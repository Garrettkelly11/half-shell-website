#!/usr/bin/env node
/**
 * Library page builder.
 *
 * Writes "Oyster Overview.html" (the Half Shell Library) from:
 *   data/oysters.js              the catalog (all oyster facts)
 *   data/regions.js              region names for the filter chips
 *   tools/library-template.html  layout, styles, filters and scripts
 *
 * Never edit "Oyster Overview.html" by hand: fix facts in data/oysters.js,
 * layout in tools/library-template.html, then run this script. A GitHub
 * Action (.github/workflows/build-library.yml) runs it whenever one of
 * those changes on main, so the page also rebuilds after Merroir
 * publishes the catalog. The Oyster Master List is no longer generated
 * (Garrett, 05/10/2026, Merroir spec v1.8): the library page has the same
 * names.
 *
 * Usage (terminal, from the "Oyster Website" folder):
 *   node tools/build-library.js
 *   node tools/build-library.js --check     # exit 1 if the page is out of date; writes nothing
 *
 * Requirements: Node 18+. No npm install.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'Oyster Overview.html');
const TEMPLATE = path.join(__dirname, 'library-template.html');

function loadCatalog() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'data', 'oysters.js'), 'utf8'), sandbox);
  if (!Array.isArray(sandbox.OYSTERS)) throw new Error('data/oysters.js: OYSTERS not found');
  return sandbox.OYSTERS;
}
const REGIONS = require(path.join(ROOT, 'data', 'regions.js'));

function esc(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function text(v) { return v === null || v === undefined || v === '' ? 'Unknown' : String(v); }
const byName = (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });

// Size filter bucket, read from the size words before the first " — " or ";"
// ("Very small — ... large meat" is small, not large):
// small/cocktail/petite with medium -> small-medium; large/jumbo -> large;
// medium -> medium; small/cocktail/petite -> small; otherwise unknown ('').
function sizeBucket(size) {
  const s = String(size || '').toLowerCase().split(/\s+—\s+|;/)[0];
  if (!s || /unknown|not documented|undocumented/.test(s)) return '';
  const small = /small|cocktail|petite/.test(s), med = /medium/.test(s), large = /large|jumbo/.test(s);
  if (small && med) return 'small-medium';
  if (large) return 'large';
  if (med) return 'medium';
  if (small) return 'small';
  return '';
}

// "Crassostrea virginica (Eastern oyster)" -> "<em>Crassostrea virginica</em> (Eastern oyster)"
function speciesHtml(species) {
  const s = text(species);
  const m = s.match(/^((?:Crassostrea|Ostrea|Magallana)\s+[a-z]+)(.*)$/);
  return m ? '<em>' + esc(m[1]) + '</em>' + esc(m[2]) : esc(s);
}
// Quick Reference: "Crassostrea virginica (...)" -> "<em>C. virginica</em>"
function speciesShort(species) {
  const m = String(species || '').match(/^(Crassostrea|Ostrea|Magallana)\s+([a-z]+)/);
  return m ? '<em>' + m[1][0] + '. ' + esc(m[2]) + '</em>' : esc(text(species));
}

function regionOf(o) { return REGIONS.find(r => r.code === o.region) || null; }

function article(o) {
  const r = regionOf(o);
  const search = [o.name, o.id.replace(/-/g, ' ')].concat(o.aliases || [])
    .concat(r ? [r.code, r.name] : []).join(' ').toLowerCase();
  const attrs = [];
  if (o.salinity) attrs.push('data-salinity="' + esc(o.salinity) + '"');
  attrs.push('data-size="' + sizeBucket(o.size) + '"');
  attrs.push('data-region="' + esc(o.region || '') + '"');
  const li = (label, html) => '        <li><span class="field-label">' + label + '</span> ' + html + '</li>';
  return [
    '    <article class="oyster" id="' + esc(o.id) + '"',
    '      ' + attrs.join(' '),
    '      data-search="' + esc(search) + '">',
    '      <h2>' + esc(o.name) + '</h2>',
    '      <ul>',
    li('Origin', esc(text(o.origin))),
    li('Farmer', esc(text(o.farmer))),
    li('Species', speciesHtml(o.species)),
    li('Farming Method', esc(text(o.farmingMethod))),
    li('Grow-Out', esc(text(o.growOut))),
    li('Seasonal Availability', esc(text(o.seasonalAvailability))),
    li('Size', esc(text(o.size))),
    li('Shell', esc(text(o.shell))),
    li('Tasting Notes', esc(text(o.tastingNotes))),
    '      </ul>',
    '      <div class="notable">',
    '        <span class="notable-label">Notable</span>',
    '        ' + esc(text(o.notable)),
    '      </div>',
    '    </article>'
  ].join('\n');
}

function build() {
  const oysters = loadCatalog().slice().sort(byName);
  const ids = new Set();
  oysters.forEach(o => {
    if (!o.id || ids.has(o.id)) throw new Error('missing or duplicate id: ' + o.id);
    ids.add(o.id);
    if (o.region && !regionOf(o)) throw new Error(o.id + ': region "' + o.region + '" is not in data/regions.js');
  });

  const used = new Set(oysters.map(o => o.region).filter(Boolean));
  const chips = REGIONS.filter(r => used.has(r.code))
    .map(r => '        <span class="chip" data-value="' + esc(r.code) + '" title="' + esc(r.name) + '">' + esc(r.short) + '</span>');
  const nav = oysters.map(o =>
    '      <li data-target="' + esc(o.id) + '"><a href="#' + esc(o.id) + '">' + esc(o.name) + '</a></li>');
  const articles = oysters.map(article).join('\n\n');
  const rows = oysters.map(o =>
    '          <tr><td><a href="#' + esc(o.id) + '">' + esc(o.name) + '</a></td><td>' + esc(text(o.origin)) +
    '</td><td>' + speciesShort(o.species) + '</td><td>' + esc(text(o.salinityText)) + '</td><td>' + esc(text(o.size)) + '</td></tr>');

  let html = fs.readFileSync(TEMPLATE, 'utf8');
  const put = (marker, value) => {
    const tag = '<!-- @@' + marker + '@@ -->';
    const at = html.indexOf(tag);
    if (at < 0 || html.indexOf(tag, at + 1) >= 0) throw new Error('template: marker ' + marker + ' missing or repeated');
    // Replace the marker and its own indentation with the generated block.
    const lineStart = html.lastIndexOf('\n', at) + 1;
    html = html.slice(0, lineStart) + value + html.slice(at + tag.length);
  };
  put('GENERATED_NOTICE', '<!-- Generated by tools/build-library.js from data/oysters.js and data/regions.js. Do not edit by hand: change the catalog or tools/library-template.html, then run: node tools/build-library.js -->');
  put('REGION_CHIPS', chips.join('\n'));
  put('NAV_LINKS', nav.join('\n'));
  put('ARTICLES', articles);
  put('QUICK_REF_ROWS', rows.join('\n'));
  if (html.includes('@@')) throw new Error('template: unreplaced marker');
  return { html, oysters };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const { html, oysters } = build();
  if (args.includes('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (current !== html) { console.log('Oyster Overview.html is out of date. Run: node tools/build-library.js'); process.exit(1); }
    console.log('Oyster Overview.html is up to date (' + oysters.length + ' oysters).');
    process.exit(0);
  }
  fs.writeFileSync(OUT, html);
  console.log('Wrote Oyster Overview.html: ' + oysters.length + ' oysters.');
}

module.exports = { build, sizeBucket };
