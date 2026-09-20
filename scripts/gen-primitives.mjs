#!/usr/bin/env node
// Generate primitives.json from JSDoc. A primitive is any exported symbol — or
// any documented method of an exported class — whose JSDoc carries an @when tag.
// Signature/import are derived; @when/@fails are the only hand-authored fields.
// Ported from bareagent's generator (2026-09-19); the one litectx-specific edit
// is inferCategory() + the class-method branch (litectx's verbs are methods on
// LiteCtx/ScopedView, not top-level exports).
//
//   node scripts/gen-primitives.mjs           # write ./primitives.json
//   node scripts/gen-primitives.mjs --check    # CI gate: verify the file is current + valid, write nothing
//
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, resolve, basename, relative } from "node:path";

const CWD = process.cwd();
const CHECK = process.argv.includes("--check");
const pkg = JSON.parse(readFileSync(join(CWD, "package.json"), "utf8"));

// --- JSDoc extraction ---------------------------------------------------------
const strip = (l) => l.replace(/^\s*\*\s?/, "");
// A JSDoc type is written for tsc, which resolves `import("./x").T` relative to
// the SOURCE file. Read out of node_modules that path means nothing, so strip the
// import() wrapper and keep the bare type name for the manifest's human reader.
const cleanType = (t) => (t || "").replace(/import\((["'])[^"')]+\1\)\./g, "");
function braced(s) {
  const start = s.indexOf("{"); if (start === -1) return null;
  let d = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "{") d++;
    else if (s[i] === "}" && --d === 0) return { inner: s.slice(start + 1, i), rest: s.slice(i + 1) };
  }
  return null;
}
function parseBlock(block) {
  const inner = block.replace(/^\/\*\*/, "").replace(/\*\/\s*$/, "");
  const params = []; let returns = null, when = null, fails = null, category = null, primName = null;
  let type = null, sigOverride = null;
  const example = []; let mode = null;
  for (const raw of inner.split("\n").map(strip)) {
    const tag = raw.trimEnd().match(/^@(\w+)\s*(.*)$/);
    if (tag) {
      mode = null; const [, name, rest] = tag;
      if (name === "param") {
        const b = braced(rest); const nm = b && b.rest.match(/^\s*(\[?)([\w.$]+)/);
        if (b && nm && !nm[2].includes(".")) params.push({ name: nm[2], type: cleanType(b.inner), optional: nm[1] === "[" });
      } else if (name === "returns") { const b = braced(rest); returns = b ? cleanType(b.inner) : null; }
      else if (name === "type") { const b = braced(rest); type = b ? cleanType(b.inner) : null; }
      else if (name === "signature") sigOverride = rest.trim(); // exact literal, overrides the derived signature
      else if (name === "when") when = rest.trim();
      else if (name === "fails") fails = rest.trim();
      else if (name === "category") category = rest.trim();
      else if (name === "name") primName = rest.trim(); // override when the export name differs from the declaration (alias)
      else if (name === "example") mode = "example";
      continue;
    }
    if (mode === "example") example.push(raw);
  }
  while (example.length && !example[0].trim()) example.shift();
  while (example.length && !example[example.length - 1].trim()) example.pop();
  // Dedent by the COMMON leading-whitespace prefix so nested literals/blocks keep
  // their RELATIVE indentation (a fixed 0-3 char cut flattened multi-line examples).
  const indents = example.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length);
  const pad = indents.length ? Math.min(...indents) : 0;
  if (pad) for (let i = 0; i < example.length; i++) example[i] = example[i].slice(pad);
  return { params, returns, type, sigOverride, when, fails, category, primName, example: example.join("\n") };
}

// JS keywords / accessor prefixes a method-shaped line could start with — a
// `@when` only ever sits above a real method, but the guard is cheap insurance
// against a control-flow line (`if (`, `for (`, …) reading as a method name.
const NOT_A_METHOD = new Set([
  "if", "for", "while", "switch", "catch", "return", "constructor",
  "function", "async", "await", "new", "typeof", "throw", "do", "else",
]);
// The enclosing class: the nearest class DECLARATION before `idx`. Line-anchored
// (`^\s*(export )?(default )?class Name`) so a prose "first-class API" or a
// `class` inside a string never reads as the class name (litectx's source has
// several — the loose /class\s+\w+/ captured "public" from "first-class public").
function enclosingClass(src, idx) {
  const cm = [...src.slice(0, idx).matchAll(/^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z0-9_$]+)/gm)].pop();
  return cm ? cm[1] : null;
}
function symbolAfter(src, afterIdx) {
  const tail = src.slice(afterIdx);
  const decl = tail.match(/^\s*(?:export\s+)?(?:async\s+)?(function|class)\s+([A-Za-z0-9_$]+)/);
  if (decl) return { name: decl[2], kind: decl[1] === "class" ? "class" : "function" };
  if (/^\s*(?:async\s+)?constructor\s*\(/.test(tail)) {
    const cls = enclosingClass(src, afterIdx);
    if (cls) return { name: cls, kind: "class" };
  }
  // A const bound to a function/arrow is a callable; a const bound to DATA is a
  // value — rendering the latter as `X()` invents an API that does not exist.
  const cst = tail.match(/^\s*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*([\s\S]{0,40})/);
  if (cst) {
    const callable = /^(?:async\s+)?(?:function\b|<[^>]*>\s*\(|\((?:[^()]|\([^()]*\))*\)\s*=>|[A-Za-z0-9_$]+\s*=>)/.test(cst[2]);
    return { name: cst[1], kind: callable ? "function" : "value" };
  }
  // LAST: a class METHOD. litectx's verbs (recall/impact/get/…) are methods on
  // LiteCtx/ScopedView, not top-level exports. Require an enclosing class (the
  // same backscan the constructor branch uses) so a top-level bare `foo()`
  // expression can't read as a method. Handle static/get/set/* prefixes so the
  // captured name is the method, not the prefix keyword.
  const meth = tail.match(/^\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+|\*\s*)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
  if (meth && !NOT_A_METHOD.has(meth[1]) && !meth[1].startsWith("_")) {
    const isStatic = /^\s*static\b/.test(tail);
    const cls = enclosingClass(src, afterIdx);
    if (cls) return { name: meth[1], kind: "method", className: cls, static: isStatic };
  }
  return null;
}
// Receiver name shown in a method signature. A tiny explicit map beats
// camelCasing edge cases — extend it when a new exported class gains verbs.
const RECEIVERS = { LiteCtx: "liteCtx", ScopedView: "view" };
const receiverFor = (cls) => RECEIVERS[cls] || (cls ? cls[0].toLowerCase() + cls.slice(1) : "obj");
function signature(sym, p) {
  if (p.sigOverride) return p.sigOverride;
  if (sym.kind === "value") return `${sym.name}: ${p.type || "unknown"}`;
  const args = p.params.map((a) => `${a.name}${a.optional ? "?" : ""}: ${a.type}`).join(", ");
  const ret = p.returns ? ` => ${p.returns}` : "";
  if (sym.kind === "class") return `new ${sym.name}(${args})`;
  if (sym.kind === "method") {
    const recv = sym.static ? sym.className : receiverFor(sym.className);
    return `${recv}.${sym.name}(${args})${ret}`;
  }
  return `${sym.name}(${args})${ret}`;
}

// --- category inference (filename -> category; @category overrides) -----------
// litectx keeps most verbs in src/index.js (they are methods on one class), so
// file-based inference lands them all in 'core' — the per-verb category comes
// from an explicit @category tag. This map only carries the multi-file cases.
function inferCategory(file) {
  const b = basename(file, ".js");
  if (b === "impact" || b === "tsalias") return "impact";
  if (b === "compress" || b === "assemble") return "CE";
  if (b === "contextgraph") return "graph";
  if (b === "embedder") return "embeddings";
  if (b === "memory-store") return "memory";
  if (b === "writegate") return "governance";
  if (b === "docparse") return "ingest";
  return "core";
}

// --- import-path resolution from the exports map ------------------------------
async function exportIndex() {
  const map = new Map(); // symbol -> subpath specifier (prefers main '.')
  const importErrors = []; // a barrel that FAILS to import is a distinct, loud failure...
  const exp = pkg.exports || { ".": { default: pkg.main || "./index.js" } };
  for (const [sub, entry] of Object.entries(exp)) {
    const file = typeof entry === "string" ? entry : entry.default || entry.import || entry.require;
    if (!file) continue;
    const target = typeof file === "string" ? file : file.default;
    // Only JS barrels export symbols. Skip a data subpath (e.g. "./primitives.json" itself) — importing
    // it would throw ("needs an import attribute of type: json") and, since a barrel-import failure is
    // fatal by design, abort the whole generation.
    if (typeof target !== "string" || !/\.(js|mjs|cjs)$/.test(target)) continue;
    const abs = resolve(CWD, target);
    if (!existsSync(abs)) continue;
    let names = [];
    // Runtime import (not a static scan) so `export { X } from './y'` re-exports resolve to their
    // real names. The cost: importing the barrel loads its runtime deps (better-sqlite3, …). If that
    // throws (unbuilt native binding, ABI mismatch), record it as its OWN error — swallowing it would
    // leave the map empty and mislabel every primitive "not found in barrel", hiding the real cause.
    try { names = Object.keys(await import(pathToFileURL(abs).href)).filter((n) => n !== "default"); }
    catch (e) { importErrors.push(`could not import exports barrel "${file}": ${e.message}`); continue; }
    const spec = sub === "." ? pkg.name : `${pkg.name}/${sub.replace(/^\.\//, "")}`;
    for (const n of names) {
      // prefer the main barrel when a symbol is re-exported from several
      if (!map.has(n) || sub === ".") map.set(n, spec);
    }
  }
  return { map, importErrors };
}

// --- scan --------------------------------------------------------------------
// A hand-rolled recursive walker (not readdirSync's `recursive`, which only
// landed in 18.17) keeps litectx's node >=18 floor; skips symlinks.
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isSymbolicLink()) return [];
    return e.isDirectory() ? walk(join(dir, e.name))
      : e.name.endsWith(".js") ? [join(dir, e.name)] : [];
  });
}
const ROOTS = ["src"].filter((d) => existsSync(join(CWD, d)));
const { map: imports, importErrors } = await exportIndex();
// A barrel that failed to load resolves NOTHING — bail with the real cause rather than proceed to
// flag every primitive "not found in barrel" (which would bury this behind noise).
if (importErrors.length) {
  console.error(`✗ could not build the exports index — fix this before generating:\n  ` + importErrors.join("\n  "));
  process.exit(1);
}
const out = [], problems = [];
const jsFiles = ROOTS.flatMap((d) => walk(join(CWD, d)).map((abs) => relative(CWD, abs)));
for (const rel of jsFiles) {
  const f = basename(rel);
  const src = readFileSync(join(CWD, rel), "utf8");
  const re = /\/\*\*[\s\S]*?\*\//g; let m;
  while ((m = re.exec(src))) {
    if (!/@when\b/.test(m[0])) continue;
    const sym = symbolAfter(src, m.index + m[0].length);
    if (!sym) { problems.push(`${f}: @when block has no resolvable symbol`); continue; }
    const p = parseBlock(m[0]);
    const name = p.primName || sym.name; // @name overrides an aliased export
    for (const req of ["when", "fails", "example"]) if (!p[req]) problems.push(`${name}: missing @${req}`);
    // import: a method is reached through its class, so look up the CLASS name.
    const importName = sym.kind === "method" ? sym.className : name;
    const spec = imports.get(importName);
    if (!spec) problems.push(`${name}: ${importName} not found in any exports barrel (is it exported?)`);
    out.push({
      name,
      category: p.category || inferCategory(rel),
      when: p.when,
      import: `import { ${importName} } from '${spec || pkg.name}'`,
      signature: signature({ ...sym, name }, p),
      fails: p.fails,
      example: p.example,
    });
  }
}
out.sort((a, b) => a.name.localeCompare(b.name));
// No `version` field by design: package.json sits beside the manifest in the
// same tarball with the authoritative version, so a copy here would only be a
// pin that goes silently stale on every release. The manifest is pure content.
const manifest = { package: pkg.name, primitives: out };
const json = JSON.stringify(manifest, null, 2) + "\n";
const target = join(CWD, "primitives.json");

if (problems.length) {
  console.error(`✗ ${problems.length} problem(s):\n  ` + problems.join("\n  "));
  process.exit(1);
}
if (CHECK) {
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (current !== json) {
    console.error("✗ primitives.json is stale — run `npm run build:primitives` and commit the result.");
    process.exit(1);
  }
  console.error(`✓ primitives.json current — ${out.length} primitive(s).`);
} else {
  writeFileSync(target, json);
  console.error(`✓ wrote primitives.json — ${out.length} primitive(s): ${out.map((e) => e.name).join(", ")}`);
}
