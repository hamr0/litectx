#!/usr/bin/env node
// MCP surface over the library — the agent-client consumption surface (PRD §14 #5, slice 10).
// A hand-rolled stdio MCP server: newline-delimited JSON-RPC 2.0, client-spawned, NOT a daemon
// (compatible with "no service tier"). Like the CLI, this is a thin adapter over the public API —
// it imports the lib exactly as an external consumer would; nothing in src/ knows it exists.
// No SDK: the protocol loop (initialize / tools/list / tools/call / ping) is under 100 lines,
// which is below the external-dependency bar. POC-validated against a real client
// (Claude Code via --mcp-config) before this was built.
//
//   litectx-mcp [--root <dir>] [--no-embeddings]   # embeddings (semantic recall) ON by default
//
// Client config (claude code, cursor, etc.):
//   { "mcpServers": { "litectx": { "command": "litectx-mcp", "args": ["--root", "/path/to/repo"] } } }
//
// stdout carries protocol ONLY; anything human goes to stderr. Tool failures return
// `isError: true` results (per spec) — protocol errors are reserved for malformed JSON-RPC.
// The audit-log defaults stand (recall logs demand, get logs a tagged fetch): an MCP client is a
// live agent, i.e. exactly the demand the log exists to capture — so no log opt-out is exposed
// here. Dashboards and batch tooling should use the lib or CLI (`--no-log`), not MCP.

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { LiteCtx, KINDS } from "../src/index.js";

// version for serverInfo — fs read, not a JSON import (import attributes need Node ≥20.10; engines floor is 18)
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** @param {string} flag @returns {string|undefined} */
const flagValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};
const root = flagValue("--root") ?? process.cwd();
const ctx = new LiteCtx({ root, embeddings: !process.argv.includes("--no-embeddings") });

// The public operations, verbatim — the MCP surface IS the library surface (parity).
const TOOLS = [
  {
    name: "index",
    description:
      "Build or incrementally refresh the repo index (only changed files are re-read). Run once before the first recall, and again after editing files. `force: true` rebuilds every file from disk (written memory always survives).",
    inputSchema: {
      type: "object",
      properties: { force: { type: "boolean", description: "full rebuild instead of incremental" } },
    },
  },
  {
    name: "recall",
    description:
      "Ranked search over the indexed repo + written memory (BM25 + import-graph spreading). Returns scored POINTERS — paths/ids with a chunk locator — not bodies; follow up with `get` on a hit's path to read one. Omit `kind` to get top hits grouped per kind (code/doc/fact/episode). Written-memory hits also carry `provenance` (human = a person signed off; agent = your own past assertion, maybe worth re-verifying — NOT a quality rank), `use` (how often recalled; 0 can be a fresh win, not a demerit), and `occurredAt` (episodes). Ranking is pure relevance — these columns are for YOU to weigh, never a thumb on the scale.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "search query (plain words work best)" },
        kind: { type: "string", enum: [...KINDS], description: "restrict to one kind → flat ranked list" },
        n: { type: "number", description: "max hits (per kind when grouped; default 5 grouped / 10 flat)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get",
    description:
      "Fetch the body for an id returned by recall — a written-memory id verbatim as remembered, or an indexed file's repo-relative path read fresh from disk. To read ONE chunk instead of the whole file, pass startLine/endLine copied verbatim from that hit's `chunk` — a recall hit points at a symbol, and this is how you read just that symbol without dragging its whole file through context. Copy the numbers; never compute or widen them.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "written-memory id or indexed file path" },
        startLine: { type: "number", description: "0-based, inclusive — copy from a recall hit's chunk.startLine. Requires endLine." },
        endLine: { type: "number", description: "0-based, inclusive — copy from a recall hit's chunk.endLine. Requires startLine." },
      },
      required: ["id"],
    },
  },
  {
    name: "recent",
    description:
      "\"What was I working on\" — the code/doc chunks litectx most recently saw edited (newest first), within a recency window. Isolated from recall: it reads the witnessed edit log, never search ranking. Returns {id, symbol, kind, lastEditedAt, edits}; `id` is a path you can `get`. Empty until edits are observed on an incremental index pass (the first/forced build records nothing).",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "lookback window in days (default 7)" },
        limit: { type: "number", description: "max rows (default 20)" },
      },
    },
  },
  {
    name: "promotions",
    description:
      "Episode promotion candidates — agent-written episodes recalled past a threshold (default 10) within the last 30 days, i.e. the scratchpad notes worth distilling into durable facts. The intended loop is YOURS: read each (get its id), then write a distilled fact with remember(kind:'fact', by:'agent'). litectx only flags; it never summarizes. Returns { path, hits }; hits gates distillation, never ranking.",
    inputSchema: {
      type: "object",
      properties: { threshold: { type: "number", description: "min recall hits to flag an episode (default 10)" } },
    },
  },
  {
    name: "impact",
    description:
      "Blast radius for a symbol defined in the indexed repo: callers (called-by), callees, reference count, and a low/med/high change-risk bucket. Use before modifying a function to see what depends on it.",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string", description: "function/class name as defined in the code" } },
      required: ["symbol"],
    },
  },
  {
    name: "remember",
    description:
      "Write a memory with no file behind it: a durable `fact`, a timestamped `episode`, or a direct `doc`. Upserts by id — re-remembering an existing id revises it. Namespace ids, e.g. `fact:auth-uses-jwt`.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "stable id, namespaced (fact:..., ep:...)" },
        text: { type: "string", description: "the content, stored verbatim" },
        kind: { type: "string", enum: ["fact", "episode", "doc"], description: "default fact" },
        by: { type: "string", enum: ["human", "agent"], description: "provenance (default agent). Use human ONLY for content a human stated." },
      },
      required: ["id", "text"],
    },
  },
  {
    name: "forget",
    description:
      "Hard-delete written memory (never touches indexed files). Pass `id` to drop one item, or `kind`/`by` to bulk-drop (e.g. every agent-asserted fact). Returns the count removed.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "one written-memory id" },
        kind: { type: "string", enum: ["fact", "episode", "doc"], description: "bulk: drop a whole kind" },
        by: { type: "string", enum: ["human", "agent"], description: "bulk: drop by provenance" },
      },
    },
  },
];

/**
 * Dispatch one tools/call to the library. Returns the result as display text; throws on tool
 * failure (mapped to an `isError` result by the caller, never a protocol error).
 * @param {string} name @param {any} a @returns {Promise<string>}
 */
async function callTool(name, a) {
  if (name === "index") return JSON.stringify(await ctx.index({ force: a.force === true }));
  if (name === "recall") return JSON.stringify(await ctx.recall(a.query, { kind: a.kind, n: a.n }), null, 1);
  if (name === "get") {
    const chunked = a.startLine != null || a.endLine != null;
    if (chunked && (a.startLine == null || a.endLine == null)) throw new Error("startLine and endLine must be passed together");
    // StalePointerError surfaces as-is: its message tells the agent to re-index, which is the fix.
    const item = ctx.get(a.id, chunked ? { startLine: a.startLine, endLine: a.endLine } : {});
    if (!item) {
      throw new Error(
        chunked
          ? `no chunk at ${a.startLine}-${a.endLine} in '${a.id}' — copy startLine/endLine from a recall hit's chunk`
          : `'${a.id}' is not in the index — ids come from recall hits`,
      );
    }
    if (item.text == null) throw new Error(`'${a.id}' is indexed but missing from disk (stale until the next index)`);
    return JSON.stringify(item, null, 1);
  }
  if (name === "recent") return JSON.stringify(ctx.recentActivity({ days: a.days, limit: a.limit }), null, 1);
  if (name === "promotions") return JSON.stringify(a.threshold ? ctx.promotionCandidates(a.threshold) : ctx.promotionCandidates(), null, 1);
  if (name === "impact") {
    const r = await ctx.impact(a.symbol);
    if (!r) throw new Error(`'${a.symbol}' is not defined in the index — run the index tool, or check the name`);
    return JSON.stringify(r, null, 1);
  }
  if (name === "remember") {
    await ctx.remember(a.id, a.text, { kind: a.kind, by: a.by });
    return `remembered ${a.kind ?? "fact"} '${a.id}'`;
  }
  if (name === "forget") {
    const removed = a.id ? ctx.forget(a.id) : ctx.forget({ kind: a.kind, by: a.by });
    return `forgot ${removed} item${removed === 1 ? "" : "s"}`;
  }
  throw new Error(`unknown tool: ${name}`);
}

/** @param {any} msg */
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

/** @param {{ id?: any, method: string, params?: any }} req */
async function handle(req) {
  const { id, method, params } = req;
  if (method === "initialize") {
    return send({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "litectx", version: pkg.version },
      },
    });
  }
  if (method.startsWith("notifications/")) return; // notifications never get a response
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") {
    try {
      const text = await callTool(params.name, params.arguments ?? {});
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: false } });
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });
    }
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  /** @type {any} */
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }
  // responses may return out of order (sync tools beat async ones) — legal: clients match by id
  handle(req).catch((e) => console.error("litectx-mcp:", e instanceof Error ? e.message : e));
});
// client hung up → clean shutdown (the client owns this process's lifecycle)
rl.on("close", () => {
  ctx.close();
  process.exit(0);
});
console.error(`litectx-mcp ${pkg.version}: serving ${root} on stdio`);
