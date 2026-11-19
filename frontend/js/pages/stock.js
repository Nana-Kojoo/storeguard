(async function () {
  'use strict';
  const session = await SG.boot({ title: 'Stock Movements' });
  if (!session) return;
  const { html, setHTML } = SG;
  const TYPES = { opening_stock: 'Opening stock', supplier_delivery: 'Delivery / restock', sale: 'Sale', refund_return: 'Refund return', adjustment: 'Manual edit',
    count_correction: 'Count correction', damaged: 'Damaged', expired: 'Expired', theft: 'Theft / shrinkage', returned_to_supplier: 'Returned to supplier', internal_use: 'Internal use', found: 'Found stock' };
  const f = { start: SG.today(-29), end: SG.today(), type: '', direction: '', q: '' };
  const main = document.querySelector('main');

  setHTML(main, html`
    <div class="page-header">
      <div><h1 class="page-title">Stock Movements</h1><p class="page-subtitle">A permanent ledger of every unit that entered or left your store, and who moved it.</p></div>
      <div class="page-actions"><button class="btn-sg btn-soft" id="exportBtn"><i class="bi bi-download"></i> Export</button>${SG.can('inventory') ? html`<a class="btn-sg btn-forest" href="/inventory.html"><i class="bi bi-box-seam"></i> Inventory</a>` : ''}</div>
    </div>
    <div class="filters-bar">
      <div class="filter-search"><i class="bi bi-search"></i><input type="search" id="q" placeholder="Product, SKU or reference…"></div>
      <select class="form-select-sg" id="type" aria-label="Movement type"><option value="">All types</option>${Object.entries(TYPES).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select>
      <div class="chip-group" id="dir"><button class="chip active" data-dir="">All</button><button class="chip" data-dir="in">Stock in</button><button class="chip" data-dir="out">Stock out</button></div>
      <div class="d-flex gap-1 align-items-center"><input type="date" class="form-input-sg" id="start" value="${f.start}" aria-label="From"><span class="small text-muted-sg">to</span><input type="date" class="form-input-sg" id="end" value="${f.end}" aria-label="To"></div>
    </div>
    <div class="card-sg flush"><div id="table"></div></div>`);

  const params = () => ({ start: f.start, end: f.end, type: f.type, direction: f.direction, q: f.q });
  const table = new SG.Table(document.getElementById('table'), {
    pageSize: 50,
    load: ({ page, perPage }) => SG.api.get('/stock-movements', { ...params(), page, per_page: perPage }),
    empty: { icon: 'bi-arrow-left-right', title: 'No movements in this period' },
    columns: [
      { key: 'created_at', label: 'When', render: m => SG.fmtDateTime(m.created_at) },
      { key: 'product_name', label: 'Product', render: m => html`<div class="cell-main">${m.product_name}</div><div class="cell-sub mono">${m.sku}</div>` },
      { key: 'movement_type', label: 'Type', render: m => html`<span class="badge-st ${m.quantity < 0 ? (['damaged', 'expired', 'theft'].includes(m.movement_type) ? 'red' : 'gray') : 'green'}">${TYPES[m.movement_type] || SG.titleCase(m.movement_type)}</span>` },
      { key: 'quantity', label: 'Change', className: 'num', render: m => html`<span class="fw-600 ${m.quantity < 0 ? 'text-red' : 'text-emerald'}">${m.quantity > 0 ? '+' : ''}${m.quantity}</span>` },
      { key: 'balance', label: 'Before → after', className: 'num', render: m => `${m.previous_quantity} → ${m.new_quantity}` },
      { key: 'user_name', label: 'By' },
      { key: 'reason', label: 'Reason / reference', render: m => html`<span class="small">${m.reason}</span>${m.reference ? html`<div class="cell-sub mono">${m.reference}</div>` : ''}` },
    ],
  });
  const reload = SG.debounce(() => table.reload(true), 250);
  document.getElementById('q').addEventListener('input', e => { f.q = e.target.value.trim(); reload(); });
  document.getElementById('type').addEventListener('change', e => { f.type = e.target.value; reload(); });
  ['start', 'end'].forEach(id => document.getElementById(id).addEventListener('change', e => { f[id] = e.target.value; reload(); }));
  document.getElementById('dir').addEventListener('click', e => {
    const c = e.target.closest('[data-dir]'); if (!c) return;
    document.querySelectorAll('#dir .chip').forEach(x => x.classList.toggle('active', x === c));
    f.direction = c.dataset.dir; reload();
  });
  document.getElementById('exportBtn').addEventListener('click', async () => {
    try {
      const res = await SG.api.get('/stock-movements', { ...params(), page: 1, per_page: 200 });
      SG.exportCSV('stock_movements', res.items, [
        { label: 'Date', value: m => SG.fmtDateTime(m.created_at) }, { label: 'Product', value: m => m.product_name }, { label: 'SKU', value: m => m.sku },
        { label: 'Type', value: m => TYPES[m.movement_type] || m.movement_type }, { label: 'Change', value: m => m.quantity },
        { label: 'Before', value: m => m.previous_quantity }, { label: 'After', value: m => m.new_quantity }, { label: 'By', value: m => m.user_name },
        { label: 'Reason', value: m => m.reason }, { label: 'Reference', value: m => m.reference },
      ]);
      if (res.total > 200) SG.toast('Exported the latest 200 movements. Narrow the date range for older records.', 'info');
    } catch (e) { SG.fail(e); }
  });
})();
