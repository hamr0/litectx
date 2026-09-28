// litectx's repo-specific config for the shared primitives.json generator
// core (scripts/primitives-core.mjs, vendored byte-identically into
// bare-agent and bareguard too). Only what genuinely differs per repo lives
// here — category inference and the class-method receiver-name map (litectx's
// verbs are methods on LiteCtx/ScopedView, not top-level exports).
import { basename } from 'node:path';

// --- category inference (POSIX-normalized relative path -> category) ---------
// litectx keeps most verbs in src/index.js (they are methods on one class), so
// file-based inference lands them all in 'core' — the per-verb category comes
// from an explicit @category tag. This map only carries the multi-file cases.
function inferCategory(file) {
  const b = basename(file, '.js');
  if (b === 'impact' || b === 'tsalias') return 'impact';
  if (b === 'compress' || b === 'assemble') return 'CE';
  if (b === 'contextgraph') return 'graph';
  if (b === 'embedder') return 'embeddings';
  if (b === 'memory-store') return 'memory';
  if (b === 'writegate') return 'governance';
  if (b === 'docparse') return 'ingest';
  return 'core';
}

export default {
  inferCategory,
  sourceRoots: ['src'],
  receivers: { LiteCtx: 'liteCtx', ScopedView: 'view' },
};
