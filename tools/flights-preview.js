#!/usr/bin/env node
/**
 * Recommended Flights — preview & test harness
 *
 * Implements the 8 flight templates from "Recommended Flights Feature Plan.md"
 * and shows exactly which flights would render for a given serving list.
 * Read-only: touches no site files, writes nothing to Firebase.
 *
 * Usage (terminal, from the "Oyster Website" folder):
 *   node tools/flights-preview.js                  # fetch live serving list from Firebase
 *   node tools/flights-preview.js --slugs a,b,c    # test a specific serving list
 *   node tools/flights-preview.js --date 2026-07-28  # pin Shucker's Choice rotation
 *   node tools/flights-preview.js --test           # run invariant self-tests (exit 1 on failure)
 *
 * Requirements: Node 18+ (built-in fetch). No npm install needed.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DATABASE_URL = 'https://half-shell-oyster-menu-default-rtdb.firebaseio.com';
const MAX_FLIGHTS_DISPLAYED = 3;

// ── Load catalog (same vm pattern as sync-toast-to-firebase.js) ──────────────
function loadCatalog() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'data', 'oysters.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.OYSTERS || [];
}

// ── Field parsing (tolerant of catalog wording) ──────────────────────────────
// Salinity rank: low=1, medium=2, medium-high=2.5, high=3. null/unknown → NaN.
function salinityRank(o) {
  const s = String(o.salinity || '').toLowerCase();
  if (s === 'low') return 1;
  if (s === 'medium') return 2;
  if (s === 'medium-high' || s === 'medium high') return 2.5;
  if (s === 'high') return 3;
  return NaN;
}

// Size rank: petite/cocktail/small=1, medium=2, large=3. Uses the largest word
// mentioned ("Medium to large" → 3). Unknown → NaN.
function sizeRank(o) {
  const s = String(o.size || '').toLowerCase();
  if (s.includes('unknown') || !s) return NaN;
  if (s.includes('large') || s.includes('jumbo')) return 3;
  if (s.includes('medium')) return 2;
  if (s.includes('small') || s.includes('cocktail') || s.includes('petite')) return 1;
  return NaN;
}

function isGigas(o)     { return /gigas/i.test(o.species || ''); }
function isVirginica(o) { return /virginica/i.test(o.species || ''); }

const NORTH = new Set(['me', 'ma', 'nh', 'ri', 'ct', 'ny', 'nb', 'pei', 'pe', 'ns', 'bc']);
const SOUTH = new Set(['nc', 'va', 'sc', 'ga', 'fl', 'al', 'ms', 'la', 'tx', 'md']);
const LOCAL = new Set(['nc', 'va']);

// Oysters with research-incomplete data are excluded from matching.
function isKnown(o) {
  return !Number.isNaN(salinityRank(o)) || !Number.isNaN(sizeRank(o));
}

// Deterministic pseudo-random index from a date string (Shucker's Choice seed).
function dateSeed(dateStr) {
  let h = 0;
  for (const c of dateStr) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

const byName = arr => [...arr].sort((a, b) => a.name.localeCompare(b.name));

// ── Templates (priority order = display priority) ────────────────────────────
// Each returns an array of oysters (the flight) or null if it can't fill.
const TEMPLATES = [
  {
    name: 'Brine Ladder',
    blurb: 'Brine is one of the defining traits of an oyster, this flight takes you through three distinct levels of salt.',
    build(av) {
      const tiers = new Map();
      for (const o of av) {
        const r = salinityRank(o);
        if (!Number.isNaN(r) && !tiers.has(r)) tiers.set(r, o);
      }
      if (tiers.size < 3) return null;
      const ranks = [...tiers.keys()].sort((a, b) => a - b);
      return [ranks[0], ranks[Math.floor(ranks.length / 2)], ranks[ranks.length - 1]]
        .filter((r, i, arr) => arr.indexOf(r) === i)
        .map(r => tiers.get(r));
    }
  },
  {
    name: 'Coast to Coast',
    blurb: 'Taste the difference between the East Coast Crassostrea Virginica and the West Coast Crassostrea Gigas.',
    build(av) {
      const east = byName(av.filter(isVirginica));
      const west = byName(av.filter(isGigas));
      if (!east.length || !west.length) return null;
      return [...east.slice(0, 2), ...west.slice(0, 2)].slice(0, 4);
    }
  },
  {
    name: 'First Timer',
    blurb: 'Small, mild, and sweet, these are the perfect start for a future oyster lover.',
    build(av) {
      const picks = byName(av.filter(o =>
        sizeRank(o) === 1 &&
        salinityRank(o) <= 2 &&
        /sweet|mild|clean|first/i.test(o.tastingNotes || '')
      ));
      return picks.length >= 2 ? picks.slice(0, 3) : null;
    }
  },
  {
    name: 'Salt Lover',
    blurb: 'Not all oysters are salt bombs, but these certainly are.',
    build(av) {
      const picks = av.filter(o => salinityRank(o) >= 2.5)
        .sort((a, b) => salinityRank(b) - salinityRank(a) || a.name.localeCompare(b.name));
      return picks.length >= 2 ? picks.slice(0, 3) : null;
    }
  },
  {
    name: 'Hometown Heroes',
    blurb: "Hailing from the waters of the Carolinas and Virginia, it's as local as you'll find in Charlotte.",
    build(av) {
      const picks = byName(av.filter(o => LOCAL.has(String(o.region || '').toLowerCase())));
      return picks.length >= 2 ? picks.slice(0, 3) : null;
    }
  },
  {
    name: 'North vs. South',
    blurb: 'Cold water against warm. How does an oyster\'s environment shape its flavor?',
    build(av) {
      const north = byName(av.filter(o => NORTH.has(String(o.region || '').toLowerCase())));
      const south = byName(av.filter(o => SOUTH.has(String(o.region || '').toLowerCase())));
      if (!north.length || !south.length) return null;
      return [north[0], south[0]];
    }
  },
  {
    name: 'Size Ladder',
    blurb: 'From our smallest to our largest, this flight celebrates the many shapes and sizes of our favorite mollusk.',
    build(av) {
      const tiers = new Map();
      for (const o of av) {
        const r = sizeRank(o);
        if (!Number.isNaN(r) && !tiers.has(r)) tiers.set(r, o);
      }
      if (tiers.size < 3) return null;
      return [...tiers.keys()].sort((a, b) => a - b).map(r => tiers.get(r));
    }
  },
  {
    name: "Shucker's Choice",
    blurb: "A rotating selection of our shucker's favorite oysters of the day.",
    build(av, dateStr) {
      if (av.length < 3) return null;
      const sorted = byName(av);
      const seed = dateSeed(dateStr);
      const picks = [];
      for (let i = 0; i < 3; i++) {
        const idx = (seed + i * 7) % sorted.length;
        if (!picks.includes(sorted[idx])) picks.push(sorted[idx]);
      }
      let j = 0;
      while (picks.length < 3 && j < sorted.length) {
        if (!picks.includes(sorted[j])) picks.push(sorted[j]);
        j++;
      }
      return picks;
    }
  }
];

// ── Selection: priority order, overlap cap, max displayed ────────────────────
function overlapTooHigh(a, b) {
  const setB = new Set(b.map(o => o.id));
  const shared = a.filter(o => setB.has(o.id)).length;
  return shared > Math.min(a.length, b.length) / 2; // "more than half"
}

function selectFlights(available, dateStr) {
  const chosen = [];
  const report = [];
  for (const t of TEMPLATES) {
    if (chosen.length >= MAX_FLIGHTS_DISPLAYED) { report.push([t.name, 'skipped — max flights reached']); continue; }
    const flight = t.build(available, dateStr);
    if (!flight || flight.length < 2) { report.push([t.name, 'hidden — not enough matching oysters']); continue; }
    if (chosen.some(c => overlapTooHigh(flight, c.oysters))) { report.push([t.name, 'skipped — overlaps an already-selected flight']); continue; }
    chosen.push({ name: t.name, blurb: t.blurb, oysters: flight });
    report.push([t.name, `RENDERS (${flight.map(o => o.name).join(', ')})`]);
  }
  return { chosen, report };
}

// ── Serving list ─────────────────────────────────────────────────────────────
async function getServingSlugs(catalog, slugArg) {
  const catalogIds = new Set(catalog.map(o => o.id));
  if (slugArg) {
    return slugArg.split(',').map(s => s.trim()).filter(s => catalogIds.has(s));
  }
  const res = await fetch(`${DATABASE_URL}/menu/serving.json`);
  if (!res.ok) throw new Error(`Firebase read failed (${res.status})`);
  const data = await res.json() || {};
  // Keys that match catalog slugs; numeric-key legacy junk is ignored naturally.
  return Object.keys(data).filter(k => catalogIds.has(k));
}

// ── Self-tests (invariants) ──────────────────────────────────────────────────
function runTests(catalog) {
  const date = '2026-07-28';
  const slugs7 = ['bear-tide', 'fat-bellies', 'fire-lake', 'love-shuck', 'malpeque', 'shigoku', 'sweet-petite'];
  const get = ids => catalog.filter(o => ids.includes(o.id) && isKnown(o));
  let failures = 0;
  const check = (label, ok) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) failures++;
  };

  const r1 = selectFlights(get(slugs7), date);
  check('renders at least 1 flight for a 7-oyster list', r1.chosen.length >= 1);
  check(`renders at most ${MAX_FLIGHTS_DISPLAYED} flights`, r1.chosen.length <= MAX_FLIGHTS_DISPLAYED);
  check('every flight has 2–4 oysters', r1.chosen.every(f => f.oysters.length >= 2 && f.oysters.length <= 4));
  check('no flight contains duplicate oysters', r1.chosen.every(f => new Set(f.oysters.map(o => o.id)).size === f.oysters.length));
  check('overlap cap respected between rendered flights', r1.chosen.every((f, i) =>
    r1.chosen.slice(i + 1).every(g => !overlapTooHigh(f.oysters, g.oysters))));

  const r2 = selectFlights(get(slugs7), date);
  check('deterministic — same list + date gives same flights', JSON.stringify(r1.chosen) === JSON.stringify(r2.chosen));

  const r3 = selectFlights(get(['malpeque']), date);
  check('single available oyster → no flights', r3.chosen.length === 0);
  const r4 = selectFlights([], date);
  check('empty serving list → no flights', r4.chosen.length === 0);

  const unknowns = catalog.filter(o => !isKnown(o));
  const r5 = selectFlights(catalog.filter(isKnown).slice(0, 7).concat(unknowns), date);
  check('unknown-data oysters never appear in a flight', r5.chosen.every(f => f.oysters.every(isKnown)));

  console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const getFlag = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  const catalog = loadCatalog();

  if (args.includes('--test')) return runTests(catalog);

  const dateStr = getFlag('--date') || new Date().toISOString().slice(0, 10);
  const slugs = await getServingSlugs(catalog, getFlag('--slugs'));
  const available = catalog.filter(o => slugs.includes(o.id) && isKnown(o));

  console.log(`Serving list (${slugs.length}): ${slugs.sort().join(', ')}`);
  console.log(`Date seed: ${dateStr}\n`);

  const { chosen, report } = selectFlights(available, dateStr);
  console.log('Template evaluation:');
  for (const [name, status] of report) console.log(`  ${name.padEnd(18)} ${status}`);

  console.log(`\n=== FLIGHTS THAT WOULD RENDER (${chosen.length}) ===`);
  for (const f of chosen) {
    console.log(`\n${f.name}`);
    console.log(`  ${f.oysters.map(o => o.name).join('  |  ')}`);
    console.log(`  "${f.blurb}"`);
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
