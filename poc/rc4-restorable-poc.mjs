// R-C4 POC — does litectx already cover restorable compression (store payload → handle → rehydrate),
// or does it need new surface? Hypothesis: remember=store, get=rehydrate already exist; the only gap
// is that the existing KINDS carry recall/decay/review semantics a "dropped payload kept only to
// restore" doesn't want. Probe: (1) round-trip, (2) does the blob pollute recall, (3) can it be pruned.
// Stupidly simple, hardcoded, no tests — AGENT_RULES POC. Run: node poc/rc4-restorable-poc.mjs
import { LiteCtx } from "../src/index.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "rc4-"));
const ctx = new LiteCtx({ root, dbPath: ":memory:", embeddings: false });

const big = "FATAL: connection pool exhausted at worker 7\n" + "routine log line ".repeat(2000);
const id = "episode:toolresult-1";

// --- (1) HAPPY PATH: store the payload (handle = the id the harness keeps), then rehydrate ---
await ctx.remember(id, big, { kind: "episode", by: "agent" });
const stub = { id, bytes: Buffer.byteLength(big), head: big.split("\n")[0] }; // harness computes from text it holds
const back = ctx.get(id);
console.log("[1] stub kept in window:", JSON.stringify(stub));
console.log("[1] rehydrate round-trips:", back?.text === big);

// --- (2) EDGE: does the stored blob pollute recall ranking? (it shouldn't compete with real memory) ---
await ctx.remember("fact:real-knowledge", "the auth token is validated in validateToken", { kind: "fact", by: "human" });
const hits = await ctx.recall("connection pool exhausted at worker", { kind: "episode" });
console.log("[2] blob surfaces in recall:", hits.some((h) => h.path === id), "→ paths:", hits.map((h) => h.path));

// --- (3) EDGE: is an episode-stored payload safe from the rolling-window prune? ---
// re-store backdated past the active window, then a fresh episode write triggers pruneStaleEpisodes
await ctx.remember(id, big, { kind: "episode", by: "agent", occurredAt: Date.now() - 365 * 24 * 3600 * 1000 });
await ctx.remember("episode:unrelated", "later activity", { kind: "episode", by: "agent" });
const after = ctx.get(id);
console.log("[3] payload survives a later episode write:", after != null && after.text === big);

ctx.close();
