// POC (throwaway, PRD §14 #4 / §11.3): does the FULL ACT-R base-level activation predict the next
// commit's edits better than the naive baselines the ledger blames for the original falsification?
//
// Git-replay next-edit oracle (non-circular: the edit stream AND the prediction target both come
// from real commit history, independent of any relevance label). Walk commits in time order; after
// a warmup, at each commit N score every previously-seen file by activation computed ONLY from edits
// in commits < N, and measure how well each scorer ranks the files actually edited in commit N
// (AUC = P[random edited-next file outscores a random not-edited-next one]; 0.5 = chance).
//
// Scorers: freq (raw count, no decay) · recency (age_last^-d — the "half-formula") · BLA
// (ln(Σ_j age_j^-d) — aurora base_level.py, bucketed count·t^-d with count=1 per event). If
// BLA > recency > freq > 0.5, the full formula earns its complexity (the ledger's thesis). If all
// ≈ 0.5, the edit-bind ships at zero. Usage: node poc/edit-bind-poc.mjs [repoPath] [extGlob]
import { execFileSync } from "node:child_process";

const repo = process.argv[2] ?? "/home/hamr/PycharmProjects/aurora";
const ext = process.argv[3] ?? "*.py";
const D = 0.5; // aurora decay_rate

// ---- parse the commit stream: chronological [{ t, files[] }] touching `ext` ----
const raw = execFileSync(
  "git", ["-C", repo, "log", "--reverse", "--no-merges", "--pretty=format:C %ct", "--name-only", "--", ext],
  { encoding: "utf8", maxBuffer: 1 << 28 },
);
const commits = [];
for (const line of raw.split("\n")) {
  if (line.startsWith("C ")) commits.push({ t: +line.slice(2), files: [] });
  else if (line.trim() && commits.length) commits[commits.length - 1].files.push(line.trim());
}
const valid = commits.filter((c) => c.files.length);
console.log(`${repo.split("/").pop()}  ${valid.length} commits touching ${ext}  (warmup = first 40%)`);

// ---- scorers, each from a file's prior edit timestamps + the query time tNow ----
const freq = (ts) => ts.length;
const recency = (ts, tNow) => Math.max(tNow - ts[ts.length - 1], 1) ** -D;
const bla = (ts, tNow) => Math.log(ts.reduce((s, t) => s + Math.max(tNow - t, 1) ** -D, 0));
const SCORERS = { freq, recency, bla };

// ---- rank-based AUC with tie handling (Mann–Whitney) ----
function auc(scores, isPos) {
  const idx = scores.map((s, i) => [s, isPos[i]]).sort((a, b) => a[0] - b[0]);
  let rankSum = 0, P = 0, N = 0, i = 0;
  while (i < idx.length) {
    let j = i; while (j < idx.length && idx[j][0] === idx[i][0]) j++;
    const avgRank = (i + 1 + j) / 2; // average rank for the tie group (1-based)
    for (let k = i; k < j; k++) if (idx[k][1]) { rankSum += avgRank; P++; } else N++;
    i = j;
  }
  return P && N ? (rankSum - (P * (P + 1)) / 2) / (P * N) : null;
}

// ---- replay ----
const history = new Map(); // file -> [timestamps]
const warmup = Math.floor(valid.length * 0.4);
const sums = { freq: 0, recency: 0, bla: 0 }, counts = { freq: 0, recency: 0, bla: 0 };
let evalCommits = 0, hit10 = { freq: 0, recency: 0, bla: 0 }, hit10n = 0;

valid.forEach((c, n) => {
  if (n >= warmup) {
    const cands = [...history.keys()];                 // files with ≥1 prior edit
    const edited = new Set(c.files);
    const isPos = cands.map((f) => edited.has(f));
    if (isPos.some(Boolean) && isPos.some((p) => !p)) { // need both classes for AUC
      evalCommits++;
      for (const [name, fn] of Object.entries(SCORERS)) {
        const scores = cands.map((f) => fn(history.get(f), c.t));
        const a = auc(scores, isPos);
        if (a != null) { sums[name] += a; counts[name]++; }
        // recall@10: of the files edited-next-with-history, how many are in the scorer's top 10?
        const top = cands.map((f, i) => [scores[i], isPos[i]]).sort((x, y) => y[0] - x[0]).slice(0, 10);
        hit10[name] += top.filter((x) => x[1]).length;
      }
      hit10n += isPos.filter(Boolean).length;
    }
  }
  for (const f of c.files) (history.get(f) ?? history.set(f, []).get(f)).push(c.t);
});

console.log(`eval commits (both classes present): ${evalCommits}\n`);
console.log("scorer     meanAUC   recall@10   (0.5 AUC = chance)");
for (const name of Object.keys(SCORERS)) {
  const a = (sums[name] / counts[name]).toFixed(4);
  const r = ((hit10[name] / hit10n) * 100).toFixed(1);
  console.log(`${name.padEnd(10)} ${a}     ${r.padStart(5)}%`);
}
