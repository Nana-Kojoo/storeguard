(async function () {
  'use strict';
  const session = await SG.boot({ title: 'Sales' });
  if (!session) return;
  const { html, setHTML, money, int } = SG;
  const manager = SG.can('reports');
  const main = document.querySelector('main');
  const filters = { days: 0, q: '', payment_method: '', status: '', cashier_id: '', start: '', end: '' };

  setHTML(main, html`
    <div class="page-header">
      <div><h1 class="page-title">${manager ? 'Sales & Transactions' : 'My Transactions'}</h1><p class="page-subtitle">${manager ? 'Every sale, payment and refund across your store.' : 'Sales you have processed. Open one to reprint or request a refund.'}</p></div>
      <div class="page-actions"><button class="btn-sg btn-soft" id="exportBtn"><i class="bi bi-download"></i> Export CSV</button>${SG.can('pos') ? html`<a class="btn-sg btn-forest" href="/pos.html"><i class="bi bi-plus-lg"></i> New sale</a>` : ''}</div>
    </div>
    <div class="stats-grid" id="stats"></div>
    <div class="filters-bar">
      <div class="filter-search"><i class="bi bi-search"></i><input type="search" id="q" placeholder="Receipt no., customer or payment ref…"></div>
      <select class="form-select-sg" id="method" aria-label="Payment method"><option value="">All payments</option>${Object.entries(SG.PAYMENT_LABELS).filter(([k]) => k !== 'bank').map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select>
      <select class="form-select-sg" id="status" aria-label="Status"><option value="">All statuses</option><option value="completed">Completed</option><option value="partially_refunded">Partially refunded</option><option value="refunded">Refunded</option></select>
      ${manager ? html`<select class="form-select-sg" id="cashier" aria-label="Cashier"><option value="">All staff</option></select>` : ''}
      <div class="chip-group" id="range"></div>
      <div class="d-flex gap-1 align-items-center"><input type="date" class="form-input-sg" id="start" aria-label="From date"><span class="small text-muted-sg">to</span><input type="date" class="form-input-sg" id="end" aria-label="To date"></div>
    </div>
    <div class="card-sg flush"><div id="table"></div></div>`);

  const table = new SG.Table(document.getElementById('table'), {
    pageSize: 20,
    load: ({ page, perPage }) => SG.api.get('/sales', { ...params(), page, per_page: perPage }),
    onLoad: res => renderStats(res.summary),
    empty: { icon: 'bi-receipt', title: 'No transactions found', text: 'Try a different date range or filter.' },
    onRowClick: s => openSale(s.id),
    columns: [
      { key: 'reference', label: 'Receipt', render: s => html`<span class="mono fw-600">${s.reference}</span>${s.offline ? html` <i class="bi bi-cloud-slash text-amber" title="Recorded offline"></i>` : ''}` },
      { key: 'created_at', label: 'Date & time', render: s => SG.fmtDateTime(s.created_at) },
      { key: 'cashier_name', label: 'Cashier' },
      { key: 'customer_name', label: 'Customer', render: s => s.customer_name || html`<span class="text-muted-sg">—</span>` },
      { key: 'item_count', label: 'Items', className: 'num' },
      { key: 'payment_method', label: 'Payment', render: s => html`<i class="bi ${SG.PAYMENT_ICONS[s.payment_method]} text-muted-sg me-1"></i>${SG.paymentLabel(s.payment_method)}` },
      { key: 'total', label: 'Amount', className: 'num', render: s => html`<span class="fw-600">${money(s.total)}</span>${SG.toNumber(s.refunded_amount) ? html`<div class="cell-sub text-red">−${money(s.refunded_amount)}</div>` : ''}` },
      { key: 'status', label: 'Status', render: s => SG.badge(s.status) },
      { key: 'x', label: '', className: 'actions', render: () => html`<i class="bi bi-chevron-right text-muted-sg"></i>` },
    ],
  });

  function params() {
    const p = { q: filters.q, payment_method: filters.payment_method, status: filters.status, cashier_id: filters.cashier_id };
    if (filters.start || filters.end) { p.start = filters.start || filters.end; p.end = filters.end || filters.start; } else if (filters.days !== null) p.days = filters.days;
    return p;
  }
  function renderStats(s) {
    const label = filters.start || filters.end ? 'Selected period' : filters.days === 0 ? 'Today' : `Last ${filters.days + 1} days`;
    setHTML(document.getElementById('stats'), html`
      <div class="stat-card"><div class="stat-label">Gross sales <i class="bi bi-currency-exchange"></i></div><div class="stat-value">${money(s.revenue)}</div><div class="stat-sub">${label}</div></div>
      <div class="stat-card"><div class="stat-label">Transactions <i class="bi bi-receipt"></i></div><div class="stat-value">${int(s.count)}</div><div class="stat-sub">Avg. ${money(s.count ? SG.toNumber(s.revenue) / s.count : 0)}</div></div>
      <div class="stat-card"><div class="stat-label">Refunded <i class="bi bi-arrow-return-left"></i></div><div class="stat-value text-red">${money(s.refunded)}</div><div class="stat-sub">On sales in this period</div></div>
      <div class="stat-card"><div class="stat-label">Net sales <i class="bi bi-cash-coin"></i></div><div class="stat-value text-emerald">${money(s.net)}</div><div class="stat-sub">Gross minus refunds</div></div>`);
  }

  const reload = SG.debounce(() => table.reload(true), 250);
  document.getElementById('q').addEventListener('input', e => { filters.q = e.target.value.trim(); reload(); });
  document.getElementById('method').addEventListener('change', e => { filters.payment_method = e.target.value; reload(); });
  document.getElementById('status').addEventListener('change', e => { filters.status = e.target.value; reload(); });
  SG.rangeChips(document.getElementById('range'), days => {
    filters.days = days; filters.start = filters.end = '';
    document.getElementById('start').value = document.getElementById('end').value = '';
    reload();
  }, '0');
  ['start', 'end'].forEach(id => document.getElementById(id).addEventListener('change', e => {
    filters[id] = e.target.value;
    document.querySelectorAll('#range .chip').forEach(c => c.classList.remove('active'));
    reload();
  }));
  if (manager) {
    SG.api.get('/employees').then(r => {
      const sel = document.getElementById('cashier');
      r.employees.forEach(e => sel.insertAdjacentHTML('beforeend', String(html`<option value="${e.id}">${e.name}</option>`)));
      sel.addEventListener('change', e => { filters.cashier_id = e.target.value; reload(); });
    }).catch(() => {});
  }

  document.getElementById('exportBtn').addEventListener('click', async () => {
    try {
      const res = await SG.api.get('/sales', { ...params(), page: 1, per_page: 200 });
      let items = res.items;
      for (let p = 2; p <= Math.min(res.pages, 25); p++) items = items.concat((await SG.api.get('/sales', { ...params(), page: p, per_page: 200 })).items);
      SG.exportCSV('sales', items, [
        { label: 'Receipt', value: s => s.reference }, { label: 'Date', value: s => SG.fmtDateTime(s.created_at) },
        { label: 'Cashier', value: s => s.cashier_name }, { label: 'Customer', value: s => s.customer_name || '' },
        { label: 'Items', value: s => s.item_count }, { label: 'Payment', value: s => SG.paymentLabel(s.payment_method) },
        { label: 'Subtotal', value: s => s.subtotal }, { label: 'Discount', value: s => s.discount }, { label: 'Tax', value: s => s.tax },
        { label: 'Total', value: s => s.total }, { label: 'Refunded', value: s => s.refunded_amount }, { label: 'Status', value: s => s.status },
      ]);
    } catch (e) { SG.fail(e); }
  });

  // ------------------------------------------------------------ detail & refunds
  async function openSale(id) {
    let data;
    try { data = await SG.api.get(`/sales/${id}`); } catch (e) { SG.fail(e); return; }
    const s = data.sale;
    const refundable = s.items.some(i => i.quantity > i.refunded_quantity) && !s.pending_refund_approval && (SG.can('refund') || SG.can('pos'));
    const m = SG.modal({
      title: `Sale ${s.reference}`, icon: 'bi-receipt', size: 'lg',
      body: html`<div class="row g-3 mb-3">
          <div class="col-6 col-md-3"><div class="small-xs text-muted-sg">Date</div><div class="fw-600 small">${SG.fmtDateTime(s.created_at)}</div></div>
          <div class="col-6 col-md-3"><div class="small-xs text-muted-sg">Cashier</div><div class="fw-600 small">${s.cashier_name}</div></div>
          <div class="col-6 col-md-3"><div class="small-xs text-muted-sg">Payment</div><div class="fw-600 small">${(() => { const p = SG.splitMomoRef(s.payment_method, s.payment_reference); return html`${p.label}${p.ref ? html` · <span class="mono">${p.ref}</span>` : ''}`; })()}</div></div>
          <div class="col-6 col-md-3"><div class="small-xs text-muted-sg">Status</div>${SG.badge(s.status)}</div>
          ${s.customer_name ? html`<div class="col-6 col-md-3"><div class="small-xs text-muted-sg">Customer</div><div class="fw-600 small">${s.customer_name}</div></div>` : ''}
        </div>
        ${s.pending_refund_approval ? html`<div class="notice warn mb-3"><i class="bi bi-hourglass-split"></i><div>Refund of ${money(s.pending_refund_approval.amount)} requested by ${s.pending_refund_approval.requested_by} is awaiting approval.</div></div>` : ''}
        <div class="table-wrap mb-3"><table class="table-sg"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Total</th><th class="num">Refunded</th></tr></thead>
          <tbody>${s.items.map(i => html`<tr><td>${i.product_name}</td><td class="num">${i.quantity}</td><td class="num">${money(i.unit_price)}</td><td class="num">${money(i.line_total)}</td><td class="num">${i.refunded_quantity || '—'}</td></tr>`)}</tbody></table></div>
        <div class="row"><div class="col-md-6 ms-auto">
          <div class="kv-row"><span class="k">Subtotal</span><span class="v">${money(s.subtotal)}</span></div>
          ${SG.toNumber(s.discount) ? html`<div class="kv-row"><span class="k">Discount</span><span class="v text-red">−${money(s.discount)}</span></div>` : ''}
          ${SG.toNumber(s.tax) ? html`<div class="kv-row"><span class="k">Tax</span><span class="v">${money(s.tax)}</span></div>` : ''}
          <div class="kv-row total"><span class="k">Total</span><span class="v">${money(s.total)}</span></div>
          ${s.amount_tendered ? html`<div class="kv-row"><span class="k">Cash tendered / change</span><span class="v">${money(s.amount_tendered)} / ${money(s.change_due)}</span></div>` : ''}
          ${SG.toNumber(s.refunded_amount) ? html`<div class="kv-row"><span class="k">Refunded</span><span class="v text-red">−${money(s.refunded_amount)}</span></div>` : ''}
        </div></div>
        ${s.refunds.length ? html`<h3 class="h6 fw-bold mt-3">Refund history</h3>${s.refunds.map(r => html`<div class="list-row"><i class="bi bi-arrow-return-left text-amber"></i><div class="main"><div class="fw-600">${money(r.amount)} · ${r.reason}</div><div class="meta"><span>${SG.fmtDateTime(r.created_at)}</span><span>by ${r.user_name}</span><span>${r.items.map(i => `${i.quantity}× ${i.product_name}`).join(', ')}</span></div></div></div>`)}` : ''}`,
      footer: html`<button class="btn-sg btn-soft" data-print><i class="bi bi-printer"></i> Print receipt</button>${refundable ? html`<button class="btn-sg btn-danger-soft" data-refund><i class="bi bi-arrow-return-left"></i> Refund…</button>` : ''}<button class="btn-sg btn-forest" data-bs-dismiss="modal">Close</button>`,
    });
    m.el.querySelector('[data-print]').addEventListener('click', () => SG.printReceipt(s, data.business));
    const rb = m.el.querySelector('[data-refund]');
    if (rb) rb.addEventListener('click', () => { m.el.addEventListener('hidden.bs.modal', () => refund(s), { once: true }); m.hide(); });
  }

  function refund(s) {
    const lines = s.items.filter(i => i.quantity > i.refunded_quantity);
    const mustApprove = !SG.can('refund');
    SG.formModal({
      title: `Refund ${s.reference}`, icon: 'bi-arrow-return-left', submitText: mustApprove ? 'Request refund' : 'Process refund', size: 'lg',
      intro: html`${mustApprove ? html`<div class="notice warn mb-3"><i class="bi bi-shield-lock"></i><div>Refunds need a manager's approval. Your request will be sent for review.</div></div>` : ''}
        <div class="small text-muted-sg mb-2">Choose how many of each item the customer is returning. Items go back into stock.</div>
        <div class="table-wrap"><table class="table-sg"><thead><tr><th>Item</th><th class="num">Refundable</th><th class="num" style="width:120px">Return qty</th></tr></thead><tbody>
        ${lines.map(i => html`<tr><td>${i.product_name}<div class="cell-sub">${money(i.unit_price)} each</div></td><td class="num">${i.quantity - i.refunded_quantity}</td><td class="num"><input type="number" class="form-control form-control-sm text-end" data-line="${i.id}" min="0" max="${i.quantity - i.refunded_quantity}" value="${i.quantity - i.refunded_quantity}"></td></tr>`)}
        </tbody></table></div><div class="small-xs text-muted-sg mt-1">Refund amounts are prorated for any discount and tax on the original sale.</div>`,
      fields: [{ name: 'reason', label: 'Reason', type: 'select', required: true, options: ['Customer request', 'Damaged product', 'Wrong item', 'Expired product', 'Duplicate charge', 'Pricing error', 'Other'] },
        { name: 'note', label: 'Details', type: 'textarea', rows: 2, placeholder: 'Optional details for the audit trail' }],
      onSubmit: async (v, m) => {
        const items = [...m.el.querySelectorAll('[data-line]')].map(inp => ({ sale_item_id: parseInt(inp.dataset.line, 10), quantity: parseInt(inp.value, 10) || 0 })).filter(i => i.quantity > 0);
        if (!items.length) throw new Error('Select at least one item to refund.');
        const res = await SG.api.post(`/sales/${s.id}/refund`, { items, reason: v.note ? `${v.reason}: ${v.note}` : v.reason });
        if (res.status === 'pending_approval') SG.toast(res.message, 'info', 'Sent for approval');
        else SG.ok('Refund processed and stock returned.');
        table.reload();
      },
    });
  }

  const deepLink = SG.param('sale');
  if (deepLink) openSale(deepLink);
})();
