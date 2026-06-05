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
import { dirname, join, extname } from "node:path";
import Parser from "web-tree-sitter";
import { langForExt } from "./langdef.js";

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
  return chunks;
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
 * Split a file into symbol/section chunks, routed by extension. Falls back to a single
 * file-level chunk for unsupported types or on parse failure — chunks are additive substrate,
 * recall never depends on them, so this can never throw or block indexing.
 * @param {string} path  repo-relative path
 * @param {string} body  file contents
 * @returns {Promise<Chunk[]>}
 */
export async function chunkFile(path, body) {
  const ext = extname(path).toLowerCase();
  if (ext === ".md") return chunkMarkdown(body);
  const lang = langForExt(ext);
  if (!lang) return [fileChunk(body)];
  try {
    const chunks = await chunkCode(lang, body);
    return chunks.length ? chunks : [fileChunk(body)];
  } catch {
    return [fileChunk(body)]; // parse error → file-level fallback
  }
}
