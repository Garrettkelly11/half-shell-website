/*
 * Oyster Passport: the stamp celebration, shared by every page a guest logs
 * from (Build Sheet 6.5). Global HS_UI.
 *   HS_UI.celebrate(session)  shows every unseen stamp in one window. Safe
 *                             to call often: one window at a time.
 *
 * Owners' change (03/11/2026): the stamps come all at once when the guest
 * saves the flight, not one by one as they are earned. So:
 *   - nothing shows while a flight is open; the stamps wait (seen: false)
 *     and show after Save Entry, or when the flight closes on its own;
 *   - one window holds them all: each new stamp pops in after the last, and
 *     the guest can swipe sideways (or use the dots) to look back;
 *   - "Nice" marks them all seen in one update.
 * Needs src/stamp-svg.js and a session from HS_STORE.session().
 */
(function (root) {
  'use strict';
  var doc = root.document;
  var STEP_MS = 750;                   // time between one stamp popping in and the next
  var CSS = [
    '.hs-modal-back{position:fixed;inset:0;background:rgba(14,45,58,.72);display:flex;align-items:center;justify-content:center;z-index:1000;padding:1rem}',
    '.hs-modal{background:#f5f0e8;border-radius:8px;max-width:360px;width:100%;padding:1.5rem 0 1.25rem;text-align:center;box-shadow:0 18px 50px rgba(0,0,0,.45);color:#0e2d3a}',
    '.hs-modal .hs-eyebrow{font-family:Lato,sans-serif;font-size:.66rem;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#b5651d;margin:0 1.5rem .5rem}',
    '.hs-track{display:flex;overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain;scrollbar-width:none;touch-action:pan-x}',
    '.hs-track::-webkit-scrollbar{display:none}',
    '.hs-slide{flex:0 0 100%;scroll-snap-align:center;scroll-snap-stop:always;padding:.5rem 1.5rem 0;box-sizing:border-box}',
    '.hs-modal h2{font-family:"Playfair Display",Georgia,serif;font-weight:400;font-size:1.4rem;margin:.6rem 0 .25rem}',
    '.hs-modal p{font-family:Lato,sans-serif;font-size:.9rem;color:#2c4a55;margin:0 0 .5rem}',
    '.hs-modal .hs-swipe{font-family:Montserrat,sans-serif;font-style:italic;font-size:.74rem;color:#5f8794;min-height:1.1em;margin:.1rem 1.5rem 0}',
    '.hs-dots{display:flex;justify-content:center;flex-wrap:wrap;gap:0;margin:.35rem 1rem .5rem;min-height:32px}',
    '.hs-dots button{width:28px;height:32px;min-height:0;padding:0;margin:0;background:none;border:0;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}',
    '.hs-dots button i{display:block;width:8px;height:8px;border-radius:50%;border:1.5px solid #0e2d3a;box-sizing:border-box}',
    '.hs-dots button[aria-current="true"] i{background:#e89438;border-color:#e89438}',
    '.hs-dots button:focus-visible{outline:2px solid #e89438;outline-offset:-2px;border-radius:4px}',
    '.hs-modal .hs-nice{display:block;min-height:44px;width:calc(100% - 3rem);margin:.75rem 1.5rem 0;background:#0e2d3a;color:#f5f0e8;border:0;border-radius:4px;font-family:Lato,sans-serif;font-weight:700;font-size:.8rem;letter-spacing:.1em;text-transform:uppercase;cursor:pointer}',
    '.hs-modal .hs-nice:focus-visible{outline:2px solid #e89438;outline-offset:2px}',
    '.hs-modal .hs-stamp-wrap{display:inline-block;mix-blend-mode:multiply;animation:hs-press .42s cubic-bezier(.2,.9,.3,1.2) both}',
    '@keyframes hs-press{0%{transform:scale(1.7) rotate(-14deg);opacity:0}60%{opacity:1}100%{transform:scale(1) rotate(0);opacity:1}}',
    '@media (prefers-reduced-motion:reduce){.hs-modal .hs-stamp-wrap{animation:hs-fade .3s ease both}}',
    '@keyframes hs-fade{from{opacity:0}to{opacity:1}}'
  ].join('\n');
  var styled = false, open = false;

  function style() {
    if (styled) return;
    var s = doc.createElement('style');
    s.textContent = CSS;
    doc.head.appendChild(s);
    styled = true;
  }
  function make(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function reducedMotion() {
    try { return root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }

  /**
   * Shows every unseen stamp in one window. Waits while a flight is open
   * (opts.force skips the wait).
   */
  function celebrate(session, opts) {
    if (open || !session) return;
    if (!(opts && opts.force) && session.openVisit && session.openVisit()) return;
    var names = (root.HS_STAMPS && root.HS_STAMPS.TIER_NAMES) || {};
    var stamps = session.state.stamps || {};
    var ids = session.unseen(), shown = [], broken = [];
    ids.forEach(function (id) {
      if (stamps[id] && session.evaluated && session.evaluated[id]) shown.push(id); else broken.push(id);
    });
    if (broken.length) session.markSeen(broken);     // a stamp that no longer exists: nothing to show
    if (!shown.length) return;
    style();
    open = true;
    var calm = reducedMotion();
    var before = doc.activeElement;
    var back = make('div', 'hs-modal-back');
    var box = make('div', 'hs-modal');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'hs-modal-title');
    var title = make('div', 'hs-eyebrow', shown.length === 1 ? 'New stamp' : shown.length + ' new stamps');
    title.id = 'hs-modal-title';
    var track = make('div', 'hs-track');
    track.setAttribute('aria-live', 'polite');
    var swipe = make('div', 'hs-swipe');
    var dots = make('div', 'hs-dots');
    dots.setAttribute('role', 'group');
    dots.setAttribute('aria-label', 'Your new stamps');
    var nice = make('button', 'hs-nice', 'Nice');
    nice.type = 'button';
    box.appendChild(title); box.appendChild(track);
    if (shown.length > 1) { box.appendChild(swipe); box.appendChild(dots); }
    box.appendChild(nice);
    back.appendChild(box);
    doc.body.appendChild(back);

    var added = 0, timer = null, userMoved = false, current = 0;
    function slideFor(id, i) {
      var stored = stamps[id], ev = session.evaluated[id], def = ev.def, tier = stored.tier;
      var tierName = tier === 'single' ? '' : names[tier] || tier;
      var slide = make('div', 'hs-slide');
      slide.setAttribute('role', 'group');
      slide.setAttribute('aria-roledescription', 'stamp');
      slide.setAttribute('aria-label', (i + 1) + ' of ' + shown.length);
      var wrap = make('div', 'hs-stamp-wrap');
      wrap.innerHTML = root.HS_STAMP_SVG.render(def, tier, { size: 150 });
      var h = make('h2', '', def.name + (tierName ? ' · ' + tierName : ''));
      var p = make('p', '', session.P.stampLine(def, ev.value));
      slide.appendChild(wrap); slide.appendChild(h); slide.appendChild(p);
      return slide;
    }
    function goTo(i, smooth) {
      var w = track.clientWidth || 1;
      try { track.scrollTo({ left: i * w, behavior: smooth && !calm ? 'smooth' : 'auto' }); } catch (e) { track.scrollLeft = i * w; }
    }
    function markDots() {
      Array.prototype.forEach.call(dots.children, function (b, i) {
        b.setAttribute('aria-current', i === current ? 'true' : 'false');
      });
    }
    function addNext() {
      var i = added++;
      track.appendChild(slideFor(shown[i], i));
      if (shown.length > 1) {
        var d = make('button');
        d.type = 'button';
        d.setAttribute('aria-label', 'Stamp ' + (i + 1) + ' of ' + shown.length);
        d.appendChild(make('i'));
        d.addEventListener('click', function () { userMoved = true; goTo(i, true); });
        dots.appendChild(d);
      }
      if (!userMoved) { current = i; goTo(i, true); }
      markDots();
      if (added < shown.length) timer = setTimeout(addNext, calm ? 250 : STEP_MS);
      else if (shown.length > 1) swipe.textContent = 'Swipe to see them all';
    }
    track.addEventListener('scroll', function () {
      var w = track.clientWidth || 1, i = Math.round(track.scrollLeft / w);
      if (i !== current && i >= 0 && i < added) { current = i; markDots(); }
    });
    ['pointerdown', 'touchstart', 'wheel'].forEach(function (ev) {
      track.addEventListener(ev, function () { userMoved = true; }, { passive: true });
    });

    function close() {
      clearTimeout(timer);
      doc.removeEventListener('keydown', keys, true);
      if (back.parentNode) back.parentNode.removeChild(back);
      session.markSeen(shown);                       // all of them, shown yet or not
      open = false;
      if (before && before.focus && doc.contains(before)) before.focus();
      // Anything earned while the window was open.
      if (session.unseen().length) celebrate(session, opts);
    }
    nice.addEventListener('click', close);
    // Focus stays inside; Escape counts as "Nice"; arrows move between stamps.
    function keys(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        userMoved = true;
        var i = Math.max(0, Math.min(added - 1, current + (e.key === 'ArrowRight' ? 1 : -1)));
        goTo(i, true);
        return;
      }
      if (e.key === 'Tab') {
        var f = Array.prototype.slice.call(box.querySelectorAll('button'));
        var k = f.indexOf(doc.activeElement);
        e.preventDefault();
        f[(k + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      }
    }
    doc.addEventListener('keydown', keys, true);
    addNext();
    nice.focus();
  }

  root.HS_UI = { celebrate: celebrate };
})(window);
