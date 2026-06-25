# barecontext — Product Requirements Document (PRD, ⚠ SUPERSEDED)

> **⚠ SUPERSEDED (2026-06-05) — do not build from this doc.** This SEED's axis (the *context
> economy*) is now **litectx's**, documented in the single
> [`litectx-prd.md`](../01-product/litectx-prd.md) (memory + CE PRDs merged 2026-06-23):
> - **memory engine** → **Part 1** — recall, impact, the code+context graph, ACT-R, kinds, indexing,
>   storage.
> - **CE primitives (Write / Select / Compress / Isolate)** → **Part 2**, which carries this doc's
>   **§4 primitives** (now first-class requirements), turns its **§6 "bare test" into the "lite
>   line,"** and points its **§7 Aurora-port notes** at
>   [`../02-engineering/build-studies.md`](../02-engineering/build-studies.md) (Part A).
>
> Two framings below are now **wrong** and kept only for history: (1) barecontext is **not** a
> future bare-suite *sibling* — it is litectx, a **standalone** library that baresuite
> *consumes* (not the reverse); (2) it is no longer SEED / NOT-NOW — litectx is in active build.
> Read the two PRDs above instead.
>
> ---
>
> _Original SEED banner (historical):_
>
> Companion to [`bareguard-prd.md`](bareguard-prd.md) (the stable governance spec) and
> [`harness-prd.md`](harness-prd.md) (the floor+harness design). **This is a seed
> doc, not a build order.** It exists to hold one idea clearly so it does not bloat
> bareguard: there is a *second axis* — the **context economy** — that context
> engineering converges on, and it belongs to a **future bare-suite sibling,
> `barecontext`**, not to bareguard. **There is no need for it yet.** Recorded so that
> when something converges we can sort it *upfront* (bareguard vs barecontext) instead
> of cramming context concerns into the governance floor.
>
> **Governing rules:** follows `.claude/memory/AGENT_RULES.md` — minimal, local-first,
> no speculative build. Nothing here is committed; no `src/` exists or is implied.
> Subject to the same hold-the-line bar as `bareguard-prd.md` Appendix E.
>
> Status legend: **SEED** (idea recorded, nothing designed), **DEFERRED** (gated on a
> real need), **PROPOSED** (stated, not settled).

---

## 0. TL;DR

bareguard governs the **boundary** — *what an action is allowed to do* (action vs
content, `bareguard-prd.md` §6). There is a different, orthogonal axis:

- **barecontext governs the *economy*** — *what the agent holds in context*: short- and
  long-term memory, freshness, and keeping a turn's context clean so pollution and
  hallucination don't carry forward and impair a long-running agent's decision.

**Status: SEED / NOT-NOW.** The user has no concrete need or design for this yet. This
doc defines the axis, the vocabulary (context engineering, context graph, their
primitives), and the **sorting rule** that keeps the two products from blurring. It
does **not** propose primitives to build.

---

## 1. Why this exists

A long-running agent accumulates context monotonically — every tool result, turn, and
observation piles into a finite window. But useful attention and token budget are
bounded, and three things go wrong as the pile grows:

- **Attention decay** — within the window, signal degrades with length ("context rot" /
  lost-in-the-middle). More tokens ≠ more understanding.
- **Cost & latency** — every turn re-pays for the whole context.
- **Pollution persists** — a stale fact, a contradiction, or a hallucination that enters
  context *carries forward* across turns and corrupts later decisions.

bareguard does nothing about any of this, **by thesis** — it decides whether an action
may run; it never touches what the agent holds in its head. That gap is barecontext's
axis. The whole job reduces to: **keep signal high and volume bounded, turn after
turn.**

---

## 2. What context engineering is

The discipline of deciding what occupies a model's context window at each turn — and
what stays out — so the model has exactly what it needs and nothing that degrades it.
The successor to *prompt engineering*: prompt engineering optimizes the **wording of one
instruction**; context engineering manages the **entire assembled context** (system
prompt + tools + history + retrieved docs + memory + state) as a **dynamic, budgeted
resource** across a long-running agent.

---

## 3. What a context graph is

Representing context not as a flat linear transcript but as a **structured graph**, so
each turn assembles a *minimal relevant subgraph* into the window instead of carrying
the whole history.

- **Nodes** = discrete context units: a fact, a tool result, a message, a memory, an
  entity, a sub-task.
- **Edges** = relationships: `derived-from`/provenance, `depends-on`, `supersedes`
  (v2 replaces v1), `references`, `belongs-to-task`.

Why a graph beats a flat window: a flat window forces keep-or-drop on *whole turns by
recency*; a graph supports retrieval by **relevance and relationship**, **provenance**
tracking (where did this come from — which source, trusted?), clean **supersession** of
stale facts, and assembling only the connected subgraph a step needs. It is the
structure underneath modern memory systems and GraphRAG-style retrieval. **The one edge
that touches bareguard is `provenance` — trust-labeling** (see §5).

---

## 4. Primitives

### 4.1 Context-engineering primitives (the techniques)

| Family | Primitive | What it does |
|---|---|---|
| **Reshape / Fit** (control window size) | Trimming | drop old turns wholesale (recency) |
| | Compaction | drop heavy payloads (big tool results), leave a placeholder so the chain of thought survives |
| | Summarization | background LLM condenses prior turns into a dense reusable block |
| **Isolate / Route** (keep main context clean) | Sub-agent handoff | push a heavy sub-task to a sub-agent; return only the *conclusion* to the orchestrator |
| **Extract / Retrieve** (memory) | Note-taking / extraction | pull critical facts to a file/JSON during the run |
| | State object | persistent structured state (milestones, profile, goals) read/written across turns |
| | RAG / semantic memory | embedding search to bring back only relevant past memories on intent — short-term (in-session) vs long-term (cross-session) |
| **Hygiene / Guardrails** | Token thresholds | hard cap tool/API returns; truncate before they hit context |
| | Memory guardrails | filter extracted memories for injections / conflicts / secrets |
| | Prompt & tool boundaries | lean system prompts, minimal overlapping tool defs, explicit structured guidelines |

### 4.2 Context-graph primitives (the data-structure building blocks)

1. **Node** — a typed unit of context (fact / result / message / memory / entity).
2. **Edge / relation** — typed link (provenance, depends-on, supersedes, references).
3. **Provenance** — every node knows its source (tool / doc / sub-agent / session).
4. **Salience / relevance scoring** — how related a node is to the current intent (drives
   what gets assembled in).
5. **Freshness / supersession** — recency + "this replaces that," so stale facts retire.
6. **Retrieval / assembly** — given the step, select the minimal subgraph for the window
   (the read path).
7. **Eviction / decay** — what leaves the graph or gets archived (the forget path).

**Mental model:** context engineering is the *policy* (what should be in context now);
the context graph is the *data structure* that makes a smart policy possible
(relationship- and provenance-aware, not just recency).

---

## 5. The bareguard ↔ barecontext boundary

The reason this doc exists: pre-sort convergence so context concerns never bloat the
governance floor. The rule:

> **Boundary / trust → bareguard.  Economy / freshness → barecontext.**

Where each convergence item lands, and — for the few with a bareguard edge — whether
that edge is *borrowable* (reuse of an existing primitive / an invariant already true)
or would be **bloat** (forces bareguard to touch context or judge content, both of which
`bareguard-prd.md` §6 forbids):

| Convergence item | Lands on | bareguard edge? |
|---|---|---|
| Trimming / compaction / summarization; RAG, state object; sub-agent context isolation | **barecontext** | none |
| Token thresholds (cap tool-output tokens) | **barecontext** | *number only* — may share `limits` config vocabulary; the act of truncating context is barecontext's. Pulling enforcement in = **bloat + §6 break** (bareguard would touch context) |
| Context graph (provenance) | **barecontext** structure | the *minimal* request+return reconcile-audit is already harness OQ4 (no new surface); a provenance **graph store** = **bloat** (fails Appendix C #3 infra, #4 LOC) |
| Memory guardrails | **split** | mechanism (extract/retrieve/freshness) = barecontext. **Borrowable via reuse:** if a memory-*write* is a normal gated action it is governed by existing `allowlist`/`askPatterns` for free; **floor supremacy** (a memory may never relax the user-authored floor) is already true by construction. **Bloat:** a secret/PII/injection *scanner* inside bareguard = content judgment = §6 break → barecontext filter (or advisory Axis-B) |

**The unifying test:** *borrowable = reuse an existing bareguard primitive, or restate an
invariant already guaranteed; **bloat** = anything that makes bareguard touch context or
judge content.* By that test **nothing here is a new bareguard primitive** — the
genuinely-bareguard pieces (memory-write gating, reconcile-audit, floor supremacy) are
all reuse or already-free; everything else is barecontext's.

---

## 6. The "bare" test for any future barecontext primitive (PROPOSED)

bareguard's Appendix C cannot be reused verbatim — its tests #1/#2 ("constrain an action
against the world, not content / by shape not semantics") are the *opposite* of
barecontext's job (barecontext **is** about content and context). So barecontext needs
its own discipline to stay *bare*. First-draft bar:

1. **Local-first** — works on one machine with a file (and at most a small embedded
   store: sqlite / a local vector index). No managed service, no server to run.
2. **Minimal & legible** — a primitive a person can read in one file; batteries-included
   frameworks are the *alternative*, not the goal.
3. **Deterministic where it can be** — assembly/eviction/supersession by explicit rules;
   only retrieval ranking may be probabilistic, and it is advisory, never load-bearing
   for correctness of the floor (cf. harness D8: probabilistic layers advise, the
   deterministic part binds).
4. **The user/operator owns retention policy, not the agent** — what is remembered,
   summarized away, or evicted is author-controlled (the M1 lesson: the agent must not
   silently author its own memory hygiene, especially the part that could drop a
   governing constraint — `harness-prd.md` §11).
5. **Opt-in, safe default** — absence of config = plain transcript, nothing clever.

> Five yeses keeps it *bare*. This is a seed, not a settled bar — revisit when a real
> need exists.

---

## 7. Reference implementation — Aurora's code-aware memory engine (the likely port source)

We do **not** have to design barecontext from scratch. `~/PycharmProjects/aurora` (a
Python monorepo) already contains a **working, separable code-aware memory engine** that
is a de-facto prototype of this entire axis — built before the vocabulary existed, and
grounded by direct read of the repo (2026-06-03). The §4 primitives map onto its
components almost 1:1; the engine is the keeper, its probabilistic orchestration is not.

### 7.1 The §4 primitives, already built

| barecontext primitive (§4.2) | Aurora component | file (grounding) |
|---|---|---|
| **Node** (typed context unit) | tree-sitter AST → `CodeChunk` (name / signature / **docstring** / line range) | `context-code/.../languages/python.py` |
| **Edge / provenance** | a real persisted `relationships` table — types `depends_on \| calls \| imports`, weighted, indexed both ends | `core/.../store/schema.py:53`; `store/memory.py:171` (`add_relationship`/`get_related`) |
| **Salience / relevance** | ACT-R `ActivationEngine` = base-level (freq/recency) + spreading + context-boost − decay | `core/.../activation/engine.py` |
| **Freshness / supersession** | base-level power-law decay + access-history compaction into time buckets | `core/.../activation/base_level.py` |
| **Retrieval / assembly** | `HybridRetriever` = BM25 + ACT-R + embeddings, staged (BM25 filter → tri-hybrid re-rank), chunk-type-aware weights | `context-code/.../semantic/hybrid_retriever.py` |
| **Eviction / persistence** | SQLite + FTS5, incremental/git-aware indexing, thread-safe pooling | `core/.../store/sqlite.py` |
| (md "memory" retrieval) | section-aware markdown chunker + BM25 over `.md` | `context-doc/.../chunker.py` |

The **edge graph is live, not dead.** It is fed at index time by a real **LSP** layer
(`packages/lsp`, `multilspy`) with a batched **ripgrep** path and a `grep -w` fallback
(`lsp/analysis.py:80-191`); the Python LSP path is solid, JS/TS/Go/Rust/Java are
"ripgrep works, LSP untested" (`lsp/analysis.py:475`). LSP feeds indexing via
`cli/.../commands/memory.py:281` → populates `relationships` → consumed by spreading
activation (`activation/spreading.py:295`). *(An earlier read mistook the vestigial
tree-sitter `_identify_dependencies()` for the whole story — that is a dead side-path;
the live path is LSP/ripgrep → `relationships` table.)*

### 7.2 The extraction seam (clean — already package-separated)

The memory engine is ~21k LOC in 4 packages, already walled off from the ~50k LOC of
orchestration/CLI that would be **left behind** (and which a harness / Claude Code
already does — the probabilistic layer this whole programme treats as the soft spot):

| Extract (the memory engine) | LOC | Leave (the probabilistic harness) | LOC |
|---|---|---|---|
| `core` (activation + store) | 8.8k | `soar` (orchestrator) | 6.9k |
| `context-code` (parser + semantic) | 7.3k | `reasoning` (LLM decompose — the mediocre part) | 2.8k |
| `context-doc` (md chunker) | 1.0k | `spawner` (agents) | 5.0k |
| `lsp` (multilspy + ripgrep) | 3.8k | `cli` | 35k |
| **≈ 21k LOC** | | ≈ 50k LOC | |

### 7.3 Portability to JS (the user's intent: rebuild the code-aware part in JS, drop the Python cruft)

Sound — and JS is the *better* host for the two hardest pieces, not a compromise:

| Component | JS target | Effort |
|---|---|---|
| ACT-R activation; BM25 + code-aware tokenizer | pure TS | **trivial** (math + strings) |
| SQLite + FTS5 + schema | `better-sqlite3` (FTS5 built in) | **low** |
| tree-sitter AST → chunks/docstrings | `web-tree-sitter` / `node-tree-sitter` (grammars are shared artifacts) | **low** — JS is tree-sitter's best-supported ecosystem |
| LSP client | `vscode-jsonrpc` / `vscode-languageserver-protocol` driving the **same** standalone servers (pyright, tsserver, gopls, jdtls, rust-analyzer) | **medium** — the one real rebuild; VS Code *is* a JS LSP client, so tooling is more mature than Python's |
| ripgrep/grep fallback | `child_process` + `rg` | **trivial** |
| embeddings | `@xenova/transformers` (ONNX) or external | **optional tier** (see §7.4) |

### 7.4 The lightweight path (how it stays "bare")

Embeddings are **optional**, grounded in the code: `hybrid_retriever.py:14` documents a
BM25+ACT-R **dual-hybrid fallback at "85% quality vs 95% tri-hybrid"** when embeddings
are unavailable. So the **bare core** — tree-sitter + BM25 + ACT-R + LSP/ripgrep edges +
SQLite/FTS5 — runs at ~85% with **zero ML dependency**; embeddings buy the last ~10% as
an **opt-in capability tier**. That is exactly the §6 "local-first / optional advanced
layer" shape.

### 7.5 Scoping decision this forces (the honest tension with §6)

A ~21k-LOC engine with tree-sitter + an LSP client is **not** bareguard-tiny — it cannot
be "bare" in the ≤150-LOC sense, and it strains §6's "minimal & legible" test even as it
passes local-first / deterministic-core / user-owns-retention / opt-in. Hold both by
defining barecontext as a **small primitive *surface* — `index / retrieve / relate /
evict` — over the extracted engine**, with **tree-sitter / LSP / embeddings as opt-in
capability tiers**, not one monolith. The JS rewrite is the natural moment to draw that
surface and shed the Python cruft. "Bare" here means *local-first, no service,
deterministic core, optional tiers* — re-read §6 with that calibration.

> Still SEED / NOT-NOW (§9). This section records *that a port source exists and what its
> shape implies* — it is not a decision to build. Engine lives at `~/PycharmProjects/aurora`
> (packages `core`, `context-code`, `context-doc`, `lsp`).

---

## 8. Relationship inside the bare suite

```
        bareagent   ← agent loop runner
          │   │
          │   └─ may use → barecontext  ← context economy / memory (this doc, FUTURE)
          ↓
        bareguard   ← policy + audit (the governance floor)
```

Like bareguard, barecontext would be a **leaf-ish** local primitive a runner *uses*, not
a service. It is **orthogonal to bareguard** — they share only the single provenance /
memory-write trust edge (§5), and barecontext never relaxes the floor.

---

## 9. Status: SEED — recorded, not started

The axis is real and the vocabulary is captured so future convergence sorts cleanly, and
§7 establishes a concrete **port source** (Aurora's engine) and what its shape implies.
But there is still **no need, no design, and no `src/`** — and per the hold-the-line bar
(`bareguard-prd.md` Appendix E, and the same discipline that kept Axis B deferred in
`harness-prd.md`) there will be none until a real, concrete need exists. Until then this
doc *names* the territory and the likely starting material; it does not build them. When
that need arrives, start from §6's "bare" test, the §5 boundary, and §7's extraction
seam, and survey the existing tools (Mem0, Zep/Graphiti, Letta/MemGPT, LangGraph state,
vector stores) for what a *minimal* primitive should and should not absorb.
