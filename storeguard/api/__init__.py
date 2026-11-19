from flask import Blueprint

api_bp = Blueprint("api", __name__)

from . import admin, catalog, operations, sales  # noqa: E402,F401
