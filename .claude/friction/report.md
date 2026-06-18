# Friction Analysis - Detailed Report

**Generated:** 2026-06-17 10:18:23 UTC

**Sessions Analyzed:** 739
**Interactive Sessions:** 269 (multi-turn conversations)
**BAD Sessions:** 18 (7% of interactive)

## Glossary

**Interactive Session:** A conversation with >1 turn (multi-turn dialogue). Single-turn sessions are filtered from BAD rate calculation.

**BAD Session:** User gave up via `/stash`, `/exit`, or silent abandonment (high friction with no resolution).

**Friction:** Cumulative weight of negative signals. Higher friction = more user frustration.

**Peak Friction:** Maximum friction reached during a session.

---

## Executive Summary

✅ **HEALTHY**: 7% of interactive sessions end in failure. Average session: 6.0 turns, 4.0 friction, 480 min.

**Top Issues:**
- **checkpoint** (1349 occurrences, 0 total friction)
- **repeated_question** (321 occurrences, 1605 total friction)
- **exit_error** (227 occurrences, 114 total friction)

---

## Friction Weight System

Each signal has a weight representing its severity. Friction accumulates as signals occur.

| Weight | Severity | Meaning |
|--------|----------|----------|
| +10 | CRITICAL | User gave up (intervention, abandonment) |
| +8 | SEVERE | LLM false claims or no progress (false_success, no_resolution) |
| +7 | HIGH | User frustration (interrupt_cascade) |
| +6 | MEDIUM | Stuck patterns (tool_loop, rapid_exit) |
| +4-5 | LOW-MEDIUM | User signals (request_interrupted, user_curse) |
| +1 | MINOR | Technical issues (exit_error, repeated_question) |
| +0.5 | NOISE | Context signals (compaction, long_silence, user_negation) |

---

## Signal Breakdown

| Signal | Count | Weight | Total Friction | What It Means |
|--------|-------|--------|----------------|---------------|
| checkpoint | 1349 | +0.0 | 0.0 | Unknown signal |
| repeated_question | 321 | +5.0 | 1605.0 | User asked same question twice |
| exit_error | 227 | +0.5 | 113.5 | Command failed (exit code != 0) |
| false_success | 141 | +1.0 | 141.0 | LLM claimed success after error |
| request_interrupted | 86 | +3.0 | 258.0 | User hit Ctrl+C or ESC |
| tool_loop | 86 | +6.0 | 516.0 | Same tool called 3+ times |
| user_intervention | 29 | +1.0 | 29.0 | User gave up (/stash, /exit) |
| no_resolution | 27 | +0.5 | 13.5 | Errors without subsequent success |
| user_correction | 18 | +8.0 | 144.0 | Unknown signal |
| rapid_exit | 11 | +1.0 | 11.0 | <3 turns, ends with error/interrupt |
| user_curse | 9 | +8.0 | 72.0 | User frustration (profanity) |
| session_abandoned | 4 | +1.0 | 4.0 | High friction, no resolution |
| interrupt_cascade | 3 | +8.0 | 24.0 | 2+ interrupts within 60s |
| exit_success | 3 | +0.0 | 0.0 | Command succeeded (exit code 0) |

## Pattern Analysis

### Common Failure Patterns

**False Success Loop** (141 occurrences): LLM claims task is complete after command fails. This indicates the LLM is not checking exit codes properly.

**High Error Rate** (227 errors): Many commands are failing. This suggests either environment issues or LLM choosing wrong approaches.

**User Interruptions** (86 interrupts): Users frequently canceling operations. Commands may be too slow, stuck, or heading in wrong direction.

**Abandonment Rate** (11%): 29/269 interactive sessions ended with user giving up. This is acceptable for complex tasks.

### Friction Level Breakdown

**Low Friction (0-15):** 131 sessions - Normal operation, minor errors quickly resolved

**Medium Friction (15-50):** 46 sessions - Some struggles, multiple retries, but eventually successful

**High Friction (50+):** 15 sessions - Severe issues, user frustration, likely gave up

---

## Top Friction Sessions

| Project | Session | Quality | Peak | Turns | Duration | Top Signals |
|---------|---------|---------|------|-------|----------|-------------|
| healthwatch | 0531-1740-7c0c25c1 | FRICTION | 143.5 | 83 | 41h34m | checkpoint:33, repeated_question:15, request_interrupted:4 |
| multis | 0512-0912-e2c8e80f | ROUGH | 88 | 30 | 177h15m | checkpoint:9, repeated_question:17, request_interrupted:1 |
| liteagents | 0616-1641-13252f69 | FRICTION | 83.5 | 53 | 6h33m | checkpoint:25, repeated_question:15, success:1 |
| hamr | 0602-1412-38dcbe62 | BAD | 80 | 33 | 48h33m | checkpoint:4, repeated_question:10, curse:2 |
| litectx | 0612-1703-f1eb7cbb | FRICTION | 75.5 | 25 | 21h49m | checkpoint:10, repeated_question:1, error:3 |
| latefyi | 0602-1136-ed4106af | ROUGH | 71 | 31 | 344h38m | checkpoint:8, repeated_question:14, error:1 |
| gitdone | 0513-2002-0248bdc5 | FRICTION | 69 | 28 | 142h25m | checkpoint:13, repeated_question:12, error:2 |
| wearehere | 0519-1504-c543f730 | ROUGH | 67 | 36 | 4h39m | checkpoint:6, repeated_question:8, request_interrupted:1 |
| gitdone | 0601-2303-f567697c | FRICTION | 65 | 8 | 1h17m | checkpoint:6, tool_loop:10, false_success:2 |
| mailproof | 0528-1558-35a2cfd9 | ROUGH | 58 | 28 | 5h21m | checkpoint:7, repeated_question:11, request_interrupted:1 |
| liteagents | 0517-2206-fc50f372 | FRICTION | 57.5 | 43 | 12h50m | checkpoint:7, repeated_question:6, curse:2 |
| bareguard | 0530-0955-01c961bf | FRICTION | 56.5 | 36 | 38h1m | checkpoint:15, repeated_question:6, error:8 |
| hamr0 | 0529-1312-250bcf8a | ROUGH | 56 | 16 | 3h43m | checkpoint:3, repeated_question:5, tool_loop:5 |
| multis | 0519-1829-927c179e | FRICTION | 54.5 | 28 | 647h9m | checkpoint:10, repeated_question:10, request_interrupted:1 |
| liteagents | 0616-1125-cee40b55 | FRICTION | 51 | 51 | 5h14m | checkpoint:10, repeated_question:9, request_interrupted:1 |
| litectx | 0614-1210-7b4eea6c | FRICTION | 42.5 | 20 | 4h17m | checkpoint:7, error:5, false_success:4 |
| wearehere | 0520-2258-64f2d9d3 | FRICTION | 42.5 | 29 | 10h57m | checkpoint:9, error:5, false_success:4 |
| multis | 0616-2012-153b4c58 | BAD | 38 | 31 | 3h31m | checkpoint:5, repeated_question:2, request_interrupted:3 |
| bareguard | 0603-2318-065ac6fc | ROUGH | 35 | 20 | 45h6m | checkpoint:13, repeated_question:7 |
| dwi | 0527-1408-e775784b | BAD | 35 | 31 | 199h25m | checkpoint:9, repeated_question:5, correction:1 |

## Session Quality Breakdown

| Quality | Count | Description |
|---------|-------|-------------|
| BAD | 18 | user gave up (/stash) |
| FRICTION | 79 | curse or false_success |
| ROUGH | 18 | high friction but completed |
| OK | 154 | no significant friction |
| ONE-SHOT | 470 | single turn (filtered) |

## Per-Project Statistics

| Project | Interactive | BAD | BAD % | Avg Friction | Avg Turns | Avg Duration |
|---------|-------------|-----|-------|--------------|-----------|-------------|
| addypin | 7 | 1 | 14% | 5.4 | 9.7 | 15h51m |
| agentic-toolkit | 3 | 0 | 0% | 0.3 | 4.3 | 31m |
| ama | 8 | 0 | 0% | 5.1 | 5.9 | 2h29m |
| bareagent | 18 | 2 | 11% | 8.2 | 13.9 | 16h25m |
| barebrowse | 15 | 0 | 0% | 4.8 | 11.1 | 3h50m |
| bareguard | 16 | 1 | 6% | 2.6 | 4.2 | 3h41m |
| bareguard-harness-code-mode | 0 | 0 | - | 0.0 | 1.0 | - |
| baremobile | 5 | 0 | 0% | 6.6 | 11.8 | 4h12m |
| beeperbox | 9 | 0 | 0% | 9.3 | 14.2 | 44h23m |
| dwi | 6 | 2 | 33% | 9.4 | 17.0 | 64h3m |
| flightlog | 2 | 0 | 0% | 5.0 | 16.5 | 23h39m |
| flowithmel | 2 | 0 | 0% | 1.5 | 14.5 | 1h19m |
| gitcore | 2 | 0 | 0% | 4.8 | 7.5 | 42m |
| gitdone | 12 | 1 | 8% | 20.3 | 16.3 | 45h49m |
| hamr | 12 | 1 | 8% | 9.8 | 12.7 | 10h12m |
| hamr0 | 3 | 0 | 0% | 19.7 | 8.0 | 4h |
| healthwatch | 1 | 0 | 0% | 143.5 | 83.0 | 41h34m |
| knowless | 9 | 0 | 0% | 1.3 | 8.7 | 3h14m |
| latefyi | 3 | 0 | 0% | 27.8 | 16.0 | 198h55m |
| liteagents | 8 | 0 | 0% | 30.4 | 27.5 | 68h43m |
| litectx | 46 | 3 | 7% | 1.4 | 3.4 | 1h53m |
| litectx-poc | 3 | 1 | 33% | 5.0 | 15.3 | 8h54m |
| mailproof | 12 | 0 | 0% | 8.1 | 11.5 | 17h28m |
| mcp-gov | 1 | 0 | 0% | 13.0 | 17.0 | 4h56m |
| mcprune | 1 | 0 | 0% | 2.0 | 8.0 | 42m |
| multis | 10 | 1 | 10% | 22.7 | 18.7 | 86h40m |
| notes-smol | 1 | 0 | 0% | 0.0 | 7.0 | 1h |
| notes-smol-bank-tx | 2 | 0 | 0% | 0.0 | 3.0 | 1m |
| plato | 16 | 1 | 6% | 7.5 | 12.4 | 6h37m |
| privcloud | 15 | 3 | 20% | 10.5 | 17.5 | 27h3m |
| privpn | 3 | 0 | 0% | 4.0 | 11.3 | 1h6m |
| tmp | 0 | 0 | - | 0.0 | 1.0 | - |
| tmp-litectx-e2e | 0 | 0 | - | 0.0 | 1.0 | - |
| wearecooked | 2 | 1 | 50% | 14.5 | 20.5 | 7h4m |
| wearehere | 16 | 0 | 0% | 12.6 | 16.1 | 4h23m |

## Recommendations

1. **High Priority:** Add CLAUDE.md rule to verify exit codes before claiming success

2. **High Priority:** Commands timing out or stuck - review for heavy operations that need optimization

3. **Medium Priority:** Add CLAUDE.md rule to detect and break out of tool loops

4. **Medium Priority:** Many repeated questions - LLM not understanding user intent or context issues

---

## Daily Trend (Last 14 Days)

| Date | Interactive | BAD | Rate | Trend |
|------|-------------|-----|------|-------|
| 2026-06-02 | 16 | 2 | 13% | █░░░░░░░░░ |
| 2026-06-03 | 4 | 0 | 0% | ░░░░░░░░░░ |
| 2026-06-04 | 7 | 3 | 43% | ████░░░░░░ |
| 2026-06-05 | 13 | 0 | 0% | ░░░░░░░░░░ |
| 2026-06-08 | 3 | 1 | 33% | ███░░░░░░░ |
| 2026-06-09 | 3 | 0 | 0% | ░░░░░░░░░░ |
| 2026-06-10 | 5 | 0 | 0% | ░░░░░░░░░░ |
| 2026-06-11 | 13 | 2 | 15% | ██░░░░░░░░ |
| 2026-06-12 | 11 | 1 | 9% | █░░░░░░░░░ |
| 2026-06-13 | 11 | 2 | 18% | ██░░░░░░░░ |
| 2026-06-14 | 6 | 0 | 0% | ░░░░░░░░░░ |
| 2026-06-15 | 9 | 0 | 0% | ░░░░░░░░░░ |
| 2026-06-16 | 11 | 1 | 9% | █░░░░░░░░░ |
| 2026-06-17 | 1 | 0 | 0% | ░░░░░░░░░░ |

