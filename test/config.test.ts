import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfigText, migrateBotAsk, migrateConflict, migrateDrafts, migrateHard, parseConfig } from "../src/config.ts";

test("default configs parse cleanly", () => {
  for (const orgs of [["acme"], ["acme", "globex"], []]) {
    const { loaded, errors } = parseConfig(defaultConfigText({ workOrgs: orgs }));
    assert.deepEqual(errors, []);
    assert.ok(loaded!.config.boards.length >= 3);
    for (const b of loaded!.config.boards) assert.ok(loaded!.config.spaces.some((s) => s.id === b.space));
    // Caps apply after the judge, so a board without them would let the policy fill Now.
    for (const b of loaded!.config.boards) assert.equal(b.caps?.now, 3, b.id);
  }
  const cfg = parseConfig(defaultConfigText({ workOrgs: ["acme"] })).loaded!.config;
  assert.equal(cfg.spaces.find((s) => s.id === "personal")!.scope, "-org:acme");
  assert.ok(cfg.handoff.prompt.includes("Do not post"));
});

test("TOML syntax errors report a line", () => {
  const { loaded, errors } = parseConfig("poll_seconds = \n[[boards]]");
  assert.equal(loaded, null);
  assert.match(errors[0]?.path ?? "", /^line \d+/);
});

test("validation finds typos, bad buckets and bad expressions", () => {
  const { errors } = parseConfig(`
[[spaces]]
id = "w"
[[boards]]
id = "x"
space = "nope"
query = "is:pr"
sort = "random"
caps = { now = 3, tomorrow = 2 }
rules = [ { when = "pr.cii == 'red'", bucket = "urgent" }, { bucket = "now" } ]
`);
  const paths = errors.map((e) => e.path).sort();
  assert.deepEqual(paths, [
    "boards[0].caps.tomorrow",
    "boards[0].rules[0].bucket",
    "boards[0].rules[0].when",
    "boards[0].rules[1].when",
    "boards[0].sort",
    "boards[0].space",
  ]);
  assert.match(errors.find((e) => e.path === "boards[0].rules[0].when")!.message, /did you mean "pr.ci"/);
});

test("duplicate ids and missing queries", () => {
  const { errors } = parseConfig(`
[[spaces]]
id = "w"
[[boards]]
id = "a"
[[boards]]
id = "a"
query = "x"
`);
  assert.ok(errors.some((e) => e.path === "boards[0].queries"));
  assert.ok(errors.some((e) => e.message.includes("duplicate board id")));
});

test("only GitHub's boards need a search query, and a board that names no source parses as before", () => {
  const { errors } = parseConfig(`
[[spaces]]
id = "w"
[[boards]]
id = "a"
source = "notes"
[[boards]]
id = "b"
source = "github"
[[boards]]
id = "c"
source = 1
`);
  assert.deepEqual(
    errors.map((e) => `${e.path}: ${e.message}`),
    [
      "boards[1].queries: needs at least one GitHub search query",
      "boards[2].source: must be a string",
      "boards[2].queries: needs at least one GitHub search query",
    ],
  );
  const board = parseConfig(`[[spaces]]\nid = "w"\n[[boards]]\nid = "a"\nquery = "x"\n`).loaded!.config.boards[0]!;
  assert.equal("source" in board, false);
});

test("settings left in config.toml are ignored with a warning pointing to Settings", () => {
  const { loaded, errors, warnings } = parseConfig(
    `poll_seconds = 5\n[signals]\nbots = ["x"]\n[[spaces]]\nid = "w"\n[[boards]]\nid = "a"\nquery = "x"\n`,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(
    warnings.map((e) => e.path),
    ["poll_seconds", "signals"],
  );
  assert.equal(warnings[0]?.message, '"poll_seconds" moved to Settings (settings.json); delete it here');
  assert.equal(loaded!.config.poll_seconds, 90);
  assert.deepEqual(loaded!.config.signals.bots, []);
});

test("a config written before hard rules gets its ask-by-name rule made hard, and nothing else", () => {
  const now = defaultConfigText({ workOrgs: ["acme"] });
  const old = now.replaceAll(`asked you directly", hard = true`, `asked you directly", nocap = true`);
  assert.notEqual(old, now);
  assert.equal(migrateHard(old), now);
  assert.equal(migrateHard(now), null, "already hard");
  const edited = old.replace(`why = "{me.requested_by} asked you directly", nocap = true`, `why = "asked by name", nocap = true`);
  const rules = parseConfig(migrateHard(edited)!).loaded!.config.boards.flatMap((b) => b.rules);
  assert.deepEqual(
    rules.filter((r) => r.when === "me.requested_direct && !me.requested_by_bot").map((r) => [r.hard, r.why]),
    [
      [true, "asked by name"],
      [true, "{me.requested_by} asked you directly"],
    ],
    "its own why is kept",
  );
  assert.equal(rules.filter((r) => r.nocap).length, 2, "My PRs' changes requested stays nocap");
  assert.equal(
    migrateHard(old.replaceAll(`bucket = "now", why = "{me.requested_by}`, `bucket = "today", why = "{me.requested_by}`)),
    null,
    "a rule the owner changed is theirs",
  );
});

test("a config from before the bot-ask rule gets it right after the hard rule for a person's ask, once", () => {
  const now = defaultConfigText({ workOrgs: ["acme"] });
  const bot = `{ when = "me.requested_direct", bucket = "today", why = "asked you by name (added by {me.requested_by})", hard = true },`;
  const old = now.replaceAll(`  ${bot}\n`, "");
  assert.notEqual(old, now);
  assert.equal(migrateBotAsk(old), now);
  assert.equal(migrateBotAsk(now), null, "already there");
  assert.equal(migrateBotAsk(migrateHard(old.replaceAll(`asked you directly", hard = true`, `asked you directly", nocap = true`))!), now);
  const soft = old.replaceAll(`asked you directly", hard = true`, `asked you directly"`);
  assert.equal(migrateBotAsk(soft), null, "a rule the owner made soft is theirs");
  const last = old.replace(/(asked you directly", hard = true \}),/, "$1");
  assert.deepEqual(parseConfig(migrateBotAsk(last)!).errors, [], "one without its trailing comma");
});

test("a config written before drafts reached the desk gets both draft rules on every My PRs board, and nothing else", () => {
  const now = defaultConfigText({ workOrgs: ["acme"] });
  const fresh = `  { when = "item.draft && item.updated_hours < 336", bucket = "today", why = "your draft: finish it", hard = true },\n  { when = "item.draft", bucket = "later", why = "draft, quiet for 2+ weeks" },`;
  const old = now.replaceAll(fresh, `  { when = "item.draft", bucket = "later", why = "draft" },`);
  assert.notEqual(old, now);
  assert.equal(migrateDrafts(old), now);
  assert.equal(migrateDrafts(now), null, "already migrated");
  assert.equal(migrateDrafts(old.replaceAll(`why = "draft" }`, `why = "my draft" }`)), null, "a rule the owner changed is theirs");
  const mine = parseConfig(migrateDrafts(old)!).loaded!.config.boards.filter((b) => b.name === "My PRs");
  assert.equal(mine.length, 2);
  for (const b of mine) assert.deepEqual([!!b.rules[1]?.hard, b.rules[1]?.bucket, b.rules[2]?.bucket], [true, "today", "later"]);
  // A blank line before it stays the only one.
  const spaced = old.replace(
    `},\n  { when = "item.draft", bucket = "later", why = "draft" },`,
    `},\n\n  { when = "item.draft", bucket = "later", why = "draft" },`,
  );
  assert.notEqual(spaced, old);
  assert.ok(migrateDrafts(spaced)!.includes(`},\n\n${fresh}`));
});

const RED = `  { when = "pr.ci == 'red' && pr.pushed_hours >= 1", bucket = "today", why = "CI failing" },\n`;
const CONFLICT = `  { when = "pr.mergeable == 'conflict'", bucket = "today", why = "merge conflict" },\n`;

test("a merge conflict alone leaves the desk: the old rule goes from every My PRs board, unless the owner changed it", () => {
  const now = defaultConfigText({ workOrgs: ["acme"] });
  const old = now.replaceAll(RED, RED + CONFLICT);
  assert.equal(old.split(CONFLICT).length - 1, 2, "both My PRs boards, as in the owner's config");
  assert.equal(migrateConflict(old), now);
  assert.equal(migrateConflict(now), null, "already gone");
  const edited = old.replace(`why = "merge conflict" }`, `why = "rebase it" }`);
  const kept = migrateConflict(edited)!;
  assert.ok(kept.includes(`bucket = "today", why = "rebase it" },`), "a rule the owner changed is theirs");
  assert.equal(kept.split(CONFLICT).length - 1, 0, "the other board's goes");
  const last = now.replace(`nudge a reviewer?" },\n`, `$&${CONFLICT.replace("},", "}")}`);
  assert.deepEqual(parseConfig(last).errors, []);
  assert.deepEqual(parseConfig(migrateConflict(last)!).errors, [], "the last one, without its trailing comma");
});

test("the oldest first-run config reaches today's through the migrations, and today's is left alone", () => {
  const now = defaultConfigText({ workOrgs: ["acme"] });
  const bot = `{ when = "me.requested_direct", bucket = "today", why = "asked you by name (added by {me.requested_by})", hard = true },`;
  const fresh = `  { when = "item.draft && item.updated_hours < 336", bucket = "today", why = "your draft: finish it", hard = true },\n  { when = "item.draft", bucket = "later", why = "draft, quiet for 2+ weeks" },`;
  const old = now
    .replaceAll(`  ${bot}\n`, "")
    .replaceAll(`asked you directly", hard = true`, `asked you directly", nocap = true`)
    .replaceAll(fresh, `  { when = "item.draft", bucket = "later", why = "draft" },`)
    .replaceAll(RED, RED + CONFLICT);
  assert.equal(migrateConflict(migrateDrafts(migrateBotAsk(migrateHard(old)!)!)!), now);
  for (const m of [migrateHard, migrateBotAsk, migrateDrafts, migrateConflict]) assert.equal(m(now), null, m.name);
});

test("final parses on any bucket; final with judge is an error", () => {
  const one = (rule: string) =>
    parseConfig(`
[[spaces]]
id = "w"
[[boards]]
id = "x"
query = "is:pr"
rules = [ ${rule} ]
`);
  for (const bucket of ["now", "today", "blocked", "later", "fyi", "hide"]) {
    const r = one(`{ when = "pr.blocked", bucket = "${bucket}", final = true }`);
    assert.deepEqual(r.errors, [], bucket);
    assert.equal(r.loaded!.config.boards[0]!.rules[0]!.final, true);
  }
  assert.equal(one(`{ when = "pr.blocked", bucket = "blocked" }`).loaded!.config.boards[0]!.rules[0]!.final, false);
  assert.deepEqual(
    one(`{ when = "pr.blocked", bucket = "judge", final = true }`).errors.map((e) => `${e.path}: ${e.message}`),
    ["boards[0].rules[0].final: a final rule places the item itself; give it a bucket, not judge"],
  );
  assert.deepEqual(
    one(`{ when = "pr.blocked", bucket = "blocked", final = "yes" }`).errors.map((e) => `${e.path}: ${e.message}`),
    ["boards[0].rules[0].final: must be true or false"],
  );
  assert.deepEqual(one(`{ when = "pr.blocked", bucket = "blocked", hard = true }`).errors, []);
});

test("the template: blocked first on every PR board", () => {
  const boards = parseConfig(defaultConfigText({ workOrgs: ["acme"] })).loaded!.config.boards;
  const rule = (id: string, i: number) => {
    const r = boards.find((b) => b.id === id)!.rules[i]!;
    return [r.when, r.bucket, !!r.final, !!r.hard];
  };
  const index = (id: string, when: string) => boards.find((b) => b.id === id)!.rules.findIndex((r) => r.when === when);
  for (const space of ["acme", "personal"]) {
    const mine = `${space}-mine`;
    assert.deepEqual(rule(mine, 0), ["pr.blocked && pr.review != 'changes_requested' && !me.owes_reply", "blocked", true, false]);
    const changes = index(mine, "pr.review == 'changes_requested'");
    assert.deepEqual(rule(mine, changes + 1), ["len(pr.requires_closed) > 0", "today", false, false]);
    assert.deepEqual(rule(mine, changes + 2), ["len(pr.blocks) > 0 && me.owes_reply", "today", false, false]);
    const threads = index(mine, "pr.unresolved_threads > 0");
    assert.deepEqual(rule(mine, threads - 1), [
      "len(pr.waiting_on) > 0 && !me.owes_reply && pr.ci != 'red' && pr.mergeable != 'conflict'",
      "blocked",
      true,
      false,
    ]);
    for (const id of [`${space}-review`, `${space}-mentions`]) assert.deepEqual(rule(id, 0), ["pr.blocked", "blocked", true, false], id);
    assert.deepEqual(rule(`${space}-review`, 1).slice(0, 2), ["me.requested_direct && !me.requested_by_bot", "now"]);
    assert.equal(rule(`${space}-review`, 1)[3], true, "the hard direct-ask rules follow");
  }
  assert.deepEqual(rule("acme-collaborators", 0), ["pr.blocked", "blocked", true, false]);
});
