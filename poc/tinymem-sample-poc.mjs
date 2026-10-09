// THROWAWAY POC — tinymem probe, STAGE 2: draw a fixed sample for labelling, and check label files.
//
// Mode 1 (default): reads out/stage1/ and writes out/stage2/ (pages.md, four batch-*.jsonl,
//   sample-manifest.json). Deterministic: order key = sha256("tinymem-stage2-v1:" + id).
// Mode 2 (--check-labels): validates labels-*.jsonl against sample-manifest.json.
//
// Data root: env TINYMEM_PROBE_DIR (default ~/.cache/tinymem-probe).
// Labels dir: env TINYMEM_LABELS_DIR (default out/stage2/).
// Session text is sensitive: this script never prints piece or note text. batch-*.jsonl hold text on disk.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = process.env.TINYMEM_PROBE_DIR || join(homedir(), ".cache", "tinymem-probe");
const IN = join(ROOT, "out", "stage1");
const OUT = join(ROOT, "out", "stage2");
const SEED = "tinymem-stage2-v1";
const PER_GROUP = 34;
const STRUCTURED_N = 200;
const MAX_CHARS = 4000;
const BATCHES = ["messy-tune", "messy-held", "structured-tune", "structured-held"];

function fail(msg) {
  console.error(`tinymem-sample-poc: ${msg}`);
  process.exit(1);
}

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const readJsonl = (p) => readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const withKey = (arr) => arr.map((r) => ({ r, key: sha(SEED + ":" + r.id) }));
const seeded = (arr) => withKey(arr).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((x) => x.r);

function loadPages() {
  const pages = JSON.parse(readFileSync(join(IN, "pages.json"), "utf8"));
  pages.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return pages.map((p, i) => ({ ...p, pid: "P" + String(i + 1).padStart(2, "0") }));
}

// ---------------------------------------------------------------- mode 1
function draw() {
  for (const f of ["pieces-sessions.jsonl", "pieces-docs.jsonl", "pages.json"]) {
    if (!existsSync(join(IN, f))) fail(`missing ${join(IN, f)}`);
  }
  mkdirSync(OUT, { recursive: true });
  const pages = loadPages();
  const sessions = readJsonl(join(IN, "pieces-sessions.jsonl"));
  const docs = readJsonl(join(IN, "pieces-docs.jsonl"));

  const groups = {
    user_text: (r) => r.kind === "user_text" && r.isMeta !== true,
    assistant_text: (r) => r.kind === "assistant_text",
    tool_use: (r) => r.kind === "tool_use",
    tool_result: (r) => r.kind === "tool_result",
    queued_command: (r) => r.kind === "queued_command" && r.isMeta !== true,
    file_attachment: (r) => r.kind === "file_attachment",
  };

  const eligible = {};
  const batches = Object.fromEntries(BATCHES.map((b) => [b, []])); // arrays of {r, key}
  const take = (list, exam, label) => {
    const picked = withKey(list).sort((a, b) => (a.key < b.key ? -1 : 1)).slice(0, label.n);
    picked.forEach((x, i) => batches[`${exam}-${i % 2 === 0 ? "tune" : "held"}`].push(x));
  };

  for (const [g, pred] of Object.entries(groups)) {
    const list = sessions.filter(pred);
    eligible[g] = list.length;
    if (list.length < PER_GROUP) fail(`group ${g} has only ${list.length} eligible pieces (need ${PER_GROUP})`);
    take(list, "messy", { n: PER_GROUP });
  }
  const sdocs = docs.filter((r) => r.kind === "doc_section" && (r.bucket === "wiki" || r.bucket === "logs"));
  eligible.structured = sdocs.length;
  if (sdocs.length < STRUCTURED_N) fail(`structured exam has only ${sdocs.length} eligible pieces (need ${STRUCTURED_N})`);
  take(sdocs, "structured", { n: STRUCTURED_N });

  // pages.md
  let md = "";
  for (const p of pages) {
    md += `## ${p.pid} — ${p.name}\npath: ${p.path} — ${p.lines} lines\n`;
    for (const h of p.headings) md += `- ${h.title} (L${h.startLine}–${h.endLine})\n`;
    md += "\n";
  }
  writeFileSync(join(OUT, "pages.md"), md);

  // batches (seeded order within each batch)
  const manifest = {
    seed: SEED,
    pageIds: pages.map((p) => ({ id: p.pid, path: p.path, name: p.name })),
    eligible,
    batches: {},
  };
  const summary = [];
  const seenIds = new Map();
  let chars;
  for (const b of BATCHES) {
    const exam = b.split("-")[0];
    const half = b.split("-")[1];
    const items = batches[b].sort((x, y) => (x.key < y.key ? -1 : 1)).map((x) => x.r);
    const byKind = {};
    let truncCount = 0;
    chars = 0;
    const lines = items.map((r, i) => {
      const text = String(r.text ?? "");
      const truncated = text.length > MAX_CHARS;
      if (truncated) truncCount++;
      const out = { n: i + 1, id: r.id, exam, half, kind: r.kind, bytes: r.bytes, truncated, text: text.slice(0, MAX_CHARS) };
      if (r.kind === "doc_section") { out.path = r.path; out.heading = r.heading; }
      if (out.text.length > MAX_CHARS) fail(`record over ${MAX_CHARS} chars in ${b}`);
      chars += out.text.length;
      byKind[r.kind] = (byKind[r.kind] || 0) + 1;
      if (seenIds.has(r.id)) fail(`id ${r.id.slice(0, 8)} appears in ${seenIds.get(r.id)} and ${b}`);
      seenIds.set(r.id, b);
      return JSON.stringify(out);
    });
    writeFileSync(join(OUT, `batch-${b}.jsonl`), lines.join("\n") + "\n");
    if (exam === "messy") {
      for (const g of Object.keys(groups)) if (byKind[g] !== 17) fail(`batch ${b} has ${byKind[g] || 0} of ${g}, expected 17`);
    } else if (items.length !== 100) fail(`batch ${b} has ${items.length} records, expected 100`);
    manifest.batches[b] = { count: items.length, byKind, ids: items.map((r) => r.id) };
    summary.push(`batch ${b}: ${items.length} records, truncated ${truncCount}, text chars ${chars}, kinds ${JSON.stringify(byKind)}`);
  }
  writeFileSync(join(OUT, "sample-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  console.log("eligible:", JSON.stringify(eligible));
  console.log(`pages: ${pages.length}`);
  for (const s of summary) console.log(s);
}

// ---------------------------------------------------------------- mode 2
function checkLabels() {
  const mpath = join(OUT, "sample-manifest.json");
  if (!existsSync(mpath)) fail(`missing ${mpath}`);
  const manifest = JSON.parse(readFileSync(mpath, "utf8"));
  const validPages = new Set(manifest.pageIds.map((p) => p.id));
  const dir = process.env.TINYMEM_LABELS_DIR || OUT;
  let allPass = true;

  for (const b of BATCHES) {
    const reasons = [];
    const expected = manifest.batches[b].ids;
    const expSet = new Set(expected);
    const file = join(dir, `labels-${b}.jsonl`);
    const rows = [];
    if (!existsSync(file)) {
      reasons.push("labels file missing");
    } else {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (!line.trim()) return;
        try { rows.push({ o: JSON.parse(line), ln: i + 1 }); } catch { reasons.push(`line ${i + 1}: not valid JSON`); }
      });
      const counts = new Map();
      for (const { o, ln } of rows) {
        const tag = `line ${ln}`;
        if (o === null || typeof o !== "object" || Array.isArray(o)) { reasons.push(`${tag}: not an object`); continue; }
        const id8 = typeof o.id === "string" ? o.id.slice(0, 8) : String(o.id);
        if (typeof o.id !== "string" || !expSet.has(o.id)) reasons.push(`${tag}: id ${id8} not in batch`);
        else counts.set(o.id, (counts.get(o.id) || 0) + 1);
        const pageOk = o.page === "none" || validPages.has(o.page);
        if (!pageOk) reasons.push(`${tag}: invalid page`);
        const secondOk = o.second === null || validPages.has(o.second);
        if (!secondOk) reasons.push(`${tag}: invalid second`);
        if (pageOk && secondOk && o.second !== null && o.second === o.page) reasons.push(`${tag}: second equals page`);
        if (o.page === "none" && o.second !== null) reasons.push(`${tag}: page none but second set`);
        if (typeof o.sure !== "boolean") reasons.push(`${tag}: sure not boolean`);
        if (o.worth !== "keep" && o.worth !== "noise") reasons.push(`${tag}: invalid worth`);
        if (typeof o.note !== "string" || o.note.length > 160) reasons.push(`${tag}: note not a string or over 160 chars`);
      }
      for (const id of expected) {
        const c = counts.get(id) || 0;
        if (c === 0) reasons.push(`missing id ${id.slice(0, 8)}`);
        else if (c > 1) reasons.push(`id ${id.slice(0, 8)} labelled ${c} times`);
      }
    }
    if (reasons.length) {
      allPass = false;
      const shown = reasons.slice(0, 20);
      console.log(`FAIL ${b}: ${reasons.length} problem(s)`);
      for (const r of shown) console.log(`  - ${r}`);
      if (reasons.length > shown.length) console.log(`  - ... ${reasons.length - shown.length} more`);
    } else {
      const per = {};
      let none = 0, keep = 0, noise = 0, unsure = 0, second = 0;
      for (const { o } of rows) {
        if (o.page === "none") none++; else per[o.page] = (per[o.page] || 0) + 1;
        if (o.worth === "keep") keep++; else noise++;
        if (o.sure === false) unsure++;
        if (o.second !== null) second++;
      }
      console.log(`PASS ${b}: ${rows.length} labels`);
      console.log(`  none=${none} keep=${keep} noise=${noise} sure_false=${unsure} second=${second}`);
      console.log(`  per page: ${JSON.stringify(Object.fromEntries(Object.entries(per).sort()))}`);
    }
  }
  process.exit(allPass ? 0 : 1);
}

if (process.argv.includes("--check-labels")) checkLabels();
else draw();
