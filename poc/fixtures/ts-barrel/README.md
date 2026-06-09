# ts-barrel — impact under-count fixture (slice 5b gate)

A tiny, **committed** TypeScript app with a deliberate **barrel** (`src/index.ts`) and a
**tsconfig path alias** (`@ui`). It exists to give the §7.2 anti-false-isolation work *teeth
before it is built*: the impact view resolves callers **by name** (`rg -w` → tree-sitter
confirm), so a symbol that is reachable only under a **renamed default export** has its
original name appear nowhere outside its definition — a name-only sweep finds zero references
and reports a **false isolation** (the one dangerous under-count, §7.2).

Ground truth lives in `poc/datasets/impact-ts.mjs`; the gate is `poc/impact-bench.mjs`.

## The planted symbols

| symbol (def)                       | reached as        | name-only sweep today        | label kind |
|------------------------------------|-------------------|------------------------------|------------|
| `renderWidget` (`widget-impl.ts`)  | `Panel` via barrel + `@ui` | **0 refs → FALSE isolation** | isolation gate (red→green at 5b) |
| `computeArea` (`shapes.ts`)        | `area` via barrel rename   | 1 mention (barrel line)      | caller-recall (incomplete list) |
| `double` (`math.ts`)               | `double` (no rename)       | confirmed call               | sanity (TS confirm works) |
| `Panel` (`decoy.ts`)               | local `Panel` (NOT the barrel) | —                        | precision decoy (must be excluded) |

`renderWidget` is the load-bearing case: default-exported, renamed to `Panel` by the barrel,
imported through the `@ui` alias by `app.ts` and `dashboard.ts`. `decoy.ts` defines an
*unrelated* `Panel` and calls it locally — a naive global `rg -w Panel` would miscredit it to
`renderWidget`; the 5b path-alias scoping (only files importing `Panel` *from the barrel*
count) must exclude it.

Not shipped (under `poc/`, outside the npm `files` whitelist) and not part of the lib's own
`tsc` (which only covers `src/**/*.js`).
