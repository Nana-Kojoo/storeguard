(async function () {
  'use strict';
  const session = await SG.boot({ title: 'Security & Alerts' });
  if (!session) return;
  const { html, setHTML, money } = SG;
  const b = session.business;
  const main = document.querySelector('main');
  const f = { status: 'active', severity: '', category: '' };
  const CATS = { cash: 'Cash', refund: 'Refunds', discount: 'Discounts', inventory: 'Inventory', auth: 'Sign-in', device: 'Devices' };

  setHTML(main, html`
    <div class="page-header">
      <div><h1 class="page-title">Security & Alerts</h1><p class="page-subtitle">Automatic loss-prevention signals. Investigate, resolve, and leave a note for the audit trail.</p></div>
      <div class="page-actions"><a class="btn-sg btn-soft" href="/audit.html"><i class="bi bi-journal-text"></i> Audit log</a><button class="btn-sg btn-forest" id="refresh"><i class="bi bi-arrow-clockwise"></i> Refresh</button></div>
    </div>
    <div class="stats-grid" id="stats"></div>
    <div class="filters-bar">
      <div class="chip-group" id="statusChips">${[['active', 'Active'], ['resolved', 'Resolved'], ['dismissed', 'Dismissed'], ['', 'All']].map(([v, l]) => html`<button class="chip ${v === 'active' ? 'active' : ''}" data-st="${v}">${l}</button>`)}</div>
      <select class="form-select-sg" id="sev" aria-label="Severity"><option value="">All severities</option><option value="critical">Critical</option><option value="warning">Warning</option><option value="info">Info</option></select>
      <select class="form-select-sg" id="cat" aria-label="Category"><option value="">All categories</option>${Object.entries(CATS).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select>
    </div>
    <div class="row grid-gap">
      <div class="col-xl-8"><div class="card-sg flush"><div id="table"></div></div></div>
      <div class="col-xl-4"><div class="card-sg"><div class="card-head"><h2 class="card-title"><i class="bi bi-radar"></i> What StoreGuard watches</h2>${SG.can('settings') ? html`<a class="small" href="/settings.html">Thresholds</a>` : ''}</div>
        <div class="list-row"><span class="sev-dot critical mt-1"></span><div class="main"><b>Cash shortages</b><div class="meta">Shift closes more than ${money(b.cash_variance_threshold)} short (overages are warnings)</div></div></div>
        <div class="list-row"><span class="sev-dot warning mt-1"></span><div class="main"><b>Refund frequency</b><div class="meta">3+ refunds by one person in 24h (critical at 5)</div></div></div>
        <div class="list-row"><span class="sev-dot warning mt-1"></span><div class="main"><b>Large discounts</b><div class="meta">Any discount of 20% or more on a sale</div></div></div>
        <div class="list-row"><span class="sev-dot warning mt-1"></span><div class="main"><b>Stock losses</b><div class="meta">Theft, damage and expiry write-offs</div></div></div>
        <div class="list-row"><span class="sev-dot warning mt-1"></span><div class="main"><b>Account lockouts</b><div class="meta">5 failed sign-ins locks the account for 15 minutes</div></div></div>
        <div class="list-row"><span class="sev-dot critical mt-1"></span><div class="main"><b>Blocked devices</b><div class="meta">Attempted sales from a till a manager has blocked</div></div></div>
        <div class="list-row"><span class="sev-dot info mt-1"></span><div class="main"><b>Low &amp; out of stock</b><div class="meta">${b.low_stock_alerts ? 'Enabled' : 'Disabled in settings'}</div></div></div>
      </div></div>
    </div>`);

  const table = new SG.Table(document.getElementById('table'), {
    pageSize: 20,
    load: ({ page, perPage }) => SG.api.get('/alerts', { ...f, page, per_page: perPage }),
    onLoad: res => renderStats(res.summary),
    empty: { icon: 'bi-shield-check', title: 'No alerts here', text: 'Nothing suspicious matches these filters.' },
    onRowClick: open,
    columns: [
      { key: 'severity', label: '', render: a => html`<span class="sev-dot ${a.severity}" title="${a.severity}"></span>` },
      { key: 'title', label: 'Alert', render: a => html`<div class="cell-main">${a.title}</div><div class="cell-sub">${a.detail}</div>` },
      { key: 'category', label: 'Category', render: a => CATS[a.category] || SG.titleCase(a.category) },
      { key: 'subject_name', label: 'Employee', render: a => a.subject_name || html`<span class="text-muted-sg">—</span>` },
      { key: 'created_at', label: 'When', render: a => html`<span title="${SG.fmtDateTime(a.created_at)}">${SG.ago(a.created_at)}</span>` },
      { key: 'status', label: 'Status', render: a => SG.badge(a.status) },
    ],
  });
  function renderStats(s) {
    setHTML(document.getElementById('stats'), html`
      <div class="stat-card"><div class="stat-label">Critical <i class="bi bi-exclamation-octagon"></i></div><div class="stat-value ${s.critical ? 'text-red' : ''}">${s.critical}</div><div class="stat-sub">Active, need action now</div></div>
      <div class="stat-card"><div class="stat-label">Warnings <i class="bi bi-exclamation-triangle"></i></div><div class="stat-value ${s.warning ? 'text-amber' : ''}">${s.warning}</div><div class="stat-sub">Active</div></div>
      <div class="stat-card"><div class="stat-label">Info <i class="bi bi-info-circle"></i></div><div class="stat-value">${s.info}</div><div class="stat-sub">Active, low priority</div></div>
      <div class="stat-card"><div class="stat-label">Closed · 24h <i class="bi bi-check2-circle"></i></div><div class="stat-value text-emerald">${s.resolved_24h}</div><div class="stat-sub">Resolved or dismissed</div></div>`);
  }
  function open(a) {
    const links = { sale: `/st.html?sale=${a.entity_id}`, product: '/inventory.html', shift: '/cash.html', user: SG.can('employees') ? `/employees.html?id=${a.entity_id}` : null, device: '/devices.html' };
    const link = links[a.entity_type];
    const m = SG.modal({ title: a.title, icon: 'bi-shield-exclamation',
      body: html`<div class="d-flex gap-2 mb-3">${SG.badge(a.severity)} ${SG.badge(a.status)} <span class="small text-muted-sg ms-auto">${SG.fmtDateTime(a.created_at)}</span></div>
        <p>${a.detail}</p>${a.subject_name ? html`<div class="kv-row"><span class="k">Employee</span><span class="v">${a.subject_name}</span></div>` : ''}<div class="kv-row"><span class="k">Category</span><span class="v">${CATS[a.category] || a.category}</span></div>
        ${a.resolution_note ? html`<div class="notice mt-3"><i class="bi bi-chat-left-text"></i><div><b>Note:</b> ${a.resolution_note}${a.resolved_at ? html`<div class="small-xs">${SG.fmtDateTime(a.resolved_at)}</div>` : ''}</div></div>` : ''}
        ${link ? html`<a class="btn-sg btn-soft sm mt-3" href="${link}"><i class="bi bi-box-arrow-up-right"></i> Open related record</a>` : ''}`,
      footer: ['open', 'investigating'].includes(a.status)
        ? html`<button class="btn-sg btn-ghost me-auto" data-st="dismissed">Dismiss</button>${a.status === 'open' ? html`<button class="btn-sg btn-soft" data-st="investigating"><i class="bi bi-search"></i> Investigating</button>` : ''}<button class="btn-sg btn-forest" data-st="resolved"><i class="bi bi-check2"></i> Resolve</button>`
        : html`<button class="btn-sg btn-soft" data-st="open">Reopen</button><button class="btn-sg btn-forest" data-bs-dismiss="modal">Close</button>` });
    m.el.querySelectorAll('[data-st]').forEach(btn => btn.addEventListener('click', () => {
      const status = btn.dataset.st;
      m.el.addEventListener('hidden.bs.modal', async () => {
        let note = '';
        if (status === 'resolved' || status === 'dismissed') {
          note = await SG.confirm({ title: status === 'resolved' ? 'Resolve alert' : 'Dismiss alert', message: 'What did you find? This note is kept in the audit log.', confirmText: status === 'resolved' ? 'Resolve' : 'Dismiss', input: { label: 'Resolution note', required: true } });
          if (note === null) return;
        }
        try { await SG.api.patch(`/alerts/${a.id}`, { status, note }); SG.ok(`Alert marked ${status}.`); table.reload(); } catch (e) { SG.fail(e); }
      }, { once: true });
      m.hide();
    }));
  }

  document.getElementById('statusChips').addEventListener('click', e => {
    const c = e.target.closest('[data-st]'); if (!c) return;
    document.querySelectorAll('#statusChips .chip').forEach(x => x.classList.toggle('active', x === c));
    f.status = c.dataset.st; table.reload(true);
  });
  document.getElementById('sev').addEventListener('change', e => { f.severity = e.target.value; table.reload(true); });
  document.getElementById('cat').addEventListener('change', e => { f.category = e.target.value; table.reload(true); });
  document.getElementById('refresh').addEventListener('click', () => table.reload());
})();
