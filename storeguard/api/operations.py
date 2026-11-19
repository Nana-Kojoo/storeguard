from datetime import time as dtime
from datetime import timedelta
from decimal import Decimal

from flask import jsonify, request
from sqlalchemy import func

from ..extensions import db
from ..models import (Approval, CashMovement, CustomerPayment, Expense, Refund, Sale, Shift, ShiftBreak, User, iso,
                      money_str, utcnow)
from ..security import has_permission, login_required, permission_required
from ..utils import (ApiError, audit, body, canonical_method, date_range_from_args, day_bounds, dec,
                     normalize_payment_method, paginate, raise_alert, to_date, to_int, to_local, to_money, to_text)
from . import api_bp
from .sales import open_shift_for

SHIFT_STARTS = {"morning": dtime(6, 0), "afternoon": dtime(14, 0), "night": dtime(22, 0)}
SHIFT_HOURS = 8
LATE_GRACE_MINUTES = 10
EXPENSE_CATEGORIES = ["Utilities", "Rent", "Salaries", "Transport", "Supplies", "Maintenance", "Marketing",
                      "Security", "Taxes & fees", "Other"]
DENOMINATIONS = ["200", "100", "50", "20", "10", "5", "2", "1", "0.50", "0.20", "0.10"]


def _aware(dt):
    from datetime import timezone
    return dt if dt is None or dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def shift_totals(shift):
    sid = shift.id
    by_method = {}
    for method, total in (db.session.query(Sale.payment_method, func.coalesce(func.sum(Sale.total), 0))
                          .filter(Sale.shift_id == sid).group_by(Sale.payment_method).all()):
        key = canonical_method(method)  # legacy Telecel / AT count as Mobile Money
        by_method[key] = by_method.get(key, Decimal(0)) + dec(total)
    sales_count = Sale.query.filter_by(shift_id=sid).count()
    refunds = db.session.query(Refund.method, func.count(Refund.id), func.coalesce(func.sum(Refund.amount), 0)) \
        .filter(Refund.shift_id == sid).group_by(Refund.method).all()
    cash_refunds = sum((dec(total) for method, _, total in refunds if method == "cash"), Decimal(0))
    refunds_total = sum((dec(total) for _, _, total in refunds), Decimal(0))
    refunds_count = sum(count for _, count, _ in refunds)
    customer_cash = dec(db.session.query(func.coalesce(func.sum(CustomerPayment.amount), 0))
                        .filter(CustomerPayment.shift_id == sid, CustomerPayment.method == "cash").scalar())
    movements = dict(db.session.query(CashMovement.kind, func.coalesce(func.sum(CashMovement.amount), 0))
                     .filter(CashMovement.shift_id == sid).group_by(CashMovement.kind).all())
    cash_in, cash_out = dec(movements.get("cash_in")), dec(movements.get("cash_out"))
    cash_sales = dec(by_method.get("cash"))
    expected = dec(shift.opening_cash) + cash_sales + customer_cash - cash_refunds + cash_in - cash_out
    now = utcnow()
    break_seconds = sum(((_aware(b.ended_at) or now) - _aware(b.started_at)).total_seconds() for b in shift.breaks)
    return {
        "sales_count": sales_count,
        "sales_total": money_str(sum((dec(v) for v in by_method.values()), Decimal(0))),
        "by_method": {k: money_str(v) for k, v in by_method.items()},
        "cash_sales": money_str(cash_sales), "customer_cash": money_str(customer_cash),
        "cash_refunds": money_str(cash_refunds), "refunds_total": money_str(refunds_total),
        "refunds_count": refunds_count, "cash_in": money_str(cash_in), "cash_out": money_str(cash_out),
        "expected_cash": money_str(expected), "break_minutes": int(break_seconds // 60),
    }


def serialize_shift(shift, totals=True, timeline=False):
    business = shift.user.business
    opened_local = to_local(business, shift.opened_at)
    start_time = SHIFT_STARTS.get(shift.user.shift_pattern)
    late_minutes = 0
    if start_time:
        scheduled = opened_local.replace(hour=start_time.hour, minute=start_time.minute, second=0, microsecond=0)
        late_minutes = max(0, int((opened_local - scheduled).total_seconds() // 60))
        if late_minutes > 12 * 60:  # opened on a different cycle; not meaningful
            late_minutes = 0
    open_break = next((b for b in shift.breaks if b.ended_at is None), None)
    data = {
        "id": shift.id, "user_id": shift.user_id, "user_name": shift.user.full_name,
        "user_initials": shift.user.initials, "role": shift.user.role, "shift_pattern": shift.user.shift_pattern,
        "device_label": shift.device_label, "status": shift.status, "opened_at": iso(shift.opened_at),
        "closed_at": iso(shift.closed_at), "opening_cash": money_str(shift.opening_cash),
        "counted_cash": money_str(shift.counted_cash) if shift.counted_cash is not None else None,
        "expected_cash_at_close": money_str(shift.expected_cash) if shift.expected_cash is not None else None,
        "variance": money_str(shift.variance) if shift.variance is not None else None,
        "denominations": shift.denominations, "notes": shift.notes, "review_status": shift.review_status,
        "on_break": open_break is not None, "break_started_at": iso(open_break.started_at) if open_break else None,
        "late_minutes": late_minutes if late_minutes > LATE_GRACE_MINUTES else 0,
        "scheduled_hours": SHIFT_HOURS,
        "breaks": [{"started_at": iso(b.started_at), "ended_at": iso(b.ended_at), "reason": b.reason} for b in shift.breaks],
    }
    if totals:
        data["totals"] = shift_totals(shift)
    if timeline:
        events = [{"at": iso(shift.opened_at), "type": "open", "title": "Shift opened",
                   "detail": f"Opening cash {money_str(shift.opening_cash)}"}]
        for b in shift.breaks:
            events.append({"at": iso(b.started_at), "type": "break", "title": "Break started", "detail": b.reason})
            if b.ended_at:
                events.append({"at": iso(b.ended_at), "type": "break_end", "title": "Returned from break", "detail": ""})
        for s in Sale.query.filter_by(shift_id=shift.id).order_by(Sale.created_at.desc()).limit(100):
            events.append({"at": iso(s.created_at), "type": "sale", "title": f"Sale {s.reference}",
                           "detail": f"{s.payment_method} · {money_str(s.total)}", "amount": money_str(s.total),
                           "method": s.payment_method})
        for r in Refund.query.filter_by(shift_id=shift.id):
            events.append({"at": iso(r.created_at), "type": "refund", "title": f"Refund on {r.sale.reference}",
                           "detail": f"{r.method} · -{money_str(r.amount)} · {r.reason}", "amount": money_str(r.amount),
                           "method": r.method})
        for m in CashMovement.query.filter_by(shift_id=shift.id):
            events.append({"at": iso(m.created_at), "type": m.kind,
                           "title": "Cash in" if m.kind == "cash_in" else "Cash out",
                           "detail": f"{money_str(m.amount)} · {m.reason}", "amount": money_str(m.amount)})
        for p in CustomerPayment.query.filter_by(shift_id=shift.id):
            events.append({"at": iso(p.created_at), "type": "customer_payment", "title": "Credit repayment",
                           "detail": f"{p.method} · {money_str(p.amount)}", "amount": money_str(p.amount),
                           "method": p.method})
        if shift.closed_at:
            events.append({"at": iso(shift.closed_at), "type": "close", "title": "Shift closed",
                           "detail": f"Counted {money_str(shift.counted_cash)} · variance {money_str(shift.variance)}"})
        data["timeline"] = sorted(events, key=lambda e: e["at"])
    return data


def get_shift(user, shift_id):
    shift = Shift.query.filter_by(id=shift_id, business_id=user.business_id).first()
    if not shift or (shift.user_id != user.id and not (has_permission(user, "shifts") or has_permission(user, "cash"))):
        raise ApiError("Shift not found", 404)
    return shift


def require_open_shift(user):
    shift = open_shift_for(user)
    if not shift:
        raise ApiError("You do not have an open shift", 409)
    return shift


def close_shift(shift, actor, counted, denominations, notes):
    totals = shift_totals(shift)
    expected = Decimal(totals["expected_cash"])
    now = utcnow()
    for b in shift.breaks:
        if b.ended_at is None:
            b.ended_at = now
    shift.status = "closed"
    shift.closed_at = now
    shift.expected_cash = expected
    shift.counted_cash = counted
    shift.variance = counted - expected
    shift.denominations = denominations
    shift.notes = notes
    threshold = Decimal(actor.business.cash_variance_threshold)
    if abs(shift.variance) > threshold:
        shift.review_status = "pending"
        shortage = shift.variance < 0
        db.session.add(Approval(business_id=shift.business_id, kind="cash_variance", entity_type="shift",
                                entity_id=str(shift.id), amount=abs(shift.variance), requested_by=actor.id,
                                summary=f"Cash {'shortage' if shortage else 'overage'} of {abs(shift.variance):.2f} "
                                        f"on {shift.user.full_name}'s shift", payload={"notes": notes}))
        raise_alert(shift.business_id, "critical" if shortage else "warning", "cash",
                    "Cash shortage detected" if shortage else "Cash overage detected",
                    f"{shift.user.full_name}: expected {expected:.2f}, counted {counted:.2f} "
                    f"(variance {shift.variance:+.2f})", subject_user_id=shift.user_id, entity_type="shift",
                    entity_id=shift.id)
    audit(actor, "shift.closed", "shift", shift.id,
          f"Closed shift for {shift.user.full_name}: counted {counted:.2f}, variance {shift.variance:+.2f}")


def parse_denominations(raw):
    if not raw:
        return None, None
    if not isinstance(raw, dict):
        raise ApiError("Invalid denomination breakdown")
    clean, total = {}, Decimal(0)
    for denom, count in raw.items():
        if denom not in DENOMINATIONS:
            raise ApiError(f"Unknown denomination {denom}")
        n = to_int(count, f"count for {denom}", minimum=0, maximum=100_000, default=0)
        if n:
            clean[denom] = n
            total += Decimal(denom) * n
    return clean, total


# ---------------------------------------------------------------- my shift

@api_bp.get("/shifts/current")
@login_required
def current_shift(user):
    shift = open_shift_for(user)
    return jsonify({"shift": serialize_shift(shift, timeline=True) if shift else None,
                    "denominations": DENOMINATIONS})


@api_bp.post("/shifts/open")
@login_required
def open_shift(user):
    payload = body()
    if open_shift_for(user):
        raise ApiError("You already have an open shift", 409)
    shift = Shift(business_id=user.business_id, user_id=user.id,
                  opening_cash=to_money(payload.get("opening_cash") or 0, "opening_cash"),
                  device_label=to_text(payload.get("device_label"), "device_label", 80))
    db.session.add(shift)
    db.session.flush()
    audit(user, "shift.opened", "shift", shift.id, f"Opened shift with {shift.opening_cash:.2f}")
    db.session.commit()
    return jsonify({"shift": serialize_shift(shift, timeline=True)}), 201


@api_bp.post("/shifts/current/close")
@login_required
def close_current_shift(user):
    payload = body()
    shift = require_open_shift(user)
    denominations, denom_total = parse_denominations(payload.get("denominations"))
    counted = to_money(payload.get("counted_cash") if payload.get("counted_cash") not in (None, "") else denom_total,
                       "counted_cash")
    close_shift(shift, user, counted, denominations, to_text(payload.get("notes"), "notes", 500))
    db.session.commit()
    return jsonify({"shift": serialize_shift(shift, timeline=True)})


@api_bp.post("/shifts/current/break")
@login_required
def toggle_break(user):
    payload = body()
    shift = require_open_shift(user)
    open_break = next((b for b in shift.breaks if b.ended_at is None), None)
    action = payload.get("action")
    if action == "start":
        if open_break:
            raise ApiError("You are already on a break", 409)
        reason = to_text(payload.get("reason") or "Break", "reason", 120)
        shift.breaks.append(ShiftBreak(reason=reason))
        audit(user, "shift.break_started", "shift", shift.id, reason)
    elif action == "end":
        if not open_break:
            raise ApiError("You are not on a break", 409)
        open_break.ended_at = utcnow()
        audit(user, "shift.break_ended", "shift", shift.id, "Returned from break")
    else:
        raise ApiError("Action must be start or end")
    db.session.commit()
    return jsonify({"shift": serialize_shift(shift, timeline=True)})


@api_bp.post("/shifts/current/cash-movements")
@login_required
def add_cash_movement(user):
    payload = body()
    shift = require_open_shift(user)
    kind = payload.get("kind")
    if kind not in {"cash_in", "cash_out"}:
        raise ApiError("Kind must be cash_in or cash_out")
    amount = to_money(payload.get("amount"), "amount", minimum=Decimal("0.01"))
    reason = to_text(payload.get("reason"), "reason", 255, required=True)
    if kind == "cash_out" and amount > Decimal(shift_totals(shift)["expected_cash"]):
        raise ApiError("Cash out exceeds the cash expected in the drawer")
    movement = CashMovement(business_id=user.business_id, shift_id=shift.id, user_id=user.id, kind=kind,
                            amount=amount, reason=reason)
    db.session.add(movement)
    if kind == "cash_out" and amount >= Decimal(user.business.cash_variance_threshold) * 10:
        raise_alert(user.business_id, "info", "cash", "Large cash withdrawal",
                    f"{user.full_name} removed {amount:.2f} from the drawer: {reason}", subject_user_id=user.id,
                    entity_type="shift", entity_id=shift.id)
    audit(user, f"cash.{kind}", "shift", shift.id, f"{amount:.2f}: {reason}")
    db.session.commit()
    return jsonify({"movement": movement.as_dict(), "shift": serialize_shift(shift, timeline=True)}), 201


# ---------------------------------------------------------------- shift admin

@api_bp.get("/shifts")
@login_required
def list_shifts(user):
    query = Shift.query.filter(Shift.business_id == user.business_id)
    manage = has_permission(user, "shifts") or has_permission(user, "cash")
    if not manage or request.args.get("mine") == "1":
        query = query.filter(Shift.user_id == user.id)
    elif request.args.get("user_id"):
        query = query.filter(Shift.user_id == to_int(request.args["user_id"], "user_id"))
    if request.args.get("status"):
        query = query.filter(Shift.status == request.args["status"])
    if request.args.get("review_status"):
        query = query.filter(Shift.review_status == request.args["review_status"])
    if request.args.get("start") or request.args.get("end"):
        start_day, end_day = date_range_from_args(user.business)
        start, end = day_bounds(user.business, start_day, end_day)
        query = query.filter(Shift.opened_at >= start, Shift.opened_at < end)
    return jsonify(paginate(query.order_by(Shift.opened_at.desc()), serialize_shift, default_per_page=20, max_per_page=100))


@api_bp.get("/shifts/<int:shift_id>")
@login_required
def shift_detail(user, shift_id):
    return jsonify({"shift": serialize_shift(get_shift(user, shift_id), timeline=True)})


@api_bp.post("/shifts/<int:shift_id>/close")
@login_required
@permission_required("shifts", "cash")
def force_close_shift(user, shift_id):
    payload = body()
    shift = get_shift(user, shift_id)
    if shift.status != "open":
        raise ApiError("Shift is already closed", 409)
    counted = to_money(payload.get("counted_cash"), "counted_cash")
    notes = to_text(payload.get("notes") or f"Closed by {user.full_name}", "notes", 500)
    close_shift(shift, user, counted, None, notes)
    db.session.commit()
    return jsonify({"shift": serialize_shift(shift, timeline=True)})


@api_bp.get("/attendance")
@login_required
@permission_required("shifts")
def attendance(user):
    business = user.business
    start_day, end_day = date_range_from_args(business, default_days=6)
    start, end = day_bounds(business, start_day, end_day)
    shifts = Shift.query.filter(Shift.business_id == user.business_id, Shift.opened_at >= start,
                                Shift.opened_at < end).order_by(Shift.opened_at).all()
    staff = User.query.filter_by(business_id=user.business_id, active=True).order_by(User.full_name).all()
    now = utcnow()
    rows = {u.id: {"user_id": u.id, "name": u.full_name, "role": u.role, "shift_pattern": u.shift_pattern,
                   "shifts": 0, "hours": 0.0, "break_minutes": 0, "late_count": 0, "days": {}} for u in staff}
    for s in shifts:
        row = rows.get(s.user_id)
        if not row:
            continue
        data = serialize_shift(s, totals=False)
        worked = ((_aware(s.closed_at) or now) - _aware(s.opened_at)).total_seconds()
        brk = sum(((_aware(b.ended_at) or now) - _aware(b.started_at)).total_seconds() for b in s.breaks)
        row["shifts"] += 1
        row["hours"] += max(0, worked - brk) / 3600
        row["break_minutes"] += int(brk // 60)
        if data["late_minutes"]:
            row["late_count"] += 1
        day = to_local(business, s.opened_at).date().isoformat()
        row["days"].setdefault(day, {"clock_in": data["opened_at"], "late_minutes": data["late_minutes"],
                                     "status": s.status})
    out = []
    for row in rows.values():
        row["hours"] = round(row["hours"], 1)
        out.append(row)
    days = [(start_day + timedelta(days=i)).isoformat() for i in range((end_day - start_day).days + 1)]
    return jsonify({"days": days, "staff": out})


# ---------------------------------------------------------------- expenses

def get_expense(user, expense_id):
    expense = Expense.query.filter_by(id=expense_id, business_id=user.business_id).first()
    if not expense:
        raise ApiError("Expense not found", 404)
    return expense


def apply_expense_fields(expense, payload, creating=False):
    if creating or "category" in payload:
        category = to_text(payload.get("category"), "category", 60, required=True)
        expense.category = category
    if creating or "description" in payload:
        expense.description = to_text(payload.get("description"), "description", 255, required=True)
    if creating or "amount" in payload:
        expense.amount = to_money(payload.get("amount"), "amount", minimum=Decimal("0.01"))
    if creating or "payment_method" in payload:
        expense.payment_method, _ = normalize_payment_method(payload.get("payment_method") or "cash",
                                                             allowed={"cash", "momo", "card", "bank"})
    if creating or "expense_date" in payload:
        expense.expense_date = to_date(payload.get("expense_date"), "expense_date", allow_none=False)
    if "reference" in payload:
        expense.reference = to_text(payload.get("reference"), "reference", 80)


@api_bp.get("/expenses")
@login_required
@permission_required("expenses", "cash", "reports")
def list_expenses(user):
    business = user.business
    start_day, end_day = date_range_from_args(business, default_days=29)
    query = Expense.query.filter(Expense.business_id == user.business_id, Expense.expense_date >= start_day,
                                 Expense.expense_date <= end_day)
    if request.args.get("category"):
        query = query.filter(Expense.category == request.args["category"])
    if request.args.get("status"):
        query = query.filter(Expense.status == request.args["status"])
    by_category = db.session.query(Expense.category, func.coalesce(func.sum(Expense.amount), 0)) \
        .filter(Expense.business_id == user.business_id, Expense.expense_date >= start_day,
                Expense.expense_date <= end_day, Expense.status == "approved") \
        .group_by(Expense.category).all()
    result = paginate(query.order_by(Expense.expense_date.desc(), Expense.id.desc()), lambda e: e.as_dict())
    result["summary"] = {
        "total": money_str(sum((dec(v) for _, v in by_category), Decimal(0))),
        "by_category": [{"category": c, "total": money_str(v)} for c, v in sorted(by_category, key=lambda r: -dec(r[1]))],
        "pending": Expense.query.filter_by(business_id=user.business_id, status="pending").count(),
    }
    result["categories"] = EXPENSE_CATEGORIES
    return jsonify(result)


@api_bp.post("/expenses")
@login_required
@permission_required("expenses", "cash")
def create_expense(user):
    payload = body()
    expense = Expense(business_id=user.business_id, user_id=user.id)
    apply_expense_fields(expense, payload, creating=True)
    auto_approve = has_permission(user, "expenses")
    expense.status = "approved" if auto_approve else "pending"
    db.session.add(expense)
    db.session.flush()
    if not auto_approve:
        db.session.add(Approval(business_id=user.business_id, kind="expense", entity_type="expense",
                                entity_id=str(expense.id), amount=expense.amount, requested_by=user.id,
                                summary=f"{expense.category}: {expense.description} ({expense.amount:.2f})"))
    audit(user, "expense.created", "expense", expense.id, f"{expense.category} {expense.amount:.2f}")
    db.session.commit()
    return jsonify({"expense": expense.as_dict()}), 201


@api_bp.patch("/expenses/<int:expense_id>")
@login_required
@permission_required("expenses")
def update_expense(user, expense_id):
    expense = get_expense(user, expense_id)
    apply_expense_fields(expense, body())
    audit(user, "expense.updated", "expense", expense.id, f"{expense.category} {expense.amount:.2f}")
    db.session.commit()
    return jsonify({"expense": expense.as_dict()})


@api_bp.delete("/expenses/<int:expense_id>")
@login_required
@permission_required("expenses")
def delete_expense(user, expense_id):
    expense = get_expense(user, expense_id)
    Approval.query.filter_by(business_id=user.business_id, kind="expense", entity_id=str(expense.id),
                             status="pending").update({"status": "rejected", "decided_by": user.id,
                                                       "decided_at": utcnow(), "decision_note": "Expense deleted"})
    audit(user, "expense.deleted", "expense", expense.id,
          f"Deleted {expense.category} {expense.amount:.2f}: {expense.description}")
    db.session.delete(expense)
    db.session.commit()
    return jsonify({"ok": True})
