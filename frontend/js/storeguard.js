/* StoreGuard core client library. Every page loads this before its own script. */
(function () {
  'use strict';

  const VERSION = '3.1.0';
  // offlineBoot: the page opened with no connection using the session saved on this device.
  const state = { session: null, csrf: null, online: navigator.onLine, offlineBoot: false };

  // ------------------------------------------------------------------ safe HTML
  class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, ch => ESC[ch]);
  }
  function fragment(value) {
    if (value instanceof Raw) return value.s;
    if (Array.isArray(value)) return value.map(fragment).join('');
    if (value === false || value === null || value === undefined) return '';
    return esc(value);
  }
  /** Tagged template: interpolations are escaped unless they are nested html`` / raw() values. */
  function html(strings, ...values) {
    let out = strings[0];
    values.forEach((v, i) => { out += fragment(v) + strings[i + 1]; });
    return new Raw(out);
  }
  const raw = s => new Raw(String(s));
  function setHTML(el, content) { el.innerHTML = fragment(content); return el; }

  // ------------------------------------------------------------------ formatting
  const SYMBOLS = { GHS: 'GH₵', NGN: '₦', USD: '$', EUR: '€', GBP: '£', KES: 'KSh', ZAR: 'R', XOF: 'CFA' };
  // Methods offered for new payments. Telecel Cash / AT Money are now part of Mobile Money (network chosen at payment).
  const PAYMENT_LABELS = { cash: 'Cash', momo: 'Mobile Money', card: 'Card', credit: 'Credit', bank: 'Bank transfer' };
  // Labels for old records saved before the merge.
  const LEGACY_PAYMENT_LABELS = { telecel: 'Mobile Money (Telecel)', at: 'Mobile Money (AirtelTigo)' };
  const PAYMENT_ICONS = { cash: 'bi-cash-stack', momo: 'bi-phone', telecel: 'bi-phone', at: 'bi-phone', card: 'bi-credit-card', credit: 'bi-journal-check', bank: 'bi-bank' };
  const MOMO_NETWORKS = ['MTN', 'Telecel', 'AirtelTigo'];
  const CATEGORY_ICONS = { food: 'bi-basket', beverages: 'bi-cup-straw', household: 'bi-house', personal: 'bi-heart', snacks: 'bi-cookie', dairy: 'bi-cup', bakery: 'bi-basket2', frozen: 'bi-snow', general: 'bi-box' };
  const ROLE_LABELS = { owner: 'Owner', manager: 'Manager', supervisor: 'Supervisor', cashier: 'Cashier', inventory_officer: 'Stock Clerk', security: 'Security' };

  function business() { return (state.session && state.session.business) || { currency: 'GHS', timezone: undefined }; }
  function currencySymbol() { const c = business().currency || 'GHS'; return SYMBOLS[c] || c + ' '; }
  const numberFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
  function toNumber(v) { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : 0; }
  function money(v, opts = {}) {
    const n = toNumber(v);
    const sign = n < 0 ? '−' : (opts.signed && n > 0 ? '+' : '');
    return `${sign}${currencySymbol()} ${numberFmt.format(Math.abs(n))}`;
  }
  function moneyCompact(v) { return `${currencySymbol()} ${compactFmt.format(toNumber(v))}`; }
  function int(v) { return new Intl.NumberFormat('en-US').format(Math.round(toNumber(v))); }
  function tz() { try { const t = business().timezone; if (t) { new Intl.DateTimeFormat('en', { timeZone: t }); return t; } } catch (e) { /* invalid tz */ } return undefined; }
  function asDate(v) { return v instanceof Date ? v : new Date(v); }
  function fmtDate(v) { if (!v) return '—'; return asDate(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: tz() }); }
  function fmtTime(v) { if (!v) return '—'; return asDate(v).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz() }); }
  function fmtDateTime(v) { if (!v) return '—'; return `${fmtDate(v)}, ${fmtTime(v)}`; }
  function fmtDay(isoDate) { const [y, m, d] = isoDate.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); }
  function ago(v) {
    if (!v) return '—';
    const s = Math.round((Date.now() - asDate(v).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 604800) return `${Math.floor(s / 86400)} d ago`;
    return fmtDate(v);
  }
  function duration(minutes) { const m = Math.max(0, Math.round(minutes)); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; }
  /** Today's date (YYYY-MM-DD) in the business timezone. */
  function today(offsetDays = 0) {
    const d = new Date(Date.now() + offsetDays * 86400000);
    const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz() }).formatToParts(d);
    const get = t => parts.find(p => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }
  const titleCase = s => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const paymentLabel = m => PAYMENT_LABELS[m] || LEGACY_PAYMENT_LABELS[m] || titleCase(m);
  /** Mobile money references are stored as "MTN · TX123": split into "Mobile Money (MTN)" + "TX123". */
  function splitMomoRef(method, reference) {
    const ref = reference || '';
    if (method !== 'momo') return { label: paymentLabel(method), ref };
    const m = ref.match(/^(MTN|Telecel|AirtelTigo)(?:\s·\s(.*))?$/);
    return m ? { label: `Mobile Money (${m[1]})`, ref: m[2] || '' } : { label: paymentLabel(method), ref };
  }
  const roleLabel = r => ROLE_LABELS[r] || titleCase(r);

  const STATUS_TONES = {
    completed: 'green', active: 'green', approved: 'green', received: 'green', resolved: 'green', open: 'amber', in: 'green',
    partially_refunded: 'amber', pending: 'amber', ordered: 'blue', investigating: 'blue', on_break: 'amber', low: 'amber',
    refunded: 'gray', closed: 'gray', off_shift: 'gray', dismissed: 'gray', cancelled: 'gray', none: 'gray',
    voided: 'red', rejected: 'red', suspended: 'red', blocked: 'red', out: 'red', critical: 'red', warning: 'amber', info: 'blue',
  };
  function badge(status, label) { return html`<span class="badge-st ${STATUS_TONES[status] || 'gray'}">${label || titleCase(status)}</span>`; }

  // ------------------------------------------------------------------ storage (never throws)
  const store = {
    get(key, fallback = null) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; } },
    remove(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } },
  };

  /**
   * The last signed-in session, kept on this device so the app (especially the POS) can open
   * when the connection is down. It holds no credentials: the server still checks the session
   * cookie on every request, and this copy is cleared on sign-out or when the server says 401.
   */
  const sessionCache = {
    KEY: 'sg_session_cache',
    save(session) { const copy = Object.assign({}, session); delete copy.csrf_token; store.set(this.KEY, { session: copy, saved_at: new Date().toISOString() }); },
    load() { const v = store.get(this.KEY); return v && v.session && v.session.user ? v : null; },
    clear() { store.remove(this.KEY); },
  };

  // ------------------------------------------------------------------ API
  class ApiError extends Error { constructor(message, status, body) { super(message); this.status = status; this.body = body; } }

  function qs(params) {
    const p = new URLSearchParams();
    Object.entries(params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, v); });
    const s = p.toString();
    return s ? `?${s}` : '';
  }

  // Top-of-screen progress bar: shown only while a request has been running for >250ms,
  // so quick calls and background polling don't make it flicker.
  const progress = {
    active: 0, timer: null, el: null,
    bar() {
      if (!this.el) { this.el = document.createElement('div'); this.el.className = 'sg-progress'; this.el.setAttribute('aria-hidden', 'true'); }
      if (!this.el.isConnected) document.body.appendChild(this.el);
      return this.el;
    },
    start() {
      this.active += 1;
      if (this.active === 1 && document.body) this.timer = setTimeout(() => this.bar().classList.add('on'), 250);
    },
    done() {
      this.active = Math.max(0, this.active - 1);
      if (!this.active) { clearTimeout(this.timer); if (this.el) this.el.classList.remove('on'); }
    },
  };

  async function request(path, opts = {}) {
    progress.start();
    try { return await doRequest(path, opts); } finally { progress.done(); }
  }

  async function doRequest(path, { method = 'GET', body, params, quiet401 = false } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) headers['X-CSRF-Token'] = state.csrf;
    const device = store.get('sg_device_token');
    if (device) headers['X-Device-Token'] = device;
    let response;
    try {
      response = await fetch(`/api${path}${qs(params)}`, {
        method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (networkError) {
      setOnline(false);
      throw new ApiError('Cannot reach the server. Check your connection.', 0);
    }
    setOnline(true);
    const data = await response.json().catch(() => ({}));
    if (data && data.csrf_token) state.csrf = data.csrf_token;
    if (response.status === 401) sessionCache.clear();
    if (response.status === 401 && !quiet401 && !location.pathname.endsWith('/auth.html')) {
      const next = encodeURIComponent(location.pathname + location.search);
      location.href = `/auth.html?next=${next}&expired=1`;
      throw new ApiError('Your session has ended. Please sign in again.', 401);
    }
    if (!response.ok) throw new ApiError(data.error || `Request failed (${response.status})`, response.status, data);
    return data;
  }
  const api = {
    get: (path, params) => request(path, { params }),
    post: (path, body = {}) => request(path, { method: 'POST', body }),
    patch: (path, body = {}) => request(path, { method: 'PATCH', body }),
    del: path => request(path, { method: 'DELETE' }),
    request,
  };

  // ------------------------------------------------------------------ toasts / dialogs
  function toastHost() {
    let host = document.querySelector('.sg-toasts');
    if (!host) { host = document.createElement('div'); host.className = 'sg-toasts'; host.setAttribute('aria-live', 'polite'); document.body.appendChild(host); }
    return host;
  }
  function toast(message, type = 'success', title) {
    const icons = { success: 'bi-check-circle-fill text-emerald', error: 'bi-x-octagon-fill text-red', warning: 'bi-exclamation-triangle-fill text-amber', info: 'bi-info-circle-fill text-primary' };
    const el = document.createElement('div');
    el.className = `sg-toast ${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    setHTML(el, html`<i class="bi ${icons[type] || icons.info}"></i><div>${title ? html`<div class="t">${title}</div>` : ''}<div class="${title ? 'm' : ''}">${message}</div></div><button type="button" aria-label="Dismiss"><i class="bi bi-x"></i></button>`);
    el.querySelector('button').addEventListener('click', () => el.remove());
    toastHost().appendChild(el);
    setTimeout(() => el.remove(), type === 'error' ? 7000 : 4000);
  }
  const ok = (m, t) => toast(m, 'success', t);
  function fail(err, fallback) {
    const message = err && err.message ? err.message : (fallback || 'Something went wrong');
    const offlineErr = err && err.status === 0;
    const stuck = document.querySelector('main [data-boot-loader]');
    // When offline, the page explains itself below; don't also stack a red toast for every failed request.
    if (!(offlineErr && (stuck || state.offlineBoot))) toast(message, offlineErr ? 'warning' : 'error');
    // If the page never got past its initial loader, replace it so it doesn't spin forever.
    if (stuck) {
      const posLink = offlineErr && can('pos') && location.pathname !== '/pos.html';
      setHTML(stuck.parentElement, html`<div class="card-sg"><div class="empty-state"><i class="bi ${offlineErr ? 'bi-wifi-off' : 'bi-cloud-slash'}"></i>
        <div class="title">${offlineErr ? 'This page needs a connection' : 'Couldn\'t load this page'}</div>
        <div class="small mb-3">${offlineErr ? 'StoreGuard can\'t reach the server right now. This page will work again as soon as the connection is back.' + (can('pos') ? ' The Point of Sale keeps selling offline.' : '') : message}</div>
        <div class="d-flex gap-2 justify-content-center flex-wrap"><button class="btn-sg btn-forest" type="button" data-reload><i class="bi bi-arrow-clockwise"></i> Retry</button>
        ${posLink ? html`<a class="btn-sg btn-soft" href="/pos.html"><i class="bi bi-upc-scan"></i> Open Point of Sale</a>` : ''}</div></div></div>`);
      document.querySelector('main [data-reload]').addEventListener('click', () => location.reload());
    }
  }

  /** Create a Bootstrap modal from markup. Removed from DOM when hidden. */
  function modal({ title, body, footer, size = '', icon = '', staticBackdrop = false }) {
    const el = document.createElement('div');
    el.className = 'modal fade';
    el.tabIndex = -1;
    if (staticBackdrop) { el.dataset.bsBackdrop = 'static'; }
    setHTML(el, html`<div class="modal-dialog modal-dialog-centered modal-dialog-scrollable ${size ? 'modal-' + size : ''}"><div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">${icon ? html`<i class="bi ${icon} me-2 text-forest"></i>` : ''}${title}</h5>
      <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>
      <div class="modal-body">${body || ''}</div>
      ${footer ? html`<div class="modal-footer">${footer}</div>` : ''}</div></div>`);
    document.body.appendChild(el);
    const instance = new bootstrap.Modal(el);
    el.addEventListener('hidden.bs.modal', () => { instance.dispose(); el.remove(); });
    instance.show();
    return { el, hide: () => instance.hide(), body: el.querySelector('.modal-body') };
  }

  /** Confirmation dialog. With `input`, resolves to the entered text (or null when cancelled). */
  function confirmDialog({ title = 'Are you sure?', message = '', confirmText = 'Confirm', danger = false, input = null }) {
    return new Promise(resolve => {
      let settled = false;
      const field = input ? html`<label class="form-label mt-2" for="sgConfirmInput">${input.label}</label>
        ${input.type === 'select' ? html`<select class="form-select" id="sgConfirmInput">${input.options.map(o => html`<option>${o}</option>`)}</select>`
          : html`<textarea class="form-control" id="sgConfirmInput" rows="2" maxlength="${input.max || 255}" placeholder="${input.placeholder || ''}"></textarea>`}
        <div class="field-error d-none" id="sgConfirmErr">This field is required.</div>` : '';
      const m = modal({
        title, icon: danger ? 'bi-exclamation-triangle' : 'bi-question-circle',
        body: html`<p class="mb-0" style="font-size:.88rem">${message}</p>${field}`,
        footer: html`<button type="button" class="btn-sg btn-soft" data-bs-dismiss="modal">Cancel</button>
          <button type="button" class="btn-sg ${danger ? 'btn-danger' : 'btn-forest'}" data-ok>${confirmText}</button>`,
      });
      m.el.querySelector('[data-ok]').addEventListener('click', () => {
        if (input) {
          const v = m.el.querySelector('#sgConfirmInput').value.trim();
          if (input.required && !v) { m.el.querySelector('#sgConfirmErr').classList.remove('d-none'); return; }
          settled = true; resolve(v); m.hide(); return;
        }
        settled = true; resolve(true); m.hide();
      });
      m.el.addEventListener('hidden.bs.modal', () => { if (!settled) resolve(input ? null : false); });
    });
  }

  function shrinkImage(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
        reject(new Error('Choose a PNG, JPEG, WebP or GIF image.'));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read that image.'));
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error('That image could not be loaded.'));
        image.onload = () => {
          const scale = Math.min(1, 640 / image.width, 640 / image.height);
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          const context = canvas.getContext('2d');
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          const output = canvas.toDataURL('image/jpeg', 0.82);
          if (output.length > 180000) reject(new Error('Image is too detailed — choose a smaller or simpler image.'));
          else resolve(output);
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function fieldControl(f, value) {
    const id = `f_${f.name}`;
    const common = html`id="${id}" name="${f.name}" ${f.required ? raw('required') : ''} ${f.disabled ? raw('disabled') : ''}`;
    const v = value === undefined || value === null ? (f.default ?? '') : value;
    switch (f.type) {
      case 'select':
        return html`<select class="form-select" ${common}>${(f.options || []).map(o => {
          const opt = typeof o === 'object' ? o : { value: o, label: o };
          return html`<option value="${opt.value}" ${String(opt.value) === String(v) ? raw('selected') : ''}>${opt.label}</option>`;
        })}</select>`;
      case 'multiselect': {
        const selected = Array.isArray(v) ? v.map(String) : [];
        const opts = f.options || [];
        if (!opts.length) return html`<div class="form-text" id="${id}">${f.emptyText || 'No options available.'}</div>`;
        return html`<div class="check-list" id="${id}" role="group">${opts.map((o, i) => {
          const opt = typeof o === 'object' ? o : { value: o, label: o };
          return html`<label class="check-pill" for="${id}_${i}"><input type="checkbox" id="${id}_${i}" name="${f.name}" value="${opt.value}" ${selected.includes(String(opt.value)) ? raw('checked') : ''}><span>${opt.label}</span></label>`;
        })}</div>`;
      }
      case 'textarea':
        return html`<textarea class="form-control" rows="${f.rows || 3}" maxlength="${f.max || 500}" ${common} placeholder="${f.placeholder || ''}">${v}</textarea>`;
      case 'checkbox':
        return html`<div class="form-check form-switch"><input class="form-check-input" type="checkbox" ${common} ${v ? raw('checked') : ''}><label class="form-check-label small" for="${id}">${f.checkLabel || ''}</label></div>`;
      case 'money':
        return html`<div class="input-group"><span class="input-group-text">${currencySymbol()}</span><input class="form-control" type="number" step="0.01" min="${f.min ?? 0}" ${common} value="${v}" placeholder="${f.placeholder || '0.00'}"></div>`;
      case 'html':
        return f.html;
      case 'image':
        return html`<div class="image-upload-field" data-image-field="${f.name}">
          <div class="image-preview-wrap">${value ? html`<img class="image-preview" src="${value}" alt="">` : html`<div class="image-preview-placeholder"><i class="bi bi-image"></i></div>`}</div>
          <div class="d-flex align-items-center gap-2 mt-2">
            <input class="form-control form-control-sm" type="file" accept="image/png,image/jpeg,image/webp,image/gif" id="${id}" name="${f.name}">
            ${value ? html`<button type="button" class="btn-sg btn-soft sm" data-image-remove="${f.name}">Remove</button>` : ''}
          </div>
        </div>`;
      default:
        return html`<input class="form-control" type="${f.type || 'text'}" ${common} value="${v}" placeholder="${f.placeholder || ''}"
          ${f.min !== undefined ? html`min="${f.min}"` : ''} ${f.max !== undefined && f.type === 'number' ? html`max="${f.max}"` : ''}
          ${f.maxlength ? html`maxlength="${f.maxlength}"` : ''} ${f.step ? html`step="${f.step}"` : ''} ${f.autocomplete ? html`autocomplete="${f.autocomplete}"` : ''}
          ${f.list ? html`list="dl_${f.name}"` : ''}>${f.list ? html`<datalist id="dl_${f.name}">${f.list.map(o => html`<option value="${o}">`)}</datalist>` : ''}`;
    }
  }

  /**
   * Generated form in a modal. fields: [{name,label,type,options,required,col,help,...}].
   * onSubmit(values) may return a promise; throwing shows the error inline and keeps the modal open.
   */
  function formModal({ title, icon, fields, values = {}, submitText = 'Save', size = '', onSubmit, intro }) {
    const body = html`${intro ? html`<div class="mb-3">${intro}</div>` : ''}<form novalidate><div class="row g-3">${fields.map(f => f.type === 'hidden' ? '' : html`
      <div class="col-${f.col || 12} ${f.colClass || ''}">${f.type !== 'checkbox' && f.label ? html`<label class="form-label" for="f_${f.name}">${f.label}${f.required ? html` <span class="text-red">*</span>` : ''}</label>` : (f.type === 'checkbox' && f.label ? html`<div class="form-label">${f.label}</div>` : '')}
      ${fieldControl(f, values[f.name])}${f.help ? html`<div class="form-text">${f.help}</div>` : ''}</div>`)}</div>
      <div class="notice danger mt-3 d-none" data-error></div><button type="submit" class="d-none"></button></form>`;
    const m = modal({
      title, icon, size, body,
      footer: html`<button type="button" class="btn-sg btn-soft" data-bs-dismiss="modal">Cancel</button>
        <button type="button" class="btn-sg btn-forest" data-submit><i class="bi bi-check-lg"></i> ${submitText}</button>`,
    });
    const form = m.el.querySelector('form');
    const errorBox = m.el.querySelector('[data-error]');
    const submitBtn = m.el.querySelector('[data-submit]');
    const collect = async () => {
      const out = {};
      for (const f of fields) {
        if (f.type === 'html') continue;
        if (f.type === 'hidden') { out[f.name] = values[f.name]; continue; }
        if (f.type === 'multiselect') {
          out[f.name] = [...form.querySelectorAll('input[type="checkbox"]:checked')].filter(i => i.name === f.name).map(i => i.value);
          continue;
        }
        const input = form.elements[f.name];
        if (!input) return;
        if (f.type === 'image') {
          const box = form.querySelector(`[data-image-field="${f.name}"]`);
          if (input.files && input.files[0]) out[f.name] = await shrinkImage(input.files[0]);
          else out[f.name] = box.dataset.removed === '1' ? '' : (values[f.name] || '');
        } else {
          out[f.name] = f.type === 'checkbox' ? input.checked : (typeof input.value === 'string' ? input.value.trim() : input.value);
        }
      }
      return out;
    };
    m.el.querySelectorAll('[data-image-remove]').forEach(button => button.addEventListener('click', () => {
      const field = button.dataset.imageRemove;
      const box = m.el.querySelector(`[data-image-field="${field}"]`);
      box.dataset.removed = '1';
      setHTML(box.querySelector('.image-preview-wrap'), html`<div class="image-preview-placeholder"><i class="bi bi-image"></i></div>`);
      const input = form.elements[field];
      if (input) input.value = '';
      button.remove();
    }));
    m.el.querySelectorAll('[data-image-field] input[type=file]').forEach(input => input.addEventListener('change', async () => {
      if (!input.files[0]) return;
      try {
        const image = await shrinkImage(input.files[0]);
        const box = input.closest('[data-image-field]');
        box.dataset.removed = '0';
        setHTML(box.querySelector('.image-preview-wrap'), html`<img class="image-preview" src="${image}" alt="">`);
      } catch (err) { toast(err.message, 'error'); input.value = ''; }
    }));
    async function submit(e) {
      if (e) e.preventDefault();
      errorBox.classList.add('d-none');
      const missing = fields.find(f => f.required && f.type !== 'checkbox' && form.elements[f.name] && !String(form.elements[f.name].value).trim());
      if (missing) { errorBox.textContent = `${missing.label} is required.`; errorBox.classList.remove('d-none'); form.elements[missing.name].focus(); return; }
      submitBtn.disabled = true;
      try {
        const result = await onSubmit(await collect(), m);
        if (result !== false) m.hide();
      } catch (err) {
        errorBox.textContent = err.message || 'Could not save.';
        errorBox.classList.remove('d-none');
      } finally { submitBtn.disabled = false; }
    }
    form.addEventListener('submit', submit);
    submitBtn.addEventListener('click', submit);
    m.el.addEventListener('shown.bs.modal', () => { const first = form.querySelector('input:not([type=hidden]):not([disabled]),select,textarea'); if (first) first.focus(); });
    return m;
  }

  // ------------------------------------------------------------------ data table
  class Table {
    constructor(container, opts) {
      this.el = typeof container === 'string' ? document.querySelector(container) : container;
      this.opts = Object.assign({ pageSize: 15, empty: { icon: 'bi-inbox', title: 'Nothing here yet', text: '' } }, opts);
      this.page = 1; this.rows = []; this.total = 0; this.sort = null; this.loading = false;
      this.el.addEventListener('click', e => this.onClick(e));
      // Keyboard users open a clickable row with Enter / Space.
      this.el.addEventListener('keydown', e => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr.clickable[data-i]') && this.opts.onRowClick) {
          e.preventDefault();
          this.opts.onRowClick(this._rendered[parseInt(e.target.dataset.i, 10)]);
        }
      });
      if (this.opts.rows) this.setRows(this.opts.rows); else if (this.opts.load) this.reload();
    }
    get serverMode() { return typeof this.opts.load === 'function'; }
    setRows(rows) { this.rows = rows || []; this.page = 1; this.render(); }
    async reload(resetPage = false) {
      if (!this.serverMode) { this.render(); return; }
      if (resetPage) this.page = 1;
      this.loading = true; this.render();
      try {
        const res = await this.opts.load({ page: this.page, perPage: this.opts.pageSize });
        this.rows = res.items; this.total = res.total;
        if (this.opts.onLoad) this.opts.onLoad(res);
      } catch (err) { this.rows = []; this.total = 0; fail(err); }
      this.loading = false; this.render();
    }
    visibleRows() {
      if (this.serverMode) return this.rows;
      let rows = this.rows.slice();
      if (this.sort) {
        const col = this.opts.columns.find(c => c.key === this.sort.key);
        const val = col.sortValue || (r => r[col.key]);
        rows.sort((a, b) => { const x = val(a), y = val(b); const r = (typeof x === 'number' && typeof y === 'number') ? x - y : String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true }); return this.sort.dir * r; });
      }
      this.total = rows.length;
      const start = (this.page - 1) * this.opts.pageSize;
      return rows.slice(start, start + this.opts.pageSize);
    }
    render() {
      const cols = this.opts.columns;
      const rows = this.loading ? [] : this.visibleRows();
      const pages = Math.max(1, Math.ceil(this.total / this.opts.pageSize));
      if (this.page > pages) { this.page = pages; if (!this.serverMode) return this.render(); }
      const head = html`<tr>${cols.map(c => {
        const sortable = c.sortable && !this.serverMode;
        const active = this.sort && this.sort.key === c.key;
        const ariaSort = !sortable ? '' : active ? (this.sort.dir > 0 ? 'ascending' : 'descending') : 'none';
        const label = html`${c.label}${active ? html` <i class="bi bi-caret-${this.sort.dir > 0 ? 'up' : 'down'}-fill" aria-hidden="true"></i>` : ''}`;
        return html`<th class="${c.className || ''} ${sortable ? 'sortable' : ''}" scope="col" ${ariaSort ? html`aria-sort="${ariaSort}"` : ''}>${sortable ? html`<button type="button" class="th-sort" data-sort="${c.key}">${label}</button>` : label}</th>`;
      })}</tr>`;
      let bodyRows;
      if (this.loading) {
        bodyRows = html`${[1, 2, 3, 4].map(() => html`<tr>${cols.map(() => html`<td><div class="skeleton"></div></td>`)}</tr>`)}`;
      } else if (!rows.length) {
        const e = this.opts.empty;
        bodyRows = html`<tr><td colspan="${cols.length}"><div class="empty-state"><i class="bi ${e.icon}"></i><div class="title">${e.title}</div><div class="small">${e.text}</div></div></td></tr>`;
      } else {
        bodyRows = html`${rows.map((r, i) => html`<tr class="${this.opts.onRowClick ? 'clickable' : ''} ${this.opts.rowClass ? this.opts.rowClass(r) : ''}" data-i="${i}" ${this.opts.onRowClick ? raw('tabindex="0"') : ''}>${cols.map(c => html`<td class="${c.className || ''}">${c.render ? c.render(r) : (r[c.key] ?? '—')}</td>`)}</tr>`)}`;
      }
      const start = this.total ? (this.page - 1) * this.opts.pageSize + 1 : 0;
      const end = Math.min(this.page * this.opts.pageSize, this.total);
      const pageButtons = [];
      for (let p = 1; p <= pages; p++) {
        if (pages > 7 && p > 2 && p < pages - 1 && Math.abs(p - this.page) > 1) { if (pageButtons[pageButtons.length - 1] !== '…') pageButtons.push('…'); continue; }
        pageButtons.push(p);
      }
      setHTML(this.el, html`<div class="table-wrap"><table class="table-sg"><thead>${head}</thead><tbody>${bodyRows}</tbody></table></div>
        ${this.opts.footer === false ? '' : html`<div class="table-foot"><span>${this.total ? `Showing ${start}–${end} of ${int(this.total)}` : 'No results'}</span>
        ${pages > 1 ? html`<div class="pager"><button type="button" data-page="${this.page - 1}" ${this.page <= 1 ? raw('disabled') : ''} aria-label="Previous page"><i class="bi bi-chevron-left"></i></button>
          ${pageButtons.map(p => p === '…' ? html`<button type="button" disabled>…</button>` : html`<button type="button" data-page="${p}" class="${p === this.page ? 'active' : ''}">${p}</button>`)}
          <button type="button" data-page="${this.page + 1}" ${this.page >= pages ? raw('disabled') : ''} aria-label="Next page"><i class="bi bi-chevron-right"></i></button></div>` : ''}</div>`}`);
      this._rendered = rows;
    }
    onClick(e) {
      const pageBtn = e.target.closest('[data-page]');
      if (pageBtn && !pageBtn.disabled) { this.page = parseInt(pageBtn.dataset.page, 10); this.serverMode ? this.reload() : this.render(); return; }
      const th = e.target.closest('[data-sort]');
      if (th && th.dataset.sort) { const key = th.dataset.sort; this.sort = this.sort && this.sort.key === key ? { key, dir: -this.sort.dir } : { key, dir: 1 }; this.render(); return; }
      const actionBtn = e.target.closest('[data-action]');
      const tr = e.target.closest('tr[data-i]');
      if (!tr) return;
      const row = this._rendered[parseInt(tr.dataset.i, 10)];
      if (actionBtn) { e.stopPropagation(); if (this.opts.onAction) this.opts.onAction(actionBtn.dataset.action, row, actionBtn); return; }
      if (this.opts.onRowClick && !e.target.closest('a,button,input,select')) this.opts.onRowClick(row);
    }
  }

  // ------------------------------------------------------------------ CSV
  function exportCSV(filename, rows, columns) {
    if (!rows.length) { toast('There is nothing to export.', 'warning'); return; }
    const cell = v => {
      let s = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralize spreadsheet formula injection
      return `"${s.replace(/"/g, '""')}"`;
    };
    const lines = [columns.map(c => cell(c.label)).join(',')].concat(rows.map(r => columns.map(c => cell(c.value(r))).join(',')));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${filename}_${today()}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ------------------------------------------------------------------ charts (validated reference palette)
  const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
  function chartDefaults() {
    if (!window.Chart || chartDefaults.done) return;
    chartDefaults.done = true;
    Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
    Chart.defaults.font.size = 11;
    Chart.defaults.color = '#6b7280';
    Chart.defaults.plugins.legend.display = false;
    Chart.defaults.plugins.tooltip.backgroundColor = '#1e2b3c';
    Chart.defaults.plugins.tooltip.padding = 10;
    Chart.defaults.plugins.tooltip.cornerRadius = 8;
    Chart.defaults.plugins.tooltip.boxPadding = 4;
    Chart.defaults.maintainAspectRatio = false;
  }
  function legend(el, items) { setHTML(el, html`${items.map(i => html`<span><i class="${i.line ? 'line' : ''}" style="background:${i.color}"></i>${i.label}</span>`)}`); }
  function axisMoney() { return { beginAtZero: true, grid: { color: '#e9ebef' }, border: { display: false }, ticks: { callback: v => moneyCompact(v), maxTicksLimit: 6 } }; }
  function lineChart(canvas, { labels, series, money: isMoney = true }) {
    chartDefaults();
    return new Chart(canvas, {
      type: 'line',
      data: { labels, datasets: series.map((s, i) => ({ label: s.label, data: s.data, borderColor: s.color || SERIES[i], backgroundColor: (s.color || SERIES[i]) + '14', fill: i === 0, borderWidth: 2, tension: .3, pointRadius: 0, pointHoverRadius: 5, pointHitRadius: 12, borderDash: s.dashed ? [5, 4] : undefined })) },
      options: { interaction: { mode: 'index', intersect: false }, scales: { y: isMoney ? axisMoney() : { beginAtZero: true, grid: { color: '#e9ebef' }, border: { display: false }, ticks: { precision: 0 } }, x: { grid: { display: false }, border: { color: '#c3c2b7' } } },
        plugins: { tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${isMoney ? money(ctx.parsed.y) : int(ctx.parsed.y)}` } } } },
    });
  }
  function barChart(canvas, { labels, series, money: isMoney = true, horizontal = false, stacked = false }) {
    chartDefaults();
    const valueAxis = isMoney ? axisMoney() : { beginAtZero: true, grid: { color: '#e9ebef' }, border: { display: false }, ticks: { precision: 0 } };
    const catAxis = { grid: { display: false }, border: { color: '#c3c2b7' }, stacked };
    return new Chart(canvas, {
      type: 'bar',
      data: { labels, datasets: series.map((s, i) => ({ label: s.label, data: s.data, backgroundColor: s.color || SERIES[i], borderRadius: 4, borderSkipped: 'start', maxBarThickness: 28, borderColor: '#fff', borderWidth: stacked ? { top: 2 } : 0 })) },
      options: { indexAxis: horizontal ? 'y' : 'x', scales: horizontal ? { x: { ...valueAxis, stacked }, y: catAxis } : { y: { ...valueAxis, stacked }, x: catAxis },
        plugins: { tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${isMoney ? money(ctx.parsed[horizontal ? 'x' : 'y']) : int(ctx.parsed[horizontal ? 'x' : 'y'])}` } } } },
    });
  }
  function doughnut(canvas, { labels, data, colors }) {
    chartDefaults();
    return new Chart(canvas, {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: colors || SERIES.slice(0, data.length), borderColor: '#fff', borderWidth: 2, hoverOffset: 4 }] },
      options: { cutout: '68%', plugins: { tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${money(ctx.parsed)}` } } } },
    });
  }

  // ------------------------------------------------------------------ session / permissions
  const can = perm => !!(state.session && state.session.user.permissions.includes(perm));
  const canAny = perms => perms.some(can);
  function homeUrl() {
    if (can('reports')) return '/index.html';
    if (can('pos')) return '/cashierdash.html';
    const first = NAV.flatMap(s => s.items).find(i => !i.perms || canAny(i.perms));
    return first ? first.href : '/profile.html';
  }

  const NAV = [
    { label: 'Main', items: [
      { href: '/index.html', icon: 'bi-grid-1x2-fill', text: 'Overview', perms: ['reports'] },
      { href: '/cashierdash.html', icon: 'bi-grid-1x2-fill', text: 'My Dashboard', perms: ['pos'], hideIf: ['reports'] },
      { href: '/pos.html', icon: 'bi-upc-scan', text: 'Point of Sale', perms: ['pos'] },
      { href: '/st.html', icon: 'bi-receipt', text: 'Sales & Transactions', mineText: 'My Transactions' },
      { href: '/inventory.html', icon: 'bi-box-seam', text: 'Inventory', perms: ['inventory'] },
      { href: '/stock.html', icon: 'bi-arrow-left-right', text: 'Stock Movements', perms: ['inventory', 'audit', 'reports'] },
      { href: '/suppliers.html', icon: 'bi-truck', text: 'Suppliers & Purchases', perms: ['suppliers', 'inventory'] },
      { href: '/employees.html', icon: 'bi-people', text: 'Employees', perms: ['employees'] },
      { href: '/shifts.html', icon: 'bi-clock-history', text: 'Shifts & Attendance', perms: ['shifts', 'cash'] },
      { href: '/cash.html', icon: 'bi-cash-stack', text: 'Cash Management', perms: ['cash'] },
      { href: '/expenses.html', icon: 'bi-wallet2', text: 'Expenses', perms: ['expenses', 'cash', 'reports'] },
      { href: '/security.html', icon: 'bi-shield-exclamation', text: 'Security & Alerts', perms: ['security'], count: 'alerts' },
      { href: '/reports.html', icon: 'bi-bar-chart-line', text: 'Reports & Analytics', perms: ['reports'] },
    ] },
    { label: 'Management', items: [
      { href: '/customers.html', icon: 'bi-person-lines-fill', text: 'Customers & Credit', perms: ['customers'] },
      { href: '/approvals.html', icon: 'bi-check2-square', text: 'Approvals', perms: ['approvals'], count: 'approvals' },
      { href: '/audit.html', icon: 'bi-journal-text', text: 'Audit Logs', perms: ['audit'] },
      { href: '/devices.html', icon: 'bi-phone', text: 'Device Management', perms: ['devices'] },
      { href: '/settings.html', icon: 'bi-gear', text: 'Settings', perms: ['settings'] },
    ] },
    { label: 'My work', items: [
      { href: '/cashiermyshift.html', icon: 'bi-person-badge', text: 'My Shift', perms: ['pos'] },
      { href: '/cashiercashdrawer.html', icon: 'bi-safe', text: 'My Cash Drawer', perms: ['pos'] },
      { href: '/cashierrefunds.html', icon: 'bi-arrow-return-left', text: 'My Refunds', perms: ['pos'] },
    ] },
    { label: 'Account', items: [
      { href: '/profile.html', icon: 'bi-person-circle', text: 'My Profile' },
      { href: '/help.html', icon: 'bi-question-circle', text: 'Help & Support' },
    ] },
  ];

  function renderShell(main, opts) {
    const s = state.session;
    const path = location.pathname === '/' ? '/index.html' : location.pathname;
    const nav = NAV.map(section => {
      const items = section.items.filter(i => (!i.perms || canAny(i.perms)) && !(i.hideIf && canAny(i.hideIf)));
      if (!items.length) return '';
      return html`<div class="sg-nav-label">${section.label}</div>${items.map(i => html`<a href="${i.href}" class="${path === i.href ? 'active' : ''}" ${path === i.href ? raw('aria-current="page"') : ''} title="${i.text}">
        <i class="bi ${i.icon}"></i><span>${i.mineText && !can('reports') ? i.mineText : i.text}</span>${i.count ? html`<b class="nav-count d-none" data-count="${i.count}"></b>` : ''}</a>`)}`;
    });
    const sidebar = document.createElement('aside');
    sidebar.className = 'sg-sidebar';
    sidebar.id = 'sgSidebar';
    sidebar.setAttribute('aria-label', 'Main navigation');
    setHTML(sidebar, html`<div class="sg-brand"><div class="sg-brand-icon"><i class="bi bi-shield-lock-fill"></i></div><div class="sg-brand-text">StoreGuard<small>${s.business.name}</small></div></div>
      <div class="sg-store"><i class="bi bi-shop"></i><span>${s.branch ? s.branch.name : 'Main branch'}</span></div>
      <nav class="sg-nav">${nav}</nav>
      <div class="sg-sidebar-footer"><div class="sg-user">${s.user.image ? html`<img class="sg-avatar avatar-image" src="${s.user.image}" alt="">` : html`<div class="sg-avatar">${s.user.initials}</div>`}<div class="sg-user-meta"><div class="name">${s.user.name}</div><div class="role">${s.role_label}</div></div>
      <button class="sg-icon-btn" type="button" data-logout title="Sign out" aria-label="Sign out"><i class="bi bi-box-arrow-right"></i></button></div></div>`);

    const overlay = document.createElement('div');
    overlay.className = 'sg-overlay';
    const wrapper = document.createElement('div');
    wrapper.className = 'sg-main';
    const topbar = document.createElement('header');
    topbar.className = 'sg-topbar no-print';
    setHTML(topbar, html`<button class="sg-icon-btn" type="button" id="sgToggle" aria-label="Toggle navigation" aria-controls="sgSidebar"><i class="bi bi-list"></i></button>
      <div class="sg-crumb hide-sm">${s.business.name} / <b>${opts.title || document.title.split('·')[0].trim()}</b></div>
      <div class="sg-search" role="search"><i class="bi bi-search"></i><input type="search" id="sgSearch" placeholder="Search products, receipts, customers, staff…" autocomplete="off" aria-label="Search"><div class="sg-search-results" id="sgSearchResults" role="listbox"></div></div>
      <div class="sg-topbar-right">
        <span class="sg-pill hide-md"><i class="bi bi-calendar3"></i><span>${new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: tz() })}</span></span>
        <button class="btn-sg btn-soft sm d-none" type="button" id="sgInstall" title="Install StoreGuard as an app on this device"><i class="bi bi-download"></i><span class="hide-sm">Install app</span></button>
        <span class="sg-conn" id="sgConn" role="status"><i class="bi bi-wifi" aria-hidden="true"></i><span class="hide-sm">Online</span></span>
        <div class="dropdown"><button class="sg-icon-btn" type="button" data-bs-toggle="dropdown" data-bs-auto-close="outside" aria-label="Notifications" id="sgBell"><i class="bi bi-bell"></i><span class="dot-count d-none" id="sgBellCount"></span></button>
          <div class="dropdown-menu dropdown-menu-end sg-notif-menu" id="sgNotifMenu"><div class="head">Notifications</div>${loader('Checking for updates…', { size: 'sm' })}</div></div>
        <div class="dropdown"><button class="sg-profile-btn" type="button" data-bs-toggle="dropdown" aria-label="Account menu">${s.user.image ? html`<img class="sg-avatar sm avatar-image" src="${s.user.image}" alt="">` : html`<span class="sg-avatar sm">${s.user.initials}</span>`}<i class="bi bi-chevron-down small"></i></button>
          <ul class="dropdown-menu dropdown-menu-end"><li class="px-3 py-2"><div class="fw-600 small">${s.user.name}</div><div class="small-xs text-muted-sg">${s.user.email}</div></li><li><hr class="dropdown-divider"></li>
          <li><a class="dropdown-item small" href="/profile.html"><i class="bi bi-person me-2"></i>My profile</a></li>
          ${can('settings') ? html`<li><a class="dropdown-item small" href="/settings.html"><i class="bi bi-gear me-2"></i>Settings</a></li>` : ''}
          <li><a class="dropdown-item small" href="/help.html"><i class="bi bi-question-circle me-2"></i>Help</a></li>
          <li><a class="dropdown-item small" href="/#install"><i class="bi bi-laptop me-2"></i>Install or download</a></li><li><hr class="dropdown-divider"></li>
          <li><button class="dropdown-item small text-danger" type="button" data-logout><i class="bi bi-box-arrow-right me-2"></i>Sign out</button></li></ul></div>
      </div>`);
    const footer = document.createElement('footer');
    footer.className = 'sg-footer no-print';
    setHTML(footer, html`<span><b>StoreGuard</b> — Retail intelligence. Complete accountability.</span><span>v${VERSION} · © ${new Date().getFullYear()} · Designed &amp; developed by <a href="https://nana-kojo.vercel.app" target="_blank" rel="noopener">Nana Kojo</a></span>`);

    main.classList.add('sg-page');
    main.id = main.id || 'main';
    main.tabIndex = -1;
    const skip = document.createElement('a');
    skip.href = `#${main.id}`; skip.className = 'visually-hidden-focusable btn-sg btn-forest position-absolute m-2'; skip.style.zIndex = 3000; skip.textContent = 'Skip to content';
    main.replaceWith(wrapper);
    wrapper.append(topbar, main, footer);
    document.body.prepend(skip, sidebar, overlay);

    if (store.get('sg_sidebar_collapsed')) document.body.classList.add('sidebar-collapsed');
    topbar.querySelector('#sgToggle').addEventListener('click', () => {
      if (window.innerWidth < 992) document.body.classList.toggle('sidebar-open');
      else { document.body.classList.toggle('sidebar-collapsed'); store.set('sg_sidebar_collapsed', document.body.classList.contains('sidebar-collapsed')); }
    });
    overlay.addEventListener('click', () => document.body.classList.remove('sidebar-open'));
    wireSearch(topbar.querySelector('#sgSearch'), topbar.querySelector('#sgSearchResults'));
    wireInstall(topbar.querySelector('#sgInstall'));
    if (state.offlineBoot) {
      const banner = document.createElement('div');
      banner.className = 'offline-banner no-print';
      banner.id = 'sgOfflineBoot';
      banner.setAttribute('role', 'status');
      setHTML(banner, html`<i class="bi bi-wifi-off" aria-hidden="true"></i><span>Offline mode — opened with the details saved on this device${state.offlineSavedAt ? ` (${ago(state.offlineSavedAt)})` : ''}. ${can('pos') ? 'Sales still work and will sync when the connection returns.' : 'Pages update when the connection returns.'}</span>`);
      main.before(banner);
    }
    refreshNotifications();
    setInterval(refreshNotifications, 60000);
    setOnline(navigator.onLine && !state.offlineBoot);
  }

  function wireInstall(button) {
    if (!button || !window.SGPwa) return;
    window.SGPwa.onChange(s => button.classList.toggle('d-none', !s.canPrompt || s.installed));
    button.addEventListener('click', async () => {
      const outcome = await window.SGPwa.install();
      if (outcome === 'accepted') ok('StoreGuard is installed. Open it from your desktop, Start menu or home screen.');
    });
  }

  function wireSearch(input, results) {
    let timer, items = [], focus = -1;
    const close = () => { results.classList.remove('show'); focus = -1; };
    const paint = () => {
      setHTML(results, items.length ? html`${items.map((r, i) => html`<a href="${r.url}" class="${i === focus ? 'focus' : ''}" role="option"><span class="type">${r.type}</span><span class="flex-grow-1 min-w-0"><span class="d-block fw-600 small text-truncate">${r.title}</span><span class="d-block small-xs text-muted-sg text-truncate">${r.subtitle}</span></span></a>`)}`
        : html`<div class="p-3 small text-muted-sg">No matches</div>`);
      results.classList.add('show');
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { close(); return; }
      timer = setTimeout(async () => {
        try { items = (await api.get('/search', { q })).results; focus = -1; paint(); } catch (e) { /* ignore */ }
      }, 250);
    });
    input.addEventListener('keydown', e => {
      if (!results.classList.contains('show')) return;
      if (e.key === 'ArrowDown') { focus = Math.min(items.length - 1, focus + 1); paint(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { focus = Math.max(0, focus - 1); paint(); e.preventDefault(); }
      if (e.key === 'Enter' && items[focus]) { location.href = items[focus].url; }
      if (e.key === 'Escape') close();
    });
    document.addEventListener('click', e => { if (!e.target.closest('.sg-search')) close(); });
  }

  async function refreshNotifications() {
    const menu = document.getElementById('sgNotifMenu');
    if (!menu) return;
    try {
      const n = await api.get('/notifications');
      const total = n.alert_count + n.approvals_pending;
      const bell = document.getElementById('sgBellCount');
      bell.textContent = total > 99 ? '99+' : total;
      bell.classList.toggle('d-none', !total);
      document.querySelectorAll('[data-count]').forEach(el => {
        const v = el.dataset.count === 'alerts' ? n.alert_count : n.approvals_pending;
        el.textContent = v; el.classList.toggle('d-none', !v);
      });
      const items = [];
      if (n.approvals_pending) items.push(html`<a class="sg-notif-item" href="/approvals.html"><i class="bi bi-check2-square text-amber"></i><div><div class="fw-600">${n.approvals_pending} request${n.approvals_pending === 1 ? '' : 's'} awaiting approval</div><div class="small-xs text-muted-sg">Refunds, expenses and cash variances</div></div></a>`);
      n.alerts.forEach(a => items.push(html`<a class="sg-notif-item" href="/security.html"><span class="sev-dot ${a.severity} mt-1"></span><div><div class="fw-600">${a.title}</div><div class="small-xs text-muted-sg">${a.detail} · ${ago(a.created_at)}</div></div></a>`));
      n.my_requests.forEach(r => items.push(html`<div class="sg-notif-item"><i class="bi bi-send ${r.status === 'approved' ? 'text-emerald' : r.status === 'rejected' ? 'text-red' : 'text-amber'}"></i><div><div class="fw-600">Your request was ${r.status === 'pending' ? 'sent for approval' : r.status}</div><div class="small-xs text-muted-sg">${r.summary}${r.decision_note ? ` — ${r.decision_note}` : ''}</div></div></div>`));
      setHTML(menu, html`<div class="head">Notifications${can('security') ? html`<a href="/security.html" class="small fw-normal">View all</a>` : ''}</div>${items.length ? items : html`<div class="empty-state py-4"><i class="bi bi-bell-slash"></i><div class="small">You're all caught up</div></div>`}`);
    } catch (e) { /* non-critical */ }
  }

  /**
   * Re-check the session with the server: picks up a fresh CSRF token after an offline start.
   * Resolves true when signed in; false when offline or the session has ended (sign-in needed).
   */
  let refreshing = null;
  function refreshSession() {
    refreshing = refreshing || (async () => {
      try {
        const s = await request('/auth/me', { quiet401: true });
        state.session = s; state.csrf = s.csrf_token; state.needsLogin = false;
        sessionCache.save(s);
        if (state.offlineBoot) {
          state.offlineBoot = false;
          const banner = document.getElementById('sgOfflineBoot');
          if (banner) banner.remove();
          toast('Back online.', 'success');
        }
        return true;
      } catch (e) {
        if (e.status === 401 && !state.needsLogin) {
          state.needsLogin = true;
          toast(html`Your session ended while this device was offline. <a href="/auth.html?next=${encodeURIComponent(location.pathname)}">Sign in again</a> to sync and continue — nothing saved on this device is lost.`, 'warning', 'Sign in needed');
        }
        return false;
      } finally { refreshing = null; }
    })();
    return refreshing;
  }

  function setOnline(online) {
    state.online = online;
    if (online && state.offlineBoot && !refreshing) refreshSession();
    const el = document.getElementById('sgConn');
    if (el) {
      el.classList.toggle('offline', !online);
      setHTML(el, online ? html`<i class="bi bi-wifi"></i><span class="hide-sm">Online</span>` : html`<i class="bi bi-wifi-off"></i><span class="hide-sm">Offline</span>`);
    }
    document.dispatchEvent(new CustomEvent('sg:connectivity', { detail: { online } }));
  }
  window.addEventListener('online', () => setOnline(true));
  window.addEventListener('offline', () => setOnline(false));

  async function logout() {
    const pending = offline.pending().length;
    if (pending && !(await confirmDialog({ title: 'Unsynced sales', message: `${pending} offline sale(s) have not synced yet. They stay saved on this device and will sync next time you sign in here. Sign out anyway?`, confirmText: 'Sign out', danger: true }))) return;
    sessionCache.clear();
    try { await api.post('/auth/logout'); } catch (e) { /* ignore */ }
    location.href = '/auth.html';
  }
  document.addEventListener('click', e => { if (e.target.closest('[data-logout]')) { e.preventDefault(); logout(); } });

  function denied(main) {
    setHTML(main, html`<div class="card-sg"><div class="empty-state"><i class="bi bi-lock"></i><div class="title">You don't have access to this page</div><div class="small mb-3">Ask your manager if you need this permission.</div><a class="btn-sg btn-forest" href="${homeUrl()}">Go to my dashboard</a></div></div>`);
  }

  /**
   * Boot a page: authenticate, render the shell, enforce the page permission.
   * Resolves with the session, or null when access is denied (page script should stop).
   */
  // ------------------------------------------------------------------ loading animations
  const LOADING_TIPS = ['Opening the till…', 'Counting the float…', 'Stocking the shelves…', 'Checking today\'s sales…', 'Polishing the receipts…', 'Waking up the cashiers…'];

  /** Animated in-content loader (items dropping into a cart). `size: 'sm'` for compact spots. */
  function loader(text = 'Loading…', { size = '' } = {}) {
    return html`<div class="sg-loader ${size}" role="status" aria-live="polite"><div class="sg-loader-scene" aria-hidden="true">
      <div class="sg-loader-items"><span></span><span></span><span></span><span></span></div>
      <i class="bi bi-cart3 sg-loader-cart"></i></div><div class="sg-loader-text">${text}</div></div>`;
  }

  /** Animated tick used to celebrate a completed sale. */
  function successMark(message = '') {
    return html`<div class="sg-success" role="status"><svg viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="25"/><path d="M14 27l8 8 16-16"/></svg>${message ? html`<div class="msg">${message}</div>` : ''}</div>`;
  }

  /** Full-screen branded splash shown while a page boots; returns a function that dismisses it. */
  function showSplash() {
    const el = document.createElement('div');
    el.className = 'sg-splash';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-label', 'Loading StoreGuard');
    let i = Math.floor(Math.random() * LOADING_TIPS.length);
    setHTML(el, html`<div class="sg-splash-inner"><div class="sg-splash-logo"><div class="ring"></div><div class="core"><i class="bi bi-shield-lock-fill"></i></div></div>
      <div class="sg-splash-name">StoreGuard</div><div class="sg-splash-tip">${LOADING_TIPS[i]}</div><div class="sg-splash-bar"></div></div>`);
    document.body.appendChild(el);
    const tip = el.querySelector('.sg-splash-tip');
    const rotate = setInterval(() => {
      tip.style.opacity = 0;
      setTimeout(() => { i = (i + 1) % LOADING_TIPS.length; tip.textContent = LOADING_TIPS[i]; tip.style.opacity = 1; }, 250);
    }, 1600);
    return () => {
      clearInterval(rotate);
      el.classList.add('done');
      setTimeout(() => el.remove(), 350);
    };
  }

  async function boot(opts = {}) {
    document.body.classList.add('sg-booting');
    const hideSplash = showSplash();
    try { return await bootInner(opts); } finally { hideSplash(); }
  }

  async function bootInner(opts) {
    let session;
    try {
      session = await request('/auth/me');
      sessionCache.save(session);
    } catch (e) {
      const cached = e.status === 0 ? sessionCache.load() : null;
      if (cached) {
        // No connection, but this device was signed in before: open in offline mode.
        session = cached.session;
        state.offlineBoot = true;
        state.offlineSavedAt = cached.saved_at;
      } else {
        if (e.status !== 401) {
          document.body.classList.remove('sg-booting');
          setHTML(document.body, html`<main class="container py-5"><div class="card-sg"><div class="empty-state"><i class="bi bi-cloud-slash"></i><div class="title">Can't reach StoreGuard</div><div class="small mb-3">${e.status === 0 ? 'The StoreGuard server isn\'t reachable and nobody has signed in on this device yet. Connect to the internet (or start StoreGuard on the store PC) and sign in once — after that the Point of Sale works offline.' : e.message}</div><button class="btn-sg btn-forest" type="button" id="sgRetry">Retry</button></div></div></main>`);
          document.getElementById('sgRetry').addEventListener('click', () => location.reload());
        }
        return null;
      }
    }
    state.session = session;
    state.csrf = session.csrf_token || null;
    const main = document.querySelector('main');
    if (opts.layout !== 'bare') renderShell(main, opts);
    // Placeholder until the page script renders its content (it replaces main's HTML).
    if (main && !main.children.length) setHTML(main, html`<div data-boot-loader>${loader(LOADING_TIPS[Math.floor(Math.random() * LOADING_TIPS.length)])}</div>`);
    document.body.classList.remove('sg-booting');
    const perms = (document.body.dataset.perm || '').split('|').filter(Boolean);
    if (perms.length && !canAny(perms)) { denied(main); return null; }
    return session;
  }

  // ------------------------------------------------------------------ offline sale queue (POS)
  const offline = {
    key() { const s = state.session; return `sg_offline_sales_${s ? s.business.id : 'x'}_${s ? s.user.id : 'x'}`; },
    pending() { return store.get(this.key(), []); },
    save(list) { store.set(this.key(), list); document.dispatchEvent(new CustomEvent('sg:queue', { detail: list })); },
    enqueue(payload) { const list = this.pending(); list.push({ payload, queued_at: new Date().toISOString(), error: null }); this.save(list); },
    discard(clientRef) { this.save(this.pending().filter(x => x.payload.client_ref !== clientRef)); },
    /** Problems that clear up on their own (connection, sign-in, server busy): keep the sale queued and retry later. */
    transient(err) {
      return err.status === 0 || err.status === 401 || err.status === 429 || err.status >= 500 ||
        (err.status === 403 && /session has expired/i.test(err.message));
    },
    async sync() {
      if (this._syncing || !this.pending().some(x => !x.error)) return { synced: 0 };
      this._syncing = true;
      let synced = 0;
      try {
        // After an offline start the CSRF token is missing: get a fresh one first.
        if ((state.offlineBoot || !state.csrf) && !(await refreshSession())) return { synced };
        for (const entry of this.pending()) {
          if (entry.error) continue;
          try {
            // client_ref makes this idempotent: a retry after a lost response never records the sale twice.
            await request('/sales', { method: 'POST', body: entry.payload, quiet401: true });
            this.save(this.pending().filter(x => x.payload.client_ref !== entry.payload.client_ref));
            synced++;
          } catch (err) {
            if (this.transient(err)) {
              if (err.status === 403 || err.status === 401) await refreshSession();
              break;
            }
            const list = this.pending();
            const hit = list.find(x => x.payload.client_ref === entry.payload.client_ref);
            if (hit) { hit.error = err.message; this.save(list); }
          }
        }
      } finally { this._syncing = false; }
      return { synced };
    },
  };

  // ------------------------------------------------------------------ receipts
  const RECEIPT_DEFAULTS = {
    auto_print: true, copies: 1, paper: '80mm', logo: '', header: '', tax_id: '', contact_line: '', policy: '',
    show_address: true, show_phone: true, show_cashier: true, show_customer: true, show_branch: true, show_sku: false, show_item_count: true,
  };
  /** The business's receipt options merged over defaults. */
  function receiptOptions(biz) {
    biz = biz || business() || {};
    return Object.assign({}, RECEIPT_DEFAULTS, biz.receipt || {});
  }

  /**
   * Customised receipt markup. `opts.label` adds a copy label (e.g. "CUSTOMER COPY");
   * `opts.branch` overrides the branch name (defaults to the signed-in user's branch).
   */
  function receiptHTML(sale, biz, opts = {}) {
    biz = biz || business() || {};
    const r = Object.assign(receiptOptions(biz), opts.receipt || {});
    const n = v => numberFmt.format(toNumber(v));
    const branch = opts.branch !== undefined ? opts.branch : (state.session && state.session.branch ? state.session.branch.name : '');
    const items = sale.items || [];
    const count = items.reduce((s, i) => s + (i.quantity || 0), 0);
    const taxRate = toNumber(biz.tax_rate);
    const offlineSale = String(sale.reference || '').startsWith('OFFLINE-');
    const logo = r.logo && /^data:image\/(png|jpeg|webp|gif);base64,/.test(r.logo) ? r.logo : '';
    return html`<div class="receipt paper-${r.paper}">
      ${opts.label ? html`<div class="r-copy">${opts.label}</div>` : ''}
      <div class="r-head">
        ${logo ? html`<img class="r-logo" src="${logo}" alt="">` : ''}
        <div class="r-shop">${biz.name}</div>
        ${r.header ? html`<div class="r-tag">${r.header}</div>` : ''}
        ${r.show_branch && branch ? html`<div>${branch}</div>` : ''}
        ${r.show_address && biz.address ? html`<div>${biz.address}</div>` : ''}
        ${r.show_phone && biz.phone ? html`<div>Tel: ${biz.phone}</div>` : ''}
        ${r.tax_id ? html`<div>TIN: ${r.tax_id}</div>` : ''}
      </div>
      <div class="r-title">${toNumber(sale.refunded_amount) ? 'SALES RECEIPT (REFUNDED)' : 'SALES RECEIPT'}</div>
      <div class="r-meta">
        <div class="line"><span>Receipt #</span><span class="r-mono">${sale.reference}</span></div>
        <div class="line"><span>Date</span><span>${fmtDateTime(sale.created_at)}</span></div>
        ${r.show_cashier && sale.cashier_name ? html`<div class="line"><span>Served by</span><span>${sale.cashier_name}</span></div>` : ''}
        ${r.show_customer && sale.customer_name ? html`<div class="line"><span>Customer</span><span>${sale.customer_name}</span></div>` : ''}
      </div>
      <hr>
      <div class="line r-cols"><span>Item</span><span>Amount</span></div>
      <div class="r-items">
      ${items.map(i => html`<div class="r-item">
        <div class="r-name">${i.product_name}${r.show_sku && i.sku ? html` <span class="r-sku">[${i.sku}]</span>` : ''}</div>
        <div class="line"><span>&nbsp;&nbsp;${i.quantity} × ${n(i.unit_price)}</span><span>${n(i.line_total)}</span></div>
        ${i.refunded_quantity ? html`<div class="line r-muted"><span>&nbsp;&nbsp;Returned ${i.refunded_quantity}</span><span></span></div>` : ''}</div>`)}
      </div>
      <hr>
      <div class="r-totals">
      ${r.show_item_count ? html`<div class="line"><span>Items</span><span>${count}</span></div>` : ''}
      <div class="line"><span>Subtotal</span><span>${n(sale.subtotal)}</span></div>
      ${toNumber(sale.discount) ? html`<div class="line"><span>Discount</span><span>−${n(sale.discount)}</span></div>` : ''}
      ${toNumber(sale.tax) ? html`<div class="line"><span>Tax${taxRate ? ` (${taxRate}%)` : ''}</span><span>${n(sale.tax)}</span></div>` : ''}
      <div class="line r-total"><span>TOTAL</span><span>${money(sale.total)}</span></div>
      </div>
      <hr>
      <div class="r-payment">
      ${(() => { const p = splitMomoRef(sale.payment_method, sale.payment_reference); return html`
      <div class="line"><span>Paid by</span><span>${p.label}</span></div>
      ${p.ref ? html`<div class="line"><span>Txn ref</span><span class="r-mono">${p.ref}</span></div>` : ''}`; })()}
      ${sale.amount_tendered ? html`<div class="line"><span>Cash received</span><span>${n(sale.amount_tendered)}</span></div><div class="line r-bold"><span>Change</span><span>${n(sale.change_due)}</span></div>` : ''}
      ${toNumber(sale.refunded_amount) ? html`<div class="line"><span>Refunded</span><span>−${n(sale.refunded_amount)}</span></div>` : ''}
      </div>
      ${offlineSale ? html`<div class="r-note">Recorded offline. Final receipt number is assigned when the till reconnects.</div>` : ''}
      ${r.policy ? html`<hr><div class="r-policy">${r.policy}</div>` : ''}
      <hr>
      <div class="r-foot">${biz.receipt_footer || 'Thank you for shopping with us!'}</div>
      ${r.contact_line ? html`<div class="r-contact">${r.contact_line}</div>` : ''}
      <div class="r-powered">Powered by StoreGuard</div>
    </div>`;
  }
  // Receipt styles, scoped to .receipt so the same rules drive the on-screen preview and the printout.
  const RECEIPT_CSS = `
    .receipt { font-family: "Inter", "Segoe UI", Arial, sans-serif; font-size: 12px; line-height: 1.35; color: #17211b; background: #fff; width: 100%; max-width: 72mm; margin: 0 auto; padding: 5mm 4mm 4mm; border: 1px solid #dfe6e1; border-top: 4px solid #1f6f43; border-radius: 8px; box-shadow: 0 8px 24px rgba(23, 33, 27, .08); box-sizing: border-box; }
    .receipt.paper-58mm { max-width: 48mm; font-size: 10.5px; padding: 4mm 3mm 3mm; }
    .receipt.paper-a4 { max-width: 105mm; font-size: 13px; padding: 10mm; }
    .receipt .line { display: flex; justify-content: space-between; gap: 8px; }
    .receipt .line > span:last-child { text-align: right; }
    .receipt hr { border: 0; border-top: 1px dashed #aebbb3; margin: 7px 0; opacity: 1; }
    .receipt .r-head { text-align: center; margin-bottom: 8px; }
    .receipt .r-logo { display: block; max-width: 60%; max-height: 70px; margin: 0 auto 7px; object-fit: contain; }
    .receipt .r-shop { font-size: 1.45em; font-weight: 800; letter-spacing: .8px; text-transform: uppercase; }
    .receipt .r-tag { color: #55705f; margin: 2px 0; }
    .receipt .r-title { text-align: center; font-size: .78em; font-weight: 800; letter-spacing: 1.5px; color: #55705f; padding: 5px 0 4px; margin: 7px 0 5px; border-top: 1px solid #edf1ee; border-bottom: 1px solid #edf1ee; }
    .receipt .r-copy { text-align: center; font-weight: 800; font-size: .78em; letter-spacing: 1.2px; color: #1f6f43; background: #edf7f1; border: 1px solid #bcdcca; border-radius: 999px; padding: 3px 6px; margin-bottom: 7px; }
    .receipt .r-meta { color: #405247; }
    .receipt .r-meta .line { margin: 1px 0; }
    .receipt .r-cols { font-weight: 800; font-size: .78em; letter-spacing: .5px; text-transform: uppercase; color: #55705f; padding: 3px 0 5px; }
    .receipt .r-items { padding: 2px 0; }
    .receipt .r-item { margin: 0 0 7px; }
    .receipt .r-name { font-weight: 750; word-break: break-word; }
    .receipt .r-sku, .receipt .r-muted { font-size: .85em; color: #6b7e71; opacity: 1; }
    .receipt .r-totals { padding: 2px 0; }
    .receipt .r-totals .line { margin: 2px 0; }
    .receipt .r-total { align-items: center; font-size: 1.32em; font-weight: 850; color: #fff; background: #1f6f43; border-radius: 6px; margin: 7px -1px 2px; padding: 7px 8px; }
    .receipt .r-payment { color: #405247; }
    .receipt .r-bold { font-weight: 700; }
    .receipt .r-mono { font-family: inherit; word-break: break-all; }
    .receipt .r-note { margin-top: 7px; font-size: .85em; text-align: center; color: #765d20; background: #fff7de; border: 1px dashed #d6bd70; border-radius: 5px; padding: 5px; }
    .receipt .r-policy { font-size: .85em; text-align: center; color: #405247; }
    .receipt .r-foot { text-align: center; font-weight: 800; color: #1f6f43; font-size: 1.05em; }
    .receipt .r-contact { text-align: center; font-size: .9em; color: #405247; }
    .receipt .r-powered { text-align: center; font-size: .72em; color: #8a9890; margin-top: 7px; }
    @media print {
      .receipt { color: #000; border: 0; border-top: 2px solid #000; border-radius: 0; box-shadow: none; }
      .receipt .r-tag, .receipt .r-meta, .receipt .r-cols, .receipt .r-sku, .receipt .r-muted, .receipt .r-payment, .receipt .r-policy, .receipt .r-contact { color: #000; }
      .receipt hr { border-top-color: #000; }
      .receipt .r-title { color: #000; border-color: #000; }
      .receipt .r-total { color: #000; background: transparent; border: 1px solid #000; }
      .receipt .r-foot { color: #000; }
      .receipt .r-copy { color: #000; background: transparent; border-color: #000; }
      .receipt .r-powered { color: #666; }
    }`;
  (function injectReceiptCSS() {
    const s = document.createElement('style');
    s.id = 'sgReceiptCSS'; s.textContent = RECEIPT_CSS;
    document.head.appendChild(s);
  })();

  const PAGE_SIZE = { '58mm': '58mm auto', '80mm': '80mm auto', a4: 'A4' };

  /** Full standalone HTML document for a receipt (all configured copies), used for printing / saving as PDF. */
  function receiptDocument(sale, biz, opts = {}) {
    const r = receiptOptions(biz);
    const copies = Math.min(3, Math.max(1, parseInt(opts.copies || r.copies, 10) || 1));
    const labels = copies === 1 ? [''] : ['CUSTOMER COPY', 'STORE COPY', 'OFFICE COPY'].slice(0, copies);
    const body = labels.map((label, i) => `<div class="copy"${i ? ' style="page-break-before:always;break-before:page"' : ''}>${receiptHTML(sale, biz, { ...opts, label })}</div>`).join('');
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Receipt ${esc(sale.reference)}</title><style>
      @page { size: ${PAGE_SIZE[r.paper] || PAGE_SIZE['80mm']}; margin: ${r.paper === 'a4' ? '15mm' : '3mm'}; }
      * { box-sizing: border-box; } html, body { margin: 0; padding: 0; background: #fff; }
      img { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      ${RECEIPT_CSS}</style></head><body>${body}</body></html>`;
  }

  /**
   * Print a receipt in an isolated, hidden iframe so the app layout, open modals and
   * scroll locks never interfere. The browser's print dialog also offers "Save as PDF".
   */
  function printReceipt(sale, biz, opts = {}) {
    const docHTML = receiptDocument(sale, biz, opts);
    const old = document.getElementById('sgPrintFrame');
    if (old) old.remove();
    const frame = document.createElement('iframe');
    frame.id = 'sgPrintFrame';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(frame);
    const doc = frame.contentWindow.document;
    doc.open(); doc.write(docHTML); doc.close();
    const go = () => {
      try { frame.contentWindow.focus(); frame.contentWindow.print(); }
      catch (e) { // fallback: open in a new window
        const w = window.open('', '_blank', 'width=420,height=640');
        if (!w) { toast('Allow pop-ups to print receipts.', 'warning'); return; }
        w.document.write(docHTML); w.document.close(); w.focus(); w.print();
      }
    };
    // Wait for the logo (if any) to decode before printing.
    const imgs = [...doc.images];
    Promise.all(imgs.map(img => img.complete ? null : new Promise(res => { img.onload = img.onerror = res; })))
      .then(() => setTimeout(go, 100));
  }

  // ------------------------------------------------------------------ utilities
  function debounce(fn, ms = 250) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }
  const param = name => new URLSearchParams(location.search).get(name);
  function uuid() { return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`); }
  function busy(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; setHTML(btn, html`<span class="sg-dots" aria-hidden="true"><i></i><i></i><i></i></span> ${label || 'Working…'}`); }
    else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  }
  function rangeChips(container, onChange, initial = '7') {
    const options = [['0', 'Today'], ['6', '7 days'], ['29', '30 days'], ['89', '90 days']];
    setHTML(container, html`${options.map(([v, l]) => html`<button type="button" class="chip ${v === initial ? 'active' : ''}" data-days="${v}">${l}</button>`)}`);
    container.addEventListener('click', e => {
      const chip = e.target.closest('[data-days]');
      if (!chip) return;
      container.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === chip));
      onChange(parseInt(chip.dataset.days, 10));
    });
  }

  window.SG = {
    VERSION, api, ApiError, html, raw, esc, setHTML, money, moneyCompact, int, toNumber, fmtDate, fmtTime, fmtDateTime, fmtDay,
    ago, duration, today, titleCase, paymentLabel, splitMomoRef, roleLabel, badge, PAYMENT_LABELS, PAYMENT_ICONS, MOMO_NETWORKS, CATEGORY_ICONS, ROLE_LABELS,
    store, toast, ok, fail, modal, confirm: confirmDialog, formModal, Table, exportCSV, SERIES, legend, lineChart, barChart,
    doughnut, can, canAny, boot, homeUrl, offline, loader, successMark, resizeImage: shrinkImage, receiptHTML, receiptDocument, receiptOptions, printReceipt, debounce, param, uuid, busy, rangeChips,
    currencySymbol, logout, refreshSession, cachedSession: () => sessionCache.load(),
    get session() { return state.session; },
    get online() { return state.online; },
    /** True while the page is running from the session saved on this device (no server contact yet). */
    get offlineBoot() { return state.offlineBoot; },
  };
})();
