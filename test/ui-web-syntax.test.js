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

test("viewer scroll: the formatted md view scrolls to its highlight when #L<n> names nothing; a real anchor wins", () => {
  const run = (hash, ids) => {
    let scrolled = 0;
    const on = { scrollIntoView: () => scrolled++ };
    let ready = () => {};
    const document = {
      documentElement: { setAttribute() {} },
      addEventListener: (_, f) => (ready = f),
      querySelector: (sel) => (sel.includes(".blk.on") ? on : null),
      getElementById: (id) => (ids.includes(id) ? {} : null),
    };
    vm.runInNewContext(readFileSync(join(dir, "theme.js"), "utf8"), { document, location: { hash }, localStorage: { getItem: () => null }, decodeURIComponent });
    ready();
    return scrolled;
  };
  assert.equal(run("#L7", []), 1, "fragment matches no element (formatted view) → scroll to the highlight");
  assert.equal(run("", []), 1, "no fragment → scroll");
  assert.equal(run("#sub", ["sub"]), 0, "an in-page anchor that exists is left to the browser");
});
