/**
 * Database rules tests: database.rules.json against the Firebase emulator.
 * Nothing here touches the real database (project "demo-hs-rules").
 *
 * Terminal, from this folder (tools/rules-test), once:
 *   npm install
 * Then each time:
 *   npm test
 * Needs Java 21+ for the emulator (firebase-tools 15 refuses older Java).
 *
 * Covers the menu, staff and Passport paths (Oyster Passport Build Sheet
 * section 4, revised 19/10/2026).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  initializeTestEnvironment, assertSucceeds, assertFails,
} = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
const A = 'custA', B = 'custB';
const PHONE_A = '+17045550101', PHONE_B = '+17045550102';
const STAFF = 'merroir:7';

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('PASS  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + (e && e.message)); }
}

function profile(extra) {
  return Object.assign({
    name: 'Garrett', dob: '1995-06-14', dobEditsUsed: 0, phone: PHONE_A, createdAt: 1760900000000,
  }, extra || {});
}
function visit(extra) {
  return Object.assign({
    date: '2026-10-19', startedAt: 1760900000000, lastChangedAt: 1760900000000, source: 'manual',
    items: { 'beach-plum': { qty: 2, addedAt: 1760900000000 } },
  }, extra || {});
}

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'demo-hs-rules',
    database: { rules: RULES, host: '127.0.0.1', port: 9000 },
  });

  const phone = (uid, num) => env.authenticatedContext(uid, {
    phone_number: num, firebase: { sign_in_provider: 'phone' },
  }).database();
  const custA = phone(A, PHONE_A);
  const custB = phone(B, PHONE_B);
  const staff = env.authenticatedContext(STAFF, {
    staff_rank: 20, staff_name: 'Garrett K.', firebase: { sign_in_provider: 'custom' },
  }).database();
  const anon = env.unauthenticatedContext().database();

  async function reset() {
    await env.clearDatabase();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.database().ref().set({
        menu: { serving: { 'beach-plum': { source: 'toast' } }, prices: { 'beach-plum': { price: 4 } },
          overrides: { 'beach-plum': { state: 'on' } }, happyHour: { schedule: { percentOff: 50 } } },
        'audit-log': { k1: { by: 'Garrett K.' } },
        staff: { [STAFF]: { name: 'Garrett K.', rank: 20 } },
        server: { lastSyncTrigger: 1 },
        config: { birthdayReward: 'A free oyster', other: 'secret' },
        users: { [A]: { profile: profile() }, [B]: { profile: profile({ phone: PHONE_B }) } },
        toastOrders: { [A]: { '2026-10-18': { chk1: { items: { 'beach-plum': { qty: 6 } } } } } },
      });
    });
  }

  // ── Existing paths keep their behavior ──
  await reset();
  await check('anyone reads menu/serving, prices, happyHour', async () => {
    await assertSucceeds(anon.ref('menu/serving').once('value'));
    await assertSucceeds(anon.ref('menu/prices').once('value'));
    await assertSucceeds(anon.ref('menu/happyHour').once('value'));
  });
  await check('nobody writes menu/serving from a browser', async () => {
    await assertFails(anon.ref('menu/serving/x').set({ source: 'staff' }));
    await assertFails(staff.ref('menu/serving/x').set({ source: 'staff' }));
    await assertFails(custA.ref('menu/serving/x').set({ source: 'staff' }));
  });
  await check('staff read overrides and audit-log; customers and guests cannot', async () => {
    await assertSucceeds(staff.ref('menu/overrides').once('value'));
    await assertSucceeds(staff.ref('audit-log').once('value'));
    await assertFails(custA.ref('menu/overrides').once('value'));
    await assertFails(custA.ref('audit-log').once('value'));
    await assertFails(anon.ref('audit-log').once('value'));
  });
  await check('staff/ and server/ are closed to everyone', async () => {
    await assertFails(staff.ref('staff').once('value'));
    await assertFails(custA.ref('staff/' + A).set({ name: 'x', rank: 40 }));
    await assertFails(custA.ref('server').once('value'));
  });

  // ── config ──
  await check('config/birthdayReward is public read, no writes', async () => {
    await assertSucceeds(anon.ref('config/birthdayReward').once('value'));
    await assertFails(custA.ref('config/birthdayReward').set('free dozen'));
    await assertFails(anon.ref('config/other').once('value'));
    await assertFails(anon.ref('config').once('value'));
  });

  // ── users: who ──
  await check('signed-out cannot read users', async () => {
    await assertFails(anon.ref('users/' + A).once('value'));
    await assertFails(anon.ref('users').once('value'));
  });
  await check('a customer reads and writes only their own node', async () => {
    await assertSucceeds(custA.ref('users/' + A).once('value'));
    await assertFails(custA.ref('users/' + B).once('value'));
    await assertFails(custA.ref('users/' + B + '/profile/name').set('Mallory'));
    await assertFails(custA.ref('users').once('value'));
  });
  await check('staff (Merroir sign-in) are not customers', async () => {
    await assertFails(staff.ref('users/' + STAFF + '/profile').set(profile({ phone: '+17045550199' })));
    await assertFails(staff.ref('users/' + STAFF + '/hereOn/2026-10-19').set(1760900000000));
    // A non-phone sign-in carrying a phone number is still not a customer.
    const custom = env.authenticatedContext(A, { phone_number: PHONE_A, firebase: { sign_in_provider: 'custom' } }).database();
    await assertFails(custom.ref('users/' + A + '/hereOn/2026-10-19').set(1760900000000));
    await assertFails(custom.ref('users/' + A).once('value'));
    await assertFails(custom.ref('toastOrders/' + A).once('value'));
    await assertFails(staff.ref('users/' + STAFF).once('value'));
    await assertFails(staff.ref('users/' + A).once('value'));
  });
  await check('a phone user with no staff entry cannot read staff paths', async () => {
    await assertFails(custA.ref('menu/overrides').once('value'));
  });

  // ── profile ──
  await env.clearDatabase();
  await check('create a complete profile', async () => {
    await assertSucceeds(custA.ref('users/' + A + '/profile').set(profile({ email: 'g@example.com' })));
  });
  await check('profile needs name, dob, dobEditsUsed, phone, createdAt', async () => {
    for (const k of ['name', 'dob', 'dobEditsUsed', 'phone', 'createdAt']) {
      const p = profile({ phone: PHONE_B }); delete p[k];
      await assertFails(custB.ref('users/' + B + '/profile').set(p));
    }
  });
  await check('profile phone must equal the sign-in phone', async () => {
    await assertFails(custB.ref('users/' + B + '/profile').set(profile({ phone: PHONE_A })));
  });
  await check('name 1-60 chars; email format; no extra fields', async () => {
    await assertFails(custA.ref('users/' + A + '/profile/name').set(''));
    await assertFails(custA.ref('users/' + A + '/profile/name').set('x'.repeat(61)));
    await assertSucceeds(custA.ref('users/' + A + '/profile/name').set('x'.repeat(60)));
    await assertFails(custA.ref('users/' + A + '/profile/email').set('not an email'));
    await assertFails(custA.ref('users/' + A + '/profile/email').set('a@b'));
    await assertSucceeds(custA.ref('users/' + A + '/profile/email').set('g.k+oysters@example.co'));
    await assertSucceeds(custA.ref('users/' + A + '/profile/email').remove());
    await assertFails(custA.ref('users/' + A + '/profile/marketing').set(true));
  });
  await check('dob must be a YYYY-MM-DD date', async () => {
    await assertFails(custB.ref('users/' + B + '/profile').set(profile({ phone: PHONE_B, dob: '06/14/1995' })));
    await assertFails(custB.ref('users/' + B + '/profile').set(profile({ phone: PHONE_B, dob: '1995-13-01' })));
  });
  await check('createdAt cannot change', async () => {
    await assertFails(custA.ref('users/' + A + '/profile/createdAt').set(1));
  });
  await check('dob changes once, only with dobEditsUsed 0 -> 1', async () => {
    await assertFails(custA.ref('users/' + A + '/profile/dob').set('1994-06-14'));
    await assertSucceeds(custA.ref('users/' + A + '/profile').update({ dob: '1994-06-14', dobEditsUsed: 1 }));
    await assertFails(custA.ref('users/' + A + '/profile').update({ dob: '1993-06-14', dobEditsUsed: 1 }));
    await assertFails(custA.ref('users/' + A + '/profile/dobEditsUsed').set(0));
    await assertFails(custA.ref('users/' + A + '/profile').update({ dob: '1993-06-14', dobEditsUsed: 0 }));
  });

  // ── visits ──
  await check('log a visit', async () => {
    await assertSucceeds(custA.ref('users/' + A + '/visits/v1').set(visit()));
    await assertSucceeds(custA.ref('users/' + A + '/activeVisitId').set('v1'));
  });
  await check('visit date: real date, opening day 2026-02-03 or later', async () => {
    await assertSucceeds(custA.ref('users/' + A + '/visits/v2').set(visit({ date: '2026-02-03' })));
    await assertFails(custA.ref('users/' + A + '/visits/v3').set(visit({ date: '2026-02-02' })));
    await assertFails(custA.ref('users/' + A + '/visits/v3').set(visit({ date: '2026-2-10' })));
  });
  await check('visit source is manual; closeReason from the list', async () => {
    await assertFails(custA.ref('users/' + A + '/visits/v4').set(visit({ source: 'toast' })));
    await assertSucceeds(custA.ref('users/' + A + '/visits/v1').update({ closedAt: 1760910000000, closeReason: 'saved' }));
    await assertFails(custA.ref('users/' + A + '/visits/v1/closeReason').set('other'));
  });
  await check('qty is a whole number 1-99', async () => {
    const it = (q) => custA.ref('users/' + A + '/visits/v1/items/beach-plum/qty').set(q);
    await assertFails(it(0)); await assertFails(it(100)); await assertFails(it(1.5)); await assertFails(it('2'));
    await assertSucceeds(it(99)); await assertSucceeds(it(1));
  });
  await check('rating is 1-5 (whole), removable', async () => {
    const r = (v) => custA.ref('users/' + A + '/visits/v1/items/beach-plum/rating').set(v);
    await assertFails(r(0)); await assertFails(r(6)); await assertFails(r(3.5));
    await assertSucceeds(r(5)); await assertSucceeds(r(null));
  });
  await check('two words <= 40 chars, note <= 280 chars', async () => {
    const base = 'users/' + A + '/visits/v1/items/beach-plum/';
    await assertSucceeds(custA.ref(base + 'twoWords').set('briny, buttery'));
    await assertFails(custA.ref(base + 'twoWords').set('x'.repeat(41)));
    await assertSucceeds(custA.ref(base + 'note').set('x'.repeat(280)));
    await assertFails(custA.ref(base + 'note').set('x'.repeat(281)));
  });
  await check('item ids are catalog-style slugs; no extra item fields', async () => {
    await assertFails(custA.ref('users/' + A + '/visits/v1/items/Beach Plum').set({ qty: 1, addedAt: 1 }));
    await assertFails(custA.ref('users/' + A + '/visits/v1/items/beach-plum/price').set(4));
    await assertFails(custA.ref('users/' + A + '/visits/v1/items/kumamoto').set({ qty: 1 }));
  });
  await check('flightsLogged/{flight}/{oyster} = true', async () => {
    const f = 'users/' + A + '/visits/v1/flightsLogged/first-timer';
    await assertSucceeds(custA.ref(f).set({ 'beach-plum': true, kumamoto: true }));
    await assertFails(custA.ref(f + '/beach-plum').set('yes'));
    await assertFails(custA.ref('users/' + A + '/visits/v1/flightsLogged/First Timer').set({ 'beach-plum': true }));
  });

  // ── stamps ──
  await check('stamps: tier from the list, seen flag', async () => {
    await assertSucceeds(custA.ref('users/' + A + '/stamps/volume').set({ tier: 'bronze', seen: false, tierEarnedAt: { bronze: 1 } }));
    await assertFails(custA.ref('users/' + A + '/stamps/volume').set({ tier: 'platinum', seen: false }));
    await assertFails(custA.ref('users/' + A + '/stamps/volume/tierEarnedAt/platinum').set(1));
  });

  // ── cards (optional, for P2) ──
  await check('cards: last 4 digits and a brand', async () => {
    await assertSucceeds(custA.ref('users/' + A + '/cards/c1').set({ last4: '0123', brand: 'VISA', addedAt: 1 }));
    await assertFails(custA.ref('users/' + A + '/cards/c2').set({ last4: '12345', brand: 'VISA', addedAt: 1 }));
    await assertFails(custA.ref('users/' + A + '/cards/c2').set({ last4: '12a4', brand: 'VISA', addedAt: 1 }));
    await assertFails(custA.ref('users/' + A + '/cards/c2').set({ last4: '1234', brand: 'visa', addedAt: 1 }));
    await assertFails(custA.ref('users/' + A + '/cards/c2').set({ last4: '1234', brand: 'AMEX', addedAt: 1, number: '4111' }));
    await assertSucceeds(custA.ref('users/' + A + '/cards/c1').remove());
  });
  await check('cards are private to their owner', async () => {
    await assertSucceeds(custA.ref('users/' + A + '/cards/c3').set({ last4: '9876', brand: 'AMEX', addedAt: 1 }));
    await assertFails(custB.ref('users/' + A + '/cards').once('value'));
    await assertFails(staff.ref('users/' + A + '/cards').once('value'));
  });

  // ── hereOn (P2) ──
  await check('hereOn/{date} = ms', async () => {
    await assertSucceeds(custA.ref('users/' + A + '/hereOn/2026-10-19').set(1760900000000));
    await assertFails(custA.ref('users/' + A + '/hereOn/today').set(1));
    await assertFails(custA.ref('users/' + A + '/hereOn/2026-10-19').set(true));
  });

  // ── anything else under a user ──
  await check('no other keys under a user (old user.html shape refused)', async () => {
    await assertFails(custA.ref('users/' + A + '/name').set('Garrett'));
    await assertFails(custA.ref('users/' + A + '/phone').set(PHONE_A));
    await assertFails(custA.ref('users/' + A + '/isStaff').set(true));
  });

  // ── toastOrders (P2, server-written) ──
  await reset();
  await check('toastOrders: owner reads; nobody else; no client writes', async () => {
    await assertSucceeds(custA.ref('toastOrders/' + A).once('value'));
    await assertFails(custB.ref('toastOrders/' + A).once('value'));
    await assertFails(anon.ref('toastOrders/' + A).once('value'));
    await assertFails(staff.ref('toastOrders/' + A).once('value'));
    await assertFails(custA.ref('toastOrders/' + A + '/2026-10-19/chk2').set({ items: {} }));
    await assertFails(custA.ref('toastOrders/' + A).remove());
  });

  // ── delete account ──
  await check('a customer can delete their whole node', async () => {
    await assertSucceeds(custA.ref('users/' + A).remove());
    await assertFails(custA.ref('users/' + B).remove());
  });

  await env.cleanup();
  console.log(failed ? `\n${failed} of ${passed + failed} checks FAILED.` : `\nAll ${passed} checks passed.`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
