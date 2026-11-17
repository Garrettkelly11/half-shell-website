/**
 * Tests for sync-trigger.js (Toast webhook and menu safety net, 11/17/2026).
 * Plain Node, no network: a fake database and a fake GitHub.
 *   cd cloud && node sync-trigger-test.js
 */

'use strict';

const assert = require('assert');
const t = require('./sync-trigger');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('PASS  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

function fakeDb(initial) {
  const data = JSON.parse(JSON.stringify(initial || {}));
  const get = (path) => path.split('/').reduce((o, k) => (o == null ? undefined : o[k]), data);
  const put = (path, val) => {
    const keys = path.split('/'); const last = keys.pop();
    let o = data; for (const k of keys) { o[k] = o[k] || {}; o = o[k]; }
    if (val === null || val === undefined) delete o[last]; else o[last] = JSON.parse(JSON.stringify(val));
  };
  const snap = (v) => ({ exists: () => v != null, val: () => (v === undefined ? null : v) });
  let pushes = 0;
  return {
    data,
    ref(path) {
      return {
        once: async () => snap(get(path)),
        set: async (v) => put(path, v),
        push: async (v) => { put(`${path}/k${++pushes}`, v); },
        transaction: async (fn) => {
          const out = fn(get(path) === undefined ? null : get(path));
          if (out === undefined) return { committed: false, snapshot: snap(get(path)) };
          put(path, out);
          return { committed: true, snapshot: snap(out) };
        },
      };
    },
  };
}

function fakeGitHub(status) {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { status }; };
  fn.calls = calls;
  return fn;
}

const STOCK = 'stock-secret', MENUS = 'menus-secret';
const T0 = Date.UTC(2026, 10, 17, 17, 0, 0);
const MIN = 60 * 1000;

function event(category = 'stock', type = 'out_of_stock', extra = {}) {
  return JSON.stringify({ timestamp: '2026-11-17T17:00:00.000Z', eventCategory: category, eventType: type,
    guid: 'evt-1', details: { itemGuid: 'b3ebe4f8-58e8-4593-9d6c-689560406b45', ...extra } });
}
function signedReq(body, secret = STOCK, ts = JSON.parse(body).timestamp) {
  return { method: 'POST', rawBody: Buffer.from(body), headers: { 'toast-signature': t.sign(secret, body, ts) } };
}
function deps(db, gh, now) {
  return { db, fetch: gh, token: 'ghp_test', secrets: [STOCK, MENUS], now: () => now };
}

(async () => {
  // ── Signing ────────────────────────────────────────────────────────────
  await check('signature: body + payload timestamp, stock secret -> valid', async () => {
    const b = event(); const r = signedReq(b);
    assert.ok(t.verifySignature(r.rawBody, r.headers, [STOCK, MENUS]));
  });
  await check('signature: menus secret also accepted', async () => {
    const b = event('menus', 'menus_updated'); const r = signedReq(b, MENUS);
    assert.ok(t.verifySignature(r.rawBody, r.headers, [STOCK, MENUS]));
  });
  await check('signature: timestamp from a header -> valid', async () => {
    const b = event(); const h = { 'toast-signature': t.sign(STOCK, b, '1763398800'), 'toast-timestamp': '1763398800' };
    assert.ok(t.verifySignature(Buffer.from(b), h, [STOCK]));
  });
  await check('signature: wrong secret, missing header, edited body, placeholder secret -> invalid', async () => {
    const b = event();
    assert.ok(!t.verifySignature(Buffer.from(b), signedReq(b, 'nope').headers, [STOCK, MENUS]));
    assert.ok(!t.verifySignature(Buffer.from(b), {}, [STOCK]));
    assert.ok(!t.verifySignature(Buffer.from(b.replace('out_of_stock', 'in_stock')), signedReq(b).headers, [STOCK]));
    assert.ok(!t.verifySignature(Buffer.from(b), signedReq(b, 'pending').headers, ['pending']));
  });

  // ── Cooldown plan ──────────────────────────────────────────────────────
  await check('plan: nothing yet -> run now', async () => {
    assert.deepStrictEqual(t.planWebhookRun(undefined, T0), { action: 'run', runAt: T0, delayMs: 0 });
  });
  await check('plan: last run 1 min ago -> run when the 5 min end', async () => {
    assert.deepStrictEqual(t.planWebhookRun(T0 - MIN, T0), { action: 'run', runAt: T0 + 4 * MIN, delayMs: 4 * MIN });
  });
  await check('plan: a run is already set for later -> covered', async () => {
    assert.deepStrictEqual(t.planWebhookRun(T0 + MIN, T0), { action: 'covered' });
  });
  await check('plan: last run 5+ min ago -> run now', async () => {
    assert.strictEqual(t.planWebhookRun(T0 - 5 * MIN, T0).delayMs, 0);
  });

  // ── Webhook handler ────────────────────────────────────────────────────
  await check('webhook: unsigned -> 401, GitHub not called', async () => {
    const db = fakeDb(); const gh = fakeGitHub(204);
    const r = await t.handleToastWebhook({ method: 'POST', rawBody: Buffer.from(event()), headers: {} }, deps(db, gh, T0));
    assert.strictEqual(r.status, 401); assert.strictEqual(gh.calls.length, 0);
  });
  await check('webhook: GET -> 405', async () => {
    const r = await t.handleToastWebhook({ method: 'GET', headers: {} }, deps(fakeDb(), fakeGitHub(204), T0));
    assert.strictEqual(r.status, 405);
  });
  await check('webhook: other category or restaurant -> 200 ignored, no sync', async () => {
    const db = fakeDb(); const gh = fakeGitHub(204);
    const a = await t.handleToastWebhook(signedReq(event('orders', 'order_updated')), deps(db, gh, T0));
    const b = await t.handleToastWebhook(signedReq(event('menus', 'menus_updated', { restaurantGuid: 'someone-else' })), deps(db, gh, T0));
    assert.strictEqual(a.result, 'ignored'); assert.strictEqual(b.result, 'ignored'); assert.strictEqual(gh.calls.length, 0);
  });
  await check('webhook: burst at open -> one sync now, one catch-up at +5 min, rest covered', async () => {
    const db = fakeDb(); const gh = fakeGitHub(204);
    const r1 = await t.handleToastWebhook(signedReq(event()), deps(db, gh, T0));
    const r2 = await t.handleToastWebhook(signedReq(event('stock', 'in_stock')), deps(db, gh, T0 + MIN));
    const r3 = await t.handleToastWebhook(signedReq(event()), deps(db, gh, T0 + 2 * MIN));
    const r4 = await t.handleToastWebhook(signedReq(event('menus', 'menus_updated'), MENUS), deps(db, gh, T0 + 4 * MIN));
    assert.deepStrictEqual([r1.result, r2.result, r3.result, r4.result], ['started', 'scheduled', 'covered', 'covered']);
    assert.strictEqual(r2.delaySeconds, 240);
    assert.strictEqual(gh.calls.length, 2);
    assert.deepStrictEqual(gh.calls[0].body, { ref: 'main', inputs: { trigger: 'Toast webhook (stock/out_of_stock)', delay_seconds: '0' } });
    assert.strictEqual(gh.calls[1].body.inputs.delay_seconds, '240');
    assert.strictEqual(db.data.server.webhookSync.runAt, T0 + 5 * MIN);
  });
  await check('webhook: just after the catch-up read -> next one waits another 5 min', async () => {
    const db = fakeDb({ server: { webhookSync: { runAt: T0 } } }); const gh = fakeGitHub(204);
    const r = await t.handleToastWebhook(signedReq(event()), deps(db, gh, T0 + 10 * 1000));
    assert.strictEqual(r.delaySeconds, 290);
  });
  await check('webhook: quiet for 5+ min -> starts at once', async () => {
    const db = fakeDb({ server: { webhookSync: { runAt: T0 } } }); const gh = fakeGitHub(204);
    const r = await t.handleToastWebhook(signedReq(event()), deps(db, gh, T0 + 6 * MIN));
    assert.strictEqual(r.result, 'started');
  });
  await check('webhook: GitHub fails -> 502 (Toast retries), slot given back, logged', async () => {
    const db = fakeDb({ server: { webhookSync: { runAt: T0 - 10 * MIN } } }); const gh = fakeGitHub(500);
    const r = await t.handleToastWebhook(signedReq(event()), deps(db, gh, T0));
    assert.strictEqual(r.status, 502);
    assert.strictEqual(db.data.server.webhookSync.runAt, T0 - 10 * MIN);
    assert.strictEqual(Object.values(db.data['audit-log'])[0].action, 'toast_webhook_dispatch_failed');
  });

  // ── Safety net ─────────────────────────────────────────────────────────
  await check('safety net: synced 10 min ago -> nothing', async () => {
    const db = fakeDb({ server: { lastSync: { at: T0 - 10 * MIN } } }); const gh = fakeGitHub(204);
    assert.deepStrictEqual(await t.refreshMenu(deps(db, gh, T0)), { ok: true, fresh: true });
    assert.strictEqual(gh.calls.length, 0);
  });
  await check('safety net: last sync 40 min ago -> one sync; next guest within 10 min -> nothing', async () => {
    const db = fakeDb({ server: { lastSync: { at: T0 - 40 * MIN } } }); const gh = fakeGitHub(204);
    assert.strictEqual((await t.refreshMenu(deps(db, gh, T0))).started, true);
    assert.strictEqual((await t.refreshMenu(deps(db, gh, T0 + 2 * MIN))).pending, true);
    assert.strictEqual(gh.calls.length, 1);
    assert.strictEqual(gh.calls[0].body.inputs.trigger, 'Menu opened (safety net)');
  });
  await check('safety net: never synced -> syncs', async () => {
    const gh = fakeGitHub(204);
    assert.strictEqual((await t.refreshMenu(deps(fakeDb(), gh, T0))).started, true);
  });
  await check('safety net: GitHub fails -> ok:false, slot given back', async () => {
    const db = fakeDb(); const gh = fakeGitHub(500);
    assert.deepStrictEqual(await t.refreshMenu(deps(db, gh, T0)), { ok: false });
    assert.strictEqual(db.data.server && db.data.server.safetyNet, undefined);
  });

  // ── index.js wiring ────────────────────────────────────────────────────
  await check('index.js: toastWebhook is public HTTPS in us-east1 with its 3 secrets', async () => {
    const ep = require('./index.js').toastWebhook.__endpoint;
    assert.ok(ep.httpsTrigger, 'https trigger'); assert.strictEqual(ep.region[0], 'us-east1');
    assert.deepStrictEqual(ep.httpsTrigger.invoker, ['public']);
    assert.deepStrictEqual(ep.secretEnvironmentVariables.map((s) => s.key).sort(),
      ['GH_DISPATCH_TOKEN', 'TOAST_WEBHOOK_SECRET_MENUS', 'TOAST_WEBHOOK_SECRET_STOCK']);
  });
  await check('index.js: refreshMenu is a callable in us-east1 with the GitHub token', async () => {
    const ep = require('./index.js').refreshMenu.__endpoint;
    assert.ok(ep.callableTrigger); assert.strictEqual(ep.region[0], 'us-east1');
    assert.deepStrictEqual(ep.secretEnvironmentVariables.map((s) => s.key), ['GH_DISPATCH_TOKEN']);
  });

  console.log('\n' + (failed ? `${failed} of ${passed + failed} checks failed.` : `All ${passed} checks passed.`));
  process.exit(failed ? 1 : 0);
})();
