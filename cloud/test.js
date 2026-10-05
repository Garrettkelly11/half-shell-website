/**
 * Tests for the `cloud` functions (S4). Plain Node, no network, no
 * Firebase: a fake database and a fake GitHub.
 *
 *   cd cloud && npm install && node test.js
 */

'use strict';

const assert = require('assert');
const lib = require('./lib');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('PASS  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

// A fake Realtime Database: enough of ref() for lib.js.
function fakeDb(initial) {
  const data = JSON.parse(JSON.stringify(initial || {}));
  const get = (path) => path.split('/').reduce((o, k) => (o == null ? undefined : o[k]), data);
  const put = (path, val) => {
    const keys = path.split('/'); const last = keys.pop();
    let o = data; for (const k of keys) { o[k] = o[k] || {}; o = o[k]; }
    if (val === null || val === undefined) delete o[last]; else o[last] = val;
  };
  const snap = (v) => ({ exists: () => v !== undefined && v !== null, val: () => (v === undefined ? null : v) });
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
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (status === 'down') throw new Error('getaddrinfo ENOTFOUND api.github.com');
    return { status };
  };
  fn.calls = calls;
  return fn;
}

const STAFF_UID = 'staff-uid';
const staffAuth = { uid: STAFF_UID, token: { email: 'staff@hsoysters.com' } };
const T0 = Date.UTC(2026, 9, 5, 18, 0, 0);

function deps(db, gh, now, token = 'ghp_test') {
  return { db, fetch: gh, token, now: () => now };
}

async function rejects(promise, code) {
  try { await promise; } catch (e) {
    assert.strictEqual(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return e;
  }
  throw new Error(`expected ${code}, but it succeeded`);
}

(async () => {
  await check('signed out: refused (unauthenticated), GitHub not called', async () => {
    const db = fakeDb({ staff: { [STAFF_UID]: true } }); const gh = fakeGitHub(204);
    await rejects(lib.startToastSync(null, deps(db, gh, T0)), 'unauthenticated');
    assert.strictEqual(gh.calls.length, 0);
  });

  await check('signed in but not staff (e.g. a Passport phone user): refused (permission-denied)', async () => {
    const db = fakeDb({ staff: { [STAFF_UID]: true } }); const gh = fakeGitHub(204);
    await rejects(lib.startToastSync({ uid: 'phone-user', token: { phone_number: '+17045550100' } },
      deps(db, gh, T0)), 'permission-denied');
    assert.strictEqual(gh.calls.length, 0);
  });

  await check('no token on the server: refused (failed-precondition), nothing recorded', async () => {
    const db = fakeDb({ staff: { [STAFF_UID]: true } }); const gh = fakeGitHub(204);
    await rejects(lib.startToastSync(staffAuth, deps(db, gh, T0, '')), 'failed-precondition');
    assert.strictEqual(gh.calls.length, 0);
    assert.strictEqual(db.data.server, undefined);
  });

  const db = fakeDb({ staff: { [STAFF_UID]: true } });
  const gh = fakeGitHub(204);
  await check('staff: GitHub is asked to run sync-oysters.yml on main, with the server token', async () => {
    const out = await lib.startToastSync(staffAuth, deps(db, gh, T0));
    assert.deepStrictEqual(out, { ok: true, nextAllowedAt: T0 + 120000 });
    assert.strictEqual(gh.calls.length, 1);
    const { url, opts } = gh.calls[0];
    assert.strictEqual(url, 'https://api.github.com/repos/Garrettkelly11/half-shell-website/actions/workflows/sync-oysters.yml/dispatches');
    assert.strictEqual(opts.method, 'POST');
    assert.strictEqual(opts.headers.Authorization, 'Bearer ghp_test');
    assert.deepStrictEqual(JSON.parse(opts.body), { ref: 'main' });
  });
  await check('…records the time and who, at server/lastSyncTrigger', async () => {
    assert.deepStrictEqual(db.data.server.lastSyncTrigger, { at: T0, by: 'staff@hsoysters.com' });
  });
  await check('…and writes an audit-log entry with the signed-in email', async () => {
    const entries = Object.values(db.data['audit-log']);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].action, 'toast_sync_requested');
    assert.strictEqual(entries[0].actor, 'staff@hsoysters.com');
    assert.strictEqual(entries[0].timestamp, T0);
    assert.strictEqual(entries[0].readable_timestamp, new Date(T0).toISOString());
  });

  await check('a second press 90 seconds later: refused (resource-exhausted), says 30 seconds', async () => {
    const e = await rejects(lib.startToastSync(staffAuth, deps(db, gh, T0 + 90000)), 'resource-exhausted');
    assert.deepStrictEqual(e.details, { retryAfterSeconds: 30 });
    assert.ok(/30 seconds/.test(e.message));
    assert.strictEqual(gh.calls.length, 1);
    assert.strictEqual(db.data.server.lastSyncTrigger.at, T0);
  });
  await check('the limit is across all staff, not per person', async () => {
    db.data.staff.other = true;
    await rejects(lib.startToastSync({ uid: 'other', token: { email: 'other@x.com' } },
      deps(db, gh, T0 + 119999)), 'resource-exhausted');
  });
  await check('exactly 2 minutes later: allowed', async () => {
    await lib.startToastSync(staffAuth, deps(db, gh, T0 + 120000));
    assert.strictEqual(gh.calls.length, 2);
    assert.strictEqual(db.data.server.lastSyncTrigger.at, T0 + 120000);
  });

  await check('GitHub refuses the token (401): failed-precondition, slot given back, failure audited', async () => {
    const db2 = fakeDb({ staff: { [STAFF_UID]: true }, server: { lastSyncTrigger: { at: T0 - 600000, by: 'x' } } });
    const e = await rejects(lib.startToastSync(staffAuth, deps(db2, fakeGitHub(401), T0)), 'failed-precondition');
    assert.ok(/token was refused/.test(e.message));
    assert.deepStrictEqual(db2.data.server.lastSyncTrigger, { at: T0 - 600000, by: 'x' });
    const entries = Object.values(db2.data['audit-log']);
    assert.strictEqual(entries[0].action, 'toast_sync_request_failed');
    assert.ok(/401/.test(entries[0].details));
  });
  await check('GitHub down: unavailable, and the next press is not blocked', async () => {
    const db3 = fakeDb({ staff: { [STAFF_UID]: true } });
    await rejects(lib.startToastSync(staffAuth, deps(db3, fakeGitHub('down'), T0)), 'unavailable');
    assert.strictEqual((db3.data.server || {}).lastSyncTrigger, undefined);
    await lib.startToastSync(staffAuth, deps(db3, fakeGitHub(204), T0 + 1000));
  });
  await check('GitHub error 500: unavailable', async () => {
    const db4 = fakeDb({ staff: { [STAFF_UID]: true } });
    const e = await rejects(lib.startToastSync(staffAuth, deps(db4, fakeGitHub(500), T0)), 'unavailable');
    assert.deepStrictEqual(e.details, { status: 500 });
  });

  await check('index.js exports startToastSync as a callable in us-east1 using the GH_DISPATCH_TOKEN secret', async () => {
    process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'half-shell-oyster-menu';
    const fns = require('./index.js');
    const ep = fns.startToastSync.__endpoint;
    assert.ok(ep.callableTrigger, 'not a callable');
    assert.deepStrictEqual(ep.region, ['us-east1']);
    assert.ok((ep.secretEnvironmentVariables || []).some((s) => s.key === 'GH_DISPATCH_TOKEN'));
  });

  console.log('\n' + (failed ? `${failed} of ${passed + failed} checks failed.` : `All ${passed} checks passed.`));
  process.exit(failed ? 1 : 0);
})();
