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
> **Status.** DRAFT — Part A is buildable now and is the priority; Part B is deferred and optional.
> Supersedes the prior SF-1..SF-15 / SF-D1..SF-D2 numbering (this doc is design-only, nothing in
> code references those IDs).

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
2. **δ** — how big must the ON−OFF delta be to call it a win (per primitive)?
3. **Pi-vs-bareagent** (FS-3) — only if Part B graduates past a spike.
4. **Web board vs Pi TUI** (FS-3) — only if a watch/gate surface is actually wanted.
