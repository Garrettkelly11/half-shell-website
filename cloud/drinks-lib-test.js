/** Tests for drinks-lib.js (fake database, no network). Run: node drinks-lib-test.js */
'use strict';
const assert = require('assert');
const dl = require('./drinks-lib');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}
async function rejects(p, code) {
  try { await p; } catch (e) { assert.strictEqual(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`); return e; }
  assert.fail('expected a rejection (' + code + ')');
}
function fakeDb(initial) {
  const data = JSON.parse(JSON.stringify(initial || {}));
  const get = (p) => p.split('/').reduce((o, k) => (o == null ? undefined : o[k]), data);
  const put = (p, v) => {
    const ks = p.split('/'); const last = ks.pop(); let o = data;
    for (const k of ks) { o[k] = o[k] || {}; o = o[k]; }
    if (v === null || v === undefined) delete o[last]; else o[last] = JSON.parse(JSON.stringify(v));
  };
  const snap = (v) => ({ exists: () => v != null, val: () => (v === undefined ? null : v) });
  let n = 0;
  return { data, ref: (p) => ({
    once: async () => snap(get(p)), set: async (v) => put(p, v),
    push: async (v) => { put(`${p}/k${++n}`, v); },
    update: async (o) => { for (const [k, v] of Object.entries(o)) put(`${p}/${k}`, v); },
    transaction: async (fn) => { const cur = get(p) === undefined ? null : get(p); const out = fn(cur); if (out === undefined) return { committed: false }; put(p, out); return { committed: true }; },
  }) };
}
const BUCKET = 'test-bucket';
const staffDb = (extra) => fakeDb(Object.assign({ staff: { 'merroir:1': { name: 'Garrett K.', rank: 20 }, 'merroir:2': { name: 'Sam S.', rank: 10 } } }, extra));
const mgr = { uid: 'merroir:1', token: { staff_rank: 20 } };
const NOW = Date.parse('2026-11-06T12:00:00-05:00');
const dep = (db) => ({ db, bucket: BUCKET, now: () => NOW });
const photo = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/drinks%2Fa.jpg?alt=media&token=t`;
const D = require('./site/src/drinks-core.js');
// What the Toast sync writes to menu/toastDrinks (cents; key = toastKey of the Toast name).
const ti = (name, group, order, extra) => Object.assign({ name, group, order, inStock: true, strategy: 'BASE_PRICE' }, extra);
const TOAST = { oldfashioned: ti('Old Fashioned', 'House Cocktails', 1, { price: 1400 }), a: ti('DFT A', 'Draft Beer', 2, { price: 600 }),
  zin: ti('Zin', 'Red Wine', 3, { strategy: 'SIZE_PRICE', sizes: [{ name: '6 oz', price: 1100 }, { name: 'Bottle', price: 4000 }] }),
  pumpkinmartini: ti('Pumpkin Martini', 'House Cocktails', 4, { price: 1500 }) };
const audits = (db) => Object.values(db.data['audit-log'] || {}).map((a) => a.action);

(async () => {
  await check('permissions: anonymous, staff, low rank, stale claim', async () => {
    const db = staffDb();
    await rejects(dl.saveDrink(null, {}, dep(db)), 'unauthenticated');
    await rejects(dl.saveDrink({ uid: 'merroir:2', token: { staff_rank: 10 } }, { create: true, drink: { name: 'A' } }, dep(db)), 'permission-denied');
    await rejects(dl.saveDrink({ uid: 'merroir:2', token: { staff_rank: 20 } }, { create: true, drink: { name: 'A' } }, dep(db)), 'permission-denied'); // live rank 10 wins
    await rejects(dl.saveDrink({ uid: 'x', token: { staff_rank: 99 } }, {}, dep(db)), 'permission-denied'); // not in staff
    for (const f of ['removeDrink', 'importDrinks', 'saveSpecial', 'removeSpecial', 'saveNightly']) {
      await rejects(dl[f]({ uid: 'merroir:2', token: { staff_rank: 10 } }, {}, dep(db)), 'permission-denied');
    }
    assert.deepStrictEqual(db.data.menu, undefined);
  });

  await check('saveDrink: create (extras only), duplicate, same Toast drink twice, edit, missing, bad input, bad photo', async () => {
    const db = staffDb();
    const d = { name: 'Old Fashioned', category: 'cocktails', price: 1400, tags: ['House'] }; // price and category are ignored: Toast owns them
    const r = await dl.saveDrink(mgr, { create: true, drink: d }, dep(db));
    const saved = db.data.menu.drinks['old-fashioned'];
    assert.strictEqual(r.id, 'old-fashioned'); assert.ok(!('price' in saved) && !('category' in saved), 'no price or category is ever stored');
    assert.strictEqual(saved.by, 'Garrett K.');
    await rejects(dl.saveDrink(mgr, { create: true, drink: d }, dep(db)), 'already-exists');
    await rejects(dl.saveDrink(mgr, { create: true, drink: { name: 'Old-Fashioned' } }, dep(db)), 'already-exists');
    const e = await rejects(dl.saveDrink(mgr, { create: true, drink: { name: 'OldFashioned' } }, dep(db)), 'already-exists'); // different id, same Toast drink
    assert.ok(/Edit that one/.test(e.message));
    await dl.saveDrink(mgr, { drink: Object.assign({}, d, { id: 'old-fashioned', description: 'Smoky', photo }) }, dep(db));
    assert.strictEqual(db.data.menu.drinks['old-fashioned'].description, 'Smoky'); assert.strictEqual(db.data.menu.drinks['old-fashioned'].photo, photo);
    await rejects(dl.saveDrink(mgr, { drink: { name: 'Ghost', id: 'ghost' } }, dep(db)), 'not-found');
    await rejects(dl.saveDrink(mgr, { create: true, drink: { name: '' } }, dep(db)), 'invalid-argument');
    await rejects(dl.saveDrink(mgr, { drink: Object.assign({}, d, { id: 'old-fashioned', photo: 'https://firebasestorage.googleapis.com/v0/b/other/o/x.jpg' }) }, dep(db)), 'invalid-argument');
    assert.deepStrictEqual(audits(db), ['drink_created', 'drink_updated']);
  });

  await check('removeDrink also ends specials on it (price and limited-time)', async () => {
    const db = staffDb({ menu: { drinks: { a: { name: 'A' }, z: { name: 'Z' } }, drinkSpecials: { s1: { kind: 'price', drinkId: 'a' }, s2: { kind: 'limited', drinkId: 'a' }, s3: { kind: 'limited', drinkId: 'z' } } } });
    const r = await dl.removeDrink(mgr, { id: 'a' }, dep(db));
    assert.strictEqual(r.endedSpecials, 2); assert.ok(!db.data.menu.drinks.a); assert.ok(!db.data.menu.drinkSpecials.s1 && !db.data.menu.drinkSpecials.s2 && db.data.menu.drinkSpecials.s3);
    await rejects(dl.removeDrink(mgr, { id: 'a' }, dep(db)), 'not-found');
    await rejects(dl.removeDrink(mgr, { id: '../x' }, dep(db)), 'not-found');
  });

  await check('importDrinks: merge, replace guard, all-or-nothing, photo kept, specials ended, Toast columns ignored', async () => {
    const db = staffDb({ menu: { drinks: {
      a: { name: 'A', description: 'old', tags: [], allergens: [], available: true, photo, sort: 3 },
      b: { name: 'B', tags: [], allergens: [], available: true } },
      drinkSpecials: { s1: { kind: 'price', drinkId: 'b' } } } });
    const rows = [{ name: 'A', description: 'new' }, { name: 'C', description: 'fresh' }];
    await rejects(dl.importDrinks(mgr, { mode: 'replace', drinks: rows }, dep(db)), 'failed-precondition');
    await rejects(dl.importDrinks(mgr, { mode: 'replace', confirm: true, drinks: rows }, dep(db)), 'failed-precondition'); // no expectedRemoved: the preview was skipped
    await rejects(dl.importDrinks(mgr, { mode: 'replace', confirm: true, expectedRemoved: [], drinks: rows }, dep(db)), 'failed-precondition'); // b would be removed unseen
    await rejects(dl.importDrinks(mgr, { mode: 'merge', drinks: [rows[0], { name: 'Bad', tags: 'nonsense' }] }, dep(db)), 'invalid-argument');
    assert.strictEqual(db.data.menu.drinks.a.description, 'old', 'nothing applied after a bad row');
    await rejects(dl.importDrinks(mgr, { mode: 'merge', drinks: [rows[0], rows[0]] }, dep(db)), 'invalid-argument');
    await rejects(dl.importDrinks(mgr, { mode: 'merge', drinks: [rows[0], { name: 'DFT A' }] }, dep(db)), 'invalid-argument'); // same Toast drink twice in the file
    const dbTwin = staffDb({ menu: { drinks: { 'bud-light': { name: 'Bud Light' } } } }); // "BudLight" is the same Toast drink under another id
    const tw = await rejects(dl.importDrinks(mgr, { mode: 'merge', drinks: [{ name: 'BudLight' }] }, dep(dbTwin)), 'invalid-argument');
    assert.ok(/already has details/.test(tw.message));
    await rejects(dl.importDrinks(mgr, { mode: 'merge', drinks: [] }, dep(db)), 'invalid-argument');
    await rejects(dl.importDrinks(mgr, { mode: 'nope', drinks: rows }, dep(db)), 'invalid-argument');
    const m = await dl.importDrinks(mgr, { mode: 'merge', drinks: rows.map((r) => Object.assign({}, r, { photo: 'https://evil.example/x.jpg', price: 99999, category: 'Evil' })) }, dep(db));
    assert.deepStrictEqual([m.added, m.changed, m.removed], [1, 1, 0]);
    assert.strictEqual(db.data.menu.drinks.a.photo, photo, 'existing photo kept, imported photo ignored'); assert.strictEqual(db.data.menu.drinks.a.sort, 3);
    assert.ok(!db.data.menu.drinks.c.photo && db.data.menu.drinks.b);
    assert.ok(!('price' in db.data.menu.drinks.a) && !('category' in db.data.menu.drinks.c), 'Toast columns never land');
    const r = await dl.importDrinks(mgr, { mode: 'replace', confirm: true, expectedRemoved: ['b'], drinks: rows }, dep(db));
    assert.strictEqual(r.removed, 1); assert.ok(!db.data.menu.drinks.b && !db.data.menu.drinkSpecials.s1);
  });

  await check('saveSpecial: needs a Toast drink; price under the Toast price and single-priced; limited-time; edit; remove', async () => {
    const db = staffDb({ menu: { drinks: { a: { name: 'A' }, zin: { name: 'Zin' }, ghost: { name: 'Ghost' }, 'pumpkin-martini': { name: 'Pumpkin Martini' } }, toastDrinks: TOAST } });
    const base = { kind: 'price', drinkId: 'a', priceText: '4', startDate: '2026-11-06', endDate: '2026-11-08' };
    await rejects(dl.saveSpecial(mgr, { special: Object.assign({}, base, { priceText: '7' }) }, dep(db)), 'invalid-argument'); // Toast price is $6
    await rejects(dl.saveSpecial(mgr, { special: Object.assign({}, base, { priceText: '6' }) }, dep(db)), 'invalid-argument');
    await rejects(dl.saveSpecial(mgr, { special: Object.assign({}, base, { drinkId: 'zz' }) }, dep(db)), 'invalid-argument');
    await rejects(dl.saveSpecial(mgr, { special: Object.assign({}, base, { drinkId: 'zin' }) }, dep(db)), 'invalid-argument'); // wine with sizes
    await rejects(dl.saveSpecial(mgr, { special: Object.assign({}, base, { drinkId: 'ghost' }) }, dep(db)), 'failed-precondition'); // not in Toast
    const r = await dl.saveSpecial(mgr, { special: base }, dep(db));
    assert.strictEqual(db.data.menu.drinkSpecials[r.id].price, 400);
    await dl.saveSpecial(mgr, { id: r.id, special: Object.assign({}, base, { priceText: '3.50' }) }, dep(db));
    assert.strictEqual(db.data.menu.drinkSpecials[r.id].price, 350);
    await rejects(dl.saveSpecial(mgr, { id: 'nope', special: base }, dep(db)), 'not-found');
    const l = await dl.saveSpecial(mgr, { special: { kind: 'limited', drinkId: 'pumpkin-martini', startDate: '2026-11-06', endDate: '2026-11-30', days: 'fri,sat', price: 1, name: 'Evil', item: { price: 1 } } }, dep(db));
    const ls = db.data.menu.drinkSpecials[l.id];
    assert.deepStrictEqual(ls.days, ['FRI', 'SAT']); assert.ok(!('price' in ls) && !('item' in ls) && !('name' in ls), 'a limited-time drink stores no price or name of its own');
    await rejects(dl.saveSpecial(mgr, { special: { kind: 'limited', drinkId: 'zin', startDate: '2026-11-06', endDate: '2026-11-30' } }, { db: staffDb({ menu: { drinks: { zin: { name: 'Zin' } } } }), now: () => NOW }), 'failed-precondition'); // no Toast list yet
    await dl.removeSpecial(mgr, { id: l.id }, dep(db)); assert.ok(!db.data.menu.drinkSpecials[l.id]);
    await rejects(dl.removeSpecial(mgr, { id: l.id }, dep(db)), 'not-found');
  });

  await check('saveNightly: save, clear, date window, prunes old nights', async () => {
    const db = staffDb({ menu: { nightlySpecials: { '2026-10-01': { items: [] }, '2026-11-01': { items: [] } } } });
    await dl.saveNightly(mgr, { date: '2026-11-06', items: [{ name: 'Bisque', allergens: 'shellfish' }] }, dep(db));
    assert.strictEqual(db.data.menu.nightlySpecials['2026-11-06'].items[0].name, 'Bisque');
    assert.ok(!db.data.menu.nightlySpecials['2026-10-01'] && db.data.menu.nightlySpecials['2026-11-01'], 'older than 14 days pruned');
    await dl.saveNightly(mgr, { date: '2026-11-06', items: [] }, dep(db)); assert.ok(!db.data.menu.nightlySpecials['2026-11-06']);
    await rejects(dl.saveNightly(mgr, { date: '2026-11-04', items: [] }, dep(db)), 'invalid-argument');
    await rejects(dl.saveNightly(mgr, { date: '2026-12-31', items: [] }, dep(db)), 'invalid-argument');
    await rejects(dl.saveNightly(mgr, { date: '2026-11-06', items: [{ name: 'X', allergens: 'dust' }] }, dep(db)), 'invalid-argument');
    await dl.saveNightly(mgr, { date: '2026-11-07', items: [{ name: 'Y' }] }, { db, now: () => Date.parse('2026-11-07T02:00:00-05:00') });
    await dl.saveNightly(mgr, { date: '2026-11-06', items: [{ name: 'Late' }] }, { db, now: () => Date.parse('2026-11-07T02:00:00-05:00') }); // 2 AM is still the 6th
  });

  await check('uploadDrinkPhoto: manager only, real images only, size, saves with a token', async () => {
    const saved = [];
    const files = { file: (name) => ({ save: async (buf, o) => saved.push({ name, buf, o }) }) };
    const db = staffDb();
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]).toString('base64');
    await rejects(dl.uploadDrinkPhoto({ uid: 'merroir:2', token: { staff_rank: 10 } }, { data: jpeg }, { db, files, bucket: BUCKET, now: () => NOW }), 'permission-denied');
    const r = await dl.uploadDrinkPhoto(mgr, { data: 'data:image/jpeg;base64,' + jpeg }, { db, files, bucket: BUCKET, now: () => NOW });
    assert.ok(r.url.startsWith(`https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/drinks%2F`) && /token=/.test(r.url));
    assert.strictEqual(saved[0].o.contentType, 'image/jpeg'); assert.ok(/^drinks\/[a-z0-9]+-[0-9a-f]{12}\.jpg$/.test(saved[0].name));
    assert.ok(require('./site/src/drinks-core.js').validPhotoUrl(r.url));
    await rejects(dl.uploadDrinkPhoto(mgr, { data: Buffer.from('<html>not an image at all</html>').toString('base64') }, { db, files, bucket: BUCKET }), 'invalid-argument');
    await rejects(dl.uploadDrinkPhoto(mgr, { data: Buffer.alloc(1600000, 0xff).toString('base64') }, { db, files, bucket: BUCKET }), 'invalid-argument');
    await rejects(dl.uploadDrinkPhoto(mgr, { data: '!!!' }, { db, files, bucket: BUCKET }), 'invalid-argument');
    await rejects(dl.uploadDrinkPhoto(mgr, {}, { db, files, bucket: BUCKET }), 'invalid-argument');
    assert.strictEqual(saved.length, 1);
    assert.ok(audits(db).includes('drink_photo_uploaded'));
  });

  await check('review fixes: stale staff entry, race on create, photo link tricks, special ids, merge keeps columns', async () => {
    const db0 = fakeDb({ staff: { 'merroir:1': { name: 'G' } } }); // no rank on the live entry
    await rejects(dl.saveDrink(mgr, { create: true, drink: { name: 'A' } }, dep(db0)), 'permission-denied');
    const db = staffDb();
    await dl.saveDrink(mgr, { create: true, drink: { name: 'A' } }, dep(db));
    const dbRace = staffDb();
    const orig = dbRace.ref.bind(dbRace);
    // Another manager's write lands between our read and our write: only the first create wins.
    dbRace.ref = (p) => { const r = orig(p); if (p === 'menu/drinks') { const once = r.once; r.once = async () => { await once(); dbRace.data.menu = { drinks: { zed: { name: 'Zed' } } }; return { exists: () => false, val: () => null }; }; } return r; };
    await rejects(dl.saveDrink(mgr, { create: true, drink: { name: 'Zed' } }, dep(dbRace)), 'already-exists');
    for (const bad of ['https://firebasestorage.googleapis.com/v0/b/' + BUCKET + '/o/../../evil/o/x.png', 'https://firebasestorage.googleapis.com/v0/b/other/o/drinks%2Fa.jpg']) {
      await rejects(dl.saveDrink(mgr, { create: true, drink: { name: 'P', photo: bad } }, dep(db)), 'invalid-argument');
    }
    await rejects(dl.saveDrink(mgr, { create: true, drink: { name: 'P', photo } }, { db, now: () => NOW }), 'invalid-argument'); // no bucket configured
    for (const id of ['constructor', 'toString', '__proto__']) await rejects(dl.saveSpecial(mgr, { id, special: { kind: 'price', drinkId: 'a', priceText: '4', startDate: '2026-11-06', endDate: '2026-11-08' } }, dep(db)), 'not-found');
    const dbm = staffDb({ menu: { drinks: { a: { name: 'A', size: '16oz', description: 'Nice', tags: ['Local'], allergens: ['Wheat'], available: false } } } });
    const f = D.drinksFromRows(D.parseCSV('Name,Description\nA,Better\n'));
    await dl.importDrinks(mgr, { mode: 'merge', drinks: f.drinks, fields: f.fields }, dep(dbm));
    const a = dbm.data.menu.drinks.a;
    assert.deepStrictEqual([a.description, a.allergens, a.tags, a.available, a.size], ['Better', ['Wheat'], ['Local'], false, '16oz']);
    await dl.importDrinks(mgr, { mode: 'merge', drinks: f.drinks, fields: ['name', 'allergens', 'price', 'category', 'bogus'] }, dep(dbm));
    assert.deepStrictEqual(dbm.data.menu.drinks.a.allergens, [], 'a present column overwrites');
    assert.strictEqual(dbm.data.menu.drinks.a.description, 'Better', 'a column not named stays');
  });

  await check('Toast drinks reader: scanDrinks (order, sections, sizes, 86, open price, duplicates, other menus ignored)', async () => {
    const P = require('./price-logic.js');
    const menu = (name, groups) => ({ name, menuGroups: groups });
    const it = (name, price, strategy, extra) => Object.assign({ name, guid: 'g-' + name, price, pricingStrategy: strategy || 'BASE_PRICE' }, extra);
    const data = {
      menus: [
        menu('Food Menu', [{ name: 'Raw Bar', menuItems: [it('Duxbury', 3.5)] }]),
        menu('Drinks', [
          { name: 'Beer', menuItems: [], menuGroups: [{ name: 'Draft Beer', menuItems: [it('DFT Lager', 7), it('DFT Pils', 7.25)] }, { name: 'Cans', menuItems: [it('CAN Sold', 6)] }] },
          { name: 'Red Wine', menuItems: [it('Zin', null, 'SIZE_PRICE', { modifierGroupReferences: [201] }), it('Cab', 55), it('Market Shot', null, 'OPEN_PRICE'), it('Lager', 8)] },
          { name: 'Misc', menuItems: [it('DFT Lager', 9), it('', 1), it('!!!', 1)] },
        ]),
      ],
      modifierGroupReferences: { 201: { name: 'Size', modifierOptionReferences: [301, 302, 303] }, 202: { name: 'Sauce', modifierOptionReferences: [] } },
      modifierOptionReferences: { 301: { name: '6 oz', price: 11 }, 302: { name: 'Bottle ', price: 40 }, 303: { name: 'Free', price: null } },
    };
    const r = P.scanDrinks(data, new Set(['g-CAN Sold']), D.toastKey);
    assert.deepStrictEqual(Object.keys(r.items), ['lager', 'pils', 'sold', 'zin', 'cab', 'marketshot'], 'Toast order, depth first; other menus left out');
    assert.deepStrictEqual([r.items.lager.group, r.items.lager.path, r.items.lager.price], ['Draft Beer', 'Beer › Draft Beer', 700], 'the first DFT Lager wins when both are in stock');
    assert.strictEqual(r.items.pils.price, 725); assert.strictEqual(r.items.sold.inStock, false);
    assert.deepStrictEqual(r.items.zin.sizes, [{ name: '6 oz', price: 1100 }, { name: 'Bottle', price: 4000 }]); assert.strictEqual(r.items.zin.price, undefined);
    assert.ok(r.items.marketshot.price === undefined && !r.items.marketshot.sizes && r.items.marketshot.strategy === 'OPEN_PRICE');
    assert.ok(r.duplicates.includes('Lager') && r.duplicates.includes('DFT Lager'));
    assert.ok(r.items.lager.order < r.items.pils.order && r.items.pils.order < r.items.zin.order);
    assert.strictEqual(P.scanDrinks({ menus: [] }, new Set(), D.toastKey).scanned, 0);
    assert.strictEqual(P.scanDrinks(null, new Set(), D.toastKey).scanned, 0);
    // an 86'd first copy gives way to an in-stock twin
    const twin = { menus: [menu('Drinks', [{ name: 'A', menuItems: [it('Stout', 8), Object.assign(it('DFT Stout', 8), { guid: 'g2' })] }])] };
    assert.strictEqual(P.scanDrinks(twin, new Set(['g-Stout']), D.toastKey).items.stout.inStock, true);
    assert.ok(P.sameDrinks(r.items, JSON.parse(JSON.stringify(r.items))) && !P.sameDrinks(r.items, {}) && !P.sameDrinks(null, r.items) && P.sameDrinks(null, {}));
  });

  await check('index.js exports the drink callables in us-east1', async () => {
    const ix = require('./index.js');
    for (const f of ['uploadDrinkPhoto', 'saveDrink', 'removeDrink', 'importDrinks', 'saveSpecial', 'removeSpecial', 'saveNightly']) {
      const ep = ix[f].__endpoint; assert.ok(ep.callableTrigger && ep.region[0] === 'us-east1', f);
    }
  });

  console.log('\n' + (failed ? `${failed} of ${passed + failed} checks failed.` : `All ${passed} checks passed.`));
  process.exit(failed ? 1 : 0);
})();
