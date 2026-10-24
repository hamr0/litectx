// Bare `litectx` on a terminal: a logo line, a one-line status and a numbered menu. Each item runs the
// same code as its subcommand.

import { createInterface } from "node:readline/promises";
import { claudeSummary, statusLines, uiLine } from "./status.js";
import { setup } from "./setup.js";
import { startUi, stopUi } from "./launcher.js";
import { version } from "./paths.js";

/**
 * @param {{ index: (path: string) => Promise<void> }} actions  `index` lives in the CLI (it owns the library calls)
 */
export async function menu(actions) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\n  ⚡ litectx ${version()} — lightning local search`);
    for (;;) {
      console.log(`  set up for Claude: ${claudeSummary()} · UI: ${await uiLine()}\n`);
      console.log("  1) start search page\n  2) stop search page\n  3) index a folder\n  4) set up Claude\n  5) status (details)\n  q) quit\n");
      const a = (await rl.question("  > ")).trim().toLowerCase();
      try {
        if (a === "q" || a === "quit") return;
        else if (a === "") continue;
        else if (a === "1") {
          const r = await startUi({});
          console.log(r.started ? `  started: ${r.url}` : `  already running: ${r.url}`);
        } else if (a === "2") console.log(`  ${(await stopUi()).message}`);
        else if (a === "3") {
          const p = (await rl.question(`  folder to index [${process.cwd()}]: `)).trim();
          await actions.index(p || process.cwd());
        } else if (a === "4") {
          const r = setup();
          for (const l of r.lines) console.log(`  ${l}`);
        } else if (a === "5") for (const l of await statusLines()) console.log(`  ${l}`);
        else console.log(`  unknown choice '${a}'`);
      } catch (e) {
        console.log(`  litectx: ${e instanceof Error ? e.message : String(e)}`);
      }
      console.log("");
    }
  } finally {
    rl.close();
  }
}
