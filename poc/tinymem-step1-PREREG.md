# Step 1 hybrid answer test: pre-registered bar (FINAL)

> Approved by the owner 2026-10-07 as proposed, with four decisions (below). This file is hashed once, right after it is written; the sha256 is recorded in the PRD (step 1) and the learnings, not inside this file.
> Nothing runs before the hash is recorded and the questions-file hashes are recorded (same order as go/no-go 1).
> Structure mirrors `out/answer/PREREG.md` (sha256 `4c082a80...`).
>
> Owner decisions: (1) 40 fresh questions (20 per repo), k = 3, bar as written below. (2) PASS-CHEAPER is a named, reported outcome and is NOT a pass; the PASS bar is the only pass. (3) The arm D tool sentence is frozen exactly as written below. (4) The scale test is its own PREREG, drafted in `out/step1-scale/PREREG.scale.draft.md`; it is not part of this one.

## What this tests

Does one agent holding litectx search AND grep/read answer "what did we decide about X" at least as well as a grep/read-only agent, at lower cost?
Go/no-go 1 gave 38 vs 45 wins in a single run. The neighbour control (learnings, 2026-10-07) showed run-to-run noise is large, so this test repeats each question.

## Arms (claude -p, sonnet, max 15 turns, one fresh run per question per repeat)

- A2: litectx `recall` and `get` only, where `get <path> --lines A-B` also prints the previous and next section (marked). Branch build, embeddings on. Same as the neighbour-diagnostic arm.
- D (hybrid): A2's litectx wrapper (Bash restricted to `lx2 recall` / `lx2 get`) PLUS Read, Grep and Glob over the corpus.
- B: Read, Grep and Glob over the corpus only. Same as go/no-go 1 arm B.
- C (floor, k=1 only): no tools. Run to flag questions that leak general knowledge.

Same across arms: model (sonnet), `--max-turns 15`, working directory, `--strict-mcp-config`, `--no-session-persistence`, `--setting-sources ''`, `--disable-slash-commands`, `--permission-mode dontAsk`, the same corpus copy, the same first and last sentences of the system prompt ("You answer questions about the decisions and history of a software project ... Answer the question, quote the supporting text verbatim, and cite each source as `path:line-range`. If you are not sure or cannot find it, say "not found"."), and `--output-format stream-json --verbose` so traces are saved.

Exact differences (only the tool sentence in the system prompt and the tool flags):

| | A2 | D | B |
|---|---|---|---|
| `--tools` | Bash | Bash,Read,Grep,Glob | Read,Grep,Glob |
| Bash allowed | `lx2 recall:*`, `lx2 get:*` | same as A2 | denied |
| Read/Grep/Glob | denied | allowed on the corpus dir only | allowed on the corpus dir only |
| `get` prints neighbours | yes | yes | n/a |
| Tool sentence | A2's (litectx only) | A2's plus: "You also have Read, Grep and Glob over <corpus> (docs/ and sessions/). Use search to find where to look; use grep and read when you need more of a file." | go/no-go 1 arm B's |

The D tool sentence is FROZEN, exactly (`<corpus>` is the corpus directory path, filled the same way as arm B's):

> You also have Read, Grep and Glob over <corpus> (docs/ and sessions/). Use search to find where to look; use grep and read when you need more of a file.

Note: any D win may come partly from this sentence; B gets no equivalent tip. This is a known confound and is reported with the result.
Note: the neighbour wrapper's `lx2` and the arm-A `lx` differ only in the appended neighbours (see `out/neighbour/scratch/lx2`).

## Questions

- FRESH: none of the 60 from go/no-go 1 may be reused (they have been seen, and the neighbour diagnostic re-ran 22 of them).
- Same two repos (bareloop, bareagent), same frozen corpora (bareloop head 08921cac, bareagent head 4de9da27; the docs plus the converted sessions), unchanged.
- 20 per repo = 40 total: 10 docs-answerable and 10 session-only per repo. Fewer than go/no-go 1's 60 on purpose: the owner chose repeats over more questions because blind question-writing is the slow part.
- Written blind by a separate worker (as in go/no-go 1: no script produced the originals; the worker was given the corpus, not any arm's output or any earlier answer). Each question has `id, question, type (docs|sessions), gold, must (list of must-facts), sources, notes`, same fields as `out/answer/questions/<repo>.json`.
- The writer must not see any run output from this PREREG or the 60 old graded answers' reasons. It may be told the old question ids/types only, to avoid repeats of topic.
- Each questions file is sha256-hashed and the hash recorded before any run. A question is not edited after the hash.
  - questions bareloop sha256: filled when questions are written, before any run
  - questions bareagent sha256: filled when questions are written, before any run
- Mix to include on purpose: at least 5 per repo whose answer spans neighbouring sections, and at least 3 per repo with a superseded decision (newest wins), because those are the failure types seen so far. These are reported as slices, not tuned toward.
- C floor: if C scores 5 or more wins of 20 on a repo, that repo's questions are flagged as leaking general knowledge.

## Repeats

- k runs per arm per question; k = 3.
- Reasoning: the control showed 1 in 4 partial questions flips on a plain re-run (control 6/22 vs original 0/22 on the same questions; A2 vs control discordant on 7 of 22). k=1 leaves a difference of a few questions unreadable. With k=3 each question yields a win fraction in {0, 1/3, 2/3, 1}, which cuts the run-noise variance of the per-question score to a third. k=5 would cut it further but costs about 1.7 times as much for a smaller gain; k=2 cannot show a majority. The owner can change k; the cost below is linear in k.
- Each repeat is a fully fresh run (no session reuse). Runs are interleaved in one batch so model drift hits every arm equally. Run order shuffled.

## Cost estimate (from measured costs; D has no measurement and is a guess)

Measured per run: A2 about $0.037 (25 runs, $0.917; control arm A $0.031); B about $0.075 (go/no-go 1: $4.50 / 60); C about $0.005 ($0.28 / 60). D (a guess) $0.06, between A2 and B.
Measured per grade: $0.019 to $0.028 (neighbour pool 44 items: $0.838; A2 first grading 25 items: $0.695). Use $0.025.

- Runs: 40 questions x k=3 = 120 per arm. A2 120 x 0.037 = $4.44. D 120 x 0.06 = $7.20. B 120 x 0.075 = $9.00. C 40 x 0.005 = $0.20. Total runs about $20.8.
- First grades: 360 answers x $0.025 = $9.00 (+ 40 C answers x $0.025 = $1.00).
- Second grades (estimate: ~25% of answers borderline): 90 x $0.025 = $2.25. Third grades (~20 disagreements): $0.50.
- Subtotal about $34. Add 20% for reruns after errors and limit hits: about $41.
- Wall time: go/no-go 1 and the diagnostic ran 4 shards in parallel; about 400 runs at 4 shards is a few hours, not days. Use the same 4-shard layout.

## Grading

- Same blind grader as go/no-go 1 (sonnet, same prompt, one answer per call, corpus readable, must open each citation, quoted evidence required). Scores per answer: correct (yes/partial/no), cited (yes/no); win = correct yes AND cited yes.
- ALL arms (A2, D, B, C), ALL repeats, in one shuffled pool with opaque ids; the key kept in a separate file not seen by the grader. Never grade one arm's batch alone.
- Second grade, rule (mechanical, fixed now). An answer gets a second grade, by a fresh grader call in a new shuffled pool with new opaque ids, if its first grade is any of:
  1. correct = partial (any cited value);
  2. correct = yes and cited = no;
  3. correct = no and the answer text contains a citation `path:line-range` (it found something, so the grader may have missed it);
  4. the answer is the odd one out for its question: its win/not-win differs from the other two repeats of the same arm and question, and the grader's reason mentions a missing or unreadable cited line.
- If the first and second grade agree on win/not-win, that is the final grade. If they differ on win/not-win, a third grade is run, the majority of the three is final. Items outside the four triggers keep their first grade.
- The count of items that got a second grade, and how many flipped, are reported (it measures grader noise on this run; the diagnostic measured 2 of 22).
- Tokens = input + cache creation + cache read + output, from the result usage.
- A light audit of 12 random graded items is not enough on its own this time: the audit sample (seeded, seed recorded) is 20 items and the orchestrator re-reads each answer and cited range in full, reporting disagreements.

## Primary metric and bar

Unit = the question. Per question and arm, score s = wins out of k, divided by k (win fraction). Per-question difference d = s(D) - s(B). Paired, never pooled across questions.

Noise basis for the margin. Caveat: the 22 questions were picked because arm A failed them, so the flip rate overstates noise for an average question (regression to the mean); the step 1 data will give an unselected figure. The diagnostic/control measured: on partial-type questions, about 1 in 4 flips on a re-run; control vs A2 differed on 7 of 22; grader changed 2 of 22. Back-of-envelope for 40 questions, k=3: assume half the questions are "uncertain" (flip rate about 0.3): within-question sd of a win fraction about sqrt(0.3 x 0.7 / 3) = 0.26, sd of a two-arm difference 0.37, so the mean over 40 questions has sd about sqrt(20 x 0.137) / 40 = 0.041. A margin of +0.10 is about 2.4 of those sd. This is a rough estimate, not a measured power calculation; the first data from the run gives the real figure and it is reported.

Bar for PASS (D vs B), all must hold:
1. Mean d over all 40 questions >= +0.10 (go/no-go 1's bar was +4 of 30 = +0.13 per repo).
2. Mean d >= +0.05 on EACH repo (neither repo may carry it alone).
3. One-sided Wilcoxon signed-rank on the 40 per-question d, p < 0.05; ties dropped and the number dropped is reported.
4. Tokens: median over questions of (median tokens of D's k runs) / (same for B) <= 0.75. Go/no-go 1: arm A was about 0.36 of B; D adds grep and reads so more is expected, but D must be clearly cheaper than B.

Weaker, separately named outcome PASS-CHEAPER (reported as its own outcome; it is NOT a pass. The PASS bar above is the only pass): mean d >= -0.05 (not worse than B by more than half the superiority margin) overall and on each repo, AND token ratio <= 0.75. Means "same answers, cheaper". It is not a pass; the owner decides what it means for the product (the PRD claims no token saving).

Secondary (reported, no pass/fail): A2 vs B, same statistic and same margins; D vs A2 (does grep add anything over search plus neighbours); slices docs vs sessions, neighbour-spanning questions, superseded-decision questions; per-arm win rate with the share of questions at 0/3, 1/3, 2/3, 3/3.

If any of the 120 per arm runs is a limit/login/error result it is not graded and is re-run; an arm with unrun repeats at the end is reported as incomplete, not scored.

## Harness requirements

- Save the full stream-json trace for every run (one jsonl per question, arm, repeat), plus the parsed tool-call list with result sizes (as `poc/tinymem-neighbour-run.mjs` does).
- Guard: refuse and re-run a result that is a parse error, `is_error`, or matches the limit/login pattern (`hit your .*limit|session limit|usage limit|please run /login|not logged in|invalid api key|credit balance|OAuth`) with a short body. Exit the whole shard on a limit hit; never save it as an answer.
- Record `total_cost_usd`, tokens, turns and ms for every run, and the grader cost for every grade; the final report states actual cost against the estimate above.
- Questions, answers, key, and grades live in `out/step1/`; the key is never shown to graders; one questions-file hash and one PREREG hash recorded before the first run.
- No `src/` changes in this PREREG. Arm D needs a wrapper (`lx2` plus Read/Grep/Glob flags) and the new tool sentence; both frozen and hashed before run.

## What counts as a failure and what it changes

- FAIL (D vs B): mean d < +0.10, or the per-repo, Wilcoxon or token condition not met, and not PASS-CHEAPER. The hybrid is not shown better than grep on this corpus size. PRD: do not build further retrieval work on the hybrid claim; read the traces by failure type first, and let the scale test (step 2) decide whether litectx has any case at all.
- FAIL-WORSE: mean d <= -0.10, or D below B on both repos. Giving the agent search made grep answers worse (distraction?). PRD: stop the hybrid; read traces for how D used the tools.
- PASS: step 3 (filters) and then step 4 (ranking on answers) go ahead on the hybrid. Neighbour fetch is kept (and promoted to a `src/` change) only if D vs A2 or A2 vs B on neighbour-spanning questions shows it, otherwise it stays an unproven helper.
- PASS-CHEAPER: not a pass. Reported as its own outcome; the owner decides whether "same quality, cheaper" justifies going on to step 3.
- If A2 >= B - 0.05 overall at lower tokens: search alone is enough, so drop grep from the hybrid (simpler product), still decided by the owner.
- If D is about equal to A2 (|D - A2| < 0.05) at higher tokens: grep adds nothing; drop it from the hybrid.
- Trace-based reading attached to any result, by failure type from the traces: never reached gold source -> step 4 (ranking) or step 3 (filters); read right file but missed non-adjacent sections -> a window by offset and length; wrong session / superseded -> step 3 (newest first).
- If C scores >= 5 of 20 on a repo: that repo is flagged and reported separately.

## Scale test

Not part of this PREREG. See `out/step1-scale/PREREG.scale.draft.md` (draft, to be finalized and hashed separately).
