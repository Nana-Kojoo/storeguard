from conftest import make_employee, make_product


# ---------------------------------------------------------------- auth & security

def test_register_returns_session_and_csrf(api):
    data = api.register()
    assert data["user"]["role"] == "owner"
    assert data["csrf_token"]
    assert api.get("/auth/me").status_code == 200


def test_state_changing_requests_require_csrf(owner):
    owner.csrf = "wrong"
    r = owner.post("/products", {"name": "X", "sku": "X1", "price": 1})
    assert r.status_code == 403


def test_requests_must_be_json(owner):
    r = owner.client.post("/api/products", data="name=x", content_type="application/x-www-form-urlencoded",
                          headers={"X-CSRF-Token": owner.csrf})
    assert r.status_code == 415


def test_weak_password_rejected(api):
    r = api.post("/auth/register", {"business_name": "S", "full_name": "A B", "email": "a@b.co",
                                    "password": "aaaaaaaaaaaa"})
    assert r.status_code == 400


def test_login_lockout_after_failed_attempts(owner):
    owner.logout()
    for _ in range(5):
        assert owner.login("owner@example.com", "wrong password 1").status_code == 401
    assert owner.login("owner@example.com").status_code == 423


def test_password_change_invalidates_other_sessions(app, owner):
    with app.test_client() as other_client:
        from conftest import ApiClient
        other = ApiClient(other_client)
        assert other.login("owner@example.com").status_code == 200
        r = owner.post("/auth/change-password", {"current_password": "correct horse battery 9",
                                                 "new_password": "new secret phrase 42"})
        assert r.status_code == 200
        assert other.get("/auth/me").status_code == 401
    assert owner.get("/auth/me").status_code == 200


def test_security_headers_present(api):
    r = api.client.get("/auth.html")
    assert "Content-Security-Policy" in r.headers
    assert r.headers["X-Frame-Options"] == "DENY"


def test_static_serving_is_restricted_to_frontend(api):
    assert api.client.get("/storeguard/models.py").status_code == 404
    assert api.client.get("/../app.py").status_code == 404
    assert api.client.get("/index.html").status_code == 200


# ---------------------------------------------------------------- products & stock

def test_sale_updates_stock_and_records_audit(owner):
    product = make_product(owner)
    r = owner.post("/sales", {"items": [{"product_id": product["id"], "quantity": 2}], "payment_method": "cash"})
    assert r.status_code == 201, r.get_json()
    assert r.get_json()["sale"]["total"] == "170.00"
    assert owner.get("/products").get_json()["products"][0]["stock_quantity"] == 8
    assert owner.get("/sales").get_json()["total"] == 1
    actions = [a["action"] for a in owner.get("/audit").get_json()["items"]]
    assert "sale.completed" in actions


def test_sale_rejects_insufficient_stock_without_mutating(owner):
    product = make_product(owner, sku="MILK-1", price="8.50", stock=1)
    r = owner.post("/sales", {"items": [{"product_id": product["id"], "quantity": 2}], "payment_method": "cash"})
    assert r.status_code == 409
    assert owner.get("/products").get_json()["products"][0]["stock_quantity"] == 1


def test_duplicate_sku_and_stock_adjustment(owner):
    product = make_product(owner, sku="SUG-1", stock=10)
    assert owner.post("/products", {"name": "Dup", "sku": "SUG-1", "price": 1}).status_code == 409
    r = owner.post(f"/products/{product['id']}/adjust", {"quantity": 3, "reason": "damaged", "note": "Torn bags"})
    assert r.status_code == 200
    assert r.get_json()["product"]["stock_quantity"] == 7
    moves = owner.get("/stock-movements").get_json()["items"]
    assert moves[0]["movement_type"] == "damaged" and moves[0]["quantity"] == -3


def test_profile_and_product_images_can_be_saved(owner):
    image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAF/gJ/l21eXQAAAABJRU5ErkJggg=="
    r = owner.patch("/auth/me", {"image": image})
    assert r.status_code == 200
    assert r.get_json()["user"]["image"] == image

    r = owner.post("/products", {"name": "Imaged product", "sku": "IMG-1", "price": 5, "image": image})
    assert r.status_code == 201
    product = r.get_json()["product"]
    assert product["image"] == image
    r = owner.patch(f"/products/{product['id']}", {"image": ""})
    assert r.status_code == 200
    assert r.get_json()["product"]["image"] == ""


def test_profile_image_rejects_invalid_data(owner):
    r = owner.patch("/auth/me", {"image": "https://example.com/avatar.png"})
    assert r.status_code == 400


def test_employee_image_can_be_saved(owner):
    image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAF/gJ/l21eXQAAAABJRU5ErkJggg=="
    r = owner.post("/employees", {
        "full_name": "Photo Staff", "email": "photo@example.com", "role": "cashier",
        "password": "temporary pass 123", "image": image,
    })
    assert r.status_code == 201
    employee = r.get_json()["employee"]
    assert employee["image"] == image


def test_business_data_is_tenant_scoped(owner):
    make_product(owner, sku="OWN-1")
    owner.logout()
    owner.register("other@example.com", "Other Shop")
    assert owner.get("/products").get_json()["products"] == []


def test_purchase_order_receipt_adds_stock(owner):
    product = make_product(owner, sku="OIL-1", stock=0)
    supplier = owner.post("/suppliers", {"name": "Wholesale Ltd"}).get_json()["supplier"]
    order = owner.post("/purchase-orders", {"supplier_id": supplier["id"], "items": [
        {"product_id": product["id"], "quantity": 12, "unit_cost": "20.00"}]}).get_json()["order"]
    assert order["total"] == "240.00"
    r = owner.post(f"/purchase-orders/{order['id']}/receive")
    assert r.status_code == 200
    p = owner.get(f"/products/{product['id']}").get_json()["product"]
    assert p["stock_quantity"] == 12 and p["cost_price"] == "20.00"
    assert owner.post(f"/purchase-orders/{order['id']}/receive").status_code == 409


# ---------------------------------------------------------------- roles, shifts & cash

def test_cashier_permissions_and_shift_requirement(owner):
    product = make_product(owner)
    make_employee(owner, "cash@example.com")
    owner.logout()
    assert owner.login("cash@example.com", "temporary pass 123").status_code == 200
    assert owner.post("/products", {"name": "X", "sku": "X", "price": 1}).status_code == 403
    sale = {"items": [{"product_id": product["id"], "quantity": 1}], "payment_method": "cash"}
    assert owner.post("/sales", sale).status_code == 409  # no open shift
    assert owner.post("/shifts/open", {"opening_cash": "200"}).status_code == 201
    assert owner.post("/sales", {**sale, "amount_tendered": "100"}).get_json()["sale"]["change_due"] == "15.00"
    assert owner.post("/sales", {**sale, "discount": "5"}).status_code == 403  # no discount permission
    current = owner.get("/shifts/current").get_json()["shift"]
    assert current["totals"]["expected_cash"] == "285.00"


def test_shift_close_variance_creates_alert_and_approval(owner):
    make_product(owner)
    owner.post("/shifts/open", {"opening_cash": "100"})
    owner.post("/shifts/current/cash-movements", {"kind": "cash_out", "amount": "10", "reason": "Change run"})
    r = owner.post("/shifts/current/close", {"counted_cash": "50"})
    shift = r.get_json()["shift"]
    assert shift["variance"] == "-40.00" and shift["review_status"] == "pending"
    alerts = owner.get("/alerts?status=active").get_json()["items"]
    assert any(a["category"] == "cash" and a["severity"] == "critical" for a in alerts)
    assert owner.get("/approvals?status=pending").get_json()["total"] == 1


def test_offline_sale_is_idempotent(owner):
    product = make_product(owner)
    sale = {"items": [{"product_id": product["id"], "quantity": 1}], "payment_method": "momo",
            "client_ref": "device-1-0001", "offline": True}
    first = owner.post("/sales", sale)
    second = owner.post("/sales", sale)
    assert first.status_code == 201 and second.status_code == 200
    assert second.get_json()["duplicate"] is True
    assert owner.get("/products").get_json()["products"][0]["stock_quantity"] == 9


# ---------------------------------------------------------------- refunds & approvals

def test_cashier_refund_requires_manager_approval(owner):
    product = make_product(owner, stock=5)
    make_employee(owner, "cash@example.com")
    owner.logout()
    owner.login("cash@example.com", "temporary pass 123")
    owner.post("/shifts/open", {"opening_cash": "0"})
    sale = owner.post("/sales", {"items": [{"product_id": product["id"], "quantity": 2}],
                                 "payment_method": "cash"}).get_json()["sale"]
    r = owner.post(f"/sales/{sale['id']}/refund", {"reason": "Damaged product"})
    assert r.status_code == 202
    owner.logout()
    owner.login("owner@example.com")
    approval = owner.get("/approvals?status=pending").get_json()["items"][0]
    r = owner.post(f"/approvals/{approval['id']}/decide", {"decision": "approve"})
    assert r.status_code == 200, r.get_json()
    detail = owner.get(f"/sales/{sale['id']}").get_json()["sale"]
    assert detail["status"] == "refunded" and detail["refunded_amount"] == "170.00"
    assert owner.get("/products").get_json()["products"][0]["stock_quantity"] == 5


def test_partial_refund_by_owner(owner):
    product = make_product(owner, price="10.00", stock=10)
    sale = owner.post("/sales", {"items": [{"product_id": product["id"], "quantity": 4}],
                                 "payment_method": "card"}).get_json()["sale"]
    item_id = sale["items"][0]["id"]
    r = owner.post(f"/sales/{sale['id']}/refund", {"reason": "Wrong item", "items": [{"sale_item_id": item_id, "quantity": 1}]})
    assert r.status_code == 200
    assert r.get_json()["sale"]["status"] == "partially_refunded"
    assert r.get_json()["sale"]["refunded_amount"] == "10.00"


def test_credit_sale_respects_limit_and_repayment(owner):
    product = make_product(owner, price="50.00")
    customer = owner.post("/customers", {"name": "Esi", "credit_limit": "80"}).get_json()["customer"]
    base = {"items": [{"product_id": product["id"], "quantity": 1}], "payment_method": "credit"}
    assert owner.post("/sales", base).status_code == 400  # no customer selected
    assert owner.post("/sales", {**base, "customer_id": customer["id"]}).status_code == 201
    assert owner.post("/sales", {**base, "customer_id": customer["id"]}).status_code == 409  # over limit
    r = owner.post(f"/customers/{customer['id']}/payments", {"amount": "20", "method": "momo"})
    assert r.get_json()["customer"]["balance"] == "30.00"


# ---------------------------------------------------------------- reporting

def test_reports_and_dashboard(owner):
    product = make_product(owner, price="10.00", cost="6.00")
    owner.post("/sales", {"items": [{"product_id": product["id"], "quantity": 3}], "payment_method": "cash"})
    owner.post("/expenses", {"category": "Utilities", "description": "ECG prepaid", "amount": "5",
                             "expense_date": owner.get("/reports/summary").get_json()["range"]["end"]})
    summary = owner.get("/reports/summary").get_json()["totals"]
    assert summary["revenue"] == "30.00" and summary["gross_profit"] == "12.00" and summary["net_profit"] == "7.00"
    dash = owner.get("/dashboard").get_json()
    assert dash["today"]["transactions"] == 1
    assert owner.get("/search?q=Product").get_json()["results"]


def test_role_assignment_rules(owner):
    make_employee(owner, "mgr@example.com", role="manager")
    assert owner.post("/employees", {"full_name": "X", "email": "x@example.com", "role": "owner",
                                     "password": "temporary pass 123"}).status_code == 201  # owner may
    owner.logout()
    owner.login("mgr@example.com", "temporary pass 123")
    r = owner.post("/employees", {"full_name": "Y", "email": "y@example.com", "role": "manager",
                                  "password": "temporary pass 123"})
    assert r.status_code == 403
