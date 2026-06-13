# Stash — litectx RT-1..RT-5 seam negotiation recorded · **RT-3 (memory socket) BUILT + SHIPPED** · v0.10.0 released + pushed (2026-06-12, session 3)

- **Date:** 2026-06-12 (continues from `2026-06-12-tier-a-closed-evict-shipped-v080-released.md`).
- **Repo:** `/home/hamr/PycharmProjects/litectx` (`~/Documents/PycharmProjects` = symlink, same tree). Branch `main`.
- **HEAD:** `b0d92ed`. **Pushed** to `github.com/hamr0/litectx` — verified `origin/main == local b0d92ed` (push prints "Changes must be made through a pull request"; user has bypass, ref advanced — normal).
- **NOT done:** no git tag `v0.10.0`, no npm publish (user said "commit and push" only; publish = manual OIDC dispatch, their call). Offered both.
- **Working tree:** clean for delivered files. Pre-existing untracked (NOT mine, leave them): `examples/`, `poc/graph-substrate-poc.mjs`, `test/graph.test.js`, prior-session `.claude/stash/*` files, and this stash. `types/` is gitignored (build:types artifact).
- **Gates:** **197 tests** (196 pass / 1 skip) via `npm test` (= `node --test`, NOT vitest — vitest can't parse the node:test suites) · `npm run typecheck` (`tsc --noEmit`) clean · `npm run build:types` clean (emits the new surface). The 1 skip is PRE-EXISTING + unrelated (embeddings.test.js: skips *because* `@huggingface/transformers` IS installed → absent-dep contract untestable here).

---

## The arc this session — RT seam dialogue → record → build Track 1 (RT-3) → validate → release

Prior session ended at "what's next" with the litectx core complete and roadmap trigger-gated. This session the user worked through **bareagent's five loop seams (RT-1..RT-5)** — the holes bareagent cuts to consume litectx — negotiating **litectx's side of each**, one at a time, in discussion (user prefers prose+evidence over multiple-choice; led with recommendations, let them steer). Then: record the negotiation, build the one ready track, validate hard, release.

### The boundary principle that governs all five (the keystone)
**litectx owns content + relevance; it NEVER learns the provider's transcript grammar.** bareagent adapts ITS messages to litectx's neutral shapes — the Store-socket move run in reverse (litectx adapted to bareagent's Store for persistence; here bareagent adapts to litectx's shapes for consumption). This is what dissolves RT-1's two hard questions (tool-call/result pairing; protect the system prompt) at the **representation layer** (pins: `pinned`/`atomic` flags), not via trust or validation.

### RT outcomes (full ledger = CE-PRD §8.2; settled decisions = memory `bareagent-rt-seam-contract.md`)
- **RT-1 `assemble(units, ctx) → units`** — BUILD-NOW shape pinned (neutral unit `{id,role,content,kind,pinned,atomic,tokensApprox}`; SELECT+COMPRESS+fit-to-budget; cache-stable order; `pinned` never drops/reorders, `atomic`=tool-call+result bundled never splits → grammar/system-prompt safe by construction; fits best-effort & returns, bareagent does final grammar-check + **fail-OPEN**). **Opens with a POC, not a build** — "budget-fit preserves task success" is POC-gated, not asserted. **= Track 2, the one remaining litectx-side build.**
- **RT-2 post-round harvest hook** — **DEFERRED-ON-EVIDENCE.** No mid-round capability gap *while the canonical transcript is preserved intact* (every write target reconstructs losslessly from end-of-task `result.msgs`). Killed the candidates: access-log re-rank already falsified (ships at zero); same-session fact recall is circular (units already carry it). **Trip-wire: un-defers the day the transcript-truncation seam (R-C3/`trim`) ships, bound as a harvest-before-evict interlock** (can't drop history you haven't harvested). Secondary: it's also the *incremental* harvest vs end-of-task *batch* — efficiency only, same trip-wire.
- **RT-3 (the memory socket) — BUILT + SHIPPED this session. See below.**
- **RT-4 sub-agent toolbox** — **ZERO NEW litectx CODE** (now adapter-ready). `litectx-mcp` already curates read verbs (§10.5) + `liteCtxAsStore` + per-child `dbPath`. Child default read-only (recall/get/impact/recent allow; remember/forget opt-in; index/promotions deny). Writes → child's OWN dbPath (physical isolation, memory-PRD §3.2, no schema — **decouples RT-4 from RT-5**). Parent promotion = explicit `recall`(child)→`remember`(parent), never auto-bleed. Recipe/example/test are **bareagent's** side.
- **RT-5 `scope TEXT` column (R-I1)** — **DEFERRED.** Separate-dbPath (RT-4) covers spawn isolation today, zero schema. **Trip-wire: un-defers only for the shared-db multi-tenant case** (many/ephemeral children one store, or cross-child union queries). Invasive (predicate on every read/write/knn/access-log); backward-compatible default=global scope; **reuses RT-3's additive-column migration** (RT-3 graded the path).

### Recording routing (the user's explicit Q: "CE or memory?")
- **Spec/requirements → `litectx-ce-prd.md` §8.2** (NEW section, the obligation ledger) + §8.1 Tier-B `assemble` rows annotated resolved. NOT memory-PRD (that's stable-API; touch only when shipped — though RT-3 now IS shipped, so its API landed there too, below).
- **Settled why/deferrals → memory** `bareagent-rt-seam-contract.md` (one file; the deferrals especially, so RT-2/RT-5 aren't re-litigated).
- **Snapshot → `docs/02-engineering/bare-suite-buildable-now.md`.**
- Seam shapes (consumer side) stay in `docs/02-engineering/litectx-for-baresuite.md` (bareagent's contract; cites the PRD).

---

## Track 1 = RT-3 the memory socket — SHIPPED (5 feature commits + tests + docs)

So a host (bareagent's `Memory`) can mount litectx as its swappable backend instead of a substring-scan `JsonFileStore`, getting ranked graph-aware recall, host code unchanged. Three pieces, all grounded in the REAL frozen interface (`../bareagent/types/index.d.ts:58-62`: `Store { store/search/get/delete }`, `any` returns → async OK; `../bareagent/src/store-jsonfile.js` = reference projection `[{id,content,metadata,score}]`, mints own id, round-trips full metadata verbatim).

1. **`recall(q, {body:true})`** (`9df3f5a`) — inline-body flag, off by default. Kind-routed (the reason it's litectx's job not the adapter's): written memory → VERBATIM (`getItem.text`); localized file hit → the chunk's INDEXED body via new `store.chunkBodyAt(path,startLine,endLine)` (drift-free, what ranked, survives file leaving disk); nothing localized → whole file fresh from disk; null if gone/unknown. Facade helper `_attachBodies`. Does NOT log a fetch (part of recall, not get). Pure read-path, no migration. `test/recall-body.test.js` (8).
2. **`remember(id,text,{meta})`** (`5402a6e`) — sealed opaque-metadata passthrough. Stored in a **NEW non-FTS sibling table `mem_meta(path PRIMARY KEY, meta TEXT NOT NULL)`** (NOT an mem/docs fts5 column — fts5 can't ALTER ADD COLUMN, and a new `CREATE TABLE IF NOT EXISTS` is the most additive migration: old dbs gain empty table, no backfill). **Sealed BY CONSTRUCTION** — in no FTS table → never tokenized/searched/scored (tested: a term only in meta can't recall the memory). Facade owns JSON (de)serialize boundary; store holds raw TEXT. `writeMemory` upserts-or-clears; `forgetMemory`+`pruneStaleEpisodes` drop `mem_meta` (delMeta added); `getItem` returns raw meta; store `metaFor(paths)` batched; facade `_attachMeta` parses onto hits (always-run, no-op for code/no-meta). `get().meta`/`hit.meta` = parsed dict. `test/recall-meta.test.js` (7, incl. seal + embeddings-path).
3. **`liteCtxAsStore(lc, {kind?})`** (`1b57e77`) — NEW file `src/memory-store.js`, exported from index.js. Free function, copies host Store shape (NO host import). Resolves the 5 mismatches: #1 adapter mints `${kind}:${randomUUID()}` (node:crypto); #2 `recall({body:true})`; #3 kind/by consumed→typed cols, REST→sealed meta, reassembled on read (full dict round-trips like jsonfile); #4 default kind `fact`; #5 single-kind search (comparable scores). `store`/`search` async, `get`/`delete` sync. `test/memory-store.test.js` (8).

**Also fixed a pre-existing shipped defect** (`acc6ea0`): `src/store.js:300` `chunkKey` used a **raw NUL byte** (literal `\0`) as the symbol/body separator → whole file read as BINARY (grep/ripgrep silently skip, `git diff` "Binary files differ"). In HEAD since ≤0.8.0. Swapped raw byte → two-char `\0` escape (runtime-identical). Guard: `test/source-hygiene.test.js` scans `src/*.js` for raw NUL. **NOTE for future: grep/rg silently return NOTHING on a NUL-containing file — if grep mysteriously finds nothing in a file Read shows content for, check `file <f>` for "data"/binary.**

---

## Validation pass (user: "validate what you just delivered first" — prove, don't assert)
- Re-ran clean: 197 tests (196 pass/1 skip/0 fail), typecheck clean, no NUL anywhere in `src/*.js`, git clean, `types/` gitignored.
- Built `.d.ts` and confirmed the SHIPPED types carry the full surface (`liteCtxAsStore`, recall `body?`, `Hit.body`/`Hit.meta`, remember `meta?`, `Item.meta`, `memory-store.d.ts`).
- **Found the real gap: every body/meta test ran embeddings-OFF (BM25).** Smoke-tested the public entry with the REAL embeddings tier (dep installed) — a pure paraphrase ("holiday leave"→"paid time off") hit with body+meta correct → the KNN/tri-hybrid path works. Then made it permanent: added a committed regression test (`recall-meta.test.js`) using the suite's deterministic **stub-embedder** pattern (`{embeddings:true, embedder: vecStub()}`, 2 facts so cosine fusion engages — no model download, CI-safe) covering body+meta through KNN ranking. = +1 test (197).
- Caught my own smoke-script crash on `hits[0]` = CORRECT behavior (BM25 returns [] for a no-lexical-overlap query), not a bug.

---

## Release v0.10.0 ("the memory-socket release") + docs (`aec4e4b` status, `b0d92ed` release)
- `package.json` 0.9.0→0.10.0; CHANGELOG `[0.10.0]` (Added: 3 verbs; Fixed: NUL).
- README: banner v0.9.0→v0.10.0, `174→197` tests, "New in v0.10.0" memory-socket clause.
- `litectx.context.md`: FULLY updated in Track 1 (status rows version-stamped v0.10.0, recall opts, Hit/Item shapes, remember meta, NEW `liteCtxAsStore` API section, architecture sidecars `mem_text`/`mem_meta`).
- memory-PRD §3 API sketch: body/meta options + `liteCtxAsStore`.
- CE-PRD §8.2 + buildable-now: RT-3 rows marked SHIPPED with commit SHAs.

---

## NEXT (open) — Track 2: the `assemble` budget-fit POC
The one remaining litectx-side build from the whole RT negotiation. **It opens with a POC, NOT a build** (RT-1 doctrine): replay a real multi-round transcript, **assemble-fitted vs full**, confirm task outcome holds before writing the verb. Dropping a stale tool-result is safe; dropping the one about to be re-read is a silent regression — that's the gate. POC clears → build `assemble(units, ctx)` over the pinned neutral unit shape (reuses the body flag — units need bodies; reuses `compress()`). User last prompt was offered this; awaiting go.

Also outstanding (user's call, not blocking): tag `v0.10.0` + npm publish (manual OIDC dispatch) — offered, not done.

## Durable rules reinforced this session
- **prove-don't-assert** ([[prove-dont-assert]]) — validate before claiming; the embeddings-path gap + the NUL defect were both found by *running*, not reading.
- **A deferral must name the exact condition that un-defers it** (RT-2/RT-5 trip-wires), not just "later" — AGENT_RULES "every line earns its place."
- **litectx owns content/mechanism, never the host's control-flow grammar** — the seam boundary that keeps litectx standalone.
- Repo runs `node --test`, NOT vitest (CLAUDE.md says Vitest — stale).
