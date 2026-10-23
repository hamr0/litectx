# Keep vectors on rebuild — spec (not built)

Status: spec only, 2026-10-23. Source: fix-ledger bullet at `src/index.js` "let embedPending = 0;".

## Problem and evidence

Since embeddings moved out of the atomic commit into the per-file backfill (ec98189, `index({signal})`),
a whole-index rebuild wipes every file vector in the commit and refills them one file at a time afterwards.

- `index({force:true})` or a stale stamp (`PRAGMA user_version` or per-node `nodes.stamp`, src/index.js:429-437; any
  release that touches `src/*.js` changes the stamp, and the default-ON CLI/MCP warm-index runs it) sets `clearAll`.
- `applyChanges` then runs `_clearIndexedRows()`, which deletes `file_embeddings` (src/store.js:683) and `doc_sections`
  (which hold the md section vectors, :684). The upsert loop also deletes each upserted file's vector (:857).
- The backfill (src/index.js:521-576) then re-embeds everything: about 67 s per 497 files, about 2 s a file, blocking
  the event loop. Until a file is re-embedded, code recall falls back to BM25-only for it.
- Measured (ledger): ranking during the embed phase differs from before and after (`b.js:2.000 a.js:1.000` vs
  `b.js:1.000 a.js:1.000`). Old code, with vectors inside the commit, was identical throughout.
- The vectors being thrown away are usually still valid: the same bytes give the same input, and so the same vector.

## Goal

A rebuild whose file bytes did not change keeps its vectors. Recall ranking is identical before, during and after.
A force or stamp rebuild of an unchanged tree embeds nothing (about 0 s instead of about 67 s).

## Non-goals

- No change to `mem_embeddings` (written memory). Rebuilds never touch it (src/store.js:679; `clearIndexed`, :576, keeps it).
  Out of scope.
- No change to chunking, stamps, or the recall formula. No new embedder or model.
- No automatic model migration UI. A model change just re-embeds, quietly, over the next passes.

## What the embed input really is (checked)

- Code and non-md files: the whole file body, `readFileSync(...)` then `embed(body)` (`readFileSync` src/index.js:530, `_embedSafe(body)` :544),
  head-cut to `HEAD_CHARS = 6000` inside `Embedder.embed` (src/embedder.js:11,58). Depends only on the file bytes, the
  model (default `Xenova/all-MiniLM-L6-v2`), dtype `q8` (embedder.js:47) and `HEAD_CHARS`.
- Indexed md: one vector per heading section, input = that section's stored text (`nodes.body`, read by `vectorlessSections` at src/store.js:1897 and embedded at src/index.js:570). Depends on the chunker's section text, so a chunker change can change what a section contains.
- The vector must not depend on the index stamp: the stamp is a hash of all `src/*.js`, so tying vectors to it
  would bring the problem straight back on every release.

## Design

1. Each vector records what it was made from. Add two columns: `th` (sha256 of the exact text embedded) and `ekey` (the
   embed recipe key, below). On `file_embeddings` and on `doc_sections` (`vec`/`dim` already live there).
   For a file, `th` equals the file's content hash.
2. Reuse inside `applyChanges`, in the same transaction as the clear. Do not delete the vector when it is still valid:
   - File: keep the `file_embeddings` row if `th` equals the new `u.hash` and `ekey` equals the current key.
     Otherwise delete it (as today, :857). `_clearIndexedRows` stops deleting `file_embeddings` wholesale (:683);
     instead, at the end of the transaction, delete vectors whose path is no longer in `file_index`
     (needed because a `clearAll` pass has an empty `prev`, so `deletes` is empty and a removed file would
     leave an orphan vector).
   - Section: before `doc_sections` is cleared (:684, and `delSec` for upserts), snapshot `(path, th, ekey, dim, vec)`
     for the paths being rebuilt. When the new section's `sha256(c.text)` and the key match a snapshot entry, insert the
     new `doc_sections` row with that vec (`insSec`, prepared at store.js:762, is run at :844 with `vec: null`). Match by text, not position:
     a moved or renumbered section with identical text keeps its vector; an edited one loses it.
3. The backfill is unchanged in spirit: it embeds only what is still vectorless, so reused vectors are skipped.
   `vectorlessFiles` / `vectorlessSections` (store.js:1875-1899) also treat a row whose `ekey` is not the current key as
   vectorless. `embedded` in `IndexResult` now counts new vectors only (docs and CHANGELOG say so).
4. Recall reads only vectors whose `ekey` matches the current key (`getEmbeddings`, store.js:2407), so a stale-model
   vector is never mixed into a cosine (different models give meaningless cosines, possibly a different `dim`).
5. The hash-conditional write now being added to `putEmbeddings`: write only if `file_index.content_hash` still equals the
   file hash the caller read the body at (the guard hash), and store `th` and `ekey` in the same statement. For a file
   the guard hash and `th` are the same value (the file content hash). `putSectionEmbeddings` passes both values: the
   file hash for the guard (compared to the section's file's `file_index.content_hash`, as src/store.js:1918 does today)
   and the section's own text hash, stored as `th`. The two differ for sections, so the guard never compares the
   section-text hash to the file hash. One TOCTOU rule for both the backfill and reuse.

### Embed key

`ekey = model id | dtype | HEAD_CHARS | sha256(src/embedder.js) prefix`. Computed once per process, like `indexStamp`
(a source hash, so a recipe change cannot be forgotten). The injected-embedder case is decision 3 below.
The key never includes the index stamp or the package version.

## When vectors MUST be invalidated, and how it is detected

| Cause | Detected by | Result |
|---|---|---|
| File bytes changed | `th` != new content hash | row deleted, backfill re-embeds |
| `embedModel` or dtype changed | `ekey` mismatch | ignored by recall, re-embedded by backfill |
| `HEAD_CHARS` or any edit to embedder.js | `ekey` mismatch (source hash) | same; over-trigger on a comment edit is accepted-safe |
| md section text changed, or chunker change that alters text | section `th` mismatch | only changed sections re-embed |
| Chunker change that only moves boundaries, text identical | no mismatch | vectors kept (correct: same input) |
| Change to what `index.js` feeds the embedder (e.g. prefixing the path) | not auto-detected | a pin test (below) fails; the change must bump a `RECIPE` constant folded into `ekey` |
| `ekey` NULL (migrated vector, non-default model) | NULL != current key | treated as stale: re-embedded once, the write stores the current `ekey`, never repeats |
| Stamp bump (release) | not a cause | vectors kept. If a future stamp bump needs vectors dropped, it must also change `ekey` |

## What `force:true` means

`force` means "re-read and re-chunk every file". It does not mean "re-embed". Vectors are kept when valid.
A separate opt `index({force:true, reembed:true})` is added, only to drop all file vectors on purpose (the current
behaviour). Without a real caller this is speculative; ship it only if the owner wants it (decision 2).

## Interactions

- Per-node stamp self-heal: a stale-stamped file is re-chunked via the sentinel `hash:""` (src/index.js:464-467); it
  reaches the upsert with its real `u.hash`, so the same reuse rule applies. No change to the stamps or to when they are
  set. A partial pass still never clears (`partial`, :429) and still does not set the stored stamp.
- clearAll in one transaction: unchanged. Reuse happens inside the same `tx`, so a reader sees the old complete index
  (old vectors included) or the new one (reused vectors included), never an empty one. Stop at the final orphan sweep
  inside that `tx`, not after it.
- `doc_sections`: covered above. The section rows get new `doc_rowid`s on rebuild, so vectors are re-attached by
  text, never by rowid.
- `mem_embeddings`: untouched. Written docs and facts keep their own table and their own ladder.
- Drift guard (src/index.js:535-543): unchanged. It guards against embedding bytes that differ from the indexed ones.

## Migration

- Schema: column-additive `ALTER TABLE ... ADD COLUMN th TEXT, ekey TEXT` on `file_embeddings` and `doc_sections`,
  in the same migration block as `nodes.stamp` (store.js:409-414). No new table, no data copy.
- Existing vectors have `th`/`ekey` NULL. Option A (recommended, decision 1): fill them from known facts. For files
  `th` = `file_index.content_hash`; for sections `th` = sha256 of that one section's own `nodes.body` (exactly what the backfill embeds, `vectorlessSections` store.js:1897 and src/index.js:570; the same definition as design point 1, never the joined body of the file); `ekey` = the current key
  only when the instance runs the default model, else leave NULL. A NULL `ekey` is never the current key, so it counts
  as stale: re-embedded once, and that write stores the current `ekey`, so it does not repeat. Option B: treat NULL as stale and re-embed once
  (67 s/497 files, one time, safe but it recreates the gap once after upgrade).
- This change touches `src/store.js`, which changes `indexStamp`, so the first run after upgrade is itself a stamp
  rebuild. With Option A it keeps its vectors; that is the first real test of the feature.

## POC first (about 15 min, throwaway, in the scratchpad)

Riskiest assumption: re-attaching a vector by `th` after a full rebuild gives the same ranking, and reuse is a real
saving. Copy a repo with embeddings on (stub embedder with a call counter and a deterministic hash-based vector, then
once with the real model on the litectx repo). Run `index()`, record `recall` top-10 for 20 queries; run
`index({force:true})` with the vector-keep patched in a scratch copy of store.js; record again and count embed calls.
Pass: rankings identical, embed calls 0 on an unchanged tree, N on N edited files. Fail on the identical-ranking check
means the section re-attach by text is wrong (duplicate section texts in one file: check they share a vector safely;
two equal texts embed to equal vectors, so this should hold).

## Test plan (each can fail)

1. Before/during/after ranking (the ledger's repro): index with a stub embedder where a.js and b.js ordering depends on
   cosine; capture top-N; run `index({force:true})` with an injected stub embedder (as test/embeddings.test.js does)
   whose `embed` wraps the stub and, on its first call during the pass, runs `recall` and records the ranking
   (no new hook is needed: the backfill awaits `embed`, so the recall runs mid-phase). Assert before == during == after. Fails today (during is BM25-only).
2. Embed-call count: unchanged tree, `force:true` and a forced stale stamp (`setStoredStamp(1)`) each give
   `embedded === 0` and zero embedder calls. Edit one file: exactly one new file vector, other vectors byte-identical.
3. Sections: an md file with 3 sections; edit one. After a force pass, 1 section re-embeds, 2 are kept byte-for-byte,
   and every `doc_sections` row points at its current `node_id`.
4. Invalidation: construct with a different `embedModel` (stub reporting another id) on an embedded index; assert recall
   ignores the old vectors, the backfill re-embeds all, and cosines are never computed across two keys.
   A NULL `ekey` under a non-default model (migration) is treated as stale: re-embedded once, and the re-embed writes
   the current `ekey`, so the second pass embeds nothing. (`HEAD_CHARS` is a module const with no seam and needs none:
   it is part of `src/embedder.js`, so a change to it changes the source hash in `ekey`, the case this test covers.)
5. Orphans: delete a file on disk, run `force:true`; assert its `file_embeddings` row is gone (mutation target: remove the
   orphan sweep, test must go red).
6. Reader isolation: a second connection reads during the rebuild transaction; it sees the full old index with vectors.
7. TOCTOU: change a file between embed and write; the conditional write stores nothing; the next pass embeds it.
8. Recipe pin: assert the backfill's embed input equals the file body (and the section's `nodes.body`) exactly, so any
   input change forces a deliberate `RECIPE` bump.
9. Scoped force (`force:true, paths`) keeps vectors outside the scope (regression of the 0.31.1 footgun).

Mutation checks (revert each, expect the named test red): keep-vector condition ignores `th` (test 2/3 stale vector
survives an edit); key check dropped (test 4); orphan sweep removed (test 5); reuse keyed by `doc_rowid` instead of text
(test 3). Also reintroduce the old `DELETE FROM file_embeddings` and confirm test 1 goes red.

## Acceptance bars

- Test 1 passes: identical top-N before, during, after, on at least 4 queries over a repo with 2 or more md files.
- Unchanged-tree force and stamp rebuilds: 0 embedder calls; wall time of the embed phase under 1 s on 497 files.
- Edited-file case: embedder calls equal edited files (or edited sections), not more.
- Full suite green, `tsc --noEmit` clean, `check:primitives` unchanged, benches byte-identical with embeddings off.
- A fresh-tarball drive (library and CLI) on an embedded index: `index --force` reports `embedded: 0`, recall unchanged.
- Docs updated together: `litectx.context.md` (the `embedded`/`embedPending` lines, :235-236, and what `force` does to
  vectors), CHANGELOG, JSDoc at src/index.js:258-260, this spec marked shipped. Grep to confirm.

## Ship condition (un-defer)

Ship when the owner approves the three decisions below AND the POC passes its identical-ranking and zero-embed-call
checks on the real model. It stays a tracked fix (not deferred) because the regression is user-visible after every
release for anyone on the default-ON warm-index with embeddings. Drop the idea and instead document "BM25-only
during rebuild" only if the POC shows the reuse changes ranking or a schema migration cannot be made additive.

## Open decisions for the owner

1. Existing vectors with no `th`/`ekey`: backfill the columns (A, recommended) or re-embed once (B).
2. Add a `reembed` opt, or ship without it (recommended: without; `rm .litectx/index.db` covers the rare case).
3. Injected embedders have no model id: require an optional `embedder.id` (recommended; absent means key `custom`,
   so swapping one custom embedder for another is not detected and is documented), or always trust.
