import assert from "node:assert/strict";
import { test } from "node:test";
import { andMore, askedAt, stage } from "../src/stage.ts";
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
    reviewAsk(4, { ...junior, via: "@me" }),
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
