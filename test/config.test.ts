import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfigText, migrateBotAsk, migrateDrafts, migrateHard, parseConfig } from "../src/config.ts";

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
  for (const b of mine) assert.deepEqual([b.rules[0]?.hard, b.rules[0]?.bucket, b.rules[1]?.bucket], [true, "today", "later"]);
});

test("the oldest first-run config reaches today's through all three migrations, and today's is left alone", () => {
  const now = defaultConfigText({ workOrgs: ["acme"] });
  const bot = `{ when = "me.requested_direct", bucket = "today", why = "asked you by name (added by {me.requested_by})", hard = true },`;
  const fresh = `  { when = "item.draft && item.updated_hours < 336", bucket = "today", why = "your draft: finish it", hard = true },\n  { when = "item.draft", bucket = "later", why = "draft, quiet for 2+ weeks" },`;
  const old = now
    .replaceAll(`  ${bot}\n`, "")
    .replaceAll(`asked you directly", hard = true`, `asked you directly", nocap = true`)
    .replaceAll(fresh, `  { when = "item.draft", bucket = "later", why = "draft" },`);
  assert.equal(migrateDrafts(migrateBotAsk(migrateHard(old)!)!), now);
  for (const m of [migrateHard, migrateBotAsk, migrateDrafts]) assert.equal(m(now), null, m.name);
});
