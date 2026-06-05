# Recommended Flows (doc #2) — how the leaders flow work

> **What this is.** The **obvious home for recommended flows** — how the platforms that lead
> CE actually move work through context, with **every behavior mapped onto the four primitives
> (Write / Select / Compress / Isolate)**. Companion to the mental-model tree
> ([`ce-tree.md`](ce-tree.md)); both derive from the leaders, not guesses (goal #5).
>
> **Source flows kept intact** in [`ctx-ifra.md`](ctx-ifra.md) (the transcript). The flows
> there — the methodology and the turn pipeline — are mirrored and grounded here so they live
> somewhere obvious. Inline tags (`[Manus]`, `[ADK]`, …) resolve in [`ce-tree.md` §8](ce-tree.md#8-sources-the-leaders).
>
> **Marks** (same legend as the tree): 🧩 litectx CORE · 🔧 litectx BUILD · ⊘ CEDE (harness).

---

## 1. The one cross-vendor consensus — KV-cache ordering

The single claim **two independent leaders state the same way** — so it's the most reliable
flow rule in the field:

> **Stable content first, dynamic content appended last. Make context append-only. Keep
> serialization deterministic.**

- **Manus** [Manus]: *"the KV-cache hit rate is the single most important metric for a
  production-stage AI agent."* Cached vs uncached input on Claude Sonnet = **$0.30 vs $3.00 /MTok — a 10× difference**; agent input:output skew ≈ **100:1**. *"Even a single-token
  difference can invalidate the cache from that token onward"* (their named anti-pattern: a
  per-second timestamp at the top of the system prompt). JSON key ordering is a silent
  cache-breaker.
- **Google ADK** [ADK]: split the window into **stable prefixes** (instructions, identity,
  long-lived summaries) and **variable suffixes** (latest turn, new tool outputs); a `static
  instruction` primitive *"guarantees immutability for system prompts, ensuring the cache
  prefix remains valid."*

**Mapped to primitives:** this is a **Compress + Write ordering discipline**. **litectx
role:** 🔧 **BUILD** — when litectx *assembles* a context payload, emit it in **cache-stable
order** (static memory/rules first, freshly-selected nodes last) and **deterministic
serialization**. The *inference call* itself is ⊘ CEDE.

---

## 2. The standard agent-turn pipeline (reframed honestly)

The video's **COLLECT → SELECT → COMPRESS → ORDER → ASSEMBLE** is a **synthesis** — no single
source states it verbatim (§7 #9). But it's a *useful* synthesis, and **Google ADK is a real
instance** of it: context is *"a compiled view over a richer stateful system"* built by
**named, ordered processors** (`basic` → `instructions` → `identity` → `contents` → … →
`code_execution`). Each stage maps to a primitive:

| Stage | What happens | Primitive | litectx |
|---|---|---|---|
| **COLLECT** | gather user input, history, tool results, RAG, state | (Write read-back) | 🧩 store provides it |
| **SELECT** | score & filter what's relevant for the step + budget | **Select** | 🧩 recall / 🔧 budgeted select |
| **COMPRESS** | summarize / trim / restructure to cut tokens | **Compress** | 🔧 token-budgeted assembly, trim, clear |
| **ORDER** | arrange for KV-cache reuse (stable first) | **Compress/Write** (§1) | 🔧 cache-stable emit |
| **ASSEMBLE** | build the final structured payload, fire the call | — | ⊘ harness fires the call |

> **Takeaway for litectx:** litectx owns **COLLECT→SELECT→COMPRESS→ORDER** as a *deterministic
> assembly* the harness calls; **ASSEMBLE/fire** is the harness's.

---

## 3. Platform-by-platform — each mapped to the four primitives

### 3.1 Claude Code / Anthropic — *"do the simplest thing that works"*
- **Philosophy:** code-centric, text-driven, hybrid retrieval.
- **Flow:** frontload `CLAUDE.md` for cache stability (**Write/Select**); **glob/grep
  just-in-time** navigation instead of pre-indexing (**Select**); **auto-compaction** near
  the limit, preserving architectural decisions/bugs + the **5 most-recent files**
  (**Compress**); spawn clean **sub-agents** for heavy tasks, returning 1–2k-token summaries
  (**Isolate**). [A]
- **litectx:** 🧩 it's the *pre-indexing* alternative Claude Code skips — litectx offers a
  persistent ranked graph so a long-running agent needn't re-grep every session. 🔧 budgeted
  compress; ⊘ sub-agent spawning.

### 3.2 Manus — infrastructure-heavy, cost/latency-optimized
- **Philosophy:** *"be the boat, not the pillar"* — bet on in-context learning over the model.
- **Flows (each a named technique):**
  - **KV-cache discipline** (§1) — **Compress/ordering**. [Manus]
  - **"Mask, don't remove"** — never add/remove tools mid-run (breaks the cache + confuses on
    prior references); instead **mask token logits via response prefill** (Auto / Required /
    Specified), leaning on tool-name prefixes (`browser_`, `shell_`) to mask whole groups
    cheaply. **Select**, done at the **inference runtime** → ⊘ CEDE. [Manus]
  - **File system as externalized context** — *"unlimited, persistent, directly operable…
    structured, externalized memory."* Defining property = **restorable compression**: *"drop
    a web page's content as long as the URL is preserved"* (any irreversible compression is
    risky). **Write + Compress.** → 🔧 **BUILD** the restorable pattern (store node, keep a
    cheap handle/URI, drop the payload) — this is litectx's tool-result-clearing done right.
  - **Recitation (`todo.md`)** — constantly rewrite the to-do list into the *end* of context to
    fight lost-in-the-middle (≈50 tool calls/task). **Write + (anti-)Compress.** → 🔧 store +
    serve the recited artifact.
  - **Keep errors in context** — *"leave the wrong turns in"*; recovery is real agentic
    behavior. A deliberate **anti-Compress** policy → ⊘ agent-loop policy.

### 3.3 Google ADK — *"context is a compiled view"* (compiler metaphor)
- **Philosophy:** principled software architecture; *"context engineering… starts looking like
  systems engineering."*
- **The three principles (verbatim) [ADK]:**
  1. **Separate storage from presentation** — durable Sessions vs per-call working context;
     evolve schemas & prompt formats independently. → 🧩 mirrors litectx's "graph is the
     substrate, recall/impact are views."
  2. **Explicit transformations** — context built by **named, ordered processors**, not ad-hoc
     string concat → observable, testable. → 🔧 litectx's assembly should be a small ordered,
     testable pipeline, not string-glue.
  3. **Scope by default** — every call/sub-agent sees the **minimum**; agents reach for more
     **explicitly via tools** (the **handle pattern**: see a lightweight name+summary; call
     `LoadArtifactsTool` for the raw data, then offload it). → 🔧 namespacing + handle/lazy-load.
- **Flows:** tiered storage (Working / Session / Memory / Artifacts); **compaction** = async
  LLM summary over a sliding window writing back a "compaction event" (**Compress**, ⊘ LLM
  step); **filtering** = the rule-based sibling (**Compress**, 🔧); `include_contents` knob to
  pass `none`/full history to a callee (**Isolate**). [ADK]
- **Primitive map:** Write = Sessions/Artifacts · Select = `contents` processor + memory
  tools · Compress = compaction/filtering · Isolate = scope-by-default + `include_contents`.

### 3.4 Slack — context as *information architecture*, zero history pass-through
- **Philosophy:** in long-running multi-agent work, replace accumulated chat-log with
  purpose-built, validated, distilled channels. *"We do not pass any message history forward
  between agent invocations"* — the channels **are** online summarization. [Slack]
- **The three channels:**
  - **Director's Journal** — structured working memory (decision/observation/finding/question/
    action/hypothesis, each phase/round/timestamp-tagged); every agent gets it as chronology.
    **Write + Select.** → 🔧 this is litectx's **state object / episodic store** done well.
  - **Critic's Review** — annotated findings with **credibility scores** (0.0–1.0 rubric); the
    Critic inspects cited evidence via tools rather than inlining it. **Compress + Select**;
    *provenance/trust* edge. → 🔧 BUILD (provenance + salience) / the *content-trust judgment*
    leans ⊘ (bareguard-adjacent).
  - **Critic's Timeline** — consolidated chronological findings; *"a hallucination can only
    survive if it is more coherent with the body of evidence than any real observation it
    competes with."* **Compress + supersession.** → 🔧 supersession/freshness is squarely
    litectx (retire stale facts). [Slack]
- **Why it matters to litectx:** Slack is the clearest production proof that **a structured,
  provenance-scored memory graph beats a flat transcript** — the litectx thesis, in the wild.

### 3.5 OpenAI — ChatGPT Agent / Operator (CUA): visual, GUI-first
- **Philosophy:** one model operating any software through the human interface (pixels, mouse,
  keyboard), RL-trained. [OpenAI]
- **Flow:** perception → reasoning → action loop; **screenshots are added to context as visual
  snapshots**; CUA reasons over *"current and past screenshots and actions"* (chain-of-thought
  retains past frames). **Select (visual) + Write (retained frames).** Visual tokens are
  expensive, so retention strategy is RL-learned, not hand-coded.
- **litectx:** ⊘ mostly out of scope (visual/GUI substrate), but the *principle* — retain a
  compact history of prior states — echoes recitation/episodic memory.

### 3.6 Arize / "Alex" — context as a managed budget; validation of the litectx thesis
- **Philosophy:** context strategy, not prompt strategy, decides success — *"remember exactly
  what it needs, safely forget what it doesn't."* [Arize]
- **Instructive negatives:** naive head-only **truncation** broke reasoning (follow-ups looked
  like new chats) — ⊘ anti-pattern; **LLM summarization as default** failed, *"inconsistent…
  no engineering control"* → **validates** deterministic Compress (docstring/signature render);
  the LLM summary stays an opt-in tier (§6).
- **What worked — smart truncation + memory store:** keep **head + tail**, drop the repetitive
  **middle** (esp. long tool results) into a store **with unique IDs**, **never reset the
  system prompt**, pull pieces back via a **retrieval tool**. **Write + Compress (restorable).**
  → 🔧 second witness to Manus's store-node / keep-handle / drop-payload (§3.2); the transcript
  head/tail trim itself is ⊘ harness.
- **Sub-agent isolation:** heavy span data stays in a dedicated sub-agent; only the concise
  result returns to a lightweight main agent. **Isolate.** → ⊘ orchestration; 🔧 per-agent scope.
- **Open challenges they name = litectx's reason to exist:**
  - **No cross-session long-term memory** (*"remember topics across different chat sessions"*).
    → 🧩 **CORE** — the persistent ranked graph *is* this gap.
  - *"Head/tail is an arbitrary heuristic; we want principled budgeting + a direct
    context-quality metric."* → 🧩/🔧 litectx's **ACT-R activation is that metric**, and the
    retrieval-quality signal (NONE/WEAK/GOOD off the activation distribution) is its surfacing.
- **Why it matters to litectx:** a **validation source** — it independently confirms the two
  core bets (persistent cross-session memory; activation as a principled quality metric) and
  the anti-LLM-summarization stance, from a team that hit the wall building *without* them.

---

## 4. The recommended end-to-end flow — Frequent Intentional Compaction (HumanLayer)

The field's most concrete "how to run a long task" flow [HL]. Structure work into phases,
each emitting a compacted artifact; reset the window between phases; stay at **40–60%**
utilization.

```
[Phase 1: Research] ──> research.md  (paths, signatures, gotchas)  ──> CONTEXT RESET
   sub-agents do raw search (ISOLATE)      artifact = WRITE              80%→15% (COMPRESS)
                                                                              │
[Phase 2: Plan] ──────> implementation plan ── HUMAN-IN-THE-LOOP review ◄────┘
   fresh window: research.md + problem only (ISOLATE/SELECT)                  │
                                                                              │
[Phase 3: Execute] ───> follow plan; progress.md tracks done/remaining ◄──────┘
   fresh window: approved plan only (ISOLATE)     progress.md = WRITE
```

- **Result (grounded):** ~35k lines of *changes* into a ~300k-LOC Rust codebase in ~7h, 2 PRs
  (1 merged), est. 3–5 senior-days. (Not "built 35k LOC.") [HL] (§7 #8)
- **litectx role:** 🧩/🔧 **store + serve** `research.md` / `progress.md` and **rank what
  survives a reset** (token-budgeted assembly, §3.3 of the tree). The **phase
  orchestration + the LLM summarizer** are ⊘ CEDE (harness / bareagent).

---

## 5. Recommended-flow cheatsheet — which technique, when (Anthropic's decision matrix)

For long-horizon tasks, Anthropic recommends choosing by task shape [A]:

| If the task is… | Use | Primitive | litectx |
|---|---|---|---|
| extensive back-and-forth, conversational flow | **Compaction** (summarize the trajectory) | Compress | 🔧 budgeted select + ⊘ LLM summary |
| iterative dev with clear milestones | **Note-taking** (`NOTES.md`/`progress.md`) | Write | 🔧 note/state store |
| complex research / parallel exploration | **Multi-agent** (clean sub-agent windows) | Isolate | ⊘ orchestration; 🔧 per-agent scope |

Plus the universal rules: **frontload essentials + JIT the rest** (Select); **stable-first
ordering** (§1); **scope by default / handle pattern** (ADK — Isolate); **restorable
compression** (Manus — keep the handle, drop the payload).

---

## 6. What litectx provides vs cedes across these flows (build-map rollup)

| Flow capability seen across leaders | litectx | Note |
|---|---|---|
| Persistent ranked memory graph (vs re-grep / flat transcript) | 🧩 **CORE** | the litectx thesis (Slack/Claude Code prove the need; Arize names it as their open gap) |
| Cache-stable, deterministic context assembly (ORDER) | 🔧 **BUILD** | §1 cross-vendor rule |
| Authority / precedence ordering (Context-Clash fix) | 🔧 **BUILD** | Breunig clash → CE-PRD R-X4 |
| Token-budgeted selection / tool-result clearing / trim | 🔧 **BUILD** | deterministic Compress |
| Restorable compression (store node, keep handle, drop payload) | 🔧 **BUILD** | Manus file-system pattern; Arize confirms |
| Structured state object + episodic store (Director's Journal) | 🔧 **BUILD** | Slack pattern |
| Provenance + credibility/salience + supersession | 🔧 **BUILD** | Slack Critic; trust-judgment edge → bareguard |
| Namespacing / scope-by-default / handle (lazy-load) | 🔧 **BUILD** | ADK pattern |
| Memory-type-aware retrieval (episodic/semantic/procedural) | 🔧 **BUILD** | LangChain taxonomy |
| Running-summary / auto-compaction *LLM step* | ⊘ **CEDE** | opt-in tier; litectx feeds it |
| Tool masking / KV-cache logit control | ⊘ **CEDE** | inference runtime |
| Sub-agent orchestration / sandboxes / phase control | ⊘ **CEDE** | bareagent / harness |
| Prompt authoring (altitude) / content-trust judgment | ⊘ **CEDE** | user / bareguard |

> The 🔧 + 🧩 rows are the **doc #3 input**: the litectx CE requirement list. The ⊘ rows are
> the non-goals and the bareagent/bareguard hand-offs.
