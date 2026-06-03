# Changelog

All notable changes to this project are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- POC gate harness (`poc/`, throwaway) — dataset-driven recall benchmark over two repos (aurora Py / gitdone JS), four ablation rankers, MRR/P@k reporting. Results in `poc/RESULTS.md`.
- `CLAUDE.md` build doctrine pointing at `.claude/memory/{AGENT_RULES,LIBRARY_CONVENTIONS}.md`.

### Decided
- **POC gate PASSED for graph-aware recall** (PRD §11): graph spreading generalizes across both repos and is the real win; git-seeded base-level activation at a flat weight does **not** generalize (lost to plain BM25 on the second repo) and must be reworked with decay+churn before it earns weight.
- **Build methodology** (PRD §11.1): walking skeleton + vertical slices, integrated as they land; the multi-repo harness is the always-green integration gate; aurora is a second opinion, not an oracle.
- **Packaging** (PRD §14 #5): core library + in-repo CLI; MCP and graph-views are separate downstream consumers.

### Next
- Slice 0 — walking skeleton: index → SQLite/FTS5 → `recall` CLI at file-granularity BM25.

## [0.0.1] — 2026-06-04

### Added
- Initial placeholder release to reserve the `litectx` name on npm.
