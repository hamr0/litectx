# Stash — litectx RT-1 `assemble` budget-fit POC CLEARED + verb BUILT (v1=FIT) · 1.8%→3.8% corrected (2026-06-13, session 4)

- **Date:** 2026-06-13 (continues from `2026-06-12-rt3-memory-socket-shipped-v0100-released.md`).
- **Repo:** `/home/hamr/PycharmProjects/litectx` (`~/Documents/PycharmProjects` = same tree via symlink). Branch `main`.
- **HEAD:** `6bd4578`. **NOT pushed** — `origin/main` still `b0d92ed`; **4 new commits ahead** (`931956c`, `7a5de69`, `a666646`, `6bd4578`). No tag, no publish (v0.10.0 never tagged; `assemble` now sits in Unreleased on top).
- **Working tree:** clean for delivered files. Untracked = prior-session `.claude/stash/*` (NOT mine, leave) + this stash. `types/` gitignored (build:types artifact).
- **Gates:** **209 tests** (208 pass / 1 pre-existing skip = embeddings absent-dep contract, untestable here) via `npm test` (`node --test`, NOT vitest) · `npm run typecheck` clean · `npm run build:types` clean (emits `types/assemble.d.ts` + the surface).

---

## The arc this session — Track 2 (`assemble`): POC-first → build → verify-shipped → correct

Prior session ended with RT-3 shipped and "NEXT = Track 2 assemble, opens with a POC not a build." This session executed that, with the user pushing hard on rigor at each step ("real tests or made up tests fit to pass?", "validated or glossed over?").

### 1. The budget-fit POC — both halves PASS (commit `931956c`)
The one unproven RT-1 claim is **"fit-to-budget preserves task success,"** NOT "we can shrink context." The silent regression = dropping the unit a later round re-reads.
- **`poc/assemble-fit-poc.mjs` (structural).** Replays **8 real Claude Code transcripts** (`~/.claude/projects/*/*.jsonl`) → RT-1 neutral units `{id,role,content,kind,pinned,atomic,tokensApprox}`. Deps extracted **mechanically** (no hand-labels — the crafted-bench trap): `edit-after-read` (Edit/Write(P) needs the most-recent Read-result(P)) + `re-read`. **1059 deps.** Fit policies blind to dep edges. Finding: **recency-anchored** fit preserves task success; **semantic re-rank does NOT help** (re-reads are recency-bound, not topic-bound — a *discovered* constraint matching cache-stable order). Proved deps are genuinely hard: **57% long-range** (>2k tok between need & consumer).
- **`poc/assemble-fit-model-poc.mjs` (the "last bit" — live model).** `claude -p --tools '' --model sonnet` (tools OFF so it can't re-read & cheat), 8 clean edit-after-read cases, needed-Read PRESENT vs ABSENT, majority-of-3. **PRESENT 8/8, ABSENT 0/8** → structural proxy is real. Dropped unit → `CANNOT_DETERMINE` (explicit, non-silent) → rehydrate handle load-bearing.
- **Process honesty (prove-don't-assert):** first model run looked noisy (6/8, one inverted row); EVERY anomaly was a *measurement bug* surfaced only by re-running — (1) scorer stripped ``` ``` ``` but not inline backticks → failed a correct answer; (2) single-sample noise → majority-of-3; (3) the harness's own `claude -p` calls wrote NEW transcripts into the live corpus mid-run → skip files modified <120s ago; (4) self-inflicted array-aliasing bug (`chosenF=chosen` then `chosen.length=0` emptied both) printed "no clean cases" while selection found 8. Clean 8/8-vs-0/8 only after each fixed.
- POCs lean on **private transcripts + live CLI → do NOT graduate to the CI bench.** Evidence in `poc/`, recorded in `poc/RESULTS.md`.

### 2. Doc gate-clear (commit `7a5de69`)
CE-PRD §8.2 RT-1 row → "budget-fit POC ✅ CLEARED"; `bare-suite-buildable-now.md` snapshot; CHANGELOG Unreleased note.

### 3. Built `assemble` v1 (commit `a666646`)
**`src/assemble.js`** — `export function assemble(units, ctx) → { units, dropped, tokens }`. Pure function (no DB/model/clock → deterministic, cache-stable).
- **Recency-anchored FIT.** `pinned` never drops/reorders (budget = un-pinned room, "pin don't hide"); `atomic` groups kept-or-dropped WHOLE (broken grammar unrepresentable). Newest-first greedy, skip-and-continue; emit in ORIGINAL order. `dropped[]` accounts for every elided unit (no silent loss; restorable by id from the host's canonical transcript). Best-effort, never a hard cap.
- **Two scope decisions (flagged, not buried):** (a) **v1 = FIT only.** COMPRESS needs a parseable `format` the unit shape doesn't carry — only recall-injected units do — so COMPRESS is coupled to SELECT; both are the NEXT slice. (b) **Return shape `{units,dropped,tokens}`, not bare `units[]`** (honors dropped[]-load-bearing + litectx's own ce-eval-harness contract). **Seam note for bareagent:** their `fromUnits`/`unitAssembler` expects `units→units`; it reads `.units` (one-line unwrap). CE-PRD `→ units` is shorthand.
- Exported from `index.js`. `test/assemble.test.js` (12) covers every invariant. Context.md API section + status row + exports updated; CHANGELOG Unreleased → Added.

### 4. Verify-shipped + CORRECTION 1.8%→3.8% (commit `6bd4578`) — the key integrity move
User: "validated or glossed over?" Caught a real gloss: unit tests are **author-written/confirmatory** (passed first try ≠ validated), and I'd NOT checked the shipped verb reproduces the POC's real-data numbers. Ran **`poc/assemble-verify-shipped.mjs`** (imports the exported `assemble`, replays the same 8 transcripts): **shipped 3.8%@50%, NOT the POC's 1.8%** (mailproof **23% vs 2%**).
- **Root cause (instrumented, not guessed):** the POC's inline fit completed atomic groups POST-HOC with NO budget check — a needed *old* read's tiny tool-CALL (~18 tok) slipped in under budget and dragged its large RESULT (~1.2k tok) over → kept by **OVERFLOWING**. The shipped verb is **budget-honest** (over-budget atomic group drops whole) → long-range reads past the boundary fall out. **Shipped is more correct; POC's 1.8% was the artifact.**
- Correction does NOT weaken the verdict — **strengthens** dropped[]-with-handle (budget-honest fit drops more long-range reads; the rehydrate re-read recovers them; the live-model 8/8-vs-0/8 is independent, comparing present-vs-absent directly, not via a fit policy). **Verb kept as-is.** Corrected 1.8%→3.8% in RESULTS.md, CE-PRD §8.2, CHANGELOG.
- **Saved durable memory** `verify-shipped-against-poc-data.md` (feedback): after a real-data POC, replay that data through the SHIPPED code; a mismatch is a finding. Linked from MEMORY.md, cross-linked [[prove-dont-assert]].

### Cross-check done this session (no code): bareagent's `litectx-runtime-prd.md` two flags HOLD for litectx primitives — `kind:null` on transcript units is CORRECT (kind enum types graph nodes not turns; typing turns would breach the content-not-grammar boundary; role⊥kind, injected units carry kinds) · COMPRESS multi-result bundle → verbatim falls straight out of `compress()`'s no-format fallback. The two PRDs are consistent across RT-1..RT-5.

---

## NEXT (open) — litectx-side, dependency order
1. **Write the deterministic `assemble` CI gate** (the `ce-eval-harness-scenario` contract test — `docs/02-engineering/ce-eval-harness-scenario.md`). Closes the one honest gap: the verb's only CI coverage is 12 confirmatory unit tests + a *manual* real-data verify; no permanent hold-or-beat gate exists (the POC can't be one — private data + live model). **Recommended next: small, makes "graduated" true without an asterisk.**
2. **`assemble` SELECT + COMPRESS slice** — recall-inject new graph context + signature-tier large units. **Blocked on one boundary decision with bareagent:** an injected unit needs a `role`, and litectx assigning a role touches provider grammar → settle "what role does injected context carry" first or it breaches the keystone boundary.
3. Trigger-gated, NOT litectx work now: RT-4 (sub-agent toolbox, bareagent's recipe, zero litectx code) · RT-2 / RT-5 (deferred, named trip-wires) · old remainders (persist call edges, edge-confidence, jina-code model).
- **Outstanding, user's call (unchanged):** tag v0.10.0 + npm publish (manual OIDC); `assemble` is Unreleased on top.

## Durable rules reinforced
- **[[verify-shipped-against-poc-data]]** (NEW) — confirmatory unit tests ≠ validation; replay the POC's real data through the shipped code.
- **[[prove-dont-assert]]** — every "anomaly" this session was a measurement bug found by *running again*; the 1.8% overclaim corrected by *running the shipped code*.
- A deferral / scope-cut must name what un-defers it and be flagged, not buried (v1=FIT, the return-shape seam note).
- litectx owns content/relevance, never the host's transcript grammar (role⊥kind; injected-unit role is the gate on the SELECT slice).
