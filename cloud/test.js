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
    if (val === null || val === undefined) delete o[last]; else o[last] = JSON.parse(JSON.stringify(val));
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
        update: async (obj) => {
          for (const [k, v] of Object.entries(obj)) put(`${path}/${k}`, v === undefined ? null : v);
        },
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

  await check('a Merroir sign-in is named from its staff entry ("Garrett K.")', async () => {
    const db5 = fakeDb({ staff: { 'merroir:1': { name: 'Garrett K.', rank: 40, location: null } } });
    await lib.startToastSync({ uid: 'merroir:1', token: {} }, deps(db5, fakeGitHub(204), T0));
    assert.strictEqual(Object.values(db5.data['audit-log'])[0].actor, 'Garrett K.');
    assert.strictEqual(db5.data.server.lastSyncTrigger.by, 'Garrett K.');
  });

  // ─── Step S6: menu overrides ──────────────────────────────────────────────
  const M = require('./menu-logic');
  const ny = (iso) => Date.parse(iso);   // ISO with offset, e.g. -04:00 (EDT) / -05:00 (EST)

  await check('4 AM: an evening override ends at 4 AM the next morning (EDT)', async () => {
    assert.strictEqual(M.next4am(ny('2026-10-05T18:00:00-04:00')), ny('2026-10-06T04:00:00-04:00'));
  });
  await check('4 AM: set at 2 AM, it ends at 4 AM the same morning', async () => {
    assert.strictEqual(M.next4am(ny('2026-10-06T02:00:00-04:00')), ny('2026-10-06T04:00:00-04:00'));
  });
  await check('4 AM: at 3:59:59 it is that 4 AM; at exactly 4:00 it is the next day', async () => {
    assert.strictEqual(M.next4am(ny('2026-10-06T03:59:59-04:00')), ny('2026-10-06T04:00:00-04:00'));
    assert.strictEqual(M.next4am(ny('2026-10-06T04:00:00-04:00')), ny('2026-10-07T04:00:00-04:00'));
  });
  await check('4 AM across the end of daylight saving (Nov 1 2026): 4 AM EST', async () => {
    assert.strictEqual(M.next4am(ny('2026-10-31T23:00:00-04:00')), ny('2026-11-01T04:00:00-05:00'));
  });
  await check('4 AM across the start of daylight saving (Mar 8 2026): 4 AM EDT', async () => {
    assert.strictEqual(M.next4am(ny('2026-03-07T23:00:00-05:00')), ny('2026-03-08T04:00:00-04:00'));
  });
  await check('4 AM in winter (EST)', async () => {
    assert.strictEqual(M.next4am(ny('2026-01-15T21:30:00-05:00')), ny('2026-01-16T04:00:00-05:00'));
  });
  await check('menu = Toast in stock + forced on − forced off', async () => {
    const out = M.compose(['a', 'b', 'c'], { b: { state: 'off' }, d: { state: 'on' } });
    assert.deepStrictEqual([...out].sort(), ['a', 'c', 'd']);
  });
  await check('an override counts only until its 4 AM', async () => {
    const now = ny('2026-10-06T04:00:00-04:00');
    const { active, expired } = M.splitOverrides({
      x: { state: 'on', until: now }, y: { state: 'off', until: now + 1 }, z: { state: 'maybe', until: now + 1 },
    }, now);
    assert.deepStrictEqual(Object.keys(active), ['y']);
    assert.deepStrictEqual(expired.sort(), ['x', 'z']);
  });

  const EVE = ny('2026-10-05T19:00:00-04:00');
  const UNTIL = ny('2026-10-06T04:00:00-04:00');
  await check('sync: Toast list only, no overrides → the menu is exactly Toast\'s list', async () => {
    const p = M.planSync(['a', 'b'], { a: { addedAt: 5, source: 'toast' }, old: { source: 'toast' } }, null, EVE);
    assert.deepStrictEqual(p.updates['serving/a'], { addedAt: 5, lastUpdated: EVE, source: 'toast' });
    assert.deepStrictEqual(p.updates['serving/b'], { addedAt: EVE, lastUpdated: EVE, source: 'toast' });
    assert.strictEqual(p.updates['serving/old'], null);
    assert.deepStrictEqual(p.updates.toastInStock, { a: true, b: true });
    assert.deepStrictEqual([p.added, p.refreshed, p.removed], [1, 1, 1]);
  });
  await check('sync: a forced-on oyster stays though Toast has it 86\'d; a forced-off one stays off', async () => {
    const ov = { kumamoto: { state: 'on', until: UNTIL }, a: { state: 'off', until: UNTIL } };
    const p = M.planSync(['a', 'b'], { a: { source: 'toast' } }, ov, EVE);
    assert.strictEqual(p.updates['serving/kumamoto'].source, 'override');
    assert.strictEqual(p.updates['serving/a'], null);
    assert.ok(p.updates['serving/b']);
    assert.ok(!('overrides/kumamoto' in p.updates) && !('overrides/a' in p.updates));
  });
  await check('sync after 4 AM: expired overrides are deleted and the menu follows Toast again', async () => {
    const ov = { kumamoto: { state: 'on', until: UNTIL }, a: { state: 'off', until: UNTIL } };
    const p = M.planSync(['a'], { kumamoto: { source: 'override' } }, ov, UNTIL + 7 * 3600e3);
    assert.strictEqual(p.updates['overrides/kumamoto'], null);
    assert.strictEqual(p.updates['overrides/a'], null);
    assert.strictEqual(p.updates['serving/kumamoto'], null);
    assert.ok(p.updates['serving/a']);
    assert.strictEqual(p.expired, 2);
  });
  await check('sync: anything else on the menu (stale, or from an old page) is removed', async () => {
    const p = M.planSync([], { ghost: { source: 'override' } }, null, EVE);
    assert.strictEqual(p.updates['serving/ghost'], null);
  });
  await check('deploy day: an oyster added on the old page stays on, as an override until 4 AM', async () => {
    const p = M.planSync([], { fatbellies: { addedAt: 111, source: 'staff' } }, null, EVE);
    assert.deepStrictEqual(p.updates['overrides/fatbellies'],
      { state: 'on', until: UNTIL, by: 'Employee page (before overrides)', at: 111 });
    assert.strictEqual(p.updates['serving/fatbellies'].source, 'override');
    assert.deepStrictEqual(p.migrated, ['fatbellies']);
  });

  const CATALOG_TEXT = require('fs').readFileSync(require('path').join(__dirname, '..', 'data', 'oysters.js'), 'utf8');
  function catalogFetch(state) {
    const fn = async (url) => {
      fn.calls.push(url);
      if (state.down) throw new Error('offline');
      return { status: 200, text: async () => CATALOG_TEXT };
    };
    fn.calls = [];
    return fn;
  }
  const garrett = { uid: 'merroir:g', token: {} };
  function menuDb(extra) {
    return fakeDb({ staff: { 'merroir:g': { name: 'Garrett K.', rank: 40 } },
      menu: { toastInStock: { 'beach-plum': true, 'kumamoto': true },
        serving: { 'beach-plum': { addedAt: 1, source: 'toast' }, 'kumamoto': { addedAt: 2, source: 'toast' } } },
      ...(extra || {}) });
  }
  const set = (db, changes, f, now) =>
    lib.setMenuOverride(garrett, { changes }, { db, fetch: f || catalogFetch({}), now: () => now || EVE });

  await check('setMenuOverride: signed out or not staff is refused', async () => {
    lib._resetCatalogCache();
    const db = menuDb();
    await rejects(lib.setMenuOverride(null, { changes: [{ id: 'kumamoto', state: 'off' }] },
      { db, fetch: catalogFetch({}), now: () => EVE }), 'unauthenticated');
    await rejects(lib.setMenuOverride({ uid: 'phone' }, { changes: [{ id: 'kumamoto', state: 'off' }] },
      { db, fetch: catalogFetch({}), now: () => EVE }), 'permission-denied');
  });
  await check('setMenuOverride: bad requests are refused (nothing, bad id, bad state, twice, too many)', async () => {
    const db = menuDb();
    await rejects(set(db, []), 'invalid-argument');
    await rejects(set(db, [{ id: 'Bad Id', state: 'on' }]), 'invalid-argument');
    await rejects(set(db, [{ id: 'kumamoto', state: 'maybe' }]), 'invalid-argument');
    await rejects(set(db, [{ id: 'kumamoto', state: 'on' }, { id: 'kumamoto', state: 'off' }]), 'invalid-argument');
    await rejects(set(db, Array.from({ length: 101 }, (_, i) => ({ id: `o${i}`, state: 'on' }))), 'invalid-argument');
    assert.strictEqual(db.data.menu.overrides, undefined);
  });
  await check('setMenuOverride: an oyster that isn\'t in the catalog is refused', async () => {
    const db = menuDb();
    const e = await rejects(set(db, [{ id: 'not-an-oyster', state: 'on' }]), 'invalid-argument');
    assert.ok(/not-an-oyster/.test(e.message));
  });
  await check('force on: override until 4 AM by "Garrett K.", on the menu at once (source override), logged', async () => {
    const db = menuDb();
    const out = await set(db, [{ id: 'fat-bellies', state: 'on' }]);
    assert.deepStrictEqual(out, { ok: true, until: UNTIL });
    assert.deepStrictEqual(db.data.menu.overrides['fat-bellies'], { state: 'on', until: UNTIL, by: 'Garrett K.', at: EVE });
    assert.deepStrictEqual(db.data.menu.serving['fat-bellies'], { addedAt: EVE, lastUpdated: EVE, source: 'override' });
    const log = Object.values(db.data['audit-log']);
    assert.strictEqual(log[0].action, 'menu_override_on');
    assert.strictEqual(log[0].oysterId, 'fat-bellies');
    assert.strictEqual(log[0].actor, 'Garrett K.');
  });
  await check('force off: a Toast oyster leaves the menu at once', async () => {
    const db = menuDb();
    await set(db, [{ id: 'kumamoto', state: 'off' }]);
    assert.strictEqual(db.data.menu.serving.kumamoto, undefined);
    assert.strictEqual(db.data.menu.overrides.kumamoto.state, 'off');
    assert.ok(db.data.menu.serving['beach-plum']);
  });
  await check('several changes in one save, one update', async () => {
    const db = menuDb();
    await set(db, [{ id: 'kumamoto', state: 'off' }, { id: 'fat-bellies', state: 'on' }]);
    assert.deepStrictEqual(Object.keys(db.data.menu.serving).sort(), ['beach-plum', 'fat-bellies']);
    assert.strictEqual(Object.values(db.data['audit-log']).length, 2);
  });
  await check('Back to Toast: a forced-on oyster Toast has 86\'d leaves the menu at once', async () => {
    const db = menuDb();
    await set(db, [{ id: 'fat-bellies', state: 'on' }]);
    await set(db, [{ id: 'fat-bellies', state: null }], null, EVE + 60e3);
    assert.strictEqual((db.data.menu.overrides || {})['fat-bellies'], undefined);
    assert.strictEqual(db.data.menu.serving['fat-bellies'], undefined);
    assert.strictEqual(Object.values(db.data['audit-log']).pop().action, 'menu_override_cleared');
  });
  await check('Back to Toast: a forced-off oyster Toast has in stock comes back at once', async () => {
    const db = menuDb();
    await set(db, [{ id: 'kumamoto', state: 'off' }]);
    await set(db, [{ id: 'kumamoto', state: null }], null, EVE + 60e3);
    assert.strictEqual(db.data.menu.serving.kumamoto.source, 'toast');
  });
  await check('any save clears overrides that already ran out, and fixes their oysters', async () => {
    const db = menuDb({});
    db.data.menu.overrides = { 'fat-bellies': { state: 'on', until: EVE - 1, by: 'x', at: 0 } };
    db.data.menu.serving['fat-bellies'] = { addedAt: 0, source: 'override' };
    await set(db, [{ id: 'kumamoto', state: 'off' }]);
    assert.strictEqual(db.data.menu.overrides['fat-bellies'], undefined);
    assert.strictEqual(db.data.menu.serving['fat-bellies'], undefined);
  });
  await check('turning a forced-off Toast oyster back on just ends the override (no needless override)', async () => {
    const db = menuDb();
    await set(db, [{ id: 'kumamoto', state: 'off' }]);
    await set(db, [{ id: 'kumamoto', state: 'on' }], null, EVE + 60e3);
    assert.strictEqual((db.data.menu.overrides || {}).kumamoto, undefined);
    assert.strictEqual(db.data.menu.serving.kumamoto.source, 'toast');
    assert.strictEqual(Object.values(db.data['audit-log']).pop().action, 'menu_override_cleared');
  });
  await check('the catalog is read once per 10 minutes', async () => {
    lib._resetCatalogCache();
    const f = catalogFetch({});
    const db = menuDb();
    await set(db, [{ id: 'kumamoto', state: 'off' }], f, EVE);
    await set(db, [{ id: 'kumamoto', state: null }], f, EVE + 5 * 60e3);
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(f.calls[0], 'https://hsoysters.com/data/oysters.js');
  });
  await check('catalog unreachable: the id format check stands and the save goes through', async () => {
    lib._resetCatalogCache();
    const db = menuDb();
    await set(db, [{ id: 'kumamoto', state: 'off' }], catalogFetch({ down: true }));
    assert.strictEqual(db.data.menu.overrides.kumamoto.state, 'off');
  });

  await check('index.js exports startToastSync as a callable in us-east1 using the GH_DISPATCH_TOKEN secret', async () => {
    process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'half-shell-oyster-menu';
    const fns = require('./index.js');
    const ep = fns.startToastSync.__endpoint;
    assert.ok(ep.callableTrigger, 'not a callable');
    assert.deepStrictEqual(ep.region, ['us-east1']);
    assert.ok((ep.secretEnvironmentVariables || []).some((s) => s.key === 'GH_DISPATCH_TOKEN'));
  });
  await check('index.js exports setMenuOverride as a callable in us-east1 (no secrets)', async () => {
    const ep = require('./index.js').setMenuOverride.__endpoint;
    assert.ok(ep.callableTrigger && ep.region[0] === 'us-east1' && !(ep.secretEnvironmentVariables || []).length);
  });

  console.log('\n' + (failed ? `${failed} of ${passed + failed} checks failed.` : `All ${passed} checks passed.`));
  process.exit(failed ? 1 : 0);
})();
