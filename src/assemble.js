// RT-1 — `assemble()`: budget-fit a multi-round transcript to a token budget without dropping the unit
// a later round re-reads (CE-PRD §8.2). The keystone CE read-path verb: bareagent hands litectx a
// neutral **unit** array (its messages, grammar-stripped) + a budget; litectx returns the fitted VIEW.
// litectx owns *content + relevance*, never the provider's transcript grammar — so the unit `role` is
// opaque to us (the consumer's grammar), and the two flags carry the whole contract:
//   - `pinned`  — never dropped, reordered (system prompt, current task). Budget is the UN-pinned room.
//   - `atomic`  — units sharing a group id (a tool-call + its result, bundled by bareagent's adapter)
//                 are kept-or-dropped WHOLE, never split → broken grammar is unrepresentable, not caught.
//
// The fit is **recency-anchored**, the one design constraint the POC pinned (`poc/assemble-fit-*.mjs`,
// RESULTS.md): re-reads are recency-bound, not topic-bound — semantic re-ranking of the transcript does
// NOT help and slightly hurts, so we keep the NEWEST un-pinned units and never reorder (cache-stable).
// What doesn't fit is **dropped — explicitly, never silently** (`dropped[]`), and restorable by id from
// the consumer's canonical transcript (the invariant bareagent guarantees): a dropped re-read becomes an
// explicit agent re-read, not lost data.
//
// SCOPE. Ships **FIT + the COMPRESS budget tier**. **SELECT (recall-inject) is deliberately NOT here** —
// auto-SELECT on in-window signal was POC-killed (`assemble-select-poc.mjs`: chunk-level re-supply ~0
// outside one repo); "re-supply the file I'm editing" is a direct `get`/`impact` path-fetch, and the
// never-read related-file mode needs an explicit agent query + its own POC. So `ctx.task` stays reserved.
// The caller injects code/doc units explicitly (its own `recall`/`get`); assemble's job is to FIT them
// and, when budget is tight, **down-tier the would-be-dropped ones to their SIGNATURE before evicting**
// (`compress-middle-poc`: signature ≫ drop for structural content, ~24% bytes, 0 hallucination; NOT a
// positional rule — lost-in-the-middle refuted at scale, so the tier is rank/recency-driven, reusing FIT).
//
// Async + deterministic: the only await is `compress()` (a pure tree-sitter render — no DB/model/Date/
// random), so the fitted view stays cache-stable & reproducible by construction.

import { compress } from "./compress.js";

/**
 * @typedef {Object} Unit
 * @property {string} id              stable identifier (the restore handle into the canonical transcript)
 * @property {string} role            conversational position ("user"|"assistant"|"tool"|"system") — the
 *                                     consumer's grammar; opaque to litectx, never interpreted here
 * @property {string} content         the unit's text
 * @property {string|null} [kind]     litectx node kind ("code"|"doc"|"fact"|"episode") for injected units;
 *                                     null for pass-through transcript turns (role and kind are orthogonal)
 * @property {string} [format]        "js"|"ts"|"py"|… — the parseable language of an injected code/doc node;
 *                                     enables the COMPRESS signature tier (absent on transcript turns)
 * @property {string} [symbol]        the node's symbol name (used for the compressed marker when present)
 * @property {boolean} [pinned]       never dropped or reordered; budget is computed over the un-pinned rest
 * @property {string|null} [atomic]   group id — units sharing one are kept-or-dropped together, never split
 * @property {number} [tokensApprox]  approximate token cost (the consumer's estimate; we fall back to chars/4)
 * @property {boolean} [compressed]   set by assemble on a unit down-tiered to its signature to fit budget
 *                                     (its `content` is the signature; full body recoverable by id, like a drop)
 * @property {boolean} [summary]      set by summaryWindow on the SYNTHETIC unit it splices in — its `content`
 *                                     is the rolling summary of the older turns it replaced
 * @property {string[]} [summarizes]  on a summary unit: the ids of the turns folded into it (each also
 *                                     reported in `dropped` with reason "summarized"; restorable by id)
 */

/**
 * @typedef {Object} AssembleCtx
 * @property {number} [budget]        token budget for the assembled view; omitted/Infinity → keep everything
 * @property {string} [task]          recall intent — reserved for SELECT (recall-inject), unused by the fit
 */

/**
 * @typedef {Object} AssembleResult
 * @property {Unit[]} units                            the fitted view: kept units in ORIGINAL order
 *                                                     (cache-stable — pinned in place, no reordering)
 * @property {{ id: string, reason: "budget" }[]} dropped   units elided to fit budget, in original order;
 *                                                     restorable by `id` from the consumer's canonical transcript
 * @property {number} tokens                           Σ `tokensApprox` of `units` (best-effort ≤ budget;
 *                                                     pinned that alone exceed budget are still kept — never a hard cap)
 */

const tokOf = (u) => {
  const t = u?.tokensApprox;
  return Number.isFinite(t) && t >= 0 ? t : Math.ceil((u?.content?.length ?? 0) / 4);
};

/**
 * Fit `units` to `ctx.budget`, recency-anchored, preserving `pinned`/`atomic` invariants; a would-be-
 * dropped code/doc unit is recovered as its `compress()` signature before being evicted (COMPRESS tier).
 * @param {Unit[]} units   the neutral transcript units, in conversation order (oldest → newest)
 * @param {AssembleCtx} [ctx]
 * @returns {Promise<AssembleResult>}
 */
export async function assemble(units, ctx = {}) {
  if (!Array.isArray(units)) throw new TypeError("assemble: units must be an array");
  const budget = Number.isFinite(ctx?.budget) ? /** @type {number} */ (ctx.budget) : Infinity;

  // Pinned are always kept and never enter the fit; they consume budget but are never the thing dropped
  // ("pin, don't hide" — the consumer must see their cost subtracted, which it does via this accounting).
  const keep = new Set();
  let used = 0;
  for (const u of units) if (u?.pinned) { keep.add(u.id); used += tokOf(u); }

  // Collapse the un-pinned remainder into FIT ITEMS: an atomic group is one item (kept/dropped whole);
  // a lone unit is a singleton item. `recency` = the newest member's position (atomic bundles ride their
  // freshest member). A group is force-kept if it contains a pinned member (atomic never splits).
  /** @type {Map<string, {ids:string[], tokens:number, recency:number, forced:boolean}>} */
  const groups = new Map();
  const items = [];
  units.forEach((u, i) => {
    if (!u || u.pinned) return; // pinned handled above (a pinned atomic member force-keeps its group below)
    if (u.atomic) {
      let g = groups.get(u.atomic);
      if (!g) { g = { ids: [], tokens: 0, recency: i, forced: false }; groups.set(u.atomic, g); items.push({ group: u.atomic }); }
      g.ids.push(u.id); g.tokens += tokOf(u); g.recency = i;
    } else {
      items.push({ ids: [u.id], tokens: tokOf(u), recency: i });
    }
  });
  // a pinned member anywhere in an atomic group forces the whole group (its pinned tokens already counted)
  for (const u of units) {
    const g = u?.pinned && u.atomic ? groups.get(u.atomic) : undefined;
    if (g) g.forced = true;
  }
  const resolved = items.map((it) => (it.group ? { ...groups.get(it.group) } : { ...it, forced: false }));

  // Recency-anchored: consider newest first. Skip-and-continue (not stop-at-first-overflow) so a tight
  // budget still keeps smaller older units rather than stranding the room — matches the POC's fit.
  resolved.sort((a, b) => b.recency - a.recency);
  for (const it of resolved) {
    if (it.forced || used + it.tokens <= budget) { for (const id of it.ids) keep.add(id); used += it.tokens; }
  }

  // COMPRESS budget tier (the rescue pass): a unit FIT would DROP, if it's a parseable code/doc node, is
  // recovered as its compress() SIGNATURE instead of evicted — header+doc kept, body elided. Strictly
  // dominates drop for structural content (compress-middle-poc: signature 6/6 vs drop 0/6, 0 hallucination,
  // ~24% bytes). Reuses FIT's recency order (newest stay verbatim; older code nodes demote before
  // vanishing) — NOT positional (lost-in-the-middle refuted at scale). Skips pinned/atomic/transcript
  // units: no parseable `format` → nothing to extract (compress would verbatim-fall-back to no saving).
  /** @type {Map<string, {content:string, tokens:number}>} */ const rescued = new Map();
  const candidates = units
    .map((u, i) => ({ u, i }))
    .filter(({ u }) => u && !keep.has(u.id) && !u.pinned && !u.atomic
      && (u.kind === "code" || u.kind === "doc") && u.format && u.content)
    .sort((a, b) => b.i - a.i); // newest-first — same priority the fit uses
  for (const { u } of candidates) {
    const sig = await compress({ text: u.content, format: u.format, symbol: u.symbol }, { level: "signature" });
    const sigTok = Math.ceil(sig.length / 4);
    if (sigTok < tokOf(u) && used + sigTok <= budget) { // only when the signature both SAVES and FITS
      rescued.set(u.id, { content: sig, tokens: sigTok });
      keep.add(u.id);
      used += sigTok;
    }
  }

  // Emit in ORIGINAL order (cache-stable); account for every non-kept unit in `dropped` (no silent loss).
  /** @type {Unit[]} */ const kept = [];
  /** @type {{id:string, reason:"budget"}[]} */ const dropped = [];
  let tokens = 0;
  for (const u of units) {
    const r = rescued.get(u.id);
    if (r) { kept.push({ ...u, content: r.content, tokensApprox: r.tokens, compressed: true }); tokens += r.tokens; }
    else if (keep.has(u.id)) { kept.push(u); tokens += tokOf(u); }
    else dropped.push({ id: u.id, reason: "budget" });
  }
  return { units: kept, dropped, tokens };
}

/**
 * @typedef {Object} SummaryWindowCtx
 * @property {number} [budget]        token budget for the assembled view (as {@link assemble})
 * @property {(messages: {role: string, content: string}[]) => Promise<string>} [summarize]
 *                                     a provider-bound summarizer the HOST supplies (litectx never calls a
 *                                     model itself). Absent → this is a plain {@link assemble}.
 * @property {number} [summaryKeep]   N most-recent transcript turns kept VERBATIM (default 8); everything
 *                                     older is rolled into one summary. litectx owns N.
 * @property {string} [summaryRole]   role for the spliced summary unit (default "system") — role is the
 *                                     consumer's grammar, so the host names it and its adapter places it
 * @property {string} [summaryId]     id for the spliced summary unit (default derived from the folded range)
 * @property {string} [task]          passed through to {@link assemble} (reserved)
 */

/**
 * summaryWindow (R-C6) — the rolling-summary read-path policy: keep the last-N transcript turns VERBATIM,
 * roll everything OLDER into one rolling summary, and budget-fit the result via {@link assemble}. litectx
 * owns trigger (engaged only under budget pressure) + N + the splice; the HOST owns the model (`ctx.summarize` —
 * litectx never calls one). The summary is a SYNTHETIC unit placed as the freshest content (a cache-stable
 * dynamic suffix; the verbatim prefix stays byte-identical for prefix caching) so the recency-anchored fit
 * keeps it; if even the summary can't fit it is dropped like any unit (never an overflow). The splice is
 * RESTORABLE: folded turns are reported in `dropped` (reason "summarized", recoverable by id) and listed on
 * the summary unit's `summarizes`. Falls back to a plain `assemble` when unwired, when everything already
 * fits (no pressure), or when there are < 2 older turns to fold — so it is never worse than FIT.
 * POC-gated: `poc/rc6-summarywindow-poc.mjs` — at equal budget, summaryWindow retained the dropped-turn
 * answers FIT-drop lost (discriminator 3/3 vs 0/3 on a live model).
 *
 * @param {Unit[]} units   the neutral transcript units, in conversation order (oldest → newest)
 * @param {SummaryWindowCtx} [ctx]
 * @returns {Promise<{ units: Unit[], dropped: {id: string, reason: "budget"|"summarized"}[], tokens: number }>}
 */
export async function summaryWindow(units, ctx = {}) {
  if (!Array.isArray(units)) throw new TypeError("summaryWindow: units must be an array");
  if (typeof ctx?.summarize !== "function") return assemble(units, ctx);
  const budget = Number.isFinite(ctx?.budget) ? /** @type {number} */ (ctx.budget) : Infinity;
  // No budget pressure → keep everything verbatim; summarizing would be wasted work (and a wasted model call).
  if (units.reduce((n, u) => n + tokOf(u), 0) <= budget) return assemble(units, ctx);

  const sk = ctx.summaryKeep;
  const N = typeof sk === "number" && Number.isInteger(sk) && sk >= 0 ? sk : 8;
  // Foldable = conversational turns only (pinned never folds; atomic tool-call/result pairs never elide into
  // prose; code/doc are COMPRESS's job inside assemble). "Older" = all foldable EXCEPT the last-N verbatim.
  const foldable = units.filter((u) => u && !u.pinned && !u.atomic && u.content && u.kind !== "code" && u.kind !== "doc");
  const older = N > 0 ? foldable.slice(0, -N) : foldable.slice();
  if (older.length < 2) return assemble(units, ctx); // a lone older turn isn't worth a model call / a summary

  const prose = await ctx.summarize(older.map((u) => ({ role: u.role, content: u.content })));
  const content = typeof prose === "string" ? prose.trim() : "";
  if (!content) return assemble(units, ctx); // summarizer gave nothing → fall back, never worse than FIT

  const olderIds = new Set(older.map((u) => u.id));
  /** @type {Unit} */ const summaryUnit = {
    id: ctx.summaryId ?? `summary:${older[0].id}..${older[older.length - 1].id}`,
    role: ctx.summaryRole ?? "system",
    content,
    kind: null,
    summary: true,
    summarizes: older.map((u) => u.id),
  };
  // Fit the verbatim tail + the summary (appended as freshest → top recency priority, so the fit keeps it
  // over older verbatim). assemble owns the budget math; nothing here can overflow it.
  const rest = units.filter((u) => !olderIds.has(u.id));
  const result = await assemble([...rest, summaryUnit], ctx);

  // Re-account `dropped` in ORIGINAL order: a folded turn is "summarized" if its summary survived the fit
  // (represented + restorable by id), else a plain "budget" drop (the summary itself didn't fit).
  const summaryKept = result.units.some((u) => u.id === summaryUnit.id);
  const budgetDropped = new Set(result.dropped.filter((d) => d.id !== summaryUnit.id).map((d) => d.id));
  /** @type {{id:string, reason:"budget"|"summarized"}[]} */ const dropped = [];
  for (const u of units) {
    if (olderIds.has(u.id)) dropped.push({ id: u.id, reason: summaryKept ? "summarized" : "budget" });
    else if (budgetDropped.has(u.id)) dropped.push({ id: u.id, reason: "budget" });
  }
  return { units: result.units, dropped, tokens: result.tokens };
}
