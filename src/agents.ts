// The agent you work in (Settings → Agent): whether it has the desk's MCP tools and the Inbox skill, and connecting it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Result } from "effect";
import { parse } from "smol-toml";
import { CommandFailed, CommandNotFound, CommandTimeout, Conflict, fsError, type FsError, type UnsafeArgument } from "./errors.ts";
import { ownersHome } from "./home.ts";
import { claudeSpawn, runCommand } from "./review.ts";
import type { AgentStatus } from "./types.ts";

const SKILL = fileURLToPath(new URL("../skills/inbox", import.meta.url));
export const SKILL_MD = path.join(SKILL, "SKILL.md");
const NAME = "inbox"; // the MCP server's name, and the skill's folder
export const TOKEN_VAR = "INBOX_TOKEN"; // where Codex and OpenCode read a desk's token on another machine
const OLD = "review-desk"; // both, before the rename to Inbox

interface Driver {
  bin: string;
  add: (url: string) => string[]; // registers the desk's MCP server for every project
  addRemote: (url: string, token: string) => string[]; // and a desk on another machine, with this machine's token
  remove?: (name: string) => string[]; // and unregisters one; OpenCode has no command for it, and its add replaces
  servers: (home: string) => unknown; // the agent's user-level MCP servers, by name
  skills: (home: string) => string;
}

const DRIVERS = {
  // ~/.claude.json's top-level mcpServers is Claude Code's user scope.
  "claude-code": {
    bin: "claude",
    add: (url) => ["mcp", "add", "--transport", "http", "--scope", "user", NAME, url],
    addRemote: (url, token) => [
      "mcp",
      "add",
      "--transport",
      "http",
      "--scope",
      "user",
      NAME,
      url,
      "--header",
      `Authorization: Bearer ${token}`,
    ],
    remove: (name) => ["mcp", "remove", "--scope", "user", name],
    servers: (home) => (JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8")) as { mcpServers?: unknown }).mcpServers,
    skills: (home) => path.join(home, ".claude", "skills"),
  },
  // Codex reads user skills from ~/.agents/skills (developers.openai.com/codex/skills).
  codex: {
    bin: "codex",
    add: (url) => ["mcp", "add", NAME, "--url", url],
    // Codex keeps no literal bearer token from its CLI, only the variable it reads one from.
    addRemote: (url) => ["mcp", "add", NAME, "--url", url, "--bearer-token-env-var", TOKEN_VAR],
    remove: (name) => ["mcp", "remove", name],
    servers: (home) => parse(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).mcp_servers,
    skills: (home) => path.join(home, ".agents", "skills"),
  },
  // OpenCode's global config and skills (opencode.ai/docs/skills); its add writes the remote server there, replacing one of that name.
  opencode: {
    bin: "opencode",
    add: (url) => ["mcp", "add", NAME, "--url", url],
    addRemote: (url) => ["mcp", "add", NAME, "--url", url, "--header", `Authorization=Bearer {env:${TOKEN_VAR}}`],
    servers: (home) =>
      (JSON.parse(fs.readFileSync(path.join(home, ".config", "opencode", "opencode.json"), "utf8")) as { mcp?: unknown }).mcp,
    skills: (home) => path.join(home, ".config", "opencode", "skills"),
  },
} satisfies Record<string, Driver>;
export type DriverId = keyof typeof DRIVERS;
// agent.harness as a driver: a value this desk doesn't know is Claude Code's.
export const driverOf = (id: string): DriverId => (Object.hasOwn(DRIVERS, id) ? (id as DriverId) : "claude-code");

const sh = (s: string) => (/^[\w./:@=-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);
const commandOf = (d: Driver, args: string[]) => [d.bin, ...args].map(sh).join(" ");

const urlOf = (u: unknown) => Result.getOrNull(Result.try({ try: () => new URL(String(u)), catch: () => null }));
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const CLI = fileURLToPath(new URL("cli.ts", import.meta.url));

// The desk's own entry: its /mcp on its port, or `desk mcp` over stdio (bin/desk, bin/desk.cmd, or node on this desk's
// src/cli.ts) at its port, which `desk mcp` takes from DESK_PORT as the desk does. Another server of the owner's may be
// named inbox, and a helpdesk's `mcp` isn't the desk's.
function desks(entry: unknown, url: string): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as {
    url?: unknown;
    command?: unknown;
    args?: unknown;
    env?: { DESK_PORT?: unknown };
    environment?: { DESK_PORT?: unknown };
  };
  const desk = urlOf(url);
  // OpenCode's command is the whole argv, its variables `environment`.
  if (typeof e.command === "string" || Array.isArray(e.command)) {
    const argv = (
      Array.isArray(e.command) ? (e.command as unknown[]) : [e.command, ...(Array.isArray(e.args) ? (e.args as unknown[]) : [])]
    ).map(String);
    const prog = argv.at(-2) ?? "";
    const vars = e.env ?? e.environment;
    const own = typeof vars?.DESK_PORT === "string" ? vars.DESK_PORT : "";
    const port = own || (process.env.DESK_PORT ?? "") || "47823";
    return argv.at(-1) === "mcp" && (/^desk(\.cmd)?$/i.test(prog.split(/[\\/]/).at(-1) ?? "") || prog === CLI) && port === desk?.port;
  }
  const at = urlOf(e.url);
  return !!at && !!desk && LOOPBACK.has(at.hostname) && at.port === desk.port && at.pathname === desk.pathname;
}

// No config yet, or one that doesn't parse: none, and registering will say what's wrong.
function listed(d: Driver, home: string): Record<string, unknown> {
  const servers = Result.getOrNull(Result.try({ try: () => d.servers(home), catch: () => null }));
  return typeof servers === "object" && servers !== null ? (servers as Record<string, unknown>) : {};
}

function server(d: Driver, home: string, name: string, url: string): "none" | "desk" | "other" {
  const servers = listed(d, home);
  if (!(name in servers)) return "none";
  return desks(servers[name], url) ? "desk" : "other";
}

// Where another server points or what it runs, so a desk's on another port reads as that.
function shown(entry: unknown): string {
  const { url, command, args } = (typeof entry === "object" ? (entry ?? {}) : {}) as { url?: unknown; command?: unknown; args?: unknown };
  if (typeof url === "string") return ` (${url})`;
  if (Array.isArray(command)) return ` (${(command as unknown[]).map(String).join(" ")})`; // OpenCode's whole argv
  return typeof command === "string" ? ` (${[command, ...(Array.isArray(args) ? (args as unknown[]) : [])].map(String).join(" ")})` : "";
}

// The skill the desk ships: not reading it is a broken install (a defect), never the owner's to fix.
const bundled = Effect.sync(() => fs.readdirSync(SKILL));
const bundledFile = (f: string) => Effect.sync(() => fs.readFileSync(path.join(SKILL, f)));

const readFile = (file: string) => Effect.try({ try: () => fs.readFileSync(file), catch: fsError("read", file) });

// The desk's skill names itself and its tools, as every version has (a zendesk_search isn't one); a skill of the owner's
// may have the same name.
const desksSkill = (text: string, name: string) =>
  new RegExp(String.raw`^---\r?\nname: ${name}\r?\n`).test(text) && /\bdesk_list\b/.test(text) && /\bdesk_item\b/.test(text);

const skillState = Effect.fnUntraced(function* (dir: string): Effect.fn.Return<AgentStatus["skill"]["state"], FsError> {
  const file = path.join(dir, "SKILL.md");
  if (!fs.existsSync(file)) return "missing";
  if (!desksSkill((yield* readFile(file)).toString("utf8"), NAME)) return "taken";
  for (const f of yield* bundled) {
    const mine = path.join(dir, f);
    if (!fs.existsSync(mine) || !(yield* readFile(mine)).equals(yield* bundledFile(f))) return "outdated";
  }
  return "installed";
});

// What an agent's state asks of you, and what Connect runs for it, as connect below does: only what's missing. A name
// another skill or server holds is yours to move: Settings says so before you press, and Connect runs nothing.
export function plan(mcp: AgentStatus["mcp"], skill: AgentStatus["skill"], taken: string | null): Pick<AgentStatus, "needs" | "connect"> {
  if (taken) return { needs: "taken", connect: [] };
  const copies = skill.state === "missing" || skill.state === "outdated";
  return {
    needs: !mcp.connected || skill.state === "missing" ? "connect" : copies ? "update" : null,
    connect: [...(mcp.connected ? [] : [mcp.command]), ...(copies ? [skill.command] : [])],
  };
}

// HOME is read on every call, so tests can point it at a scratch directory.
export const status = Effect.fn("agents.status")(function* (driver: DriverId, url: string): Effect.fn.Return<AgentStatus, FsError> {
  const d = DRIVERS[driver];
  const home = os.homedir();
  const parent = d.skills(home);
  const dir = path.join(parent, NAME);
  // Under its name from before the rename too, until the refresh or Connect renames it: its tools work either way.
  const connected = server(d, home, NAME, url) === "desk" || server(d, home, OLD, url) === "desk";
  const mcp = { connected, command: commandOf(d, d.add(url)) };
  const skill = {
    state: yield* skillState(dir),
    path: path.join(dir, "SKILL.md"),
    command: `mkdir -p ${sh(parent)} && cp -R ${sh(SKILL)} ${sh(parent)}/`,
  };
  const held = [
    ...(skill.state === "taken" ? [`${skill.path} is another skill named ${NAME}, not the desk's: move it`] : []),
    ...(!connected && server(d, home, NAME, url) === "other"
      ? [`${d.bin} has another MCP server named ${NAME}${shown(listed(d, home)[NAME])}, not this desk at ${url}: rename or remove it`]
      : []),
  ];
  const taken = held.length ? `${held.join("; ")}, then connect again` : null;
  return { driver, mcp, skill, taken, ...plan(mcp, skill, taken) };
});

type RunError = CommandNotFound | CommandFailed | CommandTimeout | UnsafeArgument | Conflict;

const TIMEOUT = 60_000;

// Every failure ends with what to run yourself instead: `command`, the same registration.
const run = (bin: string, args: string[], command: string, timeout: number): Effect.Effect<void, RunError> =>
  Effect.flatMap(claudeSpawn(bin, args), (s) => {
    const summary = (why: string) =>
      `${bin} failed: ${(why || `Command failed: ${command}`).trim().split("\n").slice(-2).join(" ")}. Run it yourself: ${command}`;
    return runCommand(s, { timeout, missing: `${bin} isn't on PATH. Run it yourself: ${command}` }).pipe(
      Effect.asVoid,
      Effect.catchTags({
        CommandFailed: (e) =>
          Effect.fail(
            new CommandFailed({
              command: bin,
              code: e.code,
              signal: e.signal,
              stderr: e.stderr,
              ...(e.cause !== undefined && { cause: e.cause }),
              summary: summary(e.stderr || (e.cause instanceof Error ? e.cause.message : "")),
            }),
          ),
        CommandTimeout: () => Effect.fail(new CommandTimeout({ command: bin, timeoutMs: timeout, summary: summary("") })),
        CommandOutputTooLarge: (e) =>
          Effect.fail(new CommandFailed({ command: bin, code: null, signal: null, stderr: "", cause: e, summary: summary(e.message) })),
      }),
    );
  });

const copySkill = Effect.fnUntraced(function* (dir: string): Effect.fn.Return<void, FsError> {
  yield* Effect.try({
    try: () => {
      fs.mkdirSync(dir, { recursive: true });
    },
    catch: fsError("mkdir", dir),
  });
  for (const f of yield* bundled) {
    const content = yield* bundledFile(f);
    const to = path.join(dir, f);
    yield* Effect.try({
      try: () => {
        fs.writeFileSync(to, content);
      },
      catch: fsError("write", to),
    });
  }
});

// The copy Connect made before the rename: the skill's own files alone, named review-desk. Anything else there is the owner's.
const oldCopy = Effect.fnUntraced(function* (parent: string): Effect.fn.Return<string | null> {
  const dir = path.join(parent, OLD);
  const files = Result.getOrNull(Result.try({ try: () => fs.readdirSync(dir), catch: () => null }));
  const shipped = yield* bundled;
  // What Finder, Explorer or an editor leaves beside the desk's files doesn't make the folder the owner's.
  const junk = (f: string) => f.startsWith(".") || f.endsWith("~") || f === "Thumbs.db" || f === "desktop.ini";
  if (!files?.includes("SKILL.md") || files.some((f) => !junk(f) && !shipped.includes(f))) return null;
  const text = Result.getOrElse(Result.try({ try: () => fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"), catch: () => "" }), () => "");
  return desksSkill(text, OLD) ? dir : null;
});

// What the desk installed before the rename, under the new names: the skill's copy in <skills>/inbox and the MCP server as
// inbox at `url`, the old ones gone. Each thing it did is said as it's done; nothing for an agent it never connected.
const migrate = Effect.fnUntraced(function* (
  d: Driver,
  url: string,
  timeout: number,
  said: (line: string) => void,
): Effect.fn.Return<void, FsError | RunError> {
  const home = os.homedir();
  const parent = d.skills(home);
  const old = yield* oldCopy(parent);
  if (old) {
    const dir = path.join(parent, NAME);
    const state = yield* skillState(dir);
    if (state === "taken") said(`kept the Inbox skill in ${old}: ${dir} is another skill named ${NAME}`);
    else {
      if (state !== "installed") yield* copySkill(dir);
      yield* Effect.try({
        try: () => {
          fs.rmSync(old, { recursive: true, force: true });
        },
        catch: fsError("remove", old),
      });
      said(`moved the Inbox skill from ${old} to ${dir}`);
    }
  }
  // Only this desk's own: another tool's review-desk stays, and one at another desk's port is that desk's to rename (a
  // scratch desk on the owner's home would point inbox at itself). The new name may be another server's, and then the old one stays.
  if (server(d, home, OLD, url) !== "desk") return;
  const now = server(d, home, NAME, url);
  if (now === "other") {
    said(`kept ${d.bin}'s MCP server ${OLD}: ${NAME} is another server's name there`);
    return;
  }
  if (now === "none") yield* run(d.bin, d.add(url), commandOf(d, d.add(url)), timeout);
  if (!d.remove) return;
  yield* run(d.bin, d.remove(OLD), commandOf(d, d.remove(OLD)), timeout);
  said(`renamed ${d.bin}'s MCP server ${OLD} to ${NAME}`);
});

// Connect's copy goes stale whenever the skill changes, and what Connect did before the rename is renamed. Only on the
// owner's own desk, whatever its home is called yet: a scratch or test desk never writes to ~/.claude. What it did, in
// words, and what one agent's CLI or files failed, which never holds up the other agent.
export const refreshSkills = Effect.fn("agents.refreshSkills")(function* (deskHome: string, url: string): Effect.fn.Return<string[]> {
  const home = os.homedir();
  if (!ownersHome(deskHome, home)) return [];
  const done: string[] = [];
  const said = (line: string) => {
    done.push(line);
  };
  for (const d of Object.values(DRIVERS)) {
    const dir = path.join(d.skills(home), NAME);
    const one = Effect.gen(function* () {
      yield* migrate(d, url, TIMEOUT, said);
      if ((yield* skillState(dir)) !== "outdated") return; // missing: an agent you didn't connect; taken: another skill
      yield* copySkill(dir);
      said(`refreshed the Inbox skill at ${path.join(dir, "SKILL.md")}`);
    });
    yield* one.pipe(
      Effect.catch((e) =>
        Effect.sync(() => {
          said(`couldn't bring ${d.bin}'s Inbox skill and MCP server up to date: ${e.message}`);
        }),
      ),
    );
  }
  return done;
});

// What to paste on another machine to give its agents a desk at `at` (https://<tailnet name>) with `token`: desk pair --print.
export function remoteCommands(at: string, token: string): string[] {
  const skill = (dir: string) =>
    `mkdir -p ${dir}/${NAME} && curl -fsS -H ${sh(`Authorization: Bearer ${token}`)} ${at}/skill -o ${dir}/${NAME}/SKILL.md`;
  return [
    "# Claude Code",
    commandOf(DRIVERS["claude-code"], DRIVERS["claude-code"].addRemote(`${at}/mcp`, token)),
    skill("~/.claude/skills"),
    `# Codex, which reads the token from ${TOKEN_VAR}: put the export in your shell's profile`,
    commandOf(DRIVERS.codex, DRIVERS.codex.addRemote(`${at}/mcp`)),
    skill("~/.agents/skills"),
    `# OpenCode, which reads it from ${TOKEN_VAR} too`,
    commandOf(DRIVERS.opencode, DRIVERS.opencode.addRemote(`${at}/mcp`)),
    skill("~/.config/opencode/skills"),
    `export ${TOKEN_VAR}=${token}`,
  ];
}

// This machine's agent given a desk on another machine: its skill as that desk serves it, and its MCP server at `url` with
// `token`, replacing one already there for the same address (a device paired again). Another server or skill named inbox
// is yours to move first.
export const connectRemote = Effect.fn("agents.connectRemote")(function* (
  driver: DriverId,
  url: string,
  token: string,
  skill: string,
  { timeout = TIMEOUT }: { timeout?: number } = {},
): Effect.fn.Return<void, FsError | RunError> {
  const d: Driver = DRIVERS[driver];
  const home = os.homedir();
  const dir = path.join(d.skills(home), NAME);
  if ((yield* skillState(dir)) === "taken")
    return yield* new Conflict({
      message: `${path.join(dir, "SKILL.md")} is another skill named ${NAME}, not the desk's: move it, then connect again`,
    });
  const entry = listed(d, home)[NAME];
  const same = urlOf((entry as { url?: unknown } | undefined)?.url)?.href === urlOf(url)?.href;
  if (entry !== undefined && !same)
    return yield* new Conflict({
      message: `${d.bin} has another MCP server named ${NAME}${shown(entry)}: remove it${d.remove ? ` (${commandOf(d, d.remove(NAME))})` : ""}, then connect again`,
    });
  yield* Effect.try({
    try: () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), skill);
    },
    catch: fsError("write", path.join(dir, "SKILL.md")),
  });
  if (same && d.remove) yield* run(d.bin, d.remove(NAME), commandOf(d, d.remove(NAME)), timeout);
  return yield* run(d.bin, d.addRemote(url, token), commandOf(d, d.addRemote(url, "<token>")), timeout);
});

// Installs or refreshes the skill, registers the MCP server if it isn't yet, then lets go of the names from before the
// rename, saying each in `log`.
export const connect = Effect.fn("agents.connect")(function* (
  driver: DriverId,
  url: string,
  { timeout = TIMEOUT, log = () => {} }: { timeout?: number; log?: (line: string) => void } = {},
): Effect.fn.Return<AgentStatus, FsError | RunError> {
  const d: Driver = DRIVERS[driver];
  const s = yield* status(driver, url);
  if (s.taken) return yield* new Conflict({ message: s.taken });
  if (s.skill.state !== "installed") yield* copySkill(path.dirname(s.skill.path));
  if (!s.mcp.connected) yield* run(d.bin, d.add(url), s.mcp.command, timeout);
  yield* migrate(d, url, timeout, log);
  return yield* status(driver, url);
});
