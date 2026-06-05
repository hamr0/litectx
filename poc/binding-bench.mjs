// THROWAWAY: native tree-sitter vs web-tree-sitter (WASM) — parse speed + chunk-count
// correctness on the POC repos. Decides the slice-2 binding on evidence, not assumption.
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, extname } from "node:path";
import NativeParser from "tree-sitter";
import NativePython from "tree-sitter-python";
import NativeJavascript from "tree-sitter-javascript";
import WasmParser from "web-tree-sitter";

const DEFS = {
  ".py": new Set(["function_definition", "class_definition"]),
  ".js": new Set(["function_declaration", "method_definition", "class_declaration", "arrow_function", "function_expression"]),
};

function defRanges(node, defs, out) {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (defs.has(c.type)) out.push([c.startPosition.row, c.endPosition.row]);
    defRanges(c, defs, out);
  }
  return out;
}

function collect(root, include, pathspecs) {
  const inc = new Set(include);
  return execFileSync("git", ["-C", root, "ls-files", ...(pathspecs ?? [])], { encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\n").filter(Boolean).filter((f) => inc.has(extname(f).toLowerCase()));
}

const ms = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms float

// --- native parsers ---
const nat = { ".py": new NativeParser(), ".js": new NativeParser() };
nat[".py"].setLanguage(NativePython);
nat[".js"].setLanguage(NativeJavascript);

// --- wasm parsers ---
await WasmParser.init();
const Language = WasmParser.Language;
const wasm = {};
for (const [ext, file] of [[".py", "tree-sitter-python.wasm"], [".js", "tree-sitter-javascript.wasm"]]) {
  const p = new WasmParser();
  p.setLanguage(await Language.load(join("node_modules/tree-sitter-wasms/out", file)));
  wasm[ext] = p;
}

for (const [name, roots, include, pathspecs] of [
  ["aurora", ["/home/hamr/PycharmProjects/aurora", "/home/hamr/Documents/PycharmProjects/aurora"], [".py"], undefined],
  ["gitdone", ["/home/hamr/PycharmProjects/gitdone", "/home/hamr/Documents/PycharmProjects/gitdone"], [".js"], ["app/**/*.js"]],
]) {
  const root = roots.find(existsSync);
  if (!root) { console.log(`\n[${name}] not found — skipped`); continue; }
  const files = collect(root, include, pathspecs).map((rel) => ({ rel, ext: extname(rel).toLowerCase(), src: readFileSync(join(root, rel), "utf8") }));

  const measure = (parsers) => {
    let chunks = 0;
    const t0 = ms();
    for (const f of files) {
      const tree = parsers[f.ext].parse(f.src);
      chunks += defRanges(tree.rootNode, DEFS[f.ext], []).length;
    }
    return { ms: ms() - t0, chunks };
  };

  measure(nat); measure(wasm); // warm up
  const n = measure(nat);
  const w = measure(wasm);
  console.log(`\n[${name}] ${files.length} files`);
  console.log(`  native : ${n.ms.toFixed(0).padStart(5)} ms   ${n.chunks} chunks`);
  console.log(`  wasm   : ${w.ms.toFixed(0).padStart(5)} ms   ${w.chunks} chunks   (${(w.ms / n.ms).toFixed(1)}x slower)`);
}
console.log();
