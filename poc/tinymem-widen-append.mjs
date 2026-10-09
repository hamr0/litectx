// POC (arm E / D'): after `get <path> --lines A-B` print the PREVIOUS section (as lx2) then FOLLOWING TEXT up to a forward line budget
// (+120 lines for sessions/, +60 for docs/; stops at file end). usage: node tinymem-widen-append.mjs <dbRoot> <path> <A-B 1-based as CLI prints>
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const Database = createRequire(new URL('../package.json', import.meta.url))('better-sqlite3');
const [root, path, range] = process.argv.slice(2);
const m = /^(\d+)-(\d+)$/.exec(range ?? ''); if (!m) process.exit(0);
const s0 = +m[1] - 1, e0 = +m[2] - 1;
const db = new Database(join(root, '.litectx/index.db'), { readonly: true });
const rows = db.prepare("SELECT start_line s,end_line e,symbol,body FROM nodes WHERE path=? AND kind='doc' ORDER BY start_line").all(path);
const i = rows.findIndex(r => r.s === s0 && r.e === e0); if (i < 0) process.exit(0);
const r = rows[i - 1];
if (r) console.log(`\n--- PREVIOUS SECTION (--lines ${r.s + 1}-${r.e + 1}, section "${r.symbol}") ---\n${r.body}`); else console.log('\n--- PREVIOUS SECTION: none (start of file) ---');
const budget = path.startsWith('sessions/') ? 120 : path.startsWith('docs/') ? 60 : 0;
const lines = readFileSync(join(root, path), 'utf8').split('\n'); if (lines.at(-1) === '') lines.pop();
const from = e0 + 1, to = Math.min(lines.length - 1, e0 + budget);
if (from > to) console.log('\n--- FOLLOWING TEXT: none (end of file) ---');
else console.log(`\n--- FOLLOWING TEXT (--lines ${from + 1}-${to + 1}${to === lines.length - 1 ? ', end of file' : ''}) ---\n${lines.slice(from, to + 1).join('\n')}`);
