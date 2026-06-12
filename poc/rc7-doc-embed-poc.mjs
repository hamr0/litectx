// R-C7 #3 — does keeping a symbol's doc-comment IN its chunk help SEMANTIC (embedding) recall?
//
// Background (why this is the only honest question): the SHIPPING embeddings tier embeds the
// raw WHOLE FILE, head-truncated to 6000 chars (src/embedder.js:6-11, src/index.js:218). The
// chunker fix only moves a doc-comment BETWEEN sub-chunks of the same file — the file's raw text
// is unchanged — so the current file-level tier is a provable no-op (the doc was always in the
// file embedding). That half of the old "embeddings embed the symbol WITHOUT its docs" claim is
// architecturally moot: there is no per-symbol embedding today.
//
// The REAL forward-looking question (what compress()/a future chunk-level tier would feed):
// if we embed at SYMBOL granularity, does doc+signature+body retrieve a purpose query better
// than signature+body alone — among realistic distractors?
//
// Method: real JSDoc'd symbols from OpenSpec TS + litectx JS. For each symbol build two embedding
// texts — withDoc (full chunk) and withoutDoc (chunk minus its leading comment). Build two
// symbol-level indexes from the SAME corpus. Query each with a natural-language paraphrase of the
// function's purpose; measure MRR / recall@1 of the target symbol among ALL symbols (distractors).
//
// HONESTY CAVEAT (the trap that caused the last overclaim): queries are derived from the doc's
// own first sentence — a user who remembers the doc's framing. This BIASES TOWARD withDoc, so the
// result is an UPPER BOUND on the benefit. If even the upper bound is small, the claim is dead;
// if large, it's suggestive, not proof (a user querying in their own words may see less).
//
// Run: node poc/rc7-doc-embed-poc.mjs
import { chunkFile } from "../src/chunker.js";
import { Embedder, cosine } from "../src/embedder.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ---- collect real source files (same corpus shape as rc7-compress-real-poc) ----
const FILES = [];
for (const f of readdirSync("src").filter((f) => f.endsWith(".js"))) FILES.push(join("src", f));
function tsUnder(dir, out, depth = 0) {
  if (depth > 4) return out;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) tsUnder(p, out, depth + 1);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
for (const f of tsUnder("/home/hamr/PycharmProjects/OpenSpec/src", [])) FILES.push(f);

// ---- a chunk's leading comment block (the doc the chunker now attaches) ----
// Returns { doc, code } by splitting off a leading /** */ or // run. Empty doc if none.
function splitDoc(text) {
  const lines = text.split("\n");
  let i = 0;
  // block comment /** ... */
  if (/^\s*\/\*/.test(lines[0])) {
    while (i < lines.length && !/\*\/\s*$/.test(lines[i])) i++;
    i++; // consume the closing line
  } else {
    while (i < lines.length && /^\s*\/\//.test(lines[i])) i++;
  }
  return { doc: lines.slice(0, i).join("\n").trim(), code: lines.slice(i).join("\n").trim() };
}

// first natural-language sentence of a JSDoc/line-comment, stripped of comment punctuation
function docSentence(doc) {
  const clean = doc
    .replace(/\/\*\*?|\*\/|^\s*\*\s?|^\s*\/\/\s?/gm, " ")
    .replace(/@\w+[^\n]*/g, " ") // drop @param/@returns tag lines — not natural-language purpose
    .replace(/\s+/g, " ")
    .trim();
  const m = clean.match(/^(.*?[.!?])(\s|$)/);
  return (m ? m[1] : clean).trim();
}

// ---- build the symbol corpus: real named defs that carry an attached leading doc ----
const symbols = []; // { id, query, withDoc, withoutDoc }
for (const path of FILES) {
  let src;
  try { src = readFileSync(path, "utf8"); } catch { continue; }
  let chunks;
  try { chunks = await chunkFile(path, src); } catch { continue; }
  for (const c of chunks) {
    if (c.nodeType === "preamble" || c.nodeType === "file" || !c.symbol) continue;
    const { doc, code } = splitDoc(c.text);
    if (!doc || doc.length < 25) continue; // only symbols that actually carry a doc
    const sentence = docSentence(doc);
    if (sentence.split(" ").length < 4) continue; // need a real phrase to query with
    // a name-derived query: camelCase/snake split of the symbol — what a user types who knows the
    // NAME but not the doc's wording. Present in BOTH texts, so it isolates the doc's marginal signal.
    const nameQuery = c.symbol
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_.]/g, " ")
      .toLowerCase()
      .trim();
    symbols.push({
      id: `${path.split("/").pop()}::${c.symbol}`,
      query: sentence,
      nameQuery,
      withDoc: c.text,
      withoutDoc: `${c.symbol}\n${code}`, // signature+body, symbol name retained (what an un-docced chunk is)
    });
  }
}

// de-dup identical queries (same boilerplate doc on multiple symbols would confound the target)
const seen = new Set();
const corpus = symbols.filter((s) => {
  const k = s.query.toLowerCase();
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

console.log(`Corpus: ${corpus.length} real doc'd symbols from ${FILES.length} files\n`);
if (corpus.length < 10) { console.log("Too few doc'd symbols to measure — aborting."); process.exit(0); }

// ---- embed everything ----
const emb = new Embedder();
console.log("Embedding (model load ~2s, then warm)…");
const vWith = await Promise.all(corpus.map((s) => emb.embed(s.withDoc)));
const vWithout = await Promise.all(corpus.map((s) => emb.embed(s.withoutDoc)));
const vQuery = await Promise.all(corpus.map((s) => emb.embed(s.query)));
const vNameQuery = await Promise.all(corpus.map((s) => emb.embed(s.nameQuery)));

// ---- retrieval: for each query, rank ALL symbols by cosine; find the target's rank ----
function evaluate(corpusVecs, queryVecs) {
  let rrSum = 0, r1 = 0, r3 = 0;
  const ranks = [];
  for (let q = 0; q < corpus.length; q++) {
    const scored = corpusVecs.map((v, i) => ({ i, s: cosine(queryVecs[q], v) }));
    scored.sort((a, b) => b.s - a.s);
    const rank = scored.findIndex((x) => x.i === q) + 1;
    ranks.push(rank);
    rrSum += 1 / rank;
    if (rank === 1) r1++;
    if (rank <= 3) r3++;
  }
  return { mrr: rrSum / corpus.length, r1: r1 / corpus.length, r3: r3 / corpus.length, ranks };
}

const pct = (x) => (100 * x).toFixed(1) + "%";
const sgn = (x, d = 3) => (x >= 0 ? "+" : "") + x.toFixed(d);

function report(label, queryVecs, note) {
  const withRes = evaluate(vWith, queryVecs);
  const withoutRes = evaluate(vWithout, queryVecs);
  let better = 0, worse = 0, same = 0;
  for (let i = 0; i < corpus.length; i++) {
    if (withRes.ranks[i] < withoutRes.ranks[i]) better++;
    else if (withRes.ranks[i] > withoutRes.ranks[i]) worse++;
    else same++;
  }
  console.log(`\n── ${label} ──`);
  console.log(`             MRR     recall@1   recall@3`);
  console.log(`withoutDoc   ${withoutRes.mrr.toFixed(3)}   ${pct(withoutRes.r1).padStart(7)}   ${pct(withoutRes.r3)}`);
  console.log(`withDoc      ${withRes.mrr.toFixed(3)}   ${pct(withRes.r1).padStart(7)}   ${pct(withRes.r3)}`);
  console.log(`Δ            ${sgn(withRes.mrr - withoutRes.mrr)}   ${sgn((withRes.r1 - withoutRes.r1) * 100, 1)}pp   ${sgn((withRes.r3 - withoutRes.r3) * 100, 1)}pp`);
  console.log(`per-query: withDoc better ${better} / worse ${worse} / same ${same}`);
  console.log(note);
}

console.log("\nSymbol-level semantic retrieval — target rank among all distractors");
report("Query = doc's first sentence", vQuery,
  "→ UPPER BOUND: query is the doc itself, biased toward withDoc.");
report("Query = symbol name (camelCase-split)", vNameQuery,
  "→ FAIRER: the name is in BOTH texts, so this isolates the doc's MARGINAL signal beyond the name.");
