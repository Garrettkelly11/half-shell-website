/*
 * Tests for src/merroir-signin.js (employee page sign-in with Merroir, M5).
 *   node tools/signin-test.js
 */
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const S = require('../src/merroir-signin.js');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('PASS  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

check('the sign-in address is Merroir\'s', () => {
  assert.strictEqual(S.SIGN_IN_URL, S.MERROIR_URL + '/api/employee-page/sign-in/');
  assert.ok(/^https:\/\//.test(S.MERROIR_URL));
});
check('one-time codes are 32 URL-safe characters and differ every time', () => {
  const a = S.makeState(n => crypto.randomBytes(n)), b = S.makeState(n => crypto.randomBytes(n));
  assert.ok(/^[A-Za-z0-9_-]{32}$/.test(a), a);
  assert.notStrictEqual(a, b);
});
check('no #, or an unrelated #, is not a sign-in return', () => {
  assert.strictEqual(S.readReturn('', 'x'), null);
  assert.strictEqual(S.readReturn('#menu', 'x'), null);
});
check('a return with the code this tab saved gives the token', () => {
  assert.deepStrictEqual(S.readReturn('#token=abc.def-ghi&state=CODE1234567890ab', 'CODE1234567890ab'),
    { token: 'abc.def-ghi' });
});
check('a return with another code is refused (a crafted link can\'t sign someone in)', () => {
  assert.deepStrictEqual(S.readReturn('#token=abc&state=OTHER', 'CODE1234567890ab'),
    { error: S.MESSAGES.badReturn });
});
check('a return when this tab saved no code is refused', () => {
  assert.ok(S.readReturn('#token=abc&state=CODE', null).error);
});
check('a return missing the token is refused', () => {
  assert.ok(S.readReturn('#state=CODE', 'CODE').error);
});
check('URL-encoded tokens are decoded', () => {
  assert.deepStrictEqual(S.readReturn('#token=a%2Bb%3D&state=C', 'C'), { token: 'a+b=' });
});
check('Merroir says ok → sign in with the token', () => {
  assert.deepStrictEqual(S.interpret(200, { status: 'ok', token: 't', name: 'Garrett K.' }),
    { token: 't', name: 'Garrett K.' });
});
check('first login → go to Merroir (only to Merroir)', () => {
  const url = S.MERROIR_URL + '/login/?next=x&first=1';
  assert.deepStrictEqual(S.interpret(200, { status: 'first_login', url }), { redirect: url });
  assert.ok(S.interpret(200, { status: 'first_login', url: 'https://evil.example/login/' }).error);
});
check('refused, throttled and unavailable each show their message', () => {
  assert.strictEqual(S.interpret(401, { status: 'refused' }).error, S.MESSAGES.refused);
  assert.strictEqual(S.interpret(429, { status: 'throttled' }).error, S.MESSAGES.throttled);
  assert.strictEqual(S.interpret(503, { status: 'unavailable' }).error, S.MESSAGES.unavailable);
});
check('anything unexpected shows the refused message', () => {
  assert.strictEqual(S.interpret(500, null).error, S.MESSAGES.refused);
  assert.strictEqual(S.interpret(200, { status: 'ok' }).error, S.MESSAGES.refused);
});
check('the page\'s messages match Merroir\'s wording', () => {
  assert.ok(S.MESSAGES.refused.includes('Ask a manager'));
  assert.ok(S.MESSAGES.throttled.includes('15 minutes'));
});

console.log('\n' + (failed ? `${failed} of ${passed + failed} checks failed.` : `All ${passed} checks passed.`));
process.exit(failed ? 1 : 0);
