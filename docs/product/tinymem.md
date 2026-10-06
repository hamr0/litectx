# tinymem — long-term organized memory for agents, inside litectx (preliminary PRD)

> **Status: DRAFT, a portal that changes as POCs come and go. Module 0 (the bake-off) signed off 2026-10-02.** The retrieval change (md sections as rows) is built in 0.34.0 (unreleased); the rest is not built. A line marked **(proposed)**
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

## Settled by the owner

| Decision |
|---|
| Ships inside litectx as new primitives. No new npm package. "tinymem" is the feature name. |
| SQLite is the truth. Markdown bodies are rows. |
| Pieces are hash-identified and immutable. Pages are named pointers that group pieces. |
| Merkle ids from the start: a node's id is the hash of its content plus its children's ids. |
| One index in docs-builder's style: page name, headings, line ranges. |
| Filing is mechanical and provisional. An occasional model pass, run by the host, cleans up. |
| tinymem works fully with no model. A model pass only improves it. |
| Two ways in: the running stream (chat, tool and MCP readings) and documents handed over. |
| First host to feed it: the owner's Claude Code sessions. |
| It answers on request, and can produce a small summary page. The host decides whether to load it. |
| A timed, periodic fold is wanted, as an opt-in. |
| The store is project-local by default, in the project's `.litectx/` folder. A global store under `~/.config/litectx` is the opt-in. |
| tinymem never fetches anything itself. Everything that passes through the agent is material, including what it reads through tools and MCP servers. |
| One-way export to a folder of `.md` files with `[[links]]`, read in Obsidian. No viewer of our own. |
| The maintenance worklist arrives with the model-pass module. |
| Open loops ("what did I leave unfinished") come right after the "what did we decide" test passes. |
| Headings of a handed-over document seed pages. |
| A piece may attach to more than one page. A link marked unsure is weeded later; the piece is never deleted. |
| Unsure links expire after 8 weeks without confirmation, hidden and revivable. Confirmed links never expire. |
| The agent reads the index (page name, headings with line ranges) and fetches only the range it needs. Up to about 100 pages it reads the index; beyond that it searches. |
| Module 0 is a bake-off: every matching method runs on the same frozen data and labelled sample, and the best wins. |

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
- Relating pieces to each other without a question. That belongs to the pages-and-links module.
- No tree, no timer, no task suggestions. Merkle ids and pages (module 3), the opt-in timed fold (module 6) and open loops (module 2) stay later modules with their triggers.

Code facts and the tenant-scope tests for this change are in [`tinymem-learnings.md`](tinymem-learnings.md#code-facts-for-the-retrieval-change-from-the-2026-10-03-design-draft).

## Measured starting facts (2026-10-01, the owner's machine)

| Fact | Value |
|---|---|
| Session logs under `~/.claude/projects` | 8,218 `.jsonl` files, 3.7 GB, 103 projects |
| Written in the last 24 hours | 156 files, 94 MB |

Most of that volume is tool output. Dedupe and filing have to cope with it; storing it verbatim
is not an option.

## Fit with litectx doctrine

Each of these is kept, not reopened.

| litectx doctrine | What it means here |
|---|---|
| No LLM inside litectx, no LLM-per-write, never distils | litectx prepares the groups and the shortlist, and validates the answer. The host's model labels and writes. |
| No loop, no server | The timer lives in the host or a CLI wrapper, never in the library. |
| Proactive auto-inject is permanently killed | tinymem is read on request. Loading the summary page is the host's choice. |
| `kind` is a closed set | Pieces and pages must fit the existing kinds, or the set is reopened by explicit decision. Open question. |
| Scope fences are structural | Every new table carries the same owner-qualified fence. |

## Shape

**Piece.** One unit of what came in: a message, a tool result, a section of a document. Its id
is the hash of its content, so the same piece arriving twice is the same piece. Never edited.

**Page.** A named pointer to the current set of pieces on one topic. The name is stable; the
hash it points at changes as pieces are added. This is how git treats a branch name.

**Index.** One catalog, written by one writer, in docs-builder's style: page name, headings,
line ranges. It is what an agent reads first.

**Links.** A piece may sit on more than one page. Pages that share pieces are related.

Search over the raw pieces always works, whatever the filing says. Organization is an overlay:
a wrong filing costs tidiness, not findability. Membership is a link, so moving a piece never
touches the piece.

### Filing a new piece

Which methods make up the ladder is decided by the module 0 bake-off, not here. The candidate
ladder, cheapest first:

1. **Same hash** — duplicate. Drop.
2. **Very high shingle overlap with an existing piece** — near-duplicate. File with its twin.
3. **Literal key** — the piece and a page share a file path, package, repo, issue number or
   error string. Attach.
4. **Shingle overlap with a page** — attach as unsure.
5. **Similarity of meaning (embeddings)** — attach as unsure, or store the shortlist.
6. **Model pass** — decides the rest from the stored top-5 shortlist.

Similarity proposes; something that can fail decides. litectx's own cross-session measurement
found the right item in the top 5 in 70% of cases and in the top slot in 0%, and BM25 scores
are not comparable between queries, so no rung attaches on a raw similarity score alone.

A piece may attach to more than one page. Pages seeded from a handed-over document take their
names from its headings.

```
 chat turn ──┐
 tool result ─┼─► cut ─► hash ─► piece ─► ladder ─┬─► attached
 handed doc ──┘                                    ├─► attached, unsure ⚑
                                                   └─► unsorted + top-5 shortlist

 index
 ├─ page "index yield"                 named from a document heading
 │    ├─ prd.md › Goal            (L2–3)
 │    ├─ prd.md › Design          (L4–5)
 │    └─ learnings.md › Yield POC (L2–3) ⚑   unsure, waits to be confirmed or weeded
 ├─ page "better-sqlite3"              named from a literal key
 │    └─ learnings.md › Release   (L6–7)
 └─ unsorted
      └─ prd.md › Out of scope    (L6–7)   shortlist: [index yield, …]
```

The example is illustrative, not measured.

### Weeding unsure links

- An unsure link expires after 8 weeks with nothing confirming it. It is hidden, not deleted,
  and comes back if evidence returns. 8 weeks is friction's number, borrowed as a start.
- Confirmation is any of: a second method later picks the same page, more pieces from the same
  session land on that page, an agent reads the piece through that page, or a model pass
  confirms it.
- Confirmed links and the pieces themselves never expire. Non-use is ambiguous and must not
  delete what was filed with confidence.

### How an agent reads it

- The index row is docs-builder's: page name, then each heading with its line range.
- The agent reads the index, picks a heading and fetches only that range. litectx already
  fetches one chunk by line range and refuses if the content under the range has changed.
- Pointers first, bodies on request. Measured in litectx: five pointers cost about 106 tokens,
  five full bodies about 6,960.
- Up to about 100 pages the agent reads the index directly. Beyond that it searches, and the
  search returns the same index rows as pointers. 100 is a starting number.

### What needs no model

- Cutting pieces, hashing, dropping exact duplicates, catching near-duplicates with shingles.
- Attaching by literal entity.
- Naming a mechanically created page from its top keywords.
- Building the index and recording links.

### What the occasional model pass does

- Reviews provisional attachments and the unsorted pile, choosing from the stored shortlist or
  answering "new page".
- Names topics that are not literal strings, merges or splits pages, tidies page prose.

A small cheap model is enough, because it classifies on a closed list. That is the use we
measured as reliable; free-form filing by a model measured 27%.

## Go / no-go

Settled by the owner, 2026-10-02. The bars below were fixed before any probe ran and are not
moved afterwards.

### Two exams, reported separately

| Exam | Corpus | Why |
|---|---|---|
| Messy | A frozen copy of real Claude Code session logs | chat and tool output, no structure |
| Structured | A frozen copy of the bareloop docs | markdown with headings |

Measured 2026-10-02: bareloop has 70 `.md` files (65 under `docs/`), 52,916 lines, and 245
session logs totalling 1.1 GB. Both exams use bareloop, so they cover the same subject.
Session folders created by headless test runs are left out of the frozen copy.

### 1. Organized memory answers better

For "what did we decide about X" questions, an agent using pages plus the index gives more
correct, sourced answers than the same agent using plain search over raw pieces at the same
token budget. **Tie rule:** if pages plus index do not beat plain search, we ship pieces plus
search and drop the pages.

### 2. Mechanical filing is good enough

| Bar | Pass |
|---|---|
| Pieces filed with confidence, on the held-out sample | at least 90% on the right page |
| Pieces filed as unsure, on the held-out sample | at least 75% on the right page |
| Coverage | at least 50% of kept pieces land in those two bands |

**Coverage** is the share of kept pieces the mechanical filer placed on a page at all, as
opposed to leaving them unsorted. Accuracy says how often a placed piece is on the right page;
coverage says how many pieces got placed. High accuracy with low coverage would mean the model
pass does most of the filing, and "works with no model" would not be true.

**Labelling.** A separate Sonnet worker that has not seen the filing output labels 200 pieces
per exam: 100 to tune on, 100 held out for scoring. "None of these pages" is a valid label. The
owner spot-checks 20.

Fails → stop, or re-scope.

## Module 0 — the bake-off

Signed off by the owner, 2026-10-02. Every matching method runs on the same frozen data
against the same labelled sample, and the best wins.

The code is throwaway, under `poc/`, on a branch. The frozen data and every output live outside
the repo under `~/.cache/tinymem-probe/`, because session text may hold secrets. Nothing enters
`src/` until a method wins.

### Contenders

| Method | What it does | Borrowed from |
|---|---|---|
| Literal keys | regex for paths, packages, issue numbers | friction, OpenHuman's regex extractor |
| Heading-seeded pages | a document's headings name the pages | docs-builder's index |
| Shingle overlap | percent of a piece's words and word pairs found on a page | friction |
| MinHash / SimHash | fast estimate of the same overlap; near-duplicate detection | `LOCAL_INTELLIGENCE.md` |
| BM25 | weighted word overlap | litectx |
| Embeddings (MiniLM) | similarity of meaning | litectx |
| Static embeddings | word-vector lookup, no model at runtime | `LOCAL_INTELLIGENCE.md` |
| Reranker | a small local model re-scores the top 5 | `LOCAL_INTELLIGENCE.md` |
| Two signals agree | attach only when two methods pick the same page | new |
| Model picks from top 5 | the ceiling the others are compared against | docs-builder's closed-list assign |

A contender that cannot be run from Node is reported as not run, never dropped silently.
Relatedness earned by use is not in this round: a frozen snapshot has no passage of time.

### Fairness rules, fixed before anything runs

1. **One fixed set of pages.** Pages are seeded from the headings of bareloop's product docs.
   The pieces to file come from its other docs and from its session logs.
2. **"None of these" is a valid answer.** A method that attaches everything is punished.
3. **Tune on one half, score on the other.** Any bar or threshold is chosen on 100 labelled
   pieces per exam and scored on a different 100.

### What is reported, per method and per exam

- how often its first pick is right;
- how often the right page is in its top 5;
- how often it correctly says "none";
- coverage;
- time per MB.

The go/no-go 2 bars apply to the best ladder assembled from the winners, on the held-out half.

### Corpus, measured 2026-10-02

| Part | Size |
|---|---|
| bareloop product docs, which seed the pages | 29 files, 12,726 lines, 290 second-level headings |
| bareloop other docs, the structured exam's pieces | 6 under `wiki/`, 24 under `logs/` |
| bareloop session logs, the messy exam's pieces | 245 logs; the folder is 1.1 GB, of which 777 MB is 1,296 nested subagent transcripts |

**(proposed)** A page is one product doc, named by its first-level heading; its headings are
that doc's second-level headings. Stage 1 cuts the 245 top-level session logs only and reports
the nested subagent transcripts separately.

### Stages

1. Freeze, cut, hash, dedupe, seed the pages, and measure volume.
2. Label 200 pieces per exam.
3. Run the contenders and score.

Each stage is checked by the orchestrator's own re-run before the next starts.

### Stage 1 results

Recorded in [tinymem-learnings.md](tinymem-learnings.md#stage-1--cutting-the-corpus-2026-10-02).

### A second question for the bake-off: is a piece worth keeping

Added 2026-10-02; the owner liked the distinction. Filing asks where a piece goes. This asks
whether it is memory material at all. The labeller marks each sampled piece as memory-worthy or
noise, and mechanical rules are scored against those marks on the held-out half.

Contenders:

- what the log gives for free: the kind of piece and the tool name;
- the share of tokens that are real dictionary words ("not words" is machine output);
- the share of function words such as "the", "to", "is".

A first, indicative look at these signals is in [tinymem-learnings.md](tinymem-learnings.md).

### Stage 2: the labelled sample (settled 2026-10-02)

- **Messy exam.** 204 unique pieces, 34 from each of six kinds: typed user text, assistant
  text, tool calls, tool results, queued commands and file attachments. Harness-injected text
  and thinking are left out. Per-kind numbers rest on 17 pieces per half and are indicative;
  the overall number is the one the bars use.
- **Structured exam.** 200 unique pieces drawn from bareloop's `wiki/` and `logs/` docs, 529
  pieces in all. The archive and the three generated top-level files are left out.
- **Halves.** Each exam's sample is split in two by a seeded, repeatable rule: one half to tune
  on, one held out.
- **What the labeller sees.** The piece, cut to its first 4,000 characters; its kind; for a doc
  piece its path and heading; and the 29 pages with their headings. It may read the frozen
  product docs when unsure.
- **What the labeller marks.** The best page or "none", an optional second page, sure or
  unsure, and keep or noise.
- **A piece belongs on a page** when it is about the feature or topic that product doc covers,
  so that someone reading the page would want the piece listed there.
- **Keep** means the piece holds something a later session would want and that would be lost if
  the piece were dropped: a decision, a finding, a requirement, a lesson, a fact about the
  project. **Noise** is everything else, including text that only reproduces a file already in
  the repo.
- Four labelling workers, one per half per exam. None has seen any filing output. A script
  checks the labels: every sampled id labelled once, every page from the closed list.
- The owner spot-checks 20 labelled pieces.

### Stage 2 results

Recorded in [tinymem-learnings.md](tinymem-learnings.md), with the problems they raise for stage 3.

## Reuse map

What already exists and is borrowed, as an idea or as code.

| From | What | Used for |
|---|---|---|
| liteagents `docs-builder` | `index-flat`: one mechanical index, single writer | the index |
| liteagents `docs-builder` | `log.md`, append-only | a record of what was filed and when |
| liteagents `docs-builder` | `search` over the outline | reading the index |
| liteagents `docs-builder` | propose themes, assign by exact key, `validate` citations | the model pass and its checks |
| liteagents `docs-builder` | `ledger` / `due` | knowing what changed since the last pass |
| liteagents `remember` | recurrence tiers; facts rewritten, not appended | the bar for the small summary page |
| liteagents `remember` | model classifies on a closed set, code does the counting | the split of work in the model pass |
| liteagents `remember/friction.cjs` | session-root probe list, session-log parser, session identity across forks, shingle matching | feeding from Claude Code sessions; near-duplicates |
| liteagents `stash` | `.processed` manifest and derived backlog count | knowing what is still unprocessed |
| litectx | store, chunker, `ingest()`, FTS, embeddings, scope fences, `recall_log`, promotion ladder | the substrate |
| OpenHuman (concept) | content-hash ids; capture with no model, organize in the background; lazy topic pages; coarse-to-fine reading with a source pointer; opt-in periodic fold | the overall flow |
| liteagents `remember/friction.cjs` | `shingles` (words plus adjacent word pairs) and its overlap threshold | the percent-similarity contender |
| liteagents `remember/friction.cjs` | unconfirmed entries expire after 8 weeks, hidden and revivable | weeding unsure links |
| litectx | chunk fetch by line range with a content-hash check | reading one heading's range from the index |
| hamr0 `LOCAL_INTELLIGENCE.md` | hash as a gate before any model; MinHash / SimHash; static embeddings; reranker; relatedness earned by use | bake-off contenders and later options |

## Out of scope and deferred

Settled by the owner, 2026-10-02.

### Deferred — each names what brings it back

| Item | What it is | Brought back when |
|---|---|---|
| Time roll-up levels and OpenHuman's three trees | Besides topic pages, every batch of pieces is summarized, and those summaries are summarized again by day, week and so on. The largest piece of machinery, and every roll-up needs a model. | time-shaped questions fail with a date filter over pieces and pages |
| A global digest across projects | One periodic summary across all projects. A model call each period and another tier that grows. | the owner asks cross-project questions the pages cannot answer |
| Three scope levels (global, project, agent) | Fences deciding which memory each agent can see. Every table and query carries the fence. | a second agent shares one store |
| A graph view without Obsidian | For example a Mermaid map of page links. | the owner wants the graph where Obsidian is not available |
| Stemming for doc sections | Word-form matching (agree/agreed) on section search. | a consumer searches docs with embeddings off (round 12: +5/60 top-5 with embeddings off, ~even with them on) |

### Not planned

- Connectors that fetch from external sources (mail, chat, calendars). What an agent reads
  through its own tools still flows in, as a tool result.
- Two-way sync with a markdown vault; edits made in Obsidian flowing back.
- Replacing `/stash`, `/remember` or the hot `MEMORY.md`.
- Multi-device sync, offline transport.
- Any UI of our own.

## Modules, in order

0. **The bake-off.** Every matching method on the same frozen bareloop data and the same
   labelled sample. Also measures bytes in versus kept, the duplicate rate and time per MB.
   Answers go/no-go 2. See "Module 0 — the bake-off".
1. **The "what did we decide" test.** Answers go/no-go 1.
2. **The open-loops test.** The same frozen data, asked "what was left unfinished".
3. **Pieces, pages and filing built properly in litectx.**
4. **The index and links.**
5. **The model pass and its worklist: task out, validated answer in.**
6. **Feeding from Claude Code sessions, and the opt-in timer.**
7. **The summary page.**
8. **One-way export for Obsidian.**

Modules 2 onward are sketches. Each is sharpened by its own POC when its turn comes.

## Open questions

- Does tinymem share the project's existing `.litectx/index.db`, or get its own file beside it?
- Do documents the owner hands over skip filing bands 2 and 3 and go to a page the owner names?
- Does litectx's closed `kind` set hold, or is it reopened for pieces and pages?
- Does the existing `episode` kind become a piece, or stay separate?
- Secret scrubbing before a piece is written: which patterns, and the measured miss rate.
- Which methods make up the filing ladder. Decided by the bake-off.
- Does a piece keep its full text forever, or is old text dropped once a page covers it?
- Are page links stored in litectx's existing edges, so `related` works on them unchanged?
- Open loops: which mechanical cues work (TODO strings, a session ending on an unanswered
  question, a stash's next-steps section). Untested.
- Schema: new tables are additive but need the owner's explicit sign-off before module 3.
- The 8-week expiry for unsure links cannot be measured on a frozen snapshot.
- The 100-page switch from reading the index to searching is a starting number.
- How headings are laid out inside a page fed from sessions, which have no headings of their own.
