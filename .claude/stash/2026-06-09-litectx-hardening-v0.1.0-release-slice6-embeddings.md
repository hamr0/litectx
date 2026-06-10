# Stash — litectx: hardening → v0.1.0 npm release → Slice 6 embeddings tier (all shipped); next = general-memory plan

- **Date:** 2026-06-09
- **Repo:** `/home/hamr/PycharmProjects/litectx` (git `main`, public `hamr0/litectx`). `Documents/PycharmProjects/litectx` is the SAME checkout.
- **Continues:** `.claude/stash/2026-06-09-litectx-slice5b-barrel-alias-and-ts-gate.md`. Chain: slice5(a/b) → **composing test → hardening (CI+gates) → v0.1.0 release → embeddings POC → Slice 6 embeddings tier**. All committed+pushed.
- **Mode:** BUILD + ship. Real `src/`, tested, benched, published to npm, all green. Governing: `.claude/memory/{AGENT_RULES,LIBRARY_CONVENTIONS}.md`; SoT `docs/01-product/litectx-memory-prd.md`; CLAUDE.md doctrine.

## HEAD == upstream == `bcaab78` (pushed). This session's commits on `main` (oldest→newest):
- `9fb56aa` test: composing scenario — recall+impact over one shared graph (§11.3)
- `47fad41` ci: push/PR + publish workflows; assert recall MRR floor (§11.3, conventions §5)
- `7935ec9` ci: install ripgrep before tests; document rg as an impact() runtime prereq
- `92eee02` ci: bump checkout/setup-node to **v5** (Node-20 runtime deprecation, forced 2026-06-16)
- `a6698ad` docs: ripgrep prereq in README; record hardening validation + publish caveat
- `93c147c` docs(readme): reflect shipped v1 surface, correct API examples to reality
- `9a6143d` **release: v0.1.0** — first functional release (v1 read surface)
- `6ca994a` docs: v0.1.0 is published — sync README + resolve OIDC caveats
- `9c48ca6` poc(embeddings): tier gate PASSES — tri-hybrid beats dual on both repos
- `5a86cb0` **slice 6: embeddings tier** (opt-in semantic recall) — POC-validated, tested
- `bcaab78` docs(slice 6): embeddings tier shipped; recall() now async  ← HEAD

## What shipped this session

### 1. Composing-scenario test (`test/composing.test.js`)
Pins "one graph, two views, no re-extraction": index once → recall ranks defining file first → impact() on same ctx (no re-index) reports that file as def site (cross-view identity), resolves callee + both callers, reverse direction works; doc/node/edge counts unchanged after both views. Mutation-checked (impact→fresh empty store turns both red).

### 2. Hardening — CI + asserted gates (LIBRARY_CONVENTIONS §5)
- **`.github/workflows/ci.yml`** — push/PR: `npm ci → typecheck → build:types → test`. No lint (§5). Installs **ripgrep** before tests (impact() hard-needs `rg`; absent rg ⇒ 0 callers ⇒ false isolation). Actions pinned **@v5** (Node-20 deprecation, forced 2026-06-16). **Watched green on a real runner.**
- **`.github/workflows/publish.yml`** — manual `workflow_dispatch`, **OIDC trusted publishing** (no NPM_TOKEN), idempotent (skip-if-published + verify end-state), `prepublishOnly` builds types into tarball. **Proven green** (published v0.1.0).
- **Recall gate graduated:** `poc/bench-lib.mjs` asserts a committed **ALL-MRR floor** per dataset (aurora ≥ **0.55** vs 0.552; gitdone ≥ **0.42** vs 0.425; floors in `poc/datasets/{aurora,gitdone}.mjs`). Non-zero exit on regression (mutation-checked). Corpus-absent → skipped, never failed → stays a **LOCAL pre-push gate, not a CI step**.
- **Impact gate** already exit-codes on §7.2 invariants (0 silent isolations, 0 ISO misses) — left untouched (caller-recall QUALITY deliberately un-gated).

### 3. v0.1.0 — first functional npm release (PUBLISHED, verified live)
`0.0.1` placeholder → **`0.1.0`** (`npm view litectx version` → 0.1.0). Tag `v0.1.0` pushed. OIDC publish path proven. **One-time setup the USER did:** configured the npmjs trusted publisher. Tarball ships `src/` (+wasm grammars) + `bin/` + generated `types/` + README + context + CHANGELOG + LICENSE; no repo-only files leak.

### 4. Slice 6 — embeddings tier (opt-in semantic recall) — the big one
**POC-validated before building** (POC-first). `poc/embeddings-poc.mjs` rounds 1+2, findings in `poc/RESULTS.md`:
- **Lift gate PASSES:** gitdone dual 0.425 → tri **0.647** (w=1.0); aurora 0.552 → 0.774. Reproduced **through shipped LiteCtx** (reran twice live, identical).
- **(A) distilled vs head = WASH** → ship simpler **head-truncation** (the distilled claim did NOT pan out — POC killed a needless mechanism).
- **(B) weight:** held-out **multis** confirmed **no overfitting cliff** → default **w=1.0** (conservative; bench is NL-only).
- **(C) search latency:** 4–6 ms/query warm (gated brute-force).

**Build decisions, all POC-locked:**
- **Storage = float32 `BLOB` per file in the SAME db, NO sqlite-vec** (recall is BM25-gated → cosine is O(pool), sub-ms at any repo size; sqlite-vec = native ext against lite doctrine). `file_embeddings(path, dim, vec)` table.
- **File-level**, head-truncated text (matches recall's unit; keeps index cost = files not chunks).
- **Model** `Xenova/all-MiniLM-L6-v2` via transformers.js, **optional peer dependency**, lazy-loaded (core stays one-prod-dep; missing dep fails loudly). Non-literal `import(pkg)` so tsc doesn't demand it / CI stays light.
- **Incremental:** only changed files re-embedded; deletes drop vector; query embedding LRU-cached.
- **Aurora learnings (read aurora source):** aurora used `all-MiniLM-L6-v2` + **BLOB column (not sqlite-vec)** + **lazy import** ("avoids 20+s startup") + **query LRU cache** + chunk-type-aware weights (CODE 0.5/0.3/0.2 bm25/act-r/semantic — keeps code-semantic LOW; KB 0.3/0.3/0.4). Indexing pain = batch-size + device; incremental skip-unchanged is the big lever.

**Files:** new `src/embedder.js` (`Embedder`, `cosine`; both exported from index.js). `src/store.js` (+file_embeddings schema/reset/applyChanges/getEmbeddings/embeddingCount). `src/index.js` (config `{embeddings, embedWeight, embedModel, embedder}`; lazy `embedder` getter; `_embedQuery` LRU; embed upserts in index(); **recall() now ASYNC** with `_rankKind` fusion = `norm(dual)+w·norm(cos)` over a 400-pool). `package.json` optional peerDependency. `bin/litectx.js` awaits recall.
**API BREAK (pre-1.0): `recall()` is now async** — uniform with index/impact. All call sites migrated (tests/bench/poc/bin/README/context). Next release = **0.2.0**.
**Tests:** `test/embeddings.test.js` — **9 hermetic tests w/ an INJECTED stub embedder** (storage round-trip, incremental re-embed, delete, fused re-rank, off-path invariant, query cache, missing-dep guard). Real model NOT in test path (kept hermetic).

## Validation of record (all GREEN, grounded by execution this session)
- **64/64** `node --test`; **typecheck clean**; recall gate **0.552/0.425 PASS**; impact gate exit 0.
- Embeddings grounded end-to-end: 9/9 wiring (stub) + **real-model lift reran live through shipped LiteCtx = 0.425→0.647** (ephemeral `@xenova` install, self-cleaned; missing-dep test confirmed @xenova truly absent after).
- CLI grounded: real index→recall→impact on a git fixture works after async migration.
- Tarball: hard deps still only `better-sqlite3`+`web-tree-sitter`; `@xenova` optional-peer only; `src/embedder.js` ships.

## Docs updated + pushed
CHANGELOG ([Unreleased] Added: slice 6; Changed: BREAKING async recall → 0.2.0; [0.1.0] release entry). `litectx.context.md` (recall async + Promise; embeddings config options; tier ✅ shipped; fixed stale sync/roadmap refs). README (await recall; opt-in embeddings snippet; status). PRD §11.2/capability table/§ storage (slice 6 SHIPPED; float32 BLOB, sqlite-vec rejected). **Borrow-ledger NOT touched** (memory flags it as historically carrying not-mine edits — get user OK first).

## NOT MINE — left untouched/uncommitted (deliberate, as every prior stash)
- `README.md` had the "Where litectx fits" baresuite/litectx positioning section (pre-existing) — user explicitly told me to commit README this session, so it IS committed now (with my edits).
- `docs/01-product/software-factory-prd.md` (?? untracked) — someone else's draft. DO NOT commit.
- The prior `.claude/stash/2026-06-09-...slice5b...md` (?? untracked) — prior session's stash, not committed.

## NEXT — general-memory plan (user clarified the vision; NOTHING built yet; awaiting steer)
User's def of "memory": a **drop-in memory** you assemble OR use readily via **MCP/CLI** to index+search across kinds (**code/facts/episodes**), default-all/n=5, specify-what-to-retrieve; **impact (ripgrep "fast LSP") usable standalone**; composable with the rest of the **CE primitives** (Write/Select/Compress/Isolate — memory `litectx-absorbs-all-ce-primitives`).
**Recall defaults confirmed to user:** omit kind → grouped over all `KINDS` n=5; single kind → flat n=10. `KINDS=["code","doc"]` today; `fact`/`episode` schema-reserved but NOT active.
**The one real gap = the Write primitive** (recall is already kind-agnostic — point at `kind:"fact"` and BM25/embeddings just work). Proposed plan (dependency-ordered), PENDING user decisions:
1. **Slice 7 — Write API** (`remember`/`forget`) + activate `fact`/`episode` in KINDS. Crux: directly-written memories must be **excluded from index()'s disk-reconciliation delete** (else index() deletes facts as "vanished files") → add a **`source` discriminator (`file`|`direct`)**; facts stored **whole** (prose, no tree-sitter chunk), **caller-supplied id/key**.
2. **MCP server** (separate package — downstream consumer) exposing index/recall/impact/remember as tools = the "anyone plugs it in, no code" surface.
3. **CLI parity** — `--embeddings` flag + `remember` command (CLI is currently dual-only, can't toggle embeddings).
**3 decisions asked of user (unanswered):** (a) fact identity = caller-supplied id [my lean] vs generated; (b) `source` column to keep files+facts coexisting [my lean yes]; (c) episodes = same `{kind,text,id}` mechanism for v1, defer episode-specific fields [my lean].
Build heart = (1). My recommendation: settle the 3 decisions → build slice 7 (POC-light, recall path already exists) → MCP wrapper → CLI parity.

## Known gaps / debt (documented, non-blocking)
- CLI can't toggle embeddings (no `--embeddings` flag) — thin CLI, dual-only.
- Embeddings: file-level + sequential embed (batching deferred — `embedMany` is sequential); only general model tested (code model + chunk-level = future refinements, RESULTS.md).
- 5b single-hop gaps remain (multi-hop barrels, Python `from x import y as z`).
- 0.2.0 not cut (async recall is the breaking change that warrants it); user hasn't asked to release.

## Memories to consider writing (`.../litectx/memory/`)
- NEW project memory: "Slice 6 embeddings tier shipped" (opt-in; float32 BLOB not sqlite-vec; head-truncation; w=1.0; transformers.js optional peer dep; recall() now async). Links [[litectx-absorbs-all-ce-primitives]], [[borrow-aurora-dont-restart]].
- NEW project memory: "v0.1.0 published to npm; OIDC publish.yml proven; next release 0.2.0".
- Update index MEMORY.md accordingly.
