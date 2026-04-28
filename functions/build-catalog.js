#!/usr/bin/env node
/**
 * Build step: snapshot data/oysters.js into functions/oyster-catalog.json.
 *
 * The Cloud Function deploys only the contents of `functions/`, so the
 * authoritative catalog at `../data/oysters.js` isn't reachable at runtime
 * unless we ship it in. This script reads the browser-style file via Node's
 * `vm` module (same pattern as `tools/toast-probe.js`) and writes the OYSTERS
 * array to JSON next to the function code.
 *
 * Wired in two places:
 *   - `firebase.json` predeploy hook → runs automatically on `firebase deploy`.
 *   - `functions/package.json` script `build:catalog` → for manual local rebuilds.
 *
 * Single source of truth stays at `data/oysters.js`; this is just a deploy
 * artifact. `oyster-catalog.json` should be regenerated, not hand-edited.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const inputPath = path.join(__dirname, '..', 'data', 'oysters.js');
const outputPath = path.join(__dirname, 'oyster-catalog.json');

if (!fs.existsSync(inputPath)) {
  console.error(`ERROR: catalog source not found at ${inputPath}`);
  process.exit(1);
}

const code = fs.readFileSync(inputPath, 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

if (!Array.isArray(sandbox.OYSTERS) || !sandbox.OYSTERS.length) {
  console.error('ERROR: data/oysters.js did not produce a non-empty OYSTERS array.');
  process.exit(1);
}

fs.writeFileSync(outputPath, JSON.stringify(sandbox.OYSTERS, null, 2));
console.log(`Wrote ${sandbox.OYSTERS.length} oysters to ${outputPath}`);
