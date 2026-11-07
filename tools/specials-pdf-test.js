#!/usr/bin/env node
/**
 * Tests for src/specials-pdf.js: builds the 2-up specials PDF with the real
 * vendored pdf-lib and fonts. Run: node tools/specials-pdf-test.js [out.pdf]
 * (touches nothing live; writes the PDF only when a path is given).
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PDFLib = require(path.join(ROOT, 'src/vendor/pdf-lib.min.js'));
const fontkit = require(path.join(ROOT, 'src/vendor/fontkit.umd.min.js'));
const P = require(path.join(ROOT, 'src/specials-pdf.js'));
const font = (f) => fs.readFileSync(path.join(ROOT, 'assets/fonts', f));
const fonts = { serif: font('PlayfairDisplay-Regular.ttf'), serifItalic: font('PlayfairDisplay-Italic.ttf'), sans: font('Lato-Regular.ttf'), sansBold: font('Lato-Bold.ttf') };

const SAMPLE = [
  { name: 'Crab Dip', ingredients: 'jumbo lump, sherry cream, Old Bay, grilled baguette', allergens: ['Shellfish', 'Milk', 'Wheat'], price: 1600 },
  { name: 'Oyster Po’ Boy', ingredients: 'fried Blue Points, remoulade, shaved lettuce', description: 'On a toasted Leidenheimer roll.', allergens: ['Shellfish', 'Eggs', 'Wheat'], price: 1450 },
  { name: 'Tuna Crudo', ingredients: 'yellowfin, citrus, chili oil, sesame', allergens: ['Fish', 'Sesame'], price: 1800 },
  { name: 'Clam Chowder', ingredients: 'littlenecks, bacon, potato, cream', allergens: ['Shellfish', 'Milk'], price: 1100 },
];

(async () => {
  assert.strictEqual(P.menuPrice(1400), '14'); assert.strictEqual(P.menuPrice(1450), '14.5'); assert.strictEqual(P.menuPrice(1405), '14.05'); assert.strictEqual(P.menuPrice(), '');
  assert.strictEqual(P.niceDate('2026-11-06'), 'Friday, November 6');

  const out = await P.build(PDFLib, fontkit, fonts, { date: '2026-11-06', items: SAMPLE });
  const doc = await PDFLib.PDFDocument.load(out.bytes);
  assert.strictEqual(doc.getPageCount(), 1, 'one sheet');
  const { width, height } = doc.getPage(0).getSize();
  assert.deepStrictEqual([width, height], [612, 792], 'US Letter portrait');
  assert.ok(out.fits && out.nameSize === 9.5, 'four specials fit at full size');

  // Many long specials shrink to fit, down to the floor.
  const many = Array.from({ length: 9 }, (_, i) => Object.assign({}, SAMPLE[i % 4], { name: SAMPLE[i % 4].name + ' ' + (i + 1), description: 'A longer description that runs onto a second line on a narrow card.' }));
  const big = await P.build(PDFLib, fontkit, fonts, { date: '2026-11-06', items: many });
  assert.ok(big.nameSize < 9.5 && big.fits, 'shrinks to fit a long list');
  const huge = await P.build(PDFLib, fontkit, fonts, { date: '2026-11-06', items: many.concat(many, many) });
  assert.strictEqual(huge.fits, false, 'reports when it cannot fit');

  // The price never starts a line on its own.
  const f = { widthOfTextAtSize: (t, s) => t.length * s * 0.5 };
  const lines = P.wrap([{ text: 'AAAA BBBB', font: f, size: 10, track: 0 }, { text: '  14', font: f, size: 10, track: 0, glue: true }], 50);
  assert.ok(!/^ /.test(lines[lines.length - 1].pieces[0].text), 'price glued to the word before');

  if (process.argv[2]) fs.writeFileSync(process.argv[2], out.bytes);
  if (process.argv[3]) fs.writeFileSync(process.argv[3], big.bytes);
  console.log('specials-pdf-test: all checks passed (long list at ' + big.nameSize + 'pt, fits: ' + big.fits + ')');
})().catch((e) => { console.error('FAIL ' + e.stack); process.exit(1); });
