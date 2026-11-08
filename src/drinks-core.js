/**
 * Drinks core: the pure logic for the bar menu, shared by bar.html, the
 * employee page's Drinks and Specials tabs, and the Cloud Functions
 * (cloud/vendor-site.js copies this file into cloud/site/ on deploy).
 * No DOM, no Firebase. Tested by tools/drinks-test.js.
 *
 * Toast is the single source of truth for what a drink is called, what it
 * costs, which section it sits in and whether it is 86'd. Every Toast drink
 * appears on the bar menu on its own. A drink record here is only the extras
 * a manager adds later (description, photo, tags, allergens, size note,
 * ABV) or a switch to hide it; it belongs to the Toast drink with the same
 * name (toastKey below).
 *
 * Money is whole cents everywhere. Times are America/New_York; a "business
 * day" runs 4 AM to 4 AM, like happy hour and the nightly menu.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HS_DRINKS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ZONE = 'America/New_York';
  var DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  var ALLERGENS = ['Milk', 'Eggs', 'Fish', 'Shellfish', 'Tree nuts', 'Peanuts', 'Wheat', 'Soy', 'Sesame', 'Sulfites'];
  var TAGS = ['House', 'Local', 'Seasonal', 'Non-alcoholic', 'Gluten-free', 'Vegan', 'Spicy', 'Low ABV'];
  var LIMITS = { drinks: 500, specials: 100, nightlyItems: 25, library: 300, name: 80, description: 400, size: 40, category: 30, note: 200, ingredients: 300 };
  var STORAGE_HOST = 'https://firebasestorage.googleapis.com/';

  /** Text from any source, cleaned: invisible characters dropped, no-break spaces and stray control characters become plain spaces, trimmed. */
  function str(v) {
    return v == null ? '' : String(v).replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, '').replace(/[\u00a0\u2007\u202f\t\v\f]/g, ' ').replace(/[\u0000-\u0008\u000e-\u001f\u007f]/g, '').trim();
  }
  /** One line: any line breaks and runs of spaces become a single space. */
  function oneLine(v) { return str(v).replace(/\s+/g, ' '); }
  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }

  // ── Money ──
  function money(cents) {
    var d = cents / 100;
    return '$' + (cents % 100 === 0 ? String(d) : d.toFixed(2));
  }
  /** "12", "$12.50", "12.5" -> 1250. null when it isn't a price. */
  function parsePrice(v) {
    if (typeof v === 'number') return isFinite(v) && v >= 0 && v <= 1000 && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6 ? Math.round(v * 100) : null;
    var s = str(v).replace(/^\$/, '');
    if (/,\d{1,2}$/.test(s) || (s.indexOf(',') >= 0 && !/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s))) return null; // "12,50" is not $1,250
    s = s.replace(/,/g, '');
    if (!/^\d{1,4}(\.\d{1,2})?$/.test(s)) return null;
    return Math.round(parseFloat(s) * 100);
  }

  // ── Time (Eastern, with the 4 AM business-day edge) ──
  var fmt = null;
  function etParts(ms) {
    if (!fmt) {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: ZONE, hourCycle: 'h23', weekday: 'short',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      });
    }
    var p = {};
    fmt.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    return {
      date: p.year + '-' + p.month + '-' + p.day,
      day: p.weekday.toUpperCase().slice(0, 3),
      minutes: Number(p.hour) * 60 + Number(p.minute),
    };
  }
  function addDays(date, n) {
    var d = new Date(date + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  /** The business day a moment belongs to: before 4 AM it is still yesterday. */
  function businessDay(ms) {
    var p = etParts(ms);
    var date = p.minutes < 240 ? addDays(p.date, -1) : p.date;
    var day = DAYS[(DAYS.indexOf(p.day) + (p.minutes < 240 ? 6 : 0)) % 7];
    return { date: date, day: day, minutes: p.minutes, clock: p.minutes };
  }
  function isDate(s) {
    return /^20\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(s) && !isNaN(Date.parse(s + 'T12:00:00Z')) &&
      new Date(s + 'T12:00:00Z').toISOString().slice(0, 10) === s;
  }
  function minutesOf(hhmm) { var m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
  function clock(hhmm) {
    var m = minutesOf(hhmm); if (m === null) return '';
    var h = Math.floor(m / 60), mm = m % 60, ap = h >= 12 ? 'pm' : 'am';
    return (h % 12 || 12) + (mm ? ':' + (mm < 10 ? '0' : '') + mm : '') + ap;
  }

  // ── Drinks ──
  function slug(name) {
    return str(name).toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  }
  // Toast names bar items with a type prefix (DFT, CAN, BTL). Guests never
  // see it, and a record's name may leave it off.
  var TOAST_PREFIX = /^(dft|can|btl)\s+/i;
  function cleanName(name) { return str(name).replace(TOAST_PREFIX, '').replace(/\s+/g, ' '); }
  /** What a Toast drink and a drink record must share to be the same drink: letters and numbers only, prefix dropped, "&" = "and". */
  function toastKey(name) {
    return cleanName(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '').slice(0, 80);
  }
  function matchList(values, allowed) {
    var out = [], bad = [];
    var norm = function (x) { return String(x).toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, ''); };
    var alias = { dairy: 'milk', egg: 'eggs', nut: 'treenuts', nuts: 'treenuts', treenut: 'treenuts', peanut: 'peanuts', shellfish: 'shellfish', crustaceans: 'shellfish', gf: 'glutenfree', glutenfree: 'glutenfree', nonalc: 'nonalcoholic', na: 'nonalcoholic', zeroproof: 'nonalcoholic', alcoholfree: 'nonalcoholic', sulfite: 'sulfites', sulphites: 'sulfites', sulphite: 'sulfites', lowabv: 'lowabv', local: 'local' };
    values.forEach(function (v) {
      var n = norm(v), want = alias[n] || alias[n + 's'] || n;
      var hit = allowed.filter(function (a) { return a.toLowerCase() === v.toLowerCase() || norm(a) === want || norm(a) === n; })[0];
      if (!hit) bad.push(v); else if (out.indexOf(hit) < 0) out.push(hit);
    });
    return { ok: out, bad: bad };
  }
  function splitList(v) {
    if (Array.isArray(v)) return v.map(str).filter(Boolean);
    return str(v).split(/[;,|]/).map(str).filter(Boolean);
  }
  /** A link to a photo this site uploaded: https, Firebase Storage host, path drinks/<file>. Pass bucket to also pin the bucket. */
  function validPhotoUrl(u, bucket) {
    if (typeof u !== 'string' || u.length > 600 || /[\s\\]/.test(u)) return false;
    var m = /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/([a-z0-9._-]+)\/o\/drinks%2F[A-Za-z0-9._-]+(\?[A-Za-z0-9=&_%.-]*)?$/.exec(u);
    return !!m && (!bucket || m[1] === bucket);
  }

  /**
   * Check and clean one drink record (the manager's extras for a Toast
   * drink). Returns { ok, drink, errors:[...] }. Price and category are
   * Toast's and are ignored if given.
   */
  function validateDrink(input) {
    var errors = [], d = {};
    var src = input || {};
    d.name = oneLine(src.name);
    if (/\ufffd|\u00c3[\u0080-\u00bf]|\u00e2\u20ac/.test(d.name)) errors.push('Name has unreadable characters (the file is not saved as UTF-8).');
    if (!d.name) errors.push('Name is required.');
    else if (d.name.length > LIMITS.name) errors.push('Name is over ' + LIMITS.name + ' characters.');
    d.id = str(src.id) || slug(cleanName(d.name));
    if (!/^[a-z0-9-]{1,60}$/.test(d.id)) errors.push('Name needs letters or numbers.');
    if (d.name && !toastKey(d.name) && errors.indexOf('Name needs letters or numbers.') < 0) errors.push('Name needs letters or numbers.');
    d.size = oneLine(src.size).slice(0, LIMITS.size);
    d.description = oneLine(src.description);
    if (/\ufffd/.test(d.description)) errors.push('Description has unreadable characters (the file is not saved as UTF-8).');
    if (d.description.length > LIMITS.description) errors.push('Description is over ' + LIMITS.description + ' characters.');
    var abv = str(src.abv).replace(/\s*(abv|alc\.?(\/vol\.?)?)\s*$/i, '').replace(/\s*%\s*$/, '').replace(/^(\d+),(\d{1,2})$/, '$1.$2');
    if (abv) {
      var a = /^\d*\.?\d+$/.test(abv) ? parseFloat(abv) : NaN;
      if (!(a >= 0 && a <= 100)) errors.push('ABV "' + str(src.abv) + '" is not a number from 0 to 100 (write 5.5 or 5.5%).');
      else if (a > 0 && a < 1 && !/%/.test(str(src.abv))) errors.push('ABV "' + str(src.abv) + '" looks like a fraction (Excel percent cell?). Write it as ' + Math.round(a * 1000) / 10 + ' or ' + Math.round(a * 1000) / 10 + '%.');
      else d.abv = Math.round(a * 10) / 10;
    }
    var t = matchList(splitList(src.tags), TAGS);
    if (t.bad.length) errors.push('Unknown tag: ' + t.bad.join(', ') + '.');
    d.tags = t.ok;
    var al = matchList(splitList(src.allergens), ALLERGENS);
    if (al.bad.length) errors.push('Unknown allergen: ' + al.bad.join(', ') + '.');
    d.allergens = al.ok;
    var av = str(src.available);
    if (src.available === false || /^(n|no|false|0|86|off|hide|hidden)$/i.test(av)) d.available = false;
    else if (src.available === true || av === '' || /^(y|yes|true|1|on|show|shown)$/i.test(av)) d.available = true;
    else { d.available = true; errors.push('Available "' + av + '" should be yes or no.'); }
    if (Array.isArray(src.keep)) d.keep = src.keep.filter(function (f) { return typeof f === 'string' && FIELDS.indexOf(f) >= 0 && f !== 'name'; });
    if (src.photo) {
      if (!validPhotoUrl(src.photo)) errors.push('Photo must be one uploaded here.'); else d.photo = src.photo;
    }
    var sort = str(src.sort) === '' ? NaN : Number(src.sort);
    if (isInt(sort) && sort >= 0 && sort <= 100000) d.sort = sort;
    return { ok: errors.length === 0, drink: d, errors: errors };
  }

  // ── Import (csv/xlsx rows) ──
  var HEADERS = {
    name: ['name', 'drink', 'item', 'drink name'],
    size: ['size', 'pour', 'volume', 'serving'],
    description: ['description', 'desc', 'notes', 'details', 'ingredients'],
    abv: ['abv', 'alcohol', 'abv %'],
    tags: ['tags', 'tag', 'labels'],
    allergens: ['allergens', 'allergen', 'contains'],
    available: ['available', 'in stock', 'active', 'on menu'],
    sort: ['sort', 'order', 'position'],
    id: ['id', 'slug'],
  };
  // Columns a file may still carry from before: Toast owns them, so they are skipped.
  var TOAST_OWNED = ['category', 'section', 'type', 'group', 'price', 'cost', 'price ($)'];
  function headerMap(row) {
    var map = {};
    Object.keys(row).forEach(function (h) {
      var k = str(h).toLowerCase();
      Object.keys(HEADERS).forEach(function (field) {
        if (HEADERS[field].indexOf(k) >= 0 && !(field in map)) map[field] = h;
      });
    });
    return map;
  }

  /** Minimal RFC 4180 CSV parser: quotes, doubled quotes, CRLF, BOM. */
  function parseCSV(text) {
    text = String(text).replace(/^﻿/, '');
    var rows = [], row = [], cur = '', q = false, i = 0, c;
    // Excel in many regions saves "CSV" with semicolons, and some tools save tabs: pick the one the header line uses.
    var delim = ',', firstLine = text.split(/\r\n|\n|\r/).filter(function (l) { return l.trim() !== ''; })[0] || '';
    (function () { var best = 0, inq = false, counts = { ',': 0, ';': 0, '\t': 0 }; for (var k = 0; k < firstLine.length; k++) { var ch = firstLine[k]; if (ch === '"') inq = !inq; else if (!inq && counts[ch] !== undefined) counts[ch]++; } [',', ';', '\t'].forEach(function (d) { if (counts[d] > best) { best = counts[d]; delim = d; } }); })();
    for (; i < text.length; i++) {
      c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); cur = '';
        rows.push(row);
        row = [];
      } else cur += c;
    }
    row.push(cur);
    rows.push(row);
    var blank = function (r) { return !r.some(function (x) { return str(x) !== ''; }); };
    var first = 0;
    while (first < rows.length && blank(rows[first])) first++;
    if (first >= rows.length) return [];
    var head = rows[first].map(str), out = [];
    rows.forEach(function (r, i) {
      if (i <= first || blank(r)) return;
      var o = {};
      head.forEach(function (h, idx) { if (h) o[h] = r[idx] == null ? '' : r[idx]; });
      Object.defineProperty(o, '__row', { value: i + 1, enumerable: false });
      out.push(o);
    });
    return out;
  }

  /**
   * Turn sheet rows (objects keyed by header) into drinks.
   * Returns { drinks:[valid], problems:[{row, errors}], duplicates:[names] }.
   * Row numbers count the header as row 1, like a spreadsheet.
   */
  function drinksFromRows(rows) {
    var drinks = [], problems = [], seen = Object.create(null), dupes = [];
    if (!rows.length) return { drinks: drinks, problems: [{ row: 1, errors: ['The file has no drinks.'] }], duplicates: dupes, fatal: true };
    var map = headerMap(rows[0]);
    if (!('name' in map)) return { drinks: drinks, problems: [{ row: 1, errors: ['Missing column: Name.'] }], duplicates: dupes, fatal: true };
    var ignored = Object.keys(rows[0]).filter(function (h) { return TOAST_OWNED.indexOf(str(h).toLowerCase()) >= 0 && h !== map.name; });
    rows.forEach(function (r, idx) {
      var o = {}, rowNo = r.__row || idx + 2;
      Object.keys(map).forEach(function (f) { o[f] = typeof r[map[f]] === 'string' ? r[map[f]].replace(/^'(?=[=+\-@])/, '') : r[map[f]]; });
      if (!Object.keys(o).some(function (k) { return str(o[k]) !== ''; })) return; // blank line
      var keep = Object.keys(o).filter(function (f) { return f !== 'id' && f !== 'name' && str(o[f]) === ''; });
      o.keep = keep;
      var v = validateDrink(o);
      if (!v.ok) { problems.push({ row: rowNo, errors: v.errors }); return; }
      var k = toastKey(v.drink.name);
      if (seen[k] || seen[v.drink.id]) { dupes.push(v.drink.name); problems.push({ row: rowNo, errors: ['Repeats "' + (seen[k] || seen[v.drink.id]) + '" (same Toast drink).'] }); return; }
      seen[k] = seen[v.drink.id] = v.drink.name;
      drinks.push(v.drink);
    });
    var fields = Object.keys(map).filter(function (f) { return f !== 'id'; });
    var used = Object.keys(map).map(function (f) { return map[f]; });
    var unknown = Object.keys(rows[0]).filter(function (h) { return str(h) && used.indexOf(h) < 0 && ignored.indexOf(h) < 0; });
    if (drinks.length > LIMITS.drinks) problems.push({ row: 1, errors: ['A file can have at most ' + LIMITS.drinks + ' drinks (this one has ' + drinks.length + ').'] });
    return { drinks: drinks, problems: problems, duplicates: dupes, fatal: false, fields: fields, ignored: ignored, unknownColumns: unknown };
  }

  var FIELDS = ['name', 'size', 'description', 'abv', 'tags', 'allergens', 'available', 'sort'];
  /**
   * A merge import only changes the columns the file has: a file with just
   * Name, Category and Price must not wipe allergens or bring back 86'd drinks.
   * old: the drink on the menu (or undefined); d: the validated row; fields: columns present.
   */
  function mergeFields(old, d, fields) {
    if (!old || !fields) return d;
    var out = Object.assign({}, d); delete out.keep;
    FIELDS.forEach(function (f) {
      if (f === 'name') return;
      if (fields.indexOf(f) < 0 || (d.keep && d.keep.indexOf(f) >= 0 && old[f] !== undefined)) { if (old[f] === undefined) delete out[f]; else out[f] = old[f]; }
    });
    return out;
  }
  function sameDrink(a, b) {
    return JSON.stringify([a.name, a.size, a.description, a.abv || null, a.tags, a.allergens, a.available]) ===
           JSON.stringify([b.name, b.size, b.description, b.abv || null, b.tags, b.allergens, b.available]);
  }
  /**
   * What an import would do. current: {id: drink}; incoming: [drink];
   * mode 'merge' keeps drinks not in the file, 'replace' removes them.
   */
  function diffImport(current, incoming, mode, fields) {
    current = current || {};
    var added = [], changed = [], same = [], removed = [], ids = Object.create(null);
    incoming.forEach(function (d) {
      ids[d.id] = true;
      var cur = Object.prototype.hasOwnProperty.call(current, d.id) ? current[d.id] : null;
      if (!cur) added.push(d.id); else if (sameDrink(cur, mode === 'merge' ? mergeFields(cur, d, fields) : d)) same.push(d.id); else changed.push(d.id);
    });
    if (mode === 'replace') Object.keys(current).forEach(function (id) { if (!ids[id]) removed.push(id); });
    return { added: added, changed: changed, same: same, removed: removed };
  }

  function csvCell(v) { v = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  var CSV_COLUMNS = ['Name', 'Size', 'Description', 'ABV', 'Tags', 'Allergens', 'Available', 'Id'];
  /** The current menu as csv (also the import template when drinks is empty). */
  function toCSV(drinks) {
    var lines = [CSV_COLUMNS.join(',')];
    (drinks || []).forEach(function (d) {
      lines.push([d.name, d.size || '', d.description || '', d.abv == null ? '' : d.abv,
        (d.tags || []).join('; '), (d.allergens || []).join('; '), d.available === false ? 'no' : 'yes', d.id || ''].map(csvCell).join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }

  // ── Specials ──
  /**
   * validateSpecial: kind 'price' (drinkId + a lower display price for a
   * drink record) or 'limited' (drinkId only: the drink shows on the bar menu
   * only while this special is live). Both run between
   * startDate and endDate (business days, inclusive) and may be limited to
   * days of the week and a daily window (end after midnight is allowed:
   * 22:00 to 02:00 means until 2 AM the next morning).
   */
  function validateSpecial(input, knownDrinkIds) {
    var errors = [], s = {}, src = input || {};
    s.id = str(src.id) || '';
    s.kind = src.kind === 'limited' ? 'limited' : src.kind === 'price' ? 'price' : null;
    if (!s.kind) errors.push('Special type is price or limited-time drink.');
    s.note = str(src.note).slice(0, LIMITS.note);
    if (s.kind) {
      s.drinkId = str(src.drinkId);
      if (!s.drinkId || (knownDrinkIds && knownDrinkIds.indexOf(s.drinkId) < 0)) errors.push('Pick a drink that is on the menu.');
    }
    if (s.kind === 'price') {
      var p = src.price != null && src.price !== '' ? (isInt(src.price) ? src.price : parsePrice(src.price)) : parsePrice(src.priceText);
      if (p == null || p < 0) errors.push('Special price must be a number like 8 or 8.50.'); else s.price = p;
    }
    s.startDate = str(src.startDate); s.endDate = str(src.endDate);
    if (!isDate(s.startDate)) errors.push('Start date is needed.');
    if (!isDate(s.endDate)) errors.push('End date is needed.');
    if (isDate(s.startDate) && isDate(s.endDate) && s.endDate < s.startDate) errors.push('End date is before the start date.');
    if (isDate(s.startDate) && isDate(s.endDate) && Date.parse(s.endDate) - Date.parse(s.startDate) > 400 * 86400000) errors.push('A special can run at most 400 days.');
    var days = splitList(src.days).map(function (d) { return d.toUpperCase().slice(0, 3); });
    if (days.some(function (d) { return DAYS.indexOf(d) < 0; })) errors.push('Days must be MON to SUN.');
    s.days = DAYS.filter(function (d) { return days.indexOf(d) >= 0; });
    if (s.days.length === 7) s.days = [];
    var st = str(src.start), en = str(src.end);
    if (st || en) {
      if (minutesOf(st) === null || minutesOf(en) === null) errors.push('Start and end times need both a valid time.');
      else if (st === en) errors.push('Start and end times can not be the same.');
      else { s.start = st; s.end = en; }
    }
    return { ok: errors.length === 0, special: s, errors: errors };
  }

  /** Is this special running at this moment? Malformed records are never live. */
  function specialActive(s, ms) {
    if (!s || !isDate(s.startDate) || !isDate(s.endDate)) return false;
    var hasWindow = !!(s.start || s.end);
    if (hasWindow && (minutesOf(s.start) === null || minutesOf(s.end) === null)) return false;
    var now = etParts(ms), day;
    if (hasWindow) {
      var st = minutesOf(s.start), en = minutesOf(s.end), m = now.minutes, wrap = en <= st;
      if (!(wrap ? (m >= st || m < en) : (m >= st && m < en))) return false;
      // The window belongs to the business day it began in (before 4 AM that is the day before).
      var back = (wrap && m < en ? 1 : 0) + (st < 240 ? 1 : 0);
      day = { date: addDays(now.date, -back), day: DAYS[(DAYS.indexOf(now.day) + 7 * 2 - back) % 7] };
    } else day = businessDay(ms);
    if (day.date < s.startDate || day.date > s.endDate) return false;
    if (s.days && s.days.length && s.days.indexOf(day.day) < 0) return false;
    return true;
  }
  /** 'live' | 'scheduled' (starts later) | 'ended' | 'idle' (between windows). */
  function specialStatus(s, ms) {
    if (specialActive(s, ms)) return 'live';
    var today = businessDay(ms).date;
    if (today > s.endDate) return 'ended';
    if (today < s.startDate) return 'scheduled';
    return 'idle';
  }

  /** How a drink record relates to Toast: 'live' (on the menu), 'hidden' (record switched off), '86' (86'd in Toast), 'missing' (no Toast drink has this name). */
  function matchStatus(d, toast) {
    var t = toast && toast[toastKey(d && d.name)];
    if (!t) return 'missing';
    if (d.available === false) return 'hidden';
    return t.inStock === false ? '86' : 'live';
  }

  /** Toast items worth showing: a name that starts with a letter or number (Toast also holds helper items such as "# of Glasses"). */
  function usableToast(t) { return !!(t && /^[A-Za-z0-9]/.test(cleanName(t.name))); }
  function recordsByKey(drinks) {
    var m = Object.create(null);
    Object.keys(drinks || {}).forEach(function (id) {
      var d = drinks[id], k = d && toastKey(d.name);
      if (k && !m[k]) m[k] = { id: id, rec: d };
    });
    return m;
  }
  /**
   * The Toast drink a special's drinkId points at: a drink record's id, or,
   * for a Toast drink nobody has added details to yet, the id its name makes.
   * Returns { id, rec, t, key } or null.
   */
  function findToast(id, drinks, toast) {
    if (typeof id !== 'string' || !id || !toast) return null;
    var rec = Object.prototype.hasOwnProperty.call(drinks || {}, id) ? drinks[id] : null;
    if (rec) { var k = toastKey(rec.name); return toast[k] ? { id: id, rec: rec, t: toast[k], key: k } : null; }
    var keys = Object.keys(toast);
    for (var i = 0; i < keys.length; i++) {
      var t = toast[keys[i]];
      if (usableToast(t) && slug(cleanName(t.name)) === id) return { id: id, rec: null, t: t, key: keys[i] };
    }
    return null;
  }
  /**
   * Everything the manager list shows: every Toast drink (with its details
   * record if it has one), then records Toast has no drink for.
   * status: 'off' (not on the bar menu: no record yet, or switched off) | '86' (on the menu but Toast has it 86'd) | 'live' | 'missing'.
   * Returns [{ id, key, name, rec, t, status }].
   */
  function listRows(drinks, toast) {
    var byKey = recordsByKey(drinks), out = [], seen = Object.create(null);
    Object.keys(toast || {}).map(function (k) { return [k, toast[k]]; }).filter(function (e) { return usableToast(e[1]); })
      .sort(function (a, b) { return (isInt(a[1].order) ? a[1].order : 1e9) - (isInt(b[1].order) ? b[1].order : 1e9); })
      .forEach(function (e) {
        var k = e[0], t = e[1], hit = byKey[k], rec = hit ? hit.rec : null;
        seen[k] = true;
        out.push({ id: hit ? hit.id : slug(cleanName(t.name)), key: k, name: cleanName(t.name), rec: rec, t: t,
          status: !rec || rec.available === false ? 'off' : t.inStock === false ? '86' : 'live' });
      });
    Object.keys(drinks || {}).forEach(function (id) {
      var d = drinks[id], k = d && toastKey(d.name);
      if (!d || (k && seen[k])) return;
      out.push({ id: id, key: k, name: str(d.name), rec: d, t: null, status: 'missing' });
    });
    return out;
  }

  /**
   * The bar menu as a guest sees it now. A Toast drink is on the menu only
   * when a manager added it (a record with the same name exists and is not
   * switched off); name, price(s), section and order come from Toast, and the
   * record adds the description, photo, tags, allergens and so on. A drink is
   * left off while Toast has it 86'd.
   *   drinks:  {id: record}      (menu/drinks)
   *   specials:{id: special}     (menu/drinkSpecials)
   *   toast:   {key: item}       (menu/toastDrinks: name, group, order, price in cents or null, sizes [{name, price}] or null, inStock)
   * A price special shows the lower price with the Toast price as "was"
   * (display only: the register charges what Toast says). A drink named by
   * a limited-time special shows only while one is live. Returns
   * [{category, items:[...]}] in Toast's section order.
   */
  function buildMenu(drinks, specials, toast, ms) {
    var live = Object.create(null), limitedIds = Object.create(null), priceOverride = Object.create(null);
    Object.keys(specials || {}).forEach(function (id) {
      var s = specials[id];
      if (!s || (s.kind !== 'price' && s.kind !== 'limited') || typeof s.drinkId !== 'string') return;
      if (s.kind === 'limited') limitedIds[s.drinkId] = true;
      if (!specialActive(s, ms)) return;
      if (s.kind === 'limited') { live[s.drinkId] = s; return; }
      if (!(isInt(s.price) && s.price >= 0)) return;
      if (priceOverride[s.drinkId] == null || s.price < priceOverride[s.drinkId]) priceOverride[s.drinkId] = s.price;
    });
    var byKey = recordsByKey(drinks), items = [];
    Object.keys(toast || {}).forEach(function (key) {
      var t = toast[key];
      if (!usableToast(t) || t.inStock === false) return;
      var hit = byKey[key], rec = hit ? hit.rec : null;
      var id = hit ? hit.id : slug(cleanName(t.name));
      if (rec && rec.available === false) return;       // switched off by a manager
      if (!rec && !live[id]) return;                    // not added to the menu (a live limited-time special does add it for its window)
      if (!id || (limitedIds[id] && !live[id])) return;
      var sizes = Array.isArray(t.sizes) ? t.sizes.filter(function (z) { return z && str(z.name) && isInt(z.price); }) : [];
      var it = Object.assign({ tags: [], allergens: [] }, rec || {}, { id: id, name: cleanName(t.name), category: str(t.group) || 'Drinks', path: str(t.path) || str(t.group), order: isInt(t.order) ? t.order : 1e9 });
      if (sizes.length) it.sizes = sizes; else if (isInt(t.price)) it.price = t.price;
      if (it.price != null && priceOverride[id] != null && priceOverride[id] < it.price) { it.was = it.price; it.price = priceOverride[id]; it.special = true; }
      if (live[id]) { it.limited = true; it.note = live[id].note; it.endDate = live[id].endDate; }
      items.push(it);
    });
    var groups = Object.create(null), first = Object.create(null);
    items.forEach(function (it) {
      (groups[it.category] = groups[it.category] || []).push(it);
      first[it.category] = Math.min(first[it.category] == null ? 1e9 : first[it.category], it.order);
    });
    var names = Object.keys(groups).sort(function (a, b) { return first[a] - first[b] || a.localeCompare(b); });
    return names.map(function (n) {
      groups[n].sort(function (a, b) {
        return (b.limited ? 1 : 0) - (a.limited ? 1 : 0) ||
          (a.sort == null ? 1e9 : a.sort) - (b.sort == null ? 1e9 : b.sort) || a.order - b.order || String(a.name).localeCompare(String(b.name));
      });
      return { category: n, items: groups[n] };
    });
  }

  // ── Bar menu tabs: Cocktails, Beer, Wine ──
  // Each Toast section goes under one tab by its top-level Toast group (the
  // first part of its path, e.g. "Beer" in "Beer › Draft Beer"), then by its
  // own name. Anything that is neither beer nor wine (house cocktails,
  // spirits, zero-proof) goes under Cocktails.
  var BAR_TABS = [{ id: 'cocktails', label: 'Cocktails' }, { id: 'beer', label: 'Beer' }, { id: 'wine', label: 'Wine' }];
  var BEER_RE = /\b(beers?|drafts?|cans?|bottles?|ciders?|seltzers?|ales?|lagers?|ipas?)\b/i;
  var WINE_RE = /\b(wines?|bubbles|sparkling|champagnes?|prosecco|cava|ros[eé]|port|sherry|sake|vino)(?![a-z])/i;
  function barTab(path, group) {
    var top = str(String(path || '').split('›')[0]), leaf = str(group);
    var pick = function (t) { return WINE_RE.test(t) ? 'wine' : BEER_RE.test(t) ? 'beer' : null; };
    return pick(top) || pick(leaf) || 'cocktails';
  }
  /** buildMenu's sections split into the three tabs, in Toast's order: [{ id, label, sections: [{ category, items }] }]. */
  function barTabs(groups) {
    var out = BAR_TABS.map(function (t) { return { id: t.id, label: t.label, sections: [] }; });
    var at = { cocktails: out[0], beer: out[1], wine: out[2] };
    (groups || []).forEach(function (g) {
      var first = g.items && g.items[0];
      at[barTab(first && first.path, g.category)].sections.push(g);
    });
    return out;
  }

  // ── Food specials: staff only, for the paper sheet ──
  // The saved list (menu/specialsLibrary) holds every special a manager has
  // made; a night (menu/nightlySpecials/{date}) holds its own ordered copies,
  // each with libId pointing back to the saved one when it came from there.
  var LIB_ID = /^[A-Za-z0-9]{1,40}$/;
  function foodItem(it, label, errors) {
    var name = str(it && it.name);
    if (!name) { errors.push(label + ' needs a name.'); return null; }
    if (name.length > LIMITS.name) errors.push(label + ' name is too long.');
    var ing = str(it.ingredients), desc = str(it.description);
    if (ing.length > LIMITS.ingredients) errors.push(label + ' ingredients are too long.');
    if (desc.length > LIMITS.description) errors.push(label + ' description is too long.');
    var al = matchList(splitList(it.allergens), ALLERGENS);
    if (al.bad.length) errors.push(label + ': unknown allergen ' + al.bad.join(', ') + '.');
    var row = { name: name, ingredients: ing, description: desc, allergens: al.ok };
    if (it.price != null && str(it.price) !== '') {
      var p = isInt(it.price) ? it.price : parsePrice(it.price);
      if (p == null) errors.push(label + ' price must be a number.'); else row.price = p;
    }
    return row;
  }
  function validateNightly(input) {
    var errors = [], src = input || {}, out = { date: str(src.date), items: [] };
    if (!isDate(out.date)) errors.push('Date is needed.');
    var items = Array.isArray(src.items) ? src.items : [];
    if (items.length > LIMITS.nightlyItems) errors.push('At most ' + LIMITS.nightlyItems + ' items a night.');
    items.forEach(function (it, i) {
      var row = foodItem(it, 'Item ' + (i + 1), errors);
      if (!row) return;
      var lid = str(it.libId);
      if (lid) { if (LIB_ID.test(lid)) row.libId = lid; else errors.push('Item ' + (i + 1) + ' has a bad saved-list link.'); }
      out.items.push(row);
    });
    return { ok: errors.length === 0, nightly: out, errors: errors };
  }
  /** One special for the saved list. */
  function validateLibrarySpecial(input) {
    var errors = [], row = foodItem(input || {}, 'The special', errors);
    return { ok: errors.length === 0 && !!row, special: row, errors: errors };
  }
  /** Olivero-style menu price: bare number, cents only when not .00 (1400 -> "14", 1450 -> "14.5", 1425 -> "14.25"). */
  function menuPrice(cents) {
    if (!isInt(cents)) return '';
    var d = Math.floor(cents / 100), c = cents % 100;
    if (!c) return String(d);
    return d + '.' + (c % 10 ? String(c).padStart(2, '0') : String(c / 10));
  }

  return {
    ZONE: ZONE, DAYS: DAYS, ALLERGENS: ALLERGENS, TAGS: TAGS, LIMITS: LIMITS,
    CSV_COLUMNS: CSV_COLUMNS, FIELDS: FIELDS, STORAGE_HOST: STORAGE_HOST,
    money: money, parsePrice: parsePrice, clock: clock, slug: slug, toastKey: toastKey, cleanName: cleanName, matchStatus: matchStatus, usableToast: usableToast, findToast: findToast, listRows: listRows, isDate: isDate,
    businessDay: businessDay, addDays: addDays, validPhotoUrl: validPhotoUrl,
    validateDrink: validateDrink, parseCSV: parseCSV, drinksFromRows: drinksFromRows,
    diffImport: diffImport, mergeFields: mergeFields, toCSV: toCSV,
    validateSpecial: validateSpecial, specialActive: specialActive, specialStatus: specialStatus,
    buildMenu: buildMenu, BAR_TABS: BAR_TABS, barTab: barTab, barTabs: barTabs, validateNightly: validateNightly, validateLibrarySpecial: validateLibrarySpecial, menuPrice: menuPrice, LIB_ID: LIB_ID,
  };
});
