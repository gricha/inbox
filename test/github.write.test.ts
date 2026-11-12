import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient as createDeskClient } from "../src/client.ts";
import { createClient } from "../src/github/client.ts";
import { ALLOWED, REST_ALLOWED, createWriter } from "../src/github/write.ts";
import { Effect, Result } from "effect";
import { failure, run } from "./helpers/run.ts";

function fakeFetch(reply: { status?: number; body: unknown }) {
  const calls: { url: string; method: string; body: string; headers: Record<string, string> }[] = [];
  const fn: typeof fetch = (url, init) => {
    calls.push({
      url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
      method: init?.method ?? "",
      body: init?.body as string,
      headers: init?.headers as Record<string, string>,
    });
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
    "rerequest",
    "close",
    "draft",
    "merge",
    "reopen",
    "request_changes",
    "close_issue",
  ]);
  assert.deepEqual(REST_ALLOWED, { unrequest: "DELETE /repos/{repo}/pulls/{number}/requested_reviewers" });
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
  assert.match(
    ALLOWED.rerequest,
    /^mutation DeskRerequest[^{]*\{\s*requestReviewsByLogin\(input: \{ pullRequestId: \$pr, userLogins: \$users, union: true \}\)/,
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
  assert.deepEqual(await run(w.reply("PRRT_1", "Fixed in abc")), { url: "https://github.com/a/b/pull/1#c1" });
  const sent = JSON.parse(f.calls[0]!.body) as { query: string; variables: unknown };
  assert.equal(sent.query, ALLOWED.reply);
  assert.deepEqual(sent.variables, { thread: "PRRT_1", body: "Fixed in abc" });
  const g = fakeFetch({ body: { data: { addComment: { commentEdge: { node: { url: "https://github.com/a/b/pull/1#c2" } } } } } });
  assert.deepEqual(await run(createWriter({ token: "t", fetch: g.fetch }).comment("PR_1", "Thanks")), {
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
  assert.deepEqual(await run(w.inlineComment("PR_1", "abc", thread)), { url });
  assert.equal(f.calls.length, 1);
  const sent = JSON.parse(f.calls[0]!.body) as { query: string; variables: unknown };
  assert.equal(sent.query, ALLOWED.inline_comment);
  assert.deepEqual(sent.variables, { pr: "PR_1", commit: "abc", thread });
  assert.deepEqual(logs, ["github write: inline_comment PR_1 at abc"]);
  const empty = fakeFetch({ body: { data: { addPullRequestReview: null } } });
  const e = await failure(createWriter({ token: "t", fetch: empty.fetch }).inlineComment("PR_1", "abc", thread));
  assert.deepEqual(
    [e._tag, e.message],
    ["GitHubWriteUncertain", "GitHub answered without the comment: check the PR before you send it again"],
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
  await run(w.ready("PR_1"));
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
  assert.deepEqual(await run(w.approve("PR_node", "abc123", "LGTM")), { url: "https://github.com/a/b/pull/1#r1" });
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
  await run(w.close("PR_1"));
  await run(w.draft("PR_1"));
  await run(w.merge("PR_1", "h1", "SQUASH"));
  await run(w.reopen("PR_1"));
  await run(w.rerequest("PR_1", ["sam"]));
  assert.deepEqual(await run(w.requestChanges("PR_1", "h1", "Add a test")), { url: "https://github.com/a/b/pull/1#r2" });
  await run(w.closeIssue("I_1"));
  await run(w.unrequest("acme/api", 7, "me"));
  const sent = f.calls.slice(0, -1).map((c) => JSON.parse(c.body) as { query: string; variables: unknown });
  assert.deepEqual(
    sent.map((x) => [x.query, x.variables]),
    [
      [ALLOWED.close, { pr: "PR_1" }],
      [ALLOWED.draft, { pr: "PR_1" }],
      [ALLOWED.merge, { pr: "PR_1", head: "h1", method: "SQUASH" }],
      [ALLOWED.reopen, { pr: "PR_1" }],
      [ALLOWED.rerequest, { pr: "PR_1", users: ["sam"] }],
      [ALLOWED.request_changes, { pr: "PR_1", commit: "h1", body: "Add a test" }],
      [ALLOWED.close_issue, { issue: "I_1" }],
    ],
  );
  // The one REST write: your login off the PR's requested reviewers.
  const rest = f.calls.at(-1)!;
  assert.equal(rest.url, "https://api.github.com/repos/acme/api/pulls/7/requested_reviewers");
  assert.equal(rest.method, "DELETE");
  assert.deepEqual(JSON.parse(rest.body), { reviewers: ["me"] });
  assert.deepEqual(logs, [
    "github write: close PR_1",
    "github write: draft PR_1",
    "github write: merge PR_1 at h1",
    "github write: reopen PR_1",
    "github write: rerequest PR_1",
    "github write: request_changes PR_1 at h1",
    "github write: close_issue I_1",
    "github write: unrequest acme/api#7",
  ]);
});

test("GitHub's errors come back as errors, and nothing is retried", async () => {
  const gql = fakeFetch({ body: { errors: [{ message: "Can not approve your own pull request" }] } });
  const no = await failure(createWriter({ token: "t", fetch: gql.fetch }).approve("PR_x", "c"));
  assert.deepEqual([no._tag, no.message], ["GitHubGraphQLError", "GitHub: Can not approve your own pull request"]);
  const down = fakeFetch({ status: 502, body: { message: "bad gateway" } });
  const http = await failure(createWriter({ token: "t", fetch: down.fetch }).approve("PR_x", "c"));
  assert.deepEqual([http._tag, http.message], ["GitHubHttpError", 'GitHub HTTP 502: {"message":"bad gateway"}']);
  assert.equal(down.calls.length, 1);
});

test("a write with no answer (a timeout, the network) may have landed: it's uncertain, in fetch's words, and never sent again", async () => {
  for (const cause of [new DOMException("The operation was aborted due to timeout", "TimeoutError"), new TypeError("fetch failed")]) {
    let calls = 0;
    const fetch: typeof globalThis.fetch = () => {
      calls++;
      return Promise.reject(cause);
    };
    const e = await failure(createWriter({ token: "t", fetch }).comment("PR_1", "Thanks"));
    assert.deepEqual([e._tag, e.message], ["GitHubWriteUncertain", cause.message]);
    assert.equal(e._tag === "GitHubWriteUncertain" && e.cause, cause);
    assert.equal(calls, 1);
  }
});

test(
  "a gh auth token that never answers fails the write in 30 s, uninterruptible or not: nothing is sent and that gh is stopped",
  { skip: process.platform === "win32" },
  async (t) => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "desk-gh-"));
    const pidFile = path.join(bin, "pid");
    // A keychain prompt nobody answers; it gives up after 5 s with no token, so a write with no timeout of its own is sent.
    fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 5\n`, { mode: 0o755 });
    const env = { PATH: process.env.PATH, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
    t.after(() => {
      process.env.PATH = env.PATH;
      if (env.GITHUB_TOKEN !== undefined) process.env.GITHUB_TOKEN = env.GITHUB_TOKEN;
      fs.rmSync(bin, { recursive: true, force: true });
    });
    process.env.PATH = `${bin}${path.delimiter}${env.PATH ?? ""}`;
    delete process.env.GITHUB_TOKEN;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fakeFetch({ body: { data: {} } });
    const write = failure(Effect.uninterruptible(createWriter({ fetch: f.fetch }).close("PR_1")));
    const started = async () => {
      for (const until = Date.now() + 4000; Date.now() < until;) {
        const text = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").trim() : "";
        if (text) return Number(text);
        await new Promise((r) => {
          setImmediate(r);
        });
      }
      return 0;
    };
    const gh = await started();
    assert.ok(gh > 0, "the fake gh started");
    t.mock.timers.tick(30_000);
    const e = await write;
    assert.deepEqual(
      [e._tag, e._tag === "GitHubAuthError" && e.reason, e.message],
      ["GitHubAuthError", "no_token", "gh auth token didn't answer in 30 s: run it in a terminal"],
    );
    assert.equal(f.calls.length, 0, "nothing sent");
    const alive = () => !Result.isFailure(Result.try(() => process.kill(gh, 0)));
    const until = Date.now() + 2000;
    while (alive() && Date.now() < until)
      await new Promise((r) => {
        setImmediate(r);
      });
    assert.equal(alive(), false, "the gh that didn't answer is stopped");
  },
);

test("a write GitHub answered 2xx with something unreadable may have landed: it's uncertain, in the parser's words", async () => {
  const fetch: typeof globalThis.fetch = () => Promise.resolve(new Response("<html>oops</html>", { status: 200 }));
  const e = await failure(createWriter({ token: "t", fetch }).comment("PR_1", "Thanks"));
  assert.equal(e._tag, "GitHubWriteUncertain");
  assert.ok(e._tag === "GitHubWriteUncertain" && e.cause instanceof SyntaxError && e.message === e.cause.message);
});

test("a write is an Effect: nothing is sent until it runs", async () => {
  const f = fakeFetch({ body: { data: {} } });
  const ready = createWriter({ token: "t", fetch: f.fetch }).ready("PR_1");
  assert.equal(f.calls.length, 0);
  await run(ready);
  assert.equal(f.calls.length, 1);
});

test("the read client still refuses mutations, and neither the CLI's nor MCP's client can write to GitHub", async () => {
  const f = fakeFetch({ body: { data: {} } });
  for (const doc of Object.values(ALLOWED))
    await assert.rejects(Effect.runPromise(createClient({ token: "t", fetch: f.fetch }).query(doc)), /read-only/);
  assert.equal(f.calls.length, 0);
  const api = createDeskClient(() => new Response("{}"));
  assert.ok(!Object.keys(api).some((k) => /approve|send|merge|ready|close|draft|reopen|changes|github/i.test(k)));
});
