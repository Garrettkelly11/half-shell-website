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
 * import, schedules) is src/drinks-core.js and src/drinks-xlsx.js; the
 * specials PDF is src/specials-pdf.js.
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
  var dr = { sel: {} };
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
    return rows().filter(function (r) { return r.t; }).map(function (r) { return Object.assign({}, r.rec || {}, { id: r.id, name: r.name, available: !!(r.rec && r.rec.available !== false) }); });
  }
  function drawStatus() {
    var rs = rows(), toastRows = rs.filter(function (r) { return r.t; }), synced = toastRows.length > 0;
    var n = function (st) { return rs.filter(function (r) { return r.status === st; }).length; };
    dr.status.className = 'cat-note ' + (!synced ? 'warn' : isPublic ? 'ok' : 'warn');
    dr.status.textContent = (isPublic
      ? 'The bar menu is live: guests can see it at bar.html. '
      : 'The bar menu is hidden from guests until the owners approve it. You can preview it at bar.html while signed in. ') +
      (synced
        ? 'Toast’s whole drink list is here. Tick the drinks that belong on the bar menu and press Add to menu (names, prices, sections and 86s always come from Toast). ' +
          (n('live') + n('86')) + ' on the menu (' + n('86') + ' of them 86’d in Toast right now), ' + n('off') + ' not on the menu' + (n('missing') ? ', ' + n('missing') + ' with a name Toast does not have.' : '.')
        : 'Toast’s drink list has not been copied over yet (it happens with the Toast sync: use Sync Toast on the Menu tab), so nothing can show yet.');
  }
  var FILTERS = [['all', 'All Toast drinks'], ['on', 'On the bar menu'], ['off', 'Not on the menu'], ['86', '86’d in Toast'], ['missing', 'Not in Toast']];
  function drawDrinks() {
    drawStatus();
    var q = dr.search.value.trim().toLowerCase(), f = dr.filter.value;
    var list = rows().filter(function (r) {
      if (f === 'on' && !(r.status === 'live' || r.status === '86')) return false;
      if (f === 'off' && r.status !== 'off') return false;
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
    var bySection = {}; list.forEach(function (r) { if (r.t) (bySection[r.t.group] = bySection[r.t.group] || []).push(r); });
    var picked = Object.keys(dr.sel);
    if (picked.length) {
      var ids = function () { return Object.keys(dr.sel); };
      dr.list.appendChild(kids(make('div', { class: 'dx-bulk', role: 'region', 'aria-label': 'Selected drinks' }), [make('strong', {}, picked.length + ' selected'),
        button('Add to menu', '', function () { setOnMenu(ids(), true); }), button('Take off menu', 'secondary', function () { setOnMenu(ids(), false); }),
        button('Clear selection', 'secondary quiet', function () { dr.sel = {}; drawDrinks(); })]));
    }
    list.forEach(function (r) {
      var sec = r.t ? r.t.group : 'Not in Toast';
      if (sec !== last) {
        last = sec;
        var head = make('div', { class: 'dx-cat' }, sec);
        if (r.t) {
          var grp = bySection[sec], allIds = grp.map(function (x) { return x.id; });
          head.appendChild(button('Add all ' + grp.length, 'secondary quiet dx-sec-btn', function () { setOnMenu(allIds, true); }));
          head.appendChild(button('Take all off', 'secondary quiet dx-sec-btn', function () { setOnMenu(allIds, false); }));
        }
        dr.list.appendChild(head);
      }
      var rec = r.rec || {};
      var row = make('div', { class: 'cat-row dx-row' + (r.status === 'live' ? '' : ' off') });
      var pick = make('input', { type: 'checkbox', 'aria-label': 'Select ' + r.name }); pick.checked = !!dr.sel[r.id]; pick.hidden = !r.t;
      pick.addEventListener('change', function () { if (pick.checked) dr.sel[r.id] = true; else delete dr.sel[r.id]; drawDrinks(); });
      var thumb = rec.photo && D.validPhotoUrl(rec.photo) ? make('img', { class: 'dx-mini', src: rec.photo, alt: '', width: '40', height: '40', loading: 'lazy' }) : make('span', { class: 'dx-mini blank', 'aria-hidden': 'true' });
      var name = make('div', { class: 'dx-name' }); name.appendChild(make('strong', {}, r.name));
      name.appendChild(make('span', { class: 'cat-row-meta' }, ' ' + [r.t ? toastPrice(r.t) : '', rec.size].filter(Boolean).join(' · ')));
      var why = { live: '', off: '', '86': 'on the menu, but 86’d in Toast', missing: 'not in Toast: won’t show' }[r.status];
      if (why) name.appendChild(make('span', { class: 'dx-pill ' + (r.status === 'missing' ? 'ended' : 'idle') }, why));
      if (r.status === 'live') name.appendChild(make('span', { class: 'dx-pill live' }, 'on menu'));
      else if (r.t) name.appendChild(make('span', { class: 'dx-pill idle' }, 'not on menu'));
      var live = Object.keys(specials).some(function (k) { var s = specials[k]; return s.drinkId === r.id && D.specialStatus(s, Date.now()) === 'live'; });
      if (live) name.appendChild(make('span', { class: 'dx-pill live' }, 'special now'));
      var onMenu = r.status === 'live' || r.status === '86';
      var kidsList = [pick, thumb, name];
      if (r.t) {
        var tog = button(onMenu ? 'Take off menu' : 'Add to menu', onMenu ? 'secondary' : '', function () { setOnMenu([r.id], !onMenu); });
        tog.setAttribute('aria-label', (onMenu ? 'Take off the bar menu: ' : 'Add to the bar menu: ') + r.name);
        kidsList.push(tog);
      }
      kidsList.push(button('Edit', 'secondary', function () { openDrinkForm(r); }));
      if (r.rec && !r.t) kidsList.push(armed(button('', 'secondary quiet'), 'Remove', function () {
        call('removeDrink', { id: r.id }).then(function (res) { note(dr.banner, res.ok ? r.name + ' removed.' + (res.data.endedSpecials ? ' Its specials ended too.' : '') : res.error, res.ok ? 'ok' : 'error'); });
      }));
      kids(row, kidsList);
      dr.list.appendChild(row);
    });
  }
  /** Add Toast drinks to the bar menu, or take them off (their details are kept). */
  function setOnMenu(ids, on) {
    call('setOnMenu', { ids: ids, on: on }).then(function (res) {
      if (!res.ok) { note(dr.banner, res.error, 'error'); return; }
      dr.sel = {};
      note(dr.banner, res.data.changed ? res.data.changed + ' drink' + (res.data.changed === 1 ? '' : 's') + (on ? ' added to the bar menu.' : ' taken off the bar menu.') : 'Nothing to change: they were already ' + (on ? 'on' : 'off') + ' the menu.', 'ok');
      drawDrinks();
    });
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
      group('', kids(make('label', { class: 'dx-check' }), [avail, document.createTextNode(' On the bar menu (untick to take it off without touching Toast)')]))]);
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
    [['merge', 'Add the drinks in the file to the menu and update their details (keeps everything else)'], ['replace', 'Make the file the whole menu: every other drink comes off (details and photos cleared)']].forEach(function (m) {
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
      if (r.unknownColumns && r.unknownColumns.length) out.appendChild(make('div', { class: 'cat-note warn' }, 'Columns not used (not recognised): ' + r.unknownColumns.join(', ') + '. Recognised: Name, Size, Description, ABV, Tags, Allergens, Available, Sort.'));
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
        out.appendChild(make('div', { class: 'cat-note warn' }, 'Clearing details for: ' + diff.removed.slice(0, 15).map(function (id) { return drinks[id].name; }).join(', ') + (diff.removed.length > 15 ? '…' : '') + '. They come off the bar menu and their details and photos are cleared.'));
      }
      if (mode === 'merge') out.appendChild(make('div', { class: 'hint' }, 'Every drink in the file is added to the menu unless its Available cell says no. Blank cells leave what is already there unchanged; only columns in your file are touched.'));
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
      else f.arrayBuffer().then(function (buf) {
        var t; // Excel's plain "CSV" is often Windows-1252, not UTF-8: fall back so accents (Crémant) survive
        try { t = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { t = new TextDecoder('windows-1252').decode(buf); }
        done(D.parseCSV(t));
      }, fail);
    });
    function onGo() {
      if (!parsed || !parsed.result) return;
      if (mode === 'replace' && !confirmReplace) { confirmReplace = true; go.textContent = 'Tap again: take the other drinks off'; go.classList.add('danger'); return; }
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
    buildFood(root);
    kids(root, [
      make('div', { class: 'section-title' }, 'Drink specials (bar menu)'),
      make('p', { class: 'cat-confirm' }, 'Prices come from Toast. A price special shows a lower price on the bar menu for a while; it is display only, so set the matching discount in Toast too. A limited-time drink shows on the bar menu only while its special runs (it must already be in Toast).'),
      sp.banner,
      kids(make('div', { class: 'cat-toolbar' }), [make('span', { class: 'spacer' }), button('Add drink special', '', function () { openSpecialForm(null, null); })]),
      sp.form, sp.list,
    ]);
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
        if (fx && t.kind === 'price' && !(fx.rec && fx.rec.available !== false)) preview.textContent += ' This drink is not on the bar menu yet, so the special will not show until you add it.';
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

  // ═══════════ FOOD SPECIALS: new special, tonight's list, saved list ═══════════
  // The saved list (menu/specialsLibrary) keeps every special a manager makes.
  // Tonight's list (menu/nightlySpecials/{date}) holds ordered copies; a copy
  // can differ from the saved one (tonight's price, say) and keeps libId.
  var lib = {};
  var nd = { date: null, items: [], dirty: false, edit: null, drag: null };
  function fromSaved(i) { return { name: i.name, ingredients: i.ingredients || '', description: i.description || '', allergens: (i.allergens || []).slice(), price: i.price == null ? null : i.price, libId: i.libId || null }; }
  function fromLib(id) { var r = fromSaved(lib[id]); r.libId = id; return r; }
  function libRows() { return Object.keys(lib).map(function (id) { return Object.assign({ id: id }, lib[id]); }).sort(function (a, b) { return a.name.localeCompare(b.name); }); }
  function onTonight(id) { return nd.items.some(function (i) { return i.libId === id; }); }
  function itemMeta(i) {
    var bits = [];
    if (i.ingredients) bits.push(i.ingredients);
    if (i.price != null) bits.push(D.money(i.price));
    if (i.allergens && i.allergens.length) bits.push('Contains ' + i.allergens.join(', ').toLowerCase());
    return bits.join(' · ');
  }
  function markDirty() { nd.dirty = true; drawTonight(); drawLibrary(); }

  function buildFood(root) {
    // 1. Create (and edit) a special.
    nd.formTitle = make('div', { class: 'section-title' }, 'Create a new special');
    nd.form = make('form', { class: 'cat-form dx-food-form', novalidate: true });
    // 2. Tonight's list.
    nd.dateEl = make('input', { type: 'date', min: D.addDays(today(), 0), max: D.addDays(today(), 30) });
    nd.copyEl = make('select', {});
    nd.rows = make('ol', { class: 'cat-list dx-tonight', 'aria-label': 'Tonight’s specials, in menu order' });
    nd.msg = make('div', { class: 'cat-note', hidden: true, role: 'status' });
    nd.state = make('span', { class: 'dx-state' });
    nd.save = button('Save tonight’s list', '', function () { saveNight(); });
    nd.pdf = button('Export PDF menu', 'secondary', exportPdf);
    // 3. Saved list.
    nd.search = make('input', { type: 'search', placeholder: 'Find a special…', 'aria-label': 'Find a saved special' });
    nd.libMsg = make('div', { class: 'cat-note', hidden: true, role: 'status' });
    nd.lib = make('div', { class: 'cat-list' });

    nd.dateEl.addEventListener('change', function () {
      if (!D.isDate(nd.dateEl.value)) return;
      if (nd.dirty && !confirm('Tonight’s list has changes that are not saved. Switch nights and lose them?')) { nd.dateEl.value = nd.date; return; }
      nd.date = nd.dateEl.value; nd.dirty = false; loadNight();
    });
    nd.copyEl.addEventListener('change', function () {
      var src = nightly[nd.copyEl.value]; nd.copyEl.value = '';
      if (!src) return;
      nd.items = src.items.slice(0, D.LIMITS.nightlyItems).map(fromSaved); markDirty();
    });
    nd.search.addEventListener('input', drawLibrary);

    kids(root, [
      nd.formTitle,
      make('p', { class: 'cat-confirm' }, 'Food specials are for the paper menu only; guests never see them on the website. A new special is saved to your list so you can pick it again another night.'),
      nd.form,
      make('div', { class: 'section-title' }, 'Tonight’s specials'),
      make('p', { class: 'cat-confirm' }, 'This is the order they print in. Drag a row, or use the arrows, to move it. Save, then export the PDF: one Letter sheet with two menus side by side; cut down the middle.'),
      kids(make('div', { class: 'cat-toolbar' }), [field('Night', nd.dateEl), field('Copy another night’s list', nd.copyEl)]),
      nd.rows, nd.msg,
      kids(make('div', { class: 'cat-form-foot dx-tonight-foot' }), [nd.state, make('span', { class: 'spacer' }), nd.pdf, nd.save]),
      make('div', { class: 'section-title' }, 'All specials'),
      make('p', { class: 'cat-confirm' }, 'Every special you have saved. Add one to tonight, or edit it for next time.'),
      kids(make('div', { class: 'cat-toolbar' }), [nd.search]),
      nd.libMsg, nd.lib,
    ]);
    nd.date = today(); nd.dateEl.value = nd.date;
    openFoodForm(null);
    loadNight();
  }

  /**
   * The one form: mode 'new' (create, save to list), 'lib' (edit a saved
   * special) or 'night' (edit a row on tonight's list: index).
   */
  function openFoodForm(mode, ref) {
    var f = clear(nd.form);
    mode = mode || 'new';
    var src = mode === 'lib' ? fromLib(ref) : mode === 'night' ? nd.items[ref] : { name: '', ingredients: '', description: '', allergens: [], price: null };
    nd.edit = { mode: mode, ref: ref };
    nd.formTitle.textContent = { new: 'Create a new special', lib: 'Edit a saved special', night: 'Edit for tonight' }[mode];
    var name = make('input', { type: 'text', maxlength: String(D.LIMITS.name), value: src.name, placeholder: 'e.g. Crab dip' });
    var price = make('input', { type: 'text', inputmode: 'decimal', value: priceText(src.price), placeholder: 'e.g. 14' });
    var ing = make('input', { type: 'text', maxlength: String(D.LIMITS.ingredients), value: src.ingredients, placeholder: 'e.g. jumbo lump, sherry cream, Old Bay' });
    var desc = make('textarea', { maxlength: String(D.LIMITS.description), rows: '2', placeholder: 'Optional. Prints in italics under the name.' }); desc.value = src.description;
    var all = checkGroup(D.ALLERGENS, src.allergens, 'Allergens');
    var msg = make('div', { class: 'cat-note error', hidden: true, role: 'alert' });
    var alsoLib = null;
    var grid = kids(make('div', { class: 'cat-form-grid' }), [field('Name', name), field('Price ($, optional)', price, { hint: 'Prints as a bare number: 14, 14.5' }),
      field('Ingredients', ing, { long: true, hint: 'Comma separated. Prints in capitals after the name, as on the menu.' }),
      field('Description', desc, { long: true }), group('Contains (allergens)', all.node)]);
    f.appendChild(grid);
    if (mode === 'night' && src.libId && lib[src.libId]) {
      alsoLib = make('input', { type: 'checkbox' });
      var l = make('label', { class: 'dx-check' }); l.appendChild(alsoLib); l.appendChild(document.createTextNode(' Also update the saved special for next time'));
      f.appendChild(l);
    }
    function read() {
      return { name: name.value, price: price.value, ingredients: ing.value, description: desc.value, allergens: all.values() };
    }
    function check() {
      var v = D.validateLibrarySpecial(read());
      if (!v.ok) { note(msg, v.errors.join(' '), 'error'); name.focus(); return null; }
      return v.special;
    }
    function busy(on) { Array.prototype.forEach.call(f.querySelectorAll('button'), function (b) { b.disabled = on; }); }
    function saveLib(id, s, then) {
      busy(true); note(msg, 'Saving…', '');
      call('saveLibrarySpecial', { id: id || undefined, special: s }).then(function (r) {
        busy(false);
        if (!r.ok) { note(msg, r.error, 'error'); return; }
        note(msg, '', ''); then(r.data.id);
      });
    }
    function addTonight(item) {
      if (nd.items.length >= D.LIMITS.nightlyItems) { note(nd.msg, 'Tonight’s list is full (' + D.LIMITS.nightlyItems + ').', 'error'); return false; }
      nd.items.push(item); markDirty(); return true;
    }
    var foot = make('div', { class: 'cat-form-foot' });
    if (mode === 'new') {
      kids(foot, [
        button('Save to list', 'secondary', function () { var s = check(); if (s) saveLib(null, s, function () { note(nd.libMsg, '“' + s.name + '” saved to your list.', 'ok'); openFoodForm(null); }); }),
        button('Save and add to tonight', '', function () {
          var s = check(); if (!s) return;
          saveLib(null, s, function (id) {
            var it = fromSaved(s); it.libId = id;
            if (addTonight(it)) note(nd.msg, '“' + s.name + '” saved and added to tonight. Save tonight’s list when you are done.', 'ok');
            openFoodForm(null);
          });
        }),
      ]);
    } else if (mode === 'lib') {
      kids(foot, [
        button('Save changes', '', function () {
          var s = check(); if (!s) return;
          saveLib(ref, s, function () {
            // Tonight's unsaved copy follows the edit.
            var hit = false;
            nd.items.forEach(function (it, i) { if (it.libId === ref) { var n = fromSaved(s); n.libId = ref; nd.items[i] = n; hit = true; } });
            if (hit) markDirty();
            note(nd.libMsg, '“' + s.name + '” updated.' + (hit ? ' It is on tonight’s list too: save tonight’s list to keep the change there.' : ''), 'ok');
            openFoodForm(null);
          });
        }),
        button('Cancel', 'secondary', function () { openFoodForm(null); }),
      ]);
    } else {
      kids(foot, [
        button('Update tonight’s list', '', function () {
          var s = check(); if (!s) return;
          var it = fromSaved(s); it.libId = src.libId || null;
          if (alsoLib && alsoLib.checked) {
            saveLib(src.libId, s, function () { nd.items[ref] = it; markDirty(); openFoodForm(null); });
          } else { nd.items[ref] = it; markDirty(); openFoodForm(null); }
        }),
        button('Cancel', 'secondary', function () { openFoodForm(null); }),
      ]);
    }
    kids(f, [msg, foot]);
    f.onsubmit = function (e) { e.preventDefault(); };
    if (mode !== 'new') { f.scrollIntoView({ block: 'start', behavior: 'smooth' }); name.focus({ preventScroll: true }); }
  }

  function loadNight() {
    var saved = nightly[nd.date];
    nd.items = saved ? saved.items.map(fromSaved) : [];
    drawTonight(); drawLibrary();
  }
  function drawCopy() {
    clear(nd.copyEl); nd.copyEl.appendChild(make('option', { value: '' }, 'Choose a night…'));
    Object.keys(nightly).sort().reverse().forEach(function (d) { if (d !== nd.date) nd.copyEl.appendChild(make('option', { value: d }, niceDate(d) + ' (' + nightly[d].items.length + ')')); });
    nd.copyEl.disabled = nd.copyEl.options.length < 2;
  }
  function move(from, to) {
    if (to < 0 || to >= nd.items.length || from === to) return;
    var it = nd.items.splice(from, 1)[0]; nd.items.splice(to, 0, it); markDirty();
    var btns = nd.rows.children[to] && nd.rows.children[to].querySelectorAll('.dx-move');
    if (btns && btns.length) (to > from ? btns[1] : btns[0]).focus();
  }
  function drawTonight() {
    if (!nd.rows) return;
    drawCopy(); clear(nd.rows);
    var saved = nightly[nd.date];
    nd.state.textContent = nd.dirty ? 'Not saved yet' : saved ? 'Saved' + (saved.by ? ' by ' + saved.by : '') : '';
    nd.state.className = 'dx-state' + (nd.dirty ? ' dirty' : '');
    if (!nd.items.length) {
      nd.rows.appendChild(make('li', { class: 'cat-empty' }, 'Nothing on ' + (nd.date === today() ? 'tonight’s' : niceDate(nd.date) + '’s') + ' list yet. Add specials from your list below, or create a new one above.'));
      return;
    }
    nd.items.forEach(function (it, i) {
      var row = make('li', { class: 'cat-row dx-row dx-trow', draggable: 'true' });
      row.appendChild(make('span', { class: 'dx-grip', 'aria-hidden': 'true' }, '⠿'));
      row.appendChild(make('span', { class: 'dx-num' }, String(i + 1)));
      var name = kids(make('div', { class: 'dx-name' }), [make('strong', {}, it.name)]);
      if (!it.libId || !lib[it.libId]) name.appendChild(make('span', { class: 'dx-pill' }, 'not on your list'));
      var meta = itemMeta(it); if (meta) name.appendChild(make('div', { class: 'cat-row-meta' }, meta));
      if (it.description) name.appendChild(make('div', { class: 'cat-row-meta dx-desc' }, it.description));
      row.appendChild(name);
      var up = button('↑', 'secondary dx-move', function () { move(i, i - 1); }); up.setAttribute('aria-label', 'Move ' + it.name + ' up'); up.disabled = i === 0;
      var down = button('↓', 'secondary dx-move', function () { move(i, i + 1); }); down.setAttribute('aria-label', 'Move ' + it.name + ' down'); down.disabled = i === nd.items.length - 1;
      var acts = kids(make('div', { class: 'dx-acts' }), [up, down, button('Edit', 'secondary', function () { openFoodForm('night', i); })]);
      if (!it.libId || !lib[it.libId]) acts.appendChild(button('Save to list', 'secondary', function (e) {
        var b = e.target; b.disabled = true;
        call('saveLibrarySpecial', { special: it }).then(function (r) {
          b.disabled = false;
          if (!r.ok) { note(nd.msg, r.error, 'error'); return; }
          it.libId = r.data.id; markDirty(); note(nd.msg, '“' + it.name + '” added to your list.', 'ok');
        });
      }));
      acts.appendChild(button('Remove', 'secondary quiet', function () { nd.items.splice(i, 1); markDirty(); }));
      row.appendChild(acts);
      // Drag to reorder (mouse); the arrows do the same on touch screens and keyboards.
      row.addEventListener('dragstart', function (e) { nd.drag = i; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(i)); } catch (x) {} });
      row.addEventListener('dragend', function () { nd.drag = null; row.classList.remove('dragging'); Array.prototype.forEach.call(nd.rows.children, function (r) { r.classList.remove('drop-above', 'drop-below'); }); });
      row.addEventListener('dragover', function (e) {
        if (nd.drag == null) return; e.preventDefault();
        var below = e.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
        row.classList.toggle('drop-below', below); row.classList.toggle('drop-above', !below);
      });
      row.addEventListener('dragleave', function () { row.classList.remove('drop-above', 'drop-below'); });
      row.addEventListener('drop', function (e) {
        e.preventDefault(); if (nd.drag == null) return;
        var below = row.classList.contains('drop-below'), to = i + (below ? 1 : 0), from = nd.drag;
        if (from < to) to--;
        nd.drag = null; move(from, to);
      });
      nd.rows.appendChild(row);
    });
  }

  function drawLibrary() {
    if (!nd.lib) return;
    clear(nd.lib);
    var q = nd.search.value.trim().toLowerCase(), rows = libRows();
    if (!rows.length) { nd.lib.appendChild(make('div', { class: 'cat-empty' }, 'No saved specials yet. Create one above and it will be kept here.')); return; }
    var shown = rows.filter(function (r) { return !q || (r.name + ' ' + (r.ingredients || '') + ' ' + (r.description || '')).toLowerCase().indexOf(q) >= 0; });
    if (!shown.length) { nd.lib.appendChild(make('div', { class: 'cat-empty' }, 'No saved special matches “' + nd.search.value.trim() + '”.')); return; }
    shown.forEach(function (r) {
      var row = make('div', { class: 'cat-row dx-row' }), on = onTonight(r.id);
      var name = kids(make('div', { class: 'dx-name' }), [make('strong', {}, r.name)]);
      if (on) name.appendChild(make('span', { class: 'dx-pill live' }, 'on tonight'));
      var meta = itemMeta(r) + (r.lastUsed ? (itemMeta(r) ? ' · ' : '') + 'last on ' + niceDate(r.lastUsed) : '');
      if (meta) name.appendChild(make('div', { class: 'cat-row-meta' }, meta));
      var add = button(on ? 'On tonight' : 'Add to tonight', on ? 'secondary' : '', function () {
        if (nd.items.length >= D.LIMITS.nightlyItems) { note(nd.libMsg, 'Tonight’s list is full (' + D.LIMITS.nightlyItems + ').', 'error'); return; }
        nd.items.push(fromLib(r.id)); markDirty();
        note(nd.libMsg, '“' + r.name + '” added to tonight. Save tonight’s list when you are done.', 'ok');
      });
      add.disabled = on;
      kids(row, [name, kids(make('div', { class: 'dx-acts' }), [add, button('Edit', 'secondary', function () { openFoodForm('lib', r.id); }),
        armed(button('', 'secondary quiet'), 'Delete', function () {
          call('removeLibrarySpecial', { id: r.id }).then(function (x) { note(nd.libMsg, x.ok ? '“' + r.name + '” deleted from your list. Nights already saved keep it.' : x.error, x.ok ? 'ok' : 'error'); });
        })])]);
      nd.lib.appendChild(row);
    });
  }

  function nightPayload() {
    return { date: nd.date, items: nd.items.map(function (i) {
      var o = { name: i.name, ingredients: i.ingredients, description: i.description, allergens: i.allergens, price: i.price == null ? '' : i.price };
      if (i.libId) o.libId = i.libId;
      return o;
    }) };
  }
  function saveNight() {
    var v = D.validateNightly(nightPayload());
    if (!v.ok) { note(nd.msg, v.errors.join(' '), 'error'); return Promise.resolve(false); }
    nd.save.disabled = true; note(nd.msg, 'Saving…', '');
    return call('saveNightly', v.nightly).then(function (r) {
      nd.save.disabled = false;
      if (r.ok) { nd.dirty = false; drawTonight(); }
      note(nd.msg, r.ok ? (r.data.count ? 'Saved ' + r.data.count + (r.data.count === 1 ? ' special' : ' specials') + ' for ' + niceDate(nd.date) + '.' : 'Cleared the list for ' + niceDate(nd.date) + '.') : r.error, r.ok ? 'ok' : 'error');
      return r.ok;
    });
  }
  function exportPdf() {
    var v = D.validateNightly(nightPayload());
    if (!v.ok) { note(nd.msg, v.errors.join(' '), 'error'); return; }
    if (!v.nightly.items.length) { note(nd.msg, 'Add at least one special to export the menu.', 'error'); return; }
    if (!window.HS_SPECIALS_PDF) { note(nd.msg, 'The PDF maker did not load. Reload the page and try again.', 'error'); return; }
    nd.pdf.disabled = true; nd.pdf.textContent = 'Making the PDF…';
    var saving = nd.dirty ? saveNight() : Promise.resolve(true);
    saving.then(function (saved) {
      return window.HS_SPECIALS_PDF.download(v.nightly).then(function (out) {
        if (!out.fits) note(nd.msg, 'Too many specials, or too much text, to fit on the card: the PDF was made but the bottom runs into the advisory. Remove a special or shorten descriptions, then export again.', 'error');
        else if (saved) note(nd.msg, 'PDF saved to your downloads. Print it on Letter paper at 100% (actual size), then cut down the middle.', 'ok');
      });
    }).catch(function (e) { note(nd.msg, 'Could not make the PDF: ' + ((e && e.message) || 'try again') + '.', 'error'); })
      .then(function () { nd.pdf.disabled = false; nd.pdf.textContent = 'Export PDF menu'; });
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
      if (built && nd.rows) { if (nd.dirty) drawTonight(); else loadNight(); }
    });
    watch('menu/specialsLibrary', function (v) { lib = v || {}; if (built && nd.rows) { drawTonight(); drawLibrary(); } });
    setInterval(function () { if (built && manager) drawSpecials(); }, 60000);
  }
  function stop() { refs.forEach(function (r) { r.off(); }); refs = []; started = false; drinks = {}; specials = {}; nightly = {}; toast = {}; lib = {}; }
  function buildAll() { if (built) return; built = true; buildDrinks(); buildSpecials(); drawDrinks(); drawSpecials(); }
  return {
    signedIn: function (claims) {
      manager = !!(claims && window.HS_CATALOG && window.HS_CATALOG.isManager(claims));
      if (manager) { start(); buildAll(); } else stop();
    },
    signedOut: function () { manager = false; stop(); },
  };
})();
