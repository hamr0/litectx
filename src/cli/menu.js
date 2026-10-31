// Bare `litectx` on a terminal: a title line, a one-line status and a numbered menu. One choice, then it
// runs the same code as its subcommand and exits.

import { createInterface } from "node:readline/promises";
import { claudeSummary, indexInfo, modeText, moreNote, openingLine, savedSource, shortPath, statusLines, uiInfo } from "./status.js";
import { detectMode } from "../ui/config.js";
import { runSetup } from "./setup.js";
import { liveMessage, startUi, stopUi } from "./launcher.js";
import { version } from "./paths.js";
import { confirmFolder } from "./indexcheck.js";
import { updateCmd } from "./update.js";
import { bcyan, cyan, dim, green, red, rule, sep, yellow } from "./style.js";

/**
 * Ask for a folder to index. No default: a blank answer is asked once more, then gives up.
 * @param {import("node:readline/promises").Interface} rl
 * @returns {Promise<string | null>} null when no folder was given
 */
export async function askFolder(rl) {
  for (let i = 0; i < 2; i++) {
    const p = (await rl.question("  folder to index: ")).trim();
    if (p) return p;
  }
  console.log(red("  no folder given"));
  return null;
}

/**
 * The `page:` banner line. A running page reports its own folder (it opens the one saved in ui.json, which is
 * not the current directory); a stopped one shows what `start` will open.
 * @param {Awaited<ReturnType<typeof uiInfo>>} u
 * @returns {string}
 */
function pageLine(u) {
  if (u.running) {
    const c = u.current;
    const parts = [`${green("running")} at ${cyan(u.url)}`];
    if (u.source) parts.push(shortPath(u.source.path));
    if (c) parts.push(modeText(c), `${c.files.toLocaleString("en-US")} files`);
    return parts.join(sep()) + moreNote(u.extra);
  }
  const path = savedSource();
  if (!path) return `${dim("not running")}${sep()}no folder saved yet`;
  const parts = [dim("not running"), `will open ${shortPath(path)}`];
  const m = detectMode(path);
  if (!m.ok) return parts.join(sep()) + sep() + m.error;
  parts.push(modeText(m.mode));
  const i = indexInfo(path); // one db read (~10-25 ms for a 46-repo, 15k-file index)
  if (i && !i.error) parts.push(`${(i.files ?? 0).toLocaleString("en-US")} files`);
  return parts.join(sep());
}

/**
 * @param {{ index: (path: string) => Promise<void> }} actions  `index` lives in the CLI (it owns the library calls)
 * @returns {Promise<number>} exit code
 */
export async function menu(actions) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const c = claudeSummary();
    const claude = c === "yes" ? green("Claude ✓") : `${c === "no" ? red("Claude not set up") : yellow("Claude partly set up")} — pick ${bcyan("5")}`;
    const u = await uiInfo();
    const ix = indexInfo(process.cwd());
    const ixLine = !ix ? dim("none here") : ix.error ? red("unreadable") : [`${(ix.files ?? 0).toLocaleString("en-US")} files`, ...(ix.repos !== undefined ? [`${ix.repos} repos`] : []), `meaning ${ix.meaning ? "on" : dim("off")}`].join(sep());
    console.log(`\n${rule()}`);
    console.log(`${bcyan("litectx")} ${dim(version())}${sep()}${claude}`);
    console.log(`${dim("here:")}  ${shortPath(process.cwd())}${sep()}${ixLine}`);
    console.log(`${dim("page:")}  ${pageLine(u)}`);
    console.log(rule());
    console.log(`  ${bcyan("1")} start   ${bcyan("2")} stop   ${bcyan("3")} restart   ${bcyan("4")} index   ${bcyan("5")} setup   ${bcyan("6")} status   ${bcyan("7")} update   ${bcyan("q")} quit`);
    let a = "";
    for (let i = 0; i < 2; i++) {
      a = (await rl.question(`${cyan(">")} `)).trim().toLowerCase();
      if (a === "q" || a === "quit") return 0;
      if (["1", "2", "3", "4", "5", "6", "7"].includes(a)) break;
      if (a !== "") console.log(red(`  unknown choice '${a}'`));
      a = "";
    }
    if (!a) return 0;
    try {
      /** @returns {Promise<boolean>} false when a page could not be stopped */
      const stop = async () => {
        const r = await stopUi();
        for (const l of r.lines) console.log(`  ${l}`);
        return r.ok;
      };
      const start = async () => {
        console.log(`  ${dim(openingLine())}`); // before the wait: a big folder makes start slow, and this says which one
        const r = await startUi({});
        if (r.started) console.log(`  started: ${cyan(r.url)}`);
        else for (const p of r.live) console.log(`  ${liveMessage(p)}`);
      };
      if (a === "1") await start();
      else if (a === "2") {
        if (!(await stop())) return 1;
      } else if (a === "3") {
        if (!(await stop())) return 1; // a page that would not stop is not started over
        await start();
      } else if (a === "4") {
        const asked = await askFolder(rl);
        if (asked === null) return 1;
        const p = await confirmFolder(asked, (q) => rl.question(q));
        if (p === null) {
          console.log(dim("  cancelled"));
          return 1;
        }
        // An open readline holds the terminal in raw mode, where Ctrl+C is a keypress for it, not a SIGINT for
        // the process: a long pass could not be stopped. Close it first; nothing else is asked after this.
        rl.close();
        await actions.index(p);
      } else if (a === "5") {
        const r = await runSetup({}, (q) => rl.question(q));
        for (const l of r.lines) console.log(l.startsWith("  ") ? l : `  ${l}`);
        if (!r.ok) return 1;
      } else if (a === "6") for (const l of await statusLines()) console.log(`  ${l}`);
      else return await updateCmd({ ask: (q) => rl.question(q), fromMenu: true });
    } catch (e) {
      console.log(red(`  litectx: ${e instanceof Error ? e.message : String(e)}`));
      return 1;
    }
    return 0;
  } finally {
    rl.close();
  }
}
