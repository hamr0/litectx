```
   ╭─────────────────────────────────────────╮
   │  litectx                                │
   │  lightning-fast local search            │
   │  for agents and humans                  │
   │  impact · recall · remember             │
   ╰─────────────────────────────────────────╯
```

<p align="center">
  <a href="https://github.com/hamr0/litectx/actions/workflows/ci.yml"><img src="https://github.com/hamr0/litectx/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/github/package-json/v/hamr0/litectx?label=version&color=2a4f8c" alt="version (auto from package.json)">
  <img src="https://img.shields.io/badge/license-Apache%202.0-2a4f8c" alt="license: Apache 2.0">
</p>

## What is litectx

**For agents** — an MCP server that indexes your code and docs and hands the agent only the relevant pieces as `file:lines` handles, instead of whole files. It also answers "what breaks if I change this?" and keeps memory across sessions.

**For you** — the same search in a simple local page, with filters by docs, code, file type, folder or repo. Searches take milliseconds, it runs on 127.0.0.1, and there is no LLM in it.

## Lightning-fast local search

`litectx start` opens a local search page over your repos: type a word or a question, get ranked docs and code in milliseconds, filter by docs, code, file type or folder, and read a hit in a side view. It shows results, not answers, and runs on 127.0.0.1 only.

<p align="center"><img src="https://raw.githubusercontent.com/hamr0/litectx/main/docs/assets/ui-demo.gif" alt="The litectx search page: a query returns ranked docs and code in tens of milliseconds, then docs/code and folder filters, a side view, and the roomy layout" width="800"></p>

## Easy setup

```sh
npm i -g litectx
litectx
```

```text
────────────────────────────────────────────────────────
litectx · Claude ✓ · page running at http://127.0.0.1:4747
index: 7,246 files · 44 repos · meaning off
────────────────────────────────────────────────────────
  1 start   2 stop   3 index   4 setup   5 status   q quit
>
```

Pick a number, it runs, it exits. The same things as commands:

- `litectx start` — the search page in the background; opens your browser, and takes the next free port if 4747 is taken.
- `litectx stop` — shuts the page down.
- `litectx index [path]` — index a folder.
- `litectx setup` — connects Claude Code once, for every repo: the MCP server, the indexing hook and the pre-edit impact hook. `litectx setup --remove` undoes it.
- `litectx status` — what is set up, running and indexed.

## Start here

- **CLI** — the commands above. `litectx` alone gives the menu.
- **MCP for agents** — `litectx-mcp --root /path/to/repo`, for any MCP client (Claude Code, Cursor…). Tools: index · recall · impact · get · recent · promotions · remember · forget. `litectx setup` wires it into Claude Code for you.
- **UI for humans** — `litectx start`, or `litectx ui [path]` over one repo or every git repo under a folder: ranked docs and code, one line per file, a side view to read the hit. Embeddings stay off unless you switch them on.

Building your own loop? `npm i litectx` and hand your assistant `litectx.context.md` (the full API, including the render/budget verbs MCP doesn't expose). Tool-calling agents: read `primitives.json` first (`unpkg.com/litectx/primitives.json`, or import it); it is generated from source, never drifts.

## What's inside

Everything a loop needs for its context, whether your automation is a harness making LLM calls or an LLM making tool calls — the same primitives either way. Use it in part or in full instead of locking into corporate-grade primitives. Used in production by [bareloop](https://github.com/hamr0/bareloop) and [fwdloop](https://github.com/hamr0/fwdloop).

One substrate — a typed code+context graph in one file — and the verbs that read and write it. Every piece works alone.

| Group | Verbs | What it does |
|---|---|---|
| **Substrate** | `index` · `getNode` · `related` · `get` | Index a repo into typed nodes + import edges. Fetch a whole body or just one chunk. Self-heals on upgrade. |
| **Select** | `recall` · `impact` | `recall` ranks by word match plus import-graph proximity, re-ranked by meaning when embeddings are on (doc/code hits must share a query word). `impact` walks callers/callees to what a change touches, plus a risk bucket. |
| **Memory** | `remember` · `ingest` · `forget` · `recentMemory` · `count` · `enumerate` | Facts, episodes, notes, and uploaded files — recall by meaning, per-tenant `scope`, retention, and an exhaustive count/enumerate for "all of them" passes recall can't answer. |
| **Compress / Isolate** | `assemble` · `summaryWindow` · `trim` · `compress` · `stash` · `peek` · `evict` | Fit a transcript to a budget, roll old turns into a restorable summary, render a symbol full/signature/dropped, park a payload and page it back. |
| **Sockets** | `liteCtxAsStore` · write-gate | Make a `LiteCtx` satisfy a host's memory interface in one line. A gate-able action and an audit line per write. |
| **Graphs** | `observe` / `trace` · `getNode` / `related` | A live run as a pipeline graph, and the code mapped by its edges. |

Two recipes cover most uses: mount litectx as a host's memory store (one line, host code never changes), or budget-fit a transcript for the next model call (deterministic, accounts for every elision).

One SQLite file, two production dependencies (`better-sqlite3` for storage and search, `web-tree-sitter` for parsing code), no LLM inside, no always-on server. litectx makes the *context* better, not the model smarter. Pre-1.0: the surface is stable and CI-gated, but may still evolve — see the [CHANGELOG](CHANGELOG.md).

## Proof — measured, not asserted

Every claim below is a committed benchmark; the core ones run in CI on every push.

| Claim | Result |
|---|---|
| written memory (facts, episodes) recalls by *meaning*, not just words | paraphrase recall **0.000 → 0.574** with embeddings on; exact matches held |
| impact never marks a used symbol "safe to remove" | safety violations **= 0**, enforced by exit code |
| `assemble` keeps a needed unit a tight budget would drop | rescued as a signature (1/1 vs 0/1 without) |
| `summaryWindow` retains decisions from dropped turns | **3/3** vs **0/3** for a plain trim |

**Docs search saves cost without losing answers.** The pre-registered test: 24 fresh questions about two projects' docs, 2 runs each, at about 50 and about 1,500 docs. An agent with litectx plus grep answered as well as grep alone at roughly 25-35% lower total cost (about a third fewer tokens when the question's wording differs from the docs, about 7% when it matches; the saving held as the docs grew about 30x). Caveat: in that test the litectx arm read each hit together with its neighbouring sections (test-wrapper behaviour, not shipped), which explains much of its correctness edge. Treat it as "no loss, lower cost", not "better answers". Docs and code hits must share a query word; meaning only re-ranks (embeddings are off by default in the library, on in the CLI and MCP server).

**What it doesn't claim.** litectx scaffolds *search* — it doesn't replace the model's reasoning. A strong model saw no net speed win from in-loop recall; a weaker model got a consistent nudge, not a rescue. The durable wins are cross-session memory and impact's safety check.

## The bare ecosystem

Local-first, composable agent infrastructure. Same API patterns throughout —
mix and match, each module works standalone.

**Core** — the brain, the gate, the memory.

- **[bareagent](https://npmjs.com/package/bare-agent)** — the think→act→observe loop. *Goal in → coordinated actions out.* Replaces LangChain, CrewAI, AutoGen.
- **[bareguard](https://npmjs.com/package/bareguard)** — the single gate every action passes through. *Action in → allow / deny / ask-a-human out.* Replaces hand-rolled allowlists and scattered policy code.
- **[litectx](https://npmjs.com/package/litectx)** — code + memory graph with activation decay, plus lightweight context engineering (write · select · compress · isolate). *Query in → ranked context out.*

**Optional reach** — give the agent hands.

- **[barebrowse](https://npmjs.com/package/barebrowse)** — a real browser for agents. *URL in → pruned snapshot out.* Replaces Playwright, Selenium, Puppeteer.
- **[baremobile](https://npmjs.com/package/baremobile)** — Android + iOS device control. *Screen in → pruned snapshot out.* Replaces Appium, Espresso, XCUITest.
- **[beeperbox](https://github.com/hamr0/beeperbox)** — 50+ messaging networks via one MCP server (headless Beeper Desktop in Docker). *Chat in → unified message stream out.* Replaces Twilio, per-platform bot APIs.

## Docs

- **Integration Guide** (`litectx.context.md`) — the complete adopter contract: every option, the full API, the graph schema. Hand it to your AI assistant. Ships in the package.
- **Primitives manifest** (`primitives.json`) — every verb, when to use it, and a runnable example, as machine-readable JSON. Ships in the package, generated from source.
- **[CHANGELOG](CHANGELOG.md)** — keep-a-changelog; an entry every release.

## License

Apache 2.0. See [LICENSE](LICENSE).
