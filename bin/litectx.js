#!/usr/bin/env node
// Thin CLI over the library — the in-repo consumption surface (PRD §14 #5).
// `index` builds (incrementally re-indexes) the index; `recall` queries it.
//
//   litectx index [root] [--force] [--embeddings]
//   litectx recall <query...> [--root <dir>] [--kind <code|doc|fact|episode>] [-n <n>] [--embeddings] [--no-log]
//   litectx get <id> [--root <dir>] [--no-log]
//   litectx recent [--root <dir>] [--since <days>] [-n <n>]
//   litectx promotions [--root <dir>] [--threshold <n>]   # episodes to consider distilling into facts
//   litectx impact <symbol> [--root <dir>]
//   litectx remember <id> [text...] [--kind <fact|episode|doc>] [--by <human|agent>] [--root <dir>] [--embeddings]
//   litectx forget <id> [--root <dir>]   |   litectx forget --kind <k> / --by <b>  (bulk)

import { readFileSync } from "node:fs";
import { LiteCtx, KINDS } from "../src/index.js";

/** @param {string[]} argv */
function parse(argv) {
  const [cmd, ...rest] = argv;
  /** @type {{root: string, n: number|undefined, since: number|undefined, threshold: number|undefined, kind: string|undefined, by: string|undefined, force: boolean, embeddings: boolean, log: boolean, words: string[]}} */
  const opts = { root: process.cwd(), n: undefined, since: undefined, threshold: undefined, kind: undefined, by: undefined, force: false, embeddings: false, log: true, words: [] };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--root") opts.root = rest[++i];
    else if (rest[i] === "-n" || rest[i] === "--limit") opts.n = Number(rest[++i]);
    else if (rest[i] === "--since") opts.since = Number(rest[++i]);
    else if (rest[i] === "--threshold") opts.threshold = Number(rest[++i]);
    else if (rest[i] === "--kind") opts.kind = rest[++i];
    else if (rest[i] === "--by") opts.by = rest[++i];
    else if (rest[i] === "--force") opts.force = true;
    else if (rest[i] === "--embeddings") opts.embeddings = true;
    else if (rest[i] === "--no-log") opts.log = false;
    else opts.words.push(rest[i]);
  }
  return { cmd, opts };
}

async function main() {
  const { cmd, opts } = parse(process.argv.slice(2));

  if (cmd === "index") {
    const root = opts.words[0] ?? opts.root;
    const ctx = new LiteCtx({ root, embeddings: opts.embeddings });
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
    const ctx = new LiteCtx({ root: opts.root, embeddings: opts.embeddings });
    if (ctx.size() === 0) console.error("warning: index is empty — run `litectx index` first");
    /** @param {import("../src/store.js").Hit} h */
    const line = (h) => console.log(`${h.score.toFixed(2)}\t${h.kind}/${h.format}\t${h.path}${fmtChunk(h.chunk)}${fmtGit(h.git)}${fmtMem(h)}`);
    if (opts.kind) {
      // one kind → flat ranked list
      (await ctx.recall(query, { kind: opts.kind, n: opts.n, log: opts.log })).forEach(line);
    } else {
      // no kind → grouped over all kinds (top-n each), so prose never buries code
      const grouped = await ctx.recall(query, { n: opts.n, log: opts.log });
      for (const k of KINDS) {
        if (!grouped[k]?.length) continue;
        console.log(`# ${k}`);
        grouped[k].forEach(line);
      }
    }
    ctx.close();
    return;
  }

  if (cmd === "get") {
    const id = opts.words[0];
    if (!id) fail("get needs an id (a written-memory id or an indexed file path)");
    const ctx = new LiteCtx({ root: opts.root });
    const item = ctx.get(id, { log: opts.log });
    ctx.close();
    if (!item) {
      console.error(`litectx: '${id}' is not in the index`);
      process.exit(1);
    }
    // metadata to stderr, body to stdout — so `litectx get <id>` pipes clean text
    console.error(`${item.kind}/${item.format}\t${item.source}${item.provenance ? `/${item.provenance}` : ""}\t${item.id}`);
    if (item.text == null) {
      console.error("litectx: indexed but missing from disk (stale until the next `litectx index`)");
      process.exit(1);
    }
    process.stdout.write(item.text.endsWith("\n") ? item.text : `${item.text}\n`);
    return;
  }

  if (cmd === "remember") {
    const id = opts.words[0];
    if (!id) fail("remember needs an id (namespace it, e.g. fact:auth-uses-jwt)");
    // body = the remaining args, or stdin when piped (`git log -1 | litectx remember ep:release`)
    let text = opts.words.slice(1).join(" ");
    if (!text) {
      if (process.stdin.isTTY) fail("remember needs text (as arguments or piped on stdin)");
      text = readFileSync(0, "utf8").trim();
      if (!text) fail("remember: stdin was empty");
    }
    const ctx = new LiteCtx({ root: opts.root, embeddings: opts.embeddings });
    await ctx.remember(id, text, { kind: opts.kind, by: opts.by });
    ctx.close();
    console.error(`remembered ${opts.kind ?? "fact"} '${id}' (${text.length} chars, by ${opts.by ?? "agent"})`);
    return;
  }

  if (cmd === "forget") {
    const id = opts.words[0];
    if (!id && !opts.kind && !opts.by) fail("forget needs an id, or --kind/--by for bulk invalidation");
    const ctx = new LiteCtx({ root: opts.root });
    const removed = id ? ctx.forget(id) : ctx.forget({ kind: opts.kind, by: opts.by });
    ctx.close();
    console.error(`forgot ${removed} item${removed === 1 ? "" : "s"}`);
    if (removed === 0) process.exit(1); // nothing matched — same contract as `get` on an unknown id
    return;
  }

  if (cmd === "recent") {
    const ctx = new LiteCtx({ root: opts.root });
    const rows = ctx.recentActivity({ days: opts.since, limit: opts.n });
    ctx.close();
    if (!rows.length) {
      console.error("litectx: no recent activity — chunk-edits are recorded on incremental `index` passes (not the first/forced build), within the window");
      return;
    }
    // age \t edits \t kind \t path \t › symbol  — recency-ordered "what was I working on"
    for (const r of rows) console.log(`${relAge(r.lastEditedAt / 1000)}\t${r.edits}×\t${r.kind}\t${r.id}${r.symbol ? `\t› ${r.symbol}` : ""}`);
    return;
  }

  if (cmd === "promotions") {
    const ctx = new LiteCtx({ root: opts.root });
    const rows = opts.threshold ? ctx.promotionCandidates(opts.threshold) : ctx.promotionCandidates();
    ctx.close();
    if (!rows.length) {
      console.error("litectx: no promotion candidates — agent episodes recalled past the threshold (default 10) within the last 30 days; distil hot ones into facts");
      return;
    }
    // hits \t episode-id — the agent reads each (get <id>) and distils a fact via remember
    for (const r of rows) console.log(`${r.hits}\t${r.path}`);
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

/**
 * Render written-memory grounding (slice 5c) as a trailing column — validation status, recall-use, and
 * episode age. Surfaced for the reader to DECIDE; NEVER scored (ranking stays pure relevance). Absent
 * on indexed files (provenance/use undefined). `use:0` is meaningful — a fresh memory, not a demerit.
 * @param {import("../src/store.js").Hit} h
 */
function fmtMem(h) {
  if (h.provenance == null && h.use == null) return "";
  const parts = [];
  if (h.provenance) parts.push(h.provenance);
  if (h.use != null) parts.push(`use:${h.use}`);
  if (h.occurredAt) parts.push(relAge(h.occurredAt / 1000));
  return parts.length ? `\t${parts.join(" ")}` : "";
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
  console.error(
    "usage: litectx index [root] [--force] [--embeddings] | litectx recall <query...> [--kind <k>] [-n <n>] [--embeddings] [--no-log] | litectx get <id> [--no-log] | litectx recent [--since <days>] [-n <n>] | litectx promotions [--threshold <n>] | litectx impact <symbol> | litectx remember <id> [text...] [--kind <fact|episode|doc>] [--by <human|agent>] | litectx forget <id> | --kind/--by   (all take --root <dir>)"
  );
  process.exit(1);
}
