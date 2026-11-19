"""Operational CLI commands: `flask --app app <command>`."""
import secrets
from datetime import timedelta
from decimal import Decimal

import click

from .extensions import db


def register_cli(app):
    @app.cli.command("init-db")
    def init_db():
        """Create all database tables."""
        from . import _add_missing_columns
        db.create_all()
        _add_missing_columns()
        click.echo("Database tables are ready.")

    @app.cli.command("create-owner")
    @click.option("--business", prompt="Business name")
    @click.option("--name", prompt="Owner full name")
    @click.option("--email", prompt="Owner email")
    @click.password_option()
    def create_owner(business, name, email, password):
        """Create a business with its owner account (use when public registration is disabled)."""
        from .auth import validate_email, validate_password
        from .models import Branch, Business, User
        from .utils import ApiError
        try:
            email = validate_email(email)
            validate_password(password)
        except ApiError as exc:
            raise click.ClickException(exc.message) from None
        if User.query.filter_by(email=email).first():
            raise click.ClickException("That email is already registered")
        biz = Business(name=business.strip(), email=email)
        db.session.add(biz)
        db.session.flush()
        branch = Branch(business_id=biz.id, name="Main branch")
        db.session.add(branch)
        db.session.flush()
        owner = User(business_id=biz.id, branch_id=branch.id, full_name=name.strip(), email=email, role="owner",
                     employee_code="EMP-001")
        owner.set_password(password)
        db.session.add(owner)
        db.session.commit()
        click.echo(f"Created {biz.name} with owner {email}.")

    @app.cli.command("seed-demo")
    @click.option("--email", default="owner@demo.storeguard.local", show_default=True)
    def seed_demo(email):
        """Create a demo business with sample staff, products and sales history (for evaluation only)."""
        import random

        from .models import (Branch, Business, Customer, Product, Sale, SaleItem, Shift, StockMovement, Supplier,
                             User, utcnow)
        if User.query.filter_by(email=email).first():
            raise click.ClickException("Demo data already exists for that email")
        password = secrets.token_urlsafe(9) + "7a"
        biz = Business(name="Demo Supermarket", address="Accra Central", phone="+233 24 000 0000", email=email)
        db.session.add(biz)
        db.session.flush()
        branch = Branch(business_id=biz.id, name="Accra Central")
        db.session.add(branch)
        db.session.flush()
        staff = []
        for i, (full_name, role, pattern) in enumerate([
            ("Demo Owner", "owner", "morning"), ("Kwame Mensah", "cashier", "morning"),
            ("Efua Boateng", "cashier", "afternoon"), ("Yaw Darko", "supervisor", "morning"),
            ("Akosua Adjei", "inventory_officer", "morning"),
        ], start=1):
            user = User(business_id=biz.id, branch_id=branch.id, full_name=full_name, role=role, shift_pattern=pattern,
                        email=email if i == 1 else f"{full_name.split()[0].lower()}@demo.storeguard.local",
                        employee_code=f"EMP-{i:03d}")
            user.set_password(password)
            db.session.add(user)
            staff.append(user)
        supplier = Supplier(business_id=biz.id, name="Accra Wholesale Ltd", contact_name="Kofi Owusu",
                            phone="+233 20 111 2222")
        db.session.add(supplier)
        db.session.flush()
        catalog = [
            ("Rice 5kg (Royal)", "RIC-5K-001", "food", "85.00", "68.00", 40, 10),
            ("Cooking Oil 1L", "OIL-1L-012", "food", "32.00", "25.00", 30, 8),
            ("Sugar 1kg", "SUG-1K-008", "food", "12.50", "9.50", 50, 10),
            ("Milk 400g", "MIL-4G-022", "dairy", "8.50", "6.20", 60, 12),
            ("Coca-Cola 1.5L", "BEV-COK-015", "beverages", "10.00", "7.00", 80, 15),
            ("Voltic Water 1.5L", "BEV-VOL-015", "beverages", "5.00", "3.20", 120, 20),
            ("Bread (Large)", "BAK-BRD-001", "food", "7.00", "5.00", 25, 5),
            ("Eggs (Crate 30)", "EGG-CRT-030", "dairy", "42.00", "35.00", 12, 4),
            ("Omo 500g", "HOU-OMO-500", "household", "18.00", "13.50", 30, 8),
            ("Key Soap 800g", "HOU-KEY-800", "household", "14.00", "10.00", 35, 10),
            ("Colgate 100g", "PER-COL-100", "personal", "9.00", "6.50", 6, 6),
            ("Digestive Biscuits", "SNK-DIG-001", "snacks", "6.50", "4.50", 45, 12),
            ("Milo 400g", "BEV-MIL-400", "beverages", "42.00", "34.00", 4, 5),
            ("Yoghurt 500ml", "DAI-YOG-500", "dairy", "16.00", "11.00", 18, 8),
        ]
        products = []
        for name, sku, cat, price, cost, stock, reorder in catalog:
            p = Product(business_id=biz.id, supplier_id=supplier.id, name=name, sku=sku, category=cat,
                        price=Decimal(price), cost_price=Decimal(cost), stock_quantity=stock, reorder_level=reorder)
            db.session.add(p)
            products.append(p)
        db.session.add(Customer(business_id=biz.id, name="Auntie Esi Provisions", phone="+233 24 555 0101",
                                credit_limit=Decimal("500.00")))
        db.session.flush()
        for p in products:
            db.session.add(StockMovement(business_id=biz.id, product_id=p.id, user_id=staff[0].id,
                                         movement_type="opening_stock", quantity=p.stock_quantity, previous_quantity=0,
                                         new_quantity=p.stock_quantity, reason="Demo opening stock"))
        rng = random.Random(42)
        now = utcnow()
        for day in range(6, 0, -1):
            opened = (now - timedelta(days=day)).replace(hour=6, minute=rng.randint(0, 15))
            shift = Shift(business_id=biz.id, user_id=staff[1].id, opened_at=opened, opening_cash=Decimal("200.00"),
                          status="closed", closed_at=opened + timedelta(hours=8))
            db.session.add(shift)
            db.session.flush()
            cash_total = Decimal(0)
            for n in range(rng.randint(8, 16)):
                picks = rng.sample(products, rng.randint(1, 3))
                method = rng.choice(["cash", "cash", "cash", "momo", "momo", "momo", "card"])
                sale = Sale(business_id=biz.id, cashier_id=staff[1].id, shift_id=shift.id,
                            reference=f"SG-DEMO{day}{n:02d}{rng.randint(100, 999)}", payment_method=method,
                            payment_reference=rng.choice(["MTN", "MTN", "Telecel", "AirtelTigo"]) if method == "momo" else "",
                            subtotal=0, total=0, created_at=opened + timedelta(minutes=20 + n * 25))
                subtotal = Decimal(0)
                for p in picks:
                    qty = rng.randint(1, 3)
                    sale.items.append(SaleItem(product_id=p.id, product_name=p.name, quantity=qty,
                                               unit_price=p.price, unit_cost=p.cost_price))
                    subtotal += p.price * qty
                sale.subtotal = sale.total = subtotal
                if method == "cash":
                    cash_total += subtotal
                db.session.add(sale)
            shift.expected_cash = Decimal("200.00") + cash_total
            shift.counted_cash = shift.expected_cash
            shift.variance = Decimal(0)
        db.session.commit()
        click.echo("Demo business created. Sign in with any of these accounts:")
        for u in staff:
            click.echo(f"  {u.email:<40} {u.role}")
        click.echo(f"Shared demo password: {password}")
        click.echo("Delete the demo business before going live.")
