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
