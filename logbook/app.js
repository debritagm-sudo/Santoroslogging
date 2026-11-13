import { db, store, onChange, newId, normUsername, isPin, setErrorHandler, DEFAULT_SETTINGS } from './store.js';
import { APP_NAME } from './config.js';

// ===========================================================================
// Helpers
// ===========================================================================
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => dateStr(new Date());
const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return dateStr(d); };
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = (m) => { m = ((m % 1440) + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
const roundTime = (t) => fromMin(Math.round(toMin(t) / 15) * 15);      // nearest 15 minutes
const roundHours = (h) => Math.round(h * 4) / 4;                         // nearest 0.25 h
const roundNow = () => { const q = 15 * 60000; return new Date(Math.round(Date.now() / q) * q); };
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const spanHours = (start, end) => { let diff = toMin(end) - toMin(start); if (diff < 0) diff += 1440; return diff / 60; };
const startDT = (e) => { const d = parseDate(e.date); d.setMinutes(toMin(e.start)); return d; };
const sum = (arr, fn) => arr.reduce((a, x) => a + (fn(x) || 0), 0);
const fmtHrs = (h) => (Math.round((h || 0) * 100) / 100).toFixed(2).replace(/\.?0+$/, '') || '0';
const fmtTime = (t) => {
  if (!t) return '—';
  let [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${pad(m)} ${ap}`;
};
const fmtDate = (s) => parseDate(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fmtShort = (s) => parseDate(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtLongDate = (s) => parseDate(s).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const fmtDuration = (ms) => { const m = Math.max(0, Math.floor(ms / 60000)); return `${Math.floor(m / 60)}:${pad(m % 60)}`; };
const weekStartOf = (s, ws = db.settings.weekStart) => { const d = parseDate(s); d.setDate(d.getDate() - ((d.getDay() - ws + 7) % 7)); return dateStr(d); };
const initials = (name) => String(name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const firstName = (name) => String(name || '').trim().split(/\s+/)[0];
const byName = (a, b) => a.name.localeCompare(b.name);
const byStart = (a, b) => (a.start || '99:99').localeCompare(b.start || '99:99') || (a.createdAt || 0) - (b.createdAt || 0);
const lsGet = (k) => { try { return localStorage.getItem('logbook-ui-' + k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem('logbook-ui-' + k, v); } catch { /* ignore */ } };
const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const EDIT_WINDOW_DAYS = 14;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const isManager = () => db.me?.role === 'manager';
const userById = (id) => db.users.find((u) => u.id === id) || (id === db.me?.id ? db.me : null);
const userName = (id) => userById(id)?.name || 'Unknown';
const projectById = (id) => db.projects.find((p) => p.id === id);
const projectName = (id) => projectById(id)?.name || 'Removed project';
const activeProjects = () => db.projects.filter((p) => p.active !== false).sort(byName);
const timeRange = (e) => (e.start ? `${fmtTime(e.start)} – ${e.active ? 'now' : fmtTime(e.end)}` : 'Hours entered');

function canEdit(e) {
  if (isManager()) return true;
  return e.userId === db.me.id && !e.lockedByManager && e.date >= addDays(today(), -(EDIT_WINDOW_DAYS - 1));
}

// Overtime: daily threshold first (if set), then weekly threshold on the
// remaining straight-time hours. Entries are processed in time order, so the
// overtime lands on whichever project's hours pushed the person over.
function computeOT(entries, settings) {
  const ot = new Map();
  const byUser = {};
  entries.filter((e) => !e.active).forEach((e) => (byUser[e.userId] ||= []).push(e));
  for (const list of Object.values(byUser)) {
    list.sort((a, b) => a.date.localeCompare(b.date) || byStart(a, b));
    const dayTot = {}, weekReg = {};
    for (const e of list) {
      const h = e.hours || 0;
      let dailyOT = 0;
      if (settings.dailyOT > 0) {
        const before = dayTot[e.date] || 0;
        dailyOT = Math.max(0, h - Math.max(0, settings.dailyOT - before));
      }
      dayTot[e.date] = (dayTot[e.date] || 0) + h;
      const straight = h - dailyOT;
      let weeklyOT = 0;
      if (settings.weeklyOT > 0) {
        const wk = weekStartOf(e.date, settings.weekStart);
        const before = weekReg[wk] || 0;
        weeklyOT = Math.max(0, straight - Math.max(0, settings.weeklyOT - before));
        weekReg[wk] = before + straight - weeklyOT;
      }
      ot.set(e.id, dailyOT + weeklyOT);
    }
  }
  return ot;
}
let OT = new Map();

// ===========================================================================
// Icons
// ===========================================================================
const svg = (p) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
const ICON = {
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  list: svg('<path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01"/>'),
  chart: svg('<path d="M3 21h18M6 17v-6M11 17V5M16 17v-9M21 17v-3"/>'),
  table: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  people: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.5a5 5 0 0 1 6 5"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  left: svg('<path d="M15 6l-6 6 6 6"/>'),
  right: svg('<path d="M9 6l6 6-6 6"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  download: svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  upload: svg('<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>'),
  out: svg('<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H4"/>'),
  phone: svg('<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
};

// ===========================================================================
// UI state + rendering
// ===========================================================================
const ui = { needsSetup: false, authError: '', authBusy: false, weekOffset: 0, ts: null, installEvt: null };

const ROUTES = {
  employee: [['clock', 'Clock', ICON.clock], ['hours', 'My Hours', ICON.list]],
  manager: [['dashboard', 'Dashboard', ICON.chart], ['timesheet', 'Timesheet', ICON.table], ['projects', 'Projects', ICON.folder], ['crew', 'Crew', ICON.people], ['clock', 'My Time', ICON.clock]],
};

function currentRoute() {
  const r = location.hash.replace(/^#\/?/, '');
  const tabs = isManager() ? ROUTES.manager : ROUTES.employee;
  const allowed = tabs.map((t) => t[0]).concat(isManager() ? ['settings', 'hours'] : []);
  return allowed.includes(r) ? r : tabs[0][0];
}

function render() {
  const app = $('#app');
  const keep = captureForm(app);
  if (!db.me) {
    app.innerHTML = ui.needsSetup ? setupHTML() : loginHTML();
  } else {
    OT = computeOT(db.entries, db.settings);
    const route = currentRoute();
    app.innerHTML = shellHTML(route);
  }
  restoreForm(app, keep);
  tick();
}

// Keep typed values / focus when a background sync re-renders the screen.
function captureForm(root) {
  const a = document.activeElement;
  const vals = {};
  root.querySelectorAll('[data-persist]').forEach((el) => { vals[el.id] = el.value; });
  return { vals, focus: a && root.contains(a) && a.id ? a.id : null, sel: a && 'selectionStart' in a ? [a.selectionStart, a.selectionEnd] : null };
}
function restoreForm(root, keep) {
  for (const [id, v] of Object.entries(keep.vals)) { const el = root.querySelector('#' + id); if (el) el.value = v; }
  if (keep.focus) {
    const el = root.querySelector('#' + keep.focus);
    if (el) { el.focus(); try { if (keep.sel) el.setSelectionRange(...keep.sel); } catch { /* not a text input */ } }
  }
}

function shellHTML(route) {
  const tabs = isManager() ? ROUTES.manager : ROUTES.employee;
  const navRoute = route === 'settings' ? '' : route === 'hours' && isManager() ? 'clock' : route;
  return `
  <header class="topbar">
    <a class="brand" href="#/"><img src="assets/logo-s.png" alt="Santoro's Logging"><span><b>${APP_NAME}</b><small>Santoro's Logging</small></span></a>
    <div class="top-actions">${syncChip()}<button class="avatar" data-act="account" aria-label="Account menu">${esc(initials(db.me.name))}</button></div>
  </header>
  ${db.mode === 'cloud' && !navigator.onLine ? '<div class="banner">No signal. Your hours are saved on this phone and will sync on their own once you have signal again.</div>' : ''}
  <main class="view ${route === 'timesheet' ? 'wide' : ''}">${VIEWS[route]()}</main>
  <nav class="tabbar">${tabs.map(([r, label, icon]) => `<a href="#/${r}" class="${r === navRoute ? 'on' : ''}">${icon}<span>${label}</span></a>`).join('')}</nav>`;
}

function syncChip() {
  if (db.mode !== 'cloud') return '';
  if (!navigator.onLine) return '<span class="chip off">Offline</span>';
  if (db.pendingSync) return '<span class="chip wait">Syncing…</span>';
  return '<span class="chip ok">Synced</span>';
}

// ---------------------------------------------------------------------------
// Auth screens
// ---------------------------------------------------------------------------
function loginHTML() {
  return `
  <div class="auth"><div class="auth-card">
    <img class="auth-logo" src="assets/logo-truck.png" alt="Santoro's Logging">
    <div class="auth-title"><h1>${APP_NAME}</h1><p>Crew time tracking</p></div>
    <form id="login-form" class="form-grid">
      <label class="field"><span>Username</span><input id="login-user" data-persist name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
      <label class="field"><span>4-digit PIN</span>${pinInput('login-pass', 'pin', 'current-password')}</label>
      <div class="form-error">${esc(ui.authError)}</div>
      <button class="btn btn-go btn-xl" ${ui.authBusy ? 'disabled' : ''}>${ui.authBusy ? 'Signing in…' : 'Sign in'}</button>
    </form>
    <p class="auth-foot">Forgot your PIN? Ask your manager to reset it.</p>
  </div></div>`;
}

// Numeric keypad on phones, digits only, max 4.
function pinInput(id, name, autocomplete, { visible = false, value = '' } = {}) {
  return `<input ${id ? `id="${id}" data-persist` : ''} name="${name}" type="${visible ? 'text' : 'password'}" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="${autocomplete}" data-pin class="pin" value="${esc(value)}" placeholder="••••">`;
}
document.addEventListener('input', (e) => {
  if (e.target.matches?.('[data-pin]')) e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
});

function setupHTML() {
  return `
  <div class="auth"><div class="auth-card">
    <img class="auth-logo" src="assets/logo-stump.png" alt="Santoro's Logging">
    <div class="auth-title"><h1>Welcome to ${APP_NAME}</h1><p>Create the first manager account to get started.</p></div>
    <form id="setup-form" class="form-grid">
      <label class="field"><span>Your name</span><input id="su-name" data-persist name="name" autocomplete="name" required></label>
      <label class="field"><span>Username</span><input id="su-user" data-persist name="username" autocapitalize="none" spellcheck="false" placeholder="e.g. tony" required></label>
      <div class="row2">
        <label class="field"><span>Choose a 4-digit PIN</span>${pinInput('su-pass', 'pin', 'new-password')}</label>
        <label class="field"><span>Type it again</span>${pinInput('su-pass2', 'pin2', 'new-password')}</label>
      </div>
      <div class="form-error">${esc(ui.authError)}</div>
      <button class="btn btn-go btn-xl" ${ui.authBusy ? 'disabled' : ''}>${ui.authBusy ? 'Setting up…' : 'Create account'}</button>
    </form>
    ${db.mode === 'device' ? '<p class="auth-foot">Device-only mode: data stays on this device. See README to turn on syncing across phones.</p>' : ''}
  </div></div>`;
}

document.addEventListener('submit', async (ev) => {
  const form = ev.target;
  if (form.id !== 'login-form' && form.id !== 'setup-form') return;
  ev.preventDefault();
  const f = Object.fromEntries(new FormData(form));
  ui.authError = '';
  if (form.id === 'setup-form') {
    if (!normUsername(f.username)) { ui.authError = 'Usernames can use letters, numbers, dots and dashes.'; return render(); }
    if (!isPin(f.pin)) { ui.authError = 'Your PIN must be exactly 4 digits.'; return render(); }
    if (f.pin !== f.pin2) { ui.authError = 'The two PINs do not match.'; return render(); }
  } else if (!isPin(f.pin)) { ui.authError = 'Enter your 4-digit PIN.'; return render(); }
  ui.authBusy = true; render();
  try {
    if (form.id === 'setup-form') { await store.setup(f); ui.needsSetup = false; }
    else await store.login(f.username, f.pin);
    if (!db.me) throw new Error('Could not sign in. Try again.');
    location.hash = '#/';
  } catch (err) {
    ui.authError = friendly(err);
    const pinBox = $('#login-pass');
    if (pinBox) pinBox.value = '';
  }
  ui.authBusy = false;
  if (db.me) document.querySelectorAll('#login-pass, #su-pass, #su-pass2').forEach((el) => { el.value = ''; });
  render();
});

function friendly(err) {
  const map = {
    'auth/invalid-credential': 'Wrong username or PIN.',
    'auth/wrong-password': 'Wrong username or PIN.',
    'auth/user-not-found': 'Wrong username or PIN.',
    'auth/invalid-email': 'That username has characters that are not allowed.',
    'auth/network-request-failed': 'No signal. You need internet the first time you sign in on a phone.',
    'auth/email-already-in-use': 'That username is already taken.',
    'auth/weak-password': 'PIN must be exactly 4 digits.',
    'auth/too-many-requests': 'Too many wrong PINs. This login is paused for a few minutes.',
    'permission-denied': 'You do not have permission to do that.',
    'functions/permission-denied': 'Only managers can reset PINs.',
  };
  return map[err?.code] || err?.message || String(err);
}

// ===========================================================================
// Views
// ===========================================================================
const VIEWS = { clock: viewClock, hours: viewHours, dashboard: viewDashboard, timesheet: viewTimesheet, projects: viewProjects, crew: viewCrew, settings: viewSettings };

const projectOptions = (selectedId, extraId) => {
  const list = activeProjects();
  if (extraId && !list.some((p) => p.id === extraId) && projectById(extraId)) list.push(projectById(extraId));
  return list.map((p) => `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${esc(p.name)}${p.code ? ' · #' + esc(p.code) : ''}${p.active === false ? ' (archived)' : ''}</option>`).join('');
};

function entryRow(e, { showUser = false } = {}) {
  const ot = OT.get(e.id) || 0;
  const lock = !canEdit(e) ? ' ' + ICON.lock : '';
  const sub = [showUser ? userName(e.userId) : null, timeRange(e), e.notes].filter(Boolean).map(esc).join(' · ');
  return `<li><button class="entry" data-act="edit-entry" data-id="${e.id}">
    <span class="what"><b>${esc(projectName(e.projectId))}${e.lockedByManager ? '<span class="tag edit">Edited</span>' : ''}${e.active ? '<span class="tag live">On clock</span>' : ''}</b><span>${sub}</span></span>
    <span class="hrs">${e.active ? '<span data-elapsed="' + e.id + '"></span>' : fmtHrs(e.hours) + ' h'}${ot ? `<small>${fmtHrs(ot)} OT</small>` : ''}</span>${lock}
  </button></li>`;
}

// ---------- Clock (home for employees, "My Time" for managers) ----------
function viewClock() {
  const me = db.me, t = today();
  const mine = db.entries.filter((e) => e.userId === me.id);
  const active = mine.find((e) => e.active);
  const projects = activeProjects();
  let top;
  if (active) {
    top = `<section class="card clock-card on">
      <div class="status-pill live">On the clock</div>
      <h2 class="clock-project">${esc(projectName(active.projectId))}</h2>
      <p class="muted">Started ${fmtTime(active.start)}${active.date !== t ? ' on ' + fmtDate(active.date) : ''}</p>
      <div class="elapsed" data-elapsed="${active.id}">0:00</div>
      <p class="muted small" data-outpreview="${active.id}"></p>
      <button class="btn btn-stop btn-xl" data-act="clock-out" data-id="${active.id}">Clock Out</button>
      ${projects.length > 1 ? `<label class="field" style="text-align:left"><span>Moving to another job? Switch project</span>
        <select data-change="switch" data-id="${active.id}"><option value="">Choose project…</option>${projects.filter((p) => p.id !== active.projectId).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>` : ''}
    </section>`;
  } else {
    const last = lsGet('lastProject');
    top = `<section class="card clock-card">
      <img class="hero-logo" src="assets/logo-treeline.png" alt="Santoro's Logging">
      ${projects.length ? `
        <label class="field"><span>Project</span><select id="clock-project">${projectOptions(projects.some((p) => p.id === last) ? last : projects[0].id)}</select></label>
        <button class="btn btn-go btn-xl" data-act="clock-in">Clock In</button>
        <p class="muted small center" style="margin:0">Records as <b id="round-preview"></b>. Times round to the nearest 15 minutes.</p>`
      : `<p class="empty-note">No projects yet. ${isManager() ? 'Add one on the Projects tab.' : 'Ask your manager to add a project.'}</p>`}
    </section>`;
  }
  const todays = mine.filter((e) => e.date === t && !e.active).sort(byStart);
  const ws = weekStartOf(t), we = addDays(ws, 6);
  const week = mine.filter((e) => !e.active && e.date >= ws && e.date <= we);
  const weekOT = sum(week, (e) => OT.get(e.id));
  return `
    <div class="greet"><h1>${greeting()}, ${esc(firstName(me.name))}</h1><p class="muted">${fmtLongDate(t)}</p></div>
    ${top}
    <button class="btn btn-outline btn-block" data-act="add-entry">${ICON.plus} Add hours manually</button>
    <section class="card">
      <div class="card-head"><h3>Today</h3><span class="total">${fmtHrs(sum(todays, (e) => e.hours))} hrs</span></div>
      ${todays.length ? `<ul class="entry-list">${todays.map((e) => entryRow(e)).join('')}</ul>` : '<p class="muted small" style="margin:0">Nothing logged yet today.</p>'}
    </section>
    <section class="stats-row">
      <a class="stat" href="#/hours" style="text-decoration:none;color:inherit"><span>This week</span><b>${fmtHrs(sum(week, (e) => e.hours))}</b><small>hrs · see all ›</small></a>
      <div class="stat ${weekOT > 0 ? 'warn' : ''}"><span>Overtime</span><b>${fmtHrs(weekOT)}</b><small>hrs this week</small></div>
    </section>`;
}

// ---------- My Hours (week view) ----------
function viewHours() {
  const ws = addDays(weekStartOf(today()), ui.weekOffset * 7), we = addDays(ws, 6);
  const mine = db.entries.filter((e) => e.userId === db.me.id && e.date >= ws && e.date <= we);
  const done = mine.filter((e) => !e.active);
  const days = [...Array(7)].map((_, i) => addDays(ws, i));
  const weekOT = sum(done, (e) => OT.get(e.id));
  return `
    <div class="page-head"><div><h1>My Hours</h1><p class="muted">Tap an entry to fix it.</p></div>
      <button class="btn btn-go btn-sm" data-act="add-entry">${ICON.plus} Add hours</button></div>
    <div class="card week-nav">
      <button class="btn btn-outline icon-btn" data-act="week" data-dir="-1" aria-label="Previous week">${ICON.left}</button>
      <b>${fmtShort(ws)} – ${fmtShort(we)}${ui.weekOffset === 0 ? '<br><small class="muted">This week</small>' : ''}</b>
      <button class="btn btn-outline icon-btn" data-act="week" data-dir="1" aria-label="Next week" ${ui.weekOffset >= 0 ? 'disabled' : ''}>${ICON.right}</button>
    </div>
    <section class="stats-row">
      <div class="stat"><span>Total</span><b>${fmtHrs(sum(done, (e) => e.hours))}</b><small>hrs</small></div>
      <div class="stat"><span>Regular</span><b>${fmtHrs(sum(done, (e) => e.hours) - weekOT)}</b><small>hrs</small></div>
      <div class="stat ${weekOT > 0 ? 'warn' : ''}"><span>Overtime</span><b>${fmtHrs(weekOT)}</b><small>hrs</small></div>
    </section>
    <section class="card">
      ${mine.length ? days.map((d) => {
        const list = mine.filter((e) => e.date === d).sort(byStart);
        return `<div class="day-block"><div class="day-head ${list.length ? '' : 'empty'}"><span>${fmtDate(d)}</span><span>${list.length ? fmtHrs(sum(list, (e) => e.hours)) + ' h' : '—'}</span></div>
          ${list.length ? `<ul class="entry-list">${list.map((e) => entryRow(e)).join('')}</ul>` : ''}</div>`;
      }).join('') : `<div class="empty"><img src="assets/logo-peak.png" alt="">No hours logged this week.</div>`}
    </section>`;
}

// ---------- Manager dashboard ----------
function viewDashboard() {
  const end = today(), start = addDays(end, -6);
  const recent = db.entries.filter((e) => !e.active && e.date >= start && e.date <= end);
  const live = db.entries.filter((e) => e.active);
  const per = {};
  for (const e of recent) {
    const p = (per[e.projectId] ||= { id: e.projectId, hours: 0, ot: 0, people: new Set() });
    p.hours += e.hours || 0;
    p.ot += OT.get(e.id) || 0;
    p.people.add(e.userId);
  }
  const rows = Object.values(per).sort((a, b) => b.hours - a.hours);
  const otRows = rows.filter((r) => r.ot > 0).sort((a, b) => b.ot - a.ot);
  const total = sum(recent, (e) => e.hours), totalOT = sum(recent, (e) => OT.get(e.id));
  const maxH = Math.max(1, ...rows.map((r) => r.hours));
  const maxOT = Math.max(1, ...otRows.map((r) => r.ot));
  return `
    <div class="page-head"><div><h1>Dashboard</h1><p class="muted">Last 7 days · ${fmtShort(start)} – ${fmtShort(end)}</p></div></div>
    <section class="stats-row four">
      <div class="stat"><span>Hours</span><b>${fmtHrs(total)}</b><small>all projects</small></div>
      <div class="stat ${totalOT > 0 ? 'warn' : ''}"><span>Overtime</span><b>${fmtHrs(totalOT)}</b><small>hrs</small></div>
      <div class="stat"><span>On the clock</span><b>${live.length}</b><small>right now</small></div>
      <div class="stat"><span>Projects</span><b>${rows.length}</b><small>with hours</small></div>
    </section>
    <div class="dash-grid">
      <section class="card">
        <div class="card-head"><h3>Hours by project</h3></div>
        ${rows.length ? `<div class="bars">${rows.map((r) => `
          <div class="bar-row"><div class="bar-label"><b>${esc(projectName(r.id))}</b><span>${fmtHrs(r.hours)} h</span></div>
          <div class="bar-track" title="${fmtHrs(r.hours - r.ot)} regular + ${fmtHrs(r.ot)} overtime">
            <div class="bar-fill" style="width:${((r.hours - r.ot) / maxH) * 100}%"></div><div class="bar-fill ot" style="width:${(r.ot / maxH) * 100}%"></div>
          </div><span class="muted small">${r.people.size} ${r.people.size === 1 ? 'person' : 'people'}</span></div>`).join('')}</div>
          <div class="legend"><span><i style="background:var(--green-600)"></i>Regular</span><span><i style="background:var(--gold)"></i>Overtime</span></div>`
        : `<div class="empty"><img src="assets/logo-saw.png" alt="">No hours in the last 7 days.</div>`}
      </section>
      <section class="card">
        <div class="card-head"><h3>Overtime by project</h3></div>
        ${otRows.length ? `<div class="bars">${otRows.map((r) => `
          <div class="bar-row"><div class="bar-label"><b>${esc(projectName(r.id))}</b><span>${fmtHrs(r.ot)} h OT</span></div>
          <div class="bar-track"><div class="bar-fill ot" style="width:${(r.ot / maxOT) * 100}%"></div></div>
          <span class="muted small">${Math.round((r.ot / r.hours) * 100)}% of this project's hours</span></div>`).join('')}</div>`
        : `<p class="muted" style="margin:0">No overtime in the last 7 days.</p>`}
        <p class="muted small" style="margin:14px 0 0">Overtime = over ${db.settings.weeklyOT || '—'} hrs/week${db.settings.dailyOT > 0 ? ` or ${db.settings.dailyOT} hrs/day` : ''} per person. <a href="#/settings">Change</a></p>
      </section>
    </div>
    <section class="card">
      <div class="card-head"><h3>On the clock now</h3><span class="total">${live.length}</span></div>
      ${live.length ? `<ul class="live-list">${live.map((e) => `<li><div><b>${esc(userName(e.userId))}</b><span>${esc(projectName(e.projectId))} · since ${fmtTime(e.start)}</span></div><span class="t" data-elapsed="${e.id}"></span></li>`).join('')}</ul>`
      : '<p class="muted small" style="margin:0">Nobody is clocked in.</p>'}
    </section>`;
}

// ---------- Timesheet (spreadsheet) ----------
function presetRange(p) {
  const t = today(), ws = weekStartOf(t);
  if (p === 'last-week') return [addDays(ws, -7), addDays(ws, -1)];
  if (p === 'last-7') return [addDays(t, -6), t];
  if (p === 'last-14') return [addDays(t, -13), t];
  if (p === 'this-month') { const d = parseDate(t); return [dateStr(new Date(d.getFullYear(), d.getMonth(), 1)), dateStr(new Date(d.getFullYear(), d.getMonth() + 1, 0))]; }
  if (p === 'last-month') { const d = parseDate(t); return [dateStr(new Date(d.getFullYear(), d.getMonth() - 1, 1)), dateStr(new Date(d.getFullYear(), d.getMonth(), 0))]; }
  return [ws, addDays(ws, 6)];
}
function tsState() {
  if (!ui.ts) { const [from, to] = presetRange('this-week'); ui.ts = { preset: 'this-week', from, to, user: '', project: '', view: 'entries' }; }
  return ui.ts;
}
function tsEntries() {
  const ts = tsState();
  return db.entries
    .filter((e) => e.date >= ts.from && e.date <= ts.to && (!ts.user || e.userId === ts.user) && (!ts.project || e.projectId === ts.project))
    .sort((a, b) => b.date.localeCompare(a.date) || userName(a.userId).localeCompare(userName(b.userId)) || byStart(a, b));
}

function viewTimesheet() {
  const ts = tsState();
  const people = [...db.users].sort(byName);
  const allProjects = [...db.projects].sort(byName);
  const presets = [['this-week', 'This week'], ['last-week', 'Last week'], ['last-7', 'Last 7 days'], ['last-14', 'Last 14 days'], ['this-month', 'This month'], ['last-month', 'Last month'], ['custom', 'Custom dates']];
  const filters = `
    <section class="card filters">
      <div class="seg"><button class="${ts.view === 'entries' ? 'on' : ''}" data-act="ts-view" data-v="entries">All entries</button><button class="${ts.view === 'grid' ? 'on' : ''}" data-act="ts-view" data-v="grid">Weekly grid</button></div>
      ${ts.view === 'entries' ? `
      <label class="field"><span>Dates</span><select id="ts-preset" data-change="ts-preset">${presets.map(([v, l]) => `<option value="${v}" ${ts.preset === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="row2">
        <label class="field"><span>From</span><input id="ts-from" type="date" value="${ts.from}" data-change="ts-from"></label>
        <label class="field"><span>To</span><input id="ts-to" type="date" value="${ts.to}" data-change="ts-to"></label>
      </div>` : `
      <div class="week-nav">
        <button class="btn btn-outline icon-btn" data-act="ts-week" data-dir="-1" aria-label="Previous week">${ICON.left}</button>
        <b>Week of ${fmtShort(weekStartOf(ts.from))} – ${fmtShort(addDays(weekStartOf(ts.from), 6))}</b>
        <button class="btn btn-outline icon-btn" data-act="ts-week" data-dir="1" aria-label="Next week">${ICON.right}</button>
      </div>`}
      <div class="row2">
        <label class="field"><span>Employee</span><select id="ts-user" data-change="ts-user"><option value="">Everyone</option>${people.map((u) => `<option value="${u.id}" ${ts.user === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Project</span><select id="ts-project" data-change="ts-project"><option value="">All projects</option>${allProjects.map((p) => `<option value="${p.id}" ${ts.project === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      </div>
    </section>`;
  return `
    <div class="page-head"><div><h1>Timesheet</h1><p class="muted">Tap any row to change it.</p></div></div>
    ${filters}
    <div class="sheet-actions-row">
      <button class="btn btn-go" data-act="add-entry" data-for-manager="1">${ICON.plus} Add entry</button>
      <button class="btn btn-outline" data-act="export-csv">${ICON.download} Export to Excel (CSV)</button>
    </div>
    ${ts.view === 'grid' ? gridHTML() : entriesTableHTML()}`;
}

function entriesTableHTML() {
  const rows = tsEntries();
  if (!rows.length) return `<section class="card empty"><img src="assets/logo-peak.png" alt="">No hours match these filters.</section>`;
  const done = rows.filter((e) => !e.active);
  const totH = sum(done, (e) => e.hours), totOT = sum(done, (e) => OT.get(e.id));
  return `<div class="sheet-wrap"><table class="sheet">
    <thead><tr><th>Date</th><th>Employee</th><th>Project</th><th>In</th><th>Out</th><th class="num">Hours</th><th class="num">Reg</th><th class="num">OT</th><th>Notes</th></tr></thead>
    <tbody>${rows.map((e) => {
      const ot = OT.get(e.id) || 0;
      return `<tr data-act="edit-entry" data-id="${e.id}">
        <td>${fmtDate(e.date)}</td>
        <td>${esc(userName(e.userId))}</td>
        <td>${esc(projectName(e.projectId))}</td>
        <td>${e.start ? fmtTime(e.start) : '<span class="zero">—</span>'}</td>
        <td>${e.active ? '<span class="tag live">On clock</span>' : e.end ? fmtTime(e.end) : '<span class="zero">—</span>'}</td>
        <td class="num"><b>${e.active ? '…' : fmtHrs(e.hours)}</b></td>
        <td class="num">${e.active ? '' : fmtHrs((e.hours || 0) - ot)}</td>
        <td class="num ${ot ? 'ot' : 'zero'}">${ot ? fmtHrs(ot) : '0'}</td>
        <td class="notes">${e.lockedByManager ? `<span class="tag edit" title="Changed by ${esc(e.editedBy)}">Edited</span> ` : ''}${esc(e.notes)}</td>
      </tr>`;
    }).join('')}</tbody>
    <tfoot><tr><td>Total</td><td>${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}</td><td></td><td></td><td></td><td class="num">${fmtHrs(totH)}</td><td class="num">${fmtHrs(totH - totOT)}</td><td class="num">${fmtHrs(totOT)}</td><td></td></tr></tfoot>
  </table></div>`;
}

function gridHTML() {
  const ts = tsState();
  const ws = weekStartOf(ts.from);
  const days = [...Array(7)].map((_, i) => addDays(ws, i));
  const list = db.entries.filter((e) => !e.active && e.date >= ws && e.date <= days[6] && (!ts.project || e.projectId === ts.project) && (!ts.user || e.userId === ts.user));
  const ids = new Set(list.map((e) => e.userId));
  const people = db.users.filter((u) => (ids.has(u.id) || (u.active && !ts.user)) && (!ts.user || u.id === ts.user)).sort(byName);
  if (!people.length) return `<section class="card empty"><img src="assets/logo-peak.png" alt="">No one to show.</section>`;
  const cell = (uid, d) => sum(list.filter((e) => e.userId === uid && e.date === d), (e) => e.hours);
  return `<div class="sheet-wrap"><table class="sheet">
    <thead><tr><th>Employee</th>${days.map((d) => `<th class="num">${parseDate(d).toLocaleDateString(undefined, { weekday: 'short' })}<br>${fmtShort(d)}</th>`).join('')}<th class="num">Total</th><th class="num">OT</th></tr></thead>
    <tbody>${people.map((u) => {
      const mine = list.filter((e) => e.userId === u.id);
      const ot = sum(mine, (e) => OT.get(e.id));
      return `<tr data-act="grid-person" data-id="${u.id}"><td><b>${esc(u.name)}</b></td>${days.map((d) => { const h = cell(u.id, d); return `<td class="num ${h ? '' : 'zero'}">${h ? fmtHrs(h) : '–'}</td>`; }).join('')}
        <td class="num"><b>${fmtHrs(sum(mine, (e) => e.hours))}</b></td><td class="num ${ot ? 'ot' : 'zero'}">${fmtHrs(ot)}</td></tr>`;
    }).join('')}</tbody>
    <tfoot><tr><td>Total</td>${days.map((d) => `<td class="num">${fmtHrs(sum(list.filter((e) => e.date === d), (e) => e.hours))}</td>`).join('')}<td class="num">${fmtHrs(sum(list, (e) => e.hours))}</td><td class="num">${fmtHrs(sum(list, (e) => OT.get(e.id)))}</td></tr></tfoot>
  </table></div><p class="muted small" style="margin:0">Tap a person to see their entries for this week.</p>`;
}

// ---------- Projects ----------
function viewProjects() {
  const since = addDays(today(), -6);
  const stats = (p) => {
    const list = db.entries.filter((e) => e.projectId === p.id && !e.active);
    return { total: sum(list, (e) => e.hours), week: sum(list.filter((e) => e.date >= since), (e) => e.hours) };
  };
  const item = (p) => {
    const s = stats(p);
    return `<button class="list-item" data-act="edit-project" data-id="${p.id}">
      <span class="what"><b>${esc(p.name)}${p.active === false ? '<span class="tag off">Archived</span>' : ''}</b><span>${[p.code ? 'Job #' + p.code : '', p.location].filter(Boolean).map(esc).join(' · ') || 'No details'}</span></span>
      <span class="side">${fmtHrs(s.week)} h<small>last 7 days · ${fmtHrs(s.total)} total</small></span></button>`;
  };
  const active = db.projects.filter((p) => p.active !== false).sort(byName);
  const archived = db.projects.filter((p) => p.active === false).sort(byName);
  return `
    <div class="page-head"><div><h1>Projects</h1><p class="muted">Jobs your crew can log hours to.</p></div>
      <button class="btn btn-go btn-sm" data-act="edit-project">${ICON.plus} New project</button></div>
    <section class="card list-card">${active.length ? active.map(item).join('') : `<div class="empty"><img src="assets/logo-saw.png" alt="">No projects yet. Add your first job.</div>`}</section>
    ${archived.length ? `<details class="card list-card"><summary>Archived (${archived.length})</summary>${archived.map(item).join('')}</details>` : ''}`;
}

// ---------- Crew ----------
function viewCrew() {
  const ws = weekStartOf(today());
  const people = [...db.users].sort((a, b) => (b.active !== false) - (a.active !== false) || byName(a, b));
  return `
    <div class="page-head"><div><h1>Crew</h1><p class="muted">Logins for employees and managers.</p></div>
      <button class="btn btn-go btn-sm" data-act="edit-person">${ICON.plus} Add person</button></div>
    <section class="card list-card">${people.map((u) => {
      const week = db.entries.filter((e) => e.userId === u.id && !e.active && e.date >= ws);
      const live = db.entries.some((e) => e.userId === u.id && e.active);
      return `<button class="list-item" data-act="edit-person" data-id="${u.id}">
        <span class="badge-circle ${u.role === 'manager' ? 'mgr' : ''}">${esc(initials(u.name))}</span>
        <span class="what"><b>${esc(u.name)}${u.active === false ? '<span class="tag off">Off</span>' : ''}${live ? '<span class="tag live">On clock</span>' : ''}</b><span>@${esc(u.username)} · ${u.role === 'manager' ? 'Manager' : 'Employee'}</span></span>
        <span class="side">${fmtHrs(sum(week, (e) => e.hours))} h<small>this week</small></span></button>`;
    }).join('')}</section>`;
}

// ---------- Settings ----------
function viewSettings() {
  const s = db.settings;
  return `
    <div class="page-head"><div><h1>Settings</h1></div></div>
    <form class="card settings-section" id="settings-form">
      <h3>Overtime rules</h3>
      <div class="row2">
        <label class="field"><span>Weekly OT after (hrs)</span><input name="weeklyOT" type="number" min="0" max="168" step="0.25" value="${s.weeklyOT}" inputmode="decimal"></label>
        <label class="field"><span>Daily OT after (hrs)</span><input name="dailyOT" type="number" min="0" max="24" step="0.25" value="${s.dailyOT}" inputmode="decimal"></label>
      </div>
      <p class="muted small">Use 0 to turn a rule off. Federal law uses 40 hrs/week. Some states also use a daily limit.</p>
      <label class="field"><span>Pay week starts on</span><select name="weekStart">${DAY_NAMES.map((d, i) => `<option value="${i}" ${+s.weekStart === i ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
      <button class="btn btn-go">Save overtime rules</button>
    </form>
    <section class="card settings-section">
      <h3>Data &amp; syncing</h3>
      ${db.mode === 'cloud'
        ? '<div class="mode-box"><b>Cloud sync is on.</b> Every phone shares one database. Phones keep working without signal and catch up once they reconnect.</div>'
        : `<div class="mode-box"><b>Device-only mode.</b> Hours are saved on <i>this</i> device only, so you only see hours entered here. To see everyone's phones in one place, turn on cloud sync (README.md, "Turn on syncing").</div>
           <div class="sheet-actions-row"><button class="btn btn-outline" data-act="export-json">${ICON.download} Back up data</button><button class="btn btn-outline" data-act="import-json">${ICON.upload} Restore backup</button></div>`}
      <button class="btn btn-outline" data-act="export-all">${ICON.download} Export all hours (CSV)</button>
    </section>`;
}

// ===========================================================================
// Modals
// ===========================================================================
function openModal(html, onMount) {
  $('#modal').innerHTML = `<div class="modal-backdrop" data-act="close-modal"></div><div class="sheet-panel" role="dialog" aria-modal="true">${html}</div>`;
  onMount?.($('#modal .sheet-panel'));
  const first = $('#modal input:not([type=hidden]):not([disabled]), #modal select:not([disabled])');
  if (first && window.matchMedia('(min-width: 640px)').matches) first.focus();
}
const closeModal = () => { $('#modal').innerHTML = ''; };
const formError = (msg) => { const el = $('#modal .form-error'); if (el) el.textContent = msg; };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'show ' + kind;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.className = ''; }, kind === 'error' ? 4500 : 2600);
}

// ---------- Add / edit hours ----------
function entryModal(entry, { userId } = {}) {
  const mgr = isManager();
  const e = entry || { userId: userId || db.me.id, projectId: lsGet('lastProject') || '', date: today(), start: '', end: '', hours: '', notes: '' };
  const readOnly = entry && !canEdit(entry);
  const mode = entry && !entry.start ? 'hours' : 'times';
  const minDate = mgr ? '' : addDays(today(), -(EDIT_WINDOW_DAYS - 1));
  const people = db.users.filter((u) => u.active !== false || u.id === e.userId).sort(byName);
  const lockMsg = readOnly ? (entry.lockedByManager
    ? `A manager (${esc(entry.editedBy || 'manager')}) changed this entry, so it is locked. Ask a manager if it needs fixing.`
    : `Entries older than ${EDIT_WINDOW_DAYS} days are locked. Ask a manager if it needs fixing.`) : '';
  openModal(`
    <form id="entry-form" data-mode="${mode}" novalidate>
      <h2>${!entry ? 'Add hours' : readOnly ? 'Entry details' : mgr && entry.userId !== db.me.id ? 'Change entry' : 'Edit hours'}</h2>
      ${readOnly ? `<p class="notice" style="margin-bottom:12px">${lockMsg}</p>` : ''}
      <fieldset ${readOnly ? 'disabled' : ''}>
        ${mgr ? `<label class="field"><span>Employee</span><select name="userId">${people.map((u) => `<option value="${u.id}" ${u.id === e.userId ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>` : ''}
        <label class="field"><span>Project</span><select name="projectId"><option value="">Choose project…</option>${projectOptions(e.projectId, e.projectId)}</select></label>
        <label class="field"><span>Date</span><input type="date" name="date" value="${e.date}" ${minDate ? `min="${minDate}"` : ''} max="${mgr ? '' : today()}"></label>
        ${entry?.active ? '<p class="notice">This person is on the clock. Leave End blank to keep them clocked in.</p>' : `
        <div class="seg" role="radiogroup" aria-label="How to enter time">
          <label><input type="radio" name="mode" value="times" ${mode === 'times' ? 'checked' : ''}>Start &amp; end time</label>
          <label><input type="radio" name="mode" value="hours" ${mode === 'hours' ? 'checked' : ''}>Total hours</label>
        </div>`}
        <div class="mode-times row2">
          <label class="field"><span>Start</span><input type="time" step="900" name="start" value="${e.start || ''}"></label>
          <label class="field"><span>End</span><input type="time" step="900" name="end" value="${e.end || ''}"></label>
        </div>
        <div class="mode-hours"><label class="field"><span>Hours worked</span><input type="number" name="hours" step="0.25" min="0.25" max="24" inputmode="decimal" value="${e.start ? '' : e.hours || ''}" placeholder="e.g. 8.5"></label></div>
        <label class="field"><span>Notes (optional)</span><input name="notes" maxlength="200" value="${esc(e.notes)}" placeholder="What you worked on"></label>
        <p class="preview" id="entry-preview"></p>
        <div class="form-error"></div>
      </fieldset>
      ${entry?.editedBy ? `<p class="muted small" style="margin:10px 0 0">Last changed by ${esc(entry.editedBy)}${entry.editedAt ? ' on ' + new Date(entry.editedAt).toLocaleString() : ''}.</p>` : ''}
      <div class="sheet-actions">
        ${entry && !readOnly ? `<button type="button" class="btn btn-danger-text" data-act="delete-entry" data-id="${entry.id}">Delete</button>` : ''}
        <button type="button" class="btn btn-outline" data-act="close-modal">${readOnly ? 'Close' : 'Cancel'}</button>
        ${readOnly ? '' : '<button class="btn btn-go">Save</button>'}
      </div>
    </form>`, (panel) => {
    const form = $('#entry-form', panel);
    const preview = () => {
      const f = new FormData(form);
      const m = form.dataset.mode;
      let txt = '';
      if (m === 'times' && f.get('start') && f.get('end')) {
        const s = roundTime(f.get('start')), en = roundTime(f.get('end'));
        const h = spanHours(s, en);
        txt = `${fmtTime(s)} to ${fmtTime(en)} = ${fmtHrs(h)} hrs${toMin(en) < toMin(s) ? ' (overnight)' : ''}`;
      } else if (m === 'hours' && f.get('hours')) {
        const h = roundHours(parseFloat(f.get('hours')));
        if (h > 0) txt = `${fmtHrs(h)} hrs (rounded to the nearest 15 min)`;
      }
      $('#entry-preview', panel).textContent = txt;
    };
    form.addEventListener('change', (ev) => {
      const t = ev.target;
      if (t.name === 'mode') form.dataset.mode = t.value;
      if (t.type === 'time' && t.value) t.value = roundTime(t.value);
      if (t.name === 'hours' && t.value) t.value = roundHours(parseFloat(t.value)) || '';
      preview();
    });
    form.addEventListener('input', preview);
    preview();
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (readOnly) return;
      const f = new FormData(form);
      const m = entry?.active ? 'times' : form.dataset.mode;
      const rec = {
        ...(entry || {}),
        id: entry?.id || newId(),
        userId: mgr ? f.get('userId') : db.me.id,
        projectId: f.get('projectId'),
        date: f.get('date'),
        notes: String(f.get('notes') || '').trim(),
        updatedAt: Date.now(),
      };
      if (!rec.projectId) return formError('Pick a project.');
      if (!rec.date) return formError('Pick a date.');
      if (!mgr && (rec.date > today() || rec.date < minDate)) return formError(`You can only log hours for the last ${EDIT_WINDOW_DAYS} days.`);
      if (m === 'times') {
        const s = f.get('start'), en = f.get('end');
        if (!s) return formError('Enter a start time.');
        rec.start = roundTime(s);
        if (!en) {
          if (!entry?.active) return formError('Enter an end time.');
          Object.assign(rec, { end: null, hours: 0, active: true });
        } else {
          rec.end = roundTime(en);
          rec.hours = roundHours(spanHours(rec.start, rec.end));
          rec.active = false;
          if (rec.hours <= 0) return formError('End time must be after start time.');
        }
      } else {
        const h = roundHours(parseFloat(f.get('hours')));
        if (!(h > 0) || h > 24) return formError('Enter hours between 0.25 and 24.');
        Object.assign(rec, { start: null, end: null, hours: h, active: false });
      }
      if (!entry) { rec.createdAt = Date.now(); rec.method = 'manual'; rec.createdBy = db.me.id; }
      if (mgr && rec.userId !== db.me.id) {
        Object.assign(rec, { editedBy: db.me.name, editedAt: Date.now(), lockedByManager: true });
      }
      lsSet('lastProject', rec.projectId);
      store.save('entries', rec);
      closeModal();
      toast(entry ? 'Entry updated' : `${fmtHrs(rec.hours)} hrs saved`);
    });
  });
}

// ---------- Project ----------
function projectModal(p) {
  const used = p && db.entries.some((e) => e.projectId === p.id);
  openModal(`
    <form id="project-form" novalidate>
      <h2>${p ? 'Edit project' : 'New project'}</h2>
      <fieldset>
        <label class="field"><span>Project name</span><input name="name" maxlength="80" value="${esc(p?.name)}" placeholder="e.g. Miller Ridge Timber Sale" required></label>
        <div class="row2">
          <label class="field"><span>Job # (optional)</span><input name="code" maxlength="30" value="${esc(p?.code)}"></label>
          <label class="field"><span>Location (optional)</span><input name="location" maxlength="80" value="${esc(p?.location)}"></label>
        </div>
        <label class="field"><span>Notes (optional)</span><textarea name="notes" rows="2" maxlength="300">${esc(p?.notes)}</textarea></label>
        ${p ? `<label class="check"><input type="checkbox" name="active" ${p.active !== false ? 'checked' : ''}> Open for logging hours</label>
               <p class="muted small" style="margin:0">Uncheck to archive. Archived projects keep their hours but disappear from the crew's project list.</p>` : ''}
        <div class="form-error"></div>
      </fieldset>
      <div class="sheet-actions">
        ${p && !used ? `<button type="button" class="btn btn-danger-text" data-act="delete-project" data-id="${p.id}">Delete</button>` : ''}
        <button type="button" class="btn btn-outline" data-act="close-modal">Cancel</button>
        <button class="btn btn-go">Save</button>
      </div>
    </form>`, (panel) => {
    $('#project-form', panel).addEventListener('submit', (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      const name = String(f.get('name')).trim();
      if (!name) return formError('Give the project a name.');
      store.save('projects', {
        ...(p || { id: newId(), createdAt: Date.now() }),
        name, code: String(f.get('code')).trim(), location: String(f.get('location')).trim(), notes: String(f.get('notes')).trim(),
        active: p ? f.get('active') === 'on' : true, updatedAt: Date.now(),
      });
      closeModal();
      toast(p ? 'Project saved' : 'Project added');
    });
  });
}

// ---------- Person ----------
function personModal(u) {
  const self = u?.id === db.me.id;
  openModal(`
    <form id="person-form" novalidate>
      <h2>${u ? 'Edit person' : 'Add person'}</h2>
      <fieldset>
        <label class="field"><span>Full name</span><input name="name" maxlength="60" value="${esc(u?.name)}" required></label>
        <label class="field"><span>Username (used to sign in)</span><input name="username" maxlength="30" autocapitalize="none" spellcheck="false" value="${esc(u?.username)}" ${u ? 'disabled' : ''} placeholder="e.g. mike.r"></label>
        ${u && !store.canResetPins ? `<p class="notice"><b>Forgot their PIN?</b> PIN reset is off on the free plan. Uncheck "Can sign in" below and save, then use <b>Add person</b> to add them again with a new username (for example ${esc(u.username)}2) and a new PIN. Their old hours stay on the books.</p>` : `
        <div class="field"><span>${u ? 'Reset PIN (leave blank to keep the current one)' : '4-digit PIN'}</span>
          <div class="pin-row">${pinInput('', 'pin', 'off', { visible: true, value: u ? '' : randomPin() })}
            <button type="button" class="btn btn-outline btn-sm" data-act="random-pin">New random PIN</button></div>
          <small class="muted">${u ? 'Type a new PIN, then Save. Tell them the new PIN.' : store.canResetPins ? 'Tell them this PIN. You can reset it any time.' : 'Tell them this PIN and ask them to remember it.'}</small>
        </div>`}
        <label class="field"><span>Role</span><select name="role" ${self ? 'disabled' : ''}>
          <option value="employee" ${u?.role !== 'manager' ? 'selected' : ''}>Employee (logs own hours)</option>
          <option value="manager" ${u?.role === 'manager' ? 'selected' : ''}>Manager (sees and changes everything)</option>
        </select></label>
        ${u && !self ? `<label class="check"><input type="checkbox" name="active" ${u.active !== false ? 'checked' : ''}> Can sign in</label>` : ''}
        <div class="form-error"></div>
      </fieldset>
      <div class="sheet-actions">
        <button type="button" class="btn btn-outline" data-act="close-modal">Cancel</button>
        <button class="btn btn-go">${u ? 'Save' : 'Add person'}</button>
      </div>
    </form>`, (panel) => {
    $('#person-form', panel).addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      const name = String(f.get('name') || '').trim();
      const pin = String(f.get('pin') || '');
      const role = self ? 'manager' : f.get('role');
      if (!name) return formError('Enter a name.');
      const btn = ev.target.querySelector('.btn-go');
      try {
        if (!u) {
          const username = normUsername(f.get('username'));
          if (!username) return formError('Enter a username (letters, numbers, dots or dashes).');
          if (!isPin(pin)) return formError('The PIN must be exactly 4 digits.');
          btn.disabled = true; btn.textContent = 'Adding…';
          await store.createUser({ name, username, role }, pin);
          toast(`${firstName(name)} signs in as "${username}" with PIN ${pin}`);
        } else {
          if (pin && !isPin(pin)) return formError('The new PIN must be exactly 4 digits.');
          btn.disabled = true; btn.textContent = 'Saving…';
          if (pin) await store.setPin(u.id, pin); // reset first: if it fails, nothing else changes
          store.save('users', { ...u, name, role, active: self ? true : f.get('active') === 'on' });
          toast(pin ? `PIN reset. ${firstName(name)}'s new PIN is ${pin}` : 'Saved');
        }
        closeModal();
      } catch (err) {
        btn.disabled = false; btn.textContent = u ? 'Save' : 'Add person';
        formError(friendly(err));
      }
    });
  });
}

// ---------- Account ----------
function accountModal() {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  openModal(`
    <div class="account-head"><span class="avatar">${esc(initials(db.me.name))}</span><div><h2 style="margin:0">${esc(db.me.name)}</h2><span class="muted">@${esc(db.me.username)} · ${isManager() ? 'Manager' : 'Employee'}</span></div></div>
    <div class="menu-list">
      ${isManager() ? `<button class="btn btn-outline" data-act="go" data-to="#/hours">${ICON.list} My hours</button><button class="btn btn-outline" data-act="go" data-to="#/settings">${ICON.gear} Settings</button>` : ''}
      ${!standalone && ui.installEvt ? `<button class="btn btn-outline" data-act="install">${ICON.phone} Install app on this phone</button>` : ''}
      ${!standalone && isIOS ? `<p class="notice">${ICON.phone} To install on iPhone: tap the Share button in Safari, then <b>Add to Home Screen</b>.</p>` : ''}
      <button class="btn btn-outline" data-act="logout">${ICON.out} Sign out</button>
    </div>
    <p class="muted small center" style="margin:16px 0 0">${APP_NAME} · Santoro's Logging · ${db.mode === 'cloud' ? 'Cloud sync' : 'Device-only mode'}</p>`);
}

// ===========================================================================
// Actions
// ===========================================================================
function clockIn() {
  const pid = $('#clock-project')?.value;
  if (!pid) return toast('Pick a project first', 'error');
  if (db.entries.some((e) => e.userId === db.me.id && e.active)) return toast('You are already clocked in', 'error');
  const t = roundNow();
  lsSet('lastProject', pid);
  store.save('entries', {
    id: newId(), userId: db.me.id, projectId: pid, date: dateStr(t), start: hhmm(t), end: null, hours: 0,
    active: true, method: 'clock', notes: '', createdAt: Date.now(), updatedAt: Date.now(), createdBy: db.me.id,
  });
  toast(`Clocked in at ${fmtTime(hhmm(t))}`);
}

function clockOut(id, { quiet = false } = {}) {
  const e = db.entries.find((x) => x.id === id);
  if (!e) return false;
  const t = roundNow();
  const hrs = roundHours(Math.max(0, (t - startDT(e)) / 3600000));
  if (hrs > 16 && !confirm(`That is ${fmtHrs(hrs)} hours since you clocked in. Did you forget to clock out?\n\nOK = save ${fmtHrs(hrs)} hrs anyway\nCancel = fix the times`)) {
    entryModal({ ...e, end: hhmm(t) });
    return false;
  }
  if (hrs === 0) {
    // Rounds to zero: nothing to record, so drop the punch entirely.
    if (!quiet && !confirm('That rounds to 0 hours, so nothing will be recorded. Clock out anyway?')) return false;
    store.remove('entries', e.id);
    if (!quiet) toast('Clocked out. Nothing recorded (under 15 minutes).');
    return true;
  }
  store.save('entries', { ...e, end: hhmm(t), hours: hrs, active: false, updatedAt: Date.now() });
  if (!quiet) toast(`Clocked out at ${fmtTime(hhmm(t))} · ${fmtHrs(hrs)} hrs`);
  return true;
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function toCSV(entries) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Date', 'Employee', 'Username', 'Project', 'Job #', 'Start', 'End', 'Hours', 'Regular', 'Overtime', 'Status', 'Notes', 'Changed by manager'];
  const rows = entries.map((e) => {
    const u = userById(e.userId) || {}, p = projectById(e.projectId) || {};
    const ot = OT.get(e.id) || 0;
    return [e.date, u.name, u.username, p.name || 'Removed project', p.code, e.start ? fmtTime(e.start) : '', e.end ? fmtTime(e.end) : '',
      e.active ? '' : e.hours, e.active ? '' : (e.hours || 0) - ot, e.active ? '' : ot, e.active ? 'On the clock' : 'Done', e.notes, e.editedBy || ''].map(q).join(',');
  });
  return '﻿' + [head.map(q).join(','), ...rows].join('\r\n');
}

function randomPin() {
  const n = globalThis.crypto?.getRandomValues ? crypto.getRandomValues(new Uint32Array(1))[0] : Math.floor(Math.random() * 1e9);
  return String(n % 10000).padStart(4, '0');
}

const actions = {
  'random-pin': (el) => { const box = el.parentElement.querySelector('[data-pin]'); box.value = randomPin(); box.focus(); },
  'clock-in': clockIn,
  'clock-out': (el) => clockOut(el.dataset.id),
  'add-entry': (el) => entryModal(null, { userId: el.dataset.forManager && tsState().user ? tsState().user : db.me.id }),
  'edit-entry': (el) => { const e = db.entries.find((x) => x.id === el.dataset.id); if (e) entryModal(e); },
  'delete-entry': (el) => {
    if (!confirm('Delete this entry? This cannot be undone.')) return;
    store.remove('entries', el.dataset.id); closeModal(); toast('Entry deleted');
  },
  'edit-project': (el) => projectModal(el.dataset.id ? projectById(el.dataset.id) : null),
  'delete-project': (el) => {
    if (!confirm('Delete this project? This cannot be undone.')) return;
    store.remove('projects', el.dataset.id); closeModal(); toast('Project deleted');
  },
  'edit-person': (el) => personModal(el.dataset.id ? userById(el.dataset.id) : null),
  'account': accountModal,
  'close-modal': closeModal,
  'go': (el) => { closeModal(); location.hash = el.dataset.to; },
  'logout': async () => { closeModal(); ui.ts = null; ui.weekOffset = 0; await store.logout(); location.hash = ''; render(); },
  'install': async () => { closeModal(); ui.installEvt?.prompt(); ui.installEvt = null; },
  'week': (el) => { ui.weekOffset = Math.min(0, ui.weekOffset + Number(el.dataset.dir)); render(); },
  'ts-view': (el) => {
    const ts = tsState();
    ts.view = el.dataset.v;
    if (ts.view === 'grid') { const ws = weekStartOf(ts.from); Object.assign(ts, { from: ws, to: addDays(ws, 6), preset: 'custom' }); }
    render();
  },
  'ts-week': (el) => {
    const ts = tsState();
    const ws = addDays(weekStartOf(ts.from), Number(el.dataset.dir) * 7);
    Object.assign(ts, { from: ws, to: addDays(ws, 6), preset: 'custom' });
    render();
  },
  'grid-person': (el) => { Object.assign(tsState(), { user: el.dataset.id, view: 'entries' }); render(); },
  'export-csv': () => {
    const ts = tsState(), rows = tsEntries();
    if (!rows.length) return toast('Nothing to export', 'error');
    download(`logbook-hours-${ts.from}-to-${ts.to}.csv`, toCSV(rows), 'text/csv;charset=utf-8');
  },
  'export-all': () => {
    const rows = [...db.entries].sort((a, b) => a.date.localeCompare(b.date) || byStart(a, b));
    if (!rows.length) return toast('Nothing to export', 'error');
    download(`logbook-all-hours-${today()}.csv`, toCSV(rows), 'text/csv;charset=utf-8');
  },
  'export-json': () => download(`logbook-backup-${today()}.json`, store.exportBackup(), 'application/json'),
  'import-json': () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      if (!confirm('Restoring replaces ALL data on this device with the backup. Continue?')) return;
      try { store.importBackup(await file.text()); toast('Backup restored'); } catch (err) { toast(friendly(err), 'error'); }
    };
    input.click();
  },
};

const changes = {
  switch: (el) => {
    const pid = el.value;
    if (!pid) return;
    const old = db.entries.find((x) => x.id === el.dataset.id);
    if (!old) return;
    const t = roundNow();
    if (!clockOut(old.id, { quiet: true })) { el.value = ''; return; }
    lsSet('lastProject', pid);
    store.save('entries', {
      id: newId(), userId: db.me.id, projectId: pid, date: dateStr(t), start: hhmm(t), end: null, hours: 0,
      active: true, method: 'clock', notes: '', createdAt: Date.now(), updatedAt: Date.now(), createdBy: db.me.id,
    });
    toast(`Switched to ${projectName(pid)}`);
  },
  'ts-preset': (el) => { const ts = tsState(); ts.preset = el.value; if (el.value !== 'custom') [ts.from, ts.to] = presetRange(el.value); render(); },
  'ts-from': (el) => { const ts = tsState(); if (!el.value) return; ts.from = el.value; ts.preset = 'custom'; if (ts.to < ts.from) ts.to = ts.from; render(); },
  'ts-to': (el) => { const ts = tsState(); if (!el.value) return; ts.to = el.value; ts.preset = 'custom'; if (ts.from > ts.to) ts.from = ts.to; render(); },
  'ts-user': (el) => { tsState().user = el.value; render(); },
  'ts-project': (el) => { tsState().project = el.value; render(); },
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (fn) { ev.preventDefault(); fn(el, ev); }
});
document.addEventListener('change', (ev) => {
  const el = ev.target.closest('[data-change]');
  if (el && changes[el.dataset.change]) changes[el.dataset.change](el);
});
document.addEventListener('submit', (ev) => {
  if (ev.target.id !== 'settings-form') return;
  ev.preventDefault();
  const f = new FormData(ev.target);
  const num = (k, max) => Math.min(max, Math.max(0, roundHours(parseFloat(f.get(k)) || 0)));
  store.saveSettings({ ...DEFAULT_SETTINGS, ...db.settings, weeklyOT: num('weeklyOT', 168), dailyOT: num('dailyOT', 24), weekStart: Number(f.get('weekStart')) });
  toast('Overtime rules saved');
});

// Live clock text (elapsed time, rounded clock-in preview).
function tick() {
  document.querySelectorAll('[data-elapsed]').forEach((el) => {
    const e = db.entries.find((x) => x.id === el.dataset.elapsed);
    if (e) el.textContent = fmtDuration(Date.now() - startDT(e));
  });
  document.querySelectorAll('[data-outpreview]').forEach((el) => {
    const e = db.entries.find((x) => x.id === el.dataset.outpreview);
    if (!e) return;
    const t = roundNow();
    el.textContent = `Clock out now: ${fmtTime(hhmm(t))}, ${fmtHrs(roundHours(Math.max(0, (t - startDT(e)) / 3600000)))} hrs`;
  });
  const rp = $('#round-preview');
  if (rp) rp.textContent = fmtTime(hhmm(roundNow()));
}
setInterval(tick, 1000);

// ===========================================================================
// Start-up
// ===========================================================================
window.addEventListener('hashchange', () => { closeModal(); render(); window.scrollTo(0, 0); });
window.addEventListener('online', render);
window.addEventListener('offline', render);
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); ui.installEvt = e; });
document.addEventListener('visibilitychange', () => { if (!document.hidden && db.me) render(); });

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Offline support unavailable:', err));
}

setErrorHandler((err) => toast(friendly(err), 'error'));
onChange(render);

(async () => {
  try {
    await store.init();
  } catch (err) {
    console.error(err);
    $('#app').innerHTML = `<div class="boot"><img src="assets/logo-s.png" alt=""><p><b>LogBook could not start.</b></p><p class="small">${navigator.onLine ? esc(friendly(err)) : 'Connect to the internet once to finish installing, then it works offline.'}</p><button class="btn btn-go" onclick="location.reload()">Try again</button></div>`;
    return;
  }
  if (!db.me) ui.needsSetup = await store.needsSetup();
  render();
})();
