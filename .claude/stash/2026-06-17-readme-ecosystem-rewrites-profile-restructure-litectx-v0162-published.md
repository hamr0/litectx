# Session stash — 2026-06-17

**Focus:** Docs/positioning pass across the whole bare* family + hamr0 profile, plus a litectx README rewrite shipped as `litectx@0.16.2`. No product code changed anywhere — all README/CHANGELOG/profile + one version bump.

## Working tree note (important)
- Two parallel clones exist and are **linked at the working-file level**: editing `/home/hamr/PycharmProjects/<repo>` also reflects in `/home/hamr/Documents/PycharmProjects/<repo>`. Worked from `~/PycharmProjects/*` throughout.
- litectx has **unrelated uncommitted work** in the tree (`examples/contextgraph/*`, untracked `src/contextgraph.js`). Left untouched — every commit staged only the specific README/CHANGELOG/package files.

## What shipped (all committed + pushed)

### 1. "The bare ecosystem" section — unified across 6 repos
- Replaced the old 4-column wide table with **Sample B (prose rows)**: a **Core** group (bareagent · bareguard · litectx) + **Optional reach** (barebrowse · baremobile · beeperbox). Identical section in all six READMEs.
- litectx pitch (per user): "tree-sitter memory with decay + lightweight context engineering (write · select · compress · isolate)" — **no "Replaces" line** for litectx (description is the pitch); others keep Replaces.
- Repos: bareagent, barebrowse, baremobile, bareguard (replaced existing table) · litectx, beeperbox (new section added). Each got an Unreleased CHANGELOG "Documentation" entry. beeperbox is on `master`; rest `main`.

### 2. flightlog + pulselog paired as a "server-log suite"
- Added an identical pairing table near the end of both READMEs. Mapping (user-confirmed): **flightlog → replaces Sentry**, **pulselog → replaces hosted analytics** (analytics-led in the Replaces cell). CHANGELOG entries in both.

### 3. hamr0 profile (github.com/hamr0, repo `hamr0/hamr0`, main) — big restructure
Final structure (two pillars + value-first):
- Bio kept but **shortened** (dropped the inline knowless example; kept "Capability without custody"). Tagline (line 5) reworded by me to name both pillars — user said **keep it**.
- Substrate list de-jargoned: "email, maps, git, chat apps, the logs your apps already write" (was "email, git, GPS, the open messaging graph").
- `## 🤖 AI & agents` — baresuite split into **Core** + **Optional reach** (each repo full line) + **Building with AI** (liteagents, coding-assistant, agentic-toolkit, multis) + aurora lineage `<sub>`.
- `## 🛡️ Privacy-first` — split into **Privacy products** (addypin, signedreply, plato, late.fyi, ama, privpn, privcloud, wearehere + 10 weare* folded in `<details>`) and **Privacy primitives** (knowless, flightlog+pulselog).
- `## 🎧 Also` — sawt + mailproof (mailproof moved here per user: more integrity than privacy).
- `## 🗄️ Archive & lineage` — `<details open>` (auto-expand, user choice), aurora→litectx/bareagent, mcprune→barebrowse, mcp-gov→bareguard, terribic, AgenticAI, bareapp, polarized.
- **aurora** marked `[ARCHIVED]` (dropped "Flagship", points to litectx + bareagent).
- Profile pushes sometimes hit a non-fast-forward from the **stats bot** (`<!-- STATS -->` line) — rebase onto origin/main then push.

### 4. litectx README rewrite → published `litectx@0.16.2`
- Rewrote **value-first**, no emojis: leads with **Two cores** (active-decay memory · CE toolkit) + **Two ways to use it** (code-aware memory layer over MCP · CE library in your loop). Tech demoted to one **"Under the hood"** block. Dropped PRD / benches-PRD / poc-RESULTS / graphs.md / "§" internal-doc links. Docs section trimmed to context.md + CHANGELOG. ASCII hero **kept**.
- Release: bumped 0.16.1 → **0.16.2** (`npm version --no-git-tag-version`), CHANGELOG 0.16.2 entry, commit `release(0.16.2)…`, tag `v0.16.2`, pushed main + tag.
- **Publish = OIDC `workflow_dispatch`** (NOT local `npm publish`): `gh workflow run publish.yml -R hamr0/litectx`. Watched run 27681143339 → green (typecheck + npm test + publish + registry-verify). `npm view litectx version` → 0.16.2. **This is the standing release procedure for litectx.**

## Validated this session (user explicitly asked "did you POC where needed?")
- Publish: tests/typecheck green in workflow, registry-verified, `npm view` confirmed.
- **Privacy-list spacing fix proven**, not asserted: rendered hamr0 README via `gh api --method POST /markdown -f mode=gfm` → privacy product list is **TIGHT** (no `<p>` wrappers). The fix was pulling wearehere's `<details>` OUT of its list item (a blank line inside a list item makes GFM render the whole list loose).
- **All 64 URLs** in hamr0 + litectx READMEs return 200 (addypin.com first showed 000 = transient/UA; 200 on retry with browser UA).
- Ran litectx against **liteagents**: `index` 205 files/9ms, recall + impact work; surfaced that liteagents copies command files (friction.js, init_skill.py, remember.md) across packages/{ampcode,opencode,droid,claude}.
- **Carried over, NOT re-run**: litectx corpus benches (recall MRR, paraphrase 0.574) are local pre-push gates — reused prior committed results. CI-gated benches (assemble 1/1, summaryWindow 3/3, impact safety) DID run fresh in the publish.

## Open / offered, not done
- Offered to re-run `npm run bench:all` to refresh corpus bench numbers — not requested yet.
- The `.litectx` auto-index discussion: it's the **SessionStart `warm-index.sh` hook** in `~/.claude/settings.json` running `litectx index --embeddings` in every git repo's cwd (→ ~9MB `.litectx/index.db` everywhere, incl. liteagents). User likes the default. **Proposed but NOT yet applied:** (1) global gitignore `.litectx/` in `~/.config/git/ignore`; (2) gate the hook to opt-in repos; (3) drop `--embeddings` to shrink dbs. Awaiting go-ahead.
- LinkedIn post (litectx + 6-repo stub, emoji and no-emoji versions) and a short Reddit post drafted in-chat — not saved to repo, user to post.

## Marketing copy guardrail (reusable)
When writing litectx posts/README: keep claims to the **honest A/B story** — recall helps FINDING not EXECUTING; weaker model = "nudge, not rescue"; cross-session memory = "shortlist, not guaranteed #1"; token-saving belongs to compress/assemble (benched), relevance belongs to memory. Don't slap "proven to save tokens" on the decay engine.
