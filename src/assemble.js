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
// SCOPE (v1 = the gated core). This ships **FIT only**. SELECT (recall-inject of new graph context) and
// COMPRESS (signature-tier large units) are the next slice and ride together: COMPRESS needs a parseable
// `format`, which pass-through transcript units don't carry — only recall-injected units do. So there is
// nothing to compress until SELECT injects it. FIT is what the budget-fit POC gated; it builds alone.
//
// Pure function — no DB, no model, no `Date`/random → deterministic & cache-stable by construction.

/**
 * @typedef {Object} Unit
 * @property {string} id              stable identifier (the restore handle into the canonical transcript)
 * @property {string} role            conversational position ("user"|"assistant"|"tool"|"system") — the
 *                                     consumer's grammar; opaque to litectx, never interpreted here
 * @property {string} content         the unit's text
 * @property {string|null} [kind]     litectx node kind ("code"|"doc"|"fact"|"episode") for injected units;
 *                                     null for pass-through transcript turns (role and kind are orthogonal)
 * @property {boolean} [pinned]       never dropped or reordered; budget is computed over the un-pinned rest
 * @property {string|null} [atomic]   group id — units sharing one are kept-or-dropped together, never split
 * @property {number} [tokensApprox]  approximate token cost (the consumer's estimate; we fall back to chars/4)
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
 * Fit `units` to `ctx.budget`, recency-anchored, preserving `pinned`/`atomic` invariants.
 * @param {Unit[]} units   the neutral transcript units, in conversation order (oldest → newest)
 * @param {AssembleCtx} [ctx]
 * @returns {AssembleResult}
 */
export function assemble(units, ctx = {}) {
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

  // Emit in ORIGINAL order (cache-stable); account for every non-kept unit in `dropped` (no silent loss).
  /** @type {Unit[]} */ const kept = [];
  /** @type {{id:string, reason:"budget"}[]} */ const dropped = [];
  let tokens = 0;
  for (const u of units) {
    if (keep.has(u.id)) { kept.push(u); tokens += tokOf(u); }
    else dropped.push({ id: u.id, reason: "budget" });
  }
  return { units: kept, dropped, tokens };
}
