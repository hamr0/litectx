---
type: reference
title: litectx Public API
status: stable
sources: [docs/archive/litectx-prd.md]
---

litectx exposes **one importable surface** (`LiteCtx`) and **one config object**. There is no
config file, no env-var layer, and no LSP — the operator sets constructor args (mirrored as CLI
flags / MCP tool args), and all advanced behavior is opt-in (litectx-prd.md:169-171,208-211).

## Constructing and indexing

```js
import { LiteCtx } from "litectx";

const lc = new LiteCtx({ root: "/path/to/repo" /*, ...LiteCtxConfig */ });

await lc.index();                       // incremental, git-aware
await lc.index({ paths: ["src/"] });    // scoped
```
(litectx-prd.md:173-179)

### `LiteCtxConfig`

One object, all fields optional except `root`. No `.litectxrc`, no env vars — this is the whole
surface (litectx-prd.md:208-212):

| field | default | knob |
|---|---|---|
| `root` | *(required)* | repo root to index |
| `include` | `.ts .js .mjs .cjs .py .md` | which file extensions to index |
| `pathspecs` | — | git pathspecs to scope the index |
| `dbPath` | `<root>/.litectx/index.db` | the single SQLite file (`:memory:` = ephemeral) |
| `embeddings` | `false` (lib) · **on** (CLI + MCP) | the opt-in semantic tier |
| `embedWeight` | `1.0` | semantic fusion weight (higher = more semantic) |
| `embedModel` | `Xenova/all-MiniLM-L6-v2` | transformers.js model id |
| `embedder` | — | inject a custom/stub embedder (advanced / testing) |

(litectx-prd.md:214-223)

No activation-preset/weights knob exists — base-level activation as a ranking signal was
POC-falsified and dropped; the edit signal lives in `recentActivity`, never in config
(litectx-prd.md:225-226).

## Node kinds

`kind` is an open discriminator, present in the schema from day one, so the engine can grow into a
general ACT-R memory rather than staying a code index (litectx-prd.md:231-236):

| `kind` | v1? | What | Chunker | Source |
|---|---|---|---|---|
| `code` | v1 | AST chunks (function/method/class) | tree-sitter | file |
| `doc` | v1 (**md**) | authored prose passages (README, FAQ, KB…) | section-aware md chunker | file **or** direct |
| `fact` | slice 7 | semantic memory — a decontextualized, durable assertion | none (stored whole) | direct |
| `episode` | slice 7 | episodic memory — a time-stamped event/observation | none (stored whole) | direct |

(litectx-prd.md:238-244)

Doc *formats* (`md`, plus `pdf`/`docx`/`txt`/`log`/`csv`) are a `format` field under `kind=doc`,
never a new top-level kind, so adding a format never migrates the schema (litectx-prd.md:249-250).
Decay (§4) is likewise keyed by `kind`: adding a kind means a decay rate + a chunker, no schema
change (litectx-prd.md:466-468).

## View 1 — `recall()`

Recall is **kind-scoped**: kinds never share a ranking.

```js
const code = lc.recall("how does auth work", { kind: "code" });      // flat Hit[], default n=10
const both = lc.recall("how does auth work");                        // grouped { code:[…5], doc:[…5] }
const more = lc.recall("how does auth work", { kind: "code", n: 30 }); // dig deeper
const full = lc.recall("how does auth work", { kind: "code", body: true }); // inline each hit's content
```

`Hit → { path, kind, format, score, chunk, body?, meta? }` — `body` is populated only with
`{body:true}`; `meta` is the written-memory opaque dict (litectx-prd.md:181-186). `recall()` is
async (litectx-prd.md:182-185).

`recall()` runs as a pipeline: **gate** (lexical match, per kind) → **rank** (BM25 + 0.3·neighbor +
optional semantics) → attach each hit's best **chunk** pointer → return grouped by kind → **log**
one impression per hit — skipped with `{log:false}` so non-demand consumers (dashboards, CI,
batch tooling, read-only-db) don't pollute the demand signal (litectx-prd.md:618,744-747).

## View 2 — `impact()`

```js
const blast = await lc.impact({ file: "src/auth.ts", line: 42 });
// → { symbol, usedBy:{refs, files}, risk:"low"|"med"|"high", complexity, callers, callees }
```
(litectx-prd.md:188-190)

## The write path — `remember()` / `forget()`

Directly-written memory — facts, episodes, and docs with no file on disk (litectx-prd.md:192):

```js
await lc.remember("fact:auth-uses-jwt", "Auth is JWT, verified in middleware.", { kind: "fact" });
await lc.remember("faq:refunds", "Refunds within 30 days…", { kind: "doc", format: "md" });
await lc.remember("ep:2026-06-09-async", "recall() became async.", { kind: "episode", occurredAt: 1717900000 });
await lc.remember("fact:tagged", "…", { kind: "fact", meta: { sessionId: "s-1", tag: "auth" } });
await lc.forget("fact:auth-uses-jwt");                              // general shape: remember(id, text, {kind, format?, by?, occurredAt?})
await lc.forget({ idPrefix });                                      // base id + all its `#<n>` segments
await lc.forget({ kind: "fact", by: "agent" });                     // forget-by-query
await lc.scoped(tenant).forget();                                   // tenant-scoped wipe
```
(litectx-prd.md:193-197,500-506)

Key rules: `kind ∈ {fact, episode, doc}` for `remember()` — docs are first-class, not only facts
(litectx-prd.md:508-509). `by` = provenance (`"human"`|`"agent"`, default `"agent"`, *who*
asserted it), distinct from `source` (`file`|`direct`, HOW it entered, set internally by
`remember`) (litectx-prd.md:510-513). `occurredAt` is the episode timestamp (epoch ms, default
write-time); facts ignore it (litectx-prd.md:514). Content is stored **whole** — no
tree-sitter/section chunking; the caller controls granularity by how it splits before writing
(litectx-prd.md:515-516). `path` is the identity/disambiguator on every node; for written content
it's the caller-supplied key, doubling as the update/forget handle (litectx-prd.md:485-489).

Two entry paths decide the available kinds: `index()` → `code`/`doc` only (you cannot index a file
*as* a fact); `remember()` → `fact`/`episode`/`doc`. `doc` is the only kind both paths produce.
`index()` is never mandatory — a `remember()`/`recall()`-only store with no repo is a supported
pure-memory store (litectx-prd.md:491-496). fact vs episode is a *type* split, not a source split:
a **fact** is a decontextualized, durable assertion (no constitutive timestamp, slow decay); an
**episode** is a time-stamped event (`occurred_at` constitutive, fast/recency-dominated decay)
(litectx-prd.md:521-529). fact vs **doc**: a doc is retrieved as a passage (RAG-style), a fact is a
distilled assertion (litectx-prd.md:531-534).

### History, trust, and promotion

Every `recall()` hit is logged as an audit row (the access log), and every written item carries
`by` (human/agent) for trust — v1 records both but does not yet rank on them
(litectx-prd.md:536-543). Promotion is **earned by use**: an agent-asserted fact that crosses a
recall-hit threshold (default 5) becomes a review candidate via `reviewCandidates(threshold=5)`
(`by="agent" ∧ hits ≥ threshold`); a human either promotes it (`remember(id, text, {by:"human"})`)
or invalidates it (`forget(id)`) — this gates *review*, not ranking, so it isn't the
rich-get-richer loop the design otherwise forbids (litectx-prd.md:545-556). fact/episode ranking
in v1 is BM25(+embeddings) only — no import/call edges, so graph-spreading does not apply; the
decay/reinforcement behavior that would make it "cognitively" work is deferred to the access-log
tier (litectx-prd.md:558-565).

## Scoping — per-tenant isolation

Per-upload/per-call **`scope`** fences doc/blob and (since v0.21) fact/episode rows, distinct from
`owner`/`session`. `recall({ scope })` / `get(id, { scope })` return `scope ∪ null-global`, never
another scope; bare `get(id)` stays unfenced unless `strictScope` is set
(litectx-prd.md:280-289,343-347). **`strictScope: true`** makes a missing scope **throw** on read
*and* write (default off = byte-identical legacy behavior); **`GLOBAL`** is the unambiguous
shared-tier sentinel (never stored, maps to `scope IS NULL`); **`ctx.scoped(scope)`** binds a
scope once across every fenceable kind (doc, fact, episode) so it can never be omitted accidentally
(litectx-prd.md:290-302,294-297,336-337).

Per-tenant memory (v0.21) fences `recall({kind:'fact'|'episode'})` on both BM25 and KNN paths plus
the promotion ladder, and fences `get(id)` too — a scoped/`GLOBAL` `get` of another tenant's
fact/episode returns `null` (litectx-prd.md:328-347). `forget({ scope, kind? })` (v0.22)
tenant-deletes on `owner = scope` exactly (stricter than read's `owner ∪ global`, so it can't wipe
shared memory) and combines only with `kind` — adding `by`/`id`/`idPrefix` throws rather than
silently widening the wipe (litectx-prd.md:348-366). `scoped(tenant).forget({ id })` / `{ idPrefix
}` (v0.27) compose with the fence: the delete matches the owner-qualified physical key, so a
foreign tenant's id matches nothing (litectx-prd.md:436,448-458).

Optional **`expiresAt`** on doc/blob rows excludes expired rows from recall/get and is reclaimed by
`ctx.purge()`; there is **no per-row TTL on the memory axis** — facts are durable by default,
episodes decay via the fixed prune window (litectx-prd.md:287-289,377,558-565).

## Other reads

**`recentMemory({ scope, n, body, kind? })`** is a separate verb (not a `recall` flag) for
all-stopword queries where `recall` returns `[]`: `kind` omitted → doc axis (newest-first,
scope-fenced + expiry-aware); `kind:'fact'|'episode'` (v0.23) → memory axis, newest-first by
`occurred_at`/`created_at`, owner-fenced; mixing doc with fact/episode in one call throws
(litectx-prd.md:303-315,367-380). **`count({ scope, kind })`** (v0.23) is a tenant-fenced row
count, additive across the doc and memory axes (litectx-prd.md:378-380). **`enumerate({ kind,
scope, offset, limit, body })`** (v0.26) is an ordered, query-less, rank-free `rowid` walk of one
memory kind (`fact`/`episode` only in v1), for "how many / all of them" questions `recall`
structurally can't answer — paginate via `offset` until `nextOffset === null` (gapless, no dupes),
writes nothing to the recall log, and is **API-only, never model-callable** (absent from MCP/CLI)
(litectx-prd.md:413-435). **`hit.cosine`** (v0.27) is surfaced verbatim on `fact`/`episode` recall
hits only, when the embeddings tier is on — raw `[-1,1]`, an *unblessed* signal (no reliable
per-query threshold, consumer owns the cut), absent on `code`/`doc` (litectx-prd.md:436-448).

## Document ingest

`ctx.ingest(buffer, { filename, scope?, expiresAt? })` is the chat-upload flow, routed by file
extension (never content-sniffed): **md/pdf/docx** → chunkable, converted to markdown then
chunked (pdf/docx ride an optional lazy peer-dep tier, `pdfjs-dist` + `mammoth`, so the base
install stays lean/offline) (litectx-prd.md:251-259); **txt/text/log/csv** → chunkable via the
same headless plaintext packer, no parser/peer-dep needed (litectx-prd.md:271-275); **any other
type** (xlsx/xml/code/binary) → byte-exact `BLOB`, filename-indexed for recall, body never parsed,
`get(id)` returns the original bytes (litectx-prd.md:276-279). Ingest is deliberately **not** the
seam for ML-grade document conversion (tables/OCR/layout) — that stays a consumer-side concern
feeding markdown into `ingest()` (litectx-prd.md:260-270).

## The substrate — graph and adapter

```js
const node = await lc.getNode(id);
const related = await lc.related(id, { edge: "calls", hops: 1 });

import { liteCtxAsStore } from "litectx";
const memory = liteCtxAsStore(lc);   // drop-in four-method { store, search, get, delete }
```
(litectx-prd.md:199-206)

Three orthogonal fields govern every node and must not be conflated (litectx-prd.md:477-483):
memory type (`kind`: `code`/`doc`/`fact`/`episode` — decides retrieval semantics + decay rate),
content form (`format`: `ts`/`js`/`py`/`md`, +`pdf`/`docx`/`txt`/`log`/`csv` — decides the chunker,
never a new kind), and origin (`source`: `file`/`direct`, + provenance user/agent/doc — decides
`index()` reconciliation + trust).

## Kinds x operations, at a glance

The whole machine is four kinds × seven operations with two frozen weights (litectx-prd.md:591-596).
`get(id, {log?})` also logs a tagged weak `fetch` signal, excluded from demand counting since you
only fetch what recall already returned (litectx-prd.md:619).

| | **code** | **doc** | **fact** | **episode** |
|---|---|---|---|---|
| Enters via | `index()` | `index()` (.md) or `remember()` | `remember()` | `remember()` |
| Word matching | exact tokens | exact tokens | stemmed | stemmed |
| Graph boost | yes (imports) | no | no | no |
| Survives re-index | re-built from file | re-built / survives if direct | always survives | always survives |

(litectx-prd.md:597-606,611-620)

## Chunk-granular `get()`

```js
lc.get(path, { startLine, endLine });
```

Redeems the exact pointer `recall()` issued, returning one chunk (code + its leading doc-comment)
instead of a whole file — a caller that previously re-read a 117 KB file nine times can fetch the
7-line function directly (litectx-prd.md:658-663). Resolution is by **(lines, content hash), never
by symbol name** — names are duplicated, renamed, and absent on ~40% of chunks, so name-lookup can
silently return the wrong body (litectx-prd.md:665-670). The index self-heals on litectx-version
upgrade: `index()` stamps the db with a hash of its own source and re-chunks on mismatch, since a
pointer's lines are only meaningful against the file *and* chunker version that drew them
(litectx-prd.md:671-676).

## Config note — no facts-only embedding default, and `log:false`

Facts ride the single existing embeddings tier switch (no second knob, per the one-config
doctrine); with the default tier off, "write facts in the words you'll query" is an accepted,
documented gotcha (litectx-prd.md:720-729,743). `recall({ log:false })` is the one boolean opt-out
for non-demand callers (dashboards, CI, batch tooling) so the recall log stays a pure demand
signal (litectx-prd.md:744-747).
