/* StoreGuard app install + offline support. Loaded on every page (before storeguard.js). */
(function () {
  'use strict';

  let deferredPrompt = null;
  const listeners = new Set();
  const notify = () => listeners.forEach(fn => { try { fn(api.state()); } catch (e) { /* ignore */ } });

  // Service workers need a secure origin: HTTPS, or the PC itself (localhost) for a local install.
  const secure = window.isSecureContext;
  const supported = 'serviceWorker' in navigator && secure;

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: window-controls-overlay)').matches || navigator.standalone === true;
  }
  function platform() {
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
    if (/Android/.test(ua)) return 'android';
    if (/Edg\//.test(ua)) return 'edge';
    if (/Firefox\//.test(ua)) return 'firefox';
    if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return 'safari';
    return 'chrome';
  }

  const api = {
    supported,
    secure,
    isStandalone,
    platform,
    /** True when the browser offered a one-click install (Chrome, Edge, Android). */
    canPrompt: () => !!deferredPrompt,
    state: () => ({ installed: isStandalone(), canPrompt: !!deferredPrompt, platform: platform(), supported, secure }),
    onChange(fn) { listeners.add(fn); fn(api.state()); return () => listeners.delete(fn); },
    /** Show the browser's install dialog. Resolves 'accepted', 'dismissed' or 'unavailable'. */
    async install() {
      if (!deferredPrompt) return 'unavailable';
      const prompt = deferredPrompt;
      deferredPrompt = null;
      prompt.prompt();
      const choice = await prompt.userChoice.catch(() => ({ outcome: 'dismissed' }));
      notify();
      return choice.outcome;
    },
    /** Step-by-step install instructions for the current browser. */
    instructions() {
      switch (platform()) {
        case 'ios': return ['Open this page in Safari.', 'Tap the Share button.', 'Choose “Add to Home Screen”, then “Add”.'];
        case 'android': return ['Open the browser menu (⋮).', 'Tap “Install app” or “Add to Home screen”.', 'Confirm with “Install”.'];
        case 'safari': return ['In Safari, open the File menu (or the Share button).', 'Choose “Add to Dock”.', 'StoreGuard appears in your Dock and Launchpad.'];
        case 'firefox': return ['Firefox on computers cannot install web apps.', 'Open this page in Microsoft Edge or Google Chrome.', 'Click the install icon in the address bar.'];
        case 'edge': return ['Click the “App available” icon at the right of the address bar.', 'Or open the menu (…) → Apps → “Install StoreGuard”.', 'StoreGuard opens in its own window and gets a desktop/Start menu icon.'];
        default: return ['Click the install icon at the right of the address bar.', 'Or open the menu (⋮) → “Cast, save and share” → “Install page as app”.', 'StoreGuard opens in its own window and gets a desktop/Start menu icon.'];
      }
    },
  };

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault(); // we show our own "Install app" button instead of the mini-infobar
    deferredPrompt = e;
    notify();
  });
  window.addEventListener('appinstalled', () => { deferredPrompt = null; notify(); });
  window.matchMedia('(display-mode: standalone)').addEventListener('change', notify);

  if (supported) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(err => console.warn('StoreGuard offline support unavailable:', err));
    });
  }

  window.SGPwa = api;
})();
