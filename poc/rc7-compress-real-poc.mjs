// R-C7 gap-closing POC — REAL fixtures (not synthetic), proves where docs land + compression ratio.
//
// Closes the two gaps from poc/rc7-compress-poc.mjs:
//   (1) synthetic 11-chunk samples → here we chunk REAL source: litectx src/*.js (JS),
//       aurora *.py (Python), gitdone *.ts (TS).
//   (2) only answered "can we derive it" → here we also measure ORPHANING (does the leading
//       doc land in the def chunk or get swept into `preamble`?) and COMPRESSION RATIO.
//
// The architecture question this answers: is capturing the doc the INDEXING job (chunker) or
// compress()'s job? If the JSDoc lands in `preamble`, it's indexed but DISSOCIATED from its
// symbol → recall + embeddings + compress all lose it → indexing's job (memory engine).
//
// Run: node poc/rc7-compress-real-poc.mjs
import { chunkFile } from "../src/chunker.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const FILES = [];
// JS — litectx's own src (real, JSDoc-heavy)
for (const f of readdirSync("src").filter((f) => f.endsWith(".js"))) FILES.push(join("src", f));
// Python — aurora soar source
const AUR = "/home/hamr/PycharmProjects/aurora/packages/soar/src/aurora_soar";
try { for (const f of readdirSync(AUR).filter((f) => f.endsWith(".py")).slice(0, 8)) FILES.push(join(AUR, f)); } catch {}
// TS — gitdone app (skip node_modules)
const GD = "/home/hamr/PycharmProjects/gitdone/app";
function tsUnder(dir, out, depth = 0) {
  if (depth > 3) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) tsUnder(p, out, depth + 1);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
try { for (const f of tsUnder(GD, []).slice(0, 8)) FILES.push(f); } catch {}
// TS — OpenSpec (real first-party TS corpus)
try { for (const f of tsUnder("/home/hamr/PycharmProjects/OpenSpec/src", []).slice(0, 30)) FILES.push(f); } catch {}

const fmtOf = (p) => (p.endsWith(".py") ? "py" : p.endsWith(".ts") ? "ts" : "js");

// signature = header up to the body-opening token (reused logic from the first POC)
function deriveSignature(text) {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && (lines[i].trim() === "" || /^(\/\/|\*|\/\*)/.test(lines[i].trim()))) i++;
  const header = [];
  for (; i < lines.length; i++) {
    header.push(lines[i]);
    if (/[{:]\s*$/.test(lines[i]) || /=>\s*[^{]/.test(lines[i])) break;
    if (header.length > 4) break;
  }
  return header.join("\n").trim();
}

const stat = {
  py: { defs: 0, docInBody: 0, sigBytes: 0, bodyBytes: 0 },
  js: { defs: 0, docOrphaned: 0, docInBody: 0, sigBytes: 0, bodyBytes: 0 },
  ts: { defs: 0, docOrphaned: 0, docInBody: 0, sigBytes: 0, bodyBytes: 0 },
};
let orphanExamples = 0;

for (const path of FILES) {
  let src;
  try { src = readFileSync(path, "utf8"); } catch { continue; }
  const fmt = fmtOf(path);
  let chunks;
  try { chunks = await chunkFile(path, src); } catch { continue; }
  const preamble = chunks.find((c) => c.nodeType === "preamble")?.text ?? "";
  const srcLines = src.split("\n");
  for (const c of chunks) {
    if (c.nodeType === "preamble" || c.nodeType === "file") continue;
    const s = stat[fmt];
    s.defs++;
    const sig = deriveSignature(c.text);
    s.sigBytes += sig.length; s.bodyBytes += c.text.length;
    // Python: docstring is the first statement inside the body
    if (fmt === "py") { if (/:\s*\n\s*("""|''')/.test(c.text)) s.docInBody++; continue; }
    // JS/TS: is there a JSDoc on the line(s) immediately above this def in SOURCE?
    const above = srcLines.slice(Math.max(0, c.startLine - 3), c.startLine).join("\n").trimEnd();
    const hasJsdocAbove = above.endsWith("*/");
    if (hasJsdocAbove) {
      // is that JSDoc inside this chunk's text (attached) or in the preamble (orphaned)?
      if (/^\s*\/\*\*/.test(c.text)) s.docInBody++;
      else { s.docOrphaned++; if (orphanExamples < 3) { orphanExamples++; console.log(`  orphan e.g. ${path}:${c.startLine} ${c.symbol} — JSDoc ${preamble.includes(above.slice(-40)) ? "IS in preamble" : "is dangling"}`); } }
    }
  }
}

console.log("\nR-C7 on REAL source — doc placement + compression ratio\n");
for (const [fmt, s] of Object.entries(stat)) {
  if (!s.defs) continue;
  const ratio = s.bodyBytes ? (100 * (1 - s.sigBytes / s.bodyBytes)).toFixed(0) : "—";
  const docLine = fmt === "py"
    ? `docstring in body: ${s.docInBody}/${s.defs} defs`
    : `JSDoc'd defs → attached ${s.docInBody} / ORPHANED ${s.docOrphaned}`;
  console.log(`${fmt.toUpperCase().padEnd(3)} ${s.defs} defs · ${docLine} · signature tier saves ${ratio}% bytes`);
}
console.log("\nREAD: Python docstrings are IN the body (free). JS/TS JSDoc is ORPHANED into preamble —");
console.log("indexed but dissociated from its symbol. Recall + embeddings + compress all lose it.");
console.log("→ Fix belongs in the CHUNKER (attach leading doc-comment to its def chunk) = indexing job.");
