# litectx — Integration Guide

The complete adopter contract: every config option, the full public API, the
scope boundaries, and the sharp edges. The README is the pitch; this is the file
you point an integrating agent at. For the design rationale behind the refusals,
the repo-only PRD (`docs/01-product/litectx-memory-prd.md`) is the authority —
but everything you need to *use* litectx is here.

> **Status (important — read first).** litectx is in **active early build**. This
> document describes the contract **as actually shipped** (slices 0–11: incremental
> indexing, symbol chunking, kind-scoped recall, import edges + spreading, git
> grounding, the `impact` view incl. the slice-5b barrel/alias mitigation, the
> opt-in **embeddings** tier incl. written-kind **KNN union** (paraphrase recall),
> the **write path** — `remember`/`forget` for facts/episodes/direct docs —
> chunk-granular recall, `get(id)` body
> access, and the two consumption surfaces: the **CLI** and the stdio **MCP server**). Where the eventual surface (ACT-R base-level activation
> weighting, `getNode`/`related` accessors) is **not yet available**, it is marked
> **🚧 roadmap** — do not wire against it yet. What is documented without that mark works
> today and is covered by tests and the multi-repo benchmark.

---

## What this is

litectx is a local, searchable **memory across kinds** for AI agents, in one
**SQLite** file. Content enters two ways — **`index()`** reads a repository
(code + markdown) from disk, and **`remember()`** writes knowledge that isn't a
file (facts, episodes, runtime docs/FAQs). Over that one store it serves ranked
**recall** (search, kind-scoped) and **impact** (called-by/calling →
blast-radius + risk bucket). It is an `import`-able library that runs **in your
process** against a file on disk — no daemon, no service, no network, no
telemetry. The views read **one** graph built by a single `index()` pass —
`impact()` is computed on demand and never re-extracts, so a symbol you
surface with `recall()` is the same node `impact()` assesses (pinned by
`test/composing.test.js`). The graph is built to grow further (ACT-R-style
activation signals scored on the recall log) under that same one-graph contract.

**The entry path decides the available kinds:** files via `index()` →
`code`/`doc` (by extension — you cannot index a file *as* a fact; distilling a
doc into facts is your extraction, then `remember`). Direct writes via
`remember()` → `fact`/`episode`/`doc`. `doc` is the one kind both produce.
`index()` is **never mandatory** — a litectx used only as a fact/episode store
(no repo, no `index()` call) is a fully supported mode.

## What litectx is and is not

- **Is:** a lite, local-first, in-process memory over your code, docs, and written
  knowledge (facts/episodes), exposing ranked recall, a called-by/calling impact
  view, and a `remember`/`forget` write path. The graph is the substrate and is
  intended to be public API.
- **Is not:** a language server, a vector database, a hosted service, an agent
  framework, or a token-budget/guardrail layer. It has **no LSP tier — ever**
  (see *What's NOT in litectx*). Curation, thresholds, prompt assembly, and budget
  policy belong to the caller, not here.

## Status — what's shipped today

| Capability | State |
|---|---|
| Incremental, git-aware indexing into SQLite (code + md) | ✅ shipped |
| First-class `kind` / `format` per document | ✅ shipped |
| Ranked **recall** over FTS5 (BM25), file-granularity | ✅ shipped |
| Symbol-level `nodes` substrate (tree-sitter: TS/JS/Python + md sections) | ✅ shipped (slice 2) |
| **Kind-scoped recall** (code-over-md fix: kinds never share a ranking) + code-aware body | ✅ shipped (slice 3) |
| **Import edges** + 1-hop **spreading** recall (BM25 + additive boost, w=0.3) | ✅ shipped (slice 4) |
| **Git activity** metadata per hit (`git: { commits, lastCommit }`; grounding, not scored) | ✅ shipped (slice 4) |
| **impact** view (`impact(symbol)`: called-by/calling → risk bucket + complexity, on-demand) | ✅ shipped (slice 5a + 5b barrel/alias resolution) |
| `calls` edges (symbol blast radius) — computed on demand, not persisted (§7.1) | ✅ shipped (slice 5a; `type='call'` row stays reserved for a future persist optimization) |
| Anti-false-isolation for TS aliases / barrels (§7.2) | ✅ shipped (slice 5b — renamed barrel/path-alias re-exports resolved) |
| `getNode` / `related` graph accessors | 🚧 roadmap |
| **Embeddings** (semantic tier) | ✅ shipped (slice 6 — opt-in, off by default; `embeddings: true` + the optional peer dep) |
| **Write path** — `remember`/`forget` for `fact`/`episode`/direct `doc`; provenance (`by`); recall audit log; `reviewCandidates` HITL query | ✅ shipped (slice 7) |
| **Stemmed fact/episode recall** (porter — inflection-tolerant; doc/code stay keyword-exact by measurement) | ✅ shipped (slice 7b) |
| **Chunk-granular recall** (`hit.chunk` — the matching function/section inside the file) + `log: false` | ✅ shipped (slice 8) |
| **`get(id)` body access** — fetch any item's full text by id (written memory verbatim, files from disk) | ✅ shipped (slice 9) |
| **MCP server** (`litectx-mcp` bin — stdio, client-spawned, all public operations) + CLI write parity (`remember`/`forget`/`--embeddings`/`--no-log`) | ✅ shipped (slice 10) |
| **KNN union** — embeddings-tier paraphrase recall for `fact`/`episode` (cosine nominates, not just re-ranks) | ✅ shipped (slice 11 — bench: para 0.000→0.574, exact/morph held) |
| **`recentActivity()`** — "what was I working on": witnessed chunk-edits, recency-windowed, isolated from recall | ✅ shipped (slice 5a — access-log tier, view #3) |
| Base-level **activation** as a recall *re-rank* (edit→search score) | ⊘ dropped (POC-falsified repo-dependent — the edit signal lives in `recentActivity`, never in ranking) |
| Episode promotion ladder · per-chunk trust/stability tie-breaker | 🚧 roadmap (access-log tier 5b/5c) |

> `recall` ranks by **BM25 + 1-hop additive import-spreading**, kind-scoped (a hit imported by /
> importing a strong hit is lifted, never taxed). This is the v1 default and the robust ceiling for
> graph-only recall — validated ≥ baseline on four repos (aurora/gitdone/aurora-mixed/multis);
> pushing the weight higher overfits one repo and sinks another, so further recall gains come from
> the deferred semantic/access-log tiers, not more graph tuning. `calls` edges are NOT used for
> recall (they don't help; Step-0 POC) — they're reserved for the impact view. Base-level (git-seeded)
> activation was tested and **does not earn ranking weight without a real access log**
> (POC: repo-dependent) — so git activity ships as *grounding metadata*, not a score. (The future
> access-log tier boosts what you actually *retrieve and use* — an "access" — which is distinct
> from git *edits* and from merely *appearing* in results; the latter would be degenerate feedback.)

## Minimal usage

```js
import { LiteCtx } from "litectx";

const ctx = new LiteCtx({ root: "/path/to/repo" });
await ctx.index();                                    // incremental, git-aware
const hits = await ctx.recall("where do we validate the auth token?", { kind: "code" });
// hits: [{ path, kind, format, score, git }, ...]  (score: higher = more relevant; git: activity, not scored)

// memory that isn't a file (slice 7): facts / episodes / runtime docs
await ctx.remember("fact:auth-uses-jwt", "Auth is JWT, verified in middleware.", { kind: "fact", by: "human" });
const facts = await ctx.recall("jwt auth", { kind: "fact" });
ctx.get("fact:auth-uses-jwt")?.text;                  // the body itself (recall returns ranked pointers)
ctx.forget("fact:auth-uses-jwt");                     // by key; or forget({ by: "agent" }) in bulk
ctx.close();
```

`index()`, `recall()`, and `remember()` are **async** (`index` parses with a WASM grammar
runtime; `recall`/`remember` embed when the tier is on). `get()`, `forget()`,
`reviewCandidates()`, `size()`, and `close()` are synchronous.

## All options — `LiteCtxConfig`

Passed to `new LiteCtx(config)`. Only `root` is required.

| Option | Type | Default | What it does |
|---|---|---|---|
| `root` | `string` | — (required) | Repository root to index. Throws if omitted. |
| `include` | `string[]` | `[".ts", ".js", ".mjs", ".cjs", ".py", ".md"]` | File extensions to index. Routing is by **extension only** — content is never sniffed. |
| `pathspecs` | `string[]` | unset | Optional git pathspecs to scope the index, e.g. `["app/**/*.js"]`. Applied via `git ls-files`. |
| `dbPath` | `string` | `<root>/.litectx/index.db` | SQLite file path. Use `":memory:"` for an ephemeral in-process index (the parent dir is created for file paths). |
| `embeddings` | `boolean` | `false` | Enable the opt-in **semantic tier**: `index()` embeds each file, `remember()` embeds the text, `recall()` fuses cosine into the ranking — and for `fact`/`episode` also *nominates* the nearest stored vectors into the pool (KNN union: paraphrase recall). Requires the optional peer dep `@xenova/transformers` (`npm i @xenova/transformers`). Off → the deterministic BM25 + spreading core, no model loaded. |
| `embedWeight` | `number` | `1.0` | Semantic fusion weight (higher = more semantic). POC-tuned default; held-out-validated, no overfitting cliff. |
| `embedModel` | `string` | `Xenova/all-MiniLM-L6-v2` | transformers.js model id for the tier. |
| `embedder` | `{ embed(text): Promise<Float32Array> }` | built-in | Advanced/testing — inject a custom embedding provider, bypassing the built-in model loading. |

There is **one** config object and no global state. No environment variables, no
config files — the adopter passes everything in.

## Public API

### `new LiteCtx(config)` → `LiteCtx`
Constructs an instance and opens (or creates) the SQLite store. Creates the
`dbPath` parent directory unless `dbPath === ":memory:"`.

### `await ctx.index(opts?)` → `Promise<IndexResult>`
Builds or **incrementally refreshes** the index over `root`.

- `opts.force?: boolean` — full rebuild (drop + reindex everything).
- `opts.paths?: string[]` — git pathspecs scoping this pass. A scoped pass
  **never deletes** files outside its scope.
- Default (no opts): re-reads only files whose content changed (fast skip on
  `(mtime, size)`, `content_hash` as the arbiter) and drops files that disappeared.

`IndexResult`:
```ts
{ files: number,      // total documents after the pass
  added: number,      // newly indexed
  updated: number,    // re-indexed (content changed)
  removed: number,    // dropped (no longer present)
  unchanged: number } // skipped (mtime/size or content unchanged)
```

### `await ctx.recall(query, opts?)` → `Promise<Hit[] | Record<kind, Hit[]>>`
Ranked recall over the index, **scoped by memory `kind`**. **Async** (since slice 6 — the
embeddings tier embeds the query at call time; with embeddings off the work is synchronous,
just wrapped in a resolved promise, no model touched). `await` it.

**Kinds never share a ranking.** Each kind is FTS-gated and ranked only against its own
kind, in a separate query — so prose volume can never bury code (no weights, no md
penalty). Within a kind, ranking is **BM25 + 1-hop additive import-spreading** (a hit
adjacent to a strong hit in the import graph is lifted; spreading never crosses kinds and
is a no-op for kinds without edges, e.g. `doc`). With the **embeddings tier on**, a wider
BM25-gated pool is additionally re-ranked by semantic cosine (`norm(dual) + embedWeight·norm(cosine)`)
— the gate bounds the cosine work to the candidate pool, never the corpus. For the **written
kinds** (`fact`/`episode`) the tier goes one step further (slice 11): up to 8 stored vectors
nearest the query are **unioned into the pool as nominees**, so a paraphrase sharing *no* words
with a fact can still reach it — nominees enter at the pool's score floor and rank on cosine
alone, so lexical hits keep their head start. `code`/`doc` stay strictly gate-then-rerank. The
return shape follows the `kind` argument:

| call | mode | returns | default `n` |
|---|---|---|---|
| `recall(q, { kind: "code" })` | single kind | flat `Hit[]` | `10` |
| `recall(q, { kind: ["code","fact"] })` | multiple | grouped `{ code:[…], fact:[…] }` | `5` each |
| `recall(q)` | omitted → all `KINDS` | grouped `{ code:[…], doc:[…], fact:[…], episode:[…] }` | `5` each |

- `opts.kind?: string | string[]` — one kind (flat list) or several (grouped). Omitted →
  grouped over **all four** known kinds (the safe CLI/agent default; never a flattened
  ranking). A kind with no content returns an empty array — honest, not an error.
- `opts.n?: number` — max hits **per kind**; raise to dig deeper. No hard cap, no
  pagination (a larger `n` is a larger context — your budget to manage).
- No usable query terms → `[]` (single kind) or all-empty groups.
- `opts.log?: boolean` (default `true`) — set `false` to skip the recall audit log. The log
  is a **demand signal**: queries from dashboards, CI checks, batch tooling, or a read-only
  db open aren't real demand and shouldn't pollute it.
- **Side effect (unless `log: false`):** every hit returned is appended to the **recall
  audit log** (slice 7) — the trail behind `reviewCandidates` and the future access-log
  activation tier. Each row records the hit's chunk symbol, so the future edit-bind can
  join "recalled" and "edited" at the same grain. Ranking is unaffected.

`Hit`:
```ts
{ path: string,    // repo-relative file path — or, for written memory, the caller's `id` key
  kind: string,    // "code" | "doc" | "fact" | "episode"
  format: string,  // "ts" | "js" | "py" | "md" | "text" | ...
  score: number,   // higher = more relevant (BM25 + additive import-spreading)
  git: { commits: number, lastCommit: number|null } | null,  // activity metadata; null = no history
  chunk: { symbol: string|null, nodeType: string,            // the best-matching chunk INSIDE the
           startLine: number, endLine: number } | null }     // hit — a function pointer, not just a file
```
> `git` is **grounding, not scored** — file-level commit count + last-commit unix-time (seconds),
> from one `git log` pass at index time. It never affects ranking; `null` means no commit history
> (a non-git tree, or a tracked-but-uncommitted file).
> `chunk` is **chunk-granular recall**: the function / method / md-section inside the file that
> best carries your query terms (0-based inclusive lines). It **localizes, never reorders** —
> ranking stays file-level and bench-identical. The most *specific* match wins: a class that
> merely contains the matching method never shadows it, and an anonymous arrow is labeled with
> its nearest named container. `null` when nothing localizes: written memory has no chunks
> (the row IS the unit), and a match carried only by the filename names none.
> 🚧 The richer roadmap shape (`{ id, signals: { bm25, activation, ... } }`)
> is not shipped yet. Today a hit is the six fields above.

### `ctx.get(id, opts?)` → `Item | null`
**Body access** (slice 9) — the read counterpart to `recall`: recall returns ranked
*pointers* (paths/ids), `get` returns the *thing itself*. Synchronous (no embedder
involved). Any id works:

- a **written-memory id** (`"fact:auth-uses-jwt"`) → the text **verbatim as remembered**
  (the FTS body is a processed searchable surface, never the deliverable);
- an **indexed file's repo-relative path** (`"src/auth.js"`) → the file **read fresh from
  disk** — the index stores the searchable surface, not a copy of your files, so you always
  see the current content (`text: null` only when the file has vanished since the last
  `index()`; the next pass sweeps the row).

```ts
Item = {
  id: string,                        // the written id, or the repo-relative path
  kind: string,                      // "code" | "doc" | "fact" | "episode"
  format: string,                    // "ts" | "js" | "py" | "md" | "text" | ...
  source: "file" | "direct",         // indexed from disk vs written via remember()
  provenance: "human"|"agent"|null,  // written memory only; null for files
  occurredAt: number | null,         // episode timestamp (epoch ms)
  text: string | null,               // the full body
}
```

Unknown id → `null`. On the (pathological) collision of a written id with a real file
path, the written row wins — namespace your ids (`"fact:…"`) and it never comes up.

- `opts.log?: boolean` (default `true`) — each `get` appends an `action: 'fetch'` row to
  the audit log. A fetch is a **tagged weak signal, not demand**: you fetch what recall
  just returned, so counting fetches as demand would double-count every retrieval (the
  fetch-toll). `recallCount`/`reviewCandidates` read `action: 'recall'` rows only; nothing
  scores the fetch tag yet (it earns weight, if any, at the action-signal bench). Set
  `log: false` for non-demand consumers, same as `recall`.

### `await ctx.impact(symbol)` → `Promise<Impact | null>`
The **impact** view (§7): *if I change this symbol, what's the blast radius and how risky?*
**Computed on demand, not persisted** — callees by a tree-sitter walk of the symbol's body,
callers by an `rg -w` sweep confirmed with tree-sitter. No LSP, ever. Returns `null` when the
symbol isn't defined in the index (impact answers for *your* symbols). Async (it shells `rg`).

```ts
Impact = {
  symbol: string,
  defs: { path: string, startLine: number, endLine: number }[],  // every definition (over-count: all)
  refCount: number,     // max(confirmed, mentions) — the over-count-safe blast radius
  confirmed: number,    // tree-sitter-confirmed external call sites
  mentions: number,     // external `rg -w` word occurrences (the safety floor)
  risk: "low" | "medium" | "high",   // bucket on refCount: ≤2 / 3–10 / 11+
  complexity: number,   // cyclomatic-ish decision-point count (max over defs)
  callers: { path: string, line: number, symbol: string | null, alias?: string }[],  // confirmed call sites (incl. bare `@decorator` applications; `alias` set when reached via a renamed barrel re-export)
  callees: string[],    // intra-repo names this symbol calls (externals dropped)
  hedges: string[],     // §7.2 safety caveats — see below
}
```

**The safety model (§7.2) is the whole point.** Over-count is safe (over-cautious); under-count is
dangerous (a false "isolated → safe" breaks hidden consumers). So:
- `refCount` is `max(confirmed, mentions)` — the **looser** signal wins, never the smaller one.
  Resolution is by **name only** (no receiver typing — that's the LSP we don't have), so a common
  method name reads as higher-risk. That is intended: cautious, not precise (calibration borrowed
  from aurora's `lsp_tool`, thresholds ≤2/3–10/11+).
- **"isolated / low-risk" is never silent.** When `refCount` is 0 or all mentions are unconfirmed,
  `hedges` explains why — an unconfirmed mention is *counted, not dropped* ("unresolved ≠ absent"),
  and an exported/public name is flagged for invisible external consumers. A clean isolation verdict
  is never returned; it's always a hedged *review candidate*.
- **Renamed barrel / path-alias re-exports are resolved** (slice 5b). A symbol reached only as a
  renamed re-export — `export { default as Panel } from "./impl"`, imported via a tsconfig `paths`
  alias and called as `Panel()` — is invisible to a name-only sweep; `impact()` follows the barrel
  and tsconfig `paths` to find the real callers (tagged with `caller.alias`) and a hedge naming the
  alias, so it no longer reads as a false isolation. Single-hop barrels and JS/TS only — multi-hop
  barrel chains and Python `from x import y as z` re-export barrels are not yet followed.

### `await ctx.remember(id, text, opts?)` → `Promise<void>`
Write one **directly-authored memory** — knowledge that isn't a file (slice 7). The write
counterpart to `index()`. **Upsert by `id`**: writing the same id again replaces the
content. The `id` is your handle for update/forget — namespace it (`"fact:auth-uses-jwt"`,
`"faq:refunds"`, `"ep:2026-06-09-deploy"`); it appears as the hit's `path` in recall.

- `opts.kind?: "fact" | "episode" | "doc"` — default `"fact"`.
  - **`fact`** — a durable, decontextualized assertion ("we use JWT"). No timestamp.
  - **`episode`** — a time-stamped event ("deploy rolled back on …"). `occurredAt` applies.
  - **`doc`** — a prose passage handed to you at runtime (an FAQ/KB entry with no file).
  - `code` is rejected — code enters via `index()` only.
- `opts.by?: "human" | "agent"` — **provenance** (who asserted it), default `"agent"`.
  The trust axis: human-asserted is durable/high-trust; agent-asserted is tentative until
  promoted (see `reviewCandidates`). Stored now; trust-*weighted ranking* is 🚧 roadmap.
- `opts.occurredAt?: number` — episode timestamp, epoch **ms**; defaults to write-time.
  Ignored for facts/docs (a durable assertion has no constitutive "when").
- `opts.format?: string` — defaults to `"md"` for docs, `"text"` otherwise. Metadata only
  for direct writes (nothing is chunked or parsed).

Content is stored **whole** — one searchable unit, no tree-sitter/section chunking. You
control granularity by how you split before writing (ten atomic facts beat one blob).
With the embeddings tier on, `remember` embeds the text at write time (hence async).

Written memory **coexists with the index in one store and survives every `index()`
pass** — structurally: `index()` reconciles deletions only against files it has itself
indexed, and written rows are never in that set. This includes `index({ force: true })`:
a force pass clears and re-reads **file-sourced data only** — written memory, its raw
text/embeddings, and the audit log are never touched (nothing about them is re-derivable
from disk).

### `ctx.forget(idOrQuery)` → `number`
Delete directly-written memory. Returns the number of rows removed.

- `forget("fact:auth-uses-jwt")` — drop one item by key.
- `forget({ kind: "fact", by: "agent" })` — **bulk invalidation** by query: every
  agent-asserted fact. At least one of `kind` / `by` is required (`forget({})` throws).

**`forget` can never touch indexed files** — it operates only on written
(`remember`-created) rows. To remove an indexed file from the store, delete the file and
re-`index()`.

### `ctx.reviewCandidates(threshold = 5)` → `{ path, hits }[]`
The **human-in-the-loop promotion query** (review earned by use): agent-asserted facts
whose recall-hit count has crossed `threshold`, most-recalled first. The intended loop is
**yours, not litectx's**: show each candidate to a human, who either **validates** it —
`remember(id, text, { by: "human" })`, flipping provenance to durable/high-trust — or
**invalidates** it — `forget(id)`. Acting on a candidate removes it from the set (no
"reviewed" flag exists or is needed). The hit count gates *review*, never *ranking* —
frequently-recalled facts do not rank higher (that would be a feedback loop; ranking
weight is the 🚧 access-log tier, validated separately).

### `ctx.recentActivity(opts?)` → `{ id, symbol, kind, lastEditedAt, edits }[]`
**"What was I working on"** — the code/doc chunks litectx most recently *witnessed* being
edited, newest first, within a recency window. `opts`: `days` (lookback, default 7),
`since` (epoch-ms window floor, overrides `days`), `limit` (default 20). Each row is a chunk:
`id` is its file path (feed it to `get`), `symbol` localizes within the file (`null` for a
file's anonymous chunks, which collapse to a single per-file row), `lastEditedAt` is the most
recent observed edit (epoch ms), and `edits` is how many index passes (sessions) changed it
in the window.

The edit stream is built **at index time**: each incremental `index()` diffs every new chunk
body against the stored `nodes` and logs the new/modified ones. A **cold first build or
`force` rebuild records nothing** (mass-loading isn't editing), so this stays empty until real
edits are observed — it reflects what litectx watched, not history before it was watching.

This is a **deliberately isolated read**: it never touches recall ranking. The witnessed-edit
signal's home is here (next-use / "where was I"), *not* in search scores — folding edit
activation into recall was POC-falsified as repo-dependent (it floats the same hot chunks for
every query), so the edit→recall re-rank ships at zero. `recentActivity` also writes nothing
to the recall audit log — it is not a demand signal.

### `ctx.size()` → `number`
Indexed document count (file-granularity).

### `ctx.close()` → `void`
Closes the SQLite connection. Call it when done (especially for file-backed DBs).

### Named exports (advanced / extension)
- `KINDS: string[]` — the canonical memory-kind vocabulary a bare `recall(query)` groups
  over: `["code", "doc", "fact", "episode"]`. `code`/`doc` enter via `index()` (files,
  routed by extension); `fact`/`episode`/`doc` via `remember()` (direct writes).
- `Store` — the SQLite/FTS5 store class (used internally by `LiteCtx`; exposed for
  tooling and tests). Notable read methods: `count()`, `nodeCount()`,
  `nodesForPath(path)` → `{ symbol, node_type, start_line, end_line }[]`.
- `splitIdent(s)` / `keywords(query)` / `ftsMatch(query)` — the code-aware
  tokenizer primitives (identifier splitting, keyword extraction, FTS5 MATCH
  building). Useful if you build queries by hand.

> `ctx.store` is reachable but is **not a stability promise** pre-1.0 — the
> `nodes` schema is the substrate for in-progress slices and may change. Treat
> `index` / `recall` / `size` / `close` as the stable surface.

## Consumption surfaces — CLI & MCP (slice 10)

The library is the core; two **thin adapters** ship in the same package, both wrapping the
public API above exactly as an external consumer would (nothing in the library knows they
exist — importing `litectx` as a lib loads zero surface code). Use whichever fits the caller;
mixing them over one `.litectx/index.db` is fine.

### `litectx` (CLI)

```
litectx index [root] [--force] [--embeddings]
litectx recall <query...> [--kind code|doc|fact|episode] [-n <n>] [--embeddings] [--no-log]
litectx get <id> [--no-log]                    # metadata → stderr, body → stdout (pipes clean)
litectx recent [--since <days>] [-n <n>]       # "what was I working on" — recent chunk-edits
litectx impact <symbol>
litectx remember <id> [text...] [--kind fact|episode|doc] [--by human|agent] [--embeddings]
litectx forget <id>            # or bulk: litectx forget --kind <k> / --by <b>
```
All commands take `--root <dir>` (default: cwd). `remember` reads its body from the arguments
or, when absent, from piped stdin (`git log -1 --format=%s | litectx remember ep:release
--kind episode`). Exit 1: unknown id (`get`), nothing matched (`forget`), unknown symbol
(`impact`). `--no-log` is the demand-signal opt-out (see Gotchas) — use it for dashboards,
CI, and batch scripts.

### `litectx-mcp` (MCP server)

A hand-rolled **stdio** MCP server — newline-delimited JSON-RPC 2.0, spawned and owned by the
MCP client, **not a daemon** (exits when the client hangs up; the no-service rule holds). Zero
dependencies beyond litectx itself. Client config:

```json
{ "mcpServers": { "litectx": { "command": "litectx-mcp", "args": ["--root", "/path/to/repo"] } } }
```

`--embeddings` opts the spawned instance into the semantic tier. The tools are the public
operations: `index`, `recall`, `impact`, `get`, `recent`, `remember`, `forget` — recall returns
scored *pointers*, `get` fetches a body, `recent` lists witnessed chunk-edits, same contract as
the lib. Tool failures come back
in-band (`isError` results an agent can read and self-correct); protocol errors are reserved
for malformed JSON-RPC. **No `log: false` is exposed over MCP** — an MCP client is a live
agent, which is precisely the demand the audit log exists to capture; non-demand consumers
belong on the lib or the CLI's `--no-log`.

**The surfaces expose the core options, not every lib option — deliberately.** Lib-only
(use `import { LiteCtx }` if you need them): pathspec-scoped indexing (`index({ paths })`),
multi-kind recall arrays (`kind: ["code", "doc"]`), `remember`'s `format` override and
`occurredAt` backdating (a surface writes an episode as happening *now* — backdating is an
ingestion concern), and the embeddings fusion knobs (`embedWeight`, `embedModel`,
`embedder`). Both surfaces stay thin adapters; anything beyond their flags/arguments is the
library's job, not a surface re-export.

## The `nodes` substrate (slice 2)

Indexing now also splits each file into **symbol/section chunks** with line
ranges, stored in a `nodes` table:

- **Code** (TS, JS, Python) → one chunk per function / method / class, plus a
  "preamble" chunk for top-level lines (imports, module constants/docstring).
  Parsing uses **tree-sitter** (vendored WebAssembly grammars). Over-counting
  (e.g. nested arrows) is acceptable by design — the eventual output is a risk
  *bucket*, not a precise reference list.
- **Markdown** → one chunk per heading section.
- **Anything else / parse failure** → a single file-level chunk (never throws).

These chunks are **additive**: recall still gates on the file-level FTS index, so
adding them does not change ranking yet. They exist to feed block-level git
signals, graph edges, and the impact view in later slices.

## Architecture

One SQLite file holds two FTS5 tables — `docs` (code + all docs, keyword-exact;
indexed files and direct-written docs share it, discriminated by a `source`
column) and `mem` (facts + episodes, porter-stemmed) — plus a `file_index` table
for incremental change detection, a `nodes` table for the symbol substrate,
`edges` (imports → spreading; impact), `git_sig` (activity metadata),
`file_embeddings` (the opt-in tier), and `recall_log` (the slice-7 audit/access
log). A `kind` routes to exactly one FTS table, and kinds never share a ranking,
so BM25 scores never merge across the two. Indexing is **routed by file
extension** (never by content) and
prefers `git ls-files` (tracked files, respects `.gitignore`), falling back to a
filesystem walk that skips the usual noise directories. The whole thing runs
synchronously against the file except parsing, which uses an async WASM runtime.

## What's NOT in litectx, and why

- **No LSP / language server — ever.** Edge resolution is `ripgrep -w` + tree-sitter
  queries only; accuracy comes from per-language config. litectx is near-perfect at
  *detecting* call/import syntax and deliberately *imprecise at resolving bindings* —
  it **over-counts by design** (PRD §7). **Where the imprecision is risk-free vs. where
  the safety contract bites:** in **recall** (shipped — import-spreading), an edge only
  nudges a rank, so over- *or* under-counting is harmless; recall makes no isolation
  claim and carries none of the risk. The contract applies to the **impact** view
  (roadmap), where "isolated → safe to change" *is* load-bearing: **over-counting
  connectivity is safe (errs cautious); under-counting is dangerous** (a false
  "isolated" breaks hidden consumers). So when impact lands, a high/connected result is
  a normal claim, but **"isolated / unused / low-risk" is only ever a hedged review
  candidate, never a guarantee** — and dead-code is "likely-unused, review," never
  "safe to delete." Precise import-vs-usage binding is a non-goal. Closed decision.
- **No embeddings by default.** The semantic tier ships (slice 6) but is the single
  **opt-in**, off by default: dual-hybrid (BM25 + spreading) ≈ 85% vs tri-hybrid ≈ 95%,
  and embeddings add cold-start model-load latency + an ML dependency not worth
  defaulting on. Turn it on with `embeddings: true` + `npm i @xenova/transformers`.
- **No service / daemon / network / telemetry.** It runs in your process against a
  file on disk.
- **No alternative store.** SQLite + FTS5, single file. BM25 is native in SQL;
  vectors (embeddings tier) would live in the same file. Closed question.
- **No token-budget / guardrail / prompt-assembly concerns.** That is the
  caller's (harness) layer. litectx returns ranked results; what you do with them
  is policy.
- **No extraction LLM, no trust funnel, no consolidation.** `remember()` stores what you
  hand it — litectx never runs a model to distill docs into facts, decide what's worth
  remembering, merge near-duplicates, or run the human-review loop. It supplies the
  *mechanism* (write, recall, the `reviewCandidates` trigger, promote/forget actions);
  *what* becomes a fact and *which* facts get promoted is consumer policy. litectx is the
  low-write-bar retrieval store (write freely; only relevant items surface) — curating a
  high-bar "hot" always-injected memory on top of it is your layer.
- **No content sniffing.** Language is decided by extension only.

## Gotchas

- **`index()` and `recall()` are async; `size()`/`close()` are sync.** `await` index and
  recall; don't `await` size/close.
- **Recall is BM25 + spreading** (kind-scoped), plus **semantic cosine** when the embeddings
  tier is on. **recency** effects (base-level activation) remain the access-log tier and
  won't appear from git history alone — the POC showed git-seeded recency is repo-dependent,
  so git ships as grounding metadata, not ranking weight.
- **Same-mtime + same-size content swap.** Change detection fast-skips on
  `(mtime, size)`; an edit that lands within one filesystem mtime tick *and* keeps
  the exact byte length can be missed. Use `index({ force: true })` to be certain.
- **Scoped passes don't delete.** `index({ paths })` never removes files outside
  the given pathspecs — by design. A full `index()` reconciles deletions.
- **`git ls-files` is preferred.** In a git repo, only tracked files are indexed
  (untracked files need `git add` or a non-git fallback). Outside a git repo, a
  filesystem walk is used instead.
- **`.tsx` / `.jsx` are best-effort.** v1 grammars are TS, JS, Python; JSX-heavy
  files may fall back to a file-level chunk. They are not in the default `include`.
- **`recall()` and `get()` write — unless you opt out.** Since slice 7, every recall appends
  its hits to the `recall_log` audit table, and since slice 9 every `get` appends a fetch row
  (tagged `action: 'fetch'`, kept apart from recall's demand signal) — so by default both need
  a writable db, and the log grows with use (append-only; small rows, but unbounded — pruning
  policy is yours until the access-log tier defines one). Pass `{ log: false }` for read-only
  opens and for any consumer whose queries aren't real demand (dashboards, CI, batch tooling)
  — the log is a demand signal, and non-demand traffic pollutes it.
- **`get()` on a file reads disk, not the index.** The store keeps a processed *searchable
  surface*, not a copy of your files — so `get("src/auth.js").text` is the file as it is
  *now*, even if it changed since the last `index()` (and `null` if it was deleted; the
  next `index()` sweeps the row). Written memory (`fact`/`episode`/direct `doc`) is the
  exception: it has no file behind it, so its raw text is stored and returned verbatim.
- **Facts/episodes recall across word forms; docs and code stay keyword-exact — deliberately.**
  `fact`/`episode` recall is porter-stemmed: *"refund policy"* finds a fact stored as
  *"refunds are honored…"* (inflection — plurals, -ed/-ing — is covered; derivational shifts
  like "deployment"→"deploys" and compounds like "rollback"→"rolled back" are not). `doc` and
  `code` are **not** stemmed: in code, word-forms are distinct symbols (`token`/`tokens`/
  `tokenize`), and stemming measurably hurt code ranking — so an FAQ written via `remember`
  still needs exact words (or key terms repeated in its `id`, which is indexed). Pure
  paraphrase ("money back" → "refunds") matches nothing lexically for any kind. **With the
  embeddings tier on, `fact`/`episode` close that hole (slice 11 — KNN union):** cosine
  *nominates* up to 8 stored vectors nearest the query into the pool, so "money back" reaches
  the refunds fact with zero shared words (bench: para MRR 0.000 → 0.574, top-3 83%, with exact
  and morph held). Two honest limits: it needs the tier **on at write time** (a fact written with
  the tier off has no vector and never nominates — re-`remember` it to embed it), and an
  off-topic query may still surface weakly-similar facts ranked low (only zero/negative
  similarity is never nominated). `doc`/`code` remain strictly BM25-gated — there the tier only
  re-ranks the lexical pool, so with the tier **off** (the default), *write facts in the words
  you'll query* is still the rule.
- **`forget` only forgets written memory.** It cannot remove an indexed file (delete the
  file + re-`index()` for that), and `remember` cannot overwrite an indexed file's row —
  the two populations share the store but are write-isolated by design.
- **Upgrading over an old index db is safe — the store self-heals on open.** A db created
  by ≤ 0.1.0 (its `docs` table predates the write-path columns) is detected and rebuilt on
  the next open — it can only contain re-indexable files, never written memory, so nothing
  is lost; run `index()` once to repopulate. Newer column-additive deltas are applied with
  `ALTER`, preserving data. You never need to delete `.litectx/` by hand.
- **`close()` matters for file DBs.** The store uses WAL; close to flush cleanly.
- **`impact()` requires `ripgrep` (`rg`) on `PATH`.** The caller sweep shells out to
  `rg -w`; it is **not** bundled. If `rg` is missing the sweep returns nothing and
  `impact()` reports **0 callers** — i.e. a symbol can read as isolated purely because
  the tool is absent (a §7.2 false-isolation, the one dangerous error). Install
  ripgrep on any host (CI, container, dev box) that calls `impact()`. `recall()` and
  `index()` do **not** need it.

## Constraints

- **Runtime:** Node **≥ 18**, ESM only (`"type": "module"`). **`ripgrep` (`rg`) on
  `PATH`** is required for `impact()` (not for `recall`/`index`) — see Gotchas.
- **Dependencies (shipped):** `better-sqlite3` (native SQLite) and
  `web-tree-sitter` (WASM parser runtime, pinned). The 3 grammars (Python, JS, TS)
  are **vendored** in the package (~3.4 MB unpacked) — no extra grammar download.
- **Indexed languages (v1):** TS, JS, Python (code) + Markdown (docs). Adding a
  language is tree-sitter queries + edge config, not a core change.
- **One index = one SQLite file.** Rebuildable from source at any time.
