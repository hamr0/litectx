---
type: reference
title: The Context-Engineering Tree
status: stable
sources: [docs/archive/litectx-prd.md]
---

The full CE (context-engineering) taxonomy that litectx's requirements were derived from — LangChain's four primitives (Write / Select / Compress / Isolate) as the trunk, every leaf marked for what it means to litectx. Grounded in primary sources (Anthropic, LangChain, Chroma, Manus, Google ADK, Slack, Breunig, arXiv), not the teaching video that first framed it — where the video diverged, the sources win (litectx-prd.md:2609-2630).

## Legend (also the build map)

| Mark | Meaning | Drives |
|---|---|---|
| 🧩 CORE | already in litectx's scope | PRD: confirm |
| 🔧 BUILD | a primitive litectx must add | PRD requirement |
| ⊘ CEDE | out of scope — belongs to the harness (bareagent/bareguard) | PRD non-goal |
| *(plain)* | concept/finding, nothing to build | context only |

A leaf can split (`🔧 store / ⊘ the LLM step`): litectx owns the deterministic substrate, the probabilistic/orchestration half is ceded (litectx-prd.md:2634-2646).

## Why CE exists

Anthropic: context engineering optimizes "the smallest possible set of high-signal tokens" against LLM constraints — the successor to prompt engineering, curating the whole evolving context state rather than one instruction's wording (litectx-prd.md:2664-2678). Two named degradation problems drive the primitives: **context rot** (Chroma — 18 models degrade continuously, well below the window limit, "a gradient not a cliff") and **lost-in-the-middle** (Liu et al. — U-shaped attention, ~75%→~55% accuracy as the answer moves to the middle) (litectx-prd.md:2680-2691). No single leader agrees on how to decompose "what competes for the window" (Anthropic/LangChain/Chase/video all group differently); litectx's slice is memory/retrieved-knowledge/state, not instructions or tool-feedback (litectx-prd.md:2693-2709).

## FOUNDATION — the context graph (R-G*)

The four primitives are views over one typed graph (litectx-prd.md:2723-2724).

- 🧩 **R-G1 Node** — typed unit (`kind`: code/doc/fact/episode)
- 🧩 **R-G2 Edge** — `calls`/`imports`/`depends_on` + add `supersedes`/`derived_from`/`references`/`belongs_to`
- 🔧/⊘ **R-G3 Provenance** — source + trust label is litectx; content-verdict is bareguard
- 🧩 **R-G4 Salience** — relevance-to-intent score (ACT-R activation generalized)
- 🔧→⊘ **R-G5 Freshness/supersession** — later dropped as duplicative of `forget`+`remember`+`pruneStaleEpisodes`
- 🔧 **R-G6 Assembly (read path)** — the `assemble()` headline call
- 🔧 **R-G7 Eviction/decay (forget path)** — author-controlled, never agent-authored
(litectx-prd.md:2726-2733)

## WRITE — persist context outside the window

LangChain: "saving context outside the context window to help an agent perform a task" (litectx-prd.md:2734-2736).

- 🧩 **R-W1 Durable store** — litectx's single-file SQLite substrate already is this
- 🔧 **R-W2 Memory kinds** (`fact`, `episode`) as first-class nodes
- 🔧 **R-W3 Sessions/state object** — schema'd runtime state across turns
- 🔧 **R-W4 Scratchpad/note store API** — survives compaction
- 🔧/⊘ **R-W5 Cross-session memory extraction** — litectx owns store+retrieve+supersede; the LLM extraction step is CEDE
- 🧩 **R-W6 Rules/procedural memory** (`CLAUDE.md`) — served as `kind=doc`
- 🔧 **R-W7 Usefulness feedback** — boost activation of nodes that helped a successful answer
- 🔧 **R-X4 Authority ordering** cross-cuts here too (see Cross-Cutting)
- ⊘ **CEDE** — the agent's decision *to* write / when to recite
(litectx-prd.md:2737-2747)

## SELECT — pull the right context in

LangChain: "pulling it into the context window ... give what this step needs" (litectx-prd.md:2749-2751).

- 🧩 **R-S1 Ranked retrieval (recall)** — BM25 + ACT-R + 1-hop graph spreading
- 🧩 **R-S2 Score fusion** — chunk-kind-aware hybrid re-rank
- 🧩 **R-S3 Embeddings as opt-in tier**
- 🔧 **R-S4 Agentic (iterative) retrieval API** — agent drives refinement, not one-shot
- 🔧 **R-S5 Memory-type-aware selection** — select by `kind` (LangChain/CoALA taxonomy)
- 🔧 **R-S6 Tool selection (RAG over tool defs)** — RAG-MCP: 13.62%→43.13% accuracy, >50% fewer tokens
- 🧩 **R-S7 Frontload + just-in-time hybrid** — `CLAUDE.md` up front, rest on demand
- 🔧→⊘ **R-S8 Retrieval-quality signal** — a trust label off the activation distribution; later POC-falsified (no usable per-query threshold)
(litectx-prd.md:2752-2761)

## COMPRESS — keep only the tokens that matter

LangChain: "retaining only the tokens required to perform a task" — the direct counter to context rot (litectx-prd.md:2763-2765).

- 🧩 **R-C1 Chunking + reranking**
- 🔧 **R-C2 Token-budgeted assembly** — deterministic, no LLM; the flagship Compress primitive
- 🔧 **R-C7 Rank-tiered render** — top-N verbatim, tail signature+docstring, drop past a cap
- 🔧 **R-C3 Tool-result clearing/context editing** — Anthropic: +29% alone, 84% token cut on a 100-turn eval
- 🔧 **R-C4 Restorable compression** — drop a payload, keep a cheap handle to rehydrate (Manus)
- 🔧 **R-C5 Trimming/pruning (heuristic)**
- 🔧/⊘ **R-C6 Running summary** — litectx ships the deterministic scaffold; the LLM summarization call is CEDE/opt-in
- ⊘ **CEDE** — LLM auto-compaction (the summarizer is harness; litectx supplies what it summarizes)
- ⊘ **CEDE (opt-in)** — Perplexity/LLM token compression (LLMLingua)
(litectx-prd.md:2766-2776)

## ISOLATE — split context across windows

LangChain: "splitting it up" — the deep issue is contamination, not space (litectx-prd.md:2778-2779).

- 🔧 **R-I1 Namespacing/scoping** — per-agent/session/user scope column, filtered queries
- 🔧 **R-I2 State partitioning** — expose one field of state, isolate the rest
- 🔧 **R-I3 Handle/lazy-load** — return a lightweight name+summary (`peek`), fetch raw on request (`load`)
- ⊘ **CEDE** — sub-agent orchestration (parent delegating, clean windows, 1–2k-token returns)
- ⊘ **CEDE** — sandboxes/environments
(litectx-prd.md:2781-2786)

## CROSS-CUTTING — assembly ordering & trust

These decide how assembled content is ordered, trusted, and built; all deterministic and litectx's except the content-trust verdict (litectx-prd.md:2790-2791).

- 🔧 **R-X1 Cache-stable ordering** — stable-first/dynamic-last, append-only (Manus + ADK consensus)
- 🔧/⊘ **R-X2 Provenance + credibility + supersession** — litectx stores the label/shape-verdict; content trust is bareguard
- 🔧 **R-X3 Explicit, testable assembly pipeline** — named ordered processors, not string concat
- 🔧 **R-X4 Authority/precedence ordering** — rule > fresh fact > episode > history (the Context-Clash fix)
(litectx-prd.md:2793-2798)

## Failure modes (Breunig) → fixing primitive

Diagnostic only — nothing to build — but each names which primitive earns its keep. Breunig's six fixes don't map cleanly 1:1 onto four buckets; that tidy mapping is a video simplification (litectx-prd.md:2802-2806).

| Failure mode | What it is | Fixing primitive(s) |
|---|---|---|
| Context Poisoning | a hallucination/error re-referenced, compounds | Compress + Select |
| Context Distraction | over-long context → over-reliance on history | Compress (+ Isolate) |
| Context Confusion | superfluous content, e.g. tool confusion | Select |
| Context Clash | new info conflicts with existing | Write + Select + R-X4 |

Six fixes → trunk: RAG→Select, Tool Loadout→Select, Quarantine→Isolate, Pruning→Compress, Summarization→Compress, Offloading→Write (litectx-prd.md:2808-2816).

## Prompts & tools

System prompts ("right altitude" — too prescriptive is brittle, too vague has no signal) are ⊘ for litectx — the user's/harness's job, though it shapes how memory is presented (litectx-prd.md:2822-2827). Tool definitions split similarly: ⊘ tool masking (Manus KV-cache trick, an inference-runtime technique) vs 🔧 RAG-based tool selection (litectx can serve this as retrieval over a corpus); the cross-vendor principle is stable content first, dynamic appended last (litectx-prd.md:2829-2839).

## Methodology — frequent intentional compaction

HumanLayer's flow: split work into phases, each emitting a compacted markdown artifact; reset the window to just that artifact on phase change; stay in the 40–60% utilization zone. Research→Plan→Execute maps to Write (`research.md`/`progress.md`), Isolate (sub-agent research), Compress (context reset). litectx's role is to store/serve the artifacts and rank what survives a reset; phase orchestration is CEDE (litectx-prd.md:2843-2850).

## Corrections ledger (video vs. primary sources)

Nine corrections were made where the source video diverged from primary sources — notably: episodic/semantic/procedural memory is LangChain's (CoALA) framing, not Pinecone's; Breunig lists six fixes, not a clean 4→4→4; RAG-MCP's real numbers are 13.62%→43.13% (id 2505.03275); Anthropic never cites "95%" for auto-compaction (a Claude Code UX detail); n² is a compute cost, not the proven cause of accuracy rot; HumanLayer's "35k LOC" was a diff into a 300k-LOC codebase, not a fresh build (litectx-prd.md:2854-2866).

## Sources

Primary sources cited throughout: Anthropic (effective context engineering, managing context, the think tool), LangChain (context engineering for agents), Pinecone, Drew Breunig (how long contexts fail / how to fix your context), Chroma (context rot), Manus, Google ADK, Slack, OpenAI, Arize, HumanLayer, plus arXiv papers *Lost in the Middle*, *RAG-MCP*, *Agentic Context Engineering*, and *Context Engineering for AI Agents in OSS* (litectx-prd.md:2870-2891).

A full Mermaid mindmap of the entire tree — every branch, every 🧩/🔧/⊘ mark — is preserved in the source PRD appendix (litectx-prd.md:2895-2968).
