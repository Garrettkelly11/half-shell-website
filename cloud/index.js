/**
 * Cloud Functions, codebase "cloud" (Data Ownership Build Guide, S4).
 *
 * Deploy ONLY with:  firebase deploy --only functions:cloud
 * (A bare `firebase deploy` would also publish the legacy hosting and
 * functions configs in firebase.json.)
 *
 * Runtime Node 22 (firebase.json), region us-east1.
 * Secret: GH_DISPATCH_TOKEN — fine-grained GitHub token for
 * Garrettkelly11/half-shell-website only, Actions: read and write.
 * Set with:  firebase functions:secrets:set GH_DISPATCH_TOKEN
 *
 * The logic lives in lib.js (tested by `node test.js`).
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const lib = require('./lib');

initializeApp();
const GH_DISPATCH_TOKEN = defineSecret('GH_DISPATCH_TOKEN');

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
