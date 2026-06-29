'use strict';

/* ============================================================
   Mail Rate-Limit Control — vanilla SPA
   ============================================================ */

const API_BASE = '/api';
const TOKEN_KEY = 'rlc_token';

/* ---------- State ---------- */
const state = {
  tab: 'dashboard',
  tiers: [],          // cached tier list (used by dropdowns/labels)
  dashTimer: null,
  dashWindow: 'h1',
  senders: { search: '', status: '', page: 1, pageSize: 50, total: 0 },
  events: { email: '', action: '' },
};

/* ---------- Tiny DOM helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'value') node.value = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d) ? esc(s) : d.toLocaleString();
}

function n(v) {
  // normalize an input value to a number or null (for nullable fields)
  if (v === '' || v === null || v === undefined) return null;
  const num = Number(v);
  return isNaN(num) ? null : num;
}

/* ---------- Token storage ---------- */
const token = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

/* ---------- Toast / banner ---------- */
let toastTimer = null;
function toast(msg, ok = false) {
  const box = $('#toast');
  $('#toast-msg').textContent = msg;
  box.classList.toggle('ok', ok);
  box.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.add('hidden'), ok ? 2500 : 6000);
}
$('#toast-close').addEventListener('click', () => $('#toast').classList.add('hidden'));

/* ---------- API helper ---------- */
async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  const t = token.get();
  if (t) headers['Authorization'] = `Bearer ${t}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    toast('Network error: ' + err.message);
    throw err;
  }

  if (res.status === 401) {
    token.clear();
    showLogin();
    const e = new Error('Unauthorized');
    e.handled = true;
    throw e;
  }

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = j.message || j.error || detail;
      if (Array.isArray(detail)) detail = detail.join(', ');
    } catch (_) { /* not json */ }
    toast(`Error ${res.status}: ${detail}`);
    const e = new Error(detail);
    e.handled = true;
    throw e;
  }

  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

/* Wrapper that swallows already-handled errors so loaders don't explode */
async function safe(promise) {
  try { return await promise; }
  catch (e) { if (!e.handled) toast(e.message || 'Unexpected error'); return undefined; }
}

function confirmAction(msg) { return window.confirm(msg); }

/* ============================================================
   Auth / shell wiring
   ============================================================ */
function showLogin() {
  stopDashTimer();
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
}

function showApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  setTab(state.tab || 'dashboard');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#login-user').value.trim();
  const password = $('#login-pass').value;
  try {
    const data = await api('/auth/login', { method: 'POST', body: { username, password } });
    if (data && data.token) {
      token.set(data.token);
      $('#login-pass').value = '';
      showApp();
    } else {
      toast('Login failed: no token returned');
    }
  } catch (e) {
    if (!e.handled) toast('Login failed');
  }
});

$('#logout').addEventListener('click', () => {
  token.clear();
  showLogin();
});

$('#nav').addEventListener('click', (e) => {
  const tab = e.target.closest('.nav-tab');
  if (tab) setTab(tab.dataset.tab);
});

function setTab(tab) {
  state.tab = tab;
  stopDashTimer();
  $$('.nav-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const fn = TABS[tab];
  if (fn) fn();
}

const view = () => $('#view');
function setView(...nodes) {
  const v = view();
  v.innerHTML = '';
  nodes.forEach((nd) => nd && v.append(nd));
}

/* Ensure tiers cache is loaded (used by Domains/Senders dropdowns) */
async function ensureTiers() {
  if (state.tiers.length) return state.tiers;
  const t = await safe(api('/tiers'));
  if (Array.isArray(t)) state.tiers = t;
  return state.tiers;
}
function tierName(id) {
  if (id === null || id === undefined) return '';
  const t = state.tiers.find((x) => x.id === id);
  return t ? t.name : `#${id}`;
}

/* ============================================================
   DASHBOARD
   ============================================================ */
function stopDashTimer() {
  if (state.dashTimer) { clearInterval(state.dashTimer); state.dashTimer = null; }
}

async function loadDashboard() {
  renderDashboardShell();
  await refreshDashboard();
  stopDashTimer();
  state.dashTimer = setInterval(() => {
    if (state.tab === 'dashboard') refreshDashboard();
  }, 10000);
}

function renderDashboardShell() {
  const head = el('div', { class: 'view-head' }, [
    el('h2', { text: 'Dashboard' }),
    el('div', { class: 'toolbar' }, [
      el('span', { class: 'muted', text: 'Top window:' }),
      el('select', {
        id: 'dash-window',
        onChange: (e) => { state.dashWindow = e.target.value; refreshTop(); },
      }, [
        optEl('m1', '1 min', state.dashWindow === 'm1'),
        optEl('h1', '1 hour', state.dashWindow === 'h1'),
        optEl('d1', '1 day', state.dashWindow === 'd1'),
        optEl('risk', 'Risk score', state.dashWindow === 'risk'),
      ]),
      el('button', { class: 'btn btn-sm', onClick: refreshDashboard, text: 'Refresh' }),
    ]),
  ]);
  setView(head, el('div', { id: 'dash-cards', class: 'cards' }), el('div', { id: 'dash-top' }));
}

function optEl(value, label, selected) {
  return el('option', { value, selected: selected ? 'selected' : null, text: label });
}

async function refreshDashboard() {
  await Promise.all([refreshStats(), refreshTop()]);
}

async function refreshStats() {
  const s = await safe(api('/dashboard/stats'));
  if (!s) return;
  const cards = $('#dash-cards');
  if (!cards) return;
  const d = s.decisions || {};
  cards.innerHTML = '';
  cards.append(
    statCard('Allow', d.allow ?? 0, 'green'),
    statCard('Defer', d.defer ?? 0, 'amber'),
    statCard('Reject', d.reject ?? 0, 'red'),
    statCard('Suspend', d.suspend ?? 0, 'red'),
    statCard('Mode', s.mode ?? '-', s.mode === 'enforce' ? 'green' : 'amber'),
    statCard('Would-suspend', s.observe ?? 0, 'amber'),
    statCard('Bounce flags', s.bounceFlags ?? 0, 'red'),
    statCard('Active senders', s.activeSenders ?? 0, ''),
    statCard('Suspended', s.suspended ?? 0, 'red'),
    redisCard(!!s.redisUp),
  );
}

function statCard(label, value, color) {
  return el('div', { class: 'card stat-card' }, [
    el('div', { class: 'stat-label', text: label }),
    el('div', { class: 'stat-value ' + color, text: String(value) }),
  ]);
}

function redisCard(up) {
  return el('div', { class: 'card stat-card' }, [
    el('div', { class: 'stat-label', text: 'Redis' }),
    el('div', { class: 'status-line' }, [
      el('span', { class: 'dot ' + (up ? 'green' : 'red') }),
      el('span', { text: up ? 'Connected' : 'Down' }),
    ]),
  ]);
}

async function refreshTop() {
  const wrap = $('#dash-top');
  if (!wrap) return;
  const rows = await safe(api(`/dashboard/top?window=${encodeURIComponent(state.dashWindow)}&limit=20`));
  if (!Array.isArray(rows)) return;
  wrap.innerHTML = '';
  const table = el('table');
  table.append(thead(['Key', 'Used', 'Limit', 'Usage']));
  const tb = el('tbody');
  if (!rows.length) {
    tb.append(el('tr', {}, el('td', { colspan: 4, class: 'empty', text: 'No senders near quota' })));
  }
  for (const r of rows) {
    const pct = Math.max(0, Math.min(100, Math.round(r.pct ?? 0)));
    tb.append(el('tr', {}, [
      el('td', { text: r.key }),
      el('td', { text: String(r.used ?? '') }),
      el('td', { text: String(r.limit ?? '') }),
      el('td', {}, pctCell(pct)),
    ]));
  }
  table.append(tb);
  wrap.append(
    el('div', { class: 'view-head' }, el('h2', { text: 'Top senders near quota' })),
    el('div', { class: 'table-wrap' }, table),
  );
}

function pctCell(pct) {
  const cls = pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : '';
  return el('span', {}, [
    el('span', { class: 'pctbar ' + cls }, el('span', { style: `width:${pct}%` })),
    el('span', { class: 'pcttxt', text: pct + '%' }),
  ]);
}

/* shared table head builder */
function thead(cols) {
  return el('thead', {}, el('tr', {}, cols.map((c) => el('th', { text: c }))));
}

/* ============================================================
   TIERS
   ============================================================ */
const TIER_FIELDS = ['perMin', 'perHour', 'perDay', 'perMonth', 'maxRcptMsg'];

async function loadTiers() {
  const head = el('div', { class: 'view-head' }, [
    el('h2', { text: 'Tiers' }),
    el('div', { class: 'toolbar' }, el('button', { class: 'btn btn-sm', text: 'Refresh', onClick: loadTiers })),
  ]);
  setView(head, tierForm(), el('div', { id: 'tiers-table' }));
  await renderTiersTable();
}

function tierForm() {
  const panel = el('div', { class: 'form-panel' });
  const f = el('form', { id: 'tier-form' });
  const grid = el('div', { class: 'form-grid' }, [
    labeledInput('name', 'Name', 'text'),
    labeledInput('perMin', 'Per minute', 'number'),
    labeledInput('perHour', 'Per hour', 'number'),
    labeledInput('perDay', 'Per day', 'number'),
    labeledInput('perMonth', 'Per month', 'number'),
    labeledInput('maxRcptMsg', 'Max rcpt/msg', 'number'),
    checkboxField('enabled', 'Enabled', true),
  ]);
  f.append(
    el('h3', { text: 'Add tier' }),
    grid,
    el('div', { class: 'form-actions' }, el('button', { class: 'btn btn-primary', text: 'Add tier' })),
  );
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    const body = {
      name: (fd.get('name') || '').toString().trim(),
      perMin: Number(fd.get('perMin') || 0),
      perHour: Number(fd.get('perHour') || 0),
      perDay: Number(fd.get('perDay') || 0),
      perMonth: Number(fd.get('perMonth') || 0),
      maxRcptMsg: Number(fd.get('maxRcptMsg') || 0),
      enabled: fd.get('enabled') === 'on',
    };
    if (!body.name) { toast('Tier name is required'); return; }
    const r = await safe(api('/tiers', { method: 'POST', body }));
    if (r) { toast('Tier created', true); f.reset(); state.tiers = []; await renderTiersTable(); }
  });
  panel.append(f);
  return panel;
}

async function renderTiersTable() {
  const wrap = $('#tiers-table');
  if (!wrap) return;
  const tiers = await safe(api('/tiers'));
  if (Array.isArray(tiers)) state.tiers = tiers;
  wrap.innerHTML = '';
  const table = el('table');
  table.append(thead(['ID', 'Name', 'Per min', 'Per hour', 'Per day', 'Per month', 'Max rcpt', 'Enabled', '']));
  const tb = el('tbody');
  if (!state.tiers.length) {
    tb.append(el('tr', {}, el('td', { colspan: 9, class: 'empty', text: 'No tiers yet' })));
  }
  for (const t of state.tiers) tb.append(tierRow(t));
  table.append(tb);
  wrap.append(el('div', { class: 'table-wrap' }, table));
}

function tierRow(t) {
  const tr = el('tr');
  tr.dataset.id = t.id;
  tr.append(
    el('td', { text: t.id }),
    el('td', { text: t.name }),
    ...TIER_FIELDS.map((fld) => el('td', { text: t[fld] })),
    el('td', {}, badge(t.enabled ? 'on' : 'off', t.enabled ? 'On' : 'Off')),
    el('td', { class: 'actions' }, [
      el('button', { class: 'btn btn-sm', text: 'Edit', onClick: () => editTierRow(tr, t) }),
      el('button', { class: 'btn btn-sm btn-danger', text: 'Delete', onClick: () => deleteTier(t) }),
    ]),
  );
  return tr;
}

function editTierRow(tr, t) {
  tr.innerHTML = '';
  const inputs = {};
  tr.append(el('td', { text: t.id }));
  const nameI = el('input', { value: t.name, class: 'inline-input', style: 'width:130px' });
  tr.append(el('td', {}, nameI));
  TIER_FIELDS.forEach((fld) => {
    const i = el('input', { type: 'number', value: t[fld], class: 'inline-input' });
    inputs[fld] = i;
    tr.append(el('td', {}, i));
  });
  const enI = el('input', { type: 'checkbox' });
  enI.checked = !!t.enabled;
  tr.append(el('td', {}, enI));
  tr.append(el('td', { class: 'actions' }, [
    el('button', {
      class: 'btn btn-sm btn-primary', text: 'Save',
      onClick: async () => {
        const body = {
          name: nameI.value.trim(), enabled: enI.checked,
        };
        TIER_FIELDS.forEach((fld) => { body[fld] = Number(inputs[fld].value || 0); });
        const r = await safe(api(`/tiers/${t.id}`, { method: 'PUT', body }));
        if (r) { toast('Tier saved', true); state.tiers = []; await renderTiersTable(); }
      },
    }),
    el('button', { class: 'btn btn-sm', text: 'Cancel', onClick: () => renderTiersTable() }),
  ]));
}

async function deleteTier(t) {
  if (!confirmAction(`Delete tier "${t.name}" (#${t.id})?`)) return;
  const r = await safe(api(`/tiers/${t.id}`, { method: 'DELETE' }));
  if (r !== undefined) { toast('Tier deleted', true); state.tiers = []; await renderTiersTable(); }
}

/* ============================================================
   DOMAINS
   ============================================================ */
async function loadDomains() {
  await ensureTiers();
  const head = el('div', { class: 'view-head' }, [
    el('h2', { text: 'Domains' }),
    el('div', { class: 'toolbar' }, el('button', { class: 'btn btn-sm', text: 'Refresh', onClick: loadDomains })),
  ]);
  setView(head, domainForm(), el('div', { id: 'domains-table' }));
  await renderDomainsTable();
}

function tierSelect(name, current) {
  const sel = el('select', { name });
  sel.append(el('option', { value: '', text: '(none)', selected: current == null ? 'selected' : null }));
  for (const t of state.tiers) {
    sel.append(el('option', {
      value: String(t.id), text: t.name,
      selected: current === t.id ? 'selected' : null,
    }));
  }
  return sel;
}

function domainForm() {
  const panel = el('div', { class: 'form-panel' });
  const f = el('form', { id: 'domain-form' });
  const grid = el('div', { class: 'form-grid' }, [
    labeledInput('domain', 'Domain', 'text'),
    field('Tier', tierSelect('tierId', null)),
    labeledInput('perHour', 'Per hour', 'number'),
    labeledInput('perDay', 'Per day', 'number'),
    field('Note', el('input', { name: 'note', type: 'text' })),
    checkboxField('enabled', 'Enabled', true),
  ]);
  f.append(
    el('h3', { text: 'Add domain' }),
    grid,
    el('div', { class: 'form-actions' }, el('button', { class: 'btn btn-primary', text: 'Add domain' })),
  );
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    const domain = (fd.get('domain') || '').toString().trim();
    if (!domain) { toast('Domain is required'); return; }
    const body = {
      domain,
      tierId: fd.get('tierId') ? Number(fd.get('tierId')) : null,
      perHour: n(fd.get('perHour')),
      perDay: n(fd.get('perDay')),
      enabled: fd.get('enabled') === 'on',
      note: (fd.get('note') || '').toString().trim() || null,
    };
    const r = await safe(api('/domains', { method: 'POST', body }));
    if (r) { toast('Domain created', true); f.reset(); await renderDomainsTable(); }
  });
  panel.append(f);
  return panel;
}

async function renderDomainsTable() {
  const wrap = $('#domains-table');
  if (!wrap) return;
  const domains = await safe(api('/domains'));
  wrap.innerHTML = '';
  const table = el('table');
  table.append(thead(['Domain', 'Tier', 'Per hour', 'Per day', 'Enabled', 'Note', '']));
  const tb = el('tbody');
  if (!Array.isArray(domains) || !domains.length) {
    tb.append(el('tr', {}, el('td', { colspan: 7, class: 'empty', text: 'No domains' })));
  } else {
    for (const d of domains) tb.append(domainRow(d));
  }
  table.append(tb);
  wrap.append(el('div', { class: 'table-wrap' }, table));
}

function domainRow(d) {
  const tr = el('tr');
  tr.append(
    el('td', { text: d.domain }),
    el('td', { text: d.tierId == null ? '—' : tierName(d.tierId) }),
    el('td', { text: d.perHour == null ? '—' : d.perHour }),
    el('td', { text: d.perDay == null ? '—' : d.perDay }),
    el('td', {}, badge(d.enabled ? 'on' : 'off', d.enabled ? 'On' : 'Off')),
    el('td', { class: 'muted', text: d.note || '' }),
    el('td', { class: 'actions' }, [
      el('button', { class: 'btn btn-sm', text: 'Edit', onClick: () => editDomainRow(tr, d) }),
      el('button', { class: 'btn btn-sm btn-danger', text: 'Delete', onClick: () => deleteDomain(d) }),
    ]),
  );
  return tr;
}

function editDomainRow(tr, d) {
  tr.innerHTML = '';
  const sel = tierSelect('tierId', d.tierId);
  const ph = el('input', { type: 'number', value: d.perHour ?? '', class: 'inline-input' });
  const pd = el('input', { type: 'number', value: d.perDay ?? '', class: 'inline-input' });
  const note = el('input', { type: 'text', value: d.note ?? '', style: 'width:140px' });
  const en = el('input', { type: 'checkbox' }); en.checked = !!d.enabled;
  tr.append(
    el('td', { text: d.domain }),
    el('td', {}, sel),
    el('td', {}, ph),
    el('td', {}, pd),
    el('td', {}, en),
    el('td', {}, note),
    el('td', { class: 'actions' }, [
      el('button', {
        class: 'btn btn-sm btn-primary', text: 'Save',
        onClick: async () => {
          const body = {
            domain: d.domain,
            tierId: sel.value ? Number(sel.value) : null,
            perHour: n(ph.value),
            perDay: n(pd.value),
            enabled: en.checked,
            note: note.value.trim() || null,
          };
          const r = await safe(api(`/domains/${encodeURIComponent(d.domain)}`, { method: 'PUT', body }));
          if (r) { toast('Domain saved', true); await renderDomainsTable(); }
        },
      }),
      el('button', { class: 'btn btn-sm', text: 'Cancel', onClick: () => renderDomainsTable() }),
    ]),
  );
}

async function deleteDomain(d) {
  if (!confirmAction(`Delete domain "${d.domain}"?`)) return;
  const r = await safe(api(`/domains/${encodeURIComponent(d.domain)}`, { method: 'DELETE' }));
  if (r !== undefined) { toast('Domain deleted', true); await renderDomainsTable(); }
}

/* ============================================================
   SENDERS
   ============================================================ */
const SENDER_LIMITS = ['perMin', 'perHour', 'perDay', 'perMonth'];

async function loadSenders() {
  await ensureTiers();
  const s = state.senders;
  const search = el('input', {
    class: 'search-input', type: 'search', placeholder: 'Search email / domain…', value: s.search,
  });
  search.addEventListener('input', debounce(() => {
    s.search = search.value.trim(); s.page = 1; renderSendersTable();
  }, 300));
  const statusSel = el('select', {
    onChange: () => { s.status = statusSel.value; s.page = 1; renderSendersTable(); },
  }, [
    optEl('', 'All statuses', s.status === ''),
    optEl('active', 'Active', s.status === 'active'),
    optEl('warmup', 'Warmup', s.status === 'warmup'),
    optEl('suspended', 'Suspended', s.status === 'suspended'),
  ]);

  const head = el('div', { class: 'view-head' }, [
    el('h2', { text: 'Senders' }),
    el('div', { class: 'toolbar' }, [search, statusSel,
      el('button', { class: 'btn btn-sm', text: 'Refresh', onClick: renderSendersTable })]),
  ]);
  setView(
    head,
    el('div', { id: 'senders-stats', class: 'cards' }),
    senderForm(),
    el('div', { id: 'senders-table' }),
    el('div', { id: 'senders-pager' }),
  );
  await renderSendersTable();
}

function renderSendersStats(stats) {
  const wrap = $('#senders-stats');
  if (!wrap) return;
  const s = stats || { total: 0, active: 0, warmup: 0, suspended: 0 };
  wrap.innerHTML = '';
  wrap.append(
    statCard('Total senders', s.total ?? 0, ''),
    statCard('Active', s.active ?? 0, 'green'),
    statCard('Warmup', s.warmup ?? 0, 'amber'),
    statCard('Suspended', s.suspended ?? 0, 'red'),
  );
}

function senderForm() {
  const panel = el('div', { class: 'form-panel' });
  const f = el('form', { id: 'sender-form' });
  const grid = el('div', { class: 'form-grid' }, [
    labeledInput('email', 'Email', 'email'),
    labeledInput('domain', 'Domain', 'text'),
    field('Tier', tierSelect('tierId', null)),
    field('Status', el('select', { name: 'status' }, [
      optEl('active', 'Active', true),
      optEl('warmup', 'Warmup', false),
      optEl('suspended', 'Suspended', false),
    ])),
    labeledInput('perMin', 'Per min', 'number'),
    labeledInput('perHour', 'Per hour', 'number'),
    labeledInput('perDay', 'Per day', 'number'),
    labeledInput('perMonth', 'Per month', 'number'),
    checkboxField('persist', 'Persist', false),
  ]);
  f.append(
    el('h3', { text: 'Add sender' }),
    grid,
    el('div', { class: 'form-actions' }, el('button', { class: 'btn btn-primary', text: 'Add sender' })),
  );
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    const email = (fd.get('email') || '').toString().trim();
    if (!email) { toast('Email is required'); return; }
    const body = {
      email,
      domain: (fd.get('domain') || '').toString().trim() || email.split('@')[1] || '',
      tierId: fd.get('tierId') ? Number(fd.get('tierId')) : null,
      status: fd.get('status') || 'active',
      persist: fd.get('persist') === 'on',
    };
    SENDER_LIMITS.forEach((fld) => { body[fld] = n(fd.get(fld)); });
    const r = await safe(api('/senders', { method: 'POST', body }));
    if (r) { toast('Sender created', true); f.reset(); await renderSendersTable(); }
  });
  panel.append(f);
  return panel;
}

async function renderSendersTable() {
  const wrap = $('#senders-table');
  if (!wrap) return;
  const s = state.senders;
  const qs = new URLSearchParams({ page: String(s.page), pageSize: String(s.pageSize) });
  if (s.search) qs.set('search', s.search);
  if (s.status) qs.set('status', s.status);
  const data = await safe(api('/senders?' + qs.toString()));
  if (!data) return;
  s.total = data.total || 0;
  const items = data.items || [];
  renderSendersStats(data.stats);

  wrap.innerHTML = '';
  const table = el('table');
  table.append(thead(['Email', 'Domain', 'Tier', 'Status', 'Limits (m/h/d/mo)', 'Would-suspend', '']));
  const tb = el('tbody');
  if (!items.length) {
    tb.append(el('tr', {}, el('td', { colspan: 7, class: 'empty', text: 'No senders found' })));
  }
  for (const it of items) tb.append(senderRow(it));
  table.append(tb);
  wrap.append(el('div', { class: 'table-wrap' }, table));
  renderSendersPager();
}

function limitsText(s) {
  return SENDER_LIMITS.map((k) => (s[k] == null ? '—' : s[k])).join(' / ');
}

/* "Would-suspend": anomaly flag count crossed the suspend threshold. In observe
   mode this is a warning only; in enforce mode such a sender is auto-suspended. */
function wouldSuspendCell(s) {
  const risk = Number(s.risk || 0);
  if (s.wouldSuspend) {
    return badge('suspended', `Yes · risk ${risk}`);
  }
  if (risk > 0) return badge('warmup', `risk ${risk}`);
  return el('span', { class: 'muted', text: '—' });
}

function senderRow(s) {
  const tr = el('tr');
  const suspended = s.status === 'suspended';
  const toggleBtn = suspended
    ? el('button', { class: 'btn btn-sm', text: 'Unsuspend', onClick: () => unsuspendSender(s) })
    : el('button', { class: 'btn btn-sm btn-danger', text: 'Suspend', onClick: () => suspendSender(s) });
  tr.append(
    el('td', { text: s.email }),
    el('td', { text: s.domain || '' }),
    el('td', { text: s.tierId == null ? '—' : tierName(s.tierId) }),
    el('td', {}, badge(s.status, s.status)),
    el('td', { class: 'muted', text: limitsText(s) }),
    el('td', {}, wouldSuspendCell(s)),
    el('td', { class: 'actions' }, [
      el('button', { class: 'btn btn-sm', text: 'Edit', onClick: () => editSenderRow(tr, s) }),
      toggleBtn,
      el('button', { class: 'btn btn-sm btn-danger', text: 'Delete', onClick: () => deleteSender(s) }),
    ]),
  );
  return tr;
}

function editSenderRow(tr, s) {
  tr.innerHTML = '';
  const sel = tierSelect('tierId', s.tierId);
  const statusSel = el('select', {}, [
    optEl('active', 'active', s.status === 'active'),
    optEl('warmup', 'warmup', s.status === 'warmup'),
    optEl('suspended', 'suspended', s.status === 'suspended'),
  ]);
  const inputs = {};
  const limitsTd = el('td');
  SENDER_LIMITS.forEach((fld) => {
    const i = el('input', { type: 'number', value: s[fld] ?? '', class: 'inline-input', style: 'width:60px', placeholder: fld });
    inputs[fld] = i;
    limitsTd.append(i);
  });
  tr.append(
    el('td', { text: s.email }),
    el('td', { text: s.domain || '' }),
    el('td', {}, sel),
    el('td', {}, statusSel),
    limitsTd,
    el('td', {}, wouldSuspendCell(s)),
    el('td', { class: 'actions' }, [
      el('button', {
        class: 'btn btn-sm btn-primary', text: 'Save',
        onClick: async () => {
          const body = {
            email: s.email, domain: s.domain,
            tierId: sel.value ? Number(sel.value) : null,
            status: statusSel.value,
            persist: !!s.persist,
          };
          SENDER_LIMITS.forEach((fld) => { body[fld] = n(inputs[fld].value); });
          const r = await safe(api(`/senders/${encodeURIComponent(s.email)}`, { method: 'PUT', body }));
          if (r) { toast('Sender saved', true); await renderSendersTable(); }
        },
      }),
      el('button', { class: 'btn btn-sm', text: 'Cancel', onClick: () => renderSendersTable() }),
    ]),
  );
}

async function suspendSender(s) {
  const reason = window.prompt(`Suspend ${s.email}? Reason:`, '');
  if (reason === null) return;
  const r = await safe(api(`/senders/${encodeURIComponent(s.email)}/suspend`, { method: 'POST', body: { reason } }));
  if (r) { toast('Sender suspended', true); await renderSendersTable(); }
}

async function unsuspendSender(s) {
  if (!confirmAction(`Unsuspend ${s.email}?`)) return;
  const r = await safe(api(`/senders/${encodeURIComponent(s.email)}/unsuspend`, { method: 'POST' }));
  if (r) { toast('Sender unsuspended', true); await renderSendersTable(); }
}

async function deleteSender(s) {
  if (!confirmAction(`Delete sender "${s.email}"?`)) return;
  const r = await safe(api(`/senders/${encodeURIComponent(s.email)}`, { method: 'DELETE' }));
  if (r !== undefined) { toast('Sender deleted', true); await renderSendersTable(); }
}

function renderSendersPager() {
  const wrap = $('#senders-pager');
  if (!wrap) return;
  const s = state.senders;
  const pages = Math.max(1, Math.ceil(s.total / s.pageSize));
  wrap.innerHTML = '';
  wrap.append(el('div', { class: 'pager' }, [
    el('button', {
      class: 'btn btn-sm', text: '‹ Prev', disabled: s.page <= 1 ? 'disabled' : null,
      onClick: () => { if (s.page > 1) { s.page--; renderSendersTable(); } },
    }),
    el('span', { class: 'muted', text: `Page ${s.page} / ${pages} · ${s.total} total` }),
    el('button', {
      class: 'btn btn-sm', text: 'Next ›', disabled: s.page >= pages ? 'disabled' : null,
      onClick: () => { if (s.page < pages) { s.page++; renderSendersTable(); } },
    }),
  ]));
}

/* ============================================================
   EVENTS
   ============================================================ */
const RED_ACTIONS = new Set(['OVER_QUOTA', 'SUSPEND', 'REJECT']);

async function loadEvents() {
  const e = state.events;
  const emailI = el('input', { class: 'search-input', type: 'search', placeholder: 'Filter by email…', value: e.email });
  emailI.addEventListener('input', debounce(() => { e.email = emailI.value.trim(); renderEventsTable(); }, 300));
  const actionI = el('input', { type: 'search', placeholder: 'Action…', value: e.action, style: 'width:140px' });
  actionI.addEventListener('input', debounce(() => { e.action = actionI.value.trim(); renderEventsTable(); }, 300));

  const head = el('div', { class: 'view-head' }, [
    el('h2', { text: 'Events' }),
    el('div', { class: 'toolbar' }, [emailI, actionI,
      el('button', { class: 'btn btn-sm', text: 'Refresh', onClick: renderEventsTable })]),
  ]);
  setView(head, el('div', { id: 'events-table' }));
  await renderEventsTable();
}

async function renderEventsTable() {
  const wrap = $('#events-table');
  if (!wrap) return;
  const e = state.events;
  const qs = new URLSearchParams({ email: e.email, action: e.action, limit: '100' });
  const rows = await safe(api('/events?' + qs.toString()));
  if (!Array.isArray(rows)) return;
  wrap.innerHTML = '';
  const table = el('table');
  table.append(thead(['Time', 'Email', 'Action', 'Window', 'Cnt / Limit', 'Client IP', 'Queue ID']));
  const tb = el('tbody');
  if (!rows.length) {
    tb.append(el('tr', {}, el('td', { colspan: 7, class: 'empty', text: 'No events' })));
  }
  for (const ev of rows) {
    const tr = el('tr');
    if (RED_ACTIONS.has((ev.action || '').toUpperCase())) tr.classList.add('row-danger');
    const isAnomaly = (ev.window || '') === 'anomaly';
    // The Cnt/Limit column overloads two meanings; spell it out on hover.
    const cntTitle = isAnomaly
      ? 'Anomaly flags accumulated / threshold to suspend (ANOMALY_FLAGS_TO_SUSPEND)'
      : 'Messages sent in this window / the configured limit';
    tr.append(
      el('td', { text: fmtDate(ev.ts) }),
      el('td', { text: ev.email || '' }),
      el('td', { text: ev.action || '' }),
      el('td', { text: ev.window || '' }),
      el('td', { title: cntTitle, text: `${ev.currentCnt ?? ''} / ${ev.limitCnt ?? ''}` }),
      el('td', { class: 'muted', text: ev.clientIp || '' }),
      el('td', { class: 'muted', text: ev.queueId || '' }),
    );
    tb.append(tr);
  }
  table.append(tb);
  wrap.append(el('div', { class: 'table-wrap' }, table), eventsLegend());
}

/* Explains the overloaded ACTION / Cnt-Limit columns right under the table. */
function eventsLegend() {
  const item = (k, v) => el('div', { class: 'legend-item' }, [
    el('span', { class: 'legend-key', text: k }), el('span', { text: v }),
  ]);
  return el('div', { class: 'legend' }, [
    el('div', { class: 'legend-title', text: 'How to read this log' }),
    item('OVER_QUOTA', 'over the rate limit — deferred (4xx, retried). Cnt/Limit = messages sent / limit, for window m1/h1/d1/mo.'),
    item('OBSERVE', 'observe mode: would have been suspended but mail was allowed. window=anomaly, Cnt/Limit = flags / suspend-threshold.'),
    item('ANOMALY', 'behavioural flag raised (below the suspend threshold). window=anomaly.'),
    item('SUSPEND', 'sender blocked — rejected (5xx). window=anomaly shows flags / threshold; window=-- means a manual/blocklist suspend.'),
    item('UPDATE', 'an accepted (allowed) message, sampled. Cnt/Limit = recipients / hourly limit.'),
    el('div', { class: 'muted', text: 'window "anomaly" = behavioural detector (per-minute flags), not a sending quota. m1/h1/d1/mo = real per minute/hour/day/month quotas.' }),
  ]);
}

/* ============================================================
   Shared form widgets
   ============================================================ */
function field(label, control) {
  return el('label', { class: 'field' }, [el('span', { text: label }), control]);
}
function labeledInput(name, label, type) {
  return field(label, el('input', { name, type, step: type === 'number' ? '1' : null, min: type === 'number' ? '0' : null }));
}
function checkboxField(name, label, checked) {
  const input = el('input', { type: 'checkbox', name });
  input.checked = !!checked;
  return el('label', { class: 'checkbox-field' }, [input, el('span', { text: label })]);
}
function badge(cls, text) {
  return el('span', { class: 'badge ' + cls, text });
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ---------- Tab registry ---------- */
const TABS = {
  dashboard: loadDashboard,
  tiers: loadTiers,
  domains: loadDomains,
  senders: loadSenders,
  events: loadEvents,
};

/* ---------- Boot ---------- */
(function init() {
  if (token.get()) showApp();
  else showLogin();
})();
