/**
 * Passport tab on the employee page (managers and above). Plan: project doc
 * "Passport P2 and Manager Dashboard Plan" (17/11/2026).
 *
 * Shows totals only. It reads passportStats/, which the warehouse job writes
 * each morning (half-shell-warehouse, src/passport-stats.js) and only
 * managers can read (database.rules.json). It never reads users/: the page
 * can't see any one guest's passport, and nothing here names a guest.
 *
 * The tab stays hidden until passportStats exists (the job's PASSPORT_STATS
 * switch), so it appears only once the totals are being written.
 *
 * Needs data/regions.js and data/stamps.js (stamp names) and HS_CATALOG
 * (src/catalog-editor.js: who counts as a manager).
 */
window.hsPassportDash = (function () {
  'use strict';
  var panel = document.getElementById('tab-passport');
  var tabBtn = document.querySelector('.page-tab[data-tab="passport"]');
  var ref = null, stats = null;
  var ui = { sort: 'sold30', dir: -1, catalogOnly: true, q: '', dailyTable: false };
  // Checked with the dataviz palette checks (light surface): color-blind
  // separation and contrast pass. Identity never rests on color alone:
  // legend, end labels and a table view.
  var COLORS = { active: '#1b88a8', newPassports: '#c96f1a' };

  // ── helpers ──
  function make(tag, attrs, text) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'on') Object.keys(v).forEach(function (ev) { n.addEventListener(ev, v[ev]); });
      else n.setAttribute(k, v === true ? '' : v);
    });
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function kids(p, list) { list.forEach(function (c) { if (c) p.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }); return p; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function num(n) { return (Number(n) || 0).toLocaleString('en-US'); }
  function pct(a, b) { return b ? Math.round((a / b) * 100) + '%' : '–'; }
  function fmtDay(d) {
    var p = d.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  }
  function rating(r) { return r === null || r === undefined ? '–' : (Number(r) === 10 ? '10' : Number(r).toFixed(1)); }

  function stampName(id) {
    var S = window.HS_STAMPS;
    if (/^region-/.test(id)) {
      var code = id.slice(7), r = (window.HS_REGIONS || []).filter(function (x) { return x.code === code; })[0];
      return (r ? r.name : code.toUpperCase()) + ' (region)';
    }
    var all = S ? (S.LADDERS || []).concat(S.SINGLES || []) : [];
    var d = all.filter(function (x) { return x.id === id; })[0];
    return d ? d.name : id;
  }
  function tierLabel(id, tier) {
    var S = window.HS_STAMPS;
    return S && S.tierName ? S.tierName({ id: id }, tier) : tier;
  }

  // ── pieces ──
  function tile(value, label, sub) {
    return kids(make('div', { class: 'pd-tile' }), [make('b', {}, value), make('span', {}, label), sub ? make('small', {}, sub) : null]);
  }
  function section(title, note) {
    var s = make('section', { class: 'pd-section' });
    s.appendChild(make('h3', { class: 'pd-h' }, title));
    if (note) s.appendChild(make('p', { class: 'pd-note' }, note));
    return s;
  }

  /** New passports and active guests per business day: two lines, legend, end labels, hover. */
  function dailyChart(daily) {
    var days = Object.keys(daily).sort();
    var series = [['active', 'Active guests'], ['newPassports', 'New passports']];
    // Drawn at the panel's own width, so labels stay a readable size on a phone.
    var W = Math.max(300, Math.min(900, ((panel && (panel.clientWidth || panel.parentNode.clientWidth)) || 640) - 18)), H = W < 500 ? 200 : 240, L = 30, R = 100, T = 12, B = 26;
    var max = 1;
    days.forEach(function (d) { series.forEach(function (s) { max = Math.max(max, daily[d][s[0]] || 0); }); });
    var step = max <= 5 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : Math.ceil(max / 50) * 10;
    var top = Math.ceil(max / step) * step;
    var x = function (i) { return L + (days.length > 1 ? (i * (W - L - R)) / (days.length - 1) : 0); };
    var y = function (v) { return T + (H - T - B) * (1 - v / top); };
    var NS = 'http://www.w3.org/2000/svg';
    function s(tag, a) { var n = document.createElementNS(NS, tag); Object.keys(a || {}).forEach(function (k) { n.setAttribute(k, a[k]); }); return n; }
    var svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'pd-chart', role: 'img',
      'aria-label': 'New passports and active guests per day, last ' + days.length + ' days. Show as a table for the numbers.' });
    for (var g = 0; g <= top; g += step) {
      svg.appendChild(s('line', { x1: L, x2: W - R, y1: y(g), y2: y(g), class: 'pd-grid' }));
      var t = s('text', { x: L - 6, y: y(g) + 4, class: 'pd-axis', 'text-anchor': 'end' }); t.textContent = g; svg.appendChild(t);
    }
    [0, Math.floor((days.length - 1) / 2), days.length - 1].forEach(function (i) {
      if (!days[i]) return;
      var t = s('text', { x: x(i), y: H - 6, class: 'pd-axis', 'text-anchor': i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle' });
      t.textContent = fmtDay(days[i]); svg.appendChild(t);
    });
    var ends = [];
    series.forEach(function (se) {
      var d = days.map(function (day, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(daily[day][se[0]] || 0).toFixed(1); }).join(' ');
      svg.appendChild(s('path', { d: d, fill: 'none', stroke: COLORS[se[0]], 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      ends.push({ y: y(daily[days[days.length - 1]][se[0]] || 0), label: se[1], color: COLORS[se[0]] });
    });
    // End labels, nudged apart so they never overlap.
    ends.sort(function (a, b) { return a.y - b.y; });
    for (var i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
    ends.forEach(function (e) {
      svg.appendChild(s('rect', { x: W - R + 6, y: e.y - 4, width: 8, height: 8, rx: 2, fill: e.color }));
      var t = s('text', { x: W - R + 18, y: e.y + 4, class: 'pd-endlabel' }); t.textContent = e.label; svg.appendChild(t);
    });
    // Hover or tap: crosshair and tooltip.
    var cross = s('line', { y1: T, y2: H - B, class: 'pd-cross', visibility: 'hidden' });
    svg.appendChild(cross);
    var dots = series.map(function (se) { var c = s('circle', { r: 4, fill: COLORS[se[0]], stroke: '#fff', 'stroke-width': 2, visibility: 'hidden' }); svg.appendChild(c); return c; });
    var hit = s('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent' });
    svg.appendChild(hit);
    var wrap = make('div', { class: 'pd-chart-wrap' });
    var tip = make('div', { class: 'pd-tip', hidden: true });
    function show(evt) {
      var box = svg.getBoundingClientRect(), px = ((evt.clientX - box.left) / box.width) * W;
      var i = Math.max(0, Math.min(days.length - 1, Math.round(((px - L) / (W - L - R)) * (days.length - 1))));
      var day = days[i], dd = daily[day];
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      series.forEach(function (se, k) { dots[k].setAttribute('cx', x(i)); dots[k].setAttribute('cy', y(dd[se[0]] || 0)); dots[k].setAttribute('visibility', 'visible'); });
      clear(tip);
      tip.appendChild(make('strong', {}, fmtDay(day)));
      series.forEach(function (se) {
        tip.appendChild(kids(make('div', {}), [make('i', { style: 'background:' + COLORS[se[0]] }), se[1] + ': ' + num(dd[se[0]])]));
      });
      tip.appendChild(make('div', { class: 'pd-tip-sub' }, 'Oysters: ' + num(dd.handLogged) + ' by hand, ' + num(dd.fromChecks) + ' from checks'));
      tip.hidden = false;
      var left = (x(i) / W) * box.width;
      tip.style.left = Math.min(box.width - 180, Math.max(0, left + 12)) + 'px';
    }
    function hide() { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); dots.forEach(function (d) { d.setAttribute('visibility', 'hidden'); }); }
    hit.addEventListener('pointermove', show);
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', hide);
    var legend = kids(make('div', { class: 'pd-legend' }), series.map(function (se) {
      return kids(make('span', {}), [make('i', { style: 'background:' + COLORS[se[0]] }), se[1]]);
    }));
    return kids(wrap, [legend, svg, tip]);
  }

  function dailyTable(daily) {
    var t = make('table', { class: 'pd-table' });
    t.appendChild(kids(make('thead'), [kids(make('tr'), ['Day', 'New passports', 'Active guests', 'Oysters by hand', 'Oysters from checks'].map(function (h) { return make('th', { scope: 'col' }, h); }))]));
    var tb = make('tbody');
    Object.keys(daily).sort().reverse().forEach(function (d) {
      var r = daily[d];
      tb.appendChild(kids(make('tr'), [make('th', { scope: 'row' }, fmtDay(d)), make('td', {}, num(r.newPassports)), make('td', {}, num(r.active)), make('td', {}, num(r.handLogged)), make('td', {}, num(r.fromChecks))]));
    });
    t.appendChild(tb);
    return kids(make('div', { class: 'pd-scroll pd-daily' }), [t]);
  }

  // [field, heading, first sort direction]
  var COLS = [
    ['name', 'Oyster', 1], ['rating', 'Rating', -1], ['ratings', 'Ratings', -1], ['raters', 'Guests who rated', -1],
    ['rating30', 'Rating, 30 days', -1], ['sold30', 'Sold, 30 days', -1], ['logged30', 'In passports, 30 days', -1]
  ];
  function oysterTable(list) {
    var rows = Object.keys(list).map(function (id) { var o = list[id]; o.id = id; return o; }).filter(function (o) {
      if (ui.catalogOnly && !o.inCatalog) return false;
      return !ui.q || String(o.name).toLowerCase().indexOf(ui.q.toLowerCase()) >= 0;
    });
    rows.sort(function (a, b) {
      var k = ui.sort, va = a[k], vb = b[k];
      if (k === 'name') return ui.dir * String(va).localeCompare(String(vb));
      va = va === null || va === undefined ? -1 : va; vb = vb === null || vb === undefined ? -1 : vb;
      return ui.dir * (va - vb) || String(a.name).localeCompare(String(b.name));
    });
    var t = make('table', { class: 'pd-table pd-oysters' });
    var hr = make('tr');
    COLS.forEach(function (c) {
      var on = ui.sort === c[0];
      var th = make('th', { scope: 'col', 'aria-sort': on ? (ui.dir > 0 ? 'ascending' : 'descending') : 'none' });
      th.appendChild(make('button', { type: 'button', class: 'pd-sort', on: { click: function () {
        if (ui.sort === c[0]) ui.dir = -ui.dir; else { ui.sort = c[0]; ui.dir = c[2]; }
        draw();
      } } }, c[1] + (on ? (ui.dir > 0 ? ' ▲' : ' ▼') : '')));
      hr.appendChild(th);
    });
    t.appendChild(kids(make('thead'), [hr]));
    var tb = make('tbody');
    rows.forEach(function (o) {
      tb.appendChild(kids(make('tr'), [
        make('th', { scope: 'row' }, o.name + (o.inCatalog ? '' : ' (not in catalog)')),
        make('td', {}, rating(o.rating)), make('td', {}, num(o.ratings)), make('td', {}, num(o.raters)),
        make('td', {}, rating(o.rating30)), make('td', {}, num(o.sold30)), make('td', {}, num(o.logged30))
      ]));
    });
    if (!rows.length) tb.appendChild(kids(make('tr'), [make('td', { colspan: COLS.length }, 'No oysters match.')]));
    t.appendChild(tb);
    return kids(make('div', { class: 'pd-scroll pd-oyster-wrap' }), [t]);
  }

  function stampTable(st) {
    var ids = Object.keys(st || {}).sort(function (a, b) {
      var ra = /^region-/.test(a), rb = /^region-/.test(b);
      return ra === rb ? stampName(a).localeCompare(stampName(b)) : (ra ? 1 : -1);
    });
    if (!ids.length) return make('p', { class: 'pd-note' }, 'No stamps earned yet.');
    var tiers = ['bronze', 'silver', 'gold', 'pearl'];
    var t = make('table', { class: 'pd-table' });
    t.appendChild(kids(make('thead'), [kids(make('tr'), [make('th', { scope: 'col' }, 'Stamp'), make('th', { scope: 'col' }, 'Guests at each level')])]));
    var tb = make('tbody');
    ids.forEach(function (id) {
      var c = st[id], parts = c.single ? [num(c.single) + ' earned'] :
        tiers.filter(function (k) { return c[k]; }).map(function (k) { return tierLabel(id, k) + ' ' + num(c[k]); });
      tb.appendChild(kids(make('tr'), [make('th', { scope: 'row' }, stampName(id)), make('td', {}, parts.join(' · '))]));
    });
    t.appendChild(tb);
    return kids(make('div', { class: 'pd-scroll' }), [t]);
  }

  function linkingPart(l) {
    var s = section('Check matching', 'Checks with at least one oyster that linked to a passport. Only nights the warehouse matched are counted.');
    if (!l || !l.on) { s.appendChild(make('p', { class: 'pd-note' }, 'Check matching isn’t on yet.')); return s; }
    function line(w, label) {
      return tile(pct(w.linked, w.checks), label, num(w.linked) + ' of ' + num(w.checks) + ' checks · phone ' + num(w.phone) + ', card ' + num(w.card) + (w.both ? ', both ' + num(w.both) : ''));
    }
    s.appendChild(kids(make('div', { class: 'pd-tiles' }), [
      line(l.days7, 'Linked, last 7 days'), line(l.days30, 'Linked, last 30 days'),
      tile(num(l.days30.multi), 'Linked to 2+ passports', 'last 30 days'),
      tile(num(l.hidden30), 'Hidden by guests', 'last 30 days'),
      tile(num(l.cardHereNoMatch30) + ' of ' + num(l.cardHere30), 'Card added, here, no match', 'guest-days, last 30 days')
    ]));
    if (l.cardHere30 >= 10 && l.cardHereNoMatch30 / l.cardHere30 > 0.5) {
      s.appendChild(make('p', { class: 'pd-note warn' }, 'More than half the guests who added a card and were here got no check matched. They may be paying with Apple Pay or Google Pay, whose last 4 digits can differ from the plastic card’s, or someone else paid.'));
    }
    return s;
  }

  function draw() {
    if (!panel) return;
    clear(panel);
    if (!stats) { panel.appendChild(make('p', { class: 'pd-note' }, 'Loading…')); return; }
    var t = stats.totals || {}, when = stats.asOf ? new Date(stats.asOf) : null;
    panel.appendChild(make('h2', { class: 'section-title' }, 'Oyster Passport'));
    panel.appendChild(make('p', { class: 'pd-note' }, 'Totals across all passports. No guest’s name, phone or notes are shown here.' +
      (when ? ' Updated ' + when.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '.' : '')));

    var a = section('Sign-ups and activity');
    a.appendChild(kids(make('div', { class: 'pd-tiles' }), [
      tile(num(t.passports), 'Passports'), tile(num(t.newThisWeek), 'New this week'),
      tile(num(t.active30), 'Active, last 30 days', 'logged an oyster or had a check linked'),
      tile(num(t.returning), 'Returning guests', '2 or more visit days'),
      tile(pct(t.withCard, t.passports), 'Added a card', num(t.withCard) + ' passports')
    ]));
    var daily = stats.daily || {};
    if (Object.keys(daily).length) {
      a.appendChild(ui.dailyTable ? dailyTable(daily) : dailyChart(daily));
      a.appendChild(make('button', { type: 'button', class: 'save-btn pd-toggle', on: { click: function () { ui.dailyTable = !ui.dailyTable; draw(); } } },
        ui.dailyTable ? 'Show as a chart' : 'Show as a table'));
    }
    panel.appendChild(a);

    var w = stats.window || {};
    var r = section('Ratings and sales', 'Rating: the average out of 10, each guest counted once per oyster. Sold: oysters sold in Toast. In passports: oysters guests have in their passports. 30 days: ' +
      (w.from30 ? fmtDay(w.from30) + ' to ' + fmtDay(w.to) : 'the last 30 days') + '.');
    var search = make('input', { type: 'search', class: 'pd-search', placeholder: 'Find an oyster', 'aria-label': 'Find an oyster', value: ui.q });
    search.addEventListener('input', function () {
      ui.q = search.value;
      var old = r.querySelector('.pd-oyster-wrap');
      old.parentNode.replaceChild(oysterTable(stats.oysters || {}), old);
    });
    var only = make('input', { type: 'checkbox', id: 'pd-catalog-only', checked: ui.catalogOnly });
    only.addEventListener('change', function () { ui.catalogOnly = only.checked; draw(); });
    r.appendChild(kids(make('div', { class: 'pd-filters' }), [search, kids(make('label', { for: 'pd-catalog-only', class: 'pd-check' }), [only, ' Current catalog only'])]));
    r.appendChild(oysterTable(stats.oysters || {}));
    panel.appendChild(r);

    var sp = section('Stamps');
    sp.appendChild(stampTable(stats.stamps));
    panel.appendChild(sp);

    panel.appendChild(linkingPart(stats.linking));
  }

  // Redraw when the tab opens: the chart is sized to the panel, which is hidden until then.
  if (tabBtn) tabBtn.addEventListener('click', function () { setTimeout(draw, 0); });

  function start() {
    if (ref) return;
    ref = firebase.database().ref('passportStats');
    ref.on('value', function (snap) {
      stats = snap.val();
      if (tabBtn) tabBtn.hidden = !stats;
      draw();
    }, function () { stats = null; if (tabBtn) tabBtn.hidden = true; });
  }
  function stop() {
    if (ref) { ref.off(); ref = null; }
    stats = null;
    if (tabBtn) tabBtn.hidden = true;
    if (panel) clear(panel);
  }
  return {
    signedIn: function (claims) {
      var manager = !!(claims && window.HS_CATALOG && window.HS_CATALOG.isManager(claims));
      if (manager) start(); else stop();
    },
    signedOut: function () { stop(); }
  };
})();
