# Stash — litectx: CE-primitive audit + Isolate scope-model SPEC (no code) + SELECT POC hardened (2026-06-13, session 6)

- **Date:** 2026-06-13. Continues from `2026-06-13-assemble-select-poc-FAILED-pathfetch-verdict.md` (session 5, the SELECT-POC failure) — **read that first**; this session is the design round on top of it.
- **Repo:** `/home/hamr/PycharmProjects/litectx` (`~/Documents/PycharmProjects` = same tree via symlink). Branch `main`.
- **HEAD:** `6bd4578`. **NOT pushed** — `origin/main` still `b0d92ed`, 4 commits ahead. **v0.10.0 never tagged, never published** (`npm` = 0.9.0; `package.json` = 0.10.0; `assemble` FIT + this round sit in Unreleased on top). Deliberate pending decision, not an oversight.
- **Working tree (UNCOMMITTED — this session's deliverables):**
  - `docs/02-engineering/bare-suite-buildable-now.md` (modified) — **the main output: new §4** (scope-model spec + audit), plus §0 records the SELECT kill, §2④ points to §4.4.
  - `poc/assemble-select-poc.mjs` (untracked) — **hardened this session** beyond session 5: `QUERY_MODE` ablation (`min`/`rich`/`upper`) + embeddings-live verification + data-derived honest verdict (was the lenient file-level PASS).
  - `poc/RESULTS.md` (modified) — SELECT entry + the two rigor-check paragraphs (embeddings verified live; query-recipe ablation).
- **Gates:** no `src/` or `test/` touched → the 209-test suite / typecheck / build:types are **unaffected** (this round is design + a throwaway POC only). Nothing to re-run.

---

## The arc this session — a design round (NO build), gated behind POCs

Opened on the user's challenge: *"if the SELECT POC isn't sure to pass, what's stopping you from running it?"* Answer given: nothing — the role-boundary decision blocks **shipping** SELECT, not the **POC** (a POC is throwaway, role=placeholder, never touches bareagent's grammar). Ran it. Then the user pushed the framing wide open ("why push code they didn't ask for? did they complain? why can't the agent fetch its own code?") — which collapsed proactive SELECT entirely and turned into a full CE-primitive audit + the Isolate scope-model design.

### 1. SELECT-as-proactive-inject — KILLED (evidence + first principles)
- **POC hardened (vs session 5):** verified **embeddings tier is live** (74 stored vectors, reranks NL queries — so "ON ≡ OFF" is real BM25-gating, not a dead tier — closed a self-gloss); **query-recipe ablation** `min`/`rich`/`upper` → chunk-level re-supply flat **~21–25%**, **0% ex-dominant-repo** (mailproof carries the average). So the negative verdict is robust, not a weak-recipe artifact.
- **First principles (the user's argument, now doctrine):** agents already fetch their own code (`recall`/`get`/`impact` shipped + live); **no demonstrated demand** (FIT fixed a *proven* 8/8-vs-0/8 failure, SELECT fixes none); 25%-precise injection = ~75% noise displacing real content in a fixed budget → **`assemble` becoming context-rot of its own**.
- **Consequences:** "re-supply the file I'm editing" = **direct path fetch** (`get`/`impact` by path), not recall · recall-SELECT's only un-refuted value = the **never-read related file** (explicit agent query, UNTESTED, hard to POC) · the bareagent **role decision is downstream** — moot until an injection mode ships, don't spend it.

### 2. The four CE primitives — value vs bloat (lens: *no proactive help the agent didn't ask for*)
- **Write = VALUE, settled.** HITL human-authored facts/instructions + ranked memory IS the demand (withdrew my earlier "is there demand?" doubt). litectx stores/retrieves; the *decision to write* is the agent's/harness's (ceded).
- **Select = reactive only.** `recall` on request (shipped); proactive inject killed.
- **Compress = FIT (shipped) + ONE new buildable** (§3 below).
- **Isolate = the scope model** (§4 below).
- The keep-column collapses to one thing: **a searchable store the agent queries on demand → best-ranked, budget-fitted answer.** Everything else is agent-policy or harness-runtime.

### 3. Compress — middle-band down-tiering (the one new buildable, POC-gated)
Grounded in `ctx-ifra.md`: **lost-in-the-middle** (line 46), **stable-top/recent-bottom** (152/217), **LLM-free trim** (99). Compose → **pin head verbatim · keep tail verbatim · down-tier the MIDDLE valley** (signature via shipped `compress()`, or drop-with-handle R-C4). Positional, deterministic, no LLM. Slots into FIT (head-pin + tail-recency already exist). Note: `peek` already renders **head+tail**.

### 4. The Isolate scope model — SPEC (the centerpiece; in §4.4 of bare-suite-buildable-now.md)
**`worktree` + `session` + `owner`.** Settled via 3-stream web research on the leaders.
- **Two layers kept separate:** workspace → `worktree` (ephemeral, filesystem); memory → stable ids, NEVER the workspace.
- **`worktree`** = MANDATORY for any code work (sandbox-by-default — never predict "will it diverge"). One branch per worktree (git-enforced); torn down at resolution; orchestrator provides it; litectx never keys memory on it.
- **`session`** = universal, harness-supplied; isolates volatile `stash`/`episode` between concurrent runs; the ONLY key that separates same-branch/same-owner agents ("two reviewers of one checkout").
- **`owner`** = scopes/shares durable `fact`s; fallback `git user.email` → config → **OS username** → default.
- **`branch`** = metadata / GC tag only (mutable; fails same-branch case).
- **DB keyed to repo identity** (remote URL / shared `.git`), NEVER the worktree path — else memory dies on teardown (claude-code#15776).
- **Kind defaults:** code/doc → per-worktree FS index (not in shared db) · `stash` (parked agent-context, R-C4/R-I3) → `session` · `episode` → `session` (+owner/branch tags) · `fact` → `owner` or global.
- **Two-layer memory + promotion bridge:** local/ephemeral (`stash`,`episode` by session) + global/durable (`fact` by owner). Bridge = **promotion ladder** (reuses shipped `promotionCandidates`, slice 5b): `episode` used **>5×** → candidate → **HITL** decides `fact` + local(owner)/global(shared). Scope assigned at promotion, by a human — agents never self-author global facts.
- **No-repo / non-git automation:** drop `worktree`/`branch`; core = `session` + `owner`=OS username; workspace un-sandboxed (or temp-dir/container); facts still durable per owner.
- **GC + worktree lifecycle:** resolution = merge-all (complementary) OR pick-one (bake-off) → `git worktree remove` = GC trigger (session episodes/stash retire; promoted facts survive). R-G7, author-controlled.
- **Impl sketch:** two nullable columns `owner`/`session` + kind-aware default + `WHERE (owner IS NULL OR owner=:me) AND (session IS NULL OR session=:sid)`.
- **Research grounding:** LangGraph `thread_id`+Store(user_id) · ADK session/`user:`/`app:`/`temp:` · Letta shared-blocks-by-attach · Memary per-agent graph · Anthropic ephemeral sub-agents+summary · claude-code#15776 (don't key memory to worktree path) · container-use (branch+git-notes). Net: session+user durable, worktree ephemeral & separate.

---

## NEXT (open) — all POC-GATED before any code (prove-don't-assert; this round is design only)
1. **Scope POC — is `session` load-bearing?** litectx recall is **relevance-ranked**, so off-session episodes may just *sink*. Replay multi-session episode streams, recall **with vs without** other sessions' episodes, measure if top results change. No change → the column is **bloat**; change → build the `owner`+`session` model. **Do not write the column before this.**
2. **Compress middle-tier POC** — down-tier the U-curve middle vs **drop** vs **keep-verbatim** on real transcripts; task success preserved?
3. **(Deferred) never-read explicit-query SELECT** — only if revisited; ground-truth proxy (agent's later Read of a graph-adjacent file, gated by impact edge) is methodologically risky — pressure-test before any build.
- **Unchanged, user's call:** tag/publish v0.10.0 (npm 0.9.0, package.json 0.10.0; assemble FIT + this round Unreleased on top).

## Durable rules reinforced
- **[[prove-dont-assert]]** — every SELECT-POC "0%" this session was a measurement bug found by re-running (empty-db constructor trap, absolute-vs-relative path, cache reuse); the embeddings "ON≡OFF" was a self-gloss closed by *verifying the tier was live*.
- **No proactive help the agent didn't ask for** — the lens that killed SELECT and sorted all four primitives; reactive-store-queried-on-demand is litectx's honest identity.
- Design rounds still gate on POCs: the scope model is coherent + research-grounded but **not built** — `session` isolation must be shown load-bearing first (don't repeat SELECT's build-on-assumption risk).
- litectx owns content/relevance + the substrate; workspace isolation (worktree) and orchestration are the harness's. See [[bareagent-rt-seam-contract]].
