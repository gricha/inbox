// acme/worker#870: its diff and AI review for the website's demo.
import type { Canned } from "../diffs.ts";
import { file } from "../patch.ts";

export const review: Canned = {
  files: [
    file(
      "docs/operations/queue-sizing.md",
      "added",
      `@@ -0,0 +1,88 @@
+# Sizing queues for large tenants
+
+Most tenants never notice the queue. The few that send more than about 50,000 jobs an hour do: their jobs wait
+behind each other, and with the defaults one of them can hold most of a worker pool. This page says which settings
+to change for those tenants, and what each costs.
+
+## Finding them
+
+The tenants over that line in the last week:
+
+    SELECT tenant, count(*) / 168 AS per_hour FROM jobs WHERE enqueued_at > now() - interval '7 days' GROUP BY tenant HAVING count(*) > 8400000;
+
+## The settings
+
+All of them live in \`worker.toml\`, and each can be set per tenant under \`[tenants.<slug>]\`.
+
+| Setting                  | Default | What it limits                                      |
+| ------------------------ | ------- | --------------------------------------------------- |
+| \`queue.max_depth\`        | 10,000  | Jobs waiting for one tenant before enqueue says 429 |
+| \`queue.prefetch\`         | 8       | Jobs one worker leases ahead of the one it runs     |
+| \`tenant.concurrency\`     | 16      | Jobs of one tenant running at once, across workers  |
+| \`lease.timeout_s\`        | 30      | How long a leased job waits before it's reclaimed   |
+
+## Depth
+
+\`queue.max_depth\` is a backstop, not a buffer. When a tenant hits it, enqueue answers 429 with \`Retry-After\`, and
+their client is expected to back off. Raise it only for tenants whose traffic comes in bursts that drain within a few
+minutes, such as a nightly import. A tenant that sits at its limit all day needs more concurrency, not more depth.
+
+A rough ceiling: each waiting job costs about 2 KB in Postgres, so 100,000 waiting jobs is about 200 MB of table and
+index. Above that, autovacuum on \`jobs\` starts to fall behind.
+
+## Concurrency
+
+\`tenant.concurrency\` is what keeps one tenant from starving the others. Set it from the tenant's job time and the
+throughput they need:
+
+    concurrency = jobs per second × average job time in seconds
+
+A tenant sending 30 jobs a second at 1.5 s each needs about 45. Leave headroom of a quarter or so, and keep the sum
+across your largest tenants below the pool's size, or they will share the pool among themselves and everyone else waits.
+
+## Prefetch
+
+Prefetch saves a round trip to the lease table per job, which matters for short jobs. For a large tenant with jobs
+under 200 ms, raising \`queue.prefetch\` to 64 roughly halves lease-table load.
+
+Prefetched jobs are leased when they're fetched, so their lease clock runs while they wait their turn.
+
+## An example
+
+A tenant importing product catalogues sends 2 million jobs overnight, about 40 a second at 0.8 s each:
+
+\`\`\`toml
+[tenants.catalogue-import]
+queue.max_depth = 80000
+queue.prefetch = 64
+tenant.concurrency = 40
+\`\`\`
+
+Depth covers the first minutes of the import, when the client enqueues in bulk. Concurrency of 40 gives 50 jobs
+a second, a quarter above what they send.
+
+## Watching it
+
+These metrics show whether the settings fit:
+
+- \`worker_queue_depth{tenant}\`: should fall back towards zero between bursts. A line that only grows means the
+  tenant needs more concurrency.
+- \`worker_queue_wait_seconds{tenant}\`: p95 time from enqueue to start. Most tenants sit under a second.
+- \`worker_enqueue_rejected_total{tenant}\`: 429s from \`max_depth\`. A few during a burst are fine; a steady rate
+  means the client isn't backing off.
+- \`worker_lease_reclaimed_total\`: leases that timed out. Anything above zero for a tenant usually means prefetch is
+  too high for its job time.
+
+## Changing it
+
+Per-tenant settings are read on each lease, so a change applies within a few seconds without a restart. Lowering
+\`max_depth\` below the current depth doesn't drop jobs: enqueue answers 429 until the queue drains below it.
+
+Record the change and the reason in the tenant's runbook entry, so whoever is on call knows the numbers are deliberate.
+
+## Still to write
+
+- How the dead-letter queue counts against \`max_depth\` (it doesn't today; check after #871).
+- Sizing for the split scheduler, once lease and dispatch run separately.
+- Whether \`tenant.concurrency\` should scale with the pool instead of being a fixed number.
+`,
    ),
  ],
  ai: {
    verdict: "skim",
    risk: "low",
    summary:
      "Adds an operations page on sizing the job queue for tenants that send more than about 50,000 jobs an hour: what `queue.max_depth`, `queue.prefetch`, `tenant.concurrency` and `lease.timeout_s` limit, a worked example, and the metrics that show whether the numbers fit. Docs only; it's a draft with a short list of sections still to write.",
    concerns: [
      "The example's prefetch of 64 with 0.8 s jobs keeps a prefetched job waiting up to about 50 s, past the default 30 s `lease.timeout_s`, so following it as written gets leases reclaimed and jobs run twice. The example should lower prefetch or raise the lease timeout to match.",
    ],
    notes: [
      {
        path: "docs/operations/queue-sizing.md",
        side: "new",
        line: 46,
        body: "The 64 here is given for jobs under 200 ms, where 64 waiting jobs clear in about 13 s; the example below reuses it for 0.8 s jobs.",
      },
      {
        path: "docs/operations/queue-sizing.md",
        side: "new",
        line: 57,
        body: "The line the concern is about: at 0.8 s a job, the last of 64 prefetched jobs starts around 50 s after it was leased.",
      },
      {
        path: "docs/operations/queue-sizing.md",
        side: "new",
        line: 73,
        body: "The page's own warning sign for this, which the example would trip.",
      },
    ],
    chunks: {
      ranked: [{ id: "h1", path: "docs/operations/queue-sizing.md", level: "skim", why: "example's prefetch outlasts the lease" }],
      unread: [],
      total: 1,
    },
    guide: {
      steps: [
        {
          title: "The sizing guide",
          body: "One new page: what each queue setting limits, how to pick concurrency from job time and throughput, an example for an overnight import, and the metrics to watch afterwards.",
          check: "The example's numbers agree with the advice above it, prefetch against the lease timeout in particular.",
          hunks: [{ id: "h1", path: "docs/operations/queue-sizing.md" }],
        },
      ],
    },
  },
};
