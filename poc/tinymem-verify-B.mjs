// usage: LC=<repo> MODE=<pyonly|mixed|mixed-nomd> node poc/tinymem-verify-B.mjs
import { existsSync } from "node:fs";
const { LiteCtx } = await import(process.env.LC + "/src/index.js");
const ds = (await import("./datasets/aurora-mixed.mjs")).default;
const MODE = process.env.MODE;
const root = ds.roots.find(existsSync);
const inc = MODE === "pyonly" ? [".py"] : ds.include;
const ps = MODE === "pyonly" ? ["*.py"] : ds.pathspecs;
const ctx = new LiteCtx({ root, include: inc, pathspecs: ps, dbPath: ":memory:" });
await ctx.index();
if (MODE === "mixed-nomd") ctx.store.db.exec("DELETE FROM docs WHERE source='file' AND format='md'"); // md rows live in a separate table: code BM25 sees code rows only
const rows = []; let leaks = 0;
for (const Q of ds.queries) {
  const hits = await ctx.recall(Q.q, { kind: "code", n: 100 });
  leaks += hits.filter((h) => !/\.py$/.test(h.path)).length;
  const i = hits.findIndex((h) => h.path === Q.target);
  rows.push({ q: Q.q, diff: Q.diff, rank: i < 0 ? Infinity : i + 1 });
}
const rr = (r) => (r === Infinity ? 0 : 1 / r);
const agg = (rs) => `MRR ${(rs.reduce((s, r) => s + rr(r.rank), 0) / rs.length).toFixed(3)} P@5 ${Math.round(100 * rs.filter((r) => r.rank <= 5).length / rs.length)}%`;
console.error(`${MODE} ALL ${agg(rows)} | HARD ${agg(rows.filter((r) => r.diff === "hard"))} | non-.py hits in kind:code: ${leaks}`);
console.log(JSON.stringify(rows.map((r) => [r.q.slice(0, 50), r.diff, r.rank === Infinity ? 999 : r.rank])));
