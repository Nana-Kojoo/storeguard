"""Home page, installable app (PWA), offline caching and the Windows download."""
import io
import json
import re
import zipfile
from pathlib import Path

import pytest

from storeguard import create_app
from storeguard.security import CSP

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"


def _sw_lists(source):
    pages = re.findall(r"'(/[^']+)'", source.split("const PAGES")[1].split("];")[0])
    assets = re.findall(r"'(/[^']+)'", source.split("const ASSETS")[1].split("];")[0])
    return pages, assets


def test_home_page_is_the_product_page(api):
    r = api.client.get("/")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    assert 'id="install"' in body and 'id="operate"' in body and 'id="support"' in body and "/download/storeguard-windows.zip" in body
    assert r.headers["Cache-Control"] == "no-cache"


def test_app_launcher_and_offline_pages(api):
    assert "launch.js" in api.client.get("/app").get_data(as_text=True)
    assert api.client.get("/offline.html").status_code == 200


def test_manifest_is_installable(api):
    r = api.client.get("/manifest.webmanifest")
    assert r.status_code == 200
    assert r.mimetype == "application/manifest+json"
    manifest = json.loads(r.get_data(as_text=True))
    assert manifest["display"] == "standalone" and manifest["start_url"].startswith("/app")
    sizes = {icon["sizes"] for icon in manifest["icons"]}
    assert {"192x192", "512x512"} <= sizes
    assert any(icon.get("purpose") == "maskable" for icon in manifest["icons"])
    for icon in manifest["icons"]:
        assert api.client.get(icon["src"]).status_code == 200, icon["src"]


def test_service_worker_is_versioned_and_never_cached(api):
    r = api.client.get("/sw.js")
    assert r.status_code == 200
    assert r.mimetype == "text/javascript"
    assert r.headers["Cache-Control"] == "no-cache"
    assert r.headers["Service-Worker-Allowed"] == "/"
    source = r.get_data(as_text=True)
    assert "__BUILD__" not in source
    assert re.search(r"const BUILD = '[0-9a-f]{16}'", source)


def test_service_worker_precaches_every_page_and_file_exists(api):
    pages, assets = _sw_lists((FRONTEND / "sw.js").read_text(encoding="utf-8"))
    for url in pages + assets:
        assert api.client.get(url).status_code == 200, f"precached file missing: {url}"
    # Every real page must be available offline (cashieropenpos.html is only a redirect).
    on_disk = {f"/{p.name}" for p in FRONTEND.glob("*.html")} - {"/cashieropenpos.html"}
    assert on_disk <= set(pages), f"pages not precached: {sorted(on_disk - set(pages))}"
    # ...and every page script too.
    scripts = {f"/js/pages/{p.name}" for p in (FRONTEND / "js" / "pages").glob("*.js")}
    assert scripts <= set(assets), f"scripts not precached: {sorted(scripts - set(assets))}"


def test_app_has_no_internet_dependencies():
    """Everything must be served locally so the app opens with no internet."""
    assert "cdn.jsdelivr" not in CSP and "googleapis" not in CSP
    for path in list(FRONTEND.glob("*.html")) + list((FRONTEND / "js").rglob("*.js")) + list((FRONTEND / "css").glob("*.css")):
        text = path.read_text(encoding="utf-8")
        assert not re.search(r"(src|href)=[\"']https?://(?!nana-kojo)", text), f"external asset in {path.name}"
        assert "cdn.jsdelivr" not in text and "fonts.googleapis" not in text, path.name


def test_every_page_links_manifest_and_local_assets(api):
    for page in FRONTEND.glob("*.html"):
        if page.name == "cashieropenpos.html":
            continue
        text = page.read_text(encoding="utf-8")
        assert 'rel="manifest"' in text, page.name
        for ref in re.findall(r'(?:src|href)="(/[^"#?]+)"', text):
            if ref in ("/", "/app") or ref.startswith("/download/"):
                continue
            assert api.client.get(ref).status_code == 200, f"{page.name} links missing {ref}"


def test_windows_download_bundle(api):
    r = api.client.get("/download/storeguard-windows.zip")
    assert r.status_code == 200
    assert r.mimetype == "application/zip"
    assert "attachment" in r.headers["Content-Disposition"]
    names = zipfile.ZipFile(io.BytesIO(r.data)).namelist()
    assert "StoreGuard/Start StoreGuard.bat" in names
    assert "StoreGuard/run_local.py" in names
    assert "StoreGuard/READ ME FIRST.txt" in names
    assert "StoreGuard/storeguard/__init__.py" in names
    assert "StoreGuard/frontend/pos.html" in names
    assert "StoreGuard/frontend/vendor/bootstrap/bootstrap.min.css" in names
    # Never ship secrets, databases or caches.
    for name in names:
        assert not name.endswith((".db", ".pyc")), name
        assert "/instance/" not in name and "/.venv/" not in name and "__pycache__" not in name, name
        assert not name.endswith("/.env"), name
    bat = zipfile.ZipFile(io.BytesIO(r.data)).read("StoreGuard/Start StoreGuard.bat")
    assert b"\r\n" in bat and b"\n" not in bat.replace(b"\r\n", b"")


def test_windows_download_can_be_disabled(tmp_path):
    app = create_app({"TESTING": True, "SECRET_KEY": "x", "DOWNLOADS_ENABLED": False,
                      "SQLALCHEMY_DATABASE_URI": f"sqlite:///{tmp_path / 'd.db'}"})
    assert app.test_client().get("/download/storeguard-windows.zip").status_code == 404


@pytest.mark.parametrize("path", ["/vendor/bootstrap/bootstrap.min.css", "/vendor/bootstrap-icons/fonts/bootstrap-icons.woff2"])
def test_vendor_files_served_with_long_cache(api, path):
    r = api.client.get(path)
    assert r.status_code == 200
    assert "max-age" in r.headers["Cache-Control"]


def test_support_contact_defaults_and_overrides(api, monkeypatch):
    info = api.client.get("/support.json").get_json()
    assert info["name"] and info["website"].startswith("https://")
    monkeypatch.setenv("SUPPORT_PHONE", "+233 24 123 4567")
    monkeypatch.setenv("SUPPORT_WHATSAPP", "+233 24 123 4567")
    monkeypatch.setenv("SUPPORT_EMAIL", "help@example.com")
    monkeypatch.setenv("SUPPORT_WEBSITE", "javascript:alert(1)")
    info = api.client.get("/support.json").get_json()
    assert info["phone_link"] == "tel:+233241234567"
    assert info["whatsapp_link"] == "https://wa.me/233241234567"
    assert info["email"] == "help@example.com"
    assert info["website"] == ""  # only http(s) links are ever rendered


def test_windows_download_carries_support_contact(api, monkeypatch):
    monkeypatch.setenv("SUPPORT_PHONE", "+233 24 765 4321")
    archive = zipfile.ZipFile(io.BytesIO(api.client.get("/download/storeguard-windows.zip").data))
    support = json.loads(archive.read("StoreGuard/support.json"))
    assert support["phone"] == "+233 24 765 4321" and "phone_link" not in support
    readme = archive.read("StoreGuard/READ ME FIRST.txt").decode()
    assert "GETTING HELP" in readme and "+233 24 765 4321" in readme
