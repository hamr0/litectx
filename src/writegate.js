// Write-gate emitter (CE-PRD §10.1 / baresuite-litectx-prd §5B). Turns a memory
// write into a gate-able ACTION, optionally runs it past a host-wired gate before
// the write commits, and keeps a standalone audit trail. POC-validated 2026-06-14
// (`poc/write-gate-emitter-poc.mjs`, GATE: PASS — the emitted shape is load-bearing
// and floor supremacy holds when gated by bareguard).
//
// The §6 line, in code: litectx emits the SOURCE (`provenance`) plus an optional
// guardrails-set `injectionRisk` SHAPE FLAG — never a trust verdict, never a
// content scan. The gate (bareguard when embedded, any `.check`-shaped object
// standalone) renders deny/ask; litectx only states the facts. litectx is NOT
// coupled to a gate version: it touches only `.check`.
//
// Scope (write-only, by POC verdict): the producer is the write path (`remember`).
// `memory.inject` is reserved in the type union but has no producer (SELECT killed),
// so it is never minted here.

/**
 * @typedef {object} WriteAction
 * @property {"memory.write"} type
 * @property {string} kind          `fact | episode | doc` (the written kind)
 * @property {string} provenance    the SOURCE — `human | agent | doc | subagent | web`
 * @property {string} text          the content being written (verbatim)
 * @property {string} id            node id — audit / restore handle
 * @property {unknown} [meta]       opaque caller dict, passed through unredacted-shape
 * @property {"low"|"medium"|"high"} [injectionRisk]  OPTIONAL shape flag — present
 *   only if a guardrails tier set it; litectx core never computes it.
 */

/**
 * Minimal gate contract litectx depends on — a structural subset of bareguard's
 * `Gate`. Standalone, a host may supply any object with a compatible `check`.
 * @typedef {object} WriteGateLike
 * @property {(action: WriteAction) => Promise<{ outcome: string, rule?: string, reason?: string }>} check
 */

/**
 * Build the gate-able action for a memory write. Pure — no I/O, no judgment.
 *
 * @param {string} id    the write's id (audit / restore handle)
 * @param {string} text  the content being written
 * @param {object} [opts]
 * @param {string} [opts.kind="fact"]         `fact | episode | doc`
 * @param {string} [opts.provenance="agent"]  source — `human | agent | doc | subagent | web`
 * @param {unknown} [opts.meta]               opaque caller dict
 * @param {"low"|"medium"|"high"} [opts.injectionRisk]  optional guardrails shape flag
 * @returns {WriteAction}
 */
export function toWriteAction(id, text, opts = {}) {
  /** @type {WriteAction} */
  const action = {
    type: "memory.write",
    kind: opts.kind ?? "fact",
    provenance: opts.provenance ?? "agent",
    text,
    id,
  };
  if (opts.meta != null) action.meta = opts.meta;
  if (opts.injectionRisk != null) action.injectionRisk = opts.injectionRisk;
  return action;
}

/**
 * Raised when a wired gate denies a write. The write does NOT commit.
 */
export class WriteDeniedError extends Error {
  /**
   * @param {string} id      the denied write's id
   * @param {{ outcome: string, rule?: string, reason?: string }} decision
   */
  constructor(id, decision) {
    super(`write-gate denied "${id}": ${decision.rule ?? "gate"}${decision.reason ? ` — ${decision.reason}` : ""}`);
    this.name = "WriteDeniedError";
    /** @type {string} */ this.id = id;
    /** @type {{ outcome: string, rule?: string, reason?: string }} */ this.decision = decision;
  }
}

/**
 * Standalone audit sink — the paper-trail half litectx ships when NOT embedded
 * (inside baresuite, the host reuses bareguard's audit instead of double-logging).
 * Appends one JSONL line per write decision. litectx ships NO secret patterns:
 * a host-supplied `redact(action) => action` scrubs before the line is written
 * (the §6 line — secret patterns are content judgment, the host's to supply).
 */
export class WriteAudit {
  /**
   * @param {object} [opts]
   * @param {(line: object) => void} [opts.sink]  where a decision line goes;
   *   default is an in-memory array on `this.lines` (fileless — the host wires
   *   a file writer when it wants one).
   * @param {(action: WriteAction) => WriteAction} [opts.redact]  host-supplied
   *   redactor applied to the action before logging; default is identity
   *   (litectx invents no patterns).
   */
  constructor(opts = {}) {
    /** @type {object[]} */ this.lines = [];
    this._sink = opts.sink ?? ((line) => this.lines.push(line));
    this._redact = opts.redact ?? ((a) => a);
  }

  /**
   * Record one write decision.
   * @param {WriteAction} action
   * @param {{ outcome: string, rule?: string, reason?: string }} decision
   * @param {number} at  epoch-ms timestamp (caller supplies the clock)
   * @returns {void}
   */
  emit(action, decision, at) {
    this._sink({
      phase: "memory.write",
      at,
      action: this._redact(action),
      decision: decision.outcome,
      rule: decision.rule ?? null,
      reason: decision.reason ?? null,
    });
  }
}
