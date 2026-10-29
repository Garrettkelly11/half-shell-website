/*
 * Oyster Passport — the logic, with no Firebase and no page code.
 * Oyster Passport Build Sheet section 6 (revised 19–20/10/2026).
 *
 * Loaded by the Passport pages as a global (HS_PASSPORT) and by
 * tools/passport-test.js via require. Pure functions: same input, same
 * output. src/passport-store.js does the reading and writing.
 *
 * Needs:
 *   data/stamps.js   (HS_STAMPS)   for stamps
 *   data/flights.js  (HS_FLIGHTS)  for salinity and size ranks (palate,
 *                                  recommendations), so they read the
 *                                  catalog exactly as Curated Flights does
 * Pages load those first. Node requires them from the repo.
 *
 * Shapes (Build Sheet section 3):
 *   visits    { visitId: { date, startedAt, lastChangedAt, closedAt?,
 *               closeReason?, source, items: { oysterId: { qty, rating?,
 *               twoWords?, note?, addedAt } }, flightsLogged? } }
 *   oysters   the catalog (OYSTERS), current oysters only
 *   regions   HS_REGIONS
 * Functions that change data return a multi-path update relative to
 * users/{uid} (e.g. { 'visits/v1/items/kumamoto/qty': 2 }), for the store
 * to send in one update().
 */
(function (root) {
  'use strict';

  var ZONE = 'America/New_York';
  var OPENING_DAY = '2026-02-03';
  var DAY_ROLLOVER_HOUR = 4;            // Toast's business day ends at 4 AM
  var TIMEOUT_MS = 6 * 3600e3;          // a visit closes after 6 h with no changes
  var MAX_QTY = 99;
  var NAME_MAX = 60, EMAIL_MAX = 120, TWO_WORDS_MAX = 40, NOTE_MAX = 280;
  var MIN_AGE = 18, PROMO_AGE = 21;
  var UNLOCK_RATED = 5;                 // palate and "You might like"
  var CARD_BRANDS = [
    { code: 'VISA', label: 'Visa' },
    { code: 'MASTERCARD', label: 'Mastercard' },
    { code: 'AMEX', label: 'Amex' },
    { code: 'DISCOVER', label: 'Discover' },
    { code: 'OTHER', label: 'Other' }
  ];
  // The rules use [^ @] (their regular expressions have no \s); this is a little stricter.
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var SLUG_RE = /^[a-z0-9-]{1,60}$/;

  // ── Loading the data files ────────────────────────────────────────────────
  function need(name, file) {
    var v = root[name];
    if (!v && typeof require === 'function') {
      try { v = require('../' + file); } catch (e) { /* reported below */ }
    }
    if (!v) throw new Error('src/passport-core.js: ' + name + ' is missing. Load ' + file + ' first.');
    return v;
  }
  function stamps() { return need('HS_STAMPS', 'data/stamps.js'); }
  function flights() { return need('HS_FLIGHTS', 'data/flights.js'); }

  // ── Dates ─────────────────────────────────────────────────────────────────
  var fmt = null;
  function nyParts(ms) {
    if (!fmt) {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit'
      });
    }
    var p = {};
    fmt.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24 };
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }
  function parseDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
  }
  /** A real calendar date written YYYY-MM-DD. */
  function isRealDate(s) {
    var p = parseDate(s);
    if (!p) return false;
    var t = new Date(Date.UTC(p.y, p.m - 1, p.d));
    return t.getUTCFullYear() === p.y && t.getUTCMonth() === p.m - 1 && t.getUTCDate() === p.d;
  }
  function addDays(s, n) {
    var p = parseDate(s);
    return new Date(Date.UTC(p.y, p.m - 1, p.d) + n * 864e5).toISOString().slice(0, 10);
  }
  function daysBetween(a, b) {   // b − a, in days
    var pa = parseDate(a), pb = parseDate(b);
    return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 864e5);
  }
  /** New York calendar date (rolls over at midnight). For ages and birthdays. */
  function nyDate(ms) {
    var p = nyParts(ms);
    return ymd(p.y, p.m, p.d);
  }
  /** Toast's business day: New York date, rolling over at 4 AM. For visits and hereOn. */
  function businessDay(ms) {
    var p = nyParts(ms), s = ymd(p.y, p.m, p.d);
    return p.h < DAY_ROLLOVER_HOUR ? addDays(s, -1) : s;
  }
  /** A past-visit date: opening day (03/02/2026) to today's business day. */
  function isVisitDate(s, today) {
    return isRealDate(s) && s >= OPENING_DAY && s <= today;
  }

  // ── Age and birthday ──────────────────────────────────────────────────────
  function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
  /** That year's birthday. Feb 29 is Feb 28 in other years. */
  function birthdayIn(dob, year) {
    var p = parseDate(dob);
    var d = p.m === 2 && p.d === 29 && !isLeap(year) ? 28 : p.d;
    return ymd(year, p.m, d);
  }
  /** Whole years old on `today` (YYYY-MM-DD, New York). */
  function age(dob, today) {
    var b = parseDate(dob), t = parseDate(today);
    var a = t.y - b.y;
    if (today < birthdayIn(dob, t.y)) a--;
    return a;
  }
  /** Sign-up birthday check: null if fine, else 'format' | 'year' | 'future'. */
  function checkDob(dob, today) {
    if (!isRealDate(dob)) return 'format';
    if (parseDate(dob).y < 1900) return 'year';
    if (dob > today) return 'future';
    return null;
  }
  function isUnderMinAge(dob, today) { return age(dob, today) < MIN_AGE; }
  /** Every alcohol promotion goes through this (21+). */
  function canShowAlcoholPromo(profile, today) {
    return !!(profile && isRealDate(profile.dob)) && age(profile.dob, today) >= PROMO_AGE;
  }
  /** Within 3 days of a birthday (any year, so Dec 30 and Jan 1 work). */
  function inBirthdayWeek(dob, date) {
    if (!isRealDate(dob) || !isRealDate(date)) return false;
    var y = parseDate(date).y;
    for (var yy = y - 1; yy <= y + 1; yy++) {
      if (Math.abs(daysBetween(birthdayIn(dob, yy), date)) <= 3) return true;
    }
    return false;
  }

  // ── Field checks (the page enforces what the rules can't) ─────────────────
  function cleanName(s) { return String(s || '').trim().replace(/\s+/g, ' '); }
  function validName(s) { var n = cleanName(s); return n.length >= 1 && n.length <= NAME_MAX; }
  function validEmail(s) { s = String(s || '').trim(); return s.length <= EMAIL_MAX && EMAIL_RE.test(s); }
  function words(s) { return String(s || '').match(/[^\s,]+/g) || []; }
  /** "this oyster in two words": at most 2 words, 40 chars. Hyphenated words count once. */
  function validTwoWords(s) { return words(s).length <= 2 && String(s || '').length <= TWO_WORDS_MAX; }
  /** For the input: cuts a third word as it is typed, and anything past 40 chars. */
  function limitTwoWords(s) {
    s = String(s || '');
    var re = /[^\s,]+/g, m, n = 0;
    while ((m = re.exec(s))) { if (++n === 3) { s = s.slice(0, m.index); break; } }
    return s.slice(0, TWO_WORDS_MAX);
  }
  function validNote(s) { return String(s || '').length <= NOTE_MAX; }
  function validCard(c) {
    return !!c && /^[0-9]{4}$/.test(String(c.last4 || '')) &&
      CARD_BRANDS.some(function (b) { return b.code === c.brand; });
  }
  function brandLabel(code) {
    var b = CARD_BRANDS.filter(function (x) { return x.code === code; })[0];
    return b ? b.label : 'Card';
  }
  function validQty(q) { return typeof q === 'number' && q % 1 === 0 && q >= 1 && q <= MAX_QTY; }

  // ── Visits ────────────────────────────────────────────────────────────────
  function items(v) { return (v && v.items) || {}; }
  function visitTotal(v) {
    var t = 0, it = items(v);
    Object.keys(it).forEach(function (k) { t += it[k].qty || 0; });
    return t;
  }
  function isEmpty(v) { return !Object.keys(items(v)).length; }
  function isOpen(v) { return !!v && !v.closedAt; }
  function openVisit(state) {
    var id = state && state.activeVisitId, v = id && state.visits && state.visits[id];
    return isOpen(v) ? { id: id, visit: v } : null;
  }
  /** The visit on a date, if any (for "Log a past visit": offer to add to it). */
  function visitOnDate(visits, date) {
    var ids = Object.keys(visits || {}).filter(function (k) { return visits[k].date === date; });
    return ids.length ? ids.sort()[0] : null;
  }

  /** Updates that close a visit. An empty visit is deleted instead. */
  function closeUpdates(state, visitId, reason, closedAt) {
    var u = {}, v = state.visits[visitId];
    if (isEmpty(v)) u['visits/' + visitId] = null;
    else {
      u['visits/' + visitId + '/closedAt'] = closedAt;
      u['visits/' + visitId + '/closeReason'] = reason;
    }
    if (state.activeVisitId === visitId) u.activeVisitId = null;
    return u;
  }
  /** On load and focus: the open visit closes 6 h after its last change. Null if nothing to do. */
  function timeoutUpdates(state, now) {
    var o = openVisit(state);
    if (!o) {
      // activeVisitId pointing at a missing or closed visit: clear it.
      return state && state.activeVisitId ? { activeVisitId: null } : null;
    }
    if (!(now - o.visit.lastChangedAt > TIMEOUT_MS)) return null;
    return closeUpdates(state, o.id, 'timeout', o.visit.lastChangedAt + TIMEOUT_MS);
  }
  /** Save Entry. */
  function saveUpdates(state, now) {
    var o = openVisit(state);
    return o ? closeUpdates(state, o.id, 'saved', now) : null;
  }
  function newVisitFields(base, date, now) {
    var u = {};
    u[base + 'date'] = date;
    u[base + 'startedAt'] = now;
    u[base + 'lastChangedAt'] = now;
    u[base + 'source'] = 'manual';
    return u;
  }
  /**
   * Add `delta` (may be negative) of an oyster to the open visit, opening
   * one (today, `newId`) if none is open. qty stays within 1–99; at 0 the
   * item is removed. Returns { visitId, qty, updates }.
   */
  function addUpdates(state, oysterId, delta, now, newId) {
    var o = openVisit(state), u = {}, id, v;
    if (!o && !(delta > 0)) return { visitId: null, qty: 0, updates: u };
    if (o) { id = o.id; v = o.visit; }
    else {
      id = newId; v = {};
      Object.assign(u, newVisitFields('visits/' + id + '/', businessDay(now), now));
      u.activeVisitId = id;
    }
    var base = 'visits/' + id + '/items/' + oysterId;
    var cur = items(v)[oysterId];
    var qty = Math.min(MAX_QTY, ((cur && cur.qty) || 0) + delta);
    if (qty <= 0) { qty = 0; if (cur) u[base] = null; }
    else {
      u[base + '/qty'] = qty;
      if (!cur) u[base + '/addedAt'] = now;
    }
    u['visits/' + id + '/lastChangedAt'] = now;
    return { visitId: id, qty: qty, updates: u };
  }
  /** "Log this flight": 1 more of every oyster in it, including ones already logged. */
  function logFlightUpdates(state, flightSlug, oysterIds, now, newId) {
    if (!oysterIds || !oysterIds.length) return { visitId: null, updates: {} };
    var r = addUpdates(state, oysterIds[0], 1, now, newId);
    var u = r.updates, id = r.visitId;
    var v = (state.visits && state.visits[id]) || {};
    oysterIds.slice(1).forEach(function (oid) {
      var cur = items(v)[oid], base = 'visits/' + id + '/items/' + oid;
      u[base + '/qty'] = Math.min(MAX_QTY, ((cur && cur.qty) || 0) + 1);
      if (!cur) u[base + '/addedAt'] = now;
    });
    oysterIds.forEach(function (oid) { u['visits/' + id + '/flightsLogged/' + flightSlug + '/' + oid] = true; });
    return { visitId: id, updates: u };
  }
  /** "Log a past visit": created closed, never the open visit. */
  function backdatedUpdates(newId, date, itemQtys, now) {
    var base = 'visits/' + newId + '/', u = newVisitFields(base, date, now);
    u[base + 'closedAt'] = now;
    u[base + 'closeReason'] = 'backdated';
    Object.keys(itemQtys).forEach(function (oid) {
      u[base + 'items/' + oid + '/qty'] = Math.min(MAX_QTY, itemQtys[oid]);
      u[base + 'items/' + oid + '/addedAt'] = now;
    });
    return u;
  }
  /** "Here today" dates remembered while signed out, kept from the day before sign-up. */
  function hereOnCarry(dates, signupDay) {
    var from = addDays(signupDay, -1);
    return (dates || []).filter(function (d) { return isRealDate(d) && d >= from && d <= signupDay; });
  }
  /** Flight name → the slug used in flightsLogged ("Shucker's Choice" → "shuckers-choice"). */
  function flightSlug(name) {
    return String(name || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '').slice(0, 60);
  }

  // ── Ratings ───────────────────────────────────────────────────────────────
  /**
   * A guest's rating of each oyster: square-root-weighted by quantity across
   * visits; unrated visits ignored (6.3). { oysterId: { rating, visits, qty } }
   */
  function aggregateRatings(visits) {
    var acc = {};
    Object.keys(visits || {}).forEach(function (vid) {
      var it = items(visits[vid]);
      Object.keys(it).forEach(function (oid) {
        var x = it[oid];
        if (!(x.rating >= 1)) return;
        var w = Math.sqrt(x.qty || 1), a = acc[oid] || (acc[oid] = { sw: 0, swr: 0, visits: 0, qty: 0 });
        a.sw += w; a.swr += w * x.rating; a.visits++; a.qty += x.qty || 0;
      });
    });
    var out = {};
    Object.keys(acc).forEach(function (oid) {
      var a = acc[oid];
      out[oid] = { rating: a.swr / a.sw, visits: a.visits, qty: a.qty };
    });
    return out;
  }
  function formatRating(r) { return r == null ? '' : (Math.round(r * 10) / 10).toFixed(1); }

  // ── Counting (stats and stamps) ───────────────────────────────────────────
  function catalogIndex(oysters) {
    var by = {};
    (oysters || []).forEach(function (o) { by[o.id] = o; });
    return by;
  }
  function regionIndex(regions) {
    var by = {};
    (regions || []).forEach(function (r) { by[r.code] = r; });
    return by;
  }
  /** Regions that have an oyster in the catalog, in regions.js order. */
  function catalogRegions(oysters, regions) {
    var present = {};
    (oysters || []).forEach(function (o) { if (o.region) present[o.region] = true; });
    var list = (regions || []).filter(function (r) { return present[r.code]; });
    Object.keys(present).forEach(function (c) {
      if (!list.some(function (r) { return r.code === c; })) list.push({ code: c, name: c.toUpperCase(), short: c.toUpperCase() });
    });
    return list;
  }

  /**
   * Everything the stamps and the stats strip count. Retired oysters (not
   * in the catalog) count toward eaten, visits and rated only. [CALL]
   */
  function measures(visits, oysters, regions) {
    var cat = catalogIndex(oysters), reg = regionIndex(regions);
    var m = { eaten: 0, rated: 0, briny: 0, mild: 0, varieties: 0, regions: 0, visits: 0,
              allVarieties: 0, byRegion: {}, east: 0, west: 0, nc: 0, canadian: 0, firstVisit: null };
    var seen = {}, seenAll = {}, regionsSeen = {}, dates = {};
    Object.keys(visits || {}).forEach(function (vid) {
      var v = visits[vid], it = items(v), ids = Object.keys(it);
      if (!ids.length) return;
      dates[v.date] = true;
      ids.forEach(function (oid) {
        var x = it[oid], q = x.qty || 0, o = cat[oid];
        m.eaten += q;
        if (x.rating >= 1) m.rated++;
        seenAll[oid] = true;
        if (!o) return;                       // retired: its facts are gone
        seen[oid] = true;
        if (o.salinity === 'high' || o.salinity === 'very-high') m.briny += q;
        if (o.salinity === 'low') m.mild += q;
        if (o.region) {
          regionsSeen[o.region] = true;
          m.byRegion[o.region] = (m.byRegion[o.region] || 0) + q;
          var r = reg[o.region];
          if (r && r.coast === 'east') m.east += q;
          if (r && r.coast === 'west') m.west += q;
          if (r && r.country === 'CA') m.canadian += q;
          if (o.region === 'nc') m.nc += q;
        }
      });
    });
    m.varieties = Object.keys(seen).length;
    m.allVarieties = Object.keys(seenAll).length;
    m.regions = Object.keys(regionsSeen).length;
    var d = Object.keys(dates).sort();
    m.visits = d.length;                      // days with oysters logged [CALL]
    m.firstVisit = d[0] || null;
    return m;
  }

  // ── Stamps ────────────────────────────────────────────────────────────────
  var RANK = { single: 1, bronze: 1, silver: 2, gold: 3, pearl: 4 };
  function tierRank(t) { return RANK[t] || 0; }

  /** Every stamp definition, region stamps included, for this catalog. */
  function stampDefs(oysters, regions) {
    var S = stamps(), defs = [];
    catalogRegions(oysters, regions).forEach(function (r) {
      defs.push({ id: S.REGION.idPrefix + r.code, kind: 'region', name: r.name, code: r.short || r.code.toUpperCase(),
        region: r.code, measure: 'region', thresholds: S.REGION.thresholds,
        description: S.REGION.description.replace('{region}', r.name), line: S.REGION.line });
    });
    S.LADDERS.forEach(function (l) {
      var all = l.measure === 'varieties' ? (oysters || []).length : catalogRegions(oysters, regions).length;
      defs.push({ id: l.id, kind: 'ladder', name: l.name, measure: l.measure, description: l.description, line: l.line,
        thresholds: l.thresholds.map(function (t) { return t === 'all' ? all : t; }) });
    });
    S.SINGLES.forEach(function (s) {
      defs.push({ id: s.id, kind: 'single', name: s.name, test: s.test, description: s.description, line: s.line });
    });
    return defs;
  }

  function singleEarned(test, ctx, m) {
    var visits = ctx.visits || {};
    switch (test) {
      case 'firstSlurp': return m.eaten > 0;
      case 'coastToCoast': return m.east > 0 && m.west > 0;
      case 'homeWaters': return m.nc > 0;
      case 'canadian': return m.canadian > 0;
      case 'birthday':
        return !!(ctx.dob) && Object.keys(visits).some(function (k) {
          return !isEmpty(visits[k]) && inBirthdayWeek(ctx.dob, visits[k].date);
        });
      case 'flightCrew':
        return Object.keys(visits).some(function (k) {
          var v = visits[k], it = items(v);
          var holds = function (ids) { return ids.length > 0 && ids.every(function (id) { return it[id] && it[id].qty >= 1; }); };
          var fl = v.flightsLogged || {};
          if (Object.keys(fl).some(function (s) { return holds(Object.keys(fl[s])); })) return true;
          return v.date === ctx.today && (ctx.todayFlights || []).some(holds);
        });
    }
    return false;
  }

  /**
   * What each stamp is worth now.
   * ctx: { visits, oysters, regions, dob, today (business day),
   *        todayFlights: [[oysterId, ...], ...] (today's Curated Flights) }
   * Returns { stampId: { def, value, tier (null if not earned), next: {tier, at} | null } }.
   */
  function evaluateStamps(ctx) {
    var m = measures(ctx.visits, ctx.oysters, ctx.regions), out = {};
    var tiers = stamps().TIERS;
    stampDefs(ctx.oysters, ctx.regions).forEach(function (d) {
      if (d.kind === 'single') {
        var got = singleEarned(d.test, ctx, m);
        out[d.id] = { def: d, value: got ? 1 : 0, tier: got ? 'single' : null, next: null };
        return;
      }
      var value = d.kind === 'region' ? (m.byRegion[d.region] || 0) : m[d.measure];
      var tier = null, next = null;
      d.thresholds.forEach(function (t, i) {
        if (value >= t) tier = tiers[i];
        else if (!next) next = { tier: tiers[i], at: t };
      });
      out[d.id] = { def: d, value: value, tier: tier, next: next };
    });
    return out;
  }
  /** The tier to show: never lower than the stored one (tiers never go backwards). */
  function shownTier(stored, evaluated) {
    var s = stored && stored.tier, e = evaluated && evaluated.tier;
    return tierRank(e) > tierRank(s) ? e : (s || null);
  }
  /**
   * Writes for stamps earned or upgraded since `stored` (users/{uid}/stamps).
   * New and upgraded stamps get seen: false, so the celebration shows once.
   */
  function stampUpdates(stored, evaluated, now) {
    var u = {}, tiers = stamps().TIERS;
    stored = stored || {};
    Object.keys(evaluated).forEach(function (id) {
      var e = evaluated[id], s = stored[id];
      if (!e.tier || tierRank(e.tier) <= tierRank(s && s.tier)) return;
      var base = 'stamps/' + id + '/';
      u[base + 'tier'] = e.tier;
      u[base + 'seen'] = false;
      if (e.tier === 'single') u[base + 'tierEarnedAt/single'] = now;
      else {
        tiers.forEach(function (t) {
          if (tierRank(t) > tierRank(s && s.tier) && tierRank(t) <= tierRank(e.tier)) u[base + 'tierEarnedAt/' + t] = now;
        });
      }
    });
    return u;
  }
  function earnedAt(s) {
    var t = s && s.tierEarnedAt && s.tierEarnedAt[s.tier];
    return typeof t === 'number' ? t : 0;
  }
  /** Stamps waiting for their celebration, oldest first. */
  function unseenStamps(stored) {
    stored = stored || {};
    return Object.keys(stored).filter(function (id) { return stored[id] && stored[id].seen === false; })
      .sort(function (a, b) { return earnedAt(stored[a]) - earnedAt(stored[b]) || (a < b ? -1 : 1); });
  }
  /** The last `n` stamps earned or upgraded, newest first. */
  function recentStamps(stored, n) {
    stored = stored || {};
    return Object.keys(stored).filter(function (id) { return stored[id] && stored[id].tier; })
      .sort(function (a, b) { return earnedAt(stored[b]) - earnedAt(stored[a]) || (a < b ? -1 : 1); })
      .slice(0, n);
  }
  /** "12 oysters from North Carolina". */
  function stampLine(def, value) {
    return String(def.line || '')
      .replace(/\{n:(\w+)\}/g, function (_, w) { return value === 1 ? w : w + 's'; })
      .replace('{n}', String(value))
      .replace('{region}', def.name);
  }

  // ── Palate and recommendations ────────────────────────────────────────────
  function ranks() { var I = flights()._internals; return { sal: I.salinityRank, size: I.sizeRank }; }
  /** Rated current oysters with their facts: [{ id, rating, o, sal, size, region, coast }]. */
  function ratedFacts(agg, oysters, regions) {
    var cat = catalogIndex(oysters), reg = regionIndex(regions), R = ranks();
    return Object.keys(agg).filter(function (id) { return cat[id]; }).sort().map(function (id) {
      var o = cat[id], r = reg[o.region];
      return { id: id, rating: agg[id].rating, o: o, sal: R.sal(o), size: R.size(o), region: o.region || null,
               coast: r ? r.coast : null };
    });
  }
  function bestGroup(list, keyFn, minCount) {
    var g = {};
    list.forEach(function (x) {
      var k = keyFn(x);
      if (k === null || k === undefined || (typeof k === 'number' && isNaN(k))) return;
      (g[k] = g[k] || []).push(x.rating);
    });
    var best = null;
    Object.keys(g).forEach(function (k) {
      var n = g[k].length;
      if (n < minCount) return;
      var mean = g[k].reduce(function (a, b) { return a + b; }, 0) / n;
      if (!best || mean > best.mean || (mean === best.mean && n > best.count)) best = { key: k, mean: mean, count: n };
    });
    return best;
  }
  var SAL_LEAN = { 1: 'mild', 2: 'mild', 3: 'middle', 4: 'briny', 5: 'briny' };   // [CALL]
  var SAL_TEXT = { mild: 'You lean mild', middle: 'Right down the middle', briny: 'You lean briny' };
  var SIZE_WORD = { 1: 'small', 2: 'medium', 3: 'large' };
  /**
   * "Your palate" (6.6). Null until 5 varieties are rated. Each line is null
   * without enough data; each says what it is based on (`basis`).
   */
  function palate(agg, oysters, regions) {
    var ratedCount = Object.keys(agg).length;
    if (ratedCount < UNLOCK_RATED) return { unlocked: false, toGo: UNLOCK_RATED - ratedCount };
    var f = ratedFacts(agg, oysters, regions), reg = regionIndex(regions), out = { unlocked: true, toGo: 0 };
    var s = bestGroup(f, function (x) { return x.sal; }, 2);
    out.salinity = s && { band: Number(s.key), lean: SAL_LEAN[s.key], text: SAL_TEXT[SAL_LEAN[s.key]],
      basis: f.filter(function (x) { return !isNaN(x.sal); }).length };
    var east = f.filter(function (x) { return x.coast === 'east'; }), west = f.filter(function (x) { return x.coast === 'west'; });
    var mean = function (l) { return l.reduce(function (a, x) { return a + x.rating; }, 0) / l.length; };
    if (east.length >= 2 && west.length >= 2) {
      var e = mean(east), w = mean(west);
      out.coast = { east: e, west: w, lean: e > w ? 'east' : w > e ? 'west' : 'even',
        text: e > w ? 'You lean East Coast' : w > e ? 'You lean West Coast' : 'Both coasts, equally',
        basis: east.length + west.length };
    } else out.coast = null;
    var z = bestGroup(f, function (x) { return x.size; }, 2);
    out.size = z && { rank: Number(z.key), text: 'You lean ' + SIZE_WORD[z.key],
      basis: f.filter(function (x) { return !isNaN(x.size); }).length };
    var r = bestGroup(f, function (x) { return x.region; }, 2);
    out.region = r && { code: r.key, name: (reg[r.key] && reg[r.key].name) || r.key, mean: r.mean, basis: r.count };
    return out;
  }

  /** How alike two oysters are (6.7). Unknown salinity or size: that term is dropped and the rest renormalized. */
  function similarity(a, b) {
    var w = 0, s = 0;
    if (!isNaN(a.sal) && !isNaN(b.sal)) { w += 0.5; s += 0.5 * (1 - Math.abs(a.sal - b.sal) / 4); }
    w += 0.3; if (a.region && a.region === b.region) s += 0.3;
    if (!isNaN(a.size) && !isNaN(b.size)) { w += 0.2; if (a.size === b.size) s += 0.2; }
    return s / w;
  }
  /**
   * "You might like" (6.7): up to 2 untried oysters from tonight's menu with
   * score > 0.3. Null until 5 varieties are rated.
   * Returns [{ id, score, because: oysterId }].
   */
  function recommendations(agg, visits, servedIds, oysters, regions) {
    if (Object.keys(agg).length < UNLOCK_RATED) return null;
    var tried = {}, cat = catalogIndex(oysters), R = ranks();
    Object.keys(visits || {}).forEach(function (k) { Object.keys(items(visits[k])).forEach(function (id) { tried[id] = true; }); });
    var rated = ratedFacts(agg, oysters, regions);
    var out = [];
    (servedIds || []).slice().sort().forEach(function (id) {
      var o = cat[id];
      if (!o || tried[id]) return;
      var me = { sal: R.sal(o), size: R.size(o), region: o.region || null };
      var num = 0, den = 0, top = null, topC = 0;
      rated.forEach(function (r) {
        var sim = similarity(me, r), c = (r.rating - 3) * sim;
        num += c; den += sim;
        if (c > topC) { topC = c; top = r.id; }
      });
      if (den > 0 && num / den > 0.3) out.push({ id: id, score: num / den, because: top });
    });
    return out.sort(function (a, b) { return b.score - a.score || (a.id < b.id ? -1 : 1); }).slice(0, 2);
  }

  root.HS_PASSPORT = {
    OPENING_DAY: OPENING_DAY, TIMEOUT_MS: TIMEOUT_MS, MAX_QTY: MAX_QTY, CARD_BRANDS: CARD_BRANDS,
    NAME_MAX: NAME_MAX, EMAIL_MAX: EMAIL_MAX, TWO_WORDS_MAX: TWO_WORDS_MAX, NOTE_MAX: NOTE_MAX,
    MIN_AGE: MIN_AGE, UNLOCK_RATED: UNLOCK_RATED,
    // dates
    nyDate: nyDate, businessDay: businessDay, isRealDate: isRealDate, addDays: addDays, isVisitDate: isVisitDate,
    // age and birthday
    age: age, checkDob: checkDob, isUnderMinAge: isUnderMinAge, canShowAlcoholPromo: canShowAlcoholPromo,
    birthdayIn: birthdayIn, inBirthdayWeek: inBirthdayWeek,
    // fields
    cleanName: cleanName, validName: validName, validEmail: validEmail, validTwoWords: validTwoWords,
    limitTwoWords: limitTwoWords, wordCount: function (s) { return words(s).length; }, validNote: validNote,
    validCard: validCard, brandLabel: brandLabel, validQty: validQty, isSlug: function (s) { return SLUG_RE.test(s); },
    // visits
    visitTotal: visitTotal, isEmpty: isEmpty, openVisit: openVisit, visitOnDate: visitOnDate,
    closeUpdates: closeUpdates, timeoutUpdates: timeoutUpdates, saveUpdates: saveUpdates, addUpdates: addUpdates,
    logFlightUpdates: logFlightUpdates, backdatedUpdates: backdatedUpdates, hereOnCarry: hereOnCarry,
    flightSlug: flightSlug,
    // ratings, stats, stamps
    aggregateRatings: aggregateRatings, formatRating: formatRating, measures: measures,
    catalogRegions: catalogRegions, stampDefs: stampDefs, evaluateStamps: evaluateStamps, shownTier: shownTier,
    stampUpdates: stampUpdates, unseenStamps: unseenStamps, recentStamps: recentStamps, stampLine: stampLine,
    tierRank: tierRank,
    // palate and recommendations
    palate: palate, similarity: similarity, recommendations: recommendations
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.HS_PASSPORT;
})(typeof window !== 'undefined' ? window : globalThis);
