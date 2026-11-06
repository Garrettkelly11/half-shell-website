#!/usr/bin/env node
/**
 * Toast drinks check (bar menu). Read-only: asks Toast for the menu and the
 * 86 list, runs the same reader the Toast sync uses for the Drinks menu
 * (scanDrinks in cloud/price-logic.js) and prints what the bar menu would
 * match on: every item's name, the name guests would see, section, price or
 * sizes and 86 status, plus anything that could trip the match (same name
 * twice, prefixes, odd characters, items with no usable price).
 *
 * Usage (from the "Oyster Website" folder):
 *   node tools/toast-drinks-check.js            # asks Toast (needs .env)
 *   node tools/toast-drinks-check.js --dump tools/toast-menu-dump.json   # an older saved copy, no network
 *   node tools/toast-drinks-check.js --out "..\Toast Drinks Check.md"
 * Never prints credentials. Writes nothing to Toast or Firebase. Node 18+.
 */
'use strict';
const fs = require('fs'), path = require('path');
const P = require('../cloud/price-logic.js'), D = require('../src/drinks-core.js');

const env = {};
try {
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (e) { console.error('No .env found here.'); process.exit(1); }
const HOST = env.TOAST_API_HOSTNAME || 'https://ws-api.toasttab.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outIdx = process.argv.indexOf('--out'), dumpIdx = process.argv.indexOf('--dump');

(async () => {
  let menu, out86 = new Set(), stockRes = { ok: true };
  if (dumpIdx > 0) {
    menu = JSON.parse(fs.readFileSync(process.argv[dumpIdx + 1], 'utf8'));
    menu = menu.menus ? menu : (menu.data || menu);
    stockRes = { ok: false, status: 'not asked (saved copy)' };
  } else {
    const auth = await fetch(`${HOST}/authentication/v1/authentication/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: env.TOAST_CLIENT_ID, clientSecret: env.TOAST_CLIENT_SECRET, userAccessType: env.TOAST_USER_ACCESS_TYPE || 'TOAST_MACHINE_CLIENT' }),
    });
    if (!auth.ok) throw new Error(`Toast login failed: ${auth.status}`);
    const token = (await auth.json()).token.accessToken;
    const h = { Authorization: `Bearer ${token}`, 'Toast-Restaurant-External-ID': env.TOAST_LOCATION_ID };
    await sleep(1100);
    stockRes = await fetch(`${HOST}/stock/v1/inventory`, { headers: h });
    const stock = stockRes.ok ? await stockRes.json() : null;
    out86 = new Set((Array.isArray(stock) ? stock : []).filter((r) => r.status === 'OUT_OF_STOCK').map((r) => r.guid));
    await sleep(1100);
    const menuRes = await fetch(`${HOST}/menus/v2/menus`, { headers: h });
    if (!menuRes.ok) throw new Error(`Menu fetch failed: ${menuRes.status}`);
    menu = await menuRes.json();
  }

  const menuNames = (menu.menus || []).map((m) => m.name);
  const r = P.scanDrinks(menu, out86, D.toastKey);
  const rows = Object.entries(r.items).sort((a, b) => a[1].order - b[1].order);
  const money = (c) => D.money(c);
  const priceOf = (i) => i.sizes ? i.sizes.map((z) => `${z.name} ${money(z.price)}`).join(' / ') : i.price !== undefined ? money(i.price) : `(${i.strategy || 'no price'})`;
  const lines = [];
  lines.push(`# Toast drinks check (${new Date().toISOString()})`, '',
    `Menus in Toast: ${menuNames.join(', ')}`,
    `Stock API: ${dumpIdx > 0 ? 'not asked (saved copy), so 86 status is not shown' : stockRes.ok ? 'ok, ' + out86.size + ' items 86\'d' : 'FAILED ' + stockRes.status + ' (every drink would look in stock)'}`,
    `Items read from the "${P.DRINKS_MENU}" menu: ${r.scanned}; distinct names after matching: ${rows.length}; 86'd now: ${rows.filter(([, i]) => !i.inStock).length}`, '');
  if (!r.scanned) lines.push(`NO ITEMS in a menu named exactly "${P.DRINKS_MENU}". The sync would keep the old list. Menu names above show what it is called.`, '');
  lines.push('## Items (section | Toast name | name guests see | match key | price | 86)', '');
  let last = null;
  for (const [key, i] of rows) {
    if (i.group !== last) { last = i.group; lines.push('', `### ${i.path}`); }
    lines.push(`- ${JSON.stringify(i.name)} → ${JSON.stringify(D.cleanName(i.name))} [${key}] ${priceOf(i)}${i.inStock ? '' : ' (86\'d)'}`);
  }
  const prefixed = rows.filter(([, i]) => /^(dft|can|btl)\s/i.test(i.name)).length;
  const odd = rows.filter(([, i]) => /[^\x20-\x7E]|\s{2,}|^\s|\s$/.test(i.name));
  const noPrice = rows.filter(([, i]) => i.price === undefined && !i.sizes);
  lines.push('', '## Things to look at', '',
    `- Same name more than once (one is kept, in stock first): ${r.duplicates.length ? r.duplicates.map((d) => JSON.stringify(d)).join(', ') : 'none'}`,
    `- Names with a DFT/CAN/BTL prefix (dropped when matching and showing): ${prefixed}`,
    `- Names with accents, odd spaces or non-keyboard characters: ${odd.length ? odd.map(([, i]) => JSON.stringify(i.name)).join(', ') : 'none'}`,
    `- Items with no usable price (open price, or a size group that is missing): ${noPrice.length ? noPrice.map(([, i]) => JSON.stringify(i.name) + ' ' + i.strategy).join(', ') : 'none'}`);
  const text = lines.join('\n') + '\n';
  if (outIdx > 0 && process.argv[outIdx + 1]) { fs.writeFileSync(process.argv[outIdx + 1], text); console.log('Wrote ' + process.argv[outIdx + 1]); }
  console.log(lines.filter((l) => !l.startsWith('- "')).join('\n'));
})().catch((e) => { console.error('Failed: ' + e.message); process.exit(1); });
