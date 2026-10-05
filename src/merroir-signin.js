/*
 * Merroir sign-in for the employee page (Data Ownership Build Guide M5;
 * Merroir spec v1.7, signin-plan.md).
 *
 * Staff sign in with their Merroir username and password. The page sends
 * them to Merroir's sign-in address; Merroir checks them with the same
 * rules as its own login (active staff only) and answers with a Firebase
 * sign-in token. The first time someone logs in (temporary password),
 * Merroir instead sends them to set their own password, then back here
 * with the token after the # and the one-time code this page saved.
 *
 * Loaded by employee.html as a global (HS_SIGNIN) and by
 * tools/signin-test.js via require. Pure logic only; the page does the
 * network and Firebase calls.
 */
(function (root) {
  'use strict';

  var MERROIR_URL = 'https://merroir.onrender.com';
  var SIGN_IN_PATH = '/api/employee-page/sign-in/';
  var STATE_KEY = 'hsMerroirSignInState';

  var MESSAGES = {
    refused: "Username or password is wrong, or this account can't use the employee page. Ask a manager.",
    throttled: 'Too many tries. Wait 15 minutes and try again.',
    unavailable: "Couldn't reach the menu database. Try again in a minute.",
    network: "Couldn't reach Merroir. Check the connection and try again.",
    badReturn: 'That sign-in link has expired or was opened in another tab. Sign in again.',
  };

  /** A random one-time code (base64url, 32 characters). */
  function makeState(randomBytes) {
    var bytes = randomBytes(24);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    var b64 = (typeof btoa === 'function') ? btoa(s) : Buffer.from(s, 'binary').toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /**
   * After a first login, Merroir returns to employee.html#token=...&state=...
   * Returns null if the hash isn't a sign-in return, {token} if the code
   * matches the one this tab saved, or {error} if it doesn't.
   */
  function readReturn(hash, savedState) {
    var h = String(hash || '').replace(/^#/, '');
    if (!h) return null;
    var params = {};
    h.split('&').forEach(function (pair) {
      var i = pair.indexOf('=');
      if (i > 0) params[decodeURIComponent(pair.slice(0, i))] =
        decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
    });
    if (!('token' in params) && !('state' in params)) return null;
    if (!params.token || !params.state || !savedState || params.state !== savedState) {
      return { error: MESSAGES.badReturn };
    }
    return { token: params.token };
  }

  /** What to do with Merroir's answer: {token} | {redirect} | {error}. */
  function interpret(status, body) {
    body = body || {};
    if (status === 200 && body.status === 'ok' && body.token) return { token: body.token, name: body.name };
    if (status === 200 && body.status === 'first_login'
        && String(body.url || '').indexOf(MERROIR_URL + '/') === 0) {
      return { redirect: body.url };
    }
    if (body.status === 'throttled') return { error: MESSAGES.throttled };
    if (body.status === 'unavailable') return { error: MESSAGES.unavailable };
    return { error: MESSAGES.refused };
  }

  var api = {
    MERROIR_URL: MERROIR_URL,
    SIGN_IN_URL: MERROIR_URL + SIGN_IN_PATH,
    STATE_KEY: STATE_KEY,
    MESSAGES: MESSAGES,
    makeState: makeState,
    readReturn: readReturn,
    interpret: interpret,
  };
  root.HS_SIGNIN = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
