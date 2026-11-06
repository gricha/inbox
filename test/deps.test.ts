import assert from "node:assert/strict";
import { test } from "node:test";
import { requiresOf } from "../src/deps.ts";

test("requiresOf reads Requires, Depends on, Stacked on, Builds on, Blocked by and Merge after, with URLs, owner/repo#n and #n", () => {
  const cases: [string, string, string[]][] = [
    // Past the 600 characters the desk keeps of a body.
    [
      `${"x ".repeat(500)}\n\nRequires https://github.com/getsentry/sentry/pull/129460`,
      "getsentry/getsentry#22982",
      ["getsentry/sentry#129460"],
    ],
    ["Stacked on [Seer reader #8941](https://github.com/getsentry/seer/pull/8941).", "getsentry/sentry#128111", ["getsentry/seer#8941"]],
    [
      "Builds on the Sentry reader ([getsentry/sentry#128080](https://github.com/getsentry/sentry/pull/128080)).",
      "getsentry/getsentry#22613",
      ["getsentry/sentry#128080"],
    ],
    ["Depends on #549.", "getsentry/warden#548", ["getsentry/warden#549"]],
    ["Stacked on the cleanup PR (#128112).", "getsentry/sentry#128628", ["getsentry/sentry#128112"]],
    ["Merge this after getsentry/sentry#1 and getsentry/sentry#2", "getsentry/getsentry#5", ["getsentry/sentry#1", "getsentry/sentry#2"]],
    ["Stacked on top of #12", "acme/api#13", ["acme/api#12"]],
    ["Blocked by https://github.com/acme/api/pull/7/files", "acme/web#3", ["acme/api#7"]],
    ["**Merge after** getsentry/seer#9396", "getsentry/sentry#1", ["getsentry/seer#9396"]],
    [
      "merge blocked on:\n- [ ] https://github.com/getsentry/sentry/pull/101\n- [x] https://github.com/getsentry/sentry/pull/102\n- [ ] getsentry/seer#7\n\nOther text #9",
      "getsentry/getsentry#5",
      ["getsentry/sentry#101", "getsentry/seer#7"],
    ],
    ["**Blocked on:**\r\n\r\n- [ ] #5\r\n* #6", "acme/api#9", ["acme/api#5", "acme/api#6"]],
    ["_Depends on_ #44", "acme/api#9", ["acme/api#44"]],
    ["Requires getsentry/sentry_plugins#12", "getsentry/sentry#1", ["getsentry/sentry_plugins#12"]],
    ["Requires GetSentry/Sentry#129460 and getsentry/sentry#129460", "getsentry/getsentry#1", ["GetSentry/Sentry#129460"]],
  ];
  for (const [md, id, want] of cases) {
    const [repo, n] = id.split("#");
    assert.deepEqual(requiresOf(md, repo!, Number(n)), want, md.slice(-60));
  }
});

test("requiresOf ignores what isn't a merge order", () => {
  const none = [
    "This needs a user since #129442 changed the auth path",
    "Follow-up to #9327",
    "Fixes #12",
    "Relands #100",
    "Merge this before getsentry/sentry#130197",
    "Deploy after [Sentry writer #128111](https://github.com/getsentry/sentry/pull/128111)",
    "us and de pick them up once getsentry/ops#24632 lands",
    "`requires #12`",
    "```\nRequires #12\n```",
    "> Requires #12",
    "<!-- Requires #12 -->",
    "Bumps x.\n<details><summary>Release notes</summary>\nRequires #5\n</details>",
    "**Stack** (each PR is based on the one above it):\n1. #128982 first\n2. #128983 second",
    "requires_user #5 is set",
    "Stacked on the request.user stack",
  ];
  for (const md of none) assert.deepEqual(requiresOf(md, "getsentry/sentry", 1), [], md);
  assert.deepEqual(requiresOf("Requires #22982", "getsentry/getsentry", 22982), [], "the PR itself");
});

test("requiresOf reads a 100,000-character body built to make a regex backtrack in linear time", () => {
  const n = 100_000;
  const bodies = [
    `Requires #1${" ".repeat(n)}x`,
    `Blocked on:\n- https://github.com/a/b/pull/${"1".repeat(n)}x y`,
    `a${"_".repeat(n)}b`,
    "<details".repeat(n / 8),
    "<!--".repeat(n / 4),
    "```".repeat(n / 3),
    `[a](https://github.com/${"x/pull/1".repeat(n / 8)} `,
    `Stacked on ${`${"x".repeat(n / 4)} `.repeat(4)}`,
    `Requires ${"#1 ".repeat(n / 3)}`,
  ];
  for (const md of bodies) {
    const t = performance.now();
    requiresOf(md, "acme/api", 9);
    // Each takes a few ms; the quadratic patterns these replace took 9 to 14 s.
    assert.ok(performance.now() - t < 1000, md.slice(0, 40));
  }
});
