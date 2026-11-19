(async function () {
  'use strict';
  const session = await SG.boot({ title: 'Audit Logs' });
  if (!session) return;
  const { html, setHTML } = SG;
  const main = document.querySelector('main');
  const f = { start: SG.today(-6), end: SG.today(), user_id: '', action: '', q: '' };
  const GROUPS = { auth: 'Sign-in & passwords', sale: 'Sales', refund: 'Refund requests', product: 'Products', stock: 'Stock', purchase_order: 'Purchase orders', supplier: 'Suppliers',
    customer: 'Customers', employee: 'Employees', shift: 'Shifts', cash: 'Cash drawer', expense: 'Expenses', approval: 'Approvals', alert: 'Alerts', device: 'Devices', settings: 'Settings' };
  const tone = a => /(locked|suspended|deleted|blocked|refunded|rejected|archived)/.test(a) ? 'red' : /(login|logout)/.test(a) ? 'gray' : /(created|completed|approved|opened|received|registered)/.test(a) ? 'green' : 'blue';

  setHTML(main, html`
    <div class="page-header"><div><h1 class="page-title">Audit Logs</h1><p class="page-subtitle">An append-only record of who did what, when and from where. Entries cannot be edited or deleted.</p></div>
      <div class="page-actions"><button class="btn-sg btn-soft" id="exportBtn"><i class="bi bi-download"></i> Export</button></div></div>
    <div class="filters-bar">
      <div class="filter-search"><i class="bi bi-search"></i><input type="search" id="q" placeholder="Search details or record ID…"></div>
      <select class="form-select-sg" id="user" aria-label="Employee"><option value="">All staff</option></select>
      <select class="form-select-sg" id="action" aria-label="Activity"><option value="">All activity</option>${Object.entries(GROUPS).map(([k, v]) => html`<option value="${k}.">${v}</option>`)}</select>
      <div class="d-flex gap-1 align-items-center"><input type="date" class="form-input-sg" id="start" value="${f.start}" aria-label="From"><span class="small text-muted-sg">to</span><input type="date" class="form-input-sg" id="end" value="${f.end}" aria-label="To"></div>
    </div>
    <div class="card-sg flush"><div id="table"></div></div>`);

  const table = new SG.Table(document.getElementById('table'), {
    pageSize: 50,
    load: ({ page, perPage }) => SG.api.get('/audit', { ...f, page, per_page: perPage }),
    empty: { icon: 'bi-journal', title: 'No activity in this period' },
    columns: [
      { key: 'created_at', label: 'When', render: a => html`<span class="tabular">${SG.fmtDateTime(a.created_at)}</span>` },
      { key: 'user_name', label: 'Who', render: a => html`<span class="fw-600">${a.user_name}</span>` },
      { key: 'action', label: 'Action', render: a => html`<span class="badge-st ${tone(a.action)} mono">${a.action}</span>` },
      { key: 'reason', label: 'Details', render: a => html`<span class="small">${a.reason}</span>` },
      { key: 'entity', label: 'Record', render: a => html`<span class="cell-sub mono">${a.entity_type} #${a.entity_id}</span>` },
      { key: 'ip_address', label: 'IP', render: a => html`<span class="cell-sub mono">${a.ip_address || '—'}</span>` },
    ],
  });
  const reload = SG.debounce(() => table.reload(true), 250);
  document.getElementById('q').addEventListener('input', e => { f.q = e.target.value.trim(); reload(); });
  ['user', 'action'].forEach(id => document.getElementById(id).addEventListener('change', e => { f[id === 'user' ? 'user_id' : 'action'] = e.target.value; reload(); }));
  ['start', 'end'].forEach(id => document.getElementById(id).addEventListener('change', e => { f[id] = e.target.value; reload(); }));
  SG.api.get('/employees').then(r => {
    const sel = document.getElementById('user');
    r.employees.forEach(e => sel.insertAdjacentHTML('beforeend', String(html`<option value="${e.id}">${e.name}</option>`)));
  }).catch(() => {});
  document.getElementById('exportBtn').addEventListener('click', async () => {
    try {
      const res = await SG.api.get('/audit', { ...f, page: 1, per_page: 200 });
      SG.exportCSV('audit_log', res.items, [{ label: 'When', value: a => a.created_at }, { label: 'Who', value: a => a.user_name }, { label: 'Action', value: a => a.action },
        { label: 'Details', value: a => a.reason }, { label: 'Record', value: a => `${a.entity_type} #${a.entity_id}` }, { label: 'IP', value: a => a.ip_address }]);
      if (res.total > 200) SG.toast('Exported the latest 200 entries. Narrow the filters to export older ones.', 'info');
    } catch (e) { SG.fail(e); }
  });
})();
