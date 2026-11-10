import assert from "node:assert/strict";
import { test } from "node:test";
import { andMore, askedAt, mergeLine, stage, standings } from "../src/stage.ts";
import type { Item } from "../src/types.ts";
import { reviewAsk, myPr, setup } from "./helpers/desk.ts";
import { hoursAgo, makeItem } from "./helpers/items.ts";
import { run, runSync } from "./helpers/run.ts";

const review = (author: string, state: Item["reviews"][number]["state"], h: number, o: { trusted?: boolean; bot?: boolean } = {}) => ({
  author,
  author_bot: !!o.bot,
  trusted: o.trusted ?? true,
  state,
  at: hoursAgo(h),
  commit: "abc",
});
// makeItem's default is "required"; most cases here leave the verdicts alone to decide.
const of = (o: Partial<Item>) => stage(makeItem({ review_decision: "none", ...o }), "alice");

test("a PR's stage: closed or merged, else a draft, else what its reviewers with a say left it at", () => {
  assert.equal(of({ kind: "issue" }), undefined, "an issue has none");
  assert.equal(of({ state: "merged" }), "merged");
  assert.equal(of({ state: "closed", draft: true }), "closed");
  assert.equal(of({ draft: true, reviews: [review("dana", "approved", 1)] }), "draft");
  assert.equal(of({}), "waiting for review");
  assert.equal(of({ reviews: [review("dana", "commented", 1)] }), "waiting for review");
  assert.equal(of({ reviews: [review("dana", "approved", 1)] }), "approved");
  assert.equal(of({ reviews: [review("dana", "changes_requested", 1)] }), "changes requested");
  assert.equal(of({ reviews: [review("dana", "approved", 1), review("kai", "changes_requested", 2)] }), "changes requested");
});

test("only a collaborator's approval counts, each reviewer's latest verdict stands, and nobody approves their own", () => {
  assert.equal(of({ reviews: [review("drive-by", "approved", 1, { trusted: false })] }), "waiting for review");
  assert.equal(of({ reviews: [review("drive-by", "changes_requested", 1, { trusted: false })] }), "changes requested");
  assert.equal(of({ reviews: [review("ci-bot", "approved", 1, { bot: true })] }), "waiting for review");
  assert.equal(of({ reviews: [review("alice", "approved", 1)] }), "waiting for review", "the author's own");
  assert.equal(of({ reviews: [review("dana", "changes_requested", 3), review("dana", "approved", 1)] }), "approved");
  assert.equal(of({ reviews: [review("dana", "approved", 3), review("dana", "dismissed", 1)] }), "waiting for review");
});

test("an approval isn't approved while GitHub still requires another review", () => {
  const approved = [review("dana", "approved", 1)];
  assert.equal(of({ review_decision: "required", reviews: approved }), "waiting for review");
  assert.equal(of({ review_decision: "approved", reviews: approved }), "approved");
});

test("each card says who it's from, you for yours or a bot's for you, and a PR's stage", async (c) => {
  const junior = { author: "sentry-junior", author_bot: true };
  const t = await setup([
    reviewAsk(1),
    myPr(2, { draft: true }),
    reviewAsk(3, { ...junior, via: "@dana" }),
    reviewAsk(4, { ...junior, via: "@me", requester: "@me", assignees: ["me"] }),
    reviewAsk(5, { kind: "issue" }),
  ]);
  c.after(t.cleanup);
  await run(t.desk.sync());
  const card = (id: string) => runSync(t.desk.item(id)).card;
  assert.deepEqual(
    ["acme/api#1", "acme/web#2", "acme/api#3", "acme/api#4", "acme/api#5"].map((id) => [card(id).by, card(id).stage]),
    [
      ["carol", "waiting for review"],
      ["you", "draft"],
      ["dana", "waiting for review"],
      ["you", "waiting for review"],
      ["carol", undefined],
    ],
  );
});

test("andMore", () => {
  assert.equal(andMore(["a"]), "a");
  assert.equal(andMore(["a", "b"]), "a and b");
  assert.equal(andMore(["a", "b", "c"]), "a, b and 1 more");
  assert.equal(andMore(["a", "b", "c", "d"]), "a, b and 2 more");
  assert.equal(andMore(["a", "b"], 3), "a, b and 3 more", "requests GitHub hides count too");
  assert.equal(andMore(["a"], 1), "a and 1 more");
  assert.equal(andMore([]), "");
});

test("askedAt is the latest ask of those still asked", () => {
  const ask = (reviewer: string, h: number, type: "user" | "team" = "user") => ({
    at: hoursAgo(h),
    actor: "me",
    actor_bot: false,
    reviewer,
    reviewer_type: type,
  });
  const user = (reviewer: string) => ({ reviewer, type: "user" as const, codeowner: false });
  const it = (o: Partial<Item>) => makeItem({ author: "me", created_at: hoursAgo(48), ...o });
  assert.equal(askedAt(it({ review_requests: [user("dana")], request_events: [ask("dana", 30)] }), "me"), hoursAgo(30));
  assert.equal(
    askedAt(it({ review_requests: [user("dana")], request_events: [ask("dana", 30), ask("sam", 2)] }), "me"),
    hoursAgo(30),
    "sam's ask is gone: he reviewed",
  );
  assert.equal(
    askedAt(it({ review_requests: [user("dana"), user("me")], request_events: [ask("dana", 30), ask("me", 1)] }), "me"),
    hoursAgo(30),
    "you aside",
  );
  assert.equal(
    askedAt(
      it({ review_requests: [{ reviewer: "backend", type: "team", codeowner: true }], request_events: [ask("backend", 5, "team")] }),
      "me",
    ),
    hoursAgo(5),
  );
  assert.equal(askedAt(it({ review_requests: [user("dana")] }), "me"), hoursAgo(48), "no ask logged: since it was opened");
});

// The review's sidebar: who reviews a PR and where each stands, in one line and one by one.
test("a PR's reviewers, each with a standing: changes requested, asked, approved or commented, and all of it in one line", () => {
  const ask = (reviewer: string, type: "user" | "team" = "user", bot = false) => ({
    reviewer,
    type,
    codeowner: false,
    ...(bot && { bot }),
  });
  const says = (o: Partial<Item>, me = "me") => standings(makeItem(o), me);
  assert.deepEqual(says({}), { line: "Nobody's asked", changes: false, list: [] });

  const mixed = says({
    review_requests: [ask("sam"), ask("backend", "team"), ask("copilot", "user", true), ask("me")],
    reviews: [
      review("marco", "approved", 9),
      review("kofi", "changes_requested", 8),
      review("kai", "commented", 7),
      review("alice", "commented", 6), // its author answering a thread
      review("ci-bot", "approved", 5, { bot: true }),
      review("guest", "approved", 4, { trusted: false }), // no say on the repo: a comment
      review("me", "pending", 3), // your own, not sent
    ],
  });
  assert.equal(mixed.line, "Changes requested by kofi · approved by marco · waiting on sam, @backend and 1 more");
  assert.equal(mixed.changes, true);
  assert.deepEqual(
    mixed.list.map((s) => `${s.who}: ${s.state}`),
    ["kofi: changes requested", "sam: asked", "@backend: asked", "you: asked", "marco: approved", "kai: commented", "guest: commented"],
  );

  // One standing each: an approval holds while they're asked again, a change request while they've approved since or not.
  const again = says({
    review_requests: [ask("marco"), ask("dana")],
    reviews: [review("marco", "approved", 9), review("dana", "changes_requested", 8), review("dana", "commented", 2)],
  });
  assert.deepEqual(
    again.list.map((s) => `${s.who}: ${s.state}`),
    ["dana: changes requested", "marco: approved"],
  );
  assert.equal(again.line, "Changes requested by dana · approved by marco");

  assert.equal(says({ reviews: [review("marco", "approved", 2)] }).line, "Approved by marco");
  assert.equal(says({ review_requests: [ask("me")] }).line, "Waiting on you");
  assert.equal(says({ reviews: [review("kai", "commented", 2), review("sam", "commented", 1)] }).line, "Comments from kai and sam");
  assert.equal(says({ review_requests_hidden: 1 }).line, "Waiting on a team GitHub doesn't show you");
  assert.equal(says({ review_requests: [ask("sam")], review_requests_hidden: 2 }).line, "Waiting on sam and 2 more");
  // Yours: your own review of it never counts, so you're not among its reviewers.
  assert.deepEqual(says({ author: "me", reviews: [review("me", "commented", 1)] }), { line: "Nobody's asked", changes: false, list: [] });
});

test("the merge's one line: a conflict with its base on an open PR, and nothing when it's clean, unknown or over", () => {
  assert.equal(mergeLine(makeItem({ mergeable: "conflict", base: "release/24.1" })), "Merge conflict with release/24.1");
  for (const o of [{ mergeable: "clean" }, { mergeable: "unknown" }, { mergeable: "conflict", state: "merged" }] as Partial<Item>[])
    assert.equal(mergeLine(makeItem(o)), null);
});

test("a review carries who reviews its PR and what stands in its merge, as the desk says them", async (c) => {
  const t = await setup(
    [
      myPr(3, {
        ci: "green",
        mergeable: "conflict",
        review_requests: [
          { reviewer: "dana", type: "user", codeowner: false },
          { reviewer: "backend", type: "team", codeowner: true },
        ],
        reviews: [review("kofi", "changes_requested", 2)],
      }),
      reviewAsk(4, { reviews: [review("marco", "approved", 3)] }),
    ],
    { settings: { "policy.judge": false, "review.auto_ai": false } },
  );
  c.after(t.cleanup);
  await run(t.desk.sync());
  const mine = await run(t.desk.reviewView("web#3", true));
  assert.deepEqual(
    [mine.reviewers.line, mine.reviewers.changes, mine.merge],
    ["Changes requested by kofi · waiting on dana and @backend", true, "Merge conflict with main"],
  );
  const theirs = await run(t.desk.reviewView("api#4", true));
  assert.deepEqual([theirs.reviewers.line, theirs.reviewers.changes, theirs.merge], ["Approved by marco · waiting on you", false, null]);
  assert.deepEqual(theirs.reviewers.list, [
    { who: "you", state: "asked" },
    { who: "marco", state: "approved" },
  ]);
});
