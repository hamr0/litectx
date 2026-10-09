# Answer test — pre-registered bar (written 2026-10-06, before any question is run)

Arms (claude -p, sonnet, one fresh run per question, max 15 turns):
  A = litectx recall/get only (branch build, embeddings on)
  B = Read/Grep/Glob over the same corpus
  C = no tools (floor)
Questions: 30 per repo (bareloop, bareagent), 15 docs + 15 session-only, written blind by a separate worker.
Grading: blind (arm labels stripped, order shuffled), one question per grader call, grader sees question, gold, must-facts, sources
and the corpus; reads cited lines. Scores per answer:
  correct = all `must` facts present and nothing contradicting gold (partial counted separately, not as correct)
  cited   = at least one citation whose lines actually contain the answer (any valid location)
  win     = correct AND cited
Tokens = input + cache_creation + cache_read + output, from the json usage.

PASS (litectx answers better) iff, on BOTH repos:
  wins(A) >= wins(B) + 4   (of 30)
  AND median tokens(A) <= median tokens(B)
Reported separately for docs and session questions; a pass overall with A losing on one type is reported as such.
TIE/LOSS on either repo = NOT CONFIRMED. If C scores >= 5 wins on a repo, that repo's questions are flagged as leaking general knowledge.
