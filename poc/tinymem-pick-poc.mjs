// THROWAWAY POC — tinymem module 0, round 4: a cheap model picks the page from the BM25-by-windows top 5.
// Reads out/stage1 (pages), out/stage2 (pieces + labels), out/stage3/picks.jsonl (method bm25/windows, READ ONLY).
// Writes ONLY out/stage4/{answers.jsonl,results.json,report.md,timing.json}. Never writes inside the repo.
// Model via the Claude Code CLI (no API key): claude -p --model haiku-4.5, tools off, no settings, no session saved.
// Answers are cached by piece id in answers.jsonl; a re-run only calls for missing ids. results.json is deterministic.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = process.env.TINYMEM_PROBE_DIR || join(homedir(), ".cache", "tinymem-probe");
const S1 = join(ROOT, "out", "stage1"), S2 = join(ROOT, "out", "stage2"), S3 = join(ROOT, "out", "stage3");
const OUT = join(ROOT, "out", "stage4");
const MODEL = "claude-haiku-4-5-20251001";
const CONC = 4, PIECE_CAP = 1500, MAX_HEADINGS = 14;
const LIMIT = process.argv.includes("--limit") ? Number(process.argv[process.argv.indexOf("--limit") + 1]) : Infinity;
const EXAMS = ["messy", "structured"], HALVES = ["held", "tune"];
const readJsonl = (p) => readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
mkdirSync(OUT, { recursive: true });

// pages: same id scheme as the bake-off (sorted by path, P01..)
const pages = JSON.parse(readFileSync(join(S1, "pages.json"), "utf8")).sort((a, b) => cmp(a.path, b.path))
  .map((p, i) => ({ ...p, pid: "P" + String(i + 1).padStart(2, "0") }));
const pageById = new Map(pages.map((p) => [p.pid, p]));
const cand = (pid) => {
  const p = pageById.get(pid);
  const hs = (p.headings || []).slice(0, MAX_HEADINGS).map((h) => `  - ${String(h.title).slice(0, 90)}`).join("\n");
  return `[${pid}] ${String(p.name).slice(0, 140)}\n  file: ${p.path}\n${hs}`;
};

// pieces + labels + shortlist
const items = [];
const shortlist = new Map();
for (const r of readJsonl(join(S3, "picks.jsonl"))) if (r.method === "bm25/windows") shortlist.set(r.id, r.top.map((t) => t[0]));
for (const exam of EXAMS) for (const half of HALVES) {
  const labels = new Map(readJsonl(join(S2, `labels-${exam}-${half}.jsonl`)).map((l) => [l.id, l]));
  for (const b of readJsonl(join(S2, `batch-${exam}-${half}.jsonl`))) {
    const l = labels.get(b.id);
    if (!l) throw new Error("piece without label " + b.id);
    items.push({ id: b.id, exam, half, text: b.text, label: l, top: shortlist.get(b.id) });
  }
}

const SYS = "You file pieces of project memory onto pages. Reply with exactly one token and nothing else: a page id from the candidate list, or NONE.";
function prompt(it) {
  let t = it.text; if (t.length > PIECE_CAP) t = t.slice(0, PIECE_CAP) + " …[cut]";
  return `Here is a piece of text (a session-log fragment or a doc section):\n\n<piece>\n${t}\n</piece>\n\n` +
    `Here are ${it.top.length} candidate pages. Each shows its id, title, file and its headings:\n\n${it.top.map(cand).join("\n\n")}\n\n` +
    `Which ONE candidate page does the piece belong on? Answer with exactly one page id (like ${it.top[0]}), or NONE if it belongs on none of them. Output only the id or NONE.`;
}

function callClaude(input) {
  return new Promise((resolve) => {
    const c = spawn("claude", ["-p", "--model", MODEL, "--output-format", "json", "--tools", "", "--setting-sources", "",
      "--no-session-persistence", "--system-prompt", SYS], { cwd: OUT, stdio: ["pipe", "pipe", "pipe"] });
    let o = "", e = "";
    c.stdout.on("data", (d) => (o += d)); c.stderr.on("data", (d) => (e += d));
    c.on("close", (code) => {
      try { const j = JSON.parse(o); resolve({ raw: String(j.result ?? ""), err: j.is_error ? "is_error" : null, cost: j.total_cost_usd ?? 0 }); }
      catch { resolve({ raw: "", err: `exit ${code}: ${e.slice(0, 200)}`, cost: 0 }); }
    });
    c.stdin.end(input);
  });
}

const ansPath = join(OUT, "answers.jsonl");
const cache = new Map();
if (existsSync(ansPath)) for (const a of readJsonl(ansPath)) cache.set(a.id, a);
const skipped = [];
const todo = [];
for (const it of items) {
  if (!it.top || it.top.length === 0) { skipped.push({ id: it.id, exam: it.exam, half: it.half, reason: "empty BM25-windows shortlist (no term overlap)" }); continue; }
  if (!cache.has(it.id)) todo.push(it);
}
const work = todo.slice(0, LIMIT);
const t0 = Date.now();
let next = 0, done = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < work.length) {
    const it = work[next++];
    let r = await callClaude(prompt(it));
    if (r.err) r = await callClaude(prompt(it)); // one retry
    if (r.err) { console.error("call failed:", it.id.slice(0, 8), r.err); continue; } // not cached -> retried on re-run
    const a = { id: it.id, shortlist: it.top, raw: r.raw.trim(), cost: r.cost };
    cache.set(it.id, a); appendFileSync(ansPath, JSON.stringify(a) + "\n");
    if (++done % 25 === 0) console.error(`${done}/${work.length}`);
  }
}));
const wall = Date.now() - t0;
writeFileSync(join(OUT, "timing.json"), JSON.stringify({ lastRunWallMs: wall, lastRunNewCalls: done }, null, 2) + "\n");
if (LIMIT !== Infinity) { console.error(`smoke: ${done} calls`); process.exit(0); }
const missing = items.filter((it) => it.top?.length && !cache.has(it.id));
if (missing.length) { console.error(`${missing.length} pieces have no answer (call failures); re-run to resume`); process.exit(1); }

// ---------------------------------------------------------------- score
const parse = (raw, top) => {
  const s = raw.trim().replace(/^[`*"'\s]+|[`*"'.\s]+$/g, "");
  if (s === "NONE") return { v: "NONE" };
  if (top.includes(s)) return { v: s };
  return { invalid: true, v: raw.slice(0, 40) };
};
const right = (pick, l) => pick != null && l.page !== "none" && (pick === l.page || pick === l.second);
const R = { model: MODEL, params: { concurrency: CONC, pieceCap: PIECE_CAP, maxHeadings: MAX_HEADINGS }, totalCalls: cache.size, skipped: skipped.length, skippedList: skipped, cells: {}, pulls: {}, examples: [] };
const pull = {};
for (const exam of EXAMS) for (const half of HALVES) {
  const rows = items.filter((i) => i.exam === exam && i.half === half);
  const withPage = rows.filter((i) => i.label.page !== "none"), none = rows.filter((i) => i.label.page === "none");
  const sk = rows.filter((i) => !i.top?.length).length;
  const c = { pieces: rows.length, withPage: withPage.length, noPage: none.length, skipped: sk,
    bm25First: 0, top5Ceiling: 0, modelFirst: 0, inTop5: 0, modelRightWhenInTop5: 0,
    noneCorrect: 0, noneWrongOnPage: 0, invalid: 0, invalidOnPage: 0, pieceNoneInTopNoneLabelled: 0 };
  for (const it of rows) {
    const l = it.label, hasP = l.page !== "none";
    if (hasP && it.top?.length) { if (right(it.top[0], l)) c.bm25First++; if (it.top.some((p) => right(p, l))) c.top5Ceiling++; }
    if (!it.top?.length) continue;
    const a = parse(cache.get(it.id).raw, it.top);
    if (a.invalid) { c.invalid++; if (hasP) c.invalidOnPage++; if (R.examples.length < 40 && hasP) R.examples.push({ id: it.id, exam, half, kind: "invalid", true: l.page, answer: a.v }); continue; }
    if (a.v !== "NONE") pull[a.v] = (pull[a.v] || 0) + 1, (R.pulls[`${exam}/${half}`] ??= {})[a.v] = ((R.pulls[`${exam}/${half}`] ?? {})[a.v] || 0) + 1;
    if (hasP) {
      const inTop = it.top.some((p) => right(p, l));
      if (inTop) c.inTop5++;
      if (a.v === "NONE") c.noneWrongOnPage++;
      if (right(a.v, l)) { c.modelFirst++; if (inTop) c.modelRightWhenInTop5++; }
      else R.examples.push({ id: it.id, exam, half, kind: a.v === "NONE" ? "said-none" : "wrong", true: l.page, second: l.second, answer: a.v, inTop5: inTop });
    } else if (a.v === "NONE") c.noneCorrect++;
  }
  R.cells[`${exam}/${half}`] = c;
}
const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).slice(0, 5);
R.topPulls = Object.fromEntries([["all", top(pull)], ...Object.entries(R.pulls).map(([k, v]) => [k, top(v)])]);
delete R.pulls;
// keep examples compact + deterministic: wrong picks only, first 12 by id
R.examples = R.examples.filter((e) => e.kind !== "said-none").sort((a, b) => cmp(a.id, b.id)).slice(0, 12);
writeFileSync(join(OUT, "results.json"), JSON.stringify(R, null, 2) + "\n");

const pct = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : `${n}/0`);
let md = `# Round 4 — Haiku 4.5 picks from the BM25-windows top 5\n\nCalls: ${R.totalCalls}. Skipped pieces: ${R.skipped} (empty shortlist: no model call; counted as no pick in the model's first-pick column).\n\n` +
  `| exam/half | pieces | with page | BM25 first | top-5 ceiling | model first | model when right in top 5 | none labelled: model says NONE | page labelled: model says NONE | invalid | skipped |\n|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const [k, c] of Object.entries(R.cells))
  md += `| ${k} | ${c.pieces} | ${c.withPage} | ${pct(c.bm25First, c.withPage)} | ${pct(c.top5Ceiling, c.withPage)} | ${pct(c.modelFirst, c.withPage)} | ${pct(c.modelRightWhenInTop5, c.inTop5)} | ${pct(c.noneCorrect, c.noPage)} | ${pct(c.noneWrongOnPage, c.withPage)} | ${c.invalid} | ${c.skipped} |\n`;
md += `\n## Most-picked pages (model)\n\n` + Object.entries(R.topPulls).map(([k, v]) => `- ${k}: ${v.map(([p, n]) => `${p}×${n}`).join(", ")}`).join("\n") + "\n";
md += `\n## Skipped\n\n` + (skipped.length ? skipped.map((s) => `- ${s.id.slice(0, 8)} ${s.exam}/${s.half}: ${s.reason}`).join("\n") : "none") + "\n";
writeFileSync(join(OUT, "report.md"), md);
console.log(md);
