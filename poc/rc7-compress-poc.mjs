// R-C7 compress(node,{level}) POC — the LOAD-BEARING question (PRD §8.1, ledger §13.1):
//
//   The aurora-borrow ledger CLAIMS "litectx already extracts signature/docstring, so the
//   render unit is free." That is FALSE — the chunker stores only `text` (full body); there is
//   NO signature/docstring column. So R-C7's middle tier must DERIVE signature+docstring from
//   the stored body. This POC measures whether a cheap body-only derivation works across
//   TS/JS/Python — or whether R-C7 needs a schema change (extract+store at index time).
//
// Three render levels (aurora CHUNK_LIMITS shape):
//   verbatim  → full body                (trivial — not the risk)
//   signature → def header + docstring    (THE RISK — measured here)
//   drop      → 1-line stub               (trivial — not the risk)
//
// Run: node poc/rc7-compress-poc.mjs
import { chunkFile } from "../src/chunker.js";

// Real multi-construct samples per language. Docstring placement differs by language:
//   Python  → docstring is INSIDE the def (first statement) → in body.
//   JS/TS   → JSDoc block is a SIBLING node ABOVE the def → NOT in the tree-sitter def body.
// That asymmetry is the whole question.
const SAMPLES = {
  "sample.py": `import os

def add(a, b):
    """Return the sum of a and b."""
    return a + b

class Cache:
    """A tiny in-memory cache."""

    def get(self, key, default=None):
        # leading comment, not a docstring
        return self._d.get(key, default)

def no_doc(x):
    return x * 2
`,
  "sample.js": `import { readFileSync } from "node:fs";

/**
 * Add two numbers.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function add(a, b) {
  return a + b;
}

// plain comment, not jsdoc
export function noDoc(x) {
  return x * 2;
}

export const mul = (a, b) => a * b;
`,
  "sample.ts": `interface Opts { trim: boolean }

/** Render a node at a given level. */
export function compress(node: Node, opts: Opts): string {
  return node.body;
}

export class Store {
  /** Open the db. */
  open(path: string): void {}
}
`,
};

// ── candidate derivations (vanilla-JS first per the dependency hierarchy) ──────────────────

/** Signature = body up to the first body-opening token ({ or :) on the def line(s). */
function deriveSignature(text, nodeType) {
  const lines = text.split("\n");
  // find first non-comment, non-blank line as the header start
  let i = 0;
  while (i < lines.length && (lines[i].trim() === "" || lines[i].trim().startsWith("//") || lines[i].trim().startsWith("*") || lines[i].trim().startsWith("/*"))) i++;
  const header = [];
  for (; i < lines.length; i++) {
    header.push(lines[i]);
    if (/[{:]\s*$/.test(lines[i]) || /=>\s*[^{]/.test(lines[i])) break; // brace, py colon, or arrow-expr
    if (header.length > 4) break; // runaway guard
  }
  return header.join("\n").trim();
}

// Docstring: Python = first triple-quoted string after the colon; JS/TS = leading JSDoc block.
function deriveDocstring(text, format) {
  if (format === "py") {
    const m = text.match(/:\s*\n\s*("""|''')([\s\S]*?)\1/);
    return m ? m[2].trim() : null;
  }
  // JS/TS: a /** ... */ at the very top of the chunk text
  const m = text.match(/^\s*\/\*\*([\s\S]*?)\*\//);
  if (!m) return null;
  return m[1].replace(/^\s*\*\s?/gm, "").trim();
}

const fmtOf = (p) => (p.endsWith(".py") ? "py" : p.endsWith(".ts") ? "ts" : "js");

// Ground truth: does the SOURCE attach a doc to THIS chunk? Python → triple-quote as 1st stmt
// inside the body; JS/TS → a JSDoc block on the ~3 lines immediately above the def's start.
function sourceHasDoc(src, chunkText, format) {
  if (format === "py") return /:\s*\n\s*("""|''')/.test(chunkText);
  const at = src.indexOf(chunkText);
  if (at < 0) return false;
  const before = src.slice(0, at).trimEnd();
  return before.endsWith("*/") && /\/\*\*[\s\S]*\*\/$/.test(before.slice(Math.max(0, before.length - 400)));
}

// ── run ────────────────────────────────────────────────────────────────────────────────────
let total = 0, sigOk = 0;
const docStat = { py: { exp: 0, got: 0 }, js: { exp: 0, got: 0 }, ts: { exp: 0, got: 0 } };
const rows = [];

for (const [path, src] of Object.entries(SAMPLES)) {
  const format = fmtOf(path);
  const chunks = await chunkFile(path, src);
  for (const c of chunks) {
    if (c.nodeType === "preamble" || c.nodeType === "file") continue; // not renderable defs
    total++;
    const sig = deriveSignature(c.text, c.nodeType);
    const doc = deriveDocstring(c.text, format);
    // a signature is "ok" if it's non-empty and no longer than the body (single-line defs tie)
    const ok = sig.length > 0 && sig.length <= c.text.length;
    if (ok) sigOk++;
    const hasDoc = sourceHasDoc(src, c.text, format);
    if (hasDoc) { docStat[format].exp++; if (doc) docStat[format].got++; }
    rows.push({ path, symbol: c.symbol, nodeType: c.nodeType, bodyLen: c.text.length, sigLen: sig.length, ok, hasDoc, doc: doc ? "✓" : "—", sig: sig.replace(/\n/g, "⏎").slice(0, 50) });
  }
}

console.log("R-C7 compress() — body-only signature+docstring derivation\n");
console.table(rows);
console.log(`\nsignature derivable: ${sigOk}/${total} (${(100 * sigOk / total).toFixed(0)}%) — body-only, all langs`);
console.log("docstring recovered (of docs present in source), by language:");
for (const [f, s] of Object.entries(docStat)) console.log(`  ${f}: ${s.got}/${s.exp}${s.exp ? ` (${(100 * s.got / s.exp).toFixed(0)}%)` : ""}`);
console.log("\nLOAD-BEARING READ: if docstring recovery is low for JS/TS, the JSDoc lives ABOVE the");
console.log("tree-sitter def node and is NOT in the chunk body → R-C7 needs a schema change");
console.log("(capture the leading comment at index time) OR compress() must re-read source lines.");
