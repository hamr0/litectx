---
type: reference
title: Local Search UI
status: draft
sources: [owner interview 2026-10-22/23, ~/.cache/litectx-ui-probe/]
---

`litectx ui` is a localhost search page for a human. You type a word or a question and get a
ranked list of matches, Google style: results, not answers. It searches one repo, or every repo
under one folder. Status: **DECIDED, NOT BUILT** (owner interview 2026-10-22/23). The visual design
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
| 7 | Embeddings | Off by default; a `--embeddings` flag and a "meaning" toggle (7A). Code/doc recall is BM25-gated, so embeddings only re-order; first build ≈15 min for ~7k files. |
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

Settings live in one file, `~/.litectx/ui.json`. These are the UI's own settings, separate from
`LiteCtxConfig`.

```json
{
  "active": "pycharm",
  "sources": [
    { "name": "litectx", "path": "/home/hamr/PycharmProjects/litectx" },
    { "name": "pycharm", "path": "/home/hamr/PycharmProjects" }
  ]
}
```

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
- **One filter line**, groups separated by `│`:
  - docs/code and file type (taken from the results)
  - a typed repo picker with live suggestions (multi-select, ✕ to remove)
  - folder chips suggested from the current results
  - "old/tests last" (archive, poc, tests and logs go to the bottom)
- **View switch** (sliding, `table ●— roomy`) on the line above the results.
- **Table view**: hover a row for a quick-look popup. Roomy view shows the top 5 with a 3-line
  preview. Click any result to open a side view with line numbers, "+N more sections" and two
  links: open the file in the browser (same tab, `/view`; only indexed files open, so an untracked
  `.env` in the root is refused), or in PyCharm at that line.
- **URL state**: the search lives in the URL hash (query, repos, docs/code, type, folder,
  old/tests last, view, open side view), so Back from the file view, reload and a bookmark restore
  the page and its scroll position. Enter adds a history entry; filter changes replace it.
- Repo picker suggestions highlight the typed text.
- **Look**: monospace, Tokyo Night Day (light) / Tokyo Night (dark). Plain JS + CSS, no build step,
  no dependencies.

## Build order

1. Multi-repo collection in `src/`: one level deep, per-repo `git ls-files`, repo-prefixed paths.
   It replaces the probe's symlink corpus. Today, a non-git root falls back to a walk that ignores
   `pathspecs` and each repo's `.gitignore` (`src/indexer.js` `collectFiles`).
2. Server: `node:http`, bound to 127.0.0.1. `/view` serves only files in the active source's index, and only when their real path is inside the source root.
   Routes: page, search JSON, view, re-index, click log, sources CRUD.
3. Page F plus three knobs, each on/off and each scored:
   - one entry per file ("+N more sections")
   - old/tests last
   - a click log (query, source, opened result)
4. Tests, docs (README, `litectx.context.md`, CHANGELOG, PRD), version bump, release.

## Evidence so far (probe, 2026-10-22)

The probe was run before building, on ~7,108 git-tracked files across ~45 repos (embeddings off;
index 37 s, 367 MB; search ~7 ms).

- **Question set**: 30 questions, frozen (`~/.cache/litectx-ui-probe/questions.md`, sha256
  `58ead080…`). Q1–16 were drafted by Claude, Q17–30 written by the owner.
- **Answer key**: labelled by reading, without grep or litectx. All 518 + 57 extra files that any
  method returned were then judged blind.

The right file in the results, on 25 scored questions (strict):

| Method | #1 | top 3 | top 5 | top 10 |
|---|---|---|---|---|
| grep (ranked by distinct query words) | 6 | 13 | 16 | 20 |
| litectx Plain | 7 | 15 | 16 | 19 |
| litectx + repo filter | 11 | 16 | 16 | 20 |

- **Plain litectx ≈ grep.** The first scoring said "litectx finds twice as many". That was an
  artifact of an incomplete answer key and was reversed after the blind pool check.
- **The repo filter moves the right answer to #1** (7 → 11). It does not find new files. Grep was
  not given the same filter, so part of the gain is "search one repo", not litectx.
- **Still failing for every method**: vague questions with no shared word (Q7, Q11, Q14). This is
  the target for the bareagent Rewrite step, not for embeddings.
- n = 25: a 4-question gap is a hint, not proof.

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
