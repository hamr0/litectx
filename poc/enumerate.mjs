// POC (bareagent RLM `scan` — litectx-enumerate-spec §4): does `enumerate` give an EXHAUSTIVE, gapless,
// scope-fenced, deterministic, rank-free page-walk that `recall` STRUCTURALLY cannot? Able-to-fail:
// code-computes ground truth, asserts against it, and runs the named MUTANT for each property to prove the
// check actually discriminates (a test that can't go red proves nothing — AGENT_RULES prove-don't-assert).
//
//   node poc/enumerate.mjs        → exit 0 all green / exit 1 on any failure
//
// NOTE this is a correctness harness, not an empirical gate: the "retrieval can't count" claim is already
// proven upstream (bareagent §9.2.1); here we only re-prove the gap at the litectx layer + lock the fence.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LiteCtx, GLOBAL } from "../src/index.js";

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  PASS  ${name}`); return; }
  failed++; console.log(`  FAIL  ${name}${detail ? "  — " + detail : ""}`);
}

const root = process.cwd();
const N = 1000;
// half the rows mention "sports" in their text, half mention nothing recall('sports') can hit — that tail
// is exactly what enumerate must return and recall(big-n) must miss.
const mkText = (i) => (i % 2 === 0 ? `record ${i} about sports leagues` : `record ${i} zzqx unrelated payload`);

// ── seed a KNOWN corpus in one in-memory store ──────────────────────────────────────────────────────────
const ctx = new LiteCtx({ root, dbPath: ":memory:", embeddings: false });
const truth = new Set();
for (let i = 0; i < N; i++) { const id = `fact:${i}`; truth.add(id); await ctx.remember(id, mkText(i), { kind: "fact" }); }

// page-walk helper → ordered id list (the consumer's union). Also asserts pages never exceed `limit`.
async function drain(c, kind, limit = 100, scope) {
  const ids = []; let off = 0, page, guard = 0;
  do {
    page = await c.enumerate(scope === undefined ? { kind, offset: off, limit } : { kind, offset: off, limit, scope });
    if (page.items.length > limit) throw new Error(`page exceeded limit (${page.items.length} > ${limit})`);
    page.items.forEach((it) => ids.push(it.path));
    off = page.nextOffset;
    if (++guard > 10 * N) throw new Error("walk did not terminate"); // nextOffset never reaching null
  } while (off !== null);
  return ids;
}

console.log("\nTEST 1 — COMPLETENESS & GAPLESS (the core)");
{
  const ids = await drain(ctx, "fact");
  const seen = new Set(ids);
  check("union == truth (complete)", seen.size === truth.size && [...truth].every((id) => seen.has(id)), `seen ${seen.size} / truth ${truth.size}`);
  check("no duplicate row across pages", ids.length === seen.size, `emitted ${ids.length}, distinct ${seen.size}`);
  // MUTANT: enumerate-as-recall(q,{n:1e6}). Tail rows ("zzqx", no overlap with a real query) drop out.
  const recHits = await ctx.recall("sports", { kind: "fact", n: 1_000_000 });
  const mutantSeen = new Set(recHits.map((h) => h.path));
  check("MUTANT recall(big-n) is RED here (misses the tail)", mutantSeen.size < truth.size, `recall saw ${mutantSeen.size} of ${truth.size}`);
}

console.log("\nTEST 2 — DOES WHAT RECALL CANNOT");
{
  const rec = await ctx.recall("sports", { kind: "fact", n: N });
  const enumSet = new Set(await drain(ctx, "fact"));
  const recSet = new Set(rec.map((h) => h.path));
  const strictSubset = [...recSet].every((p) => enumSet.has(p)) && recSet.size < enumSet.size;
  check("recall(big-n) set ⊊ enumerate set", strictSubset, `recall ${recSet.size} ⊊ enum ${enumSet.size}`);
}

console.log("\nTEST 3 — SCOPE ISOLATION (correctness/IDOR)");
{
  const dir = mkdtempSync(join(tmpdir(), "litectx-enum-"));
  const dbPath = join(dir, "scope.db");
  try {
    const a = new LiteCtx({ root, dbPath, owner: "A" });
    const b = new LiteCtx({ root, dbPath, owner: "B" });
    await a.remember("fact:ownA", "alpha", { kind: "fact" });
    await b.remember("fact:secretB", "beta", { kind: "fact" });
    await a.scoped(GLOBAL).remember("fact:shared", "gamma", { kind: "fact" }); // shared tier
    const aSeen = new Set(await drain(a, "fact"));
    check("A sees its own row", aSeen.has("fact:ownA"));
    check("A sees the shared/global row", aSeen.has("fact:shared"));
    check("A never enumerates B's row", !aSeen.has("fact:secretB"), [...aSeen].join(","));
    check("A.total == A's scoped count (own + shared = 2)", (await a.enumerate({ kind: "fact", offset: 0, limit: 100 })).total === 2);
    // MUTANT: drop the mem_scope fence → raw read leaks B. Proves the fence is load-bearing.
    const raw = a.store.db.prepare("SELECT path FROM mem WHERE kind='fact'").all().map((r) => r.path);
    check("MUTANT unfenced raw read IS RED (leaks B)", raw.some((p) => p.includes("secretB")), raw.join(","));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("\nTEST 4 — DETERMINISTIC ORDER");
{
  const w1 = await drain(ctx, "fact");
  const w2 = await drain(ctx, "fact");
  check("two full walks are byte-identical", w1.length === w2.length && w1.every((id, i) => id === w2[i]));
}

console.log("\nTEST 5 — BODY FIDELITY");
{
  const page = await ctx.enumerate({ kind: "fact", offset: 0, limit: 5, body: true });
  let ok = page.items.length === 5;
  for (const it of page.items) {
    const got = ctx.get(it.path); // verbatim record by id
    if (!got || got.text !== it.body) { ok = false; break; }
  }
  check("body:true === get(id).text verbatim", ok);
  const noBody = await ctx.enumerate({ kind: "fact", offset: 0, limit: 5 });
  check("body:false omits the body (pointers only)", noBody.items.every((it) => it.body === undefined));
}

console.log("\nTEST 6 — EMBEDDINGS-AGNOSTIC (not a ranking op)");
{
  const dir = mkdtempSync(join(tmpdir(), "litectx-enum-emb-"));
  try {
    const mk = async (emb, p) => {
      const c = new LiteCtx({ root, dbPath: join(dir, p), embeddings: emb });
      for (let i = 0; i < 50; i++) await c.remember(`fact:${i}`, mkText(i), { kind: "fact" });
      return drain(c, "fact");
    };
    const offIds = await mk(false, "off.db");
    const onIds = await mk(true, "on.db");
    check("embeddings on vs off → identical id order", offIds.length === onIds.length && offIds.every((id, i) => id === onIds[i]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("\nTEST 7 — total / nextOffset CORRECT");
{
  const total = ctx.count({ kind: "fact" });
  check("total === count(kind)", (await ctx.enumerate({ kind: "fact", offset: 0, limit: 100 })).total === total, `${total}`);
  // last page must have nextOffset === null exactly, no premature stop / no dupe page
  const lastOff = Math.floor((total - 1) / 100) * 100;
  const last = await ctx.enumerate({ kind: "fact", offset: lastOff, limit: 100 });
  check("nextOffset === null exactly at the last page", last.nextOffset === null, `nextOffset=${last.nextOffset}`);
  const penult = await ctx.enumerate({ kind: "fact", offset: lastOff - 100, limit: 100 });
  check("nextOffset advances by items.length mid-walk", penult.nextOffset === lastOff);
  const past = await ctx.enumerate({ kind: "fact", offset: total + 500, limit: 100 });
  check("offset past end → empty page, nextOffset null", past.items.length === 0 && past.nextOffset === null);
}

console.log("\nTEST 8 — NO DEMAND-SIGNAL POLLUTION");
{
  const logCount = () => ctx.store.db.prepare("SELECT count(*) AS n FROM recall_log").get().n;
  const before = logCount();
  await drain(ctx, "fact");
  check("a full walk writes ZERO recall_log rows", logCount() === before, `${before} → ${logCount()}`);
}

console.log("\nGUARD — input validation");
{
  const throws = async (fn) => { try { await fn(); return false; } catch { return true; } };
  check("kind:'doc' rejected (v1 mem-axis only)", await throws(() => ctx.enumerate({ kind: "doc" })));
  check("negative offset rejected", await throws(() => ctx.enumerate({ kind: "fact", offset: -1 })));
  check("limit:0 rejected", await throws(() => ctx.enumerate({ kind: "fact", limit: 0 })));
}

console.log(`\n${failed === 0 ? "ALL GREEN" : failed + " FAILED"}`);
process.exit(failed === 0 ? 0 : 1);
