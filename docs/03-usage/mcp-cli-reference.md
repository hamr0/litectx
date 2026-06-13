# litectx — MCP & CLI Reference

How to drive litectx two ways — the **CLI** (`litectx …`) and the **MCP server**
(`litectx-mcp`, the same library over stdio for any MCP client). Both wrap the one
`LiteCtx` library; they expose the same operations with the same semantics. Repo-only
doc (not shipped in the npm `files` whitelist).

> **Embeddings are ON by default on both surfaces** (the library default stays
> `false` — see [§ Embeddings](#embeddings--when-the-ml-installs)). Pass
> `--no-embeddings` to either surface for the BM25-only base.

---

## 1. The model in one paragraph

litectx is a code+context **graph** in a single SQLite file (`better-sqlite3` + FTS5).
You **index** a repo (routed by file extension: TS/JS/Python → `code`, Markdown →
`doc`), then use two views: **recall** (ranked search — BM25 + import-graph spreading,
plus a semantic rerank when embeddings are on) and **impact** (blast radius / risk
bucket for a symbol, from ripgrep `-w` + tree-sitter — **no LSP**). On top of the
indexed repo you can **remember** free-standing memory (`fact` / `episode` / `doc`)
that has no file behind it. Everything lives in one db; written memory survives a
`--force` rebuild.

---

## 2. CLI

Binary: `litectx` (also `node …/bin/litectx.js`). Every command takes `--root <dir>`
(defaults to cwd). `help` / `--help` / `-h` / no args → usage on stdout, exit 0.

Output is **tab-separated columns** (legend printed by `litectx help`):

```
recall  score  kind/format  path  → chunk-symbol:start-end  git:Ncommits/age   (memory hits also: provenance use:N)
recent  age  edits×  kind  path  › symbol
```

### `index [root] [--force] [--no-embeddings]`
Build or incrementally refresh the index. Incremental by default (mtime+size → sha256;
only changed files re-read). `--force` rebuilds every file from disk — **written memory
always survives**. With embeddings on, changed chunks are (re-)embedded.

```bash
litectx index                      # incremental, embeddings on
litectx index --force               # full rebuild from disk
litectx index --no-embeddings       # BM25-only, no vectors written
# → {"files":108,"added":0,"updated":0,"removed":0,"unchanged":107}
```

### `recall <query…> [--kind <k>] [-n <n>] [--no-embeddings] [--no-log]`
Ranked search over the repo + written memory. Returns **scored pointers** (path/id +
chunk locator), never bodies — follow up with `get`. Omit `--kind` for top hits grouped
per kind; pass `--kind code|doc|fact|episode` for a flat ranked list. `--no-log` skips
recording the recall in the access log.

```bash
litectx recall how does base-level decay work
litectx recall "auth token refresh" --kind code -n 10
litectx recall paraphrase of a fact --kind fact     # semantic — needs embeddings
```

### `impact <symbol>`
Blast radius for a symbol defined in the repo: callers (called-by), callees, ref count
(`confirmed` vs `mentions`), complexity, and a **low/med/high** risk bucket. Over-counts
by design — it's a risk bucket, not a precise reference list.

```bash
litectx impact recall
# → symbol recall · risk HIGH · 761 refs (confirmed 94 / mentions 761) · complexity 9 · callers […]
```

### `get <id> [--no-log]`
Fetch the full body for a recall hit: a written-memory id verbatim, or an indexed file
path read **fresh from disk**.

```bash
litectx get src/index.js
litectx get docs/02-engineering/build-studies.md
litectx get fact:auth-uses-jwt
```

### `remember <id> [text…] [--kind <fact|episode|doc>] [--by <human|agent>] [--no-embeddings]`
Write memory with no file behind it. Upserts by id (re-remembering revises). Namespace
ids (`fact:…`, `ep:…`). `--by human` only for content a person stated; default `agent`.

```bash
litectx remember fact:auth-uses-jwt "Auth is JWT, 15-min access tokens." --by human
litectx remember ep:2026-06-11-debug "Chased the force-rebuild memory wipe to store.js" --kind episode
```

### `forget <id> | --kind <k> | --by <p>`
Hard-delete written memory (never touches indexed files). One id, or bulk by kind/by.

```bash
litectx forget fact:auth-uses-jwt
litectx forget --kind episode        # drop all episodes
litectx forget --by agent            # drop every agent-asserted memory
```

### `recent [--since <days>] [-n <n>]`
"What was I working on" — the chunks litectx most recently **witnessed edited**, newest
first. Reads the edit-witness log, never search ranking. Empty until an *incremental*
pass observes edits (the first/forced build records nothing).

```bash
litectx recent --since 3 -n 20
```

### `promotions [--threshold <n>]`
Episodes recalled past a threshold (default 10, last 30 days) — scratchpad notes worth
distilling into durable facts. litectx only **flags**; the distill loop is yours
(`get` it, then `remember kind:fact`).

```bash
litectx promotions --threshold 5
```

---

## 3. MCP server

`litectx-mcp` is the same library over **stdio JSON-RPC** (MCP). Any MCP client can use
it. It exposes **eight tools** — the CLI commands, 1:1:

| MCP tool | Args | Does |
|---|---|---|
| `index` | `force?` | Build/refresh the index (incremental; `force` = full rebuild, memory survives). |
| `recall` | `query`, `kind?`, `n?` | Ranked search → scored **pointers** (grouped per kind, or flat with `kind`). Memory hits also carry `provenance` / `use` / `occurredAt` — context for you to weigh, **not** a ranking thumb. |
| `impact` | `symbol` | Blast radius + low/med/high risk for a defined symbol. |
| `get` | `id` | Full body for a recall hit (memory verbatim, or file fresh from disk). |
| `remember` | `id`, `text`, `kind?`, `by?` | Write a `fact`/`episode`/`doc`; upsert by id. |
| `forget` | `id` \| `kind` \| `by` | Hard-delete written memory (bulk by kind/by). |
| `recent` | `days?`, `limit?` | Recently-witnessed edits, newest first (edit log, not ranking). |
| `promotions` | `threshold?` | Episodes recalled past a threshold — distill candidates. |

**The intended loop:** `recall` to find pointers → `get` to read a hit's body →
`impact` before editing a symbol → `remember` durable facts → `promotions`/`recent` to
keep memory curated. `recall` deliberately returns pointers (cheap), so you only pay to
`get` the few bodies you actually need.

### Configuring the MCP server — manual, one-time

Registration is **manual** (one `claude mcp add`), then it's persistent. It is **not**
auto-wired by installing the package.

```bash
# user scope (every project), embeddings on:
claude mcp add litectx --scope user -- \
  node ~/.local/lib/node_modules/litectx/bin/litectx-mcp.js --embeddings
```

This writes a `mcpServers.litectx` entry to `~/.claude.json`:

```json
{ "type": "stdio", "command": "node",
  "args": ["/home/<you>/.local/lib/node_modules/litectx/bin/litectx-mcp.js", "--embeddings"],
  "env": {} }
```

Notes:
- **Drop `--embeddings`** for the BM25-only base (faster cold start, no ML dep/model).
- MCP config loads at **client startup** — a fresh registration activates next session.
- The server **auto-resolves the repo from cwd**, so the one user-scope registration
  serves every project; no per-project setup.
- Verify: `claude mcp list` → `litectx … ✔ Connected`.
- Other MCP clients: point them at the same `node …/bin/litectx-mcp.js --embeddings`
  stdio command.

---

## 4. Optional Claude Code hooks (`integrations/claude/`)

Two opt-in hooks ship in the package. Nothing in the library depends on them. Wire them
in `~/.claude/settings.json` pointing at the **global install** (so they track the
published version, and apply to every project):

```jsonc
"hooks": {
  "PreToolUse": [{ "matcher": "Edit", "hooks": [{ "type": "command",
    "command": "node /home/<you>/.local/lib/node_modules/litectx/integrations/claude/pre-edit-impact.mjs" }] }],
  "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command",
    "command": "/home/<you>/.local/lib/node_modules/litectx/integrations/claude/warm-index.sh" }] }]
}
```

- **`pre-edit-impact.mjs`** — `PreToolUse:Edit` hook. Finds the symbol enclosing the
  edit (indentation + block-open scan), runs litectx **`impact()`**, and returns it as
  `additionalContext` the model sees before editing (callers, ref count, risk; a ⚠️ on
  HIGH). **Never blocks** — any failure path just allows the edit and adds nothing. This
  is the **LSP-free replacement** for an old language-server pre-edit check: same intent
  (warn before touching a high-fan-in symbol), but the reference count comes from
  litectx's ripgrep + tree-sitter resolution — see [§ No LSP](#5-no-lsp-and-the-aurora-question).
- **`warm-index.sh`** — `SessionStart` hook. Inside a git repo, runs
  `index --embeddings` on the current project (180 s timeout, silent, non-fatal) so
  recall returns fresh hits without a manual index first. Resolves the litectx bin
  **relative to itself**, so pointing it at the global copy uses the global binary.

Both hook commands point at the global npm install; the binary/library is global while
the *target* is always the current project (cwd at session start / edit time).

---

## 5. No LSP, and the "aurora" question

litectx has **no language server, ever** (doctrine). The `impact` view — the thing you'd
otherwise ask an LSP ("who calls this?") — is built from **ripgrep `-w` + tree-sitter
only**: tree-sitter emits the symbol table, one batched `rg -F -w --json` finds candidate
refs, tree-sitter confirms each is a *use* (not a def/comment/string), then thresholds
bucket it low/med/high. Over-counting is intentional (`mentions` ≥ `confirmed`); the
output is a risk bucket, not a proof.

**The pre-edit hook uses litectx's own `impact()`, not aurora.** litectx *borrowed*
aurora's validated **calibration** (risk thresholds, `skip_names`, complexity formula)
into clean ESM code — it does not call aurora or any LSP. Our own enhancements ship in
the published package and the hook gets all of them:

- **Risk calibration** (slice 5a) — `max(tree-sitter-resolved, rg -w count)` bucketed
  ≤2 / 3–10 / 11+, borrowed from aurora's `lsp_tool` but with LSP dropped.
- **Barrel / path-alias resolution** (slice 5b, `src/tsalias.js`) — impact resolves
  renamed barrel / path-alias callers on demand (impact-only; recall ranking unchanged).

Because the hook imports `LiteCtx` from whatever copy its path points at, aligning the
hook to the **global published install** means it runs the **published 0.5.0 `impact()`**
— every enhancement above, no working-tree drift.

---

## 6. Embeddings — when the ML installs

Two separate layers, do not conflate them:

1. **The JS dependency** (`@xenova/transformers`) installs **with npm**, at package
   install time. It's an **`optionalDependency`**, so `npm install -g litectx`
   auto-installs it best-effort — and if its native/optional build fails, npm
   **continues without failing the install** (bare/offline installs still work).
2. **The model weights** (`Xenova/all-MiniLM-L6-v2`, 384-dim, **~23 MB** quantized ONNX)
   are **not bundled**. They download **lazily on first embedding use** (first
   `index`/`recall`/`remember` with embeddings on) from the HF hub, then cache. Measured:
   **~2.1 s first-ever download · ~0.72 s cached load · ~6 ms warm**.

So: `--embeddings` is only "real" if the dep installed. If it can't load, litectx's
**graceful fallback** disables the tier for that instance, warns once to stderr, and
continues on BM25 — it never crashes. Embeddings is a **two-sided switch**: vectors must
be *written at index time* to be *usable at recall time*, which is why both the index and
the recall surface carry the flag.

The lift it buys: natural-language code recall +~0.2 MRR; and **memory paraphrase recall
goes from 0.000 → 0.574** — a fact you can't query by meaning is half a memory, which is
why both CLI and MCP default it on.
