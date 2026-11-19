(async function () {
  'use strict';
  const session = await SG.boot({ title: 'Reports & Analytics' });
  if (!session) return;
  const { html, setHTML, money, int } = SG;
  const main = document.querySelector('main');
  const f = { start: SG.today(-6), end: SG.today() };
  let charts = [], report = null, inventory = null;

  setHTML(main, html`
    <div class="page-header">
      <div><h1 class="page-title">Reports & Analytics</h1><p class="page-subtitle">Profit and loss, sales trends, product performance and staff accountability.</p></div>
      <div class="page-actions"><button class="btn-sg btn-soft" id="printBtn"><i class="bi bi-printer"></i> Print</button></div>
    </div>
    <div class="filters-bar no-print"><div class="chip-group" id="range"></div>
      <div class="d-flex gap-1 align-items-center"><input type="date" class="form-input-sg" id="start" value="${f.start}" aria-label="From"><span class="small text-muted-sg">to</span><input type="date" class="form-input-sg" id="end" value="${f.end}" aria-label="To"></div></div>
    <div id="report" class="print-area"><div class="skeleton" style="height:300px"></div></div>`);

  function card(title, icon, body, extra = '') { return html`<div class="card-sg h-100"><div class="card-head"><h2 class="card-title"><i class="bi ${icon}"></i> ${title}</h2>${extra}</div>${body}</div>`; }
  function exportBtn(id) { return html`<button class="btn-sg btn-soft sm no-print" data-export="${id}"><i class="bi bi-download"></i> CSV</button>`; }

  function render() {
    charts.forEach(c => c.destroy()); charts = [];
    const r = report, t = r.totals;
    const hasSales = t.transactions > 0;
    setHTML(document.getElementById('report'), html`
      <div class="small text-muted-sg mb-2">Period: <b>${SG.fmtDate(r.range.start)} – ${SG.fmtDate(r.range.end)}</b> · ${session.business.name}</div>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Net sales <i class="bi bi-currency-exchange"></i></div><div class="stat-value">${money(t.net_sales)}</div><div class="stat-sub">Gross ${money(t.revenue)} − refunds − tax</div></div>
        <div class="stat-card"><div class="stat-label">Gross profit <i class="bi bi-graph-up-arrow"></i></div><div class="stat-value">${money(t.gross_profit)}</div><div class="stat-sub">Margin ${t.gross_margin_pct}%</div></div>
        <div class="stat-card"><div class="stat-label">Net profit <i class="bi bi-piggy-bank"></i></div><div class="stat-value ${SG.toNumber(t.net_profit) < 0 ? 'text-red' : 'text-emerald'}">${money(t.net_profit)}</div><div class="stat-sub">After ${money(t.expenses)} expenses</div></div>
        <div class="stat-card"><div class="stat-label">Transactions <i class="bi bi-receipt"></i></div><div class="stat-value">${int(t.transactions)}</div><div class="stat-sub">Avg. basket ${money(t.avg_basket)} · ${int(t.items_sold)} items</div></div>
      </div>
      <div class="row grid-gap mb-3">
        <div class="col-lg-8">${card('Revenue & gross profit by day', 'bi-graph-up', html`<div class="legend" id="lgTrend"></div><div class="chart-box"><canvas id="cTrend" role="img" aria-label="Daily revenue and gross profit"></canvas></div>`, exportBtn('series'))}</div>
        <div class="col-lg-4">${card('Profit & loss', 'bi-journal-text', html`
          <div class="kv-row"><span class="k">Gross sales</span><span class="v">${money(t.revenue)}</span></div>
          <div class="kv-row"><span class="k">− Refunds</span><span class="v">${money(-SG.toNumber(t.refunds))}</span></div>
          <div class="kv-row"><span class="k">− Tax collected</span><span class="v">${money(-SG.toNumber(t.tax))}</span></div>
          <div class="kv-row total"><span class="k">Net sales</span><span class="v">${money(t.net_sales)}</span></div>
          <div class="kv-row"><span class="k">− Cost of goods sold</span><span class="v">${money(-SG.toNumber(t.cogs))}</span></div>
          <div class="kv-row total"><span class="k">Gross profit</span><span class="v">${money(t.gross_profit)}</span></div>
          <div class="kv-row"><span class="k">− Operating expenses</span><span class="v">${money(-SG.toNumber(t.expenses))}</span></div>
          <div class="kv-row total"><span class="k">Net profit</span><span class="v ${SG.toNumber(t.net_profit) < 0 ? 'text-red' : 'text-emerald'}">${money(t.net_profit)}</span></div>
          <div class="small-xs text-muted-sg mt-2">Discounts given: ${money(t.discounts)} (already deducted from gross sales).</div>`)}</div>
      </div>
      <div class="row grid-gap mb-3">
        <div class="col-lg-4">${card('Sales by payment method', 'bi-credit-card', r.by_payment.length ? html`<div class="chart-box sm"><canvas id="cPay" role="img" aria-label="Sales by payment method"></canvas></div>` : empty())}</div>
        <div class="col-lg-4">${card('Sales by category', 'bi-tags', r.by_category.length ? html`<div class="chart-box sm"><canvas id="cCat" role="img" aria-label="Sales by category"></canvas></div>` : empty())}</div>
        <div class="col-lg-4">${card('Busiest hours', 'bi-clock', hasSales ? html`<div class="chart-box sm"><canvas id="cHour" role="img" aria-label="Transactions by hour of day"></canvas></div>` : empty())}</div>
      </div>
      <div class="row grid-gap mb-3">
        <div class="col-lg-7"><div class="card-sg flush h-100"><div class="card-head"><h2 class="card-title"><i class="bi bi-trophy"></i> Top products</h2>${exportBtn('products')}</div><div id="tProducts"></div></div></div>
        <div class="col-lg-5"><div class="card-sg flush h-100"><div class="card-head"><h2 class="card-title"><i class="bi bi-people"></i> Staff performance</h2>${exportBtn('cashiers')}</div><div id="tCashiers"></div></div></div>
      </div>
      ${r.expenses_by_category.length ? html`<div class="card-sg mb-3"><div class="card-head"><h2 class="card-title"><i class="bi bi-wallet2"></i> Expenses by category</h2></div>${r.expenses_by_category.map(c => html`<div class="bar-row"><span>${c.category}</span><div class="bar-track"><div class="bar-fill" style="width:${SG.toNumber(c.total) / SG.toNumber(r.expenses_by_category[0].total) * 100}%"></div></div><span class="fw-600 tabular">${money(c.total)}</span></div>`)}</div>` : ''}
      <div id="invSection"></div>`);

    SG.legend(document.getElementById('lgTrend'), [{ label: 'Revenue', color: SG.SERIES[0], line: true }, { label: 'Gross profit', color: SG.SERIES[1], line: true }]);
    charts.push(SG.lineChart(document.getElementById('cTrend'), { labels: r.series.map(s => SG.fmtDay(s.date)), series: [
      { label: 'Revenue', data: r.series.map(s => SG.toNumber(s.revenue)) }, { label: 'Gross profit', data: r.series.map(s => SG.toNumber(s.profit)) }] }));
    if (r.by_payment.length) charts.push(SG.barChart(document.getElementById('cPay'), { horizontal: true, labels: r.by_payment.map(p => SG.paymentLabel(p.method)), series: [{ label: 'Sales', data: r.by_payment.map(p => SG.toNumber(p.total)) }] }));
    if (r.by_category.length) charts.push(SG.barChart(document.getElementById('cCat'), { horizontal: true, labels: r.by_category.slice(0, 8).map(c => SG.titleCase(c.category)), series: [{ label: 'Sales', data: r.by_category.slice(0, 8).map(c => SG.toNumber(c.total)) }] }));
    if (hasSales) {
      const hours = r.by_hour.filter(h => h.hour >= 5 && h.hour <= 23);
      charts.push(SG.barChart(document.getElementById('cHour'), { money: false, labels: hours.map(h => `${String(h.hour).padStart(2, '0')}:00`), series: [{ label: 'Transactions', data: hours.map(h => h.txns) }] }));
    }
    new SG.Table(document.getElementById('tProducts'), { rows: r.top_products, pageSize: 10, empty: { icon: 'bi-box', title: 'No products sold in this period' },
      columns: [{ key: 'name', label: 'Product', sortable: true }, { key: 'quantity', label: 'Units', className: 'num', sortable: true },
        { key: 'revenue', label: 'Revenue', className: 'num', sortable: true, sortValue: p => SG.toNumber(p.revenue), render: p => money(p.revenue) },
        { key: 'profit', label: 'Profit', className: 'num', sortable: true, sortValue: p => SG.toNumber(p.profit), render: p => money(p.profit) },
        { key: 'margin', label: 'Margin', className: 'num', render: p => SG.toNumber(p.revenue) ? `${Math.round(SG.toNumber(p.profit) / SG.toNumber(p.revenue) * 100)}%` : '—' }] });
    new SG.Table(document.getElementById('tCashiers'), { rows: r.by_cashier, pageSize: 10, empty: { icon: 'bi-person', title: 'No sales in this period' },
      columns: [{ key: 'name', label: 'Employee', sortable: true }, { key: 'txns', label: 'Txns', className: 'num', sortable: true },
        { key: 'revenue', label: 'Sales', className: 'num', sortable: true, sortValue: c => SG.toNumber(c.revenue), render: c => money(c.revenue) },
        { key: 'discounts', label: 'Discounts', className: 'num', render: c => money(c.discounts) },
        { key: 'refunds', label: 'Refunds', className: 'num', sortable: true, render: c => html`<span class="${c.refunds >= 3 ? 'text-red fw-600' : ''}">${c.refunds}</span>` }] });
    renderInventory();
  }
  function empty() { return html`<div class="empty-state"><i class="bi bi-bar-chart"></i><div class="small">No sales in this period</div></div>`; }

  function renderInventory() {
    if (!inventory) return;
    const inv = inventory;
    setHTML(document.getElementById('invSection'), html`<h2 class="h5 fw-bold mt-4 mb-3">Inventory health <span class="small text-muted-sg fw-normal">· current snapshot</span></h2>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Stock at cost</div><div class="stat-value">${money(inv.totals.cost_value)}</div><div class="stat-sub">${int(inv.totals.units)} units · ${inv.totals.products} products</div></div>
        <div class="stat-card"><div class="stat-label">Stock at retail</div><div class="stat-value">${money(inv.totals.retail_value)}</div><div class="stat-sub">Potential margin ${money(SG.toNumber(inv.totals.retail_value) - SG.toNumber(inv.totals.cost_value))}</div></div>
        <div class="stat-card"><div class="stat-label">Low / out of stock</div><div class="stat-value"><span class="text-amber">${inv.low_stock.length}</span> / <span class="text-red">${inv.out_of_stock.length}</span></div><div class="stat-sub">Reorder soon</div></div>
        <div class="stat-card"><div class="stat-label">Slow movers</div><div class="stat-value">${inv.slow_movers.length}</div><div class="stat-sub">In stock, no sales in 30 days</div></div>
      </div>
      <div class="row grid-gap"><div class="col-lg-6"><div class="card-sg flush h-100"><div class="card-head"><h3 class="card-title"><i class="bi bi-tags"></i> Valuation by category</h3>${exportBtn('valuation')}</div><div id="tVal"></div></div></div>
        <div class="col-lg-6"><div class="card-sg flush h-100"><div class="card-head"><h3 class="card-title"><i class="bi bi-hourglass-bottom"></i> Slow movers</h3>${exportBtn('slow')}</div><div id="tSlow"></div></div></div></div>`);
    new SG.Table(document.getElementById('tVal'), { rows: inv.by_category, pageSize: 12, columns: [
      { key: 'category', label: 'Category', render: c => SG.titleCase(c.category) }, { key: 'products', label: 'Products', className: 'num' }, { key: 'units', label: 'Units', className: 'num' },
      { key: 'cost_value', label: 'At cost', className: 'num', render: c => money(c.cost_value) }, { key: 'retail_value', label: 'At retail', className: 'num', render: c => money(c.retail_value) }] });
    new SG.Table(document.getElementById('tSlow'), { rows: inv.slow_movers, pageSize: 8, empty: { icon: 'bi-lightning', title: 'Everything is selling' }, columns: [
      { key: 'name', label: 'Product', render: p => html`<div class="cell-main">${p.name}</div><div class="cell-sub mono">${p.sku}</div>` }, { key: 'stock_quantity', label: 'In stock', className: 'num' },
      { key: 'value', label: 'Tied-up cost', className: 'num', render: p => money(SG.toNumber(p.cost_price) * p.stock_quantity) }] });
  }

  const EXPORTS = {
    series: () => SG.exportCSV('daily_sales', report.series, [{ label: 'Date', value: s => s.date }, { label: 'Revenue', value: s => s.revenue }, { label: 'Gross profit', value: s => s.profit }, { label: 'Transactions', value: s => s.txns }, { label: 'Refunds', value: s => s.refunds }, { label: 'Expenses', value: s => s.expenses }]),
    products: () => SG.exportCSV('top_products', report.top_products, [{ label: 'Product', value: p => p.name }, { label: 'Units', value: p => p.quantity }, { label: 'Revenue', value: p => p.revenue }, { label: 'Profit', value: p => p.profit }]),
    cashiers: () => SG.exportCSV('staff_performance', report.by_cashier, [{ label: 'Employee', value: c => c.name }, { label: 'Transactions', value: c => c.txns }, { label: 'Sales', value: c => c.revenue }, { label: 'Discounts', value: c => c.discounts }, { label: 'Refunds', value: c => c.refunds }]),
    valuation: () => SG.exportCSV('stock_valuation', inventory.by_category, [{ label: 'Category', value: c => c.category }, { label: 'Products', value: c => c.products }, { label: 'Units', value: c => c.units }, { label: 'Cost value', value: c => c.cost_value }, { label: 'Retail value', value: c => c.retail_value }]),
    slow: () => SG.exportCSV('slow_movers', inventory.slow_movers, [{ label: 'Product', value: p => p.name }, { label: 'SKU', value: p => p.sku }, { label: 'In stock', value: p => p.stock_quantity }, { label: 'Cost price', value: p => p.cost_price }]),
  };
  document.getElementById('report').addEventListener('click', e => { const b = e.target.closest('[data-export]'); if (b) EXPORTS[b.dataset.export](); });

  async function load() {
    try {
      const [r, inv] = await Promise.all([SG.api.get('/reports/summary', f), SG.api.get('/reports/inventory').catch(() => null)]);
      report = r; inventory = inv; render();
    } catch (e) { SG.fail(e); }
  }
  SG.rangeChips(document.getElementById('range'), days => {
    f.start = SG.today(-days); f.end = SG.today();
    document.getElementById('start').value = f.start; document.getElementById('end').value = f.end; load();
  }, '6');
  ['start', 'end'].forEach(id => document.getElementById(id).addEventListener('change', e => {
    f[id] = e.target.value; document.querySelectorAll('#range .chip').forEach(c => c.classList.remove('active')); if (f.start && f.end) load();
  }));
  document.getElementById('printBtn').addEventListener('click', () => window.print());
  load();
})();
