# Stash — litectx: PRD reconciled to single-source-of-truth + memory-engine module map

- **Date:** 2026-06-04
- **Repo:** `/home/hamr/PycharmProjects/litectx` (note: working dir resolved as
  `/home/hamr/Documents/PycharmProjects/litectx` this session). git, public GitHub `hamr0/litectx`, `main`.
- **Continues:** `.claude/stash/2026-06-04-litectx-slice1-and-aurora-borrow-ledger.md`.
- **This session:** a **doc-consistency pass on the PRD** (no code). Reviewed `litectx-prd.md`
  against the borrow ledger + the shipped slice-0/1 code, fixed the drifts, added a module map and
  a per-slice definition-of-done, and made the PRD the **single source of truth for the memory
  engine**. All edits are doc-only; **nothing committed, nothing pushed.**
- **Mode:** PRD reconciliation / planning.

> **SCOPE CLARIFICATION (user, load-bearing):** litectx is **two big parts** — (1) the **memory
> part (aurora-borrowed: index · recall · impact · graph)**, in active build; (2) the **CE
> primitives** (Write/Select/Compress/Isolate), **still being determined, no skeleton yet.**
> This session is ONLY about the **memory part**. The first answer drifted into CE — corrected.
> Goal for the memory part: *anyone can port it and use it standalone, via CLI, via MCP, or
> embedded in a CE harness for autonomous agents — lean, clean, fast, adaptable.* It will also
> hold non-code memory (docs, facts, episodes), so retrieval must stay fast/clean on all signals.

---

## Files changed this session (uncommitted, `git status`: ` M`)
- `docs/01-product/litectx-prd.md`
- `docs/02-engineering/aurora-borrow-ledger.md`

## PRD edits applied (the consistency fixes A–F + 2 process additions)
- **A — TS→JS drift fixed.** Source language is **pure ESM JS + JSDoc, no build step**; TypeScript
  is **dev-only** (`tsc` checks JSDoc + *generates* the shipped `.d.ts`). Fixed banner, §0 Stack,
  §0 Method, §3 code fence (```js), §12. Remaining "TypeScript"/"TS" mentions are all correct
  (the new dev-only note + "TS/TypeScript" as an **indexed language**, not the source).
- **B — markdown decay miscalibration (the real bug).** §4 decay map now keyed on **`(kind,
  format)`** with **markdown = 0.05** (NOT 0.02). Aurora tuned *markdown* (`kb`) at 0.05; its 0.02
  was for paginated pdf/docx. Same fix mirrored in **ledger §3** litectx-target line. (Ledger's
  aurora source table left intact as provenance.)
- **C — `file_index` schema** in §6 now includes `size` (shipped in slice 1); git-status tier noted
  deferred.
- **D — spreading sequencing** (§11.2 slice 4): spreading is scaffolded in slice 4 but **earns
  weight in slice 5** once real edges exist.
- **E — both edge types mandated** (§7 + slice 5): ship `calls` AND `imports` (= aurora
  `get_imported_by`), not calls alone.
- **F — dead-code candidate signal** added to §7 (review-candidate, never "safe to delete"); §13
  reworded to "binding-precise dead-code out of scope."
- **G — `activations` table** noted reserved in §9 (v1 has no access log; git seeds BLA).
- **NEW §2.1 — Module architecture** (the headline deliverable; see below).
- **NEW banner block — Single source of truth** (the doc hierarchy; see below).
- **NEW §11.1 — Definition of done per slice** (the 3 gates; see below).

## The single-source-of-truth hierarchy (now in the PRD banner)
- **`litectx-prd.md` = THE authority** for the memory engine. Decisions/scope/build-order live
  here or are *referenced* from here. When a companion disagrees about the memory engine, **the PRD
  wins; fix the companion.**
- `aurora-borrow-ledger.md` = **calibration appendix** (exact constants + aurora `file:line`),
  subordinate, referenced not duplicated.
- `litectx-ce-requirements.md` = **the other half (CE)**, separate/still-forming, NOT in this build.
- `barecontext-prd.md` = **superseded**.
- stash / CLAUDE.md = history/doctrine, never SoT.

## §2.1 Module map — memory engine (strict DAG, mapped to slices). State as of now:
| # | module | role | state | slice |
|---|---|---|---|---|
| 1 | `store` | SQLite/FTS5, pragmas, SQL, tables, getNode/related | ✅ have | shipped |
| 2 | `indexer` | collect + incremental diff + dispatch | ✅ have | 0–1 |
| 3 | `langdef` | per-lang registry (def types/call node/branch/skip/entry/callbacks/.scm) | embryo (`classify`) | **slice 2 (extract)** |
| 4 | `chunker` | tree-sitter (code) / section (md) chunks + line ranges | new | slice 2 |
| 5 | `tokenize` | code-aware BM25 text + query match | partial | slice 3 |
| 6 | `activation` | ACT-R **pure fns**: BLA·decay(type+churn)·spread·boost·total·norm | new | slice 4 |
| 7 | `recall` | FTS gate → kind-aware hybrid fusion → topK | inline | slice 4 (extract) |
| 8 | `gitsig` | file-level blame cache, slice per range → count+recency | new | slice 4 |
| 9 | `edges` | symbol table → `calls` + `imports` | new | slice 5 |
| 10 | `impact` | refs/files → risk bucket + complexity | new | slice 6 |
| 11 | `embeddings` | semantic tier (off by default) | tier | post-v1 |
| 12 | `LiteCtx` | facade: config + wiring | ✅ have | shipped |

**4 seam rules (in §2.1):** (1) `store` persists FTS content, never builds it — body-text
construction moves out of `store.applyChanges` into `tokenize` in slice 3. (2) ONE `langdef`
registry — chunker + edges + complexity all read it, never fork (`.scm` for chunking + node-type
config for edges hang off the same module). (3) `activation` stays **pure** (functions of
extracted signals) so the bench can ablate each term — the POC's "BLA doesn't generalize" was a
half-formula artifact. (4) `recall` is its own module, not the facade.

## §11.1 Definition of done — one slice = one module, 3 gates, then next
1. **Behavior** — `npm run bench` holds-or-beats baseline MRR/P@k on **both** repos (aurora +
   gitdone); adopt a weight only if ≥ baseline on *every* repo.
2. **Types** — `tsc --noEmit` (checkJs + strictNullChecks) clean; no `!`/`as any`/`@ts-ignore`.
3. **Tests** — integration-first (`:memory:` SQLite + tmp repo, <60% mock); bug fix ⇒ regression test.

## Architecture answer to "build it right / portable" (stated, not yet in PRD beyond §14 #5)
Library = **pure mechanism**; every surface is a **thin adapter over the same public API**:
core lib (`index/recall/impact/getNode/related` + later memory writes) · CLI `bin/` in-repo ·
**MCP = separate `litectx-mcp` package, stdio subprocess not a daemon** (stays in "no service
tier") · CE/agent = import directly. None re-implement logic → all surfaces stay in sync.

## Verdict given to user: PRD is CLEAR + READY for the memory engine. 3 rough edges (non-blocking):
1. Banner's older scope lines ("~3–4k LOC", "Not part of the bare suite", "context economy axis")
   predate the absorbs-CE scope — accurate for the memory engine alone, cosmetically dated; clean
   up when CE track firms.
2. **Slice 4 is the heaviest** — lands `activation` + `gitsig` + extracts `recall` (3 modules);
   consider splitting (4a activation+recall, 4b git-cold-start) to keep "one slice = one module".
3. §2.1 names are the **target**, not current filenames (src = store/indexer/index/tokenize);
   marked by the state column, not a defect.

## NEXT (unchanged engineering action)
1. **Slice 2 — tree-sitter symbol-level chunking** (TS/JS/Python + md sections). **Create
   `langdef.js`** here (seam rule 2). POC-first: web-tree-sitter/WASM vs native; `.scm` for
   chunking + node-type config for edges. Must hold-or-beat `npm run bench` on both repos. This is
   where recall numbers should first jump; gives slice-4 git-blame the line ranges it needs.
2. Then slice 3 (code-aware BM25 — apply seam rule 1) → 4 (activation full formula + extract
   recall, possibly split) → 5 (edges: calls + imports) → 6 (impact + dead-code candidate).
3. Optional doc cleanup: banner older-scope lines; mark `barecontext-prd.md` superseded; CLAUDE.md
   scope line (deferred — tied to CE track, which is out of scope this session).

## KEY CONTEXT FOR RESUMING
- **Gate = `npm run bench`** (`poc/bench-lib.mjs`, runs the real lib). Baseline both repos: aurora
  ALL MRR 0.523 / P@3 64%; gitdone ALL MRR 0.416 / P@3 45%.
- **Baseline still holds** — no code touched this session; only PRD + ledger markdown edited.
- **Governing files:** `.claude/memory/AGENT_RULES.md` (POC-first, dep hierarchy, testing trophy)
  + `.claude/memory/LIBRARY_CONVENTIONS.md` (pure ESM JS + JSDoc → generated `.d.ts`; anti-drift
  contract §2; one-prod-dep bar; mechanism-in-lib/policy-in-adopter; CI = typecheck+build:types+test,
  no lint; trusted-publishing OIDC, manual publish).
- **aurora paths:** `/home/hamr/PycharmProjects/aurora` (HEAD `750a39d`); ledger pinned to it.
- **Memories:** `borrow-aurora-dont-restart`, `litectx-absorbs-all-ce-primitives` (CE scope, NOT
  this session's focus), `ce-tree-and-skill-map-project`.
- **Untracked, NOT mine (leave alone):** `docs/00-context/*` (user's CE doc set),
  `docs/01-product/litectx-ce-requirements.md` (user's CE-half doc).
- **Slice 1 src seams (unchanged):** `src/indexer.js` `diffFiles()`/`classify()`; `src/store.js`
  `loadIndex()`/`applyChanges()` (+pragmas, FTS body-doubling on line ~107); `src/index.js`
  `index(opts)`; `src/tokenize.js` `splitIdent`/`keywords`/`ftsMatch`.
