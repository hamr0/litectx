// double is imported and called UNDER ITS OWN NAME (no rename anywhere), so the existing
// name-based sweep already confirms its caller. Proves the TS confirm path works end-to-end
// (TS is new to the impact gate — neither aurora nor mcprune is TS). A sanity label.

export function double(n: number): number {
  return n + n;
}
