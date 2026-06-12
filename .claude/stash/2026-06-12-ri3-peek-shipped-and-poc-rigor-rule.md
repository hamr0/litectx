# Stash — litectx: R-I3 `peek()` SHIPPED + pushed · POC-rigor rule added to AGENT_RULES org-wide (2026-06-12)

- **Date:** 2026-06-12
- **Repo:** `/home/hamr/PycharmProjects/litectx` (`~/Documents/PycharmProjects` is a **symlink** to `~/PycharmProjects` — same tree). Branch `main`.
- **litectx HEAD:** `5aa6fc6` — *"feat: peek() — head+tail lazy-load preview of a stash (R-I3) + consumption-surface doctrine"*. **Pushed** (bypassed the main PR-protection rule, as usual — user has bypass rights).
- **Version:** `0.6.1` (published, live on npm). `peek` is **unreleased** (CHANGELOG `[Unreleased]`; minor bump when next cut). 144 tests (143 pass / 1 skip / 0 fail), tsc clean, types build clean.
- **Working tree:** only `.claude/memory/AGENT_RULES.md` modified (the org-wide POC-rigor edit — **uncommitted in litectx**; see below) + the two prior-session stashes untracked + this stash.

---

## Headline outcomes this session (in order)

1. **Consumption-surface doctrine settled (CE PRD §10.5, NEW).** The question "MCP vs direct API for agent verbs" resolved by a single discriminator: **who *chooses* the call — code or a model?** Code→`import` (strictly better: types, in-process, no serialization). Model→MCP (a toolbox for an LLM; does NOT ease program consumption). Two relationships: baresuite **imports** litectx for its own loop AND **mounts litectx's MCP** into the *driven model's* toolbox. Per-verb table: recall/remember/impact = MCP (model reasons); **stash/peek/assemble = API only** (host-loop mechanics). Second MCP server deferred until an autonomous-Claude caller is real. `stash()` reframed from "library API for now" → **API-only BY DESIGN**.

2. **R-C4 `stash()` marked SHIPPED in CE PRD** (was already built/published in 0.6.0); R-C4 row + §10.5 updated.

3. **R-I3 `peek()` BUILT, validated, shipped** (`5aa6fc6`) — the read-half of `stash`. POC-first → designed → built → grounded. See full detail below.

4. **POC-rigor rule added to AGENT_RULES.md and propagated ORG-WIDE.** Triggered by user calling out a "big mouth" pattern (I asserted "peek is cheap/constant" without measuring; grounding falsified it). Rule = *aim the POC at the load-bearing claim not the easy part; prove don't assert; measure anything you call "cheap"/"fast"/"constant"*. See "AGENT_RULES propagation" below.

---

## R-I3 `peek()` — what shipped (commit `5aa6fc6`, 8 files)

- **`LiteCtx.peek(id)` → `{ id, bytes, head, tail, createdAt, truncated } | null`** (`src/index.js`) + **`Store.peekStash(id)`** (`src/store.js`). A **head+tail** preview of a stashed payload WITHOUT rehydrating it. `get(id)` is still the full body (= the "load" half — already existed; R-I3 added peek only).
- **Mechanism:** SQL `substr(text,1,160)` (head) + `substr(text,-80)` (tail, negative-substr verified) + `length(CAST(text AS BLOB))` (octet `bytes`, NOT `length(text)` = chars). Consts `STASH_HEAD=160`/`STASH_TAIL=80` in store.js. `tail` is `""` unless a real middle gap (`chars > HEAD+TAIL`); head/tail always **disjoint**. `truncated = chars > HEAD`.
- **Head+tail (NOT head-only)** — the conclusion (exit code, failing frame, closing structure) lives at the END. Borrows the *structural* half of SmartCrusher's start+end split (copy-pattern-studies §4, an R-C7 prior); deliberately NOT the anomaly-keep (needs a full scan → stays R-C7).
- **Stash-only** — recall owns ranked retrieval; peek carries no weights. `peek(fact-id)`/`peek(missing)` → null.
- **6 integration tests** in `test/stash.test.js`. **POC `poc/ri3-handle-poc.mjs`** (committed evidence, 21 assertions, excluded from `files`).
- **Decisions baked in (user-steered):** stash-only (recall for memory); fixed head/tail length, truncation signalled-not-lossy; `createdAt` = staleness hint, **no TTL / no audit log** (stash = private working-set, removed only by `forget`; unbounded growth → R-G7 eviction, separate); built now because it's the read-half of a shipped primitive, NOT speculative (the SW factory *validates* usability, it doesn't *define* primitives).

### ⚠️ THE GROUNDING CORRECTION (don't let this drift back)
My first claim — *"peek is cheap / cost ~constant / never materializes the blob"* — was **FALSE** and the user told me to "validate in full / ground it." Measured against the real facade: peek **RESULT size is bounded** (~306 B for any payload — THE REAL WIN: blob stays out of the context/token budget), but peek **WALL-TIME SCALES with payload** (0.47ms@0.1MB → 3.99ms@1MB → 17.8ms@5MB) and is **SLOWER than `get` past a few MB** — because SQLite reads the full column to run substr/length. Corrected the claim in ALL six places (store.js comment+JSDoc, index.js JSDoc, context.md, README, PRD R-I3 row) + added POC band `[2c]` that *measures* the scaling so the evidence file can't regress. **True O(1) peek would need byte-size stored at write (a deferred column).** `summary`/`scope` columns stay deferred (deterministic head+tail covers logs/traces/text/code; opaque blobs would need a caller summary — add only when a real caller passes one).

---

## AGENT_RULES propagation (this session, NOT all committed)

- **The rule** (added to "Validate Before You Build" + "Red Flags" + the condensed "Dev Rules" summary): (a) **Aim the POC at the load-bearing claim — not the easy part** (if you write "production would do X" instead of *doing* X, the POC hasn't validated X); (b) **Prove, don't assert — measure anything you call "cheap"/"fast"/"constant"**; claim only what the evidence supports. Also reconciled the "POC scope" bullet (was "happy path + edges = sound", which contradicted the new "happy-path shape = theater").
- **Propagated org-wide** via an idempotent Python script (pulled OLD anchors from unpatched `aurora`, NEW text from patched `hamr0` → byte-identical). **22 active copies fully patched** (verified). `beeperbox` = 3/4 (it has NO condensed summary block — complete for its structure). **`sawt/archive/tasks/AGENT_RULES.md` deliberately SKIPPED** (stale archive, no anchors — don't retro-edit archives).
- **Committed + pushed:** `hamr0` only (`8b3c79c` → `github.com/hamr0/hamr0`). #1 of the user's 3-part ask.
- **STILL UNCOMMITTED — user's call:** 13 tracked repos now carry the dirty `AGENT_RULES.md`: `agentic-toolkit, bareagent, bareguard, beeperbox, flightlog, gitdone, knowless, latefyi, litectx, mailproof, privcloud, pulselog, wearecooked`. (~9 others — addypin, aurora, barebrowse, baremobile, dwi, liteagents, multis, plato, sawt — have `.claude/memory/` **gitignored**, so updated on disk but nothing to commit.) **OPEN: user hasn't said whether to commit these 13** (offered a per-repo `standards: POC rigor` commit; held pending go).
- **Feedback memory written:** `prove-dont-assert.md` (+ MEMORY.md pointer).

---

## Immediate open threads (next session)

1. **Commit the 13 dirty AGENT_RULES repos?** — awaiting user yes/no (incl. litectx's own `.claude/memory/AGENT_RULES.md`, currently the only dirty file in the litectx tree).
2. **Two prior-session stashes still untracked** in `.claude/stash/` (rc4 + v0.6.0) — left out of the peek commit as out-of-scope; commit if desired.
3. **CE roadmap (held recommendation):** R-I3 done → next linchpin is **R-G6 `assemble()`** (intent + token budget → ordered minimal subgraph; unlocks R-C2/C7/X1/X3/X4). Doctrine: don't speculatively grind it — let the **software factory** (the ON-vs-OFF A/B validation harness, `docs/01-product/software-factory-prd.md`) pull its budget/intent contract. Adoption-first per PRD §15.

---

## Environment / gotchas to carry forward

- **`src/store.js` NUL byte at line ~248** → `grep`/`rg` treat it as binary (no matches). Use the Read tool or a node line-scan, NOT grep, on store.js.
- **Test runner = `node --test`** (node:test + node:assert/strict), NOT Vitest despite CLAUDE.md. Run via `npm test` (bare `node --test test/` misbehaves).
- **Gates:** `npm test` · `npx tsc --noEmit` · `npm run build:types`. Benches byte-identical on non-ranking changes.
- **`@huggingface/transformers` installed locally** → embeddings/KNN tests RUN here; the 1 skip = absent-dep contract test. **CI runs WITHOUT the dep** → those tests skip in CI.
- **`~/Documents/PycharmProjects` is a SYMLINK to `~/PycharmProjects`** — same files; don't double-count.
- **`main` push bypasses a PR-protection rule** (user has bypass; every push reports "Bypassed rule violations"). User's call whether to switch to PRs.
- **Governing docs (win over CLAUDE.md):** `.claude/memory/AGENT_RULES.md` (now incl. POC-rigor) + `.claude/memory/LIBRARY_CONVENTIONS.md`.
