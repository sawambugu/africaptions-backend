const TOKEN_KEY = 'ap_token';

function getToken() { return localStorage.getItem(TOKEN_KEY); }
function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); }

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  // Let uploads set their own headers (browser sets multipart boundary).
  if (options.body instanceof FormData) delete headers['Content-Type'];

  const res = await fetch(`/api${path}`, { ...options, headers });
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : null;

  if (!res.ok) {
    throw new Error((data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}

let state = { user: null, client: null, currentProjectId: null, planDays: 30 };

api('/billing/plan')
  .then((data) => {
    state.planDays = data.planDays;
    document.getElementById('planDaysLabel').textContent = data.planDays;
  })
  .catch(() => {});

// --- View plumbing ----------------------------------------------------------

function showAuthView() {
  document.getElementById('authView').classList.remove('hidden');
  document.getElementById('appView').classList.add('hidden');
  document.getElementById('userbox').classList.add('hidden');
}

function showAppView() {
  document.getElementById('authView').classList.add('hidden');
  document.getElementById('appView').classList.remove('hidden');
  document.getElementById('userbox').classList.remove('hidden');
}

function setMainTab(view) {
  document.querySelectorAll('#mainTabs .tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  ['projects', 'upgrade', 'clients'].forEach((v) => {
    document.getElementById(`${v}View`).classList.toggle('hidden-view', v !== view);
  });
  document.getElementById('projectDetailView').classList.add('hidden-view');
}

document.getElementById('mainTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  setMainTab(btn.dataset.view);
  if (btn.dataset.view === 'projects') loadProjects();
  if (btn.dataset.view === 'clients') loadClients();
});

document.querySelectorAll('#authView .tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#authView .tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('loginForm').classList.toggle('hidden', btn.dataset.tab !== 'login');
    document.getElementById('registerForm').classList.toggle('hidden', btn.dataset.tab !== 'register');
  });
});

// --- Auth --------------------------------------------------------------------

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  try {
    const data = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
    });
    setToken(data.token);
    await boot();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const errEl = document.getElementById('registerError');
  errEl.textContent = '';
  try {
    const data = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: form.get('email'),
        password: form.get('password'),
        clientName: form.get('clientName'),
      }),
    });
    setToken(data.token);
    await boot();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  clearToken();
  state = { user: null, client: null, currentProjectId: null };
  showAuthView();
});

function isEntitled() {
  return state.user && (state.user.role === 'ADMIN' || (state.client && state.client.tier === 'ADVANCED'));
}

async function boot() {
  const token = getToken();
  if (!token) return showAuthView();

  try {
    const me = await api('/auth/me');
    state.user = me.user;
    state.client = me.client;
  } catch (err) {
    clearToken();
    return showAuthView();
  }

  showAppView();
  document.getElementById('userEmail').textContent = state.user.email;
  document.getElementById('tierBadge').textContent =
    state.user.role === 'ADMIN' ? 'STAFF' : (state.client ? state.client.tier : 'FREE');
  document.getElementById('clientsTabBtn').classList.toggle('hidden', state.user.role !== 'ADMIN');

  setMainTab(isEntitled() ? 'projects' : 'upgrade');
  if (isEntitled()) loadProjects();
}

// --- Upgrade / billing ---------------------------------------------------

document.getElementById('paystackBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('upgradeError');
  errEl.textContent = '';
  try {
    const data = await api('/billing/paystack/initialize', { method: 'POST' });
    window.location.href = data.authorizationUrl;
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('mpesaForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const errEl = document.getElementById('upgradeError');
  const statusEl = document.getElementById('mpesaStatus');
  errEl.textContent = '';
  statusEl.textContent = '';
  try {
    const data = await api('/billing/mpesa/stk-push', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber: form.get('phoneNumber') }),
    });
    statusEl.textContent = data.message;
    pollPaymentStatus(data.reference, statusEl);
  } catch (err) {
    errEl.textContent = err.message;
  }
});

function pollPaymentStatus(reference, statusEl, attempt = 0) {
  if (attempt > 20) {
    statusEl.textContent = 'Still waiting for confirmation — check back shortly.';
    return;
  }
  setTimeout(async () => {
    try {
      const data = await api(`/billing/status/${reference}`);
      if (data.status === 'SUCCESS') {
        statusEl.textContent = 'Payment received! Your account is now Advanced.';
        await boot();
      } else if (data.status === 'FAILED') {
        statusEl.textContent = 'Payment was not completed. You can try again.';
      } else {
        pollPaymentStatus(reference, statusEl, attempt + 1);
      }
    } catch (err) {
      statusEl.textContent = err.message;
    }
  }, 3000);
}

// --- Projects --------------------------------------------------------------

async function loadProjects() {
  const listEl = document.getElementById('projectsList');
  const errEl = document.getElementById('projectsError');
  errEl.textContent = '';
  listEl.innerHTML = '';
  try {
    const data = await api('/projects');
    data.projects.forEach((p) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="title">${escapeHtml(p.title)}</span><span class="meta">${p.status}</span>`;
      li.querySelector('.title').addEventListener('click', () => openProject(p.id));
      listEl.appendChild(li);
    });
  } catch (err) {
    errEl.textContent = err.message;
  }
}

document.getElementById('newProjectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const errEl = document.getElementById('projectsError');
  errEl.textContent = '';
  try {
    await api('/projects', { method: 'POST', body: JSON.stringify({ title: form.get('title') }) });
    e.target.reset();
    loadProjects();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('backToProjects').addEventListener('click', () => {
  document.getElementById('projectDetailView').classList.add('hidden-view');
  document.getElementById('projectsView').classList.remove('hidden-view');
});

async function openProject(id) {
  state.currentProjectId = id;
  document.getElementById('projectsView').classList.add('hidden-view');
  document.getElementById('projectDetailView').classList.remove('hidden-view');

  const { project } = await api(`/projects/${id}`);
  document.getElementById('projectTitle').textContent = project.title;
  document.getElementById('projectStatus').value = project.status;

  await loadMedia(id);
  await loadCaptions(id);
}

document.getElementById('projectStatus').addEventListener('change', async (e) => {
  await api(`/projects/${state.currentProjectId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: e.target.value }),
  });
});

async function loadMedia(projectId) {
  const listEl = document.getElementById('mediaList');
  listEl.innerHTML = '';
  const { media } = await api(`/projects/${projectId}/media`);
  media.forEach((m) => {
    const li = document.createElement('li');
    li.innerHTML = `<a href="${m.url}" target="_blank" class="title">${escapeHtml(m.filename)}</a><span class="meta">${(m.sizeBytes / 1024).toFixed(0)} KB</span>`;
    listEl.appendChild(li);
  });
}

document.getElementById('uploadMediaForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fileInput = e.target.file;
  const body = new FormData();
  body.append('file', fileInput.files[0]);
  await api(`/projects/${state.currentProjectId}/media`, { method: 'POST', body });
  e.target.reset();
  loadMedia(state.currentProjectId);
});

async function loadCaptions(projectId) {
  const listEl = document.getElementById('captionsList');
  listEl.innerHTML = '';
  const { captionTracks } = await api(`/projects/${projectId}/captions`);
  captionTracks.forEach((c) => {
    const li = document.createElement('li');
    li.innerHTML = `<a href="${c.fileUrl}" target="_blank" class="title">${escapeHtml(c.language)} (${c.format})</a>`;
    listEl.appendChild(li);
  });
}

document.getElementById('newCaptionForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  await api(`/projects/${state.currentProjectId}/captions`, {
    method: 'POST',
    body: JSON.stringify({
      language: form.get('language'),
      format: form.get('format'),
      content: form.get('content'),
    }),
  });
  e.target.reset();
  loadCaptions(state.currentProjectId);
});

// --- Admin: clients ----------------------------------------------------------

async function loadClients() {
  const tbody = document.getElementById('clientsTableBody');
  tbody.innerHTML = '';
  const { clients } = await api('/admin/clients');
  clients.forEach((c) => {
    const tr = document.createElement('tr');
    const expires = c.tierExpiresAt ? new Date(c.tierExpiresAt).toLocaleDateString() : '—';
    tr.innerHTML = `
      <td>${escapeHtml(c.name)}</td>
      <td>${c.users.map((u) => escapeHtml(u.email)).join(', ')}</td>
      <td>${c.tier}</td>
      <td>${expires}</td>
      <td>
        <select data-client="${c.id}" class="grantSelect">
          <option value="">Set tier…</option>
          <option value="FREE">FREE</option>
          <option value="STANDARD">STANDARD</option>
          <option value="ADVANCED">ADVANCED</option>
        </select>
      </td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.grantSelect').forEach((select) => {
    select.addEventListener('change', async () => {
      const tier = select.value;
      if (!tier) return;
      const tierExpiresAt =
        tier === 'ADVANCED'
          ? new Date(Date.now() + state.planDays * 24 * 60 * 60 * 1000).toISOString()
          : null;
      await api(`/admin/clients/${select.dataset.client}/tier`, {
        method: 'PATCH',
        body: JSON.stringify({ tier, tierExpiresAt }),
      });
      loadClients();
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

boot();
