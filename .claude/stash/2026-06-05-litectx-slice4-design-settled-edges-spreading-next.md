# Stash — litectx: Slice-4 design fully settled (edges+spreading+git-metadata), build is next

- **Date:** 2026-06-05
- **Repo:** `/home/hamr/PycharmProjects/litectx` (git, `main`, public GitHub `hamr0/litectx`).
- **Continues / supersedes:** `.claude/stash/2026-06-05-litectx-slice4-step0-activation-deferred.md`
  (that one stopped at the activation deferral; this captures everything through the §7 safety
  contract). Earlier chain: slice3-kind-scoped-recall → slice4-step0-activation-deferred → this.
- **Mode:** design discussion + two Step-0 POCs + full doc reconciliation. **Throwaway-POC phase
  DONE; at the START of slice-4 BUILD.** No `src/` touched this session — docs + POCs only.
- **Governing:** `.claude/memory/AGENT_RULES.md` (POC-first, simple-over-clever, no speculative
  code) + `LIBRARY_CONVENTIONS.md`. SoT engine = `docs/01-product/litectx-memory-prd.md`.
- **Commits pushed this session (all on `main`):**
  - `13b10ff` Slice 3: kind-scoped recall (the shipped slice-3 work).
  - `bdc526c` Slice-4 Step-0 POCs — defer base-level activation, spreading(imports) is the win.
  - `7f0b804` PRD §7 LSP/ripgrep carve-out + safety contract.
  - `bf65b53` propagate §7 safety contract to CHANGELOG + context.md.
  - HEAD = `bf65b53`, local==remote, clean (except 3 not-mine files, below).

---

## The two settled findings (POC-proven, in `poc/RESULTS.md`)

1. **Base-level (git-seeded) activation does NOT earn v1 ranking weight** — `poc/activation-poc.mjs`.
   Repo-dependent (+aurora / −gitdone at every weight 0.1–0.4); decay+churn (the ledger's "missing
   half") made gitdone *worse* (churn bites *stale* high-churn files; the failure mode is
   *recently*-churned ones). Root cause: base-level needs a real **access log** (mem-recall
   accesses), which v1 lacks — **git gives EDIT frequency, not ACCESS frequency** (two different
   sources; aurora's card shows `accessed 7x, 7 commits` separately). → **Deferred to the access-log
   tier** (litectx's long-running-memory differentiator; `activations` table schema-reserved).
   **Git → passive activity metadata** (commit count + last-modified, file-level `git log`, NO
   per-block blame), displayed alongside hits, NOT scored.

2. **Spreading is the v1 ranking win — over IMPORT edges only** — `poc/spreading-poc.mjs`.
   imports: +0.028 aurora / +0.021 gitdone (holds on both; HARD even stronger). **Call edges do NOT
   help recall** (great aurora, −gitdone — same repo-dependence that killed activation); merging
   calls into imports drags below baseline. ⚠️ caveat: the call result used a noisy proxy
   (over-linked ~13×) — re-test calls-in-recall only with the precise extractor, default imports-only.
   → **Recall spreading = imports; calls feed the IMPACT view (slice 5), not recall.**

**Consolidated signal model:** v1 default ranking = **BM25 + spreading(imports)** (two zero-ML
signals). Semantic = embeddings tier (opt-in; semantic≡embeddings, one renders the other).
Base-level activation = access-log tier. Context-boost folds into BM25 (slice-3 indexes symbol
names). "ACT-R in v1 recall" effectively means **spreading**, not base-level.

---

## The impact-view safety contract (PRD §7, GOVERNING — written this session)

The whole impact view is built on an **asymmetry**: **over-count is SAFE** (looks more connected →
AI over-cautious → wasteful not harmful; 75% accuracy fine); **under-count is DANGEROUS** (looks
isolated → AI thinks "safe to change" → breaks hidden consumers).
- **Invariant:** litectx may overstate connectivity freely, but must NEVER understate it silently.
  "connected/risky" = normal claim; **"isolated/unused/low-risk" = load-bearing safety claim**, only
  ships hedged. Dead-code = "review candidate," never "safe to delete."
- **Detection ~99% (tree-sitter); resolution is the gap and biased to over-count by design.**
- **LSP carve-out (in/out):** IN = calling, called-by, imports/connectivity, refs→risk, complexity,
  dead-code(candidate). OUT = get_definition/hover, lint, precise import-vs-usage binding (non-goal).
- **Every dangerous mode is an under-count.** Sorted by *danger × incidence × testability* — gate
  repos (aurora Py, gitdone JS) exercise ONLY reflection (aurora 23/497 `getattr`; gitdone 7/103
  dynamic `require`); **zero** aliases/barrels/TS:
  - **Build now (present + cheap):** entry/callback/export **roots** (aurora ships the lists to
    borrow); **reflection flag + string-literal mention check** (catches string-keyed dispatch where
    key==symbol name; rides the rg pass).
  - **Half now:** capture `export…from` re-export EDGES (cheap); barrel **transitivity** deferred
    (0 incidence, untestable, and unbounded transitivity makes everything HIGH = useless).
  - **Spec, don't build blind:** tsconfig/jsconfig path-alias resolution — real danger for TS but
    0 TS in the bench → **gate on adding a TS fixture repo first** (POC-first).
- **Universal safety net:** the only dangerous act is silently dropping a reference → any
  unresolvable ref (alias/dynamic/unfound import) is recorded **`unresolved`, never `absent`**, so
  isolation verdicts stay honest.

---

## Revised slice plan (0–3 shipped)
- **Slice 4 = edges(imports) + import-spreading in recall + git-activity-metadata.** The next
  ranking win. Gate = `npm run bench` (≥ baseline on aurora + gitdone + aurora-mixed with REAL
  tree-sitter+ripgrep edges).
- **Slice 5 = impact view** (calls + risk bucket + complexity + the §7.2 safety mitigations).
  **Prerequisite: add a TS fixture repo to the bench** to make aliases/barrels testable.
- **Deferred tiers (schema-reserved, not slices):** embeddings/semantic; access-log + base-level
  activation.

## Module seams (PRD §2.1) for slice 4
- `edges` (new) — symbol table → `imports` (recall) + `calls` (impact) edges. Store symbol-level +
  directed; aggregate to file-level + undirected for spreading; read directed for impact.
- `gitsig` (new) — file-level `git log` → commit count + last-modified metadata on hits (no blame).
- `recall` — add import-spreading fusion within-kind (slice-3 invariant: never re-rank across kinds).
- `langdef` — extend with `call_node_type` + import-node config + skip/entry/callback lists (borrow
  aurora's lists). `activation` module = NOT built in v1 (access-log tier).

## Open design calls (my leans, user mostly aligned — confirm at build time)
1. **Import resolution = intra-repo only** (skip node_modules/external; prefer a miss over a false
   edge). tsconfig path-aliases are a *safety requirement for TS* but gated on a TS fixture.
2. **Edge storage:** one `edges` table, symbol-level + directed; aggregate as needed.
3. **Hops/weight:** ship 1-hop (validated); settle 0.3-vs-0.4 on the integration bench.
4. **Calls-in-recall:** defer precise re-test to slice 5 (calls get built for impact anyway).

## NEXT action (build, not POC)
Build slice 4 in order: (1) `edges` module — **imports first** (tree-sitter import nodes →
intra-repo module→file resolution → `imports` edges table); (2) wire 1-hop import-spreading into
`recall` within-kind (~0.4) → run `npm run bench`, adopt weight only if ≥ baseline all 3 datasets
(STOP+discuss if real edges don't reproduce the POC lift); (3) `gitsig` metadata (small,
independent — anytime). Recommended start: edges(imports)+spreading (the validated value). `gitsig`
can be the warm-up if preferred. **Tests/typecheck after design stabilizes (Testing Trophy); every
weight re-validated on the multi-repo gate.**

## Carry-overs / debt
- **Code comment drift:** `src/store.js:47` still says line ranges "feed block git-blame (slice 4)"
  — now file-level metadata + deferred blame. Fix when slice 4 touches `store.js`.
- **TS fixture repo** needed before slice-5 alias/barrel safety mitigations can be validated.
- Pre-1.0 debt: CI (`ci.yml`/`publish.yml`), trusted-publishing OIDC.
- **NOT mine / leave alone (uncommitted, modified outside this work):** `docs/00-context/*`,
  `docs/01-product/litectx-ce-prd.md`, `M docs/01-product/barecontext-prd.md`.

## Throwaway POC files (kept, like run.mjs — not shipped, never imported)
- `poc/activation-poc.mjs` (base-level fail), `poc/spreading-poc.mjs` (imports win / calls fail).
- `poc/RESULTS.md` has both writeups as the evidence of record.
