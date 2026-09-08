---
type: reference
title: Build Order & Provenance
status: stable
sources: [docs/archive/litectx-prd.md]
---

litectx was built in a strict sequence gated by evidence, not by a fixed roadmap: a single
falsifiable POC decided whether to build at all, a walking-skeleton methodology decided how each
capability landed, and two later negotiations (an Aurora borrow ledger and a real bareagent
consumer) decided what the remaining ambiguous surfaces should look like. This page traces that
order and where each piece's algorithm came from.

## The POC gate

Before any v1 code, one hypothesis was tested stupidly simply: `better-sqlite3` + FTS5 (BM25) +
hand-coded ACT-R base-level decay + git-seeded cold-start + a few hardcoded edges + one-hop
spreading, over one sample repo — does activation-weighted, graph-aware recall measurably beat
plain BM25? **POC PASSED for graph spreading, FAILED for git-seeded base-level activation**
(litectx-prd.md:1171-1195). Run on two repos (aurora/Python, gitdone/JS), spreading generalized
and never hurt an aggregate on either; flat-weighted git-seeded activation looked like a win on
aurora but was net-negative on gitdone, because the recency half of ACT-R shipped without its
churn/decay half. The verdict shaped v1 exactly: ship the graph substrate + spreading; rework
activation (decay+churn, demoted to a tiebreaker) before it earns real ranking weight
(litectx-prd.md:1192-1195).

## Build methodology — walking skeleton, not modules-then-wire

The build rule was set to avoid a known failure mode: a prior project shipped ~5500 heavy-TDD unit
tests across modules that were never wired together (litectx-prd.md:1199-1201). litectx instead
built a **walking skeleton first** (index → store → `recall` returns hits, connected from commit
one) and added **one vertical slice at a time**, integrated as it landed — never built in isolation
(litectx-prd.md:1203-1208). "Works by itself" was defined as observable end-to-end behavior, not
isolated unit tests, and Aurora was treated as a second opinion, never an oracle — a divergence
from Aurora is a question to investigate, not a bug to fix toward it (litectx-prd.md:1209-1220).

Each slice is one module from the module DAG and is not done until three gates pass
(litectx-prd.md:1222-1234):
1. **Behavior** — `npm run bench` holds-or-beats baseline MRR/P@k on *both* repos; a new
   weight/signal is adopted only if ≥ baseline on every repo.
2. **Types** — `tsc --noEmit` clean, `.d.ts` in sync, no `!`/`as any`/`@ts-ignore`.
3. **Tests** — integration-first against `:memory:` SQLite + a tmp repo, <60% mocking; every bug
   fix ships a regression test.

## v1 slice sequence (DECIDED, all shipped)

The slices, in build order (litectx-prd.md:1236-1509):

- **Slice 0** — walking skeleton: file→SQLite FTS5→`recall` returns ranked hits, plain BM25,
  file-granularity (litectx-prd.md:1238-1244).
- **Slice 1** — hardened store + schema (`kind`/`format`) + incremental git-aware indexing;
  recall path untouched, bench holds exactly (litectx-prd.md:1245-1252).
- **Slice 2** — tree-sitter symbol-level chunking (TS/JS/Python) + md section chunker, landed as a
  **dual-grain addition** alongside file-level FTS, not a replacement — pure chunk-BM25 regressed
  the file-target gate on both repos (litectx-prd.md:1253-1267).
- **Slice 3** — kind-scoped recall (the code-over-md fix): one FTS query per kind, kinds never
  share a ranking, replacing Aurora's per-kind hybrid weights which need ≥2 signals and degenerate
  to a forbidden md-penalty under BM25-only (litectx-prd.md:1268-1275).
- **Slice 4** — import edges + spreading + git activity metadata (`gitsig`). The original slice 4
  ("ACT-R activation in recall") was dissolved after a Step-0 POC showed base-level activation
  earns no v1 ranking weight. Spreading shipped as an additive `own + w·spread` at w=0.3 (the
  convex form taxed well-ranked files with weak neighbours); `calls` edges are reserved for impact,
  since call edges don't help recall (litectx-prd.md:1276-1298).
- **Slice 5a/5b** — the `impact()` view: reference count → risk bucket, sequenced *after* recall
  because it depends on accurate edges; alias/barrel false-isolation mitigations followed
  (litectx-prd.md:1299-1310, 1507-1509). If edges had slipped, recall would ship as v1 with impact
  deferred to v1.1 — the graph substrate makes that a clean cut, not a rework.
- **Access-log tier** — `promotionCandidates()` (episode→fact ladder) and `recentActivity()`
  ("what was I working on") shipped as the legitimate home for the witnessed-edit signal that was
  validated for next-use prediction but falsified for recall re-ranking (litectx-prd.md:1311-1361).
- **Slice 6** — embeddings/semantic tier, opt-in third ranking signal, off by default
  (litectx-prd.md:1489-1497).
- **Slice 7/7b** — the write path (facts/episodes/direct docs) and written-memory stemming
  (litectx-prd.md:1450-1488).
- **Slices 8–11** — chunk-granular recall, `get(id)` body access, MCP + CLI write parity, and the
  KNN union for written-kind paraphrase recall (litectx-prd.md:1362-1449).

Each view earned its own labeled bench gate with a view-appropriate metric (recall = MRR/P@k;
impact = caller-recall/miss-rate, since a missed caller is a dangerous false "isolated," not a
ranking defect) — the hold-or-beat rule made each gate a permanent regression check
(litectx-prd.md:1511-1534, 1551-1556). CI now runs `tsc --noEmit` + build:types + test on every
push/PR; the labeled benches stay a local pre-push gate, not CI, per LIBRARY_CONVENTIONS
(litectx-prd.md:1573-1591).

## What to carry over from Aurora — borrow, don't port

Aurora is the port source and a second opinion, never an oracle. The explicit borrow contract
(litectx-prd.md:1595-1627):

**Reimplement in clean ESM JS (pure logic, near-verbatim):** the spreading ACT-R term, the
code-aware BM25 tokenizer + `k1`/`b`, two-stage retrieval + the code-over-md fix, three-tier
incremental indexing, per-language edge-semantics config, the `kind`-keyed type taxonomy, and
file-level git activity metadata. Base-level ACT-R formulas and block-level git-blame are deferred
to the access-log tier, not v1.

**Carry the calibration, not the code:**
- Dual-hybrid ≈85% vs tri-hybrid ≈95% → embeddings are a tier, not the spine. (litectx's "dual" is
  BM25 + spreading, not BM25 + base-level activation.)
- Code-over-md is solved by kind-scoping, not a penalty hack or shared weights — Aurora's per-kind
  hybrid weights need ≥2 signals to be principled and collapse to a forbidden md-penalty under
  BM25-only.
- Edges come from ripgrep/lang-def, **not** tree-sitter's import-parsing — Aurora's
  `_identify_dependencies()` was a dead side-path, not to be repeated.
- Type-specific decay/churn parameters are tuned values worth keeping, but they belong to the
  access-log tier, not v1 ranking (they don't rescue git-only base-level activation).
- BM25 content must include deps + file_path, or descriptive queries return zero results.

**Leave behind entirely:** `soar`/`reasoning`/`spawner`/`cli` (~50k LOC), Aurora's Python plumbing
that Node deletes for free (connection pooling, budget tracker, conversation logging, metrics,
retry handler, abstract multi-backend store), and the entire `lsp` package. The actual tuned
constants with Aurora file:line provenance live in the separate aurora borrow ledger
(litectx-prd.md:1624-1627).

## Requirement rollup — Tier A vs Tier B

The public API was organized into a build surface (litectx-prd.md:2274-2294) and then split by a
single discriminator: **does the contract depend on knowing how a specific consumer drives it, or
is it self-evident from litectx's own data model and falsifiable on litectx's own bench?**
(litectx-prd.md:2298-2309). Speculative API-grinding was rejected, but so was blocking
self-evident primitives on an adopter that "adds nothing to their design."

**Tier A (factory-independent, build now)** — shape fixed by litectx's own data, validated on
existing benches (litectx-prd.md:2310-2332):
- `compress(node,{level})` (R-C7) — **SHIPPED**, tree-sitter signature extraction, ~82% bytes
  saved with the doc kept.
- `evict(id | {olderThan, maxCount})` (R-G7) — **SHIPPED**, stash-only by construction.
- `recall().quality` (R-S8) — **DROPPED**: the activation-distribution premise was falsified
  (Part 1 §14 #4), and the fallback candidate (a confidence label off embeddings cosine) was
  separately POC-falsified — aggregate AUC 0.92 but no usable per-query threshold.
- `supersede(old,new)` (R-G5) — **DROPPED** as duplicative: `forget`+`remember` upsert already
  covers retire/replace/auto-freshness/promotion.

With all four resolved, Tier A was declared dry — "what's next" moved honestly to the
adopter-pulled Tier B, not a Tier-A scrape (litectx-prd.md:2326-2332).

**Tier B (adopter-pulled)** — shape genuinely unknown until a caller exists: `assemble` (R-G6/C2),
its ordering contract (R-X1/X4), `session/state` (R-W3/I2), and `clear`/`trim`/`summaryWindow`
(R-C3/C5/C6) (litectx-prd.md:2334-2345). A caution was flagged explicitly: `scope` (R-I1) reads as
"cheap" but touches every op (schema migration + a filter on every query) — invasive, not cheap
(litectx-prd.md:2343-2345).

## The bareagent RT-seam negotiation (2026-06-12)

bareagent's first real CE consumer cut five seams (RT-1…RT-5) into its loop and negotiated what
litectx owes on its side of each — this is the adopter Tier B was waiting on
(litectx-prd.md:2381-2391). The binding boundary principle: **litectx owns content + relevance; it
never learns the provider's transcript grammar** — bareagent adapts its own messages to litectx's
neutral shapes (litectx-prd.md:2393-2397).

- **RT-1** — `assemble(units, ctx) → units` over a neutral unit model, SHIPPED. `pinned` units
  never drop/reorder, `atomic` units never split — grammar safety by construction, not trust.
  Best-effort fit, never a hard cap; bareagent fail-opens to full context. The POC gate ("does
  budget-fit preserve task success?") passed: 8/8 correct next actions with the needed unit present
  vs 0/8 absent (litectx-prd.md:2399-2401).
- **RT-2** — a mid-round observe/harvest hook — **DEFERRED**, with the trip-wire that fired: once
  `trim` (R-C5) shipped, its `harvest[]` worklist supplies the litectx half of a
  harvest-before-evict interlock; only bareagent-side wiring remains (litectx-prd.md:2402).
- **RT-3** — `recall(q,{body:true})` and a sealed `meta` passthrough (`mem_meta`
  sibling table, never tokenized/scored) and the `liteCtxAsStore(lc)` adapter — all **SHIPPED**
  (litectx-prd.md:2403-2405).
- **RT-4** — sub-agent MCP toolbox mounting — **CLOSED with zero litectx code**; bareagent shipped
  its own mount, read-only by default, opted-in writes land in the child's own physically isolated
  `dbPath` (litectx-prd.md:2406).
- **RT-5** — `owner`/`session` scope keys — the litectx-side predicate **BUILT**; harness threading
  for many/ephemeral children in one store **DEFERRED**, since per-child `dbPath` already covers
  spawn isolation today (litectx-prd.md:2407).

## Doc/companion discipline

Build-now obligations are recorded as requirements in the PRD; the settled why/deferrals are
mirrored one line into project memory so the two RT deferrals are not re-litigated, while the
consumer-side seam shapes stay in the baresuite integration guide rather than the litectx PRD
(litectx-prd.md:2409-2411).

## The bareagent/bareguard lift

Per the standalone, copy-don't-depend principle: litectx never depends on baresuite at runtime, but
where a design exists in bareguard/bareagent it is copied and adapted for standalone fit, tagged
**[copy]** (lift as-is), **[adapt]** (lift + change), or **[cede]** (baresuite keeps it, litectx
only defines the seam) (litectx-prd.md:2439-2447).

**bareguard — gate the memory-write (R-G3/R-X2).** `remember()` emits a gate-able
`{type:"memory.write", ...}` action through an opt-in `writeGate`, checked before any side effect
— SHIPPED (litectx-prd.md:2450-2464). litectx copies-then-adapts bareguard's `Gate#check` decision
contract and its fixed 6-step floor-supremacy eval order (denies/asks run before the allowlist, so
a write can't relax the user's floor even if allowlisted) into its own minimal standalone hook
(litectx-prd.md:2465-2476). It ships its own audit log + `redact`, adapted from bareguard's design,
reused instead of double-logged when embedded (litectx-prd.md:2477-2484). The load-bearing
division: litectx computes and emits *content* signals (`provenance`, optional
`injectionRisk`) as structured flags; bareguard gates on those flags directly, never via a regex
over stringified content — litectx never encodes a verdict as matchable text
(litectx-prd.md:2485-2495).

**bareagent — insert around the loop, plug under the store (R-W*/R-I*).** `Loop.run` never
auto-reads memory; litectx sits around it (`assemble()` → `run()` → harvest → persist), zero loop
changes (litectx-prd.md:2497-2501). litectx ships a `{store,search,get,delete}` adapter matching
bareagent's `Store` interface with no runtime import, and **replaces** bareagent's `Memory`
passthrough for long-running use, while **ceding** `StateMachine`/`Checkpoint` (task-lifecycle
concerns that don't overlap litectx's context store) (litectx-prd.md:2502-2511). Sub-agent
spawning stays bareagent's (fork + lifecycle); litectx's contribution is a scoped store per child
(litectx-prd.md:2512-2516). Eviction (R-G7) is unclaimed in bareagent — litectx owns it
(litectx-prd.md:2517).

Several Aurora SOAR-survey capabilities were explicitly parked as **not litectx's**: a cost-budget
gate (design-only in Aurora, never built — belongs to bareguard), query-complexity assessment,
decomposition caps (2/4/6 sub-goals), closed-label agent-matching, verify-lite, and
success-verdict feeding (the *verdict* is bareagent's, the *boost* is litectx's R-W7) — all
bareagent's lane (litectx-prd.md:2530-2565).

**Consumption surface — who chooses the call.** The deciding question for each verb's channel is
whether *code* or a *model* decides to call it (litectx-prd.md:2566-2569). Direct `import` is
strictly better for program→library use (real types, in-process, no serialization). The MCP server
is a thin adapter whose only job is curating the verbs a reasoning model sees mid-task
(`recall`/`remember`/`impact`/`get`/`recent`/`promotions`); it never eases program consumption. The
CLI is the human/hook surface. Runtime-plumbing verbs (`stash`/`assemble`/`summaryWindow`/`trim`)
stay API-only by design so orchestration mechanics never clutter the model-facing toolbox
(litectx-prd.md:2571-2595). A second, separately-scoped MCP server is deferred until an autonomous
agent (not baresuite, which imports) needs CE-automation verbs over MCP
(litectx-prd.md:2597-2601).
