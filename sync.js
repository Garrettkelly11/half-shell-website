/**
 * sync.js — Half Shell Toast Oyster Sync
 *
 * Polls the Toast Menus API and writes public/oysters.json with
 * current availability. Designed to run via GitHub Actions every 15 min.
 *
 * Required environment variables (set as GitHub Secrets):
 *   TOAST_CLIENT_ID
 *   TOAST_CLIENT_SECRET
 *   TOAST_RESTAURANT_GUID
 *
 * Usage:
 *   node sync.js
 */

const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = 'https://ws-api.toasttab.com';
const STATE_FILE = path.join(__dirname, 'sync-state.json');
const OUTPUT_FILE = path.join(__dirname, 'public', 'oysters.json');

// The Menu Group name in Toast that contains your oysters.
// Log into Toast back-of-house and find the exact name — update this to match.
const OYSTER_GROUP_NAMES = ['oyster', 'oysters', 'raw bar', 'half shell'];

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastModifiedTime: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Authentication ────────────────────────────────────────────────────────────

async function getToken() {
  const clientId = process.env.TOAST_CLIENT_ID;
  const clientSecret = process.env.TOAST_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'Missing TOAST_CLIENT_ID or TOAST_CLIENT_SECRET environment variables.\n' +
      'Add them as GitHub Secrets: Settings → Secrets and variables → Actions.'
    );
  }

  const res = await fetch(`${BASE_URL}/authentication/v1/authentication/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId,
      clientSecret,
      userAccessType: 'TOAST_MACHINE_CLIENT'
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Toast auth failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return data.token.accessToken;
}

// ── Metadata check ────────────────────────────────────────────────────────────

async function getMenuMetadata(token) {
  const restaurantGuid = process.env.TOAST_RESTAURANT_GUID;

  const res = await fetch(`${BASE_URL}/menus/v2/metadata`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Toast-Restaurant-External-ID': restaurantGuid
    }
  });

  if (!res.ok) {
    throw new Error(`Metadata fetch failed (${res.status})`);
  }

  return res.json();
}

// ── Full menu fetch ────────────────────────────────────────────────────────────

async function fetchFullMenu(token) {
  const restaurantGuid = process.env.TOAST_RESTAURANT_GUID;

  // Respect 1 req/sec rate limit
  await sleep(1100);

  const res = await fetch(`${BASE_URL}/menus/v2/menus`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Toast-Restaurant-External-ID': restaurantGuid
    }
  });

  // 409 = menu modified during request — retry once
  if (res.status === 409) {
    console.log('Menu modified during fetch (409) — retrying...');
    await sleep(2000);
    return fetchFullMenu(token);
  }

  if (!res.ok) {
    throw new Error(`Menu fetch failed (${res.status})`);
  }

  return res.json();
}

// ── Filter oysters ────────────────────────────────────────────────────────────

function extractOysters(menuResponse) {
  const oysters = [];

  const menus = menuResponse.menus || menuResponse;
  if (!Array.isArray(menus)) {
    console.warn('Unexpected menu response shape — check Toast API version');
    return oysters;
  }

  for (const menu of menus) {
    const groups = menu.menuGroups || [];
    for (const group of groups) {
      const groupName = (group.name || '').toLowerCase();
      const isOysterGroup = OYSTER_GROUP_NAMES.some(n => groupName.includes(n));

      if (isOysterGroup) {
        console.log(`Found oyster group: "${group.name}" (${(group.menuItems || []).length} items)`);

        for (const item of (group.menuItems || [])) {
          oysters.push({
            id: item.guid || item.name.toLowerCase().replace(/\s+/g, '-'),
            name: item.name,
            description: item.description || '',
            price: item.price || 0,
            available: !item.outOfStock
          });
        }
      }
    }
  }

  return oysters;
}

// ── Write output ──────────────────────────────────────────────────────────────

function writeOutput(oysters) {
  // Ensure public/ directory exists
  const dir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Safety check: don't overwrite with empty data on API error
  if (oysters.length === 0) {
    // Keep existing data if we get zero oysters (could be an API issue)
    if (fs.existsSync(OUTPUT_FILE)) {
      const existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
      if (existing.oysters && existing.oysters.length > 0) {
        console.warn('Warning: Toast returned 0 oysters. Keeping previous oysters.json to avoid empty menu.');
        return;
      }
    }
  }

  const output = {
    lastUpdated: new Date().toISOString(),
    oysterCount: oysters.length,
    availableCount: oysters.filter(o => o.available).length,
    oysters
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`Wrote ${oysters.length} oysters (${output.availableCount} available) to ${OUTPUT_FILE}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const missingCreds =
    !process.env.TOAST_CLIENT_ID ||
    !process.env.TOAST_CLIENT_SECRET ||
    !process.env.TOAST_RESTAURANT_GUID;

  if (missingCreds) {
    console.log('Toast API credentials not configured — skipping sync. Add TOAST_CLIENT_ID, TOAST_CLIENT_SECRET, and TOAST_RESTAURANT_GUID as GitHub Secrets when ready.');
    return;
  }

  console.log(`[${new Date().toISOString()}] Starting oyster sync...`);

  const state = loadState();

  // Step 1: Authenticate
  const token = await getToken();
  console.log('Authenticated with Toast API.');

  // Step 2: Check metadata — skip full fetch if menu hasn't changed
  const metadata = await getMenuMetadata(token);
  const lastModified = metadata.lastModifiedTime;

  if (lastModified && lastModified === state.lastModifiedTime) {
    console.log('Menu unchanged since last sync — skipping full fetch.');
    return;
  }

  console.log(`Menu updated (${lastModified}) — fetching full menu...`);

  // Step 3: Fetch full menu
  const menuData = await fetchFullMenu(token);

  // Step 4: Extract oysters
  const oysters = extractOysters(menuData);
  console.log(`Extracted ${oysters.length} oyster items.`);

  // Step 5: Write output
  writeOutput(oysters);

  // Step 6: Save state
  saveState({ lastModifiedTime: lastModified, lastSync: new Date().toISOString() });

  console.log('Sync complete.');
}

main().catch(err => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
