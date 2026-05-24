// ══ STERK GUTT — main application module ════════════════════════════════════
// CSS is imported via main.js. All app logic lives here for now.
// Future: split into db.js, ui/workout.js, ui/routines.js etc.

import { createClient } from '@supabase/supabase-js';
import * as BodyMuscles from 'body-muscles';
window.BodyMuscles = BodyMuscles;

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
  let hasSynced = false;
  sb.auth.onAuthStateChange(async (event, session) => {
    if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session) {
      try {
        currentUser = session.user;
        USER_ID = session.user.id;
        localStorage.setItem('sg_user_id', USER_ID);
        hideLoginScreen();
        if (!hasSynced) {
          hasSynced = true;
          await migrateDataIfNeeded();
          await syncFromCloud();
          // Re-render all visible pages with fresh data
          renderHome();
          renderRoutines(); // always re-render routines so splits show up
          const activePage = document.querySelector('.page.active');
          if (activePage) {
            if (activePage.id === 'page-exercises') { renderExerciseLibrary(); renderEquipmentInventory(); }
            if (activePage.id === 'page-stats')     renderStats();
          }
        }
      } catch(e) {
        console.error('Auth flow error:', e.message, e.stack);
      }
    } else if (event === 'SIGNED_OUT' || (event === 'INITIAL_SESSION' && !session)) {
      currentUser = null;
      hasSynced = false;
      showLoginScreen();
    }
  });
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
let _splits    = [];  // { id, name }[]
let _sessions  = [];
let _activeSession = null;

// Shim for legacy load() calls that still exist
const SK = { routines:'_r', sessions:'_s', activeSession:'_a', exercises:'_e', splits:'_splits' };
function load(key) {
  if (key === SK.exercises)     return _exercises.length ? _exercises : null;
  if (key === SK.routines)      return _routines.length  ? _routines  : null;
  if (key === SK.splits)        return _splits;
  if (key === SK.sessions)      return _sessions.length  ? _sessions  : null;
  if (key === SK.activeSession) return _activeSession;
  return null;
}
function save(key, val) {
  if (key === SK.exercises)     { _exercises = val || []; return; }
  if (key === SK.routines)      { _routines  = val || []; return; }
  if (key === SK.splits)        { _splits    = val || []; return; }
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
      // Deduplicate by name (case-insensitive), keep last entry (most recently created)
      const seen = new Map();
      data.forEach(e => seen.set(e.name.toLowerCase(), e));
      _exercises = Array.from(seen.values()).map(e => ({
        id:e.id, name:e.name, muscle:e.muscle, primaryMuscle:e.primary_muscle||null, secondaryMuscles:e.secondary_muscles||[], unilateral:!!e.unilateral
      }));
      // Delete orphaned duplicate rows from Supabase silently
      const keptIds = new Set(_exercises.map(e => e.id));
      const dupes = data.filter(e => !keptIds.has(e.id));
      dupes.forEach(e => supabaseFetch(`exercises?id=eq.${e.id}&user_id=eq.${USER_ID}`, '', 'DELETE').catch(()=>{}));
    } else {
      await dbSeedExercises();
    }
  } catch(e) { console.warn('Load exercises failed:', e.message); }
}

async function dbSeedExercises() {
  const rows = DEFAULT_EXERCISES.map(e => ({ ...e, user_id: USER_ID }));
  await supabaseFetch('exercises', 'on_conflict=id', 'POST', rows);
  _exercises = [...DEFAULT_EXERCISES];
}

async function dbSaveExercise(ex) {
  const clean = { id: ex.id, name: ex.name, muscle: ex.muscle||'', primaryMuscle: ex.primaryMuscle||null, secondaryMuscles: ex.secondaryMuscles||[], unilateral: !!ex.unilateral };
  const idx = _exercises.findIndex(e => e.id === ex.id);
  if (idx >= 0) _exercises[idx] = clean;
  else          _exercises.push(clean);
  if (document.getElementById('page-exercises')?.classList.contains('active')) renderExerciseLibrary();

  try {
    const row = { id: ex.id, name: ex.name, muscle: ex.muscle||'', primary_muscle: ex.primaryMuscle||null, secondary_muscles: ex.secondaryMuscles||[], unilateral: !!ex.unilateral, user_id: USER_ID };
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
      split_id: routine.splitId || null,
      created_at: routine.createdAt ? new Date(routine.createdAt).toISOString() : new Date().toISOString(),
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
  } catch(e) {}

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
      _routines = data.map(r => ({ id:r.id, name:r.name, exercises:r.exercises, createdAt:new Date(r.created_at).getTime(), splitId:r.split_id||null }));
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
    const data = await supabaseFetch('sessions', `select=*&user_id=eq.${USER_ID}&is_active=eq.false&order=started_at.asc`);
    if (data) {
      _sessions = data.map(s => ({
        id:s.id, routineId:s.routine_id, routineName:s.routine_name,
        startedAt:new Date(s.started_at).getTime(), duration:s.duration,
        exercises:s.exercises, stravaUploaded:s.strava_uploaded,
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
    await loadInventoryFromCloud();
    await dbLoadSplits();
    // Render routines AFTER splits are loaded so groups show correctly
    renderRoutines();
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
      { id: 'e8', name: 'Goblet Squat', muscle: 'Legs', sets: 4, unilateral: false },
      { id: 'e9', name: 'Step-ups', muscle: 'Legs', sets: 4, unilateral: true },
      { id: 'e10', name: 'Walking Lunges', muscle: 'Legs', sets: 3, unilateral: false },
      { id: 'e11', name: 'RDL', muscle: 'Legs', sets: 3, unilateral: false },
      { id: 'e12', name: 'Single Leg Calf Raise', muscle: 'Legs', sets: 5, unilateral: true },
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
      { id: 'e23', name: 'Bulgarian Split Squat', muscle: 'Legs', sets: 4, unilateral: true },
      { id: 'e24', name: 'Step-ups', muscle: 'Legs', sets: 4, unilateral: true },
      { id: 'e25', name: 'Single Leg RDL', muscle: 'Legs', sets: 3, unilateral: true },
      { id: 'e26', name: 'Single Leg Hip Thrust', muscle: 'Legs', sets: 3, unilateral: true },
      { id: 'e27', name: 'Single Leg Calf Raise', muscle: 'Legs', sets: 5, unilateral: true },
      { id: 'e28', name: 'Lying Curl', muscle: 'Legs', sets: 3, unilateral: false },
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

// Primary muscles per muscle group
const PRIMARY_MUSCLES = {
  Abs:       ['Abs', 'Obliques', 'Transverse Abdominis'],
  Back:      ['Lats', 'Traps', 'Rhomboids', 'Rear Delts', 'Erectors'],
  Biceps:    ['Biceps', 'Brachialis', 'Brachioradialis'],
  Chest:     ['Pecs', 'Upper Pecs', 'Lower Pecs'],
  Legs:      ['Quads', 'Hamstrings', 'Glutes', 'Calves', 'Hip Flexors', 'Adductors'],
  Shoulders: ['Front Delts', 'Side Delts', 'Rear Delts'],
  Triceps:   ['Triceps Long Head', 'Triceps Lateral Head', 'Triceps Medial Head'],
};

const MUSCLE_NORMALISE = {
  'Quads': 'Legs', 'Hamstrings': 'Legs', 'Glutes': 'Legs', 'Calves': 'Legs',
};
function normaliseMuscle(m) { return MUSCLE_NORMALISE[m] || m; }


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
  if (name === 'exercises') { renderExerciseLibrary(); renderEquipmentInventory(); }
  if (name === 'stats') {
    renderStats();
  }
}

// ═══════════════════════════════════════════
// MODALS
// ═══════════════════════════════════════════
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
  if (id === 'exercise-picker') { _sessionPickerMode = false; _editingSessionPickerMode = false; }
}

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
  const recent = [...sessions].reverse(); // newest first
  const now = new Date();

  // ── Date card ─────────────────────────────────────────────────────────────
  const dayNum = now.getDate();
  const dayName = now.toLocaleDateString('en-GB', { weekday:'long' }).toUpperCase();
  const monthName = now.toLocaleDateString('en-GB', { month:'long' }).toUpperCase();
  // ISO week number
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((now - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);

  const dayNumEl = document.getElementById('home-day-num');
  const dateLineEl = document.getElementById('home-date-line');
  const weekLineEl = document.getElementById('home-week-line');
  if (dayNumEl) dayNumEl.textContent = dayNum;
  if (dateLineEl) dateLineEl.textContent = `${dayName} · ${monthName}`;
  if (weekLineEl) weekLineEl.textContent = `→ TODAY · WEEK ${weekNum}`;

  // ── Days since last lift ───────────────────────────────────────────────────
  const statusEl = document.getElementById('home-status-text');
  if (statusEl) {
    if (recent.length > 0) {
      const lastDate = new Date(recent[0].startedAt);
      // Compare calendar dates, not raw milliseconds
      const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const lastMidnight  = new Date(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate());
      const daysSince = Math.round((todayMidnight - lastMidnight) / 86400000);
      if (daysSince === 0) statusEl.textContent = 'READY · TRAINED TODAY';
      else if (daysSince === 1) statusEl.textContent = 'READY · 1 DAY SINCE LAST LIFT';
      else statusEl.textContent = `READY · ${daysSince} DAYS SINCE LAST LIFT`;
    } else {
      statusEl.textContent = 'READY · LET\'S GET STARTED';
    }
  }

  // ── Strava button ─────────────────────────────────────────────────────────
  updateStravaBtn();

  // ── Resume banner ─────────────────────────────────────────────────────────
  const resumeSlot = document.getElementById('home-resume-slot');
  if (resumeSlot) {
    resumeSlot.innerHTML = '';
    let savedActive = load(SK.activeSession);
    if (!savedActive) {
      try { savedActive = JSON.parse(localStorage.getItem(LS_ACTIVE)); } catch(e) {}
    }
    if (savedActive && !activeSession) {
      const dur = formatDuration(Math.floor((Date.now() - savedActive.startedAt) / 1000));
      resumeSlot.innerHTML = `
        <div class="resume-banner">
          <div>
            <div class="resume-banner-title">⚡ WORKOUT IN PROGRESS</div>
            <div class="resume-banner-sub">${savedActive.routineName} · ${dur} ago</div>
          </div>
          <button class="resume-btn" onclick="resumeWorkout()">RESUME</button>
        </div>`;
    }
  }

  // ── Session list ──────────────────────────────────────────────────────────
  const list = document.getElementById('recent-list');
  if (recent.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">💪</div><div class="empty-state-text">No sessions yet</div></div>';
    return;
  }

  list.innerHTML = '';
  recent.forEach(s => {
    const totalSets = (s.exercises||[]).reduce((a,ex)=>a+(ex.sets||[]).filter(st=>st.logged).length, 0);
    const dur = s.duration ? formatDuration(s.duration) : '—';
    const d = new Date(s.startedAt);
    const dayN = d.getDate();
    const weekday = d.toLocaleDateString('en-GB', { weekday:'short' }).toUpperCase();
    const metaStr = `${weekday} · ${dur} · ${totalSets} SETS`;

    const item = document.createElement('div');
    item.className = 'recent-item';
    item.innerHTML = `
      <div class="recent-day-num">${dayN}</div>
      <div class="recent-info">
        <div class="recent-name">${s.routineName}</div>
        <div class="recent-meta">${metaStr}</div>
      </div>
      <div class="recent-right">
        <span class="recent-sets">${totalSets}</span>
        <span class="recent-sets-label">sets</span>
      </div>`;

    item.addEventListener('click', () => openSessionEditor(s.id));
    list.appendChild(item);
  });
}

let _editingSession = null;
let _sessionEditMode = false;

function toggleSessionEdit() {
  _sessionEditMode = !_sessionEditMode;
  const btn = document.getElementById('session-edit-btn');
  if (btn) btn.textContent = _sessionEditMode ? 'DONE' : 'EDIT';
  if (btn) btn.style.borderColor = _sessionEditMode ? 'rgba(255,68,102,0.5)' : 'rgba(200,240,110,0.35)';
  if (btn) btn.style.color = _sessionEditMode ? '#ff4466' : '#c8f06e';
  renderSessionBody(_editingSession);
  if (!_sessionEditMode) saveEditedSession();
}

function saveEditedSession() {
  if (!_editingSession) return;
  const allSessions = load(SK.sessions) || [];
  const idx = allSessions.findIndex(x => x.id === _editingSession.id);
  if (idx >= 0) {
    allSessions[idx] = _editingSession;
    save(SK.sessions, allSessions);
    dbSaveSession(_editingSession);
    renderHome();
    showToast('Session saved');
  }
}

function renderSessionBody(s) {
  const body = document.getElementById('session-edit-body');
  if (!body || !s) return;
  body.innerHTML = '';

  // Build muscle data from this session
  const allEx = load(SK.exercises) || [];
  const muscleData = {};
  (s.exercises||[]).forEach(ex => {
    const libEx = allEx.find(e => e.id === ex.id || e.name === ex.name);
    const pm = libEx?.primaryMuscle || ex.primaryMuscle;
    if (!pm) return;
    const logged = Array.isArray(ex.sets) ? ex.sets.filter(st => st.logged).length : 1;
    muscleData[pm] = (muscleData[pm] || 0) + logged;
  });

  // Body map card
  if (Object.keys(muscleData).length > 0) {
    const mapDiv = document.createElement('div');
    mapDiv.id = 'session-body-map';
    mapDiv.style.cssText = 'margin-bottom:20px;';
    body.appendChild(mapDiv);
    setTimeout(() => renderMuscleMap('session-body-map', muscleData, true), 0);
  }

  (s.exercises||[]).forEach((ex, exIdx) => {
    const logged = (ex.sets||[]).filter(st => st.logged);
    if (!logged.length && !_sessionEditMode) return;

    const isUni = ex.unilateral;
    const colLabel = isUni ? 'L / R' : 'REPS';
    const block = document.createElement('div');
    block.style.cssText = 'margin-bottom:24px;';

    // Exercise header
    let exHeader = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:4px;">
        <div class="sd-ex-name">${ex.name}</div>
        <div style="display:flex;align-items:center;gap:8px;">
          ${ex.equipment ? `<span class="sd-eq-tag">${ex.equipment.toUpperCase()}</span>` : ''}
          ${_sessionEditMode ? `<button onclick="removeSessionExercise(${exIdx})" style="background:none;border:none;color:#ff4466;font-size:16px;cursor:pointer;padding:0;line-height:1;">✕</button>` : ''}
        </div>
      </div>`;

    // Column headers
    exHeader += `<div class="sd-col-hdr" style="grid-template-columns:${_sessionEditMode?'20px ':''} 24px 80px 1fr 1fr;">
      ${_sessionEditMode ? '<span></span>' : ''}
      <span>#</span><span>KG</span><span>${colLabel}</span><span>NOTE</span>
    </div>`;

    block.innerHTML = exHeader;

    // Set rows
    const rowsDiv = document.createElement('div');
    rowsDiv.className = 'sd-rows';
    (ex.sets||[]).filter(st => st.logged || _sessionEditMode).forEach((st, setIdx) => {
      const row = document.createElement('div');
      row.className = 'sd-set-row';
      row.style.gridTemplateColumns = (_sessionEditMode ? '20px ' : '') + '24px 80px 1fr 1fr';

      if (_sessionEditMode) {
        // Editable inputs
        const repsField = isUni
          ? `<div style="display:flex;gap:4px;">
               <input type="number" inputmode="numeric" value="${st.repsL||''}" placeholder="L"
                 style="width:44px;background:#111;border:1px solid rgba(255,255,255,0.10);color:#c8f06e;font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;text-align:center;padding:5px 2px;outline:none;"
                 onchange="updateSavedSet(${exIdx},${setIdx},'repsL',this.value)"/>
               <input type="number" inputmode="numeric" value="${st.repsR||''}" placeholder="R"
                 style="width:44px;background:#111;border:1px solid rgba(255,255,255,0.10);color:#c8f06e;font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;text-align:center;padding:5px 2px;outline:none;"
                 onchange="updateSavedSet(${exIdx},${setIdx},'repsR',this.value)"/>
             </div>`
          : `<input type="number" inputmode="numeric" value="${st.reps||''}" placeholder="reps"
               style="width:60px;background:#111;border:1px solid rgba(255,255,255,0.10);color:#c8f06e;font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;text-align:center;padding:5px 4px;outline:none;"
               onchange="updateSavedSet(${exIdx},${setIdx},'reps',this.value)"/>`;
        row.innerHTML = `
          <button onclick="removeSavedSet(${exIdx},${setIdx})" style="background:none;border:none;color:rgba(255,68,102,0.6);font-size:14px;cursor:pointer;padding:0;line-height:1;">✕</button>
          <span class="sd-set-num">${setIdx+1}</span>
          <input type="text" inputmode="decimal" value="${st.weight||''}" placeholder="kg"
            style="width:72px;background:#111;border:1px solid rgba(255,255,255,0.10);color:#c8f06e;font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;text-align:center;padding:5px 4px;outline:none;"
            onchange="updateSavedSet(${exIdx},${setIdx},'weight',this.value.replace(',','.'))"/>
          ${repsField}
          <input type="text" value="${st.note||''}" placeholder="note"
            style="background:#111;border:1px solid rgba(255,255,255,0.08);color:rgba(241,236,226,0.5);font-family:'JetBrains Mono',monospace;font-size:11px;padding:5px 6px;outline:none;width:100%;"
            onchange="updateSavedSet(${exIdx},${setIdx},'note',this.value)"/>`;
      } else {
        // Read-only display
        const repsStr = isUni
          ? `<span class="sd-reps">${st.repsL||0} / ${st.repsR||0}</span>`
          : `<span class="sd-reps">${st.reps||'—'}</span>`;
        const noteStr = st.note ? `<span class="sd-note-pill">${st.note}</span>` : '<span></span>';
        row.innerHTML = `
          <span class="sd-set-num">${setIdx+1}</span>
          <span class="sd-weight">${fmtKg(st.weight)||'—'} <span style="font-size:11px;font-weight:400;">kg</span></span>
          ${repsStr}${noteStr}`;
      }
      rowsDiv.appendChild(row);
    });

    // Add set button in edit mode
    if (_sessionEditMode) {
      const addSetBtn = document.createElement('button');
      addSetBtn.style.cssText = 'margin-top:8px;padding:7px 14px;background:transparent;border:1px dashed rgba(200,240,110,0.25);color:rgba(200,240,110,0.6);font-family:"JetBrains Mono",monospace;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;cursor:pointer;width:100%;';
      addSetBtn.textContent = '+ Add Set';
      addSetBtn.onclick = () => addSavedSet(exIdx);
      rowsDiv.appendChild(addSetBtn);
    }

    block.appendChild(rowsDiv);
    body.appendChild(block);
  });

  // Add exercise button in edit mode
  if (_sessionEditMode) {
    const addExBtn = document.createElement('button');
    addExBtn.style.cssText = 'width:100%;padding:13px;border:1.5px dashed rgba(200,240,110,0.22);background:transparent;color:rgba(200,240,110,0.6);font-family:"JetBrains Mono",monospace;font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;cursor:pointer;margin-top:8px;';
    addExBtn.textContent = '+ Add Exercise';
    addExBtn.onclick = () => openExPickerForSession();
    body.appendChild(addExBtn);
  }
}

function updateSavedSet(exIdx, setIdx, field, val) {
  if (!_editingSession) return;
  const st = _editingSession.exercises[exIdx].sets[setIdx];
  if (field === 'weight') st[field] = parseFloat(val) || val;
  else if (field === 'reps' || field === 'repsL' || field === 'repsR') st[field] = parseInt(val) || 0;
  else st[field] = val;
}

function removeSavedSet(exIdx, setIdx) {
  if (!_editingSession) return;
  const ex = _editingSession.exercises[exIdx];
  if (ex.sets.filter(st=>st.logged).length <= 1) { showToast('Need at least one set'); return; }
  ex.sets.splice(setIdx, 1);
  renderSessionBody(_editingSession);
}

function addSavedSet(exIdx) {
  if (!_editingSession) return;
  const ex = _editingSession.exercises[exIdx];
  const last = ex.sets[ex.sets.length-1] || {};
  ex.sets.push({ logged:true, weight:last.weight||'', reps:last.reps||'', repsL:last.repsL||'', repsR:last.repsR||'', note:'' });
  renderSessionBody(_editingSession);
}

function removeSessionExercise(exIdx) {
  if (!_editingSession) return;
  showConfirm('Remove exercise?', 'This removes it from this session only.', () => {
    _editingSession.exercises.splice(exIdx, 1);
    renderSessionBody(_editingSession);
  });
}

let _sessionPickerMode = false;
let _editingSessionPickerMode = false;

function openExPickerForSession() {
  if (!_editingSession) return;
  pickerExIdx = null;
  _editingSessionPickerMode = true;
  _sessionPickerMode = false;
  filterExPicker('');
  openModal('exercise-picker');
}

function openSessionEditor(sessionId) {
  const allSessions = load(SK.sessions)||[];
  const s = JSON.parse(JSON.stringify(allSessions.find(x => x.id === sessionId)||{}));
  if (!s.id) return;
  _editingSession = s;
  _sessionEditMode = false;

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:#0f0f0e;z-index:9999;display:flex;flex-direction:column;overflow:hidden;';

  // ── Header ────────────────────────────────────────────────────────────────
  const d = new Date(s.startedAt);
  const dateStr = d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'}).toUpperCase();
  const dur = s.duration ? formatDuration(s.duration) : '';
  const totalSets = (s.exercises||[]).reduce((a,ex)=>a+(ex.sets||[]).filter(st=>st.logged).length,0);
  const totalVol = Math.round((s.exercises||[]).reduce((a,ex)=>{
    return a+(ex.sets||[]).filter(st=>st.logged).reduce((b,st)=>{
      const w=parseFloat(st.weight)||0;
      const r=ex.unilateral?((parseFloat(st.repsL)||0)+(parseFloat(st.repsR)||0)):parseFloat(st.reps)||0;
      return b+w*r;
    },0);
  },0)/1000*10)/10;

  const header = document.createElement('div');
  header.style.cssText = 'padding:20px 20px 16px;flex-shrink:0;border-bottom:1px solid rgba(255,255,255,0.06);';
  header.innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px;">
      <div class="sd-title">${s.routineName}</div>
      <div style="display:flex;align-items:center;gap:10px;">
        <button id="session-edit-btn" onclick="toggleSessionEdit()" style="background:none;border:1px solid rgba(200,240,110,0.35);color:#c8f06e;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;padding:5px 12px;cursor:pointer;">EDIT</button>
        <button onclick="this.closest('[style*=fixed]').remove()" style="background:none;border:none;color:#555552;font-size:20px;cursor:pointer;padding:0;line-height:1;margin-top:2px;">×</button>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <span class="sd-meta">${dateStr}${dur?' · '+dur:''} · ${totalSets} SETS</span>
      <span class="sd-vol-pill">${totalVol}T VOL</span>
    </div>`;
  overlay.appendChild(header);

  // ── Body ──────────────────────────────────────────────────────────────────
  const body = document.createElement('div');
  body.id = 'session-edit-body';
  body.style.cssText = 'overflow-y:auto;flex:1;padding:0 20px 20px;-webkit-overflow-scrolling:touch;';
  overlay.appendChild(body);

  // ── Footer ────────────────────────────────────────────────────────────────
  const footer = document.createElement('div');
  footer.style.cssText = 'padding:12px 20px;border-top:1px solid rgba(255,255,255,0.06);flex-shrink:0;display:flex;flex-direction:column;gap:8px;';

  // Strava upload button — only if connected
  if (stravaConnected) {
    const alreadyUploaded = !!s.stravaUploaded;
    const stravaBtn = document.createElement('button');
    stravaBtn.style.cssText = 'width:100%;padding:13px;background:transparent;border:1px solid #FC4C02;color:#FC4C02;font-family:"Barlow Condensed",sans-serif;font-size:16px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:10px;';
    // Strava logo SVG (simplified)
    stravaBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="#FC4C02"><path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.598h4.172L10.463 0l-7 13.828h4.169"/></svg>${alreadyUploaded ? '✓ Uploaded to Strava' : 'Upload to Strava'}`;
    if (alreadyUploaded) {
      stravaBtn.style.opacity = '0.45';
      stravaBtn.style.cursor = 'default';
      stravaBtn.disabled = true;
    } else {
      stravaBtn.addEventListener('click', () => uploadSessionToStrava(s, stravaBtn));
    }
    footer.appendChild(stravaBtn);
  }

  const delBtn = document.createElement('button');
  delBtn.style.cssText = 'width:100%;padding:13px;background:transparent;border:1px solid rgba(255,68,102,0.25);color:#ff4466;font-family:"JetBrains Mono",monospace;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;cursor:pointer;';
  delBtn.textContent = 'DELETE SESSION';
  delBtn.addEventListener('click', () => {
    showConfirm('Delete session?', `Remove "${s.routineName}" permanently?`, async () => {
      overlay.remove();
      _sessions = _sessions.filter(x => x.id !== s.id);
      await dbDeleteSession(s.id);
      renderHome();
      showToast('Session deleted');
    });
  });
  footer.appendChild(delBtn);
  overlay.appendChild(footer);
  document.body.appendChild(overlay);
  // Now the element is in the DOM — safe to render body
  renderSessionBody(s);
}

function deleteSession(btn) {
  // Legacy — kept for safety
  showToast('Tap the session to edit or delete');
}

function resumeWorkout() {
  // Try in-memory first, then localStorage fallback
  let saved = load(SK.activeSession);
  if (!saved) {
    try { saved = JSON.parse(localStorage.getItem(LS_ACTIVE)); } catch(e) {}
  }
  if (!saved) return;
  activeSession = saved;
  _activeSession = saved;
  renderWorkoutPage();
  showPage('workout', document.getElementById('nav-workout'));
  startGlobalTimer();
}

// ═══════════════════════════════════════════
// WORKOUT PICKER
// ═══════════════════════════════════════════
function openWorkoutPicker() {
  const routines = load(SK.routines) || [];
  const sessions = load(SK.sessions) || [];
  const list = document.getElementById('picker-routine-list');

  // Subtitle
  const now = new Date();
  const dayStr = now.toLocaleDateString('en-GB',{weekday:'short'}).toUpperCase();
  const dayNum = now.getDate();
  const monStr = now.toLocaleDateString('en-GB',{month:'short'}).toUpperCase();
  const sub = document.getElementById('wp-subtitle');
  if (sub) sub.textContent = `${dayStr} ${dayNum} ${monStr} · ${routines.length} ROUTINES`;

  // Helper: days since last time this routine was used
  function daysSince(routineId) {
    const last = [...sessions].reverse().find(s => s.routineId === routineId);
    if (!last) return null;
    return Math.floor((Date.now() - last.startedAt) / 86400000);
  }

  const routineRows = routines.map(r => {
    const ds = daysSince(r.id);
    const daysLabel = ds === null ? 'NEVER' : ds === 0 ? 'TODAY' : `${ds}D AGO`;
    const exCount = r.exercises?.length || 0;
    return `
      <div class="wp-row" onclick="startWorkout('${r.id}')">
        <div class="wp-row-info">
          <div class="wp-row-name">${r.name}</div>
          <div class="wp-row-meta">${exCount} EXERCISES · ${daysLabel}</div>
        </div>
        <span class="wp-row-chevron">›</span>
      </div>`;
  }).join('');

  const adHocRow = `
    <div class="wp-row wp-row-adhoc" onclick="startAdHocWorkout()">
      <div class="wp-adhoc-icon">+</div>
      <div class="wp-row-info">
        <div class="wp-row-name" style="color:#c8f06e;">AD HOC</div>
        <div class="wp-row-meta">Blank workout — add lifts as you go</div>
      </div>
      <span class="wp-row-chevron" style="color:#c8f06e;">›</span>
    </div>`;

  list.innerHTML = routineRows + adHocRow;
  openModal('workout-picker');
}

function startAdHocWorkout() {
  closeModal('workout-picker');
  const sessionId = Date.now();
  activeSession = {
    id: sessionId,
    routineId: null,
    routineName: 'Ad Hoc',
    startedAt: Date.now(),
    duration: null,
    exercises: [],
  };
  setTimers = {};
  autoSaveSession();
  renderWorkoutPage();
  showPage('workout', document.getElementById('nav-workout'));
  startGlobalTimer();
}

function promptAdHocName(callback) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(7,8,12,0.95);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;';
  overlay.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border2);border-radius:16px;padding:24px;width:100%;max-width:320px;">
      <div style="font-family:'Bebas Neue',sans-serif;font-size:22px;letter-spacing:3px;color:var(--text);margin-bottom:6px;">NAME THIS WORKOUT</div>
      <div style="font-size:12px;color:var(--muted2);margin-bottom:16px;">Give your Ad Hoc session a name</div>
      <input id="adhoc-name-input" type="text" placeholder="e.g. Push day, Chest & arms..." value="Ad Hoc"
        style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:10px;padding:12px 14px;font-size:14px;color:var(--text);font-family:inherit;outline:none;margin-bottom:14px;"/>
      <div style="display:flex;gap:10px;">
        <button id="adhoc-save-btn" style="flex:1;padding:12px;background:var(--neon);color:#000;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;">Save</button>
        <button id="adhoc-skip-btn" style="padding:12px 16px;background:var(--surface2);color:var(--muted2);border:1px solid var(--border);border-radius:10px;font-size:13px;cursor:pointer;font-family:inherit;">Skip</button>
      </div>
    </div>`;
  overlay.querySelector('#adhoc-save-btn').addEventListener('click', () => {
    const name = overlay.querySelector('#adhoc-name-input')?.value?.trim() || 'Ad Hoc';
    overlay.remove();
    callback(name);
  });
  overlay.querySelector('#adhoc-skip-btn').addEventListener('click', () => {
    overlay.remove();
    callback('Ad Hoc');
  });
  setTimeout(() => overlay.querySelector('input')?.focus(), 100);
  document.body.appendChild(overlay);
}


let activeSession = null;
let globalTimerInterval = null;
let workoutPaused = false;
let pausedAt = null;
let totalPausedMs = 0;
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
  const header = document.querySelector('.workout-header');
  const body = document.getElementById('workout-body');

  if (!activeSession) {
    if (header) header.style.display = 'none';
    body.innerHTML = `
      <div class="wk-idle-wrap">
        <div class="wk-idle-icon">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#CCFF4C" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>
        </div>
        <div class="wk-idle-title">No workout<br>in progress</div>
        <div class="wk-idle-sub">Tap Start Workout on Home, or pick a routine to begin.</div>
        <button class="wk-idle-cta" onclick="openWorkoutPicker()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#CCFF4C" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>
          Start workout
        </button>
      </div>`;
    return;
  }

  if (header) header.style.display = '';
  document.getElementById('active-workout-name').textContent = activeSession.routineName;
  document.getElementById('active-workout-date').textContent =
    new Date(activeSession.startedAt).toLocaleDateString('no-NO', { weekday:'long', day:'numeric', month:'long' });
  const saveBtn = document.getElementById('save-routine-btn');
  const saveLabel = document.getElementById('save-routine-btn-label');
  if (saveBtn) saveBtn.style.display = '';
  if (saveLabel) {
    saveLabel.textContent = activeSession.routineId
      ? 'Save exercise changes to routine'
      : 'Save as new routine';
  }
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
  addExBtn.style.cssText = 'width:100%;margin:12px 0 4px;border:1.5px dashed rgba(200,240,110,0.25);color:#c8f06e;letter-spacing:1px;';
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
    step_up:     '#c8f06e',
    consolidate: '#c8f06e',
    drop:        '#ff4466',
  }[perSet.overallDecision] || '#c8f06e';

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

      const trendColor = s.trend==='↑'?'#c8f06e':s.trend==='↓'?'#ff4466':'rgba(200,240,110,0.45)';
      const repsStr    = s.repsMin===s.repsMax ? `${s.repsMin}` : `${s.repsMin}–${s.repsMax}`;
      const prevStr    = lastPerSet[i] ? `${fmtKg(lastPerSet[i].weight)}kg×${lastPerSet[i].reps}` : '—';

      row.innerHTML =
        `<span style="color:var(--muted2);font-weight:600;">S${i+1}</span>` +
        `<span style="color:var(--muted2);font-size:10px;">${prevStr}</span>` +
        `<span style="color:#e8eaf0;font-weight:700;">${fmtKg(s.weight)}kg × ${repsStr}</span>` +
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
    if (sugg) sugg.style.color = '#c8f06e';
  }
}

function buildExCard(ex, ei) {
  const logged = ex.sets.filter(s => s.state === 'logged').length;
  const total  = ex.sets.length;
  const isUni  = ex.unilateral;

  let setHeaderHTML = isUni
    ? `<div class="set-header-row unilateral"><span></span><span style="text-align:center">KG</span><span style="text-align:center">L</span><span style="text-align:center">R</span></div>`
    : `<div class="set-header-row bilateral"><span></span><span style="text-align:center">KG</span><span style="text-align:center">REPS</span></div>`;

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
      <button class="ex-collapse-bottom" onclick="toggleExCollapse(${ei})">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>
        Minimise
      </button>
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

  let btnLabel, btnClass, btnSublabel;
  if (s.state === 'idle') {
    btnLabel = 'START'; btnClass = 'state-idle'; btnSublabel = '';
  } else if (s.state === 'active') {
    btnLabel = 'STOP'; btnClass = 'state-active';
    btnSublabel = `<span class="set-btn-sublabel" id="set-timer-${ei}-${si}">0:00</span>`;
  } else {
    btnLabel = '✓ SET DONE'; btnClass = 'state-logged';
    btnSublabel = s.setDuration
      ? `<span class="set-btn-sublabel">${formatMMSS(s.setDuration)}</span>`
      : '';
  }

  const inputs = isUni ? `
    <input class="set-input ${gClass(s.weight,s.ghostWeight)}" type="text" inputmode="decimal"
      value="${s.weight}" placeholder="${gPH(s.weight,s.ghostWeight,'kg')}" style="${inputOpacity}"
      ${inputDisabled} oninput="updateSet(${ei},${si},'weight',this.value)" onchange="updateSet(${ei},${si},'weight',this.value)"/>
    <input class="set-input ${gClass(s.repsL,s.ghostRepsL)}" type="number" inputmode="numeric" min="0"
      value="${s.repsL}" placeholder="${gPH(s.repsL,s.ghostRepsL,'L')}" style="${inputOpacity}"
      ${inputDisabled} oninput="updateSet(${ei},${si},'repsL',this.value)" onchange="updateSet(${ei},${si},'repsL',this.value)"/>
    <input class="set-input ${gClass(s.repsR,s.ghostRepsR)}" type="number" inputmode="numeric" min="0"
      value="${s.repsR}" placeholder="${gPH(s.repsR,s.ghostRepsR,'R')}" style="${inputOpacity}"
      ${inputDisabled} oninput="updateSet(${ei},${si},'repsR',this.value)" onchange="updateSet(${ei},${si},'repsR',this.value)"/>` : `
    <input class="set-input ${gClass(s.weight,s.ghostWeight)}" type="text" inputmode="decimal"
      value="${s.weight}" placeholder="${gPH(s.weight,s.ghostWeight,'kg')}" style="${inputOpacity}"
      ${inputDisabled} oninput="updateSet(${ei},${si},'weight',this.value)" onchange="updateSet(${ei},${si},'weight',this.value)"/>
    <input class="set-input ${gClass(s.reps,s.ghostReps)}" type="number" inputmode="numeric" min="0"
      value="${s.reps}" placeholder="${gPH(s.reps,s.ghostReps,'reps')}" style="${inputOpacity}"
      ${inputDisabled} oninput="updateSet(${ei},${si},'reps',this.value)" onchange="updateSet(${ei},${si},'reps',this.value)"/>`;

  return `<div class="set-row ${stateClass}" id="set-row-${ei}-${si}">
    <div class="set-row-top ${isUni?'unilateral':'bilateral'}">
      <div class="set-num" onclick="removeSet(${ei},${si})" title="Tap to remove set" style="cursor:pointer;position:relative;">
        <span class="set-num-label">${si+1}</span>
        <span class="set-num-remove">✕</span>
      </div>
      ${inputs}
    </div>
    <div class="set-note-row">
      <input class="set-note${s.note ? ' set-note--prefilled' : ''}" placeholder="note..." value="${s.note||''}"
        ${inputDisabled} onchange="updateSet(${ei},${si},'note',this.value)"/>
    </div>
    <div class="set-btn-row">
      <button class="set-start-btn ${btnClass}" onclick="handleSetBtn(${ei},${si})">${btnLabel}${btnSublabel}</button>
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
  // Normalise weight: accept comma as decimal separator, store as number
  if (field === 'weight') {
    const normalised = String(val).replace(',', '.');
    const num = parseFloat(normalised);
    activeSession.exercises[ei].sets[si][field] = isNaN(num) ? val : num;
  } else {
    activeSession.exercises[ei].sets[si][field] = val;
  }
  autoSaveSession();
}

function openAddExerciseDuringWorkout() {
  const allEx = load(SK.exercises) || [];
  // Build a simple modal
  const overlay = document.createElement('div');
  overlay.id = 'add-ex-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(7,8,12,0.92);z-index:3000;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding:0 16px 40px;';

  const panel = document.createElement('div');
  panel.style.cssText = 'background:#151824;border:1px solid rgba(200,240,110,0.18);border-radius:16px;padding:20px;width:100%;max-width:420px;max-height:70vh;display:flex;flex-direction:column;';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;';
  header.innerHTML = `<div style="font-family:'Bebas Neue',sans-serif;font-size:18px;letter-spacing:2px;color:#fff;">ADD EXERCISE</div><button onclick="document.getElementById('add-ex-overlay').remove()" style="background:none;border:none;color:#6b7280;font-size:18px;cursor:pointer;">✕</button>`;

  // Search input
  const search = document.createElement('input');
  search.type = 'text'; search.placeholder = 'Search exercises…';
  search.style.cssText = 'background:#0d0f17;border:1px solid rgba(200,240,110,0.15);border-radius:8px;padding:10px 12px;font-size:13px;color:#f0ede8;font-family:inherit;outline:none;margin-bottom:10px;width:100%;';

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

  const card = document.getElementById(`ex-card-${ei}`);
  if (card) {
    // Update equipment button highlights
    card.querySelectorAll('.eq-btn').forEach(btn => {
      btn.classList.toggle('active', btn.textContent === ex.equipment);
    });
    // Update meta line
    const meta = document.getElementById(`ex-meta-${ei}`);
    if (meta) meta.textContent = `${ex.muscle}${ex.unilateral?' · Uni':''} · ${ex.sets.filter(s=>s.state==='logged').length}/${ex.sets.length} sets${ex.equipment?' · '+ex.equipment:''}`;
    // Rebuild suggestion card with new equipment context
    const oldHint = card.querySelector('.hint-card');
    if (oldHint) {
      const newHint = buildSuggestionCard(ei, ex.name, ex.equipment);
      oldHint.replaceWith(newHint);
    }
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

function removeSet(ei, si) {
  if (!activeSession) return;
  const ex = activeSession.exercises[ei];
  if (ex.sets.length <= 1) { showToast('Need at least one set'); return; }
  stopSetTimerDisplay(ei, si);
  ex.sets.splice(si, 1);
  autoSaveSession();
  // Re-render just this exercise's sets
  const container = document.getElementById(`sets-${ei}`);
  if (container) {
    const isUni = ex.unilateral;
    container.innerHTML = ex.sets.map((s, i) => buildSetRow(s, i, ei, isUni)).join('');
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
  if (!activeSession) return;

  // Ad Hoc — create a brand new routine from current exercises
  if (!activeSession.routineId) {
    promptAdHocName(async (name) => {
      if (!activeSession.exercises.length) { showToast('Add at least one exercise first'); return; }
      const routine = {
        id: 'r_' + Date.now(),
        name: name || activeSession.routineName || 'Ad Hoc',
        createdAt: Date.now(),
        exercises: activeSession.exercises.map(ex => ({
          id: ex.id, name: ex.name, muscle: ex.muscle,
          unilateral: ex.unilateral, sets: ex.sets.length,
        })),
      };
      const routines = load(SK.routines) || [];
      routines.push(routine);
      save(SK.routines, routines);
      await dbSaveRoutine(routine);
      showToast(`Routine "${routine.name}" saved ✓`);
    });
    return;
  }

  // Existing routine — update exercises
  showConfirm(
    'Save Routine Changes?',
    'This will update the exercise list and order in the saved routine.',
    () => {
      const routines = load(SK.routines) || [];
      const idx = routines.findIndex(r => r.id === activeSession.routineId);
      if (idx < 0) { showToast('Routine not found'); return; }
      routines[idx].exercises = activeSession.exercises.map(ex => ({
        id: ex.id, name: ex.name, muscle: ex.muscle,
        unilateral: ex.unilateral, sets: ex.sets.length,
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
  workoutPaused = false;
  totalPausedMs = 0;
  pausedAt = null;
  globalTimerInterval = setInterval(() => {
    if (!activeSession || workoutPaused) return;
    const elapsed = Math.floor((Date.now() - activeSession.startedAt - totalPausedMs) / 1000);
    const el = document.getElementById('workout-global-timer');
    if (el) el.textContent = formatMMSS(elapsed);
  }, 1000);
}

function togglePauseWorkout() {
  if (!activeSession) return;
  const btn = document.getElementById('workout-pause-btn');
  if (workoutPaused) {
    // Resume — add paused duration to total
    if (pausedAt) totalPausedMs += Date.now() - pausedAt;
    pausedAt = null;
    workoutPaused = false;
    if (btn) { btn.textContent = 'PAUSE'; btn.classList.remove('paused'); }
  } else {
    // Pause
    pausedAt = Date.now();
    workoutPaused = true;
    if (btn) { btn.textContent = 'RESUME'; btn.classList.add('paused'); }
  }
}

function finishWorkout() {
  showConfirm('Finish Workout?', 'This will save your session and return you to the home screen.', async () => {
    if (!activeSession) return;
    // Account for any time still paused
    const finalPausedMs = totalPausedMs + (workoutPaused && pausedAt ? Date.now() - pausedAt : 0);
    activeSession.duration = Math.floor((Date.now() - activeSession.startedAt - finalPausedMs) / 1000);
    clearInterval(globalTimerInterval);
    workoutPaused = false; pausedAt = null; totalPausedMs = 0;
    clearRestBanner();
    Object.values(setTimers).forEach(t => clearInterval(t.interval));
    setTimers = {};

    activeSession.exercises.forEach(ex => {
      if (ex.startedAt && !ex.duration) {
        ex.duration = Math.floor((Date.now() - ex.startedAt) / 1000);
      }
    });

    // For Ad Hoc workouts, ask for a name first
    if (!activeSession.routineId) {
      promptAdHocName(async (name) => {
        activeSession.routineName = name || 'Ad Hoc';
        await doFinishWorkout(activeSession);
      });
    } else {
      await doFinishWorkout(activeSession);
    }
  });
}

async function doFinishWorkout(session) {
  // Mark as inactive and save
  session.is_active = false;
  await dbSaveSession(session);
  save(SK.activeSession, null);
  _activeSession = null;
  // Clear localStorage so resume banner doesn't appear after finishing
  try { localStorage.removeItem(LS_ACTIVE); } catch(e) {}

  // Update in-memory sessions list
  const existing = _sessions.findIndex(x => x.id === session.id);
  const sessionRecord = {
    id: session.id,
    routineId: session.routineId,
    routineName: session.routineName,
    startedAt: session.startedAt,
    duration: session.duration,
    exercises: session.exercises,
  };
  if (existing >= 0) _sessions[existing] = sessionRecord;
  else _sessions.push(sessionRecord);

  activeSession = null;
  showToast('Workout saved! 💪');
  showPage('home', document.getElementById('nav-home'));
  renderHome();

  if (stravaConnected) {
    setTimeout(() => showStravaUploadPrompt(session), 800);
  }
}

const LS_ACTIVE = 'sg_active_session';

function autoSaveSession() {
  if (activeSession) {
    // Write to localStorage first — survives app kill / swipe-up on iOS
    try { localStorage.setItem(LS_ACTIVE, JSON.stringify(activeSession)); } catch(e) {}
    dbSaveSession(activeSession); // Supabase in the background
  } else {
    try { localStorage.removeItem(LS_ACTIVE); } catch(e) {}
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

// ═══════════════════════════════════════════
// MUSCLE BODY MAP — powered by body-muscles
// ═══════════════════════════════════════════

// Map our primaryMuscle names → body-muscles IDs (both left+right)
const PM_TO_BODY_IDS = {
  'Pecs':                  ['chest-upper-left','chest-upper-right','chest-lower-left','chest-lower-right'],
  'Upper Pecs':            ['chest-upper-left','chest-upper-right'],
  'Lower Pecs':            ['chest-lower-left','chest-lower-right'],
  'Front Delts':           ['shoulder-front-left','shoulder-front-right'],
  'Side Delts':            ['shoulder-side-left','shoulder-side-right'],
  'Rear Delts':            ['deltoid-rear-left','deltoid-rear-right'],
  'Biceps':                ['biceps-left','biceps-right'],
  'Brachialis':            ['biceps-left','biceps-right'],
  'Brachioradialis':       ['forearm-left','forearm-right','forearm-flexors-left','forearm-flexors-right'],
  'Abs':                   ['abs-upper-left','abs-upper-right','abs-lower-left','abs-lower-right'],
  'Obliques':              ['obliques-left','obliques-right'],
  'Transverse Abdominis':  ['abs-lower-left','abs-lower-right'],
  'Quads':                 ['quads-left','quads-right'],
  'Hip Flexors':           ['hip-flexor-left','hip-flexor-right'],
  'Adductors':             ['adductors-left','adductors-right'],
  'Calves':                ['calves-gastroc-medial-left','calves-gastroc-lateral-left','calves-gastroc-medial-right','calves-gastroc-lateral-right'],
  'Lats':                  ['lats-upper-left','lats-mid-left','lats-lower-left','lats-upper-right','lats-mid-right','lats-lower-right'],
  'Traps':                 ['traps-upper-left','traps-mid-left','traps-lower-left','traps-upper-right','traps-mid-right','traps-lower-right'],
  'Rhomboids':             ['traps-mid-left','traps-mid-right'],
  'Erectors':              ['lower-back-erectors-left','lower-back-erectors-right'],
  'Triceps':               ['triceps-long-left','triceps-lateral-left','triceps-long-right','triceps-lateral-right'],
  'Triceps Long Head':     ['triceps-long-left','triceps-long-right'],
  'Triceps Lateral Head':  ['triceps-lateral-left','triceps-lateral-right'],
  'Triceps Medial Head':   ['triceps-lateral-left','triceps-lateral-right'],
  'Glutes':                ['gluteus-maximus-left','gluteus-maximus-right','gluteus-medius-left','gluteus-medius-right'],
  'Hamstrings':            ['hamstrings-medial-left','hamstrings-lateral-left','hamstrings-medial-right','hamstrings-lateral-right'],
};

let _bodyMusclesLib = null;

function getBodyMusclesLib() {
  if (_bodyMusclesLib) return _bodyMusclesLib;
  if (typeof window.BodyMuscles !== 'undefined') {
    _bodyMusclesLib = window.BodyMuscles;
    return _bodyMusclesLib;
  }
  return null;
}

 //
 // Build a bodyState object for body-muscles library from muscle data.
 // @param {Object} muscleData - { 'Quads': 24, 'Pecs': 12, ... }
 // @param {boolean} heatMode - scale 0-10 by relative volume, or binary 0/10

function buildBodyState(muscleData, secondaryMuscleData, heatMode) {
  const bodyState = {};
  const allVals = [...Object.values(muscleData), ...Object.values(secondaryMuscleData).map(v => v * 0.5)].filter(v => v > 0);
  const maxVal = allVals.length ? Math.max(...Object.values(muscleData)) : 1;

  // Primary muscles — full intensity
  Object.entries(muscleData).forEach(([pm, val]) => {
    if (!val) return;
    const ids = PM_TO_BODY_IDS[pm];
    if (!ids) return;
    const intensity = heatMode ? Math.max(1, Math.round((val / maxVal) * 10)) : 10;
    ids.forEach(id => {
      if (!bodyState[id] || bodyState[id].intensity < intensity) {
        bodyState[id] = { intensity, selected: false };
      }
    });
  });

  // Secondary muscles — half intensity, don't override primary
  Object.entries(secondaryMuscleData).forEach(([pm, val]) => {
    if (!val) return;
    const ids = PM_TO_BODY_IDS[pm];
    if (!ids) return;
    const intensity = heatMode ? Math.max(1, Math.round((val / maxVal) * 5)) : 5;
    ids.forEach(id => {
      if (!bodyState[id]) {
        bodyState[id] = { intensity, selected: false };
      }
      // Don't override if primary already set it higher
    });
  });

  return bodyState;
}

 //
 // Render a muscle map into a container div using body-muscles library.
 // Returns { frontChart, backChart } or null if library not available.

function renderMuscleMap(containerId, muscleData, heatMode = false, secondaryData = {}) {
  const container = document.getElementById(containerId);
  if (!container) return null;

  const lib = getBodyMusclesLib();
  if (!lib) {
    container.innerHTML = `<div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:rgba(241,236,226,0.28);letter-spacing:0.06em;padding:12px 0;text-align:center;">Set primary muscles on exercises to enable the body map</div>`;
    return null;
  }

  const bodyState = buildBodyState(muscleData, secondaryData, heatMode);
  container.innerHTML = '';

  // Tooltip element
  const tooltip = document.createElement('div');
  tooltip.className = 'muscle-map-tooltip';
  tooltip.style.display = 'none';
  container.appendChild(tooltip);

  // Expand button
  const expandBtn = document.createElement('button');
  expandBtn.className = 'muscle-map-expand-btn';
  expandBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg> Expand`;
  expandBtn.onclick = () => openFullscreenMap(muscleData, secondaryData, heatMode);
  container.appendChild(expandBtn);

  // Maps wrap
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:4px;justify-content:center;';

  const frontEl = document.createElement('div');
  frontEl.style.cssText = 'flex:1;max-width:48%;';
  const backEl = document.createElement('div');
  backEl.style.cssText = 'flex:1;max-width:48%;';

  wrap.appendChild(frontEl);
  wrap.appendChild(backEl);
  container.appendChild(wrap);

  function onMuscleClick(id, name) {
    tooltip.textContent = name;
    tooltip.style.display = 'block';
    clearTimeout(tooltip._timer);
    tooltip._timer = setTimeout(() => { tooltip.style.display = 'none'; }, 2500);
  }

  const frontChart = new lib.BodyChart(frontEl, {
    view: lib.ViewSide.FRONT, bodyState, enableTransitions: false,
    onMuscleClick,
  });
  const backChart = new lib.BodyChart(backEl, {
    view: lib.ViewSide.BACK, bodyState, enableTransitions: false,
    onMuscleClick,
  });

  return { frontChart, backChart };
}

function openFullscreenMap(muscleData, secondaryData, heatMode) {
  const lib = getBodyMusclesLib();
  if (!lib) return;

  const overlay = document.createElement('div');
  overlay.className = 'muscle-map-fullscreen';
  overlay.innerHTML = `
    <div class="muscle-map-fs-header">
      <span class="muscle-map-fs-title">Muscle Map</span>
      <button class="muscle-map-fs-close" onclick="this.closest('.muscle-map-fullscreen').remove()">✕</button>
    </div>
    <div class="muscle-map-fs-tooltip" id="fs-tooltip" style="display:none;"></div>
    <div class="muscle-map-fs-body">
      <div class="muscle-map-fs-col"><div class="muscle-map-fs-lbl">FRONT</div><div id="fs-front"></div></div>
      <div class="muscle-map-fs-col"><div class="muscle-map-fs-lbl">BACK</div><div id="fs-back"></div></div>
    </div>
    <div class="muscle-map-fs-hint">Tap any muscle to see its name</div>`;

  document.body.appendChild(overlay);

  const bodyState = buildBodyState(muscleData, secondaryData, heatMode);

  function onMuscleClick(id, name) {
    const tt = document.getElementById('fs-tooltip');
    if (!tt) return;
    tt.textContent = name;
    tt.style.display = 'block';
    clearTimeout(tt._timer);
    tt._timer = setTimeout(() => { tt.style.display = 'none'; }, 3000);
  }

  setTimeout(() => {
    new lib.BodyChart(document.getElementById('fs-front'), {
      view: lib.ViewSide.FRONT, bodyState, enableTransitions: false, onMuscleClick,
    });
    new lib.BodyChart(document.getElementById('fs-back'), {
      view: lib.ViewSide.BACK, bodyState, enableTransitions: false, onMuscleClick,
    });
  }, 50);
}

// Legacy shim — keep old call signature working
function buildMuscleMapSVG() { return ''; }
function buildMusclDataFromExercises(exercises, heatMode) {
  const data = {};
  (exercises || []).forEach(ex => {
    const pm = ex.primaryMuscle;
    if (!pm) return;
    if (heatMode) {
      const sets = Array.isArray(ex.sets)
        ? ex.sets.filter(s => s.logged || s.state === 'logged').length || 1
        : (ex.sets || 1);
      data[pm] = (data[pm] || 0) + sets;
    } else {
      data[pm] = 1;
    }
  });
  return data;
}

const MUSCLE_MAP_REGIONS = {
  'Upper Pecs':          { cx:78,  cy:106, rx:17, ry:11, side:'front' },
  'Lower Pecs':          { cx:78,  cy:120, rx:14, ry:8,  side:'front' },
  'Pecs':                { cx:78,  cy:112, rx:17, ry:16, side:'front' },
  'Front Delts':         { cx:44,  cy:100, rx:10, ry:10, side:'front' },
  'Side Delts':          { cx:38,  cy:109, rx:9,  ry:10, side:'front' },
  'Biceps':              { cx:36,  cy:130, rx:8,  ry:14, side:'front' },
  'Brachialis':          { cx:36,  cy:145, rx:7,  ry:7,  side:'front' },
  'Brachioradialis':     { cx:35,  cy:157, rx:6,  ry:8,  side:'front' },
  'Abs':                 { cx:78,  cy:145, rx:12, ry:20, side:'front' },
  'Obliques':            { cx:63,  cy:148, rx:8,  ry:16, side:'front' },
  'Transverse Abdominis':{ cx:78,  cy:155, rx:10, ry:10, side:'front' },
  'Quads':               { cx:72,  cy:218, rx:14, ry:27, side:'front' },
  'Hip Flexors':         { cx:78,  cy:185, rx:10, ry:9,  side:'front' },
  'Adductors':           { cx:84,  cy:218, rx:7,  ry:20, side:'front' },
  'Calves':              { cx:72,  cy:288, rx:9,  ry:17, side:'front' },
  'Lats':                { cx:128, cy:128, rx:15, ry:22, side:'back' },
  'Traps':               { cx:122, cy:97,  rx:17, ry:11, side:'back' },
  'Rhomboids':           { cx:122, cy:111, rx:11, ry:9,  side:'back' },
  'Rear Delts':          { cx:158, cy:100, rx:10, ry:10, side:'back' },
  'Erectors':            { cx:122, cy:148, rx:7,  ry:18, side:'back' },
  'Triceps Long Head':   { cx:162, cy:128, rx:7,  ry:13, side:'back' },
  'Triceps Lateral Head':{ cx:156, cy:133, rx:6,  ry:11, side:'back' },
  'Triceps Medial Head': { cx:160, cy:143, rx:5,  ry:7,  side:'back' },
  'Triceps':             { cx:160, cy:133, rx:8,  ry:16, side:'back' },
  'Hamstrings':          { cx:126, cy:218, rx:14, ry:27, side:'back' },
  'Glutes':              { cx:122, cy:184, rx:17, ry:15, side:'back' },
};

const BODY_SVG_FRONT = `
  <ellipse cx="74" cy="72" rx="12" ry="13" fill="#111113" stroke="rgba(200,240,110,0.15)" stroke-width="0.8"/>
  <rect x="70" y="83" width="8" height="8" fill="#111113" stroke="rgba(200,240,110,0.15)" stroke-width="0.8"/>
  <path d="M55,90 Q50,95 50,150 L50,175 Q55,180 74,180 Q93,180 98,175 L98,150 Q98,95 93,90 Z" fill="#111113" stroke="rgba(200,240,110,0.15)" stroke-width="0.8"/>
  <path d="M55,175 Q48,185 50,200 L98,200 Q100,185 93,175 Z" fill="#111113" stroke="rgba(200,240,110,0.15)" stroke-width="0.8"/>
  <path d="M55,92 Q44,95 40,120 Q38,140 38,165 Q42,168 46,165 Q48,140 50,120 Q52,100 58,95 Z" fill="#111113" stroke="rgba(200,240,110,0.15)" stroke-width="0.8"/>
  <path d="M93,92 Q104,95 108,120 Q110,140 110,165 Q106,168 102,165 Q100,140 98,120 Q96,100 90,95 Z" fill="#111113" stroke="rgba(200,240,110,0.15)" stroke-width="0.8"/>
  <path d="M40,162 Q38,180 40,200 Q43,202 46,200 Q48,180 46,162 Z" fill="#111113" stroke="rgba(200,240,110,0.15)" stroke-width="0.8"/>
  <path d="M108,162 Q110,180 108,200 Q105,202 102,200 Q100,180 102,162 Z" fill="#111113" stroke="rgba(200,240,110,0.15)" stroke-width="0.8"/>
  <path d="M56,198 Q52,210 52,260 Q54,275 60,275 Q66,275 68,260 Q70,210 70,198 Z" fill="#111113" stroke="rgba(200,240,110,0.15)" stroke-width="0.8"/>
  <path d="M82,198 Q86,210 96,260 Q94,275 88,275 Q82,275 80,260 Q78,210 78,198 Z" fill="#111113" stroke="rgba(200,240,110,0.15)" stroke-width="0.8"/>
  <path d="M52,272 Q50,295 54,312 Q58,316 63,312 Q67,295 66,272 Z" fill="#111113" stroke="rgba(200,240,110,0.15)" stroke-width="0.8"/>
  <path d="M82,272 Q80,295 84,312 Q88,316 93,312 Q97,295 96,272 Z" fill="#111113" stroke="rgba(200,240,110,0.15)" stroke-width="0.8"/>`;

const BODY_SVG_BACK = `
  <ellipse cx="128" cy="72" rx="12" ry="13" fill="#111113" stroke="rgba(200,240,110,0.15)" stroke-width="0.8"/>
  <rect x="124" y="83" width="8" height="8" fill="#111113" stroke="rgba(200,240,110,0.15)" stroke-width="0.8"/>
  <path d="M109,90 Q104,95 104,150 L104,175 Q109,180 128,180 Q147,180 152,175 L152,150 Q152,95 147,90 Z" fill="#111113" stroke="rgba(200,240,110,0.15)" stroke-width="0.8"/>
  <path d="M109,175 Q102,185 104,200 L152,200 Q154,185 147,175 Z" fill="#111113" stroke="rgba(200,240,110,0.15)" stroke-width="0.8"/>
  <path d="M109,92 Q98,95 94,120 Q92,140 92,165 Q96,168 100,165 Q102,140 104,120 Q106,100 112,95 Z" fill="#111113" stroke="rgba(200,240,110,0.15)" stroke-width="0.8"/>
  <path d="M147,92 Q158,95 162,120 Q164,140 164,165 Q160,168 156,165 Q154,140 152,120 Q150,100 144,95 Z" fill="#111113" stroke="rgba(200,240,110,0.15)" stroke-width="0.8"/>
  <path d="M94,162 Q92,180 94,200 Q97,202 100,200 Q102,180 100,162 Z" fill="#111113" stroke="rgba(200,240,110,0.15)" stroke-width="0.8"/>
  <path d="M162,162 Q164,180 162,200 Q159,202 156,200 Q154,180 156,162 Z" fill="#111113" stroke="rgba(200,240,110,0.15)" stroke-width="0.8"/>
  <path d="M110,198 Q106,210 106,260 Q108,275 114,275 Q120,275 122,260 Q124,210 124,198 Z" fill="#111113" stroke="rgba(200,240,110,0.15)" stroke-width="0.8"/>
  <path d="M146,198 Q150,210 150,260 Q148,275 142,275 Q136,275 134,260 Q132,210 132,198 Z" fill="#111113" stroke="rgba(200,240,110,0.15)" stroke-width="0.8"/>
  <path d="M106,272 Q104,295 108,312 Q112,316 117,312 Q121,295 120,272 Z" fill="#111113" stroke="rgba(200,240,110,0.15)" stroke-width="0.8"/>
  <path d="M136,272 Q134,295 138,312 Q142,316 147,312 Q151,295 150,272 Z" fill="#111113" stroke="rgba(200,240,110,0.15)" stroke-width="0.8"/>`;

 //
 // Build muscle map SVG string.
 // @param {Object} muscleData - { 'Quads': 1 } for binary, or { 'Quads': 24 } for heat

function saveSplits() {
  if (!USER_ID || USER_ID === 'pending') return;
  localStorage.setItem(`sg_splits_${USER_ID}`, JSON.stringify(_splits));
  // Upsert each split individually and log any errors
  _splits.forEach(split => {
    supabaseFetch('user_splits', 'on_conflict=id', 'POST', {
      id: split.id,
      user_id: USER_ID,
      name: split.name,
    }).catch(e => console.warn('saveSplits error:', e.message));
  });
}

async function dbLoadSplits() {
  // Load from localStorage first for instant display
  try {
    const raw = localStorage.getItem(`sg_splits_${USER_ID}`);
    if (raw) _splits = JSON.parse(raw);
  } catch(e) {}

  // Sync from Supabase
  try {
    const data = await supabaseFetch('user_splits', `select=id,name&user_id=eq.${USER_ID}&order=created_at.asc`);
    if (data && data.length) {
      _splits = data.map(s => ({ id: s.id, name: s.name }));
      localStorage.setItem(`sg_splits_${USER_ID}`, JSON.stringify(_splits));
    }
  } catch(e) {
    console.warn('dbLoadSplits Supabase failed:', e.message);
  }
}

function createSplit() {
  const name = prompt('Split name (e.g. ULUL, PPL, Full Body):', '');
  if (!name || !name.trim()) return;
  const split = { id: 'split_' + Date.now(), name: name.trim() };
  _splits.push(split);
  // Save to localStorage immediately
  localStorage.setItem(`sg_splits_${USER_ID}`, JSON.stringify(_splits));
  // Upsert to Supabase with visible error if it fails
  supabaseFetch('user_splits', 'on_conflict=id', 'POST', {
    id: split.id,
    user_id: USER_ID,
    name: split.name,
  }).then(() => {
    console.log('Split saved to Supabase:', split.name);
  }).catch(e => {
    console.warn('Split Supabase save failed:', e.message);
    showToast('Split saved locally — sync failed: ' + e.message);
  });
  renderRoutines();
}

function renameSplit(splitId) {
  const split = _splits.find(s => s.id === splitId);
  if (!split) return;
  const name = prompt('Rename split:', split.name);
  if (!name || !name.trim()) return;
  split.name = name.trim();
  saveSplits();
  renderRoutines();
}

function deleteSplit(splitId) {
  showConfirm('Delete split?', 'Routines in this split will be moved to ungrouped.', () => {
    _splits = _splits.filter(s => s.id !== splitId);
    // Unassign routines from this split
    const routines = load(SK.routines) || [];
    routines.forEach(r => { if (r.splitId === splitId) delete r.splitId; });
    save(SK.routines, routines);
    routines.forEach(r => dbSaveRoutine(r));
    // Delete from Supabase and localStorage
    supabaseFetch(`user_splits?id=eq.${splitId}&user_id=eq.${USER_ID}`, '', 'DELETE').catch(() => {});
    localStorage.setItem(`sg_splits_${USER_ID}`, JSON.stringify(_splits));
    renderRoutines();
  });
}

function assignRoutineToSplit(routineId, splitId) {
  const routines = load(SK.routines) || [];
  const r = routines.find(x => x.id === routineId);
  if (!r) return;
  r.splitId = splitId || null;
  save(SK.routines, routines);
  dbSaveRoutine(r);
  renderRoutines();
}

function renderRoutines() {
  const routines = load(SK.routines) || [];
  const splits   = _splits || [];
  const list = document.getElementById('routines-list');

  if (routines.length === 0 && splits.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div><div class="empty-state-text">No routines yet</div></div>';
    return;
  }

  const makeRoutineCard = (r) => `
    <div class="routine-card">
      <div class="routine-card-header" onclick="toggleRoutineCard(this.parentElement)">
        <div>
          <div class="routine-card-name">${r.name}</div>
          <div class="routine-card-meta">${r.exercises.length} exercise${r.exercises.length !== 1 ? 's' : ''}</div>
        </div>
        <div class="routine-card-actions" onclick="event.stopPropagation()">
          ${splits.length ? `<select class="routine-split-select" onchange="assignRoutineToSplit('${r.id}',this.value)" onclick="event.stopPropagation()">
            <option value="">No split</option>
            ${splits.map(s=>`<option value="${s.id}" ${r.splitId===s.id?'selected':''}>${s.name}</option>`).join('')}
          </select>` : ''}
          <button onclick="openRoutineEditor('${r.id}')" title="Edit">✎</button>
          <button onclick="deleteRoutine('${r.id}')" title="Delete">✕</button>
        </div>
        <span class="routine-chevron">›</span>
      </div>
      <div class="routine-card-body">
        ${(() => {
          const allEx = load(SK.exercises) || [];
          const primaryData = {};
          const secondaryData = {};
          r.exercises.forEach(ex => {
            const libEx = allEx.find(e => e.id === ex.id || e.name === ex.name);
            const pm = libEx?.primaryMuscle || ex.primaryMuscle;
            if (pm) primaryData[pm] = 1;
            (libEx?.secondaryMuscles || ex.secondaryMuscles || []).forEach(sm => { secondaryData[sm] = 1; });
          });
          const hasPrimary = Object.keys(primaryData).length > 0;
          const mapId = `routine-map-${r.id}`;
          if (hasPrimary) {
            setTimeout(() => renderMuscleMap(mapId, primaryData, false, secondaryData), 0);
            return `<div id="${mapId}" class="routine-muscle-map"></div>`;
          }
          return '';
        })()}
        ${r.exercises.map(ex => `
          <div class="routine-ex-item">
            <div class="routine-ex-info">
              <div class="routine-ex-name">${ex.name}</div>
              <div class="routine-ex-tags">
                <span class="tag">${ex.muscle}</span>
                ${ex.primaryMuscle ? `<span class="tag" style="color:rgba(200,240,110,0.7);border-color:rgba(200,240,110,0.25);">${ex.primaryMuscle}</span>` : ''}
                <span class="tag">${ex.sets} sets</span>
                ${ex.unilateral ? '<span class="tag unilateral">Uni</span>' : ''}
              </div>
            </div>
          </div>
        `).join('')}
        <button class="routine-start-btn" onclick="startWorkout('${r.id}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
          Start Workout
        </button>
      </div>
    </div>`;

  let html = '';

  // Render splits with their routines
  splits.forEach(split => {
    const splitRoutines = routines.filter(r => r.splitId === split.id);
    html += `
      <div class="split-group">
        <div class="split-group-header">
          <span class="split-group-name">${split.name}</span>
          <span class="split-group-count">${splitRoutines.length} routine${splitRoutines.length !== 1 ? 's' : ''}</span>
          <div class="split-group-actions">
            <button onclick="renameSplit('${split.id}')" title="Rename">✎</button>
            <button onclick="deleteSplit('${split.id}')" title="Delete">✕</button>
          </div>
        </div>
        ${splitRoutines.length
          ? splitRoutines.map(makeRoutineCard).join('')
          : '<div class="split-empty">No routines in this split yet — assign one using the dropdown on a routine.</div>'}
      </div>`;
  });

  // Ungrouped routines
  const ungrouped = routines.filter(r => !r.splitId || !splits.find(s => s.id === r.splitId));
  if (ungrouped.length) {
    if (splits.length) {
      html += `<div class="split-group-header" style="margin-top:8px;">
        <span class="split-group-name" style="color:rgba(241,236,226,0.35);">Ungrouped</span>
        <span class="split-group-count">${ungrouped.length}</span>
      </div>`;
    }
    html += ungrouped.map(makeRoutineCard).join('');
  }

  list.innerHTML = html;
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
        <div class="routine-ex-name">${ex.name}</div>
        <div class="routine-ex-tags" style="margin-top:4px;">
          <span class="tag">${ex.muscle}</span>
          ${ex.unilateral ? '<span class="tag unilateral">Uni</span>' : ''}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
        <input type="number" value="${ex.sets}" min="1" max="20"
          oninput="updateEditorExSets(${i},this.value)"
          onchange="updateEditorExSets(${i},this.value)"/>
        <span class="sets-label">sets</span>
      </div>
      <button class="btn-icon" onclick="removeEditorEx(${i})">✕</button>
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
  _pickerFiltered = q
    ? allEx.filter(e => e.name.toLowerCase().includes(q) || (e.muscle||'').toLowerCase().includes(q))
    : [...allEx].sort((a,b) => {
        const ai = MUSCLE_GROUPS.indexOf(a.muscle), bi = MUSCLE_GROUPS.indexOf(b.muscle);
        if (ai !== bi) return (ai<0?99:ai) - (bi<0?99:bi);
        return a.name.localeCompare(b.name);
      });

  const results = document.getElementById('ex-picker-results');
  let html = '';

  if (!q) {
    // Grouped by muscle
    const groups = {};
    _pickerFiltered.forEach((ex, i) => {
      const m = normaliseMuscle(ex.muscle) || 'Other';
      if (!groups[m]) groups[m] = [];
      groups[m].push({ ex, i });
    });
    const order = [...MUSCLE_GROUPS, 'Other'];
    order.forEach(muscle => {
      if (!groups[muscle]) return;
      html += `<div class="ex-picker-group-label">${muscle}</div>`;
      html += groups[muscle].map(({ ex, i }) => `
        <div class="ex-search-item" onclick="selectExerciseFromPicker(${i})">
          <span class="ex-search-item-name">${ex.name}</span>
          ${ex.unilateral ? '<span class="ex-search-item-muscle">Uni</span>' : ''}
        </div>`).join('');
    });
  } else {
    // Flat filtered list
    html = _pickerFiltered.map((ex, i) => `
      <div class="ex-search-item" onclick="selectExerciseFromPicker(${i})">
        <span class="ex-search-item-name">${ex.name}</span>
        <span class="ex-search-item-muscle">${ex.muscle||''}${ex.unilateral ? ' · Uni' : ''}</span>
      </div>`).join('');
  }

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
  document.getElementById('ex-picker-uni').checked = false;
  document.getElementById('ex-picker-results').innerHTML = '';
  selectedMuscle = '';
  renderMusclePicker('ex-picker-muscle-grid');
}

function hideNewExForm() {
  document.getElementById('ex-picker-new-form').style.display = 'none';
  filterExPicker(document.getElementById('ex-picker-search').value);
}

// Ensure all exercises from a workout are present in the exercise library
function syncWorkoutExercisesToLibrary(exercises) {
  const allEx = load(SK.exercises) || [];
  const knownIds = new Set(allEx.map(e => e.id));
  const knownNames = new Set(allEx.map(e => e.name.toLowerCase()));
  let changed = false;
  (exercises || []).forEach(ex => {
    if (!ex.name) return;
    if (!knownIds.has(ex.id) && !knownNames.has(ex.name.toLowerCase())) {
      const libEx = { id: ex.id || ('ex_' + Date.now() + '_' + Math.random().toString(36).slice(2)), name: ex.name, muscle: ex.muscle || 'Other', unilateral: !!ex.unilateral };
      allEx.push(libEx);
      knownIds.add(libEx.id);
      knownNames.add(libEx.name.toLowerCase());
      dbSaveExercise(libEx);
      changed = true;
    }
  });
  if (changed) {
    save(SK.exercises, allEx);
    if (document.getElementById('page-exercises')?.classList.contains('active')) renderExerciseLibrary();
  }
}

function addExToRoutine(ex) {
  if (_editingSessionPickerMode) {
    // Adding to a saved session being edited
    _editingSessionPickerMode = false;
    if (!_editingSession) return;
    const sets = parseInt(document.getElementById('ex-picker-sets')?.value) || 3;
    const newSets = Array.from({length:sets}, () => ({ logged:true, weight:'', reps:'', repsL:'', repsR:'', note:'' }));
    _editingSession.exercises.push({ ...ex, sets:newSets });
    closeModal('exercise-picker');
    renderSessionBody(_editingSession);
    return;
  }

  if (_sessionPickerMode) {
    // Adding to active workout session
    _sessionPickerMode = false;
    if (!activeSession) return;
    const sets = parseInt(document.getElementById('ex-picker-sets')?.value)||3;
    const newSets = Array.from({length:sets}, () => ({ state:'idle', weight:'', reps:'', repsL:'', repsR:'', note:'' }));
    activeSession.exercises.push({ ...ex, sets:newSets, collapsed:false });
    autoSaveSession();
    closeModal('exercise-picker');
    renderWorkoutBody();
    return;
  }

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
  // Always navigate to routines page and render after saving
  showPage('routines', document.getElementById('nav-routines'));
  renderRoutines();
  showToast('Routine saved!');
}

// ═══════════════════════════════════════════
// EXERCISE LIBRARY PAGE
// ═══════════════════════════════════════════
let libMuscleFilter = 'All';
let editingExId = null;
let selectedMuscle = '';
let selectedPrimaryMuscle = '';
let selectedSecondaryMuscles = []; // array — multiple allowed

function selectMuscle(muscle, containerId) {
  selectedMuscle = muscle;
  selectedPrimaryMuscle = '';
  selectedSecondaryMuscles = [];
  renderMusclePicker(containerId);
  if (containerId === 'ex-lib-muscle-grid') {
    const wrap = document.getElementById('ex-lib-primary-wrap');
    if (wrap) wrap.style.display = selectedMuscle ? '' : 'none';
    renderPrimaryMusclePicker('ex-lib-primary-grid', containerId);
    renderSecondaryMusclePicker('ex-lib-secondary-grid');
  }
}

function selectPrimaryMuscle(muscle, containerId) {
  selectedPrimaryMuscle = muscle;
  renderPrimaryMusclePicker(containerId.replace('primary-grid','primary-grid'), containerId);
  // Re-render secondary excluding primary
  renderSecondaryMusclePicker('ex-lib-secondary-grid');
}

function toggleSecondaryMuscle(muscle) {
  const idx = selectedSecondaryMuscles.indexOf(muscle);
  if (idx >= 0) selectedSecondaryMuscles.splice(idx, 1);
  else selectedSecondaryMuscles.push(muscle);
  renderSecondaryMusclePicker('ex-lib-secondary-grid');
}

function renderSecondaryMusclePicker(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const options = (PRIMARY_MUSCLES[selectedMuscle] || [])
    .filter(m => m !== selectedPrimaryMuscle);
  if (!options.length) { el.innerHTML = ''; return; }
  el.innerHTML = options.map(m => {
    const active = selectedSecondaryMuscles.includes(m);
    return `<button class="muscle-btn secondary-btn ${active ? 'active' : ''}"
      onclick="toggleSecondaryMuscle('${m}')">${m}</button>`;
  }).join('');
}

function renderPrimaryMusclePicker(containerId, parentContainerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const options = PRIMARY_MUSCLES[selectedMuscle] || [];
  if (!options.length) { el.innerHTML = ''; return; }
  el.innerHTML = options.map(m => `
    <button class="muscle-btn ${selectedPrimaryMuscle === m ? 'active' : ''}"
      onclick="selectPrimaryMuscle('${m}','${containerId}')">${m}</button>
  `).join('');
}

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
  const filtered = libMuscleFilter === 'All' ? allEx : allEx.filter(e => normaliseMuscle(e.muscle) === libMuscleFilter);
  const list = document.getElementById('exercises-list');

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🏋️</div><div class="empty-state-text">No exercises yet</div></div>';
    return;
  }

  // Group by muscle
  const groups = {};
  filtered.forEach(ex => {
    const exMuscle = normaliseMuscle(ex.muscle); if (!groups[exMuscle]) groups[exMuscle] = [];
    groups[exMuscle].push(ex);
  });

  list.innerHTML = Object.entries(groups).sort((a,b) => a[0].localeCompare(b[0])).map(([muscle, exs]) => `
    <div style="margin-bottom:4px;">
      <div class="ex-lib-group-title">${muscle}</div>
      ${exs.map(ex => `
        <div class="ex-lib-item">
          <div class="ex-lib-info">
            <div class="ex-lib-name">${ex.name}</div>
            <div class="ex-lib-tags">
              ${ex.primaryMuscle ? `<span class="tag" style="color:rgba(200,240,110,0.7);border-color:rgba(200,240,110,0.25);">${ex.primaryMuscle}</span>` : ''}
              ${ex.unilateral ? '<span class="tag unilateral">Uni</span>' : ''}
            </div>
          </div>
          <div class="ex-lib-actions">
            <button onclick="openExerciseLibEditor('${ex.id}')" title="Edit">✎</button>
            <button onclick="deleteExerciseLib('${ex.id}')" title="Delete">✕</button>
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
  document.getElementById('ex-lib-editor-title').textContent = exId ? 'Edit Exercise' : 'New Exercise';

  if (exId) {
    const allEx = load(SK.exercises) || [];
    const ex = allEx.find(e => e.id === exId);
    if (ex) {
      document.getElementById('ex-lib-name').value = ex.name;
      selectedMuscle = ex.muscle || '';
      selectedPrimaryMuscle = ex.primaryMuscle || '';
      selectedSecondaryMuscles = Array.isArray(ex.secondaryMuscles) ? [...ex.secondaryMuscles] : [];
      const isUni = !!ex.unilateral;
      renderMusclePicker('ex-lib-muscle-grid');
      const wrap = document.getElementById('ex-lib-primary-wrap');
      if (wrap) wrap.style.display = selectedMuscle ? '' : 'none';
      renderPrimaryMusclePicker('ex-lib-primary-grid', 'ex-lib-muscle-grid');
      const secWrap = document.getElementById('ex-lib-secondary-wrap');
      if (secWrap) secWrap.style.display = selectedMuscle ? '' : 'none';
      renderSecondaryMusclePicker('ex-lib-secondary-grid');
      openModal('exercise-lib-editor');
      setTimeout(() => {
        const cb = document.getElementById('ex-lib-uni');
        if (cb) { cb.checked = isUni; cb.defaultChecked = isUni; }
      }, 50);
      return;
    }
  }

  selectedMuscle = '';
  selectedPrimaryMuscle = '';
  selectedSecondaryMuscles = [];
  renderMusclePicker('ex-lib-muscle-grid');
  const wrap = document.getElementById('ex-lib-primary-wrap');
  if (wrap) wrap.style.display = 'none';
  const secWrap2 = document.getElementById('ex-lib-secondary-wrap');
  if (secWrap2) secWrap2.style.display = 'none';
  openModal('exercise-lib-editor');
}

function renderMusclePicker(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = MUSCLE_GROUPS.map(m => `
    <button class="muscle-btn ${selectedMuscle === m ? 'active' : ''}"
      onclick="selectMuscle('${m}','${containerId}')">${m}</button>
  `).join('');
  // Show/update primary muscle picker for lib editor
  if (containerId === 'ex-lib-muscle-grid') {
    const wrap = document.getElementById('ex-lib-primary-wrap');
    if (wrap) wrap.style.display = selectedMuscle ? '' : 'none';
    renderPrimaryMusclePicker('ex-lib-primary-grid', containerId);
  }
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
    if (idx >= 0) { allEx[idx] = { ...allEx[idx], name, muscle: selectedMuscle, primaryMuscle: selectedPrimaryMuscle||null, secondaryMuscles: [...selectedSecondaryMuscles], unilateral }; savedEx = allEx[idx]; }
  } else {
    savedEx = { id: 'ex_' + Date.now(), name, muscle: selectedMuscle, primaryMuscle: selectedPrimaryMuscle||null, secondaryMuscles: [...selectedSecondaryMuscles], unilateral };
    allEx.push(savedEx);
  }
  save(SK.exercises, allEx);
  if (savedEx) dbSaveExercise(savedEx);

  // Propagate name/muscle/unilateral changes to all routines that contain this exercise
  let routinesUpdated = false;
  if (editingExId) {
    const routines = load(SK.routines) || [];
    routines.forEach(r => {
      r.exercises.forEach(ex => {
        if (ex.id === editingExId || ex.name === savedEx.name) {
          ex.name = name; ex.muscle = selectedMuscle; ex.unilateral = unilateral;
          routinesUpdated = true;
        }
      });
    });
    if (routinesUpdated) {
      save(SK.routines, routines);
      Promise.all(routines.map(r => dbSaveRoutine(r))).catch(e => console.warn('Routine update failed:', e.message));
    }

    // Propagate to active workout session — re-render exercise card if unilateral changed
    if (activeSession) {
      let workoutChanged = false;
      activeSession.exercises.forEach((ex, ei) => {
        if (ex.id === editingExId || ex.name === name) {
          const uniChanged = ex.unilateral !== unilateral;
          ex.name = name; ex.muscle = selectedMuscle; ex.unilateral = unilateral;
          workoutChanged = true;
          // If unilateral flag changed, re-render that exercise card fully
          if (uniChanged) renderWeekWi(ei);
        }
      });
      if (workoutChanged) autoSaveSession();
    }
  }

  closeModal('exercise-lib-editor');
  renderExerciseLibrary();
  showToast(editingExId ? 'Exercise updated' : 'Exercise created');
}

// Re-render a single exercise card in the active workout (e.g. after unilateral flag change)
function renderWeekWi(ei) {
  if (!activeSession) return;
  const card = document.getElementById(`ex-card-${ei}`);
  if (!card) return;
  const ex = activeSession.exercises[ei];
  const newCard = buildExCard(ex, ei);
  card.replaceWith(newCard);
  // Re-inject suggestion card
  const hintSlot = document.getElementById(`hint-slot-${ei}`);
  if (hintSlot) {
    const allSessions = load(SK.sessions) || [];
    const points = buildProgressionPoints(allSessions, ex.name, ex.equipment);
    const hint = buildSuggestionCard(ei, ex.name, ex.equipment);
    hintSlot.appendChild(hint);
    updateSuggestionCard(ei, points);
  }
}

function deleteExerciseLib(exId) {
  showConfirm('Delete Exercise?', 'This removes it from the library and all routines. Existing sessions are unaffected.', () => {
    // Remove from routines
    const routines = load(SK.routines) || [];
    let routinesChanged = false;
    routines.forEach(r => {
      const before = r.exercises.length;
      r.exercises = r.exercises.filter(ex => ex.id !== exId);
      if (r.exercises.length !== before) routinesChanged = true;
    });
    if (routinesChanged) {
      save(SK.routines, routines);
      routines.forEach(r => dbSaveRoutine(r));
      if (document.getElementById('page-routines')?.classList.contains('active')) renderRoutines();
    }
    // Remove from library
    dbDeleteExercise(exId);
    renderExerciseLibrary();
    showToast('Exercise deleted');
  });
}

// ═══════════════════════════════════════════
// EQUIPMENT INVENTORY UI
// ═══════════════════════════════════════════

const EQUIPMENT_TYPES = ['Dumbbell', 'Barbell', 'Cable', 'Machine', 'Bodyweight'];

// ─── Exercises tab sub-tabs ──────────────────────────────────────────────
function setExercisesSubtab(tab) {
  document.getElementById('ex-subpage-library').style.display   = tab === 'library'   ? '' : 'none';
  document.getElementById('ex-subpage-equipment').style.display = tab === 'equipment' ? '' : 'none';
  document.getElementById('ex-subtab-library').classList.toggle('active',   tab === 'library');
  document.getElementById('ex-subtab-equipment').classList.toggle('active', tab === 'equipment');
  if (tab === 'equipment') renderEquipmentInventory();
}

// ─── Equipment inventory inline page ─────────────────────────────────────

// Common preset weights per equipment type — shown as quick-add chips
const EQUIPMENT_PRESETS = {
  Dumbbell:   [4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 36, 40],
  Barbell:    [20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120],
  Cable:      [5, 10, 15, 20, 25, 30, 35, 40, 50, 60, 70, 80],
  Machine:    [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
  Bodyweight: [],
};

function renderEquipmentInventory() {
  const body = document.getElementById('eq-inv-body');
  if (!body) return;

  body.innerHTML = EQUIPMENT_TYPES.map(type => {
    const owned   = getInventoryWeights(type);
    const presets = (EQUIPMENT_PRESETS[type] || []).filter(w => !owned.includes(w));
    const isBodyweight = type === 'Bodyweight';

    return `
      <div class="eq-section">

        <!-- Type header -->
        <div class="eq-section-header">
          <span class="eq-section-name">${type}</span>
          ${owned.length ? `<span class="eq-section-count">${owned.length} weight${owned.length !== 1 ? 's' : ''}</span>` : ''}
        </div>

        ${isBodyweight ? `
          <div class="eq-bodyweight-note">No weights needed — bodyweight exercises are always available.</div>
        ` : `
          <!-- Owned weights -->
          <div class="eq-owned-row" id="eq-owned-${type}">
            ${owned.length ? owned.map(w => `
              <button class="eq-chip eq-chip-owned" onclick="removeInventoryWeight('${type}', ${w})" title="Tap to remove">
                ${w}kg
                <span class="eq-chip-remove">×</span>
              </button>`).join('')
            : `<span class="eq-none-yet">None added yet</span>`}
          </div>

          <!-- Manual add -->
          <div class="eq-add-row">
            <div class="eq-input-wrap">
              <input class="eq-input" id="eq-input-${type}" type="text"
                inputmode="decimal" placeholder="e.g. 10.5"
                onkeydown="if(event.key==='Enter')addInventoryWeight('${type}')"/>
              <button class="eq-add-btn" onclick="addInventoryWeight('${type}')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 4v16M4 12h16"/></svg>
                Add
              </button>
            </div>
          </div>

          <!-- Quick-add presets -->
          ${presets.length ? `
            <div class="eq-presets-label">Quick add</div>
            <div class="eq-presets-row" id="eq-presets-${type}">
              ${presets.map(w => `
                <button class="eq-chip eq-chip-preset" onclick="addInventoryWeightDirect('${type}', ${w})">
                  + ${w}kg
                </button>`).join('')}
            </div>` : ''}
        `}

      </div>`;
  }).join('');
}

// Direct add without input field — used by preset chips
function addInventoryWeightDirect(type, kg) {
  if (!_inventory[type]) _inventory[type] = [];
  if (_inventory[type].includes(kg)) return;
  _inventory[type].push(kg);
  _inventory[type].sort((a, b) => a - b);
  saveInventory();
  renderEquipmentInventory();
}

function openEquipmentSettings() {
  // Navigate to exercises tab, equipment sub-tab
  showPage('exercises', document.getElementById('nav-exercises'));
  setExercisesSubtab('equipment');
}



function addInventoryWeight(type) {
  const input = document.getElementById(`eq-input-${type}`);
  // Accept both . and , as decimal separator
  const raw = parseFloat(input.value.replace(',', '.'));
  if (isNaN(raw) || raw <= 0) { showToast('Enter a valid weight'); return; }
  const kg = Math.round(raw * 10) / 10; // round to 1 decimal

  if (!_inventory[type]) _inventory[type] = [];
  if (_inventory[type].includes(kg)) { showToast(`${kg}kg already in inventory`); return; }

  _inventory[type].push(kg);
  _inventory[type].sort((a, b) => a - b);
  saveInventory();
  updateEquipmentSummary();
  input.value = '';
  renderEquipmentInventory();
}

function removeInventoryWeight(type, kg) {
  if (!_inventory[type]) return;
  _inventory[type] = _inventory[type].filter(w => w !== kg);
  saveInventory();
  updateEquipmentSummary();
  renderEquipmentInventory();
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

// ── EQUIPMENT INVENTORY ──────────────────────────────────────────────────
// Stored as { Dumbbell: [kg,...], Barbell: [kg,...], Cable: [kg,...], ... }
// Weights are always kept sorted ascending.

let _inventory = {};

const INVENTORY_DEFAULT = {
  Dumbbell:   [6, 10.5, 15, 19.5, 24, 28.5, 33, 40],
  Barbell:    [],   // user fills in their plate combos
  Cable:      [],
  Machine:    [],
  Bodyweight: [],
};

function inventoryKey() { return `sg_inventory_${USER_ID}`; }

function loadInventory() {
  try {
    const raw = localStorage.getItem(inventoryKey());
    if (raw) { _inventory = JSON.parse(raw); return; }
  } catch(e) {}
  // First time — seed with defaults
  _inventory = JSON.parse(JSON.stringify(INVENTORY_DEFAULT));
  saveInventory();
}

function saveInventory() {
  localStorage.setItem(inventoryKey(), JSON.stringify(_inventory));
  // Upsert one row per equipment type into user_equipment
  const upserts = Object.entries(_inventory).map(([equipment_type, weights]) =>
    supabaseFetch('user_equipment', 'on_conflict=user_id,equipment_type', 'POST', {
      user_id: USER_ID,
      equipment_type,
      weights: weights,
      updated_at: new Date().toISOString(),
    })
  );
  Promise.all(upserts).catch(() => {});
}

async function loadInventoryFromCloud() {
  try {
    const data = await supabaseFetch(
      'user_equipment',
      `select=equipment_type,weights&user_id=eq.${USER_ID}`
    );
    if (data && data.length > 0) {
      _inventory = {};
      data.forEach(row => {
        // weights comes back as a parsed array from jsonb
        _inventory[row.equipment_type] = Array.isArray(row.weights)
          ? row.weights
          : JSON.parse(row.weights || '[]');
      });
      localStorage.setItem(inventoryKey(), JSON.stringify(_inventory));
    } else {
      loadInventory(); // fall back to local / defaults
    }
  } catch(e) { loadInventory(); }
  updateEquipmentSummary();
}

function updateEquipmentSummary() {
  const el = document.getElementById('eq-summary');
  if (!el) return;
  const parts = Object.entries(_inventory)
    .filter(([, weights]) => weights && weights.length > 0)
    .map(([type, weights]) => `${type} ×${weights.length}`);
  el.textContent = parts.length ? parts.join(' · ') : 'Not set up';
}

// Return sorted weight array for a given equipment type
function getInventoryWeights(equipType) {
  const w = _inventory[equipType] || [];
  return [...w].sort((a, b) => a - b);
}

// Next available weight above currentKg for the given equipment type.
// Falls back to currentKg + 2.5 if inventory is empty or no step found.
function nextAvailableWeight(currentKg, equipType) {
  const weights = getInventoryWeights(equipType);
  if (!weights.length) return Math.round((currentKg + 2.5) * 4) / 4;
  const next = weights.find(w => w > currentKg);
  return next ?? null; // null = already at max
}

// Previous available weight below currentKg.
function prevAvailableWeight(currentKg, equipType) {
  const weights = getInventoryWeights(equipType);
  if (!weights.length) return Math.max(0, Math.round((currentKg - 2.5) * 4) / 4);
  const prev = [...weights].reverse().find(w => w < currentKg);
  return prev ?? null; // null = already at minimum
}

// Nearest weight in inventory to a target (for snapping suggestions to real weights)
function nearestAvailableWeight(targetKg, equipType) {
  const weights = getInventoryWeights(equipType);
  if (!weights.length) return targetKg;
  return weights.reduce((best, w) => Math.abs(w - targetKg) < Math.abs(best - targetKg) ? w : best, weights[0]);
}

// Legacy alias kept so nothing else breaks
const DB_STEPS = [6, 10.5, 15, 19.5, 24, 28.5, 33, 40]; // only used as fallback
function nextDBStep(currentKg) { return nextAvailableWeight(currentKg, 'Dumbbell'); }
function prevDBStep(currentKg) { return prevAvailableWeight(currentKg, 'Dumbbell'); }
const COMPOUND_PRESS = ['Bench Press','Incline Bench Press','Dumbbell OHP','Push Up','Floor Press'];
// Compound pulls — allow 15% drop
const COMPOUND_PULL  = ['Bent Row','Single Arm DB Row','Chest-Supported Row','Bent-Over Row','Pull-up'];
// Isolation — flag if drop >10%
// Everything else is isolation by default

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
        bestLabel: bestW>0 ? `${fmtKg(bestW)}kg×${bestR}` : '—',
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
  // Use est1RM — accounts for both weight and reps, so going heavier with fewer reps still shows progress
  const rm = points.map(p => p.est1RM || p.weight);
  const slopePerSession = linearTrend(rm);
  const trendPerMonth = Math.round(slopePerSession * 4 * 10) / 10;
  const last3 = points.slice(-3);
  const last3RM = last3.map(p => p.est1RM || p.weight);
  // Plateau only if <2% variation in est1RM across last 3 sessions
  const maxRM = Math.max(...last3RM);
  const minRM = Math.min(...last3RM);
  const plateau = last3.length >= 3 && (maxRM - minRM) / (maxRM || 1) < 0.02;
  const regressing = last3.length >= 3 && last3RM[last3RM.length-1] < last3RM[0] * 0.97;
  let status = 'progressing';
  if (regressing) status = 'regressing';
  else if (plateau && slopePerSession < 0) status = 'plateau';
  return { status, trendPerMonth, plateau, regressing };
}

// ── HYPERTROPHY PER-SET SUGGESTION ENGINE ────────────────────────────────────
//
// Rep ranges:
//   Compound press/pull: 6–12  (step up when all working sets hit 12)
//   Isolation:           8–15  (step up when all working sets hit 15)
//
// Rules:
//   1. Each set is assessed against its own weight independently
//   2. Warmup sets (< 80% of top weight used): suggest same weight, nudge reps up
//   3. Working sets: apply 2-for-2 rule — step up after 2 consecutive sessions
//      where ALL working sets hit the top of the rep range
//   4. If avg working-set reps < repMin: too heavy → suggest dropping
//
function buildSetSuggestions(points, exName, equipment, numSets) {
  if (!points.length) return null;

  const equipType  = equipment || 'Dumbbell';
  const isCompound = COMPOUND_PRESS.includes(exName) || COMPOUND_PULL.includes(exName);

  // Wider rep range — step up only when ALL working sets are at the ceiling
  const repMin = isCompound ? 6  : 8;
  const repMax = isCompound ? 12 : 15;

  const last     = points[points.length - 1];
  const prevLast = points.length >= 2 ? points[points.length - 2] : null;

  const lastSets = last.perSet  || [];
  const prevSets = prevLast?.perSet || [];

  if (!lastSets.length) return buildNextSessionSuggestion(points, exName, equipment);

  // ── Identify working weight = highest weight used ─────────────────────────
  const topWeight = Math.max(...lastSets.map(s => s.weight));

  // Working sets = those at ≥ 80% of top weight
  function isWorking(s) { return s.weight >= topWeight * 0.80; }

  const lastWorking = lastSets.filter(isWorking);
  const prevWorking = prevSets.filter(isWorking);

  // ── 2-for-2: did ALL working sets hit repMax? ─────────────────────────────
  function allHitTop(sets) {
    return sets.length > 0 && sets.every(s => s.reps >= repMax);
  }
  const lastHitTop = allHitTop(lastWorking);
  const prevHitTop = prevWorking.length ? allHitTop(prevWorking) : false;
  const twoForTwo  = lastHitTop && prevHitTop;

  // ── Too heavy? avg working reps below floor ───────────────────────────────
  const avgWorkingReps = lastWorking.length
    ? lastWorking.reduce((a, s) => a + s.reps, 0) / lastWorking.length
    : 0;
  const tooHeavy = avgWorkingReps > 0 && avgWorkingReps < repMin;

  // ── Next/prev step for the working weight ─────────────────────────────────
  const nextStep = nextAvailableWeight(topWeight, equipType);
  const prevStep = prevAvailableWeight(topWeight, equipType);
  const stepGap  = nextStep != null ? nextStep - topWeight : null;
  const bigJump  = stepGap != null && stepGap > 6;

  const n = numSets || Math.max(lastSets.length, 3);

  let overallDecision;
  if (tooHeavy)       overallDecision = 'drop';
  else if (twoForTwo) overallDecision = 'step_up';
  else                overallDecision = 'consolidate';

  const sets = [];
  for (let i = 0; i < n; i++) {
    const prev    = lastSets[i] || lastSets[lastSets.length - 1] || { weight: topWeight, reps: repMin };
    const isWarm  = !isWorking(prev);

    if (isWarm) {
      // Warmup — keep same weight, suggest nudging reps up slightly
      const sugReps = Math.min(prev.reps + 1, repMax - 2);
      sets.push({
        weight:   prev.weight,
        repsMin:  prev.reps,
        repsMax:  sugReps,
        trend:    '↑',
        note:     'warm-up',
      });
      continue;
    }

    if (overallDecision === 'step_up') {
      const targetW    = nextStep ?? topWeight;
      const repDrop    = bigJump ? 3 : 2;
      const targetReps = Math.max(repMin, Math.round(prev.reps * 0.85));
      sets.push({
        weight:  targetW,
        repsMin: Math.max(repMin, targetReps - 1),
        repsMax: Math.min(repMax, targetReps + 1),
        trend:   '↑',
        note:    i === 0 ? `Step up from ${fmtKg(topWeight)}kg` : '',
      });

    } else if (overallDecision === 'drop') {
      const targetW    = prevStep ?? topWeight;
      const targetReps = Math.min(repMax - 2, prev.reps + 2);
      sets.push({
        weight:  targetW,
        repsMin: targetReps,
        repsMax: Math.min(repMax, targetReps + 2),
        trend:   '↓',
        note:    i === 0 ? `Too heavy at ${fmtKg(topWeight)}kg — drop down` : '',
      });

    } else {
      // Consolidate — same weight, aim for +1 rep on each set
      const targetReps = prev.reps >= repMax ? repMax : prev.reps + 1;
      sets.push({
        weight:  prev.weight,
        repsMin: Math.min(targetReps, repMax),
        repsMax: Math.min(targetReps + 1, repMax),
        trend:   targetReps >= repMax ? '→' : '↑',
        note:    '',
      });
    }
  }

  // ── Summary line ──────────────────────────────────────────────────────────
  let summary, subtext;
  if (overallDecision === 'step_up') {
    summary = `Step up to ${fmtKg(nextStep)}kg — you hit ${repMax} reps ${twoForTwo ? 'two sessions running' : 'last session'}`;
    subtext = bigJump
      ? `Big jump (+${stepGap}kg) — expect reps to drop, aim for ${repMin}+`
      : `Aim for ${repMin}–${repMax} reps at the new weight`;
  } else if (overallDecision === 'drop') {
    summary = `Drop to ${fmtKg(prevStep ?? topWeight)}kg — average reps below ${repMin}`;
    subtext = `Build back to ${repMin}–${repMax} reps before stepping up again`;
  } else if (lastHitTop) {
    summary = `Hold ${fmtKg(topWeight)}kg — hit ${repMax} last session, one more to confirm`;
    subtext = `Hit ${repMax} reps again this session to earn the step up next time`;
  } else {
    summary = `Hold ${fmtKg(topWeight)}kg — add 1 rep where possible`;
    subtext = `Avg ${avgWorkingReps.toFixed(1)} reps at ${fmtKg(topWeight)}kg last time — target is ${repMax}`;
  }

  return { sets, summary, subtext, overallDecision, repMin, repMax, currentW: topWeight };
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
    {val:last.bestLabel,   lbl:'Best set',     color:'#c8f06e'},
    {val:last.est1RM+'kg', lbl:'Est. 1RM',     color:'#00ffcc'},
    {val:points.length,    lbl:'Sessions',      color:'#7c6aff'},
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
    meta.textContent = `Top weight: ${fmtKg(first.weight)}kg → ${fmtKg(last.weight)}kg (${sign}${diff}kg) over ${points.length} sessions`;
    container.appendChild(meta);
  }

  // ── Est 1RM chart (primary — replaces raw weight sparkline) ─────────────
  const rmTitle = document.createElement('div');
  rmTitle.style.cssText = 'font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted2);margin-bottom:4px;';
  rmTitle.textContent = 'Strength trend — estimated 1RM (kg)';
  container.appendChild(rmTitle);

  const rmNote = document.createElement('div');
  rmNote.style.cssText = 'font-size:10px;color:var(--muted);margin-bottom:8px;';
  rmNote.textContent = 'Accounts for both weight and reps — goes up when you lift heavier or do more reps';
  container.appendChild(rmNote);

  const rmWrap = document.createElement('div');
  rmWrap.style.cssText = 'position:relative;width:100%;height:120px;overflow:hidden;margin-bottom:4px;';
  const rmCanvas = document.createElement('canvas');
  rmCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;';
  rmWrap.appendChild(rmCanvas);
  container.appendChild(rmWrap);

  // Dots below chart showing best set label + date
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

  // ── Next session suggestion — per-set table ─────────────────────────────
  const allSess2 = load(SK.sessions)||[];
  const perSetData = buildSetSuggestions(points, exName, equipment,
    last.perSet?.length || last.sets || 3);

  if (perSetData) {
    const hintCard = document.createElement('div');
    hintCard.style.cssText = 'background:rgba(200,240,110,0.06);border:1px solid rgba(200,240,110,0.20);border-radius:12px;padding:14px 16px;margin-bottom:14px;';

    const summaryEl = document.createElement('div');
    summaryEl.innerHTML = `
      <div style="font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#c8f06e;font-weight:700;margin-bottom:6px;">Next session</div>
      <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:2px;">${perSetData.summary}</div>
      <div style="font-size:11px;color:var(--muted2);margin-bottom:10px;">${perSetData.subtext}</div>`;
    hintCard.appendChild(summaryEl);

    if (perSetData.sets?.length) {
      const colHdr = document.createElement('div');
      colHdr.style.cssText = 'display:grid;grid-template-columns:32px 1fr 1fr 20px;gap:6px;padding:0 6px;font-size:9px;color:var(--muted2);letter-spacing:0.08em;text-transform:uppercase;margin-bottom:4px;';
      colHdr.innerHTML = '<span></span><span>Last</span><span>Target</span><span></span>';
      hintCard.appendChild(colHdr);

      const lastPerSet = last.perSet || [];
      perSetData.sets.forEach((s, i) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:grid;grid-template-columns:32px 1fr 1fr 20px;align-items:center;gap:6px;padding:5px 6px;background:rgba(255,255,255,0.03);border-radius:6px;font-size:11px;margin-bottom:3px;';
        const trendColor = s.trend==='↑'?'#c8f06e':s.trend==='↓'?'#ff4466':'rgba(200,240,110,0.45)';
        const repsStr = s.repsMin===s.repsMax ? `${s.repsMin}` : `${s.repsMin}–${s.repsMax}`;
        const prevStr = lastPerSet[i] ? `${fmtKg(lastPerSet[i].weight)}kg×${lastPerSet[i].reps}` : '—';
        row.innerHTML =
          `<span style="color:var(--muted2);font-weight:600;">S${i+1}</span>` +
          `<span style="color:var(--muted2);">${prevStr}</span>` +
          `<span style="color:#e8eaf0;font-weight:700;">${fmtKg(s.weight)}kg × ${repsStr}</span>` +
          `<span style="color:${trendColor};font-weight:700;">${s.trend}</span>`;
        hintCard.appendChild(row);
      });
    }
    container.appendChild(hintCard);
  } else if (hint) {
    const hintCard = document.createElement('div');
    hintCard.style.cssText = 'background:rgba(200,240,110,0.06);border:1px solid rgba(200,240,110,0.20);border-radius:12px;padding:14px 16px;margin-bottom:14px;';
    hintCard.innerHTML = `
      <div style="font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#c8f06e;font-weight:700;margin-bottom:6px;">Next session</div>
      <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:4px;">${hint.suggestion}</div>
      <div style="font-size:11px;color:var(--muted2);">${hint.subtext}</div>`;
    container.appendChild(hintCard);
  }

  // Draw chart after DOM paint
  setTimeout(() => {
    if (rmCanvas.offsetWidth) {
      drawProgressLine(rmCanvas, points.map(p=>p.dateStr), points.map(p=>p.est1RM), '#00ffcc', false);
    }
  }, 100);
}

function renderSingleSessionCard(container, point, exName, equipment) {
  const hint = buildNextSessionSuggestion([point], exName, equipment);
  container.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px;">
      <div style="background:rgba(0,0,0,0.06);border-radius:10px;padding:10px;text-align:center;"><div style="font-size:18px;font-weight:800;color:#c8f06e;">${fmtKg(point.weight)}kg</div><div style="font-size:9px;color:var(--muted2);margin-top:2px;">TOP WEIGHT</div></div>
      <div style="background:rgba(0,0,0,0.06);border-radius:10px;padding:10px;text-align:center;"><div style="font-size:18px;font-weight:800;color:#c8f06e;">${point.est1RM}kg</div><div style="font-size:9px;color:var(--muted2);margin-top:2px;">EST. 1RM</div></div>
      <div style="background:rgba(0,0,0,0.06);border-radius:10px;padding:10px;text-align:center;"><div style="font-size:18px;font-weight:800;color:#c8f06e;">${point.bestLabel}</div><div style="font-size:9px;color:var(--muted2);margin-top:2px;">BEST SET</div></div>
    </div>
    <div style="font-size:10px;color:var(--muted2);margin-bottom:12px;text-align:center;">First session — do more to see trends</div>`;

  if (hint) {
    const hintCard = document.createElement('div');
    hintCard.style.cssText = 'background:rgba(200,240,110,0.06);border:1px solid rgba(200,240,110,0.20);border-radius:12px;padding:14px 16px;';
    hintCard.innerHTML = `
      <div style="font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#c8f06e;font-weight:700;margin-bottom:6px;">Next session</div>
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
  const row = document.getElementById('stats-presets');
  if (!row) return;
  // Always clear and rebuild — prevents duplicate buttons on re-visit
  row.innerHTML = '';
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
  ['overview','routines','exercise','coach'].forEach(t=>{
    const el=document.getElementById('stats-tab-'+t);
    if (!el) return;
    if (t === 'coach') {
      el.style.display = t===tab ? 'flex' : 'none';
    } else {
      el.style.display = t===tab ? '' : 'none';
    }
  });
  if (tab === 'coach') {
    initCoachPage();
    return; // don't call renderStats for coach tab
  }
  renderStats();
}

function renderStats() {
  if (_statsSubtab === 'coach') return; // handled by initCoachPage
  initStatsPage();
  const allSessions = load(SK.sessions) || [];

  // If no sessions loaded yet and we're still syncing, show a placeholder
  if (!allSessions.length && !currentUser) {
    const grid = document.getElementById('stats-kpi-grid');
    const bars = document.getElementById('muscle-bars');
    if (grid) grid.innerHTML = '';
    if (bars) bars.innerHTML = '<div style="font-family:\'JetBrains Mono\',monospace;font-size:10px;letter-spacing:0.08em;color:rgba(241,236,226,0.28);padding:8px 0;">Loading…</div>';
    return;
  }

  const {from,to} = getStatsDates();
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
  renderStatsBodyMap(sessions);
  renderWeeklyFreqChart(sessions, fromDate, toDate);
}

function renderStatsBodyMap(sessions) {
  const primaryData = {};
  const secondaryData = {};
  const allEx = load(SK.exercises) || [];
  sessions.forEach(s => {
    (s.exercises || []).forEach(ex => {
      const libEx = allEx.find(e => e.id === ex.id || e.name === ex.name);
      const logged = Array.isArray(ex.sets) ? ex.sets.filter(st => st.logged).length : (ex.sets || 1);
      const pm = libEx?.primaryMuscle || ex.primaryMuscle;
      if (pm) primaryData[pm] = (primaryData[pm] || 0) + logged;
      const secs = libEx?.secondaryMuscles || ex.secondaryMuscles || [];
      secs.forEach(sm => { secondaryData[sm] = (secondaryData[sm] || 0) + logged; });
    });
  });

  // Find or create the stats body map card — replaces muscle bars
  let mapCard = document.getElementById('stats-body-map-card');
  if (!mapCard) {
    const overviewTab = document.getElementById('stats-tab-overview');
    if (!overviewTab) return;
    mapCard = document.createElement('div');
    mapCard.id = 'stats-body-map-card';
    mapCard.className = 'stat-card';
    mapCard.style.marginBottom = '8px';
    // Insert before the first stat-card in the overview (replaces muscle bars card)
    const firstCard = overviewTab.querySelector('.stat-card');
    if (firstCard) overviewTab.insertBefore(mapCard, firstCard);
    else overviewTab.prepend(mapCard);
  }

  const hasPrimary = Object.keys(primaryData).length > 0;
  mapCard.innerHTML = `
    <div class="stat-card-title">Primary muscle heat map</div>
    ${hasPrimary ? `
      <div id="stats-body-map-inner" class="stats-body-map"></div>
      <div class="stats-map-legend">
        <span class="legend-dot" style="background:rgba(255,180,0,0.3)"></span><span>Low</span>
        <span class="legend-dot" style="background:rgba(255,120,0,0.65)"></span><span>Med</span>
        <span class="legend-dot" style="background:#ff4500"></span><span>High</span>
      </div>` : `
      <div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:rgba(241,236,226,0.28);letter-spacing:0.06em;padding:8px 0;">
        Set primary muscles on exercises to see the heat map
      </div>`}`;

  if (hasPrimary) {
    setTimeout(() => renderMuscleMap('stats-body-map-inner', primaryData, true, secondaryData), 0);
  }
}



function renderMuscleBars(sessions) {
  const muscles = {};
  sessions.forEach(s => {
    (s.exercises||[]).forEach(ex => {
      const sets = (ex.sets||[]).filter(st=>st.logged).length;
      if (!sets) return;
      const m = normaliseMuscle(ex.muscle) || 'Other';
      muscles[m] = (muscles[m]||0) + sets;
    });
  });
  const container = document.getElementById('muscle-bars');
  if (!container) return;
  const entries = Object.entries(muscles).sort((a,b) => {
    const ai = MUSCLE_GROUPS.indexOf(a[0]);
    const bi = MUSCLE_GROUPS.indexOf(b[0]);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return b[1] - a[1]; // unknown groups sorted by count
  });
  if (!entries.length) {
    container.innerHTML='<div style="color:rgba(241,236,226,0.28);font-family:\'JetBrains Mono\',monospace;font-size:11px;letter-spacing:0.06em;padding:8px 0;">No data yet</div>';
    return;
  }
  const max = Math.max(...entries.map(e=>e[1]));
  container.innerHTML = entries.map(([m,v])=>`
    <div class="muscle-bar-row">
      <span class="muscle-bar-label">${m}</span>
      <div class="muscle-bar-track"><div class="muscle-bar-fill" data-pct="${Math.round(v/max*100)}"></div></div>
      <span class="muscle-bar-val">${v}</span>
    </div>`).join('');
  // Animate bars in
  requestAnimationFrame(() => {
    container.querySelectorAll('.muscle-bar-fill').forEach(el => {
      el.style.width = el.dataset.pct + '%';
    });
  });
}

function renderKPIs(sessions, fromDate, toDate) {
  const n = sessions.length;
  const allSets = sessions.reduce((a,s)=>a+(s.exercises||[]).reduce((b,ex)=>b+(ex.sets||[]).filter(st=>st.logged).length,0),0);
  const avgSets = n ? (allSets/n).toFixed(1) : 0;
  const totalVol = Math.round(sessions.reduce((a,s)=>a+calcSessionVolume(s),0));
  const totalDur = sessions.reduce((a,s)=>a+(s.duration||0),0);
  const avgDur = n ? Math.round(totalDur/n/60) : 0;

  // Sessions/week: count distinct weeks, exclude current week unless 3+ sessions
  const weekCounts = {};
  sessions.forEach(s => {
    const key = getWeekKey(new Date(s.startedAt));
    weekCounts[key] = (weekCounts[key]||0) + 1;
  });
  if (!includeCurrentWeek(weekCounts)) delete weekCounts[currentWeekKey()];
  const completedSessions = Object.values(weekCounts).reduce((a,b)=>a+b, 0);
  const totalWeeks = Object.keys(weekCounts).length || 1;
  const freq = (completedSessions / totalWeeks).toFixed(1);

  const grid = document.getElementById('stats-kpi-grid');
  if (!grid) return;
  grid.innerHTML = [
    {val:n,              lbl:'Sessions',       sub:'in period',         color:'#c8f06e'},
    {val:avgSets,        lbl:'Avg sets',        sub:'per session',       color:'#00ffcc'},
    {val:freq,           lbl:'Sessions/week',   sub:`over ${totalWeeks} active week${totalWeeks!==1?'s':''}`, color:'#f0a96e'},
    {val:avgDur+'m',     lbl:'Avg duration',    sub:'per session',       color:'#7c6aff'},
    {val:totalVol.toLocaleString()+'kg', lbl:'Total volume', sub:'sets×reps×kg', color:'#00ffcc'},
    {val:allSets,        lbl:'Total sets',      sub:'logged',            color:'#c8f06e'},
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
    const fill=document.createElement('div'); fill.style.cssText=`height:${h}px;background:#c8f06e88;border-radius:2px 2px 0 0;`;
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


// Get ISO week Monday key (YYYY-MM-DD) for any date
function getWeekKey(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

// Current week's Monday key
function currentWeekKey() { return getWeekKey(new Date()); }

// Should the current week be included in frequency stats?
// Yes only if it has 3+ sessions (i.e. likely a full or near-full week of training)
function includeCurrentWeek(weeks) {
  const key = currentWeekKey();
  return (weeks[key] || 0) >= 3;
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
    const key = getWeekKey(new Date(s.startedAt));
    weeks[key] = (weeks[key]||0) + 1;
  });

  // Exclude current week unless it has 3+ sessions
  const thisWeek = currentWeekKey();
  if (!includeCurrentWeek(weeks)) delete weeks[thisWeek];

  const labels = Object.keys(weeks).sort();
  const data = labels.map(k => weeks[k]);
  // Defer draw so canvas has proper dimensions after paint
  setTimeout(() => {
    const canvas = document.getElementById('chart-volume');
    if (!canvas || !canvas.offsetWidth) return;
    const ctx = canvas.getContext('2d');
    drawBarChart(ctx, canvas, labels.map(l=>l.slice(5)), data, '#c8f06e');
  }, 100);
}

function populateExSelect() {
  const allEx = load(SK.exercises) || [];
  const sel = document.getElementById('ex-select');
  if (!sel) return;
  const current = sel.value;

  // Group by muscle, normalised
  const grouped = {};
  allEx.sort((a,b)=>a.name.localeCompare(b.name)).forEach(e => {
    const m = normaliseMuscle(e.muscle) || 'Other';
    if (!grouped[m]) grouped[m] = [];
    grouped[m].push(e);
  });

  sel.innerHTML = '<option value="">— Select exercise —</option>' +
    MUSCLE_GROUPS.filter(m => grouped[m]).map(m =>
      `<optgroup label="${m}">${grouped[m].map(e=>`<option value="${e.name}">${e.name}</option>`).join('')}</optgroup>`
    ).join('');

  if (current) sel.value = current;

  // Wire change to immediately render — remove old listener first
  sel.onchange = () => { if (sel.value) renderExerciseSection(); };
}

let _exEquipFilter = 'All';

function renderExerciseSection(equipFilter) {
  if (equipFilter !== undefined) _exEquipFilter = equipFilter;
  const exName = document.getElementById('ex-select')?.value;
  const body   = document.getElementById('exercise-progress-body');
  if (!body) return;
  if (!exName) { body.innerHTML = ''; return; }

  // Make sure the exercise tab is visible so canvas dimensions work
  const tabEl = document.getElementById('stats-tab-exercise');
  if (tabEl && tabEl.style.display === 'none') {
    // Switch to exercise subtab
    setStatsSubtab('exercise');
    return; // setStatsSubtab will call renderExerciseSection again
  }

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
      btn.style.cssText = `padding:4px 12px;border-radius:20px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;border:1px solid ${active?'var(--neon)':'var(--border)'};background:${active?'rgba(200,240,110,0.10)':'var(--surface2)'};color:${active?'var(--neon)':'var(--muted2)'};`;
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
      currentTag.style.cssText = `font-size:10px;font-weight:600;padding:3px 9px;border-radius:12px;${ex.equipment ? 'color:var(--neon);background:rgba(200,240,110,0.10);border:1px solid rgba(200,240,110,0.20);' : 'color:#4b5563;'}`;
      currentTag.textContent = ex.equipment || 'Untagged';

      topRow.appendChild(info);
      topRow.appendChild(currentTag);

      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';

      EQUIPMENT.forEach(eq => {
        const btn = document.createElement('button');
        btn.textContent = eq;
        const isActive = ex.equipment === eq;
        btn.style.cssText = `padding:5px 12px;border-radius:16px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;border:1px solid ${isActive?'var(--neon)':'rgba(255,255,255,0.1)'};background:${isActive?'rgba(200,240,110,0.10)':'transparent'};color:${isActive?'var(--neon)':'#6b7280'};`;

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
            b.style.background  = active ? 'rgba(200,240,110,0.10)' : 'transparent';
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

// Format a weight to 1 decimal, dropping trailing zero (e.g. 24.0 → "24", 10.5 → "10.5")
function fmtKg(kg) {
  const n = Math.round(parseFloat(kg) * 10) / 10;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

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
function buildStravaDescription(session) {
  return (session.exercises || [])
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
}

async function uploadSessionToStrava(session, btnEl) {
  if (!stravaConnected) { showToast('Strava not connected'); return; }
  btnEl.textContent = 'Uploading…';
  btnEl.disabled = true;
  try {
    const desc = buildStravaDescription(session);
    await uploadToStrava(session, desc);
    // Mark session as uploaded
    const allSessions = load(SK.sessions) || [];
    const idx = allSessions.findIndex(x => x.id === session.id);
    if (idx >= 0) {
      allSessions[idx].stravaUploaded = true;
      save(SK.sessions, allSessions);
    }
    btnEl.textContent = '✓ Uploaded to Strava';
    btnEl.style.opacity = '0.5';
    btnEl.style.cursor = 'default';
    btnEl.disabled = true;
    showToast('Uploaded to Strava!');
  } catch(e) {
    btnEl.textContent = '⟳ Retry Upload';
    btnEl.disabled = false;
    showToast('Upload failed — ' + (e.message || 'check connection'));
  }
}

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
    btn.classList.add('connected');
    if (lbl) lbl.textContent = '✓ STRAVA';
  } else {
    btn.classList.remove('connected');
    if (lbl) lbl.textContent = '^ STRAVA';
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
  const exerciseSummary = buildStravaDescription(session);

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
    <div style="background:#151824;border:1px solid rgba(200,240,110,0.18);border-radius:16px;padding:24px 20px;width:100%;max-width:400px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="#FC4C02"><path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.598h4.172L10.463 0l-7 13.828h4.169"/></svg>
        <div style="font-family:'Bebas Neue',sans-serif;font-size:18px;letter-spacing:2px;color:#fff;">Upload to Strava?</div>
      </div>
      <div style="font-size:12px;color:#4a5068;margin-bottom:16px;">${name} · ${durStr}</div>
      <div style="font-size:11px;color:#6b7490;background:#0d0f17;border-radius:8px;padding:10px 12px;margin-bottom:16px;white-space:pre-line;max-height:120px;overflow-y:auto;">${previewSummary}</div>
      <div style="font-size:10px;color:#4a5068;margin-bottom:12px;letter-spacing:0.5px;">Full sets & reps will be included in the Strava description.</div>
      <div style="display:flex;gap:10px;">
        <button id="strava-upload-yes" style="flex:1;background:#FC4C02;color:#fff;border:none;border-radius:8px;padding:13px;font-family:'DM Mono',monospace;font-size:12px;font-weight:500;letter-spacing:1px;cursor:pointer;">UPLOAD</button>
        <button id="strava-upload-no" style="flex:1;background:transparent;color:#4a5068;border:1px solid rgba(200,240,110,0.10);border-radius:8px;padding:13px;font-family:'DM Mono',monospace;font-size:12px;cursor:pointer;">SKIP</button>
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
      const allSessions = load(SK.sessions) || [];
      const idx = allSessions.findIndex(x => x.id === session.id);
      if (idx >= 0) { allSessions[idx].stravaUploaded = true; save(SK.sessions, allSessions); }
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

// ═══════════════════════════════════════════
// COACH — AI training assistant
// ═══════════════════════════════════════════

let _coachHistory = [];   // { role, content }[]
let _coachInitialised = false;

const COACH_SUGGESTIONS = [
  'Create me a routine',
  'What should I work on today?',
  'How is my progress looking?',
  'Am I training enough?',
  'Suggest a deload week',
  'Fix muscle imbalances',
];

function initCoachPage() {
  if (_coachInitialised) return;
  _coachInitialised = true;
  // Render suggestion chips
  const chips = document.getElementById('coach-suggestions');
  if (chips) {
    chips.innerHTML = COACH_SUGGESTIONS.map(s =>
      `<button class="coach-chip" onclick="coachChip(this)">${s}</button>`
    ).join('');
  }
  // Show welcome message
  appendCoachMsg('assistant', `Hey! I'm your personal training coach. I have full visibility of your routines, recent sessions, exercises, and equipment — so my advice is specific to *you*.

Ask me anything, or tell me to create a new routine and I'll build one from scratch.`);
}

function coachChip(btn) {
  const text = btn.textContent;
  const input = document.getElementById('coach-input');
  if (input) { input.value = text; input.style.height = 'auto'; }
  sendCoachMessage();
}

function buildCoachContext() {
  const routines   = load(SK.routines)   || [];
  const sessions   = (load(SK.sessions)  || []).slice(-20); // last 20 sessions
  const exercises  = load(SK.exercises)  || [];

  const inventory  = Object.entries(_inventory||{})
    .filter(([,w]) => w && w.length)
    .map(([t,w]) => `${t}: ${w.join(', ')}kg`)
    .join('; ');

  const recentStr  = sessions.map(s => {
    const date = new Date(s.startedAt).toLocaleDateString('en-GB',{day:'numeric',month:'short'});
    const exStr = (s.exercises||[]).map(ex => {
      const logged = (ex.sets||[]).filter(st=>st.logged);
      const topW   = Math.max(0,...logged.map(st=>parseFloat(st.weight)||0));
      const reps   = logged.map(st=>st.reps||`${st.repsL||0}/${st.repsR||0}`).join(', ');
      return `  ${ex.name} (${logged.length} sets, top ${topW}kg, reps: ${reps})`;
    }).join('\n');
    return `${date} — ${s.routineName}\n${exStr}`;
  }).join('\n\n');

  const routineStr = routines.map(r =>
    `${r.name}: ${(r.exercises||[]).map(e=>`${e.name} ×${e.sets}`).join(', ')}`
  ).join('\n');

  const exStr = exercises.map(e=>`${e.name} (${e.muscle}${e.unilateral?' Uni':''})`).join(', ');

  return `You are an expert strength and hypertrophy coach for the Sterk Gutt app.
The user trains with dumbbells and uses a split routine. Always give specific, actionable advice based on their actual data.

EQUIPMENT INVENTORY:
${inventory || 'Not set up'}

CURRENT ROUTINES:
${routineStr || 'None'}

EXERCISE LIBRARY:
${exStr || 'None'}

RECENT SESSIONS (last 20):
${recentStr || 'No sessions yet'}

When asked to CREATE A ROUTINE, respond with a JSON block inside triple backticks tagged as "routine_json" in this exact format:
\`\`\`routine_json
{
  "name": "Routine Name",
  "exercises": [
    {"name": "Exercise Name", "sets": 3, "muscle": "Chest", "unilateral": false},
    ...
  ]
}
\`\`\`
Then add a brief explanation outside the JSON.
For all other questions, respond in plain conversational text. Keep responses concise and direct.`;
}

async function sendCoachMessage() {
  const input   = document.getElementById('coach-input');
  const sendBtn = document.getElementById('coach-send-btn');
  const text    = input?.value?.trim();
  if (!text) return;

  input.value   = '';
  input.style.height = 'auto';
  sendBtn.disabled   = true;

  appendCoachMsg('user', text);
  _coachHistory.push({ role:'user', content:text });

  // Typing indicator
  const typingId = 'coach-typing-' + Date.now();
  const msgEl = document.getElementById('coach-messages');
  if (msgEl) {
    const typing = document.createElement('div');
    typing.id = typingId;
    typing.className = 'coach-msg assistant';
    typing.innerHTML = `
      <div class="coach-avatar">AI</div>
      <div class="coach-msg-bubble">
        <div class="coach-typing"><span></span><span></span><span></span></div>
      </div>`;
    msgEl.appendChild(typing);
    msgEl.scrollTop = msgEl.scrollHeight;
  }

  try {
    // Call through Cloudflare Worker proxy (keeps API key server-side)
    const response = await fetch('/api/coach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        system: buildCoachContext(),
        messages: _coachHistory,
      }),
    });

    const data = await response.json();

    // Remove typing indicator
    document.getElementById(typingId)?.remove();

    // Handle API errors (e.g. invalid key, quota exceeded)
    if (!response.ok || data.error) {
      const errMsg = data.error?.message || JSON.stringify(data.error) || `HTTP ${response.status}`;
      appendCoachMsg('assistant', `API error: ${errMsg}`);
      sendBtn.disabled = false;
      input?.focus();
      return;
    }

    const content = data.content?.[0]?.text || 'Sorry, something went wrong.';

    // Check for routine JSON
    const routineMatch = content.match(/```routine_json\s*([\s\S]*?)```/);
    if (routineMatch) {
      try {
        const routineData = JSON.parse(routineMatch[1].trim());
        const textWithoutJson = content.replace(/```routine_json[\s\S]*?```/, '').trim();
        if (textWithoutJson) appendCoachMsg('assistant', textWithoutJson);
        appendRoutinePreview(routineData);
      } catch(e) {
        appendCoachMsg('assistant', content);
      }
    } else {
      appendCoachMsg('assistant', content);
    }

    _coachHistory.push({ role:'assistant', content });

    // Keep history to last 20 turns
    if (_coachHistory.length > 40) _coachHistory = _coachHistory.slice(-40);

  } catch(e) {
    document.getElementById(typingId)?.remove();
    appendCoachMsg('assistant', `Something went wrong: ${e.message || 'Unknown error'}. Please try again.`);
  }

  sendBtn.disabled = false;
  input?.focus();
}

function appendCoachMsg(role, text) {
  const container = document.getElementById('coach-messages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = `coach-msg ${role}`;
  const boldRe = /\*{2}(.+?)\*{2}/g;
  const italRe = /\*(.+?)\*/g;
  const html = text
    .replace(boldRe, '<strong>$1</strong>')
    .replace(italRe, '<em>$1</em>')
    .replace(/\n/g, '<br>');
  div.innerHTML = role === 'assistant'
    ? `<div class="coach-avatar">AI</div><div class="coach-msg-bubble">${html}</div>`
    : `<div class="coach-msg-bubble">${html}</div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function appendRoutinePreview(routine) {
  const container = document.getElementById('coach-messages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'coach-msg assistant';
  const exRows = (routine.exercises||[]).map(ex =>
    `<div class="coach-routine-preview-ex">
      <strong>${ex.name}</strong> &nbsp;·&nbsp; ${ex.sets} sets &nbsp;·&nbsp; ${ex.muscle}${ex.unilateral?' · Uni':''}
    </div>`
  ).join('');
  const safeRoutine = JSON.stringify(routine).replace(/'/g, "\\'").replace(/"/g, '&quot;');
  div.innerHTML = `
    <div class="coach-avatar">AI</div>
    <div class="coach-msg-bubble" style="padding:0;overflow:hidden;background:transparent;border:none;">
      <div class="coach-routine-preview">
        <div class="coach-routine-preview-header">
          <span class="coach-routine-preview-name">${routine.name}</span>
          <button class="coach-routine-preview-save" onclick="saveCoachRoutine(this)">Save</button>
        </div>
        ${exRows}
      </div>
    </div>`;
  div.querySelector('.coach-routine-preview-save').dataset.routine = JSON.stringify(routine);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

async function saveCoachRoutine(btn) {
  try {
    const routine = JSON.parse(btn.dataset.routine);
    const allEx = load(SK.exercises) || [];
    const knownNames = new Set(allEx.map(e => e.name.toLowerCase()));

    // Save any new exercises to library AND Supabase
    const newExercises = [];
    routine.exercises.forEach(ex => {
      if (!knownNames.has(ex.name.toLowerCase())) {
        const newEx = { id:'ex_'+Date.now()+'_'+Math.random().toString(36).slice(2), name:ex.name, muscle:ex.muscle||'Other', unilateral:!!ex.unilateral };
        allEx.push(newEx);
        knownNames.add(ex.name.toLowerCase());
        newExercises.push(newEx);
      }
    });
    save(SK.exercises, allEx);
    // Persist each new exercise to Supabase
    await Promise.all(newExercises.map(ex => dbSaveExercise(ex)));

    // Build and save routine
    const newRoutine = {
      id: 'r_'+Date.now(),
      name: routine.name,
      createdAt: Date.now(),
      exercises: routine.exercises.map(ex => ({
        id: allEx.find(e=>e.name.toLowerCase()===ex.name.toLowerCase())?.id || 'ex_'+Date.now(),
        name: ex.name, muscle: ex.muscle||'Other',
        unilateral: !!ex.unilateral, sets: ex.sets || 3,
      })),
    };
    const routines = load(SK.routines) || [];
    routines.push(newRoutine);
    save(SK.routines, routines);
    await dbSaveRoutine(newRoutine); // await to confirm it saved

    btn.textContent = '✓ Saved';
    btn.disabled = true;
    btn.style.background = 'rgba(200,240,110,0.20)';
    btn.style.color = '#c8f06e';
    btn.style.border = '1px solid #c8f06e';
    showToast(`"${routine.name}" added to routines`);
  } catch(e) {
    showToast('Failed to save: ' + e.message);
    console.error(e);
  }
}

Object.assign(window, {
  // Coach
  initCoachPage, sendCoachMessage, coachChip, saveCoachRoutine,
  // Nav & pages
  showPage, openModal, closeModal, signInWithGoogle, signInWithMagicLink, signOut,
  // Confirm dialog
  showConfirm, confirmOk, closeConfirm,
  // Home
  openWorkoutPicker, handleStravaHomeBtn, startAdHocWorkout,
  // Workout
  startWorkout, resumeWorkout, finishWorkout, togglePauseWorkout,
  handleSetBtn, addSet, removeSet, removeLastSet, toggleExCollapse,
  setEquipment, updateSet,
  // Routine editor
  createSplit, renameSplit, deleteSplit, assignRoutineToSplit,
  openFullscreenMap,
  openRoutineEditor, saveRoutine, saveRoutineChanges, deleteRoutine,
  addExerciseToEditor, removeEditorEx, toggleRoutineCard,
  updateEditorExSets: (i, v) => { if (editorExercises[i]) editorExercises[i].sets = Math.max(1, +v || 1); },
  // Exercise picker
  selectExerciseFromPicker, showNewExForm, hideNewExForm,
  createAndAddExercise, selectMuscle, selectPrimaryMuscle, toggleSecondaryMuscle,
  // Exercise library
  openExerciseLibEditor, saveExerciseLib, deleteExerciseLib, setLibFilter,
  // Stats
  setStatsSubtab, applyCustomRange,
  toggleSessionEdit, updateSavedSet, removeSavedSet, addSavedSet, removeSessionExercise, openExPickerForSession,
  // Equipment inventory
  openEquipmentSettings, addInventoryWeight, addInventoryWeightDirect,
  removeInventoryWeight, updateEquipmentSummary, setExercisesSubtab,
});
