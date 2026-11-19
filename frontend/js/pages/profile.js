(async function () {
  'use strict';
  const session = await SG.boot({ title: 'My Profile' });
  if (!session) return;
  const { html, setHTML } = SG;
  const u = session.user;
  const main = document.querySelector('main');
  const PERM_LABELS = { pos: 'Process sales', refund: 'Issue refunds', discount: 'Apply discounts', inventory: 'Manage inventory', suppliers: 'Suppliers', customers: 'Customers & credit',
    employees: 'Manage employees', shifts: 'Manage shifts', cash: 'Cash management', expenses: 'Expenses', reports: 'Reports', approvals: 'Approvals', security: 'Security', audit: 'Audit logs', devices: 'Devices', settings: 'Settings' };

  setHTML(main, html`
    <div class="page-header"><div><h1 class="page-title">My Profile</h1><p class="page-subtitle">Your account details and password.</p></div></div>
    <div class="row grid-gap">
      <div class="col-lg-5"><div class="card-sg h-100"><div class="d-flex align-items-center gap-3 mb-3"><span class="sg-avatar lg">${u.initials}</span><div><div class="fs-5 fw-bold">${u.name}</div><div class="small text-muted-sg">${session.role_label} · ${u.employee_code || ''}</div><div class="small text-muted-sg">${session.business.name}</div></div></div>
        <form id="profileForm" novalidate>
          <div class="mb-3"><label class="form-label" for="full_name">Full name</label><input class="form-control" id="full_name" value="${u.name}" maxlength="160" required></div>
          <div class="mb-3"><label class="form-label" for="phone">Phone</label><input class="form-control" id="phone" type="tel" value="${u.phone}" maxlength="40"></div>
          <div class="mb-3"><label class="form-label">Email</label><input class="form-control" value="${u.email}" disabled><div class="form-text">Ask your manager to change your sign-in email.</div></div>
          <button class="btn-sg btn-forest" type="submit"><i class="bi bi-check-lg"></i> Save</button>
        </form>
        <h3 class="h6 fw-bold mt-4">What you can do</h3><div class="d-flex flex-wrap gap-1">${u.permissions.map(p => html`<span class="badge-st gray">${PERM_LABELS[p] || p}</span>`)}</div>
        <div class="small text-muted-sg mt-3">Last sign-in: ${u.last_login_at ? SG.fmtDateTime(u.last_login_at) : '—'}</div>
      </div></div>
      <div class="col-lg-7"><div class="card-sg"><h2 class="card-title mb-3"><i class="bi bi-key"></i> Change password</h2>
        <form id="pwForm" novalidate>
          <div class="mb-3"><label class="form-label" for="current">Current password</label><input class="form-control" type="password" id="current" autocomplete="current-password" required></div>
          <div class="row"><div class="col-sm-6 mb-3"><label class="form-label" for="newpw">New password</label><input class="form-control" type="password" id="newpw" autocomplete="new-password" required><div class="form-text">At least 10 characters with letters and numbers or symbols.</div></div>
            <div class="col-sm-6 mb-3"><label class="form-label" for="confirmpw">Confirm new password</label><input class="form-control" type="password" id="confirmpw" autocomplete="new-password" required></div></div>
          <div class="notice warn mb-3"><i class="bi bi-info-circle"></i><div>Changing your password signs you out on all other devices.</div></div>
          <div class="notice danger mb-3 d-none" id="pwErr"></div>
          <button class="btn-sg btn-forest" type="submit"><i class="bi bi-shield-lock"></i> Update password</button>
        </form></div></div>
    </div>`);

  document.getElementById('profileForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button'); SG.busy(btn, true, 'Saving…');
    try { await SG.api.patch('/auth/me', { full_name: document.getElementById('full_name').value.trim(), phone: document.getElementById('phone').value.trim() }); SG.ok('Profile updated.'); }
    catch (err) { SG.fail(err); } finally { SG.busy(btn, false); }
  });
  document.getElementById('pwForm').addEventListener('submit', async e => {
    e.preventDefault();
    const err = document.getElementById('pwErr'); err.classList.add('d-none');
    const current = document.getElementById('current').value, next = document.getElementById('newpw').value;
    if (next !== document.getElementById('confirmpw').value) { err.textContent = 'New passwords do not match.'; err.classList.remove('d-none'); return; }
    const btn = e.target.querySelector('button'); SG.busy(btn, true, 'Updating…');
    try { await SG.api.post('/auth/change-password', { current_password: current, new_password: next }); e.target.reset(); SG.ok('Password changed.'); }
    catch (ex) { err.textContent = ex.message; err.classList.remove('d-none'); } finally { SG.busy(btn, false); }
  });
})();
