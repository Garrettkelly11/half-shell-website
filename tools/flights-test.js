#!/usr/bin/env node
/**
 * Curated Flights — test and preview harness.
 * Loads the same data/flights.js the website uses. Read-only: touches no site
 * files and writes nothing to Firebase.
 *
 * Usage (terminal, from the "Oyster Website" folder):
 *   node tools/flights-test.js --test                 # invariant tests, exit 1 on failure
 *   node tools/flights-test.js --sim                  # exposure simulation over random 6-oyster menus
 *   node tools/flights-test.js --slugs a,b,c          # flights for a specific serving list
 *   node tools/flights-test.js                        # flights for the live Firebase serving list
 *   add --date 2026-09-30 to pin the rotation date
 *
 * Requirements: Node 18+ (built-in fetch). No npm install.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../data/flights.js');
const I = F._internals;

const DATABASE_URL = 'https://half-shell-oyster-menu-default-rtdb.firebaseio.com';

function loadCatalog() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'data', 'oysters.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.OYSTERS || [];
}

// Seeded RNG so test and simulation runs repeat exactly.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
function sampleMenu(pool, n, rnd) {
  const a = pool.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}
function randomDate(rnd) {
  const d = new Date(Date.UTC(2026, 0, 1) + Math.floor(rnd() * 365) * 864e5);
  return d.toISOString().slice(0, 10);
}
const reg = o => String(o.region || '').toLowerCase();
const ids = f => f.oysters.map(o => o.id);

// ── Tests ────────────────────────────────────────────────────────────────────
function runTests(catalog) {
  let failures = 0, total = 0;
  const check = (label, ok, detail) => {
    total++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? '  -> ' + detail : ''}`);
    if (!ok) failures++;
  };
  const known = catalog.filter(I.isKnown);
  const rnd = makeRng(20260930);
  const N = 5000;
  const bad = {};
  const note = (k, d) => { if (!bad[k]) bad[k] = d; };
  const sizeRule = f => f.name === 'First Timer' ? [2, 3] : [3, 4];
  const def = name => F.POOL.find(p => p.name === name);

  for (let t = 0; t < N; t++) {
    const menu = sampleMenu(known, 6, rnd);
    const date = randomDate(rnd);
    const flights = F.selectFlights(menu, date);
    const tag = `${date} [${menu.map(o => o.id).join(',')}]`;

    if (flights.length < 1 || flights.length > 2) note('count', tag);
    flights.forEach(f => {
      const [lo, hi] = sizeRule(f);
      if (f.oysters.length < lo || f.oysters.length > hi) note('size', tag + ' ' + f.name);
      if (new Set(ids(f)).size !== f.oysters.length) note('dupes', tag + ' ' + f.name);
      if (!f.oysters.every(o => menu.includes(o))) note('notServed', tag + ' ' + f.name);
      if (!f.description) note('desc', f.name);
      if (f.name === 'North vs. South') {
        const n = f.oysters.filter(o => I.ATLANTIC_NORTH.includes(reg(o))).length;
        const s = f.oysters.filter(o => I.ATLANTIC_SOUTH.includes(reg(o))).length;
        if (n !== 2 || s !== 2) note('nvs', tag);
        if (f.oysters.some(o => I.WEST_COAST.includes(reg(o)))) note('nvsWest', tag);
      }
      if (f.name === 'Coast to Coast') {
        const e = f.oysters.filter(o => I.ATLANTIC_ALL.includes(reg(o))).length;
        const w = f.oysters.filter(o => I.WEST_COAST.includes(reg(o))).length;
        if (!e || !w || e + w !== f.oysters.length) note('c2c', tag);
      }
      if (f.name === 'Brine Ladder') {
        const r = f.oysters.map(I.salinityRank);
        if (!(r[0] < r[1] && r[1] < r[2])) note('brine', tag + ' ' + r);
      }
      if (f.name === 'Size Ladder') {
        const r = f.oysters.map(I.sizeRank);
        if (r.join() !== '1,2,3') note('sizeLadder', tag + ' ' + r);
      }
      if (f.name === 'Hometown Heroes' && !f.oysters.every(o => I.HOMETOWN.includes(reg(o)))) note('hometown', tag);
      if (f.name === 'First Timer' && !f.oysters.every(o => I.sizeRank(o) === 1 && I.salinityRank(o) <= 2)) note('firstTimer', tag);
      if (f.name === 'Salt Lover' && !f.oysters.every(o => I.salinityRank(o) >= 3)) note('saltLover', tag);
    });
    for (let i = 0; i < flights.length; i++)
      for (let j = i + 1; j < flights.length; j++)
        if (I.overlapTooHigh(flights[i].oysters, flights[j].oysters)) note('overlap', tag);

    // Same inputs, same output — including when the menu arrives in a different order.
    const again = F.selectFlights(menu.slice().reverse(), date);
    if (JSON.stringify(flights.map(f => [f.name, ids(f)])) !== JSON.stringify(again.map(f => [f.name, ids(f)]))) note('determinism', tag);

    // Shucker's Choice only when nothing else qualifies.
    if (flights.length === 1 && flights[0].name === "Shucker's Choice") {
      const others = F.POOL.filter(d => !d.fallback).some(d => {
        const av = menu.filter(I.isKnown);
        const out = d.build(av.slice().sort((a, b) => a.id < b.id ? -1 : 1), date + '|' + d.name);
        return out && out.length >= d.min;
      });
      if (others) note('fallback', tag);
    }
  }
  const labels = {
    count: 'every 6-oyster menu shows 1 or 2 flights',
    size: 'flight sizes: 3–4 oysters (First Timer 2–3)',
    dupes: 'no flight contains the same oyster twice',
    notServed: 'flights only use oysters that are being served',
    desc: 'every flight has a description',
    nvs: 'North vs. South is always 2 northern + 2 southern',
    nvsWest: 'North vs. South never includes a West Coast oyster',
    c2c: 'Coast to Coast has Atlantic and West Coast oysters only, at least one of each',
    brine: 'Brine Ladder runs least to most salty (strictly increasing)',
    sizeLadder: 'Size Ladder runs small, medium, large',
    hometown: 'Hometown Heroes is NC/VA only',
    firstTimer: 'First Timer is small size, low-to-medium salinity',
    saltLover: 'Salt Lover is medium-high salinity or above',
    overlap: 'no two shown flights share more than half their oysters',
    determinism: 'same menu and date give the same flights, in any menu order',
    fallback: "Shucker's Choice appears only when no other flight qualifies"
  };
  Object.keys(labels).forEach(k => check(`${labels[k]}  (${N} random menus)`, !bad[k], bad[k]));

  // Edge cases
  check('empty serving list gives no flights', F.selectFlights([], '2026-09-30').length === 0);
  check('two oysters gives no flights', F.selectFlights(known.slice(0, 2), '2026-09-30').length === 0);
  const unknowns = catalog.filter(o => !I.isKnown(o));
  const mixed = F.selectFlights(known.slice(0, 6).concat(unknowns), '2026-09-30');
  check('oysters with no salinity or size data never appear in a flight',
    mixed.every(f => f.oysters.every(I.isKnown)), unknowns.map(o => o.id).join());
  check('duplicate entries in the serving list are ignored',
    JSON.stringify(F.selectFlights(known.slice(0, 6).concat(known.slice(0, 6)), '2026-09-30').map(f => ids(f))) ===
    JSON.stringify(F.selectFlights(known.slice(0, 6), '2026-09-30').map(f => ids(f))));
  check('rotation changes across dates for the same menu', (() => {
    const menu = known.slice(0, 6); const seen = new Set();
    for (let d = 1; d <= 28; d++) seen.add(JSON.stringify(F.selectFlights(menu, `2026-03-${String(d).padStart(2, '0')}`).map(f => f.name)));
    return seen.size > 1;
  })());

  // Descriptions match what Garrett approved
  check('Coast to Coast description says "the west" and "the east"',
    /the west/.test(def('Coast to Coast').description) && /the east/.test(def('Coast to Coast').description) &&
    !/Washington|carolinas/i.test(def('Coast to Coast').description.replace(/Carolinas and Virginia/, '')));
  check('First Timer description no longer says "small"', !/small/i.test(def('First Timer').description));

  // Rotation date: America/New_York, rolls over at midnight Eastern (EDT and EST)
  const rd = s => F.rotationDate(new Date(s));
  check('rotation date: 11:59 p.m. EDT is still the old day', rd('2026-10-01T03:59:00Z') === '2026-09-30');
  check('rotation date: 12:01 a.m. EDT is the new day', rd('2026-10-01T04:01:00Z') === '2026-10-01');
  check('rotation date: 8 p.m. EDT (midnight UTC) does not roll over', rd('2026-10-01T00:30:00Z') === '2026-09-30');
  check('rotation date: 11:59 p.m. EST is still the old day', rd('2026-12-01T04:59:00Z') === '2026-11-30');
  check('rotation date: 12:01 a.m. EST is the new day', rd('2026-12-01T05:01:00Z') === '2026-12-01');

  console.log(failures === 0 ? `\nAll ${total} checks passed.` : `\n${failures} of ${total} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

// ── Simulation ───────────────────────────────────────────────────────────────
function runSim(catalog) {
  const known = catalog.filter(I.isKnown);
  const rnd = makeRng(12345);
  const N = 30000;
  const names = F.POOL.map(p => p.name);
  const shown = {}, qual = {};
  names.forEach(n => { shown[n] = 0; qual[n] = 0; });
  let two = 0, one = 0, none = 0;
  for (let t = 0; t < N; t++) {
    const menu = sampleMenu(known, 6, rnd);
    const date = randomDate(rnd);
    const flights = F.selectFlights(menu, date);
    flights.forEach(f => shown[f.name]++);
    flights.length === 2 ? two++ : flights.length === 1 ? one++ : none++;
    const av = menu.slice().sort((a, b) => a.id < b.id ? -1 : 1);
    F.POOL.filter(d => !d.fallback).forEach(d => {
      const out = d.build(av, date + '|' + d.name);
      if (out && out.length >= d.min) qual[d.name]++;
    });
  }
  console.log(`${N} random 6-oyster menus drawn evenly from ${known.length} oysters with usable data.\n`);
  console.log('Flight'.padEnd(18) + 'Qualifies'.padStart(10) + 'Shown'.padStart(9) + 'Shown|qualified'.padStart(17));
  names.filter(n => n !== "Shucker's Choice").forEach(n => {
    console.log(n.padEnd(18) + (100 * qual[n] / N).toFixed(1).padStart(9) + '%' + (100 * shown[n] / N).toFixed(1).padStart(8) + '%' +
      (qual[n] ? (100 * shown[n] / qual[n]).toFixed(0) : '-').padStart(16) + '%');
  });
  console.log(`\nShucker's Choice fallback shown on ${(100 * shown["Shucker's Choice"] / N).toFixed(1)}% of nights.`);
  console.log(`Nights with 2 flights: ${(100 * two / N).toFixed(1)}%   1 flight: ${(100 * one / N).toFixed(1)}%   none: ${(100 * none / N).toFixed(1)}%`);
}

// ── Preview for a specific / live serving list ───────────────────────────────
async function preview(catalog, args) {
  const getFlag = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  const catalogIds = new Set(catalog.map(o => o.id));
  let slugs;
  if (getFlag('--slugs')) {
    slugs = getFlag('--slugs').split(',').map(s => s.trim()).filter(s => catalogIds.has(s));
  } else {
    const res = await fetch(`${DATABASE_URL}/menu/serving.json`);
    if (!res.ok) throw new Error(`Firebase read failed (${res.status})`);
    slugs = Object.keys((await res.json()) || {}).filter(k => catalogIds.has(k));
  }
  const date = getFlag('--date') || F.rotationDate(new Date());
  const served = catalog.filter(o => slugs.includes(o.id));
  console.log(`Serving (${served.length}): ${served.map(o => o.id).sort().join(', ')}`);
  console.log(`Rotation date: ${date}\n`);
  const flights = F.selectFlights(served, date);
  if (!flights.length) console.log('No flight qualifies. The page would show its empty state.');
  flights.forEach(f => {
    console.log(f.name);
    console.log('  ' + f.oysters.map(o => o.name).join('  |  '));
    console.log('  "' + f.description + '"\n');
  });
}

const args = process.argv.slice(2);
const catalog = loadCatalog();
if (args.includes('--test')) runTests(catalog);
else if (args.includes('--sim')) runSim(catalog);
else preview(catalog, args).catch(err => { console.error(err.message); process.exit(1); });
