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

test("the allowlist is exactly six mutations: approve, a reply or comment you send, and m's auto-merge on and off", () => {
  assert.deepEqual(Object.keys(ALLOWED), ["approve", "reply", "comment", "ready", "auto_merge", "auto_merge_off"]);
  assert.match(
    ALLOWED.approve,
    /addPullRequestReview\(input: \{ pullRequestId: \$pr, commitOID: \$commit, event: APPROVE, body: \$body \}\)/,
  );
  assert.match(
    ALLOWED.reply,
    /^mutation DeskReply[^{]*\{\s*addPullRequestReviewThreadReply\(input: \{ pullRequestReviewThreadId: \$thread/,
  );
  assert.match(ALLOWED.comment, /^mutation DeskComment[^{]*\{\s*addComment\(input: \{ subjectId: \$subject, body: \$body \}\)/);
  assert.match(ALLOWED.ready, /^mutation DeskReady[^{]*\{\s*markPullRequestReadyForReview\(input: \{ pullRequestId: \$pr \}\)/);
  assert.match(
    ALLOWED.auto_merge,
    /^mutation DeskAutoMerge[^{]*\{\s*enablePullRequestAutoMerge\(input: \{ pullRequestId: \$pr, mergeMethod: \$method \}\)/,
  );
  assert.match(
    ALLOWED.auto_merge_off,
    /^mutation DeskAutoMergeOff[^{]*\{\s*disablePullRequestAutoMerge\(input: \{ pullRequestId: \$pr \}\)/,
  );
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

test("ready, auto-merge on and off send their mutation once each and log it, with the merge method", async () => {
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
  await w.autoMerge("PR_1", "SQUASH");
  await w.autoMergeOff("PR_1");
  const sent = f.calls.map((c) => JSON.parse(c.body) as { query: string; variables: unknown });
  assert.deepEqual(
    sent.map((x) => [x.query, x.variables]),
    [
      [ALLOWED.ready, { pr: "PR_1" }],
      [ALLOWED.auto_merge, { pr: "PR_1", method: "SQUASH" }],
      [ALLOWED.auto_merge_off, { pr: "PR_1" }],
    ],
  );
  assert.deepEqual(logs, ["github write: ready PR_1", "github write: auto_merge PR_1 (SQUASH)", "github write: auto_merge_off PR_1"]);
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

test("GitHub's errors come back as errors, and nothing is retried", async () => {
  const gql = fakeFetch({ body: { errors: [{ message: "Can not approve your own pull request" }] } });
  await assert.rejects(createWriter({ token: "t", fetch: gql.fetch }).approve("PR_x", "c"), /Can not approve your own pull request/);
  const down = fakeFetch({ status: 502, body: { message: "bad gateway" } });
  await assert.rejects(createWriter({ token: "t", fetch: down.fetch }).approve("PR_x", "c"), /HTTP 502/);
  assert.equal(down.calls.length, 1);
});

test("the read client still refuses mutations, and neither the CLI's nor MCP's client can approve, send or hand off", async () => {
  const f = fakeFetch({ body: { data: {} } });
  for (const doc of Object.values(ALLOWED)) await assert.rejects(createClient({ token: "t", fetch: f.fetch }).query(doc), /read-only/);
  assert.equal(f.calls.length, 0);
  const api = createDeskClient(() => new Response("{}"));
  assert.ok(!Object.keys(api).some((k) => /approve|send|handoff|back|merge|ready/i.test(k)));
});
