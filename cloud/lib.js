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
 *   4. Writes an audit-log entry with the caller's email, from the verified
 *      sign-in, not from anything the page sends.
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

  if (!auth || !auth.uid) {
    throw new SyncError('unauthenticated', 'Sign in on the employee page first.');
  }
  const staff = await db.ref(`staff/${auth.uid}`).once('value');
  if (!staff.exists()) {
    throw new SyncError('permission-denied', 'Only staff accounts can start a Toast sync.');
  }
  const actor = (auth.token && auth.token.email) || auth.uid;
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

module.exports = { startToastSync, SyncError, DISPATCH_URL, MIN_GAP_MS, LAST_TRIGGER_PATH };
