// The GitHub connector's passes and loops: what fails them, what that records, and that a loop keeps its schedule.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { Desk } from "../src/desk.ts";
import { GitHubAuthError, GitHubRateLimited } from "../src/errors.ts";
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

test("fetchOne fails with GitHubNotFetched when details skips the item; add answers 502 with its words", async (c) => {
  const t = await setup([]);
  c.after(t.cleanup);
  await run(t.desk.sync());
  t.gh.items.set(ID, makeItem({ repo: "acme/other", number: 9, author: "dave" }));
  t.gh.details = () => Effect.succeed([]); // GitHub refused the batch it was in, which details skips

  const e = await failure(t.desk.gh.fetchOne("acme/other", 9));
  assert.equal(e._tag, "GitHubNotFetched");
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

test("a desk with no context yet fails init with what GitHub's viewer fails with", async (c) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-test-"));
  const gh = new FakeGitHub([], () => []);
  const err = refused();
  gh.viewer = () => Effect.fail(err);
  const desk = new Desk({ home, github: gh, now: () => NOW, log: () => {} });
  c.after(() => {
    desk.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });
  await assert.rejects(run(desk.init()), (e) => e === err);
});

test("a desk that couldn't read your GitHub context writes no first config: init fails Upstream with what failed", async (c) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-test-"));
  const gh = new FakeGitHub([], () => []);
  gh.context = () => Effect.fail(refused());
  const desk = new Desk({ home, github: gh, now: () => NOW, log: () => {} });
  c.after(() => {
    desk.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const err = await failure(desk.init());
  assert.deepEqual(
    [err._tag, err.message],
    ["Upstream", `couldn't read your GitHub context to write a first config: ${refused().message}`],
  );
  assert.equal(fs.existsSync(path.join(home, "config.toml")), false);
});
