// Consumer reaching the barrel through the `@ui` path alias. `Panel` and `area` are called
// under their barrel-exported names; the original definition names never appear here. `double`
// is imported directly from `@ui/math` under its own name.

import { Panel, area } from "@ui";
import { double } from "@ui/math";

export function renderApp(): string {
  const a = area(2);
  const d = double(a);
  return Panel(d) + ":" + d;
}
