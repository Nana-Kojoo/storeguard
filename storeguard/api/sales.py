from datetime import timedelta
from decimal import Decimal
from uuid import uuid4

from flask import jsonify, request
from sqlalchemy import func, or_

from ..extensions import db
from ..models import Approval, Customer, CustomerPayment, Device, Product, Refund, Sale, SaleItem, Shift, utcnow
from ..security import client_ip, has_permission, is_manager, login_required, permission_required
from ..utils import (CENT, MOMO_METHODS, PAYMENT_METHODS, ApiError, audit, body, date_range_from_args, day_bounds,
                     dec, like, normalize_payment_method, paginate, raise_alert, to_int, to_money, to_text)
from . import api_bp
from .catalog import check_low_stock, record_movement


def open_shift_for(user):
    return Shift.query.filter_by(business_id=user.business_id, user_id=user.id, status="open").first()


def resolve_device(user):
    token = request.headers.get("X-Device-Token", "").strip()
    if not token:
        return None
    device = Device.query.filter_by(token=token[:64], business_id=user.business_id).first()
    if device and device.status == "blocked":
        raise_alert(user.business_id, "critical", "device", f"Blocked device used: {device.name}",
                    f"{user.full_name} attempted a transaction from a blocked device ({client_ip()})",
                    subject_user_id=user.id, entity_type="device", entity_id=device.id)
        db.session.commit()
        raise ApiError("This device has been blocked by a manager", 403)
    return device


def visible_sales_query(user):
    query = Sale.query.filter(Sale.business_id == user.business_id)
    if not has_permission(user, "reports"):
        query = query.filter(Sale.cashier_id == user.id)
    return query


def get_sale(user, sale_id):
    sale = visible_sales_query(user).filter(Sale.id == sale_id).first()
    if not sale:
        raise ApiError("Sale not found", 404)
    return sale


# ---------------------------------------------------------------- sales

@api_bp.post("/sales")
@login_required
@permission_required("pos")
def create_sale(user):
    payload = body()
    business = user.business
    client_ref = to_text(payload.get("client_ref"), "client_ref", 64) or None
    if client_ref:
        existing = Sale.query.filter_by(business_id=user.business_id, client_ref=client_ref).first()
        if existing:
            return jsonify({"sale": existing.as_dict(detail=True), "duplicate": True}), 200

    device = resolve_device(user)
    payment_method, payment_reference = normalize_payment_method(
        payload.get("payment_method", "cash"), to_text(payload.get("payment_reference"), "payment_reference", 80))
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        raise ApiError("Add at least one item to the sale")

    shift = open_shift_for(user)
    if business.require_shift_for_sales and not shift and not is_manager(user):
        raise ApiError("Open your shift before recording sales", 409)

    quantities = {}
    for raw in items:
        if not isinstance(raw, dict):
            raise ApiError("Invalid sale item")
        product_id = to_int(raw.get("product_id"), "product_id")
        quantities[product_id] = quantities.get(product_id, 0) + to_int(raw.get("quantity"), "quantity", minimum=1, maximum=10_000)

    products = {p.id: p for p in Product.query.filter(
        Product.business_id == user.business_id, Product.active.is_(True), Product.id.in_(quantities)
    ).with_for_update().all()}
    subtotal = Decimal("0.00")
    for product_id, quantity in quantities.items():
        product = products.get(product_id)
        if not product:
            raise ApiError("One of the products is no longer available. Refresh and try again.", 409)
        if product.stock_quantity < quantity:
            raise ApiError(f"Insufficient stock for {product.name} (only {product.stock_quantity} left)", 409)
        subtotal += product.price * quantity

    discount = to_money(payload.get("discount") or 0, "discount")
    if discount > subtotal:
        raise ApiError("Discount cannot exceed the subtotal")
    discount_pct = (discount / subtotal * 100) if subtotal else Decimal(0)
    if discount > 0:
        if not has_permission(user, "discount"):
            raise ApiError("You are not allowed to apply discounts", 403)
        if not is_manager(user) and discount_pct > business.max_discount_pct:
            raise ApiError(f"Discounts above {business.max_discount_pct}% need a manager", 403)

    taxable = subtotal - discount
    tax = (taxable * Decimal(business.tax_rate) / 100).quantize(CENT)
    total = taxable + tax

    customer = None
    if payload.get("customer_id"):
        customer = Customer.query.filter_by(id=to_int(payload["customer_id"], "customer_id"),
                                            business_id=user.business_id, active=True).first()
        if not customer:
            raise ApiError("Customer not found")
    if payment_method == "credit":
        if not customer:
            raise ApiError("Select a customer for credit sales")
        if Decimal(customer.balance) + total > Decimal(customer.credit_limit):
            available = max(Decimal(customer.credit_limit) - Decimal(customer.balance), Decimal(0))
            raise ApiError(f"{customer.name} only has {available:.2f} credit available", 409)
        customer.balance = Decimal(customer.balance) + total

    tendered = None
    change = Decimal("0.00")
    if payment_method == "cash" and payload.get("amount_tendered") not in (None, ""):
        tendered = to_money(payload.get("amount_tendered"), "amount_tendered")
        if tendered < total:
            raise ApiError("Amount tendered is less than the total")
        change = tendered - total

    created_at = utcnow()
    offline = bool(payload.get("offline"))
    if offline and payload.get("occurred_at"):
        from datetime import datetime
        try:
            occurred = datetime.fromisoformat(str(payload["occurred_at"]).replace("Z", "+00:00"))
            if occurred.tzinfo and created_at - timedelta(days=7) <= occurred <= created_at + timedelta(minutes=5):
                created_at = occurred
        except ValueError:
            pass

    sale = Sale(business_id=user.business_id, cashier_id=user.id, shift_id=shift.id if shift else None,
                customer_id=customer.id if customer else None, device_id=device.id if device else None,
                reference=f"SG-{uuid4().hex[:10].upper()}", client_ref=client_ref, payment_method=payment_method,
                subtotal=subtotal, discount=discount, tax=tax, total=total, amount_tendered=tendered,
                change_due=change, payment_reference=payment_reference,
                note=to_text(payload.get("note"), "note", 255), offline=offline, created_at=created_at)
    db.session.add(sale)
    db.session.flush()
    for product_id, quantity in quantities.items():
        product = products[product_id]
        sale.items.append(SaleItem(product_id=product.id, product_name=product.name, quantity=quantity,
                                   unit_price=product.price, unit_cost=product.cost_price))
        record_movement(user, product, "sale", -quantity, f"Sale {sale.reference}", sale.reference)
        check_low_stock(user, product)

    if discount > 0 and discount_pct >= 20:
        raise_alert(user.business_id, "warning", "discount", "Large discount applied",
                    f"{discount_pct:.0f}% ({discount:.2f}) on {sale.reference}", subject_user_id=user.id,
                    entity_type="sale", entity_id=sale.id)
    audit(user, "sale.completed", "sale", sale.id, f"{sale.reference} {payment_method} {total:.2f}")
    db.session.commit()
    return jsonify({"sale": sale.as_dict(detail=True)}), 201


def apply_sale_filters(query, user):
    business = user.business
    if request.args.get("start") or request.args.get("end") or request.args.get("days"):
        days = to_int(request.args.get("days"), "days", minimum=0, maximum=366, default=0)
        start_day, end_day = date_range_from_args(business, default_days=days)
        start, end = day_bounds(business, start_day, end_day)
        query = query.filter(Sale.created_at >= start, Sale.created_at < end)
    if request.args.get("status"):
        query = query.filter(Sale.status == request.args["status"])
    if request.args.get("payment_method"):
        wanted = request.args["payment_method"]
        if wanted in MOMO_METHODS:  # "Mobile Money" includes legacy Telecel / AT sales
            query = query.filter(Sale.payment_method.in_(MOMO_METHODS))
        else:
            query = query.filter(Sale.payment_method == wanted)
    if request.args.get("cashier_id"):
        query = query.filter(Sale.cashier_id == to_int(request.args["cashier_id"], "cashier_id"))
    if request.args.get("mine") == "1":
        query = query.filter(Sale.cashier_id == user.id)
    if request.args.get("shift_id"):
        query = query.filter(Sale.shift_id == to_int(request.args["shift_id"], "shift_id"))
    if request.args.get("q"):
        term = like(request.args["q"].strip())
        query = query.outerjoin(Customer, Sale.customer_id == Customer.id).filter(
            or_(Sale.reference.ilike(term, escape="\\"), Customer.name.ilike(term, escape="\\"),
                Sale.payment_reference.ilike(term, escape="\\")))
    return query


@api_bp.get("/sales")
@login_required
def list_sales(user):
    query = apply_sale_filters(visible_sales_query(user), user)
    totals = query.with_entities(func.count(Sale.id), func.coalesce(func.sum(Sale.total), 0),
                                 func.coalesce(func.sum(Sale.refunded_amount), 0)).order_by(None).one()
    result = paginate(query.order_by(Sale.created_at.desc(), Sale.id.desc()), lambda s: s.as_dict(), default_per_page=25)
    result["summary"] = {"count": totals[0], "revenue": str(dec(totals[1])), "refunded": str(dec(totals[2])),
                         "net": str(dec(totals[1]) - dec(totals[2]))}
    return jsonify(result)


@api_bp.get("/sales/<int:sale_id>")
@login_required
def sale_detail(user, sale_id):
    sale = get_sale(user, sale_id)
    pending = Approval.query.filter_by(business_id=user.business_id, kind="refund", entity_id=str(sale.id),
                                       status="pending").first()
    data = sale.as_dict(detail=True)
    data["pending_refund_approval"] = pending.as_dict() if pending else None
    return jsonify({"sale": data, "business": user.business.as_dict()})


# ---------------------------------------------------------------- refunds

def build_refund_lines(sale, raw_items):
    """Validate requested refund lines; returns [(SaleItem, qty)] and the refund amount."""
    by_id = {item.id: item for item in sale.items}
    lines = []
    if not raw_items:
        lines = [(item, item.quantity - item.refunded_quantity) for item in sale.items
                 if item.quantity > item.refunded_quantity]
    else:
        if not isinstance(raw_items, list):
            raise ApiError("Invalid refund items")
        for raw in raw_items:
            item = by_id.get(to_int((raw or {}).get("sale_item_id"), "sale_item_id"))
            if not item:
                raise ApiError("Refund item does not belong to this sale")
            qty = to_int(raw.get("quantity"), "quantity", minimum=0)
            if qty == 0:
                continue
            if qty > item.quantity - item.refunded_quantity:
                raise ApiError(f"Only {item.quantity - item.refunded_quantity} of {item.product_name} can be refunded")
            lines.append((item, qty))
    if not lines:
        raise ApiError("Nothing left to refund on this sale")

    remaining_after = sum(i.quantity - i.refunded_quantity for i in sale.items) - sum(q for _, q in lines)
    if remaining_after == 0:
        amount = Decimal(sale.total) - Decimal(sale.refunded_amount)
    else:
        line_value = sum(item.unit_price * qty for item, qty in lines)
        amount = (Decimal(sale.total) * line_value / Decimal(sale.subtotal)).quantize(CENT) if sale.subtotal else Decimal(0)
        amount = min(amount, Decimal(sale.total) - Decimal(sale.refunded_amount))
    return lines, amount


def execute_refund(sale, raw_items, reason, requester, approver=None):
    lines, amount = build_refund_lines(sale, raw_items)
    actor = approver or requester
    for item, qty in lines:
        item.refunded_quantity += qty
        product = db.session.get(Product, item.product_id)
        record_movement(actor, product, "refund_return", qty, f"Refund on {sale.reference}", sale.reference)
    sale.refunded_amount = Decimal(sale.refunded_amount) + amount
    fully = all(i.refunded_quantity >= i.quantity for i in sale.items)
    sale.status = "refunded" if fully else "partially_refunded"
    if sale.payment_method == "credit" and sale.customer:
        sale.customer.balance = max(Decimal(sale.customer.balance) - amount, Decimal(0))
    shift = open_shift_for(requester) or (open_shift_for(approver) if approver else None)
    refund = Refund(business_id=sale.business_id, sale_id=sale.id, user_id=requester.id,
                    approved_by=approver.id if approver else None, shift_id=shift.id if shift else None,
                    amount=amount, method=sale.payment_method, reason=reason,
                    items=[{"sale_item_id": i.id, "product_name": i.product_name, "quantity": q} for i, q in lines])
    db.session.add(refund)
    audit(actor, "sale.refunded", "sale", sale.id, f"{sale.reference} refunded {amount:.2f}: {reason}")

    since = utcnow() - timedelta(hours=24)
    recent = Refund.query.filter(Refund.business_id == sale.business_id, Refund.user_id == requester.id,
                                 Refund.created_at >= since).count() + 1
    if recent >= 3:
        raise_alert(sale.business_id, "critical" if recent >= 5 else "warning", "refund", "Unusual refund frequency",
                    f"{requester.full_name} processed {recent} refunds in 24 hours (latest {sale.reference})",
                    subject_user_id=requester.id, entity_type="user", entity_id=requester.id, dedupe=True)
    return refund


@api_bp.post("/sales/<int:sale_id>/refund")
@login_required
@permission_required("pos", "refund")
def refund_sale(user, sale_id):
    payload = body()
    sale = get_sale(user, sale_id)
    if sale.status in {"refunded", "voided"}:
        raise ApiError(f"Sale is already {sale.status}", 409)
    reason = to_text(payload.get("reason"), "reason", 255, required=True)
    raw_items = payload.get("items") or None
    lines, amount = build_refund_lines(sale, raw_items)

    can_refund = has_permission(user, "refund")
    needs_approval = not can_refund or (amount > Decimal(user.business.refund_approval_threshold) and not is_manager(user))
    if needs_approval:
        if Approval.query.filter_by(business_id=user.business_id, kind="refund", entity_id=str(sale.id),
                                    status="pending").first():
            raise ApiError("A refund request for this sale is already awaiting approval", 409)
        approval = Approval(business_id=user.business_id, kind="refund", entity_type="sale", entity_id=str(sale.id),
                            summary=f"Refund {amount:.2f} on {sale.reference}: {reason}", amount=amount,
                            payload={"items": raw_items, "reason": reason}, requested_by=user.id)
        db.session.add(approval)
        db.session.flush()
        audit(user, "refund.requested", "sale", sale.id, f"Requested refund {amount:.2f} on {sale.reference}")
        db.session.commit()
        return jsonify({"status": "pending_approval", "approval": approval.as_dict(),
                        "message": "Refund sent to a manager for approval"}), 202

    execute_refund(sale, raw_items, reason, user)
    db.session.commit()
    return jsonify({"status": "refunded", "sale": sale.as_dict(detail=True)})


@api_bp.get("/refunds")
@login_required
def list_refunds(user):
    query = Refund.query.filter(Refund.business_id == user.business_id)
    if not has_permission(user, "reports") or request.args.get("mine") == "1":
        query = query.filter(Refund.user_id == user.id)
    if request.args.get("start") or request.args.get("end"):
        start_day, end_day = date_range_from_args(user.business)
        start, end = day_bounds(user.business, start_day, end_day)
        query = query.filter(Refund.created_at >= start, Refund.created_at < end)
    result = paginate(query.order_by(Refund.created_at.desc()), lambda r: r.as_dict())
    pending = Approval.query.filter_by(business_id=user.business_id, kind="refund", status="pending")
    if not has_permission(user, "approvals"):
        pending = pending.filter_by(requested_by=user.id)
    result["pending"] = [a.as_dict() for a in pending.order_by(Approval.created_at.desc()).limit(50)]
    return jsonify(result)


# ---------------------------------------------------------------- customers

def get_customer(user, customer_id):
    customer = Customer.query.filter_by(id=customer_id, business_id=user.business_id).first()
    if not customer:
        raise ApiError("Customer not found", 404)
    return customer


def apply_customer_fields(customer, payload, creating=False):
    if creating or "name" in payload:
        customer.name = to_text(payload.get("name"), "name", 160, required=True)
    for field, limit in (("phone", 40), ("email", 255), ("notes", 500)):
        if field in payload:
            setattr(customer, field, to_text(payload.get(field), field, limit))
    if creating or "credit_limit" in payload:
        customer.credit_limit = to_money(payload.get("credit_limit") or 0, "credit_limit")


@api_bp.get("/customers")
@login_required
@permission_required("customers", "pos")
def list_customers(user):
    query = Customer.query.filter_by(business_id=user.business_id, active=True)
    if request.args.get("q"):
        term = like(request.args["q"].strip())
        query = query.filter(or_(Customer.name.ilike(term, escape="\\"), Customer.phone.ilike(term, escape="\\")))
    if request.args.get("owing") == "1":
        query = query.filter(Customer.balance > 0)
    rows = query.order_by(Customer.name).limit(1000).all()
    return jsonify({"customers": [c.as_dict() for c in rows]})


@api_bp.get("/customers/<int:customer_id>")
@login_required
@permission_required("customers")
def customer_detail(user, customer_id):
    customer = get_customer(user, customer_id)
    sales = Sale.query.filter_by(business_id=user.business_id, customer_id=customer.id) \
        .order_by(Sale.created_at.desc()).limit(100).all()
    payments = CustomerPayment.query.filter_by(business_id=user.business_id, customer_id=customer.id) \
        .order_by(CustomerPayment.created_at.desc()).limit(100).all()
    return jsonify({"customer": customer.as_dict(), "sales": [s.as_dict() for s in sales],
                    "payments": [p.as_dict() for p in payments]})


@api_bp.post("/customers")
@login_required
@permission_required("customers", "pos")
def create_customer(user):
    payload = body()
    customer = Customer(business_id=user.business_id, balance=0)
    apply_customer_fields(customer, payload, creating=True)
    if customer.credit_limit > 0 and not has_permission(user, "customers"):
        raise ApiError("Only managers can grant credit", 403)
    db.session.add(customer)
    db.session.flush()
    audit(user, "customer.created", "customer", customer.id, f"Created customer {customer.name}")
    db.session.commit()
    return jsonify({"customer": customer.as_dict()}), 201


@api_bp.patch("/customers/<int:customer_id>")
@login_required
@permission_required("customers")
def update_customer(user, customer_id):
    customer = get_customer(user, customer_id)
    apply_customer_fields(customer, body())
    audit(user, "customer.updated", "customer", customer.id, f"Updated customer {customer.name}")
    db.session.commit()
    return jsonify({"customer": customer.as_dict()})


@api_bp.delete("/customers/<int:customer_id>")
@login_required
@permission_required("customers")
def archive_customer(user, customer_id):
    customer = get_customer(user, customer_id)
    if Decimal(customer.balance) > 0:
        raise ApiError("Customer still owes money; settle the balance first", 409)
    customer.active = False
    audit(user, "customer.archived", "customer", customer.id, f"Archived customer {customer.name}")
    db.session.commit()
    return jsonify({"ok": True})


@api_bp.post("/customers/<int:customer_id>/payments")
@login_required
@permission_required("customers", "pos")
def record_customer_payment(user, customer_id):
    payload = body()
    customer = get_customer(user, customer_id)
    amount = to_money(payload.get("amount"), "amount", minimum=Decimal("0.01"))
    if amount > Decimal(customer.balance):
        raise ApiError(f"Payment exceeds the outstanding balance of {Decimal(customer.balance):.2f}")
    method, _ = normalize_payment_method(payload.get("method", "cash"), allowed=PAYMENT_METHODS - {"credit"})
    shift = open_shift_for(user)
    payment = CustomerPayment(business_id=user.business_id, customer_id=customer.id, user_id=user.id,
                              shift_id=shift.id if shift else None, amount=amount, method=method,
                              note=to_text(payload.get("note"), "note", 255))
    customer.balance = Decimal(customer.balance) - amount
    db.session.add(payment)
    db.session.flush()
    audit(user, "customer.payment", "customer", customer.id, f"Received {amount:.2f} ({method}) from {customer.name}")
    db.session.commit()
    return jsonify({"customer": customer.as_dict(), "payment": payment.as_dict()}), 201
