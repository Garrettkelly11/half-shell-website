/*
 * Oyster prices and happy hour on the site (Data Ownership Build Guide S5;
 * "Price and Happy Hour Plan", decided 06/10/2026).
 *
 * Toast is the only source of an oyster's regular price: the Toast sync
 * writes menu/prices/{id} = {price, strategy, updatedAt}. Happy hour is a
 * rule managers set on the employee page:
 *   menu/happyHour/schedule = {days: ['MON',...], start: '15:00', end: '18:00', percentOff: 50}
 *   menu/happyHour/today    = {state: 'on'|'off', until}   (until the next 4 AM)
 * This file works out, on the device and in New York time, whether it is
 * happy hour now and what each oyster costs. Pure functions (no network):
 * used by index.html, oyster.html, curated-flights.html and employee.html
 * as a global (HS_PRICE), and by tools/price-display-test.js via require.
 *
 * Rounding: to the cent, half a cent up ($4.25 half off → $2.13), as Toast
 * does (Garrett, 06/10/2026).
 */
(function (root) {
  'use strict';

  var ZONE = 'America/New_York';
  var DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  var DAY_NAMES = { MON: 'Mon', TUE: 'Tue', WED: 'Wed', THU: 'Thu', FRI: 'Fri', SAT: 'Sat', SUN: 'Sun' };
  var WEEKDAY = { Mon: 'MON', Tue: 'TUE', Wed: 'WED', Thu: 'THU', Fri: 'FRI', Sat: 'SAT', Sun: 'SUN' };

  var fmt = null;
  /** Day ('MON'…) and minutes since midnight, New York time. */
  function nyNow(ms) {
    if (!fmt) {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: ZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      });
    }
    var p = {};
    fmt.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    return { day: WEEKDAY[p.weekday], minutes: Number(p.hour) * 60 + Number(p.minute) };
  }

  function toMinutes(t) {
    var m = /^(\d{2}):(\d{2})$/.exec(t || '');
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  /** Today's switch, if it hasn't run out (4 AM). */
  function todayState(hh, ms) {
    var t = hh && hh.today;
    return t && t.until > ms && (t.state === 'on' || t.state === 'off') ? t.state : null;
  }

  /** Is it happy hour at `ms`? */
  function isHappyHour(hh, ms) {
    var s = hh && hh.schedule;
    if (!s) return false;
    var start = toMinutes(s.start), end = toMinutes(s.end);
    if (start === null || end === null || !(s.percentOff > 0)) return false;
    var today = todayState(hh, ms);
    if (today === 'off') return false;
    var now = nyNow(ms);
    var scheduled = (s.days || []).indexOf(now.day) >= 0;
    if (!scheduled && today !== 'on') return false;
    return now.minutes >= start && now.minutes < end;
  }

  /** Happy hour price in cents, half a cent up. */
  function discountCents(cents, percentOff) {
    return Math.floor((cents * (100 - percentOff) + 50) / 100);
  }

  /** "$5", "$4.50". */
  function money(cents) {
    return '$' + (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));
  }

  /**
   * What to show for one oyster at `ms`:
   *   null                                   no Toast price (show nothing)
   *   {text: 'MP', mp: true}                 open / market price
   *   {text: '$5'}                           regular price
   *   {text: '$2.50', regular: '$5', happy: true, label: 'Happy hour $2.50, regularly $5'}
   * `withHappyHour` false gives the regular price even during happy hour
   * (the employee page's table).
   */
  function priceFor(entry, hh, ms, withHappyHour) {
    if (!entry) return null;
    if (entry.strategy === 'OPEN_PRICE' || typeof entry.price !== 'number') {
      return entry.strategy === 'OPEN_PRICE' ? { text: 'MP', mp: true, label: 'Market price' } : null;
    }
    var cents = Math.round(entry.price * 100);
    if (withHappyHour !== false && isHappyHour(hh, ms)) {
      var d = discountCents(cents, hh.schedule.percentOff);
      if (d < cents) {
        return { text: money(d), regular: money(cents), happy: true,
          label: 'Happy hour ' + money(d) + ', regularly ' + money(cents) };
      }
    }
    return { text: money(cents), label: money(cents) };
  }

  /** HTML for a price (escaped; numbers and fixed words only). */
  function priceHtml(p, cls) {
    if (!p) return '';
    var c = cls || 'card-price';
    if (p.happy) {
      return '<div class="' + c + ' hh-price" aria-label="' + p.label + '">' +
        '<s aria-hidden="true">' + p.regular + '</s> <span aria-hidden="true">' + p.text + '</span></div>';
    }
    return '<div class="' + c + '"' + (p.mp ? ' aria-label="Market price"' : '') + '>' + p.text + '</div>';
  }

  /** "3 PM", "3:30 PM", "12 PM". */
  function clock(t) {
    var m = toMinutes(t);
    if (m === null) return t;
    var h = Math.floor(m / 60), min = m % 60, ap = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + (min ? ':' + (min < 10 ? '0' : '') + min : '') + ' ' + ap;
  }

  /** "3–6 PM", "11 AM–2 PM". */
  function clockRange(start, end) {
    var a = clock(start), b = clock(end);
    var ap = a.slice(-2) === b.slice(-2);
    return (ap ? a.slice(0, -3) : a) + '–' + b;
  }

  /** "Mon–Thu", "Mon, Wed, Fri". */
  function dayRange(days) {
    var idx = (days || []).map(function (d) { return DAYS.indexOf(d); })
      .filter(function (i) { return i >= 0; }).sort(function (a, b) { return a - b; });
    var runs = [];
    idx.forEach(function (i) {
      var last = runs[runs.length - 1];
      if (last && i === last[1] + 1) last[1] = i; else runs.push([i, i]);
    });
    return runs.map(function (r) {
      var a = DAY_NAMES[DAYS[r[0]]], b = DAY_NAMES[DAYS[r[1]]];
      return r[0] === r[1] ? a : r[1] === r[0] + 1 ? a + ', ' + b : a + '–' + b;
    }).join(', ');
  }

  /**
   * The banner: {text, live} or null when there's no happy hour set.
   *   live:   "Happy hour until 6 PM: oysters 50% off"
   *   otherwise "Happy hour Mon–Thu 3–6 PM: oysters 50% off", with
   *   " (not today)" when today is switched off and today is scheduled.
   */
  function banner(hh, ms) {
    var s = hh && hh.schedule;
    if (!s || !(s.percentOff > 0) || toMinutes(s.start) === null) return null;
    var off = 'oysters ' + s.percentOff + '% off';
    if (isHappyHour(hh, ms)) return { text: 'Happy hour until ' + clock(s.end) + ': ' + off, live: true };
    var line = 'Happy hour ' + dayRange(s.days) + ' ' + clockRange(s.start, s.end) + ': ' + off;
    var today = todayState(hh, ms);
    var now = nyNow(ms);
    if (today === 'off' && (s.days || []).indexOf(now.day) >= 0) line += ' (not today)';
    if (today === 'on' && (s.days || []).indexOf(now.day) < 0 && now.minutes < toMinutes(s.end)) {
      line = 'Happy hour today ' + clockRange(s.start, s.end) + ': ' + off;
    }
    return { text: line, live: false };
  }

  var api = {
    ZONE: ZONE, DAYS: DAYS, nyNow: nyNow, todayState: todayState, isHappyHour: isHappyHour,
    discountCents: discountCents, money: money, priceFor: priceFor, priceHtml: priceHtml,
    clock: clock, clockRange: clockRange, dayRange: dayRange, banner: banner,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HS_PRICE = api;
})(this);
