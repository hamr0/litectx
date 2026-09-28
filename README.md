```
   ╭───────────────────────────────────────╮
   │  litectx                                │
   │  the context-engineering library        │
   │  write · select · compress · isolate    │
   ╰───────────────────────────────────────╯
```

<p align="center">
  <a href="https://github.com/hamr0/litectx/actions/workflows/ci.yml"><img src="https://github.com/hamr0/litectx/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/github/package-json/v/hamr0/litectx?label=version&color=2a4f8c" alt="version (auto from package.json)">
  <img src="https://img.shields.io/badge/license-Apache%202.0-2a4f8c" alt="license: Apache 2.0">
</p>

**Lightweight, complete context engineering for AI agents — an active-decay memory plus the full write / select / compress / isolate toolkit, in one local library.**

litectx makes the *context* better, not the model smarter — it owns no loop and calls no model of its own. One production dependency (`better-sqlite3`). Pre-1.0: the surface is stable and CI-gated, but may still evolve — see the [CHANGELOG](CHANGELOG.md).

## Two cores

**Active-decay memory** — crucial for long-running workflows. What gets used rises in the ranking; what goes stale fades on its own, and the notes that keep proving useful surface as candidates for promotion to durable facts. This is what [bareloop](https://github.com/hamr0/bareloop) leans on heavily: memory that survives across runs is what lets a workflow actually improve, instead of relearning the same thing every time.

**Context-engineering toolkit** — everyday boilerplate for agentic automation, and for building harnesses, arbiters, or judges. **write** (store it), **select** (find it by meaning, walk the code graph to what's related), **compress** (render full, as a signature, or drop it), **isolate** (park a payload and page it back). A judge is only as good as what's in its window — this is how you fit the right evidence into it.

Both cores ride the same graph, in one local file.

## Start here

- **MCP client** (Claude Code, Cursor…) → run `litectx-mcp --root /path/to/repo`. Tools: index · recall · impact · get · recent · promotions · remember · forget.
- **Your own loop** → `npm i litectx`, hand your assistant `litectx.context.md` (the full API, including the render/budget verbs MCP doesn't expose).
- **AI agent / tool-calling** → read `primitives.json` first (`unpkg.com/litectx/primitives.json`, or import it); generated from source, never drifts.

## What's inside

One substrate — a typed code+context graph in one file — and the verbs that read and write it. Every piece works alone.

| Group | Verbs | What it does |
|---|---|---|
| **Substrate** | `index` · `getNode` · `related` · `get` | Index a repo into typed nodes + import edges. Fetch a whole body or just one chunk. Self-heals on upgrade. |
| **Select** | `recall` · `impact` | `recall` ranks by relevance, not just keyword match. `impact` walks callers/callees to what a change touches, plus a risk bucket. |
| **Memory** | `remember` · `ingest` · `forget` · `recentMemory` · `count` · `enumerate` | Facts, episodes, notes, and uploaded files — recall by meaning, per-tenant `scope`, retention, and an exhaustive count/enumerate for "all of them" passes recall can't answer. |
| **Compress / Isolate** | `assemble` · `summaryWindow` · `trim` · `compress` · `stash` · `peek` · `evict` | Fit a transcript to a budget, roll old turns into a restorable summary, render a symbol full/signature/dropped, park a payload and page it back. |
| **Sockets** | `liteCtxAsStore` · write-gate | Make a `LiteCtx` satisfy a host's memory interface in one line. A gate-able action and an audit line per write. |
| **Graphs** | `observe` / `trace` · `getNode` / `related` | A live run as a pipeline graph, and the code mapped by its edges. |

Two recipes cover most uses: mount litectx as a host's memory store (one line, host code never changes), or budget-fit a transcript for the next model call (deterministic, accounts for every elision).

## Proof — measured, not asserted

Every claim below is a committed benchmark; the core ones run in CI on every push.

| Claim | Result |
|---|---|
| memory recalls by *meaning*, not just words | paraphrase recall **0.000 → 0.574** with embeddings on; exact matches held |
| impact never marks a used symbol "safe to remove" | safety violations **= 0**, enforced by exit code |
| `assemble` keeps a needed unit a tight budget would drop | rescued as a signature (1/1 vs 0/1 without) |
| `summaryWindow` retains decisions from dropped turns | **3/3** vs **0/3** for a plain trim |

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
