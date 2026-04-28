/**
 * Firebase Cloud Functions entry point — Half Shell Toast sync.
 *
 * Exports three functions:
 *   - syncToastMenu           HTTP: called by employee.html "Sync Toast" button.
 *                             Returns oyster list for preview; no Firebase writes.
 *   - syncToastMenuAutomatic  HTTP: forces a write to Firebase. Safety net for manual triggers.
 *   - scheduledToastSync      Scheduled: runs every 15 min during service hours,
 *                             writes sync'd list to /menu/serving.
 *
 * Secrets are configured via Firebase Functions secrets (preferred) or env vars.
 * Set once with:
 *   firebase functions:secrets:set TOAST_CLIENT_SECRET
 *   firebase functions:config:set toast.client_id=... toast.location_id=...
 *
 * Deploy: `npm run deploy` (from this directory).
 */

const functions = require('firebase-functions');
const { defineSecret, defineString } = require('firebase-functions/params');

// --- Params & secrets ------------------------------------------------------
// Defined here so Firebase knows to wire them into the function environment.
const toastClientSecret = defineSecret('TOAST_CLIENT_SECRET');
const toastClientId = defineString('TOAST_CLIENT_ID');
const toastLocationId = defineString('TOAST_LOCATION_ID');
const toastApiHostname = defineString('TOAST_API_HOSTNAME', { default: 'https://ws-api.toasttab.com' });
const toastUserAccessType = defineString('TOAST_USER_ACCESS_TYPE', { default: 'TOAST_MACHINE_CLIENT' });
// Note: TOAST_OYSTER_GROUP_GUID / TOAST_OYSTER_GROUP_NAME were removed —
// the new sync logic iterates every group and matches by item name against
// the local catalog, so per-group filtering isn't needed. If a Half Shell
// menu ever grows so large that scanning everything is wasteful, reintroduce
// a group filter here and pass it through to fetchFromToastAPI.

const RUNTIME_OPTS = {
  secrets: [toastClientSecret],
  timeoutSeconds: 60,
  memory: '256MB',
  region: 'us-east1', // Charlotte is closest to us-east1
};

// Lazy-require the sync module so secrets are populated first.
function loadSync() {
  // Populate process.env from params/secrets before requiring the module.
  process.env.TOAST_CLIENT_SECRET = toastClientSecret.value();
  process.env.TOAST_CLIENT_ID = toastClientId.value();
  process.env.TOAST_LOCATION_ID = toastLocationId.value();
  process.env.TOAST_API_HOSTNAME = toastApiHostname.value();
  process.env.TOAST_USER_ACCESS_TYPE = toastUserAccessType.value();
  return require('./sync-toast-endpoint');
}

// --- Manual sync (preview only) --------------------------------------------
exports.syncToastMenu = functions
  .runWith(RUNTIME_OPTS)
  .https.onRequest(async (req, res) => {
    // CORS for browser call from employee.html
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).send('');

    const sync = loadSync();
    return sync.syncToastMenuHTTP(req, res);
  });

// --- Manual trigger of full sync-to-Firebase (admin/debug) -----------------
exports.syncToastMenuAutomatic = functions
  .runWith(RUNTIME_OPTS)
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    const sync = loadSync();
    return sync.syncToastMenuAutomaticHTTP(req, res);
  });

// --- Scheduled sync (every 15 min, 11am–11pm ET) ---------------------------
exports.scheduledToastSync = functions
  .runWith(RUNTIME_OPTS)
  .pubsub.schedule('every 15 minutes')
  .timeZone('America/New_York')
  .onRun(async (context) => {
    const hour = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).getHours();
    if (hour < 11 || hour >= 23) {
      console.log(`Outside service hours (${hour}:00 ET). Skipping sync.`);
      return null;
    }
    const sync = loadSync();
    const result = await sync.syncToastToFirebase();
    console.log('Scheduled sync result:', result);
    return null;
  });
