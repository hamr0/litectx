# Software Factory — HL Requirements (litectx's first adopter / validation harness)

> **What this is.** High-level requirements for the **Software Factory**: an autonomous
> software-developer agent that runs against a real repo with minimum supervision, one command,
> human-in-the-loop only at gates. Its **primary purpose is to validate litectx** — to be the
> first real adopter that proves what litectx context buys (and what it doesn't) on actual work.
>
> **Status.** DRAFT — design-ahead, for discussion. Not built. HL (high-level) only: scenarios,
> flow, component split, the validation method, and the gaps it surfaces in baresuite. Detailed
> design follows once we agree the shape.
>
> **Where it lives.** The Factory is **its own project/repo** (a consumer app), drafted here
> because its #1 job is to exercise litectx. It is **not** part of litectx and **not** part of
> baresuite — it is the *app* that wires litectx + baresuite + Pi together. It graduates to its
> own repo when we build it.

---

## 0. The component map (who owns what)

The Factory is glue. It owns almost no mechanism — it composes three things:

| Layer | Repo | Role in the Factory |
|---|---|---|
| **litectx** | `litectx` | what the agent **knows** — recall (relevant code), impact (blast radius), persistent memory across runs. The context organ. |
| **baresuite** | `bareagent` + `bareguard` | what the agent **does, safely** — the loop, the phase FSM, the HITL gates, tool dispatch, budgets, content-trust. The runtime. |
| **Pi UI** | `pi.dev` SDK | how a human **watches & gates** — terminal UI to observe agents move through phases and action the checkpoints. The console. |
| **Factory** | *(new repo)* | the **flow definition + entry command + repo/PR/issue adapters** that bind the three. |

**Dependency direction (fixed):** Factory → {litectx, baresuite, Pi}. None of the three depend
on the Factory. litectx stays standalone; baresuite stays one-shot; Pi stays a UI SDK.

---

## 1. Purpose & the validation thesis

**SF-1 — The Factory exists to validate litectx, not to be impressive.** Its center of gravity
is a **falsifiable A/B**: the same task run **with litectx context ON vs OFF**, measured. "OFF"
= the naive baseline (dump files into context / stock baresuite with no graph recall, no impact,
no persistent memory). Without the A/B it's a demo, not evidence — this is the `poc/` bench-gate
doctrine lifted to system scale.

**SF-2 — "Validated" means a measured win on coherence-over-steps + correctness.** litectx is
validated if, vs the OFF baseline, the agent: edits fewer wrong files/symbols, stays coherent
past the step-15–20 rot point (`ctx-ifra.md`), uses fewer tokens for equal-or-better outcomes,
and **carries context across runs** (remembers prior PRs/decisions). What *doesn't* work is
equally a result — the Factory is allowed to falsify litectx.

---

## 2. Scenarios

**SF-3 — Primary scenario: autonomous repo maintainer (build this first).**
> One command points the Factory at one of my repos. It looks at open PRs and issues, validates
> them, and fixes issues — working on a branch, with HITL only at the gates.

This is the **sharpest litectx test** because it leans on exactly what's **built today**:
- **Validate a PR** → litectx **impact** (blast radius of the diff) + **recall** (what the
  changed code relates to). Objective ground truth: tests/CI pass or they don't.
- **Fix an issue** → **recall** (find the relevant code) + **impact** (don't break callers) +
  **Write** (log the decision so the next run remembers).
- **Across PRs/issues** → persistent **memory** — the long-running axis litectx owns.

**SF-4 — Secondary scenario (later): personal assistant.** "Does stuff" with persistent memory.
**Deferred** — it exercises the general memory primitives over **non-code** context (`fact` /
`episode` kinds, which are **reserved, not built**) and has **no objective pass/fail**, so it
can't yet *measure* a litectx win. Revisit once non-code kinds land. (Recorded so the Factory's
flow format stays general enough to host it.)

---

## 3. The flow — phases, not steps

**SF-5 — The agent follows a fixed, non-bypassable *phase* graph; it moves freely *within* a
phase.** Phases are CE-level checkpoints, **not** code steps (a step is application logic, not
context engineering). The FSM enforces phase **order** and blocks each **gate**; it does **not**
script the agent's micro-actions inside a phase (that would be a script, not an agent, and
brittle on open-ended work).

**SF-6 — The four gates (the example flow, shippable as a template):**

| # | Phase | Gate (HITL) — agent cannot cross without approval | litectx used |
|---|---|---|---|
| 1 | **Scope** | human confirms which PR/issue + acceptance criteria | recall (triage context) |
| 2 | **Plan** | human approves the plan **before any edit** | recall + **impact** (blast radius) |
| 3 | **Diff** | human reviews the branch diff + test results before merge | impact (regression surface) |
| 4 | **Ship** | human approves the irreversible action (merge / push / deploy) | — |

**SF-7 — Flows are declarative and forkable.** The scope→plan→diff→ship graph is *one* shipped
template; users author their own (bugfix flow, review-only flow, research flow) in the same
declarative format. The Factory ships a small library of example flows.

---

## 4. Where baresuite needs new / enhanced primitives

The Factory surfaces gaps in baresuite (bareagent/bareguard). HL list — to be confirmed against
the repos and the CE-PRD §10 hand-off contracts:

**SF-8 — bareagent gaps:**
- **Declarative flow/phase format + enforcement.** `state.js` is a per-task FSM; the Factory
  needs a **reusable, declarative phase-graph** (nodes, transitions, gates) that is
  **non-bypassable** and forkable (SF-5/SF-7). *New or enhance `state.js`.*
- **Repo / PR / CI adapters.** Read PRs, diffs, CI status; git branch/commit ops. *New tools.*
- **Issue intake.** Read + triage issues from the tracker. *New tool.*
- **One-command entry.** A CLI entry that points at a repo and kicks the flow. *Enhance
  bareagent CLI.*
- **Persistent-memory wiring.** `loop.js:212` never auto-reads memory — the Factory must
  explicitly wire **litectx as the memory backend** via the `Store` adapter (`{store, search,
  get, delete}`) so context survives across runs. *Integration, not new primitive.*

**SF-9 — bareguard gaps:**
- **Destructive-action classification + gate** for the Ship gate (merge/push/deploy as
  irreversible). The gate contract exists; the **classifier + the ramp policy** (§6) need
  confirming/building.

**SF-10 — checkpoint ↔ Pi.** `checkpoint.js` is the human-approval gate; the Factory routes its
prompts to the **Pi UI** (§7) instead of a bare stdin prompt.

---

## 5. litectx seams exercised (built vs design-ahead)

**SF-11 — The Factory wires these litectx surfaces; built ones validate now, design-ahead ones
validate as they land:**

| Seam | litectx surface | Status | Factory use |
|---|---|---|---|
| Recall | ranked code/context search | **built (slices 1–4)** | find relevant code per phase |
| Impact | called-by/calling → risk bucket | **built (slice 5a/5b)** | PR/diff blast radius |
| Write (memory) | persist nodes/decisions | **memory engine** | cross-run decision log |
| Compress / Isolate | budget-fit + handle/rehydrate | **CE primitives — design-ahead, gated** | keep the window lean on long tasks |

The Factory therefore **validates recall+impact today** and becomes the **system-level bench for
the CE primitives** (Compress/Isolate/Write feedback) as those slices graduate.

---

## 6. HITL & the automation ramp

**SF-12 — Start supervised, widen by evidence, never by vibes.**
- **Stage 0** — sandbox, HITL at *every* gate. Observe, tune the agent/prompts.
- **Stage 1** — live, HITL only at **destructive** gates (Diff→merge, Ship). Auto-pass Scope/Plan
  once trusted.
- **Stage 2** — progressively widen the auto-approve allowlist **driven by the audit log** (§7),
  not confidence.

The widening is justified by logged outcomes — which is exactly the data the validation A/B (SF-1)
already produces. (Sandboxing itself is ⊘ CEDE for litectx — it lives in the Factory/runtime.)

---

## 7. Instrumentation, metrics & the Pi console

**SF-13 — Every run is instrumented (this is the evidence, not a nicety):** task success
(tests/CI pass?), # steps, tokens used, # wrong-file / wrong-symbol actions, the coherence-break
step, cross-session recall (did it reuse prior context?), and a full **audit log** of gate
decisions.

**SF-14 — A/B harness is first-class:** run any task **litectx-ON vs litectx-OFF** and diff the
SF-13 metrics. This is the validating mechanism, not an afterthought.

**SF-15 — Pi UI is the watch + gate surface.** Use the `pi.dev` terminal-UI SDK to (a) **watch**
agents move through the phase graph live, and (b) **action the HITL gates** (the checkpoint
prompts from SF-10). **Pi is used as a UI SDK only — not as a second agent runtime** (bareagent
remains the only loop; two loops would fight).

---

## 8. Non-goals

- **Not a litectx feature.** The Factory is a separate consumer app; litectx gains nothing in its
  `files` whitelist or deps.
- **Not a new orchestration model.** Everything runs through the bareagent orchestrator (A2A
  settled out — boundary-only, build none of its internals).
- **Not the assistant scenario yet** (SF-4).
- **Not a production CI bot** on day one — it's a *validation* harness first; productization is
  downstream of a passed A/B.

---

## 9. Decisions & open questions

**Settled:**
- **SF-D1 — Task sequence.** **PR-review-only** is the **plumbing smoke-test** (does the factory
  wire up, does a gate fire, does Pi render) — *not* the validation; it mostly re-proves the impact
  view `poc/` already validated. **Issue-fix, scoped to one small issue, is the real validation
  run** — it's the only path that exercises litectx's central claim (recall + impact + persistent
  memory + compression over a long task) with objective ground truth (tests/CI). Order: smoke-test
  → validation.
- **SF-D2 — OFF baseline = *strong*.** litectx-OFF means **stock baresuite with grep-style
  retrieval but no graph recall / no impact / no persistent memory / no compression** — a *fair*
  non-graph alternative, not a "naive file dump" strawman. If litectx still wins, the result is
  credible. (Weak file-dump OFF is permitted only for the SF-D1 smoke-test.) The ON−OFF delta is
  the proof (SF-1/SF-2).

**Open:**
1. **Repo target** — which repo is the first subject?
2. **Flow format** — reuse/extend bareagent's FSM, or a thin declarative layer above it? (SF-8.)
3. **Where the Factory repo lives** and how it pins litectx/baresuite/Pi versions.
4. **Pi integration depth** — watch-only first, or gate-action from day one?
