// The browser scripts in src/ui/web are served as-is and never imported by Node, so a syntax slip
// ships silently and blanks the page (5a6631b). Parse every one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const dir = fileURLToPath(new URL("../src/ui/web/", import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".js"));

test("src/ui/web has scripts to check", () => assert.ok(files.length >= 3));

for (const f of files) {
  test(`ui web script parses: ${f}`, () => {
    assert.doesNotThrow(() => new vm.Script(readFileSync(join(dir, f), "utf8"), { filename: f }));
  });
}
