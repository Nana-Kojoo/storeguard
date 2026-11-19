from datetime import date, datetime, time, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from flask import jsonify, request

from .extensions import db
from .models import Alert, AuditLog
from .security import client_ip

CENT = Decimal("0.01")
PAYMENT_METHODS = {"cash", "momo", "card", "credit"}
NON_CREDIT_METHODS = PAYMENT_METHODS - {"credit"}
# Telecel Cash and AT Money used to be separate methods; they are now part of "momo" (Mobile Money).
# Old rows keep their stored value; new requests using them are folded into momo with the network noted.
LEGACY_MOMO = {"telecel": "Telecel", "at": "AirtelTigo"}
MOMO_METHODS = {"momo", *LEGACY_MOMO}
MOMO_NETWORKS = ("MTN", "Telecel", "AirtelTigo")


def canonical_method(method):
    """Group legacy mobile-money methods under momo for totals and filters."""
    return "momo" if method in MOMO_METHODS else method


def normalize_payment_method(method, reference="", allowed=PAYMENT_METHODS):
    """Validate a payment method; map legacy telecel/at to momo and record the network in the reference."""
    method = method or "cash"
    if method in LEGACY_MOMO:
        network = LEGACY_MOMO[method]
        reference = f"{network} · {reference}" if reference else network
        method = "momo"
    if method not in allowed:
        raise ApiError("Choose a valid payment method")
    return method, reference[:80]


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def error(message, status=400):
    return jsonify({"error": message}), status


def body():
    payload = request.get_json(silent=True)
    if payload is None:
        return {}
    if not isinstance(payload, dict):
        raise ApiError("Request body must be a JSON object")
    return payload


def to_money(value, field="amount", minimum=Decimal("0"), allow_none=False):
    if value is None or value == "":
        if allow_none:
            return None
        raise ApiError(f"{field.replace('_', ' ').capitalize()} is required")
    try:
        amount = Decimal(str(value)).quantize(CENT, rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        raise ApiError(f"{field.replace('_', ' ').capitalize()} must be a number") from None
    if not amount.is_finite() or (minimum is not None and amount < minimum):
        raise ApiError(f"{field.replace('_', ' ').capitalize()} must be at least {minimum}")
    if amount > Decimal("9999999999.99"):
        raise ApiError(f"{field.replace('_', ' ').capitalize()} is too large")
    return amount


def to_int(value, field="value", minimum=None, maximum=None, default=None):
    if value is None or value == "":
        if default is not None:
            return default
        raise ApiError(f"{field.replace('_', ' ').capitalize()} is required")
    try:
        if isinstance(value, float) and not value.is_integer():
            raise ValueError
        number = int(str(value).strip()) if not isinstance(value, (int, float)) else int(value)
    except (TypeError, ValueError):
        raise ApiError(f"{field.replace('_', ' ').capitalize()} must be a whole number") from None
    if minimum is not None and number < minimum:
        raise ApiError(f"{field.replace('_', ' ').capitalize()} must be at least {minimum}")
    if maximum is not None and number > maximum:
        raise ApiError(f"{field.replace('_', ' ').capitalize()} must be at most {maximum}")
    return number


def to_text(value, field="value", max_length=255, required=False):
    text = "" if value is None else str(value).strip()
    if required and not text:
        raise ApiError(f"{field.replace('_', ' ').capitalize()} is required")
    if len(text) > max_length:
        raise ApiError(f"{field.replace('_', ' ').capitalize()} must be at most {max_length} characters")
    return text


def to_date(value, field="date", allow_none=True):
    if value in (None, ""):
        if allow_none:
            return None
        raise ApiError(f"{field.replace('_', ' ').capitalize()} is required")
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        raise ApiError(f"{field.replace('_', ' ').capitalize()} must be a date (YYYY-MM-DD)") from None


def to_bool(value):
    if isinstance(value, bool):
        return value
    return str(value).lower() in {"1", "true", "yes", "on"}


# ---------------------------------------------------------------- time

def business_tz(business):
    try:
        return ZoneInfo(business.timezone or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return timezone.utc


def local_today(business):
    return datetime.now(business_tz(business)).date()


def day_bounds(business, start_day, end_day=None):
    """Return UTC datetimes covering [start_day 00:00, end_day 24:00) in the business timezone."""
    tz = business_tz(business)
    end_day = end_day or start_day
    start = datetime.combine(start_day, time.min, tzinfo=tz).astimezone(timezone.utc)
    end = datetime.combine(end_day + timedelta(days=1), time.min, tzinfo=tz).astimezone(timezone.utc)
    return start, end


def to_local(business, value):
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(business_tz(business))


def date_range_from_args(business, default_days=0):
    """Parse ?start=YYYY-MM-DD&end=YYYY-MM-DD (inclusive), defaulting to the last `default_days` days."""
    today = local_today(business)
    end_day = to_date(request.args.get("end"), "end") or today
    start_day = to_date(request.args.get("start"), "start") or (end_day - timedelta(days=default_days))
    if start_day > end_day:
        raise ApiError("Start date must be before end date")
    if (end_day - start_day).days > 366:
        raise ApiError("Date range cannot exceed one year")
    return start_day, end_day


# ---------------------------------------------------------------- queries

def paginate(query, serializer, default_per_page=25, max_per_page=200):
    page = to_int(request.args.get("page"), "page", minimum=1, default=1)
    per_page = to_int(request.args.get("per_page"), "per_page", minimum=1, maximum=max_per_page, default=default_per_page)
    total = query.order_by(None).count()
    items = query.limit(per_page).offset((page - 1) * per_page).all()
    return {
        "items": [serializer(item) for item in items],
        "total": total, "page": page, "per_page": per_page,
        "pages": max(1, -(-total // per_page)),
    }


def like(term):
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def dec(value):
    return Decimal(str(value or 0)).quantize(CENT)


# ---------------------------------------------------------------- records

def audit(user, action, entity_type, entity_id, reason, business_id=None):
    db.session.add(AuditLog(
        business_id=business_id or user.business_id, user_id=user.id if user else None, action=action,
        entity_type=entity_type, entity_id=str(entity_id), reason=reason[:255], ip_address=client_ip(),
    ))


def raise_alert(business_id, severity, category, title, detail="", subject_user_id=None,
                entity_type="", entity_id="", dedupe=False):
    """Create a security/operational alert. With dedupe, skip if an identical open alert exists."""
    if dedupe:
        existing = Alert.query.filter_by(business_id=business_id, category=category, entity_type=entity_type,
                                         entity_id=str(entity_id)).filter(
            Alert.status.in_(("open", "investigating"))).first()
        if existing:
            return existing
    alert = Alert(business_id=business_id, severity=severity, category=category, title=title[:160],
                  detail=detail[:500], subject_user_id=subject_user_id, entity_type=entity_type,
                  entity_id=str(entity_id))
    db.session.add(alert)
    return alert
