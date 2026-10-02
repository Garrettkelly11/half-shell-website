#!/usr/bin/env node
/**
 * Regions — checks for data/regions.js.
 * Read-only: touches no site files and writes nothing to Firebase.
 *
 * Usage (terminal, from the "Oyster Website" folder):
 *   node tools/regions-test.js        # exit 1 on failure
 *
 * Checks:
 *   - every region has the required fields; codes are unique
 *   - every catalog `region` in data/oysters.js exists in HS_REGIONS
 *     (null is allowed and listed)
 *   - the coast lists data/flights.js builds are the same as the lists it
 *     used to hard-code
 *   - abbreviations match the old employee-page labels
 *
 * Requirements: Node 18+. No npm install.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const REGIONS = require('../data/regions.js');
const I = require('../data/flights.js')._internals;

let failed = 0, passed = 0;
function check(label, ok, detail) {
  if (ok) { passed++; console.log('PASS  ' + label); }
  else { failed++; console.log('FAIL  ' + label + (detail ? '\n      ' + detail : '')); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function loadCatalog() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'data', 'oysters.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.OYSTERS || [];
}

// ── Shape ────────────────────────────────────────────────────────────────────
const GROUPS = ['atlantic-north', 'atlantic-south', 'west', null];
const bad = REGIONS.filter(r =>
  !/^[a-z]{2,3}$/.test(r.code) || !r.name || !r.short ||
  !['US', 'CA'].includes(r.country) || !['east', 'west'].includes(r.coast) ||
  !GROUPS.includes(r.group));
check('every region has code, name, short, country, coast, group', !bad.length,
  bad.map(r => r.code).join(', '));

const codes = REGIONS.map(r => r.code);
const dupes = codes.filter((c, i) => codes.indexOf(c) !== i);
check('region codes are unique', !dupes.length, dupes.join(', '));

// ── Catalog ──────────────────────────────────────────────────────────────────
const catalog = loadCatalog();
const missing = [], nulls = [];
catalog.forEach(o => {
  if (o.region === null || o.region === undefined) nulls.push(o.id);
  else if (!codes.includes(o.region)) missing.push(o.id + ' (' + o.region + ')');
});
check('every catalog region exists in HS_REGIONS (' + catalog.length + ' oysters)', !missing.length,
  missing.join(', '));
console.log('INFO  oysters with no region: ' + (nulls.length ? nulls.join(', ') : 'none'));

// ── Flight lists unchanged ───────────────────────────────────────────────────
// The lists data/flights.js hard-coded before regions.js existed.
const OLD = {
  ATLANTIC_NORTH: ['me', 'ma', 'nh', 'ri', 'ct', 'ny', 'nb', 'pei', 'ns'],
  ATLANTIC_SOUTH: ['nc', 'va', 'sc', 'md'],
  ATLANTIC_ALL:   ['me', 'ma', 'nh', 'ri', 'ct', 'ny', 'nb', 'pei', 'ns', 'nc', 'va', 'sc', 'md', 'nj'],
  WEST_COAST:     ['wa', 'bc'],
  HOMETOWN:       ['nc', 'va']
};
Object.keys(OLD).forEach(k => {
  check('flights.js ' + k + ' is unchanged', same(I[k], OLD[k]),
    'now ' + JSON.stringify(I[k]) + ', was ' + JSON.stringify(OLD[k]));
});

// ── Employee page labels unchanged ───────────────────────────────────────────
// The regionLabel map employee.html used before regions.js existed.
const OLD_LABELS = { ct:'CT', ma:'MA', md:'MD', me:'ME', nc:'NC', nj:'NJ', ny:'NY', ri:'RI', va:'VA', wa:'WA', bc:'BC', nb:'NB', pei:'PEI' };
const changed = Object.keys(OLD_LABELS).filter(c => {
  const r = REGIONS.find(x => x.code === c);
  return !r || r.short !== OLD_LABELS[c];
});
check('abbreviations match the old employee-page labels', !changed.length, changed.join(', '));

// ── flights.js refuses to run without regions ────────────────────────────────
(function () {
  const src = fs.readFileSync(path.join(__dirname, '..', 'data', 'flights.js'), 'utf8');
  const sandbox = { window: {} };       // browser-like: no require, no HS_REGIONS
  vm.createContext(sandbox);
  let msg = '';
  try { vm.runInContext(src, sandbox); } catch (e) { msg = e.message; }
  check('flights.js throws a clear error when regions.js is not loaded',
    /HS_REGIONS is missing/.test(msg), 'got: ' + (msg || 'no error'));
})();

console.log('\n' + (failed ? failed + ' of ' + (passed + failed) + ' checks failed.' : 'All ' + passed + ' checks passed.'));
process.exit(failed ? 1 : 0);
