#!/usr/bin/env node
/**
 * Oyster Passport — unit tests for src/passport-core.js and data/stamps.js
 * (Oyster Passport Build Sheet section 10). Plain Node, no npm install.
 * Reads the real catalog (data/oysters.js) and regions; writes nothing.
 *
 * Terminal, from the "Oyster Website" folder:
 *   node tools/passport-test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const P = require('../src/passport-core.js');
const S = require('../data/stamps.js');
const REGIONS = require('../data/regions.js');
const F = require('../data/flights.js');

function loadCatalog() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'data', 'oysters.js'), 'utf8') + ';this.OYSTERS = OYSTERS;', sandbox);
  return sandbox.OYSTERS;
}
const OYSTERS = loadCatalog();

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('PASS  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + (e && e.message)); }
}
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < (eps || 1e-9), `${msg || ''} ${a} != ${b}`);

/** UTC ms of a New York wall-clock time. */
function ny(y, m, d, h, min) {
  for (const off of [4, 5]) {
    const ms = Date.UTC(y, m - 1, d, h + off, min || 0);
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms));
    const g = t => Number(p.find(x => x.type === t).value);
    if (g('year') === y && g('month') === m && g('day') === d && g('hour') % 24 === h && g('minute') === (min || 0)) return ms;
  }
  throw new Error(`no such New York time ${y}-${m}-${d} ${h}:${min}`);
}

// ── Fixtures built from the real catalog ────────────────────────────────────
const byId = Object.fromEntries(OYSTERS.map(o => [o.id, o]));
const firstWhere = f => OYSTERS.find(f).id;
const NC = firstWhere(o => o.region === 'nc');
const WEST = firstWhere(o => o.region === 'wa');
const CANADA = firstWhere(o => o.region === 'pei');
const HIGH = firstWhere(o => o.salinity === 'high');
const LOW = firstWhere(o => o.salinity === 'low');
const NOSAL = firstWhere(o => o.salinity === null);
const T0 = ny(2026, 10, 20, 18, 0);

/** Visits from [[oysterId, qty, rating?], ...]: each item in its own visit, a day apart, qty split into ≤ 99. */
function visitsOf(list, opts) {
  const visits = {};
  let n = 0;
  const startDay = (opts && opts.start) || P.OPENING_DAY;
  list.forEach(([id, qty, rating]) => {
    let left = qty;
    while (left > 0) {
      const q = Math.min(99, left); left -= q;
      const item = { qty: q, addedAt: T0 };
      if (rating) item.rating = rating;
      visits['v' + n] = { date: P.addDays(startDay, n), startedAt: T0, lastChangedAt: T0, closedAt: T0,
        closeReason: 'saved', source: 'manual', items: { [id]: item } };
      n++;
    }
  });
  return visits;
}
/** One visit holding many items. */
function oneVisit(itemMap, date) {
  return { v1: { date: date || '2026-10-19', startedAt: T0, lastChangedAt: T0, source: 'manual', items: itemMap } };
}
/** Visits whose measure for `m` comes to exactly n. */
function visitsFor(m, n, region) {
  if (n === 0) return {};
  switch (m) {
    case 'eaten': return visitsOf([[NC, n]]);
    case 'region': return visitsOf([[firstWhere(o => o.region === region), n]]);
    case 'briny': return visitsOf([[HIGH, n]]);
    case 'mild': return visitsOf([[LOW, n]]);
    case 'varieties': return oneVisit(Object.fromEntries(OYSTERS.slice(0, n).map(o => [o.id, { qty: 1, addedAt: T0 }])));
    case 'regions': {
      const codes = P.catalogRegions(OYSTERS, REGIONS).slice(0, n).map(r => r.code);
      return oneVisit(Object.fromEntries(codes.map(c => [firstWhere(o => o.region === c), { qty: 1, addedAt: T0 }])));
    }
    case 'visits': return visitsOf(Array.from({ length: n }, () => [NC, 1]));
    case 'rated': {
      const visits = {};
      for (let i = 0, v = 0; i < n; v++) {
        const it = {};
        for (let j = 0; j < OYSTERS.length && i < n; j++, i++) it[OYSTERS[j].id] = { qty: 1, rating: 4, addedAt: T0 };
        visits['v' + v] = { date: P.addDays(P.OPENING_DAY, v), startedAt: T0, lastChangedAt: T0, source: 'manual', items: it };
      }
      return visits;
    }
  }
  throw new Error('unknown measure ' + m);
}
const ctx = (visits, extra) => Object.assign({ visits, oysters: OYSTERS, regions: REGIONS, dob: '1995-06-14', today: '2026-10-20' }, extra || {});

// ── Ratings (6.3) ──────────────────────────────────────────────────────────
check('aggregate rating: 5★×6 and 2★×1 → 4.13', () => {
  const r = P.aggregateRatings(visitsOf([['a', 6, 5], ['a', 1, 2]]));
  near(Math.round(r.a.rating * 100) / 100, 4.13, 1e-9);
});
check('aggregate rating: 5★×12 and 2★×1 three times → 3.61', () => {
  const r = P.aggregateRatings(visitsOf([['a', 12, 5], ['a', 1, 2], ['a', 1, 2], ['a', 1, 2]]));
  near(Math.round(r.a.rating * 100) / 100, 3.61, 1e-9);
});
check('aggregate rating: 4★×3 → 4.0; unrated visits ignored; none → no entry', () => {
  const r = P.aggregateRatings(visitsOf([['a', 3, 4], ['a', 5], ['b', 2]]));
  assert.strictEqual(P.formatRating(r.a.rating), '4.0');
  assert.strictEqual(r.a.visits, 1);
  assert.strictEqual(r.b, undefined);
  assert.strictEqual(P.formatRating(null), '');
});

// ── Visit lifecycle (6.1) ──────────────────────────────────────────────────
const openState = (items, last) => ({ activeVisitId: 'v1', visits: { v1: { date: '2026-10-20', startedAt: last, lastChangedAt: last, source: 'manual', items } } });
check('timeout: 5h59m stays open; exactly 6h stays open', () => {
  const s = openState({ [NC]: { qty: 2, addedAt: T0 } }, T0);
  assert.strictEqual(P.timeoutUpdates(s, T0 + 5 * 3600e3 + 59 * 60e3), null);
  assert.strictEqual(P.timeoutUpdates(s, T0 + 6 * 3600e3), null);
});
check('timeout: 6h01m closes with closedAt = lastChangedAt + 6h', () => {
  const s = openState({ [NC]: { qty: 2, addedAt: T0 } }, T0);
  assert.deepStrictEqual(P.timeoutUpdates(s, T0 + 6 * 3600e3 + 60e3),
    { 'visits/v1/closedAt': T0 + 6 * 3600e3, 'visits/v1/closeReason': 'timeout', activeVisitId: null });
});
check('timeout: an empty visit is deleted', () => {
  assert.deepStrictEqual(P.timeoutUpdates(openState({}, T0), T0 + 7 * 3600e3), { 'visits/v1': null, activeVisitId: null });
});
check('timeout: activeVisitId pointing at a closed or missing visit is cleared', () => {
  assert.deepStrictEqual(P.timeoutUpdates({ activeVisitId: 'gone', visits: {} }, T0), { activeVisitId: null });
  assert.strictEqual(P.timeoutUpdates({ visits: {} }, T0), null);
});
check('Save Entry closes as saved; empty visit deleted', () => {
  assert.deepStrictEqual(P.saveUpdates(openState({ [NC]: { qty: 1, addedAt: T0 } }, T0), T0 + 60e3),
    { 'visits/v1/closedAt': T0 + 60e3, 'visits/v1/closeReason': 'saved', activeVisitId: null });
  assert.deepStrictEqual(P.saveUpdates(openState({}, T0), T0), { 'visits/v1': null, activeVisitId: null });
  assert.strictEqual(P.saveUpdates({ visits: {} }, T0), null);
});
check('+ with no open visit opens one dated today\'s business day', () => {
  const late = ny(2026, 10, 21, 0, 30);   // 12:30 AM counts as the 20th
  const r = P.addUpdates({ visits: {} }, NC, 1, late, 'new1');
  assert.deepStrictEqual(r.updates, {
    'visits/new1/date': '2026-10-20', 'visits/new1/startedAt': late, 'visits/new1/lastChangedAt': late,
    'visits/new1/source': 'manual', activeVisitId: 'new1',
    ['visits/new1/items/' + NC + '/qty']: 1, ['visits/new1/items/' + NC + '/addedAt']: late,
  });
});
check('stepper: qty stays 1–99; − at 1 removes the item; − with no visit does nothing', () => {
  const s = openState({ [NC]: { qty: 98, addedAt: T0 }, [LOW]: { qty: 1, addedAt: T0 } }, T0);
  assert.strictEqual(P.addUpdates(s, NC, 5, T0 + 1, 'x').qty, 99);
  assert.strictEqual(P.addUpdates(s, NC, 5, T0 + 1, 'x').updates['visits/v1/items/' + NC + '/qty'], 99);
  const r = P.addUpdates(s, LOW, -1, T0 + 1, 'x');
  assert.strictEqual(r.updates['visits/v1/items/' + LOW], null);
  assert.strictEqual(r.updates['visits/v1/lastChangedAt'], T0 + 1);
  assert.deepStrictEqual(P.addUpdates({ visits: {} }, NC, -1, T0, 'x').updates, {});
});
check('Log this flight adds 1 of each, including ones already logged, and records the flight', () => {
  const s = openState({ [NC]: { qty: 2, addedAt: T0 } }, T0);
  const r = P.logFlightUpdates(s, 'hometown-heroes', [NC, LOW], T0 + 5, 'x');
  assert.strictEqual(r.visitId, 'v1');
  assert.strictEqual(r.updates['visits/v1/items/' + NC + '/qty'], 3);
  assert.strictEqual(r.updates['visits/v1/items/' + NC + '/addedAt'], undefined);
  assert.strictEqual(r.updates['visits/v1/items/' + LOW + '/qty'], 1);
  assert.strictEqual(r.updates['visits/v1/items/' + LOW + '/addedAt'], T0 + 5);
  assert.strictEqual(r.updates['visits/v1/flightsLogged/hometown-heroes/' + NC], true);
  assert.strictEqual(r.updates['visits/v1/flightsLogged/hometown-heroes/' + LOW], true);
  const fresh = P.logFlightUpdates({ visits: {} }, 'first-timer', [NC, LOW], T0, 'n1');
  assert.strictEqual(fresh.updates.activeVisitId, 'n1');
  assert.strictEqual(fresh.updates['visits/n1/items/' + LOW + '/qty'], 1);
});
check('past visit: created closed as backdated; never the open visit', () => {
  const u = P.backdatedUpdates('b1', '2026-02-03', { [NC]: 6 }, T0);
  assert.strictEqual(u['visits/b1/closeReason'], 'backdated');
  assert.strictEqual(u['visits/b1/date'], '2026-02-03');
  assert.strictEqual(u['visits/b1/items/' + NC + '/qty'], 6);
  assert.ok(!('activeVisitId' in u));
  assert.ok(P.isVisitDate('2026-02-03', '2026-10-20') && !P.isVisitDate('2026-02-02', '2026-10-20'));
  assert.ok(!P.isVisitDate('2026-10-21', '2026-10-20') && !P.isVisitDate('2026-02-30', '2026-10-20'));
  assert.strictEqual(P.visitOnDate(visitsOf([[NC, 1]]), P.OPENING_DAY), 'v0');
  assert.strictEqual(P.visitOnDate({}, P.OPENING_DAY), null);
});
check('every write path fits the rules (slugs, dates, field names)', () => {
  const s = openState({}, T0);
  const all = Object.assign({},
    P.addUpdates({ visits: {} }, NC, 1, T0, '-Nx1').updates,
    P.logFlightUpdates(s, P.flightSlug("Shucker's Choice"), OYSTERS.slice(0, 3).map(o => o.id), T0, 'y').updates,
    P.backdatedUpdates('-Nb2', '2026-03-01', { [LOW]: 2 }, T0));
  const ok = /^(activeVisitId|visits\/[^/]{1,40}(\/(date|startedAt|lastChangedAt|closedAt|closeReason|source)|\/items\/[a-z0-9-]{1,60}\/(qty|addedAt)|\/flightsLogged\/[a-z0-9-]{1,60}\/[a-z0-9-]{1,60}))$/;
  Object.keys(all).forEach(k => assert.ok(ok.test(k), k));
  OYSTERS.forEach(o => assert.ok(P.isSlug(o.id), o.id));
});
check('flight slugs', () => {
  assert.strictEqual(P.flightSlug("Shucker's Choice"), 'shuckers-choice');
  assert.strictEqual(P.flightSlug('North vs. South'), 'north-vs-south');
  F.POOL.forEach(d => assert.ok(P.isSlug(P.flightSlug(d.name)), d.name));
});
check('here today: dates carried from the day before sign-up', () => {
  assert.deepStrictEqual(P.hereOnCarry(['2026-10-18', '2026-10-19', '2026-10-20', 'junk'], '2026-10-20'), ['2026-10-19', '2026-10-20']);
});

// ── Dates (6.8) ────────────────────────────────────────────────────────────
check('business day: 3:59 AM is the day before, 4:00 AM is today', () => {
  assert.strictEqual(P.businessDay(ny(2026, 10, 20, 3, 59)), '2026-10-19');
  assert.strictEqual(P.businessDay(ny(2026, 10, 20, 4, 0)), '2026-10-20');
  assert.strictEqual(P.businessDay(ny(2026, 10, 20, 23, 59)), '2026-10-20');
  assert.strictEqual(P.nyDate(ny(2026, 10, 21, 0, 30)), '2026-10-21');
});
check('business day across the spring DST change (08/03/2026)', () => {
  assert.strictEqual(P.businessDay(ny(2026, 3, 8, 1, 59)), '2026-03-07');
  assert.strictEqual(P.businessDay(ny(2026, 3, 8, 3, 59)), '2026-03-07');
  assert.strictEqual(P.businessDay(ny(2026, 3, 8, 4, 0)), '2026-03-08');
});
check('business day across the autumn DST change (01/11/2026)', () => {
  const first130 = Date.UTC(2026, 10, 1, 5, 30), second130 = Date.UTC(2026, 10, 1, 6, 30); // 1:30 EDT, 1:30 EST
  assert.strictEqual(P.businessDay(first130), '2026-10-31');
  assert.strictEqual(P.businessDay(second130), '2026-10-31');
  assert.strictEqual(P.businessDay(ny(2026, 11, 1, 3, 59)), '2026-10-31');
  assert.strictEqual(P.businessDay(ny(2026, 11, 1, 4, 0)), '2026-11-01');
});

// ── Age and birthday (6.4) ─────────────────────────────────────────────────
check('age gate: the day before the 18th birthday is blocked; the day of is allowed', () => {
  assert.strictEqual(P.MIN_AGE, 18);
  assert.ok(P.isUnderMinAge('2008-10-21', '2026-10-20'));
  assert.ok(!P.isUnderMinAge('2008-10-21', '2026-10-21'));
  assert.strictEqual(P.age('2008-10-21', '2026-10-21'), 18);
});
check('age with a 29 February birthday', () => {
  assert.strictEqual(P.age('2012-02-29', '2025-02-27'), 12);
  assert.strictEqual(P.age('2012-02-29', '2025-02-28'), 13);   // Feb 28 in non-leap years
  assert.strictEqual(P.age('2012-02-29', '2028-02-28'), 15);
  assert.strictEqual(P.age('2012-02-29', '2028-02-29'), 16);
});
check('21+ for alcohol promotion', () => {
  assert.ok(!P.canShowAlcoholPromo({ dob: '2005-10-21' }, '2026-10-20'));
  assert.ok(P.canShowAlcoholPromo({ dob: '2005-10-20' }, '2026-10-20'));
  assert.ok(!P.canShowAlcoholPromo(null, '2026-10-20'));
});
check('birthday checks at sign-up: real date, 1900 or later, not in the future', () => {
  assert.strictEqual(P.checkDob('1995-06-14', '2026-10-20'), null);
  assert.strictEqual(P.checkDob('2026-02-30', '2026-10-20'), 'format');
  assert.strictEqual(P.checkDob('06/14/1995', '2026-10-20'), 'format');
  assert.strictEqual(P.checkDob('1899-12-31', '2026-10-20'), 'year');
  assert.strictEqual(P.checkDob('2026-10-21', '2026-10-20'), 'future');
});
check('birthday week: mid-year, ±3 days', () => {
  ['2026-06-11', '2026-06-14', '2026-06-17'].forEach(d => assert.ok(P.inBirthdayWeek('1990-06-14', d), d));
  ['2026-06-10', '2026-06-18'].forEach(d => assert.ok(!P.inBirthdayWeek('1990-06-14', d), d));
});
check('birthday week across the new year (Dec 30 for a Jan 1 birthday)', () => {
  assert.ok(P.inBirthdayWeek('1990-01-01', '2026-12-30'));
  assert.ok(P.inBirthdayWeek('1990-12-30', '2027-01-02'));
  assert.ok(!P.inBirthdayWeek('1990-01-01', '2026-12-28'));
});
check('birthday week for 29 February in a non-leap year uses Feb 28', () => {
  assert.ok(P.inBirthdayWeek('1992-02-29', '2026-02-25'));
  assert.ok(P.inBirthdayWeek('1992-02-29', '2026-03-03'));
  assert.ok(!P.inBirthdayWeek('1992-02-29', '2026-03-04'));
});

// ── Field checks ───────────────────────────────────────────────────────────
check('two words: "briny, buttery" ok; "very briny finish" refused; hyphens count once', () => {
  assert.ok(P.validTwoWords('briny, buttery'));
  assert.ok(!P.validTwoWords('very briny finish'));
  assert.ok(P.validTwoWords('salty-sweet finish'));
  assert.ok(!P.validTwoWords('x'.repeat(41)));
  assert.strictEqual(P.wordCount('  briny,  buttery '), 2);
  assert.strictEqual(P.limitTwoWords('very briny f'), 'very briny ');
  assert.strictEqual(P.limitTwoWords('very briny'), 'very briny');
});
check('card digits: exactly 4 digits and a known brand', () => {
  assert.ok(P.validCard({ last4: '0123', brand: 'VISA' }));
  assert.ok(!P.validCard({ last4: '123', brand: 'VISA' }));
  assert.ok(!P.validCard({ last4: '12a4', brand: 'VISA' }));
  assert.ok(!P.validCard({ last4: '1234', brand: 'visa' }));
  assert.deepStrictEqual(P.CARD_BRANDS.map(b => b.code), ['VISA', 'MASTERCARD', 'AMEX', 'DISCOVER', 'OTHER']);
  assert.strictEqual(P.brandLabel('AMEX'), 'Amex');
});
check('name, email and note limits match the rules', () => {
  assert.ok(P.validName(' Garrett ') && !P.validName('   ') && !P.validName('x'.repeat(61)) && P.validName('x'.repeat(60)));
  assert.ok(P.validEmail('g@example.com') && !P.validEmail('not an email') && !P.validEmail('a@b'));
  assert.ok(P.validNote('x'.repeat(280)) && !P.validNote('x'.repeat(281)));
  assert.ok(P.validQty(1) && P.validQty(99) && !P.validQty(0) && !P.validQty(100) && !P.validQty(1.5));
});

// ── Stamps (6.5) ───────────────────────────────────────────────────────────
const defs = P.stampDefs(OYSTERS, REGIONS);
check('region stamps: one per region in the catalog, nothing else', () => {
  const catalogCodes = [...new Set(OYSTERS.map(o => o.region).filter(Boolean))].sort();
  const stampCodes = defs.filter(d => d.kind === 'region').map(d => d.region).sort();
  assert.deepStrictEqual(stampCodes, catalogCodes);
  assert.strictEqual(stampCodes.length, 14);
});
check('stamp ids fit the rules (≤ 60 chars, slug)', () => {
  defs.forEach(d => assert.ok(/^[a-z0-9-]{1,60}$/.test(d.id), d.id));
  assert.strictEqual(new Set(defs.map(d => d.id)).size, defs.length);
});
check('thresholds match the Build Sheet table (6.5)', () => {
  const want = { volume: [12, 60, 300, 1500], variety: [5, 15, 30, 'all'], atlas: [3, 6, 10, 'all'],
    regular: [3, 10, 25, 50], critic: [10, 50, 150, 500], 'salt-lover': [6, 24, 72, 200], 'sweet-tooth': [6, 24, 72, 200] };
  assert.deepStrictEqual(Object.fromEntries(S.LADDERS.map(l => [l.id, l.thresholds])), want);
  assert.deepStrictEqual(S.REGION.thresholds, [1, 12, 36, 100]);
  assert.deepStrictEqual(S.SINGLES.map(x => x.id),
    ['first-slurp', 'coast-to-coast', 'home-waters', 'passport-stamp', 'flight-crew', 'birthday-shuck']);
  assert.deepStrictEqual(S.TIER_COLORS, { bronze: '#9a6a3a', silver: '#8a9aa3', gold: '#c8962e', pearl: ['#e8e4f0', '#cfe3e6', '#f3e6d8'] });
});
check('Variety and Atlas Pearl = the whole current catalog', () => {
  assert.strictEqual(defs.find(d => d.id === 'variety').thresholds[3], OYSTERS.length);
  assert.strictEqual(defs.find(d => d.id === 'atlas').thresholds[3], 14);
});
defs.filter(d => d.kind !== 'single').forEach(d => {
  check(`${d.id}: each tier at threshold − 1 and at threshold`, () => {
    d.thresholds.forEach((t, i) => {
      [t - 1, t].forEach(n => {
        const e = P.evaluateStamps(ctx(visitsFor(d.measure, n, d.region)))[d.id];
        assert.strictEqual(e.value, n, `value for ${n}`);
        const want = n >= t ? S.TIERS[i] : (i ? S.TIERS[i - 1] : null);
        assert.strictEqual(e.tier, want, `tier at ${n}`);
      });
    });
  });
});
check('next tier and progress ("24 / 36 to Gold")', () => {
  const e = P.evaluateStamps(ctx(visitsOf([[NC, 24]])))['region-nc'];
  assert.strictEqual(e.tier, 'silver');
  assert.deepStrictEqual(e.next, { tier: 'gold', at: 36 });
  const top = P.evaluateStamps(ctx(visitsOf([[NC, 100]])))['region-nc'];
  assert.strictEqual(top.next, null);
});
check('single stamps: First Slurp, Home Waters, Passport Stamp, Coast to Coast', () => {
  const none = P.evaluateStamps(ctx({}));
  ['first-slurp', 'home-waters', 'passport-stamp', 'coast-to-coast'].forEach(id => assert.strictEqual(none[id].tier, null, id));
  const nc = P.evaluateStamps(ctx(visitsOf([[NC, 1]])));
  assert.strictEqual(nc['first-slurp'].tier, 'single');
  assert.strictEqual(nc['home-waters'].tier, 'single');
  assert.strictEqual(nc['coast-to-coast'].tier, null);
  const both = P.evaluateStamps(ctx(visitsOf([[NC, 1], [WEST, 1], [CANADA, 1]])));
  assert.strictEqual(both['coast-to-coast'].tier, 'single');
  assert.strictEqual(both['passport-stamp'].tier, 'single');
});
check('Birthday Shuck: a visit in that year\'s birthday week', () => {
  assert.strictEqual(P.evaluateStamps(ctx(visitsOf([[NC, 1]], { start: '2026-06-16' })))['birthday-shuck'].tier, 'single');
  assert.strictEqual(P.evaluateStamps(ctx(visitsOf([[NC, 1]], { start: '2026-06-18' })))['birthday-shuck'].tier, null);
  assert.strictEqual(P.evaluateStamps(ctx(visitsOf([[NC, 1]], { start: '2026-06-16' }), { dob: null }))['birthday-shuck'].tier, null);
});
check('Flight Crew: a visit holding a logged flight, or today\'s flight', () => {
  const v = oneVisit({ [NC]: { qty: 1, addedAt: T0 }, [LOW]: { qty: 2, addedAt: T0 } });
  v.v1.flightsLogged = { 'first-timer': { [NC]: true, [LOW]: true } };
  assert.strictEqual(P.evaluateStamps(ctx(v))['flight-crew'].tier, 'single');
  delete v.v1.items[LOW];
  assert.strictEqual(P.evaluateStamps(ctx(v))['flight-crew'].tier, null);
  const today = oneVisit({ [NC]: { qty: 1, addedAt: T0 }, [HIGH]: { qty: 1, addedAt: T0 } }, '2026-10-20');
  assert.strictEqual(P.evaluateStamps(ctx(today, { todayFlights: [[NC, HIGH]] }))['flight-crew'].tier, 'single');
  assert.strictEqual(P.evaluateStamps(ctx(today, { todayFlights: [[NC, HIGH, LOW]] }))['flight-crew'].tier, null);
  today.v1.date = '2026-10-19';
  assert.strictEqual(P.evaluateStamps(ctx(today, { todayFlights: [[NC, HIGH]] }))['flight-crew'].tier, null);
});
check('retired oysters count toward Volume, Regular and Critic only', () => {
  const m = P.measures(visitsOf([['retired-oyster', 12, 4]]), OYSTERS, REGIONS);
  assert.deepStrictEqual([m.eaten, m.visits, m.rated, m.varieties, m.regions, m.briny, m.mild], [12, 1, 1, 0, 0, 0, 0]);
  assert.strictEqual(m.allVarieties, 1);
  const e = P.evaluateStamps(ctx(visitsOf([['retired-oyster', 12, 4]])));
  assert.strictEqual(e.volume.tier, 'bronze');
  assert.strictEqual(e['first-slurp'].tier, 'single');
});
check('an oyster with no salinity counts toward everything but Salt Lover and Sweet Tooth', () => {
  const o = byId[NOSAL];
  const m = P.measures(visitsOf([[NOSAL, 6]]), OYSTERS, REGIONS);
  assert.deepStrictEqual([m.eaten, m.varieties, m.regions, m.byRegion[o.region], m.briny, m.mild], [6, 1, 1, 6, 0, 0]);
});
check('Regular counts days: two visits on one date are one', () => {
  const v = visitsOf([[NC, 1], [LOW, 1]]);
  v.v1.date = v.v0.date;
  assert.strictEqual(P.measures(v, OYSTERS, REGIONS).visits, 1);
});
check('stamp writes: new tiers with seen: false and every tier passed', () => {
  const e = P.evaluateStamps(ctx(visitsOf([[NC, 12]])));
  const u = P.stampUpdates({}, e, 1000);
  assert.strictEqual(u['stamps/region-nc/tier'], 'silver');
  assert.strictEqual(u['stamps/region-nc/seen'], false);
  assert.strictEqual(u['stamps/region-nc/tierEarnedAt/bronze'], 1000);
  assert.strictEqual(u['stamps/region-nc/tierEarnedAt/silver'], 1000);
  assert.strictEqual(u['stamps/volume/tier'], 'bronze');
  assert.strictEqual(u['stamps/first-slurp/tierEarnedAt/single'], 1000);
  assert.strictEqual(u['stamps/variety/tier'], undefined);
  Object.keys(u).forEach(k => assert.ok(/^stamps\/[a-z0-9-]{1,60}\/(tier|seen|tierEarnedAt\/(single|bronze|silver|gold|pearl))$/.test(k), k));
});
check('tiers never go backwards: deleting logs writes nothing and keeps the shown tier', () => {
  const stored = { 'region-nc': { tier: 'silver', seen: true, tierEarnedAt: { bronze: 1, silver: 1 } } };
  const e = P.evaluateStamps(ctx(visitsOf([[NC, 2]])));
  assert.strictEqual(e['region-nc'].tier, 'bronze');
  assert.ok(!Object.keys(P.stampUpdates(stored, e, 5)).some(k => k.startsWith('stamps/region-nc/')));
  assert.strictEqual(P.shownTier(stored['region-nc'], e['region-nc']), 'silver');
  assert.strictEqual(P.shownTier(stored['region-nc'], P.evaluateStamps(ctx({}))['region-nc']), 'silver');
});
check('catalog growth does not revoke a Pearl', () => {
  const stored = { variety: { tier: 'pearl', seen: true, tierEarnedAt: { pearl: 1 } } };
  const bigger = OYSTERS.concat([{ id: 'new-oyster', region: 'nc', salinity: 'low' }]);
  const e = P.evaluateStamps(Object.assign(ctx(visitsFor('varieties', OYSTERS.length)), { oysters: bigger })).variety;
  assert.strictEqual(e.tier, 'gold');
  assert.strictEqual(P.shownTier(stored.variety, e), 'pearl');
});
check('an upgrade writes only the new tier and asks for a new celebration', () => {
  const stored = { 'region-nc': { tier: 'silver', seen: true, tierEarnedAt: { bronze: 1, silver: 2 } } };
  const u = P.stampUpdates(stored, P.evaluateStamps(ctx(visitsOf([[NC, 36]]))), 9);
  assert.strictEqual(u['stamps/region-nc/tier'], 'gold');
  assert.strictEqual(u['stamps/region-nc/seen'], false);
  assert.strictEqual(u['stamps/region-nc/tierEarnedAt/gold'], 9);
  assert.strictEqual(u['stamps/region-nc/tierEarnedAt/silver'], undefined);
});
check('celebration queue oldest first; recent stamps newest first', () => {
  const stored = {
    a: { tier: 'bronze', seen: false, tierEarnedAt: { bronze: 30 } },
    b: { tier: 'single', seen: false, tierEarnedAt: { single: 10 } },
    c: { tier: 'gold', seen: true, tierEarnedAt: { bronze: 1, silver: 2, gold: 50 } },
    d: { tier: 'silver', seen: true, tierEarnedAt: { bronze: 5, silver: 20 } },
  };
  assert.deepStrictEqual(P.unseenStamps(stored), ['b', 'a']);
  assert.deepStrictEqual(P.recentStamps(stored, 3), ['c', 'a', 'd']);
});
check('celebration lines', () => {
  const nc = defs.find(d => d.id === 'region-nc');
  assert.strictEqual(P.stampLine(nc, 1), '1 oyster from North Carolina');
  assert.strictEqual(P.stampLine(nc, 12), '12 oysters from North Carolina');
  assert.strictEqual(P.stampLine(defs.find(d => d.id === 'atlas'), 3), 'Oysters from 3 regions');
  assert.strictEqual(P.stampLine(defs.find(d => d.id === 'first-slurp'), 1), 'Your first oyster');
});

// ── Palate and recommendations (6.6, 6.7) on a fixed fixture ───────────────
const FIX = [
  { id: 'a', salinity: 'high', region: 'ma', size: 'Medium — 3"' },
  { id: 'b', salinity: 'high', region: 'ma', size: 'Medium' },
  { id: 'c', salinity: 'low', region: 'wa', size: 'Small' },
  { id: 'd', salinity: 'low', region: 'wa', size: 'Small; deep cup' },
  { id: 'e', salinity: 'medium', region: 'nc', size: 'Large' },
  { id: 'x', salinity: 'high', region: 'ma', size: 'Medium' },
  { id: 'y', salinity: 'low', region: 'wa', size: 'Petite' },
  { id: 'z', salinity: null, region: 'ma', size: 'Unknown' },
];
const fixVisits = visitsOf([['a', 1, 5], ['b', 2, 5], ['c', 1, 1], ['d', 1, 2], ['e', 3, 3]]);
const fixAgg = P.aggregateRatings(fixVisits);
check('palate locked below 5 rated, with how many to go', () => {
  const p = P.palate(P.aggregateRatings(visitsOf([['a', 1, 5], ['b', 1, 4], ['c', 1, 3]])), FIX, REGIONS);
  assert.deepStrictEqual(p, { unlocked: false, toGo: 2 });
});
check('palate: salinity, coast, size and region, each with its basis', () => {
  const p = P.palate(fixAgg, FIX, REGIONS);
  assert.strictEqual(p.unlocked, true);
  assert.deepStrictEqual(p.salinity, { band: 4, lean: 'briny', text: 'You lean briny', basis: 5 });
  assert.strictEqual(p.coast.lean, 'east');
  assert.strictEqual(p.coast.basis, 5);
  assert.deepStrictEqual(p.size, { rank: 2, text: 'You lean medium', basis: 5 });
  assert.strictEqual(p.region.code, 'ma');
  assert.strictEqual(p.region.basis, 2);
});
check('palate size reads the size text the way Curated Flights does', () => {
  // "Very small — ... large meat" is small (only the words before " — " count).
  const fix = [
    { id: 'p', salinity: 'low', region: 'ma', size: 'Very small — deep cup, large meat' },
    { id: 'q', salinity: 'low', region: 'ma', size: 'Small' },
    { id: 'r', salinity: 'high', region: 'wa', size: 'Large' },
    { id: 's', salinity: 'high', region: 'wa', size: 'Jumbo' },
    { id: 't', salinity: 'medium', region: 'nc', size: 'Medium' },
  ];
  assert.strictEqual(F._internals.sizeRank(fix[0]), 1);
  const agg = P.aggregateRatings(visitsOf([['p', 1, 5], ['q', 1, 5], ['r', 1, 1], ['s', 1, 2], ['t', 1, 3]]));
  assert.strictEqual(P.palate(agg, fix, REGIONS).size.text, 'You lean small');
});
check('similarity: same oyster 1; salinity unknown drops that term', () => {
  const R = o => ({ sal: F._internals.salinityRank(o), size: F._internals.sizeRank(o), region: o.region });
  near(P.similarity(R(FIX[0]), R(FIX[5])), 1);
  near(P.similarity(R(FIX[0]), R(FIX[2])), 0.125);
  near(P.similarity(R(FIX[7]), R(FIX[0])), 0.3 / 0.3);           // same region; salinity and size unknown
});
check('You might like: untried, on tonight\'s menu, score > 0.3, top 2, with the reason', () => {
  const r = P.recommendations(fixAgg, fixVisits, ['y', 'x', 'a', 'z', 'not-in-catalog'], FIX, REGIONS);
  // z has only a region on file, so its salinity and size terms drop out (score 2).
  assert.deepStrictEqual(r.map(x => x.id), ['z', 'x']);
  near(r[1].score, 1.45, 1e-9, 'x score');
  assert.strictEqual(r[1].because, 'a');
  assert.ok(!r.some(x => x.id === 'y' || x.id === 'a'));
  assert.strictEqual(P.recommendations(P.aggregateRatings(visitsOf([['a', 1, 5]])), {}, ['x'], FIX, REGIONS), null);
});

console.log(failed ? `\n${failed} of ${passed + failed} checks failed.` : `\nAll ${passed} checks passed.`);
process.exit(failed ? 1 : 0);
