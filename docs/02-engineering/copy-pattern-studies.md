# Copy-Pattern API Studies (CE prep #4)

**Purpose.** Focused, source-grounded API write-ups of the three net-new CE patterns litectx will
**adapt** (not port) when the Compress/Isolate slices get built. Each study = the real external API
surface + mechanism + **the litectx adaptation delta** (carry / correct / cede), mapped to
`litectx-ce-prd.md` R-* IDs. Companion to the [aurora-borrow-ledger](aurora-borrow-ledger.md) (which
covers the *memory signals* + SOAR/CE borrows); this covers the *external library* patterns.

**Doctrine (same as the ledger).** Borrow the **pattern + the shape**, not the plumbing. Adapt to the
**lite line**: single-file SQLite, **no LLM-on-write/index**, embeddings & any LLM step are opt-in
tiers, one prod dep, standalone (never a runtime dep on baresuite). Marks: 🧩 CORE · 🔧 BUILD · ⊘ CEDE.

**Status.** Design-ahead reference notes — **nothing here is built**; these inform the eventual CE
slices (after core memory graduates, per memory-PRD §11). Web-grounded 2026-06-05 against current
docs; URLs per study. Re-verify before building (APIs drift — two of three sources had caveats).

---

## 1. LlamaIndex `ChatSummaryMemoryBuffer` → **R-C6** (running-summary scaffold)

### The pattern
Keep the most-recent messages **verbatim** up to a token budget; when older messages overflow,
collapse them into a **single LLM-written summary** prepended (as a SYSTEM message) to the live tail.
Each overflow **recomputes** the summary from *prior-summary + newly-overflowed turns*, so context
stays bounded at ~fixed size regardless of conversation length.

### API surface (as found)
- **Import:** `from llama_index.core.memory import ChatSummaryMemoryBuffer` — ⚠️ **DEPRECATED**;
  docstring says *"Please use `llama_index.core.memory.Memory` instead."* The successor `Memory`
  generalizes short-term FIFO + optional long-term **memory blocks** (`StaticMemoryBlock`,
  `FactExtractionMemoryBlock`, `VectorMemoryBlock`, custom `BaseMemoryBlock`).
- **`from_defaults(...)` key params:** `token_limit` (budget kept verbatim), `llm` (writes the
  summary — without it, degrades to a plain truncating buffer), `summarize_prompt`,
  `count_initial_tokens` (count a system prompt against the budget; raises if it alone exceeds
  `token_limit`), `tokenizer_fn`, `chat_store` (default in-memory `SimpleChatStore`).
- **`Memory.from_defaults` priors:** `token_limit=30_000`, `chat_history_token_ratio=0.7` (the
  flush-to-long-term threshold).
- **Mechanism:** lazy — summarization runs only on `get()` (walks newest→oldest, keeps what fits,
  summarizes the rest via `_split_messages_summary_or_full_text` → `_summarize_oldest_chat_history`).
  `get_all()` bypasses it (raw log). Summary emitted with `role=SYSTEM`.
- **Default prompt:** *"…Write a concise summary about the contents of this conversation."*

### litectx adaptation delta
| | verdict |
|---|---|
| **Carry** 🔧 | the **shape**: verbatim-tail + summarized-overflow, token-budget trigger, summary recomputed from prior-summary+overflow, summary surfaced as a stable SYSTEM-role block. `token_limit` / `0.7` ratio = **priors** for `summaryWindow(n)`. |
| **Correct/adapt** | (a) **litectx is not the LLM caller** — it owns the *deterministic* half (`_split` = decide what/when overflows the budget) and **exposes a hook**; the summarizer prose is the opt-in LLM step. R-C6 is exactly `🟡 scaffold 🟢 / ⊘ LLM step`. (b) Carry the **pattern, not the deprecated class** — litectx's `kind`/node model already generalizes past the buffer (cf. the new `Memory` blocks). (c) Persist in **SQLite**, not in-memory `SimpleChatStore`. |
| **The known weakness → litectx's edge** | recompute-each-cycle **erodes detail** (no verbatim retention of summarized turns). litectx mitigates with **restorable compression** (§3): keep a **handle** to each summarized turn so the summary is lossy *by reference, not permanently*. This is a genuine improvement over the LlamaIndex buffer. |
| **Cede** ⊘ | the LLM summarizer call (opt-in tier / harness). |

**Surface:** `summaryWindow(n)` + summarizer hook (R-C6). **Sources:**
`github.com/run-llama/llama_index/.../chat_summary_memory_buffer.py`;
`developers.llamaindex.ai/python/framework/module_guides/deploying/agents/memory/`.
*(Unconfirmed: exact version where deprecation landed; whether a public `aget` exists.)*

---

## 2. Google ADK — artifacts & the handle pattern → **R-I3** (handle/lazy-load) + **R-C4**

### The pattern
Give the model a **lightweight handle** (a stable name, optionally a summary) for any large blob
instead of inlining it. The model reasons over handles and **explicitly fetches the raw payload via
a tool only when needed**, then it can be evicted again. "Scope by default, reach for more
explicitly" — decoupling **storage** (keyed, versioned blob store) from **presentation** (what's in
the window).

### API surface (as found, Python SDK)
- **Artifact = `google.genai.types.Part`** (`inline_data: bytes` + `mime_type`), managed by an
  `ArtifactService`, keyed by **filename** within a **scope**, **auto-versioned 0,1,2… on each save.**
- **`BaseArtifactService`:** `save_artifact(...) -> int` (version), `load_artifact(..., version=None)
  -> Part|None` (None = latest), `list_artifact_keys(...) -> list[str]`, `delete_artifact`,
  `list_versions`. Impls: `InMemoryArtifactService` (test), `GcsArtifactService` (prod); passed to
  `Runner(artifact_service=...)`.
- **Scope by filename prefix:** plain `"report.pdf"` → session-local (app+user+session);
  `"user:profile.png"` → persists across that user's sessions.
- **`LoadArtifactsTool`:** exposes a `load_artifacts(artifact_names=[...])` function to the LLM;
  injects the **names only** into instructions ("You have a list of artifacts: …call
  `load_artifacts` before answering questions about them"); on call, appends each requested payload
  to the request as user content. Raw bytes enter context **only on demand**.
- **`include_contents`** (`LlmAgent`): `'default'` (gets history) vs `'none'` (no prior contents —
  stateless/scoped callee).
- **Context wrappers:** `ToolContext` / `CallbackContext` provide `save_artifact` / `load_artifact` /
  `list_artifacts` with ambient app/user/session injected.

### litectx adaptation delta
| | verdict |
|---|---|
| **Carry** 🔧 | the **storage/presentation split** = R-I3: `peek(id)` returns name+summary (the handle), `load(id)` returns raw, then offload. The keyed blob store = litectx's **node store**. Scope-by-prefix maps onto litectx's reserved **`scope`** column (stash prep #2): session vs `user:`-style cross-session. `include_contents='none'` = **R-I2** state-partitioning / isolate (callee sees the minimum). |
| **Correct/adapt** | (a) ADK exposes a **tool to the LLM** (`LoadArtifactsTool`); litectx ships the **data primitive** (`peek`/`load`) — wiring a load-tool into the agent is **bareagent**. (b) ADK **auto-versions and keeps all** (0,1,2…); litectx's **supersession (R-G5)** *retires* stale — different intent; if we want version history, that's an explicit choice, not the default. (c) Provenance/`source` label (stash prep #2) ≈ ADK `custom_metadata`. |
| **Cede** ⊘ | the `load_artifacts` tool surfaced to the model + the agent-loop decision to call it → bareagent. |

**Surface:** `peek(id)` vs `load(id)` (R-I3), `scope` (R-I1), `state.view(fields)` (R-I2).
**Sources:** `adk.dev/artifacts/`, `adk.dev/agents/llm-agents/`;
`github.com/google/adk-python/.../artifacts/base_artifact_service.py`, `.../tools/load_artifacts_tool.py`.
*(Caveat: `include_contents='none'` has open bugs — adk-python #1124, #3535; treat docs as spec.)*

---

## 3. Manus — restorable compression → **R-C4** (store node, keep handle, drop payload)

### The pattern
When trimming context, **never delete a large payload outright** — replace it with a stable, cheap
**handle** (id / URL / path) that re-materializes the full content on demand. Compression becomes
**lossless-by-reference**, because you can't predict which dropped observation a later step needs.

### Source framing (verbatim, manus.im blog, Jul 2025)
- *"Our compression strategies are always designed to be **restorable**. … the content of a web page
  can be dropped from the context as long as the **URL is preserved**, and a document's contents can
  be omitted if its **path remains available** in the sandbox."* → *"shrink context length without
  permanently losing information."*
- File-system-as-context: *"unlimited in size, persistent by nature, and directly operable by the
  agent"*; *"the model learns to write to and read from files on demand — … structured, externalized
  memory."*
- Why irreversible is risky: *"you can't reliably predict which observation might become critical ten
  steps later. … any irreversible compression carries risk."*
- (Distinct, related) **recitation:** rewriting `todo.md` to the **end** of context to fight
  lost-in-the-middle — an attention technique, not compression.

### litectx adaptation delta
| | verdict |
|---|---|
| **Carry** 🔧 | R-C4 directly: `node.handle` (cheap URI/path/id) + `rehydrate(id)`. **Tool-result clearing (R-C3)** = the same move — drop the payload, keep a **1-line stub** = the handle. The node **is** the handle; payload evicts to durable SQLite (or external path/URL), re-hydrate by reference. |
| **Why litectx fits cleanly** | this is **deterministic, no-LLM** — squarely litectx, no ceded step. Already sketched in `ce-flow.md §3.2`. The "restorable" rule also **fixes the LlamaIndex summary-drift weakness** (§1) and **converges with ADK's storage/presentation split** (§2) — see synthesis below. |
| **Correct/note** | the agent's *decision* of **when** to drop/recite = agent-loop policy → **bareagent** (cf. ⊘ in R-W4). Recitation (`todo.md`) is **R-W4** (scratchpad/note), not R-C4 — keep them separate. |
| **Cede** ⊘ | only the *when-to-compress* trigger (agent loop). The mechanism is litectx's. |

**Surface:** `node.handle`, `rehydrate(id)` (R-C4); `clear(nodeId)` (R-C3). **Source:**
`manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus`. *(Use the word
"restorable" — secondary write-ups say "recoverable"; the primary says restorable.)*

---

## 4. Headroom — CCR (Compress-Cache-Retrieve) → **R-C4 / R-C3 / R-I3** (shipping reference impl)

### The pattern
A shipping, benchmarked library that does exactly the store-backed handle contract §2/§3 describe in
the abstract. When a compressor shrinks a payload, the **original is stashed in a local cache under a
hash key** and the window gets an **inline marker** — `[1000 items compressed to 20. Retrieve more:
hash=abc123]` — that *is* the handle. A `headroom_retrieve(hash, query?)` tool re-materializes it on
demand (~1ms, local). The same path is reused for **budget-driven message dropping**: dropped turns
are stashed + markered too, so the trim is restorable, not lossy. This is the third independent
witness to the §2/§3 contract — and the most concrete (real marker grammar + retrieve signature).

### API surface / mechanism (as found)
- **CCR contract:** compress → store original in an LRU cache, hash key for retrieval → emit marker.
  `headroom_retrieve(hash, query?)` returns the payload; **`query` runs BM25 over the cached payload**
  (search-within-handle, not just whole-blob fetch). Marker-and-stash also fires when the context
  manager drops low-importance messages to fit budget.
- **ContentRouter:** routes by **content type** to a per-type compressor — JSON arrays (statistical
  sampling + anomaly preservation, 83–95%), string arrays (dedup + adaptive sampling), build/test
  logs (pattern clustering, 85–94%), HTML (article extraction), source code (AST body compression,
  40–70%). Rule-based classification.
- **SmartCrusher** (JSON/structured, rule-based, no ML): field-level statistical analysis
  (variance/uniqueness/changepoints) + Kneedle on bigram coverage. **Retention split: 30% from start
  (schema), 15% from end (recency), 55% by importance score**, with **anomalies (errors/warnings) and
  distribution boundaries kept unconditionally**. `min_tokens_to_crush=200` (skip small payloads).
- **CodeCompressor** (rule-based): tree-sitter AST → compress **function bodies** while keeping
  **imports, signatures, type annotations, and error handlers verbatim**.
- **CacheAligner:** pulls dynamic content (dates, UUIDs) out to **stabilize the prompt prefix** for
  cache hits — a concrete prefix-stability tactic.
- **Kompress-base / LLMLingua:** an **opt-in** ML compressor (ONNX/HF model, `--llmlingua` flag). The
  *default* path is fully rule-based; ML is an add-on — mirroring litectx's own embeddings-as-a-tier
  stance.

### litectx adaptation delta
| | verdict |
|---|---|
| **Carry** 🔧 | (a) **The CCR marker+retrieve contract → R-C4/C3/I3.** The inline marker = litectx's stub/handle; the hash-keyed store = the node store; `retrieve(hash, query)` = **litectx's recall view pointed at the drop-store** (the BM25-over-payload is *native FTS5* here, a free win). Budget-drop reusing the same stash = R-C3 / message-drop is restorable by the same primitive. This concretely confirms "build R-C4 first; C3/I3 fall out." (b) **SmartCrusher's 30/15/55 + unconditional-anomaly split → a competing prior for R-C7** next to aurora's `CHUNK_LIMITS` (head + tail + importance, with a never-drop override for errors — a structural idea aurora's tiering lacks). (c) **CodeCompressor's signature-verbatim / body-elided → the middle render tier** for code, between R-C7's full-code top and docstring-only tail. (d) **CacheAligner → R-X1** (extract dynamic tokens to stabilize the cache prefix). |
| **Correct/adapt** | (a) **ContentRouter sniffs content type** (JSON vs code vs log) — fine for choosing a *render/compress* strategy by `kind`, but it must **never leak into the indexer**, which routes by **extension, never content** (CLAUDE.md doctrine). (b) litectx already owns tree-sitter extraction + `signature`/`docstring`, so CodeCompressor is a *render policy*, not a new parser. (c) Python-first lib (PyPI primary, npm secondary) under **Apache-2.0** → **port the concept to ESM, don't vendor** (same as all borrows). |
| **Cede** ⊘ | **Kompress-base / LLMLingua** (ML dep — opt-in tier at most, off by default like embeddings). The **proxy / `headroom wrap` / MCP server / cross-agent memory / `headroom learn`** (mine failed sessions → write `CLAUDE.md`) are **harness**: orchestration → bareagent, budget/trust → bareguard. Not litectx. |

**Surface:** confirms `node.handle` + `rehydrate(id)` (R-C4), `clear→stub` (R-C3), `peek`/`load`
(R-I3); `retrieve(hash, query)` ⇒ recall-over-drop-store. Competing R-C7 prior: 30/15/55 + anomaly.
**Sources:** repo `github.com/chopratejas/headroom` (Apache-2.0); docs
`headroom-docs.vercel.app/docs`, `…/llms-full.txt`. Web-grounded 2026-06-05.
*(Numbers — 30/15/55, `min_tokens_to_crush=200`, savings %% — are **untested priors** for the bench,
not calibration; re-verify before building, APIs/figures drift.)*

---

## 5. Synthesis — two patterns, one contract

**ADK's handle pattern (§2) and Manus's restorable compression (§3) are the same idea from two
angles** — and **Headroom (§4) is a shipping reference implementation of that same contract** — and
they jointly define litectx's **R-C4 / R-I3** contract:

- *Storage/presentation separation* (ADK) ⇔ *keep-handle / drop-payload* (Manus) ⇔ *marker + hashed
  cache + `retrieve`* (Headroom §4). All three say: the **handle lives in context; the payload lives
  in durable external storage; re-materialize by reference on demand.** Headroom proves it ships and
  benchmarks — and adds **search-within-handle** (BM25 over the cached payload), which in litectx is
  just **recall pointed at the drop-store** (native FTS5, no new machinery).
- litectx already has the substrate for this: nodes in single-file SQLite, a `scope` key, a `source`
  label. R-C4 (`handle`/`rehydrate`), R-C3 (`clear` to a stub), R-I3 (`peek`/`load`) are **one
  store-backed mechanism** with three entry points — and Headroom's `retrieve(hash, query)` shows the
  fourth: **query the dropped store** without re-inlining everything.
- The **LlamaIndex buffer (§1) is the odd one out**: it's the only pattern with a genuine **ceded LLM
  step** (the summary prose). Its weakness (recompute drift) is precisely what restorable
  compression repairs — so litectx's R-C6 scaffold should **keep handles to summarized turns**, not
  discard them.

**One-line build implication:** build the **restorable store primitive first** (R-C4: node + handle +
`rehydrate`); R-C3 (clear→stub), R-I3 (peek/load), and the R-C6 summary-window's "keep handles to
summarized turns" all fall out of it. The summarizer LLM hook is the only opt-in/ceded piece.
