// Dataset: aurora-mixed — the code-over-md gate (PRD §5). Same repo and the SAME 22 queries as
// `aurora.mjs`, all of whose ground-truth targets are CODE files — but here we index `.py` AND
// `.md` together. Aurora ships ~196 design/feature docs (ACTR_ACTIVATION.md, MEM_INDEXING.md, …)
// that discuss decay/activation/BM25/tree-sitter in prose far more often than the terse
// implementation files mention them. That makes the md docs strong lexical distractors: if plain
// BM25 lets prose out-surface the implementation, this bench's MRR drops below the py-only
// baseline, and the code-over-md fix's job is to recover it WITHOUT regressing the py-only run.
import aurora from "./aurora.mjs";

export default {
  name: "aurora-mixed",
  roots: aurora.roots,
  pathspecs: ["*.py", "*.md"],
  include: [".py", ".md"],
  edges: aurora.edges,
  queries: aurora.queries, // unchanged — every target is a code file; md files are distractors only
};
