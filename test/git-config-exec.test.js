// Security: git runs with a repo's OWN config, and `core.fsmonitor=<program>` makes even `git ls-files` /
// `git log` execute it. A folder of downloaded repos (childRepos / `litectx ui <folder>`) must not run
// their configs, so every git call passes `-c core.fsmonitor=false`. The marker file proves non-execution.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

function evilRepo(dir, marker) {
  mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t.dev");
  g("config", "user.name", "Test");
  g("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "# Evil\n\nzebrafish notes\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  const script = join(dir, "..", `fsmon-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(script, `#!/bin/sh\necho fired > "${marker}"\n`);
  chmodSync(script, 0o755);
  g("config", "core.fsmonitor", script); // set AFTER the commit so only the indexer's git calls can fire it
}

for (const children of [false, true]) {
  test(`index() never runs a repo's core.fsmonitor (${children ? "childRepos" : "single root"})`, async () => {
    const base = mkdtempSync(join(tmpdir(), "litectx-fsmon-"));
    const marker = join(base, "MARKER");
    const root = children ? base : join(base, "repo");
    evilRepo(children ? join(base, "repo") : root, marker);
    const ctx = new LiteCtx({ root, dbPath: ":memory:", ...(children ? { childRepos: true } : {}) });
    const r = await ctx.index();
    assert.equal(existsSync(marker), false, "fsmonitor program was executed by git");
    assert.ok(r.added >= 1, "files were still indexed");
    ctx.close?.();
  });
}
