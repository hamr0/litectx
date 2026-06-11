#!/usr/bin/env sh
# Optional Claude Code SessionStart hook — keep the current repo's litectx index warm so `recall`
# (CLI or the generic MCP server) returns fresh hits without a manual `index` first. Incremental,
# silent, and non-fatal: it never blocks session start and never prints to the transcript.
#
# At SessionStart the cwd is the project root. We only act inside a git repo, and resolve the
# litectx CLI relative to THIS script so the hook is portable across checkouts. Wire up per
# integrations/claude/README.md.
set -e
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LITECTX="$SCRIPT_DIR/../../bin/litectx.js"
if [ -d .git ] && [ -f "$LITECTX" ] && command -v node >/dev/null 2>&1; then
  timeout 60 node "$LITECTX" index >/dev/null 2>&1 || true
fi
exit 0
