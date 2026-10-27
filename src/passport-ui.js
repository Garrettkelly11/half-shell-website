/*
 * Oyster Passport: the stamp celebration, shared by every page a guest logs
 * from (Build Sheet 6.5). Global HS_UI.
 *   HS_UI.celebrate(session)  shows unseen stamps one at a time; "Nice" marks
 *                             each seen. Safe to call often: one queue at a time.
 * Needs src/stamp-svg.js and a session from HS_STORE.session().
 */
(function (root) {
  'use strict';
  var doc = root.document;
  var CSS = [
    '.hs-modal-back{position:fixed;inset:0;background:rgba(14,45,58,.72);display:flex;align-items:center;justify-content:center;z-index:1000;padding:1rem}',
    '.hs-modal{background:#f5f0e8;border-radius:8px;max-width:340px;width:100%;padding:1.75rem 1.5rem 1.5rem;text-align:center;box-shadow:0 18px 50px rgba(0,0,0,.45);color:#0e2d3a}',
    '.hs-modal .hs-eyebrow{font-family:Lato,sans-serif;font-size:.62rem;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#b5651d;margin-bottom:.75rem}',
    '.hs-modal h2{font-family:"Playfair Display",Georgia,serif;font-weight:400;font-size:1.45rem;margin:.75rem 0 .25rem}',
    '.hs-modal p{font-family:Lato,sans-serif;font-size:.9rem;color:#2c4a55;margin-bottom:1.25rem}',
    '.hs-modal button{min-height:44px;width:100%;background:#0e2d3a;color:#f5f0e8;border:0;border-radius:4px;font-family:Lato,sans-serif;font-weight:700;font-size:.8rem;letter-spacing:.1em;text-transform:uppercase;cursor:pointer}',
    '.hs-modal button:focus-visible{outline:2px solid #e89438;outline-offset:2px}',
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

  function celebrate(session) {
    if (open || !session) return;
    var queue = session.unseen();
    if (!queue.length) return;
    style();
    open = true;
    var before = doc.activeElement;
    var back = doc.createElement('div');
    back.className = 'hs-modal-back';
    var box = doc.createElement('div');
    box.className = 'hs-modal';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'hs-modal-title');
    back.appendChild(box);
    doc.body.appendChild(back);

    function show() {
      var id = queue.shift();
      var stored = (session.state.stamps || {})[id];
      var ev = session.evaluated && session.evaluated[id];
      if (!stored || !ev) { session.markSeen(id); return next(); }
      var def = ev.def, tier = stored.tier;
      var names = (root.HS_STAMPS && root.HS_STAMPS.TIER_NAMES) || {};
      var tierName = tier === 'single' ? '' : names[tier] || tier;
      box.innerHTML = '';
      var eyebrow = doc.createElement('div');
      eyebrow.className = 'hs-eyebrow';
      eyebrow.textContent = tier === 'single' ? 'New stamp' : 'New stamp · ' + tierName;
      var wrap = doc.createElement('div');
      wrap.className = 'hs-stamp-wrap';
      wrap.innerHTML = root.HS_STAMP_SVG.render(def, tier, { size: 150 });
      var h = doc.createElement('h2');
      h.id = 'hs-modal-title';
      h.textContent = def.name + (tierName ? ' · ' + tierName : '');
      var p = doc.createElement('p');
      p.textContent = session.P.stampLine(def, ev.value);
      var b = doc.createElement('button');
      b.type = 'button';
      b.textContent = 'Nice';
      b.addEventListener('click', function () { session.markSeen(id); next(); });
      box.appendChild(eyebrow); box.appendChild(wrap); box.appendChild(h); box.appendChild(p); box.appendChild(b);
      b.focus();
    }
    function next() {
      if (queue.length) return show();
      doc.removeEventListener('keydown', trap, true);
      back.parentNode.removeChild(back);
      open = false;
      if (before && before.focus && doc.contains(before)) before.focus();
      // Anything earned while the modal was open.
      if (session.unseen().length) celebrate(session);
    }
    // Focus stays on the one button; Escape counts as "Nice".
    function trap(e) {
      if (e.key === 'Tab') { e.preventDefault(); var b = box.querySelector('button'); if (b) b.focus(); }
      if (e.key === 'Escape') { e.preventDefault(); var b2 = box.querySelector('button'); if (b2) b2.click(); }
    }
    doc.addEventListener('keydown', trap, true);
    show();
  }

  root.HS_UI = { celebrate: celebrate };
})(window);
