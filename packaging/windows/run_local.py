"""Run StoreGuard on this PC: the shop's own server, no internet needed day to day.

Started by "Start StoreGuard.bat". On first run it writes a .env with a random secret key.
Every start makes a dated backup of the database (the last 30 are kept in backups/).
"""
import argparse
import secrets
import shutil
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ENV_FILE = ROOT / ".env"
DB_FILE = ROOT / "instance" / "storeguard.db"
BACKUPS = ROOT / "backups"
KEEP_BACKUPS = 30


def ensure_env():
    if ENV_FILE.exists():
        return
    ENV_FILE.write_text(
        "# StoreGuard settings for this PC. Created automatically on first start.\n"
        "APP_ENV=production\n"
        "LOCAL_INSTALL=true\n"
        f"SECRET_KEY={secrets.token_urlsafe(48)}\n"
        "# Plain http on the shop network (no HTTPS certificate on a local PC)\n"
        "SESSION_COOKIE_SECURE=false\n"
        "# Set to false after you have created your business\n"
        "ALLOW_REGISTRATION=true\n"
        "# 0.0.0.0 lets other tills on the shop network connect; use 127.0.0.1 for this PC only\n"
        "HOST=0.0.0.0\n"
        "PORT=8000\n"
        "LOG_LEVEL=WARNING\n",
        encoding="utf-8",
    )
    print("  Created settings file (.env) with a new secret key.")


def read_env():
    values = {}
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    return values


def backup_database():
    if not DB_FILE.exists():
        return
    BACKUPS.mkdir(exist_ok=True)
    target = BACKUPS / f"storeguard-{date.today().isoformat()}.db"
    if not target.exists():
        # sqlite3's backup API gives a consistent copy even if the file is busy.
        import sqlite3
        with sqlite3.connect(DB_FILE) as src, sqlite3.connect(target) as dst:
            src.backup(dst)
        print(f"  Backed up today's database to backups\\{target.name}")
    old = sorted(BACKUPS.glob("storeguard-*.db"))[:-KEEP_BACKUPS]
    for path in old:
        path.unlink(missing_ok=True)


def lan_addresses():
    addresses = set()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))  # no packet is sent; picks the LAN interface
            addresses.add(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            addresses.add(info[4][0])
    except OSError:
        pass
    return sorted(a for a in addresses if not a.startswith("127."))


def open_when_ready(url, health):
    def wait_and_open():
        for _ in range(60):
            try:
                with urllib.request.urlopen(health, timeout=1):
                    break
            except OSError:
                time.sleep(0.5)
        webbrowser.open(url)
    threading.Thread(target=wait_and_open, daemon=True).start()


def main():
    parser = argparse.ArgumentParser(description="Run StoreGuard on this PC")
    parser.add_argument("--no-browser", action="store_true", help="don't open the browser")
    args = parser.parse_args()

    print("\n  StoreGuard - retail management for your store\n")
    ensure_env()
    env = read_env()
    host, port = env.get("HOST", "0.0.0.0"), int(env.get("PORT", "8000"))
    backup_database()

    sys.path.insert(0, str(ROOT))
    from waitress import serve

    from wsgi import app

    local = f"http://localhost:{port}"
    print(f"  On this PC:        {local}")
    if host == "0.0.0.0":
        for address in lan_addresses():
            print(f"  Other tills/tablets: http://{address}:{port}")
    print("\n  Keep this window open while the store is trading. Close it to stop StoreGuard.")
    print("  Tip: in Chrome or Edge, click 'Install' in the address bar to get a StoreGuard desktop icon.\n")
    if not args.no_browser:
        open_when_ready(f"{local}/app", f"http://127.0.0.1:{port}/healthz")
    serve(app, host=host, port=port, threads=8, ident="StoreGuard")


if __name__ == "__main__":
    main()
