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
 *   menu/happyHour/gameDay    = { state: 'on', until, percentOff, by, at }
 *       Game day happy hour (S7, Panthers games, half off): on from the
 *       switch until the next 4 AM New York time, or until switched off.
 *       Absent when off. Public.
 * Only the server (Admin SDK) writes any of these.
 */

'use strict';

const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const FOOD_MENU = 'Food Menu';
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

// ─── Reading Toast's menu ───────────────────────────────────────────────────

/**
 * Where tonight's oysters are read from: the Food Menu's Raw Bar group and
 * any groups inside it. Items elsewhere in Toast (Drinks, Lunch, Toast
 * Tables, other groups) are ignored, so a wine or a duplicate button that
 * shares an oyster's name can't put that oyster on the menu (10/30/2026).
 */
const RAW_BAR = { menu: FOOD_MENU, group: 'Raw Bar' };

/**
 * Every menu item with the name of the menu it sits in, the path of groups
 * above it ("Raw Bar › Sub"), and whether it is inside `scope` (a group
 * named scope.group, at any depth, in the menu named scope.menu). With no
 * scope every item is in scope.
 */
function* itemsWithMenu(menuData, scope) {
  for (const menu of (menuData && menuData.menus) || []) {
    const name = menu.name || '';
    const stack = (menu.menuGroups || []).map((g) => ({ g, path: [], inScope: false }));
    while (stack.length) {
      const { g, path, inScope } = stack.shift();
      const here = [...path, g.name || ''];
      const scoped = !scope || inScope || (name === scope.menu && g.name === scope.group);
      for (const item of g.menuItems || []) yield { item, menu: name, group: here.join(' › '), inScope: scoped };
      stack.push(...(g.menuGroups || []).map((c) => ({ g: c, path: here, inScope: scoped })));
    }
  }
}

/**
 * One pass over Toast's menu.
 *   matchSlug(item) → catalog id or null
 *   outOfStock      → Set of 86'd item GUIDs
 *   scope           → optional { menu, group } (see RAW_BAR); items outside
 *                     it are left out of everything below except `outside`
 * Returns:
 *   matched     — ids of in-stock oysters (tonight's menu)
 *   unmatched   — in-stock items no oyster matches
 *   skipped     — number of 86'd items
 *   scanned     — number of items in scope
 *   appearances — every matched item, 86'd or not: { id, price, strategy, menu }
 *   sources     — per matched id, every Toast item for it:
 *                 { name, guid, menu, group, inStock } — shows which item put
 *                 an oyster on the menu, and any 86'd copies beside it
 *   outside     — items outside the scope whose name matches an oyster:
 *                 { id, name, guid, menu, group, inStock } (ignored; logged)
 */
function scanMenu(menuData, matchSlug, outOfStock, scope) {
  const matched = [], seen = new Set(), unmatched = [], appearances = [], outside = [];
  const sources = {};
  let skipped = 0, scanned = 0;
  for (const { item, menu, group, inScope } of itemsWithMenu(menuData, scope)) {
    if (!item || !item.name) continue;
    const id = matchSlug(item);
    const inStock = !(item.guid && outOfStock.has(item.guid));
    if (!inScope) {
      if (id) outside.push({ id, name: item.name, guid: item.guid || null, menu, group, inStock });
      continue;
    }
    scanned++;
    if (id) {
      appearances.push({
        id, menu,
        price: typeof item.price === 'number' ? item.price : null,
        strategy: item.pricingStrategy || null,
      });
      (sources[id] = sources[id] || []).push({ name: item.name, guid: item.guid || null, menu, group, inStock });
    }
    if (!inStock) { skipped++; continue; }
    if (id) {
      if (!seen.has(id)) { seen.add(id); matched.push(id); }
    } else {
      unmatched.push({ name: item.name, guid: item.guid, price: item.price ?? null });
    }
  }
  return { matched, unmatched, skipped, scanned, appearances, sources, outside };
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

// ─── Game day happy hour (S7) ───────────────────────────────────────────────

const GAME_DAY_PERCENT = 50; // half off (Garrett, 09/10/2026)

/**
 * The game day setting after a switch press.
 *   action  'on' | 'off'
 *   current the stored setting (or null)
 *   cap     the next 4 AM New York time after `now`, in ms
 * Returns the new setting { state, until, percentOff }, or null for off.
 * Throws Error(message) for a press that can't be done.
 */
function gameDayChange(action, now, current, cap) {
  if (action === 'off') return null;
  if (action === 'on') {
    // Until the next 4 AM (Garrett, 12/10/2026).
    return { state: 'on', until: cap, percentOff: GAME_DAY_PERCENT };
  }
  throw new Error('Game day is on or off.');
}

module.exports = {
  DAYS, FOOD_MENU, RAW_BAR, itemsWithMenu, scanMenu, collectPrices, priceUpdates, validateSchedule, describeSchedule,
  GAME_DAY_PERCENT, gameDayChange,
};
