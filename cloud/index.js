/**
 * Cloud Functions, codebase "cloud" (Data Ownership Build Guide, S4).
 *
 * Deploy with:  firebase deploy --only functions:cloud
 * (firebase.json lists only this codebase and the database rules; the
 * legacy functions/ codebase and hosting config were removed 05/11/2026.)
 *
 * Runtime Node 22 (firebase.json), region us-east1.
 * Secrets: TOAST_WEBHOOK_SECRET_STOCK, TOAST_WEBHOOK_SECRET_MENUS (toastWebhook).
 * Secret: GH_DISPATCH_TOKEN — fine-grained GitHub token for
 * Garrettkelly11/half-shell-website only, Actions: read and write.
 * Set with:  firebase functions:secrets:set GH_DISPATCH_TOKEN
 *
 * Functions: startToastSync (S4), toastWebhook and refreshMenu (sync triggers,
 * 11/17/2026; sync-trigger.js), setMenuOverride (S6), setHappyHour (S5),
 * deletePassport (Oyster Passport, delete my account), awardStamps
 * (Oyster Passport stamps, 05/11/2026), and the drinks set: uploadDrinkPhoto, saveDrink,
 * removeDrink, setOnMenu, importDrinks, saveSpecial, removeSpecial, saveNightly,
 * saveLibrarySpecial, removeLibrarySpecial
 * (employee page Drinks and Specials tabs, managers and above; drinks-lib.js).
 * The logic lives in lib.js, menu-logic.js, price-logic.js and stamps.js
 * (tested by `node test.js`). Deploying runs vendor-site.js first
 * (firebase.json predeploy), which copies the stamp code into cloud/site/.
 */

'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');
const lib = require('./lib');
const stamps = require('./stamps');
const drinks = require('./drinks-lib');
const syncTrigger = require('./sync-trigger');

initializeApp();
const GH_DISPATCH_TOKEN = defineSecret('GH_DISPATCH_TOKEN');
// Toast webhook signing secrets, one per subscription (Toast gives each
// subscription its own). Set with firebase functions:secrets:set.
const TOAST_WEBHOOK_SECRET_STOCK = defineSecret('TOAST_WEBHOOK_SECRET_STOCK');
const TOAST_WEBHOOK_SECRET_MENUS = defineSecret('TOAST_WEBHOOK_SECRET_MENUS');

exports.startToastSync = onCall(
  { region: 'us-east1', secrets: [GH_DISPATCH_TOKEN], maxInstances: 2 },
  async (request) => {
    try {
      return await lib.startToastSync(request.auth, {
        db: getDatabase(),
        fetch: globalThis.fetch,
        token: GH_DISPATCH_TOKEN.value(),
      });
    } catch (e) {
      if (e instanceof lib.SyncError) throw new HttpsError(e.code, e.message, e.details);
      console.error('startToastSync failed', e);
      throw new HttpsError('internal', 'Something went wrong starting the sync.');
    }
  },
);

// Toast webhook (11/17/2026): Toast posts stock and menu events here; this
// starts the GitHub sync with a 5-minute cooldown (sync-trigger.js). Public:
// Toast can't sign in, so every message must carry a valid Toast signature.
exports.toastWebhook = onRequest(
  { region: 'us-east1', invoker: 'public', maxInstances: 4,
    secrets: [GH_DISPATCH_TOKEN, TOAST_WEBHOOK_SECRET_STOCK, TOAST_WEBHOOK_SECRET_MENUS] },
  async (req, res) => {
    try {
      const out = await syncTrigger.handleToastWebhook(
        { method: req.method, headers: req.headers, rawBody: req.rawBody },
        { db: getDatabase(), fetch: globalThis.fetch, token: GH_DISPATCH_TOKEN.value(),
          secrets: [TOAST_WEBHOOK_SECRET_STOCK.value(), TOAST_WEBHOOK_SECRET_MENUS.value()] });
      if (out.status === 401) console.warn('toastWebhook: bad signature; headers sent:', out.headerNames.join(', '));
      else if (out.status >= 400) console.warn('toastWebhook:', out.status, out.result);
      res.status(out.status).json({ result: out.result });
    } catch (e) {
      console.error('toastWebhook failed', e);
      res.status(500).json({ result: 'error' });
    }
  },
);

// Safety net (11/17/2026): the menu page calls this when a guest opens it.
// Syncs only if nothing has synced in 30 minutes (sync-trigger.js). Open to
// guests (no sign-in); the shared cooldown caps it at one sync per 10 minutes.
exports.refreshMenu = onCall(
  { region: 'us-east1', secrets: [GH_DISPATCH_TOKEN], maxInstances: 4 },
  async () => {
    try {
      return await syncTrigger.refreshMenu({ db: getDatabase(), fetch: globalThis.fetch, token: GH_DISPATCH_TOKEN.value() });
    } catch (e) {
      console.error('refreshMenu failed', e);
      return { ok: false };
    }
  },
);

// Step S6: the employee page's Save Menu and "Back to Toast". The page no
// longer writes the menu itself; this checks staff, writes the overrides
// (until 4 AM) and menu/serving together, and logs each change.
exports.setMenuOverride = onCall(
  { region: 'us-east1', maxInstances: 4 },
  async (request) => {
    try {
      return await lib.setMenuOverride(request.auth, request.data, {
        db: getDatabase(),
        fetch: globalThis.fetch,
      });
    } catch (e) {
      if (e instanceof lib.SyncError) throw new HttpsError(e.code, e.message, e.details);
      console.error('setMenuOverride failed', e);
      throw new HttpsError('internal', 'Something went wrong saving the menu.');
    }
  },
);

// Step S5: the employee page's Happy hour section (managers and above).
// Writes menu/happyHour/schedule or menu/happyHour/today and logs it.
exports.setHappyHour = onCall(
  { region: 'us-east1', maxInstances: 2 },
  async (request) => {
    try {
      return await lib.setHappyHour(request.auth, request.data, { db: getDatabase() });
    } catch (e) {
      if (e instanceof lib.SyncError) throw new HttpsError(e.code, e.message, e.details);
      console.error('setHappyHour failed', e);
      throw new HttpsError('internal', 'Something went wrong saving happy hour.');
    }
  },
);

// Oyster Passport (Build Sheet 5.7): a guest deletes their account from the
// Profile tab. Removes users/{uid} and toastOrders/{uid}, then the sign-in.
exports.deletePassport = onCall(
  { region: 'us-east1', maxInstances: 2 },
  async (request) => {
    try {
      return await lib.deletePassport(request.auth, { db: getDatabase(), auth: getAuth() });
    } catch (e) {
      if (e instanceof lib.SyncError) throw new HttpsError(e.code, e.message, e.details);
      console.error('deletePassport failed', e);
      throw new HttpsError('internal', 'Something went wrong deleting your passport.');
    }
  },
);

// Oyster Passport stamps (audit L-passport-F02, 05/11/2026): the page asks
// after a save; this works the stamps out from the saved visits and writes
// any new tier. Guests can no longer write tiers themselves.
exports.awardStamps = onCall(
  { region: 'us-east1', maxInstances: 4 },
  async (request) => {
    try {
      return await stamps.awardStamps(request.auth, {
        db: getDatabase(),
        fetch: globalThis.fetch,
        SyncError: lib.SyncError,
      });
    } catch (e) {
      if (e instanceof lib.SyncError) throw new HttpsError(e.code, e.message, e.details);
      console.error('awardStamps failed', e);
      throw new HttpsError('internal', 'Something went wrong checking your stamps.');
    }
  },
);

// Drinks and Specials tabs (managers and above; drinks-lib.js checks rank and
// validates). One callable per action; each logs to audit-log.
const STORAGE_BUCKET = (() => {
  try { return JSON.parse(process.env.FIREBASE_CONFIG).storageBucket; } catch (e) { return null; }
})() || 'half-shell-oyster-menu.firebasestorage.app';

function drinksCallable(name, fallback) {
  return onCall({ region: 'us-east1', maxInstances: 2 }, async (request) => {
    try {
      return await drinks[name](request.auth, request.data, { db: getDatabase(), bucket: STORAGE_BUCKET, files: getStorage().bucket(STORAGE_BUCKET) });
    } catch (e) {
      if (e instanceof lib.SyncError) throw new HttpsError(e.code, e.message, e.details);
      console.error(name + ' failed', e);
      throw new HttpsError('internal', fallback);
    }
  });
}
exports.uploadDrinkPhoto = drinksCallable('uploadDrinkPhoto', 'Something went wrong uploading the photo.');
exports.saveDrink = drinksCallable('saveDrink', 'Something went wrong saving the drink.');
exports.removeDrink = drinksCallable('removeDrink', 'Something went wrong removing the drink.');
exports.setOnMenu = drinksCallable('setOnMenu', 'Something went wrong changing the menu.');
exports.importDrinks = drinksCallable('importDrinks', 'Something went wrong importing the drinks.');
exports.saveSpecial = drinksCallable('saveSpecial', 'Something went wrong saving the special.');
exports.removeSpecial = drinksCallable('removeSpecial', 'Something went wrong removing the special.');
exports.saveNightly = drinksCallable('saveNightly', 'Something went wrong saving tonight\'s specials.');
exports.saveLibrarySpecial = drinksCallable('saveLibrarySpecial', 'Something went wrong saving the special.');
exports.removeLibrarySpecial = drinksCallable('removeLibrarySpecial', 'Something went wrong deleting the special.');
