# litectx + Claude Code integration (optional)

Two **Claude-Code-specific** hooks, plus a note on registering the **generic** MCP server. All
opt-in — nothing in the library depends on any of this.

- `pre-edit-impact.mjs` — **Claude-only** `PreToolUse:Edit` hook. Before an edit, it finds the
  enclosing symbol and surfaces litectx `impact()` (callers, reference count, low/med/high risk
  bucket) as `additionalContext`. LSP-free; never blocks the edit. Emits Claude Code's
  `hookSpecificOutput` shape, so it is specific to Claude Code.
- `warm-index.sh` — **Claude-only** `SessionStart` hook. Incrementally re-indexes the current repo
  so `recall` is fresh without a manual `index`. Silent, non-fatal.

The **MCP server is not Claude-specific** — `bin/litectx-mcp.js` is a generic stdio JSON-RPC MCP
server that works with any MCP client (Claude Code, Cursor, etc.). It is documented here only
because registering it is how you'd use litectx tools from Claude Code.

## MCP server (any MCP client)

Register globally so it auto-scopes to whatever repo you're in (the server defaults `--root` to the
client's cwd):

```sh
claude mcp add --scope user litectx -- node /ABS/PATH/litectx/bin/litectx-mcp.js
# add --embeddings after the bin to enable paraphrase recall for facts/episodes (slower cold start)
```

Tools exposed: `index`, `recall`, `get`, `recent`, `promotions`, `impact`, `remember`, `forget`.
See each tool's `description` in `tools/list` for the contract.

## Hooks (Claude Code)

Point `~/.claude/settings.json` at your checkout (absolute paths required):

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Edit", "hooks": [
        { "type": "command", "command": "node /ABS/PATH/litectx/integrations/claude/pre-edit-impact.mjs" }
      ] }
    ],
    "SessionStart": [
      { "matcher": "", "hooks": [
        { "type": "command", "command": "/ABS/PATH/litectx/integrations/claude/warm-index.sh" }
      ] }
    ]
  }
}
```

`chmod +x` the two scripts once.

## Indexing: CLI vs MCP vs hook

Same on-disk index (`<repo>/.litectx/index.db`) whichever you use:

- **`warm-index.sh` (SessionStart)** — keeps the current repo fresh automatically; the zero-effort path.
- **CLI `litectx index`** — best for the first build of a new repo, or a manual `--force` rebuild.
- **MCP `index` tool** — index from inside an agent session (e.g. right after a batch of edits).
