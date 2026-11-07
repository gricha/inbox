import assert from "node:assert/strict";
import { test } from "node:test";
import { blockedOrder, dependencies, requiresOf } from "../src/deps.ts";
import { buildStacks } from "../src/stacks.ts";
import type { Card, Item } from "../src/types.ts";
import { hoursAgo, makeItem } from "./helpers/items.ts";

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

const deps = (items: Item[]) => dependencies(items, buildStacks(items));
const pr = (id: string, o: Partial<Item> = {}) => {
  const [repo, n] = id.split("#");
  return makeItem({ repo, number: Number(n), ...o });
};

test("the live example: getsentry#22982 requires sentry#129460, open, so it's blocked by it; once it merges, it isn't", () => {
  const root = pr("getsentry/sentry#129460");
  const it = pr("getsentry/getsentry#22982", { requires: ["getsentry/sentry#129460"] });
  const f = deps([root, it]);
  assert.deepEqual(f.get(it.id)?.open, ["sentry#129460"]);
  assert.equal(f.get(it.id)?.root, "getsentry/sentry#129460");
  assert.equal(f.get(it.id)?.through, null);
  assert.deepEqual(f.get(root.id)?.blocks, ["getsentry#22982"]);
  assert.equal(f.get(root.id)?.root, null);

  const merged = deps([{ ...root, state: "merged", closed_at: hoursAgo(1) }, it]);
  const g = merged.get(it.id)!;
  assert.equal(g.root, null);
  assert.deepEqual(g.open, []);
  assert.deepEqual(g.merged, [{ ref: "sentry#129460", at: hoursAgo(1) }]);
  assert.deepEqual(g.requires, ["sentry#129460"]);
  assert.equal(merged.has(root.id), false, "only open PRs get facts");
});

test("ids keep their case: requires 'GetSentry/Sentry#129460' finds getsentry/sentry#129460, and the map, root and blocks use its item.id", () => {
  const root = pr("getsentry/sentry#129460");
  const it = pr("getsentry/getsentry#22982", { requires: ["GetSentry/Sentry#129460", "getsentry/sentry#129460"] });
  const f = deps([root, it]);
  assert.deepEqual([...f.keys()], ["getsentry/sentry#129460", "getsentry/getsentry#22982"]);
  assert.equal(f.get(it.id)?.root, "getsentry/sentry#129460");
  assert.deepEqual(f.get(it.id)?.requires, ["sentry#129460"], "one need, as the desk names it");
  assert.deepEqual(f.get(root.id)?.blocks, ["getsentry#22982"]);
});

test("transitive: A requires api#2, api#2 is stacked on open api#3, so A's root is api#3 through api#2", () => {
  const a = pr("acme/web#1", { requires: ["acme/api#2"] });
  const two = pr("acme/api#2", { head_ref: "b2", base: "b3" });
  const three = pr("acme/api#3", { head_ref: "b3" });
  const f = deps([a, two, three]);
  assert.equal(f.get(a.id)?.root, "acme/api#3");
  assert.equal(f.get(a.id)?.through, "api#2");
  assert.deepEqual(f.get(a.id)?.open, ["api#2"]);
  assert.deepEqual(f.get(two.id)?.requires, ["api#3"], "its stack parent");
  assert.equal(f.get(two.id)?.root, "acme/api#3");
  assert.equal(f.get(two.id)?.through, null);
  assert.deepEqual(f.get(three.id)?.blocks, ["web#1", "api#2"]);
  assert.deepEqual(f.get(two.id)?.blocks, ["web#1"]);
});

test("a loop blocks nobody in it; a PR that needs the loop is blocked by the first one it reaches", () => {
  const a = pr("acme/api#1", { requires: ["acme/api#2"] });
  const b = pr("acme/api#2", { requires: ["acme/api#1"] });
  const x = pr("acme/api#9", { requires: ["acme/api#1"] });
  const f = deps([a, b, x]);
  assert.equal(f.get(a.id)?.root, null);
  assert.equal(f.get(b.id)?.root, null);
  assert.deepEqual(f.get(a.id)?.open, [], "the edge that closes the loop is left out");
  assert.deepEqual(f.get(a.id)?.requires, ["api#2"]);
  assert.equal(f.get(x.id)?.root, "acme/api#1");
  assert.deepEqual(f.get(a.id)?.blocks, ["api#9"]);
  assert.deepEqual(f.get(b.id)?.blocks, []);
});

test("closed without merging doesn't block: closed names it", () => {
  const dep = pr("acme/api#1", { state: "closed", closed_at: hoursAgo(3) });
  const it = pr("acme/api#2", { requires: ["acme/api#1"] });
  const f = deps([dep, it]).get(it.id)!;
  assert.equal(f.root, null);
  assert.deepEqual(f.closed, ["api#1"]);
  assert.deepEqual(f.open, []);
  assert.deepEqual(f.merged, []);
});

test("refs the desk doesn't hold, and issues, don't block", () => {
  const issue = pr("acme/api#5", { kind: "issue" });
  const it = pr("acme/api#2", { requires: ["acme/api#5", "Acme/Other#7"] });
  const f = deps([issue, it]).get(it.id)!;
  assert.equal(f.root, null);
  assert.deepEqual(f.requires, ["api#5", "Other#7"]);
  assert.deepEqual(f.open, []);
});

test("another org's PR never blocks, held or not: requires names it in full", () => {
  const theirs = pr("evilcorp/sentry#5");
  const it = pr("getsentry/sentry#9", { requires: ["evilcorp/sentry#5", "GetSentry/Seer#3"] });
  const f = deps([theirs, it, pr("getsentry/seer#3")]).get(it.id)!;
  assert.deepEqual([f.requires, f.open, f.root], [["evilcorp/sentry#5", "seer#3"], ["seer#3"], "getsentry/seer#3"]);
  assert.deepEqual(deps([theirs]).get(theirs.id)?.blocks, []);
});

test("a PR stacked on an open PR is blocked by it, with no description", () => {
  const below = pr("acme/api#1", { head_ref: "b1" });
  const it = pr("acme/api#2", { head_ref: "b2", base: "b1" });
  const f = deps([below, it]);
  assert.equal(f.get(it.id)?.root, "acme/api#1");
  assert.deepEqual(f.get(it.id)?.open, ["api#1"]);
  assert.deepEqual(f.get(below.id)?.blocks, ["api#2"]);
});

const WAITS = "waits on your reply to markstory, then a review from cvxluo, skaasten and 6 more";
const row = (id: string, why: string, since: number, blocker?: string): Card =>
  ({ id, why, waiting_since: hoursAgo(since), ...(blocker && { blocker: { id: blocker, ref: "sentry#129460", waits: WAITS } }) }) as Card;
const FULL = `blocked by sentry#129460, which ${WAITS}`;
const ROOT = "getsentry/sentry#129460";

test("blockedOrder: a chain's rows together, the PR blocking them first, chains by their longest wait; the chain says once what its blocker waits on", () => {
  const cards = [
    row("getsentry/getsentry#22983", FULL, 30, ROOT),
    row("acme/web#1", "waits on a review from dana", 20),
    row("getsentry/getsentry#22984", FULL, 10, ROOT),
    row("getsentry/getsentry#22982", FULL, 50, ROOT),
    row("getsentry/getsentry#22990", `in Merging \u00b7 ${FULL}`, 40, ROOT),
    row("acme/web#7", "blocked by api#4, which waits on CI", 60, "acme/api#4"),
    row("acme/web#8", "approved by hand", 5, ROOT),
  ];
  const got = blockedOrder(cards);
  assert.deepEqual(
    got.map((c) => [c.id, c.why]),
    [
      ["acme/web#7", "blocked by api#4, which waits on CI"],
      ["getsentry/getsentry#22982", FULL],
      ["getsentry/getsentry#22990", "in Merging \u00b7 blocked by sentry#129460"],
      ["getsentry/getsentry#22983", "blocked by sentry#129460"],
      ["getsentry/getsentry#22984", "blocked by sentry#129460"],
      ["acme/web#8", "approved by hand"],
      ["acme/web#1", "waits on a review from dana"],
    ],
  );
  assert.equal(cards[2]!.why, FULL, "the cards it was given are left as they were");

  const withRoot = blockedOrder([...cards.slice(0, 3), row(ROOT, "waits on your reply to markstory", 1)]);
  assert.deepEqual(
    withRoot.map((c) => [c.id, c.why]),
    [
      [ROOT, "waits on your reply to markstory"],
      ["getsentry/getsentry#22983", "blocked by sentry#129460"],
      ["getsentry/getsentry#22984", "blocked by sentry#129460"],
      ["acme/web#1", "waits on a review from dana"],
    ],
  );
});
