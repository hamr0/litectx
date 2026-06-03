// Dataset: gitdone (JavaScript / CommonJS) — generalization test, different language + domain.
// Indexes app/ (source + bin + web + tests). The same-named *.test.js files are deliberate
// distractors for the HARD queries. Ground truth from an Explore pass; targets verified to exist.
export default {
  name: "gitdone",
  roots: ["/home/hamr/PycharmProjects/gitdone", "/home/hamr/Documents/PycharmProjects/gitdone"],
  pathspecs: ["app/**/*.js"],
  edges: "cjs",             // resolve relative require('./x') to files
  queries: [
    // ---- EASY (keyword in file name) ----
    { q: "How do I send emails from gitdone to users?", target: "app/src/outbound.js", diff: "easy" },
    { q: "Where is the email address parser that handles event+ and manage+ addresses?", target: "app/src/router.js", diff: "easy" },
    { q: "How does it validate the trust level of an incoming email?", target: "app/src/classifier.js", diff: "easy" },
    { q: "Where is the completion engine that decides if a reply counts toward finishing an event?", target: "app/src/completion.js", diff: "easy" },
    { q: "How is the per-event git repository created and updated?", target: "app/src/gitrepo.js", diff: "easy" },
    { q: "Where is the OpenTimestamps proof integration?", target: "app/src/ots.js", diff: "easy" },
    { q: "How are participant notifications sent?", target: "app/src/notifications.js", diff: "easy" },
    { q: "Where are the body texts for lifecycle emails stored?", target: "app/src/email-bodies.js", diff: "easy" },
    { q: "How does it decide which recipients get a lifecycle notification?", target: "app/src/email-recipients.js", diff: "easy" },
    { q: "Where is the DKIM public key archived for offline verification?", target: "app/src/dkim-archive.js", diff: "easy" },
    // ---- HARD (intent/synonym; same-named test file is a distractor) ----
    { q: "How does it prevent auto-responder loops and mailing-list spam?", target: "app/src/prefilter.js", diff: "hard" },
    { q: "What extracts and re-checks a forwarded message against a stored signature?", target: "app/src/verify.js", diff: "hard" },
    { q: "Where do we upgrade a previously-unverified signature to verified on resubmission?", target: "app/src/reverify.js", diff: "hard" },
    { q: "How do we parse delivery failure reports when an outbound message bounces?", target: "app/src/dsn.js", diff: "hard" },
    { q: "Where do we create an authenticated session so an organiser can reach their dashboard?", target: "app/src/auth.js", diff: "hard" },
    { q: "Which module downloads an archived event repository as a tar.gz for offline checking?", target: "app/src/bundle.js", diff: "hard" },
    { q: "How do we stop the same event being activated twice or two completions racing?", target: "app/src/event-mutex.js", diff: "hard" },
    { q: "Where is the hourly background job that archives old events and sends overdue nudges?", target: "app/src/sweep.js", diff: "hard" },
    { q: "What computes the reference-doc progress, how many of N attestors have signed?", target: "app/src/ack-progress.js", diff: "hard" },
    { q: "How can I tell an event was explicitly closed by the organiser, not completed naturally?", target: "app/src/completion.js", diff: "hard" },
  ],
};
