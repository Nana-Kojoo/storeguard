(async function () {
  'use strict';
  const session = await SG.boot({ title: 'Customers & Credit' });
  if (!session) return;
  const { html, setHTML, money } = SG;
  const main = document.querySelector('main');
  let customers = [];
  const f = { q: '', owing: false };
  const METHODS = ['cash', 'momo', 'card'].map(m => ({ value: m, label: SG.paymentLabel(m) }));

  setHTML(main, html`
    <div class="page-header">
      <div><h1 class="page-title">Customers & Credit</h1><p class="page-subtitle">Regular customers, credit limits and outstanding balances.</p></div>
      <div class="page-actions"><button class="btn-sg btn-soft" id="exportBtn"><i class="bi bi-download"></i> Export</button><button class="btn-sg btn-forest" id="addBtn"><i class="bi bi-person-plus"></i> Add customer</button></div>
    </div>
    <div class="stats-grid" id="stats"></div>
    <div class="filters-bar"><div class="filter-search"><i class="bi bi-search"></i><input type="search" id="q" placeholder="Name or phone…"></div>
      <div class="chip-group" id="owingChips"><button class="chip active" data-o="">All customers</button><button class="chip" data-o="1">Owing money</button></div></div>
    <div class="card-sg flush"><div id="table"></div></div>`);

  const table = new SG.Table(document.getElementById('table'), {
    rows: [], pageSize: 20, onRowClick: c => detail(c.id),
    onAction: (a, c) => ({ pay: () => pay(c), edit: () => edit(c) })[a](),
    empty: { icon: 'bi-person-lines-fill', title: 'No customers yet', text: 'Add customers to sell on credit and track repayments.' },
    columns: [
      { key: 'name', label: 'Customer', sortable: true, render: c => html`<div class="cell-main">${c.name}</div><div class="cell-sub">${c.phone || 'No phone'}${c.email ? ` · ${c.email}` : ''}</div>` },
      { key: 'credit_limit', label: 'Credit limit', className: 'num', sortable: true, sortValue: c => SG.toNumber(c.credit_limit), render: c => money(c.credit_limit) },
      { key: 'balance', label: 'Owes', className: 'num', sortable: true, sortValue: c => SG.toNumber(c.balance), render: c => html`<b class="${SG.toNumber(c.balance) > 0 ? 'text-red' : ''}">${money(c.balance)}</b>` },
      { key: 'used', label: 'Credit used', render: c => { const lim = SG.toNumber(c.credit_limit); const pct = lim ? Math.min(100, SG.toNumber(c.balance) / lim * 100) : 0; return lim ? html`<div class="progress-thin" style="width:110px"><div style="width:${pct}%;background:${pct >= 90 ? 'var(--red)' : pct >= 70 ? '#e09a1d' : 'var(--emerald)'}"></div></div><div class="cell-sub">${Math.round(pct)}% used</div>` : html`<span class="cell-sub">No credit</span>`; } },
      { key: 'a', label: '', className: 'actions', render: c => html`${SG.toNumber(c.balance) > 0 ? html`<button class="btn-sg btn-soft sm" data-action="pay"><i class="bi bi-cash"></i> Receive payment</button>` : ''}<button class="icon-action" data-action="edit" aria-label="Edit"><i class="bi bi-pencil"></i></button>` },
    ],
  });

  function apply() {
    const q = f.q.toLowerCase();
    table.setRows(customers.filter(c => (!q || c.name.toLowerCase().includes(q) || c.phone.includes(q)) && (!f.owing || SG.toNumber(c.balance) > 0)));
    const owed = customers.reduce((n, c) => n + SG.toNumber(c.balance), 0);
    const owing = customers.filter(c => SG.toNumber(c.balance) > 0);
    const near = customers.filter(c => SG.toNumber(c.credit_limit) && SG.toNumber(c.balance) / SG.toNumber(c.credit_limit) >= 0.9);
    setHTML(document.getElementById('stats'), html`
      <div class="stat-card"><div class="stat-label">Customers <i class="bi bi-people"></i></div><div class="stat-value">${customers.length}</div><div class="stat-sub">${customers.filter(c => SG.toNumber(c.credit_limit) > 0).length} with credit</div></div>
      <div class="stat-card"><div class="stat-label">Total owed to you <i class="bi bi-cash-coin"></i></div><div class="stat-value text-red">${money(owed)}</div><div class="stat-sub">${owing.length} customer(s) owing</div></div>
      <div class="stat-card"><div class="stat-label">Near credit limit <i class="bi bi-exclamation-triangle"></i></div><div class="stat-value text-amber">${near.length}</div><div class="stat-sub">90% or more used</div></div>`);
  }
  async function load() { try { customers = (await SG.api.get('/customers')).customers; apply(); } catch (e) { SG.fail(e); } }

  const fields = [{ name: 'name', label: 'Full name / business', required: true }, { name: 'phone', label: 'Phone', type: 'tel', col: 6 }, { name: 'email', label: 'Email', type: 'email', col: 6 },
    { name: 'credit_limit', label: 'Credit limit', type: 'money', help: 'Maximum amount this customer may owe. 0 = cash only.', default: '0' }, { name: 'notes', label: 'Notes', type: 'textarea', rows: 2 }];
  function add() { SG.formModal({ title: 'Add customer', icon: 'bi-person-plus', fields, onSubmit: async v => { await SG.api.post('/customers', v); SG.ok('Customer added.'); load(); } }); }
  function edit(c) {
    SG.formModal({ title: `Edit ${c.name}`, icon: 'bi-pencil-square', fields, values: c,
      onSubmit: async v => { await SG.api.patch(`/customers/${c.id}`, v); SG.ok('Customer updated.'); load(); } });
  }
  function pay(c) {
    SG.formModal({ title: `Receive payment · ${c.name}`, icon: 'bi-cash', submitText: 'Record payment',
      intro: html`<div class="small">Outstanding balance: <b class="text-red">${money(c.balance)}</b>. Cash payments go into your open drawer.</div>`,
      fields: [{ name: 'amount', label: 'Amount received', type: 'money', required: true, col: 6, default: c.balance }, { name: 'method', label: 'Method', type: 'select', options: METHODS, col: 6 }, { name: 'note', label: 'Note', placeholder: 'Optional' }],
      onSubmit: async v => { await SG.api.post(`/customers/${c.id}/payments`, v); SG.ok('Payment recorded.'); load(); } });
  }
  async function detail(id) {
    let d; try { d = await SG.api.get(`/customers/${id}`); } catch (e) { SG.fail(e); return; }
    const c = d.customer;
    const entries = d.sales.filter(s => s.payment_method === 'credit').map(s => ({ at: s.created_at, label: `Credit sale ${s.reference}`, amount: SG.toNumber(s.total) - SG.toNumber(s.refunded_amount), kind: 'sale' }))
      .concat(d.payments.map(p => ({ at: p.created_at, label: `Payment (${SG.paymentLabel(p.method)})${p.note ? ` — ${p.note}` : ''}`, amount: -SG.toNumber(p.amount), kind: 'pay' })))
      .sort((a, b) => b.at.localeCompare(a.at));
    const m = SG.modal({ title: c.name, icon: 'bi-person-vcard', size: 'lg',
      body: html`<div class="stats-grid"><div class="stat-card"><div class="stat-label">Owes</div><div class="stat-value text-red">${money(c.balance)}</div></div><div class="stat-card"><div class="stat-label">Credit limit</div><div class="stat-value">${money(c.credit_limit)}</div><div class="stat-sub">${money(c.available_credit)} available</div></div><div class="stat-card"><div class="stat-label">Purchases</div><div class="stat-value">${d.sales.length}</div><div class="stat-sub">Last 100 shown</div></div></div>
        <div class="small text-muted-sg mb-2">${c.phone || ''} ${c.email ? `· ${c.email}` : ''} ${c.notes ? `· ${c.notes}` : ''}</div>
        <h3 class="h6 fw-bold">Credit statement</h3>
        <div class="table-wrap"><table class="table-sg"><thead><tr><th>Date</th><th>Entry</th><th class="num">Amount</th></tr></thead><tbody>${entries.length ? entries.map(e => html`<tr><td>${SG.fmtDateTime(e.at)}</td><td>${e.label}</td><td class="num ${e.kind === 'pay' ? 'text-emerald' : ''}">${money(e.amount, { signed: true })}</td></tr>`) : html`<tr><td colspan="3" class="text-center text-muted-sg py-3">No credit activity</td></tr>`}</tbody></table></div>`,
      footer: html`${SG.toNumber(c.balance) <= 0 ? html`<button class="btn-sg btn-ghost me-auto" data-archive>Archive</button>` : ''}<button class="btn-sg btn-soft" data-edit><i class="bi bi-pencil"></i> Edit</button>${SG.toNumber(c.balance) > 0 ? html`<button class="btn-sg btn-forest" data-pay><i class="bi bi-cash"></i> Receive payment</button>` : ''}` });
    const after = fn => () => { m.el.addEventListener('hidden.bs.modal', fn, { once: true }); m.hide(); };
    m.el.querySelector('[data-edit]').addEventListener('click', after(() => edit(c)));
    const p = m.el.querySelector('[data-pay]'); if (p) p.addEventListener('click', after(() => pay(c)));
    const a = m.el.querySelector('[data-archive]'); if (a) a.addEventListener('click', after(async () => {
      if (!(await SG.confirm({ title: 'Archive customer?', message: `${c.name} will be hidden from lists. History is kept.`, confirmText: 'Archive', danger: true }))) return;
      try { await SG.api.del(`/customers/${c.id}`); SG.ok('Customer archived.'); load(); } catch (e) { SG.fail(e); }
    }));
  }

  document.getElementById('q').addEventListener('input', SG.debounce(e => { f.q = e.target.value.trim(); apply(); }, 150));
  document.getElementById('owingChips').addEventListener('click', e => {
    const c = e.target.closest('[data-o]'); if (!c) return;
    document.querySelectorAll('#owingChips .chip').forEach(x => x.classList.toggle('active', x === c)); f.owing = !!c.dataset.o; apply();
  });
  document.getElementById('addBtn').addEventListener('click', add);
  document.getElementById('exportBtn').addEventListener('click', () => SG.exportCSV('customers', table.rows, [{ label: 'Name', value: c => c.name }, { label: 'Phone', value: c => c.phone },
    { label: 'Email', value: c => c.email }, { label: 'Credit limit', value: c => c.credit_limit }, { label: 'Balance owed', value: c => c.balance }]));
  await load();
  if (SG.param('id')) detail(parseInt(SG.param('id'), 10));
})();
