// The GitHub connector's passes and loops: what fails them, what that records, and that a loop keeps its schedule.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { Desk } from "../src/desk.ts";
import { GitHubAuthError, GitHubNotFetched, GitHubRateLimited } from "../src/errors.ts";
import { idle, reviewAsk, setup } from "./helpers/desk.ts";
import { FakeGitHub, makeItem, NOW } from "./helpers/items.ts";
import { failure, run, runSync } from "./helpers/run.ts";

const ID = "acme/other#9";
const refused = () => new GitHubAuthError({ reason: "rejected", message: "GitHub rejected the token (HTTP 401): run `gh auth login`" });

test("every search failing fails the pass with GitHubSearchesFailed, after it kept what it could; the sync shows its words", async (c) => {
  const t = await setup([reviewAsk(1)]);
  c.after(t.cleanup);
  await run(t.desk.sync());
  t.gh.items.set(ID, makeItem({ repo: "acme/other", number: 9, author: "dave" }));
  await run(t.desk.add(ID)); // pinned: no search returns it, so each pass refreshes it
  const err = refused();
  t.gh.search = () => Effect.fail(err);
  t.setNow(new Date(NOW.getTime() + 4 * 60_000));
  t.gh.detailCalls = [];

  const e = await failure(t.desk.gh.pass());
  assert.equal(e._tag, "GitHubSearchesFailed");
  assert.equal(e.message, err.message, "the first search's words, without its query");
  assert.equal(e._tag === "GitHubSearchesFailed" && e.cause, err);
  assert.deepEqual(t.gh.detailCalls, [[ID]], "the pin was still refreshed");

  const before = t.desk.syncedAt;
  await run(t.desk.sync());
  assert.equal(t.desk.syncError, err.message);
  assert.equal(t.desk.syncedAt, before);
  assert.equal(runSync(t.desk.overview()).connectors[0]?.status, "error");
});

test("a rate limit in a pass pauses the loops until GitHub's reset, and the next sync waits for it", async (c) => {
  const t = await setup([reviewAsk(1)]);
  c.after(t.cleanup);
  await run(t.desk.sync());
  const resetAt = new Date(Date.now() + 3_600_000).toISOString();
  const message = `GitHub rate limited until ${resetAt} (HTTP 403)`;
  let asked = 0;
  t.gh.search = () =>
    Effect.suspend(() => {
      asked++;
      return Effect.fail(new GitHubRateLimited({ resetAt, message }));
    });
  await run(t.desk.sync());
  assert.equal(asked, 1, "the first search's rate limit stops the pass");
  assert.equal(t.desk.gh.pausedUntil, Date.parse(resetAt));
  assert.equal(t.desk.syncError, message);
  assert.equal(runSync(t.desk.overview()).connectors[0]?.status, "paused");
  await run(t.desk.sync());
  assert.equal(asked, 1, "paused: no pass");
});

test("fetchOne fails with GitHubNotFetched, as Upstream's cause, when details skips the item; add answers 502 with its words", async (c) => {
  const t = await setup([]);
  c.after(t.cleanup);
  await run(t.desk.sync());
  t.gh.items.set(ID, makeItem({ repo: "acme/other", number: 9, author: "dave" }));
  t.gh.details = () => Effect.succeed([]); // GitHub refused the batch it was in, which details skips

  const e = await failure(t.desk.gh.fetchOne(ID));
  assert.deepEqual([e._tag, e._tag === "Upstream" && e.cause instanceof GitHubNotFetched], ["Upstream", true]);
  assert.equal(e.message, "couldn't fetch acme/other#9 from GitHub; try again");
  await assert.rejects(run(t.desk.add(ID)), (err: Error & { status: number }) => err.status === 502 && err.message === e.message);
  assert.equal(t.desk.snapshot().entries.has(ID), false);
});

test("a bug after a pass is logged and the loop keeps its schedule", async (c) => {
  c.mock.timers.enable({ apis: ["setTimeout"] });
  const logs: string[] = [];
  const t = await setup([reviewAsk(1)], {
    desk: {
      log: (m) => {
        logs.push(m);
      },
    },
  });
  c.after(t.cleanup);
  const synced = t.desk.synced.bind(t.desk);
  let bug = true;
  t.desk.synced = () => {
    if (bug) {
      bug = false;
      throw new TypeError("a bug in synced");
    }
    synced();
  };
  t.desk.start();
  await idle(t.desk);
  assert.ok(
    logs.some((l) => l.startsWith("sync failed: ") && l.includes("a bug in synced")),
    logs.join("\n"),
  );
  const before = t.gh.searches.length;
  c.mock.timers.tick(t.desk.settings["github.poll_seconds"] * 1000);
  await idle(t.desk);
  assert.ok(t.gh.searches.length > before, "the next pass ran on time");
});

test("an interrupt from inside a pass records nothing and the loop keeps its schedule", async (c) => {
  c.mock.timers.enable({ apis: ["setTimeout"] });
  const logs: string[] = [];
  const t = await setup([reviewAsk(1)], {
    desk: {
      log: (m) => {
        logs.push(m);
      },
    },
  });
  c.after(t.cleanup);
  const search = t.gh.search.bind(t.gh);
  let first = true;
  t.gh.search = (...a: Parameters<typeof search>) => {
    if (!first) return search(...a);
    first = false;
    return Effect.interrupt;
  };
  t.desk.start();
  await idle(t.desk);
  assert.ok(t.desk.gh.timer !== null, "the next pass is armed");
  assert.deepEqual([t.desk.gh.error, logs.filter((l) => l.includes("failed"))], [null, []]);
  const before = t.gh.searches.length;
  c.mock.timers.tick(t.desk.settings["github.poll_seconds"] * 1000);
  await idle(t.desk);
  assert.ok(t.gh.searches.length > before, "the next pass ran on time");
});

test("the desk stopping mid-pass records nothing: no error, and the pass lets go of syncing", async (c) => {
  const logs: string[] = [];
  const t = await setup([reviewAsk(1)], {
    desk: {
      log: (m) => {
        logs.push(m);
      },
    },
  });
  c.after(t.cleanup);
  t.gh.search = () => Effect.never;
  t.desk.start();
  assert.equal(t.desk.syncing, true, "the pass waits on GitHub");
  t.desk.stop();
  assert.equal(t.desk.syncing, false);
  assert.equal(t.desk.syncError, null);
  assert.ok(!logs.some((l) => l.includes("failed")), logs.join("\n"));
});

test("a desk with no context yet starts without a config, keeping what GitHub's viewer failed with for the first-run page", async (c) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-test-"));
  const gh = new FakeGitHub([], () => []);
  const err = refused();
  gh.viewer = () => Effect.fail(err);
  const desk = new Desk({ home, github: gh, now: () => NOW, log: () => {} });
  c.after(() => {
    desk.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });
  await run(desk.init());
  assert.equal(desk.githubError, err);
  assert.equal(desk.loaded, null);
  assert.equal(fs.existsSync(path.join(home, "config.toml")), false);
});

test("a desk that couldn't read your GitHub context writes no first config, and keeps what failed as Upstream", async (c) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-test-"));
  const gh = new FakeGitHub([], () => []);
  gh.context = () => Effect.fail(refused());
  const desk = new Desk({ home, github: gh, now: () => NOW, log: () => {} });
  c.after(() => {
    desk.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });
  await run(desk.init());
  const err = desk.githubError!;
  assert.deepEqual(
    [err._tag, err.message],
    ["Upstream", `couldn't read your GitHub context to write a first config: ${refused().message}`],
  );
  assert.equal(fs.existsSync(path.join(home, "config.toml")), false);
});

test("a bot's PR opened for you is read as deeply and as often as your own, once the desk knows whose it is", async (c) => {
  const junior = { author: "sentry-junior", author_bot: true, requester: "@me" };
  const t = await setup([
    makeItem({ number: 1, ...junior, assignees: ["me"] }),
    makeItem({ number: 2, ...junior, requester: "@dana", assignees: ["dana"] }),
  ]);
  c.after(t.cleanup);
  t.gh.route = (q) => (q.includes("assignee:@me") ? ["acme/api#1", "acme/api#2"] : []);
  const seen: [string, boolean][] = [];
  const details = t.gh.details.bind(t.gh);
  t.gh.details = (hits) => {
    seen.push(...hits.map((h): [string, boolean] => [h.id, !!h.mine]));
    return details(hits);
  };
  await run(t.desk.sync());
  assert.deepEqual(
    seen,
    [
      ["acme/api#1", false],
      ["acme/api#2", false],
    ],
    "the first read can't know yet",
  );
  assert.equal(runSync(t.desk.item("api#1")).card.by, "you");
  seen.length = 0;
  t.setNow(new Date(NOW.getTime() + 4 * 60_000));
  await run(t.desk.sync());
  assert.deepEqual(seen, [["acme/api#1", true]], "yours again after 3 minutes, deeply; someone else's waits 30");
});
