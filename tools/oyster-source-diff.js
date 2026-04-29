#!/usr/bin/env node
/**
 * Oyster source diff — compare three views of the catalog:
 *   1. data/oysters.js as committed at HEAD (the previous working state)
 *   2. data/oysters.js in the working tree (what would be committed now)
 *   3. The inline `const OYSTERS = [...]` array in index.html
 *
 * Output: per-source oyster id list + symmetric diff between each pair, so we
 * can scrutinize the uncommitted data/oysters.js change AND see what the
 * consolidation between index.html and data/oysters.js needs to handle.
 *
 * Usage (from Oyster Website folder):
 *   node tools/oyster-source-diff.js
 *
 * No npm install needed. Uses git via child_process to read the HEAD version.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

function loadOystersJs(code) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return Array.isArray(sandbox.OYSTERS) ? sandbox.OYSTERS : [];
}

function loadIndexInline(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  // Extract the `const OYSTERS = [ ... ];` block. Match from the keyword
  // through the matching close bracket / semicolon.
  const start = html.indexOf('const OYSTERS = [');
  if (start === -1) throw new Error('Could not find `const OYSTERS = [` in index.html');
  // Walk forward counting brackets to find the matching close.
  let depth = 0;
  let i = start + 'const OYSTERS = '.length;
  for (; i < html.length; i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']') { depth--; if (depth === 0) { i++; break; } }
  }
  // Build a fragment that the vm sandbox can evaluate.
  const fragment = `var OYSTERS = ${html.slice(start + 'const OYSTERS = '.length, i)};`;
  return loadOystersJs(fragment);
}

const root = path.join(__dirname, '..');

// 1. HEAD version of data/oysters.js
let headArr = [];
try {
  const headCode = execSync('git show HEAD:data/oysters.js', { cwd: root, encoding: 'utf8' });
  headArr = loadOystersJs(headCode);
} catch (err) {
  console.error('Could not load HEAD version of data/oysters.js:', err.message);
}

// 2. Working-tree version of data/oysters.js
const wtCode = fs.readFileSync(path.join(root, 'data', 'oysters.js'), 'utf8');
const wtArr = loadOystersJs(wtCode);

// 3. Inline OYSTERS in index.html
const idxArr = loadIndexInline(path.join(root, 'index.html'));

// Build id sets
const headIds = new Set(headArr.map((o) => o.id));
const wtIds = new Set(wtArr.map((o) => o.id));
const idxIds = new Set(idxArr.map((o) => o.id));

function diff(aSet, bSet, label) {
  const onlyA = [...aSet].filter((id) => !bSet.has(id)).sort();
  const onlyB = [...bSet].filter((id) => !aSet.has(id)).sort();
  console.log(`\n--- ${label} ---`);
  console.log(`  ${aSet.size} ↔ ${bSet.size}`);
  console.log(`  Only in left  (${onlyA.length}): ${onlyA.join(', ') || '(none)'}`);
  console.log(`  Only in right (${onlyB.length}): ${onlyB.join(', ') || '(none)'}`);
}

console.log('=== Oyster source counts ===');
console.log(`  data/oysters.js @ HEAD:           ${headArr.length} entries`);
console.log(`  data/oysters.js (working tree):   ${wtArr.length} entries`);
console.log(`  index.html inline OYSTERS array:  ${idxArr.length} entries`);

console.log('\n=== Symmetric id diffs ===');
diff(headIds, wtIds, 'data/oysters.js  HEAD → working tree (uncommitted change)');
diff(wtIds, idxIds, 'data/oysters.js (working tree) ↔ index.html inline');

// Field-level comparison for oysters present in both data/oysters.js (working
// tree) and index.html — flags fields where the values disagree, so the
// consolidation isn't accidentally dropping or rewriting data.
const wtById = new Map(wtArr.map((o) => [o.id, o]));
const idxById = new Map(idxArr.map((o) => [o.id, o]));
const sharedIds = [...wtIds].filter((id) => idxIds.has(id)).sort();

console.log(`\n=== Field-level disagreements between data/oysters.js and index.html (${sharedIds.length} shared oysters) ===`);
const fieldsToCompare = ['name', 'salinity', 'salinityText', 'origin', 'tastingNotes', 'photoUrl', 'price'];
let conflicts = 0;
for (const id of sharedIds) {
  const wt = wtById.get(id);
  const idx = idxById.get(id);
  for (const field of fieldsToCompare) {
    if (wt[field] !== idx[field]) {
      console.log(`  ${id}.${field}:`);
      console.log(`    data/oysters.js  =  ${JSON.stringify(wt[field])}`);
      console.log(`    index.html       =  ${JSON.stringify(idx[field])}`);
      conflicts++;
    }
  }
}
if (!conflicts) console.log('  (no disagreements on shared fields — clean migration possible)');
