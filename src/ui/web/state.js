// litectx ui — page state <-> URL hash. Pure (no DOM), so test/ui.test.js runs it from node.
// Defaults are omitted, so a fresh page has an empty hash. Repos are repeated keys (a name may hold a comma).
(function (root) {
  "use strict";
  var KEYS = ["q", "sub", "ext", "folder", "open"];
  function encodeState(s) {
    var p = new URLSearchParams();
    KEYS.forEach(function (k) { if (s[k]) p.set(k, s[k]); });
    (s.repos || []).forEach(function (r) { p.append("repo", r); });
    var kinds = s.kinds || { doc: true, code: true };
    if (!kinds.doc) p.set("doc", "0");
    if (!kinds.code) p.set("code", "0");
    if (s.kwOnly) p.set("kw", "1");
    if (s.demote === false) p.set("demote", "0");
    if (s.view === "roomy") p.set("view", "roomy");
    var out = p.toString();
    return out ? "#" + out : "";
  }
  function decodeState(hash) {
    var p = new URLSearchParams(String(hash || "").replace(/^#/, ""));
    var d = {
      q: p.get("q") || "", sub: p.get("sub") || "", ext: p.get("ext") || null, folder: p.get("folder") || null, open: p.get("open") || null,
      repos: p.getAll("repo"), kinds: { doc: p.get("doc") !== "0", code: p.get("code") !== "0" },
      kwOnly: p.get("kw") === "1", demote: p.get("demote") !== "0", view: p.get("view") === "roomy" ? "roomy" : "table"
    };
    return d;
  }
  root.litectxState = { encodeState: encodeState, decodeState: decodeState };
})(window);
