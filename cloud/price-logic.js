/**
 * Prices from Toast and the happy hour setting (Data Ownership Build Guide
 * S5; "Price and Happy Hour Plan", decided 06/10/2026). Pure functions,
 * shared by the Toast sync (tools/sync-toast-to-firebase.js) and the
 * setHappyHour server function (cloud/lib.js). Tested by cloud/test.js.
 *
 * Database shape:
 *   menu/prices/{id}          = { price, strategy, updatedAt }
 *       Toast's regular price for every oyster the sync matches, 86'd or
 *       not. `price` is null for an open (market) price. Written only when
 *       it changes; never deleted, so an oyster that leaves Toast keeps its
 *       last Toast price. Public.
 *   menu/happyHour/schedule   = { days, start, end, percentOff, by, at }
 *       The standing rule, e.g. MON–THU, "15:00"–"18:00", 50. Public.
 *   menu/happyHour/today      = { state: 'on'|'off', until, by, at }
 *       The employee page's switch for today; lasts until the next 4 AM
 *       New York time, then the schedule applies again. Public.
 * Only the server (Admin SDK) writes any of these.
 */

'use strict';

const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const FOOD_MENU = 'Food Menu';
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

// ─── Reading Toast's menu ───────────────────────────────────────────────────

/** Every menu item with the name of the menu it sits in. */
function* itemsWithMenu(menuData) {
  for (const menu of (menuData && menuData.menus) || []) {
    const stack = [...(menu.menuGroups || [])];
    while (stack.length) {
      const g = stack.shift();
      for (const item of g.menuItems || []) yield { item, menu: menu.name || '' };
      stack.push(...(g.menuGroups || []));
    }
  }
}

/**
 * One pass over Toast's menu.
 *   matchSlug(item) → catalog id or null
 *   outOfStock      → Set of 86'd item GUIDs
 * Returns:
 *   matched     — ids of in-stock oysters (tonight's menu, as before)
 *   unmatched   — in-stock items no oyster matches
 *   skipped     — number of 86'd items
 *   appearances — every matched item, 86'd or not: { id, price, strategy, menu }
 */
function scanMenu(menuData, matchSlug, outOfStock) {
  const matched = [], seen = new Set(), unmatched = [], appearances = [];
  let skipped = 0;
  for (const { item, menu } of itemsWithMenu(menuData)) {
    if (!item || !item.name) continue;
    const id = matchSlug(item);
    if (id) {
      appearances.push({
        id, menu,
        price: typeof item.price === 'number' ? item.price : null,
        strategy: item.pricingStrategy || null,
      });
    }
    if (item.guid && outOfStock.has(item.guid)) { skipped++; continue; }
    if (id) {
      if (!seen.has(id)) { seen.add(id); matched.push(id); }
    } else {
      unmatched.push({ name: item.name, guid: item.guid, price: item.price ?? null });
    }
  }
  return { matched, unmatched, skipped, appearances };
}

/**
 * One price per oyster. If an oyster sits in several Toast menus at
 * different prices, the Food Menu's is used and the difference is
 * reported. Returns { prices: {id: {price, strategy}}, conflicts: [text] }.
 */
function collectPrices(appearances) {
  const byId = {};
  for (const a of appearances) (byId[a.id] = byId[a.id] || []).push(a);
  const prices = {}, conflicts = [];
  for (const [id, list] of Object.entries(byId)) {
    const pick = list.find((a) => a.menu === FOOD_MENU) || list[0];
    const distinct = new Set(list.map((a) => `${a.price}|${a.strategy}`));
    if (distinct.size > 1) {
      conflicts.push(`${id}: ` + list.map((a) => `${a.menu} ${a.price === null ? a.strategy : '$' + a.price.toFixed(2)}`).join(', ')
        + ` — using ${pick.menu}`);
    }
    prices[id] = { price: pick.price, strategy: pick.strategy };
  }
  return { prices, conflicts };
}

/**
 * The menu/prices writes (keys relative to menu/): only oysters whose price
 * or pricing type changed, or that have no entry yet. Never deletes.
 */
function priceUpdates(prices, current, now) {
  const updates = {}, changed = [];
  for (const [id, p] of Object.entries(prices)) {
    const cur = (current || {})[id];
    if (cur && cur.price === p.price && cur.strategy === p.strategy) continue;
    updates[`prices/${id}`] = { price: p.price, strategy: p.strategy, updatedAt: now };
    changed.push({ id, from: cur ? cur.price : undefined, to: p.price });
  }
  return { updates, changed };
}

// ─── Happy hour setting ─────────────────────────────────────────────────────

/** Validates the standing rule. Returns it tidied, or throws Error(message). */
function validateSchedule(s) {
  if (!s || typeof s !== 'object') throw new Error('Nothing to save.');
  const days = Array.isArray(s.days) ? [...new Set(s.days.map((d) => String(d).toUpperCase()))] : [];
  if (!days.length) throw new Error('Pick at least one day.');
  if (days.some((d) => !DAYS.includes(d))) throw new Error('Unknown day.');
  const start = String(s.start || ''), end = String(s.end || '');
  if (!TIME.test(start) || !TIME.test(end)) throw new Error('Times look like 15:00.');
  if (start >= end) throw new Error('Happy hour has to end after it starts (and before midnight).');
  const pct = Number(s.percentOff);
  if (!Number.isInteger(pct) || pct < 1 || pct > 99) throw new Error('Percent off is a whole number from 1 to 99.');
  return { days: DAYS.filter((d) => days.includes(d)), start, end, percentOff: pct };
}

const DAY_NAMES = { MON: 'Mon', TUE: 'Tue', WED: 'Wed', THU: 'Thu', FRI: 'Fri', SAT: 'Sat', SUN: 'Sun' };

/** "Mon–Thu 15:00–18:00, 50% off" for logs. Runs of days are joined. */
function describeSchedule(s) {
  const idx = s.days.map((d) => DAYS.indexOf(d)).sort((a, b) => a - b);
  const runs = [];
  for (const i of idx) {
    const last = runs[runs.length - 1];
    if (last && i === last[1] + 1) last[1] = i; else runs.push([i, i]);
  }
  const days = runs.map(([a, b]) => a === b ? DAY_NAMES[DAYS[a]]
    : b === a + 1 ? `${DAY_NAMES[DAYS[a]]}, ${DAY_NAMES[DAYS[b]]}` : `${DAY_NAMES[DAYS[a]]}–${DAY_NAMES[DAYS[b]]}`).join(', ');
  return `${days} ${s.start}–${s.end}, ${s.percentOff}% off`;
}

module.exports = {
  DAYS, FOOD_MENU, itemsWithMenu, scanMenu, collectPrices, priceUpdates, validateSchedule, describeSchedule,
};
