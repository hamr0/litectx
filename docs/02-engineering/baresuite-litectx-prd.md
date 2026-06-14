# litectx ↔ baresuite — the integration contract (buildable-now + the adopter guide)

> **What this is — the single canonical litectx↔baresuite contract.** Merges two former docs: the
> *buildable-now distillation* (§0–§4 below) and the *integration guide* (the orientation preamble +
> §5–§9, folded in from the retired `litectx-for-baresuite.md` 2026-06-13). It answers, in one place:
> **what litectx is, why your suite consumes it, exactly what you build and what stays litectx's job,
> and — of the primitives the suite depends on — which can be built now vs. which wait on you.**
>
> **Method = the §8.1 discriminator.** Does a primitive's contract *depend on knowing how a specific
> consumer drives it* (→ adopter-pulled, **defer**), or is it *self-evident from litectx's own data
> model / already frozen in a sibling repo's code* (→ **build now**)? This doc separates the two.
> Every "build now" claim is grounded at file:line, not asserted.
>
> **Grounded against live source 2026-06-12** (HEAD `9ac64c8`, `litectx@0.8.0`): the litectx facade,
> `../bareagent/types/index.d.ts`, `../bareguard/src/gate.js`. **Sources of truth (litectx side):**
> [`litectx-ce-prd.md`](../01-product/litectx-ce-prd.md) §10 (the lift), §8/§8.1 (the surface + build
> order); [`litectx-memory-prd.md`](../01-product/litectx-memory-prd.md) §3 (the API).
>
> > **Stable anchors — do not renumber.** §4.1 and §4.4 are cited cross-repo (bareagent
> > `docs/01-product/prd.md`) and by `litectx-ce-prd.md`. The integration-guide material is appended as
> > §5–§9 precisely so §0–§4 keep their numbers.

---

## Orientation — what litectx is & why baresuite consumes it

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
come in (§6–§7).

**Why baresuite consumes litectx — and the direction.** baresuite serves **lightweight, one-shot
automation**; litectx serves **long-running, specialized agents that need persistent, ranked,
relationship-aware memory.** Your suite reaches for litectx when a loop needs to *remember across
turns/sessions*, *retrieve the right context*, or *park context out of the window* — heavier than the
thin `Memory` passthrough you ship today (`bareagent/src/memory.js`). **The dependency direction is
fixed: baresuite consumes litectx, never the reverse** — litectx is standalone and never imports
baresuite. So everything below is *you adapting to litectx's surface*, or litectx *copying/adapting a
shape from your repos* into its own standalone implementation — never a runtime dependency onto you.

**Two distinct relationships (don't conflate):**
1. **bareagent *imports* litectx** for its own orchestration (assemble context → run loop → persist).
   Use the **direct API** (`import { LiteCtx }`) — real types, in-process, no JSON-RPC.
2. **bareagent *mounts litectx's MCP server*** into the toolbox of the **sub-agent it drives** — so the
   *model* can call `recall`/`remember`/`impact` mid-reasoning. This is the only legitimate MCP use:
   equipping the model in the loop, **not** easing bareagent's own consumption (wrapping a function call
   in JSON-RPC only removes capability). litectx-CE-PRD §10.5.

---

## 0. Status snapshot — where the surface actually stands

**Shipped (live on the facade, `src/index.js`):** `index` · `recall` · `impact` · `get` · `remember`
· `forget` (memory-only) · `stash` · `peek` · `evict` · `reviewCandidates` · `promotionCandidates`
· `recentActivity` · embeddings tier · plus exported `compress`.

**Dropped on evidence (do NOT re-propose):**
- **R-S8 `recall().quality`** — POC-falsified twice (`poc/confidence-poc.mjs`: AUC 0.92, no usable
  threshold). [[rs8-confidence-label-falsified]]
- **R-G5 `supersede`** — duplicative (`forget`+`remember` upsert already covers it).
- **SELECT-as-proactive-inject (auto-inject inside `assemble`)** — POC-killed 2026-06-13
  (`poc/assemble-select-poc.mjs`, RESULTS.md): in-window-keyed recall re-supply is 25% chunk-level,
  **0% outside one repo**, flat across query recipes (min/rich/upper), embeddings inert (code recall is
  BM25-gated, verified live). Reactive `recall`/`get`/`impact` already serve "fetch my own code";
  proactive injection at 25% precision is net context-rot. See §4.1. (Never-read explicit-query SELECT
  is untested, not endorsed.)

**The Tier-A well is closed** (CE-PRD §8.1): `compress` (v0.7.0) + `evict` (v0.8.0) shipped, R-S8 +
R-G5 struck. So "what's next" is no longer a Tier-A scrape — it's the question this doc answers.

---

## 1. The honest gate first — most CE is *deliberately* deferred

The CE-PRD §8.1 splits the unbuilt surface into **Tier-B (adopter-pulled)** — shape genuinely unknown
until a caller exists — and these are **not** speculative-build candidates. Listing them so the
"build now" shortlist below is understood as *the residue after this exclusion*, not an oversight:

| Primitive | ID | Why it waits on bareagent (do NOT build speculatively) |
|---|---|---|
| ~~`assemble({intent,budget})`~~ | R-G6/R-C2/R-X1/R-X4 | **RESOLVED → build-now; budget-fit POC ✅ CLEARED 2026-06-13 (CE-PRD §8.2).** bareagent's RT-1 seam supplied the consumer: `assemble(units, ctx)` over a neutral unit model, `intent`=`ctx.task`, budget=tokens, cache-stable order via `pinned`/`atomic`. POC (`poc/assemble-fit-*.mjs`) settled the one open claim: recency-anchored fit @50% loses 1.8% of 1059 real re-read deps, live model 8/8-present vs 0/8-absent; constraints → recency-anchored (no semantic re-rank), `dropped[]`-with-handle in the same slice. **Build, not blocked.** |
| `session` / `state` / `state.view` | R-W3/R-I2 | The state *schema* (which fields, which are LLM-visible) is the consumer's, not ours. |
| `clear` / `trim` / `summaryWindow` | R-C3/R-C5/R-C6 | Loop mechanics: *when* to clear/trim/summarize is the orchestration loop's policy. |
| `selectTools(intent, defs)` | R-S6 | Net-new candidate; needs a real tool corpus + a caller to rank for. |
| `recordUseful(ids, weight)` | R-W7 | Mechanism is aurora-calibrated, but the recall-rerank use was **falsified topic-blind** (memory-PRD §14 #4); its only safe home (trust/tie-break) already shipped as columns. Needs the loop's success-verdict. |

**These are "pending litectx" only in the sense that litectx will eventually host them — their design
is pending the consumer, so building now would be procrastination dressed as progress.** ~~`assemble()`
is the one the whole doctrine is reserved for.~~ — **`assemble()` is no longer pending:** bareagent's
RT-seam negotiation (2026-06-12) supplied the consumer and pinned its shape (CE-PRD §8.2).

**↳ RT-seam negotiation outcome (2026-06-12):**
- ✅ **RT-3 SHIPPED (the memory socket):** `recall(q,{body:true})` inline-body (`9df3f5a`) · `meta`
  sealed passthrough as a new non-FTS `mem_meta` table (`5402a6e`) · `liteCtxAsStore(lc)` adapter
  (`1b57e77`); plus a pre-existing store.js NUL-byte defect fixed (`acc6ea0`). 196 tests green.
- **build-now (next):** `assemble(units, ctx)` — shape pinned, **budget-fit POC ✅ CLEARED 2026-06-13**
  (`poc/assemble-fit-poc.mjs` structural + `poc/assemble-fit-model-poc.mjs` live-model; RESULTS.md).
  Building: recency-anchored fit · `pinned`/`atomic` invariants · `dropped[]`-with-handle same slice.
- **zero new code (adapter ready):** RT-4 sub-agent toolbox = `litectx-mcp` read verbs +
  `liteCtxAsStore` + child-own `dbPath` isolation (memory-PRD §3.2) — read-only child default, no
  schema. Recipe/example/test are bareagent's side.
- **still deferred:** RT-2 post-round harvest (un-defers *with* the `trim`/truncation seam, as a
  harvest-before-evict interlock) · RT-5 `scope` column R-I1 (un-defers for the shared-db multi-tenant
  case; separate-db covers spawn isolation today). Full ledger: CE-PRD §8.2.

---

## 2. Build NOW — shape is pinned by frozen sibling code or litectx's own data model

These pass the §8.1 discriminator: **no consumer ambiguity.** Ranked by readiness.

### ① bareagent `Store` adapter — *the bullseye* (CE-PRD §10.2)
- **What:** a thin shim exposing litectx as bareagent's swappable memory backend, matching the
  **frozen** interface `{store, search, get, delete}`.
- **Why buildable now:** the contract is **already code in the sibling repo** —
  `../bareagent/types/index.d.ts:58-62`, and `../bareagent/src/memory.js` literally documents *"Bring
  your own: implement { store, search, get, delete }"* and projects results onto
  `[{id, content, metadata, score}]`. Nothing about the shape is unknown. This is wiring litectx to an
  existing, stable interface — **not** speculative.
- **Shape:** `store(content, meta) → remember(id, content, meta)` · `search(q, opts) → recall(q, opts)`
  projected to `{id, content, metadata, score}` · `get(id) → get(id)` · `delete(id) → forget(id)`.
- **Standalone rule (§0 of CE-PRD):** copy/adapt the *shape*, **no runtime dependency** on bareagent
  (no import). ~50 lines + integration test against a `:memory:` store.
- **Caveat:** confirm bareagent actually intends to mount litectx as its store before shipping — the
  adapter is the glue, but it earns its keep only once a bareagent flow consumes it. Cheap and
  low-risk either way (contract frozen, blast radius zero).

### ② bareguard write-gate seam (CE-PRD §10.1) — **the one net-new bareguard primitive (see §5B)**
> **litectx EMITTER SHIPPED 2026-06-14.** The write-gate hook is built: `remember()` emits
> `{type:"memory.write", kind, provenance, text, id, meta?, injectionRisk?}` via the exported
> `toWriteAction` and checks it through an opt-in `writeGate` (duck-typed `.check`) before committing;
> deny throws `WriteDeniedError`, nothing persists. `WriteAudit`/`WriteDeniedError` also exported. POC
> 13/13 on the REAL bareguard `Gate` (`poc/write-gate-emitter-poc.mjs`). **bareguard is now unblocked** to
> swap `seam-contract.test.js` onto the real emitter (the producer-less seam in §1 item 4 now has a
> producer). `memory.write` only — `memory.inject` has no producer (SELECT killed).
- **What:** litectx emits gate-able actions `{type:"memory.write"|"memory.inject", kind, provenance,
  text, …}` and exposes a minimal optional **write-gate hook** so the action is checkable standalone;
  inside baresuite, bareguard *is* the gate.
- **Zero-change covers the SHAPE half only.** bareguard's 6-step floor (`gate.js:140-176`) is
  **type-generic** — a `{type:"memory.write"}` already routes through denylist → content → allowlist
  with no new code (proven in `bareguard/test/seam-contract.test.js`). The earlier "recognize the two
  action types" framing is **retired** (§5B): no type recognition is owed.
- **The one real ask — a structured shape-flag gate.** The §6 line says "bareguard gates the flag by
  shape," but bareguard can only read `action.type` (allowlist) or `JSON.stringify(action)` (content
  regex) — it has **no path that reads a structured field**. So litectx needs a small generic `flags`
  primitive that gates on a named field's value (`provenance`, `injectionRisk`) **before the allowlist**
  (floor supremacy). Full spec, action-field contract, and seam-test swap in **§5B**.
- **Scope discipline (the §6/§7 line):** litectx carries the **source** label (R-G3, e.g.
  `provenance:"web"`) — *not* a trust verdict; the `flags` policy decides which sources escalate.
  litectx must **not** push content judgment into bareguard.
- **Pairs with:** a small own audit-log + `redact` (adapt from `bareguard/primitives/audit.js`,
  `secrets.js`) — the inject paper-trail. Build only the standalone hook now; reuse bareguard's audit
  when embedded.

### ③ `getNode(id)` / `related(id, {edge, dir, hops})` — the graph substrate ✅ **SHIPPED 2026-06-12**
- **Status:** **BUILT** (`src/index.js:440` `getNode`, `:454` `related`; `src/store.js:831/867`;
  `test/graph.test.js`). `getNode` = kind-agnostic structure (chunks + exact import-edge counts; written
  memory = zero-chunk/zero-edge node); `related` = BFS over persisted `import` edges (`dir` out/in/both,
  hops capped at 3). Seam invariant held: `getNode.edges.imports === related(out,1).length`. *(This
  section formerly read "genuinely absent" — that predated the graph-substrate build; corrected
  2026-06-13.)*
- **Net-new sliver still open:** R-G2 reserves non-code edge types (`supersedes`/`derived_from`/
  `references`/`belongs_to`). `related`'s `edge` is already a generic type so they slot in with **no
  migration once a producer emits them** — but **no producer exists yet** (building them now would be
  speculative). Calls stay `impact()`'s job (over-counts by design — off the exact graph).

### ④ `scope` / namespacing (R-I1) — buildable, but flagged *invasive, not cheap*
- **What:** a scope key (agent/session/user) + a filter on every op so contexts don't bleed; the
  foundation for per-child scoped stores in sub-agent spawning (§10.2).
- **Why buildable now:** shape is obvious (a column + a WHERE clause). **But** CE-PRD §8.1 explicitly
  warns the "cheap" label is wrong — it touches *every op* (schema migration + a filter on every query).
  Build it deliberately and measured, not waved through. Lower priority than ①–③ unless a multi-tenant
  / sub-agent consumer pulls it.
- **↳ Now specced (2026-06-13) — see §4.4.** The bare "a column" framing is superseded by the full
  **Isolate scope model** (`worktree` + `session` + `owner`, kind-aware, research-grounded). Still gated
  on the *relevance-already-isolates* POC (§4.5) before any column is written — measure, don't assume.

---

## 3. Recommendation

**Honest bottom line:** there is no large backlog of buildable-now litectx work — the §8.1 doctrine
already pushed the bulk (session/state, clear/trim) behind the adopter on purpose, and that call holds.
The factory-independent residue is now **almost entirely shipped** (status 2026-06-13):

1. ~~**`getNode`/`related` (③)**~~ ✅ **SHIPPED 2026-06-12** — public graph substrate complete.
2. **bareagent `Store` adapter (①)** ✅ **SHIPPED + MOUNTED** — `liteCtxAsStore` (litectx) + bareagent
   RT-3 consumer (v0.13.0). No longer pending.
3. **`assemble()` (R-G6)** ✅ **SHIPPED** — FIT (v0.11.0) + **COMPRESS tier (Build B, 2026-06-13)**;
   SELECT killed. bareagent RT-1 adapter consumes it (awaits → async-compatible).
4. **bareguard write-gate seam (②)** ✅ **EMITTER SHIPPED 2026-06-14** (litectx `build-b-compress-tier`
   @ `5b9cf8b`) — `toWriteAction` + opt-in `writeGate` on `remember` + `WriteAudit`/`WriteDeniedError`.
   bareguard's `flags` field-gate was already on main (`738ab20`); the seam is **branch-test GREEN on the
   real emitter** (bareguard `litectx-seam-branchtest` @ `1d182fe`: 10/10 seam rows, 139/139 suite — the
   two flag-path rows matched the litectx POC 13/13). **One step left and it's litectx's: cut the release**
   → then bareguard repins its seam test from the relative import to a published `devDependency` (the
   mergeable, CI-safe commit). See **§3.1 + §5B step 6**.
5. **`scope` (④)** — `owner`/`session` predicate ✅ **SHIPPED** (R-I1, §4.4); harness threading deferred (RT-5 trip-wire).

The factory-independent seam list is **done** (only the release cut remains). What's genuinely left is
**one agreed build — R-C6 summaryWindow** (shape CONFIRMED 2026-06-14; NOT to be deferred) — plus
necessary, trip-wired deferrals (R-S6 data-blocked, RT-2/RT-5). The canonical cross-repo board is **§3.1**.

---

## 3.1 Tri-repo board — who owns what + build order (canonical, 2026-06-14)

> The single source of truth for the litectx ↔ bareagent ↔ bareguard hand-offs. **Spine:** litectx is
> *consumed by* baresuite (bareagent + bareguard), never the reverse — litectx owns **content/context**,
> bareagent owns the **loop/grammar/provider**, bareguard owns the **gate/floor**. When a seam needs a
> model call or transcript grammar, it is NOT litectx's (it never calls a model on these paths, never
> learns provider grammar). Update this table, not scattered notes, when a hand-off moves.

### Ownership (steady-state)
| Domain | litectx (content) | bareagent (loop) | bareguard (gate) |
|---|---|---|---|
| Code/doc graph · recall · impact · `get`/`getNode`/`related` | **owns** | — | — |
| Write path · memory · `stash`/`peek`/`evict` · scope predicate | **owns** | — | — |
| CE render: `compress`, `assemble` (FIT+COMPRESS) | **owns** (the verb) | msgs⇄units adapter + grammar/pairing/fail-open | — |
| Store backend | `liteCtxAsStore` plug | mounts it (RT-3) | — |
| MCP mount | the `litectx-mcp` bin | mount recipe (RT-4) | — |
| Write-gate | **emitter** (`toWriteAction`) + standalone audit/redact | — | the **gate** (`flags` + 6-step floor) |
| Summary window (R-C6) | **policy SHIPPED** — `summaryWindow(units,ctx)` (trigger/N/splice over `assemble`) | **`ctx.summarize()` SHIPPED** (loop.js, §23.1.5) — live seam lit | — |
| Agent loop · tool dispatch · sub-agent spawn · `ctx` carrier | — | **owns** | — |
| Content-trust: source label vs verdict | `provenance` label + shape flag | — | renders **deny/ask** (never scans text) |

### Build order — agreed work only, no unnecessary deferral
**A. Close the write-gate seam:**
1. ✅ **litectx — release cut.** **v0.13.0 published** (COMPRESS + write-gate emitter), on npm.
2. **bareguard — repin** (DUE). Swap `seam-contract.test.js` from the relative import to a `devDependency` on `litectx@^0.13.0`; merge to main. ← *bareguard's move.* Seam then CLOSED both sides.

**B. R-C6 summaryWindow (AGREED — shape confirmed 2026-06-14):**
3. ✅ **litectx — windowing-policy POC** (`poc/rc6-summarywindow-poc.mjs`): at equal budget, 3/3 vs 0/3 dropped-turn answers. Gate PASSED.
4. ✅ **litectx — `summaryWindow(units, ctx)` SHIPPED** (`[Unreleased]`): a verb over `assemble` (last-N verbatim + rolling summary of older, restorable, never overflows). Works with any host summarizer.
5. ✅ **bareagent — `ctx.summarize(excerpt, opts?)` SHIPPED** (loop.js, spec'd §23.1.5; contract verified compatible). **The live R-C6 seam is lit** — litectx's `summaryWindow` reads `ctx.summarize` directly. (Committed on bareagent main; push/release is bareagent's call.)

**B is COMPLETE** — both halves shipped; the live seam works end-to-end. Optional next: a release cut + an end-to-end integration test wiring `summaryWindow` ↔ a real `ctx.summarize`.

**C. Contract-only close-outs — ✅ DONE:** resolved Tier-B contracts folded into **§5C** (R-W3 = state on `ctx.session`; R-C3/C5 = view-level drop only; R-W4 = `remember(kind:"episode")`; R-S6 = data-blocked). Scratch deleted. **No code on any repo.**

### Necessary deferrals (blocked on a real precondition — trip-wires, not vague "later")
| Item | Owner when it fires | Trip-wire |
|---|---|---|
| **R-S6 selectTools** | litectx (build) | bareagent ships a real **tool corpus + (intent→tools) traces** (~hundreds of MCP tools). Today ~15–20 native → RAG lift ≈ 0. |
| **RT-2 onTurn observe** | bareagent (seam) / litectx (writer) | a **transcript-truncation seam** exists (harvest-before-evict interlock). |
| **RT-5 scope-key threading** | bareagent (thread) / litectx (predicate ✅ ships) | ephemeral children / cross-child queries / multi-tenant single store. |

---

## 4. Round update — 2026-06-13: the SELECT kill, the CE-primitive audit, and the Isolate scope model

> A design round (no code) that (a) killed proactive SELECT on POC + first-principles, (b) ran every CE
> primitive through one lens — *does it serve the agent on request, or push work it didn't ask for?* —
> and (c) settled the **Isolate scope model** the §2④ stub was waiting on. Grounded against the two CE
> docs ([`litectx-ce-prd.md` Appendix CE-T §3.4](../01-product/litectx-ce-prd.md), [`build-studies.md` Part E](build-studies.md)) and
> a 3-stream web research pass on the field's leaders (§4.4.8).

### 4.0 Summary — what this round settled
1. **Proactive SELECT is dead** (§4.1). Auto-injecting code the agent didn't ask for fails on evidence *and* principle. Reactive retrieval already covers the real need.
2. **The four primitives sort cleanly** (§4.2): **Write** = value (HITL facts + ranked memory). **Select** = reactive recall only. **Compress** = FIT (shipped) + one new buildable. **Isolate** = the scope model below.
3. **Compress gains one principled buildable** (§4.3): **middle-band down-tiering** — pin head, keep tail, down-tier the lost-in-the-middle valley. Deterministic, no LLM.
4. **The Isolate scope model is `worktree` + `session` + `owner`** (§4.4), with branch as a GC tag, db keyed to repo identity, a two-layer local/global memory split, and the promotion ladder as the only local→global path.
5. **Two POC gates are owed before any column is written** (§4.5) — same prove-don't-assert discipline that killed SELECT.

### 4.1 SELECT-as-proactive-inject — KILLED
- **Evidence** (`poc/assemble-select-poc.mjs`, RESULTS.md): on real edit-after-read cases across 8 repos, recall queried with **in-window signal only** re-supplied the needed chunk **25%** of the time, **0% outside the one repo** that carried the average; file-level was 56% but mailproof-dominated. Ablated `min`/`rich`/`upper` query recipes → flat (more signal doesn't help; the bottleneck is the FTS gate + chunk localization). Embeddings **ON ≡ OFF** — code recall is BM25-gated (verified live: 74 stored vectors, reranks NL queries; the misses are gate misses cosine can't recover). Four harness bugs each faked a clean 0% first — all found by re-running. [[prove-dont-assert]] [[verify-shipped-against-poc-data]]
- **First principles:** agents already fetch their own code — `recall`/`get`/`impact` are shipped and live. There is **no demonstrated demand** (contrast FIT, which fixed a proven 8/8-vs-0/8 failure). And 25%-precise injection means ~75% noise displacing real transcript content inside a fixed budget — `assemble` becoming **context-rot of its own**.
- **Consequences:**
  - "Re-supply the file I'm editing" is a **direct path fetch** (`get`/`impact` by path), not lexical recall.
  - recall-SELECT's only un-refuted value is the **never-read related file** (a callee def never opened) — needs an **explicit, agent-supplied query**, is **untested**, and is methodologically hard to POC (proposed ground-truth proxy: the agent's *own later Read* of a graph-adjacent file, gated by an impact edge — flagged risky, not yet endorsed).
  - The bareagent **role-boundary decision** (what role an injected unit carries) is **downstream of this** — moot until an injection mode actually ships. Do not spend it yet.

### 4.2 The four CE primitives — value vs. bloat (lens: *no proactive help the agent didn't ask for*)

| Primitive | The part that's real (keep) | The part that's bloat / ceded | Verdict |
|---|---|---|---|
| **Write** | durable store + searchable, ranked recall; **HITL human-authored facts/instructions** | the agent's *decision* to auto-memorize (ceded to agent/harness) | **Value — settled.** The HITL author *is* the demand. |
| **Select** | `recall` on request (shipped) | **proactive auto-inject (killed, §4.1)** | Reactive only. |
| **Compress** | FIT/budget-fit (shipped); **middle-band down-tiering** (§4.3) | LLM summarization (ceded / opt-in) | FIT + one new buildable. |
| **Isolate** | a scope model: `worktree`+`session`+`owner` (§4.4) | sub-agent orchestration (ceded to harness) | Designed; POC-gated. |

The left column is one coherent thing — **a searchable store the agent queries on demand, returning the best-ranked, budget-fitted answer**. Every right-column item is agent-policy or harness-runtime.

### 4.3 Compress — middle-band down-tiering (the one new buildable)
Grounded, not arbitrary: the CE-29min transcript (`build-studies.md` Part E) establishes **lost-in-the-middle** (U-shaped attention, beginning + end used well, middle missed, 30+ pt drop), **stable-top / recent-bottom** ordering, and the only **LLM-free** compaction = trim-oldest. Compose them:
- **head** (system / rules / first instructions) → **pinned, verbatim** — FIT already does this.
- **tail** (recent turns) → **kept, verbatim** — FIT's recency anchoring already does this.
- **middle** (old tool outputs, the U-curve valley) → **down-tier to signature** (`compress()` shipped) **or drop with a rehydrate handle** (R-C4; `stash`/`peek` already park + preview **head+tail**).

So COMPRESS is **positional** — you compress where attention is already wasted, fully deterministic, no LLM. It slots into `assemble` FIT (head-pin + tail-recency exist; add the middle-tiering step). **POC-gated** (§4.5).

> **POC verdict (2026-06-13, `poc/compress-middle-poc.mjs` + `poc/lost-in-middle-poc.mjs`) — reframes this section.** Two findings: **(1)** the signature-vs-drop mechanism is confirmed and useful — signature-tier preserved a middle answer **6/6** where **drop** lost all 6, at 24% bytes, zero hallucinations. **(2)** the positional premise is **REFUTED for litectx's target model**: a 400-unit / ~159 KB (~41k-token) lost-in-the-middle position sweep found a single attention-required needle **15/15, flat across all positions including the middle** — no mid-context penalty on sonnet at scale. So **build signature as a rank/recency-driven intermediate BUDGET TIER** (keep verbatim → down-tier to signature → drop, applied to the units FIT would otherwise drop) — **NOT** a positional "middle-band" rule; the lost-in-the-middle rationale this section opened with does not hold here. Honest limits: signature preserves the **doc/header**, not the body (body-level answer lost too, 0/2); the refutation is single-fact retrieval on one strong model up to ~41k tokens (not a universal claim). See `poc/RESULTS.md` §4.5 gate #2.

### 4.4 The Isolate scope model — SPEC (settled 2026-06-13)
Supersedes the §2④ "a column + WHERE" sketch and the §1 RT-5 row.

**4.4.1 — Two layers, kept separate.** Workspace isolation and memory isolation are *different problems*:
- **Workspace → worktree** (ephemeral, filesystem). The code sandbox.
- **Memory → stable ids, NEVER the workspace.** Durable, survives teardown.

**4.4.2 — The keys.**
- **`worktree`** — **mandatory** for any code work (sandbox-by-default; you never have to predict "will it diverge"). One branch per worktree (git enforces it); ephemeral; torn down at resolution. Already provided by the orchestrator. litectx does **not** key memory on it.
- **`session`** — **universal**, harness-supplied. Isolates volatile memory (`stash`, `episode`) between concurrent runs. The *only* key that distinguishes same-branch / same-owner concurrent agents (the "two reviewers of one checkout" case).
- **`owner`** — scopes/shares durable `fact`s per actor. Fallback chain: `git config user.email` → explicit config → **OS username** → single-tenant default.
- **`branch`** — **metadata / GC tag, NOT an isolation key** (mutable; fails the same-branch case). Drives retirement and filtering only.
- **DB location** — keyed to **repo identity** (remote URL / shared `.git`), **never the worktree path** — or memory dies when the worktree is removed (the [`anthropics/claude-code#15776`](https://github.com/anthropics/claude-code/issues/15776) failure mode).

**4.4.3 — Kind-aware scope defaults.**

| Kind | Default scope | Durability | Recall sees |
|---|---|---|---|
| `code` / `doc` | per-worktree filesystem index (not in the shared memory db) | ephemeral, branch-correct | the worktree's own files |
| `stash` (parked agent-context, R-C4/R-I3) | `session` (+ `owner`, `branch` tags) | most transient — dies with the run/worktree | own session |
| `episode` (trajectory) | `session` (+ `owner`, `branch` tags) | run-scoped; `branch` tag drives GC | own session (± own owner) |
| `fact` (HITL instructions) | `owner`, or global (`NULL`) | durable, cross-session | own + shared/global |

**4.4.4 — Two-layer memory + the promotion bridge.** **Local/ephemeral** (`stash`, `episode` by `session`) + **global/durable** (`fact` by `owner`/global). The bridge is the **promotion ladder** — reuses the shipped `promotionCandidates` (slice 5b): an `episode` used **> 5×** surfaces as a candidate → **a human** decides `fact` + **local (`owner`) or global (shared)**. Scope is assigned **at promotion, by a person** — agents never self-author global facts.

**4.4.5 — No-repo / non-git automation.** Drop the `worktree`/`branch` rows (no divergent code to sandbox). Core = **`session`** (run id) + **`owner` = OS username**. Workspace un-sandboxed unless a temp-dir/container is added; `fact`s still durable per owner. The model degrades to exactly the two keys that don't depend on git.

**4.4.6 — GC + worktree lifecycle.** One branch per worktree; resolution is a human/orchestrator choice — **merge-all** (complementary streams) or **pick-one** (bake-off). Then `git worktree remove`. Removal is the **GC trigger**: that session's `episode`/`stash` retire; **promoted `fact`s survive** in the `owner` layer (R-G7, author-controlled, never agent-authored). This is *why* memory never lives inside the worktree.

**4.4.7 — Implementation sketch.** Two nullable columns — `owner` (NULL = global) and `session` (NULL = durable/not-run-bound) — a kind-aware default, and one filter:
`WHERE (owner IS NULL OR owner = :me) AND (session IS NULL OR session = :sid)`.
Git supplies `owner`; the harness supplies `session`; the db sits at the repo-identity path.

> **✅ BUILT (litectx, CHANGELOG `[Unreleased]`).** Shipped as `LiteCtxConfig.owner` / `.session`, kind-aware
> at write (`fact` = owner; `episode` = owner + session; `code`/`doc` unscoped). Two refinements vs the
> sketch, both faithful to its intent: (1) scope lives in a **non-FTS sibling table `mem_scope`**, not
> columns on `mem` — the `mem` FTS5 table takes no `ALTER ADD COLUMN`; mirrors `mem_meta`, zero-backfill.
> (2) the filter guards the unset reader: `(:me IS NULL OR owner IS NULL OR owner = :me) AND (:sid IS NULL
> OR session IS NULL OR session = :sid)` — a NULL `:me`/`:sid` sees everything (single-tenant default;
> literal `owner = NULL` would have wrongly hidden owned rows). litectx does **not** resolve identity
> (no `git`/OS call in the constructor) — the harness threads `owner`/`session` in (RT-5). Threaded
> through both the BM25 and embeddings/KNN recall paths. `stash` scope deferred (no GC consumer yet —
> AGENT_RULES: no speculative code; recall-burial, the proven need, is fact/episode only). Tests
> `test/scope.test.js` (6). **`worktree`/`branch` keys + db-at-repo-identity-path stay the harness's job.**

**4.4.8 — Research grounding (the leaders, why the weight landed here).**
- **LangGraph** — two orthogonal durable dims: `thread_id` (session, checkpointer) **+** `Store` namespace rooted on `user_id` (cross-session). Recommends both.
- **Google ADK** — four explicit scopes by key prefix: `session` (default) / `user:` / `app:` (global) / `temp:` (the *only* ephemeral one).
- **Letta** — memory blocks shared across agents by **explicit attach** (global + project-local blocks); sharing is deliberate.
- **Memary** — per-agent graph isolation, optional `user_id`.
- **Anthropic multi-agent** — sub-agents are **ephemeral-run** isolated; durable artifact returns as a ~1–2k summary; persistence is opt-in via external store.
- **claude-code#15776** — direct warning: keying durable memory to the *worktree path* loses it on teardown → key by repo identity.
- **container-use** — counter-pattern: makes the **branch** the durable key (state as git-notes), worktree is just machinery.
- **Net:** workspace → **worktree** (ephemeral); durable memory → **session + user**, kept off the workspace. That is exactly `worktree` + `session` + `owner`, branch as a tag.

### 4.5 Gates owed before any column is written (prove-don't-assert)
1. **Scope isolation — is `session` load-bearing? ✅ CLEARED 2026-06-13 → BUILT (see §4.4.7).** POC `poc/scope-session-poc.mjs`, now on **real uncrafted data** — episodes from 12 real Claude Code session transcripts of this repo (the first version was a rigged crafted-overlap corpus; corrected). Literal §4.5.1 test (recall over current-session-only vs all-sessions): the current run's episodes are **buried by more-relevant older sessions** — rank-1 stolen by a foreign session in **5/6 (BM25) · 9/10 (embeddings)**, own top-5 held only **38% · 8%**. **REAL and CONCURRENT regimes are identical because recency is not a ranking term** (verified: identical-text episodes aged 8d vs 1min score identically; decay only gates very-old). So relevance is session-blind and recency can't compensate — even in **solo** use (this corrected an earlier guess that recency would protect the solo case). Only an explicit `session` filter keeps a run's volatile context from being buried → **build the `session` scope.** Residual premise (stated, not buried): this is load-bearing *for own-run volatile retrieval*; for knowledge retrieval cross-session is a feature — which is why the model scopes `episode`/`stash` to `session` but `fact` to `owner`/global. (`poc/RESULTS.md` §4.5 gate #1.)
2. **Compress middle-tier — does it preserve task success? ✅ RESOLVED 2026-06-13 → build signature as a budget tier; positional rule REFUTED.** Two POCs: `poc/compress-middle-poc.mjs` (signature preserved the middle answer **6/6** where **drop** lost all 6, 24% bytes, 0 hallucinations) and `poc/lost-in-middle-poc.mjs` (a 400-unit / ~159 KB position sweep: single attention-required needle found **15/15, flat across all positions including the middle** — lost-in-the-middle did **not** manifest on sonnet at 41k tokens). So down-tier to signature is a confirmed **rank/recency-driven intermediate tier** (recover would-be-dropped units as signatures); the **positional "middle valley" framing is refuted for the target model** — do not build it. Honest limits: signature keeps doc/header not body (body-needle 0/2); the refutation is single-fact retrieval, one model, ≤41k tokens. (`poc/RESULTS.md` §4.5 gate #2; reframes §4.3.)
3. **(Deferred) never-read explicit-query SELECT** — only if revisited; the ground-truth proxy (agent's later Read of a graph-adjacent file) is methodologically risky and must be pressure-tested before any build.

*Memory pointers: [[litectx-absorbs-all-ce-primitives]] · [[slice-rc7-compress-shipped]] ·
[[rs8-confidence-label-falsified]] · [[borrow-aurora-dont-restart]] · [[prove-dont-assert]] ·
[[verify-shipped-against-poc-data]] · [[bareagent-rt-seam-contract]].*

---

## 5. The ask — what you build, grouped by repo and readiness

> The integration guide, folded in 2026-06-13. The Store adapter (① below) and bareguard write-gate (②)
> restate §2①/§2② from the adopter's side — see §2 for the §8.1 "build-now" justification and file:line
> grounding; this section is the per-repo *task* framing.

### 5A. bareagent — integration wiring (buildable now; contracts already frozen)

**(a) Mount litectx as a `Memory` backend.** Your `Memory` is a thin wrapper over a swappable store
and already invites *"Bring your own: implement { store, search, get, delete }"*
(`bareagent/src/memory.js`; interface at `bareagent/types/index.d.ts:58-62`). You ship two backends
(`store-jsonfile.js`, `store-sqlite.js`) — **litectx is a third**. The ask: a `store-litectx.js`
adapter mapping the four methods onto litectx:

| `Store` method | litectx call | notes |
|---|---|---|
| `store(content, metadata)` | `remember(id, content, {kind, by})` | `id` from metadata or hashed; `kind` defaults `fact` |
| `search(query, options)` | `recall(query, options)` | project hits → `[{id, content, metadata, score}]` |
| `get(id)` | `get(id)` | body text, verbatim |
| `delete(id)` | `forget(id)` | memory-only (litectx `forget` never touches files/stash) |

*Who ships it:* per CE-PRD §10.2 litectx ships the projection shim so it stays decoupled from your
version — **but the wiring that selects litectx as the active backend is yours.** Coordinate so it isn't
built twice.

**(b) Assemble → run → persist *around* the loop (loop unchanged).** `Loop.run()`
(`bareagent/src/loop.js:212`) never auto-reads memory — its `store` is validate-only (`:130`). So
context assembly + persistence stay in caller space, exactly where litectx plugs in:
```
context = litectx.assemble(units, ctx)   // ← RT-1 FIT shipped v0.11.0; SELECT/COMPRESS are the next slice
result  = loop.run(context.messages, tools)
litectx.remember(...harvest(result.msgs))       // persist what the turn produced
```
**Zero changes to `loop.run`.** litectx sits on both sides of it.

**(c) Scoped store per spawned child.** `spawnChild()` (`bareagent/tools/spawn.js:74`) hands children
no scoped context today. The ask: pass each child a **namespaced litectx view** through its config, so
sibling sub-agents don't bleed context. bareagent keeps fork + lifecycle; litectx owns the child's
context boundary. (The Isolate scope model is **built** — `owner`/`session`, §4.4.7; `worktree`/`branch`
keys + the db-at-repo-identity path stay the harness's job.)

### 5B. bareguard — gate the memory write/inject by **structured shape flag** (2026-06-13 regrounding)

> **Correction to the prior framing.** This section used to read *"bareguard does not recognize these
> types yet → recognize + gate the two action types … by `denyArgPatterns`/content regex."* Both halves
> are **retired**, source-grounded against `bareguard/src/gate.js` + `test/seam-contract.test.js`:
> (a) bareguard's 6-step floor is **type-generic** — a `{type:"memory.write"}` already routes through
> denylist → content → allowlist with **zero new code** (the seam test proves it), so no type
> *recognition* is owed; (b) "content regex over `provenance`/`injectionRisk`" is the **wrong
> mechanism** — it forces litectx to serialize its verdict into matchable text, violating the §8.2
> boundary (litectx never encodes a verdict as the consumer's grammar). The corrected ask is below.

**The real gap.** The §6 line says litectx reduces a content verdict to a **shape flag** and
*"bareguard gates that flag by shape."* But bareguard has **no path that reads a structured field** — it
gates on `action.type` (allowlist, `tools.js:61`) or on `JSON.stringify(action)` via regex
(`content.js:38`). So today the flag half of the seam is **asserted, not implemented** (the seam test
only exercises allowlist + content-text).

**The one ask — a structured field-value gate primitive.** Mirror `primitives/content.js`'s two-function
shape; read **named fields** off the action:

```js
flags: {
  provenance:    { web: "ask", subagent: "ask" },   // field → { value → outcome }
  injectionRisk: { high: "deny", medium: "ask" },
}
```
- Reads `action[field]` **directly** (never `JSON.stringify`) — lets litectx pass a structured verdict, not text.
- Outcome ∈ `deny` | `ask` only (a flag restricts, never grants; `allow` stays the default fall-through).
- **Floor supremacy preserved:** deny-arm co-located with step 2 (content-deny), ask-arm with step 4
  (content-ask) — **both before the allowlist (step 5)**, so a flagged inject is blocked *even if
  `memory.inject` is allowlisted*. That *is* "a memory may never relax the floor."
- Audit `rule = flags.<field>` (e.g. `flags.injectionRisk`), not a misleading `content.denyPatterns`.
- Absent/unconfigured field = no-op (like `net`/`bash` on a non-matching `type`).
~25–30 lines + one `types.js` config type + two wire-points in `_stepEval`. Generic — **not**
memory-specific, **no** `memory.*` type recognition.

**The action shapes litectx emits** (Build B / SELECT mints `memory.inject`; the write path mints `memory.write`):
```js
{ type:"memory.write",  kind, provenance, text, id, meta? }
{ type:"memory.inject", kind, provenance, text, sourceId, injectionRisk? }
```
| field | enum | set by |
|---|---|---|
| `kind` | `code \| doc \| fact \| episode` | litectx |
| `provenance` | `human \| agent \| doc \| subagent \| web` — the **source** (extends today's `human\|agent`, `index.js:103`) | litectx |
| `text` | content (`recall({body:true})`) | litectx |
| `id` / `sourceId` | node id (audit / restore handle) | litectx |
| `injectionRisk` | **optional** `low \| medium \| high`; absent unless a guardrails tier set it | guardrails tier (not litectx core); litectx passes through |

**Refinement to the §10.1 example, on purpose.** §10.1 shows `provenance:"untrusted"`. litectx will
**not** emit `"untrusted"` — that's a *trust verdict*, and which sources are untrusted is **policy**, not
litectx's content job. litectx emits the **source** (`provenance:"web"`); the `flags` config maps
source→outcome. This is *more* faithful to §6 than the PRD's own wording: litectx states the source,
bareguard's policy renders the verdict.

**Swap the seam test onto the real shape.** Replace `seam-contract.test.js:30`'s synthetic
`memoryWrite()` with litectx's real emitter and add the flag-path rows the current test can't express:
`provenance:"web"` + `flags:{provenance:{web:"ask"}}` → **ask**, `rule:"flags.provenance"`;
`injectionRisk:"high"` + `flags:{injectionRisk:{high:"deny"}}` → **deny even when allowlisted**
(floor-supremacy proof). The existing secret/text rows stay green untouched.

**Preserve floor supremacy & keep audit yours** — unchanged: the 6-step eval order holds; every
check/record still emits a JSONL line via `primitives/audit.js`; litectx reuses *your* audit when
embedded, ships its own only when standalone.

**The §6 line — do NOT take this on:** the **content verdict** (is this a prompt-injection? does it
semantically conflict with the floor?) stays litectx's job (or an opt-in guardrails tier). bareguard
only *reads* the flag; it never scans inject `text` and never renders the content judgment. Fixed
(CE-PRD §10.1).

**Dependency direction (neither side blocks).** Build B (`assemble` SELECT/COMPRESS) **ships standalone,
no bareguard change** — the gate is compose-time inside baresuite. The `flags` primitive + swapped seam
test land on bareguard's timeline; when both are in, the seam test flips from synthetic to real and
either stays green (coverage confirmed) or fails at the exact `rule` line.

### 5C. Tier-B adopter-pulled primitives — RESOLVED (2026-06-14)

These were **adopter-pulled** (CE-PRD §8.1 Tier-B): litectx asked bareagent to pin the spec before
building. bareagent answered (folded in here from the working scratch). **Net: of the five, one was a
real build (R-C6, now SHIPPED), one is data-blocked, three are subsumed by shipped primitives — no code.**
Ownership rule that settled them: if a seam needs a *model call* or *provider grammar* it is **not**
litectx's; litectx owns content/policy, bareagent owns the loop/provider.

| Primitive | Disposition | Who builds / owns |
|---|---|---|
| **R-C6 `summaryWindow`** | ✅ **SHIPPED** — `summaryWindow(units, ctx)`, a verb over `assemble` (last-N verbatim + rolling summary of older, restorable, never overflows). | litectx owns trigger/N/splice; **bareagent owns the model call** — `ctx.summarize(excerpt, opts?)` **SHIPPED** (loop.js, spec'd bareagent §23.1.5; contract verified compatible with litectx's `[{role,content}]` call). Live seam lit. |
| **R-W3 `session`/`state`/`state.view`** | **No build.** State rides the opaque `ctx` (forwarded by-ref, unmodified — bareagent's RT-1 guarantee); a field is LLM-visible iff litectx emits a unit for it in `assemble`, isolated iff it doesn't; durability = serialize into Memory + rehydrate. | litectx owns the schema (its own keys on `ctx.session`); bareagent owns the carrier + the Memory substrate. Both ship. |
| **R-C3 `clear` / R-C5 `trim`** | **No build.** `assemble` FIT+COMPRESS + `dropped[]` already do view-level elision every call; destructive transcript mutation is **forbidden** (breaks fail-open). "Spent" results drop from the *view*, restorable by id. | litectx (view-level, shipped); bareagent will not add destructive loop mutation. |
| **R-W4 note store** | **No build.** Subsumed by `remember(kind:"episode")` + free-form `meta`; survives compaction (lives outside the transcript). | litectx (shipped). |
| **R-S6 `selectTools` / `recordUseful`** | **Deferred — data-blocked, not design-blocked.** ~15–20 native tools → RAG-over-tools lift ≈ 0; recall-rerank-for-tools was falsified topic-blind (§1). | litectx (build) **when** bareagent supplies a real tool corpus + (intent→tools) traces. Trip-wire: hundreds of MCP tools + mineable traces. |

## 6. What litectx will NOT do — so you don't wait on it

Ceded to you/the harness by design (CE-PRD §7, §10). Build them on your side; litectx only defines the seam:

- **The agent loop, tool dispatch, sub-agent fork/lifecycle, sandboxes, phase control** → bareagent.
- **The content-trust *judgment*** (injection / secret / semantic floor-conflict) → bareguard renders the
  verdict; litectx carries the provenance label + a shape flag.
- **The LLM step** in fact-extraction, summarization, auto-compaction → opt-in tier / harness. litectx
  feeds these deterministically; it never requires an LLM on the write/index path.
- **Budget *enforcement*** (per-tier $ caps, soft/hard gates) → bareguard. litectx does budget-*aware
  assembly*, not budget *policing*.
- **Any GUI / rendering / visualization.** litectx ships graph *data* (`getNode`/`related`, in design);
  the click/highlight/render is a consumer's.

## 7. Hand-off summary — who owns what

| Capability | litectx (standalone) | baresuite (when present) |
|---|---|---|
| recall / impact / graph / write path / compress / stash-evict | **owns** | — |
| memory-write **shape** gate + floor supremacy + audit | label + content-flag | **bareguard** (gate.js) |
| content-trust verdict (injection / semantic conflict) | **owns** (or guardrails tier) | — |
| agent loop / tool dispatch | assembles `messages` around it | **bareagent** (loop.js) |
| sub-agent fork / lifecycle | scoped store per child (`owner`/`session`, §4.4) | **bareagent** (spawn.js) |
| per-task FSM / human-approval checkpoint | — | **bareagent** (state.js / checkpoint.js) |
| memory backend behind `Store {store,search,get,delete}` | **adapter shim** | bareagent **selects + wires** |

## 8. Start-here checklist for bareagent/bareguard

1. **Read** CE-PRD §10 (the full lift, file:line into your repos) + §8.1 (why Tier-B waits on you).
2. **bareagent:** scaffold `store-litectx.js` against `{store,search,get,delete}` (5A-a); the
   assemble→run→persist seam (5A-b) is live now that RT-1 FIT shipped.
3. **bareguard:** add the generic **`flags` field-value gate** to `_stepEval` (reads `provenance` /
   `injectionRisk` off the action, deny/ask **before** the allowlist) + swap `seam-contract.test.js`
   onto litectx's real emitter. **Not** `memory.*` type recognition — the floor is already type-generic (5B).
4. **bareagent (design, not code):** answer the `session` / `clear` / `selectTools` questions (5C) and
   send them back — that unblocks litectx's remaining Tier-B build.
5. **Coordinate the adapter seam** so the Store shim isn't built on both sides.

## 9. Reference — litectx surface you can call today

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
| `assemble(units, ctx)` | budget-fit a neutral unit array → `{units, dropped, tokens}` (RT-1 FIT, v0.11.0) |
| `reviewCandidates(threshold)` | agent facts recalled ≥N → human promote/kill |
| `promotionCandidates(threshold)` | episodes earning promotion |
| `recentActivity({...})` | recently-edited chunks (captured, not ranked) |

*In design (the substrate for codegraph/contextgraph views): `getNode(id)` + `related(id, {edge, dir,
hops})` — describe a node, walk its edges. Generic `edge` type so future CE edges
(`derived_from`/`supersedes`) slot in without migration.*
