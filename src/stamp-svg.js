/*
 * Oyster Passport stamp art (Build Sheet section 6.5). Global HS_STAMP_SVG.
 *   HS_STAMP_SVG.render(def, tier, opts) -> SVG string
 * def: a stamp from HS_PASSPORT.stampDefs(); tier: 'single' | 'bronze' |
 * 'silver' | 'gold' | 'pearl', or null for not yet earned (faint, dashed).
 * Circle for regions, rounded square for ladders, hexagon for singles.
 * Double ring, the name along the top, the region code or a small mark in
 * the middle, the tier along the bottom. Tilted -6° to 6°, fixed per stamp.
 * Basic art (step 4); the fuller art (rays, sheen, rough edges) is step 6.
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

  /**
   * opts.size (px, default 96), opts.label (accessible name; default the
   * stamp name and tier).
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
    if (tier === 'pearl' && Array.isArray(colors.pearl)) {
      defs = '<defs><linearGradient id="hsp' + n + '" x1="0" y1="0" x2="1" y2="1">' +
        colors.pearl.map(function (c, i, a) { return '<stop offset="' + (i / (a.length - 1)) + '" stop-color="' + c + '"/>'; }).join('') +
        '</linearGradient></defs>';
      fill = 'url(#hsp' + n + ')';
    }
    var label = opts.label || (def.name + (earned ? (tier === 'single' ? ', earned' : ', ' + (names[tier] || tier)) : ', not earned yet'));
    var dash = earned ? '' : ' stroke-dasharray="4 4"';
    var r1 = 44, r2 = 37, rText = 30;
    var center;
    if (def.kind === 'region') {
      center = '<text x="0" y="7" text-anchor="middle" font-family="\'Playfair Display\', Georgia, serif" font-weight="700" font-size="' +
        (String(def.code).length > 2 ? 17 : 22) + '" fill="' + color + '">' + esc(def.code) + '</text>';
    } else {
      var d = MARKS[def.id] || MARKS.volume;
      center = '<g transform="translate(-12 -14)" fill="none" stroke="' + color + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + d + '"/></g>';
    }
    var bottom = earned ? (tier === 'single' ? '' : String(names[tier] || tier).toUpperCase()) : '';
    var arcTop = 'M ' + -rText + ' 0 A ' + rText + ' ' + rText + ' 0 0 1 ' + rText + ' 0';
    var arcBottom = 'M ' + -rText + ' 0 A ' + rText + ' ' + rText + ' 0 0 0 ' + rText + ' 0';
    return '<svg xmlns="http://www.w3.org/2000/svg" class="hs-stamp' + (earned ? '' : ' hs-stamp-blank') + '" width="' + size + '" height="' + size +
      '" viewBox="-50 -50 100 100" role="img" aria-label="' + esc(label) + '">' + defs +
      '<g transform="rotate(' + tilt(def.id).toFixed(1) + ')">' +
      '<g fill="' + fill + '" stroke="' + color + '" stroke-width="2.4"' + dash + '>' + shape(def.kind, r1) + '</g>' +
      '<g fill="none" stroke="' + color + '" stroke-width="1"' + dash + '>' + shape(def.kind, r2) + '</g>' +
      '<path id="hst' + n + '" d="' + arcTop + '" fill="none"/>' +
      '<path id="hsb' + n + '" d="' + arcBottom + '" fill="none"/>' +
      '<text font-family="Lato, sans-serif" font-weight="700" font-size="' + (def.name.length > 14 ? 6.2 : 7.4) + '" letter-spacing="0.6" fill="' + color + '">' +
      '<textPath href="#hst' + n + '" startOffset="50%" text-anchor="middle">' + esc(def.name.toUpperCase()) + '</textPath></text>' +
      (bottom ? '<text font-family="Lato, sans-serif" font-weight="700" font-size="6.4" letter-spacing="1" fill="' + color + '" dy="5">' +
        '<textPath href="#hsb' + n + '" startOffset="50%" text-anchor="middle">' + esc(bottom) + '</textPath></text>' : '') +
      center + '</g></svg>';
  }

  root.HS_STAMP_SVG = { render: render, tilt: tilt };
})(window);
