# Stash: slice 10 + v0.2.0 published + slice 11 (KNN union) built & validated — slice 11 UNCOMMITTED

**Date:** 2026-06-11 (session spans 06-10 → 06-11; continues `2026-06-10-slice9-get-body-access-fetch-toll-force-fix.md`)
**State:** `main` @ `e97adf0`, pushed. **v0.2.0 PUBLISHED to npm** (tag `v0.2.0`, OIDC workflow green,
registry-verified). **Slice 11 is DIRTY in the working tree** — 11 files (9 M + 2 new:
`test/knn-union.test.js`, `poc/knn-union-poc.mjs`), validated, **not committed**.
113 tests (112 pass / 1 env-skip) · `tsc` clean · 3 code gates byte-identical to v0.2.0 baseline.

**OPEN QUESTION to user (unanswered):** commit slice 11 — and cut it as `0.2.1`/`0.3.0` now, or
hold for the access-log tier? (It's a user-visible recall improvement on the published tier.)

---

## Shipped this session

### Slice 10 — MCP surface + CLI write parity (commit `7440ed6`, 06-10)
- `bin/litectx-mcp.js` — **second bin in this package** (PRD §14 #5 AMENDED w/ user: "i dont want
  more packages"; "zero dep is aspiration not a hardliner"; "mcp is a surface"). Hand-rolled stdio
  newline-delimited JSON-RPC 2.0, zero new deps (no SDK; loop ~50 lines), client-spawned not a
  daemon. Six tools = six public ops, core options only (advanced opts lib-only — occurredAt
  backdating, pathspecs, kind arrays). isError results in-band; stdout protocol-pure; responses
  legally out-of-order (match by id). NO log:false over MCP (MCP client = live demand).
- POC-first: 101-line `poc/mcp-stdio-poc.mjs` validated vs REAL client (`claude -p --mcp-config
  --strict-mcp-config`) BEFORE the build. Shape: hexagonal-mini — src/ knows nothing of surfaces.
- CLI: `remember` (args or piped stdin) · `forget` (id | bulk --kind/--by, exit 1 no-match) ·
  `--embeddings` · `--no-log`. 7 spawn-the-binary JSON-RPC tests.
- Test lesson: failed spawning test strands child → runner HANGS; `client()` registers
  `t.after(() => proc.kill())`.

### v0.2.0 cut + published (commits `45c54b9`/`34a76ad`/`e97adf0`, tag, 06-10)
- "The write release" = slices 6–10 over 0.1.0. npm description un-placeholdered.
- Pre-cut E2E (packed tarball, clean projects): full lib contract sweep · published-0.1.0-db →
  0.2.0 upgrade (self-heal) · CLI sweep · real-client MCP six-tool pass · real-model embeddings.
- Post-publish E2E from live registry: types in tarball, both bins, positive/negative get probes.
- **E2E FINDING → slice 11's mandate:** embeddings tier did NOT bypass the BM25 gate — cosine
  only re-ranked the FTS pool; zero-shared-term paraphrase ("money back"→refunds fact) MISSED
  even with tier on. Docs corrected then; user then ordered the fix built.

### Slice 11 — KNN union: written-kind paraphrase recall (UNCOMMITTED, 06-11)
- **Mechanism:** `Store.knnCandidates(kind, qvec, k, exclude)` — mem-table rows joined to
  `file_embeddings`, cosine-scored, top `KNN_K = 8` (cos > 0 only) returned Hit-shaped (score 0,
  git null); `_rankKind` unions them into the pool pre-fusion; nominees enter at pool-floor dual
  score, rank on cosine. fact/episode ONLY — code/doc strictly gate-then-rerank (knnCandidates
  returns [] for non-mem kinds → old math byte-identical).
- **POC-settled** (`poc/knn-union-poc.mjs`, real model, K×T grid): **NO admission threshold** —
  true-para cosines run LOW (T=0.25 halves para MRR 0.556→0.306; T=0.35 → 0.083); K-cap+fusion
  are the guard. Boundary kept: cos>0 (zero/negative = no evidence; live probe: off-topic query
  cosines vs unrelated facts are NEGATIVE → empty result, not noise).
- **Bench (production == POC):** para 0.000→**0.574** (P@1 33%, P@3 83%) · morph 0.722→**0.889**
  (bonus: stemmer-resistant morphs nominate semantically) · exact **1.000** held.
- **Bench graduation:** memory-bench `--embeddings` pass informative → **GATED when it runs**
  (`ds.embFloors = {exact:.8, morph:.85, para:.55}`; mutation-checked: floor 0.99 → exit 1;
  skips when model dep absent — corpora discipline).
- **Tests:** `test/knn-union.test.js`, 8 tests, synonym-dimensions stub embedder (zero-overlap
  hit · tier-only · lexical-first · dedup · code stays gated · vectorless rows safe · episodes
  kind-scoped · KNN_K cap).
- **Limits (documented):** tier-off writes have no vector → never nominate (re-remember to fix);
  weakly-positive off-topic nominees can surface, ranked low.
- Docs synced: CHANGELOG [Unreleased] slice-11 entry · context.md (header 0–11, status row,
  recall §, config row, gotcha REWRITTEN: para now works for fact/episode with tier on) ·
  README (embeddings ¶) · PRD (§14 "not built, not promised" → ~~struck~~ BUILT; §11.2 slice-11
  entry; §15 heading + list item 4b).

## Environment notes (matter for reproduction)
- **`@xenova/transformers` SYMLINKED** into root `node_modules/@xenova/transformers` →
  `poc/node_modules/@xenova/transformers` (untracked; needed for memory-bench `--embeddings` —
  the lib resolves from root, not poc/). A clean checkout: bench pass skips (by design).
- That symlink broke slice-6 test "Embedder fails loudly when peer dep absent" → fixed as
  conditional `t.skip` when the dep resolves (still asserts in CI where absent). The 1 skip in
  113 is this.
- memory-bench gate-line greps used this session: `grep -E "PASS|FAIL|MRR|failures"`.
- v0.2.0 gate baselines live at `/tmp/gates/now-{recall,impact,memory}.txt` (tmp — regenerate by
  checking out v0.2.0 if needed; slice-11 outputs matched them exactly).

## Next (user-confirmed order)
1. **Resolve the open question** → commit slice 11 (+ optional release cut).
2. **Access-log tier** (PRD §15 #5, NEW SESSION) — FIRST build the **action-signal bench** (the
   biggest IOU): edit-bind / corrective re-remember / fetch / impressions / survived-exposure
   each earn weight there or ship at zero. Then capture: harvest-at-recall over the log window,
   file hash = trigger, chunk diff = attribution. Activation re-ranks, never gates.

## Grounding pass #2 (2026-06-11, re-validated at working tree — every claim re-run)
All numbers below were *executed*, not recalled:
- **Suite:** `node --test` → 113 tests, **112 pass / 1 skip / 0 fail** ✓ (runner is `node --test`,
  not Vitest — CLAUDE.md drift, harmless). `tsc --noEmit` → **exit 0** ✓.
- **Default bench (tier off):** exact 1.000 · morph 0.722 · **para 0.000 = expected baseline → PASS** ·
  exit 0 ✓.
- **`--embeddings` bench (real model, both dep paths symlinked):** exact **1.000** · morph **0.889** ·
  para **0.574** (P@1 33% / P@3 83%) — reproduces the recorded numbers exactly · exit 0 ✓.
- **Gate is real, not decorative:** mutation — raise `embFloors.para` 0.55→0.99 → PARA prints `FAIL`,
  `failures: 1`, **process exit 1**; reverted, back to 0.55 ✓. So the embeddings pass is **gated when
  it runs** as claimed.
- **No code-path regression:** recall bench (aurora 0.552 / gitdone 0.425) PASS exit 0; impact bench
  SAFETY=0 ISOLATION=0 exit 0 ✓ — the tier-off math is untouched.
- **Live end-to-end probe (public API, not fixtures):** `recall("money back guarantee period",
  {kind:'fact'})` — zero shared terms with the refund fact — ranks `refund-policy` **first** with the
  tier ON, and returns **0 hits with the tier OFF**. The win is attributable to slice 11, not lexis ✓.

**Bench-scope clarification (answers "do we have a bench now?"):** YES for slice 11 — a gated
*paraphrase/embeddings recall* bench now exists and holds. This is **NOT** the *action-signal bench*
that Next-step #2 (access-log tier) still owes — that one (edit-bind / corrective re-remember / fetch /
impressions / survived-exposure earn weight or ship at zero) is **still unbuilt** and remains the first
thing to build before the access-log tier. Two different benches; only the first exists.

## Session lessons (meta)
- **E2E found what 105 green tests + benches didn't** (the para gate hole) because it probed the
  *adopter journey* with the *real model* — the live-probe rule generalizes: probe contracts on
  real substrates, not just fixtures with stubs.
- **Sweep before you threshold:** intuition said "add a min-cosine floor"; the data said any
  floor kills true paraphrases (their cosines are low). The only defensible boundary was the
  semantically-grounded one (cos > 0 = "some evidence at all").
- **Watch the cwd in this harness** — `cd poc` persisted across calls and silently mis-ran an
  install (`npm i --no-save` landed in poc/) and a bench (`poc/poc/` path). Use absolute paths
  or explicit `cd` per command.
- A dep present-or-absent **environment fact in a test** is a latent failure — make such tests
  self-skip on the untestable branch.
