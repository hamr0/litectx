// An UNRELATED symbol that happens to share the alias name `Panel`. It is NOT the barrel's
// Panel (that one is widget-impl's default export). A naive global `rg -w Panel` sweep would
// wrongly credit this file as a caller of the widget symbol; the 5b path-alias scoping (only
// files importing `Panel` FROM the `@ui` barrel count) must EXCLUDE it. Precision, not safety —
// so the bench does not gate it, but test/impact-alias.test.js asserts the exclusion.

export function Panel(): string {
  return "unrelated-panel";
}

export function usesLocalPanel(): string {
  return Panel();
}
