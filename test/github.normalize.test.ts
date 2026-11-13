import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { normalize, toHit, type RawCheck, type RawNode } from "../src/github/normalize.ts";

const fixture = (name: string): RawNode => JSON.parse(readFileSync(new URL(`./fixtures/github/${name}.json`, import.meta.url), "utf8"));
const NOW = "2026-03-03T00:00:00.000Z";

test("PR by someone else with a bot-added team request (review fragment)", () => {
  const it = normalize(fixture("pr-review"), NOW);
  assert.equal(it.id, "acme/widgets#412");
  assert.equal(it.node_id, "PR_synthetic_review_412");
  assert.equal(it.kind, "pr");
  assert.equal(it.repo, "acme/widgets");
  assert.equal(it.author, "maple");
  assert.equal(it.author_bot, false);
  assert.equal(it.state, "open");
  assert.equal(it.ci, "pending");
  assert.equal(it.review_decision, "required");
  assert.equal(it.mergeable, "unknown");
  assert.equal(it.base, "main");
  assert.deepEqual([it.additions, it.deletions, it.changed_files], [120, 30, 4]);
  assert.deepEqual(it.labels, ["enhancement"]);
  assert.equal(it.head_author, "maple");
  assert.equal(it.head_committed_at, "2026-03-02T08:00:00Z");
  assert.deepEqual(it.review_requests, [
    { reviewer: "platform-core", type: "team", codeowner: true },
    { reviewer: "octo-dev", type: "user", codeowner: false },
  ]);
  assert.equal(it.review_requests_hidden, undefined);
  // A bot asked to review (Copilot's) says so.
  const bot = { asCodeOwner: false, requestedReviewer: { __typename: "Bot", login: "copilot-pull-request-reviewer" } };
  const raw = fixture("pr-review");
  const withBot = normalize({ ...raw, reviewRequests: { nodes: [...(raw.reviewRequests?.nodes ?? []), bot] } }, NOW);
  assert.deepEqual(withBot.review_requests.at(-1), {
    reviewer: "copilot-pull-request-reviewer",
    type: "user",
    bot: true,
    codeowner: false,
  });
  assert.deepEqual(it.request_events, [
    { at: "2026-03-01T09:05:00Z", actor: "maple", actor_bot: false, reviewer: "octo-dev", reviewer_type: "user" },
    { at: "2026-03-01T10:00:00Z", actor: "triage-helper", actor_bot: true, reviewer: "platform-core", reviewer_type: "team" },
  ]);
  // latestReviews fills in cedar's verdict that fell out of reviews(last: 20); birch is deduped.
  assert.deepEqual(it.reviews, [
    // trusted: a collaborator on the repo (OWNER, MEMBER, COLLABORATOR); a CONTRIBUTOR isn't one.
    { author: "cedar", author_bot: false, trusted: false, state: "changes_requested", at: "2026-03-01T13:00:00Z", commit: "" },
    { author: "birch", author_bot: false, trusted: true, state: "approved", at: "2026-03-02T09:00:00Z", commit: "" },
    { author: "lint-buddy", author_bot: true, trusted: false, state: "commented", at: "2026-03-02T10:00:00Z", commit: "" },
  ]);
  assert.deepEqual(it.comments, [
    { author: "birch", author_bot: false, trusted: true, at: "2026-03-01T12:00:00Z" },
    { author: "legacy-ci[bot]", author_bot: true, trusted: false, at: "2026-03-02T11:00:00Z" },
  ]);
  assert.equal(it.comments_total, 4);
  assert.equal(it.threads_total, 2);
  assert.equal(it.threads_unresolved, 1);
  assert.deepEqual(it.thread_last, []);
  assert.equal(it.detail_at, NOW);
});

test("the description's first 600 characters, one paragraph a line, and a PR's changed paths", () => {
  const pr = normalize(fixture("pr-review"), NOW);
  assert.equal(pr.body?.length, 600);
  assert.ok(
    pr.body?.startsWith("Adds a resize observer to the widget grid.\n## Why\nThe list re-measured every row on resize. Measured on"),
  );
  assert.deepEqual(pr.paths, ["src/widgets/grid/resize.ts", "src/widgets/grid/list.ts", "test/widgets/grid.test.ts", "package.json"]);
  assert.deepEqual(normalize(fixture("pr-mine"), NOW).paths, ["deploy/release.yaml"]);
  const issue = normalize(fixture("issue"), NOW);
  assert.equal(issue.body, "Steps:\n1. Open the widget list\n2. Resize the window");
  assert.equal(issue.paths, undefined);
  // GitHub gives no files for some PRs: unknown, not none.
  const ghost = normalize(fixture("pr-ghost"), NOW);
  assert.equal(ghost.body, "");
  assert.equal("paths" in ghost, false);
});

test("requires comes from the PR's markdown body, past the 600-character cut; an issue has none", () => {
  const md = `${"Moves the usage reader to service accounts. ".repeat(23)}\n\nRequires https://github.com/getsentry/sentry/pull/129460`;
  assert.ok(md.indexOf("Requires") > 600);
  const pr = normalize({ ...fixture("pr-review"), body: md, bodyText: md }, NOW);
  assert.deepEqual(pr.requires, ["getsentry/sentry#129460"]);
  assert.ok(pr.body!.length <= 600);
  assert.deepEqual(normalize(fixture("pr-mine"), NOW).requires, [], "no body: nothing required, and not lacking it");
  const issue = normalize({ ...fixture("issue"), body: "Requires #1" }, NOW);
  assert.equal("requires" in issue, false);
});

test("your PR with red CI, a conflict and unresolved threads (mine fragment)", () => {
  const it = normalize(fixture("pr-mine"), NOW);
  assert.equal(it.id, "acme/infra#77");
  assert.equal(it.author, "octo-dev");
  assert.equal(it.draft, true);
  assert.equal(it.ci, "red");
  assert.equal(it.mergeable, "conflict");
  assert.equal(it.review_decision, "changes_requested");
  assert.equal(it.base, "release-2");
  assert.equal(it.default_branch, "main");
  assert.deepEqual(it.assignees, ["octo-dev"]);
  assert.equal(it.threads_total, 3);
  assert.equal(it.threads_unresolved, 2);
  const [a, b] = ["aaaa111122223333444455556666777788889999", "bbbb111122223333444455556666777788889999"];
  const last = (author: string, at: string, resolved: boolean, outdated: boolean, commit: string) => ({
    author,
    author_bot: false,
    trusted: true,
    at,
    resolved,
    outdated,
    commit,
  });
  assert.deepEqual(it.thread_last, [
    last("birch", "2026-03-01T16:00:00Z", false, true, a),
    last("octo-dev", "2026-03-01T17:00:00Z", true, false, b),
    last("octo-dev", "2026-03-02T17:00:00Z", false, false, b),
  ]);
  assert.equal(it.head_oid, b);
  assert.equal(it.head_author, "octo-dev");
  assert.deepEqual(it.commits, [
    { oid: a, at: "2026-03-01T12:00:00Z", author: "octo-dev" },
    { oid: b, at: "2026-03-02T17:30:00Z", author: "octo-dev" },
  ]);
  assert.equal("commits" in normalize(fixture("pr-review"), NOW), false, "only asked of your own PRs");
  assert.deepEqual(it.reviews, [
    { author: "birch", author_bot: false, trusted: true, state: "changes_requested", at: "2026-03-01T16:00:00Z", commit: "" },
  ]);
});

test("a bot's PR opened for a person says who, from its description's last via line, however long it is", () => {
  const raw = fixture("pr-review");
  const long = `${"Background. ".repeat(80)}\nIt goes via the queue.\n\nvia greg.pstrucha.\n\n--\nView Session`;
  const bot = { ...raw, author: { __typename: "Bot", login: "sentry-junior" }, bodyText: long };
  assert.equal(normalize(bot, NOW).via, "greg.pstrucha");
  assert.equal(normalize({ ...bot, bodyText: "Fixes it.\n\nvia @joseph-sentry." }, NOW).via, "@joseph-sentry");
  assert.equal(normalize({ ...bot, bodyText: "Fixes it.\nvia Michelle Tran." }, NOW).via, "Michelle Tran");
  assert.equal(normalize({ ...bot, bodyText: "Bumps lodash." }, NOW).via, "", "no via line");
  assert.equal(normalize({ ...raw, bodyText: long }, NOW).via, "", "only a bot's PR is opened for someone");
  assert.equal(normalize(raw, NOW).default_branch, "", "not asked of this one");
});

test("issue gets zero values for PR-only fields", () => {
  const it = normalize(fixture("issue"), NOW);
  assert.equal(it.id, "acme/widgets#500");
  assert.equal(it.kind, "issue");
  assert.equal(it.state, "open");
  assert.deepEqual(it.assignees, ["octo-dev", "maple"]);
  assert.equal(it.comments_total, 12);
  assert.deepEqual(
    it.comments.map((c) => [c.author, c.author_bot]),
    [
      ["maple", false],
      ["stale-keeper", true],
    ],
  );
  assert.deepEqual(
    { draft: it.draft, additions: it.additions, deletions: it.deletions, changed_files: it.changed_files, base: it.base },
    { draft: false, additions: 0, deletions: 0, changed_files: 0, base: "" },
  );
  assert.deepEqual(
    {
      ci: it.ci,
      review: it.review_decision,
      mergeable: it.mergeable,
      head_oid: it.head_oid,
      head_at: it.head_committed_at,
      head_author: it.head_author,
    },
    { ci: "none", review: "none", mergeable: "unknown", head_oid: "", head_at: null, head_author: "" },
  );
  assert.deepEqual([it.review_requests, it.request_events, it.reviews, it.thread_last], [[], [], [], []]);
  assert.deepEqual([it.threads_total, it.threads_unresolved], [0, 0]);
});

test("deleted accounts become ghost; null reviewers are dropped, but counted: someone was asked", () => {
  const it = normalize(fixture("pr-ghost"), NOW);
  assert.equal(it.review_requests_hidden, 1);
  assert.equal(it.author, "ghost");
  assert.equal(it.author_bot, false);
  assert.equal(it.state, "merged");
  assert.equal(it.review_decision, "none");
  assert.equal(it.ci, "none");
  assert.equal(it.head_author, "");
  assert.deepEqual(it.review_requests, []);
  assert.deepEqual(it.request_events, [
    { at: "2025-12-01T09:00:00Z", actor: "ghost", actor_bot: false, reviewer: "maple", reviewer_type: "user" },
  ]);
  assert.deepEqual(it.comments, [{ author: "ghost", author_bot: false, trusted: false, at: "2025-12-02T08:00:00Z" }]);
  // A pending review has no submittedAt; it falls back to createdAt.
  assert.deepEqual(it.reviews, [
    { author: "maple", author_bot: false, trusted: false, state: "pending", at: "2025-12-01T20:00:00Z", commit: "" },
    { author: "ghost", author_bot: false, trusted: false, state: "dismissed", at: "2025-12-02T09:00:00Z", commit: "" },
  ]);
});

test("CI rollup states map to green/red/pending/none", () => {
  const ci = (state: string | null) => {
    const n = fixture("pr-review");
    const head = n.commits?.nodes[0];
    assert.ok(head, "the fixture has a head commit");
    const commit = { ...head.commit, statusCheckRollup: state ? { state } : null };
    return normalize({ ...n, commits: { nodes: [{ commit }] } }, NOW).ci;
  };
  assert.deepEqual(
    [ci("SUCCESS"), ci("FAILURE"), ci("ERROR"), ci("PENDING"), ci("EXPECTED"), ci(null)],
    ["green", "red", "red", "pending", "pending", "none"],
  );
  assert.equal(normalize({ ...fixture("pr-review"), commits: { nodes: [] } }, NOW).ci, "none");
});

test("review decision and mergeable mappings", () => {
  const n = { ...fixture("pr-mine"), reviewDecision: "APPROVED", mergeable: "MERGEABLE" };
  assert.deepEqual([normalize(n, NOW).review_decision, normalize(n, NOW).mergeable], ["approved", "clean"]);
  assert.equal(normalize({ ...n, mergeable: "UNKNOWN" }, NOW).mergeable, "unknown");
  assert.equal(normalize({ ...n, state: "CLOSED" }, NOW).state, "closed");
});

test("your PR's repo's merge method, only when asked", () => {
  const n = fixture("pr-mine");
  assert.equal(normalize(n, NOW).merge_method, undefined);
  const method = (m: string) => normalize({ ...n, repository: { ...n.repository, viewerDefaultMergeMethod: m } }, NOW).merge_method;
  assert.equal(method("SQUASH"), "SQUASH");
  assert.equal(method("FAST_FORWARD"), undefined);
});

test("toHit builds the light search hit", () => {
  const hit = toHit({
    __typename: "Issue",
    id: "I_x",
    number: 3,
    updatedAt: "2026-01-01T00:00:00Z",
    repository: { nameWithOwner: "acme/widgets" },
    author: null,
  });
  assert.deepEqual(hit, {
    node_id: "I_x",
    id: "acme/widgets#3",
    kind: "issue",
    updated_at: "2026-01-01T00:00:00Z",
    author: "ghost",
    author_bot: false,
  });
});

test("your PR's head branch, where it lives, and the names of its failing checks", () => {
  const raw: RawNode = {
    ...fixture("pr-mine"),
    headRefName: "fix/retry",
    headRepository: { nameWithOwner: "octo-dev/infra" },
    checks: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [
                  { __typename: "CheckRun", name: "test (3.12)", conclusion: "TIMED_OUT" },
                  { __typename: "CheckRun", name: "lint", conclusion: "SUCCESS" },
                  { __typename: "CheckRun", name: "flaky", conclusion: "CANCELLED" },
                  { __typename: "StatusContext", context: "buildkite", state: "FAILURE" },
                  null,
                ],
              },
            },
          },
        },
      ],
    },
  };
  const it = normalize(raw, NOW);
  assert.deepEqual([it.head_ref, it.head_repo, it.checks_failed], ["fix/retry", "octo-dev/infra", ["test (3.12)", "buildkite"]]);
  // Someone else's PR isn't asked for checks, so it has no list rather than an empty one.
  assert.equal(normalize(fixture("pr-mine"), NOW).checks_failed, undefined);
  assert.equal(normalize({ ...fixture("pr-mine"), headRepository: null }, NOW).head_repo, "");
});

test("a PR's latest base change says the branch it was on before: by hand, or GitHub's when the PR below merged", () => {
  const moved = (nodes: object[]) => normalize({ ...fixture("pr-review"), baseChanges: { nodes } } as RawNode, NOW).retargeted;
  assert.deepEqual(moved([{ oldBase: "ref/sa-api", createdAt: "2026-10-30T20:51:11Z" }]), {
    from: "ref/sa-api",
    at: "2026-10-30T20:51:11Z",
  });
  assert.deepEqual(moved([{ previousRefName: "master", createdAt: "2026-10-23T21:33:03Z" }]), {
    from: "master",
    at: "2026-10-23T21:33:03Z",
  });
  assert.equal(moved([]), null);
  assert.equal(normalize(fixture("issue"), NOW).retargeted, undefined, "an issue has no base");
});

test("ready_at is the latest Ready for review, null if it never was a draft, absent when not asked", () => {
  const ready = (nodes: object[]) => normalize({ ...fixture("pr-review"), readied: { nodes } } as RawNode, NOW).ready_at;
  assert.equal(ready([{ createdAt: "2026-11-02T12:00:00Z" }]), "2026-11-02T12:00:00Z");
  assert.equal(ready([]), null);
  assert.equal(normalize(fixture("pr-review"), NOW).ready_at, undefined, "an answer from before the desk asked");
  assert.equal(normalize(fixture("issue"), NOW).ready_at, undefined, "an issue is never a draft");
});

test("a failing check the base branch doesn't require doesn't make CI red", () => {
  const withChecks = (state: string, nodes: RawCheck[]): RawNode => {
    const raw = fixture("pr-mine");
    const head = raw.commits!.nodes[0]!.commit;
    return {
      ...raw,
      commits: { nodes: [{ commit: { ...head, statusCheckRollup: { state } } }] },
      checks: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes } } } }] },
    };
  };
  const optional = {
    __typename: "CheckRun",
    name: "(Optional) schema diff",
    status: "COMPLETED",
    conclusion: "FAILURE",
    isRequired: false,
  };
  const backend = { __typename: "CheckRun", name: "backend", status: "COMPLETED", conclusion: "SUCCESS", isRequired: true };
  const only = normalize(withChecks("FAILURE", [optional, backend]), NOW);
  assert.deepEqual([only.ci, only.checks_failed, only.checks_optional], ["green", ["(Optional) schema diff"], ["(Optional) schema diff"]]);
  const running = normalize(withChecks("FAILURE", [optional, { ...backend, status: "IN_PROGRESS", conclusion: null }]), NOW);
  assert.equal(running.ci, "pending");
  const acceptance = { __typename: "StatusContext", context: "Acceptance", state: "FAILURE", isRequired: true };
  const both = normalize(withChecks("FAILURE", [optional, acceptance]), NOW);
  assert.deepEqual(
    [both.ci, both.checks_failed, both.checks_optional],
    ["red", ["(Optional) schema diff", "Acceptance"], ["(Optional) schema diff"]],
  );
  // A repo that requires nothing: every failure counts, as GitHub's rollup says.
  const none = normalize(withChecks("FAILURE", [{ ...optional, name: "test" }]), NOW);
  assert.deepEqual([none.ci, none.checks_optional], ["red", undefined]);
});
