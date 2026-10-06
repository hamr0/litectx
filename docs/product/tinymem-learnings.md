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

## Code facts for the retrieval change (from the 2026-10-03 design draft)

The new-kind / second-table options were dropped 2026-10-03: owner ruled out a new kind and any duplicate capture of md.

Line cites are to the code at HEAD of `tinymem-poc` on 2026-10-03.

### What the code does today

| Fact | Cite |
|---|---|
| `index()` writes ONE `docs` row per file (whole body, unstemmed) and N `nodes` rows (chunks with line ranges, `stamp`) | `store.js:494-575`, `store.js:132` |
| md chunks = every heading level, plus a preamble | `chunker.js:199-229` |
| File embedding is ONE vector per file, whole body head-truncated to 6,000 chars (model sees ~512 tokens) | `index.js:471-478`, `embedder.js:11` |
| `docs` FTS has no stemmer; `mem` FTS is `porter unicode61` | `store.js:118`, `store.js:221` |
| `search()` for fact/episode reads `mem` + `mem_scope` owner/session fence; other kinds read `docs` + `doc_scope` fence | `store.js:1655-1695` |
| Cosine NOMINATES only for fact/episode (`MEM_KINDS`); code/doc are BM25-gated, cosine only re-ranks | `index.js:859-880`, `store.js:1967-1969`, `store.js:250` |
| `ingest()` already stores each segment as its own direct `docs` row `<id>#<n>` (unstemmed, no line ranges); md/DOCX segments reuse the md chunker | `index.js:1259-1303`, `docparse.js:242-252` |
| `doc_scope` fence: `scope IS NULL OR scope = :scope`, plus expiry; file rows have no sidecar row (global) | `store.js:1690-1696`, `store.js:212` |
| `get(path,{startLine,endLine})` for file rows: `_chunkState` hash gate, then `nodes` body; written rows return null for a range | `index.js:766-777`, `index.js:1019-1048`, `store.js:1399` |
| Self-heal: whole-index stamp `user_version` = hash of `src/*.js`; per-node `nodes.stamp` | `indexer.js:32-45`, `store.js:1452` |
| `forget`/prune touch `source='direct'` only; `index()` force clears file rows only | `store.js:811`, `store.js:439-445` |

Finding: a file's single embedding is made from only its first 6,000 characters
(`src/embedder.js:11`), which explains the weak doc-path embeddings.

### Cost estimates (unmeasured; to be measured before building)

| Item | Estimate |
|---|---|
| Rows | 1,607 md chunks for 59 files (round 9 U2); about 27 chunks per file vs 1 file row |
| Vector size | 384 float32 = 1.5 KB per chunk, about 2.5 MB for that corpus |
| Index time with embeddings | one embed call per chunk instead of per file; model cost per call is small but ~27x the calls on md. Unmeasured. Embeddings off: stemmed BM25 alone gave .45/.30 |

Consumers: owner and multis only.

### multis tenant-scope rules

Today: ingest chunks carry `doc_scope(path, scope, expires_at)`; fence is
`scope IS NULL OR scope = :scope` plus expiry (`store.js:1690-1696`); `strictScope` makes a
missing scope throw on read and write (`index.js:525-556`); `GLOBAL` maps to `scope IS NULL`.
File-indexed chunks have no sidecar row, so they are global, as code and md are today.

| Rule | Behaviour |
|---|---|
| Read fence | Section search and KNN join `doc_scope` on the row's path with the SAME predicate: `scope ∪ null-global`, expiry-aware. Factor the predicate into one helper used by `search`, `knnCandidates`, `getItem`, `count`, so there is no second copy |
| strictScope | `recall`, `get`, `ingest` throw without a scope or `GLOBAL`. File rows (global) remain readable under `GLOBAL`/tenant scope |
| Write / `scoped(tenant)` | direct rows get `doc_scope` like `remember({kind:'doc'})` (`index.js:1100-1108`); `ScopedView` binds scope unchanged (`index.js:625`) |

Two independent mechanisms, as on the memory axis (`store.js:256` W4 key + `mem_scope` JOIN):
1. SQL fence: the `doc_scope` JOIN in `search`/`knnCandidates`/`getItem`.
2. Structural key: direct section rows use a scope-qualified physical key `scope\x1Fid`
   (reuse `assertNoMemSep`), so a bare `get(id)`, an upsert, or `forget({id})` under tenant B
   cannot match tenant A's row even if the JOIN were broken. The public id is stripped on output.

Isolation tests required (all mutation-verified: break ONE mechanism, the isolation test must
still pass; break BOTH, it must fail):
- A's section never appears in B's recall, BM25 and KNN-nominated (semantically identical text).
- `get(id)` and `get(id,{startLine,endLine})` across tenants return null.
- Same id under two scopes = two rows; re-ingest replaces only its own tenant's row.
- `strictScope` throws on read, write, `get`; `GLOBAL` reads only the shared tier.
- `forget({scope})`/`forget({id})` leaves the other tenant and ALL file-sourced rows alone.
- `forget`/episode prune/reset-by-kind never delete file-sourced section rows.

## Round 10 — unstemmed per-section doc path (the proposal as specified)

Script: `poc/tinymem-round10-poc.mjs`. Outputs: `~/.cache/tinymem-probe/out/stage10/`
(`results.json` sha256 `b3deee32de5e1c93cad1adfbf418cebd255e2c45f9244be57ed0330a6dd0d52a`,
`report.md` sha256 `deadc8a9b471aae49fc72098328dfb9db5b37b53fb290829aab6bd28a85c5349`).

Setup:
- Same 59-file corpus, same questions, askA/askB, gold + gold-extra + gold-extra2 keys, same scoring as round 9.
- Sections = litectx's own `chunkFile` (md splits at every heading): 1,607 rows, identical ranges and text to round 9 U2 (0 diffs).
- Each section written with `remember(file#start-end, text, {kind:'doc'})` into the UNSTEMMED `docs` table, real embedder (all-MiniLM-L6-v2), 1,607 vectors in `mem_embeddings`.
- C1: BM25 only (same db, second `LiteCtx` with embeddings off, `recall kind doc n=50`).
- C2: shipped `recall kind doc n=50` (BM25 pool of 400, cosine re-ranks only).
- C3: BM25 pool UNION nearest-vector nominees, copy of `_rankKind` with the fact/episode-only gate lifted. K=8 (`index.js:40`), pool 400 (`index.js:32`, `:865`), nominees cos>0 not already in pool, score 0, `store.js:1967-1990`. Fusion `minmax(score; nominees at pool floor) + 1.0*minmax(cosine)` (`index.js:892-898`).
- Checks: my fusion with no nominees equals shipped `recall` on all 40 asks (0 mismatches). All gold sections mapped to rows (0 unmapped).

Numbers (extra2 gold, all 20 questions):

| config | prim@5 A | prim@5 B | prim@10 A | prim@10 B | any@5 A | any@5 B |
|---|---|---|---|---|---|---|
| C1 unstemmed BM25 | .40 | .35 | .40 | .40 | .85 | .80 |
| C2 shipped recall (re-rank only) | .35 | .40 | .55 | .50 | .90 | .95 |
| C3 proposal (nominate) | .35 | .40 | .55 | .50 | .90 | .95 |
| round 9 U2 stemmed + emb (ref) | .50 | .40 | .65 | .60 | .95 | 1.00 |
| round 9 U2 stemmed BM25 (ref) | .50 | .40 | .55 | .50 | .85 | .85 |

Reference rows read from `stage9/results.json` (sha256 `a87f3e39...86a2f`), not re-graded.

Cost (embeddings on, model pre-loaded, same corpus):

| | rows | db size | index time |
|---|---|---|---|
| Per section (`remember` loop) | 1,607 | 12.4 MB | 179.8 s (~112 ms/row) |
| Per file (`ctx.index`, shipped way) | 59 | 7.6 MB | 6.3 s |

Truncation: 37 of 1,607 sections exceed the 6,000-char embed cap (max 84,174 chars; mean 1,542). For comparison 56 of 59 whole files exceed it today.

Plain read:
- Pass bar missed. C3 vs round 9 U2: any@5 -.05/-.05 (at the edge), prim@5 A -.15, B 0. prim@10 -.10.
- C3 is identical to C2 on every top-5. Nominees reached the top 10 in 2 of 400 slots. With a 400-row BM25 pool over 1,607 rows, only 8 extra vectors can be added, so nomination does nothing here. The embedding gain comes from re-ranking.
- C1 vs round 9 stemmed BM25: prim@5 -.10/-.05, any@5 equal on A, -.05 on B. Stemming accounts for the primary@5 gap on BM25. Whether it also explains the gap to U2 stemmed+emb was not isolated (the stemmed run was the `mem` table, unstemmed here is `docs`; path tokens in the FTS body may differ).
- Index cost is ~28x the time and 1.6x the size of per-file indexing.

## Round 11 — stemming vs path differences (isolation)

Script: `poc/tinymem-round11-poc.mjs`. Outputs: `~/.cache/tinymem-probe/out/stage11/`
(`results.json` sha256 `4fa8ec4340391c3deddb4a4bb417056e6b412d044c27deef695f4260c5c07713`,
`report.md` sha256 `dd71362b03f51a396234155bf8a1ee602bd667d698d1da8f98744aa9b8e3df1b`).

Question: round 10's unstemmed `docs` sections scored prim@5 askA .35 (C2) vs round 9 U2's .50.
Is that stemming, or other differences between the `mem` path and the `docs` path?

Setup (one change per step, same 1,607 sections, questions, gold + gold-extra + gold-extra2, scoring):
- S1 = round 10 C1 re-run (unstemmed `docs`, BM25 only, shipped `recall`). Reproduces round 10 C1 on all 40 asks.
- S2 = the SAME FTS column values copied row by row (all 7 columns, 1,607 rows, from the round-10 db) into a
  `tokenize='porter unicode61'` table; same `ftsMatch` query, same `-bm25(t)` call, `ORDER BY score DESC LIMIT 400`. Only the tokenizer differs.
  `docs` = `fts5(... body)` default unicode61 (`src/store.js:118`); `mem` = same plus `tokenize='porter unicode61'` (`src/store.js:221`).
- S3 = S2 pool + the shipped fusion (`minmax(score) + 1.0*minmax(cosine)`, `src/index.js:870-898`, pool 400, vectors from the round-10 `mem_embeddings`).
- Controls: S1 equals an own-SQL copy of the unstemmed table on 40/40 asks (so the `doc_scope` JOIN and import-spreading are no-ops here: no edges, no scopes);
  my fusion equals shipped `recall` on 40/40; shipped recall equals round 10 C2 on 40/40; re-scored round 9 refs equal stored metrics.

Numbers (extra2 gold, 20 questions):

| config | prim@5 A | prim@5 B | prim@10 A | prim@10 B | any@5 A | any@5 B |
|---|---|---|---|---|---|---|
| S1 unstemmed BM25 | .40 | .35 | .40 | .40 | .85 | .80 |
| S2 porter BM25, same text | .50 | .40 | .55 | .50 | .85 | .85 |
| S3 S2 + shipped re-rank | .50 | .40 | .65 | .60 | .95 | 1.00 |
| ref round 9 U2 stemmed BM25 | .50 | .40 | .55 | .50 | .85 | .85 |
| ref round 9 U2 stemmed + emb | .50 | .40 | .65 | .60 | .95 | 1.00 |
| ref round 10 C2 (unstemmed + re-rank) | .35 | .40 | .55 | .50 | .90 | .95 |

Pooled over A+B (40 asks): prim@5 S1 .375, S2 .45, S3 .45; prim@10 .40 / .525 / .625; any@5 .825 / .85 / .975.

Read:
- S2 equals round 9 U2 stemmed BM25 on the top-10 sections of all 40 asks (0 differences). Stemming is the whole BM25 gap; nothing else in the `mem` vs `docs` path moves BM25 ranking.
- S3 matches U2 stemmed+emb on every metric, though 8 of 40 top-10 lists differ (U2's KNN nominees on the memory path, not available to `docs`); the metrics do not move.
- So the .35 vs .50 askA gap in round 10 (C2 vs U2 emb) is stemming; the embedding re-rank behaves the same on both tables.
- Flips (primary rank, 0 = not in top 10; "extras" = gold-extra/extra2 keys for that question):
  - askA S1->S2: q01 0->4, q05 0->3 (both enter primary@5; q05 has 6 extras). askA S2->U2: none.
  - askB S1->S2: q03 0->2 enters primary@5; q06 0->10 and q19 (any@5 only), q13 10->0 (any@5 out). askB S2->U2: none.
  - S2->S3 (not asked, for context): askA q14 4->0 out of primary@5, q19 0->2 in; askB q06 10->5 in, q08 5->0 out.
- Primary@5 scores only the original primary key; the graded extras influence any@5 only. The 2-3 primary@5 flips per ask
  are real rank moves (0 vs 2-4), not borderline-5 effects, and none depends on the disputed grader verdicts. The any@5
  flips (q06, q13, q19 on B) are the grader-sensitive ones.

Differences between the `mem` path and the `docs` path, besides the tokenizer (none of them changed BM25 order here):
- FTS body: identical. Both write `indexBody({ path: m.id, body: m.text })` (`src/store.js:624` mem, `:648` docs). Round 9 ids were `file::a-b`, round 10 `file#a-b`; both split to the same path tokens.
- Columns: `docs` has an extra `source` column (`store.js:118` vs `:221`), UNINDEXED in both, so no effect on BM25. No column weights are passed in either: `-bm25(docs)` (`store.js:1689`) vs `-bm25(mem)` (`store.js:1669`); only `body` is indexed.
- Query building: same `ftsMatch` and same `_rankKind` entry (`index.js:859-866`).
- SQL: `docs` fetches `min(max(limit,200),400)` rows then runs import-spreading (`store.js:1683`, `:1696`); `mem` is `LIMIT :limit` with no spreading (`store.js:1674`). Spreading is a no-op without edges (control above).
- Fences: `doc_scope` JOIN + expiry (docs) vs `mem_scope` owner/session JOIN (mem). No scopes set, so no effect.
- KNN nomination: only for `MEM_KINDS` (`index.js:866`, `store.js:1968`). docs gets re-rank only. Changed 8 top-10 lists, no metric.
- `Hit.cosine` surfaced on mem only (`index.js:889`); not a ranking term.
- Vectors: both use `mem_embeddings` (written rows), same input text.

## Round 12 — fresh questions, two repos (stemming re-check)

Script: `poc/tinymem-round12-poc.mjs`. Outputs: `~/.cache/tinymem-probe/out/stage12/{results.json,report.md}` (results sha256 `171d7ea1d0837035880b4988e8aafd4b7d84f48db4e694f601def1b6e8fa68aa`, report sha256 `a3410a4b52b1c911d34978ae865e278e41258ceee916785796790e79b3c45fac`). Questions: 30 per repo, written blind, never seen by any retrieval (bareloop.json sha `cce11be3...8085`, bareagent.json sha `d6cb21d8...3c7`, both verified first).

Setup: litectx md chunker sections, one `doc` row each via `remember()`, embeddings ON, round-11 mechanics. S1 unstemmed `docs` BM25 | S2 same FTS rows in a `porter unicode61` table, same query + `bm25()` | S3 = S2 + shipped embedding re-rank | S4 = S1 + the same re-rank (new; round 11 lacked it). Scored at chunk level, primary key only, no graders. Primary mapping: question `line` is 1-based, chunker `startLine` is 0-based, so the section is the one with `startLine == line - 1` in that file (first line also checked to contain the heading). 0 unmapped primaries on both corpora. S1 and S4 match the shipped `recall` (no embeddings / embeddings) on 30/30 questions per corpus.
Corpora: bareloop = the round 9/10/11 corpus (59 files, 1607 sections). bareagent = all `git ls-files '*.md'` at HEAD 4de9da27 (confirmed), 40 files, 832 sections; excluded CHANGELOG.md (release history), docs/index.md and docs/archive/wiki-index.md (both generated by docs-builder, state "never hand-edit"); no node_modules entries.

Pass bar (fixed before running): Stemming is CONFIRMED if, on BOTH corpora, S2 > S1 on primary@5 AND S3 > S4 on primary@5, and in each comparison stemming loses at most 2 questions that unstemmed had in the top 5. Win on one corpus and tie on the other = WEAK. Tie or loss on both = NOT CONFIRMED.

| corpus | cfg | p@1 | p@5 | p@10 | MRR@10 |
|---|---|---|---|---|---|
| bareloop | S1 unstemmed | 12 | 22 | 23 | .539 |
| bareloop | S2 porter | 17 | 24 | 24 | .658 |
| bareloop | S3 porter + re-rank | 21 | 27 | 27 | .771 |
| bareloop | S4 unstemmed + re-rank | 18 | 25 | 27 | .710 |
| bareagent | S1 unstemmed | 10 | 19 | 25 | .493 |
| bareagent | S2 porter | 17 | 22 | 25 | .656 |
| bareagent | S3 porter + re-rank | 17 | 22 | 27 | .667 |
| bareagent | S4 unstemmed + re-rank | 18 | 23 | 26 | .673 |

Verdict: **WEAK**. bareloop meets the bar (S2-S1 = +2, S3-S4 = +2, stemming loses 0 in both). bareagent meets S2 > S1 (+3, loses 1 of S1's top 5, gains 4) but fails S3 > S4 (-1: S3 22 vs S4 23). One corpus passes, the other does not; it is not a tie or loss on both, so not NOT CONFIRMED.

Read:
- Stemming reliably helps BM25 alone (p@1 12->17 and 10->17, MRR +0.12 and +0.16 on the two repos). With the embedding re-rank on, the p@5 gap shrinks to +2 on bareloop and reverses to -1 on bareagent; the re-rank takes over most of what stemming gives.
- Movers S1->S2 (bareloop 2, bareagent 5; all primary@5 entries except ba05): 6 of 7 have question~section word-form differences consistent with stemming (agree~agreed, report~reporting, park~parked, fire~fires, mean~means, app~apps, ...). ba05 (S1 5 -> S2 6, loses) has no word-form difference: a BM25 length/idf shift from stemmed term merging, not a form match.
- Movers S4->S3: bl08 (6->1, agree~agreed, change~changed, message~messages) and bl29 (25->5, pause~paused, answer~answers) are word-form driven; ba25 (4->8, loses) has no word-form difference between question and primary section, so that loss is not explained by forms.
- The one-question margins (bareagent S3 vs S4) are within what 30 questions can resolve; the claim supported is "stemming helps without embeddings, and the benefit with embeddings is smaller and not consistent across repos".

## Round 13 — whole-file baseline on fresh questions

Script: `poc/tinymem-round13-poc.mjs`. Outputs: `~/.cache/tinymem-probe/out/stage13/{results.json,report.md}` (results sha256 `502a4de281c15ba55336a0b9be2fa39ee9cd2d11b5cd27ae3e88e6b9ee158b3f`, report sha256 `a8300febdbf3314f14efbc79813ff63b76c7696a505ab23d6694d36aefcfb127`).

Setup: SHIPPED code, unmodified. Same round-12 question files (hashes verified) and identical corpora (bareloop 59 files; bareagent HEAD 4de9da27, 40 files, same exclusions), written to a fresh root and indexed with `ctx.index()` (one `docs` row per file; indexed doc count == corpus file count checked), then `recall(q, {kind:'doc', n:10})`. F1 embeddings off, F2 embeddings on. STRICT = hit.path == primary.path AND `chunk.startLine == primary.line - 1`; FILE = path only. S1/S4 not re-scored from scratch; re-run on 5 questions per corpus against the saved round-12 sections dbs and all 10 ranks reproduced exactly.

Pass bar (fixed before running): Sections beat whole files if, on BOTH corpora, round-12 S4 (sections + embeddings) beats F2 (STRICT) on primary@5 by >= 3 of 30, AND S1 beats F1 (STRICT) by >= 3 of 30. Tie or smaller margin on either corpus = NOT CONFIRMED.

| corpus | cfg | p@1 | p@5 | p@10 | MRR@10 |
|---|---|---|---|---|---|
| bareloop | F1 strict | 7 | 12 | 13 | .306 |
| bareloop | F1 file | 8 | 17 | 18 | .390 |
| bareloop | F2 strict | 7 | 13 | 14 | .312 |
| bareloop | F2 file | 10 | 19 | 20 | .457 |
| bareloop | S1 (r12) | 12 | 22 | 23 | .539 |
| bareloop | S4 (r12) | 18 | 25 | 27 | .710 |
| bareagent | F1 strict | 10 | 12 | 13 | .366 |
| bareagent | F1 file | 12 | 18 | 22 | .487 |
| bareagent | F2 strict | 8 | 11 | 14 | .322 |
| bareagent | F2 file | 12 | 19 | 25 | .510 |
| bareagent | S1 (r12) | 10 | 19 | 25 | .493 |
| bareagent | S4 (r12) | 18 | 23 | 26 | .673 |

Verdict: **CONFIRMED**. Margins at p@5 (STRICT): bareloop S4-F2 = +12, S1-F1 = +10; bareagent S4-F2 = +12, S1-F1 = +7. All four clear the >= 3 bar.

Read:
- Strict is the fair comparison for section-level questions, but the file-level reading is the upper bound for whole-file search: even there S1 beats F1-file on p@5 (22 vs 17, 19 vs 18) and S4 beats F2-file (25 vs 19, 23 vs 19); the bareagent S1 vs F1-file gap (+1) is within noise at 30 questions. The p@1 and MRR gaps are larger than the p@5 gaps.
- Right file in top 5 but pointer on the wrong section (or null): bareloop F1 5 of 17, F2 6 of 19; bareagent F1 6 of 18, F2 8 of 19. Roughly a third of right-file hits point at a different section, so the shipped chunk pointer does not close the gap.
- Embeddings on whole files barely move STRICT p@5 (+1 bareloop, -1 bareagent) but lift FILE p@10 on bareagent (22 to 25).
- Caveat: indexing a non-git root logs harmless `fatal: not a git repository` from the git-signal step; no effect on results.

## Build: md sections as rows (0.34.0, unreleased)

- First build put doc rows in the shared `docs` FTS table. That perturbed code BM25 statistics: aurora-mixed HARD MRR fell 0.447 to 0.294. Fix: a separate `doc_fts` table. After it, ALL MRR 0.552, P@5 77%, HARD 0.414, rank-for-rank identical to py-only.
- Clobber repro `poc/tinymem-verify-A.mjs` now prints "A recall after B: 1" (tenant B ingesting A's filename no longer deletes A's doc). Direct docs are keyed in their own namespace (`scope\x1Eid`, global `\x1Eid`); the first build keyed them `owner\x1Fid`, which collided with facts (see the review findings below).
- Tests are mutation-verified: breaking one tenant lock does not leak, breaking both does.
- Fresh-question scores through the built code held (top 5 of 30 questions per corpus): bareloop 22/30 embeddings off, 25/30 on; bareagent 19/30 off, 23/30 on.
- The bench, impact, memory, assemble and summary benches are byte-identical to before.
- Cold first index with embeddings on: bareloop ~146 s, bareagent ~42 s; db 7.6 to 12.4 MB on bareloop.
- Review findings, all reproduced, then fixed: (1) a tenant doc `x` and tenant fact `x` shared `mem_text`/`mem_meta`/`mem_embeddings`/`recall_log` (doc recall returned the fact's body, forgetting the fact deleted the doc), and the global tier had the same collision since main; (2) opening a main-written db with a doc and fact of the same id threw `UNIQUE constraint failed: mem_text.path` on every open, and a mixed-version db threw on `doc_scope.path`; (3) the `doc_fts` migration dropped indexed md rows but left their `file_index` entries, so a consumer running only `index({ paths })` never got them back.
- Fix: docs get their own key namespace in both tiers (`scope\x1Eid`, global `\x1Eid`; facts unchanged, `\x1E` rejected on write like `\x1F`). The migration converts bare-global, bare-scoped (main) and `scope\x1Fid` (this branch) rows; it copies a sidecar while a fact still owns the old key, moves it otherwise, lets the migrated (newer-write) row replace an existing target, never throws, and is idempotent. The md migration now invalidates `file_index` entries. Lesson: a key convention shared by two axes is a collision waiting for the first same-id pair, so the second axis needs its own namespace, and a migration must be tested against a db that already contains the collision.
- Three extras were built, reviewed, then dropped as unreachable for multis (the owner's call; the main fix stays): (1) key-type-aware `memId(key, kind)` and per-table forget public-id SQL for legacy ids holding `\x1E`; (2) recovery of a shared doc/fact `mem_text` collision from the FTS body (`indexBody` inverse); (3) tenant `get(id)` preferring the tenant's own doc over a shared fact. Reason: none arises in the real multis case (customers uploading files by name; facts and docs do not share ids; no `\x1E` ids in the wild), and each added code and test surface. They are listed as known limits in the 0.34.0 changelog, each with its un-defer condition. `memId(key)` strips at the first `\x1E` or `\x1F`; the migration's "already migrated" test is "key contains `\x1E`"; `get` is tenant fact, shared fact, then one doc query.
- Regression test for the real case: `[MULTIS]` in `test/doc-key-namespace.test.js` (KB file, admin file, a customer uploading same-named files); mutation-verified against bare doc ids.

## Build: row-number lookups and fence (0.34.0, unreleased)

Problem: `doc_fts.path` is an UNINDEXED fts5 column, so every by-path `get`, replace and delete read every body. At 100k doc rows: `get` 95 ms, `remember` 44 ms, md `ingest` 234 ms, doc `recall` with `body:true` 187 ms. POC `perf3` (variants v0..v6b, 11 matrices, sizes 3k to 100k plus bareloop) picked the design.

- Rejected: a separate pointer table (`doc_ptr`: row number to path/source). Fast, but an older litectx writing to the same db replaces rows without touching it, so the table goes stale. `scratchpad/perf3/foreign.mjs` showed a rowid reused by another tenant resolving to the wrong owner: a cross-tenant read in a test. The pointer has to live where an older writer already rewrites it.
- Chosen: `doc_scope.rid`. Every direct doc already has a sidecar row that an older writer deletes and re-inserts with the doc, so a stale pointer shows up as NULL (never as a wrong number). NULL is repaired by a heal: an O(1) probe through a partial index (`WHERE rid IS NULL`) at the top of every doc search, and heal-on-miss in `getItem` / `getItemByKey`. `rid = -1` marks a sidecar with no row behind it so the probe does not fire forever. Every lookup also checks the fetched row's own key, so a wrong pointer finds nothing instead of the wrong doc. `migrateDocFts` nulls every `rid` (new row numbers); the one-time column backfill also creates the sidecar for a legacy direct doc that never had one (NULL scope/expiry = global, forever, undated, identical to absent). An indexed md file is found through `doc_sections.doc_rowid`.
- Search: the scope/expiry fence is joined by row number in the top-N query (it must run before the LIMIT), and path/kind/format are read for the winners only. Doc kind skips the import-edge query (docs have no edges). `_chunkState` takes a per-recall cache so a file is read and hashed once per recall.
- Letter case (found in port): the POC narrowed ingest's `forget({idPrefix})` with a plain key range, which made it case-sensitive where the original `LIKE ... ESCAPE` is ASCII case-insensitive. Fixed by ranging only on the tenant part of the key (`scope\x1E` to `scope\x1F`, exact case, already demanded by `d.scope = @owner`) and keeping `LIKE` as the test on the id. Pinned by `[CASE]` in `test/doc-rowid-pointer.test.js` and run against the old build to confirm identical results.
- Also routed by row number in the port: the owner-blind `forget({id|kind})` (the POC had left it scanning `doc_fts` twice).
- Numbers at 100k rows (median ms, before to after): get 95 to 0.3, get missing 115 to 0.25, md file 121 to 0.3, section 119 to 0.56, remember 44.5 to 0.3, md ingest 234 to 3.0, recall n=5 37 to 14, recall body 187 to 16. 3k: get 2.2 to 0.35, remember 2.8 to 0.33. Store open pays the one-time backfill (129 to 225 ms at 100k); a second open does nothing. 360 returned objects compared against the old build: 0 differ.
- Tests: `test/doc-rowid-pointer.test.js`, 15 tests, mutation-verified (no probe in search, no `rid` nulling in `migrateDocFts`, fence joined on the wrong key, no heal-on-miss in `getItem`/`_docRowid`/owner-blind forget, no NULL-rid fallback in the delete, case-sensitive range): each goes red for its own reason.
- Not fixed, measured (code table `docs`, same unindexed-path problem, 1 row per file): `DELETE FROM docs WHERE path = ?` runs per upserted file in `applyChanges` and costs 0.4 / 2.2 / 5.6 ms at 2k / 8k / 20k code files (about 0.28 ms per 1k rows); `getItemByKey` of a direct doc or md key and `get` of a missing id fall through to a `docs` scan: 0.5 / 2.4 / 5.8 ms; `get` of a code file indexed late: 0.6 / 2.3 / 5.3 ms. Cold `index()` of N code files is super-linear: 0.9 s at 2k, 10.7 s at 8k, 62 s at 20k, 800 s at 60k (old build). Un-defer: a consumer indexing 10k+ code files.
