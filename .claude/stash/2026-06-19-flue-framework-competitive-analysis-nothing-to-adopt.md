# Flue framework competitive analysis — honest verdict: nothing to adopt into litectx

**Date:** 2026-06-19 · **Branch:** main · **Type:** research/positioning (NO code changes) · tree clean before+after (this stash only).
**Trigger:** user asked whether Flue (https://flueframework.com — claims "the Claude primitives"), anything worth learning for litectx without bloat. Honest judgement requested.

## What Flue actually is
TypeScript **agent-orchestration runtime** from the Astro team (`withastro/flue`, Fred Schott). `createAgent({model, instructions})`, workflows, sandboxes, sessions, tools, skills, subagents; deploy to Node (Hono) / Cloudflare (Durable Objects) / CI. Its "Claude primitives" = the Claude Code **harness LOOP** (sessions/tools/skills/instructions/filesystem/sandbox), NOT context-engineering primitives. By its own docs it's "deliberately the opposite of Claude Code" (headless, no UI).

**Layer placement:** Flue is in **bareagent's lane** (orchestration/loop/server), NOT litectx's (graph/memory/CE substrate, no loop/no server). Flue is a potential *consumer* of a context lib, not one.

## The ONE technically substantive overlap: context compaction
Flue `CompactionConfig` (the only real mechanics in litectx's domain):
- `reserveTokens` (default model-aware, cap 20k) — headroom reserved BEFORE auto-compaction (compact at `limit − reserve`, proactive).
- `keepRecentTokens` (default 8000) — recent turns kept unsummarized.
- `model` — model override for the summary call.
- 3 trigger modes: auto-threshold · overflow-recovery (fires even if `compaction:false`) · explicit `session.compact()`.

**Maps onto litectx's existing `summaryWindow`/`assemble`/`trim` — and litectx already went DEEPER:** `reserveTokens` IS the "reserve + re-summarize" design litectx tested and recorded as UNSTABLE (settled on freshest-unit-over-assemble; "force-on-full overflows; reserve+re-summarize is unstable"). Flue likely dodges the instability only because it compacts inside a LIVE agent loop (a model call every turn) vs litectx being a deterministic library with no loop. → confirmation, not a technique. Do NOT re-open the reserve design (already-rejected, per memory).

Everything else (sessions=transcript state litectx deliberately doesn't own; tools=`defineTool` loop mechanics; skills=`import SKILL.md`; persistence punted to Durable Objects/unspecified) is harness/loop/transcript = bareagent's lane, excluded by litectx doctrine.

## Verdict (evidence-backed)
**Nothing to adopt without bloat.** The dig upgraded the call from "vague marketing" to "the single overlapping area (compaction) is already implemented in litectx AND has a deeper recorded finding; all else is loop/transcript/orchestration the doctrine excludes." Persistence philosophy is OPPOSITE: Flue punts to the platform (DO), litectx owns it deterministically (single-file better-sqlite3, local-first; also can't run on Cloudflare Workers — native addon — which is a deliberate choice, not a gap).

**Strategic takeaway (positioning, not code):** a credible Astro-team framework selling "Claude-Code-harness for everyone" while leaving the context/memory substrate thin = exactly the gap litectx fills. Worth ~1 line in ecosystem/README framing; zero lines in the codebase. Flue is a candidate adopter of `liteCtxAsStore`/`recall`/`ingest`/`scoped()`, not a competitor for the substrate.

## State
0.18.0 fail-closed scope shipped+published last session (HEAD `a320b57`); this session added no code. Sources: flueframework.com/docs/api/agent-api, /docs/concepts/agents, /docs/guide/sandboxes, betterstack.com/community/guides/ai/flue-framework, github.com/withastro/flue.
