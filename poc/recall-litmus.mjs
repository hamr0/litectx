// Recall litmus (scratch, not shipped) — does CODE conceptual recall need embeddings ON by default,
// or can the always-present agent LLM substitute for it via query expansion?
//
// The weak spot: fuzzy prose queries ("knn union") let keyword-dense POC/test chunks outrank the
// real src/ implementation, because the default core is lexical (BM25 + import-spreading).
//
// Three levers, same 8 code targets on THIS repo (src/ is truth; poc/ + test/ are the distractors):
//   - BM25 / naive      : status quo for a fuzzy first query
//   - BM25 / expanded   : the LLM rewrites the query with identifiers/domain nouns (free in-agent)
//   - emb@w / naive      : embeddings tier re-ranks the BM25 pool (sweep w)
//   - emb@w / expanded   : both
// Metric per condition: MRR over targets, P@1, P@3, and #targets where a poc/test file beats the
// src target (the weak spot, directly). Usage: node poc/recall-litmus.mjs [w1 w2 ...]

import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

const ROOT = "/home/hamr/PycharmProjects/litectx";
const WEIGHTS = process.argv.slice(2).map(Number).filter((x) => !Number.isNaN(x));
const SWEEP = WEIGHTS.length ? WEIGHTS : [0.3, 0.5, 0.7, 1.0];

// target src file ← (naive fuzzy query, expanded identifier-rich query)
const Q = [
  ["src/index.js", "knn union", "rank a kind by fusing BM25 with cosine and import spreading, knn nominate"],
  ["src/store.js", "find the nearest stored vectors", "knnCandidates cosine nearest stored embedding vectors nominate pool"],
  ["src/embedder.js", "compare two vectors for similarity", "cosine similarity dot product L2 normalized embedding vectors transformers"],
  ["src/edges.js", "resolve an import to a file", "resolve import specifier to intra-repo target file path require from"],
  ["src/impact.js", "how risky is changing a function", "compute blast radius callers callees reference count risk bucket impact symbol"],
  ["src/chunker.js", "split code into functions", "extract function and class chunks with tree-sitter node symbol line ranges"],
  ["src/tsalias.js", "handle renamed re-exports", "resolve tsconfig path alias barrel re-export rename"],
  ["src/tokenize.js", "break up identifier words", "split camelCase snake_case identifier into tokens keywords for FTS"],
];

const rr = (r) => (r > 0 ? 1 / r : 0);
const pct = (x) => (100 * x).toFixed(0).padStart(3) + "%";

/** rank of `target` in the hit list, and whether a poc/test file outranks it */
function probe(hits, target) {
  const i = hits.findIndex((h) => h.path === target);
  const rank = i < 0 ? 0 : i + 1;
  const buried = i > 0 && hits.slice(0, i).some((h) => /^(poc|test)\//.test(h.path));
  return { rank, buried };
}

async function runCondition(ctx, useExpanded) {
  const rows = [];
  for (const [target, naive, expanded] of Q) {
    const hits = await ctx.recall(useExpanded ? expanded : naive, { kind: "code", n: 10, log: false });
    rows.push(probe(hits, target));
  }
  const mrr = rows.reduce((s, r) => s + rr(r.rank), 0) / rows.length;
  const p1 = rows.filter((r) => r.rank === 1).length / rows.length;
  const p3 = rows.filter((r) => r.rank >= 1 && r.rank <= 3).length / rows.length;
  const buried = rows.filter((r) => r.buried).length;
  const missed = rows.filter((r) => r.rank === 0).length;
  return { mrr, p1, p3, buried, missed };
}

function line(label, m) {
  console.log(
    `  ${label.padEnd(22)} MRR ${m.mrr.toFixed(3)}   P@1 ${pct(m.p1)}   P@3 ${pct(m.p3)}   buried-by-poc/test ${m.buried}/${Q.length}   missed ${m.missed}`
  );
}

const db = join(mkdtempSync(join(tmpdir(), "litmus-")), "i.db");
console.log("indexing src/ + poc/ + test/ with embeddings (one-time model load + chunk embed)…");
const t0 = Date.now();
const idx = new LiteCtx({ root: ROOT, include: [".js", ".mjs"], pathspecs: ["src/*", "poc/*", "test/*"], dbPath: db, embeddings: true });
const r = await idx.index();
idx.close();
console.log(`indexed ${r.files} files in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

const bm25 = new LiteCtx({ root: ROOT, dbPath: db, embeddings: false });
console.log("BM25 core (embeddings OFF) — the default:");
line("naive query", await runCondition(bm25, false));
line("LLM-expanded query", await runCondition(bm25, true));
bm25.close();

console.log("\nembeddings tier (gate-then-rerank for code), weight sweep:");
for (const w of SWEEP) {
  const e = new LiteCtx({ root: ROOT, dbPath: db, embeddings: true, embedWeight: w });
  line(`emb@${w} naive`, await runCondition(e, false));
  line(`emb@${w} expanded`, await runCondition(e, true));
  e.close();
}
rmSync(db, { recursive: true, force: true });
console.log("\n(src/ is truth; buried-by-poc/test is the weak spot we're chasing)");
