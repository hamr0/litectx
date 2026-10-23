---
type: reference
title: Local Search UI
status: draft
sources: [owner interview 2026-10-22/23, ~/.cache/litectx-ui-probe/]
---

`litectx ui` is a localhost search page for a human. You type a word or a question and get a
ranked list of matches, Google style: results, not answers. It searches one repo, or every repo
under one folder. Status: **BUILT, UNRELEASED** on branch `feat/local-ui` (owner interview 2026-10-22/23); the UI as built was scored on the frozen set (see Evidence). The visual design
is variant F (`DESIGN_PLAN.md` + `DESIGN_MEMORY.md` at the repo root; working copy in
`~/.cache/litectx-ui-probe/design-F/`).

## Why it exists

Two reasons:

1. **A personal "where did I write that?" across many repos.** Decisions are spread over PRDs,
   changelogs and logs in about 45 repos.
2. **A lab for litectx retrieval.** A knob tried in the UI is scored against a frozen question set.
   If it wins, it can graduate into `recall` for agents (see [Agent carry-overs](#agent-carry-overs)).

It is not a Glean clone. There are no connectors to other services, no MCP aggregation and no
hosted tier.

## Decisions (owner, 2026-10-22/23)

| # | Decision | Choice |
|---|---|---|
| 3 | Where it lives | Inside litectx, as the `litectx ui` CLI command (3B). This is the first web server in the package; see the amended non-goal in the PRD core. |
| 4 | Repo discovery depth | One level under the given folder (4A). |
| 5 | Combined index location | `<folder>/.litectx/index.db`, the same convention as a single repo (5A). |
| 6 | When it re-indexes | Once on start, plus a re-index button. Incremental: only changed files are re-read (6A). |
| 7 | Embeddings | Off by default; a `--embeddings` flag and a "meaning" toggle (7A). Code/doc recall is BM25-gated, so embeddings only re-order; first build ≈15 min for ~7k files (an estimate scaled from 67 s / 497 files, not measured). |
| — | File types | Git-tracked files only for now. A plain-folder "files mode" (PDF/Word/notes, no git) is parked. |
| — | LLM | Not in litectx. A Rewrite step (an LLM adds search words) belongs in bareagent's version of the UI (option B). litectx calling bareagent would be a dependency loop and would break the no-LLM-inside rule. |
| — | Search scope | One source at a time, picked from a dropdown. Merging scores across separate index files is unproven, so "search everything" means adding the parent folder as an all-repos source. |
| — | Repo name in a query | The query is searched as typed (the repo word stays in), and results are filtered to the named repo. |

## Sources and modes

A **source** is a `{name, path}` pair. The mode is detected from the path and printed at
startup (e.g. `mode: all repos (45 found)`):

- **One-repo mode**: the path has `.git`. It reuses that repo's own `.litectx/index.db`, the same
  index agents use, so nothing is indexed twice.
- **All-repos mode**: the path has no `.git` but contains git repos one level down. It builds one
  combined index of every repo's `git ls-files`, with paths prefixed by the repo name
  (`rwxmap/README.md`). Untracked data (e.g. 14k files in `bareloop-patients`) is never read.
  Not treated as repos: hidden-named folders (`.dotfiles`), folders named like a noise dir
  (`node_modules`, `dist`, `build`, `coverage`, `.venv`, `__pycache__`, `.litectx`) and symlinked
  directories (a symlink to a repo would index it twice); rename the folder to include it. A repo
  whose `git ls-files` fails is reported as skipped (stderr warning) and its indexed files are kept.
  Pathspecs are routed on their first segment: a leading `./` is ignored, `:`-magic specs go to every
  repo verbatim, and a spec whose first segment equals a repo name goes to that repo only.
  In this mode `impact()` (agents, not the UI) runs ripgrep over the whole root, so it also sweeps
  untracked data (over-count, the safe direction), and tsconfig path aliases are read only from
  `<root>/tsconfig.json`, so per-repo aliases are not seen.

Settings live in one file, `~/.litectx/ui.json` (override the location with the `LITECTX_UI_CONFIG`
environment variable). These are the UI's own settings, separate from
`LiteCtxConfig`.

```json
{
  "active": "pycharm",
  "sources": [
    { "name": "litectx", "path": "/home/hamr/PycharmProjects/litectx" },
    { "name": "pycharm", "path": "/home/hamr/PycharmProjects" }
  ],
  "editor": "/opt/pycharm/bin/pycharm"
}
```

- **`editor`** (optional): absolute path of the launcher that "open in pycharm" runs. Unset, the
  server tries `pycharm` on PATH, `/opt/pycharm/bin/pycharm`, the JetBrains Toolbox script,
  then `/snap/bin/pycharm-professional` and `-community`; none found → the page shows
  `PyCharm not found; set "editor" in ~/.litectx/ui.json`.

- **First run** (no sources): the page opens on the Add form. Submit a name and a path; it is
  checked, the mode is detected, and the source is indexed.
- **Title line** (small, muted): `litectx tinymem · v<version> · lightning local retrieval`; the
  version is read from litectx's own package.json by the server (also in the tab title).
- **Top bar**: `pycharm ▾ · 7,108 files · ↻ re-index · meaning: off`. Picking another source makes
  it the remembered default.
- **Settings page**: lists sources (name, path, mode, file count) with Add, Remove and Set default.
  Remove never deletes a one-repo index, because agents use it. For an all-repos index, an "also
  delete its index" box is offered, unticked by default.

## Page (variant F)

- **Top bar**: source dropdown, file count and timing; re-index and meaning controls on the right.
- **Search line**.
- **Search line**: a `×` at the end of the box clears the query text only (filters stay; the
  per-search type/folder chips go with the old results), focuses the box and adds a history entry.
  Hidden while the box is empty.
- **One filter line**, fixed order, groups set apart by spacing (no separator glyphs; the always-there controls never move;
  the per-search suggestions come after):
  - docs, code, "old/tests last" (archive, poc, tests and logs go to the bottom). docs and code start OFF = no filter (both kinds are searched); click one to search only that kind, both on = both. `✕ clear` resets them
  - a typed repo picker with live suggestions (multi-select, ✕ to remove)
  - file-type chips (taken from the results)
  - folder chips (suggested from the current results)
  - `✕ clear` last, only while a filter is set (resets filters, keeps the query)
- **View switch** (sliding, `table ●— roomy`) on the line above the results.
- **Table view**: hover a row for a quick-look popup. Roomy view shows the same results, each with a 3-line
  preview. Click any result to open a side view (sticky, so it stays in view beside the list while you scroll; stacked below it on a phone) with line numbers, "+N more sections" and two
  links: open the file in the browser (same tab, `/view`; only indexed files open, so an untracked
  `.env` in the root is refused), or in PyCharm at that line. "open in pycharm" is a button: it POSTs `/api/open {path, line}` and the
  server starts the editor (`<editor> --line N <abs path>`, detached, no shell), with "opening…" →
  "opened" or the error shown beside it. Only indexed files of the active source open.
- **Keywords only while building**: while the active source runs a pass with meaning on, a search skips the query embedding (the in-flight file embed blocks the event loop, so it would wait ~2 s) and runs on a second embeddings-off handle on the same db; the response carries `keywordsOnly: true` and the top bar says so. After the pass, searches use meaning again.
- **URL state**: the search lives in the URL hash (query, repos, docs/code, type, folder,
  old/tests last, view, open side view), so Back from the file view, reload and a bookmark restore
  the page and its scroll position. Enter adds a history entry; filter changes replace it.
- Repo picker suggestions highlight the typed text.
- The repo box survives filter-line rebuilds (status poll during a pass, search replies): text, caret, focus and list are kept.
- **Repo filters are sticky**: repos picked by hand stay until ✕ or `✕ clear`; repo names typed in the query are added (deduped), never replacing. `✕ clear` (shown only when a filter is set) resets repos, docs/code, type, folder and old/tests last, keeps the query, and re-runs the search. With repos set, the server filters to them before interleaving docs and code.
- **Instant feedback**: re-index, meaning and source changes show a busy state at click time (button disabled, CSS spinner, label, elapsed seconds; static indicator under reduced motion), then the result (`+3 ~1 -0 · 2.1 s`). No progress bar: `index()` has no progress hook, so elapsed time is all that is honest. If the optional peer `@huggingface/transformers` is missing the library drops to keyword-only and the page shows "meaning unavailable: install ...".
- **Look**: monospace, Tokyo Night Day (light) / Tokyo Night (dark). Plain JS + CSS, no build step,
  no dependencies.

## Build order

1. **Done.** Multi-repo collection in `src/`: one level deep, per-repo `git ls-files`, repo-prefixed paths.
   It replaces the probe's symlink corpus. Today, a non-git root falls back to a walk that ignores
   `pathspecs` and each repo's `.gitignore` (`src/indexer.js` `collectFiles`).
2. **Done.** Server: `node:http`, bound to 127.0.0.1. `/view` serves only files in the active source's index, and only when their real path is inside the source root.
   Routes: page, search JSON, view, re-index, click log, sources CRUD.
3. **Done.** Page F plus three knobs, each on/off and each scored:
   - one entry per file ("+N more sections")
   - old/tests last
   - a click log (query, source, opened result)
4. Tests, docs (README, `litectx.context.md`, CHANGELOG, PRD), version bump, release.

## Evidence so far (probe, 2026-10-22)

The probe was run before building, on ~7,108 git-tracked files across ~45 repos (embeddings off;
index 37 s, 367 MB; search ~7 ms). Those figures are the probe's, on a symlink corpus. The shipped
`childRepos` mode found 7,193 files and took 63 s cold without yield (about 2 min with the UI's
yielding index).

- **Question set**: 30 questions, frozen (`~/.cache/litectx-ui-probe/questions.md`, sha256
  `58ead080…`). Q1–16 were drafted by Claude, Q17–30 written by the owner.
- **Excluded from scoring**: Q13 and Q16 (no answer exists), Q17, Q18 and Q24 (loose wording). That
  leaves 25 scored questions.
- **Answer key**: labelled by reading, without grep or litectx. All 518 + 57 extra files that any
  method returned were then judged blind.

The right file in the results, on 25 scored questions (strict):

| Method | #1 | top 3 | top 5 | top 10 |
|---|---|---|---|---|
| grep (ranked by distinct query words) | 6 | 13 | 16 | 20 |
| litectx Plain | 7 | 15 | 16 | 19 |
| litectx + repo filter | 11 | 16 | 16 | 20 |

- **Plain litectx ≈ grep, but not robustly.** The first scoring said "litectx finds twice as many".
  That was an artifact of an incomplete answer key and was reversed after the blind pool check. The
  result depends on how labels are counted. Counting only blind-judged files (no gold) at #1/3/5/10:
  grep 6/12/15/16, plain 2/7/10/17, filter 3/10/13/18. Counting partial matches too: grep
  12/20/22/24, plain 10/19/20/22, filter 15/20/21/23. So "plain ≈ grep" does not hold under every
  counting.
- **The repo filter moves the right answer to #1** (7 → 11). It mostly re-orders; it recovered one
  file (Q20, a typo query). Grep was not given the same filter, so part of the gain is "search one
  repo", not litectx. The filter arm was scored on chunk-level lists that contain duplicate files
  while plain was not (Q2, Q5), which understates the filter.
- **Q3 and Q25**: grep found them (rank 2) and litectx did not, so these are not only Rewrite
  targets.
- **Still failing for every method**: vague questions with no shared word (Q7, Q11, Q14). This is
  the target for the bareagent Rewrite step, not for embeddings.
- n = 25: a 4-question gap is a hint, not proof.
- **Next**: the built UI was scored; see the next section.

## Evidence: the UI as built (2026-10-23)

Scored on the same 25 questions, same answer key, same blind judging as above. "The UI" is the
default page search at commit 5c3917f: repo names in the query become a repo filter, docs and code
together, one entry per file, old/tests last. Index: scratch `childRepos` index of
`~/PycharmProjects`, 7,211 files, embeddings off. Every top-10 slot of every arm is labelled (0
unlabelled). The numbers were recomputed from `results-*.json`, the gold files and the judge files in
`~/.cache/litectx-ui-probe/`.

Right file found at #1 / top 3 / top 5 / top 10 (of 25):

| Method | Strict (key + judged yes) | Judged yes only (no key) | Lenient (+ partial) |
|---|---|---|---|
| grep | 6 / 13 / 16 / 20 | 6 / 12 / 15 / 16 | 12 / 20 / 22 / 24 |
| litectx Plain | 7 / 15 / 16 / 19 | 2 / 7 / 10 / 17 | 10 / 19 / 20 / 22 |
| litectx + repo filter (probe, deduped) | 11 / 16 / 17 / 20 | 3 / 10 / 13 / 18 | 15 / 20 / 21 / 23 |
| UI before the fix | 9 / 16 / 18 / 21 | 2 / 10 / 13 / 17 | 13 / 20 / 21 / 23 |
| **UI as built (fixed)** | **11 / 17 / 18 / 21** | 3 / 11 / 12 / 17 | 15 / 21 / 22 / 23 |
| UI fixed, old/tests last off | 11 / 16 / 17 / 20 | 3 / 10 / 13 / 18 | 15 / 21 / 21 / 23 |

- **With the key, the built UI beats grep in every column**: 11 vs 6 at #1, 18 vs 16 in the top 5.
- **Old/tests last adds a little**: top 3 is 17 vs 16 and top 5 is 18 vs 17 (UI fixed vs the same
  run with it off). #1 and top 10 are not helped.
- **On judged-yes-only labels grep still wins #1** (6 vs 3). The UI is a good shortlist, not a
  reliable top hit.
- **The Q20 rank drop was a bug.** The repo filter ran after the doc/code interleave, which pushed
  Q20's right file to rank 9. Fixed in 5c3917f: Q20 now has an answer at #1 (`rwxmap/CHANGELOG.md`,
  judged yes), and the key's `rwxmap/README.md` is at #5. That fix is the 9 to 11 at #1.
- **Still failing for every method**: the vague questions Q7, Q11 and Q14. Q3 is found only by grep.
- n = 25: gaps of 1 or 2 are noise.

## Agent carry-overs

These are things the UI may teach `recall` for agents. Each is deferred until its named
condition is met.

| Idea | Un-defer when |
|---|---|
| A path/repo filter on `recall` (e.g. `recall(q, {under: "rwxmap/"})`) | The UI ships it and its probe score holds (#1 ≥ 11/25 on the frozen set). |
| Multi-repo indexing as a library feature (not only for the UI) | Build step 1 lands; it ships with the UI. |
| One entry per file in results | The click log shows duplicate chunks of one file pushing other good files out of the top 10. |
| Old/tests ranked last | Scored on the frozen set and on click-log queries without lowering the #1 count. |
| Any ranking change for agents | Checked against the click-log test set (real queries plus the opened result) before shipping. |
| Typo help ("did you mean") from index vocabulary | The click log shows typo queries returning nothing (e.g. Q20 "mechancially"). |

## Parked

- **Files mode** (plain folders, PDF/Word/text via `ingest()`). Un-defer when the owner names a
  real folder to search.
- **Searching several sources at once.** Un-defer when a score-merge across index files is
  measured and holds up on the frozen set.
- **LLM Rewrite.** Lives in bareagent. Un-defer when the plain UI ships and the vague-question
  misses bother the owner in real use.

**Stopping and cancelling.** While a pass runs the re-index / meaning chip is a cancel button (`POST /api/cancel`, same Host/Origin guards as the other POSTs). It aborts the pass through `index({ signal })`: the pass stops after at most one in-flight embed. The keyword index commits whole first and vectors are then written file by file, so a cancel keeps the full keyword index and every vector so far; meaning stays ON and the next pass embeds only the files still without one (the page says "cancelled · N of M embedded · the next pass finishes the rest"). A cancel before the commit leaves the index unchanged. Ctrl+C (and switching or removing the source) aborts the same way, then exits; a crash mid-embed keeps the vectors written so far too. Measured: a 12,800-file build cancelled at 3,146 vectors; Ctrl+C at 4,546 exited in 0.06 s; the restart embedded exactly the remaining 8,254 (no file twice), `integrity_check` ok.
