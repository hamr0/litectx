# Stash — barecontext axis became a named library: `litectx` (PRD set)

- **Date:** 2026-06-04
- **Branch:** main (harness PoC E1–E5 already on origin/main from prior sessions; THIS session = docs + memory only, **uncommitted**)
- **Continues:** `.claude/stash/2026-06-03-barecontext-axis-aurora-portsource.md` (which identified Aurora as the port source for the deferred `barecontext` axis). This session **named the library, set its PRD, and locked the build decisions** — moving from SEED/NOT-NOW to a DRAFT PRD with a POC gate.
- **Mode:** think-out-loud / PRD-setting. No `src/`, no build, nothing committed.

---

## Headline outcome

The "context economy" axis from barecontext-prd.md is now a **named, scoped library: `litectx`** ("lite context"). DRAFT PRD written at **`docs/01-product/litectx-prd.md`**. It is **NOT** part of the bare suite (it's a real ~3–4k-LOC lib, not a ≤150-LOC primitive). Built by **borrowing** (not porting) Aurora's validated kernel. **Next action = the POC in PRD §11, NOT a full build.**

---

## Naming journey (don't relitigate)

User-driven, npm-checked at each step:
- `cortext` (user's first pick: cortex+context) → **taken** on npm (v0.13.0, "Metacognition for Claude Code prompts" — adjacent domain, real collision).
- `engram`, `recall`, `hippo`, `mnemo`, `codecortex` → all **taken**.
- `mnesia` (user pick) → npm-free BUT rejected: **too close to "amnesia"** (= loss of memory, opposite meaning) + Erlang DBMS collision.
- **`litectx`** (user pick via Other) → **FREE on npm**, FINAL. Good: lightweight signal, no `*graph` collision with future children, no amnesia echo.
- Fallback if ever needed: `cortexel` or `mnema` (both free, memory-rooted).

---

## DECIDED (locked in PRD — do not relitigate)

1. **Identity:** lite, local-first, importable **npm library** (Node + TypeScript). Standalone; the bare suite *consumes* it. Discipline = lite/local-first/no-service/deterministic-core/optional-tiers (NOT "bare").
2. **Core = one substrate, two views.** Substrate = a **code+context graph** (typed nodes + typed edges + per-node signals). Views = **recall** (ranked search) + **impact** (called-by/calling → blast-radius + risk bucket low/med/high). **The graph is exposed as public API** so future `codegraph`/`contextgraph` are views over the same data, not re-extractions. (User explicitly AGREED to this reframe.)
3. **Storage:** `better-sqlite3` + FTS5 (single file, synchronous, BM25 native in SQL). Closed question — no alternative. Vectors (embeddings tier only) via `sqlite-vec` or float32 BLOB, same file.
4. **Indexing routed by file EXTENSION everywhere** (never sniff by content). v1 langs = **TS, JS, Python**. md + code, incremental 3-tier git re-index (git status→mtime→content-hash). **Block-level git-blame signals** (per chunk line-range) = differentiator.
5. **Edges = tree-sitter queries + `ripgrep -w` ONLY. NO LSP server, ever** (user was explicit: "the one and only ripgrep"). Accuracy comes from per-language def (function_def_types / call_node_type / skip_names / framework-callbacks). Goal = best-possible blast radius via lang def. Over-counting is fine for a risk *bucket*. ~1–2 days/language.
6. **Embeddings OFF by default**, the only opt-in tier (`@xenova/transformers`/ONNX or sqlite-vec). Dual-hybrid (BM25+ACT-R) ≈ 85% vs tri-hybrid ≈ 95%; embeddings add 15–19s cold latency + ML dep.
7. **`kind` discriminator first-class from day one** (§3.1). v1 implements `code` + `doc`(**md only**). Reserved (schema + decay-map ready, NO migration): `fact` (semantic memory), `episode` (episodic), and doc formats pdf/docx/txt via a `format` field under `kind=doc`. ACT-R applies across kinds → how short/long-term memory lands later. PDF/DOCX deferred (need heavier extraction libs).
8. **One config** (`LiteCtxConfig`), no token/budget/guardrail concerns (that's bareguard/harness). Provider-agnostic.
9. **Method = borrow, don't port.** Reimplement Aurora's algorithms in clean TS; carry the *calibration* not the code.
10. **Repo move:** `litectx-prd.md` + `barecontext-prd.md` both **move to a new `litectx` repo once settled**; bareguard keeps only the boundary reference (bareguard↔litectx).

---

## Grounded findings from Aurora docs (read this session)

Read (from `~/Documents/PycharmProjects/aurora/docs/02-features/` — note: TWO aurora paths exist, `~/Documents/PycharmProjects/aurora` and `~/PycharmProjects/aurora`, same git HEAD 750a39d):
- **ACTR_ACTIVATION.md** — full formula set: BLA `ln(Σ t^-d)` d=0.5; spreading F=0.7 max 3 hops; context boost 0.5; decay `-d·log10(days)` 1-day grace cap 365; type-specific decay (kb 0.05 / class 0.20 / function 0.40); churn `0.1·log10(commits+1)`; MMR (needs embeddings). 5 presets.
- **MEM_INDEXING.md** — extension→type map; 3-tier incremental; FTS5 gate **replaced** activation gate (v0.17.1, fixed rare-code starvation); code weights `(0.5,0.3,0.2)` vs kb `(0.3,0.3,0.4)`; code-aware tokenizer `getUserData→get/User/Data`; "Adding a Language" = 2 layers (tree-sitter queries + edge config).
- **LSP.md** — accuracy data (LSP 231 refs vs grep 396; grep over-counts); ripgrep ~2ms vs LSP ~300ms/symbol; multilspy = Python-only, hand-driving in Node = fragile → REJECTED.
- **CACHING_GUIDE.md** — embeddings cause 15–19s cold search → confirms keeping them opt-in.

**Code-over-md fix (user remembered this; grounded):** 3 structural mechanisms, NO penalty hack (grepped, none exists): (1) per-candidate kind-aware weights (code BM25 0.5), (2) FTS5 gate replaced activation gate, (3) code-aware tokenizer + deps/file_path in BM25 content.

**Cold-start BLA (clean design proposed):** never-accessed = neutral (BLA 0, decay 0). Recommended unification: **seed BLA access-history with git commit timestamps as pseudo-accesses** → one `ln(Σ t^-d)` formula bootstraps first-index ranking (commit recency→recency, count→frequency). Validate in POC.

**complexity ≠ risk (corrected the user):** complexity = cyclomatic AST branch count (local); risk/impact = reference count from call graph (blast radius). Separate schema fields.

**Aurora package LOC (grounded):** keep ≈ core/activation (~2.4k) + store schema/memory + chunks + bm25 + git + lang defs; the real TS kernel ≈ 3–4k LOC (NOT 21k). Leave: soar/reasoning/spawner/cli (~50k) + Python plumbing (pooling/budget/logging/metrics/retry/abstract-store) + the entire `lsp` package.

---

## Files changed this session (DOCS + MEMORY only, UNCOMMITTED)
- **NEW** `docs/01-product/litectx-prd.md` (DRAFT — the deliverable).
- **DELETED** `docs/01-product/mnesia-prd.md` (interim, renamed to litectx).
- **MEMORY** updated `project_aurora_barecontext_core.md` (+ litectx outcome block) and `MEMORY.md` index line (Aurora→litectx).
- Pre-existing uncommitted docs reorg (`M harness-prd.md`, `D decisions-log.md`, `docs/02-features/`, `docs/04-process/`, `barecontext-prd.md`) — NOT touched this session.

---

## NEXT (gated)
- **The POC (PRD §11), not a build.** Stupidly simple: `better-sqlite3` + FTS5 (BM25) + hand-coded ACT-R base-level + git-seeded cold-start + a few hardcoded edges + 1-hop spreading, on one sample repo. **Hypothesis to kill/confirm: does activation + graph-aware recall measurably beat plain FTS5/BM25?** Pass → build v1 in §11 sequence. Fail → re-scope to a thin BM25 index.
- Offered but NOT yet chosen by user: scaffold the `litectx` repo + write the POC, vs let the PRD settle first.
- Open questions live in PRD §14 (cold-start unification, MMR-without-embeddings, extra edge types, access-write-path ownership, codegraph/contextgraph packaging, fact/episode kinds).
