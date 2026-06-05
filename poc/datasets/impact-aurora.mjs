// Impact ground-truth dataset — aurora (Python). Hand-audited real call sites (git grep → read).
// Excludes imports, `__all__` strings, type-annotation positions (`list[ParsedTask]`), and the
// definition. See impact-mcprune.mjs for the labeling contract; metric in poc/impact-bench.mjs.

export default {
  name: "impact-aurora",
  roots: ["/home/hamr/PycharmProjects/aurora", "/home/hamr/Documents/PycharmProjects/aurora"],
  include: [".py"],
  pathspecs: ["*.py"],
  labels: [
    // direct function call — expect high confirmed recall.
    { symbol: "topological_sort_tasks", defFile: "packages/implement/src/implement/topo_sort.py",
      used: true, form: "direct",
      callerFiles: [
        "packages/cli/src/aurora_cli/commands/spawn.py",
        "packages/implement/tests/test_topo_sort.py",
      ] },
    // class constructor `ParsedTask(...)` — a `call` node in Python; expect high confirmed recall.
    { symbol: "ParsedTask", defFile: "packages/implement/src/implement/models.py",
      used: true, form: "constructor",
      callerFiles: [
        "packages/implement/src/implement/parser.py",
        "packages/implement/tests/test_executor.py",
        "packages/implement/tests/test_models.py",
        "packages/implement/tests/test_topo_sort.py",
      ] },
    // ADVERSARIAL: every use is a bare `@handle_errors` decorator — NOT a `call` node, so confirmed
    // recall is expected to be ~0. The §7.2 safety net must still hold: the `rg` mention floor keeps
    // refCount high → never reported isolated. This is the label that proves the gate separates
    // confirmed-caller QUALITY from false-isolation SAFETY.
    // NB: errors.py:652 `@handle_errors` sits INSIDE handle_errors's own def (a self-application),
    // so it's a self-reference, not an external caller — correctly excluded (like recursion). The
    // gate caught this over-inclusion in an earlier draft of this label; errors.py is omitted.
    { symbol: "handle_errors", defFile: "packages/cli/src/aurora_cli/errors.py",
      used: true, form: "decorator (bare @handle_errors — exercises decorator confirmation)",
      callerFiles: [
        "packages/cli/src/aurora_cli/commands/agents.py",
        "packages/cli/src/aurora_cli/commands/budget.py",
        "packages/cli/src/aurora_cli/commands/goals.py",
        "packages/cli/src/aurora_cli/commands/init.py",
        "packages/cli/src/aurora_cli/commands/memory.py",
        "packages/cli/src/aurora_cli/commands/plan.py",
      ] },
  ],
};
