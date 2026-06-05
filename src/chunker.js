// Symbol-level chunker (slice 2). tree-sitter (WASM) splits code into function/method/class
// chunks with line ranges; markdown splits into heading sections. These chunks are the
// structural SUBSTRATE (the `nodes` table) that block-level git-blame (slice 4) and call/
// import edges (slice 5) ride on — recall still gates on the file-level FTS index, so adding
// chunks holds the benchmark exactly (POC: poc/RESULTS.md "Slice-2 — dual-grain, not
// replacement"; pure chunk-BM25 regressed the file-target gate).
//
// Binding: web-tree-sitter pinned to 0.22.6 to match the vendored grammars' ABI. Native
// tree-sitter was ~3x SLOWER for this walk-heavy workload, identical output (POC: binding-bench).

import { fileURLToPath } from "node:url";
import { LANGDEFS, langForExt } from "./langdef.js";
import { dirname, join, extname } from "node:path";
import Parser from "web-tree-sitter";

const GRAMMAR_DIR = join(dirname(fileURLToPath(import.meta.url)), "grammars");

/** @type {Promise<void> | null} */
let initPromise = null;
/** @type {Map<string, any>} grammar filename → ready Parser */
const parsers = new Map();

/**
 * @typedef {Object} Chunk
 * @property {string|null} symbol  symbol name when recoverable, else null
 * @property {string} nodeType     tree-sitter node type, or "preamble" | "section" | "file"
 * @property {number} startLine    0-based, inclusive
 * @property {number} endLine      0-based, inclusive
 * @property {string} text         chunk source text
 */

/**
 * Lazily init the WASM runtime and load a grammar once, caching the ready parser.
 * @param {import("./langdef.js").LangDef} lang
 * @returns {Promise<any>}
 */
async function parserFor(lang) {
  if (!initPromise) initPromise = Parser.init();
  await initPromise;
  let p = parsers.get(lang.grammar);
  if (!p) {
    const language = await Parser.Language.load(join(GRAMMAR_DIR, lang.grammar));
    p = new Parser();
    p.setLanguage(language);
    parsers.set(lang.grammar, p);
  }
  return p;
}

// collect every def-node (recursive — nested methods/classes included; over-counting is
// acceptable per §7, the output is a risk bucket not a precise reference list).
function collectDefs(node, defTypes, out) {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (defTypes.includes(c.type)) out.push(c);
    collectDefs(c, defTypes, out);
  }
  return out;
}

function symbolName(node) {
  const n = node.childForFieldName("name");
  return n ? n.text : null;
}

function fileChunk(body) {
  const lines = body.split("\n");
  return { symbol: null, nodeType: "file", startLine: 0, endLine: Math.max(0, lines.length - 1), text: body };
}

async function chunkCode(lang, body) {
  const parser = await parserFor(lang);
  const tree = parser.parse(body);
  const lines = body.split("\n");
  const defs = collectDefs(tree.rootNode, lang.defTypes, []);

  /** @type {Chunk[]} */
  const chunks = defs.map((d) => ({
    symbol: symbolName(d),
    nodeType: d.type,
    startLine: d.startPosition.row,
    endLine: d.endPosition.row,
    text: lines.slice(d.startPosition.row, d.endPosition.row + 1).join("\n"),
  }));

  // preamble: top-level lines no def-node owns (imports, module-level config/docstring) — so
  // file-level signals (module docstring, top-level constants) still land as a node.
  const covered = new Array(lines.length).fill(false);
  for (const d of defs) for (let i = d.startPosition.row; i <= d.endPosition.row; i++) covered[i] = true;
  const pre = lines.filter((_, i) => !covered[i]).join("\n").trim();
  if (pre) chunks.push({ symbol: null, nodeType: "preamble", startLine: 0, endLine: lines.length - 1, text: pre });
  return { chunks, imports: collectImports(tree.rootNode, lang) };
}

// strip surrounding quotes from a tree-sitter `string` node, preferring its string_fragment child.
function stringText(node) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c.type === "string_fragment") return c.text;
  }
  return node.text.replace(/^['"`]|['"`]$/g, "");
}

// first ES-import `string` child (JS/TS) — present iff this is an ES `import … from "…"`.
function esImportSource(node) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c.type === "string") return stringText(c);
  }
  return null;
}

// one Python import-node → its raw module specifier(s), reconstructed exactly as written
// (absolute "a.b.c", or relative ".x" / "..pkg.name"). `from m import a, b` also emits "m.a"/"m.b"
// so a submodule import resolves to its file. Over-collects safely (§7).
function pyImportSpecs(node, out) {
  if (node.type === "import_statement") {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c.type === "dotted_name") out.push(c.text);
      else if (c.type === "aliased_import") {
        const d = c.namedChild(0); // the dotted_name being aliased
        if (d && d.type === "dotted_name") out.push(d.text);
      }
    }
    return;
  }
  // import_from_statement: first named child is the module (dotted_name | relative_import).
  const kids = [];
  for (let i = 0; i < node.namedChildCount; i++) kids.push(node.namedChild(i));
  if (!kids.length) return;
  const base = kids[0].text; // "aurora_core.activation" | "." | "..pkg"
  out.push(base);
  const rel = base.endsWith("."); // bare relative ("from . import x")
  for (const c of kids.slice(1)) {
    let name = null;
    if (c.type === "dotted_name") name = c.text;
    else if (c.type === "aliased_import") {
      const d = c.namedChild(0);
      name = d && d.type === "dotted_name" ? d.text : null;
    }
    if (name) out.push(rel ? base + name : base + "." + name);
  }
}

// collect raw import specifiers (resolved to files by edges.js). Driven by langdef.importTypes
// for declarative imports, plus require("…") call-expressions for CJS. Recurses fully so
// requires nested in functions are caught; over-collecting is safe (§7).
function collectImports(root, lang) {
  /** @type {string[]} */
  const out = [];
  const types = new Set(lang.importTypes ?? []);
  const py = lang.format === "py";
  (function walk(n) {
    if (types.has(n.type)) {
      if (py) pyImportSpecs(n, out);
      else {
        const s = esImportSource(n); // js/ts ES import
        if (s) out.push(s);
      }
    } else if (lang.requireCalls && n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      if (fn && fn.text === "require") {
        const args = n.childForFieldName("arguments");
        const a = args && args.namedChildCount ? args.namedChild(0) : null;
        if (a && a.type === "string") out.push(stringText(a));
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i));
  })(root);
  return out;
}

// markdown → one chunk per heading section (heading line through the line before the next
// heading), plus a preamble for any text before the first heading.
function chunkMarkdown(body) {
  const lines = body.split("\n");
  const heads = [];
  for (let i = 0; i < lines.length; i++) if (/^#{1,6}\s/.test(lines[i])) heads.push(i);
  if (!heads.length) return [fileChunk(body)];

  /** @type {Chunk[]} */
  const chunks = [];
  if (heads[0] > 0) {
    const t = lines.slice(0, heads[0]).join("\n").trim();
    if (t) chunks.push({ symbol: null, nodeType: "preamble", startLine: 0, endLine: heads[0] - 1, text: t });
  }
  for (let h = 0; h < heads.length; h++) {
    const start = heads[h];
    const end = (h + 1 < heads.length ? heads[h + 1] : lines.length) - 1;
    chunks.push({
      symbol: lines[start].replace(/^#{1,6}\s+/, "").trim(),
      nodeType: "section",
      startLine: start,
      endLine: end,
      text: lines.slice(start, end + 1).join("\n"),
    });
  }
  return chunks;
}

/**
 * Split a file into symbol/section chunks AND collect its import specifiers, in a single parse,
 * routed by extension. Falls back to a single file-level chunk (no imports) for unsupported
 * types or on parse failure — both are additive substrate, recall never depends on them, so
 * this can never throw or block indexing.
 * @param {string} path  repo-relative path
 * @param {string} body  file contents
 * @returns {Promise<{ chunks: Chunk[], imports: string[] }>}
 */
export async function chunkAndImports(path, body) {
  const ext = extname(path).toLowerCase();
  if (ext === ".md") return { chunks: chunkMarkdown(body), imports: [] };
  const lang = langForExt(ext);
  if (!lang) return { chunks: [fileChunk(body)], imports: [] };
  try {
    const { chunks, imports } = await chunkCode(lang, body);
    return { chunks: chunks.length ? chunks : [fileChunk(body)], imports };
  } catch {
    return { chunks: [fileChunk(body)], imports: [] }; // parse error → file-level fallback
  }
}

/**
 * Symbol/section chunks for a file (imports discarded). Thin wrapper over {@link chunkAndImports}.
 * @param {string} path  repo-relative path
 * @param {string} body  file contents
 * @returns {Promise<Chunk[]>}
 */
export async function chunkFile(path, body) {
  return (await chunkAndImports(path, body)).chunks;
}

// ---- impact view (slice 5) primitives — all tree-sitter, no rg here (§7.1) ----

// The called NAME from a call node's `function` field: a bare identifier, or the rightmost
// member/attribute of `a.b.c()` → "c". Member/attribute calls resolve by method NAME only (no
// receiver typing — that is the LSP we deliberately don't have), which over-counts safely (§7.2).
function calleeName(fnNode) {
  if (!fnNode) return null;
  switch (fnNode.type) {
    case "identifier":
    case "property_identifier":
      return fnNode.text;
    case "attribute": { // python  obj.method
      const a = fnNode.childForFieldName("attribute");
      return a ? a.text : null;
    }
    case "member_expression": { // js/ts  obj.method
      const p = fnNode.childForFieldName("property");
      return p ? p.text : null;
    }
    default:
      return null;
  }
}

// nearest enclosing def-node name for a call site (its caller symbol), or null at module top level.
function enclosingDef(node, defTypes) {
  for (let p = node.parent; p; p = p.parent) {
    if (defTypes.has(p.type)) {
      const n = p.childForFieldName("name");
      return n ? n.text : null;
    }
  }
  return null;
}

/**
 * Analyse one symbol's body: the names it CALLS (callees, by name) and its cyclomatic-ish
 * complexity (1 + decision-point count). Tree-sitter only; parse failure → empty/zero (never
 * throws — impact is a hedged view, not a hard dependency). Callees are raw names; the caller
 * resolves them against the indexed symbol set.
 * @param {string} format  "py" | "js" | "ts"
 * @param {string} body    the symbol's source text
 * @returns {Promise<{ calls: string[], complexity: number }>}
 */
export async function analyzeBody(format, body) {
  const lang = LANGDEFS[format];
  if (!lang) return { calls: [], complexity: 0 };
  let tree;
  try {
    tree = (await parserFor(lang)).parse(body);
  } catch {
    return { calls: [], complexity: 0 };
  }
  const callT = new Set(lang.callTypes);
  const branchT = new Set(lang.branchTypes);
  /** @type {string[]} */
  const calls = [];
  let complexity = 1; // the single base path through the symbol
  (function walk(n) {
    if (callT.has(n.type)) {
      const nm = calleeName(n.childForFieldName("function"));
      if (nm) calls.push(nm);
    }
    if (branchT.has(n.type)) complexity++;
    for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i));
  })(tree.rootNode);
  return { calls, complexity };
}

/**
 * Confirmed call sites of `name` in a file body: every place `name` is actually CALLED (not merely
 * mentioned in a comment/string), with the enclosing caller symbol. This is the tree-sitter
 * "confirm" step that turns an `rg -w` candidate into a real caller (§7.1 called-by).
 * @param {string} format  "py" | "js" | "ts"
 * @param {string} body    file contents
 * @param {string} name    callee name to confirm
 * @returns {Promise<{ line: number, enclosing: string|null }[]>}  line is 0-based
 */
export async function callSitesOf(format, body, name) {
  const lang = LANGDEFS[format];
  if (!lang) return [];
  let tree;
  try {
    tree = (await parserFor(lang)).parse(body);
  } catch {
    return [];
  }
  const callT = new Set(lang.callTypes);
  const defT = new Set(lang.defTypes);
  const decoT = new Set(lang.decoratorTypes ?? []);
  /** @type {{ line: number, enclosing: string|null }[]} */
  const out = [];
  (function walk(n) {
    if (callT.has(n.type) && calleeName(n.childForFieldName("function")) === name) {
      out.push({ line: n.startPosition.row, enclosing: enclosingDef(n, defT) });
    } else if (decoT.has(n.type)) {
      // a bare `@name` / `@a.name` decorator APPLIES (= calls) `name` at decoration time. Skip the
      // `@name(...)` form — its child is a call node already counted by the branch above (no double).
      const expr = n.namedChild(0);
      if (expr && !callT.has(expr.type) && calleeName(expr) === name) {
        out.push({ line: n.startPosition.row, enclosing: enclosingDef(n, defT) });
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i));
  })(tree.rootNode);
  return out;
}
