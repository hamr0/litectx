// Dataset: memory-facts — the written-memory (slice 7) recall QUALITY gate (§11.3).
// Unlike the repo datasets, the corpus is IN the dataset: hand-authored facts/episodes an agent
// would realistically `remember()`, so the bench needs no local checkout and runs anywhere.
//
// Every query carries a `cat` label — the diagnostic axis this bench exists to measure:
//   exact — query shares ≥1 content keyword with the target (BM25's home turf; MUST stay high)
//   morph — query uses an inflectional VARIANT of a target word (refund/refunds, deploy/deploys):
//           zero exact-token overlap, ≥1 shared stem. FTS5 has no stemming → expected 0 with the
//           shipped BM25 core; this category is the red line a stemming/semantic fix must move.
//   para  — paraphrase/synonyms, no lexical relation at all: the embeddings-tier case.
//
// Labels are hand-audited AND mechanically audited by the bench (a morph/para query sharing an
// exact keyword with its target's indexed text — body OR id, since the id is indexed — fails the
// run; an exact query sharing none does too). Trust the metric only as far as the audit.
export default {
  name: "memory-facts",
  // Asserted regression floors (ALL-MRR style, per category — see memory-bench.mjs).
  // exact: BM25's home turf, must hold. morph: GRADUATED 2026-06-10 — slice 7b's porter `mem`
  // table lifted it 0.000 → 0.722 (epsilon-floored at 0.7); the 2 residual misses are derivational
  // ("deployment"→"deploys") + compounding ("rollback"→"rolled back"), beyond a stemmer by design.
  floors: { exact: 0.8, morph: 0.7 },
  // The currently-measured truth for the un-floored categories. If a change MOVES these (e.g. an
  // embeddings default lifts para), the bench fails until this line is consciously updated — the
  // same hold-or-beat discipline, pointed at honesty instead of quality.
  expected: { para: 0.0 },
  facts: [
    { id: "fact:auth-tokens", text: "Authentication uses JWT bearer tokens verified in the gateway middleware before any handler runs." },
    { id: "fact:session-expiry", text: "User sessions expire after thirty minutes of inactivity and then require a fresh login." },
    { id: "fact:signing-keys", text: "API signing keys rotate every ninety days through the KMS schedule." },
    { id: "fact:password-rules", text: "Passwords need twelve characters minimum and are hashed with argon2id." },
    { id: "fact:returns-terms", text: "Refunds are honored within thirty days of purchase; afterwards only store credit is offered." },
    { id: "fact:invoice-currency", text: "All invoices are denominated in EUR and converted for display only." },
    { id: "fact:tax-handling", text: "VAT is computed by the tax service at checkout and never stored on the invoice row." },
    { id: "fact:ship-to-prod", text: "Deploys to production go through the staging gate and need two approvals." },
    { id: "fact:failed-release-recovery", text: "A failed release is rolled back by promoting the previous image tag." },
    { id: "fact:db-engine", text: "The primary datastore is PostgreSQL fifteen running on RDS." },
    { id: "fact:schema-changes", text: "Schema migrations run automatically at boot, guarded by an advisory lock." },
    { id: "fact:hot-reads", text: "Caching for search results uses a five minute TTL in Redis." },
    { id: "fact:rate-limits", text: "Requests are throttled at one hundred per minute per API key." },
    { id: "fact:retry-behavior", text: "Failed webhook deliveries are retried five times with exponential backoff." },
    { id: "fact:log-retention", text: "Application logs are kept for ninety days in CloudWatch then archived to S3." },
    { id: "fact:error-tracking", text: "Unhandled exceptions are reported to Sentry with release tagging." },
    { id: "fact:feature-flags", text: "Feature flags live in LaunchDarkly and default to off for new flags." },
    { id: "fact:search-engine", text: "Full text search is served by the SQLite FTS5 index, not Elasticsearch." },
    { id: "fact:email-provider", text: "Transactional email goes through Postmark with a sandbox mode in staging." },
    { id: "fact:list-endpoints", text: "List endpoints use cursor pagination with a default page size of fifty." },
    { id: "fact:data-at-rest", text: "Customer records are encrypted at rest with AES two fifty six." },
    { id: "fact:timezone-convention", text: "All timestamps are stored in UTC; conversion to local time happens in the client." },
    { id: "fact:code-style", text: "The codebase is pure ESM JavaScript with JSDoc types; TypeScript is dev-only." },
    { id: "fact:testing-framework", text: "Tests run on node:test with integration tests against in-memory SQLite." },
  ],
  episodes: [
    { id: "ep:2026-06-04-poc-pass", text: "The recall POC passed on both repos; graph spreading beat plain BM25.", occurredAt: 1780531200000 },
    { id: "ep:2026-06-05-slice4", text: "Shipped import edges and spreading; additive weight zero point three won on four repos.", occurredAt: 1780617600000 },
    { id: "ep:2026-06-09-embeddings", text: "Shipped the embeddings tier; recall became async as a consequence.", occurredAt: 1780963200000 },
    { id: "ep:2026-06-09-v010", text: "Published version zero one zero to npm through the OIDC trusted publishing workflow.", occurredAt: 1780963200000 },
    { id: "ep:2026-06-10-write-path", text: "Shipped the write path; facts and episodes are now first class memory kinds.", occurredAt: 1781049600000 },
  ],
  queries: [
    // ---- exact (shared content keywords; BM25 must deliver — the floored category) ----
    { q: "JWT bearer tokens", target: "fact:auth-tokens", kind: "fact", cat: "exact" },
    { q: "sessions expire after inactivity", target: "fact:session-expiry", kind: "fact", cat: "exact" },
    { q: "how often do signing keys rotate", target: "fact:signing-keys", kind: "fact", cat: "exact" },
    { q: "password minimum characters", target: "fact:password-rules", kind: "fact", cat: "exact" },
    { q: "store credit after thirty days", target: "fact:returns-terms", kind: "fact", cat: "exact" },
    { q: "invoices in EUR", target: "fact:invoice-currency", kind: "fact", cat: "exact" },
    { q: "VAT computed at checkout", target: "fact:tax-handling", kind: "fact", cat: "exact" },
    { q: "staging gate approvals", target: "fact:ship-to-prod", kind: "fact", cat: "exact" },
    { q: "PostgreSQL on RDS", target: "fact:db-engine", kind: "fact", cat: "exact" },
    { q: "Redis TTL for search results", target: "fact:hot-reads", kind: "fact", cat: "exact" },
    { q: "exponential backoff for webhooks", target: "fact:retry-behavior", kind: "fact", cat: "exact" },
    { q: "logs archived to S3", target: "fact:log-retention", kind: "fact", cat: "exact" },
    { q: "feature flags default off", target: "fact:feature-flags", kind: "fact", cat: "exact" },
    { q: "timestamps stored in UTC", target: "fact:timezone-convention", kind: "fact", cat: "exact" },
    { q: "when did the POC pass", target: "ep:2026-06-04-poc-pass", kind: "episode", cat: "exact" },
    { q: "npm OIDC trusted publishing", target: "ep:2026-06-09-v010", kind: "episode", cat: "exact" },
    { q: "recall became async", target: "ep:2026-06-09-embeddings", kind: "episode", cat: "exact" },
    // ---- morph (inflectional variant, zero exact overlap — FTS5 has no stemming) ----
    { q: "refund policy", target: "fact:returns-terms", kind: "fact", cat: "morph" },          // refund ≠ refunds
    { q: "deployment workflow", target: "fact:ship-to-prod", kind: "fact", cat: "morph" },     // deployment ≠ deploys
    { q: "rollback steps", target: "fact:failed-release-recovery", kind: "fact", cat: "morph" }, // rollback ≠ rolled back
    { q: "migrate safely", target: "fact:schema-changes", kind: "fact", cat: "morph" },        // migrate ≠ migrations
    { q: "cached values", target: "fact:hot-reads", kind: "fact", cat: "morph" },              // cached ≠ caching
    { q: "throttling rules", target: "fact:rate-limits", kind: "fact", cat: "morph" },         // throttling ≠ throttled
    { q: "how many retries", target: "fact:retry-behavior", kind: "fact", cat: "morph" },      // retries ≠ retried/retry
    { q: "how to paginate", target: "fact:list-endpoints", kind: "fact", cat: "morph" },       // paginate ≠ pagination
    { q: "encrypt the database", target: "fact:data-at-rest", kind: "fact", cat: "morph" },    // encrypt ≠ encrypted
    // ---- para (no lexical relation at all — the embeddings-tier case) ----
    { q: "customers want their money back", target: "fact:returns-terms", kind: "fact", cat: "para" },
    { q: "how do users sign in", target: "fact:auth-tokens", kind: "fact", cat: "para" },
    { q: "getting code live for users", target: "fact:ship-to-prod", kind: "fact", cat: "para" },
    { q: "speed up slow lookups", target: "fact:hot-reads", kind: "fact", cat: "para" },
    { q: "government levies on sales", target: "fact:tax-handling", kind: "fact", cat: "para" },
    { q: "where do crashes end up", target: "fact:error-tracking", kind: "fact", cat: "para" },
  ],
};
