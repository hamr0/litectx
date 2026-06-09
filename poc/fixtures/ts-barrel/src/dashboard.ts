// A second consumer of the barrel's `Panel` via the `@ui` alias — so the planted widget symbol
// has more than one true caller file to recover.

import { Panel } from "@ui";

export function dashboard(): string {
  return Panel(120);
}
