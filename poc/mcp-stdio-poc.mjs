#!/usr/bin/env node
// POC (slice 10 gate): can a HAND-ROLLED stdio MCP server — vanilla JS, zero new deps —
// satisfy a real MCP client? Newline-delimited JSON-RPC 2.0 per the MCP stdio transport.
// Exposes two tools (recall, get) over the real lib. Throwaway — never ship the POC.
//
//   node poc/mcp-stdio-poc.mjs [--root <dir>]
//
// stdout = protocol ONLY; everything human goes to stderr.

import { createInterface } from "node:readline";
import { LiteCtx, KINDS } from "../src/index.js";

const root = process.argv.includes("--root")
  ? process.argv[process.argv.indexOf("--root") + 1]
  : process.cwd();
const ctx = new LiteCtx({ root });

const TOOLS = [
  {
    name: "recall",
    description:
      "Ranked search over the indexed repo + written memory (BM25 + spreading). Returns scored pointers (path/id + chunk); use `get` to fetch a body.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "search query" },
        kind: { type: "string", enum: [...KINDS], description: "optional: restrict to one kind" },
        n: { type: "number", description: "max hits (per kind when unscoped)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get",
    description:
      "Fetch the full body for an id returned by recall — a written-memory id verbatim, or an indexed file fresh from disk.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "written-memory id or indexed file path" } },
      required: ["id"],
    },
  },
];

/** @param {string} name @param {any} args */
async function callTool(name, args) {
  if (name === "recall") {
    const r = await ctx.recall(args.query, { kind: args.kind, n: args.n });
    return JSON.stringify(r, null, 1);
  }
  if (name === "get") {
    const item = ctx.get(args.id);
    if (!item) throw new Error(`'${args.id}' is not in the index`);
    return JSON.stringify(item, null, 1);
  }
  throw new Error(`unknown tool: ${name}`);
}

/** @param {any} msg */
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

/** @param {any} req */
async function handle(req) {
  const { id, method, params } = req;
  if (method === "initialize") {
    return send({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "litectx-mcp-poc", version: "0.0.0" },
      },
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return; // notifications: no response
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") {
    try {
      const text = await callTool(params.name, params.arguments ?? {});
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: false } });
    } catch (e) {
      // tool-level failure = result with isError, NOT a protocol error (MCP spec)
      const text = e instanceof Error ? e.message : String(e);
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });
    }
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }
  handle(req).catch((e) => console.error("litectx-mcp-poc:", e));
});
rl.on("close", () => { ctx.close(); process.exit(0); });
console.error(`litectx-mcp-poc: serving ${root} on stdio`);
