# tinymem — learnings from the probes

> This is the record of what the throwaway probes measured and what they taught. The design and
> the bars live in [`tinymem.md`](tinymem.md). Probe data and outputs are outside the repo under
> `~/.cache/tinymem-probe/`, because session text may hold secrets. Entries are dated; new
> findings are added and old ones are not rewritten.


## Stage 1 — cutting the corpus (2026-10-02)

Run on the frozen copy: 245 top-level session logs and 65 docs, bareloop at `eff64e4`. The
script is `poc/tinymem-cut-poc.mjs`. Every run, including the orchestrator's own, gave
identical statistics.

**Correction.** The first run harvested only `user` and `assistant` lines. A breakdown of what
it ignored showed two real sources were dropped: commands queued while the agent was busy, and
files attached to the conversation. Both are now harvested. The five original kinds are
unchanged by the fix.

| Measure | Value |
|---|---|
| Raw session log bytes | 301.9 MB |
| Text held in pieces | 65.9 MB, 22% of raw |
| After dropping exact duplicates | 60.2 MB, 20% of raw |
| Session pieces, total and unique | 49,754 and 43,612 (12.3% exact duplicates) |
| Cut and hash speed | 87 to 97 MB per second |
| Doc pieces, total and unique | 1,014 and 998 |
| Pages and their headings | 29 and 290 |

| Piece kind | Unique pieces | Text | Exact duplicates |
|---|---|---|---|
| Tool result | 14,350 | 24.9 MB | 17% |
| Tool call | 16,092 | 16.1 MB | 8% |
| User text | 3,778 | 15.4 MB | 27% |
| Assistant text | 8,253 | 5.8 MB | 4% |
| File attachment | 185 | 2.5 MB | 12% |
| Queued command | 710 | 1.0 MB | 5% |
| Assistant thinking | 262 | 0.06 MB | 6% |

What this shows:

- Tool traffic is 62% of the text: 41.1 of 65.9 MB.
- A third of user text, 5.0 of 15.4 MB in 896 pieces, is injected by the harness, not typed.
- Thinking is almost absent: 13,101 thinking blocks are empty in the logs.
- Exact dedupe removes 12% of pieces. Near-duplicates are not measured yet.
- No piece is byte-identical between the sessions and the docs.
- The hot path is cheap: cutting and hashing 302 MB took about 3 seconds.
- No queued command exactly duplicates a user text piece. Only 23 of the 745 carry the
  human-turn flag and it is absent on the other 722, so that flag cannot separate typed
  commands from automated ones.

**How the harvest decides.** By log structure only: the line type and the block type. Nothing
is judged for importance, and everything harvested is kept, noise included.

What the harvest ignores, by size:

| Ignored | Size | Why |
|---|---|---|
| A second copy of every tool result, stored beside the first | 52 MB | duplicates what is kept |
| Encrypted signatures on thinking blocks | 31 MB | no readable text |
| Queue bookkeeping | 16.7 MB | not examined in detail |
| Harness attachments: instructions, style and token reminders, hook output, skill lists | about 30 MB | boilerplate |

Not verified: whether attached file content is truncated for large files, and whether an
edited-file snippet is a diff or file text.

## A first look at keep-or-noise signals (2026-10-02)

A first look, by the orchestrator's own throwaway check on pieces of 200 bytes or more. It is
indicative only: there is no ground truth yet, and it compares kinds, which the log already
gives.

| Kind | Dictionary words, median share | Pieces under 50% real words | Function words, median share |
|---|---|---|---|
| Assistant text | 0.84 | 0% | 0.28 |
| Typed user text | 0.73 | 7% | 0.18 |
| Tool results | 0.59 | 34% | 0.16 |
| Tool calls | 0.50 | 49% | 0.08 |

Line count, line length and compressibility barely differed between kinds. These signals
measure form, not importance: a one-line error is "not words" and can still be worth keeping.

## Stage 2 — the labelled sample (2026-10-02)

All four label files pass the checker, run by the orchestrator. The orchestrator's re-run of
the sampler reproduced the worker's file hashes.

| Batch | Pieces | On a page | "None" | Keep | Noise | Unsure |
|---|---|---|---|---|---|---|
| Messy, tune | 102 | 33 | 69 | 19 | 83 | 32 |
| Messy, held out | 102 | 27 | 75 | 16 | 86 | 21 |
| Structured, tune | 100 | 74 | 26 | 93 | 7 | 50 |
| Structured, held out | 100 | 74 | 26 | 87 | 13 | 47 |

Pieces marked keep in the messy exam, both halves together, out of 34 per kind:

| Kind | Keep |
|---|---|
| Assistant text | 12 |
| Typed user text | 7 |
| Tool calls | 6 |
| File attachments | 6 |
| Queued commands | 4 |
| Tool results | 0 |

What this shows:

- Seven in ten session pieces belong on none of the 29 doc-seeded pages (144 of 204), and five
  in six are noise (169 of 204).
- No tool result in the sample was worth keeping, 0 of 34. Tool results are 24.9 of the 65.9 MB
  of text. On 34 pieces this is indicative, not proof.
- The structured labels are weak ground truth: 97 of 200 are marked unsure. The labellers
  reported that many log sections are experiment findings only loosely tied to one product
  page, and that several pages overlap. None of the four labellers opened the full product
  docs; all judged from the page headings.
- The two structured labellers did not use "unsure" the same way: one marked all 26 of its
  "none" answers unsure, the other 11 of 26.

Problems this raises, not yet decided:

- **The coverage bar depends on what "kept pieces" means.** The bar was written before the
  keep/noise mark existed. Counted over every sampled session piece it cannot be met: 71% have
  no right page among the 29. Counted over pieces labelled keep, it can be met. Which reading
  applies is the owner's decision; an earlier version of this note said only that the bar could
  not be met, which overstated it.

  | Batch | Labelled keep | Of those, on a page | Of those, marked sure |
  |---|---|---|---|
  | Messy, tune | 19 | 17 | 6 |
  | Messy, held out | 16 | 16 | 8 |
  | Structured, tune | 93 | 73 | 50 |
  | Structured, held out | 87 | 69 | 36 |
- **Few positives.** The messy held-out half has 27 pieces with a page, 11 of them marked sure.
  A percent bar on that few pieces moves about four points per piece.
- **Label reliability is unmeasured.** No piece was labelled twice.

### The owner's spot-check (2026-10-02)

The owner marked all 20 pieces and agreed with all 20.

| Exam | Marked | Agree | Disagree |
|---|---|---|---|
| Messy | 10 | 10 | 0 |
| Structured | 10 | 10 | 0 |

- Two structured held-out pieces were first marked disagree. The owner withdrew both: they had
  read the pieces as noise, and on a second look agreed with keep.
- The owner's remarks were about keep versus noise. Whether the page labels were also judged
  was not stated, so this check does not confirm the page labels.
- Eight of the ten messy pieces were labelled noise, so the messy result mostly confirms
  noise calls.
- Twenty pieces is a sanity check, not a measure of label reliability.

## Module 0 bake-off, rounds 1 to 3 (2026-10-02)

The script is `poc/tinymem-bakeoff-poc.mjs`. It scores every method on the held-out half against
the stage 2 answer key, chooses any threshold on the tune half only, and writes ids, page ids and
numbers to `~/.cache/tinymem-probe/out/stage3/`. Every round left the earlier rounds' numbers
byte-identical, and the orchestrator's own re-run reproduced the output hashes.

Each round changed one thing: how a page is cut up for matching.

| Round | A page is matched as | Why the round was run |
|---|---|---|
| 1 | its whole text, or its headings only | the first run |
| 2 | each `##` section; the page scores its best section | whole pages favoured the biggest docs |
| 3 | windows of about 1,000 characters; the page scores its best window | sections are as uneven as pages: median 1.4 KB, largest 85 KB |

First pick right, held-out half, pieces that have a page (27 session pieces, 74 doc pieces):

| Method | Session: whole | Session: sections | Session: windows | Docs: whole | Docs: sections | Docs: windows |
|---|---|---|---|---|---|---|
| BM25 | 13 (48%) | 15 (56%) | 13 (48%) | 25 (34%) | 31 (42%) | 39 (53%) |
| Shingle overlap | 11 (41%) | 4 (15%) | 13 (48%) | 16 (22%) | 7 (9%) | 35 (47%) |
| Literal keys | 11 (41%) | 8 (30%) | 10 (37%) | 31 (42%) | 27 (36%) | 31 (42%) |
| MiniLM embeddings | — | 10 (37%) | 10 (37%) | — | 28 (38%) | 27 (36%) |
| MinHash | 5 (19%) | 0 | 10 (37%) | 18 (24%) | 12 (16%) | 22 (30%) |
| Random | 0 | | | 3 (4%) | | |

Right page in the top 5, best result: BM25 by windows, 22 of 27 session pieces (81%) and 64 of 74
doc pieces (86%).

What this shows:

- Windows of equal size helped the overlap methods most. On docs, BM25 went from 34% to 53% and
  shingle overlap from 22% to 47%.
- No method files with confidence. On the tune half no threshold reached 90% right on more than a
  handful of pieces, and none held up on the held-out half.
- The right page is in the top 5 far more often than it is first. Similarity gives a shortlist,
  not a decision, as litectx measured before.
- One page still draws first picks it is rarely labelled with. P26, the bareloop PRD, is the most
  common first pick of every docs method by windows (18 to 24 of 100), but only 1 of the 74 doc
  pieces with a page is labelled P26. The most-labelled page, P12, is never the most common first
  pick.
- Two methods agreeing is the only route near 90%. On docs, literal keys and embeddings agreed on
  14 pieces and were right on 13 (by sections), and on 19 pieces right on 17 (keys by whole page).
  That covers under a fifth of the pieces. On session pieces the same pairs are right less than
  half the time.
- MinHash does not track exact shingle overlap closely enough to stand in for it.
- Embeddings are about 100 times slower than the word-based methods.
- Keep or noise: the best rule on session pieces (piece kind plus share of function words) finds
  11 of 16 keep pieces, but only 11 of its 36 keep calls are right. On docs nearly every piece is
  keep, and no rule beats saying keep to all.

Not run yet: static embeddings, a reranker, and a model picking from the top 5.

Caution: all three rounds were scored on the same held-out half. The more rounds look at it, the
less it counts as untouched. A final pass or fail needs fresh labels.

## Lessons about method

- A harvest rule chosen from one sample file missed real content. Break down what a filter
  ignores before trusting it.
- A labelling worker must not use scripts or keyword matching to decide labels, or the answer
  key is contaminated by the kind of method under test.
- Choosing a threshold on the same sample it is scored on is fitting to pass. Tune on one half,
  score on the other.


## Module 0 bake-off, rounds 4 and 5 (2026-10-02)

### Round 4 — Haiku picks from the BM25-by-windows top 5

Script `poc/tinymem-pick-poc.mjs`, claude CLI. 404 calls, about $4.13, 32 minutes, 0 invalid, 0
skipped. stage4 results.json sha256
`4d2252b2c0523ff76492646f8e35f6053cc0fdf37646b2b85842e408810c446a`.

| Exam / half | BM25 first pick | Model first pick | Top-5 ceiling | Model right when in top 5 |
|---|---|---|---|---|
| Session, held-out (27 with a page) | 13 (48%) | 17 (63%) | 22 (81%) | 17/22 (77%) |
| Session, tune (33) | 14 (42%) | 20 (61%) | 25 (76%) | 20/25 (80%) |
| Docs, held-out (74) | 39 (53%) | 39 (53%) | 64 (86%) | 39/64 (61%) |
| Docs, tune (74) | 27 (36%) | 38 (51%) | 60 (81%) | 38/60 (63%) |

- Session held-out went 13 to 17 of 27 (ceiling 22), tune 14 to 20 of 33 (25).
- Docs held-out stayed at 39 of 74 (ceiling 64), tune went 27 to 38 of 74 (60).
- When the right page is in the 5, the model finds it 77–80% on session pieces and 61–63% on
  docs.
- NONE: on session pieces labelled none the model says NONE about half the time (36/75 held-out,
  36/69 tune). On docs it almost never does (4/26, 2/26). When the right page is not in the 5 it
  picks a decoy instead.
- Split by label confidence (orchestrator's recount): session sure 18/21, unsure 19/39; docs
  sure 54/88, unsure 23/60. The model is mostly right where the label is sure.
- Most-picked pages overall: P26 (42), P20 (32), P08 (22), P29 (22), P13 (20).

Caveats. Haiku saw 1,500 characters and at most 14 headings, with no definition of "belongs
on". The labellers saw 4,000 characters, all headings, the doc path and heading, and the rule.
Candidates were shown in BM25 order; a position effect is untested.

**Lesson from round 4.** A large part of the "coin flip" is the setup, not the matcher:
overlapping doc-seeded pages, and weak labels judged from headings. The model agrees with the
label where the label is sure and splits where it is not.

### Data removal (2026-10-02)

At the owner's request all copied session-log data and everything derived from it was deleted
from `~/.cache/tinymem-probe/`: the frozen logs, pieces, messy sample, messy labels, spot-check
and a stray index. The messy exam cannot be re-run without re-cutting. Session memory is parked;
work continues on docs only (owner: session pieces are mostly noise).

### Round 5 — building topics from the data

Script `poc/tinymem-topics-poc.mjs`. 998 doc H2 units. Method A: TF-IDF vectors, average-link
clustering. Method B: term co-occurrence. Scored as same-topic pairs against same-label pairs,
and against a seeded random partition with the same topic sizes. stage5 sha256
`4e0d4dde86f619c6522361e480daedbcef6d9a9ae697f705db7e18fd9020df69`.

**Round 5b** (`TOPICS_FILTER=1`) excluded the archive and generated top-level files (998 to 848
units: 111 archive, 39 other dropped) and added near-duplicate collapse (Jaccard ≥ 0.8). It
collapsed 0 units. stage5b sha256
`c8aea830743b7e8105f935691a2289fd6a590910dd16a70310796979d559b517`.

5b, pairs over all labelled units (P = share of same-topic pairs that share a labelled page,
R = share of same-page pairs found, random P in brackets):

| Variant | Topics | No topic | Giant topic | P / R | Random P |
|---|---|---|---|---|---|
| A cos ≥ 0.10 | 130 | 31 | 4.5% | 0.60 / 0.14 | 0.11 |
| A cos ≥ 0.15 | 196 | 92 | 1.4% | 0.74 / 0.06 | 0.11 |
| B label-prop J ≥ 0.2 | 139 | 35 | 11.9% | 0.43 / 0.21 | 0.12 |
| B conn-comp J ≥ 0.2 | 3 | 0 | 100% | 0.11 / 1.00 | 0.11 |
| B conn-comp J ≥ 0.35 | 140 | 117 | 13.2% | 0.28 / 0.13 | 0.11 |

What changed from round 5:

- Method A barely moved (cos ≥ 0.10 P 0.597 to 0.601; cos ≥ 0.15 P 0.747 to 0.743).
- Method B conn-comp J ≥ 0.35 giant fell from 45.2% to 13.2%, and its precision rose from 0.113
  (random level) to 0.284. B label-prop J ≥ 0.2 giant fell 13.8% to 11.9%, P 0.374 to 0.432.
- Conn-comp J ≥ 0.2 stays one blob (97.9% in round 5, 100% in 5b).

Findings:

- Real topics exist and cut across docs. Examples by name: softgreen / hitl / pause;
  bundle / export / blessing; clipipe / usage / pricing.
- Method A is precise (P 0.60–0.96 against about 0.11 random) but low recall (1–14%) and makes
  no blob.
- Method B makes blobs or grab-bags and is not usable alone.
- The junk topic index-flat / log.md came from including generated files. That was an error in
  the brief, fixed in 5b.
- Template-doc preambles still cluster as junk.
- The existing answer key grades doc pages, not topics, so it cannot fully judge topic quality.

### OpenHuman memory tree (read 2026-10-02)

The engine lives in tinyhumansai/tinycortex (commit 72ce1d1).

- Topic trees and the daily digest are retired. Topics are query-time views over an entity to
  chunk index.
- Hotness constants exist (create 10.0, archive 2.0) with counters (30-day mentions, distinct
  sources, last seen, query hits), but no formula combines them.
- Entities come from regex (email, URL, handle, hashtag), with an LLM only on borderline chunks.
  Merge is exact-match.
- Noise gate: cheap weighted signals. Keep at ≥ 0.85, drop at ≤ 0.15, model only in between,
  admit at ≥ 0.3.
- Seal: L0 at 50k tokens, fanout 10. The default summariser is deterministic concatenation.
- The 20-minute auto-fetch only ingests. Suggestions come from an LLM "goals reflection agent".
- No filing-quality evaluation exists in their repo.
- Relatedness is shared entity, same source or time, and embedding re-rank at query time. There
  is no clustering.

### Direction agreed with the owner

- H2 sections are the leaves.
- A noise gate in front.
- An entity index: literal keys plus distinctive recurring terms.
- Method A groups seed the pages.
- Pages grow from lookups. Only USED leaves (fetched or cited) count, never appearance.
- Counts promote a topic to a page and never re-rank search. This reuses litectx's recall/fetch
  log and the `promotionCandidates` pattern.
- A host model on a timer may name or merge pages (bareagent lane).

Next: round 6 tests the entity index.

### Round 6 — entity index (2026-10-02)

Setup: 848 filtered H2 units. Entities are literal keys (the bake-off regex) plus recurring terms
(in ≥ 2 doc files and ≤ 25 units, i.e. 3%). A page's score is the idf-sum of the entities a piece
shares with it. Random baseline is 20 seeded reps. Source: `stage6/report.md` and `results.json`
(sha256 bd9a3729…d683); script `poc/tinymem-entities-poc.mjs`.

Pieces with a labelled page, first / top5 (round 3 scored held only, so it has no tune BM25):

| method | tune first/top5 | held first/top5 |
|---|---|---|
| BM25 by windows (round 3) | n/a | 39/74, 64/74 |
| literal keys | 23/74, 52/74 | 24/74, 53/74 |
| recurring terms | 17/74, 51/74 | 23/74, 48/74 |
| combined | 18/74, 56/74 | 22/74, 52/74 |
| random (mean of 20) | ~6–7, ~17–24 | ~6–7, ~17–19 |

- Reach of 90–99% is inflated. A piece reaches 20–40% of all units through shared entities, and
  random recurring/combined entity sets reach ~80% too. Literal keys are the cleanest (reach ~2x
  random, ~175–180 units vs ~65).
- No NONE behaviour. 24–26 of 26 none-labelled pieces still reach a page, and top-score cuts
  (≤ 0/3/6) do not separate none from paged pieces.
- The frequency cut removes the useful terms. softgreen (56 units), bundle (52), clipipe (52) and
  spawner (67) are all over the 25-unit cap. The survivors at the cap are glue words (the top
  recurring entities are generic verbs and adjectives). hitl survives as a literal key (19
  units, coherent). The literal regex also catches hyphenated English (load-bearing, cap-halt).

Verdict: the entity index is not a router. BM25 stays the lookup. Distinctive terms are
concentrated in a few docs, so a plain unit-count cap cannot separate them from glue; a
doc-level or concentration measure is the open fix. All of rounds 4–6 grade against doc-page
labels, which cannot judge cross-doc topics. The next test should be question-based.

### Rounds 7a and 7b — topic words and real questions (2026-10-02)

**7a: topic-word concentration** (`poc/tinymem-concentration-poc.mjs`, results sha256
c2acf3e03ce4ce7d9ee543f9f288b0d41451749486a4baa2a48fa8961cd46db0). 59 whole docs. Density = term
count / doc content words (stopwords excluded, owner's spec). Score = mean top-3 doc density /
corpus density, count >= 5.

- FAILS as a topic-word picker. The top of the list is run ids and one-off rare words. Check terms
  sit mid-table (bundle 20th percentile, softgreen 43, hitl 53, spawner 55, clipipe 82) against a
  glue median of 93, and the two groups overlap (come at 37 beats clipipe). No separation in 9
  settings; the denominator choice barely matters.
- WORKS the other way: a term's densest docs are the docs about it.
- Cause: lift rewards rarity and ignores mass. Untested fix: per-doc keyness (log-likelihood).
- The check terms were chosen from earlier rounds, so this is a sanity check, not an unbiased test.

**7b: real questions** (`poc/tinymem-questions-poc.mjs`). Questions pre-registered, sha256
2c38c60040edbcecf277956e4899b335c1119e30e6d039f1679fd05ce97c62fc, written by a worker that ran no
retrieval. Results sha256 537b9408ed382670e13e394116b7153e2da06b253086ef7e02282a6dc87b758c.
Shipped litectx recall, BM25, 59 files / 1607 nodes.

| ask | p@1 | primary@5 | any-gold@5 | gold-file@5 |
|---|---|---|---|---|
| askA | .05 | .20 | .40 | .44 |
| askB | .05 | .15 | .25 | .21 |

- Embeddings: askA no gain; askB any-gold@5 .25 -> .45 (noisy, n=20).
- CONFOUND (found by the orchestrator): the question writer skipped the 4 largest docs (PRD,
  FINDINGS, UPSTREAM-ASKS, TESTGEN-PREREG) but recall searched them. 18/100 askA and 31/100 askB
  top-5 slots come from them (14 and 16 of 20 questions). Some are real answers (q01 scout ON/OFF
  -> FINDINGS F126 was scored a miss). The search numbers are a FLOOR of unknown distance. Not yet
  re-graded.
- Structural limit: doc `recall` returns one best chunk per FILE, so two gold sections in one file
  can never both be retrieved. litectx doc retrieval is tuned file-level (code/md top 5), not
  section-level memory.
- Grow (less affected by the confound, relative comparison): a realistic agent (top 3 fetched) is
  flat to slightly negative. Wrong page 16/18 (leaf overlap) and 14/19 (term overlap); 1.7-2.7
  non-gold leaves injected per 5 slots. The oracle helps <= 1 question; only 8/20 askA found any
  gold, so 12 pages never formed.
- Lesson: a page is capped by the first ask's search; pages do not fix weak search; overlapping
  topics make page matching wrong.

Open: re-grade the skipped-doc slots blind. Owner's idea: tinymem may need its own retrieval kind
(section-level, possibly via the memory path: stemmed `mem` FTS + embeddings nominating), since doc
recall is file-level.

### Where module 0 stands, and what carries forward (2026-10-02)

**Correction to 7b.** The "gold-file@5" column was copied from a worker report, not computed by
the script. The orchestrator recomputed it from per-question hits: askA .43 (not .44), askB .25
(not .21). At @10: .56 / .50. No conclusion changes.

**OpenHuman: copy / don't copy.**
- Copy: an entity -> chunk index read at query time (no filing onto one page).
- Copy: a cheap noise gate before storing. Keep >=0.85, drop <=0.15, admit >=0.3, on weighted
  cheap signals.
- Copy: content-hash ids.
- Copy: top-down reading (summary -> children -> leaves). For us: index -> page -> leaf -> line
  range via `get`.
- Copy: hotness counters (30-day mentions, distinct sources, last seen). The formula is ours to
  write and test.
- Don't copy: LLM entity extraction, LLM summaries, LLM goals-reflection inside the library.
  All host/bareagent lane.
- Don't copy: their evaluation. None exists.

Their pipeline mapped to litectx:
1. Source adapters -> `index()` / `remember()` / `ingest()`.
2. Canonicalize -> ingest's pdf/docx -> md.
3. Chunker -> heading chunker + content-hash ids.
4. content_store -> one SQLite file (settled).
5. Score -> embeddings exist; noise gate + entity index missing.
6. Source/topic/global trees -> none. Their topic/global trees are retired.
7. Retrieval -> `recall` + `get` exist; topic lookup missing.

**Owner's ideas this session (credit).**
- (a) Build topics from the data, not fixed pages.
- (b) Let questions build pages: pages grow from what an agent actually used.
- (c) Measure term concentration as density against the doc's CONTENT words (prepositions and
  connectives excluded).
- (d) Memory may need its own retrieval kind, because doc recall is file-level and tuned for
  code/md top 5.
- (e) Focus on docs. Session logs are mostly noise; that data was deleted.

**Direction as of now (supersedes "Direction agreed with the owner" above).**
- Filing a piece onto exactly one page: dropped (rounds 1-4).
- Blind topic building: Method A gives a few real cross-doc topics, mostly small or mixed. Word
  co-occurrence alone fails (rounds 5-5b). Global topic-word ranking by density lift fails;
  per-doc density does find the docs about a term (7a).
- Entity index as a router: dropped. BM25/recall is the lookup (round 6).
- Pages grown from use: do not help when search is weak, and overlapping topics make page
  matching wrong (7b). A page is capped by the first ask's search.
- The bottleneck is FINDING, not organising. Doc recall returns one section per file.

**Next: round 8 (running).**
1. The same 20 pre-registered questions through litectx's memory path. Every H2 section is stored
   as a `fact` (stemmed `mem` FTS + embeddings that nominate). Embeddings off and on, side by
   side with the doc path.
2. ONE blind re-grade of every non-gold top-5 section from BOTH methods. Shuffled; method and
   rank hidden; criterion: a careful reader would cite it. Result is `gold-extra`, reported
   separately from the original gold.
3. If the memory path wins, a `tinymem` kind with sections as memory items becomes the design,
   and organising comes after.

### Round 8 — memory path vs doc path, blind re-grade (2026-10-02)

**Setup.** Same 20 pre-registered questions (sha256 2c38c600...62fc). Memory path = every H2
section (848 units: 789 H2 + 59 preambles) stored via `remember({kind:'fact'})`;
`recall(q,{kind:'fact'})` uses the stemmed `mem` FTS, with embeddings ON nominating (KNN union).
Script `poc/tinymem-mempath-poc.mjs`; results sha256 46b0c48d...5d69, hits.json 6e69abf0...2595.
Doc-path numbers were re-derived from the 7b hits and match exactly.

**Original gold, primary source in top 5 (askA / askB).**
- doc-bm25 .20 / .15; doc-emb .15 / .25; mem-bm25 .45 / .30; mem-emb .55 / .45.
- p@1 (primary): doc .05, mem-emb .25.

**Blind re-grade (owner-agreed).** Pool = every non-gold top-5 section from ALL four methods,
both asks = 427 pairs (`poc/tinymem-gradeprep-poc.mjs`, seed 20260930). 4 shuffled packets with
only question + file + heading + text; no method, no rank; key kept private. 4 Sonnet graders,
strict rule: a careful reader would cite it; shared keywords are not enough.
- 47 yes / 380 no. 17 of 20 questions gained sources; 22 of the 47 come from the 4 docs the
  question writer skipped.
- Orchestrator spot-checked a sample of yes and no verdicts and agreed.
- gold-extra.json sha256 677ff46b...c76a6 (kept outside the repo).
- Process slip: the graders were launched via a Workflow without explicit owner opt-in. Results
  unaffected.

**Any valid source in top 5 (original -> with gold-extra), askA / askB.**
- doc-bm25 .40->.65 / .25->.50; doc-emb .45->.70 / .45->.65.
- mem-bm25 .60->.85 / .45->.80; mem-emb .60->.90 / .70->.85.

**Top-1 is a valid source (original -> with gold-extra), askA / askB.**
- doc-bm25 .10->.10 / .10->.25; doc-emb .20->.35 / .20->.30.
- mem-bm25 .35->.50 / .20->.45; mem-emb .35->.70 / .30->.55.

**Non-gold slots judged valid.** doc-bm25 13/177, doc-emb 18/177, mem-bm25 32/168, mem-emb
33/161. The memory path's crowding into big docs was largely legitimate, not noise.

**Verdict.** Memory path + embeddings wins under both answer keys; the ordering is unchanged by
the re-grade. The owner's idea (d) is confirmed: memory needs its own retrieval, with
section-granular items, stemmed FTS, and embeddings that nominate. Finding is no longer the
bottleneck; organising comes next.

**Caveats.**
- n=20: one question = 5 points.
- One grader per pair.
- Stemming is not isolated from the unit change (section vs file).
- Coverage barely moves because gold-extra enlarges the denominator.

**Next.** Design a `tinymem` kind = H2 sections as memory items on the existing fact/episode
path; then organising (pages) on top.

### Round 9 — chunk size, what drives the win, grading reliability (2026-10-03)

**Setup.** Same 20 questions, memory path. Three unit shapes, hits mapped back to their H2,
first-rank dedupe:
- U1 H2 sections (848; reproduces round 8 exactly).
- U2 litectx's own md chunks (1,607, read from the 7b doc index).
- U3 ~1,000-char windows (1,871).
- Script `poc/tinymem-chunking-poc.mjs`. Final results sha256 a87f3e39...6a2f, scored with
  gold-extra2.

**Chunk size, embeddings on, all 20 (askA/askB).**
- Primary@5: U1 .55/.45; U2 .50/.40; U3 .25/.20.
- Any-valid@5 (gold + extra + extra2): U1 .90/.85; U2 .95/1.00; U3 .80/.90.
- BM25-only primary@5: U1 .45/.30; U2 .50/.40; U3 .25/.25.
- Read: litectx's own md chunker is about equal to H2 (1-2 questions either way). Windows are
  clearly worse on the primary source: cutting a section from its heading loses context. This
  reverses round 3, where pieces, not questions, were matched.

**Mechanism split on H2 sections (original gold, primary@5, askA/askB).**
- Unstemmed per-section BM25: .35/.35. Already beats the doc path (.20/.15), so per-section
  results are the biggest single factor.
- Porter stemming: .45/.30. A small, consistent plus.
- Embeddings nominating: .55/.45. A plus on depth (primary@10 .55 -> .75 on A).
- One-per-file cap on mem-emb primary@10: .75 -> .55 (A), .60 -> .50 (B). The cap costs depth.

**Conclusion.** Route prose through litectx's EXISTING memory engine (per-item results,
stemmed FTS, embeddings that nominate) using the EXISTING md chunker. No new chunking, no new
search engine.

**Remaining decisions.**
- New kind vs an updated `doc` kind.
- multis tenant scope.
- Indexing plumbing.

**Grading reliability (new finding).**
- Two round-8/9 packets came back with one boilerplate "no" reason for 80-95 verdicts; one
  grader read sections only partly.
- Round 8 packet 2, careful re-grade: agreed on 102/106 (same 11 yes, 9 shared). Round 8
  numbers stand (moves <= .05 under original, re-grade and union).
- Round 9 packet 1, two independent graders: agreed on 77/83 but on only 3 of 9 "yes" calls.
  A single-grader "yes" on a borderline section is noisy, so report extended-key numbers as
  ranges.
- Round 9 packet 3 re-grade was BLOCKED at 31/83 by the auto-mode classifier ("PII Data
  Handling"). Not worked around.
- gold-extra2 = union of all trustworthy yes verdicts, including the partial re-grade (20
  sections, 14 questions, sha256 8a6aca7f...f04ef620).
- Method rankings hold under every grading variant.

**Lesson.** A repeated reason is a flag to re-check, not proof of a bad grade. Always check
grader reason diversity and whether the full text was read.
