(async function () {
  'use strict';
  const session = await SG.boot({ title: 'Approvals' });
  if (!session) return;
  const { html, setHTML, money } = SG;
  const main = document.querySelector('main');
  const KINDS = { refund: { label: 'Refund', icon: 'bi-arrow-return-left' }, expense: { label: 'Expense', icon: 'bi-wallet2' }, cash_variance: { label: 'Cash variance', icon: 'bi-calculator' } };
  const f = { status: 'pending', kind: '' };

  setHTML(main, html`
    <div class="page-header"><div><h1 class="page-title">Approvals</h1><p class="page-subtitle">Requests that need a second pair of eyes. You can't approve your own requests.</p></div></div>
    <div class="stats-grid" id="stats"></div>
    <div class="filters-bar">
      <div class="chip-group" id="statusChips">${[['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['', 'All']].map(([v, l]) => html`<button class="chip ${v === 'pending' ? 'active' : ''}" data-st="${v}">${l}</button>`)}</div>
      <select class="form-select-sg" id="kind" aria-label="Type"><option value="">All types</option>${Object.entries(KINDS).map(([k, v]) => html`<option value="${k}">${v.label}</option>`)}</select>
    </div>
    <div class="card-sg flush"><div id="table"></div></div>`);

  const table = new SG.Table(document.getElementById('table'), {
    pageSize: 20,
    load: ({ page, perPage }) => SG.api.get('/approvals', { ...f, page, per_page: perPage }),
    onLoad: res => {
      const p = res.pending_by_kind || {};
      setHTML(document.getElementById('stats'), html`${Object.entries(KINDS).map(([k, v]) => html`<div class="stat-card"><div class="stat-label">${v.label}s pending <i class="bi ${v.icon}"></i></div><div class="stat-value ${p[k] ? 'text-amber' : ''}">${p[k] || 0}</div></div>`)}`);
    },
    empty: { icon: 'bi-check2-all', title: 'Nothing to review', text: 'Refunds by cashiers, expenses and large cash variances appear here.' },
    onAction: (a, r) => decide(r, a),
    onRowClick: r => view(r),
    columns: [
      { key: 'kind', label: 'Type', render: r => html`<span class="badge-st gray"><i class="bi ${KINDS[r.kind] ? KINDS[r.kind].icon : 'bi-question'}"></i> ${KINDS[r.kind] ? KINDS[r.kind].label : r.kind}</span>` },
      { key: 'summary', label: 'Request', render: r => html`<div class="cell-main">${r.summary}</div><div class="cell-sub">by ${r.requested_by} · ${SG.ago(r.created_at)}</div>` },
      { key: 'amount', label: 'Amount', className: 'num', render: r => html`<b>${money(r.amount)}</b>` },
      { key: 'status', label: 'Status', render: r => html`${SG.badge(r.status)}${r.decided_by ? html`<div class="cell-sub">${r.decided_by}</div>` : ''}` },
      { key: 'a', label: '', className: 'actions', render: r => r.status === 'pending' && (r.requested_by_id !== session.user.id || session.user.role === 'owner')
        ? html`<button class="btn-sg btn-danger-soft sm" data-action="reject">Reject</button> <button class="btn-sg btn-forest sm" data-action="approve">Approve</button>` : '' },
    ],
  });

  function link(r) { return r.entity_type === 'sale' ? `/st.html?sale=${r.entity_id}` : r.entity_type === 'shift' ? null : r.entity_type === 'expense' ? '/expenses.html' : null; }
  function view(r) {
    const href = link(r);
    const m = SG.modal({ title: `${KINDS[r.kind] ? KINDS[r.kind].label : 'Request'} approval`, icon: 'bi-check2-square',
      body: html`<p class="fw-600">${r.summary}</p>
        <div class="kv-row"><span class="k">Amount</span><span class="v">${money(r.amount)}</span></div><div class="kv-row"><span class="k">Requested by</span><span class="v">${r.requested_by}</span></div>
        <div class="kv-row"><span class="k">Requested</span><span class="v">${SG.fmtDateTime(r.created_at)}</span></div><div class="kv-row"><span class="k">Status</span><span class="v">${SG.badge(r.status)}</span></div>
        ${r.decided_by ? html`<div class="kv-row"><span class="k">Decided by</span><span class="v">${r.decided_by} · ${SG.fmtDateTime(r.decided_at)}</span></div>` : ''}
        ${r.decision_note ? html`<div class="notice mt-2"><i class="bi bi-chat-left-text"></i><div>${r.decision_note}</div></div>` : ''}
        ${r.payload && r.payload.notes ? html`<div class="notice mt-2"><i class="bi bi-sticky"></i><div>Cashier note: ${r.payload.notes}</div></div>` : ''}
        ${href ? html`<a class="btn-sg btn-soft sm mt-3" href="${href}"><i class="bi bi-box-arrow-up-right"></i> Open related record</a>` : ''}
        ${r.entity_type === 'shift' ? html`<button class="btn-sg btn-soft sm mt-3" data-shift><i class="bi bi-clock-history"></i> View shift</button>` : ''}`,
      footer: r.status === 'pending' && (r.requested_by_id !== session.user.id || session.user.role === 'owner') ? html`<button class="btn-sg btn-danger-soft" data-d="reject">Reject</button><button class="btn-sg btn-forest" data-d="approve">Approve</button>` : html`<button class="btn-sg btn-soft" data-bs-dismiss="modal">Close</button>` });
    const sb = m.el.querySelector('[data-shift]');
    if (sb) sb.addEventListener('click', () => { m.el.addEventListener('hidden.bs.modal', () => SG.showShift(parseInt(r.entity_id, 10)), { once: true }); m.hide(); });
    m.el.querySelectorAll('[data-d]').forEach(b => b.addEventListener('click', () => { m.el.addEventListener('hidden.bs.modal', () => decide(r, b.dataset.d), { once: true }); m.hide(); }));
  }

  async function decide(r, decision) {
    const what = { refund: 'The refund will be processed and items returned to stock.', expense: 'The expense will count towards your reports.', cash_variance: 'The variance will be accepted and related alerts resolved.' }[r.kind] || '';
    const note = await SG.confirm({ title: decision === 'approve' ? 'Approve request?' : 'Reject request?', message: decision === 'approve' ? `${r.summary}. ${what}` : r.summary,
      confirmText: decision === 'approve' ? 'Approve' : 'Reject', danger: decision === 'reject', input: { label: decision === 'approve' ? 'Note (optional)' : 'Reason for rejecting', required: decision === 'reject' } });
    if (note === null) return;
    try { await SG.api.post(`/approvals/${r.id}/decide`, { decision, note }); SG.ok(`Request ${decision === 'approve' ? 'approved' : 'rejected'}.`); table.reload(); }
    catch (e) { SG.fail(e); }
  }

  document.getElementById('statusChips').addEventListener('click', e => {
    const c = e.target.closest('[data-st]'); if (!c) return;
    document.querySelectorAll('#statusChips .chip').forEach(x => x.classList.toggle('active', x === c)); f.status = c.dataset.st; table.reload(true);
  });
  document.getElementById('kind').addEventListener('change', e => { f.kind = e.target.value; table.reload(true); });
})();
