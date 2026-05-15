#!/usr/bin/env node
/**
 * Toast API Explorer — Half Shell comprehensive probe
 *
 * Systematically hits every known Toast API endpoint across the Menu, Config,
 * Stock, Restaurant, and Partner surfaces. For each endpoint it records the
 * HTTP status, response shape, and a human-readable summary so you can see
 * exactly what data is available and how it's structured.
 *
 * Usage (from the "Oyster Website" folder):
 *   node tools/toast-api-explorer.js
 *
 * Output:
 *   - Console: live status of each probe + summaries
 *   - tools/toast-api-explorer-dump.json  — full raw responses for every 200
 *   - tools/toast-api-explorer-report.txt — plain-text report you can share
 *
 * Requirements: Node 18+ (built-in fetch). No npm install needed.
 */

const fs   = require('fs');
const path = require('path');

// ─── .env loader ────────────────────────────────────────────────────────────
function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) { console.error(`ERROR: ${envPath} not found.`); process.exit(1); }
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.trim().match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["'](.*)["']$/, '$1');
  }
}
loadEnv(path.join(__dirname, '..', '.env'));

const HOST     = process.env.TOAST_API_HOSTNAME   || 'https://ws-api.toasttab.com';
const CLIENT_ID     = process.env.TOAST_CLIENT_ID;
const CLIENT_SECRET = process.env.TOAST_CLIENT_SECRET;
const USER_ACCESS   = process.env.TOAST_USER_ACCESS_TYPE || 'TOAST_MACHINE_CLIENT';
const LOC_ID        = process.env.TOAST_LOCATION_ID;

for (const [k, v] of Object.entries({ TOAST_CLIENT_ID: CLIENT_ID, TOAST_CLIENT_SECRET: CLIENT_SECRET, TOAST_LOCATION_ID: LOC_ID })) {
  if (!v) { console.error(`ERROR: ${k} missing from .env`); process.exit(1); }
}

// ─── helpers ─────────────────────────────────────────────────────────────────
const dumps   = {};   // endpoint → raw parsed body (200s only)
const report  = [];   // lines for the text report

function log(line = '') { console.log(line); report.push(line); }
function section(title) {
  const bar = '─'.repeat(68);
  log(); log(bar); log(`  ${title}`); log(bar);
}

async function login() {
  const res = await fetch(`${HOST}/authentication/v1/authentication/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, userAccessType: USER_ACCESS }),
  });
  if (!res.ok) throw new Error(`Login failed ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const token = body?.token?.accessToken || body?.accessToken;
  if (!token) throw new Error(`Unexpected login shape: ${JSON.stringify(body).slice(0, 300)}`);
  log(`✓ Authenticated  (token expires in ${body?.token?.expiresIn ?? '?'}s,  type: ${body?.token?.tokenType ?? '?'})`);
  log(`  Credential type in response: ${JSON.stringify(body?.token?.scope ?? body?.scope ?? '(not present)')}`);
  return token;
}

async function probe(token, method, urlPath, body) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Toast-Restaurant-External-ID': LOC_ID,
    'Content-Type': 'application/json',
  };
  const opts = { method: method || 'GET', headers };
  if (body) opts.body = JSON.stringify(body);

  const url = `${HOST}${urlPath}`;
  let status, json, text;
  try {
    const res = await fetch(url, opts);
    status = res.status;
    text = await res.text();
    try { json = JSON.parse(text); } catch (_) { json = null; }
  } catch (err) {
    return { status: 'ERR', error: err.message, json: null, text: err.message };
  }
  if (status === 200 && json !== null) dumps[urlPath] = json;
  return { status, json, text };
}

function summariseShape(val, depth = 0) {
  if (depth > 3) return '…';
  if (val === null) return 'null';
  if (Array.isArray(val)) {
    if (val.length === 0) return '[]';
    return `Array(${val.length}) of ${summariseShape(val[0], depth + 1)}`;
  }
  if (typeof val === 'object') {
    const keys = Object.keys(val);
    if (keys.length === 0) return '{}';
    return `{ ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''} }`;
  }
  return typeof val;
}

function printResult(label, { status, json, text }) {
  const shape = json !== null ? summariseShape(json) : '';
  const note  = status === 200 ? `✓  ${shape}` :
                status === 404 ? '✗  404 Not Found' :
                status === 403 ? '✗  403 Forbidden (scope/auth)' :
                status === 401 ? '✗  401 Unauthorized' :
                status === 400 ? `✗  400 Bad Request — ${text.slice(0, 120)}` :
                `?  ${status} — ${text.slice(0, 120)}`;
  log(`  ${label.padEnd(52)}  ${note}`);
  return status === 200;
}

// ─── deep-dive helpers ───────────────────────────────────────────────────────
function countMenuItems(data) {
  let total = 0;
  const menus = Array.isArray(data) ? data : (data?.menus || []);
  function walk(groups) {
    for (const g of groups || []) {
      total += (g.menuItems || g.items || []).length;
      walk(g.menuGroups || []);
    }
  }
  for (const m of menus) walk(m.menuGroups || m.groups || []);
  return total;
}

function walkGroups(data) {
  const result = [];
  const menus = Array.isArray(data) ? data : (data?.menus || []);
  function walk(groups, menuName, depth) {
    for (const g of groups || []) {
      const items = g.menuItems || g.items || [];
      result.push({ menuName, depth, name: g.name, guid: g.guid, itemCount: items.length });
      walk(g.menuGroups || [], menuName, depth + 1);
    }
  }
  for (const m of menus) walk(m.menuGroups || m.groups || [], m.name, 0);
  return result;
}

function describeItems(items, label) {
  if (!items || items.length === 0) return;
  log(`\n  ${label} (${items.length} items):`);
  const fields = new Set();
  for (const it of items) Object.keys(it).forEach(k => fields.add(k));
  log(`  Available fields on each item: ${[...fields].sort().join(', ')}`);
  log();
  for (const it of items.slice(0, 60)) {
    const vis  = (it.visibility || []).join(', ');
    const plu  = it.plu  ? ` | plu="${it.plu}"` : '';
    const sku  = it.sku  ? ` | sku="${it.sku}"` : '';
    const oos  = it.outOfStock != null ? ` | outOfStock=${it.outOfStock}` : '';
    const avail = it.available   != null ? ` | available=${it.available}` : '';
    const qty  = it.quantity     != null ? ` | qty=${it.quantity}` : '';
    const price = it.price != null ? ` $${it.price}` : '';
    log(`    ${String(it.name || it.guid || '?').padEnd(30)}${price} | vis=[${vis}]${oos}${avail}${qty}${plu}${sku}`);
  }
  if (items.length > 60) log(`    … and ${items.length - 60} more`);
}

// ─── main ────────────────────────────────────────────────────────────────────
(async () => {
  log(`Toast API Explorer — Half Shell`);
  log(`Host: ${HOST}`);
  log(`Restaurant GUID: ${LOC_ID}`);
  log(`Run at: ${new Date().toISOString()}`);
  log();

  const token = await login();

  // ── 1. Menus API v2 ─────────────────────────────────────────────────────
  section('1. MENUS API v2  (/menus/v2/...)');
  log('  The primary display-menu surface. Returns published menu tree.');
  log();
  const r_meta  = await probe(token, 'GET', '/menus/v2/metadata');
  printResult('GET /menus/v2/metadata', r_meta);
  if (r_meta.status === 200) {
    log(`    → restaurantGuid: ${r_meta.json?.restaurantGuid}`);
    log(`    → lastUpdated:    ${r_meta.json?.lastUpdated}`);
  }

  const r_menus = await probe(token, 'GET', '/menus/v2/menus');
  printResult('GET /menus/v2/menus', r_menus);
  if (r_menus.status === 200) {
    const groups = walkGroups(r_menus.json);
    const total  = countMenuItems(r_menus.json);
    log(`    → Total items across all groups: ${total}`);
    log(`    → Menu / Group tree:`);
    for (const g of groups) {
      const indent = '  '.repeat(g.depth + 3);
      log(`    ${indent}[${g.menuName}]  "${g.name}"  (${g.itemCount} items)  guid:${g.guid}`);
    }

    // Deep-dive: all items in the Raw Bar group
    const menus = r_menus.json?.menus || [];
    let rawBarItems = [];
    for (const m of menus) {
      for (const g of (m.menuGroups || [])) {
        if (g.name?.toLowerCase().includes('raw bar')) rawBarItems = g.menuItems || [];
      }
    }
    describeItems(rawBarItems, 'Raw Bar items (all fields shown)');
  }

  // ── 2. Config API v2 — menu structure ────────────────────────────────────
  section('2. CONFIG API v2 — MENU STRUCTURE  (/config/v2/...)');
  log('  CRUD surface for editing menus. Often returns richer internal data');
  log('  than the published Menus v2 API (e.g. internal flags, PLU, pricing).');
  log();
  const configMenuEndpoints = [
    ['/config/v2/menus',                  'All menus (config)'],
    ['/config/v2/menuGroups',             'All menu groups'],
    ['/config/v2/menuItems',              'All menu items (LARGE — may be slow)'],
    ['/config/v2/modifierGroups',         'Modifier groups'],
    ['/config/v2/modifierOptions',        'Modifier options'],
  ];
  for (const [ep, label] of configMenuEndpoints) {
    const r = await probe(token, 'GET', ep);
    const ok = printResult(`GET ${ep}`, r);
    if (ok && Array.isArray(r.json)) {
      log(`    → ${r.json.length} records`);
      if (r.json.length > 0) log(`    → Fields: ${Object.keys(r.json[0]).join(', ')}`);
    }
  }

  // ── 3. Config API v2 — stock / inventory ─────────────────────────────────
  section('3. CONFIG API v2 — STOCK & INVENTORY  (/config/v2/...)');
  log('  Endpoints that may expose out-of-stock (86) status per item.');
  log();
  const stockConfigEndpoints = [
    ['/config/v2/stockStatuses',                'Stock statuses (86 list)'],
    ['/config/v2/menuItemStockStatuses',         'Menu item stock statuses'],
    ['/config/v2/inventoryItems',                'Inventory items'],
    ['/config/v2/menuItemInventory',             'Menu item inventory'],
    ['/config/v2/preModifierGroups',             'Pre-modifier groups'],
    ['/config/v2/salesCategories',               'Sales categories'],
    ['/config/v2/pricingRules',                  'Pricing rules'],
  ];
  for (const [ep, label] of stockConfigEndpoints) {
    const r = await probe(token, 'GET', ep);
    const ok = printResult(`GET ${ep}`, r);
    if (ok) {
      const items = Array.isArray(r.json) ? r.json : (r.json?.results || []);
      log(`    → ${items.length} records`);
      if (items.length > 0) {
        log(`    → Fields: ${Object.keys(items[0]).join(', ')}`);
        log(`    → Sample: ${JSON.stringify(items[0]).slice(0, 200)}`);
      }
    }
  }

  // ── 4. Stock API (dedicated surface) ─────────────────────────────────────
  section('4. STOCK API  (/stock/...)');
  log('  Dedicated stock/inventory management endpoints.');
  log();
  const stockEndpoints = [
    ['/stock/v1/inventory',              'Inventory levels'],
    ['/stock/v1/inventoryItems',         'Inventory item list'],
    ['/stock/v1/stockStatuses',          'Stock statuses'],
    ['/stock/v1/outOfStock',             'Currently out-of-stock items'],
    ['/stock/v1/items',                  'Stock items'],
  ];
  for (const [ep, label] of stockEndpoints) {
    const r = await probe(token, 'GET', ep);
    const ok = printResult(`GET ${ep}`, r);
    if (ok) {
      const items = Array.isArray(r.json) ? r.json : (r.json?.items || r.json?.results || []);
      log(`    → ${items.length} records`);
      if (items.length > 0) {
        log(`    → Fields: ${Object.keys(items[0]).join(', ')}`);
        log(`    → Sample: ${JSON.stringify(items[0]).slice(0, 200)}`);
      }
    }
  }

  // ── 5. Restaurant / Partner API ───────────────────────────────────────────
  section('5. RESTAURANT & PARTNER API');
  log('  Identity, location info, and partner-level restaurant discovery.');
  log();
  const restaurantEndpoints = [
    ['/restaurants/v1/groups',                        'Restaurant groups'],
    ['/restaurants/v1/groups/locations',              'Restaurant locations'],
    [`/restaurants/v1/groups/${LOC_ID}/locations`,    'Locations for this restaurant'],
    ['/partners/v1/restaurants',                      'Restaurants accessible to this partner'],
    [`/partners/v1/restaurants/${LOC_ID}`,            'This restaurant detail'],
  ];
  for (const [ep, label] of restaurantEndpoints) {
    const r = await probe(token, 'GET', ep);
    const ok = printResult(`GET ${ep.replace(LOC_ID, '<guid>')}`, r);
    if (ok) log(`    → Shape: ${summariseShape(r.json)}`);
  }

  // ── 6. Orders / Labor (read-only scope check) ────────────────────────────
  section('6. SCOPE CHECK — Orders / Labor / Reports');
  log('  Tests whether this credential has read access beyond menus.');
  log('  Useful for understanding the full permission surface.');
  log();
  const scopeCheckEndpoints = [
    ['/orders/v2/orders',            'Orders (orders:read scope)'],
    ['/labor/v1/shifts',             'Labor shifts (labor:read scope)'],
    ['/reporting/v1/sales',          'Sales reports (reporting:read scope)'],
    ['/cash/v1/sessions',            'Cash sessions (cash:read scope)'],
    ['/items/v1/items',              'Items (items:read scope)'],
    ['/discounts/v1/discounts',      'Discounts (discounts:read scope)'],
    ['/payments/v2/orders',          'Payments/orders'],
  ];
  for (const [ep, label] of scopeCheckEndpoints) {
    const r = await probe(token, 'GET', ep);
    printResult(`GET ${ep}`, r);
  }

  // ── 7. Webhooks / events ──────────────────────────────────────────────────
  section('7. WEBHOOKS / EVENTS');
  log('  Check if webhook subscriptions can be managed via API.');
  log();
  const webhookEndpoints = [
    ['/config/v2/webhookSubscriptions',  'Webhook subscriptions'],
    ['/events/v1/subscriptions',         'Event subscriptions'],
  ];
  for (const [ep, label] of webhookEndpoints) {
    const r = await probe(token, 'GET', ep);
    const ok = printResult(`GET ${ep}`, r);
    if (ok) log(`    → Shape: ${summariseShape(r.json)}`);
  }

  // ── 8. Menus API v3 (ordering-focused, newer) ────────────────────────────
  section('8. MENUS API v3  (/menus/v3/...)');
  log('  Newer API designed for ordering integrations. May expose different');
  log('  availability/stock fields than v2.');
  log();
  const v3Endpoints = [
    ['/menus/v3/menus',          'Full menu v3'],
    ['/menus/v3/metadata',       'Metadata v3'],
    ['/menus/v3/items',          'Items v3'],
  ];
  for (const [ep, label] of v3Endpoints) {
    const r = await probe(token, 'GET', ep);
    const ok = printResult(`GET ${ep}`, r);
    if (ok) {
      log(`    → Shape: ${summariseShape(r.json)}`);
      // Check if v3 has outOfStock or availability fields
      const text = JSON.stringify(r.json);
      if (text.includes('outOfStock'))   log(`    ★ Contains "outOfStock" field!`);
      if (text.includes('availability')) log(`    ★ Contains "availability" field!`);
      if (text.includes('inStock'))      log(`    ★ Contains "inStock" field!`);
    }
  }

  // ── 9. Field survey: stock-related fields across all 200 responses ───────
  section('9. FIELD SURVEY — stock/availability fields in all responses');
  log('  Scans every successful response for fields related to availability.');
  log();
  const stockFields = ['outOfStock','available','inStock','quantity','stock',
                       'soldOut','availability','enabled','active','visible',
                       'stockStatus','inventoryStatus'];
  for (const [ep, body] of Object.entries(dumps)) {
    const text = JSON.stringify(body);
    const found = stockFields.filter(f => text.toLowerCase().includes(f.toLowerCase()));
    if (found.length > 0) {
      log(`  ${ep}`);
      log(`    Found: ${found.join(', ')}`);
    }
  }

  // ── 10. Write outputs ─────────────────────────────────────────────────────
  section('10. OUTPUT FILES');
  const dumpPath   = path.join(__dirname, 'toast-api-explorer-dump.json');
  const reportPath = path.join(__dirname, 'toast-api-explorer-report.txt');
  fs.writeFileSync(dumpPath,   JSON.stringify(dumps,       null, 2));
  fs.writeFileSync(reportPath, report.join('\n') + '\n');
  log(`  ✓ Raw response dump  → tools/toast-api-explorer-dump.json`);
  log(`  ✓ Plain-text report  → tools/toast-api-explorer-report.txt`);
  log();
  log('Done.');
})().catch(err => {
  console.error(`\n✗ Fatal: ${err.message}`);
  process.exit(1);
});
