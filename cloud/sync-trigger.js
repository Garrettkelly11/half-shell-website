/**
 * What starts a Toast sync besides the employee page's button (11/17/2026).
 * The 15-minute GitHub schedule was dropped: GitHub ran it only a few times
 * a day. Instead:
 *
 * toastWebhook — Toast calls this when an item's stock changes (86'd, back
 *   in stock, a count set or used up) and when a menu is published. It starts
 *   the GitHub sync, at most once every 5 minutes. An event inside the
 *   5 minutes is not dropped: it schedules one catch-up sync for when the
 *   5 minutes end (the workflow waits, then reads Toast), and any further
 *   events before then are covered by that run. So a burst of 86s at open
 *   ends with one sync after the last of them.
 *   State: server/webhookSync = { runAt, at, event } — runAt is when the
 *   latest sync reads Toast (now, or up to 5 minutes ahead).
 *
 * refreshMenu — the menu page calls this when a guest opens it (or comes
 *   back to the tab). It syncs only if no sync has finished in 30 minutes
 *   (server/lastSync, written by the sync script), and at most once every
 *   10 minutes across all guests (server/safetyNet), so a missed webhook or
 *   last night's employee-page override can't linger.
 *
 * Both use the employee page's GitHub token and workflow (lib.js). Pure
 * logic with injected db/fetch/now, tested by sync-trigger-test.js.
 */

'use strict';

const crypto = require('crypto');
const { DISPATCH_URL, auditEntry } = require('./lib');

const WEBHOOK_GAP_MS = 5 * 60 * 1000;
const SAFETY_STALE_MS = 30 * 60 * 1000;
const SAFETY_RETRY_MS = 10 * 60 * 1000;
const WEBHOOK_PATH = 'server/webhookSync';
const SAFETY_PATH = 'server/safetyNet';
const LAST_SYNC_PATH = 'server/lastSync';
const CATEGORIES = new Set(['stock', 'menus']);
const RESTAURANT_GUID = '55811240-e58f-4128-a1d7-137fbe1e2047';   // Half Shell (not secret)

// ─── Toast message signing ──────────────────────────────────────────────────
// Toast: Base64(HMAC-SHA256(secret, body + timestamp)), sent in the
// Toast-Signature header. Each subscription (stock, menus) has its own
// secret. Toast's page doesn't say where the timestamp comes from, so a
// header timestamp and the payload's own `timestamp` are both tried.

function sign(secret, body, timestamp) {
  return crypto.createHmac('sha256', String(secret)).update(body + (timestamp || ''), 'utf8').digest('base64');
}

function sameText(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** true if the request carries a valid Toast signature for any of `secrets`. */
function verifySignature(rawBody, headers, secrets) {
  const given = headers && headers['toast-signature'];
  const keys = (secrets || []).filter((s) => s && s !== 'pending');
  if (!given || !keys.length) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const stamps = new Set([headers['toast-timestamp'], headers['x-toast-timestamp']].filter(Boolean));
  try { const t = JSON.parse(body).timestamp; if (t) stamps.add(String(t)); } catch (e) { /* not JSON */ }
  stamps.add('');
  for (const key of keys) for (const ts of stamps) if (sameText(sign(key, body, ts), given)) return true;
  return false;
}

// ─── Starting the GitHub sync ───────────────────────────────────────────────

/** Ask GitHub to run the sync. Returns the HTTP status (0 = unreachable). */
async function dispatch(fetchFn, token, inputs) {
  try {
    const res = await fetchFn(DISPATCH_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'half-shell-cloud',
      },
      body: JSON.stringify({ ref: 'main', inputs }),
    });
    return res.status;
  } catch (e) {
    return 0;
  }
}

/**
 * The webhook cooldown. lastRunAt: when the latest sync reads Toast.
 *   covered — a sync is already set to read Toast after now
 *   run     — read Toast at runAt (now, or when the 5 minutes end)
 */
function planWebhookRun(lastRunAt, now) {
  if (typeof lastRunAt === 'number' && lastRunAt > now) return { action: 'covered' };
  if (typeof lastRunAt !== 'number' || now - lastRunAt >= WEBHOOK_GAP_MS) {
    return { action: 'run', runAt: now, delayMs: 0 };
  }
  const runAt = lastRunAt + WEBHOOK_GAP_MS;
  return { action: 'run', runAt, delayMs: runAt - now };
}

/**
 * req:  { method, headers (lower-case names), rawBody }
 * deps: { db, fetch, token, secrets: [stockSecret, menusSecret], now }
 * Returns { status, result, ... } for the HTTP reply. A failed GitHub call
 * answers 502 so Toast can retry; the cooldown slot is given back.
 */
async function handleToastWebhook(req, deps) {
  const { db } = deps;
  const now = (deps.now || Date.now)();
  if (req.method !== 'POST') return { status: 405, result: 'POST only' };
  if (!verifySignature(req.rawBody, req.headers, deps.secrets)) {
    return { status: 401, result: 'bad signature', headerNames: Object.keys(req.headers || {}).sort() };
  }
  let body;
  try { body = JSON.parse(Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : req.rawBody); } catch (e) {
    return { status: 400, result: 'not JSON' };
  }
  const category = String(body.eventCategory || ''), type = String(body.eventType || '');
  const guid = body.details && body.details.restaurantGuid;
  if (!CATEGORIES.has(category) || (guid && guid !== RESTAURANT_GUID)) return { status: 200, result: 'ignored' };
  if (!deps.token) return { status: 503, result: 'no GitHub token on the server' };

  const event = `${category}/${type}`.slice(0, 60);
  const ref = db.ref(WEBHOOK_PATH);
  let previous = null, plan = null;
  const claim = await ref.transaction((cur) => {
    previous = cur;
    plan = planWebhookRun(cur && cur.runAt, now);
    if (plan.action === 'covered') return;   // abort: the pending run covers it
    return { runAt: plan.runAt, at: now, event };
  });
  if (!claim.committed) return { status: 200, result: 'covered' };

  const delaySeconds = Math.ceil(plan.delayMs / 1000);
  const status = await dispatch(deps.fetch, deps.token,
    { trigger: `Toast webhook (${event})`, delay_seconds: String(delaySeconds) });
  if (status !== 204) {
    await ref.set(previous === undefined ? null : previous);
    await db.ref('audit-log').push(auditEntry('toast_webhook_dispatch_failed',
      `${event}: GitHub answered ${status || 'nothing'}`, 'Toast webhook', now));
    return { status: 502, result: 'GitHub did not start the sync' };
  }
  return { status: 200, result: delaySeconds ? 'scheduled' : 'started', delaySeconds };
}

/**
 * The safety net, called by the menu page. deps: { db, fetch, token, now }.
 * Returns { ok, started?, fresh?, pending? }. Never throws for guests.
 */
async function refreshMenu(deps) {
  const { db } = deps;
  const now = (deps.now || Date.now)();
  const last = (await db.ref(LAST_SYNC_PATH).once('value')).val();
  if (last && typeof last.at === 'number' && now - last.at < SAFETY_STALE_MS) return { ok: true, fresh: true };
  if (!deps.token) return { ok: false };

  const ref = db.ref(SAFETY_PATH);
  let previous = null;
  const claim = await ref.transaction((cur) => {
    previous = cur;
    if (cur && typeof cur.at === 'number' && now - cur.at < SAFETY_RETRY_MS) return;   // asked recently
    return { at: now };
  });
  if (!claim.committed) return { ok: true, pending: true };

  const status = await dispatch(deps.fetch, deps.token, { trigger: 'Menu opened (safety net)', delay_seconds: '0' });
  if (status !== 204) {
    await ref.set(previous === undefined ? null : previous);
    console.warn(`refreshMenu: GitHub answered ${status || 'nothing'}`);
    return { ok: false };
  }
  return { ok: true, started: true };
}

module.exports = {
  WEBHOOK_GAP_MS, SAFETY_STALE_MS, SAFETY_RETRY_MS, WEBHOOK_PATH, SAFETY_PATH, LAST_SYNC_PATH,
  RESTAURANT_GUID, sign, verifySignature, planWebhookRun, handleToastWebhook, refreshMenu,
};
