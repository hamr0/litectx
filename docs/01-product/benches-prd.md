# Software Factory — split into a litectx **validation bench** + an optional **factory spike**

> **What this is.** This doc used to frame the "Software Factory" as one thing: an autonomous
> developer agent whose #1 job was to validate litectx. We split it. The two purposes were
> propping each other up, and once separated, one of them collapses into a bench:
>
> - **Part A — Validation = a litectx bench.** The falsifiable "does litectx beat a non-graph
>   baseline on real work?" question is a **bench that lives inside litectx**, next to
>   `impact-bench`/`memory-bench`, gated locally on every change. **No standalone app is needed
>   to validate litectx.** This is the part that ships.
> - **Part B — The Factory = an optional, honestly-labeled spike.** A fabro-like agent console
>   (graphs + swim-lane + HITL + Pi). It is **not validation** and **not a litectx example**. It
>   exists to (a) *harvest* the real-work traces Part A replays and (b) scratch the build-itch /
>   try Pi. It **stands on fabro's shell** rather than rebuilding it, and it **may reveal**
>   primitive gaps but **never dictates** litectx's API.
>
> **Status.** Part A is **DONE** — the validation suite ships (see A7: recall/impact/memory + the
> `assemble`/`summaryWindow` VALUE gates; the redundant `realwork-bench` is deliberately unbuilt per F1).
> Part B is **PARKED** (2026-06-14) — optional, personal R&D, not on any roadmap; see the banner at Part B.
> Supersedes the prior SF-1..SF-15 / SF-D1..SF-D2 numbering (this doc is design-only, nothing in
> code references those IDs).
>
> **Update 2026-06-13 — the A/B has now been *run*, not just designed. See [Findings to date](#findings-to-date-2026-06-13--the-live-ab-and-what-it-changes)
> below; the empirical results change Part A's conclusion (the replay bench is largely redundant;
> litectx's single-run discovery lift is narrow). The Part A design (VB-1..VB-7) is kept as rationale
> but is superseded where Findings conflict.**

---

# Findings to date (2026-06-13) — the live A/B, and what it changes

We stopped *designing* the validation bench and ran the actual experiment. Five things came out of it;
they refine (and in places supersede) the Part A design below.

## F1 — The replay bench (VB-2..VB-5) is largely redundant

Each replayable column just **re-scores an existing per-primitive bench** on a real-task corpus:
recall→`bench-lib`, impact→`impact-bench`, memory→`memory-bench`. The "recall-given-the-working-set
differs" objection fails — shipped `recall()` is `query → ranked files`; the working set is **not** a
scoring input. The one genuinely new claim — **multi-step compounding** — is structurally
**non-replayable** (it needs a live agent trajectory). ⟹ Don't build a standalone `realwork-bench`
gate. Instead: (1) feed real-task **NL** queries into the existing benches (VB-4a); (2) the
compounding claim is a **live ON-vs-OFF trajectory run = evidence (VB-6), not a per-commit gate**.

## F2 — Corpus ≠ A/B subject (the constraint that bounds every live test)

A read-only **corpus** is cheap (any local checkout). A live **A/B subject** needs a *runnable,
green-at-baseline test oracle* so "did it work" is a fact, not an opinion — a much higher bar. Of the
corpus repos, **aurora** (no venv anywhere, ML src-layout monorepo) and **gitdone** (no
`node_modules`, no wired test script) **cannot** serve as A/B subjects without standing up heavy
per-worktree environments. Only **mcp-gov** and **litectx itself** are turnkey. This is *why* the
large-unfamiliar-repo A/B (the case that would most favor litectx) hasn't been run — it is blocked on
**building an oracle**, not on willingness (see F4).

## F3 — Two live A/B trajectory runs (safe-copy worktree harness)

Safety model, held on every run: an **independent copy or `git worktree`** / throwaway `bench/*`
branch / **never push** / oracle **green at baseline** / teardown after. The real litectx checkout is
never touched.

- **Run 1 — `assemble` (SHORT, single function).** Revert-rebuild `src/assemble.js` (its 12 tests the
  oracle). ON = grep + litectx CLI; OFF = grep only. Both reached green. **OFF: 7 tools / 24.7k tok /
  69s. ON: 15 / 44.9k / 146s — litectx LOST ~2×.** Not a recall failure (one call nailed the context);
  the task was too short and the spec was *handed over* as tests → nothing to discover, and the
  cold index-build was pure overhead.

- **Run 2 — the `impact` subsystem (LONG, discovery-heavy, n=3 per side).** Rip out `src/impact.js` +
  `src/tsalias.js` (19 tests across core / barrel-alias / recall↔impact compose / MCP as the oracle).
  ON ran against a **pre-warmed** index (cold-build measured *separately* = **11.9s**, model cached);
  OFF was grep-only. Fairness walls verified post-hoc on **all six** worktrees: only the two permitted
  files changed, `tsc` clean, and **none byte-identical to the original** (no git-history recovery).

  | Arm | Tools (mean) | Tokens (mean) | Pass rate |
  |---|---|---|---|
  | **ON** (grep + warm recall) | **27.7** | **108.2k** | **3/3** |
  | **OFF** (grep only) | **22.0** | **109.6k** | **3/3** |

  **Verdict: no measurable lift.** Tokens are a dead tie (ON 1.3% *lower* — noise); ON used **+26%
  more tool calls**; both arms finished every run. (Wall-clock omitted — the runs shared CPU, so it's
  confounded; tools + tokens are the clean metrics.) All six agents *independently* reported the same
  reason: the surviving `src/chunker.js` already exported every hard primitive (`analyzeBody`,
  `callSitesOf`, `reExportsOf`, `importBindingsOf`), so impact was **orchestration, not discovery** —
  recall helped "orientation," but reading 3–4 obvious files was decisive.

- **Run 3 — `markdown-it` emphasis/strikethrough (LONG, n=3, the *favorable* regime).** The Run-2
  caveat said the impact test under-tested the favorable case (litectx's own greppable, familiar code).
  So Run 3 deliberately built that case: a **third-party, unfamiliar** repo
  ([markdown-it](https://github.com/markdown-it/markdown-it), MIT, turnkey — `npm install` + 941 tests
  green out of the box, no build) and a subsystem with **indirect, non-greppable wiring** — rip out the
  two-pass inline-emphasis rules (`lib/rules_inline/emphasis.mjs` + `strikethrough.mjs`; delimiters
  pushed in pass 1, linked by `balance_pairs.mjs`, resolved in pass 2). ON had warm `recall` **and**
  working `impact`; OFF grep-only. Walls verified post-hoc on all six (only the 2 files, both suites
  green, none identical to original).

  | Arm | Tools (mean) | Tokens (mean) | Pass rate |
  |---|---|---|---|
  | **ON** (grep + recall + impact) | **15.7** | **39.9k** | **3/3** |
  | **OFF** (grep only) | **12.0** | **35.6k** | **3/3** |

  **Verdict: litectx lost again — in the regime engineered to favor it.** OFF was leaner on every axis
  (ON +31% tools, +12% tokens). All three ON agents converged, unprompted, on the same mechanism:
  **recall *points* but doesn't *pay*** — it ranked the right ~4 wiring files in one shot (a real edge
  over guessing filenames to grep; one run even surfaced a relevant *doc* by meaning), **but it changed
  neither outcome nor cost**, because the real bottlenecks were (a) the emphasis algorithm already
  **in the model's weights** and (b) **reading the local delimiter-field contract** — neither of which
  recall shortcuts, while the recall calls themselves cost tokens. `impact` went unused ("the coupling
  was static-registration, not call-graph").

## F4 — Meta-finding: litectx's single-run lift is NARROW (6 independent signals)

The in-run discovery lift does **not** appear as a net win, even where the regime was engineered to
favor it. Signals: (1) warm-up keyword corpora (+0.02 MRR); (2) the recall column on a clean repo;
(3) the mcp-gov shakedown (the agent never needed litectx); (4) the `assemble` A/B (lost ~2×);
(5) the `impact` A/B (tied tokens, +26% tools); (6) the `markdown-it` A/B (lost on every axis) — the
**deliberately favorable** regime: unfamiliar third-party repo, indirect non-greppable wiring.

The Run-2→Run-3 progression closes the obvious objection. Run 2's caveat was "litectx's own code is
greppable + familiar, so this under-tested the favorable case." Run 3 built that case and litectx
**still** lost. The crisp mechanism (all three Run-3 ON agents, unprompted): **recall *points* but
doesn't *pay*.** It does what it claims — rank the right files by meaning, faster than guessing grep
terms — but for a strong model that doesn't move the outcome, because the bottleneck is **domain
knowledge (in-weights) + reading a small local contract**, not *finding* the files; and the recall
calls cost their own tokens. So the honest scope of the in-run claim is narrower than "stays coherent
on long tasks": litectx accelerates *file-finding*, which is rarely the long pole.

This does **not** condemn litectx — it relocates its value. The two places it was relocated to: **(a)
cross-session memory** (OFF has no mechanism at all — now run, **F5**: a qualified shortlist win, top-5
70% vs 20%, but not a top-1 bullseye), and **(b) impact's safety guarantee** (the "never a silent
isolated → safe" invariant is a *correctness* property, not a speed one, so a speed-based A/B can't
measure it — un-refuted). A genuinely huge repo where context *physically* can't be held may still favor
recall, but that's blocked by **F2** (oracle) and not chased per the "don't chase" stance.

## F6 — Model-strength dependence: the Haiku re-run (the sign flips, but it's a nudge)

Every result above used a frontier model (Opus 4.8) — the case *least* in need of retrieval
scaffolding. So we re-ran the **identical markdown-it harness with Haiku on both arms**, n=3, to test
whether a weaker model — less domain knowledge in-weights, worse blind navigation, smaller context —
benefits more. Metric: **remaining failures (of 144) when the run stops** (Haiku can't fully solve, so
binary pass/fail doesn't apply; this is recoverable even from a watchdog-killed run).

| Arm (Haiku, n=3) | remaining failures | mean | median |
|---|---|---|---|
| **ON** (grep + recall) | 16 · 30 · 60 | **35.3** | 30 |
| **OFF** (grep only) | 23 · 35 · 81 | **46.3** | 35 |

Findings: **(1) Neither arm solved it** — best of all 6 runs was 16 remaining; the task is beyond Haiku
*regardless* of litectx (Opus: 0-fail in ~38k tok / 14 tools; Haiku: 100–160 tools / ~110k tok and
still failing). **(2) ON beat OFF on every order statistic** (min 16<23, median 30<35, max 60<81,
mean −24%) — the **sign flipped** from the Opus runs (neutral-to-worse) to consistently positive. So
retrieval scaffolding *does* help the weaker model more. **(3) But it's a nudge, not a rescue**:
distributions overlap heavily (ON's worst 60 > OFF's best 23), variance is huge, n=3 is directional
only; an early scout's dramatic 21-vs-81 was variance.

**The unifying mechanism for F4+F6: recall helps *finding*, not *executing*.** Opus — finding trivial →
no help. Haiku — finding helped a bit → small consistent edge — but its real bottleneck was *executing*
the delimiter algorithm, which recall can't touch → no rescue. litectx's value is bounded by how much
of a task is *locate* vs *do*; for coding, *do* dominates. **Corollary (untested):** a task whose
bottleneck genuinely *is* finding (needle in a large unfamiliar repo, simple edit) on a weak model is
where a category-difference — ON solves, OFF can't — would most plausibly appear.

## F7 — Error-keyed memory: a design pattern test (knowing ≠ executing)

Direct test of the "litectx helps with *known failures*" thesis, using existing primitives (no new
one): seed litectx **memory** with the conceptual emphasis/strikethrough *pitfalls* (rule-of-3,
multi-marker nesting, flanking, underscore intra-word, odd strikethrough, delimiter-record fields —
*knowledge, not the solution code*) and have Haiku **recall them by the failing case** (`recall
"<error>" --kind fact`). Pre-checked that a seeded lesson is retrievable by a *paraphrased* error and
ranks above decoys. Third arm, n=3, vs the F6 baselines:

| Arm (Haiku, n=3) | remaining failures | mean | spread |
|---|---|---|---|
| OFF (grep) | 23 · 35 · 81 | 46.3 | 23–81 |
| ON-code (recall over repo) | 16 · 30 · 60 | 35.3 | 16–60 |
| **ON-mem (recall + seeded failure-memory)** | **30 · 35 · 30** | **31.7** | **30–35** |

Each ON-mem agent **genuinely queried the memory** (verified in transcripts: 3–6 recall calls, 4
`--kind fact` queries each) and named the lessons as "instrumental." Findings: **(1) No rescue —
knowing ≠ executing.** Every run plateaued at ~30, failing the *exact* edge cases the recalled lessons
described; surfacing the known-failure lesson did not convert into fixing it, because the weak model's
bottleneck is execution skill, not knowledge access. **(2) The one real benefit is variance collapse**
— ON-mem clusters tightly at 30–35 where ON-code (16–60) and OFF (23–81) swing wildly: the memory
**floors the downside** (no 60/81 disasters) but also **caps the upside** (no 16). So error-keyed
memory is a **stabilizer, not a capability boost**. **(3) Scope of the "known-failures" value:** it
pays off when the fix is something the model can *execute once reminded* (a mechanical "call X before
Y"), not when the fix is itself a hard algorithm (the emphasis edge cases are the latter). The test
could have shown a rescue; it didn't — it was able to fail, and did.

## F5 — Cross-session memory: RUN (2026-06-14) — a *qualified* win (shortlist yes, top-1 no)

The one regime the in-run A/Bs could not test (OFF has no cross-session mechanism) is now **run**, not
just designed. Harness: `poc/cross-session-memory-poc.mjs` — **14 real prior decisions harvested
verbatim-faithfully from litectx's own memory log** (uncrafted), queried by **10 fresh-session
paraphrases** with an **asserted zero-keyword-overlap audit** (the memory-bench discipline; the audit
caught 2 leaks on the first pass and the run aborted until they were true paraphrases). The corpus
**deliberately packs near-neighbour decoys** — three "a ranking signal was falsified → ships surfaced,
not scored" siblings (`no-confidence-label`, `edit-activation-zero`, `trust-not-scored`) plus generic
infra decisions — so a vague paraphrase can land on the wrong sibling. ON = litectx semantic recall;
OFF = BM25-only (the "structurally cannot" arm). Built to be able to FAIL — and it half-did.

| Arm | P@1 | P@3 | P@5 | MRR |
|---|---|---|---|---|
| **OFF** (BM25 lexical) | 0% | 10% | 20% | 0.070 |
| **ON** (semantic) | **0%** | **40%** | **70%** | **0.268** |

**Verdict — two findings, opposite signs:**

- **The strong claim ("recall THE right decision at #1 among decoys") is FALSIFIED here.** ON P@1 = 0%
  — the semantic arm *never* ranks the exact target first. The near-neighbour siblings win the top slot
  on genuine proximity (not an embedding artifact): `trust-not-scored` absorbs the confidence /
  recall-value / edit-activation queries — all genuinely *"should signal X affect result ordering,"* its
  own theme — and the `storage` decision (which literally names "vector tier… float arrays") legitimately
  pulls the embeddings query. **Top-1 retrieval degrades exactly when prior decisions cluster
  semantically — and real decision logs cluster** (you make many related calls).

- **The realistic claim ("surface the right decision into the shortlist the agent reads") HOLDS, and is
  a large win.** At top-5 — what an agent actually consumes from a ranked recall — ON hits 70% vs OFF's
  20% (Δ +50 pts); top-3 40% vs 10% (Δ +30 pts); MRR +0.198. **OFF is at chance** (top-3 10%, MRR at the
  ~1/N floor; 7/10 pure misses; its few hits are stopword noise, audit confirmed clean), so this is the
  one regime where **OFF genuinely cannot and ON can** — the cross-session mechanism is real. The lift
  comes from the **slice-11 cosine-nomination path** (BM25 returns ~nothing on zero-overlap paraphrases;
  the KNN nomination is what brings the targets into the pool) — so this also corroborates `memory-bench`
  (para 0.000 → 0.574) on **real, uncrafted decisions under adversarial decoys**, not a curated dataset.

**Net:** F5 is **not** the by-construction blowout the pitch implied. It is a **shortlist win, not a
bullseye** — litectx surfaces the right past decision into the top-5 where lexical retrieval is blind,
but does not reliably rank it #1 among semantically similar decisions. This is the *same* through-line as
F4/F6: **litectx surfaces and narrows; it does not hand back a single perfect answer.** Honest scope:
the cross-session value is "the agent gets the right decision in front of it among ~5," which is real and
OFF-impossible — provided the host reads the shortlist, not just hit #1. *(Caveat: n=10 queries,
directional; one embedding model — the default MiniLM. A stronger model could lift P@1, but the
decoy-clustering ceiling is structural, not just model-limited.)*

---

# Part A — Validation: the real-work bench (litectx owns this; it ships)

## A0. The bench architecture it must match (not reinvent)

litectx already has a precise, working bench rig. The validation bench is **more of the same**, on
a corpus *harvested from real agent work*:

| Existing piece | What it does | The validation bench reuses it |
|---|---|---|
| `poc/*-bench.mjs` (vs `*-poc.mjs`) | durable gates vs throwaway spikes | new durable bench `poc/realwork-bench.mjs` |
| `poc/datasets/*.mjs` | corpus + queries + `floors` + `expected` | new `poc/datasets/realwork.mjs` (the trace) |
| corpus → **shipped** `src/index.js` → MRR/P@1/P@3 → assert | the scoring shape | identical |
| `floors` (hold-or-beat) + `expected` (pinned) + **label-audit** | regression discipline | floor = **ON − OFF delta > δ** |
| BM25-core vs embeddings-tier (two columns, one delta) | the ON/OFF pattern already exists | ON=graph recall, OFF=grep — same shape |
| **local pre-push gate, not CI** (`ci.yml`: corpora are local checkouts) | where benches run | same — local `npm run bench:realwork` |

## A1. The falsifiable A/B, expressed as a bench floor

**VB-1 — The bench's whole job is the ON−OFF delta.** "litectx-ON" = graph recall + impact +
persistent memory + compression. "litectx-OFF" = the **strong** non-graph baseline: grep-style
retrieval, no graph recall, no impact, no cross-run memory, no compression (a *fair* alternative,
not a file-dump strawman). The bench reports both as columns and **floors the delta**: if a future
change erodes litectx's edge on real work, the bench goes red. This is a regression gate on
litectx's *reason to exist*, not a demo.

## A2. What it measures — per primitive, on harvested decisions

**VB-2 — Score the individual CE decisions an agent actually faced, not "the agent."** Each replayed
item is a question with a known real answer harvested from a real run:

| Primitive | The replayed question | Known answer (from the harvest) |
|---|---|---|
| **recall** | given the working set at step *N*, did recall surface the file/symbol the agent then edited? | the file it actually edited |
| **impact** | for the diff at step *N*, did impact flag the caller that actually broke? | the caller CI/tests caught |
| **compress** | did compression keep the bytes that were used downstream? | the spans later cited/edited |
| **memory** | on run *k+1*, did recall re-surface the decision logged in run *k*? | the prior-run decision node |

Each is a floored MRR/precision metric — the same machinery `memory-bench` uses for exact/morph/para.

**VB-2a — ON = the *shipped* `recall()`/`impact()` path, never a research ablation arm.** Warm-up POC
lesson (2026-06-13): `run.mjs`'s `litectx` arm bundles the **falsified `+bla` activation term** (it
ships at zero), which swings the delta **±0.1 by repo** — aurora-EASY +0.155 but gitdone −0.067,
aurora-HARD −0.099. Using that column as "ON" would import a dead, repo-dependent term and read as a
spurious win-or-loss. **OFF disables only the graph/memory/compression features; everything else is
identical.** (A `[[verify-shipped-against-poc-data]]` harness confound, caught before it was baked in.)

## A2b. CE read/write verbs shipped since this PRD — what to bench, what to keep OUT (BUILT 2026-06-14)

> **Status: built.** `bench:assemble` (`poc/assemble-bench.mjs`) + `bench:summary`
> (`poc/summarywindow-bench.mjs`) ship as durable VALUE gates (see A7). The write-gate emitter stays out
> (covered by unit + seam-contract tests). The structural-proxy idea below is what `bench:assemble`
> implements; `summaryWindow` got its own gate (not just a replay row) on the same stub-summarizer basis.

Three CE verbs shipped after A2 was written (`assemble` FIT+COMPRESS, **`summaryWindow`** R-C6, the
**write-gate emitter**). Slotting them into the bench correctly — without smuggling in things that don't
belong in an MRR gate:

- **`summaryWindow` — ADD a replay row (deterministic, stub summarizer).** Question: *given the turns the
  budget dropped, did the rolling summary retain the decision/bytes used downstream?* Known answer = the
  span later cited/edited (same harvest the `compress` row uses). **Gate determinism:** drive it with a
  **stub** `ctx.summarize` (e.g. identity/extractive concat), not a live model — the live-model value is
  already proven in `poc/rc6-summarywindow-poc.mjs` (3/3 vs 0/3); the *gate* must be offline and free
  (VB-3). Floor = summaryWindow ≥ plain FIT-drop on the dropped-turn answers (the POC's discriminator,
  expressed as a floor). This is the natural 5th row of the A2 table.
- **`assemble` FIT+COMPRESS — already covered by the `compress` row + structural proxy.** The shipped
  `assemble-fit-poc`/`assemble-compress-seam-poc` use a live model for *validation*; the per-commit gate
  should use the **structural proxy** ("the needed unit survived the fit") which is deterministic — reserve
  the live-model run for periodic harvest, not the gate (VB-3 split).
- **write-gate emitter — KEEP OUT of the MRR bench (scope note, so it isn't smuggled in).** It is a
  *gate*, not a ranking/quality signal — there is no MRR to floor. It is fully covered by deterministic
  unit tests (`test/writegate.test.js`) + bareguard's `seam-contract.test.js` (the real-emitter swap, green
  both sides). Benching it as "quality" would be a category error.

Net suggestion: the validation bench grows by **one row (`summaryWindow`)**, run with a stub summarizer;
everything else is either already in scope (recall/impact/compress/memory) or explicitly out (write-gate).

## A3. The crux — harvest ≠ replay (this is why it can gate every change)

**VB-3 — The bench replays a committed trace; it never runs a live agent.** A live agent is
non-deterministic, costs tokens, and its outcome depends on the *model*, not just litectx — so it
**cannot** be a per-commit gate. The split:

- **Replay (the gate, runs every change):** deterministic, offline, free, scores the harvested
  decisions through shipped `src/index.js`. This is the bench.
- **Harvest (occasional, by hand):** a real agent run (Part B, or a thin one-off harness) that
  *produces* the trace fixture and the trajectory report. **Not a gate.**

**The scoring runs every change; the harvesting does not.** The agent is a fixture-harvester.

## A4. The harvested fixture

**VB-4 — `poc/datasets/realwork.mjs` is a committed trace of real CE decisions + their ground-truth
outcomes, harvested from three real local repos: `aurora`, `gitdone`, and `litectx` itself.** Ground
truth comes from real **git history** — a past multi-commit task's changed files (recall/impact
targets), and for the cross-run-memory column, **litectx's own real decision/stash log** (run *k* →
run *k+1*; litectx is the only one of the three with a rich logged decision history, which is why it
carries that column). Shape (illustrative): `{ repo, step, kind:
"recall"|"impact"|"compress"|"memory", workingSet, query, target, outcome }`. Captured once,
hand-checked, committed — exactly the `[[verify-shipped-against-poc-data]]` doctrine (replay real data
through shipped code; a mismatch is a finding).

**VB-4a — Weight the trace toward natural-language queries, not exact-keyword ones.** Warm-up POC
lesson: keyword corpora *understate* litectx's edge (graph spread is only +0.02 MRR on the
keyword-labeled aurora/gitdone queries, vs the +0.2 the `recall-litmus` POCs found on NL queries).
The harvest should phrase each step's `query` the way an agent actually would — in prose. Like the
repo corpora, the three checkouts are local → **local gate** (absent repo → skip, never fail).

## A5. Floors, label-audit, runnability

**VB-5 — Mirror `memory-bench` discipline exactly:**
- `floors` = ON−OFF delta must hold-or-beat; `expected` pins any known-zero baseline (red-before-fix).
- **Label-audit** the trace: every harvested item's claimed `kind`/`target` must be consistent with
  the indexed text, so a drifted fixture fails loudly instead of scoring noise.
- Script `bench:realwork` in `package.json`; **local pre-push gate, not CI** (corpus is a local
  checkout). Results appended to `poc/RESULTS.md` in the existing format.
- Optional `--embeddings` pass, gated-when-it-runs, like the others.

## A6. The trajectory report (evidence, not a gate)

**VB-6 — The harvest also emits a one-off SF-13-style report:** task success (CI/tests), # steps,
tokens, # wrong-file/wrong-symbol edits, the coherence-break step, cross-run reuse. This is
**evidence printed once per harvest run**, not a green/red signal — it's model-dependent and can't
gate. It justifies the automation ramp (Part B) and headlines a release note; it does not block merge.

> **Run twice already (2026-06-13) — see [F3](#f3--two-live-ab-trajectory-runs-safe-copy-worktree-harness).**
> The live ON/OFF trajectory harness exists and works on the safe-copy worktree model; `assemble`
> (short) and `impact` (long, n=3) have both been run. Result so far: **no measurable in-run lift**
> (F4). The **cross-session memory** half (F5) has now also been run (`poc/cross-session-memory-poc.mjs`,
> 2026-06-14) — a **shortlist win, not a bullseye**: top-5 70% vs 20% (OFF at chance), but P@1 0%.

## A7. The existing bench suite (what `realwork-bench` joins)

`realwork-bench` is a new member of a suite that already exists and already encodes the discipline it
reuses (local pre-push gate; absent-corpus → skip-never-fail; SAFETY-asymmetry floors; label-audit;
ON/OFF columns). The durable suite today:

| Bench | `npm run` | Gates | Corpus | Floor / verdict |
|---|---|---|---|---|
| `bench-lib.mjs` | `bench` | recall E2E — where the ground-truth file lands via `recall()` (PRD §11.1) | aurora + gitdone (local checkouts) | **ALL-MRR floor** per dataset (hold-or-beat) |
| `impact-bench.mjs` | `bench:impact` | impact E2E — **zero silent-isolated** SAFETY invariant + isolation accuracy; caller-recall reported, not gated (over-count is safe) | impact-aurora / impact-mcprune / impact-ts (local) | **SAFETY = 0** + isolation match set the exit code |
| `memory-bench.mjs` | `bench:memory` | written-memory recall quality by category | memory-facts (pure-memory — **runs anywhere**) | exact **floored**; morph/para **pinned** (red-before-fix); `--embeddings` adds emb-floors when it runs |
| `access-bench.mjs` | _(manual)_ | does edit-activation **lift or pollute** recall rank | aurora + gitdone (local) | SAFETY: no swept weight may drop below the recall baseline — **ships at zero** (surfaced, not scored) |
| `assemble-bench.mjs` | `bench:assemble` | `assemble()` VALUE — the **COMPRESS tier rescues** a needed code unit FIT would drop, + the structural invariants (pinned/atomic/no-loss/no-overflow/order) | _none — synthetic fixtures (pure, CI-capable)_ | **floor** needed-symbol retention ≥ 1.0 via `compressed:true`; **expected** FIT-only baseline = 0 (red-before-regression) |
| `summarywindow-bench.mjs` | `bench:summary` | `summaryWindow()` VALUE — the **rolling summary retains** dropped-turn decisions (stub summarizer) + fold/restorable/never-overflow/fallback contract | _none — synthetic fixtures + stub summarizer (pure, CI-capable)_ | **floor** retention ≥ FIT and = 3/3; **expected** FIT-drop = 0/3 |

> **Built 2026-06-14 (A2b).** `assemble-bench` + `summarywindow-bench` are the two new durable VALUE gates
> agreed in A2b — they guard each verb's *reason to exist* (beats the naive FIT-drop baseline) where the
> unit tests guard invariants. Both are **pure/deterministic/offline/free** (synthetic fixtures; a STUB
> extractive summarizer, never a live model — the live-model value is already proven in
> `poc/rc6-summarywindow-poc.mjs`), so unlike the corpus benches they are **CI-capable** but kept as local
> `npm run` gates for suite parity. The redundant `realwork-bench` (VB-1..VB-7) is **not** built — F1.

Plus two research/one-time harnesses kept for the record:

| Harness | `npm run` | Role |
|---|---|---|
| `run.mjs` | `bench:ablation` | the original PRD §11 **4-ranker ablation** (baseline · +bla · +spread · litectx) — the "does graph-aware recall beat BM25?" gate; results in `poc/RESULTS.md` |
| `binding-bench.mjs` | _(settled)_ | one-time slice-2 decision — native vs WASM tree-sitter (parse speed + chunk correctness); kept as the evidence behind `web-tree-sitter` |

**VB-7 — `realwork-bench` is added to this table as a durable gate** with script `bench:realwork`,
corpus `poc/datasets/realwork.mjs` (local), floor = ON−OFF delta (VB-1). The shared bench-floor
library (`bench-lib.mjs`, invoked by `npm run bench`) is the natural home for its scoring helpers.

---

# Part B — The Factory spike (optional · personal · stands on fabro)

> **PARKED 2026-06-14.** With Part A done (the bench suite fully covers validation), Part B has **no
> dependency pulling on it** — it is *not* validation and nothing in litectx/baresuite needs it. It stays
> here as a recorded want (build-itch + try Pi), explicitly **off the roadmap and unscheduled**. Un-park
> only as a deliberate, separately-budgeted personal spike; the hard rules below (FS-1/FS-2 — stands on
> fabro, never dictates a primitive) still bind if it ever wakes up. Everything below is the parked design.

## B0. Honest framing

**FS-1 — What it is and is NOT.** It is a fabro-like agent console: pick a workflow graph, watch
agents move through a swim-lane (planned/doing/pending/done), HITL monitor + approve at gates. It is
**not** litectx validation (that's Part A) and **not** a litectx/baresuite "example" (an example is
*small and disposable*; a Pi-runtime + board + gates is neither — calling it an example is a relabel
that doesn't change the maintenance bill). It is **personal R&D**: build-the-thing-you-want + try Pi.
Budget it as joy, not ROI. **Hard rule:** the spike may *reveal* primitive gaps; it may **never**
dictate litectx's or baresuite's API.

## B1. Don't rebuild the shell — stand on fabro

**FS-2 — fabro already is the factory shell.** [fabro](https://github.com/fabro-sh/fabro) (MIT, Rust
single-binary, ~1.2k★) ships: deterministic workflow **graphs** (Graphviz DOT), **HITL gates**
(hexagon nodes), a **runs board** (Working/Pending/Verify/Merge — i.e. the swim-lane), per-stage **git
checkpointing**, and cloud **sandboxes**. Rebuilding that is a four-way AGENT_RULES violation
(open-source-only, lightweight, don't-reinvent, no-speculative-code). So:

- The **shell** (graphs + board + gates + checkpoint + sandbox) = **borrow from fabro.**
- litectx's wedge = the thing fabro **lacks**: graph-aware code context (recall/impact) + persistent
  cross-run memory, **served over MCP** — which already works today (`mcp__litectx__recall/impact/
  remember/...` are live). A fabro agent-node calling litectx over MCP is the **cheapest possible
  first probe** — half a day, no new shell.

## B2. The open fork: Pi-as-runtime vs bareagent

**FS-3 — Pi competes with bareagent; resolve it before any of this is "product."** Two facts:
(1) pi.dev ships **no** swim-lane/board component — it's an *agent runtime* + TUI primitives, so the
board is hand-built either way; (2) the prior PRD said "bareagent is the only loop, two loops would
fight." So wanting Pi *as the runtime* directly contradicts baresuite's role. Split the wish:
- *"I want to learn Pi"* → legitimate **throwaway spike**, today, no pretense it's product.
- *"Pi belongs in the product"* → owes a real **bareagent-vs-Pi** decision; one of them loses.

Either way, **Pi never lands in litectx or the bench (Part A).** If it earns a place at all, it does
so in the Part-B spike's own personal repo and may **graduate to its own project outside** one day —
it projects out, never in.

Also: a TUI isn't phone-friendly, and AGENT_RULES require UI to be mobile-consumable. If a watch/gate
surface is wanted on a phone, a **~100-line local web board** reading the run's SQLite/JSONL event log
(two buttons → localhost endpoint) is simpler and more aligned than a Pi TUI. Precedent exists:
`examples/graph-view/` is already a zero-dep, offline, repo-only HTML viewer over litectx data.

## B3. The component map (who owns what)

**FS-4 — The spike is glue; it owns almost no mechanism.**

| Layer | Repo | Role | Dependency |
|---|---|---|---|
| **litectx** | `litectx` | what the agent **knows** — recall, impact, memory (over MCP) | standalone |
| **baresuite** | `bareagent`+`bareguard` | what the agent **does, safely** — loop, gates, trust | one-shot |
| **shell** | `fabro` (borrowed) | graphs + swim-lane + HITL + checkpoint + sandbox | external |
| **Pi** | `pi.dev` | *optional, under FS-3* — TUI runtime/UX experiment | UI/runtime |
| **spike** | *(new, personal repo)* | the flow defs + entry cmd + repo/PR/issue adapters that bind | → all above |

**Dependency direction (fixed):** spike → {litectx, baresuite, fabro, Pi}. None depend on the spike.

## B4. Gaps the spike may reveal (input to Part A — never a mandate)

**FS-5 — Suspected baresuite/litectx gaps, to confirm against the repos, not to pre-build:** a
declarative non-bypassable phase-graph; repo/PR/CI + issue-intake adapters; one-command entry;
explicit litectx-as-memory-backend wiring (`Store` adapter — integration, not new primitive);
destructive-action classification for the Ship gate. **Each is a hypothesis the harvest tests**, and
anything it surfaces becomes a Part-A bench item or a baresuite ticket — it does **not** reshape a
litectx primitive to fit one consumer.

## B5. HITL ramp (if/when the spike runs live)

**FS-6 — Start supervised, widen by logged evidence, never by vibes.** Stage 0: HITL every gate.
Stage 1: HITL only at destructive gates (merge/push/deploy). Stage 2: widen the auto-approve
allowlist driven by the audit log — which is exactly the VB-6 trajectory data. Sandboxing is fabro's,
not litectx's concern.

---

## Non-goals

- **Not a litectx feature.** Neither Part A's corpus nor Part B touches litectx's `files` whitelist
  or deps. (The bench is `poc/`, already outside `files`.)
- **Not a new orchestration model.** Borrow fabro's; build none of its internals.
- **Not the assistant/non-code-memory scenario yet** (reserved `fact`/`episode` over non-code context,
  no objective pass/fail — revisit when those kinds land).
- **Not a production CI bot.** Part A is a validation gate; Part B is a personal spike. Productization
  is downstream of a passed Part-A delta.

## Decisions & open questions

**Settled:**
- **D1 — Validation is a bench, not an app.** It collapses into litectx's `poc/` rig (VB-1..VB-6).
  The standalone "validation harness app" is dropped.
- **D2 — The factory is an optional, honestly-labeled spike** that stands on fabro and never dictates
  the primitives (FS-1/FS-2). litectx serves it over MCP.
- **D3 — OFF baseline = strong** (grep retrieval, no graph/impact/memory/compression), not a file-dump.
- **D4 — Corpus = three real local repos: `aurora`, `gitdone`, `litectx`** (VB-4). Ground truth from
  real git history; the cross-run-memory column rides on litectx's own decision/stash log. Warm-up
  POC (2026-06-13) on aurora/gitdone confirmed the harness + a small positive single-step delta
  (+0.02–0.03 MRR) and the two confounds now pinned in VB-2a / VB-4a (ON = shipped path; weight NL).

**Open:**
1. **Which task per repo** — one past multi-commit issue/PR per repo produces the first
   `realwork.mjs` trace; the repos are settled (D4), the specific commits are not yet chosen.
2. **δ** — how big must the ON−OFF delta be to call it a win (per primitive)? *(Moot for the in-run
   trajectory: ON did not win on any axis — F3/F4. Still live for the replay columns and the
   cross-session memory test — F5.)*
3. **Pi-vs-bareagent** (FS-3) — only if Part B graduates past a spike.
4. **Web board vs Pi TUI** (FS-3) — only if a watch/gate surface is actually wanted.
