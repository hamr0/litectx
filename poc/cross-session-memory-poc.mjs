// F5 — cross-session memory POC (EVIDENCE, not a gate; per docs/01-product/benches-prd.md §F5).
//
// THE QUESTION. On a FRESH session, does litectx recall the RIGHT prior decision by MEANING,
// among many real decoys, where a lexical (OFF) arm structurally cannot? This is the one
// long-running claim the in-run A/Bs (F3–F6) could not test, because OFF has no cross-session
// mechanism at all. Design rule (F5): the win must be "retrieve the right memory among decoys,"
// NOT "has a notes file."
//
// HONESTY GUARDS (this test is built to be able to FAIL — see [[prove-dont-assert]]):
//   1. REAL corpus. The 14 decisions are harvested VERBATIM-faithfully from litectx's OWN memory
//      log (~/.claude/.../memory/*.md) — uncrafted decision records, not a fixture authored to
//      contain the answer.
//   2. NEAR-NEIGHBOUR decoys on purpose. Three decisions (#1 no-confidence-label, #12 edit-
//      activation-zero, #14 trust-not-scored) are ALL "a ranking signal was falsified → ships
//      surfaced, not scored." A generic paraphrase can land on the wrong sibling → the test can
//      pick the wrong decision and fail.
//   3. LABEL AUDIT (asserted, the memory-bench discipline). Every query must share ZERO indexed
//      keyword with its target's text+id. A leak → the query is lexical, not a paraphrase → the
//      run aborts. This is also what makes a passing OFF arm meaningful: OFF can only win by
//      keyword, and the audit guarantees there is none — so OFF SHOULD miss. If OFF hits anyway,
//      that's the confound, surfaced.
//
// READ THE RESULT THIS WAY:
//   OFF ~0  &  ON high  → the F5 win: meaning retrieves what lexical cannot (the cross-session pitch).
//   ON also ~0          → a real NULL: memory does not retrieve by meaning among decoys.
//   OFF high            → confound: queries leaked keywords (audit should have caught it — investigate).
//
// Usage: node poc/cross-session-memory-poc.mjs            (ON needs @huggingface/transformers; if
//        absent it prints OFF-only with a notice — never crashes.)

import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LiteCtx, splitIdent, keywords } from "../src/index.js";
import { indexBody } from "../src/tokenize.js";

// ── The corpus: 14 real prior decisions, harvested verbatim-faithfully from the memory log ──────
// (faithful condensations of the real decision statements; wording kept close to the source so the
//  text is the decision, never reverse-engineered from a query).
const DECISIONS = [
  { id: "decision:no-recall-confidence-label",
    text: "The recall().quality retrieval-confidence label is closed and must not be re-proposed. A label off top embeddings cosine was POC-falsified: it separates answerable from unanswerable in aggregate at AUC 0.92 but has no usable threshold — genuine paraphrase hits sit in the same cosine band as queries with nothing to find, so any cutoff falsely brands roughly a quarter of correct hits as weak, worst on the very cases the label would exist for." },
  { id: "decision:jina-code-off-the-table",
    text: "The jina-code embedding-model swap is off the table; the user explicitly ruled it out. The recall lane has reached diminishing returns and a model swap is a recall-quality bet the user has declined, so it should not appear again as a next step, roadmap remainder, or POC idea." },
  { id: "decision:chunker-attaches-leading-doc",
    text: "The chunker extends each definition chunk upward over an immediately-adjacent comment block, so a leading JSDoc rides inside the chunk body and a blank line breaks the attachment. Its sole justification is enabling the signature render tier; it does not improve recall, measured at zero of three lexical and minus 0.003 MRR semantic on real source." },
  { id: "decision:recall-finds-not-executes",
    text: "The live ON versus OFF A/B verdict is that the single-run discovery lift is narrow, even in the regime engineered to favor it. Retrieval points but does not pay: it ranks the right files by meaning yet changes neither outcome nor cost for a strong model, because the real bottleneck is in-weights domain knowledge plus reading a small local contract, not locating files. It helps finding, not doing." },
  { id: "decision:compress-shipped-as-pure-fn",
    text: "compress is shipped as a pure library function with three levels, verbatim, signature, and drop, and is deliberately not a model verb. Signature extraction is tree-sitter, cut at the definition body; a bare method chunk is retried inside a synthetic class wrapper. Measured at about 82 percent of bytes saved with the doc kept over 627 real symbols." },
  { id: "decision:borrow-aurora-dont-reinvent",
    text: "When building litectx signals and algorithms, read aurora's actual tested source first and carry what already worked instead of reinventing crude approximations; correct aurora's over-engineered parts rather than copying them. Reinventing throws away the tuned calibration and produces wrong conclusions." },
  { id: "decision:impact-risk-max-bucket",
    text: "The impact risk bucket borrows aurora's calibration without its dependency on a heavyweight resolver: risk is the larger of tree-sitter-confirmed fan-in and the whole-word grep count, bucketed two-or-fewer low, three to ten medium, eleven-plus high. Taking the larger of the two is what makes a heavily-referenced base class impossible to falsely stamp as isolated." },
  { id: "decision:verify-shipped-against-poc",
    text: "After building a verb that a prototype validated, re-run the shipped exported code over the same real data the prototype used and confirm it reproduces the prototype's numbers before claiming validation. Author-written unit tests are merely confirmatory — they guard invariants, not real-data parity — so a divergence must be treated as a finding." },
  { id: "decision:no-language-server-ever",
    text: "Edge resolution uses whole-word grep plus tree-sitter queries only, with no protocol-based resolver, ever. Accuracy comes from per-language definition configuration. Over-counting is acceptable on purpose because the output is a coarse risk bucket, not a precise reference list." },
  { id: "decision:storage-is-sqlite-fts5",
    text: "Storage is one SQLite file via better-sqlite3 plus FTS5, a closed question with no alternative store. Ranked text matching is native in SQL, and the optional vector tier keeps its float arrays in the very same file." },
  { id: "decision:embeddings-off-by-default",
    text: "The semantic tier ships disabled by default purely to keep the base install small and usable offline, not as a stance on quality. For the memory primitive it is effectively mandatory, since matching reworded questions is near zero without it and good with it." },
  { id: "decision:edit-activation-ships-at-zero",
    text: "Promoting recently-touched chunks as a ranking input ships at zero weight, because the edit signal proved topic-blind and repo-dependent. The edit information lives in dedicated views and never enters the relevance score." },
  { id: "decision:assemble-select-poc-killed",
    text: "The assemble tier that would auto-inject retrieved code into the conversation was killed after its prototype failed. A consumer fetches its own material through the normal read paths instead, and assemble only fits and shrinks what the host already holds." },
  { id: "decision:trust-surfaced-not-scored",
    text: "A reliability tie-break for ordering results was falsified because it buries better-matching items. Provenance, how often something was used, and when it happened ship as columns the agent can weigh, never folded into the relevance ordering." },
];

// ── The queries: fresh-session paraphrases. Each shares ZERO indexed keyword with its target ────
// (asserted below). Targets span 10 of the 14 decisions; the other 4 are pure decoys in the pool.
const QUERIES = [
  { q: "should the system report how certain it is that a result is genuinely relevant?",      target: "decision:no-recall-confidence-label" },
  { q: "would switching to a stronger neural encoder give us sharper lookups?",               target: "decision:jina-code-off-the-table" },
  { q: "how do we keep the notes written just above a method from drifting away from it when we split files into pieces?", target: "decision:chunker-attaches-leading-doc" },
  { q: "does giving an agent a way to look things up actually improve how well it finishes jobs?", target: "decision:recall-finds-not-executes" },
  { q: "before writing a brand-new scoring rule, should we look at how the earlier engine handled it?", target: "decision:borrow-aurora-dont-reinvent" },
  { q: "once a throwaway spike shows an approach works, how do we make sure the released function matches what the spike measured?", target: "decision:verify-shipped-against-poc" },
  { q: "why do we avoid the heavyweight tool that gives exact jump-to-declaration and stick to plain text scanning?", target: "decision:no-language-server-ever" },
  { q: "why isn't vector-based meaning lookup turned on straight out of the box?",             target: "decision:embeddings-off-by-default" },
  { q: "should the things I just changed automatically float to the front of the results?",    target: "decision:edit-activation-ships-at-zero" },
  { q: "if two saved notes are equally on-point, should the more battle-tested one come first?", target: "decision:trust-surfaced-not-scored" },
];

// ── Label audit (asserted): a query may share NO indexed keyword with its target's text+id ──────
const byId = new Map(DECISIONS.map((d) => [d.id, d]));
const auditFailures = [];
for (const Q of QUERIES) {
  const t = byId.get(Q.target);
  if (!t) { auditFailures.push(`"${Q.q}" → unknown target ${Q.target}`); continue; }
  const indexed = new Set(splitIdent(indexBody({ path: t.id, body: t.text })));
  const overlap = keywords(Q.q).filter((k) => indexed.has(k));
  if (overlap.length) auditFailures.push(`LEAK "${Q.q}" shares [${overlap.join(", ")}] with ${Q.target} — lexical, not a paraphrase`);
}
if (auditFailures.length) {
  console.error("LABEL AUDIT FAILED — queries are not pure paraphrases:\n  " + auditFailures.join("\n  "));
  process.exit(1);
}

const DEPTH = DECISIONS.length;            // rank within the whole decoy pool
const rr = (r) => (r < 0 ? 0 : 1 / (r + 1)); // r is 0-based index; miss = -1 → 0

async function run(embeddings) {
  const root = mkdtempSync(join(tmpdir(), "litectx-f5-"));
  const ctx = new LiteCtx({ root, dbPath: ":memory:", embeddings });
  try {
    for (const d of DECISIONS) await ctx.remember(d.id, d.text, { kind: "fact", by: "agent" });
    const rows = [];
    for (const Q of QUERIES) {
      const hits = await ctx.recall(Q.q, { kind: "fact", n: DEPTH, log: false });
      const rank = hits.findIndex((h) => h.path === Q.target); // 0-based; -1 = miss
      const topWrong = rank !== 0 && hits.length ? hits[0].path : null;
      rows.push({ q: Q.q, target: Q.target, rank, topWrong });
    }
    const mrr = rows.reduce((s, r) => s + rr(r.rank), 0) / rows.length;
    const pAt = (k) => rows.filter((r) => r.rank >= 0 && r.rank < k).length / rows.length;
    return { rows, mrr, p1: pAt(1), p3: pAt(3), p5: pAt(5) };
  } finally {
    ctx.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function report(label, res) {
  const pc = (x) => (x * 100).toFixed(0).padStart(3) + "%";
  console.log(`\n${label}\n   P@1 ${pc(res.p1)}   P@3 ${pc(res.p3)}   P@5 ${pc(res.p5)}   MRR ${res.mrr.toFixed(3)}`);
  for (const r of res.rows) {
    const tag = r.rank === 0 ? "  #1 ✓" : r.rank > 0 ? `  #${r.rank + 1}` : "  MISS";
    const wrong = r.rank > 0 && r.topWrong ? `   (top: ${r.topWrong.replace("decision:", "")})` : r.rank < 0 ? `   (top: ${r.topWrong ? r.topWrong.replace("decision:", "") : "—"})` : "";
    console.log(`${tag.padEnd(7)} ${r.target.replace("decision:", "").padEnd(34)} ⟵ ${r.q}${wrong}`);
  }
}

console.log(`F5 cross-session memory — ${DECISIONS.length} real decisions, ${QUERIES.length} paraphrase queries (audit clean), near-neighbour decoys in pool.`);

const off = await run(false);
report("OFF  (BM25 lexical — the 'structurally cannot' arm)", off);

let on = null;
try {
  on = await run(true);
  report("ON   (litectx semantic recall)", on);
} catch (e) {
  console.log(`\nON arm SKIPPED — embeddings tier unavailable (${e.message}). Install @huggingface/transformers to run it.`);
}

if (on) {
  const dp = (a, b) => ((b - a) * 100).toFixed(0).padStart(3) + " pts";
  console.log("\n── Verdict (OFF → ON) ──");
  console.log(`  P@1  ${(off.p1 * 100).toFixed(0)}% → ${(on.p1 * 100).toFixed(0)}%   (Δ ${dp(off.p1, on.p1)})`);
  console.log(`  P@3  ${(off.p3 * 100).toFixed(0)}% → ${(on.p3 * 100).toFixed(0)}%   (Δ ${dp(off.p3, on.p3)})`);
  console.log(`  P@5  ${(off.p5 * 100).toFixed(0)}% → ${(on.p5 * 100).toFixed(0)}%   (Δ ${dp(off.p5, on.p5)})`);
  console.log(`  MRR  ${off.mrr.toFixed(3)} → ${on.mrr.toFixed(3)}   (Δ ${(on.mrr - off.mrr).toFixed(3)})`);
  // A genuine lexical confound shows up as OFF retrieving paraphrase targets ABOVE chance (top-3).
  // OFF MRR at the ~1/N floor with P@3 near zero = stopword noise, not content matching.
  if (off.p3 > 0.2)
    console.log("  ⚠ OFF hit paraphrase targets in the top-3 despite a clean keyword audit — investigate a lexical confound.");
  else
    console.log(`  ✓ OFF top-3 ${(off.p3 * 100).toFixed(0)}% (≈ chance) — the lexical arm genuinely cannot retrieve these by meaning.`);
}
