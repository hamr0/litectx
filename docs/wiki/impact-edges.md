---
type: reference
title: Impact & Edge Resolution
status: stable
sources: [docs/archive/litectx-prd.md]
---

## No language-server tier (DECIDED)

litectx resolves code edges without an LSP. The one and only edge resolver is
**tree-sitter queries + `ripgrep -w`** (word-boundary matching) — zero external
binaries, ~2ms/symbol, deterministic. Aurora (the port source) measured LSP at
~300ms/symbol and itself fell back to `rg -w`; in Node there is no equivalent of
`multilspy`, and hand-driving language servers over `vscode-jsonrpc` was judged
fragile and rejected (litectx-prd.md:1005-1008).

Accuracy comes from the **per-language definition** (`function_def_types`,
`call_node_type`, `skip_names`, entry/callback lists) — not from a server. This
calibration work is the bulk of "adding a language" (~1-2 days/language)
(litectx-prd.md:1008-1011).

An independent 2026 survey of competing "code-graph MCP" tools corroborates the
decision: two of the three closest claimants avoid running real language servers
at all, and the one that does gate true-LSP behind optional tiers requiring
pre-installed servers — the same fragility litectx rejected. More tellingly, one
competitor's own published evaluation found its graph-backed agent scored *lower*
answer quality (0.83) than a plain grep+read agent (0.92), winning only on token
and tool-call efficiency — evidence that precision-grade binding resolution buys
no agent-level quality over approximate structure plus reading code
(litectx-prd.md:1013-1028).

## `impact(symbol)` — how it's computed

`impact()` is built on demand, not persisted: callees come from a tree-sitter
walk of the symbol's body; callers come from an `rg -w` sweep confirmed against
tree-sitter; risk is `max(confirmed, mentions)` bucketed at thresholds `≤2` low,
`3-10` medium, `11+` high, plus a complexity signal and the anti-false-isolation
hedges described below. (A `type='call'` edge row is reserved in schema for a
future persist-if-slow optimization, but is not active in v1.) Validated on
aurora, hub symbols correctly bucket `high` (e.g. `SQLiteStore` at 235
references/109 callers), at roughly 0.1-0.9s/symbol (litectx-prd.md:977-984).

Barrel/re-export and path-alias false-isolation is mitigated on demand: a symbol
reached only through a renamed re-export (invisible to a name-only `rg -w`
sweep) is resolved by chaining definition → barrel alias → consumers that
actually import that alias from the barrel, scoped by `tsconfig` path-alias
resolution so an unrelated same-named symbol is never miscredited. This still
uses no LSP, and lives in a separate module (`tsalias.js`) so recall's import
resolution stays frozen (litectx-prd.md:986-994).

As of v0.32.0, a **missing `rg` binary is detected, not silently swallowed**:
previously a spawn failure (rg absent, not executable, broken `PATH`) collapsed
into the same empty result as a genuine "no matches," producing `refCount 0 /
risk low` for a symbol that actually had callers — the worst possible
under-count wearing a normal hedged shape. `impact()` now throws
`RipgrepMissingError` (`.code = "RIPGREP_MISSING"`), with both sweep sites
routed through one guard that distinguishes "rg never ran" from "rg ran and
exited 1 / crashed / was overflow-killed" (which remain valid-empty results)
(litectx-prd.md:996-1003).

## The carve-out — what litectx answers vs. what only an LSP can (DECIDED)

litectx answers the *questions you'd ask* an LSP, not the LSP itself. It is
near-perfect at **detecting** syntax via tree-sitter, and deliberately
**imprecise at resolving bindings** — over-counting by design
(litectx-prd.md:1030-1033):

| Capability | In/Out | Detect | Resolve | Failure bias |
|---|---|---|---|---|
| calling (callees) | in | ~99% | ~95% by-name | over (nothing to resolve) |
| called-by (callers) | in | ~90% | ~80% | **over-count** (superset) |
| imports / connected files | in | ~98% | ~75-90% | under/mis-attrib |
| refs → risk bucket | in | — | inherits | over → higher risk |
| complexity | in | ~99% | n/a | none |
| dead-code | candidate only, never a verdict | — | inherits | false-neg (safe) |
| `get_definition` / `hover` | out | editor nav, not litectx | | |
| lint / diagnostics | out | linters exist | | |
| precise import-vs-usage binding | **non-goal** | over-count by design | | |

Detection is near-perfect everywhere; the gap is in resolution, and that gap is
deliberately biased toward over-counting (litectx-prd.md:1035-1050).

## The safety contract: over-count is safe, under-count is dangerous (DECIDED, GOVERNING)

This asymmetry governs the entire impact view:

- **Over-count** (looks more connected / higher risk) → an AI consuming the
  result becomes over-cautious → wasteful, never harmful. 75%-accurate counts
  are acceptable.
- **Under-count** (looks more isolated / lower risk) → an AI concludes "siloed,
  safe to change" → **breaks hidden consumers. This is the damaging error.**

**Invariant: litectx may overstate connectivity freely, but must never
understate it silently.** "It's connected / risky" is an ordinary claim;
**"it's isolated / unused / low-risk" is a load-bearing safety claim**, and it
only ships hedged, after the mitigations below (litectx-prd.md:1052-1064).

### Under-count mitigations

Ranked by danger × incidence × testability (litectx-prd.md:1066-1076):

| Under-count mode | Mitigation | v1 status |
|---|---|---|
| Framework callbacks / entry points | aurora's `entry_*`/`callback` lists carried as roots | built |
| Public exports look unused | every export is a usage root | built |
| Reflection / string-keyed calls (`getattr`, `require(var)`) | flag dynamic-feature files + string-literal mention check before any dead/isolated claim | built |
| Barrel / `export…from` re-exports | resolve renamed re-exports on demand (single-hop) | built |
| Path aliases (`tsconfig paths`) | parse `paths`/`baseUrl` to scope alias attribution | built |

**The universal safety net:** the only dangerous act is *silently dropping a
reference*. Any reference that can't be resolved — an unfollowable alias, a
dynamic call, an unresolvable import — is recorded as **`unresolved`, never
`absent`**. This keeps every "isolated / low-risk" verdict honest even for
modes not fully solved: such a symbol reads as "couldn't fully resolve," not
"siloed." Reflection that's genuinely unresolvable gets an explicit caveat —
"dynamic usage not statically visible — review candidate" — never a clean
isolation verdict (litectx-prd.md:1078-1083).

A planned (not yet built) refinement borrows the idea of a **graded resolution
confidence** per reference (not the confidence-cascade mechanism itself, which
exists to reduce over-count — litectx's explicit non-goal). The plan is to
surface the confidence grain v1 already computes implicitly
(tree-sitter-confirmed > rg-mention > unresolved) as an explicit output field,
so `impact()` can report "N confirmed + M low-confidence callers" and demand
high-confidence absence before making even a hedged isolation claim. This
requires no migration and no ranking change, and is not a blocker on any other
work (litectx-prd.md:1085-1096).

## Edge types & the two non-conflatable signals

Two edge types are both required: `calls` (symbol→symbol) powers
called-by/calling and symbol blast radius; `imports` (file→file, from
tree-sitter import nodes) powers file connectivity. Recall's spreading activation
rides `imports` only (calls were found repo-dependent for recall); `calls`
feeds impact exclusively, never recall (litectx-prd.md:1100-1103).

`complexity` (a cyclomatic-ish AST branch count local to one chunk) and
`risk`/`impact` (a reference count from the call graph, i.e. blast radius) are
deliberately separate fields — one is a local property, the other is a global
one (litectx-prd.md:1104-1106).
