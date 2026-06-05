// Dataset: multis (JavaScript / CommonJS) — a THIRD repo, independent of the aurora (py) and
// gitdone (js) gate pair, added to pressure-test whether import-spreading generalizes beyond the
// two repos the signal was tuned on. Queries are tool-generated from an Explore pass over src/
// (7 easy = filename keyword present, 7 hard = intent/synonym, same-named test files as distractors)
// and each target was confirmed to exist. Labels are not hand-audited like aurora/gitdone, so treat
// the ABSOLUTE MRR as soft; the within-repo DELTA (spreading vs baseline, same labels) is the signal.
export default {
  name: "multis",
  roots: ["/home/hamr/PycharmProjects/multis", "/home/hamr/Documents/PycharmProjects/multis"],
  pathspecs: ["src/**/*.js", "test/**/*.js"],
  include: [".js"],
  edges: "cjs",
  queries: [
    // ---- EASY ----
    { q: "How do I handle message routing in this bot?", target: "src/bot/handlers.js", diff: "easy" },
    { q: "Where is the scheduler implementation for /remind and /cron commands?", target: "src/bot/scheduler.js", diff: "easy" },
    { q: "How does the Telegram platform connect to the bot?", target: "src/platforms/telegram.js", diff: "easy" },
    { q: "Where can I find the document indexing logic?", target: "src/indexer/index.js", diff: "easy" },
    { q: "How is memory stored and managed for conversations?", target: "src/memory/manager.js", diff: "easy" },
    { q: "Where are LLM providers configured and initialized?", target: "src/llm/provider-adapter.js", diff: "easy" },
    { q: "How does the config system work with file paths and environment variables?", target: "src/config.js", diff: "easy" },
    // ---- HARD ----
    { q: "What module orchestrates parsing, chunking, and storing document content?", target: "src/indexer/index.js", diff: "hard" },
    { q: "Where does the bot detect and log suspicious prompt injection attempts?", target: "src/security/injection.js", diff: "hard" },
    { q: "What code handles user approval workflows for sensitive operations?", target: "src/bot/checkpoint.js", diff: "hard" },
    { q: "How does the Beeper Desktop API integration work?", target: "src/platforms/beeper.js", diff: "hard" },
    { q: "Which module manages access control via PIN authentication?", target: "src/security/pin.js", diff: "hard" },
    { q: "Where is the policy engine that controls tool execution and resource access?", target: "src/governance/gate.js", diff: "hard" },
    { q: "What code summarizes conversations and stores them as searchable chunks?", target: "src/memory/capture.js", diff: "hard" },
  ],
};
