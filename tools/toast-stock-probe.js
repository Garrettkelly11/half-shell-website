#!/usr/bin/env node
/**
 * Toast Stock/Availability Probe — Half Shell diagnostic
 *
 * Answers the question: "How does Toast know which oysters are available to serve?"
 *
 * Tries several Toast API endpoints to discover:
 *   1. Which items (if any) are currently 86'd / out of stock
 *   2. Whether the Stock API is accessible with the current credential
 *   3. The current live state of every oyster item in the Raw Bar group
 *
 * Usage (from the "Oyster Website" folder):
 *   node tools/toast-stock-probe.js
 *
 * Requirements: Node 18+ (built-in fetch). No npm install needed.
 */

const fs = require('fs');
const path = require('path');

// --- tiny .env loader -------------------------------------------------------
function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) {
    console.error(`ERROR: ${envPath} not found.`);
    process.exit(1);
  }
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawVal] = match;
    if (!(key in process.env)) process.env[key] = rawVal.replace(/^["'](.*)["']$/, '$1');
  }
}

loadEnv(path.join(__dirname, '..', '.env'));

const {
  TOAST_API_HOSTNAME = 'https://ws-api.toasttab.com',
  TOAST_CLIENT_ID,
  TOAST_CLIENT_SECRET,
  TOAST_USER_ACCESS_TYPE = 'TOAST_MACHINE_CLIENT',
  TOAST_LOCATION_ID,
} = process.env;

for (const [k, v] of Object.entries({ TOAST_CLIENT_ID, TOAST_CLIENT_SECRET, TOAST_LOCATION_ID })) {
  if (!v) { console.error(`ERROR: ${k} missing from .env`); process.exit(1); }
}

// --- helpers ----------------------------------------------------------------
async function login() {
  const res = await fetch(`${TOAST_API_HOSTNAME}/authentication/v1/authentication/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: TOAST_CLIENT_ID, clientSecret: TOAST_CLIENT_SECRET, userAccessType: TOAST_USER_ACCESS_TYPE }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status} — ${await res.text()}`);
  const body = await res.json();
  const token = body?.token?.accessToken || body?.accessToken;
  if (!token) throw new Error(`Unexpected login shape: ${JSON.stringify(body).slice(0, 200)}`);
  return token;
}

async function get(token, path) {
  const res = await fetch(`${TOAST_API_HOSTNAME}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Toast-Restaurant-External-ID': TOAST_LOCATION_ID,
    },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, ok: res.ok, json, text: text.slice(0, 500) };
}

function section(title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'─'.repeat(60)}`);
}

// --- main -------------------------------------------------------------------
(async () => {
  console.log(`Toast Stock/Availability Probe`);
  console.log(`Restaurant: ${TOAST_LOCATION_ID}`);

  const token = await login();
  console.log(`✓ Authenticated\n`);

  // -------------------------------------------------------------------
  // 1. Check stock status endpoint (86'd items)
  // -------------------------------------------------------------------
  section('1. Stock Status API  (tells us which items are 86\'d)');

  const stockEndpoints = [
    '/config/v2/stockStatuses',
    '/config/v2/menuItemStockStatuses',
  ];

  let stockData = null;
  for (const ep of stockEndpoints) {
    const r = await get(token, ep);
    console.log(`  GET ${ep}  →  ${r.status}`);
    if (r.ok && r.json) {
      stockData = r.json;
      const items = Array.isArray(r.json) ? r.json : r.json.stockStatuses || [];
      console.log(`  ✓ Found ${items.length} stock-status record(s)`);
      if (items.length > 0) {
        console.log(`\n  Sample records:`);
        for (const it of items.slice(0, 5)) {
          console.log(`    ${JSON.stringify(it)}`);
        }
        if (items.length > 5) console.log(`    … and ${items.length - 5} more`);
        // Write full dump
        const outPath = path.join(__dirname, 'toast-stock-dump.json');
        fs.writeFileSync(outPath, JSON.stringify(r.json, null, 2));
        console.log(`\n  ✓ Full stock dump saved to tools/toast-stock-dump.json`);
      } else {
        console.log(`  → 0 items means nothing is currently 86\'d.`);
      }
      break;
    } else {
      console.log(`    ${r.text}`);
    }
  }

  // -------------------------------------------------------------------
  // 2. Menu items live state — check visibility & any stock-related fields
  // -------------------------------------------------------------------
  section('2. Live Menu — Raw Bar oyster items');

  const menuRes = await get(token, '/menus/v2/menus');
  if (!menuRes.ok) {
    console.log(`  ✗ Could not fetch menu: ${menuRes.status}`);
  } else {
    const menus = menuRes.json?.menus || menuRes.json || [];
    let rawBarGroup = null;
    for (const menu of menus) {
      for (const group of (menu.menuGroups || [])) {
        if (group.name?.toLowerCase().includes('raw bar')) {
          rawBarGroup = group;
          break;
        }
        // Also check nested sub-groups
        for (const sub of (group.menuGroups || [])) {
          if (sub.name?.toLowerCase().includes('raw bar')) { rawBarGroup = sub; break; }
        }
      }
    }

    if (!rawBarGroup) {
      console.log(`  ✗ No "Raw Bar" group found in menu`);
    } else {
      const items = rawBarGroup.menuItems || [];
      // Separate oysters (priced at $3–$6 typically) from other raw bar items
      const likelyOysters = items.filter(it => it.price != null && it.price >= 2.5 && it.price <= 6.5);
      const other = items.filter(it => !likelyOysters.includes(it));

      console.log(`  Raw Bar group: ${items.length} total items`);
      console.log(`  Likely oysters (price $2.50–$6.50): ${likelyOysters.length}`);
      console.log(`  Other items (towers, caviar, etc.): ${other.length}`);

      // Check visibility values and any availability flags
      const visibilityCounts = {};
      const outOfStockItems = [];
      const hiddenItems = [];

      for (const item of likelyOysters) {
        // Count visibility combos
        const visKey = JSON.stringify((item.visibility || []).sort());
        visibilityCounts[visKey] = (visibilityCounts[visKey] || 0) + 1;

        // Flag items that might be hidden/unavailable
        if (item.outOfStock) outOfStockItems.push(item.name);
        const vis = item.visibility || [];
        if (!vis.includes('POS')) hiddenItems.push(item.name);
      }

      console.log(`\n  Visibility distribution across oyster items:`);
      for (const [vis, count] of Object.entries(visibilityCounts)) {
        console.log(`    ${count}x  ${vis}`);
      }

      if (outOfStockItems.length > 0) {
        console.log(`\n  ✓ ITEMS MARKED OUT OF STOCK (86'd):`);
        for (const name of outOfStockItems) console.log(`    - ${name}`);
      } else {
        console.log(`\n  → No items have outOfStock=true in the Menus API response.`);
        console.log(`    (This is expected — outOfStock lives in the Stock API, not Menus API)`);
      }

      if (hiddenItems.length > 0) {
        console.log(`\n  Items NOT visible on POS:`);
        for (const name of hiddenItems) console.log(`    - ${name}`);
      }

      console.log(`\n  All oyster items and their fields:`);
      for (const item of likelyOysters) {
        const vis = (item.visibility || []).join(', ');
        const oos = item.outOfStock != null ? ` | outOfStock=${item.outOfStock}` : '';
        const plu = item.plu ? ` | plu="${item.plu}"` : '';
        const sku = item.sku ? ` | sku="${item.sku}"` : '';
        console.log(`    ${item.name.padEnd(28)} $${item.price} | vis=[${vis}]${oos}${plu}${sku}`);
      }
    }
  }

  // -------------------------------------------------------------------
  // 3. Cross-reference stock statuses with oyster GUIDs
  // -------------------------------------------------------------------
  if (stockData) {
    section('3. Cross-reference: which oysters are 86\'d right now?');
    const stockItems = Array.isArray(stockData) ? stockData : stockData.stockStatuses || [];
    if (stockItems.length === 0) {
      console.log('  → 0 stock records. Nothing is currently 86\'d in Toast.');
      console.log('  → This means ALL items are considered "in stock" at this moment.');
    } else {
      console.log(`  ${stockItems.length} item(s) have a non-default stock status:`);
      for (const it of stockItems) {
        console.log(`    ${JSON.stringify(it)}`);
      }
    }
  }

  // -------------------------------------------------------------------
  // 4. Summary & recommendation
  // -------------------------------------------------------------------
  section('4. Summary & recommendation');
  console.log(`
  Based on what the API returned, here's what controls oyster availability:

  A) STOCK API (86 workflow):
     If the Stock API returned records above, Toast is tracking availability
     via the "86" feature. Staff mark items out of stock in Toast back-of-house,
     and the sync code should cross-reference those GUIDs to exclude 86'd items.

  B) NO STOCK RECORDS / ALL IN STOCK:
     If nothing came back from the Stock API, one of two things is true:
       - Everything is currently in stock (no items have been 86'd yet)
       - The Stock API isn't being used and you need a different mechanism

  RECOMMENDED NEXT STEP:
     Go into Toast back-of-house right now and 86 one oyster that you are NOT
     currently serving. Then re-run this script. If the stock record appears,
     the 86 workflow is the right approach and we wire it into the sync code.
     If nothing changes, we should use a dedicated "Tonight's Oysters" menu
     group in Toast Web instead.
  `);

  console.log('Done.\n');
})().catch(err => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
