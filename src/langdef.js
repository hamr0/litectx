// Per-language registry — the ONE place language specifics live (§2.1 seam rule 2).
// The chunker reads `grammar` + `defTypes`; slice-5 edge extraction will hang call/import
// node config off these same entries, never forking a second registry. Routing is by file
// extension only — never sniff content (§6).
//
// Grammars are vendored as WASM under ./grammars (Unlicense, Apache-compatible) and loaded by
// web-tree-sitter, pinned to 0.22.6 to match the grammars' ABI. v1 languages: TS, JS, Python.

/**
 * @typedef {Object} LangDef
 * @property {string} format         format tag (matches indexer FORMAT)
 * @property {string} grammar        vendored wasm filename under ./grammars
 * @property {string[]} defTypes     tree-sitter node types that become symbol chunks
 * @property {string[]} importTypes  tree-sitter node types that carry an import specifier (slice 4)
 * @property {boolean} [requireCalls] also treat `require("…")` call-expressions as imports (CJS)
 * @property {string[]} callTypes    tree-sitter node types that are a call site (impact, slice 5)
 * @property {string[]} branchTypes  node types counted as decision points for cyclomatic-ish complexity (slice 5)
 */

/** @type {Record<string, LangDef>} */
export const LANGDEFS = {
  py: {
    format: "py",
    grammar: "tree-sitter-python.wasm",
    defTypes: ["function_definition", "class_definition"],
    importTypes: ["import_statement", "import_from_statement"],
    callTypes: ["call"],
    branchTypes: ["if_statement", "elif_clause", "for_statement", "while_statement", "except_clause", "conditional_expression", "boolean_operator", "case_clause", "assert_statement"],
  },
  js: {
    format: "js",
    grammar: "tree-sitter-javascript.wasm",
    defTypes: ["function_declaration", "method_definition", "class_declaration", "arrow_function", "function_expression"],
    importTypes: ["import_statement"],
    requireCalls: true,
    callTypes: ["call_expression"],
    branchTypes: ["if_statement", "for_statement", "for_in_statement", "while_statement", "do_statement", "switch_case", "catch_clause", "ternary_expression"],
  },
  ts: {
    format: "ts",
    grammar: "tree-sitter-typescript.wasm",
    defTypes: ["function_declaration", "method_definition", "class_declaration", "arrow_function", "function_expression", "interface_declaration", "type_alias_declaration"],
    importTypes: ["import_statement"],
    requireCalls: true,
    callTypes: ["call_expression"],
    branchTypes: ["if_statement", "for_statement", "for_in_statement", "while_statement", "do_statement", "switch_case", "catch_clause", "ternary_expression"],
  },
};

// extension → format key. md has no grammar (handled by the section chunker). Routing only.
const EXT_FORMAT = { ".py": "py", ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "js", ".ts": "ts" };

/**
 * Language def for a file extension, or null when no tree-sitter grammar applies (md, or an
 * unsupported extension — the chunker falls back to a file-level chunk).
 * @param {string} ext  lowercased extension including the dot, e.g. ".py"
 * @returns {LangDef | null}
 */
export function langForExt(ext) {
  const fmt = EXT_FORMAT[ext];
  return fmt ? LANGDEFS[fmt] : null;
}
