/*
 * Oyster Passport stamp art (Build Sheet section 6.5). Global HS_STAMP_SVG.
 *   HS_STAMP_SVG.render(def, tier, opts) -> SVG string
 * def: a stamp from HS_PASSPORT.stampDefs(); tier: 'single' | 'bronze' |
 * 'silver' | 'gold' | 'pearl', or null for not yet earned (faint, dashed).
 * Circle for regions, rounded square for ladders, hexagon for singles.
 * Double ring, the name along the top, the region code or a small mark in
 * the middle, the tier along the bottom. Tilted -6° to 6°, fixed per stamp.
 * Earned stamps get an inked, slightly rough edge; Silver adds a dotted
 * inner ring, Gold rays, Pearl a gradient and a sheen.
 * Needs data/stamps.js (colors).
 */
(function (root) {
  'use strict';

  var INK_SINGLE = '#2a7f94';
  var MUTED = '#9ec4bc';
  var uid = 0;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function hash(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h;
  }
  /** -6 to 6 degrees, the same every time for a stamp. */
  function tilt(id) { return (hash(String(id)) % 1300) / 100 - 6.5 + 0.5; }

  // Small line marks for ladders and singles (24×24 boxes, drawn at the center).
  var MARKS = {
    volume: 'M4 15c2-6 14-6 16 0-2 4-14 4-16 0z M8 14h8',                       // an oyster
    variety: 'M5 8h6v6H5z M13 8h6v6h-6z M9 14h6v6H9z',                           // three squares
    atlas: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M3 12h18 M12 3c-4 5-4 13 0 18 M12 3c4 5 4 13 0 18',
    regular: 'M5 5h14v15H5z M5 9h14 M9 3v4 M15 3v4',                             // a calendar
    critic: 'M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6-5.3-3-5.3 3 1.2-6L3.4 9.3l6-.7z',   // a star
    'salt-lover': 'M12 3c3 5 6 8 6 11a6 6 0 0 1-12 0c0-3 3-6 6-11z',            // a drop
    'sweet-tooth': 'M7 10a5 5 0 0 1 10 0c0 5-5 9-5 9s-5-4-5-9z',
    'first-slurp': 'M4 15c2-6 14-6 16 0-2 4-14 4-16 0z M12 6v4',
    'coast-to-coast': 'M3 12h18 M7 8l-4 4 4 4 M17 8l4 4-4 4',
    'home-waters': 'M4 12l8-7 8 7 M6 11v8h12v-8',
    'passport-stamp': 'M12 3l2 5h5l-4 3 2 5-5-3-5 3 2-5-4-3h5z',
    'flight-crew': 'M3 16h18 M6 16a2 2 0 1 1 0-.1 M12 16a2 2 0 1 1 0-.1 M18 16a2 2 0 1 1 0-.1 M5 10h14',
    'birthday-shuck': 'M5 12h14v8H5z M5 15h14 M12 12V6 M12 6c-1-1 0-3 0-3s1 2 0 3'
  };

  function shape(kind, r) {
    if (kind === 'region') return '<circle cx="0" cy="0" r="' + r + '"/>';
    if (kind === 'ladder') return '<rect x="' + -r + '" y="' + -r + '" width="' + 2 * r + '" height="' + 2 * r + '" rx="' + r * 0.22 + '"/>';
    var pts = [];
    for (var i = 0; i < 6; i++) {
      var a = Math.PI / 6 + i * Math.PI / 3;
      pts.push((r * Math.cos(a)).toFixed(2) + ',' + (r * Math.sin(a)).toFixed(2));
    }
    return '<polygon points="' + pts.join(' ') + '"/>';
  }

  /** Short rays between the rings (Gold and Pearl), following the shape. */
  function rays(kind, r1, r2, color) {
    var out = '', n = kind === 'single' ? 18 : 24;
    for (var i = 0; i < n; i++) {
      var a = (i / n) * 2 * Math.PI;
      var c = Math.cos(a), si = Math.sin(a);
      var k = kind === 'ladder' ? 1 / Math.max(Math.abs(c), Math.abs(si)) : 1;     // squares: rays reach the sides
      var a1 = (r2 + 1.5) * k, a2 = (r1 - 1.5) * k;
      out += '<line x1="' + (c * a1).toFixed(2) + '" y1="' + (si * a1).toFixed(2) + '" x2="' + (c * a2).toFixed(2) + '" y2="' + (si * a2).toFixed(2) + '"/>';
    }
    return '<g stroke="' + color + '" stroke-width="0.9" opacity="0.7">' + out + '</g>';
  }

  /**
   * opts.size (px, default 96), opts.label (accessible name; default the
   * stamp name and tier), opts.plain (no rough edge, e.g. for small lists).
   */
  function render(def, tier, opts) {
    opts = opts || {};
    var S = root.HS_STAMPS || {};
    var colors = S.TIER_COLORS || {};
    var names = S.TIER_NAMES || {};
    var size = opts.size || 96;
    var n = ++uid;
    var earned = !!tier;
    var color = !earned ? MUTED : tier === 'single' ? INK_SINGLE : tier === 'pearl' ? '#5b5f6e' : colors[tier] || INK_SINGLE;
    var fill = 'none', defs = '';
    if (earned && !opts.plain) {
      // A little ink spread: the edges wobble, fixed per stamp.
      defs += '<filter id="hsr' + n + '" x="-10%" y="-10%" width="120%" height="120%">' +
        '<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="' + (hash(def.id) % 97) + '" result="t"/>' +
        '<feDisplacementMap in="SourceGraphic" in2="t" scale="1.6" xChannelSelector="R" yChannelSelector="G"/></filter>';
    }
    if (tier === 'pearl' && Array.isArray(colors.pearl)) {
      defs += '<linearGradient id="hsp' + n + '" x1="0" y1="0" x2="1" y2="1">' +
        colors.pearl.map(function (c, i, a) { return '<stop offset="' + (i / (a.length - 1)) + '" stop-color="' + c + '"/>'; }).join('') +
        '</linearGradient>' +
        '<radialGradient id="hss' + n + '" cx="0.35" cy="0.3" r="0.5"><stop offset="0" stop-color="#fff" stop-opacity="0.85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>';
      fill = 'url(#hsp' + n + ')';
    }
    var label = opts.label || (def.name + (earned ? (tier === 'single' ? ', earned' : ', ' + (names[tier] || tier)) : ', not earned yet'));
    var dash = earned ? '' : ' stroke-dasharray="4 4"';
    var r1 = 44, r2 = 37;
    // The name runs inside the inner ring; hexagons are narrower at the top.
    var rText = def.kind === 'single' ? 24 : 29;
    var fs = def.kind === 'single' ? (def.name.length > 12 ? 5.4 : 6.2) : (def.name.length > 14 ? 6.2 : 7.4);
    var center;
    if (def.kind === 'region') {
      center = '<text x="0" y="7" text-anchor="middle" font-family="\'Playfair Display\', Georgia, serif" font-weight="700" font-size="' +
        (String(def.code).length > 2 ? 17 : 22) + '" fill="' + color + '">' + esc(def.code) + '</text>';
    } else {
      var d = MARKS[def.id] || MARKS.volume;
      center = '<g transform="translate(-12 -12)" fill="none" stroke="' + color + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + d + '"/></g>';
    }
    var bottom = earned ? (tier === 'single' ? '' : String(names[tier] || tier).toUpperCase()) : '';
    var arcTop = 'M ' + -rText + ' 0 A ' + rText + ' ' + rText + ' 0 0 1 ' + rText + ' 0';
    var arcBottom = 'M ' + -rText + ' 0 A ' + rText + ' ' + rText + ' 0 0 0 ' + rText + ' 0';
    var inner = '<g fill="none" stroke="' + color + '" stroke-width="' + (tier === 'silver' ? 1.6 : 1) + '"' +
      (tier === 'silver' ? ' stroke-dasharray="0.1 3.2" stroke-linecap="round"' : dash) + '>' + shape(def.kind, r2) + '</g>';
    var body =
      '<g fill="' + fill + '" stroke="' + color + '" stroke-width="2.4"' + dash + '>' + shape(def.kind, r1) + '</g>' +
      (tier === 'pearl' ? '<g fill="url(#hss' + n + ')" stroke="none">' + shape(def.kind, r1 - 1) + '</g>' : '') +
      ((tier === 'gold' || tier === 'pearl') ? rays(def.kind, r1, r2, color) : '') +
      inner +
      '<path id="hst' + n + '" d="' + arcTop + '" fill="none"/>' +
      '<path id="hsb' + n + '" d="' + arcBottom + '" fill="none"/>' +
      '<text font-family="Lato, sans-serif" font-weight="700" font-size="' + fs + '" letter-spacing="0.5" fill="' + color + '">' +
      '<textPath href="#hst' + n + '" startOffset="50%" text-anchor="middle">' + esc(def.name.toUpperCase()) + '</textPath></text>' +
      (bottom ? '<text font-family="Lato, sans-serif" font-weight="700" font-size="6.2" letter-spacing="1" fill="' + color + '" dy="4.5">' +
        '<textPath href="#hsb' + n + '" startOffset="50%" text-anchor="middle">' + esc(bottom) + '</textPath></text>' : '') +
      center;
    return '<svg xmlns="http://www.w3.org/2000/svg" class="hs-stamp' + (earned ? '' : ' hs-stamp-blank') + '" width="' + size + '" height="' + size +
      '" viewBox="-50 -50 100 100" role="img" aria-label="' + esc(label) + '">' + (defs ? '<defs>' + defs + '</defs>' : '') +
      '<g transform="rotate(' + tilt(def.id).toFixed(1) + ')"' + (earned && !opts.plain ? ' filter="url(#hsr' + n + ')"' : '') + '>' + body + '</g></svg>';
  }

  root.HS_STAMP_SVG = { render: render, tilt: tilt };
})(window);
