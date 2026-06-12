// R-C7 chunk-localization bench — does attaching a symbol's doc-comment to its chunk make a
// DOC-PHRASED query localize to the right SYMBOL? (the win the file-level floor benches can't see).
//
// Method: each function's distinctive words live ONLY in its doc — never in the symbol name or
// body. So recall can localize to that symbol ONLY IF the doc rides in the symbol's chunk. The
// engine (indexer, FTS, attachChunks) is fully real; files are crafted to isolate the mechanism.
//   JS / TS  → JSDoc is a sibling ABOVE the def → orphaned WITHOUT the chunker fix (expect before:✗)
//   PY       → docstring is INSIDE the body → control, localizes with or without the fix
//
// Toggle the fix to see before/after:  git stash → run → git stash pop → run
// Run: node poc/rc7-doc-localize-poc.mjs
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

const FILES = {
  "billing.js": `import { run } from "./run.js";

/**
 * Reconcile pending invoices against the ledger before the nightly settlement window.
 * @param {string} acct
 */
export function settle(acct) {
  return run(acct);
}

/** Rotate the signing credentials and purge the stale keyring entries. */
export function refresh() {
  return run("k");
}
`,
  "spans.ts": `interface Job { id: string }

/** Deduplicate the telemetry spans emitted during a cold bootstrap. */
export function collapse(jobs: Job[]): number {
  return jobs.length;
}

export class Pipeline {
  /** Backfill the dormant partitions from the archived snapshot. */
  hydrate(): void {}
}
`,
  "vault.py": `def merge(a, b):
    """Coalesce overlapping retention windows into a canonical interval."""
    return a

class Vault:
    def seal(self):
        """Quarantine the tampered manifest and emit an audit breadcrumb."""
        return None
`,
};

// (file, doc-only query, expected localized symbol, language)
const CASES = [
  ["billing.js", "reconcile pending invoices settlement window", "settle", "js"],
  ["billing.js", "rotate signing credentials purge keyring", "refresh", "js"],
  ["spans.ts", "deduplicate telemetry spans cold bootstrap", "collapse", "ts"],
  ["spans.ts", "backfill dormant partitions archived snapshot", "hydrate", "ts"],
  ["vault.py", "coalesce overlapping retention windows interval", "merge", "py"],
  ["vault.py", "quarantine tampered manifest audit breadcrumb", "seal", "py"],
];

const dir = mkdtempSync(join(tmpdir(), "rc7-loc-"));
for (const [name, src] of Object.entries(FILES)) writeFileSync(join(dir, name), src);

const ctx = new LiteCtx({ root: dir, include: [".js", ".ts", ".py"], dbPath: ":memory:" });
await ctx.index();

const byLang = {};
const rows = [];
for (const [file, query, expected, lang] of CASES) {
  const hits = await ctx.recall(query, { kind: "code", n: 5, log: false });
  const hit = hits.find((h) => h.path.endsWith(file));
  const got = hit?.chunk?.symbol ?? null;
  const ok = got === expected;
  (byLang[lang] ??= { ok: 0, n: 0 }).n++; if (ok) byLang[lang].ok++;
  rows.push({ lang, query: query.slice(0, 34), expected, localized: got ?? "—", "✓": ok ? "✓" : "✗" });
}

rmSync(dir, { recursive: true, force: true });

console.log("R-C7 doc→symbol localization (doc-only queries; real engine)\n");
console.table(rows);
console.log("\nlocalized to the documented symbol, by language:");
for (const [l, s] of Object.entries(byLang)) console.log(`  ${l}: ${s.ok}/${s.n}`);
console.log("\nWith the chunker fix: JS+TS should localize (doc now rides in the symbol chunk).");
console.log("Without it (git stash): JS+TS ✗ (doc orphaned in preamble), PY ✓ either way (in-body).");
