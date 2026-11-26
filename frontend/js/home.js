/* StoreGuard product page behaviour. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  };

  /* Accessible tabs (WAI-ARIA tabs pattern). Without JavaScript every panel simply shows in order. */
  function setupTabs(root) {
    const list = root.querySelector('[role="tablist"]');
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const panels = tabs.map(t => $(t.getAttribute('aria-controls')));
    const vertical = list.getAttribute('aria-orientation') === 'vertical';

    function select(index, focus) {
      tabs.forEach((tab, i) => {
        const on = i === index;
        tab.setAttribute('aria-selected', String(on));
        tab.tabIndex = on ? 0 : -1;
        panels[i].hidden = !on;
      });
      if (focus) tabs[index].focus();
    }

    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => select(i, false));
      tab.addEventListener('keydown', e => {
        const prev = vertical && innerWidth > 1080 ? 'ArrowUp' : 'ArrowLeft';
        const next = vertical && innerWidth > 1080 ? 'ArrowDown' : 'ArrowRight';
        let to = null;
        if (e.key === next) to = (i + 1) % tabs.length;
        else if (e.key === prev) to = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') to = 0;
        else if (e.key === 'End') to = tabs.length - 1;
        if (to !== null) { e.preventDefault(); select(to, true); }
      });
    });
    panels.forEach(p => { p.tabIndex = 0; });
    list.hidden = false;
    root.classList.add('ready');
    select(0, false);
    return { select, panels };
  }

  /* Developer / support contact from /support.json (set by the server's SUPPORT_* settings). */
  function renderSupport(info) {
    const card = $('contactCard');
    card.querySelectorAll('[data-support]').forEach(node => {
      const value = info[node.dataset.support];
      if (value) node.textContent = value;
    });
    const rows = [
      ['phone', 'bi-telephone-fill', 'Call', info.phone_link, info.phone],
      ['whatsapp', 'bi-whatsapp', 'WhatsApp', info.whatsapp_link, info.whatsapp],
      ['email', 'bi-envelope-fill', 'Email', info.email && `mailto:${info.email}?subject=${encodeURIComponent('StoreGuard support')}`, info.email],
      ['website', 'bi-globe2', 'Website', info.website, info.website && info.website.replace(/^https?:\/\//, '').replace(/\/$/, '')],
    ].filter(([, , , href, text]) => href && text);
    if (rows.length) {
      $('contactList').replaceChildren(...rows.map(([key, icon, label, href, text]) => {
        const external = key === 'website' || key === 'whatsapp';
        const link = el('a', { href }, el('small', { textContent: label }), text);
        if (external) {
          link.target = '_blank';
          link.rel = 'noopener';
          link.append(el('span', { className: 'sr-only', textContent: ' (opens in a new tab)' }));
        }
        const glyph = el('i', { className: `bi ${icon}` });
        glyph.setAttribute('aria-hidden', 'true');
        return el('li', {}, glyph, link);
      }));
    }
    const hours = card.querySelector('[data-support-row="hours"]');
    hours.hidden = !info.hours;
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('year').textContent = new Date().getFullYear();

    // ---------------------------------------------------------- mobile menu
    const toggle = $('navToggle');
    const menu = $('navMenu');
    const setMenu = open => { menu.classList.toggle('open', open); toggle.setAttribute('aria-expanded', String(open)); };
    toggle.addEventListener('click', () => setMenu(!menu.classList.contains('open')));
    menu.addEventListener('click', e => { if (e.target.closest('a')) setMenu(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && menu.classList.contains('open')) { setMenu(false); toggle.focus(); } });

    // ---------------------------------------------------------- tabs, with links like #panel-pc opening the right one
    const tabsets = [...document.querySelectorAll('[data-tabs]')].map(setupTabs);
    function openFromHash() {
      const id = location.hash.slice(1);
      for (const set of tabsets) {
        const index = set.panels.findIndex(p => p.id === id);
        if (index >= 0) { set.select(index, false); set.panels[index].scrollIntoView(); }
      }
    }
    window.addEventListener('hashchange', openFromHash);
    openFromHash();

    // ---------------------------------------------------------- support contact
    fetch('/support.json', { headers: { Accept: 'application/json' } })
      .then(r => (r.ok ? r.json() : null))
      .then(info => { if (info) renderSupport(info); })
      .catch(() => { /* offline and not cached: the built-in contact stays */ });

    // ---------------------------------------------------------- signed in? offer "Open StoreGuard" instead of "Sign in"
    fetch('/api/auth/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(r => {
        if (!r.ok) return;
        document.querySelectorAll('[data-signed-out]').forEach(node => { node.hidden = true; });
        document.querySelectorAll('[data-signed-in]').forEach(node => { node.hidden = false; });
      })
      .catch(() => { /* offline: leave as is */ });

    // ---------------------------------------------------------- download availability
    const download = $('downloadBtn');
    fetch(download.getAttribute('href'), { method: 'HEAD' }).then(r => {
      if (r.status === 404) {
        download.remove();
        $('downloadHint').textContent = 'The Windows download isn\'t offered on this server. Contact support below for a copy.';
      }
    }).catch(() => { /* offline */ });

    // ---------------------------------------------------------- install
    const button = $('installBtn');
    const label = button.querySelector('span');
    const hint = $('installHint');
    const dialog = $('installDialog');
    const pwa = window.SGPwa;

    function render(s) {
      button.disabled = false;
      if (s.installed) {
        label.textContent = 'Installed on this device';
        button.disabled = true;
        hint.textContent = 'You\'re using the StoreGuard app.';
      } else if (s.canPrompt) {
        label.textContent = 'Install StoreGuard';
        hint.textContent = 'One click adds StoreGuard to your desktop, Start menu or home screen.';
      } else if (!s.secure) {
        label.textContent = 'How to install';
        hint.textContent = 'Installing needs a secure (https://) address, or opening StoreGuard on the store PC itself.';
      } else {
        label.textContent = 'How to install on this device';
        hint.textContent = '';
      }
    }

    function showInstructions(s) {
      $('installSteps').replaceChildren(...pwa.instructions().map(text => el('li', { textContent: text })));
      $('installDialogNote').textContent = !s.secure
        ? 'This page was opened over a plain http:// network address, so browsers won\'t install it from here. Use the secure https:// address, or install it on the store PC from http://localhost:8000.'
        : 'Once installed, sign in once while online. After that StoreGuard opens and sells even with no connection.';
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else alert(pwa.instructions().join('\n'));
    }

    if (!pwa) { button.hidden = true; return; }
    pwa.onChange(render);
    button.addEventListener('click', async () => {
      const s = pwa.state();
      if (s.canPrompt) {
        const outcome = await pwa.install();
        if (outcome === 'accepted') hint.textContent = 'Installed! Open StoreGuard from your desktop, Start menu or home screen.';
        return;
      }
      showInstructions(s);
    });
    dialog.addEventListener('close', () => button.focus());
  });
})();
