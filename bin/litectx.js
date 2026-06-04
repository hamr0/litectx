#!/usr/bin/env node
// Thin CLI over the library — the in-repo consumption surface (PRD §14 #5).
// `index` builds (incrementally re-indexes) the index; `recall` queries it.
//
//   litectx index [root] [--force]
//   litectx recall <query...> [--root <dir>] [--limit <n>]

import { LiteCtx } from "../src/index.js";

/** @param {string[]} argv */
function parse(argv) {
  const [cmd, ...rest] = argv;
  /** @type {{root: string, limit: number, force: boolean, words: string[]}} */
  const opts = { root: process.cwd(), limit: 10, force: false, words: [] };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--root") opts.root = rest[++i];
    else if (rest[i] === "--limit") opts.limit = Number(rest[++i]);
    else if (rest[i] === "--force") opts.force = true;
    else opts.words.push(rest[i]);
  }
  return { cmd, opts };
}

function main() {
  const { cmd, opts } = parse(process.argv.slice(2));

  if (cmd === "index") {
    const root = opts.words[0] ?? opts.root;
    const ctx = new LiteCtx({ root });
    const t = Date.now();
    const r = ctx.index({ force: opts.force });
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
    const hits = ctx.recall(query, { limit: opts.limit });
    ctx.close();
    for (const h of hits) console.log(`${h.score.toFixed(2)}\t${h.kind}/${h.format}\t${h.path}`);
    return;
  }

  fail(`unknown command: ${cmd ?? "(none)"}`);
}

/** @param {string} msg */
function fail(msg) {
  console.error(`litectx: ${msg}`);
  console.error("usage: litectx index [root] | litectx recall <query...> [--root <dir>] [--limit <n>]");
  process.exit(1);
}

main();
