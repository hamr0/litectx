// litectx Slice-4 Step-0 POC — THROWAWAY. Not shipped, never imported.
//
// One question (the only thing slice 4 is gated on):
//   The original POC (run.mjs / RESULTS.md) shipped the RECENCY HALF of ACT-R
//   base-level (BLA) and it FAILED gitdone (-0.030 ALL, -0.072 HARD) — "recently
//   changed" read as "more relevant". The mandated fix (ledger §3, PRD §4) was
//   the dropped half: TYPE-DECAY + CHURN, so volatile recency is penalized.
//
//   Does git-seeded activation WITH decay+churn (NO spreading — that's slice 5)
//   beat plain BM25 on BOTH aurora AND gitdone? Adopt a weight ONLY if it is
//   >= baseline on every repo (the POC's hard rule; gitdone already vetoed flat BLA).
//
// Model (PRD §4.1.2 unification): git commits ARE the pseudo-access history.
//   BLA   = ln(Σ_j max(age_days_j,1)^-d)         over all commit timestamps (recency+freq)
//   decay = rate · log10(max(days_since_last_commit, 1)),  rate = D_CODE + 0.1·log10(commits+1)
//           (1-day floor = grace; churn raises the rate so high-commit files decay faster)
//   act   = BLA - decay     (min-max normed, then fused with BM25 — no spreading term)
//
// Honest caveat: BLA and decay-recency both reward recent commits; the only
// counterweight to "hot file looks relevant" is CHURN, which bites STALE high-churn
// files. So this may NOT fully rescue the gitdone case (recently-churned files).
// Let the data decide; also sweep a demoted BLA-only tiebreaker as the fallback.

import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DECAY_D = 0.5;        // BLA decay_rate (base_level.py:78)
const D_CODE = 0.40;        // DECAY_BY_TYPE.function/method/code (decay.py:53) — all targets are code
const CHURN_K = 0.1;        // CHURN_COEFFICIENT (decay.py:68)

// ---- tokenization (verbatim from run.mjs, the validated baseline) ----
const STOP = new Set("the a an is are be how where what when which does do i of to into for from on in it its and or s as we use used using system code module responsible".split(" "));
const splitIdent = (s) => s
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .replace(/[^A-Za-z0-9]+/g, " ")
  .toLowerCase().split(/\s+/).filter(Boolean);
const keywords = (q) => [...new Set(splitIdent(q).filter((w) => w.length >= 3 && !STOP.has(w)))];

// weight rows: [bm25, act, blaOnly] — act uses BLA-decay, blaOnly is the recency-only signal
const VARIANTS = {
  baseline: [1.0, 0.0, 0.0],
  "+bla.4": [0.6, 0.0, 0.4],   // reproduce the POC failure (recency only, flat 0.4)
  "+act.4": [0.6, 0.4, 0.0],   // full activation, co-equal (the §4 mandate at flat weight)
  "+act.3": [0.7, 0.3, 0.0],   // aurora's code activation weight (0.3)
  "+act.2": [0.8, 0.2, 0.0],   // demoted
  "+act.1": [0.9, 0.1, 0.0],   // tiebreaker
  "+bla.1": [0.9, 0.0, 0.1],   // recency-only tiebreaker (the POC's other suggestion)
};
const VNAMES = Object.keys(VARIANTS);

const minmax = (arr, get) => {
  const v = arr.map(get), lo = Math.min(...v), hi = Math.max(...v);
  return (x) => (hi > lo ? (get(x) - lo) / (hi - lo) : (arr.length === 1 ? 1 : 0));
};
const rr = (r) => (r === Infinity ? 0 : 1 / r);
const pct = (x) => (x * 100).toFixed(0).padStart(3) + "%";

const rows = []; // {name, results, agg} per repo, for the cross-repo verdict

const DATASETS = process.argv[2] ? [process.argv[2]] : ["aurora", "gitdone"];

for (const name of DATASETS) {
  const ds = (await import(`./datasets/${name}.mjs`)).default;
  const ROOT = ds.roots.find(existsSync);
  if (!ROOT) { console.log(`\n[${name}] repo not found — skipped`); continue; }
  const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8", maxBuffer: 1 << 28 });

  const files = git("ls-files", ...ds.pathspecs).trim().split("\n").filter(Boolean);
  const fileSet = new Set(files);

  // ---- git history → per-file commit timestamps (newest-first not required) ----
  const NOW = parseInt(git("log", "-1", "--format=%at").trim(), 10);
  const commits = new Map(files.map((f) => [f, []]));
  {
    const log = git("log", "--format=C%at", "--name-only", "--", ...ds.pathspecs);
    let t = null;
    for (const line of log.split("\n")) {
      if (/^C\d+$/.test(line)) { t = parseInt(line.slice(1), 10); continue; }
      if (t != null && fileSet.has(line)) commits.get(line).push(t);
    }
  }

  // ---- BLA + decay(+churn) per file (commits as pseudo-accesses, §4.1.2) ----
  const bla = new Map(), decay = new Map();
  for (const f of files) {
    const ts = commits.get(f);
    if (!ts.length) { bla.set(f, 0); decay.set(f, 0); continue; }       // untracked → neutral (§4.1.1)
    let sum = 0;
    for (const t of ts) sum += Math.pow(Math.max((NOW - t) / 86400, 1), -DECAY_D);
    bla.set(f, Math.log(sum));
    const lastCommit = Math.max(...ts);
    const daysSince = Math.max((NOW - lastCommit) / 86400, 1);          // 1-day floor ≈ grace
    const rate = D_CODE + CHURN_K * Math.log10(ts.length + 1);
    decay.set(f, rate * Math.log10(daysSince));
  }

  // ---- FTS index (path tokens folded in, same as run.mjs) ----
  const db = new Database(":memory:");
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(path UNINDEXED, txt)");
  const ins = db.prepare("INSERT INTO docs(rowid, path, txt) VALUES (?,?,?)");
  const rowToFile = [];
  db.transaction(() => {
    files.forEach((f, idx) => {
      const body = readFileSync(join(ROOT, f), "utf8");
      const pathTok = splitIdent(f).join(" ");
      ins.run(idx + 1, f, `${pathTok} ${pathTok} ${body} ${splitIdent(body).join(" ")}`);
      rowToFile[idx + 1] = f;
    });
  })();

  const matchQuery = (q) => {
    const kws = keywords(q);
    if (!kws.length) return [];
    const match = kws.map((k) => `"${k}"`).join(" OR ");
    return db.prepare("SELECT rowid, -bm25(docs) AS rel FROM docs WHERE docs MATCH ? ORDER BY rel DESC").all(match)
      .map((r) => ({ file: rowToFile[r.rowid], rel: r.rel }));
  };

  const rankOf = (list, t) => { const i = list.indexOf(t); return i < 0 ? Infinity : i + 1; };
  const results = ds.queries.map((Q) => {
    const cands = matchQuery(Q.q);
    if (!cands.length) return { ...Q, ranks: Object.fromEntries(VNAMES.map((v) => [v, Infinity])), matched: false };
    const nb = minmax(cands, (c) => c.rel);
    const feats = cands.map((c) => ({ file: c.file, bm25: nb(c), actRaw: (bla.get(c.file) ?? 0) - (decay.get(c.file) ?? 0), blaRaw: bla.get(c.file) ?? 0 }));
    const na = minmax(feats, (f) => f.actRaw);
    const nbla = minmax(feats, (f) => f.blaRaw);
    const ranks = {};
    for (const [v, w] of Object.entries(VARIANTS)) {
      const ordered = [...feats].sort((a, b) =>
        (w[0] * b.bm25 + w[1] * na(b) + w[2] * nbla(b)) - (w[0] * a.bm25 + w[1] * na(a) + w[2] * nbla(a))
      ).map((f) => f.file);
      ranks[v] = rankOf(ordered, Q.target);
    }
    return { ...Q, ranks, matched: cands.some((c) => c.file === Q.target) };
  });
  db.close();

  const agg = (rs, v) => ({
    mrr: rs.reduce((s, r) => s + rr(r.ranks[v]), 0) / rs.length,
    p1: rs.filter((r) => r.ranks[v] === 1).length / rs.length,
    p3: rs.filter((r) => r.ranks[v] <= 3).length / rs.length,
    p5: rs.filter((r) => r.ranks[v] <= 5).length / rs.length,
  });
  const table = (label, rs) => {
    console.log(`\n  ${label} (n=${rs.length})`);
    const base = agg(rs, "baseline");
    for (const v of VNAMES) {
      const m = agg(rs, v);
      const d = v === "baseline" ? "" : `   Δmrr ${m.mrr - base.mrr >= 0 ? "+" : ""}${(m.mrr - base.mrr).toFixed(3)}`;
      const flag = (v !== "baseline" && m.mrr >= base.mrr) ? "  ✓" : "";
      console.log(`    ${v.padEnd(9)} MRR ${m.mrr.toFixed(3)}  P@1 ${pct(m.p1)}  P@3 ${pct(m.p3)}  P@5 ${pct(m.p5)}${d}${flag}`);
    }
  };

  console.log(`\n[${name}] ${files.length} files · activation = BLA − (decay+churn), NO spreading`);
  table("ALL", results);
  table("HARD", results.filter((r) => r.diff === "hard"));
  rows.push({ name, results, agg });
}

// ---- verdict: which weight is >= baseline ALL-MRR on EVERY repo? ----
console.log(`\n${"=".repeat(64)}\nVERDICT — adopt only weights >= baseline on EVERY repo (ALL MRR):`);
for (const v of VNAMES) {
  if (v === "baseline") continue;
  const perRepo = rows.map(({ name, results, agg }) => {
    const b = agg(results, "baseline").mrr, m = agg(results, v).mrr;
    return { name, ok: m >= b, delta: m - b };
  });
  const all = perRepo.every((r) => r.ok);
  console.log(`  ${all ? "✓ ADOPTABLE" : "✗ rejected  "}  ${v.padEnd(8)}  ${perRepo.map((r) => `${r.name} ${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(3)}`).join("   ")}`);
}
console.log();
