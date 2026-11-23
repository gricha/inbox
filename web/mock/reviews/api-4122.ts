// acme/api#4122: its diff and AI review for the website's demo.
import type { Canned } from "../diffs.ts";
import { file } from "../patch.ts";

export const review: Canned = {
  files: [
    file(
      "src/audit/page.ts",
      "added",
      `@@ -0,0 +1,34 @@
+import type { Db } from "../db.ts";
+import type { AuditEntry } from "./types.ts";
+
+export const MAX_PAGE = 1000;
+
+export interface AuditPage {
+  entries: AuditEntry[];
+  next_cursor: string | null;
+}
+
+// The last row's id in decimal. Clients keep cursors between runs, so this format is part of the API.
+export const encodeCursor = (id: bigint): string => id.toString();
+
+export function decodeCursor(cursor: string): bigint | null {
+  return /^\\d{1,19}$/.test(cursor) ? BigInt(cursor) : null;
+}
+
+export async function pageAuditLog(
+  db: Db,
+  q: { orgId: string; from: Date; to: Date; after: bigint | null; limit: number },
+): Promise<AuditPage> {
+  // One row past the page says whether there's another, without a count.
+  const rows = await db.many<AuditEntry>(
+    \`SELECT id, at, actor, action, target, ip FROM audit_log
+     WHERE org_id = $1 AND at >= $2 AND at < $3 AND id > $4
+     ORDER BY id
+     LIMIT $5\`,
+    [q.orgId, q.from, q.to, q.after ?? 0n, q.limit + 1],
+  );
+  const more = rows.length > q.limit;
+  const entries = more ? rows.slice(0, q.limit) : rows;
+  const last = entries.at(-1);
+  return { entries, next_cursor: more && last ? encodeCursor(last.id) : null };
+}`,
    ),
    file(
      "src/routes/audit.ts",
      "modified",
      `@@ -1,6 +1,6 @@
 import type { App } from "../app.ts";
-import { allAuditEntries } from "../audit/query.ts";
+import { MAX_PAGE, decodeCursor, pageAuditLog } from "../audit/page.ts";
 import { parseRange } from "../audit/range.ts";
 import { db } from "../db.ts";
 import { requireScope } from "../auth/scope.ts";

@@ -19,7 +19,11 @@ export function auditRoutes(app: App): void {
   app.get("/v2/orgs/:org/audit-log/export", requireScope("audit:read"), async (req, res) => {
     const range = parseRange(req.query);
     if (!range.ok) return res.status(400).json({ error: range.error });
-    const entries = await allAuditEntries(db, req.params.org, range.from, range.to);
-    res.json({ entries });
+    const cursor = req.query.cursor ? String(req.query.cursor) : null;
+    const after = cursor === null ? null : decodeCursor(cursor);
+    if (cursor !== null && after === null) return res.status(400).json({ error: "not a cursor this endpoint gave out" });
+    const limit = Math.min(Number(req.query.limit) || MAX_PAGE, MAX_PAGE);
+    const page = await pageAuditLog(db, { orgId: req.params.org, from: range.from, to: range.to, after, limit });
+    res.json(page);
   });
 }`,
    ),
    file(
      "packages/cli/src/commands/audit-export.ts",
      "modified",
      `@@ -4,12 +4,23 @@ import type { AuditEntry } from "../types.ts";

 const HEADER = "id,at,actor,action,target,ip";

+type Page = { entries: AuditEntry[]; next_cursor: string | null };
+
 export async function auditExport(api: ApiClient, opts: { org: string; from: string; to: string; out: Writable }) {
-  const { entries } = await api.get(\`/v2/orgs/\${opts.org}/audit-log/export\`, { from: opts.from, to: opts.to });
-  opts.out.write(toCsv(entries));
+  // The export comes a page at a time now; follow next_cursor until the server says there's no more.
+  let cursor: string | null = null;
+  do {
+    const page: Page = await api.get(\`/v2/orgs/\${opts.org}/audit-log/export\`, {
+      from: opts.from,
+      to: opts.to,
+      ...(cursor && { cursor }),
+    });
+    opts.out.write(toCsv(page.entries));
+    cursor = page.next_cursor;
+  } while (cursor);
 }

 function toCsv(entries: AuditEntry[]): string {
   const lines = entries.map((e) => [e.id, e.at.toISOString(), e.actor, e.action, e.target, e.ip].map(csvCell).join(","));
   return [HEADER, ...lines].join("\\n") + "\\n";
 }`,
    ),
    file(
      "test/audit/page.test.ts",
      "added",
      `@@ -0,0 +1,27 @@
+import { test } from "node:test";
+import assert from "node:assert/strict";
+import { decodeCursor, encodeCursor, pageAuditLog } from "../../src/audit/page.ts";
+import { seedAudit, testDb } from "../helpers/db.ts";
+
+test("pages through the log in id order, each row once", async () => {
+  const db = await testDb();
+  await seedAudit(db, "org_1", 2500);
+  const seen: bigint[] = [];
+  let after: bigint | null = null;
+  for (;;) {
+    const page = await pageAuditLog(db, { orgId: "org_1", from: new Date(0), to: new Date(), after, limit: 1000 });
+    seen.push(...page.entries.map((e) => e.id));
+    if (!page.next_cursor) break;
+    after = decodeCursor(page.next_cursor);
+  }
+  assert.equal(seen.length, 2500);
+  assert.deepEqual(seen, [...seen].sort((a, b) => (a < b ? -1 : 1)));
+});
+
+// Clients keep cursors between runs: a change to this format breaks them, so it fails here first.
+test("the cursor is the last row's id in decimal", () => {
+  assert.equal(encodeCursor(4122n), "4122");
+  assert.equal(decodeCursor("4122"), 4122n);
+  assert.equal(decodeCursor("eyJpZCI6NDEyMn0"), null);
+  assert.equal(decodeCursor("-1"), null);
+});`,
    ),
  ],
  ai: {
    verdict: "look",
    risk: "medium",
    summary:
      "Pages the audit log export: `/v2/orgs/:org/audit-log/export` now returns up to 1,000 entries and a `next_cursor`, the last row's id, instead of every entry in the range at once. The CLI's `audit export` follows the cursor until it runs out, and a test pins the cursor's format so clients' saved cursors keep working.",
    concerns: [
      "`toCsv()` puts the header row on every call, and the CLI now calls it once per page, so an export of 2,500 entries writes the header three times, twice in the middle of the data. Write `HEADER` once before the loop and have `toCsv` return only the rows.",
      "`?limit=` goes through `Number(...) || MAX_PAGE`, which catches NaN and 0 but not a negative value: `limit=-5` reaches the query as `LIMIT -4` and the database's error comes back as a 500, not a 400.",
    ],
    notes: [
      {
        path: "src/audit/page.ts",
        side: "new",
        line: 12,
        body: "The row id as the cursor, kept after dana's review: ids only grow and the query orders by them, so a page picks up exactly where the last one ended.",
      },
      {
        path: "src/audit/page.ts",
        side: "new",
        line: 28,
        body: "Asks for one row more than the page, so the last page has no cursor and a client never makes a request that comes back empty.",
      },
      {
        path: "src/routes/audit.ts",
        side: "new",
        line: 25,
        body: "The concern's line: a negative `limit` passes `||` and `Math.min` unchanged.",
      },
      {
        path: "src/routes/audit.ts",
        side: "new",
        line: 27,
        body: "A contract change for any other client: without a cursor they now get only the first 1,000 entries, and nothing in the response says so but `next_cursor`.",
      },
      {
        path: "packages/cli/src/commands/audit-export.ts",
        side: "new",
        line: 18,
        body: "Where the repeated header comes from: each page's CSV starts with `HEADER` (line 25).",
      },
      {
        path: "test/audit/page.test.ts",
        side: "new",
        line: 22,
        body: "Pins the cursor as the bare row id, so a later change to an encoded cursor fails here before it breaks saved cursors.",
      },
    ],
    chunks: {
      ranked: [
        { id: "h4", path: "packages/cli/src/commands/audit-export.ts", level: "look", why: "CSV header written once per page" },
        { id: "h3", path: "src/routes/audit.ts", level: "look", why: "negative ?limit= becomes a 500" },
        { id: "h1", path: "src/audit/page.ts", level: "skim", why: "keyset query on the row id" },
        { id: "h5", path: "test/audit/page.test.ts", level: "skim", why: "pins the cursor format" },
      ],
      unread: [],
      total: 5,
    },
    guide: {
      steps: [
        {
          title: "Pages by row id",
          body: "`pageAuditLog` reads the range in id order, one page past the cursor at a time, and hands back the last row's id as the next cursor. The test walks 2,500 rows through it and pins the cursor's format.",
          check: "The last page comes back with no cursor.",
          hunks: [
            { id: "h1", path: "src/audit/page.ts" },
            { id: "h5", path: "test/audit/page.test.ts" },
          ],
        },
        {
          title: "The export route",
          body: "The route reads `?cursor=` and `?limit=`, refuses a cursor it didn't give out, and returns the page as it comes.",
          check: "Every bad `limit` gets a 400 or the default, never a 500.",
          hunks: [
            { id: "h2", path: "src/routes/audit.ts" },
            { id: "h3", path: "src/routes/audit.ts" },
          ],
        },
        {
          title: "The CLI follows pages",
          body: "`audit export` asks for pages until `next_cursor` is null and writes each as CSV.",
          check: "The output has one header row.",
          hunks: [{ id: "h4", path: "packages/cli/src/commands/audit-export.ts" }],
        },
      ],
    },
  },
};
