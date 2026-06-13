// THROWAWAY POC — §4.5 gate #2, the UNTESTED premise: does lost-in-the-middle actually manifest?
//
// gate #2 v1 (compress-middle-poc.mjs) showed signature-tier PRESERVES a middle answer where drop
// loses it — but at ~4.6 KB the model retrieved the middle needle 8/8, so lost-in-the-middle (the whole
// justification for compressing the MIDDLE specifically) NEVER MANIFESTED. §4.3's positional framing
// hinges on it. This POC tests it properly: a large, homogeneous haystack where the model must find a
// single distinctive needle BY ATTENTION (the question does not name its unit), swept across relative
// positions. If mid-context accuracy drops vs head/tail → middle is the safe band to compress. If it
// stays flat-high even at scale → the positional premise is FALSE for this model and §4.3 should NOT
// build a positional middle-band rule (sound verdict either way — this can kill the positional framing).
//
// Model = `claude -p --tools ""` via stdin (sonnet, tools off → must answer from context).
// Run: node poc/lost-in-middle-poc.mjs

import { execFileSync } from "node:child_process";

const MODEL = "sonnet";
const N_UNITS = 400;          // homogeneous filler units → ~140 KB context (~35k tokens)
const POSITIONS = [0.0, 0.25, 0.5, 0.75, 1.0];

// homogeneous filler: 150 near-identical service handlers (svc000..svc149). The needle is the ONLY unit
// carrying a distinctive marker; the question asks for that marker generically, so the model cannot
// jump to a named unit — it must attend across the whole context (the lost-in-the-middle condition).
function filler(i) {
  const s = `svc${String(i).padStart(3, "0")}`;
  return `/**\n * Handles the ${s} pipeline for routine ${s} traffic; standard retmilter and flush.\n * @param {object} req inbound request\n * @returns {Promise<object>} the ${s} result\n */\nexport async function handle_${s}(req) {\n  const ctx = await open_${s}(req);\n  const out = await run_${s}_stage(ctx, req.payload);\n  await flush_${s}(out);\n  return { ok: true, service: "${s}", id: out.id };\n}`;
}
function needleUnit(marker) {
  // benign, distinctive operational detail in an otherwise-ordinary unit (NO secret/override/auth
  // language — that tripped prompt-injection flagging in v1 and contaminated the answers).
  return `/**\n * Handles the svchub pipeline for routine svchub traffic.\n * Note: ${marker}\n * @param {object} req inbound request\n * @returns {Promise<object>} the svchub result\n */\nexport async function handle_svchub(req) {\n  const ctx = await open_svchub(req);\n  const out = await run_svchub_stage(ctx, req.payload);\n  await flush_svchub(out);\n  return { ok: true, service: "svchub", id: out.id };\n}`;
}

// benign + distinctive values that cannot collide with svcNNN filler; questions do NOT name the unit,
// so the model must find the fact by attention across the whole context.
const NEEDLES = [
  { marker: "the fleet-wide batch ceiling is tagged BCEIL-8841.", q: "What is the fleet-wide batch ceiling tag?", val: "BCEIL-8841" },
  { marker: "the shared canary release is labeled CANARY-QFX204.", q: "What is the shared canary release label?", val: "CANARY-QFX204" },
  { marker: "the cross-service trace cookie is named TRACE-ZP19.", q: "What is the cross-service trace cookie name?", val: "TRACE-ZP19" },
];

function ask(context, question) {
  const prompt =
    `${context}\n\n---\n` +
    `Using ONLY the code and comments above, answer this question.\n` +
    `Reply with JUST the specific value, or exactly "NOT FOUND" if it is not present.\n` +
    `Question: ${question}`;
  try {
    return execFileSync("claude", ["-p", "--tools", "", "--model", MODEL], {
      input: prompt, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180000,
    }).trim();
  } catch (e) {
    return `__ERROR__ ${e.message}`;
  }
}

function buildContext(needle, posFrac) {
  const units = [];
  for (let i = 0; i < N_UNITS; i++) units.push(filler(i));
  const at = Math.min(N_UNITS, Math.max(0, Math.round(posFrac * N_UNITS)));
  units.splice(at, 0, needleUnit(needle.marker)); // insert needle at the relative position
  return { ctx: units.join("\n\n"), at };
}

const byPos = {};
for (const p of POSITIONS) byPos[p] = { pass: 0, n: 0 };

const sample = buildContext(NEEDLES[0], 0.5);
console.log(`haystack: ${N_UNITS} units, context ≈ ${(sample.ctx.length / 1024).toFixed(0)} KB (~${Math.round(sample.ctx.length / 4 / 1000)}k tokens)\n`);

for (const needle of NEEDLES) {
  for (const p of POSITIONS) {
    const { ctx, at } = buildContext(needle, p);
    const ans = ask(ctx, needle.q);
    const correct = new RegExp(needle.val.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(ans);
    byPos[p].n++;
    if (correct) byPos[p].pass++;
    console.log(`  pos=${(p * 100).toFixed(0).padStart(3)}% (unit ${at}/${N_UNITS})  "${needle.val}"  → "${ans.slice(0, 36).replace(/\n/g, " ")}"  ${correct ? "FOUND" : "MISS"}`);
  }
}

console.log(`\n================= RETRIEVAL BY POSITION =================`);
for (const p of POSITIONS) {
  const b = byPos[p];
  console.log(`  pos ${(p * 100).toFixed(0).padStart(3)}% : ${b.pass}/${b.n} found`);
}
const head = byPos[0.0].pass + byPos[1.0].pass, headN = byPos[0.0].n + byPos[1.0].n;
const mid = byPos[0.5].pass, midN = byPos[0.5].n;
console.log(
  `\nRead: if MIDDLE (50%) accuracy < HEAD/TAIL (0%/100%), lost-in-the-middle MANIFESTS → compressing\n` +
  `the middle is the safe band (§4.3 positional framing holds). If accuracy is flat-high everywhere,\n` +
  `the premise is FALSE for this model at ${(sample.ctx.length / 1024).toFixed(0)} KB → do NOT build a positional middle rule; signature\n` +
  `stays a rank-driven budget tier (gate #2 v1). [ends: ${head}/${headN} · middle: ${mid}/${midN}]`,
);
