(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const notice = $('authNotice');

  function show(message, tone = '') {
    notice.className = `notice mb-3 ${tone}`;
    notice.textContent = message;
  }
  function safeNext() {
    const next = SG.param('next') || '';
    return next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/auth.html') ? next : null;
  }
  function homeFor(session) {
    const perms = session.user.permissions;
    if (perms.includes('reports')) return '/index.html';
    if (perms.includes('pos')) return '/cashierdash.html';
    return '/profile.html';
  }
  function go(session) { location.href = safeNext() || homeFor(session); }

  // Already signed in? Skip the form.
  SG.api.request('/auth/me', { quiet401: true }).then(go).catch(() => {});
  if (SG.param('expired')) show('Your session ended. Please sign in again.', 'warn');

  document.querySelectorAll('[data-tab]').forEach(tab => tab.addEventListener('click', () => {
    const signup = tab.dataset.tab === 'signup';
    document.querySelectorAll('[data-tab]').forEach(t => { t.classList.toggle('active', t === tab); t.setAttribute('aria-selected', t === tab); });
    $('loginForm').classList.toggle('d-none', signup);
    $('signupForm').classList.toggle('d-none', !signup);
    notice.classList.add('d-none');
  }));

  document.querySelectorAll('.toggle-pw').forEach(btn => btn.addEventListener('click', () => {
    const input = $(btn.dataset.target);
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.querySelector('i').className = showing ? 'bi bi-eye' : 'bi bi-eye-slash';
    btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  }));

  $('forgotLink').addEventListener('click', e => {
    e.preventDefault();
    show('For security, passwords are reset by your store owner or manager from the Employees page. Owners locked out of their account should contact their StoreGuard administrator.', '');
  });

  $('suPassword').addEventListener('input', e => {
    const v = e.target.value;
    let score = 0;
    if (v.length >= 10) score++;
    if (v.length >= 14) score++;
    if (/[a-z]/.test(v) && /[A-Z]/.test(v)) score++;
    if (/\d/.test(v)) score++;
    if (/[^A-Za-z0-9]/.test(v)) score++;
    const levels = [['0%', '#e3e8ee', 'At least 10 characters, mixing letters with numbers or symbols.'], ['25%', '#b33b3b', 'Weak'], ['50%', '#e09a1d', 'Fair'], ['75%', '#2e7d5e', 'Good'], ['100%', '#0f3d2b', 'Strong']];
    const [w, c, t] = levels[Math.min(4, v ? Math.max(1, score - 1) : 0)];
    $('strengthBar').style.width = w; $('strengthBar').style.background = c; $('strengthText').textContent = t;
  });

  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('loginEmail').value.trim();
    const password = $('loginPassword').value;
    if (!email || !password) { show('Enter your email and password.', 'danger'); return; }
    const btn = e.target.querySelector('[type=submit]');
    SG.busy(btn, true, 'Signing in…');
    try { go(await SG.api.post('/auth/login', { email, password })); }
    catch (err) { show(err.message, 'danger'); SG.busy(btn, false); }
  });

  $('signupForm').addEventListener('submit', async e => {
    e.preventDefault();
    const password = $('suPassword').value;
    const required = ['suFirst', 'suLast', 'suBusiness', 'suEmail'].find(id => !$(id).value.trim());
    if (required) { show('Please fill in all required fields.', 'danger'); $(required).focus(); return; }
    if (password.length < 10) { show('Password must be at least 10 characters long.', 'danger'); return; }
    if (password !== $('suConfirm').value) { show('Passwords do not match.', 'danger'); return; }
    if (!$('suTerms').checked) { show('Please accept the terms to continue.', 'danger'); return; }
    const btn = e.target.querySelector('[type=submit]');
    SG.busy(btn, true, 'Creating account…');
    try {
      go(await SG.api.post('/auth/register', {
        business_name: $('suBusiness').value.trim(),
        full_name: `${$('suFirst').value.trim()} ${$('suLast').value.trim()}`,
        email: $('suEmail').value.trim(), phone: $('suPhone').value.trim(), password,
      }));
    } catch (err) { show(err.message, 'danger'); SG.busy(btn, false); }
  });
})();
