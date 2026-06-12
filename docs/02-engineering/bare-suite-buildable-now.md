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

**The Tier-A well is closed** (CE-PRD §8.1): `compress` (v0.7.0) + `evict` (v0.8.0) shipped, R-S8 +
R-G5 struck. So "what's next" is no longer a Tier-A scrape — it's the question this doc answers.

---

## 1. The honest gate first — most CE is *deliberately* deferred

The CE-PRD §8.1 splits the unbuilt surface into **Tier-B (adopter-pulled)** — shape genuinely unknown
until a caller exists — and these are **not** speculative-build candidates. Listing them so the
"build now" shortlist below is understood as *the residue after this exclusion*, not an oversight:

| Primitive | ID | Why it waits on bareagent (do NOT build speculatively) |
|---|---|---|
| ~~`assemble({intent,budget})`~~ | R-G6/R-C2/R-X1/R-X4 | **NOW RESOLVED → build-now (CE-PRD §8.2).** bareagent's RT-1 seam supplied the consumer: `assemble(units, ctx)` over a neutral unit model, `intent`=`ctx.task`, budget=tokens, cache-stable order via `pinned`/`atomic`. Budget-fit quality stays POC-gated. |
| `session` / `state` / `state.view` | R-W3/R-I2 | The state *schema* (which fields, which are LLM-visible) is the consumer's, not ours. |
| `clear` / `trim` / `summaryWindow` | R-C3/R-C5/R-C6 | Loop mechanics: *when* to clear/trim/summarize is the orchestration loop's policy. |
| `selectTools(intent, defs)` | R-S6 | Net-new candidate; needs a real tool corpus + a caller to rank for. |
| `recordUseful(ids, weight)` | R-W7 | Mechanism is aurora-calibrated, but the recall-rerank use was **falsified topic-blind** (memory-PRD §14 #4); its only safe home (trust/tie-break) already shipped as columns. Needs the loop's success-verdict. |

**These are "pending litectx" only in the sense that litectx will eventually host them — their design
is pending the consumer, so building now would be procrastination dressed as progress.** ~~`assemble()`
is the one the whole doctrine is reserved for.~~ — **`assemble()` is no longer pending:** bareagent's
RT-seam negotiation (2026-06-12) supplied the consumer and pinned its shape (CE-PRD §8.2).

**↳ RT-seam negotiation outcome (2026-06-12) — three more build-now, two still deferred-with-trip-wire:**
- **build-now:** `assemble(units, ctx)` (shape pinned, budget-fit POC-gated) · `recall(q,{body:true})`
  inline-body flag (no migration) · `meta TEXT` sealed passthrough column (first memory-tier migration,
  write-path rows only).
- **zero new code:** RT-4 sub-agent toolbox = `litectx-mcp` read verbs + child-own `dbPath` isolation
  (memory-PRD §3.2) — read-only child default, no schema.
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

*Memory pointers: [[litectx-absorbs-all-ce-primitives]] · [[slice-rc7-compress-shipped]] ·
[[rs8-confidence-label-falsified]] · [[borrow-aurora-dont-restart]].*
