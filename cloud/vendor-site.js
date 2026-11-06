/**
 * Runs before `firebase deploy --only functions:cloud` (firebase.json
 * predeploy). Copies the site files awardStamps needs into cloud/site/, so the
 * deployed function uses exactly the stamp logic the pages use. cloud/site/ is
 * generated: gitignored, never edited by hand.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FROM = path.join(__dirname, '..');
const TO = path.join(__dirname, 'site');
const FILES = ['src/passport-core.js', 'data/stamps.js', 'data/flights.js', 'data/regions.js', 'data/oysters.js'];

fs.rmSync(TO, { recursive: true, force: true });
for (const f of FILES) {
  fs.mkdirSync(path.dirname(path.join(TO, f)), { recursive: true });
  fs.copyFileSync(path.join(FROM, f), path.join(TO, f));
}
console.log(`vendor-site: copied ${FILES.length} files into cloud/site/`);
