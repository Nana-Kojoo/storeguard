import json
from datetime import datetime, timezone
from decimal import Decimal

from werkzeug.security import check_password_hash, generate_password_hash

from .extensions import db


def utcnow():
    return datetime.now(timezone.utc)


def iso(value):
    """Serialize datetimes as ISO-8601 UTC (SQLite returns naive values)."""
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return value.isoformat()


def money_str(value):
    return str(Decimal(value or 0).quantize(Decimal("0.01")))


class TimestampMixin:
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)


# ---------------------------------------------------------------- tenancy

# Receipt customisation, stored as JSON in Business.receipt_settings. Missing keys fall back to these.
RECEIPT_DEFAULTS = {
    "auto_print": True,        # print automatically as soon as a sale is paid
    "copies": 1,               # 1-3 copies per sale (e.g. customer + store copy)
    "paper": "80mm",           # 58mm | 80mm | a4
    "logo": "",                # small data:image/... URL, or "" for none
    "header": "",              # message under the shop name, e.g. "Quality you can trust"
    "tax_id": "",              # TIN / VAT number printed on the receipt
    "contact_line": "",        # website, WhatsApp, social handle…
    "policy": "",              # returns / exchange policy
    "show_address": True,
    "show_phone": True,
    "show_cashier": True,
    "show_customer": True,
    "show_branch": True,
    "show_sku": False,
    "show_item_count": True,
}


class Business(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(160), nullable=False)
    currency = db.Column(db.String(3), nullable=False, default="GHS")
    timezone = db.Column(db.String(64), nullable=False, default="Africa/Accra")
    address = db.Column(db.String(255), nullable=False, default="")
    phone = db.Column(db.String(40), nullable=False, default="")
    email = db.Column(db.String(255), nullable=False, default="")
    tax_rate = db.Column(db.Numeric(5, 2), nullable=False, default=0)
    receipt_footer = db.Column(db.String(255), nullable=False, default="Thank you for shopping with us!")
    max_discount_pct = db.Column(db.Numeric(5, 2), nullable=False, default=10)
    refund_approval_threshold = db.Column(db.Numeric(12, 2), nullable=False, default=100)
    cash_variance_threshold = db.Column(db.Numeric(12, 2), nullable=False, default=20)
    require_shift_for_sales = db.Column(db.Boolean, nullable=False, default=True)
    low_stock_alerts = db.Column(db.Boolean, nullable=False, default=True)
    receipt_settings = db.Column(db.Text, nullable=False, default="{}")

    @property
    def receipt(self):
        try:
            stored = json.loads(self.receipt_settings or "{}")
        except (TypeError, ValueError):
            stored = {}
        if not isinstance(stored, dict):
            stored = {}
        return {key: stored.get(key, default) for key, default in RECEIPT_DEFAULTS.items()}

    @receipt.setter
    def receipt(self, value):
        self.receipt_settings = json.dumps({key: value[key] for key in RECEIPT_DEFAULTS if key in value})

    def as_dict(self):
        return {
            "id": self.id, "name": self.name, "currency": self.currency, "timezone": self.timezone,
            "address": self.address, "phone": self.phone, "email": self.email,
            "tax_rate": money_str(self.tax_rate), "receipt_footer": self.receipt_footer,
            "max_discount_pct": money_str(self.max_discount_pct),
            "refund_approval_threshold": money_str(self.refund_approval_threshold),
            "cash_variance_threshold": money_str(self.cash_variance_threshold),
            "require_shift_for_sales": self.require_shift_for_sales,
            "low_stock_alerts": self.low_stock_alerts,
            "receipt": self.receipt,
        }


class Branch(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    business_id = db.Column(db.Integer, db.ForeignKey("business.id"), nullable=False, index=True)
    name = db.Column(db.String(160), nullable=False)
    address = db.Column(db.String(255), nullable=False, default="")

    def as_dict(self):
        return {"id": self.id, "name": self.name, "address": self.address}


class User(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    business_id = db.Column(db.Integer, db.ForeignKey("business.id"), nullable=False, index=True)
    branch_id = db.Column(db.Integer, db.ForeignKey("branch.id"), nullable=True)
    full_name = db.Column(db.String(160), nullable=False)
    email = db.Column(db.String(255), nullable=False, unique=True, index=True)
    phone = db.Column(db.String(40), nullable=False, default="")
    image = db.Column(db.Text, nullable=False, default="")
    employee_code = db.Column(db.String(40), nullable=False, default="")
    role = db.Column(db.String(40), nullable=False, default="cashier")
    shift_pattern = db.Column(db.String(20), nullable=False, default="morning")
    permissions = db.Column(db.JSON, nullable=True)  # None => role defaults
    password_hash = db.Column(db.String(255), nullable=False)
    active = db.Column(db.Boolean, nullable=False, default=True)
    session_version = db.Column(db.Integer, nullable=False, default=1)
    failed_logins = db.Column(db.Integer, nullable=False, default=0)
    locked_until = db.Column(db.DateTime(timezone=True), nullable=True)
    last_login_at = db.Column(db.DateTime(timezone=True), nullable=True)

    business = db.relationship("Business")
    branch = db.relationship("Branch")

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)
        self.session_version = (self.session_version or 0) + 1

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

    @property
    def initials(self):
        parts = [p for p in self.full_name.split() if p]
        return ("".join(p[0] for p in parts[:2]) or "?").upper()

    def as_dict(self, include_private=False):
        from .security import effective_permissions
        data = {
            "id": self.id, "name": self.full_name, "initials": self.initials, "email": self.email,
            "phone": self.phone, "employee_code": self.employee_code, "role": self.role,
            "shift_pattern": self.shift_pattern, "active": self.active, "image": self.image or "",
            "permissions": sorted(effective_permissions(self)),
            "custom_permissions": self.permissions is not None,
            "last_login_at": iso(self.last_login_at), "created_at": iso(self.created_at),
        }
        if include_private:
            data["business_id"] = self.business_id
        return data


# ---------------------------------------------------------------- catalog

product_categories = db.Table(
    "product_categories",
    db.Column("product_id", db.Integer, db.ForeignKey("product.id", ondelete="CASCADE"), primary_key=True),
    db.Column("category_id", db.Integer, db.ForeignKey("category.id", ondelete="CASCADE"), primary_key=True),
)


class Category(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    business_id = db.Column(db.Integer, db.ForeignKey("business.id"), nullable=False, index=True)
    name = db.Column(db.String(80), nullable=False)
    __table_args__ = (db.UniqueConstraint("business_id", "name", name="uq_business_category_name"),)

    def as_dict(self, product_count=0):
        return {"id": self.id, "name": self.name, "product_count": product_count}


class Supplier(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    business_id = db.Column(db.Integer, db.ForeignKey("business.id"), nullable=False, index=True)
    name = db.Column(db.String(160), nullable=False)
    contact_name = db.Column(db.String(160), nullable=False, default="")
    phone = db.Column(db.String(40), nullable=False, default="")
    email = db.Column(db.String(255), nullable=False, default="")
    address = db.Column(db.String(255), nullable=False, default="")
    notes = db.Column(db.String(500), nullable=False, default="")
    active = db.Column(db.Boolean, nullable=False, default=True)

    def as_dict(self):
        return {"id": self.id, "name": self.name, "contact_name": self.contact_name, "phone": self.phone,
                "email": self.email, "address": self.address, "notes": self.notes, "active": self.active,
                "created_at": iso(self.created_at)}


class Product(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    business_id = db.Column(db.Integer, db.ForeignKey("business.id"), nullable=False, index=True)
    supplier_id = db.Column(db.Integer, db.ForeignKey("supplier.id"), nullable=True)
    name = db.Column(db.String(160), nullable=False)
    sku = db.Column(db.String(80), nullable=False)
    barcode = db.Column(db.String(80), nullable=False, default="")
    category = db.Column(db.String(80), nullable=False, default="general")
    unit = db.Column(db.String(20), nullable=False, default="unit")
    price = db.Column(db.Numeric(12, 2), nullable=False)
    cost_price = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    stock_quantity = db.Column(db.Integer, nullable=False, default=0)
    reorder_level = db.Column(db.Integer, nullable=False, default=5)
    expiry_date = db.Column(db.Date, nullable=True)
    image = db.Column(db.Text, nullable=False, default="")
    active = db.Column(db.Boolean, nullable=False, default=True)
    __table_args__ = (db.UniqueConstraint("business_id", "sku", name="uq_business_product_sku"),)

    supplier = db.relationship("Supplier")
    categories = db.relationship("Category", secondary=product_categories, backref="products")

    def as_dict(self, include_cost=True):
        data = {
            "id": self.id, "name": self.name, "sku": self.sku, "barcode": self.barcode,
            "category": self.category, "unit": self.unit, "price": money_str(self.price),
            "category_ids": [category.id for category in self.categories],
            "categories": [category.name for category in self.categories],
            "stock_quantity": self.stock_quantity, "reorder_level": self.reorder_level,
            "expiry_date": self.expiry_date.isoformat() if self.expiry_date else None,
            "supplier_id": self.supplier_id, "supplier_name": self.supplier.name if self.supplier else None,
            "active": self.active, "image": self.image or "",
        }
        if include_cost:
            data["cost_price"] = money_str(self.cost_price)
        return data


class StockMovement(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    business_id = db.Column(db.Integer, db.ForeignKey("business.id"), nullable=False, index=True)
    product_id = db.Column(db.Integer, db.ForeignKey("product.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    movement_type = db.Column(db.String(40), nullable=False)
    quantity = db.Column(db.Integer, nullable=False)
    previous_quantity = db.Column(db.Integer, nullable=False)
    new_quantity = db.Column(db.Integer, nullable=False)
    reason = db.Column(db.String(255), nullable=False)
    reference = db.Column(db.String(80), nullable=False, default="")

    product = db.relationship("Product")
    user = db.relationship("User")

    def as_dict(self):
        return {"id": self.id, "product_id": self.product_id, "product_name": self.product.name,
                "sku": self.product.sku, "user_name": self.user.full_name, "movement_type": self.movement_type,
                "quantity": self.quantity, "previous_quantity": self.previous_quantity,
                "new_quantity": self.new_quantity, "reason": self.reason, "reference": self.reference,
                "created_at": iso(self.created_at)}


class PurchaseOrder(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    business_id = db.Column(db.Integer, db.ForeignKey("business.id"), nullable=False, index=True)
    supplier_id = db.Column(db.Integer, db.ForeignKey("supplier.id"), nullable=False)
    reference = db.Column(db.String(40), nullable=False)
    status = db.Column(db.String(20), nullable=False, default="ordered")  # ordered | received | cancelled
    expected_date = db.Column(db.Date, nullable=True)
    notes = db.Column(db.String(500), nullable=False, default="")
    total = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    created_by = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    received_by = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=True)
    received_at = db.Column(db.DateTime(timezone=True), nullable=True)

    supplier = db.relationship("Supplier")
    items = db.relationship("PurchaseItem", backref="order", cascade="all, delete-orphan")
    creator = db.relationship("User", foreign_keys=[created_by])

    def as_dict(self):
        return {"id": self.id, "reference": self.reference, "supplier_id": self.supplier_id,
                "supplier_name": self.supplier.name, "status": self.status,
                "expected_date": self.expected_date.isoformat() if self.expected_date else None,
                "notes": self.notes, "total": money_str(self.total), "created_by": self.creator.full_name,
                "received_at": iso(self.received_at), "created_at": iso(self.created_at),
                "items": [i.as_dict() for i in self.items]}


class PurchaseItem(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    order_id = db.Column(db.Integer, db.ForeignKey("purchase_order.id"), nullable=False, index=True)
    product_id = db.Column(db.Integer, db.ForeignKey("product.id"), nullable=False)
    quantity = db.Column(db.Integer, nullable=False)
    unit_cost = db.Column(db.Numeric(12, 2), nullable=False)

    product = db.relationship("Product")

    def as_dict(self):
        return {"id": self.id, "product_id": self.product_id, "product_name": self.product.name,
                "quantity": self.quantity, "unit_cost": money_str(self.unit_cost),
                "line_total": money_str(self.unit_cost * self.quantity)}


# ---------------------------------------------------------------- customers

class Customer(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    business_id = db.Column(db.Integer, db.ForeignKey("business.id"), nullable=False, index=True)
    name = db.Column(db.String(160), nullable=False)
    phone = db.Column(db.String(40), nullable=False, default="")
    email = db.Column(db.String(255), nullable=False, default="")
    credit_limit = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    balance = db.Column(db.Numeric(12, 2), nullable=False, default=0)  # amount owed to the shop
    notes = db.Column(db.String(500), nullable=False, default="")
    active = db.Column(db.Boolean, nullable=False, default=True)

    def as_dict(self):
        return {"id": self.id, "name": self.name, "phone": self.phone, "email": self.email,
                "credit_limit": money_str(self.credit_limit), "balance": money_str(self.balance),
                "available_credit": money_str(max(Decimal(self.credit_limit) - Decimal(self.balance), Decimal(0))),
                "notes": self.notes, "active": self.active, "created_at": iso(self.created_at)}


class CustomerPayment(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    business_id = db.Column(db.Integer, db.ForeignKey("business.id"), nullable=False, index=True)
    customer_id = db.Column(db.Integer, db.ForeignKey("customer.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    shift_id = db.Column(db.Integer, db.ForeignKey("shift.id"), nullable=True)
    amount = db.Column(db.Numeric(12, 2), nullable=False)
    method = db.Column(db.String(20), nullable=False, default="cash")
    note = db.Column(db.String(255), nullable=False, default="")

    user = db.relationship("User")

    def as_dict(self):
        return {"id": self.id, "amount": money_str(self.amount), "method": self.method, "note": self.note,
                "user_name": self.user.full_name, "created_at": iso(self.created_at)}


# ---------------------------------------------------------------- sales

class Sale(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    business_id = db.Column(db.Integer, db.ForeignKey("business.id"), nullable=False, index=True)
    cashier_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)
    shift_id = db.Column(db.Integer, db.ForeignKey("shift.id"), nullable=True, index=True)
    customer_id = db.Column(db.Integer, db.ForeignKey("customer.id"), nullable=True)
    device_id = db.Column(db.Integer, db.ForeignKey("device.id"), nullable=True)
    reference = db.Column(db.String(40), nullable=False, unique=True)
    client_ref = db.Column(db.String(64), nullable=True)
    payment_method = db.Column(db.String(40), nullable=False)
    status = db.Column(db.String(30), nullable=False, default="completed")
    subtotal = db.Column(db.Numeric(12, 2), nullable=False)
    discount = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    tax = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    total = db.Column(db.Numeric(12, 2), nullable=False)
    amount_tendered = db.Column(db.Numeric(12, 2), nullable=True)
    change_due = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    refunded_amount = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    payment_reference = db.Column(db.String(80), nullable=False, default="")
    note = db.Column(db.String(255), nullable=False, default="")
    offline = db.Column(db.Boolean, nullable=False, default=False)
    __table_args__ = (db.UniqueConstraint("business_id", "client_ref", name="uq_business_sale_client_ref"),)

    items = db.relationship("SaleItem", backref="sale", cascade="all, delete-orphan")
    cashier = db.relationship("User")
    customer = db.relationship("Customer")

    def as_dict(self, detail=False):
        data = {
            "id": self.id, "reference": self.reference, "payment_method": self.payment_method,
            "status": self.status, "subtotal": money_str(self.subtotal), "discount": money_str(self.discount),
            "tax": money_str(self.tax), "total": money_str(self.total),
            "refunded_amount": money_str(self.refunded_amount),
            "cashier_id": self.cashier_id, "cashier_name": self.cashier.full_name,
            "customer_id": self.customer_id, "customer_name": self.customer.name if self.customer else None,
            "item_count": sum(i.quantity for i in self.items), "offline": self.offline,
            "created_at": iso(self.created_at),
        }
        if detail:
            data.update({
                "items": [i.as_dict() for i in self.items],
                "amount_tendered": money_str(self.amount_tendered) if self.amount_tendered is not None else None,
                "change_due": money_str(self.change_due), "payment_reference": self.payment_reference,
                "note": self.note,
                "refunds": [r.as_dict() for r in Refund.query.filter_by(sale_id=self.id).order_by(Refund.created_at)],
            })
        return data


class SaleItem(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    sale_id = db.Column(db.Integer, db.ForeignKey("sale.id"), nullable=False, index=True)
    product_id = db.Column(db.Integer, db.ForeignKey("product.id"), nullable=False, index=True)
    product_name = db.Column(db.String(160), nullable=False, default="")
    quantity = db.Column(db.Integer, nullable=False)
    unit_price = db.Column(db.Numeric(12, 2), nullable=False)
    unit_cost = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    refunded_quantity = db.Column(db.Integer, nullable=False, default=0)

    product = db.relationship("Product")

    def as_dict(self):
        return {"id": self.id, "product_id": self.product_id, "product_name": self.product_name,
                "sku": self.product.sku if self.product else "", "quantity": self.quantity, "unit_price": money_str(self.unit_price),
                "line_total": money_str(self.unit_price * self.quantity),
                "refunded_quantity": self.refunded_quantity}


class Refund(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    business_id = db.Column(db.Integer, db.ForeignKey("business.id"), nullable=False, index=True)
    sale_id = db.Column(db.Integer, db.ForeignKey("sale.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)
    approved_by = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=True)
    shift_id = db.Column(db.Integer, db.ForeignKey("shift.id"), nullable=True, index=True)
    amount = db.Column(db.Numeric(12, 2), nullable=False)
    method = db.Column(db.String(40), nullable=False)
    reason = db.Column(db.String(255), nullable=False)
    items = db.Column(db.JSON, nullable=False, default=list)  # [{sale_item_id, quantity}]

    user = db.relationship("User", foreign_keys=[user_id])
    sale = db.relationship("Sale")

    def as_dict(self):
        return {"id": self.id, "sale_id": self.sale_id, "sale_reference": self.sale.reference,
                "amount": money_str(self.amount), "method": self.method, "reason": self.reason,
                "user_name": self.user.full_name, "items": self.items, "created_at": iso(self.created_at)}


# ---------------------------------------------------------------- shifts & cash

class Shift(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    business_id = db.Column(db.Integer, db.ForeignKey("business.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)
    device_label = db.Column(db.String(80), nullable=False, default="")
    opened_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    closed_at = db.Column(db.DateTime(timezone=True), nullable=True)
    status = db.Column(db.String(20), nullable=False, default="open")  # open | closed
    opening_cash = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    expected_cash = db.Column(db.Numeric(12, 2), nullable=True)
    counted_cash = db.Column(db.Numeric(12, 2), nullable=True)
    variance = db.Column(db.Numeric(12, 2), nullable=True)
    denominations = db.Column(db.JSON, nullable=True)
    notes = db.Column(db.String(500), nullable=False, default="")
    review_status = db.Column(db.String(20), nullable=False, default="none")  # none | pending | approved | rejected
    reviewed_by = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=True)

    user = db.relationship("User", foreign_keys=[user_id])
    breaks = db.relationship("ShiftBreak", backref="shift", cascade="all, delete-orphan", order_by="ShiftBreak.started_at")


class ShiftBreak(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    shift_id = db.Column(db.Integer, db.ForeignKey("shift.id"), nullable=False, index=True)
    started_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)
    ended_at = db.Column(db.DateTime(timezone=True), nullable=True)
    reason = db.Column(db.String(120), nullable=False, default="Break")


class CashMovement(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    business_id = db.Column(db.Integer, db.ForeignKey("business.id"), nullable=False, index=True)
    shift_id = db.Column(db.Integer, db.ForeignKey("shift.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    kind = db.Column(db.String(20), nullable=False)  # cash_in | cash_out
    amount = db.Column(db.Numeric(12, 2), nullable=False)
    reason = db.Column(db.String(255), nullable=False)

    user = db.relationship("User")

    def as_dict(self):
        return {"id": self.id, "shift_id": self.shift_id, "kind": self.kind, "amount": money_str(self.amount),
                "reason": self.reason, "user_name": self.user.full_name, "created_at": iso(self.created_at)}


class Expense(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    business_id = db.Column(db.Integer, db.ForeignKey("business.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    category = db.Column(db.String(60), nullable=False)
    description = db.Column(db.String(255), nullable=False)
    amount = db.Column(db.Numeric(12, 2), nullable=False)
    payment_method = db.Column(db.String(20), nullable=False, default="cash")
    expense_date = db.Column(db.Date, nullable=False)
    reference = db.Column(db.String(80), nullable=False, default="")
    status = db.Column(db.String(20), nullable=False, default="approved")  # approved | pending | rejected

    user = db.relationship("User")

    def as_dict(self):
        return {"id": self.id, "category": self.category, "description": self.description,
                "amount": money_str(self.amount), "payment_method": self.payment_method,
                "expense_date": self.expense_date.isoformat(), "reference": self.reference,
                "status": self.status, "user_name": self.user.full_name, "created_at": iso(self.created_at)}


# ---------------------------------------------------------------- oversight

class Alert(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    business_id = db.Column(db.Integer, db.ForeignKey("business.id"), nullable=False, index=True)
    severity = db.Column(db.String(20), nullable=False)  # critical | warning | info
    category = db.Column(db.String(40), nullable=False)
    title = db.Column(db.String(160), nullable=False)
    detail = db.Column(db.String(500), nullable=False, default="")
    subject_user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=True)
    entity_type = db.Column(db.String(40), nullable=False, default="")
    entity_id = db.Column(db.String(40), nullable=False, default="")
    status = db.Column(db.String(20), nullable=False, default="open")  # open | investigating | resolved | dismissed
    resolved_by = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=True)
    resolved_at = db.Column(db.DateTime(timezone=True), nullable=True)
    resolution_note = db.Column(db.String(500), nullable=False, default="")

    subject = db.relationship("User", foreign_keys=[subject_user_id])

    def as_dict(self):
        return {"id": self.id, "severity": self.severity, "category": self.category, "title": self.title,
                "detail": self.detail, "subject_name": self.subject.full_name if self.subject else None,
                "entity_type": self.entity_type, "entity_id": self.entity_id, "status": self.status,
                "resolution_note": self.resolution_note, "resolved_at": iso(self.resolved_at),
                "created_at": iso(self.created_at)}


class Approval(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    business_id = db.Column(db.Integer, db.ForeignKey("business.id"), nullable=False, index=True)
    kind = db.Column(db.String(30), nullable=False)  # refund | expense | cash_variance
    entity_type = db.Column(db.String(40), nullable=False)
    entity_id = db.Column(db.String(40), nullable=False)
    summary = db.Column(db.String(255), nullable=False)
    amount = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    payload = db.Column(db.JSON, nullable=False, default=dict)
    requested_by = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    status = db.Column(db.String(20), nullable=False, default="pending")  # pending | approved | rejected
    decided_by = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=True)
    decided_at = db.Column(db.DateTime(timezone=True), nullable=True)
    decision_note = db.Column(db.String(500), nullable=False, default="")

    requester = db.relationship("User", foreign_keys=[requested_by])
    decider = db.relationship("User", foreign_keys=[decided_by])

    def as_dict(self):
        return {"id": self.id, "kind": self.kind, "entity_type": self.entity_type, "entity_id": self.entity_id,
                "summary": self.summary, "amount": money_str(self.amount), "payload": self.payload,
                "requested_by": self.requester.full_name, "requested_by_id": self.requested_by,
                "status": self.status, "decided_by": self.decider.full_name if self.decider else None,
                "decided_at": iso(self.decided_at), "decision_note": self.decision_note,
                "created_at": iso(self.created_at)}


class Device(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    business_id = db.Column(db.Integer, db.ForeignKey("business.id"), nullable=False, index=True)
    token = db.Column(db.String(64), nullable=False, unique=True)
    name = db.Column(db.String(80), nullable=False)
    kind = db.Column(db.String(30), nullable=False, default="pos_terminal")
    status = db.Column(db.String(20), nullable=False, default="active")  # active | blocked
    last_seen_at = db.Column(db.DateTime(timezone=True), nullable=True)
    last_ip = db.Column(db.String(64), nullable=False, default="")
    user_agent = db.Column(db.String(255), nullable=False, default="")
    last_user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=True)

    last_user = db.relationship("User")

    def as_dict(self):
        return {"id": self.id, "name": self.name, "kind": self.kind, "status": self.status,
                "last_seen_at": iso(self.last_seen_at), "last_ip": self.last_ip, "user_agent": self.user_agent,
                "last_user": self.last_user.full_name if self.last_user else None,
                "created_at": iso(self.created_at)}


class AuditLog(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    business_id = db.Column(db.Integer, db.ForeignKey("business.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=True)
    action = db.Column(db.String(80), nullable=False, index=True)
    entity_type = db.Column(db.String(80), nullable=False)
    entity_id = db.Column(db.String(80), nullable=False)
    reason = db.Column(db.String(255), nullable=False)
    ip_address = db.Column(db.String(64), nullable=False, default="")

    user = db.relationship("User")

    def as_dict(self):
        return {"id": self.id, "action": self.action, "entity_type": self.entity_type, "entity_id": self.entity_id,
                "reason": self.reason, "user_name": self.user.full_name if self.user else "System",
                "ip_address": self.ip_address, "created_at": iso(self.created_at)}
