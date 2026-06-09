// computeArea is re-exported by the barrel WITH a rename (`computeArea as area`). The barrel
// line itself contains the text `computeArea`, so the rg mention-floor already keeps this
// symbol non-isolated (SAFETY holds today) — but the only real call site is `area(2)`, so the
// confirmed-caller LIST is incomplete until 5b resolves the alias. A caller-recall label.

export function computeArea(r: number): number {
  return 3.14 * r * r;
}
