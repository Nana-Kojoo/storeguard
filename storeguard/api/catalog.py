import re
from datetime import timedelta
from uuid import uuid4

from flask import jsonify, request
from sqlalchemy import or_

from ..extensions import db
from ..models import Category, Product, PurchaseItem, PurchaseOrder, StockMovement, Supplier, product_categories, utcnow
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


def generate_sku(user, name):
    """Build a readable unique SKU such as RICE-5KG-001 from the product name."""
    prefix = "-".join(re.findall(r"[A-Z0-9]+", (name or "").upper())[:3])[:20] or "ITEM"
    taken = {sku for (sku,) in db.session.query(Product.sku).filter(Product.business_id == user.business_id,
                                                                     Product.sku.like(f"{prefix}-%"))}
    n = 1
    while f"{prefix}-{n:03d}" in taken:
        n += 1
    return f"{prefix}-{n:03d}"


def apply_product_fields(product, payload, user, creating=False):
    if "image" in payload:
        product.image = clean_image(payload.get("image"))
    if creating or "name" in payload:
        product.name = to_text(payload.get("name"), "name", 160, required=True)
    if creating and not str(payload.get("sku") or "").strip():
        product.sku = generate_sku(user, product.name)
    elif creating or "sku" in payload:
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


def apply_product_categories(product, payload, user, creating=False):
    if "category_ids" in payload:
        ids = payload.get("category_ids") or []
        if not isinstance(ids, list):
            raise ApiError("category_ids must be a list")
        try:
            ids = list(dict.fromkeys(int(value) for value in ids))
        except (TypeError, ValueError):
            raise ApiError("category_ids must contain valid category IDs")
        found = {c.id: c for c in Category.query.filter(Category.business_id == user.business_id, Category.id.in_(ids)).all()} if ids else {}
        if len(found) != len(ids):
            raise ApiError("One or more categories were not found")
        if ids:
            product.categories = [found[i] for i in ids]
            if "category" not in payload:
                product.category = found[ids[0]].name
            return
        # No categories ticked: fall back to the product's primary category so it is never uncategorised.
        product.categories = []
        creating = True
    if not (creating or "category" in payload):
        return
    name = product.category
    category = Category.query.filter_by(business_id=user.business_id, name=name).first()
    if not category:
        category = Category(business_id=user.business_id, name=name)
        db.session.add(category)
        db.session.flush()
    if category not in product.categories:
        product.categories.append(category)


# ---------------------------------------------------------------- categories

@api_bp.get("/categories")
@login_required
@permission_required("inventory")
def list_categories(user):
    categories = Category.query.filter_by(business_id=user.business_id).order_by(Category.name).all()
    counts = dict(db.session.query(product_categories.c.category_id, db.func.count(product_categories.c.product_id))
                  .join(Product, Product.id == product_categories.c.product_id)
                  .filter(Product.business_id == user.business_id, Product.active.is_(True))
                  .group_by(product_categories.c.category_id).all())
    return jsonify({"categories": [category.as_dict(counts.get(category.id, 0)) for category in categories]})


@api_bp.post("/categories")
@login_required
@permission_required("inventory")
def create_category(user):
    name = to_text(body().get("name"), "name", 80, required=True).strip().lower()
    if Category.query.filter_by(business_id=user.business_id, name=name).first():
        raise ApiError("A category with this name already exists", 409)
    category = Category(business_id=user.business_id, name=name)
    db.session.add(category)
    db.session.flush()
    audit(user, "category.created", "category", category.id, f"Created category {category.name}")
    db.session.commit()
    return jsonify({"category": category.as_dict()}), 201


@api_bp.patch("/categories/<int:category_id>")
@login_required
@permission_required("inventory")
def update_category(user, category_id):
    category = Category.query.filter_by(id=category_id, business_id=user.business_id).first()
    if not category:
        raise ApiError("Category not found", 404)
    old_name = category.name
    name = to_text(body().get("name"), "name", 80, required=True).strip().lower()
    duplicate = Category.query.filter(Category.business_id == user.business_id, Category.name == name,
                                      Category.id != category.id).first()
    if duplicate:
        raise ApiError("A category with this name already exists", 409)
    category.name = name
    for product in category.products:
        if product.category == old_name:
            product.category = name
    audit(user, "category.updated", "category", category.id, f"Updated category {category.name}")
    db.session.commit()
    return jsonify({"category": category.as_dict(len(category.products))})


@api_bp.delete("/categories/<int:category_id>")
@login_required
@permission_required("inventory")
def delete_category(user, category_id):
    category = Category.query.filter_by(id=category_id, business_id=user.business_id).first()
    if not category:
        raise ApiError("Category not found", 404)
    if category.products:
        raise ApiError("Remove this category from its products (including archived ones) before deleting it", 409)
    audit(user, "category.deleted", "category", category.id, f"Deleted category {category.name}")
    db.session.delete(category)
    db.session.commit()
    return jsonify({"ok": True})


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
    apply_product_categories(product, payload, user, creating=True)
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
    apply_product_categories(product, payload, user)
    if "stock_quantity" in payload:
        target = to_int(payload["stock_quantity"], "stock_quantity", minimum=0)
        if target != product.stock_quantity:
            reason = to_text(payload.get("adjust_reason") or "Inventory edit", "adjust_reason", 255)
            record_movement(user, product, "adjustment", target - product.stock_quantity, reason)
    audit(user, "product.updated", "product", product.id, f"Updated {product.name}")
    db.session.commit()
    return jsonify({"product": product.as_dict()})


IMPORT_FIELDS = ("name", "sku", "barcode", "category", "unit", "price", "cost_price", "stock_quantity",
                 "reorder_level", "expiry_date")
MAX_IMPORT_ROWS = 2000


def _clean_number(value):
    """Spreadsheets often contain prices like "GH₵ 1,200.50" — keep only the number."""
    if value is None or isinstance(value, (int, float)):
        return value
    text = re.sub(r"[^0-9.\-]", "", str(value))
    return text


def _find_existing(user, row):
    sku = str(row.get("sku") or "").strip()
    barcode = str(row.get("barcode") or "").strip()
    name = str(row.get("name") or "").strip()
    query = Product.query.filter(Product.business_id == user.business_id)
    if sku:
        found = query.filter(Product.sku == sku).first()
        if found:
            return found
    if barcode:
        found = query.filter(Product.barcode == barcode).first()
        if found:
            return found
    if name:
        return query.filter(db.func.lower(Product.name) == name.lower()).first()
    return None


def _categories_for(user, text, cache):
    result = []
    for name in [part.strip().lower()[:80] for part in re.split(r"[,;|/]", str(text or "")) if part.strip()]:
        if name not in cache:
            category = Category.query.filter_by(business_id=user.business_id, name=name).first()
            if not category:
                category = Category(business_id=user.business_id, name=name)
                db.session.add(category)
                db.session.flush()
            cache[name] = category
        if cache[name] not in result:
            result.append(cache[name])
    return result


def _validate_import_row(user, row):
    """Check every value up front so a bad row fails before anything is written (no savepoints needed)."""
    v = {
        "name": to_text(row.get("name"), "name", 160),
        "sku": to_text(row.get("sku"), "sku", 80),
        "barcode": to_text(row.get("barcode"), "barcode", 80),
        "unit": to_text(row.get("unit"), "unit", 20),
        "price": to_money(_clean_number(row.get("price")), "price", allow_none=True),
        "cost_price": to_money(_clean_number(row.get("cost_price")), "cost_price", allow_none=True),
        "reorder_level": to_int(_clean_number(row.get("reorder_level")), "reorder_level", minimum=0, default=-1),
        "stock": to_int(_clean_number(row.get("stock_quantity")), "stock_quantity", minimum=0, maximum=10_000_000,
                        default=-1),
        "expiry_date": to_date(row.get("expiry_date"), "expiry_date"),
        "categories": [part.strip().lower()[:80] for part in re.split(r"[,;|/]", str(row.get("category") or ""))
                       if part.strip()],
    }
    product = _find_existing(user, row)
    if not product:
        if not v["name"]:
            raise ApiError("Product name is required")
        if v["price"] is None:
            raise ApiError("Price is required for new products")
    if v["sku"] and (not product or product.sku != v["sku"]):
        if Product.query.filter_by(business_id=user.business_id, sku=v["sku"]).first():
            raise ApiError(f"SKU {v['sku']} is already used by another product")
    return product, v


def _import_row(user, row, stock_mode, category_cache):
    product, v = _validate_import_row(user, row)
    payload = {k: (str(v[k]) if k in ("price", "cost_price") else v[k])
               for k in ("name", "sku", "barcode", "unit", "price", "cost_price") if v[k] not in (None, "")}
    if v["reorder_level"] >= 0:
        payload["reorder_level"] = v["reorder_level"]
    if v["expiry_date"]:
        payload["expiry_date"] = v["expiry_date"].isoformat()
    categories = _categories_for(user, ",".join(v["categories"]), category_cache)
    if categories:
        payload["category"] = categories[0].name
    stock = v["stock"]

    if product:
        if payload.get("name", "").lower() == product.name.lower():
            payload.pop("name")  # don't rewrite a name that only differs in capitalisation
        apply_product_fields(product, payload, user)
        product.active = True
        for category in categories:
            if category not in product.categories:
                product.categories.append(category)
        if stock >= 0:
            delta = stock if stock_mode == "add" else stock - product.stock_quantity
            if delta:
                record_movement(user, product, "supplier_delivery" if stock_mode == "add" else "adjustment", delta,
                                "Spreadsheet import")
        return "updated", product
    product = Product(business_id=user.business_id, stock_quantity=0)
    apply_product_fields(product, payload, user, creating=True)
    db.session.add(product)
    db.session.flush()
    if categories:
        product.categories = categories
    else:
        apply_product_categories(product, payload, user, creating=True)
    if stock > 0:
        record_movement(user, product, "opening_stock", stock, "Spreadsheet import")
    return "created", product


@api_bp.post("/products/import")
@login_required
@permission_required("inventory")
def import_products(user):
    """Bulk create/update products from spreadsheet rows. With dry_run nothing is saved."""
    payload = body()
    rows = payload.get("rows")
    if not isinstance(rows, list) or not rows:
        raise ApiError("No rows to import")
    if len(rows) > MAX_IMPORT_ROWS:
        raise ApiError(f"You can import at most {MAX_IMPORT_ROWS} rows at a time")
    stock_mode = "add" if payload.get("stock_mode") == "add" else "set"
    dry_run = bool(payload.get("dry_run"))
    results, counts, category_cache = [], {"created": 0, "updated": 0, "failed": 0}, {}
    for index, row in enumerate(rows, start=1):
        try:
            if not isinstance(row, dict):
                raise ApiError("Invalid row")
            status, product = _import_row(user, row, stock_mode, category_cache)
            db.session.flush()
            counts[status] += 1
            results.append({"row": index, "status": status, "name": product.name, "sku": product.sku,
                            "stock_quantity": product.stock_quantity})
        except ApiError as exc:
            counts["failed"] += 1
            results.append({"row": index, "status": "failed",
                            "name": str(row.get("name") or "") if isinstance(row, dict) else "", "error": exc.message})
    if dry_run:
        db.session.rollback()
    else:
        audit(user, "product.imported", "product", "-",
              f"Spreadsheet import: {counts['created']} created, {counts['updated']} updated, {counts['failed']} failed")
        db.session.commit()
    return jsonify({"dry_run": dry_run, "stock_mode": stock_mode, **counts, "results": results})


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
