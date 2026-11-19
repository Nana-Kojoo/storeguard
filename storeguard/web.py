from pathlib import Path

from flask import Blueprint, abort, current_app, send_from_directory

web_bp = Blueprint("web", __name__)

ALLOWED_SUFFIXES = {".html", ".js", ".css", ".svg", ".png", ".jpg", ".ico", ".webmanifest", ".woff2"}


def frontend_dir():
    return Path(current_app.config["FRONTEND_DIR"])


@web_bp.get("/")
def index():
    return send_from_directory(frontend_dir(), "index.html")


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
    response = send_from_directory(root, path.relative_to(root).as_posix())
    if path.suffix.lower() == ".html":
        response.headers["Cache-Control"] = "no-cache"
    return response
