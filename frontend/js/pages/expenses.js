(async function () {
  'use strict';
  const session = await SG.boot({ title: 'Expenses' });
  if (!session) return;
  const { html, setHTML, money } = SG;
  const main = document.querySelector('main');
  const canManage = SG.can('expenses');
  const canAdd = canManage || SG.can('cash');
  const METHODS = [{ value: 'cash', label: 'Cash' }, { value: 'momo', label: 'Mobile Money' }, { value: 'card', label: 'Card' }, { value: 'bank', label: 'Bank transfer' }];
  const f = { start: SG.today(-29), end: SG.today(), category: '', status: '' };
  let categories = [];

  setHTML(main, html`
    <div class="page-header">
      <div><h1 class="page-title">Expenses</h1><p class="page-subtitle">Operating costs that reduce profit — utilities, rent, transport and more.${canManage ? '' : ' Expenses you record are sent to a manager for approval.'}</p></div>
      <div class="page-actions"><button class="btn-sg btn-soft" id="exportBtn"><i class="bi bi-download"></i> Export</button>${canAdd ? html`<button class="btn-sg btn-forest" id="addBtn"><i class="bi bi-plus-lg"></i> Record expense</button>` : ''}</div>
    </div>
    <div class="stats-grid" id="stats"></div>
    <div class="filters-bar">
      <select class="form-select-sg" id="cat" aria-label="Category"><option value="">All categories</option></select>
      <select class="form-select-sg" id="status" aria-label="Status"><option value="">All statuses</option><option value="approved">Approved</option><option value="pending">Pending</option><option value="rejected">Rejected</option></select>
      <div class="d-flex gap-1 align-items-center"><input type="date" class="form-input-sg" id="start" value="${f.start}" aria-label="From"><span class="small text-muted-sg">to</span><input type="date" class="form-input-sg" id="end" value="${f.end}" aria-label="To"></div>
    </div>
    <div class="row grid-gap">
      <div class="col-xl-8"><div class="card-sg flush"><div id="table"></div></div></div>
      <div class="col-xl-4"><div class="card-sg"><div class="card-head"><h2 class="card-title"><i class="bi bi-pie-chart"></i> By category</h2><span class="card-sub">Approved only</span></div><div id="byCat"></div></div></div>
    </div>`);

  const table = new SG.Table(document.getElementById('table'), {
    pageSize: 20,
    load: ({ page, perPage }) => SG.api.get('/expenses', { ...f, page, per_page: perPage }),
    onLoad: renderSummary,
    empty: { icon: 'bi-wallet2', title: 'No expenses in this period' },
    onAction: (a, e) => (a === 'edit' ? edit(e) : remove(e)),
    columns: [
      { key: 'expense_date', label: 'Date', render: e => SG.fmtDate(e.expense_date) },
      { key: 'category', label: 'Category', render: e => html`<span class="badge-st gray">${e.category}</span>` },
      { key: 'description', label: 'Description', render: e => html`<div>${e.description}</div><div class="cell-sub">${e.reference ? `Ref ${e.reference} · ` : ''}by ${e.user_name}</div>` },
      { key: 'payment_method', label: 'Paid by', render: e => SG.paymentLabel(e.payment_method) },
      { key: 'amount', label: 'Amount', className: 'num', render: e => html`<b>${money(e.amount)}</b>` },
      { key: 'status', label: 'Status', render: e => SG.badge(e.status) },
      { key: 'a', label: '', className: 'actions', render: () => canManage ? html`<button class="icon-action" data-action="edit" aria-label="Edit"><i class="bi bi-pencil"></i></button><button class="icon-action danger" data-action="delete" aria-label="Delete"><i class="bi bi-trash3"></i></button>` : '' },
    ],
  });

  function renderSummary(res) {
    const s = res.summary;
    categories = res.categories;
    const sel = document.getElementById('cat');
    if (sel.options.length === 1) categories.forEach(c => sel.insertAdjacentHTML('beforeend', String(html`<option>${c}</option>`)));
    const days = Math.max(1, Math.round((new Date(f.end) - new Date(f.start)) / 86400000) + 1);
    setHTML(document.getElementById('stats'), html`
      <div class="stat-card"><div class="stat-label">Approved expenses <i class="bi bi-wallet2"></i></div><div class="stat-value">${money(s.total)}</div><div class="stat-sub">${SG.fmtDate(f.start)} – ${SG.fmtDate(f.end)}</div></div>
      <div class="stat-card"><div class="stat-label">Daily average <i class="bi bi-calendar3"></i></div><div class="stat-value">${money(SG.toNumber(s.total) / days)}</div><div class="stat-sub">Over ${days} day(s)</div></div>
      <div class="stat-card"><div class="stat-label">Largest category <i class="bi bi-trophy"></i></div><div class="stat-value" style="font-size:1.15rem">${s.by_category[0] ? s.by_category[0].category : '—'}</div><div class="stat-sub">${s.by_category[0] ? money(s.by_category[0].total) : 'No spend yet'}</div></div>
      <div class="stat-card"><div class="stat-label">Awaiting approval <i class="bi bi-hourglass-split"></i></div><div class="stat-value ${s.pending ? 'text-amber' : ''}">${s.pending}</div><div class="stat-sub">${s.pending && SG.can('approvals') ? html`<a href="/approvals.html">Review</a>` : 'All time'}</div></div>`);
    const max = Math.max(...s.by_category.map(c => SG.toNumber(c.total)), 1);
    setHTML(document.getElementById('byCat'), s.by_category.length ? html`${s.by_category.map(c => html`<div class="bar-row"><span class="text-truncate">${c.category}</span><div class="bar-track"><div class="bar-fill" style="width:${SG.toNumber(c.total) / max * 100}%"></div></div><span class="fw-600 tabular">${money(c.total)}</span></div>`)}`
      : html`<div class="empty-state py-3"><i class="bi bi-pie-chart"></i><div class="small">No approved expenses yet</div></div>`);
  }

  const fields = () => [
    { name: 'expense_date', label: 'Date', type: 'date', required: true, col: 6, default: SG.today() },
    { name: 'category', label: 'Category', type: 'select', required: true, col: 6, options: categories.length ? categories : ['Utilities', 'Rent', 'Salaries', 'Transport', 'Supplies', 'Maintenance', 'Marketing', 'Security', 'Taxes & fees', 'Other'] },
    { name: 'description', label: 'Description', required: true, maxlength: 255, placeholder: 'e.g. ECG prepaid electricity' },
    { name: 'amount', label: 'Amount', type: 'money', required: true, col: 6 }, { name: 'payment_method', label: 'Paid by', type: 'select', options: METHODS, col: 6 },
    { name: 'reference', label: 'Receipt / reference no.', maxlength: 80 },
  ];
  function add() {
    SG.formModal({ title: 'Record expense', icon: 'bi-wallet2', fields: fields(), submitText: canManage ? 'Save expense' : 'Submit for approval',
      onSubmit: async v => { const { expense } = await SG.api.post('/expenses', v); SG.ok(expense.status === 'pending' ? 'Expense sent for approval.' : 'Expense recorded.'); table.reload(); } });
  }
  function edit(e) {
    SG.formModal({ title: 'Edit expense', icon: 'bi-pencil-square', fields: fields(), values: { ...e, payment_method: ['telecel', 'at'].includes(e.payment_method) ? 'momo' : e.payment_method },
      onSubmit: async v => { await SG.api.patch(`/expenses/${e.id}`, v); SG.ok('Expense updated.'); table.reload(); } });
  }
  async function remove(e) {
    if (!(await SG.confirm({ title: 'Delete expense?', message: `${e.description} (${money(e.amount)}) will be removed. The deletion is recorded in the audit log.`, confirmText: 'Delete', danger: true }))) return;
    try { await SG.api.del(`/expenses/${e.id}`); SG.ok('Expense deleted.'); table.reload(); } catch (err) { SG.fail(err); }
  }

  const reload = () => table.reload(true);
  document.getElementById('cat').addEventListener('change', e => { f.category = e.target.value; reload(); });
  document.getElementById('status').addEventListener('change', e => { f.status = e.target.value; reload(); });
  ['start', 'end'].forEach(id => document.getElementById(id).addEventListener('change', e => { f[id] = e.target.value; reload(); }));
  if (canAdd) document.getElementById('addBtn').addEventListener('click', add);
  document.getElementById('exportBtn').addEventListener('click', async () => {
    try {
      const res = await SG.api.get('/expenses', { ...f, page: 1, per_page: 200 });
      SG.exportCSV('expenses', res.items, [{ label: 'Date', value: e => e.expense_date }, { label: 'Category', value: e => e.category }, { label: 'Description', value: e => e.description },
        { label: 'Amount', value: e => e.amount }, { label: 'Paid by', value: e => SG.paymentLabel(e.payment_method) }, { label: 'Reference', value: e => e.reference },
        { label: 'Status', value: e => e.status }, { label: 'Recorded by', value: e => e.user_name }]);
    } catch (e) { SG.fail(e); }
  });
  if (SG.param('new') && canAdd) setTimeout(add, 300);
})();
