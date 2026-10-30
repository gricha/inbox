import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { normalize, toHit, type RawNode } from "../src/github/normalize.ts";

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

test("your PR with red CI, a conflict and unresolved threads (mine fragment)", () => {
  const it = normalize(fixture("pr-mine"), NOW);
  assert.equal(it.id, "acme/infra#77");
  assert.equal(it.author, "octo-dev");
  assert.equal(it.draft, true);
  assert.equal(it.ci, "red");
  assert.equal(it.mergeable, "conflict");
  assert.equal(it.review_decision, "changes_requested");
  assert.equal(it.base, "release-2");
  assert.deepEqual(it.assignees, ["octo-dev"]);
  assert.equal(it.threads_total, 3);
  assert.equal(it.threads_unresolved, 2);
  assert.deepEqual(it.thread_last, [
    { author: "birch", author_bot: false, trusted: true, at: "2026-03-01T16:00:00Z" },
    { author: "octo-dev", author_bot: false, trusted: true, at: "2026-03-01T17:00:00Z" },
    { author: "octo-dev", author_bot: false, trusted: true, at: "2026-03-02T17:00:00Z" },
  ]);
  assert.equal(it.head_oid, "bbbb111122223333444455556666777788889999");
  assert.equal(it.head_author, "octo-dev");
  assert.deepEqual(it.reviews, [
    { author: "birch", author_bot: false, trusted: true, state: "changes_requested", at: "2026-03-01T16:00:00Z", commit: "" },
  ]);
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

test("deleted accounts become ghost; null reviewers are dropped", () => {
  const it = normalize(fixture("pr-ghost"), NOW);
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
    head.commit.statusCheckRollup = state ? { state } : null;
    return normalize(n, NOW).ci;
  };
  assert.deepEqual(
    [ci("SUCCESS"), ci("FAILURE"), ci("ERROR"), ci("PENDING"), ci("EXPECTED"), ci(null)],
    ["green", "red", "red", "pending", "pending", "none"],
  );
  const noCommits = fixture("pr-review");
  noCommits.commits = { nodes: [] };
  assert.equal(normalize(noCommits, NOW).ci, "none");
});

test("review decision and mergeable mappings", () => {
  const n = fixture("pr-mine");
  n.reviewDecision = "APPROVED";
  n.mergeable = "MERGEABLE";
  assert.deepEqual([normalize(n, NOW).review_decision, normalize(n, NOW).mergeable], ["approved", "clean"]);
  n.mergeable = "UNKNOWN";
  assert.equal(normalize(n, NOW).mergeable, "unknown");
  n.state = "CLOSED";
  assert.equal(normalize(n, NOW).state, "closed");
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
