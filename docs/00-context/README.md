# Context-Engineering Docs — index

The source-grounded doc set that defines litectx's scope as the **comprehensive
context-engineering (CE) library** for long-running agents. **Specs are derived from the
leaders in CE, not guessed** — every claim traces to a primary source (Anthropic, LangChain,
Manus, Google ADK, Slack, OpenAI, Drew Breunig, Chroma, HumanLayer, the arXiv papers).

## The docs (read in this order)

| # | Doc | What it is |
|---|---|---|
| 0 | [`ctx-ifra.md`](ctx-ifra.md) | **Source transcript** — Marina Wyss, *Context Engineering in 29 Minutes*. Kept intact; the raw material everything is grounded against. |
| 1 | [`ce-tree.md`](ce-tree.md) | **The mental model + build map.** What CE *is*, organized with the four primitives (Write / Select / Compress / Isolate) as the trunk; every leaf marked for litectx. The whole story at a glance. |
| 2 | [`ce-flow.md`](ce-flow.md) | **The recommended flows.** How the leaders flow work (Claude Code · Manus · ADK · Slack · OpenAI) + the turn pipeline + frequent-intentional-compaction, each behavior mapped to the four primitives. |
| 3 | [`../01-product/litectx-ce-prd.md`](../01-product/litectx-ce-prd.md) | **The CE PRD** — requirements derived from the build-map marks, with the bareagent/bareguard hand-off contracts. |

## The pipeline

```
ctx-ifra.md ──grounded against leaders──> ce-tree.md ──┬──> ce-flow.md
 (transcript)                              (mental model)│    (recommended flows)
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

**Engineering companions (the requirements' evidence base):**
- [`../02-engineering/aurora-borrow-ledger.md`](../02-engineering/aurora-borrow-ledger.md) —
  validated signal formulas/constants to borrow from aurora (BM25, ACT-R, edges, impact), **plus
  the SOAR/CE-primitive borrows (§13)**: rank-tiered render, retrieval-quality, usefulness-feedback,
  with carry-vs-correct verdicts at file:line.
- [`../02-engineering/copy-pattern-studies.md`](../02-engineering/copy-pattern-studies.md) — API
  studies of the net-new patterns litectx *adapts* (LlamaIndex summary buffer, ADK handle pattern,
  Manus restorable compression) + the adaptation delta per requirement.
- [`../02-engineering/ce-eval-harness-scenario.md`](../02-engineering/ce-eval-harness-scenario.md) —
  the CE walking-skeleton test that pins the `assemble()` contract (the hold-or-beat gate).

**PRDs:**
- [`../01-product/litectx-memory-prd.md`](../01-product/litectx-memory-prd.md) — the memory-engine PRD
  (recall + impact + graph + ACT-R + indexing).
- [`../01-product/barecontext-prd.md`](../01-product/barecontext-prd.md) — the earlier SEED for
  this axis; **superseded** by the two live PRDs together (memory-prd + ce-prd); banner at its top.
