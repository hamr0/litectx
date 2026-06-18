# multis M3 ingest ask (R0–R5) — built, security-reviewed, shipped 0.17.0; pdfjs range fixed in 0.17.1

**Date:** 2026-06-18 · **Branch:** main · **Heads:** `5ef9dcb` (0.17.0 release) → `38e8eac` (chore: memory/stash/friction sync) → `11af277` (0.17.1 pdfjs range) · all pushed · **tree CLEAN**
**Published:** `litectx@0.17.1` live on npm (`latest`), verified end-state.
**Ask:** `~/Documents/PycharmProjects/multis/docs/01-product/litectx-asks/doc-ingest-pdf-docx.md` (multis M3 — replace `src/indexer/*` with litectx). Rewritten mid-session from "parse PDF/DOCX" to a 5-requirement ingest rule.

## Outcome — R0–R5 SHIPPED + the cosmetic peer-range bug found & fixed

`ctx.ingest(buffer, opts)` is the unified third ingest path (supersedes the **unreleased** `ingestDocument` — renamed, no migration). Routed by filename extension:
- **md / pdf / docx → chunkable** (`mode:"chunked"`): convert→md→segments, `source='direct'` doc rows, `format` under `kind='doc'`, survive `index()`. (md buffer = user's "md too, cheap" — reuses `segmentsFromMarkdown`; **code buffers are NOT chunked** by ingest → they fall to blob; body-search for code stays the repo-`index()` opt-in.)
- **everything else (csv/xlsx/xml/code/binary) → byte-exact BLOB** (`mode:"blob"`, `chunks:0`): bytes stored verbatim in a SQLite `BLOB`, **filename-only** FTS body (never parsed/chunked), `get(id).bytes` returns originals.

**R2 scope** fences BOTH `recall({scope})` AND `get(id,{scope})` → `scope ∪ null-global`, never another scope. **Bare `get(id)` unchanged** (unfenced by id; owner/session fact model untouched — opt-in stricter check = threat-model-justified asymmetry). **R5 `expiresAt`** excluded from recall/get once past + `ctx.purge({now?})` reclaims storage (incl. blob bytes). **R4** bounds intact (`maxSize` also caps blobs).

## Architecture / decisions (POC-first, per user)
- **POC `poc/doc-store-scope-poc.mjs`** (14/14 incl. negative controls) de-risked the 3 new surfaces BEFORE building: BLOB byte-exact round-trip (control: TEXT mangles real .wasm + random bytes → BLOB load-bearing), filename-only recall (no body leak), `scope ∪ null` fence, expiry+purge. Shipped code reproduces it (validate-shipped-vs-POC).
- **Schema (additive, no migration; old DBs gain empty tables, LEFT-JOIN-NULL = byte-identical):** `doc_scope(path PK, scope, expires_at)` sidecar (per-upload tags — distinct from `mem_scope` which is instance owner/session on fact/episode) + `blobs(path PK, bytes BLOB, filename)`.
- **Scope is a NEW axis, not `owner`** — per-upload (chat id), query-filtered; `owner`/`session` stay instance-level fact/episode scoping.
- A blob = a direct `doc` row whose FTS body is just the filename + bytes in `blobs`. `kind=doc`, `format`=ext (capped `^[a-z0-9]{1,16}$` else `bin`).

## Files (src)
- `src/docparse.js`: `classifyDocument(filename,explicit)→{mode,format}` (single routing source; replaced `detectFormat`/`FORMAT_BY_EXT`), `documentToSegments` generalized (md branch), `DEFAULT_MAX_SIZE` exported.
- `src/store.js`: 2 tables + `doc_scope_expires` index; `setDocScope`, `writeBlob`, `purge(now)`; scope+expiry filter in `search()` docs branch; `getItem(id, now, scope)` (expiry + handle-fence + blob bytes); `forgetMemory` cascades doc_scope+blobs.
- `src/index.js`: `ingest()` (replaces ingestDocument) + `purge()`; `recall({scope})`; `get(id,{scope})` returns `bytes`+honors expiry/scope; `remember` threads scope/expiresAt; `Item.bytes` added.
- `src/memory-store.js`: one-line comment — text-KV view deliberately doesn't surface blob bytes.
- Tests: `test/docstore.test.js` (14, all ACs + get-fencing) + `test/docingest.test.js` (renamed calls/titles; test-60 now "unknown ext → blob"). Fixtures: `test/fixtures/doc-ingest/{notes.md,sales.csv,sales.xlsx,logo.png}` (last two real binaries). **289 tests, 288 pass, 1 pre-existing skip, tsc clean.**
- Docs propagated: README, litectx.context.md, CHANGELOG, memory-prd. CE-PRD/baresuite-PRD correctly untouched (no ingest refs — boundary docs).

## Security review (`/security`) — found R2 was INCOMPLETE, not a separate bug
- Finding: `get(id)` wasn't scope-fenced; derived ids are guessable (slug of filename) → cross-scope read. User reframe: fencing discovery without the handle doesn't deliver "one customer never sees another's." **Fixed = Option 3:** `get(id,{scope})` enforcement (optional param, backward-compatible) + namespace-ids guidance as defense-in-depth. **multis obligation (their lane):** always pass scope to BOTH recall and get on customer-reachable paths; never expose a bare `get(id)`; namespace ids per scope.
- Clean: SQL all bound-param; no path traversal (blobs are `source='direct'`, never hit `readFileSync`); no orphaned bytes (forget+purge cascade); no new deps.

## diff-review (`/diff-review`) — 3 items, all resolved
- **writeGate/blob asymmetry** → documented (option a): gate screens *text* for injection-risk; blob bytes are opaque & never reach an LLM except via the gated convert→md route. Blobs intentionally ungated; screen at call site + egress-trust. (multis doctrine: injection=log-only, scope=hard boundary.)
- memory-store adapter drops blob bytes → one-line comment. Format tag → capped. No bugs/dead-code/loose-ends.

## The 0.17.1 fix (post-publish, this session's tail)
- multis (pdfjs-dist@5.x) hit a `peerOptional` conflict: 0.17.0 declared `pdfjs-dist@^4.0.0`. **Why `^4`:** conservative pin to the tested major (root devDep 4.10.38, the CVE-2024-4367-patched line). **Proven COSMETIC:** ran litectx's exact extraction path against 4.x/5.7.284/6.0.227 on a real PDF → **byte-identical** (same sha256 d870436f…). Widened peer to `^4.0.0 || ^5.0.0 || ^6.0.0` (claim only verified majors; devDep stays ^4 so CI tests the floor). 0.17.0→0.17.1, republished, verified live.

## Open / not-mine (multis lane)
- multis runs full AC validation against installed 0.17.1 (in progress on their side), then deletes `src/indexer/{parsers,chunker,chunk,store}.js`.
- multis ask-doc was edited by me (R2→recall+get, AC 3b, obligations) and is **committed in the multis repo** (`01585f4`); multis has other uncommitted M3 work (handlers.js, tests — 519/519 green) that is the USER's to commit. **Do NOT commit multis's unreviewed code.**
- Known edge (flagged, not blocking): `deriveDocId` strips extension → `data.csv`/`data.xlsx` collide on derived id; multis passes explicit chat-scoped ids.

## Working-style reinforced
- POC-first the riskiest/newest surface with negative controls (test must be able to fail). Replay POC data through shipped code. Verify-before-done (ran tsc+suite+registry end-state each gate).
- Stage ONLY changed files (shared `~/PycharmProjects` ↔ `~/Documents/PycharmProjects` clones; excluded pre-modified CLAUDE.md/.claude until user said "commit all").
- Publish = manual OIDC `gh workflow run publish.yml` + verify on registry; never local `npm publish`; docs/dep change still needs a version bump. main push warns (advisory protection) but succeeds.
- A finding can mean "the requirement is incomplete," not "scope creep" — finishing it is correct (R2 get-fence). Don't `--force` past a peer conflict — investigate cosmetic-vs-real first.
