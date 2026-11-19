(async function () {
  'use strict';
  const session = await SG.boot({ title: 'My Shift' });
  if (!session) return;
  const { html, setHTML, money } = SG;
  const main = document.querySelector('main');
  main.classList.add('print-area');
  const CHECKLIST = ['Count and record the cash in your drawer', 'Hand over any held sales or customer orders', 'Report damaged or missing stock to the supervisor', 'Tidy the till area and restock bags', 'Note anything the next shift needs to know'];
  let shift = null, ticker;

  async function render() {
    let history;
    try {
      [shift, history] = await Promise.all([SG.api.get('/shifts/current').then(r => r.shift), SG.api.get('/shifts', { mine: 1, status: 'closed', per_page: 8 })]);
    } catch (e) { SG.fail(e); return; }
    clearInterval(ticker);
    if (!shift) {
      setHTML(main, html`<div class="page-header"><div><h1 class="page-title">My Shift</h1><p class="page-subtitle">Start your shift, take breaks and hand over cleanly.</p></div></div>
        <div class="card-sg mb-3"><div class="empty-state"><i class="bi bi-door-closed"></i><div class="title">You are not on shift</div><div class="small mb-3">Count your opening float, then open your shift to start selling.</div><button class="btn-sg btn-forest lg" id="openShift"><i class="bi bi-door-open"></i> Open shift</button></div></div>
        <div class="card-sg flush"><div class="card-head"><h2 class="card-title"><i class="bi bi-journal-text"></i> My recent shifts</h2></div><div id="history"></div></div>`);
      document.getElementById('openShift').addEventListener('click', () => SG.formModal({ title: 'Open your shift', icon: 'bi-door-open', submitText: 'Open shift',
        fields: [{ name: 'opening_cash', label: 'Opening cash in drawer', type: 'money', required: true }, { name: 'device_label', label: 'Till / drawer name', default: SG.store.get('sg_device_name', '') }],
        onSubmit: async v => { await SG.api.post('/shifts/open', v); SG.ok('Shift opened.'); render(); } }));
      renderHistory(history.items);
      return;
    }
    const t = shift.totals;
    const done = SG.store.get(`sg_checklist_${shift.id}`, []);
    setHTML(main, html`
      <div class="page-header"><div><h1 class="page-title">My Shift</h1><p class="page-subtitle">Manage breaks, follow your progress and complete the handover checklist.</p></div>
        <div class="page-actions"><button class="btn-sg btn-soft" id="printBtn"><i class="bi bi-printer"></i> Print summary</button><button class="btn-sg btn-amber" id="breakBtn">${shift.on_break ? html`<i class="bi bi-play-circle"></i> End break` : html`<i class="bi bi-cup-hot"></i> Start break`}</button><a class="btn-sg btn-danger" href="/cashiercashdrawer.html#close"><i class="bi bi-box-arrow-right"></i> End shift</a></div></div>
      ${shift.on_break ? html`<div class="notice warn mb-3"><i class="bi bi-cup-hot"></i><div>You've been on break since ${SG.fmtTime(shift.break_started_at)}. Tap <b>End break</b> when you're back.</div></div>` : ''}
      <div class="hero-band">
        <div class="d-flex align-items-center gap-3"><span class="sg-avatar lg" style="background:rgba(255,255,255,.15)">${session.user.initials}</span><div><h2>${SG.titleCase(shift.shift_pattern)} shift${shift.device_label ? ` · ${shift.device_label}` : ''}</h2><p>Started ${SG.fmtTime(shift.opened_at)}${shift.late_minutes ? ` · ${shift.late_minutes} min after scheduled start` : ' · on time'}</p>
          <span class="hero-chip"><span class="dot"></span><span id="elapsed"></span></span></div></div>
        <div style="min-width:220px"><div class="label">Shift progress (${shift.scheduled_hours}h)</div><div class="big" id="pct"></div><div class="progress-thin" style="background:rgba(255,255,255,.2)"><div id="bar" style="background:#7ee2b0"></div></div></div>
      </div>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Sales this shift <i class="bi bi-currency-exchange"></i></div><div class="stat-value">${money(t.sales_total)}</div><div class="stat-sub">${t.sales_count} transactions</div></div>
        <div class="stat-card"><div class="stat-label">Refunds <i class="bi bi-arrow-return-left"></i></div><div class="stat-value text-amber">${t.refunds_count}</div><div class="stat-sub">${money(t.refunds_total)}</div></div>
        <div class="stat-card"><div class="stat-label">Drawer (expected) <i class="bi bi-safe"></i></div><div class="stat-value text-emerald">${money(t.expected_cash)}</div><div class="stat-sub"><a href="/cashiercashdrawer.html">Open cash drawer</a></div></div>
        <div class="stat-card"><div class="stat-label">Break time <i class="bi bi-cup-hot"></i></div><div class="stat-value">${SG.duration(t.break_minutes)}</div><div class="stat-sub">${shift.breaks.length} break(s)</div></div>
      </div>
      <div class="row grid-gap mb-3">
        <div class="col-lg-5"><div class="card-sg h-100"><div class="card-head"><h2 class="card-title"><i class="bi bi-check2-square"></i> Handover checklist</h2><span class="card-sub" id="checkProgress"></span></div>
          ${CHECKLIST.map((c, i) => html`<div class="form-check py-2 border-bottom"><input class="form-check-input" type="checkbox" id="chk${i}" data-chk="${i}" ${done.includes(i) ? SG.raw('checked') : ''}><label class="form-check-label small" for="chk${i}">${c}</label></div>`)}
          <div class="small-xs text-muted-sg mt-2">Saved on this device for this shift.</div></div></div>
        <div class="col-lg-7"><div class="card-sg h-100" style="max-height:460px;overflow:auto"><div class="card-head"><h2 class="card-title"><i class="bi bi-clock-history"></i> Today's timeline</h2></div>${SG.shiftTimeline(shift.timeline)}</div></div>
      </div>
      <div class="card-sg flush"><div class="card-head"><h2 class="card-title"><i class="bi bi-journal-text"></i> My recent shifts</h2></div><div id="history"></div></div>`);

    const tick = () => {
      const mins = (Date.now() - new Date(shift.opened_at)) / 60000;
      const pct = Math.min(100, Math.round(mins / (shift.scheduled_hours * 60) * 100));
      document.getElementById('elapsed').textContent = `${shift.on_break ? 'On break' : 'Active'} · ${SG.duration(mins)} elapsed`;
      document.getElementById('pct').textContent = `${pct}%`;
      document.getElementById('bar').style.width = `${pct}%`;
    };
    tick(); ticker = setInterval(tick, 30000);
    const updateChecks = () => {
      const list = [...main.querySelectorAll('[data-chk]:checked')].map(c => parseInt(c.dataset.chk, 10));
      SG.store.set(`sg_checklist_${shift.id}`, list);
      document.getElementById('checkProgress').textContent = `${list.length} of ${CHECKLIST.length} done`;
    };
    main.querySelectorAll('[data-chk]').forEach(c => c.addEventListener('change', updateChecks));
    updateChecks();
    document.getElementById('breakBtn').addEventListener('click', async () => {
      if (shift.on_break) {
        try { await SG.api.post('/shifts/current/break', { action: 'end' }); SG.ok('Welcome back!'); render(); } catch (e) { SG.fail(e); }
        return;
      }
      SG.formModal({ title: 'Start break', icon: 'bi-cup-hot', submitText: 'Start break',
        fields: [{ name: 'reason', label: 'Break type', type: 'select', options: ['Lunch break', 'Short break', 'Prayer', 'Personal', 'Other'] }],
        intro: html`<div class="small text-muted-sg">Lock your till or hand it over before stepping away.</div>`,
        onSubmit: async v => { await SG.api.post('/shifts/current/break', { action: 'start', reason: v.reason }); SG.ok('Break started.'); render(); } });
    });
    document.getElementById('printBtn').addEventListener('click', () => window.print());
    renderHistory(history.items);
  }

  function renderHistory(items) {
    new SG.Table(document.getElementById('history'), { rows: items, pageSize: 8, footer: false, onRowClick: s => SG.showShift(s.id),
      empty: { icon: 'bi-journal', title: 'No previous shifts' },
      columns: [{ key: 'opened_at', label: 'Date', render: s => SG.fmtDate(s.opened_at) }, { key: 'time', label: 'Time', render: s => `${SG.fmtTime(s.opened_at)} – ${SG.fmtTime(s.closed_at)}` },
        { key: 'sales', label: 'Sales', className: 'num', render: s => money(s.totals.sales_total) }, { key: 'variance', label: 'Variance', className: 'num', render: s => html`<span class="${SG.toNumber(s.variance) < 0 ? 'text-red' : ''}">${money(s.variance, { signed: true })}</span>` },
        { key: 'review_status', label: 'Review', render: s => s.review_status === 'none' ? SG.badge('completed', 'OK') : SG.badge(s.review_status) }] });
  }
  render();
})();
