# Changelog

All notable changes to this project are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Slice 1 — incremental indexing + hardened schema:** `index()` is now incremental and git-aware — it re-reads only files whose content changed (fast skip on `(mtime, size)`, `content_hash` as the arbiter via a new `file_index` table) and drops files that disappeared; returns `{ files, added, updated, removed, unchanged }`. `index({ force })` rebuilds; `index({ paths })` scopes a pass without deleting outside it. `kind`/`format` are first-class columns on every row (format routed by extension: ts/js/py/md); recall hits carry both. CLI `index` reports the change breakdown and takes `--force`. 8 added `node --test` integration tests (incremental, deletion, size-guard, force, kind/format). Recall path unchanged — bench holds the slice-0 baseline exactly on both repos.
- **Slice 0 — walking skeleton:** `src/` library (`LiteCtx` index/recall, FTS5 `Store`, extension-routed git-aware indexer, code-aware tokenizer) + thin CLI `bin/litectx.js`. File-granularity, plain BM25. Pure ESM + JSDoc→`.d.ts` (typecheck clean); one prod dep (`better-sqlite3`); 6 `node --test` integration tests.
- Integration gate `poc/bench-lib.mjs` (`npm run bench`) — runs the real library on both repos so lib and gate can't drift. Slice-0 baseline: aurora MRR 0.523 / gitdone MRR 0.416.
- POC gate harness (`poc/`, throwaway) — dataset-driven recall benchmark over two repos (aurora Py / gitdone JS), four ablation rankers, MRR/P@k reporting. Results in `poc/RESULTS.md`.
- `CLAUDE.md` build doctrine pointing at `.claude/memory/{AGENT_RULES,LIBRARY_CONVENTIONS}.md`.

### Decided
- **POC gate PASSED for graph-aware recall** (PRD §11): graph spreading generalizes across both repos and is the real win; git-seeded base-level activation at a flat weight does **not** generalize (lost to plain BM25 on the second repo) and must be reworked with decay+churn before it earns weight.
- **Build methodology** (PRD §11.1): walking skeleton + vertical slices, integrated as they land; the multi-repo harness is the always-green integration gate; aurora is a second opinion, not an oracle.
- **Packaging** (PRD §14 #5): core library + in-repo CLI; MCP and graph-views are separate downstream consumers.

### Next
- Slice 2 (tree-sitter symbol-level chunking) — replaces file-granularity; the benchmark should jump. Must hold-or-beat the slice-0/1 baseline on both repos.

## [0.0.1] — 2026-06-04

### Added
- Initial placeholder release to reserve the `litectx` name on npm.
