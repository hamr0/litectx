# Stash — the live ON/OFF A/B investigation: "recall finds, doesn't execute" (2026-06-14, session 10)

- **Date:** 2026-06-14. **Repo:** `/home/hamr/PycharmProjects/litectx`, branch `main`.
- **HEAD moved during session** (user's parallel session): now `281c283` (release 0.14.0 summaryWindow). My only working-tree change = **`docs/01-product/benches-prd.md` (uncommitted)** — the F1–F7 Findings section. Untouched everything else.
- **This session = experiment + analysis only.** No litectx source touched. All agent work ran on throwaway copies/worktrees (torn down). Real repo never at risk.

---

## What this session did
Continued the benches-prd "does litectx beat a non-graph baseline on real agent work?" question by actually **running** live ON (litectx recall/impact) vs OFF (grep-only) A/Bs, instead of designing a replay bench. Four experiments, all rebuild-a-stubbed-subsystem tasks with the repo's own test suite as the objective oracle. Safe-harness: independent copy / `git worktree` / throwaway `bench/*` branch / never push / oracle green-at-baseline / teardown. Walls: agents edit ONLY the stubbed files, no git-history/online recovery of the original; verified post-hoc (only N files changed, none byte-identical to original).

## The four experiments + results (all recorded in benches-prd §Findings F1–F7)
1. **`assemble` (litectx, SHORT, Opus):** litectx LOST ~2× (OFF 7 tools/24.7k; ON 15/44.9k). Task too short, spec handed over as tests → nothing to discover.
2. **`impact` subsystem (litectx, LONG, Opus, n=3):** rip out `src/impact.js`+`src/tsalias.js`. NO lift — tokens tied (ON 108.2k vs OFF 109.6k), ON +26% tools, 6/6 pass. Reason: greppable/familiar wiring; `chunker.js` already exported the hard primitives → "orchestration not discovery."
3. **`markdown-it` emphasis/strikethrough (3rd-party UNFAMILIAR repo, indirect non-greppable two-pass delimiter wiring, Opus, n=3) — the FAVORABLE regime:** litectx LOST on every axis (ON 15.7 tools/39.9k vs OFF 12.0/35.6k), 6/6 pass. All ON agents: **"recall POINTS but doesn't PAY"** — ranks right files fast, but bottleneck was (a) algorithm in-weights + (b) reading local contract, neither shortcut by recall.
4. **`markdown-it` re-run with HAIKU (n=3) + the error-keyed-memory design test:** Haiku CAN'T solve this task either arm (best 16 remaining of 144). Metric = remaining-failures-at-stop (Haiku doesn't finish).
   - OFF(grep): 23/35/81 (mean 46.3). ON-code(recall): 16/30/60 (35.3). **ON-mem (recall + seeded known-failure lessons, recalled by error): 30/35/30 (31.7).**
   - **Sign flipped** vs Opus (recall helps weak model on every order stat ~−24%) but it's a NUDGE not a rescue.
   - **Error-keyed memory (F7): KNOWING ≠ EXECUTING** — agents genuinely recalled the exact pitfall lessons (verified: 3-6 recalls, 4 `--kind fact` each) and STILL failed those exact edge cases. Only benefit = **variance collapse** (stabilizer: floors downside, caps upside), not capability.

## THE THROUGH-LINE (the session's conclusion)
**litectx reliably does RETRIEVAL (find files, surface lessons) — but retrieval was never the bottleneck.** Strong models don't need it; weak models need EXECUTION help it can't give. litectx's value is bounded by how much of a task is *locate* vs *do*; for coding, *do* dominates.
- In-run code discovery (recall/impact as agent scaffolding) = **thoroughly tested, NARROW.** Not the pitch.
- Error-keyed memory = helps only when fix is *execute-once-reminded* (mechanical), not a hard algorithm.
- **Un-refuted, where value plausibly lives:** (1) **cross-session persistence** (retrieval is the ONLY option — info not in context/weights; memory-bench already shows para recall 0→0.574); (2) **impact's safety invariant** (correctness property no speed A/B can measure).

## User's framing (their words, now confirmed)
- "litectx is a harness, can't think for you, helps with known failures" → TRUE but weak: it surfaces the known lesson reliably; surfacing only pays when the model can execute the fix once reminded.
- User hypothesized weak models benefit more (#2) → confirmed directionally (sign flip) but not a rescue.
- User pushed hard against premature "give up" / overclaiming → drove the Opus→favorable-regime→Haiku→memory escalation. Honor [[prove-dont-assert]]: don't fish for an in-run win; the in-run thesis is settled.

## State / next
- **benches-prd.md F1–F7 uncommitted** — offer to commit just that file (HEAD now 281c283; user has parallel work in flight, so let them bundle or commit solo on request). NOTE: F-intro still says "Five things" (stale, now 7) — fix if committing.
- Memory updated: [[litectx-lift-is-narrow-ab-results]] (full F1–F7), MEMORY.md index line.
- **Recommended next = NOT another in-run A/B (would be fishing).** Act on conclusion: reposition litectx pitch around persistence + safety. The ONE genuinely-different future test = cross-session memory in-task (stop/resume, recall right past decision among decoys; OFF has no mechanism) — optional.
- All sandboxes (`litectx-cp*`, `poc-subjects/`) torn down. Clean.
