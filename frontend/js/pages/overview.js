(async function () {
  'use strict';
  const session = await SG.boot({ title: 'Overview' });
  if (!session) return;
  const { html, setHTML, money, int } = SG;
  const main = document.querySelector('main');
  let charts = [];

  const hour = parseInt(new Date().toLocaleString('en-GB', { hour: 'numeric', hour12: false, timeZone: session.business.timezone }), 10);
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  setHTML(main, html`
    <div class="page-header">
      <div><h1 class="page-title">${greeting}, ${session.user.name.split(' ')[0]}</h1><p class="page-subtitle">Here's what's happening at ${session.business.name} today.</p></div>
      <div class="page-actions"><span class="small text-muted-sg" id="updatedAt"></span><button class="btn-sg btn-soft" id="refreshBtn"><i class="bi bi-arrow-clockwise"></i> Refresh</button><a class="btn-sg btn-forest" href="/pos.html"><i class="bi bi-cart-plus"></i> New sale</a></div>
    </div>
    <div id="dash"><div class="stats-grid">${[1, 2, 3, 4, 5, 6].map(() => html`<div class="stat-card"><div class="skeleton mb-2" style="width:60%"></div><div class="skeleton" style="height:26px"></div></div>`)}</div></div>`);

  function trend(today, yesterday) {
    const t = SG.toNumber(today), y = SG.toNumber(yesterday);
    if (!y) return html`<span class="text-muted-sg">No sales yesterday</span>`;
    const pct = ((t - y) / y) * 100;
    return html`<span class="${pct >= 0 ? 'trend-up' : 'trend-down'}"><i class="bi bi-arrow-${pct >= 0 ? 'up' : 'down'}-short"></i>${Math.abs(pct).toFixed(1)}%</span> vs yesterday`;
  }

  function render(d) {
    charts.forEach(c => c.destroy()); charts = [];
    const t = d.today, inv = d.inventory, cash = d.cash;
    const variance = SG.toNumber(cash.variance);
    setHTML(document.getElementById('dash'), html`
      ${d.approvals_pending ? html`<div class="notice warn mb-3"><i class="bi bi-hourglass-split"></i><div><b>${d.approvals_pending} request${d.approvals_pending === 1 ? '' : 's'}</b> waiting for your approval. <a href="/approvals.html">Review now</a></div></div>` : ''}
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Today's revenue <i class="bi bi-currency-exchange"></i></div><div class="stat-value">${money(t.revenue)}</div><div class="stat-sub">${trend(t.revenue, t.yesterday_revenue)}</div></div>
        <div class="stat-card"><div class="stat-label">Gross profit <i class="bi bi-graph-up-arrow"></i></div><div class="stat-value">${money(t.gross_profit)}</div><div class="stat-sub">Margin ${t.gross_margin_pct}% · after refunds</div></div>
        <div class="stat-card"><div class="stat-label">Transactions <i class="bi bi-receipt"></i></div><div class="stat-value">${int(t.transactions)}</div><div class="stat-sub">Avg. basket ${money(t.avg_basket)}</div></div>
        <div class="stat-card"><div class="stat-label">Cash in drawers <i class="bi bi-cash-coin"></i></div><div class="stat-value">${money(cash.expected)}</div><div class="stat-sub ${variance < 0 ? 'text-red' : ''}">${cash.open_drawers} open · variance ${money(variance, { signed: true })}</div></div>
        <div class="stat-card"><div class="stat-label">Inventory value <i class="bi bi-boxes"></i></div><div class="stat-value">${money(inv.cost_value)}</div><div class="stat-sub">${int(inv.products)} products at cost</div></div>
        <div class="stat-card"><div class="stat-label">Security alerts <i class="bi bi-shield-exclamation"></i></div><div class="stat-value ${d.alerts.critical ? 'text-red' : ''}">${d.alerts.active}</div><div class="stat-sub">${d.alerts.critical ? html`<span class="text-red fw-600">${d.alerts.critical} critical</span>` : 'None critical'} · unresolved</div></div>
      </div>

      <div class="row grid-gap mb-3">
        <div class="col-lg-8"><div class="card-sg h-100"><div class="card-head"><h2 class="card-title"><i class="bi bi-graph-up"></i> Last 7 days</h2><div class="legend mb-0" id="trendLegend"></div></div><div class="chart-box"><canvas id="trendChart" aria-label="Revenue and gross profit for the last 7 days" role="img"></canvas></div></div></div>
        <div class="col-lg-4"><div class="card-sg h-100"><div class="card-head"><h2 class="card-title"><i class="bi bi-credit-card"></i> Today by payment</h2></div>
          ${d.by_payment.length ? html`<div class="chart-box sm"><canvas id="payChart" role="img" aria-label="Revenue by payment method today"></canvas></div><div class="mt-3">${d.by_payment.map((p, i) => html`<div class="kv-row"><span class="k"><span class="legend d-inline-flex m-0"><span><i style="background:${SG.SERIES[i]}"></i>${SG.paymentLabel(p.method)}</span></span></span><span class="v">${money(p.total)} <span class="text-muted-sg fw-normal">${pctOf(p.total, t.revenue)}</span></span></div>`)}</div>`
            : html`<div class="empty-state"><i class="bi bi-credit-card"></i><div class="title">No sales yet today</div></div>`}
        </div></div>
      </div>

      <div class="row grid-gap mb-3">
        <div class="col-lg-5"><div class="card-sg h-100"><div class="card-head"><h2 class="card-title"><i class="bi bi-shield-exclamation"></i> Security monitoring</h2><a class="btn-sg btn-soft sm" href="/security.html">View all</a></div>
          ${d.alerts.latest.length ? d.alerts.latest.map(a => html`<div class="list-row"><span class="sev-dot ${a.severity} mt-1"></span><div class="main"><div class="fw-600">${a.title}</div><div class="meta"><span>${a.detail}</span><span>${SG.ago(a.created_at)}</span>${SG.badge(a.status)}</div></div></div>`)
            : html`<div class="empty-state"><i class="bi bi-shield-check"></i><div class="title">No open alerts</div><div class="small">Refund spikes, cash shortages and stock losses appear here.</div></div>`}
        </div></div>
        <div class="col-lg-7"><div class="card-sg flush h-100"><div class="card-head"><h2 class="card-title"><i class="bi bi-receipt-cutoff"></i> Recent transactions</h2><a class="btn-sg btn-soft sm" href="/st.html">All sales</a></div><div id="recentTable"></div></div></div>
      </div>

      <div class="row grid-gap mb-3">
        <div class="col-lg-6"><div class="card-sg flush h-100"><div class="card-head"><h2 class="card-title"><i class="bi bi-people"></i> Staff activity today</h2><a class="btn-sg btn-soft sm" href="/shifts.html">Shifts</a></div><div id="staffTable"></div></div></div>
        <div class="col-lg-6"><div class="card-sg h-100"><div class="card-head"><h2 class="card-title"><i class="bi bi-box-seam"></i> Inventory needing attention</h2><a class="btn-sg btn-soft sm" href="/inventory.html">Manage</a></div>
          <div class="d-flex flex-wrap gap-4 mb-3"><div><div class="small-xs text-muted-sg">Products</div><div class="fw-bold">${int(inv.products)}</div></div><div><div class="small-xs text-muted-sg">Low stock</div><div class="fw-bold text-amber">${inv.low_stock}</div></div><div><div class="small-xs text-muted-sg">Out of stock</div><div class="fw-bold text-red">${inv.out_of_stock}</div></div><div><div class="small-xs text-muted-sg">Expiring ≤30d</div><div class="fw-bold">${inv.expiring}</div></div></div>
          ${inv.attention.length ? html`<div class="table-wrap"><table class="table-sg"><thead><tr><th>Product</th><th class="num">In stock</th><th class="num">Reorder at</th><th>Status</th></tr></thead><tbody>${inv.attention.map(p => html`<tr><td><div class="cell-main">${p.name}</div><div class="cell-sub mono">${p.sku}</div></td><td class="num">${p.stock_quantity}</td><td class="num">${p.reorder_level}</td><td>${p.stock_quantity <= 0 ? SG.badge('out', 'Out of stock') : SG.badge('low', 'Low')}</td></tr>`)}</tbody></table></div>`
            : html`<div class="empty-state"><i class="bi bi-check2-circle"></i><div class="title">Stock levels look healthy</div></div>`}
        </div></div>
      </div>

      <div class="row grid-gap">
        <div class="col-lg-5"><div class="card-sg h-100"><div class="card-head"><h2 class="card-title"><i class="bi bi-cash-coin"></i> Cash reconciliation · today</h2><a class="btn-sg btn-soft sm" href="/cash.html">Details</a></div>
          <div class="kv-row"><span class="k">Opening floats</span><span class="v">${money(cash.opening)}</span></div>
          <div class="kv-row"><span class="k">+ Cash sales &amp; repayments</span><span class="v">${money(cash.cash_sales)}</span></div>
          <div class="kv-row"><span class="k">− Cash refunds</span><span class="v">${money(-SG.toNumber(cash.cash_refunds))}</span></div>
          <div class="kv-row"><span class="k">+ Cash in / − cash out</span><span class="v">${money(SG.toNumber(cash.cash_in) - SG.toNumber(cash.cash_out), { signed: true })}</span></div>
          <div class="kv-row total"><span class="k">Expected in drawers</span><span class="v">${money(cash.expected)}</span></div>
          <div class="mt-2">${variance ? SG.badge(variance < 0 ? 'rejected' : 'pending', `Closed-shift variance ${money(variance, { signed: true })}`) : SG.badge('completed', 'No variance on closed shifts')}</div>
        </div></div>
        <div class="col-lg-3"><div class="card-sg h-100"><div class="card-head"><h2 class="card-title"><i class="bi bi-lightning-charge"></i> Quick actions</h2></div><div class="quick-grid">
          <a class="quick-btn" href="/pos.html"><i class="bi bi-cart-plus"></i>New sale</a>
          ${SG.can('inventory') ? html`<a class="quick-btn" href="/inventory.html?new=1"><i class="bi bi-plus-square"></i>Add product</a>` : ''}
          ${SG.can('suppliers') ? html`<a class="quick-btn" href="/suppliers.html"><i class="bi bi-truck"></i>Receive stock</a>` : ''}
          ${SG.can('expenses') ? html`<a class="quick-btn" href="/expenses.html?new=1"><i class="bi bi-wallet2"></i>Record expense</a>` : ''}
          <a class="quick-btn" href="/reports.html"><i class="bi bi-bar-chart"></i>Reports</a>
          ${SG.can('cash') ? html`<a class="quick-btn" href="/cash.html"><i class="bi bi-safe"></i>Reconcile cash</a>` : ''}
        </div></div></div>
        <div class="col-lg-4"><div class="card-sg h-100"><div class="card-head"><h2 class="card-title"><i class="bi bi-clipboard-data"></i> Daily business summary</h2><button class="btn-sg btn-soft sm" id="exportSummary"><i class="bi bi-download"></i> Export</button></div>
          <div class="kv-row"><span class="k">Total sales</span><span class="v">${money(t.revenue)}</span></div>
          <div class="kv-row"><span class="k">Gross profit</span><span class="v">${money(t.gross_profit)}</span></div>
          <div class="kv-row"><span class="k">Discounts given</span><span class="v">${money(t.discounts)}</span></div>
          <div class="kv-row"><span class="k">Refunds</span><span class="v">${money(t.refunds)}</span></div>
          <div class="kv-row"><span class="k">Expenses</span><span class="v">${money(t.expenses)}</span></div>
          <div class="kv-row"><span class="k">Open alerts</span><span class="v ${d.alerts.active ? 'text-red' : ''}">${d.alerts.active}</span></div>
        </div></div>
      </div>`);

    const labels = d.series.map(s => SG.fmtDay(s.date));
    SG.legend(document.getElementById('trendLegend'), [{ label: 'Revenue', color: SG.SERIES[0], line: true }, { label: 'Gross profit', color: SG.SERIES[1], line: true }]);
    charts.push(SG.lineChart(document.getElementById('trendChart'), { labels, series: [
      { label: 'Revenue', data: d.series.map(s => SG.toNumber(s.revenue)) },
      { label: 'Gross profit', data: d.series.map(s => SG.toNumber(s.profit)) },
    ] }));
    if (d.by_payment.length) charts.push(SG.doughnut(document.getElementById('payChart'), { labels: d.by_payment.map(p => SG.paymentLabel(p.method)), data: d.by_payment.map(p => SG.toNumber(p.total)) }));

    new SG.Table(document.getElementById('recentTable'), {
      rows: d.recent_sales, pageSize: 8, footer: false,
      empty: { icon: 'bi-receipt', title: 'No sales recorded yet', text: 'Sales from the POS appear here instantly.' },
      onRowClick: s => { location.href = `/st.html?sale=${s.id}`; },
      columns: [
        { key: 'reference', label: 'Receipt', render: s => html`<span class="mono">${s.reference}</span>` },
        { key: 'created_at', label: 'Time', render: s => SG.fmtTime(s.created_at) },
        { key: 'cashier_name', label: 'Cashier' },
        { key: 'payment_method', label: 'Payment', render: s => SG.paymentLabel(s.payment_method) },
        { key: 'total', label: 'Amount', className: 'num', render: s => money(s.total) },
        { key: 'status', label: 'Status', render: s => SG.badge(s.status) },
      ],
    });
    new SG.Table(document.getElementById('staffTable'), {
      rows: d.employees, pageSize: 8, footer: false,
      empty: { icon: 'bi-person', title: 'Nobody has clocked in today' },
      columns: [
        { key: 'name', label: 'Employee', render: e => html`<span class="cell-main">${e.name}</span>` },
        { key: 'role', label: 'Role' },
        { key: 'txns', label: 'Txns', className: 'num' },
        { key: 'sales', label: 'Sales', className: 'num', render: e => money(e.sales) },
        { key: 'refunds', label: 'Refunds', className: 'num' },
        { key: 'status', label: 'Status', render: e => SG.badge(e.status) },
      ],
    });
    document.getElementById('exportSummary').addEventListener('click', () => SG.exportCSV('daily_summary', [
      ['Total sales', t.revenue], ['Gross profit', t.gross_profit], ['Discounts', t.discounts], ['Refunds', t.refunds],
      ['Expenses', t.expenses], ['Transactions', t.transactions], ['Average basket', t.avg_basket], ['Open alerts', d.alerts.active],
    ], [{ label: 'Metric', value: r => r[0] }, { label: 'Value', value: r => r[1] }]));
    document.getElementById('updatedAt').textContent = `Updated ${SG.fmtTime(new Date())}`;
  }

  function pctOf(part, whole) { const w = SG.toNumber(whole); return w ? `(${Math.round(SG.toNumber(part) / w * 100)}%)` : ''; }

  async function load() {
    const btn = document.getElementById('refreshBtn');
    SG.busy(btn, true, 'Refreshing');
    try { render(await SG.api.get('/dashboard')); } catch (e) { SG.fail(e); } finally { SG.busy(btn, false); }
  }
  document.getElementById('refreshBtn').addEventListener('click', load);
  load();
  setInterval(() => { if (!document.hidden) load(); }, 120000);
})();
