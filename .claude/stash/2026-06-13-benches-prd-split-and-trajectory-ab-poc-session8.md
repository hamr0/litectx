# Stash — Software-Factory → benches-prd split + the live ON/OFF trajectory A/B POC (2026-06-13, session 8)

- **Date:** 2026-06-13 (continues from `2026-06-13-v0110-released-gates-regrounded-on-real-data-agentrules-propagated-session7.md`).
- **Repo:** `/home/hamr/PycharmProjects/litectx`, branch `main`, HEAD `6b6e1d3` (v0.12.0 — Isolate scope model). **Original working tree has ~9 IN-FLIGHT scope changes that are NOT mine** (the user's parallel session-7+ owner/session work on `src/index.js`, `src/store.js`, untracked `poc/scope-grounding.mjs` + `test/scope.test.js`). Leave them alone; don't conflate with this session's doc edits.
- **This session = design/POC only.** No litectx source touched. My edits are docs-only.

---

## The arc

### 1. Reframed "Software Factory" → split into a bench + an optional spike
User reconsidered the shape of the SF (ref: fabro `github.com/fabro-sh/fabro`, pi.dev). Pushback held: SF's two purposes were propping each other up. **Validation collapses into a litectx BENCH** (no app needed); the **fabro-like factory becomes an optional, honestly-labeled personal spike** that *stands on fabro* (don't rebuild the shell) and serves litectx over MCP. Pi never lands in litectx — projects out, never in.

### 2. Doc changes (DONE, in working tree)
- `git mv docs/01-product/software-factory-prd.md → benches-prd.md`, **rewritten** into Part A (validation bench, VB-1..VB-7) + Part B (factory spike, FS-1..FS-6) + A7 (catalogue of the existing bench suite: bench-lib/impact-bench/memory-bench/access-bench + run.mjs/binding-bench).
- `docs/01-product/litectx-ce-prd.md`: 2 cross-links retargeted to `benches-prd.md` (§8.1 adopter line + Tier-A "validated on [existing benches]").
- `.claude/stash/*` references to the old filename left as historical record (not rewritten).

### 3. POC'd the "realwork bench" — the riskiest assumption, not the easy part
- **Warm-up (aurora/gitdone via `npm run bench:ablation` + `bench`):** clean single-step recall ON−OFF (graph-spread vs BM25) = **+0.028 aurora / +0.021 gitdone** — small but real. Shipped library gate passes floors.
- **Pinned two confounds into the PRD:**
  - **VB-2a — ON = the *shipped* `recall()` path, NEVER `run.mjs`'s `litectx` ablation arm** (it bundles the falsified `+bla` activation term → swings ±0.1 by repo: aurora-EASY +0.155, gitdone −0.067, aurora-HARD −0.099).
  - **VB-4a — weight the trace toward natural-language queries** (keyword corpora understate the edge: +0.02 keyword vs +0.2 NL per recall-litmus).
  - **D4 — corpus = aurora + gitdone + litectx** (real git history; memory column rides litectx's own decision/stash log).
- **RT-1 `assemble` harvest POC (live MCP):** recall ranked `src/assemble.js` **1,1,1,6** on NL queries (grep-OFF found it too, unranked among 5/4/2 — modest ranking edge). **Memory column degenerate** (1 fact → trivial rank-1) AND **the index has NO memory-vector table** (`file_embeddings` = 152 code files only; `mem` is FTS-only) → paraphrase recall ≈ 0 in this env. Cleaned up the test fact (`forget`).

### 4. **THE KEY POC FINDING** — the realwork *replay bench* is largely redundant
Each replayable column (recall→bench-lib, impact→impact-bench, memory→memory-bench) just re-scores an EXISTING per-primitive bench on a real-task corpus. The objection "recall-given-working-set differs" fails: shipped `recall()` is `query→ranked files`, the working set isn't a scoring input. **The ONE genuinely new claim — multi-step compounding — is structurally NON-REPLAYABLE** (needs a live agent trajectory). ⟹ Don't build a standalone realwork replay gate; (1) feed real-task NL queries into existing benches, (2) the compounding claim = a live ON-vs-OFF trajectory run = **evidence, not a gate (VB-6)**. *(Part A of benches-prd NOT yet rewritten to reflect this — offered, user steered to running the experiment.)*

### 5. Built + proved the live ON/OFF trajectory harness (the safe-worktree A/B)
- **Safety model (proven on mcp-gov):** different repo / `git worktree` / throwaway `bench/*` branch / **never push** / test oracle green-at-baseline / `worktree remove`+`branch -D` cleanup / always `git -C <repo>` never bare git. All four walls held; mcp-gov ended pristine, nothing pushed. **mcp-gov is already cleaned up.**
  - The mcp-gov shakedown agent found a real bug (`extractService` returns `""` not `"unknown"` for `_`-prefixed tools → silent policy-bypass), fixed it, 137 green, committed local-only. It used **grep/read only — no litectx** (a natural OFF arm).
- **aurora is BLOCKED as an A/B subject:** no venv anywhere, `aurora-core` invisible to python, ML src-layout monorepo → no runnable oracle without standing up a heavy per-worktree venv. gitdone also needs setup (no node_modules, no wired test script). **Only mcp-gov + litectx are turnkey.** Distinction surfaced: **corpus (read-only, easy) ≠ A/B subject (needs a runnable test oracle).**

### 6. The litectx-cp ON/OFF A/B (RAN — litectx LOST)
- User: "copy folder litectx-cp" → made a **full independent copy** (1.3G, own `.git`), reset to clean `6b6e1d3`, baseline **214/215 green**.
- Task: **revert-rebuild `assemble`** — stubbed `src/assemble.js` to throw (only its 12 tests fail, 202 others pass), committed on `bench/base`, forked two worktrees.
- ON arm uses the litectx **CLI against its OWN worktree** (`node bin/litectx.js index . / recall --root .`) to avoid MCP binding to the real repo. OFF = grep-only. Fairness rule: no recovering the original from git history.
- **Result:** both reached 12/12 + 214 green. **OFF: 7 tools / 24.7k tok / 69s. ON: 15 tools / 44.9k tok / 146s.** litectx **LOST ~2×** — not because recall failed (1 call nailed the exact context incl. the budget-honest subtlety) but because the task was short + the spec (tests) was handed over → nothing to discover → grep sufficed, litectx's index-build was pure overhead.

---

## The recurring meta-finding (now 4 independent signals)
**litectx's lift is NARROW** — it only helps on **big/unfamiliar codebases that require *discovery***, not on short/well-signposted tasks. Signals: (1) warm-up keyword corpora, (2) recall column on clean repo, (3) mcp-gov shakedown (agent didn't need litectx), (4) assemble A/B (lost 2×).

## User's reframe (last message) + where we are
**"The bench must validate LONG-RUNNING tasks — that's the whole point of litectx; the short tests were unfair."** Correct. litectx = long-running agents ([[litectx-absorbs-all-ce-primitives]]); every test so far measured the one shape where it has nothing to offer.

## NEXT ACTION (awaiting user greenlight)
**Run one fair, LONG, discovery-heavy A/B on litectx-cp:**
- **Rip out a whole SUBSYSTEM** (not one function) — candidate: `src/impact.js` + `src/tsalias.js`, keep `test/impact.test.js` + `test/impact-alias.test.js` as the clean oracle. Big + wired into graph/langdef/ripgrep → forces real navigation = long + discovery-heavy + objectively scored.
- **ON vs OFF, n≥3** per side (signal not anecdote). Measure: finish? steps? context burned? did ON drift-less / find-faster as the task got long.
- Then a **cheaper second test for the OTHER long-running half — cross-session memory** (stop, resume fresh, litectx recalls prior decisions; OFF structurally can't — but design it so the win is "retrieve the right memory by meaning among many," not just "has a notes file," to avoid a strawman).
- Honest stance to keep: this is the FAIR test litectx hasn't had; if it can't win on a long discovery task either, that becomes the conclusion (fold into benches-prd Part A) rather than chasing.

## Sandbox state — STILL ON DISK (cleanup pending)
- `/home/hamr/PycharmProjects/litectx-cp` (copy, branch `bench/base`, `assemble` stubbed, node_modules real)
- `/home/hamr/PycharmProjects/litectx-cp-on` (worktree, branch `bench/on`, node_modules symlinked)
- `/home/hamr/PycharmProjects/litectx-cp-off` (worktree, branch `bench/off`)
- **Cleanup when done:** `rm -rf /home/hamr/PycharmProjects/litectx-cp*` (independent copy → safe; real litectx untouched).
- mcp-gov: already cleaned (no residue).

## Open / not-yet-done
- **Rewrite benches-prd Part A** to reflect §4 finding (replay bench redundant; compounding = live trajectory evidence). Deferred.
- Decide δ (win threshold) per the long A/B.
- Possible memory worth writing once the long test concludes: "litectx lift is narrow — validate ON discovery-heavy long tasks only" (don't write yet; let the long test confirm/refute).
