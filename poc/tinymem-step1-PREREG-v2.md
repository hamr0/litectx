# Step 1 hybrid answer test, v2: pre-registered bar

> Approved by the owner 2026-10-07; supersedes v1 (poc/tinymem-step1-PREREG.md, kept as history; never run). Approved before any run.
> This file is hashed once, right after it is final; the sha256 is recorded in the PRD and the learnings, not inside this file.
> Nothing runs before this hash and the question-file hashes are recorded.
> Structure mirrors v1. The scale test (`out/step1-scale/PREREG.scale.draft.md`) is folded in here as a second size; that draft is superseded.

## What this tests

Does one agent holding litectx search AND grep/read answer "what did we decide about X" at least as well as a grep/read-only agent, at lower cost, at the current corpus size (1x) and at about 5x?
And does the gap between them grow with corpus size?
Run-to-run noise is large (neighbour control), so each question is repeated.

## What changed from v1

- Arm A2 (search only) is dropped. Nobody would use litectx without grep, and its result feeds no decision.
- Arm C (no tools) runs once per question at 1x only, as the leak floor.
- Two corpus sizes: 1x and about 5x (padded).
- The scale test is part of this PREREG, not a separate one.
- One joint blind grading pool across both sizes and both arms.
- Everything else (questions, D sentence, grader, grading rules, primary bar) is unchanged from v1.

## Arms (claude -p, sonnet, max 15 turns, one fresh run per question per repeat)

- D (hybrid): litectx `lx2` (Bash restricted to `lx2 recall` / `lx2 get`; `get <path> --lines A-B` also prints the previous and next section, marked; branch build, embeddings on) PLUS Read, Grep and Glob over the corpus.
- B: Read, Grep and Glob over the corpus only.
- C (floor, k=1, 1x only): no tools.

Same across arms: model (sonnet), `--max-turns 15`, working directory, `--strict-mcp-config`, `--no-session-persistence`, `--setting-sources ''`, `--disable-slash-commands`, `--permission-mode dontAsk`, the same corpus per size, the same first and last sentences of the system prompt, and `--output-format stream-json --verbose` so traces are saved.

The D tool sentence is FROZEN, unchanged from v1 (`<corpus>` is the corpus directory path of that size):

> You also have Read, Grep and Glob over <corpus> (docs/ and sessions/). Use search to find where to look; use grep and read when you need more of a file.

Note: any D win may come partly from this sentence; B gets no equivalent tip. Known confound, reported with the result.

## Questions

- The SAME 40 frozen questions as v1 (20 bareloop, 20 bareagent; 10 docs-answerable and 10 session-only per repo). Not edited, not re-hashed, not re-read for this draft.
  - questions bareloop sha256: `9ac3ba15742e6b4e8a9d780fe22440754553ab5b3e5435e84791a55cdc77bf73`
  - questions bareagent sha256: `26e0284dd52b401fa7653c41cab3b6395acbfef30e4b1e8c10cd8ba4af1fde4a`
- Slices reported per size: `docs` / `session`, `slice:neighbour`, `slice:superseded` (exact tags as in the question files).
- C floor: if C scores 5 or more wins of 20 on a repo, that repo's questions are flagged as leaking general knowledge.

## Corpora

- 1x: the frozen corpora, unchanged (`out/answer/<repo>/{corpus,lroot}`; bareloop head 08921cac, bareagent head 4de9da27). bareagent: 118 files, 5.3 MB, 9,652 sections.
- About 5x: `out/step1-scale/<repo>-10x`. The directory name says 10x; that is the original plan. Actual size is about 4 to 5x by bytes, so this document calls it "~5x" everywhere.

| | 1x | ~5x |
|---|---|---|
| bareagent files | 118 | 1,180 |
| bareagent size | 5.3 MB | 27.9 MB (about 5.3x bytes), 52,306 sections (1x: 9,652) |
| bareloop files | 210 | 1,850 |
| bareloop size | 11.6 MB | about 42 MB (about 3.6x bytes) |

- Padding = other projects' docs (git HEAD `.md`) plus Claude Code sessions. Selection seeded (seed 20261007). A `MANIFEST.json` per corpus lists every padding file.
- Files whose text names bareloop or bareagent are excluded from padding (own material). Files naming litectx or bareguard are KEPT as realistic distractors.
- 10 `bareloop-close` docs (a sibling of bareloop, so own material) were removed from the bareloop padding.
- Limitation: padding is doc-heavy, about 82% docs versus 36% at 1x, because only 186 clean session files exist. The ~5x corpora therefore test growth in docs more than growth in sessions.

### Padding contamination check (done before any run, read-only)

- 2 of 40 questions have a second valid source in padding: bareloop-d03 (in `docs/_pad/bareloop-close`, now REMOVED; re-check not needed) and bareloop-d06 (`sessions/_pad/2026-07-10-adaptlearn-d8fc76dd.md`).
- 1 question has an older-version trap in padding: bareloop-d06, same file (earlier lines are superseded by later lines in that file).
- The grader accepts any valid location. These are reported with the result, not removed.

### Index build (once per corpus, before the runs, outside all timing)

- 1x: existing indexes, unchanged.
- bareagent ~5x: 37.5 min, 217 MB.
- bareloop ~5x: reported with results (index built once before the ~5x runs, outside timing).
- Build times are reported. They are not part of any run cost.

## Pilot gate at ~5x (before the full run)

- 2 OLD go/no-go-1 questions (not from the 40) x D and B x 1 run each, on the ~5x corpus. 4 runs, about $0.5.
- Checks plumbing only: `lx2` points at the padded `lroot`; grep sees padding (a Grep result includes a `_pad` path); cost per run and turns per run are recorded; no run hits the turn cap for a harness reason.
- Not scored, not graded, not in any result. If it fails, fix the plumbing and re-pilot; nothing else runs.

## Repeats

- k = 3 per arm per question per size (C: k = 1, 1x only). Reasoning unchanged from v1: with k=3 each question yields a win fraction in {0, 1/3, 2/3, 1}, cutting run-noise variance of the per-question score to a third.
- Each repeat is a fully fresh run. Runs are interleaved in one seeded shuffled batch per size (harness seed 20261007, STEP1_DIR separate per size, shards 4 each). Model drift is then equal across arms within a size; the two sizes run in the same window.

## Cost estimate

Measured in the pilot (small n): D $0.0475/run, B $0.097/run, C $0.0054/run, grade $0.025.
~5x will likely cost more per run (bigger grep and read results): stated uplift +25% on D, +50% on B. Not measured; the pilot gate gives the first real figure.

| Item | Arithmetic | Cost |
|---|---|---|
| 1x runs, D | 120 x $0.0475 | $5.70 |
| 1x runs, B | 120 x $0.097 | $11.64 |
| 1x runs, C | 40 x $0.0054 | $0.22 |
| ~5x runs, D | 120 x $0.0475 x 1.25 | $7.13 |
| ~5x runs, B | 120 x $0.097 x 1.5 | $17.46 |
| Pilot gate | 2 x ($0.0594 + $0.1455) | $0.41 |
| Runs subtotal | | $42.56 |
| First grades | (240 + 40 + 240) = 520 x $0.025 | $13.00 |
| Second grades (~25%) | 130 x $0.025 | $3.25 |
| Third grades (~30) | 30 x $0.025 | $0.75 |
| Subtotal | | $59.56 |
| +20% reruns and limit hits | | about $71.5 |

- HARD STOP: if cumulative spend (runs plus grades, from `total_cost_usd`) passes $90, abort, save everything, and report what is complete. Incomplete cells are reported as incomplete, not scored.
- Wall time: about 480 runs plus grading at 4 shards; ~5x runs are slower. Expect hours, not days.

## Grading

Unchanged from v1:
- Same blind grader (sonnet, same prompt, one answer per call, corpus readable, must open each citation, quoted evidence required). Win = correct yes AND cited yes.
- ONE joint pool: all arms (D, B, C), all repeats, BOTH sizes, shuffled, opaque ids; the key in a separate file the grader never sees. Never grade one arm or one size alone. The grader reads the corpus of the size the run used.
- Second grade rule (mechanical) and third grade rule: exactly v1's four triggers, majority of three is final. Counts of second grades and flips reported.
- Tokens = input + cache creation + cache read + output.
- Audit: 20 seeded items (seed recorded) re-read in full by the orchestrator, disagreements reported. The 20 are drawn by the harness `audit` command (seeded shuffle of the joint graded set, both sizes together, default seed 4242); the size split of the draw is reported.
- The harness already has the pool change (size-tagged run ids `qid.arm.size.rN`, a pool built from both dirs via `STEP1_POOL_DIRS`, grader corpus taken from each run's recorded `corpusRoot`). No `src/` change.
- Grader size blinding: the grader never sees the real corpus path. Each grading item gets a neutral opaque symlink `out/step1/gview/<10-hex hash of the real path>/` pointing at the right corpus, so 1x and ~5x paths look alike (no `root5x`, no `answer/`). Checked on the plumbing pool: graded prompts contain neither string, and the grader reads through the link.

## Harness commands

- Corpus root layout the harness expects: `<root>/<repo>/{corpus,lroot}`. For ~5x, make a root of symlinks (e.g. `out/step1-scale/root5x/<repo> -> ../<repo>-10x`).
- 1x: `STEP1_DIR=out/step1/x1 STEP1_CORPUS_ROOT=out/answer STEP1_ARMS=D,B,C STEP1_K=3 node poc/tinymem-step1.mjs run <shard> 4`
- ~5x: `STEP1_DIR=out/step1/x5 STEP1_CORPUS_ROOT=out/step1-scale/root5x STEP1_ARMS=D,B STEP1_K=3 node poc/tinymem-step1.mjs run <shard> 4` (C is not run at ~5x).
- Pilot: same as ~5x with `STEP1_QIDS=<2 old ids> STEP1_K=1` into a throwaway `STEP1_DIR`.
- Traces, guard (parse error, `is_error`, limit/login pattern with a short body; exit the shard on a limit hit), resumability, and cost/token/turn/ms recording are unchanged from v1. Every run saves its full stream-json trace and tool-call list with result sizes.
- Grading: `grade-build 1|2|3`, `grade`, `score`, `audit` as in v1, after the pool patch above.

## Primary metric and bar (per size, unchanged from v1)

Unit = the question. Per question and arm, s = wins / k. d = s(D) - s(B). Paired, never pooled across questions.

PASS at a size, all must hold:
1. Mean d over all 40 questions >= +0.10.
2. Mean d >= +0.05 on EACH repo.
3. One-sided Wilcoxon signed-rank on the 40 per-question d, p < 0.05; ties dropped and the number dropped reported.
4. Tokens: median over questions of (median tokens of D's k runs) / (same for B) <= 0.75.

PASS-CHEAPER (its own outcome, NOT a pass): mean d >= -0.05 overall and on each repo, AND token ratio <= 0.75. "Same answers, cheaper."

FAIL: neither of the above. FAIL-WORSE: mean d <= -0.10, or D below B on both repos.

Each size gets its own outcome: PASS / PASS-CHEAPER / FAIL / FAIL-WORSE.
Noise basis: unchanged from v1 (sd of the 40-question mean about 0.04, rough, not a measured power calculation; the real figure from the data is reported).

## SCALE result (new)

Question: does search pay more as the corpus grows?

- Per question: g = d(~5x) - d(1x), paired on the same 40 questions. Report mean g overall and per repo, the sign test on the 40 g (zeros dropped, count reported), and the one-sided Wilcoxon on g as a secondary figure.
- Token-ratio change: median token ratio (D/B) at ~5x minus at 1x, per question and overall.
- Also reported per size: B's and D's mean win fraction, the share of runs ending at the turn cap with no answer, and the cost per run.
- Scale bar: "gap grows" = mean g >= +0.05 overall (mean g = mean d at ~5x minus mean d at 1x), AND the one-sided sign test on the 40 per-question g (zeros dropped, count reported) gives p < 0.05. Both must hold; otherwise "gap does not grow".
- Caveat stated with the result: sizes are about 4 to 5x by bytes, padding is doc-heavy, and 1x versus ~5x are the same questions so the comparison is paired but the corpora differ in more than size.

## What each outcome means for the PRD

| 1x | ~5x | Gap | Meaning |
|---|---|---|---|
| PASS | PASS | any | Hybrid beats grep at both sizes. Go to step 3 (filters), then step 4 (ranking). |
| PASS | FAIL / PASS-CHEAPER | shrinks | Odd. Read the traces (padding distraction?) before any conclusion; do not build on it yet. |
| FAIL / PASS-CHEAPER | PASS | grows | Search pays with size. Continue to step 3 and test a larger scale (the owner's real 8,218 session files). |
| FAIL | FAIL | grows | Search pays with size but not yet enough. Continue to a larger scale and filters; claim nothing at today's sizes. |
| FAIL | FAIL | does not grow | Grep is enough at these sizes. Re-scope: no build on the hybrid claim; read traces by failure type; the next test is the real corpus or stop. |
| PASS-CHEAPER | PASS-CHEAPER | any | "Same answers, cheaper." The owner decides whether that justifies step 3. |
| any | any | FAIL-WORSE at either size | Giving the agent search made grep answers worse. Stop the hybrid; read how D used the tools. |

- B hitting the turn cap in >= 20% of ~5x runs is a result by itself and is reported as such.
- Trace-based reading attached to any result, by failure type: never reached gold source -> step 4 (ranking) or step 3 (filters); read right file but missed non-adjacent sections -> a window by offset and length; wrong session / superseded -> step 3 (newest first).
- If C scores >= 5 of 20 on a repo at 1x: that repo is flagged and reported separately.
- Neighbour fetch is kept (promoted to a `src/` change) only if the neighbour-slice results show it; otherwise it stays an unproven helper. With A2 dropped, this can only be read from D's traces, not from an A2 contrast.

## Known limits (stated with every result)

- Grader size leak: the padding folder `_pad` is NOT renamed (that would make the built `lroot` indexes stale), so a grader that opens a padding file can infer a ~5x corpus. Path-level size is hidden, content-level is not. Grading is not fully size-blind.
- Sizes are about 4 to 5x by bytes, not 10x.
- Padding is doc-heavy (~82% docs versus 36% at 1x); only 186 clean sessions exist.
- The 40 questions were written by a model that read the corpus with grep, so answers are grep-findable by construction. This likely favours B.
- D's instruction sentence is a tip that B lacks.
- No human-checked gold.
- Contamination: 2 questions have a second valid source in padding and 1 has an older-version trap (bareloop-d06). Reported, not removed.
- Cost per run at ~5x is an uplift guess until the pilot gate and the run give real figures.
- D versus A2 is no longer tested; whether search alone suffices is not answered here.

## Harness requirements

- `poc/tinymem-step1.mjs` at sha256 `e0f6ac68efad61dd14541f32422c583f1678eeb34ae109da2687afabd114a063`; no `src/` changes. `lx2` wrapper and D sentence are frozen and hashed before the run.
- Guard, resumability, traces, second/third grade rules unchanged from v1.
- Record `total_cost_usd`, tokens, turns and ms for every run, and grader cost for every grade. The final report states actual cost against the table above and checks the $90 hard stop throughout.
- One PREREG hash, both question-file hashes (above), and the harness hash recorded before the first run.

## Exact command sequence

`O=~/.cache/tinymem-probe/out`. Questions: `STEP1_QDIR=$O/step1/questions`. ~5x root: `$O/step1-scale/root5x`. Pool: `$O/step1/pool`.

1. 1x runs (4 shards, then re-run each shard to fill gaps; resumable):
   `STEP1_DIR=$O/step1/x1 STEP1_QDIR=$O/step1/questions STEP1_CORPUS_ROOT=$O/answer STEP1_SIZE=x1 STEP1_ARMS=D,B,C STEP1_K=3 node poc/tinymem-step1.mjs run <shard 0..3> 4`
2. ~5x runs (same, 4 shards):
   `STEP1_DIR=$O/step1/x5 STEP1_QDIR=$O/step1/questions STEP1_CORPUS_ROOT=$O/step1-scale/root5x STEP1_SIZE=x5 STEP1_ARMS=D,B STEP1_K=3 node poc/tinymem-step1.mjs run <shard 0..3> 4`
3. Joint grading (rounds 1, 2, 3 per the grading rules), with `STEP1_DIR=$O/step1/pool STEP1_POOL_DIRS=$O/step1/x1,$O/step1/x5 STEP1_QDIR=$O/step1/questions`:
   `node poc/tinymem-step1.mjs grade-build <round>`, then `grade <round> <shard> 4` for 4 shards, then `score`, then `audit`.
