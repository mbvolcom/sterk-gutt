// ══ STERK GUTT — main application module ════════════════════════════════════
// CSS is imported via main.js. All app logic lives here for now.
// Future: split into db.js, ui/workout.js, ui/routines.js etc.

import { createClient } from '@supabase/supabase-js';

// Re-export createClient so the rest of the file can use sb directly
const SUPA_URL = 'https://fzbovpdnpvsfdnxyftqv.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ6Ym92cGRucHZzZmRueHlmdHF2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwMzM5NzcsImV4cCI6MjA5MzYwOTk3N30.LqtdpwtEfZweiQW3NJmtFkVZuCG7_ANLP8yLB8XfIn4';
const sb = createClient(SUPA_URL, SUPA_KEY, {
  auth: {
    detectSessionInUrl: true,
    persistSession: true,
    autoRefreshToken: true,
  },
});

// ── AUTH ─────────────────────────────────────────────────────────────────────
const OLD_LEGACY_USER_ID = 'sg_k5dgxv305khmp604919'; // data to migrate on first login

let currentUser = null;

async function initAuth() {
  // Listen for auth state changes
  sb.auth.onAuthStateChange(async (event, session) => {
    if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session) {
      try {
        currentUser = session.user;
        USER_ID = session.user.id;
        hideLoginScreen();
        await migrateDataIfNeeded();
        // Small delay to ensure Supabase client is fully ready
        await new Promise(resolve => setTimeout(resolve, 100));
        await syncFromCloud();
        renderHome();
        const activePage = document.querySelector('.page.active');
        if (activePage && activePage.id === 'page-routines') renderRoutines();
      } catch(e) {
        console.error('Auth flow error:', e.message, e.stack);
      }
    } else if (event === 'SIGNED_OUT' || (event === 'INITIAL_SESSION' && !session)) {
      currentUser = null;
      showLoginScreen();
    }
  });

  // onAuthStateChange fires INITIAL_SESSION immediately — handles both
  // already-logged-in and fresh login cases. No need for getSession separately.
}

async function signInWithGoogle() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: 'https://sterk-gutt.pages.dev',
    },
  });
  if (error) console.error('Google sign in error:', error.message);
}

async function signInWithMagicLink() {
  const email = document.getElementById('magic-email').value.trim();
  if (!email) { showToast('Enter your email'); return; }
  const btn = document.getElementById('magic-link-btn');
  btn.textContent = 'Sending...'; btn.disabled = true;
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: 'https://sterk-gutt.pages.dev' },
  });
  btn.disabled = false;
  if (error) {
    btn.textContent = 'Send magic link';
    showToast('Error: ' + error.message);
  } else {
    btn.textContent = 'Send magic link';
    document.getElementById('magic-link-sent').style.display = 'block';
  }
}

async function signOut() {
  await sb.auth.signOut();
  currentUser = null;
  USER_ID = 'pending';
  _exercises = []; _routines = []; _sessions = [];
  showLoginScreen();
}

async function migrateDataIfNeeded() {
  // Data already migrated manually via SQL — skip
  console.log('migrateDataIfNeeded — skipping (already done)');
  return;
}

function showLoginScreen() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('main-app').style.display = 'none';
}

function hideLoginScreen() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('main-app').style.display = 'flex';
}


// ═══════════════════════════════════════════
// SUPABASE CONFIG
// ═══════════════════════════════════════════
const SUPABASE_URL = 'https://fzbovpdnpvsfdnxyftqv.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ6Ym92cGRucHZzZmRueHlmdHF2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwMzM5NzcsImV4cCI6MjA5MzYwOTk3N30.LqtdpwtEfZweiQW3NJmtFkVZuCG7_ANLP8yLB8XfIn4';

// ── Anonymous device user ID ──────────────────────────────
// Stored in localStorage only as a bootstrap key — all actual data in Supabase.
async function getUserId() {
  let id = localStorage.getItem('sg_user_id');
  if (!id) {
    id = 'sg_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('sg_user_id', id);
    // Also store in Supabase for reference
    // user_config skip — using auth.uid() now
  }
  return id;
}
let USER_ID = localStorage.getItem('sg_user_id') || 'pending';

// ═══════════════════════════════════════════
// SUPABASE DATA LAYER (Supabase is source of truth)
// ═══════════════════════════════════════════

// In-memory cache — loaded from Supabase on init
let _exercises = [];
let _routines  = [];
let _sessions  = [];
let _activeSession = null;

// Shim for legacy load() calls that still exist
const SK = { routines:'_r', sessions:'_s', activeSession:'_a', exercises:'_e' };
function load(key) {
  if (key === SK.exercises)     return _exercises.length ? _exercises : null;
  if (key === SK.routines)      return _routines.length  ? _routines  : null;
  if (key === SK.sessions)      return _sessions.length  ? _sessions  : null;
  if (key === SK.activeSession) return _activeSession;
  return null;
}
function save(key, val) {
  if (key === SK.exercises)     { _exercises = val || []; return; }
  if (key === SK.routines)      { _routines  = val || []; return; }
  if (key === SK.sessions)      { _sessions  = val || []; return; }
  if (key === SK.activeSession) { _activeSession = val;   return; }
}

function setSyncStatus(status) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  if (status === 'syncing') { el.textContent = '⟳ syncing'; el.style.color = 'var(--muted2)'; }
  else if (status === 'ok') { el.textContent = '✓ synced'; el.style.color = 'var(--neon2)'; setTimeout(() => { el.textContent = ''; }, 3000); }
  else if (status === 'offline') { el.textContent = '○ offline'; el.style.color = 'var(--muted)'; }
  else { el.textContent = ''; }
}

// ── EXERCISES ────────────────────────────────────────────
async function dbLoadExercises() {
  try {
    const data = await supabaseFetch('exercises', `select=*&user_id=eq.${USER_ID}&order=name`);
    if (data && data.length) {
      _exercises = data.map(e => ({ id:e.id, name:e.name, muscle:e.muscle, unilateral:!!e.unilateral }));
    } else {
      await dbSeedExercises();
    }
    // Recovery: scan routines and sessions for exercises not in library
    const knownNames = new Set(_exercises.map(e => e.name));
    const toSave = [];
    [..._routines, ..._sessions].forEach(item => {
      (item.exercises || []).forEach(ex => {
        if (ex.name && !knownNames.has(ex.name)) {
          knownNames.add(ex.name);
          const recovered = {
            id: ex.id || ('ex_' + Date.now() + '_' + Math.random().toString(36).slice(2)),
            name: ex.name, muscle: ex.muscle || 'Other', unilateral: !!ex.unilateral,
          };
          _exercises.push(recovered);
          toSave.push(recovered);
        }
      });
    });
    if (toSave.length) {
      for (const ex of toSave) await dbSaveExercise(ex);
    }
  } catch(e) { console.warn('Load exercises failed:', e.message); }
}

async function dbSeedExercises() {
  const rows = DEFAULT_EXERCISES.map(e => ({ ...e, user_id: USER_ID }));
  await supabaseFetch('exercises', 'on_conflict=id', 'POST', rows);
  _exercises = [...DEFAULT_EXERCISES];
}

async function dbSaveExercise(ex) {
  // Update in-memory immediately so UI reflects change right away
  const clean = { id: ex.id, name: ex.name, muscle: ex.muscle||'', unilateral: !!ex.unilateral };
  const idx = _exercises.findIndex(e => e.id === ex.id);
  if (idx >= 0) _exercises[idx] = clean;
  else          _exercises.push(clean);
  // Refresh exercises tab if visible
  if (document.getElementById('page-exercises')?.classList.contains('active')) renderExerciseLibrary();

  try {
    const row = { id: ex.id, name: ex.name, muscle: ex.muscle||'', unilateral: !!ex.unilateral, user_id: USER_ID };
    await supabaseFetch('exercises', 'on_conflict=id', 'POST', row);
    setSyncStatus('ok');
  } catch(e) {
    console.warn('dbSaveExercise failed:', e.message);
    setSyncStatus('offline');
  }
}
async function dbDeleteExercise(id) {
  try {
    await supabaseFetch(`exercises?id=eq.${id}&user_id=eq.${USER_ID}`, '', 'DELETE');
    _exercises = _exercises.filter(e => e.id !== id);
  } catch(e) { console.warn('Delete exercise failed:', e.message); }
}

// ── ROUTINES ─────────────────────────────────────────────
async function dbSaveRoutine(routine) {
  try {
    setSyncStatus('syncing');
    const row = {
      id: routine.id, user_id: USER_ID, name: routine.name,
      exercises: routine.exercises,
      created_at: new Date(routine.createdAt).toISOString(),
      updated_at: new Date().toISOString(),
    };
    await supabaseFetch('routines', 'on_conflict=id', 'POST', row);
    const idx = _routines.findIndex(r => r.id === routine.id);
    if (idx >= 0) _routines[idx] = routine; else _routines.push(routine);
    setSyncStatus('ok');
  } catch(e) {
    console.warn('Save routine failed:', e.message);
    setSyncStatus('offline');
    showToast('⚠ Save failed: ' + e.message);
  }
}

async function dbDeleteRoutine(id) {
  try {
    setSyncStatus('syncing');
    await supabaseFetch(`routines?id=eq.${id}&user_id=eq.${USER_ID}`, '', 'DELETE');
    _routines = _routines.filter(r => r.id !== id);
    setSyncStatus('ok');
  } catch(e) { console.warn('Delete routine failed:', e.message); setSyncStatus('offline'); }
}

async function supabaseFetch(table, params = '', method = 'GET', body = null) {
  const authKey = `sb-fzbovpdnpvsfdnxyftqv-auth-token`;
  let token = SUPA_KEY;
  try {
    const stored = localStorage.getItem(authKey);
    if (stored) {
      const parsed = JSON.parse(stored);
      token = parsed.access_token || parsed[0]?.access_token || SUPA_KEY;
    }
  } catch(e) { /* use anon key */ }

  // Split table from params if params contains on_conflict (upsert)
  const isUpsert = params.includes('on_conflict');
  const url = `${SUPA_URL}/rest/v1/${table}${params ? '?' + params : ''}`;

  const headers = {
    'apikey': SUPA_KEY,
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (method === 'POST' && isUpsert) {
    headers['Prefer'] = 'resolution=merge-duplicates,return=representation';
  } else if (method === 'POST') {
    headers['Prefer'] = 'return=representation';
  } else if (method === 'DELETE') {
    headers['Prefer'] = 'return=minimal';
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${table} ${method} failed: ${res.status} ${err}`);
  }
  return method === 'DELETE' ? null : res.json();
}

async function dbLoadRoutines() {
  try {
    const data = await supabaseFetch('routines', `select=*&user_id=eq.${USER_ID}&order=created_at`);

    if (data && data.length) {
      _routines = data.map(r => ({ id:r.id, name:r.name, exercises:r.exercises, createdAt:new Date(r.created_at).getTime() }));
      window.__routines = _routines; // debug
      console.log('dbLoadRoutines — first routine exercises:', JSON.stringify(_routines[0]?.exercises?.slice(0,2)));
    } else {
      try {
        for (const r of DEFAULT_ROUTINES) await dbSaveRoutine(r);
      } catch(e) {
        console.warn('Seed routines failed:', e.message);
        _routines = [...DEFAULT_ROUTINES];
      }
    }
    return _routines;
  } catch(e) { console.warn('Load routines failed:', e.message); return []; }
}

// ── SESSIONS ─────────────────────────────────────────────
async function dbSaveSession(session) {
  try {
    setSyncStatus('syncing');
    await supabaseFetch('sessions', 'on_conflict=id', 'POST', {
      id: session.id, user_id: USER_ID,
      routine_id: session.routineId || null,
      routine_name: session.routineName,
      started_at: new Date(session.startedAt).toISOString(),
      finished_at: session.duration ? new Date(session.startedAt + session.duration * 1000).toISOString() : null,
      duration: session.duration || null,
      exercises: session.exercises,
      is_active: !session.duration,
    });
    setSyncStatus('ok');
  } catch(e) { console.warn('Save session failed:', e.message); setSyncStatus('offline'); }
}

async function dbLoadSessions() {
  try {
    const data = await supabaseFetch('sessions', `select=*&is_active=eq.false&order=started_at`);
    if (data) {
      _sessions = data.map(s => ({
        id:s.id, routineId:s.routine_id, routineName:s.routine_name,
        startedAt:new Date(s.started_at).getTime(), duration:s.duration, exercises:s.exercises,
      }));
    }
    const list = document.getElementById('recent-list');
    if (list) renderHome();
    return _sessions;
  } catch(e) { console.warn('Load sessions failed:', e.message); return []; }
}

async function dbDeleteSession(id) {
  try {
    await supabaseFetch(`sessions?id=eq.${id}`, '', 'DELETE');
    if (error) throw error;
    _sessions = _sessions.filter(s => s.id !== id);
  } catch(e) { console.warn('Delete session failed:', e.message); }
}

async function dbLoadActiveSession() {
  try {
    const data = await supabaseFetch('sessions', `user_id=eq.${USER_ID}&is_active=eq.true&order=started_at.desc&limit=1`);
    if (data && data.length) {
      _activeSession = {
        id:data[0].id, routineId:data[0].routine_id, routineName:data[0].routine_name,
        startedAt:new Date(data[0].started_at).getTime(), exercises:data[0].exercises,
      };
    }
    return _activeSession;
  } catch(e) { console.warn('Load active session failed:', e.message); return null; }
}

// ── Main init sync ────────────────────────────────────────
async function syncFromCloud() {
  setSyncStatus('syncing');
  try {
    await dbLoadRoutines();
    await dbLoadSessions();
    await dbLoadExercises();
    setSyncStatus('ok');
  } catch(e) {
    console.error('syncFromCloud error:', e.message, e.stack);
    setSyncStatus('offline');
  }
}

// ═══════════════════════════════════════════
// DEFAULT ROUTINES (Dr. Swole's Program)
// ═══════════════════════════════════════════
const DEFAULT_ROUTINES = [
  {
    id: 'upper1', name: 'Upper 1', createdAt: Date.now(),
    exercises: [
      { id: 'e1', name: 'Bench Press', muscle: 'Chest', sets: 4, unilateral: false },
      { id: 'e2', name: 'Bent Row', muscle: 'Back', sets: 4, unilateral: false },
      { id: 'e3', name: 'Flys', muscle: 'Chest', sets: 4, unilateral: false },
      { id: 'e4', name: 'Pullovers', muscle: 'Back', sets: 4, unilateral: false },
      { id: 'e5', name: 'Upright Row', muscle: 'Shoulders', sets: 3, unilateral: false },
      { id: 'e6', name: 'Skullcrushers', muscle: 'Triceps', sets: 3, unilateral: false },
      { id: 'e7', name: 'Lateral Raises', muscle: 'Shoulders', sets: 3, unilateral: false },
    ]
  },
  {
    id: 'lower1', name: 'Lower 1', createdAt: Date.now(),
    exercises: [
      { id: 'e8', name: 'Goblet Squat', muscle: 'Quads', sets: 4, unilateral: false },
      { id: 'e9', name: 'Step-ups', muscle: 'Quads', sets: 4, unilateral: true },
      { id: 'e10', name: 'Walking Lunges', muscle: 'Quads', sets: 3, unilateral: false },
      { id: 'e11', name: 'RDL', muscle: 'Hamstrings', sets: 3, unilateral: false },
      { id: 'e12', name: 'Single Leg Calf Raise', muscle: 'Calves', sets: 5, unilateral: true },
      { id: 'e13', name: 'Hammer Curl', muscle: 'Biceps', sets: 2, unilateral: false },
      { id: 'e14', name: 'Paused Lateral Raise', muscle: 'Shoulders', sets: 2, unilateral: false },
      { id: 'e15', name: 'Dumbbell Curls', muscle: 'Biceps', sets: 3, unilateral: false },
    ]
  },
  {
    id: 'upper2', name: 'Upper 2', createdAt: Date.now(),
    exercises: [
      { id: 'e16', name: 'Dumbbell OHP', muscle: 'Shoulders', sets: 3, unilateral: false },
      { id: 'e17', name: 'Single Arm DB Row', muscle: 'Back', sets: 4, unilateral: true },
      { id: 'e18', name: 'Incline Bench Press', muscle: 'Chest', sets: 3, unilateral: false },
      { id: 'e19', name: 'Chest-Supported Row', muscle: 'Back', sets: 4, unilateral: false },
      { id: 'e20', name: 'Push Up', muscle: 'Chest', sets: 3, unilateral: false },
      { id: 'e21', name: 'Incline Skullcrushers', muscle: 'Triceps', sets: 3, unilateral: false },
      { id: 'e22', name: 'Lateral Raise', muscle: 'Shoulders', sets: 3, unilateral: false },
    ]
  },
  {
    id: 'lower2', name: 'Lower 2', createdAt: Date.now(),
    exercises: [
      { id: 'e23', name: 'Bulgarian Split Squat', muscle: 'Quads', sets: 4, unilateral: true },
      { id: 'e24', name: 'Step-ups', muscle: 'Quads', sets: 4, unilateral: true },
      { id: 'e25', name: 'Single Leg RDL', muscle: 'Hamstrings', sets: 3, unilateral: true },
      { id: 'e26', name: 'Single Leg Hip Thrust', muscle: 'Glutes', sets: 3, unilateral: true },
      { id: 'e27', name: 'Single Leg Calf Raise', muscle: 'Calves', sets: 5, unilateral: true },
      { id: 'e28', name: 'Lying Curl', muscle: 'Hamstrings', sets: 3, unilateral: false },
      { id: 'e29', name: 'Paused Lateral Raise', muscle: 'Shoulders', sets: 2, unilateral: false },
      { id: 'e30', name: 'Single Arm Preacher Curl', muscle: 'Biceps', sets: 2, unilateral: true },
    ]
  }
];

// ── Default global exercise library from Dr. Swole's program ──
const DEFAULT_EXERCISES = [
  { id: 'e1',  name: 'Bench Press',            muscle: 'Chest',     unilateral: false },
  { id: 'e2',  name: 'Bent Row',               muscle: 'Back',      unilateral: false },
  { id: 'e3',  name: 'Flys',                   muscle: 'Chest',     unilateral: false },
  { id: 'e4',  name: 'Pullovers',              muscle: 'Back',      unilateral: false },
  { id: 'e5',  name: 'Upright Row',            muscle: 'Shoulders', unilateral: false },
  { id: 'e6',  name: 'Skullcrushers',          muscle: 'Triceps',   unilateral: false },
  { id: 'e7',  name: 'Lateral Raises',         muscle: 'Shoulders', unilateral: false },
  { id: 'e8',  name: 'Goblet Squat',           muscle: 'Legs',      unilateral: false },
  { id: 'e9',  name: 'Step-ups',               muscle: 'Legs',      unilateral: true  },
  { id: 'e10', name: 'Walking Lunges',         muscle: 'Legs',      unilateral: false },
  { id: 'e11', name: 'RDL',                    muscle: 'Legs',      unilateral: false },
  { id: 'e12', name: 'Single Leg Calf Raise',  muscle: 'Legs',      unilateral: true  },
  { id: 'e13', name: 'Hammer Curl',            muscle: 'Biceps',    unilateral: false },
  { id: 'e14', name: 'Paused Lateral Raise',   muscle: 'Shoulders', unilateral: false },
  { id: 'e15', name: 'Dumbbell Curls',         muscle: 'Biceps',    unilateral: false },
  { id: 'e16', name: 'Dumbbell OHP',           muscle: 'Shoulders', unilateral: false },
  { id: 'e17', name: 'Single Arm DB Row',      muscle: 'Back',      unilateral: true  },
  { id: 'e18', name: 'Incline Bench Press',    muscle: 'Chest',     unilateral: false },
  { id: 'e19', name: 'Chest-Supported Row',    muscle: 'Back',      unilateral: false },
  { id: 'e20', name: 'Push Up',                muscle: 'Chest',     unilateral: false },
  { id: 'e21', name: 'Incline Skullcrushers',  muscle: 'Triceps',   unilateral: false },
  { id: 'e22', name: 'Lateral Raise',          muscle: 'Shoulders', unilateral: false },
  { id: 'e23', name: 'Bulgarian Split Squat',  muscle: 'Legs',      unilateral: true  },
  { id: 'e24', name: 'Single Leg RDL',         muscle: 'Legs',      unilateral: true  },
  { id: 'e25', name: 'Single Leg Hip Thrust',  muscle: 'Legs',      unilateral: true  },
  { id: 'e26', name: 'Lying Curl',             muscle: 'Legs',      unilateral: false },
  { id: 'e27', name: 'Single Arm Preacher Curl', muscle: 'Biceps',  unilateral: true  },
];

function initData() {
  // No-op — data is loaded from Supabase in syncFromCloud()
}

// ── Get last performance for an exercise across ALL sessions ──
function getLastPerformance(exName) {
  for (let i = _sessions.length - 1; i >= 0; i--) {
    const s = _sessions[i];
    const ex = (s.exercises || []).find(e => e.name === exName);
    if (ex && ex.sets && ex.sets.some(st => st.logged)) return ex.sets.filter(st => st.logged);
  }
  return null;
}

// ═══════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════
const MUSCLE_GROUPS = ['Abs','Back','Biceps','Chest','Legs','Shoulders','Triceps'];

// ═══════════════════════════════════════════
// NAV & PAGES
// ═══════════════════════════════════════════
function showPage(name, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  if (name === 'home')      renderHome();
  if (name === 'routines')  renderRoutines();
  if (name === 'exercises') renderExerciseLibrary();
  if (name === 'stats')     { initStatsPage(); renderStats(); }
}

// ═══════════════════════════════════════════
// MODALS
// ═══════════════════════════════════════════
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// ═══════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════
let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ═══════════════════════════════════════════
// CONFIRM DIALOG
// ═══════════════════════════════════════════
let confirmCb;
function showConfirm(title, text, cb) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-text').textContent = text;
  confirmCb = cb;
  document.getElementById('confirm-overlay').classList.add('open');
}
function closeConfirm() { document.getElementById('confirm-overlay').classList.remove('open'); }
function confirmOk() {
  closeConfirm();
  if (confirmCb) confirmCb();
}

// ═══════════════════════════════════════════
// HOME PAGE
// ═══════════════════════════════════════════
function renderHome() {
  const sessions = load(SK.sessions) || [];
  const recent = [...sessions].reverse(); // all sessions, newest first
  const list = document.getElementById('recent-list');

  const now = new Date();
  const hour = now.getHours();
  const greet = hour < 12 ? 'GOOD MORNING' : hour < 17 ? 'GOOD AFTERNOON' : 'GOOD EVENING';
  document.getElementById('home-greeting').textContent = greet;

  // Resume banner — show if there's an active session saved
  const heroEl = document.querySelector('.home-hero');
  const existingBanner = document.getElementById('resume-banner');
  if (existingBanner) existingBanner.remove();
  const savedActive = load(SK.activeSession);
  if (savedActive && !activeSession) {
    const banner = document.createElement('div');
    banner.className = 'resume-banner';
    banner.id = 'resume-banner';
    const dur = formatDuration(Math.floor((Date.now() - savedActive.startedAt) / 1000));
    banner.innerHTML = `
      <div class="resume-banner-text">
        <div class="resume-banner-title">⚡ Workout in progress</div>
        <div class="resume-banner-sub">${savedActive.routineName} · started ${dur} ago</div>
      </div>
      <button class="resume-btn" onclick="resumeWorkout()">RESUME</button>
    `;
    heroEl.parentNode.insertBefore(banner, heroEl);
  }

  if (recent.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">💪</div><div class="empty-state-text">No sessions yet</div></div>';
    return;
  }

  list.innerHTML = '';
  recent.forEach(s => {
    const totalSets = (s.exercises||[]).reduce((a,ex)=>a+(ex.sets||[]).filter(st=>st.logged).length, 0);
    const dur = s.duration ? formatDuration(s.duration) : '—';
    const dateStr = new Date(s.startedAt).toLocaleDateString('no-NO',{weekday:'short',day:'numeric',month:'short'});

    const item = document.createElement('div');
    item.className = 'recent-item';
    item.style.cursor = 'pointer';
    item.innerHTML = `
      <div class="recent-dot"></div>
      <div class="recent-info">
        <div class="recent-name">${s.routineName}</div>
        <div class="recent-meta">${dateStr} · ${dur}</div>
      </div>
      <div class="recent-right">
        <span class="recent-sets">${totalSets}</span>
        <span style="font-size:9px;color:var(--muted);">sets</span>
      </div>
      <button class="recent-delete" title="Delete">✕</button>`;

    item.querySelector('.recent-delete').addEventListener('click', e => {
      e.stopPropagation();
      showConfirm('Delete Session?', 'This will permanently remove this workout from your history.', async () => {
        _sessions = _sessions.filter(x => x.id !== s.id);
        await dbDeleteSession(s.id);
        renderHome();
        showToast('Session deleted');
      });
    });

    item.addEventListener('click', e => {
      if (e.target.classList.contains('recent-delete')) return;
      openSessionEditor(s.id);
    });

    list.appendChild(item);
  });
}

function openSessionEditor(sessionId) {
  const allSessions = load(SK.sessions)||[];
  const s = allSessions.find(x => x.id === sessionId);
  if (!s) return;
  const EQUIPMENT = ['Barbell','Dumbbell','Cable','Bodyweight','Machine'];

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(7,8,12,0.97);z-index:9999;display:flex;flex-direction:column;overflow:hidden;';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.08);flex-shrink:0;';
  const dateStr = new Date(s.startedAt).toLocaleDateString('no-NO',{weekday:'long',day:'numeric',month:'long'});
  header.innerHTML = `<div><div style="font-family:'Bebas Neue',sans-serif;font-size:20px;letter-spacing:2px;color:#f0ede8;">${s.routineName}</div><div style="font-size:11px;color:#4b5563;margin-top:2px;">${dateStr}</div></div>`;
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'background:none;border:none;color:#9ca3af;font-size:24px;cursor:pointer;padding:4px 8px;line-height:1;';
  closeBtn.addEventListener('click', () => overlay.remove());
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.style.cssText = 'overflow-y:auto;flex:1;padding:12px 16px;-webkit-overflow-scrolling:touch;';

  (s.exercises||[]).forEach((ex, ei) => {
    const logged = (ex.sets||[]).filter(st=>st.logged);
    const maxW = logged.length ? Math.max(...logged.map(st=>parseFloat(st.weight)||0)) : 0;
    const card = document.createElement('div');
    card.style.cssText = 'background:#151824;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px;margin-bottom:10px;';

    const exHeader = document.createElement('div');
    exHeader.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;';
    exHeader.innerHTML = `<div><div style="font-size:14px;font-weight:600;color:#d1d5db;">${ex.name}</div><div style="font-size:10px;color:#4b5563;margin-top:2px;">${ex.muscle||''} · ${logged.length} sets${maxW?` · best ${maxW}kg`:''}</div></div>`;

    const eqTag = document.createElement('span');
    eqTag.style.cssText = `font-size:10px;font-weight:600;padding:3px 9px;border-radius:12px;${ex.equipment?'color:var(--neon);background:rgba(0,180,255,0.1);border:1px solid rgba(0,180,255,0.2);':'color:#4b5563;'}`;
    eqTag.textContent = ex.equipment || 'Untagged';
    exHeader.appendChild(eqTag);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';

    EQUIPMENT.forEach(eq => {
      const btn = document.createElement('button');
      btn.textContent = eq;
      const isActive = ex.equipment === eq;
      btn.style.cssText = `padding:5px 12px;border-radius:16px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;border:1px solid ${isActive?'var(--neon)':'rgba(255,255,255,0.1)'};background:${isActive?'rgba(0,180,255,0.12)':'transparent'};color:${isActive?'var(--neon)':'#6b7280'};`;

      btn.addEventListener('click', async () => {
        ex.equipment = ex.equipment === eq ? null : eq;
        save(SK.sessions, allSessions);
        // Also update _sessions cache
        const cached = _sessions.find(x=>x.id===s.id);
        if (cached) { const cex=(cached.exercises||[]).find(e=>e.name===ex.name); if(cex) cex.equipment=ex.equipment; }
        await dbSaveSession(s);
        eqTag.textContent = ex.equipment || 'Untagged';
        eqTag.style.color = ex.equipment ? 'var(--neon)' : '#4b5563';
        eqTag.style.background = ex.equipment ? 'rgba(0,180,255,0.1)' : 'transparent';
        eqTag.style.border = ex.equipment ? '1px solid rgba(0,180,255,0.2)' : 'none';
        btnRow.querySelectorAll('button').forEach(b => {
          const active = b.textContent === ex.equipment;
          b.style.borderColor = active ? 'var(--neon)' : 'rgba(255,255,255,0.1)';
          b.style.background  = active ? 'rgba(0,180,255,0.12)' : 'transparent';
          b.style.color       = active ? 'var(--neon)' : '#6b7280';
        });
        // Save equipment pref
        const prefs = JSON.parse(localStorage.getItem('sg_eq_prefs')||'{}');
        prefs[ex.name] = ex.equipment;
        localStorage.setItem('sg_eq_prefs', JSON.stringify(prefs));
        showToast(ex.equipment ? `Tagged: ${ex.equipment}` : 'Tag removed');
      });
      btnRow.appendChild(btn);
    });

    card.appendChild(exHeader);
    card.appendChild(btnRow);
    body.appendChild(card);
  });

  overlay.appendChild(header);
  overlay.appendChild(body);
  document.body.appendChild(overlay);
}

function deleteSession(btn) {
  // Legacy — kept for safety
  showToast('Tap the session to edit or delete');
}

function resumeWorkout() {
  const saved = load(SK.activeSession);
  if (!saved) return;
  activeSession = saved;
  renderWorkoutPage();
  showPage('workout', document.getElementById('nav-workout'));
  startGlobalTimer();
}

// ═══════════════════════════════════════════
// WORKOUT PICKER
// ═══════════════════════════════════════════
function openWorkoutPicker() {
  const routines = load(SK.routines) || [];
  const list = document.getElementById('picker-routine-list');

  if (routines.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-text">No routines yet</div></div>';
  } else {
    list.innerHTML = routines.map(r => `
      <div class="routine-pick-item" onclick="startWorkout('${r.id}')">
        <div class="routine-pick-icon">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
        </div>
        <div>
          <div class="routine-pick-name">${r.name}</div>
          <div class="routine-pick-meta">${r.exercises.length} exercises</div>
        </div>
      </div>
    `).join('');
  }
  openModal('workout-picker');
}

// ═══════════════════════════════════════════
// ACTIVE WORKOUT
// ═══════════════════════════════════════════
let activeSession = null;
let globalTimerInterval = null;
// Per-set timers: keyed by "ei-si"
let setTimers = {}; // { "ei-si": { interval, startTime } }
// Active rest timer
let restTimer = { interval: null, startTime: null, el: null };

function startWorkout(routineId) {
  closeModal('workout-picker');
  const routines = load(SK.routines) || [];
  const routine = routines.find(r => r.id === routineId);
  if (!routine) return;

  activeSession = {
    id: Date.now(),
    routineId,
    routineName: routine.name,
    startedAt: Date.now(),
    duration: null,
    exercises: routine.exercises.map(ex => {
      const prevSets = getLastPerformance(ex.name) || [];
      return {
        id: ex.id,
        name: ex.name,
        muscle: ex.muscle,
        unilateral: ex.unilateral,
        startedAt: null,
        duration: null,
        collapsed: true,
        equipment: getEquipmentPref(ex.name),
        sets: Array.from({ length: ex.sets }, (_, i) => ({
          num: i + 1,
          weight: '', reps: '', repsL: '', repsR: '',
          note: prevSets[i] ? (prevSets[i].note || '') : '',
          logged: false, restDuration: null,
          setStartTime: null, setDuration: null,
          state: 'idle',
          ghostWeight: prevSets[i] ? (prevSets[i].weight || '') : '',
          ghostReps:   prevSets[i] ? (prevSets[i].reps   || '') : '',
          ghostRepsL:  prevSets[i] ? (prevSets[i].repsL  || '') : '',
          ghostRepsR:  prevSets[i] ? (prevSets[i].repsR  || '') : '',
        }))
      };
    })
  };

  setTimers = {};
  autoSaveSession();
  renderWorkoutPage();
  showPage('workout', document.getElementById('nav-workout'));
  startGlobalTimer();
}

function renderWorkoutPage() {
  if (!activeSession) return;
  document.getElementById('active-workout-name').textContent = activeSession.routineName;
  document.getElementById('active-workout-date').textContent =
    new Date(activeSession.startedAt).toLocaleDateString('no-NO', { weekday:'long', day:'numeric', month:'long' });
  renderWorkoutBody();
}

function renderWorkoutBody() {
  const body = document.getElementById('workout-body');
  body.innerHTML = '';
  activeSession.exercises.forEach((ex, ei) => {
    body.appendChild(buildExCard(ex, ei));
  });

  // Add exercise button at the bottom
  const addExBtn = document.createElement('button');
  addExBtn.className = 'btn btn-ghost';
  addExBtn.style.cssText = 'width:100%;margin:12px 0 4px;border:1.5px dashed rgba(0,180,255,0.3);color:var(--neon);letter-spacing:1px;';
  addExBtn.textContent = '+ ADD EXERCISE';
  addExBtn.addEventListener('click', () => openAddExerciseDuringWorkout());
  body.appendChild(addExBtn);

  attachDragHandles();
  activeSession.exercises.forEach((ex, ei) => {
    ex.sets.forEach((s, si) => {
      if (s.state === 'active' && s.setStartTime) startSetTimerDisplay(ei, si, s.setStartTime);
    });
  });
  if (restTimer.interval && restTimer.el) {
    const { ei, si } = restTimer;
    if (ei !== undefined) showRestBanner(ei, si, restTimer.startTime);
  }
}

// ── In-workout suggestion ─────────────────────────────────────────────────
function getExerciseSuggestion(exName, equipment, numSets) {
  const allSessions = load(SK.sessions)||[];
  const points = buildExercisePoints(allSessions, exName, equipment || null);
  if (!points.length) return null;
  const perSet = buildSetSuggestions(points, exName, equipment, numSets || 3);
  const prog   = assessProgression(points);
  const last   = points[points.length-1];
  const weights = points.map(p=>p.weight);
  return { perSet, prog, last, weights, points };
}

function buildSuggestionCard(ei, exName, equipment) {
  const ex      = activeSession?.exercises[ei];
  const numSets = ex?.sets?.length || 3;
  const data    = getExerciseSuggestion(exName, equipment, numSets);
  const card    = document.createElement('div');
  card.className = 'hint-card';
  card.id = 'hint-' + ei;

  if (!data || !data.perSet) {
    const hdr = document.createElement('div');
    hdr.className = 'hint-card-header';
    hdr.innerHTML = '<span class="hint-card-icon">💡</span><div class="hint-card-main"><div class="hint-card-suggestion" style="color:var(--muted2);">No history yet — log this session to start tracking</div></div>';
    card.appendChild(hdr);
    return card;
  }

  const { perSet, prog, last, weights } = data;
  const decisionColor = {
    step_up:     '#00ff96',
    consolidate: '#00b4ff',
    drop:        '#ff4466',
  }[perSet.overallDecision] || '#00b4ff';

  const decisionIcon = {
    step_up:     '↑',
    consolidate: '→',
    drop:        '↓',
  }[perSet.overallDecision] || '💡';

  const lastAgo = last.date ? (() => {
    const diff = Math.round((Date.now()-last.date.getTime())/(1000*60*60*24));
    return diff===0?'today':diff===1?'yesterday':diff+'d ago';
  })() : '';

  // ── Header (always visible) ───────────────────────────────────────────────
  const hdr = document.createElement('div');
  hdr.className = 'hint-card-header';

  const iconEl = document.createElement('span');
  iconEl.className = 'hint-card-icon';
  iconEl.style.color = decisionColor;
  iconEl.textContent = decisionIcon;

  const mainEl = document.createElement('div');
  mainEl.className = 'hint-card-main';

  const suggEl = document.createElement('div');
  suggEl.className = 'hint-card-suggestion';
  suggEl.textContent = perSet.summary;

  const subEl = document.createElement('div');
  subEl.className = 'hint-card-sub';
  subEl.textContent = perSet.subtext;

  mainEl.appendChild(suggEl);
  mainEl.appendChild(subEl);

  const chevEl = document.createElement('span');
  chevEl.className = 'hint-card-chevron';
  chevEl.textContent = '▾';

  hdr.appendChild(iconEl);
  hdr.appendChild(mainEl);
  hdr.appendChild(chevEl);
  card.appendChild(hdr);

  // ── Body: per-set table ───────────────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'hint-card-body';

  // Last session summary line
  const lastLine = document.createElement('div');
  lastLine.className = 'hint-last-line';
  lastLine.innerHTML = 'Last: <strong>' + last.bestLabel + '</strong>' + (lastAgo?' · '+lastAgo:'');
  body.appendChild(lastLine);

  // Per-set table
  if (perSet.sets && perSet.sets.length) {
    const table = document.createElement('div');
    table.style.cssText = 'margin-top:10px;display:flex;flex-direction:column;gap:4px;';

    // Show last session's actual sets alongside targets
    const lastPerSet = last.perSet || [];

    perSet.sets.forEach((s, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:grid;grid-template-columns:32px 1fr 1fr 20px;align-items:center;gap:6px;padding:5px 8px;background:rgba(255,255,255,0.03);border-radius:6px;font-size:11px;';

      const trendColor = s.trend==='↑'?'#00ff96':s.trend==='↓'?'#ff4466':'#6b7280';
      const repsStr    = s.repsMin===s.repsMax ? `${s.repsMin}` : `${s.repsMin}–${s.repsMax}`;
      const prevStr    = lastPerSet[i] ? `${lastPerSet[i].weight}kg×${lastPerSet[i].reps}` : '—';

      row.innerHTML =
        `<span style="color:var(--muted2);font-weight:600;">S${i+1}</span>` +
        `<span style="color:var(--muted2);font-size:10px;">${prevStr}</span>` +
        `<span style="color:#e8eaf0;font-weight:700;">${s.weight}kg × ${repsStr}</span>` +
        `<span style="color:${trendColor};font-weight:700;">${s.trend}</span>`;
      table.appendChild(row);
    });

    // Column header
    const colHdr = document.createElement('div');
    colHdr.style.cssText = 'display:grid;grid-template-columns:32px 1fr 1fr 20px;gap:6px;padding:0 8px;font-size:9px;color:var(--muted2);letter-spacing:0.08em;text-transform:uppercase;margin-bottom:2px;';
    colHdr.innerHTML = '<span></span><span>Last</span><span>Target</span><span></span>';
    table.insertBefore(colHdr, table.firstChild);

    body.appendChild(table);
  }

  card.appendChild(body);
  hdr.addEventListener('click', () => card.classList.toggle('collapsed'));
  return card;
}

function updateHintAfterSet(ei) {
  const card = document.getElementById('hint-' + ei);
  if (!card) return;
  const ex = activeSession?.exercises[ei];
  if (!ex) return;
  const logged = ex.sets.filter(s => s.state === 'logged');
  if (!logged.length) return;

  // Collapse after first logged set
  card.classList.add('collapsed');

  // Check vs per-set targets — update summary if beating targets
  const data = getExerciseSuggestion(ex.name, ex.equipment, ex.sets.length);
  if (!data?.perSet?.sets) return;

  const targets = data.perSet.sets;
  let beatingAll = true, anyBeat = false;
  logged.forEach((s, i) => {
    const tgt = targets[i];
    if (!tgt) return;
    const w = parseFloat(s.weight)||0;
    const r = ex.unilateral
      ? Math.max(parseFloat(s.repsL)||0, parseFloat(s.repsR)||0)
      : parseFloat(s.reps)||0;
    if (w >= tgt.weight && r >= tgt.repsMax) anyBeat = true;
    else beatingAll = false;
  });

  if (beatingAll && logged.length === ex.sets.length) {
    card.classList.add('hint-done');
    const sugg = card.querySelector('.hint-card-suggestion');
    if (sugg) sugg.textContent = '✓ All targets hit — great session!';
  } else if (anyBeat) {
    const sugg = card.querySelector('.hint-card-suggestion');
    if (sugg) sugg.style.color = '#00ff96';
  }
}

function buildExCard(ex, ei) {
  const logged = ex.sets.filter(s => s.state === 'logged').length;
  const total  = ex.sets.length;
  const isUni  = ex.unilateral;

  let setHeaderHTML = isUni
    ? `<div class="set-header-row unilateral"><span>#</span><span style="text-align:center">KG</span><span style="text-align:center">L</span><span style="text-align:center">R</span><span style="text-align:center">NOTE</span></div>`
    : `<div class="set-header-row bilateral"><span>#</span><span style="text-align:center">KG</span><span style="text-align:center">REPS</span><span style="text-align:center">NOTE</span></div>`;

  const setsHTML = ex.sets.map((s, si) => buildSetRow(s, si, ei, isUni)).join('');

  const EQUIPMENT = ['Barbell','Dumbbell','Cable','Bodyweight','Machine'];
  const eq = ex.equipment || null;
  const eqHTML = `<div class="eq-selector" id="eq-${ei}">
    ${EQUIPMENT.map(e => `<button class="eq-btn${eq===e?' active':''}" onclick="setEquipment(${ei},'${e}')">${e}</button>`).join('')}
  </div>`;

  // Build card as DOM element so we can inject the suggestion card
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `<div class="ex-card ${ex.collapsed ? 'collapsed' : ''}" id="ex-card-${ei}" data-ei="${ei}">
    <div class="ex-card-header">
      <span class="ex-drag-handle" data-ei="${ei}">⠿</span>
      <div class="ex-card-title" onclick="toggleExCollapse(${ei})">
        <div class="ex-card-name">${ex.name}</div>
        <div class="ex-card-meta" id="ex-meta-${ei}">${ex.muscle}${ex.unilateral?' · Uni':''} · ${logged}/${total} sets${eq?' · '+eq:''}</div>
      </div>
      <span class="ex-collapse-btn" onclick="toggleExCollapse(${ei})">▾</span>
    </div>
    <div class="ex-card-body" id="ex-body-${ei}">
      ${eqHTML}
      <div id="hint-slot-${ei}"></div>
      ${setHeaderHTML}
      <div id="sets-${ei}">${setsHTML}</div>
      <div class="ex-actions">
        <button class="btn btn-ghost btn-sm" onclick="addSet(${ei})">+ Set</button>
        <button class="btn btn-danger btn-sm" onclick="removeLastSet(${ei})">− Set</button>
      </div>
    </div>
  </div>`;

  const card = wrapper.firstElementChild;

  // Inject suggestion card into hint slot
  const slot = card.querySelector(`#hint-slot-${ei}`);
  if (slot) {
    const hintCard = buildSuggestionCard(ei, ex.name, ex.equipment);
    // Auto-collapse if sets already logged
    if (logged > 0) hintCard.classList.add('collapsed');
    slot.appendChild(hintCard);
  }

  return card;
}

function buildSetRow(s, si, ei, isUni) {
  const stateClass = s.state === 'active' ? 'set-active' : s.state === 'logged' ? 'set-logged' : '';
  const disabled   = s.state !== 'logged' ? '' : 'disabled'; // inputs editable after stop, locked after logged
  const isLogged   = s.state === 'logged';
  const isActive   = s.state === 'active';

  function gClass(val, ghost) {
    if (isLogged) return 'logged';
    if (val !== '' && val !== null && val !== undefined) return '';
    if (ghost !== '' && ghost !== null && ghost !== undefined) return 'ghost-only';
    return '';
  }
  function gPH(val, ghost, fb) {
    if (val !== '' && val !== null && val !== undefined) return val; // show value
    if (ghost !== '' && ghost !== null && ghost !== undefined) return ghost;
    return fb;
  }

  // Inputs always editable
  const inputDisabled = isLogged ? '' : '';
  const inputOpacity  = '';

  let btnLabel, btnClass;
  if (s.state === 'idle')   { btnLabel = 'START'; btnClass = 'state-idle'; }
  if (s.state === 'active') { btnLabel = 'STOP';  btnClass = 'state-active'; }
  if (s.state === 'logged') { btnLabel = '✓ Set done'; btnClass = 'state-logged'; }

  // Set duration badge
  const durBadge = s.setDuration
    ? `<span style="font-size:10px;color:var(--muted2);letter-spacing:1px;">${formatMMSS(s.setDuration)}</span>`
    : s.state === 'active'
    ? `<span id="set-timer-${ei}-${si}" style="font-size:10px;color:var(--neon);letter-spacing:1px;font-family:'Bebas Neue',sans-serif;">0:00</span>`
    : '';

  const inputs = isUni ? `
    <input class="set-input ${gClass(s.weight,s.ghostWeight)}" type="number" inputmode="decimal" min="0" step="0.5"
      value="${s.weight}" placeholder="${gPH(s.weight,s.ghostWeight,'kg')}" style="${inputOpacity}"
      ${inputDisabled} oninput="updateSet(${ei},${si},'weight',this.value)" onchange="updateSet(${ei},${si},'weight',this.value)"/>
    <input class="set-input ${gClass(s.repsL,s.ghostRepsL)}" type="number" inputmode="numeric" min="0"
      value="${s.repsL}" placeholder="${gPH(s.repsL,s.ghostRepsL,'L')}" style="${inputOpacity}"
      ${inputDisabled} oninput="updateSet(${ei},${si},'repsL',this.value)" onchange="updateSet(${ei},${si},'repsL',this.value)"/>
    <input class="set-input ${gClass(s.repsR,s.ghostRepsR)}" type="number" inputmode="numeric" min="0"
      value="${s.repsR}" placeholder="${gPH(s.repsR,s.ghostRepsR,'R')}" style="${inputOpacity}"
      ${inputDisabled} oninput="updateSet(${ei},${si},'repsR',this.value)" onchange="updateSet(${ei},${si},'repsR',this.value)"/>` : `
    <input class="set-input ${gClass(s.weight,s.ghostWeight)}" type="number" inputmode="decimal" min="0" step="0.5"
      value="${s.weight}" placeholder="${gPH(s.weight,s.ghostWeight,'kg')}" style="${inputOpacity}"
      ${inputDisabled} oninput="updateSet(${ei},${si},'weight',this.value)" onchange="updateSet(${ei},${si},'weight',this.value)"/>
    <input class="set-input ${gClass(s.reps,s.ghostReps)}" type="number" inputmode="numeric" min="0"
      value="${s.reps}" placeholder="${gPH(s.reps,s.ghostReps,'reps')}" style="${inputOpacity}"
      ${inputDisabled} oninput="updateSet(${ei},${si},'reps',this.value)" onchange="updateSet(${ei},${si},'reps',this.value)"/>`;

  return `<div class="set-row ${stateClass}" id="set-row-${ei}-${si}">
    <div class="set-row-top ${isUni?'unilateral':'bilateral'}">
      <div class="set-num">${si+1}</div>
      ${inputs}
    </div>
    <div class="set-note-row">
      <input class="set-note${s.note ? ' set-note--prefilled' : ''}" placeholder="note..." value="${s.note||''}"
        ${inputDisabled} onchange="updateSet(${ei},${si},'note',this.value)"/>
    </div>
    <div class="set-btn-row">
      <button class="set-start-btn ${btnClass}" onclick="handleSetBtn(${ei},${si})">${btnLabel}</button>
      ${durBadge}
    </div>
  </div>`;
}

// ── Set button handler: START → STOP (logged), next START clears rest ──
function handleSetBtn(ei, si) {
  if (!activeSession) return;
  const ex  = activeSession.exercises[ei];
  const set = ex.sets[si];

  if (set.state === 'idle') {
    // ── START ── clear rest timer, start set
    clearRestBanner();

    if (!ex.startedAt) ex.startedAt = Date.now();
    set.state = 'active';
    set.setStartTime = Date.now();
    startSetTimerDisplay(ei, si, set.setStartTime);

    dbSaveSession(activeSession);
    refreshSetRow(ei, si);

  } else if (set.state === 'active') {
    // ── STOP → immediately mark as logged, start rest timer ──
    const elapsed = Math.floor((Date.now() - set.setStartTime) / 1000);
    set.setDuration = elapsed;
    set.state  = 'logged';
    set.logged = true;

    stopSetTimerDisplay(ei, si);
    showRestBanner(ei, si, Date.now());

    dbSaveSession(activeSession);
    refreshSetRow(ei, si);
    updateExMeta(ei);
    updateHintAfterSet(ei);

  } else if (set.state === 'logged') {
    // Tap again to un-log
    set.state  = 'idle';
    set.logged = false;
    set.setStartTime = null;
    set.setDuration  = null;
    stopSetTimerDisplay(ei, si);
    dbSaveSession(activeSession);
    refreshSetRow(ei, si);
    updateExMeta(ei);
  }
}

// ── Set timer display ──────────────────────────────────────
function startSetTimerDisplay(ei, si, startTime) {
  const key = `${ei}-${si}`;
  if (setTimers[key]) clearInterval(setTimers[key].interval);
  setTimers[key] = {
    startTime,
    interval: setInterval(() => {
      const el = document.getElementById(`set-timer-${ei}-${si}`);
      if (!el) { clearInterval(setTimers[key]?.interval); return; }
      el.textContent = formatMMSS(Math.floor((Date.now() - startTime) / 1000));
    }, 1000)
  };
}

function stopSetTimerDisplay(ei, si) {
  const key = `${ei}-${si}`;
  if (setTimers[key]) { clearInterval(setTimers[key].interval); delete setTimers[key]; }
}

// ── Rest banner ───────────────────────────────────────────
function showRestBanner(ei, si, startTime) {
  clearRestBanner();
  restTimer.startTime = startTime;
  restTimer.ei = ei; restTimer.si = si;

  // Insert banner after the set row that just stopped
  const setRow = document.getElementById(`set-row-${ei}-${si}`);
  if (!setRow) return;

  const badge = document.getElementById('rest-timer-badge');
  const badgeTime = document.getElementById('rest-timer-badge-time');
  if (badge) badge.style.display = '';

  restTimer.interval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (badgeTime) badgeTime.textContent = formatMMSS(elapsed);
  }, 1000);
  restTimer.el = badge;
}

function clearRestBanner() {
  if (restTimer.interval) { clearInterval(restTimer.interval); restTimer.interval = null; }
  const badge = document.getElementById('rest-timer-badge');
  if (badge) { badge.style.display = 'none'; }
  const badgeTime = document.getElementById('rest-timer-badge-time');
  if (badgeTime) badgeTime.textContent = '0:00';
  restTimer.el = null; restTimer.startTime = null;
  restTimer.ei = undefined; restTimer.si = undefined;
}

// ── Refresh a single set row without re-rendering all ─────
function refreshSetRow(ei, si) {
  const ex  = activeSession.exercises[ei];
  const set = ex.sets[si];
  const rowEl = document.getElementById(`set-row-${ei}-${si}`);
  if (rowEl) rowEl.outerHTML = buildSetRow(set, si, ei, ex.unilateral);
  // If set just became active, start its timer
  if (set.state === 'active') startSetTimerDisplay(ei, si, set.setStartTime);
}

function updateExMeta(ei) {
  const ex  = activeSession.exercises[ei];
  const el  = document.getElementById(`ex-meta-${ei}`);
  if (el) el.textContent = `${ex.muscle}${ex.unilateral?' · Uni':''} · ${ex.sets.filter(s=>s.state==='logged').length}/${ex.sets.length} sets`;
}

function updateSet(ei, si, field, val) {
  if (!activeSession) return;
  activeSession.exercises[ei].sets[si][field] = val;
  autoSaveSession();
}

function openAddExerciseDuringWorkout() {
  const allEx = load(SK.exercises) || [];
  // Build a simple modal
  const overlay = document.createElement('div');
  overlay.id = 'add-ex-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(7,8,12,0.92);z-index:3000;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding:0 16px 40px;';

  const panel = document.createElement('div');
  panel.style.cssText = 'background:#151824;border:1px solid rgba(0,180,255,0.18);border-radius:16px;padding:20px;width:100%;max-width:420px;max-height:70vh;display:flex;flex-direction:column;';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;';
  header.innerHTML = `<div style="font-family:'Bebas Neue',sans-serif;font-size:18px;letter-spacing:2px;color:#fff;">ADD EXERCISE</div><button onclick="document.getElementById('add-ex-overlay').remove()" style="background:none;border:none;color:#6b7280;font-size:18px;cursor:pointer;">✕</button>`;

  // Search input
  const search = document.createElement('input');
  search.type = 'text'; search.placeholder = 'Search exercises…';
  search.style.cssText = 'background:#0d0f17;border:1px solid rgba(0,180,255,0.15);border-radius:8px;padding:10px 12px;font-size:13px;color:#f0ede8;font-family:inherit;outline:none;margin-bottom:10px;width:100%;';

  // Exercise list
  const list = document.createElement('div');
  list.style.cssText = 'overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:4px;';

  function renderList(filter='') {
    const filtered = allEx.filter(e => e.name.toLowerCase().includes(filter.toLowerCase()));
    list.innerHTML = '';
    if (!filtered.length) {
      list.innerHTML = `<div style="color:#4b5563;font-size:12px;padding:12px 0;text-align:center;">No exercises found</div>`;
    }
    filtered.forEach(ex => {
      const item = document.createElement('button');
      item.style.cssText = 'background:#0d0f17;border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:12px;text-align:left;cursor:pointer;color:#d1d5db;font-family:inherit;font-size:13px;';
      item.innerHTML = `<span style="font-weight:600;">${ex.name}</span><span style="color:#4b5563;font-size:10px;margin-left:8px;">${ex.muscle||''}</span>`;
      item.addEventListener('click', () => {
        addExerciseToWorkout(ex);
        overlay.remove();
      });
      list.appendChild(item);
    });
  }

  search.addEventListener('input', () => renderList(search.value));
  renderList();

  panel.appendChild(header);
  panel.appendChild(search);
  panel.appendChild(list);
  overlay.appendChild(panel);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  setTimeout(() => search.focus(), 100);
}

function addExerciseToWorkout(ex) {
  if (!activeSession) return;
  const prevSets = getLastPerformance(ex.name) || [];
  const numSets = prevSets.length || 3;
  activeSession.exercises.push({
    id: ex.id,
    name: ex.name,
    muscle: ex.muscle,
    unilateral: ex.unilateral,
    startedAt: null,
    duration: null,
    collapsed: false, // expand newly added exercise
    sets: Array.from({ length: numSets }, (_, i) => ({
      num: i+1,
      weight:'', reps:'', repsL:'', repsR:'', note:'',
      logged:false, restDuration:null,
      setStartTime:null, setDuration:null, state:'idle',
      ghostWeight: prevSets[i]?.weight||'',
      ghostReps:   prevSets[i]?.reps||'',
      ghostRepsL:  prevSets[i]?.repsL||'',
      ghostRepsR:  prevSets[i]?.repsR||'',
    }))
  });
  autoSaveSession();
  renderWorkoutBody();
  // Scroll to the new exercise
  setTimeout(() => {
    const cards = document.querySelectorAll('.ex-card');
    if (cards.length) cards[cards.length-1].scrollIntoView({ behavior:'smooth', block:'start' });
  }, 100);
}

function setEquipment(ei, equipment) {
  if (!activeSession) return;
  const ex = activeSession.exercises[ei];
  ex.equipment = ex.equipment === equipment ? null : equipment; // toggle off if same
  autoSaveSession();
  // Re-render just the equipment selector and meta
  const card = document.getElementById(`ex-card-${ei}`);
  if (card) {
    card.querySelectorAll('.eq-btn').forEach(btn => {
      btn.classList.toggle('active', btn.textContent === ex.equipment);
    });
    const meta = document.getElementById(`ex-meta-${ei}`);
    if (meta) meta.textContent = `${ex.muscle}${ex.unilateral?' · Uni':''} · ${ex.sets.filter(s=>s.state==='logged').length}/${ex.sets.length} sets${ex.equipment?' · '+ex.equipment:''}`;
  }
  // Remember last used equipment for this exercise
  const prefs = JSON.parse(localStorage.getItem('sg_eq_prefs')||'{}');
  prefs[ex.name] = ex.equipment;
  localStorage.setItem('sg_eq_prefs', JSON.stringify(prefs));
}

function getEquipmentPref(exName) {
  try { return JSON.parse(localStorage.getItem('sg_eq_prefs')||'{}')[exName] || null; } catch { return null; }
}

function addSet(ei) {
  if (!activeSession) return;
  const ex   = activeSession.exercises[ei];
  const prev = ex.sets[ex.sets.length - 1] || {};
  // Look up last performance for this new set index
  const lastPerf = getLastPerformance(ex.name) || [];
  const si = ex.sets.length;
  const lastSet = lastPerf[si] || null;
  ex.sets.push({
    num: si + 1,
    weight: '', reps: '', repsL: '', repsR: '',
    note: lastSet ? (lastSet.note || '') : '',
    logged: false, restDuration: null,
    setStartTime: null, setDuration: null, state: 'idle',
    ghostWeight: prev.weight || '', ghostReps: prev.reps || '',
    ghostRepsL: prev.repsL || '', ghostRepsR: prev.repsR || '',
  });
  autoSaveSession();
  const container = document.getElementById(`sets-${ei}`);
  if (container) {
    const newSi = ex.sets.length - 1;
    const div = document.createElement('div');
    div.innerHTML = buildSetRow(ex.sets[newSi], newSi, ei, ex.unilateral);
    container.appendChild(div.firstChild);
  }
  updateExMeta(ei);
}

function removeLastSet(ei) {
  if (!activeSession) return;
  const ex = activeSession.exercises[ei];
  if (ex.sets.length <= 1) return;
  const last = ex.sets.pop();
  stopSetTimerDisplay(ei, ex.sets.length);
  autoSaveSession();
  const container = document.getElementById(`sets-${ei}`);
  if (container && container.lastChild) container.removeChild(container.lastChild);
  updateExMeta(ei);
}

function toggleExCollapse(ei) {
  if (!activeSession) return;
  activeSession.exercises[ei].collapsed = !activeSession.exercises[ei].collapsed;
  const card = document.getElementById(`ex-card-${ei}`);
  if (card) card.classList.toggle('collapsed');
}

// ── Save current exercise list back to the routine ─────────
function saveRoutineChanges() {
  if (!activeSession || !activeSession.routineId) return;
  showConfirm(
    'Save Routine Changes?',
    'This will update the exercise list and order in the saved routine.',
    () => {
      const routines = load(SK.routines) || [];
      const idx = routines.findIndex(r => r.id === activeSession.routineId);
      if (idx < 0) { showToast('Routine not found'); return; }

      // Update exercises — keep original set counts from routine, just sync order/names
      routines[idx].exercises = activeSession.exercises.map(ex => ({
        id:         ex.id,
        name:       ex.name,
        muscle:     ex.muscle,
        unilateral: ex.unilateral,
        sets:       ex.sets.length,
      }));

      save(SK.routines, routines);
      dbSaveRoutine(routines[idx]);
      showToast('Routine updated ✓');
    }
  );
}

// ─── Global workout timer ───
function startGlobalTimer() {
  clearInterval(globalTimerInterval);
  globalTimerInterval = setInterval(() => {
    if (!activeSession) return;
    const elapsed = Math.floor((Date.now() - activeSession.startedAt) / 1000);
    document.getElementById('workout-global-timer').textContent = formatMMSS(elapsed);
  }, 1000);
}

function finishWorkout() {
  showConfirm('Finish Workout?', 'This will save your session and return you to the home screen.', async () => {
    if (!activeSession) return;
    activeSession.duration = Math.floor((Date.now() - activeSession.startedAt) / 1000);
    clearInterval(globalTimerInterval);
    clearRestBanner();
    Object.values(setTimers).forEach(t => clearInterval(t.interval));
    setTimers = {};

    // Finish exercise durations
    activeSession.exercises.forEach(ex => {
      if (ex.startedAt && !ex.duration) {
        ex.duration = Math.floor((Date.now() - ex.startedAt) / 1000);
      }
    });

    await dbSaveSession(activeSession);
    _activeSession = null;

    const completedSession = { ...activeSession };
    activeSession = null;

    // Add to in-memory sessions so home page shows it immediately
    _sessions.push({
      id: completedSession.id,
      routineId: completedSession.routineId,
      routineName: completedSession.routineName,
      startedAt: completedSession.startedAt,
      duration: completedSession.duration,
      exercises: completedSession.exercises,
    });

    showToast('Workout saved! 💪');
    showPage('home', document.getElementById('nav-home'));
    renderHome();

    // Offer Strava upload if connected
    if (stravaConnected) {
      setTimeout(() => showStravaUploadPrompt(completedSession), 800);
    }
  });
}

function autoSaveSession() {
  if (activeSession) {
    dbSaveSession(activeSession); // Supabase only
  }
}

// ─── Drag to reorder exercises ───
let dragSrc = null;

function attachDragHandles() {
  document.querySelectorAll('.ex-drag-handle').forEach(handle => {
    handle.addEventListener('touchstart', onHandleTouchStart, { passive: false });
  });
}

let dragCard = null, dragClone = null, dragStartY = 0, dragCardH = 0;

function onHandleTouchStart(e) {
  e.preventDefault();
  const ei = +e.currentTarget.dataset.ei;
  dragCard = document.getElementById(`ex-card-${ei}`);
  dragSrc = ei;
  dragStartY = e.touches[0].clientY;
  dragCardH = dragCard.offsetHeight;

  dragCard.style.opacity = '0.3';
  document.addEventListener('touchmove', onDragTouchMove, { passive: false });
  document.addEventListener('touchend', onDragTouchEnd);
}

function onDragTouchMove(e) {
  e.preventDefault();
  const y = e.touches[0].clientY;
  const cards = [...document.querySelectorAll('.ex-card')];
  cards.forEach((card, i) => {
    const rect = card.getBoundingClientRect();
    if (i !== dragSrc && y > rect.top && y < rect.bottom) {
      if (i < dragSrc) {
        card.parentNode.insertBefore(dragCard, card);
        // Reorder in state
        const ex = activeSession.exercises.splice(dragSrc, 1)[0];
        activeSession.exercises.splice(i, 0, ex);
        dragSrc = i;
        renderWorkoutBody();
        dragCard = document.getElementById(`ex-card-${dragSrc}`);
        dragCard.style.opacity = '0.3';
      } else {
        card.parentNode.insertBefore(dragCard, card.nextSibling);
        const ex = activeSession.exercises.splice(dragSrc, 1)[0];
        activeSession.exercises.splice(i, 0, ex);
        dragSrc = i;
        renderWorkoutBody();
        dragCard = document.getElementById(`ex-card-${dragSrc}`);
        dragCard.style.opacity = '0.3';
      }
    }
  });
}

function onDragTouchEnd() {
  document.removeEventListener('touchmove', onDragTouchMove);
  document.removeEventListener('touchend', onDragTouchEnd);
  if (dragCard) { dragCard.style.opacity = '1'; dragCard = null; }
  dragSrc = null;
  autoSaveSession();
  renderWorkoutBody();
}

// ═══════════════════════════════════════════
// ROUTINES PAGE
// ═══════════════════════════════════════════
let editingRoutineId = null;
let editorExercises = []; // exercises in the routine being edited
let pickerExIdx = null;   // which slot in editorExercises we're picking for (null = new)

function renderRoutines() {
  const routines = load(SK.routines) || [];
  const list = document.getElementById('routines-list');
  if (routines.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div><div class="empty-state-text">No routines yet</div></div>';
    return;
  }
  list.innerHTML = routines.map(r => `
    <div class="routine-card">
      <div class="routine-card-header" onclick="toggleRoutineCard(this.parentElement)">
        <div style="flex:1;">
          <div class="routine-card-name">${r.name}</div>
          <div class="routine-card-meta">${r.exercises.length} exercises</div>
        </div>
        <div class="routine-card-actions" onclick="event.stopPropagation()">
          <button onclick="openRoutineEditor('${r.id}')">✏️</button>
          <button onclick="deleteRoutine('${r.id}')">🗑</button>
        </div>
        <span class="routine-chevron">›</span>
      </div>
      <div class="routine-card-body">
        ${r.exercises.map(ex => `
          <div class="routine-ex-item">
            <div class="routine-ex-info">
              <div class="routine-ex-name">${ex.name}</div>
              <div class="routine-ex-tags">
                <span class="tag">${ex.muscle}</span>
                <span class="tag">${ex.sets} sets</span>
                ${ex.unilateral ? '<span class="tag unilateral">Unilateral</span>' : ''}
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

function toggleRoutineCard(card) {
  card.classList.toggle('open');
}

function openRoutineEditor(routineId) {
  editingRoutineId = routineId;
  editorExercises = [];

  if (routineId) {
    const routines = load(SK.routines) || [];
    const r = routines.find(r => r.id === routineId);
    if (r) {
      document.getElementById('re-name').value = r.name;
      editorExercises = r.exercises.map(ex => ({ ...ex }));
      document.getElementById('routine-editor-title').textContent = 'EDIT ROUTINE';
    }
  } else {
    document.getElementById('re-name').value = '';
    document.getElementById('routine-editor-title').textContent = 'NEW ROUTINE';
  }

  renderEditorExercises();
  openModal('routine-editor');
}

function renderEditorExercises() {
  const container = document.getElementById('re-exercises');
  if (editorExercises.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding:20px;"><div class="empty-state-text">No exercises yet</div></div>';
    return;
  }
  container.innerHTML = editorExercises.map((ex, i) => `
    <div class="routine-ex-item" style="flex-direction:row;align-items:center;gap:8px;" id="re-ex-${i}" data-rei="${i}">
      <span class="re-drag-handle" data-rei="${i}">⠿</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:500;color:var(--text);">${ex.name}</div>
        <div class="routine-ex-tags" style="margin-top:4px;">
          <span class="tag">${ex.muscle}</span>
          ${ex.unilateral ? '<span class="tag unilateral">Unilateral</span>' : ''}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
        <input type="number" value="${ex.sets}" min="1" max="20"
          style="width:40px;text-align:center;padding:6px 4px;"
          oninput="editorExercises[${i}].sets=Math.max(1,+this.value||1)"
          onchange="editorExercises[${i}].sets=Math.max(1,+this.value||1)"/>
        <span style="font-size:10px;color:var(--muted2);">sets</span>
      </div>
      <button class="btn-icon" onclick="removeEditorEx(${i})" style="color:var(--red);border-color:var(--red-dim);flex-shrink:0;">✕</button>
    </div>
  `).join('');

  // Attach touch drag to reorder
  attachEditorDragHandles();
}

// ── Drag to reorder exercises in routine editor ───────────
let reDragSrc = null, reDragEl = null;

function attachEditorDragHandles() {
  document.querySelectorAll('.re-drag-handle').forEach(h => {
    h.addEventListener('touchstart', onReDragStart, { passive: false });
  });
}

function onReDragStart(e) {
  e.preventDefault();
  reDragSrc = +e.currentTarget.dataset.rei;
  reDragEl = document.getElementById(`re-ex-${reDragSrc}`);
  reDragEl.style.opacity = '0.4';
  document.addEventListener('touchmove', onReDragMove, { passive: false });
  document.addEventListener('touchend', onReDragEnd);
}

function onReDragMove(e) {
  e.preventDefault();
  const y = e.touches[0].clientY;
  const items = [...document.querySelectorAll('[id^="re-ex-"]')];
  items.forEach((item, i) => {
    if (i === reDragSrc) return;
    const rect = item.getBoundingClientRect();
    if (y > rect.top && y < rect.bottom) {
      const moved = editorExercises.splice(reDragSrc, 1)[0];
      editorExercises.splice(i, 0, moved);
      reDragSrc = i;
      renderEditorExercises();
      reDragEl = document.getElementById(`re-ex-${reDragSrc}`);
      if (reDragEl) reDragEl.style.opacity = '0.4';
    }
  });
}

function onReDragEnd() {
  document.removeEventListener('touchmove', onReDragMove);
  document.removeEventListener('touchend', onReDragEnd);
  if (reDragEl) { reDragEl.style.opacity = '1'; reDragEl = null; }
  reDragSrc = null;
}

function addExerciseToEditor() {
  openExercisePicker(null);
}

function removeEditorEx(i) {
  editorExercises.splice(i, 1);
  renderEditorExercises();
}

// ── Exercise Picker ───────────────────────────────────────
let _pickerFiltered = []; // stored ref so onclick doesn't need JSON

function openExercisePicker(idx) {
  pickerExIdx = idx;
  document.getElementById('ex-picker-search').value = '';
  document.getElementById('ex-picker-sets').value = '3';
  document.getElementById('ex-picker-new-form').style.display = 'none';
  filterExPicker('');
  openModal('exercise-picker');
  setTimeout(() => document.getElementById('ex-picker-search').focus(), 100);
}

function filterExPicker(query) {
  const allEx = load(SK.exercises) || [];
  const q = query.toLowerCase().trim();
  _pickerFiltered = q ? allEx.filter(e => e.name.toLowerCase().includes(q)) : allEx;
  const results = document.getElementById('ex-picker-results');

  let html = _pickerFiltered.map((ex, i) => `
    <div class="ex-search-item" onclick="selectExerciseFromPicker(${i})">
      <span class="ex-search-item-name">${ex.name}</span>
      <span class="ex-search-item-muscle">${ex.muscle}${ex.unilateral ? ' · Uni' : ''}</span>
    </div>
  `).join('');

  const exactMatch = allEx.find(e => e.name.toLowerCase() === q);
  if (q && !exactMatch) {
    const safe = query.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    html += `<div class="ex-create-option" onclick="showNewExForm('${safe}')">
      <span>+</span> Create "<strong>${query}</strong>"
    </div>`;
  }

  results.innerHTML = html || '<div style="padding:10px 14px;font-size:11px;color:var(--muted);">No exercises found</div>';
}

function selectExerciseFromPicker(idx) {
  const ex = _pickerFiltered[idx];
  if (!ex) return;
  const sets = parseInt(document.getElementById('ex-picker-sets').value) || 3;
  addExToRoutine({ ...ex, sets });
}

function showNewExForm(name) {
  document.getElementById('ex-picker-new-form').style.display = 'block';
  document.getElementById('ex-picker-search').value = name;
  document.getElementById('ex-picker-muscle').value = '';
  document.getElementById('ex-picker-uni').checked = false;
  document.getElementById('ex-picker-results').innerHTML = '';
}

function hideNewExForm() {
  document.getElementById('ex-picker-new-form').style.display = 'none';
  filterExPicker(document.getElementById('ex-picker-search').value);
}

function createAndAddExercise_UNUSED1() { /* removed duplicate */ }

function addExToRoutine(ex) {
  if (pickerExIdx !== null) {
    editorExercises[pickerExIdx] = ex;
  } else {
    editorExercises.push(ex);
  }
  closeModal('exercise-picker');
  renderEditorExercises();
  const modal = document.getElementById('routine-editor');
  setTimeout(() => modal.scrollTop = modal.scrollHeight, 50);
}

function saveRoutine() {
  const name = document.getElementById('re-name').value.trim();
  if (!name) { showToast('Please enter a routine name'); return; }
  if (editorExercises.length === 0) { showToast('Add at least one exercise'); return; }

  const routines = load(SK.routines) || [];
  const routine = {
    id: editingRoutineId || 'r_' + Date.now(),
    name,
    createdAt: editingRoutineId ? (routines.find(r => r.id === editingRoutineId)?.createdAt || Date.now()) : Date.now(),
    exercises: editorExercises.map(ex => ({ ...ex, sets: Math.max(1, +ex.sets || 3) }))
  };

  if (editingRoutineId) {
    const idx = routines.findIndex(r => r.id === editingRoutineId);
    if (idx >= 0) routines[idx] = routine;
    else routines.push(routine);
  } else {
    routines.push(routine);
  }

  save(SK.routines, routines);
  dbSaveRoutine(routine);
  closeModal('routine-editor');
  renderRoutines();
  showToast('Routine saved!');
}

// ═══════════════════════════════════════════
// EXERCISE LIBRARY PAGE
// ═══════════════════════════════════════════
let libMuscleFilter = 'All';
let editingExId = null;
let selectedMuscle = '';

function renderExerciseLibrary() {
  const allEx = load(SK.exercises) || [];

  // Muscle filter chips
  const filterEl = document.getElementById('lib-muscle-filters');
  const filters = ['All', ...MUSCLE_GROUPS];
  filterEl.innerHTML = filters.map(m => `
    <button class="filter-btn ${libMuscleFilter === m ? 'active' : ''}"
      onclick="setLibFilter('${m}')">${m}</button>
  `).join('');

  // Exercise list
  const filtered = libMuscleFilter === 'All' ? allEx : allEx.filter(e => e.muscle === libMuscleFilter);
  const list = document.getElementById('exercises-list');

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🏋️</div><div class="empty-state-text">No exercises yet</div></div>';
    return;
  }

  // Group by muscle
  const groups = {};
  filtered.forEach(ex => {
    if (!groups[ex.muscle]) groups[ex.muscle] = [];
    groups[ex.muscle].push(ex);
  });

  list.innerHTML = Object.entries(groups).sort((a,b) => a[0].localeCompare(b[0])).map(([muscle, exs]) => `
    <div style="margin-bottom:16px;">
      <div class="section-title" style="margin-bottom:8px;">${muscle}</div>
      ${exs.map(ex => `
        <div class="ex-lib-item">
          <div class="ex-lib-info">
            <div class="ex-lib-name">${ex.name}</div>
            <div class="ex-lib-tags">
              ${ex.unilateral ? '<span class="tag unilateral">Unilateral</span>' : ''}
            </div>
          </div>
          <div class="ex-lib-actions">
            <button onclick="openExerciseLibEditor('${ex.id}')">✏️</button>
            <button onclick="deleteExerciseLib('${ex.id}')" style="color:var(--red)!important;">🗑</button>
          </div>
        </div>
      `).join('')}
    </div>
  `).join('');
}

function setLibFilter(muscle) {
  libMuscleFilter = muscle;
  renderExerciseLibrary();
}

function openExerciseLibEditor(exId) {
  editingExId = exId;
  selectedMuscle = '';

  // Clear fields first
  document.getElementById('ex-lib-name').value = '';
  document.getElementById('ex-lib-uni').checked = false;
  document.getElementById('ex-lib-editor-title').textContent = exId ? 'EDIT EXERCISE' : 'NEW EXERCISE';

  if (exId) {
    const allEx = load(SK.exercises) || [];
    const ex = allEx.find(e => e.id === exId);
    if (ex) {
      document.getElementById('ex-lib-name').value = ex.name;
      selectedMuscle = ex.muscle || '';
      // Set checkbox after muscle picker renders to avoid iOS DOM reflow reset
      const isUni = !!ex.unilateral;
      renderMusclePicker('ex-lib-muscle-grid');
      openModal('exercise-lib-editor');
      // Use setTimeout to set after the modal is fully painted
      setTimeout(() => {
        const cb = document.getElementById('ex-lib-uni');
        if (cb) {
          cb.checked = isUni;
          cb.defaultChecked = isUni;
        }
      }, 50);
      return;
    }
  }

  renderMusclePicker('ex-lib-muscle-grid');
  openModal('exercise-lib-editor');
}

function renderMusclePicker(containerId) {
  document.getElementById(containerId).innerHTML = MUSCLE_GROUPS.map(m => `
    <button class="muscle-chip ${selectedMuscle === m ? 'selected' : ''}"
      onclick="selectMuscle('${m}','${containerId}')">${m}</button>
  `).join('');
}

function selectMuscle(muscle, containerId) {
  selectedMuscle = muscle;
  renderMusclePicker(containerId);
}

function saveExerciseLib() {
  const name = document.getElementById('ex-lib-name').value.trim();
  const unilateral = document.getElementById('ex-lib-uni').checked;

  if (!name)           { showToast('Enter a name'); return; }
  if (!selectedMuscle) { showToast('Select a muscle group'); return; }

  const allEx = load(SK.exercises) || [];
  let savedEx;
  if (editingExId) {
    const idx = allEx.findIndex(e => e.id === editingExId);
    if (idx >= 0) { allEx[idx] = { ...allEx[idx], name, muscle: selectedMuscle, unilateral }; savedEx = allEx[idx]; }
  } else {
    savedEx = { id: 'ex_' + Date.now(), name, muscle: selectedMuscle, unilateral };
    allEx.push(savedEx);
  }
  save(SK.exercises, allEx);
  if (savedEx) dbSaveExercise(savedEx);
  closeModal('exercise-lib-editor');
  renderExerciseLibrary();
  showToast(editingExId ? 'Exercise updated' : 'Exercise created');
}

function deleteExerciseLib(exId) {
  showConfirm('Delete Exercise?', 'This removes it from the library. Existing sessions are unaffected.', () => {
    let allEx = load(SK.exercises) || [];
    allEx = allEx.filter(e => e.id !== exId);
    save(SK.exercises, allEx);
    renderExerciseLibrary();
    showToast('Exercise deleted');
  });
}

function deleteRoutine(id) {
  showConfirm('Delete Routine?', 'This cannot be undone.', () => {
    let routines = load(SK.routines) || [];
    routines = routines.filter(r => r.id !== id);
    save(SK.routines, routines);
    dbDeleteRoutine(id);
    renderRoutines();
    showToast('Routine deleted');
  });
}

// Also use muscle chip picker in exercise picker modal new form


function createAndAddExercise() {
  const name = document.getElementById('ex-picker-search').value.trim();
  const unilateral = document.getElementById('ex-picker-uni').checked;
  const sets = parseInt(document.getElementById('ex-picker-sets').value) || 3;

  if (!name)           { showToast('Enter an exercise name'); return; }
  if (!selectedMuscle) { showToast('Select a muscle group'); return; }

  const allEx = load(SK.exercises) || [];
  const newEx = { id: 'ex_' + Date.now(), name, muscle: selectedMuscle, unilateral };
  allEx.push(newEx);
  save(SK.exercises, allEx);
  dbSaveExercise(newEx);
  addExToRoutine({ ...newEx, sets });
}

// ═══════════════════════════════════════════
// ── EXERCISE PROGRESSION ENGINE ──────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
// EXERCISE PROGRESSION ENGINE — shared by Sterk Gutt + Calendar stats
// ═══════════════════════════════════════════════════════════════════════════

// Marius's dumbbell steps in kg
const DB_STEPS = [6, 10.5, 15, 19.5, 24, 28.5, 33, 40];

// Compound presses — expect more inter-set fatigue drop (allow 20%)
const COMPOUND_PRESS = ['Bench Press','Incline Bench Press','Dumbbell OHP','Push Up','Floor Press'];
// Compound pulls — allow 15% drop
const COMPOUND_PULL  = ['Bent Row','Single Arm DB Row','Chest-Supported Row','Bent-Over Row','Pull-up'];
// Isolation — flag if drop >10%
// Everything else is isolation by default

function nextDBStep(currentKg) {
  const i = DB_STEPS.findIndex(s => s >= currentKg);
  if (i === -1) return null;
  if (DB_STEPS[i] === currentKg) return DB_STEPS[i+1] ?? null;
  return DB_STEPS[i];
}

function prevDBStep(currentKg) {
  let idx = -1;
  for (let i = 0; i < DB_STEPS.length; i++) { if (DB_STEPS[i] <= currentKg) idx = i; }
  return idx > 0 ? DB_STEPS[idx-1] : null;
}

function linearTrend(values) {
  const n = values.length;
  if (n < 2) return 0;
  const xs = values.map((_, i) => i);
  const mx = xs.reduce((a,b)=>a+b,0)/n;
  const my = values.reduce((a,b)=>a+b,0)/n;
  const num = xs.reduce((a,x,i) => a + (x-mx)*(values[i]-my), 0);
  const den = xs.reduce((a,x)   => a + (x-mx)**2, 0);
  return den === 0 ? 0 : num/den;
}

// Get allowed fatigue drop for exercise type
function getFatigueTolerance(exName) {
  if (COMPOUND_PRESS.includes(exName)) return 0.20;
  if (COMPOUND_PULL.includes(exName))  return 0.15;
  return 0.10; // isolation
}

// Extract per-set data from a session for a specific exercise
function getSessionSets(session, exName, equipFilter) {
  const ex = (session.exercises||[]).find(e => {
    if (e.name !== exName) return false;
    if (equipFilter && equipFilter !== 'All' && (e.equipment||'') !== equipFilter) return false;
    return true;
  });
  if (!ex) return null;
  const logged = (ex.sets||[]).filter(s => s.logged);
  if (!logged.length) return null;
  return logged.map(s => ({
    weight: parseFloat(s.weight)||0,
    reps: ex.unilateral
      ? Math.max(parseFloat(s.repsL)||0, parseFloat(s.repsR)||0)
      : parseFloat(s.reps)||0,
    note: s.note||'',
  }));
}

function buildExercisePoints(sessions, exName, equipFilter) {
  const points = [];
  const sessionsInOrder = [...sessions].sort((a,b)=>
    new Date(a.startedAt||a.started_at) - new Date(b.startedAt||b.started_at));

  sessionsInOrder.forEach(s => {
    (s.exercises||[]).forEach(ex => {
      if (ex.name !== exName) return;
      if (equipFilter && equipFilter !== 'All' && (ex.equipment||'Unspecified') !== equipFilter) return;
      const logged = (ex.sets||[]).filter(st => st.logged);
      if (!logged.length) return;

      let bestW=0, bestR=0, best1RM=0;
      logged.forEach(st => {
        const w = parseFloat(st.weight)||0;
        const r = ex.unilateral
          ? Math.max(parseFloat(st.repsL)||0, parseFloat(st.repsR)||0)
          : parseFloat(st.reps)||0;
        const rm = r>0 ? w*(1+r/30) : 0;
        if (rm > best1RM) { best1RM=rm; bestW=w; bestR=r; }
      });

      const volLoad = Math.round(logged.reduce((a,st)=>{
        const w=parseFloat(st.weight)||0;
        const r=ex.unilateral?((parseFloat(st.repsL)||0)+(parseFloat(st.repsR)||0)):parseFloat(st.reps)||0;
        return a+w*r;
      },0));

      const startedAt = s.startedAt||s.started_at;
      points.push({
        date: new Date(startedAt),
        dateStr: new Date(startedAt).toLocaleDateString('no-NO',{day:'numeric',month:'short'}),
        weight: bestW, reps: bestR, sets: logged.length,
        est1RM: Math.round(best1RM*10)/10, volLoad,
        bestLabel: bestW>0 ? `${bestW}kg×${bestR}` : '—',
        equipment: ex.equipment||null,
        // Store full per-set data for hypertrophy logic
        perSet: logged.map(st => ({
          weight: parseFloat(st.weight)||0,
          reps: ex.unilateral
            ? Math.max(parseFloat(st.repsL)||0, parseFloat(st.repsR)||0)
            : parseFloat(st.reps)||0,
        })),
      });
    });
  });
  return points;
}

function assessProgression(points) {
  if (points.length < 2) return { status:'insufficient', trendPerMonth:0, plateau:false };
  const weights = points.map(p=>p.weight);
  const slopePerSession = linearTrend(weights);
  const trendPerMonth = Math.round(slopePerSession * 4 * 10) / 10;
  const last3 = points.slice(-3);
  const last3Weights = last3.map(p=>p.weight);
  const plateau = last3.length >= 3 && Math.max(...last3Weights) - Math.min(...last3Weights) < 1;
  const regressing = last3.length >= 3 && last3Weights[last3Weights.length-1] < last3Weights[0] - 0.5;
  let status = 'progressing';
  if (regressing) status = 'regressing';
  else if (plateau) status = 'plateau';
  else if (slopePerSession <= 0.01) status = 'plateau';
  return { status, trendPerMonth, plateau, regressing };
}

// ── HYPERTROPHY PER-SET SUGGESTION ENGINE ────────────────────────────────────
//
// Rules:
// 1. Default rep range: 8–12 (override per exercise type)
// 2. Stay at weight until ALL sets hit top of range
// 3. 2-for-2: only step up after 2 consecutive sessions hitting top on ALL sets
// 4. Fatigue tolerance: allow % drop from set 1 without flagging
// 5. If any set is below bottom of range: too heavy → consider dropping weight
//
function buildSetSuggestions(points, exName, equipment, numSets) {
  if (!points.length) return null;

  const isDB       = !equipment || equipment === 'Dumbbell';
  const isCompound = COMPOUND_PRESS.includes(exName) || COMPOUND_PULL.includes(exName);
  const fatigueTol = getFatigueTolerance(exName);

  // Rep range — compounds tend to be 6–10, isolation 10–15
  const repMin = isCompound ? 6  : 8;
  const repMax = isCompound ? 10 : 12;

  const last     = points[points.length - 1];
  const prevLast = points.length >= 2 ? points[points.length - 2] : null;

  const lastSets  = last.perSet  || [];
  const prevSets  = prevLast?.perSet || [];

  if (!lastSets.length) return buildNextSessionSuggestion(points, exName, equipment);

  // ── Check 2-for-2 readiness ───────────────────────────────────────────────
  function allSetsHitTop(perSet) {
    if (!perSet.length) return false;
    return perSet.every(s => s.reps >= repMax);
  }
  const lastHitTop = allSetsHitTop(lastSets);
  const prevHitTop = prevSets.length ? allSetsHitTop(prevSets) : false;
  const twoForTwo  = lastHitTop && prevHitTop;

  // ── Check if weight is too heavy (set 1 below repMin) ────────────────────
  const set1Reps   = lastSets[0]?.reps || 0;
  const tooHeavy   = set1Reps > 0 && set1Reps < repMin;

  // ── Check intra-session fatigue pattern ───────────────────────────────────
  const set1W      = lastSets[0]?.weight || last.weight;
  const maxDrop    = Math.floor(set1Reps * fatigueTol);

  // ── Determine next weight ─────────────────────────────────────────────────
  const currentW  = lastSets[0]?.weight || last.weight;
  const nextStep  = isDB ? nextDBStep(currentW) : currentW + 2;
  const prevStep  = isDB ? prevDBStep(currentW) : currentW - 2;
  const stepGap   = nextStep ? nextStep - currentW : null;
  const bigJump   = stepGap && stepGap > 6;

  // ── Build per-set targets ─────────────────────────────────────────────────
  const n = numSets || Math.max(lastSets.length, 3);

  let overallDecision; // 'step_up' | 'consolidate' | 'drop'
  if (tooHeavy)    overallDecision = 'drop';
  else if (twoForTwo) overallDecision = 'step_up';
  else             overallDecision = 'consolidate';

  const sets = [];
  for (let i = 0; i < n; i++) {
    const prev = lastSets[i] || lastSets[lastSets.length - 1] || { weight: currentW, reps: repMin };

    if (overallDecision === 'step_up') {
      // Step up — expect reps to drop back toward bottom of range
      const targetW    = nextStep || currentW;
      // Compound press big jump: back off reps more
      const repDrop    = bigJump && COMPOUND_PRESS.includes(exName) ? 3 : 2;
      const targetReps = Math.max(repMin, prev.reps - repDrop - i); // fatigue per set
      sets.push({ weight: targetW, repsMin: Math.max(repMin, targetReps-1), repsMax: targetReps+1,
        trend: '↑', note: i===0 ? `Step up from ${currentW}kg` : '' });

    } else if (overallDecision === 'drop') {
      const targetW    = prevStep || currentW;
      const targetReps = Math.min(repMax - 1, prev.reps + 2);
      sets.push({ weight: targetW, repsMin: targetReps, repsMax: Math.min(repMax, targetReps+2),
        trend: '↓', note: i===0 ? `Too heavy at ${currentW}kg — drop down` : '' });

    } else {
      // Consolidate — same weight, try to add 1 rep where possible
      const targetW = prev.weight || currentW;
      let targetReps;
      if (prev.reps >= repMax) {
        targetReps = repMax; // already there, hold
      } else if (prev.reps < repMin) {
        targetReps = repMin; // below floor, get to minimum
      } else {
        // Add 1 rep unless set dropped due to normal fatigue
        const expectedDrop = Math.floor((lastSets[0]?.reps || prev.reps) * fatigueTol);
        const normalFatigue = i > 0 && (lastSets[0]?.reps || 0) - prev.reps <= expectedDrop;
        targetReps = normalFatigue ? prev.reps + 1 : prev.reps + 1;
      }
      const atTop = targetReps >= repMax;
      sets.push({
        weight: targetW,
        repsMin: Math.min(targetReps, repMax),
        repsMax: Math.min(targetReps + 1, repMax),
        trend: atTop ? '→' : '↑',
        note: '',
      });
    }
  }

  // ── Summary line ──────────────────────────────────────────────────────────
  let summary, subtext;
  if (overallDecision === 'step_up') {
    summary = `Step up to ${nextStep}kg — you hit ${repMax}+ reps ${twoForTwo ? 'two sessions running' : 'last session'}`;
    subtext = bigJump ? `Big jump (+${stepGap}kg) — expect reps to drop` : `Aim for ${repMin}–${repMax} reps at the new weight`;
  } else if (overallDecision === 'drop') {
    summary = `Drop to ${prevStep||currentW}kg — ${set1Reps} reps on set 1 is below the floor`;
    subtext = `Build back to ${repMin}–${repMax} reps before stepping up again`;
  } else if (lastHitTop) {
    summary = `Hold ${currentW}kg — hit top range last session, one more to confirm`;
    subtext = `Hit ${repMax}+ reps again this session to earn the step up`;
  } else {
    const worstSet = lastSets.reduce((a,b) => b.reps<a.reps?b:a, lastSets[0]);
    summary = `Hold ${currentW}kg — add 1 rep where possible`;
    subtext = worstSet.reps < repMin
      ? `Set dropped to ${worstSet.reps} reps — focus on consistency first`
      : `Closing in on ${repMax} reps across all sets`;
  }

  return { sets, summary, subtext, overallDecision, repMin, repMax, currentW };
}

function buildNextSessionSuggestion(points, exName, equipment) {
  // Kept for backwards compatibility — wraps buildSetSuggestions into single-line format
  if (!points.length) return null;
  const result = buildSetSuggestions(points, exName, equipment, points[points.length-1]?.sets || 3);
  if (!result) return null;
  if (result.sets) {
    // Convert to single suggestion string
    return { suggestion: result.summary, subtext: result.subtext };
  }
  return result;
}

function renderExerciseAnalysis(container, points, exName, equipment) {
  // Clears container and renders full analysis
  container.innerHTML = '';
  if (!points.length) {
    container.innerHTML = `<div style="color:var(--muted2);font-size:12px;padding:12px 0;text-align:center;">No data for ${exName}.</div>`;
    return;
  }
  if (points.length === 1) {
    renderSingleSessionCard(container, points[0], exName, equipment);
    return;
  }

  const prog = assessProgression(points);
  const hint = buildNextSessionSuggestion(points, exName, equipment);
  const first = points[0], last = points[points.length-1];
  const rmChange = first.est1RM>0 ? ((last.est1RM-first.est1RM)/first.est1RM*100).toFixed(1) : null;

  // Status config
  const statusMap = {
    progressing: { icon:'↑', label:'Progressing',  color:'#00ff96', bg:'rgba(0,255,150,0.10)' },
    plateau:     { icon:'→', label:'Plateauing',    color:'#f0c060', bg:'rgba(240,192,96,0.12)' },
    regressing:  { icon:'↓', label:'Regressing',   color:'#ff4466', bg:'rgba(255,68,102,0.12)' },
    insufficient:{ icon:'?', label:'Not enough data',color:'#6b7280',bg:'rgba(255,255,255,0.05)' },
  };
  const st = statusMap[prog.status];

  // ── KPI row ──────────────────────────────────────────────────────────────
  const kpiRow = document.createElement('div');
  kpiRow.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px;';
  [
    {val:last.weight+'kg', lbl:'Last top weight', color:'#00b4ff'},
    {val:last.est1RM+'kg', lbl:'Est. 1RM',        color:'#00ffcc'},
    {val:points.length,    lbl:'Sessions',         color:'#7c6aff'},
  ].forEach(k=>{
    const c=document.createElement('div');
    c.style.cssText='background:rgba(0,0,0,0.06);border-radius:10px;padding:10px 8px;text-align:center;';
    c.innerHTML=`<div style="font-size:20px;font-weight:800;color:${k.color};font-variant-numeric:tabular-nums;">${k.val}</div><div style="font-size:9px;color:var(--muted2);text-transform:uppercase;letter-spacing:1px;margin-top:3px;">${k.lbl}</div>`;
    kpiRow.appendChild(c);
  });
  container.appendChild(kpiRow);

  // ── Status badge ─────────────────────────────────────────────────────────
  const badge = document.createElement('div');
  badge.style.cssText = `display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:8px;font-size:12px;font-weight:700;margin-bottom:8px;background:${st.bg};color:${st.color};`;
  badge.innerHTML = `${st.icon} ${st.label}`;
  if (prog.trendPerMonth !== 0 && prog.status !== 'insufficient') {
    const sign = prog.trendPerMonth > 0 ? '+' : '';
    badge.innerHTML += ` <span style="font-weight:400;font-size:11px;opacity:0.8;">${sign}${prog.trendPerMonth}kg/month</span>`;
  }
  container.appendChild(badge);

  // ── Weight comparison ─────────────────────────────────────────────────────
  if (first.weight !== last.weight) {
    const diff = (last.weight - first.weight).toFixed(1);
    const sign = diff > 0 ? '+' : '';
    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:11px;color:var(--muted2);margin-bottom:14px;';
    meta.textContent = `Top weight: ${first.weight}kg → ${last.weight}kg (${sign}${diff}kg) over ${points.length} sessions`;
    container.appendChild(meta);
  }

  // ── Weight sparkline ─────────────────────────────────────────────────────
  const sparkTitle = document.createElement('div');
  sparkTitle.style.cssText = 'font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted2);margin-bottom:6px;';
  sparkTitle.textContent = 'Best set weight per session (kg)';
  container.appendChild(sparkTitle);

  const sparkWrap = document.createElement('div');
  sparkWrap.style.cssText = 'position:relative;width:100%;height:90px;overflow:hidden;margin-bottom:4px;';
  const sparkCanvas = document.createElement('canvas');
  sparkCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;';
  sparkWrap.appendChild(sparkCanvas);
  container.appendChild(sparkWrap);

  // Dots below sparkline showing best set label
  const dotRow = document.createElement('div');
  dotRow.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:16px;';
  points.forEach((p,i)=>{
    const show = points.length<=6 || i===0 || i===points.length-1 || i%Math.ceil(points.length/6)===0;
    if(!show) return;
    const dot=document.createElement('div');
    dot.style.cssText='font-size:9px;color:var(--muted2);text-align:center;flex:1;';
    dot.innerHTML=`<div style="font-weight:600;color:var(--text);">${p.bestLabel}</div><div>${p.dateStr}</div>`;
    dotRow.appendChild(dot);
  });
  container.appendChild(dotRow);

  // ── Est 1RM chart ─────────────────────────────────────────────────────────
  const rmTitle = document.createElement('div');
  rmTitle.style.cssText = 'font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted2);margin-bottom:6px;';
  rmTitle.textContent = 'Estimated 1RM trend';
  container.appendChild(rmTitle);

  const rmWrap = document.createElement('div');
  rmWrap.style.cssText = 'position:relative;width:100%;height:110px;overflow:hidden;margin-bottom:16px;';
  const rmCanvas = document.createElement('canvas');
  rmCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;';
  rmWrap.appendChild(rmCanvas);
  container.appendChild(rmWrap);

  // ── Next session suggestion ───────────────────────────────────────────────
  if (hint) {
    const hintCard = document.createElement('div');
    hintCard.style.cssText = 'background:rgba(0,180,255,0.08);border:1px solid rgba(0,180,255,0.2);border-radius:12px;padding:14px 16px;margin-bottom:14px;';
    hintCard.innerHTML = `
      <div style="font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#00b4ff;font-weight:700;margin-bottom:6px;">Next session</div>
      <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:4px;">${hint.suggestion}</div>
      <div style="font-size:11px;color:var(--muted2);">${hint.subtext}</div>`;
    container.appendChild(hintCard);
  }

  // Draw charts after DOM paint
  setTimeout(() => {
    if (sparkCanvas.offsetWidth) {
      drawProgressLine(sparkCanvas, points.map(p=>p.dateStr), points.map(p=>p.weight), '#00b4ff', true);
    }
    if (rmCanvas.offsetWidth) {
      drawProgressLine(rmCanvas, points.map(p=>p.dateStr), points.map(p=>p.est1RM), '#00ffcc', false);
    }
  }, 100);
}

function renderSingleSessionCard(container, point, exName, equipment) {
  const hint = buildNextSessionSuggestion([point], exName, equipment);
  container.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px;">
      <div style="background:rgba(0,0,0,0.06);border-radius:10px;padding:10px;text-align:center;"><div style="font-size:18px;font-weight:800;color:#00b4ff;">${point.weight}kg</div><div style="font-size:9px;color:var(--muted2);margin-top:2px;">TOP WEIGHT</div></div>
      <div style="background:rgba(0,0,0,0.06);border-radius:10px;padding:10px;text-align:center;"><div style="font-size:18px;font-weight:800;color:#00ffcc;">${point.est1RM}kg</div><div style="font-size:9px;color:var(--muted2);margin-top:2px;">EST. 1RM</div></div>
      <div style="background:rgba(0,0,0,0.06);border-radius:10px;padding:10px;text-align:center;"><div style="font-size:18px;font-weight:800;color:#7c6aff;">${point.bestLabel}</div><div style="font-size:9px;color:var(--muted2);margin-top:2px;">BEST SET</div></div>
    </div>
    <div style="font-size:10px;color:var(--muted2);margin-bottom:12px;text-align:center;">First session — do more to see trends</div>`;

  if (hint) {
    const hintCard = document.createElement('div');
    hintCard.style.cssText = 'background:rgba(0,180,255,0.08);border:1px solid rgba(0,180,255,0.2);border-radius:12px;padding:14px 16px;';
    hintCard.innerHTML = `
      <div style="font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#00b4ff;font-weight:700;margin-bottom:6px;">Next session</div>
      <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:4px;">${hint.suggestion}</div>
      <div style="font-size:11px;color:var(--muted2);">${hint.subtext}</div>`;
    container.appendChild(hintCard);
  }
}

function drawProgressLine(canvas, labels, data, color, showAnnotations) {
  const dpr = devicePixelRatio||1;
  canvas.width  = canvas.offsetWidth  * dpr;
  canvas.height = canvas.offsetHeight * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr,dpr);
  const w=canvas.offsetWidth, h=canvas.offsetHeight;
  const pad={top:12,right:12,bottom:22,left:38};
  const cW=w-pad.left-pad.right, cH=h-pad.top-pad.bottom;
  const n=data.length;
  const maxV=Math.max(...data)*1.05, minV=Math.min(...data)*0.95;
  const xS=i=>pad.left+(n===1?cW/2:i/(n-1)*cW);
  const yS=v=>pad.top+cH-((v-minV)/(maxV-minV||1))*cH;

  // Trend line
  const slope = linearTrend(data);
  if (n >= 3) {
    const y0=yS(data[0]+(0)*slope), y1=yS(data[0]+(n-1)*slope);
    ctx.strokeStyle='rgba(255,255,255,0.12)'; ctx.lineWidth=1.5; ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(xS(0),y0); ctx.lineTo(xS(n-1),y1); ctx.stroke();
    ctx.setLineDash([]);
  }

  // Grid
  [0,0.5,1].forEach(t=>{
    const y=pad.top+t*cH;
    ctx.strokeStyle='rgba(255,255,255,0.06)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(pad.left,y); ctx.lineTo(w-pad.right,y); ctx.stroke();
    ctx.fillStyle='rgba(255,255,255,0.35)'; ctx.font=`9px sans-serif`; ctx.textAlign='right';
    ctx.fillText(Math.round(maxV-t*(maxV-minV)), pad.left-4, y+3);
  });

  // Gradient fill
  const grad=ctx.createLinearGradient(0,pad.top,0,pad.top+cH);
  grad.addColorStop(0,color+'40'); grad.addColorStop(1,color+'00');
  ctx.fillStyle=grad;
  ctx.beginPath();
  data.forEach((v,i)=>i===0?ctx.moveTo(xS(i),yS(v)):ctx.lineTo(xS(i),yS(v)));
  ctx.lineTo(xS(n-1),pad.top+cH); ctx.lineTo(xS(0),pad.top+cH); ctx.closePath(); ctx.fill();

  // Line
  ctx.strokeStyle=color; ctx.lineWidth=2.5; ctx.lineJoin='round'; ctx.lineCap='round';
  ctx.beginPath();
  data.forEach((v,i)=>i===0?ctx.moveTo(xS(i),yS(v)):ctx.lineTo(xS(i),yS(v)));
  ctx.stroke();

  // Dots
  data.forEach((v,i)=>{
    ctx.fillStyle=color; ctx.beginPath(); ctx.arc(xS(i),yS(v),3.5,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.beginPath(); ctx.arc(xS(i),yS(v),1.5,0,Math.PI*2); ctx.fill();
  });

  // X labels
  ctx.fillStyle='rgba(255,255,255,0.3)'; ctx.textAlign='center'; ctx.font='8px sans-serif';
  const step=Math.max(1,Math.ceil(n/5));
  data.forEach((_,i)=>{ if(i%step===0||i===n-1) ctx.fillText(labels[i],xS(i),h-4); });
}


// STATS PAGE
// ═══════════════════════════════════════════
let volumeChartInstance = null;
let exerciseChartInstance = null;

// ── STATS STATE ──────────────────────────────────────────────────────────────
let _statsPreset = 'all';  // 'all' | '1w' | '1m' | '3m' | '6m' | '1y' | 'custom'
let _statsFrom = null, _statsTo = null;
let _statsSubtab = 'overview';

function initStatsPage() {
  // Build preset buttons
  const row = document.getElementById('stats-presets');
  if (!row) return;
  if (row.dataset.init) return;
  row.dataset.init = '1';
  const presets = [
    {key:'all', label:'All time'},
    {key:'1w',  label:'Last week'},
    {key:'1m',  label:'Last month'},
    {key:'3m',  label:'3 months'},
    {key:'6m',  label:'6 months'},
    {key:'1y',  label:'1 year'},
    {key:'custom', label:'Custom…'},
  ];
  presets.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'stats-preset-btn' + (_statsPreset===p.key?' active':'');
    btn.textContent = p.label;
    btn.dataset.key = p.key;
    btn.addEventListener('click', () => {
      _statsPreset = p.key;
      row.querySelectorAll('.stats-preset-btn').forEach(b=>b.classList.toggle('active',b.dataset.key===p.key));
      const customRow = document.getElementById('stats-custom-row');
      customRow.style.display = p.key==='custom' ? '' : 'none';
      if (p.key !== 'custom') renderStats();
    });
    row.appendChild(btn);
  });
}

function getStatsDates() {
  const now = new Date(); now.setHours(23,59,59,999);
  const allSessions = load(SK.sessions)||[];
  if (_statsPreset === 'all') {
    // Use earliest session date to today
    const earliest = allSessions.length
      ? new Date(Math.min(...allSessions.map(s=>new Date(s.startedAt).getTime())))
      : new Date();
    earliest.setHours(0,0,0,0);
    return { from: earliest, to: now };
  }
  if (_statsPreset === 'custom') {
    const fromEl = document.getElementById('stats-from');
    const toEl   = document.getElementById('stats-to');
    const from = fromEl?.value ? new Date(fromEl.value+'T00:00:00') : new Date(0);
    const to   = toEl?.value   ? new Date(toEl.value+'T23:59:59')   : now;
    return { from, to };
  }
  const days = {
    '1w':7,'1m':30,'3m':90,'6m':180,'1y':365
  }[_statsPreset]||90;
  const from = new Date(now); from.setDate(from.getDate()-days); from.setHours(0,0,0,0);
  return { from, to: now };
}

function applyCustomRange() {
  _statsPreset = 'custom';
  renderStats();
}

function setStatsSubtab(tab) {
  _statsSubtab = tab;
  document.querySelectorAll('.stats-subtab').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  ['overview','routines','exercise'].forEach(t=>{
    const el=document.getElementById('stats-tab-'+t);
    if(el) el.style.display=t===tab?'':'none';
  });
  renderStats();
}

function renderStats() {
  initStatsPage();
  const {from,to} = getStatsDates();
  const allSessions = load(SK.sessions)||[];
  const sessions = allSessions.filter(s=>{
    const d=new Date(s.startedAt); return d>=from && d<=to;
  });
  if (_statsSubtab==='overview') renderOverview(sessions, from, to);
  if (_statsSubtab==='routines') renderRoutineStats(sessions);
  if (_statsSubtab==='exercise') {
    populateExSelect();
    if (document.getElementById('ex-select')?.value) renderExerciseSection();
  }
}

function renderOverview(sessions, fromDate, toDate) {
  renderKPIs(sessions, fromDate, toDate);
  renderMuscleBars(sessions);
  renderWeeklyFreqChart(sessions, fromDate, toDate);
}



function renderMuscleBars(sessions) {
  const muscles = {};
  sessions.forEach(s => {
    (s.exercises||[]).forEach(ex => {
      const sets = (ex.sets||[]).filter(st=>st.logged).length;
      if (sets) muscles[ex.muscle||'Other'] = (muscles[ex.muscle||'Other']||0) + sets;
    });
  });
  const container = document.getElementById('muscle-bars');
  if (!container) return;
  const entries = Object.entries(muscles).sort((a,b)=>b[1]-a[1]);
  if (!entries.length) { container.innerHTML='<div style="color:var(--muted);font-size:11px;padding:8px 0;">No data yet</div>'; return; }
  const max = Math.max(...entries.map(e=>e[1]));
  container.innerHTML = entries.map(([m,v])=>`
    <div class="muscle-bar-row">
      <span class="muscle-bar-label">${m}</span>
      <div class="muscle-bar-track"><div class="muscle-bar-fill" style="width:${Math.round(v/max*100)}%"></div></div>
      <span class="muscle-bar-val">${v}</span>
    </div>`).join('');
}

function renderKPIs(sessions, fromDate, toDate) {
  const n = sessions.length;
  const allSets = sessions.reduce((a,s)=>a+(s.exercises||[]).reduce((b,ex)=>b+(ex.sets||[]).filter(st=>st.logged).length,0),0);
  const avgSets = n ? (allSets/n).toFixed(1) : 0;
  const totalVol = Math.round(sessions.reduce((a,s)=>a+calcSessionVolume(s),0));
  const totalDur = sessions.reduce((a,s)=>a+(s.duration||0),0);
  const avgDur = n ? Math.round(totalDur/n/60) : 0;

  // Sessions/week: count distinct calendar weeks that had sessions
  const weeksWithSessions = new Set(sessions.map(s=>{
    const d=new Date(s.startedAt);
    const mon=new Date(d); mon.setDate(d.getDate()-((d.getDay()+6)%7));
    return mon.toISOString().slice(0,10);
  }));
  const totalWeeks = weeksWithSessions.size || 1;
  const freq = (n / totalWeeks).toFixed(1);

  const grid = document.getElementById('stats-kpi-grid');
  if (!grid) return;
  grid.innerHTML = [
    {val:n,              lbl:'Sessions',       sub:'in period',         color:'#00b4ff'},
    {val:avgSets,        lbl:'Avg sets',        sub:'per session',       color:'#00ffcc'},
    {val:freq,           lbl:'Sessions/week',   sub:`over ${totalWeeks} active week${totalWeeks!==1?'s':''}`, color:'#f0a96e'},
    {val:avgDur+'m',     lbl:'Avg duration',    sub:'per session',       color:'#7c6aff'},
    {val:totalVol.toLocaleString()+'kg', lbl:'Total volume', sub:'sets×reps×kg', color:'#00ffcc'},
    {val:allSets,        lbl:'Total sets',      sub:'logged',            color:'#00b4ff'},
  ].map(k=>`
    <div class="stats-kpi-card">
      <div class="stats-kpi-val" style="color:${k.color}">${k.val}</div>
      <div class="stats-kpi-lbl">${k.lbl}</div>
      <div class="stats-kpi-sub">${k.sub}</div>
    </div>`).join('');
}

function renderRoutineStats(sessions) {
  const body = document.getElementById('stats-routines-body');
  if (!body) return;

  // Count sessions per routine
  const routineMap = {}; // routineId → { name, count, totalSets, totalVol, totalDur }
  sessions.forEach(s => {
    const key = s.routineId || s.routineName || 'Unknown';
    const name = s.routineName || s.routineId || 'Unknown';
    if (!routineMap[key]) routineMap[key] = { name, count:0, totalSets:0, totalVol:0, totalDur:0, sessions:[] };
    const sets=(s.exercises||[]).reduce((a,ex)=>a+(ex.sets||[]).filter(st=>st.logged).length,0);
    routineMap[key].count++;
    routineMap[key].totalSets+=sets;
    routineMap[key].totalVol+=calcSessionVolume(s);
    routineMap[key].totalDur+=(s.duration||0);
    routineMap[key].sessions.push(s);
  });

  const entries = Object.values(routineMap).sort((a,b)=>b.count-a.count);
  const maxCount = entries[0]?.count||1;

  if (!entries.length) {
    body.innerHTML='<div style="color:#6b7280;font-size:13px;padding:20px 0;text-align:center;">No sessions in this period.</div>';
    return;
  }

  body.innerHTML='';
  entries.forEach(r => {
    const avgSets = r.count ? (r.totalSets/r.count).toFixed(1) : 0;
    const avgDur  = r.count ? Math.round(r.totalDur/r.count/60) : 0;
    const pct = Math.round((r.count/maxCount)*100);
    const card = document.createElement('div');
    card.className = 'routine-stat-card';
    card.innerHTML = `
      <div class="routine-stat-name">${r.name}</div>
      <div class="routine-stat-meta">
        <div class="routine-stat-item"><span>${r.count}</span> sessions</div>
        <div class="routine-stat-item"><span>${avgSets}</span> avg sets</div>
        <div class="routine-stat-item"><span>${avgDur}m</span> avg duration</div>
        <div class="routine-stat-item"><span>${Math.round(r.totalVol/1000)}t</span> total vol</div>
      </div>
      <div class="routine-bar-track"><div class="routine-bar-fill" style="width:${pct}%"></div></div>`;
    // Tap to see routine progress
    card.addEventListener('click', () => showRoutineProgress(r));
    body.appendChild(card);
  });
}

function showRoutineProgress(routineData) {
  // Switch to exercise tab and show a routine-level progress view
  const body = document.getElementById('stats-routines-body');
  body.innerHTML = '';

  const back = document.createElement('button');
  back.style.cssText='background:none;border:none;color:var(--neon);font-size:13px;cursor:pointer;font-family:inherit;padding:0 0 16px;display:flex;align-items:center;gap:6px;';
  back.innerHTML='← Back to routines';
  back.addEventListener('click', () => { const {from,to}=getStatsDates(); const allS=load(SK.sessions)||[]; renderRoutineStats(allS.filter(s=>{const d=new Date(s.startedAt);return d>=from&&d<=to;})); });
  body.appendChild(back);

  const title=document.createElement('div');
  title.style.cssText='font-family:"Bebas Neue",sans-serif;font-size:20px;letter-spacing:2px;color:#e0ddd8;margin-bottom:16px;';
  title.textContent=routineData.name;
  body.appendChild(title);

  // Sessions per week bar chart
  const weekMap={};
  routineData.sessions.forEach(s=>{
    const d=new Date(s.startedAt);
    const mon=new Date(d); mon.setDate(d.getDate()-((d.getDay()+6)%7));
    const k=mon.toISOString().slice(0,10);
    weekMap[k]=(weekMap[k]||0)+1;
  });
  const sortedWks=Object.keys(weekMap).sort();
  const maxW=Math.max(...Object.values(weekMap),1);
  const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const freqCard=document.createElement('div'); freqCard.className='stat-card'; freqCard.style.marginBottom='12px';
  freqCard.innerHTML='<div class="stat-card-title">Sessions per week</div>';
  const chartWrap=document.createElement('div'); chartWrap.style.cssText='display:flex;align-items:flex-end;gap:4px;height:80px;';
  sortedWks.forEach(wk=>{
    const cnt=weekMap[wk];
    const h=Math.round((cnt/maxW)*72);
    const [,m]=wk.split('-');
    const col=document.createElement('div'); col.style.cssText='flex:1;display:flex;flex-direction:column;align-items:stretch;';
    const bar=document.createElement('div'); bar.style.cssText=`display:flex;flex-direction:column;justify-content:flex-end;height:72px;`;
    const fill=document.createElement('div'); fill.style.cssText=`height:${h}px;background:#00b4ff88;border-radius:2px 2px 0 0;`;
    bar.appendChild(fill);
    const lbl=document.createElement('div'); lbl.style.cssText='font-size:7px;color:#4b5563;text-align:center;margin-top:2px;overflow:hidden;';
    lbl.textContent=MONTHS[parseInt(m,10)-1];
    col.appendChild(bar); col.appendChild(lbl); chartWrap.appendChild(col);
  });
  freqCard.appendChild(chartWrap);
  body.appendChild(freqCard);

  // Volume trend
  const volCard=document.createElement('div'); volCard.className='stat-card'; volCard.style.marginBottom='12px';
  volCard.innerHTML='<div class="stat-card-title">Volume load per session (sets×reps×kg)</div>';
  const sortedSess=routineData.sessions.sort((a,b)=>new Date(a.startedAt)-new Date(b.startedAt));
  const volData=sortedSess.map(s=>Math.round(calcSessionVolume(s)));
  const volLabels=sortedSess.map(s=>new Date(s.startedAt).toLocaleDateString('no-NO',{day:'numeric',month:'short'}));
  const canWrap=document.createElement('div'); canWrap.style.cssText='position:relative;width:100%;height:140px;overflow:hidden;margin-top:8px;';
  const canvas=document.createElement('canvas'); canvas.style.cssText='position:absolute;top:0;left:0;width:100%;height:100%;';
  canWrap.appendChild(canvas); volCard.appendChild(canWrap); body.appendChild(volCard);
  setTimeout(()=>{ if(canvas.offsetWidth) drawLineChart(canvas.getContext('2d'),canvas,volLabels,volData,'#7c6aff'); },100);
}


function calcSessionVolume(s) {
  return (s.exercises||[]).reduce((a,ex) => a+(ex.sets||[]).reduce((b,st) => {
    if (!st.logged) return b;
    const w = parseFloat(st.weight)||0;
    const r = ex.unilateral ? ((parseFloat(st.repsL)||0)+(parseFloat(st.repsR)||0)) : (parseFloat(st.reps)||0);
    return b+w*r;
  },0),0);
}

function renderWeeklyFreqChart(sessions, fromDate, toDate) {
  const weeks = {};
  sessions.forEach(s => {
    const d = new Date(s.startedAt);
    const mon = new Date(d); mon.setDate(d.getDate()-((d.getDay()+6)%7));
    const key = mon.toISOString().slice(0,10);
    weeks[key] = (weeks[key]||0)+1;
  });
  const labels = Object.keys(weeks).sort();
  const data = labels.map(k => weeks[k]);
  // Defer draw so canvas has proper dimensions after paint
  setTimeout(() => {
    const canvas = document.getElementById('chart-volume');
    if (!canvas || !canvas.offsetWidth) return;
    const ctx = canvas.getContext('2d');
    drawBarChart(ctx, canvas, labels.map(l=>l.slice(5)), data, '#00b4ff');
  }, 100);
}

function populateExSelect() {
  const allEx = load(SK.exercises) || [];
  const sel = document.getElementById('ex-select');
  const current = sel.value;
  sel.innerHTML = '<option value="">— Select exercise —</option>' +
    allEx.sort((a,b)=>a.name.localeCompare(b.name)).map(e=>`<option value="${e.name}">${e.name}</option>`).join('');
  if (current) sel.value = current;
}

let _exEquipFilter = 'All';

function renderExerciseSection(equipFilter) {
  if (equipFilter !== undefined) _exEquipFilter = equipFilter;
  const exName = document.getElementById('ex-select')?.value;
  const body   = document.getElementById('exercise-progress-body');
  if (!body) return;
  if (!exName) { body.innerHTML = ''; return; }

  const {from: fromDate, to: toDate} = getStatsDates();
  const allSess = (load(SK.sessions)||[]).filter(s => {
    const d = new Date(s.startedAt); return d >= fromDate && d <= toDate;
  });

  // Collect equipment types for this exercise
  const equipSet = new Set(['All']);
  allSess.forEach(s => (s.exercises||[]).forEach(ex => {
    if (ex.name === exName) equipSet.add(ex.equipment||'Unspecified');
  }));
  const equipOptions = [...equipSet];

  // Build points using engine
  const points = buildExercisePoints(allSess, exName, _exEquipFilter === 'All' ? null : _exEquipFilter);
  const equipment = _exEquipFilter === 'All' ? (points[0]?.equipment||null) : _exEquipFilter;

  // Equipment filter pills
  const filterWrap = document.createElement('div');
  if (equipOptions.length > 1) {
    filterWrap.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;';
    equipOptions.forEach(e => {
      const btn = document.createElement('button');
      btn.textContent = e;
      const active = _exEquipFilter === e;
      btn.style.cssText = `padding:4px 12px;border-radius:20px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;border:1px solid ${active?'var(--neon)':'var(--border)'};background:${active?'rgba(0,180,255,0.12)':'var(--surface2)'};color:${active?'var(--neon)':'var(--muted2)'};`;
      btn.addEventListener('click', () => renderExerciseSection(e));
      filterWrap.appendChild(btn);
    });
  }

  body.innerHTML = '';
  body.appendChild(filterWrap);

  const analysisEl = document.createElement('div');
  body.appendChild(analysisEl);
  renderExerciseAnalysis(analysisEl, points, exName, equipment);

  // Tag history button
  const tagBtn = document.createElement('button');
  tagBtn.style.cssText = 'width:100%;padding:10px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;font-size:12px;color:var(--muted2);cursor:pointer;font-family:inherit;margin-top:12px;';
  tagBtn.textContent = '🏷 Tag equipment history';
  tagBtn.addEventListener('click', () => openTagHistory(exName));
  body.appendChild(tagBtn);
}

async function openTagHistory(exName) {
  const EQUIPMENT = ['Barbell','Dumbbell','Cable','Bodyweight','Machine'];
  const allSessions = load(SK.sessions)||[];
  const relevant = allSessions
    .filter(s => (s.exercises||[]).some(ex => ex.name === exName))
    .sort((a,b) => new Date(b.startedAt) - new Date(a.startedAt));

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(7,8,12,0.97);z-index:9999;display:flex;flex-direction:column;overflow:hidden;';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.08);flex-shrink:0;';

  const titleEl = document.createElement('div');
  titleEl.innerHTML = `<div style="font-family:'Bebas Neue',sans-serif;font-size:20px;letter-spacing:2px;color:#f0ede8;">TAG HISTORY</div><div style="font-size:11px;color:#4b5563;margin-top:2px;">${exName}</div>`;

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'background:none;border:none;color:#9ca3af;font-size:24px;cursor:pointer;padding:4px 8px;line-height:1;';
  closeBtn.addEventListener('click', () => overlay.remove());

  header.appendChild(titleEl);
  header.appendChild(closeBtn);

  const list = document.createElement('div');
  list.style.cssText = 'overflow-y:auto;flex:1;padding:12px 16px;-webkit-overflow-scrolling:touch;';

  if (!relevant.length) {
    list.innerHTML = '<div style="color:#4b5563;font-size:13px;padding:20px 0;text-align:center;">No sessions found.</div>';
  } else {
    relevant.forEach(s => {
      const ex = (s.exercises||[]).find(e => e.name === exName);
      if (!ex) return;
      const logged = (ex.sets||[]).filter(st => st.logged);
      const dateStr = new Date(s.startedAt).toLocaleDateString('no-NO',{weekday:'short',day:'numeric',month:'short'});
      const maxW = logged.length ? Math.max(...logged.map(st=>parseFloat(st.weight)||0)) : 0;
      const setsStr = logged.length ? `${logged.length} sets · best ${maxW}kg` : 'no logged sets';

      const row = document.createElement('div');
      row.style.cssText = 'background:#151824;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:12px 14px;margin-bottom:8px;';

      const topRow = document.createElement('div');
      topRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;';

      const info = document.createElement('div');
      info.innerHTML = `<div style="font-size:13px;color:#d1d5db;font-weight:500;">${dateStr}</div><div style="font-size:10px;color:#4b5563;margin-top:2px;">${setsStr}</div>`;

      const currentTag = document.createElement('span');
      currentTag.style.cssText = `font-size:10px;font-weight:600;padding:3px 9px;border-radius:12px;${ex.equipment ? 'color:var(--neon);background:rgba(0,180,255,0.1);border:1px solid rgba(0,180,255,0.2);' : 'color:#4b5563;'}`;
      currentTag.textContent = ex.equipment || 'Untagged';

      topRow.appendChild(info);
      topRow.appendChild(currentTag);

      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';

      EQUIPMENT.forEach(eq => {
        const btn = document.createElement('button');
        btn.textContent = eq;
        const isActive = ex.equipment === eq;
        btn.style.cssText = `padding:5px 12px;border-radius:16px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;border:1px solid ${isActive?'var(--neon)':'rgba(255,255,255,0.1)'};background:${isActive?'rgba(0,180,255,0.12)':'transparent'};color:${isActive?'var(--neon)':'#6b7280'};`;

        btn.addEventListener('click', async () => {
          const allS = load(SK.sessions)||[];
          const sess = allS.find(x => x.id === s.id);
          if (!sess) return;
          const exObj = (sess.exercises||[]).find(e => e.name === exName);
          if (!exObj) return;
          exObj.equipment = exObj.equipment === eq ? null : eq;
          save(SK.sessions, allS);
          await dbSaveSession(sess);
          // Update UI
          currentTag.textContent = exObj.equipment || 'Untagged';
          currentTag.style.color = exObj.equipment ? 'var(--neon)' : '#4b5563';
          btnRow.querySelectorAll('button').forEach(b => {
            const active = b.textContent === exObj.equipment;
            b.style.borderColor = active ? 'var(--neon)' : 'rgba(255,255,255,0.1)';
            b.style.background  = active ? 'rgba(0,180,255,0.12)' : 'transparent';
            b.style.color       = active ? 'var(--neon)' : '#6b7280';
          });
          showToast(exObj.equipment ? `Tagged: ${exObj.equipment}` : 'Tag removed');
        });
        btnRow.appendChild(btn);
      });

      row.appendChild(topRow);
      row.appendChild(btnRow);
      list.appendChild(row);
    });
  }

  overlay.appendChild(header);
  overlay.appendChild(list);
  document.body.appendChild(overlay);
}

async function tagSession(sessionId, exName, equipment, btnEl) {
  // Legacy — kept for compatibility
  const allSessions = load(SK.sessions)||[];
  const s = allSessions.find(s=>s.id===sessionId);
  if (!s) return;
  const ex = (s.exercises||[]).find(e=>e.name===exName);
  if (!ex) return;
  ex.equipment = ex.equipment === equipment ? null : equipment;
  save(SK.sessions, allSessions);
  await dbSaveSession(s);
  showToast(ex.equipment ? `Tagged as ${ex.equipment}` : 'Tag removed');
}


// ─── Canvas Charts ───
function drawBarChart(ctx, canvas, labels, data, color) {
  const W = canvas.offsetWidth * devicePixelRatio;
  const H = canvas.offsetHeight * devicePixelRatio;
  canvas.width = W; canvas.height = H;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const w = canvas.offsetWidth, h = canvas.offsetHeight;
  const pad = { top: 10, right: 10, bottom: 28, left: 40 };
  const chartW = w - pad.left - pad.right;
  const chartH = h - pad.top - pad.bottom;
  const max = Math.max(...data, 1);
  const barW = Math.max(4, (chartW / data.length) - 6);

  ctx.clearRect(0, 0, w, h);

  // Grid lines
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + chartH - (i / 4) * chartH;
    ctx.strokeStyle = 'rgba(0,180,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + chartW, y); ctx.stroke();
    ctx.fillStyle = 'rgba(74,80,104,0.8)';
    ctx.font = `${9 * devicePixelRatio / devicePixelRatio}px DM Mono, monospace`;
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(max * i / 4), pad.left - 4, y + 3);
  }

  data.forEach((val, i) => {
    const x = pad.left + i * (chartW / data.length) + (chartW / data.length - barW) / 2;
    const barH = (val / max) * chartH;
    const y = pad.top + chartH - barH;

    // Glow
    const grd = ctx.createLinearGradient(0, y, 0, y + barH);
    grd.addColorStop(0, color);
    grd.addColorStop(1, color + '44');
    ctx.fillStyle = grd;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.fillRect(x, y, barW, barH);
    ctx.shadowBlur = 0;

    // Label
    ctx.fillStyle = 'rgba(74,80,104,0.9)';
    ctx.textAlign = 'center';
    ctx.font = `8px DM Mono, monospace`;
    ctx.fillText(labels[i] || '', x + barW / 2, pad.top + chartH + 14);
  });
}

function drawLineChart(ctx, canvas, labels, data, color) {
  const W = canvas.offsetWidth * devicePixelRatio;
  const H = canvas.offsetHeight * devicePixelRatio;
  canvas.width = W; canvas.height = H;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const w = canvas.offsetWidth, h = canvas.offsetHeight;
  const pad = { top: 10, right: 10, bottom: 28, left: 40 };
  const chartW = w - pad.left - pad.right;
  const chartH = h - pad.top - pad.bottom;
  const max = Math.max(...data, 1);
  const min = Math.min(...data);

  ctx.clearRect(0, 0, w, h);

  // Grid
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (i / 4) * chartH;
    ctx.strokeStyle = 'rgba(0,180,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + chartW, y); ctx.stroke();
    const val = max - (i / 4) * (max - min);
    ctx.fillStyle = 'rgba(74,80,104,0.8)';
    ctx.font = '9px DM Mono, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(val), pad.left - 4, y + 3);
  }

  if (data.length < 2) return;

  const xStep = chartW / (data.length - 1);
  const points = data.map((v, i) => ({
    x: pad.left + i * xStep,
    y: pad.top + chartH - ((v - min) / (max - min || 1)) * chartH
  }));

  // Area fill
  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + chartH);
  grad.addColorStop(0, color + '33');
  grad.addColorStop(1, color + '00');
  ctx.beginPath();
  ctx.moveTo(points[0].x, pad.top + chartH);
  points.forEach(p => ctx.lineTo(p.x, p.y));
  ctx.lineTo(points[points.length-1].x, pad.top + chartH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Dots
  points.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = 'rgba(74,80,104,0.9)';
    ctx.font = '8px DM Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(labels[i] || '', p.x, pad.top + chartH + 14);
  });
}

// ═══════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════
function formatMMSS(secs) {
  const m = Math.floor(secs / 60), s = secs % 60;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function formatDuration(secs) {
  if (!secs) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════
function init() {
  initData();

  const now = new Date();
  const headerDate = document.getElementById('header-date');
  if (headerDate) headerDate.textContent = now.toLocaleDateString('no-NO', { weekday:'short', day:'numeric', month:'short' }).toUpperCase();

  // Auth handles data loading — just init auth and Strava
  initAuth().then(() => {
    initStrava();
  });
}

// ═══════════════════════════════════════════
// STRAVA INTEGRATION
// ═══════════════════════════════════════════
const STRAVA_CLIENT_ID = '232651';
const STRAVA_REFRESH_FN = 'https://fzbovpdnpvsfdnxyftqv.supabase.co/functions/v1/strava-refresh';
const SG_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ6Ym92cGRucHZzZmRueHlmdHF2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwMzM5NzcsImV4cCI6MjA5MzYwOTk3N30.LqtdpwtEfZweiQW3NJmtFkVZuCG7_ANLP8yLB8XfIn4';

let stravaConnected = false;

async function initStrava() {
  // Check if just connected
  const params = new URLSearchParams(window.location.search);
  if (params.get('strava') === 'connected') {
    showToast('Strava connected! 🎉');
    window.history.replaceState({}, '', '/');
  }
  if (params.get('strava') === 'error') {
    showToast('Strava connection failed.');
    window.history.replaceState({}, '', '/');
  }

  // Check if we have a valid token
  try {
    const res = await fetch(STRAVA_REFRESH_FN, {
      headers: { 'apikey': SG_ANON_KEY, 'Authorization': 'Bearer ' + SG_ANON_KEY }
    });
    if (res.ok) {
      const data = await res.json();
      stravaConnected = !!data.access_token;
    }
  } catch(e) { stravaConnected = false; }

  updateStravaBtn();
}

function updateStravaBtn() {
  const btn = document.getElementById('strava-connect-row');
  const lbl = document.getElementById('strava-home-label');
  if (!btn) return;
  if (stravaConnected) {
    btn.style.borderColor = 'rgba(0,255,150,0.35)';
    btn.style.background  = 'rgba(0,255,150,0.08)';
    btn.style.color       = 'var(--green)';
    btn.querySelector('svg').style.fill = 'var(--green)';
    if (lbl) lbl.textContent = '✓';
  } else {
    btn.style.borderColor = 'rgba(255,255,255,0.1)';
    btn.style.background  = 'rgba(255,255,255,0.06)';
    btn.style.color       = 'var(--muted2)';
    btn.querySelector('svg').style.fill = '#FC4C02';
    if (lbl) lbl.textContent = '';
  }
}

function handleStravaHomeBtn() {
  if (stravaConnected) {
    showToast('Strava is connected ✓');
  } else {
    connectStrava();
  }
}

function connectStrava() {
  const redirectUri = encodeURIComponent('https://sterk-gutt.pages.dev/callback.html');
  const scope = 'activity:write,activity:read';
  const url = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&response_type=code&redirect_uri=${redirectUri}&approval_prompt=force&scope=${scope}`;
  window.location.href = url;
}

async function getStravaToken() {
  const res = await fetch(STRAVA_REFRESH_FN, {
    headers: { 'apikey': SG_ANON_KEY, 'Authorization': 'Bearer ' + SG_ANON_KEY }
  });
  if (!res.ok) throw new Error('Could not get Strava token');
  const data = await res.json();
  return data.access_token;
}

function showStravaUploadPrompt(session) {
  // Build detailed exercise notes — each exercise with all sets
  const exerciseSummary = (session.exercises || [])
    .map(ex => {
      const logged = (ex.sets || []).filter(s => s.logged);
      if (!logged.length) return null;
      const setsStr = logged.map((s, i) => {
        if (ex.unilateral) {
          const l = s.repsL || 0, r = s.repsR || 0;
          return `  Set ${i+1}: ${l}L / ${r}R${s.weight ? ' @ ' + s.weight + 'kg' : ''}`;
        }
        return `  Set ${i+1}: ${s.reps || '?'} reps${s.weight ? ' @ ' + s.weight + 'kg' : ''}`;
      }).join('\n');
      return `${ex.name}\n${setsStr}`;
    })
    .filter(Boolean)
    .join('\n\n');

  const name = session.routineName || session.exercises?.[0]?.name || 'Strength workout';
  const dur  = session.duration || 0;
  const durStr = dur > 3600
    ? `${Math.floor(dur/3600)}h ${Math.floor((dur%3600)/60)}m`
    : `${Math.floor(dur/60)}m`;

  // Preview summary (shorter for display)
  const previewSummary = (session.exercises || [])
    .map(ex => {
      const logged = (ex.sets || []).filter(s => s.logged);
      if (!logged.length) return null;
      const maxW = Math.max(...logged.map(s => parseFloat(s.weight) || 0));
      return `${ex.name} ${logged.length}×${logged[0].reps || '?'}${maxW ? ' @ ' + maxW + 'kg' : ''}`;
    })
    .filter(Boolean)
    .join('\n');

  const overlay = document.createElement('div');
  overlay.id = 'strava-upload-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(7,8,12,0.92);z-index:2000;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding:0 16px 40px;';
  overlay.innerHTML = `
    <div style="background:#151824;border:1px solid rgba(0,180,255,0.18);border-radius:16px;padding:24px 20px;width:100%;max-width:400px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="#FC4C02"><path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.598h4.172L10.463 0l-7 13.828h4.169"/></svg>
        <div style="font-family:'Bebas Neue',sans-serif;font-size:18px;letter-spacing:2px;color:#fff;">Upload to Strava?</div>
      </div>
      <div style="font-size:12px;color:#4a5068;margin-bottom:16px;">${name} · ${durStr}</div>
      <div style="font-size:11px;color:#6b7490;background:#0d0f17;border-radius:8px;padding:10px 12px;margin-bottom:16px;white-space:pre-line;max-height:120px;overflow-y:auto;">${previewSummary}</div>
      <div style="font-size:10px;color:#4a5068;margin-bottom:12px;letter-spacing:0.5px;">Full sets & reps will be included in the Strava description.</div>
      <div style="display:flex;gap:10px;">
        <button id="strava-upload-yes" style="flex:1;background:#FC4C02;color:#fff;border:none;border-radius:8px;padding:13px;font-family:'DM Mono',monospace;font-size:12px;font-weight:500;letter-spacing:1px;cursor:pointer;">UPLOAD</button>
        <button id="strava-upload-no" style="flex:1;background:transparent;color:#4a5068;border:1px solid rgba(0,180,255,0.1);border-radius:8px;padding:13px;font-family:'DM Mono',monospace;font-size:12px;cursor:pointer;">SKIP</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  function closeOverlay() {
    const el = document.getElementById('strava-upload-overlay');
    if (el) el.remove();
  }

  document.getElementById('strava-upload-no').addEventListener('click', closeOverlay);

  document.getElementById('strava-upload-yes').addEventListener('click', async () => {
    const btn = document.getElementById('strava-upload-yes');
    btn.textContent = 'UPLOADING…'; btn.disabled = true;
    try {
      await uploadToStrava(session, exerciseSummary);
      closeOverlay();
      showToast('Uploaded to Strava! 🧡');
    } catch(e) {
      closeOverlay();
      showToast('Upload failed: ' + e.message);
    }
  });
}

async function uploadToStrava(session, description) {
  const token = await getStravaToken();
  const name = session.routineName || session.exercises?.[0]?.name || 'Strength workout';
  const startTime = new Date(session.startedAt);
  // Format as local time for Strava (avoid UTC conversion shifting the time)
  const pad = n => String(n).padStart(2,'0');
  const localISO = `${startTime.getFullYear()}-${pad(startTime.getMonth()+1)}-${pad(startTime.getDate())}T${pad(startTime.getHours())}:${pad(startTime.getMinutes())}:${pad(startTime.getSeconds())}Z`;

  const res = await fetch('https://www.strava.com/api/v3/activities', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      type: 'WeightTraining',
      start_date_local: localISO,
      elapsed_time: session.duration || 0,
      description: description + '\n\nLogged with Sterk Gutt 💪',
    })
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || 'Strava API error');
  }
  return res.json();
}

// Service worker disabled to prevent caching issues
// if ('serviceWorker' in navigator) { ... }

// Wait for DOM before initialising
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init(); // DOM already ready
}

Object.assign(window, {
  // Nav & pages
  showPage, openModal, closeModal, signInWithGoogle, signInWithMagicLink, signOut,
  // Home
  openWorkoutPicker, handleStravaHomeBtn,
  // Workout
  startWorkout, resumeWorkout, finishWorkout,
  handleSetBtn, addSet, removeLastSet, toggleExCollapse,
  setEquipment, updateSet,
  // Routine editor
  openRoutineEditor, saveRoutine, saveRoutineChanges, deleteRoutine,
  addExerciseToEditor, removeEditorEx, toggleRoutineCard,
  // Exercise picker
  selectExerciseFromPicker, showNewExForm, hideNewExForm,
  createAndAddExercise, selectMuscle,
  // Exercise library
  openExerciseLibEditor, saveExerciseLib, deleteExerciseLib, setLibFilter,
  // Stats
  setStatsSubtab, applyCustomRange,
  // Confirm dialog
  confirmOk, closeConfirm,
});
