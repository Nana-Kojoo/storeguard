import logging
import os
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix

from .extensions import db

ROOT = Path(__file__).resolve().parent.parent
DEV_SECRET = "development-only-change-me"


def _database_url():
    url = os.getenv("DATABASE_URL", f"sqlite:///{ROOT / 'instance' / 'storeguard.db'}")
    if url.startswith("postgres://"):  # Heroku-style URLs
        url = "postgresql://" + url[len("postgres://"):]
    return url


def create_app(test_config=None):
    load_dotenv()
    app = Flask(__name__, instance_path=str(ROOT / "instance"), static_folder=None)
    production = os.getenv("APP_ENV", "development").lower() == "production"
    app.config.from_mapping(
        APP_ENV="production" if production else "development",
        SECRET_KEY=os.getenv("SECRET_KEY", DEV_SECRET),
        SQLALCHEMY_DATABASE_URI=_database_url(),
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        SQLALCHEMY_ENGINE_OPTIONS={"pool_pre_ping": True},
        SESSION_COOKIE_NAME="storeguard_session",
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=os.getenv("SESSION_COOKIE_SECURE", "true" if production else "false").lower() == "true",
        PERMANENT_SESSION_LIFETIME=timedelta(hours=int(os.getenv("SESSION_HOURS", "12"))),
        MAX_CONTENT_LENGTH=1024 * 1024,
        ALLOW_REGISTRATION=os.getenv("ALLOW_REGISTRATION", "true").lower() == "true",
        FRONTEND_DIR=str(ROOT / "frontend"),
        AUTO_CREATE_TABLES=os.getenv("AUTO_CREATE_TABLES", "true").lower() == "true",
        CSRF_DISABLED=False,
    )
    if test_config:
        app.config.update(test_config)
    app.json.sort_keys = False

    if production and app.config["SECRET_KEY"] in ("", DEV_SECRET, "replace-me-in-development"):
        raise RuntimeError("SECRET_KEY must be set to a long random value when APP_ENV=production")
    if production and app.config["SQLALCHEMY_DATABASE_URI"].startswith("sqlite"):
        logging.getLogger(__name__).warning("Running production on SQLite; use PostgreSQL for multi-user deployments")

    if int(os.getenv("TRUSTED_PROXIES", "0")):
        n = int(os.getenv("TRUSTED_PROXIES"))
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=n, x_proto=n, x_host=n)

    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    Path(app.instance_path).mkdir(parents=True, exist_ok=True)
    db.init_app(app)

    from . import models  # noqa: F401
    from .api import api_bp
    from .auth import auth_bp
    from .cli import register_cli
    from .security import apply_security_headers, check_request_security
    from .utils import ApiError
    from .web import web_bp

    app.register_blueprint(auth_bp, url_prefix="/api/auth")
    app.register_blueprint(api_bp, url_prefix="/api")
    app.register_blueprint(web_bp)
    register_cli(app)

    @app.before_request
    def _guard():
        if request.endpoint == "auth.register" and not app.config["ALLOW_REGISTRATION"]:
            return jsonify({"error": "New business registration is disabled on this server"}), 403
        return check_request_security()

    app.after_request(apply_security_headers)

    @app.errorhandler(ApiError)
    def _api_error(exc):
        db.session.rollback()
        return jsonify({"error": exc.message}), exc.status

    @app.errorhandler(HTTPException)
    def _http_error(exc):
        db.session.rollback()
        if request.path.startswith("/api/"):
            messages = {404: "Not found", 405: "Method not allowed", 413: "Request too large"}
            return jsonify({"error": messages.get(exc.code, exc.description)}), exc.code
        if exc.code == 404:
            return send_from_directory(app.config["FRONTEND_DIR"], "404.html"), 404
        return exc

    @app.errorhandler(Exception)
    def _unhandled(exc):
        db.session.rollback()
        app.logger.exception("Unhandled error on %s %s", request.method, request.path)
        if request.path.startswith("/api/"):
            return jsonify({"error": "Something went wrong on the server. The error has been logged."}), 500
        return "Internal server error", 500

    @app.teardown_appcontext
    def _cleanup(exc):
        if exc is not None:
            db.session.rollback()

    if app.config["AUTO_CREATE_TABLES"]:
        with app.app_context():
            db.create_all()
            _add_missing_columns()

    return app


# Columns added after the first release. create_all() never alters existing tables, so add them here.
_LATE_COLUMNS = {
    "business": {"receipt_settings": "TEXT NOT NULL DEFAULT '{}'"},
}


def _add_missing_columns():
    from sqlalchemy import inspect, text
    inspector = inspect(db.engine)
    tables = set(inspector.get_table_names())
    with db.engine.begin() as conn:
        for table, columns in _LATE_COLUMNS.items():
            if table not in tables:
                continue
            existing = {col["name"] for col in inspector.get_columns(table)}
            for name, ddl in columns.items():
                if name not in existing:
                    conn.execute(text(f'ALTER TABLE "{table}" ADD COLUMN {name} {ddl}'))
                    logging.getLogger(__name__).info("Added column %s.%s", table, name)
