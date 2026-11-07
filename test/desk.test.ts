import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfigText } from "../src/config.ts";
import { Desk, parseUntil } from "../src/desk.ts";
import { judgeKey } from "../src/judge.ts";
import type { Card, Context, Item } from "../src/types.ts";
import { idle, myPr, reviewAsk, setup, teamPing } from "./helpers/desk.ts";
import { FakeGitHub, hoursAgo, makeItem, NOW } from "./helpers/items.ts";

test("first run writes a config with a space for the busiest org", async () => {
  const t = await setup([]);
  const text = fs.readFileSync(path.join(t.home, "config.toml"), "utf8");
  assert.match(text, /scope = "org:acme"/);
  assert.match(text, /scope = "-org:acme"/);
  assert.deepEqual(t.desk.configErrors, []);
  t.cleanup();
});

test("sync fills boards, focus and status", async () => {
  const t = await setup([reviewAsk(1), teamPing(2), myPr(3)]);
  await t.desk.sync();
  const review = t.desk.board("acme-review");
  assert.deepEqual(
    review.sections.now.map((c) => c.id),
    ["acme/api#1"],
  );
  assert.deepEqual(
    review.sections.fyi.map((c) => c.id),
    ["acme/api#2"],
  );
  assert.equal(review.sections.now[0]?.why, "carol asked you directly");
  assert.ok(review.board.queries.every((q) => q.endsWith("org:acme")));
  const mine = t.desk.board("acme-mine");
  assert.deepEqual(
    mine.sections.today.map((c) => c.id),
    ["acme/web#3"],
  );
  assert.ok(mine.sections.today[0]?.chips.includes("CI red"));

  const focus = t.desk.focus();
  assert.deepEqual(focus.sections.now.map((c) => c.id).sort(), ["acme/api#1"]);
  assert.deepEqual(focus.sections.today.map((c) => c.id).sort(), ["acme/web#3"]);
  assert.equal(t.desk.status().text, "desk 2");
  const ov = t.desk.overview();
  assert.equal(ov.me, "me");
  assert.equal(ov.focus.now, 1);
  assert.equal(ov.spaces[0]?.boards[0]?.counts.now, 1);
  t.cleanup();
});

test("details are only refetched when an item changed or went stale", async () => {
  const item = reviewAsk(1);
  const t = await setup([item]);
  await t.desk.sync();
  await t.desk.sync();
  assert.equal(t.gh.detailCalls.filter((c) => c.length).length, 1);
  t.gh.items.set("acme/api#1", { ...item, updated_at: hoursAgo(0) });
  await t.desk.sync();
  assert.equal(t.gh.detailCalls.filter((c) => c.length).length, 2);
  t.cleanup();
});

test("done hides until someone else acts; undo restores", async () => {
  const t = await setup([reviewAsk(1)]);
  await t.desk.sync();
  const r = t.desk.act("api#1", "done");
  assert.ok(r.undo_seq > 0);
  let board = t.desk.board("acme-review");
  assert.equal(board.sections.now.length, 0);
  assert.deepEqual(
    board.cleared.map((c) => [c.id, c.status]),
    [["acme/api#1", "done"]],
  );

  assert.deepEqual(t.desk.undo().action, "done");
  assert.equal(t.desk.board("acme-review").sections.now.length, 1);

  t.desk.act("acme/api#1", "done");
  t.setNow(new Date(NOW.getTime() + 3_600_000));
  t.gh.items.set(
    "acme/api#1",
    reviewAsk(1, {
      updated_at: new Date(NOW.getTime() + 1800_000).toISOString(),
      comments: [{ author: "carol", author_bot: false, at: new Date(NOW.getTime() + 1800_000).toISOString() }],
    }),
  );
  await t.desk.sync();
  board = t.desk.board("acme-review");
  assert.equal(board.sections.now[0]?.id, "acme/api#1");
  assert.equal(board.sections.now[0].new, true);
  t.cleanup();
});

test("snooze until a time, wakes on time or on activity; mute and pin", async () => {
  const t = await setup([reviewAsk(1), reviewAsk(2)]);
  await t.desk.sync();
  t.desk.act("api#1", "snooze", "3h");
  assert.equal(t.desk.board("acme-review").cleared[0]?.status, "snoozed");
  t.setNow(new Date(NOW.getTime() + 4 * 3_600_000));
  t.desk.changed();
  assert.equal(t.desk.board("acme-review").cleared.length, 0);

  t.desk.act("api#2", "mute");
  assert.equal(t.desk.board("acme-review").cleared[0]?.status, "muted");
  t.desk.act("api#2", "unmute");
  t.desk.act("api#2", "pin");
  assert.equal(t.desk.board("acme-review").sections.now[0]?.id, "acme/api#2");
  t.cleanup();
});

test("refs resolve by full id, short id, number or URL; ambiguity is a 409", async () => {
  const t = await setup([reviewAsk(1), myPr(1)]);
  await t.desk.sync();
  assert.equal(t.desk.resolve("api#1"), "acme/api#1");
  assert.equal(t.desk.resolve("https://github.com/acme/web/pull/1/files"), "acme/web#1");
  assert.throws(
    () => t.desk.resolve("#1"),
    (e: { status: number }) => e.status === 409,
  );
  assert.throws(
    () => t.desk.resolve("api#99"),
    (e: { status: number }) => e.status === 404,
  );
  const detail = t.desk.item("acme/api#1");
  assert.equal(detail.signals.me.requested_direct, true);
  assert.ok(detail.handoff_prompt.includes("gh pr diff 1 --repo acme/api"));
  assert.ok(!detail.handoff_prompt.includes(detail.item.title));
  t.cleanup();
});

test("the Rules page lists the final rules with the hard ones, in board order, their whys in plain words", async (c) => {
  const t = await setup([]);
  c.after(t.cleanup);
  const review = t.desk.getConfig().hard.filter((h) => h.board === "PRs to review (acme)");
  assert.deepEqual(
    review.map((h) => [h.bucket, h.why, !!h.final]),
    [
      ["blocked", "blocked by another PR, which waits on something", true],
      ["now", "someone asked you directly", false],
      ["today", "asked you by name (added by someone)", false],
    ],
  );
});

test("preview shows moves without saving; putConfig saves valid text only", async () => {
  const t = await setup([reviewAsk(1), teamPing(2)]);
  await t.desk.sync();
  const text = t.desk
    .getConfig()
    .text.replace(
      `{ when = "me.requested_codeowner && !me.requested_direct", bucket = "fyi"`,
      `{ when = "me.requested_codeowner && !me.requested_direct", bucket = "today"`,
    );
  const p = t.desk.preview(text);
  assert.deepEqual(p.errors, []);
  const review = p.boards.find((b) => b.id === "acme-review")!;
  assert.deepEqual(review.moved, [{ id: "acme/api#2", title: "Change 2", from: "fyi", to: "today" }]);
  assert.equal(t.desk.board("acme-review").sections.fyi.length, 1);

  assert.equal(t.desk.putConfig("[[boards]]\nid = 1").ok, false);
  assert.equal(t.desk.putConfig(text).ok, true);
  assert.equal(t.desk.board("acme-review").sections.today[0]?.id, "acme/api#2");
  t.cleanup();
});

test("notifies for a new item on the queue after the first sync", async () => {
  const items = [reviewAsk(1)];
  const t = await setup(items);
  await t.desk.sync();
  assert.deepEqual(t.notes, []);
  t.gh.items.set("acme/api#5", reviewAsk(5));
  t.setNow(new Date("2026-10-27T15:00:00")); // local time, outside quiet hours
  await t.desk.sync();
  assert.equal(t.notes.length, 1);
  assert.match(t.notes[0] ?? "", /api#5/);
  await t.desk.sync();
  assert.equal(t.notes.length, 1);
  t.cleanup();
});

test("a new queue item notifies once Claude or a hard rule placed it, never while Claude hasn't sorted it or for your own pin", async () => {
  const t = await setup([reviewAsk(1), teamPing(2)], { settings: { "notify.quiet": "" } });
  await t.desk.sync();
  t.gh.items.set("acme/web#3", myPr(3, { ci: "red" }));
  await t.desk.sync();
  assert.ok(t.desk.focus().sections.today.some((x) => x.id === "acme/web#3" && x.placed_by === "pending"));
  assert.deepEqual(t.notes, [], "the rules put it there, and Claude may still sort it away");
  const e = t.desk.snapshot().entries.get("acme/web#3")!;
  const key = judgeKey(e.item, e.analysis.activity_at, null);
  t.desk.store.set("judge:acme/web#3", { key, policy: t.desk.policy.hash, bucket: "today", why: "your PR is red", at: NOW.toISOString() });
  t.desk.changed();
  t.desk.notifyNew();
  assert.deepEqual(t.notes, ["web#3 · your PR is red"]);
  t.desk.notifyNew();
  assert.equal(t.notes.length, 1, "once");
  t.desk.act("api#2", "pin");
  assert.ok(t.desk.focus().sections.today.some((x) => x.id === "acme/api#2" && x.placed_by === "pin"));
  t.desk.notifyNew();
  assert.equal(t.notes.length, 1, "your pin put it there");
  t.cleanup();
});

test("your own new drafts never notify, and the queue lists a stack of them once", async () => {
  const t = await setup([reviewAsk(1)], { settings: { "notify.quiet": "", "policy.judge": false } });
  await t.desk.sync();
  // Four drafts, each based on the one before, and two that make a stack of two.
  const stack = [10, 11, 12, 13].map((n) => myPr(n, { draft: true, ci: "none", head_ref: `s${n}`, base: n === 10 ? "main" : `s${n - 1}` }));
  const pair = [20, 21].map((n) => myPr(n, { draft: true, ci: "none", head_ref: `p${n}`, base: n === 20 ? "main" : "p20" }));
  for (const p of [...stack, ...pair]) t.gh.items.set(p.id, p);
  await t.desk.sync();
  const cards = [...t.desk.focus().sections.now, ...t.desk.focus().sections.today];
  assert.deepEqual(t.notes, [], "you just opened them");
  assert.deepEqual(
    cards
      .filter((c) => c.draft)
      .map((c) => [c.id, c.stack?.pos, c.stack?.size])
      .toSorted((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [
      ["acme/web#10", 1, 4],
      ["acme/web#20", 1, 2],
    ],
  );
  t.gh.items.set("acme/api#31", reviewAsk(31));
  await t.desk.sync();
  assert.deepEqual(t.notes, ["api#31 · carol asked you directly"]);
  t.cleanup();
});

test("a desktop app attached to the desk takes its notifications over while it's connected", async () => {
  const t = await setup([reviewAsk(1)]);
  const app: string[] = [];
  const off = t.desk.onNotify((_title, body) => {
    app.push(body);
  });
  t.desk.notify("Review Desk", "one");
  off();
  t.desk.notify("Review Desk", "two");
  assert.deepEqual([app, t.notes], [["one"], ["two"]]);
  t.cleanup();
});

test("close_authors expands within GitHub's 256-char query limit", async () => {
  const t = await setup([]);
  t.desk.ctx!.affinity = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`collaborator-${i}`, 50 - i]));
  const q = t.desk.gh.expandQuery(
    "is:pr is:open archived:false -is:draft -author:@me -review-requested:@me {close_authors}",
    "org:acme",
    t.desk.loaded!,
  )!;
  assert.ok(q.length <= 256);
  assert.match(q, /author:collaborator-0 author:collaborator-1/);
  t.desk.ctx!.affinity = {};
  assert.equal(t.desk.gh.expandQuery("is:pr {close_authors}", "", t.desk.loaded!), null);
  t.cleanup();
});

test("your areas: fetched on the first sync, then daily; a failure keeps them and retries in about an hour", async () => {
  const t = await setup([]);
  const later = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
  t.gh.found = { "acme/api": { "src/auth/": 6 } };
  await t.desk.sync();
  await t.desk.sync();
  assert.equal(t.gh.areaCalls, 1);
  assert.deepEqual(t.desk.ctx?.areas, { "acme/api": { "src/auth/": 6 } });

  // The daily context refresh keeps them; the failed areas fetch does too.
  t.setNow(later(25));
  t.gh.found = new Error("GitHub HTTP 502");
  await t.desk.sync();
  assert.equal(t.gh.areaCalls, 2);
  assert.equal(t.desk.ctx?.refreshed_at, later(25).toISOString());
  assert.deepEqual(t.desk.ctx?.areas, { "acme/api": { "src/auth/": 6 } });
  t.setNow(later(25.5));
  await t.desk.sync();
  assert.equal(t.gh.areaCalls, 2);

  t.setNow(later(26.1));
  t.gh.found = { "acme/api": { "src/auth/": 9 } };
  await t.desk.sync();
  assert.equal(t.gh.areaCalls, 3);
  assert.deepEqual((t.desk.store.get("context") as Context).areas, { "acme/api": { "src/auth/": 9 } });
  t.cleanup();
});

test("parseUntil", () => {
  const now = new Date("2026-10-28T15:30:00"); // a Wednesday, local
  assert.equal(parseUntil("3h", now).getTime(), now.getTime() + 3 * 3_600_000);
  const tomorrow = parseUntil("tomorrow", now);
  assert.deepEqual([tomorrow.getDate(), tomorrow.getHours()], [29, 9]);
  const monday = parseUntil("monday", now);
  assert.deepEqual([monday.getDay(), monday.getDate(), monday.getHours()], [1, 2, 9]);
  assert.throws(() => parseUntil("someday", now));
});

test("parseUntil rejects bare numbers and past times; accepts Nd", () => {
  const now = new Date("2026-10-28T15:30:00Z");
  assert.throws(() => parseUntil("3", now), /can't read/);
  assert.throws(() => parseUntil("2026-10-01", now), /can't read/);
  assert.equal(parseUntil("2d", now).getTime(), now.getTime() + 48 * 3_600_000);
  assert.equal(parseUntil("2026-11-02T09:00:00Z", now).toISOString(), "2026-11-02T09:00:00.000Z");
});

test("done remembers the activity you saw: activity synced after the click still resurfaces", async () => {
  const t = await setup([reviewAsk(1)]);
  await t.desk.sync();
  // A comment made just before the click, but synced after it.
  const commentAt = new Date(NOW.getTime() - 60_000).toISOString();
  t.desk.act("api#1", "done");
  t.gh.items.set("acme/api#1", reviewAsk(1, { updated_at: commentAt, comments: [{ author: "carol", author_bot: false, at: commentAt }] }));
  await t.desk.sync();
  assert.equal(t.desk.board("acme-review").sections.now[0]?.id, "acme/api#1");
  t.cleanup();
});

test("undo by seq refuses to overwrite a later action on the same item", async () => {
  const t = await setup([reviewAsk(1)]);
  await t.desk.sync();
  const first = t.desk.act("api#1", "pin").undo_seq;
  t.desk.act("api#1", "done");
  assert.throws(
    () => t.desk.undo(first),
    (e: { status: number }) => e.status === 409,
  );
  t.desk.undo();
  t.desk.undo(first);
  assert.equal(t.desk.item("api#1").state.pinned, false);
  t.cleanup();
});

test("bare numbers resolve as numbers, not repo + digit", async () => {
  const t = await setup([reviewAsk(123)]);
  await t.desk.sync();
  assert.equal(t.desk.resolve("123"), "acme/api#123");
  assert.equal(t.desk.resolve("#123"), "acme/api#123");
  t.cleanup();
});

test("a date-only snooze means 09:00 local that day", () => {
  const d = parseUntil("2026-11-02", new Date("2026-10-28T15:30:00"));
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()], [2026, 10, 2, 9]);
});

test("tomorrow after midnight means this morning; monday before 9 on a Monday means today; 0h is refused", () => {
  const lateNight = new Date("2026-10-27T01:30:00"); // Tuesday, local
  const t = parseUntil("tomorrow", lateNight);
  assert.deepEqual([t.getDate(), t.getHours()], [27, 9]);
  const mondayEarly = new Date("2026-11-02T07:00:00"); // Monday, local
  assert.deepEqual([parseUntil("monday", mondayEarly).getDate()], [2]);
  assert.throws(() => parseUntil("0h", lateNight), /can't read/);
});

test("hand-off prompt depends on kind: review, your PR, issue", async () => {
  const issue = makeItem({ number: 9, kind: "issue", author: "carol", assignees: ["me"] });
  const t = await setup([reviewAsk(1), myPr(2), issue]);
  await t.desk.sync();
  assert.match(t.desk.item("api#1").handoff_prompt, /gh pr diff 1 --repo acme\/api/);
  assert.match(t.desk.item("web#2").handoff_prompt, /gh pr checks 2 --repo acme\/web/);
  t.cleanup();
});

test("the main page's parts: a hand-back, what waits on your review, the rest that's someone else's, your PRs; Now and Today each in that order", async (c) => {
  const t = await setup([reviewAsk(1), myPr(2, { draft: true }), myPr(3), myPr(5, { ci: "green" })], {
    settings: { "policy.judge": false },
  });
  c.after(t.cleanup);
  await t.desk.sync();
  t.gh.items.set("acme/api#9", makeItem({ number: 9, kind: "issue", author: "carol", assignees: ["me"] }));
  t.gh.items.set("acme/api#6", makeItem({ number: 6, author: "carol" }));
  await t.desk.add("acme/api#9");
  await t.desk.add("acme/api#6"); // someone else's PR nobody asked you to review
  t.desk.act("web#5", "inflight");
  t.desk.handBack("web#5", "needs a product call on the retry budget");
  const f = t.desk.focus();
  const part = Object.fromEntries([...f.sections.now, ...f.sections.today].map((x) => [x.id, x.group]));
  assert.deepEqual(part, {
    "acme/web#5": "back",
    "acme/api#1": "review",
    "acme/api#9": "other",
    "acme/api#6": "other",
    "acme/web#2": "mine",
    "acme/web#3": "mine",
  });
  assert.equal(f.sections.now[0]?.id, "acme/web#5", "a hand-back tops the queue");
  const rank = (cs: { group?: string }[]) => cs.map((x) => ["back", "review", "other", "mine"].indexOf(x.group ?? ""));
  for (const cs of [f.sections.now, f.sections.today])
    assert.deepEqual(
      rank(cs),
      rank(cs).toSorted((a, b) => a - b),
      "Now, then Today, each by part",
    );
});

test("saving config refuses when the file changed since it was loaded", async () => {
  const t = await setup([]);
  const base = t.desk.getConfig().text;
  assert.equal(t.desk.putConfig(base, base).ok, true);
  assert.throws(
    () => t.desk.putConfig(base, base + "\n# stale"),
    (e: { status: number }) => e.status === 409,
  );
  t.cleanup();
});

test("when every search fails, the last sync time stays and the error is shown", async () => {
  const t = await setup([reviewAsk(1)]);
  await t.desk.sync();
  const before = t.desk.syncedAt;
  t.gh.search = () => Promise.reject(new Error("GitHub rejected the token (HTTP 401): run `gh auth login`"));
  t.setNow(new Date(NOW.getTime() + 3_600_000));
  await t.desk.sync();
  assert.equal(t.desk.syncedAt, before);
  assert.match(t.desk.syncError!, /gh auth login/);
  t.cleanup();
});

test("settings: saving changes the live config; bad values write nothing", async () => {
  const t = await setup([reviewAsk(1)]);
  await t.desk.sync();
  const r = t.desk.putSettings({ set: { "handoff.prompt": "Look at {item.url} please", "github.poll_seconds": 120 } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.settings.overridden.sort(), ["github.poll_seconds", "handoff.prompt"]);
  assert.equal(t.desk.loaded!.config.poll_seconds, 120);
  assert.equal(t.desk.item("api#1").handoff_prompt, "Look at https://github.com/acme/api/pull/1 please");
  const bad = t.desk.putSettings({ set: { "github.poll_seconds": 5, "notify.enabled": false } });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0]?.path, "github.poll_seconds");
  assert.equal(t.desk.settings["notify.enabled"], true);
  // Setting a default value or resetting drops the key from settings.json.
  t.desk.putSettings({ set: { "github.poll_seconds": 90 }, reset: ["handoff.prompt"] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(t.home, "settings.json"), "utf8")), {});
  assert.equal(t.desk.getSettings().github.login, "me");
  t.cleanup();
});

test("a removed setting is ignored: no settings problem, and a save keeps it for an older desk", async () => {
  const old = { "analyze.model": "sonnet", "inflight.babysit": false, "inflight.auto_merge": false, "notify.enabled": false };
  const t = await setup([reviewAsk(1)], { settings: old });
  assert.deepEqual(t.desk.getSettings().errors, []);
  assert.equal(t.desk.settings["notify.enabled"], false);
  assert.equal(t.desk.putSettings({ set: { "github.poll_seconds": 120 } }).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(t.home, "settings.json"), "utf8")), { ...old, "github.poll_seconds": 120 });
  t.cleanup();
});

test("settings move out of an old config.toml on start", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-test-"));
  const boards = (await import("../src/config.ts")).defaultConfigText({ workOrgs: ["acme"] });
  fs.writeFileSync(path.join(home, "config.toml"), `poll_seconds = 300\n\n[notify]\nenabled = false\n\n${boards}`);
  const gh = new FakeGitHub([], () => []);
  const desk = new Desk({ home, github: gh, now: () => NOW, notify: () => {}, log: () => {} });
  await desk.init();
  assert.deepEqual(desk.configErrors, []);
  assert.equal(desk.settings["github.poll_seconds"], 300);
  assert.equal(desk.settings["notify.enabled"], false);
  assert.doesNotMatch(fs.readFileSync(path.join(home, "config.toml"), "utf8"), /poll_seconds|\[notify\]/);
  assert.match(fs.readFileSync(path.join(home, "config.toml.bak"), "utf8"), /poll_seconds = 300/);
  desk.stop();
  fs.rmSync(home, { recursive: true });
});

test("queue: every item once at its best placement, plus hidden and cleared", async () => {
  const t = await setup([reviewAsk(1), teamPing(2), myPr(3), myPr(4, { ci: "green" })]);
  await t.desk.sync();
  t.desk.act("web#4", "done");
  const q = t.desk.queue();
  assert.deepEqual(q.sections.now.map((c) => c.id).sort(), ["acme/api#1"]);
  assert.deepEqual(q.sections.today.map((c) => c.id).sort(), ["acme/web#3"]);
  assert.deepEqual(
    q.sections.fyi.map((c) => c.id),
    ["acme/api#2"],
  );
  assert.deepEqual(
    q.cleared.map((c) => c.id),
    ["acme/web#4"],
  );
  const all = [...Object.values(q.sections).flat(), ...q.hidden, ...q.cleared].map((c) => c.id);
  assert.equal(new Set(all).size, all.length);
  t.cleanup();
});

test("Resolved lists the last day's items that were in Now or Today or asked of you; a team ping resolves silently", async () => {
  const t = await setup([reviewAsk(1), teamPing(2)]);
  await t.desk.sync();
  const merged = (n: number, o = {}) => ({ ...t.gh.items.get(`acme/api#${n}`)!, state: "merged" as const, closed_at: hoursAgo(0.5), ...o });
  t.gh.items.set("acme/api#1", merged(1));
  t.gh.items.set("acme/api#2", merged(2));
  await t.desk.sync();
  assert.deepEqual(
    t.desk.queue().resolved.map((c) => c.id),
    ["acme/api#1"],
  );
  t.setNow(new Date(NOW.getTime() + 30 * 3_600_000));
  await t.desk.sync();
  assert.deepEqual(t.desk.queue().resolved, [], "a day on, it's gone");
  t.cleanup();
});

test("a review asked only of your team says so", async () => {
  const t = await setup([reviewAsk(4, { review_requests: [{ reviewer: "ml-team", type: "team", codeowner: true }] })]);
  await t.desk.sync();
  const q = t.desk.queue();
  const all = [...q.sections.now, ...q.sections.today, ...q.sections.later, ...q.sections.fyi];
  assert.equal(all.find((c) => c.id === "acme/api#4")?.team_ask, "CODEOWNERS ping to @ml-team");
  t.cleanup();
});

test("quiet items drop out of Now and Today: your old failing PRs go to Later; a PR in Merging stays there", async () => {
  const days = (d: number) => hoursAgo(d * 24);
  const t = await setup([
    myPr(20631, { updated_at: days(143) }),
    myPr(548, { updated_at: days(20) }),
    myPr(7),
    myPr(8, { ci: "red", updated_at: days(30) }),
    reviewAsk(1, { updated_at: days(30) }),
  ]);
  await t.desk.sync();
  t.desk.act("web#8", "inflight");
  const q = t.desk.queue();
  assert.deepEqual(
    q.sections.later.filter((c) => c.demoted?.startsWith("quiet")).map((c) => [c.id, c.demoted]),
    [
      ["acme/web#20631", "quiet for 5 months"],
      ["acme/web#548", "quiet for 3 weeks"],
    ],
  );
  assert.deepEqual(
    q.sections.now.map((c) => [c.id, c.why]),
    [["acme/api#1", "carol asked you directly"]],
    "the ask came an hour ago, so it isn't quiet whatever updated_at says",
  );
  assert.deepEqual(
    q.sections.today.map((c) => c.id),
    ["acme/web#7"],
  );
  assert.deepEqual([t.desk.inflight().rows[0]?.waits_on, t.desk.overview().inflight.total], ["waits on a CI fix", 1]);

  t.desk.putSettings({ set: { "queue.quiet_days": 0 } });
  assert.deepEqual(
    t.desk
      .queue()
      .sections.today.map((c) => c.id)
      .sort(),
    ["acme/web#20631", "acme/web#548", "acme/web#7"],
  );
  t.cleanup();
});

test("synced_at is when the sync finished; hits keep its start time", async () => {
  const t = await setup([reviewAsk(1)]);
  const done = new Date(NOW.getTime() + 60_000);
  const search = t.gh.search.bind(t.gh);
  t.gh.search = (q: string) => {
    t.setNow(done);
    return search(q);
  };
  await t.desk.sync();
  assert.equal(t.desk.syncedAt, done.toISOString());
  assert.equal(t.desk.store.get("synced_at"), done.toISOString());
  assert.ok([...t.desk.store.queries().values()].every((x) => x.fetched_at === NOW.toISOString()));
  t.cleanup();
});

test("saving settings keeps entries in settings.json it can't use", async () => {
  const t = await setup([]);
  const file = path.join(t.home, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ "github.poll_seconds": 5, "x.typo": true }));
  t.desk.reloadSettings();
  const r = t.desk.putSettings({ set: { "notify.enabled": false } });
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.settings.errors.map((e) => e.path),
    ["github.poll_seconds", "x.typo"],
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { "github.poll_seconds": 5, "notify.enabled": false, "x.typo": true });
  await idle(t.desk);
  t.cleanup();
});

test("a desk started on the oldest config migrates its rules once, with one backup, and leaves today's config alone", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-test-"));
  const config = path.join(home, "config.toml");
  const now = defaultConfigText({ workOrgs: ["acme"] });
  const old = now
    .replaceAll(
      `  { when = "me.requested_direct", bucket = "today", why = "asked you by name (added by {me.requested_by})", hard = true },\n`,
      "",
    )
    .replaceAll(`asked you directly", hard = true`, `asked you directly", nocap = true`)
    .replaceAll(
      `  { when = "item.draft && item.updated_hours < 336", bucket = "today", why = "your draft: finish it", hard = true },\n  { when = "item.draft", bucket = "later", why = "draft, quiet for 2+ weeks" },`,
      `  { when = "item.draft", bucket = "later", why = "draft" },`,
    )
    .replaceAll(
      /^.*why = "CI failing" \},\n/gm,
      `$&  { when = "pr.mergeable == 'conflict'", bucket = "today", why = "merge conflict" },\n`,
    );
  fs.writeFileSync(config, old);
  const logs: string[] = [];
  const opts = { home, github: new FakeGitHub([], () => []), now: () => NOW, notify: () => {}, log: (m: string) => void logs.push(m) };
  const desk = new Desk(opts);
  await desk.init();
  assert.equal(fs.readFileSync(config, "utf8"), now);
  assert.equal(fs.readFileSync(`${config}.bak`, "utf8"), old);
  assert.equal(logs.filter((l) => l.includes("backup: config.toml.bak")).length, 1);
  for (const k of ["hard_migrated", "bot_ask_migrated", "drafts_migrated", "conflict_migrated"]) {
    assert.ok(desk.store.get(k), k);
    desk.store.set(k, null);
  }
  desk.stop();

  fs.writeFileSync(config, now);
  fs.rmSync(`${config}.bak`);
  const again = new Desk(opts);
  await again.init();
  assert.equal(fs.readFileSync(config, "utf8"), now);
  assert.ok(!fs.existsSync(`${config}.bak`), "today's config isn't touched");
  again.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

test("an unreadable settings.json is never overwritten: saving and moving settings both wait", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-test-"));
  const config = path.join(home, "config.toml");
  const file = path.join(home, "settings.json");
  fs.writeFileSync(config, `poll_seconds = 300\n\n${defaultConfigText({ workOrgs: ["acme"] })}`);
  fs.writeFileSync(file, "{ oops");
  const desk = new Desk({ home, github: new FakeGitHub([], () => []), now: () => NOW, notify: () => {}, log: () => {} });
  await desk.init();
  assert.match(fs.readFileSync(config, "utf8"), /^poll_seconds = 300/);
  assert.equal(desk.store.get("settings_migrated"), null);
  assert.ok(desk.loaded);
  assert.deepEqual(
    desk.configWarnings.map((w) => w.path),
    ["poll_seconds"],
  );
  const r = desk.putSettings({ set: { "notify.enabled": false } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, [
    { path: "settings.json", message: "settings.json can't be read, so saving now would overwrite it. Fix or delete the file first." },
  ]);
  assert.equal(fs.readFileSync(file, "utf8"), "{ oops");
  desk.stop();
  fs.rmSync(home, { recursive: true });
});

test("settings move once: leftovers in config.toml only warn, and a later reset sticks", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-test-"));
  const config = path.join(home, "config.toml");
  const legacy = `poll_seconds = 300\n\n${defaultConfigText({ workOrgs: ["acme"] })}`;
  fs.writeFileSync(config, legacy);
  const open = async () => {
    const d = new Desk({ home, github: new FakeGitHub([], () => []), now: () => NOW, notify: () => {}, log: () => {} });
    await d.init();
    return d;
  };
  let desk = await open();
  assert.equal(desk.settings["github.poll_seconds"], 300);
  desk.putSettings({ reset: ["github.poll_seconds"] });
  await idle(desk);
  desk.stop();
  fs.writeFileSync(config, legacy); // e.g. restored from a backup
  desk = await open();
  assert.equal(desk.settings["github.poll_seconds"], 90);
  assert.deepEqual(desk.configErrors, []);
  assert.ok(desk.loaded);
  assert.deepEqual(desk.getConfig().warnings, [
    { path: "poll_seconds", message: '"poll_seconds" moved to Settings (settings.json); delete it here' },
  ]);
  desk.stop();
  fs.rmSync(home, { recursive: true });
});

test("a config saved after the first start can't set settings: the agent-reachable command stays put", async (c) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-test-"));
  const desks: Desk[] = [];
  c.after(() => {
    for (const d of desks) d.stop();
    fs.rmSync(home, { recursive: true });
  });
  const open = async () => {
    const d = new Desk({ home, github: new FakeGitHub([], () => []), now: () => NOW, notify: () => {}, log: () => {} });
    desks.push(d);
    await d.init();
    return d;
  };
  const first = await open();
  const r = first.putConfig(`${first.getConfig().text}\n[analyze]\ncommand = "/tmp/not-claude"\n`, first.getConfig().hash);
  assert.deepEqual(
    [r.ok, r.errors.map((e) => e.path)],
    [false, ["analyze"]],
    "refused, so a desk that hasn't moved its settings yet can't take it at the next start",
  );
  await idle(first);
  first.stop();
  const desk = await open();
  assert.ok(!("analyze.command" in desk.settings), "no Claude command setting: every agent is claude from PATH");
});

test("settings that change the searches sync right away", async () => {
  const t = await setup([]);
  await t.desk.sync();
  assert.ok(!t.gh.searches.some((q) => q.includes("author:bob")));
  t.desk.putSettings({ set: { "github.close_collaborator_min": 1 } });
  await idle(t.desk);
  assert.ok(t.gh.searches.some((q) => q.endsWith("author:alice author:bob")));
  // Anything else applies to what the desk has: no new pass over GitHub.
  const before = t.gh.searches.length;
  t.desk.putSettings({ set: { "policy.judge": false, "notify.quiet": "", "github.my_repos": ["acme/web"] } });
  await idle(t.desk);
  assert.equal(t.gh.searches.length, before);
  t.cleanup();
});

test("a new sync interval re-arms the pending poll", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] });
  const t = await setup([]);
  t.desk.start();
  await idle(t.desk);
  t.desk.putSettings({ set: { "github.poll_seconds": 30 } });
  await idle(t.desk);
  const before = t.gh.searches.length;
  ctx.mock.timers.tick(30_000);
  await idle(t.desk);
  assert.ok(t.gh.searches.length > before, "polled after 30s, not the old 90s");
  t.cleanup();
});

// ---------------------------------------------------------------- Blocked

// The live example: getsentry#22982 and #22983 require sentry#129460, yours, which waits on your reply to markstory (he spoke
// last on two open threads after his COMMENTED review) and on reviews from cvxluo, skaasten and 6 teams.
const LIVE = "getsentry/sentry#129460";
const WAITS = "waits on your reply to markstory, then a review from cvxluo, skaasten and 6 more";
const said = (author: string, h: number) => ({ author, author_bot: false, at: hoursAgo(h), resolved: false });
const review = (author: string, state: "approved" | "changes_requested" | "commented", h = 45) => ({
  author,
  author_bot: false,
  trusted: true,
  state,
  at: hoursAgo(h),
  commit: "abc",
});
const root = (o: Partial<Item> = {}) =>
  makeItem({
    repo: "getsentry/sentry",
    number: 129460,
    author: "me",
    head_author: "me",
    created_at: hoursAgo(70),
    review_requests: [
      { reviewer: "cvxluo", type: "user", codeowner: false },
      { reviewer: "skaasten", type: "user", codeowner: false },
      ...["issues", "owners-auth", "security", "issue-detection-backend", "issues-feed", "backend"].map((reviewer) => ({
        reviewer,
        type: "team" as const,
        codeowner: true,
      })),
    ],
    reviews: [review("markstory", "commented", 30)],
    threads_total: 5,
    threads_unresolved: 5,
    thread_last: [said("markstory", 29), said("markstory", 28), said("me", 27), said("me", 26), said("me", 25)],
    ...o,
  });
// Yours, approved by a collaborator, CI green, no comments, nobody asked any more.
const dependent = (n: number, o: Partial<Item> = {}) =>
  makeItem({
    repo: "getsentry/getsentry",
    number: n,
    author: "me",
    head_author: "me",
    created_at: hoursAgo(60 - (n % 10)),
    review_decision: "approved",
    reviews: [review("kofi", "approved")],
    requires: [LIVE],
    ...o,
  });
const QUIET = { "policy.judge": false, "notify.quiet": "" };
const merge = (t: Awaited<ReturnType<typeof setup>>, id: string, h: number) => {
  t.setNow(new Date(NOW.getTime() + h * 3_600_000));
  const at = new Date(NOW.getTime() + h * 3_600_000).toISOString();
  t.gh.items.set(id, { ...t.gh.items.get(id)!, state: "merged", closed_at: at, updated_at: at });
};
const back = (cs: Card[]) => cs.filter((x) => x.group === "back").map((x) => [x.id, x.why]);

test("Blocked: getsentry#22982 and #22983, handed back while sentry#129460 waits on a reply and reviews, wait in Blocked; when it merges they're back to you, unblocked, with one notification", async (c) => {
  const t = await setup([dependent(22982), dependent(22983), root()], { settings: QUIET });
  c.after(t.cleanup);
  t.desk.coordinator.wake = () => {};
  await t.desk.sync();
  const why = "CI can't pass until getsentry/sentry#129460 merges";
  for (const id of ["getsentry#22982", "getsentry#22983"]) {
    t.desk.act(id, "inflight");
    t.desk.handBack(id, why);
  }
  let q = t.desk.queue();
  assert.deepEqual(back(q.sections.now), [], "not back to you while #129460 blocks them");
  assert.deepEqual(
    q.sections.blocked.map((x) => [x.id, x.why, x.stage]),
    [
      ["getsentry/getsentry#22982", `blocked by sentry#129460, which ${WAITS}`, "blocked"],
      ["getsentry/getsentry#22983", "blocked by sentry#129460", "blocked"],
    ],
  );
  assert.deepEqual(
    q.sections.today.map((x) => [x.id, x.why, x.cta]),
    [[LIVE, `blocks getsentry#22982 and getsentry#22983; it ${WAITS}`, "reply"]],
  );
  assert.deepEqual(t.notes, []);

  merge(t, LIVE, 1);
  await t.desk.sync();
  await t.desk.sync();
  q = t.desk.queue();
  const unblocked = `unblocked: sentry#129460 merged \u00b7 handed back: ${why}`;
  assert.deepEqual(back(q.sections.now), [
    ["getsentry/getsentry#22982", unblocked],
    ["getsentry/getsentry#22983", unblocked],
  ]);
  assert.deepEqual(q.sections.blocked, []);
  assert.deepEqual(t.notes, ["2 need you: getsentry#22982, getsentry#22983"]);
  const events = t.desk.store.activity({ after: 0, limit: 100 }).filter((e) => e.kind === "unblocked");
  assert.deepEqual(
    events.map((e) => [e.item_id, e.data.merged]),
    [
      ["getsentry/getsentry#22982", "sentry#129460"],
      ["getsentry/getsentry#22983", "sentry#129460"],
    ],
  );
});

test("Blocked: sentry#129460 once your push changed the code under markstory's last words: no Reply, it waits on its reviews, and the review has nothing waiting on you", async (c) => {
  const stale = (h: number) => ({ ...said("markstory", h), outdated: true });
  const pushed = { head_committed_at: hoursAgo(1), updated_at: hoursAgo(0) };
  const t = await setup([root({ ...pushed, thread_last: [stale(29), stale(28), said("me", 27), said("me", 26), said("me", 25)] })], {
    settings: QUIET,
  });
  c.after(t.cleanup);
  const say = (id: string, h: number) => ({
    id,
    author: "markstory",
    bot: false,
    body: "Do we need the primary here?",
    at: hoursAgo(h),
    url: "",
  });
  const thread = (id: string, h: number) => ({
    id,
    resolved: false,
    outdated: true,
    path: "src/sentry/auth/access.py",
    line: null,
    side: "old" as const,
    hunk: "",
    comments: [say(id, h)],
  });
  t.gh.contexts.set("PR_getsentry/sentry_129460", {
    threads: [thread("PRRT_a", 29), thread("PRRT_b", 28)],
    reviews: [],
    comments: [],
    commits: [],
  });
  await t.desk.sync();
  const q = t.desk.queue();
  assert.deepEqual(
    q.sections.blocked.map((x) => [x.id, x.why, x.cta ?? null]),
    [[LIVE, "waits on a review from cvxluo, skaasten and 6 more", null]],
  );
  assert.deepEqual([...q.sections.now, ...q.sections.today], []);
  assert.deepEqual(
    (await t.desk.convos.list(LIVE)).map((x) => [x.id, x.waiting_on_you]),
    [
      ["PRRT_a", false],
      ["PRRT_b", false],
    ],
  );
});

test("A review asked of you by name that requires an open PR waits in Blocked; once that PR merges it's in Now, notified", async (c) => {
  const ask = reviewAsk(9, { requires: ["acme/api#5"] });
  const t = await setup([ask], { settings: QUIET });
  c.after(t.cleanup);
  // carol's own PR, on no board: kai has looked, nobody has approved.
  const five = makeItem({ number: 5, author: "carol", reviews: [{ ...review("kai", "commented"), commit: "x" }] });
  t.desk.store.putItems([five], NOW.toISOString(), true);
  await t.desk.sync();
  let q = t.desk.queue();
  assert.deepEqual(
    q.sections.now.map((x) => x.id),
    [],
  );
  assert.deepEqual(
    q.sections.blocked.map((x) => [x.id, x.why]),
    [["acme/api#9", "blocked by api#5, which waits on a review"]],
  );
  const at = new Date(NOW.getTime() + 3_600_000).toISOString();
  t.desk.store.putItems([{ ...five, state: "merged", closed_at: at, updated_at: at }], at, true);
  t.setNow(new Date(at));
  await t.desk.sync();
  q = t.desk.queue();
  assert.deepEqual(
    q.sections.now.map((x) => [x.id, x.why]),
    [["acme/api#9", "carol asked you directly"]],
  );
  assert.equal(t.notes.at(-1), "api#9 \u00b7 carol asked you directly");
});

test("A review asked of you by name whose description names an open PR in another org stays in Now", async (c) => {
  const t = await setup([reviewAsk(9, { requires: ["evilcorp/api#5"] })], { settings: QUIET });
  c.after(t.cleanup);
  t.desk.store.putItems([makeItem({ repo: "evilcorp/api", number: 5, author: "carol" })], NOW.toISOString(), true);
  await t.desk.sync();
  const q = t.desk.queue();
  assert.deepEqual([q.sections.now.map((x) => [x.id, x.why]), q.sections.blocked], [[["acme/api#9", "carol asked you directly"]], []]);
});

test("A change request or a reply you owe on a blocked PR is yours: not in Blocked, and its hand-back isn't held", async (c) => {
  const needs = { requires: ["acme/web#100"] };
  const t = await setup(
    [
      myPr(100, { ci: "green", created_at: hoursAgo(80) }),
      myPr(1, { ...needs, ci: "green", review_decision: "changes_requested", reviews: [review("kofi", "changes_requested")] }),
      myPr(2, { ...needs, ci: "green", threads_unresolved: 1, thread_last: [said("priya", 1)] }),
      myPr(3, { ...needs, draft: true }),
    ],
    { settings: QUIET },
  );
  c.after(t.cleanup);
  await t.desk.sync();
  t.desk.act("web#1", "inflight");
  t.desk.handBack("web#1", "kofi wants a different retry budget");
  const q = t.desk.queue();
  assert.equal(
    q.sections.today.some((x) => x.id === "acme/web#3"),
    false,
    "your fresh draft waits on web#100 too",
  );
  assert.deepEqual(back(q.sections.now), [["acme/web#1", "handed back: kofi wants a different retry budget"]]);
  assert.deepEqual(
    q.sections.blocked.map((x) => [x.id, x.why]),
    [
      ["acme/web#100", "waits on a review from dana"],
      ["acme/web#3", "blocked by web#100"],
    ],
    "a reply you owe keeps web#2 out; web#100's own row says what it waits on",
  );
});

test("Done on a Blocked row: it comes back when the PR it waits on merges", async (c) => {
  const t = await setup([dependent(22982), root()], { settings: QUIET });
  c.after(t.cleanup);
  await t.desk.sync();
  t.desk.act("getsentry#22982", "done");
  const all = () => Object.values(t.desk.queue().sections).flat();
  assert.equal(
    all().some((x) => x.id === "getsentry/getsentry#22982"),
    false,
  );
  merge(t, LIVE, 1);
  await t.desk.sync();
  assert.deepEqual(
    t.desk.queue().sections.today.map((x) => [x.id, x.why]),
    [["getsentry/getsentry#22982", "approved and green: ready to merge"]],
  );
  assert.equal(t.notes.at(-1), "getsentry#22982 \u00b7 approved and green: ready to merge");
});

test("Done or a snooze after the PR it needs merged sticks, from a description or a retargeted stack", async (c) => {
  const t = await setup(
    [
      dependent(22982),
      root(),
      myPr(1, { ci: "green", head_ref: "change-1" }),
      myPr(2, { ci: "green", head_ref: "change-2", base: "change-1" }),
    ],
    { settings: QUIET },
  );
  c.after(t.cleanup);
  await t.desk.sync();
  merge(t, LIVE, 1);
  merge(t, "acme/web#1", 1);
  const at = new Date(NOW.getTime() + 3_600_000).toISOString();
  t.gh.items.set("acme/web#2", {
    ...t.gh.items.get("acme/web#2")!,
    base: "main",
    retargeted: { from: "change-1", at },
    updated_at: hoursAgo(5),
  });
  await t.desk.sync();
  t.setNow(new Date(NOW.getTime() + 2 * 3_600_000));
  const where = (id: string) =>
    Object.entries(t.desk.queue().sections)
      .filter(([, cs]) => cs.some((x) => x.id === id))
      .map(([s]) => s);
  t.desk.act("getsentry#22982", "done");
  t.desk.act("web#2", "done");
  assert.deepEqual([where("getsentry/getsentry#22982"), where("acme/web#2")], [[], []]);
  t.desk.act("getsentry#22982", "snooze", "3h");
  assert.deepEqual(where("getsentry/getsentry#22982"), []);
});

test("Blocked by the template: your PRs waiting on reviews, the latest ask as their age; what's yours to do stays out", async (c) => {
  const asked = (reviewer: string, at: number, type: "user" | "team" = "user") => ({
    review_requests: [{ reviewer, type, codeowner: false }],
    request_events: [{ at: hoursAgo(at), actor: "me", actor_bot: false, reviewer, reviewer_type: type }],
  });
  const t = await setup(
    [
      myPr(1, { ci: "green", ...asked("dana", 30) }),
      myPr(2, {
        ci: "pending",
        review_requests: [
          { reviewer: "sam", type: "user", codeowner: false },
          { reviewer: "backend", type: "team", codeowner: false },
          { reviewer: "kai", type: "user", codeowner: false },
        ],
      }),
      myPr(3, { ci: "green", ...asked("dana", 5), comments: [{ author: "priya", author_bot: false, at: hoursAgo(1) }] }),
      myPr(5, { ci: "green", review_decision: "changes_requested", reviews: [review("kofi", "changes_requested", 20)] }),
      myPr(6, { ci: "red", ...asked("dana", 5) }),
      myPr(7, { ci: "green", ...asked("eve", 10) }),
      myPr(8, { ci: "green", head_ref: "planner-a", ...asked("dana", 40) }),
      myPr(9, { ci: "green", head_ref: "planner-b", base: "planner-a", ...asked("sam", 2) }),
    ],
    { settings: QUIET },
  );
  c.after(t.cleanup);
  await t.desk.sync();
  t.desk.act("web#7", "inflight");
  const q = t.desk.queue();
  assert.equal(
    q.sections.later.some((x) => x.id === "acme/web#1"),
    false,
    "Blocked, not Later",
  );
  const b = q.sections.blocked;
  assert.deepEqual(
    b.map((x) => [x.id, x.why, x.waiting_since]),
    [
      ["acme/web#2", "waits on a review from sam, @backend and 1 more", hoursAgo(48)],
      ["acme/web#8", "waits on a review from dana", hoursAgo(40)],
      ["acme/web#1", "waits on a review from dana", hoursAgo(30)],
    ],
    "a reply owed (web#3), changes requested (web#5), red CI (web#6) and Merging's web#7 waiting on a review stay out",
  );
  assert.deepEqual([b[1]!.stack?.folded, b[1]!.blocks], [["acme/web#9"], ["web#9"]], "web#8 stands for its stack");
});

test("Merging's PRs another PR blocks are on Blocked, in their chain, marked in Merging", async (c) => {
  const t = await setup([dependent(22982), dependent(22983), root()], { settings: QUIET });
  c.after(t.cleanup);
  t.desk.coordinator.wake = () => {};
  await t.desk.sync();
  t.desk.act("getsentry#22983", "inflight");
  const q = t.desk.queue();
  assert.equal(
    q.sections.today.some((x) => x.id === "getsentry/getsentry#22982"),
    false,
    "approved and green, but it can't merge before sentry#129460",
  );
  assert.deepEqual(
    q.sections.blocked.map((x) => [x.id, x.why, x.inflight]),
    [
      ["getsentry/getsentry#22982", `blocked by sentry#129460, which ${WAITS}`, false],
      ["getsentry/getsentry#22983", "in Merging \u00b7 blocked by sentry#129460", true],
    ],
  );
  const elsewhere = [...q.sections.now, ...q.sections.today, ...q.sections.later, ...q.sections.fyi, ...q.hidden, ...q.cleared];
  assert.equal(
    elsewhere.some((x) => x.id === "getsentry/getsentry#22983"),
    false,
  );
  assert.deepEqual(
    t.desk.inflight().rows.map((r) => [r.card.id, r.waits_on]),
    [["getsentry/getsentry#22983", "waits on sentry#129460 to merge first"]],
  );
});

test("a hand-back of a PR only waiting on reviewers isn't held, and a hand-back never held never says unblocked", async (c) => {
  const t = await setup(
    [myPr(1, { ci: "green", reviews: [review("kofi", "commented")] }), myPr(2, { ci: "green", requires: ["acme/api#77"] })],
    {
      settings: QUIET,
    },
  );
  c.after(t.cleanup);
  t.desk.coordinator.wake = () => {};
  await t.desk.sync();
  assert.equal(
    t.desk.queue().sections.later.some((x) => x.id === "acme/web#1"),
    false,
    "it waits on reviews: Blocked, not Later",
  );
  for (const n of [1, 2]) {
    t.desk.act(`web#${n}`, "inflight");
    t.desk.handBack(`web#${n}`, "needs your call");
  }
  // web#2's dependency merged after the hand-back, while the desk never saw it open.
  const at = new Date(NOW.getTime() + 3_600_000).toISOString();
  t.desk.store.putItems([makeItem({ number: 77, state: "merged", closed_at: at, updated_at: at })], at, true);
  t.setNow(new Date(at));
  await t.desk.sync();
  assert.deepEqual(back(t.desk.queue().sections.now), [
    ["acme/web#1", "handed back: needs your call"],
    ["acme/web#2", "handed back: needs your call"],
  ]);
});

test("the nobody's-asked hoist, handBackUnasked and rebaseConflicts skip a blocked PR", async (c) => {
  const needs = { requires: ["acme/web#100"] };
  const ready: Partial<Item> = { ci: "green", review_decision: "approved", reviews: [review("kofi", "approved")] };
  const t = await setup(
    [
      myPr(100, { ci: "green" }),
      myPr(1, { ...needs, ci: "green", review_requests: [] }),
      myPr(2, { ...needs, ci: "green" }),
      myPr(3, { ...needs, ...ready, mergeable: "conflict" }),
    ],
    { settings: QUIET },
  );
  c.after(t.cleanup);
  t.desk.store.set("coordinator_bg", { id: "c0ffee01", url: "https://claude.ai/code/session_01Fakec0ffee01" });
  t.desk.coordinator.wake = () => {};
  t.desk.coordinator.stop = async () => {};
  await t.desk.sync();
  t.desk.act("web#2", "inflight");
  t.desk.act("web#3", "pin");
  t.gh.items.set("acme/web#2", { ...t.gh.items.get("acme/web#2")!, review_requests: [], updated_at: hoursAgo(1) });
  await t.desk.sync();
  const q = t.desk.queue();
  assert.equal(
    q.sections.now.some((x) => x.id === "acme/web#1"),
    false,
    "not hoisted: it can't merge before web#100 anyway",
  );
  assert.equal(t.desk.merging("acme/web#2").handback, undefined, "Merging keeps it");
  assert.equal(t.desk.merging("acme/web#3").rebase, undefined, "a blocked PR isn't ready to merge");
});

test("trackBlocked: the first run logs nothing; becoming blocked logs 'blocked by \u2026'; its blocker follows a change; kv blocked's since is the Blocked row's age", async (c) => {
  const t = await setup([myPr(100, { ci: "green" }), myPr(1, { ci: "green", requires: ["acme/web#100"] }), myPr(2, { ci: "green" })], {
    settings: QUIET,
  });
  c.after(t.cleanup);
  const kinds = () => t.desk.store.activity({ after: 0, limit: 100 }).filter((e) => e.kind === "blocked" || e.kind === "unblocked");
  await t.desk.sync();
  assert.deepEqual(kinds(), []);
  assert.deepEqual(t.desk.store.get("blocked"), { "acme/web#1": { since: hoursAgo(48), by: "web#100" } });

  t.setNow(new Date(NOW.getTime() + 3_600_000));
  const later = new Date(NOW.getTime() + 3_600_000).toISOString();
  t.gh.items.set("acme/web#2", { ...t.gh.items.get("acme/web#2")!, requires: ["acme/web#100"], updated_at: later });
  t.gh.items.set("acme/web#1", { ...t.gh.items.get("acme/web#1")!, requires: ["acme/web#101"], updated_at: later });
  t.gh.items.set("acme/web#101", myPr(101, { ci: "green" }));
  await t.desk.sync();
  assert.deepEqual(
    kinds().map((e) => [e.item_id, e.kind, e.data.by]),
    [["acme/web#2", "blocked", "web#100"]],
    "web#1 was blocked already",
  );
  assert.deepEqual(t.desk.store.get("blocked"), {
    "acme/web#1": { since: hoursAgo(48), by: "web#101" },
    "acme/web#2": { since: later, by: "web#100" },
  });
  const rows = Object.fromEntries(t.desk.queue().sections.blocked.map((x) => [x.id, x.waiting_since]));
  assert.deepEqual([rows["acme/web#1"], rows["acme/web#2"]], [hoursAgo(48), later]);
});

test("a dependency closed without merging puts your PR in Today: needs X, closed without merging", async (c) => {
  const t = await setup([myPr(1, { ci: "green", requires: ["acme/api#66"] })], { settings: QUIET });
  c.after(t.cleanup);
  t.desk.store.putItems([makeItem({ number: 66, state: "closed", closed_at: hoursAgo(3) })], NOW.toISOString(), true);
  await t.desk.sync();
  assert.deepEqual(
    t.desk.queue().sections.today.map((x) => [x.id, x.why]),
    [["acme/web#1", "needs api#66, closed without merging"]],
  );
});

test("the coordinator's desk_add is its opinion: no Today floor; on no other board it's on Added; anyone else's desk_add is your pin", async (c) => {
  const needs = (n: number) => myPr(n, { ci: "green", requires: ["acme/web#100"] });
  const t = await setup([myPr(100, { ci: "green" }), needs(1), needs(2)], { settings: QUIET });
  c.after(t.cleanup);
  await t.desk.sync();
  const coordinator = "Review Desk coordinator";
  await t.desk.add("acme/web#1", "waits on web#100: no review in 3 days", coordinator);
  let q = t.desk.queue();
  assert.equal(
    q.sections.today.some((x) => x.id === "acme/web#1"),
    false,
    "no floor: the rule's Blocked keeps it",
  );
  assert.deepEqual(
    q.sections.blocked.filter((x) => x.id === "acme/web#1").map((x) => x.handoff),
    [{ why: "waits on web#100: no review in 3 days", from: coordinator }],
  );
  t.gh.items.set("acme/api#6", makeItem({ number: 6, author: "carol" }));
  await t.desk.add("acme/api#6", "carol's fix for the flaky retry", coordinator);
  await t.desk.add("acme/web#2", "needs your call on the retry budget", "seer fix");
  q = t.desk.queue();
  assert.deepEqual(
    q.sections.today.map((x) => [x.id, x.board, x.why]),
    [
      ["acme/api#6", "added", "you added it"],
      ["acme/web#2", "acme-mine", "blocked by web#100, which waits on a review from dana"],
    ],
    "on no other board it's on Added; anyone else's desk_add is your pin, which lifts it to Today",
  );
});

test("a coordinator's desk_add on no other board stays on Added after you act on it: in the Archive while done, back in Today on activity", async (c) => {
  const t = await setup([], { settings: QUIET });
  c.after(t.cleanup);
  t.gh.items.set("acme/api#77", makeItem({ number: 77, author: "carol" }));
  await t.desk.sync();
  await t.desk.add("acme/api#77", "carol's fix for the flaky retry", "Review Desk coordinator");
  t.desk.act("api#77", "done");
  let q = t.desk.queue();
  assert.deepEqual(
    q.cleared.map((x) => [x.id, x.status]),
    [["acme/api#77", "done"]],
  );
  const at = new Date(NOW.getTime() + 3_600_000).toISOString();
  t.setNow(new Date(at));
  t.gh.items.set("acme/api#77", {
    ...t.gh.items.get("acme/api#77")!,
    updated_at: at,
    comments: [{ author: "carol", author_bot: false, at }],
  });
  await t.desk.sync();
  q = t.desk.queue();
  assert.deepEqual(
    q.sections.today.map((x) => [x.id, x.board]),
    [["acme/api#77", "added"]],
  );
});
