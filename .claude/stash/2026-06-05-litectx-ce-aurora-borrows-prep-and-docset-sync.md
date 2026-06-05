# Stash — litectx CE track: aurora CE-primitive borrows mined, copy-pattern studies + eval-harness drafted, R-X4 added, whole CE doc set synced to PRD (2026-06-05)

- **Date:** 2026-06-05
- **Repo:** `/home/hamr/PycharmProjects/litectx` (== `/home/hamr/Documents/PycharmProjects/litectx`, same inode 4481739). cwd = `poc/`.
- **Aurora repo:** `/home/hamr/PycharmProjects/aurora` (== `…/Documents/…/aurora`, same inode 3681847) **@ `750a39d`** — matches the borrow-ledger header. ✅ path question resolved.
- **Track:** CE-PRIMITIVES track (design/docs only). **No `src/` touched, no code shipped.** Continuation of the prep-walkthrough from `2026-06-05-litectx-ce-doc-set-and-prd.md` (the "4 prep items").
- **Mode:** discovery + design docs. Memory rule in play: *prefers discussion/opinion over multiple-choice*; lead with prose, let user steer.

---

## Headline outcomes this session

1. **Prep #3 (aurora CE-primitive survey) — ✅ DONE.** Dispatched an Explore agent over aurora `packages/soar/`, `packages/reasoning/`. Wrote **borrow-ledger §13** with file:line + carry/correct verdicts. **Three corrections to what the docs implied:**
   - **R-C7 (rank-tiered render) — ✅ built, CARRY shape, reimplement.** `decompose.py:243-310`, **inlined** in `_build_context_summary` (not a discrete fn). Real mechanism is richer than "render to docstring": `CHUNK_LIMITS = {MEDIUM:(5,8),COMPLEX:(7,12),CRITICAL:(10,15)}` = `(TOP_N_full_code, MAX)` → top-N **verbatim**, tail **docstring-only**, drop past cap. Folds into R-C2 assemble().
   - **R-S8 (retrieval-quality NONE/WEAK/GOOD) — ⚠️ DESIGN ONLY, never built.** Thresholds `0.3 / 0.7 / 3` live only in `SOAR_ARCHITECTURE.md`, absent from code → reclassified **litectx-original**, thresholds are **untested priors**.
   - **R-W7 (success boost) — ✅ confirmed.** `record.py:282-283`: `+0.2` if conf≥0.8 else `+0.05`; skip <0.5. "success" = `synthesis_result.confidence` (LLM) → the *verdict* is ceded to bareagent, the boost is litectx.
   - **Sibling borrows (CE-PRD §10.4):** cost-budget gate → **bareguard** but ⚠️ **design-only in aurora too** (`tracker.py` tracks spend, no caps/gate) → build fresh. Complexity-regex (`assess.py:82-343`) + decomposition caps (`SUBGOAL_LIMITS={MEDIUM:2,COMPLEX:4,CRITICAL:6}` `decompose.py:167`; few-shot is a SEPARATE knob, now 0/1/1/2 `examples.py:111-116`) → **bareagent**.
2. **Prep #4 (copy-pattern API studies) — ✅ DONE.** 3 parallel web-research agents → `docs/02-engineering/copy-pattern-studies.md`. Key synthesis: **ADK handle pattern + Manus restorable compression are the SAME contract** (storage/presentation split = keep-handle/drop-payload) → jointly define R-C4/R-C3/R-I3 as one store-backed mechanism. **LlamaIndex `ChatSummaryMemoryBuffer` is DEPRECATED** (→ `Memory`+blocks); carry the *pattern* not the class; its recompute-drift weakness is fixed by keeping handles to summarized turns. Build R-C4 first; C3/I3/C6-handles fall out.
3. **Prep #1 (CE eval-harness scenario) — ✅ DRAFTED** (was only "locked", now written): `docs/02-engineering/ce-eval-harness-scenario.md`. One seeded graph (relevant + stale-v1 + poisoned + distractors + 2 scopes), W→S→C→I flow with **assertion at every boundary**, **pins the `assemble()` I/O contract** (blocks[] ordered+precedence+tier · dropped[] restorable · quality · tokens≤budget). The CE counterpart of `poc/bench-lib.mjs`, hold-or-beat. Won't *run* until memory engine graduates.
4. **New requirement R-X4 (Authority/precedence ordering)** added — the 4th Breunig failure mode (Context Clash) had no requirement. Closes the W/S/C/I × 4-failure-mode matrix. Composition note: X1 (cache-order) / X2 (freshness) / X4 (authority) are 3 non-contradictory axes. Lost-in-the-middle positioning = parked as an emergent heuristic (R-W6 head + R-W4 tail + R-X1), not a new req.
5. **Whole CE doc set synced to the PRD** (user: *"i dont want diff lang, make them consistent"*). **Full R-id parity: 36 IDs in PRD = 36 in ce-tree, zero missing/extra**, all **id-first** (`R-W2 Memory kinds`), marks (🧩/🔧/⊘) + source tags consistent across tree↔flow↔prd. Added ce-tree **§3.0 Foundation (R-G1–G7)** + **§3.5 Cross-cutting (R-X1–X4)**; updated §0 overview + §9 mermaid. README indexes all 3 engineering companions.

---

## Files touched this session (all docs)
- `docs/02-engineering/aurora-borrow-ledger.md` — **+§13** (SOAR/CE borrows, carry/correct, file:line); path-note resolved.
- `docs/02-engineering/copy-pattern-studies.md` — **NEW** (LlamaIndex/ADK/Manus API + adaptation deltas + §4 synthesis).
- `docs/02-engineering/ce-eval-harness-scenario.md` — **NEW** (walking-skeleton test; pins assemble() contract).
- `docs/01-product/litectx-ce-prd.md` — R-W7/R-C7 confirmed, R-S8 reclassified, **+R-X4** (§6), §8 rollup, §9/§10.4 stale-pending fixed, status header, engineering-companion links on R-C4/C6/I3.
- `docs/00-context/ce-tree.md` — +§3.0 Foundation, +§3.5 Cross-cutting, all leaves id-first, Arize woven, Clash row → R-X4, mermaid + §0 overview synced.
- `docs/00-context/ce-flow.md` — +§3.6 Arize (validation source), +§6 authority-ordering row, Arize §6 confirms.
- `docs/00-context/ce-tree.md` §8 + `ce-flow.md` — `[Arize]` source = `youtube.com/watch?v=esY99nYXxR4` (the Sally-Ann Delucia "Alex" talk).
- `docs/00-context/README.md` — engineering-companions section.

---

## State of the 4 prep items (from prior stash)
- #1 CE eval-harness — ✅ **drafted** (scenario doc written).
- #2 Schema forward-compat — ✅ LOCKED (reserve `scope` + `source` nullable cols; R-W3 session/state table additive-later). *Not yet written as a doc.*
- #3 Aurora CE-primitive survey — ✅ **DONE** (ledger §13).
- #4 Copy-pattern studies — ✅ **DONE** (copy-pattern-studies.md).

---

## Key invariants / decisions to respect
- **Everything is design-ahead & BUILD-GATED behind core memory** (memory-PRD §11). No CE code until recall/impact slices graduate. CE constants are **priors** (R-S8 `0.3/0.7/3`, R-W7 `+0.2/+0.05`, R-C7 `(top_N,max)`, LlamaIndex `0.7/30k`) — earn weight only via the `poc/` bench gate on both repos.
- **litectx = pure library (no LLM, no loop, no orchestration).** "harness" = sibling repos that import it: **bareagent** (loop/decomp/agent-matching/spawn), **bareguard** (budgets/guardrails/content-trust), **baresuite** (one-shot). Rule: *orchestration→bareagent · budget/trust→bareguard · graph ops→litectx.*
- **Two PRDs, no fold:** `litectx-memory-prd.md` (engine) + `litectx-ce-prd.md` (CE primitives). `barecontext-prd.md` superseded (banner present).
- Doc evidence trails: aurora memory-signals + SOAR/CE borrows → `aurora-borrow-ledger.md`; external-library adapt patterns → `copy-pattern-studies.md`.

---

## Clarifications confirmed in post-sync Q&A (no doc changes)
- **Build order reconfirmed:** CE build comes **after** core memory, never before — *"we will wait until we get core memory right."* Allowed before that: **design-ahead docs only** (this session). Sources agree: ce-doc-set stash #5, ce-prd §9, CLAUDE.md. First CE *build* target when the gate opens = **R-C4 restorable store**.
- **Where the aurora→bareguard borrow lives:** CE-PRD **§10.4** (line 329, bareguard bullet) + ledger **§13.4** (line 426). It is **exactly one thing — the cost-budget gate** (per-tier $ caps $0.001/$0.05/$0.50/$2.00 + soft-80%/hard-100% + monthly tracker), and ⚠️ **design-only in aurora** (`aurora_core/budget/tracker.py` tracks spend, no caps/gate) → **build fresh**. Everything else from SOAR = **bareagent**, not bareguard.
- **Direction nuance (don't confuse):** CE-PRD **§10.1 = bareguard→litectx** (litectx *copies* bareguard's gate contract / floor supremacy / audit-redact). CE-PRD **§10.4 = aurora→bareguard** (the cost-gate bareguard should absorb). Opposite flows.

## Next actions (when resuming)
1. **Optional CLAUDE.md pointer** to `litectx-ce-prd.md` — the one remaining edit the CE-PRD §9 lists (deferred "until CE build begins").
2. **Prep #2 schema note** could be written as a doc anytime (design-only) if wanted.
3. Otherwise: **wait for core memory** (memory slices through recall) before any CE build; first CE build target per the studies = **R-C4 restorable store primitive** (C3/I3/C6-handles fall out of it).
4. Possible: propagate the same R-id discipline / Clash-fix mark into any other derived doc if new ones appear.
