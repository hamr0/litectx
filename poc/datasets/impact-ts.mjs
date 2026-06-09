// Impact ground-truth dataset — the committed `poc/fixtures/ts-barrel` TypeScript app. Unlike
// aurora/mcprune (external, name-reachable corpora), this fixture is PURPOSE-BUILT to exercise
// the §7.2 under-count modes that name-only caller resolution (`rg -w` → tree-sitter confirm)
// cannot see: a barrel re-export that RENAMES a symbol, reached through a tsconfig path alias.
//
// Labels are hand-audited against the source (see the table in the fixture README). New fields
// beyond the aurora/mcprune datasets:
//   `isolated`  — ground-truth: is the symbol genuinely unreferenced? (all here are USED → false)
//   `reachVia`  — how the call site names it: "direct" | "barrel-named-alias" | "barrel-default-alias"
// The gate asserts impact()'s isolation verdict (refCount === 0) against `isolated`. The
// `barrel-default-alias` label is the load-bearing one: it FAILS today (name-only sweep finds
// zero refs → false isolation) and only passes once the 5b barrel/alias mitigation lands.

export default {
  name: "impact-ts",
  roots: ["poc/fixtures/ts-barrel", "/home/hamr/PycharmProjects/litectx/poc/fixtures/ts-barrel"],
  include: [".ts"],
  pathspecs: ["*.ts"],
  labels: [
    // SANITY: imported and called under its own name (no rename) — the existing name-based
    // confirm already recovers the caller. Proves the TS path works (TS is new to this gate).
    { symbol: "double", defFile: "src/math.ts", used: true, isolated: false, reachVia: "direct",
      callerFiles: ["src/app.ts"] },

    // CALLER-RECALL: re-exported renamed (`computeArea as area`); the barrel line carries the
    // text `computeArea`, so the rg floor keeps it non-isolated TODAY (refCount > 0), but the
    // only real call is `area(2)` → confirmed-caller list is empty until 5b resolves the alias.
    { symbol: "computeArea", defFile: "src/shapes.ts", used: true, isolated: false, reachVia: "barrel-named-alias",
      callerFiles: ["src/app.ts"] },

    // THE GATE: default-exported, renamed to `Panel` by the barrel, imported via the `@ui` path
    // alias. Its definition name appears nowhere outside its own def line → name-only sweep =
    // 0 refs → FALSE isolation TODAY. Called from app.ts and dashboard.ts (NOT decoy.ts, whose
    // `Panel` is an unrelated local symbol). 5b must lift refCount > 0 and name both callers.
    { symbol: "renderWidget", defFile: "src/widget-impl.ts", used: true, isolated: false, reachVia: "barrel-default-alias",
      callerFiles: ["src/app.ts", "src/dashboard.ts"] },
  ],
};
