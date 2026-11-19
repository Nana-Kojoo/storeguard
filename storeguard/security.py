"""Authentication, authorization, CSRF and request-hardening helpers."""
import hmac
import secrets
import threading
import time
from collections import defaultdict, deque
from functools import wraps

from flask import current_app, g, jsonify, request, session

from .extensions import db

ALL_PERMISSIONS = (
    "pos", "refund", "discount", "inventory", "suppliers", "customers", "employees", "shifts",
    "cash", "expenses", "reports", "approvals", "security", "audit", "devices", "settings",
)

ROLES = {
    "owner": "Owner",
    "manager": "Manager",
    "supervisor": "Supervisor",
    "cashier": "Cashier",
    "inventory_officer": "Stock Clerk",
    "security": "Security",
}

ROLE_DEFAULTS = {
    "owner": set(ALL_PERMISSIONS),
    "manager": set(ALL_PERMISSIONS) - {"settings"},
    "supervisor": {"pos", "refund", "discount", "customers", "shifts", "cash", "reports", "approvals", "security"},
    "cashier": {"pos"},
    "inventory_officer": {"inventory", "suppliers"},
    "security": {"security", "audit", "reports"},
}

# Roles a given role may assign. Owners can do anything; managers cannot create owners/managers.
ASSIGNABLE_ROLES = {
    "owner": set(ROLES),
    "manager": {"supervisor", "cashier", "inventory_officer", "security"},
}

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
CSRF_EXEMPT_ENDPOINTS = {"auth.login", "auth.register"}


def effective_permissions(user):
    if user.role == "owner":
        return set(ALL_PERMISSIONS)
    if user.permissions is not None:
        return {p for p in user.permissions if p in ALL_PERMISSIONS}
    return set(ROLE_DEFAULTS.get(user.role, set()))


def has_permission(user, permission):
    return permission in effective_permissions(user)


def is_manager(user):
    return user.role in {"owner", "manager"}


# ---------------------------------------------------------------- session / user

def current_user():
    if "user" in g:
        return g.user
    from .models import User
    user = None
    user_id = session.get("user_id")
    if user_id:
        user = db.session.get(User, user_id)
        if not user or not user.active or session.get("sv") != user.session_version:
            session.clear()
            user = None
    g.user = user
    return user


def login_user(user):
    session.clear()
    session.permanent = True
    session["user_id"] = user.id
    session["sv"] = user.session_version
    session["csrf"] = secrets.token_urlsafe(32)


def csrf_token():
    token = session.get("csrf")
    if not token:
        token = session["csrf"] = secrets.token_urlsafe(32)
    return token


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        user = current_user()
        if not user:
            return jsonify({"error": "Authentication required"}), 401
        return view(user, *args, **kwargs)
    return wrapped


def permission_required(*permissions):
    """Require ANY of the listed permissions. Must be placed below @login_required."""
    def decorator(view):
        @wraps(view)
        def wrapped(user, *args, **kwargs):
            perms = effective_permissions(user)
            if not any(p in perms for p in permissions):
                return jsonify({"error": "You do not have permission to perform this action"}), 403
            return view(user, *args, **kwargs)
        return wrapped
    return decorator


# ---------------------------------------------------------------- request hardening

def check_request_security():
    """before_request hook for /api: enforce JSON bodies and CSRF on state-changing requests."""
    if not request.path.startswith("/api/") or request.method in SAFE_METHODS:
        return None
    if request.content_length and not request.is_json:
        return jsonify({"error": "Requests must use application/json"}), 415
    if request.endpoint in CSRF_EXEMPT_ENDPOINTS or current_app.config.get("CSRF_DISABLED"):
        return None
    expected = session.get("csrf")
    supplied = request.headers.get("X-CSRF-Token", "")
    if not expected or not hmac.compare_digest(expected, supplied):
        return jsonify({"error": "Your session has expired. Please refresh the page and try again."}), 403
    return None


CSP = (
    "default-src 'self'; "
    "script-src 'self' https://cdn.jsdelivr.net; "
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; "
    "font-src 'self' https://cdn.jsdelivr.net https://fonts.gstatic.com data:; "
    "img-src 'self' data: blob:; "
    "connect-src 'self'; "
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"
)


def apply_security_headers(response):
    headers = response.headers
    headers.setdefault("Content-Security-Policy", CSP)
    headers.setdefault("X-Content-Type-Options", "nosniff")
    headers.setdefault("X-Frame-Options", "DENY")
    headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    headers.setdefault("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
    headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
    if current_app.config.get("SESSION_COOKIE_SECURE"):
        headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    if request.path.startswith("/api/"):
        headers["Cache-Control"] = "no-store"
    return response


class RateLimiter:
    """Small in-process sliding-window limiter (per worker). Put a shared limiter in front for multi-node."""

    def __init__(self):
        self._hits = defaultdict(deque)
        self._lock = threading.Lock()

    def hit(self, key, limit, window_seconds):
        now = time.monotonic()
        with self._lock:
            hits = self._hits[key]
            while hits and now - hits[0] > window_seconds:
                hits.popleft()
            if len(hits) >= limit:
                return False
            hits.append(now)
            return True

    def reset(self, key):
        with self._lock:
            self._hits.pop(key, None)


limiter = RateLimiter()


def client_ip():
    return (request.remote_addr or "")[:64]
