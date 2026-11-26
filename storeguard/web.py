import hashlib
import json
from pathlib import Path

from flask import Blueprint, Response, abort, current_app, send_from_directory

from .packaging import windows_bundle
from .support import support_info

web_bp = Blueprint("web", __name__)

ALLOWED_SUFFIXES = {".html", ".js", ".css", ".svg", ".png", ".jpg", ".ico", ".webmanifest", ".woff2", ".woff"}


def frontend_dir():
    return Path(current_app.config["FRONTEND_DIR"])


def _page(name):
    response = send_from_directory(frontend_dir(), name)
    response.headers["Cache-Control"] = "no-cache"
    return response


@web_bp.get("/")
def home():
    """Public product page: what StoreGuard is, how to use it, how to install or download it."""
    return _page("home.html")


@web_bp.get("/app")
def launch():
    """Start URL of the installed app: sends the user to their dashboard, sign-in, or the offline POS."""
    return _page("app.html")


def build_id():
    """Hash of the frontend files. Changes whenever any page, script or style changes, so installed
    apps pick up the new version (the service worker's cache name includes it)."""
    cached = current_app.extensions.get("storeguard_build")
    if cached and not current_app.debug:
        return cached
    digest = hashlib.sha256()
    root = frontend_dir()
    for path in sorted(p for p in root.rglob("*") if p.is_file() and p.name != "sw.js"):
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(path.read_bytes())
    value = digest.hexdigest()[:16]
    current_app.extensions["storeguard_build"] = value
    return value


@web_bp.get("/sw.js")
def service_worker():
    source = (frontend_dir() / "sw.js").read_text(encoding="utf-8").replace("__BUILD__", build_id())
    response = Response(source, mimetype="text/javascript")
    # Browsers must always re-check the worker so updates roll out promptly.
    response.headers["Cache-Control"] = "no-cache"
    response.headers["Service-Worker-Allowed"] = "/"
    return response


@web_bp.get("/download/storeguard-windows.zip")
def download_windows():
    """Self-contained copy of StoreGuard to run on a store PC (local server, works with no internet)."""
    if not current_app.config.get("DOWNLOADS_ENABLED", True):
        abort(404)
    data = windows_bundle(support_info())
    response = Response(data, mimetype="application/zip")
    response.headers["Content-Disposition"] = 'attachment; filename="StoreGuard-Windows.zip"'
    response.headers["Content-Length"] = str(len(data))
    response.headers["Cache-Control"] = "no-cache"
    return response


@web_bp.get("/support.json")
def support():
    """Who to contact for help. Shown on the home page, the Help page and the offline page."""
    response = Response(json.dumps(support_info()), mimetype="application/json")
    response.headers["Cache-Control"] = "no-cache"
    return response


@web_bp.get("/healthz")
def healthz():
    from .extensions import db
    try:
        db.session.execute(db.text("SELECT 1"))
        return {"status": "ok"}
    except Exception:  # pragma: no cover - surfaced to load balancer
        current_app.logger.exception("Health check failed")
        return {"status": "error"}, 503


@web_bp.get("/<path:filename>")
def static_page(filename):
    root = frontend_dir().resolve()
    path = (root / filename).resolve()
    if root not in path.parents or not path.is_file() or path.suffix.lower() not in ALLOWED_SUFFIXES:
        abort(404)
    suffix = path.suffix.lower()
    mimetype = "application/manifest+json" if suffix == ".webmanifest" else None
    response = send_from_directory(root, path.relative_to(root).as_posix(), mimetype=mimetype)
    if suffix in (".html", ".webmanifest"):
        response.headers["Cache-Control"] = "no-cache"
    elif path.relative_to(root).parts[0] == "vendor":
        # Pinned third-party libraries never change at the same URL.
        response.headers["Cache-Control"] = "public, max-age=604800"
    return response
