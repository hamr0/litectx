# Stash — litectx: CE doc set built, CE PRD derived, bareagent/bareguard lift integrated, prep-work walkthrough in progress (2026-06-05)

- **Date:** 2026-06-05
- **Repo:** `/home/hamr/PycharmProjects/litectx` (== `/home/hamr/Documents/PycharmProjects/litectx`, same inode — user often types the `Documents` path; it resolves to the same place). cwd this session = `poc/`.
- **Track:** this session is the **context-engineering PRIMITIVES track** (the W/S/C/I doc set), *separate* from the memory-engine slice work (slices 2–4, other stashes). No code shipped this session — it's **discovery + design docs + a prep-work walkthrough**.
- **Mode:** docs/design. Real artifacts created in `docs/00-context/` and `docs/01-product/`; memories written. No `src/` touched.

---

## Headline outcomes this session

1. **Scope decision (settled):** litectx absorbs **all four CE primitives (Write / Select / Compress / Isolate)** and becomes the comprehensive CE library for **long-running** agents; baresuite (bareagent/bareguard) = lightweight **one-shot** automation.
2. **TWO separate PRDs, NOT a fold:**
   - `docs/01-product/litectx-memory-prd.md` — the **memory engine** (recall, impact, graph, ACT-R, kinds, indexing). *Renamed from `litectx-prd.md` this session (done externally/linter); refs clean.* Keeps its own §13.
   - `docs/01-product/litectx-ce-prd.md` — the **CE primitives** built on top. **References** the memory PRD (its §1.0), does NOT rewrite/absorb it. Own non-goals = §7.
   - `docs/01-product/barecontext-prd.md` — **SUPERSEDED by the two together** (banner added at top this session).
3. **CE doc set created** in `docs/00-context/` (+ a README index):
   - `ctx-ifra.md` — source transcript (Marina Wyss, *Context Engineering in 29 Minutes*). Kept intact.
   - `ce-tree.md` — **doc #1, the mental model + build map.** Primitives-as-trunk; everything branches with a 1–2 line desc; every leaf **marked** (legend below). Has a corrections ledger + per-author "anatomy of context."
   - `ce-flow.md` — **doc #2, recommended flows.** Claude Code / Manus / ADK / Slack / OpenAI + the turn pipeline + frequent-intentional-compaction, each mapped to the 4 primitives.
   - `README.md` — index (reading order, pipeline, the marks).
4. **CE PRD derived** (`litectx-ce-prd.md`) from the build-map marks; **bareagent/bareguard lift integrated** (§10, file:line); copy-adapt-standalone doctrine encoded (§0/§10).
5. **Dev order DECIDED:** finish **core memory first** (through recall ≈ memory slice 4 minimum); CE primitives come **after** as vertical slices on the one pipeline — **NOT parallel module-building** (the anti-pattern §11.1 guards against). User: *"we will wait until we get core memory right."* Only safe parallelism = design-ahead in docs (this session) + the prep work below.

---

## The marks (shared convention — this is the build map → drives the PRD)

| Mark | Meaning | Drives |
|---|---|---|
| 🧩 **CORE** | already in litectx's memory-engine scope | PRD: confirm |
| 🔧 **BUILD** | a CE primitive to add | **PRD requirement** |
| ⊘ **CEDE** | harness / bareagent / bareguard | **non-goal** |
| *(plain)* | concept/finding | context only |

**Lite line (binds every req):** no service/daemon · no external graph DB · no LLM-on-write/index · single-file SQLite · embeddings & any LLM step are opt-in tiers · one prod dep. **Standalone, copy-don't-depend:** baresuite *consumes* litectx, never the reverse; lift the *design* of primitives, adapt to standalone, never a runtime dep on baresuite.

---

## Source-grounding (method = derive from CE leaders, not guess) — corrections banked

5 parallel research agents grounded the tree against primary sources. Video diverged in ≥8 places (logged in `ce-tree.md` §7):
- episodic/semantic/procedural memory = **LangChain's** (from CoALA), **not Pinecone's**.
- Breunig has **6 fixes, not 4**; RAG+Tool-Loadout→Select, Pruning+Summarization→Compress, Quarantine→Isolate, Offloading→Write.
- RAG-MCP = **13.62%→43.13%**, >50% tokens; correct arXiv id **2505.03275** (not 2501.09136).
- "95% auto-compaction" is a Claude Code UX detail, **not** in Anthropic's essay (which says "nearing the limit" + preserve architectural decisions/bugs + **5 most-recent files**).
- **n²** = compute cost, **not** the cited cause of accuracy rot (Chroma/Lost-in-Middle are empirical/positional).
- "7 categories" = course construction; use per-author anatomy (Anthropic/LangChain/Chase).
- "think tool" **de-emphasized Dec 2025** (Anthropic now prefers extended thinking); +54% was airline-only/relative/optimized-prompt/Claude 3.7.
- HumanLayer "35k LOC" = **diff** into a ~300k-LOC Rust codebase (2 PRs, 1 merged), not a built codebase.
- KV-cache ordering (stable-first/append-only) = **cross-vendor consensus** (Manus + Google ADK) — strongest claim.

**Competitive survey (market-researcher):** litectx's moat = **deterministic** (no LLM-on-write, no graph DB, no server, single-file SQLite, code-aware graph). Every graph-memory competitor (Mem0/Zep-Graphiti/Cognee/GraphRAG) pays an LLM-per-write and/or mandates a graph DB — the heaviness we refuse. Closest "lite+comprehensive" peer = **LlamaIndex `Memory`/MemoryBlocks** (SQLite-backed). 10 refusals = the lite line.

---

## The bareagent/bareguard lift (ce-prd §10, file:line-grounded — read-only survey)

**Port & adapt (small deterministic primitives → litectx's own impl, standalone):**
- bareguard `Gate#check(action)→Decision{outcome,severity,rule,reason}` (`bareguard/src/gate.js:215`, `types.js:40`); action = open `{type,...}` dict (`types.js:24`) → `{type:"memory.write"}` is first-class, **zero bareguard change**.
- **Floor supremacy = the fixed 6-step eval order** (`gate.js:139-175`; `bareguard.context.md:202-216`): denies/asks (1–4) run **before** allowlist (5) → a write can't relax the floor even if allowlisted. Copy/adapt the pattern.
- **Audit + redact** (`primitives/audit.js:79`, `secrets.js:22`) → litectx's own small audit log standalone.
- bareagent **`Store` interface `{store,search,get,delete}`** (`bareagent/types/index.d.ts:58`) → litectx ships an adapter matching the shape (no import).

**Cede (stays in baresuite; litectx only persists state it reads):**
- bareagent **`Loop.run`** (`src/loop.js:212`) never auto-reads memory (`store` is validate-only, `:451`) → litectx inserts **around** the loop (`assemble→run→harvest result.msgs→persist`), **zero loop changes**.
- **Sub-agent spawn** (`tools/spawn.js:74` lib / `:229` blocking tool; child = a bareagent CLI) — no scoped context today; litectx supplies each child a scoped store via config.
- bareagent `StateMachine` (`state.js:23`, per-task FSM) + `Checkpoint` (`checkpoint.js:16`, human-approval gate) — keep bareagent's; not litectx overlaps. `Memory` (`src/memory.js:20`) = **replace** for long-running.
- **R-G7 eviction = unclaimed** in bareagent → litectx owns it outright.

**Separate opt-in guardrails tier (neither litectx nor bareguard core):** the **content injection/credibility *judgment*** (is this an injection? semantic conflict?). bareguard **refuses content judgment** by thesis (`bareguard.context.md:313`). litectx stores the **verdict label** only.

**The test:** small deterministic data/decision primitive needed standalone → **port & adapt**. Runtime loop/orchestration or content judgment → **cede / seam**.

---

## PREP-WORK WALKTHROUGH (IN PROGRESS — resume here)

User asked for prep we can do while core memory is finished. Walking through 4 items **one at a time, plain terms (problem + proposal)**; user gives the memory-side decision, then we lock. State:

- **#1 CE eval harness — ✅ LOCKED.** A **"CE walking-skeleton test"**: one 4-step flow (WRITE store known nodes incl. a stale v1 + a poisoned one → SELECT recall the right subset → COMPRESS fit a budget / drop stale+poisoned → ISOLATE scope, no cross-session bleed → out: assembled, cache-ordered context), **asserting at each boundary**. Lives **in the repo**, **hold-or-beat on every change** — the CE counterpart of memory's `poc/bench-lib.mjs` gate. Per-primitive micro-checks (supersession, pruning) hang off it. Writing the scenario now **pins the `assemble()` contract** before building. Won't *run* until the memory pieces exist.
- **#2 Schema forward-compat — ✅ LOCKED.** Rule: *nullable column on an existing growing table → reserve now (cheap now, expensive to backfill later); new standalone table → defer (cheap anytime).*
  - **Reserve now** (nullable cols on nodes): **`scope`** (agent/room/owner; the isolation key) + **`source`** (provenance — where a fact came from; a label ON the item, not an event log).
  - **Additive-later, confirmed-needed (= R-W3 session/state table):** {agent name → `scope`; **`step`** (N of M); **prev-context as a reference/handle**, NOT raw blob; **outcome as a compacted artifact** (the `progress.md`); **`validation` label** pass/fail}. = the frequent-intentional-compaction pattern.
  - **Boundary (user-confirmed):** validation/injection-guard + the loop/repeat decision = **harness/bareguard**, NOT litectx. litectx **stores** the validation label; harness **computes** it. Don't store full prev-context/outcome text — store the compacted artifact + a handle (restorable compression).
- **#3 Aurora CE-primitive survey — ⏳ IN PROGRESS (just presented, awaiting user's memory-side input).** Read-only mine of aurora's **left-behind layers** (`soar`/`reasoning`/`spawner`/`cli`) for CE-primitive precedent (context assembly/budgeting, summarization/compaction, session/state/progress, supersession, eviction, provenance, scope) → extend `docs/02-engineering/aurora-borrow-ledger.md` with **carry vs correct/drop + file:line**. Honest: **thin yield expected** (CE bits mostly sit in the orchestration layers we're ceding). Lowest-effort/lowest-yield of the four; do after #4.
- **#4 Copy-pattern API studies — ⬜ NOT STARTED.** Focused API write-ups of the net-new patterns we'll *adapt*: **LlamaIndex `ChatSummaryMemoryBuffer`** (running-summary scaffold), **ADK handle pattern**, **Manus restorable compression** — reference notes for the eventual slices.

> **Important:** these four are PREP/DESIGN to be *produced when chosen* — none have been built yet. #1 and #2 are *decided*, not *written*. The eval-harness scenario + schema note are the natural first deliverables once memory matures (or sooner, since they're design-only).

---

## Next action

Resume the prep-walkthrough: take the user's memory-side input on **#3 (aurora survey)**, then explain **#4 (copy-pattern API studies)**, and let them pick which prep items to actually produce. Nothing here starts until *"core memory is right"* — but the **eval-harness scenario (#1)** and **schema note (#2)** are design-only and can be written anytime.

## Key files (this session)
- `docs/00-context/{README.md, ctx-ifra.md, ce-tree.md, ce-flow.md}`
- `docs/01-product/litectx-ce-prd.md` (new) · `litectx-memory-prd.md` (renamed) · `barecontext-prd.md` (superseded banner)
- Memory: `litectx-absorbs-all-ce-primitives.md`, `ce-tree-and-skill-map-project.md`, `MEMORY.md` (index). Related (added externally): `borrow-aurora-dont-restart.md`.
