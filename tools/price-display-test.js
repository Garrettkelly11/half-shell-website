/*
 * Tests for src/price-display.js (prices from Toast and happy hour, S5).
 *   node tools/price-display-test.js
 */
'use strict';
const assert = require('assert');
const P = require('../src/price-display.js');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('PASS  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

// New York wall-clock → UTC ms. October 2026 is EDT (UTC−4); 2 Nov is EST (UTC−5).
const edt = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h + 4, mi);
const est = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h + 5, mi);
const HH = { schedule: { days: ['MON', 'TUE', 'WED', 'THU'], start: '15:00', end: '18:00', percentOff: 50 } };
// 8 Oct 2026 is a Thursday; 9 Oct a Friday.
const THU = (h, m) => edt(2026, 10, 8, h, m), FRI = (h, m) => edt(2026, 10, 9, h, m);

check('New York day and time', () => {
  assert.deepStrictEqual(P.nyNow(THU(15, 0)), { day: 'THU', minutes: 900 });
  assert.deepStrictEqual(P.nyNow(edt(2026, 10, 8, 23, 59)), { day: 'THU', minutes: 1439 });
});
check('window edges: 2:59 no, 3:00 yes, 5:59 yes, 6:00 no', () => {
  assert.strictEqual(P.isHappyHour(HH, THU(14, 59)), false);
  assert.strictEqual(P.isHappyHour(HH, THU(15, 0)), true);
  assert.strictEqual(P.isHappyHour(HH, THU(17, 59)), true);
  assert.strictEqual(P.isHappyHour(HH, THU(18, 0)), false);
});
check('Thursday 5:59 PM yes, Friday 5:59 PM no', () => {
  assert.strictEqual(P.isHappyHour(HH, THU(17, 59)), true);
  assert.strictEqual(P.isHappyHour(HH, FRI(17, 59)), false);
});
check('both DST change days (a Sunday rule): 3 PM is 3 PM local', () => {
  const SUN = { schedule: { ...HH.schedule, days: ['SUN'] } };
  // 8 Mar 2026: clocks go forward at 2 AM (EDT afterwards). 1 Nov 2026: back at 2 AM (EST).
  assert.strictEqual(P.isHappyHour(SUN, Date.UTC(2026, 2, 8, 19, 0)), true);   // 3:00 PM EDT
  assert.strictEqual(P.isHappyHour(SUN, Date.UTC(2026, 2, 8, 18, 59)), false); // 2:59 PM EDT
  assert.strictEqual(P.isHappyHour(SUN, Date.UTC(2026, 10, 1, 20, 0)), true);  // 3:00 PM EST
  assert.strictEqual(P.isHappyHour(SUN, Date.UTC(2026, 10, 1, 19, 59)), false); // 2:59 PM EST
  assert.strictEqual(P.isHappyHour(HH, est(2026, 11, 2, 15, 0)), true);        // Monday after
});
check('today switched off: no happy hour, until the switch runs out', () => {
  const off = { ...HH, today: { state: 'off', until: edt(2026, 10, 9, 4, 0) } };
  assert.strictEqual(P.isHappyHour(off, THU(16, 0)), false);
  assert.strictEqual(P.isHappyHour({ ...HH, today: { state: 'off', until: THU(12, 0) } }, THU(16, 0)), true);
});
check('today switched on: an unscheduled day gets the usual times', () => {
  const on = { ...HH, today: { state: 'on', until: edt(2026, 10, 10, 4, 0) } };
  assert.strictEqual(P.isHappyHour(on, FRI(16, 0)), true);
  assert.strictEqual(P.isHappyHour(on, FRI(18, 0)), false);
  assert.strictEqual(P.isHappyHour(on, FRI(14, 0)), false);
});
check('no schedule: never happy hour', () => {
  assert.strictEqual(P.isHappyHour(null, THU(16, 0)), false);
  assert.strictEqual(P.isHappyHour({}, THU(16, 0)), false);
});
check('half off, half a cent rounds up: $4.25 → $2.13, $5 → $2.50, $3.50 → $1.75', () => {
  assert.strictEqual(P.discountCents(425, 50), 213);
  assert.strictEqual(P.discountCents(500, 50), 250);
  assert.strictEqual(P.discountCents(350, 50), 175);
  assert.strictEqual(P.discountCents(399, 50), 200);
  assert.strictEqual(P.discountCents(425, 30), 298); // 2.975 → 2.98
});
check('regular price outside happy hour; "$5", "$4.50"', () => {
  assert.deepStrictEqual(P.priceFor({ price: 5, strategy: 'BASE_PRICE' }, HH, FRI(16, 0)), { text: '$5', label: '$5' });
  assert.strictEqual(P.priceFor({ price: 4.5, strategy: 'BASE_PRICE' }, HH, FRI(16, 0)).text, '$4.50');
});
check('happy hour price with the regular price, read aloud', () => {
  const p = P.priceFor({ price: 4.25, strategy: 'BASE_PRICE' }, HH, THU(16, 0));
  assert.deepStrictEqual(p, { text: '$2.13', regular: '$4.25', happy: true, label: 'Happy hour $2.13, regularly $4.25' });
  const html = P.priceHtml(p);
  assert.ok(html.includes('<s aria-hidden="true">$4.25</s>') && html.includes('aria-label="Happy hour $2.13, regularly $4.25"'));
});
check('the employee table can ask for the regular price during happy hour', () => {
  assert.strictEqual(P.priceFor({ price: 5, strategy: 'BASE_PRICE' }, HH, THU(16, 0), false).text, '$5');
});
check('open price → MP, never discounted; no entry → nothing', () => {
  assert.deepStrictEqual(P.priceFor({ price: null, strategy: 'OPEN_PRICE' }, HH, THU(16, 0)), { text: 'MP', mp: true, label: 'Market price' });
  assert.strictEqual(P.priceFor(undefined, HH, THU(16, 0)), null);
  assert.strictEqual(P.priceHtml(null), '');
});
check('banner during happy hour', () => {
  assert.deepStrictEqual(P.banner(HH, THU(16, 0)), { text: 'Happy hour until 6 PM: oysters 50% off', live: true });
});
check('banner the rest of the time; "(not today)" when switched off', () => {
  assert.deepStrictEqual(P.banner(HH, FRI(12, 0)), { text: 'Happy hour Mon–Thu 3–6 PM: oysters 50% off', live: false });
  const off = { ...HH, today: { state: 'off', until: edt(2026, 10, 9, 4, 0) } };
  assert.strictEqual(P.banner(off, THU(12, 0)).text, 'Happy hour Mon–Thu 3–6 PM: oysters 50% off (not today)');
  const on = { ...HH, today: { state: 'on', until: edt(2026, 10, 10, 4, 0) } };
  assert.strictEqual(P.banner(on, FRI(12, 0)).text, 'Happy hour today 3–6 PM: oysters 50% off');
  assert.strictEqual(P.banner(null, THU(16, 0)), null);
});
check('times and days read plainly', () => {
  assert.strictEqual(P.clockRange('15:00', '18:00'), '3–6 PM');
  assert.strictEqual(P.clockRange('11:30', '14:00'), '11:30 AM–2 PM');
  assert.strictEqual(P.clock('12:00'), '12 PM');
  assert.strictEqual(P.dayRange(['MON', 'WED', 'THU', 'SAT']), 'Mon, Wed, Thu, Sat');
  assert.strictEqual(P.dayRange(['THU', 'MON', 'TUE', 'WED']), 'Mon–Thu');
});

console.log(`\n${failed ? 'FAILED: ' + failed + ' of ' + (passed + failed) : 'All ' + passed + ' checks passed.'}`);
process.exit(failed ? 1 : 0);
