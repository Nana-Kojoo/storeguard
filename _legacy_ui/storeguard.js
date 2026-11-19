(function () {
  'use strict';

  const API_PREFIX = '/api';
  const iconByCategory = {
    food: 'bi-basket', beverages: 'bi-cup-straw', household: 'bi-house',
    personal: 'bi-heart', snacks: 'bi-cookie', dairy: 'bi-cup'
  };

  async function request(path, options) {
    const response = await fetch(API_PREFIX + path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(options && options.headers) },
      ...options
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  }

  function showError(message) {
    window.alert(message);
  }

  function redirectToLogin() {
    if (!window.location.pathname.endsWith('/auth.html')) window.location.href = '/auth.html';
  }

  async function requireUser() {
    try { return (await request('/auth/me')).user; }
    catch (error) { if (error.message.includes('Authentication required')) redirectToLogin(); return null; }
  }

  function mapProduct(product) {
    return {
      ...product,
      price: Number(product.price),
      stock: product.stock_quantity,
      minStock: product.reorder_level,
      icon: iconByCategory[product.category] || 'bi-box'
    };
  }

  async function loadProducts() {
    const body = await request('/products');
    return body.products.map(mapProduct);
  }

  function wireNavigation() {
    const links = document.querySelectorAll('.nav-link');
    const routes = {
      'Overview': '/index.html', 'Point of Sale': '/pos.html', 'Sales & Transactions': '/st.html',
      'Inventory': '/inventory.html', Employees: '/employees.html'
    };
    links.forEach(link => {
      const label = link.querySelector('.nav-text')?.textContent.trim();
      if (routes[label]) { link.href = routes[label]; link.addEventListener('click', () => { link.classList.add('active'); }); }
      else link.addEventListener('click', event => { event.preventDefault(); showError(`${label || 'This module'} is not connected yet.`); });
    });
    document.querySelectorAll('a[href="#"]').forEach(link => {
      if (!link.classList.contains('nav-link')) link.addEventListener('click', event => event.preventDefault());
    });
  }

  async function wireAuth() {
    const loginForm = document.getElementById('loginForm');
    const signupForm = document.getElementById('signupForm');
    if (!loginForm || !signupForm) return;
    if (loginForm.dataset.apiWired) return;
    loginForm.dataset.apiWired = 'true';

    loginForm.addEventListener('submit', async event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const button = loginForm.querySelector('.btn-submit');
      button.disabled = true;
      try {
        await request('/auth/login', { method: 'POST', body: JSON.stringify({
          email: document.getElementById('loginEmail').value.trim(),
          password: document.getElementById('loginPassword').value
        }) });
        window.location.href = '/index.html';
      } catch (error) { showError(error.message); }
      finally { button.disabled = false; }
    });

    signupForm.addEventListener('submit', async event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const password = document.getElementById('signupPassword').value;
      if (password.length < 10) { showError('Password must be at least 10 characters long.'); return; }
      if (password !== document.getElementById('signupConfirmPassword').value) { showError('Passwords do not match.'); return; }
      if (!document.getElementById('agreeTerms').checked) { showError('You must agree to the Terms of Service and Privacy Policy.'); return; }
      const button = signupForm.querySelector('.btn-submit');
      button.disabled = true;
      try {
        await request('/auth/register', { method: 'POST', body: JSON.stringify({
          business_name: document.getElementById('signupBusiness').value.trim(),
          full_name: `${document.getElementById('signupFirstName').value.trim()} ${document.getElementById('signupLastName').value.trim()}`,
          email: document.getElementById('signupEmail').value.trim(), password
        }) });
        window.location.href = '/index.html';
      } catch (error) { showError(error.message); }
      finally { button.disabled = false; }
    });
  }

  async function wireInventory() {
    const table = document.getElementById('inventoryTableBody');
    if (!table) return;
    const original = window.fetch;
    try {
      const user = await requireUser();
      if (!user) return;
      const products = await loadProducts();
      window.storeGuardProducts = products;
      document.dispatchEvent(new CustomEvent('storeguard:products-loaded', { detail: products }));
    } catch (error) { showError(error.message); }
    return original;
  }

  async function wirePos() {
    if (!document.getElementById('productGrid')) return;
    try {
      const user = await requireUser();
      if (!user) return;
      const products = await loadProducts();
      window.storeGuardProducts = products;
      document.dispatchEvent(new CustomEvent('storeguard:products-loaded', { detail: products }));
    } catch (error) { showError(error.message); }
  }

  function wireLogout() {
    document.querySelectorAll('.logout-action, [title="Logout"], .dropdown-item.text-danger').forEach(button => {
      button.addEventListener('click', async event => {
        event.preventDefault();
        try { await request('/auth/logout', { method: 'POST' }); } finally { window.location.href = '/auth.html'; }
      });
    });
  }

  window.StoreGuard = { request, requireUser, loadProducts, mapProduct, showError };
  if (document.getElementById('loginForm')) wireAuth();
  document.addEventListener('DOMContentLoaded', () => {
    wireNavigation(); wireLogout(); wireAuth(); wireInventory(); wirePos();
    if (!document.getElementById('loginForm')) requireUser();
  });
})();
