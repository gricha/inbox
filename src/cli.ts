// `desk`: a thin CLI over the local desk API.

import { spawnSync } from "node:child_process";
import os from "node:os";
import { readFileSync, realpathSync, watchFile, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { Cause, Data, Effect, Exit, Option } from "effect";
import * as agents from "./agents.ts";
import * as api from "./client.ts";
import { untilText } from "./client.ts";
import { fsError, messageOf } from "./errors.ts";
import { deskHome } from "./home.ts";
import { judgeText, weighedLines } from "./judge.ts";
import { permalink } from "./links.ts";
import { renderText } from "./render.ts";
import { install, uninstall } from "./launchd.ts";
import { startSentry, stopSentry } from "./sentry.ts";
import { openCommand } from "./notify.ts";
import { UNTIL, type Action, type Bucket, type Card, type SettingDef, type SettingValue } from "./types.ts";

export interface Out {
  write(s: string): unknown;
  isTTY?: boolean;
  columns?: number;
}
export interface IO {
  stdout: Out;
  stderr: Out;
}

const USAGE = `usage: desk <command>

  serve [--port N] [--open] [--tailscale]
                                      run the desk server in the foreground; --tailscale: also for your other devices
  open                                open the UI in the browser
  status [--short]                    counts per board; --short prints the status-line text
  ls [board|focus] [--all] [--json]   list cards (default focus); --all adds blocked, later and fyi
  show <ref> [--json]                 one item: why, facts, rule trace
  add <ref> [why] [--from <task>]     put a PR or issue on your desk (fetched if new, pinned) and start its pre-review;
                                      why: the line it shows as why it's there
  done|mute|unmute|pin|unpin|restore <ref>
  urgent|standard|fyi <ref>           move it to that section of the Inbox, until you're done with it, snooze or mute it
  snooze <ref> [until]                1h, 3h, tomorrow (default), monday, activity, ISO time, or ci|push|approved|ready|conflict
  undo [seq]                          undo the last action (or the one with that number)
  sync                                sync with GitHub now (read only)
  prompt <ref>                        print the review hand-off prompt
  brief <ref> [--force]               the PR's AI review: look/skim/skip, summary, concerns; cached per commit
  render <doc.json> [-o out.html]     a review document (docs/review-format.md) as one HTML page, beside it unless -o
                                      says where (- for stdout); no desk needed
  config [path|check|edit]            where the config lives, validate it, or edit it
  settings [--json]                   every setting by section; * = changed from the default
  settings set <key> <value>          change one; lists: a,b or a JSON array; booleans: true/false, yes/no, on/off
  settings reset <key>                back to the default
  fields                              the fields rules can use
  mcp [--url <address>]               MCP server on stdio (the desk also serves MCP over HTTP at /mcp); --url or DESK_URL,
                                      with DESK_TOKEN, for a desk on another machine
  setup [claude|codex|opencode]       the first-run page: GitHub and each agent, what to run; naming one sets it as your
                                      agent and connects it (Settings → Local Agent Integration)
  connect [claude|codex|opencode] [--apply]
                                      connect your agent (Settings → Local Agent Integration) to the desk: MCP tools and skill; --apply does it
  connect <address> --code <code> [claude|codex|opencode]
                                      on another machine: pair with the desk at its tailnet address, connect your agent to it
  pair [--print] [--name <name>]      pair another device over Tailscale: a one-time code and what to run there;
                                      --print: a token for one machine and the commands to paste there
  install | uninstall                 run the server at login (macOS launchd)

<ref> is owner/repo#123, repo#123 when unique, a GitHub URL, or an item's link from the desk (inbox://item/owner/repo/123).
`;

// What you typed isn't a command the CLI knows how to run: exit 2, with the usage hint.
class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string }> {}

// The command can't do what you asked: its words, exit 1.
class CliError extends Data.TaggedError("CliError")<{ readonly message: string; readonly cause?: unknown }> {}

// Every command's failure is a tagged error main tells apart by its tag and shows by its message.
type Failure = Error & { readonly _tag: string };
type Command = (x: Ctx) => Effect.Effect<number, Failure>;

const GLYPH: Record<Bucket, string> = { now: "\u25cf", today: "\u25d0", blocked: "\u2298", later: "\u25cb", fyi: "\u00b7", hide: "\u00d7" };
const PAST: Record<string, string> = {
  done: "done",
  mute: "muted",
  unmute: "unmuted",
  pin: "pinned",
  unpin: "unpinned",
  restore: "restored",
  snooze: "snoozed",
  urgent: "moved to Urgent",
  standard: "moved to Standard",
  fyi: "moved to FYI",
};

const OPTIONS: Record<string, ParseArgsConfig["options"]> = {
  serve: { port: { type: "string" }, open: { type: "boolean" }, tailscale: { type: "boolean" } },
  status: { short: { type: "boolean" } },
  ls: { all: { type: "boolean" }, json: { type: "boolean" } },
  brief: { force: { type: "boolean" } },
  show: { json: { type: "boolean" } },
  settings: { json: { type: "boolean" } },
  connect: { apply: { type: "boolean" }, code: { type: "string" } },
  pair: { print: { type: "boolean" }, name: { type: "string" } },
  mcp: { url: { type: "string" } },
  add: { from: { type: "string" } },
  render: { out: { type: "string", short: "o" } },
};

// [min, max] positionals per command.
const ARITY: Record<string, [number, number]> = {
  serve: [0, 0],
  open: [0, 0],
  status: [0, 0],
  ls: [0, 1],
  show: [1, 1],
  snooze: [1, 2],
  undo: [0, 1],
  sync: [0, 0],
  prompt: [1, 1],
  brief: [1, 1],
  render: [1, 1],
  fields: [0, 0],
  config: [0, 1],
  settings: [0, 3],
  mcp: [0, 0],
  connect: [0, 2],
  setup: [0, 1],
  pair: [0, 0],
  install: [0, 0],
  uninstall: [0, 0],
  add: [1, 2],
  done: [1, 1],
  mute: [1, 1],
  unmute: [1, 1],
  pin: [1, 1],
  unpin: [1, 1],
  restore: [1, 1],
  urgent: [1, 1],
  standard: [1, 1],
  fyi: [1, 1],
};

function palette(on: boolean) {
  const c = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { bold: c("1"), dim: c("2"), red: c("31"), green: c("32"), yellow: c("33") };
}

function ctxFor(io: IO, args: string[], opts: Record<string, unknown>) {
  const c = palette(!!io.stdout.isTTY && !process.env.NO_COLOR);
  const glyph = (b: Bucket) => (b === "now" ? c.red : b === "today" ? c.yellow : b === "fyi" ? c.dim : (s: string) => s)(GLYPH[b]);
  return {
    args,
    opts,
    c,
    glyph,
    width: io.stdout.columns ?? (io.stdout.isTTY ? 80 : Infinity),
    out: (s = "") => void io.stdout.write(s + "\n"),
  };
}
type Ctx = ReturnType<typeof ctxFor>;

const shortRef = (card: Card) => `${card.repo.split("/")[1]}#${card.number}`;
// GitHub titles are untrusted: strip control chars so they can't emit terminal escapes.
const plain = (s: string) => s.replaceAll(/\p{Cc}+/gu, " ");
const clip = (s: string, n: number) => (s.length <= n ? s : n <= 1 ? "" : s.slice(0, n - 1) + "…");

// The title wins: the why is clipped first, down to 20 columns, before the title gives way.
function fit(title: string, why: string, avail: number): [string, string] {
  if (title.length + 2 + why.length <= avail) return [title, why];
  const t = clip(title, Math.max(Math.min(title.length, avail - 2 - Math.min(why.length, 20)), Math.min(title.length, 24, avail)));
  const rest = avail - t.length - 2;
  return [t, rest >= 8 ? clip(why, rest) : ""];
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

const localTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function printCards(x: Ctx, groups: [Bucket, Card[], string?][]): void {
  const shown = groups.filter(([, cs]) => cs.length);
  const refW = Math.max(0, ...shown.flatMap(([, cs]) => cs.map((k) => shortRef(k).length)));
  shown.forEach(([b, cs, label], i) => {
    if (i) x.out();
    x.out(x.c.bold(`${label ?? b.toUpperCase()} ${cs.length}`));
    for (const k of cs) {
      const [t, w] = fit(plain(k.title), plain(k.why), x.width - refW - 4);
      const note =
        k.status !== "active"
          ? `  [${k.status}${k.snooze_when ? ` until ${UNTIL[k.snooze_when]}` : k.snooze_until ? ` until ${localTime(k.snooze_until)}` : ""}]`
          : k.demoted
            ? `  (${k.demoted})`
            : "";
      x.out(
        `${x.glyph(b)} ${shortRef(k).padEnd(refW)}  ${k.new ? x.c.bold(t) : t}${w ? "  " + x.c.dim(w) : ""}${note ? x.c.dim(note) : ""}`,
      );
    }
  });
}

const ls = Effect.fnUntraced(function* (x: Ctx) {
  const which = x.args[0] ?? "focus";
  // An unknown board lists the ones there are.
  const board = api.board(which).pipe(
    Effect.catchTag("DeskApiError", (e) =>
      e.tag !== "NotFound"
        ? Effect.fail(e)
        : Effect.flatMap(api.overview(), (o) => {
            const ids = o.spaces.flatMap((s) => s.boards.map((b) => b.id));
            return Effect.fail(new CliError({ message: `${e.message} — boards: focus, ${ids.join(", ")}` }));
          }),
    ),
  );
  // Focus is the queue's Now and Today; the queue has the rest for --all and the counts.
  const v = which === "focus" ? yield* api.queue() : yield* board;
  if (x.opts.json) return (x.out(JSON.stringify(v, null, 2)), 0);
  const s = v.sections;
  const groups: [Bucket, Card[], string?][] = [
    ["now", s.now],
    ["today", s.today],
  ];
  if (x.opts.all) groups.push(["blocked", s.blocked], ["later", s.later], ["fyi", s.fyi]);
  if (groups.every(([, cs]) => !cs.length)) x.out(`Nothing in ${groups.map(([b]) => b.toUpperCase()).join(" or ")}.`);
  if (x.opts.all) groups.push(["hide", v.hidden, "HIDDEN BY RULES"], ["hide", v.cleared, "CLEARED (done, snoozed, muted)"]);
  printCards(x, groups);
  const counts: [number, string][] = x.opts.all
    ? []
    : [
        [s.blocked.length, "blocked"],
        [s.later.length, "later"],
        [s.fyi.length, "fyi"],
        [v.cleared.length, "cleared"],
        [v.hidden.length, "hidden"],
        ["reviewing" in v ? v.reviewing : 0, "more once Claude has reviewed them"],
      ];
  const more = counts.filter(([n]) => n).map(([n, l]) => `${n} ${l}`);
  const hint =
    !x.opts.all && (s.blocked.length || s.later.length || s.fyi.length) ? `  (desk ls ${which === "focus" ? "" : `${which} `}--all)` : "";
  if (more.length) x.out("\n" + x.c.dim(clip(more.join(" · ") + hint, x.width)));
  return 0;
});

const show = Effect.fnUntraced(function* (x: Ctx) {
  const d = yield* api.item(x.args[0]!);
  if (x.opts.json) return (x.out(JSON.stringify(d, null, 2)), 0);
  const k = d.card;
  const st = d.state;
  const statusText =
    k.status === "snoozed" && k.snooze_when
      ? `snoozed until ${UNTIL[k.snooze_when]}`
      : k.status === "snoozed"
        ? `snoozed${st.snooze_until ? ` until ${localTime(st.snooze_until)}` : ""}${st.snooze_on_activity ? `${st.snooze_until ? " or" : " until"} activity` : ""}`
        : k.status;
  x.out(`${x.c.bold(k.id)}  ${plain(k.title)}`);
  x.out(x.c.dim(k.url));
  x.out(x.c.dim(permalink({ item: k.id })));
  x.out(
    [
      `${k.kind} by ${k.author}${k.author_bot ? " (bot)" : ""}`,
      ...k.chips,
      `updated ${ago(k.updated_at)}`,
      statusText,
      ...(k.pinned ? ["pinned"] : []),
    ].join(" · "),
  );
  if (!d.placements.length) x.out(x.c.dim("Not on any board now: a board filter drops it, or no board's search returns it anymore."));
  for (const p of d.placements) {
    x.out();
    x.out(`${x.c.bold(p.board)}  ${x.glyph(p.bucket)} ${p.bucket}  ${x.c.dim(plain(p.why))}`);
    if (p.demoted) x.out(x.c.dim(`  rule said ${p.rule_bucket}; ${p.demoted}`));
    for (const t of p.trace) {
      const mark = t.error ? x.c.red("!") : t.matched ? x.c.green("✓") : x.c.dim("✗");
      x.out(`  ${mark} ${(t.index < 0 ? "filter" : `#${t.index}`).padEnd(6)} ${t.when}${t.error ? x.c.red(`  ${t.error}`) : ""}`);
    }
    if (p.rule === null) x.out(x.c.dim(`  → default`));
    if (p.floor) x.out(x.c.dim(`  → ${p.hard ? "hard rule" : "pinned"}: never below ${p.floor}`));
    if (p.judge) x.out(`  → ${plain(judgeText(p.judge))}`);
  }
  if (d.judge) {
    x.out();
    for (const l of weighedLines(d.judge)) x.out(l.startsWith("  ") ? plain(l) : x.c.bold(l));
  }
  return 0;
});

const act =
  (action: Action): Command =>
  (x) => {
    const until = action === "snooze" ? (x.args[1] ?? "tomorrow") : undefined;
    return Effect.map(api.act(x.args[0]!, action, until), (r) => {
      const s = r.state;
      const when = untilText(until, s, localTime);
      x.out(`${x.c.green("✓")} ${PAST[action]} ${s.id}${when}  ${x.c.dim(`(desk undo ${r.undo_seq} to revert)`)}`);
      return 0;
    });
  };

const add: Command = (x) =>
  Effect.map(api.add(x.args[0]!, x.args[1], typeof x.opts.from === "string" ? x.opts.from : undefined), (r) => {
    const d = r.item;
    const ai = d.generating ? ", AI review started" : "";
    x.out(`${x.c.green("✓")} added ${d.card.id} to your desk, pinned${ai}  ${x.c.dim(`(desk undo ${r.undo_seq} to revert)`)}`);
    return 0;
  });

// 503 = up but not serving: still starting, or the config never loaded. Anything else (no answer, a bug) is offline.
function statusWord(cause: Cause.Cause<api.ClientError>): string {
  const e = Option.getOrUndefined(Cause.findErrorOption(cause));
  if (e?._tag !== "DeskApiError" || e.tag !== "Unavailable") return "desk offline";
  return e.reason === "config" ? "desk config error" : "desk starting";
}

const status = Effect.fnUntraced(function* (x: Ctx) {
  // Feeds a status line: never fail, never hang.
  if (x.opts.short)
    return yield* api.status(1000).pipe(
      Effect.map((s) => {
        if (s.text) x.out(s.text);
        return 0;
      }),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          x.out(statusWord(cause));
          return 0;
        }),
      ),
    );
  const o = yield* api.overview();
  const sync = o.syncing ? "syncing…" : `synced ${ago(o.synced_at)}`;
  x.out(`${x.glyph("now")} ${o.focus.now} now  ${x.glyph("today")} ${o.focus.today} today  +${o.focus.new} new   ${x.c.dim(sync)}`);
  if (o.sync_error) x.out(x.c.red(`sync error: ${o.sync_error}`));
  if (o.config_errors.length) x.out(x.c.red(`${o.config_errors.length} config error(s) — desk config check`));
  if (o.rate_limit && o.rate_limit.remaining < 500)
    x.out(x.c.yellow(`GitHub rate limit low: ${o.rate_limit.remaining} left, resets ${localTime(o.rate_limit.reset_at)}`));
  const boards = o.spaces.flatMap((s) => s.boards);
  const idW = Math.max(0, ...boards.map((b) => b.id.length));
  const nameW = Math.max(0, ...boards.map((b) => b.name.length));
  for (const s of o.spaces) {
    x.out();
    x.out(x.c.bold(s.name));
    for (const b of s.boards) {
      const n = b.counts;
      const counts = (["now", "today", "blocked", "later", "fyi"] as const).map((k) => `${x.glyph(k)}${n[k]}`).join(" ");
      x.out(
        `  ${b.id.padEnd(idW)}  ${b.name.padEnd(nameW)}  ${counts}${b.new ? `  +${b.new} new` : ""}${b.error ? x.c.red(`  ${b.error}`) : ""}`,
      );
    }
  }
  return 0;
});

const readText = (file: string) => Effect.try({ try: () => readFileSync(file, "utf8"), catch: fsError("read", file) });

const config = Effect.fnUntraced(function* (x: Ctx) {
  const sub = x.args[0] ?? "path";
  if (!["path", "check", "edit"].includes(sub)) return yield* new UsageError({ message: `unknown config command: ${sub}` });
  // Works with the server down too: that's when you most need to fix the config.
  const up = yield* api.getConfig().pipe(Effect.catchTag("DeskDown", () => Effect.succeed(null)));
  const path = up?.path ?? join(deskHome(), "config.toml");
  if (sub === "path") return (x.out(path), 0);
  if (sub === "edit") {
    const editor = (process.env.EDITOR ?? "") || (process.platform === "win32" ? "notepad" : "vi");
    // A shell splits EDITOR's flags ("code -w"). Windows paths can't contain quotes.
    const r =
      process.platform === "win32"
        ? spawnSync(`${editor} "${path}"`, { shell: true, stdio: "inherit" })
        : spawnSync("/bin/sh", ["-c", `${editor} "$1"`, "sh", path], { stdio: "inherit" });
    if (r.status !== 0) return yield* new CliError({ message: `editor exited with ${r.status ?? r.signal}` });
  }
  if (!up) {
    const { parseConfig } = yield* Effect.promise(() => import("./config.ts"));
    const { errors, warnings } = parseConfig(yield* readText(path));
    for (const e of errors) x.out(`${x.c.red("✗")} ${e.path}: ${e.message}`);
    for (const w of warnings) x.out(`${x.c.yellow("!")} ${w.path}: ${w.message}`);
    x.out(
      errors.length
        ? x.c.dim("desk isn't running; start it with: desk serve")
        : `${x.c.green("✓")} ${path} is valid (desk isn't running; start it with: desk serve)`,
    );
    return errors.length ? 1 : 0;
  }
  // Validate what's on disk, which may differ from what the server loaded.
  const text = yield* readText(path);
  const { errors, warnings = [] } = sub === "edit" ? yield* api.putConfig(text) : yield* api.previewConfig(text);
  for (const e of errors) x.out(`${x.c.red("✗")} ${e.path}: ${e.message}`);
  for (const w of warnings) x.out(`${x.c.yellow("!")} ${w.path}: ${w.message}`);
  if (errors.length) {
    if (sub === "edit") x.out(x.c.dim("not applied; the server keeps the last valid config"));
    return 1;
  }
  x.out(`${x.c.green("✓")} ${path} ${sub === "edit" ? "saved; syncing" : "is valid"}`);
  return 0;
});

function showSetting(v: SettingValue | undefined): string {
  if (Array.isArray(v)) return v.length ? v.join(", ") : "(none)";
  if (v === "") return "(empty)";
  const lines = String(v).split("\n");
  return plain(lines[0] ?? "") + (lines.length > 1 ? ` … (+${lines.length - 1} lines)` : "");
}

// The server checks ranges and patterns; this only turns the argument into the setting's type.
function parseSetting(d: SettingDef, raw: string): Effect.Effect<SettingValue, CliError> {
  const bad = (message: string) => Effect.fail(new CliError({ message }));
  if (d.type === "number") {
    if (!raw.trim() || Number.isNaN(Number(raw))) return bad(`${d.key} must be a number`);
    return Effect.succeed(Number(raw));
  }
  if (d.type === "boolean") {
    const v = raw.trim().toLowerCase();
    if (["true", "yes", "on"].includes(v)) return Effect.succeed(true);
    if (["false", "no", "off"].includes(v)) return Effect.succeed(false);
    return bad(`${d.key} must be true or false (yes/no, on/off)`);
  }
  if (d.type === "list") {
    if (!raw.trim().startsWith("["))
      return Effect.succeed(
        raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    return Effect.try({
      try: () => JSON.parse(raw) as string[],
      catch: (cause) => new CliError({ message: `${d.key}: bad JSON list (${(cause as Error).message})`, cause }),
    });
  }
  return Effect.succeed(raw);
}

const settings = Effect.fnUntraced(function* (x: Ctx) {
  const [sub, key, raw] = x.args;
  if (sub === "set" && x.args.length !== 3) return yield* new UsageError({ message: "settings set needs <key> <value>" });
  if (sub === "reset" && x.args.length !== 2) return yield* new UsageError({ message: "settings reset needs <key>" });
  if (sub !== undefined && sub !== "set" && sub !== "reset") return yield* new UsageError({ message: `unknown settings command: ${sub}` });
  const v = yield* api.settings();
  if (sub === undefined) {
    if (x.opts.json) return (x.out(JSON.stringify(v, null, 2)), 0);
    const w = Math.max(...v.defs.map((d) => d.key.length));
    const groups = v.sections.map((s) => [s, v.defs.filter((d) => d.section === s.id)] as const).filter(([, ds]) => ds.length);
    groups.forEach(([s, ds], i) => {
      if (i) x.out();
      x.out(x.c.bold(s.title));
      for (const d of ds)
        x.out(`${v.overridden.includes(d.key) ? "*" : " "} ${d.key.padEnd(w)}  ${clip(showSetting(v.values[d.key]), x.width - w - 4)}`);
    });
    for (const e of v.errors) x.out(x.c.red(`✗ ${e.path}: ${e.message}`));
    x.out("\n" + x.c.dim(`* set in ${v.path}`));
    return 0;
  }
  const d = v.defs.find((def) => def.key === key);
  if (!d) return yield* new CliError({ message: `unknown setting "${key}"; desk settings lists them` });
  const r = yield* api.putSettings(sub === "set" ? { set: { [d.key]: yield* parseSetting(d, raw!) } } : { reset: [d.key] });
  if (!r.ok) return yield* new CliError({ message: r.errors.map((e) => `${e.path} ${e.message}`).join("; ") });
  const isDefault = !r.settings.overridden.includes(d.key);
  x.out(`${x.c.green("✓")} ${d.key} = ${showSetting(r.settings.values[d.key])}${isDefault ? x.c.dim("  (default)") : ""}`);
  return 0;
});

const SKILL_STATE = { installed: "installed", outdated: "out of date", missing: "not installed" };

// The harness you work in, given the desk's tools: Claude Code unless you name Codex or OpenCode. Works with the desk down too: it
// reads the agent's own config files.
const HARNESSES: Record<string, { id: agents.DriverId; label: string }> = {
  claude: { id: "claude-code", label: "Claude Code" },
  codex: { id: "codex", label: "Codex" },
  opencode: { id: "opencode", label: "OpenCode" },
};

// A desk on another machine, from its address as `desk pair` prints it: https://<its tailnet name>.
const addressOf = (typed: string): string | null => {
  const u = URL.parse(typed.includes("://") ? typed : `https://${typed}`);
  return u && u.protocol === "https:" && (u.pathname === "/" || u.pathname === "") && !u.search && !u.hash ? u.origin : null;
};

// On another machine: the code traded for this machine's token, then the agent given the desk's skill and MCP server.
const connectTo = Effect.fnUntraced(function* (x: Ctx) {
  const at = addressOf(x.args[0]!);
  if (!at)
    return yield* new UsageError({ message: `the desk's address is https://<its tailnet name>, as desk pair prints it: not ${x.args[0]}` });
  const driver = HARNESSES[x.args[1] ?? "claude"];
  if (!driver) return yield* new UsageError({ message: `unknown agent: ${x.args[1]} (try: claude, codex or opencode)` });
  if (typeof x.opts.code !== "string")
    return yield* new UsageError({ message: "connect <address> needs --code <code>: run desk pair on the desk's machine" });
  const desk = api.createClient((p, init) => fetch(at + p, init));
  const { token } = yield* desk.trade(x.opts.code, os.hostname());
  const noSkill = (why: string, cause?: unknown) =>
    new CliError({ message: `the desk paired this machine but didn't send its skill (${why}): run desk pair again`, cause });
  const res = yield* Effect.tryPromise({
    try: () => fetch(`${at}/skill`, { headers: { authorization: `Bearer ${token}` } }),
    catch: (cause) => noSkill(messageOf(cause), cause),
  });
  if (!res.ok) return yield* noSkill(`HTTP ${res.status}`);
  const skill = yield* Effect.tryPromise({ try: () => res.text(), catch: (cause) => noSkill(messageOf(cause), cause) });
  yield* agents.connectRemote(driver.id, `${at}/mcp`, token, skill);
  x.out(`${x.c.green("✓")} ${driver.label}: paired with ${at}, MCP tools and skill connected`);
  if (driver.id !== "claude-code") {
    x.out(
      `# ${driver.label} reads the token from ${agents.TOKEN_VAR}: put this line in your shell's profile (it's a password for your desk)`,
    );
    x.out(`export ${agents.TOKEN_VAR}=${token}`);
  }
  x.out(`# Revoke it on the desk's machine: Settings → This device`);
  return 0;
});

// On the desk's machine: what another device needs to pair, or with --print one machine's token and what to paste there.
const pair = Effect.fnUntraced(function* (x: Ctx) {
  if (x.opts.print) {
    const { url, token } = yield* api.pairToken(typeof x.opts.name === "string" ? x.opts.name : "A machine (desk pair --print)");
    x.out("# Paste these on the other machine. The token is a password for your desk; revoke it in Settings → This device.");
    for (const line of agents.remoteCommands(url, token)) x.out(line);
    return 0;
  }
  const p = yield* api.pairCode();
  x.out(`Pairing code ${x.c.bold(p.code)}: works once, for 10 minutes.`);
  x.out("");
  x.out(`A browser on your other device: open ${p.pair_url}`);
  x.out(`Another machine with an Inbox checkout: bin/desk connect ${p.url} --code ${p.code}`);
  x.out(`One without: run desk pair --print here instead, and paste what it prints there.`);
  return 0;
});

const connect = Effect.fnUntraced(function* (x: Ctx) {
  if (x.args[0] && /[.:]/.test(x.args[0])) return yield* connectTo(x);
  if (x.args.length > 1) return yield* new UsageError({ message: `connect: unexpected argument ${x.args[1]}` });
  const driver = HARNESSES[x.args[0] ?? "claude"];
  if (!driver) return yield* new UsageError({ message: `unknown agent: ${x.args[0]} (try: desk connect claude, codex or opencode)` });
  const url = `http://localhost:${(process.env.DESK_PORT ?? "") || 47823}/mcp`;
  const log = (line: string) => {
    x.out(`# ${line}`);
  };
  const s = x.opts.apply ? yield* agents.connect(driver.id, url, { log }) : yield* agents.status(driver.id, url);
  if (s.mcp.connected && s.skill.state === "installed") {
    x.out(`${x.c.green("✓")} ${driver.label}: MCP tools connected, skill installed (${s.skill.path})`);
    return 0;
  }
  x.out(`# ${driver.label}${x.opts.apply ? "" : ` (desk connect ${x.args[0] ? `${x.args[0]} ` : ""}--apply does this)`}`);
  x.out(`# MCP tools: ${s.mcp.connected ? "connected" : "not connected"}`);
  if (s.connect.includes(s.mcp.command)) x.out(s.mcp.command);
  x.out(`# Skill: ${SKILL_STATE[s.skill.state]}`);
  if (s.connect.includes(s.skill.command)) x.out(s.skill.command);
  if (s.note) x.out(`# ${s.note}`);
  x.out(`# The tools work while the desk runs (the app or desk serve). Clients that only speak stdio: desk mcp`);
  return 0;
});

// The first-run page in a terminal: GitHub and each agent asked again; with an agent named, that one picked and connected.
const setup = Effect.fnUntraced(function* (x: Ctx) {
  const pick = x.args[0];
  const driver = pick === undefined ? undefined : HARNESSES[pick];
  if (pick !== undefined && !driver)
    return yield* new UsageError({ message: `unknown agent: ${pick} (try: desk setup claude, codex or opencode)` });
  const s = driver ? yield* api.chooseAgent(driver.id) : yield* api.checkSetup();
  const g = s.github;
  x.out(g.login ? `${x.c.green("✓")} GitHub: signed in as @${g.login}` : `GitHub: ${g.error}${g.fix ? ` Run: ${g.fix}` : ""}`);
  if (driver) {
    x.out(`${x.c.green("✓")} ${driver.label} is your agent: Inbox's MCP tools and skill are installed in it`);
    if (s.needed) x.out(`Inbox opens once GitHub is connected: run ${g.fix ?? "desk setup"}, then press Retry in the app`);
    return 0;
  }
  for (const a of s.agents) {
    const state = a.logged_in ? "ready" : a.installed ? "not logged in" : "not installed";
    const mark = s.agent === a.id && !s.needed ? x.c.green("✓") : " ";
    x.out(`${mark} ${a.name.padEnd(12)} ${state}${a.fix ? `. Run: ${a.fix}` : ""}`);
  }
  if (s.needed) x.out(`Pick one: desk setup claude, codex or opencode`);
  return 0;
});

// launchd is macOS-only; elsewhere the desktop app's login item does the job.
const macOnly = (cmd: string): Effect.Effect<void, CliError> =>
  process.platform === "darwin"
    ? Effect.void
    : Effect.fail(
        new CliError({
          message: `${cmd} is macOS-only. On Linux and Windows, use Settings → This device → Open at login in the desktop app`,
        }),
      );

const serve = Effect.fnUntraced(function* (x: Ctx) {
  const raw = typeof x.opts.port === "string" ? x.opts.port : (process.env.DESK_PORT ?? "") || 47823;
  const port = Number(raw);
  // Port 0 would pick a random port no client can find.
  if (!Number.isInteger(port) || port < 1 || port > 65535) return yield* new UsageError({ message: `bad port: ${raw}` });
  // Before the server's modules load, so Sentry instruments them.
  yield* Effect.promise(() => startSentry());
  const { startDesk, refreshAgents } = yield* Effect.promise(() => import("./server.ts"));
  const srv = yield* startDesk({ port, open: !!x.opts.open, tailscale: !!x.opts.tailscale });
  const desk = srv.desk;
  // The checkout's desk restarts on src/ changes only, so a skill-only merge would wait for an unrelated one.
  watchFile(agents.SKILL_MD, { interval: 5000, persistent: false }, () => {
    desk.runner.fork("skill refresh", refreshAgents(desk, srv.url));
  });
  yield* Effect.callback<void>((resume) => {
    const stop = () => {
      resume(Effect.void);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  yield* Effect.promise(() => srv.close());
  yield* Effect.promise(() => stopSentry());
  return 0;
});

const cliPath = () => {
  const file = import.meta.filename;
  return Effect.try({ try: () => realpathSync(file), catch: fsError("realpath", file) });
};

const COMMANDS: Record<string, Command> = {
  serve,
  status,
  ls,
  show,
  config,
  settings,
  connect,
  setup,
  pair,
  add,
  done: act("done"),
  mute: act("mute"),
  unmute: act("unmute"),
  pin: act("pin"),
  unpin: act("unpin"),
  restore: act("restore"),
  urgent: act("urgent"),
  standard: act("standard"),
  fyi: act("fyi"),
  snooze: act("snooze"),
  open: () =>
    Effect.map(api.health(), () => {
      spawnSync(...openCommand(api.baseUrl() + "/"));
      return 0;
    }),
  undo: Effect.fnUntraced(function* (x: Ctx) {
    const seq = x.args[0] === undefined ? undefined : Number(x.args[0]);
    if (seq !== undefined && !Number.isInteger(seq)) return yield* new UsageError({ message: `bad undo number: ${x.args[0]}` });
    const r = yield* api.undo(seq);
    x.out(`${x.c.green("✓")} Undid ${r.action} on ${r.id.split("/")[1]}`);
    return 0;
  }),
  sync: (x) =>
    Effect.map(api.sync(), () => {
      x.out("sync started");
      return 0;
    }),
  // The prompt template can interpolate the title; keep newlines and tabs, drop other control chars.
  prompt: (x) =>
    Effect.map(api.item(x.args[0]!), (d) => {
      x.out(d.handoff_prompt.replaceAll(/(?![\t\n])\p{Cc}/gu, ""));
      return 0;
    }),
  fields: (x) =>
    Effect.map(api.fields(), (fs) => {
      const w = Math.max(...fs.map((f) => f.path.length));
      for (const f of fs) x.out(`${f.path.padEnd(w)}  ${x.c.dim(f.type.padEnd(8))}  ${f.doc}`);
      return 0;
    }),
  brief: (x) =>
    Effect.map(api.aiReview(x.args[0]!, !!x.opts.force), ({ ai: b }) => {
      const clean = (t: string) => t.replaceAll(/\p{Cc}/gu, " ");
      const color = b.verdict === "look" ? x.c.red : b.verdict === "skim" ? x.c.yellow : x.c.dim;
      x.out(`${color(b.verdict.toUpperCase())} · risk ${b.risk} · ${b.model}`);
      x.out(clean(b.summary));
      for (const r of b.concerns) x.out(`  - ${clean(r)}`);
      if (b.notes.length) x.out(x.c.dim(`${b.notes.length} notes on the code: open the PR in the desk to read them`));
      return 0;
    }),
  // No desk: the document is read and rendered here, as the desk would.
  render: Effect.fnUntraced(function* (x: Ctx) {
    const file = x.args[0]!;
    const text = yield* Effect.try({ try: () => readFileSync(file, "utf8"), catch: fsError("read", file) });
    const { html, dropped } = yield* renderText(text);
    const out = typeof x.opts.out === "string" ? x.opts.out : file.replace(/(\.json)?$/i, ".html");
    if (out === "-") {
      x.out(html.trimEnd());
      return 0;
    }
    yield* Effect.try({
      try: () => {
        writeFileSync(out, html);
      },
      catch: fsError("write", out),
    });
    for (const d of dropped) x.out(x.c.dim(`left out: ${d}`));
    x.out(out);
    return 0;
  }),
  // The MCP server answers its tools' failures itself; it runs until stdin ends.
  mcp: (x) =>
    Effect.promise(async () => {
      if (typeof x.opts.url === "string") process.env.DESK_URL = x.opts.url;
      const { runMcp } = await import("./mcp.ts");
      await runMcp();
      await new Promise((r) => {
        process.stdin.once("end", r);
      });
      return 0;
    }),
  install: Effect.fnUntraced(function* (x: Ctx) {
    yield* macOnly("install");
    const { file, log } = yield* install(yield* cliPath(), undefined, (m) => {
      x.out(m);
    });
    x.out(`${x.c.green("✓")} installed ${file}\n  desk serve now runs at login; log: ${log}`);
    return 0;
  }),
  uninstall: Effect.fnUntraced(function* (x: Ctx) {
    yield* macOnly("uninstall");
    const gone = yield* uninstall();
    x.out(gone.length ? `${x.c.green("✓")} removed ${gone.join(" and ")}` : "nothing to remove: desk install wasn't run");
    return 0;
  }),
};

const STDIO: IO = { stdout: process.stdout, stderr: process.stderr };

// The command, with its arguments read as it takes them.
const command = Effect.fnUntraced(function* (cmd: string, rest: string[], io: IO) {
  const run = COMMANDS[cmd];
  const arity = ARITY[cmd];
  if (!run || !arity) return yield* new UsageError({ message: `unknown command: ${cmd}` });
  // parseArgs throws for what was typed (ERR_PARSE_ARGS_*): an unknown option, a missing value; anything else is a bug.
  const { values, positionals } = yield* Effect.try({
    try: () =>
      parseArgs({ args: rest, allowPositionals: true, strict: true, options: { help: { type: "boolean", short: "h" }, ...OPTIONS[cmd] } }),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause): Effect.Effect<never, UsageError> => {
      const code = (cause as { code?: unknown }).code;
      const typed = typeof code === "string" && code.startsWith("ERR_PARSE_ARGS");
      return typed ? Effect.fail(new UsageError({ message: (cause as Error).message })) : Effect.die(cause);
    }),
  );
  if (values.help) return (io.stdout.write(USAGE), 0);
  const [min, max] = arity;
  if (positionals.length < min) return yield* new UsageError({ message: `${cmd}: missing argument` });
  if (positionals.length > max) return yield* new UsageError({ message: `${cmd}: unexpected argument ${positionals[max]}` });
  return yield* run(ctxFor(io, positionals, values));
});

// The CLI's boundary (docs/effect.md): a usage error exits 2 with the hint, the desk down says so alone, and anything
// else, a bug too, is `desk: <its words>`, exit 1.
export async function main(argv: string[], io: IO = STDIO): Promise<number> {
  const [cmd = "help", ...rest] = argv;
  if (cmd === "help" || cmd === "--help" || cmd === "-h") return (io.stdout.write(USAGE), 0);
  const exit = await Effect.runPromiseExit(command(cmd, rest, io));
  if (Exit.isSuccess(exit)) return exit.value;
  const failed = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (failed?._tag === "UsageError") {
    io.stderr.write(`desk: ${failed.message}\nrun 'desk help' for usage\n`);
    return 2;
  }
  if (failed?._tag === "DeskDown") {
    io.stderr.write(`${failed.message}\n`);
    return 1;
  }
  const e = failed ?? Cause.squash(exit.cause);
  io.stderr.write(`desk: ${messageOf(e)}\n`);
  return 1;
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  // Exit once stdout has flushed; pipes are async on macOS.
  process.stdout.write("", () => process.exit(code));
}
