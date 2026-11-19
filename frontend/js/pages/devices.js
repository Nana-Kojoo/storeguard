(async function () {
  'use strict';
  const session = await SG.boot({ title: 'Device Management' });
  if (!session) return;
  const { html, setHTML } = SG;
  const main = document.querySelector('main');
  const KINDS = { pos_terminal: 'POS terminal', tablet: 'Tablet', phone: 'Phone', back_office: 'Back office PC' };

  setHTML(main, html`
    <div class="page-header"><div><h1 class="page-title">Device Management</h1><p class="page-subtitle">Tills register automatically the first time the POS opens on them. Block a lost or misused device to stop it recording sales.</p></div>
      <div class="page-actions"><button class="btn-sg btn-soft" id="refresh"><i class="bi bi-arrow-clockwise"></i> Refresh</button></div></div>
    <div class="stats-grid" id="stats"></div>
    <div class="card-sg flush"><div id="table"></div></div>`);

  const online = d => d.last_seen_at && (Date.now() - new Date(d.last_seen_at)) < 10 * 60000;
  const table = new SG.Table(document.getElementById('table'), {
    rows: [], pageSize: 20,
    empty: { icon: 'bi-phone', title: 'No devices registered', text: 'Open the Point of Sale on a till to register it.' },
    onAction: (a, d) => ({ edit: () => edit(d), block: () => setStatus(d, 'blocked'), unblock: () => setStatus(d, 'active'), remove: () => remove(d) })[a](),
    columns: [
      { key: 'name', label: 'Device', sortable: true, render: d => html`<div class="cell-flex"><span class="thumb-icon"><i class="bi ${d.kind === 'tablet' ? 'bi-tablet' : d.kind === 'phone' ? 'bi-phone' : d.kind === 'back_office' ? 'bi-pc-display' : 'bi-display'}"></i></span><div><div class="cell-main">${d.name}</div><div class="cell-sub">${KINDS[d.kind] || d.kind}</div></div></div>` },
      { key: 'status', label: 'Status', render: d => d.status === 'blocked' ? SG.badge('blocked') : online(d) ? SG.badge('active', 'Online') : SG.badge('off_shift', 'Idle') },
      { key: 'last_seen_at', label: 'Last seen', sortable: true, render: d => d.last_seen_at ? html`<span title="${SG.fmtDateTime(d.last_seen_at)}">${SG.ago(d.last_seen_at)}</span>` : 'Never' },
      { key: 'last_user', label: 'Last user', render: d => d.last_user || '—' },
      { key: 'sales_24h', label: 'Sales · 24h', className: 'num', sortable: true },
      { key: 'last_ip', label: 'IP / browser', render: d => html`<div class="cell-sub mono">${d.last_ip || '—'}</div><div class="cell-sub text-truncate" style="max-width:220px" title="${d.user_agent}">${d.user_agent || ''}</div>` },
      { key: 'a', label: '', className: 'actions', render: d => html`<button class="icon-action" data-action="edit" aria-label="Rename"><i class="bi bi-pencil"></i></button>${d.status === 'blocked' ? html`<button class="btn-sg btn-soft sm" data-action="unblock">Unblock</button>` : html`<button class="btn-sg btn-danger-soft sm" data-action="block">Block</button>`}${d.sales_24h === 0 ? html`<button class="icon-action danger" data-action="remove" aria-label="Remove"><i class="bi bi-trash3"></i></button>` : ''}` },
    ],
  });

  async function load() {
    try {
      const { devices } = await SG.api.get('/devices');
      table.setRows(devices);
      setHTML(document.getElementById('stats'), html`
        <div class="stat-card"><div class="stat-label">Registered <i class="bi bi-phone"></i></div><div class="stat-value">${devices.length}</div></div>
        <div class="stat-card"><div class="stat-label">Online now <i class="bi bi-wifi"></i></div><div class="stat-value text-emerald">${devices.filter(online).length}</div><div class="stat-sub">Seen in the last 10 min</div></div>
        <div class="stat-card"><div class="stat-label">Blocked <i class="bi bi-slash-circle"></i></div><div class="stat-value text-red">${devices.filter(d => d.status === 'blocked').length}</div></div>`);
    } catch (e) { SG.fail(e); }
  }
  function edit(d) {
    SG.formModal({ title: `Edit ${d.name}`, icon: 'bi-pencil-square', values: d, fields: [{ name: 'name', label: 'Name', required: true, maxlength: 80 }, { name: 'kind', label: 'Type', type: 'select', options: Object.entries(KINDS).map(([value, label]) => ({ value, label })) }],
      onSubmit: async v => { await SG.api.patch(`/devices/${d.id}`, v); SG.ok('Device updated.'); load(); } });
  }
  async function setStatus(d, status) {
    if (status === 'blocked' && !(await SG.confirm({ title: `Block ${d.name}?`, message: 'Sales from this device will be refused and an alert raised if someone tries.', confirmText: 'Block device', danger: true }))) return;
    try { await SG.api.patch(`/devices/${d.id}`, { status }); SG.ok(status === 'blocked' ? 'Device blocked.' : 'Device unblocked.'); load(); } catch (e) { SG.fail(e); }
  }
  async function remove(d) {
    if (!(await SG.confirm({ title: `Remove ${d.name}?`, message: 'It will register again as a new device if the POS is opened on it.', confirmText: 'Remove', danger: true }))) return;
    try { await SG.api.del(`/devices/${d.id}`); SG.ok('Device removed.'); load(); } catch (e) { SG.fail(e); }
  }
  document.getElementById('refresh').addEventListener('click', load);
  load();
})();
