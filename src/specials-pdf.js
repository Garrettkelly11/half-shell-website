/**
 * Tonight's food specials as a PDF: one US Letter page (portrait) holding two
 * identical menus, each 4.25" x 11", to cut or fold down the long center line.
 * Layout after Olivero's menu (run-in items: bold NAME, ingredients, bare
 * price), in Half Shell's typefaces (Playfair Display, Lato) and colours,
 * with everything centred on each half.
 *
 * Vector text with embedded fonts, built by pdf-lib (src/vendor/, loaded only
 * when a manager exports). The layout (build) runs in Node too, for tests:
 *   build(PDFLib, fontkit, fonts, night) -> Promise<Uint8Array>
 *   fonts: { serif, serifItalic, sans, sansBold } font file bytes
 *   night: { date: 'YYYY-MM-DD', items: [{ name, ingredients, description, allergens, price }] }
 * In the page, HS_SPECIALS_PDF.download(night) loads everything and saves
 * the file.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HS_SPECIALS_PDF = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var IN = 72;
  var PAGE = { w: 8.5 * IN, h: 11 * IN };
  var PANEL = { w: PAGE.w / 2, side: 0.42 * IN, top: 0.62 * IN, bottom: 0.5 * IN };
  var NAVY = [0x0e, 0x2d, 0x3a], ORANGE = [0xe8, 0x94, 0x38], TEAL = [0x14, 0x6c, 0x7b];

  var ADVISORY = 'CONSUMER ADVISORY — Eating raw, or undercooked oysters, clams or mussels may cause severe illness. ' +
    'People with the following conditions are at especially high risk: liver disease, alcoholism, diabetes, cancer, ' +
    'stomach or blood disorder, or weakened immune system. Ask your doctor if you are unsure of your risk. ' +
    'If you eat raw, or undercooked shellfish and become sick, see a doctor immediately.';

  function menuPrice(cents) {
    if (typeof cents !== 'number' || !isFinite(cents) || Math.floor(cents) !== cents) return '';
    var d = Math.floor(cents / 100), c = cents % 100;
    if (!c) return String(d);
    return d + '.' + (c % 10 ? (c < 10 ? '0' : '') + c : String(c / 10));
  }
  function niceDate(iso) {
    var p = String(iso || '').split('-').map(Number);
    if (p.length !== 3 || !p[0]) return '';
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2], 12));
    var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return days[d.getUTCDay()] + ', ' + months[d.getUTCMonth()] + ' ' + d.getUTCDate();
  }
  // Characters the embedded fonts may lack; straighten the usual suspects.
  function clean(s) {
    return String(s || '').replace(/[‘’]/g, '\'').replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
  }

  /**
   * Word-wraps runs of mixed fonts into centred lines.
   * runs: [{ text, font, size, track, color }]. Returns [{ width, height, pieces: [{ text, font, size, track, color, x }] }].
   */
  function wrap(runs, maxW) {
    var words = [];
    runs.forEach(function (r) {
      // Keep "  14" glued to the word before it; split elsewhere on spaces.
      String(r.text).split(/( +)/).forEach(function (w) {
        if (w === '') return;
        words.push({ text: w, run: r, space: /^ +$/.test(w) });
      });
    });
    var lines = [], cur = [], curW = 0;
    function width(t, r) { return r.font.widthOfTextAtSize(t, r.size) + r.track * t.length; }
    function push() {
      while (cur.length && cur[cur.length - 1].space) { curW -= cur[cur.length - 1].w; cur.pop(); }
      if (cur.length) lines.push({ width: curW, items: cur });
      cur = []; curW = 0;
    }
    words.forEach(function (w, i) {
      w.w = width(w.text, w.run);
      if (w.space) { if (cur.length) { cur.push(w); curW += w.w; } return; }
      var glue = w.run.glue && cur.length; // a price stays with the word before it
      if (curW + w.w > maxW && cur.length && !glue) push();
      cur.push(w); curW += w.w;
    });
    push();
    return lines.map(function (l) {
      var h = 0, x = 0, pieces = [];
      l.items.forEach(function (w) {
        h = Math.max(h, w.run.size);
        var last = pieces[pieces.length - 1];
        if (last && last.run === w.run) last.text += w.text;
        else pieces.push({ text: w.text, run: w.run, x: x });
        x += w.w;
      });
      return { width: l.width, height: h, pieces: pieces };
    });
  }

  // Centred text reads best with even lines: the narrowest width that keeps
  // the same number of lines (so no lone word on the last line).
  function balanced(runs, maxW) {
    var best = wrap(runs, maxW), n = best.length;
    if (n < 2) return best;
    var lo = maxW * 0.45, hi = maxW;
    for (var k = 0; k < 14; k++) {
      var mid = (lo + hi) / 2, t = wrap(runs, mid);
      if (t.length === n && t.every(function (l) { return l.width <= mid + 0.01; })) { hi = mid; best = t; } else lo = mid;
    }
    return best;
  }

  function itemBlocks(items, f, s) {
    // s: item name size; everything else scales with it.
    return items.map(function (it) {
      var name = { text: clean(it.name).toUpperCase(), font: f.sansBold, size: s, track: s * 0.06, color: NAVY };
      var runs = [name];
      var ing = clean(it.ingredients);
      if (ing) runs.push({ text: ', ' + ing.toUpperCase(), font: f.sans, size: s, track: s * 0.04, color: NAVY });
      var price = menuPrice(it.price);
      if (price) runs.push({ text: '\u00a0\u00a0' + price, font: f.sans, size: s, track: s * 0.04, color: NAVY, glue: true });
      var parts = [{ lines: balanced(runs, PANEL.w - 2 * PANEL.side), lead: s * 1.42 }];
      var desc = clean(it.description);
      if (desc) parts.push({ lines: balanced([{ text: desc, font: f.serifItalic, size: s * 1.02, track: 0, color: NAVY }], PANEL.w - 2 * PANEL.side - 0.2 * IN), lead: s * 1.38, gapBefore: s * 0.3 });
      var al = (it.allergens || []).map(function (a) { return clean(a).toUpperCase(); });
      if (al.length) parts.push({ lines: wrap([{ text: 'CONTAINS ' + al.join(' · '), font: f.sans, size: s * 0.66, track: s * 0.09, color: TEAL }], PANEL.w - 2 * PANEL.side), lead: s * 1.05, gapBefore: s * 0.45 });
      var h = 0;
      parts.forEach(function (p) { h += (p.gapBefore || 0) + p.lines.length * p.lead; });
      return { parts: parts, height: h };
    });
  }

  function build(PDFLib, fontkit, fonts, night) {
    var rgb = PDFLib.rgb, c = function (a) { return rgb(a[0] / 255, a[1] / 255, a[2] / 255); };
    return PDFLib.PDFDocument.create().then(function (doc) {
      doc.registerFontkit(fontkit);
      doc.setTitle('Half Shell Specials ' + (night.date || ''));
      doc.setAuthor('Half Shell'); doc.setCreator('hsoysters.com employee page');
      return Promise.all([
        doc.embedFont(fonts.serif, { subset: true }), doc.embedFont(fonts.serifItalic, { subset: true }),
        doc.embedFont(fonts.sans, { subset: true }), doc.embedFont(fonts.sansBold, { subset: true }),
      ]).then(function (e) {
        var f = { serif: e[0], serifItalic: e[1], sans: e[2], sansBold: e[3] };
        var page = doc.addPage([PAGE.w, PAGE.h]);
        var items = (night.items || []).filter(function (i) { return clean(i.name); });

        // Header and footer are fixed; measured once, drawn on both halves.
        var headH = 0.62 * IN /* sun + horizon */ + 16 + 46 + 18 + 18;
        var adv = wrap([{ text: ADVISORY, font: f.sans, size: 5.6, track: 0.05, color: NAVY }], PANEL.w - 2 * PANEL.side - 0.1 * IN);
        var advLead = 7.3, footH = 14 + adv.length * advLead;
        var areaTop = PAGE.h - PANEL.top - headH, areaBottom = PANEL.bottom + footH + 0.3 * IN;
        var avail = areaTop - areaBottom;

        // Largest name size (9.5pt down to 6.5pt) at which every item fits.
        // At the smallest size the gaps between items close up too; past that it
        // doesn't fit (fits: false) and the page asks for fewer or shorter specials.
        var s = 9.5, blocks, gap, total, measure = function (g) {
          gap = s * g;
          total = blocks.reduce(function (a, b) { return a + b.height; }, 0) + gap * Math.max(0, blocks.length - 1);
        };
        for (;;) {
          blocks = itemBlocks(items, f, s); measure(2.1);
          if (total <= avail || s <= 6.5) break;
          s = Math.round((s - 0.25) * 100) / 100;
        }
        if (total > avail) measure(1.3);

        [0, PANEL.w].forEach(function (x0) {
          var cx = x0 + PANEL.w / 2, y = PAGE.h - PANEL.top;
          function centred(text, font, size, track, color, yy) {
            var w = font.widthOfTextAtSize(text, size) + track * Math.max(0, text.length - 1);
            if (!track) { page.drawText(text, { x: cx - w / 2, y: yy, size: size, font: font, color: c(color) }); return; }
            var x = cx - w / 2;
            for (var i = 0; i < text.length; i++) {
              page.drawText(text[i], { x: x, y: yy, size: size, font: font, color: c(color) });
              x += font.widthOfTextAtSize(text[i], size) + track;
            }
          }
          // Sun on the horizon, with two small waves.
          var r = 0.17 * IN, hz = y - 0.36 * IN;
          page.drawSvgPath('M ' + (-r) + ' 0 A ' + r + ' ' + r + ' 0 0 1 ' + r + ' 0 Z', { x: cx, y: hz, color: c(ORANGE), scale: 1 });
          var wave = function (yy, half) {
            var d = 'M ' + (-half) + ' 0', step = half / 3;
            for (var k = 0; k < 6; k++) d += ' q ' + step / 2 + ' ' + (k % 2 ? 1.6 : -1.6) + ' ' + step + ' 0';
            page.drawSvgPath(d, { x: cx, y: yy, borderColor: c(TEAL), borderWidth: 0.9, scale: 1 });
          };
          wave(hz - 3.5, 0.42 * IN); wave(hz - 7.5, 0.42 * IN);
          y = hz - 0.26 * IN - 10;
          centred('HALF SHELL', f.serif, 10.5, 3.2, NAVY, y);
          y -= 46;
          centred('Specials', f.serifItalic, 40, 0.4, NAVY, y);
          y -= 18;
          centred(niceDate(night.date).toUpperCase(), f.sansBold, 7, 1.9, TEAL, y);
          y -= 12;
          page.drawLine({ start: { x: cx - 18, y: y }, end: { x: cx + 18, y: y }, thickness: 1, color: c(ORANGE) });

          // Items, centred as a block in the space between header and footer.
          var spare = Math.max(0, avail - total), by = areaTop - spare * 0.44;
          blocks.forEach(function (b, bi) {
            b.parts.forEach(function (p) {
              by -= p.gapBefore || 0;
              p.lines.forEach(function (ln) {
                by -= p.lead;
                var lx = cx - ln.width / 2, base = by + (p.lead - ln.height) / 2 + ln.height * 0.18;
                ln.pieces.forEach(function (pc) {
                  var R = pc.run, x = lx + pc.x;
                  if (!R.track) { page.drawText(pc.text, { x: x, y: base, size: R.size, font: R.font, color: c(R.color) }); return; }
                  for (var i = 0; i < pc.text.length; i++) {
                    var ch = pc.text[i];
                    if (ch !== ' ' && ch !== '\u00a0') page.drawText(ch, { x: x, y: base, size: R.size, font: R.font, color: c(R.color) });
                    x += R.font.widthOfTextAtSize(ch, R.size) + R.track;
                  }
                });
              });
            });
            if (bi < blocks.length - 1) by -= gap;
          });

          // Footer: the North Carolina shellfish advisory, required wording.
          var fy = PANEL.bottom + footH;
          page.drawLine({ start: { x: cx - 18, y: fy }, end: { x: cx + 18, y: fy }, thickness: 0.8, color: c(ORANGE) });
          fy -= 14;
          adv.forEach(function (ln) {
            var x = cx - ln.width / 2;
            ln.pieces.forEach(function (pc) {
              var R = pc.run, xx = x + pc.x;
              for (var i = 0; i < pc.text.length; i++) {
                if (pc.text[i] !== ' ') page.drawText(pc.text[i], { x: xx, y: fy, size: R.size, font: R.font, color: c(R.color) });
                xx += R.font.widthOfTextAtSize(pc.text[i], R.size) + R.track;
              }
            });
            fy -= advLead;
          });
        });

        // Cut marks at the top and bottom of the centre line (outside the text).
        var mid = PAGE.w / 2, grey = rgb(0.72, 0.76, 0.78);
        page.drawLine({ start: { x: mid, y: PAGE.h }, end: { x: mid, y: PAGE.h - 0.22 * IN }, thickness: 0.5, color: grey });
        page.drawLine({ start: { x: mid, y: 0 }, end: { x: mid, y: 0.22 * IN }, thickness: 0.5, color: grey });
        return doc.save().then(function (bytes) { return { bytes: bytes, nameSize: s, fits: total <= avail }; });
      });
    });
  }

  // ── In the page: load pdf-lib and the fonts once, then save the file. ──
  var ready = null;
  function script(src) {
    return new Promise(function (ok, bad) {
      var t = document.createElement('script'); t.src = src; t.async = true;
      t.onload = ok; t.onerror = function () { bad(new Error('Could not load ' + src)); };
      document.head.appendChild(t);
    });
  }
  function bytes(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error('Could not load ' + url); return r.arrayBuffer(); });
  }
  function load() {
    if (!ready) {
      ready = Promise.all([
        window.PDFLib ? null : script('src/vendor/pdf-lib.min.js'),
        window.fontkit ? null : script('src/vendor/fontkit.umd.min.js'),
        bytes('assets/fonts/PlayfairDisplay-Regular.ttf'), bytes('assets/fonts/PlayfairDisplay-Italic.ttf'),
        bytes('assets/fonts/Lato-Regular.ttf'), bytes('assets/fonts/Lato-Bold.ttf'),
      ]).then(function (r) { return { serif: r[2], serifItalic: r[3], sans: r[4], sansBold: r[5] }; });
      ready.catch(function () { ready = null; });
    }
    return ready;
  }
  function download(night) {
    return load().then(function (fonts) { return build(window.PDFLib, window.fontkit, fonts, night); }).then(function (out) {
      var blob = new Blob([out.bytes], { type: 'application/pdf' });
      var url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = 'Half Shell Specials ' + night.date + '.pdf';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      return out;
    });
  }

  return { build: build, download: download, menuPrice: menuPrice, niceDate: niceDate, ADVISORY: ADVISORY, wrap: wrap };
});
