/* Truck Deals: durable favorites + hidden ("ignored") trucks, with keyless cross-device sync.

   Local copy (always): localStorage "td_marks_v2"
     { v: 2, favs: { <key>: { on, t, s? } }, hidden: { <key>: { on, t } } }
     key = VIN (upper-case) when the listing has one, else a normalized listing URL ("url:host/path?q").
     on  = true (favorited / hidden) or false (a tombstone: removed on purpose).
     t   = ms timestamp of the last change. Merge = union, newest t wins per key, so a removal on
           one device beats an older add on another, and nothing is ever dropped by a data refresh.
     s   = snapshot of the truck (title, price, miles, dealer, url...) so a favorite that is no longer
           in data.json still shows as "No longer listed".
   Old formats are migrated on every load (idempotent) and the old keys are kept and rewritten:
     truck-deals-favorites-v1 / truck-deals-hidden-v1 = JSON string[] of VIN-or-raw-url (2026-10-28).
   Sync (optional): textdb.dev, keyless, CORS *. One text document per sync code at
     https://textdb.dev/api/data/<code>. Anyone holding the code can read/write that document, so the
     code is a long random id. Nothing else (no account, no key, no token) is stored or sent. */
(function (global) {
  "use strict";

  var STORE_KEY = "td_marks_v2";
  var SYNC_KEY = "td_sync_v1";
  var LEGACY = { favs: ["truck-deals-favorites-v1"], hidden: ["truck-deals-hidden-v1"] };
  /* Migrated entries get an old timestamp so any real add/remove made later wins a merge. */
  var MIGRATED_T = Date.UTC(2026, 9, 28, 5, 0, 0);
  var SYNC_BASE = "https://textdb.dev/api/data/";
  var CODE_RE = /^[A-Za-z0-9_-]{12,80}$/;
  var KINDS = ["favs", "hidden"];
  var SNAP_FIELDS = ["title", "yr", "model", "trim", "price", "mi", "loc", "d", "url", "vin", "thumb", "online", "seen"];

  function now() { return Date.now(); }

  function lsGet(key) { try { return global.localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, val) {
    try { global.localStorage.setItem(key, val); return true; } catch (e) { return false; }
  }

  /* ---------- keys ---------- */
  var DROP_PARAM = /^(utm_.*|fbclid|gclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|_ga|_gl|ref|referrer|igshid)$/i;
  function normUrl(raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (!s) return "";
    try {
      var u = new URL(s);
      if (!/^https?:$/.test(u.protocol)) return "";
      var host = u.hostname.toLowerCase().replace(/^www\./, "");
      var params = [];
      u.searchParams.forEach(function (v, k) { if (!DROP_PARAM.test(k)) params.push([k, v]); });
      params.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0; });
      var path = u.pathname.replace(/\/+$/, "") || "/";
      var q = params.map(function (p) { return encodeURIComponent(p[0]) + "=" + encodeURIComponent(p[1]); }).join("&");
      return "url:" + host + path + (q ? "?" + q : "");
    } catch (e) {
      return "";
    }
  }

  function vinOf(listing) {
    return String((listing && listing.vin) || "").trim().toUpperCase();
  }

  /* Primary key: VIN, else normalized url. */
  function keyFor(listing) {
    return vinOf(listing) || normUrl(listing && listing.url);
  }

  /* An old stored string (VIN or raw url) -> current key. */
  function keyFromLegacy(entry) {
    var s = String(entry == null ? "" : entry).trim();
    if (!s) return "";
    if (/^url:/.test(s)) return s;
    if (/^https?:\/\//i.test(s)) return normUrl(s);
    return s.toUpperCase();
  }

  /* ---------- records ---------- */
  function cleanSnap(s) {
    if (!s || typeof s !== "object") return undefined;
    var out = {};
    SNAP_FIELDS.forEach(function (f) {
      var v = s[f];
      if (v == null || v === "") return;
      if (typeof v === "number" && isFinite(v)) out[f] = v;
      else if (typeof v === "boolean") out[f] = v;
      else if (typeof v === "string") out[f] = v.slice(0, 300);
    });
    return Object.keys(out).length ? out : undefined;
  }

  function cleanRec(r) {
    if (r === true) return { on: true, t: MIGRATED_T };
    if (!r || typeof r !== "object") return null;
    var t = Number(r.t);
    if (!isFinite(t) || t < 0) t = 0;
    var rec = { on: r.on !== false, t: Math.round(t) };
    if (rec.on) {
      var s = cleanSnap(r.s);
      if (s) rec.s = s;
    }
    return rec;
  }

  function cleanMap(m) {
    var out = {};
    if (!m || typeof m !== "object" || Array.isArray(m)) return out;
    Object.keys(m).forEach(function (k) {
      var key = keyFromLegacy(k);
      var rec = cleanRec(m[k]);
      if (key && rec) out[key] = pick(out[key], rec);
    });
    return out;
  }

  function cleanDoc(d) {
    var doc = { v: 2, favs: {}, hidden: {} };
    if (!d || typeof d !== "object") return doc;
    KINDS.forEach(function (k) { doc[k] = cleanMap(d[k]); });
    return doc;
  }

  /* Newest t wins; on a tie an add beats a removal (never lose a favorite to a coin flip).
     The winner keeps the other side's snapshot if it has none. */
  function pick(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    var w = a.t > b.t ? a : b.t > a.t ? b : a.on ? a : b;
    var o = w === a ? b : a;
    var out = { on: w.on, t: w.t };
    if (out.on) {
      var s = w.s || (o.on ? o.s : undefined);
      if (s) out.s = s;
    }
    return out;
  }

  function mergeDocs(a, b) {
    var out = { v: 2, favs: {}, hidden: {} };
    KINDS.forEach(function (kind) {
      var A = (a && a[kind]) || {};
      var B = (b && b[kind]) || {};
      var keys = {};
      Object.keys(A).forEach(function (k) { keys[k] = 1; });
      Object.keys(B).forEach(function (k) { keys[k] = 1; });
      Object.keys(keys).sort().forEach(function (k) { out[kind][k] = pick(A[k], B[k]); });
    });
    return out;
  }

  function canon(doc) {
    var out = {};
    KINDS.forEach(function (kind) {
      var m = (doc && doc[kind]) || {};
      out[kind] = Object.keys(m).sort().map(function (k) {
        var r = m[k];
        return [k, r.on ? 1 : 0, r.t, r.s ? JSON.stringify(r.s, Object.keys(r.s).sort()) : ""];
      });
    });
    return JSON.stringify(out);
  }

  /* ---------- load / migrate / save ---------- */
  function legacyList(key) {
    var raw = lsGet(key);
    if (!raw) return null;
    try {
      var v = JSON.parse(raw);
      if (Array.isArray(v)) return v.filter(function (x) { return typeof x === "string" && x.trim(); });
      if (v && typeof v === "object") {
        /* tolerate an object map { key: true | {..} } */
        return Object.keys(v).filter(function (k) { return v[k] && (v[k] === true || v[k].on !== false); });
      }
    } catch (e) {}
    return null;
  }

  function migrateInto(doc) {
    var found = { favs: 0, hidden: 0 };
    KINDS.forEach(function (kind) {
      var keys = LEGACY[kind].slice();
      /* any other Truck Deals favorites-looking key on this origin (only td_/truck-deals keys:
         mjlembo88.github.io is shared with other apps that have their own stars) */
      if (kind === "favs") {
        try {
          for (var i = 0; i < global.localStorage.length; i++) {
            var k = global.localStorage.key(i);
            if (!k || k === STORE_KEY || k === SYNC_KEY || keys.indexOf(k) !== -1) continue;
            if (/^(td[_-]|truck-?deals)/i.test(k) && /fav|star/i.test(k)) keys.push(k);
          }
        } catch (e) {}
      }
      keys.forEach(function (lk) {
        var list = legacyList(lk);
        if (!list) return;
        list.forEach(function (entry) {
          var key = keyFromLegacy(entry);
          if (!key) return;
          var had = doc[kind][key];
          var rec = { on: true, t: MIGRATED_T };
          if (/^https?:\/\//i.test(entry) && kind === "favs") rec.s = { url: entry };
          doc[kind][key] = pick(had, rec);
          if (!had) found[kind]++;
        });
      });
    });
    return found;
  }

  var doc = { v: 2, favs: {}, hidden: {} };
  var migrated = { favs: 0, hidden: 0 };
  var listeners = [];

  function load() {
    var raw = lsGet(STORE_KEY);
    var parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = null; }
    if (raw && !parsed) lsSet(STORE_KEY + "_corrupt_" + now(), raw); /* keep a copy, never just drop it */
    doc = cleanDoc(parsed);
    migrated = migrateInto(doc);
    save(true);
  }

  function legacyArray(kind) {
    var m = doc[kind];
    return Object.keys(m).filter(function (k) { return m[k].on; }).map(function (k) {
      if (/^url:/.test(k)) return (m[k].s && m[k].s.url) || k;
      return k;
    });
  }

  function save(quiet) {
    var ok = lsSet(STORE_KEY, JSON.stringify(doc));
    /* keep the old keys current so an older cached app version still sees the same stars */
    lsSet(LEGACY.favs[0], JSON.stringify(legacyArray("favs")));
    lsSet(LEGACY.hidden[0], JSON.stringify(legacyArray("hidden")));
    if (!quiet) emit("local");
    return ok;
  }

  function emit(why) {
    listeners.slice().forEach(function (fn) { try { fn(why); } catch (e) {} });
  }

  /* ---------- public store API ---------- */
  function rec(kind, key) { return key ? doc[kind][key] : null; }
  function isOn(kind, key) { var r = rec(kind, key); return !!(r && r.on); }

  function set(kind, key, on, snap) {
    if (!key) return false;
    var prev = doc[kind][key];
    var t = Math.max(now(), prev ? prev.t + 1 : 0);
    var r = { on: !!on, t: t };
    if (on) {
      var s = cleanSnap(snap) || (prev && prev.s);
      if (s) r.s = s;
    }
    doc[kind][key] = r;
    save();
    scheduleSync();
    return r.on;
  }

  function toggle(kind, key, snap) { return set(kind, key, !isOn(kind, key), snap); }

  function activeKeys(kind) {
    var m = doc[kind];
    return Object.keys(m).filter(function (k) { return m[k].on; });
  }

  /* Call after each data load: re-key url favorites whose truck now has a VIN, refresh snapshots
     of trucks still listed. Never removes anything. */
  function reconcile(listings, snapOf) {
    var changed = false;
    (listings || []).forEach(function (l) {
      var vin = vinOf(l);
      var uk = normUrl(l && l.url);
      KINDS.forEach(function (kind) {
        if (vin && uk && doc[kind][uk]) {
          doc[kind][vin] = pick(doc[kind][vin], doc[kind][uk]);
          delete doc[kind][uk];
          changed = true;
        }
      });
      var key = vin || uk;
      var r = key && doc.favs[key];
      if (r && r.on && snapOf) {
        var s = cleanSnap(snapOf(l));
        if (s && JSON.stringify(s) !== JSON.stringify(r.s || null)) { r.s = s; changed = true; }
      }
    });
    if (changed) { save(true); scheduleSync(); }
    return changed;
  }

  /* ---------- export / import ---------- */
  function exportJson() {
    return JSON.stringify({ app: "truck-deals", kind: "favorites-backup", exported_at: new Date().toISOString(), data: doc }, null, 1);
  }

  function importJson(text) {
    var parsed = JSON.parse(text);
    var incoming;
    if (Array.isArray(parsed)) incoming = { favs: listToMap(parsed) };
    else if (parsed && parsed.data) incoming = parsed.data;
    else incoming = parsed;
    var clean = cleanDoc(incoming);
    if (incoming && Array.isArray(incoming.favs)) clean.favs = listToMap(incoming.favs);
    if (incoming && Array.isArray(incoming.hidden)) clean.hidden = listToMap(incoming.hidden);
    var before = activeKeys("favs").length;
    doc = mergeDocs(doc, clean);
    save();
    scheduleSync();
    return { favs: activeKeys("favs").length, added: activeKeys("favs").length - before };
  }

  function listToMap(arr) {
    var m = {};
    arr.forEach(function (e) {
      var k = keyFromLegacy(e);
      if (k) m[k] = { on: true, t: MIGRATED_T };
    });
    return m;
  }

  /* ---------- sync ---------- */
  var sync = { code: "", lastOk: 0, lastErr: "", busy: false, pending: false, timer: null, status: "off" };

  function loadSync() {
    try {
      var s = JSON.parse(lsGet(SYNC_KEY) || "null");
      if (s && CODE_RE.test(String(s.code || ""))) { sync.code = s.code; sync.lastOk = Number(s.lastOk) || 0; }
    } catch (e) {}
    sync.status = sync.code ? "idle" : "off";
  }

  function saveSync() {
    lsSet(SYNC_KEY, JSON.stringify({ code: sync.code, lastOk: sync.lastOk }));
  }

  function newCode() {
    var bytes = new Uint8Array(16);
    (global.crypto || global.msCrypto).getRandomValues(bytes);
    var hex = Array.prototype.map.call(bytes, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
    return "tdfav-" + hex;
  }

  function validCode(code) { return CODE_RE.test(String(code || "")); }

  function setStatus(st, err) {
    sync.status = st;
    if (err !== undefined) sync.lastErr = err;
    emit("sync-status");
  }

  function fetchRemote() {
    return global.fetch(SYNC_BASE + encodeURIComponent(sync.code) + "?t=" + now(), { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("sync read HTTP " + res.status);
        return res.text();
      })
      .then(function (text) {
        text = String(text || "").trim();
        if (!text) return null;
        var parsed;
        try { parsed = JSON.parse(text); } catch (e) { throw new Error("sync data is not Truck Deals JSON"); }
        if (!parsed || parsed.app !== "truck-deals") throw new Error("sync code holds other data");
        return cleanDoc(parsed);
      });
  }

  function pushRemote(d) {
    var body = JSON.stringify({ app: "truck-deals", v: 2, updated_at: new Date().toISOString(), favs: d.favs, hidden: d.hidden });
    /* text/plain keeps this a CORS "simple request" (no preflight) */
    return global.fetch(SYNC_BASE + encodeURIComponent(sync.code), {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: body,
      cache: "no-store"
    }).then(function (res) {
      if (!res.ok) throw new Error("sync write HTTP " + res.status);
    });
  }

  function syncNow() {
    if (!sync.code) return Promise.resolve({ skipped: "off" });
    if (global.navigator && global.navigator.onLine === false) {
      setStatus("offline");
      return Promise.resolve({ skipped: "offline" });
    }
    if (sync.busy) { sync.pending = true; return Promise.resolve({ skipped: "busy" }); }
    sync.busy = true;
    setStatus("syncing");
    var code = sync.code;
    return fetchRemote()
      .then(function (remote) {
        if (code !== sync.code) return { skipped: "code changed" };
        var merged = mergeDocs(doc, remote || {});
        var localChanged = canon(merged) !== canon(doc);
        var remoteChanged = !remote || canon(merged) !== canon(remote);
        doc = merged;
        if (localChanged) save(true);
        return (remoteChanged ? pushRemote(merged) : Promise.resolve()).then(function () {
          sync.lastOk = now();
          saveSync();
          setStatus("ok", "");
          if (localChanged) emit("remote");
          return { pulled: localChanged, pushed: remoteChanged };
        });
      })
      .catch(function (err) {
        setStatus("error", String((err && err.message) || err));
        return { error: sync.lastErr };
      })
      .then(function (r) {
        sync.busy = false;
        if (sync.pending) { sync.pending = false; scheduleSync(300); }
        return r;
      });
  }

  function scheduleSync(ms) {
    if (!sync.code) return;
    clearTimeout(sync.timer);
    sync.timer = setTimeout(syncNow, ms == null ? 1500 : ms);
  }

  function startSync(code) {
    sync.code = validCode(code) ? code : newCode();
    sync.lastOk = 0;
    saveSync();
    setStatus("idle", "");
    return syncNow();
  }

  function stopSync() {
    sync.code = "";
    sync.lastOk = 0;
    clearTimeout(sync.timer);
    lsSet(SYNC_KEY, JSON.stringify({ code: "", lastOk: 0 }));
    setStatus("off", "");
  }

  function syncLink(baseHref) {
    if (!sync.code) return "";
    var base = String(baseHref || global.location.href).split("#")[0];
    return base + "#sync=" + sync.code;
  }

  /* "#sync=<code>" in the url links this device; returns the code or "". */
  function codeFromHash(hash) {
    var m = /^#sync=([A-Za-z0-9_-]+)/.exec(String(hash || ""));
    return m && validCode(m[1]) ? m[1] : "";
  }

  load();
  loadSync();

  global.TDFavs = {
    STORE_KEY: STORE_KEY,
    SYNC_KEY: SYNC_KEY,
    SYNC_BASE: SYNC_BASE,
    keyFor: keyFor,
    normUrl: normUrl,
    isFav: function (key) { return isOn("favs", key); },
    isHidden: function (key) { return isOn("hidden", key); },
    toggleFav: function (key, snap) { return toggle("favs", key, snap); },
    toggleHidden: function (key) { return toggle("hidden", key); },
    setFav: function (key, on, snap) { return set("favs", key, on, snap); },
    favKeys: function () { return activeKeys("favs"); },
    hiddenKeys: function () { return activeKeys("hidden"); },
    favRecord: function (key) { return rec("favs", key); },
    reconcile: reconcile,
    migrated: function () { return { favs: migrated.favs, hidden: migrated.hidden }; },
    exportJson: exportJson,
    importJson: importJson,
    mergeDocs: mergeDocs,
    reload: function () { load(); emit("reload"); },
    onChange: function (fn) { listeners.push(fn); },
    sync: {
      state: function () { return { code: sync.code, status: sync.status, lastOk: sync.lastOk, lastErr: sync.lastErr }; },
      start: startSync,
      stop: stopSync,
      now: syncNow,
      schedule: scheduleSync,
      link: syncLink,
      codeFromHash: codeFromHash,
      validCode: validCode
    }
  };
})(window);
