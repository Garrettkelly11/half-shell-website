/*
 * Tests for src/catalog-editor.js (the employee page's Oysters tab, Merroir
 * spec v1.8).
 *   node tools/catalog-editor-test.js
 */
'use strict';
const assert = require('assert');
const C = require('../src/catalog-editor.js');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('PASS  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

const kuma = {
  id: 'kumamoto', name: 'Kumamoto', aliases: ['Kumo', 'Kumamoto WA'], status: 'ACTIVE', price: 4.5,
  salinity: null, salinityText: 'Mild', region: 'wa', origin: 'Totten Inlet, WA', farmer: null,
  farmerUrl: null, species: 'Crassostrea sikamea', farmingMethod: 'Bags', growOut: '3 years',
  seasonalAvailability: 'Year-round', size: 'Small', shell: 'Deep', tastingNotes: 'Melon.',
  notable: 'Classic.', photoUrl: 'assets/oysters/kumamoto.jpg', photoAlt: 'Kumamotos',
};

check('the tab talks to Merroir over https', () => {
  assert.strictEqual(C.API, 'https://merroir.onrender.com/api/catalog/');
});
check('only rank 20 (MANAGER) and up get the tab', () => {
  assert.strictEqual(C.isManager({ staff_rank: 10 }), false);
  assert.strictEqual(C.isManager({ staff_rank: 20 }), true);
  assert.strictEqual(C.isManager({ staff_rank: 40 }), true);
  assert.strictEqual(C.isManager({}), false, 'a sign-in from before v1.8 has no rank');
  assert.strictEqual(C.isManager(null), false);
});
check('the form has every published field except id and price', () => {
  const keys = C.FIELDS.map(f => f.key);
  ['name', 'aliases', 'salinity', 'salinityText', 'region', 'origin', 'farmer', 'farmerUrl', 'species',
    'farmingMethod', 'growOut', 'seasonalAvailability', 'size', 'shell', 'tastingNotes', 'notable',
    'photoUrl', 'photoAlt'].forEach(k => assert.ok(keys.includes(k), k));
  assert.ok(!keys.includes('price') && !keys.includes('id'));
});
check('other names split on commas, trimmed, no repeats or blanks', () => {
  assert.deepStrictEqual(C.splitAliases(' Kumo, Kumamoto WA,, Kumo '), ['Kumo', 'Kumamoto WA']);
  assert.deepStrictEqual(C.splitAliases(''), []);
});
check('editing: empty optional fields show as —, aliases as a list', () => {
  const v = C.formValues(kuma);
  assert.strictEqual(v.farmer, '—');
  assert.strictEqual(v.salinity, '—');
  assert.strictEqual(v.aliases, 'Kumo, Kumamoto WA');
  assert.strictEqual(v.photoUrl, 'assets/oysters/kumamoto.jpg');
});
check('adding: every field starts empty', () => {
  const v = C.formValues(null);
  assert.ok(Object.values(v).every(x => x === ''));
});
check('the form round-trips to what Merroir expects (never price or id)', () => {
  const p = C.payload(C.formValues(kuma));
  assert.deepStrictEqual(p.aliases, ['Kumo', 'Kumamoto WA']);
  assert.strictEqual(p.farmer, '—');
  assert.strictEqual(p.name, 'Kumamoto');
  assert.ok(!('price' in p) && !('id' in p) && !('confirm_different' in p));
  assert.strictEqual(C.payload(C.formValues(kuma), true).confirm_different, true);
});
check('a save → ok with the data', () => {
  const r = C.interpret(200, { status: 'ok', oyster: kuma, publish: null });
  assert.ok(r.ok && r.data.oyster.id === 'kumamoto');
});
check('a near-duplicate name → confirm, with the warnings', () => {
  const r = C.interpret(409, { status: 'confirm', message: 'Check these are different oysters.', warnings: ['close to Kumamoto'] });
  assert.deepStrictEqual(r.confirm, ['close to Kumamoto']);
});
check('bad fields → the message and each field\'s problem', () => {
  const r = C.interpret(400, { status: 'invalid', message: 'Some fields need fixing.', errors: { name: 'Name is required.' } });
  assert.strictEqual(r.error, 'Some fields need fixing.');
  assert.strictEqual(r.errors.name, 'Name is required.');
});
check('an expired sign-in → sign in again', () => {
  assert.ok(C.interpret(401, { status: 'forbidden' }).signIn);
});
check('not a manager → Merroir\'s message', () => {
  assert.strictEqual(C.interpret(403, { status: 'forbidden', message: 'Changing the oyster catalog is for managers.' }).error,
    'Changing the oyster catalog is for managers.');
});
check('anything else (Render waking up, 502) says nothing may have been saved', () => {
  assert.ok(/502/.test(C.interpret(502, null).error));
});
check('publish results read plainly, with the commit link', () => {
  const ok = C.describePublish({ status: 'PUBLISHED', commit_url: 'https://github.com/x/commit/1' });
  assert.ok(/about 2 minutes/.test(ok.text) && ok.link === 'https://github.com/x/commit/1');
  const bad = C.describePublish({ status: 'REFUSED', error: 'edited by hand' });
  assert.ok(/not yet on the site/.test(bad.text) && /edited by hand/.test(bad.text) && bad.publishNow);
  assert.ok(/not yet on the site/.test(C.describePublish({ status: 'FAILED', error: 'x' }).text));
  assert.strictEqual(C.describePublish(null).text, 'Nothing changed.');
});
check('Publish now: any failure wins; else the last commit; else up to date', () => {
  assert.ok(C.describePublishes([{ status: 'NO_CHANGE' }, { status: 'FAILED', error: 'down' }]).publishNow);
  assert.strictEqual(C.describePublishes([{ status: 'PUBLISHED', commit_url: 'a' }, { status: 'PUBLISHED', commit_url: 'b' }]).link, 'b');
  assert.strictEqual(C.describePublishes([{ status: 'NO_CHANGE' }, { status: 'NO_CHANGE' }]).text, 'The site is up to date.');
});
check('search matches name, other names, origin and id, ignoring case and punctuation', () => {
  const list = [kuma, { ...kuma, id: 'fat-bellies', name: 'Fat Bellies', aliases: [], origin: 'Newport River, NC' },
    { ...kuma, id: 'old', name: 'Old One', aliases: [], status: 'RETIRED' }];
  assert.deepStrictEqual(C.filterOysters(list, 'kumo', 'ACTIVE').map(o => o.id), ['kumamoto']);
  assert.deepStrictEqual(C.filterOysters(list, 'newport', 'ACTIVE').map(o => o.id), ['fat-bellies']);
  assert.deepStrictEqual(C.filterOysters(list, 'FAT-BELL', 'ACTIVE').map(o => o.id), ['fat-bellies']);
  assert.deepStrictEqual(C.filterOysters(list, '', 'RETIRED').map(o => o.id), ['old']);
  assert.deepStrictEqual(C.filterOysters(list, '', 'ACTIVE').map(o => o.name), ['Fat Bellies', 'Kumamoto']);
});
check('the Toast reminder is there', () => {
  assert.ok(/exactly as Toast has it/.test(C.TOAST_REMINDER));
});

console.log(`\n${failed ? 'FAILED: ' + failed + ' of ' + (passed + failed) : 'All ' + passed + ' checks passed.'}`);
process.exit(failed ? 1 : 0);
