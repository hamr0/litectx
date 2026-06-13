// THROWAWAY POC — §4.5 gate #2: does down-tiering the MIDDLE band preserve task success?
//
// §4.3 proposes a positional compose for assemble(): PIN head verbatim · KEEP tail verbatim ·
// DOWN-TIER the middle valley (signature via shipped compress(), grounded in lost-in-the-middle).
// FIT already pins head + keeps tail (recency). The new claim is: the MIDDLE is the SAFE band to
// compress, and SIGNATURE-tiering it preserves the answer where DROPPING it loses it — at ~82% bytes.
//
// The byte saving is already proven (R-C7). The OPEN question is task success: when the answer lives
// in the middle, does a SIGNATURE-rendered middle still let the model answer (≈ verbatim), while a
// DROPPED middle fails? And the honest limit: signature keeps the DOC/header, not the body — so a
// body-level answer is lost by signature too (no better than drop). We test both needle kinds.
//
// Model = `claude -p --tools ""` via stdin (tools off → must answer from the assembled context).
// Deterministic survival+bytes recorded alongside, as a sanity floor under the model verdict.
// Run: node poc/compress-middle-poc.mjs

import { execFileSync } from "node:child_process";
import { compress } from "../src/compress.js";

const MODEL = "sonnet";

// ── a realistic context: 12 JS service-handler units with JSDoc. head=0..2, tail=9..11 pinned;
//    middle = 3..8 is the down-tier band. Each unit documents a distinct fictional service. ─────────
const SERVICES = [
  "ledger", "paywall", "ingest", "notify", "geocode", "archive",
  "throttle", "transcode", "webhook", "sessionz", "registry", "sweeper",
];

/** doc-needle: the answer lives in the JSDoc (signature KEEPS it). */
function unitDocNeedle(svc, i, needleFact) {
  const doc = needleFact
    ? `/**\n * Handles the ${svc} pipeline. ${needleFact}\n * @param {object} req inbound request\n * @returns {Promise<object>} the ${svc} result\n */`
    : `/**\n * Handles the ${svc} pipeline for routine ${svc} traffic.\n * @param {object} req inbound request\n * @returns {Promise<object>} the ${svc} result\n */`;
  return `${doc}\nexport async function handle_${svc}(req) {\n  const ctx = await open_${svc}(req);\n  const out = await run_${svc}_stage(ctx, req.payload);\n  await flush_${svc}(out);\n  return { ok: true, service: "${svc}", id: out.id };\n}`;
}

/** body-needle: the answer lives in the function BODY (signature ELIDES it — honest-limit control). */
function unitBodyNeedle(svc, needleFact) {
  return `/**\n * Handles the ${svc} pipeline.\n * @param {object} req inbound request\n * @returns {Promise<object>}\n */\nexport async function handle_${svc}(req) {\n  // ${needleFact}\n  const ctx = await open_${svc}(req);\n  const out = await run_${svc}_stage(ctx, req.payload);\n  return { ok: true, service: "${svc}", id: out.id };\n}`;
}

async function render(units, mode) {
  // head 0..2 + tail 9..11 always verbatim; middle 3..8 rendered per mode.
  const out = [];
  let dropped = 0;
  for (let i = 0; i < units.length; i++) {
    const inMiddle = i >= 3 && i <= 8;
    if (!inMiddle || mode === "verbatim") {
      out.push(units[i].text);
    } else if (mode === "signature") {
      out.push(await compress({ format: "js", text: units[i].text, symbol: `handle_${units[i].svc}` }, { level: "signature" }));
    } else if (mode === "drop") {
      dropped++; // collapse the whole middle into one handle line at the first drop
    }
  }
  if (mode === "drop") {
    out.splice(3, 0, `// [${dropped} context units elided to fit budget — ids u3..u8]`);
  }
  return out.join("\n\n");
}

function ask(context, question) {
  const prompt =
    `${context}\n\n` +
    `---\nUsing ONLY the code/comments above, answer this question.\n` +
    `Reply with JUST the specific value, or exactly "NOT FOUND" if it is not present above.\n` +
    `Question: ${question}`;
  try {
    return execFileSync("claude", ["-p", "--tools", "", "--model", MODEL], {
      input: prompt, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 180000,
    }).trim();
  } catch (e) {
    return `__ERROR__ ${e.message}`;
  }
}

// ── trials: each fact NAMES its own host service, and the question names the SAME service, so the
//    needle and the question are always aligned (the host service = SERVICES[pos]). Doc-needles
//    rotate through middle positions 3..8; 2 body-needle controls. ${s} is filled at build time. ────
const mk = (factT, qT, val) => ({ factT, qT, val });
const DOC_FACTS = [
  mk((s) => `The ${s} pipeline's dead-letter queue drains every 47 seconds.`, (s) => `How often does the ${s} pipeline's dead-letter queue drain?`, "47"),
  mk((s) => `The ${s} pipeline signs callbacks with key id NK-8841.`, (s) => `What key id does the ${s} pipeline sign callbacks with?`, "NK-8841"),
  mk((s) => `The ${s} pipeline caches its results in region eu-west-3 only.`, (s) => `Which region caches the ${s} pipeline's results?`, "eu-west-3"),
  mk((s) => `The ${s} pipeline seals cold archives after 19 days.`, (s) => `After how many days does the ${s} pipeline seal cold archives?`, "19"),
  mk((s) => `The ${s} pipeline's rate limiter allows 220 requests per minute.`, (s) => `How many requests per minute does the ${s} pipeline's rate limiter allow?`, "220"),
  mk((s) => `The ${s} pipeline transcodes at a target bitrate of 3.5 Mbps.`, (s) => `What target bitrate does the ${s} pipeline use?`, "3.5"),
];
const BODY_FACTS = [
  mk((s) => `SECRET: the ${s} fallback provider is maptiler-x.`, (s) => `What is the ${s} fallback provider?`, "maptiler-x"),
  mk((s) => `SECRET: the ${s} burst ceiling is 900.`, (s) => `What is the ${s} burst ceiling?`, "900"),
];
const MIDDLE_POS = [3, 4, 5, 6, 7, 8];
const DOC_TRIALS = DOC_FACTS.map((f, k) => {
  const pos = MIDDLE_POS[k % MIDDLE_POS.length], svc = SERVICES[pos];
  return { pos, svc, fact: f.factT(svc), q: f.qT(svc), val: f.val };
});
const BODY_TRIALS = BODY_FACTS.map((f, k) => {
  const pos = [5, 7][k], svc = SERVICES[pos];
  return { pos, svc, fact: f.factT(svc), q: f.qT(svc), val: f.val };
});

function buildUnits(trial, kind) {
  return SERVICES.map((svc, i) => {
    if (i === trial.pos) {
      return { svc, text: kind === "doc" ? unitDocNeedle(svc, i, trial.fact) : unitBodyNeedle(svc, trial.fact) };
    }
    return { svc, text: unitDocNeedle(svc, i, null) };
  });
}

const MODES = ["verbatim", "signature", "drop"];
const tally = {};
// retrieved = model produced the value (the TASK succeeded — info reached AND was used).
// survive   = needle bytes present in the render. abstain = correctly said NOT FOUND when absent.
// hallucinated = produced the value when it was NOT present (made up — should be ~0).
for (const m of MODES) tally[m] = { retrieved: 0, n: 0, bytes: 0, baseBytes: 0, survive: 0, abstain: 0, halluc: 0 };

async function runSet(trials, kind) {
  console.log(`\n===== ${kind.toUpperCase()}-NEEDLE TRIALS (answer in ${kind === "doc" ? "JSDoc — signature KEEPS it" : "function body — signature ELIDES it"}) =====`);
  for (const t of trials) {
    const units = buildUnits(t, kind);
    const verbatimBytes = (await render(units, "verbatim")).length;
    for (const mode of MODES) {
      const ctx = await render(units, mode);
      const present = ctx.includes(t.val) || ctx.includes(t.fact);
      const ans = ask(ctx, t.q);
      const correct = new RegExp(t.val.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(ans);
      const abstained = /not found/i.test(ans);
      const T = tally[mode];
      T.n++; T.bytes += ctx.length; T.baseBytes += verbatimBytes;
      if (present) T.survive++;
      if (correct) T.retrieved++;
      if (!present && abstained) T.abstain++;
      if (!present && correct) T.halluc++;
      const verdict = correct ? "RETRIEVED" : abstained ? (present ? "missed(said NF)" : "abstain✓") : "wrong";
      console.log(
        `  [${mode.padEnd(9)}] svc=${t.svc.padEnd(9)} pos=${t.pos} present=${present ? "Y" : "n"} ${ctx.length}B  → ` +
        `"${ans.slice(0, 40).replace(/\n/g, " ")}"  ${verdict}`,
      );
    }
  }
}

await runSet(DOC_TRIALS, "doc");
await runSet(BODY_TRIALS, "body");

console.log(`\n================= SUMMARY (task metric = RETRIEVED the value) =================`);
for (const m of MODES) {
  const t = tally[m];
  const saved = t.baseBytes ? (100 * (1 - t.bytes / t.baseBytes)).toFixed(0) : "0";
  console.log(
    `${m.padEnd(9)}: retrieved ${t.retrieved}/${t.n}  · needle survived ${t.survive}/${t.n}  · ` +
    `abstain-when-absent ${t.abstain}  · halluc ${t.halluc}  · ${saved}% bytes saved`,
  );
}
console.log(
  `\nRead: RETRIEVED is the task metric (info reached the model AND was used). If SIGNATURE ≈ VERBATIM\n` +
  `on doc-needles but DROP ≈ 0, down-tiering the middle to signatures preserves doc-level task success\n` +
  `where dropping destroys it — at the byte saving. Drop's high "abstain" is honest-but-empty: the\n` +
  `info is simply gone. BODY-needles are the honest limit: signature elides the body, so it tracks DROP.`,
);
