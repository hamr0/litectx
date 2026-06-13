# Context-Engineering Docs — index

The source-grounded doc set that defines litectx's scope as the **comprehensive
context-engineering (CE) library** for long-running agents. **Specs are derived from the
leaders in CE, not guessed** — every claim traces to a primary source (Anthropic, LangChain,
Manus, Google ADK, Slack, OpenAI, Drew Breunig, Chroma, HumanLayer, the arXiv papers).

> **Consolidated 2026-06-13.** The former standalone CE docs were folded into two homes: the
> **mental-model tree** → [`litectx-ce-prd.md` **Appendix CE-T**](../01-product/litectx-ce-prd.md);
> the **source transcript, recommended flows, and build studies** →
> [`02-engineering/build-studies.md` **Parts A–E**](../02-engineering/build-studies.md). This page is
> the map into them.

## The CE doc set (read in this order)

| # | Where it now lives | What it is |
|---|---|---|
| 0 | [`build-studies.md` Part E](../02-engineering/build-studies.md) | **Source transcript** — Marina Wyss, *Context Engineering in 29 Minutes*. Kept intact; the raw material everything is grounded against. |
| 1 | [`litectx-ce-prd.md` Appendix CE-T](../01-product/litectx-ce-prd.md) | **The mental model + build map.** What CE *is*, organized with the four primitives (Write / Select / Compress / Isolate) as the trunk; every leaf marked for litectx. The whole story at a glance. |
| 2 | [`build-studies.md` Part D](../02-engineering/build-studies.md) | **The recommended flows.** How the leaders flow work (Claude Code · Manus · ADK · Slack · OpenAI) + the turn pipeline + frequent-intentional-compaction, each behavior mapped to the four primitives. |
| 3 | [`litectx-ce-prd.md`](../01-product/litectx-ce-prd.md) | **The CE PRD** — requirements derived from the build-map marks (Appendix CE-T), with the bareagent/bareguard hand-off contracts. |

## The pipeline

```
Part E ──grounded against leaders──> Appendix CE-T ──┬──> Part D
(transcript)                          (mental model) │    (recommended flows)
                                                      └──> litectx-ce-prd.md ──> litectx-memory-prd.md
                                                           (the 🔧+🧩 marks become specs)
```

## The marks (shared convention across the docs)

| Mark | Meaning |
|---|---|
| 🧩 **CORE** | already in litectx's scope/plan (the code+context memory engine) |
| 🔧 **BUILD** | a CE primitive/tool litectx must add — **a PRD requirement** |
| ⊘ **CEDE** | deliberately out of scope — harness / bareagent / bareguard — **a non-goal** |
| *(plain)* | a concept/finding — explains *why*, nothing to build |

The **🔧 + 🧩** leaves are the requirement list; the **⊘** leaves are the non-goals and the
bareagent/bareguard hand-offs.

## Related (not part of this set)

**Engineering companions (the requirements' evidence base) — now folded into
[`../02-engineering/build-studies.md`](../02-engineering/build-studies.md):**
- **Part A — Aurora Borrow Ledger** — validated signal formulas/constants to borrow from aurora
  (BM25, ACT-R, edges, impact), **plus the SOAR/CE-primitive borrows (§13)**: rank-tiered render,
  retrieval-quality, usefulness-feedback, with carry-vs-correct verdicts at file:line.
- **Part B — Copy-Pattern API Studies** — API studies of the net-new patterns litectx *adapts*
  (LlamaIndex summary buffer, ADK handle pattern, Manus restorable compression) + the adaptation
  delta per requirement.
- **Part C — CE Eval-Harness Scenario** — the CE walking-skeleton test that pins the `assemble()`
  contract (the hold-or-beat gate).

**PRDs & contracts:**
- [`../01-product/litectx-memory-prd.md`](../01-product/litectx-memory-prd.md) — the memory-engine PRD
  (recall + impact + graph + ACT-R + indexing).
- [`../02-engineering/baresuite-litectx-prd.md`](../02-engineering/baresuite-litectx-prd.md) — the
  litectx↔baresuite integration contract (what bareagent/bareguard build vs. what stays litectx's).
- [`../archive/barecontext-prd.md`](../archive/barecontext-prd.md) — the earlier SEED for this axis;
  **superseded** by the two live PRDs together (memory-prd + ce-prd); banner at its top.
