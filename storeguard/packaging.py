"""Builds the "run it on your store PC" download: StoreGuard plus a double-click launcher, as one zip."""
import io
import json
import threading
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOP = "StoreGuard"

# (source directory or file relative to ROOT, glob) — nothing from instance/, .env, databases or the venv.
_INCLUDE = [
    ("storeguard", "**/*.py"),
    ("frontend", "**/*"),
]
_FILES = ["app.py", "serve.py", "wsgi.py", "README.md", ".env.example"]
_LAUNCHER_DIR = ROOT / "packaging" / "windows"

_lock = threading.Lock()
_cache = {}


def _bundle_files():
    for folder, pattern in _INCLUDE:
        for path in sorted((ROOT / folder).glob(pattern)):
            if path.is_file() and "__pycache__" not in path.parts:
                yield path, path.relative_to(ROOT).as_posix()
    for name in _FILES:
        path = ROOT / name
        if path.is_file():
            yield path, name
    # Launcher files go at the top of the folder so the owner sees them first.
    for path in sorted(_LAUNCHER_DIR.iterdir()):
        if path.is_file():
            yield path, path.name


def _fingerprint():
    return tuple((arc, path.stat().st_mtime_ns, path.stat().st_size) for path, arc in _bundle_files())


def _contact_block(support):
    lines = ["", "", "GETTING HELP", "------------",
             "If something isn't working, check the steps above first. Still stuck? Contact:", "",
             f"  {support.get('name', '')} - {support.get('role', '')}".rstrip(" -")]
    for label, key in (("Phone", "phone"), ("WhatsApp", "whatsapp"), ("Email", "email"), ("Website", "website"),
                       ("Hours", "hours")):
        if support.get(key):
            lines.append(f"  {label + ':':10}{support[key]}")
    lines += ["", "Please say what you were doing, what you saw (a photo of the screen helps) and the",
              "StoreGuard version shown in Help & Support."]
    return "\n".join(lines).encode("utf-8") + b"\n"


def windows_bundle(support=None):
    """Zip bytes, rebuilt only when a bundled file (or the support contact) changes."""
    support = {k: v for k, v in (support or {}).items() if not k.endswith("_link")}
    key = (_fingerprint(), json.dumps(support, sort_keys=True))
    with _lock:
        if _cache.get("key") == key:
            return _cache["data"]
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for path, arc in _bundle_files():
                data = path.read_bytes()
                if arc == "READ ME FIRST.txt" and support:
                    data = data.rstrip() + _contact_block(support)
                if path.suffix.lower() in {".bat", ".cmd", ".txt"}:
                    # Windows tools expect CRLF line endings in batch files and notes.
                    data = data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
                archive.writestr(f"{TOP}/{arc}", data)
            if support:
                # Read by the store PC's own server (storeguard/support.py) so Help shows the same contact.
                archive.writestr(f"{TOP}/support.json", json.dumps(support, indent=2))
        _cache.update(key=key, data=buffer.getvalue())
        return _cache["data"]
