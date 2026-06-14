// POC — R-C6 summaryWindow windowing POLICY (CE-PRD §10.1 / baresuite-litectx-prd §3.1 step 3).
//
// The decided next litectx build is the summary-window POLICY: keep the last-N turns verbatim, roll
// everything OLDER into a rolling summary (the LLM call is bareagent's `summarize()`; litectx owns
// trigger/N/splice, and the splice is the shipped restorable COMPRESS path). This POC validates the
// ONE thing that decides whether to build it — the riskiest assumption, not the plumbing:
//
//   At an EQUAL token budget, does last-N-verbatim + rolling-summary-of-older retain task-relevant
//   answers that plain FIT-drop (the shipped assemble) LOSES?
//
// If yes → build it. If the summary is too lossy (drops the same facts), or FIT-drop already keeps
// enough → no win, don't build. The test MUST be able to fail (prove-don't-assert):
//   - the summarizer gets a GENERIC "summarize concisely" prompt — it is NOT told which facts to keep,
//     so a fact it drops is a real miss (no crafting the summary to contain the answer);
//   - probes mix salient decisions (a good summary keeps) with incidental details (a summary may drop);
//   - a CONTROL probe whose answer is in a recent turn (kept verbatim by BOTH) must pass for both, or
//     the harness itself is broken.
//
// Real components: the SHIPPED `assemble` does the FIT-drop arm AND the final fit of the summary arm;
// a live `claude -p` (tools OFF) is both the summarizer (stand-in for bareagent's `summarize()`) and
// the answerer. Run: node poc/rc6-summarywindow-poc.mjs

import { execFileSync } from "node:child_process";
import { assemble, summaryWindow } from "../src/index.js";

const MODEL = "sonnet";

// ── A realistic agent session. Facts are seeded in EARLY turns (1-6) that a tight budget will drop;
//    recent turns (9-12) are unrelated frontend work, kept verbatim by both arms. Nothing here is
//    written to be summary-friendly — it's ordinary session prose. ──────────────────────────────────
const TURNS = [
  ["user",      "Let's harden the billing service. Start by reviewing the retry + persistence setup."],
  ["assistant", "Reviewed the HTTP client. I set MAX_RETRIES to 5 with an exponential backoff base of 200ms; anything past 5 attempts surfaces a hard error to the caller rather than retrying silently."],
  ["user",      "Good. What about the datastore — are we still deciding?"],
  ["assistant", "Decision made: we chose Postgres over DynamoDB because billing reconciliation needs transactional multi-row joins across invoices and ledger entries, which Dynamo can't do atomically."],
  ["user",      "Note the staging access so the team can repro."],
  ["assistant", "The staging database URL (with credentials) lives in the STAGING_PG_URL env var — it is NOT committed; pull it from the 1Password 'billing-staging' item."],
  ["user",      "Now the reconciliation job itself."],
  ["assistant", "The reconciliation job runs nightly at 02:00 UTC via the cron worker, batches 1000 invoices per transaction, and writes a summary row to the audit_runs table on completion."],
  // ── filler: routine work between the early decisions and the recent UI thread; long enough that a
  //    budget holding (summary + last-N) cannot buy the EARLY fact-turns back into the FIT view. ──
  ["user",      "Add some observability before we move on."],
  ["assistant", "Added a Prometheus counter billing_retry_total labeled by outcome, and a histogram for backoff latency. Wired both into the existing /metrics endpoint and confirmed they scrape locally."],
  ["user",      "Does the worker handle SIGTERM cleanly?"],
  ["assistant", "It does now — the cron worker traps SIGTERM, stops pulling new batches, lets the in-flight transaction commit, then exits 0. Verified with a manual kill during a batch."],
  ["user",      "What about connection pooling?"],
  ["assistant", "Set the pg pool to max 20 connections with a 30s idle timeout; the nightly job and the API share the same pool config via db/pool.js, so we don't double-provision."],
  ["user",      "Any test coverage gaps?"],
  ["assistant", "The reconciliation happy-path is covered, but partial-failure (a batch that errors mid-transaction) isn't. Added a fixture that injects a constraint violation on row 500 and asserts the whole batch rolls back."],
  ["user",      "Switch gears — the dashboard's date filter is broken in the UI."],
  ["assistant", "Found it: the date picker emits local time but the API expects UTC, so the filter is off by the user's timezone offset. Fixing the serializer in DateFilter.tsx to call toISOString()."],
  ["user",      "Any other UI fallout from that?"],
  ["assistant", "Yes — the CSV export reused the same buggy local-time formatter, so exported rows were also shifted. Patched both to share one toISOString() helper in lib/time.ts."],
];

// Probes: which turn holds the answer, the question, and an accept-substring the answer must contain.
const PROBES = [
  { turn: 2,  q: "What is MAX_RETRIES set to in the billing HTTP client?",                 accept: ["5"],                          kind: "early/salient" },
  { turn: 4,  q: "Why was Postgres chosen over DynamoDB?",                                  accept: ["join", "transaction"],       kind: "early/salient" },
  { turn: 6,  q: "Which env var holds the staging database URL?",                           accept: ["STAGING_PG_URL"],            kind: "early/incidental" },
  { turn: 8,  q: "At what time (UTC) does the reconciliation job run?",                     accept: ["02:00", "2:00", "2 "],       kind: "mid/incidental" },
  { turn: 20, q: "Which file got a shared toISOString helper for the CSV export fix?",      accept: ["lib/time.ts", "time.ts"],    kind: "recent/control" },
];

const unitsFrom = (turns) => turns.map(([role, content], i) => ({ id: `t${i + 1}`, role, content }));
const renderView = (units) => units.map((u) => `[${u.role}] ${u.content}`).join("\n\n");

function ask(prompt) {
  try {
    return execFileSync("claude", ["-p", "--tools", "", "--model", MODEL], {
      input: prompt, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180000,
    }).trim();
  } catch (e) { return `__ERR__ ${e.message?.slice(0, 80)}`; }
}

const answerAll = (view) =>
  ask(
    `You are answering ONLY from the conversation excerpt below. For each numbered question, reply with ` +
    `the answer on its own line as "N: <answer>", or "N: CANNOT_DETERMINE" if the excerpt does not contain it.\n\n` +
    `=== EXCERPT ===\n${view}\n=== END ===\n\n` +
    PROBES.map((p, i) => `${i + 1}. ${p.q}`).join("\n"),
  );

const scored = (raw) =>
  PROBES.map((p, i) => {
    const line = raw.split("\n").find((l) => l.trim().startsWith(`${i + 1}:`)) ?? "";
    const ans = line.slice(line.indexOf(":") + 1).trim();
    const hit = ans !== "" && !/CANNOT_DETERMINE/i.test(ans) &&
      p.accept.some((a) => ans.toLowerCase().includes(a.toLowerCase()));
    return { ...p, ans, hit };
  });

// ── Setup ─────────────────────────────────────────────────────────────────────────────────────────
const all = unitsFrom(TURNS);
const N = 4;                                   // last-N kept verbatim
const recent = all.slice(-N);
const older = all.slice(0, -N);
const tok = (s) => Math.ceil(s.length / 4);

// The summarizer (stand-in for bareagent's ctx.summarize). Memoized by folded-turn count so the
// budget-sizing call and the in-assemble call return the SAME text (deterministic budget).
const memo = new Map();
const summarize = async (msgs) => {
  if (memo.has(msgs.length)) return memo.get(msgs.length);
  const text = ask(
    `Summarize the following earlier portion of an engineering conversation concisely (a few sentences), ` +
    `preserving concrete decisions and values a teammate might need later:\n\n` +
    msgs.map((m) => `[${m.role}] ${m.content}`).join("\n\n"),
  );
  memo.set(msgs.length, text);
  return text;
};

// Size the EQUAL budget = summary(of older) + last-N verbatim + headroom, so the FIT arm spends the
// summary-sized slack buying back the most RECENT older turns (never reaching the early fact-turns).
const summaryText = await summarize(older.map((u) => ({ role: u.role, content: u.content })));
const budget = tok(summaryText) + recent.reduce((n, u) => n + tok(u.content), 0) + 20;

console.log(`R-C6 summaryWindow — equal-budget A/B (budget≈${budget} tok, last-N=${N}, model=${MODEL})\n`);

// Arm 1 — FIT-drop (the shipped verb, no summarize).
const fit = await assemble(all, { budget });
console.log(`FIT-drop: kept ${fit.units.length}/${all.length} turns (dropped ${fit.dropped.length} older), ${fit.tokens} tok`);

// Arm 2 — summaryWindow via the SHIPPED verb (same budget, keep last-N verbatim).
console.log(`summary of ${older.length} older turns = ${tok(summaryText)} tok`);
const sw = await summaryWindow(all, { budget, summarize, summaryKeep: N });
const swSummary = sw.units.find((u) => u.summary);
const swSummarized = sw.dropped.filter((d) => d.reason === "summarized").map((d) => d.id);
console.log(`summaryWindow (shipped tier): kept ${sw.units.length} units, ${sw.tokens} tok; ` +
  `summary spliced=${!!swSummary} folding ${swSummarized.length} turns\n`);

// ── Probe both views with the live model ────────────────────────────────────────────────────────────
const fitScore = scored(answerAll(renderView(fit.units)));
const swScore = scored(answerAll(renderView(sw.units)));

console.log("probe                         | in view? (fit/sw) | fit | sw");
console.log("-".repeat(70));
for (let i = 0; i < PROBES.length; i++) {
  const p = PROBES[i];
  const inFit = fit.units.some((u) => u.id === `t${p.turn}`);
  const inSw = sw.units.some((u) => u.id === `t${p.turn}`) || (swSummarized.includes(`t${p.turn}`)); // verbatim OR folded into summary
  console.log(
    `${p.kind.padEnd(18)} t${String(p.turn).padEnd(2)} | ${String(inFit).padEnd(5)}/${String(inSw).padEnd(5)} ` +
    `| ${fitScore[i].hit ? " ✓ " : " ✗ "} | ${swScore[i].hit ? " ✓ " : " ✗ "}  ${swScore[i].hit ? "" : `(sw said: ${swScore[i].ans.slice(0, 40)})`}`,
  );
}

const fitHits = fitScore.filter((s) => s.hit).length;
const swHits = swScore.filter((s) => s.hit).length;
// The discriminator: probes whose answer is in a DROPPED-by-FIT turn (the early/mid ones).
const disc = PROBES.map((p, i) => ({ p, i })).filter(({ p }) => !fit.units.some((u) => u.id === `t${p.turn}`));
const fitDisc = disc.filter(({ i }) => fitScore[i].hit).length;
const swDisc = disc.filter(({ i }) => swScore[i].hit).length;
const control = PROBES.findIndex((p) => p.kind.includes("control"));

console.log(`\n${"─".repeat(70)}`);
console.log(`total: FIT-drop ${fitHits}/${PROBES.length} · summaryWindow ${swHits}/${PROBES.length}`);
console.log(`discriminator (answers in FIT-dropped turns): FIT ${fitDisc}/${disc.length} · summaryWindow ${swDisc}/${disc.length}`);
console.log(`control (recent turn, both should pass): fit=${fitScore[control].hit} sw=${swScore[control].hit}`);

const controlOk = fitScore[control].hit && swScore[control].hit;
if (!controlOk) {
  console.log("\nGATE: INVALID — control probe failed; the harness or model call is broken, not a finding.");
  process.exit(2);
}
if (swDisc > fitDisc) {
  console.log(`\nGATE: PASS — at equal budget, summaryWindow retained ${swDisc} answer(s) FIT-drop lost (${fitDisc}).`);
  console.log("→ The policy beats plain eviction; build R-C6 (wire bareagent's summarize() into the splice).");
} else {
  console.log(`\nGATE: FAIL — summaryWindow did not beat FIT-drop on dropped-turn answers (${swDisc} vs ${fitDisc}).`);
  console.log("→ Either the summary was too lossy or eviction kept enough; do NOT build on this evidence.");
  process.exit(1);
}
