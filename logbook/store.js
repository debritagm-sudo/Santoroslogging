// Data layer. Two interchangeable back ends with the same interface:
//   deviceAdapter – localStorage on this device only (no setup needed)
//   cloudAdapter  – Firebase Auth + Firestore with offline persistence
import { FIREBASE_CONFIG, PIN_RESET_ENABLED } from './config.js';

// weeklyOT / dailyOT apply to loggers; driverWeeklyOT applies to truck drivers.
export const DEFAULT_SETTINGS = { weeklyOT: 40, dailyOT: 0, driverWeeklyOT: 40, weekStart: 0 };

// Shared in-memory snapshot the UI renders from.
export const db = {
  mode: FIREBASE_CONFIG ? 'cloud' : 'device',
  me: null,
  users: [],
  projects: [],
  entries: [],
  settings: { ...DEFAULT_SETTINGS },
  pendingSync: false,
};

const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
let emitQueued = false;
function emit() {
  if (emitQueued) return;
  emitQueued = true;
  queueMicrotask(() => { emitQueued = false; listeners.forEach((fn) => fn()); });
}

let errorHandler = (err) => console.error(err);
export const setErrorHandler = (fn) => { errorHandler = fn; };

export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

export const normUsername = (u) => String(u || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');

// Sign-in uses a 4-digit PIN.
export const isPin = (p) => /^\d{4}$/.test(String(p ?? ''));
// Firebase requires 6+ character passwords, so the PIN is padded into one.
// This is not a secret: protection against PIN guessing comes from Firebase's
// sign-in rate limiting. Must match functions/index.js.
const pinToPassword = (pin) => `lb-${pin}-santoros`;

async function hashPw(username, pw) {
  const text = 'logbook:' + username + ':' + pw;
  if (globalThis.crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 2166136261;
  for (const c of text) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); }
  return 'f' + (h >>> 0).toString(16);
}

function waitFor(cond, ms = 10000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const check = () => (cond() || Date.now() - t0 > ms ? resolve() : setTimeout(check, 100));
    check();
  });
}

// ---------------------------------------------------------------------------
// Device-only storage
// ---------------------------------------------------------------------------
function deviceAdapter() {
  const KEY = 'logbook-data-v1';
  const SESSION = 'logbook-session-v1';
  const blank = () => ({ users: [], projects: [], entries: [], settings: { ...DEFAULT_SETTINGS }, setupDone: false });
  let s;
  try { s = JSON.parse(localStorage.getItem(KEY)) || blank(); } catch { s = blank(); }

  const strip = ({ pwHash, ...u }) => u;
  const session = () => { try { return localStorage.getItem(SESSION); } catch { return null; } };
  const publish = () => {
    const me = s.users.find((u) => u.id === session() && u.active);
    db.me = me ? strip(me) : null;
    db.users = s.users.map(strip);
    db.projects = [...s.projects];
    db.entries = [...s.entries];
    db.settings = { ...DEFAULT_SETTINGS, ...s.settings };
    emit();
  };
  const persist = () => {
    try { localStorage.setItem(KEY, JSON.stringify(s)); }
    catch (err) { errorHandler(new Error('Could not save on this device (storage full or blocked).')); }
    publish();
  };
  window.addEventListener('storage', (e) => {
    if (e.key === KEY || e.key === SESSION) {
      try { s = JSON.parse(localStorage.getItem(KEY)) || s; } catch { /* keep current */ }
      publish();
    }
  });

  const makeUser = async ({ name, username, role, crewType = 'logger' }, pin) => ({
    id: newId(), name: name.trim(), username: normUsername(username), role, crewType, active: true,
    createdAt: Date.now(), pwHash: await hashPw(normUsername(username), pin),
  });

  return {
    canResetPins: true,
    async init() { publish(); },
    async needsSetup() { return !s.setupDone; },
    async setup(info) {
      const user = await makeUser({ ...info, role: 'manager' }, info.pin);
      s.users.push(user);
      s.setupDone = true;
      localStorage.setItem(SESSION, user.id);
      persist();
    },
    async login(username, pin) {
      const u = normUsername(username);
      const user = s.users.find((x) => x.username === u);
      if (!user || user.pwHash !== (await hashPw(u, pin))) throw new Error('Wrong username or PIN.');
      if (!user.active) throw new Error('This account has been turned off. Talk to your manager.');
      localStorage.setItem(SESSION, user.id);
      publish();
    },
    async logout() { localStorage.removeItem(SESSION); publish(); },
    save(coll, doc) {
      const arr = s[coll];
      const i = arr.findIndex((x) => x.id === doc.id);
      if (i >= 0) arr[i] = coll === 'users' ? { ...arr[i], ...doc } : doc;
      else arr.push(doc);
      persist();
    },
    remove(coll, id) { s[coll] = s[coll].filter((x) => x.id !== id); persist(); },
    saveSettings(settings) { s.settings = { ...settings }; persist(); },
    async createUser(info, pin) {
      const u = normUsername(info.username);
      if (s.users.some((x) => x.username === u)) throw new Error('That username is already taken.');
      const user = await makeUser(info, pin);
      s.users.push(user);
      persist();
      return user.id;
    },
    async setPin(userId, pin) {
      const user = s.users.find((x) => x.id === userId);
      user.pwHash = await hashPw(user.username, pin);
      persist();
    },
    exportBackup() { return JSON.stringify(s, null, 1); },
    importBackup(text) {
      const data = JSON.parse(text);
      if (!Array.isArray(data.users) || !Array.isArray(data.entries) || !Array.isArray(data.projects)) {
        throw new Error('That file is not a LogBook backup.');
      }
      s = { ...blank(), ...data };
      persist();
    },
  };
}

// ---------------------------------------------------------------------------
// Firebase (cloud sync + offline)
// ---------------------------------------------------------------------------
function cloudAdapter(cfg) {
  const base = 'https://www.gstatic.com/firebasejs/10.12.2/';
  let F, A, S, auth, fs;
  let unsubs = [];
  let meUnsub = null;
  let currentRole = null;
  let settingUp = false;

  const toEmail = (u) => `${normUsername(u)}@santoros-logbook.app`;
  const clearSubs = () => { unsubs.forEach((u) => u()); unsubs = []; };
  // Firestore writes resolve only once the server confirms. Offline that can be
  // hours later, so never await them: the local cache updates instantly.
  const write = (p) => { p.catch((err) => errorHandler(err)); };
  const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

  function subscribeData(role, uid) {
    clearSubs();
    const live = (ref, fn) => unsubs.push(S.onSnapshot(ref, { includeMetadataChanges: true }, fn, errorHandler));
    live(S.collection(fs, 'projects'), (snap) => {
      db.projects = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
      emit();
    });
    live(S.doc(fs, 'meta', 'settings'), (snap) => {
      db.settings = { ...DEFAULT_SETTINGS, ...(snap.data() || {}) };
      emit();
    });
    const entriesRef = role === 'manager'
      ? S.collection(fs, 'entries')
      : S.query(S.collection(fs, 'entries'), S.where('userId', '==', uid));
    live(entriesRef, (snap) => {
      db.entries = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
      db.pendingSync = snap.metadata.hasPendingWrites;
      emit();
    });
    if (role === 'manager') {
      live(S.collection(fs, 'users'), (snap) => {
        db.users = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
        emit();
      });
    }
  }

  function handleUser(user) {
    if (meUnsub) { meUnsub(); meUnsub = null; }
    clearSubs();
    currentRole = null;
    if (!user) {
      Object.assign(db, { me: null, users: [], projects: [], entries: [], pendingSync: false });
      emit();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 8000);
      const done = () => { clearTimeout(timer); resolve(); };
      meUnsub = S.onSnapshot(S.doc(fs, 'users', user.uid), (snap) => {
        if (!snap.exists()) {
          if (snap.metadata.fromCache || settingUp) return; // wait for the server
          errorHandler(new Error('This login has no LogBook profile. Ask a manager to add you.'));
          A.signOut(auth);
          return done();
        }
        const me = { ...snap.data(), id: snap.id };
        if (!me.active) {
          errorHandler(new Error('This account has been turned off. Talk to your manager.'));
          A.signOut(auth);
          return done();
        }
        db.me = me;
        if (me.role !== currentRole) { currentRole = me.role; subscribeData(me.role, me.id); }
        if (me.role !== 'manager') db.users = [me];
        emit();
        done();
      }, (err) => { errorHandler(err); done(); });
    });
  }

  return {
    canResetPins: PIN_RESET_ENABLED,
    async init() {
      [F, A, S] = await Promise.all([
        import(base + 'firebase-app.js'),
        import(base + 'firebase-auth.js'),
        import(base + 'firebase-firestore.js'),
      ]);
      const app = F.initializeApp(cfg);
      auth = A.getAuth(app);
      fs = S.initializeFirestore(app, {
        localCache: S.persistentLocalCache({ tabManager: S.persistentMultipleTabManager() }),
      });
      await new Promise((res) => {
        let first = true;
        A.onAuthStateChanged(auth, (user) => {
          const p = handleUser(user);
          if (first) { first = false; p.then(res); }
        });
      });
    },
    async needsSetup() {
      try { return !(await S.getDoc(S.doc(fs, 'meta', 'setup'))).exists(); }
      catch { return false; }
    },
    async setup({ name, username, pin }) {
      settingUp = true;
      try {
        const cred = await A.createUserWithEmailAndPassword(auth, toEmail(username), pinToPassword(pin));
        const b = S.writeBatch(fs);
        b.set(S.doc(fs, 'meta', 'setup'), { done: true, at: Date.now() });
        b.set(S.doc(fs, 'users', cred.user.uid), {
          name: name.trim(), username: normUsername(username), role: 'manager', crewType: 'logger', active: true, createdAt: Date.now(),
        });
        await b.commit();
      } finally { settingUp = false; }
      await waitFor(() => db.me);
    },
    async login(username, pin) {
      const cred = await A.signInWithEmailAndPassword(auth, toEmail(username), pinToPassword(pin));
      await waitFor(() => db.me?.id === cred.user.uid || !auth.currentUser);
    },
    async logout() { await A.signOut(auth); },
    save(coll, doc) { write(S.setDoc(S.doc(fs, coll, doc.id), clean(doc))); },
    remove(coll, id) { write(S.deleteDoc(S.doc(fs, coll, id))); },
    saveSettings(settings) { write(S.setDoc(S.doc(fs, 'meta', 'settings'), clean(settings))); },
    async createUser(info, pin) {
      if (!navigator.onLine) throw new Error('You need signal to add a new person.');
      // A second Firebase app instance creates the login without signing the manager out.
      const app2 = F.initializeApp(cfg, 'add-user-' + Date.now());
      try {
        const auth2 = A.getAuth(app2);
        const cred = await A.createUserWithEmailAndPassword(auth2, toEmail(info.username), pinToPassword(pin));
        await A.signOut(auth2);
        await S.setDoc(S.doc(fs, 'users', cred.user.uid), {
          name: info.name.trim(), username: normUsername(info.username), role: info.role,
          crewType: info.crewType || 'logger', active: true, createdAt: Date.now(),
        });
        return cred.user.uid;
      } finally { F.deleteApp(app2); }
    },
    // Changing someone else's login needs admin rights, so this calls the
    // setPin Cloud Function (functions/index.js), which checks the caller is a manager.
    async setPin(userId, pin) {
      if (!navigator.onLine) throw new Error('You need signal to reset a PIN.');
      const Fn = await import(base + 'firebase-functions.js');
      try {
        await Fn.httpsCallable(Fn.getFunctions(F.getApp()), 'setPin')({ userId, pin });
      } catch (err) {
        const bare = String(err.code || '').replace('functions/', '') === err.message;
        if (bare && (err.code === 'functions/not-found' || err.code === 'functions/internal')) {
          throw new Error('PIN reset is not set up yet. Deploy the setPin function (README, step 8).');
        }
        throw err;
      }
    },
  };
}

export const store = FIREBASE_CONFIG ? cloudAdapter(FIREBASE_CONFIG) : deviceAdapter();
