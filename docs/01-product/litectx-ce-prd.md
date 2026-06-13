# litectx — Context-Engineering PRD (DERIVED from the build-map)

> **What this is.** The requirement list for litectx as the **comprehensive context-engineering
> library** — *derived* from the build-map marks in [`ce-tree.md`](../00-context/ce-tree.md)
> and [`ce-flow.md`](../00-context/ce-flow.md), which are themselves grounded in the CE
> leaders (Anthropic, LangChain, Manus, Google ADK, Slack, OpenAI, Drew Breunig, Chroma,
> HumanLayer, arXiv). **Specs derived from leaders, not guessed** (goal #5).
>
> **Scope decision this encodes:** litectx absorbs all four CE primitives and serves
> **long-running, specialized agents**; baresuite (bareagent/bareguard) serves lightweight
> one-shot automation. **Two separate PRDs — no fold:** [`litectx-memory-prd.md`](litectx-memory-prd.md)
> owns **the memory engine (all memory: recall, impact, graph, ACT-R, kinds, indexing)**; **this
> doc owns the CE primitives** built on top. This PRD **references** the memory engine and names
> what it provides (§1.0) — it does **not** re-spec, absorb, or rewrite it. `barecontext-prd.md`
> is **superseded by the two together** (§9).
>
> **Status:** DERIVED, lift-checked & borrow-confirmed. CE requirements derived from the
> build-map and **checked against the existing bareagent/bareguard primitives we copy/adapt**
> (§10, file:line). Aurora/SOAR borrows confirmed at file:line (ledger §13); external-library
> patterns studied (copy-pattern-studies). `barecontext-prd.md` superseded banner: done.
> Only remaining: the *optional* CLAUDE.md pointer, deferred until CE build begins (§9 #4).
>
> **Method reminder:** requirements point at their source of truth — where litectx already has a
> validated mechanism, the [aurora-borrow-ledger](../02-engineering/aurora-borrow-ledger.md)
> (borrow the calibration, don't reinvent — [[borrow-aurora-dont-restart]]); for the net-new
> patterns we adapt from CE leaders, the
> [copy-pattern-studies](../02-engineering/copy-pattern-studies.md) (real API surface + the
> litectx adaptation delta).

---

## 0. How to read a requirement

Each requirement carries: **ID** · **primitive** · **what** (1–2 lines) · **derives-from**
(the leader) · **surface** (litectx API shape) · **determinism** (🟢 deterministic core / 🟡
deterministic scaffold + ⊘ ceded LLM step / ⊘ fully ceded) · **precedent** (aurora ledger or
net-new) · **delta** (vs current `litectx-memory-prd.md`).

> **Lite line (binds every requirement).** No service/daemon · no external graph DB · no
> LLM-on-write/index · single-file SQLite · embeddings & any LLM step are **opt-in tiers** ·
> one prod-dep bar (`better-sqlite3`). A requirement that can't be met within this line is
> **⊘ ceded**, not bent. (Grounded in the competitive survey: every graph-memory competitor
> pays an LLM-per-write and/or mandates a graph DB — that heaviness is the thing we refuse.)
>
> **Standalone, copy-don't-depend (binds every lift).** litectx is a **standalone** library —
> baresuite *consumes* litectx, never the reverse (the dependency direction is fixed). So any
> primitive lifted from bareagent/bareguard is **copied/adapted into litectx's own
> implementation**, never a runtime dependency on baresuite. **If a lifted primitive doesn't
> fully fit, or needs enhancement to fit litectx's needs, we adapt it** so litectx stands alone;
> when litectx runs *inside* baresuite it composes with the originals (§10). The §6 thesis still
> binds: litectx never makes bareguard judge content (§7).

---

## 1. Foundation — the context graph as data structure (first-class)

### 1.0 What the memory engine already provides (reference — see [`litectx-memory-prd.md`](litectx-memory-prd.md))

litectx's **memory engine is specified in its own PRD**; this doc builds the CE primitives **on
top of** it and **references** it — it does not re-spec it. Provided today / by the memory build
(the 🧩 **CORE** marks below): the **code+context graph** (typed nodes + `calls`/`imports`/
`depends_on` edges), **recall** (BM25 + ACT-R activation + 1-hop spreading, kind-aware hybrid),
**impact** (blast-radius / risk bucket), **incremental git-aware indexing**, the **`kind`/
`format` schema** (`code`/`doc` live; `fact`/`episode` reserved), **embeddings as the one opt-in
tier**, **single-file SQLite/FTS5** storage. *Details live in the memory PRD — not duplicated
here.* Below, 🧩 = provided by that engine (cited, not re-specced); 🔧 = the CE additions this
PRD specs.

### 1.1 The context-graph primitives

The substrate the four primitives ride on. These promote `barecontext-prd.md` §4.2 from SEED
to requirement, unified with the existing code+context graph (`litectx-memory-prd.md` §2–3).

| ID | What | Surface | Det. | Precedent | Delta |
|---|---|---|---|---|---|
| **R-G1 Node** ✅ **SHIPPED** | typed unit of context (`kind`: code · doc · **fact** · **episode**) | `getNode(id)` | 🟢 | ledger §10 (`chunk_types`) | **BUILT 2026-06-12** — kind-agnostic structure accessor (`chunks` + exact import-edge counts); written memory = zero-chunk/zero-edge node. Path-keyed (file-granular). `test/graph.test.js`; design `docs/plans/2026-06-12-graph-substrate-design.md` |
| **R-G2 Edge** ✅ **SHIPPED (import)** | typed relation: `imports` (persisted) · `calls` (impact, on-demand) + reserved **`supersedes`·`derived_from`·`references`·`belongs_to`** | `related(id,{edge,dir,hops})` | 🟢 | ledger §4 (spreading) | **BUILT 2026-06-12** — BFS over persisted `import` edges, `dir` out/in/both, hops capped at 3, deduped. `edge` is a **generic type** so the reserved non-code edges slot in with no migration once a producer emits them (NOT built — no producer yet; would be speculative). `calls` stays impact()'s job (over-counts by design — kept off the exact graph) |
| **R-G3 Provenance** | every node knows its source (tool · doc · sub-agent · session) + a trust label | `node.source`, `node.trust?` | 🟢 / ⊘ content-verdict | label = litectx; shape-gate = **bareguard** (§10.1) | new |
| **R-G4 Salience** | relevance-to-intent score driving assembly (ACT-R activation generalized beyond code) | internal; surfaced in `recall().signals` | 🟢 | ledger §2–6 (ACT-R) | generalize activation to all kinds |
| **R-G5 Freshness / supersession** | recency + "v2 replaces v1" so stale facts retire deterministically | `supersede(oldId,newId)`; freshness in salience | 🟢 | ledger §3 (decay/churn) | **net-new supersession path** |
| **R-G6 Assembly (read path)** ✅ **SHIPPED (v1=FIT)** | given a step + budget, select the minimal relevant subgraph, ordered for cache reuse | `assemble(units, ctx)` → `{ units, dropped, tokens }` | 🟢 | §5 below | **SHIPPED v0.11.0 (2026-06-13)** — the CE headline API, **FIT** half first: budget-fits a neutral unit array (grammar-stripped `{id,role,content,kind?,pinned?,atomic?,tokensApprox?}`) recency-anchored + cache-stable, `pinned`/`atomic` invariants, `dropped[]`-with-handle (no silent loss). SELECT (recall-inject) **KILLED** this round (§4.1 of `bare-suite-buildable-now.md` — agents already fetch own code, no demand, ~75% noise); COMPRESS (signature-tier, R-C7 render) is the next composable. `poc/assemble-fit-*.mjs` + `test/assemble.test.js` (12). |
| **R-G7 Eviction / decay (forget path)** | what leaves/archives the graph, author-controlled | `evict(policy)` | 🟢 | ledger §3 | net-new explicit policy |

> **Retention is author-owned, never agent-authored** (barecontext §6 #4; the M1 lesson). The
> agent may *request* writes/evictions as gated actions; the policy that could drop a governing
> fact is the operator's.

---

## 2. WRITE — persist context outside the window

| ID | What | Derives-from | Surface | Det. | Delta |
|---|---|---|---|---|---|
| **R-W1 Durable store** | single-file SQLite memory across turns/sessions | (all leaders) | the store | 🟢 | 🧩 have (PRD §9) |
| **R-W2 Memory kinds** | `fact` (semantic) + `episode` (episodic) as queryable nodes | LangChain memory types [LC] | `kind` on write/recall | 🟢 | promote PRD §3.1 reserved → built |
| **R-W3 Session / state object** | schema'd, versioned per-session state (plan, milestones, profile) read/written across turns | LangChain "state" + LangGraph checkpoint [LC]; Slack Director's Journal | `session(id)`, `state.get/set` | 🟢 | net-new |
| **R-W4 Scratchpad / note store** | durable notes that survive compaction (`NOTES.md`/`progress.md`/recitation) | Anthropic note-taking [A]; Manus `todo.md` | `note.append/read` | 🟢 | net-new |
| **R-W5 Cross-session memory write** | store + retrieve + supersede facts/preferences across sessions | LangChain memories [LC]; Mem0 (survey) | `remember(fact,{source})` | 🟡 store 🟢 / ⊘ LLM fact-extraction | net-new; **extraction is ceded** |
| **R-W6 Rules / procedural memory** | index & serve `CLAUDE.md`-style rules (`kind=doc`) | Anthropic/LangChain [A][LC] | recall(`kind:doc`) | 🟢 | 🧩 have |
| **R-W7 Usefulness feedback** | boost activation of nodes that *contributed to a successful answer* (+0.2 if conf≥0.8 / +0.05 if ≥0.5 / skip below), beyond automatic base-level use | aurora `record.py:282-283` ✅ confirmed (ledger §13) | `recordUseful(ids,weight)` | 🟢 boost / ⊘ success-verdict | **net-new** (boost is litectx; the success *verdict* — LLM confidence — is ceded) |

**Ceded (⊘):** the agent's *decision* of when to write/recite (agent-loop policy → bareagent);
the LLM that *extracts* a fact from prose (→ harness, opt-in); the *verdict* that an answer
succeeded (R-W7 input) → harness/bareagent.

---

## 3. SELECT — pull the right context in

| ID | What | Derives-from | Surface | Det. | Delta |
|---|---|---|---|---|---|
| **R-S1 Ranked recall** | BM25 + ACT-R + 1-hop spreading over the graph | aurora (validated) | `recall(q,{topK,kind})` | 🟢 | 🧩 have (ledger §1–7) |
| **R-S2 Score fusion** | kind-aware hybrid weighting across signals | aurora hybrid [LC echoes] | `recall().signals` | 🟢 | 🧩 have (ledger §7) |
| **R-S3 Embeddings tier** | semantic re-rank, **off by default** (dual-hybrid ≈85%) | aurora; survey | config `embeddings:on` | 🟡 opt-in tier | 🧩 have (PRD §8) |
| **R-S4 Agentic / iterative retrieval** | agent-driven query refinement + "enough yet?" — recall as a loop, not one-shot | Agentic RAG [video][LC] | `recall` re-entrant + cursor | 🟢 | net-new (thin) |
| **R-S5 Memory-type-aware select** | select by `kind` so episodic/semantic/procedural are retrievable distinctly | LangChain/CoALA [LC] | `recall({kind})` | 🟢 | follows R-W2 |
| **R-S6 Tool selection (RAG over tool defs)** | semantic-search the relevant tools for a step (RAG-MCP 13.6→43.1%, >50% tokens) | RAG-MCP [RAG-MCP]; LangChain [LC] | `selectTools(intent,defs)` | 🟢 | net-new **candidate** (a corpus litectx can rank) |
| **R-S7 Frontload + JIT** | serve both the up-front index and on-demand retrieval | Anthropic hybrid [A] | (composition of R-S1) | 🟢 | 🧩 have (pattern) |
| **R-S8 Retrieval-quality signal** | recall returns a trust label (NONE/WEAK/GOOD) off the **activation distribution** — *design*: ≥3 nodes at activation ≥0.3 = GOOD; tells the caller when context is too weak to act on | aurora SOAR Phase 4 — **design only, NOT built** (ledger §13); Arize "principled quality metric" gap [Arize] | `recall().quality` | 🟢 | **net-new, litectx-original** (only litectx owns the activation scores; 0.3/0.7/3 are *untested priors* — validate on the bench) |

**Ceded (⊘):** which tools the *agent* ultimately invokes (agent-loop); tool *execution*.

---

## 4. COMPRESS — keep only the tokens that matter

| ID | What | Derives-from | Surface | Det. | Delta |
|---|---|---|---|---|---|
| **R-C1 Chunk + rerank** | coherent chunks; surface only the best (before-context) | aurora; LangChain [LC] | internal to recall | 🟢 | 🧩 have (ledger §1/§7) |
| **R-C2 Token-budgeted assembly** | given a token budget, return the highest-salience subset — *the* lite-Compress primitive | survey; ADK budget | `assemble({budget})` (= R-G6) | 🟢 | **net-new, flagship** |
| **R-C3 Tool-result clearing** | drop raw payloads already acted on, keep a 1-line stub | Anthropic context-editing [A] | `clear(nodeId)` / auto-policy | 🟢 | net-new |
| **R-C4 Restorable compression** | drop a payload but keep a cheap handle (URL/path/id) to restore on demand | Manus file-system-as-context [Manus] | `stash(id,text)` + `peek(id)` + `get(id)` + `evict(...)` | 🟢 | ✅ **SHIPPED v0.6.0** — dedicated non-fts5 `stash` table (never indexed → recall-invisible, never pruned → restore always works). **API-only by §10.5** (orchestration mechanic, not a model-reasoning verb → no CLI/MCP). Deletion is **`evict`** (R-G7), the stash-only deleter — `forget` is memory-only and never reaches the stash table. (Manus pattern, done right; [study §3](../02-engineering/copy-pattern-studies.md)) |
| **R-C5 Trim / prune (heuristic)** | recency/size heuristics to drop old turns | LangChain trim [LC]; Provence | `trim(policy)` | 🟢 | net-new |
| **R-C6 Running-summary scaffold** | "last-N verbatim + rolling summary of older" — litectx decides *what/when*; LLM does the prose | LlamaIndex buffer [LC]; ADK compaction | `summaryWindow(n)` + hook | 🟡 scaffold 🟢 / ⊘ LLM step | net-new ([study §1](../02-engineering/copy-pattern-studies.md) — keep handles to summarized turns) |
| **R-C7 Rank-tiered render** | compact code **by rank**: top-N **verbatim code** · next tier **signature+docstring** · **drop** past a cap (aurora `CHUNK_LIMITS` (top-N, max) per complexity). The docstring render is the unit; R-C2 budget picks the tier | aurora `decompose.py:243-310` ✅ confirmed — *inlined in `_build_context_summary`, reimplement not extract* (ledger §13); Arize "LLM-summary failed" [Arize] | `compress(node,{level})`; `assemble()` tiers by rank | 🟢 | ✅ **SHIPPED 2026-06-12** — `compress(node,{level})` → `verbatim` \| `signature` (header + doc, body elided) \| `drop`; tree-sitter signature extraction (+ method-chunk wrapping), saves **~82% bytes with the doc kept** on 627 real symbols. Pure library export (no DB/ranking), like `stash`/`peek`. De-risks `assemble()` (the render half it composes). 16 tests. (extraction's chunker dependency in memory PRD §2; pairs with R-C2) |

**Ceded (⊘):** the LLM that writes the summary (auto-compaction prose); perplexity/LLM token
compression (LLMLingua) — opt-in tier behind the embeddings line.

---

## 5. ISOLATE — split context across windows

| ID | What | Derives-from | Surface | Det. | Delta |
|---|---|---|---|---|---|
| **R-I1 Namespacing / scope** | a scope key (agent/session/user) + filtered queries so contexts don't bleed | Memary/Letta (survey); ADK scope-by-default [ADK] | `scope` on every op | 🟢 | net-new (cheap) |
| **R-I2 State partitioning** | expose one field of state to the LLM, isolate the rest | LangChain state [LC] | `state.view(fields)` | 🟢 | follows R-W3 |
| **R-I3 Handle / lazy-load** | return a lightweight handle; fetch raw only on explicit request, then offload | ADK handle pattern [ADK]; Manus | `peek(id)` (`{id,bytes,head,tail,createdAt,truncated}`) vs `get(id)` (= load) | 🟢 | ✅ **SHIPPED** (stash-only) — `peek` previews **head+tail** via SQL first-N/last-N `substr` + octet `length`; `load`==`get` already. **Win = bounded RESULT** (only ~head+tail bytes reach the caller → payload stays out of the context/token budget), **NOT** bounded compute — grounding measured peek wall-time *scales* with payload (≈`get`, slower past a few MB; SQLite reads the column to slice it). An O(1) peek would need byte-size stored at write (deferred column). **Head+tail, not head-only**: the conclusion (exit code, failing frame, closing structure) lives at the END — borrows SmartCrusher's start+end split (study §4, R-C7 prior), but *only* the cheap structural slice, NOT the anomaly-keep (full-scan → stays in R-C7). **POC-validated** (`poc/ri3-handle-poc.mjs`, 17 assertions): byte-length via `CAST(text AS BLOB)` not `length(text)`; tail via negative `substr`. `summary`/`scope` columns stay **deferred** — head+tail covers logs/traces/text/code; opaque blobs would need a caller-supplied summary, added only when a real caller passes one. (pairs with R-C4; [study §2](../02-engineering/copy-pattern-studies.md)) |

**Ceded (⊘):** sub-agent **orchestration** (fork/lifecycle) and **sandboxes** → **bareagent**
owns spawning (`tools/spawn.js`); litectx supplies each child's scoped store (§10.2). Phase
control / human-in-the-loop gating → harness.

---

## 6. Cross-cutting — assembly ordering & trust

| ID | What | Derives-from | Surface | Det. | Delta |
|---|---|---|---|---|---|
| **R-X1 Cache-stable ordering** | emit assembled context stable-first / dynamic-last, append-only, deterministic serialization | **cross-vendor consensus**: Manus + ADK [Manus][ADK] | `assemble()` output contract | 🟢 | net-new (the strongest field rule) |
| **R-X2 Provenance + credibility** | source + salience/credibility; supersession retires stale/refuted facts; **floor supremacy on writes** | Slack Critic channels [Slack] | R-G3 + R-G5 + bareguard gate | 🟢 / ⊘ content-verdict | shape-verdict + floor = **bareguard lift** (§10.1); content-verdict = litectx/guardrails tier |
| **R-X3 Explicit, testable assembly pipeline** | context built by named, ordered steps — not string concat (observable, testable) | ADK "explicit transformations" [ADK] | internal `processors[]` | 🟢 | net-new (architecture) |
| **R-X4 Authority / precedence ordering** | order **and label** assembled blocks by a trust/authority class (procedural rule > fresh fact > episode > history) so the model resolves conflicts predictably — the **Context-Clash** fix, distinct from cache-order (R-X1) and freshness (R-X2) | Breunig "Context Clash" → *establish authority ordering: System > Retrieved Facts > History* [DB] | precedence class on `assemble()` blocks | 🟢 | **net-new** (closes the 4-failure-mode matrix) |

> **How X1 / X2 / X4 compose (not contradictory):** they're three ordering *axes*. **R-X1** fixes
> the prefix/suffix split for KV-cache (stable-first, append-only). **R-X4** ranks blocks by
> *authority* — but authoritative content (rules) is also the most stable, so it naturally lands in
> the R-X1 prefix; within the dynamic suffix, blocks are ordered by authority then salience. **R-X2**
> decides which blocks are even eligible (retire stale/refuted). *Positioning note (lost-in-the-
> middle, [DB]/[Chroma]/[LitM]):* place highest-salience content at the **edges** — head = rules
> (R-W6), tail = most-salient/recited (R-W4) — so this is **mostly emergent** from R-W6+R-W4+R-X1;
> the only net-new sliver is "order the dynamic selected block by salience, most-salient at the
> tail." Build it as a heuristic in `assemble()`, not a separate requirement.

---

## 7. Non-goals (⊘) — the CE-scope non-goals (the memory PRD keeps its own §13)

These are *this* doc's non-goals; `litectx-memory-prd.md` keeps its own §13 (memory-engine
scope) — the two are separate, not merged. litectx is the **substrate**; these belong to the
harness / bareagent / bareguard:

- **Sub-agent orchestration, agent loop, sandboxes, phase control** → bareagent / harness.
- **The LLM step** in fact-extraction, summarization, auto-compaction, perplexity compression
  → opt-in tier / harness (litectx feeds it deterministically, never requires it).
- **Tool masking / KV-cache logit control** → inference runtime.
- **Prompt authoring** ("right altitude") → user / harness.
- **Content-trust *judgment*** (is this fact safe / a secret / an injection?) → bareguard;
  litectx carries the provenance label, bareguard renders the verdict.
- **Visual/GUI substrate** (screenshots as tokens, CUA) → out of scope.
- Plus all current PRD §13 carry-overs: no LSP, no token *budgeting policy* (litectx does
  budget-*aware assembly*, not budget *enforcement*), no multi-provider LLM clients as default.

---

## 8. Requirement rollup — the build surface (one public API, opt-in tiers)

```
litectx (one importable lib, one config, safe defaults)
  index()            — 🧩 incremental, git-aware            (slices 0–1 shipped)
  recall()           — 🧩 ranked select  (R-S1..S7)
  impact()           — 🧩 blast-radius   (PRD slice 6)
  getNode/related    — 🧩 graph substrate (R-G1..G2)
  ── CE expansion (this doc) ─────────────────────────────
  remember/forget    — 🔧 Write          (R-W2..W5, R-G7)
  recordUseful       — 🔧 Write feedback (R-W7)  ← boost what helped (aurora Record)
  session/state      — 🔧 Write+Isolate  (R-W3, R-I2)
  supersede          — 🔧 freshness      (R-G5)
  recall().quality   — 🔧 Select signal  (R-S8)  ← trust label off activation dist.
  assemble()         — 🔧 Compress+order (R-G6, R-C2, R-X1, R-X4)  ← the CE headline call
  compress(node)     — 🔧 Compress       (R-C7)  ← signature/docstring render
  clear/trim/rehydrate — 🔧 Compress     (R-C3..C6)
  scope / peek/load  — 🔧 Isolate        (R-I1, R-I3)
  selectTools()      — 🔧 Select (cand.) (R-S6)
  [tiers] embeddings | summarizer-hook | extractor-hook   — opt-in, ⊘ by default
```

---

## 8.1 Build order — adopter-pulled vs factory-independent

The [software factory](software-factory-prd.md) is litectx's first adopter and validation harness
(the ON-vs-OFF A/B). The standing doctrine is *adoption-first*: don't speculatively grind an API —
let a real consumer pull its contract. **But that doctrine governs *ambiguous shapes*, not
*universal primitives*.** The factory is **one** adopter exercising one or two flows; it will not
surface every CE need. Conflating the two would make primitives whose shape is already fixed wait
on a consumer that adds nothing to their design — procrastination dressed as discipline.

The discriminator: **does the contract depend on knowing how a specific consumer drives it, or is
it self-evident from litectx's own data model and falsifiable on litectx's own bench?**

**Tier A — factory-independent (build now; shape fixed by our data + validated on existing benches).**
The first adopter may *fine-tune* these (thresholds, defaults), but it does not *define* their shape.

| Req | Surface | Why it needs no adopter | Validation harness (exists today) |
|---|---|---|---|
| **R-C7** | `compress(node,{level})` | ✅ **SHIPPED.** Signature tier = tree-sitter cut at the `body` field (+ method-chunk wrapping); saves **~82% bytes WITH the doc kept** on 627 real symbols (not the earlier naive "95–98%"). aurora-calibrated (`decompose.py:243-310`). **De-risks `assemble()` — it's the render half assemble composes.** | `poc/rc7-compress*-poc.mjs`, `test/compress.test.js` |
| **R-G7** | `evict(id \| {olderThan, maxCount})` | ✅ **SHIPPED 2026-06-12** (the stash-cleanup verb). `evict(id)` (one payload) / `{olderThan}` (epoch-ms floor, `created_at <`) / `{maxCount}` (keep newest N) — both policies compose (age then count). **API-only** (§10.5) and **stash-only by construction** — only the `stash` table is touched, so a bulk age/size sweep can never reach a durable `fact`/`episode`. This split is the point: `forget` was made **memory-only** (its old id-fallthrough into `stash` removed — a breaking change, ~zero blast radius: no live stash consumer exists), so the model-facing "drop knowledge" verb and the runtime-only "reclaim scratch" verb sit on opposite sides of the §10.5 line. Runtime owns the policy; litectx owns the delete. POC `poc/evict-poc.mjs`; tests in `test/stash.test.js` (incl. the *evict-never-touches-memory* + *forget-can't-reach-stash* invariants). | `poc/evict-poc.mjs`, `test/stash.test.js` |
| ~~**R-S8**~~ | ~~`recall().quality`~~ | **DROPPED — premise falsified (2026-06-12 grounding).** Sold as litectx-original "off the **activation distribution**, only we hold those scores." **Those scores do not exist in shipped recall:** memory-PRD §4 deferred base-level activation and §14 #4 *falsified it for recall ranking on real edit data* (`poc/access-bench.mjs`: topic-blind, repo-dependent — ships at zero). The only ACT-R term in recall is import-spreading (code-only). A quality label would fall back to **raw BM25 magnitude** — repo/query-length-dependent score-thresholding, the *exact* class of prior §4 forbids recall to ship. Building it re-litigates a settled falsification. **The one candidate residue — a confidence label off the embeddings cosine distribution — was then POC-falsified too** (`poc/confidence-poc.mjs`, 2026-06-12): top raw cosine separates answerable from unanswerable queries in aggregate (AUC 0.92) but has **no usable threshold** — the paraphrase/morph answers (the queries the label would *exist* to judge) score in the same 0.21–0.54 band as the unanswerable ones (≤0.36), so any τ that catches "nothing here" falsely flags ~25% of real answers as "weak," worst on exactly the semantic hits. Same shape as §4: real for *aggregate* judgment, useless for the *per-query* decision. Closed on evidence (memory-PRD §14 #7). | `poc/confidence-poc.mjs` |
| ~~**R-G5**~~ | ~~`supersede(old,new)`~~ | **DROPPED — duplicative (2026-06-12 grounding).** Retire = `forget(id)`; replace-in-place = `remember(sameId, …)` (upsert, `store.js:395`); auto-freshness = `pruneStaleEpisodes` on every episode write; supersede-by-promotion = the `reviewCandidates` re-`remember` flow. `supersede(old,new)` is `forget(old); remember(new)` with a ribbon. The only uncovered sliver — an audit forward-pointer (old→new lineage) — nobody asked for, and its content-verdict is ceded to bareguard (R-X2). Document the `forget`+`remember` idiom instead. | n/a |

*Half-in:* **R-W7 `recordUseful`** — the boost *mechanism* is buildable + aurora-calibrated
(+0.2/+0.05), but whether the boost helps ranking wants a real loop feeding "what was useful" →
mechanism now, weight-validation with the adopter. **Caveat (2026-06-12):** the *recall-reranking*
use of any use-derived boost was falsified topic-blind in memory-PRD §14 #4 — so `recordUseful`'s
only safe home is the **trust/tie-break** layer that already shipped (5c), not a global lift.

**Tier-A status after the 2026-06-12 grounding pass — the well is now dry (all four resolved).** Of the
four Tier-A primitives: `compress` **shipped** (v0.7.0), `evict` **shipped** (v0.8.0 — the stash-cleanup
verb, with `forget` made memory-only); `R-S8` and `R-G5` are **struck** above (falsified premise /
duplicative). This is **good news, not a setback** (§3 #2): the strike-throughs reconcile this CE
backlog — drafted before the access-log POCs settled — with the memory PRD's already-validated findings.
litectx's core is *more* complete than this table implied; with Tier A closed, "what's next" is honestly
the **adopter-pulled `assemble()`** (Tier B), not a Tier-A scrape.

**Tier B — adopter-pulled (shape is genuinely unknown until a caller exists).**

| Req | Surface | The ambiguity only a consumer resolves |
|---|---|---|
| **R-G6 / R-C2** | `assemble({intent,budget})` | What *is* `intent` (query? step descriptor?); budget unit (tokens? nodes?); how the caller wants blocks ordered. **The headline call — the doctrine was written for exactly this.** → **SHAPE RESOLVED by the bareagent RT-seam negotiation, §8.2** (2026-06-12): `assemble(units, ctx)` over a neutral unit model; `intent`=`ctx.task`, budget=tokens, ordering=cache-stable with `pinned`/`atomic` flags. |
| **R-X1 / R-X4** | `assemble()` ordering contract | Cache-prefix split + authority precedence are properties of the *assembled output* → follow assemble. → resolved with the above (§8.2): `pinned` units never move/drop, `atomic` units never split. |
| **R-W3 / R-I2** | `session/state`, `state.view` | The state *schema* (which fields, which are LLM-visible) is the consumer's, not ours. |
| **R-C3 / R-C5 / R-C6** | `clear` / `trim` / `summaryWindow` | Loop-mechanics: *when* to clear/trim/summarize is a policy the orchestration loop owns. |

**Caution (POC-rigor):** the table tags **R-I1 `scope`** "cheap," but it touches *every op*
(schema migration + a filter on every query) — its shape is obvious but it is **invasive, not
cheap**. Don't let the label wave it through unmeasured.

**Current pick:** **R-C7 `compress()`** — ✅ **SHIPPED 2026-06-12.** Tier A, and uniquely it
*de-risks* the Tier-B linchpin (`assemble` composes it) instead of competing with it. `compress(node,
{level})` → `verbatim` (the body) | `signature` (header + doc, body elided) | `drop` (a name marker).
A pure render view (no DB/ranking/weights), exported from the library (`import { compress }`). The
signature tier extracts via tree-sitter (cut at the def's `body` field; a naive slice mangled
arrows/generics/multiline params — 99% vs 32% on 303 defs) and **wraps a bare method chunk in a
synthetic class** so methods (≈38% of real symbols) compress too. **Measured on 627 real named
symbols (litectx JS + OpenSpec TS + aurora PY): signature saves ~82% of bytes WITH the doc/docstring
kept, 0 unparseable** — correcting the earlier "95–98%" (a naive slice over only the parseable defs,
silently skipping methods). 16 tests. **The docstring tier surfaced an upstream indexing defect**
(below) — the chunker fix that attaches a symbol's leading doc to its chunk, which belongs to the
memory engine, not compress.

**↳ Indexing dependency (memory-engine, not CE) — leading docs are orphaned.** The POC falsified the
ledger's *"signature/docstring already extracted, render unit is free"*: the chunker persists only
`body`. **Python docstrings are inside the body (free).** But **JS/TS JSDoc is a sibling node above
the def** → `chunker.js` sweeps it into the file's `preamble` chunk (86/86 real JS defs orphaned).
So the doc is indexed but **dissociated from its symbol at chunk granularity. ✅ FIXED 2026-06-12**
(`chunker.js` `docStartRow` — extends a def chunk upward over an immediately-adjacent comment block;
a blank line breaks attachment) → a memory-engine change, not compress. The compress docstring tier
now falls out for free (docs ride in the body). **This is the fix's only justification — it does NOT
improve recall** (an earlier "doc→symbol 0/2→2/2" claim was retracted: it came from a crafted bench
with doc-exclusive sentinel queries; on real OpenSpec TS the fix changed localization in **0/3** cases,
because real queries share vocabulary with the code body and the named-chunk-over-preamble tie-break
already localizes correctly). Semantic recall is a wash too: the embeddings tier indexes the raw whole
file (no-op), and at symbol granularity the doc adds **−0.003 MRR** on fair name-derived queries
(`poc/rc7-doc-embed-poc.mjs`; the +0.248 upper bound is an artifact of doc-derived queries). File-level
recall is **byte-identical** (aurora 0.552 / gitdone 0.425) — FTS + `file_embeddings` index the **raw
whole file** (`indexer.js:104`→`store.js:317`), so the change lands only on chunk localization
(`attachChunks`, `index.js:279`), never file ranking. 146 tests, tsc + types clean.
*(memory: `chunker-orphans-leading-docs.md`)*

---

## 8.2 Build order resolved by the bareagent RT-seam negotiation (2026-06-12)

bareagent's first real CE consumer cut five seams into its loop (RT-1…RT-5) and negotiated, seam by
seam, **what litectx must do on its side of each**. This is the adopter the §8.1 Tier-B rows were
waiting on — it resolves `assemble`'s shape and surfaces two small build-now additions, while two
items stay deferred *with crisp trip-wires* (the litectx discipline: a deferral names the exact
condition that un-defers it). The seam shapes (the holes) are bareagent's and live in
[`litectx-for-baresuite.md`](../02-engineering/litectx-for-baresuite.md); the **litectx obligations**
are here.

**The boundary principle (binds all five): litectx owns content + relevance; it never learns the
provider's transcript grammar.** bareagent adapts *its* messages to litectx's neutral shapes — the
Store-socket move run in reverse. This is what keeps litectx standalone and is what makes both of
RT-1's hard questions (tool-call/result pairing; system-prompt protection) dissolve at the
*representation* layer instead of via trust or validation.

| RT | litectx obligation | Status | Resolution / trip-wire |
|---|---|---|---|
| **RT-1** | **`assemble(units, ctx) → units`** (R-G6/C2/X1/X4) over a neutral unit model `{id, role, content, kind, pinned, atomic, tokensApprox}`; SELECT (recall-inject) + COMPRESS (`compress`) + fit-to-`ctx.budget`, cache-stable order. | **BUILD-NOW — budget-fit POC ✅ CLEARED (2026-06-13)** | `pinned` units never drop/reorder; `atomic` units (a tool-call+its-result, bundled by bareagent's adapter) never split → grammar can't break and the system prompt can't be dropped, *by construction*, not by trust. Fits **best-effort and returns** — never enforces a hard cap; bareagent does final grammar-check + **fail-open** (degrade to full context, never crash). **The one unproven claim — "budget-fit preserves task success" — was the POC gate, now PASSED** (`poc/assemble-fit-poc.mjs` + `poc/assemble-fit-model-poc.mjs`, see `poc/RESULTS.md`): replayed 8 real transcripts / 1059 deps — the **budget-honest shipped** recency-anchored fit @50% budget loses **3.8%** of re-read deps (the POC's inline 1.8% was optimistic — an atomic-group overflow artifact, corrected in RESULTS.md), and a live model produces the correct next action **8/8** with the needed unit present vs **0/8** absent. **Two constraints the POC pinned for the build:** (a) the fit is **recency-anchored** — semantic re-rank of the transcript does NOT help (re-reads are recency-bound, not topic-bound), matching cache-stable order; (b) **`dropped[]`-with-handle is load-bearing** (dropping a re-read unit yields an explicit `CANNOT_DETERMINE`, recovered by one rehydrate re-read) → it ships in the **same slice**, not after. Transcript units pass through **`kind:null`**; only recall-injected units carry a litectx kind (role and kind are orthogonal). |
| **RT-2** | post-round observe/harvest hook (would let litectx `remember`/log mid-round). | **DEFERRED-ON-EVIDENCE** | No mid-round *capability* gap exists **while the canonical transcript is preserved intact** — every write target is losslessly reconstructable from `result.msgs` at end-of-task. Trip-wire: **un-defers the day the transcript-truncation seam (R-C3/`trim`) ships**, bound to it as a **harvest-before-evict interlock** (you cannot drop history you have not harvested). Secondary: RT-2 is also the *incremental* harvest vs end-of-task *batch* — an efficiency lever only, same trip-wire. |
| **RT-3 #2** | **`recall(q, {body:true})`** — inline-body flag. | ✅ **SHIPPED** (`9df3f5a`, 8 tests) | Chosen over the adapter doing N `get()`s: *where the body lives is kind-dependent* (fact/episode = same FTS row, ~free, zero extra reads; code/doc = the chunk slice we already localize) and that knowledge must not leak into the adapter. Bound default to the chunk span; widen to whole-file only when nothing localizes. Reused by `assemble` (units need body) — earns its place twice. Pure read-path; **no migration**. |
| **RT-3 #3** | **`meta` sealed passthrough** on write-path rows (`remember` only; null for indexed code/doc). | ✅ **SHIPPED** (`5402a6e`, 6 tests) — *first memory-tier migration* | Shipped as a **new non-FTS sibling table `mem_meta`** (not an `mem`/`docs` column) — sealed *by construction* (in no FTS table → never tokenized, searched, or scored), and a `CREATE TABLE IF NOT EXISTS` is the most additive migration possible (old dbs gain an empty table, no backfill). Chosen over a narrow "refuse unknown keys" contract (would break drop-in `Store` replacement). Guidance ships with it: *small structured tags, not payloads — big things go in `stash`*. Grades the migration path RT-5 reuses. |
| **RT-3 adapter** | **`liteCtxAsStore(lc)`** — the `{store,search,get,delete}` socket composing #2+#3. | ✅ **SHIPPED** (`1b57e77`, 8 tests) — *closes RT-3* | Free function, copies the host `Store` shape (no host import). Mints namespaced ids (#1), `recall({body:true})` content (#2), full metadata round-trip via the sealed passthrough (#3), single-kind comparable scores (#5), default kind `fact` (#4). |
| **RT-4** | sub-agent toolbox (mount `litectx-mcp` read verbs into a spawned child). | **ZERO NEW litectx CODE** (adapter ready) | `litectx-mcp` already curates to model-reasoning verbs (§10.5). Child default = **read-only** (`recall`/`get`/`impact`/`recent` allow; `remember`/`forget` opt-in; `index`/`promotions` deny). Opted-in writes land in the **child's own `dbPath`** (physical isolation, memory-PRD §3.2, **no schema** — decouples RT-4 from RT-5). Promotion to the parent store = explicit parent-orchestrated `recall`(child)→`remember`(parent), existing verbs, never an automatic bleed. |
| **RT-5** | **`scope TEXT`** column (R-I1) — logical partitioning of one shared store. | **DEFERRED** | Separate `dbPath` per child (RT-4) covers spawn isolation **today**, zero schema. Trip-wire: un-defers only for the **shared-db multi-tenant case** — many/ephemeral children in one store, or cross-child union queries (`WHERE scope=` for isolation, omit for union). Threads a scope predicate through *every* read/write/knn/access-log path (the §8.1 "invasive, not cheap" caution) — backward-compatible (default = single global scope) and **reuses RT-3's additive-column migration**. |

**Recording rule applied:** build-now obligations live here as requirements; the settled
*why/deferrals* are mirrored one-line in project memory (`bareagent-rt-seam-contract.md`) so the two
deferrals aren't re-litigated; the consumer-side seam shapes stay in the baresuite integration guide.

---

## 9. PRD relationship & remaining edits

**Two PRDs, separate by design — do NOT fold.** litectx ships as one library, documented by two
PRDs along a clean seam:

1. **`litectx-memory-prd.md`** — the **memory engine (all memory)**: recall, impact, the
   code+context graph, ACT-R, kinds, indexing, storage. **Unchanged by this doc**; it keeps its
   own §13 non-goals (memory-engine scope). This PRD **references** it (§1.0) and never rewrites
   or absorbs it.
2. **`litectx-ce-prd.md`** (this) — the **CE primitives** built on top (Write/Select/Compress/
   Isolate as views over the same graph). Its non-goals are §7 (CE scope).
3. **`barecontext-prd.md`** — **superseded by the two together**: its axis is now split — memory
   → the memory PRD, primitives → here. Its §4 primitives live here (§1–6), its §6 "bare test"
   became the lite line (§0), its §7 Aurora notes are subsumed by the
   [aurora-borrow-ledger](../02-engineering/aurora-borrow-ledger.md). ✅ **superseded banner added.**
4. **`CLAUDE.md`** — already points at `litectx-memory-prd.md`; add a one-line pointer to this CE
   PRD when CE build work begins. *(Optional, low-priority — the one outstanding edit.)*

**Engineering companions (not PRDs, but where the requirements' evidence lives):**
[`aurora-borrow-ledger.md`](../02-engineering/aurora-borrow-ledger.md) (memory signals + SOAR/CE
borrows, file:line) and [`copy-pattern-studies.md`](../02-engineering/copy-pattern-studies.md)
(LlamaIndex/ADK/Manus API surface + adaptation deltas). Requirement rows link to the relevant §.

**Build order (unchanged discipline):** CE slices come **after** the memory engine's recall/
impact slices graduate; every new signal is re-validated on both repos via the `poc/` bench
gate before it earns weight.

---

## 10. The bareagent/bareguard lift — copy/adapt for standalone fit

Read-only survey of both repos (file:line). Per **standalone, copy-don't-depend** (§0): we
**copy the design and adapt it** into litectx's own implementation — litectx never depends on
baresuite at runtime; where a primitive doesn't fully fit, **we adapt/enhance it** for litectx's
standalone needs. When litectx runs *inside* baresuite, it composes with the originals. Each
item is tagged **[copy]** (lift the design ~as-is), **[adapt]** (lift + change to fit), or
**[cede]** (baresuite keeps it; litectx only defines the seam). The lite line and bareguard's §6
action-vs-content thesis both hold.

### 10.1 bareguard — gate the memory-write, inherit floor supremacy (R-G3 / R-X2)
- **Gate decision contract — [copy → adapt]:** `Gate#check(action)` → `Decision{outcome:"allow"
  |"deny", severity, rule, reason}` (`bareguard/src/gate.js:215`, `types.js:40`); an action is an
  open dict keyed by `type` (`types.js:24`). litectx **copies this contract** and **adapts** it
  into its own minimal, optional **write-gate hook** so a `{type:"memory.write"|"memory.inject",
  kind, provenance, text}` is gate-able **standalone**. Inside baresuite, litectx emits that same
  action shape and **bareguard is the gate** (zero bareguard change).
- **Floor supremacy — [copy → adapt]:** the fixed **6-step eval order** (`gate.js:139-175`;
  contract `bareguard.context.md:202-216`) runs denies + asks (steps 1–4) **before** the
  allowlist (step 5) — so a write matching the user's floor `denyPatterns`/`askPatterns` is
  blocked **even if `memory.write` is allowlisted**. That *is* "a memory may never relax the
  floor." litectx **adapts the same eval-order pattern** into its write-gate hook so the
  invariant holds standalone; inside baresuite, bareguard enforces it.
- **Audit + redact — [adapt]:** litectx ships its **own small audit log + `redact`**, adapted
  from bareguard's design (every `check`/`record` emits a JSONL phase + action-shape line,
  `primitives/audit.js:79`; `redact` keeps secrets out, `secrets.js:22`) → the inject
  paper-trail. Inside baresuite it reuses bareguard's audit instead of double-logging.
- **Compose seam (when embedded):** `wireGate(gate,{actionTranslator})`
  (`bareagent/src/bareguard-adapter.js:107`, translator `:80`) — litectx touches only
  `.check/.record/.allows`, so it is **not coupled to a bareguard version**; standalone, its own
  hook does the same job.
- **The §6 line — do NOT push into bareguard:** the **content** half of the verdict (is this
  fact a prompt-injection? does it *semantically* conflict with the floor?) is content
  judgment bareguard refuses (`bareguard.context.md:313`). **Division:** litectx (or a
  guardrails tier) computes a content verdict and **reduces it to a shape flag** on the action
  (`provenance:"untrusted"`, `injectionRisk:"high"`); bareguard gates that flag **by shape**
  (`denyArgPatterns` / `content` regex). → R-G3 label = litectx · R-X2 shape-verdict + floor =
  bareguard (lift) · R-X2 content-verdict = litectx/guardrails tier (opt-in).

### 10.2 bareagent — insert *around* the loop, plug *under* the store (R-W*, R-I*)
- **Around the loop (⊘ loop unchanged):** `Loop.run(messages, tools, opts)`
  (`bareagent/src/loop.js:212`) never auto-reads memory — its `store` is validate-only
  (`:451`). Context assembly + persistence are caller space today. litectx sits **around** it:
  `assemble()` → `run()` → harvest `result.msgs` → persist. **Zero loop changes.**
- **Under the store — [adapt, no dependency]:** bareagent's `Store` interface is exactly
  `{store, search, get, delete}` (`bareagent/types/index.d.ts:58`). litectx ships an adapter that
  **matches that shape** (no bareagent import) → becomes bareagent's memory backend when present
  (project litectx recall onto `[{id, content, metadata, score}]`). litectx's own surface is the
  richer one; the adapter is the thin compat layer.
- **Replace / cede the overlaps:** **replace** `Memory` (`src/memory.js:20` — a 4-method
  passthrough, no ranking/graph) for long-running use; **cede** `StateMachine` (`state.js:23`,
  per-task FSM) and `Checkpoint` (`checkpoint.js:16`, a human-approval gate) — keep bareagent's;
  they don't overlap litectx's context store. *(Note: litectx's R-W3 session/state is a context
  store, a different thing from bareagent's task-lifecycle FSM — complementary, not duplicate.)*
- **Sub-agent spawning (⊘ CEDE, additive seam — R-I1/R-I3):** spawning exists
  (`tools/spawn.js:74` lib, `:229` blocking tool; child = a bareagent CLI process) and hands
  children **no scoped context** today. litectx's contribution: give each child a **scoped
  store / namespaced view** through the child's bareagent config — bareagent keeps fork +
  lifecycle, litectx owns the child's context boundary.
- **R-G7 eviction is unclaimed** — no eviction primitive exists in bareagent; litectx owns it.

### 10.3 Hand-off summary (litectx stands alone; composes when embedded)
| Capability | litectx (standalone) | baresuite (when present) |
|---|---|---|
| context assemble / recall / graph / supersession / eviction | **owns** | — |
| memory-write *shape* gate + floor supremacy + audit | label + content-flag | **bareguard** (lift, §10.1) |
| content trust verdict (injection / semantic conflict) | **owns** (or guardrails tier) | — |
| agent loop / tool dispatch | assembles `messages` around it | **bareagent** (`loop.js`) |
| sub-agent fork / lifecycle | scoped store per child | **bareagent** (`tools/spawn.js`) |
| per-task FSM / human-approval checkpoint | — | **bareagent** (`state.js` / `checkpoint.js`) |
| memory backend behind `Store {store,search,get,delete}` | **adapter** (`types/index.d.ts:58`) | bareagent consumes |

### 10.4 Aurora CE borrows that belong to the *siblings* (parked here so we don't miss them)

These surfaced in the aurora SOAR survey ([SOAR.md], [SOAR_ARCHITECTURE.md]) and the Arize talk
[Arize]. **None are litectx** — they're orchestration / budget enforcement. Parked here (not in
litectx's build surface) so the seam is captured. **Confirmed at file:line in the
[aurora-borrow-ledger](../02-engineering/aurora-borrow-ledger.md) §13** — incl. the correction that
the cost-budget gate and the retrieval-quality signal were *design-only* in aurora, never built.

**→ bareguard (budget *enforcement*):**
- **Cost-budget gate** — per-tier $ caps (SIMPLE $0.001 / MEDIUM $0.05 / COMPLEX $0.50 /
  CRITICAL $2.00), **pre-query soft (80%) / hard (100%) check**, monthly tracker.
  ⚠️ **DESIGN ONLY in aurora** — `aurora_core/budget/tracker.py` *tracks* spend but has **no
  per-tier caps and no soft/hard gate** (only documented in `SOAR_ARCHITECTURE.md`). So this is a
  design to **build fresh** in bareguard, not a tested borrow. Budget *enforcement* → bareguard;
  litectx only does budget-*aware assembly* (§7).

**→ bareagent (orchestration / LLM-interface):**
- **Query-complexity assessment** — lightweight **keyword dicts + regex, no LLM** (Tier-1,
  SIMPLE/MEDIUM/COMPLEX/CRITICAL), used to size the retrieval + decomposition budget.
  ✅ built: aurora `assess.py:82-343` (verb stoplists + question-pattern regex). *Deterministic but
  its job is budget-sizing → bareagent, not litectx.*
- **Decomposition caps** — MEDIUM/COMPLEX/CRITICAL = **2 / 4 / 6** sub-goals
  (`SUBGOAL_LIMITS`, aurora `decompose.py:167`). Lesson: LLMs over-engineer; **give a numeric cap
  and they respect it.** *(Separate knob: few-shot example count, since cut to 0/1/1/2 in
  `examples.py:111-116` to save context — don't conflate with the 2/4/6 subgoal cap.)*
- **Agent-matching as closed labels** — `excellent | adequate | bad`, **not** a confidence %
  (LLMs are bad at %, good at tight closed options); `bad` → spawn on the fly (Phase 4/5).
- **Verify-lite** — validate decomposition (no circular deps, required fields) **and** assign
  agents in one pass; **max 2 retries with feedback** (Phase 4).
- **Early-failure detection + circuit breaker + retry/fallback-to-LLM** (Phase 5).
- **Success-verdict feeding litectx R-W7** — bareagent decides an answer *succeeded*
  (confidence ≥0.8 / ≥0.5 → +0.2 / +0.05); litectx only applies the activation boost. The
  *verdict* is bareagent's; the *boost* is litectx's (see R-W7).
- **JSON-schema-enforced LLM I/O** — force structured output, retry on mismatch (general
  prompting discipline; pairs with the closed-label rule above).

### 10.5 Consumption surface — `import` vs MCP (who *chooses* the call)

litectx exposes the same capability through up to three channels; the deciding question for
each verb is **who decides to call it — code, or a model.**

- **Direct API (`import { LiteCtx }`)** — the caller is a *program* that knows the verb at
  write-time. **Strictly better than MCP for program→library use**: real types, in-process,
  no JSON serialization, no subprocess, streams/objects/handles survive, direct error
  semantics. baresuite/bareagent's own orchestration logic consumes litectx **this way**.
- **MCP server (`bin/litectx-mcp.js`)** — a *thin adapter over the API* whose only job is to
  **curate the verbs a reasoning model sees**. MCP earns its keep solely when an **LLM** must
  discover a toolbox at runtime and choose among tools. It does **not** make program
  consumption easier — wrapping a function call in JSON-RPC only *removes* capability and
  *adds* overhead. MCP is a toolbox **for the model**, never a convenience for the program.
- **CLI (`bin/litectx.js`)** — the human/hook surface (index, recall, impact checks). Gated by
  a concrete human/script caller; no verb goes here speculatively.

**The discriminator → which channel a verb lands on:**

| Verb class | Who chooses to call | Channel |
|---|---|---|
| `recall` · `remember` · `impact` · `get` · `recent` · `promotions` | the **model**, mid-reasoning ("recall X", "blast radius of editing Y") | **MCP** (+ API) |
| `stash` · future `assemble`/`isolate`/`clear`/`trim` | the **runtime loop** (baresuite), as plumbing *around* the model ("this result is huge — park it") | **API only** |
| `index` (human/hook-driven) | a person or a build hook | **CLI** (+ API/MCP for completeness) |

**Two relationships, not one** — baresuite both (1) **imports** litectx for its own loop logic
*and* (2) **mounts litectx's MCP** into the toolbox of the *sub-agent it drives*. #2 is the only
legitimate MCP use: equipping the model in the loop, not easing baresuite's own consumption.
The MCP surface stays lean **by design** — it holds exactly the model-reasoning verbs, so
orchestration mechanics like `stash` never clutter the everyday/standalone memory toolbox.

**A second MCP server is deferred** — true tool separation (e.g. an everyday `litectx` vs an
`litectx-agent`) is only warranted if an **autonomous Claude-style agent** (not baresuite —
baresuite imports) ever needs CE-automation verbs over MCP. A tool *description* does not
separate (every tool in a server stays visible + callable); only a separate server, left
disabled, does. Build it when that caller is real, not before.
