import assert from "node:assert/strict";
import { test } from "node:test";
import { settingDef } from "../../src/settings.ts";
import type {
  ActivityEvent,
  Card,
  CoordinatorLogEntry,
  CoordinatorStatus,
  JudgeStatus,
  QueueView,
  ReviewHunk,
  ReviewOrder,
} from "../../src/types.ts";
import { age, ago, clearedText, eventText, modelName, shortId, shortRef, tilde } from "../src/format.ts";
import {
  acceleratorOf,
  actedText,
  authProblem,
  cardFacts,
  coordinatorText,
  currentFile,
  DEFAULT_OPEN,
  draftOf,
  foldOf,
  groupsOf,
  judgeStatusText,
  judgeStepText,
  laneFacts,
  waitsOn,
  lineOf,
  logText,
  policyLines,
  navigable,
  noCloneOf,
  onLines,
  parseList,
  parseRoute,
  removeCard,
  resolvedHead,
  routeHash,
  says,
  sections,
  sitterParts,
  stops,
  valueOf,
  waitingText,
  type KeyLike,
} from "../src/view.ts";

const card = (id: string, extra: Partial<Card> = {}): Card => {
  const [repo = "", n] = id.split("#");
  return {
    id,
    kind: "pr",
    repo,
    number: Number(n),
    title: `title ${id}`,
    url: "",
    author: "dana",
    author_bot: false,
    bucket: "now",
    why: "",
    board: "b",
    boards: ["b"],
    chips: [],
    ci: "green",
    review: "required",
    draft: false,
    size: 1,
    created_at: "",
    updated_at: "",
    activity_at: "",
    waiting_since: "",
    new: false,
    pinned: false,
    status: "active",
    snooze_until: null,
    verdict: null,
    resolved: null,
    resolved_at: null,
    inflight: false,
    ...extra,
  };
};

const queue = (): QueueView => ({
  sections: { now: [card("acme/api#1")], today: [card("acme/web#2", { author: "priya" })], later: [card("acme/api#3")], fyi: [] },
  hidden: [card("acme/api#4")],
  cleared: [card("acme/api#5", { status: "muted" })],
  resolved: [card("acme/api#6", { resolved: "merged", why: "merged" })],
  cards: 10,
  paused: null,
  babysitting: true,
  stacks: {},
});

test("routes round-trip through the hash", () => {
  assert.deepEqual(parseRoute(""), { name: "queue" });
  assert.deepEqual(parseRoute("#/focus"), { name: "queue" });
  assert.deepEqual(parseRoute("#/settings"), { name: "settings", section: "github" });
  assert.deepEqual(parseRoute("#/settings/handoff"), { name: "settings", section: "handoff" });
  assert.deepEqual(parseRoute("#/rules"), { name: "settings", section: "rules" });
  assert.equal(routeHash({ name: "settings", section: "rules" }), "#/settings/rules");
  assert.deepEqual(parseRoute(routeHash({ name: "settings", section: "app" })), { name: "settings", section: "app" });
  assert.equal(routeHash({ name: "queue" }), "#/");
  assert.deepEqual(parseRoute("#/settings/"), { name: "settings", section: "github" });
  assert.deepEqual(parseRoute("#/inflight"), { name: "inflight" });
  assert.equal(routeHash({ name: "inflight" }), "#/inflight");
  assert.deepEqual(parseRoute(routeHash({ name: "later" })), { name: "later" });
});

test("an in-flight row's status in plain words", () => {
  const row = {
    ci: "red" as const,
    failing: ["test (3.12)", "lint"],
    approved_by: ["marco"],
    changes_by: ["dana"],
    waiting_on: ["sam", "@backend"],
    threads_unresolved: 2,
    mergeable: "conflict" as const,
    draft: false,
  };
  // The same words and colours as the queue and the review: red for CI, amber for changes requested and a conflict.
  assert.deepEqual(laneFacts(row), [
    { text: "CI failing: test (3.12), lint", tone: "bad" },
    { text: "approved by marco", tone: "" },
    { text: "changes requested by dana", tone: "warn" },
    { text: "waiting on sam, @backend", tone: "" },
    { text: "2 unresolved threads", tone: "" },
    { text: "merge conflict", tone: "warn" },
  ]);
  assert.deepEqual(
    laneFacts({
      ...row,
      ci: "green",
      failing: [],
      approved_by: [],
      changes_by: [],
      waiting_on: [],
      threads_unresolved: 1,
      mergeable: "clean",
    }).map((f) => f.text),
    ["CI passing", "1 unresolved thread"],
  );
  assert.deepEqual(
    laneFacts({
      ...row,
      ci: "pending",
      failing: [],
      approved_by: [],
      changes_by: [],
      waiting_on: [],
      threads_unresolved: 0,
      mergeable: "unknown",
      draft: true,
    }).map((f) => f.text),
    ["draft", "CI running"],
  );
  assert.equal(laneFacts({ ...row, failing: ["a", "b", "c"] })[0]?.text, "CI failing: a and 2 more");
  assert.equal(
    laneFacts({ ...row, failing: ["tacos-gha / TACOS Unlock (terraform/eng-tools/workflow-engine)"] })[0]?.text,
    "CI failing: tacos-gha / TACOS Unlock (terraform/eng…",
  );
  // A CODEOWNERS list of teams is a count, people first.
  const teams = ["@issue-detection-backend", "@issues-feed", "@security", "@foundations", "@owners-auth"];
  assert.ok(laneFacts({ ...row, waiting_on: ["azulus", ...teams] }).some((f) => f.text === "waiting on azulus and 5 teams"));
  assert.equal(waitingText(teams), "5 teams");
  assert.equal(waitingText(["a", "b", "c", "@t"]), "a, b and 2 more");
  assert.equal(waitingText(["a", "@t"]), "a, @t");
  assert.equal(laneFacts({ ...row, auto_merge: true }).at(-1)?.text, "auto-merge on");
});

test("what a PR in Merging waits on, while Claude has nothing to do on it and nothing needs you", () => {
  const idle = { state: "idle" as const, text: "watching", since: null };
  const r = {
    state: "open" as const,
    needs_you: null,
    sitter: idle,
    ci: "green" as const,
    approved_by: ["marco"],
    changes_by: [],
    mergeable: "clean" as const,
    draft: false,
    auto_merge: true,
  };
  assert.equal(waitsOn(r), "waits on GitHub to merge it");
  assert.equal(waitsOn({ ...r, auto_merge: false }), null, "ready to merge says itself");
  assert.equal(waitsOn({ ...r, ci: "pending" }), "waits on CI");
  assert.equal(waitsOn({ ...r, approved_by: [] }), "waits on a review");
  assert.equal(waitsOn({ ...r, changes_by: ["dana"] }), "waits on a second look");
  assert.equal(waitsOn({ ...r, approved_by: [], sitter: { ...idle, state: "running" } }), null, "Claude's line says what it's doing");
  assert.equal(waitsOn({ ...r, approved_by: [], needs_you: "reply ready to send" }), null);
  assert.equal(waitsOn({ ...r, state: "merged" }), null);
});

test("settings fields: text to value and back", () => {
  const def = (key: string) => settingDef(key)!;
  assert.deepEqual(parseList(" a \n\n b\n"), ["a", "b"]);
  assert.deepEqual(valueOf(def("github.bots"), "acme-junior\n  ci-helper \n"), ["acme-junior", "ci-helper"]);
  assert.equal(draftOf(["a", "b"]), "a\nb");
  assert.equal(draftOf([]), "");
  assert.equal(valueOf(def("github.poll_seconds"), " 120 "), 120);
  // Blank or junk numbers go to the server as null so it can say why.
  assert.equal(JSON.stringify(valueOf(def("github.poll_seconds"), "")), "null");
  assert.equal(JSON.stringify(valueOf(def("github.poll_seconds"), "1e")), "null");
  assert.equal(valueOf(def("notify.quiet"), " 19:00-09:00 "), "19:00-09:00");
  assert.equal(valueOf(def("handoff.prompt"), "line one\n  indented\n"), "line one\n  indented\n");
  assert.equal(draftOf(90), "90");
});

test("a key combo becomes an Electron accelerator", () => {
  const k = (code: string, mods: Partial<KeyLike> = {}): KeyLike => ({
    code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });
  assert.equal(acceleratorOf(k("KeyD", { ctrlKey: true, altKey: true }), true), "Control+Alt+D");
  assert.equal(acceleratorOf(k("KeyK", { metaKey: true, shiftKey: true }), true), "CommandOrControl+Shift+K");
  assert.equal(acceleratorOf(k("KeyK", { metaKey: true }), false), "Super+K");
  assert.equal(acceleratorOf(k("Digit1", { altKey: true }), true), "Alt+1");
  assert.equal(acceleratorOf(k("F12", { ctrlKey: true }), true), "Control+F12");
  assert.equal(acceleratorOf(k("Space", { ctrlKey: true, shiftKey: true }), true), "Control+Shift+Space");
  assert.equal(acceleratorOf(k("ArrowUp", { altKey: true }), true), "Alt+Up");
  assert.equal(acceleratorOf(k("Slash", { metaKey: true }), true), "CommandOrControl+/");
  // Not yet a combo: only modifiers, no modifier, Shift alone, or a key Electron can't take.
  assert.equal(acceleratorOf(k("ControlLeft", { ctrlKey: true }), true), null);
  assert.equal(acceleratorOf(k("KeyD"), true), null);
  assert.equal(acceleratorOf(k("KeyD", { shiftKey: true }), true), null);
  assert.equal(acceleratorOf(k("F25", { ctrlKey: true }), true), null);
  assert.equal(acceleratorOf(k("Numpad1", { ctrlKey: true }), true), null);
  // Whatever it builds, the server's pattern accepts.
  const re = new RegExp(settingDef("app.hotkey")!.pattern!);
  for (const a of ["Control+Alt+D", "CommandOrControl+Shift+K", "Control+Shift+Space", "Alt+Up", "CommandOrControl+/", "Control+F12"])
    assert.ok(re.test(a), a);
});

test("a babysitter's line in parts, so each sits apart", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const at = new Date(now - 24 * 60_000).toISOString();
  assert.deepEqual(sitterParts({ sitter: { state: "done", text: "pushed a fix for 3 comments · 4be71c2", since: at }, run: null }, now), [
    "pushed a fix for 3 comments",
    "4be71c2",
    "24m",
  ]);
});

test("auth problems are told apart from other GitHub errors", () => {
  assert.ok(authProblem("GitHub rejected the token (HTTP 401): run `gh auth login`"));
  assert.ok(authProblem("no GitHub token: set GITHUB_TOKEN or run `gh auth login` (exit 1)"));
  assert.ok(!authProblem("GitHub HTTP 502"));
  assert.ok(!authProblem("1 search(es) failed: author not found"));
});

const away = (gs: ReturnType<typeof groupsOf>) => gs.filter((g) => g.key !== "queue");
const main = (gs: ReturnType<typeof groupsOf>) => gs.filter((g) => g.key === "queue");

test("the queue and Later are pages of their own: Later's own group opens with it, the rest when asked; filtering opens matches", () => {
  const groups = groupsOf(queue(), DEFAULT_OPEN, "");
  assert.deepEqual(
    groups.map((g) => [g.key, g.open, g.total]),
    [
      ["queue", true, 2],
      ["later", true, 1],
      ["fyi", false, 0],
      ["resolved", false, 1],
      ["hidden", false, 1],
      ["cleared", false, 1],
    ],
  );
  assert.equal(groups.find((g) => g.key === "resolved")?.variant, "resolved");
  assert.deepEqual(
    navigable(main(groups), new Set()).map((c) => c.id),
    ["acme/api#1", "acme/web#2"],
  );
  assert.deepEqual(
    navigable(main(groups), new Set(["acme/api#1"])).map((c) => c.id),
    ["acme/web#2"],
  );
  assert.deepEqual(
    navigable(away(groups), new Set()).map((c) => c.id),
    ["acme/api#3"],
  );
  assert.deepEqual(
    navigable(away(groupsOf(queue(), { ...DEFAULT_OPEN, resolved: true }, "")), new Set()).map((c) => c.id),
    ["acme/api#3", "acme/api#6"],
  );

  const filtered = groupsOf(queue(), { ...DEFAULT_OPEN, later: false }, "api#6");
  assert.deepEqual(
    navigable(away(filtered), new Set()).map((c) => c.id),
    ["acme/api#6"],
  );
  assert.deepEqual(navigable(main(filtered), new Set()), []);
  // Opened by the filter, not by you: the toggle is off-limits until the filter clears.
  assert.deepEqual([filtered.find((g) => g.key === "resolved")?.open, filtered.find((g) => g.key === "resolved")?.forced], [true, true]);
  assert.equal(groupsOf(queue(), { ...DEFAULT_OPEN, resolved: true }, "api#6").find((g) => g.key === "resolved")?.forced, false);
  assert.deepEqual(
    navigable(groupsOf(queue(), DEFAULT_OPEN, "PRIYA"), new Set()).map((c) => c.id),
    ["acme/web#2"],
  );
  assert.deepEqual(groupsOf(null, DEFAULT_OPEN, ""), []);
});

test("the queue is now's items then today's in the desk's order, and folds after queue.cards: j/k stop on its line", () => {
  const look = { state: "ready" as const, verdict: "look" as const };
  const today = ["acme/web#10", "acme/web#11", "acme/web#12", "acme/web#13"].map((id) => card(id, { bucket: "today", author: id }));
  const now = [card("acme/api#1", { preflight: { state: "ready", verdict: "skip" } }), card("acme/api#2", { preflight: look })];
  const v = { ...queue(), sections: { ...queue().sections, now, today }, cards: 3 };
  const t = (g: ReturnType<typeof groupsOf>) => g.find((x) => x.key === "queue")!;
  const folded = groupsOf(v, DEFAULT_OPEN, "");
  assert.deepEqual(
    [t(folded).cards.map((c) => c.id), t(folded).fold, t(folded).total],
    [["acme/api#1", "acme/api#2", "acme/web#10"], 3, 6],
    "as the desk sent them: it orders them, the page only shows them",
  );
  assert.deepEqual(stops(main(folded), new Set()), ["acme/api#1", "acme/api#2", "acme/web#10", foldOf("queue")]);

  assert.equal(t(groupsOf(v, DEFAULT_OPEN, "", { queue: true })).cards.length, 6);
  assert.ok(!stops(main(groupsOf(v, DEFAULT_OPEN, "", { queue: true })), new Set()).includes(foldOf("queue")));
  assert.equal(t(groupsOf({ ...v, cards: 0 }, DEFAULT_OPEN, "")).fold, 0);
  assert.equal(t(groupsOf({ ...v, cards: 5 }, DEFAULT_OPEN, "")).fold, 0, "a fold never hides just one");
  assert.deepEqual(
    t(groupsOf(v, DEFAULT_OPEN, "web#1")).cards.map((c) => c.id),
    ["acme/web#10", "acme/web#11", "acme/web#12", "acme/web#13"],
    "every match shows while filtering",
  );
});

test("the selected card's facts leave out what the card already says", () => {
  const pr = card("acme/api#1", {
    chips: ["CI red", "conflict", "3 unresolved", "+62 −7"],
    ci: "red",
    preflight: { state: "ready", risk: "medium", notes: 5 },
    demoted: "3 from B are urgent already",
  });
  // Problems and size are on every card, so the facts skip them.
  assert.deepEqual(cardFacts(pr, "me"), [
    "by dana",
    "3 unresolved threads",
    "medium risk",
    "5 notes on the changes",
    "3 from B are urgent already",
  ]);
  // A sorted-away row shows its note already.
  assert.ok(!cardFacts(pr, "me", true).includes("3 from B are urgent already"));
  assert.ok(says("conflicts with main", "merge conflict"));
  assert.ok(!says("asked you directly", "merge conflict"));
  // A rule's why in its own words says the same problem: a sorted-away row shows it once.
  assert.ok(says("merge conflict", "conflicts with main"));
  assert.ok(says("red CI on main", "CI failing"));
  assert.ok(says("CI failing", "CI went red"));
  assert.ok(says("new commits after you requested changes", "changes requested"));
  assert.ok(says("has 2 approvals", "approved"));
  assert.ok(!says("CI failing", "CI passing"));
  assert.ok(!says("waiting on reviewers", "optional check failing"));
  assert.ok(!says("required by CODEOWNERS", "CI failing"));
  assert.deepEqual(cardFacts({ ...pr, why: "3 unresolved threads", author: "me", demoted: undefined }, "me"), [
    "medium risk",
    "5 notes on the changes",
  ]);
  assert.deepEqual(
    cardFacts(
      {
        ...pr,
        chips: ["1 unresolved", "approved"],
        ci: "green",
        preflight: { state: "stale", risk: "high", notes: 2 },
        demoted: undefined,
      },
      "me",
    ),
    ["by dana", "CI passing", "approved", "1 unresolved thread"],
  );
  assert.deepEqual(cardFacts({ ...pr, chips: ["draft"], ci: "pending", preflight: undefined, demoted: undefined }, "me"), [
    "by dana",
    "CI running",
    "draft",
  ]);
  assert.deepEqual(cardFacts(card("acme/api#2", { kind: "issue", ci: "none", author: "nina" }), "me"), ["by nina"]);
  // A team-only ask says so when the why doesn't; "approved and green" already says CI passes; the coordinator says why.
  assert.deepEqual(
    cardFacts(card("acme/api#3", { why: "close collaborator", team_ask: "CODEOWNERS ping to @ml-team", ci: "green" }), "me"),
    ["by dana", "CODEOWNERS ping to @ml-team", "CI passing"],
  );
  assert.ok(
    !cardFacts(card("acme/api#4", { why: "CODEOWNERS ping to @ml-team", team_ask: "CODEOWNERS ping to @ml-team" }), "me").some((f) =>
      f.includes("@"),
    ),
  );
  assert.deepEqual(
    cardFacts(card("acme/api#5", { author: "me", why: "approved and green: merge it", ci: "green", chips: ["approved"] }), "me"),
    [],
  );
  assert.deepEqual(cardFacts(card("acme/api#6", { ci: "none", cleared_by_coordinator: "a thread you've left" }), "me"), [
    "by dana",
    "the coordinator: a thread you've left",
  ]);
  // Who placed it, before any demotion: the why is a hard rule's, Claude's, or the rule's until Claude answers.
  assert.deepEqual(cardFacts({ ...pr, placed_by: "claude" }, "me").slice(-2), ["sorted by Claude", "3 from B are urgent already"]);
  assert.deepEqual(cardFacts(card("acme/api#7", { ci: "none", placed_by: "hard" }), "me"), ["by dana", "placed by a hard rule"]);
  assert.deepEqual(cardFacts(card("acme/api#8", { ci: "none", placed_by: "pending" }), "me"), ["by dana", "not sorted by Claude yet"]);
});

test("the file you're in: the last whose top passed the line, and the last file at the page's end", () => {
  assert.equal(currentFile([-900, -200, 60, 400, 700], 96), 2);
  assert.equal(currentFile([120, 400], 96), 0, "nothing past the line yet: the first");
  // Scrolled to the end, short last files never reach the line.
  assert.equal(currentFile([-900, -200, 60, 400, 700], 96, true), 4);
  assert.equal(currentFile([], 96, true), 0);
});

test("the review reads in the desk's order: a file's hunks next to each other at one level are one section", () => {
  const hunk = (id: string, path: string, level: ReviewHunk["level"], why: string | null, notes: number[] = []): ReviewHunk => ({
    id,
    path,
    file: path === "a.ts" ? 0 : 1,
    index: 0,
    header: "@@ -1,3 +1,4 @@",
    patch: "@@ -1,3 +1,4 @@\n+x",
    additions: 1,
    deletions: 0,
    level,
    rank: null,
    why,
    notes,
  });
  const ranked: ReviewOrder = {
    ranked: true,
    capped: false,
    chunks: [
      hunk("h3", "b.ts", "look", "unchecked input", [1]),
      hunk("h1", "a.ts", "skim", "rename"),
      hunk("h2", "a.ts", "skim", "rename"),
    ],
    unread: [hunk("h5", "b.ts", "unread", "its file was too long to read whole")],
    rest: [{ path: "a.ts", file: 0, why: "not worth reviewing", hunks: [hunk("h4", "a.ts", "skip", null)], notes: [] }],
    notes: [1, 0],
  };
  const { list, rest } = sections(ranked);
  assert.deepEqual(
    list.map((s) => [s.path, s.level, s.hunks.map((h) => h.id), s.notes]),
    [
      ["b.ts", "look", ["h3"], [1]],
      ["a.ts", "skim", ["h1", "h2"], []],
      ["b.ts", "unread", ["h5"], []],
      ["a.ts", "skip", ["h4"], []],
    ],
  );
  assert.equal(rest, 3, "the fold starts at the files not worth reviewing");
  // Without a ranking: file by file, and a file with no text diff is no fold of its own.
  const plain = sections({
    ranked: false,
    capped: false,
    chunks: [hunk("h1", "a.ts", null, null, [0]), hunk("h2", "a.ts", null, null), hunk("h3", "b.ts", null, null)],
    unread: [],
    rest: [{ path: "logo.png", file: 2, why: "no text diff: binary or too large", hunks: [], notes: [2] }],
    notes: [0, 2],
  });
  assert.deepEqual(
    plain.list.map((s) => [s.path, s.level, s.hunks.length, s.notes]),
    [
      ["a.ts", null, 2, [0]],
      ["b.ts", null, 1, []],
      ["logo.png", null, 0, [2]],
    ],
  );
});

test("a note on a hunk's lines goes on the diff; one on none of them is about the whole file", () => {
  const h = [{ header: "@@ -10,3 +12,5 @@ function plan()" }];
  assert.equal(onLines(h, { side: "new", line: 12 }), true);
  assert.equal(onLines(h, { side: "new", line: 16 }), true);
  assert.equal(onLines(h, { side: "new", line: 17 }), false);
  assert.equal(onLines(h, { side: "old", line: 12 }), true);
  assert.equal(onLines(h, { side: "old", line: 13 }), false);
  assert.equal(onLines(h, { side: "new", line: 0 }), false, "line 0: the file itself");
  assert.equal(onLines([{ header: "@@ -0,0 +1 @@" }], { side: "new", line: 1 }), true, "a count of one is left out");
});

test("a PR with no clone for Claude to work in", () => {
  assert.equal(noCloneOf({ why: "handed back: no local clone of oss/tinyhttp", repo: "oss/tinyhttp" }), "oss/tinyhttp");
  assert.equal(noCloneOf({ why: "merging: reply ready to send", repo: "oss/tinyhttp" }), undefined);
});

test("removeCard drops an item from every active group but keeps cleared and resolved", () => {
  const v = removeCard(removeCard(queue(), "acme/api#1"), "acme/api#4");
  assert.equal(v.sections.now.length, 0);
  assert.equal(v.hidden.length, 0);
  assert.equal(v.cleared.length, 1);
  assert.equal(removeCard(queue(), "acme/api#6").resolved.length, 1);
});

test("events read as plain words", () => {
  const e = (kind: ActivityEvent["kind"], actor = "", data: ActivityEvent["data"] = {}): ActivityEvent => ({
    seq: 1,
    at: "",
    source: "github",
    item_id: "acme/api#1",
    kind,
    actor,
    data,
  });
  assert.deepEqual(
    [
      e("new", "dana"),
      e("review_requested", "alice", { reviewer: "me", type: "user" }),
      e("review_requested", "", { reviewer: "ml-team", type: "team" }),
      e("request_removed", "", { reviewer: "ml-team", type: "team" }),
      e("request_removed", "", { reviewer: "me", type: "user" }),
      e("reviewed", "alice", { state: "approved" }),
      e("reviewed", "bob", { state: "changes_requested" }),
      e("pushed", "dana"),
      e("ci", "", { from: "green", to: "red" }),
      e("ci", "", { from: "red", to: "pending" }),
      e("commented", "carol"),
      e("merged", "dana"),
      e("mentioned", "", { reason: "team_mention" }),
      e("assigned"),
      e("resolved", "alice", { reason: "approved by alice" }),
      e("unresolved", "", { was: "approved by alice" }),
    ].map((x) => eventText(x, "dana")),
    [
      "first seen",
      "alice asked you",
      "asked @ml-team",
      "request to @ml-team removed",
      "request to you removed",
      "alice approved",
      "bob requested changes",
      "you pushed",
      "CI went red",
      "CI started",
      "carol commented",
      "you merged it",
      "your team was mentioned",
      "assigned to you",
      "resolved: approved by alice",
      "came back (was approved by alice)",
    ],
  );
});

test("a resolved PR's header says what resolved it once: the line takes its cause out of Recent activity", () => {
  let seq = 0;
  const e = (kind: ActivityEvent["kind"], actor = "", data: ActivityEvent["data"] = {}): ActivityEvent => ({
    seq: ++seq,
    at: "",
    source: "github",
    item_id: "acme/api#1",
    kind,
    actor,
    data,
  });
  const merged = [e("resolved", "", { reason: "merged" }), e("merged", "li-wei"), e("ci", "", { to: "red" }), e("merged", "old")];
  const m = resolvedHead(merged, "merged", "me");
  assert.equal(m.line, "Resolved: merged by li-wei");
  assert.deepEqual(
    m.events.map((x) => x.seq),
    [3, 4],
    "only the newest merge goes",
  );
  assert.equal(resolvedHead([e("merged", "me")], "merged", "Me").line, "Resolved: merged by you");
  assert.equal(resolvedHead([e("closed")], "closed", "me").line, "Resolved: closed", "nobody named, nobody said");

  const approved = [e("reviewed", "Carol", { state: "approved" }), e("reviewed", "dan", { state: "approved" }), e("commented", "carol")];
  const a = resolvedHead(approved, "approved by carol", "me");
  assert.equal(a.line, "Resolved: approved by carol");
  assert.deepEqual(
    a.events.map((x) => x.actor),
    ["dan", "carol"],
  );
  assert.deepEqual(
    resolvedHead(
      [e("request_removed", "", { reviewer: "ml-team", type: "team" }), e("new", "kofi")],
      "no longer requested",
      "me",
    ).events.map((x) => x.kind),
    ["new"],
  );
  const mine = [e("resolved", "me", { reason: "you approved" }), e("commented", "sam")];
  assert.deepEqual(resolvedHead(mine, "you approved", "me"), { line: "Resolved: you approved", events: [mine[1]] });
});

const TOML = `poll_seconds = 60

[signals]
bots = ["a"]

[[boards]]
id = "one"
queries = [
  "q1",
]

[[boards.rules]]
when = "x"
bucket = "now"

[[boards]]
id = "two"
caps = { now = 3 }

[[boards.rules]]
when = "a"
bucket = "now"

[[boards.rules]] # second
when = "b"
bucket = "soon"
`;

test("lineOf finds the line for config error paths", () => {
  const lines = TOML.split("\n");
  const at = (path: string) => {
    const n = lineOf(TOML, path);
    return n === null ? null : lines[n];
  };
  assert.equal(at("poll_seconds"), "poll_seconds = 60");
  assert.equal(at("signals.bots"), 'bots = ["a"]');
  assert.equal(at("boards[0].queries"), "queries = [");
  assert.equal(at("boards[1].rules[1].bucket"), 'bucket = "soon"');
  assert.equal(at("boards[1].rules[0].when"), 'when = "a"');
  assert.equal(at("boards[1].caps.now"), "caps = { now = 3 }");
  assert.equal(at("boards[1].rules[1]"), "[[boards.rules]] # second");
  // Missing key: falls back to the closest table found.
  assert.equal(at("boards[1].filter"), "[[boards]]");
  assert.equal(at("boards[7].rules[0].when"), null);
  assert.equal(at("line 3"), "[signals]");
});

test("formatting", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  assert.equal(age("2026-10-27T11:20:00Z", now), "40m");
  assert.equal(age("2026-10-27T07:00:00Z", now), "5h");
  assert.equal(age("2026-10-24T12:00:00Z", now), "3d");
  // Rounded before the switch to days: 47.6h and 48.3h both read "2d".
  assert.equal(age(new Date(now - 47.6 * 3_600_000).toISOString(), now), "2d");
  assert.equal(age(new Date(now - 48.3 * 3_600_000).toISOString(), now), "2d");
  assert.equal(age(new Date(now - 47.4 * 3_600_000).toISOString(), now), "47h");
  assert.equal(ago(new Date(now - 47.6 * 3_600_000).toISOString(), now), "2d ago");
  assert.equal(tilde("/Users/greg/.review-desk/config.toml"), "~/.review-desk/config.toml");
  assert.equal(ago("2026-10-27T11:59:20Z", now), "40s ago");
  assert.equal(ago("2026-10-27T12:00:05Z", now), "0s ago");
  assert.equal(shortRef({ repo: "getsentry/seer", number: 9085 }), "seer#9085");
  assert.equal(shortId("getsentry/seer#9085"), "seer#9085");
  assert.equal(clearedText(card("a/b#1", { status: "snoozed", snooze_until: null })), "snoozed until activity");
  assert.equal(clearedText(card("a/b#1", { status: "muted" })), "muted");
  // What the coordinator put away says so; times read as the snooze menu writes them.
  const sat = new Date(2026, 9, 31, 9, 0).toISOString();
  assert.match(
    clearedText(card("a/b#1", { status: "snoozed", snooze_until: sat, cleared_by_coordinator: "a CODEOWNERS ping" })),
    /^coordinator snoozed until .*\b9:00 or new activity$/,
  );
  assert.equal(clearedText(card("a/b#1", { status: "muted", cleared_by_coordinator: "" })), "coordinator muted");
});

test("an AI review names the model that wrote it the way people say it", () => {
  assert.equal(modelName("claude-opus-5[1m]"), "Opus 5");
  assert.equal(modelName("claude-sonnet-4-5-20250929"), "Sonnet 4.5");
  assert.equal(modelName("claude-opus-4-1"), "Opus 4.1");
  assert.equal(modelName("sonnet"), "Sonnet", "a review from before, by the old setting");
  assert.equal(modelName("claude-code"), "Claude Code");
  assert.equal(modelName("codex"), "Codex");
  assert.equal(modelName("claude-3-5-sonnet-20241022"), "claude-3-5-sonnet-20241022");
});

test("lineOf finds rules written as an inline array", () => {
  const t = `[[spaces]]\nid = "a"\n\n[[boards]]\nid = "one"\nrules = [\n  { when = "x", bucket = "now" },\n  { when = "y", bucket = "today" },\n]\n\n[[boards]]\nid = "two"\nrules = [\n  { when = "z" },\n]\n`;
  assert.equal(lineOf(t, "boards[0].rules[1].when"), 7);
  assert.equal(lineOf(t, "boards[1].rules[0].bucket"), 13);
  assert.equal(lineOf(t, "boards[1].id"), 11);
});

test("the coordinator in plain words: the top bar's line, its log, its status", () => {
  assert.equal(actedText({ counts: { snooze: 3 }, buckets: ["fyi", "fyi", "fyi"], at: "" }), "snoozed 3 FYI items");
  assert.equal(actedText({ counts: { snooze: 1 }, buckets: ["later"], at: "" }), "snoozed 1 Later item");
  // The queue is one list: no "Today item".
  assert.equal(actedText({ counts: { snooze: 1 }, buckets: ["today"], at: "" }), "snoozed 1 item");
  assert.equal(actedText({ counts: { done: 2 }, buckets: ["now", "now"], at: "" }), "cleared 2 items");
  assert.equal(actedText({ counts: { snooze: 2 }, buckets: ["fyi", "later"], at: "" }), "snoozed 2 items");
  assert.equal(actedText({ counts: { mute: 1, snooze: 2 }, buckets: ["fyi", "fyi", "fyi"], at: "" }), "snoozed 2 items and muted 1");
  assert.equal(actedText({ counts: { done: 1, mute: 1, snooze: 4 }, buckets: [], at: "" }), "snoozed 4 items, cleared 1 and muted 1");

  const entry = (o: Partial<CoordinatorLogEntry>): CoordinatorLogEntry => ({
    seq: 1,
    at: "",
    run: 3,
    kind: "note",
    text: "",
    item_id: null,
    action: null,
    bucket: null,
    undo_seq: null,
    version: null,
    undone: false,
    ...o,
  });
  assert.equal(logText(entry({ kind: "act", action: "snooze", item_id: "acme/api#12", text: "bot bump" })), "Snoozed api#12: bot bump");
  const change = entry({ kind: "policy", text: "Changed the policy\n− Bot PRs: hide.\n+ Bot PRs: fyi.", version: 2 });
  assert.equal(logText(change), "Changed the policy");
  assert.deepEqual(policyLines(change), ["− Bot PRs: hide.", "+ Bot PRs: fyi."]);
  assert.deepEqual(policyLines(entry({ text: "a note\nwith two lines" })), [], "only a policy change comes apart");
  assert.equal(logText(entry({ kind: "act", action: "done", item_id: "acme/api#12" })), "Cleared api#12");
  assert.equal(logText(entry({ kind: "run", text: "6 events, 3 actions · 41s" })), "Run 3 · 6 events, 3 actions · 41s");
  assert.equal(logText(entry({ kind: "note", text: "Nothing needed you." })), "Nothing needed you.");

  const now = Date.parse("2026-10-27T12:00:00Z");
  const s: CoordinatorStatus = {
    state: "idle",
    off_reason: null,
    session_id: "x",
    started: true,
    dir: "/h/coordinator",
    command: "cd …",
    running_since: null,
    pending: 0,
    next_at: null,
    last_run: { n: 4, kind: "events", started_at: "2026-10-27T11:48:00Z", ms: 1, ok: true, events: 1, actions: 2, error: null },
    error: null,
    held: false,
  };
  assert.equal(coordinatorText(s, now), "Idle. Last run 12m ago: 1 event, 2 actions.");
  assert.equal(
    coordinatorText({ ...s, last_run: { ...s.last_run!, kind: "learn", events: 5, actions: 0 } }, now),
    "Idle. Last run 12m ago: read your last 5 actions.",
  );
  assert.equal(
    coordinatorText({ ...s, state: "off", off_reason: "Coordinator needs Claude Code for now" }, now),
    "Coordinator needs Claude Code for now.",
  );
  assert.equal(
    coordinatorText(
      { ...s, state: "error", error: "claude CLI isn't logged in. Run: claude auth login", next_at: "2026-10-27T12:05:00Z" },
      now,
    ),
    "Its last run failed 12m ago: Claude CLI isn't logged in. Run: claude auth login. Next try in 5m.",
  );
  assert.equal(
    coordinatorText({ ...s, state: "waiting", held: true }, now),
    "Waiting: you have it open in a terminal. It picks up the new events once you close it.",
  );
  assert.equal(coordinatorText({ ...s, started: false, last_run: null }, now), "It starts its session after the first sync.");
});

test("the judge in plain words", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  const j: JudgeStatus = {
    state: "idle",
    off_reason: null,
    waiting: 2,
    judged: 14,
    spent: 20,
    max_per_hour: 60,
    last_at: null,
    error: null,
    retry_at: null,
  };
  assert.equal(judgeStatusText(j, now), "14 items sorted by Claude, 2 waiting. 20 of 60 this hour.");
  assert.equal(
    judgeStatusText({ ...j, state: "off", off_reason: "it's turned off" }, now),
    "Claude doesn't sort your desk: it's turned off.",
  );
  assert.equal(
    judgeStatusText({ ...j, state: "error", error: "claude CLI isn't logged in", retry_at: "2026-10-27T12:10:00Z" }, now),
    "Claude's last sorting call failed: Claude CLI isn't logged in. Next try in 10m.",
  );
  assert.equal(
    judgeStatusText({ ...j, spent: 60, retry_at: "2026-10-27T12:12:00Z" }, now),
    "14 items sorted by Claude, 2 waiting. The hour's limit is reached (60); next batch in 12m.",
  );
  assert.equal(judgeStepText({ bucket: "today", why: "your library", pending: false }), "today, your library");
  assert.equal(judgeStepText({ bucket: "later", why: "", pending: false }), "later, keeps the rule's why");
  assert.equal(judgeStepText({ bucket: null, why: "", pending: true }), "not sorted yet, so where the rules put it");
  assert.equal(judgeStepText({ bucket: "fyi", why: "bot", pending: true }), "fyi, bot (an earlier answer; sorting it again)");
});
