/**
 * Drinks and Specials tabs on the employee page (managers and above).
 * Builds its own screens inside #tab-drinks and #tab-specials. Toast is the
 * source of truth for a drink's name, price, section and 86 status (the
 * Toast sync writes menu/toastDrinks). A manager adds only the extras
 * (description, photo, tags, allergens); a drink shows on the bar menu when
 * its name matches a Toast drink. Reads the
 * database live (staff can read menu/drinks even before the bar menu is
 * public) and writes only through the Cloud Functions in cloud/drinks-lib.js,
 * which re-check the rank and re-validate everything. Logic (validation,
 * import, schedules) is src/drinks-core.js and src/drinks-xlsx.js.
 */
window.hsDrinksAdmin = (function () {
  'use strict';
  var D = window.HS_DRINKS, X = window.HS_XLSX;
  var drinks = {}, specials = {}, nightly = {}, toast = {}, isPublic = false;
  var refs = [], started = false, built = false, manager = false;
  var fns = null;

  // ── small helpers ──
  function make(tag, attrs, text) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (typeof attrs[k] === 'boolean') { if (attrs[k]) n.setAttribute(k, ''); }
      else n.setAttribute(k, attrs[k]);
    });
    if (text != null) n.textContent = text;
    return n;
  }
  function kids(parent, list) { list.forEach(function (c) { if (c) parent.appendChild(c); }); return parent; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }

  function call(name, data) {
    if (!fns) fns = firebase.app().functions('us-east1');
    return fns.httpsCallable(name)(data).then(function (r) { return { ok: true, data: r.data }; },
      function (e) { return { ok: false, error: (e && e.message) || 'Not saved. Try again.' }; });
  }
  function note(node, text, kind) {
    node.textContent = text || '';
    node.className = 'cat-note' + (kind ? ' ' + kind : '');
    node.hidden = !text;
    if (text && kind !== 'ok') node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  var uid = 0;
  function field(label, input, opts) {
    opts = opts || {};
    var w = make('div', { class: 'cat-field' + (opts.long ? ' long' : '') });
    input.id = 'dx-f' + (++uid);
    w.appendChild(make('label', { for: input.id }, label));
    w.appendChild(input);
    if (opts.hint) w.appendChild(make('div', { class: 'hint' }, opts.hint));
    return w;
  }
  function group(label, node) {
    var fs = make('fieldset', { class: 'cat-field long dx-set' });
    if (label) fs.appendChild(make('legend', {}, label));
    fs.appendChild(node); return fs;
  }
  function checkGroup(options, selected, label) {
    var wrap = make('div', { class: 'dx-checks', role: 'group', 'aria-label': label });
    var boxes = options.map(function (o) {
      var cb = make('input', { type: 'checkbox', value: o });
      cb.checked = selected.indexOf(o) >= 0;
      var l = make('label', { class: 'dx-check' }); l.appendChild(cb); l.appendChild(document.createTextNode(' ' + o));
      wrap.appendChild(l);
      return cb;
    });
    return { node: wrap, values: function () { return boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; }); } };
  }
  function armed(btn, label, action) { // two taps to confirm
    var t = null;
    btn.textContent = label;
    btn.addEventListener('click', function () {
      if (t) { clearTimeout(t); t = null; btn.textContent = label; btn.classList.remove('danger'); action(); return; }
      btn.textContent = 'Tap again to confirm'; btn.classList.add('danger');
      t = setTimeout(function () { t = null; btn.textContent = label; btn.classList.remove('danger'); }, 4000);
    });
    return btn;
  }
  function button(label, cls, fn) { var b = make('button', { type: 'button', class: 'save-btn' + (cls ? ' ' + cls : '') }, label); if (fn) b.addEventListener('click', fn); return b; }
  function priceText(cents) { return cents == null ? '' : (cents / 100).toFixed(2); }
  /** "$7", "6 oz $8 · Bottle $30", or "no set price". */
  function toastPrice(t) {
    if (!t) return '';
    if (t.sizes && t.sizes.length) return t.sizes.map(function (z) { return z.name + ' ' + D.money(z.price); }).join(' · ');
    return Number.isInteger(t.price) ? D.money(t.price) : 'no set price';
  }
  function today() { return D.businessDay(Date.now()).date; }
  function niceDate(iso) {
    var p = iso.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  // ── photos: shrink in the browser, upload through the server ──
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var s = Math.min(1, 1000 / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
        var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error('That picture could not be read.')); }, 'image/jpeg', 0.82);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('This browser can not open that file as a picture. Try a JPEG or PNG.')); };
      img.src = url;
    });
  }
  function toBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1]); };
      r.onerror = function () { reject(new Error('That picture could not be read.')); };
      r.readAsDataURL(blob);
    });
  }
  function photoField(initial) {
    var url = initial || '', busy = false;
    var preview = make('img', { class: 'dx-thumb', alt: '', width: '88', height: '88' });
    var status = make('div', { class: 'hint', role: 'status' });
    var input = make('input', { type: 'file', accept: 'image/*', 'aria-label': 'Choose a photo' });
    var remove = button('Remove photo', 'secondary', function () { url = ''; status.textContent = ''; draw(); });
    function draw() { preview.hidden = !url; remove.hidden = !url; if (url) preview.src = url; }
    input.addEventListener('change', function () {
      var f = input.files && input.files[0]; if (!f) return;
      busy = true; status.textContent = 'Uploading…'; status.className = 'hint';
      shrink(f).then(toBase64).then(function (b64) { return call('uploadDrinkPhoto', { data: b64 }); }).then(function (r) {
        if (!r.ok) throw new Error(r.error);
        url = r.data.url; status.textContent = 'Photo ready. Save to keep it.'; draw();
      }).catch(function (e) { status.textContent = e.message; status.className = 'err'; })
        .then(function () { busy = false; input.value = ''; });
    });
    var wrap = make('div', { class: 'cat-field long' });
    kids(wrap, [make('label', {}, 'Photo (optional)'),
      kids(make('div', { class: 'dx-photo-row' }), [preview, kids(make('div', { class: 'dx-photo-ctl' }), [input, remove])]), status]);
    draw();
    return { node: wrap, url: function () { return url; }, busy: function () { return busy; } };
  }

  // ═══════════ DRINKS TAB ═══════════
  var dr = {};
  function buildDrinks() {
    var root = document.getElementById('tab-drinks');
    dr.status = make('div', { class: 'cat-note' });
    dr.banner = make('div', { class: 'cat-note', hidden: true, role: 'status' });
    dr.search = make('input', { type: 'text', placeholder: 'Search drinks…', 'aria-label': 'Search drinks' });
    dr.filter = make('select', { 'aria-label': 'Show which drinks' });
    FILTERS.forEach(function (o) { dr.filter.appendChild(make('option', { value: o[0] }, o[1])); });
    dr.form = make('form', { class: 'cat-form', hidden: true, novalidate: true });
    dr.importBox = make('div', { class: 'cat-form', hidden: true });
    dr.list = make('div', { class: 'cat-list' });
    kids(root, [
      make('div', { class: 'section-title' }, 'Drinks'), dr.status, dr.banner,
      kids(make('div', { class: 'cat-toolbar' }), [dr.search, make('span', { class: 'spacer' }),
        dr.filter, button('Download as CSV', 'secondary', function () { download('half-shell-drinks.csv', D.toCSV(csvRecords())); }),
        button('Import from file', 'secondary', openImport)]),
      dr.form, dr.importBox, dr.list,
    ]);
    dr.search.addEventListener('input', drawDrinks); dr.filter.addEventListener('change', drawDrinks);
  }
  function rows() { return D.listRows(drinks, toast); }
  function download(name, text) {
    var a = make('a', { href: URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' })), download: name });
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  /** Every Toast drink as a spreadsheet row (details filled in where they exist), ready to fill in and import. */
  function csvRecords() {
    return rows().filter(function (r) { return r.t; }).map(function (r) { return Object.assign({}, r.rec || {}, { id: r.id, name: r.name }); });
  }
  function drawStatus() {
    var rs = rows(), toastRows = rs.filter(function (r) { return r.t; }), synced = toastRows.length > 0;
    var n = function (st) { return rs.filter(function (r) { return r.status === st; }).length; };
    dr.status.className = 'cat-note ' + (!synced ? 'warn' : isPublic ? 'ok' : 'warn');
    dr.status.textContent = (isPublic
      ? 'The bar menu is live: guests can see it at bar.html. '
      : 'The bar menu is hidden from guests until the owners approve it. You can preview it at bar.html while signed in. ') +
      (synced
        ? 'Every drink in Toast shows here and on the menu on its own; names, prices, sections and 86s come from Toast. Add descriptions, photos and tags with Edit, or Hide what should not show. ' +
          n('live') + ' showing, ' + n('hidden') + ' hidden by you, ' + n('86') + ' 86’d in Toast' + (n('missing') ? ', ' + n('missing') + ' with a name Toast does not have.' : '.')
        : 'Toast’s drink list has not been copied over yet (it happens with the Toast sync: use Sync Toast on the Menu tab), so nothing can show yet.');
  }
  var FILTERS = [['all', 'All drinks'], ['plain', 'No details added yet'], ['hidden', 'Hidden by you'], ['86', '86’d in Toast'], ['missing', 'Not in Toast']];
  function drawDrinks() {
    drawStatus();
    var q = dr.search.value.trim().toLowerCase(), f = dr.filter.value;
    var list = rows().filter(function (r) {
      if (f === 'plain' && !(r.t && !r.rec)) return false;
      if (f === 'hidden' && r.status !== 'hidden') return false;
      if (f === '86' && r.status !== '86') return false;
      if (f === 'missing' && r.status !== 'missing') return false;
      return !q || (r.name + ' ' + (r.t ? r.t.group : '') + ' ' + ((r.rec && r.rec.description) || '')).toLowerCase().indexOf(q) >= 0;
    });
    clear(dr.list);
    if (!list.length) {
      dr.list.appendChild(make('div', { class: 'cat-empty' }, rows().length ? 'No drinks match.' : 'No drinks yet. They appear here after the Toast sync has run.'));
      return;
    }
    var last = null;
    list.forEach(function (r) {
      var sec = r.t ? r.t.group : 'Not in Toast';
      if (sec !== last) { last = sec; dr.list.appendChild(make('div', { class: 'dx-cat' }, sec)); }
      var rec = r.rec || {};
      var row = make('div', { class: 'cat-row dx-row' + (r.status === 'live' ? '' : ' off') });
      var thumb = rec.photo && D.validPhotoUrl(rec.photo) ? make('img', { class: 'dx-mini', src: rec.photo, alt: '', width: '40', height: '40', loading: 'lazy' }) : make('span', { class: 'dx-mini blank', 'aria-hidden': 'true' });
      var name = make('div', { class: 'dx-name' }); name.appendChild(make('strong', {}, r.name));
      name.appendChild(make('span', { class: 'cat-row-meta' }, ' ' + [r.t ? toastPrice(r.t) : '', rec.size].filter(Boolean).join(' · ')));
      var why = { live: '', hidden: 'hidden by you', '86': '86’d in Toast', missing: 'not in Toast: won’t show' }[r.status];
      if (why) name.appendChild(make('span', { class: 'dx-pill ' + (r.status === 'missing' ? 'ended' : 'idle') }, why));
      if (r.t && !r.rec) name.appendChild(make('span', { class: 'dx-pill' }, 'Toast info only'));
      var live = Object.keys(specials).some(function (k) { var s = specials[k]; return s.drinkId === r.id && D.specialStatus(s, Date.now()) === 'live'; });
      if (live) name.appendChild(make('span', { class: 'dx-pill live' }, 'special now'));
      var hidden = rec.available === false;
      var hide = button(hidden ? 'Show' : 'Hide', 'secondary', function () { quickSave(r, { available: hidden }); });
      hide.setAttribute('aria-label', (hidden ? 'Show on the bar menu: ' : 'Hide from the bar menu: ') + r.name);
      var kidsList = [thumb, name, hide, button('Edit', 'secondary', function () { openDrinkForm(r); })];
      if (r.rec) kidsList.push(armed(button('', 'secondary quiet'), r.t ? 'Clear details' : 'Remove', function () {
        call('removeDrink', { id: r.id }).then(function (res) { note(dr.banner, res.ok ? (r.t ? r.name + ': details cleared, back to Toast’s own info.' : r.name + ' removed.') + (res.data.endedSpecials ? ' Its specials ended too.' : '') : res.error, res.ok ? 'ok' : 'error'); });
      }));
      kids(row, kidsList);
      dr.list.appendChild(row);
    });
  }
  function quickSave(r, change) {
    var save = r.rec ? call('saveDrink', { drink: Object.assign({}, r.rec, { id: r.id }, change) })
      : call('saveDrink', { create: true, drink: Object.assign({ name: r.name }, change) });
    save.then(function (res) { note(dr.banner, res.ok ? r.name + (change.available === false ? ' is hidden from the bar menu.' : ' is showing on the bar menu.') : res.error, res.ok ? 'ok' : 'error'); });
  }

  function openDrinkForm(r) {
    var f = dr.form; clear(f); f.hidden = false; dr.importBox.hidden = true;
    var d = r.rec || { available: true, tags: [], allergens: [] }, linked = !!r.t;
    f.appendChild(make('h3', {}, 'Edit ' + r.name));
    var name = make('input', { type: 'text', maxlength: String(D.LIMITS.name), value: r.name, autocomplete: 'off' });
    if (linked) name.readOnly = true;
    var match = make('div', { class: 'hint', role: 'status' });
    var size = make('input', { type: 'text', maxlength: String(D.LIMITS.size), value: d.size || '', placeholder: '16oz, 5oz pour, glass…' });
    var abv = make('input', { type: 'text', inputmode: 'decimal', value: d.abv == null ? '' : String(d.abv), placeholder: 'optional' });
    var sort = make('input', { type: 'text', inputmode: 'numeric', value: d.sort == null ? '' : String(d.sort), placeholder: 'optional' });
    var desc = make('textarea', { maxlength: String(D.LIMITS.description) }); desc.value = d.description || '';
    var tags = checkGroup(D.TAGS, d.tags || [], 'Tags'), allergens = checkGroup(D.ALLERGENS, d.allergens || [], 'Allergens');
    var avail = make('input', { type: 'checkbox' }); avail.checked = d.available !== false;
    var photo = photoField(d.photo);
    var msg = make('div', { class: 'cat-note error', hidden: true, role: 'alert' });
    function showMatch() {
      var t = toast[D.toastKey(name.value)];
      match.className = 'hint' + (t ? '' : ' err');
      match.textContent = t ? 'From Toast: ' + t.group + ', ' + toastPrice(t) + (t.inStock === false ? ' (86’d there right now, so it is off the menu)' : '') + '. Name and price are Toast’s: change them in Toast.'
        : 'No drink in Toast has this name, so it will not show. Change the name to match Toast’s, or remove this entry.';
    }
    name.addEventListener('input', showMatch); showMatch();
    var grid = kids(make('div', { class: 'cat-form-grid' }), [kids(field(linked ? 'Drink (from Toast)' : 'Drink name', name), [match]), field('Size note', size, { hint: 'Optional, e.g. 16oz can. Toast’s sizes show on their own.' }),
      field('ABV %', abv), field('Order in its section', sort, { hint: 'Lower shows first. Blank = Toast’s order' }),
      field('Description', desc, { long: true, hint: 'Ingredients or a line about the drink' }),
      group('Tags', tags.node), group('Contains (allergens)', allergens.node), photo.node,
      group('', kids(make('label', { class: 'dx-check' }), [avail, document.createTextNode(' Show on the bar menu (untick to hide it without touching Toast)')]))]);
    var save = make('button', { type: 'submit', class: 'save-btn' }, 'Save');
    kids(f, [grid, msg, kids(make('div', { class: 'cat-form-foot' }), [save, button('Cancel', 'secondary', function () { f.hidden = true; })])]);
    f.onsubmit = function (e) {
      e.preventDefault();
      if (photo.busy()) { note(msg, 'Wait for the photo to finish uploading.', 'error'); return; }
      var v = D.validateDrink({ id: r.rec ? r.id : undefined, name: name.value, size: size.value, abv: abv.value, sort: sort.value,
        description: desc.value, tags: tags.values(), allergens: allergens.values(), available: avail.checked, photo: photo.url() || undefined });
      if (!v.ok) { note(msg, v.errors.join(' '), 'error'); return; }
      save.disabled = true; note(msg, 'Saving…', '');
      call('saveDrink', { drink: v.drink, create: !r.rec }).then(function (res) {
        save.disabled = false;
        if (!res.ok) { note(msg, res.error, 'error'); return; }
        f.hidden = true; note(dr.banner, r.name + ' saved.', 'ok');
        dr.banner.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    };
    desc.focus(); f.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ── import from csv / xlsx ──
  function openImport() {
    var b = clear(dr.importBox); b.hidden = false; dr.form.hidden = true;
    b.appendChild(make('h3', {}, 'Import drinks from a spreadsheet'));
    b.appendChild(make('p', { class: 'cat-confirm' }, 'Use an Excel (.xlsx) or CSV file with a Name column that matches Toast’s drink names. Optional: Size, Description, ABV, Tags, Allergens, Available. Price and category come from Toast, so those columns are ignored. Photos are added on each drink afterward.'));
    var file = make('input', { type: 'file', accept: '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'aria-label': 'Choose a spreadsheet' });
    var mode = 'merge', modeBox = make('div', { class: 'dx-checks', role: 'radiogroup', 'aria-label': 'Import mode' });
    [['merge', 'Add new drinks and update matching ones (keeps everything else)'], ['replace', 'Reset every drink not in this file to plain Toast info (details and photos cleared)']].forEach(function (m) {
      var r = make('input', { type: 'radio', name: 'dx-mode', value: m[0] }); r.checked = m[0] === 'merge';
      r.addEventListener('change', function () { mode = m[0]; draw(); });
      modeBox.appendChild(kids(make('label', { class: 'dx-check' }), [r, document.createTextNode(' ' + m[1])]));
    });
    var out = make('div', { class: 'dx-import-out', role: 'status' });
    var go = button('Import', '', onGo); go.disabled = true;
    var parsed = null, confirmReplace = false;
    kids(b, [kids(make('div', { class: 'cat-toolbar' }), [file, button('Download a blank template', 'secondary', function () { download('half-shell-drinks-template.csv', D.toCSV([])); })]),
      modeBox, out, kids(make('div', { class: 'cat-form-foot' }), [go, button('Close', 'secondary', function () { b.hidden = true; })])]);

    function draw() {
      clear(out); go.disabled = true; confirmReplace = false; go.textContent = 'Import'; go.classList.remove('danger');
      if (!parsed) return;
      if (parsed.error) { out.appendChild(make('div', { class: 'cat-note error' }, parsed.error)); return; }
      var r = parsed.result;
      if (r.fatal) { out.appendChild(make('div', { class: 'cat-note error' }, r.problems[0].errors[0])); return; }
      var diff = D.diffImport(drinks, r.drinks, mode, r.fields);
      var unmatched = r.drinks.filter(function (d) { return !toast[D.toastKey(d.name)]; });
      if (r.ignored && r.ignored.length) out.appendChild(make('div', { class: 'cat-note' }, 'Ignored (Toast owns these): ' + r.ignored.join(', ') + '.'));
      if (unmatched.length && Object.keys(toast).length) out.appendChild(make('div', { class: 'cat-note warn' }, unmatched.length + ' name' + (unmatched.length === 1 ? '' : 's') + ' not in Toast right now (they will not show until Toast has them): ' + unmatched.slice(0, 8).map(function (d) { return d.name; }).join(', ') + (unmatched.length > 8 ? '…' : '') + '.'));
      out.appendChild(make('div', { class: 'cat-note' + (r.problems.length ? ' warn' : ' ok') },
        r.drinks.length + ' drinks read: ' + diff.added.length + ' new, ' + diff.changed.length + ' changed, ' + diff.same.length + ' unchanged' +
        (mode === 'replace' ? ', ' + diff.removed.length + ' would be removed' : '') + '.'));
      if (r.problems.length) {
        var ul = make('ul', { class: 'dx-problems' });
        r.problems.slice(0, 12).forEach(function (p) { ul.appendChild(make('li', {}, 'Row ' + p.row + ': ' + p.errors.join(' '))); });
        if (r.problems.length > 12) ul.appendChild(make('li', {}, '…and ' + (r.problems.length - 12) + ' more.'));
        kids(out, [make('div', { class: 'cat-note error' }, 'Fix these rows in your file and choose it again. Nothing is imported until every row is good.'), ul]);
        return;
      }
      if (mode === 'replace' && diff.removed.length) {
        out.appendChild(make('div', { class: 'cat-note warn' }, 'Clearing details for: ' + diff.removed.slice(0, 15).map(function (id) { return drinks[id].name; }).join(', ') + (diff.removed.length > 15 ? '…' : '') + '. Their details and photos are cleared; the drinks still show from Toast.'));
      }
      var t = make('table', { class: 'dx-table' }), hr = make('tr');
      ['Name', 'In Toast?', 'Status'].forEach(function (h) { hr.appendChild(make('th', {}, h)); }); t.appendChild(hr);
      r.drinks.slice(0, 8).forEach(function (d) {
        var tr = make('tr'), st = diff.added.indexOf(d.id) >= 0 ? 'new' : diff.changed.indexOf(d.id) >= 0 ? 'changed' : 'same';
        [d.name, toast[D.toastKey(d.name)] ? 'yes' : 'not yet', st].forEach(function (c) { tr.appendChild(make('td', {}, c)); }); t.appendChild(tr);
      });
      out.appendChild(t);
      if (r.drinks.length > 8) out.appendChild(make('div', { class: 'hint' }, 'Showing 8 of ' + r.drinks.length + '.'));
      go.disabled = !diff.added.length && !diff.changed.length && !diff.removed.length;
      if (go.disabled) out.appendChild(make('div', { class: 'hint' }, 'This file matches the menu already. Nothing to import.'));
    }
    file.addEventListener('change', function () {
      var f = file.files && file.files[0]; parsed = null; draw(); if (!f) return;
      var done = function (rows) { parsed = { result: D.drinksFromRows(rows) }; draw(); };
      var fail = function (e) { parsed = { error: (e && e.message) || 'Could not read that file.' }; draw(); };
      if (/\.xlsx$/i.test(f.name)) f.arrayBuffer().then(X.readRows).then(done, fail);
      else if (/\.xls$/i.test(f.name)) fail(new Error('Older .xls files are not supported. In Excel choose Save As, then .xlsx or CSV.'));
      else if (f.size > 2 * 1024 * 1024) fail(new Error('That file is over 2 MB.'));
      else f.text().then(function (t) { done(D.parseCSV(t)); }, fail);
    });
    function onGo() {
      if (!parsed || !parsed.result) return;
      if (mode === 'replace' && !confirmReplace) { confirmReplace = true; go.textContent = 'Tap again: clear the other drinks'; go.classList.add('danger'); return; }
      go.disabled = true; go.textContent = 'Importing…';
      call('importDrinks', { mode: mode, confirm: mode === 'replace', fields: parsed.result.fields, drinks: parsed.result.drinks,
        expectedRemoved: mode === 'replace' ? D.diffImport(drinks, parsed.result.drinks, 'replace', parsed.result.fields).removed : undefined }).then(function (r) {
        go.classList.remove('danger');
        if (!r.ok) { go.disabled = false; go.textContent = 'Import'; out.appendChild(make('div', { class: 'cat-note error' }, r.error)); return; }
        b.hidden = true;
        note(dr.banner, 'Imported: ' + r.data.added + ' new, ' + r.data.changed + ' changed' + (r.data.removed ? ', ' + r.data.removed + ' removed' : '') + '.', 'ok');
      });
    }
    b.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ═══════════ SPECIALS TAB ═══════════
  var sp = {};
  function buildSpecials() {
    var root = document.getElementById('tab-specials');
    sp.banner = make('div', { class: 'cat-note', hidden: true, role: 'status' });
    sp.form = make('form', { class: 'cat-form', hidden: true, novalidate: true });
    sp.list = make('div', { class: 'cat-list' });
    sp.nbox = make('div', { class: 'cat-form' });
    kids(root, [
      make('div', { class: 'section-title' }, 'Drink specials'),
      make('p', { class: 'cat-confirm' }, 'Prices come from Toast. A price special shows a lower price on the bar menu for a while; it is display only, so set the matching discount in Toast too. A limited-time drink shows on the bar menu only while its special runs (it must already be in Toast).'),
      sp.banner,
      kids(make('div', { class: 'cat-toolbar' }), [make('span', { class: 'spacer' }), button('Add drink special', '', function () { openSpecialForm(null, null); })]),
      sp.form, sp.list,
      make('div', { class: 'section-title' }, 'Tonight’s food specials'),
      make('p', { class: 'cat-confirm' }, 'For the paper sheet only. Guests do not see these on the website. Add each special, tick the allergens, save, then print.'),
      sp.nbox,
    ]);
    buildNightly();
  }
  function describeSpecial(s) {
    var when = niceDate(s.startDate) + (s.endDate !== s.startDate ? ' – ' + niceDate(s.endDate) : '');
    var days = s.days && s.days.length ? ' · ' + s.days.map(function (d) { return d.charAt(0) + d.slice(1).toLowerCase(); }).join(', ') : '';
    var win = s.start && s.end ? ' · ' + D.clock(s.start) + '–' + D.clock(s.end) : '';
    return when + days + win;
  }
  function drawSpecials() {
    if (!sp.list) return;
    clear(sp.list);
    var now = Date.now(), rank = { live: 0, idle: 1, scheduled: 2, ended: 3 };
    var items = Object.keys(specials).map(function (id) { return Object.assign({ id: id, _st: D.specialStatus(specials[id], now) }, specials[id]); })
      .sort(function (a, b) { return rank[a._st] - rank[b._st] || a.startDate.localeCompare(b.startDate); });
    if (!items.length) { sp.list.appendChild(make('div', { class: 'cat-empty' }, 'No drink specials yet.')); return; }
    items.forEach(function (s) {
      var row = make('div', { class: 'cat-row dx-row' + (s._st === 'ended' ? ' off' : '') });
      var fx = D.findToast(s.drinkId, drinks, toast), t = fx && fx.t, nm = fx ? D.cleanName(fx.t.name) : (drinks[s.drinkId] ? drinks[s.drinkId].name : s.drinkId);
      var title = s.kind === 'price' ? nm + ' at ' + D.money(s.price) + (t && Number.isInteger(t.price) ? ' (Toast ' + D.money(t.price) + ')' : '') : nm + ' · limited-time';
      var label = { live: 'live now', idle: 'between times', scheduled: 'scheduled', ended: 'ended' }[s._st];
      var name = kids(make('div', { class: 'dx-name' }), [make('strong', {}, title), make('span', { class: 'dx-pill ' + s._st }, label),
        make('div', { class: 'cat-row-meta' }, describeSpecial(s) + (s.note ? ' · ' + s.note : ''))]);
      kids(row, [name, button('Edit', 'secondary', function () { openSpecialForm(s.id, s); }),
        armed(button('', 'secondary'), s._st === 'ended' ? 'Remove' : 'End and remove', function () {
          call('removeSpecial', { id: s.id }).then(function (r) { note(sp.banner, r.ok ? 'Special removed.' : r.error, r.ok ? 'ok' : 'error'); });
        })]);
      sp.list.appendChild(row);
    });
  }
  function openSpecialForm(id, s) {
    var f = clear(sp.form); f.hidden = false;
    var isNew = !id;
    s = s || { kind: 'price', days: [], startDate: today(), endDate: D.addDays(today(), 7) };
    f.appendChild(make('h3', {}, isNew ? 'Add a drink special' : 'Edit special'));
    var kind = make('select', {});
    [['price', 'Price special on a drink'], ['limited', 'Limited-time drink (shows only while this runs)']].forEach(function (o) {
      var op = make('option', { value: o[0] }, o[1]); if (o[0] === s.kind) op.selected = true; kind.appendChild(op);
    });
    if (!isNew) kind.disabled = true;
    var drinkSel = make('select', {}); drinkSel.appendChild(make('option', { value: '' }, 'Choose a drink…'));
    D.listRows(drinks, toast).forEach(function (r) {
      if (!r.t) return; // only drinks Toast has
      var op = make('option', { value: r.id }, r.name + ' (' + toastPrice(r.t) + ')'); if (r.id === s.drinkId) op.selected = true; drinkSel.appendChild(op);
    });
    var price = make('input', { type: 'text', inputmode: 'decimal', value: priceText(s.kind === 'price' ? s.price : null), placeholder: '8.00' });
    var start = make('input', { type: 'date', value: s.startDate }), end = make('input', { type: 'date', value: s.endDate });
    var cap = function (d) { return d.charAt(0) + d.slice(1).toLowerCase(); };
    var days = checkGroup(D.DAYS.map(cap), (s.days || []).map(cap), 'Days');
    var tStart = make('input', { type: 'time', value: s.start || '' }), tEnd = make('input', { type: 'time', value: s.end || '' });
    var snote = make('input', { type: 'text', maxlength: String(D.LIMITS.note), value: s.note || '', placeholder: 'e.g. Through Thanksgiving' });
    var preview = make('div', { class: 'cat-note', role: 'status' }), msg = make('div', { class: 'cat-note error', hidden: true, role: 'alert' });
    var priceField = field('Special price ($)', price, { hint: 'Must be under the Toast price. Display only: ring it in Toast too.' });
    var grid = kids(make('div', { class: 'cat-form-grid' }), [field('Type', kind, { long: true }), field('Drink', drinkSel, { hint: 'Every drink that is in Toast.' }), priceField,
      field('Starts', start), field('Ends (last day)', end), group('Days (none ticked = every day)', days.node),
      field('From time (optional)', tStart, { hint: 'Leave both times blank for all day' }), field('Until time', tEnd, { hint: 'After midnight is fine: 10pm to 2am' }),
      field('Note for guests (optional)', snote, { long: true })]);
    function build() {
      var raw = { kind: kind.value, drinkId: drinkSel.value, startDate: start.value, endDate: end.value, days: days.values().map(function (x) { return x.toUpperCase(); }), start: tStart.value, end: tEnd.value, note: snote.value };
      if (kind.value === 'price') raw.priceText = price.value;
      var known = D.listRows(drinks, toast).filter(function (r) { return r.t; }).map(function (r) { return r.id; });
      var v = D.validateSpecial(raw, known);
      var fx = v.ok && D.findToast(v.special.drinkId, drinks, toast), t = fx && fx.t;
      if (v.ok && !t) { v.ok = false; v.errors = ['That drink is not in Toast right now.']; }
      else if (v.ok && v.special.kind === 'price' && !Number.isInteger(t.price)) { v.ok = false; v.errors = ['Price specials need a drink with a single Toast price (this one has sizes).']; }
      else if (v.ok && v.special.kind === 'price' && v.special.price >= t.price) { v.ok = false; v.errors = ['A price special has to be under the Toast price (' + D.money(t.price) + ').']; }
      v.raw = raw; return v;
    }
    function sync() {
      priceField.hidden = kind.value === 'limited';
      var v = build();
      if (v.ok) {
        var t = v.special;
        preview.className = 'cat-note ok';
        var fx = D.findToast(t.drinkId, drinks, toast), tn = fx ? D.cleanName(fx.t.name) : t.drinkId;
        preview.textContent = (t.kind === 'price' ? tn + ' ' + D.money(fx && fx.t.price) + ' → ' + D.money(t.price) : tn + ' shows only during this special') + '. ' + describeSpecial(t) + '.';
      } else { preview.className = 'cat-note'; preview.textContent = v.errors[0]; }
    }
    f.oninput = f.onchange = sync;
    var save = make('button', { type: 'submit', class: 'save-btn' }, 'Save special');
    kids(f, [grid, preview, msg, kids(make('div', { class: 'cat-form-foot' }), [save, button('Cancel', 'secondary', function () { f.hidden = true; })])]);
    f.onsubmit = function (e) {
      e.preventDefault();
      var v = build(); if (!v.ok) { note(msg, v.errors.join(' '), 'error'); return; }
      save.disabled = true; note(msg, 'Saving…', '');
      call('saveSpecial', { id: id || undefined, special: v.raw }).then(function (r) {
        save.disabled = false;
        if (!r.ok) { note(msg, r.error, 'error'); return; }
        f.hidden = true; note(sp.banner, 'Special saved.', 'ok');
      });
    };
    sync(); f.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ── tonight's food specials + the paper sheet ──
  var nd = { date: null, items: [], dirty: false };
  function blankItem() { return { name: '', ingredients: '', description: '', allergens: [], price: '' }; }
  function fromSaved(i) { return { name: i.name, ingredients: i.ingredients || '', description: i.description || '', allergens: (i.allergens || []).slice(), price: i.price == null ? '' : priceText(i.price) }; }
  function buildNightly() {
    nd.date = today();
    nd.dateEl = make('input', { type: 'date', value: nd.date, min: today(), max: D.addDays(today(), 30) });
    nd.copyEl = make('select', {});
    nd.rows = make('div', { class: 'dx-items' });
    nd.msg = make('div', { class: 'cat-note', hidden: true, role: 'status' });
    nd.save = button('Save', '', saveNight);
    nd.dateEl.addEventListener('change', function () { if (D.isDate(nd.dateEl.value)) { nd.date = nd.dateEl.value; nd.dirty = false; loadNight(); } });
    nd.copyEl.addEventListener('change', function () {
      var src = nightly[nd.copyEl.value]; if (!src) return;
      nd.items = src.items.map(fromSaved); nd.dirty = true; drawNightly();
    });
    kids(sp.nbox, [kids(make('div', { class: 'cat-toolbar' }), [field('Night', nd.dateEl), field('Copy from another night', nd.copyEl)]), nd.rows, nd.msg,
      kids(make('div', { class: 'cat-form-foot' }), [button('Add a special', 'secondary', function () {
        if (nd.items.length < D.LIMITS.nightlyItems) { nd.items.push(blankItem()); nd.dirty = true; drawNightly(); }
      }), make('span', { class: 'spacer' }), button('Print the sheet', 'secondary', printSheet), nd.save])]);
    loadNight();
  }
  function loadNight() {
    var saved = nightly[nd.date];
    nd.items = saved ? saved.items.map(fromSaved) : [];
    if (!nd.items.length) nd.items.push(blankItem());
    drawNightly();
  }
  function drawNightlyCopy() {
    clear(nd.copyEl); nd.copyEl.appendChild(make('option', { value: '' }, 'Choose a night…'));
    Object.keys(nightly).sort().reverse().forEach(function (d) { if (d !== nd.date) nd.copyEl.appendChild(make('option', { value: d }, niceDate(d) + ' (' + nightly[d].items.length + ')')); });
  }
  function drawNightly() {
    if (!nd.rows) return;
    drawNightlyCopy(); clear(nd.rows);
    nd.items.forEach(function (it, i) {
      var name = make('input', { type: 'text', maxlength: String(D.LIMITS.name), value: it.name, placeholder: 'Name of the special' });
      var price = make('input', { type: 'text', inputmode: 'decimal', value: it.price, placeholder: '0.00' });
      var ing = make('input', { type: 'text', maxlength: String(D.LIMITS.ingredients), value: it.ingredients, placeholder: 'crab, cream, sherry…' });
      var desc = make('textarea', { maxlength: String(D.LIMITS.description) }); desc.value = it.description;
      var all = checkGroup(D.ALLERGENS, it.allergens, 'Allergens');
      var set = function (k, el) { el.addEventListener('input', function () { it[k] = el.value; nd.dirty = true; }); };
      set('name', name); set('price', price); set('ingredients', ing); set('description', desc);
      all.node.addEventListener('change', function () { it.allergens = all.values(); nd.dirty = true; });
      var grid = kids(make('div', { class: 'cat-form-grid' }), [field('Name', name), field('Price ($, optional)', price), field('Ingredients', ing, { long: true }),
        field('Description', desc, { long: true }), group('Contains (allergens)', all.node)]);
      nd.rows.appendChild(kids(make('div', { class: 'dx-item' }), [grid, kids(make('div', { class: 'cat-form-foot' }), [
        button('Remove', 'secondary', function () { nd.items.splice(i, 1); if (!nd.items.length) nd.items.push(blankItem()); nd.dirty = true; drawNightly(); })])]));
    });
  }
  function nightPayload() { return { date: nd.date, items: nd.items.filter(function (i) { return i.name.trim() || i.ingredients.trim() || i.description.trim(); }) }; }
  function saveNight() {
    var v = D.validateNightly(nightPayload());
    if (!v.ok) { note(nd.msg, v.errors.join(' '), 'error'); return; }
    nd.save.disabled = true; note(nd.msg, 'Saving…', '');
    call('saveNightly', v.nightly).then(function (r) {
      nd.save.disabled = false;
      if (r.ok) nd.dirty = false;
      note(nd.msg, r.ok ? (r.data.count ? 'Saved ' + r.data.count + (r.data.count === 1 ? ' special' : ' specials') + ' for ' + niceDate(nd.date) + '.' : 'Cleared the specials for ' + niceDate(nd.date) + '.') : r.error, r.ok ? 'ok' : 'error');
    });
  }
  function printSheet() {
    var v = D.validateNightly(nightPayload());
    if (!v.ok) { note(nd.msg, v.errors.join(' '), 'error'); return; }
    if (!v.nightly.items.length) { note(nd.msg, 'Add at least one special to print.', 'error'); return; }
    var old = document.getElementById('dx-print'); if (old) old.remove();
    var sheet = make('div', { id: 'dx-print' });
    kids(sheet, [make('img', { src: 'assets/logo.png', alt: '', class: 'dx-print-logo' }), make('h1', {}, 'Specials'),
      make('div', { class: 'dx-print-date' }, new Date(nd.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }))]);
    v.nightly.items.forEach(function (i) {
      var row = make('div', { class: 'dx-print-item' }), top = make('div', { class: 'dx-print-top' });
      top.appendChild(make('span', { class: 'dx-print-name' }, i.name));
      if (i.price != null) top.appendChild(make('span', { class: 'dx-print-price' }, D.money(i.price)));
      row.appendChild(top);
      if (i.ingredients) row.appendChild(make('div', { class: 'dx-print-ing' }, i.ingredients));
      if (i.description) row.appendChild(make('div', { class: 'dx-print-desc' }, i.description));
      if (i.allergens.length) row.appendChild(make('div', { class: 'dx-print-all' }, 'Contains: ' + i.allergens.join(', ')));
      sheet.appendChild(row);
    });
    sheet.appendChild(make('p', { class: 'dx-print-fine' }, 'Consumer advisory: eating raw or undercooked oysters, clams or mussels may cause severe illness. Please tell your server about any allergy before you order.'));
    document.body.appendChild(sheet);
    document.body.classList.add('dx-printing');
    var after = function () { document.body.classList.remove('dx-printing'); sheet.remove(); window.removeEventListener('afterprint', after); };
    window.addEventListener('afterprint', after);
    setTimeout(function () { window.print(); }, 50);
  }

  // ═══════════ wiring ═══════════
  function start() {
    if (started) return; started = true;
    var db = firebase.database();
    function watch(path, fn) { var r = db.ref(path); r.on('value', function (s) { fn(s.val()); }, function () {}); refs.push(r); }
    watch('config/drinksPublic', function (v) { isPublic = v === true; if (built) drawStatus(); });
    watch('menu/drinks', function (v) { drinks = v || {}; if (built) { drawDrinks(); drawSpecials(); } });
    watch('menu/toastDrinks', function (v) { toast = v || {}; if (built) { drawDrinks(); drawSpecials(); } });
    watch('menu/drinkSpecials', function (v) { specials = v || {}; if (built) { drawSpecials(); drawDrinks(); } });
    watch('menu/nightlySpecials', function (v) {
      nightly = v || {};
      if (built && nd.rows) { if (nd.dirty) drawNightlyCopy(); else loadNight(); }
    });
    setInterval(function () { if (built && manager) drawSpecials(); }, 60000);
  }
  function stop() { refs.forEach(function (r) { r.off(); }); refs = []; started = false; drinks = {}; specials = {}; nightly = {}; toast = {}; }
  function buildAll() { if (built) return; built = true; buildDrinks(); buildSpecials(); drawDrinks(); drawSpecials(); }
  return {
    signedIn: function (claims) {
      manager = !!(claims && window.HS_CATALOG && window.HS_CATALOG.isManager(claims));
      if (manager) { start(); buildAll(); } else stop();
    },
    signedOut: function () { manager = false; stop(); },
  };
})();
