# Stash — litectx: v0.12.0 PUBLISHED (the Isolate scope model, built + grounded) · bareagent litectx-runtime doc drift fixed · NEXT = Build B (2026-06-13, session 8)

- **Date:** 2026-06-13. Continues from `2026-06-13-v0110-released-gates-regrounded-on-real-data-agentrules-propagated-session7.md` (session 7 = v0.11.0 assemble/FIT + §4.5 gates re-grounded). This session: **fixed cross-repo doc drift in bareagent, then built + grounded + shipped Build A (the scope model) as v0.12.0.**
- **Repo:** `/home/hamr/PycharmProjects/litectx` (`~/Documents/PycharmProjects` = same via symlink). Branch `main`.
- **litectx HEAD:** `6b6e1d3` (release 0.12.0). **origin in sync. v0.12.0 PUBLISHED to npm** (`latest: 0.12.0`, verified on registry via OIDC publish run 27476572912 — all gates green). Tag `v0.12.0` pushed.
- **bareagent HEAD:** `6f3ab76` (litectx-DX changeset). The user's own **security-scoped work stays UNCOMMITTED** in bareagent's tree (`src/mcp-bridge.js`, `src/provider-openai.js`, `test/mcp-bridge.test.js`, `test/fixtures/mock-mcp-server.js`, `examples/wake.sh`, untracked `poc/rt4-*.mjs`) — theirs, left untouched.

---

## 1. Fixed bareagent's litectx-runtime PRD drift (the user pointed at the file)
The shipped review found bareagent (v0.13.0) already reconciled the `assemble` seam — BUT `docs/01-product/litectx-runtime-prd.md` described two **delivered shapes wrongly**:
- **RT-3 `meta`**: doc said "a nullable `meta` TEXT **column** on the written-memory rows" → it actually shipped as the **non-FTS sibling table `mem_meta`** (v0.10.0). Fixed §3.2 #3 + migration note + §5.3 ("both nullable columns on same rows" → both additive sibling-table migrations).
- **scope**: doc said a single **`scope` TEXT column** → litectx settled it as **two keys `owner`+`session`**. Fixed §5.1/§5.3/§5 title/RT-5 row + 4× "scope column"→"scope keys" (incl. `WHERE scope=`→`WHERE owner=`/`session=`). Flagged storage form as not-yet-litectx-committed (prove-don't-assert; I had only hedged-built it).
- **bareagent code itself: NO correction needed** — assemble adapter (atomic group-id-per-bundle, `.units` unwrap, tokensApprox=chars/4), MCP curation (all 8 litectx-mcp verbs enumerated), store mount all faithful; reference-oracle test is a standing drift-detector.
- **One DX gap fixed** (committed `6f3ab76`): the **`ctx.budget` footgun** — unset budget → litectx fit = Infinity → silent no-op (litectx gets blamed for a wiring omission). Added a README assemble-row note + `examples/litectx-assemble.mjs` (runs against litectx's real verb; inline stand-in when absent). Verified: budget=400 → 18→2 msgs; unset → 18→18.

## 2. Build A SHIPPED — the Isolate scope model (§4.4), v0.12.0
**Graduated, not a POC** (gate #1 cleared 2026-06-13 on real data → built with tests). Two optional `LiteCtxConfig` keys:
- **`owner`** (actor, durable `fact`s) + **`session`** (run, volatile `episode`s). Default unset = global/durable = **byte-identical to pre-scope**. Kind-aware write: `fact`=owner; `episode`=owner+session; `code`/`doc` never scoped.
- **Storage:** new non-FTS sibling table **`mem_scope(path, owner, session)`** — `CREATE TABLE IF NOT EXISTS`, zero backfill (the `mem` FTS5 table can't `ALTER ADD COLUMN`; mirrors `mem_meta`). `forget` + `pruneStaleEpisodes` drop the scope row.
- **Read filter** on BOTH paths — `store.search()` (BM25; **no alias on `mem` — fts5 `bm25()`/MATCH need the real table name, not `m`**) + `store.knnCandidates()` (embeddings): `(:me IS NULL OR owner IS NULL OR owner=:me) AND (:sid IS NULL OR session IS NULL OR session=:sid)`. The `:me IS NULL` guard (vs the literal §4.4.7 sketch) makes an unset reader see everything — single-tenant default; literal `owner=NULL` would wrongly hide owned rows.
- **Identity is the host's** — litectx stores + filters, NO `git`/OS call in the constructor (kept lightweight; harness threads it — RT-5).
- **Scope on `mem` table only (fact/episode).** `stash` scope DEFERRED (no GC consumer yet — AGENT_RULES no-speculation; recall-burial, the proven need, is fact/episode).
- **Files:** `src/store.js` (schema + constructor `{owner,session}` + writeMemory scope + 2 read filters + forget/prune cleanup), `src/index.js` (config passthrough + JSDoc), `test/scope.test.js` (6 tests). Suite **214 pass / 0 fail / 1 pre-existing skip**, typecheck clean.

## 3. Grounded against gate #1's REAL data (verify-shipped-vs-poc-data)
`poc/scope-grounding.mjs` (new) replays gate #1's real transcripts (12 real Claude Code sessions) through the **SHIPPED** filter on ONE shared db:
- **UNSET reader reproduces the burial EXACTLY** (matches a fresh gate #1 run): own-held **0% BM25 / 2% emb**, rank1-stolen **3/3 BM25 / 10/10 emb**, both regimes.
- **session-set reader RECOVERS exactly**: **100% own-held, 0 foreign, == ISO gold** on every scored query. → PASS ✅.
- Falsifiable (UNSET 0% vs CURRENT 100% on the same db); not vacuous (==ISO on non-empty sets).
- **Numbers drifted vs session-7's recorded gate #1** (38%/8%, 5/6, 9/10 → now 0%/2%, 3/3, 10/10): the transcript corpus **grew during the day** (192 files now; the 12-session window rotated/densified). Sample-driven, NOT a phenomenon shift; verdict identical and stronger; recovery is corpus-independent.

## 4. Docs synced (all committed in 6b6e1d3)
CHANGELOG `[0.12.0]` · README status v0.12.0 + 215 tests + New-in entry · `litectx.context.md` (owner/session option rows + capability row + boundary note) · `bare-suite-buildable-now.md` §4.4.7 **BUILT** + gate #1 BUILT · CE-PRD **R-I1 SHIPPED** + RT-5 updated. CLAUDE.md unchanged (doctrine still accurate). The release commit also landed the user's pending §8.1 + benches-prd.md doc edits (validation-bench framing) since they were entangled and the user said commit the PRD.

---

## NEXT — Build B (the next graduated build; gate #2 already cleared)
**Compress signature budget-tier in `assemble()`.** Gate #2 (session 7) cleared **"signature as a rank/recency-driven budget tier"** and **REFUTED the positional middle-band framing** (lost-in-the-middle did not manifest on sonnet at ≤41k tokens). So:
- Build the **rank/recency-driven intermediate tier** in `assemble()`: keep verbatim → **down-tier to signature** (`compress()` is SHIPPED, R-C7) → drop, applied to the units FIT would otherwise drop. Composes on the shipped FIT verb.
- **Do NOT build a positional "middle valley" rule** — refuted for the target model.
- Honest limit (gate #2): signature preserves the doc/header, not the body. COMPRESS needs a parseable `format`, which only recall-injected (SELECT) units carry — so confirm where the format comes from for transcript units (may pair with SELECT, or apply only to units that carry a kind/format). Re-read gate #2 in `poc/RESULTS.md` §4.5 + `bare-suite-buildable-now.md` §4.3 before building.
- It's **graduated (no new POC)** — build properly with tests, then ground if it touches real ranking.

## Other open (trigger-gated, NOT pending POCs)
- **v0.12.0 is published** — nothing owed there.
- `stash` scope (when a GC consumer is built), harness-side RT-5 threading (when shared-db multi-tenant is real), persisted `call` edges, edge-confidence, jina-code model. All demand-gated.
- The session-7 stash + this stash are untracked in `.claude/stash/` — commit if the repo's stash-history convention wants them (prior stashes are tracked).

## Durable rules reinforced
- **[[verify-shipped-against-poc-data]]** — author-written unit tests are confirmatory; replay the real POC data through the SHIPPED code and reconcile. Did exactly this for Build A (`poc/scope-grounding.mjs`); UNSET reader == fresh gate #1.
- **[[prove-dont-assert]]** — the test must be able to FAIL (UNSET-vs-CURRENT contrast on one db); audit drifted numbers for confounds (corpus grew → checked file count/dates, not assumed); flagged my unbuilt storage-form choice as not-litectx-committed rather than asserting it in bareagent's doc.
- **Before overwriting, look at the target** — the bareagent PRD "drift" was a real delivered-shape mismatch (meta=table not column), found by reading code not trusting the explorer's "all clean."
- **Release cadence is the user's call** — cut + tag + OIDC `gh workflow run publish.yml` only when told; idempotent, verify END-STATE on the registry.
