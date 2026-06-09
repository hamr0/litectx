// Slice 5b integration tests — the barrel/path-alias anti-false-isolation mitigation (§7.2). A
// symbol reached only under a re-exported alias (renamed default export, renamed named export) is
// invisible to a name-only `rg -w` sweep and would read as a FALSE isolation. These pin that such
// a symbol resolves to its real callers, that attribution is SCOPED to consumers importing the
// alias FROM the barrel (an unrelated same-named symbol is never miscredited), and the unit-level
// specifier resolver behind the scoping.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";
import { loadTsPaths, specResolvesTo } from "../src/tsalias.js";

// A TS app with a barrel (src/index.ts) reached via the `@lib` path alias. `drawWidget` is the
// DEFAULT export of widget.ts, renamed to `Widget` by the barrel — its own name appears nowhere
// outside its def. `compute` is a named export renamed to `calc`. decoy.ts defines an UNRELATED
// `Widget`; other.ts imports THAT one (not the barrel's) and calls it — the precision trap.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "litectx-alias-"));
  mkdirSync(join(root, "src"));
  const w = (p, lines) => writeFileSync(join(root, p), lines.join("\n") + "\n");

  w("tsconfig.json", ['{ "compilerOptions": { "baseUrl": ".", "paths": {', '  "@lib": ["./src/index.ts"], "@lib/*": ["./src/*"] } } }']);
  w("src/widget.ts", ["export default function drawWidget(n) {", "  return n > 0 ? n : 0;", "}"]);
  w("src/math.ts", ["export function compute(a) {", "  return a + 1;", "}"]);
  w("src/index.ts", ['export { default as Widget } from "./widget";', 'export { compute as calc } from "./math";']);
  w("src/app.ts", ['import { Widget } from "@lib";', 'import { calc } from "@lib";', "export function app() {", "  return Widget(calc(2));", "}"]);
  // decoy: an unrelated `Widget`, called LOCALLY — must NOT be credited to drawWidget.
  w("src/decoy.ts", ["export function Widget() {", '  return "decoy";', "}", "export function useDecoy() {", "  return Widget();", "}"]);
  // other: imports `Widget` from the DECOY, not the barrel — must NOT be credited to drawWidget.
  w("src/other.ts", ['import { Widget } from "./decoy";', "export function other() {", "  return Widget();", "}"]);
  return root;
}

async function withCtx(fn) {
  const root = fixture();
  const ctx = new LiteCtx({ root, include: [".ts"], dbPath: ":memory:" });
  await ctx.index();
  try {
    await fn(ctx);
  } finally {
    ctx.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("a renamed DEFAULT export reached via barrel + path alias is not isolated (§7.2)", async () => {
  await withCtx(async (ctx) => {
    const r = await ctx.impact("drawWidget");
    assert.ok(r);
    assert.ok(r.refCount > 0, "name-only sweep finds 0; alias resolution lifts it above isolated");
    const callerPaths = r.callers.map((c) => c.path);
    assert.ok(callerPaths.includes("src/app.ts"), "app.ts calls it as Widget()");
    assert.ok(r.callers.some((c) => c.path === "src/app.ts" && c.alias === "Widget"), "attributed to the alias it travelled under");
  });
});

test("alias attribution is scoped — an unrelated same-named symbol is never miscredited", async () => {
  await withCtx(async (ctx) => {
    const r = await ctx.impact("drawWidget");
    assert.ok(r);
    const callerPaths = r.callers.map((c) => c.path);
    assert.ok(!callerPaths.includes("src/decoy.ts"), "decoy's LOCAL Widget() is not a caller of drawWidget");
    assert.ok(!callerPaths.includes("src/other.ts"), "other.ts imports Widget from decoy, NOT the barrel — excluded");
  });
});

test("a renamed NAMED export resolves its aliased caller", async () => {
  await withCtx(async (ctx) => {
    const r = await ctx.impact("compute");
    assert.ok(r);
    assert.ok(r.callers.some((c) => c.path === "src/app.ts" && c.alias === "calc"), "calc(2) in app.ts is a caller of compute");
  });
});

test("the rename is surfaced as a hedge — never a silent resolution", async () => {
  await withCtx(async (ctx) => {
    const r = await ctx.impact("drawWidget");
    assert.ok(r);
    assert.ok(r.hedges.some((h) => /re-exported alias/.test(h)), "blast radius via an alias is explained, not a mystery");
  });
});

test("specResolvesTo handles relative specifiers and tsconfig path aliases", () => {
  const tsPaths = { baseDir: "", entries: [
    { prefix: "@lib", suffix: "", wildcard: false, targets: ["./src/index.ts"] },
    { prefix: "@lib/", suffix: "", wildcard: true, targets: ["./src/*"] },
  ] };
  // relative, with extension + index resolution
  assert.equal(specResolvesTo("src/index.ts", "./widget", "src/widget.ts", tsPaths), true);
  assert.equal(specResolvesTo("src/app.ts", "./widget", "src/other.ts", tsPaths), false);
  // exact alias → barrel; wildcard alias → module
  assert.equal(specResolvesTo("src/app.ts", "@lib", "src/index.ts", tsPaths), true);
  assert.equal(specResolvesTo("src/app.ts", "@lib/math", "src/math.ts", tsPaths), true);
  // a bare external specifier resolves to nothing intra-repo
  assert.equal(specResolvesTo("src/app.ts", "react", "src/index.ts", null), false);
});

test("loadTsPaths returns null when there is no tsconfig (relative resolution still works)", () => {
  const root = mkdtempSync(join(tmpdir(), "litectx-nots-"));
  try {
    assert.equal(loadTsPaths(root), null);
    // with no alias map, a relative specifier still resolves; an alias one simply does not.
    assert.equal(specResolvesTo("src/index.ts", "./widget", "src/widget.ts", null), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
