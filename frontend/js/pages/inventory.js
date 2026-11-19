(async function () {
  'use strict';
  const session = await SG.boot({ title: 'Inventory' });
  if (!session) return;
  const { html, setHTML, money, int } = SG;
  const main = document.querySelector('main');
  const DEFAULT_CATS = ['food', 'beverages', 'dairy', 'bakery', 'household', 'personal', 'snacks', 'frozen', 'general'];
  const ADJUST_REASONS = [
    { value: 'count_correction', label: 'Stock count correction (+/−)' }, { value: 'damaged', label: 'Damaged goods (−)' },
    { value: 'expired', label: 'Expired goods (−)' }, { value: 'theft', label: 'Theft / shrinkage (−)' },
    { value: 'returned_to_supplier', label: 'Returned to supplier (−)' }, { value: 'internal_use', label: 'Internal use (−)' },
    { value: 'found', label: 'Found stock (+)' },
  ];
  let products = [], suppliers = [];
  const f = { q: SG.param('q') || '', category: '', stock: 'all' };

  setHTML(main, html`
    <div class="page-header">
      <div><h1 class="page-title">Inventory</h1><p class="page-subtitle">Products, prices and stock levels. Every change is recorded in stock movements.</p></div>
      <div class="page-actions"><button class="btn-sg btn-soft" id="exportBtn"><i class="bi bi-download"></i> Export</button><a class="btn-sg btn-soft" href="/stock.html"><i class="bi bi-arrow-left-right"></i> Movements</a><button class="btn-sg btn-forest" id="addBtn"><i class="bi bi-plus-lg"></i> Add product</button></div>
    </div>
    <div class="stats-grid" id="stats"></div>
    <div class="filters-bar">
      <div class="filter-search"><i class="bi bi-search"></i><input type="search" id="q" placeholder="Name, SKU or barcode…" value="${f.q}"></div>
      <select class="form-select-sg" id="cat" aria-label="Category"><option value="">All categories</option></select>
      <div class="chip-group" id="stockChips">${[['all', 'All stock'], ['in', 'In stock'], ['low', 'Low'], ['out', 'Out'], ['expiring', 'Expiring ≤30d']].map(([v, l]) => html`<button class="chip ${v === 'all' ? 'active' : ''}" data-stock="${v}">${l}</button>`)}</div>
    </div>
    <div class="card-sg flush"><div id="table"></div></div>`);

  const today = SG.today();
  const in30 = SG.today(30);
  const status = p => p.stock_quantity <= 0 ? 'out' : p.stock_quantity <= p.reorder_level ? 'low' : 'in';
  const expiring = p => p.expiry_date && p.expiry_date <= in30;

  const table = new SG.Table(document.getElementById('table'), {
    pageSize: 15, rows: [],
    empty: { icon: 'bi-box-seam', title: 'No products found', text: 'Add your first product or adjust the filters.' },
    onRowClick: p => history(p),
    onAction: (action, p) => ({ edit: () => editProduct(p), restock: () => restock(p), adjust: () => adjust(p), decrease: () => adjust(p, { reason: 'count_correction', quantity: -1 }), archive: () => archive(p), history: () => history(p) })[action](),
    columns: [
      { key: 'name', label: 'Product', sortable: true, render: p => html`<div class="cell-flex"><span class="thumb-icon"><i class="bi ${SG.CATEGORY_ICONS[p.category] || 'bi-box'}"></i></span><div class="min-w-0"><div class="cell-main text-truncate">${p.name}</div><div class="cell-sub mono">${p.sku}${p.barcode ? ` · ${p.barcode}` : ''}</div></div></div>` },
      { key: 'category', label: 'Category', className: 'hide-md', sortable: true, render: p => SG.titleCase(p.category) },
      { key: 'price', label: 'Price', className: 'num', sortable: true, sortValue: p => SG.toNumber(p.price), render: p => money(p.price) },
      { key: 'cost_price', label: 'Cost', className: 'num hide-md', sortable: true, sortValue: p => SG.toNumber(p.cost_price), render: p => html`${money(p.cost_price)}<div class="cell-sub">${marginPct(p)} margin</div>` },
      { key: 'stock_quantity', label: 'Stock', className: 'num', sortable: true, render: p => html`
        <div class="stock-stepper">
          <button type="button" class="step-btn" data-action="decrease" title="Reduce stock" aria-label="Reduce stock of ${p.name}" ${p.stock_quantity <= 0 ? SG.raw('disabled') : ''}><i class="bi bi-dash-lg"></i></button>
          <span class="step-val"><span class="fw-600">${int(p.stock_quantity)}</span> <span class="cell-sub">${p.unit}</span></span>
          <button type="button" class="step-btn plus" data-action="restock" title="Add stock" aria-label="Add stock to ${p.name}"><i class="bi bi-plus-lg"></i></button>
        </div>
        <div class="progress-thin mt-1" style="width:100%;max-width:120px;margin-left:auto"><div style="width:${Math.min(100, p.stock_quantity / Math.max(p.reorder_level * 2, 1) * 100)}%;background:${status(p) === 'out' ? 'var(--red)' : status(p) === 'low' ? '#e09a1d' : 'var(--emerald)'}"></div></div>
        <div class="cell-sub mt-1">Reorder at ${int(p.reorder_level)}</div>` },
      { key: 'status', label: 'Status', sortValue: p => p.stock_quantity, render: p => html`${status(p) === 'out' ? SG.badge('out', 'Out of stock') : status(p) === 'low' ? SG.badge('low', 'Low stock') : SG.badge('in', 'In stock')} ${expiring(p) ? SG.badge(p.expiry_date < today ? 'rejected' : 'pending', p.expiry_date < today ? 'Expired' : `Exp. ${SG.fmtDate(p.expiry_date)}`) : ''}` },
      { key: 'actions', label: 'Actions', className: 'actions sticky-actions', render: () => html`
        <button class="icon-action add" data-action="restock" title="Receive stock" aria-label="Receive stock"><i class="bi bi-plus-circle-fill"></i></button>
        <button class="icon-action" data-action="adjust" title="Adjust stock" aria-label="Adjust stock"><i class="bi bi-sliders"></i></button>
        <button class="icon-action" data-action="history" title="View details & history" aria-label="View details"><i class="bi bi-clock-history"></i></button>
        <button class="icon-action" data-action="edit" title="Edit" aria-label="Edit"><i class="bi bi-pencil"></i></button>
        <button class="icon-action danger" data-action="archive" title="Archive" aria-label="Archive"><i class="bi bi-archive"></i></button>` },
    ],
  });

  function marginPct(p) { const pr = SG.toNumber(p.price); return pr ? `${Math.round((pr - SG.toNumber(p.cost_price)) / pr * 100)}%` : '—'; }

  function applyFilters() {
    const q = f.q.toLowerCase();
    table.setRows(products.filter(p => (!q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || (p.barcode || '').toLowerCase().includes(q))
      && (!f.category || p.category === f.category)
      && (f.stock === 'all' || (f.stock === 'expiring' ? expiring(p) : status(p) === f.stock))));
  }
  function renderStats() {
    const cost = products.reduce((s, p) => s + SG.toNumber(p.cost_price) * p.stock_quantity, 0);
    const retail = products.reduce((s, p) => s + SG.toNumber(p.price) * p.stock_quantity, 0);
    setHTML(document.getElementById('stats'), html`
      <div class="stat-card"><div class="stat-label">Products <i class="bi bi-box-seam"></i></div><div class="stat-value">${int(products.length)}</div><div class="stat-sub">Active SKUs</div></div>
      <div class="stat-card"><div class="stat-label">Stock value (cost) <i class="bi bi-currency-exchange"></i></div><div class="stat-value">${money(cost)}</div><div class="stat-sub">Retail value ${money(retail)}</div></div>
      <div class="stat-card"><div class="stat-label">Low stock <i class="bi bi-exclamation-triangle"></i></div><div class="stat-value text-amber">${products.filter(p => status(p) === 'low').length}</div><div class="stat-sub">At or below reorder level</div></div>
      <div class="stat-card"><div class="stat-label">Out of stock <i class="bi bi-x-circle"></i></div><div class="stat-value text-red">${products.filter(p => status(p) === 'out').length}</div><div class="stat-sub">Needs restocking</div></div>
      <div class="stat-card"><div class="stat-label">Expiring ≤30 days <i class="bi bi-calendar-x"></i></div><div class="stat-value text-amber">${products.filter(expiring).length}</div><div class="stat-sub">Includes already expired</div></div>`);
    const cats = [...new Set(DEFAULT_CATS.filter(c => products.some(p => p.category === c)).concat(products.map(p => p.category)))].sort();
    const sel = document.getElementById('cat');
    setHTML(sel, html`<option value="">All categories</option>${cats.map(c => html`<option value="${c}" ${c === f.category ? SG.raw('selected') : ''}>${SG.titleCase(c)}</option>`)}`);
  }
  async function load() {
    try {
      const [p, s] = await Promise.all([SG.api.get('/products'), SG.can('suppliers') || SG.can('inventory') ? SG.api.get('/suppliers').catch(() => ({ suppliers: [] })) : { suppliers: [] }]);
      products = p.products; suppliers = s.suppliers;
      renderStats(); applyFilters();
    } catch (e) { SG.fail(e); }
  }
  function upsert(p) { const i = products.findIndex(x => x.id === p.id); if (i >= 0) products[i] = p; else products.push(p); renderStats(); applyFilters(); }

  function productFields(p) {
    const cats = [...new Set(DEFAULT_CATS.concat(products.map(x => x.category)))].sort();
    return [
      { name: 'name', label: 'Product name', required: true, maxlength: 160, placeholder: 'e.g. Rice 5kg (Royal)' },
      { name: 'sku', label: 'SKU', required: true, col: 6, maxlength: 80, placeholder: 'e.g. RIC-5K-001' },
      { name: 'barcode', label: 'Barcode', col: 6, maxlength: 80, placeholder: 'Scan or type' },
      { name: 'category', label: 'Category', col: 6, required: true, list: cats, default: 'general' },
      { name: 'unit', label: 'Unit', col: 6, list: ['unit', 'pack', 'kg', 'g', 'litre', 'crate', 'box', 'bag'], default: 'unit' },
      { name: 'price', label: 'Selling price', type: 'money', col: 6, required: true },
      { name: 'cost_price', label: 'Cost price', type: 'money', col: 6, help: 'Used for profit and stock valuation' },
      p ? null : { name: 'stock_quantity', label: 'Opening stock', type: 'number', min: 0, col: 4, default: 0 },
      { name: 'reorder_level', label: 'Reorder level', type: 'number', min: 0, col: p ? 6 : 4, default: 5 },
      { name: 'expiry_date', label: 'Expiry date', type: 'date', col: p ? 6 : 4 },
      { name: 'supplier_id', label: 'Default supplier', type: 'select', options: [{ value: '', label: '— None —' }].concat(suppliers.map(s => ({ value: s.id, label: s.name }))) },
    ].filter(Boolean);
  }
  function addProduct() {
    SG.formModal({ title: 'Add product', icon: 'bi-plus-circle', size: 'lg', fields: productFields(null), submitText: 'Save product',
      onSubmit: async v => { const { product } = await SG.api.post('/products', { ...v, supplier_id: v.supplier_id || null, expiry_date: v.expiry_date || null }); upsert(product); SG.ok(`${product.name} added.`); } });
  }
  function editProduct(p) {
    SG.formModal({ title: `Edit ${p.name}`, icon: 'bi-pencil-square', size: 'lg', fields: productFields(p), values: { ...p, supplier_id: p.supplier_id || '' }, submitText: 'Save changes',
      onSubmit: async v => { const { product } = await SG.api.patch(`/products/${p.id}`, { ...v, supplier_id: v.supplier_id || null, expiry_date: v.expiry_date || null }); upsert(product); SG.ok('Product updated.'); } });
  }
  function restock(p) {
    SG.formModal({ title: `Receive stock · ${p.name}`, icon: 'bi-box-arrow-in-down', submitText: 'Add to stock',
      intro: html`<div class="small text-muted-sg">Current stock: <b>${p.stock_quantity}</b> ${p.unit}. For supplier deliveries with paperwork, use a purchase order.</div>`,
      fields: [{ name: 'quantity', label: 'Quantity received', type: 'number', min: 1, required: true, col: 6, default: 1 }, { name: 'unit_cost', label: 'Unit cost (optional)', type: 'money', col: 6, default: p.cost_price },
        { name: 'note', label: 'Note', placeholder: 'e.g. Delivery note #123', maxlength: 255 }],
      onSubmit: async v => { const { product } = await SG.api.post(`/products/${p.id}/restock`, v); upsert(product); SG.ok(`Stock updated: ${product.stock_quantity} ${product.unit}.`); } });
  }
  function adjust(p, preset = {}) {
    SG.formModal({ title: `Adjust stock · ${p.name}`, icon: 'bi-sliders', submitText: 'Record adjustment',
      intro: html`<div class="small text-muted-sg">Current stock: <b>${p.stock_quantity}</b>. Losses (damage, expiry, theft) are flagged to security automatically.</div>`,
      fields: [{ name: 'reason', label: 'Reason', type: 'select', options: ADJUST_REASONS, required: true, default: preset.reason }, { name: 'quantity', label: 'Quantity', type: 'number', required: true, default: preset.quantity, help: 'For count corrections, use a negative number to reduce stock.' },
        { name: 'note', label: 'Details', type: 'textarea', rows: 2, max: 200 }],
      onSubmit: async v => {
        let qty = parseInt(v.quantity, 10);
        if (!qty) throw new Error('Quantity cannot be zero.');
        if (!['count_correction', 'found'].includes(v.reason)) qty = -Math.abs(qty);
        const { product } = await SG.api.post(`/products/${p.id}/adjust`, { ...v, quantity: qty });
        upsert(product); SG.ok('Adjustment recorded.');
      } });
  }
  async function archive(p) {
    if (!(await SG.confirm({ title: 'Archive product?', message: `${p.name} will be hidden from the POS and inventory. Its sales history is kept.`, confirmText: 'Archive', danger: true }))) return;
    try { await SG.api.del(`/products/${p.id}`); products = products.filter(x => x.id !== p.id); renderStats(); applyFilters(); SG.ok('Product archived.'); } catch (e) { SG.fail(e); }
  }
  async function history(p) {
    let data;
    try { data = await SG.api.get(`/products/${p.id}`); } catch (e) { SG.fail(e); return; }
    const m = SG.modal({ title: p.name, icon: 'bi-box-seam', size: 'lg',
      body: html`<div class="row g-3 mb-3">
        <div class="col-6 col-md-3"><div class="small-xs text-muted-sg">In stock</div><div class="fw-bold fs-5">${data.product.stock_quantity}</div></div>
        <div class="col-6 col-md-3"><div class="small-xs text-muted-sg">Price / cost</div><div class="fw-600">${money(data.product.price)} / ${money(data.product.cost_price)}</div></div>
        <div class="col-6 col-md-3"><div class="small-xs text-muted-sg">Supplier</div><div class="fw-600">${data.product.supplier_name || '—'}</div></div>
        <div class="col-6 col-md-3"><div class="small-xs text-muted-sg">Expiry</div><div class="fw-600">${data.product.expiry_date ? SG.fmtDate(data.product.expiry_date) : '—'}</div></div></div>
        <h3 class="h6 fw-bold">Recent stock movements</h3>
        <div class="table-wrap"><table class="table-sg"><thead><tr><th>When</th><th>Type</th><th class="num">Change</th><th class="num">After</th><th>By</th><th>Reason</th></tr></thead><tbody>
        ${data.movements.length ? data.movements.map(mv => html`<tr><td>${SG.fmtDateTime(mv.created_at)}</td><td>${SG.titleCase(mv.movement_type)}</td><td class="num ${mv.quantity < 0 ? 'text-red' : 'text-emerald'}">${mv.quantity > 0 ? '+' : ''}${mv.quantity}</td><td class="num">${mv.new_quantity}</td><td>${mv.user_name}</td><td class="small">${mv.reason}</td></tr>`) : html`<tr><td colspan="6" class="text-center text-muted-sg py-3">No movements yet</td></tr>`}
        </tbody></table></div>`,
      footer: html`<button class="btn-sg btn-soft" data-adjust><i class="bi bi-sliders"></i> Adjust</button><button class="btn-sg btn-soft" data-edit><i class="bi bi-pencil"></i> Edit</button><button class="btn-sg btn-forest" data-restock><i class="bi bi-plus-circle"></i> Receive stock</button>` });
    const then = fn => () => { m.el.addEventListener('hidden.bs.modal', () => fn(products.find(x => x.id === p.id) || p), { once: true }); m.hide(); };
    m.el.querySelector('[data-adjust]').addEventListener('click', then(adjust));
    m.el.querySelector('[data-edit]').addEventListener('click', then(editProduct));
    m.el.querySelector('[data-restock]').addEventListener('click', then(restock));
  }

  document.getElementById('q').addEventListener('input', SG.debounce(e => { f.q = e.target.value.trim(); applyFilters(); }, 150));
  document.getElementById('cat').addEventListener('change', e => { f.category = e.target.value; applyFilters(); });
  document.getElementById('stockChips').addEventListener('click', e => {
    const c = e.target.closest('[data-stock]'); if (!c) return;
    document.querySelectorAll('#stockChips .chip').forEach(x => x.classList.toggle('active', x === c));
    f.stock = c.dataset.stock; applyFilters();
  });
  document.getElementById('addBtn').addEventListener('click', addProduct);
  document.getElementById('exportBtn').addEventListener('click', () => SG.exportCSV('inventory', table.rows, [
    { label: 'Name', value: p => p.name }, { label: 'SKU', value: p => p.sku }, { label: 'Barcode', value: p => p.barcode },
    { label: 'Category', value: p => p.category }, { label: 'Unit', value: p => p.unit }, { label: 'Price', value: p => p.price },
    { label: 'Cost', value: p => p.cost_price }, { label: 'Stock', value: p => p.stock_quantity }, { label: 'Reorder level', value: p => p.reorder_level },
    { label: 'Expiry', value: p => p.expiry_date || '' }, { label: 'Supplier', value: p => p.supplier_name || '' },
  ]));

  await load();
  if (SG.param('new')) addProduct();
})();
