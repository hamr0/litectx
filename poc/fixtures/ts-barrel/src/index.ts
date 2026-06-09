// Barrel — the package's public surface, reached as `@ui` via the tsconfig path alias. It
// renames widget-impl's DEFAULT export to `Panel`; that rename hides the original definition
// name from every consumer and is the crux of the 5b under-count gate. `computeArea` is
// re-exported renamed to `area`; `double` is re-exported under its own name.

export { default as Panel } from "./widget-impl";
export { computeArea as area } from "./shapes";
export { double } from "./math";
