# Stash — barecontext axis seeded + Aurora identified as port source

- **Date:** 2026-06-03
- **Branch:** main (harness PoC E1–E5 already on origin/main from prior session; THIS session's work is docs-only, **uncommitted**)
- **Continues:** `.claude/stash/2026-06-02-harness-poc-gates-e1-e5.md` (closed the harness POC). This session was a **think-out-loud / design** session — no code, no `src/`, all docs + memory.

---

## What this session did (all DOCS + MEMORY only — nothing built, nothing committed)

A talk on context engineering / context graphs prompted: *does this couple to bareguard?* Worked it to a disciplined answer, then discovered an existing port source.

### 1. Verdict: context engineering is a DIFFERENT axis → future sibling `barecontext`
- **bareguard governs the boundary** (what an action may do; action-vs-content §6). **barecontext governs the economy** (short/long-term memory, freshness, keeping a turn's context clean so pollution/hallucination doesn't carry forward and impair a long-running agent's decision).
- Coupling wholesale = scope creep ([[feedback-adoption-pushback]]); bar is HIGHER than an adopter request (a talk has no user). Held the line.
- **Sorting rule (decided): boundary/trust → bareguard; economy/freshness → barecontext.**
- Most talk techniques (trim/compact/summarize, RAG, state, sub-agent isolation, prompt hygiene) = runner/barecontext, NOT bareguard. Only narrow edges touch bareguard, and only via REUSE of existing primitives or already-true invariants — never new surface (borrowable = reuse; bloat = makes bareguard touch context or judge content).

### 2. Created `docs/01-product/barecontext-prd.md` (SEED / NOT-NOW)
A new bare-suite-sibling seed doc next to bareguard-prd.md + harness-prd.md. Sections:
- §0–§5: axis def; what context-engineering / context-graph are + their primitives (techniques table + graph building blocks: node, edge/provenance, salience, freshness, retrieval/assembly, eviction); the **bareguard↔barecontext sorting table** (borrowable-vs-bloat).
- §6: first-draft **"bare" test** for a barecontext primitive (local-first / minimal-legible / deterministic-where-possible / user-owns-retention per M1 / opt-in safe default) — bareguard's Appendix C can't be reused (its #1/#2 are the OPPOSITE of barecontext's job).
- **§7 (added last): Reference implementation — Aurora's memory engine (the port source).** See below.
- §8 suite relationship; §9 Status = SEED.

### 3. harness-prd.md trimmed to a pointer
§10.1 now just points to barecontext-prd.md §5 (sorting rule lives there); §11 gained one line ("context economy = different axis, future barecontext concern"). Earlier verbose OQ3/OQ4/OQ5 + §11 draft was REVERTED at user's request (keep future ideas as a pointer, not bloat).

### 4. KEY DISCOVERY — Aurora already contains a working barecontext engine (grounded by direct read)
`~/PycharmProjects/aurora` (Python monorepo). The code-aware memory engine = a de-facto barecontext prototype. **User correction was right:** the dependency/edge graph is LIVE (an earlier Explore agent wrongly called it dead — it read the vestigial tree-sitter `_identify_dependencies()`; the real path is LSP/ripgrep → `relationships` table → spreading activation).
- **§4 primitives → Aurora 1:1:** Node=`CodeChunk` (tree-sitter, w/ docstring); Edge=`relationships` table (`core/store/schema.py:53`, types depends_on|calls|imports, indexed); Salience=ACT-R `activation/engine.py`; Freshness=base-level decay; Retrieval=`semantic/hybrid_retriever.py` (BM25+ACT-R+embeddings, staged); Persistence=SQLite+FTS5.
- **LSP is real:** `packages/lsp` (multilspy) + batched ripgrep + `grep -w` fallback (`lsp/analysis.py:80-191`). Python LSP solid; JS/TS/Go/Rust/Java = "ripgrep works, LSP untested" (`analysis.py:475`). Feeds indexing via `cli/commands/memory.py:281`.
- **Extraction seam (clean, package-separated):** extract ~21k LOC = `core`(8.8k)+`context-code`(7.3k)+`context-doc`(1.0k)+`lsp`(3.8k). LEAVE ~50k = `soar`(orchestrator)+`reasoning`(LLM decompose=the mediocre part)+`spawner`+`cli`(35k). The leave-pile is the probabilistic harness — the soft spot per the whole programme.
- **Port to JS = sound, JS is the BETTER host:** ACT-R/BM25 trivial; SQLite→better-sqlite3; tree-sitter→web-tree-sitter (JS = tree-sitter's best ecosystem); LSP→vscode-jsonrpc driving the SAME standalone servers (the one medium rebuild); ripgrep→child_process. 
- **Lightweight path (grounded):** embeddings OPTIONAL — `hybrid_retriever.py:14` documents BM25+ACT-R dual-hybrid fallback "85% vs 95% tri-hybrid". Zero-ML bare core viable; embeddings = opt-in tier.
- **Scoping tension (honest):** 21k LOC + tree-sitter + LSP is NOT bareguard-tiny. Hold both by defining barecontext as a small primitive SURFACE — `index / retrieve / relate / evict` — over the engine, with tree-sitter/LSP/embeddings as opt-in tiers. "Bare" here = local-first/no-service/deterministic-core/optional-tiers, not ≤150 LOC.

### 5. Also answered (factual)
- Claude Code = built on Claude Agent SDK = a context-engineering harness for coding. **Correct** — but its context engineering = retrieval-on-demand + compaction + subagent isolation, NOT a persistent ACT-R/BM25 index. Aurora's core is complementary, not subsumed.
- **Agent SDK locks you to Claude — correct.** Not provider-agnostic. Aurora already depends on anthropic+openai+ollama (multi-provider), so adopting the Agent SDK throws that away. Real fork.
- Anthropic SDK context primitives map: NATIVE = compaction (beta), context editing, prompt caching, token counting, tool search, PTC, task budgets, memory *interface* (you supply storage), + full memory stores on Managed Agents. BUILD-YOURSELF = RAG/embeddings substrate (no first-party embeddings endpoint), state object, context graph, memory guardrails, trimming/summarization policy.

---

## Files changed this session (DOCS only — `src/` untouched; UNCOMMITTED)
- **NEW** `docs/01-product/barecontext-prd.md` (SEED/NOT-NOW; §7 = Aurora port source)
- **EDIT** `docs/01-product/harness-prd.md` (§10.1 → pointer; §11 += one ceiling line)
- Memory: NEW `project_aurora_barecontext_core.md`; updated `project_harness_prd.md`, `MEMORY.md`.
- Pre-existing uncommitted docs reorg (`D docs/decisions-log.md`, `docs/02-features/`, `docs/04-process/`) still UNTOUCHED — not ours.

---

## NEXT (all gated — user is THINKING OUT LOUD, no build decision yet)
- barecontext stays **SEED / NOT-NOW**. No `src/`, no build, until a real concrete need.
- If pursued: draw the minimal `index/retrieve/relate/evict` surface (core vs opt-in tier), rebuild code-aware part in JS from the Aurora `core`+`context-code`+`context-doc`+`lsp` packages, drop the orchestration.
- Open thread offered, not taken: read Aurora's `reasoning/decompose.py` to see WHY the decomposer was mediocre.
- Harness side unchanged from prior stash: spine exercised, Axis-B `src/` DEFERRED on OQ1 + real user.
