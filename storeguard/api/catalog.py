from datetime import timedelta
from uuid import uuid4

from flask import jsonify, request
from sqlalchemy import or_

from ..extensions import db
from ..models import Product, PurchaseItem, PurchaseOrder, StockMovement, Supplier, utcnow
from ..security import has_permission, login_required, permission_required
from ..utils import (ApiError, audit, body, clean_image, date_range_from_args, day_bounds, like, local_today, paginate,
                     raise_alert, to_date, to_int, to_money, to_text)
from . import api_bp

ADJUSTMENT_REASONS = {
    "count_correction": "Stock count correction",
    "damaged": "Damaged goods",
    "expired": "Expired goods",
    "theft": "Theft / shrinkage",
    "returned_to_supplier": "Returned to supplier",
    "internal_use": "Internal use",
    "found": "Found stock",
}
LOSS_REASONS = {"damaged", "expired", "theft"}


def get_product(user, product_id):
    product = Product.query.filter_by(id=product_id, business_id=user.business_id, active=True).first()
    if not product:
        raise ApiError("Product not found", 404)
    return product


def record_movement(user, product, movement_type, delta, reason, reference=""):
    previous = product.stock_quantity
    new = previous + delta
    if new < 0:
        raise ApiError(f"Insufficient stock for {product.name}")
    product.stock_quantity = new
    db.session.add(StockMovement(business_id=user.business_id, product_id=product.id, user_id=user.id,
                                 movement_type=movement_type, quantity=delta, previous_quantity=previous,
                                 new_quantity=new, reason=reason[:255], reference=reference[:80]))
    return product


def check_low_stock(user, product):
    if user.business.low_stock_alerts and product.stock_quantity <= product.reorder_level:
        severity = "warning" if product.stock_quantity <= 0 else "info"
        title = f"{'Out of stock' if product.stock_quantity <= 0 else 'Low stock'}: {product.name}"
        raise_alert(user.business_id, severity, "inventory", title,
                    f"{product.stock_quantity} left (reorder level {product.reorder_level})",
                    entity_type="product", entity_id=product.id, dedupe=True)


def apply_product_fields(product, payload, user, creating=False):
    if "image" in payload:
        product.image = clean_image(payload.get("image"))
    if creating or "name" in payload:
        product.name = to_text(payload.get("name"), "name", 160, required=True)
    if creating or "sku" in payload:
        product.sku = to_text(payload.get("sku"), "sku", 80, required=True)
    if "barcode" in payload:
        product.barcode = to_text(payload.get("barcode"), "barcode", 80)
    if creating or "category" in payload:
        product.category = to_text(payload.get("category") or "general", "category", 80).lower() or "general"
    if "unit" in payload:
        product.unit = to_text(payload.get("unit") or "unit", "unit", 20) or "unit"
    if creating or "price" in payload:
        product.price = to_money(payload.get("price"), "price")
    if creating or "cost_price" in payload:
        product.cost_price = to_money(payload.get("cost_price") or 0, "cost_price")
    if creating or "reorder_level" in payload:
        product.reorder_level = to_int(payload.get("reorder_level"), "reorder_level", minimum=0, default=5)
    if "expiry_date" in payload:
        product.expiry_date = to_date(payload.get("expiry_date"), "expiry_date")
    if "supplier_id" in payload:
        supplier_id = payload.get("supplier_id") or None
        if supplier_id is not None:
            supplier = Supplier.query.filter_by(id=to_int(supplier_id, "supplier_id"), business_id=user.business_id).first()
            if not supplier:
                raise ApiError("Supplier not found")
            supplier_id = supplier.id
        product.supplier_id = supplier_id
    with db.session.no_autoflush:
        duplicate = Product.query.filter(Product.business_id == user.business_id, Product.sku == product.sku,
                                         Product.id != (product.id or 0)).first()
    if duplicate:
        raise ApiError("A product with this SKU already exists", 409)


# ---------------------------------------------------------------- products

@api_bp.get("/products")
@login_required
def list_products(user):
    query = Product.query.filter_by(business_id=user.business_id)
    if request.args.get("include_archived") != "1":
        query = query.filter_by(active=True)
    rows = query.order_by(Product.name).all()
    show_cost = has_permission(user, "inventory") or has_permission(user, "reports")
    return jsonify({"products": [row.as_dict(include_cost=show_cost) for row in rows]})


@api_bp.get("/products/<int:product_id>")
@login_required
def product_detail(user, product_id):
    product = get_product(user, product_id)
    movements = StockMovement.query.filter_by(business_id=user.business_id, product_id=product.id) \
        .order_by(StockMovement.created_at.desc()).limit(50).all()
    return jsonify({"product": product.as_dict(include_cost=has_permission(user, "inventory")),
                    "movements": [m.as_dict() for m in movements]})


@api_bp.post("/products")
@login_required
@permission_required("inventory")
def create_product(user):
    payload = body()
    product = Product(business_id=user.business_id, stock_quantity=0)
    apply_product_fields(product, payload, user, creating=True)
    opening = to_int(payload.get("stock_quantity"), "stock_quantity", minimum=0, default=0)
    db.session.add(product)
    db.session.flush()
    if opening:
        record_movement(user, product, "opening_stock", opening, "Product creation")
    audit(user, "product.created", "product", product.id, f"Created {product.name} ({product.sku})")
    db.session.commit()
    return jsonify({"product": product.as_dict()}), 201


@api_bp.patch("/products/<int:product_id>")
@login_required
@permission_required("inventory")
def update_product(user, product_id):
    product = get_product(user, product_id)
    payload = body()
    apply_product_fields(product, payload, user)
    if "stock_quantity" in payload:
        target = to_int(payload["stock_quantity"], "stock_quantity", minimum=0)
        if target != product.stock_quantity:
            reason = to_text(payload.get("adjust_reason") or "Inventory edit", "adjust_reason", 255)
            record_movement(user, product, "adjustment", target - product.stock_quantity, reason)
    audit(user, "product.updated", "product", product.id, f"Updated {product.name}")
    db.session.commit()
    return jsonify({"product": product.as_dict()})


@api_bp.post("/products/<int:product_id>/restock")
@login_required
@permission_required("inventory")
def restock_product(user, product_id):
    payload = body()
    quantity = to_int(payload.get("quantity"), "quantity", minimum=1, maximum=1_000_000)
    product = get_product(user, product_id)
    if "unit_cost" in payload and payload["unit_cost"] not in (None, ""):
        product.cost_price = to_money(payload["unit_cost"], "unit_cost")
    note = to_text(payload.get("note") or "Manual restock", "note", 255)
    record_movement(user, product, "supplier_delivery", quantity, note)
    audit(user, "stock.restocked", "product", product.id, f"+{quantity} {product.name}: {note}")
    db.session.commit()
    return jsonify({"product": product.as_dict()})


@api_bp.post("/products/<int:product_id>/adjust")
@login_required
@permission_required("inventory")
def adjust_product(user, product_id):
    payload = body()
    product = get_product(user, product_id)
    reason_code = payload.get("reason")
    if reason_code not in ADJUSTMENT_REASONS:
        raise ApiError("Choose a valid adjustment reason")
    quantity = to_int(payload.get("quantity"), "quantity", minimum=-1_000_000, maximum=1_000_000)
    if quantity == 0:
        raise ApiError("Quantity cannot be zero")
    if reason_code in LOSS_REASONS and quantity > 0:
        quantity = -quantity
    note = to_text(payload.get("note"), "note", 200)
    reason = ADJUSTMENT_REASONS[reason_code] + (f": {note}" if note else "")
    record_movement(user, product, reason_code, quantity, reason)
    if reason_code in LOSS_REASONS:
        loss_value = abs(quantity) * product.cost_price
        raise_alert(user.business_id, "warning" if reason_code == "theft" else "info", "inventory",
                    f"Stock loss recorded: {product.name}",
                    f"{abs(quantity)} units written off as {ADJUSTMENT_REASONS[reason_code].lower()} "
                    f"(cost value {loss_value:.2f})", subject_user_id=user.id, entity_type="product",
                    entity_id=product.id)
    check_low_stock(user, product)
    audit(user, "stock.adjusted", "product", product.id, f"{quantity:+d} {product.name}: {reason}")
    db.session.commit()
    return jsonify({"product": product.as_dict()})


@api_bp.delete("/products/<int:product_id>")
@login_required
@permission_required("inventory")
def archive_product(user, product_id):
    product = get_product(user, product_id)
    product.active = False
    audit(user, "product.archived", "product", product.id, f"Archived {product.name}")
    db.session.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- stock movements

@api_bp.get("/stock-movements")
@login_required
@permission_required("inventory", "audit", "reports")
def list_stock_movements(user):
    start_day, end_day = date_range_from_args(user.business, default_days=30)
    start, end = day_bounds(user.business, start_day, end_day)
    query = StockMovement.query.filter(StockMovement.business_id == user.business_id,
                                       StockMovement.created_at >= start, StockMovement.created_at < end)
    if request.args.get("type"):
        query = query.filter(StockMovement.movement_type == request.args["type"])
    if request.args.get("product_id"):
        query = query.filter(StockMovement.product_id == to_int(request.args["product_id"], "product_id"))
    if request.args.get("direction") == "in":
        query = query.filter(StockMovement.quantity > 0)
    elif request.args.get("direction") == "out":
        query = query.filter(StockMovement.quantity < 0)
    if request.args.get("q"):
        term = like(request.args["q"].strip())
        query = query.join(Product).filter(or_(Product.name.ilike(term, escape="\\"), Product.sku.ilike(term, escape="\\"),
                                               StockMovement.reference.ilike(term, escape="\\")))
    query = query.order_by(StockMovement.created_at.desc(), StockMovement.id.desc())
    return jsonify(paginate(query, lambda m: m.as_dict(), default_per_page=50))


# ---------------------------------------------------------------- suppliers

def get_supplier(user, supplier_id):
    supplier = Supplier.query.filter_by(id=supplier_id, business_id=user.business_id).first()
    if not supplier:
        raise ApiError("Supplier not found", 404)
    return supplier


def apply_supplier_fields(supplier, payload, creating=False):
    if creating or "name" in payload:
        supplier.name = to_text(payload.get("name"), "name", 160, required=True)
    for field, limit in (("contact_name", 160), ("phone", 40), ("email", 255), ("address", 255), ("notes", 500)):
        if field in payload:
            setattr(supplier, field, to_text(payload.get(field), field, limit))


@api_bp.get("/suppliers")
@login_required
@permission_required("suppliers", "inventory")
def list_suppliers(user):
    suppliers = Supplier.query.filter_by(business_id=user.business_id, active=True).order_by(Supplier.name).all()
    open_orders = dict(db.session.query(PurchaseOrder.supplier_id, db.func.count(PurchaseOrder.id))
                       .filter_by(business_id=user.business_id, status="ordered").group_by(PurchaseOrder.supplier_id).all())
    product_counts = dict(db.session.query(Product.supplier_id, db.func.count(Product.id))
                          .filter_by(business_id=user.business_id, active=True).group_by(Product.supplier_id).all())
    out = []
    for s in suppliers:
        row = s.as_dict()
        row["open_orders"] = open_orders.get(s.id, 0)
        row["product_count"] = product_counts.get(s.id, 0)
        out.append(row)
    return jsonify({"suppliers": out})


@api_bp.post("/suppliers")
@login_required
@permission_required("suppliers")
def create_supplier(user):
    supplier = Supplier(business_id=user.business_id)
    apply_supplier_fields(supplier, body(), creating=True)
    db.session.add(supplier)
    db.session.flush()
    audit(user, "supplier.created", "supplier", supplier.id, f"Created supplier {supplier.name}")
    db.session.commit()
    return jsonify({"supplier": supplier.as_dict()}), 201


@api_bp.patch("/suppliers/<int:supplier_id>")
@login_required
@permission_required("suppliers")
def update_supplier(user, supplier_id):
    supplier = get_supplier(user, supplier_id)
    apply_supplier_fields(supplier, body())
    audit(user, "supplier.updated", "supplier", supplier.id, f"Updated supplier {supplier.name}")
    db.session.commit()
    return jsonify({"supplier": supplier.as_dict()})


@api_bp.delete("/suppliers/<int:supplier_id>")
@login_required
@permission_required("suppliers")
def archive_supplier(user, supplier_id):
    supplier = get_supplier(user, supplier_id)
    supplier.active = False
    audit(user, "supplier.archived", "supplier", supplier.id, f"Archived supplier {supplier.name}")
    db.session.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- purchase orders

def get_order(user, order_id):
    order = PurchaseOrder.query.filter_by(id=order_id, business_id=user.business_id).first()
    if not order:
        raise ApiError("Purchase order not found", 404)
    return order


@api_bp.get("/purchase-orders")
@login_required
@permission_required("suppliers", "inventory")
def list_purchase_orders(user):
    query = PurchaseOrder.query.filter_by(business_id=user.business_id)
    if request.args.get("status"):
        query = query.filter_by(status=request.args["status"])
    if request.args.get("supplier_id"):
        query = query.filter_by(supplier_id=to_int(request.args["supplier_id"], "supplier_id"))
    query = query.order_by(PurchaseOrder.created_at.desc())
    return jsonify(paginate(query, lambda o: o.as_dict(), default_per_page=25))


@api_bp.post("/purchase-orders")
@login_required
@permission_required("suppliers")
def create_purchase_order(user):
    payload = body()
    supplier = get_supplier(user, to_int(payload.get("supplier_id"), "supplier_id"))
    items = payload.get("items") or []
    if not isinstance(items, list) or not items:
        raise ApiError("Add at least one product to the order")
    order = PurchaseOrder(business_id=user.business_id, supplier_id=supplier.id, created_by=user.id,
                          reference=f"PO-{uuid4().hex[:8].upper()}",
                          expected_date=to_date(payload.get("expected_date"), "expected_date"),
                          notes=to_text(payload.get("notes"), "notes", 500))
    total = 0
    seen = set()
    for raw in items:
        if not isinstance(raw, dict):
            raise ApiError("Invalid order line")
        product = get_product(user, to_int(raw.get("product_id"), "product_id"))
        if product.id in seen:
            raise ApiError(f"{product.name} is listed more than once")
        seen.add(product.id)
        quantity = to_int(raw.get("quantity"), "quantity", minimum=1, maximum=1_000_000)
        unit_cost = to_money(raw.get("unit_cost") if raw.get("unit_cost") not in (None, "") else product.cost_price, "unit_cost")
        order.items.append(PurchaseItem(product_id=product.id, quantity=quantity, unit_cost=unit_cost))
        total += unit_cost * quantity
    order.total = total
    db.session.add(order)
    db.session.flush()
    audit(user, "purchase_order.created", "purchase_order", order.id, f"{order.reference} for {supplier.name}")
    db.session.commit()
    return jsonify({"order": order.as_dict()}), 201


@api_bp.post("/purchase-orders/<int:order_id>/receive")
@login_required
@permission_required("suppliers", "inventory")
def receive_purchase_order(user, order_id):
    order = get_order(user, order_id)
    if order.status != "ordered":
        raise ApiError(f"Order is already {order.status}", 409)
    for item in order.items:
        product = item.product
        if not product.active:
            continue
        product.cost_price = item.unit_cost
        record_movement(user, product, "supplier_delivery", item.quantity,
                        f"Received from {order.supplier.name}", order.reference)
    order.status = "received"
    order.received_by = user.id
    order.received_at = utcnow()
    audit(user, "purchase_order.received", "purchase_order", order.id, f"Received {order.reference}")
    db.session.commit()
    return jsonify({"order": order.as_dict()})


@api_bp.post("/purchase-orders/<int:order_id>/cancel")
@login_required
@permission_required("suppliers")
def cancel_purchase_order(user, order_id):
    order = get_order(user, order_id)
    if order.status != "ordered":
        raise ApiError(f"Order is already {order.status}", 409)
    order.status = "cancelled"
    audit(user, "purchase_order.cancelled", "purchase_order", order.id, f"Cancelled {order.reference}")
    db.session.commit()
    return jsonify({"order": order.as_dict()})


@api_bp.get("/inventory/expiring")
@login_required
@permission_required("inventory", "reports")
def expiring_products(user):
    days =to_int(request.args.get("days"), "days", minimum=1, maximum=365, default=30)
    today = local_today(user.business)
    rows = Product.query.filter(Product.business_id == user.business_id, Product.active.is_(True),
                                Product.expiry_date.isnot(None),
                                Product.expiry_date <= today + timedelta(days=days)) \
        .order_by(Product.expiry_date).all()
    return jsonify({"products": [p.as_dict() for p in rows]})
