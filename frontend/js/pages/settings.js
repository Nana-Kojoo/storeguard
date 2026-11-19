(async function () {
  'use strict';
  const session = await SG.boot({ title: 'Settings' });
  if (!session) return;
  const { html, setHTML } = SG;
  const main = document.querySelector('main');
  let data;
  try { data = await SG.api.get('/settings'); } catch (e) { SG.fail(e); return; }
  const b = data.business, br = data.branch || {};
  const r = SG.receiptOptions(b);
  let logo = r.logo || '';
  const TZ = ['Africa/Accra', 'Africa/Lagos', 'Africa/Abidjan', 'Africa/Nairobi', 'Africa/Johannesburg', 'Africa/Cairo', 'Europe/London', 'UTC'];
  const field = (name, label, value, attrs = '', help = '') => html`<div class="mb-3"><label class="form-label" for="${name}">${label}</label><input class="form-control" id="${name}" name="${name}" value="${value}" ${SG.raw(attrs)}>${help ? html`<div class="form-text">${help}</div>` : ''}</div>`;

  setHTML(main, html`
    <div class="page-header"><div><h1 class="page-title">Settings</h1><p class="page-subtitle">Business details, receipts, tax and loss-prevention thresholds.</p></div></div>
    <form id="settingsForm" novalidate><div class="row grid-gap">
      <div class="col-lg-6"><div class="card-sg h-100"><h2 class="card-title mb-3"><i class="bi bi-shop"></i> Business</h2>
        ${field('name', 'Business name', b.name, 'required maxlength="160"')}
        <div class="row"><div class="col-sm-6">${field('branch_name', 'Branch / store name', br.name || '', 'maxlength="160"')}</div><div class="col-sm-6">${field('phone', 'Phone', b.phone, 'type="tel" maxlength="40"')}</div></div>
        ${field('address', 'Address', b.address, 'maxlength="255"', 'Printed on receipts')}
        ${field('email', 'Contact email', b.email, 'type="email" maxlength="255"')}
        <div class="row"><div class="col-sm-6">${field('currency', 'Currency code', b.currency, 'maxlength="3" style="text-transform:uppercase"', 'e.g. GHS, NGN, USD')}</div>
          <div class="col-sm-6"><div class="mb-3"><label class="form-label" for="timezone">Time zone</label><select class="form-select" id="timezone" name="timezone">${[...new Set([b.timezone, ...TZ])].map(t => html`<option ${t === b.timezone ? SG.raw('selected') : ''}>${t}</option>`)}</select><div class="form-text">Used for "today", reports and shift lateness.</div></div></div></div>
      </div></div>
      <div class="col-lg-6"><div class="card-sg mb-3"><h2 class="card-title mb-3"><i class="bi bi-receipt"></i> Sales & receipts</h2>
        <div class="row"><div class="col-sm-6">${field('tax_rate', 'Tax rate (%)', b.tax_rate, 'type="number" min="0" max="100" step="0.01"', 'Added on top of prices at checkout. 0 to disable.')}</div>
          <div class="col-sm-6">${field('max_discount_pct', 'Max cashier discount (%)', b.max_discount_pct, 'type="number" min="0" max="100" step="0.01"', 'Owners & managers can exceed this.')}</div></div>
        <div class="form-check form-switch"><input class="form-check-input" type="checkbox" id="require_shift_for_sales" name="require_shift_for_sales" ${b.require_shift_for_sales ? SG.raw('checked') : ''}><label class="form-check-label small" for="require_shift_for_sales">Cashiers must open a shift before selling (recommended)</label></div>
      </div>
      <div class="card-sg"><h2 class="card-title mb-3"><i class="bi bi-shield-check"></i> Loss prevention</h2>
        <div class="row"><div class="col-sm-6">${field('refund_approval_threshold', `Refund approval above (${SG.currencySymbol()})`, b.refund_approval_threshold, 'type="number" min="0" step="0.01"', 'Supervisors need a manager above this. Cashiers always need approval.')}</div>
          <div class="col-sm-6">${field('cash_variance_threshold', `Cash variance alert above (${SG.currencySymbol()})`, b.cash_variance_threshold, 'type="number" min="0" step="0.01"', 'Shifts closing further off than this go to review.')}</div></div>
        <div class="form-check form-switch"><input class="form-check-input" type="checkbox" id="low_stock_alerts" name="low_stock_alerts" ${b.low_stock_alerts ? SG.raw('checked') : ''}><label class="form-check-label small" for="low_stock_alerts">Raise alerts for low and out-of-stock products</label></div>
      </div></div>
      <div class="col-12"><div class="card-sg">
        <div class="card-head mb-3"><h2 class="card-title"><i class="bi bi-printer"></i> Receipt design</h2>
          <button type="button" class="btn-sg btn-soft sm" id="testPrint"><i class="bi bi-printer"></i> Print test receipt</button></div>
        <div class="row g-4">
          <div class="col-lg-7">
            <div class="mb-3"><label class="form-label">Logo</label>
              <div class="d-flex align-items-center gap-3 flex-wrap">
                <div class="logo-box" id="logoBox"></div>
                <div><input type="file" class="form-control form-control-sm" id="logoFile" accept="image/png,image/jpeg,image/webp,image/gif" style="max-width:260px">
                  <div class="form-text">PNG or JPG. Black-and-white logos print best on thermal paper.</div>
                  <button type="button" class="btn btn-link btn-sm p-0 text-danger" id="logoRemove">Remove logo</button></div>
              </div></div>
            <div class="row">
              <div class="col-sm-6">${field('r_header', 'Tagline / welcome message', r.header, 'maxlength="120" placeholder="e.g. Quality goods, fair prices"')}</div>
              <div class="col-sm-6">${field('r_tax_id', 'Tax ID (TIN / VAT no.)', r.tax_id, 'maxlength="40" placeholder="e.g. C0012345678"')}</div>
              <div class="col-sm-6">${field('receipt_footer', 'Thank-you message', b.receipt_footer, 'maxlength="255"')}</div>
              <div class="col-sm-6">${field('r_contact_line', 'Contact line', r.contact_line, 'maxlength="120" placeholder="e.g. WhatsApp 024 000 0000 · @myshop"')}</div>
              <div class="col-12"><div class="mb-3"><label class="form-label" for="r_policy">Returns policy</label><textarea class="form-control" id="r_policy" name="r_policy" rows="2" maxlength="255" placeholder="e.g. Goods can be exchanged within 7 days with this receipt.">${r.policy}</textarea></div></div>
              <div class="col-sm-6"><div class="mb-3"><label class="form-label" for="r_paper">Paper size</label><select class="form-select" id="r_paper" name="r_paper">
                ${[['80mm', '80 mm thermal roll (most common)'], ['58mm', '58 mm thermal roll (small)'], ['a4', 'A4 / Letter (office printer)']].map(([v, l]) => html`<option value="${v}" ${r.paper === v ? SG.raw('selected') : ''}>${l}</option>`)}</select></div></div>
              <div class="col-sm-6"><div class="mb-3"><label class="form-label" for="r_copies">Copies per sale</label><select class="form-select" id="r_copies" name="r_copies">
                ${[[1, '1 — customer copy'], [2, '2 — customer + store copy'], [3, '3 — customer, store + office']].map(([v, l]) => html`<option value="${v}" ${Number(r.copies) === v ? SG.raw('selected') : ''}>${l}</option>`)}</select></div></div>
            </div>
            <div class="form-check form-switch mb-3"><input class="form-check-input" type="checkbox" id="r_auto_print" name="r_auto_print" ${r.auto_print ? SG.raw('checked') : ''}><label class="form-check-label small fw-600" for="r_auto_print">Print the receipt automatically as soon as the customer pays</label>
              <div class="form-text">Each till can switch this off from the sale-complete screen (e.g. tills without a printer).</div></div>
            <div class="small fw-600 mb-2">Show on receipt</div>
            <div class="row">${[['show_branch', 'Branch name'], ['show_address', 'Address'], ['show_phone', 'Phone number'], ['show_cashier', 'Cashier name'], ['show_customer', 'Customer name'], ['show_item_count', 'Item count'], ['show_sku', 'Product SKU codes']]
              .map(([k, l]) => html`<div class="col-sm-6 col-xl-4"><div class="form-check"><input class="form-check-input" type="checkbox" id="r_${k}" name="r_${k}" ${r[k] ? SG.raw('checked') : ''}><label class="form-check-label small" for="r_${k}">${l}</label></div></div>`)}</div>
          </div>
          <div class="col-lg-5"><div class="small fw-600 mb-2">Live preview</div><div class="receipt-preview" id="receiptPreview"></div></div>
        </div>
      </div></div>
    </div>
    <div class="notice danger mt-3 d-none" id="err"></div>
    <div class="d-flex justify-content-end gap-2 mt-3"><button type="reset" class="btn-sg btn-soft">Undo changes</button><button type="submit" class="btn-sg btn-forest"><i class="bi bi-check-lg"></i> Save settings</button></div></form>`);

  // ------------------------------------------------------------ receipt designer
  const form = document.getElementById('settingsForm');
  const FLAGS = ['auto_print', 'show_branch', 'show_address', 'show_phone', 'show_cashier', 'show_customer', 'show_item_count', 'show_sku'];
  function receiptFromForm() {
    const el = form.elements;
    const out = { logo, header: el.r_header.value.trim(), tax_id: el.r_tax_id.value.trim(), contact_line: el.r_contact_line.value.trim(),
      policy: el.r_policy.value.trim(), paper: el.r_paper.value, copies: parseInt(el.r_copies.value, 10) };
    FLAGS.forEach(k => { out[k] = el[`r_${k}`].checked; });
    return out;
  }
  function draftBusiness() {
    const el = form.elements;
    return { ...b, name: el.name.value.trim() || b.name, address: el.address.value.trim(), phone: el.phone.value.trim(),
      receipt_footer: el.receipt_footer.value.trim(), tax_rate: el.tax_rate.value, currency: el.currency.value.trim().toUpperCase() || b.currency, receipt: receiptFromForm() };
  }
  const SAMPLE = () => {
    const t = SG.toNumber(form.elements.tax_rate.value);
    const items = [{ product_name: 'Rice 5kg (Royal)', sku: 'RIC-5K-001', quantity: 2, unit_price: '85.00', line_total: '170.00' },
      { product_name: 'Cooking Oil 1L', sku: 'OIL-1L-002', quantity: 1, unit_price: '32.50', line_total: '32.50' },
      { product_name: 'Milo 400g', sku: 'MIL-400-003', quantity: 3, unit_price: '28.00', line_total: '84.00' }];
    const sub = 286.5, disc = 6.5, tax = Math.round((sub - disc) * t) / 100;
    return { reference: 'SG-000123', created_at: new Date().toISOString(), cashier_name: session.user.name, customer_name: 'Ama Mensah', items,
      subtotal: sub, discount: disc, tax, total: sub - disc + tax, payment_method: 'cash', amount_tendered: 300, change_due: 300 - (sub - disc + tax) };
  };
  function paintLogo() {
    setHTML(document.getElementById('logoBox'), logo ? html`<img src="${logo}" alt="Logo preview">` : html`<i class="bi bi-image text-muted-sg"></i>`);
    document.getElementById('logoRemove').classList.toggle('d-none', !logo);
  }
  function paintPreview() {
    const branchName = form.elements.branch_name.value.trim();
    setHTML(document.getElementById('receiptPreview'), SG.receiptHTML(SAMPLE(), draftBusiness(), { branch: branchName }));
  }
  /** Shrink an uploaded logo so it stays small (thermal printers are ~384–576 px wide anyway). */
  function shrinkImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('That file is not a supported image.'));
        img.onload = () => {
          const scale = Math.min(1, 320 / img.width, 160 / img.height);
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * scale)); c.height = Math.max(1, Math.round(img.height * scale));
          const ctx = c.getContext('2d');
          let url = (ctx.drawImage(img, 0, 0, c.width, c.height), c.toDataURL('image/png'));
          if (url.length > 140000) { ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); url = c.toDataURL('image/jpeg', 0.85); }
          if (url.length > 140000) reject(new Error('Logo is too detailed — try a simpler or smaller image.')); else resolve(url);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }
  document.getElementById('logoFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try { logo = await shrinkImage(file); paintLogo(); paintPreview(); } catch (ex) { SG.toast(ex.message, 'error'); }
    e.target.value = '';
  });
  document.getElementById('logoRemove').addEventListener('click', () => { logo = ''; paintLogo(); paintPreview(); });
  document.getElementById('testPrint').addEventListener('click', () => SG.printReceipt(SAMPLE(), draftBusiness(), { branch: form.elements.branch_name.value.trim() }));
  form.addEventListener('input', SG.debounce(paintPreview, 150));
  form.addEventListener('change', paintPreview);
  form.addEventListener('reset', () => setTimeout(() => { logo = r.logo || ''; paintLogo(); paintPreview(); }, 0));
  paintLogo(); paintPreview();

  if (!data.can_edit) document.querySelectorAll('#settingsForm input, #settingsForm select, #settingsForm textarea, #settingsForm button').forEach(el => { el.disabled = true; });
  document.getElementById('testPrint').disabled = false; // anyone may print a test
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const err = document.getElementById('err');
    err.classList.add('d-none');
    const payload = {};
    ['name', 'branch_name', 'phone', 'address', 'email', 'currency', 'timezone', 'tax_rate', 'max_discount_pct', 'receipt_footer', 'refund_approval_threshold', 'cash_variance_threshold']
      .forEach(k => { payload[k] = form.elements[k].value.trim(); });
    payload.require_shift_for_sales = form.elements.require_shift_for_sales.checked;
    payload.low_stock_alerts = form.elements.low_stock_alerts.checked;
    payload.receipt = receiptFromForm();
    const btn = form.querySelector('[type=submit]');
    SG.busy(btn, true, 'Saving…');
    try { await SG.api.patch('/settings', payload); SG.ok('Settings saved. Reloading…'); setTimeout(() => location.reload(), 900); }
    catch (ex) { err.textContent = ex.message; err.classList.remove('d-none'); SG.busy(btn, false); }
  });
})();
