(async function () {
  'use strict';
  const session = await SG.boot({ title: 'Help & Support' });
  if (!session) return;
  const { html, setHTML } = SG;
  const faq = [
    ['How do I start selling?', 'Open Point of Sale. If asked, count your drawer float and open your shift. Tap products or scan barcodes, choose the payment method and press Charge (F9).'],
    ['What happens if the internet goes down?', 'The POS keeps working. Sales are saved on the device and sync automatically when the connection returns. The banner at the top shows how many are waiting. Do not clear the browser data on a till with unsynced sales.'],
    ['Can I open StoreGuard with no connection at all?', 'Yes, on any device where someone has signed in before. Install StoreGuard as an app (below), sign in once while online, and from then on it opens offline and goes straight to the Point of Sale. Reports and editing wait until the connection is back.'],
    ['How do I install StoreGuard as an app?', 'In Chrome or Edge click "Install app" in the top bar, or the install icon at the right of the address bar. On iPhone/iPad open StoreGuard in Safari, tap Share → Add to Home Screen. On Android use the browser menu → Install app.'],
    ['Can I run StoreGuard on my own store PC?', 'Yes. Download the Windows version from the StoreGuard home page, extract it and double-click "Start StoreGuard". That PC becomes your store\'s own server, so the tills don\'t need the internet, and it backs up your data every day. The READ ME FIRST file inside explains everything.'],
    ['How do refunds work?', 'Open the sale from Sales & Transactions and choose Refund. Pick the items being returned and a reason. Cashiers\' refunds (and large refunds by supervisors) go to a manager for approval; items return to stock once approved.'],
    ['How do I close my shift?', 'Go to My Cash Drawer, count the cash (the denomination counter helps) and submit. Big differences between expected and counted cash are sent to a manager to review.'],
    ['I forgot my password.', 'Ask your owner or manager to reset it from the Employees page. They will give you a temporary password which you can change under My Profile.'],
    ['Why was my account locked?', 'After 5 wrong passwords the account locks for 15 minutes to stop guessing attacks. Wait, or ask a manager to reset your password. Owners who are locked out can contact the developer (below).'],
    ['Who can see what I do?', 'Every sale, refund, stock change and sign-in is recorded with your name in the audit log. Managers and owners can review it.'],
    ['How do I add staff?', 'Owners and managers open Employees → Add employee, choose a role, and share the temporary password privately.'],
  ];
  setHTML(document.querySelector('main'), html`
    <div class="page-header"><div><h1 class="page-title">Help & Support</h1><p class="page-subtitle">Answers to common questions about using StoreGuard.</p></div></div>
    <div class="row grid-gap">
      <div class="col-lg-8"><div class="card-sg"><div class="accordion accordion-flush" id="faq">${faq.map(([q, a], i) => html`<div class="accordion-item"><h2 class="accordion-header"><button class="accordion-button ${i ? 'collapsed' : ''} fw-600" type="button" data-bs-toggle="collapse" data-bs-target="#faq${i}" aria-controls="faq${i}" aria-expanded="${i ? 'false' : 'true'}">${q}</button></h2><div id="faq${i}" class="accordion-collapse collapse ${i ? '' : 'show'}" data-bs-parent="#faq"><div class="accordion-body small">${a}</div></div></div>`)}</div></div></div>
      <div class="col-lg-4">
        <div class="card-sg mb-3"><h2 class="card-title mb-2"><i class="bi bi-laptop" aria-hidden="true"></i> Install &amp; offline</h2>
          <div class="small text-muted-sg mb-3">${window.SGPwa && window.SGPwa.isStandalone() ? 'You\'re using the installed StoreGuard app on this device.' : 'Install StoreGuard on this device so it opens from the desktop or home screen and works offline.'}
            ${SG.offline.pending().length ? html`<br><b class="text-amber">${SG.offline.pending().length} offline sale(s) waiting to sync on this device.</b>` : ''}</div>
          <a class="btn-sg btn-forest sm" href="/#install"><i class="bi bi-download" aria-hidden="true"></i> Install or download</a></div>
        <div class="card-sg mb-3"><h2 class="card-title mb-2"><i class="bi bi-keyboard"></i> POS shortcuts</h2><div class="kv-row"><span class="k">Focus search / scan</span><span class="v mono">F2</span></div><div class="kv-row"><span class="k">Charge</span><span class="v mono">F9</span></div><div class="kv-row"><span class="k">Clear search</span><span class="v mono">Esc</span></div><div class="kv-row"><span class="k">Add scanned item</span><span class="v mono">Enter</span></div></div>
        <div class="card-sg mb-3" id="supportCard"><h2 class="card-title mb-2"><i class="bi bi-headset" aria-hidden="true"></i> Contact the developer</h2>
          <div class="small text-muted-sg mb-2">Still stuck after the answers here? Contact StoreGuard support. Say what you were doing, what you saw (a screenshot helps) and the version below.</div>
          <div id="supportRows" class="small"><div class="kv-row"><span class="k">Website</span><span class="v"><a href="https://nana-kojo.vercel.app" target="_blank" rel="noopener">nana-kojo.vercel.app</a></span></div></div>
          <a class="btn-sg btn-soft sm mt-2" href="/#operate"><i class="bi bi-book" aria-hidden="true"></i> Step-by-step guides</a></div>
        <div class="card-sg"><h2 class="card-title mb-2"><i class="bi bi-info-circle"></i> About</h2><div class="small text-muted-sg">StoreGuard v${SG.VERSION}<br>Retail intelligence. Complete accountability.<br>Signed in to <b>${session.business.name}</b> as ${session.role_label}.</div></div></div>
    </div>`);

  // Developer contact comes from the server's SUPPORT_* settings (cached for offline use by the service worker).
  try {
    const r = await fetch('/support.json', { headers: { Accept: 'application/json' } });
    const info = r.ok ? await r.json() : null;
    if (!info) return;
    const rows = [
      ['Name', info.name ? `${info.name}${info.role ? ` · ${info.role}` : ''}` : '', ''],
      ['Phone', info.phone, info.phone_link],
      ['WhatsApp', info.whatsapp, info.whatsapp_link],
      ['Email', info.email, info.email ? `mailto:${info.email}?subject=${encodeURIComponent(`StoreGuard support · ${session.business.name}`)}` : ''],
      ['Website', info.website && info.website.replace(/^https?:\/\//, '').replace(/\/$/, ''), info.website],
      ['Hours', info.hours, ''],
    ].filter(([, text]) => text);
    setHTML(document.getElementById('supportRows'), html`${rows.map(([k, text, href]) => html`<div class="kv-row"><span class="k">${k}</span><span class="v text-end">${href
      ? html`<a href="${href}" ${/^https?:/.test(href) ? SG.raw('target="_blank" rel="noopener"') : ''}>${text}</a>` : text}</span></div>`)}`);
  } catch (e) { /* offline and not cached: keep the built-in contact */ }
})();
