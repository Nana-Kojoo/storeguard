(async function () {
  'use strict';
  const session = await SG.boot({ title: 'Shifts & Attendance' });
  if (!session) return;
  const { html, setHTML, money } = SG;
  const main = document.querySelector('main');
  const canAttendance = SG.can('shifts');
  const hist = { start: SG.today(-6), end: SG.today(), user_id: '' };

  setHTML(main, html`
    <div class="page-header">
      <div><h1 class="page-title">Shifts & Attendance</h1><p class="page-subtitle">Who is working, when they clocked in, breaks taken and how each shift closed.</p></div>
      <div class="page-actions"><button class="btn-sg btn-soft" id="refresh"><i class="bi bi-arrow-clockwise"></i> Refresh</button></div>
    </div>
    <div class="stats-grid" id="stats"></div>
    <div class="card-sg flush mb-3"><div class="card-head"><h2 class="card-title"><i class="bi bi-broadcast"></i> Open shifts</h2><span class="card-sub">Live drawer totals</span></div><div id="openTable"></div></div>
    ${canAttendance ? html`<div class="card-sg mb-3"><div class="card-head"><h2 class="card-title"><i class="bi bi-calendar-check"></i> Attendance · last 7 days</h2><div class="legend mb-0"><span><i style="background:var(--emerald-wash);border:1px solid #1f6d4a"></i>On time</span><span><i style="background:var(--amber-wash);border:1px solid var(--amber)"></i>Late</span><span><i style="background:#f3f5f8;border:1px solid #cfd6df"></i>No shift</span></div></div><div id="attendance"><div class="skeleton" style="height:120px"></div></div></div>` : ''}
    <div class="card-sg flush"><div class="card-head"><h2 class="card-title"><i class="bi bi-journal-text"></i> Shift history</h2>
      <div class="d-flex gap-2 flex-wrap align-items-center"><select class="form-select-sg" id="histUser" aria-label="Employee"><option value="">All staff</option></select><input type="date" class="form-input-sg" id="histStart" value="${hist.start}" aria-label="From"><input type="date" class="form-input-sg" id="histEnd" value="${hist.end}" aria-label="To"></div></div><div id="histTable"></div></div>`);

  const shiftCols = [
    { key: 'user_name', label: 'Employee', render: s => html`<div class="cell-flex"><span class="sg-avatar sm">${s.user_initials}</span><div><div class="cell-main">${s.user_name}</div><div class="cell-sub">${SG.roleLabel(s.role)}${s.device_label ? ` · ${s.device_label}` : ''}</div></div></div>` },
    { key: 'opened_at', label: 'Started', render: s => html`${SG.fmtDateTime(s.opened_at)}${s.late_minutes ? html`<div class="cell-sub text-amber">${s.late_minutes} min late</div>` : ''}` },
  ];
  const openTable = new SG.Table(document.getElementById('openTable'), {
    rows: [], pageSize: 20, footer: false, onRowClick: s => SG.showShift(s.id, { onChange: load }),
    empty: { icon: 'bi-moon', title: 'No open shifts', text: 'Cashiers open a shift from the POS before selling.' },
    columns: shiftCols.concat([
      { key: 'elapsed', label: 'Elapsed', render: s => SG.duration((Date.now() - new Date(s.opened_at)) / 60000) },
      { key: 'status', label: 'Status', render: s => s.on_break ? SG.badge('on_break', `On break since ${SG.fmtTime(s.break_started_at)}`) : SG.badge('active', 'Working') },
      { key: 'sales', label: 'Sales', className: 'num', render: s => html`${money(s.totals.sales_total)}<div class="cell-sub">${s.totals.sales_count} txns</div>` },
      { key: 'expected', label: 'Expected cash', className: 'num', render: s => money(s.totals.expected_cash) },
    ]),
  });
  const histTable = new SG.Table(document.getElementById('histTable'), {
    pageSize: 15, onRowClick: s => SG.showShift(s.id, { onChange: load }),
    load: ({ page, perPage }) => SG.api.get('/shifts', { status: 'closed', start: hist.start, end: hist.end, user_id: hist.user_id, page, per_page: perPage }),
    empty: { icon: 'bi-journal', title: 'No closed shifts in this period' },
    columns: shiftCols.concat([
      { key: 'closed_at', label: 'Ended', render: s => SG.fmtDateTime(s.closed_at) },
      { key: 'hours', label: 'Length', render: s => SG.duration((new Date(s.closed_at) - new Date(s.opened_at)) / 60000) },
      { key: 'breaks', label: 'Breaks', render: s => SG.duration(s.totals.break_minutes) },
      { key: 'sales', label: 'Sales', className: 'num', render: s => money(s.totals.sales_total) },
      { key: 'variance', label: 'Variance', className: 'num', render: s => html`<span class="fw-600 ${SG.toNumber(s.variance) < 0 ? 'text-red' : SG.toNumber(s.variance) > 0 ? 'text-amber' : 'text-emerald'}">${money(s.variance, { signed: true })}</span>` },
      { key: 'review_status', label: 'Review', render: s => s.review_status === 'none' ? html`<span class="text-muted-sg small">—</span>` : SG.badge(s.review_status) },
    ]),
  });

  async function loadAttendance() {
    if (!canAttendance) return;
    try {
      const a = await SG.api.get('/attendance', { start: SG.today(-6), end: SG.today() });
      setHTML(document.getElementById('attendance'), html`<div class="table-wrap"><table class="table-sg"><thead><tr><th>Employee</th>${a.days.map(d => html`<th class="text-center">${SG.fmtDay(d)}</th>`)}<th class="num">Shifts</th><th class="num">Hours</th><th class="num">Late</th></tr></thead><tbody>
        ${a.staff.map(r => html`<tr><td><div class="cell-main">${r.name}</div><div class="cell-sub">${SG.roleLabel(r.role)} · ${SG.titleCase(r.shift_pattern)}</div></td>${a.days.map(d => {
          const day = r.days[d];
          if (!day) return html`<td class="text-center"><span class="attendance-cell absent" title="No shift">–</span></td>`;
          return html`<td class="text-center"><span class="attendance-cell ${day.late_minutes ? 'late' : 'present'}" title="Clocked in ${SG.fmtTime(day.clock_in)}${day.late_minutes ? ` (${day.late_minutes} min late)` : ''}">${SG.fmtTime(day.clock_in).slice(0, 2)}</span></td>`;
        })}<td class="num">${r.shifts}</td><td class="num">${r.hours}</td><td class="num ${r.late_count ? 'text-amber fw-600' : ''}">${r.late_count}</td></tr>`)}</tbody></table></div><div class="small-xs text-muted-sg mt-2">Cells show the clock-in hour. Late = started more than 10 minutes after the employee's usual shift start.</div>`);
    } catch (e) { SG.fail(e); }
  }

  async function load() {
    try {
      const open = await SG.api.get('/shifts', { status: 'open', per_page: 100 });
      openTable.setRows(open.items);
      const pending = await SG.api.get('/shifts', { review_status: 'pending', per_page: 1 });
      const onBreak = open.items.filter(s => s.on_break).length;
      const expected = open.items.reduce((n, s) => n + SG.toNumber(s.totals.expected_cash), 0);
      setHTML(document.getElementById('stats'), html`
        <div class="stat-card"><div class="stat-label">Working now <i class="bi bi-person-check"></i></div><div class="stat-value text-emerald">${open.items.length - onBreak}</div><div class="stat-sub">Open shifts</div></div>
        <div class="stat-card"><div class="stat-label">On break <i class="bi bi-cup-hot"></i></div><div class="stat-value text-amber">${onBreak}</div><div class="stat-sub">Currently away</div></div>
        <div class="stat-card"><div class="stat-label">Cash in open drawers <i class="bi bi-safe"></i></div><div class="stat-value">${money(expected)}</div><div class="stat-sub">Expected, live</div></div>
        <div class="stat-card"><div class="stat-label">Variances to review <i class="bi bi-exclamation-diamond"></i></div><div class="stat-value ${pending.total ? 'text-red' : ''}">${pending.total}</div><div class="stat-sub">${pending.total && SG.can('approvals') ? html`<a href="/approvals.html">Review in approvals</a>` : 'Above your threshold'}</div></div>`);
      histTable.reload();
      loadAttendance();
    } catch (e) { SG.fail(e); }
  }

  SG.api.get('/employees').then(r => {
    const sel = document.getElementById('histUser');
    r.employees.forEach(e => sel.insertAdjacentHTML('beforeend', String(html`<option value="${e.id}">${e.name}</option>`)));
  }).catch(() => {});
  document.getElementById('histUser').addEventListener('change', e => { hist.user_id = e.target.value; histTable.reload(true); });
  document.getElementById('histStart').addEventListener('change', e => { hist.start = e.target.value; histTable.reload(true); });
  document.getElementById('histEnd').addEventListener('change', e => { hist.end = e.target.value; histTable.reload(true); });
  document.getElementById('refresh').addEventListener('click', load);
  load();
  setInterval(() => { if (!document.hidden) load(); }, 60000);
})();
