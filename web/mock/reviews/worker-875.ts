// acme/worker#875: its diff and AI review for the website's demo.
import type { Canned } from "../diffs.ts";
import { file } from "../patch.ts";

export const review: Canned = {
  files: [
    file(
      "docs/webhooks.md",
      "modified",
      `@@ -18,7 +18,12 @@ Every delivery is a \`POST\` with a JSON body and these headers:
 | \`Content-Type\` | \`application/json\` |
 | \`X-Acme-Event\` | The event type, such as \`invoice.paid\` |
 | \`X-Acme-Signature\` | HMAC-SHA256 of the body with your endpoint's secret |
+| \`Idempotency-Key\` | The same on every attempt at one delivery |

 ## Retries

 A delivery that times out or gets anything but a 2xx is retried with backoff, for up to 24 hours.
+
+A retry can reach you after the first attempt did: the request arrived, but your answer didn't reach us in
+time. It carries the same \`Idempotency-Key\`, so keep the keys you've handled and drop a repeat. Keys are
+32 hex characters.`,
    ),
    file(
      "migrations/0042_webhook_deliveries.sql",
      "added",
      `@@ -0,0 +1,8 @@
+CREATE TABLE webhook_deliveries (
+  key text PRIMARY KEY,
+  webhook_id text NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
+  event_id text NOT NULL,
+  attempts integer NOT NULL DEFAULT 0,
+  delivered_at timestamptz,
+  created_at timestamptz NOT NULL DEFAULT now()
+);`,
    ),
    file(
      "src/jobs/webhook.ts",
      "modified",
      `@@ -1,5 +1,6 @@
 import type { Job } from "./types.ts";
 import { db } from "../db.ts";
+import { deliveries } from "../webhooks/deliveries.ts";
 import { deliver } from "../webhooks/deliver.ts";
 import { loadEvent, loadWebhook } from "../webhooks/store.ts";

@@ -14,6 +15,6 @@ export const webhookJob: Job<{ webhookId: string; eventId: string }> = {
   async run({ webhookId, eventId }) {
     const hook = await loadWebhook(db, webhookId);
     const event = await loadEvent(db, eventId);
-    await deliver(hook, event);
+    await deliver(deliveries(db), hook, event);
   },
 };`,
    ),
    file(
      "src/webhooks/deliver.ts",
      "modified",
      `@@ -1,20 +1,26 @@
 import { RetryableError } from "../jobs/errors.ts";
+import { deliveryKey, type Deliveries } from "./deliveries.ts";
 import { sign } from "./sign.ts";
 import type { Webhook, WebhookEvent } from "./types.ts";

 const TIMEOUT_MS = 10_000;

-export async function deliver(hook: Webhook, event: WebhookEvent): Promise<void> {
+export async function deliver(deliveries: Deliveries, hook: Webhook, event: WebhookEvent): Promise<void> {
+  const key = deliveryKey(hook.id, event.id);
+  if (await deliveries.delivered(key)) return;
+  await deliveries.attempt(key, hook.id, event.id);
   const body = JSON.stringify(event.payload);
   const res = await fetch(hook.url, {
     method: "POST",
     headers: {
       "Content-Type": "application/json",
+      "Idempotency-Key": key,
       "X-Acme-Event": event.type,
       "X-Acme-Signature": sign(hook.secret, body),
     },
     body,
     signal: AbortSignal.timeout(TIMEOUT_MS),
   });
   if (!res.ok) throw new RetryableError(\`webhook \${hook.id} answered \${res.status}\`);
+  await deliveries.markDelivered(key);
 }`,
    ),
    file(
      "src/webhooks/deliveries.ts",
      "added",
      `@@ -0,0 +1,29 @@
+import { createHash } from "node:crypto";
+import type { Db } from "../db.ts";
+
+// From the webhook and the event alone, so every attempt at one delivery, on any worker, sends the same key.
+export const deliveryKey = (webhookId: string, eventId: string): string =>
+  createHash("sha256").update(\`\${webhookId}:\${eventId}\`).digest("hex").slice(0, 32);
+
+export interface Deliveries {
+  delivered(key: string): Promise<boolean>;
+  attempt(key: string, webhookId: string, eventId: string): Promise<void>;
+  markDelivered(key: string): Promise<void>;
+}
+
+export const deliveries = (db: Db): Deliveries => ({
+  async delivered(key) {
+    const row = await db.one<{ delivered_at: Date | null }>("SELECT delivered_at FROM webhook_deliveries WHERE key = $1", [key]);
+    return row?.delivered_at != null;
+  },
+  async attempt(key, webhookId, eventId) {
+    await db.exec(
+      \`INSERT INTO webhook_deliveries (key, webhook_id, event_id, attempts) VALUES ($1, $2, $3, 1)
+       ON CONFLICT (key) DO UPDATE SET attempts = webhook_deliveries.attempts + 1\`,
+      [key, webhookId, eventId],
+    );
+  },
+  async markDelivered(key) {
+    await db.exec("UPDATE webhook_deliveries SET delivered_at = now() WHERE key = $1", [key]);
+  },
+});`,
    ),
    file(
      "test/webhooks/deliver.test.ts",
      "added",
      `@@ -0,0 +1,39 @@
+import { test } from "node:test";
+import assert from "node:assert/strict";
+import { deliver } from "../../src/webhooks/deliver.ts";
+import type { Deliveries } from "../../src/webhooks/deliveries.ts";
+
+const hook = { id: "wh_1", url: "https://example.test/hook", secret: "s3cret" };
+const event = { id: "ev_1", type: "invoice.paid", payload: { invoice: "in_1" } };
+
+function memory(): Deliveries {
+  const done = new Set<string>();
+  return {
+    delivered: async (key) => done.has(key),
+    attempt: async () => {},
+    markDelivered: async (key) => void done.add(key),
+  };
+}
+
+test("a retry after a timeout sends the same key", async (t) => {
+  const keys: (string | null)[] = [];
+  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
+    keys.push(new Headers(init.headers).get("Idempotency-Key"));
+    if (keys.length === 1) throw new DOMException("timed out", "TimeoutError");
+    return new Response(null, { status: 200 });
+  });
+  const store = memory();
+  await assert.rejects(deliver(store, hook, event));
+  await deliver(store, hook, event);
+  assert.equal(keys.length, 2);
+  assert.ok(keys[0]);
+  assert.equal(keys[0], keys[1]);
+});
+
+test("a delivery the receiver took isn't sent again", async (t) => {
+  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
+  const store = memory();
+  await deliver(store, hook, event);
+  await deliver(store, hook, event);
+  assert.equal(fetch.mock.callCount(), 1);
+});`,
    ),
  ],
  ai: {
    verdict: "skim",
    risk: "low",
    summary:
      "Sends an `Idempotency-Key` header with every webhook delivery, derived from the webhook and event ids so every attempt at one delivery carries the same key, and records each key in a new `webhook_deliveries` table. A delivery already marked delivered is skipped; one that timed out after the request went out is retried with the same key, so the receiver can drop the repeat.",
    concerns: [
      "The docs tell receivers to drop a repeat but not what to answer it with. `deliver()` retries anything outside 2xx, so a receiver that answers a repeat with 409 gets retried for 24 hours and the delivery dead-letters; the docs should ask for a 2xx.",
    ],
    notes: [
      {
        path: "src/webhooks/deliver.ts",
        side: "new",
        line: 24,
        body: "Any status outside 2xx is still a failure here, including a 409 from a receiver that recognised the key. Either the docs ask for a 2xx on a repeat, or a 409 counts as delivered.",
      },
      {
        path: "src/webhooks/deliveries.ts",
        side: "new",
        line: 5,
        body: "The key is computed, not stored first and read back, so a retry on another worker, or after a restart, sends the same one without a lookup.",
      },
      {
        path: "src/webhooks/deliver.ts",
        side: "new",
        line: 10,
        body: "Only a delivery that got a 2xx is skipped. One that timed out stays unmarked and goes out again with the same key, which is the case the header exists for.",
      },
      {
        path: "src/webhooks/deliver.ts",
        side: "new",
        line: 25,
        body: "Marked after the response, so a worker that dies between the 2xx and this line resends once; the receiver drops it by key.",
      },
      {
        path: "migrations/0042_webhook_deliveries.sql",
        side: "new",
        line: 3,
        body: "Additive: a new table, nothing existing changes, so it's safe to run before the code deploys. Rows go when their webhook is deleted.",
      },
      {
        path: "test/webhooks/deliver.test.ts",
        side: "new",
        line: 0,
        body: "Covers the two paths that matter: a timed-out attempt retried with the same key, and a delivered one not sent again.",
      },
    ],
    chunks: {
      ranked: [
        { id: "h5", path: "src/webhooks/deliver.ts", level: "look", why: "skips delivered, marks after a 2xx" },
        { id: "h6", path: "src/webhooks/deliveries.ts", level: "skim", why: "key from webhook and event ids" },
        { id: "h2", path: "migrations/0042_webhook_deliveries.sql", level: "skim", why: "new table, additive" },
        { id: "h7", path: "test/webhooks/deliver.test.ts", level: "skim", why: "retry reuses the key" },
        { id: "h1", path: "docs/webhooks.md", level: "skim", why: "receivers told to drop repeats" },
        { id: "h4", path: "src/jobs/webhook.ts", level: "skim", why: "passes the store in" },
      ],
      unread: [],
      total: 7,
    },
    guide: {
      steps: [
        {
          title: "The key and where it's kept",
          body: "`deliveryKey()` hashes the webhook and event ids, so every attempt at one delivery gets the same key. `webhook_deliveries` records each key, its attempts and when it was delivered.",
          check: "",
          hunks: [
            { id: "h6", path: "src/webhooks/deliveries.ts" },
            { id: "h2", path: "migrations/0042_webhook_deliveries.sql" },
          ],
        },
        {
          title: "Sending it",
          body: "`deliver()` skips a key already delivered, counts the attempt, sends the key as `Idempotency-Key`, and marks it delivered only after a 2xx. The webhook job passes the store in.",
          check: "A timed-out attempt isn't marked delivered, so its retry sends the same key.",
          hunks: [
            { id: "h5", path: "src/webhooks/deliver.ts" },
            { id: "h3", path: "src/jobs/webhook.ts" },
            { id: "h4", path: "src/jobs/webhook.ts" },
          ],
        },
        {
          title: "Tests and the receiver's side",
          body: "The tests fake a timeout and a 204; the docs add the header and tell receivers to drop a repeat.",
          check: "",
          hunks: [
            { id: "h7", path: "test/webhooks/deliver.test.ts" },
            { id: "h1", path: "docs/webhooks.md" },
          ],
        },
      ],
    },
  },
};
