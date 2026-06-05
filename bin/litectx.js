#!/usr/bin/env node
// Thin CLI over the library — the in-repo consumption surface (PRD §14 #5).
// `index` builds (incrementally re-indexes) the index; `recall` queries it.
//
//   litectx index [root] [--force]
//   litectx recall <query...> [--root <dir>] [--kind <code|doc>] [-n <n>]

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
    const line = (h) => console.log(`${h.score.toFixed(2)}\t${h.kind}/${h.format}\t${h.path}${fmtGit(h.git)}`);
    if (opts.kind) {
      // one kind → flat ranked list
      ctx.recall(query, { kind: opts.kind, n: opts.n }).forEach(line);
    } else {
      // no kind → grouped over all kinds (top-n each), so prose never buries code
      const grouped = ctx.recall(query, { n: opts.n });
      for (const k of KINDS) {
        if (!grouped[k]?.length) continue;
        console.log(`# ${k}`);
        grouped[k].forEach(line);
      }
    }
    ctx.close();
    return;
  }

  fail(`unknown command: ${cmd ?? "(none)"}`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));

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
  console.error("usage: litectx index [root] | litectx recall <query...> [--root <dir>] [--kind <code|doc>] [-n <n>]");
  process.exit(1);
}
