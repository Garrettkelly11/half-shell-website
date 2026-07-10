#!/usr/bin/env node
/**
 * Toast → Firebase sync — standalone script for GitHub Actions.
 *
 * Runs in the GitHub Actions environment (not Firebase Functions). Reads
 * credentials from environment variables set as GitHub Secrets, then:
 *   1. Authenticates with Toast (OAuth client-credentials flow)
 *   2. Fetches /menus/v2/menus to get the full Raw Bar item list
 *   3. Fetches /stock/v1/inventory to get which items are currently 86'd
 *   4. Name-matches non-86'd items against the Half Shell oyster catalog
 *   5. Writes the resulting slug list to Firebase Realtime Database /menu/serving
 *
 * Required environment variables (set as GitHub Secrets):
 *   TOAST_CLIENT_ID        — OAuth client ID
 *   TOAST_CLIENT_SECRET    — OAuth client secret
 *   TOAST_LOCATION_ID      — Half Shell restaurant GUID (55811240-...)
 *   FIREBASE_DATABASE_URL  — e.g. https://half-shell-oyster-menu-default-rtdb.firebaseio.com
 *
 * Firebase auth: uses GOOGLE_APPLICATION_CREDENTIALS env var pointing to a
 * service-account JSON file written by the workflow before calling this script.
 *
 * Usage:
 *   node tools/sync-toast-to-firebase.js
 *
 * Exit codes:
 *   0 — sync succeeded (or was skipped cleanly)
 *   1 — fatal error (auth failure, database unreachable, etc.)
 */

const fs    = require('fs');
const path  = require('path');
const vm    = require('vm');
const { initializeApp, getApps, applicationDefault } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

// ─── Config ─────────────────────────────────────────────────────────────────
const HOSTNAME         = process.env.TOAST_API_HOSTNAME || 'https://ws-api.toasttab.com';
const CLIENT_ID        = process.env.TOAST_CLIENT_ID;
const CLIENT_SECRET    = process.env.TOAST_CLIENT_SECRET;
const USER_ACCESS_TYPE = process.env.TOAST_USER_ACCESS_TYPE || 'TOAST_MACHINE_CLIENT';
const LOCATION_ID      = process.env.TOAST_LOCATION_ID;
const DATABASE_URL     = process.env.FIREBASE_DATABASE_URL
  || 'https://half-shell-oyster-menu-default-rtdb.firebaseio.com';

for (const [k, v] of Object.entries({ TOAST_CLIENT_ID: CLIENT_ID, TOAST_CLIENT_SECRET: CLIENT_SECRET, TOAST_LOCATION_ID: LOCATION_ID })) {
  if (!v) { console.error(`ERROR: ${k} env var missing.`); process.exit(1); }
}

const TOAST_RATE_LIMIT_MS = 1100; // Toast allows ~1 req/sec
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Load oyster catalog ────────────────────────────────────────────────────
// Reads data/oysters.js (browser-style var declaration) via Node's vm module.
// This is the single source of truth for catalog slugs and display names.
const catalogPath = path.join(__dirname, '..', 'data', 'oysters.js');
let CATALOG = [];
try {
  const code    = fs.readFileSync(catalogPath, 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  CATALOG = sandbox.OYSTERS || [];
  console.log(`Loaded ${CATALOG.length} oysters from catalog.`);
} catch (err) {
  console.error(`Failed to load catalog from ${catalogPath}: ${err.message}`);
  process.exit(1);
}

// ─── Load GUID override table ───────────────────────────────────────────────
let guidToSlug = {};
try {
  const mapping = require(path.join(__dirname, '..', 'functions', 'toast-mapping.js'));
  guidToSlug = mapping.guidToSlug || {};
} catch (_) { /* no override table — fine */ }

// ─── Build name-match index ──────────────────────────────────────────────────
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
    if (base.endsWith('s'))   yield base.slice(0, -1);     else yield base + 's';
    if (base.endsWith('ies')) yield base.slice(0, -3) + 'y';
    if (base.endsWith('y'))   yield base.slice(0, -1) + 'ies';
  }
}

const matchIndex = new Map();
for (const entry of CATALOG) {
  for (const key of matchKeysFor(entry)) {
    if (!matchIndex.has(key)) matchIndex.set(key, entry.id);
  }
}
console.log(`Match index: ${matchIndex.size} keys.`);

// ─── Toast auth ──────────────────────────────────────────────────────────────
async function getToken() {
  const res = await fetch(`${HOSTNAME}/authentication/v1/authentication/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, userAccessType: USER_ACCESS_TYPE }),
  });
  if (!res.ok) throw new Error(`Toast login failed: ${res.status} — ${await res.text()}`);
  const body = await res.json();
  const token = body?.token?.accessToken || body?.accessToken;
  if (!token) throw new Error(`Unexpected login response shape`);
  console.log(`Toast auth: OK (expires in ${body?.token?.expiresIn}s)`);
  return token;
}

// ─── Toast API calls ─────────────────────────────────────────────────────────
const authHeaders = token => ({
  'Authorization': `Bearer ${token}`,
  'Toast-Restaurant-External-ID': LOCATION_ID,
});

async function fetchMenu(token) {
  await sleep(TOAST_RATE_LIMIT_MS);
  const res = await fetch(`${HOSTNAME}/menus/v2/menus`, { headers: authHeaders(token) });
  if (res.status === 409) {
    console.log('Menu modified mid-fetch (409) — retrying...');
    await sleep(2000);
    return fetchMenu(token);
  }
  if (!res.ok) throw new Error(`Menu fetch failed: ${res.status}`);
  return res.json();
}

async function fetchOutOfStockGuids(token) {
  await sleep(TOAST_RATE_LIMIT_MS);
  const res = await fetch(`${HOSTNAME}/stock/v1/inventory`, { headers: authHeaders(token) });
  if (!res.ok) {
    console.warn(`Stock API ${res.status} — treating all items as in stock.`);
    return new Set();
  }
  const records = await res.json();
  const outOfStock = new Set(
    (Array.isArray(records) ? records : [])
      .filter(r => r.status === 'OUT_OF_STOCK')
      .map(r => r.guid)
  );
  console.log(`Stock API: ${records.length} records, ${outOfStock.size} OUT_OF_STOCK.`);
  return outOfStock;
}

// ─── Menu walk ───────────────────────────────────────────────────────────────
function* iterateGroups(groups) {
  for (const group of groups || []) {
    for (const item of (group.menuItems || [])) yield item;
    yield* iterateGroups(group.menuGroups || []);
  }
}

function* iterateAllItems(data) {
  for (const menu of (data?.menus || [])) {
    yield* iterateGroups(menu.menuGroups || []);
  }
}

// ─── Firebase init ───────────────────────────────────────────────────────────
if (!getApps().length) {
  initializeApp({ credential: applicationDefault(), databaseURL: DATABASE_URL });
}
const db = getDatabase();

// ─── Main sync ───────────────────────────────────────────────────────────────
(async () => {
  const now = Date.now();
  console.log(`\nHalf Shell Toast sync — ${new Date(now).toISOString()}`);

  try {
    const token           = await getToken();
    const outOfStockGuids = await fetchOutOfStockGuids(token);
    const menuData        = await fetchMenu(token);

    const matched    = [];
    const matchedSet = new Set();
    const unmatched  = [];
    let   skipped    = 0;

    for (const item of iterateAllItems(menuData)) {
      if (!item?.name) continue;

      // Skip 86'd items
      if (item.guid && outOfStockGuids.has(item.guid)) { skipped++; continue; }

      // GUID override table (toast-mapping.js)
      const slugOverride = item.guid && guidToSlug[item.guid];
      const slug = slugOverride || matchIndex.get(normalize(item.name)) || null;

      if (slug) {
        if (!matchedSet.has(slug)) { matched.push(slug); matchedSet.add(slug); }
      } else {
        unmatched.push({ name: item.name, guid: item.guid, price: item.price ?? null });
      }
    }

    console.log(`Matched: ${matched.length} | Unmatched: ${unmatched.length} | 86'd (skipped): ${skipped}`);
    if (matched.length) console.log(`Serving: ${matched.join(', ')}`);
    if (unmatched.length) {
      console.log(`Unmatched items (not in catalog):`);
      for (const u of unmatched) console.log(`  - ${u.name} ($${u.price})`);
    }

    // ── Write to Firebase ──────────────────────────────────────────────────
    const snapshot    = await db.ref('menu/serving').once('value');
    const currentMenu = snapshot.val() || {};
    const updates     = {};
    let added = 0, updated = 0, removed = 0;

    for (const id of matched) {
      if (currentMenu[id]) {
        updates[id] = { addedAt: currentMenu[id].addedAt, lastUpdated: now, source: 'toast' };
        updated++;
      } else {
        updates[id] = { addedAt: now, lastUpdated: now, source: 'toast' };
        added++;
      }
    }

    // Remove toast-sourced oysters no longer in the serving list (86'd or pulled)
    const matchedSet2 = new Set(matched);
    for (const [id, entry] of Object.entries(currentMenu)) {
      if (entry?.source === 'toast' && !matchedSet2.has(id)) { updates[id] = null; removed++; }
    }

    if (Object.keys(updates).length > 0) {
      await db.ref('menu/serving').update(updates);
      console.log(`Firebase updated: +${added} added, ~${updated} refreshed, -${removed} removed.`);
    } else {
      console.log('Firebase: no changes needed.');
    }

    // Audit log
    await db.ref('audit-log').push({
      timestamp: now,
      action: 'toast_sync',
      details: `added:${added} updated:${updated} removed:${removed} unmatched:${unmatched.length} skipped_86d:${skipped}`,
      actor: 'GitHub Actions (scheduled)',
      readable_timestamp: new Date(now).toISOString(),
    });

    console.log('Sync complete.\n');
    process.exit(0);

  } catch (err) {
    console.error(`\nSync failed: ${err.message}`);
    try {
      await db.ref('audit-log').push({
        timestamp: now,
        action: 'toast_sync_error',
        details: err.message,
        actor: 'GitHub Actions (scheduled)',
        readable_timestamp: new Date(now).toISOString(),
      });
    } catch (_) {}
    process.exit(1);
  }
})();
