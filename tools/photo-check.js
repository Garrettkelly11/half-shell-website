#!/usr/bin/env node
/**
 * Oyster photos — check (and optionally fill) photoUrl in data/oysters.js.
 * Replaces tools/generate_photo_map.js, which wrote a PHOTO_MAP into the
 * HTML pages. Photos now live on the catalog entry (photoUrl).
 *
 * Usage (terminal, from the "Oyster Website" folder):
 *   node tools/photo-check.js          # report; exit 1 if a photoUrl points to a missing file
 *   node tools/photo-check.js --fill   # also set photoUrl for oysters that have none,
 *                                      # when assets/oysters/ has a file named after the id
 *                                      # (case-insensitive, any extension)
 *
 * GitHub Pages is case-sensitive: "Malpeque.jpg" and "malpeque.jpg" are
 * different files. The check compares exact names.
 *
 * Requirements: Node 18+. No npm install.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CATALOG = path.join(ROOT, 'data', 'oysters.js');
const DIR = 'assets/oysters';
const fill = process.argv.includes('--fill');

function loadCatalog(src) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.OYSTERS || [];
}

let src = fs.readFileSync(CATALOG, 'utf8');
const oysters = loadCatalog(src);
const files = fs.readdirSync(path.join(ROOT, DIR), { withFileTypes: true })
  .filter(d => d.isFile()).map(d => d.name).sort();
const fileSet = new Set(files);

// photoUrl pointing at a file that doesn't exist (exact case)
const broken = oysters.filter(o => o.photoUrl &&
  !(o.photoUrl.startsWith(DIR + '/') && fileSet.has(o.photoUrl.slice(DIR.length + 1))));

// Fill: oysters with no photo and a file whose name (minus extension) equals the id
const filled = [];
if (fill) {
  oysters.filter(o => !o.photoUrl).forEach(o => {
    const match = files.filter(f => f.replace(/\.[^.]+$/, '').toLowerCase() === o.id);
    if (match.length !== 1) return;
    const start = src.indexOf(`    id: "${o.id}",`);
    const end = src.indexOf('\n  }', start);
    const block = src.slice(start, end);
    if (start < 0 || (block.match(/photoUrl: null,/g) || []).length !== 1) return;
    const url = DIR + '/' + match[0];
    src = src.slice(0, start) + block.replace('photoUrl: null,', 'photoUrl: ' + JSON.stringify(url) + ',') + src.slice(end);
    o.photoUrl = url;
    filled.push(o.id + ' -> ' + url);
  });
  if (filled.length) {
    loadCatalog(src); // throws if the edit broke the file
    fs.writeFileSync(CATALOG, src);
  }
}

const used = new Set(oysters.filter(o => o.photoUrl).map(o => o.photoUrl.slice(DIR.length + 1)));
const unused = files.filter(f => !used.has(f));
const none = oysters.filter(o => !o.photoUrl).map(o => o.id);

console.log(oysters.length + ' oysters, ' + (oysters.length - none.length) + ' with a photo, ' + files.length + ' files in ' + DIR);
if (fill) console.log('Filled: ' + (filled.length ? '\n  ' + filled.join('\n  ') : 'none'));
console.log('No photo: ' + (none.join(', ') || 'none'));
console.log('Files not used by any oyster: ' + (unused.join(', ') || 'none'));
if (broken.length) {
  console.log('MISSING FILES (photoUrl points to a file that does not exist):');
  broken.forEach(o => console.log('  ' + o.id + ': ' + o.photoUrl));
  process.exit(1);
}
console.log('All photoUrl paths exist.');
