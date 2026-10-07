// POC (arm A2): print the immediately previous and next index sections of the same file around a fetched section.
// usage: node tinymem-neighbour-append.mjs <dbRoot> <path> <A-B 1-based as CLI prints>
import { createRequire } from 'node:module';
import { join } from 'node:path';
const Database = createRequire(new URL('../package.json', import.meta.url))('better-sqlite3');
const [root, path, range] = process.argv.slice(2);
const m = /^(\d+)-(\d+)$/.exec(range ?? ''); if (!m) process.exit(0);
const s0 = +m[1] - 1, e0 = +m[2] - 1;
const db = new Database(join(root, '.litectx/index.db'), { readonly: true });
const rows = db.prepare("SELECT start_line s,end_line e,symbol,body FROM nodes WHERE path=? AND kind='doc' ORDER BY start_line").all(path);
const i = rows.findIndex(r => r.s === s0 && r.e === e0); if (i < 0) process.exit(0);
const show = (r, label) => console.log(`\n--- ${label} (--lines ${r.s + 1}-${r.e + 1}, section "${r.symbol}") ---\n${r.body}`);
if (rows[i - 1]) show(rows[i - 1], 'PREVIOUS SECTION'); else console.log('\n--- PREVIOUS SECTION: none (start of file) ---');
if (rows[i + 1]) show(rows[i + 1], 'NEXT SECTION'); else console.log('\n--- NEXT SECTION: none (end of file) ---');
