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

litectx handles the parts of context that trip agents up: remembering across sessions, finding the right code, and fitting it all into the window. It makes the *context* better, not the model smarter — which matters most when the model is small, cheap, or local and the window is tight. It owns no loop and calls no model of its own. Light enough to read in an afternoon; complete enough that you don't reinvent memory, recall, or budget-fitting. One production dependency (`better-sqlite3`). Import what you need, ignore the rest.

> **Status: v0.16.1 — `npm i litectx`.** Pre-1.0: the surface is stable and CI-gated, but may still evolve (`recall()` / `impact()` / `assemble()` are async). Release detail in the [CHANGELOG](CHANGELOG.md).

## Two cores

litectx is built around two things an agent needs and rarely has together.

**Active-decay memory — what the agent knows over time.**
An agent keeps a scratchpad as it works. What gets used rises in the ranking; what goes stale fades on its own. The notes that keep proving useful surface as candidates for promotion to durable facts — which a human can confirm before they stick. Recall matches by *meaning*, not just keywords, and everything survives across sessions and re-indexes. The payoff is a small, relevant slice of memory instead of a growing wall of text — exactly what a weaker, cheaper, or local model needs to stay on track.

**Context-engineering toolkit — how you shape a single call.**
The moves you need to put the right thing in front of the model: **write** (store it), **select** (find it by meaning and walk the code graph to what's related), **compress** (render a symbol in full, as a signature, or dropped — or roll old turns into one summary), **isolate** (park a payload out of context and page it back when needed). Together they fit more signal into a smaller window.

Both cores ride the same graph in one local file — index once, and memory and code recall share it.

## Two ways to use it

**As a code-aware memory layer — over MCP.**
Point Claude Code, Cursor, or any MCP client at it. It indexes your repo and serves ranked recall, impact (what a change would touch), and a memory you write to and recall by meaning — no code to write.

```jsonc
{ "mcpServers": { "litectx": { "command": "litectx-mcp", "args": ["--root", "/path/to/repo"] } } }
// tools: index · recall · impact · get · recent · promotions · remember · forget
```

**As a context-engineering library — in your own loop.**
Import it for the full toolkit, including the render and budget verbs MCP doesn't expose (deciding *when* to compress is your loop's job, not a model's):

```js
import { LiteCtx } from "litectx";

const ctx = new LiteCtx({ root: "/path/to/repo", include: [".ts", ".js", ".py", ".md"] });
await ctx.index();

const hits  = await ctx.recall("where do we validate the auth token?", { kind: "code" });
const blast = await ctx.impact("validateToken");          // what a change would touch + a risk bucket

await ctx.remember("fact:auth-uses-jwt", "Auth is JWT, verified in middleware.", { kind: "fact", by: "human" });
const facts = await ctx.recall("how does login work", { kind: "fact" });   // matches by meaning
```

There's a CLI too (`litectx index`, `litectx recall …`) over the same index. Node >= 18. Hand your assistant `litectx.context.md` — it ships in the package and documents every option and the full API.

## Recipes

**Mount litectx as a host's memory backend** — one line, the host code never changes:

```js
import { LiteCtx, liteCtxAsStore } from "litectx";
const store = liteCtxAsStore(new LiteCtx({ root, embeddings: true }));
// store now satisfies { store, search, get, delete } — ranked, graph-aware recall in place of a substring scan
```

**Budget-fit a transcript for the next model call** — deterministic, accounts for every elision:

```js
import { assemble } from "litectx";
const { units, dropped, tokens } = await assemble(transcriptUnits, { budget: 8000, task });
// pinned units never drop; a tool-call + its result are kept or dropped together; dropped[] lists what was cut
```

## What's inside

One substrate — a typed code+context graph in one file — and the verbs that read and write it. Every piece works alone.

| Group | Verbs | What it does |
|---|---|---|
| **Substrate** | `index` · `getNode` · `related` · `get` | Index a repo (routed by file extension) into typed nodes + import edges. Address a node, walk its edges, fetch any body. |
| **Select** | `recall` · `impact` | **recall** ranks by relevance now, not just keyword match. **impact** walks callers/callees to what a change touches + a risk bucket. |
| **Memory** | `remember` · `ingestDocument` · `forget` · `recentActivity` · `promotionCandidates` · `reviewCandidates` | Knowledge that isn't a file — facts, episodes, notes, and **dropped-in PDF/DOCX** (`ingestDocument` extracts → segments → recall by meaning; optional lazy parser tier). Same store, same ranking, carries provenance, survives re-index. Episodes auto-prune. |
| **Compress / Isolate** | `assemble` · `summaryWindow` · `trim` · `compress` · `stash` · `peek` · `evict` | Fit a transcript to a budget, roll old turns into a restorable summary, render a symbol full/signature/dropped, park a payload and page it back. |
| **Sockets** | `liteCtxAsStore` · write-gate | Make a `LiteCtx` satisfy a host's memory interface in one line. A gate-able action and an audit line per memory write. |
| **Graphs** | `observe` / `trace` · `getNode` / `related` | Two views over the same data: a live run as a pipeline graph, and the code mapped by its edges. |

## Proof — measured, not asserted

Every claim below is a committed benchmark; the core ones run in CI on every push.

| Claim | Result |
|---|---|
| graph-aware recall beats plain keyword search | gate cleared on the ablation |
| recall lands the ground-truth file | per-dataset accuracy floors hold or beat |
| memory recalls by *meaning*, not just words | paraphrase recall **0.000 → 0.574** with embeddings on; exact matches held |
| impact never marks a used symbol "safe to remove" | safety violations **= 0**, enforced by exit code |
| `assemble` keeps a needed unit a tight budget would drop | rescued as a signature (1/1 vs 0/1 without) |
| `summaryWindow` retains decisions from dropped turns | **3/3** vs **0/3** for a plain trim |

**What it doesn't claim.** litectx scaffolds *search* — it doesn't replace the model's reasoning. In live A/B runs, in-loop recall gave a strong model no net speed win (its bottleneck is thinking, not finding) and a weaker model a consistent nudge, not a rescue. The durable wins are **cross-session memory** (on a fresh session it surfaces the right past decision into your top few results, where keyword search is blind — a shortlist, not a guaranteed top hit) and **impact's safety check**.

## Under the hood

If you want the mechanism: storage is `better-sqlite3` + FTS5 in a single file; code structure comes from tree-sitter; `impact`'s caller sweep shells out to `ripgrep` (no LSP — so `impact` needs `rg` on `PATH`, or a symbol reads as zero callers); ranking and decay use ACT-R-style activation. Semantic recall is an optional local embeddings model (ONNX, no API, ~23 MB downloaded once) — without it, recall falls back to keyword search.

## Where litectx fits

litectx is the **context organ** — what an agent knows and how it's organized. It pairs with [baresuite](https://github.com/hamr0/bareagent) (`bareagent` + `bareguard`), the **runtime** — what an agent does, step by step, safely. They meet at one interface; the dependency points one way.

| | baresuite | litectx |
|---|---|---|
| **is a** | runtime / harness | library |
| **owns** | loop, tools, gates, budgets | recall, impact, graph, memory, the context verbs |
| **made for** | lightweight one-shot automation | persistent, long-running loops |
| **has a model/loop** | yes | no — deterministic |
| **depends on** | imports litectx | nothing (standalone) |

litectx owns the data and the mechanism; baresuite owns the control flow — including the decision of *when* to compress or recall.

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

| | |
|---|---|
| **Integration Guide** (`litectx.context.md`) | The complete adopter contract — every option, the full API, the graph schema. Hand it to your AI assistant. Ships in the package. |
| **[CHANGELOG](CHANGELOG.md)** | keep-a-changelog; an entry every release. |

## License

Apache 2.0. See [LICENSE](LICENSE).
