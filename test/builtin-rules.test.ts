import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfigText, migrateBuiltIns, migrateHard, parseConfig, switchBuiltIn, type Source } from "../src/config.ts";
import { GITHUB_RULES } from "../src/connectors/github-rules.ts";
import { classify, type Entry } from "../src/rules.ts";
import { analyze, FIELDS } from "../src/signals.ts";
import type { BuiltInRules, Rule, Signals } from "../src/types.ts";
import { makeContext, makeItem, NOW } from "./helpers/items.ts";
import { setup, reviewAsk } from "./helpers/desk.ts";
import { run, runSync } from "./helpers/run.ts";

const plain = (rs: readonly Rule[]) => rs.map((r) => [r.when, r.bucket, r.why ?? "", !!r.nocap, !!r.hard, !!r.final]);
const boardOf = (text: string, id: string, sources?: Source[]) => {
  const { loaded, errors } = parseConfig(text, undefined, sources);
  assert.deepEqual(errors, []);
  return loaded!.config.boards.find((b) => b.id === id)!;
};
// A copy of a plugin's rules a test changes, as a release would.
type Editable = Record<string, { name: string; rules: BuiltInRules["rules"][number][] }>;
const errorsOf = (text: string) => parseConfig(text).errors.map((e) => `${e.path}: ${e.message}`);

const BOARD = (extra: string) => `[[spaces]]
id = "w"

[[boards]]
id = "r"
query = "is:pr"
builtin = "review"
${extra}
`;

test("every built-in rule compiles, with an id unique in its set", () => {
  for (const [name, set] of Object.entries(GITHUB_RULES)) {
    assert.equal(new Set(set.rules.map((r) => r.id)).size, set.rules.length, name);
    const b = boardOf(BOARD("").replace(`builtin = "review"`, `builtin = "${name}"`), "r");
    assert.deepEqual(plain(b.rules), plain(set.rules), name);
  }
});

test("the first-run config names GitHub's rules instead of copying them, and places as the copy did", () => {
  for (const orgs of [["acme"], []]) {
    const named = defaultConfigText({ workOrgs: orgs });
    assert.doesNotMatch(named, /rules = \[/);
    const copied = parseConfig(defaultConfigText({ workOrgs: orgs, expanded: true })).loaded!.config.boards;
    const boards = parseConfig(named).loaded!.config.boards;
    assert.deepEqual(
      boards.map((b) => [b.id, b.builtin, plain(b.rules)]),
      copied.map((b, i) => [b.id, boards[i]!.builtin, plain(b.rules)]),
    );
  }
});

test("a built-in rule the plugin changes takes effect without touching config.toml", () => {
  const text = defaultConfigText({ workOrgs: ["acme"] });
  const better = structuredClone(GITHUB_RULES) as unknown as Editable;
  better.review!.rules.find((r) => r.id === "bot-pr")!.bucket = "fyi";
  const rule = (sources?: Source[]) => boardOf(text, "acme-review", sources).rules.find((r) => r.id === "bot-pr")!;
  assert.equal(rule().bucket, "hide");
  assert.equal(rule([{ id: "github", rules: better }]).bucket, "fyi");
});

// Fails on main: there, config.toml holds a copy of each rule, so a release's change to one never reaches an existing desk.
test("a release's change to a built-in rule reaches a desk whose config.toml names it", async () => {
  const t = await setup([reviewAsk(1)]);
  await run(t.desk.sync());
  const file = path.join(t.home, "config.toml");
  const before = fs.readFileSync(file, "utf8");
  assert.deepEqual(
    runSync(t.desk.board("acme-review")).sections.now.map((c) => [c.id, c.why]),
    [["acme/api#1", "carol asked you directly"]],
  );
  const gh = t.desk.gh as unknown as { rules: Record<string, BuiltInRules> };
  const next = structuredClone(gh.rules ?? {}) as unknown as Editable;
  const asked = next.review?.rules.find((r) => r.id === "asked-directly");
  if (asked) asked.why = "{me.requested_by} asks you";
  gh.rules = next;
  await run(t.desk.reloadConfig());
  assert.equal(fs.readFileSync(file, "utf8"), before, "config.toml is as it was");
  assert.deepEqual(
    runSync(t.desk.board("acme-review")).sections.now.map((c) => [c.id, c.why]),
    [["acme/api#1", "carol asks you"]],
  );
  t.cleanup();
});

test("switching a built-in rule off writes the board's off, and on again takes it out", async () => {
  const t = await setup([reviewAsk(1)]);
  await run(t.desk.sync());
  const file = path.join(t.home, "config.toml");
  const before = fs.readFileSync(file, "utf8");
  const r = runSync(t.desk.switchRule("acme-review", "asked-directly", false, t.desk.getConfig().hash));
  assert.deepEqual(r, { ok: true, errors: [], warnings: [] });
  assert.match(fs.readFileSync(file, "utf8"), /^builtin = "review"\noff = \["asked-directly"\]\n/m);
  // No other rule of GitHub's matches a person's ask: the board's default, Later.
  assert.deepEqual(
    runSync(t.desk.board("acme-review")).sections.later.map((c) => [c.id, c.why]),
    [["acme/api#1", "review requested"]],
  );
  const view = t.desk.getConfig().builtins.find((b) => b.board === "acme-review")!;
  assert.equal(view.rules.find((x) => x.id === "asked-directly")!.on, false);
  assert.equal(view.rules.filter((x) => !x.on).length, 1);
  runSync(t.desk.switchRule("acme-review", "asked-directly", true));
  assert.equal(fs.readFileSync(file, "utf8"), before);
  t.cleanup();
});

test("switchBuiltIn edits only the board's off line", () => {
  const two = `${BOARD("")}\n[[boards]]\nid = "s"\nquery = "x"\nbuiltin = "mine"\noff = ["stacked"]   # mine\n`;
  assert.match(switchBuiltIn(two, "s", "quiet", false)!, /^off = \["stacked", "quiet"\] # mine$/m);
  assert.doesNotMatch(switchBuiltIn(two, "s", "stacked", true)!, /off =/);
  assert.equal(switchBuiltIn(two, "s", "stacked", false), two, "already off");
  assert.match(switchBuiltIn(two, "r", "bot-pr", false)!, /^builtin = "review"\noff = \["bot-pr"\]\n/m);
  assert.equal(switchBuiltIn(two, "nope", "bot-pr", false), null);
  assert.equal(switchBuiltIn(BOARD(`off = [\n  "bot-pr",\n]`), "r", "codeowners", false), null, "an off over lines is the file's to edit");
});

test("a rule of yours with a built-in's id stands in its place", () => {
  const b = boardOf(BOARD(`rules = [{ id = "bot-pr", when = "author.bot", bucket = "fyi", why = "bot" }]`), "r");
  const at = GITHUB_RULES.review!.rules.findIndex((r) => r.id === "bot-pr");
  assert.deepEqual(b.rules[at], {
    id: "bot-pr",
    when: "author.bot",
    bucket: "fyi",
    why: "bot",
    nocap: false,
    hard: false,
    final: false,
    own: 0,
  });
  assert.equal(b.rules.length, GITHUB_RULES.review!.rules.length);
});

test("yours come first, then GitHub's in order, yours after the one each names", () => {
  const b = boardOf(
    BOARD(`off = ["your-repo"]
rules = [
  { after = "bot-pr", when = "item.number == 1", bucket = "fyi" },
  { when = "item.number == 2", bucket = "now" },
  { id = "new-commits", when = "item.number == 3", bucket = "today" },
  { after = "bot-pr", when = "item.number == 4", bucket = "fyi" },
  { when = "item.number == 5", bucket = "now" },
  { after = "your-repo", when = "item.number == 6", bucket = "later" },
]`),
    "r",
  );
  assert.deepEqual(
    b.rules.map((r) => r.id ?? r.when.slice(-1)),
    [
      "2",
      "5",
      "asked-directly",
      "asked-by-bot",
      "yours-via-bot",
      "after-changes-requested",
      "new-commits",
      "team-taken",
      "team-waited",
      "close-collaborator",
      "6",
      "bot-pr",
      "1",
      "4",
      "added-by-bot",
      "codeowners-your-area",
      "codeowners",
      "team-your-area",
      "team",
    ],
  );
  assert.equal(b.rules.find((r) => r.id === "new-commits")!.when, "item.number == 3");
  assert.ok(b.rules.every((r) => !("after" in r)));
});

test("config.toml says what's wrong with a built-in reference", () => {
  assert.deepEqual(errorsOf(BOARD("").replace(`"review"`, `"reviews"`)), [
    "boards[0].builtin: must be one of review, mine, mentions, issues, collaborators",
  ]);
  assert.deepEqual(errorsOf(BOARD(`off = ["nope"]`)), [`boards[0].off[0]: review has no rule "nope"`]);
  assert.deepEqual(errorsOf(BOARD(`rules = [{ id = "nope", when = "true" }, { after = "nah", when = "true" }]`)), [
    `boards[0].rules[0].id: review has no rule "nope"`,
    `boards[0].rules[1].after: review has no rule "nah"`,
  ]);
  assert.deepEqual(errorsOf(BOARD(`off = ["bot-pr"]\nrules = [{ id = "bot-pr", when = "true" }]`)), [
    `boards[0].rules[0].id: "bot-pr" is switched off in off; drop one of them`,
  ]);
  assert.deepEqual(
    errorsOf(BOARD(`rules = [{ id = "bot-pr", when = "item.number == 1" }, { id = "bot-pr", when = "item.number == 2" }]`)),
    [`boards[0].rules[1].id: another rule of yours replaces "bot-pr"`],
  );
  assert.deepEqual(errorsOf(BOARD(`rules = [{ id = "bot-pr", after = "codeowners", when = "item.number == 1" }]`)), [
    "boards[0].rules[0].after: a rule with an id stands in that rule's place; drop after",
  ]);
  const plainBoard = BOARD(`off = ["bot-pr"]\nrules = [{ id = "codeowners", when = "item.number == 1" }]`).replace(
    `builtin = "review"\n`,
    "",
  );
  assert.deepEqual(errorsOf(plainBoard), [
    "boards[0].off: switches off built-in rules: name them with builtin",
    "boards[0].rules[0].id: names a built-in rule: name the board's with builtin",
  ]);
  assert.match(errorsOf(BOARD(`rules = [{ when = "(" }]`))[0]!, /^boards\[0\]\.rules\[0\]\.when: /, "a compile error points at yours");
});

// Every board of `text` places the same items the same way in `next`: bucket, why, rule, floor, finality and the trace.
function samePlacements(text: string, next: string) {
  const a = parseConfig(text).loaded!;
  const b = parseConfig(next).loaded!;
  const cfg = a.config;
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const STRINGS = ["", "red", "green", "pending", "approved", "changes_requested", "conflict", "clean", "pr", "issue", "alice", "ml-team"];
  const NUMBERS = [-1, 0, 0.5, 1, 2, 4, 23, 25, 71, 73, 300, 335, 337, 2000, 3000];
  const base = analyze(makeItem(), makeContext(), cfg, NOW).signals;
  const entries: Entry[] = Array.from({ length: 3000 }, (_, n) => {
    const s = structuredClone(base) as unknown as Record<string, Record<string, unknown>>;
    for (const f of FIELDS) {
      const [head, key] = f.path.split(".") as [string, string];
      s[head] ??= {};
      s[head][key] =
        f.type === "boolean"
          ? rand() < 0.5
          : f.type === "number"
            ? pick(NUMBERS)
            : f.type === "string"
              ? pick(STRINGS)
              : rand() < 0.5
                ? []
                : ["x"];
    }
    const id = `acme/api#${n}`;
    return {
      id,
      signals: s as unknown as Signals,
      waiting_since: NOW.toISOString(),
      created_at: NOW.toISOString(),
      activity_at: NOW.toISOString(),
      pinned: false,
      active: true,
    };
  });
  assert.equal(a.boards.length, b.boards.length);
  let placed = 0;
  a.boards.forEach((board, i) => {
    const before = classify(board, entries);
    const after = classify(b.boards[i]!, entries);
    // Where it's placed, not how the judge names and weighs the rules: yours became GitHub's, with GitHub's weights.
    const where = (r: typeof before) =>
      new Map([...r.placements].map(([id, { signals, ...p }]) => [id, { ...p, matched: signals?.map((x) => [x.bucket, x.why]) }]));
    assert.deepEqual(where(after), where(before), board.config.id);
    assert.deepEqual(after.order, before.order, board.config.id);
    placed += [...before.placements.values()].filter((p) => p.rule !== null).length;
  });
  return placed;
}

test("migrating a copy of GitHub's rules keeps what's yours and places every item as before", () => {
  // Copies had no weights: the migration compares rules without them.
  const old = defaultConfigText({ workOrgs: ["acme"], expanded: true }).replaceAll(/, weight = \d+/g, "");
  const edited = old
    // Changed: GitHub's bot PR rule, made FYI.
    .replace(
      `{ when = "author.bot && author.via == ''", bucket = "hide", why = "bot PR" }`,
      `{ when = "author.bot && author.via == ''", bucket = "fyi", why = "bot PR" }`,
    )
    // Gone: your repo.
    .replace(`  { when = "repo.mine", bucket = "today", why = "your repo" },\n`, "")
    // Added: one of yours first, and one after GitHub's stacked rule.
    .replace(
      `rules = [\n  { when = "me.requested_direct && !me.requested_by_bot"`,
      `rules = [\n  { when = "'ml-team' in item.labels", bucket = "now", why = "ML" },   # mine\n  { when = "me.requested_direct && !me.requested_by_bot"`,
    )
    .replace(
      `  { when = "pr.stacked", bucket = "later", why = "stacked on {pr.base}" },\n`,
      `  { when = "pr.stacked", bucket = "later", why = "stacked on {pr.base}" },\n  { when = "pr.ci == 'pending'", bucket = "later", why = "CI running" },\n`,
    );
  const next = migrateBuiltIns(edited)!;
  assert.ok(next);
  assert.match(
    next,
    /# mine\nbuiltin = "review"\noff = \["your-repo"\]\nrules = \[\n {2}\{ when = "'ml-team' in item.labels", bucket = "now", why = "ML" \},\n {2}\{ id = "bot-pr", when = "author.bot && author.via == ''", bucket = "fyi", why = "bot PR" \},\n\]\n/,
  );
  assert.match(
    next,
    /builtin = "mine"\nrules = \[\n {2}\{ after = "stacked", when = "pr.ci == 'pending'", bucket = "later", why = "CI running" \},\n\]\n/,
  );
  assert.equal(next.split("rules = [").length - 1, 2, "the boards you didn't change name GitHub's alone");
  assert.ok(samePlacements(edited, next) > 1000);
  assert.equal(migrateBuiltIns(next), null, "once");
  assert.equal(migrateBuiltIns(defaultConfigText({ workOrgs: ["acme"] })), null, "a fresh config names them already");
});

test("a board of your own, or one that's mostly yours, stays as it is", () => {
  const own = `[[spaces]]\nid = "w"\n\n[[boards]]\nid = "x"\nquery = "q"\nrules = [\n  { when = "me.new_activity", bucket = "today", why = "new comments or reviews" },\n  { when = "item.number == 1", bucket = "now" },\n]\n`;
  assert.equal(migrateBuiltIns(own), null);
  const table = (r: Rule) =>
    `[[boards.rules]]\n${Object.entries(r)
      .filter(([k]) => k !== "id")
      .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
      .join("\n")}\n`;
  const copied = defaultConfigText({ workOrgs: [], expanded: true });
  const tables = copied.replace(/^rules = \[\n[\s\S]*?^\]\n/m, GITHUB_RULES.review!.rules.map(table).join(""));
  assert.deepEqual(parseConfig(tables).errors, []);
  const next = migrateBuiltIns(tables)!;
  assert.deepEqual(
    parseConfig(next).loaded!.config.boards.map((b) => b.builtin ?? null),
    [null, "mine", "issues"],
    "rules as [[boards.rules]] tables are left to you",
  );
  assert.ok(samePlacements(tables, next) > 1000);
});

test("a config shaped as the owner's migrates losslessly", () => {
  const text = fs.readFileSync(path.join(import.meta.dirname, "fixtures/config/owner.toml"), "utf8");
  const next = migrateBuiltIns(text)!;
  assert.ok(next);
  const boards = parseConfig(next).loaded!.config.boards;
  assert.deepEqual(
    boards.map((b) => [b.id, b.builtin ?? null, b.off ?? [], b.rules.filter((r) => r.own !== undefined).length]),
    [
      // Rules added since the copy are off, so nothing moves; its hard asks and its older draft rule stand in GitHub's place.
      ["acme-review", "review", ["team-taken", "team-waited", "team-your-area", "team"], 2],
      ["acme-mine", "mine", ["no-review-ready"], 1],
      ["acme-mentions", "mentions", [], 0],
      ["acme-collaborators", "collaborators", [], 0],
      ["acme-watching", null, [], 0],
      ["personal-review", "review", ["team-taken", "team-waited", "team-your-area", "team"], 2],
      ["personal-mine", "mine", ["no-review-ready"], 1],
      ["personal-mentions", "issues", [], 0],
    ],
  );
  // Only the rules lists change: every other line is as it was.
  const kept = (t: string) => t.replaceAll(/^rules = \[\n[\s\S]*?^\]\n|^builtin = .*\n|^off = .*\n/gm, "");
  assert.equal(kept(next), kept(text));
  assert.ok(samePlacements(text, next) > 10000);
});

test("an older config takes the earlier migrations, then names GitHub's rules, keeping the ask by name they made hard", () => {
  const now = defaultConfigText({ workOrgs: ["acme"], expanded: true }).replaceAll(/, weight = \d+/g, "");
  const old = now
    .replace(`why = "{me.requested_by} asked you directly" },`, `why = "{me.requested_by} asked you directly", nocap = true },`)
    .replace(/^ *\{ when = "me\.requested_direct && me\.requested_by_bot", .*\n/m, "");
  assert.notEqual(old, now);
  const next = parseConfig(migrateBuiltIns(migrateHard(old)!)!).loaded!.config.boards[0]!;
  assert.deepEqual(
    [next.builtin, next.off, next.rules.filter((r) => r.own !== undefined).map((r) => [r.id, r.hard])],
    ["review", ["asked-by-bot"], [["asked-directly", true]]],
  );
});

test("a desk started on a config.toml with GitHub's rules copied names them once, with a backup", async () => {
  const t = await setup([reviewAsk(1)]);
  const file = path.join(t.home, "config.toml");
  const copied = defaultConfigText({ workOrgs: ["acme"], expanded: true });
  fs.writeFileSync(file, copied);
  t.desk.store.set("builtins_migrated", null);
  await run(t.desk.migrateRules());
  assert.equal(fs.readFileSync(file, "utf8"), defaultConfigText({ workOrgs: ["acme"] }));
  assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), copied);
  fs.writeFileSync(file, copied);
  await run(t.desk.migrateRules());
  assert.equal(fs.readFileSync(file, "utf8"), copied, "once");
  t.cleanup();
});
