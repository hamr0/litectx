# litectx — what's buildable NOW for bareagent/bareguard (distilled 2026-06-12)

> **What this is.** A grounded distillation of the two PRDs ([`litectx-ce-prd.md`](../01-product/litectx-ce-prd.md)
> §8 rollup + §10 lift; [`litectx-memory-prd.md`](../01-product/litectx-memory-prd.md) §3 API)
> answering one question: **of the litectx primitives the bare suite depends on, which can I build
> now — without waiting on a consumer to define the shape?**
>
> **Method = the §8.1 discriminator.** Does a primitive's contract *depend on knowing how a specific
> consumer drives it* (→ adopter-pulled, **defer**), or is it *self-evident from litectx's own data
> model / already frozen in a sibling repo's code* (→ **build now**)? This doc separates the two.
> Every "build now" claim is grounded at file:line, not asserted.
>
> **Grounded against live source 2026-06-12** (HEAD `9ac64c8`, `litectx@0.8.0`): the litectx facade,
> `../bareagent/types/index.d.ts`, `../bareguard/src/gate.js`.

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

### ② bareguard write-gate seam (CE-PRD §10.1)
- **What:** litectx emits a gate-able action `{type:"memory.write"|"memory.inject", kind, provenance,
  text}` and exposes a minimal optional **write-gate hook** so the action is checkable standalone;
  inside baresuite, bareguard *is* the gate (zero bareguard change).
- **Why buildable now:** the gate contract is **frozen sibling code** — `Gate#check(action) →
  {outcome, severity, rule, reason}` at `../bareguard/src/gate.js:220`, with the 6-step floor-supremacy
  eval order at `gate.js` (denies/asks before allowlist). litectx copies/adapts that contract; the only
  net-new thing is the *action shape* litectx emits, which is litectx's own to define.
- **Scope discipline (the §6/§7 line):** litectx carries the **provenance label** (R-G3) and reduces any
  content verdict to a **shape flag** (`provenance:"untrusted"`, `injectionRisk:"high"`); bareguard
  gates by shape. litectx must **not** push content judgment into bareguard.
- **Pairs with:** a small own audit-log + `redact` (adapt from `bareguard/primitives/audit.js`,
  `secrets.js`) — the inject paper-trail. Build only the standalone hook now; reuse bareguard's audit
  when embedded.

### ③ `getNode(id)` / `related(id, {edge, hops})` — the promised graph substrate (R-G1/R-G2)
- **What:** the typed node + edge accessors. CE-PRD §1.1 and memory-PRD §3 both list these as
  first-class public API ("the graph is the product"); they are **genuinely absent** from the facade
  today (verified: only doc-comment mentions in `impact.js`/`tsalias.js`).
- **Why buildable now:** shape is **self-evident from the existing data model** and falsifiable on
  litectx's own data — no consumer needed. The store already holds typed nodes and `imports` edges
  (1-hop spreading already traverses them internally in `recall`); `related` is exposing that traversal,
  `getNode` is a row fetch by id. This is the cleanest factory-independent build — closer in spirit to
  Tier-A than Tier-B.
- **Net-new sliver to scope:** R-G2 also reserves non-code edge types (`supersedes`/`derived_from`/
  `references`/`belongs_to`). Ship `getNode`/`related` over the **existing** `imports`/`calls` edges
  first; add new edge types only when a primitive needs them (none does yet).

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
already pushed the bulk (assemble, session/state, clear/trim) behind the adopter on purpose, and that
call holds. The genuinely buildable-now residue is **integration glue + the promised substrate**:

1. **`getNode`/`related` (③)** — build first. Zero consumer ambiguity, completes the public graph
   substrate the PRDs promised, validatable on litectx's own data today.
2. **bareagent `Store` adapter (①)** — build when a bareagent flow is ready to mount it (contract is
   frozen, so it's ready whenever you are; just confirm a live consumer so it's glue, not shelfware).
3. **bareguard write-gate seam (②)** — build alongside ① if/when memory-write gating is on the table;
   contract frozen, scope-disciplined (label + shape-flag only, never content judgment in bareguard).
4. **`scope` (④)** — only when a multi-tenant / sub-agent consumer needs it; invasive, measure it.

Everything else is `assemble()`-class: **defer until bareagent pins the shape.** When bareagent exists,
the first question for each deferred item stays *"does `forget`/`evict`/`remember`/`recall` already
cover this?"* before adding surface.

---

## 4. Round update — 2026-06-13: the SELECT kill, the CE-primitive audit, and the Isolate scope model

> A design round (no code) that (a) killed proactive SELECT on POC + first-principles, (b) ran every CE
> primitive through one lens — *does it serve the agent on request, or push work it didn't ask for?* —
> and (c) settled the **Isolate scope model** the §2④ stub was waiting on. Grounded against the two CE
> docs ([`ce-tree.md`](../00-context/ce-tree.md) §3.4, [`ctx-ifra.md`](../00-context/ctx-ifra.md)) and
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
Grounded, not arbitrary: ctx-ifra.md establishes **lost-in-the-middle** (line 46 — U-shaped attention, beginning + end used well, middle missed, 30+ pt drop), **stable-top / recent-bottom** ordering (lines 152/217), and the only **LLM-free** compaction = trim-oldest (line 99). Compose them:
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
1. **Scope isolation — is `session` load-bearing? ✅ CLEARED 2026-06-13 (real-data rebuild) → YES, build it for `episode`/`stash`.** POC `poc/scope-session-poc.mjs`, now on **real uncrafted data** — episodes from 12 real Claude Code session transcripts of this repo (the first version was a rigged crafted-overlap corpus; corrected). Literal §4.5.1 test (recall over current-session-only vs all-sessions): the current run's episodes are **buried by more-relevant older sessions** — rank-1 stolen by a foreign session in **5/6 (BM25) · 9/10 (embeddings)**, own top-5 held only **38% · 8%**. **REAL and CONCURRENT regimes are identical because recency is not a ranking term** (verified: identical-text episodes aged 8d vs 1min score identically; decay only gates very-old). So relevance is session-blind and recency can't compensate — even in **solo** use (this corrected an earlier guess that recency would protect the solo case). Only an explicit `session` filter keeps a run's volatile context from being buried → **build the `session` scope.** Residual premise (stated, not buried): this is load-bearing *for own-run volatile retrieval*; for knowledge retrieval cross-session is a feature — which is why the model scopes `episode`/`stash` to `session` but `fact` to `owner`/global. (`poc/RESULTS.md` §4.5 gate #1.)
2. **Compress middle-tier — does it preserve task success? ✅ RESOLVED 2026-06-13 → build signature as a budget tier; positional rule REFUTED.** Two POCs: `poc/compress-middle-poc.mjs` (signature preserved the middle answer **6/6** where **drop** lost all 6, 24% bytes, 0 hallucinations) and `poc/lost-in-middle-poc.mjs` (a 400-unit / ~159 KB position sweep: single attention-required needle found **15/15, flat across all positions including the middle** — lost-in-the-middle did **not** manifest on sonnet at 41k tokens). So down-tier to signature is a confirmed **rank/recency-driven intermediate tier** (recover would-be-dropped units as signatures); the **positional "middle valley" framing is refuted for the target model** — do not build it. Honest limits: signature keeps doc/header not body (body-needle 0/2); the refutation is single-fact retrieval, one model, ≤41k tokens. (`poc/RESULTS.md` §4.5 gate #2; reframes §4.3.)
3. **(Deferred) never-read explicit-query SELECT** — only if revisited; the ground-truth proxy (agent's later Read of a graph-adjacent file) is methodologically risky and must be pressure-tested before any build.

*Memory pointers: [[litectx-absorbs-all-ce-primitives]] · [[slice-rc7-compress-shipped]] ·
[[rs8-confidence-label-falsified]] · [[borrow-aurora-dont-restart]] · [[prove-dont-assert]] ·
[[verify-shipped-against-poc-data]] · [[bareagent-rt-seam-contract]].*
