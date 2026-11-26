# StoreGuard

Retail management and loss-prevention for supermarkets: POS with offline queue, inventory, suppliers and purchase orders, shifts and cash drawers, refunds with approvals, customers on credit, expenses, reports, security alerts and a full audit trail.

- **Backend:** Flask 3 + SQLAlchemy (`storeguard/`) — JSON API under `/api`
- **Frontend:** static HTML + vanilla JS (`frontend/`) — Bootstrap 5.3, Chart.js, no build step. All libraries and fonts are served locally from `frontend/vendor/`, so nothing loads from the internet.
- **Installable app (PWA):** manifest + service worker; installs from Chrome/Edge/Safari and opens offline.

The home page (`/`) explains the product, how to use it, and how to get it: install as an app, download for a store PC, or use in the browser. Signed-in users go to `/app`.

## Quick start (development)

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env          # then edit SECRET_KEY
python app.py                   # http://127.0.0.1:5000
```

Open the app, choose **Create business** and register the owner account. Add staff from **Employees**.

To explore with sample data instead: `flask --app app seed-demo` (prints demo logins and a generated password; delete the demo business before going live).

## Production

1. Set environment variables (see `.env.example`):
   - `APP_ENV=production` — the app refuses to start without a strong `SECRET_KEY`
   - `SECRET_KEY` — `python -c "import secrets; print(secrets.token_urlsafe(48))"`
   - `DATABASE_URL=postgresql+psycopg://user:pass@host:5432/storeguard` (SQLite works for a single till but is not recommended)
   - `ALLOW_REGISTRATION=false` once your business exists (or create it with `flask --app app create-owner`)
   - `TRUSTED_PROXIES=1` when behind nginx / a load balancer
2. Serve over **HTTPS** only (session cookies are `Secure` in production).
3. Run with a production server:
   - Windows/Linux: `python serve.py` (waitress, port 8000)
   - Linux: `gunicorn -w 4 -b 0.0.0.0:8000 wsgi:app`
4. Point uptime monitoring at `GET /healthz`.
5. Back up the database daily.

Tables are created automatically on start (`AUTO_CREATE_TABLES=true`) or with `flask --app app init-db`. There are no migrations yet: if you upgrade over an existing database whose schema has changed, create a fresh database or add Alembic before deploying schema changes.

## Roles

| Role | Default access |
|---|---|
| Owner | Everything, including settings |
| Manager | Everything except business settings |
| Supervisor | POS, refunds, discounts, customers, shifts, cash, reports, approvals, security |
| Cashier | POS, own sales/refunds/shift/drawer |
| Stock Clerk | Inventory and suppliers |
| Security | Alerts, audit log, reports |

Permissions can be customised per employee. Approvals enforce separation of duties (you cannot approve your own request).

## Security controls

- Session cookies (HttpOnly, SameSite=Lax, Secure in production), 12h lifetime, sessions invalidated on password change/suspension
- CSRF token required on every state-changing API request; JSON-only request bodies
- Login rate limiting and 15-minute account lockout after 5 failures; constant-time login for unknown emails
- Strict Content-Security-Policy (no inline scripts), HSTS, X-Frame-Options, nosniff; CDN assets pinned with Subresource Integrity
- All output HTML-escaped by default in the frontend; CSV exports neutralise spreadsheet formulas
- Tenant isolation on every query; static serving limited to `frontend/`
- Append-only audit log with user and IP for every sensitive action

The in-process rate limiter is per worker; put a shared limiter (e.g. at the proxy) in front for multi-node deployments.

## Offline access

- **Installed app:** `frontend/sw.js` caches every page, script, style and font on first visit. Online, pages come from the network (always current); offline, from the cache. The server stamps a hash of the frontend files into the worker (`/sw.js`), so each deploy refreshes installed apps automatically. Service workers need HTTPS, or `localhost`.
- **Offline start:** after one online sign-in, the device keeps a copy of the session (no credentials). With no connection, pages open in offline mode and `/app` goes straight to the POS.
- **Offline POS:** sales are queued on the device with a unique `client_ref` and synced automatically (idempotently) when the connection returns. Connection, sign-in and server errors just retry later; sales the server rejects (e.g. stock ran out) are kept for review in the POS. The product, customer and shift details are cached for offline use. Don't clear browser data on a till with unsynced sales.
- Reports, editing, refunds and approvals need the server.

## Run on a store PC (Windows download)

`GET /download/storeguard-windows.zip` (the **Download for Windows** button on the home page) bundles the app with `packaging/windows/`:
`Start StoreGuard.bat` (sets up Python on first run, then starts), `run_local.py` (creates `.env` with a random secret, takes a daily database backup in `backups/`, serves on port 8000, opens the browser) and `READ ME FIRST.txt` for the owner. The PC becomes the store's own server, so the tills don't need the internet. Set `DOWNLOADS_ENABLED=false` to hide the download.

## Support contact

The home page, the Help page, the offline page and the Windows download show who to contact for help. Set `SUPPORT_NAME`, `SUPPORT_ROLE`, `SUPPORT_EMAIL`, `SUPPORT_PHONE`, `SUPPORT_WHATSAPP`, `SUPPORT_WEBSITE` and `SUPPORT_HOURS` (see `.env.example`); empty values are hidden. The values are served at `/support.json` and copied into each download as `support.json` and at the end of `READ ME FIRST.txt`.

## Tests

```powershell
python -m pytest -q
```

## Project layout

```
storeguard/          Flask app (models, security, API blueprints, CLI)
  api/catalog.py     products, stock, suppliers, purchase orders
  api/sales.py       sales, refunds, customers
  api/operations.py  shifts, cash drawer, attendance, expenses
  api/admin.py       employees, alerts, approvals, audit, devices, settings, reports, dashboard, search
frontend/            pages (*.html), home.html (product page), css/, js/storeguard.js (core), js/pwa.js, js/pages/*.js
  sw.js, manifest.webmanifest, icons/, vendor/ (local copies of Bootstrap, icons, Chart.js, SheetJS, Inter)
packaging/windows/   launcher files bundled into the Windows download
tests/               pytest suite
_legacy_ui/          previous static mock-ups (not served; safe to delete)
```
