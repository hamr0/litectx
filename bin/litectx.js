#!/usr/bin/env node
// Thin CLI over the library — the in-repo consumption surface (PRD §14 #5).
// `index` builds (incrementally re-indexes) the index; `recall` queries it.
//
//   litectx index [root] [--force]
//   litectx recall <query...> [--root <dir>] [--kind <code|doc>] [-n <n>]
//   litectx impact <symbol> [--root <dir>]

import { LiteCtx, KINDS } from "../src/index.js";

/** @param {string[]} argv */
function parse(argv) {
  const [cmd, ...rest] = argv;
  /** @type {{root: string, n: number|undefined, kind: string|undefined, force: boolean, words: string[]}} */
  const opts = { root: process.cwd(), n: undefined, kind: undefined, force: false, words: [] };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--root") opts.root = rest[++i];
    else if (rest[i] === "-n" || rest[i] === "--limit") opts.n = Number(rest[++i]);
    else if (rest[i] === "--kind") opts.kind = rest[++i];
    else if (rest[i] === "--force") opts.force = true;
    else opts.words.push(rest[i]);
  }
  return { cmd, opts };
}

async function main() {
  const { cmd, opts } = parse(process.argv.slice(2));

  if (cmd === "index") {
    const root = opts.words[0] ?? opts.root;
    const ctx = new LiteCtx({ root });
    const t = Date.now();
    const r = await ctx.index({ force: opts.force });
    ctx.close();
    console.error(
      `indexed ${r.files} files from ${root} (+${r.added} ~${r.updated} -${r.removed}, ${r.unchanged} unchanged) in ${Date.now() - t}ms`
    );
    return;
  }

  if (cmd === "recall") {
    const query = opts.words.join(" ");
    if (!query) fail("recall needs a query");
    const ctx = new LiteCtx({ root: opts.root });
    if (ctx.size() === 0) console.error("warning: index is empty — run `litectx index` first");
    /** @param {import("../src/store.js").Hit} h */
    const line = (h) => console.log(`${h.score.toFixed(2)}\t${h.kind}/${h.format}\t${h.path}${fmtChunk(h.chunk)}${fmtGit(h.git)}`);
    if (opts.kind) {
      // one kind → flat ranked list
      (await ctx.recall(query, { kind: opts.kind, n: opts.n })).forEach(line);
    } else {
      // no kind → grouped over all kinds (top-n each), so prose never buries code
      const grouped = await ctx.recall(query, { n: opts.n });
      for (const k of KINDS) {
        if (!grouped[k]?.length) continue;
        console.log(`# ${k}`);
        grouped[k].forEach(line);
      }
    }
    ctx.close();
    return;
  }

  if (cmd === "impact") {
    const symbol = opts.words[0];
    if (!symbol) fail("impact needs a symbol name");
    const ctx = new LiteCtx({ root: opts.root });
    if (ctx.size() === 0) console.error("warning: index is empty — run `litectx index` first");
    const r = await ctx.impact(symbol);
    ctx.close();
    if (!r) {
      console.error(`litectx: '${symbol}' is not defined in the index`);
      process.exit(1);
    }
    console.log(`${r.symbol}\trisk:${r.risk}\trefs:${r.refCount} (confirmed ${r.confirmed} / mentions ${r.mentions})\tcomplexity:${r.complexity}`);
    for (const d of r.defs) console.log(`  def\t${d.path}:${d.startLine + 1}`);
    if (r.callees.length) console.log(`  calls\t${r.callees.join(", ")}`);
    for (const c of r.callers.slice(0, opts.n ?? 15)) console.log(`  called-by\t${c.path}:${c.line + 1}${c.symbol ? `\t(${c.symbol})` : ""}`);
    if (r.callers.length > (opts.n ?? 15)) console.log(`  …\t${r.callers.length - (opts.n ?? 15)} more callers`);
    for (const h of r.hedges) console.log(`  ⚠ ${h}`);
    return;
  }

  fail(`unknown command: ${cmd ?? "(none)"}`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));

/**
 * Render the hit's chunk pointer (chunk-granular recall, slice 8) — the matching function/section
 * inside the file, 1-based lines for humans. No localization → no column.
 * @param {import("../src/store.js").ChunkRef | null | undefined} c
 */
function fmtChunk(c) {
  if (!c) return "";
  return `\t→ ${c.symbol ?? c.nodeType}:${c.startLine + 1}-${c.endLine + 1}`;
}

/**
 * Render file-level git grounding as a compact trailing column (grounding, never scored — PRD §slice4).
 * No commit history (non-git tree / tracked-but-uncommitted) → `git: null` → no column.
 * @param {import("../src/gitsig.js").GitSig | null | undefined} g
 */
function fmtGit(g) {
  if (!g) return "";
  return `\tgit:${g.commits}c${g.lastCommit ? `/${relAge(g.lastCommit)}` : ""}`;
}

/** @param {number} sec unix seconds of last commit @returns {string} coarse age (m/h/d) */
function relAge(sec) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** @param {string} msg */
function fail(msg) {
  console.error(`litectx: ${msg}`);
  console.error("usage: litectx index [root] | litectx recall <query...> [--root <dir>] [--kind <code|doc>] [-n <n>] | litectx impact <symbol> [--root <dir>]");
  process.exit(1);
}
