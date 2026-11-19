# StoreGuard

Retail management and loss-prevention for supermarkets: POS with offline queue, inventory, suppliers and purchase orders, shifts and cash drawers, refunds with approvals, customers on credit, expenses, reports, security alerts and a full audit trail.

- **Backend:** Flask 3 + SQLAlchemy (`storeguard/`) — JSON API under `/api`
- **Frontend:** static HTML + vanilla JS (`frontend/`) — Bootstrap 5.3, Chart.js, no build step

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

## Offline POS

If the connection drops, the POS keeps selling: sales are queued in the browser with a unique `client_ref` and synced automatically (idempotently) when the connection returns. Sales that fail to sync (e.g. stock ran out) are kept for review in the POS. Don't clear browser data on a till with unsynced sales.

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
frontend/            pages (*.html), css/app.css, js/storeguard.js (core), js/pages/*.js
tests/               pytest suite
_legacy_ui/          previous static mock-ups (not served; safe to delete)
```
