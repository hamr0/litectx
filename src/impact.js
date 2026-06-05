// Impact view (slice 5) — "if I change this symbol, what's the blast radius and how risky?"
//
// Computed ON DEMAND (§7.1), never persisted: callees by a tree-sitter walk of the symbol's body,
// callers by an `rg -w` sweep confirmed with tree-sitter. No LSP, ever (§7). The whole view is
// built around the §7.2 asymmetry: OVER-count is safe (over-cautious), UNDER-count is dangerous (a
// false "isolated → safe" breaks hidden consumers). So we may overstate connectivity freely but
// never understate it silently — "isolated / low-risk" only ships HEDGED.
//
// Risk calibration is borrowed from aurora's `lsp_tool` (carry the numbers, not the LSP): bucket on
// max(confirmed callers, external rg mentions) at thresholds ≤2 / 3–10 / 11+ (ledger §9).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { langForExt } from "./langdef.js";
import { analyzeBody, callSitesOf } from "./chunker.js";

// callee names that are ubiquitous noise even when they happen to collide with an indexed symbol —
// kept SMALL because callees are already filtered to intra-repo definitions (§7.2 over-count safe).
const SKIP_CALLEES = new Set(["constructor", "toString", "valueOf", "__init__", "__call__", "self", "super"]);

// Confirming callers re-parses each candidate file; bound the work for a pathologically common name.
// The `rg` mention floor stays exact regardless, so the risk bucket is never capped — only the named
// caller LIST is (and we hedge when it is).
const CONFIRM_FILE_CAP = 300;

/**
 * Risk bucket from a reference count. Aurora-validated thresholds (lsp_tool `_calculate_risk`):
 * @param {number} n
 * @returns {"low"|"medium"|"high"}
 */
export function riskBucket(n) {
  if (n <= 2) return "low";
  if (n <= 10) return "medium";
  return "high";
}

/**
 * @typedef {Object} Caller
 * @property {string} path    repo-relative file with a confirmed call
 * @property {number} line    0-based line of the call site
 * @property {string|null} symbol  enclosing caller symbol, or null at module top level
 */

/**
 * @typedef {Object} Impact
 * @property {string} symbol
 * @property {{ path: string, startLine: number, endLine: number }[]} defs  every definition (over-count: all of them)
 * @property {number} refCount    max(confirmed, mentions) — the over-count-safe blast radius
 * @property {number} confirmed   tree-sitter-confirmed external call sites
 * @property {number} mentions    external `rg -w` word occurrences (the safety floor)
 * @property {"low"|"medium"|"high"} risk
 * @property {number} complexity  cyclomatic-ish (max over defs)
 * @property {Caller[]} callers   confirmed call sites (may be capped — see hedges)
 * @property {string[]} callees   intra-repo names this symbol calls (unique)
 * @property {string[]} hedges    §7.2 safety caveats; never a silent "isolated"
 */

/**
 * Compute the impact of changing `symbol`. Returns null if the symbol isn't defined in the index
 * (impact answers for YOUR code's symbols; an unknown name has no blast radius to report).
 * @param {import("./store.js").Store} store
 * @param {string} root      absolute repo root
 * @param {string[]} include indexed file extensions (e.g. [".py", ".js"])
 * @param {string} symbol
 * @returns {Promise<Impact|null>}
 */
export async function computeImpact(store, root, include, symbol) {
  const defs = store.symbolDefs(symbol);
  if (!defs.length) return null;

  const defRanges = defs.map((d) => ({ path: d.path, start: d.start_line, end: d.end_line }));
  const inOwnDef = (relPath, line) =>
    defRanges.some((r) => r.path === relPath && line >= r.start && line <= r.end);

  // ---- callees + complexity: tree-sitter walk of each def body (§7.1, no rg) ----
  const known = store.allSymbolNames();
  /** @type {Set<string>} */
  const callees = new Set();
  let complexity = 0;
  for (const d of defs) {
    const a = await analyzeBody(d.format, d.body);
    complexity = Math.max(complexity, a.complexity);
    for (const c of a.calls) if (c !== symbol && !SKIP_CALLEES.has(c) && known.has(c)) callees.add(c);
  }

  // ---- callers: rg -w sweep → tree-sitter confirm (§7.1 called-by) ----
  const matches = rgWordMatches(symbol, root, include); // [{ rel, abs, line, count }]
  let mentions = 0;
  /** @type {Map<string, { abs: string, lines: number[] }>} */
  const byFile = new Map();
  for (const m of matches) {
    if (inOwnDef(m.rel, m.line)) continue; // the definition itself is not a usage
    mentions += m.count;
    const e = byFile.get(m.rel);
    if (e) e.lines.push(m.line);
    else byFile.set(m.rel, { abs: m.abs, lines: [m.line] });
  }

  /** @type {Caller[]} */
  const callers = [];
  const hedges = [];
  const candidateFiles = [...byFile.entries()];
  const confirmFiles = candidateFiles.slice(0, CONFIRM_FILE_CAP);
  if (candidateFiles.length > CONFIRM_FILE_CAP) {
    hedges.push(`caller list capped at ${CONFIRM_FILE_CAP} files (${candidateFiles.length} mention it); the risk count is the exact mention floor and is not capped`);
  }
  for (const [rel, { abs }] of confirmFiles) {
    const lang = langForExt(extname(rel).toLowerCase());
    if (!lang) continue;
    let body;
    try {
      body = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    for (const site of await callSitesOf(lang.format, body, symbol)) {
      if (inOwnDef(rel, site.line)) continue; // self-recursion isn't an external consumer
      callers.push({ path: rel, line: site.line, symbol: site.enclosing });
    }
  }

  const confirmed = callers.length;
  // Over-count-safe blast radius: the larger of the two signals (aurora's max(used_by, text)).
  const refCount = Math.max(confirmed, mentions);
  const risk = riskBucket(refCount);

  // ---- §7.2 safety net: never a silent "isolated" ----
  if (confirmed === 0 && mentions > 0) {
    hedges.push(`${mentions} text mention(s) couldn't be confirmed as calls (comments / strings / dynamic) — counted, not dropped (§7.2)`);
  }
  if (refCount === 0) {
    // The only dangerous act is a false "isolated". Hedge every such verdict (§7.2). Note: a string
    // mention (reflection / dynamic dispatch) would already make `mentions > 0`, so reaching here
    // means rg found NOTHING outside the definition — genuinely no static reference.
    if (looksExternallyReachable(symbol, defs)) {
      hedges.push(`exported / public name — external consumers aren't statically visible`);
    }
    hedges.push(`no references found outside its definition — review candidate, NOT a confirmed isolation (§7.2)`);
  }

  return {
    symbol,
    defs: defs.map((d) => ({ path: d.path, startLine: d.start_line, endLine: d.end_line })),
    refCount,
    confirmed,
    mentions,
    risk,
    complexity,
    callers,
    callees: [...callees].sort(),
    hedges,
  };
}

/**
 * `rg -F -w --json` for whole-word occurrences of `name`, scoped to the indexed extensions.
 * @param {string} name
 * @param {string} root
 * @param {string[]} include
 * @returns {{ rel: string, abs: string, line: number, count: number }[]}
 */
function rgWordMatches(name, root, include) {
  const globs = include.flatMap((e) => ["-g", `*${e}`]);
  let out = "";
  try {
    out = execFileSync("rg", ["--json", "-F", "-w", ...globs, "--", name, root], {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch (/** @type {any} */ e) {
    // rg exits 1 on "no matches" — a valid empty result, not a failure. stdout may still carry
    // partial JSON on other non-zero exits; use it if present, else treat as empty.
    if (e && typeof e.stdout === "string" && e.stdout) out = e.stdout;
    else return [];
  }
  /** @type {{ rel: string, abs: string, line: number, count: number }[]} */
  const res = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type !== "match") continue;
    const abs = ev.data.path.text;
    res.push({
      rel: relative(root, abs),
      abs,
      line: ev.data.line_number - 1,
      count: (ev.data.submatches || []).length || 1,
    });
  }
  return res;
}

/**
 * Heuristic "could be reached from outside the repo" check, used only to hedge an isolated verdict
 * (no new schema): a non-underscore Python name (module-public) or a def whose source carries the
 * `export` keyword (JS/TS). Over-hedges safely (§7.2) — better a spurious caveat than a false silo.
 * @param {string} name
 * @param {{ format: string, body: string }[]} defs
 * @returns {boolean}
 */
function looksExternallyReachable(name, defs) {
  for (const d of defs) {
    if (d.format === "py" && !name.startsWith("_")) return true;
    if ((d.format === "js" || d.format === "ts") && /(^|\n)\s*export\b/.test(d.body)) return true;
  }
  return false;
}
