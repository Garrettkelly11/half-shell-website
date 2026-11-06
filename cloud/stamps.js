/**
 * Oyster Passport stamps, awarded on the server (audit finding L-passport-F02,
 * 05/11/2026). Before this, the page wrote stamp tiers itself, so a guest
 * could give themselves any medal from the browser console. Now:
 *
 *   - the page still works out stamps locally, to draw progress and to know
 *     when to ask (src/passport-store.js), but never writes a tier;
 *   - awardStamps (a callable in index.js) reads the guest's saved visits,
 *     works the stamps out with the same code the page uses
 *     (src/passport-core.js, data/stamps.js, data/flights.js,
 *     data/regions.js) and writes new tiers with seen: false;
 *   - the database rules refuse a tier or tierEarnedAt written by a guest
 *     (they may only set seen, after the celebration).
 *
 * Visits dated after today's business day are ignored (finding
 * L-passport-F01: the rules can't compare a date string with "now").
 *
 * Where the code comes from: `firebase deploy --only functions:cloud` runs
 * vendor-site.js first, which copies those four files into cloud/site/.
 * In the repo (node test.js) they are read from ../src and ../data.
 * The catalog changes whenever Merroir saves, so it is read from the live
 * site (https://hsoysters.com/data/oysters.js) every 10 minutes and parsed
 * as data — never run. If that fails, the copy taken at deploy is used.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SITE_DIR = fs.existsSync(path.join(__dirname, 'site', 'src', 'passport-core.js'))
  ? path.join(__dirname, 'site') : path.join(__dirname, '..');
const LIVE_CATALOG_URL = 'https://hsoysters.com/data/oysters.js';
const CATALOG_TTL_MS = 10 * 60 * 1000;
const SLUG_RE = /^[a-z0-9-]{1,60}$/;

let P = null, F = null, REGIONS = null;
function code() {
  if (!P) {
    REGIONS = require(path.join(SITE_DIR, 'data', 'regions.js'));
    require(path.join(SITE_DIR, 'data', 'stamps.js'));
    F = require(path.join(SITE_DIR, 'data', 'flights.js'));
    P = require(path.join(SITE_DIR, 'src', 'passport-core.js'));
  }
  return { P, F, REGIONS };
}

/**
 * data/oysters.js (Merroir's `var OYSTERS = [ { id: "x", ... }, ... ];`) as a
 * list, without running it: quote the keys, drop trailing commas, JSON.parse.
 * Throws if the file isn't in that shape.
 */
function parseCatalog(text) {
  const head = 'var OYSTERS = ';
  const start = text.indexOf(head);
  const end = text.lastIndexOf('];');
  if (start < 0 || end < start) throw new Error('catalog: no "var OYSTERS = [ ... ];"');
  const body = text.slice(start + head.length, end + 1)
    .replace(/^(\s*)([A-Za-z_$][\w$]*)\s*:/gm, '$1"$2":')
    .replace(/,(\s*[}\]])/g, '$1');
  const list = JSON.parse(body);
  if (!Array.isArray(list) || list.length < 10) throw new Error('catalog: fewer than 10 oysters');
  for (const o of list) {
    if (!o || typeof o !== 'object' || !SLUG_RE.test(o.id)) throw new Error('catalog: bad entry ' + JSON.stringify(o && o.id));
  }
  return list;
}

let catalogCache = { at: 0, list: null, source: '' };
/** The catalog: live site (cached 10 min), else the deploy-time copy. */
async function catalog(fetchFn, now) {
  if (catalogCache.list && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.list;
  try {
    const res = await fetchFn(LIVE_CATALOG_URL);
    if (!res || res.status !== 200) throw new Error(`answered ${res && res.status}`);
    catalogCache = { at: now, list: parseCatalog(await res.text()), source: 'live' };
  } catch (e) {
    console.warn('awardStamps: live catalog unavailable, using the deploy copy:', e.message);
    const list = parseCatalog(fs.readFileSync(path.join(SITE_DIR, 'data', 'oysters.js'), 'utf8'));
    catalogCache = { at: now - CATALOG_TTL_MS + 60 * 1000, list, source: 'copy' };   // retry live in a minute
  }
  return catalogCache.list;
}

/** Today's Curated Flights as lists of oyster ids (Flight Crew); same as Session.todayFlights. */
function todayFlights(F, oysters, servedIds, now) {
  const by = {};
  oysters.forEach((o) => { by[o.id] = o; });
  const served = servedIds.map((id) => by[id]).filter(Boolean);
  if (!served.length) return [];
  return F.selectFlights(served, F.rotationDate(new Date(now))).map((f) => f.oysters.map((o) => o.id));
}

/**
 * deps: { db, fetch, now?: () => ms, SyncError }
 * Returns { updates } — the paths written under users/{uid} (empty if nothing new).
 */
async function awardStamps(auth, deps) {
  const { db, SyncError } = deps;
  if (!auth || !auth.uid) throw new SyncError('unauthenticated', 'Sign in to collect stamps.');
  const provider = auth.token && auth.token.firebase && auth.token.firebase.sign_in_provider;
  if (provider !== 'phone') throw new SyncError('permission-denied', 'Stamps are for Oyster Passport accounts.');
  const now = (deps.now || Date.now)();
  const uid = auth.uid;

  const [userSnap, servingSnap] = await Promise.all([
    db.ref(`users/${uid}`).once('value'),
    db.ref('menu/serving').once('value'),
  ]);
  const user = userSnap.val() || {};
  if (!user.profile) throw new SyncError('failed-precondition', 'No passport for this account.');

  const { P, F, REGIONS } = code();
  const oysters = await catalog(deps.fetch, now);
  const today = P.businessDay(now);
  const visits = {};
  for (const [vid, v] of Object.entries(user.visits || {})) {
    if (v && typeof v.date === 'string' && v.date <= today) visits[vid] = v;   // future dates don't count
  }
  const evaluated = P.evaluateStamps({
    visits, oysters, regions: REGIONS, dob: user.profile.dob, today,
    todayFlights: todayFlights(F, oysters, Object.keys(servingSnap.val() || {}), now),
  });
  const updates = P.stampUpdates(user.stamps || {}, evaluated, now);
  if (Object.keys(updates).length) await db.ref(`users/${uid}`).update(updates);
  return { updates };
}

module.exports = {
  awardStamps, parseCatalog, todayFlights, LIVE_CATALOG_URL, SITE_DIR,
  _resetCache: () => { catalogCache = { at: 0, list: null, source: '' }; },
};
