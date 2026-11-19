(async function () {
  'use strict';
  const session = await SG.boot({ title: 'My Dashboard' });
  if (!session) return;
  const { html, setHTML, money } = SG;
  const main = document.querySelector('main');
  let chart;

  async function render() {
    let shift, sales, notes;
    try {
      [shift, sales, notes] = await Promise.all([
        SG.api.get('/shifts/current').then(r => r.shift),
        SG.api.get('/sales', { mine: 1, days: 0, per_page: 8 }),
        SG.api.get('/notifications'),
      ]);
    } catch (e) { SG.fail(e); return; }
    const t = shift ? shift.totals : null;
    const first = session.user.name.split(' ')[0];
    if (chart) { chart.destroy(); chart = null; }
    setHTML(main, html`
      <div class="page-header"><div><h1 class="page-title">Hello, ${first}</h1><p class="page-subtitle">${shift ? 'Your shift is running. Here is how it is going.' : 'You are not on shift yet.'}</p></div>
        <div class="page-actions"><a class="btn-sg btn-forest lg" href="/pos.html"><i class="bi bi-upc-scan"></i> Open POS</a></div></div>
      <div class="hero-band">
        <div><h2>${shift ? `Shift open since ${SG.fmtTime(shift.opened_at)}` : 'No open shift'}</h2><p>${shift ? `${shift.device_label || 'Drawer'} · opening float ${money(shift.opening_cash)}` : 'Open your shift and count your float before you start selling.'}</p>
          <span class="hero-chip"><span class="dot" style="${shift ? '' : 'background:#f6c26b'}"></span>${shift ? (shift.on_break ? 'On break' : 'Active') : 'Off shift'}${shift ? ` · ${SG.duration((Date.now() - new Date(shift.opened_at)) / 60000)} elapsed` : ''}</span></div>
        <div class="text-end">${shift ? html`<div class="label">Expected in drawer</div><div class="big">${money(t.expected_cash)}</div>` : html`<button class="btn-sg btn-soft lg" id="openShift"><i class="bi bi-door-open"></i> Open shift</button>`}</div>
      </div>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">My sales today <i class="bi bi-currency-exchange"></i></div><div class="stat-value">${money(sales.summary.revenue)}</div><div class="stat-sub">${sales.summary.count} transactions</div></div>
        <div class="stat-card"><div class="stat-label">Average sale <i class="bi bi-basket"></i></div><div class="stat-value">${money(sales.summary.count ? SG.toNumber(sales.summary.revenue) / sales.summary.count : 0)}</div><div class="stat-sub">Today</div></div>
        <div class="stat-card"><div class="stat-label">Refunds this shift <i class="bi bi-arrow-return-left"></i></div><div class="stat-value text-amber">${t ? t.refunds_count : 0}</div><div class="stat-sub">${t ? money(t.refunds_total) : '—'}</div></div>
        <div class="stat-card"><div class="stat-label">Break time <i class="bi bi-cup-hot"></i></div><div class="stat-value">${t ? SG.duration(t.break_minutes) : '—'}</div><div class="stat-sub">This shift</div></div>
      </div>
      <div class="row grid-gap mb-3">
        <div class="col-lg-8"><div class="card-sg h-100"><div class="card-head"><h2 class="card-title"><i class="bi bi-graph-up"></i> My sales this shift · by hour</h2></div>${shift && t.sales_count ? html`<div class="chart-box"><canvas id="hourChart" role="img" aria-label="Sales by hour this shift"></canvas></div>` : html`<div class="empty-state"><i class="bi bi-bar-chart"></i><div class="title">No sales this shift yet</div></div>`}</div></div>
        <div class="col-lg-4"><div class="card-sg h-100"><div class="card-head"><h2 class="card-title"><i class="bi bi-lightning-charge"></i> Quick actions</h2></div><div class="quick-grid">
          <a class="quick-btn" href="/pos.html"><i class="bi bi-cart-plus"></i>New sale</a><a class="quick-btn" href="/st.html"><i class="bi bi-receipt"></i>My sales</a>
          <a class="quick-btn" href="/cashierrefunds.html"><i class="bi bi-arrow-return-left"></i>Refunds</a><a class="quick-btn" href="/cashiermyshift.html"><i class="bi bi-person-badge"></i>My shift</a>
          <a class="quick-btn" href="/cashiercashdrawer.html"><i class="bi bi-safe"></i>Cash drawer</a><a class="quick-btn" href="/help.html"><i class="bi bi-question-circle"></i>Help</a></div></div></div>
      </div>
      <div class="row grid-gap">
        <div class="col-lg-8"><div class="card-sg flush h-100"><div class="card-head"><h2 class="card-title"><i class="bi bi-receipt-cutoff"></i> My recent transactions</h2><a class="btn-sg btn-soft sm" href="/st.html">View all</a></div><div id="recent"></div></div></div>
        <div class="col-lg-4"><div class="card-sg h-100"><div class="card-head"><h2 class="card-title"><i class="bi bi-megaphone"></i> Updates for you</h2></div>
          ${notes.my_requests.length ? notes.my_requests.map(r => html`<div class="list-row"><i class="bi bi-send ${r.status === 'approved' ? 'text-emerald' : r.status === 'rejected' ? 'text-red' : 'text-amber'}"></i><div class="main"><div class="fw-600">${SG.titleCase(r.kind)} ${r.status}</div><div class="meta"><span>${r.summary}</span>${r.decision_note ? html`<span>${r.decision_note}</span>` : ''}<span>${SG.ago(r.decided_at || r.created_at)}</span></div></div></div>`)
            : html`<div class="empty-state py-3"><i class="bi bi-inbox"></i><div class="small">No updates. Approval decisions on your refund requests appear here.</div></div>`}
        </div></div>
      </div>`);

    new SG.Table(document.getElementById('recent'), { rows: sales.items, pageSize: 8, footer: false, onRowClick: s => { location.href = `/st.html?sale=${s.id}`; },
      empty: { icon: 'bi-receipt', title: 'No sales today yet' },
      columns: [{ key: 'reference', label: 'Receipt', render: s => html`<span class="mono">${s.reference}</span>` }, { key: 'created_at', label: 'Time', render: s => SG.fmtTime(s.created_at) },
        { key: 'item_count', label: 'Items', className: 'num' }, { key: 'payment_method', label: 'Payment', render: s => SG.paymentLabel(s.payment_method) },
        { key: 'total', label: 'Amount', className: 'num', render: s => money(s.total) }, { key: 'status', label: 'Status', render: s => SG.badge(s.status) }] });

    if (shift && t.sales_count) {
      const buckets = {};
      shift.timeline.filter(e => e.type === 'sale').forEach(e => { const h = SG.fmtTime(e.at).slice(0, 2) + ':00'; buckets[h] = (buckets[h] || 0) + SG.toNumber(e.amount); });
      const labels = Object.keys(buckets).sort();
      chart = SG.barChart(document.getElementById('hourChart'), { labels, series: [{ label: 'Sales', data: labels.map(l => Math.round(buckets[l] * 100) / 100) }] });
    }
    const open = document.getElementById('openShift');
    if (open) open.addEventListener('click', () => SG.formModal({ title: 'Open your shift', icon: 'bi-door-open', submitText: 'Open shift',
      fields: [{ name: 'opening_cash', label: 'Opening cash in drawer', type: 'money', required: true }, { name: 'device_label', label: 'Till / drawer name', default: SG.store.get('sg_device_name', '') }],
      onSubmit: async v => { await SG.api.post('/shifts/open', v); SG.ok('Shift opened.'); render(); } }));
  }
  render();
  setInterval(() => { if (!document.hidden && !document.querySelector('.modal.show')) render(); }, 90000);
})();
