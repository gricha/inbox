// A PR's checks in its review: read from GitHub one by one, only when a review is opened, kept until the desk next
// refreshes the PR, and listed with what's wrong first under one line that says where CI stands.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Effect } from "effect";
import { checksView } from "../src/checks.ts";
import { GitHubHttpError } from "../src/errors.ts";
import { createGitHub } from "../src/github/index.ts";
import { toChecks, type RawCheck } from "../src/github/normalize.ts";
import type { Check } from "../src/types.ts";
import { idle, reviewAsk, setup } from "./helpers/desk.ts";
import { NOW } from "./helpers/items.ts";
import { run } from "./helpers/run.ts";

const job = (name: string, conclusion: string | null, o: Partial<RawCheck> = {}): RawCheck => ({
  __typename: "CheckRun",
  name,
  status: conclusion ? "COMPLETED" : "IN_PROGRESS",
  conclusion,
  permalink: `https://github.com/acme/api/runs/${name.length}`,
  ...o,
});
const status = (context: string, state: string, o: Partial<RawCheck> = {}): RawCheck => ({
  __typename: "StatusContext",
  context,
  state,
  ...o,
});
const check = (name: string, state: Check["state"], optional = false): Check => ({ name, state, optional, url: "" });

test("a check's state is one of five words, cancelled apart from failing and skipped; only an https link is kept", () => {
  const got = toChecks([
    job("build", "SUCCESS"),
    job("test", "FAILURE"),
    job("slow", "TIMED_OUT"),
    job("e2e", null),
    job("queued", null, { status: "QUEUED" }),
    job("stopped", "CANCELLED"),
    job("docs", "SKIPPED"),
    job("advice", "NEUTRAL"),
    status("ci/external", "SUCCESS", { targetUrl: "https://ci.example/b/7" }),
    status("ci/broken", "ERROR", { targetUrl: "http://ci.example/b/8" }),
    status("ci/waiting", "PENDING", { targetUrl: "javascript:alert(1)" }),
    status("ci/expected", "EXPECTED", { targetUrl: "https://github.com@evil.example/x" }),
  ]);
  assert.deepEqual(
    got.map((c) => [c.name, c.state]),
    [
      ["build", "passing"],
      ["test", "failing"],
      ["slow", "failing"],
      ["e2e", "running"],
      ["queued", "running"],
      ["stopped", "cancelled"],
      ["docs", "skipped"],
      ["advice", "skipped"],
      ["ci/external", "passing"],
      ["ci/broken", "failing"],
      ["ci/waiting", "running"],
      ["ci/expected", "running"],
    ],
  );
  assert.equal(got[0]!.url, "https://github.com/acme/api/runs/5", "a check run's page on GitHub");
  assert.deepEqual(
    got.slice(8).map((c) => c.url),
    ["https://ci.example/b/7", "", "", ""],
    "a status points where its sender chose: https only, and never with a user in it",
  );
  assert.ok(
    got.every((c) => !c.optional),
    "a repo that requires no check has no optional ones",
  );
});

test("a check is optional only where the base branch requires others and not it", () => {
  const got = toChecks([job("backend", "SUCCESS", { isRequired: true }), job("schema diff", "FAILURE", { isRequired: false })]);
  assert.deepEqual(
    got.map((c) => c.optional),
    [false, true],
  );
});

test("the checks' one line says where CI stands, and the list has what's wrong first", () => {
  assert.equal(checksView([]), null, "nothing ran: no checks to show");
  const green = checksView([check("lint", "passing"), check("build", "passing"), check("deploy", "skipped")])!;
  assert.deepEqual([green.line, green.failing], ["CI passing · 3 checks", false]);
  assert.equal(checksView([check("build", "passing")])!.line, "CI passing · 1 check");

  const red = checksView([
    check("lint", "passing"),
    check("docs", "skipped"),
    check("e2e", "running"),
    check("unit (2/3)", "failing"),
    check("old run", "cancelled"),
    check("build", "passing"),
    check("api", "failing"),
  ])!;
  assert.deepEqual([red.line, red.failing], ["2 failing, 1 cancelled, 1 running of 7 checks", true]);
  assert.deepEqual(
    red.list.map((c) => `${c.name}: ${c.state}`),
    ["api: failing", "unit (2/3): failing", "old run: cancelled", "e2e: running", "build: passing", "lint: passing", "docs: skipped"],
  );

  assert.deepEqual(
    [checksView([check("e2e", "running"), check("build", "passing")])!.line, checksView([check("e2e", "running")])!.failing],
    ["1 running of 2 checks", false],
  );
  // What the base branch doesn't require doesn't hold the merge back: counted, said to be so, and not red.
  const optional = checksView([check("backend", "passing"), check("schema diff", "failing", true)])!;
  assert.deepEqual([optional.line, optional.failing], ["1 failing (not required) of 2 checks", false]);
  const both = checksView([check("backend", "failing"), check("schema diff", "failing", true)])!;
  assert.deepEqual([both.line, both.failing], ["2 failing of 2 checks", true]);
});

test("GitHub.checks: every check on the PR's head commit, a page of 100 at a time, in queries only", async () => {
  type Body = { query: string; variables: Record<string, unknown> };
  const calls: Body[] = [];
  const pages: Record<string, { next: string | null; nodes: (RawCheck | null)[] }> = {
    first: { next: "c100", nodes: [job("build", "SUCCESS", { isRequired: true }), null, status("ci/external", "PENDING")] },
    c100: { next: null, nodes: [job("test", "FAILURE", { isRequired: false })] },
  };
  const fake = ((_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Body;
    calls.push(body);
    const page = pages[(body.variables.after as string | null) ?? "first"]!;
    const contexts = { pageInfo: { hasNextPage: page.next !== null, endCursor: page.next }, nodes: page.nodes };
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: {
            rateLimit: { remaining: 4000, resetAt: "2099-01-01T00:00:00Z", cost: 1 },
            node: { commits: { nodes: [{ commit: { statusCheckRollup: { contexts } } }] } },
          },
        }),
      ),
    );
  }) as unknown as typeof fetch;
  const got = await run(createGitHub({ token: "t", fetch: fake }).checks("PR_1"));
  assert.deepEqual(
    got.map((c) => [c.name, c.state, c.optional]),
    [
      ["build", "passing", false],
      ["ci/external", "running", true],
      ["test", "failing", true],
    ],
  );
  assert.deepEqual(
    calls.map((c) => c.variables),
    [
      { id: "PR_1", after: null },
      { id: "PR_1", after: "c100" },
    ],
  );
  for (const c of calls) {
    assert.match(c.query, /^query\(\$id: ID!, \$after: String\)/);
    assert.doesNotMatch(c.query, /mutation/);
  }

  // A commit nothing ran on has no rollup: no checks, not an error.
  const none = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: {
            rateLimit: { remaining: 4000, resetAt: "2099-01-01T00:00:00Z", cost: 1 },
            node: { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } },
          },
        }),
      ),
    )) as unknown as typeof fetch;
  assert.deepEqual(await run(createGitHub({ token: "t", fetch: none }).checks("PR_2")), []);
});

test("a review carries its PR's checks: asked of GitHub when it's opened, never by a sync, and kept until the desk refreshes the PR", async (c) => {
  const t = await setup([reviewAsk(4, { ci: "red" })], { settings: { "policy.judge": false, "review.auto_ai": false } });
  c.after(t.cleanup);
  t.gh.checkLists.set("PR_acme/api_4", [check("build", "passing"), check("e2e", "running"), check("unit", "failing")]);
  await run(t.desk.sync());
  await idle(t.desk);
  while (t.desk.warming) await sleep(1);
  assert.deepEqual(t.gh.checkCalls, [], "a sync, and the reviews it fetches ahead, ask for no checks");

  const v = await run(t.desk.reviewView("api#4", true));
  assert.deepEqual([v.checks?.line, v.checks?.failing, v.checks_error], ["1 failing, 1 running of 3 checks", true, null]);
  assert.deepEqual(
    v.checks?.list.map((x) => x.name),
    ["unit", "e2e", "build"],
  );
  await Promise.all([run(t.desk.reviewView("api#4")), run(t.desk.reviewView("api#4", true))]);
  assert.deepEqual(t.gh.checkCalls, ["PR_acme/api_4"], "kept: opening it again asks nothing");

  // A sync that leaves the PR as it was keeps them; one that reads the PR again (here: 30 minutes on) has the next open ask.
  t.setNow(new Date(NOW.getTime() + 60_000));
  await run(t.desk.sync());
  await run(t.desk.reviewView("api#4", true));
  assert.equal(t.gh.checkCalls.length, 1);
  t.gh.checkLists.set("PR_acme/api_4", [check("build", "passing"), check("e2e", "passing"), check("unit", "passing")]);
  t.setNow(new Date(NOW.getTime() + 31 * 60_000));
  await run(t.desk.sync());
  assert.equal(t.gh.checkCalls.length, 1, "the sync itself still asks for none");
  assert.equal((await run(t.desk.reviewView("api#4", true))).checks?.line, "CI passing · 3 checks");
  assert.equal(t.gh.checkCalls.length, 2);
});

test("checks GitHub won't give are the review's checks_error, in its words, and asked for again next time; none is no part at all", async (c) => {
  const t = await setup([reviewAsk(4), reviewAsk(5, { ci: "none" })], { settings: { "policy.judge": false, "review.auto_ai": false } });
  c.after(t.cleanup);
  await run(t.desk.sync());
  const checks = t.gh.checks.bind(t.gh);
  t.gh.checks = () => Effect.fail(new GitHubHttpError({ status: 502, message: "GitHub HTTP 502: bad gateway" }));
  const failed = await run(t.desk.reviewView("api#4", true));
  assert.deepEqual([failed.checks, failed.checks_error], [null, "GitHub HTTP 502: bad gateway"]);
  assert.equal(failed.card.id, "acme/api#4", "the rest of the review still comes");
  t.gh.checks = checks;
  t.gh.checkLists.set("PR_acme/api_4", [check("build", "passing")]);
  const again = await run(t.desk.reviewView("api#4", true));
  assert.deepEqual([again.checks?.line, again.checks_error], ["CI passing · 1 check", null], "the failure wasn't kept");
  const none = await run(t.desk.reviewView("api#5", true));
  assert.deepEqual([none.checks, none.checks_error], [null, null]);
});
