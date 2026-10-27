/*
 * Oyster Passport — the browser side: Firebase, this phone's storage and
 * Google Analytics. Oyster Passport Build Sheet sections 0.10, 5.11 and 6.2.
 *
 * Loaded by the Passport pages as a global (HS_STORE), after
 * src/passport-core.js. Browser only.
 *
 * Firebase: the Passport uses its own named app ('passport'), so a guest's
 * phone sign-in and a staff sign-in on the employee page (default app,
 * session persistence) live side by side in one browser. [CALL]
 *
 * Google Analytics: every Passport event goes through track(), which only
 * sends the events and parameters listed in EVENTS. Nothing that
 * identifies a guest (name, phone, email, birthday, card digits, notes,
 * the Firebase uid) is ever passed to it.
 *
 * user.html uses the Firebase, storage and analytics parts. Passport pages
 * (passport.html; the menu and Curated Flights from step 5) open a session
 * with HS_STORE.session(), which holds the guest's passport in memory,
 * saves changes (6.2) and earns stamps (6.5).
 *
 * Needs src/passport-core.js; a session also needs data/oysters.js,
 * data/regions.js, data/flights.js and data/stamps.js.
 */
(function (root) {
  'use strict';

  var CONFIG = {
    apiKey:            'AIzaSyDNuyGuzAmow0YehKlztihYn3l57--82L8',
    authDomain:        'half-shell-oyster-menu.firebaseapp.com',
    databaseURL:       'https://half-shell-oyster-menu-default-rtdb.firebaseio.com',
    projectId:         'half-shell-oyster-menu',
    storageBucket:     'half-shell-oyster-menu.firebasestorage.app',
    messagingSenderId: '784452175310',
    appId:             '1:784452175310:web:2d56ed01d06bb39886179f'
  };
  var SDK = 'https://www.gstatic.com/firebasejs/9.23.0/firebase-';
  var APP_NAME = 'passport';

  // Keys on this phone (localStorage). None holds a birthday or card digits.
  var PREVIEW_KEY = 'hs_passport_preview';      // '1' = preview link opened on this phone
  var SIGNED_IN_KEY = 'hs_passport_signed_in';  // '1' = a Passport sign-in is stored (the menu checks this)
  var HERE_KEY = 'hs_passport_here';            // { 'YYYY-MM-DD': ms } menu opened while signed out

  // ── This phone's storage (every access in try/catch) ──────────────────────
  function lsGet(k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { root.localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsRemove(k) { try { root.localStorage.removeItem(k); } catch (e) { /* nothing to do */ } }
  function lsJson(k) { try { return JSON.parse(lsGet(k) || 'null'); } catch (e) { return null; } }

  /** Preview link (user.html?preview=1) remembered on this phone; ?preview=0 forgets it. */
  var previewThisPage = false;
  function isPreview() {
    var q = null;
    try { q = new URLSearchParams(root.location.search).get('preview'); } catch (e) { /* old browser */ }
    if (q === '1') { previewThisPage = true; lsSet(PREVIEW_KEY, '1'); }
    if (q === '0') { previewThisPage = false; lsRemove(PREVIEW_KEY); return false; }
    return previewThisPage || lsGet(PREVIEW_KEY) === '1';
  }
  function markSignedIn(on) { if (on) lsSet(SIGNED_IN_KEY, '1'); else lsRemove(SIGNED_IN_KEY); }
  /** Here-today dates remembered while signed out: { date: ms }. */
  function hereRemembered() {
    var h = lsJson(HERE_KEY);
    return h && typeof h === 'object' ? h : {};
  }

  // ── Firebase ──────────────────────────────────────────────────────────────
  var loads = {};
  function loadScript(src) {
    if (!loads[src]) {
      loads[src] = new Promise(function (resolve, reject) {
        var s = root.document.createElement('script');
        s.src = src;
        s.onload = function () { resolve(); };
        s.onerror = function () { delete loads[src]; reject(new Error('Could not load ' + src)); };
        root.document.head.appendChild(s);
      });
    }
    return loads[src];
  }
  /** Loads the compat SDK: app first, then each part ('auth', 'database', 'functions'). */
  function sdk(parts) {
    return loadScript(SDK + 'app-compat.js').then(function () {
      return Promise.all((parts || []).map(function (p) { return loadScript(SDK + p + '-compat.js'); }));
    });
  }
  var theApp = null;
  /** The Passport's own Firebase app. */
  function app() {
    if (theApp) return theApp;
    var fb = root.firebase;
    theApp = (fb.apps || []).filter(function (a) { return a.name === APP_NAME; })[0] ||
      fb.initializeApp(CONFIG, APP_NAME);
    return theApp;
  }

  // ── Google Analytics (5.11) ───────────────────────────────────────────────
  var EVENTS = {
    sign_up: ['method', 'cards_added'],
    login: ['method'],
    oyster_logged: ['oyster', 'qty', 'where'],
    rating_given: ['oyster', 'stars'],
    flight_logged: ['flight'],
    visit_saved: ['oysters', 'varieties', 'rated'],
    stamp_earned: ['stamp', 'tier'],
    passport_tab: ['tab'],
    data_exported: [],
    account_deleted: []
  };
  /** Sends one listed event with only its listed parameters. */
  function track(name, params) {
    var keys = EVENTS[name];
    if (!keys || typeof root.gtag !== 'function') return;
    var clean = {};
    keys.forEach(function (k) { if (params && params[k] !== undefined) clean[k] = params[k]; });
    try { root.gtag('event', name, clean); } catch (e) { /* analytics never breaks the page */ }
  }

  /** GA user properties: a member, and a visit-count band (no identifiers). */
  function visitBand(n) { return n >= 10 ? '10+' : n >= 5 ? '5–9' : n >= 2 ? '2–4' : n >= 1 ? '1' : '0'; }
  function setMember(visits) {
    if (typeof root.gtag !== 'function') return;
    try { root.gtag('set', 'user_properties', { passport_member: 'yes', visit_band: visitBand(visits) }); } catch (e) { /* never breaks the page */ }
  }

  // ── Multi-path updates, in memory ─────────────────────────────────────────
  /** Applies { 'a/b/c': v } to a plain object the way Realtime Database does (null deletes; empty parents go). */
  function applyPaths(obj, updates) {
    Object.keys(updates).forEach(function (path) {
      var parts = path.split('/').filter(Boolean), v = updates[path], node = obj, trail = [];
      for (var i = 0; i < parts.length - 1; i++) {
        if (!node[parts[i]] || typeof node[parts[i]] !== 'object') {
          if (v === null) return;
          node[parts[i]] = {};
        }
        trail.push([node, parts[i]]);
        node = node[parts[i]];
      }
      var last = parts[parts.length - 1];
      if (v === null) delete node[last];
      else node[last] = (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v;
      for (var j = trail.length - 1; j >= 0; j--) {
        var parent = trail[j][0], key = trail[j][1];
        if (parent[key] && typeof parent[key] === 'object' && !Object.keys(parent[key]).length) delete parent[key];
        else break;
      }
    });
    return obj;
  }
  /**
   * Adds `updates` to a pending multi-path update without overlapping paths
   * (Realtime Database refuses an update with a path inside another).
   */
  function mergePending(pending, updates) {
    Object.keys(updates).forEach(function (path) {
      var v = updates[path];
      // A newer write to a path replaces anything pending below it.
      Object.keys(pending).forEach(function (k) { if (k.indexOf(path + '/') === 0) delete pending[k]; });
      // A pending write above this path takes the change inside its value.
      var anc = Object.keys(pending).filter(function (k) { return path.indexOf(k + '/') === 0; })[0];
      if (anc) {
        var inner = {};
        inner[path.slice(anc.length + 1)] = v;
        if (pending[anc] === null || typeof pending[anc] !== 'object') pending[anc] = {};
        applyPaths(pending[anc], inner);
        if (!Object.keys(pending[anc]).length) pending[anc] = null;
      } else {
        pending[path] = (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v;
      }
    });
    return pending;
  }

  // ── A signed-in guest's passport ──────────────────────────────────────────
  /**
   * Opens the guest's passport. Resolves to a session, or to null when nobody
   * is signed in or the profile isn't complete (opts.redirect sends them to
   * user.html instead). Rejects when the passport can't be read.
   *   opts.redirect   true: go to user.html when there's no passport
   *   opts.served     true: keep tonight's menu (menu/serving) live
   */
  function session(opts) {
    opts = opts || {};
    var P = root.HS_PASSPORT;
    return sdk(['auth', 'database']).then(function () {
      var a = app(), auth = a.auth(), db = a.database();
      return new Promise(function (resolve) {
        var off = auth.onAuthStateChanged(function (user) { off(); resolve(user); });
      }).then(function (user) {
        if (!user || !user.phoneNumber) {
          markSignedIn(false);
          if (opts.redirect) root.location.replace('user.html');
          return null;
        }
        markSignedIn(true);
        return db.ref('users/' + user.uid).once('value').then(function (snap) {
          var data = snap.val() || {};
          if (!(data.profile && data.profile.name && data.profile.dob)) {
            if (opts.redirect) root.location.replace('user.html');
            return null;
          }
          return new Session(P, a, auth, db, user, data, opts);
        });
      });
    });
  }

  function Session(P, a, auth, db, user, data, opts) {
    var self = this;
    this.P = P; this.auth = auth; this.db = db; this.user = user; this.uid = user.uid;
    this.state = data;                       // users/{uid}, kept current in memory
    this.oysters = root.OYSTERS || [];
    this.regions = root.HS_REGIONS || [];
    this.served = [];                        // tonight's menu: catalog ids
    this.online = true;
    this.listeners = [];
    this.pendingKey = 'hs_pending_' + user.uid;
    this.pending = {};
    this.inflight = null;
    this.timer = null;
    this.saveError = null;
    this.birthdayReward = null;

    // Changes saved on this phone but not yet sent (a reload, a lost signal).
    var saved = lsJson(this.pendingKey);
    if (saved && typeof saved === 'object' && Object.keys(saved).length) {
      applyPaths(this.state, saved);
      mergePending(this.pending, saved);
    }

    db.ref('.info/connected').on('value', function (s) { self.online = s.val() !== false; self.emit('status'); });
    db.ref('config/birthdayReward').once('value').then(function (s) {
      var v = s.val();
      self.birthdayReward = typeof v === 'string' && v.trim() ? v.trim() : null;
      self.emit('change');
    }, function () { /* no reward shown */ });
    if (opts.served) {
      db.ref('menu/serving').on('value', function (s) {
        self.served = Object.keys(s.val() || {}).sort();
        self.emit('served');
      }, function () { self.servedError = true; self.emit('served'); });
    }

    // Visit timeout on load and whenever the page comes back.
    this.checkTimeout();
    this.refreshStamps(true);
    if (Object.keys(this.pending).length) this.flush();
    root.addEventListener('focus', function () { self.checkTimeout(); });
    root.document.addEventListener('visibilitychange', function () {
      if (root.document.visibilityState === 'hidden') self.flush();
      else self.checkTimeout();
    });
    root.addEventListener('pagehide', function () { self.flush(); });
    setMember(P.measures(this.state.visits, this.oysters, this.regions).visits);
  }
  Session.prototype.on = function (fn) { this.listeners.push(fn); };
  Session.prototype.emit = function (what) {
    this.listeners.forEach(function (fn) { try { fn(what); } catch (e) { if (root.console) root.console.error(e); } });
  };
  Session.prototype.now = function () { return Date.now(); };
  Session.prototype.today = function () { return this.P.businessDay(this.now()); };
  Session.prototype.newId = function () { return this.db.ref('users/' + this.uid + '/visits').push().key; };
  Session.prototype.firstName = function () {
    return String((this.state.profile && this.state.profile.name) || '').split(' ')[0];
  };
  Session.prototype.openVisit = function () { return this.P.openVisit(this.state); };

  /** Applies a change: memory, this phone, then the database within 5 s. */
  Session.prototype.apply = function (updates, opts) {
    if (!updates || !Object.keys(updates).length) return;
    applyPaths(this.state, updates);
    mergePending(this.pending, updates);
    this.savePendingLocally();
    if (!(opts && opts.noStamps)) this.refreshStamps(false);
    this.emit('change');
    this.schedule();
  };
  Session.prototype.savePendingLocally = function () {
    var all = mergePending(mergePending({}, this.inflight || {}), this.pending);
    if (Object.keys(all).length) lsSet(this.pendingKey, JSON.stringify(all));
    else lsRemove(this.pendingKey);
  };
  Session.prototype.schedule = function () {
    var self = this;
    clearTimeout(this.timer);
    this.timer = setTimeout(function () { self.flush(); }, 5000);
  };
  /** Sends pending changes in one update. Resolves true when the database has them. */
  Session.prototype.flush = function () {
    var self = this;
    clearTimeout(this.timer);
    if (this.inflight) return this.inflightPromise;
    if (!Object.keys(this.pending).length) return Promise.resolve(true);
    this.inflight = this.pending;
    this.pending = {};
    this.inflightPromise = this.db.ref('users/' + this.uid).update(this.inflight).then(function () {
      self.inflight = null;
      self.saveError = null;
      self.savePendingLocally();
      self.emit('status');
      if (Object.keys(self.pending).length) return self.flush();
      return true;
    }, function (err) {
      // Keep everything; newer changes win.
      self.pending = mergePending(self.inflight, self.pending);
      self.inflight = null;
      self.saveError = (err && err.message) || 'save failed';
      self.savePendingLocally();
      self.emit('status');
      return false;
    });
    return this.inflightPromise;
  };
  Session.prototype.checkTimeout = function () {
    this.apply(this.P.timeoutUpdates(this.state, this.now()));
  };
  /** Today's Curated Flights for this menu, as lists of oyster ids (Flight Crew). */
  Session.prototype.todayFlights = function () {
    var F = root.HS_FLIGHTS;
    if (!F || !this.served.length) return [];
    var by = {};
    this.oysters.forEach(function (o) { by[o.id] = o; });
    var served = this.served.map(function (id) { return by[id]; }).filter(Boolean);
    return F.selectFlights(served, F.rotationDate(new Date(this.now()))).map(function (f) {
      return f.oysters.map(function (o) { return o.id; });
    });
  };
  /** Evaluates stamps and records new tiers (seen: false). */
  Session.prototype.refreshStamps = function (initial) {
    var P = this.P, now = this.now();
    var ev = P.evaluateStamps({ visits: this.state.visits || {}, oysters: this.oysters, regions: this.regions,
      dob: this.state.profile && this.state.profile.dob, today: this.today(), todayFlights: this.todayFlights() });
    this.evaluated = ev;
    var u = P.stampUpdates(this.state.stamps, ev, now);
    if (!Object.keys(u).length) return;
    Object.keys(u).forEach(function (k) {
      var m = /^stamps\/([^/]+)\/tier$/.exec(k);
      if (m) track('stamp_earned', { stamp: m[1], tier: u[k] });
    });
    this.apply(u, { noStamps: true });
  };
  /** Stamps waiting for their celebration, oldest first. */
  Session.prototype.unseen = function () { return this.P.unseenStamps(this.state.stamps); };
  Session.prototype.markSeen = function (id) {
    var u = {};
    u['stamps/' + id + '/seen'] = true;
    this.apply(u, { noStamps: true });
  };
  /** A catalog oyster by id (null for a retired one). */
  Session.prototype.oyster = function (id) {
    for (var i = 0; i < this.oysters.length; i++) if (this.oysters[i].id === id) return this.oysters[i];
    return null;
  };
  Session.prototype.signOut = function () {
    var self = this;
    return this.flush().then(function () { return self.auth.signOut(); }).then(function () {
      markSignedIn(false);
    });
  };

  root.HS_STORE = {
    CONFIG: CONFIG, APP_NAME: APP_NAME, EVENTS: EVENTS,
    PREVIEW_KEY: PREVIEW_KEY, SIGNED_IN_KEY: SIGNED_IN_KEY, HERE_KEY: HERE_KEY,
    lsGet: lsGet, lsSet: lsSet, lsRemove: lsRemove, lsJson: lsJson,
    isPreview: isPreview, markSignedIn: markSignedIn, hereRemembered: hereRemembered,
    sdk: sdk, app: app, track: track, setMember: setMember, visitBand: visitBand,
    applyPaths: applyPaths, mergePending: mergePending, session: session
  };
})(window);
