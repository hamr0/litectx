#!/usr/bin/env node
// Optional Claude Code PreToolUse:Edit hook — surfaces litectx `impact()` (blast radius + a
// low/med/high risk bucket) for the symbol you're about to edit, as `additionalContext` the model
// sees before the edit. This is the LSP-free replacement for an aurora-LSP pre-edit check: same
// idea (warn before touching a high-fan-in symbol), but the reference count comes from litectx's
// ripgrep + tree-sitter resolution, no language server.
//
// Opt-in and self-contained: nothing in the library depends on this file (see ../README in
// integrations/claude). It reads the Edit payload on stdin, NEVER blocks the edit (always allow),
// and stays silent unless it finds a defined symbol with a real blast radius. Imports the library
// in-process (one node spawn per edit, no subprocess fan-out).
//
// Wiring (settings.json), pointed at your checkout:
//   "PreToolUse": [{ "matcher": "Edit", "hooks": [{ "type": "command",
//     "command": "node /ABS/PATH/litectx/integrations/claude/pre-edit-impact.mjs" }] }]

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { LiteCtx } from "../../src/index.js";

const CODE_EXT = /\.(py|js|ts|jsx|tsx|mjs|cjs)$/; // litectx v1 languages (python + js/ts family)
// Definition patterns, scanned upward from the edit site to find the enclosing symbol whose blast
// radius matters. Best-effort by design — impact() returns null for anything not a defined symbol,
// so a wrong guess simply no-ops (matches litectx's "over-count safe, a risk bucket not a proof").
const DEF_RE = [
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, // python def
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_]\w*)/, // js/ts function
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_]\w*)/, // class
  // binding ONLY when the RHS is a function/arrow — never a plain local like `const a = b.c`
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
];
// class/object methods carry no keyword: `name(args) {`. Lowest priority, and guarded against
// control-flow words (`if (x) {`) and the keywords that the patterns above already own.
const METHOD_RE = /^\s*(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+|get\s+|set\s+|\*\s*)*([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/;
const NOT_A_SYMBOL = new Set(["if", "for", "while", "switch", "catch", "return", "function", "class", "else", "do", "try", "with", "const", "let", "var", "new", "await", "case", "typeof"]);

const indentOf = (s) => (s.match(/^[ \t]*/) ?? [""])[0].length;
const opensBlock = (s) => /\{\s*$/.test(s) || /:\s*$/.test(s); // js block open, or python `def ...:`
const matchDef = (line) => {
  for (const re of DEF_RE) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  const mm = METHOD_RE.exec(line);
  return mm && !NOT_A_SYMBOL.has(mm[1]) ? mm[1] : null;
};

// The symbol whose BODY encloses the edit. Scanning upward, a candidate only counts as the
// encloser if it sits at shallower indentation than the edit AND opens a block — so a one-line
// local (`const f = x => x`) can't shadow the real function, and a method isn't lost to its class.
// The edit line itself is always eligible (editing a signature names that symbol).
const symbolAt = (lines, line0) => {
  const top = Math.min(line0, lines.length - 1);
  const editIndent = indentOf(lines[top] ?? "");
  for (let i = top; i >= 0; i--) {
    if (i !== top && (indentOf(lines[i]) >= editIndent || !opensBlock(lines[i]))) continue;
    const sym = matchDef(lines[i]);
    if (sym) return sym;
  }
  return null;
};

const bail = () => process.exit(0); // every failure path = allow the edit, add nothing

/** nearest .git ancestor of `start`, or `start` itself */
function repoRoot(start) {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return start;
    dir = up;
  }
}

let data;
try {
  data = JSON.parse(readFileSync(0, "utf8"));
} catch {
  bail();
}
const ti = data.tool_input ?? {};
const file = ti.file_path ?? "";
const oldStr = ti.old_string ?? "";
const cwd = data.cwd || process.cwd();
if (!file || !CODE_EXT.test(file)) bail();

let content;
try {
  content = readFileSync(file, "utf8");
} catch {
  bail();
}
const at = oldStr ? content.indexOf(oldStr) : 0;
if (oldStr && at < 0) bail(); // can't locate the edit → don't guess
const line0 = oldStr ? content.slice(0, at).split("\n").length - 1 : 0;
const symbol = symbolAt(content.split("\n"), line0);
if (!symbol) bail();

const ctx = new LiteCtx({ root: repoRoot(cwd) });
let r = null;
try {
  if (ctx.size() > 0) r = await ctx.impact(symbol);
} catch {
  // ripgrep missing, parse error, etc. — surface nothing rather than break the edit
}
ctx.close();
if (!r) bail();

let msg = `litectx impact — '${r.symbol}' risk:${r.risk.toUpperCase()} · ${r.refCount} refs (confirmed ${r.confirmed} / mentions ${r.mentions}) · complexity ${r.complexity}`;
if (r.callers.length) {
  const shown = r.callers
    .slice(0, 8)
    .map((c) => `${c.path}:${c.line + 1}${c.symbol ? ` (${c.symbol})` : ""}`)
    .join(", ");
  msg += `\ncalled-by: ${shown}${r.callers.length > 8 ? `, +${r.callers.length - 8} more` : ""}`;
}
if (r.risk === "high") msg += `\n⚠️ HIGH IMPACT — review the callers above before editing.`;
for (const h of r.hedges) msg += `\n⚠ ${h}`;

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      additionalContext: msg,
    },
  })
);
process.exit(0);
