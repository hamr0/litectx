# Stash: Slice 9 shipped (get(id) body access + tagged fetch logging) · force-reindex data-loss FIXED · committed & pushed

**Date:** 2026-06-10 (third stash today; continues `2026-06-10-slice8-chunk-granular-recall-log-false-capture-mechanics-settled.md`)
**State:** CLEAN — committed and pushed. `main` @ `46a52c3` (slice 9, one commit: code + tests + docs).
98/98 tests · `tsc` clean · all three bench gates **diff-verified byte-identical against HEAD**
(not quoted from memory — see validation notes below).

---

## What shipped this session

### Slice 9 — `get(id)` body access + tagged fetch logging (commit `46a52c3`)
User's design calls, verbatim: **"any id"** · **"consolidate where possible"** · **"simpler > clever"**.

- **`ctx.get(id, { log? })`** — the read counterpart to recall (pointers → the thing itself); the
  MCP prerequisite (a recall tool returning fact ids with no way to read their text is useless).
  Sync (no embedder). Returns `{ id, kind, format, source, provenance, occurredAt, text } | null`.
- **Any id:** a written-memory id → text **VERBATIM** via the new **`mem_text(path, text)`** table.
  This was the slice's wrinkle: the FTS body is the processed *searchable surface* (`indexBody`
  folds doubled path tokens + camel parts) and a written row has no file behind it — raw text was
  otherwise **unrecoverable**. FTS5 can't `ALTER ADD COLUMN`, so a plain side table beat a hairy
  rebuild-migration (simpler > clever). A file path → read **fresh from disk** (the index is not a
  file cache; `text: null` only when the file vanished since last `index()`).
- **No migration needed — grounded:** published `0.1.0` (npm registry checked live) ships the read
  surface only; the write path is `[Unreleased]`. Only this repo's own dev dbs can hold pre-slice-9
  written rows; those degrade to the stored FTS body on `get` (preserved, documented, never null).
- **Fetch-toll lands as designed (§14 #4):** `recall_log` gained **`action`** ('recall'|'fetch') —
  consolidated same-table per user, no second log. Demand readers (`recallCount`,
  `reviewCandidates`) filter `action='recall'`: a fetch is mechanically coupled to the recall that
  produced the id → counting it double-counts demand. Tagged weak signal, scored only if the
  action-signal bench ever admits it. `get(id, { log: false })` = same opt-out contract as recall.
- **Self-heal extended additively:** `ALTER` adds `action` (pre-existing rows are all real recalls,
  so the `'recall'` default is the true value). Collision rule: written row wins an id/file-path
  clash (ids namespaced by convention); probed live.
- **CLI:** `litectx get <id>` — metadata → stderr, body → stdout (pipes clean), exit 1 on unknown
  id and on indexed-but-vanished files. (CLI has NO `--no-log` flag yet — deliberate; folds into
  the MCP/CLI parity slice where dashboards become a real audience.)

### FIX — `index({ force: true })` destroyed ALL written memory (pre-existing, slice-7-era)
Found by the validation round (live probe), **reproduced at HEAD in an isolated worktree** to prove
it pre-dates slice 9: fact recallable 1 → 0 across a force pass. `force` called `Store.reset()` —
scorched earth — deleting every fact/episode/direct doc, raw text, embeddings, and the whole recall
log, violating §3.2's documented "survives every `index()` pass" AND the store's own "only ever
drop re-indexable data" rule. **Fix:** force now calls new **`Store.clearIndexed()`** — drops
file-sourced data only (`docs` source='file', `file_index`, `nodes`, `edges`, `git_sig`, embeddings
scoped by `file_index` keys — written rows are never in `file_index`, so written embeddings
survive structurally). `mem`/`mem_text`/direct docs/`recall_log` (append-only demand history) all
survive. `reset()` remains for the ≤0.1.0 self-heal, where nothing unrecoverable can exist.
Regression test pins row + raw text + embedding + demand history across force.

---

## Validation (user pushed twice: "validate", then "ground your answers, no handwaving")

Round 2 method — **git HEAD (`3047bea`) as ground truth, isolated worktree** (`git worktree add` +
symlinked node_modules):
- **Scope purity:** every deleted source line vs HEAD was one slice 9 legitimately replaced;
  `typeof ctx.get` at HEAD = `undefined`; `mem_text` absent at HEAD. One earlier-slice item in the
  diff, transparent: context.md's status table had NO slice-8 row (verified `git show HEAD:`) — back-filled it.
- **Counts counted, not asserted:** per-file `grep -c '^test('` — HEAD 87 (suite run in worktree:
  87/87), now 98 (= +10 get.test.js, +1 force regression in memory.test.js; other files identical).
- **Gates:** all three benches run in BOTH trees, outputs diffed → 47 gate lines each, identical.
  ⚠ **My first diff was invalid** — `cd worktree && benchA > head.txt; benchB > now.txt` ran BOTH
  in the worktree (compound command; cwd reset happens per Bash call, not per statement). Caught it,
  redid with per-directory subshells. Lesson: HEAD-vs-now comparisons need explicit dirs per side.
- **My own test failed twice on the way in** (wrong fixture file count copied from another test
  file; miscounted demand rows) — both test bugs, fixed so the counts prove the right thing.
- **Doc imprecision fixed:** CHANGELOG Added claimed "+11" but 1 test belongs to the Fixed entry →
  now "+10 here, +1 with the fix below".
- Live probes: verbatim round-trip on the real repo, collision precedence, CLI piping/exit codes,
  fetch excluded from demand + from reviewCandidates, path traversal structurally safe (disk reads
  only for ids already in the index), `.d.ts` exports `Item`.

## Known non-blocking (deliberate, recorded)
1. **`getItem` = linear FTS5 scan** on unindexed `path` (~0.4ms @ 83 files). Fine at lite scale;
   revisit only if 100k-file repos matter (could route file lookups via `file_index` PK).
2. **CLI lacks `log:false` flags** (recall + get) — belongs to the MCP/CLI parity slice.
3. **Pre-slice-9 dev dbs** degrade `get` to FTS body — by design, documented.

## Docs state (all synced, in the commit)
PRD (§3.3 now "seven operations", Table 2 has `get` row + fetch-toll; §11.2 slice-9 entry incl.
validation finding; §15 heading slices 0–9 + item 3 struck) · CHANGELOG (slice 9 Added + new
**Fixed** section) · litectx.context.md (header slices 0–9, status table +slice-8-backfill+slice-9
rows, `get` API section, Item shape, gotchas: recall+get write / get-reads-disk / force-survival
added to the §3.2 seam paragraph) · README (98 tests, get in status + quickstart) · project memory
(`slice7-write-path.md` + MEMORY.md index updated).

## Next builds (user-confirmed order, PRD §15)
1. **MCP/CLI parity** (§14 #5) — separate `litectx-mcp` pkg (stdio, client-spawned, NOT a daemon);
   tools: index/recall/impact/remember/forget/get; CLI gains `remember` + `--embeddings` +
   `--no-log` flags (known item 2 folds in).
2. **Access-log tier** (§4, §14 #4 SETTLED) — edit-bind (harvest-at-recall) + corrective
   re-remember; episodes-first; trust-weighting; **requires the action-signal bench first (the
   biggest IOU)** — every signal type earns weight there or ships at zero; activation re-ranks,
   never gates. The `action` column is now the join key for grading fetch vs recall vs (future)
   edit signals.

## Session lessons (meta)
- The live-probe rule paid out a third time: fixtures + 97 green tests said done; one probe of
  `index({force:true})` against the documented contract found silent total data loss. **Probe the
  CONTRACTS (docs' promises), not just the features.**
- When the user says "ground it": make HEAD the ground truth — worktree + run the old suite +
  reproduce the bug there + diff actual outputs. "Byte-identical" is a diff, not a recollection.
- Compound `cd X && a; b` in this harness: `b` still runs in X (cwd resets per tool call, not per
  statement) — my "HEAD vs now" diff silently compared HEAD to itself until caught.
