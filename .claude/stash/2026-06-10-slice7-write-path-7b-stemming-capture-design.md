# Stash: Slice 7 + 7b shipped (write path + stemming) · memory bench · capture design settled

**Date:** 2026-06-10
**State:** Uncommitted on `main` — slices 7 + 7b built/tested/gated but NOT committed. Last commit: `bcaab78` (slice 6 docs).

---

## What shipped this session (all gates green, nothing committed)

### Slice 7 — the write path (2026-06-09, PRD §3.2)
- `remember(id, text, { kind, format?, by?, occurredAt? })` / `forget(id)` / `forget({ kind, by })` on `LiteCtx`.
- `kind ∈ {fact, episode, doc}` — direct docs first-class; `code` rejected (enters via `index()` only).
- **Three axes:** `kind` (memory type → decay/retrieval), `format` (content form), `source` = HOW it entered (`file|direct`, internal) vs `by`/provenance = WHO asserted (`human|agent`, default agent).
- **Reconcile seam is structural:** written rows never enter `file_index`; `index()` deletes derive solely from `file_index` keys → written memory provably survives every index pass. `forget` scoped to `source='direct'` — can't touch indexed files.
- `recall_log` table: every recall hit logged (impressions — audit + future access log). `recallCount(path)`, `reviewCandidates(threshold=5)` (HITL: agent facts past recall threshold → human validates via re-remember `by:"human"` or invalidates via forget; gates REVIEW not RANKING).
- `occurred_at` constitutive for episodes only (epoch ms, default now; facts store null).
- 13 integration tests (`test/memory.test.js`).

### bench:memory — written-memory recall quality gate (§11.3)
- `poc/memory-bench.mjs` + `poc/datasets/memory-facts.mjs` (corpus IN the dataset: 24 facts + 5 episodes; pure-memory mode, no index(), runs anywhere).
- 32 queries labeled **exact / morph / para** + mechanical label audit (exact must share ≥1 keyword with target's indexed text incl. id; morph/para must share 0). Mutation-checked 3 ways.
- First run: exact 1.000 / **morph 0.000 (total — FTS5 has no stemming)** / para 0.000.

### Slice 7b — written-memory stemming (2026-06-10, PRD §5.1)
- **Porter-everywhere MEASURED AND REJECTED** (every-repo rule): aurora 0.552→0.530 (breaks floor), multis 0.457→0.431, gitdone P@1 25%→15%. Mechanism: code word-forms are distinct symbols (`token/tokens/tokenize`); stemming dilutes identifier precision. Recorded in poc/RESULTS.md.
- **Aurora grounding:** aurora ships `tokenize='porter ascii'` but ONLY as stage-1 gate, re-ranked separately; litectx FTS = gate AND ranker → porter moves rankings. "Stem the gate, rank exact" = documented future option for code morph.
- **Shipped:** second FTS table `mem` (`porter unicode61`) for fact/episode, kind-routed in `search()`/`writeMemory()`; doc/code (incl. DIRECT docs — one kind = one ranking domain) stay unstemmed in `docs`. `forgetMemory` covers both tables; `reviewCandidates` reads `mem`; `count()` = both.
- **Result: morph 0.000→0.722** (floored ≥0.7; `expected` pin tripped on the move as designed then graduated; residual = derivational "deployment/deploys" + compounding "rollback/rolled back"); exact 1.000; para 0.000 pinned (embeddings tier); **code gates byte-identical**.
- 79/79 tests; typecheck clean; all benches pass (aurora 0.552 / gitdone 0.425 / impact 0/0 / memory 0 failures).

---

## Capture design SETTLED (PRD §14 #4, revised ×2 by user's razor)

The access-log tier's core question: how to know an item was USED (BLA fuel). Evolution:
1. ~~`used(id)` courtesy API~~ → empty log, nobody instruments politeness.
2. ~~Fetch toll-gate (get(id) logs body fetch)~~ → DEMOTED: agents fetch greedily (5 snippets → takes 5; agent attention isn't scarce like human clicks) → fetch ≈ impression = forbidden rich-get-richer. MCP binds nothing (offers tools).
3. **SETTLED: bind to ACTIONS, not reads.**
   - **Code: the EDIT** — recalled at t + chunk changed by next `index()` (content-hash + nodes line ranges) = chunk-level use from disk truth. Immune to greedy fetch / context-holding / MCP indifference. Chunk = tree-sitter AST unit. Recency-windowed. `impact(symbol)` = second touch.
   - **Facts: the WRITE-BACKS** — re-`remember` (reinforcement), `forget` (negative), human promotion (strongest trust event). Sparse-but-true > dense-but-fake (friction lesson: 15 false antigens from dense proxies → 0 from sparse observed reactions).
   - Weak signals (impressions/fetches) logged with type tags but structurally powerless: BLA bounded (log-scale, small additive) + decaying + **bench-gated per signal type**.
   - Chunk-granular recall = QUALITY move (function pointer > file pointer), NOT capture (forced-choice dies to greedy fetch).
   - Activation re-ranks, NEVER gates (stemming fixes the gate; activation fixes the rank).

## Other settled models (this session's discussion)
- **Cold start: NOT a problem.** Day-one recall = BM25 + spreading (+ embeddings opt-in) — what the benches already gate. Git-seeding re-litigated AGAIN and closed: topic-blind prior (lifts same hot files for every query); git = display-only metadata (`git: {commits, lastCommit}`). Aurora's activation-led gate starved rare chunks and aurora itself removed it (v0.17.1 → FTS5).
- **Lifecycle:** born → found by matching(+graph) → used → strengthened by real use. Access = retrieval-that-was-used (click), never appearance (impression).
- **The user's razor (now doctrine):** does this signal measure the thing, or something that merely correlates on lucky days? Killed: git-seeded BLA, porter-on-the-ranker, fetch-toll.

---

## Docs state (all synced this session)
- **PRD:** §3.2 (write path), §5.1 (stemming decision + porter evidence), §9 (tables incl. mem/recall_log), §11.2 (slices 7+7b SHIPPED), §11.3 (write round-trip + memory-quality gate rows), §14 #4 (capture design, revised ×2), #6 RESOLVED, §15 status.
- **CHANGELOG:** slice 7 + 7b + bench:memory entries under Unreleased; Changed: recall async (was), 4-kind grouped recall, recall()-now-writes (no log:false opt-out yet — open).
- **litectx.context.md:** write-path API sections, entry-path-decides-kinds, stemming gotcha rewritten, architecture (2 FTS tables), status table.
- **README:** quickstart remember/forget lines, write-path paragraph, 77→(now 79) tests note.
- **poc/RESULTS.md:** memory bench + porter probe + porter-everywhere four-repo rejection.
- **Project memory:** `slice7-write-path.md` fully updated.

## Next builds (sequenced, user-confirmed direction)
1. **Chunk-granular recall** (quality: function pointer > file pointer) — now motivated.
2. **`get(id)` / body access** — needed for MCP usability (fact text is only inside litectx; hits carry no body). Logging = tagged weak signal only.
3. **MCP/CLI parity** (§14 #5) — separate `litectx-mcp` pkg, stdio, client-spawned; tools: index/recall/impact/remember/forget/get.
4. **Access-log tier** — score BLA on action-grade signals (edit-bind, write-backs), episodes-first (recency), bench-gated per signal type. Trust-weighting (human > agent).
Open small item: `log: false` opt-out on recall() (read-only db consumers).

## Session lessons (meta)
- User called out premature "complete" claims twice: (1) tested-vs-built gap (3 behaviors shipped untested), (2) "cheap" framing minimizing it. Fix applied: tests written, reviewCandidates built (was doc-claimed but unbuilt). Rule: green suite ≠ tested surface; check "complete" against the built surface.
- Ground deliveries with receipts (schema lines, empirical probes, named test lists), not rolled-up counts.
- User prefers: discussion in prose, decisions PRD-first, measure-before-decide (every fork this session was settled by running the experiment same-day).
