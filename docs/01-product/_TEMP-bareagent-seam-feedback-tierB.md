# _TEMP — bareagent feedback on Tier-B asks (specs needed to build)

**Status:** working scratch, not a PRD. Captured 2026-06-14 from bareagent's reply to the §5C asks.
Fold the resolved contracts into the real docs, then delete this file. Lane note: litectx-side
contracts → `baresuite-litectx-prd.md §5C`; bareagent-side commitments → bareagent's
`docs/01-product/prd.md §23`.

## Verdict up front
Of the five asks, only **one needs a real bareagent build-spec (R-C6)**, and it's tiny.
One is **data-blocked (R-S6)**. Three are **subsumed / litectx's to own (R-W3, R-C3/C5, R-W4)**.

| Ask | Disposition | Net |
|-----|-------------|-----|
| R-W3 session/state | Subsumed — litectx owns schema/view/lifecycle; bareagent owns carrier + durability substrate | No bareagent build (maybe a thin rehydrate helper, only on real need) |
| R-C6 summaryWindow | **The one genuinely-new bareagent seam** — a provider-bound `summarize()` | Small build: one bound function |
| R-S6 selectTools | Data-blocked — ~15-20 native tools, no labeled traces | Park until an adopter has hundreds of MCP tools + mineable traces |
| R-C3 clear / R-C5 trim | Subsumed — view-level fitting suffices; destructive transcript mutation forbidden | No build |
| R-W4 note store | Subsumed by Memory (`remember(kind:"episode")`) | No build |

---

## R-W3 session/state — no schema to hand over (and shouldn't be)
- `loop.js`: `const ctx = options.ctx || null;` — per-run **opaque blob** forwarded by-reference,
  unmodified, to assemble/policy/onLlmResult/onToolResult. bareagent never reads/writes a field on it.
  litectx already reads `ctx.task` / `ctx.budget` **by convention**, not because bareagent defines them.
- (a) **schema** — litectx owns it. Put it on `ctx.session` (or wherever). bareagent's only written
  guarantee: `ctx` is forwarded by-reference, unmodified, to every seam for the life of `run()`.
- (b) **per-field LLM-visible vs isolated (R-I2)** — already solved. A field is LLM-visible iff litectx
  emits a unit for it in `assemble(units, ctx)`; isolated iff litectx holds it in `ctx` and never emits.
  "Isolate a field" = "don't `toUnits` it." You need bareagent to *not* know your fields — today's state.
- (c) **lifecycle** — caller's choice. One `run()` = one invocation; `ctx` lives as long as the caller's
  reference. Same object across runs → spans runs. Fresh per run → 1:1.
- (d) **durability** — in-memory `ctx` dies with the process; bareagent won't auto-persist (it can't
  serialize a shape it refuses to know). For restart survival: serialize session into Memory (SQLite
  FTS5 or JsonFileStore) keyed by session-id, rehydrate into `ctx` next `run()`. Substrate ships today.
- (e) **concurrency** — last-write-wins, single-writer per run (loop is single-threaded within a run).
  No versioning; bareagent pushes back on building checkpoints until a real concurrent-writer exists.
- **Net:** bareagent contributes the carrier (`ctx`, opaque, forwarded) + durability substrate (Memory).
  Schema, view-policy, lifecycle are litectx's. Possible thin `rehydrate/persist` helper — only on real need.

## R-C6 summaryWindow — the one genuinely-new bareagent seam (small)
- Wrinkle is the whole spec: `assemble` does **not** call the provider (loop.js:263-274 is msgs → view,
  no model round). Summarization needs a model call; litectx never calls a model on this path.
- **Cleanest wiring:** bareagent injects a provider-bound `summarize(messages) => Promise<string>` into
  the assemble path (on `ctx`, or as 3rd arg). litectx calls it inside its own assemble, owns
  trigger + N + splice, returns the view. Entire new surface = **one bound function**.
- **Splice already solved** — it's COMPRESS: litectx rewrites a unit's `content` to the summary, and
  `fromUnits` already reconstructs content-rewritten units (context-units.js:174-195). So *don't* return
  `{keep, toSummarize}` for bareagent to splice — summarize, rewrite the unit's content, existing
  compress round-trip carries it. Only missing piece = the model call.
- (a) **trigger** — litectx owns it. Recommend token threshold against `ctx.budget` (roll a summary when
  projected window exceeds budget), not a fixed turn count — budget is the natural signal, one source of truth.
- (b) **N** — litectx owns it; bareagent has no opinion. Pinned units (system + first user turn) never
  drop and shouldn't summarize — free.
- (c) **seam confirmation** — Confirmed: litectx never calls its own model; bareagent owns the model
  invocation (it owns the provider) via bound `summarize()`; litectx owns trigger/N and splices via compress.
- **OPEN DECISION (blocks bareagent spec):** confirm the **`summarize()`-on-ctx** shape (vs.
  return-`{keep, toSummarize}`-and-bareagent-splices). On confirm, bareagent specs the signature into prd.md §23.

## R-S6 selectTools — data-blocked (can give (a), not (b)/(c))
- (a) **tool-def format** — confirmed from tools/shell.js:295+: OpenAI function format
  `{ name, description, parameters: { type:'object', properties:{...}, required:[...] } }`.
- (b) **corpus** — small: native = ShellTools (shell_read/grep/run/exec), BrowsingTools, MobileTools,
  spawn, defer, MCP meta-tools (mcp_discover, mcp_invoke) — ~15-20. MCP-discovered tools inflate at
  runtime per deployment. Native count alone won't move a RAG-over-tools bench.
- (c) **(intent → tools-used) traces** — none shipped. Raw material = JSONL run logs
  (transport-jsonl.js); no curated corpus.
- **Recommendation:** don't build until a real adopter has hundreds of MCP tools + mineable traces.
  At ~15-20 native tools, selection-RAG lift ≈ zero; baseline (send all tools) wins on simplicity.
  Data-blocked, not design-blocked — park it. (Same prove-don't-assert gate that already falsified
  recall-rerank-for-tools topic-blind.)

## R-C3 clear / R-C5 trim — subsumed; destructive mutation architecturally forbidden
- View-level fitting suffices and is required. assemble returns a **view**; canonical transcript never
  mutated (loop.js:257-259; `dropped[]` units stay restorable by id). FIT + COMPRESS elide per-call.
- Destructive mutation would break the fail-open invariant: if assembly throws, the loop degrades to
  full context — only sound if full context still exists.
- **No build.** If litectx deems a result "spent," drop it from the *view* every call — cheap,
  idempotent, restorable. bareagent will not add destructive clearing to the loop.
- **Don't conflate:** unbounded in-memory transcript growth over a long run = a transcript-spooling/
  eviction concern in bareagent's transcript layer — separate feature, separate lane, not clear/trim.

## R-W4 note store — subsumed by Memory; no distinct primitive
- Memory is already append-capable, searchable, durable (memory.js; store-jsonfile.js:57-59 pushes
  `{id, content, metadata, createdAt}`). `remember(kind:"episode")` → `Memory.store(content,
  { kind:'episode' })`; free-form metadata carries the tag. Survives compaction (lives outside
  transcript/ctx). Backends: SQLite FTS5 or zero-dep JSON file.
- **No build.** Notes = Memory.store entries with a kind tag.
- Nuance: Memory exposes `delete`, so not enforced append-only. For a hard guarantee, just don't call
  `delete` (or back with an append-only store). Not worth a new primitive.

---

## Folding plan (lanes)
- **litectx doc — `baresuite-litectx-prd.md §5C`:** the resolved litectx-side contracts (R-W3 schema on
  `ctx.session`; R-C6 trigger/N/splice ownership; R-C3/C5 view-level drop; R-W4 = Memory + kind tag).
- **bareagent doc — `prd.md §23`:** three bareagent-side commitments —
  1. `ctx` forwarded by-ref, unmodified (R-W3 carrier guarantee),
  2. provider-bound `summarize()` seam (R-C6) — **only actual new API**,
  3. explicit non-goal: transcript never destructively mutated; clear/trim is view-level (R-C3/C5).

## Open items blocking spec
- [x] **CONFIRMED 2026-06-14 — `summarize()`-on-ctx shape** (litectx drives trigger/N/splice; bareagent
  lends only the provider-bound `summarize(messages) => Promise<string>` on `ctx`). Chosen over
  return-`{keep, toSummarize}` because it keeps litectx owning the windowing policy and reuses the
  shipped COMPRESS splice. **This is not a new design — it's the R-C6 split the CE-PRD already made**
  (`litectx-ce-prd.md:678` "litectx ships the deterministic scaffold … the LLM summarization call is
  CEDE/opt-in tier"; `:679` "the summarizer is harness; litectx supplies the ranking/selection").
  **Caveat held to bareagent:** summarized turns MUST stay **restorable by id** — the splice is the
  shipped restorable COMPRESS path (rewrite unit `content`, body recoverable), NOT a destructive
  overwrite (Arize: LLM-summary-as-default failed → keep handles to summarized turns;
  `litectx-ce-prd.md:678`). Consistent with bareagent's own R-C3/C5 non-goal (no destructive transcript
  mutation). → bareagent unblocked to spec the §23 `summarize()` signature.
- [ ] Decide whether to fold these into §5C now (bareagent offered to draft §23).

> Note: head+tail = **R-I3 `peek`** (handle/lazy-load preview of one stored blob; `litectx-ce-prd.md:148`),
> NOT the summarizer. R-C6 summary shape = **last-N verbatim + rolling summary of older** (`:134`).
> compress = **R-C7 rank-tiered render** (`:135`). Three distinct primitives — don't conflate.
