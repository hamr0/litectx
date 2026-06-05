# Stash — litectx: Slice-4 Step-0 POC killed activation-in-ranking; slices reshaped

- **Date:** 2026-06-05
- **Repo:** `/home/hamr/PycharmProjects/litectx` (git, `main`, public GitHub). Slice 3 committed +
  pushed this session (`13b10ff`).
- **Continues:** `.claude/stash/2026-06-05-litectx-slice3-kind-scoped-recall.md`.
- **Mode:** Step-0 POC (POC-first, before building) + a long design discussion that **reshaped the
  remaining slices**. Doc reconciliation done. **NOT committed** (user commits explicitly; offer).
- **Governing:** `AGENT_RULES.md` (POC-first, simple-over-clever, no speculative code) +
  `LIBRARY_CONVENTIONS.md`. SoT engine = `docs/01-product/litectx-memory-prd.md`.

---

## The headline: git-seeded activation does NOT earn ranking weight — deferred, not built

Slice 4 was "ACT-R activation lands in recall." Per AGENT_RULES POC-first, I ran a ~throwaway
Step-0 POC **before** building the expensive git-blame plumbing. It falsified the premise.

**`poc/activation-poc.mjs`** (new, throwaway) extends the validated `run.mjs`: adds the term the
original POC dropped — **type-decay + churn** (ledger §3) — treating git commits as pseudo-accesses
(PRD §4.1.2). `act = BLA − decay`; swept weights 0.1–0.4. Result on the multi-repo gate:

```
               aurora ALL   gitdone ALL   adoptable (≥ baseline BOTH)?
  +bla.4 (rec) +0.005       -0.030        ✗
  +act.4       +0.009       -0.094        ✗  ← decay+churn made gitdone WORSE
  +act.2 (0.2) +0.060       -0.016        ✗
  +act.1 (0.1) +0.005       -0.004        ✗  ← "safe" only because ≈ zero
```

**No weight is ≥ baseline on both repos.** Two findings:
1. **decay+churn (the "missing half") did not rescue gitdone — it made it worse.** Mechanism: BLA
   *and* decay-recency both reward recent commits; the only counterweight is **churn**, which raises
   the decay *rate* but bites only *stale* high-churn files. gitdone's failure mode is *recently*-
   churned files → churn never catches them. Git-seeded base-level is just **repo-dependent**.
2. It re-derives aurora's own structure: aurora never scored git directly — git **seeded**
   activation and was **displayed raw**; its scored activation rode a **real access log**
   ("accessed 7x"). v1 has no access log → the base-level slot is empty → git can't fill it.

POC-first did its job: learned this **before** building per-block blame (aurora's "336× killer"),
whose only v1 consumer was this signal.

---

## The decisions (settled with the user via discussion)

1. **Base-level activation (BLA · type-decay · churn · context-boost) → DEFERRED to an
   "access-log tier"** — litectx's long-running-memory differentiator. Validated *then*, on real
   accesses, not git proxy. `activations` table already schema-reserved.
2. **Git → passive activity metadata** (commit count + last-modified, file-level `git log`, **no
   per-block blame**) attached to each hit as grounding — **not a scored term**. Mirrors aurora's
   result card.
3. **Spreading is the v1 ranking win** (original POC: +0.028 aurora / +0.021 gitdone, holds on
   both). It needs edges → **promoted to the next ranking slice**. "ACT-R in v1 recall" = spreading.
4. **Context-boost folds into BM25** — slice-3 `indexBody` already indexes symbol names (the thing
   boost rewarded); a separate scored boost is redundant for v1.
5. **v1 default ranking = BM25 + spreading** (two zero-ML signals). **Semantic = embeddings tier**
   (opt-in; semantic and embeddings are the *same* thing — one renders the other). **Base-level
   activation = access-log tier.**

### Revised slice plan (0–3 shipped)
- **Slice 4 = edges + spreading + git-activity-metadata.** tree-sitter+ripgrep `calls`/`imports`
  edges → 1-hop spreading fused **within a kind** (slice-3 invariant holds); git activity as
  displayed grounding. Re-run multi-repo gate incl. `aurora-mixed`; adopt spreading weight only if
  ≥ baseline on every repo. *(git-metadata is independent of edges — can land first/alongside.)*
- **Slice 5 = impact view** (refs → risk bucket + complexity over slice-4 edges).
- **Deferred tiers (schema-reserved, not v1 slices):** embeddings/semantic; access-log + base-level
  activation.

---

## Docs reconciled this session (uncommitted)
- `poc/RESULTS.md` — NEW "Slice-4 Step-0" section (the evidence of record).
- `poc/activation-poc.mjs` — NEW throwaway harness.
- PRD `docs/01-product/litectx-memory-prd.md` — §2.1 module table (gitsig/edges/activation/recall/
  impact rows + seam rule 3), §4 header callout (full reframe), §4.1 (retired banner), §5 (within-
  kind layering), §11.2 (slices 4/5 rewritten + deferred tiers), §12 (carry-over notes), §14 #1
  (CLOSED) + #4 (access-log gate), §15 (status + next action). Slice 5/6 → 4/5 renumbering.
- Ledger `docs/02-engineering/aurora-borrow-ledger.md` — §2/§3/§6 targets → deferred; §4 spreading
  → slice 4 (promoted); §5 boost → folded into BM25; §7 hybrid → v1 dual = BM25+spreading; §8 git →
  activity metadata (file-level); §12 blame banner; §11 heading slice 4/5.
- `README.md` — recall description + indexing paragraph (git = metadata, not ranking seed).
- `litectx.context.md` — roadmap table rows, BM25-only caveat, gotcha.

## DoD / verification
- `node --test` 26 pass / tsc clean (docs-only changes; no `src/` touched). `activation-poc.mjs`
  runs clean on both repos.

## Carry-overs / debt
- **Code comment drift:** `src/store.js:47` still says line ranges "feed block git-blame (slice 4)"
  — now file-level metadata + deferred blame. Fix when slice 4 touches `store.js` (not worth a
  docs-only edit now).
- Pre-1.0 debt unchanged: CI (`ci.yml`/`publish.yml`), trusted-publishing OIDC.
- **NOT mine / leave alone:** `docs/00-context/*`, `docs/01-product/litectx-ce-prd.md`,
  `M docs/01-product/barecontext-prd.md` (modified outside session).

## NEXT — Slice 4 (edges + spreading + git metadata)
- Start with another **Step-0-style POC** if spreading's real-edge extraction (tree-sitter+ripgrep)
  diverges from `run.mjs`'s regex edges — confirm the +0.028/+0.021 holds with *real* edges before
  wiring into `recall`. Then build `edges` + `gitsig` modules, fuse spreading within-kind, gate on
  all 3 datasets (incl. aurora-mixed), adopt weight only if ≥ baseline everywhere.
