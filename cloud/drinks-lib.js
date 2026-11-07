/**
 * Drinks and specials: the server side of the employee page's Drinks and
 * Specials tabs. Managers and above only. The page never writes the menu
 * itself (database rules say .write: false); each action re-checks the
 * rank, re-validates everything with src/drinks-core.js (the same rules the
 * page uses), writes, and adds one audit-log entry.
 *
 * Toast is the source of truth for a drink's name, price, section and 86
 * status (the Toast sync writes menu/toastDrinks). A record here holds only
 * what a manager adds, and it shows on the bar menu only while a Toast drink
 * with the same name exists. Nothing here ever writes a price or a section.
 *
 * Data (see database.rules.json):
 *   menu/toastDrinks/{key}      from Toast (the sync); guests see it once config/drinksPublic is true
 *   menu/drinks/{id}            the extras; guests see it only once config/drinksPublic is true
 *   menu/drinkSpecials/{id}     same
 *   menu/nightlySpecials/{date} staff only: that night's food specials, in menu order
 *   menu/specialsLibrary/{id}   staff only: every food special a manager has saved, to pick from
 * Photos: the page shrinks the picture, sends it to uploadDrinkPhoto (checks the
 * rank and that it really is an image), which saves it to Firebase Storage and
 * returns the link. Only that link is ever saved on a drink or special.
 */
'use strict';

const path = require('path');
const lib = require('./lib');
const { SyncError, staffEntry, auditEntry, MANAGER_RANK } = lib;

let D;
try { D = require(path.join(__dirname, 'site', 'src', 'drinks-core.js')); } // deployed copy
catch (e) { D = require('../src/drinks-core.js'); }                          // local tests

const STORAGE_PREFIX = (bucket) => `${D.STORAGE_HOST}v0/b/${bucket}/o/`;

async function manager(auth, db, what) {
  const { name, rank: liveRank } = await staffEntry(auth, db, what);
  const rank = Number(auth.token && auth.token.staff_rank);
  if (!(rank >= MANAGER_RANK) || !(liveRank >= MANAGER_RANK)) { // the live staff entry must exist and agree
    throw new SyncError('permission-denied', `Only managers can ${what}. Sign out and in again if you were just promoted.`);
  }
  return name;
}

function checkPhoto(drink, bucket) {
  if (!drink.photo) return;
  if (!bucket || !D.validPhotoUrl(drink.photo, bucket)) {
    throw new SyncError('invalid-argument', 'That photo was not uploaded through this site.');
  }
}
async function val(db, p) { return (await db.ref(p).once('value')).val(); }

/** data: { drink, create? }. create: true refuses to overwrite an existing id. */
async function saveDrink(auth, data, deps) {
  const { db, bucket } = deps; const now = (deps.now || Date.now)();
  const actor = await manager(auth, db, 'edit drinks');
  const v = D.validateDrink(data && data.drink);
  if (!v.ok) throw new SyncError('invalid-argument', v.errors.join(' '));
  checkPhoto(v.drink, bucket);
  const all = (await val(db, 'menu/drinks')) || {};
  const clash = Object.keys(all).find((k) => k !== v.drink.id && D.toastKey(all[k].name) === D.toastKey(v.drink.name));
  if (clash) throw new SyncError('already-exists', `"${all[clash].name}" already has details for that Toast drink. Edit that one instead.`);
  const existing = all[v.drink.id] || null;
  if (data.create && existing) throw new SyncError('already-exists', `There is already a drink called "${existing.name}". Edit that one instead.`);
  if (!data.create && !existing) throw new SyncError('not-found', 'That drink is not on the menu any more.');
  const count = Object.keys(all).length;
  if (!existing && count >= D.LIMITS.drinks) throw new SyncError('resource-exhausted', `The menu is full (${D.LIMITS.drinks} drinks).`);
  const drink = Object.assign({}, v.drink, { by: actor, at: now });
  if (!drink.photo) delete drink.photo;
  if (data.create) {
    // Two managers adding the same drink at once: only the first write lands.
    const tx = await db.ref(`menu/drinks/${drink.id}`).transaction((cur) => (cur ? undefined : drink));
    if (!tx.committed) throw new SyncError('already-exists', 'Someone just added that drink. Edit it instead.');
  } else {
    await db.ref(`menu/drinks/${drink.id}`).set(drink);
  }
  await db.ref('audit-log').push(auditEntry(existing ? 'drink_updated' : 'drink_created', drink.name, actor, now));
  return { ok: true, id: drink.id };
}

async function dropSpecialsFor(db, ids) {
  const specials = (await val(db, 'menu/drinkSpecials')) || {};
  const gone = Object.keys(specials).filter((k) => ids.indexOf(specials[k].drinkId) >= 0);
  if (gone.length) {
    const u = {}; gone.forEach((k) => { u[k] = null; });
    await db.ref('menu/drinkSpecials').update(u);
  }
  return gone.length;
}

/** data: { id } */
async function removeDrink(auth, data, deps) {
  const { db } = deps; const now = (deps.now || Date.now)();
  const actor = await manager(auth, db, 'remove drinks');
  const id = data && data.id;
  const existing = typeof id === 'string' && /^[a-z0-9-]{1,60}$/.test(id) ? await val(db, `menu/drinks/${id}`) : null;
  if (!existing) throw new SyncError('not-found', 'That drink is not on the menu.');
  await db.ref(`menu/drinks/${id}`).set(null);
  // Removing the details only resets the drink to Toast's own; its specials go only if Toast no longer has the drink.
  const toast = (await val(db, 'menu/toastDrinks')) || {};
  const stillInToast = !!toast[D.toastKey(existing.name)] && D.usableToast(toast[D.toastKey(existing.name)]);
  const specials = stillInToast ? 0 : await dropSpecialsFor(db, [id]);
  await db.ref('audit-log').push(auditEntry('drink_removed', `${existing.name}` + (specials ? `; ended ${specials} special(s) on it` : ''), actor, now));
  return { ok: true, endedSpecials: specials };
}

/**
 * data: { mode: 'merge' | 'replace', drinks: [raw rows], confirm? }
 * Every row is validated again here. A row that fails stops the whole import
 * (nothing is half-applied). 'replace' removes drinks missing from the file
 * and needs confirm: true. Photos already on a drink are kept.
 */
async function importDrinks(auth, data, deps) {
  const { db, bucket } = deps; const now = (deps.now || Date.now)();
  const actor = await manager(auth, db, 'import drinks');
  const mode = data && data.mode;
  if (mode !== 'merge' && mode !== 'replace') throw new SyncError('invalid-argument', 'Import mode is merge or replace.');
  const rows = data && Array.isArray(data.drinks) ? data.drinks : null;
  if (!rows || !rows.length) throw new SyncError('invalid-argument', 'There are no drinks to import.');
  if (rows.length > D.LIMITS.drinks) throw new SyncError('invalid-argument', `At most ${D.LIMITS.drinks} drinks.`);
  if (mode === 'replace' && data.confirm !== true) throw new SyncError('failed-precondition', 'Replacing the menu needs confirmation.');
  const current = (await val(db, 'menu/drinks')) || {};
  const incoming = Object.create(null), keys = Object.create(null), errors = [];
  const fields = Array.isArray(data.fields) ? data.fields.filter((f) => typeof f === 'string' && D.FIELDS.indexOf(f) >= 0) : null;
  rows.forEach((r, i) => {
    const v = D.validateDrink(Object.assign({}, r, { photo: undefined })); // photos come only from uploads
    if (!v.ok) { errors.push(`Row ${i + 1}: ${v.errors.join(' ')}`); return; }
    if (incoming[v.drink.id] || keys[D.toastKey(v.drink.name)]) { errors.push(`Row ${i + 1}: repeats "${(incoming[v.drink.id] || keys[D.toastKey(v.drink.name)]).name}".`); return; }
    incoming[v.drink.id] = keys[D.toastKey(v.drink.name)] = v.drink;
  });
  if (mode === 'merge') { // a kept record with another id but the same Toast drink would show twice
    Object.keys(current).forEach((id) => { const k = D.toastKey(current[id].name); if (!incoming[id] && keys[k]) errors.push(`"${keys[k].name}" already has details as "${current[id].name}".`); });
  }
  if (errors.length) throw new SyncError('invalid-argument', errors.slice(0, 5).join(' ') + (errors.length > 5 ? ` (+${errors.length - 5} more)` : ''));
  const updates = {}; const diff = D.diffImport(current, Object.keys(incoming).map((k) => incoming[k]), mode, fields);
  if (mode === 'replace') {
    // What the manager saw in the preview must be what gets removed.
    const seen = Array.isArray(data.expectedRemoved) ? data.expectedRemoved.slice().sort() : null;
    const now2 = diff.removed.slice().sort();
    if (!seen || seen.length !== now2.length || seen.some((x, i) => x !== now2[i])) {
      throw new SyncError('failed-precondition', 'The menu changed since you previewed this file. Choose the file again to see what will be removed.');
    }
  }
  Object.keys(incoming).forEach((id) => {
    const old = Object.prototype.hasOwnProperty.call(current, id) ? current[id] : undefined;
    const d = Object.assign({}, mode === 'merge' ? D.mergeFields(old, incoming[id], fields) : incoming[id], { by: actor, at: now });
    delete d.keep;
    if (old && old.photo) d.photo = old.photo;
    if (d.sort == null && old && old.sort != null) d.sort = old.sort;
    updates[id] = d;
  });
  const removedNames = {}; diff.removed.forEach((id) => { removedNames[id] = current[id].name; updates[id] = null; });
  if (mode === 'merge' && Object.keys(current).length + diff.added.length > D.LIMITS.drinks) throw new SyncError('resource-exhausted', `The menu would pass ${D.LIMITS.drinks} drinks.`);
  await db.ref('menu/drinks').update(updates);
  const toast = diff.removed.length ? ((await val(db, 'menu/toastDrinks')) || {}) : {};
  const gone = diff.removed.filter((id) => !toast[D.toastKey(removedNames[id])]); // specials end only for drinks Toast no longer has
  const ended = gone.length ? await dropSpecialsFor(db, gone) : 0;
  await db.ref('audit-log').push(auditEntry('drinks_imported',
    `${mode}: ${diff.added.length} added, ${diff.changed.length} changed, ${diff.removed.length} removed, ${diff.same.length} unchanged` + (ended ? `; ended ${ended} special(s)` : ''), actor, now));
  return { ok: true, added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length, same: diff.same.length };
}

/**
 * data: { ids: [row ids], on: boolean }. Adds Toast drinks to the bar menu (creates a plain record for a drink nobody
 * has touched, or switches an existing one back on), or takes them off (switches the record off; details are kept).
 * One write, one audit entry. ids are the manager list's row ids (a record id, or the slug of the Toast name).
 */
async function setOnMenu(auth, data, deps) {
  const { db } = deps; const now = (deps.now || Date.now)();
  const actor = await manager(auth, db, 'choose what shows on the bar menu');
  const ids = data && Array.isArray(data.ids) ? Array.from(new Set(data.ids.filter((x) => typeof x === 'string'))) : null;
  if (!ids || !ids.length) throw new SyncError('invalid-argument', 'Pick at least one drink.');
  if (ids.length > 300) throw new SyncError('invalid-argument', 'At most 300 drinks at a time.');
  if (typeof (data && data.on) !== 'boolean') throw new SyncError('invalid-argument', 'Say whether to add or remove them.');
  const on = data.on;
  const drinks = (await val(db, 'menu/drinks')) || {};
  const toast = (await val(db, 'menu/toastDrinks')) || {};
  const updates = {}; let changed = 0, unknown = 0, created = 0;
  for (const id of ids) {
    const hit = D.findToast(id, drinks, toast);
    if (!hit) { unknown++; continue; }
    if (hit.rec) {
      if ((hit.rec.available !== false) === on) continue;
      updates[`${hit.id}/available`] = on; updates[`${hit.id}/by`] = actor; updates[`${hit.id}/at`] = now; changed++;
    } else if (on) {
      const v = D.validateDrink({ name: D.cleanName(hit.t.name) });
      if (!v.ok) { unknown++; continue; }
      updates[v.drink.id] = Object.assign({}, v.drink, { by: actor, at: now }); changed++; created++;
    }
  }
  if (Object.keys(drinks).length + created > D.LIMITS.drinks) throw new SyncError('resource-exhausted', `The menu would pass ${D.LIMITS.drinks} drinks.`);
  if (!changed && unknown === ids.length) throw new SyncError('not-found', 'Those drinks are not in Toast right now.');
  if (changed) {
    await db.ref('menu/drinks').update(updates);
    await db.ref('audit-log').push(auditEntry(on ? 'menu_drinks_added' : 'menu_drinks_removed', `${changed} drink(s) ${on ? 'added to' : 'taken off'} the bar menu`, actor, now));
  }
  return { ok: true, changed, unknown };
}

/** data: { special, id? } id given = edit that special. */
async function saveSpecial(auth, data, deps) {
  const { db } = deps; const now = (deps.now || Date.now)();
  const actor = await manager(auth, db, 'edit specials');
  const drinks = (await val(db, 'menu/drinks')) || {};
  const toast = (await val(db, 'menu/toastDrinks')) || {};
  // A special can name a drink with details, or a Toast drink nobody has added details to yet (its id is its name's slug).
  const known = Object.keys(drinks).concat(Object.keys(toast).filter((k) => D.usableToast(toast[k])).map((k) => D.slug(D.cleanName(toast[k].name))));
  const v = D.validateSpecial(data && data.special, known);
  if (!v.ok) throw new SyncError('invalid-argument', v.errors.join(' '));
  const s = v.special; delete s.id;
  const all = (await val(db, 'menu/drinkSpecials')) || {};
  let id = data.id;
  if (id && (typeof id !== 'string' || !/^[A-Za-z0-9]{1,40}$/.test(id) || !Object.prototype.hasOwnProperty.call(all, id))) throw new SyncError('not-found', 'That special no longer exists.');
  const hit = D.findToast(s.drinkId, drinks, toast);
  if (!hit) throw new SyncError('failed-precondition', 'That drink is not in Toast right now, so it can not have a special.');
  const t = hit.t, shown = D.cleanName(t.name);
  if (s.kind === 'price') {
    if (!Number.isInteger(t.price)) throw new SyncError('invalid-argument', 'Price specials work on drinks with a single price. This one has sizes or no set price in Toast.');
    if (s.price >= t.price) throw new SyncError('invalid-argument', `A price special has to be under the Toast price (${D.money(t.price)}).`);
  }
  if (!id) {
    if (Object.keys(all).length >= D.LIMITS.specials) throw new SyncError('resource-exhausted', 'Too many specials. Remove ended ones first.');
    id = 's' + now.toString(36) + Math.random().toString(36).slice(2, 6);
  }
  s.by = actor; s.at = now;
  await db.ref(`menu/drinkSpecials/${id}`).set(s);
  const label = s.kind === 'price' ? `${shown} at ${D.money(s.price)} (display only; Toast ${D.money(t.price)})` : `${shown} limited-time`;
  await db.ref('audit-log').push(auditEntry(data.id ? 'drink_special_updated' : 'drink_special_created', `${label}, ${s.startDate} to ${s.endDate}`, actor, now));
  return { ok: true, id };
}

/** data: { id } */
async function removeSpecial(auth, data, deps) {
  const { db } = deps; const now = (deps.now || Date.now)();
  const actor = await manager(auth, db, 'remove specials');
  const id = data && data.id;
  const s = typeof id === 'string' && /^[A-Za-z0-9]{1,40}$/.test(id) ? await val(db, `menu/drinkSpecials/${id}`) : null;
  if (!s) throw new SyncError('not-found', 'That special no longer exists.');
  await db.ref(`menu/drinkSpecials/${id}`).set(null);
  await db.ref('audit-log').push(auditEntry('drink_special_removed', `${s.kind === 'price' ? 'Price special' : 'Limited-time'} on ${s.drinkId}`, actor, now));
  return { ok: true };
}

/** data: { date, items } the food specials for one business day (staff-only). */
async function saveNightly(auth, data, deps) {
  const { db } = deps; const now = (deps.now || Date.now)();
  const actor = await manager(auth, db, 'set nightly specials');
  const v = D.validateNightly(data);
  if (!v.ok) throw new SyncError('invalid-argument', v.errors.join(' '));
  const today = D.businessDay(now).date;
  if (v.nightly.date < today || v.nightly.date > D.addDays(today, 30)) throw new SyncError('invalid-argument', 'Pick a date from today to 30 days ahead.');
  const ref = db.ref(`menu/nightlySpecials/${v.nightly.date}`);
  if (!v.nightly.items.length) await ref.set(null);
  else await ref.set({ items: v.nightly.items, by: actor, at: now });
  // Tidy: nights more than 14 days gone.
  const all = (await val(db, 'menu/nightlySpecials')) || {};
  const cutoff = D.addDays(today, -14), old = {};
  Object.keys(all).forEach((d) => { if (d < cutoff) old[d] = null; });
  if (Object.keys(old).length) await db.ref('menu/nightlySpecials').update(old);
  // Saved specials used tonight remember the night (the list shows "last on").
  const lib = (await val(db, 'menu/specialsLibrary')) || {}, used = {};
  v.nightly.items.forEach((i) => { if (i.libId && lib[i.libId] && !(lib[i.libId].lastUsed >= v.nightly.date)) used[`${i.libId}/lastUsed`] = v.nightly.date; });
  if (Object.keys(used).length) await db.ref('menu/specialsLibrary').update(used);
  await db.ref('audit-log').push(auditEntry('nightly_specials_set', `${v.nightly.date}: ${v.nightly.items.length} item(s)`, actor, now));
  return { ok: true, count: v.nightly.items.length };
}

const nameKey = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** data: { id?, special } one food special on the saved list. Returns { ok, id }. */
async function saveLibrarySpecial(auth, data, deps) {
  const { db } = deps; const now = (deps.now || Date.now)();
  const actor = await manager(auth, db, 'save specials');
  const v = D.validateLibrarySpecial(data && data.special);
  if (!v.ok) throw new SyncError('invalid-argument', v.errors.join(' '));
  const all = (await val(db, 'menu/specialsLibrary')) || {};
  let id = data.id;
  if (id && (typeof id !== 'string' || !D.LIB_ID.test(id) || !Object.prototype.hasOwnProperty.call(all, id))) throw new SyncError('not-found', 'That special is no longer on the list.');
  const clash = Object.keys(all).find((k) => k !== id && nameKey(all[k].name) === nameKey(v.special.name));
  if (clash) throw new SyncError('already-exists', `"${all[clash].name}" is already on the list. Edit that one instead.`);
  if (!id) {
    if (Object.keys(all).length >= D.LIMITS.library) throw new SyncError('resource-exhausted', 'The list is full. Delete specials you no longer make first.');
    id = 'f' + now.toString(36) + Math.random().toString(36).slice(2, 6);
  }
  const rec = Object.assign({}, v.special, { by: actor, at: now });
  if (data.id && all[id].lastUsed) rec.lastUsed = all[id].lastUsed;
  await db.ref(`menu/specialsLibrary/${id}`).set(rec);
  await db.ref('audit-log').push(auditEntry(data.id ? 'food_special_updated' : 'food_special_created', rec.name, actor, now));
  return { ok: true, id };
}

/** data: { id } takes a special off the saved list. Nights already saved keep their copy. */
async function removeLibrarySpecial(auth, data, deps) {
  const { db } = deps; const now = (deps.now || Date.now)();
  const actor = await manager(auth, db, 'delete specials');
  const id = data && data.id;
  const s = typeof id === 'string' && D.LIB_ID.test(id) ? await val(db, `menu/specialsLibrary/${id}`) : null;
  if (!s) throw new SyncError('not-found', 'That special is no longer on the list.');
  await db.ref(`menu/specialsLibrary/${id}`).set(null);
  await db.ref('audit-log').push(auditEntry('food_special_deleted', s.name, actor, now));
  return { ok: true };
}

const crypto = require('crypto');
const MAX_PHOTO_BYTES = 1500000;
function imageKind(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ['image/jpeg', 'jpg'];
  if (buf.length > 12 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ['image/png', 'png'];
  if (buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return ['image/webp', 'webp'];
  return null;
}
/** data: { data: base64 image }. Returns { ok, url }. deps.files: the Storage bucket. */
async function uploadDrinkPhoto(auth, data, deps) {
  const { db, files, bucket } = deps; const now = (deps.now || Date.now)();
  const actor = await manager(auth, db, 'upload drink photos');
  const b64 = data && typeof data.data === 'string' ? data.data.replace(/^data:[^,]*,/, '') : '';
  if (!b64 || b64.length > MAX_PHOTO_BYTES * 1.4 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new SyncError('invalid-argument', 'That picture is too large or not a picture. Try a smaller one.');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > MAX_PHOTO_BYTES) throw new SyncError('invalid-argument', 'That picture is too large. Try a smaller one.');
  const kind = imageKind(buf);
  if (!kind) throw new SyncError('invalid-argument', 'Photos must be JPEG, PNG or WebP pictures.');
  const name = `drinks/${now.toString(36)}-${crypto.randomBytes(6).toString('hex')}.${kind[1]}`;
  const token = crypto.randomUUID();
  await files.file(name).save(buf, { contentType: kind[0], resumable: false, metadata: { cacheControl: 'public, max-age=31536000', metadata: { firebaseStorageDownloadTokens: token } } });
  await db.ref('audit-log').push(auditEntry('drink_photo_uploaded', `${name} (${Math.round(buf.length / 1024)} KB)`, actor, now));
  return { ok: true, url: `${STORAGE_PREFIX(bucket)}${encodeURIComponent(name)}?alt=media&token=${token}` };
}

module.exports = { uploadDrinkPhoto, saveDrink, removeDrink, setOnMenu, importDrinks, saveSpecial, removeSpecial, saveNightly, saveLibrarySpecial, removeLibrarySpecial };
