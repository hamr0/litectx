// ANSI accents for the `litectx` command, same palette as the sibling bareloop launcher. Plain text unless
// stdout is a terminal (NO_COLOR wins; FORCE_COLOR forces on) — so piped output and tests see no escapes.
// green = good/running · yellow = needs you · red = not set up/error · cyan = things you type or click ·
// dim = labels/zero/quiet.

/** @returns {boolean} */
export function colorOn() {
  const e = process.env;
  if (e.NO_COLOR) return false;
  if (e.FORCE_COLOR !== undefined && e.FORCE_COLOR !== "" && e.FORCE_COLOR !== "0") return true;
  return !!process.stdout.isTTY;
}

const c = (/** @type {string} */ n) => (/** @type {string} */ s) => (colorOn() ? `\x1b[${n}m${s}\x1b[0m` : s);
export const bold = c("1");
export const dim = c("2");
export const green = c("32");
export const yellow = c("33");
export const red = c("31");
export const cyan = c("36");
export const bcyan = c("1;36");
/** @returns {string} dim ' · ' */
export const sep = () => dim(" · ");
/** @returns {string} thin dim rule */
export const rule = () => dim("─".repeat(56));

/** Colour a yes/no word: yes green, no red. @param {string} s */
export const yn = (s) => (s === "yes" ? green(s) : red(s));
