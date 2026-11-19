(async function () {
  'use strict';
  const session = await SG.boot({ title: 'Cash Management' });
  if (!session) return;
  const { html, setHTML, money } = SG;
  const main = document.querySelector('main');
  let chart;

  setHTML(main, html`
    <div class="page-header">
      <div><h1 class="page-title">Cash Management</h1><p class="page-subtitle">Track every cedi from opening float to closing count. Variances above ${money(session.business.cash_variance_threshold)} need review.</p></div>
      <div class="page-actions"><a class="btn-sg btn-soft" href="/shifts.html"><i class="bi bi-clock-history"></i> Shifts</a><button class="btn-sg btn-forest" id="refresh"><i class="bi bi-arrow-clockwise"></i> Refresh</button></div>
    </div>
    <div class="stats-grid" id="stats"></div>
    <div class="row grid-gap mb-3">
      <div class="col-lg-7"><div class="card-sg flush h-100"><div class="card-head"><h2 class="card-title"><i class="bi bi-safe"></i> Open drawers</h2></div><div id="drawers"></div></div></div>
      <div class="col-lg-5"><div class="card-sg h-100"><div class="card-head"><h2 class="card-title"><i class="bi bi-bar-chart"></i> Daily net variance · 14 days</h2></div><div class="chart-box sm"><canvas id="varChart" role="img" aria-label="Net cash variance per day over the last 14 days"></canvas></div><div class="small-xs text-muted-sg mt-2">Bars below zero are shortages. Hover a bar for the amount.</div></div></div>
    </div>
    <div class="card-sg flush"><div class="card-head"><h2 class="card-title"><i class="bi bi-exclamation-diamond"></i> Closed shifts with variance</h2>
      <div class="chip-group" id="reviewChips"><button class="chip active" data-r="">All · 14 days</button><button class="chip" data-r="pending">Pending review</button></div></div><div id="closed"></div></div>`);

  let reviewFilter = '';
  const drawers = new SG.Table(document.getElementById('drawers'), {
    rows: [], pageSize: 20, footer: false, onRowClick: s => SG.showShift(s.id, { onChange: load }),
    empty: { icon: 'bi-safe', title: 'No drawers open', text: 'Drawers open when a cashier starts a shift.' },
    columns: [
      { key: 'user_name', label: 'Cashier', render: s => html`<div class="cell-main">${s.user_name}</div><div class="cell-sub">${s.device_label || 'Drawer'} · since ${SG.fmtTime(s.opened_at)}</div>` },
      { key: 'opening', label: 'Float', className: 'num', render: s => money(s.opening_cash) },
      { key: 'cash_sales', label: 'Cash sales', className: 'num', render: s => money(s.totals.cash_sales) },
      { key: 'refunds', label: 'Refunds', className: 'num', render: s => money(-SG.toNumber(s.totals.cash_refunds)) },
      { key: 'inout', label: 'In / out', className: 'num', render: s => money(SG.toNumber(s.totals.cash_in) - SG.toNumber(s.totals.cash_out), { signed: true }) },
      { key: 'expected', label: 'Expected', className: 'num', render: s => html`<b>${money(s.totals.expected_cash)}</b>` },
    ],
  });
  const closed = new SG.Table(document.getElementById('closed'), {
    pageSize: 15, onRowClick: s => SG.showShift(s.id, { onChange: load }),
    load: ({ page, perPage }) => SG.api.get('/shifts', { status: 'closed', review_status: reviewFilter, start: SG.today(-13), end: SG.today(), page, per_page: perPage }),
    empty: { icon: 'bi-check2-circle', title: 'No closed shifts', text: 'Closed shifts and their counts appear here.' },
    columns: [
      { key: 'user_name', label: 'Cashier', render: s => html`<div class="cell-main">${s.user_name}</div><div class="cell-sub">${SG.fmtDate(s.opened_at)}</div>` },
      { key: 'expected', label: 'Expected', className: 'num', render: s => money(s.expected_cash_at_close) },
      { key: 'counted', label: 'Counted', className: 'num', render: s => money(s.counted_cash) },
      { key: 'variance', label: 'Variance', className: 'num', render: s => html`<b class="${SG.toNumber(s.variance) < 0 ? 'text-red' : SG.toNumber(s.variance) > 0 ? 'text-amber' : 'text-emerald'}">${money(s.variance, { signed: true })}</b>` },
      { key: 'review_status', label: 'Review', render: s => s.review_status === 'none' ? SG.badge('completed', 'Within limit') : SG.badge(s.review_status) },
      { key: 'notes', label: 'Notes', render: s => html`<span class="small">${s.notes || '—'}</span>` },
    ],
  });

  async function load() {
    try {
      const [open, recent] = await Promise.all([
        SG.api.get('/shifts', { status: 'open', per_page: 100 }),
        SG.api.get('/shifts', { status: 'closed', start: SG.today(-13), end: SG.today(), per_page: 100 }),
      ]);
      drawers.setRows(open.items);
      closed.reload();
      const sum = (rows, fn) => rows.reduce((n, s) => n + fn(s), 0);
      const todayKey = SG.today();
      const closedToday = recent.items.filter(s => SG.today() === localDay(s.closed_at));
      const shortages = recent.items.filter(s => SG.toNumber(s.variance) < 0);
      setHTML(document.getElementById('stats'), html`
        <div class="stat-card"><div class="stat-label">Expected in open drawers <i class="bi bi-safe"></i></div><div class="stat-value">${money(sum(open.items, s => SG.toNumber(s.totals.expected_cash)))}</div><div class="stat-sub">${open.items.length} drawer(s) open</div></div>
        <div class="stat-card"><div class="stat-label">Cash sales · open shifts <i class="bi bi-cash-stack"></i></div><div class="stat-value">${money(sum(open.items, s => SG.toNumber(s.totals.cash_sales)))}</div><div class="stat-sub">Refunds ${money(sum(open.items, s => SG.toNumber(s.totals.cash_refunds)))}</div></div>
        <div class="stat-card"><div class="stat-label">Net variance · today <i class="bi bi-calculator"></i></div><div class="stat-value ${sum(closedToday, s => SG.toNumber(s.variance)) < 0 ? 'text-red' : ''}">${money(sum(closedToday, s => SG.toNumber(s.variance)), { signed: true })}</div><div class="stat-sub">${closedToday.length} shift(s) closed on ${SG.fmtDate(todayKey)}</div></div>
        <div class="stat-card"><div class="stat-label">Shortages · 14 days <i class="bi bi-exclamation-triangle"></i></div><div class="stat-value text-red">${money(sum(shortages, s => SG.toNumber(s.variance)))}</div><div class="stat-sub">${shortages.length} shift(s) short</div></div>`);
      const days = Array.from({ length: 14 }, (_, i) => SG.today(i - 13));
      const byDay = Object.fromEntries(days.map(d => [d, 0]));
      recent.items.forEach(s => { const d = localDay(s.closed_at); if (d in byDay) byDay[d] += SG.toNumber(s.variance); });
      if (chart) chart.destroy();
      chart = SG.barChart(document.getElementById('varChart'), { labels: days.map(SG.fmtDay), series: [{ label: 'Net variance', data: days.map(d => Math.round(byDay[d] * 100) / 100), color: SG.SERIES[0] }] });
    } catch (e) { SG.fail(e); }
  }
  function localDay(iso) {
    const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: session.business.timezone }).formatToParts(new Date(iso));
    const g = t => parts.find(p => p.type === t).value;
    return `${g('year')}-${g('month')}-${g('day')}`;
  }

  document.getElementById('reviewChips').addEventListener('click', e => {
    const c = e.target.closest('[data-r]'); if (!c) return;
    document.querySelectorAll('#reviewChips .chip').forEach(x => x.classList.toggle('active', x === c));
    reviewFilter = c.dataset.r; closed.reload(true);
  });
  document.getElementById('refresh').addEventListener('click', load);
  load();
})();
