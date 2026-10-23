# DESIGN_PLAN — `litectx ui` local search page

> The spec of record is `docs/wiki/local-ui.md`. It covers sources (`~/.litectx/ui.json`), the one-repo and all-repos modes, the Settings page and the agent carry-overs. This file is the visual and implementation companion for variant F.

## Summary
- **Scope:** one page, a localhost search UI over every git repo under one folder (e.g. `~/PycharmProjects`).
- **Winner:** variant F, a mix of B (table), C (roomy) and D (side pane), refined over 6 feedback rounds on 2026-10-23.
- **Reference copy of F:** `~/.cache/litectx-ui-probe/design-F/` (`index.html`, `variants/F.js`, `variants/shared.js`, `fixtures.js`).
- **Key improvements over the probe UI (`~/.cache/litectx-ui-probe/app/server.mjs`):**
  - table/roomy switch
  - hover quick look and click side view
  - one-line filter bar
  - typed repo picker with suggestions
  - folder suggestions taken from the current results
  - old/tests-last chip
  - re-index and embeddings controls
- **Look:** terminal style, monospace (Courier New first), Tokyo Night Day for light and Tokyo Night for dark, no frameworks.

## Files to Change
- [ ] `src/` multi-repo file collection: find git repos one level under the root, run `git ls-files` per repo, and prefix each path with the repo name. Replaces the symlink corpus.
- [ ] `src/` UI server module: plain `node:http`, bound to 127.0.0.1 only.
- [ ] page asset (HTML + JS + CSS, no build step), shipped in `files`.
- [ ] CLI: `litectx ui <folder> [--port N] [--embeddings]`.
- [ ] tests (integration, `:memory:` or temp dir) + `litectx.context.md`, README, CHANGELOG, PRD, `primitives.json` if a new `@when` export.

## Implementation Steps
1. Multi-repo indexing: one level deep (owner 4A); index at `<folder>/.litectx/index.db` (5A).
2. Server routes:
   - `/`: the page.
   - `/api/search?q=`: JSON hits.
   - `/view?p=&s=&e=`: file with the chunk highlighted. Real-path confined to the root folder.
   - `/api/reindex`: incremental `index()`.
   - `/api/log`: click log.
3. Search: one `recall` over doc + code, interleaved by rank (per-kind scores are not comparable). The repo filter keeps the repo word in the query (owner choice).
4. Knobs, all on/off and scored with the probe script:
   - one entry per file with "+N more sections"
   - old/tests last
   - click log
5. Re-index on start + button only (6A). Embeddings off by default, `--embeddings` flag (7A).
6. Page = F.
7. Score F's search against the 30 frozen questions (`~/.cache/litectx-ui-probe/questions.md`, sha256 58ead080…) before release.

## Component API
- **Page state:**
  - `q`
  - `kinds {doc, code}`
  - `ext`
  - `kwOnly`
  - `repos[]`
  - `folder`
  - `demote` (old/tests last)
  - `view` (`table|roomy`)
  - `open` (path in the side view)
  - `emb`
  - `indexing`
- **Events:**
  - Enter in the search box runs the search.
  - Chip clicks toggle a filter.
  - The repo input suggests on each keystroke (substring match, max 6); Enter/click adds a repo, ✕ removes it.
  - Hover a row (table view) for the quick look.
  - Click or Enter opens the side view; Esc or ✕ closes it.
  - The switch flips the view.
  - ↻ runs re-index.
  - "meaning" toggles embeddings.
- **Hit shape shown:**
  - repo, folder, file, lines (1-based for humans)
  - kind, score, keyword/meaning marker
  - section name, 3-line preview
  - `+N more sections`
  - open-in-browser and `pycharm://open?file=&line=` links (verify the PyCharm URL scheme on the owner's machine).

## Required UI States
- **Empty query:** "type a word or a question, press Enter."
- **No matches:** "no matches. try fewer words, or turn a filter off."
- **Loading or re-indexing:** count line replaced by "re-indexing… (≈40 s for all repos)".
- **Error** (index missing, view outside root): plain text message, no stack.
- **Disabled:** "meaning" while embeddings are not built shows the one-time cost in its tooltip.

## Accessibility Checklist
- [ ] `:focus-visible` outline on every control
- [ ] targets ≥ 28px (desktop-first tool; owner asked for very simple)
- [ ] switch uses `role="switch"` + `aria-checked`
- [ ] tooltip `role="tooltip"`; side view is an `aside` with a label
- [ ] rows are keyboard reachable (`tabindex=0`, Enter opens)
- [ ] honour `prefers-reduced-motion`
- [ ] both themes pass contrast for text tokens

## Testing Checklist
- [ ] multi-repo collection: tracked files only, untracked dirs skipped, repo-prefixed paths
- [ ] `/view` refuses paths outside the root (`../`, symlink escape)
- [ ] server binds 127.0.0.1 only
- [ ] search JSON shape matches the page's expectations
- [ ] re-index is incremental (unchanged files skipped)
- [ ] probe score on the 30 questions recorded, not regressed vs the 2026-10-22 run (filter: #1 = 11/25)

## Design Tokens
- **Light (Tokyo Night Day):**
  - `--bg #e1e2e7`, `--panel #d5d6db`, `--fg #3760bf`, `--text #343b58`, `--mute #848cb5`, `--line #c4c8da`, `--sel #b7c1e3`
  - `--blue #2e7de9`, `--cyan #007197` (doc), `--green #587539` (code), `--orange #b15c00` (meaning-only), `--magenta #9854f1` (repo/section), `--yellow #8c6c3e` (keyword)
- **Dark (Tokyo Night):**
  - `--bg #1a1b26`, `--panel #16161e`, `--fg #c0caf5`, `--text #a9b1d6`, `--mute #565f89`, `--line #292e42`, `--sel #283457`
  - `--blue #7aa2f7`, `--cyan #7dcfff`, `--green #9ece6a`, `--orange #ff9e64`, `--magenta #bb9af7`, `--yellow #e0af68`
- **Font:** `"Courier New", Courier, ui-monospace, monospace`; 14px body, 13px meta.
- **Shape:** square chips (radius 0), 1px borders, no shadows. The only rounded parts are the switch track and knob.
