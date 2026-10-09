// tinymem cut-off probe (Part 1, counting only, no embedding): does the answer sit past MiniLM's input window inside its gold section?
// Embed input for an indexed-md section = nodes.body (= chunk.text) of the section, HEAD-sliced to 6000 chars (src/index.js:~478 `_embedSafe(c.text)`,
// src/embedder.js HEAD_CHARS), then transformers.js tokenizes with truncation:true -> tokenizer.model_max_length (512, verified empirically below).
// ANSWER spans were marked BY READING (see ANS), not by script. Reads the 1x docs-only index.db files read-only; no src/ import.
// usage: node poc/tinymem-cutoff.mjs      (needs node_modules for better-sqlite3 + @huggingface/transformers)
import Database from "better-sqlite3";
import { AutoTokenizer } from "@huggingface/transformers";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const O = join(homedir(), ".cache/tinymem-probe/out"), OUT = join(O, "cutoff");
mkdirSync(OUT, { recursive: true });
const HEAD_CHARS = 6000;

// frozen-question hash check
const frozen = Object.fromEntries(readFileSync(join(O, "step3/FROZEN.sha256"), "utf8").trim().split("\n").map((l) => { const [h, f] = l.trim().split(/\s+/); return [f, h]; }));
for (const [f, h] of Object.entries(frozen)) {
  const got = createHash("sha256").update(readFileSync(join(O, "step3/questions", f))).digest("hex");
  if (got !== h) throw new Error(`FROZEN hash mismatch for ${f}`);
}

const tok = await AutoTokenizer.from_pretrained("Xenova/all-MiniLM-L6-v2");
const MAXLEN = tok.model_max_length; // 512
const nTok = (t, special = true) => tok(t, { truncation: false, add_special_tokens: special }).input_ids.dims[1];
// sanity: what the pipeline really keeps
const probe = tok("word ".repeat(3000), { truncation: true }).input_ids.dims[1];

// Answer spans marked by reading each question + gold section (file line numbers, 1-based, inclusive).
// core=false: gold source that holds none of the question's must-items (related context only).
// key = `${path}:${goldA}-${goldB}` as in the question file's `sources`
const ANS = {
  "docs/docs/wiki/workflow-governance.md:56-58": [58, 58, true, "L58: 'a step ends when it stops making progress... A strike is a red iteration that repeats an already-seen normalized gap... Two strikes... shell-owned'"],
  "docs/CHANGELOG.md:54-54": [54, 54, false, "L54 F122 2A(b): truncated round counts as a strike; holds no must-item (related only)"],
  "docs/CHANGELOG.md:3740-3744": [3739, 3743, true, "L3739-3743: fixed cap replaced by strike ladder; strike = repeats seen gap or no gate-audit writes; default 2"],
  "docs/docs/wiki/workflow-governance.md:106-112": [110, 110, true, "L110: SCOUT_ATTEMPTS = 3; unparseable+empty retry; call-failed/short/non-object/empty-object do not"],
  "docs/docs/archive/PRD.md:4017-4034": [4017, 4030, true, "L4017 heading SCOUT_ATTEMPTS=3 + cause table L4024-4030"],
  "docs/docs/wiki/workflow-governance.md:100-100": [100, 100, true, "L100: blind spot parked, later closed via altBranchesOverlap, rejections-only"],
  "docs/docs/archive/PRD.md:3712-3727": [3714, 3722, true, "L3714-3720 CLOSED 2026-08-13 altBranchesOverlap, adding rejections only; L3722 measured miss"],
  "docs/bareloop.context.md:488-498": [488, 498, true, "L488-491 not a verdict, never retried; L498 killed row: status===null, no spawn error, close-killed"],
  "docs/docs/product/2026-07-13-forbidden-zone-audit-spec.md:9-13": [10, 13, true, "L10-13 close-killed own escalation never red; status===null with no spawn error"],
  "docs/docs/product/2026-07-26-materials-metering-design.md:149-175": [156, 156, true, "(section L149-162) L156 C1: stop() cannot cut in-flight generate(); (section L163-176) handled below via second section"],
  "docs/docs/product/2026-07-26-materials-metering-design.md:377-379": [378, 379, true, "L378-379 callTimeoutMs = min(PROVIDER_TIMEOUT_MS, max(MIN_CALL_TIMEOUT_MS, remainingMs()))"],
  "docs/docs/logs/SCOUT-CONTRAST.md:126-134": [128, 131, true, "L128-131 both arms green; OFF $0.37 MORE inside $0.40 noise band; lever closed, no default flip"],
  "docs/docs/logs/RUBRIC-LEARNINGS.md:67-76": [67, 75, true, "L67-70 two concerns (circular/easy; calibration once, 90% judge luck); L72-75 calibration by mutation"],
  "docs/docs/product/PRD.md:1017-1017": [1017, 1017, true, "L1017 R5 calibration by mutation (alternative only; concerns not here)"],
  "docs/docs/product/EXPORT-BUILD.md:201-221": [205, 216, true, "L205-210 cause (close script hardcodes WORKDIR, ignores cwd); L213-216 close-absolute-path check"],
  "docs/CHANGELOG.md:1390-1395": [1390, 1394, true, "L1390-1394 close scripts hardcoded absolute patient path -> process.cwd() (cause side only)"],
  "docs/docs/product/CLOSE-INTEGRITY-BUILD.md:84-84": [84, 85, true, "L84-85 close-absolute-path moves to run-start precheck (safeguard side only)"],
  "docs/docs/wiki/tools-and-interface.md:51-51": [51, 51, true, "L51 per-family (root run_id), counted from audit log, fork-bomb reason"],
  "docs/docs/product/errors.md:71-71": [71, 71, true, "L71 truncated:max_tokens: partial text, tool calls refused not executed, no auto-retry (doubles spend)"],
  "docs/bareagent.context.md:343-349": [345, 349, true, "L345-349 child config must declare gate; bin/cli.js refuses exit 1; 'ungoverned': true opt-out"],
  "docs/docs/wiki/api-reference.md:252-252": [252, 252, true, "L252 gate-less config refused exit 1; 'ungoverned': true"],
  "docs/docs/wiki/decisions-log.md:188-189": [188, 189, true, "L188 halt returns {error:'halt:<rule>',msgs} even with throwOnError; L189 synthetic [halted:<rule>] tool msg"],
  "docs/CHANGELOG.md:1519-1519": [1519, 1519, true, "L1519 wrapProvider dropped .model -> cost null; fix (1) spread provider, (2) Loop prefers response model (fix 2 at END of the long line)"],
  "docs/docs/wiki/decisions-log.md:177-177": [177, 177, true, "L177 heartbeat idleTimeoutMs, resets on every stdout/stderr line, SIGTERM->5s->SIGKILL, defaults off"],
  "docs/CHANGELOG.md:1017-1032": [1017, 1029, true, "L1017-1029 one stream event per content block repeats usage; 5.04x; a run of events sharing message.id = one turn"],
  "docs/bareagent.context.md:968-968": [968, 968, true, "L968 onTurn: CLI emits stream event per content block repeating usage; token axis 5.04x (turn definition not here)"],
};
// per-section override: the metering-design 149-175 source spans two sections; second section's answer span:
const ANS_SEC2 = { "docs/docs/product/2026-07-26-materials-metering-design.md:149-175@163": [165, 171, true, "L165-171 deadline checked between rounds overshoots one round; per-call timeout min(600000, remainingWallMs)"] };

const ranks = JSON.parse(readFileSync(join(O, "step4/m4/results.json"), "utf8")).rows.filter((r) => r.size === "1x" && r.set === "step3");
const results = [];
for (const repo of ["bareloop", "bareagent"]) {
  const db = new Database(join(O, "step2/root", repo, "lroot/.litectx/index.db"), { readonly: true });
  const qs = JSON.parse(readFileSync(join(O, "step3/questions", repo + ".json"), "utf8"));
  for (const q of qs) {
    const row = ranks.find((r) => r.id === q.id && r.repo === repo);
    const secRows = [];
    q.sources.forEach((s, si) => {
      const m = /^(.+):(\d+)-(\d+)$/.exec(s), p = m[1], a = +m[2], b = +m[3];
      const secs = db.prepare("SELECT n.start_line sl, n.end_line el, n.symbol sym, n.body body FROM doc_sections sec JOIN nodes n ON n.id = sec.node_id WHERE sec.path = ? AND n.start_line + 1 <= ? AND n.end_line + 1 >= ? ORDER BY n.start_line").all(p, b, a);
      if (!secs.length) { secRows.push({ source: s, error: "no section row (not skipped silently: reported)" }); return; }
      for (const x of secs) {
        const ak = ANS_SEC2[`${s}@${x.sl + 1}`] ?? ANS[s];
        let [la, lb, core, ev] = ak;
        // clamp the answer span into this section (a gold source can straddle two sections)
        const secA = x.sl + 1, secB = x.el + 1;
        if (la < secA || la > secB) { la = secA; }
        if (lb > secB) lb = secB;
        // sections where the hand-marked span is in the OTHER section of a straddling source: use the evidence key for sec1 (first section) only
        if (s.includes("materials-metering") && s.endsWith("149-175") && x.sl + 1 === 149 && !ANS_SEC2[`${s}@${x.sl + 1}`]) { la = 156; lb = 156; }
        const lines = x.body.split("\n");
        const rel = (ln) => ln - secA; // index into lines
        const pre = lines.slice(0, rel(la)).join("\n") + (rel(la) > 0 ? "\n" : "");
        const preUpTo = lines.slice(0, rel(lb) + 1).join("\n");
        const startChar = pre.length, endChar = preUpTo.length;
        const startTok = 1 + nTok(pre, false); // +1 = [CLS]; index of first answer token
        const endTok = 1 + nTok(preUpTo, false); // index just past last answer token
        const embedded = x.body.slice(0, HEAD_CHARS);
        const fullTok = nTok(x.body), embTok = nTok(embedded);
        const limit = Math.min(MAXLEN, embTok); // tokens the model actually reads (incl CLS/SEP)
        const effLast = MAXLEN - 1; // last readable content slot (SEP takes the 512th)
        const s256 = startTok >= 255, s512 = startTok >= effLast, c6000 = startChar >= HEAD_CHARS;
        secRows.push({
          source: s, goldRank: row ? (Number.isFinite(row.direct[si]) ? row.direct[si] : null) : undefined, section: `L${secA}-${secB}`, symbol: x.sym, core,
          chars: x.body.length, fullTokens: fullTok, embeddedTokens: Math.min(embTok, MAXLEN), exceeds512: fullTok > MAXLEN, exceeds256: fullTok > 256, charCapHit: x.body.length > HEAD_CHARS,
          answerLines: `${la}-${lb}`, answerStartTok: startTok, answerEndTok: endTok, answerStartChar: startChar,
          past256: s256, past512: s512, pastCharCap: c6000, straddles512: !s512 && endTok > effLast, straddles256: !s256 && endTok > 255,
          // visible = the answer START is inside what the model reads
          visibleToModel: !s512 && !c6000, evidence: ev,
        });
      }
    });
    const direct = row ? row.direct.map((d) => (Number.isFinite(d) ? d : null)) : null;
    const fin = (d) => d.filter((x) => x !== null);
    const f8 = direct ? fin(direct).some((d) => d <= 8) : null, f20 = direct ? fin(direct).some((d) => d <= 20) : null;
    const core = secRows.filter((r) => r.core && !r.error);
    results.push({
      id: q.id, repo, question: q.question, direct, found8: f8, found20: f20,
      coreSections: core.length,
      anyCoreVisible512: core.some((r) => r.visibleToModel), allCorePast512: core.every((r) => !r.visibleToModel),
      anyCoreVisible256: core.some((r) => !r.past256 && !r.pastCharCap), allCorePast256: core.every((r) => r.past256 || r.pastCharCap),
      minCoreStartTok: Math.min(...core.map((r) => r.answerStartTok)), secs: secRows,
    });
  }
  db.close();
}

// ---- totals ----
const T = (pred, key) => ({ n: results.filter(pred).length, past: results.filter((r) => pred(r) && r[key]).length });
const grp = (name, pred) => ({ name, n: results.filter(pred).length, allCorePast512: results.filter((r) => pred(r) && r.allCorePast512).length, allCorePast256: results.filter((r) => pred(r) && r.allCorePast256).length, anyVisible512: results.filter((r) => pred(r) && r.anyCoreVisible512).length });
const totals = [grp("miss@8", (r) => !r.found8), grp("hit@8", (r) => r.found8), grp("miss@20", (r) => !r.found20), grp("hit@20", (r) => r.found20)];
const skipped = results.flatMap((r) => r.secs.filter((s) => s.error).map((s) => `${r.id} ${s.source}: ${s.error}`));

writeFileSync(join(OUT, "results.json"), JSON.stringify({ tokenizerMaxLen: MAXLEN, probeTruncatedLen: probe, headChars: HEAD_CHARS, totals, skipped, results }, null, 1));

const L = [], P = (s = "") => L.push(s);
P("# tinymem cut-off probe (Part 1: counting only)");
P(`Embed input = section body (nodes.body == chunk.text), HEAD-sliced to ${HEAD_CHARS} chars by litectx (src/embedder.js HEAD_CHARS, applied in embed()), then the transformers.js pipeline tokenizes with truncation:true -> tokenizer.model_max_length = ${MAXLEN} (measured: a 3000-word text tokenizes to ${probe} ids). So litectx's EFFECTIVE window = ${MAXLEN} tokens incl [CLS]/[SEP] and 6000 chars, whichever bites first. The model's TRAINED window (sentence-transformers sentence_bert_config.json max_seq_length) is 256; the Xenova tokenizer.json also carries a stale truncation.max_length=128 that the pipeline does not use. Both cuts reported: past256 / past512.`);
P("Frozen question hashes verified against FROZEN.sha256. Answer spans marked by reading (evidence column); core=n means that gold source holds no must-item.");
P();
P("Question level: 'answer past cut-off' = EVERY core gold section has its answer START at/after the cut (model never saw the start of any answer-bearing section). 'any visible' = at least one core section shows its answer start inside the window.");
P();
P("| question | found@8 | found@20 | gold ranks (per source) | min core answer-start tok | all core past 512? | all core past 256? |");
P("|---|---|---|---|---|---|---|");
for (const r of results) P(`| ${r.id} | ${r.found8 ? "yes" : "no"} | ${r.found20 ? "yes" : "no"} | ${r.direct ? r.direct.map((d) => d ?? "-").join(",") : "n/a"} | ${r.minCoreStartTok} | ${r.allCorePast512 ? "YES" : "no"} | ${r.allCorePast256 ? "YES" : "no"} |`);
P();
P("## Per gold section");
P("| question | rank | section | core | chars | section tokens (full) | tokens embedded | exceeds 512? | answer lines | answer start tok | answer end tok | past 256 | past 512 | straddles 512 | evidence |");
P("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of results) for (const s of r.secs) {
  if (s.error) { P(`| ${r.id} | | ${s.source} | | | | | | | | | | | | ERROR ${s.error} |`); continue; }
  P(`| ${r.id} | ${s.goldRank ?? "-"} | ${s.section} | ${s.core ? "y" : "n"} | ${s.chars} | ${s.fullTokens} | ${s.embeddedTokens} | ${s.exceeds512 ? "YES" : "no"} | ${s.answerLines} | ${s.answerStartTok} | ${s.answerEndTok} | ${s.past256 ? "YES" : "no"} | ${s.past512 || s.pastCharCap ? "YES" : "no"} | ${s.straddles512 ? "yes" : "no"} | ${s.evidence.replace(/\|/g, "/")} |`);
}
P();
P("## Totals (question level)");
P("| group | n | all core past 512 | all core past 256 | any core answer visible (<512) |");
P("|---|---|---|---|---|");
for (const t of totals) P(`| ${t.name} | ${t.n} | ${t.allCorePast512} | ${t.allCorePast256} | ${t.anyVisible512} |`);
P();
P("Skipped: " + (skipped.length ? skipped.join("; ") : "none") + ". Questions in step3 files: " + results.length + " (bareagent-p03 is not in the frozen file).");
writeFileSync(join(OUT, "report.md"), L.join("\n") + "\n");
console.log(L.join("\n"));
