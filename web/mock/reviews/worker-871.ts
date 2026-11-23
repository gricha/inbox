// acme/worker#871: its diff and AI review for the website's demo.
import type { Canned } from "../diffs.ts";
import { file } from "../patch.ts";

export const review: Canned = {
  files: [
    file(
      "src/jobs/deadLetter.ts",
      "modified",
      `@@ -1,8 +1,26 @@
 import type { Job } from "./types.ts";
 import type { Db } from "../db.ts";
+import { RetryableError } from "./errors.ts";
 import { log } from "../log.ts";
+
+export type DeadReason = "not_retryable" | "expired" | "out_of_attempts";
+
+// Why a job stopped being retried: the first that holds.
+export function reasonFor(job: Job, err: unknown, now = Date.now()): DeadReason {
+  if (!(err instanceof RetryableError)) return "not_retryable";
+  if (job.expires_at && job.expires_at.getTime() <= now) return "expired";
+  return "out_of_attempts";
+}

 export async function deadLetter(db: Db, job: Job, err: unknown): Promise<void> {
+  const reason = reasonFor(job, err);
+  const message = err instanceof Error ? err.message : String(err);
   await db.exec("UPDATE jobs SET state = 'dead', finished_at = now() WHERE id = $1", [job.id]);
-  log.warn("job dead-lettered", { job_id: job.id, queue: job.queue });
+  log.warn("job dead-lettered", {
+    job_id: job.id,
+    queue: job.queue,
+    attempts: job.attempts,
+    reason,
+    error: message.slice(0, 500),
+  });
 }`,
    ),
    file(
      "test/jobs/deadLetter.test.ts",
      "modified",
      `@@ -1,8 +1,20 @@
 import { test } from "node:test";
 import assert from "node:assert/strict";
-import { deadLetter } from "../../src/jobs/deadLetter.ts";
+import { deadLetter, reasonFor } from "../../src/jobs/deadLetter.ts";
+import { RetryableError } from "../../src/jobs/errors.ts";
 import { fakeDb, job } from "../helpers/jobs.ts";

+const NOW = Date.parse("2026-11-01T12:00:00Z");
+
+test("says why a job was dead-lettered", () => {
+  assert.equal(reasonFor(job(), new TypeError("bad payload"), NOW), "not_retryable");
+  assert.equal(
+    reasonFor(job({ expires_at: new Date(NOW - 1) }), new RetryableError("503"), NOW),
+    "expired",
+  );
+  assert.equal(reasonFor(job({ attempts: 5 }), new RetryableError("503"), NOW), "out_of_attempts");
+});
+
 test("marks the job dead", async () => {
   const db = fakeDb();
   await deadLetter(db, job(), new Error("boom"));`,
    ),
  ],
  ai: {
    verdict: "skim",
    risk: "low",
    summary:
      "Logs why a job was dead-lettered: `reasonFor()` names it as not retryable, expired or out of attempts, and the warning now carries that reason with the attempt count and the error's message, cut to 500 characters. Nothing changes in what gets dead-lettered or when.",
    concerns: [],
    notes: [
      {
        path: "src/jobs/deadLetter.ts",
        side: "new",
        line: 10,
        body: "The order matters: an error that isn't a `RetryableError` is reported as not retryable even when the job had also expired, which is the more useful answer for whoever reads the log.",
      },
      {
        path: "src/jobs/deadLetter.ts",
        side: "new",
        line: 24,
        body: "Cut to 500 characters so an error that quotes a whole response body doesn't flood the log line.",
      },
      {
        path: "test/jobs/deadLetter.test.ts",
        side: "new",
        line: 7,
        body: "A fixed `now`, so the expiry case doesn't depend on when the suite runs.",
      },
    ],
    chunks: {
      ranked: [
        { id: "h1", path: "src/jobs/deadLetter.ts", level: "skim", why: "reason picked from the error, then the clock" },
        { id: "h2", path: "test/jobs/deadLetter.test.ts", level: "skim", why: "one case per reason" },
      ],
      unread: [],
      total: 2,
    },
    guide: {
      steps: [
        {
          title: "The reason in the log",
          body: "`reasonFor()` decides why the job stopped, and `deadLetter()` logs it with the attempts and the error's message.",
          check: "",
          hunks: [{ id: "h1", path: "src/jobs/deadLetter.ts" }],
        },
        {
          title: "Tests",
          body: "One case per reason, against a fixed clock.",
          check: "",
          hunks: [{ id: "h2", path: "test/jobs/deadLetter.test.ts" }],
        },
      ],
    },
  },
};
