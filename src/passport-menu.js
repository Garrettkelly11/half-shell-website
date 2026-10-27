/*
 * Oyster Passport on tonight's menu and Curated Flights (Build Sheet 5.8,
 * 5.9). Global HS_PASSPORT_MENU. Loaded by index.html and
 * curated-flights.html only on a phone with a stored Passport sign-in, after
 * the menu has drawn, so a signed-out guest downloads none of this.
 *
 * The page calls, after each draw:
 *   HS_PASSPORT_MENU.cards(grid, servedIds)    tonight's menu (index.html)
 *   HS_PASSPORT_MENU.flights(grid, servedIds)  Curated Flights
 * and sets HS_MENU_PAGE.redraw() so this file can ask for a fresh draw.
 *
 * Signed in with a complete profile: account icon -> passport, My Flight
 * icon with a count while a flight is open, both pinned top-right once the
 * header scrolls away; on each oyster card + / - n +, "Your rating" or
 * "Tried · Rate it", and "You might like"; "Log this flight" on each flight;
 * "here today" for the business day (menu only); the stamp celebration.
 * Signed in without a profile, or the passport can't be read: the page
 * stays exactly as it is for everyone else.
 */
(function (root) {
  'use strict';
  var doc = root.document;
  var P = root.HS_PASSPORT, S = root.HS_STORE;
  var s = null;                        // the session, once open
  var view = { kind: null, grid: null, served: [] };
  var why = {};                        // "You might like" reasons shown

  var CSS = [
    '.pp-icons{position:absolute;top:.85rem;right:1rem;z-index:10;display:flex;gap:.4rem}',
    '.pp-icons .hero-login-link{position:relative;top:auto;right:auto}',
    '.pp-icons .hero-login-link[hidden]{display:none}',
    '.pp-icons.docked{position:fixed;top:.6rem;right:.75rem;z-index:100}',
    '.pp-icons.docked .hero-login-link{background:rgba(14,45,58,.92)}',
    '.pp-icons .pp-count{position:absolute;top:-6px;right:-6px;min-width:18px;height:18px;padding:0 4px;border-radius:9px;background:#e89438;color:#0e2d3a;font:700 .66rem/18px "Roboto Mono",monospace;text-align:center}',
    '.pp-bar{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;padding:.6rem 1.25rem .9rem;border-top:1px dotted #bcd4ce;font-family:Lato,sans-serif;font-size:.8rem;color:#29525f}',
    '.pp-bar .pp-info{flex:1 1 140px;display:flex;flex-direction:column;gap:.25rem}',
    '.pp-bar a{color:#2a7f94}',
    '.pp-bar .pp-mine{font-weight:700;color:#0e2d3a}',
    '.pp-bar .pp-mine b{color:#e89438}',
    '.pp-like{align-self:flex-start;background:#fff3e2;border:1px solid #e89438;border-radius:12px;color:#7a4510;font:700 .7rem Lato,sans-serif;padding:.25rem .6rem;min-height:32px;cursor:pointer}',
    '.pp-why{font-style:italic;color:#29525f}',
    '.pp-add{width:44px;height:44px;border-radius:50%;border:1.5px solid #0e2d3a;background:#0e2d3a;color:#f5f0e8;font-size:1.35rem;cursor:pointer}',
    '.pp-step{display:inline-flex;align-items:center;border:1.5px solid #0e2d3a;border-radius:22px;overflow:hidden}',
    '.pp-step button{width:44px;height:40px;background:none;border:0;font-size:1.2rem;color:#0e2d3a;cursor:pointer}',
    '.pp-step output{min-width:1.6rem;text-align:center;font:700 .9rem "Roboto Mono",monospace;color:#0e2d3a}',
    '.pp-log{display:block;margin:.2rem 1.25rem 1.1rem;min-height:44px;width:calc(100% - 2.5rem);border-radius:4px;border:1.5px solid #0e2d3a;background:#0e2d3a;color:#f5f0e8;font:700 .74rem Lato,sans-serif;letter-spacing:.1em;text-transform:uppercase;cursor:pointer}',
    '.pp-log-done{display:block;margin:-.6rem 1.25rem 1rem;font:italic .78rem Montserrat,sans-serif;color:#2a7f94;text-align:center}',
    ':where(.pp-bar,.pp-icons) :focus-visible{outline:2px solid #e89438;outline-offset:2px}'
  ].join('\n');

  function el(tag, attrs, kids) {
    var e = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') e.textContent = v;
      else if (k === 'on') Object.keys(v).forEach(function (ev) { e.addEventListener(ev, v[ev]); });
      else e.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c); });
    return e;
  }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function nameOf(id) { var o = s.oyster(id); return o ? o.name : id; }

  // ── The header icons ──────────────────────────────────────────────────────
  var icons = null;
  function setupIcons() {
    var link = doc.querySelector('.hero-login-link');
    if (!link || icons) return;
    var st = doc.createElement('style');
    st.textContent = CSS;
    doc.head.appendChild(st);
    link.setAttribute('href', 'passport.html');
    link.setAttribute('aria-label', 'My Passport');
    var flight = el('a', { class: 'hero-login-link pp-flight-link', href: 'passport.html#flight', hidden: true });
    flight.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 15c2-7 16-7 18 0-2 5-16 5-18 0z"/><path d="M8 14h8"/></svg>';
    var count = el('span', { class: 'pp-count', 'aria-hidden': 'true' });
    flight.appendChild(count);
    icons = el('div', { class: 'pp-icons' });
    link.parentNode.insertBefore(icons, link);
    icons.appendChild(flight);
    icons.appendChild(link);
    icons.flight = flight; icons.count = count;
    var header = link.closest ? icons.closest('header') : null;
    if (header && 'IntersectionObserver' in root) {
      new root.IntersectionObserver(function (entries) {
        icons.classList.toggle('docked', !entries[0].isIntersecting);
      }).observe(header);
    }
    updateIcons();
  }
  function updateIcons() {
    if (!icons) return;
    var o = s.openVisit(), n = o ? P.visitTotal(o.visit) : 0;
    icons.flight.hidden = !o;
    icons.count.textContent = String(n);
    icons.flight.setAttribute('aria-label', 'My Flight, ' + plural(n, 'oyster'));
  }

  // ── Oyster cards (tonight's menu) ─────────────────────────────────────────
  function lastVisitWith(id) {
    var visits = s.state.visits || {};
    var ids = Object.keys(visits).filter(function (k) { return visits[k].items && visits[k].items[id]; });
    ids.sort(function (a, b) { return visits[b].date.localeCompare(visits[a].date) || (visits[b].startedAt || 0) - (visits[a].startedAt || 0); });
    return ids[0] || null;
  }
  function add(id, delta) {
    var r = P.addUpdates(s.state, id, delta, s.now(), s.newId());
    s.apply(r.updates);
    if (delta > 0) S.track('oyster_logged', { oyster: id, qty: delta, where: 'menu' });
  }
  function decorateCards() {
    var grid = view.grid;
    if (!grid) return;
    var visits = s.state.visits || {};
    var agg = P.aggregateRatings(visits);
    var recs = P.recommendations(agg, visits, view.served, s.oysters, s.regions) || [];
    var o = s.openVisit();
    Array.prototype.forEach.call(grid.querySelectorAll('.oyster-card[data-id]'), function (card) {
      var id = card.getAttribute('data-id'), name = nameOf(id);
      var old = card.querySelector('.pp-bar');
      if (old) old.parentNode.removeChild(old);
      var info = el('div', { class: 'pp-info' });
      if (agg[id]) {
        info.appendChild(el('span', { class: 'pp-mine' }, ['Your rating ', el('b', { text: '★ ' + P.formatRating(agg[id].rating) })]));
      } else {
        var where = lastVisitWith(id);
        if (where) {
          var href = o && o.id === where ? 'passport.html#flight' : 'passport.html#visit/' + where;
          info.appendChild(el('span', {}, ['Tried · ', el('a', { href: href, text: 'Rate it' })]));
        }
      }
      var rec = recs.filter(function (r) { return r.id === id; })[0];
      if (rec) {
        info.appendChild(el('button', { type: 'button', class: 'pp-like', 'aria-expanded': why[id] ? 'true' : 'false',
          text: 'You might like', on: { click: function () { why[id] = !why[id]; decorate(); } } }));
        if (why[id]) info.appendChild(el('span', { class: 'pp-why', text: 'Because you liked ' + nameOf(rec.because) + '.' }));
      }
      var it = o && o.visit.items && o.visit.items[id];
      var control = it
        ? el('span', { class: 'pp-step' }, [
            el('button', { type: 'button', 'aria-label': 'One fewer ' + name, text: '−', on: { click: function () { add(id, -1); } } }),
            el('output', { 'aria-label': name + ' in My Flight', text: String(it.qty) }),
            el('button', { type: 'button', 'aria-label': 'One more ' + name, text: '+', disabled: it.qty >= P.MAX_QTY, on: { click: function () { add(id, 1); } } })
          ])
        : el('button', { type: 'button', class: 'pp-add', 'aria-label': 'Add ' + name + ' to My Flight', text: '+', on: { click: function () { add(id, 1); } } });
      card.appendChild(el('div', { class: 'pp-bar' }, [info, control]));
    });
  }

  // ── Curated Flights ───────────────────────────────────────────────────────
  var logged = {};
  function decorateFlights() {
    var grid = view.grid;
    if (!grid) return;
    Array.prototype.forEach.call(grid.querySelectorAll('.flight-card[data-oysters]'), function (card) {
      var name = card.getAttribute('data-flight') || '';
      var slug = P.flightSlug(name);
      var ids = card.getAttribute('data-oysters').split(' ').filter(Boolean);
      var old = card.querySelectorAll('.pp-log, .pp-log-done');
      Array.prototype.forEach.call(old, function (e) { e.parentNode.removeChild(e); });
      card.appendChild(el('button', { type: 'button', class: 'pp-log', text: 'Log this flight', on: { click: function () {
        var r = P.logFlightUpdates(s.state, slug, ids, s.now(), s.newId());
        s.apply(r.updates);
        S.track('flight_logged', { flight: slug });
        ids.forEach(function (id) { S.track('oyster_logged', { oyster: id, qty: 1, where: 'flight' }); });
        logged[slug] = true;
        decorate();
        setTimeout(function () { delete logged[slug]; decorate(); }, 4000);
      } } }));
      if (logged[slug]) card.appendChild(el('span', { class: 'pp-log-done', role: 'status', text: 'Added to My Flight' }));
    });
  }

  function decorate() {
    if (!s) return;
    updateIcons();
    if (view.kind === 'cards') decorateCards();
    if (view.kind === 'flights') decorateFlights();
  }

  // ── "Here today" (menu only) ──────────────────────────────────────────────
  function hereToday() {
    var day = s.today();
    if (!(s.state.hereOn && s.state.hereOn[day])) {
      var u = {};
      u['hereOn/' + day] = s.now();
      s.apply(u, { noStamps: true });
    }
  }

  /** kind: 'cards' (tonight's menu) or 'flights' (Curated Flights). */
  function start(kind) {
    S.session({ served: false }).then(function (session) {
      if (!session) return;                       // no passport: the page stays as it is
      s = session;
      s.served = view.served;
      setupIcons();
      if (kind === 'cards') hereToday();
      s.on(function (what) {
        if (what === 'change') { decorate(); root.HS_UI.celebrate(s); }
        if (what === 'status') updateIcons();
      });
      decorate();
      root.HS_UI.celebrate(s);
    }, function () { /* passport unreachable: the menu works as for everyone */ });
  }

  root.HS_PASSPORT_MENU = {
    cards: function (grid, served) { view = { kind: 'cards', grid: grid, served: served || [] }; if (s) { s.served = view.served; decorate(); } },
    flights: function (grid, served) { view = { kind: 'flights', grid: grid, served: served || [] }; if (s) { s.served = view.served; decorate(); } },
    start: start
  };
})(window);
