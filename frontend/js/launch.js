/* /app — where the installed app starts. Sends each person to the right place, online or offline. */
(async function () {
  'use strict';

  function homeFor(perms) {
    if (perms.includes('reports')) return '/index.html';
    if (perms.includes('pos')) return '/cashierdash.html';
    return '/profile.html';
  }

  try {
    const session = await SG.api.request('/auth/me', { quiet401: true });
    location.replace(homeFor(session.user.permissions));
  } catch (err) {
    if (err.status !== 0) { location.replace('/auth.html'); return; }
    // Server unreachable. Someone signed in here before → open the POS (it sells offline).
    const cached = SG.cachedSession();
    if (!cached) { location.replace('/offline.html'); return; }
    const perms = cached.session.user.permissions;
    location.replace(perms.includes('pos') ? '/pos.html' : homeFor(perms));
  }
})();
