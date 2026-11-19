(async function () {
  'use strict';
  const session = await SG.boot({ title: 'My Cash Drawer' });
  if (!session) return;
  const { html, setHTML, money } = SG;
  const main = document.querySelector('main');
  main.classList.add('print-area');
  let chart;

  async function render() {
    let res;
    try { res = await SG.api.get('/shifts/current'); } catch (e) { SG.fail(e); return; }
    const shift = res.shift, denoms = res.denominations;
    if (chart) { chart.destroy(); chart = null; }
    if (!shift) {
      setHTML(main, html`<div class="page-header"><div><h1 class="page-title">My Cash Drawer</h1></div></div><div class="card-sg"><div class="empty-state"><i class="bi bi-safe"></i><div class="title">No open drawer</div><div class="small mb-3">Your drawer opens with your shift.</div><a class="btn-sg btn-forest" href="/cashiermyshift.html">Go to My Shift</a></div></div>`);
      return;
    }
    const t = shift.totals;
    const cashEvents = shift.timeline.filter(e => ['open', 'sale', 'refund', 'cash_in', 'cash_out', 'customer_payment'].includes(e.type) && (e.type !== 'sale' && e.type !== 'refund' && e.type !== 'customer_payment' || e.method === 'cash'));
    setHTML(main, html`
      <div class="page-header"><div><h1 class="page-title">My Cash Drawer</h1><p class="page-subtitle">Follow your cash in real time, record cash in/out, and count your drawer to close the shift.</p></div>
        <div class="page-actions no-print"><button class="btn-sg btn-soft" id="printBtn"><i class="bi bi-printer"></i> Print summary</button><button class="btn-sg btn-amber" data-move="cash_out"><i class="bi bi-box-arrow-up"></i> Cash out</button><button class="btn-sg btn-forest" data-move="cash_in"><i class="bi bi-box-arrow-in-down"></i> Cash in</button></div></div>
      <div class="hero-band"><div><h2>${shift.device_label || 'My drawer'} · ${SG.titleCase(shift.shift_pattern)} shift</h2><p>${session.user.name} · opened ${SG.fmtTime(shift.opened_at)} with ${money(shift.opening_cash)}</p><span class="hero-chip"><span class="dot"></span>Drawer open</span></div>
        <div class="text-end"><div class="label">Expected in drawer now</div><div class="big">${money(t.expected_cash)}</div></div></div>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Opening float</div><div class="stat-value">${money(shift.opening_cash)}</div></div>
        <div class="stat-card"><div class="stat-label">Cash sales</div><div class="stat-value text-emerald">${money(t.cash_sales)}</div><div class="stat-sub">${money(t.sales_total)} all methods</div></div>
        <div class="stat-card"><div class="stat-label">Cash refunds</div><div class="stat-value text-amber">${money(-SG.toNumber(t.cash_refunds))}</div></div>
        <div class="stat-card"><div class="stat-label">Cash in / out</div><div class="stat-value">${money(SG.toNumber(t.cash_in) - SG.toNumber(t.cash_out), { signed: true })}</div><div class="stat-sub">In ${money(t.cash_in)} · out ${money(t.cash_out)}</div></div>
      </div>
      <div class="row grid-gap mb-3">
        <div class="col-lg-7"><div class="card-sg h-100"><div class="card-head"><h2 class="card-title"><i class="bi bi-graph-up"></i> Expected cash through the shift</h2></div><div class="chart-box"><canvas id="flowChart" role="img" aria-label="Expected drawer balance over time"></canvas></div></div></div>
        <div class="col-lg-5"><div class="card-sg h-100" id="close"><div class="card-head"><h2 class="card-title"><i class="bi bi-calculator"></i> Count & close drawer</h2></div>
          <div class="denom-grid mb-2">${denoms.map(d => html`<div><label for="d${d}">${SG.currencySymbol()} ${d}</label><input type="number" min="0" step="1" class="form-control form-control-sm" id="d${d}" data-denom="${d}" placeholder="0"></div>`)}</div>
          <div class="kv-row"><span class="k">Counted total</span><span class="v" id="counted">${money(0)}</span></div>
          <div class="kv-row"><span class="k">Expected</span><span class="v">${money(t.expected_cash)}</span></div>
          <div class="kv-row total"><span class="k">Variance</span><span class="v" id="variance">—</span></div>
          <label class="form-label mt-2" for="closeNotes">Notes for your supervisor</label><textarea class="form-control" id="closeNotes" rows="2" maxlength="500" placeholder="Explain any difference"></textarea>
          <button class="btn-sg btn-forest w-100 mt-3 no-print" id="closeBtn" disabled><i class="bi bi-door-closed"></i> Close drawer & end shift</button>
          <div class="small-xs text-muted-sg mt-2">Differences over ${money(session.business.cash_variance_threshold)} are sent to a manager for review.</div></div></div>
      </div>
      <div class="card-sg"><div class="card-head"><h2 class="card-title"><i class="bi bi-list-ul"></i> Drawer activity</h2></div>
        <div class="table-wrap"><table class="table-sg"><thead><tr><th>Time</th><th>Activity</th><th>Details</th><th class="num">Cash effect</th></tr></thead><tbody>
        ${cashEvents.slice().reverse().map(e => { const amt = e.type === 'open' ? SG.toNumber(shift.opening_cash) : SG.toNumber(e.amount) * (['refund', 'cash_out'].includes(e.type) ? -1 : 1);
          return html`<tr><td>${SG.fmtTime(e.at)}</td><td class="fw-600">${e.title}</td><td class="small">${e.detail}</td><td class="num ${amt < 0 ? 'text-red' : 'text-emerald'}">${money(amt, { signed: true })}</td></tr>`; })}
        </tbody></table></div></div>`);

    // running balance chart
    let bal = 0;
    const pts = cashEvents.map(e => { bal += e.type === 'open' ? SG.toNumber(shift.opening_cash) : SG.toNumber(e.amount) * (['refund', 'cash_out'].includes(e.type) ? -1 : 1); return { x: SG.fmtTime(e.at), y: Math.round(bal * 100) / 100 }; });
    chart = SG.lineChart(document.getElementById('flowChart'), { labels: pts.map(p => p.x), series: [{ label: 'Expected cash', data: pts.map(p => p.y) }] });

    const expected = SG.toNumber(t.expected_cash);
    const inputs = [...main.querySelectorAll('[data-denom]')];
    const recount = () => {
      const counted = inputs.reduce((s, i) => s + (parseInt(i.value, 10) || 0) * parseFloat(i.dataset.denom), 0);
      const touched = inputs.some(i => i.value !== '');
      document.getElementById('counted').textContent = money(counted);
      const v = Math.round((counted - expected) * 100) / 100;
      const el = document.getElementById('variance');
      el.textContent = touched ? money(v, { signed: true }) : '—';
      el.className = `v ${!touched ? '' : v < 0 ? 'text-red' : v > 0 ? 'text-amber' : 'text-emerald'}`;
      document.getElementById('closeBtn').disabled = !touched;
      return { counted, v };
    };
    inputs.forEach(i => i.addEventListener('input', recount));
    document.getElementById('closeBtn').addEventListener('click', async () => {
      const { counted, v } = recount();
      const ok = await SG.confirm({ title: 'Close drawer and end shift?', message: `Counted ${money(counted)} against ${money(expected)} expected (variance ${money(v, { signed: true })}). You won't be able to sell until you open a new shift.`, confirmText: 'Close shift', danger: Math.abs(v) > SG.toNumber(session.business.cash_variance_threshold) });
      if (!ok) return;
      const denominations = Object.fromEntries(inputs.filter(i => parseInt(i.value, 10) > 0).map(i => [i.dataset.denom, parseInt(i.value, 10)]));
      try {
        const r = await SG.api.post('/shifts/current/close', { counted_cash: counted.toFixed(2), denominations, notes: document.getElementById('closeNotes').value.trim() });
        SG.ok(r.shift.review_status === 'pending' ? 'Shift closed. The variance was sent to a manager for review.' : 'Shift closed. Thank you!');
        render();
      } catch (e) { SG.fail(e); }
    });
    main.querySelectorAll('[data-move]').forEach(b => b.addEventListener('click', () => {
      const kind = b.dataset.move;
      SG.formModal({ title: kind === 'cash_in' ? 'Cash in' : 'Cash out', icon: kind === 'cash_in' ? 'bi-box-arrow-in-down' : 'bi-box-arrow-up', submitText: 'Record',
        intro: html`<div class="small text-muted-sg">${kind === 'cash_in' ? 'Money added to the drawer, e.g. extra change from the safe.' : 'Money taken out, e.g. a cash drop to the safe or a supervisor pickup.'}</div>`,
        fields: [{ name: 'amount', label: 'Amount', type: 'money', required: true }, { name: 'reason', label: 'Reason', required: true, list: kind === 'cash_in' ? ['Change top-up from safe', 'Float correction'] : ['Cash drop to safe', 'Supervisor pickup', 'Petty cash'], maxlength: 255 }],
        onSubmit: async v => { await SG.api.post('/shifts/current/cash-movements', { kind, ...v }); SG.ok('Recorded.'); render(); } });
    }));
    document.getElementById('printBtn').addEventListener('click', () => window.print());
    if (location.hash === '#close') document.getElementById('close').scrollIntoView({ behavior: 'smooth' });
  }
  render();
})();
