import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfigText } from "../src/config.ts";
import { Desk, parseUntil } from "../src/desk.ts";
import type { Context } from "../src/types.ts";
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
    mine.sections.now.map((c) => c.id),
    ["acme/web#3"],
  );
  assert.ok(mine.sections.now[0]?.chips.includes("CI red"));

  const focus = t.desk.focus();
  assert.deepEqual(focus.sections.now.map((c) => c.id).sort(), ["acme/api#1", "acme/web#3"]);
  assert.equal(t.desk.status().text, "desk ●2");
  const ov = t.desk.overview();
  assert.equal(ov.me, "me");
  assert.equal(ov.focus.now, 2);
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

test("notifies only for new NOW entries after the first sync", async () => {
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

test("close_authors expands within GitHub's 256-char query limit", async () => {
  const t = await setup([]);
  t.desk.ctx!.affinity = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`collaborator-${i}`, 50 - i]));
  const q = t.desk.gh.expandQuery("is:pr is:open archived:false -is:draft -author:@me -review-requested:@me {close_authors}", "org:acme")!;
  assert.ok(q.length <= 256);
  assert.match(q, /author:collaborator-0 author:collaborator-1/);
  t.desk.ctx!.affinity = {};
  assert.equal(t.desk.gh.expandQuery("is:pr {close_authors}", ""), null);
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

test("your PR's card says what failed, and leaves out a next step its keys already say", async () => {
  const t = await setup([
    myPr(3, { checks_failed: ["Acceptance", "(Optional) schema diff"], checks_optional: ["(Optional) schema diff"] }),
    myPr(4, { ci: "green", review_decision: "approved", mergeable: "clean" }),
  ]);
  await t.desk.sync();
  const q = t.desk.queue();
  const of = (id: string) => [...q.sections.now, ...q.sections.today].find((c) => c.id === id);
  assert.deepEqual(
    [of("acme/web#3")?.checks_failed, of("acme/web#3")?.checks_optional],
    [["Acceptance", "(Optional) schema diff"], ["(Optional) schema diff"]],
  );
  assert.ok(of("acme/web#4"), "approved and green is on the queue");
  assert.equal(of("acme/web#4")?.next, undefined, "o on its keys opens it to merge");
  t.cleanup();
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

test("a stored Claude model from before is ignored: no settings problem, and the next save drops it", async () => {
  const t = await setup([reviewAsk(1)], { settings: { "analyze.model": "sonnet", "notify.enabled": false } });
  assert.deepEqual(t.desk.getSettings().errors, []);
  assert.equal(t.desk.settings["notify.enabled"], false);
  assert.equal(t.desk.putSettings({ set: { "github.poll_seconds": 120 } }).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(t.home, "settings.json"), "utf8")), {
    "github.poll_seconds": 120,
    "notify.enabled": false,
  });
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
  assert.deepEqual(q.sections.now.map((c) => c.id).sort(), ["acme/api#1", "acme/web#3"]);
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

test("what the coordinator cleared says so, with its reason, until something else acts on it", async () => {
  const t = await setup([reviewAsk(1), reviewAsk(2)]);
  await t.desk.sync();
  t.desk.act("api#1", "snooze", "tomorrow", { agent: "coordinator", reason: "a CODEOWNERS ping" });
  t.desk.act("api#2", "snooze", "tomorrow");
  const by = () => Object.fromEntries(t.desk.queue().cleared.map((c) => [c.id, c.cleared_by_coordinator]));
  assert.deepEqual(by(), { "acme/api#1": "a CODEOWNERS ping", "acme/api#2": undefined });
  t.desk.act("api#1", "mute");
  assert.equal(by()["acme/api#1"], undefined, "your own action since is the one in effect");
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

test("your PR's card carries who last spoke on it; nobody asked you by name says so", async () => {
  const t = await setup([
    myPr(3, { ci: "green", threads_unresolved: 2 }),
    reviewAsk(4, { review_requests: [{ reviewer: "ml-team", type: "team", codeowner: true }] }),
  ]);
  await t.desk.sync();
  t.gh.items.set("acme/web#3", {
    ...t.gh.items.get("acme/web#3")!,
    comments: [{ author: "priya", author_bot: false, at: hoursAgo(0.2) }],
    updated_at: hoursAgo(0.2),
  });
  await t.desk.sync();
  const q = t.desk.queue();
  const all = [...q.sections.now, ...q.sections.today, ...q.sections.later, ...q.sections.fyi];
  const mine = all.find((c) => c.id === "acme/web#3");
  assert.deepEqual([mine?.last_event?.kind, mine?.last_event?.actor], ["commented", "priya"]);
  assert.equal(all.find((c) => c.id === "acme/api#4")?.team_ask, "CODEOWNERS ping to @ml-team");
  t.cleanup();
});

test("quiet items drop out of Now and Today: your old conflicting PRs go to Later; a PR in flight that needs you stays", async () => {
  const days = (d: number) => hoursAgo(d * 24);
  const t = await setup([
    myPr(20631, { ci: "green", mergeable: "conflict", updated_at: days(143) }),
    myPr(548, { ci: "green", mergeable: "conflict", updated_at: days(20) }),
    myPr(7, { ci: "green", mergeable: "conflict" }),
    myPr(8, { ci: "red", updated_at: days(30) }),
    reviewAsk(1, { updated_at: days(30) }),
  ]);
  await t.desk.sync();
  t.desk.act("web#8", "inflight");
  t.desk.putSettings({ set: { "inflight.babysit": false } }); // so web#8 needs you: nobody else will fix its CI
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
    [
      ["acme/web#8", "in flight: CI failing"],
      ["acme/api#1", "carol asked you directly"],
    ],
    "the ask came an hour ago, so it isn't quiet whatever updated_at says",
  );
  assert.deepEqual(
    q.sections.today.map((c) => [c.id, c.next]),
    [["acme/web#7", "merge conflict with main: d puts it in flight"]],
  );
  assert.equal(q.sections.now[0]?.next, undefined, "its why says it, and Enter on its keys opens the lane");

  t.desk.putSettings({ set: { "queue.quiet_days": 0, "inflight.babysit": true } });
  assert.deepEqual(
    t.desk
      .queue()
      .sections.today.map((c) => c.id)
      .sort(),
    ["acme/web#20631", "acme/web#548", "acme/web#7"],
  );
  assert.equal(
    t.desk.queue().sections.today.find((c) => c.id === "acme/web#7")?.next,
    "merge conflict with main: d hands it to a babysitter",
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
