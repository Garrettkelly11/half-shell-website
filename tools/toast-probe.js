#!/usr/bin/env node
/**
 * Toast API Probe — standalone diagnostic
 *
 * Runs locally (not in Cloud Functions). Authenticates against Toast with the
 * credentials in `.env`, then fetches the published menu and dumps a summary
 * of groups and items so we can discover:
 *   - Which menuGroup holds oysters
 *   - Which Toast GUIDs correspond to which Half Shell oyster slugs
 *   - Whether externalId is set on items (the clean mapping path)
 *
 * Usage (from Oyster Website folder):
 *   node tools/toast-probe.js
 *
 * Requirements: Node 18+ (for built-in fetch). No npm install needed.
 *
 * Output: writes full menu JSON to `tools/toast-menu-dump.json` and prints a
 * compact summary to stdout.
 */

const fs = require('fs');
const path = require('path');

// --- tiny .env loader (no dotenv dep) --------------------------------------
function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) {
    console.error(`ERROR: ${envPath} not found. Create it from .env.example.`);
    process.exit(1);
  }
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawVal] = match;
    // strip optional surrounding quotes
    const val = rawVal.replace(/^["'](.*)["']$/, '$1');
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadEnv(path.join(__dirname, '..', '.env'));

const {
  TOAST_API_HOSTNAME,
  TOAST_CLIENT_ID,
  TOAST_CLIENT_SECRET,
  TOAST_USER_ACCESS_TYPE = 'TOAST_MACHINE_CLIENT',
  TOAST_LOCATION_ID,
} = process.env;

for (const [k, v] of Object.entries({ TOAST_API_HOSTNAME, TOAST_CLIENT_ID, TOAST_CLIENT_SECRET, TOAST_LOCATION_ID })) {
  if (!v) {
    console.error(`ERROR: ${k} missing from .env`);
    process.exit(1);
  }
}

// --- main ------------------------------------------------------------------
async function login() {
  const res = await fetch(`${TOAST_API_HOSTNAME}/authentication/v1/authentication/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: TOAST_CLIENT_ID,
      clientSecret: TOAST_CLIENT_SECRET,
      userAccessType: TOAST_USER_ACCESS_TYPE,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Login failed: ${res.status} ${res.statusText}\n${text}`);
  }
  const body = await res.json();
  // Toast returns { token: { accessToken, expiresIn, tokenType, ... } }
  const token = body?.token?.accessToken || body?.accessToken;
  const expiresIn = body?.token?.expiresIn || body?.expiresIn;
  if (!token) throw new Error(`Unexpected login response shape:\n${JSON.stringify(body, null, 2)}`);
  return { token, expiresIn, rawLogin: body };
}

async function fetchMenu(token) {
  const res = await fetch(`${TOAST_API_HOSTNAME}/menus/v2/menus`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Toast-Restaurant-External-ID': TOAST_LOCATION_ID,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Menu fetch failed: ${res.status} ${res.statusText}\n${text}`);
  }
  return res.json();
}

async function fetchMetadata(token) {
  const res = await fetch(`${TOAST_API_HOSTNAME}/menus/v2/metadata`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Toast-Restaurant-External-ID': TOAST_LOCATION_ID,
    },
  });
  if (!res.ok) return null;
  return res.json();
}

function summarize(menu) {
  // The v2 published menu shape is typically:
  //   { menus: [ { name, menuGroups: [ { name, menuItems: [ { guid, name, externalId, price, ... } ] } ] } ] }
  // but variants exist; handle both top-level arrays and nested shapes.
  const menus = Array.isArray(menu) ? menu : menu?.menus || [];
  console.log(`\n=== ${menus.length} menu(s) ===`);
  for (const m of menus) {
    const groups = m.menuGroups || m.groups || [];
    console.log(`\nMenu: "${m.name}" (guid: ${m.guid || m.id})  — ${groups.length} group(s)`);
    for (const g of groups) {
      const items = g.menuItems || g.items || [];
      console.log(`  └ Group: "${g.name}"  (guid: ${g.guid || g.id})  — ${items.length} item(s)`);
      for (const it of items.slice(0, 40)) {
        const name = it.name;
        const guid = it.guid || it.id;
        const ext = it.externalId ? ` externalId=${it.externalId}` : ' [no externalId]';
        const price = it.price != null ? ` $${it.price}` : '';
        console.log(`      • ${name}  (${guid})${ext}${price}`);
      }
      if (items.length > 40) console.log(`      … and ${items.length - 40} more`);
    }
  }
}

(async () => {
  try {
    console.log(`Hitting ${TOAST_API_HOSTNAME} for restaurant ${TOAST_LOCATION_ID}…`);
    const { token, expiresIn } = await login();
    console.log(`✓ Authenticated. Token expires in ${expiresIn} seconds.`);

    const metadata = await fetchMetadata(token);
    if (metadata) {
      console.log(`\n=== Metadata ===`);
      console.log(JSON.stringify(metadata, null, 2));
    } else {
      console.log(`(metadata endpoint returned non-OK; continuing)`);
    }

    const menu = await fetchMenu(token);
    const outPath = path.join(__dirname, 'toast-menu-dump.json');
    fs.writeFileSync(outPath, JSON.stringify(menu, null, 2));
    console.log(`\n✓ Full menu payload written to ${outPath}`);

    summarize(menu);

    console.log(`\nNext step: look for an "Oysters" group above. Note the group GUID and whether items have externalId set.`);
  } catch (err) {
    console.error(`\n✗ ${err.message}`);
    process.exit(1);
  }
})();
