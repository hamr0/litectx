// THROWAWAY POC — tinymem probe, STAGE 1: cut, hash, de-dup, seed pages, measure volume.
//
// Reads the frozen corpora (Claude Code session logs + bareloop markdown docs), cuts them
// into "pieces" (id = sha256 of the text), counts duplicates, builds "pages" from product
// doc headings, and writes numbers to out/stage1/. No matching or filing happens here.
//
// Data root: env TINYMEM_PROBE_DIR (default ~/.cache/tinymem-probe).
// Session text is sensitive: this script never prints piece text; report.md holds numbers
// and document headings only. pieces-*.jsonl DO contain text and stay on disk.

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, relative } from "node:path";

const ROOT = process.env.TINYMEM_PROBE_DIR || join(homedir(), ".cache", "tinymem-probe");
const FROZEN = join(ROOT, "frozen");
const OUT = join(ROOT, "out", "stage1");

function fail(msg) {
  console.error(`tinymem-cut-poc: ${msg}`);
  process.exit(1);
}

if (!existsSync(join(FROZEN, "MANIFEST.json"))) fail(`missing ${join(FROZEN, "MANIFEST.json")} (freeze the corpora first)`);
mkdirSync(OUT, { recursive: true });

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const byteLen = (text) => Buffer.byteLength(text, "utf8");
const bump = (obj, key, n = 1) => { obj[key] = (obj[key] || 0) + n; };

// Recursively list files under dir whose name ends with ext, sorted by relative path.
function listFiles(dir, ext) {
  const found = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(ext)) found.push(p);
    }
  };
  walk(dir);
  return found.sort();
}

// ---------- shared: de-dup bookkeeping + statistics ----------

// Map id -> { rec, count }. First occurrence wins.
function makeSet() { return new Map(); }
function addPiece(set, rec) {
  const hit = set.get(rec.id);
  if (hit) hit.count++;
  else set.set(rec.id, { rec, count: 1 });
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

// Stats for one group of pieces. `all` = every piece (with repeats), as {id, bytes}.
function groupStats(all) {
  const seen = new Set();
  let bytes = 0, uniqueBytes = 0;
  for (const p of all) {
    bytes += p.bytes;
    if (!seen.has(p.id)) { seen.add(p.id); uniqueBytes += p.bytes; }
  }
  const sizes = all.map((p) => p.bytes).sort((a, b) => a - b);
  return {
    pieces: all.length,
    unique: seen.size,
    duplicates: all.length - seen.size,
    bytes,
    uniqueBytes,
    p50: percentile(sizes, 50),
    p90: percentile(sizes, 90),
    p99: percentile(sizes, 99),
    max: sizes.length ? sizes[sizes.length - 1] : 0,
  };
}

// ---------- 3a. session pieces ----------

const KINDS = ["user_text", "assistant_text", "assistant_thinking", "tool_use", "tool_result", "queued_command", "file_attachment"];
const sessionFiles = readdirSync(join(FROZEN, "sessions")).filter((f) => f.endsWith(".jsonl")).sort();

const sessSet = makeSet();
const sessAll = []; // {id, bytes, kind} for every piece, kept light (no text)
const lineTypes = {};
const emptySkipped = {};
const unknownBlocks = {};
const attachmentTypes = {}; // attachment.type -> line count (all attachment lines)
let badLines = 0, nonTextResultBlocks = 0, sidechainPieces = 0, metaPieces = 0, inputBytes = 0;

async function cutSessions() {
  for (const file of sessionFiles) {
    const path = join(FROZEN, "sessions", file);
    inputBytes += statSync(path).size;
    const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    let lineNo = 0;
    for await (const raw of rl) {
      lineNo++;
      if (raw.trim() === "") continue;
      let obj;
      try { obj = JSON.parse(raw); } catch { badLines++; continue; }
      const type = obj && typeof obj.type === "string" ? obj.type : "(none)";
      bump(lineTypes, type);
      if (type === "attachment") {
        const att = obj.attachment;
        const at = att && typeof att.type === "string" ? att.type : "(none)";
        bump(attachmentTypes, at);
        const ameta = { file, line: lineNo, timestamp: obj.timestamp ?? null, isSidechain: obj.isSidechain === true, isMeta: obj.isMeta === true };
        const emitAtt = (kind, text, extra) => {
          if (typeof text !== "string" || text.trim() === "") { bump(emptySkipped, kind); return; }
          const rec = { id: sha(text), kind, ...ameta, ...extra, bytes: byteLen(text), text };
          addPiece(sessSet, rec);
          sessAll.push({ id: rec.id, bytes: rec.bytes, kind, humanTurn: extra.humanTurn, isMeta: extra.isMeta });
        };
        if (at === "queued_command") {
          emitAtt("queued_command", att.prompt, {
            timestamp: att.timestamp ?? obj.timestamp ?? null,
            humanTurn: typeof att.humanTurn === "boolean" ? att.humanTurn : null,
            isMeta: att.isMeta === true,
            commandMode: att.commandMode ?? null,
          });
        } else if (at === "edited_text_file") {
          emitAtt("file_attachment", att.snippet, { attachmentType: at, filename: att.filename ?? null });
        } else if (at === "file" || at === "already_read_file") {
          emitAtt("file_attachment", att.content?.file?.content, { attachmentType: at, filename: att.filename ?? null });
        }
        continue;
      }
      if (type !== "user" && type !== "assistant") continue;

      const meta = { file, line: lineNo, timestamp: obj.timestamp ?? null, isSidechain: obj.isSidechain === true, isMeta: obj.isMeta === true };
      const emit = (kind, text) => {
        if (typeof text !== "string" || text.trim() === "") { bump(emptySkipped, kind); return; }
        const rec = { id: sha(text), kind, ...meta, bytes: byteLen(text), text };
        addPiece(sessSet, rec);
        sessAll.push({ id: rec.id, bytes: rec.bytes, kind });
        if (meta.isSidechain) sidechainPieces++;
        if (meta.isMeta) metaPieces++;
      };

      const content = obj.message?.content;
      if (typeof content === "string") {
        emit(type === "user" ? "user_text" : "assistant_text", content);
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const bt = block?.type;
        if (bt === "text") emit(type === "user" ? "user_text" : "assistant_text", block.text);
        else if (bt === "thinking") emit("assistant_thinking", block.thinking);
        else if (bt === "tool_use") emit("tool_use", `${block.name}\n${JSON.stringify(block.input)}`);
        else if (bt === "tool_result") {
          let text;
          if (typeof block.content === "string") text = block.content;
          else if (Array.isArray(block.content)) {
            const parts = [];
            for (const sub of block.content) {
              if (sub?.type === "text") parts.push(sub.text ?? "");
              else nonTextResultBlocks++;
            }
            text = parts.join("\n");
          }
          emit("tool_result", text);
        } else bump(unknownBlocks, String(bt));
      }
    }
  }
}

// ---------- 3b/3c. document pieces and pages ----------

const docSet = makeSet();
const docAll = []; // {id, bytes, bucket}
const docRecordsForChecks = [];
const pages = [];

// Split a markdown body into lines (a trailing newline does not make an extra line).
function toLines(body) {
  const lines = body.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// Walk lines once; return { h1 (first outside-fence "# " title or null), headings: [{title, line}] }.
function scanHeadings(lines) {
  let inFence = false, h1 = null;
  const headings = [];
  lines.forEach((l, i) => {
    if (l.startsWith("```") || l.startsWith("~~~")) { inFence = !inFence; return; }
    if (inFence) return;
    if (l.startsWith("## ")) headings.push({ title: l.slice(3).trim(), line: i + 1 });
    else if (h1 === null && l.startsWith("# ")) h1 = l.slice(2).trim();
  });
  return { h1, headings };
}

function cutDocs() {
  const docsDir = join(FROZEN, "docs");
  for (const full of listFiles(docsDir, ".md")) {
    const relPath = "docs/" + relative(docsDir, full).split("\\").join("/");
    const seg = relPath.split("/")[1];
    const bucket = ["product", "wiki", "logs", "archive"].includes(seg) && relPath.split("/").length > 2 ? seg : "other";
    const lines = toLines(readFileSync(full, "utf8"));
    const { h1, headings } = scanHeadings(lines);

    const sections = [];
    const firstStart = headings.length ? headings[0].line : lines.length + 1;
    const pre = lines.slice(0, firstStart - 1).join("\n");
    if (pre.trim() !== "") sections.push({ heading: "(preamble)", startLine: 1, endLine: firstStart - 1 });
    headings.forEach((h, i) => {
      const endLine = i + 1 < headings.length ? headings[i + 1].line - 1 : lines.length;
      sections.push({ heading: h.title, startLine: h.line, endLine });
    });

    for (const s of sections) {
      const text = lines.slice(s.startLine - 1, s.endLine).join("\n");
      const rec = { id: sha(text), kind: "doc_section", bucket, path: relPath, heading: s.heading, startLine: s.startLine, endLine: s.endLine, bytes: byteLen(text), text };
      addPiece(docSet, rec);
      docAll.push({ id: rec.id, bytes: rec.bytes, bucket });
    }
    docRecordsForChecks.push({ relPath, total: lines.length, sections, preBlank: pre.trim() === "", firstStart });

    if (bucket === "product") {
      pages.push({
        name: h1 ?? relPath.split("/").pop(),
        path: relPath,
        lines: lines.length,
        headings: headings.map((h, i) => ({ title: h.title, startLine: h.line, endLine: i + 1 < headings.length ? headings[i + 1].line - 1 : lines.length })),
      });
    }
  }
  pages.sort((a, b) => (a.path < b.path ? -1 : 1));
}

// ---------- run ----------

const t0 = process.hrtime.bigint();
await cutSessions();
const t1 = process.hrtime.bigint();
cutDocs();
const t2 = process.hrtime.bigint();
const sessionsSeconds = Number(t1 - t0) / 1e9;
const docsSeconds = Number(t2 - t1) / 1e9;

// ---------- 3d. statistics ----------

const sessionStats = { total: groupStats(sessAll), byKind: {} };
for (const k of KINDS) sessionStats.byKind[k] = groupStats(sessAll.filter((p) => p.kind === k));
const BUCKETS = ["product", "wiki", "logs", "archive", "other"];
const docStats = { total: groupStats(docAll), byBucket: {} };
for (const b of BUCKETS) docStats.byBucket[b] = groupStats(docAll.filter((p) => p.bucket === b));

let qcOverlap = 0;
{
  const userIds = new Set();
  for (const { rec } of sessSet.values()) if (rec.kind === "user_text") userIds.add(rec.id);
  for (const { rec } of sessSet.values()) if (rec.kind === "queued_command" && userIds.has(rec.id)) qcOverlap++;
}
const qc = sessAll.filter((p) => p.kind === "queued_command");
const queuedFlags = {
  humanTurn: { true: qc.filter((p) => p.humanTurn === true).length, false: qc.filter((p) => p.humanTurn === false).length, absent: qc.filter((p) => p.humanTurn === null).length },
  isMeta: { true: qc.filter((p) => p.isMeta === true).length, false: qc.filter((p) => p.isMeta === false).length },
};

let overlap = 0;
for (const id of docSet.keys()) if (sessSet.has(id)) overlap++;

const stats = {
  sessions: {
    files: sessionFiles.length,
    inputBytes,
    lineTypes,
    badLines,
    emptySkipped,
    unknownBlocks,
    attachmentTypes,
    queuedFlags,
    queuedIdsAlsoUserText: qcOverlap,
    nonTextResultBlocks,
    sidechainPieces,
    metaPieces,
    ...sessionStats,
  },
  docs: { files: docRecordsForChecks.length, ...docStats },
  pages: { count: pages.length, totalHeadings: pages.reduce((n, p) => n + p.headings.length, 0) },
  crossSetDistinctIds: overlap,
  timing: { sessionsSeconds, docsSeconds, sessionsMBPerSecond: inputBytes / 1e6 / sessionsSeconds },
};

// ---------- self-checks ----------

function check(ok, msg) { if (!ok) fail(`SELF-CHECK FAILED: ${msg}`); }

check(KINDS.reduce((n, k) => n + sessionStats.byKind[k].pieces, 0) === sessionStats.total.pieces, "per-kind session piece counts do not sum to the total");
check(BUCKETS.reduce((n, b) => n + docStats.byBucket[b].pieces, 0) === docStats.total.pieces, "per-bucket doc piece counts do not sum to the total");
for (const g of [sessionStats.total, ...Object.values(sessionStats.byKind), docStats.total, ...Object.values(docStats.byBucket)]) {
  check(g.unique <= g.pieces, "unique > pieces in some group");
}
for (const d of docRecordsForChecks) {
  let expect = d.preBlank ? d.firstStart : 1; // where the first section must start
  for (const s of d.sections) {
    check(1 <= s.startLine && s.startLine <= s.endLine && s.endLine <= d.total, `${d.relPath}: bad range ${s.startLine}-${s.endLine} (file has ${d.total} lines)`);
    check(s.startLine === expect, `${d.relPath}: gap or overlap at line ${s.startLine} (expected ${expect})`);
    expect = s.endLine + 1;
  }
  check(d.sections.length === 0 ? d.total === 0 || d.preBlank : expect === d.total + 1, `${d.relPath}: sections do not reach end of file`);
}

// ---------- 3e. outputs ----------

function writeJsonl(file, set) {
  const out = [];
  for (const { rec, count } of set.values()) out.push(JSON.stringify({ ...rec, count }));
  writeFileSync(join(OUT, file), out.join("\n") + (out.length ? "\n" : ""));
}
writeJsonl("pieces-sessions.jsonl", sessSet);
writeJsonl("pieces-docs.jsonl", docSet);
writeFileSync(join(OUT, "pages.json"), JSON.stringify(pages, null, 2));
writeFileSync(join(OUT, "stats.json"), JSON.stringify(stats, null, 2));

const n = (x) => x.toLocaleString("en-US");
const f2 = (x) => x.toFixed(2);
const statRow = (label, g) =>
  `| ${label} | ${n(g.pieces)} | ${n(g.unique)} | ${n(g.duplicates)} | ${n(g.bytes)} | ${n(g.uniqueBytes)} | ${g.pieces ? f2((100 * g.duplicates) / g.pieces) : "0.00"} | ${n(g.p50)} | ${n(g.p90)} | ${n(g.p99)} | ${n(g.max)} |`;
const statHead = (first) =>
  `| ${first} | pieces | unique | duplicates | bytes | uniqueBytes | % duplicate | p50 | p90 | p99 | max |\n|---|---|---|---|---|---|---|---|---|---|---|`;

const md = [];
md.push("# tinymem probe, stage 1 report", "");
md.push("## Corpus sizes", "", "| item | value |", "|---|---|");
md.push(`| session files | ${n(sessionFiles.length)} |`, `| session input bytes | ${n(inputBytes)} |`);
md.push(`| doc files | ${n(docRecordsForChecks.length)} |`, `| doc bytes (sum of piece bytes) | ${n(docStats.total.bytes)} |`, "");
md.push("## Session line types", "", "| type | lines |", "|---|---|");
for (const [t, c] of Object.entries(lineTypes).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) md.push(`| ${t} | ${n(c)} |`);
md.push("", "| counter | value |", "|---|---|");
md.push(`| badLines | ${n(badLines)} |`, `| nonTextResultBlocks | ${n(nonTextResultBlocks)} |`, `| sidechain pieces | ${n(sidechainPieces)} |`, `| isMeta pieces | ${n(metaPieces)} |`);
md.push(`| emptySkipped | ${JSON.stringify(emptySkipped)} |`, `| unknownBlocks | ${JSON.stringify(unknownBlocks)} |`, "");
md.push("## Session pieces per kind", "", statHead("kind"));
for (const k of KINDS) md.push(statRow(k, sessionStats.byKind[k]));
md.push(statRow("TOTAL", sessionStats.total), "");
md.push("## Queued commands by flag", "", "| flag | value | pieces |", "|---|---|---|");
for (const v of ["true", "false", "absent"]) md.push(`| humanTurn | ${v} | ${n(queuedFlags.humanTurn[v])} |`);
for (const v of ["true", "false"]) md.push(`| isMeta | ${v} | ${n(queuedFlags.isMeta[v])} |`);
md.push("", `queued_command piece ids also the id of a user_text piece (distinct ids): ${n(qcOverlap)}`, "");
md.push("## Attachment lines by type", "", "| attachment.type | lines |", "|---|---|");
for (const [t, c] of Object.entries(attachmentTypes).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) md.push(`| ${t} | ${n(c)} |`);
md.push("");
md.push("## Doc pieces per bucket", "", statHead("bucket"));
for (const b of BUCKETS) md.push(statRow(b, docStats.byBucket[b]));
md.push(statRow("TOTAL", docStats.total), "");
md.push("## Pages", "", "| item | value |", "|---|---|", `| pages | ${pages.length} |`, `| total second-level headings | ${stats.pages.totalHeadings} |`, "");
md.push("## Cross-set overlap", "", "| item | value |", "|---|---|", `| distinct ids in both sessions and docs | ${n(overlap)} |`, "");
md.push("## Timing", "", "| item | value |", "|---|---|", `| sessionsSeconds | ${f2(sessionsSeconds)} |`, `| docsSeconds | ${f2(docsSeconds)} |`, `| sessionsMBPerSecond | ${f2(stats.timing.sessionsMBPerSecond)} |`, "");
md.push("## Index sample", "");
for (const p of pages.slice(0, 3)) {
  md.push(`- [${p.name}](${p.path}) — ${p.lines} lines`);
  for (const h of p.headings) md.push(`  - ${h.title} (L${h.startLine}–${h.endLine})`);
}
const report = md.join("\n") + "\n";
writeFileSync(join(OUT, "report.md"), report);
process.stdout.write(report);
