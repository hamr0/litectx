# Stash — litectx Track-2 `assemble` SELECT-leg POC **FAILED its gate** → don't auto-build SELECT (2026-06-13, session 5)

- **Date:** 2026-06-13 (continues from `2026-06-13-rt1-assemble-fit-poc-cleared-verb-built-v1.md`).
- **Repo:** `/home/hamr/PycharmProjects/litectx` (`~/Documents/PycharmProjects` = same tree via symlink). Branch `main`.
- **HEAD:** `6bd4578`. **NOT pushed** — `origin/main` still `b0d92ed`, **4 commits ahead** (`931956c` `7a5de69` `a666646` `6bd4578`). **v0.10.0 NEVER tagged** (tags stop at `v0.9.0`) and **NEVER published** (`npm view litectx version` → **0.9.0**). `package.json` says `0.10.0`; `assemble` (FIT) sits in **Unreleased on top of that** — so the release story is two versions behind the code (a deliberate pending decision, NOT an oversight).
- **Working tree (UNCOMMITTED — this session's deliverable):** `poc/assemble-select-poc.mjs` (untracked, NEW) + `poc/RESULTS.md` (modified — SELECT findings appended). Other untracked = prior-session `.claude/stash/*` + this file. `types/` gitignored.
- **Gates:** **209 tests** (208 pass / 1 pre-existing skip = embeddings absent-dep contract) · `npm run typecheck` clean · `npm run build:types` clean. (Test runner = `node --test` via `npm test`, NOT vitest.)

---

## The arc this session — Track-2 SELECT leg: POC-FIRST → **gate FAILED** → scoped verdict

`assemble` v1 is **FIT-only** (shipped `a666646`). The next slice is SELECT/COMPRESS. Per doctrine, SELECT opens with a POC, not a build. **It did, and the POC says do NOT build auto-SELECT yet.** This is the headline.

### The question (the one genuinely-unproven SELECT assumption — CE-PRD §8.1)
FIT's model POC proved: drop the unit a later action needs → model FAILS (8/8 PRESENT vs 0/8 ABSENT). **SELECT's promise** is that litectx can put that off-window context *back* by **retrieving it from the graph index**. But the recall benches use **curated dev questions**; at the assemble moment there is **no curated query — only in-window signal** (what the agent is doing right now). *Can recall, queried with in-window signal alone, surface the chunk the next action needs?* If no, auto-SELECT is inert regardless of any model lift.

### Method (`poc/assemble-select-poc.mjs`, prove-don't-assert, NO hand-labels)
Reuse the FIT POC's **mechanical edit-after-read cases** (an Edit whose `old_string` ≥24 chars is a real substring of the most-recent Read result of that file — exactly the off-window chunk a budget drops). Index each transcript's **live repo**; query recall with **in-window signal ONLY** — target file basename + identifiers from the agent's recent text + identifiers from the `new_string` it's writing — **NEVER the `old_string`** (that's the answer under test; peeking = the crafted-bench cheat). **8 repos, 43 cases.** HIT = the anchor reappears in some top-K recalled body. Fairness gate: only score a case whose anchor still exists in the live index.

### Result (BM25-only; **embeddings ON ≡ OFF**, byte-identical)
| metric | rate |
|---|---|
| file-level re-supply | **24/43 = 56%** (median rank **1**) |
| exact-chunk re-supply (unchanged files) | **6/24 = 25%** |
| …**ex-dominant-repo** (drop top contributor) | **0/13 = 0%** |

The 56% file-level number is **bimodal & mailproof-dominated** (mailproof 13/13 @100%, latefyi 75%; dwi 0%, plato 20%, litectx 25%). The **strict** metric — did the bytes the action needs actually come back — is **25%, and 0% outside the single repo that carries it. It does NOT generalize.** Embeddings change nothing because **code recall is BM25-GATED** (cosine re-ranks the FTS candidate set, never *nominates* for code — KNN-union is fact/episode only), so the misses are lexical-gate misses the in-window query can't anchor; cosine can't recover them.

### VERDICT (recorded in `poc/RESULTS.md`)
**Auto-SELECT keyed on in-window task text is NOT a dependable re-supply signal** (chunk-level ~0% outside one repo). Two honest consequences:
1. **"Re-supply the file I'm editing" should be a DIRECT PATH FETCH** (`get`/`impact` by path — near-100%, no lexical gamble), **NOT** lexical recall. SELECT shouldn't own that case.
2. **recall-SELECT's real value is the NEVER-read related file** (e.g. a callee def) — which this mechanical proxy **cannot label**, and which needs an **EXPLICIT query**, not auto-derived in-window text.
→ **Do NOT build auto-SELECT on this signal yet.** Either scope SELECT to path-fetch re-supply, or POC the never-read mode with an agent-supplied query before committing the slice.

### Process honesty (again — [[prove-dont-assert]] / [[verify-shipped-against-poc-data]])
**4 harness bugs each printed a clean-but-FALSE 0%**, surfaced only by *running*: (1) on-disk cache reused a partial db; (2) transcript `file_path` is **absolute + uses the `/Documents` symlink** while `hit.path` is repo-relative → path compare + disk read both silently failed; (3) the big one — `new LiteCtx({dbPath})` **creates the db file in its constructor**, so the `existsSync` cache-guard was always true → `index()` skipped → every cached db empty; (4) symlink realpath mismatch on the fairness gate. Every "0%" was a measurement bug, not a result.

---

## OUTSTANDING / what's next

1. **Commit this session's deliverable.** `poc/assemble-select-poc.mjs` + `poc/RESULTS.md` are uncommitted. Suggested: `poc(assemble): SELECT-leg re-supply POC — gate FAILED, auto-SELECT inert on in-window signal`. (POC leans on **private transcripts + indexes live repos → does NOT graduate to the CI bench**, like the FIT POCs.)
2. **The release decision is the big standing item.** Code is at `0.10.0` (memory-socket RT-3) **+ Unreleased `assemble` FIT** on top; origin is 2 releases behind (`b0d92ed`), **nothing pushed, v0.10.0 untagged, npm still 0.9.0.** Needs a call: push `main`, tag, and publish — and decide the version (assemble FIT likely makes it `0.11.0`, or fold into a single `0.10.0` publish). **Do not publish without the user's go** (prior sessions published via manual `gh workflow run publish.yml` — OIDC trusted publishing, no token).
3. **SELECT slice is now gated, not building.** Per the verdict: pick (a) scope SELECT to **path-fetch re-supply** (`get`/`impact` by path — the dependable case), or (b) **POC the never-read mode** with an agent-supplied query first. Don't write auto-SELECT keyed on in-window text.
4. **COMPRESS is still coupled to SELECT** (needs a parseable `format` only recall-injected units carry — FIT-only units don't). Lands with whatever SELECT shape is chosen.
5. **bareagent RT seam (CE-PRD §8.2 ledger):** RT-3 shipped; RT-1 `assemble` FIT built (their `fromUnits` reads `.units` — one-line unwrap of `{units,dropped,tokens}`). Still deferred: RT-2 harvest (un-defers with the trim/truncation interlock), RT-4 sub-agent toolbox (zero new code — `litectx-mcp` + `liteCtxAsStore` + child-own `dbPath`), RT-5 `scope` column R-I1 (shared-db multi-tenant only). Handoff doc: `docs/02-engineering/litectx-for-baresuite.md`.

## Carry-forward gotchas
- **Push to `main` bypasses PR-protection** (user has bypass) — every push prints "Changes must be made through a pull request"; it still lands.
- `store.js` had a raw **NUL byte** that broke `grep`; **FIXED** `acc6ea0` (replaced with `\0` escape in the chunk-key separator). grep works on store.js now.
- **`new LiteCtx({dbPath})` creates the db file in its constructor** — an `existsSync(dbPath)` "is it indexed yet?" guard is ALWAYS true and silently skips `index()`. Gate on a content check (e.g. `nodeCount()`), not file existence. (Bit the SELECT POC.)
- Transcript `file_path`s are **absolute and may resolve through the `/Documents` symlink**; `hit.path`/index paths are **repo-relative**. Normalize via `realpath` + repo-relativize before comparing or reading.
- **Code recall is BM25-gated**: cosine re-ranks the FTS candidate pool, never nominates for `code` (KNN-union nominates for `fact`/`episode` only). So embeddings cannot rescue a lexical-gate miss on code — relevant to any "just turn on embeddings" instinct.
- Embeddings POC/bench needs `@huggingface/transformers` (present in this env; the 1 skipped test is its absence-guard).
- The user's standing bar: **prove don't assert, don't re-open closed issues, don't overclaim.** This session: a POC gate that came back FAIL was reported as FAIL (not massaged into a build), and 4 false-0% harness bugs were caught by re-running.
