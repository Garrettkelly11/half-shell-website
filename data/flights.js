/*
 * Curated Flights — flight pool and selection engine.
 *
 * Loaded by curated-flights.html (as a global, HS_FLIGHTS) and by
 * tools/flights-preview.js (via require). One file, so the page and the
 * tests can never drift apart.
 *
 * Needs data/regions.js: pages load it first (global HS_REGIONS); Node
 * requires it from this folder.
 *
 * Usage:
 *   HS_FLIGHTS.selectFlights(servedOysters, HS_FLIGHTS.rotationDate(new Date()))
 *     -> [{ name, description, oysters: [catalogEntry, ...] }, ...]   (0–2 flights)
 *
 * To reword a description or add a flight, edit POOL below. Nothing else needs to change.
 *
 * Rules (see "Curated Flights Feature Plan.md"):
 *   - 3–4 oysters per flight, except First Timer (2–3).
 *   - At most 2 flights shown. Flights that qualify are ranked by a hash of
 *     (date + flight name); no two shown flights may share more than half their oysters.
 *   - Shucker's Choice is a fallback only, used when no other flight qualifies.
 *   - Same served list + same date always gives the same result. The date is the
 *     America/New_York calendar date (rolls over at midnight).
 */
(function (root) {
  'use strict';

  var MAX_FLIGHTS = 2;

  // ── Regions ────────────────────────────────────────────────────────────────
  // Coast lists come from data/regions.js. HOMETOWN is a flight rule, not a
  // region property, so it stays here.
  var REGIONS = root.HS_REGIONS, loadError = '';
  if (!REGIONS && typeof require === 'function') {
    try { REGIONS = require('./regions.js'); } catch (e) { loadError = ' (' + e.message + ')'; }
  }
  if (!Array.isArray(REGIONS) || !REGIONS.length) {
    throw new Error('data/flights.js: HS_REGIONS is missing. Load data/regions.js before data/flights.js.' + loadError);
  }
  function codesWhere(test) {
    return REGIONS.filter(test).map(function (r) { return r.code; });
  }
  var ATLANTIC_NORTH = codesWhere(function (r) { return r.group === 'atlantic-north'; });
  var ATLANTIC_SOUTH = codesWhere(function (r) { return r.group === 'atlantic-south'; });
  var ATLANTIC_ALL   = codesWhere(function (r) { return r.coast === 'east'; });
  var WEST_COAST     = codesWhere(function (r) { return r.coast === 'west'; });
  var HOMETOWN       = ['nc', 'va'];

  function region(o) { return String(o.region || '').toLowerCase(); }
  function inList(o, list) { return list.indexOf(region(o)) !== -1; }

  // ── Catalog field parsing ──────────────────────────────────────────────────
  // Same scale the menu page uses: low 1, medium 2, medium-high 3, high 4, very-high 5.
  var SAL = { 'low': 1, 'medium': 2, 'medium-high': 3, 'high': 4, 'very-high': 5 };
  function salinityRank(o) {
    var r = SAL[String(o.salinity || '').toLowerCase()];
    return r === undefined ? NaN : r;
  }

  // petite/cocktail/small = 1, medium = 2, large/jumbo = 3. The largest word wins
  // ("Medium to large" = 3). Unknown or undocumented = NaN.
  function sizeRank(o) {
    var s = String(o.size || '').toLowerCase();
    if (!s || /unknown|not documented|undocumented/.test(s)) return NaN;
    if (/large|jumbo/.test(s)) return 3;
    if (/medium/.test(s)) return 2;
    if (/small|cocktail|petite/.test(s)) return 1;
    return NaN;
  }

  // Oysters with neither salinity nor size on file are left out of every flight.
  function isKnown(o) { return !isNaN(salinityRank(o)) || !isNaN(sizeRank(o)); }

  // ── Deterministic hashing (no randomness) ──────────────────────────────────
  function hash32(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= h >>> 16; h = Math.imul(h, 2246822507) >>> 0;
    h ^= h >>> 13; h = Math.imul(h, 3266489909) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
  }
  function unit(str) { return (hash32(str) + 0.5) / 4294967296; }

  // Pick k oysters from a list, ordered by a hash of (date + flight + id).
  function pickSeeded(list, k, seed) {
    return list.slice().sort(function (a, b) {
      return unit(seed + '|' + a.id) - unit(seed + '|' + b.id) || (a.id < b.id ? -1 : 1);
    }).slice(0, k);
  }

  // ── Flight pool ────────────────────────────────────────────────────────────
  // build(available, seed) returns an ordered array of oysters, or null.
  // min/max are the allowed flight sizes; a flight shorter than min does not qualify.
  var POOL = [
    {
      name: 'Brine Ladder',
      description: 'Brine is one of the defining traits of an oyster, this flight takes you from the least to most salty from our current selection.',
      min: 3, max: 3,
      build: function (av, seed) {
        var tiers = {};
        av.forEach(function (o) {
          var r = salinityRank(o);
          if (!isNaN(r)) (tiers[r] = tiers[r] || []).push(o);
        });
        var ranks = Object.keys(tiers).map(Number).sort(function (a, b) { return a - b; });
        if (ranks.length < 3) return null;
        var chosen = [ranks[0], ranks[Math.floor(ranks.length / 2)], ranks[ranks.length - 1]];
        return chosen.map(function (r) { return pickSeeded(tiers[r], 1, seed)[0]; });
      }
    },
    {
      name: 'Coast to Coast',
      description: 'Atlantic and Pacific, two coasts with two drastically different oyster experiences. Whether you love the cucumber note of the west or the rich brine from the east, any oyster lover should experience them back to back.',
      min: 3, max: 4,
      build: function (av, seed) {
        var east = av.filter(function (o) { return inList(o, ATLANTIC_ALL); });
        var west = av.filter(function (o) { return inList(o, WEST_COAST); });
        if (!east.length || !west.length) return null;
        // Up to 2 from each side; if one side is short, the other fills up to 4.
        var e = Math.min(east.length, 2), w = Math.min(west.length, 2);
        if (e + w < 4) { e = Math.min(east.length, 4 - w); w = Math.min(west.length, 4 - e); }
        return pickSeeded(east, e, seed + 'E').concat(pickSeeded(west, w, seed + 'W'));
      }
    },
    {
      name: 'First Timer',
      description: 'Mild and sweet, these are the perfect start for a future oyster lover.',
      min: 2, max: 3,
      build: function (av, seed) {
        var picks = av.filter(function (o) {
          return sizeRank(o) === 1 &&
                 salinityRank(o) <= 2 &&
                 /sweet|mild|clean|first/i.test(o.tastingNotes || '');
        });
        return picks.length >= 2 ? pickSeeded(picks, 3, seed) : null;
      }
    },
    {
      name: 'Salt Lover',
      description: 'Not all oysters are salt bombs, but these certainly are.',
      min: 3, max: 3,
      build: function (av, seed) {
        var picks = av.filter(function (o) { return salinityRank(o) >= 3; });
        if (picks.length < 3) return null;
        // Highest salinity first; ties broken by the daily seed.
        return picks.slice().sort(function (a, b) {
          return salinityRank(b) - salinityRank(a) || unit(seed + '|' + a.id) - unit(seed + '|' + b.id);
        }).slice(0, 3);
      }
    },
    {
      name: 'Hometown Heroes',
      description: "Hailing from the waters of the Carolinas and Virginia, it's as local as you'll find in Charlotte.",
      min: 3, max: 3,
      build: function (av, seed) {
        var picks = av.filter(function (o) { return inList(o, HOMETOWN); });
        return picks.length >= 3 ? pickSeeded(picks, 3, seed) : null;
      }
    },
    {
      name: 'North vs. South',
      description: 'North to south, the same ocean separated by miles of coastline and drastic changes in environment. The icy cold waters of the north and the nutrient rich south, together on one plate',
      min: 4, max: 4,
      build: function (av, seed) {
        var north = av.filter(function (o) { return inList(o, ATLANTIC_NORTH); });
        var south = av.filter(function (o) { return inList(o, ATLANTIC_SOUTH); });
        if (north.length < 2 || south.length < 2) return null;
        return pickSeeded(north, 2, seed + 'N').concat(pickSeeded(south, 2, seed + 'S'));
      }
    },
    {
      name: 'Size Ladder',
      description: 'From our smallest to our largest, this flight celebrates the many shapes and sizes of our favorite mollusk.',
      min: 3, max: 3,
      build: function (av, seed) {
        var tiers = {};
        av.forEach(function (o) {
          var r = sizeRank(o);
          if (!isNaN(r)) (tiers[r] = tiers[r] || []).push(o);
        });
        if (!tiers[1] || !tiers[2] || !tiers[3]) return null;
        return [1, 2, 3].map(function (r) { return pickSeeded(tiers[r], 1, seed)[0]; });
      }
    },
    {
      name: "Shucker's Choice",
      description: "A rotating selection of our shucker's favorite oysters of the day.",
      fallback: true,           // only used when no other flight qualifies
      min: 3, max: 3,
      build: function (av, seed) {
        return av.length >= 3 ? pickSeeded(av, 3, seed) : null;
      }
    }
  ];

  // ── Selection ──────────────────────────────────────────────────────────────
  // More than half of the smaller flight shared counts as too similar.
  function overlapTooHigh(a, b) {
    var ids = {};
    b.forEach(function (o) { ids[o.id] = true; });
    var shared = a.filter(function (o) { return ids[o.id]; }).length;
    return shared > Math.min(a.length, b.length) / 2;
  }

  function dedupeById(list) {
    var seen = {};
    return list.filter(function (o) {
      if (!o || !o.id || seen[o.id]) return false;
      seen[o.id] = true;
      return true;
    });
  }

  function qualifies(def, date, av) {
    var oysters = def.build(av, date + '|' + def.name);
    if (!oysters) return null;
    oysters = dedupeById(oysters);
    if (oysters.length < def.min || oysters.length > def.max) return null;
    return { name: def.name, description: def.description, oysters: oysters };
  }

  // servedOysters: catalog entries currently on the menu. dateStr: 'YYYY-MM-DD'.
  function selectFlights(servedOysters, dateStr) {
    // Sorted by id so the result never depends on catalog order.
    var av = dedupeById(servedOysters).filter(isKnown).sort(function (a, b) {
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    var candidates = [];
    POOL.forEach(function (def) {
      if (def.fallback) return;
      var f = qualifies(def, dateStr, av);
      if (f) { f.rank = unit(dateStr + '|' + def.name); candidates.push(f); }
    });
    candidates.sort(function (a, b) { return a.rank - b.rank; });

    var chosen = [];
    candidates.forEach(function (c) {
      if (chosen.length >= MAX_FLIGHTS) return;
      if (chosen.some(function (x) { return overlapTooHigh(c.oysters, x.oysters); })) return;
      chosen.push(c);
    });

    if (!chosen.length) {
      var fb = POOL.filter(function (d) { return d.fallback; })[0];
      var f = fb && qualifies(fb, dateStr, av);
      if (f) chosen.push(f);
    }

    return chosen.map(function (c) {
      return { name: c.name, description: c.description, oysters: c.oysters };
    });
  }

  // The America/New_York calendar date ('YYYY-MM-DD'). Rolls over at midnight Eastern.
  function rotationDate(now) {
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(now || new Date());
    return parts; // en-CA formats as YYYY-MM-DD
  }

  root.HS_FLIGHTS = {
    POOL: POOL,
    MAX_FLIGHTS: MAX_FLIGHTS,
    selectFlights: selectFlights,
    rotationDate: rotationDate,
    // exposed for the test harness
    _internals: { salinityRank: salinityRank, sizeRank: sizeRank, isKnown: isKnown,
                  overlapTooHigh: overlapTooHigh, ATLANTIC_NORTH: ATLANTIC_NORTH,
                  ATLANTIC_SOUTH: ATLANTIC_SOUTH, ATLANTIC_ALL: ATLANTIC_ALL,
                  WEST_COAST: WEST_COAST, HOMETOWN: HOMETOWN }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.HS_FLIGHTS;
})(typeof window !== 'undefined' ? window : globalThis);
