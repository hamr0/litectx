// Recall litmus iteration 3 (scratch) — does free LLM QUERY-EXPANSION recover the embeddings lift
// on the intent-phrased aurora/gitdone queries, or does embeddings still win?
//
// Conditions on the SAME index: BM25 natural / BM25 expanded / emb@1.0 natural / emb@1.0 expanded.
// "Expanded" = an agent-plausible rewrite adding domain synonyms/likely identifiers to the natural
// query, authored from intent + general knowledge (NOT by reading the target files). CAVEAT: the
// author has prior exposure to these repos, so treat expanded numbers as an optimistic ceiling for
// what a cold agent would produce. Usage: node poc/recall-litmus-expand.mjs <aurora|gitdone>

import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

// expansions are index-parallel to each dataset's `queries`
const EXP = {
  aurora: [
    "base-level activation ACT-R compute decay access frequency recency log retrieval strength",
    "BM25 tokenizer tokenize keyword scoring code identifier camelCase split lexical",
    "SQLite store database persist save retrieve chunk insert select connection",
    "git blame commit history author line authorship subprocess log",
    "FTS5 full text search virtual table schema sqlite create index",
    "tree-sitter parse Python AST extract function class def node query language",
    "chunk base class dataclass data structure fields id text type",
    "spreading activation graph propagate neighbors relationships edges hop",
    "decay formula time exponential power-law activation penalty age recency half-life",
    "hybrid retriever combine fuse BM25 activation embeddings semantic score weight rank",
    "LSP language server protocol facade code analysis references definition hover",
    "function dependencies call graph extract relationships edges imports references build language",
    "access history prune cap bound compact evict prevent unbounded growth limit",
    "code chunk location source file path line range start end span position",
    "natural language query retrieval entry point search retrieve pipeline orchestrate hybrid",
    "compact history buckets aggregate bucket time window decide threshold access",
    "knowledge markdown parse documentation md section chunk heading extract kb",
    "penalize unstable frequently changing code churn volatility decay commits stability",
    "context keywords extract match boost query terms chunk overlap",
    "activation pipeline orchestrate engine total score combine base spreading decay context",
    "database schema version compatibility migration check before load upgrade",
    "connection pool thread-local per thread manage sqlite reuse concurrency",
  ],
  gitdone: [
    "send email outbound SMTP deliver message mail transport user",
    "email address parse router subaddress plus event manage local-part route",
    "validate trust level incoming email classify sender authentication",
    "completion engine reply counts finish complete event decide threshold",
    "per-event git repository create init commit update repo clone",
    "OpenTimestamps OTS proof timestamp attestation bitcoin integration",
    "participant notification send notify email recipients alert",
    "email body text template lifecycle message content strings",
    "recipients lifecycle notification decide who filter participants email",
    "DKIM public key archive store offline verify signature dns",
    "prevent auto-responder loop mailing list spam prefilter detect vacation",
    "extract forwarded message verify re-check stored signature compare",
    "upgrade unverified signature verified resubmit reverify promote status",
    "parse delivery failure report DSN bounce NDR outbound message",
    "authenticated session login organiser dashboard auth token cookie access",
    "download archived event repository tar.gz bundle export offline archive",
    "stop event activated twice race condition concurrency mutex lock serialize",
    "hourly background job cron sweep archive old events overdue nudge reminder schedule",
    "reference doc progress attestors signed count acknowledgement ack quorum",
    "event explicitly closed organiser manually completion natural status close",
  ],
};

const name = process.argv[2];
if (!EXP[name]) { console.error("usage: recall-litmus-expand.mjs <aurora|gitdone>"); process.exit(1); }
const ds = (await import(`./datasets/${name}.mjs`)).default;
const root = ds.roots.find(existsSync);
if (!root) { console.error(`no checkout of ${name}`); process.exit(1); }
if (EXP[name].length !== ds.queries.length) { console.error(`expansion count ${EXP[name].length} != queries ${ds.queries.length}`); process.exit(1); }

const rr = (r) => (r > 0 ? 1 / r : 0);
const pct = (x) => (100 * x).toFixed(0).padStart(3) + "%";

async function run(ctx, expanded) {
  const ranks = [];
  for (let i = 0; i < ds.queries.length; i++) {
    const q = expanded ? EXP[name][i] : ds.queries[i].q;
    const hits = await ctx.recall(q, { kind: "code", n: 10, log: false });
    const j = hits.findIndex((h) => h.path === ds.queries[i].target);
    ranks.push(j < 0 ? 0 : j + 1);
  }
  const mrr = ranks.reduce((s, r) => s + rr(r), 0) / ranks.length;
  return { mrr, p1: ranks.filter((r) => r === 1).length / ranks.length, p3: ranks.filter((r) => r >= 1 && r <= 3).length / ranks.length, missed: ranks.filter((r) => r === 0).length };
}
const line = (label, m) => console.log(`  ${label.padEnd(20)} MRR ${m.mrr.toFixed(3)}   P@1 ${pct(m.p1)}   P@3 ${pct(m.p3)}   missed ${m.missed}/${ds.queries.length}`);

const db = join(mkdtempSync(join(tmpdir(), `litmus3-${name}-`)), "i.db");
console.log(`[${name}] indexing with embeddings…`);
const idx = new LiteCtx({ root, include: ds.include, pathspecs: ds.pathspecs, dbPath: db, embeddings: true });
await idx.index();
idx.close();

const bm = new LiteCtx({ root, dbPath: db, embeddings: false });
line("BM25 natural", await run(bm, false));
line("BM25 expanded", await run(bm, true));
bm.close();
const e = new LiteCtx({ root, dbPath: db, embeddings: true, embedWeight: 1.0 });
line("emb@1.0 natural", await run(e, false));
line("emb@1.0 expanded", await run(e, true));
e.close();
rmSync(db, { recursive: true, force: true });
console.log("\n(question: does BM25-expanded reach emb-natural? if yes, the LLM substitutes for the tier)");
