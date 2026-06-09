// This module's DEFAULT export is renamed to `Panel` by the barrel (src/index.ts). Every
// consumer imports it as `Panel` through the `@ui` path alias, so its definition name appears
// NOWHERE outside the one line that declares it. A name-only (`rg -w`) caller sweep therefore
// finds zero external references → a FALSE isolation. Ground truth: it is called from app.ts
// and dashboard.ts. This is the under-count the 5b barrel/alias mitigation must close.
//
// NB: the definition name is deliberately kept out of every comment (here and in the consumer
// files) — a stray mention would seed the rg floor and paper over the very gap under test.

export default function renderWidget(size: number): string {
  const w = clampSize(size);
  if (w > 100) {
    return `<widget big=${w}>`;
  }
  return `<widget=${w}>`;
}

function clampSize(n: number): number {
  return n < 0 ? 0 : n;
}
