import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient as createDeskClient } from "../src/client.ts";
import { createClient } from "../src/github/client.ts";
import { ALLOWED, createWriter } from "../src/github/write.ts";

function fakeFetch(reply: { status?: number; body: unknown }) {
  const calls: { body: string; headers: Record<string, string> }[] = [];
  const fn: typeof fetch = (_url, init) => {
    calls.push({ body: init?.body as string, headers: init?.headers as Record<string, string> });
    return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 }));
  };
  return { fetch: fn, calls };
}

test("the allowlist is exactly these mutations: approve, a reply or comment, one on a line, ready for review with its reviewers, and the More menu's", () => {
  assert.deepEqual(Object.keys(ALLOWED), [
    "approve",
    "reply",
    "comment",
    "inline_comment",
    "ready",
    "request_reviews",
    "close",
    "draft",
    "merge",
    "reopen",
    "request_changes",
    "close_issue",
  ]);
  assert.match(
    ALLOWED.approve,
    /addPullRequestReview\(input: \{ pullRequestId: \$pr, commitOID: \$commit, event: APPROVE, body: \$body \}\)/,
  );
  assert.match(
    ALLOWED.reply,
    /^mutation DeskReply[^{]*\{\s*addPullRequestReviewThreadReply\(input: \{ pullRequestReviewThreadId: \$thread/,
  );
  assert.match(ALLOWED.comment, /^mutation DeskComment[^{]*\{\s*addComment\(input: \{ subjectId: \$subject, body: \$body \}\)/);
  assert.match(
    ALLOWED.inline_comment,
    /^mutation DeskInlineComment[^{]*\{\s*addPullRequestReview\(input: \{ pullRequestId: \$pr, commitOID: \$commit, event: COMMENT, threads: \[\$thread\] \}\)/,
  );
  assert.match(ALLOWED.ready, /^mutation DeskReady[^{]*\{\s*markPullRequestReadyForReview\(input: \{ pullRequestId: \$pr \}\)/);
  assert.match(
    ALLOWED.request_reviews,
    /^mutation DeskRequestReviews[^{]*\{\s*requestReviews\(input: \{ pullRequestId: \$pr, userIds: \$users, teamIds: \$teams, union: true \}\)/,
  );
  assert.match(ALLOWED.close, /^mutation DeskClose[^{]*\{\s*closePullRequest\(input: \{ pullRequestId: \$pr \}\)/);
  assert.match(ALLOWED.draft, /^mutation DeskDraft[^{]*\{\s*convertPullRequestToDraft\(input: \{ pullRequestId: \$pr \}\)/);
  assert.match(
    ALLOWED.merge,
    /^mutation DeskMerge[^{]*\{\s*mergePullRequest\(input: \{ pullRequestId: \$pr, expectedHeadOid: \$head, mergeMethod: \$method \}\)/,
  );
  assert.match(ALLOWED.reopen, /^mutation DeskReopen[^{]*\{\s*reopenPullRequest\(input: \{ pullRequestId: \$pr \}\)/);
  assert.match(ALLOWED.request_changes, /commitOID: \$commit, event: REQUEST_CHANGES, body: \$body \}\)/);
  assert.match(ALLOWED.close_issue, /^mutation DeskCloseIssue[^{]*\{\s*closeIssue\(input: \{ issueId: \$issue \}\)/);
  // One mutation per document: nothing else rides along.
  for (const doc of Object.values(ALLOWED)) assert.equal(doc.match(/\(input:/g)?.length, 1);
});

test("a reply and a comment send their mutation once and log it", async () => {
  const f = fakeFetch({ body: { data: { addPullRequestReviewThreadReply: { comment: { url: "https://github.com/a/b/pull/1#c1" } } } } });
  const logs: string[] = [];
  const w = createWriter({
    token: "t",
    fetch: f.fetch,
    log: (m) => {
      logs.push(m);
    },
  });
  assert.deepEqual(await w.reply("PRRT_1", "Fixed in abc"), { url: "https://github.com/a/b/pull/1#c1" });
  const sent = JSON.parse(f.calls[0]!.body) as { query: string; variables: unknown };
  assert.equal(sent.query, ALLOWED.reply);
  assert.deepEqual(sent.variables, { thread: "PRRT_1", body: "Fixed in abc" });
  const g = fakeFetch({ body: { data: { addComment: { commentEdge: { node: { url: "https://github.com/a/b/pull/1#c2" } } } } } });
  assert.deepEqual(await createWriter({ token: "t", fetch: g.fetch }).comment("PR_1", "Thanks"), {
    url: "https://github.com/a/b/pull/1#c2",
  });
  assert.equal((JSON.parse(g.calls[0]!.body) as { query: string }).query, ALLOWED.comment);
  assert.deepEqual(logs, ["github write: reply PRRT_1"]);
});

test("an inline comment is one COMMENT review with one thread, pinned to the commit, answering with the comment's link", async () => {
  const url = "https://github.com/a/b/pull/1#discussion_r5";
  const f = fakeFetch({
    body: {
      data: {
        addPullRequestReview: {
          pullRequestReview: { url: "https://github.com/a/b/pull/1#pullrequestreview-1", comments: { nodes: [{ url }] } },
        },
      },
    },
  });
  const logs: string[] = [];
  const w = createWriter({
    token: "t",
    fetch: f.fetch,
    log: (m) => {
      logs.push(m);
    },
  });
  const thread = { path: "src/a.ts", line: 9, side: "RIGHT" as const, startLine: 7, startSide: "RIGHT" as const, body: "Nit" };
  assert.deepEqual(await w.inlineComment("PR_1", "abc", thread), { url });
  assert.equal(f.calls.length, 1);
  const sent = JSON.parse(f.calls[0]!.body) as { query: string; variables: unknown };
  assert.equal(sent.query, ALLOWED.inline_comment);
  assert.deepEqual(sent.variables, { pr: "PR_1", commit: "abc", thread });
  assert.deepEqual(logs, ["github write: inline_comment PR_1 at abc"]);
  const empty = fakeFetch({ body: { data: { addPullRequestReview: null } } });
  await assert.rejects(
    createWriter({ token: "t", fetch: empty.fetch }).inlineComment("PR_1", "abc", thread),
    /answered without the comment/,
  );
});

test("ready sends its mutation once and logs it", async () => {
  const f = fakeFetch({ body: { data: {} } });
  const logs: string[] = [];
  const w = createWriter({
    token: "t",
    fetch: f.fetch,
    log: (m) => {
      logs.push(m);
    },
  });
  await w.ready("PR_1");
  const sent = f.calls.map((c) => JSON.parse(c.body) as { query: string; variables: unknown });
  assert.deepEqual(
    sent.map((x) => [x.query, x.variables]),
    [[ALLOWED.ready, { pr: "PR_1" }]],
  );
  assert.deepEqual(logs, ["github write: ready PR_1"]);
});

test("approve sends the allowlisted mutation once, pinned to the commit, with its own token, and logs it", async () => {
  const f = fakeFetch({ body: { data: { addPullRequestReview: { pullRequestReview: { url: "https://github.com/a/b/pull/1#r1" } } } } });
  const logs: string[] = [];
  const w = createWriter({
    token: "t0k",
    fetch: f.fetch,
    log: (m) => {
      logs.push(m);
    },
  });
  assert.deepEqual(await w.approve("PR_node", "abc123", "LGTM"), { url: "https://github.com/a/b/pull/1#r1" });
  assert.equal(f.calls.length, 1);
  const sent = JSON.parse(f.calls[0]!.body) as { query: string; variables: unknown };
  assert.equal(sent.query, ALLOWED.approve);
  assert.deepEqual(sent.variables, { pr: "PR_node", commit: "abc123", body: "LGTM" });
  assert.equal(f.calls[0]!.headers.authorization, "bearer t0k");
  assert.deepEqual(logs, ["github write: approve PR_node at abc123"]);
});

test("the More menu's writes send their mutation once each, a merge pinned to its head, and log it", async () => {
  const f = fakeFetch({ body: { data: { addPullRequestReview: { pullRequestReview: { url: "https://github.com/a/b/pull/1#r2" } } } } });
  const logs: string[] = [];
  const w = createWriter({
    token: "t",
    fetch: f.fetch,
    log: (m) => {
      logs.push(m);
    },
  });
  await w.close("PR_1");
  await w.draft("PR_1");
  await w.merge("PR_1", "h1", "SQUASH");
  await w.reopen("PR_1");
  assert.deepEqual(await w.requestChanges("PR_1", "h1", "Add a test"), { url: "https://github.com/a/b/pull/1#r2" });
  await w.closeIssue("I_1");
  const sent = f.calls.map((c) => JSON.parse(c.body) as { query: string; variables: unknown });
  assert.deepEqual(
    sent.map((x) => [x.query, x.variables]),
    [
      [ALLOWED.close, { pr: "PR_1" }],
      [ALLOWED.draft, { pr: "PR_1" }],
      [ALLOWED.merge, { pr: "PR_1", head: "h1", method: "SQUASH" }],
      [ALLOWED.reopen, { pr: "PR_1" }],
      [ALLOWED.request_changes, { pr: "PR_1", commit: "h1", body: "Add a test" }],
      [ALLOWED.close_issue, { issue: "I_1" }],
    ],
  );
  assert.deepEqual(logs, [
    "github write: close PR_1",
    "github write: draft PR_1",
    "github write: merge PR_1 at h1",
    "github write: reopen PR_1",
    "github write: request_changes PR_1 at h1",
    "github write: close_issue I_1",
  ]);
});

test("GitHub's errors come back as errors, and nothing is retried", async () => {
  const gql = fakeFetch({ body: { errors: [{ message: "Can not approve your own pull request" }] } });
  await assert.rejects(createWriter({ token: "t", fetch: gql.fetch }).approve("PR_x", "c"), /Can not approve your own pull request/);
  const down = fakeFetch({ status: 502, body: { message: "bad gateway" } });
  await assert.rejects(createWriter({ token: "t", fetch: down.fetch }).approve("PR_x", "c"), /HTTP 502/);
  assert.equal(down.calls.length, 1);
});

test("the read client still refuses mutations, and neither the CLI's nor MCP's client can write to GitHub", async () => {
  const f = fakeFetch({ body: { data: {} } });
  for (const doc of Object.values(ALLOWED)) await assert.rejects(createClient({ token: "t", fetch: f.fetch }).query(doc), /read-only/);
  assert.equal(f.calls.length, 0);
  const api = createDeskClient(() => new Response("{}"));
  assert.ok(!Object.keys(api).some((k) => /approve|send|merge|ready|close|draft|reopen|changes|github/i.test(k)));
});
