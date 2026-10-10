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
- The bottleneck is FINDING, not organising. Doc recall returns one section per file. (superseded 2026-10-09: see Step 4)

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
- Code table `docs` fixed too (same pattern, `file_index.code_rowid`; -1 = doc file, NULL = legacy, filled by an open-time backfill or on first use via a one-time scan). The scan fully explained the cold-index super-linearity: cold `index()` before to after 2k 1.7 to 0.85 s, 8k 14.2 to 2.9 s, 20k 71 to 6.8 s (about 0.35 ms per file, flat); 60k now 49.5 s (0.83 ms per file, so something else appears above 20k; not investigated; the old build took ~800 s). Per call at 20k: get of a late code file 6.1 to 0.36 ms, get missing 6.4 to 0.26 ms. Not improved: reindexing one changed file (212 ms at 20k, 1.8 s at 60k) and a no-op `index()` (188 ms at 20k) are dominated by the file walk, not by `docs`. Tests `test/code-rowid-pointer.test.js` (11, mutation-verified). Recall/impact on this repo identical to the old build (impact caller order differs run to run on the old build itself; sorted, identical).

## Answer test — go/no-go 1 (2026-10-07)

Question: does an agent with litectx search answer "what did we decide about X" better than an agent with plain grep, at the same or lower cost? Verdict: **NOT CONFIRMED**.

**Setup.**
- Two corpora, frozen copies. bareloop: 71 docs and 139 sessions. bareagent: 43 docs and 75 sessions. Sessions were converted to md with only the user and assistant text. Headless SDK runs and sessions with no human turns were left out.
- 30 questions per repo: 15 about docs and 15 that only a session can answer. Written blind by a separate worker, each with a gold answer and a list of must-have facts.
- Three arms, one fresh `claude -p` run (sonnet, max 15 turns) per question and arm:
  - A: litectx `recall` and `get` only (branch build, embeddings on).
  - B: Read, Grep and Glob over the same files.
  - C: no tools. This is the floor, to catch questions the model can answer from general knowledge.
- Grading: a blind sonnet grader, arm labels stripped, order shuffled, one question per call. It sees the question, the gold, the must-facts and the corpus, and opens the cited lines. A **win** is correct (all must-facts, nothing contradicting gold) and cited (a citation whose lines really hold the answer).
- Tokens = input + cache creation + cache read + output.

**Pre-registered bar** (written 2026-10-06, before any question ran; PREREG.md sha256 `4c082a807bb15d5a5877d013a5d89c458619e07a7cd7226a995b87d313a9dd6c`; questions files sha256 bareagent `9d066049f2e93b1f3d3259ccd0af2bf4f836aac1d6eeb384b5e4ad4592a27d57`, bareloop `8acb95a114ec7ad94ec01fb529c361a7786863a9b653894ef527a793131165bc`).
- Pass only if, on BOTH repos: wins(A) >= wins(B) + 4 of 30, and median tokens(A) <= median tokens(B).
- A tie or loss on either repo is NOT CONFIRMED.
- If C wins 5 or more on a repo, that repo's questions leak general knowledge.

**Results** (wins of 30, correct and cited).

| Repo | A wins | B wins | C wins | Median tokens A | Median tokens B |
|---|---|---|---|---|---|
| bareagent | 20 | 26 | 0 | 13,011 | 34,908 |
| bareloop | 18 | 19 | 0 | 12,521 | 39,855 |
| both | 38 | 45 | 0 | 12,795 | 35,625 |

By question type (wins, A vs B):

| Slice | A | B |
|---|---|---|
| bareagent docs (15) | 11 | 13 |
| bareagent sessions (15) | 9 | 13 |
| bareloop docs (15) | 10 | 10 |
| bareloop sessions (15) | 8 | 9 |
| both, docs (30) | 21 | 23 |
| both, sessions (30) | 17 | 22 |

- The token half of the bar passed on both repos: A used about a third of B's tokens. The wins half failed on both: A was 6 behind on bareagent and 1 behind on bareloop, where the bar needed 4 ahead.
- C scored 0 wins on both repos, so the questions do not leak general knowledge.
- Cost of the answer runs: A $1.78, B $4.50, C $0.28 (60 questions each).
- Update 2026-10-07: this single-run gap is within the measured run-to-run noise (about 1 in 4 partial answers flips to a win on a plain re-run). See [Neighbour fetch diagnostic + control](#neighbour-fetch-diagnostic--control-2026-10-07).

**Why A did not win.**
- A cited real lines almost every time (59 of 60). Wrong or invented sources were not the problem.
- Of the 22 questions A did not win, about 18 found the right section but stopped before the neighbouring section that held the rest of the answer. They were graded partial. With only search and a pointer, the agent took the hit and answered. Grep-and-read agents opened the whole file and saw the neighbours.
  - Caveat: this is the grader's reading of the answers. No tool traces were saved, so it is not yet confirmed from the calls.
- 2 failures were the wrong session.
- 1 was a superseded decision. An older session said context windows never overflow; a later finding said they do (on a weak model, 3 of 4 runs crossed the limit). A returned the old session and answered with the old decision. Nothing in search says "newest wins".

**Audit.** The orchestrator skimmed the 12 seeded-random audit items (seed 777): the grader's quoted evidence and reasons for the items it read were consistent with the verdicts, but it did not re-read every answer and cited range in full — this is a light check, not an independent re-grade.

**Harness incidents.**
- A logout killed some runs mid-way. They were re-run.
- 45 results were the "session limit reached" message, saved as if they were answers. They were set aside and re-run, and a guard was added so a limit message cannot be saved as an answer.
- No tool traces were saved, so we cannot say exactly which calls each arm made. Save them next time.

**Cost of the test.** Answers $6.56, grader $3.51.

**What carries forward.**
- Search alone is not enough, and neither is grep alone: grep wins on answers, search wins on tokens. The next test gives one agent both, plus a way to fetch the neighbours of a hit. See the PRD, "Next, in order".
- Do not reuse these 60 questions for a confirming run; they have been seen. Write fresh ones.

## Neighbour fetch diagnostic + control (2026-10-07)

Question: did arm A stop short, so that fetching the neighbouring sections would flip its non-wins? Verdict: **the neighbour effect is not separable from noise at this size.**

**Setup.**
- Arm A2 = arm A with one change: `get <path> --lines A-B` also prints the previous and next section of the same file, marked. Same model (sonnet), max 15 turns, same prompt except one clause in the `get` description. Scripts: `poc/tinymem-neighbour-{run,append,grade}.mjs`.
- Run on the 22 questions arm A did not win in go/no-go 1 (20 partial, 2 no), plus 3 of A's original wins as a check. Full tool traces saved for every run.
- These 22 questions were already seen. This is a diagnostic, not a confirming run.
- Graded by the same blind grader and prompt as go/no-go 1.

**A2 result.**
- 9 of the 22 flipped to a win. The 3 original wins held. Median tokens about 14.5k.
- Cost: runs $0.92 (25 runs), grading $0.70, about $1.62 in all.

**Trace breakdown** (what the calls show, not the grader's reading):
- 5 of the 9 flips had a gold range only in a neighbour section: bareagent d02, s07, s08, s14, and bareloop s08 (bareloop s08: the gold range lies only inside a neighbour).
- Source of the 5/5/6/2 trace breakdown: the first diagnostic worker's overlap analysis of the traces. It is not stored as a file.
- Of the 13 still failing: 5 never reached the gold source (retrieval, or the wrong session); 6 reached the right file but needed sections that are not adjacent; 2 read the right section and still missed facts.
- So "about 18 stopped short" from go/no-go 1 is not supported as stated. Most non-wins are not a missing neighbour.

**Control.**
- Plain arm A re-run on the same 22, same runner, no neighbours. Control and A2 answers were graded together in one blind, shuffled pool of 44.
- Control won 6 of 22; A2 won 9 of 22. Overlap 4, A2 only 5, control only 2. Sign test on the 7 discordant questions: p about 0.45.
- The control also won 4 of the 9 questions that A2 flipped, with no neighbours. So even the flips are partly noise.
  - Of the 5 neighbour-supplied flips, the plain re-run also won 3: bareagent d02, bareagent s07, bareloop s08. So 3 of the 5 are not clean neighbour effects either.
- A2's grade in the joint pool differed from its first grade on 2 of 22 items. That is grader noise.
- Median tokens equal (control about 14.8k, A2 about 14.5k).
- Cost: runs $0.69, grading $0.84 (the 44-item pool includes the A2 re-grades), about $1.53 in all.

**What this means.**
- About 1 in 4 partial answers flips to a win just by running again. Run-to-run noise on one question is large.
  - Caveat: the 22 were picked because arm A failed them, so this overstates the flip rate for an average question. The size of the noise on unselected questions is still unmeasured.
- Go/no-go 1's 38 against 45 single-run gap is therefore not solid either way. It is neither a clear loss for search nor a clear win for grep.
- Neighbour fetch stays in the hybrid arm: it is cheap, and 9 against 6 is not evidence against it. It is unproven. Nothing goes into `src/` on this evidence.
- Owner decision (2026-10-07): handle the noise with repeats per question, not more questions. Writing blind questions is the slow part; repeats are only machine time and a few dollars.
- Step 1 PREREG written and approved 2026-10-07 (40 fresh questions, k = 3): `poc/tinymem-step1-PREREG.md`, sha256 `b5f0949fe0030a3c6d36febfe2ba914cf1097c8ff5771622b1f06bd1422e9675`. The go/no-go 1 PREREG (sha256 `4c082a80...`) is not in the repo; only its hash is recorded here.
- Step 1 questions frozen 2026-10-07: bareloop sha256 `9ac3ba15742e6b4e8a9d780fe22440754553ab5b3e5435e84791a55cdc77bf73`, bareagent sha256 `26e0284dd52b401fa7653c41cab3b6395acbfef30e4b1e8c10cd8ba4af1fde4a`. 40 questions written blind (Sonnet), audited read-only by Opus: 20 FIX + 20 OK; 22 changed (the 20 FIX plus 2 OK-with-nit: bareloop d01, bareagent d01; 3 severe: bareloop s05, d07, d02 — gold superseded/wrong chronology), 0 replaced. The questions are never edited after this.

## Lessons from LlamaIndex's document-search talk (2026-10-07)

The owner found this very relevant. Each point is tied to our own evidence.

- **Grep is enough at about 100 to 1,000 files.** Search earns its keep at thousands of files and up, where reading every time burns tokens. Our corpora (118 and 210 files) were grep's home ground, and grep still cost about 3 times the tokens.
- **Search is a compass, not a replacement.** Give the agent search and grep and read, and let it choose. Our test pitted litectx-only against grep-only, which is the setup they argue against.
- **Fetch context around a hit.** Read by offset and length around the chunk. Our main failure was stopping at the hit without the neighbouring section.
- **Hybrid ranking.** Keyword and vector fused, then a re-ranker over the top 100 or so. Ours: BM25 gates, vectors only re-order. Round 10 found nomination added nothing on retrieval, but that is untested on answers. A local re-ranker with no LLM fits the no-LLM-inside rule.
- **Metadata filters** (date, source type, folder) let the agent narrow first. This could also fix the superseded-decision failure: newest wins.
- **Freshness and sync of the index** is why Claude Code skipped vectors. litectx has an incremental index and self-heal stamps. The open cost: a growing session file may re-chunk and re-embed the whole file. The first full index with embeddings took about 19 minutes (bareloop, about 13k session sections, CPU embedding). Solvable later: embed only new sections, batch, use a lighter or static model.
- **Layout-faithful parsing** (LlamaParse, and the open-source LiteParse) for tables and scans. Our pdf and docx conversion is weak on tables. LiteParse is local, open source, and a TypeScript library. PDF is native; Office files (docx, xlsx, pptx) go through LibreOffice to PDF; images go through ImageMagick to PDF plus OCR. It outputs markdown, JSON or text with bounding boxes. Sources: https://github.com/run-llama/liteparse and https://www.llamaindex.ai/blog/liteparse-local-document-parsing-for-ai-agents. Relevant to multis PDF manuals and tables.
- **Permissions pushed into the storage layer** is what our scope fences already do, and they are tested.
- **Sub-agents re-reading documents** are heavy in tokens and time. This agrees with the cost gap we measured.
- **Not adopted:** page screenshots and multimodal rendering. It needs image handling and is not lean.

## Step 1 v2 PREREG and padding facts (2026-10-07)

- PREREG v2 sha256 `8e13b70c3b1d252ba897a003c442d0fad57c37e9c76a1d7c23c973a0ba10a2e0` (`poc/tinymem-step1-PREREG-v2.md`); harness `poc/tinymem-step1.mjs` sha256 `e0f6ac68efad61dd14541f32422c583f1678eeb34ae109da2687afabd114a063`. The grader now reads the corpus through a neutral opaque symlink (hides `root5x` vs `answer`); the `_pad` folder name still shows when a padding file is opened, a stated limit.
- Padding: sizes are about 5.3x (bareagent) and about 3.6x (bareloop) by bytes, not 10x. Padding is doc-heavy (about 82% docs versus 36% at 1x; only 186 clean session files exist).
- Contamination: the `bareloop-close` docs were removed from bareloop padding (own material). bareloop-d06 has a second valid source and an older-version trap in `sessions/_pad/2026-07-10-adaptlearn-d8fc76dd.md`. Reported with the result, not removed.


## Step 1 v2 — hybrid vs grep at 1x and ~5x (2026-10-08)

Question: does an agent with litectx search AND grep/read (D) answer at least as well as a grep/read-only agent (B), cheaper, at 1x and at about 5x? And does the gap grow with size? Verdict per the PREREG outcome table: **FAIL-WORSE at 1x, FAIL at ~5x, gap does not grow. The hybrid is dropped as the plan.**

**Setup.** 40 frozen questions, k = 3, D vs B at both sizes, C once at 1x as the leak floor, one joint blind grading pool. Bar and rules: [`poc/tinymem-step1-PREREG-v2.md`](../../poc/tinymem-step1-PREREG-v2.md) (sha256 `8e13b70c3b1d252ba897a003c442d0fad57c37e9c76a1d7c23c973a0ba10a2e0`). Source of the numbers: `~/.cache/tinymem-probe/out/step1/pool/score.md`. 520 runs graded; no incomplete runs.

**Results** (win rate = mean wins/k per question; tokens = median over runs; d = D minus B per question).

| | D win rate | B win rate | mean d | up/down | token ratio D/B | outcome |
|---|---|---|---|---|---|---|
| 1x | 0.617 | 0.742 | -0.125 (se 0.060) | 5/13 | 0.69 | FAIL-WORSE |
| ~5x | 0.658 | 0.717 | -0.058 (se 0.065) | 8/9 | 0.63 | FAIL |

- Per repo, mean d at 1x: bareloop -0.117, bareagent -0.133. At ~5x: bareloop 0.000, bareagent -0.117.
- Wilcoxon p (one-sided, D better): 0.974 at 1x, 0.836 at ~5x. Ties dropped: 22 and 23 of 40.
- Only the token bar (<= 0.75) held, at both sizes. The win bars failed.
- Turn cap: no run hit it, in any arm. Mean turns: D 4.6 (1x) and 4.7 (~5x); B 5.0 and 5.2.
- C floor: 0 wins on both repos, so no leak flag.

**Slices** (D minus B).

| Slice | 1x | ~5x |
|---|---|---|
| docs (20 q) | +0.017 | +0.083 |
| sessions (20 q) | -0.267 | -0.200 |
| neighbour_spanning (29 q) | -0.080 | -0.023 |
| superseded (23 q) | -0.130 | +0.043 |

On docs, D matched B or slightly beat it, at about 60% of the tokens. On sessions, D lost at both sizes.

**Scale.** g = d(~5x) minus d(1x) per question, paired on 40 questions.
- Mean g +0.067 overall (bareloop +0.117, bareagent +0.017).
- Sign test, one-sided: p = 0.067 (15 positive of 22 non-zero; 18 zeros dropped). Wilcoxon on g, secondary: p = 0.113.
- Median token ratio D/B: 0.69 at 1x, 0.63 at ~5x (change -0.06).
- The bar needs mean g >= +0.05 AND p < 0.05. The mean passes and the sign test does not. **Gap does not grow.** The mean g is positive because D's loss shrank, not because D got ahead: D is still below B at ~5x.

**Cost.** Runs $26.52 + grader $19.09 = $45.60 (PREREG estimate $60-72; hard stop $90 not reached). Cost per run: D $0.034 / $0.036, B $0.071 / $0.078 (1x / ~5x). Grading: 520 first grades, 161 second, 12 third.

**Index times, ~5x.**
- bareloop: 44 min 58 s, 312 MB db, 71,684 sections, peak RSS 825 MB.
- bareagent: 37.5 min, 217 MB db, 52,306 sections.

**Why D lost on sessions: it stopped early.** (Corrected 2026-10-08: the trace autopsy below shows this reading was wrong. The cause is small read windows, not stopping early.)
- D typically made 2 to 4 calls and answered. B kept digging (more turns on average).
- Session answers are scattered and often superseded, so the first good-looking hit is often not the last word. D trusted search and stopped.
- Share of D runs (of 120 per size) that used grep or read at all, from the per-run tool list in score.md:

| | 1x | ~5x |
|---|---|---|
| all | 66/120 (55%) | 57/120 (48%) |
| docs | 25/60 (42%) | 22/60 (37%) |
| sessions | 41/60 (68%) | 35/60 (58%) |

- Every D run used litectx. So the agent did use grep/read on most session runs, but on fewer of them than the questions needed, and it fell with size. Whether those calls were the right ones is not read from the traces here.
- The per-run list shows tool use and call counts, not the reasoning. "Stopped early" is read from the call counts and turn means, not proven per run.

**Limits** (stated with the result).
- The 40 questions were written by a model that read the corpus with grep, so answers are grep-findable by construction. This likely favours B.
- ~5x is about 3.6x (bareloop) to 5.3x (bareagent) by bytes, and 8.8x (bareloop) to 10x (bareagent) by files. Padding is doc-heavy (about 82% docs against 36% at 1x), so ~5x tests docs growth more than session growth.
- The grader could infer the size from opened `_pad` files. Grading is not fully size-blind.
- D's instruction sentence is a tip that B lacks. It did not rescue D.
- One model family (sonnet). No human-checked gold. The real corpus (8,218 session files) was not tested.
- bareloop-d06 has a second valid source and an older-version trap in padding; reported, not removed.

**Verdict.** Per the PREREG table (FAIL-WORSE at either size), stop the hybrid; read how D used the tools (above). Grep is enough at these sizes. The hybrid is dropped as the plan. Neighbour fetch is not promoted: the neighbour slice shows no D gain (-0.080 at 1x, -0.023 at ~5x).

## Trace autopsy and widened-fetch diagnostic (2026-10-08)

### A. Trace autopsy of the step-1 v2 D losses

Read-only, Opus, two repos. Question: why did D lose on sessions?

**Findings.**
- Search found the right file and section in nearly all losing runs.
- Citation format is ruled out. All runs cited (cited=yes) and the lx line numbers were 1-based and correct.
- The earlier wording "stopped early / trusted search" is wrong. D used grep or read on 68% (1x) and 58% (~5x) of session runs. The real cause is small read windows.

**Mechanism 1 (high confidence): the fetch window is too small.**
- `get` returned one section plus one neighbour on each side.
- Session logs are fragmented. Assistant turns average 8.6 lines, and one decision spans 5 to 20 sections.
- D read a median 35-line window; B read 75.
- Answers lay 3 to 5 turns past the window.
- In bareagent-s04 the previous neighbour held a superseded theory, and D repeated it.

**Mechanism 2 (medium-high): one compound query ranks a recap or stale section first.**
- bareloop-d07: rank 1 says "TBD"; the set values rank 15.
- bareloop-s10: rank 1 is the recap written after the decision.
- Short sub-question queries put the gold turns in the top 3 to 4.
- D won when one self-contained section held the answer (docs).

**Offline replay.** Widening D's real fetches to -30/+120 lines raised gold coverage to 85 to 100% on s02, s03 and s07.

### B. D-prime diagnostic (arm E)

E is D with only the tool output changed. The prompt is byte-identical.
- `get` returns the requested section, the previous section, and a forward budget (+120 lines for `sessions/`, +60 for `docs/`).
- `recall` adds a line "FILE <path>: N hits, lines a-b" for any file with 2 or more hits.

**Validated first.** Offline replay of 95 real D `get` calls: gold coverage rose on every loser (s04 23 to 100, s10 65 to 100, d08 50 to 100, s07 5 to 16, s03 18 to 50, d07 28 to 56) and no winner dropped. `get` output median grew from 2.8 KB to 9.3 KB (about 3x). A live pilot confirmed it.

**Run.** SEEN questions, k = 2, $3.31. Wins out of runs (old D / E / B):

| | 6 losers | 3 winners |
|---|---|---|
| 1x | 0/18, 8/12, 14/18 | 8/9, 6/6, 3/9 |
| ~5x | 1/18, 10/12, 14/18 | 8/9, 6/6, 7/9 |

- bareagent s04, s10, d08 and bareloop d07 flipped to 2/2 at both sizes.
- bareloop-s07 (0/2 at both sizes) and bareloop-s03 (0/2 at 1x) still fail. The top hit was wrong (recall surfaced other sessions). Widening does not fix that.
- Median tokens, 1x: D 26.6k, E 27.1k, B 35.4k. At ~5x: D 26.6k, E 29.3k, B 40.5k.

**Limits.** Seen questions, k = 2, 9 questions, not significant. This shows the mechanism, not a result.

**Score-column finding (display issue, not a ranking bug).** The CLI prints the pre-fusion BM25 score (`bin/litectx.js:65`). `LiteCtx.recall` re-sorts by the fused minmax(score) + embedWeight x minmax(cosine) (`src/index.js` about 938-946). So the printed score can disagree with the printed order. To fix separately.

### C. Owner direction (2026-10-08)

- No big paid run without a cheap validation run first.
- Claude session history is too fragmented. tinymem tests stick to md docs: questions about features and what was decided.
- Next: fresh docs-only questions (blind and audited), a ~$3 validation run of E against B, owner approval, then a pre-registered run.

- Step-2 questions frozen 2026-10-08: 27 docs-only questions (bareloop 15, bareagent 12), blind-written, Opus-audited (16 OK, 11 fixed, 3 dropped); sha256 recorded in [tinymem.md](tinymem.md#measurement-order).

## Step 2 — M1 offline coverage + M2 validation (2026-10-08/09)

### M1 (offline, no model)

Source: `~/.cache/tinymem-probe/out/step2/m1/report.md`, docs-only index, both repos, all 27 questions, verbatim query (Q1).
- Top n=8: any gold source found 93%, all gold sources found 67%. The superseded slice is the weak one: 100% any, 44% all.
- Top n=20: 100% any, 78% all. Mean rank of the first gold hit (at n=20): 2.5.
- Splitting into sub-questions (Q2) does not help: n=8 is 70/89 against 67/93 for Q1, and n=20 is 74/96 against 78/100.
- Grouping hits into file spans adds 3 to 4 points (n=8: 70/100, n=20: 81/100).
- The misses are other files, or sections far apart in the same file.
- Caveat: all-found is strict; some gold sources are redundant with each other, so a run can answer correctly with fewer.
- Docs-only 1x index with embeddings on: bareloop (71 files) 558 s, bareagent (43 files) 338 s. Both were built concurrently, so CPU contention inflates the times. Not investigated.

### M2 (validation run, E against B, docs-only)

- 10 questions, seed 20261008, 5 per repo; slices 5 single, 2 neighbour, 3 superseded. E against B, k = 2, so 20 runs per arm.
- Wins: E 20/20, B 20/20. Ceiling, no separation.
- Median tokens: E 24.5k, B 23.5k. Median lines read: E 182.5, B 106. Cost $2.70 (runs $1.67 + grading $1.03).
- 4 benign "no chunk at" errors in E (the agent asked for a range that is not a section). The frozen E sentence still mentions `sessions/`; known minor mismatch.
- Reading: on coherent project docs of 43 to 71 files, grep alone answers everything. The +60 forward window mostly inflates reading on docs.
- Validation-first saved a roughly $40 run that would have hit the same ceiling.

### Part 1 replay: tighter doc fetch (offline, calls held fixed)

Replayed the 41 E `get` calls under five fetch policies (`poc/tinymem-step2-fetch-replay.mjs`, table in `step2/m2/replay.md`). Median lines/run: P0 as run 182.5; requested only 46; prev+req+next 112; req+next 75; prev+req+20 fwd 120 (B 106). No policy keeps gold coverage at P0's level while cutting lines to B's. Caveat: a live agent may behave differently, and coverage counts only Read and `get` text, not recall or Grep output.

### Next (owner-approved 2026-10-09)

Paraphrase questions: wording differs from the docs, so grep needs exact terms. Written blind, audited, then a roughly $3 validation run.

## Step 3 — paraphrase validation (2026-10-09)

### Audit and freeze
- 16 paraphrase questions written blind; audit verdict 9 OK / 6 FIX / 1 dropped. Fixes: bareloop p01 (wording "tolerated", added CHANGELOG:54 and :3742 as accepted framings), p03 (added workflow-governance.md:100; two stale docs still say PARKED), p04 (removed leaked "out of memory"), p05 (30 s floor on the timeout, added metering-design:377-379), p07 (corroborating PRD:1017), p08 ("one paid trial", dropped the superseded last gold sentence; later state in CHANGELOG:1390-1395 and CLOSE-INTEGRITY-BUILD:84). bareagent p01 (dropped the time-span ask, docs disagree), p06 (reworded "decorated"). Dropped bareagent p03 (grep-easy). Kept bareagent p02 as easy-control. Final: bareloop 8, bareagent 7. Each fix notes "audit-fix 2026-10-09" in the question's notes; pre-fix copies are `*.prefix.json`. Sources are corpus-relative.
- FROZEN sha256: `bareloop.json` 6df121f58bb8451f8932504e1b6c164aaa8a44be1aec4b98f1607c3dcc945087, `bareagent.json` 953565cca50c9ab1a0abd2c3a71f3d39baacbec0b7e4c7001f3e3385c3909f6e.

### Validation run (docs-only, arms E and B, k = 2, x1, embeddings on)
- Picked 13 (all but bareagent-p02 and bareloop-p03). All 52 runs were made (pilot r1 kept; same config), but run cost was $2.88, so full grading would have broken the $4 stop. Graded the first 10 of the list (bareagent-p06/07/08 runs set aside in `m3/ungraded`, not graded): 40 runs, one blind pool, same grader, second-grade rule fired once (a partial, agreed), no third.
- Wins: E 19/20, B 20/20. Only miss: bareagent-p01 E r2 (partial). All other cells 2/2 vs 2/2. Ceiling again; no separation, paraphrase wording did not make grep fail.
- Median tokens: E 23.7k, B 39.9k. Median lines read: E 136, B 132.5 (bytes 12.0k vs 20.2k).
- Finding cost (the point of the test): E's first recall listed a gold file in 15/20 runs (median rank 2; rank 1 in 6; top 5 in 12); with the section range overlapping a gold range 12/20 (median rank 1.5). B's greps to first touch of a gold file: touched 16/20, median 1.5 greps (mean 1.81; 1 grep in 8; 3 or more in 3); median total 2 greps/run. So grep found the files about as fast as litectx's first recall, with the agent's own wording.
- Spend: runs $2.877 + grading $0.963 = $3.84 (under the $4 stop).
- Caveat: validation only, k = 2, 13 questions picked (10 graded), one grader; at the ceiling it cannot show a difference in accuracy. The reliable difference is cost: B used about 1.7x E's tokens here.

## Step 4 — scale, nomination, cut-off, fairness, model (2026-10-09)

All free: no model calls, MiniLM unless stated. Scripts: `poc/tinymem-step4-m4.mjs`,
`poc/tinymem-knn-doc.mjs`, `poc/tinymem-cutoff.mjs`, `poc/tinymem-models.mjs`. Outputs are under
`~/.cache/tinymem-probe/out/` (`step4/m4`, `knn-doc`, `cutoff`, `fairness`, `models`).

### Scale: docs-only, 919 to 1,525 files (M4)

The same frozen questions were run against the docs padded with renamed docs from other projects
(padding folder `docs/ext`). Cell = questions where any gold source is found.

| Question set | Top 8, 1x | Top 8, padded | Top 20, 1x | Top 20, padded |
|---|---|---|---|---|
| Plain (27) | 25/27 | 25/27 | 27/27 | 27/27 |
| Reworded (15) | 8/15 | 8/15 | 11/15 | 8/15 |

- Plain wording holds at scale. Reworded holds at the top 8 but the tail thins: the top 20 loses 3 questions (11 to 8).
- Padding takes about 11% of the top 8 on plain questions and about 21% on reworded ones.
- Grep gets noisier too: for the two rarest words of each reworded question, the files containing either word go from a mean of 6.7 to 87 (about 13x).
- Index times with embeddings, run one at a time: bareloop 1x (71 files) 3:30 alone. The earlier 9:18 was CPU contention, so the old "558 s" figure in the Step 2 section is inflated. bareloop padded (1,525 files, 36,703 sections) 21:02, 167 MB db. bareagent padded (919 files, 21,852 sections) 11:53, 95.6 MB. The bareagent 1x was not re-run, so its old 338 s is still unchecked.

### Letting meaning nominate doc sections changed nothing

- Today doc recall takes a pool of up to 400 sections by word match and then re-ranks them with the meaning score. The test also added the 20 or 50 sections nearest by meaning to the pool.
- Result: identical to today on plain, reworded and the stress set. 0 better, 0 worse in every cell. The new entries never reached the top 8.
- Why: the 400-section pool is out of only about 1,100 to 2,300 sections, so it already holds what meaning would add. A control with the pool cut to 10 does make the nominees matter, so the harness works.
- The "no shared words" stress set (every question word that appears in the gold lines removed) was flawed. Read by hand, 7 of its 12 misses lost or flipped the meaning when the words were stripped (removed "no" or "never", word salad). Only 5 are valid evidence. Its "20%" found figure must not be quoted.

### Length cut-off ruled out

- litectx embeds the first 6,000 characters of a section, then the tokenizer cuts at 512 tokens. The model was trained at 256.
- Of the 7 reworded misses at the top 8, only 1 has every answer-bearing section starting past the cut. Of the 8 hits, also 1.
- So truncation does not explain the misses.

### Question fairness ruled out

- Each reworded question was read by hand (single Opus grader): natural, answerable, and the same meaning as the docs.
- 5 of the 7 misses are fair questions. 6 of the 8 hits are fair. The misses are not an artefact of badly written questions.
- Fair misses: bareloop-p02, bareagent-p01, bareagent-p04, bareagent-p05, bareagent-p07.

### Model ruled out

bge-small-en-v1.5 and e5-small-v2 were tried, each as litectx would run it and with the model's intended pooling and prefixes (meaning rank only).

- Of the 5 fair misses, only 1 is rescued into the top 8: bareagent-p07 via bge (rank 21 to 2). e5 rescues none.
- Ranks swing by hundreds in both directions across the 42 questions.
- Full recall: reworded top 8 is 8/15 for all three models; plain top 8 is 25/27 for MiniLM and e5, 26/27 for bge.
- Cost: both are about 50% bigger (34 MB against 23 MB) and 2.3x to 5.3x slower to index (the timings are noisy).
- Keep MiniLM.

### Working explanation (not proven)

- Project words are unknown to a general model, the sections are all about the same broad topic, and each section gets one vector. Nearly-the-same sections are hard to tell apart.
- The live agent compensates by rewriting its queries (a gold file listed in 15/20 reworded runs). Grep-only did not fail (20/20): the large-model agent supplies the meaning. litectx's measured value is fewer tokens (about 40%), not more correct answers.
- Chunking: heading-section (H2) chunks would be coarser than today's, because litectx splits at every heading level (`chunkMarkdown`, `src/chunker.js`). Rounds 4 to 9 already found litectx chunks as good as or better than H2.
- Doc search is word-based with a meaning re-rank (doc and code recall is gated by word match). "Finds by meaning" is not established for docs.

### External reading (2026-10-09)

- No universal chunk size; it depends on the answer type (arXiv 2505.21700).
- Smaller chunks raise precision, not recall; overlap helped MiniLM more than shrinking (Chroma research, trychroma.com/research/evaluating-chunking).
- Structure-aware boundaries are the common advice (Reducto, Unstructured).
- Biggest measured gain: a context prefix on each chunk. Contextual retrieval cut failures 35% with embeddings and 49% with BM25 added (anthropic.com/news/contextual-retrieval).
- litectx cannot call an LLM per chunk. The deterministic version is a file name plus heading path prefix. The test was run (see the next sub-section) alongside small-to-big (match on the paragraph, return the section).

### Chunk context and small-to-big (2026-10-09)

Free, MiniLM fixed, run through simulated shipped recall (real `recall()`, BM25 pool 400, min-max fusion; only the section vectors swapped). Script: `poc/tinymem-ctxembed.mjs`. Sanity gates passed: base reproduces the shipped ranks with 0 mismatches. Variants: (a) a "path > heading chain" prefix on each section; (b) small-to-big, one vector per paragraph, section score = best paragraph. Cell = any gold section found at the top 8.

| Variant | Reworded (15) any @8 | Reworded all-gold @8 | Plain (27) any @8 | Vectors |
|---|---|---|---|---|
| base (shipped) | 8 | 3 | 25 | 3,462 |
| a: prefix | 8 | 3 | 24 | 3,462 |
| b: small-to-big | 8 | 5 | 27 | 9,320 |

- Reworded top 8 is 8/15 in every variant, so neither moves the headline.
- (a) helps the pure-meaning rank on reworded (3 to 5 at the top 8) but slightly hurts plain recall (25 to 24).
- (b) raises reworded all-gold from 3 to 5 and plain top 8 from 25 to 27, and rescues one fair miss (bareagent-p01, first gold at rank 8). It costs 2.7x the vectors (9,320 against 3,462; about 14 MB against 5 MB) and needs a new per-paragraph vector table. Embedding time rose about 25% to 50% (bareloop 160 s to 199 s, bareagent 44 s to 67 s).
- Parked. Un-defer only if the scale run shows partial answers (missing gold sections) cost correctness.

### Ranking is not hurting; where the misses sit (2026-10-09)

Fused (BM25 plus meaning) against BM25-only, by first-gold rank. Script: `poc/tinymem-rankcut.mjs`, `poc/tinymem-rankcut-report.mjs`. Sanity: shipped recall against the step-4 ranks, 84 rows, 0 mismatches.

| | Gold moves up | Gold moves down | Same |
|---|---|---|---|
| 1x (42) | 17 | 5 | 20 |
| big (42) | 15 | 4 | 23 |

- The downs are small. At 1x, 2 of 5 go 1 to 2; the others are 9 to 11, 5 to 13, 15 to 20. At big, 2 of 4 go 1 to 2.
- The doc pool is the BM25 top 400 sections (`SEMANTIC_POOL`, `src/index.js:32`); doc has no meaning nomination (consistent with the nomination test above).
- Misses of the 5 fair questions: bareagent-p07 is lexically out of the pool (shares only "agent" with its gold section). The rest are in the pool but deep: fused first-gold rank 13 to 23 at 1x, 28 to 102 at big. bareloop-p04 (not a fair-miss question) drops out of the pool at big.
- The older note "doc recall returns one section per file" is obsolete since 0.34.0 (one row per section). The reverse problem is real: the top 20 averages about 9 distinct files at 1x and about 10 at big, and one file can take 12 to 13 slots.

### Top-N sweep (2026-10-09)

All 42 questions, fused list. Approx tokens = CLI bytes / 4.

| n | All-gold 1x | All-gold big | ~Tokens 1x | ~Tokens big |
|---|---|---|---|---|
| 5 | 19 | 18 | 134 | 134 |
| 8 | 21 | 20 | 209 | 213 |
| 10 | 24 | 24 | 262 | 270 |
| 15 | 25 | 24 | 396 | 410 |
| 20 | 27 | 25 | 525 | 545 |

- 5 to 10 is worth it: all-gold 19 to 24 at 1x and 18 to 24 at big, for about 130 more tokens.
- Past 10 it is flat at big for reworded (any 8, all 4 at n = 10, 15 and 20). Padding grows: for reworded at big, padding files are 2.2 of 10 at n = 10 and 5.3 of 20 at n = 20 (about 27%).

### Per-file cap against grouping by file (2026-10-09)

Same fused list, post-processing only. Script: `poc/tinymem-filecap.mjs`. Sanity: any-gold counts reproduce the rankcut results, 0 mismatches. Gold-file coverage = share of gold files surfaced.

- A per-file cap loses multi-section answers. Cap 1 at n = 10: all-gold 24 down to 18 (1x and big). On the 13 questions with 2+ gold sections in one file, cap 1 completes 1/13 against 6/13 for plain top 10.
- Grouping wins. Format: one "FILE path: lines a-b, c-d" line per file, files in best-hit order, sections taken from the top-50 window (`w50`).

| Variant (42 questions) | 1x any / all | 1x file cov. | 1x ~tok | big any / all | big file cov. | big ~tok |
|---|---|---|---|---|---|---|
| base top 10 | 33 / 24 | .79 | 262 | 34 / 24 | .79 | 270 |
| group-8-w50 | 37 / 29 | .84 | 179 | 37 / 27 | .84 | 169 |

- Multi-gold-in-one-file questions: group-8-w50 completes 9/13 at 1x and 7/13 at big, against 6/13 for base top 10.
- Caveats: part of the token saving is the leaner line format, not the grouping. Grouping reaches past rank 10 through the window, so it sees more sections. It was picked from many variants on the same 42 questions. The grouped-output win was picked and scored on the same 42 questions; confirmation needs a fresh question set with line-level gold. Done: see the next three sub-sections (coverage confirmed; agent A/B lost).

### Fresh question set for confirmation (2026-10-09)

- 24 questions, 12 per repo (bareloop, bareagent). Per repo: 6 plain and 6 reworded, 6 single-section and 6 multi-section.
- Written blind to the results by an Opus worker, then frozen. sha256 in `~/.cache/tinymem-probe/out/fresh/FROZEN.sha256`: `bareloop.json` `7ab9f9b9706968ca75eb8a40e60256bbdb1dc638616f5071fcc64bd590e9b44b`, `bareagent.json` `e01aebf601b4c83f70e9ed227362803522e48e7346c5e56b593a1ae73afa723b` (checked: both OK).
- Gold = the `sources` only. `also` lists duplicate places that say the same thing; it is not gold.

### Free confirmation of grouped output (pre-registered, 2026-10-09)

Script: `poc/tinymem-filecap-fresh.mjs`. Rule written and hashed before scoring (`out/fresh/confirm/PREREG.txt`): group-8-w50 holds if, at both sizes, gold-file coverage and all-gold count are at least base-10's and mean tokens are lower. Sanity: base-5/10/20 equal plain fused recall cut at N for all 48 (question, size) runs.

| Size (24 q) | | Gold-file coverage | All-gold | ~Tokens |
|---|---|---|---|---|
| 1x | base-10 | .83 | 15 | 262 |
| 1x | group-8-w50 | .83 | 17 | 175 |
| big | base-10 | .85 | 15 | 253 |
| big | group-8-w50 | .90 | 17 | 161 |

- Verdict: HOLDS at both sizes. Never worse than base-10 on any question; it differs on 2 questions at 1x and 5 at big, all in its favour.
- Grouped lists carry many section pointers: mean 38.0 (max 47) at 1x, 28.3 (max 49) at big.
- This is coverage only: the gold range is listed. It does not say whether an agent uses the list well (next sub-section).

### Agent A/B of grouped output: it lost (step 6, 2026-10-09)

Pre-registered (`out/step6/PREREG.txt`), k = 2, the 24 fresh questions, 48 runs per arm, blind graded. Cost $7.28 (runs $4.44, grading $2.84); the brief said $7.34, the score file says $7.277.

- **F:** the shipped tool descriptions plus the shipped-style output (`lx3`). **H:** an honest description plus grouped bare-range output (`lx4`).
- Rule: adopt H if correct >= F - 1, median tokens <= F, and median lines read <= F x 1.25. **H failed the first test.**

| | F | H |
|---|---|---|
| Correct (of 48) | 48 | 40 |
| Plain | 24/24 | 23/24 |
| Reworded | 24/24 | 17/24 |
| Median tokens | 25.9k | 26.9k |
| Median lines read | 192 | 110 |
| Runs that read a recalled file with Read (hand-off) | 8/48 | 24/48 |
| First tool was recall | 48/48 | 48/48 |

- Fewer lines read in H is not a gain: the agent left litectx for grep and Read instead (24/48 against 8/48 runs). By the stricter script count (a Grep or Glob aimed at a file from recall) it is 7 against 1.
- `get` errors ("no chunk at A-B"): H 19 of 68 calls, because the agent merged or computed ranges from the bare FILE lines. F 26 of 115, all from the test wrapper's FILE span line, which is not shipped output and whose ranges are not gettable; F always recovered.

### Likely cause and lesson (hypothesis, not isolated)

- H changed the description AND the format, so the cause is not separated. Most likely cause: the grouped line dropped section names.
- Shipped CLI line: `<score> doc/md <path> → <heading>:<a-b>`, e.g. `→ Retry:77-90`. Grouped line: `FILE <path>: lines a-b, c-d, ...`, bare numbers. The heading is how the agent picks which range to open. Losses sit on reworded questions (17/24 against 24/24), where the agent has to choose by meaning.
- Lesson: the free coverage metric (is the gold range listed) did not predict agent behaviour when what was trimmed is what the agent uses to choose. A free win on presentation needs a paid check before shipping.
- Decision (owner, 2026-10-09): keep the shipped output format for now.
- Next candidate, not run: grouping WITH section names, e.g. `FILE <path>: Retry 77-90; Backoff 112-119`, tested as a format-only change (same description) so any difference is attributable.

### Pilot at big scale (step 7, 2026-10-09)

- 4 fresh questions (bareagent-f03, bareagent-f10, bareloop-f02, bareloop-f08), F and B, k = 1, big corpus (1,525 bareloop files), 8 runs. Cost $0.713 (runs $0.434, grading $0.279).
- Result: the harness works at about 1,500 docs. No turn-cap hits, no blowups. F 4/4, B 3/4 (too few runs to read as a result).
- It set the budget for the scale run and showed the test wrapper's FILE span lines were not get-able. They were removed for the scale run (wrapper `lx5`).

### Scale run (step 8, 2026-10-09)

Pre-registered and hashed before the batch (`out/step8/PREREG.txt`, sha256 `63eb721fa5c57612536a44b6cd12953a75220ac34a95ae226221a5c3c2831c95`; re-checked, matches). Bar fixed in advance, final blind grades.

- **F:** litectx recall output exactly as the shipped CLI prints it (wrapper `lx5`; checked byte-for-byte against the shipped CLI), plus a widened `get` that returns the section and its neighbours (NOT shipped behaviour), plus Read/Grep/Glob. **B:** Read/Grep/Glob only.
- 24 fresh questions (12 plain, 12 reworded; 12 per repo), both sizes (1x about 114 files, big 1,525 bareloop files), k = 2: 192 runs. The questions were seen in step 6 (F vs H, 1x); step 6 results are not reused. Cost $16.89 (runs $11.00, grading $5.89), under the $20 hard stop.
- Bar (all three needed): (1) wins F >= B - 2 at each size; (2) median tokens F <= 0.75 x B at each size; (3) F/B token ratio at big <= ratio at 1x + 0.05.

| | 1x F | 1x B | big F | big B |
|---|---|---|---|---|
| Correct (of 48) | 45 | 36 | 42 | 42 |
| Median tokens | 25,571 | 28,956 | 27,452 | 29,984 |
| Median wall time (ms) | 15,663 | 15,194 | 16,274 | 17,544 |
| Run cost ($) | 2.02 | 3.12 | 2.50 | 3.35 |
| Mean turns | 4.5 | 4.9 | 5.1 | 5.1 |

| Bar | Result |
|---|---|
| (1) correctness | PASS: 45 vs 36 at 1x, 42 vs 42 at big |
| (2) tokens F/B <= 0.75 | FAIL: 0.883 at 1x, 0.916 at big |
| (3) scale | PASS: 0.916 <= 0.883 + 0.05 = 0.933 |

- Wall time is about the same (F/B 1.03 at 1x, 0.93 at big). Total cost F/B is 0.65 at 1x and 0.75 at big. Median lines read: F 186 against B 138 at 1x, 190 against 146 at big (about 1.3x).
- The token bar failed because the plain questions barely save anything. The split by question wording (24 runs per cell):

| | Correct F / B (1x) | Correct F / B (big) | Median tokens F / B (1x) | Median tokens F / B (big) | F/B tokens |
|---|---|---|---|---|---|
| Plain | 23 / 15 | 22 / 21 | 25,470 / 27,475 | 25,340 / 27,366 | 0.93 at both |
| Reworded | 22 / 21 | 20 / 21 | 25,571 / 38,307 | 29,025 / 42,850 | 0.67 at both |

- Reworded: about one third fewer tokens at both sizes, with about equal correctness. This is the 2026-10-09 step 3 finding (about 40% fewer tokens) holding on fresh questions and at scale.
- **Goal verdict:** not met overall (the pre-registered 0.75 token bar fails). Met for reworded questions.
- F was the first tool in 48/48 runs at each size. Only 3/48 F runs per size handed off from a recalled file to Grep or Glob. `get` errors: 20 of 100 gets at 1x, 21 of 102 at big (see the replay below).
- Caveat: the correctness lead rests partly on F's widened `get` (see the next sub-section). Part of the wall-time and cost picture also includes about 1 to 1.5 s of process spawn per run.

### B plain at 1x: autopsy of the 9 losses (2026-10-09)

Source: `out/step8/autopsy-B1x.txt`. Read by hand: traces, answers, gold, grades. No model calls. B scored 15/24 on plain questions at 1x against 21/24 at big, so the dip was checked for a harness or grader cause.

- 9 not-win runs: 6 real omissions where the agent read too narrow a window or dropped a fact it had already read (in 3 of them the missing fact was in text it had read); 1 never reached the gold file (bareloop-f01 r2 stopped at a CHANGELOG summary); 2 mixed (bareloop-f06: a broad grep for "signed" overflowed the preview and buried the CHANGELOG line, plus a missed fact).
- No grader false negatives, no citation or format failures, no tool errors, no turn-cap hits. Prompts at 1x and big differ only in the corpus path; the files are byte-identical (hardlinks). A smaller haystack at 1x can only help grep.
- Same failure modes recur at big for 3 of the 6 questions. At big, one B win (bareagent-f01 r1) was grader leniency: the answer left out the NaN rule and was still passed, so B big plain is closer to 20/24.
- Verdict: the 15 against 21 swing is ordinary run-to-run variance (about p 0.1 by Fisher at k = 2), not a size effect and not an artefact. Best single estimate of B on plain questions is 36/48, about 75%, across sizes.
- F's lead on plain (45/48 against 36/48, pooled over sizes) is real but modest. Part of it comes from the widened `get`, which returns the neighbouring sections and so directly cures B's main failure, the too-narrow read. Do not credit it to recall ranking. This matches the step 1 v2 trace finding (arm E).
- The owner's framing of this failure: without litectx the agent either guesses (reads too narrowly, so facts go missing, the dominant grep-only failure seen here) or reads in full (costly).

### `get` failure replay (2026-10-09)

Source: `out/step8/getreplay/report.txt` and `results.json`. Offline replay of the F traces.

- 96 F traces; 41 `get` calls failed with "no chunk at A-B", in 36 of the 96 runs (20 calls at 1x, 21 at big). Every failure was against a current index (no drift).
- Cause, recomputed from the printed ranges: 0 failures asked for a range inside one printed section. 38 of 41 asked for a range spanning 2 or more printed sections; in 36 of those both ends sit on printed section bounds (22 of the 38 are directly adjacent sections, 16 have unprinted gaps between). The other 5 are looser: 2 end past or inside a printed section and 3 have no printed section in range (invented ranges). The replay's own cause tag splits the same 41 as 21 "merge of printed sections" and 20 "range includes unprinted sections".
- The agent mostly merged the sections `recall` printed into one range, as if `get` took any span. It always recovered, but it cost about +0.7 turns per failing run (5.31 turns against 4.57 clean) and about +4% cost per run ($0.0483 against $0.0465; the two groups are not matched for question).
- Replayed fixes (offline, calls held fixed): S1 (serve the one section containing the range) serves 0 of 41, inert. S2 (serve all sections the range overlaps) serves all 41 and covers gold in 17 of the 18 failed calls in a gold file, but that widens `get` and violates the never-widen doctrine. S3 (keep the error, add a hint listing the exact chunk ranges near the request) keeps the doctrine; the hint overlaps gold in 17 of 18 gold-file calls, but it adds little since the agent already had the printed ranges.
- Untested, the better fit: a multi-range `get` (several exact printed ranges in one call), which matches what the agent tries to do and widens nothing.

### Owner decision: close out the docs-compass work (2026-10-09)

- Closed as a measurable success. The claim, with litectx an agent answers docs questions as well as or better than grep alone, at about 25 to 35% lower total cost (F/B 0.65 at 1x, 0.75 at big) and about one third fewer tokens when the question's wording differs from the docs (F/B 0.67), about 7% fewer when it matches (0.93). The saving held from about 50 to about 1,500 docs (reworded 0.67 at both sizes; the pre-registered scale bar passed).
- Honest limits to keep with the claim: the pre-registered 0.75 token bar failed overall (0.883 and 0.916); the correctness lead leans on a non-shipped widened `get`; k = 2 and 24 questions; one grader; the 1,500-doc corpus is padded with other projects' docs, not a naturally grown corpus; "finds by meaning" is still unproven for docs (recall is word-gated).

## Embedding index speed (2026-10-09/10)

Source: POC scripts in `poc/`: `embed-speed-profile.mjs`, `embed-speed-knobs.mjs`, `embed-speed-threads.mjs`, `embed-speed-batch.mjs` (superseded, noisy, its numbers are invalid), `embed-dupes.mjs`, `embed-cos.mjs`, and `embed-speed-parallel.mjs` (written, never run). Machine: i7-8665U, 4 physical cores / 8 threads, Node 22. Corpus: bareloop's 71 md files, 2,347 sections. Question: why is the embedding index slow, and is there a safe speed-up?

### Where the time goes

- Cold `index()` with embeddings on: 116 s and 118 s on quiet starts. A third run took 142 s. Earlier runs on a loaded machine took 130 s and 147 s. With embeddings off: 0.65 s.
- Embedding is about 99.5% of the time. Parsing and SQLite are negligible. Model load is 0.2 to 0.5 s.
- About 55 ms per section on average. Cost rises with section length up to about 2,000 chars, then flattens near 100 ms because the tokenizer caps input at 512 tokens. Tiny sections take about 6 ms.
- Section lengths: mean 1,686 chars, p50 926, p95 4,525, max 89,765. 79 sections exceed the 6,000-char head cut. About 529 exceed 2,000 chars.

### Ruled out

- Batching (same pipeline, q8): slower, 0.55x unsorted and about 0.8 to 0.9x length-sorted. It also changes the vectors (min cosine against sequential about 0.98, mean about 0.993). Cause: padding plus q8 quantization. Batches of identical text give cosine 1.0, and fp32 batches are padding-invariant (cosine 1.0).
- Dedupe: 18 of 2,347 sections are duplicates (0.8%), about 0% of the characters (17 within one file, 1 across files). Nothing to save.
- Thread tuning: 15 interleaved runs at default, 1, 2, 4 and 8 intra-op threads on 1,178 sections. Process CPU was 3.97 to 3.99 cores in every run, including "1 thread". The setting does not take effect through the transformers.js pipeline. onnxruntime's default is one intra-op thread per physical core (4 here, per the onnxruntime threading docs). Throughput was 21 to 31 sections/s with no consistent difference between settings. Run-to-run noise (about 40%) is larger than any setting effect.
- An earlier single-run inference that the model "effectively runs single-core" was wrong. Corrected here.
- Parallel embedders: not run, inferred. One process already saturates the 4 physical cores.

### The token cap

- The tokenizer truncates at 512 tokens (`model_max_length`). The reference model card (sentence-transformers/all-MiniLM-L6-v2) says "By default, input text longer than 256 word pieces is truncated" and that training used a sequence length of 128 tokens. So litectx embeds up to 512 tokens, twice the reference default.
- Measured: a 256 cap is about 1.8x faster (30 to 33 against 17 to 19 sections/s). A 128 cap is about 3.0x faster.
- The vectors change. Against the current 512 vectors: 256 gives min cosine 0.659, mean 0.931; 128 gives min 0.561, mean 0.817. Cosine to the current vectors measures difference, not which is better.
- Truncation options passed to the pipeline call are ignored (the pipeline hard-codes truncation). The POC changed the tokenizer's `model_max_length` instead.

### Measurement lessons

- The first run was on a heavily loaded machine (load 3 to 23). Absolute timings from it are unreliable. Directions and vector maths are fine.
- An embedding run raises the load average itself (about 2.5 to 3). A "start only below load 1.0" rule made each run wait for the previous one: about 2 h of waiting for about 12 min of runs. Judge contamination by other processes' CPU, not by the load at the end.

### External comparison (web, 2026-10-10)

- No clean public CPU benchmark of all-MiniLM-L6-v2 at long inputs was found. Published high throughput figures (hundreds of texts/s) are for short texts. That matches our own about 6 ms (about 150/s) for sections under 200 chars.
- A different route exists: static embeddings (Model2Vec "potion" models) claim up to 500x faster on CPU. On retrieval they score about 82% of all-MiniLM-L6-v2 (potion-retrieval-32M 35.06 against 42.92 MTEB retrieval). That is a quality trade and a model change.

### Conclusion

- No safe speed-up exists for the current model on this CPU. A cold index costs about 2 minutes for 71 md files. It is one-time, because indexing is incremental.
- The one promising lever is a 256-token cap. It matches the reference model's own default truncation and is about 1.8x faster. It changes stored vectors, so it needs a recall bench first (memory paraphrase MRR, floor 0.574, via `poc/memory-bench.mjs --embeddings`, plus doc recall) and a one-time re-embed on upgrade.
- A static-embedding model is a second, bigger quality trade.
- Trigger to revisit: a consumer reports the cold index as a blocker, or the owner picks the 256-cap bench.
