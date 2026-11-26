"""Developer / support contact shown to store owners and staff when they need help.

Set with environment variables (SUPPORT_NAME, SUPPORT_EMAIL, SUPPORT_PHONE, SUPPORT_WHATSAPP, SUPPORT_WEBSITE,
SUPPORT_HOURS). A store-PC install has no such variables, so the Windows download carries the hosting server's
values in support.json at the top of the folder. Empty values are simply not shown.
"""
import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUPPORT_FILE = ROOT / "support.json"

DEFAULTS = {
    "name": "Nana Kojo",
    "role": "Developer of StoreGuard",
    "email": "",
    "phone": "",
    "whatsapp": "",
    "website": "https://nana-kojo.vercel.app",
    "hours": "Monday to Saturday, 8am to 8pm (GMT)",
}


def _from_file():
    try:
        data = json.loads(SUPPORT_FILE.read_text(encoding="utf-8"))
        return {k: str(v) for k, v in data.items() if k in DEFAULTS and isinstance(v, str)}
    except (OSError, ValueError):
        return {}


def support_info():
    info = dict(DEFAULTS)
    info.update(_from_file())
    for key in DEFAULTS:
        value = os.getenv(f"SUPPORT_{key.upper()}")
        if value is not None:
            info[key] = value.strip()
    # wa.me links need the number in international format with digits only.
    info["whatsapp_link"] = f"https://wa.me/{re.sub(r'[^0-9]', '', info['whatsapp'])}" if info["whatsapp"] else ""
    info["phone_link"] = f"tel:{re.sub(r'[^0-9+]', '', info['phone'])}" if info["phone"] else ""
    if info["website"] and not info["website"].startswith(("https://", "http://")):
        info["website"] = ""  # never render javascript: or other schemes as a link
    return info
