# tinymem — long-term organized memory for agents, inside litectx (preliminary PRD)

> **Status: DRAFT, a portal that changes as POCs come and go. Go/no-go 1 ran 2026-10-07: NOT CONFIRMED. Step 1 v2 ran 2026-10-08: hybrid FAIL-WORSE at 1x, FAIL at ~5x, gap does not grow; the hybrid is dropped as the plan. The next steps are on hold pending an owner re-scope.** The retrieval change (md sections as rows) is built in 0.34.0 (unreleased); everything under "Next, in order" is not built. A line marked **(proposed)**
> is the orchestrator's recommendation awaiting the owner's answer; it is not a decision.
> Companion to [`litectx-prd.md`](litectx-prd.md), which stays the authority for what litectx is.
> Probe results and findings are in [`tinymem-learnings.md`](tinymem-learnings.md).

> **Sources for the concepts.** OpenHuman's Memory Tree (its docs only, not its source; it is
> GPL-3.0 Rust, so concepts are borrowed and no code is ported), Karpathy's LLM-wiki gist, and
> our own `/stash`, `/remember` and `/docs-builder` skills in liteagents.

## Goal

tinymem is long-term, organized memory for agents. It makes an agent smarter as its
interactions accumulate, the way Claude on the web does: a memory built up from past sessions,
plus search over those sessions, kept per project. Keep it simple.

**The test of "smarter".** The agent can answer "what do we know, or what did we decide, about
X" from past sessions, and point to the source. Adapting to the owner's corrections is already
`/remember`'s job and is not tinymem's.

**What this is not claiming.** Not a token saving. Our own measurement was a tie between
splitting docs and searching them.

## Current direction (2026-10-08)

- **Step 1 ran (2026-10-08) and the hybrid is dropped.** D (litectx plus grep/read) against B (grep/read only), 40 questions, k = 3: win rate 0.617 against 0.742 at 1x (FAIL-WORSE), 0.658 against 0.717 at ~5x (FAIL). The gap does not grow with size (mean g +0.067, sign test p = 0.067). D used about 60% of B's tokens. D matched B on docs but lost on sessions, where it stopped early. Per the PREREG outcome table, no build on the hybrid claim. Details: [learnings](tinymem-learnings.md#step-1-v2--hybrid-vs-grep-at-1x-and-5x-2026-10-08).

- Go/no-go 1 ran and is **NOT CONFIRMED** as a single run. litectx-only search won 38 of 60 questions; grep/read-only won 45. The gap is inside the measured noise, so read it as "search did not clearly win", not "grep clearly won". Search used about a third of the tokens (median ~12.8k against ~35.6k). The bar needed search to win by 4 on each repo. Details: [learnings](tinymem-learnings.md#answer-test--go-no-go-1-2026-10-07).
- The neighbour diagnostic (step 1a, done) and its control changed the reading. With neighbours, 9 of the 22 non-wins flipped to wins; a plain re-run without neighbours flipped 6. That difference is within noise (sign test p about 0.45). Of the 13 still failing, 5 never reached the gold source, 6 needed non-adjacent sections, 2 read the right section and still missed facts. The "about 18 stopped short" reading is not supported. Details: [learnings](tinymem-learnings.md#neighbour-fetch-diagnostic--control-2026-10-07).
- Run-to-run noise is large: about 1 in 4 partial answers becomes a win on a plain re-run. So go/no-go 1's single-run 38 against 45 is not solid either way. The owner's decision is to handle noise with repeats per question, not more questions.
- The plan is now: search as a compass, with grep and read beside it, measured on answers. Pages, filing and the rest of the old design are retired (see "Retired").
- Lessons from the LlamaIndex talk that shaped this are in [learnings](tinymem-learnings.md#lessons-from-llamaindexs-document-search-talk-2026-10-07).

## Settled by the owner

| Decision |
|---|
| Ships inside litectx as new primitives. No new npm package. "tinymem" is the feature name. |
| SQLite is the truth. Markdown bodies are rows. |
| tinymem works fully with no model. A model only improves it. |
| Two ways in: the running stream (chat, tool and MCP readings) and documents handed over. |
| First host to feed it: the owner's Claude Code sessions. |
| It answers on request. The host decides what to load. |
| The store is project-local by default, in the project's `.litectx/` folder. A global store under `~/.config/litectx` is the opt-in. |
| tinymem never fetches anything itself. Everything that passes through the agent is material, including what it reads through tools and MCP servers. |

## Retrieval change (decided 2026-10-04) — BUILT (0.34.0, unreleased)

**Now.** An indexed md file is one search row. Search ranks whole files and returns one hit per file, with a guess at the best section. That guess is wrong about a third of the time when the right file is found (round 13). One embedding per file, made from its first 6,000 characters.

**Change.**
- Indexed md files store each heading section as its own `doc` row. Doc rows live in a separate FTS table, `doc_fts` (same unstemmed tokenizer); the `docs` table is code-only, so md no longer perturbs code BM25 (a shared table dropped aurora-mixed HARD MRR 0.447 to 0.294). The sections come from litectx's existing md chunker, at every heading level.
- Each section row has its own embedding and line range.
- Same kind, nothing stored twice.
- Scoped direct docs (`remember` kind doc, `ingest` under a scope) use their own key namespace in both tiers (`scope\x1Eid`, global `\x1Eid`), separate from the fact keys `owner\x1Fid`. This fixed tenant B's same-filename ingest deleting tenant A's doc, and also the same-id doc/fact collision (they no longer share `mem_text`/`mem_meta`/embedding rows). Scoped `forget({id})`/`{idPrefix}` now also deletes that tenant's own docs.
- Search returns sections. `get(path,{startLine,endLine})` fetches them.
- Embeddings keep re-ordering only. They do not nominate.
- No stemming.
- `.eml` is added to the text formats (about 800-char paragraph pieces).
- Uploads (md, docx, pdf, txt, log, csv) are already per piece and are unchanged.
- Code, facts, episodes and blobs are unchanged.

**Evidence** (learnings, rounds 10-13).
- Fresh questions (60, two repos), right section in the top 5: sections: bareloop 22/30 embeddings off, 25/30 on; bareagent 19/30 off, 23/30 on. Whole files (exact section): bareloop 12/30 off, 13/30 on; bareagent 12/30 off, 11/30 on (round 13).
- Nomination added nothing (round 10).
- Stemming helps with embeddings off and is about even with them on (round 12), so it is left out.

**Cost.** First index takes about 3 min, against about 6 s on the bareloop docs (round 10). The db grows from 7.6 to 12.4 MB. After that only changed files re-embed.

**Build tests.**
- The multis scope fence on section rows, with break-one and break-both mutation tests.
- Existing tests and the doc and code benches pass.
- Re-run the 60 fresh questions through the built code and confirm the numbers.
- Measure index time.

**Not proven.**
- Uploads and 800-char pieces were not re-tested on real questions. Test them via `.eml` during the build.

**Out of scope.**
- Pages, links, a tree, a timer and task suggestions. All retired; see "Retired".

Code facts and the tenant-scope tests for this change are in [`tinymem-learnings.md`](tinymem-learnings.md#code-facts-for-the-retrieval-change-from-the-2026-10-03-design-draft).

## Measured starting facts (2026-10-01, the owner's machine)

| Fact | Value |
|---|---|
| Session logs under `~/.claude/projects` | 8,218 `.jsonl` files, 3.7 GB, 103 projects |
| Written in the last 24 hours | 156 files, 94 MB |

Most of that volume is tool output. Dedupe and the noise gate (the chat-feed step) have to cope with it; storing it verbatim
is not an option.

## Fit with litectx doctrine

Each of these is kept, not reopened.

| litectx doctrine | What it means here |
|---|---|
| No LLM inside litectx, no LLM-per-write, never distils | litectx searches and fetches. The host's model reads and answers. A re-ranker, if added, is local and not an LLM. |
| No loop, no server | Any timer lives in the host, never in the library. |
| Proactive auto-inject is permanently killed | tinymem is read on request. |
| `kind` is a closed set | New content fits the existing kinds. `format` is the extension point. |
| Scope fences are structural | Every new table carries the same owner-qualified fence. |

## Reuse map

What already exists and is borrowed, as an idea or as code.

| From | What | Used for |
|---|---|---|
| litectx | store, chunker, `ingest()`, FTS, embeddings, scope fences | the substrate |
| liteagents `remember/friction.cjs` | session-root probe list, session-log parser, session identity across forks, shingle matching | feeding from Claude Code sessions; near-duplicates |
| liteagents `stash` | `.processed` manifest and derived backlog count | knowing what is still unprocessed |
| litectx | chunk fetch by line range with a content-hash check | reading one section's range, and its neighbours |
| hamr0 `LOCAL_INTELLIGENCE.md` | hash as a gate before any model; MinHash / SimHash; static embeddings; reranker; relatedness earned by use | the local re-ranker and static-embedding options (step 4, step 5) |

## Out of scope and deferred

Settled by the owner, 2026-10-02.

### Deferred — each names what brings it back

| Item | What it is | Brought back when |
|---|---|---|
| Time roll-up levels and OpenHuman's three trees | Every batch of sessions is summarized, and those summaries are summarized again by day, week and so on. Every roll-up needs a model. | time-shaped questions fail with the step 3 date filter |
| A global digest across projects | One periodic summary across all projects. A model call each period. | the owner asks cross-project questions search cannot answer |
| Three scope levels (global, project, agent) | Fences deciding which memory each agent can see. Every table and query carries the fence. | a second agent shares one store |
| Stemming for doc sections | Word-form matching (agree/agreed) on section search. | a consumer searches docs with embeddings off (round 12: +5/60 top-5 with embeddings off, ~even with them on) |

### Not planned

- Connectors that fetch from external sources (mail, chat, calendars). What an agent reads
  through its own tools still flows in, as a tool result.
- Replacing `/stash`, `/remember` or the hot `MEMORY.md`.
- Multi-device sync, offline transport.
- Any UI of our own.

## Next, in order

**ON HOLD (2026-10-08) pending the owner's re-scope decision (see "Open: re-scope").** Steps 1 and 2 are done; steps 3 to 7 are kept as written but not started.

Each step names its pass bar or what it measures. A confirming run uses fresh questions; the 60 from go/no-go 1 have been seen.

1a. **Diagnostic. DONE 2026-10-07.** A2 on the 22 non-wins, traces saved: 9 flipped, but a plain re-run (control) flipped 6, so the neighbour effect is not separable from noise; 13 still failed for other reasons (retrieval, non-adjacent sections, missed facts). Neighbour fetch stays in the hybrid arm, unproven. Details: [learnings](tinymem-learnings.md#neighbour-fetch-diagnostic--control-2026-10-07).
1. **Hybrid agent. DONE 2026-10-08: FAIL-WORSE at 1x, FAIL at ~5x.** D win rate 0.617 against B 0.742 at 1x, 0.658 against 0.717 at ~5x; tokens about 0.63 to 0.69 of B. The hybrid is dropped as the plan. Results: [learnings](tinymem-learnings.md#step-1-v2--hybrid-vs-grep-at-1x-and-5x-2026-10-08). The design below is as it was run.

   Three arms on one harness, run in the same batch:
   - **A2:** litectx only, plus neighbour fetch. Tests the stopped-short diagnosis on its own.
   - **D:** litectx plus grep/read, plus neighbour fetch. This is the hybrid.
   - **B:** grep/read only, re-run in the same batch so model drift cancels.

   Each arm runs each question k times (k is set in the PREREG). Each question is scored as wins-of-k, and arms are compared paired, question by question. Answers whose grade is borderline get a second grade. The bar is set against the measured noise (about 1 in 4 partials flip on a re-run; grader differs on about 2 of 22), not against single runs. Final PREREG (approved 2026-10-07; 40 fresh questions, k = 3): `poc/tinymem-step1-PREREG.md`, sha256 `b5f0949fe0030a3c6d36febfe2ba914cf1097c8ff5771622b1f06bd1422e9675`. Questions frozen 2026-10-07: bareloop `9ac3ba15742e6b4e8a9d780fe22440754553ab5b3e5435e84791a55cdc77bf73`, bareagent `26e0284dd52b401fa7653c41cab3b6395acbfef30e4b1e8c10cd8ba4af1fde4a`. Questions-file hashes are recorded before any run. The scale test (step 2) is its own PREREG, still a draft: `~/.cache/tinymem-probe/out/step1-scale/PREREG.scale.draft.md`.

   `get` also returns the neighbouring sections, or a window by offset and length around a hit. Bar: fixed before the run in a hashed PREREG, with a stated win margin per repo (go/no-go 1 used +4 per repo) and a token ratio. The numbers are set in the PREREG, not here. Harness: save tool traces for every run; guard against session-limit and logout results being saved as answers.
   **PREREG v2 (2026-10-07, owner-approved, supersedes v1 which never ran):** `poc/tinymem-step1-PREREG-v2.md`, sha256 `8e13b70c3b1d252ba897a003c442d0fad57c37e9c76a1d7c23c973a0ba10a2e0`; harness `poc/tinymem-step1.mjs` sha256 `e0f6ac68efad61dd14541f32422c583f1678eeb34ae109da2687afabd114a063`. Arms D vs B at 1x and about 5x (scale test folded in), k=3, C once at 1x as the leak floor, A2 dropped, one joint blind grading pool. Scale bar: mean g >= +0.05 and sign test p < 0.05. Budget about $72, hard stop $90.
2. **Scale test, run alongside step 1. DONE 2026-10-08: gap does not grow** (mean g +0.067, sign test p = 0.067; the bar needs mean g >= +0.05 and p < 0.05). ~5x was about 3.6x to 5.3x by bytes, doc-heavy. Results: [learnings](tinymem-learnings.md#step-1-v2--hybrid-vs-grep-at-1x-and-5x-2026-10-08). The real 8,218-file corpus is untested. As planned: the same questions with 10 to 50 times more files mixed in (other repos' docs and sessions). The test corpora (~210 and ~118 files) sit in the range where grep is enough (~100 to 1,000 files, per the talk), so a tie there is expected. Scale is where litectx's value would show. The real scale is the owner's 8,218 session files. Measures where grep-only stops being enough.
3. **Search filters.** Source type (doc or session), date range, folder, and newest-first for sessions. Re-test the superseded-decision cases. Measures whether those cases are now answered with the newest decision. The newest-first case rests on a single superseded-decision failure, so the bar first requires writing more superseded-decision questions (at least 5 per repo).
4. **Ranking re-test on answers.** Keyword and vector both nominating, and a local non-LLM re-ranker. Measures wins on answers; round 10 only tested retrieval.
5. **Cost of growing session files and of the first index with embeddings.** Embed only new sections, batching, a lighter model. Measured before building the chat feed. The first full index took about 19 minutes on bareloop.
6. **Chat/session feed proper.** Stream ingest plus a noise gate, then re-run the answer test on it.
7. **Later: LiteParse** for layout-faithful PDF, Office and image parsing (tables). It replaces the current pdf/docx converters behind the same optional add-on pattern. Motivated by multis PDF manuals.

## Retired (2026-10-07)

The long module-0 bake-off design (contenders, fairness rules, stages, labelling) was removed from this PRD. It is history; its results are in [learnings](tinymem-learnings.md).

The answer test showed search plus grep is the open question, not filing. These pieces of the old design are shelved. Their module-0 results and rounds are in [learnings](tinymem-learnings.md) (stage 1 and 2, rounds 1 to 9).

**Bring-back condition for pages and Merkle ids:** an answer-test question type fails that a topic page would answer and search plus grep cannot.

- **Pieces, pages and topic filing.** The filing ladder never got close to its bar. Back when: the condition above.
- **Merkle ids.** Only needed for pages. Back with pages.
- **The filing ladder and the module-0 bake-off bar (90% right page).** Never approached. Back when: pages come back.
- **Index-of-pages reading switch (about 100 pages).** There are no pages. Back with pages.
- **Links and unsure-link expiry (8 weeks).** There are no links. Back with pages.
- **Model pass and its worklist.** Served filing only. Back with pages.
- **Summary page.** Served pages. Back with pages.
- **Timed fold / timer.** Needs a model pass. Back when a model pass exists.
- **Obsidian export.** Exports pages and links. Back with pages.
- **Open loops ("what did I leave unfinished").** Back after the chat feed passes the answer test.
- **Keep-or-noise labelling and the go/no-go 2 coverage bars.** Part of filing. The noise gate in step 6 may reuse the keep-or-noise signals in learnings.
- **Settled rows that only served these:** hash-identified immutable pieces and named pages; docs-builder-style index; mechanical provisional filing; summary page; timed fold; Obsidian export; maintenance worklist; open-loops timing; headings seeding pages; pieces on several pages and unsure-link expiry; index-reading switch; module 0 as a bake-off.

## Open questions

- Does tinymem share the project's existing `.litectx/index.db`, or get its own file beside it?
- Secret scrubbing before session text is written: which patterns, and the measured miss rate.
- How headings are laid out for session text, which has no headings of its own.
- Does a hybrid agent's gain survive at scale? Answered 2026-10-08: no gain at 1x or ~5x, and the gap does not grow ([learnings](tinymem-learnings.md#step-1-v2--hybrid-vs-grep-at-1x-and-5x-2026-10-08)). The real corpus (8,218 session files) is untested.
- **Open: re-scope.** The owner decides. Options, none chosen, each needs its own test before any build:
  - (a) Drop session search as a tinymem goal.
  - (b) A docs-only token-saving mode. D matched B on docs at about 60% of the tokens, but this PRD says token saving is not the claim.
  - (c) Change how results are presented so the agent keeps digging, since D lost on sessions by stopping early.
