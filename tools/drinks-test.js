#!/usr/bin/env node
/** Tests for src/drinks-core.js. Run: node tools/drinks-test.js (touches nothing live). */
'use strict';
const assert = require('assert');
const C = require('../src/drinks-core.js');
let n = 0;
function t(name, fn) { fn(); n++; }
// 2026-11-06 is a Friday. ET is UTC-5 in November.
const at = (date, hhmm) => Date.parse(`${date}T${hhmm}:00-05:00`);

t('money and parsePrice', () => {
  assert.strictEqual(C.money(1200), '$12'); assert.strictEqual(C.money(850), '$8.50');
  assert.strictEqual(C.parsePrice('$12.5'), 1250); assert.strictEqual(C.parsePrice('12'), 1200);
  assert.strictEqual(C.parsePrice('abc'), null); assert.strictEqual(C.parsePrice('-3'), null);
  assert.strictEqual(C.parsePrice(''), null); assert.strictEqual(C.parsePrice('1,200'), 120000);
});

t('business day rolls at 4 AM', () => {
  assert.strictEqual(C.businessDay(at('2026-11-06', '03:59')).date, '2026-11-05');
  assert.strictEqual(C.businessDay(at('2026-11-06', '03:59')).day, 'THU');
  assert.strictEqual(C.businessDay(at('2026-11-06', '04:00')).date, '2026-11-06');
  assert.strictEqual(C.businessDay(at('2026-11-06', '04:00')).day, 'FRI');
  assert.strictEqual(C.businessDay(at('2026-11-09', '01:00')).day, 'SUN');
});

t('toastKey and cleanName: the match between a record and a Toast drink', () => {
  assert.strictEqual(C.toastKey('DFT Allagash White'), 'allagashwhite');
  assert.strictEqual(C.toastKey('allagash   white'), 'allagashwhite');
  assert.strictEqual(C.toastKey('BTL Bud Light'), C.toastKey("bud-light"));
  assert.strictEqual(C.toastKey('Surf & Turf Sour'), C.toastKey('Surf and Turf Sour'));
  assert.strictEqual(C.toastKey('Canadian Club'), 'canadianclub', 'only the CAN prefix word is dropped, not letters of a name');
  assert.strictEqual(C.toastKey('Dftx Ale'), 'dftxale');
  assert.strictEqual(C.cleanName('CAN  Burial Surf Wax IPA'), 'Burial Surf Wax IPA');
  assert.strictEqual(C.toastKey('!!!'), '');
  assert.strictEqual(C.toastKey('Crémant de Loire'), C.toastKey('Cremant de Loire'), 'accents do not break the match');
  assert.strictEqual(C.toastKey('Rosé'), 'rose');
});

t('validateDrink: extras only; price and category belong to Toast', () => {
  const ok = C.validateDrink({ name: "DFT Dark 'n Stormy", category: 'cocktails', priceText: '$13', tags: 'house; SPICY', allergens: 'sulfites', abv: '12%' });
  assert.ok(ok.ok, ok.errors.join()); assert.strictEqual(ok.drink.id, 'dark-n-stormy', 'id ignores the Toast prefix');
  assert.deepStrictEqual(ok.drink.tags, ['House', 'Spicy']); assert.strictEqual(ok.drink.abv, 12);
  assert.ok(!('price' in ok.drink) && !('category' in ok.drink), 'Toast owns price and category');
  const bad = C.validateDrink({ name: '', tags: 'weird', allergens: 'glitter', photo: 'http://evil.example/x.jpg' });
  assert.ok(!bad.ok); assert.ok(bad.errors.length >= 4, bad.errors.join());
  assert.ok(!C.validateDrink({ name: '!!!' }).ok, 'a name with no letters can never match');
  assert.strictEqual(C.validateDrink({ name: 'A', available: 'no' }).drink.available, false);
  assert.ok(C.validateDrink({ name: 'A', photo: C.STORAGE_HOST + 'v0/b/x/o/drinks%2Fp.jpg?alt=media&token=t' }).ok);
});

t('parseCSV handles quotes, commas, CRLF, BOM', () => {
  const rows = C.parseCSV('﻿Name,Category,Price,Description\r\n"Gin, Tonic",Cocktails,12,"A ""classic"""\r\n\r\nPilsner,Beer,6,\r\n');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].Name, 'Gin, Tonic'); assert.strictEqual(rows[0].Description, 'A "classic"');
  assert.strictEqual(rows[1].Price, '6');
});

t('drinksFromRows: aliases, row errors, duplicates, Toast-owned columns', () => {
  const r = C.drinksFromRows(C.parseCSV('Drink,Section,Cost,Notes\nMargarita,Cocktails,12,Lime\nmargarita,Cocktails,12,Again\nDFT Margarita,,,Third\n,,,\n'));
  assert.strictEqual(r.drinks.length, 1); assert.strictEqual(r.problems.length, 2);
  assert.strictEqual(r.problems[0].row, 3); assert.strictEqual(r.problems[1].row, 4);
  assert.deepStrictEqual(r.ignored, ['Section', 'Cost'], 'Price and category columns are reported, not used');
  assert.deepStrictEqual(r.fields, ['name', 'description']);
  assert.ok(!('price' in r.drinks[0]) && !('category' in r.drinks[0]));
  const m = C.drinksFromRows(C.parseCSV('Price,Description\n3,x'));
  assert.ok(m.fatal && /Name/.test(m.problems[0].errors[0]));
  assert.ok(C.drinksFromRows([]).fatal);
  assert.strictEqual(C.drinksFromRows(C.parseCSV('Name,Tags\nA,weird\n')).problems.length, 1, 'bad tag is a row problem');
});

t('csv round trip', () => {
  const src = C.drinksFromRows(C.parseCSV('Name,Size,Description,ABV,Tags,Allergens,Available\n"Rye, Neat",2oz,"Smoky ""rye""",45,House,,yes\n')).drinks;
  const back = C.drinksFromRows(C.parseCSV(C.toCSV(src))).drinks;
  assert.deepStrictEqual(back, src);
  assert.ok(C.toCSV([]).startsWith('Name,Size,Description'));
  assert.ok(!/price|category/i.test(C.toCSV([])), 'the template has no Toast columns');
});

t('diffImport', () => {
  const a = C.validateDrink({ name: 'A', description: 'x' }).drink, b = C.validateDrink({ name: 'B' }).drink;
  const a2 = Object.assign({}, a, { description: 'changed' }), c = C.validateDrink({ name: 'C' }).drink;
  const cur = { a, b };
  assert.deepStrictEqual(C.diffImport(cur, [a2, c], 'merge'), { added: ['c'], changed: ['a'], same: [], removed: [] });
  assert.deepStrictEqual(C.diffImport(cur, [a2, c], 'replace'), { added: ['c'], changed: ['a'], same: [], removed: ['b'] });
  assert.deepStrictEqual(C.diffImport(cur, [a], 'merge').same, ['a']);
});

t('validateSpecial', () => {
  const base = { kind: 'price', drinkId: 'a', priceText: '4', startDate: '2026-11-06', endDate: '2026-11-08' };
  assert.ok(C.validateSpecial(base, ['a']).ok);
  assert.ok(!C.validateSpecial(base, ['z']).ok);
  assert.ok(!C.validateSpecial(Object.assign({}, base, { endDate: '2026-11-05' }), ['a']).ok);
  assert.ok(!C.validateSpecial(Object.assign({}, base, { startDate: '2026-02-30' }), ['a']).ok);
  assert.ok(!C.validateSpecial(Object.assign({}, base, { start: '17:00' }), ['a']).ok, 'half a window');
  assert.ok(!C.validateSpecial(Object.assign({}, base, { start: '17:00', end: '17:00' }), ['a']).ok);
  assert.ok(!C.validateSpecial(Object.assign({}, base, { days: 'FUNDAY' }), ['a']).ok);
  assert.deepStrictEqual(C.validateSpecial(Object.assign({}, base, { days: 'mon,tue,wed,thu,fri,sat,sun' }), ['a']).special.days, []);
  const l = C.validateSpecial({ kind: 'limited', drinkId: 'pumpkin-spice-martini', startDate: '2026-11-06', endDate: '2026-11-30', note: 'Through Thanksgiving' }, ['pumpkin-spice-martini']);
  assert.ok(l.ok, l.errors.join()); assert.strictEqual(l.special.drinkId, 'pumpkin-spice-martini'); assert.ok(!('price' in l.special) && !('item' in l.special), 'a limited-time drink has no price of its own');
  assert.ok(!C.validateSpecial({ kind: 'limited', startDate: '2026-11-06', endDate: '2026-11-30' }, ['a']).ok, 'needs a drink');
  assert.ok(!C.validateSpecial({ kind: 'nope' }).ok);
});

t('specialActive: dates, days, windows, past-midnight windows', () => {
  const s = { kind: 'price', drinkId: 'a', price: 400, startDate: '2026-11-06', endDate: '2026-11-08', days: [] };
  assert.ok(C.specialActive(s, at('2026-11-06', '12:00')));
  assert.ok(!C.specialActive(s, at('2026-11-05', '12:00')));
  assert.ok(C.specialActive(s, at('2026-11-09', '02:00')), 'Sunday night after midnight is still Sunday 11-08');
  assert.ok(!C.specialActive(s, at('2026-11-09', '05:00')));
  const fri = Object.assign({}, s, { days: ['FRI'] });
  assert.ok(C.specialActive(fri, at('2026-11-06', '20:00')) && !C.specialActive(fri, at('2026-11-07', '20:00')));
  assert.ok(C.specialActive(fri, at('2026-11-07', '01:00')) === false || true); // 1 AM Sat is business-day Fri
  assert.ok(C.specialActive(fri, at('2026-11-07', '01:00')), 'business day Friday until 4 AM');
  const hh = Object.assign({}, s, { start: '15:00', end: '18:00' });
  assert.ok(C.specialActive(hh, at('2026-11-06', '15:00')) && !C.specialActive(hh, at('2026-11-06', '18:00')));
  assert.ok(!C.specialActive(hh, at('2026-11-06', '14:59')));
  const late = Object.assign({}, s, { start: '22:00', end: '02:00', days: ['SAT'], startDate: '2026-11-01', endDate: '2026-11-30' });
  assert.ok(C.specialActive(late, at('2026-11-07', '23:00')), 'Sat 11pm');
  assert.ok(C.specialActive(late, at('2026-11-08', '01:30')), 'Sun 1:30am belongs to Saturday');
  assert.ok(!C.specialActive(late, at('2026-11-07', '01:30')), 'Sat 1:30am belongs to Friday');
  assert.ok(!C.specialActive(late, at('2026-11-08', '02:00')));
  assert.strictEqual(C.specialStatus(s, at('2026-11-05', '12:00')), 'scheduled');
  assert.strictEqual(C.specialStatus(s, at('2026-11-10', '12:00')), 'ended');
  assert.strictEqual(C.specialStatus(hh, at('2026-11-06', '12:00')), 'idle');
  assert.strictEqual(C.specialStatus(hh, at('2026-11-06', '16:00')), 'live');
});

// Toast's side, as the sync writes it: price in cents, `order` = Toast's own order, sizes for wine.
const toastItem = (name, group, order, extra) => Object.assign({ name, group, order, inStock: true, strategy: 'BASE_PRICE' }, extra);
const TOAST = {
  oldfashioned: toastItem('Old Fashioned', 'House Cocktails', 20, { price: 1400 }),
  lager: toastItem('DFT Lager', 'Draft Beer', 1, { price: 600 }),
  gone: toastItem('DFT Gone', 'Draft Beer', 2, { price: 600 }),
  soldout: toastItem('CAN Sold Out', 'Cans', 5, { price: 700, inStock: false }),
  zin: toastItem('Zin', 'Red Wine', 40, { strategy: 'SIZE_PRICE', sizes: [{ name: '6 oz', price: 1100 }, { name: 'Bottle', price: 4000 }] }),
  cab: toastItem('Cab', 'Red Wine', 41, { price: 5500 }),
  pumpkinmartini: toastItem('Pumpkin Martini', 'House Cocktails', 21, { price: 1500 }),
  marketoystershot: toastItem('Market Oyster Shot', 'House Cocktails', 22, { strategy: 'OPEN_PRICE' }),
  notprofiledbeer: toastItem('Not Profiled Beer', 'Draft Beer', 3, { price: 600 }),
};
const rec = (o) => Object.assign({ id: C.slug(C.cleanName(o.name)) }, o);

t('buildMenu: Toast supplies name, price and section; records supply extras', () => {
  const drinks = {
    lager: rec({ name: 'Lager', description: 'Crisp', tags: ['Local'] }),         // matches "DFT Lager" (prefix dropped)
    'old-fashioned': rec({ name: 'Old Fashioned', sort: 5 }),
    gone: rec({ name: 'Gone', available: false }),                                 // hidden by a manager
    'sold-out': rec({ name: 'Sold Out' }),                                          // 86'd in Toast
    zin: rec({ name: 'Zin' }), cab: rec({ name: 'Cab' }), ghost: rec({ name: 'Ghost Drink' }), // ghost: not in Toast
    'pumpkin-martini': rec({ name: 'Pumpkin Martini' }), mp: rec({ name: 'Market Oyster Shot' }),
  };
  const specials = {
    s1: { kind: 'price', drinkId: 'lager', price: 400, startDate: '2026-11-01', endDate: '2026-11-30', days: [] },
    s2: { kind: 'price', drinkId: 'lager', price: 300, startDate: '2026-11-01', endDate: '2026-11-30', days: [] },
    s3: { kind: 'price', drinkId: 'cab', price: 9900, startDate: '2026-11-01', endDate: '2026-11-30', days: [] },
    s4: { kind: 'price', drinkId: 'zin', price: 100, startDate: '2026-11-01', endDate: '2026-11-30', days: [] },
    s5: { kind: 'limited', drinkId: 'pumpkin-martini', note: 'Through Thanksgiving', startDate: '2026-11-01', endDate: '2026-11-30', days: [] },
    s6: { kind: 'price', drinkId: 'old-fashioned', price: 100, startDate: '2026-12-01', endDate: '2026-12-31', days: [] },
  };
  const m = C.buildMenu(drinks, specials, TOAST, at('2026-11-06', '19:00'));
  assert.deepStrictEqual(m.map(g => g.category), ['Draft Beer', 'House Cocktails', 'Red Wine'], "sections come from Toast, in Toast's order");
  const lager = m[0].items[0];
  assert.strictEqual(lager.name, 'Lager', 'the Toast prefix is not shown'); assert.strictEqual(lager.price, 300); assert.strictEqual(lager.was, 600); assert.ok(lager.special);
  assert.strictEqual(lager.description, 'Crisp');
  assert.ok(!m.some(g => g.items.some(i => ['gone', 'sold-out', 'ghost'].includes(i.id))), 'hidden, 86d in Toast and not-in-Toast drinks stay off');
  assert.ok(!m.some(g => g.items.some(i => i.name === 'Not Profiled Beer' || i.name === 'Old Fashioned Twin')), 'a Toast drink nobody added to the menu does not show');
  const cocktails = m[1].items;
  assert.strictEqual(cocktails[0].id, 'pumpkin-martini', 'limited-time first'); assert.ok(cocktails[0].limited); assert.strictEqual(cocktails[0].price, 1500, "limited drinks use Toast's price");
  assert.strictEqual(cocktails[1].id, 'old-fashioned'); assert.strictEqual(cocktails[1].price, 1400, 'a future special is not applied');
  assert.strictEqual(cocktails[2].id, 'mp'); assert.strictEqual(cocktails[2].price, undefined, 'open price: no number');
  const wine = m[2].items;
  assert.strictEqual(wine[0].id, 'zin'); assert.deepStrictEqual(wine[0].sizes.map(z => z.name), ['6 oz', 'Bottle']); assert.strictEqual(wine[0].price, undefined);
  assert.ok(!wine[0].special, 'a price special does not apply to a drink with sizes');
  assert.strictEqual(wine[1].price, 5500, 'a "special" above the Toast price is ignored');
});

t('buildMenu: a limited-time drink shows only while its special is live; toast changes flow through', () => {
  const drinks = { 'pumpkin-martini': rec({ name: 'Pumpkin Martini' }) };
  const lim = (a, b) => ({ s: { kind: 'limited', drinkId: 'pumpkin-martini', startDate: a, endDate: b, days: [] } });
  const has = m => m.some(g => g.items.some(i => i.id === 'pumpkin-martini'));
  assert.ok(has(C.buildMenu(drinks, lim('2026-11-01', '2026-11-30'), TOAST, at('2026-11-06', '12:00'))));
  assert.ok(!has(C.buildMenu(drinks, lim('2026-11-10', '2026-11-30'), TOAST, at('2026-11-06', '12:00'))), 'not started');
  assert.ok(!has(C.buildMenu(drinks, lim('2026-10-01', '2026-10-31'), TOAST, at('2026-11-06', '12:00'))), 'ended');
  assert.ok(has(C.buildMenu(drinks, {}, TOAST, at('2026-11-06', '12:00'))), 'with no special it is an ordinary drink');
  const bare = C.buildMenu({}, lim('2026-10-01', '2026-10-31'), TOAST, at('2026-11-06', '12:00'));
  assert.ok(!has(bare), 'limited gating works with no record too');
  assert.ok(has(C.buildMenu({}, lim('2026-11-01', '2026-11-30'), TOAST, at('2026-11-06', '12:00'))), 'a live limited-time special puts a drink on the menu for its window, record or not');
  assert.ok(!has(C.buildMenu({ 'pumpkin-martini': rec({ name: 'Pumpkin Martini', available: false }) }, lim('2026-11-01', '2026-11-30'), TOAST, at('2026-11-06', '12:00'))), 'but a manager switching it off wins');
  const repriced = Object.assign({}, TOAST, { pumpkinmartini: toastItem('Pumpkin Martini', 'House Cocktails', 21, { price: 1600 }) });
  const rp = C.buildMenu(drinks, {}, repriced, Date.now()).find(g => g.category === 'House Cocktails').items.find(i => i.id === 'pumpkin-martini');
  assert.strictEqual(rp.price, 1600, 'the Toast price is read live');
  assert.strictEqual(C.buildMenu(drinks, {}, {}, Date.now()).length, 0, 'empty Toast list: nothing shows');
  assert.deepStrictEqual(C.buildMenu({}, {}, TOAST, Date.now()), [], 'no records at all: nothing is on the menu until a manager adds drinks');
  assert.deepStrictEqual(C.buildMenu(drinks, {}, null, Date.now()), [], 'no toast list at all');
});

t('listRows / findToast: every Toast drink is listed; records are optional', () => {
  const drinks = { lager: rec({ name: 'Lager' }), gone: rec({ name: 'Gone', available: false }), ghost: rec({ name: 'Ghost Drink' }), 'sold-out': rec({ name: 'Sold Out' }) };
  const toast = Object.assign({ junk: toastItem('# of Glasses', 'Wine', 99, { price: 0 }) }, TOAST);
  const rows = C.listRows(drinks, toast);
  assert.ok(!rows.some(r => r.name.indexOf('Glasses') >= 0), 'non-drink modifier rows are skipped');
  assert.strictEqual(rows.filter(r => r.t).length, Object.keys(TOAST).length, 'every usable Toast drink is listed');
  const by = n => rows.find(r => r.name === n);
  assert.strictEqual(by('Lager').status, 'live'); assert.ok(by('Lager').rec);
  assert.strictEqual(by('Gone').status, 'off'); assert.strictEqual(by('Sold Out').status, '86');
  assert.ok(by('Not Profiled Beer').rec === null && by('Not Profiled Beer').status === 'off', 'no record = not on the menu');
  assert.strictEqual(by('Ghost Drink').status, 'missing');
  assert.strictEqual(rows[rows.length - 1].name, 'Ghost Drink', 'orphan records come last');
  assert.ok(C.findToast('lager', drinks, toast).t.price === 600, 'by record id');
  assert.ok(C.findToast('not-profiled-beer', drinks, toast).rec === null, 'by Toast name slug when no record');
  assert.strictEqual(C.findToast('ghost', drinks, toast), null); assert.strictEqual(C.findToast('nope', drinks, toast), null);
  const sp = { s: { kind: 'limited', drinkId: 'not-profiled-beer', startDate: '2026-11-01', endDate: '2026-11-30', days: [] } };
  const m = C.buildMenu({}, sp, TOAST, at('2026-11-06', '19:00'));
  assert.strictEqual(m[0].items[0].id, 'not-profiled-beer', 'a limited-time special works on a drink with no record');
});

t('csv cleaning: delimiters, invisible characters, forgiving tags, strict ABV and availability, blanks keep old values', () => {
  const rows = txt => C.drinksFromRows(C.parseCSV(txt));
  assert.strictEqual(rows('Name;Description;Tags\nA;Nice;Local\n').drinks[0].tags[0], 'Local', 'semicolon files (Excel in other regions)');
  assert.strictEqual(rows('Name\tDescription\nA\tNice\n').drinks[0].description, 'Nice', 'tab files');
  assert.strictEqual(rows('Name,Description\n"A\u00a0B\u200b","  hi\u00a0 there \n x "\n').drinks[0].name, 'A B');
  assert.strictEqual(rows('Name,Description\nA,"l1\nl2"\n').drinks[0].description, 'l1 l2', 'line breaks become spaces');
  const f = rows('Name,Tags,Allergens\nA,"local, Gluten Free; non alcoholic","tree nut, shell fish, dairy"\n').drinks[0];
  assert.deepStrictEqual(f.tags, ['Local', 'Gluten-free', 'Non-alcoholic']); assert.deepStrictEqual(f.allergens, ['Tree nuts', 'Shellfish', 'Milk']);
  assert.ok(rows('Name,Tags\nA,bogus\n').problems.length, 'unknown tags still stop the import');
  const abv = rows('Name,ABV\nA,5.5% ABV\nB,"5,5"\nC,abc\nD,0.055\nE,0.5%\nF,5.55.5\n');
  assert.deepStrictEqual(abv.drinks.map(d => [d.name, d.abv]), [['A', 5.5], ['B', 5.5], ['E', 0.5]]);
  assert.deepStrictEqual(abv.problems.map(p => p.row), [4, 5, 7], 'bad numbers and fractions are rejected, not guessed');
  const av = rows('Name,Available\nA,Yes\nB,no\nC,Sold out\nD,\n');
  assert.deepStrictEqual(av.drinks.map(d => d.available), [true, false, true]); assert.strictEqual(av.problems[0].row, 4);
  assert.ok(rows('Name\nCr\ufffdmant\n').problems.length && rows('Name\nCr\u00c3\u00a9mant\n').problems.length, 'wrong-encoding names are refused');
  assert.deepStrictEqual(rows('Name,Notes2,Price\nA,x,5\n').unknownColumns, ['Notes2']);
  assert.deepStrictEqual(rows('Name,Notes2,Price\nA,x,5\n').ignored, ['Price']);
  // blank cells keep what is there in a merge
  const old = { id: 'a', name: 'A', description: 'Keep me', tags: ['Local'], allergens: ['Milk'], available: false };
  const r2 = rows('Name,Description,Tags,Available\nA,,Vegan,\n');
  const m = C.mergeFields(old, r2.drinks[0], r2.fields);
  assert.deepStrictEqual([m.description, m.tags, m.available, 'keep' in m], ['Keep me', ['Vegan'], false, false]);
});

t('matchStatus', () => {
  assert.strictEqual(C.matchStatus({ name: 'Lager' }, TOAST), 'live');
  assert.strictEqual(C.matchStatus({ name: 'dft lager!' }, TOAST), 'live');
  assert.strictEqual(C.matchStatus({ name: 'Lager', available: false }, TOAST), 'hidden');
  assert.strictEqual(C.matchStatus({ name: 'Sold Out' }, TOAST), '86');
  assert.strictEqual(C.matchStatus({ name: 'Nope' }, TOAST), 'missing');
  assert.strictEqual(C.matchStatus({ name: 'Lager' }, null), 'missing');
});

t('validateNightly', () => {
  const ok = C.validateNightly({ date: '2026-11-06', items: [{ name: 'Crab Bisque', ingredients: 'crab, cream', description: 'Rich', allergens: 'shellfish; milk', price: '9' }, { name: 'Oyster Po Boy' }] });
  assert.ok(ok.ok, ok.errors.join()); assert.deepStrictEqual(ok.nightly.items[0].allergens, ['Shellfish', 'Milk']); assert.strictEqual(ok.nightly.items[0].price, 900);
  assert.ok(!C.validateNightly({ date: 'x', items: [{ name: '' }, { name: 'A', allergens: 'dust' }] }).ok);
  assert.ok(C.validateNightly({ date: '2026-11-06', items: [] }).ok, 'an empty night clears the list');
});

t('review fixes: prices, photo links, availability flags', () => {
  assert.strictEqual(C.parsePrice('12,50'), null); assert.strictEqual(C.parsePrice('1,2'), null);
  assert.strictEqual(C.parsePrice('$1,200'), 120000); assert.strictEqual(C.parsePrice(12.999), null); assert.strictEqual(C.parsePrice('12.999'), null);
  assert.strictEqual(C.parsePrice(12.5), 1250);
  const good = C.STORAGE_HOST + 'v0/b/bkt/o/drinks%2Fa-1.jpg?alt=media&token=abc-123';
  assert.ok(C.validPhotoUrl(good) && C.validPhotoUrl(good, 'bkt') && !C.validPhotoUrl(good, 'other'));
  assert.ok(!C.validPhotoUrl(C.STORAGE_HOST + 'v0/b/bkt/o/../../evil/o/x.png'));
  assert.ok(!C.validPhotoUrl('http://firebasestorage.googleapis.com/v0/b/bkt/o/drinks%2Fa.jpg'));
  assert.ok(!C.validPhotoUrl('https://evil.example/https://firebasestorage.googleapis.com/v0/b/bkt/o/drinks%2Fa.jpg'));
  for (const v of ['n', 'N', 'no', 'No', 'false', '86', 'off']) assert.strictEqual(C.validateDrink({ name: 'A', available: v }).drink.available, false, v);
  assert.strictEqual(C.validateDrink({ name: 'A', sort: '' }).drink.sort, undefined, 'blank sort stays unset');
  assert.strictEqual(C.validateDrink({ name: 'A', sort: '0' }).drink.sort, 0);
  assert.doesNotThrow(() => C.buildMenu({ a: { name: 'A' }, b: { name: '__proto__' }, c: { name: 'constructor' } }, {}, { a: { name: 'A', group: 'constructor', order: 1, price: 100, inStock: true } }, Date.now()));
  assert.doesNotThrow(() => C.buildMenu({ a: { name: 'A' } }, {}, { a: { name: 'A', group: '__proto__', order: 1, price: 100, inStock: true } }, Date.now()));
});

t('review fixes: merge import keeps columns the file does not have', () => {
  const old = { id: 'a', name: 'A', size: '16oz', description: 'Nice', tags: ['Local'], allergens: ['Wheat'], available: false, photo: 'p', sort: 2 };
  const file = C.drinksFromRows(C.parseCSV('Name,Description\nA,Better\n'));
  assert.deepStrictEqual(file.fields, ['name', 'description']);
  const merged = C.mergeFields(old, file.drinks[0], file.fields);
  assert.deepStrictEqual([merged.description, merged.allergens, merged.tags, merged.available, merged.size], ['Better', ['Wheat'], ['Local'], false, '16oz']);
  const full = C.drinksFromRows(C.parseCSV('Name,Description,Allergens,Available\nA,Nice,,yes\n'));
  const m2 = C.mergeFields(old, full.drinks[0], full.fields);
  assert.deepStrictEqual([m2.allergens, m2.available, m2.tags], [['Wheat'], true, ['Local']], 'present columns overwrite, but a blank cell keeps what is there');
  assert.deepStrictEqual(C.diffImport({ a: old }, file.drinks, 'merge', file.fields), { added: [], changed: ['a'], same: [], removed: [] });
  const same = C.drinksFromRows(C.parseCSV('Name,Description\nA,Nice\n'));
  assert.deepStrictEqual(C.diffImport({ a: old }, same.drinks, 'merge', same.fields).same, ['a']);
});

t('review fixes: ids survive export/import, row numbers, constructor ids, formula guard', () => {
  const d = C.validateDrink({ name: 'Renamed', id: 'old-id' }).drink;
  const back = C.drinksFromRows(C.parseCSV(C.toCSV([d]))).drinks[0];
  assert.strictEqual(back.id, 'old-id');
  const r = C.drinksFromRows(C.parseCSV('Name,Description\n\nA,x\n\nB,\n'));
  assert.strictEqual(r.problems.length, 0); assert.strictEqual(r.drinks.length, 2);
  const bad = C.drinksFromRows(C.parseCSV('Name,Tags\n\nA,Local\n\nB,nonsense\n'));
  assert.strictEqual(bad.problems[0].row, 5, 'spreadsheet row, blank lines counted');
  const c = C.drinksFromRows(C.parseCSV('Name\nConstructor\n'));
  assert.strictEqual(c.problems.length, 0, 'an id like "constructor" is not a repeat');
  assert.ok(C.toCSV([C.validateDrink({ name: '=1+1' }).drink]).includes("'=1+1"));
  assert.strictEqual(C.drinksFromRows(C.parseCSV("Name\n'=1+1\n")).drinks[0].name, '=1+1', 'guard is undone on import');
});

t('review fixes: windows before 4 AM belong to the business day; bad specials never go live', () => {
  const base = { kind: 'price', drinkId: 'a', price: 400, days: [] };
  const w = Object.assign({}, base, { start: '00:30', end: '02:00', startDate: '2026-11-06', endDate: '2026-11-06' });
  assert.ok(!C.specialActive(w, at('2026-11-06', '01:00')), 'Fri 1 AM is Thursday night');
  assert.ok(C.specialActive(w, at('2026-11-07', '01:00')), 'Sat 1 AM is Friday night');
  const fri = Object.assign({}, base, { start: '01:00', end: '03:00', days: ['FRI'], startDate: '2026-11-01', endDate: '2026-11-30' });
  assert.ok(!C.specialActive(fri, at('2026-11-06', '02:00')) && C.specialActive(fri, at('2026-11-07', '02:00')));
  const ended = Object.assign({}, base, { start: '01:00', end: '03:00', startDate: '2026-11-01', endDate: '2026-11-05' });
  assert.ok(C.specialActive(ended, at('2026-11-06', '02:00')), 'still Thursday night, last day');
  assert.ok(!C.specialActive({ kind: 'price', drinkId: 'a', price: 100 }, Date.now()), 'no dates');
  assert.ok(!C.specialActive(Object.assign({}, base, { startDate: '2026-01-01', endDate: '2027-01-01', start: 'abc', end: 'xyz' }), Date.now()), 'bad window');
  const dr = { a: { name: 'A' }, b: { description: 'no name' }, c: { name: 'C' } };
  const tt = { a: { name: 'A', group: 'Beer', order: 1, price: 500, inStock: true }, c: { name: 'C', group: 'Beer', order: 2, price: 'x', inStock: true } };
  const sp = { s1: Object.assign({}, base, { drinkId: 'a', startDate: '2026-01-01', endDate: '2027-12-31', price: -5 }), s2: Object.assign({}, base, { drinkId: 'a', startDate: '2026-01-01', endDate: '2027-12-31', price: '1' }),
    s3: { kind: 'limited', startDate: '2026-01-01', endDate: '2027-12-31' }, s4: null };
  const m = C.buildMenu(dr, sp, tt, at('2026-11-06', '12:00'));
  assert.strictEqual(m.length, 1); assert.strictEqual(m[0].items.length, 2); assert.strictEqual(m[0].items[0].price, 500, 'a negative or text special is ignored');
  assert.strictEqual(m[0].items[1].price, undefined, 'a non-number Toast price is never shown');
});

(async () => {
  const X = require('../src/drinks-xlsx.js');
  const fs = require('fs'), path = require('path');
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures', 'drinks-sample.xlsx'));
  const rows = await X.readRows(buf);
  assert.strictEqual(rows.length, 4, 'blank row dropped, second sheet ignored');
  assert.strictEqual(rows[0].Description, 'Rye, demerara & bitters');
  assert.strictEqual(rows[1].Available, 'yes', 'boolean cell');
  assert.strictEqual(rows[3].Price, '9.7', 'float noise rounded (9.700000000000001)');
  assert.ok(rows[0].__row === 2 && rows[3].__row === 6, 'sheet row numbers kept');
  const r = C.drinksFromRows(rows);
  assert.strictEqual(r.problems.length, 0, JSON.stringify(r.problems));
  assert.strictEqual(r.drinks.length, 4);
  assert.deepStrictEqual(r.ignored, ['Category', 'Price'], 'an old-style sheet still imports; Toast owns those columns');
  const byId = Object.fromEntries(r.drinks.map(d => [d.id, d]));
  assert.ok(!('price' in byId['old-fashioned'])); assert.deepStrictEqual(byId['pilsner'].allergens, ['Wheat']);
  assert.strictEqual(byId['zero-proof-spritz'].available, false);
  assert.deepStrictEqual(byId['zero-proof-spritz'].tags, ['Non-alcoholic', 'Vegan']);
  assert.strictEqual(byId['pilsner'].description, 'Crisp "local" lager');
  await assert.rejects(X.readRows(Buffer.from('not a zip file at all, just text, long enough to scan.')), /not an Excel/);
  await assert.rejects(X.readRows(new Uint8Array(6 * 1024 * 1024)), /5 MB/);
  n++;
  console.log(`drinks-test: ${n} groups passed`);
})().catch((e) => { console.error(e); process.exit(1); });
