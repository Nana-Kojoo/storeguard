(async function () {
  'use strict';
  const session = await SG.boot({ title: 'Point of Sale' });
  if (!session) return;
  const { html, setHTML, money } = SG;
  const biz = session.business;
  const taxRate = SG.toNumber(biz.tax_rate);
  const maxDiscount = SG.toNumber(biz.max_discount_pct);
  const isManager = ['owner', 'manager'].includes(session.user.role);
  const HELD_KEY = `sg_held_${biz.id}_${session.user.id}`;
  const LAST_KEY = `sg_last_receipt_${biz.id}_${session.user.id}`;

  let products = [];
  let cart = [];          // {product_id, name, price, qty, stock}
  let discount = 0;       // absolute amount
  let customer = null;
  let method = 'cash';
  let category = 'all';
  let term = '';
  let shift = null;

  const $ = id => document.getElementById(id);
  const main = document.querySelector('main');

  setHTML(main, html`
    <div class="offline-banner d-none" id="offlineBanner" role="status"><i class="bi bi-wifi-off"></i><span>You're offline. Sales are saved on this device and will sync automatically.</span></div>
    <div class="offline-banner d-none" id="queueBanner"><i class="bi bi-cloud-upload"></i><span id="queueText"></span><button class="btn-sg btn-soft sm ms-auto" id="syncNow">Sync now</button><button class="btn-sg btn-ghost sm" id="reviewQueue">Review</button></div>
    <div class="pos-toolbar no-print">
      <h1 class="h6 fw-bold m-0"><i class="bi bi-upc-scan text-emerald me-1"></i> Point of Sale</h1>
      <div class="ms-auto d-flex align-items-center gap-2 flex-wrap">
        <span class="sg-pill" id="shiftPill"><i class="bi bi-clock"></i> …</span>
        <button class="btn-sg btn-soft sm" id="lastReceiptBtn" disabled title="Reprint the last receipt"><i class="bi bi-printer"></i> <span class="hide-sm">Last receipt</span></button>
        <button class="btn-sg btn-soft sm" id="heldBtn"><i class="bi bi-pause-circle"></i> Held <b id="heldCount">0</b></button>
      </div>
    </div>
    <div class="pos-main">
      <section class="pos-catalog" aria-label="Products">
        <div class="pos-searchbar">
          <div class="filter-search"><i class="bi bi-upc-scan"></i><input type="search" id="search" placeholder="Search or scan barcode / SKU, then press Enter  (F2)" autocomplete="off" aria-label="Search products"></div>
          <button class="btn-sg btn-soft" id="refreshProducts" title="Reload products"><i class="bi bi-arrow-clockwise"></i></button>
        </div>
        <div class="pos-cats" id="cats" role="tablist"></div>
        <div class="product-grid" id="grid"><div style="grid-column:1/-1">${SG.loader('Stocking the shelves…')}</div></div>
      </section>
      <section class="pos-cart" aria-label="Current sale">
        <div class="cart-head"><h2 class="h6 fw-bold m-0"><i class="bi bi-cart3 text-emerald me-1"></i> Current sale <span class="badge-st gray ms-1" id="itemCount">0 items</span></h2>
          <div class="d-flex gap-1"><button class="btn-sg btn-soft sm" id="holdBtn" title="Hold sale"><i class="bi bi-pause"></i> Hold</button><button class="icon-action danger" id="clearBtn" title="Clear cart" aria-label="Clear cart"><i class="bi bi-trash3"></i></button></div></div>
        <div class="px-3 pt-2"><button class="btn-sg btn-soft sm w-100 justify-content-start" id="customerBtn"><i class="bi bi-person-plus"></i> <span id="customerLabel">Add customer (optional)</span></button></div>
        <div class="cart-items" id="cartItems"></div>
        <div class="cart-summary">
          <div class="kv-row py-1"><span class="k">Subtotal</span><span class="v" id="subtotal">—</span></div>
          <div class="kv-row py-1"><span class="k">Discount ${SG.can('discount') ? html`<button class="btn btn-link btn-sm p-0 ms-1 small" id="discountBtn">edit</button>` : ''}</span><span class="v text-red" id="discount">—</span></div>
          ${taxRate ? html`<div class="kv-row py-1"><span class="k">Tax (${taxRate}%)</span><span class="v" id="tax">—</span></div>` : ''}
          <div class="kv-row total py-2"><span class="k fw-bold text-dark">Total</span><span class="v fs-5" id="total">—</span></div>
          <div class="pay-grid" id="methods">${['cash', 'momo', 'card'].map(m => html`<button type="button" class="pay-btn ${m === 'cash' ? 'active' : ''}" data-method="${m}"><i class="bi ${SG.PAYMENT_ICONS[m]}"></i>${SG.PAYMENT_LABELS[m]}</button>`)}</div>
          <button class="btn-charge" id="chargeBtn" disabled><i class="bi bi-check-circle"></i> <span id="chargeLabel">Charge</span></button>
          <div class="small-xs text-muted-sg text-center mt-2">F2 search · F9 charge · Esc clear search</div>
        </div>
      </section>
    </div>`);

  // ------------------------------------------------------------ data
  async function loadProducts() {
    try {
      products = (await SG.api.get('/products')).products.map(p => ({ ...p, price: SG.toNumber(p.price) }));
      SG.store.set(`sg_products_${biz.id}`, products);
    } catch (e) {
      products = SG.store.get(`sg_products_${biz.id}`, []);
      if (products.length) SG.toast('Showing the product list saved on this device.', 'warning', 'Offline');
      else SG.fail(e);
    }
    renderCats(); renderGrid();
  }

  async function loadShift() {
    try { shift = (await SG.api.get('/shifts/current')).shift; } catch (e) { shift = null; }
    const pill = $('shiftPill');
    if (shift) setHTML(pill, html`<i class="bi bi-circle-fill text-emerald" style="font-size:.5rem"></i> Shift open since ${SG.fmtTime(shift.opened_at)}`);
    else setHTML(pill, html`<i class="bi bi-circle text-amber" style="font-size:.5rem"></i> No open shift`);
    if (!shift && biz.require_shift_for_sales && !isManager) promptOpenShift();
  }

  function promptOpenShift() {
    SG.formModal({
      title: 'Open your shift', icon: 'bi-clock-history', submitText: 'Open shift',
      intro: html`<div class="notice"><i class="bi bi-info-circle"></i><div>Count the cash float in your drawer before you start selling. Every sale is recorded against your shift.</div></div>`,
      fields: [{ name: 'opening_cash', label: 'Opening cash in drawer', type: 'money', required: true },
        { name: 'device_label', label: 'Till / drawer name', placeholder: 'e.g. Till 1', default: SG.store.get('sg_device_name', '') }],
      onSubmit: async v => {
        shift = (await SG.api.post('/shifts/open', v)).shift;
        SG.ok('Shift opened. Happy selling!');
        loadShift();
      },
    });
  }

  async function heartbeat() {
    try {
      const r = await SG.api.post('/devices/heartbeat', { token: SG.store.get('sg_device_token'), name: SG.store.get('sg_device_name') || undefined });
      SG.store.set('sg_device_token', r.token);
      SG.store.set('sg_device_name', r.device.name);
      if (r.device.status === 'blocked') SG.toast('This till has been blocked by a manager. Sales will be refused.', 'error', 'Device blocked');
    } catch (e) { /* offline or no permission */ }
  }

  // ------------------------------------------------------------ catalog
  function renderCats() {
    const cats = [...new Set(products.map(p => p.category))].sort();
    setHTML($('cats'), html`<button class="chip ${category === 'all' ? 'active' : ''}" data-cat="all">All products</button>${cats.map(c => html`<button class="chip ${category === c ? 'active' : ''}" data-cat="${c}">${SG.titleCase(c)}</button>`)}`);
  }
  function filtered() {
    const t = term.toLowerCase();
    return products.filter(p => (category === 'all' || p.category === category) &&
      (!t || p.name.toLowerCase().includes(t) || p.sku.toLowerCase().includes(t) || (p.barcode || '').toLowerCase().includes(t)));
  }
  function renderGrid() {
    const list = filtered();
    if (!list.length) { setHTML($('grid'), html`<div class="empty-state" style="grid-column:1/-1"><i class="bi bi-search"></i><div class="title">${products.length ? 'No products match' : 'No products yet'}</div><div class="small">${products.length ? 'Try another search or category.' : 'Add products on the Inventory page.'}</div></div>`); return; }
    setHTML($('grid'), html`${list.map(p => {
      const inCart = (cart.find(c => c.product_id === p.id) || {}).qty || 0;
      const left = p.stock_quantity - inCart;
      const cls = left <= 0 ? 'out' : left <= p.reorder_level ? 'low' : '';
      return html`<button type="button" class="product-tile" data-id="${p.id}" ${left <= 0 ? SG.raw('disabled') : ''} title="${p.name}">
        ${p.image ? html`<img class="thumb-icon thumb-image" src="${p.image}" alt="">` : html`<span class="thumb-icon"><i class="bi ${SG.CATEGORY_ICONS[p.category] || 'bi-box'}"></i></span>`}
        <span class="nm">${p.name}</span><span class="pr">${money(p.price)}</span>
        <span class="stk ${cls}">${left <= 0 ? 'Out of stock' : `${left} in stock`}</span></button>`;
    })}`);
  }

  // ------------------------------------------------------------ cart
  const subtotal = () => cart.reduce((s, i) => s + i.price * i.qty, 0);
  const round2 = n => Math.round(n * 100) / 100;
  function totals() {
    const sub = round2(subtotal());
    const disc = Math.min(discount, sub);
    const tax = round2((sub - disc) * taxRate / 100);
    return { sub, disc, tax, total: round2(sub - disc + tax) };
  }
  function addToCart(id, qty = 1) {
    const p = products.find(x => x.id === id);
    if (!p) return;
    const line = cart.find(c => c.product_id === id);
    const want = (line ? line.qty : 0) + qty;
    if (want > p.stock_quantity) { SG.toast(`Only ${p.stock_quantity} × ${p.name} available.`, 'warning'); return; }
    if (line) line.qty = want; else cart.push({ product_id: p.id, name: p.name, price: p.price, qty, stock: p.stock_quantity });
    renderCart(); renderGrid();
  }
  function setQty(id, qty) {
    const line = cart.find(c => c.product_id === id);
    if (!line) return;
    if (!Number.isFinite(qty) || qty <= 0) cart = cart.filter(c => c.product_id !== id);
    else if (qty > line.stock) { SG.toast(`Only ${line.stock} × ${line.name} available.`, 'warning'); line.qty = line.stock; }
    else line.qty = qty;
    renderCart(); renderGrid();
  }
  function renderCart() {
    const count = cart.reduce((s, i) => s + i.qty, 0);
    $('itemCount').textContent = `${count} item${count === 1 ? '' : 's'}`;
    if (!cart.length) {
      discount = 0;
      setHTML($('cartItems'), html`<div class="empty-state"><i class="bi bi-cart-x"></i><div class="title">Cart is empty</div><div class="small">Tap a product or scan a barcode.</div></div>`);
    } else {
      setHTML($('cartItems'), html`${cart.map(i => html`<div class="cart-line" data-id="${i.product_id}">
        <div class="min-w-0"><div class="nm text-truncate">${i.name}</div><div class="small-xs text-muted-sg">${money(i.price)} each</div></div>
        <div class="qty-ctrl"><button type="button" data-q="-1" aria-label="Decrease">−</button><input type="number" min="1" max="${i.stock}" value="${i.qty}" aria-label="Quantity"><button type="button" data-q="1" aria-label="Increase">+</button></div>
        <div class="fw-600 tabular text-end" style="min-width:76px">${money(i.price * i.qty)}</div>
        <button type="button" class="icon-action danger" data-remove aria-label="Remove"><i class="bi bi-x-lg"></i></button></div>`)}`);
    }
    const t = totals();
    $('subtotal').textContent = money(t.sub);
    $('discount').textContent = t.disc ? `− ${money(t.disc)}` : money(0);
    if ($('tax')) $('tax').textContent = money(t.tax);
    $('total').textContent = money(t.total);
    if ($('chargeLabel')) $('chargeLabel').textContent = cart.length ? `Charge ${money(t.total)}` : 'Charge';
    $('chargeBtn').disabled = !cart.length;
  }

  // ------------------------------------------------------------ held sales
  const held = () => SG.store.get(HELD_KEY, []);
  function renderHeldCount() { $('heldCount').textContent = held().length; }
  function holdSale() {
    if (!cart.length) { SG.toast('Cart is empty — nothing to hold.', 'warning'); return; }
    const list = held();
    list.push({ id: SG.uuid(), at: new Date().toISOString(), cart, discount, customer, method });
    SG.store.set(HELD_KEY, list);
    resetSale(); renderHeldCount();
    SG.ok('Sale put on hold. Resume it from "Held".');
  }
  function showHeld() {
    const list = held();
    const m = SG.modal({
      title: 'Held sales', icon: 'bi-pause-circle',
      body: list.length ? html`${list.map(h => html`<div class="list-row"><div class="main"><div class="fw-600">${h.cart.length} item(s) · ${money(h.cart.reduce((s, i) => s + i.price * i.qty, 0))}</div><div class="meta"><span>${SG.fmtDateTime(h.at)}</span>${h.customer ? html`<span>${h.customer.name}</span>` : ''}</div></div>
        <button class="btn-sg btn-forest sm" data-resume="${h.id}">Resume</button><button class="icon-action danger" data-drop="${h.id}" aria-label="Discard"><i class="bi bi-trash3"></i></button></div>`)}`
        : html`<div class="empty-state"><i class="bi bi-inbox"></i><div class="title">No held sales</div></div>`,
    });
    m.el.addEventListener('click', e => {
      const resume = e.target.closest('[data-resume]'); const drop = e.target.closest('[data-drop]');
      if (resume) {
        if (cart.length) { SG.toast('Hold or clear the current sale first.', 'warning'); return; }
        const h = held().find(x => x.id === resume.dataset.resume);
        SG.store.set(HELD_KEY, held().filter(x => x.id !== h.id));
        cart = h.cart.filter(i => products.some(p => p.id === i.product_id)).map(i => ({ ...i, stock: (products.find(p => p.id === i.product_id) || {}).stock_quantity || i.stock }));
        discount = h.discount || 0; customer = h.customer; selectMethod(['telecel', 'at'].includes(h.method) ? 'momo' : ['cash', 'momo', 'card'].includes(h.method) ? h.method : 'cash');
        updateCustomerLabel(); renderCart(); renderGrid(); renderHeldCount(); m.hide();
      }
      if (drop) { SG.store.set(HELD_KEY, held().filter(x => x.id !== drop.dataset.drop)); renderHeldCount(); m.hide(); showHeld(); }
    });
  }

  // ------------------------------------------------------------ discount & customer
  function editDiscount() {
    if (!cart.length) { SG.toast('Add items first.', 'warning'); return; }
    const sub = subtotal();
    const limit = isManager ? 100 : maxDiscount;
    SG.formModal({
      title: 'Apply discount', icon: 'bi-percent', submitText: 'Apply',
      intro: html`<div class="small text-muted-sg">Subtotal ${money(sub)}. ${isManager ? 'Large discounts are flagged for review.' : `Your limit is ${limit}% of the subtotal.`}</div>`,
      fields: [{ name: 'mode', label: 'Discount type', type: 'select', col: 6, options: [{ value: 'pct', label: 'Percentage (%)' }, { value: 'amt', label: `Amount (${SG.currencySymbol()})` }] },
        { name: 'value', label: 'Value', type: 'number', col: 6, min: 0, step: '0.01', required: true, default: discount ? round2(discount / sub * 100) : '' }],
      onSubmit: v => {
        const n = parseFloat(v.value);
        if (!Number.isFinite(n) || n < 0) throw new Error('Enter a valid number.');
        const amount = round2(v.mode === 'pct' ? sub * n / 100 : n);
        if (amount > sub) throw new Error('Discount cannot exceed the subtotal.');
        if (amount / sub * 100 > limit + 1e-9) throw new Error(`Discounts above ${limit}% need a manager.`);
        discount = amount; renderCart();
      },
    });
  }
  function updateCustomerLabel() {
    $('customerLabel').textContent = customer ? `${customer.name}${customer.phone ? ' · ' + customer.phone : ''}` : 'Add customer (optional)';
  }
  async function pickCustomer() {
    let list = [];
    try { list = (await SG.api.get('/customers')).customers; } catch (e) { SG.fail(e); return; }
    const m = SG.modal({
      title: 'Select customer', icon: 'bi-person-lines-fill',
      body: html`<div class="filter-search mb-3" style="max-width:none"><i class="bi bi-search"></i><input id="custSearch" placeholder="Search name or phone" autocomplete="off"></div><div id="custList"></div>`,
      footer: html`${customer ? html`<button class="btn-sg btn-ghost me-auto" data-clear>Remove customer</button>` : ''}<button class="btn-sg btn-soft" data-new><i class="bi bi-person-plus"></i> New customer</button>`,
    });
    const paint = q => setHTML(m.el.querySelector('#custList'), html`${list.filter(c => !q || c.name.toLowerCase().includes(q) || c.phone.includes(q)).slice(0, 50).map(c => html`
      <div class="list-row" style="cursor:pointer" data-pick="${c.id}"><div class="main"><div class="fw-600">${c.name}</div><div class="meta"><span>${c.phone || 'No phone'}</span><span>Owes ${money(c.balance)}</span><span>Credit left ${money(c.available_credit)}</span></div></div></div>`)}` || html`<div class="small text-muted-sg">No customers found.</div>`);
    paint('');
    m.el.querySelector('#custSearch').addEventListener('input', e => paint(e.target.value.trim().toLowerCase()));
    m.el.addEventListener('click', e => {
      const pick = e.target.closest('[data-pick]');
      if (pick) { customer = list.find(c => String(c.id) === pick.dataset.pick); updateCustomerLabel(); m.hide(); }
      if (e.target.closest('[data-clear]')) { customer = null; updateCustomerLabel(); m.hide(); }
      if (e.target.closest('[data-new]')) {
        m.hide();
        SG.formModal({ title: 'New customer', icon: 'bi-person-plus', fields: [
          { name: 'name', label: 'Full name', required: true }, { name: 'phone', label: 'Phone', type: 'tel' }],
          onSubmit: async v => { customer = (await SG.api.post('/customers', v)).customer; updateCustomerLabel(); SG.ok('Customer added.'); } });
      }
    });
  }

  // ------------------------------------------------------------ checkout
  function selectMethod(m) {
    method = m;
    document.querySelectorAll('.pay-btn').forEach(b => b.classList.toggle('active', b.dataset.method === m));
  }
  function charge() {
    if (!cart.length) return;
    const t = totals();
    if (method === 'cash') {
      const quick = [...new Set([Math.ceil(t.total), Math.ceil(t.total / 5) * 5, Math.ceil(t.total / 10) * 10, Math.ceil(t.total / 50) * 50, Math.ceil(t.total / 100) * 100, Math.ceil(t.total / 200) * 200])].slice(0, 8);
      const m = SG.formModal({
        title: 'Cash payment', icon: 'bi-cash-stack', submitText: 'Complete sale',
        intro: html`<div class="text-center mb-2"><div class="small text-muted-sg">Amount due</div><div class="fs-3 fw-bold">${money(t.total)}</div></div><div class="cash-keys mb-1">${quick.map(q => html`<button type="button" data-cash="${q}">${q}</button>`)}</div>`,
        fields: [{ name: 'amount_tendered', label: 'Cash received', type: 'money', required: true, default: t.total.toFixed(2) }, { name: 'change', type: 'html', html: html`<div class="kv-row total"><span class="k">Change</span><span class="v" id="changeDue">${money(0)}</span></div>` }],
        onSubmit: async (v, modalRef) => {
          const tendered = parseFloat(v.amount_tendered);
          if (!(tendered >= t.total)) throw new Error('Cash received is less than the amount due.');
          afterHide(modalRef, await submitSale({ amount_tendered: tendered.toFixed(2) }));
        },
      });
      const input = m.el.querySelector('[name=amount_tendered]');
      const upd = () => { const c = parseFloat(input.value) - t.total; m.el.querySelector('#changeDue').textContent = money(c > 0 ? c : 0); };
      input.addEventListener('input', upd);
      m.el.querySelectorAll('[data-cash]').forEach(b => b.addEventListener('click', () => { input.value = b.dataset.cash; upd(); }));
      return;
    }
    {
      const isMomo = method === 'momo';
      const lastNet = SG.store.get('sg_momo_network', 'MTN');
      SG.formModal({
        title: `${SG.paymentLabel(method)} payment`, icon: SG.PAYMENT_ICONS[method], submitText: 'Payment received',
        intro: html`<div class="text-center mb-2"><div class="small text-muted-sg">Amount due</div><div class="fs-3 fw-bold">${money(t.total)}</div></div><div class="notice warn"><i class="bi bi-exclamation-circle"></i><div>Confirm the payment on the ${isMomo ? 'customer\'s phone / merchant SMS' : 'card terminal'} before completing.</div></div>`,
        fields: [
          isMomo ? { name: 'network', type: 'html', html: html`<div class="form-label">Network <span class="text-red">*</span></div>
            <div class="momo-nets" role="radiogroup" aria-label="Mobile money network">${SG.MOMO_NETWORKS.map(n => html`<label class="momo-net"><input type="radio" name="momo_network" value="${n}" ${n === lastNet ? SG.raw('checked') : ''}><span>${n}</span></label>`)}</div>` } : null,
          { name: 'payment_reference', label: 'Transaction ID / reference', placeholder: 'Optional but recommended', maxlength: 70 },
        ].filter(Boolean),
        onSubmit: async (v, modalRef) => {
          let ref = v.payment_reference;
          if (isMomo) {
            const picked = modalRef.el.querySelector('input[name=momo_network]:checked');
            if (!picked) throw new Error('Select the mobile money network.');
            SG.store.set('sg_momo_network', picked.value);
            ref = ref ? `${picked.value} · ${ref}` : picked.value;
          }
          afterHide(modalRef, await submitSale({ payment_reference: ref }));
        },
      });
    }
  }

  /** Show the receipt only once the payment dialog has fully closed (avoids stacked Bootstrap modals). */
  function afterHide(modalRef, result) {
    modalRef.el.addEventListener('hidden.bs.modal', () => showReceipt(result.sale, result.isOffline), { once: true });
  }

  async function submitSale(extra) {
    const t = totals();
    const payload = {
      items: cart.map(i => ({ product_id: i.product_id, quantity: i.qty })), payment_method: method,
      discount: t.disc.toFixed(2), customer_id: customer ? customer.id : null, client_ref: SG.uuid(), ...extra,
    };
    const btn = $('chargeBtn');
    let result;
    // While busy, the button's inner HTML (incl. #chargeLabel) is replaced by a spinner, so the
    // cart must only be reset after the button is restored — otherwise renderCart() hits a null element
    // and the cashier sees an error for a sale that was actually recorded.
    SG.busy(btn, true, 'Processing…');
    try {
      const { sale } = await SG.api.post('/sales', payload);
      result = { sale, isOffline: false };
    } catch (err) {
      if (err.status !== 0) {
        if (err.status === 409) loadProducts(); // stock changed elsewhere — refresh counts
        throw err;
      }
      SG.offline.enqueue({ ...payload, offline: true, occurred_at: new Date().toISOString() });
      result = { isOffline: true, sale: { reference: `OFFLINE-${payload.client_ref.slice(0, 8).toUpperCase()}`, created_at: new Date().toISOString(), cashier_name: session.user.name,
        customer_name: customer ? customer.name : null,
        items: cart.map(i => ({ product_id: i.product_id, product_name: i.name, quantity: i.qty, unit_price: i.price, line_total: i.price * i.qty })),
        subtotal: t.sub, discount: t.disc, tax: t.tax, total: t.total, payment_method: method, payment_reference: extra.payment_reference || '',
        amount_tendered: extra.amount_tendered, change_due: extra.amount_tendered ? SG.toNumber(extra.amount_tendered) - t.total : 0 } };
    } finally { SG.busy(btn, false); }
    // The sale is recorded (server or offline queue). UI refresh must never make it look like it failed.
    try { applyStock(); resetSale(); if (result.isOffline) renderQueue(); } catch (e) { console.error('POS refresh after sale failed', e); }
    return result;
  }
  function applyStock() {
    cart.forEach(i => { const p = products.find(x => x.id === i.product_id); if (p) p.stock_quantity -= i.qty; });
  }
  function resetSale() { cart = []; discount = 0; customer = null; updateCustomerLabel(); selectMethod('cash'); renderCart(); renderGrid(); }
  // Auto-print: business default from Settings → Receipts, overridable per till (e.g. a till with no printer).
  const AUTO_PRINT_KEY = 'sg_auto_print_receipts';
  const autoPrint = () => { const v = SG.store.get(AUTO_PRINT_KEY, null); return v === null ? SG.receiptOptions(biz).auto_print : !!v; };

  function showReceipt(sale, isOffline, reprint = false) {
    // Attach SKUs the server may not know yet (offline sales) so the receipt can show them.
    (sale.items || []).forEach(i => { if (!i.sku) { const p = products.find(x => x.id === i.product_id || x.name === i.product_name); if (p) i.sku = p.sku; } });
    SG.store.set(LAST_KEY, { sale, isOffline });
    $('lastReceiptBtn').disabled = false;
    const m = SG.modal({
      title: reprint ? `Receipt ${sale.reference}` : isOffline ? 'Saved offline' : 'Sale complete', icon: reprint ? 'bi-receipt' : isOffline ? 'bi-cloud-slash' : 'bi-check-circle',
      body: html`${!reprint && !isOffline ? SG.successMark('Payment received') : ''}${isOffline && !reprint ? html`<div class="notice warn mb-3"><i class="bi bi-cloud-slash"></i><div>No connection. This sale is stored on this device and will sync automatically. The final receipt number is assigned on sync.</div></div>` : ''}
        ${!reprint && SG.toNumber(sale.change_due) > 0 ? html`<div class="notice ok mb-3 justify-content-center"><div class="fs-5">Give change: <b>${money(sale.change_due)}</b></div></div>` : ''}
        <div class="receipt-preview">${SG.receiptHTML(sale, biz)}</div>
        <div class="form-check form-switch mt-3 mb-0"><input class="form-check-input" type="checkbox" id="autoPrintToggle" ${autoPrint() ? SG.raw('checked') : ''}><label class="form-check-label small" for="autoPrintToggle">Print receipts automatically when a sale is paid (this till)</label></div>`,
      footer: html`<button class="btn-sg btn-soft" data-print><i class="bi bi-printer"></i> ${reprint || !autoPrint() ? 'Print receipt' : 'Print again'}</button><button class="btn-sg btn-forest" data-bs-dismiss="modal" data-next><i class="bi bi-cart-plus"></i> New sale</button>`,
    });
    m.el.querySelector('[data-print]').addEventListener('click', () => SG.printReceipt(sale, biz));
    m.el.querySelector('#autoPrintToggle').addEventListener('change', e => SG.store.set(AUTO_PRINT_KEY, e.target.checked));
    m.el.addEventListener('hidden.bs.modal', () => $('search').focus());
    // Customer has paid → print straight away (once the dialog is on screen).
    if (!reprint && autoPrint()) m.el.addEventListener('shown.bs.modal', () => SG.printReceipt(sale, biz), { once: true });
  }

  // ------------------------------------------------------------ offline queue
  function renderQueue() {
    const list = SG.offline.pending();
    const failed = list.filter(x => x.error).length;
    $('queueBanner').classList.toggle('d-none', !list.length);
    $('queueText').textContent = `${list.length} offline sale${list.length === 1 ? '' : 's'} waiting to sync${failed ? ` · ${failed} need attention` : ''}`;
  }
  async function syncQueue(manual) {
    if (!SG.offline.pending().length) return;
    const { synced } = await SG.offline.sync();
    if (synced) { SG.ok(`${synced} offline sale${synced === 1 ? '' : 's'} synced.`); loadProducts(); }
    else if (manual) SG.toast(SG.online ? 'Some sales could not sync — review them.' : 'Still offline.', 'warning');
    renderQueue();
  }
  function reviewQueue() {
    const list = SG.offline.pending();
    const m = SG.modal({
      title: 'Offline sales', icon: 'bi-cloud-upload', size: 'lg',
      body: list.length ? html`${list.map(x => html`<div class="list-row"><div class="main"><div class="fw-600">${x.payload.items.length} line(s) · ${SG.paymentLabel(x.payload.payment_method)}</div>
        <div class="meta"><span>Queued ${SG.fmtDateTime(x.queued_at)}</span>${x.error ? html`<span class="text-red">${x.error}</span>` : html`<span>Waiting</span>`}</div></div>
        ${x.error ? html`<button class="btn-sg btn-soft sm" data-retry="${x.payload.client_ref}">Retry</button><button class="btn-sg btn-danger-soft sm" data-discard="${x.payload.client_ref}">Discard</button>` : ''}</div>`)}`
        : html`<div class="empty-state"><i class="bi bi-cloud-check"></i><div class="title">Everything is synced</div></div>`,
    });
    m.el.addEventListener('click', async e => {
      const retry = e.target.closest('[data-retry]'); const discard = e.target.closest('[data-discard]');
      if (retry) { const l = SG.offline.pending(); const x = l.find(i => i.payload.client_ref === retry.dataset.retry); x.error = null; SG.offline.save(l); m.hide(); await syncQueue(true); }
      if (discard && await SG.confirm({ title: 'Discard offline sale?', message: 'The sale will be permanently removed from this device. Make sure the customer was refunded or the sale re-entered.', confirmText: 'Discard', danger: true })) {
        SG.offline.discard(discard.dataset.discard); renderQueue(); m.hide();
      }
    });
  }

  // ------------------------------------------------------------ events
  $('grid').addEventListener('click', e => { const tile = e.target.closest('.product-tile'); if (tile && !tile.disabled) addToCart(parseInt(tile.dataset.id, 10)); });
  $('cats').addEventListener('click', e => { const c = e.target.closest('[data-cat]'); if (c) { category = c.dataset.cat; renderCats(); renderGrid(); } });
  $('search').addEventListener('input', SG.debounce(e => { term = e.target.value.trim(); renderGrid(); }, 120));
  $('search').addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.target.value = ''; term = ''; renderGrid(); }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = e.target.value.trim().toLowerCase();
    if (!code) return;
    const exact = products.find(p => p.sku.toLowerCase() === code || (p.barcode && p.barcode.toLowerCase() === code));
    const list = filtered();
    const hit = exact || (list.length === 1 ? list[0] : null);
    if (hit) { addToCart(hit.id); e.target.value = ''; term = ''; renderGrid(); }
    else SG.toast(`No single product matches "${e.target.value.trim()}".`, 'warning');
  });
  $('cartItems').addEventListener('click', e => {
    const line = e.target.closest('.cart-line'); if (!line) return;
    const id = parseInt(line.dataset.id, 10);
    const item = cart.find(c => c.product_id === id);
    const q = e.target.closest('[data-q]');
    if (q) setQty(id, item.qty + parseInt(q.dataset.q, 10));
    if (e.target.closest('[data-remove]')) setQty(id, 0);
  });
  $('cartItems').addEventListener('change', e => {
    if (e.target.matches('.qty-ctrl input')) setQty(parseInt(e.target.closest('.cart-line').dataset.id, 10), parseInt(e.target.value, 10));
  });
  $('methods').addEventListener('click', e => { const b = e.target.closest('[data-method]'); if (b) selectMethod(b.dataset.method); });
  $('chargeBtn').addEventListener('click', charge);
  $('holdBtn').addEventListener('click', holdSale);
  $('heldBtn').addEventListener('click', showHeld);
  $('lastReceiptBtn').addEventListener('click', () => { const last = SG.store.get(LAST_KEY); if (last) showReceipt(last.sale, last.isOffline, true); });
  if (SG.store.get(LAST_KEY)) $('lastReceiptBtn').disabled = false;
  $('clearBtn').addEventListener('click', async () => { if (cart.length && await SG.confirm({ title: 'Clear sale?', message: 'Remove all items from the current sale?', confirmText: 'Clear', danger: true })) resetSale(); });
  $('customerBtn').addEventListener('click', pickCustomer);
  if ($('discountBtn')) $('discountBtn').addEventListener('click', editDiscount);
  $('refreshProducts').addEventListener('click', () => { setHTML($('grid'), html`<div style="grid-column:1/-1">${SG.loader('Restocking the shelves…')}</div>`); loadProducts(); });
  $('syncNow').addEventListener('click', () => syncQueue(true));
  $('reviewQueue').addEventListener('click', reviewQueue);
  document.addEventListener('keydown', e => {
    if (e.key === 'F2') { e.preventDefault(); $('search').focus(); }
    if (e.key === 'F9' && !document.querySelector('.modal.show')) { e.preventDefault(); charge(); }
  });
  document.addEventListener('sg:connectivity', e => {
    $('offlineBanner').classList.toggle('d-none', e.detail.online);
    if (e.detail.online) syncQueue(false);
  });
  window.addEventListener('beforeunload', e => { if (cart.length) { e.preventDefault(); e.returnValue = ''; } });

  // ------------------------------------------------------------ init
  renderCart(); renderHeldCount(); renderQueue();
  if (!navigator.onLine) $('offlineBanner').classList.remove('d-none');
  await Promise.all([loadProducts(), loadShift(), heartbeat()]);
  syncQueue(false);
  setInterval(() => { syncQueue(false); }, 30000);
  setInterval(heartbeat, 300000);
  $('search').focus();
})();
