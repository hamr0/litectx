// R-C7 compress() POC — signature-render FIDELITY (the load-bearing claim for the feature).
//
// ⚠️ CAVEAT (2026-06-12, found while SHIPPING compress()): this POC does `if (ts == null) continue`
// — it SILENTLY SKIPS defs that don't parse standalone, which is ~38% of real symbols (METHODS:
// `method_definition` is only valid inside a class, so a bare method chunk yields no def). That
// inflated the clean-rate denominator. The SHIPPED `signatureOf` (src/chunker.js) fixes this by
// retrying inside a synthetic class wrapper, so methods compress too. Honest end-state, measured on
// 627 real named symbols (litectx JS + OpenSpec TS + aurora PY): signature tier saves **~82%** of
// bytes WITH the doc kept, 0 unparseable — NOT the "95–98%" the early notes claimed.
//
// The extraction mechanism is already settled (poc/rc7-compress-real-poc.mjs: signature 100%
// derivable from body, docstring now rides in the chunk after the chunker fix). The OPEN risk is
// fidelity: the earlier naive `deriveSignature` (slice to the first `{`/`:`) visibly mangled arrow
// functions, interfaces, and would break on multiline params / generics / decorators / defaults.
//
// Question: does a PRECISE tree-sitter extraction — parse the chunk body, cut at the def's `body`
// field — produce a clean signature across REAL complex defs where the heuristic fails? If yes,
// compress()'s signature tier uses tree-sitter (already a dep); the heuristic is rejected.
//
// Run: node poc/rc7-compress-sig-poc.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Parser from "web-tree-sitter";
import { LANGDEFS } from "../src/langdef.js";
import { chunkFile } from "../src/chunker.js";

const GRAMMAR_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src/grammars");
await Parser.init();
const parsers = new Map();
async function parserFor(lang) {
  if (!parsers.has(lang.grammar)) {
    const language = await Parser.Language.load(join(GRAMMAR_DIR, lang.grammar));
    const p = new Parser();
    p.setLanguage(language);
    parsers.set(lang.grammar, p);
  }
  return parsers.get(lang.grammar);
}

// PRECISE: signature = text from the def node start up to its `body` field (the block/suite).
// Defs with no `body` field (type aliases, bare arrows) → whole text is already the signature.
function sigTreeSitter(body, lang) {
  const def = findDef(body, lang);
  if (!def) return null;
  const bodyField = def.childForFieldName("body");
  const end = bodyField ? bodyField.startIndex : def.endIndex;
  return body.slice(def.startIndex, end).replace(/\s*$/, "");
}
function findDef(body, lang) {
  const p = parsersSync.get(lang.grammar);
  const tree = p.parse(body);
  let found = null;
  (function walk(n) {
    if (found) return;
    if (lang.defTypes.includes(n.type)) { found = n; return; }
    for (let i = 0; i < n.childCount; i++) walk(n.child(i));
  })(tree.rootNode);
  return found;
}

// NAIVE: the earlier heuristic — slice to the first body-opening token.
function sigNaive(text) {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && (lines[i].trim() === "" || /^(\/\/|\*|\/\*|#)/.test(lines[i].trim()))) i++;
  const header = [];
  for (; i < lines.length; i++) {
    header.push(lines[i]);
    if (/[{:]\s*$/.test(lines[i]) || /=>\s*[^{]/.test(lines[i])) break;
    if (header.length > 4) break;
  }
  return header.join("\n").trim();
}

// leading doc-comment now in the chunk (after the chunker fix) — the other half of the tier
function leadingDoc(text) {
  const m = text.match(/^\s*(\/\*\*[\s\S]*?\*\/|(?:\/\/.*\n)+|(?:#.*\n)+)/);
  return m ? m[1].trim() : null;
}

const TS_SAMPLE = `interface Box<T> { v: T }

/** Map a boxed value through a fn, preserving the box. */
export async function transform<T, U>(
  box: Box<T>,
  fn: (x: T) => Promise<U>,
  opts: { strict?: boolean } = {},
): Promise<Box<U>> {
  return { v: await fn(box.v) };
}

export type Handler = (req: Request) => Response;
`;

const SOURCES = [
  ["src/index.js", readFileSync("src/index.js", "utf8"), LANGDEFS.js],
  ["src/store.js", readFileSync("src/store.js", "utf8"), LANGDEFS.js],
  ["transform.ts", TS_SAMPLE, LANGDEFS.ts],
];
const AUR = "/home/hamr/PycharmProjects/aurora/packages/soar/src/aurora_soar/discovery_adapter.py";
try { SOURCES.push(["discovery_adapter.py", readFileSync(AUR, "utf8"), LANGDEFS.py]); } catch {}
// real first-party TS — OpenSpec (closes the crafted-TS limitation)
import { readdirSync } from "node:fs";
function tsFiles(dir, out, depth = 0) {
  if (depth > 3) return out;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) tsFiles(p, out, depth + 1);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
    }
  } catch {}
  return out;
}
for (const f of tsFiles("/home/hamr/PycharmProjects/OpenSpec/src", []).slice(0, 25)) {
  try { SOURCES.push([f.split("/").slice(-2).join("/"), readFileSync(f, "utf8"), LANGDEFS.ts]); } catch {}
}

// sync parser cache (findDef is sync) — warm it first
const parsersSync = new Map();
for (const [, , lang] of SOURCES) if (!parsersSync.has(lang.grammar)) parsersSync.set(lang.grammar, await parserFor(lang));

let n = 0, tsClean = 0, naiveClean = 0, naiveBroke = 0;
const samples = [];
for (const [path, src, lang] of SOURCES) {
  const chunks = await chunkFile(path, src);
  for (const c of chunks) {
    if (c.nodeType === "preamble" || c.nodeType === "file") continue;
    const ts = sigTreeSitter(c.text, lang);
    const nv = sigNaive(c.text);
    if (ts == null) continue;
    n++;
    // "clean" = non-empty, no stray opening brace/colon dangling, shorter than the body
    const isClean = (s) => s && s.length < c.text.length && !/[{]\s*$/.test(s);
    const tsOk = isClean(ts);
    const nvOk = isClean(nv);
    if (tsOk) tsClean++;
    if (nvOk) naiveClean++;
    // naive "broke" = it disagrees with tree-sitter AND ts is clean (heuristic lost fidelity)
    const broke = tsOk && nv.replace(/\s+/g, " ") !== ts.replace(/\s+/g, " ");
    if (broke) naiveBroke++;
    if (broke && samples.length < 6) samples.push({ path, symbol: c.symbol, ts: ts.replace(/\n/g, "⏎"), naive: nv.replace(/\n/g, "⏎") });
  }
}

console.log("R-C7 compress() signature fidelity — tree-sitter (cut at `body` field) vs naive slice\n");
console.log(`defs measured: ${n}`);
console.log(`tree-sitter clean: ${tsClean}/${n} (${(100 * tsClean / n).toFixed(0)}%)`);
console.log(`naive clean:       ${naiveClean}/${n} (${(100 * naiveClean / n).toFixed(0)}%)`);
console.log(`naive lost fidelity vs tree-sitter: ${naiveBroke}/${n}\n`);
console.log("where the naive heuristic diverged (tree-sitter = correct):");
for (const s of samples) {
  console.log(`\n  ${s.path} :: ${s.symbol}`);
  console.log(`    ts:    ${s.ts.slice(0, 90)}`);
  console.log(`    naive: ${s.naive.slice(0, 90)}`);
}
console.log("\nREAD: if tree-sitter ≫ naive on clean-rate, compress() must extract the signature via the");
console.log("`body` field (already a dep), not a line-slice. The full signature tier = leadingDoc + this.");
