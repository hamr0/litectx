// Completeness guard for the primitives manifest (primitives.json).
// A primitive is any exported symbol — OR any documented method of an exported
// class — whose JSDoc carries @when. This test fails if a PUBLIC surface symbol
// is neither in primitives.json nor on the deliberate-exclusion allow-list, so a
// NEW export/verb can never silently miss the manifest.
//
// litectx-specific vs bareagent's original: litectx's verbs are METHODS on
// LiteCtx/ScopedView (class methods are non-enumerable, so Object.keys misses
// them). allSurface() therefore also walks getOwnPropertyNames(Cls.prototype) —
// without that, manifesting `LiteCtx` alone would satisfy a toothless guard that
// enforces nothing about the verbs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as barrel from "../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "primitives.json"), "utf8"));
const manifested = new Set(manifest.primitives.map((p) => p.name));

// Exported classes whose PROTOTYPE methods are part of the public verb surface.
const VERB_CLASSES = ["LiteCtx", "ScopedView"];

// Deliberate exclusions — WHY each is out. A primitive is "something an agent or
// adopter code invokes as an automation step"; the entries here are caught,
// read, or internal, not invoked as a capability.
const EXCLUDED = new Set([
  // Error classes: you catch them, you don't construct them as a capability.
  "StalePointerError", "RipgrepMissingError", "WriteDeniedError", "WriteAudit",
  // Vocabulary constants: data you read/compare against, not a callable primitive.
  "KINDS", "WRITE_KINDS", "GLOBAL", "COMPRESS_LEVELS",
  "PRIMITIVES", "VERBS_BY_PRIMITIVE", "PRIMITIVE",
  // Low-level tokenizer internals: exposed for advanced use, not agent primitives.
  "splitIdent", "keywords", "ftsMatch",
  // Low-level embeddings surface: the tier is configured via LiteCtx, not driven directly.
  "Embedder", "cosine",
  // Not constructed directly: obtained via a verb (ScopedView ← liteCtx.scoped();
  // ContextGraph ← observe()) or an advanced/internal store.
  "ScopedView", "ContextGraph", "Store",
  // Object plumbing on every prototype.
  "constructor",
  // LiteCtx methods/accessors left out of the manifest: low-level graph accessors
  // (getNode/related), lifecycle/plumbing (size/close), and the lazy-init embedder
  // getter — internal wiring, not automation verbs.
  "close", "getNode", "related", "size", "embedder",
]);

// Every public surface name: top-level exports PLUS the prototype methods of the
// exported verb classes (non-enumerable → getOwnPropertyNames, not Object.keys).
function allSurface() {
  const names = new Set(Object.keys(barrel));
  for (const cls of VERB_CLASSES) {
    const C = barrel[cls];
    if (typeof C !== "function") continue;
    for (const n of Object.getOwnPropertyNames(C.prototype)) {
      if (n === "constructor" || n.startsWith("_")) continue;
      names.add(n);
    }
  }
  return names;
}

test("every public surface symbol is manifested or explicitly excluded", () => {
  const missing = [...allSurface()].filter((n) => !manifested.has(n) && !EXCLUDED.has(n)).sort();
  assert.deepStrictEqual(missing, [],
    `These public symbols are neither in primitives.json nor on the exclusion allow-list. ` +
    `Add @when/@fails/@example to each (and run \`npm run build:primitives\`), ` +
    `or add it to EXCLUDED here with a reason:\n  ${missing.join("\n  ")}`);
});

test("exclusion allow-list has no stale entries", () => {
  const surface = allSurface();
  // `constructor` is intentionally permanent (every prototype has it); the rest
  // must be a real, currently-unmanifested public symbol.
  const stale = [...EXCLUDED].filter((n) => n !== "constructor" && (manifested.has(n) || !surface.has(n))).sort();
  assert.deepStrictEqual(stale, [],
    `EXCLUDED entries that are now manifested or no longer on the public surface — remove them:\n  ${stale.join("\n  ")}`);
});

test("primitives.json is reachable via the package exports subpath", () => {
  // Shipping the file in `files` is not enough: with an `exports` map present,
  // Node blocks any subpath not listed (ERR_PACKAGE_PATH_NOT_EXPORTED), so a
  // consumer's `import 'litectx/primitives.json'` fails unless the subpath is
  // exported. Guards the 0.33.1 fix.
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.exports?.["./primitives.json"], "./primitives.json",
    "package.json exports must map './primitives.json' so consumers can import the manifest by subpath");
});

test("primitives.json subpath actually resolves and loads at runtime", async () => {
  // The assertion above only string-compares the exports config — it would stay
  // green even if the mapping pointed at a nonexistent file, or if Node's own
  // self-reference resolution broke for some other reason. This drives REAL
  // module resolution: Node lets a package import itself by its own `name` when
  // `exports` is defined (self-referencing, works from anywhere inside the repo,
  // no publish/install needed), so `import 'litectx/primitives.json'` here goes
  // through the exact same exports-map lookup a real consumer's `npm i litectx`
  // would hit. If the subpath is removed or broken, this throws
  // ERR_PACKAGE_PATH_NOT_EXPORTED (or a resolution error), not a string mismatch.
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const mod = await import(`${pkg.name}/primitives.json`, { with: { type: "json" } });
  const loaded = mod.default;
  assert.ok(Array.isArray(loaded.primitives) && loaded.primitives.length > 0,
    "resolved primitives.json did not load a non-empty primitives array");
  assert.deepStrictEqual(Object.keys(loaded).sort(), ["package", "primitives"]);
});

test("every JS export subpath resolves through the package name", async () => {
  // Derive entry points from the exports MAP (never a hardcoded barrel path) and
  // resolve each through the package NAME via Node self-referencing — the exact
  // lookup a consumer's `import 'litectx'` / `import 'litectx/x'` performs. A broken
  // exports target (renamed/missing file, wrong condition) fails HERE with a clean
  // named failure, instead of surfacing only indirectly as a misleading "stale
  // manifest" error from the generator's --check. Auto-covers any future JS subpath.
  // Data subpaths (*.json) are covered by the dedicated primitives.json test above
  // and skipped here (importing one needs a JSON import attribute).
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const targetOf = (v) => (typeof v === "string" ? v : v?.default ?? v?.import ?? "");
  const jsSubpaths = Object.entries(pkg.exports || {})
    .filter(([, v]) => !String(targetOf(v)).endsWith(".json"))
    .map(([k]) => k);
  assert.ok(jsSubpaths.includes("."), "expected the main '.' export to be present in the exports map");
  for (const sub of jsSubpaths) {
    const spec = sub === "." ? pkg.name : `${pkg.name}/${sub.slice(2)}`;
    let mod;
    try {
      mod = await import(spec);
    } catch (e) {
      assert.fail(`export subpath "${sub}" does not resolve as "${spec}" — a consumer's import would break: ${e.code || e.message}`);
    }
    assert.ok(Object.keys(mod).length > 0, `export subpath "${sub}" resolved but exported nothing`);
  }
});

test("committed primitives.json is not stale — matches the generator's current output", () => {
  // Name coverage + field presence above do NOT catch a reworded @when/@fails that
  // was never regenerated. This runs the generator's own `--check` so `npm test`
  // gates content staleness everywhere (locally + CI), not just in a publish step.
  const gen = join(ROOT, "scripts", "gen-primitives.mjs");
  try {
    execFileSync(process.execPath, [gen, "--check"], { stdio: "pipe" });
  } catch (e) {
    assert.fail(`primitives.json is stale or invalid — run \`npm run build:primitives\` and commit:\n${(e.stderr || "").toString()}`);
  }
});

test("manifest is well-formed: every entry has the required fields", () => {
  for (const p of manifest.primitives) {
    for (const f of ["name", "category", "when", "import", "signature", "fails", "example"]) {
      assert.ok(p[f] && String(p[f]).trim(), `primitive ${p.name || "(unnamed)"} missing field: ${f}`);
    }
  }
});

test("manifest shape is exactly {package, primitives} — pins the no-version decision", () => {
  assert.deepStrictEqual(Object.keys(manifest).sort(), ["package", "primitives"]);
});

test("every @example is syntactically valid ESM", () => {
  // A copy-paste example that does not parse is a confident wrong answer.
  // node --check, never executes.
  const dir = mkdtempSync(join(tmpdir(), "prim-ex-"));
  try {
    for (const p of manifest.primitives) {
      const file = join(dir, `${p.name.replace(/[^\w$]/g, "_")}.mjs`);
      writeFileSync(file, p.example + "\n");
      try {
        execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
      } catch (e) {
        assert.fail(`primitive ${p.name}: @example is not valid ESM syntax:\n${p.example}\n\n${(e.stderr || "").toString()}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
