(async function () {
  'use strict';
  const session = await SG.boot({ title: 'Suppliers & Purchases' });
  if (!session) return;
  const { html, setHTML, money } = SG;
  const canEdit = SG.can('suppliers');
  const main = document.querySelector('main');
  let suppliers = [], products = [], poStatus = 'ordered';

  setHTML(main, html`
    <div class="page-header">
      <div><h1 class="page-title">Suppliers & Purchases</h1><p class="page-subtitle">Manage vendors, place purchase orders and receive deliveries straight into stock.</p></div>
      <div class="page-actions">${canEdit ? html`<button class="btn-sg btn-soft" id="addSupplier"><i class="bi bi-plus-lg"></i> Add supplier</button><button class="btn-sg btn-forest" id="newPO"><i class="bi bi-cart-plus"></i> New purchase order</button>` : ''}</div>
    </div>
    <div class="stats-grid" id="stats"></div>
    <div class="row grid-gap">
      <div class="col-xl-5"><div class="card-sg flush h-100"><div class="card-head"><h2 class="card-title"><i class="bi bi-truck"></i> Suppliers</h2></div><div id="supTable"></div></div></div>
      <div class="col-xl-7"><div class="card-sg flush h-100"><div class="card-head"><h2 class="card-title"><i class="bi bi-receipt"></i> Purchase orders</h2>
        <div class="chip-group" id="poChips">${[['ordered', 'Open'], ['received', 'Received'], ['cancelled', 'Cancelled'], ['', 'All']].map(([v, l]) => html`<button class="chip ${v === 'ordered' ? 'active' : ''}" data-st="${v}">${l}</button>`)}</div></div><div id="poTable"></div></div></div>
    </div>`);

  const supTable = new SG.Table(document.getElementById('supTable'), {
    rows: [], pageSize: 10,
    empty: { icon: 'bi-truck', title: 'No suppliers yet', text: canEdit ? 'Add the vendors you buy stock from.' : '' },
    onAction: (a, s) => (a === 'edit' ? editSupplier(s) : a === 'order' ? newPO(s.id) : archiveSupplier(s)),
    columns: [
      { key: 'name', label: 'Supplier', sortable: true, render: s => html`<div class="cell-main">${s.name}</div><div class="cell-sub">${[s.contact_name, s.phone].filter(Boolean).join(' · ') || '—'}</div>` },
      { key: 'product_count', label: 'Products', className: 'num', sortable: true },
      { key: 'open_orders', label: 'Open POs', className: 'num', sortable: true },
      { key: 'a', label: '', className: 'actions', render: () => canEdit ? html`<button class="icon-action" data-action="order" title="New order"><i class="bi bi-cart-plus"></i></button><button class="icon-action" data-action="edit" title="Edit"><i class="bi bi-pencil"></i></button><button class="icon-action danger" data-action="archive" title="Archive"><i class="bi bi-archive"></i></button>` : '' },
    ],
  });
  const poTable = new SG.Table(document.getElementById('poTable'), {
    pageSize: 10,
    load: ({ page, perPage }) => SG.api.get('/purchase-orders', { status: poStatus, page, per_page: perPage }),
    onLoad: () => {},
    empty: { icon: 'bi-receipt', title: 'No purchase orders', text: 'Create one to track deliveries from suppliers.' },
    onRowClick: viewPO,
    columns: [
      { key: 'reference', label: 'PO', render: o => html`<span class="mono fw-600">${o.reference}</span><div class="cell-sub">${SG.fmtDate(o.created_at)}</div>` },
      { key: 'supplier_name', label: 'Supplier' },
      { key: 'items', label: 'Lines', className: 'num', render: o => o.items.length },
      { key: 'total', label: 'Total', className: 'num', render: o => money(o.total) },
      { key: 'expected_date', label: 'Expected', render: o => o.expected_date ? SG.fmtDate(o.expected_date) : '—' },
      { key: 'status', label: 'Status', render: o => SG.badge(o.status) },
    ],
  });

  async function load() {
    try {
      const [s, p] = await Promise.all([SG.api.get('/suppliers'), SG.api.get('/products')]);
      suppliers = s.suppliers; products = p.products;
      supTable.setRows(suppliers);
      const open = suppliers.reduce((n, x) => n + x.open_orders, 0);
      const low = products.filter(x => x.stock_quantity <= x.reorder_level);
      setHTML(document.getElementById('stats'), html`
        <div class="stat-card"><div class="stat-label">Suppliers <i class="bi bi-truck"></i></div><div class="stat-value">${suppliers.length}</div><div class="stat-sub">Active vendors</div></div>
        <div class="stat-card"><div class="stat-label">Open orders <i class="bi bi-hourglass-split"></i></div><div class="stat-value">${open}</div><div class="stat-sub">Awaiting delivery</div></div>
        <div class="stat-card"><div class="stat-label">Products to reorder <i class="bi bi-exclamation-triangle"></i></div><div class="stat-value text-amber">${low.length}</div><div class="stat-sub">${low.length && canEdit ? html`<a href="#" id="reorderLink">Create PO for these</a>` : 'At or below reorder level'}</div></div>`);
      const link = document.getElementById('reorderLink');
      if (link) link.addEventListener('click', e => { e.preventDefault(); newPO(null, low); });
    } catch (e) { SG.fail(e); }
  }

  const supplierFields = [
    { name: 'name', label: 'Company name', required: true, maxlength: 160 }, { name: 'contact_name', label: 'Contact person', col: 6 },
    { name: 'phone', label: 'Phone', type: 'tel', col: 6 }, { name: 'email', label: 'Email', type: 'email', col: 6 },
    { name: 'address', label: 'Address', col: 6 }, { name: 'notes', label: 'Notes', type: 'textarea', rows: 2 },
  ];
  function addSupplier() { SG.formModal({ title: 'Add supplier', icon: 'bi-truck', fields: supplierFields, onSubmit: async v => { await SG.api.post('/suppliers', v); SG.ok('Supplier added.'); load(); } }); }
  function editSupplier(s) { SG.formModal({ title: `Edit ${s.name}`, icon: 'bi-pencil-square', fields: supplierFields, values: s, onSubmit: async v => { await SG.api.patch(`/suppliers/${s.id}`, v); SG.ok('Supplier updated.'); load(); } }); }
  async function archiveSupplier(s) {
    if (!(await SG.confirm({ title: 'Archive supplier?', message: `${s.name} will be hidden. Past orders are kept.`, confirmText: 'Archive', danger: true }))) return;
    try { await SG.api.del(`/suppliers/${s.id}`); SG.ok('Supplier archived.'); load(); } catch (e) { SG.fail(e); }
  }

  function newPO(supplierId, prefill) {
    if (!suppliers.length) { SG.toast('Add a supplier first.', 'warning'); return; }
    const lineRow = (p = {}) => html`<tr class="po-line"><td><select class="form-select form-select-sm" data-f="product"><option value="">Select product…</option>${products.map(x => html`<option value="${x.id}" ${x.id === p.id ? SG.raw('selected') : ''} data-cost="${x.cost_price}">${x.name} (${x.stock_quantity} in stock)</option>`)}</select></td>
      <td><input type="number" class="form-control form-control-sm" data-f="qty" min="1" value="${p.qty || ''}"></td><td><input type="number" class="form-control form-control-sm" data-f="cost" min="0" step="0.01" value="${p.cost_price || ''}"></td>
      <td class="num fw-600" data-f="line">—</td><td><button type="button" class="icon-action danger" data-remove aria-label="Remove line"><i class="bi bi-x-lg"></i></button></td></tr>`;
    const initial = (prefill || []).map(p => ({ id: p.id, qty: Math.max(p.reorder_level * 2 - p.stock_quantity, 1), cost_price: p.cost_price }));
    const m = SG.modal({ title: 'New purchase order', icon: 'bi-cart-plus', size: 'xl',
      body: html`<div class="row g-3 mb-3"><div class="col-md-5"><label class="form-label">Supplier *</label><select class="form-select" id="poSupplier">${suppliers.map(s => html`<option value="${s.id}" ${s.id === supplierId ? SG.raw('selected') : ''}>${s.name}</option>`)}</select></div>
        <div class="col-md-3"><label class="form-label">Expected delivery</label><input type="date" class="form-control" id="poDate"></div><div class="col-md-4"><label class="form-label">Notes</label><input class="form-control" id="poNotes" maxlength="500"></div></div>
        <div class="table-wrap"><table class="table-sg"><thead><tr><th style="min-width:240px">Product</th><th style="width:110px">Qty</th><th style="width:130px">Unit cost</th><th class="num">Line total</th><th></th></tr></thead><tbody id="poLines">${initial.length ? initial.map(lineRow) : lineRow()}</tbody></table></div>
        <div class="d-flex justify-content-between align-items-center mt-2"><button type="button" class="btn-sg btn-soft sm" id="addLine"><i class="bi bi-plus"></i> Add line</button><div class="fw-bold">Total: <span id="poTotal">${money(0)}</span></div></div>
        <div class="notice danger mt-3 d-none" id="poErr"></div>`,
      footer: html`<button class="btn-sg btn-soft" data-bs-dismiss="modal">Cancel</button><button class="btn-sg btn-forest" id="poSave"><i class="bi bi-check-lg"></i> Place order</button>` });
    const tbody = m.el.querySelector('#poLines');
    const recalc = () => {
      let total = 0;
      tbody.querySelectorAll('.po-line').forEach(tr => {
        const q = parseFloat(tr.querySelector('[data-f=qty]').value) || 0, c = parseFloat(tr.querySelector('[data-f=cost]').value) || 0;
        tr.querySelector('[data-f=line]').textContent = money(q * c); total += q * c;
      });
      m.el.querySelector('#poTotal').textContent = money(total);
    };
    tbody.addEventListener('input', recalc);
    tbody.addEventListener('change', e => {
      if (e.target.dataset.f === 'product') { const opt = e.target.selectedOptions[0]; const cost = e.target.closest('tr').querySelector('[data-f=cost]'); if (opt && opt.dataset.cost && !cost.value) cost.value = opt.dataset.cost; recalc(); }
    });
    tbody.addEventListener('click', e => { if (e.target.closest('[data-remove]') && tbody.children.length > 1) { e.target.closest('tr').remove(); recalc(); } });
    m.el.querySelector('#addLine').addEventListener('click', () => { tbody.insertAdjacentHTML('beforeend', String(lineRow())); });
    recalc();
    m.el.querySelector('#poSave').addEventListener('click', async () => {
      const err = m.el.querySelector('#poErr'); err.classList.add('d-none');
      const items = [...tbody.querySelectorAll('.po-line')].map(tr => ({ product_id: parseInt(tr.querySelector('[data-f=product]').value, 10), quantity: tr.querySelector('[data-f=qty]').value, unit_cost: tr.querySelector('[data-f=cost]').value })).filter(i => i.product_id);
      if (!items.length) { err.textContent = 'Add at least one product.'; err.classList.remove('d-none'); return; }
      const btn = m.el.querySelector('#poSave'); SG.busy(btn, true, 'Saving…');
      try {
        const { order } = await SG.api.post('/purchase-orders', { supplier_id: parseInt(m.el.querySelector('#poSupplier').value, 10), expected_date: m.el.querySelector('#poDate').value || null, notes: m.el.querySelector('#poNotes').value, items });
        m.hide(); SG.ok(`Purchase order ${order.reference} placed.`); poTable.reload(); load();
      } catch (e) { err.textContent = e.message; err.classList.remove('d-none'); SG.busy(btn, false); }
    });
  }

  function viewPO(o) {
    const m = SG.modal({ title: `Purchase order ${o.reference}`, icon: 'bi-receipt', size: 'lg',
      body: html`<div class="row g-3 mb-3"><div class="col-6 col-md-3"><div class="small-xs text-muted-sg">Supplier</div><div class="fw-600">${o.supplier_name}</div></div><div class="col-6 col-md-3"><div class="small-xs text-muted-sg">Status</div>${SG.badge(o.status)}</div>
        <div class="col-6 col-md-3"><div class="small-xs text-muted-sg">Created</div><div class="fw-600 small">${SG.fmtDate(o.created_at)} by ${o.created_by}</div></div><div class="col-6 col-md-3"><div class="small-xs text-muted-sg">${o.received_at ? 'Received' : 'Expected'}</div><div class="fw-600 small">${o.received_at ? SG.fmtDateTime(o.received_at) : (o.expected_date ? SG.fmtDate(o.expected_date) : '—')}</div></div></div>
        ${o.notes ? html`<div class="notice mb-3"><i class="bi bi-sticky"></i><div>${o.notes}</div></div>` : ''}
        <div class="table-wrap"><table class="table-sg"><thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Unit cost</th><th class="num">Total</th></tr></thead><tbody>${o.items.map(i => html`<tr><td>${i.product_name}</td><td class="num">${i.quantity}</td><td class="num">${money(i.unit_cost)}</td><td class="num">${money(i.line_total)}</td></tr>`)}
        <tr><td colspan="3" class="text-end fw-bold">Total</td><td class="num fw-bold">${money(o.total)}</td></tr></tbody></table></div>`,
      footer: html`${o.status === 'ordered' && canEdit ? html`<button class="btn-sg btn-danger-soft me-auto" data-cancel>Cancel order</button>` : ''}${o.status === 'ordered' ? html`<button class="btn-sg btn-forest" data-receive><i class="bi bi-box-arrow-in-down"></i> Mark as received</button>` : ''}<button class="btn-sg btn-soft" data-bs-dismiss="modal">Close</button>` });
    const rcv = m.el.querySelector('[data-receive]');
    if (rcv) rcv.addEventListener('click', async () => {
      SG.busy(rcv, true, 'Receiving…');
      try { await SG.api.post(`/purchase-orders/${o.id}/receive`); m.hide(); SG.ok('Delivery received — stock and cost prices updated.'); poTable.reload(); load(); }
      catch (e) { SG.fail(e); SG.busy(rcv, false); }
    });
    const cancel = m.el.querySelector('[data-cancel]');
    if (cancel) cancel.addEventListener('click', async () => {
      try { await SG.api.post(`/purchase-orders/${o.id}/cancel`); m.hide(); SG.ok('Order cancelled.'); poTable.reload(); load(); } catch (e) { SG.fail(e); }
    });
  }

  document.getElementById('poChips').addEventListener('click', e => {
    const c = e.target.closest('[data-st]'); if (!c) return;
    document.querySelectorAll('#poChips .chip').forEach(x => x.classList.toggle('active', x === c));
    poStatus = c.dataset.st; poTable.reload(true);
  });
  if (canEdit) {
    document.getElementById('addSupplier').addEventListener('click', addSupplier);
    document.getElementById('newPO').addEventListener('click', () => newPO(null));
  }
  load();
})();
