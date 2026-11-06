// `desk`: a thin CLI over the local desk API.

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, watchFile } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import * as agents from "./agents.ts";
import * as api from "./client.ts";
import { DeskApiError, DeskDownError, untilText } from "./client.ts";
import { judgeText } from "./judge.ts";
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

  serve [--port N] [--open]           run the desk server in the foreground
  open                                open the UI in the browser
  status [--short]                    counts per board; --short prints the status-line text
  ls [board|focus] [--all] [--json]   list cards (default focus); --all adds later and fyi
  show <ref> [--json]                 one item: why, facts, rule trace
  add <ref> [why] [--from <task>]     put a PR or issue on your desk (fetched if new, pinned) and start its pre-review;
                                      why: the line it shows as why it's there
  done|mute|unmute|pin|unpin|restore <ref>
  snooze <ref> [until]                1h, 3h, tomorrow (default), monday, activity, ISO time, or ci|push|approved|ready|conflict
  undo [seq]                          undo the last action (or the one with that number)
  sync                                sync with GitHub now (read only)
  prompt <ref>                        print the review hand-off prompt
  brief <ref> [--force]               the PR's AI review: look/skim/skip, summary, concerns; cached per commit
  config [path|check|edit]            where the config lives, validate it, or edit it
  settings [--json]                   every setting by section; * = changed from the default
  settings set <key> <value>          change one; lists: a,b or a JSON array; booleans: true/false, yes/no, on/off
  settings reset <key>                back to the default
  fields                              the fields rules can use
  mcp                                 MCP server on stdio (the desk also serves MCP over HTTP at /mcp)
  connect [claude|codex] [--apply]    connect your agent (Settings → Agents) to the desk: MCP tools and skill; --apply does it
  install | uninstall                 run the server at login (macOS launchd)

<ref> is owner/repo#123, or repo#123 when unique.
`;

class UsageError extends Error {}

const GLYPH: Record<Bucket, string> = { now: "●", today: "◐", later: "○", fyi: "·", hide: "×" };
const PAST: Record<string, string> = {
  done: "done",
  mute: "muted",
  unmute: "unmuted",
  pin: "pinned",
  unpin: "unpinned",
  restore: "restored",
  snooze: "snoozed",
};

const OPTIONS: Record<string, ParseArgsConfig["options"]> = {
  serve: { port: { type: "string" }, open: { type: "boolean" } },
  status: { short: { type: "boolean" } },
  ls: { all: { type: "boolean" }, json: { type: "boolean" } },
  brief: { force: { type: "boolean" } },
  show: { json: { type: "boolean" } },
  settings: { json: { type: "boolean" } },
  connect: { apply: { type: "boolean" } },
  add: { from: { type: "string" } },
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
  fields: [0, 0],
  config: [0, 1],
  settings: [0, 3],
  mcp: [0, 0],
  connect: [0, 1],
  install: [0, 0],
  uninstall: [0, 0],
  add: [1, 2],
  done: [1, 1],
  mute: [1, 1],
  unmute: [1, 1],
  pin: [1, 1],
  unpin: [1, 1],
  restore: [1, 1],
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

const deskHome = () => (process.env.DESK_HOME ?? "") || join(homedir(), ".review-desk");
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

async function ls(x: Ctx): Promise<number> {
  const which = x.args[0] ?? "focus";
  // Focus is the queue's Now and Today; the queue has the rest for --all and the counts.
  const v =
    which === "focus"
      ? await api.queue()
      : await api.board(which).catch(async (e) => {
          if (!(e instanceof DeskApiError) || e.status !== 404) throw e;
          const ids = (await api.overview()).spaces.flatMap((s) => s.boards.map((b) => b.id));
          throw new Error(`${e.message} — boards: focus, ${ids.join(", ")}`);
        });
  if (x.opts.json) return (x.out(JSON.stringify(v, null, 2)), 0);
  const s = v.sections;
  const groups: [Bucket, Card[], string?][] = [
    ["now", s.now],
    ["today", s.today],
  ];
  if (x.opts.all) groups.push(["later", s.later], ["fyi", s.fyi]);
  if (groups.every(([, cs]) => !cs.length)) x.out(`Nothing in ${groups.map(([b]) => b.toUpperCase()).join(" or ")}.`);
  if (x.opts.all) groups.push(["hide", v.hidden, "HIDDEN BY RULES"], ["hide", v.cleared, "CLEARED (done, snoozed, muted)"]);
  printCards(x, groups);
  const counts: [number, string][] = x.opts.all
    ? []
    : [
        [s.later.length, "later"],
        [s.fyi.length, "fyi"],
        [v.cleared.length, "cleared"],
        [v.hidden.length, "hidden"],
        ["reviewing" in v ? v.reviewing : 0, "more once Claude has reviewed them"],
      ];
  const more = counts.filter(([n]) => n).map(([n, l]) => `${n} ${l}`);
  const hint = !x.opts.all && (s.later.length || s.fyi.length) ? `  (desk ls ${which === "focus" ? "" : `${which} `}--all)` : "";
  if (more.length) x.out("\n" + x.c.dim(clip(more.join(" · ") + hint, x.width)));
  return 0;
}

async function show(x: Ctx): Promise<number> {
  const d = await api.item(x.args[0]!);
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
  return 0;
}

const act =
  (action: Action) =>
  async (x: Ctx): Promise<number> => {
    const until = action === "snooze" ? (x.args[1] ?? "tomorrow") : undefined;
    const r = await api.act(x.args[0]!, action, until);
    const s = r.state;
    const when = untilText(until, s, localTime);
    x.out(`${x.c.green("✓")} ${PAST[action]} ${s.id}${when}  ${x.c.dim(`(desk undo ${r.undo_seq} to revert)`)}`);
    return 0;
  };

async function add(x: Ctx): Promise<number> {
  const r = await api.add(x.args[0]!, x.args[1], typeof x.opts.from === "string" ? x.opts.from : undefined);
  const d = r.item;
  const ai = d.generating ? ", AI review started" : "";
  x.out(`${x.c.green("✓")} added ${d.card.id} to your desk, pinned${ai}  ${x.c.dim(`(desk undo ${r.undo_seq} to revert)`)}`);
  return 0;
}

async function status(x: Ctx): Promise<number> {
  if (x.opts.short) {
    // Feeds a status line: never fail, never hang.
    try {
      const s = await api.status(1000);
      if (s.text) x.out(s.text);
    } catch (e) {
      // 503 = up but not serving: still starting, or the config never loaded.
      x.out(
        !(e instanceof DeskApiError && e.status === 503)
          ? "desk offline"
          : e.message.includes("config")
            ? "desk config error"
            : "desk starting",
      );
    }
    return 0;
  }
  const o = await api.overview();
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
      const counts = (["now", "today", "later", "fyi"] as const).map((k) => `${x.glyph(k)}${n[k]}`).join(" ");
      x.out(
        `  ${b.id.padEnd(idW)}  ${b.name.padEnd(nameW)}  ${counts}${b.new ? `  +${b.new} new` : ""}${b.error ? x.c.red(`  ${b.error}`) : ""}`,
      );
    }
  }
  return 0;
}

async function config(x: Ctx): Promise<number> {
  const sub = x.args[0] ?? "path";
  if (!["path", "check", "edit"].includes(sub)) throw new UsageError(`unknown config command: ${sub}`);
  // Works with the server down too: that's when you most need to fix the config.
  const up = await api.getConfig().catch((e) => {
    if (e instanceof DeskDownError) return null;
    throw e;
  });
  const path = up?.path ?? join(deskHome(), "config.toml");
  if (sub === "path") return (x.out(path), 0);
  if (sub === "edit") {
    const editor = (process.env.EDITOR ?? "") || (process.platform === "win32" ? "notepad" : "vi");
    // A shell splits EDITOR's flags ("code -w"). Windows paths can't contain quotes.
    const r =
      process.platform === "win32"
        ? spawnSync(`${editor} "${path}"`, { shell: true, stdio: "inherit" })
        : spawnSync("/bin/sh", ["-c", `${editor} "$1"`, "sh", path], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`editor exited with ${r.status ?? r.signal}`);
  }
  if (!up) {
    const { parseConfig } = await import("./config.ts");
    const { errors, warnings } = parseConfig(readFileSync(path, "utf8"));
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
  const text = readFileSync(path, "utf8");
  const { errors, warnings = [] } = sub === "edit" ? await api.putConfig(text) : await api.previewConfig(text);
  for (const e of errors) x.out(`${x.c.red("✗")} ${e.path}: ${e.message}`);
  for (const w of warnings) x.out(`${x.c.yellow("!")} ${w.path}: ${w.message}`);
  if (errors.length) {
    if (sub === "edit") x.out(x.c.dim("not applied; the server keeps the last valid config"));
    return 1;
  }
  x.out(`${x.c.green("✓")} ${path} ${sub === "edit" ? "saved; syncing" : "is valid"}`);
  return 0;
}

function showSetting(v: SettingValue | undefined): string {
  if (Array.isArray(v)) return v.length ? v.join(", ") : "(none)";
  if (v === "") return "(empty)";
  const lines = String(v).split("\n");
  return plain(lines[0] ?? "") + (lines.length > 1 ? ` … (+${lines.length - 1} lines)` : "");
}

// The server checks ranges and patterns; this only turns the argument into the setting's type.
function parseSetting(d: SettingDef, raw: string): SettingValue {
  if (d.type === "number") {
    if (!raw.trim() || Number.isNaN(Number(raw))) throw new Error(`${d.key} must be a number`);
    return Number(raw);
  }
  if (d.type === "boolean") {
    const v = raw.trim().toLowerCase();
    if (["true", "yes", "on"].includes(v)) return true;
    if (["false", "no", "off"].includes(v)) return false;
    throw new Error(`${d.key} must be true or false (yes/no, on/off)`);
  }
  if (d.type === "list") {
    if (!raw.trim().startsWith("["))
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    try {
      return JSON.parse(raw) as string[];
    } catch (e) {
      throw new Error(`${d.key}: bad JSON list (${(e as Error).message})`, { cause: e });
    }
  }
  return raw;
}

async function settings(x: Ctx): Promise<number> {
  const [sub, key, raw] = x.args;
  if (sub === "set" && x.args.length !== 3) throw new UsageError("settings set needs <key> <value>");
  if (sub === "reset" && x.args.length !== 2) throw new UsageError("settings reset needs <key>");
  if (sub !== undefined && sub !== "set" && sub !== "reset") throw new UsageError(`unknown settings command: ${sub}`);
  const v = await api.settings();
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
  if (!d) throw new Error(`unknown setting "${key}"; desk settings lists them`);
  const r = await api.putSettings(sub === "set" ? { set: { [d.key]: parseSetting(d, raw!) } } : { reset: [d.key] });
  if (!r.ok) throw new Error(r.errors.map((e) => `${e.path} ${e.message}`).join("; "));
  const isDefault = !r.settings.overridden.includes(d.key);
  x.out(`${x.c.green("✓")} ${d.key} = ${showSetting(r.settings.values[d.key])}${isDefault ? x.c.dim("  (default)") : ""}`);
  return 0;
}

const SKILL_STATE = { installed: "installed", outdated: "out of date", missing: "not installed" };

// The harness you work in, given the desk's tools: Claude Code unless you name Codex. Works with the desk down too: it
// reads the agent's own config files.
const HARNESSES: Record<string, { id: agents.DriverId; label: string }> = {
  claude: { id: "claude-code", label: "Claude Code" },
  codex: { id: "codex", label: "Codex" },
};

async function connect(x: Ctx): Promise<number> {
  const driver = HARNESSES[x.args[0] ?? "claude"];
  if (!driver) throw new UsageError(`unknown agent: ${x.args[0]} (try: desk connect claude, or codex)`);
  const url = `http://localhost:${(process.env.DESK_PORT ?? "") || 47823}/mcp`;
  const s = x.opts.apply ? await agents.connect(driver.id, url) : agents.status(driver.id, url);
  if (s.mcp.connected && s.skill.state === "installed") {
    x.out(`${x.c.green("✓")} ${driver.label}: MCP tools connected, skill installed (${s.skill.path})`);
    return 0;
  }
  x.out(`# ${driver.label}${x.opts.apply ? "" : ` (desk connect ${x.args[0] ? `${x.args[0]} ` : ""}--apply does this)`}`);
  x.out(`# MCP tools: ${s.mcp.connected ? "connected" : "not connected"}`);
  if (!s.mcp.connected) x.out(s.mcp.command);
  x.out(`# Skill: ${SKILL_STATE[s.skill.state]}`);
  if (s.skill.state !== "installed") x.out(s.skill.command);
  x.out(`# The tools work while the desk runs (the app or desk serve). Clients that only speak stdio: desk mcp`);
  return 0;
}

// launchd is macOS-only; elsewhere the desktop app's login item does the job.
function macOnly(cmd: string): void {
  if (process.platform !== "darwin")
    throw new Error(`${cmd} is macOS-only. On Linux and Windows, use Settings → Desktop app → Open at login in the desktop app`);
}

async function serve(x: Ctx): Promise<number> {
  const raw = typeof x.opts.port === "string" ? x.opts.port : (process.env.DESK_PORT ?? "") || 47823;
  const port = Number(raw);
  // Port 0 would pick a random port no client can find.
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError(`bad port: ${raw}`);
  // Before the server's modules load, so Sentry instruments them.
  await startSentry();
  const { startServer } = await import("./server.ts");
  const srv = await startServer({ port, open: !!x.opts.open });
  const refresh = () => {
    try {
      for (const f of agents.refreshSkills(srv.desk.home)) srv.desk.log(`refreshed the Review Desk skill at ${f}`);
    } catch (e) {
      srv.desk.log(`couldn't refresh the Review Desk skill: ${(e as Error).message}`);
    }
  };
  refresh();
  // The checkout's desk restarts on src/ changes only, so a skill-only merge would wait for an unrelated one.
  watchFile(agents.SKILL_MD, { interval: 5000, persistent: false }, refresh);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await srv.close();
  await stopSentry();
  return 0;
}

const cliPath = () => realpathSync(import.meta.filename);

const COMMANDS: Record<string, (x: Ctx) => Promise<number>> = {
  serve,
  status,
  ls,
  show,
  config,
  settings,
  connect,
  add,
  done: act("done"),
  mute: act("mute"),
  unmute: act("unmute"),
  pin: act("pin"),
  unpin: act("unpin"),
  restore: act("restore"),
  snooze: act("snooze"),
  open: async () => {
    await api.health();
    spawnSync(...openCommand(api.baseUrl() + "/"));
    return 0;
  },
  undo: async (x) => {
    const seq = x.args[0] === undefined ? undefined : Number(x.args[0]);
    if (seq !== undefined && !Number.isInteger(seq)) throw new UsageError(`bad undo number: ${x.args[0]}`);
    const r = await api.undo(seq);
    x.out(`${x.c.green("✓")} Undid ${r.action} on ${r.id.split("/")[1]}`);
    return 0;
  },
  sync: async (x) => {
    await api.sync();
    x.out("sync started");
    return 0;
  },
  // The prompt template can interpolate the title; keep newlines and tabs, drop other control chars.
  prompt: async (x) => {
    x.out((await api.item(x.args[0]!)).handoff_prompt.replaceAll(/(?![\t\n])\p{Cc}/gu, ""));
    return 0;
  },
  fields: async (x) => {
    const fs = await api.fields();
    const w = Math.max(...fs.map((f) => f.path.length));
    for (const f of fs) x.out(`${f.path.padEnd(w)}  ${x.c.dim(f.type.padEnd(8))}  ${f.doc}`);
    return 0;
  },
  brief: async (x) => {
    const b = (await api.aiReview(x.args[0]!, !!x.opts.force)).ai;
    const clean = (t: string) => t.replaceAll(/\p{Cc}/gu, " ");
    const color = b.verdict === "look" ? x.c.red : b.verdict === "skim" ? x.c.yellow : x.c.dim;
    x.out(`${color(b.verdict.toUpperCase())} · risk ${b.risk} · ${b.model}`);
    x.out(clean(b.summary));
    for (const r of b.concerns) x.out(`  - ${clean(r)}`);
    if (b.notes.length) x.out(x.c.dim(`${b.notes.length} notes on the code: open the PR in the desk to read them`));
    return 0;
  },
  mcp: async () => {
    const { runMcp } = await import("./mcp.ts");
    await runMcp();
    await new Promise((r) => {
      process.stdin.once("end", r);
    });
    return 0;
  },
  install: async (x) => {
    macOnly("install");
    const file = await install(cliPath());
    x.out(`${x.c.green("✓")} installed ${file}\n  desk serve now runs at login; log: ~/.review-desk/desk.log`);
    return 0;
  },
  uninstall: (x) => {
    macOnly("uninstall");
    x.out(`${x.c.green("✓")} removed ${uninstall()}`);
    return Promise.resolve(0);
  },
};

const STDIO: IO = { stdout: process.stdout, stderr: process.stderr };

export async function main(argv: string[], io: IO = STDIO): Promise<number> {
  const [cmd = "help", ...rest] = argv;
  if (cmd === "help" || cmd === "--help" || cmd === "-h") return (io.stdout.write(USAGE), 0);
  try {
    const run = COMMANDS[cmd];
    const arity = ARITY[cmd];
    if (!run || !arity) throw new UsageError(`unknown command: ${cmd}`);
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: { help: { type: "boolean", short: "h" }, ...OPTIONS[cmd] },
    });
    if (values.help) return (io.stdout.write(USAGE), 0);
    const [min, max] = arity;
    if (positionals.length < min) throw new UsageError(`${cmd}: missing argument`);
    if (positionals.length > max) throw new UsageError(`${cmd}: unexpected argument ${positionals[max]}`);
    return await run(ctxFor(io, positionals, values));
  } catch (e) {
    const err = e as Error & { code?: string };
    if (e instanceof UsageError || err.code?.startsWith("ERR_PARSE_ARGS")) {
      io.stderr.write(`desk: ${err.message}\nrun 'desk help' for usage\n`);
      return 2;
    }
    io.stderr.write(e instanceof DeskDownError ? `${err.message}\n` : `desk: ${err.message}\n`);
    return 1;
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  // Exit once stdout has flushed; pipes are async on macOS.
  process.stdout.write("", () => process.exit(code));
}
