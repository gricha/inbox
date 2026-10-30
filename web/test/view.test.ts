import assert from "node:assert/strict";
import { test } from "node:test";
import { settingDef } from "../../src/settings.ts";
import type { ActivityEvent, Card, CoordinatorLogEntry, CoordinatorStatus, JudgeStatus, QueueView } from "../../src/types.ts";
import { age, ago, clearedText, eventText, modelName, shortId, shortRef, tilde } from "../src/format.ts";
import {
  acceleratorOf,
  actedText,
  aiWord,
  authProblem,
  cardFacts,
  coordinatorText,
  DEFAULT_OPEN,
  draftOf,
  firstClause,
  foldOf,
  groupsOf,
  judgeStatusText,
  judgeStepText,
  keepUnits,
  keyParts,
  laneFacts,
  lineOf,
  logText,
  navigable,
  nextText,
  opening,
  parseList,
  parseRoute,
  problems,
  removeCard,
  resolvedHead,
  routeHash,
  runs,
  says,
  sitterParts,
  sizeOf,
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
  now_cards: 5,
  today_cards: 5,
  ai_paused: null,
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

test("sorted-away groups are skipped by j/k until opened; filtering opens groups with matches", () => {
  const groups = groupsOf(queue(), DEFAULT_OPEN, "");
  assert.deepEqual(
    groups.map((g) => [g.key, g.open, g.total]),
    [
      ["now", true, 1],
      ["today", true, 1],
      ["later", false, 1],
      ["fyi", false, 0],
      ["resolved", false, 1],
      ["hidden", false, 1],
      ["cleared", false, 1],
    ],
  );
  assert.equal(groupsOf(queue(), DEFAULT_OPEN, "").find((g) => g.key === "resolved")?.variant, "resolved");
  assert.deepEqual(
    navigable(groupsOf(queue(), { ...DEFAULT_OPEN, resolved: true }, ""), new Set()).map((c) => c.id),
    ["acme/api#1", "acme/web#2", "acme/api#6"],
  );
  assert.deepEqual(
    navigable(groups, new Set()).map((c) => c.id),
    ["acme/api#1", "acme/web#2"],
  );
  assert.deepEqual(
    navigable(groups, new Set(["acme/api#1"])).map((c) => c.id),
    ["acme/web#2"],
  );
  assert.deepEqual(
    navigable(groupsOf(queue(), { ...DEFAULT_OPEN, later: true }, ""), new Set()).map((c) => c.id),
    ["acme/api#1", "acme/web#2", "acme/api#3"],
  );

  const filtered = groupsOf(queue(), DEFAULT_OPEN, "api#3");
  assert.deepEqual(
    navigable(filtered, new Set()).map((c) => c.id),
    ["acme/api#3"],
  );
  assert.equal(filtered.find((g) => g.key === "later")?.open, true);
  // Opened by the filter, not by you: the toggle is off-limits until the filter clears.
  assert.equal(filtered.find((g) => g.key === "later")?.forced, true);
  assert.equal(groupsOf(queue(), { ...DEFAULT_OPEN, later: true }, "api#3").find((g) => g.key === "later")?.forced, false);
  assert.deepEqual(
    navigable(groupsOf(queue(), DEFAULT_OPEN, "PRIYA"), new Set()).map((c) => c.id),
    ["acme/web#2"],
  );
  assert.deepEqual(groupsOf(null, DEFAULT_OPEN, ""), []);
});

test("Today folds after today_cards: j/k stop on its line; unfolded, filtering, or 0 shows them all", () => {
  const today = ["acme/web#10", "acme/web#11", "acme/web#12", "acme/web#13"].map((id) => card(id, { bucket: "today", author: id }));
  const v = { ...queue(), sections: { ...queue().sections, today }, today_cards: 2 };
  const t = (g: ReturnType<typeof groupsOf>) => g.find((x) => x.key === "today")!;
  const folded = groupsOf(v, DEFAULT_OPEN, "");
  assert.deepEqual([t(folded).cards.map((c) => c.id), t(folded).fold, t(folded).total], [["acme/web#10", "acme/web#11"], 2, 4]);
  assert.deepEqual(
    navigable(folded, new Set()).map((c) => c.id),
    ["acme/api#1", "acme/web#10", "acme/web#11"],
  );
  assert.deepEqual(stops(folded, new Set()), ["acme/api#1", "acme/web#10", "acme/web#11", foldOf("today")]);
  assert.deepEqual(
    stops(groupsOf(v, { ...DEFAULT_OPEN, later: true }, ""), new Set()).slice(-2),
    [foldOf("today"), "acme/api#3"],
    "then the next open group",
  );

  assert.equal(t(groupsOf(v, DEFAULT_OPEN, "", { today: true })).cards.length, 4);
  assert.equal(t(groupsOf(v, DEFAULT_OPEN, "", { today: true })).fold, 0);
  assert.ok(!stops(groupsOf(v, DEFAULT_OPEN, "", { today: true }), new Set()).includes(foldOf("today")));
  assert.equal(t(groupsOf({ ...v, today_cards: 0 }, DEFAULT_OPEN, "")).fold, 0);
  assert.deepEqual(
    t(groupsOf(v, DEFAULT_OPEN, "web#1")).cards.map((c) => c.id),
    ["acme/web#10", "acme/web#11", "acme/web#12", "acme/web#13"],
    "every match shows while filtering",
  );
});

test("Now and Today put the weightiest first and fold after now_cards and today_cards, whole stacks at a time", () => {
  const look = { state: "ready" as const, verdict: "look" as const };
  const skip = { state: "ready" as const, verdict: "skip" as const };
  const now = [
    card("acme/api#20", { author: "a20", preflight: skip }),
    card("acme/api#21", { author: "a21", preflight: { state: "ready", verdict: "skim" } }),
    card("acme/api#22", { author: "a22", preflight: look }),
    card("acme/api#25", { author: "me", inflight: true, why: "in flight: no local clone of oss/tinyhttp, so no babysitter" }),
    card("acme/api#23", {
      author: "me",
      inflight: true,
      why: "in flight: reply ready to send",
      reply: { id: "d1", thread_id: null, to: "dana", quote: "", body: "Kept it.", at: "", sent_at: null, url: null },
    }),
    card("acme/api#24", { author: "a24", preflight: { state: "ready", verdict: "skim", risk: "high" } }),
  ];
  const v = { ...queue(), sections: { ...queue().sections, now }, now_cards: 3 };
  const g = groupsOf(v, DEFAULT_OPEN, "", {}, "me").find((x) => x.key === "now")!;
  // A close look, your PR one key from done and high risk first; skip last; otherwise as the rules ordered them. Your PR
  // in flight that no key can finish (no clone) is one of the rest.
  assert.deepEqual([g.cards.map((c) => c.id), g.fold], [["acme/api#22", "acme/api#23", "acme/api#24"], 3]);
  assert.deepEqual(
    groupsOf(v, DEFAULT_OPEN, "", { now: true }, "me")
      .find((x) => x.key === "now")!
      .cards.map((c) => c.id),
    ["acme/api#22", "acme/api#23", "acme/api#24", "acme/api#21", "acme/api#25", "acme/api#20"],
  );
  assert.ok(stops([g], new Set()).includes(foldOf("now")));
  const demoted = card("acme/web#30", { demoted: "Now was full on PRs to review (3)" });
  const today = [card("acme/web#31", { author: "a31" }), card("acme/web#32", { author: "a32", preflight: skip }), demoted];
  const t = groupsOf({ ...queue(), sections: { ...queue().sections, today }, today_cards: 1 }, DEFAULT_OPEN, "").find(
    (x) => x.key === "today",
  )!;
  assert.deepEqual(
    t.cards.map((c) => c.id),
    ["acme/web#30"],
    "what a cap pushed out of Now comes first",
  );

  // A stack is all above the line or all behind it; the first one always shows whole.
  const stack = ["acme/web#40", "acme/web#41", "acme/web#42", "acme/web#43"].map((id) =>
    card(id, { author: "vaind", why: "close collaborator" }),
  );
  const stacked = (list: Card[], cap: number) =>
    groupsOf({ ...queue(), sections: { ...queue().sections, today: list }, today_cards: cap }, DEFAULT_OPEN, "").find(
      (x) => x.key === "today",
    )!;
  assert.deepEqual(
    [
      stacked([card("acme/web#39", { author: "a39" }), ...stack], 3).cards.length,
      stacked([card("acme/web#39", { author: "a39" }), ...stack], 3).fold,
    ],
    [1, 4],
  );
  assert.deepEqual([stacked(stack, 2).cards.length, stacked(stack, 2).fold], [4, 0]);
  assert.deepEqual(
    runs(stack).map((r) => r.cards.length),
    [4],
  );
});

test("your PR's next step leaves out what its why already says", () => {
  const next = "merge conflict with main: d hands it to a babysitter";
  assert.equal(nextText({ why: "merge conflict", next }), "d hands it to a babysitter");
  assert.equal(
    nextText({ why: "approved and green: merge it", next: "approved and green: o opens it on GitHub to merge" }),
    "o opens it on GitHub to merge",
  );
  assert.equal(nextText({ why: "close collaborator", next }), next);
  assert.equal(nextText({ why: "", next }), next);
  assert.equal(nextText({ why: "x", next: undefined }), undefined);
});

test("a card's next step sets its keys apart", () => {
  assert.deepEqual(keyParts("enter opens In flight, y sends it"), ["", "enter", " opens In flight, ", "y", " sends it"]);
  assert.deepEqual(keyParts("d hands it to a babysitter"), ["", "d", " hands it to a babysitter"]);
  assert.deepEqual(keyParts("a draft: mark it ready for review when it is"), ["a draft: mark it ready for review when it is"]);
});

test("a card's gist and concern end at a whole sentence or clause, never in an ellipsis", () => {
  const scheduler =
    "Splits the scheduler in two. Lease owns the jobs table: it hands out time-limited leases with a fencing token, renews them on heartbeat and reclaims expired ones every 15 s. Dispatch asks Lease for work.";
  assert.equal(
    opening(scheduler),
    "Splits the scheduler in two. Lease owns the jobs table: it hands out time-limited leases with a fencing token, renews them on heartbeat and reclaims expired ones every 15 s.",
  );
  assert.equal(
    opening("Splits the scheduler in two. Lease owns the jobs table."),
    "Splits the scheduler in two. Lease owns the jobs table.",
  );
  // A first sentence longer than the limit stays whole: the card's line clamp is the fallback.
  const long = `Moves the retry budget ${"and more ".repeat(40)}into the coordinator. Then this.`;
  assert.equal(opening(long), long.replace(" Then this.", ""));
  // The shortest gist is its first clause; a concern keeps its whole first sentence, so the consequence stays.
  const budget = "The budget is per process; with 12 replicas one hot shard trips it on some and not others. Tests miss it.";
  assert.equal(opening(budget, 0), "The budget is per process.");
  assert.equal(opening(budget, 0, false), "The budget is per process; with 12 replicas one hot shard trips it on some and not others.");
  assert.equal(opening("Adds an http2: 'prior-knowledge' option. HTTP/1.1 keeps working.", 0), "Adds an http2: 'prior-knowledge' option.");
});

test("a card's problems and size, in the review's and the lane's words", () => {
  assert.deepEqual(problems({ chips: ["CI red", "conflict", "changes requested", "approved", "+62 −7"] }), [
    { text: "CI failing", tone: "bad" },
    { text: "changes requested", tone: "warn" },
    { text: "merge conflict", tone: "warn" },
  ]);
  assert.deepEqual(problems({ chips: ["draft", "3 unresolved"] }), []);
  assert.equal(sizeOf({ chips: ["CI red", "+341 −802"] }), "+341 −802");
  assert.equal(sizeOf({ chips: ["issue"] }), undefined);
});

test("a card's AI word: the verdict, marked when it's for an older commit, or why there's none yet", () => {
  assert.deepEqual(aiWord({ state: "ready", verdict: "look" }), { verdict: "look", note: "" });
  assert.deepEqual(aiWord({ state: "stale", verdict: "skim" }), { verdict: "skim", note: "updating" });
  assert.deepEqual(aiWord({ state: "paused", verdict: "look" }), { verdict: "look", note: "paused" });
  assert.deepEqual(aiWord({ state: "off", verdict: "skip" }), { verdict: "skip", note: "earlier commit" });
  assert.deepEqual(aiWord({ state: "running" }), { verdict: null, note: "AI review being written" });
  assert.deepEqual(aiWord({ state: "queued" }), { verdict: null, note: "AI review queued" });
  assert.deepEqual(aiWord({ state: "paused" }), { verdict: null, note: "AI review paused" });
  assert.equal(aiWord({ state: "off" }), null);
  assert.equal(aiWord({ state: "none" }), null);
});

test("the selected card's facts leave out what the card already says", () => {
  const pr = card("acme/api#1", {
    chips: ["CI red", "conflict", "3 unresolved", "+62 −7"],
    ci: "red",
    preflight: { state: "ready", risk: "medium", notes: 5 },
    demoted: "Now was full (3)",
  });
  // Problems and size are on every card, so the facts skip them.
  assert.deepEqual(cardFacts(pr, "me"), ["by dana", "3 unresolved threads", "medium risk", "5 notes on the changes", "Now was full (3)"]);
  // A sorted-away row shows its note already.
  assert.ok(!cardFacts(pr, "me", true).includes("Now was full (3)"));
  assert.ok(!cardFacts(pr, "me", false, true).includes("by dana"), "in a stack, its head names the author");
  assert.ok(says("conflicts with main", "merge conflict"));
  assert.ok(!says("asked you directly", "merge conflict"));
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
});

test("a skip's gist is its first clause when the sentence won't fit a line; units stay with their numbers", () => {
  assert.equal(
    firstClause("Runs eval shard setup and sandbox provisioning in the background, with most of the change in evals-runner. More."),
    "Runs eval shard setup and sandbox provisioning in the background.",
  );
  assert.equal(firstClause("Deletes an unused helper and its tests. Nothing else."), "Deletes an unused helper and its tests.");
  assert.equal(
    keepUnits("maps raw readings to 0–100 % moisture every 15 s"),
    "maps raw readings to 0–\u2060100\u202f% moisture every 15\u202fs",
  );
  assert.equal(keepUnits("2 sensors"), "2 sensors");
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
    undone: false,
    ...o,
  });
  assert.equal(logText(entry({ kind: "act", action: "snooze", item_id: "acme/api#12", text: "bot bump" })), "Snoozed api#12: bot bump");
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
    policy_empty: false,
    held: false,
  };
  assert.equal(coordinatorText(s, now), "Idle. Last run 12m ago: 1 event, 2 actions.");
  assert.equal(
    coordinatorText({ ...s, policy_empty: true }, now),
    "Idle. Last run 12m ago: 1 event, 2 actions. It wakes on new activity once you've written a policy.",
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
  assert.equal(judgeStatusText(j, now), "14 items placed by the policy, 2 waiting. 20 of 60 this hour.");
  assert.equal(
    judgeStatusText({ ...j, state: "off", off_reason: "there's no policy yet" }, now),
    "Nothing is judged: there's no policy yet.",
  );
  assert.equal(
    judgeStatusText({ ...j, state: "error", error: "claude CLI isn't logged in", retry_at: "2026-10-27T12:10:00Z" }, now),
    "The judge's last call failed: Claude CLI isn't logged in. Next try in 10m.",
  );
  assert.equal(
    judgeStatusText({ ...j, spent: 60, retry_at: "2026-10-27T12:12:00Z" }, now),
    "14 items placed by the policy, 2 waiting. The hour's limit is reached (60); next batch in 12m.",
  );
  assert.equal(judgeStepText({ bucket: "today", why: "your library", pending: false }), "today, your library");
  assert.equal(judgeStepText({ bucket: "later", why: "", pending: false }), "later, it says nothing about this item");
  assert.equal(judgeStepText({ bucket: null, why: "", pending: true }), "not judged yet, so the board default");
  assert.equal(judgeStepText({ bucket: "fyi", why: "bot", pending: true }), "fyi, bot (judged before the latest activity)");
});
