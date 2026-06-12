// R-C7 compress() — the rank-tiered render primitive. Real tree-sitter extraction over real chunk
// bodies (and end-to-end from chunkFile). Behavior, not implementation: a signature keeps the
// declaration + doc and elides the body; drop is a name marker; verbatim is identity; unparseable
// content falls back losslessly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { compress, COMPRESS_LEVELS } from "../src/index.js";
import { chunkFile } from "../src/chunker.js";

test("verbatim returns the body unchanged", async () => {
  const node = { format: "js", text: "function f() {\n  return 1;\n}" };
  assert.equal(await compress(node, { level: "verbatim" }), node.text);
});

test("signature keeps export/async/generics/return type and elides the body (TS)", async () => {
  const text = `/** Map a boxed value through fn. */
export async function transform<T, U>(
  box: Box<T>,
  fn: (x: T) => Promise<U>,
): Promise<Box<U>> {
  return { v: await fn(box.v) };
}`;
  const sig = await compress({ format: "ts", text, symbol: "transform" }, { level: "signature" });
  assert.match(sig, /export async function transform<T, U>/);
  assert.match(sig, /Promise<Box<U>>/);
  assert.match(sig, /Map a boxed value/); // the JSDoc rides above the header
  assert.ok(!sig.includes("await fn(box.v)"), "the implementation body must be elided");
  assert.ok(sig.length < text.length, "signature must be shorter than the body");
});

test("signature re-attaches a Python docstring (in-body) and keeps the decorator", async () => {
  const text = `@cached
def merge(a, b):
    """Coalesce overlapping retention windows into a canonical interval."""
    work = a + b
    return work`;
  const sig = await compress({ format: "py", text, symbol: "merge" }, { level: "signature" });
  assert.match(sig, /@cached/);
  assert.match(sig, /def merge\(a, b\):/);
  assert.match(sig, /Coalesce overlapping retention windows/); // docstring kept
  assert.ok(!sig.includes("work = a + b"), "the implementation body must be elided");
});

test("signature keeps a leading line-comment as the doc (JS)", async () => {
  const text = `// rotate the signing credentials
export function refresh() {
  return run("k");
}`;
  const sig = await compress({ format: "js", text, symbol: "refresh" }, { level: "signature" });
  assert.match(sig, /rotate the signing credentials/);
  assert.match(sig, /export function refresh\(\)/);
  assert.ok(!sig.includes('return run("k")'));
});

test("a type alias (no body field) is already its own signature", async () => {
  const text = `export type Handler = (req: Request) => Response;`;
  assert.equal(await compress({ format: "ts", text }, { level: "signature" }), text);
});

test("a class signature drops its method bodies", async () => {
  const text = `export class Pipeline {
  hydrate(): void { this.x = 1; }
  drain(): void { this.x = 0; }
}`;
  const sig = await compress({ format: "ts", text, symbol: "Pipeline" }, { level: "signature" });
  assert.match(sig, /export class Pipeline/);
  assert.ok(!sig.includes("this.x = 1"), "method bodies are not part of the class signature");
});

test("signature compresses a standalone METHOD chunk (not valid top-level on its own)", async () => {
  // regression: a method chunk's text (`  embed() {…}`) can't parse standalone — method_definition
  // is only valid inside a class — so signatureOf must retry in a synthetic class wrapper. The sig
  // POC silently skipped these (≈38% of real symbols), inflating its clean-rate.
  const src = `export class Embedder {
  /** Embed one text into a vector. */
  async embed(text) {
    const pipe = await this._pipeline();
    return pipe(text);
  }
}`;
  const chunks = await chunkFile("e.js", src);
  const method = chunks.find((c) => c.symbol === "embed");
  assert.ok(method && method.nodeType === "method_definition", "embed is a method chunk");
  const sig = await compress({ ...method, format: "js" }, { level: "signature" });
  assert.match(sig, /async embed\(text\)/);
  assert.match(sig, /Embed one text into a vector/);
  assert.ok(!sig.includes("this._pipeline()"), "method body elided");
  assert.ok(sig.length < method.text.length);
});

test("signature compresses a standalone Python method chunk with its docstring", async () => {
  const src = `class Vault:
    def seal(self, manifest):
        """Quarantine the tampered manifest and emit an audit breadcrumb."""
        self.audit(manifest)
        return None`;
  const chunks = await chunkFile("v.py", src);
  const method = chunks.find((c) => c.symbol === "seal");
  assert.ok(method, "seal method chunk exists");
  const sig = await compress({ ...method, format: "py" }, { level: "signature" });
  assert.match(sig, /def seal\(self, manifest\):/);
  assert.match(sig, /Quarantine the tampered manifest/);
  assert.ok(!sig.includes("self.audit(manifest)"), "method body elided");
});

test("drop returns a name marker, using the chunk symbol when present", async () => {
  assert.equal(await compress({ format: "js", text: "function settle(){}", symbol: "settle" }, { level: "drop" }), "settle …");
});

test("drop recovers the name from the body when no symbol is supplied", async () => {
  assert.equal(await compress({ format: "py", text: "def seal(self):\n    return None" }, { level: "drop" }), "seal …");
});

test("drop of an anonymous/unparseable node is a bare marker", async () => {
  assert.equal(await compress({ format: "md", text: "# Heading\nprose" }, { level: "drop" }), "…");
});

test("signature falls back to verbatim for unparseable content (markdown)", async () => {
  const text = "# Title\nsome prose with no code";
  assert.equal(await compress({ format: "md", text }, { level: "signature" }), text);
});

test("signature falls back to verbatim when no format is given", async () => {
  const text = "function f(){ return 1 }";
  assert.equal(await compress({ text }, { level: "signature" }), text);
});

test("default level is signature", async () => {
  const text = `function add(a, b) {\n  return a + b;\n}`;
  const sig = await compress({ format: "js", text });
  assert.match(sig, /function add\(a, b\)/);
  assert.ok(!sig.includes("return a + b"));
});

test("an unknown level throws", async () => {
  await assert.rejects(() => compress({ format: "js", text: "x" }, { level: "tiny" }), /unknown level/);
  assert.deepEqual([...COMPRESS_LEVELS], ["verbatim", "signature", "drop"]);
});

test("end-to-end: chunkFile → compress each tier on a real symbol", async () => {
  const src = `/**
 * Reconcile pending invoices before the nightly settlement.
 * @param {string} acct
 */
export function settle(acct) {
  const ledger = load(acct);
  return reconcile(ledger);
}
`;
  const chunks = await chunkFile("billing.js", src);
  const node = chunks.find((c) => c.symbol === "settle");
  assert.ok(node, "settle chunk exists");
  node.format = "js"; // a chunk carries no format; the caller knows it from the file

  assert.equal(await compress(node, { level: "verbatim" }), node.text);

  const sig = await compress(node, { level: "signature" });
  assert.match(sig, /Reconcile pending invoices/); // attached JSDoc (chunker fix) is now renderable
  assert.match(sig, /export function settle\(acct\)/);
  assert.ok(!sig.includes("reconcile(ledger)"), "body elided");
  assert.ok(sig.length < node.text.length);

  assert.equal(await compress(node, { level: "drop" }), "settle …");
});
