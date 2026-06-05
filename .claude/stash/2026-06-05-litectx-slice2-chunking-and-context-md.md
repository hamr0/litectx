# Stash — litectx: Slice 2 shipped (tree-sitter symbol chunking, dual-grain) + adopter context.md

- **Date:** 2026-06-05
- **Repo:** `/home/hamr/PycharmProjects/litectx` (also resolves via `/home/hamr/Documents/...`).
  git, public GitHub `hamr0/litectx`, branch `main`.
- **Continues:** `.claude/stash/2026-06-04-litectx-prd-reconcile-memory-engine.md`.
- **Mode:** build (slice 2) + docs. **Committed AND pushed** this session (unlike prior doc-only sessions).
- **Governing files:** `.claude/memory/AGENT_RULES.md` (POC-first, dep hierarchy, testing trophy) +
  `.claude/memory/LIBRARY_CONVENTIONS.md` (pure ESM JS + JSDoc → generated `.d.ts`; one-prod-dep bar;
  §3 `<lib>.context.md` contract). SoT for the memory engine = `docs/01-product/litectx-memory-prd.md`.

---

## What shipped this session

### 1. PRD renamed (user request)
`docs/01-product/litectx-prd.md` → **`litectx-memory-prd.md`** (via `git mv`). All live refs repointed
(CLAUDE.md, README.md, the PRD self-label, the user's CE docs `docs/00-context/README.md` +
`litectx-ce-prd.md`). Stash files left with old name (historical record). `git grep litectx-prd.md` clean.

### 2. Slice 2 — tree-sitter symbol chunking (commit `00e141f`, pushed)
**POC-first finding (the headline correction):** the PRD said slice 2 "replaces file-granularity."
The POC (`poc/chunk-poc.mjs`, throwaway) proved a literal replacement **REGRESSES** the file-target
bench — pure chunk-BM25 lost on both repos under every pooling (aurora MRR 0.523→0.434 max-pool;
sum-pool collapses; top3 regresses gitdone). Reason: for *file*-finding, whole-file BM25 is a strong
baseline that sub-file chunks fragment. **Fused (file gate + α·best-chunk) ≈ break-even, lifts P@3.**
→ **Slice 2 reshaped to DUAL-GRAIN, not replacement** (user approved):
- File-level FTS `docs` table **stays the recall gate** → bench holds **EXACTLY** (aurora 0.523/64%,
  gitdone 0.416/45%). Recall path untouched.
- Symbol chunks land **alongside** in a new `nodes` table (line-ranged) — the substrate slices 4–5
  (git-blame, edges) ride on. The recall jump arrives in slices 3–4, NOT here (flat bench = success).

**Binding decision (validated, not assumed — user said "validate before deciding"):**
`poc/binding-bench.mjs` head-to-head → **web-tree-sitter (WASM) wins**, ~3× FASTER than native for this
walk-heavy chunk-extraction workload (native marshals a JS object per node across the C++ boundary;
WASM stays in linear memory), identical chunk output, <1s prebuilt install vs 40s node-gyp + peer
conflicts. **Pinned `web-tree-sitter@0.22.6`** (the 0.25+ dylink model can't load the older-ABI
grammars). **+1 prod dep** (web-tree-sitter, 292 KB). Rejected `tree-sitter-wasms` (50 MB, all langs) —
**vendored just 3 grammars** (py/js/ts, Unlicense) into `src/grammars/` (~3.4 MB).

**New modules:** `src/langdef.js` (the ONE language registry — `defTypes`/grammar per ext; seam rule 2,
edges will extend it) · `src/chunker.js` (WASM code chunks + md heading sections, line-ranged, file-level
fallback that never throws). `src/store.js` gained the `nodes` table + `nodeCount()`/`nodesForPath()`,
wired into incremental `applyChanges` (delete-then-insert per path). **`index()` is now async** (PRD §3
`await lc.index()` shape) — CLI, bench, and tests updated to await. `tsconfig.json` += `esModuleInterop`.

### 3. `litectx.context.md` — adopter contract (LIBRARY_CONVENTIONS §3)
Complete integration guide grounded in **shipped reality** (slices 0–2), roadmap surface
(`impact`/activation/edges/embeddings) explicitly marked 🚧. Closed the `files[]` whitelist gap
(npm pack 20→21 files). Every API claim cross-checked against source.

---

## DoD gates — ALL GREEN (verified, re-run, and adversarially checked)
1. **Behavior:** `npm run bench` holds baseline EXACTLY both repos.
2. **Types:** `tsc --noEmit` clean (no `!`/`as any`/`@ts-ignore`); `.d.ts` generate for all modules.
3. **Tests:** `node --test` 20 pass / 0 fail (14 prior + 6 new in `test/chunker.test.js`).
- **Adversarial verify done:** grammars ship full-size in tarball (3.5 MB unpacked, not truncated);
  **consumption from a foreign cwd (`/tmp`) works** — grammar path resolves via `import.meta.url`, not
  cwd (the real shipped scenario the in-repo bench wouldn't catch).

## Public API as shipped (the stable surface)
`new LiteCtx({root, include?, pathspecs?, dbPath?})` · `await index({paths?,force?})→{files,added,updated,
removed,unchanged}` · `recall(q,{limit?})→Hit[]{path,kind,format,score}` (BM25-only, file-granularity —
NOT activation-weighted yet) · `size()` · `close()`. Exports: `Store`, `splitIdent/keywords/ftsMatch`.
`ctx.store.nodeCount()/nodesForPath()` reachable but NOT a pre-1.0 stability promise.

## Git state
- `00e141f` Slice 2 — committed + pushed to `origin/main` (in sync). Carried 4 prior unpushed doc commits.
- **This stash + the context.md + CHANGELOG context.md entry are being committed next** (user: "commit
  it and push after changelog and /stash").
- **NOT committed / leave alone:** `docs/00-context/*` and `docs/01-product/litectx-ce-prd.md` (user's CE
  track — user edited litectx-ce-prd.md this session to a "two separate PRDs, no fold" framing).

## NEXT — Slice 3 (code-aware BM25 + FTS5 gate + code-over-md fix, §5)
1. **Apply seam rule 1:** move FTS body-text construction OUT of `store.applyChanges` (today doubles path
   tokens) INTO `tokenize` → code-aware body (identifier-split + deps + file_path folded in; aurora lesson:
   sparse code → descriptive queries return 0).
2. Per-candidate **kind-aware weights** + FTS5 gate (the 3 structural mechanisms from §5, NO md penalty).
3. **Open question to validate in-slice:** fold symbol chunks into the BM25 body at small weight (POC fused
   α=0.3 lifted P@3 both repos) vs defer to slice-4 activation re-rank. Adopt only if ≥ baseline everywhere.
4. Gate: tsc clean · node --test green · `npm run bench` **holds-or-beats** both repos (expect a genuine
   beat here, not just hold — this is where recall should first move).

## Pre-1.0 debt noted (not slice work)
- `litectx.context.md` now exists ✅. Still owed before a real `0.1.0`: CI workflows (`ci.yml`/`publish.yml`
  per LIBRARY_CONVENTIONS §5), trusted-publishing OIDC setup.
- Banner cosmetic-staleness in the memory PRD (older "~3–4k LOC / not part of bare suite" lines) — deferred,
  tied to the CE-scope track which the user is firming separately.
