import re
from datetime import timedelta

from flask import Blueprint, jsonify, session
from werkzeug.security import check_password_hash, generate_password_hash

from .extensions import db
from .models import Branch, Business, User, utcnow
from .security import ROLES, client_ip, csrf_token, current_user, limiter, login_required, login_user
from .utils import ApiError, audit, body, clean_image, raise_alert, to_text

auth_bp = Blueprint("auth", __name__)

MAX_FAILED_LOGINS = 5
LOCKOUT = timedelta(minutes=15)
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_DUMMY_HASH = generate_password_hash("storeguard-timing-equalizer")


def validate_password(password):
    if len(password) < 10:
        raise ApiError("Password must be at least 10 characters long")
    if len(password) > 128:
        raise ApiError("Password must be at most 128 characters long")
    if password.isdigit() or password.isalpha():
        raise ApiError("Password must contain both letters and numbers or symbols")


def validate_email(email):
    email = to_text(email, "email", 255, required=True).lower()
    if not EMAIL_RE.match(email):
        raise ApiError("Enter a valid email address")
    return email


def session_payload(user):
    business = user.business
    return {
        "user": user.as_dict(include_private=True),
        "role_label": ROLES.get(user.role, user.role.title()),
        "business": business.as_dict(),
        "branch": user.branch.as_dict() if user.branch else None,
        "csrf_token": csrf_token(),
    }


def _aware(dt):
    from datetime import timezone
    return dt if dt is None or dt.tzinfo else dt.replace(tzinfo=timezone.utc)


@auth_bp.post("/register")
def register():
    if not limiter.hit(f"register:{client_ip()}", 5, 3600):
        return jsonify({"error": "Too many sign-up attempts. Try again later."}), 429
    payload = body()
    name = to_text(payload.get("business_name"), "business_name", 160, required=True)
    full_name = to_text(payload.get("full_name"), "full_name", 160, required=True)
    email = validate_email(payload.get("email"))
    phone = to_text(payload.get("phone"), "phone", 40)
    password = str(payload.get("password") or "")
    validate_password(password)
    if User.query.filter_by(email=email).first():
        return jsonify({"error": "Email is already registered"}), 409

    business = Business(name=name, phone=phone, email=email)
    db.session.add(business)
    db.session.flush()
    branch = Branch(business_id=business.id, name="Main branch")
    db.session.add(branch)
    db.session.flush()
    user = User(business_id=business.id, branch_id=branch.id, full_name=full_name, email=email, phone=phone,
                role="owner", employee_code="EMP-001")
    user.set_password(password)
    db.session.add(user)
    db.session.flush()
    audit(user, "business.registered", "business", business.id, "Initial business registration")
    db.session.commit()
    login_user(user)
    return jsonify(session_payload(user)), 201


@auth_bp.post("/login")
def login():
    ip = client_ip()
    if not limiter.hit(f"login:{ip}", 20, 300):
        return jsonify({"error": "Too many login attempts. Wait a few minutes and try again."}), 429
    payload = body()
    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "")
    user = User.query.filter_by(email=email).first() if email else None
    now = utcnow()

    if user and user.locked_until and _aware(user.locked_until) > now:
        minutes = max(1, int((_aware(user.locked_until) - now).total_seconds() // 60) + 1)
        return jsonify({"error": f"Account temporarily locked after repeated failed attempts. Try again in {minutes} min."}), 423

    if not user:
        check_password_hash(_DUMMY_HASH, password)  # equalize timing to avoid account enumeration
    if not user or not user.active or not user.check_password(password):
        if user:
            user.failed_logins = (user.failed_logins or 0) + 1
            if user.failed_logins >= MAX_FAILED_LOGINS:
                user.locked_until = now + LOCKOUT
                user.failed_logins = 0
                raise_alert(user.business_id, "warning", "auth", "Account locked after failed logins",
                            f"{MAX_FAILED_LOGINS} failed sign-in attempts for {user.email} from {ip}",
                            subject_user_id=user.id, entity_type="user", entity_id=user.id)
                audit(user, "auth.locked", "user", user.id, f"Locked after failed logins from {ip}")
            db.session.commit()
        return jsonify({"error": "Invalid email or password"}), 401

    user.failed_logins = 0
    user.locked_until = None
    user.last_login_at = now
    audit(user, "auth.login", "user", user.id, "Signed in")
    db.session.commit()
    login_user(user)
    return jsonify(session_payload(user))


@auth_bp.post("/logout")
def logout():
    user = current_user()
    if user:
        audit(user, "auth.logout", "user", user.id, "Signed out")
        db.session.commit()
    session.clear()
    return jsonify({"ok": True})


@auth_bp.get("/me")
@login_required
def me(user):
    return jsonify(session_payload(user))


@auth_bp.patch("/me")
@login_required
def update_me(user):
    payload = body()
    if "full_name" in payload:
        user.full_name = to_text(payload["full_name"], "full_name", 160, required=True)
    if "phone" in payload:
        user.phone = to_text(payload["phone"], "phone", 40)
    if "image" in payload:
        user.image = clean_image(payload.get("image"))
    audit(user, "user.profile_updated", "user", user.id, "Updated own profile")
    db.session.commit()
    return jsonify(session_payload(user))


@auth_bp.post("/change-password")
@login_required
def change_password(user):
    payload = body()
    if not user.check_password(str(payload.get("current_password") or "")):
        return jsonify({"error": "Current password is incorrect"}), 400
    new_password = str(payload.get("new_password") or "")
    validate_password(new_password)
    user.set_password(new_password)
    audit(user, "auth.password_changed", "user", user.id, "Changed own password")
    db.session.commit()
    login_user(user)  # rotate session; other sessions are invalidated by session_version bump
    return jsonify({"ok": True, "csrf_token": csrf_token()})
