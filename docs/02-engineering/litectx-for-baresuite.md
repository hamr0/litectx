# litectx → baresuite integration guide (for bareagent / bareguard)

> **Who this is for.** bareagent and bareguard maintainers (human or agent). Drop this whole file
> into your context to get oriented on what litectx is, why your suite now consumes it, and **exactly
> what you build, for whom, and what stays litectx's job.** Written from litectx's side as the
> contract; nothing here asks you to depend on litectx at runtime in a way that couples you to it.
>
> **Grounded 2026-06-12** against `litectx@0.8.0` and your own repos at file:line (paths relative to
> `~/PycharmProjects/`). Where a line is cited, it was read, not assumed.
>
> **Sources of truth (litectx side):** [`litectx-ce-prd.md`](../01-product/litectx-ce-prd.md) §10
> (the lift), §8 (the surface), §8.1 (build order); [`litectx-memory-prd.md`](../01-product/litectx-memory-prd.md)
> §3 (the API).

---

## 1. Background — what litectx is

litectx is a **lite, local-first, importable memory library** for AI agents. It indexes a repo
(code + docs) and accepts written knowledge (facts/episodes) into one **code+context graph** stored
in a single SQLite file, and serves views over it:

- **`recall(query, {kind})`** — ranked search (BM25 + 1-hop import-spreading; embeddings optional).
- **`impact(symbol)`** — blast radius: callers/callees → risk bucket (low/med/high).
- **the write path** — `remember(id, text, {kind, by})` / `forget(id)` for facts/episodes/docs that
  have no file on disk; survives across sessions.
- **context-engineering verbs** — `compress(node, {level})`, `stash`/`peek`/`get`/`evict` (park a
  big payload out of the window, restore on demand).

**The lite line (binds everything):** no service/daemon, no external graph DB, no LLM-on-write,
single-file SQLite, one prod dep (`better-sqlite3`), embeddings/LLM are opt-in tiers. If a capability
can't live within that line, litectx **cedes** it rather than bending — which is exactly where *you*
come in (§4).

**Shipped surface you can call today:** `index` · `recall` · `impact` · `get` · `remember` ·
`forget` · `stash` · `peek` · `evict` · `compress` · `reviewCandidates` · `promotionCandidates` ·
`recentActivity`. (Full one-liners in §7.)

---

## 2. Why baresuite now consumes litectx — and the direction

**The scope split.** baresuite serves **lightweight, one-shot automation**; litectx serves
**long-running, specialized agents that need persistent, ranked, relationship-aware memory.** Your
suite reaches for litectx when a loop needs to *remember across turns/sessions*, *retrieve the right
context*, or *park context out of the window* — things heavier than the thin `Memory` passthrough you
ship today (`bareagent/src/memory.js`).

**The dependency direction is fixed: baresuite consumes litectx, never the reverse.** litectx is
standalone and never imports baresuite. So everything below is **you adapting to litectx's surface**,
or litectx **copying/adapting a shape from your repos** into its own standalone implementation — never
a runtime dependency from litectx onto you.

**Two distinct relationships (don't conflate):**
1. **bareagent *imports* litectx** for its own orchestration logic (assemble context → run loop →
   persist). Use the **direct API** (`import { LiteCtx }`) — real types, in-process, no JSON-RPC.
2. **bareagent *mounts litectx's MCP server*** into the toolbox of the **sub-agent it drives** — so
   the *model* can call `recall`/`remember`/`impact` mid-reasoning. This is the only legitimate MCP
   use: equipping the model in the loop, **not** easing bareagent's own consumption (wrapping a
   function call in JSON-RPC only removes capability). litectx-CE-PRD §10.5.

---

## 3. The ask — what you build, grouped by repo and readiness

### 3A. bareagent — integration wiring (buildable now; contracts already frozen)

**(a) Mount litectx as a `Memory` backend.** Your `Memory` is a thin wrapper over a swappable store
and already invites *"Bring your own: implement { store, search, get, delete }"*
(`bareagent/src/memory.js`; interface at `bareagent/types/index.d.ts:58-62`). You ship two backends
(`store-jsonfile.js`, `store-sqlite.js`) — **litectx is a third**. The ask: a
`store-litectx.js` adapter mapping the four methods onto litectx:

| `Store` method | litectx call | notes |
|---|---|---|
| `store(content, metadata)` | `remember(id, content, {kind, by})` | `id` from metadata or hashed; `kind` defaults `fact` |
| `search(query, options)` | `recall(query, options)` | project hits → `[{id, content, metadata, score}]` |
| `get(id)` | `get(id)` | body text, verbatim |
| `delete(id)` | `forget(id)` | memory-only (litectx `forget` never touches files/stash) |

*Who decides whether litectx **or** litectx ships this adapter:* per CE-PRD §10.2 litectx will ship
the projection shim so it stays decoupled from your version — **but the wiring that selects litectx as
the active backend is yours.** Coordinate so it isn't built twice.

**(b) Assemble → run → persist *around* the loop (loop unchanged).** `Loop.run()`
(`bareagent/src/loop.js:212`) never auto-reads memory — its `store` is validate-only (`:130`). So
context assembly + persistence stay in caller space, exactly where litectx plugs in:
```
context = litectx.assemble({intent, budget})   // ← see 3C: you must pull this contract
result  = loop.run(context.messages, tools)
litectx.remember(...harvest(result.msgs))       // persist what the turn produced
```
**Zero changes to `loop.run`.** litectx sits on both sides of it.

**(c) Scoped store per spawned child.** `spawnChild()` (`bareagent/tools/spawn.js:74`) hands children
no scoped context today. The ask: pass each child a **namespaced litectx view** (a scope key) through
its config, so sibling sub-agents don't bleed context. bareagent keeps fork + lifecycle; litectx owns
the child's context boundary. (Depends on litectx shipping `scope` — CE-PRD R-I1; flag if you need it.)

### 3B. bareguard — gate the memory write (buildable now; net-new action types)

litectx emits a gate-able action when memory is written or injected:
`{ type: "memory.write" | "memory.inject", kind, provenance, text }`. **bareguard does not recognize
these types yet** (confirmed: no `memory.write`/`injectionRisk` references in `bareguard/src`). The ask:

- **Recognize + gate** the two action types in `Gate#check(action)`
  (`bareguard/src/gate.js:220` → `{outcome, severity, rule, reason}`), by **shape** —
  `denyArgPatterns` / content regex over `provenance`, `injectionRisk`, `text`.
- **Preserve floor supremacy.** Your fixed 6-step eval order (`gate.js` — denies/asks *before* the
  allowlist) already gives the invariant *"a memory write may never relax the floor"*: a write
  matching a floor `denyPatterns`/`askPatterns` is blocked even if `memory.write` is allowlisted.
  Keep that ordering when you add the new types — don't special-case memory above the floor.
- **Audit stays yours.** Every check/record emits a JSONL line via `primitives/audit.js` — the inject
  paper-trail. litectx reuses *your* audit when embedded; it only ships its own when standalone.

**The §6 line — do NOT take this on:** the **content verdict** (is this fact a prompt-injection? does
it semantically conflict with the floor?) is litectx's job (or an opt-in guardrails tier), reduced to
a **shape flag** on the action (`provenance:"untrusted"`, `injectionRisk:"high"`). bareguard gates the
*flag by shape*; it never renders the content judgment. That division is fixed (CE-PRD §10.1).

### 3C. bareagent — *pull* the deferred primitives (specify so litectx can build)

These are **adopter-pulled** (CE-PRD §8.1 Tier-B): litectx deliberately has **not** built them because
their shape is *yours to define*. They are blocked on **you answering**, not on litectx coding. This is
the highest-leverage part of the ask — until you specify these, litectx should not build them:

| Primitive | What litectx needs you to pin |
|---|---|
| **`assemble({intent, budget})`** — the headline | What *is* `intent` — a query string? a step descriptor? · budget **unit** — tokens? nodes? · how do you want blocks **ordered** (cache-stable prefix + authority precedence)? |
| **`session` / `state` / `state.view`** | The state **schema** — which fields exist, which are LLM-visible vs isolated? |
| **`clear` / `trim` / `summaryWindow`** | The **policy** — *when* does your loop clear a spent tool-result / trim old turns / roll a summary? (litectx supplies mechanism; timing is your loop's.) |

---

## 4. What litectx will NOT do — so you don't wait on it

These are **ceded to you/the harness by design** (CE-PRD §7, §10). Build them on your side; litectx
only defines the seam:

- **The agent loop, tool dispatch, sub-agent fork/lifecycle, sandboxes, phase control** → bareagent.
- **The content-trust *judgment*** (injection / secret / semantic floor-conflict) → bareguard renders
  the verdict; litectx carries the provenance label + a shape flag.
- **The LLM step** in fact-extraction, summarization, auto-compaction → opt-in tier / harness. litectx
  feeds these deterministically; it never requires an LLM on the write/index path.
- **Budget *enforcement*** (per-tier $ caps, soft/hard gates) → bareguard. litectx does budget-*aware
  assembly*, not budget *policing*.
- **Any GUI / rendering / visualization.** litectx ships graph *data* (`getNode`/`related`, in
  design); the click/highlight/render is a consumer's.

---

## 5. Hand-off summary (who owns what)

| Capability | litectx (standalone) | baresuite (when present) |
|---|---|---|
| recall / impact / graph / write path / compress / stash-evict | **owns** | — |
| memory-write **shape** gate + floor supremacy + audit | label + content-flag | **bareguard** (gate.js) |
| content-trust verdict (injection / semantic conflict) | **owns** (or guardrails tier) | — |
| agent loop / tool dispatch | assembles `messages` around it | **bareagent** (loop.js) |
| sub-agent fork / lifecycle | scoped store per child | **bareagent** (spawn.js) |
| per-task FSM / human-approval checkpoint | — | **bareagent** (state.js / checkpoint.js) |
| memory backend behind `Store {store,search,get,delete}` | **adapter shim** | bareagent **selects + wires** |

---

## 6. Start-here checklist for bareagent/bareguard

1. **Read** CE-PRD §10 (the full lift, file:line into your repos) + §8.1 (why Tier-B waits on you).
2. **bareagent:** scaffold `store-litectx.js` against the `{store,search,get,delete}` interface (3A-a);
   stub the assemble→run→persist seam (3A-b).
3. **bareguard:** add `memory.write` / `memory.inject` recognition to `Gate#check`, gated by shape,
   floor-supremacy preserved (3B).
4. **bareagent (design, not code):** answer the three `assemble`/`session`/`clear` questions (3C) and
   send them back — that unblocks litectx's Tier-B build.
5. **Coordinate the adapter seam** so the Store shim isn't built on both sides.

---

## 7. Reference — litectx surface you can call today

| Method | One line |
|---|---|
| `index({paths?})` | incremental, git-aware repo index |
| `recall(query, {kind, n, log})` | ranked search; grouped by kind or flat |
| `impact(symbol)` | blast radius → `{usedBy, risk, callers, callees}` |
| `remember(id, text, {kind, by, occurredAt})` | upsert a fact/episode/direct-doc |
| `forget(id)` | hard-delete written memory (never files/stash) |
| `get(id, {log})` | body text — memory verbatim, files fresh from disk |
| `stash(id, text)` | park a payload out of the window (recall-invisible) |
| `peek(id)` | head+tail preview of a stashed payload (bounded result) |
| `evict(id \| {olderThan, maxCount})` | delete stashed payloads (stash-only) |
| `compress(node, {level})` | `verbatim` \| `signature` \| `drop` render |
| `reviewCandidates(threshold)` | agent facts recalled ≥N → human promote/kill |
| `promotionCandidates(threshold)` | episodes earning promotion |
| `recentActivity({...})` | recently-edited chunks (captured, not ranked) |

*In design (the substrate for codegraph/contextgraph views): `getNode(id)` + `related(id, {edge, dir,
hops})` — describe a node, walk its edges. Generic `edge` type so future CE edges
(`derived_from`/`supersedes`) slot in without migration.*
