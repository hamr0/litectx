// Bare `litectx` on a terminal: a title line, a one-line status and a numbered menu. One choice, then it
// runs the same code as its subcommand and exits.

import { createInterface } from "node:readline/promises";
import { claudeSummary, indexInfo, statusLines, uiInfo } from "./status.js";
import { runSetup } from "./setup.js";
import { startUi, stopUi } from "./launcher.js";
import { version } from "./paths.js";
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
 * @param {{ index: (path: string) => Promise<void> }} actions  `index` lives in the CLI (it owns the library calls)
 * @returns {Promise<number>} exit code
 */
export async function menu(actions) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const c = claudeSummary();
    const claude = c === "yes" ? green("Claude ✓") : `${c === "no" ? red("Claude not set up") : yellow("Claude partly set up")} — pick ${bcyan("4")}`;
    const u = await uiInfo();
    const page = u.running ? `page ${green("running")} at ${cyan(u.url)}` : `page ${dim("not running")}`;
    const ix = indexInfo(process.cwd());
    const ixLine = !ix ? dim("none here") : ix.error ? red("unreadable") : [`${(ix.files ?? 0).toLocaleString("en-US")} files`, ...(ix.repos !== undefined ? [`${ix.repos} repos`] : []), `meaning ${ix.meaning ? "on" : dim("off")}`].join(sep());
    console.log(`\n${rule()}`);
    console.log(`${bcyan("litectx")} ${dim(version())}${sep()}${claude}${sep()}${page}`);
    console.log(`${dim("index:")} ${ixLine}`);
    console.log(rule());
    console.log(`  ${bcyan("1")} start   ${bcyan("2")} stop   ${bcyan("3")} index   ${bcyan("4")} setup   ${bcyan("5")} status   ${dim("q quit")}`);
    let a = "";
    for (let i = 0; i < 2; i++) {
      a = (await rl.question(`${cyan(">")} `)).trim().toLowerCase();
      if (a === "q" || a === "quit") return 0;
      if (["1", "2", "3", "4", "5"].includes(a)) break;
      if (a !== "") console.log(red(`  unknown choice '${a}'`));
      a = "";
    }
    if (!a) return 0;
    try {
      if (a === "1") {
        const r = await startUi({});
        console.log(r.started ? `  started: ${cyan(r.url)}` : `  already running: ${cyan(r.url)}`);
      } else if (a === "2") console.log(`  ${(await stopUi()).message}`);
      else if (a === "3") {
        const p = await askFolder(rl);
        if (p === null) return 1;
        await actions.index(p);
      } else if (a === "4") {
        const r = await runSetup({}, (q) => rl.question(q));
        for (const l of r.lines) console.log(l.startsWith("  ") ? l : `  ${l}`);
        if (!r.ok) return 1;
      } else for (const l of await statusLines()) console.log(`  ${l}`);
    } catch (e) {
      console.log(red(`  litectx: ${e instanceof Error ? e.message : String(e)}`));
      return 1;
    }
    return 0;
  } finally {
    rl.close();
  }
}
