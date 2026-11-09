// The agent you work in (Settings → Claude): whether it has the desk's MCP tools and the Inbox skill, and connecting it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Result } from "effect";
import { parse } from "smol-toml";
import { CommandFailed, CommandNotFound, CommandTimeout, Conflict, fsError, type FsError, type UnsafeArgument } from "./errors.ts";
import { defaultHome } from "./home.ts";
import { claudeSpawn, runCommand } from "./review.ts";
import type { AgentStatus } from "./types.ts";

const SKILL = fileURLToPath(new URL("../skills/inbox", import.meta.url));
export const SKILL_MD = path.join(SKILL, "SKILL.md");
const NAME = "inbox"; // the MCP server's name, and the skill's folder
const OLD = "review-desk"; // both, before the rename to Inbox

interface Driver {
  bin: string;
  add: (url: string) => string[]; // registers the desk's MCP server for every project
  remove: (name: string) => string[]; // and unregisters one
  servers: (home: string) => unknown; // the agent's user-level MCP servers, by name
  skills: (home: string) => string;
}

const DRIVERS = {
  // ~/.claude.json's top-level mcpServers is Claude Code's user scope.
  "claude-code": {
    bin: "claude",
    add: (url) => ["mcp", "add", "--transport", "http", "--scope", "user", NAME, url],
    remove: (name) => ["mcp", "remove", "--scope", "user", name],
    servers: (home) => (JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8")) as { mcpServers?: unknown }).mcpServers,
    skills: (home) => path.join(home, ".claude", "skills"),
  },
  // Codex reads user skills from ~/.agents/skills (developers.openai.com/codex/skills).
  codex: {
    bin: "codex",
    add: (url) => ["mcp", "add", NAME, "--url", url],
    remove: (name) => ["mcp", "remove", name],
    servers: (home) => parse(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).mcp_servers,
    skills: (home) => path.join(home, ".agents", "skills"),
  },
} satisfies Record<string, Driver>;
export type DriverId = keyof typeof DRIVERS;

const sh = (s: string) => (/^[\w./:@=-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);
const commandOf = (d: Driver, args: string[]) => [d.bin, ...args].map(sh).join(" ");

const urlOf = (u: unknown) => Result.getOrNull(Result.try({ try: () => new URL(String(u)), catch: () => null }));
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// The desk's own entry: its /mcp on its port, or `desk mcp` over stdio. Another server of the owner's may be named inbox.
function desks(entry: unknown, url: string): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as { url?: unknown; command?: unknown; args?: unknown };
  if (typeof e.command === "string")
    return [e.command, ...(Array.isArray(e.args) ? (e.args as unknown[]) : [])].join(" ").endsWith("desk mcp");
  const at = urlOf(e.url);
  const desk = urlOf(url);
  return !!at && !!desk && LOOPBACK.has(at.hostname) && at.port === desk.port && at.pathname === desk.pathname;
}

// No config yet, or one that doesn't parse: none, and registering will say what's wrong.
function server(d: Driver, home: string, name: string, url: string): "none" | "desk" | "other" {
  const servers = Result.getOrNull(Result.try({ try: () => d.servers(home), catch: () => null }));
  if (typeof servers !== "object" || servers === null || !(name in servers)) return "none";
  return desks((servers as Record<string, unknown>)[name], url) ? "desk" : "other";
}

// The skill the desk ships: not reading it is a broken install (a defect), never the owner's to fix.
const bundled = Effect.sync(() => fs.readdirSync(SKILL));
const bundledFile = (f: string) => Effect.sync(() => fs.readFileSync(path.join(SKILL, f)));

const readFile = (file: string) => Effect.try({ try: () => fs.readFileSync(file), catch: fsError("read", file) });

// The desk's skill names itself and its tools; a skill of the owner's may have the same name.
const desksSkill = (text: string, name: string) => new RegExp(String.raw`^---\r?\nname: ${name}\r?\n`).test(text) && text.includes("desk_");

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

// What an agent's state asks of you, and what Connect runs for it, as connect below does: only what's missing. A folder
// another skill holds is yours to move: Connect says so and copies nothing over it.
export function plan(mcp: AgentStatus["mcp"], skill: AgentStatus["skill"]): Pick<AgentStatus, "needs" | "connect"> {
  const copies = skill.state === "missing" || skill.state === "outdated";
  return {
    needs: !mcp.connected || skill.state === "missing" || skill.state === "taken" ? "connect" : copies ? "update" : null,
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
  return { driver, mcp, skill, ...plan(mcp, skill) };
});

type RunError = CommandNotFound | CommandFailed | CommandTimeout | UnsafeArgument | Conflict;

const TIMEOUT = 60_000;

// Every failure ends with what to run yourself instead: `command`, the same registration.
const run = (bin: string, args: string[], command: string, timeout: number): Effect.Effect<void, RunError> =>
  Effect.flatMap(claudeSpawn(bin, args), (s) => {
    const summary = (why: string) =>
      `${bin} failed: ${(why || `Command failed: ${[bin, ...args].join(" ")}`).trim().split("\n").slice(-2).join(" ")}. Run it yourself: ${command}`;
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
  if (!files?.includes("SKILL.md") || files.some((f) => !shipped.includes(f))) return null;
  const text = Result.getOrElse(Result.try({ try: () => fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"), catch: () => "" }), () => "");
  return desksSkill(text, OLD) ? dir : null;
});

// What the desk installed before the rename, under the new names: the skill's copy in <skills>/inbox and the MCP server as
// inbox at `url`, the old ones gone. What it did, in words; nothing for an agent it never connected.
const migrate = Effect.fnUntraced(function* (d: Driver, url: string, timeout: number): Effect.fn.Return<string[], FsError | RunError> {
  const home = os.homedir();
  const parent = d.skills(home);
  const done: string[] = [];
  const old = yield* oldCopy(parent);
  if (old) {
    const dir = path.join(parent, NAME);
    const state = yield* skillState(dir);
    if (state === "taken") done.push(`kept the Inbox skill in ${old}: ${dir} is another skill named ${NAME}`);
    else {
      if (state !== "installed") yield* copySkill(dir);
      yield* Effect.try({
        try: () => {
          fs.rmSync(old, { recursive: true, force: true });
        },
        catch: fsError("remove", old),
      });
      done.push(`moved the Inbox skill from ${old} to ${dir}`);
    }
  }
  // The old name was only ever the desk's; the new one may be another server's, and then the old one stays.
  if (server(d, home, OLD, url) === "none") return done;
  const now = server(d, home, NAME, url);
  if (now === "other") {
    done.push(`kept ${d.bin}'s MCP server ${OLD}: ${NAME} is another server's name there`);
    return done;
  }
  if (now === "none") yield* run(d.bin, d.add(url), commandOf(d, d.add(url)), timeout);
  yield* run(d.bin, d.remove(OLD), commandOf(d, d.remove(OLD)), timeout);
  done.push(`renamed ${d.bin}'s MCP server ${OLD} to ${NAME}`);
  return done;
});

// Connect's copy goes stale whenever the skill changes, and what Connect did before the rename is renamed. Only on
// ~/.inbox: a scratch or test desk never writes to ~/.claude. What it did, in words.
export const refreshSkills = Effect.fn("agents.refreshSkills")(function* (
  deskHome: string,
  url: string,
): Effect.fn.Return<string[], FsError | RunError> {
  const home = os.homedir();
  if (path.resolve(deskHome) !== defaultHome(home)) return [];
  const done: string[] = [];
  for (const d of Object.values(DRIVERS)) {
    done.push(...(yield* migrate(d, url, TIMEOUT)));
    const dir = path.join(d.skills(home), NAME);
    if ((yield* skillState(dir)) !== "outdated") continue; // missing: an agent you didn't connect; taken: another skill
    yield* copySkill(dir);
    done.push(`refreshed the Inbox skill at ${path.join(dir, "SKILL.md")}`);
  }
  return done;
});

// Installs or refreshes the skill, registers the MCP server if it isn't yet, then lets go of the names from before the rename.
export const connect = Effect.fn("agents.connect")(function* (
  driver: DriverId,
  url: string,
  timeout: number = TIMEOUT,
): Effect.fn.Return<AgentStatus, FsError | RunError> {
  const d = DRIVERS[driver];
  const s = yield* status(driver, url);
  if (s.skill.state === "taken")
    return yield* new Conflict({ message: `${s.skill.path} is another skill named ${NAME}, not the desk's: move it, then connect again` });
  if (!s.mcp.connected && server(d, os.homedir(), NAME, url) === "other")
    return yield* new Conflict({
      message: `${d.bin} has another MCP server named ${NAME}, not the desk's: rename or remove it, then connect again`,
    });
  if (s.skill.state !== "installed") yield* copySkill(path.dirname(s.skill.path));
  if (!s.mcp.connected) yield* run(d.bin, d.add(url), s.mcp.command, timeout);
  yield* migrate(d, url, timeout);
  return yield* status(driver, url);
});
