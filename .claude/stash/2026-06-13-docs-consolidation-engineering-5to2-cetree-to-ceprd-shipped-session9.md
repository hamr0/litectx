# Stash — litectx: docs consolidation SHIPPED (no code) · 02-engineering 5→2 · ce-tree→ce-prd · committed + pushed (2026-06-13, session 9)

- **Date:** 2026-06-13. Continues from `2026-06-13-v0120-scope-model-shipped-grounded-bareagent-drift-fixed-next-build-B-session8.md` (session 8 = v0.12.0 scope model + Build B teed up). This session: **a pure docs-reorg pass — no `src/` / test / behavior change.** The user folded the scattered CE/requirement docs into fewer canonical homes, with every cross-link reconciled.
- **Repo:** `/home/hamr/PycharmProjects/litectx` (`~/Documents/PycharmProjects` = same tree). Branch `main`.
- **litectx HEAD:** `3b80c02` (`docs: consolidate the docs set into fewer canonical homes`). **Pushed to origin/main** (`6b6e1d3..3b80c02`). v0.12.0 still the published release — this commit ships **no package change** (docs are repo-only, not in the `files` whitelist).
- **bareagent HEAD:** `e35b07d` (`docs: consolidate to a single PRD…`), **already committed + pushed by the user** between turns — it carried my one cross-repo edit (the `prd.md` ref-repoint). bareagent is in sync with origin (ahead 0 / behind 0). The former standalone `litectx-runtime-prd.md` is now folded into bareagent `docs/01-product/prd.md` (seen at its line ~986).

---

## What this session did — the consolidation (all in `3b80c02`)

**`docs/` went from a scattered set → fewer canonical homes. Net `02-engineering` 5→2. Zero dangling links repo-wide (verified by sweep).**

1. **`barecontext-prd.md` (superseded SEED) → `docs/archive/`.** `git mv`; 3 inbound links repointed (00-context/README ×1, litectx-memory-prd ×2). Also fixed its **own** outbound links that broke on the move (litectx-ce-prd, litectx-memory-prd → `../01-product/`; aurora ref → build-studies). Its 2 `bareguard-prd`/`harness-prd` dangles are **pre-existing** (those docs never lived in this repo) — left as-is.

2. **Merge A — the litectx↔baresuite contract.** `bare-suite-buildable-now.md` + `litectx-for-baresuite.md` → **`baresuite-litectx-prd.md`** (renamed per the user: "say it's baresuite-litectx-prd"). Kept `bare-suite`'s §0–§4 **byte-for-byte** because **`§4.1`/`§4.4` are cited cross-repo** (bareagent `prd.md`) + by ce-prd; folded the integration guide in as an Orientation preamble + §5–§9. Updated all refs incl. cross-repo bareagent `prd.md` (4×).

3. **Merge B — the build studies.** `aurora-borrow-ledger.md` + `copy-pattern-studies.md` + `ce-eval-harness-scenario.md` → **`build-studies.md`** as **Parts A/B/C**, then `ce-flow.md` + `ctx-ifra.md` appended as **Parts D/E**. Each Part keeps its **original internal section numbers** (cite as "Part A §13", "Part B §4", "Part E"). User's framing: all 5 were "studies on how to build / market research that led to litectx's formation — they stay together."

4. **`ce-tree.md` → `litectx-ce-prd.md` Appendix CE-T.** Headers **namespaced** `CE-T.N` / `CE-T.N.N` (e.g. `§3.4`→`CE-T.3.4`, `§8`→`CE-T.8`) to avoid collision with ce-prd's own `§3`/`§8` and keep external citations resolvable. ce-prd 510→871 lines.

5. **`00-context/` reduced to its `README.md`**, rewritten as the CE doc-set **index/map** (points at the new homes: Part E = transcript, Appendix CE-T = tree, Part D = flows).

6. **Cross-link reconciliation pass** (the hard part, done after both destinations existed): ce-prd's own ce-tree links → intra-doc; the CE-T appendix's former ce-flow/ctx-ifra links → build-studies Part D/E; `doc #2`→`Part D`; two namespacing self-refs simplified; Part B's `ce-flow §3.2`→`Part D §3.2`; Part D's `ce-tree §8`→`ce-prd Appendix CE-T §8`; memory-prd's 4 "calibration source-of-truth" aurora refs → `build-studies.md Part A`; baresuite-prd §4's `ce-tree §3.4`/`ctx-ifra` → new homes (dropped brittle ctx-ifra line-numbers); the `mcp get` example doc path; the archived doc.

7. **CHANGELOG `[Unreleased]` → `### Changed`** entry documenting the reorg (flagged repo-only, no package/API/behavior change).

**Method note:** the two big verbatim folds + the ce-tree fold were delegated to 3 background sub-agents (verbatim-preserve, namespace headers, leave cross-links for my reconciliation pass); I did the rename, all link surgery, README rewrite, CHANGELOG, commit, push.

## Final `docs/` shape
- `00-context/`: `README.md` (index only)
- `01-product/`: `litectx-ce-prd.md` (+ Appendix CE-T) · `litectx-memory-prd.md` · `benches-prd.md`
- `02-engineering/`: **`baresuite-litectx-prd.md`** (contract, 441 L) · **`build-studies.md`** (Parts A–E, 1307 L)
- `archive/`: `barecontext-prd.md`

---

## NEXT — unchanged: Build B (the compress signature budget-tier in `assemble()`)
Still the next graduated build (gate #2 cleared in session 7; positional "middle valley" framing **refuted** for sonnet ≤41k tokens — build signature as a **rank/recency-driven** tier, NOT positional). **The open question is now answered** (the user pointed me at bareagent's runtime PRD this session): **COMPRESS composes on SELECT — it cannot run standalone over the transcript.** Raw transcript units carry `kind` but **no parseable `format`**; only recall-injected `code`/`doc` units (SELECT) carry the structure tree-sitter signature extraction needs. So Build B is scoped to units with `kind ∈ {code,doc}` + a parseable body, OR SELECT becomes a prerequisite slice. The grounding now lives in **`build-studies.md` Part B** (copy-pattern studies) + bareagent `prd.md` §1.2/§1.3. Re-read `poc/RESULTS.md` §4.5 gate #2 + `baresuite-litectx-prd.md` §4.3 before building.

## Housekeeping / open
- **Untracked prior stashes still untracked** in `.claude/stash/` (session-7, session-8, and this session-9 file). Prior stashes appear to be tracked history; the user has not said to commit them. Offer again or leave local.
- No POCs owed; no package release owed (v0.12.0 stands). All roadmap remainders trigger-gated (per session-8 stash): `stash` scope, RT-5 threading, persisted call edges, edge-confidence, jina-code model.

## Durable rules reinforced this session
- **Before overwriting, look at the target** — surfaced that `aurora-borrow-ledger.md` was NOT redundant design material but a **referenced source-of-truth** (memory-prd: "that ledger… is the source of truth for constants"; ce-prd cites its §13; an MCP example returns it), and recommended against dissolving it before the user decided to keep all three studies together. Recommendation given with evidence, user steered.
- **Don't break links on a move** — every `git mv`/rename was followed by an inbound-AND-outbound link sweep (in-repo + cross-repo), incl. catching that moving `barecontext` to `archive/` broke its *own* relative links. [[sequence-plans-by-dependency]]
- **Preserve cited anchors across a fold** — kept `§4.1/§4.4` (cross-repo), `CE-T §3.4/§8`, Part-A `§13` resolvable by namespacing/keeping internal numbering rather than renumbering.
- **Commit only when asked; targeted adds across repos** — committed litectx on the user's "commit and push all"; in bareagent would have added ONLY `prd.md` (the user's other bareagent work is theirs) — moot, they'd already committed it.
