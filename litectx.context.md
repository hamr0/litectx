# litectx — Integration Guide

The complete adopter contract: every config option, the full public API, the
scope boundaries, and the sharp edges. The README is the pitch; this is the file
you point an integrating agent at. For the design rationale behind the refusals,
the repo-only PRD (`docs/01-product/litectx-memory-prd.md`) is the authority —
but everything you need to *use* litectx is here.

> **Status (important — read first).** litectx is in **active early build**. This
> document describes the contract **as actually shipped** (slices 0–5: incremental
> indexing, symbol chunking, kind-scoped recall, import edges + spreading, git
> grounding, and the `impact` view incl. the slice-5b barrel/alias mitigation). Where
> the eventual surface (ACT-R activation weighting, `getNode`/`related` accessors,
> embeddings) is **not yet available**, it is marked **🚧 roadmap** — do not wire
> against it yet. What is documented without that mark works today and is covered by tests
> and the multi-repo benchmark.

---

## What this is

litectx indexes a repository (code + markdown) into a single local **SQLite**
file and serves two views over it: ranked **recall** (search) and **impact**
(called-by/calling → blast-radius + risk bucket). It is a `import`-able library
that runs **in your process** against a file on disk — no daemon, no service, no
network, no telemetry. Both views read **one** graph built by a single `index()`
pass — `impact()` is computed on demand and never re-extracts, so a symbol you
surface with `recall()` is the same node `impact()` assesses (pinned by
`test/composing.test.js`). The graph is built to grow further (ACT-R-style
activation signals, an embeddings tier) under that same one-graph contract.

## What litectx is and is not

- **Is:** a lite, local-first, in-process index over your code and docs, exposing
  ranked recall and a called-by/calling impact view. The graph is the
  substrate and is intended to be public API.
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
| Embeddings (semantic tier) | 🚧 roadmap (opt-in, off by default) |
| Base-level **activation** (recency/frequency decay) | 🚧 roadmap (access-log tier, long-running memory) |

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
const hits = ctx.recall("where do we validate the auth token?", { kind: "code" });
// hits: [{ path, kind, format, score, git }, ...]  (score: higher = more relevant; git: activity, not scored)
ctx.close();
```

`index()` is **async** (it parses files with a WebAssembly grammar runtime).
`recall()`, `size()`, and `close()` are synchronous.

## All options — `LiteCtxConfig`

Passed to `new LiteCtx(config)`. Only `root` is required.

| Option | Type | Default | What it does |
|---|---|---|---|
| `root` | `string` | — (required) | Repository root to index. Throws if omitted. |
| `include` | `string[]` | `[".ts", ".js", ".mjs", ".cjs", ".py", ".md"]` | File extensions to index. Routing is by **extension only** — content is never sniffed. |
| `pathspecs` | `string[]` | unset | Optional git pathspecs to scope the index, e.g. `["app/**/*.js"]`. Applied via `git ls-files`. |
| `dbPath` | `string` | `<root>/.litectx/index.db` | SQLite file path. Use `":memory:"` for an ephemeral in-process index (the parent dir is created for file paths). |

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

### `ctx.recall(query, opts?)` → `Hit[]` | `Record<kind, Hit[]>`
Ranked recall over the index, **scoped by memory `kind`**. Synchronous.

**Kinds never share a ranking.** Each kind is FTS-gated and ranked only against its own
kind, in a separate query — so prose volume can never bury code (no weights, no md
penalty). Within a kind, ranking is **BM25 + 1-hop additive import-spreading** (a hit
adjacent to a strong hit in the import graph is lifted; spreading never crosses kinds and
is a no-op for kinds without edges, e.g. `doc`). The return shape follows the `kind` argument:

| call | mode | returns | default `n` |
|---|---|---|---|
| `recall(q, { kind: "code" })` | single kind | flat `Hit[]` | `10` |
| `recall(q, { kind: ["code","doc"] })` | multiple | grouped `{ code:[…], doc:[…] }` | `5` each |
| `recall(q)` | omitted → all `KINDS` | grouped `{ code:[…], doc:[…] }` | `5` each |

- `opts.kind?: string | string[]` — one kind (flat list) or several (grouped). Omitted →
  grouped over all known kinds (the safe CLI/agent default; never a flattened ranking).
- `opts.n?: number` — max hits **per kind**; raise to dig deeper. No hard cap, no
  pagination (a larger `n` is a larger context — your budget to manage).
- No usable query terms → `[]` (single kind) or empty groups `{ code:[], doc:[] }`.

`Hit`:
```ts
{ path: string,    // repo-relative file path
  kind: string,    // "code" | "doc"
  format: string,  // "ts" | "js" | "py" | "md" | ...
  score: number,   // higher = more relevant (BM25 + additive import-spreading)
  git: { commits: number, lastCommit: number|null } | null }  // activity metadata; null = no history
```
> `git` is **grounding, not scored** — file-level commit count + last-commit unix-time (seconds),
> from one `git log` pass at index time. It never affects ranking; `null` means no commit history
> (a non-git tree, or a tracked-but-uncommitted file).
> 🚧 The richer roadmap shape (`{ id, lines, signals: { bm25, activation, ... } }`)
> is not shipped yet. Today a hit is the five fields above.

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

### `ctx.size()` → `number`
Indexed document count (file-granularity).

### `ctx.close()` → `void`
Closes the SQLite connection. Call it when done (especially for file-backed DBs).

### Named exports (advanced / extension)
- `KINDS: string[]` — the canonical memory-kind vocabulary a bare `recall(query)` groups
  over (`["code", "doc"]` in v1; grows as `fact` / `episode` extractors land).
- `Store` — the SQLite/FTS5 store class (used internally by `LiteCtx`; exposed for
  tooling and tests). Notable read methods: `count()`, `nodeCount()`,
  `nodesForPath(path)` → `{ symbol, node_type, start_line, end_line }[]`.
- `splitIdent(s)` / `keywords(query)` / `ftsMatch(query)` — the code-aware
  tokenizer primitives (identifier splitting, keyword extraction, FTS5 MATCH
  building). Useful if you build queries by hand.

> `ctx.store` is reachable but is **not a stability promise** pre-1.0 — the
> `nodes` schema is the substrate for in-progress slices and may change. Treat
> `index` / `recall` / `size` / `close` as the stable surface.

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

One SQLite file holds an FTS5 table (`docs`, file-granularity, BM25) for recall, a
`file_index` table for incremental change detection, and a `nodes` table for the
symbol substrate. Indexing is **routed by file extension** (never by content) and
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
- **No embeddings by default.** The semantic tier is the single opt-in (roadmap,
  off by default): dual-hybrid (BM25 + spreading) ≈ 85% vs tri-hybrid ≈ 95%, and
  embeddings add cold-start latency + an ML dependency not worth defaulting on.
- **No service / daemon / network / telemetry.** It runs in your process against a
  file on disk.
- **No alternative store.** SQLite + FTS5, single file. BM25 is native in SQL;
  vectors (embeddings tier) would live in the same file. Closed question.
- **No token-budget / guardrail / prompt-assembly concerns.** That is the
  caller's (harness) layer. litectx returns ranked results; what you do with them
  is policy.
- **No content sniffing.** Language is decided by extension only.

## Gotchas

- **`index()` is async; `recall()` is sync.** `await` the index; do not `await`
  recall/size/close.
- **Recall is BM25-only today** (kind-scoped). **Centrality** effects arrive with the
  spreading slice (graph edges); **recency** effects (base-level activation) are the
  access-log tier and won't appear from git history alone — the POC showed git-seeded
  recency is repo-dependent, so git ships as grounding metadata, not ranking weight.
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
