# Stash — litectx R-C7 `compress()` SHIPPED + 3 overclaims corrected + v0.7.0 cut/tagged/pushed (2026-06-12)

- **Date:** 2026-06-12
- **Repo:** `/home/hamr/PycharmProjects/litectx` (`~/Documents/PycharmProjects` = symlink to `~/PycharmProjects`, same tree). Branch `main`.
- **HEAD:** `f13c5d2`. **All pushed** to `github.com/hamr0/litectx` (push reports "Bypassed rule violations" for main PR-protection — user has bypass, normal). **Tag `v0.7.0` pushed.**
- **Working tree:** CLEAN, in sync with origin/main.
- **Gates (re-validated multiple times this session):** **162 tests** (161 pass / 1 skip = absent optional dep) via `npm test` (= `node --test`, NOT vitest despite CLAUDE.md) · `npx tsc --noEmit` clean · `npm run build:types` clean. `src/store.js` has a NUL byte ~line 248 → use Read/node-scan, NOT grep, on store.js.

---

## The task this session (user: "do 1, 3 then build #2", then docs, then release)

Continued from the prior stash's 3 open decisions:
1. **Correct the record** — the chunker doc-attachment fix was sold on a "recall localization 0/2→2/2" win that was false on real code.
2. **Build `compress()`** (R-C7).
3. **Measure** the unverified "doc-with-symbol helps embeddings" claim.

Executed in order **1, 3, 2**, then "changelog/prd/readme/context + validate", then "commit and push", then **cut v0.7.0**.

---

## ✅ DELIVERED (commits, in order)

- **`4f65bf5` docs: correct the chunker record.** The chunker fix (attach a symbol's leading doc-comment to its chunk, commit `aa1d51e` last session) has ONE justification: it feeds `compress()`'s doc tier. **It does NOT improve recall.** Corrected CHANGELOG, CE PRD §8.1, memory PRD §2, the crafted bench header, and the auto-memory.
- **`ab1f56f` feat(compress): R-C7 rank-tiered render.** `compress(node, { level })` → `verbatim` | `signature` | `drop`. Pure library export (`import { compress, COMPRESS_LEVELS }`), NOT a `ctx` method, NOT MCP (library/orchestration verb like stash/peek). 16 tests.
- **`d0f27a6` docs: surface compress() in README/CHANGELOG/PRD; test count → 162.**
- **`b18a79f` docs(readme): surface stash/peek/compress in the status NOTE.**
- **`ba1a62c` docs(stash): prior session history.**
- **`f13c5d2` chore(release): v0.7.0** — bumped package.json + package-lock to 0.7.0, dated CHANGELOG `[0.7.0] — 2026-06-12`, flipped README status line, tagged `v0.7.0`.

---

## ⚠️ THREE OVERCLAIMS CAUGHT THIS SESSION (the prove-don't-assert pattern, again)

All three are now codified as instances in memory `prove-dont-assert.md`:
1. **Crafted-bench bias (lexical recall):** the "0/2→2/2" came from doc-EXCLUSIVE sentinel queries. On real OpenSpec TS the chunker fix changed localization **0/3**. A bench rigged to need the thing you're testing proves nothing.
2. **Query-source bias (semantic recall, decision #3):** measured with doc-DERIVED queries → +0.248 MRR (looks great); the FAIR name-derived query → **−0.003 MRR (a wash)**. Always bracket a measurement with an input source NOT coupled to the hypothesis; report the fair number, label the biased one an upper bound. POC: `poc/rc7-doc-embed-poc.mjs` (229 real symbols). Plus the shipping embeddings tier is file-level → no-op anyway. **Claim dropped.**
3. **Silent-skip denominator (compress savings + the bug):** the sig POC did `if (ts==null) continue`, dropping **~38% of symbols** (METHODS don't parse standalone — `method_definition` only valid inside a class), inflating "99% clean / 95–98% savings." **This was a real bug AND an overclaim.** Fixed (see below). Honest shipped number: **~82% (81.7%) on 627 real symbols, 0 unparseable.**

---

## compress() — how it's built (so you don't re-derive)

- **`src/compress.js`** = thin level switch. `verbatim`→text; `signature`→`signatureOf(...).signature ?? text` (lossless verbatim fallback for md/preamble/unparseable); `drop`→`"name …"` (name from `node.symbol` else parsed). Unknown level throws. Exports `compress` + `COMPRESS_LEVELS = ["verbatim","signature","drop"]`. Re-exported from `index.js`.
- **`signatureOf(format, body)` lives in `src/chunker.js`** (with the other tree-sitter primitives `analyzeBody`/`callSitesOf`), reusing the module-private `parserFor`. Returns `{ name, signature } | null`.
  - Signature = header sliced from chunk start (AFTER the leading doc) to the def's `body` field → keeps `export`/`async`/decorators/generics/multiline params (they sit OUTSIDE the inner def node, between doc and body). Naive line-slice was 32% vs tree-sitter 99% (POC).
  - **JS/TS:** leading JSDoc/line-comment stripped via regex then re-prepended ABOVE the header (strips the connecting newline with `/^[ \t]*\n+/`). **Python:** docstring is the first in-body string statement, re-attached BELOW the header.
  - **THE non-obvious fix — `locateDef`:** a bare method chunk can't parse standalone, so on a miss it re-parses inside a synthetic `class ɵW {…}` (JS/TS) / `class ɵW:` (Python, method keeps its indent → valid suite) wrapper, descends past the wrapper class, and maps offsets back by `-pre.length`.
- **`node` contract:** `{ text, format?, symbol? }`. `text` = chunk body; `format` needed for signature/drop; `symbol` improves drop marker. Caller gets `text` from a recall hit by slicing `get(hit.path).text` to `hit.chunk.{startLine,endLine}` (0-based inclusive); `format` = `hit.format`. (recall/`nodesForPath` give the line range, NOT the text.)
- **Tests:** `test/compress.test.js` (16) incl. standalone method chunks (JS + PY) — the gap that hid the method bug.

## Node version note
- `node --test` foreground is fine; the embeddings POC needs `@huggingface/transformers` (DEP PRESENT in this env). Pin is dtype `q8` (embedder.js).

---

## Files this session

- **src (committed):** `src/compress.js` (new), `src/chunker.js` (+`signatureOf`/`locateDef`/`firstDef`), `src/index.js` (re-export).
- **tests (committed):** `test/compress.test.js` (new, 16).
- **POCs (committed):** `poc/rc7-doc-embed-poc.mjs` (new — the bracketed embeddings measurement), `poc/rc7-compress-sig-poc.mjs` (+caveat about the silent-skip), `poc/rc7-compress-real-poc.mjs` (+caveat about inflated ratio + corrected recall/embeddings framing), `poc/rc7-doc-localize-poc.mjs` (+RETRACTED caveat).
- **docs (committed):** CHANGELOG, README, `litectx.context.md` (new `compress()` section + status row + named export), CE PRD `litectx-ce-prd.md` (R-C7 → SHIPPED in 3 places: req table L135, build-order table L237, current-pick L259; ~82% everywhere), memory PRD `litectx-memory-prd.md` (§2 chunker note), `aurora-borrow-ledger.md` (§13.1 ~82% + method-wrap).
- **package (committed in release):** `package.json` + `package-lock.json` → 0.7.0.

## Memory written/updated
- `slice-rc7-compress-shipped.md` (NEW — full compress() record). Index updated in `MEMORY.md`.
- `chunker-orphans-leading-docs.md` (rewritten — sole justification = compress; recall NOT improved, lexical 0/3 + semantic −0.003).
- `prove-dont-assert.md` (+3 new instances + 2 new how-to-apply rules: bracket measurements, never `continue` past hard cases without counting).

---

## OUTSTANDING / what's next

- **npm publish NOT done** — it's the manual OIDC workflow_dispatch (per `slice7-write-path` memory). v0.7.0 is cut+tagged+pushed but NOT on npm. User's trigger.
- **Next build pick (discussed, NOT started):** next **Tier-A CE primitive** per CE PRD §8.1 — `evict` / `quality` / `supersede`. Each needs its own POC-first scoping (which one + what shape its data fixes). User wants to **brainstorm the pick** before coding (lead with prose + the 3 candidates per [[prefers-discussion-over-multiple-choice]]).
- **`assemble()`** (Tier-B linchpin that compress de-risks) stays DEFERRED — adoption-pulled by doctrine (its intent/budget shape needs a real consumer), do NOT build speculatively.
- **Roadmap remainders (all trigger-gated):** persist call edges, edge-confidence, jina-code model, graph accessors (`getNode`/`related`).

## Carry-forward gotchas
- Push to `main` bypasses PR-protection (user has bypass) — every push says "Bypassed rule violations". Normal.
- `store.js` NUL byte ~L248 → Read/node-scan, not grep.
- Test runner = `node --test` via `npm test` (NOT vitest, despite CLAUDE.md).
- The ~82% compress figure KEEPS THE DOC (signature+docstring). Don't restate "95–98%" — that was the inflated number.
