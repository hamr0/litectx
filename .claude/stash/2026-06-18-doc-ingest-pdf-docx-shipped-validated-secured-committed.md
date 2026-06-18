# Document ingest (PDF/DOCX) — POC'd, built, validated, secured, committed

**Date:** 2026-06-18 · **Branch:** main · **Head:** `79b695d` (pushed)
**Ask:** `~/Documents/PycharmProjects/multis/docs/01-product/litectx-asks/doc-ingest-pdf-docx.md` (multis M3, the chat-upload "query your documents" flow).

## Outcome — SHIPPED on main (not yet versioned/published)
`ctx.ingestDocument(buffer, opts?)` — the third ingest path (distinct from `index()` file-sweep and `remember()` whole-store). Converts PDF/DOCX bytes → markdown → segments → N `source='direct'` doc rows. Ranks alongside `md`, carries reserved `format: "pdf"|"docx"` under `kind=doc` (no schema migration), survives `index()`. Full suite green (274 pass / 1 pre-existing skip), typecheck clean.

**Not done (user's call, deliberately left):** version bump → 0.17.0 + OIDC publish (`gh workflow run publish.yml`); CE-PRD / baresuite-PRD untouched (boundary docs, capability is litectx-internal).

## Architecture decisions (all POC-validated before building — user insisted "poc first" twice)
- **Convert→md→reuse chunker** (ask §3.1 crux). DOCX (mammoth `convertToMarkdown`) keeps `#` headings → existing md chunker, one section/segment. PDF (pdfjs `getTextContent`) is FLAT text.
- **Headless-PDF problem:** pdfjs emits ZERO blank lines and `chunkMarkdown` only splits on `#` headings → a PDF would be ONE giant chunk. **Fix = reconstruct paragraphs from the VERTICAL GAP between lines** (pdfjs `transform[5]` y-pos; break when gap > 1.5× the page's median leading, or page change). Median-relative → font-size independent. Gap histogram proved clean separation (leading 13.8 vs para-breaks 21–28 vs heading 43).
- **Packing (user-refined twice):** pack WHOLE paragraphs UNDER an 800-char soft cap, **round-down only, NEVER split a paragraph or word**. The one over-cap exception: a lone paragraph >800 rides whole (truncation is worse). 800 = POC sweet spot (500 fragments, 1200 drops coverage); **internal constant, NO config lever** (user's explicit call — presets unnecessary; trip-wire to expose `chunkChars` only when a real corpus mis-granulates).
- **Storage = N direct doc rows** (ids `<base>#0,#1,…`) via existing `remember(kind:'doc')` path — zero new store surface. Recall gates on `docs` then localizes to `nodes`; a direct row has no nodes so "the row IS the unit" → one whole-doc row would re-blob, hence N rows.
- **Optional deps:** `pdfjs-dist` + `mammoth` as `peerDependenciesMeta.optional` (mirror `@huggingface/transformers`), lazy-imported on first ingest (verified 0 eager loads). `npm i litectx` stays lean/offline.

## Files
- `src/docparse.js` (NEW) — `documentToSegments()` (exported, used by index.js) + internals (detectFormat now un-exported, reconstructParagraphs, packSegments, pdfToParagraphs, docxToMarkdown, segmentsFromMarkdown, mapParseError).
- `src/index.js` — `ingestDocument()` method + `deriveDocId()` helper + import.
- `src/store.js` — `forgetMemory({ idPrefix })` selector (clean re-ingest upsert; bound params + `LIKE … ESCAPE '\\'`).
- `test/docingest.test.js` (14 tests) + `test/fixtures/doc-ingest/` (real LibreOffice/ImageMagick: report.pdf/docx, scan.pdf, encrypted.pdf, multipage.pdf 14pg, bigpara.pdf 1105-char single para).
- `poc/doc-ingest-poc.mjs`, `doc-chunk-split-poc.mjs`, `doc-para-chunk-poc.mjs`, `doc-ingest-bounds-poc.mjs` (committed, convention).
- Docs: CHANGELOG `[Unreleased]` (+Security), litectx.context.md (full API + deployment-security note), litectx-memory-prd.md §3.1 deferred→SHIPPED + §13 non-goal struck, README "What's inside" Memory row.

## Validation caught 2 real bugs (the "validate what you deliver" payoff)
1. **pdfjs rejects Node Buffer** — demands plain `Uint8Array` (`bytes.constructor === Uint8Array ? bytes : new Uint8Array(bytes)`).
2. **`setTimeout`-race timeout was security theater** — probe showed a 20–45ms parse never tripping a 1ms timer (pdfjs is microtask/CPU-bound; a timer macrotask can't preempt it). Replaced with a **per-page** wall-clock check between pages. Honest limit documented: a single CPU-bound page is bounded by maxSize/maxPages, not the timer (needs a worker thread; out of scope).

## Security (ran /security + /diff-review)
- npm audit 0 vulns; no secrets/.env; SQL bound-param safe; no path traversal (ingest writes only SQLite, id is a key); regexes linear (no ReDoS); ingest is library-only (not in bin/ CLI/MCP).
- **Hardening applied:** `isEvalSupported:false` + scripting/XFA off (CVE-2024-4367 pdf.js font-path RCE class; pdfjs 4.10.38 already patched), `useSystemFonts:false` (no local font enum). **XXE probed inert** — `@xmldom@0.8.13` does NOT resolve external entities (`file://` SYSTEM entity → "entity not found").
- **Residual (deployment-shaped, documented, NOT auto-changed):** (1) maxSize bounds INPUT bytes not decompressed size (zip/stream bomb) — keep cap conservative + memory-limit the host; (2) CPU-bound parse blocks event loop — run hostile input in a worker thread. Offered to lower default maxSize or ship a worker wrapper — user didn't take it.
- **diff-review cleanups applied:** un-exported unused `detectFormat`; collapsed `loadMammoth` double `import()`; no-text guard `join("").trim()` → `some(s=>s.trim())` (avoid multi-MB alloc).

## Open / flagged (not blocking)
- **Per-segment write + wired `writeGate`** can leave a partial doc (forget-old-then-write, a middle deny). Inert today (no consumer gates ingest). Fix is multi-shape (gate-once vs transactional) → asked, user didn't pick.
- DOCX-with-long-section still yields one big segment (reuse-the-md-chunker contract; same as `.md` files) — consistent, not a regression.

## User working-style reinforced this session
- POC-first the riskiest assumption; prove-don't-assert (negative controls, probe real data before setting thresholds — e.g. peeked the gap histogram before picking 1.5×).
- Validate-what-you-deliver replays real data through SHIPPED code (caught the 2 bugs).
- Lean doctrine: no speculative config (800 stays a constant, not a lever; presets rejected).
- Stage ONLY changed files (shared parallel clones) — excluded pre-modified CLAUDE.md + .claude/. Commit/push only when asked; main is direct-push (advisory protection bypassed).
