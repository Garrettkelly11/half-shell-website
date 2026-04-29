#!/usr/bin/env node
/**
 * One-shot catalog consolidation.
 *
 * Merges the punchy `tastingNotes` from index.html's inline `OYSTERS` array
 * into `data/oysters.js`, applies the catalog renames previously decided
 * (Mama Mia → Momma Mia, plurals, etc.), adds the Le Petit alias, and
 * rewrites `data/oysters.js` in place. Then index.html can drop its inline
 * array and source from `data/oysters.js` directly via a `<script>` tag.
 *
 * Run once, review the resulting `git diff data/oysters.js`, then commit.
 *
 * Usage (from Oyster Website folder):
 *   node tools/consolidate-catalog.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const dataPath = path.join(root, 'data', 'oysters.js');
const idxPath = path.join(root, 'index.html');

// ---- Load both sources -----------------------------------------------------
function loadOystersFromCode(code) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return Array.isArray(sandbox.OYSTERS) ? sandbox.OYSTERS : [];
}

const dataOysters = loadOystersFromCode(fs.readFileSync(dataPath, 'utf8'));

const idxHtml = fs.readFileSync(idxPath, 'utf8');
const idxStart = idxHtml.indexOf('const OYSTERS = [');
if (idxStart === -1) throw new Error('Could not locate `const OYSTERS = [` in index.html');
let depth = 0;
let i = idxStart + 'const OYSTERS = '.length;
for (; i < idxHtml.length; i++) {
  if (idxHtml[i] === '[') depth++;
  else if (idxHtml[i] === ']') { depth--; if (depth === 0) { i++; break; } }
}
const idxFragment = `var OYSTERS = ${idxHtml.slice(idxStart + 'const OYSTERS = '.length, i)};`;
const idxOysters = loadOystersFromCode(idxFragment);

// ---- Slug aliases: index.html slug → canonical data/oysters.js slug --------
// These exist because index.html accumulated legacy slug variants over time.
// Used only here to decide which catalog entry should pick up each index.html
// tastingNotes value.
const SLUG_ALIASES = {
  'beausoleil':       'beau-soleil',
  'blue-point':       'blue-point-ct',
  'ct-blue-points':   'blue-point-ct',
  'divine-pine':      'divine-pines',
  'irish-points':     'irish-point',
  'katama-ma':        'katama',
  'momma-mia':        'mama-mia',
  'southern-salts':   'southern-salt',
  'ts-virginica':     'taylor-virginica',
};

// Slugs to drop entirely (no catalog equivalent, not coming back via Toast today).
const DROP_FROM_INDEX = new Set(['fat-bellies']);

// ---- Renames + aliases (Garrett's calls) -----------------------------------
const NAME_RENAMES = {
  'mama-mia':            'Momma Mia',
  'fat-bastard':         'Fat Bastards',
  'masonboro-pearl':     'Masonboro Pearls',
  'wellfleet':           'Wellfleets',
  'savage-blonde':       'Savage Blondes',
  'olde-salt':           'Olde Salts',
  'blackberry':          'Blackberries',
  'ta':                  'TNA',
  'blue-point-ct':       'Blue Point CT',
  'le-petite-barachois': 'Le Petit Barachois',
};
const ALIASES_TO_ADD = {
  'le-petite-barachois': ['Le Petit'],
};

// ---- Build map: data-id → tastingNotes from index.html ---------------------
// Last-write-wins for aliased duplicates; skip empty / TBD-flavored values.
const idxTastingByDataId = new Map();
for (const o of idxOysters) {
  if (!o || !o.id) continue;
  if (DROP_FROM_INDEX.has(o.id)) continue;
  const dataId = SLUG_ALIASES[o.id] || o.id;
  if (o.tastingNotes && typeof o.tastingNotes === 'string' && o.tastingNotes.trim()) {
    idxTastingByDataId.set(dataId, o.tastingNotes);
  }
}

// ---- Apply transforms ------------------------------------------------------
let renameCount = 0;
let aliasCount = 0;
let portCount = 0;

const merged = dataOysters.map((entry) => {
  const out = { ...entry };

  if (NAME_RENAMES[out.id]) {
    if (out.name !== NAME_RENAMES[out.id]) {
      out.name = NAME_RENAMES[out.id];
      renameCount++;
    }
  }
  if (ALIASES_TO_ADD[out.id]) {
    out.aliases = ALIASES_TO_ADD[out.id];
    aliasCount++;
  }
  if (idxTastingByDataId.has(out.id)) {
    const idxNotes = idxTastingByDataId.get(out.id);
    if (idxNotes !== out.tastingNotes) {
      out.tastingNotes = idxNotes;
      portCount++;
    }
  }
  return out;
});

// ---- Serialize back to JS --------------------------------------------------
// Preserve a stable field order so diffs are reviewable. Fields not in the
// preferred list keep their natural insertion order at the end.
const PREFERRED_ORDER = [
  'id', 'name', 'aliases',
  'salinity', 'salinityText', 'region',
  'origin', 'farmer', 'farmerUrl',
  'species', 'farmingMethod', 'growOut', 'seasonalAvailability',
  'size', 'shell',
  'tastingNotes', 'notable',
  'photoUrl', 'photoAlt',
  'price',
];

function orderedEntries(obj) {
  const seen = new Set();
  const out = [];
  for (const k of PREFERRED_ORDER) {
    if (k in obj) { out.push([k, obj[k]]); seen.add(k); }
  }
  for (const [k, v] of Object.entries(obj)) {
    if (!seen.has(k)) out.push([k, v]);
  }
  return out;
}

function jsValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return '[' + v.map(jsValue).join(', ') + ']';
  // Should not be reached for catalog entries; fall back to JSON.
  return JSON.stringify(v);
}

function serializeEntry(entry) {
  const lines = orderedEntries(entry).map(([k, v]) => `    ${k}: ${jsValue(v)}`);
  return '  {\n' + lines.join(',\n') + '\n  }';
}

const output = 'var OYSTERS = [\n' +
  merged.map(serializeEntry).join(',\n') +
  '\n];\n';

fs.writeFileSync(dataPath, output);

console.log(`Wrote ${merged.length} oysters to data/oysters.js`);
console.log(`  Renames applied:        ${renameCount}`);
console.log(`  Aliases added:          ${aliasCount}`);
console.log(`  tastingNotes ported:    ${portCount}`);
console.log(`  index.html-only dropped: ${[...DROP_FROM_INDEX].join(', ') || '(none)'}`);
