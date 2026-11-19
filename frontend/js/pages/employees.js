(async function () {
  'use strict';
  const session = await SG.boot({ title: 'Employees' });
  if (!session) return;
  const { html, setHTML, money, int } = SG;
  const main = document.querySelector('main');
  const PERM_LABELS = { pos: 'Process sales (POS)', refund: 'Issue refunds', discount: 'Apply discounts', inventory: 'Manage inventory', suppliers: 'Suppliers & purchases',
    customers: 'Customers & credit', employees: 'Manage employees', shifts: 'Manage shifts', cash: 'Cash management', expenses: 'Approve expenses', reports: 'View reports',
    approvals: 'Approve requests', security: 'Security alerts', audit: 'Audit logs', devices: 'Manage devices', settings: 'Business settings' };
  const SHIFTS = [{ value: 'morning', label: 'Morning (6am – 2pm)' }, { value: 'afternoon', label: 'Afternoon (2pm – 10pm)' }, { value: 'night', label: 'Night (10pm – 6am)' }];
  let data = { employees: [] }, view = SG.store.get('sg_emp_view', 'grid');
  const f = { q: '', role: '', status: '' };

  setHTML(main, html`
    <div class="page-header">
      <div><h1 class="page-title">Employees</h1><p class="page-subtitle">Staff accounts, roles, permissions and today's performance.</p></div>
      <div class="page-actions"><button class="btn-sg btn-soft" id="exportBtn"><i class="bi bi-download"></i> Export</button><button class="btn-sg btn-forest" id="addBtn"><i class="bi bi-person-plus"></i> Add employee</button></div>
    </div>
    <div class="stats-grid" id="stats"></div>
    <div class="filters-bar">
      <div class="filter-search"><i class="bi bi-search"></i><input type="search" id="q" placeholder="Name, email or employee ID…"></div>
      <select class="form-select-sg" id="role" aria-label="Role"><option value="">All roles</option>${Object.entries(SG.ROLE_LABELS).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select>
      <select class="form-select-sg" id="status" aria-label="Status"><option value="">All statuses</option><option value="active">On shift</option><option value="on_break">On break</option><option value="off_shift">Off shift</option><option value="suspended">Suspended</option></select>
      <div class="chip-group ms-auto" id="viewToggle"><button class="chip ${view === 'grid' ? 'active' : ''}" data-view="grid" aria-label="Card view"><i class="bi bi-grid-3x3-gap"></i></button><button class="chip ${view === 'table' ? 'active' : ''}" data-view="table" aria-label="Table view"><i class="bi bi-list-ul"></i></button></div>
    </div>
    <div id="gridView" class="emp-grid"></div>
    <div id="tableView" class="card-sg flush d-none"><div id="table"></div></div>`);

  const statusLabel = { active: 'On shift', on_break: 'On break', off_shift: 'Off shift', suspended: 'Suspended' };
  const table = new SG.Table(document.getElementById('table'), {
    rows: [], pageSize: 15, onRowClick: e => detail(e.id),
    columns: [
      { key: 'name', label: 'Employee', sortable: true, render: e => html`<div class="cell-flex"><span class="sg-avatar sm">${e.initials}</span><div><div class="cell-main">${e.name}</div><div class="cell-sub">${e.employee_code} · ${e.email}</div></div></div>` },
      { key: 'role', label: 'Role', sortable: true, render: e => e.role_label },
      { key: 'status', label: 'Status', sortable: true, render: e => SG.badge(e.status, statusLabel[e.status]) },
      { key: 'shift_pattern', label: 'Shift', render: e => SG.titleCase(e.shift_pattern) },
      { key: 'txns_today', label: 'Txns today', className: 'num', sortable: true },
      { key: 'sales_today', label: 'Sales today', className: 'num', sortable: true, sortValue: e => SG.toNumber(e.sales_today), render: e => money(e.sales_today) },
      { key: 'refunds_today', label: 'Refunds', className: 'num', sortable: true },
      { key: 'last_login_at', label: 'Last sign-in', render: e => e.last_login_at ? SG.ago(e.last_login_at) : 'Never' },
    ],
  });

  function filtered() {
    const q = f.q.toLowerCase();
    return data.employees.filter(e => (!q || e.name.toLowerCase().includes(q) || e.email.toLowerCase().includes(q) || e.employee_code.toLowerCase().includes(q))
      && (!f.role || e.role === f.role) && (!f.status || e.status === f.status));
  }
  function render() {
    const list = filtered();
    const es = data.employees;
    setHTML(document.getElementById('stats'), html`
      <div class="stat-card"><div class="stat-label">Staff accounts <i class="bi bi-people"></i></div><div class="stat-value">${es.filter(e => e.active).length}</div><div class="stat-sub">${es.length} total incl. suspended</div></div>
      <div class="stat-card"><div class="stat-label">On shift now <i class="bi bi-person-check"></i></div><div class="stat-value text-emerald">${es.filter(e => e.status === 'active').length}</div><div class="stat-sub">Shift open</div></div>
      <div class="stat-card"><div class="stat-label">On break <i class="bi bi-cup-hot"></i></div><div class="stat-value text-amber">${es.filter(e => e.status === 'on_break').length}</div><div class="stat-sub">Temporarily away</div></div>
      <div class="stat-card"><div class="stat-label">Suspended <i class="bi bi-person-x"></i></div><div class="stat-value text-red">${es.filter(e => e.status === 'suspended').length}</div><div class="stat-sub">Cannot sign in</div></div>`);
    table.setRows(list);
    setHTML(document.getElementById('gridView'), list.length ? html`${list.map(e => html`<div class="emp-card" data-id="${e.id}" tabindex="0" role="button" aria-label="${e.name}">
      <div class="d-flex align-items-center gap-3"><span class="sg-avatar">${e.initials}</span><div class="min-w-0 flex-grow-1"><div class="fw-600 text-truncate">${e.name}</div><div class="small-xs text-muted-sg">${e.role_label} · ${e.employee_code}</div></div>${SG.badge(e.status, statusLabel[e.status])}</div>
      <div class="small-xs text-muted-sg mt-2"><i class="bi bi-envelope me-1"></i>${e.email}${e.phone ? html`<br><i class="bi bi-telephone me-1"></i>${e.phone}` : ''}</div>
      <div class="emp-stats"><div><div class="v">${e.txns_today}</div><div class="k">Txns</div></div><div><div class="v">${SG.moneyCompact(e.sales_today)}</div><div class="k">Sales</div></div><div><div class="v ${e.refunds_today >= 3 ? 'text-red' : ''}">${e.refunds_today}</div><div class="k">Refunds</div></div></div></div>`)}`
      : html`<div class="card-sg" style="grid-column:1/-1"><div class="empty-state"><i class="bi bi-people"></i><div class="title">No employees match</div></div></div>`);
    document.getElementById('gridView').classList.toggle('d-none', view !== 'grid');
    document.getElementById('tableView').classList.toggle('d-none', view !== 'table');
  }
  async function load() { try { data = await SG.api.get('/employees'); render(); } catch (e) { SG.fail(e); } }

  function permEditor(selected, useDefaults) {
    return html`<div class="form-check form-switch mb-2"><input class="form-check-input" type="checkbox" id="useDefaults" ${useDefaults ? SG.raw('checked') : ''}><label class="form-check-label small" for="useDefaults">Use the role's default permissions</label></div>
      <div class="perm-grid" id="permGrid">${data.permissions.map(p => html`<label class="perm-item"><span>${PERM_LABELS[p] || p}</span><input class="form-check-input m-0" type="checkbox" data-perm="${p}" ${selected.includes(p) ? SG.raw('checked') : ''} ${useDefaults || (p === 'settings' && session.user.role !== 'owner') ? SG.raw('disabled') : ''}></label>`)}</div>`;
  }
  function wirePerms(m, roleSelect) {
    const sync = () => {
      const defaults = m.el.querySelector('#useDefaults').checked;
      const role = roleSelect.value;
      m.el.querySelectorAll('[data-perm]').forEach(cb => {
        cb.disabled = defaults || (cb.dataset.perm === 'settings' && session.user.role !== 'owner');
        if (defaults) cb.checked = (data.role_defaults[role] || []).includes(cb.dataset.perm);
      });
    };
    m.el.querySelector('#useDefaults').addEventListener('change', sync);
    roleSelect.addEventListener('change', sync);
    sync();
  }
  const readPerms = m => (m.el.querySelector('#useDefaults').checked ? null : [...m.el.querySelectorAll('[data-perm]:checked')].map(cb => cb.dataset.perm));
  const roleOptions = current => data.assignable_roles.concat(current && !data.assignable_roles.includes(current) ? [current] : []).map(r => ({ value: r, label: SG.roleLabel(r) }));

  function addEmployee() {
    if (!data.assignable_roles.length) { SG.toast('Only owners and managers can add employees.', 'warning'); return; }
    const m = SG.formModal({ title: 'Add employee', icon: 'bi-person-plus', size: 'lg', submitText: 'Create account',
      fields: [
        { name: 'full_name', label: 'Full name', required: true, col: 6 }, { name: 'email', label: 'Email (used to sign in)', type: 'email', required: true, col: 6 },
        { name: 'phone', label: 'Phone', type: 'tel', col: 6 }, { name: 'employee_code', label: 'Employee ID', col: 6, placeholder: 'Auto-generated if blank' },
        { name: 'role', label: 'Role', type: 'select', options: roleOptions(), col: 6, default: 'cashier' }, { name: 'shift_pattern', label: 'Usual shift', type: 'select', options: SHIFTS, col: 6 },
        { name: 'password', label: 'Temporary password', type: 'text', required: true, help: 'At least 10 characters with letters and numbers. Share it privately; they can change it under My Profile.', default: tempPassword(), autocomplete: 'off' },
        { name: 'perms', label: 'Permissions', type: 'html', html: permEditor([], true) },
      ],
      onSubmit: async (v, modalRef) => {
        const { employee } = await SG.api.post('/employees', { ...v, permissions: readPerms(modalRef) });
        SG.ok(`${employee.name} can now sign in with ${employee.email}.`, 'Employee added'); load();
      } });
    wirePerms(m, m.el.querySelector('[name=role]'));
  }
  function editEmployee(e) {
    const self = e.id === session.user.id;
    const m = SG.formModal({ title: `Edit ${e.name}`, icon: 'bi-pencil-square', size: 'lg',
      fields: [
        { name: 'full_name', label: 'Full name', required: true, col: 6 }, { name: 'email', label: 'Email', type: 'email', required: true, col: 6 },
        { name: 'phone', label: 'Phone', type: 'tel', col: 6 }, { name: 'employee_code', label: 'Employee ID', col: 6 },
        { name: 'role', label: 'Role', type: 'select', options: roleOptions(e.role), col: 6, disabled: self || e.role === 'owner' }, { name: 'shift_pattern', label: 'Usual shift', type: 'select', options: SHIFTS, col: 6 },
        e.role === 'owner' ? null : { name: 'perms', label: 'Permissions', type: 'html', html: permEditor(e.permissions, !e.custom_permissions) },
      ].filter(Boolean),
      values: { ...e, full_name: e.name },
      onSubmit: async (v, modalRef) => {
        const body = { full_name: v.full_name, email: v.email, phone: v.phone, employee_code: v.employee_code, shift_pattern: v.shift_pattern };
        if (!self && e.role !== 'owner') { body.role = v.role; body.permissions = readPerms(modalRef); }
        await SG.api.patch(`/employees/${e.id}`, body); SG.ok('Employee updated.'); load();
      } });
    if (e.role !== 'owner') wirePerms(m, m.el.querySelector('[name=role]'));
  }
  function tempPassword() {
    const words = ['mango', 'cedar', 'river', 'tiger', 'amber', 'cocoa', 'harbor', 'lotus', 'orbit', 'pepper'];
    const pick = () => words[crypto.getRandomValues(new Uint32Array(1))[0] % words.length];
    return `${pick()}-${pick()}-${(crypto.getRandomValues(new Uint32Array(1))[0] % 900) + 100}`;
  }

  async function detail(id) {
    let d;
    try { d = await SG.api.get(`/employees/${id}`); } catch (e) { SG.fail(e); return; }
    const e = d.employee, s = d.stats_30d;
    const listed = data.employees.find(x => x.id === id) || e;
    const self = e.id === session.user.id;
    const m = SG.modal({ title: e.name, icon: 'bi-person-vcard', size: 'xl',
      body: html`<div class="d-flex flex-wrap gap-3 align-items-center mb-3"><span class="sg-avatar lg">${e.initials}</span><div><div class="fs-5 fw-bold">${e.name}</div><div class="small text-muted-sg">${e.role_label} · ${e.employee_code} · ${e.email}${e.phone ? ` · ${e.phone}` : ''}</div>
        <div class="mt-1">${SG.badge(listed.status || (e.active ? 'active' : 'suspended'), statusLabel[listed.status] || (e.active ? 'Active' : 'Suspended'))} <span class="small text-muted-sg ms-2">Last sign-in ${e.last_login_at ? SG.fmtDateTime(e.last_login_at) : 'never'}</span></div></div></div>
        <div class="stats-grid">
          <div class="stat-card"><div class="stat-label">Sales · 30d</div><div class="stat-value">${money(s.sales)}</div><div class="stat-sub">${int(s.txns)} transactions</div></div>
          <div class="stat-card"><div class="stat-label">Discounts · 30d</div><div class="stat-value">${money(s.discounts)}</div></div>
          <div class="stat-card"><div class="stat-label">Refunds · 30d</div><div class="stat-value ${s.refunds >= 5 ? 'text-red' : ''}">${s.refunds}</div><div class="stat-sub">${money(s.refund_amount)}</div></div>
          <div class="stat-card"><div class="stat-label">Cash variance · 30d</div><div class="stat-value ${SG.toNumber(s.cash_variance) < 0 ? 'text-red' : ''}">${money(s.cash_variance, { signed: true })}</div><div class="stat-sub">Across closed shifts</div></div>
        </div>
        <div class="row grid-gap">
          <div class="col-lg-6"><h3 class="h6 fw-bold">Recent shifts</h3>${d.shifts.length ? d.shifts.map(sh => html`<div class="list-row"><i class="bi bi-clock-history text-emerald"></i><div class="main"><div class="fw-600">${SG.fmtDateTime(sh.opened_at)}${sh.closed_at ? ` – ${SG.fmtTime(sh.closed_at)}` : ''}</div><div class="meta">${SG.badge(sh.status)}${sh.variance !== null ? html`<span class="${SG.toNumber(sh.variance) < 0 ? 'text-red' : ''}">Variance ${money(sh.variance, { signed: true })}</span>` : ''}${sh.late_minutes ? html`<span class="text-amber">Late ${sh.late_minutes} min</span>` : ''}</div></div></div>`) : html`<div class="small text-muted-sg">No shifts yet.</div>`}
            ${d.alerts.length ? html`<h3 class="h6 fw-bold mt-3">Alerts involving this employee</h3>${d.alerts.map(a => html`<div class="list-row"><span class="sev-dot ${a.severity} mt-1"></span><div class="main"><div class="fw-600">${a.title}</div><div class="meta"><span>${SG.ago(a.created_at)}</span>${SG.badge(a.status)}</div></div></div>`)}` : ''}</div>
          <div class="col-lg-6"><h3 class="h6 fw-bold">Recent activity</h3>${d.activity.length ? d.activity.map(a => html`<div class="list-row"><i class="bi bi-dot"></i><div class="main"><div>${a.reason}</div><div class="meta"><span class="mono">${a.action}</span><span>${SG.ago(a.created_at)}</span></div></div></div>`) : html`<div class="small text-muted-sg">No activity yet.</div>`}</div>
        </div>
        <h3 class="h6 fw-bold mt-3">Permissions ${e.custom_permissions ? SG.badge('pending', 'Custom') : SG.badge('none', 'Role default')}</h3><div class="d-flex flex-wrap gap-1">${e.permissions.map(p => html`<span class="badge-st gray">${PERM_LABELS[p] || p}</span>`)}</div>`,
      footer: html`${!self ? html`<button class="btn-sg ${e.active ? 'btn-danger-soft' : 'btn-soft'} me-auto" data-toggle>${e.active ? html`<i class="bi bi-person-x"></i> Suspend` : html`<i class="bi bi-person-check"></i> Reactivate`}</button><button class="btn-sg btn-soft" data-reset><i class="bi bi-key"></i> Reset password</button>` : ''}<button class="btn-sg btn-forest" data-edit><i class="bi bi-pencil"></i> Edit</button>` });
    const after = fn => () => { m.el.addEventListener('hidden.bs.modal', fn, { once: true }); m.hide(); };
    m.el.querySelector('[data-edit]').addEventListener('click', after(() => editEmployee(listed)));
    const reset = m.el.querySelector('[data-reset]');
    if (reset) reset.addEventListener('click', after(() => SG.formModal({ title: `Reset password · ${e.name}`, icon: 'bi-key', submitText: 'Reset password',
      intro: html`<div class="notice warn"><i class="bi bi-info-circle"></i><div>They'll be signed out everywhere and must use this new password.</div></div>`,
      fields: [{ name: 'password', label: 'New temporary password', required: true, default: tempPassword(), autocomplete: 'off' }],
      onSubmit: async v => { await SG.api.post(`/employees/${e.id}/reset-password`, v); SG.ok('Password reset. Share it with the employee privately.'); } })));
    const toggle = m.el.querySelector('[data-toggle]');
    if (toggle) toggle.addEventListener('click', after(async () => {
      if (e.active) {
        const reason = await SG.confirm({ title: `Suspend ${e.name}?`, message: 'They will be signed out immediately and cannot sign in until reactivated.', confirmText: 'Suspend', danger: true, input: { label: 'Reason', required: true } });
        if (reason === null) return;
        try { await SG.api.patch(`/employees/${e.id}`, { active: false, reason }); SG.ok('Employee suspended.'); load(); } catch (err) { SG.fail(err); }
      } else {
        try { await SG.api.patch(`/employees/${e.id}`, { active: true }); SG.ok('Employee reactivated.'); load(); } catch (err) { SG.fail(err); }
      }
    }));
  }

  document.getElementById('q').addEventListener('input', SG.debounce(e => { f.q = e.target.value.trim(); render(); }, 150));
  document.getElementById('role').addEventListener('change', e => { f.role = e.target.value; render(); });
  document.getElementById('status').addEventListener('change', e => { f.status = e.target.value; render(); });
  document.getElementById('viewToggle').addEventListener('click', e => {
    const b = e.target.closest('[data-view]'); if (!b) return;
    view = b.dataset.view; SG.store.set('sg_emp_view', view);
    document.querySelectorAll('#viewToggle .chip').forEach(x => x.classList.toggle('active', x === b)); render();
  });
  document.getElementById('gridView').addEventListener('click', e => { const c = e.target.closest('.emp-card'); if (c) detail(parseInt(c.dataset.id, 10)); });
  document.getElementById('gridView').addEventListener('keydown', e => { const c = e.target.closest('.emp-card'); if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); detail(parseInt(c.dataset.id, 10)); } });
  document.getElementById('addBtn').addEventListener('click', addEmployee);
  document.getElementById('exportBtn').addEventListener('click', () => SG.exportCSV('employees', filtered(), [
    { label: 'Name', value: e => e.name }, { label: 'Employee ID', value: e => e.employee_code }, { label: 'Email', value: e => e.email },
    { label: 'Phone', value: e => e.phone }, { label: 'Role', value: e => e.role_label }, { label: 'Shift', value: e => e.shift_pattern },
    { label: 'Status', value: e => statusLabel[e.status] }, { label: 'Txns today', value: e => e.txns_today }, { label: 'Sales today', value: e => e.sales_today },
    { label: 'Last sign-in', value: e => e.last_login_at ? SG.fmtDateTime(e.last_login_at) : '' },
  ]));

  await load();
  if (SG.param('id')) detail(parseInt(SG.param('id'), 10));
})();
