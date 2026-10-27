import assert from "node:assert/strict";
import { test } from "node:test";
import { settingDef } from "../../src/settings.ts";
import type { Card, QueueView } from "../../src/types.ts";
import { age, ago, clearedText, shortId, shortRef } from "../src/format.ts";
import {
  acceleratorOf, authProblem, DEFAULT_OPEN, draftOf, groupsOf, lineOf, navigable, parseList, parseRoute, removeCard, routeHash, routeKey,
  valueOf, type KeyLike,
} from "../src/view.ts";

const card = (id: string, extra: Partial<Card> = {}): Card => {
  const [repo, n] = id.split("#");
  return {
    id, kind: "pr", repo, number: Number(n), title: `title ${id}`, url: "", author: "dana", author_bot: false, bucket: "now", why: "",
    board: "b", boards: ["b"], chips: [], ci: "green", review: "required", draft: false, size: 1, created_at: "", updated_at: "",
    activity_at: "", waiting_since: "", new: false, pinned: false, status: "active", snooze_until: null, verdict: null, ...extra,
  };
};

const queue = (): QueueView => ({
  sections: { now: [card("acme/api#1")], today: [card("acme/web#2", { author: "priya" })], later: [card("acme/api#3")], fyi: [] },
  hidden: [card("acme/api#4")],
  cleared: [card("acme/api#5", { status: "muted" })],
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
  assert.equal(routeKey({ name: "settings", section: "app" }), "settings:app");
  assert.deepEqual(parseRoute("#/settings/"), { name: "settings", section: "github" });
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
  const k = (code: string, mods: Partial<KeyLike> = {}): KeyLike => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
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
  for (const a of ["Control+Alt+D", "CommandOrControl+Shift+K", "Control+Shift+Space", "Alt+Up", "CommandOrControl+/", "Control+F12"]) assert.ok(re.test(a), a);
});

test("auth problems are told apart from other GitHub errors", () => {
  assert.ok(authProblem("GitHub rejected the token (HTTP 401): run `gh auth login`"));
  assert.ok(authProblem("no GitHub token: set GITHUB_TOKEN or run `gh auth login` (exit 1)"));
  assert.ok(!authProblem("GitHub HTTP 502"));
  assert.ok(!authProblem("1 search(es) failed: author not found"));
});

test("sorted-away groups are skipped by j/k until opened; filtering opens groups with matches", () => {
  const groups = groupsOf(queue(), DEFAULT_OPEN, "");
  assert.deepEqual(groups.map((g) => [g.key, g.open, g.total]), [
    ["now", true, 1], ["today", true, 1], ["later", false, 1], ["fyi", false, 0], ["hidden", false, 1], ["cleared", false, 1],
  ]);
  assert.deepEqual(navigable(groups, new Set()).map((c) => c.id), ["acme/api#1", "acme/web#2"]);
  assert.deepEqual(navigable(groups, new Set(["acme/api#1"])).map((c) => c.id), ["acme/web#2"]);
  assert.deepEqual(navigable(groupsOf(queue(), { ...DEFAULT_OPEN, later: true }, ""), new Set()).map((c) => c.id), ["acme/api#1", "acme/web#2", "acme/api#3"]);

  const filtered = groupsOf(queue(), DEFAULT_OPEN, "api#3");
  assert.deepEqual(navigable(filtered, new Set()).map((c) => c.id), ["acme/api#3"]);
  assert.equal(filtered.find((g) => g.key === "later")?.open, true);
  // Opened by the filter, not by you: the toggle is off-limits until the filter clears.
  assert.equal(filtered.find((g) => g.key === "later")?.forced, true);
  assert.equal(groupsOf(queue(), { ...DEFAULT_OPEN, later: true }, "api#3").find((g) => g.key === "later")?.forced, false);
  assert.deepEqual(navigable(groupsOf(queue(), DEFAULT_OPEN, "PRIYA"), new Set()).map((c) => c.id), ["acme/web#2"]);
  assert.deepEqual(groupsOf(null, DEFAULT_OPEN, ""), []);
});

test("removeCard drops an item from every active group but keeps cleared", () => {
  const v = removeCard(removeCard(queue(), "acme/api#1"), "acme/api#4");
  assert.equal(v.sections.now.length, 0);
  assert.equal(v.hidden.length, 0);
  assert.equal(v.cleared.length, 1);
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
  assert.equal(ago("2026-10-27T11:59:20Z", now), "40s ago");
  assert.equal(ago("2026-10-27T12:00:05Z", now), "0s ago");
  assert.equal(shortRef({ repo: "getsentry/seer", number: 9085 }), "seer#9085");
  assert.equal(shortId("getsentry/seer#9085"), "seer#9085");
  assert.equal(clearedText(card("a/b#1", { status: "snoozed", snooze_until: null })), "snoozed until activity");
  assert.equal(clearedText(card("a/b#1", { status: "muted" })), "muted");
});

test("lineOf finds rules written as an inline array", () => {
  const t = `[[spaces]]\nid = "a"\n\n[[boards]]\nid = "one"\nrules = [\n  { when = "x", bucket = "now" },\n  { when = "y", bucket = "today" },\n]\n\n[[boards]]\nid = "two"\nrules = [\n  { when = "z" },\n]\n`;
  assert.equal(lineOf(t, "boards[0].rules[1].when"), 7);
  assert.equal(lineOf(t, "boards[1].rules[0].bucket"), 13);
  assert.equal(lineOf(t, "boards[1].id"), 11);
});
