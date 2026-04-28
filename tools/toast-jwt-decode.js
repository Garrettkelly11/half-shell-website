#!/usr/bin/env node
/**
 * Toast JWT Decode — diagnostic
 *
 * Authenticates against Toast with the credentials in `.env`, then decodes the
 * returned JWT (without verifying the signature — we just want to see the
 * claims) and prints what scopes and restaurant authorizations Toast actually
 * baked into the token.
 *
 * Use this when /menus/v2/menus or /metadata returns 403: the JWT will tell us
 * whether the issue is missing scopes, missing restaurant authorization, or
 * something else. The portal can show stale/aspirational state; the JWT shows
 * what the auth server actually issued.
 *
 * Usage (from Oyster Website folder):
 *   node tools/toast-jwt-decode.js
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
  TOAST_LOCATION_ID,
} = process.env;

for (const [k, v] of Object.entries({ TOAST_API_HOSTNAME, TOAST_CLIENT_ID, TOAST_CLIENT_SECRET, TOAST_LOCATION_ID })) {
  if (!v) {
    console.error(`ERROR: ${k} missing from .env`);
    process.exit(1);
  }
}

function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error(`Token does not look like a JWT (got ${parts.length} parts, expected 3)`);
  // base64url decode
  const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const json = Buffer.from(padded, 'base64').toString('utf8');
  return JSON.parse(json);
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
  return res.json();
}

(async () => {
  try {
    console.log(`Hitting ${TOAST_API_HOSTNAME} for restaurant ${TOAST_LOCATION_ID}…\n`);
    const body = await login();
    const token = body?.token?.accessToken || body?.accessToken;
    if (!token) throw new Error(`Unexpected login response shape:\n${JSON.stringify(body, null, 2)}`);

    console.log(`✓ Authenticated.`);
    console.log(`Token type: ${body?.token?.tokenType || body?.tokenType || '(unset)'}`);
    console.log(`Expires in: ${body?.token?.expiresIn || body?.expiresIn} seconds`);
    console.log(`Refresh token present: ${!!(body?.token?.refreshToken || body?.refreshToken)}`);

    const claims = decodeJwtPayload(token);
    console.log(`\n=== JWT claims ===`);
    console.log(JSON.stringify(claims, null, 2));

    // Highlight the fields that matter most for diagnosing 403s.
    console.log(`\n=== Diagnostic summary ===`);
    const scopes = claims.scope || claims.scopes || claims.authorities || claims.aud;
    console.log(`Scopes / authorities: ${Array.isArray(scopes) ? scopes.join(' ') : scopes ?? '(not in claims)'}`);
    console.log(`Subject (sub): ${claims.sub ?? '(none)'}`);
    console.log(`Issuer (iss): ${claims.iss ?? '(none)'}`);
    console.log(`Audience (aud): ${Array.isArray(claims.aud) ? claims.aud.join(', ') : claims.aud ?? '(none)'}`);

    // Toast often puts restaurant authorizations in custom claims — print any
    // non-standard claim so we can spot them.
    const standard = new Set(['iss', 'sub', 'aud', 'exp', 'iat', 'jti', 'nbf', 'scope', 'scopes', 'authorities', 'token_type', 'azp']);
    const custom = Object.fromEntries(Object.entries(claims).filter(([k]) => !standard.has(k)));
    if (Object.keys(custom).length) {
      console.log(`\n=== Custom claims (likely where restaurant auth lives) ===`);
      console.log(JSON.stringify(custom, null, 2));
    }

    console.log(`\nLooking for: a 'menus:read' (or similar) entry in scopes, AND a reference to restaurant GUID ${TOAST_LOCATION_ID} somewhere in the claims. If either is missing, that's the cause of the 403.`);
  } catch (err) {
    console.error(`\n✗ ${err.message}`);
    process.exit(1);
  }
})();
