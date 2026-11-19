(async function () {
  'use strict';
  const session = await SG.boot({ title: 'My Refunds' });
  if (!session) return;
  const { html, setHTML, money } = SG;
  const main = document.querySelector('main');

  setHTML(main, html`
    <div class="page-header"><div><h1 class="page-title">My Refunds</h1><p class="page-subtitle">Refunds you've processed or requested. To start a refund, open the sale from your transactions.</p></div>
      <div class="page-actions"><a class="btn-sg btn-forest" href="/st.html"><i class="bi bi-search"></i> Find a sale to refund</a></div></div>
    <div class="notice mb-3"><i class="bi bi-info-circle"></i><div>${SG.can('refund') ? `Refunds above ${money(session.business.refund_approval_threshold)} need a manager's approval.` : 'Your refunds are sent to a manager for approval before money is returned. You will see the decision here and in your notifications.'}</div></div>
    <div class="card-sg flush mb-3"><div class="card-head"><h2 class="card-title"><i class="bi bi-hourglass-split"></i> Awaiting approval</h2></div><div id="pending"></div></div>
    <div class="card-sg flush"><div class="card-head"><h2 class="card-title"><i class="bi bi-arrow-return-left"></i> Completed refunds</h2></div><div id="done"></div></div>`);

  const pendingTable = new SG.Table(document.getElementById('pending'), {
    rows: [], pageSize: 10, footer: false, empty: { icon: 'bi-check2-all', title: 'No pending requests' },
    onRowClick: a => { location.href = `/st.html?sale=${a.entity_id}`; },
    columns: [{ key: 'created_at', label: 'Requested', render: a => SG.fmtDateTime(a.created_at) }, { key: 'summary', label: 'Request', render: a => html`<span class="small">${a.summary}</span>` },
      { key: 'amount', label: 'Amount', className: 'num', render: a => money(a.amount) }, { key: 'status', label: 'Status', render: a => SG.badge(a.status) }],
  });
  new SG.Table(document.getElementById('done'), {
    pageSize: 15,
    load: async ({ page, perPage }) => {
      const res = await SG.api.get('/refunds', { mine: 1, page, per_page: perPage });
      pendingTable.setRows(res.pending.filter(a => a.status === 'pending' && a.requested_by_id === session.user.id));
      return res;
    },
    empty: { icon: 'bi-arrow-return-left', title: 'No refunds yet' },
    onRowClick: r => { location.href = `/st.html?sale=${r.sale_id}`; },
    columns: [
      { key: 'created_at', label: 'When', render: r => SG.fmtDateTime(r.created_at) }, { key: 'sale_reference', label: 'Sale', render: r => html`<span class="mono">${r.sale_reference}</span>` },
      { key: 'items', label: 'Items', render: r => html`<span class="small">${r.items.map(i => `${i.quantity}× ${i.product_name}`).join(', ')}</span>` },
      { key: 'reason', label: 'Reason', render: r => html`<span class="small">${r.reason}</span>` }, { key: 'method', label: 'Method', render: r => SG.paymentLabel(r.method) },
      { key: 'amount', label: 'Amount', className: 'num', render: r => html`<b>${money(r.amount)}</b>` },
    ],
  });
})();
