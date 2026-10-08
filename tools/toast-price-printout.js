#!/usr/bin/env node
/**
 * Toast price printout (Data Ownership Build Guide S5, step 1).
 *
 * Read-only. Fetches the Toast menu and stock list and prints, for every
 * catalog oyster Toast sells (86'd or not): the Toast item, its price,
 * pricingStrategy, time-specific pricing rules (happy hour) and modifier
 * groups, next to the catalog's price. It flags what step 2 needs to know
 * before any price sync is written:
 *   - no happy-hour rule (Monday–Thursday 3–6 PM, half off), or a different one
 *   - a happy-hour price that isn't half the regular price
 *   - Toast's regular price differs from the catalog price
 *   - the same oyster at more than one price (several menus or items)
 *   - a strategy other than BASE / MENU_SPECIFIC / TIME_SPECIFIC
 *   - catalog oysters Toast doesn't have, and Raw Bar items no oyster matches
 *
 * Matching is the Toast sync's (tools/sync-toast-to-firebase.js): the GUID
 * table in functions/toast-mapping.js first, then the oyster's id, name and
 * aliases, letters and digits only, with simple plurals.
 *
 * Usage (terminal, from the "Oyster Website" folder):
 *   node tools/toast-price-printout.js                  # asks Toast (needs .env)
 *   node tools/toast-price-printout.js --dump tools/toast-api-explorer-dump.json
 *   node tools/toast-price-printout.js --out "..\Toast Price Printout.md"
 * Writes the printout to ../Toast Price Printout.md (outside the repo) by
 * default and a short summary to the terminal. Never prints credentials.
 * Requirements: Node 18+. No npm install.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const argVal = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const DUMP = argVal('--dump');
const OUT = argVal('--out') || path.join(ROOT, '..', 'Toast Price Printout.md');

// The happy hour Garrett set up in Toast (02/10/2026): every oyster half
// off, Monday–Thursday 3–6 PM.
const HAPPY_DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY'];
const HAPPY_START = '15:00', HAPPY_END = '18:00';

// ─── Catalog and matching (as the sync does it) ─────────────────────────────
function loadCatalog() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'data', 'oysters.js'), 'utf8'), sandbox);
  return sandbox.OYSTERS || [];
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function* matchKeysFor(entry) {
  const sources = [entry.id, entry.name, ...(Array.isArray(entry.aliases) ? entry.aliases : [])];
  for (const source of sources) {
    if (!source) continue;
    const base = normalize(source);
    if (!base) continue;
    yield base;
    if (base.endsWith('s')) yield base.slice(0, -1); else yield base + 's';
    if (base.endsWith('ies')) yield base.slice(0, -3) + 'y';
    if (base.endsWith('y')) yield base.slice(0, -1) + 'ies';
  }
}

function buildMatcher(catalog) {
  const index = new Map();
  for (const entry of catalog) for (const key of matchKeysFor(entry)) if (!index.has(key)) index.set(key, entry.id);
  let guidToSlug = {};
  try { guidToSlug = require(path.join(ROOT, 'functions', 'toast-mapping.js')).guidToSlug || {}; } catch (_) {}
  return item => (item.guid && guidToSlug[item.guid]) || index.get(normalize(item.name)) || null;
}

// ─── Toast (read-only GETs) ─────────────────────────────────────────────────
function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) throw new Error(`${envPath} not found (Toast credentials).`);
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["'](.*)["']$/, '$1');
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fromToast() {
  loadEnv(path.join(ROOT, '.env'));
  const host = process.env.TOAST_API_HOSTNAME || 'https://ws-api.toasttab.com';
  for (const k of ['TOAST_CLIENT_ID', 'TOAST_CLIENT_SECRET', 'TOAST_LOCATION_ID']) {
    if (!process.env[k]) throw new Error(`${k} missing from .env`);
  }
  const step = (what, p) => p.catch(e => { e.message = `${what} (${host}): ${e.message}`; throw e; });
  const login = await step('Toast login', fetch(`${host}/authentication/v1/authentication/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: process.env.TOAST_CLIENT_ID, clientSecret: process.env.TOAST_CLIENT_SECRET,
      userAccessType: process.env.TOAST_USER_ACCESS_TYPE || 'TOAST_MACHINE_CLIENT',
    }),
  }));
  if (!login.ok) throw new Error(`Toast login failed: ${login.status}`);
  const body = await login.json();
  const token = body?.token?.accessToken || body?.accessToken;
  if (!token) throw new Error('Unexpected Toast login response.');
  const headers = { 'Authorization': `Bearer ${token}`, 'Toast-Restaurant-External-ID': process.env.TOAST_LOCATION_ID };
  await sleep(1100);
  let menus;
  for (let tries = 0; tries < 3; tries++) {
    const r = await step('Toast menu', fetch(`${host}/menus/v2/menus`, { headers }));
    if (r.status === 409) { await sleep(2000); continue; }
    if (!r.ok) throw new Error(`Menu fetch failed: ${r.status}`);
    menus = await r.json();
    break;
  }
  if (!menus) throw new Error('Menu kept changing during the fetch (409). Try again.');
  await sleep(1100);
  const s = await step('Toast stock', fetch(`${host}/stock/v1/inventory`, { headers }));
  const stock = s.ok ? await s.json() : null;
  return { menus, stock, source: `Toast API, ${new Date().toISOString()}` };
}

function fromDump(file) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const menus = d['/menus/v2/menus'];
  if (!menus || !menus.menus) throw new Error(`${file} has no /menus/v2/menus.`);
  return { menus, stock: d['/stock/v1/inventory'] || null,
    source: `saved dump ${path.basename(file)} (menu last updated ${menus.lastUpdated || '?'})` };
}

// ─── Reading the menu ───────────────────────────────────────────────────────
function* walk(menus) {
  for (const menu of menus.menus || []) {
    const stack = (menu.menuGroups || []).map(g => [g, [g.name]]);
    while (stack.length) {
      const [g, trail] = stack.shift();
      for (const item of g.menuItems || []) yield { item, menu: menu.name, group: trail.join(' › ') };
      for (const sub of g.menuGroups || []) stack.push([sub, trail.concat(sub.name)]);
    }
  }
}

const money = v => (v === null || v === undefined) ? '—' : '$' + Number(v).toFixed(2);

function timeRules(item) {
  const rules = (item.pricingRules && item.pricingRules.timeSpecificPricingRules) || [];
  return rules.map(r => ({
    price: r.timeSpecificPrice, base: r.basePrice,
    schedule: (r.schedule || []).map(s => ({ days: s.days || [], ranges: (s.timeRanges || []).map(t => `${t.start}–${t.end}`) })),
  }));
}

function describeRules(rules) {
  if (!rules.length) return '—';
  return rules.map(r => `${money(r.price)} ` + r.schedule.map(s =>
    `${s.days.map(d => d.slice(0, 3)).join('/')} ${s.ranges.join(', ')}`).join('; ')).join(' | ');
}

function isHappyHour(rule) {
  return rule.schedule.some(s => HAPPY_DAYS.every(d => s.days.includes(d))
    && s.ranges.includes(`${HAPPY_START}–${HAPPY_END}`));
}

function modifierNames(item, refs) {
  return (item.modifierGroupReferences || []).map(id => (refs && refs[id] && refs[id].name) || `#${id}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────
(async () => {
  const catalog = loadCatalog();
  const bySlug = Object.fromEntries(catalog.map(o => [o.id, o]));
  const match = buildMatcher(catalog);
  const { menus, stock, source } = DUMP ? fromDump(DUMP) : await fromToast();
  const out86 = new Set((Array.isArray(stock) ? stock : []).filter(r => r.status === 'OUT_OF_STOCK').map(r => r.guid));

  const seen = {};            // slug -> [appearances]
  const unmatchedRaw = [];
  for (const { item, menu, group } of walk(menus)) {
    if (!item || !item.name) continue;
    const slug = match(item);
    if (!slug) {
      if (/raw bar/i.test(group)) unmatchedRaw.push({ name: item.name, price: item.price, group });
      continue;
    }
    (seen[slug] = seen[slug] || []).push({
      name: item.name, guid: item.guid, menu, group, price: item.price ?? null,
      strategy: item.pricingStrategy || '?', rules: timeRules(item),
      mods: modifierNames(item, menus.modifierGroupReferences), out: out86.has(item.guid),
    });
  }

  const rows = [], flags = [], noHappy = [];
  const flag = (slug, text) => flags.push({ slug, text });
  for (const slug of Object.keys(seen).sort()) {
    const apps = seen[slug];
    const cat = bySlug[slug];
    const prices = new Set(apps.map(a => a.price));
    if (prices.size > 1) flag(slug, `sold at more than one price in Toast: ${[...prices].map(money).join(', ')}`);
    for (const a of apps) {
      const notes = [];
      if (!['BASE_PRICE', 'MENU_SPECIFIC_PRICE', 'TIME_SPECIFIC_PRICE'].includes(a.strategy)) {
        notes.push(`strategy ${a.strategy}`);
        flag(slug, `${a.name}: pricing strategy ${a.strategy} (${a.strategy === 'SIZE_PRICE' ? 'no single price; sizes' : a.strategy === 'OPEN_PRICE' ? 'price set at order time' : 'unexpected'})`);
      }
      const hh = a.rules.find(isHappyHour);
      if (!hh) {
        notes.push('no happy hour');
        noHappy.push(`${a.name}` + (a.rules.length ? ` (has: ${describeRules(a.rules)})` : ''));
      } else {
        const half = Math.round(a.price * 50) / 100;   // half, to the cent
        if (a.price !== null && Math.abs(hh.price - a.price / 2) > 0.006) {   // more than rounding
          notes.push('happy hour not half');
          flag(slug, `${a.name}: happy hour ${money(hh.price)}, half of ${money(a.price)} is ${money(a.price / 2)}`);
        } else if (a.price !== null && Math.round(a.price * 100) % 2 === 1) {
          notes.push('odd cents');
          flag(slug, `${a.name}: ${money(a.price)} halves to an odd half-cent; Toast charges ${money(hh.price)} (check a ticket; ${money(half)} if rounded)`);
        }
        if (hh.base !== undefined && hh.base !== null && a.price !== null && Math.abs(hh.base - a.price) > 0.001) {
          flag(slug, `${a.name}: rule's base price ${money(hh.base)} differs from the item price ${money(a.price)}`);
        }
      }
      if (cat && cat.price !== null && cat.price !== undefined && a.price !== null && Math.abs(cat.price - a.price) > 0.001) {
        notes.push('catalog differs');
        flag(slug, `${a.name}: Toast ${money(a.price)}, catalog ${money(cat.price)}`);
      }
      rows.push({ slug, cat, a, notes });
    }
  }
  const missing = catalog.filter(o => !seen[o.id]);

  // ── Printout ──
  const L = [];
  L.push('# Toast price printout');
  L.push('');
  L.push(`Source: ${source}. Catalog: data/oysters.js (${catalog.length} oysters). Data Ownership Build Guide S5 step 1; read-only.`);
  L.push('');
  L.push(`Matched ${Object.keys(seen).length} catalog oysters in Toast (${rows.length} Toast item${rows.length === 1 ? '' : 's'}); ` +
    `${rows.filter(r => r.a.out).length} 86'd right now. Happy hour expected: Mon–Thu ${HAPPY_START}–${HAPPY_END}, half off.`);
  L.push('');
  L.push('## To look at');
  L.push('');
  if (noHappy.length && noHappy.length === rows.length) {
    L.push(`- **Happy hour**: none of the ${rows.length} oyster items has a Mon–Thu 3–6 PM time-specific price in Toast's menu. ` +
      'If happy hour is set up in Toast as a discount or promotion instead, the menu API doesn\'t show it, and the site can\'t read it from there.');
  } else if (noHappy.length) {
    L.push(`- **Happy hour missing** on ${noHappy.length} of ${rows.length} oyster items: ${noHappy.join(', ')}`);
  }
  if (!flags.length && !noHappy.length) L.push('Nothing: every matched oyster has the happy hour at half price and matches the catalog.');
  for (const f of flags) L.push(`- **${bySlug[f.slug] ? bySlug[f.slug].name : f.slug}**: ${f.text}`);
  L.push('');
  L.push('## Every matched oyster');
  L.push('');
  L.push('| Oyster | Toast item | Menu › group | 86\'d | Toast price | Strategy | Time-specific prices | Modifier groups | Catalog price | Notes |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  const cell = s => String(s).replace(/\|/g, '\\|');
  for (const r of rows) {
    L.push(`| ${cell(r.cat ? r.cat.name : r.slug)} | ${cell(r.a.name)} | ${cell(r.a.menu + ' › ' + r.a.group)} | ${r.a.out ? 'yes' : ''} | ` +
      `${money(r.a.price)} | ${r.a.strategy} | ${cell(describeRules(r.a.rules))} | ${cell(r.a.mods.join(', ') || '—')} | ` +
      `${money(r.cat && r.cat.price)} | ${r.notes.join('; ')} |`);
  }
  L.push('');
  L.push(`## Catalog oysters not found in Toast (${missing.length})`);
  L.push('');
  L.push(missing.length ? missing.map(o => `- ${o.name} (${o.id})`).join('\n') : 'None.');
  L.push('');
  L.push(`## Raw Bar items no catalog oyster matches (${unmatchedRaw.length})`);
  L.push('');
  L.push(unmatchedRaw.length ? unmatchedRaw.map(u => `- ${u.name} (${money(u.price)}; ${u.group})`).join('\n') : 'None.');
  L.push('');
  fs.writeFileSync(OUT, L.join('\n'));

  const strategies = {};
  for (const r of rows) strategies[r.a.strategy] = (strategies[r.a.strategy] || 0) + 1;
  console.log(`Source: ${source}`);
  console.log(`Matched ${Object.keys(seen).length} oysters (${rows.length} Toast items). Strategies: ` +
    Object.entries(strategies).map(([k, v]) => `${k} ${v}`).join(', '));
  console.log(`Items without the happy hour rule: ${noHappy.length} of ${rows.length}. Other flags: ${flags.length}. Catalog oysters not in Toast: ${missing.length}. Unmatched Raw Bar items: ${unmatchedRaw.length}.`);
  console.log(`Wrote ${OUT}`);
})().catch(e => {
  // Node's fetch says only "fetch failed"; the reason is in e.cause
  // (no credentials in it).
  const c = e.cause;
  console.error('ERROR: ' + e.message + (c ? ` — ${c.code || ''} ${c.message || ''}`.trimEnd() : ''));
  if (c && c.cause) console.error('       ' + (c.cause.code || '') + ' ' + (c.cause.message || ''));
  process.exit(1);
});
