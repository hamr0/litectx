#!/usr/bin/env node
// Thin entry point — all generator logic lives in the vendored, byte-identical
// scripts/primitives-core.mjs (shared with bare-agent and bareguard). Repo-
// specific bits (source roots, category inference, method-receiver names)
// live in primitives.config.mjs. See primitives-core.mjs's header comment and
// docs/product/litectx-prd.md § "Status (memory engine)" (primitives.json
// paragraph) for the full rationale.
//
//   node scripts/gen-primitives.mjs           # write ./primitives.json
//   node scripts/gen-primitives.mjs --check    # CI gate: verify the file is current + valid, write nothing
//
import { run } from './primitives-core.mjs';
import config from '../primitives.config.mjs';
await run(config);
