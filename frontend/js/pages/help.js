(async function () {
  'use strict';
  const session = await SG.boot({ title: 'Help & Support' });
  if (!session) return;
  const { html, setHTML } = SG;
  const faq = [
    ['How do I start selling?', 'Open Point of Sale. If asked, count your drawer float and open your shift. Tap products or scan barcodes, choose the payment method and press Charge (F9).'],
    ['What happens if the internet goes down?', 'The POS keeps working. Sales are saved on the device and sync automatically when the connection returns. The banner at the top shows how many are waiting. Do not clear the browser data on a till with unsynced sales.'],
    ['How do refunds work?', 'Open the sale from Sales & Transactions and choose Refund. Pick the items being returned and a reason. Cashiers\' refunds (and large refunds by supervisors) go to a manager for approval; items return to stock once approved.'],
    ['How do I close my shift?', 'Go to My Cash Drawer, count the cash (the denomination counter helps) and submit. Big differences between expected and counted cash are sent to a manager to review.'],
    ['I forgot my password.', 'Ask your owner or manager to reset it from the Employees page. They will give you a temporary password which you can change under My Profile.'],
    ['Why was my account locked?', 'After 5 wrong passwords the account locks for 15 minutes to stop guessing attacks. Wait, or ask a manager to reset your password.'],
    ['Who can see what I do?', 'Every sale, refund, stock change and sign-in is recorded with your name in the audit log. Managers and owners can review it.'],
    ['How do I add staff?', 'Owners and managers open Employees → Add employee, choose a role, and share the temporary password privately.'],
  ];
  setHTML(document.querySelector('main'), html`
    <div class="page-header"><div><h1 class="page-title">Help & Support</h1><p class="page-subtitle">Answers to common questions about using StoreGuard.</p></div></div>
    <div class="row grid-gap">
      <div class="col-lg-8"><div class="card-sg"><div class="accordion accordion-flush" id="faq">${faq.map(([q, a], i) => html`<div class="accordion-item"><h2 class="accordion-header"><button class="accordion-button ${i ? 'collapsed' : ''} fw-600" type="button" data-bs-toggle="collapse" data-bs-target="#faq${i}" aria-expanded="${i ? 'false' : 'true'}">${q}</button></h2><div id="faq${i}" class="accordion-collapse collapse ${i ? '' : 'show'}" data-bs-parent="#faq"><div class="accordion-body small">${a}</div></div></div>`)}</div></div></div>
      <div class="col-lg-4"><div class="card-sg mb-3"><h2 class="card-title mb-2"><i class="bi bi-keyboard"></i> POS shortcuts</h2><div class="kv-row"><span class="k">Focus search / scan</span><span class="v mono">F2</span></div><div class="kv-row"><span class="k">Charge</span><span class="v mono">F9</span></div><div class="kv-row"><span class="k">Clear search</span><span class="v mono">Esc</span></div><div class="kv-row"><span class="k">Add scanned item</span><span class="v mono">Enter</span></div></div>
        <div class="card-sg"><h2 class="card-title mb-2"><i class="bi bi-info-circle"></i> About</h2><div class="small text-muted-sg">StoreGuard v${SG.VERSION}<br>Retail intelligence. Complete accountability.<br>Signed in to <b>${session.business.name}</b> as ${session.role_label}.<br><br>For technical support contact your system administrator${session.business.email ? html` or <a href="mailto:${session.business.email}">${session.business.email}</a>` : ''}.</div></div></div>
    </div>`);
})();
