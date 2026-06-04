# Stash — litectx: name reserved, repo live, POC PASSED (2 repos), methodology set, SLICES 0–1 SHIPPED

- **Date:** 2026-06-04
- **Repo:** `/home/hamr/PycharmProjects/litectx` (== `/home/hamr/Documents/PycharmProjects/litectx`, same inode). Git initialized this session; **public** GitHub repo `hamr0/litectx`, pushed to `main`.
- **Continues:** `.claude/stash/2026-06-04-litectx-prd-set.md` (PRD-set session). This session: **reserved the npm name, scaffolded the repo, ran the POC gate on two repos, locked the build methodology, and shipped slice 0 (the walking skeleton).** Next action = **slice 1 or 2**.
- **Mode:** shipping + validation. Real artifacts committed/pushed.

> **SLICE 0 SHIPPED (commit `47b3feb`).** Walking skeleton runs: `index → SQLite/FTS5 → recall`,
> file-granularity plain BM25. `src/` (LiteCtx, Store, indexer, tokenizer) + thin CLI `bin/litectx.js`
> + 6 passing `node --test` integration tests + typecheck clean (JSDoc→.d.ts). One prod dep
> (better-sqlite3). **Integration gate = `npm run bench` → `poc/bench-lib.mjs`** runs the REAL
> library on both repos (can't drift). **Slice-0 baseline to beat (both repos):**
> aurora ALL MRR **0.523** P@3 64% · gitdone ALL MRR **0.416** P@3 45%. Reproduces the ablation
> baseline within noise + same single aurora FTS miss (`decay.py`). NEXT slice must hold-or-beat
> these on BOTH repos.

---

## Headline outcomes this session

1. **npm name reserved** — `litectx@0.0.1` published (placeholder). User ran the OTP publish (2FA; the agent's non-TTY publish hung — user did it interactively).
2. **Repo live & configured** — public, Apache-2.0. Branch protection on `main` mirrors pulselog (1 PR review, no force-push, no deletion, admins NOT enforced → **owner pushes bypass**, which is intended; protection is for others). 17 topics set. README modeled on **pulselog's structure** (banner → pitch → badges → what-this-is → install → quick start → the graph → docs → license). CLAUDE.md + LICENSE + CHANGELOG.md + package.json (full lib shape: ESM, JSDoc→.d.ts toolchain, `files` whitelist).
3. **POC gate (PRD §11) — PASSED, on TWO repos.** Throwaway harness in `poc/` (dataset-driven, never shipped). Verdict nuanced — see below.
4. **Build methodology locked** (this session's discussion) — walking skeleton + vertical slices; aurora = second opinion, not oracle. **Being codified into PRD §11 + CHANGELOG now; then slice 0 starts.**

---

## POC RESULT — read this carefully (it's nuanced)

Harness: `poc/run.mjs <dataset>`, datasets in `poc/datasets/{aurora,gitdone}.mjs`, writeup `poc/RESULTS.md`. Indexes a repo's source into SQLite FTS5; for hand-verified (query→file) ground truth, orders the **same FTS candidate set** four ways and measures where the right file lands (MRR/P@1/P@3/P@5, split EASY/HARD).

Four rankers (weights over [bm25, git-bla, graph-spread]): `baseline`=[1,0,0], `+bla`=[.6,.4,0], `+spread`=[.6,0,.4], `litectx`=[.5,.3,.2].
- **git-bla** = `ln(Σ age_days^-0.5)`, commit timestamps as pseudo-accesses (PRD §4.1 cold-start). **NO decay/churn term implemented** (only the recency half of ACT-R).
- **graph-spread** = 1-hop: a candidate inherits best neighbor BM25 relevance. Edges: python imports / cjs relative requires.

**Findings (aurora: Py, 497 files, n=22 · gitdone: JS/CJS, 100 files, n=20):**
- **Graph spreading GENERALIZES — the robust win.** Positive on both repos, every breakdown, never hurts an aggregate (aurora HARD ΔMRR +0.050; gitdone HARD P@3 50%→70%). → **graph-as-substrate confirmed; build it.**
- **Git-BLA (flat 0.3) does NOT generalize.** Net-positive on aurora (hot-file/easy queries) but **net-negative on gitdone** (ALL −0.030, HARD −0.072); the combined `litectx` preset **LOST to plain BM25 on gitdone** (−0.067, 9/15 moved queries worse). The single-repo aurora run **overstated** BLA.

**CRITICAL CAVEAT (user's insight):** the POC rankers are Claude's crude approximations, NOT aurora's real calibrated algorithm — **decay+churn was omitted.** So "BLA hurts" may be an artifact of the half-implementation, not the idea. Do **not** preemptively "rework BLA" as gospel — investigate only if it misbehaves in the real build.

**Verdict:** PASS for **graph-aware recall**. Ship graph+spreading. Treat the activation/cold-start term as unproven at weight — implement decay+churn, demote BLA to a small term/tiebreaker, and **re-validate on BOTH repos** (adopt weights only if ≥ baseline on every repo). Keep `poc/` as the **multi-repo calibration gate**.

---

## DECIDED this session (added to PRD; do not relitigate)

- **§14 #5 RESOLVED — packaging.** Core = **library**. **Thin CLI ships in-repo** (`bin/`) from v1 (humans + cron + shell-out agents, near-zero cost, house style). **MCP and codegraph/contextgraph views = separate downstream consumers**, NOT core — they wrap the same public API (scope discipline: mechanism in lib, policy in adopter). MCP **stdio** = client-spawned subprocess, not a daemon → compatible with "no service tier," just lives in its own package when a consumer needs it.
- **§14 #1 (cold-start)** — POC-answered (partial): unified `ln(Σ t^-d)` recency prior does NOT generalize as a co-equal weight; valid only paired with decay+churn at a small/tiebreaker weight; multi-repo validation mandatory.
- **Build methodology** (being codified into §11):
  - **Aurora = second opinion, not oracle.** Borrow concept not output; aurora may be bloated/wrong; divergence = a question to investigate, not a bug to fix toward aurora. Manual/as-needed cross-check, NOT a CI dependency.
  - **Walking skeleton + vertical slices.** Thinnest end-to-end pipeline that RUNS on day one; grow one slice at a time; integrate each slice as it lands (never wire-up-at-the-end).
  - **"Works by itself" = observable end-to-end behavior, not isolated unit tests.** (User's lesson: a prior project built 5500 heavy-TDD unit tests with nothing connected → false coverage, huge cleanup. Inverted trophy.)
  - **The `poc/` labeled-query harness = the always-green integration gate.** Every slice must hold-or-beat its score on BOTH repos. Tests written per slice AFTER its design stabilizes (integration-first, `:memory:` SQLite + tmp repo, <60% mocking), per AGENT_RULES testing trophy.

---

## v1 BUILD SLICES (mapped from PRD §11.2)

- **Slice 0 — walking skeleton: ✅ DONE/SHIPPED** (commit `47b3feb`; baseline above).
- **Slice 1 — incremental indexing + hardened schema: ✅ DONE/SHIPPED.** `index()` is incremental + git-aware: fast skip on `(mtime, size)`, `content_hash` arbiter via new `file_index` table, drops deleted files; returns `{files, added, updated, removed, unchanged}`; `force`/`paths` opts. `kind`/`format` first-class columns (format routed by ext: ts/js/py/md), surfaced on recall hits. CLI `index` shows the breakdown + `--force`. **Recall path untouched → bench holds slice-0 baseline EXACTLY on both repos** (aurora 0.523 / gitdone 0.416). 14 `node --test` tests (added: incremental, deletion, **size-guard**, force, kind/format). Typecheck clean. **Caught + fixed a real silent-miss:** mtime-only detection skips a same-tick edit without hashing → added `size` to the fast signal (an edit almost always changes length); residual same-mtime/same-size swap is the documented `--force` corner. **Git-status pre-filter tier deferred** (mtime+size+hash already meets "skip ~95%").
- **Slice 2 (NEXT — where numbers move):** tree-sitter **symbol-level** chunking for TS/JS/Python + md section chunker. Replaces file-granularity; **benchmark must not regress**, should jump. POC-first: throwaway chunking POC (pick binding — lean **web-tree-sitter/WASM** for adopter install-portability — and confirm symbol-granularity beats file-granularity on both repos) before building properly. tree-sitter = the justified 2nd prod dep (core doctrine).
- **Slice 3:** code-aware BM25 + FTS5 gate + code-over-md (§5). (NB: slice-0 Store does path-doubling but NOT camelCase body-splitting — that lands here.)
- **Slice 4:** activation — base-level → **decay+churn** → spreading; **validate on both repos before BLA gets weight** (POC mandate); aurora cross-check only if a number looks off.
- **Slice 5:** edges (tree-sitter + ripgrep) → spreading in recall, then **impact view** (refs→risk bucket; complexity from AST).

**User chose slice 1 (foundation first); slice 1 now shipped → slice 2 is next.**

---

## Files this session

- **NEW (committed/pushed):** `package.json`, `README.md`, `LICENSE` (Apache-2.0, copy of pulselog's), `CHANGELOG.md`, `CLAUDE.md`, `.gitignore`, `poc/{run.mjs,RESULTS.md,package.json,package-lock.json}`, `poc/datasets/{aurora,gitdone}.mjs`. `poc/node_modules/` gitignored.
- **MODIFIED:** `docs/01-product/litectx-prd.md` (§11 POC result, §14 #1 + #5, §15 status → POC passed). `barecontext-prd.md` carried in.
- **`.claude/memory/`** holds `AGENT_RULES.md` + `LIBRARY_CONVENTIONS.md` (the two governing files; CLAUDE.md points at them as source of truth).
- Commits: `83fea95` scaffold → `7af69c7` POC aurora → `b885a84` POC gitdone. (PRD methodology + CHANGELOG commit pending.)

---

## NEXT (in order)
1. ✅ Codify methodology in PRD §11.1/§11.2 (commit `cb5ba8c`).
2. ✅ CHANGELOG entry (commit `cb5ba8c`).
3. ✅ Build slice 0 — walking skeleton (commit `47b3feb`).
4. ✅ Slice 1 — incremental indexing + hardened schema (see slices above; bench held exactly).
5. **Slice 2 — tree-sitter symbol-level chunking** (next). POC-gate the binding + the symbol-vs-file jump on both repos first, then build with tests; keep `npm run bench` ≥ baseline on BOTH repos; aurora = second opinion only.

## Commits this session
`83fea95` scaffold+PRDs → `7af69c7` POC aurora → `b885a84` POC gitdone → `cb5ba8c` methodology+changelog+stash → `47b3feb` slice 0. All pushed to `origin/main` (admin bypass of PR rule — intended).

## Key context for resuming
- **better-sqlite3** native build works on this Fedora box (root `node_modules/` + `poc/node_modules/` both built; gitignored).
- **Two aurora paths, same inode** as litectx's; aurora local HEAD `750a39d` == origin/main (current, not stale).
- **Governing docs:** `.claude/memory/{AGENT_RULES,LIBRARY_CONVENTIONS}.md` (CLAUDE.md points at them). pulselog (`/home/hamr/PycharmProjects/pulselog`) is the house-style reference (README shape, Apache LICENSE, `node --test`, JSDoc→.d.ts).
- **Branch protection** on `main`: 1 PR review, no force-push/delete, admins NOT enforced → owner pushes bypass (for others, not you).
- **npm:** `litectx@0.0.1` placeholder published; account `hamr0`; publish needs interactive OTP (agent non-TTY publish hangs → user runs it).
