import pytest

from storeguard import create_app
from storeguard.extensions import db
from storeguard.security import limiter


class ApiClient:
    """Wraps the Flask test client: JSON in/out and automatic CSRF header."""

    def __init__(self, client):
        self.client = client
        self.csrf = None

    def _call(self, method, path, json=None, headers=None):
        headers = dict(headers or {})
        if self.csrf and method != "get":
            headers["X-CSRF-Token"] = self.csrf
        response = getattr(self.client, method)(f"/api{path}", json=json, headers=headers)
        data = response.get_json(silent=True) or {}
        if isinstance(data, dict) and data.get("csrf_token"):
            self.csrf = data["csrf_token"]
        return response

    def get(self, path, **kw):
        return self._call("get", path, **kw)

    def post(self, path, json=None, **kw):
        return self._call("post", path, json=json if json is not None else {}, **kw)

    def patch(self, path, json=None, **kw):
        return self._call("patch", path, json=json or {}, **kw)

    def delete(self, path, **kw):
        return self._call("delete", path, **kw)

    def register(self, email="owner@example.com", business="Test Shop"):
        r = self.post("/auth/register", {"business_name": business, "full_name": "Ama Kusi", "email": email,
                                         "password": "correct horse battery 9"})
        assert r.status_code == 201, r.get_json()
        return r.get_json()

    def login(self, email, password="correct horse battery 9"):
        return self.post("/auth/login", {"email": email, "password": password})

    def logout(self):
        r = self.post("/auth/logout")
        self.csrf = None
        return r


@pytest.fixture()
def app(tmp_path):
    limiter._hits.clear()
    app = create_app({"TESTING": True, "SECRET_KEY": "test-secret",
                      "SQLALCHEMY_DATABASE_URI": f"sqlite:///{tmp_path / 'test.db'}"})
    yield app
    with app.app_context():
        db.drop_all()


@pytest.fixture()
def api(app):
    with app.test_client() as client:
        yield ApiClient(client)


@pytest.fixture()
def owner(api):
    api.register()
    return api


def make_product(api, sku="RICE-5", price="85.00", stock=10, cost="60.00", **extra):
    r = api.post("/products", {"name": f"Product {sku}", "sku": sku, "price": price, "cost_price": cost,
                               "stock_quantity": stock, **extra})
    assert r.status_code == 201, r.get_json()
    return r.get_json()["product"]


def make_employee(api, email, role="cashier", **extra):
    r = api.post("/employees", {"full_name": f"Staff {role}", "email": email, "role": role,
                                "password": "temporary pass 123", **extra})
    assert r.status_code == 201, r.get_json()
    return r.get_json()["employee"]
