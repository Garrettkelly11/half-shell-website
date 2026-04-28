#!/usr/bin/env node
/**
 * Toast Partners — list accessible restaurants
 *
 * Authenticates with the OysterMenu credential, then calls the Partners API
 * `GET /partners/v1/restaurants` endpoint. This returns the list of restaurants
 * this credential has been granted access to, with their canonical location
 * and management-group GUIDs.
 *
 * Use case: Toast support indicated the restaurant GUID we have on file is
 * invalid. This script asks Toast directly which restaurants the credential is
 * authorized for, and prints their real GUIDs so we can update `.env` with the
 * correct value.
 *
 * Usage (from Oyster Website folder):
 *   node tools/toast-list-restaurants.js
 *
 * Requirements: Node 18+ (built-in fetch). No npm install needed.
 */

const fs = require('fs');
const path = require('path');

function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) {
    console.error(`ERROR: ${envPath} not found.`);
    process.exit(1);
  }
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawVal] = match;
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
} = process.env;

for (const [k, v] of Object.entries({ TOAST_API_HOSTNAME, TOAST_CLIENT_ID, TOAST_CLIENT_SECRET })) {
  if (!v) {
    console.error(`ERROR: ${k} missing from .env`);
    process.exit(1);
  }
}

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
  return body?.token?.accessToken || body?.accessToken;
}

async function listRestaurants(token) {
  const url = `${TOAST_API_HOSTNAME}/partners/v1/restaurants`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET ${url}\n${res.status} ${res.statusText}\n${text}`);
  }
  return JSON.parse(text);
}

(async () => {
  try {
    console.log(`Hitting ${TOAST_API_HOSTNAME}…\n`);
    const token = await login();
    console.log(`✓ Authenticated.`);

    const restaurants = await listRestaurants(token);
    console.log(`\n=== /partners/v1/restaurants response ===`);
    console.log(JSON.stringify(restaurants, null, 2));

    const arr = Array.isArray(restaurants) ? restaurants : (restaurants?.restaurants || []);
    console.log(`\n=== Summary ===`);
    if (!arr.length) {
      console.log(`No restaurants returned. The credential is authenticated but has no restaurant access granted yet — Toast support will need to grant access.`);
    } else {
      console.log(`${arr.length} restaurant(s) accessible:`);
      for (const r of arr) {
        const guid = r.restaurantGuid || r.locationGuid || r.guid || '(no guid field)';
        const name = r.restaurantName || r.name || '(no name field)';
        const mgmt = r.managementGroupGuid ? ` mgmtGroup=${r.managementGroupGuid}` : '';
        const externalId = r.externalGroupRef || r.externalRestaurantRef || '';
        console.log(`  • ${name}  guid=${guid}${mgmt}${externalId ? `  externalRef=${externalId}` : ''}`);
      }
      console.log(`\nUse the guid above as TOAST_LOCATION_ID in .env, then re-run node tools/toast-probe.js`);
    }
  } catch (err) {
    console.error(`\n✗ ${err.message}`);
    process.exit(1);
  }
})();
