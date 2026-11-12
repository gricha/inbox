import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { Cause, Effect, Exit } from "effect";
import { main } from "../src/cli.ts";
import * as api from "../src/client.ts";
import { install, plistFor, uninstall } from "../src/launchd.ts";
import { startFakeApi, unusedPort, type FakeApi } from "./helpers/fake-api.ts";
import { failure, run as runFx } from "./helpers/run.ts";

const ROOT = join(import.meta.dirname, "..");
const BIN = join(ROOT, "bin", "desk");
const tmp = mkdtempSync(join(tmpdir(), "desk-cli-"));

let fake: FakeApi;
before(async () => {
  fake = await startFakeApi();
});
after(() => fake.close());

async function run(argv: string[], stdout: { isTTY?: boolean; columns?: number } = {}) {
  let out = "",
    err = "";
  const code = await main(argv, { stdout: { ...stdout, write: (s: string) => (out += s) }, stderr: { write: (s: string) => (err += s) } });
  return { code, out, err };
}

async function withPort<T>(port: number, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.DESK_PORT;
  process.env.DESK_PORT = String(port);
  try {
    return await fn();
  } finally {
    process.env.DESK_PORT = prev;
  }
}

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// A scratch HOME (USERPROFILE on Windows) and desk home, so connect never reads or writes the real ~/.claude, ~/.codex or ~/.inbox.
function scratchHome(settings: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmp, "home-"));
  writeFileSync(join(home, "settings.json"), JSON.stringify(settings));
  return { HOME: home, USERPROFILE: home, DESK_HOME: home, DESK_PORT: "47960" };
}

const lastCall = () => {
  const last = fake.calls.at(-1);
  assert.ok(last, "no call reached the fake API");
  return last;
};

test("client fails with DeskDown when nothing is listening", async () => {
  await withPort(await unusedPort(), async () => {
    const down = await failure(api.overview());
    assert.equal(down._tag, "DeskDown");
    assert.equal(down.message, "desk is not running — start it with: desk serve");
    const r = await run(["ls"]);
    assert.equal(r.code, 1);
    assert.equal(r.err, "desk is not running — start it with: desk serve\n");
  });
});

test("client maps 404 and 409 to readable errors, tagged by their status when the desk sends no tag", async () => {
  await assert.rejects(
    runFx(api.item("nope#9")),
    (e: Error) => e instanceof api.DeskApiError && e.status === 404 && e.tag === "NotFound" && e.message === "unknown item nope#9",
  );
  await assert.rejects(
    runFx(api.item("sentry#1")),
    (e: api.DeskApiError) =>
      e.status === 409 &&
      e.tag === "AmbiguousRef" &&
      e.candidates.length === 2 &&
      e.message.includes("candidates: getsentry/sentry#1, other/sentry#1"),
  );
});

test("a body the client can't encode is a bug, not the desk not answering", async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const exit = await Effect.runPromiseExit(api.createClient(() => new Response("{}")).putSettings(cyclic as never));
  assert.ok(Exit.isFailure(exit) && Cause.hasDies(exit.cause) && !Cause.hasFails(exit.cause), String(exit));
});

// One answer, at any path, from a desk that isn't the fake.
async function answering<T>(status: number, body: unknown, fn: () => Promise<T>): Promise<T> {
  const srv = createServer((_, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => {
    srv.listen(0, "127.0.0.1", r);
  });
  try {
    return await withPort((srv.address() as AddressInfo).port, fn);
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
}

// What the desk refused with: an API error, nothing else.
async function refusal<A>(effect: Effect.Effect<A, api.ClientError>): Promise<api.DeskApiError> {
  const e = await failure(effect);
  assert.ok(e instanceof api.DeskApiError, e.message);
  return e;
}

test("client keeps the tag and reason the desk sends, and a request with no answer in time keeps fetch's words", async () => {
  const stale = await answering(409, { error: "policy.md changed since you opened it", tag: "Stale" }, () => refusal(api.item("x")));
  assert.deepEqual([stale.status, stale.tag, stale.message], [409, "Stale", "policy.md changed since you opened it"]);
  // The words say nothing about config: the reason does.
  const broken = await answering(503, { error: "the rules have errors", tag: "Unavailable", reason: "config" }, () =>
    refusal(api.status(1000)),
  );
  assert.deepEqual([broken.tag, broken.reason], ["Unavailable", "config"]);
  const bug = await answering(500, { error: "x is undefined", tag: "Internal" }, () => refusal(api.overview()));
  assert.deepEqual([bug.status, bug.tag, bug.message], [500, "Internal", "x is undefined"]);
  const hung = createServer(() => {});
  await new Promise<void>((r) => {
    hung.listen(0, "127.0.0.1", r);
  });
  try {
    const late = await withPort((hung.address() as AddressInfo).port, () => failure(api.status(50)));
    assert.deepEqual([late._tag, late.message], ["DeskNoAnswer", "The operation was aborted due to timeout"]);
  } finally {
    hung.closeAllConnections();
    hung.close();
  }
});

test("ls defaults to focus, grouped by bucket, with counts of the rest", async () => {
  const r = await run(["ls"]);
  assert.equal(r.code, 0);
  assert.equal(
    r.out,
    [
      "NOW 1",
      "● seer#8949   Flag provider client calls in unchecked paths  octo asked you · 6d",
      "",
      "TODAY 1",
      "◐ sentry#101  Fix the flaky snuba test that only fails on Tuesdays  your team was asked · 1d",
      "",
      "1 later · 1 fyi · 1 cleared · 1 hidden  (desk ls --all)",
      "",
    ].join("\n"),
  );
  assert.equal(lastCall().path, "/api/queue");
});

test("ls --all on focus prints the whole queue", async () => {
  const r = await run(["ls", "--all"]);
  assert.equal(r.code, 0);
  assert.equal(lastCall().path, "/api/queue");
  assert.match(
    r.out,
    /^NOW 1\n● seer#8949 .*\n\nTODAY 1\n◐ sentry#101 .*\n\nLATER 1\n○ sentry#202 +Bump some dependency.*\n\nFYI 1\n· widgets#7 +Widget docs.*\n\nHIDDEN BY RULES 1\n× sentry#303 .*\n\nCLEARED \(done, snoozed, muted\) 1\n× sentry#404 .*\[done\]\n$/,
  );
});

test("ls <board> hides blocked/later/fyi unless --all, and counts cleared/hidden", async () => {
  const r = await run(["ls", "reviews"]);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /LATER|sentry#202/);
  assert.match(r.out, /1 blocked \u00b7 1 later \u00b7 1 fyi \u00b7 1 cleared \u00b7 1 hidden {2}\(desk ls reviews --all\)\n$/);

  const all = await run(["ls", "reviews", "--all"]);
  assert.match(all.out, /TODAY 1\n.*\n\nBLOCKED 1\n\u2298 sentry#606 +Read the new region config/);
  assert.match(all.out, /LATER 1\n○ sentry#202 +Bump some dependency/);
  assert.match(all.out, /FYI 1\n· widgets#7 +Widget docs/);
  assert.match(all.out, /HIDDEN BY RULES 1\n/);
  assert.match(all.out, /CLEARED \(done, snoozed, muted\) 1\n.*\[/);
});

test("ls unknown board lists the boards", async () => {
  const r = await run(["ls", "nope"]);
  assert.equal(r.code, 1);
  assert.equal(r.err, "desk: unknown board nope — boards: focus, reviews\n");
});

test("ls --json prints the raw view", async () => {
  const r = await run(["ls", "--json"]);
  assert.equal(JSON.parse(r.out).sections.now[0].id, "getsentry/seer#8949");
});

test("ls truncates to the terminal width", async () => {
  const r = await run(["ls"], { columns: 40 });
  for (const line of r.out.split("\n")) assert.ok(line.length <= 40, line);
  assert.match(r.out, /…/);
});

test("color only on a TTY without NO_COLOR", async () => {
  const prev = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  try {
    assert.ok((await run(["ls"], { isTTY: true, columns: 200 })).out.includes("\x1b["));
    assert.ok(!(await run(["ls"])).out.includes("\x1b["));
    process.env.NO_COLOR = "1";
    assert.ok(!(await run(["ls"], { isTTY: true, columns: 200 })).out.includes("\x1b["));
  } finally {
    if (prev === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prev;
  }
});

test("show prints facts and the rule trace", async () => {
  const r = await run(["show", "seer#8949"]);
  assert.equal(r.code, 0);
  const lines = r.out.split("\n");
  assert.equal(lines[0], "getsentry/seer#8949  Flag provider client calls in unchecked paths");
  assert.equal(lines[1], "https://github.com/getsentry/seer/pull/8949");
  assert.equal(lines[2], "inbox://item/getsentry/seer/8949");
  assert.match(lines[3] ?? "", /^pr by octo · CI red · \+120 −30 · updated 2h ago · active$/);
  assert.match(r.out, /reviews {2}● now {2}octo asked you · 6d/);
  assert.match(r.out, / {2}✓ filter !author\.bot\n {2}✗ #0 {5}pr\.ci == 'red' && me\.author\n {2}✓ #1 {5}me\.requested_direct\n/);
  assert.equal(JSON.parse((await run(["show", "seer#8949", "--json"])).out).card.id, "getsentry/seer#8949");
});

test("show reports ambiguous and unknown refs", async () => {
  const amb = await run(["show", "sentry#1"]);
  assert.equal(amb.code, 1);
  assert.match(amb.err, /candidates: getsentry\/sentry#1, other\/sentry#1/);
  const unk = await run(["show", "nope#9"]);
  assert.equal(unk.code, 1);
  assert.equal(unk.err, "desk: unknown item nope#9\n");
});

test("done/mute/pin post the action", async () => {
  for (const [cmd, past] of [
    ["done", "done"],
    ["mute", "muted"],
    ["pin", "pinned"],
    ["restore", "restored"],
  ] as const) {
    const r = await run([cmd, "seer#8949"]);
    assert.equal(r.code, 0);
    assert.deepEqual(lastCall(), { method: "POST", path: "/api/act", body: { id: "seer#8949", action: cmd } });
    assert.match(r.out, new RegExp(`^✓ ${past} getsentry/seer#8949  \\(desk undo \\d+ to revert\\)\\n$`));
  }
});

test("add posts the ref and says what it started", async () => {
  const r = await run(["add", "seer#8949"]);
  assert.equal(r.code, 0);
  assert.deepEqual(lastCall(), { method: "POST", path: "/api/add", body: { id: "seer#8949" } });
  assert.equal(r.out, "✓ added getsentry/seer#8949 to your desk, pinned, AI review started  (desk undo 8 to revert)\n");
  assert.equal((await run(["add"])).code, 2);
  assert.equal((await run(["add", "seer#8949", "your call on the timeout", "--from", "flags fix"])).code, 0);
  assert.deepEqual(lastCall().body, { id: "seer#8949", why: "your call on the timeout", from: "flags fix" });
});

test("snooze defaults to tomorrow and passes an explicit until", async () => {
  const r = await run(["snooze", "seer#8949"]);
  assert.equal(r.code, 0);
  assert.deepEqual(lastCall().body, { id: "seer#8949", action: "snooze", until: "tomorrow" });
  assert.match(r.out, /^✓ snoozed getsentry\/seer#8949 until .+ or activity {2}\(desk undo \d+ to revert\)\n$/);

  await run(["snooze", "seer#8949", "3h"]);
  assert.equal(lastCall().body.until, "3h");
  const act = await run(["snooze", "seer#8949", "activity"]);
  assert.match(act.out, /^✓ snoozed getsentry\/seer#8949 until someone else acts {2}\(desk undo \d+ to revert\)\n$/);
});

test("undo, sync, prompt", async () => {
  assert.equal((await run(["undo"])).out, "✓ Undid done on seer#8949\n");
  assert.equal(lastCall().path, "/api/undo");
  assert.equal((await run(["sync"])).out, "sync started\n");
  assert.equal(
    (await run(["prompt", "seer#8949"])).out,
    "Review https://github.com/getsentry/seer/pull/8949\nTitle: Flag provider client calls in unchecked paths\n",
  );
});

test("prompt drops terminal control chars from a hostile title", async () => {
  assert.equal(
    (await run(["prompt", "widgets#66"])).out,
    "Review https://github.com/acme/widgets/pull/66\nTitle: Hi]52;c;cm0gLXJmIH4=there\n",
  );
});

test("status prints focus totals and boards", async () => {
  const r = await run(["status"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /^● 1 now {2}◐ 1 today {2}\+1 new {3}synced (just now|\dm ago)\n/);
  assert.match(r.out, /\nWork\n {2}reviews {2}PRs to review {2}\u25cf1 \u25d01 \u22980 \u25cb1 \u00b71 {2}\+1 new\n/);
});

test("status --short prints the status text, or 'desk offline' fast", async () => {
  assert.deepEqual(await run(["status", "--short"]), { code: 0, out: "desk 2 +1\n", err: "" });
  await withPort(await unusedPort(), async () => {
    assert.deepEqual(await run(["status", "--short"]), { code: 0, out: "desk offline\n", err: "" });
  });
  // 503 means up but not serving yet, or the config never loaded: by its reason, or an older desk's words.
  for (const [body, out] of [
    [{ error: "desk is starting; the first sync can take a minute" }, "desk starting\n"],
    [{ error: "config has errors: boards[0].id: missing" }, "desk config error\n"],
    [{ error: "config has errors: boards[0].id: missing", tag: "Unavailable", reason: "config" }, "desk config error\n"],
    [{ error: "the rules have errors", tag: "Unavailable", reason: "config" }, "desk config error\n"],
    [{ error: "the config is loading", tag: "Unavailable", reason: "starting" }, "desk starting\n"],
  ] as const) {
    assert.equal((await answering(503, body, () => run(["status", "--short"]))).out, out, JSON.stringify(body));
  }
  assert.equal((await answering(500, { error: "oops", tag: "Internal" }, () => run(["status", "--short"]))).out, "desk offline\n");
  // A server that accepts but never answers must not hang the status line.
  const hung = createServer(() => {});
  await new Promise<void>((r) => {
    hung.listen(0, "127.0.0.1", r);
  });
  try {
    const t0 = Date.now();
    const r = await withPort((hung.address() as AddressInfo).port, () => run(["status", "--short"]));
    assert.equal(r.out, "desk offline\n");
    assert.ok(Date.now() - t0 < 1800, `took ${Date.now() - t0}ms`);
  } finally {
    hung.closeAllConnections();
    hung.close();
  }
});

test("a bug in a command is `desk: <its words>`, exit 1", async () => {
  // A desk that answers 200 with nothing: ls reads null.
  const r = await answering(200, null, () => run(["ls"]));
  assert.equal(r.code, 1);
  assert.match(r.err, /^desk: .*null.*\n$/);
});

test("usage errors exit 2", async () => {
  const settings = [
    ["settings", "nope"],
    ["settings", "set", "github.bots"],
    ["settings", "reset"],
    ["settings", "reset", "a", "b"],
    ["settings", "set", "a", "b", "c"],
  ];
  for (const argv of [
    ["frobnicate"],
    ["done"],
    ["show", "a", "b"],
    ["ls", "--bogus"],
    ["config", "nope"],
    ["serve", "--port", "x"],
    ["serve", "--port", "0"],
    ["connect", "vim"],
    ["connect", "claude", "codex"],
    ["setup", "vim"],
    ...settings,
  ]) {
    const r = await run(argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.err, /^desk: .+\nrun 'desk help' for usage\n$/);
  }
  const help = await run([]);
  assert.equal(help.code, 0);
  assert.match(help.out, /^usage: desk <command>/);
  assert.equal((await run(["ls", "--help"])).code, 0);
});

test("config path, check, edit", async () => {
  const file = join(tmp, "config.toml");
  fake.configPath = file;
  writeFileSync(file, "poll_seconds = 60\n");
  assert.equal((await run(["config"])).out, `${file}\n`);
  assert.equal((await run(["config", "path"])).out, `${file}\n`);

  const ok = await run(["config", "check"]);
  assert.equal(ok.code, 0);
  assert.equal(ok.out, `✓ ${file} is valid\n`);
  assert.deepEqual(lastCall().body, { text: "poll_seconds = 60\n" });

  writeFileSync(file, "INVALID\n");
  const bad = await run(["config", "check"]);
  assert.equal(bad.code, 1);
  assert.equal(bad.out, "✗ boards[0].rules[0].when: unknown field me.nope\n");

  const prev = process.env.EDITOR;
  process.env.EDITOR = "true";
  try {
    writeFileSync(file, "poll_seconds = 30\n");
    const ed = await run(["config", "edit"]);
    assert.equal(ed.code, 0);
    assert.deepEqual(lastCall(), { method: "PUT", path: "/api/config", body: { text: "poll_seconds = 30\n" } });
  } finally {
    process.env.EDITOR = prev;
  }
});

test("config works with the desk down: path, and check reads the file itself", async (c) => {
  const home = mkdtempSync(join(tmpdir(), "desk-offline-"));
  c.after(() => {
    rmSync(home, { recursive: true, force: true });
  });
  writeFileSync(join(home, "config.toml"), "INVALID\n");
  await withEnv({ DESK_HOME: home, DESK_PORT: String(await unusedPort()) }, async () => {
    const bad = await run(["config", "check"]);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /^✗ line 1: Invalid TOML document/m);
    assert.match(bad.out, /desk isn't running; start it with: desk serve\n$/);
    assert.equal((await run(["config", "path"])).out, `${join(home, "config.toml")}\n`);
  });
});

test("settings lists effective values by section and stars overrides", async () => {
  fake.settings = { "github.poll_seconds": 120 };
  const r = await run(["settings"]);
  assert.equal(r.code, 0);
  assert.match(
    r.out,
    /^GitHub\n {2}github\.resolve_on_others_approval +always\n {2}review\.auto_ai +true\n {2}review\.at_once +8\n {2}github\.my_repos +\(none\)\n/,
  );
  assert.match(r.out, /\n\* github\.poll_seconds +120\n {2}handoff\.prompt +Review \{item\.url\} by \{item\.author\}\. … \(\+3 lines\)\n/);
  assert.match(r.out, /\n\nAgent\n {2}agent\.harness +claude-code\n {2}policy\.judge +true\n/);
  assert.match(
    r.out,
    /\n\nInbox and notifications\n {2}queue\.quiet_days +14\n {2}queue\.urgent_at +8\n {2}queue\.fyi_at +3\n {2}notify\.enabled +true\n {2}notify\.quiet +19:00-09:00\n/,
  );
  assert.match(r.out, /\n\nThis device\n {2}app\.hotkey +/);
  assert.deepEqual(
    r.out.split("\n").filter((l) => /^\S/.test(l) && !l.startsWith("*")),
    ["GitHub", "Sessions", "Agent", "Inbox and notifications", "This device"],
  );
  assert.match(r.out, /\n\n\* set in \/home\/you\/\.inbox\/settings\.json\n$/);
  assert.equal(lastCall().path, "/api/settings");
  assert.equal(JSON.parse((await run(["settings", "--json"])).out).values["github.poll_seconds"], 120);
});

test("settings set parses the value by the setting's type", async () => {
  const cases: [string, string, unknown][] = [
    ["github.poll_seconds", "300", 300],
    ["notify.enabled", "off", false],
    ["notify.enabled", "YES", true],
    ["github.bots", "renovate, dependabot ,", ["renovate", "dependabot"]],
    ["github.bots", '["a-bot[bot]", "b"]', ["a-bot[bot]", "b"]],
    ["github.bots", "", []],
    ["notify.quiet", "", ""],
    ["app.hotkey", "Control+Shift+K", "Control+Shift+K"],
    ["handoff.issue", "Look at {item.url}\nThen reply.", "Look at {item.url}\nThen reply."],
  ];
  for (const [key, raw, value] of cases) {
    const r = await run(["settings", "set", key, raw]);
    assert.equal(r.code, 0, `${key} ${raw}: ${r.err}`);
    assert.deepEqual(lastCall(), { method: "PUT", path: "/api/settings", body: { set: { [key]: value } } });
  }
  assert.equal((await run(["settings", "set", "github.poll_seconds", "300"])).out, "✓ github.poll_seconds = 300\n");
  assert.equal((await run(["settings", "set", "notify.enabled", "on"])).out, "✓ notify.enabled = true  (default)\n");
  assert.equal((await run(["settings", "set", "github.bots", "a,b"])).out, "✓ github.bots = a, b\n");
  assert.equal(fake.settings["github.poll_seconds"], 300);
});

test("settings set rejects bad values without writing", async () => {
  fake.settings = { "github.poll_seconds": 120 };
  const bad: [string[], string][] = [
    [["github.poll_seconds", "5"], "desk: github.poll_seconds must be at least 30\n"],
    [["github.poll_seconds", "soon"], "desk: github.poll_seconds must be a number\n"],
    [["notify.enabled", "maybe"], "desk: notify.enabled must be true or false (yes/no, on/off)\n"],
    [["github.my_repos", "nope"], `desk: github.my_repos "nope" isn't owner/name\n`],
    [["nope.key", "1"], `desk: unknown setting "nope.key"; desk settings lists them\n`],
  ];
  for (const [args, err] of bad) {
    const r = await run(["settings", "set", ...args]);
    assert.equal(r.code, 1, args.join(" "));
    assert.equal(r.err, err);
  }
  assert.match((await run(["settings", "set", "github.bots", "[oops"])).err, /^desk: github\.bots: bad JSON list/);
  assert.deepEqual(fake.settings, { "github.poll_seconds": 120 });
});

test("settings reset puts one back to its default", async () => {
  fake.settings = { "github.poll_seconds": 120 };
  const r = await run(["settings", "reset", "github.poll_seconds"]);
  assert.equal(r.code, 0);
  assert.equal(r.out, "✓ github.poll_seconds = 90  (default)\n");
  assert.deepEqual(lastCall(), { method: "PUT", path: "/api/settings", body: { reset: ["github.poll_seconds"] } });
  assert.deepEqual(fake.settings, {});
});

test("connect claude prints what's missing and the commands that fix it", async () => {
  const env = scratchHome();
  const r = await withEnv(env, () => run(["connect", "claude"]));
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split("\n");
  assert.deepEqual(lines.slice(0, 3), [
    "# Claude Code (desk connect claude --apply does this)",
    "# MCP tools: not connected",
    "claude mcp add --transport http --scope user inbox http://localhost:47960/mcp",
  ]);
  assert.equal(lines[3], "# Skill: not installed");
  assert.match(lines[4]!, /^mkdir -p .*\.claude.skills'? && cp -R .*inbox'? .*\.claude.skills'?\/$/);
  // A name another server keeps: the desk's goes beside it, and says so.
  writeFileSync(join(env.HOME, ".claude.json"), JSON.stringify({ mcpServers: { inbox: { command: "mail-mcp" } } }));
  const beside = (await withEnv(env, () => run(["connect", "claude"]))).out.split("\n");
  assert.deepEqual(beside.slice(1, 3), [
    "# MCP tools: not connected",
    "claude mcp add --transport http --scope user inbox-desk http://localhost:47960/mcp",
  ]);
  assert.equal(beside[5], "# Connects as inbox-desk: your server named inbox (mail-mcp) keeps its name");
});

test("setup shows GitHub and each agent with what to run, and naming one picks it", async () => {
  const r = await run(["setup"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.out.split("\n"), [
    "✓ GitHub: signed in as @you",
    "  Claude Code  ready",
    "  Codex        not logged in. Run: codex login",
    "  OpenCode     not installed. Run: curl -fsSL https://opencode.ai/install | bash && opencode auth login",
    "Pick one: desk setup claude, codex or opencode",
    "",
  ]);
  const picked = await run(["setup", "claude"]);
  assert.equal(picked.out, "✓ GitHub: signed in as @you\n✓ Claude Code is your agent: Inbox's MCP tools and skill are installed in it\n");
  assert.deepEqual(fake.calls.at(-1), { method: "POST", path: "/api/setup", body: { agent: "claude-code" } });
  const refused = await run(["setup", "opencode"]);
  assert.deepEqual(
    [refused.code, refused.err],
    [1, "desk: OpenCode isn't installed. Run curl -fsSL https://opencode.ai/install | bash && opencode auth login\n"],
  );
});

test("connect without an argument connects Claude Code; codex connects Codex", async () => {
  const claude = await withEnv(scratchHome(), () => run(["connect"]));
  assert.match(claude.out, /^# Claude Code \(desk connect --apply does this\)\n/);
  const codex = await withEnv(scratchHome(), () => run(["connect", "codex"]));
  assert.equal(codex.code, 0, codex.err);
  assert.match(codex.out, /^# Codex \(desk connect codex --apply does this\)\n/);
  assert.match(codex.out, /^codex mcp add inbox --url http:\/\/localhost:47960\/mcp$/m);
  assert.equal((await withEnv(scratchHome(), () => run(["connect", "vim"]))).code, 2);
});

// A fake claude, alone on PATH, so the real one (and the user's config) is never reached.
test("connect --apply registers the desk and installs the skill", { skip: process.platform === "win32" }, async () => {
  const env = scratchHome();
  const bin = join(env.HOME, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "$HOME/claude-args"\nprintf '{"mcpServers":{"inbox":{"type":"http","url":"%s"}}}' "$8" > "$HOME/.claude.json"\n`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  const missing = await withEnv({ ...env, PATH: tmp }, () => run(["connect", "--apply"]));
  assert.equal(missing.code, 1);
  assert.equal(
    missing.err,
    "desk: claude isn't on PATH. Run it yourself: claude mcp add --transport http --scope user inbox http://localhost:47960/mcp\n",
  );
  const r = await withEnv({ ...env, PATH: bin }, () => run(["connect", "--apply"]));
  assert.equal(r.code, 0, r.err);
  assert.equal(
    readFileSync(join(env.HOME, "claude-args"), "utf8"),
    "mcp\nadd\n--transport\nhttp\n--scope\nuser\ninbox\nhttp://localhost:47960/mcp\n",
  );
  const skill = join(env.HOME, ".claude", "skills", "inbox", "SKILL.md");
  assert.equal(r.out, `✓ Claude Code: MCP tools connected, skill installed (${skill})\n`);
  assert.equal(readFileSync(skill, "utf8"), readFileSync(join(ROOT, "skills", "inbox", "SKILL.md"), "utf8"));
});

test("install and uninstall are macOS-only", async () => {
  const real = Object.getOwnPropertyDescriptor(process, "platform")!;
  for (const platform of ["linux", "win32"]) {
    Object.defineProperty(process, "platform", { value: platform });
    try {
      // Never reach launchctl from a test.
      assert.equal(process.platform, platform);
      for (const cmd of ["install", "uninstall"]) {
        const r = await run([cmd]);
        assert.equal(r.code, 1);
        assert.equal(
          r.err,
          `desk: ${cmd} is macOS-only. On Linux and Windows, use Settings → This device → Open at login in the desktop app\n`,
        );
      }
    } finally {
      Object.defineProperty(process, "platform", real);
    }
  }
});

test(
  "install boots out the job from before the rename, moves ~/.review-desk to ~/.inbox, retries launchctl bootstrap 5 times, 500 ms apart, then says its words; uninstall removes the plists",
  { skip: process.platform !== "darwin" },
  async (c) => {
    const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
    c.after(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    const bin = mkdtempSync(join(tmpdir(), "desk-launchctl-"));
    const home = mkdtempSync(join(tmpdir(), "desk-launchd-home-"));
    c.after(() => {
      for (const dir of [bin, home]) rmSync(dir, { recursive: true, force: true });
    });
    writeFileSync(
      join(bin, "launchctl"),
      `#!/bin/sh\necho "$*" >> "$HOME/calls"\n[ "$1" = bootstrap ] && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 1; }\nexit 0\n`,
    );
    chmodSync(join(bin, "launchctl"), 0o755);
    // The fake alone on PATH: the real launchctl, and the owner's own dev.inbox.desk job, are out of reach.
    process.env.HOME = home;
    process.env.PATH = bin;
    const agents = join(home, "Library", "LaunchAgents");
    const old = join(agents, "dev.review-desk.desk.plist");
    mkdirSync(agents, { recursive: true });
    writeFileSync(old, "<plist/>");
    mkdirSync(join(home, ".review-desk"));
    writeFileSync(join(home, ".review-desk", "config.toml"), "# mine\n");
    const said: string[] = [];
    const e = await failure(
      install("/x/cli.ts", await unusedPort(), (m) => {
        said.push(m);
      }),
    );
    assert.deepEqual([e._tag, e.message], ["CommandFailed", "launchctl bootstrap failed: Bootstrap failed: 5: Input/output error"]);
    const uid = process.getuid!();
    const plist = join(agents, "dev.inbox.desk.plist");
    const calls = () => readFileSync(join(home, "calls"), "utf8").trim().split("\n");
    assert.deepEqual(calls(), [
      `bootout gui/${uid}/dev.review-desk.desk`,
      `bootout gui/${uid}/dev.inbox.desk`,
      ...Array.from({ length: 5 }, () => `bootstrap gui/${uid} ${plist}`),
    ]);
    assert.ok(!existsSync(old), "the old label's plist is gone");
    assert.ok(existsSync(plist));
    assert.equal(
      readFileSync(join(home, ".inbox", "config.toml"), "utf8"),
      "# mine\n",
      "the home moved before ~/.inbox was made for the log",
    );
    assert.ok(lstatSync(join(home, ".review-desk")).isSymbolicLink(), "left as a link to the home");
    assert.deepEqual(said, [
      `moved the desk's home from ${join(home, ".review-desk")} to ${join(home, ".inbox")}, and left ${join(home, ".review-desk")} as a link to it`,
    ]);
    assert.match(
      readFileSync(plist, "utf8"),
      new RegExp(`<key>StandardOutPath</key>\\s*<string>${join(home, ".inbox", "desk.log")}</string>`),
    );
    writeFileSync(old, "<plist/>");
    assert.deepEqual(await runFx(uninstall()), [old, plist]);
    assert.ok(!existsSync(plist) && !existsSync(old));
    assert.deepEqual(calls().slice(-2), [`bootout gui/${uid}/dev.review-desk.desk`, `bootout gui/${uid}/dev.inbox.desk`]);
    assert.deepEqual(await runFx(uninstall()), [], "nothing left to remove");
  },
);

test(
  "install with a desk still running from ~/.review-desk installs nothing: its job's desk would move the folder its log is in",
  { skip: process.platform !== "darwin", timeout: 20_000 },
  async (c) => {
    const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
    const bin = mkdtempSync(join(tmpdir(), "desk-launchctl-"));
    const home = mkdtempSync(join(tmpdir(), "desk-launchd-home-"));
    // A desk from the old home (Review Desk.app, say) that booting out the jobs doesn't stop.
    const desk = createServer(() => {});
    await new Promise<void>((r) => {
      desk.listen(0, "127.0.0.1", r);
    });
    c.after(() => {
      desk.close();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      for (const dir of [bin, home]) rmSync(dir, { recursive: true, force: true });
    });
    writeFileSync(join(bin, "launchctl"), `#!/bin/sh\necho "$*" >> "$HOME/calls"\nexit 0\n`);
    chmodSync(join(bin, "launchctl"), 0o755);
    process.env.HOME = home;
    process.env.PATH = bin;
    const old = join(home, ".review-desk");
    mkdirSync(old);
    const e = await failure(install("/x/cli.ts", (desk.address() as AddressInfo).port));
    assert.deepEqual(
      [e._tag, e.message],
      [
        "Conflict",
        `desk install needs the port free: quit the desk running from ${old} (Review Desk.app, or that desk serve), then run it again`,
      ],
    );
    assert.ok(!existsSync(join(home, "Library", "LaunchAgents", "dev.inbox.desk.plist")), "no plist naming a log in the old folder");
    assert.ok(!readFileSync(join(home, "calls"), "utf8").includes("bootstrap"));
    assert.ok(lstatSync(old).isDirectory() && !existsSync(join(home, ".inbox")));
  },
);

// oxlint-disable-next-line typescript/strict-void-return -- promisify picks execFile's util.promisify.custom form, so no return value is discarded
const execBin = promisify(execFile);

// bin/desk is a POSIX sh launcher; Windows uses bin/desk.cmd.
test("bin/desk resolves through a symlink", { skip: process.platform === "win32" }, async () => {
  const link = join(tmp, "desk");
  symlinkSync(BIN, link);
  const env = { ...process.env, DESK_PORT: String(fake.port) };
  const { stdout } = await execBin(link, ["status", "--short"], { env });
  assert.equal(stdout, "desk 2 +1\n");

  const down = { ...process.env, DESK_PORT: String(await unusedPort()) };
  const t0 = Date.now();
  const r = await execBin(link, ["status", "--short"], { env: down });
  assert.equal(r.stdout, "desk offline\n");
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`);

  await assert.rejects(
    execBin(link, ["ls"], { env: down }),
    (e: { code: number; stderr: string }) => e.code === 1 && e.stderr === "desk is not running — start it with: desk serve\n",
  );
});

// launchd is macOS-only, and Windows would join these paths with backslashes.
test("plistFor builds a LaunchAgent plist", { skip: process.platform === "win32" }, () => {
  const xml = plistFor({
    nodePath: "/opt/node/bin/node",
    cliPath: "/Users/a&b/review-desk/src/cli.ts",
    home: "/Users/a&b",
    deskHome: "/Users/a&b/.inbox",
    port: 47823,
  });
  assert.match(xml, /<key>Label<\/key>\s*<string>dev\.inbox\.desk<\/string>/);
  assert.match(
    xml,
    /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/node\/bin\/node<\/string>\s*<string>--disable-warning=ExperimentalWarning<\/string>\s*<string>\/Users\/a&amp;b\/review-desk\/src\/cli\.ts<\/string>\s*<string>serve<\/string>\s*<\/array>/,
  );
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(xml, /<key>StandardOutPath<\/key>\s*<string>\/Users\/a&amp;b\/\.inbox\/desk\.log<\/string>/);
  assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/a&amp;b\/\.inbox\/desk\.log<\/string>/);
  assert.match(
    xml,
    /<key>PATH<\/key>\s*<string>\/opt\/node\/bin:\/Users\/a&amp;b\/\.local\/bin:\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin<\/string>/,
  );
  assert.match(xml, /<key>DESK_PORT<\/key>\s*<string>47823<\/string>/);

  const file = join(tmp, "test.plist");
  writeFileSync(file, xml);
  const lint = spawnSync("plutil", ["-lint", file], { encoding: "utf8" });
  if (!lint.error) assert.equal(lint.status, 0, lint.stdout + lint.stderr);
});
