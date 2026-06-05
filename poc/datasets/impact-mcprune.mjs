// Impact ground-truth dataset — mcprune (JS, archived ~2026-05-29; a stable call-graph oracle).
// Labels are HAND-AUDITED real call sites (git grep → read each line), NOT derived from impact()
// itself (that would be circular). `callerFiles` = every distinct file with a genuine invocation;
// re-exports, imports, type positions, object-key shorthand (`summarize: fakeSummarize`), and
// member calls on OTHER receivers (`JSON.parse`) are deliberately excluded.
//
// Metric is the §7.2 pair: (1) SAFETY — a used symbol must never read isolated (refCount > 0);
// (2) QUALITY — confirmed-caller-file recall. See poc/impact-bench.mjs.

export default {
  name: "impact-mcprune",
  roots: ["/home/hamr/PycharmProjects/mcprune", "/home/hamr/Documents/PycharmProjects/mcprune"],
  include: [".js"],
  pathspecs: ["*.js"],
  labels: [
    { symbol: "detectMode", defFile: "src/proxy-utils.js", used: true, form: "direct",
      callerFiles: ["src/proxy-utils.js", "test/proxy.test.js"] },
    { symbol: "extractContext", defFile: "src/proxy-utils.js", used: true, form: "direct",
      callerFiles: ["mcp-server.js", "test/proxy.test.js"] },
    { symbol: "looksLikeSnapshot", defFile: "src/proxy-utils.js", used: true, form: "direct",
      callerFiles: ["mcp-server.js", "test/proxy.test.js"] },
    { symbol: "processSnapshot", defFile: "src/proxy-utils.js", used: true, form: "direct",
      callerFiles: ["mcp-server.js", "test/proxy.test.js"] },
    { symbol: "serialize", defFile: "src/serialize.js", used: true, form: "direct",
      callerFiles: ["src/prune.js"] },
    // `parse` over-counts: mcp-server.js has only `JSON.parse` (a different receiver), which impact
    // will false-positive — harmless to recall, and a check that over-count never costs us a real one.
    { symbol: "parse", defFile: "src/parse.js", used: true, form: "direct  (note: JSON.parse over-counts)",
      callerFiles: ["src/prune.js", "test/edge-cases.test.js", "test/parse.test.js"] },
  ],
};
