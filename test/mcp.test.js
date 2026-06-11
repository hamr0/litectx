// Slice 10 integration tests — the MCP surface (bin/litectx-mcp.js). Behavior, not implementation:
// a REAL server process spawned per test, spoken to over stdio in newline-delimited JSON-RPC,
// exactly as an MCP client would. The load-bearing invariants: the handshake is spec-shaped; the
// tools are the public operations (parity); tool failures are `isError` results, never
// protocol errors; responses are matched by id (they may legally return out of order); and the
// audit-log defaults hold over MCP — an MCP client is live agent demand, so recall logs demand
// and get logs a tagged fetch, with no opt-out exposed on this surface.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LiteCtx } from "../src/index.js";

const SERVER = fileURLToPath(new URL("../bin/litectx-mcp.js", import.meta.url));

/** Build a throwaway repo on disk; returns its root. */
function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "litectx-mcp-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "auth.js"), "export function validateToken(t){ return t.length > 0; }\n");
  writeFileSync(join(root, "src", "app.js"), 'import { validateToken } from "./auth.js";\nexport function login(t){ return validateToken(t); }\n');
  writeFileSync(join(root, "README.md"), "# Demo\nAuthentication uses signed tokens.\n");
  return root;
}

/**
 * Spawn a real server on a fixture root; returns a tiny by-id JSON-RPC client. Registers a
 * kill-on-teardown so a failed assertion never strands the child (which would hang the runner).
 * @param {string} root @param {import("node:test").TestContext} t
 */
function client(root, t) {
  // --no-embeddings: these tests assert protocol + BM25 mechanics, not semantic quality, so keep
  // them deterministic and independent of the optional model dep (embeddings are ON by default now).
  const proc = spawn(process.execPath, [SERVER, "--root", root, "--no-embeddings"], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => proc.kill()); // no-op when the test already closed it cleanly
  /** @type {Map<number, (msg: any) => void>} */
  const pending = new Map();
  /** @type {any[]} responses addressed to no live request (e.g. parse errors with id null) */
  const orphans = [];
  createInterface({ input: proc.stdout }).on("line", (line) => {
    const msg = JSON.parse(line); // stdout must be protocol-pure — anything else fails the test here
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    } else {
      orphans.push(msg);
    }
  });
  let nextId = 1;
  return {
    orphans,
    /** @param {string} method @param {any} [params] @returns {Promise<any>} the response, matched by id */
    request(method, params) {
      const id = nextId++;
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return new Promise((resolve) => pending.set(id, resolve));
    },
    /** @param {string} raw send a raw line (malformed on purpose) */
    raw(raw) {
      proc.stdin.write(raw + "\n");
    },
    /** spec handshake: initialize, then the initialized notification */
    async init() {
      const r = await this.request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      return r;
    },
    /** close stdin (client hang-up) and wait for the clean exit the server promises */
    close() {
      proc.stdin.end();
      return new Promise((resolve) => proc.on("exit", resolve));
    },
  };
}

/** Unwrap a tools/call response: assert it's a non-error result and return its text. @param {any} res */
function toolText(res, label = "") {
  assert.equal(res.error, undefined, `${label}: protocol error ${JSON.stringify(res.error)}`);
  assert.equal(res.result.isError, false, `${label}: tool error: ${res.result.content?.[0]?.text}`);
  return res.result.content[0].text;
}

test("handshake is spec-shaped and tools/list exposes the public operations", async (t) => {
  const root = fixtureRepo();
  const c = client(root, t);
  const init = await c.init();
  assert.equal(init.result.serverInfo.name, "litectx");
  assert.equal(init.result.protocolVersion, "2025-03-26", "echoes the client's version");
  assert.ok(init.result.capabilities.tools, "advertises the tools capability");
  const list = await c.request("tools/list");
  assert.deepEqual(
    list.result.tools.map((/** @type {{name: string}} */ t) => t.name).sort(),
    ["forget", "get", "impact", "index", "promotions", "recall", "recent", "remember"],
    "MCP surface = library surface, nothing more"
  );
  for (const t of list.result.tools) assert.ok(t.description && t.inputSchema, `${t.name} is self-describing`);
  const exit = await c.close();
  assert.equal(exit, 0, "client hang-up → clean shutdown");
  rmSync(root, { recursive: true, force: true });
});

test("the read loop over MCP: index → recall returns pointers → get returns the body fresh from disk", async (t) => {
  const root = fixtureRepo();
  const c = client(root, t);
  await c.init();
  const idx = JSON.parse(toolText(await c.request("tools/call", { name: "index", arguments: {} }), "index"));
  assert.equal(idx.files, 3);
  const hits = JSON.parse(toolText(await c.request("tools/call", { name: "recall", arguments: { query: "validate token", kind: "code", n: 2 } }), "recall"));
  // the adapter is under test, not the ranking (the lib's benches own that): hits arrive as
  // scored pointers and the defining file is among them
  assert.ok(hits.every((/** @type {{path: string, score: number}} */ h) => h.path && typeof h.score === "number"), "scored pointers");
  assert.ok(hits.some((/** @type {{path: string}} */ h) => h.path === "src/auth.js"), "the defining file is found");
  const item = JSON.parse(toolText(await c.request("tools/call", { name: "get", arguments: { id: "src/auth.js" } }), "get"));
  assert.equal(item.text, readFileSync(join(root, "src", "auth.js"), "utf8"));
  await c.close();
  rmSync(root, { recursive: true, force: true });
});

test("impact over MCP reports the caller and a risk bucket", async (t) => {
  const root = fixtureRepo();
  const c = client(root, t);
  await c.init();
  toolText(await c.request("tools/call", { name: "index", arguments: {} }), "index");
  const r = JSON.parse(toolText(await c.request("tools/call", { name: "impact", arguments: { symbol: "validateToken" } }), "impact"));
  assert.equal(r.symbol, "validateToken");
  assert.ok(["low", "medium", "high"].includes(r.risk));
  assert.ok(r.callers.some((/** @type {{path: string}} */ x) => x.path === "src/app.js"), "the importing caller is found");
  await c.close();
  rmSync(root, { recursive: true, force: true });
});

test("the write loop over MCP: remember → recall finds it → get verbatim → forget → gone", async (t) => {
  const root = fixtureRepo();
  const c = client(root, t);
  await c.init();
  const text = "Authentication uses JWT tokens verified in middleware.";
  toolText(await c.request("tools/call", { name: "remember", arguments: { id: "fact:auth", text, by: "human" } }), "remember");
  const hits = JSON.parse(toolText(await c.request("tools/call", { name: "recall", arguments: { query: "JWT middleware", kind: "fact" } }), "recall"));
  assert.equal(hits[0].path, "fact:auth");
  const item = JSON.parse(toolText(await c.request("tools/call", { name: "get", arguments: { id: "fact:auth" } }), "get"));
  assert.equal(item.text, text, "verbatim, and provenance rides along");
  assert.equal(item.provenance, "human");
  assert.match(toolText(await c.request("tools/call", { name: "forget", arguments: { id: "fact:auth" } }), "forget"), /forgot 1 item/);
  const gone = await c.request("tools/call", { name: "get", arguments: { id: "fact:auth" } });
  assert.equal(gone.result.isError, true, "forgotten → get is a tool error");
  await c.close();
  rmSync(root, { recursive: true, force: true });
});

test("failures stay in-band: tool errors are isError results, unknown methods are protocol errors, garbage doesn't kill the loop", async (t) => {
  const root = fixtureRepo();
  const c = client(root, t);
  await c.init();
  // tool-level failure → isError result, NOT a protocol error (the agent reads it and self-corrects)
  const bad = await c.request("tools/call", { name: "get", arguments: { id: "fact:never" } });
  assert.equal(bad.error, undefined);
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /not in the index/);
  const unkTool = await c.request("tools/call", { name: "explode", arguments: {} });
  assert.equal(unkTool.result.isError, true);
  // protocol-level failures
  const unkMethod = await c.request("resources/list");
  assert.equal(unkMethod.error.code, -32601);
  c.raw("this is not json");
  // the loop survives both — a later request still answers
  const ping = await c.request("ping");
  assert.deepEqual(ping.result, {});
  const parseErr = c.orphans.find((m) => m.error?.code === -32700);
  assert.ok(parseErr, "malformed line → -32700 with id null");
  await c.close();
  rmSync(root, { recursive: true, force: true });
});

test("responses are matched by id, not arrival order — a sync get may answer before an in-flight recall", async (t) => {
  const root = fixtureRepo();
  const c = client(root, t);
  await c.init();
  toolText(await c.request("tools/call", { name: "index", arguments: {} }), "index");
  // fire both without awaiting: recall is async (kind-by-kind ranking), get is sync
  const [recallRes, getRes] = await Promise.all([
    c.request("tools/call", { name: "recall", arguments: { query: "signed tokens", kind: "doc" } }),
    c.request("tools/call", { name: "get", arguments: { id: "README.md" } }),
  ]);
  assert.equal(JSON.parse(toolText(recallRes, "recall"))[0].path, "README.md");
  assert.match(toolText(getRes, "get"), /Authentication uses signed tokens/);
  await c.close();
  rmSync(root, { recursive: true, force: true });
});

test("audit-log parity over MCP: recall writes demand, get writes a tagged fetch (no opt-out on this surface)", async (t) => {
  const root = fixtureRepo();
  const c = client(root, t);
  await c.init();
  toolText(await c.request("tools/call", { name: "remember", arguments: { id: "fact:demand", text: "Recall demand flows through MCP unchanged." } }), "remember");
  toolText(await c.request("tools/call", { name: "recall", arguments: { query: "recall demand", kind: "fact" } }), "recall");
  toolText(await c.request("tools/call", { name: "get", arguments: { id: "fact:demand" } }), "get");
  await c.close(); // release the db before inspecting it
  const ctx = new LiteCtx({ root });
  const rows = /** @type {{ action: string, n: number }[]} */ (
    ctx.store.db.prepare("SELECT action, count(*) AS n FROM recall_log WHERE path = 'fact:demand' GROUP BY action").all()
  );
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.action, r.n])), { recall: 1, fetch: 1 });
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});
