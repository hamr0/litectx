// litectx ui — page state <-> URL hash. Pure (no DOM), so test/ui.test.js runs it from node.
// Defaults are omitted, so a fresh page has an empty hash. Repos are repeated keys (a name may hold a comma).
(function (root) {
  "use strict";
  var KEYS = ["q", "sub", "ext", "folder", "open"];
  function encodeState(s) {
    var p = new URLSearchParams();
    KEYS.forEach(function (k) { if (s[k]) p.set(k, s[k]); });
    (s.repos || []).forEach(function (r) { p.append("repo", r); });
    var kinds = s.kinds || {};
    if (kinds.doc) p.set("doc", "1");
    if (kinds.code) p.set("code", "1");
    if (s.demote === false) p.set("demote", "0");
    if (s.view === "roomy") p.set("view", "roomy");
    var out = p.toString();
    return out ? "#" + out : "";
  }
  // docs/code are a filter: ON = only that kind, none ON = no filter. An old hash (doc=0 / code=0 meant
  // "that kind off") maps to the kind still on; an old both-on hash had no key and means no filter.
  function kindsOf(p) {
    var doc = p.get("doc"), code = p.get("code");
    if (doc === "1" || code === "1") return { doc: doc === "1", code: code === "1" };
    return { doc: code === "0", code: doc === "0" };
  }
  function decodeState(hash) {
    var p = new URLSearchParams(String(hash || "").replace(/^#/, ""));
    var d = {
      q: p.get("q") || "", sub: p.get("sub") || "", ext: p.get("ext") || null, folder: p.get("folder") || null, open: p.get("open") || null,
      repos: p.getAll("repo"), kinds: kindsOf(p),
      demote: p.get("demote") !== "0", view: p.get("view") === "roomy" ? "roomy" : "table"
    };
    return d;
  }
  // Repos named in a query are ADDED to the picked ones (deduped, picked order kept) -- never replace them.
  function mergeRepos(picked, available, query) {
    var words = String(query || "").toLowerCase().split(/[^a-z0-9_.-]+/), out = (picked || []).slice();
    (available || []).forEach(function (r) { if (words.indexOf(r.toLowerCase()) >= 0 && out.indexOf(r) < 0) out.push(r); });
    return out;
  }
  // True when any filter differs from its default (the query itself is not a filter).
  function hasFilters(s) {
    var k = s.kinds || {};
    return !!((s.repos && s.repos.length) || s.ext || s.folder || k.doc || k.code || s.demote === false);
  }
  // "clear all": reset every filter to its default, keep the query. Mutates and returns s.
  function clearFilters(s) {
    s.repos = []; s.ext = null; s.folder = null; s.kinds = { doc: false, code: false }; s.demote = true;
    return s;
  }
  // "+3 ~1 -0 · 2.1 s" from the server's last index pass
  function passText(last) {
    return last ? "+" + last.added + " ~" + last.updated + " -" + last.removed + " · " + (last.ms / 1000).toFixed(1) + " s" : "";
  }
  root.litectxState = { encodeState: encodeState, decodeState: decodeState, mergeRepos: mergeRepos, hasFilters: hasFilters, clearFilters: clearFilters, passText: passText };
})(window);
