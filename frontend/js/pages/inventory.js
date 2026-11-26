(async function () {
  'use strict';
  const session = await SG.boot({ title: 'Inventory' });
  if (!session) return;
  const { html, setHTML, money, int } = SG;
  const main = document.querySelector('main');
  const ADJUST_REASONS = [
    { value: 'count_correction', label: 'Stock count correction (+/−)' }, { value: 'damaged', label: 'Damaged goods (−)' },
    { value: 'expired', label: 'Expired goods (−)' }, { value: 'theft', label: 'Theft / shrinkage (−)' },
    { value: 'returned_to_supplier', label: 'Returned to supplier (−)' }, { value: 'internal_use', label: 'Internal use (−)' },
    { value: 'found', label: 'Found stock (+)' },
  ];
  let products = [], suppliers = [], categories = [];
  const f = { q: SG.param('q') || '', category: '', stock: 'all' };

  setHTML(main, html`
    <div class="page-header">
      <div><h1 class="page-title">Inventory</h1><p class="page-subtitle">Products, prices and stock levels. Every change is recorded in stock movements.</p></div>
      <div class="page-actions"><button class="btn-sg btn-soft" id="importBtn"><i class="bi bi-upload"></i> Import spreadsheet</button><button class="btn-sg btn-soft" id="exportBtn"><i class="bi bi-download"></i> Export</button><a class="btn-sg btn-soft" href="/stock.html"><i class="bi bi-arrow-left-right"></i> Movements</a><button class="btn-sg btn-soft" id="categoriesBtn"><i class="bi bi-tags"></i> Categories</button><button class="btn-sg btn-soft" id="addBtn"><i class="bi bi-plus-lg"></i> Add product</button><button class="btn-sg btn-forest" id="quickBtn"><i class="bi bi-lightning-charge"></i> Quick add</button></div>
    </div>
    <div class="stats-grid" id="stats"></div>
    <div class="filters-bar">
      <div class="filter-search"><i class="bi bi-search"></i><input type="search" id="q" placeholder="Name, SKU or barcode…" value="${f.q}"></div>
      <select class="form-select-sg" id="cat" aria-label="Category"><option value="">All categories</option></select>
      <button class="btn-sg btn-soft sm" id="newCatBtn" title="Add a category"><i class="bi bi-plus-lg"></i> New category</button>
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
      { key: 'name', label: 'Product', sortable: true, render: p => html`<div class="cell-flex">${p.image ? html`<img class="thumb-icon thumb-image" src="${p.image}" alt="">` : html`<span class="thumb-icon"><i class="bi ${SG.CATEGORY_ICONS[p.category] || 'bi-box'}"></i></span>`}<div class="min-w-0"><div class="cell-main text-truncate">${p.name}</div><div class="cell-sub mono">${p.sku}${p.barcode ? ` · ${p.barcode}` : ''}</div></div></div>` },
      { key: 'category', label: 'Category', className: 'hide-md', sortable: true, render: p => (p.categories && p.categories.length ? p.categories : [p.category]).map(SG.titleCase).join(', ') },
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
      && (!f.category || (p.categories || [p.category]).includes(f.category))
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
    const cats = [...new Set(categories.map(c => c.name).concat(products.flatMap(p => p.categories && p.categories.length ? p.categories : [p.category])))].sort();
    const sel = document.getElementById('cat');
    setHTML(sel, html`<option value="">All categories</option>${cats.map(c => html`<option value="${c}" ${c === f.category ? SG.raw('selected') : ''}>${SG.titleCase(c)}</option>`)}`);
  }
  async function load() {
    try {
      const [p, s, c] = await Promise.all([SG.api.get('/products'), SG.can('suppliers') || SG.can('inventory') ? SG.api.get('/suppliers').catch(() => ({ suppliers: [] })) : { suppliers: [] }, SG.api.get('/categories').catch(() => ({ categories: [] }))]);
      products = p.products; suppliers = s.suppliers; categories = c.categories;
      renderStats(); applyFilters();
    } catch (e) { SG.fail(e); }
  }
  function upsert(p) { const i = products.findIndex(x => x.id === p.id); if (i >= 0) products[i] = p; else products.push(p); renderStats(); applyFilters(); }

  function newCategoryInline() {
    return html`<div class="input-group input-group-sm" style="max-width:360px"><input class="form-control" data-new-cat-name maxlength="80" placeholder="New category name"><button type="button" class="btn btn-outline-secondary" data-new-cat><i class="bi bi-plus-lg"></i> Add category</button></div>`;
  }
  async function createCategory(name) {
    const { category } = await SG.api.post('/categories', { name });
    categories = categories.concat({ ...category, product_count: 0 }).sort((a, b) => a.name.localeCompare(b.name));
    renderStats();
    return category;
  }
  // "Add category" inside the product form: creates it and ticks it straight away.
  document.body.addEventListener('click', async e => {
    const btn = e.target.closest('[data-new-cat]');
    if (!btn) return;
    const form = btn.closest('form');
    const input = form.querySelector('[data-new-cat-name]');
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    btn.disabled = true;
    try {
      const c = await createCategory(name);
      let list = form.querySelector('.check-list');
      if (!list) { const empty = form.querySelector('#f_category_ids'); list = document.createElement('div'); list.className = 'check-list'; list.id = 'f_category_ids'; empty.replaceWith(list); }
      const label = document.createElement('label');
      label.className = 'check-pill';
      const box = document.createElement('input'); box.type = 'checkbox'; box.name = 'category_ids'; box.value = c.id; box.checked = true;
      const text = document.createElement('span'); text.textContent = SG.titleCase(c.name);
      label.append(box, text); list.append(label);
      input.value = '';
      SG.ok(`Category ${SG.titleCase(c.name)} added.`);
    } catch (err) { SG.fail(err); } finally { btn.disabled = false; }
  });
  document.body.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.matches('[data-new-cat-name]')) { e.preventDefault(); e.stopPropagation(); e.target.closest('form').querySelector('[data-new-cat]').click(); }
  }, true);

  function productFields(p) {
    const cats = categories.map(c => ({ value: c.id, label: SG.titleCase(c.name) }));
    return [
      { name: 'image', label: 'Product image', type: 'image', col: 12, help: 'PNG, JPEG, WebP or GIF. The image is resized automatically.' },
      { name: 'name', label: 'Product name', required: true, maxlength: 160, placeholder: 'e.g. Rice 5kg (Royal)' },
      { name: 'sku', label: 'SKU', required: !!p, col: 6, maxlength: 80, placeholder: p ? 'e.g. RIC-5K-001' : 'Leave blank to auto-generate' },
      { name: 'barcode', label: 'Barcode', col: 6, maxlength: 80, placeholder: 'Scan or type' },
      { name: 'category_ids', label: 'Categories', type: 'multiselect', options: cats, col: 12, help: 'Tick every category this product belongs to.', emptyText: 'No categories yet. Create one below.' },
      { name: 'new_category', type: 'html', col: 12, html: newCategoryInline() },
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
      onSubmit: async v => { const ids = v.category_ids || []; const primary = categories.find(c => String(c.id) === String(ids[0])); const { product } = await SG.api.post('/products', { ...v, category: primary ? primary.name : 'general', category_ids: ids.map(Number), supplier_id: v.supplier_id || null, expiry_date: v.expiry_date || null }); upsert(product); SG.ok(`${product.name} added.`); } });
  }
  function editProduct(p) {
    SG.formModal({ title: `Edit ${p.name}`, icon: 'bi-pencil-square', size: 'lg', fields: productFields(p), values: { ...p, category_ids: p.category_ids || [], supplier_id: p.supplier_id || '' }, submitText: 'Save changes',
      onSubmit: async v => { const ids = v.category_ids || []; const primary = categories.find(c => String(c.id) === String(ids[0])); const { product } = await SG.api.patch(`/products/${p.id}`, { ...v, category: primary ? primary.name : p.category, category_ids: ids.map(Number), supplier_id: v.supplier_id || null, expiry_date: v.expiry_date || null }); upsert(product); SG.ok('Product updated.'); } });
  }
  function quickAdd() {
    const catOptions = () => html`<option value="">— None —</option>${categories.map(c => html`<option value="${c.id}">${SG.titleCase(c.name)}</option>`)}<option value="__new">+ New category…</option>`;
    const m = SG.modal({ title: 'Quick add products', icon: 'bi-lightning-charge', size: 'xl',
      body: html`<p class="small text-muted-sg mb-3">Type the details and press <b>Enter</b> to save. The form clears so you can add the next item straight away. SKUs are generated automatically.</p>
        <form class="row g-2 align-items-end" data-quick novalidate>
          <div class="col-12 col-md-3"><label class="form-label">Product name <span class="text-red">*</span></label><input class="form-control" name="name" maxlength="160" placeholder="e.g. Rice 5kg" autocomplete="off"></div>
          <div class="col-6 col-md-2"><label class="form-label">Barcode</label><input class="form-control" name="barcode" maxlength="80" placeholder="Scan (optional)" autocomplete="off"></div>
          <div class="col-6 col-md-2"><label class="form-label">Category</label><select class="form-select" name="category">${catOptions()}</select></div>
          <div class="col-4 col-md-1"><label class="form-label">Price <span class="text-red">*</span></label><input class="form-control" name="price" type="number" step="0.01" min="0"></div>
          <div class="col-4 col-md-1"><label class="form-label">Cost</label><input class="form-control" name="cost_price" type="number" step="0.01" min="0"></div>
          <div class="col-4 col-md-1"><label class="form-label">Qty</label><input class="form-control" name="stock_quantity" type="number" min="0" value="0"></div>
          <div class="col-12 col-md-2"><button type="submit" class="btn-sg btn-forest w-100"><i class="bi bi-plus-lg"></i> Add</button></div>
        </form>
        <div class="notice danger mt-2 d-none" data-error></div>
        <div class="mt-3" data-added><div class="small text-muted-sg">Items you add will appear here.</div></div>`,
      footer: html`<button type="button" class="btn-sg btn-soft" data-bs-dismiss="modal">Done</button>` });
    const form = m.el.querySelector('[data-quick]');
    const err = m.el.querySelector('[data-error]');
    const added = [];
    m.el.addEventListener('shown.bs.modal', () => form.elements.name.focus());
    form.elements.category.addEventListener('change', async e => {
      if (e.target.value !== '__new') return;
      const name = await SG.confirm({ title: 'New category', confirmText: 'Create', input: { label: 'Category name', max: 80, required: true } });
      if (!name) { e.target.value = ''; return; }
      try { const c = await createCategory(name); setHTML(e.target, catOptions()); e.target.value = String(c.id); } catch (ex) { SG.fail(ex); e.target.value = ''; }
    });
    // Barcode scanners usually send Enter: jump to the price instead of submitting a half-filled row.
    form.elements.barcode.addEventListener('keydown', e => { if (e.key === 'Enter' && !form.elements.price.value) { e.preventDefault(); form.elements.price.focus(); } });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      err.classList.add('d-none');
      const v = Object.fromEntries(new FormData(form));
      const fail = (msg, field) => { err.textContent = msg; err.classList.remove('d-none'); form.elements[field].focus(); };
      if (!v.name.trim()) return fail('Product name is required.', 'name');
      if (v.price === '') return fail('Price is required.', 'price');
      const cat = categories.find(c => String(c.id) === v.category);
      const btn = form.querySelector('[type=submit]'); btn.disabled = true;
      try {
        const { product } = await SG.api.post('/products', { name: v.name.trim(), barcode: v.barcode.trim(), price: v.price, cost_price: v.cost_price || null,
          stock_quantity: Number(v.stock_quantity) || 0, category: cat ? cat.name : 'general', category_ids: cat ? [cat.id] : [] });
        upsert(product);
        added.unshift(product);
        setHTML(m.el.querySelector('[data-added]'), html`<div class="form-label">Added (${added.length})</div>${added.map(x => html`<div class="list-row"><div class="main"><div class="fw-600">${x.name}</div><div class="meta mono">${x.sku} · ${(x.categories || []).map(SG.titleCase).join(', ')}</div></div><div class="text-end"><div>${money(x.price)}</div><div class="cell-sub">${int(x.stock_quantity)} in stock</div></div></div>`)}`);
        const keepCat = v.category;
        form.reset();
        form.elements.category.value = keepCat; // keep the same category for the next item
        form.elements.name.focus();
      } catch (ex) { fail(ex.message || 'Could not save product.', 'name'); } finally { btn.disabled = false; }
    });
  }
  // ---------------------------------------------------------------- spreadsheet import
  const IMPORT_FIELDS = [
    { key: 'name', label: 'Product name', aliases: ['name', 'product', 'product name', 'item', 'item name', 'description', 'title', 'product description'] },
    { key: 'sku', label: 'SKU / code', aliases: ['sku', 'code', 'item code', 'product code', 'ref', 'reference', 'item no', 'item number'] },
    { key: 'barcode', label: 'Barcode', aliases: ['barcode', 'bar code', 'upc', 'ean', 'gtin'] },
    { key: 'category', label: 'Category', aliases: ['category', 'categories', 'group', 'department', 'type', 'section'] },
    { key: 'unit', label: 'Unit', aliases: ['unit', 'uom', 'unit of measure', 'measure'] },
    { key: 'price', label: 'Selling price', aliases: ['price', 'selling price', 'sale price', 'retail price', 'unit price', 'sp', 'sell price', 'retail'] },
    { key: 'cost_price', label: 'Cost price', aliases: ['cost', 'cost price', 'buying price', 'purchase price', 'cp', 'unit cost', 'buy price'] },
    { key: 'stock_quantity', label: 'Quantity in stock', aliases: ['qty', 'quantity', 'stock', 'stock quantity', 'on hand', 'quantity on hand', 'qty on hand', 'count', 'stock level', 'balance'] },
    { key: 'reorder_level', label: 'Reorder level', aliases: ['reorder', 'reorder level', 'reorder point', 'min stock', 'minimum', 'min qty'] },
    { key: 'expiry_date', label: 'Expiry date', aliases: ['expiry', 'expiry date', 'expires', 'exp date', 'exp', 'best before', 'expiration', 'expiration date'] },
  ];
  const normHeader = h => String(h ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  let xlsxLoading = null;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    xlsxLoading = xlsxLoading || new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = '/vendor/xlsx/xlsx.full.min.js';
      tag.onload = () => resolve(window.XLSX);
      tag.onerror = () => { xlsxLoading = null; reject(new Error('Could not load the spreadsheet reader. Reload the page and try again.')); };
      document.head.appendChild(tag);
    });
    return xlsxLoading;
  }
  function cellText(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) {
      if (isNaN(v)) return '';
      const pad = n => String(n).padStart(2, '0');
      return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
    }
    // Long barcodes come through as numbers; write them out in full rather than as 6.0012E+12.
    if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 0 }) : String(v);
    return String(v).replace(/^'/, '').trim();
  }
  function guessMapping(headers) {
    const norm = headers.map(normHeader), map = {}, used = new Set();
    for (const pass of ['exact', 'contains']) {
      for (const f of IMPORT_FIELDS) {
        if (map[f.key] !== undefined) continue;
        const i = norm.findIndex((h, idx) => !used.has(idx) && h && f.aliases.some(a => pass === 'exact' ? h === a : (h.includes(a) && a.length > 2)));
        if (i >= 0) { map[f.key] = i; used.add(i); }
      }
    }
    return map;
  }
  function downloadTemplate() {
    SG.exportCSV('inventory_template', [
      { name: 'Rice 5kg (Royal)', sku: '', barcode: '6001234567890', category: 'Food, Grains', unit: 'bag', price: '85.00', cost: '60.00', qty: 20, reorder: 5, expiry: '2027-06-30' },
      { name: 'Coca-Cola 500ml', sku: 'COKE-500', barcode: '', category: 'Drinks', unit: 'unit', price: '8.50', cost: '6.00', qty: 48, reorder: 12, expiry: '' },
    ], [
      { label: 'Name', value: r => r.name }, { label: 'SKU', value: r => r.sku }, { label: 'Barcode', value: r => r.barcode },
      { label: 'Category', value: r => r.category }, { label: 'Unit', value: r => r.unit }, { label: 'Price', value: r => r.price },
      { label: 'Cost', value: r => r.cost }, { label: 'Stock', value: r => r.qty }, { label: 'Reorder level', value: r => r.reorder },
      { label: 'Expiry', value: r => r.expiry },
    ]);
  }

  function importSpreadsheet() {
    const m = SG.modal({ title: 'Import inventory from a spreadsheet', icon: 'bi-file-earmark-spreadsheet', size: 'xl',
      body: html`<div data-step></div>`,
      footer: html`<button type="button" class="btn-sg btn-soft" data-bs-dismiss="modal">Cancel</button>
        <button type="button" class="btn-sg btn-soft d-none" data-check><i class="bi bi-search"></i> Check file</button>
        <button type="button" class="btn-sg btn-forest d-none" data-run><i class="bi bi-upload"></i> Import</button>` });
    const step = m.el.querySelector('[data-step]');
    const checkBtn = m.el.querySelector('[data-check]');
    const runBtn = m.el.querySelector('[data-run]');
    const st = { workbook: null, sheet: '', headers: [], data: [], map: {}, stockMode: 'set', fileName: '' };

    function chooseFile() {
      checkBtn.classList.add('d-none'); runBtn.classList.add('d-none');
      setHTML(step, html`
        <div class="notice mb-3"><i class="bi bi-info-circle"></i><div>Upload an <b>Excel (.xlsx, .xls)</b>, <b>CSV</b> or <b>OpenDocument (.ods)</b> file with one product per row and a header row such as <i>Name, Price, Cost, Stock, Category, Barcode</i>. You'll match the columns and preview everything before anything is saved.
          <div class="mt-2"><button type="button" class="btn-sg btn-soft sm" data-template><i class="bi bi-download"></i> Download template</button></div></div></div>
        <label class="d-block border rounded-3 p-4 text-center" style="border-style:dashed!important;cursor:pointer" data-drop>
          <i class="bi bi-cloud-arrow-up" style="font-size:2rem"></i>
          <div class="fw-600 mt-1">Click to choose a file, or drag it here</div>
          <div class="small text-muted-sg">.xlsx, .xls, .csv, .ods</div>
          <input type="file" class="d-none" accept=".xlsx,.xls,.xlsm,.csv,.ods,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" data-file>
        </label>
        <div class="notice danger mt-3 d-none" data-error></div>`);
      step.querySelector('[data-template]').addEventListener('click', e => { e.preventDefault(); downloadTemplate(); });
      const drop = step.querySelector('[data-drop]');
      const input = step.querySelector('[data-file]');
      input.addEventListener('change', () => input.files[0] && readFile(input.files[0]));
      drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('bg-light'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('bg-light'));
      drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('bg-light'); if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]); });
    }
    const showError = msg => { const box = step.querySelector('[data-error]'); if (box) { box.textContent = msg; box.classList.remove('d-none'); } else SG.fail(new Error(msg)); };

    async function readFile(file) {
      if (file.size > 10 * 1024 * 1024) return showError('That file is larger than 10 MB. Split it into smaller files.');
      try {
        const XLSX = await loadXlsx();
        st.workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
        st.fileName = file.name;
        if (!st.workbook.SheetNames.length) return showError('That file has no sheets.');
        loadSheet(st.workbook.SheetNames[0]);
      } catch (e) { showError(e.message && !/^Unsupported/.test(e.message) ? e.message : 'That file could not be read. Save it as .xlsx or .csv and try again.'); }
    }
    function loadSheet(name) {
      st.sheet = name;
      const rows = XLSX.utils.sheet_to_json(st.workbook.Sheets[name], { header: 1, raw: true, defval: '', blankrows: false });
      // The header is the first row with at least two filled cells (skips titles above the table).
      const headerIndex = rows.findIndex(r => r.filter(c => cellText(c) !== '').length >= 2);
      if (headerIndex < 0) { st.headers = []; st.data = []; }
      else {
        st.headers = rows[headerIndex].map((h, i) => cellText(h) || `Column ${i + 1}`);
        st.data = rows.slice(headerIndex + 1).filter(r => r.some(c => cellText(c) !== ''));
      }
      st.map = guessMapping(st.headers);
      renderMapping();
    }
    function mappedRows() {
      return st.data.map(r => Object.fromEntries(IMPORT_FIELDS.filter(f => st.map[f.key] !== undefined).map(f => [f.key, cellText(r[st.map[f.key]])])))
        .filter(r => Object.values(r).some(v => v !== ''));
    }
    function renderMapping() {
      runBtn.classList.add('d-none');
      checkBtn.classList.remove('d-none');
      const rows = mappedRows();
      const cols = IMPORT_FIELDS.filter(f => st.map[f.key] !== undefined);
      setHTML(step, html`
        <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
          <i class="bi bi-file-earmark-spreadsheet text-forest"></i><b>${st.fileName}</b>
          <span class="text-muted-sg small">${rows.length} product row${rows.length === 1 ? '' : 's'} found</span>
          ${st.workbook.SheetNames.length > 1 ? html`<select class="form-select form-select-sm" style="width:auto" data-sheet aria-label="Sheet">${st.workbook.SheetNames.map(n => html`<option ${n === st.sheet ? SG.raw('selected') : ''}>${n}</option>`)}</select>` : ''}
          <button type="button" class="btn-sg btn-soft sm ms-auto" data-other><i class="bi bi-arrow-repeat"></i> Choose another file</button>
        </div>
        ${!st.headers.length ? html`<div class="notice danger">No table was found in this sheet. Make sure the first row has column headings.</div>` : html`
        <div class="form-label">1. Match your columns</div>
        <div class="row g-2 mb-3">${IMPORT_FIELDS.map(f => html`<div class="col-6 col-md-4 col-lg-3"><label class="small text-muted-sg" for="map_${f.key}">${f.label}${f.key === 'name' || f.key === 'price' ? html` <span class="text-red">*</span>` : ''}</label>
          <select class="form-select form-select-sm" id="map_${f.key}" data-map="${f.key}"><option value="">— Not in file —</option>${st.headers.map((h, i) => html`<option value="${i}" ${st.map[f.key] === i ? SG.raw('selected') : ''}>${h}</option>`)}</select></div>`)}</div>
        <div class="form-label">2. What does the quantity column mean for products you already have?</div>
        <div class="d-flex flex-wrap gap-3 mb-3 small">
          <label><input type="radio" name="stockMode" value="set" ${st.stockMode === 'set' ? SG.raw('checked') : ''}> <b>Stock count</b>: set stock to this number</label>
          <label><input type="radio" name="stockMode" value="add" ${st.stockMode === 'add' ? SG.raw('checked') : ''}> <b>New delivery</b>: add this number to current stock</label>
        </div>
        <div class="form-label">3. Preview <span class="text-muted-sg small fw-normal">(first 8 rows)</span></div>
        ${cols.length ? html`<div class="table-responsive border rounded-3"><table class="table table-sm mb-0 small"><thead><tr><th>#</th>${cols.map(f => html`<th>${f.label}</th>`)}</tr></thead>
          <tbody>${rows.slice(0, 8).map((r, i) => html`<tr><td class="text-muted-sg">${i + 1}</td>${cols.map(f => html`<td>${r[f.key]}</td>`)}</tr>`)}</tbody></table></div>`
          : html`<div class="notice warn">Match at least the product name column to continue.</div>`}
        <p class="small text-muted-sg mt-2 mb-0">Existing products are matched by SKU, then barcode, then name and updated. Everything else is added as a new product. Empty cells never overwrite existing values, and new categories are created automatically (separate several with commas).</p>`}
        <div data-result class="mt-3"></div>`);
      step.querySelector('[data-other]').addEventListener('click', chooseFile);
      const sheetSel = step.querySelector('[data-sheet]');
      if (sheetSel) sheetSel.addEventListener('change', () => loadSheet(sheetSel.value));
      step.querySelectorAll('[data-map]').forEach(sel => sel.addEventListener('change', () => {
        if (sel.value === '') delete st.map[sel.dataset.map]; else st.map[sel.dataset.map] = Number(sel.value);
        renderMapping();
      }));
      step.querySelectorAll('[name=stockMode]').forEach(r => r.addEventListener('change', () => { st.stockMode = r.value; runBtn.classList.add('d-none'); setHTML(step.querySelector('[data-result]'), ''); }));
      checkBtn.disabled = !st.headers.length || st.map.name === undefined && st.map.sku === undefined && st.map.barcode === undefined || !rows.length;
    }
    async function send(dryRun) {
      const rows = mappedRows();
      const btn = dryRun ? checkBtn : runBtn;
      btn.disabled = true;
      try {
        // Send in batches so big sheets stay under the server's request size limit.
        const res = { created: 0, updated: 0, failed: 0, results: [] };
        for (let start = 0; start < rows.length; start += 1000) {
          if (!dryRun && rows.length > 1000) setHTML(runBtn, html`<span class="spinner-border spinner-border-sm"></span> Importing ${Math.min(start + 1000, rows.length)} / ${rows.length}`);
          const part = await SG.api.post('/products/import', { rows: rows.slice(start, start + 1000), stock_mode: st.stockMode, dry_run: dryRun });
          res.created += part.created; res.updated += part.updated; res.failed += part.failed;
          res.results.push(...part.results.map(r => ({ ...r, row: r.row + start })));
        }
        if (!dryRun) {
          m.hide();
          await load();
          SG.ok(`Import finished: ${res.created} added, ${res.updated} updated${res.failed ? `, ${res.failed} skipped` : ''}.`);
          return;
        }
        const failed = res.results.filter(r => r.status === 'failed');
        setHTML(step.querySelector('[data-result]'), html`
          <div class="d-flex flex-wrap gap-2 mb-2">
            ${SG.badge('in', `${res.created} new`)} ${SG.badge('pending', `${res.updated} will be updated`)} ${res.failed ? SG.badge('rejected', `${res.failed} with problems`) : ''}
          </div>
          ${failed.length ? html`<div class="notice warn mb-2"><i class="bi bi-exclamation-triangle"></i><div>These rows will be <b>skipped</b>. Fix them in your file and import again, or continue without them.</div></div>
            <div class="table-responsive border rounded-3" style="max-height:220px"><table class="table table-sm mb-0 small"><thead><tr><th>Row</th><th>Product</th><th>Problem</th></tr></thead>
            <tbody>${failed.map(r => html`<tr><td>${r.row}</td><td>${r.name || '—'}</td><td class="text-red">${r.error}</td></tr>`)}</tbody></table></div>`
            : html`<div class="notice"><i class="bi bi-check-circle"></i><div>Everything looks good. Nothing has been saved yet. Click <b>Import</b> to apply.</div></div>`}`);
        const ok = res.created + res.updated;
        runBtn.classList.toggle('d-none', !ok);
        setHTML(runBtn, html`<i class="bi bi-upload"></i> Import ${ok} product${ok === 1 ? '' : 's'}`);
      } catch (e) { SG.fail(e); } finally { btn.disabled = false; }
    }
    checkBtn.addEventListener('click', () => send(true));
    runBtn.addEventListener('click', () => send(false));
    chooseFile();
  }

  function manageCategories() {
    const m = SG.modal({ title: 'Product categories', icon: 'bi-tags', size: 'lg',
      body: html`<div class="d-flex justify-content-end mb-3"><button class="btn-sg btn-forest" data-add-category><i class="bi bi-plus-lg"></i> Add category</button></div><div data-category-list></div>` });
    const paint = () => setHTML(m.el.querySelector('[data-category-list]'), html`${categories.length ? categories.map(c => html`<div class="list-row"><div class="main"><div class="fw-600">${SG.titleCase(c.name)}</div><div class="meta">${c.product_count} product${c.product_count === 1 ? '' : 's'}</div></div><button class="btn-sg btn-soft sm" data-edit-category="${c.id}"><i class="bi bi-pencil"></i> Edit</button><button class="icon-action danger" data-delete-category="${c.id}" aria-label="Delete ${c.name}"><i class="bi bi-trash3"></i></button></div>`) : html`<div class="empty-state"><i class="bi bi-tags"></i><div class="title">No categories yet</div></div>`}`);
    const edit = c => SG.formModal({ title: c ? `Edit ${SG.titleCase(c.name)}` : 'Add category', icon: 'bi-tags', fields: [{ name: 'name', label: 'Category name', required: true, maxlength: 80 }], values: { name: c ? c.name : '' },
      onSubmit: async v => { await (c ? SG.api.patch(`/categories/${c.id}`, v) : SG.api.post('/categories', v)); await load(); paint(); SG.ok(c ? 'Category updated.' : 'Category added.'); } });
    m.el.addEventListener('click', async e => {
      const add = e.target.closest('[data-add-category]'); const editBtn = e.target.closest('[data-edit-category]'); const del = e.target.closest('[data-delete-category]');
      if (add) edit(null);
      if (editBtn) edit(categories.find(c => c.id === Number(editBtn.dataset.editCategory)));
      if (del && await SG.confirm({ title: 'Delete category?', message: 'It must not be assigned to any products.', confirmText: 'Delete', danger: true })) {
        try { await SG.api.del(`/categories/${del.dataset.deleteCategory}`); await load(); paint(); SG.ok('Category deleted.'); } catch (err) { SG.fail(err); }
      }
    });
    paint();
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
  document.getElementById('categoriesBtn').addEventListener('click', manageCategories);
  document.getElementById('quickBtn').addEventListener('click', quickAdd);
  document.getElementById('importBtn').addEventListener('click', importSpreadsheet);
  document.getElementById('newCatBtn').addEventListener('click', async () => {
    const name = await SG.confirm({ title: 'New category', confirmText: 'Create', input: { label: 'Category name', max: 80, required: true } });
    if (!name) return;
    try { const c = await createCategory(name); SG.ok(`Category ${SG.titleCase(c.name)} added.`); } catch (ex) { SG.fail(ex); }
  });
  document.getElementById('exportBtn').addEventListener('click', () => SG.exportCSV('inventory', table.rows, [
    { label: 'Name', value: p => p.name }, { label: 'SKU', value: p => p.sku }, { label: 'Barcode', value: p => p.barcode },
    { label: 'Category', value: p => (p.categories && p.categories.length ? p.categories : [p.category]).join(', ') }, { label: 'Unit', value: p => p.unit }, { label: 'Price', value: p => p.price },
    { label: 'Cost', value: p => p.cost_price }, { label: 'Stock', value: p => p.stock_quantity }, { label: 'Reorder level', value: p => p.reorder_level },
    { label: 'Expiry', value: p => p.expiry_date || '' }, { label: 'Supplier', value: p => p.supplier_name || '' },
  ]));

  await load();
  if (SG.param('new')) addProduct();
})();
