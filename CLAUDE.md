# litectx — Agent Context

**litectx** ("lite context") is a lite, local-first, importable npm library: a
code+context **graph** exposed as public API, with two views — **recall** (ranked
search) and **impact** (called-by/calling → blast-radius + low/med/high risk
bucket). Built on SQLite + FTS5 with ACT-R-style activation signals. No service
tier. The bare suite *consumes* it; litectx is standalone.

Published placeholder: `litectx@0.0.1` on npm (name reserved). Real implementation
follows once the POC gate clears.

## Source of truth — read these first

These two files govern; this CLAUDE.md only adds litectx-specific doctrine. When
anything here disagrees with them, **they win**.

1. **`.claude/memory/AGENT_RULES.md`** — parent standard: POC-first, dependency
   hierarchy (vanilla → stdlib → external), simple-over-clever, open-source-only,
   surgical changes, the Testing Trophy, security invariants.
2. **`.claude/memory/LIBRARY_CONVENTIONS.md`** — how we ship a JS library: pure
   ESM JS + JSDoc → generated `.d.ts` (no drift), library shape, `<lib>.context.md`,
   the doc set, CI shape (trusted-publishing OIDC, manual publish).

Design rationale lives in **`docs/01-product/litectx-memory-prd.md`** (PRD). Session
history in **`.claude/stash/`**.

## Dev Rules (from AGENT_RULES.md — mandatory)

**POC first.** Validate logic with a ~15min proof-of-concept before building. POC works → design properly → build with tests. Never ship the POC.

**Build incrementally.** Small independent modules, one at a time, each working on its own before integrating.

**Dependency hierarchy — strict:** vanilla JS → stdlib → external (only when stdlib can't do it in <100 lines). External deps must be maintained, lightweight, widely adopted. Vetted libraries required for security-critical code.

**Lightweight over complex.** Fewer moving parts, fewer deps, less config. Simple > clever. Readable > elegant. Every line must have a purpose — no speculative code, no premature abstractions.

**Open-source only.** No vendor lock-in.

**Surgical changes only.** Touch what the task requires; nothing else. Match existing style.

## Library shape (from LIBRARY_CONVENTIONS.md)

- **Pure ESM JS + JSDoc. No build step for shipped code** — the `.js` you author is the `.js` that ships. (This supersedes any "TypeScript source" framing in the PRD: TypeScript is a **dev-only** types toolchain, not the source language.)
- **Types: JSDoc → generated `.d.ts`, never hand-edited, git-ignored, built on publish.** `tsc` runs `checkJs` + `strictNullChecks` (not full `strict`). CI runs `tsc --noEmit` on every push/PR and before publish — a JSDoc/code mismatch blocks merge and publish. Never use `!`, `as any`, or `@ts-ignore`.
- **Two production dependencies, both explicitly justified** — `better-sqlite3` (storage + FTS5/BM25) and `web-tree-sitter` (vendored WASM grammars; the no-LSP edge resolution this doctrine mandates needs a parser). A third needs the same bar. The embeddings ML stack (`@huggingface/transformers`) is an **optional peer dep marked `optional` in `peerDependenciesMeta`** — NOT auto-installed, so `npm i litectx` stays lean + offline-capable; adopters who want the tier install it themselves (the embedder throws a helpful message if it's missing).
- **`package.json`:** `"type": "module"`, `main`, `exports` with a `types` condition on every subpath, `files` whitelist (`src/` + `types/` + doc set), `engines` Node floor.
- **Adopter docs:** `README.md` (pitch + 6-line quickstart) and `litectx.context.md` (complete contract — every option, full public API, extension contracts, "what's NOT in litectx and why", gotchas). Both ship. This `CLAUDE.md` and `docs/` are **repo-only — never in `files`**.

## litectx doctrine — the most-litigated refusals

- **NO LSP server, ever.** Edge resolution is **ripgrep `-w` + tree-sitter queries only**. Accuracy comes from the per-language def (`function_def_types` / `call_node_type` / `skip_names` / framework-callbacks). Over-counting is acceptable — the output is a risk *bucket*, not a precise reference list.
- **Embeddings OFF by default — but STRONGLY RECOMMENDED, and near-essential for memory.** Off-by-default is *only* to keep the base install lean + offline-capable (a library can't bundle the model the way a static-binary competitor can); it is **not** a quality stance. For the **memory primitive** (facts/episodes) embeddings is effectively required: paraphrase recall is 0.000 without it vs 0.574 with (a memory you can't query by meaning is half a memory). For **code** it's a strong lift (+0.2 MRR on natural-language queries across aurora/gitdone; free LLM query-expansion recovers ~90–95% and erases misses — see PRD §15 recall-litmus). Costs, measured 2026-06-11 (NOT the mis-borrowed aurora-torch figures): **ML dep** (`@xenova/transformers`) + **index-time embedding** (~67s/497-file repo, one-time/incremental) + **~23 MB** model downloaded once (breaks pure-offline first run). Per-query cost is negligible — **~0.7s cached load / ~2s first-download / ~6ms warm**, not "15–19s". Dual-hybrid (BM25+ACT-R) ≈ 85% vs tri-hybrid ≈ 95%.
- **Storage = `better-sqlite3` + FTS5, single file. Closed question** — no alternative store. BM25 native in SQL. Vectors (embeddings tier only) via `sqlite-vec` / float32 BLOB, same file.
- **Indexing routed by file extension everywhere — never sniff by content.** v1 langs: **TS, JS, Python**. Adding a language = tree-sitter queries + edge config (~1–2 days).
- **Graph is the substrate and is public API.** Future `codegraph` / `contextgraph` are views over the same data, not re-extractions.
- **`kind` discriminator first-class from day one.** v1: `code` + `doc` (md only). Reserved (schema ready, no migration): `fact`, `episode`, and doc formats pdf/docx/txt via a `format` field. PDF/DOCX deferred (heavier extraction libs).
- **One config** (`LiteCtxConfig`). No token/budget/guardrail concerns — that's the harness/bareguard layer.
- **Borrow, don't port.** Reimplement Aurora's validated algorithms in clean code; carry the calibration, not the code.

## The POC gate (next action — PRD §11)

Everything is gated on one question, **not a build yet**: *does activation +
graph-aware recall measurably beat plain FTS5/BM25?* Stupidly simple POC —
`better-sqlite3` + FTS5 (BM25) + hand-coded ACT-R base-level + git-seeded
cold-start + a few hardcoded edges + 1-hop spreading, on one sample repo.
**Pass → build v1 in the §11 sequence. Fail → re-scope to a thin BM25 index.**

## Testing (Testing Trophy — see AGENT_RULES.md)

Few unit (pure logic/algorithms) · many integration (real components, `:memory:`
SQLite) · some E2E. Test behavior not implementation. Tests come **after** the
design stabilizes — do not TDD the POC. Every bug fix ships a regression test.
JS test runner: Vitest.
