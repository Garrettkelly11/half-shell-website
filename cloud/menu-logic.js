/**
 * Tonight's menu: Toast's in-stock oysters plus employee-page overrides
 * (Data Ownership Build Guide, step S6). Pure functions, shared by the
 * Toast sync (tools/sync-toast-to-firebase.js) and the setMenuOverride
 * server function (cloud/lib.js), so both always compose the menu the
 * same way. Tested by cloud/test.js.
 *
 * Database shape:
 *   menu/serving/{id}      = { addedAt, lastUpdated, source: 'toast'|'override' }
 *                            (public; what the menu pages show)
 *   menu/overrides/{id}    = { state: 'on'|'off', until, by, at }
 *                            (staff can read; only the server writes)
 *   menu/toastInStock/{id} = true   (the last sync's Toast in-stock list;
 *                            server only — lets "Back to Toast" answer
 *                            at once instead of waiting for the next sync)
 *
 * serving = (Toast in stock ∪ overrides 'on') − overrides 'off', counting
 * only overrides whose `until` is still ahead. `until` is the next
 * 4:00 AM America/New_York after the override was set (Garrett,
 * 02/10/2026): after close and after the last sync of the night.
 */

'use strict';

const ZONE = 'America/New_York';
const CLOSE_HOUR = 4;

/** Wall-clock parts of `ms` in New York. */
function nyParts(ms) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const { type, value } of f.formatToParts(new Date(ms))) p[type] = Number(value);
  return p;
}

/** UTC ms of a New York wall-clock time (exact for 4 AM: DST changes at 2 AM). */
function nyToUtc(y, mo, d, h) {
  let guess = Date.UTC(y, mo - 1, d, h);
  for (let i = 0; i < 3; i++) {
    const p = nyParts(guess);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const want = Date.UTC(y, mo - 1, d, h);
    if (shown === want) break;
    guess += want - shown;
  }
  return guess;
}

/** The next 4:00 AM New York time strictly after `ms`. */
function next4am(ms) {
  const p = nyParts(ms);
  let at = nyToUtc(p.year, p.month, p.day, CLOSE_HOUR);
  if (at <= ms) {
    const tomorrow = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    at = nyToUtc(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), CLOSE_HOUR);
  }
  return at;
}

function isActive(override, now) {
  return !!override && typeof override.until === 'number' && override.until > now
    && (override.state === 'on' || override.state === 'off');
}

/** Split overrides into active ones and the ids of expired ones. */
function splitOverrides(overrides, now) {
  const active = {}, expired = [];
  for (const [id, o] of Object.entries(overrides || {})) {
    if (isActive(o, now)) active[id] = o; else expired.push(id);
  }
  return { active, expired };
}

/** The ids on tonight's menu. toast: iterable of ids; active: {id: override}. */
function compose(toast, active) {
  const out = new Set(toast);
  for (const [id, o] of Object.entries(active || {})) {
    if (o.state === 'on') out.add(id);
    else if (o.state === 'off') out.delete(id);
  }
  return out;
}

/** The menu/serving entry for an id that is on the menu. */
function servingEntry(id, current, active, now) {
  const prev = current && current[id];
  const source = active && active[id] && active[id].state === 'on' ? 'override' : 'toast';
  return { addedAt: (prev && prev.addedAt) || now, lastUpdated: now, source };
}

/**
 * Database updates (paths relative to menu/) that bring menu/serving in
 * line for `ids`, given Toast's list and the active overrides.
 */
function servingUpdates(ids, toast, active, current, now) {
  const on = compose(toast, active);
  const updates = {};
  for (const id of ids) {
    updates[`serving/${id}`] = on.has(id) ? servingEntry(id, current, active, now) : null;
  }
  return updates;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * What one Toast sync writes (paths relative to menu/), given Toast's
 * in-stock catalog ids, the current menu/serving and menu/overrides.
 *   - serving becomes exactly (Toast ∪ active 'on') − active 'off';
 *     anything else is removed, whoever added it;
 *   - expired overrides are deleted;
 *   - toastInStock is replaced with Toast's list;
 *   - one-time carry-over: an entry added on the old employee page
 *     (source 'staff') with no override becomes an 'on' override until
 *     the next 4 AM, so nothing drops off mid-service on deploy day.
 */
function planSync(toastIds, current, overrides, now) {
  current = current || {};
  const { active, expired } = splitOverrides(overrides, now);
  const updates = {};
  const migrated = [];
  for (const [id, e] of Object.entries(current)) {
    if (e && e.source === 'staff' && !active[id]) {
      active[id] = { state: 'on', until: next4am(now), by: 'Employee page (before overrides)',
        at: typeof e.addedAt === 'number' ? e.addedAt : now };
      updates[`overrides/${id}`] = active[id];
      migrated.push(id);
    }
  }
  for (const id of expired) updates[`overrides/${id}`] = null;

  const on = compose(toastIds, active);
  let added = 0, refreshed = 0, removed = 0;
  for (const id of on) {
    if (current[id]) refreshed++; else added++;
    updates[`serving/${id}`] = servingEntry(id, current, active, now);
  }
  for (const id of Object.keys(current)) {
    if (!on.has(id)) { updates[`serving/${id}`] = null; removed++; }
  }
  const stock = {};
  for (const id of toastIds) stock[id] = true;
  updates.toastInStock = stock;
  const forcedOn = Object.values(active).filter((o) => o.state === 'on').length;
  const forcedOff = Object.values(active).filter((o) => o.state === 'off').length;
  return { updates, added, refreshed, removed, migrated, expired: expired.length, forcedOn, forcedOff };
}

module.exports = {
  ZONE, CLOSE_HOUR, SLUG, nyParts, nyToUtc, next4am, isActive, splitOverrides, compose,
  servingEntry, servingUpdates, planSync,
};
