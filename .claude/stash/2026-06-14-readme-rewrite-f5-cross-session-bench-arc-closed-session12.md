# Session 12 — README rewrite · F5 cross-session memory · bench arc CLOSED

**Date:** 2026-06-14
**Branch:** main (pushed; `origin/main == local main`)
**Continues from:** `2026-06-14-live-ab-investigation-recall-finds-not-executes-session10.md`
(the in-run A/B arc; that session ended recommending we reposition the pitch around persistence +
safety and, optionally, run the F5 cross-session test).

---

## TL;DR of what shipped this session

1. **README fully rewritten** to the bareagent skeleton + CE-forward framing (committed `0.14.1`).
2. **Logo simplified** to a CE wordmark: `write · select · compress · isolate`.
3. **F5 cross-session memory test RUN** (the last un-run finding) → **qualified win: shortlist yes,
   top-1 no.**
4. **Two durable VALUE gates built + CI-wired:** `bench:assemble` + `bench:summary`; `bench:all` added.
5. **Bench arc declared CLOSED;** `realwork-bench` stays unbuilt (F1); **Part B parked.**
6. All propagated to CHANGELOG / PRD §11.3 / README; context.md deliberately unchanged.

---

## Commit trail (this session, all on main, pushed)

- `7748d97` poc(f5): cross-session memory — qualified win (shortlist yes, top-1 no)
- `6d873d9` docs(readme): sharpen cross-session-memory claim to shortlist-grade (F5)
- `dacaad7` bench(assemble,summary): durable VALUE gates for the two CE read-path verbs (A2b)
- `54c58fe` ci+bench: gate the pure CE-verb benches in CI; add bench:all; park Part B
- `7660c95` docs: propagate the closed bench arc (changelog, PRD §11.3, README)
- (`0eea71b` release(0.14.1) + `eed51b5`/`0a8eea7` contextgraph example — **user's**, not mine)
- Earlier README/CHANGELOG/benches-A2b commits folded into the `0.14.1` release by the user.

---

## F5 — the headline finding (cross-session memory)

**POC:** `poc/cross-session-memory-poc.mjs` (a `*-poc.mjs` spike, NOT a gate — evidence).
**Design (built to FAIL, per [[prove-dont-assert]]):**
- Corpus = **14 real decisions harvested verbatim** from litectx's own memory log (uncrafted).
- 10 fresh-session **paraphrase** queries with an **asserted zero-keyword-overlap audit** (it caught
  2 leaks — `correct`, `items` — and aborted until fixed; that's the falsifiability guard working).
- **Near-neighbour decoys packed on purpose** (3 "a ranking signal was falsified → ships surfaced,
  not scored" siblings + generic infra decisions) so a vague paraphrase can land on the wrong one.
- ON = litectx semantic recall; OFF = BM25-only (the "structurally cannot" arm).

**Result:**
| Arm | P@1 | P@3 | P@5 | MRR |
|---|---|---|---|---|
| OFF (BM25) | 0% | 10% | 20% | 0.070 |
| ON (semantic) | **0%** | **40%** | **70%** | **0.268** |

**Two findings, opposite signs:**
- **Strong claim FALSIFIED** — semantic recall NEVER ranks the exact decision #1; near-neighbour
  siblings win the top slot on *genuine* proximity (verified not an artifact: `trust-not-scored`
  absorbs the "should signal X affect ordering" queries; `storage` literally names "vector tier" so
  it legitimately pulls the embeddings query). **Top-1 degrades when decisions cluster — real logs
  cluster.**
- **Realistic claim HOLDS** — at top-5 (what an agent reads from a ranked recall) it's a big
  OFF-impossible win (OFF at chance, 7/10 pure misses); lift = the slice-11 cosine-nomination path,
  corroborating `memory-bench` (para 0→0.574) on real decisions under adversarial decoys.

**Net:** same through-line as F4/F6 — **litectx SURFACES and NARROWS, never hands back one perfect
answer.** Honest scope: "the right past decision lands in the agent's top-5 where lexical is blind,"
provided the host reads the shortlist not just hit #1. Caveat: n=10 directional; default MiniLM
(jina-code swap is [[jina-code-off-the-table]]; the clustering ceiling is structural, not just
model-limited). Recorded in benches-prd §F5; memory [[litectx-lift-is-narrow-ab-results]] updated.

---

## The two new benches (built, mutation-verified, CI-gated)

Both follow the memory-bench floor/expected/exitCode discipline; both import the **shipped**
`assemble`/`summaryWindow` (grounded, not POC reimpl); both **pure/deterministic/offline/free**.

- **`poc/assemble-bench.mjs`** (`npm run bench:assemble`) — VALUE = the COMPRESS tier RESCUES a needed
  code unit FIT would drop. Result: needle retained **1/1** (`compressed:true`) vs FIT-only **0/1**;
  + structural invariants (pinned/atomic/no-silent-loss/no-overflow/order).
- **`poc/summarywindow-bench.mjs`** (`npm run bench:summary`) — VALUE = rolling summary retains
  dropped-turn decisions via a **stub extractive summarizer**. Result: **3/3** vs plain FIT **0/3**;
  + fold→"summarized"/restorable/never-overflow/fallback contract.
- **`bench:all`** = `bench && bench:impact && bench:memory && bench:assemble && bench:summary`
  (corpus benches skip-never-fail when absent). Validated exit 0 locally, full suite green.

**CI:** `.github/workflows/ci.yml` now runs `bench:assemble` + `bench:summary` after `npm test`
(pure → CI-capable). Corpus benches (recall/impact/memory) stay LOCAL pre-push gates.

**Validation discipline applied this session (after the user asked "did you ground/validate?"):**
- Ran full `npm test` (235 pass / 0 fail / 1 skip).
- **Mutation-tested both gates against shipped src:** broke summaryWindow splice → `bench:summary`
  exit 1; disabled assemble COMPRESS rescue → `bench:assemble` exit 1; `git checkout` reverted clean,
  both back to exit 0. (Earlier I'd mis-measured a pipe `$?` reading `tail` not `node` — corrected.)
  Lesson reinforced: a gate that can't go RED is worthless; PROVE it, don't assert it.

---

## Bench-suite state (the "are we done?" answer = YES)

Durable gates (6): `bench` (recall), `bench:impact` (SAFETY=0), `bench:memory`, `access-bench`
(manual), `bench:assemble`, `bench:summary`. Plus `bench:ablation` + `binding-bench` (research/settled).

**Every shipped primitive gated or covered:** recall/impact/memory (benches), compress (unit tests +
exercised in assemble-bench), assemble/summaryWindow (new benches), stash/peek/evict (unit tests),
write-gate (unit + bareguard seam-contract), graph accessors/liteCtxAsStore (unit/integration tests).

**The SW-Factory → benches shift is complete.** Validation (Part A) fully replaces the factory's
validation role. The one thing benches can't do (live in-run multi-step lift) is an *answered finding*
(F4/F6 narrow), not a gap. `realwork-bench` deliberately unbuilt (F1: redundant). **Part B (fabro-like
factory spike + Pi) PARKED 2026-06-14** — off-roadmap, un-park only as a separately-budgeted personal
spike (benches-prd Part B banner + status line).

---

## Doc propagation (commit 7660c95)

- **CHANGELOG `[Unreleased]`:** F5 result + 2 CE gates in CI + bench:all + framing settled; README
  cross-session sharpen. (The big README rewrite is already in the released `0.14.1` block.)
- **PRD §11.3:** replaced `compress/select/isolate — tbd post-v1` row with shipped assemble +
  summaryWindow gates (run in CI); SELECT POC-killed, isolate=scope filter, compress unit-tested.
- **README Validation:** +2 rows (assemble/summaryWindow); intro distinguishes CI gates vs local
  corpus gates. Cross-session note now "shortlist, not a guaranteed #1 hit."
- **context.md:** UNCHANGED on purpose — memory claim already top-3-framed/honest; F5 corroborated it;
  public API unchanged. (Avoided a speculative edit.)

---

## README shape now (for reference)

bareagent skeleton: CE-wordmark logo → badges → bold pitch ("Every context-engineering primitive…
One production dependency") → "Opinionated and lightweight… scaffolds the rough spots where agents
fail at low processing cost… helps a weaker model search like a strong one without replacing its
reasoning" → Quick start (give AI the context doc + 6 lines) → **What's inside** (5 buckets:
Substrate/Views/Memory/Context verbs/Sockets) → Tiers → Surfaces (CLI/MCP/Claude prehook) → Recipes
(memory socket, assemble) → **Validation** (6-row grounded table + honest "what we don't claim":
edge = durable cross-session memory [shortlist-grade] + impact safety, NOT in-run navigation) →
Where litectx fits (vs baresuite) → Docs → License.

---

## Open / next (nothing required)

- Bench arc is CLOSED. No uncovered primitive. Building more gates = fishing (F4 warning).
- **User's WIP, untouched by me:** `examples/contextgraph/*` (observe() live drop-in + W/S/C/I
  coverage tree + interactive viewer; their commits eed51b5 / 0a8eea7). Don't commit on their behalf.
- Optional someday: the one genuinely-different test = cross-session memory IN-TASK (stop/resume,
  recall the right past decision among decoys mid-run) — the only regime OFF has no mechanism for.
  Optional, not scheduled.
- Natural next thread is product-side, not more benches. README/pitch is current with the findings.

## Standing doctrine reinforced this session
- [[prove-dont-assert]] — built F5 + both benches to be able to FAIL; mutation-proved the gates.
- [[verify-shipped-against-poc-data]] — benches import shipped verbs; validated before claiming.
- [[litectx-lift-is-narrow-ab-results]] — updated with F5 (the cross-session half).
- [[prefers-discussion-over-multiple-choice]] — led the README + bench-scope decisions with prose.
