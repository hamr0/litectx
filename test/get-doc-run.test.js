// get(path,{startLine,endLine}) serving an exact run of adjacent WHOLE md chunks (multi-section range).
// Safety shape unchanged: hash gate, no widening — a partial edge or a gap is still null, and code
// chunks nest so a code union is never served.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx, StalePointerError } from "../src/index.js";
import { chunkFile } from "../src/chunker.js";

const MD = `# Top

intro text

## One

first body
line two

## Two

second body

## Three

third body
`;
const JS = `export class Box {
  open() {
    return 1;
  }
  shut() {
    return 2;
  }
}
`;

async function repo(md = MD) {
  const root = mkdtempSync(join(tmpdir(), "litectx-docrun-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "a.md"), md);
  writeFileSync(join(root, "box.js"), JS);
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  return { root, ctx, chunks: await chunkFile("docs/a.md", md) };
}
const lines = (md, a, b) => md.split("\n").slice(a, b + 1).join("\n");

test("2- and 3-chunk md unions are served byte-equal to the file's lines", async () => {
  const { ctx, chunks } = await repo();
  assert.ok(chunks.length >= 4);
  const two = ctx.get("docs/a.md", { startLine: chunks[1].startLine, endLine: chunks[2].endLine });
  assert.equal(two?.text, lines(MD, chunks[1].startLine, chunks[2].endLine));
  const three = ctx.get("docs/a.md", { startLine: chunks[1].startLine, endLine: chunks[3].endLine });
  assert.equal(three?.text, lines(MD, chunks[1].startLine, chunks[3].endLine));
  const all = ctx.get("docs/a.md", { startLine: chunks[0].startLine, endLine: chunks[3].endLine });
  assert.equal(all?.text, lines(MD, chunks[0].startLine, chunks[3].endLine));
});

test("start-partial and end-partial ranges are still null (never widened)", async () => {
  const { ctx, chunks } = await repo();
  assert.equal(ctx.get("docs/a.md", { startLine: chunks[1].startLine + 1, endLine: chunks[2].endLine }), null);
  assert.equal(ctx.get("docs/a.md", { startLine: chunks[1].startLine, endLine: chunks[2].endLine - 1 }), null);
  assert.equal(ctx.get("docs/a.md", { startLine: chunks[1].startLine, endLine: chunks[3].endLine + 5 }), null);
});

test("a gap in the chain is not a run - null", async () => {
  const { ctx, chunks } = await repo();
  ctx.store.db.prepare("DELETE FROM nodes WHERE path = 'docs/a.md' AND start_line = ?").run(chunks[2].startLine);
  assert.equal(ctx.get("docs/a.md", { startLine: chunks[1].startLine, endLine: chunks[3].endLine }), null);
});

test("a run that starts at a (trimmed) preamble is served from the stored bodies", async () => {
  const md = "preamble line\n\n\n# H\n\nbody\n";
  const { ctx, chunks } = await repo(md);
  assert.equal(chunks[0].nodeType, "preamble");
  const got = ctx.get("docs/a.md", { startLine: chunks[0].startLine, endLine: chunks[1].endLine });
  assert.equal(got?.text, chunks[0].text + "\n" + chunks[1].text, "joined stored bodies (the preamble body is stored trimmed)");
});

test("a single exact chunk is unchanged", async () => {
  const { ctx, chunks } = await repo();
  const one = ctx.get("docs/a.md", { startLine: chunks[2].startLine, endLine: chunks[2].endLine });
  assert.equal(one?.text, chunks[2].text);
});

test("a code file union is null (code chunks nest)", async () => {
  const { ctx } = await repo();
  const cs = await chunkFile("box.js", JS);
  assert.ok(cs.length >= 2);
  const lo = Math.min(...cs.map((c) => c.startLine)), hi = Math.max(...cs.map((c) => c.endLine));
  const exact = cs.find((c) => c.startLine === lo && c.endLine === hi);
  assert.ok(exact, "precondition: the class chunk exactly spans lo..hi");
  const whole = ctx.get("box.js", { startLine: lo, endLine: hi }); // an exact chunk range is served as that one chunk
  assert.ok(whole, "an exact chunk range is served, not null");
  assert.equal(whole.text, exact.text, "…and it is that chunk's text");
  assert.equal(whole.id, "box.js");
  assert.equal(whole.text, lines(JS, lo, hi), "…spanning exactly lines lo..hi of the file");
  const m = cs.filter((c) => c.symbol === "open" || c.symbol === "shut");
  assert.equal(ctx.get("box.js", { startLine: m[0].startLine, endLine: m[1].endLine }), null);
});

test("a drifted file throws StalePointerError; a deleted file returns null", async () => {
  const { ctx, root, chunks } = await repo();
  const r = { startLine: chunks[1].startLine, endLine: chunks[2].endLine };
  writeFileSync(join(root, "docs", "a.md"), "# New\n\n" + MD);
  assert.throws(() => ctx.get("docs/a.md", r), StalePointerError);
  rmSync(join(root, "docs", "a.md"));
  assert.equal(ctx.get("docs/a.md", r), null);
});

test("one fetch row per get, and written-memory docs (stored whole) are unaffected", async () => {
  const { ctx, chunks } = await repo();
  const before = ctx.store.db.prepare("SELECT COUNT(*) n FROM recall_log WHERE action='fetch'").get().n;
  ctx.get("docs/a.md", { startLine: chunks[1].startLine, endLine: chunks[3].endLine });
  const after = ctx.store.db.prepare("SELECT COUNT(*) n FROM recall_log WHERE action='fetch'").get().n;
  assert.equal(after - before, 1);
  await ctx.remember("note:1", "# H\n\nbody\n\n## H2\n\nmore", { kind: "doc" });
  assert.equal(ctx.get("note:1", { startLine: 0, endLine: 6 }), null, "written memory has no chunks");
});
