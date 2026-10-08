/**
 * Server logic for the `cloud` functions codebase (Data Ownership Build
 * Guide, step S4). Kept apart from index.js so it can be tested with plain
 * Node and fakes (node test.js): no Firebase or GitHub needed.
 *
 * startToastSync — the employee page's "Sync Toast" button.
 *   1. The caller must be signed in, and staff: staff/{uid} exists.
 *   2. At most one manual sync every 2 minutes, across all staff. The last
 *      one is stored at server/lastSyncTrigger (clients can't read or write
 *      server/; the root rule denies it).
 *   3. Asks GitHub to run .github/workflows/sync-oysters.yml on main, with
 *      a token only this function can read (secret GH_DISPATCH_TOKEN).
 *   4. Writes an audit-log entry naming the caller: the name in their
 *      staff/{uid} entry (Merroir sign-ins, M5), else the verified email.
 *      Never anything the page sends.
 */

'use strict';

const REPO = 'Garrettkelly11/half-shell-website';
const WORKFLOW = 'sync-oysters.yml';
// GH_API_BASE is honored only inside the local Functions emulator (for
// testing against a fake GitHub); deployed functions always use GitHub.
const API_BASE = (process.env.FUNCTIONS_EMULATOR === 'true' && process.env.GH_API_BASE)
  || 'https://api.github.com';
const DISPATCH_URL = `${API_BASE}/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`;
const MIN_GAP_MS = 2 * 60 * 1000;
const LAST_TRIGGER_PATH = 'server/lastSyncTrigger';

/** An error the page can show; `code` is a Firebase callable error code. */
class SyncError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function auditEntry(action, details, actor, now) {
  return {
    timestamp: now,
    action,
    oysterId: null,
    details,
    actor,
    readable_timestamp: new Date(now).toISOString(),
  };
}

/**
 * deps:
 *   db    — firebase-admin Database (or a fake with ref().once/transaction/push)
 *   fetch — fetch()
 *   token — the GitHub token (string)
 *   now   — () => ms
 * auth: the callable's request.auth ({ uid, token: { email } }) or null.
 * Returns { ok: true, nextAllowedAt }. Throws SyncError.
 */
async function startToastSync(auth, deps) {
  const { db, fetch, token } = deps;
  const now = (deps.now || Date.now)();

  // Merroir sign-ins (M5) carry their name in their staff entry ("Garrett K.").
  const actor = await staffName(auth, db, 'start a Toast sync');
  if (!token) {
    throw new SyncError('failed-precondition', 'Sync is not set up (no GitHub token on the server).');
  }

  // Claim the 2-minute slot atomically, so two quick presses (or two
  // phones) can't both start a sync.
  const lastRef = db.ref(LAST_TRIGGER_PATH);
  let previous = null;
  const claim = await lastRef.transaction((current) => {
    previous = current;
    if (current && typeof current.at === 'number' && now - current.at < MIN_GAP_MS) {
      return; // abort: too soon
    }
    return { at: now, by: actor };
  });
  if (!claim.committed) {
    const last = claim.snapshot.val() || {};
    const waitSeconds = Math.max(1, Math.ceil((last.at + MIN_GAP_MS - now) / 1000));
    throw new SyncError('resource-exhausted',
      `A sync was started less than 2 minutes ago. Try again in ${waitSeconds} seconds.`,
      { retryAfterSeconds: waitSeconds });
  }

  let res;
  try {
    res = await fetch(DISPATCH_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'half-shell-cloud',
      },
      body: JSON.stringify({ ref: 'main' }),
    });
  } catch (e) {
    res = { status: 0, error: e };
  }

  if (res.status !== 204) {
    // Give the slot back so a failed attempt doesn't block the next one.
    await lastRef.set(previous === undefined ? null : previous);
    const why = res.status === 0 ? `GitHub could not be reached (${res.error && res.error.message})`
      : `GitHub answered ${res.status}`;
    await db.ref('audit-log').push(auditEntry('toast_sync_request_failed', why, actor, now));
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      throw new SyncError('failed-precondition',
        'The server\'s GitHub token was refused. Ask a manager to replace it.', { status: res.status });
    }
    throw new SyncError('unavailable', 'GitHub didn\'t start the sync. Try again in a minute.',
      { status: res.status });
  }

  await db.ref('audit-log').push(auditEntry('toast_sync_requested',
    'Manual Toast sync started from the employee page', actor, now));
  return { ok: true, nextAllowedAt: now + MIN_GAP_MS };
}

// ─── Menu overrides (step S6) ───────────────────────────────────────────────

const menu = require('./menu-logic');

const CATALOG_URL = 'https://hsoysters.com/data/oysters.js';
const CATALOG_TTL_MS = 10 * 60 * 1000;
const MAX_CHANGES = 100;
let catalogCache = { at: 0, ids: null };

/** Catalog ids from the live site's data/oysters.js, kept for 10 minutes. */
async function liveCatalogIds(fetchFn, now) {
  if (catalogCache.ids && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.ids;
  const res = await fetchFn(CATALOG_URL);
  if (!res || res.status !== 200) throw new Error(`catalog answered ${res && res.status}`);
  // Read the ids as text (each entry's `    id: "slug",` line); the
  // fetched file is never run.
  const text = await res.text();
  const ids = [...text.matchAll(/^\s*id:\s*"([a-z0-9-]+)",?\s*$/gm)].map((m) => m[1]);
  if (ids.length < 10) throw new Error(`catalog has only ${ids.length} ids`);
  catalogCache = { at: now, ids: new Set(ids) };
  return catalogCache.ids;
}

/** Who is asking, and are they staff? Returns their name for the change log. */
async function staffName(auth, db, what) {
  if (!auth || !auth.uid) {
    throw new SyncError('unauthenticated', 'Sign in on the employee page first.');
  }
  const staff = await db.ref(`staff/${auth.uid}`).once('value');
  if (!staff.exists()) {
    throw new SyncError('permission-denied', `Only staff accounts can ${what}.`);
  }
  const entry = staff.val();
  return (entry && typeof entry === 'object' && entry.name)
    || (auth.token && auth.token.email) || auth.uid;
}

/**
 * setMenuOverride — the employee page's Save Menu and "Back to Toast".
 * data: { changes: [{ id, state: 'on' | 'off' | null }] }
 *   'on'  — on tonight's menu until 4 AM whatever Toast says
 *   'off' — off tonight's menu until 4 AM whatever Toast says
 *   null  — back to Toast: the override is removed and the oyster follows
 *           Toast's last in-stock list at once
 * Asking for what Toast already says ('on' for an oyster Toast has in
 * stock, 'off' for one it has 86'd) is treated as Back to Toast, so
 * undoing a change never leaves a needless override behind.
 * Writes overrides and menu/serving in one update, clears any expired
 * overrides it finds, and writes one audit-log entry per change.
 * deps: { db, fetch, now }. Returns { ok, until }. Throws SyncError.
 */
async function setMenuOverride(auth, data, deps) {
  const { db } = deps;
  const now = (deps.now || Date.now)();
  const actor = await staffName(auth, db, 'change tonight\'s menu');

  const changes = data && Array.isArray(data.changes) ? data.changes : null;
  if (!changes || changes.length === 0 || changes.length > MAX_CHANGES) {
    throw new SyncError('invalid-argument', 'Nothing to change.');
  }
  const seen = new Set();
  for (const c of changes) {
    if (!c || typeof c.id !== 'string' || !menu.SLUG.test(c.id) || c.id.length > 80
        || !(c.state === 'on' || c.state === 'off' || c.state === null)) {
      throw new SyncError('invalid-argument', 'One of the changes isn\'t valid. Reload the page.');
    }
    if (seen.has(c.id)) throw new SyncError('invalid-argument', 'An oyster is listed twice.');
    seen.add(c.id);
  }
  // Oysters being put on (or forced off) must be in the published catalog.
  // If the catalog can't be read, the id format check above stands.
  try {
    const ids = await liveCatalogIds(deps.fetch, now);
    const unknown = changes.filter((c) => c.state !== null && !ids.has(c.id)).map((c) => c.id);
    if (unknown.length) {
      throw new SyncError('invalid-argument', `Not in the oyster catalog: ${unknown.join(', ')}.`);
    }
  } catch (e) {
    if (e instanceof SyncError) throw e;
    console.warn('Catalog check skipped:', e.message);
  }

  const [ovSnap, toastSnap, servingSnap] = await Promise.all([
    db.ref('menu/overrides').once('value'),
    db.ref('menu/toastInStock').once('value'),
    db.ref('menu/serving').once('value'),
  ]);
  const { active, expired } = menu.splitOverrides(ovSnap.val(), now);
  const toast = Object.keys(toastSnap.val() || {});
  const current = servingSnap.val() || {};
  const until = menu.next4am(now);

  // Asking for what Toast already says (turning back on a Toast oyster that
  // was forced off, or off one Toast has 86'd) just ends the override.
  const inToast = new Set(toast);
  for (const c of changes) {
    if ((c.state === 'on' && inToast.has(c.id)) || (c.state === 'off' && !inToast.has(c.id))) {
      c.state = null;
    }
  }

  const updates = {};
  for (const id of expired) {
    updates[`overrides/${id}`] = null;
    delete active[id];
  }
  for (const c of changes) {
    if (c.state === null) {
      delete active[c.id];
      updates[`overrides/${c.id}`] = null;
    } else {
      active[c.id] = { state: c.state, until, by: actor, at: now };
      updates[`overrides/${c.id}`] = active[c.id];
    }
  }
  Object.assign(updates, menu.servingUpdates(
    [...new Set([...expired, ...changes.map((c) => c.id)])], toast, active, current, now));
  await db.ref('menu').update(updates);

  const words = { on: 'On the menu until 4 AM', off: 'Off the menu until 4 AM' };
  const actions = { on: 'menu_override_on', off: 'menu_override_off' };
  for (const c of changes) {
    await db.ref('audit-log').push({
      ...auditEntry(c.state ? actions[c.state] : 'menu_override_cleared',
        c.state ? words[c.state] : 'Back to Toast', actor, now),
      oysterId: c.id,
    });
  }
  return { ok: true, until };
}

// ─── Happy hour (S5) ────────────────────────────────────────────────────────

const prices = require('./price-logic');
const MANAGER_RANK = 20;

/**
 * setHappyHour — the employee page's Happy hour section (S5; "Price and
 * Happy Hour Plan", 06/10/2026). MANAGER and above: the rank Merroir puts in
 * the sign-in (claim staff_rank), and a staff/{uid} entry.
 * data: { schedule: {days, start, end, percentOff} }   the standing rule
 *    or { today: 'on' | 'off' | null }                  today's switch, until
 *                                                        4 AM; null = back to
 *                                                        the schedule
 * Writes menu/happyHour/... and one audit-log entry. Returns { ok, ... }.
 * This changes only what the site shows; Toast charges what Toast charges.
 */
async function setHappyHour(auth, data, deps) {
  const { db } = deps;
  const now = (deps.now || Date.now)();
  const actor = await staffName(auth, db, 'change happy hour');
  const rank = Number(auth.token && auth.token.staff_rank);
  if (!(rank >= MANAGER_RANK)) {
    throw new SyncError('permission-denied', 'Only managers can change happy hour. Sign out and in again if you were just promoted.');
  }
  const log = (action, details) => db.ref('audit-log').push(auditEntry(action, details, actor, now));

  if (data && 'schedule' in data) {
    let schedule;
    try { schedule = prices.validateSchedule(data.schedule); } catch (e) {
      throw new SyncError('invalid-argument', e.message);
    }
    await db.ref('menu/happyHour/schedule').set({ ...schedule, by: actor, at: now });
    await log('happy_hour_schedule_set', prices.describeSchedule(schedule));
    return { ok: true, schedule };
  }
  if (data && 'today' in data) {
    const state = data.today;
    if (!(state === 'on' || state === 'off' || state === null)) {
      throw new SyncError('invalid-argument', 'Today is on, off, or back to the schedule.');
    }
    if (state === null) {
      await db.ref('menu/happyHour/today').set(null);
      await log('happy_hour_today_cleared', 'Happy hour today: back to the schedule');
      return { ok: true, today: null };
    }
    const until = menu.next4am(now);
    await db.ref('menu/happyHour/today').set({ state, until, by: actor, at: now });
    await log(state === 'on' ? 'happy_hour_today_on' : 'happy_hour_today_off',
      `Happy hour ${state} today, until 4 AM`);
    return { ok: true, today: { state, until } };
  }
  throw new SyncError('invalid-argument', 'Nothing to save.');
}

module.exports = {
  setHappyHour, MANAGER_RANK,
  startToastSync, setMenuOverride, SyncError, DISPATCH_URL, MIN_GAP_MS, LAST_TRIGGER_PATH,
  CATALOG_URL, _resetCatalogCache: () => { catalogCache = { at: 0, ids: null }; },
};
