// Dataset: aurora (Python). The kernel we're borrowing — the gate's primary repo.
// queries grounded by an Explore pass over the real modules; targets verified to exist.
export default {
  name: "aurora",
  roots: ["/home/hamr/PycharmProjects/aurora", "/home/hamr/Documents/PycharmProjects/aurora"],
  pathspecs: ["*.py"],
  edges: "python",          // resolve `from aurora_x.y import z` to files
  queries: [
    // ---- EASY ----
    { q: "How do I calculate base-level activation from access history?", target: "packages/core/src/aurora_core/activation/base_level.py", diff: "easy" },
    { q: "Where is the BM25 tokenizer for code-aware keyword matching?", target: "packages/context-code/src/aurora_context_code/semantic/bm25_scorer.py", diff: "easy" },
    { q: "How does the SQLite store save and retrieve chunks?", target: "packages/core/src/aurora_core/store/sqlite.py", diff: "easy" },
    { q: "What is the git blame implementation for commit history?", target: "packages/context-code/src/aurora_context_code/git.py", diff: "easy" },
    { q: "Where is the FTS5 full-text search table defined?", target: "packages/core/src/aurora_core/store/schema.py", diff: "easy" },
    { q: "How do I extract Python code elements with tree-sitter?", target: "packages/context-code/src/aurora_context_code/languages/python.py", diff: "easy" },
    { q: "What defines the base chunk data structure?", target: "packages/core/src/aurora_core/chunks/base.py", diff: "easy" },
    { q: "How is spreading activation calculated across relationships?", target: "packages/core/src/aurora_core/activation/spreading.py", diff: "easy" },
    { q: "What is the decay formula for time-based activation penalty?", target: "packages/core/src/aurora_core/activation/decay.py", diff: "easy" },
    { q: "How does the hybrid retriever combine BM25 activation and embeddings?", target: "packages/context-code/src/aurora_context_code/semantic/hybrid_retriever.py", diff: "easy" },
    { q: "Where is the LSP facade for code analysis?", target: "packages/lsp/src/aurora_lsp/facade.py", diff: "easy" },
    // ---- HARD ----
    { q: "How are function dependencies extracted to build the relationship graph?", target: "packages/context-code/src/aurora_context_code/languages/python.py", diff: "hard" },
    { q: "What mechanism prevents unbounded growth of access history?", target: "packages/core/src/aurora_core/store/access_history.py", diff: "hard" },
    { q: "How do code chunks represent their location in source files?", target: "packages/core/src/aurora_core/chunks/code_chunk.py", diff: "hard" },
    { q: "What is the entry point for turning a natural language query into retrieval?", target: "packages/context-code/src/aurora_context_code/semantic/hybrid_retriever.py", diff: "hard" },
    { q: "How does the system decide when to compact history into buckets?", target: "packages/core/src/aurora_core/store/access_history.py", diff: "hard" },
    { q: "Where are knowledge chunks parsed from markdown documentation?", target: "packages/context-code/src/aurora_context_code/knowledge_parser.py", diff: "hard" },
    { q: "How does the system penalize unstable frequently-changing code?", target: "packages/core/src/aurora_core/activation/decay.py", diff: "hard" },
    { q: "How are context keywords extracted and matched against chunks?", target: "packages/core/src/aurora_core/activation/context_boost.py", diff: "hard" },
    { q: "What orchestrates the full activation calculation pipeline to a total score?", target: "packages/core/src/aurora_core/activation/engine.py", diff: "hard" },
    { q: "Where does it check database schema compatibility before loading?", target: "packages/core/src/aurora_core/store/migrations.py", diff: "hard" },
    { q: "How is the connection pool managed per thread?", target: "packages/core/src/aurora_core/store/connection_pool.py", diff: "hard" },
  ],
};
