/* Shared shift detail modal. Exposes SG.showShift(id, {onChange}). */
(function () {
  'use strict';
  const { html, money } = SG;
  const ICONS = { open: 'bi-door-open', close: 'bi-door-closed', sale: 'bi-cart-check', refund: 'bi-arrow-return-left', cash_in: 'bi-box-arrow-in-down',
    cash_out: 'bi-box-arrow-up', break: 'bi-cup-hot', break_end: 'bi-play-circle', customer_payment: 'bi-person-check' };

  function timeline(events) {
    if (!events || !events.length) return html`<div class="small text-muted-sg">No activity yet.</div>`;
    return html`<div class="timeline">${events.slice().reverse().map(ev => html`<div class="tl-item ${ev.type}"><div class="fw-600"><i class="bi ${ICONS[ev.type] || 'bi-dot'} me-1 text-muted-sg"></i>${ev.title}</div><div class="small text-muted-sg">${ev.detail}</div><div class="when">${SG.fmtDateTime(ev.at)}</div></div>`)}</div>`;
  }

  function reconciliation(s) {
    const t = s.totals;
    return html`
      <div class="kv-row"><span class="k">Opening cash</span><span class="v">${money(s.opening_cash)}</span></div>
      <div class="kv-row"><span class="k">+ Cash sales</span><span class="v">${money(t.cash_sales)}</span></div>
      ${SG.toNumber(t.customer_cash) ? html`<div class="kv-row"><span class="k">+ Credit repayments (cash)</span><span class="v">${money(t.customer_cash)}</span></div>` : ''}
      <div class="kv-row"><span class="k">− Cash refunds</span><span class="v">${money(-SG.toNumber(t.cash_refunds))}</span></div>
      <div class="kv-row"><span class="k">+ Cash in</span><span class="v">${money(t.cash_in)}</span></div>
      <div class="kv-row"><span class="k">− Cash out</span><span class="v">${money(-SG.toNumber(t.cash_out))}</span></div>
      <div class="kv-row total"><span class="k">Expected in drawer</span><span class="v">${money(s.status === 'closed' ? s.expected_cash_at_close : t.expected_cash)}</span></div>
      ${s.status === 'closed' ? html`<div class="kv-row"><span class="k">Counted</span><span class="v">${money(s.counted_cash)}</span></div>
        <div class="kv-row"><span class="k">Variance</span><span class="v ${SG.toNumber(s.variance) < 0 ? 'text-red' : SG.toNumber(s.variance) > 0 ? 'text-amber' : 'text-emerald'}">${money(s.variance, { signed: true })}</span></div>` : ''}`;
  }

  async function showShift(id, opts = {}) {
    let s;
    try { s = (await SG.api.get(`/shifts/${id}`)).shift; } catch (e) { SG.fail(e); return; }
    const t = s.totals;
    const canClose = s.status === 'open' && (SG.can('shifts') || SG.can('cash')) && s.user_id !== SG.session.user.id;
    const m = SG.modal({ title: `${s.user_name} · ${SG.fmtDate(s.opened_at)}`, icon: 'bi-clock-history', size: 'xl',
      body: html`<div class="d-flex flex-wrap gap-2 mb-3">${SG.badge(s.status)} ${s.on_break ? SG.badge('on_break', 'On break') : ''} ${s.review_status !== 'none' ? SG.badge(s.review_status, `Variance review: ${s.review_status}`) : ''} ${s.late_minutes ? SG.badge('pending', `Started ${s.late_minutes} min late`) : ''}
          <span class="small text-muted-sg ms-auto">${SG.fmtDateTime(s.opened_at)} → ${s.closed_at ? SG.fmtDateTime(s.closed_at) : 'now'}${s.device_label ? ` · ${s.device_label}` : ''}</span></div>
        <div class="stats-grid">
          <div class="stat-card"><div class="stat-label">Sales</div><div class="stat-value">${money(t.sales_total)}</div><div class="stat-sub">${t.sales_count} transactions</div></div>
          <div class="stat-card"><div class="stat-label">Refunds</div><div class="stat-value text-amber">${money(t.refunds_total)}</div><div class="stat-sub">${t.refunds_count} refunds</div></div>
          <div class="stat-card"><div class="stat-label">Breaks</div><div class="stat-value">${SG.duration(t.break_minutes)}</div><div class="stat-sub">${s.breaks.length} break(s)</div></div>
          <div class="stat-card"><div class="stat-label">By method</div><div class="small mt-1">${Object.entries(t.by_method).map(([k, v]) => html`<div class="d-flex justify-content-between"><span>${SG.paymentLabel(k)}</span><b>${money(v)}</b></div>`)}${Object.keys(t.by_method).length ? '' : '—'}</div></div>
        </div>
        <div class="row grid-gap"><div class="col-lg-5"><div class="card-sg"><h3 class="card-title mb-2"><i class="bi bi-calculator"></i> Drawer reconciliation</h3>${reconciliation(s)}
          ${s.denominations ? html`<div class="small text-muted-sg mt-2">Count: ${Object.entries(s.denominations).map(([d, n]) => `${n}×${d}`).join(', ')}</div>` : ''}${s.notes ? html`<div class="notice mt-2"><i class="bi bi-sticky"></i><div>${s.notes}</div></div>` : ''}</div></div>
          <div class="col-lg-7"><div class="card-sg" style="max-height:420px;overflow:auto"><h3 class="card-title mb-3"><i class="bi bi-list-ul"></i> Timeline</h3>${timeline(s.timeline)}</div></div></div>`,
      footer: html`${canClose ? html`<button class="btn-sg btn-danger-soft me-auto" data-close><i class="bi bi-door-closed"></i> Close this shift</button>` : ''}<a class="btn-sg btn-soft" href="/st.html">All sales</a><button class="btn-sg btn-forest" data-bs-dismiss="modal">Done</button>` });
    const close = m.el.querySelector('[data-close]');
    if (close) close.addEventListener('click', () => {
      m.el.addEventListener('hidden.bs.modal', () => SG.formModal({ title: `Close ${s.user_name}'s shift`, icon: 'bi-door-closed', submitText: 'Close shift',
        intro: html`<div class="notice warn"><i class="bi bi-exclamation-triangle"></i><div>Use this when a cashier left without closing. Count the drawer first. Expected: <b>${money(t.expected_cash)}</b>.</div></div>`,
        fields: [{ name: 'counted_cash', label: 'Cash counted in drawer', type: 'money', required: true }, { name: 'notes', label: 'Notes', type: 'textarea', rows: 2 }],
        onSubmit: async v => { await SG.api.post(`/shifts/${s.id}/close`, v); SG.ok('Shift closed.'); if (opts.onChange) opts.onChange(); } }), { once: true });
      m.hide();
    });
  }

  SG.showShift = showShift;
  SG.shiftTimeline = timeline;
  SG.shiftReconciliation = reconciliation;
})();
