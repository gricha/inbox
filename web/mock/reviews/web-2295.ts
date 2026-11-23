// acme/web#2295: its diff and AI review for the website's demo.
import type { Canned } from "../diffs.ts";
import { file } from "../patch.ts";

export const review: Canned = {
  files: [
    file(
      "src/format/date.test.ts",
      "modified",
      `@@ -1,5 +1,12 @@
-import { describe, expect, it } from "vitest";
+import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
 import { formatDay, relativeDay } from "./date.ts";
+
+// A fixed clock: "an hour ago" was yesterday whenever the suite ran in the hour after midnight.
+beforeEach(() => {
+  vi.useFakeTimers();
+  vi.setSystemTime(new Date("2026-03-10T02:00:00Z"));
+});
+afterEach(() => vi.useRealTimers());

 describe("relativeDay", () => {
   it("says today for a time earlier today", () => {
@@ -21,7 +28,6 @@ describe("relativeDay", () => {

 describe("formatDay", () => {
   it("writes the day and the short month", () => {
-    const now = new Date();
-    expect(formatDay(now)).toBe(now.toLocaleDateString("en-GB", { day: "numeric", month: "short" }));
+    expect(formatDay(new Date())).toBe("10 Mar");
   });
 });`,
    ),
  ],
  ai: {
    verdict: "skim",
    risk: "low",
    summary:
      "Pins the date tests to a fixed clock with Vitest's fake timers, so `relativeDay`'s \"an hour ago is today\" case no longer fails when the suite runs just after midnight. `formatDay`'s test now checks a literal date instead of comparing against `toLocaleDateString`, which only restated the implementation.",
    concerns: [
      "The expected \"10 Mar\" assumes the runner's time zone is UTC. `formatDay` renders in local time, and 02:00 UTC on 10 March is still 9 March anywhere west of UTC−2, so the test fails on such a runner, as test (20.x) does on this PR. Pin the zone (`TZ=UTC` in the Vitest config's `env`) or move the clock to midday UTC, which is 10 March in every zone from UTC−11 to UTC+11.",
    ],
    notes: [
      {
        path: "src/format/date.test.ts",
        side: "new",
        line: 7,
        body: 'Applies to every test in the file, so `relativeDay` runs at 02:00 UTC as well. A midday clock would keep both its "an hour earlier" and `formatDay`\'s date on 10 March in nearly every zone.',
      },
      {
        path: "src/format/date.test.ts",
        side: "new",
        line: 31,
        body: "The line test (20.x) fails on: the date in the runner's zone, not UTC's.",
      },
    ],
    chunks: {
      ranked: [
        { id: "h2", path: "src/format/date.test.ts", level: "look", why: "expected date assumes UTC" },
        { id: "h1", path: "src/format/date.test.ts", level: "skim", why: "fake timers for the whole file" },
      ],
      unread: [],
      total: 2,
    },
    guide: {
      steps: [
        {
          title: "A fixed clock",
          body: "Every test in the file now runs at 02:00 UTC on 10 March, with real timers restored after each.",
          check: "",
          hunks: [{ id: "h1", path: "src/format/date.test.ts" }],
        },
        {
          title: "The date it expects",
          body: "`formatDay`'s test compares against a literal date rather than `toLocaleDateString`.",
          check: "The literal holds on a runner outside UTC.",
          hunks: [{ id: "h2", path: "src/format/date.test.ts" }],
        },
      ],
    },
  },
};
