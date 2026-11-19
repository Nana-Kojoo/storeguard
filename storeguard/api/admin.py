import re
import secrets
from collections import defaultdict
from datetime import timedelta
from decimal import Decimal

from flask import jsonify, request
from sqlalchemy import func, or_

from ..auth import validate_email, validate_password
from ..extensions import db
from ..models import (Alert, Approval, AuditLog, Customer, Device, Expense, Product, Refund, Sale, SaleItem, Shift,
                      User, money_str, utcnow)
from ..security import (ALL_PERMISSIONS, ASSIGNABLE_ROLES, ROLE_DEFAULTS, ROLES, client_ip, has_permission,
                        limiter, login_required, permission_required)
from ..utils import (ApiError, audit, body, canonical_method, clean_image, date_range_from_args, day_bounds, dec, like,
                     local_today, paginate, to_bool, to_int, to_local, to_money, to_text)
from . import api_bp
from .operations import serialize_shift, shift_totals
from .sales import execute_refund


# ---------------------------------------------------------------- employees

def get_employee(user, employee_id):
    employee = User.query.filter_by(id=employee_id, business_id=user.business_id).first()
    if not employee:
        raise ApiError("Employee not found", 404)
    return employee


def employee_status(employee, open_shifts):
    if not employee.active:
        return "suspended"
    shift = open_shifts.get(employee.id)
    if not shift:
        return "off_shift"
    return "on_break" if any(b.ended_at is None for b in shift.breaks) else "active"


def today_stats(business_id, start, end):
    sales = dict((row[0], (row[1], dec(row[2]))) for row in db.session.query(
        Sale.cashier_id, func.count(Sale.id), func.coalesce(func.sum(Sale.total), 0)
    ).filter(Sale.business_id == business_id, Sale.created_at >= start, Sale.created_at < end)
        .group_by(Sale.cashier_id).all())
    refunds = dict(db.session.query(Refund.user_id, func.count(Refund.id)).filter(
        Refund.business_id == business_id, Refund.created_at >= start, Refund.created_at < end
    ).group_by(Refund.user_id).all())
    return sales, refunds


@api_bp.get("/employees")
@login_required
@permission_required("employees", "reports", "shifts", "audit", "security")
def list_employees(user):
    business = user.business
    start, end = day_bounds(business, local_today(business))
    employees = User.query.filter_by(business_id=user.business_id).order_by(User.full_name).all()
    open_shifts = {s.user_id: s for s in Shift.query.filter_by(business_id=user.business_id, status="open")}
    sales, refunds = today_stats(user.business_id, start, end)
    out = []
    for e in employees:
        row = e.as_dict()
        row["role_label"] = ROLES.get(e.role, e.role)
        row["status"] = employee_status(e, open_shifts)
        count, total = sales.get(e.id, (0, Decimal(0)))
        row.update({"txns_today": count, "sales_today": money_str(total), "refunds_today": refunds.get(e.id, 0),
                    "shift_opened_at": serialize_shift(open_shifts[e.id], totals=False)["opened_at"]
                    if e.id in open_shifts else None})
        out.append(row)
    return jsonify({"employees": out, "roles": ROLES, "permissions": ALL_PERMISSIONS,
                    "role_defaults": {k: sorted(v) for k, v in ROLE_DEFAULTS.items()},
                    "assignable_roles": sorted(ASSIGNABLE_ROLES.get(user.role, set()))})


@api_bp.get("/employees/<int:employee_id>")
@login_required
@permission_required("employees")
def employee_detail(user, employee_id):
    employee = get_employee(user, employee_id)
    business = user.business
    start, end = day_bounds(business, local_today(business) - timedelta(days=29), local_today(business))
    sales = db.session.query(func.count(Sale.id), func.coalesce(func.sum(Sale.total), 0),
                             func.coalesce(func.sum(Sale.discount), 0)).filter(
        Sale.cashier_id == employee.id, Sale.created_at >= start, Sale.created_at < end).one()
    refunds = db.session.query(func.count(Refund.id), func.coalesce(func.sum(Refund.amount), 0)).filter(
        Refund.user_id == employee.id, Refund.created_at >= start, Refund.created_at < end).one()
    variance = db.session.query(func.coalesce(func.sum(Shift.variance), 0)).filter(
        Shift.user_id == employee.id, Shift.closed_at >= start).scalar()
    shifts = Shift.query.filter_by(user_id=employee.id).order_by(Shift.opened_at.desc()).limit(10).all()
    activity = AuditLog.query.filter_by(business_id=user.business_id, user_id=employee.id) \
        .order_by(AuditLog.created_at.desc()).limit(20).all()
    alerts = Alert.query.filter_by(business_id=user.business_id, subject_user_id=employee.id) \
        .order_by(Alert.created_at.desc()).limit(10).all()
    data = employee.as_dict()
    data["role_label"] = ROLES.get(employee.role, employee.role)
    return jsonify({
        "employee": data,
        "stats_30d": {"txns": sales[0], "sales": money_str(sales[1]), "discounts": money_str(sales[2]),
                      "refunds": refunds[0], "refund_amount": money_str(refunds[1]),
                      "cash_variance": money_str(variance)},
        "shifts": [serialize_shift(s, totals=False) for s in shifts],
        "activity": [a.as_dict() for a in activity],
        "alerts": [a.as_dict() for a in alerts],
    })


def apply_employee_fields(actor, employee, payload, creating=False):
    if "image" in payload:
        employee.image = clean_image(payload.get("image"))
    if creating or "full_name" in payload:
        employee.full_name = to_text(payload.get("full_name"), "full_name", 160, required=True)
    if creating or "email" in payload:
        email = validate_email(payload.get("email"))
        clash = User.query.filter(User.email == email, User.id != (employee.id or 0)).first()
        if clash:
            raise ApiError("Another account already uses this email", 409)
        employee.email = email
    if "phone" in payload:
        employee.phone = to_text(payload.get("phone"), "phone", 40)
    if "employee_code" in payload:
        employee.employee_code = to_text(payload.get("employee_code"), "employee_code", 40)
    if "shift_pattern" in payload:
        if payload["shift_pattern"] not in {"morning", "afternoon", "night"}:
            raise ApiError("Shift must be morning, afternoon or night")
        employee.shift_pattern = payload["shift_pattern"]
    if creating or "role" in payload:
        role = payload.get("role") or "cashier"
        if role not in ROLES:
            raise ApiError("Unknown role")
        if role != employee.role and role not in ASSIGNABLE_ROLES.get(actor.role, set()):
            raise ApiError("You cannot assign this role", 403)
        if employee.id == actor.id and role != actor.role:
            raise ApiError("You cannot change your own role", 403)
        employee.role = role
    if "permissions" in payload:
        perms = payload.get("permissions")
        if perms is None:
            employee.permissions = None
        else:
            if not isinstance(perms, list) or any(p not in ALL_PERMISSIONS for p in perms):
                raise ApiError("Invalid permissions")
            if actor.role != "owner" and "settings" in perms:
                raise ApiError("Only the owner can grant settings access", 403)
            employee.permissions = sorted(set(perms))


@api_bp.post("/employees")
@login_required
@permission_required("employees")
def create_employee(user):
    payload = body()
    if not ASSIGNABLE_ROLES.get(user.role):
        raise ApiError("Only owners and managers can add employees", 403)
    employee = User(business_id=user.business_id, branch_id=user.branch_id, role="cashier")
    apply_employee_fields(user, employee, payload, creating=True)
    password = str(payload.get("password") or "")
    validate_password(password)
    employee.set_password(password)
    if not employee.employee_code:
        count = User.query.filter_by(business_id=user.business_id).count()
        employee.employee_code = f"EMP-{count + 1:03d}"
    db.session.add(employee)
    db.session.flush()
    audit(user, "employee.created", "user", employee.id, f"Added {employee.full_name} as {employee.role}")
    db.session.commit()
    return jsonify({"employee": employee.as_dict()}), 201


@api_bp.patch("/employees/<int:employee_id>")
@login_required
@permission_required("employees")
def update_employee(user, employee_id):
    employee = get_employee(user, employee_id)
    if employee.role == "owner" and user.role != "owner":
        raise ApiError("Only the owner can edit the owner account", 403)
    if user.role == "manager" and employee.role == "manager" and employee.id != user.id:
        raise ApiError("Managers cannot edit other managers", 403)
    payload = body()
    apply_employee_fields(user, employee, payload)
    if "active" in payload:
        active = to_bool(payload["active"])
        if employee.id == user.id and not active:
            raise ApiError("You cannot suspend your own account", 403)
        if active != employee.active:
            employee.active = active
            employee.session_version += 1  # sign out everywhere
            audit(user, "employee.reactivated" if active else "employee.suspended", "user", employee.id,
                  to_text(payload.get("reason") or "", "reason", 200) or employee.full_name)
    audit(user, "employee.updated", "user", employee.id, f"Updated {employee.full_name}")
    db.session.commit()
    return jsonify({"employee": employee.as_dict()})


@api_bp.post("/employees/<int:employee_id>/reset-password")
@login_required
@permission_required("employees")
def reset_employee_password(user, employee_id):
    employee = get_employee(user, employee_id)
    if employee.role == "owner" and user.role != "owner":
        raise ApiError("Only the owner can reset the owner password", 403)
    password = str(body().get("password") or "")
    validate_password(password)
    employee.set_password(password)
    employee.failed_logins = 0
    employee.locked_until = None
    audit(user, "employee.password_reset", "user", employee.id, f"Reset password for {employee.full_name}")
    db.session.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- alerts & notifications

@api_bp.get("/alerts")
@login_required
@permission_required("security")
def list_alerts(user):
    query = Alert.query.filter_by(business_id=user.business_id)
    status = request.args.get("status")
    if status == "active":
        query = query.filter(Alert.status.in_(("open", "investigating")))
    elif status:
        query = query.filter_by(status=status)
    if request.args.get("severity"):
        query = query.filter_by(severity=request.args["severity"])
    if request.args.get("category"):
        query = query.filter_by(category=request.args["category"])
    counts = dict(db.session.query(Alert.severity, func.count(Alert.id)).filter(
        Alert.business_id == user.business_id, Alert.status.in_(("open", "investigating"))
    ).group_by(Alert.severity).all())
    since = utcnow() - timedelta(days=1)
    resolved_today = Alert.query.filter(Alert.business_id == user.business_id, Alert.resolved_at >= since).count()
    result = paginate(query.order_by(Alert.created_at.desc()), lambda a: a.as_dict())
    result["summary"] = {"critical": counts.get("critical", 0), "warning": counts.get("warning", 0),
                         "info": counts.get("info", 0), "resolved_24h": resolved_today}
    return jsonify(result)


@api_bp.patch("/alerts/<int:alert_id>")
@login_required
@permission_required("security")
def update_alert(user, alert_id):
    alert = Alert.query.filter_by(id=alert_id, business_id=user.business_id).first()
    if not alert:
        raise ApiError("Alert not found", 404)
    payload = body()
    status = payload.get("status")
    if status not in {"open", "investigating", "resolved", "dismissed"}:
        raise ApiError("Invalid status")
    alert.status = status
    alert.resolution_note = to_text(payload.get("note") or alert.resolution_note, "note", 500)
    if status in {"resolved", "dismissed"}:
        alert.resolved_by = user.id
        alert.resolved_at = utcnow()
    audit(user, f"alert.{status}", "alert", alert.id, f"{alert.title}: {alert.resolution_note or status}")
    db.session.commit()
    return jsonify({"alert": alert.as_dict()})


@api_bp.get("/notifications")
@login_required
def notifications(user):
    data = {"alerts": [], "alert_count": 0, "approvals_pending": 0, "my_requests": []}
    if has_permission(user, "security"):
        active = Alert.query.filter(Alert.business_id == user.business_id, Alert.status.in_(("open", "investigating")))
        data["alert_count"] = active.count()
        data["alerts"] = [a.as_dict() for a in active.order_by(Alert.created_at.desc()).limit(8)]
    if has_permission(user, "approvals"):
        data["approvals_pending"] = Approval.query.filter_by(business_id=user.business_id, status="pending").count()
    since = utcnow() - timedelta(days=2)
    mine = Approval.query.filter(Approval.business_id == user.business_id, Approval.requested_by == user.id,
                                 Approval.created_at >= since).order_by(Approval.created_at.desc()).limit(5)
    data["my_requests"] = [a.as_dict() for a in mine]
    return jsonify(data)


# ---------------------------------------------------------------- approvals

@api_bp.get("/approvals")
@login_required
@permission_required("approvals")
def list_approvals(user):
    query = Approval.query.filter_by(business_id=user.business_id)
    if request.args.get("status"):
        query = query.filter_by(status=request.args["status"])
    if request.args.get("kind"):
        query = query.filter_by(kind=request.args["kind"])
    counts = dict(db.session.query(Approval.kind, func.count(Approval.id)).filter_by(
        business_id=user.business_id, status="pending").group_by(Approval.kind).all())
    result = paginate(query.order_by(Approval.created_at.desc()), lambda a: a.as_dict())
    result["pending_by_kind"] = counts
    return jsonify(result)


@api_bp.post("/approvals/<int:approval_id>/decide")
@login_required
@permission_required("approvals")
def decide_approval(user, approval_id):
    approval = Approval.query.filter_by(id=approval_id, business_id=user.business_id).first()
    if not approval:
        raise ApiError("Approval not found", 404)
    if approval.status != "pending":
        raise ApiError(f"Already {approval.status}", 409)
    if approval.requested_by == user.id and user.role != "owner":
        raise ApiError("You cannot approve your own request", 403)
    payload = body()
    decision = payload.get("decision")
    if decision not in {"approve", "reject"}:
        raise ApiError("Decision must be approve or reject")
    note = to_text(payload.get("note"), "note", 500)
    if decision == "reject" and not note:
        raise ApiError("Give a reason when rejecting")
    approved = decision == "approve"

    if approval.kind == "refund":
        if approved:
            sale = Sale.query.filter_by(id=int(approval.entity_id), business_id=user.business_id).first()
            if not sale:
                raise ApiError("Sale no longer exists", 409)
            execute_refund(sale, approval.payload.get("items"), approval.payload.get("reason") or "Approved refund",
                           requester=approval.requester, approver=user)
    elif approval.kind == "expense":
        expense = Expense.query.filter_by(id=int(approval.entity_id), business_id=user.business_id).first()
        if expense:
            expense.status = "approved" if approved else "rejected"
    elif approval.kind == "cash_variance":
        shift = Shift.query.filter_by(id=int(approval.entity_id), business_id=user.business_id).first()
        if shift:
            shift.review_status = "approved" if approved else "rejected"
            shift.reviewed_by = user.id
            if approved:
                Alert.query.filter_by(business_id=user.business_id, entity_type="shift", entity_id=str(shift.id),
                                      status="open").update({"status": "resolved", "resolved_by": user.id,
                                                             "resolved_at": utcnow(),
                                                             "resolution_note": note or "Variance accepted"})

    approval.status = "approved" if approved else "rejected"
    approval.decided_by = user.id
    approval.decided_at = utcnow()
    approval.decision_note = note
    audit(user, f"approval.{approval.status}", approval.entity_type, approval.entity_id,
          f"{approval.summary}{' — ' + note if note else ''}")
    db.session.commit()
    return jsonify({"approval": approval.as_dict()})


# ---------------------------------------------------------------- audit

@api_bp.get("/audit")
@login_required
@permission_required("audit")
def list_audit(user):
    start_day, end_day = date_range_from_args(user.business, default_days=6)
    start, end = day_bounds(user.business, start_day, end_day)
    query = AuditLog.query.filter(AuditLog.business_id == user.business_id, AuditLog.created_at >= start,
                                  AuditLog.created_at < end)
    if request.args.get("user_id"):
        query = query.filter(AuditLog.user_id == to_int(request.args["user_id"], "user_id"))
    if request.args.get("action"):
        query = query.filter(AuditLog.action.like(f"{request.args['action']}%"))
    if request.args.get("q"):
        term = like(request.args["q"].strip())
        query = query.filter(or_(AuditLog.reason.ilike(term, escape="\\"), AuditLog.entity_id.ilike(term, escape="\\")))
    return jsonify(paginate(query.order_by(AuditLog.created_at.desc(), AuditLog.id.desc()),
                            lambda a: a.as_dict(), default_per_page=50))


# ---------------------------------------------------------------- devices

@api_bp.post("/devices/heartbeat")
@login_required
@permission_required("pos")
def device_heartbeat(user):
    payload = body()
    token = to_text(payload.get("token"), "token", 64)
    device = Device.query.filter_by(token=token, business_id=user.business_id).first() if token else None
    if not device:
        if not limiter.hit(f"device-register:{user.business_id}", 30, 3600):
            raise ApiError("Too many new devices registered. Try again later.", 429)
        count = Device.query.filter_by(business_id=user.business_id).count()
        device = Device(business_id=user.business_id, token=secrets.token_urlsafe(32)[:43],
                        name=to_text(payload.get("name") or f"POS-{count + 1:02d}", "name", 80))
        db.session.add(device)
        db.session.flush()
        audit(user, "device.registered", "device", device.id, f"Registered {device.name}")
    device.last_seen_at = utcnow()
    device.last_ip = client_ip()
    device.user_agent = (request.headers.get("User-Agent") or "")[:255]
    device.last_user_id = user.id
    db.session.commit()
    return jsonify({"token": device.token, "device": device.as_dict()})


@api_bp.get("/devices")
@login_required
@permission_required("devices")
def list_devices(user):
    devices = Device.query.filter_by(business_id=user.business_id).order_by(Device.name).all()
    since = utcnow() - timedelta(days=1)
    counts = dict(db.session.query(Sale.device_id, func.count(Sale.id)).filter(
        Sale.business_id == user.business_id, Sale.created_at >= since).group_by(Sale.device_id).all())
    out = []
    for d in devices:
        row = d.as_dict()
        row["sales_24h"] = counts.get(d.id, 0)
        out.append(row)
    return jsonify({"devices": out})


@api_bp.patch("/devices/<int:device_id>")
@login_required
@permission_required("devices")
def update_device(user, device_id):
    device = Device.query.filter_by(id=device_id, business_id=user.business_id).first()
    if not device:
        raise ApiError("Device not found", 404)
    payload = body()
    if "name" in payload:
        device.name = to_text(payload["name"], "name", 80, required=True)
    if "kind" in payload:
        if payload["kind"] not in {"pos_terminal", "tablet", "phone", "back_office"}:
            raise ApiError("Invalid device type")
        device.kind = payload["kind"]
    if "status" in payload:
        if payload["status"] not in {"active", "blocked"}:
            raise ApiError("Status must be active or blocked")
        if payload["status"] != device.status:
            audit(user, f"device.{'blocked' if payload['status'] == 'blocked' else 'unblocked'}", "device",
                  device.id, device.name)
        device.status = payload["status"]
    audit(user, "device.updated", "device", device.id, device.name)
    db.session.commit()
    return jsonify({"device": device.as_dict()})


@api_bp.delete("/devices/<int:device_id>")
@login_required
@permission_required("devices")
def delete_device(user, device_id):
    device = Device.query.filter_by(id=device_id, business_id=user.business_id).first()
    if not device:
        raise ApiError("Device not found", 404)
    if Sale.query.filter_by(device_id=device.id).first():
        raise ApiError("Device has recorded sales; block it instead of removing it", 409)
    audit(user, "device.removed", "device", device.id, device.name)
    db.session.delete(device)
    db.session.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- settings

RECEIPT_TEXT_LIMITS = {"header": 120, "tax_id": 40, "contact_line": 120, "policy": 255}
RECEIPT_FLAGS = ("auto_print", "show_address", "show_phone", "show_cashier", "show_customer",
                 "show_branch", "show_sku", "show_item_count")
LOGO_PATTERN = re.compile(r"^data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$")
MAX_LOGO_CHARS = 150_000  # ~110 KB image; the browser shrinks logos before upload


def _clean_receipt(raw, current):
    if not isinstance(raw, dict):
        raise ApiError("Receipt settings must be an object")
    receipt = dict(current)
    for field, limit in RECEIPT_TEXT_LIMITS.items():
        if field in raw:
            receipt[field] = to_text(raw[field], field, limit)
    for field in RECEIPT_FLAGS:
        if field in raw:
            receipt[field] = to_bool(raw[field])
    if "copies" in raw:
        receipt["copies"] = to_int(raw["copies"], "copies", minimum=1, maximum=3)
    if "paper" in raw:
        if raw["paper"] not in ("58mm", "80mm", "a4"):
            raise ApiError("Paper size must be 58mm, 80mm or A4")
        receipt["paper"] = raw["paper"]
    if "logo" in raw:
        logo = "" if raw["logo"] is None else str(raw["logo"]).strip()
        if logo and (len(logo) > MAX_LOGO_CHARS or not LOGO_PATTERN.match(logo)):
            raise ApiError("Logo must be a PNG, JPEG, WebP or GIF image under 100 KB")
        receipt["logo"] = logo
    return receipt


@api_bp.get("/settings")
@login_required
def get_settings(user):
    return jsonify({"business": user.business.as_dict(), "branch": user.branch.as_dict() if user.branch else None,
                    "can_edit": has_permission(user, "settings")})


@api_bp.patch("/settings")
@login_required
@permission_required("settings")
def update_settings(user):
    payload = body()
    business = user.business
    for field, limit in (("name", 160), ("address", 255), ("phone", 40), ("email", 255), ("receipt_footer", 255)):
        if field in payload:
            setattr(business, field, to_text(payload[field], field, limit, required=field == "name"))
    if "currency" in payload:
        currency = to_text(payload["currency"], "currency", 3, required=True).upper()
        if len(currency) != 3 or not currency.isalpha():
            raise ApiError("Currency must be a 3-letter code")
        business.currency = currency
    if "timezone" in payload:
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
        try:
            ZoneInfo(str(payload["timezone"]))
        except (ZoneInfoNotFoundError, ValueError):
            raise ApiError("Unknown timezone") from None
        business.timezone = str(payload["timezone"])
    if "tax_rate" in payload:
        business.tax_rate = to_money(payload["tax_rate"], "tax_rate")
        if business.tax_rate > 100:
            raise ApiError("Tax rate cannot exceed 100%")
    if "max_discount_pct" in payload:
        business.max_discount_pct = to_money(payload["max_discount_pct"], "max_discount_pct")
        if business.max_discount_pct > 100:
            raise ApiError("Maximum discount cannot exceed 100%")
    for field in ("refund_approval_threshold", "cash_variance_threshold"):
        if field in payload:
            setattr(business, field, to_money(payload[field], field))
    for field in ("require_shift_for_sales", "low_stock_alerts"):
        if field in payload:
            setattr(business, field, to_bool(payload[field]))
    if "receipt" in payload:
        business.receipt = _clean_receipt(payload["receipt"], business.receipt)
    if user.branch:
        if "branch_name" in payload:
            user.branch.name = to_text(payload["branch_name"], "branch_name", 160, required=True)
        if "branch_address" in payload:
            user.branch.address = to_text(payload["branch_address"], "branch_address", 255)
    audit(user, "settings.updated", "business", business.id, "Business settings updated")
    db.session.commit()
    return jsonify({"business": business.as_dict(), "branch": user.branch.as_dict() if user.branch else None})


# ---------------------------------------------------------------- analytics

def sales_rows(business_id, start, end):
    return db.session.query(Sale.id, Sale.created_at, Sale.total, Sale.discount, Sale.tax, Sale.refunded_amount,
                            Sale.payment_method, Sale.cashier_id).filter(
        Sale.business_id == business_id, Sale.created_at >= start, Sale.created_at < end).all()


def item_rows(business_id, start, end):
    return db.session.query(Sale.created_at, SaleItem.product_id, SaleItem.product_name, SaleItem.quantity,
                            SaleItem.refunded_quantity, SaleItem.unit_price, SaleItem.unit_cost, Product.category) \
        .join(Sale, SaleItem.sale_id == Sale.id).join(Product, SaleItem.product_id == Product.id) \
        .filter(Sale.business_id == business_id, Sale.created_at >= start, Sale.created_at < end).all()


def analyse(business, start_day, end_day):
    start, end = day_bounds(business, start_day, end_day)
    sales = sales_rows(business.id, start, end)
    items = item_rows(business.id, start, end)
    refunds = db.session.query(Refund.created_at, Refund.amount, Refund.user_id).filter(
        Refund.business_id == business.id, Refund.created_at >= start, Refund.created_at < end).all()
    expenses = db.session.query(Expense.category, Expense.expense_date, Expense.amount).filter(
        Expense.business_id == business.id, Expense.status == "approved", Expense.expense_date >= start_day,
        Expense.expense_date <= end_day).all()

    days = [(start_day + timedelta(days=i)) for i in range((end_day - start_day).days + 1)]
    series = {d.isoformat(): {"date": d.isoformat(), "revenue": Decimal(0), "profit": Decimal(0), "txns": 0,
                              "refunds": Decimal(0), "expenses": Decimal(0)} for d in days}
    by_payment, by_cashier, by_hour = defaultdict(Decimal), {}, defaultdict(int)
    revenue = discounts = tax = Decimal(0)
    for s in sales:
        local = to_local(business, s.created_at)
        key = local.date().isoformat()
        total = dec(s.total)
        revenue += total
        discounts += dec(s.discount)
        tax += dec(s.tax)
        by_payment[canonical_method(s.payment_method)] += total
        by_hour[local.hour] += 1
        c = by_cashier.setdefault(s.cashier_id, {"txns": 0, "revenue": Decimal(0), "discounts": Decimal(0), "refunds": 0})
        c["txns"] += 1
        c["revenue"] += total
        c["discounts"] += dec(s.discount)
        if key in series:
            series[key]["revenue"] += total
            series[key]["txns"] += 1

    cogs = Decimal(0)
    products, categories = {}, defaultdict(Decimal)
    items_sold = 0
    for i in items:
        sold = i.quantity - i.refunded_quantity
        line_rev = dec(i.unit_price) * sold
        line_cost = dec(i.unit_cost) * sold
        cogs += line_cost
        items_sold += sold
        p = products.setdefault(i.product_id, {"product_id": i.product_id, "name": i.product_name,
                                               "quantity": 0, "revenue": Decimal(0), "profit": Decimal(0)})
        p["quantity"] += sold
        p["revenue"] += line_rev
        p["profit"] += line_rev - line_cost
        categories[i.category] += line_rev
        key = to_local(business, i.created_at).date().isoformat()
        if key in series:
            series[key]["profit"] += line_rev - line_cost

    refunded = Decimal(0)
    for r in refunds:
        refunded += dec(r.amount)
        key = to_local(business, r.created_at).date().isoformat()
        if key in series:
            series[key]["refunds"] += dec(r.amount)
        if r.user_id in by_cashier:
            by_cashier[r.user_id]["refunds"] += 1

    expense_total = Decimal(0)
    expense_by_cat = defaultdict(Decimal)
    for e in expenses:
        expense_total += dec(e.amount)
        expense_by_cat[e.category] += dec(e.amount)
        if e.expense_date.isoformat() in series:
            series[e.expense_date.isoformat()]["expenses"] += dec(e.amount)

    net_sales = revenue - refunded - tax
    gross_profit = net_sales - cogs
    names = {u.id: u.full_name for u in User.query.filter_by(business_id=business.id)}
    txns = len(sales)
    return {
        "range": {"start": start_day.isoformat(), "end": end_day.isoformat()},
        "totals": {
            "revenue": money_str(revenue), "refunds": money_str(refunded), "discounts": money_str(discounts),
            "tax": money_str(tax), "net_sales": money_str(net_sales), "cogs": money_str(cogs),
            "gross_profit": money_str(gross_profit),
            "gross_margin_pct": f"{(gross_profit / net_sales * 100):.1f}" if net_sales else "0.0",
            "expenses": money_str(expense_total), "net_profit": money_str(gross_profit - expense_total),
            "transactions": txns, "avg_basket": money_str(revenue / txns) if txns else "0.00",
            "items_sold": items_sold,
        },
        "series": [{**r, "revenue": money_str(r["revenue"]), "profit": money_str(r["profit"]),
                    "refunds": money_str(r["refunds"]), "expenses": money_str(r["expenses"])} for r in series.values()],
        "by_payment": [{"method": k, "total": money_str(v)} for k, v in sorted(by_payment.items(), key=lambda x: -x[1])],
        "by_category": [{"category": k, "total": money_str(v)} for k, v in sorted(categories.items(), key=lambda x: -x[1])],
        "by_hour": [{"hour": h, "txns": by_hour.get(h, 0)} for h in range(24)],
        "by_cashier": sorted([{"user_id": uid, "name": names.get(uid, "Unknown"), "txns": c["txns"],
                               "revenue": money_str(c["revenue"]), "discounts": money_str(c["discounts"]),
                               "refunds": c["refunds"]} for uid, c in by_cashier.items()],
                             key=lambda r: -Decimal(r["revenue"])),
        "top_products": [{**p, "revenue": money_str(p["revenue"]), "profit": money_str(p["profit"])}
                         for p in sorted(products.values(), key=lambda p: -p["revenue"])[:15]],
        "expenses_by_category": [{"category": k, "total": money_str(v)}
                                 for k, v in sorted(expense_by_cat.items(), key=lambda x: -x[1])],
    }


@api_bp.get("/reports/summary")
@login_required
@permission_required("reports")
def report_summary(user):
    start_day, end_day = date_range_from_args(user.business, default_days=6)
    return jsonify(analyse(user.business, start_day, end_day))


@api_bp.get("/reports/inventory")
@login_required
@permission_required("reports", "inventory")
def report_inventory(user):
    business = user.business
    products = Product.query.filter_by(business_id=user.business_id, active=True).all()
    since, _ = day_bounds(business, local_today(business) - timedelta(days=30))
    sold_recently = {row[0] for row in db.session.query(SaleItem.product_id).join(Sale).filter(
        Sale.business_id == user.business_id, Sale.created_at >= since).distinct()}
    by_category = defaultdict(lambda: {"products": 0, "units": 0, "cost_value": Decimal(0), "retail_value": Decimal(0)})
    for p in products:
        c = by_category[p.category]
        c["products"] += 1
        c["units"] += p.stock_quantity
        c["cost_value"] += dec(p.cost_price) * p.stock_quantity
        c["retail_value"] += dec(p.price) * p.stock_quantity
    slow = [p.as_dict() for p in products if p.stock_quantity > 0 and p.id not in sold_recently]
    return jsonify({
        "by_category": [{"category": k, **{**v, "cost_value": money_str(v["cost_value"]),
                                          "retail_value": money_str(v["retail_value"])}}
                        for k, v in sorted(by_category.items())],
        "totals": {"products": len(products), "units": sum(p.stock_quantity for p in products),
                   "cost_value": money_str(sum((dec(p.cost_price) * p.stock_quantity for p in products), Decimal(0))),
                   "retail_value": money_str(sum((dec(p.price) * p.stock_quantity for p in products), Decimal(0)))},
        "low_stock": [p.as_dict() for p in products if 0 < p.stock_quantity <= p.reorder_level],
        "out_of_stock": [p.as_dict() for p in products if p.stock_quantity <= 0],
        "slow_movers": sorted(slow, key=lambda p: -p["stock_quantity"])[:25],
    })


@api_bp.get("/dashboard")
@login_required
@permission_required("reports")
def dashboard(user):
    business = user.business
    today = local_today(business)
    week = analyse(business, today - timedelta(days=6), today)
    today_series = week["series"][-1]
    yesterday_series = week["series"][-2] if len(week["series"]) > 1 else None
    start, end = day_bounds(business, today)
    today_data = analyse(business, today, today)

    products = Product.query.filter_by(business_id=user.business_id, active=True).all()
    expiring_cutoff = today + timedelta(days=30)
    low = sorted([p for p in products if p.stock_quantity <= p.reorder_level], key=lambda p: p.stock_quantity)

    active_alerts = Alert.query.filter(Alert.business_id == user.business_id,
                                       Alert.status.in_(("open", "investigating")))
    open_shifts = {s.user_id: s for s in Shift.query.filter_by(business_id=user.business_id, status="open")}
    sales_today, refunds_today = today_stats(user.business_id, start, end)
    staff = User.query.filter_by(business_id=user.business_id, active=True).all()
    activity = []
    for e in staff:
        if e.id not in open_shifts and e.id not in sales_today:
            continue
        count, total = sales_today.get(e.id, (0, Decimal(0)))
        activity.append({"id": e.id, "name": e.full_name, "role": ROLES.get(e.role, e.role),
                         "status": employee_status(e, open_shifts), "txns": count, "sales": money_str(total),
                         "refunds": refunds_today.get(e.id, 0)})

    shifts_today = Shift.query.filter(Shift.business_id == user.business_id,
                                      or_(Shift.status == "open", Shift.closed_at >= start)).all()
    cash = {"opening": Decimal(0), "cash_sales": Decimal(0), "cash_refunds": Decimal(0), "cash_in": Decimal(0),
            "cash_out": Decimal(0), "expected": Decimal(0), "variance": Decimal(0), "open_drawers": 0}
    for s in shifts_today:
        t = shift_totals(s)
        cash["opening"] += dec(s.opening_cash)
        cash["cash_sales"] += dec(t["cash_sales"]) + dec(t["customer_cash"])
        cash["cash_refunds"] += dec(t["cash_refunds"])
        cash["cash_in"] += dec(t["cash_in"])
        cash["cash_out"] += dec(t["cash_out"])
        cash["expected"] += dec(t["expected_cash"])
        if s.status == "open":
            cash["open_drawers"] += 1
        elif s.variance is not None:
            cash["variance"] += dec(s.variance)

    expenses_today = dec(db.session.query(func.coalesce(func.sum(Expense.amount), 0)).filter(
        Expense.business_id == user.business_id, Expense.status == "approved", Expense.expense_date == today).scalar())
    recent = Sale.query.filter_by(business_id=user.business_id).order_by(Sale.created_at.desc()).limit(8).all()
    totals = today_data["totals"]
    return jsonify({
        "today": {
            "revenue": totals["revenue"], "gross_profit": totals["gross_profit"],
            "gross_margin_pct": totals["gross_margin_pct"], "transactions": totals["transactions"],
            "avg_basket": totals["avg_basket"], "refunds": totals["refunds"], "expenses": money_str(expenses_today),
            "yesterday_revenue": yesterday_series["revenue"] if yesterday_series else "0.00",
            "discounts": totals["discounts"],
        },
        "series": week["series"], "by_payment": today_data["by_payment"], "today_series": today_series,
        "inventory": {
            "products": len(products),
            "cost_value": money_str(sum((dec(p.cost_price) * p.stock_quantity for p in products), Decimal(0))),
            "low_stock": sum(1 for p in products if 0 < p.stock_quantity <= p.reorder_level),
            "out_of_stock": sum(1 for p in products if p.stock_quantity <= 0),
            "expiring": sum(1 for p in products if p.expiry_date and p.expiry_date <= expiring_cutoff),
            "attention": [p.as_dict() for p in low[:6]],
        },
        "alerts": {"active": active_alerts.count(),
                   "critical": active_alerts.filter(Alert.severity == "critical").count(),
                   "latest": [a.as_dict() for a in active_alerts.order_by(Alert.created_at.desc()).limit(5)]},
        "approvals_pending": Approval.query.filter_by(business_id=user.business_id, status="pending").count(),
        "employees": activity,
        "cash": {k: (money_str(v) if isinstance(v, Decimal) else v) for k, v in cash.items()},
        "recent_sales": [s.as_dict() for s in recent],
    })


# ---------------------------------------------------------------- search

@api_bp.get("/search")
@login_required
def global_search(user):
    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify({"results": []})
    term = like(q)
    results = []
    for p in Product.query.filter(Product.business_id == user.business_id, Product.active.is_(True),
                                  or_(Product.name.ilike(term, escape="\\"), Product.sku.ilike(term, escape="\\"),
                                      Product.barcode.ilike(term, escape="\\"))).limit(6):
        results.append({"type": "product", "id": p.id, "title": p.name,
                        "subtitle": f"{p.sku} · {p.stock_quantity} in stock", "url": f"/inventory.html?q={p.sku}"})
    sales = Sale.query.filter(Sale.business_id == user.business_id, Sale.reference.ilike(term, escape="\\"))
    if not has_permission(user, "reports"):
        sales = sales.filter(Sale.cashier_id == user.id)
    for s in sales.limit(5):
        results.append({"type": "sale", "id": s.id, "title": s.reference,
                        "subtitle": f"{money_str(s.total)} · {s.payment_method} · {s.status}",
                        "url": f"/st.html?sale={s.id}"})
    if has_permission(user, "customers"):
        for c in Customer.query.filter(Customer.business_id == user.business_id, Customer.active.is_(True),
                                       or_(Customer.name.ilike(term, escape="\\"), Customer.phone.ilike(term, escape="\\"))).limit(5):
            results.append({"type": "customer", "id": c.id, "title": c.name,
                            "subtitle": f"{c.phone} · owes {money_str(c.balance)}", "url": f"/customers.html?id={c.id}"})
    if has_permission(user, "employees"):
        for e in User.query.filter(User.business_id == user.business_id,
                                   or_(User.full_name.ilike(term, escape="\\"), User.email.ilike(term, escape="\\"),
                                       User.employee_code.ilike(term, escape="\\"))).limit(5):
            results.append({"type": "employee", "id": e.id, "title": e.full_name,
                            "subtitle": f"{ROLES.get(e.role, e.role)} · {e.employee_code}",
                            "url": f"/employees.html?id={e.id}"})
    return jsonify({"results": results})
