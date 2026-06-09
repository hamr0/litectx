// Composing-scenario integration test — the v1 surface end to end: index ONCE, then both views
// (recall + impact) read the SAME graph. This is the doctrine claim the per-view suites don't pin:
// the graph is one shared substrate, the views are reads over it, NOT re-extractions (CLAUDE.md —
// "views over the same data"). So this test proves coherence ACROSS views on a single index pass:
//   - the file recall surfaces for a concept is the same node impact names as that symbol's def;
//   - impact's callees/callers are themselves indexed symbols both views can see;
//   - the graph is navigable both directions (a callee links back as a caller);
//   - running the views never mutates or rebuilds the graph (docs/nodes/edges counts hold).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

// A small realistic app with a real import chain (handler → auth → crypto) so a single index pass
// produces both the FTS rows recall ranks AND the import edges + symbol nodes impact traverses.
// Non-git → indexed via the filesystem-walk fallback (like impact.test.js).
function fixtureApp() {
  const root = mkdtempSync(join(tmpdir(), "litectx-compose-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "crypto.js"),
    [
      "export function verifySignature(token) {",
      "  // verify the cryptographic signature carried by a token",
      "  return token.length > 0;",
      "}",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(root, "src", "auth.js"),
    [
      'import { verifySignature } from "./crypto.js";',
      "",
      "// Authentication entrypoint: validate an incoming session token.",
      "export function validateToken(token) {",
      "  if (!token) return false;",
      "  return verifySignature(token);",
      "}",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(root, "src", "handler.js"),
    [
      'import { validateToken } from "./auth.js";',
      "",
      "export function handleLogin(request) {",
      "  return validateToken(request.token);",
      "}",
      "export function handleRefresh(request) {",
      "  return validateToken(request.token);",
      "}",
      "",
    ].join("\n")
  );
  // an unrelated module + a doc — a distractor for recall, and a second `kind` in the same graph.
  writeFileSync(
    join(root, "src", "mailer.js"),
    "export function sendEmail(recipient, body) {\n  return recipient && body;\n}\n"
  );
  writeFileSync(join(root, "README.md"), "# Demo Service\nHandles user authentication and sends email notifications.\n");
  return root;
}

async function withApp(fn) {
  const root = fixtureApp();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  try {
    await fn(ctx);
  } finally {
    ctx.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("recall and impact compose over a single index pass — same graph, both directions", async () => {
  await withApp(async (ctx) => {
    // ---- ONE extraction. Everything below reads this graph; nothing re-indexes. ----
    const res = await ctx.index();
    assert.equal(res.added, 5, "4 js modules + 1 md indexed in one pass");
    assert.equal(res.files, 5);

    // Fingerprint the graph built by that single pass: docs (FTS), symbol nodes, import edges.
    const docs0 = ctx.size();
    const nodes0 = ctx.store.nodeCount();
    const edges0 = ctx.store.edgeCount();
    assert.ok(nodes0 >= 4, `expected the function nodes in the graph (got ${nodes0})`);
    assert.ok(edges0 >= 2, `expected the import chain's edges (handler→auth, auth→crypto) (got ${edges0})`);

    // ---- recall view: find the auth concept → top code hit is the file that defines it. ----
    const hits = (await ctx.recall("authentication entrypoint validate session token", { kind: "code" }));
    assert.ok(hits.length > 0, "recall returns hits");
    assert.equal(hits[0].path, "src/auth.js", "recall ranks the defining file first");

    // ---- impact view, SAME ctx, no re-index: the symbol recall pointed at, assessed in place. ----
    const imp = await ctx.impact("validateToken");
    assert.ok(imp, "validateToken is in the shared index");
    // Cross-view node identity: the file recall surfaced IS the def site impact reports — one graph.
    assert.equal(imp.defs.length, 1);
    assert.equal(imp.defs[0].path, "src/auth.js", "impact's def site matches recall's top hit");
    // Down the chain: validateToken calls verifySignature (an intra-repo callee).
    assert.ok(imp.callees.includes("verifySignature"), `callees should include verifySignature (got ${imp.callees})`);
    // Up the chain: both handler functions are confirmed callers, in handler.js.
    const callerSyms = imp.callers.map((c) => c.symbol).sort();
    assert.deepEqual(callerSyms, ["handleLogin", "handleRefresh"], "confirmed callers from handler.js");
    assert.ok(imp.callers.every((c) => c.path === "src/handler.js"), "all calls live in handler.js");

    // ---- the graph is navigable BOTH ways: a callee of validateToken links back to it as a caller. ----
    const down = await ctx.impact("verifySignature");
    assert.ok(down, "the callee is itself an indexed symbol — same node set");
    assert.equal(down.defs[0].path, "src/crypto.js");
    assert.ok(
      down.callers.some((c) => c.symbol === "validateToken" && c.path === "src/auth.js"),
      "verifySignature's caller is validateToken — the callee edge traverses back as a caller edge"
    );

    // ---- coherence: every symbol either view names is in the one shared node set. ----
    const names = ctx.store.allSymbolNames();
    for (const callee of imp.callees) assert.ok(names.has(callee), `callee ${callee} is an indexed node`);
    for (const c of imp.callers) assert.ok(names.has(c.symbol), `caller ${c.symbol} is an indexed node`);

    // ---- views are READS, not re-extractions: the graph is byte-for-byte unchanged after all of it. ----
    assert.equal(ctx.size(), docs0, "recall + impact never touched the doc count");
    assert.equal(ctx.store.nodeCount(), nodes0, "...nor the node count");
    assert.equal(ctx.store.edgeCount(), edges0, "...nor the edge count — no re-extraction");
  });
});

test("a symbol discovered through recall hands off to impact with no re-index", async () => {
  await withApp(async (ctx) => {
    await ctx.index();

    // The realistic loop: an agent recalls a concept, picks a symbol from a hit, then asks impact
    // to weigh the change — all against the graph already in memory.
    const grouped = (await ctx.recall("handle login authentication"));
    const codePaths = grouped.code.map((h) => h.path);
    assert.ok(codePaths.includes("src/handler.js"), `recall surfaces the handler (got ${codePaths})`);
    // the doc kind is ranked separately in the same call — one graph, two non-competing lists.
    assert.ok(grouped.doc.some((h) => h.path === "README.md"), "the README is recalled under its own kind");

    // Hand the discovered symbol straight to impact — one hop down lands on validateToken, the
    // same symbol the first test assessed from the other end. The chain closes on one graph.
    const imp = await ctx.impact("handleLogin");
    assert.ok(imp);
    assert.equal(imp.defs[0].path, "src/handler.js", "impact agrees on where recall's hit is defined");
    assert.ok(imp.callees.includes("validateToken"), `handleLogin's callee is validateToken (got ${imp.callees})`);
  });
});
