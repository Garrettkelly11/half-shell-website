/*
 * The employee page's Oysters tab: managers add and edit oysters and
 * regions in Merroir, which publishes data/oysters.js and data/regions.js
 * to this repo (Merroir spec v1.8, editing-plan.md; Data Ownership Build
 * Guide M3 phase 2 + M4).
 *
 * The page sends each request to Merroir with the person's Firebase
 * sign-in ("Authorization: Bearer <ID token>"). Merroir checks it and
 * requires MANAGER or above; the tab is shown only when the sign-in token
 * says rank 20 or more (claim staff_rank), but Merroir decides.
 *
 * Loaded by employee.html as a global (HS_CATALOG) and by
 * tools/catalog-editor-test.js via require. Pure logic only; the page does
 * the network calls and the drawing.
 */
(function (root) {
  'use strict';

  var MERROIR_URL = 'https://merroir.onrender.com';
  var API = MERROIR_URL + '/api/catalog/';
  var MANAGER_RANK = 20;

  // The form's fields, in the order the form shows them.
  var FIELDS = [
    { key: 'name', label: 'Name', required: true },
    { key: 'aliases', label: 'Other names (Toast spellings)', hint: 'Separate with commas' },
    { key: 'salinity', label: 'Salinity', select: 'salinities', unknown: true },
    { key: 'salinityText', label: 'Salinity text', required: true },
    { key: 'region', label: 'Region', select: 'regions', required: true },
    { key: 'origin', label: 'Origin', required: true },
    { key: 'farmer', label: 'Farmer', unknown: true },
    { key: 'farmerUrl', label: 'Farmer website', unknown: true, hint: 'https://…' },
    { key: 'species', label: 'Species', required: true },
    { key: 'farmingMethod', label: 'Farming method', required: true },
    { key: 'growOut', label: 'Grow-out', required: true },
    { key: 'seasonalAvailability', label: 'Availability', required: true },
    { key: 'size', label: 'Size', required: true },
    { key: 'shell', label: 'Shell', required: true },
    { key: 'tastingNotes', label: 'Tasting notes', required: true, long: true },
    { key: 'notable', label: 'Notable', required: true, long: true },
    { key: 'photoUrl', label: 'Photo', unknown: true, hint: 'assets/oysters/name.jpg' },
    { key: 'photoAlt', label: 'Photo description', required: true },
  ];

  var REGION_FIELDS = [
    { key: 'code', label: 'Code', hint: '2–4 lowercase letters, e.g. or', createOnly: true },
    { key: 'name', label: 'Name' },
    { key: 'short', label: 'Short name', hint: 'e.g. OR' },
    { key: 'country', label: 'Country', options: [['US', 'US'], ['CA', 'Canada']] },
    { key: 'coast', label: 'Coast', options: [['east', 'East'], ['west', 'West']] },
    { key: 'group', label: 'Group', select: 'groups', none: true },
  ];

  var TOAST_REMINDER = 'Use the name exactly as Toast has it, or add Toast’s spelling under ' +
    'Other names. The Toast sync matches oysters by name.';

  var MESSAGES = {
    network: "Couldn't reach Merroir. Check the connection and try again.",
    signIn: 'Your sign-in has expired. Sign out and sign in again.',
    closed: 'Oyster editing opens on the switch-over day. Until then, nothing here can be saved.',
  };

  function isManager(claims) {
    var r = claims && Number(claims.staff_rank);
    return !!r && r >= MANAGER_RANK;
  }

  /** "Fat Bellies, Fat Belly " → ["Fat Bellies", "Fat Belly"] */
  function splitAliases(text) {
    var out = [];
    String(text || '').split(',').forEach(function (a) {
      a = a.trim();
      if (a && out.indexOf(a) < 0) out.push(a);
    });
    return out;
  }

  /** An oyster from Merroir → the form's values (strings; "—" for unknown). */
  function formValues(oyster) {
    var v = {};
    FIELDS.forEach(function (f) {
      var x = oyster ? oyster[f.key] : null;
      if (f.key === 'aliases') v[f.key] = (x || []).join(', ');
      else if (x === null || x === undefined || x === '') v[f.key] = (oyster && f.unknown) ? '—' : '';
      else v[f.key] = String(x);
    });
    return v;
  }

  /** The form's values → what Merroir expects. */
  function payload(values, confirmDifferent) {
    var p = {};
    FIELDS.forEach(function (f) {
      var x = values[f.key] === undefined ? '' : String(values[f.key]).trim();
      p[f.key] = f.key === 'aliases' ? splitAliases(x) : x;
    });
    if (confirmDifferent) p.confirm_different = true;
    return p;
  }

  /**
   * Merroir's answer → what the page does.
   *   {ok: true, data}                    saved (data has oyster/region and publish)
   *   {confirm: [warnings], message}      near-duplicate names: tick the box and save again
   *   {error, errors: {field: message}}   not saved
   *   {error, signIn: true}               sign in again
   */
  function interpret(status, body) {
    body = body || {};
    if (status === 200 && body.status === 'ok') return { ok: true, data: body };
    if (status === 409 && body.status === 'confirm') {
      return { confirm: body.warnings || [], message: body.message || 'Check these are different oysters.' };
    }
    if (status === 401) return { error: MESSAGES.signIn, signIn: true };
    if (status === 400 || status === 403) {
      return { error: body.message || 'Not saved.', errors: body.errors || {} };
    }
    return { error: 'Merroir answered ' + status + '. Nothing may have been saved; reload and check.' };
  }

  /** One publish result → a line for the page, with a link when there is one. */
  function describePublish(p) {
    if (!p) return { text: 'Nothing changed.', kind: 'info' };
    if (p.status === 'PUBLISHED') {
      return { text: 'Saved. Live on the site in about 2 minutes.', link: p.commit_url, kind: 'ok' };
    }
    if (p.status === 'NO_CHANGE') return { text: 'Saved. The site already has it.', kind: 'ok' };
    return { text: 'Saved, not yet on the site. ' + (p.error || ''), kind: 'warn', publishNow: true };
  }

  /** Several (Publish now) → one line. */
  function describePublishes(list) {
    list = list || [];
    var bad = list.filter(function (p) { return p.status === 'REFUSED' || p.status === 'FAILED'; });
    if (bad.length) return describePublish(bad[0]);
    var done = list.filter(function (p) { return p.status === 'PUBLISHED'; });
    if (done.length) return { text: 'Published. Live on the site in about 2 minutes.', link: done[done.length - 1].commit_url, kind: 'ok' };
    return { text: 'The site is up to date.', kind: 'ok' };
  }

  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

  /** Oysters with this status whose name, aliases, origin or id match the search. */
  function filterOysters(oysters, query, status) {
    var q = norm(query);
    return (oysters || []).filter(function (o) {
      if (status && o.status !== status) return false;
      if (!q) return true;
      return [o.name, o.id, o.origin].concat(o.aliases || []).some(function (s) { return norm(s).indexOf(q) >= 0; });
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  function regionName(regions, code) {
    var r = (regions || []).filter(function (x) { return x.code === code; })[0];
    return r ? r.name : (code || '');
  }

  var api = {
    MERROIR_URL: MERROIR_URL, API: API, MANAGER_RANK: MANAGER_RANK, FIELDS: FIELDS,
    REGION_FIELDS: REGION_FIELDS, TOAST_REMINDER: TOAST_REMINDER, MESSAGES: MESSAGES,
    isManager: isManager, splitAliases: splitAliases, formValues: formValues, payload: payload,
    interpret: interpret, describePublish: describePublish, describePublishes: describePublishes,
    filterOysters: filterOysters, regionName: regionName,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HS_CATALOG = api;
})(this);
