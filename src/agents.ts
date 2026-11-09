// The agent you work in (Settings → Claude): whether it has the desk's MCP tools and the Review Desk skill, and connecting it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Result } from "effect";
import { parse } from "smol-toml";
import { CommandFailed, CommandNotFound, CommandTimeout, fsError, type FsError, type UnsafeArgument } from "./errors.ts";
import { defaultHome } from "./home.ts";
import { claudeSpawn, runCommand } from "./review.ts";
import type { AgentStatus } from "./types.ts";

const SKILL = fileURLToPath(new URL("../skills/review-desk", import.meta.url));
export const SKILL_MD = path.join(SKILL, "SKILL.md");

interface Driver {
  bin: string;
  add: (url: string) => string[]; // registers the desk's MCP server for every project
  servers: (home: string) => unknown; // the agent's user-level MCP servers, by name
  skills: (home: string) => string;
}

const DRIVERS = {
  // ~/.claude.json's top-level mcpServers is Claude Code's user scope.
  "claude-code": {
    bin: "claude",
    add: (url) => ["mcp", "add", "--transport", "http", "--scope", "user", "review-desk", url],
    servers: (home) => (JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8")) as { mcpServers?: unknown }).mcpServers,
    skills: (home) => path.join(home, ".claude", "skills"),
  },
  // Codex reads user skills from ~/.agents/skills (developers.openai.com/codex/skills).
  codex: {
    bin: "codex",
    add: (url) => ["mcp", "add", "review-desk", "--url", url],
    servers: (home) => parse(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).mcp_servers,
    skills: (home) => path.join(home, ".agents", "skills"),
  },
} satisfies Record<string, Driver>;
export type DriverId = keyof typeof DRIVERS;

const sh = (s: string) => (/^[\w./:@=-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

// No config yet, or one that doesn't parse: not registered, and registering will say what's wrong.
function registered(d: Driver, home: string): boolean {
  const servers = Result.getOrNull(Result.try({ try: () => d.servers(home), catch: () => null }));
  return typeof servers === "object" && servers !== null && "review-desk" in servers;
}

// The skill the desk ships: not reading it is a broken install (a defect), never the owner's to fix.
const bundled = Effect.sync(() => fs.readdirSync(SKILL));
const bundledFile = (f: string) => Effect.sync(() => fs.readFileSync(path.join(SKILL, f)));

const readFile = (file: string) => Effect.try({ try: () => fs.readFileSync(file), catch: fsError("read", file) });

const skillState = Effect.fnUntraced(function* (dir: string): Effect.fn.Return<AgentStatus["skill"]["state"], FsError> {
  if (!fs.existsSync(path.join(dir, "SKILL.md"))) return "missing";
  for (const f of yield* bundled) {
    const mine = path.join(dir, f);
    if (!fs.existsSync(mine) || !(yield* readFile(mine)).equals(yield* bundledFile(f))) return "outdated";
  }
  return "installed";
});

// What an agent's state asks of you, and what Connect runs for it, as connect below does: only what's missing.
export function plan(mcp: AgentStatus["mcp"], skill: AgentStatus["skill"]): Pick<AgentStatus, "needs" | "connect"> {
  return {
    needs: !mcp.connected || skill.state === "missing" ? "connect" : skill.state === "outdated" ? "update" : null,
    connect: [...(mcp.connected ? [] : [mcp.command]), ...(skill.state === "installed" ? [] : [skill.command])],
  };
}

// HOME is read on every call, so tests can point it at a scratch directory.
export const status = Effect.fn("agents.status")(function* (driver: DriverId, url: string): Effect.fn.Return<AgentStatus, FsError> {
  const d = DRIVERS[driver];
  const home = os.homedir();
  const parent = d.skills(home);
  const dir = path.join(parent, "review-desk");
  const mcp = { connected: registered(d, home), command: [d.bin, ...d.add(url)].map(sh).join(" ") };
  const skill = {
    state: yield* skillState(dir),
    path: path.join(dir, "SKILL.md"),
    command: `mkdir -p ${sh(parent)} && cp -R ${sh(SKILL)} ${sh(parent)}/`,
  };
  return { driver, mcp, skill, ...plan(mcp, skill) };
});

type RunError = CommandNotFound | CommandFailed | CommandTimeout | UnsafeArgument;

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

// Connect's copy goes stale whenever the skill changes. Only on ~/.inbox: a scratch or test desk never writes to ~/.claude.
export const refreshSkills = Effect.fn("agents.refreshSkills")(function* (deskHome: string): Effect.fn.Return<string[], FsError> {
  const home = os.homedir();
  if (path.resolve(deskHome) !== defaultHome(home)) return [];
  const done: string[] = [];
  for (const d of Object.values(DRIVERS)) {
    const dir = path.join(d.skills(home), "review-desk");
    if ((yield* skillState(dir)) !== "outdated") continue; // missing: an agent you didn't connect
    yield* copySkill(dir);
    done.push(path.join(dir, "SKILL.md"));
  }
  return done;
});

// Installs or refreshes the skill, then registers the MCP server if it isn't yet.
export const connect = Effect.fn("agents.connect")(function* (
  driver: DriverId,
  url: string,
  timeout: number = TIMEOUT,
): Effect.fn.Return<AgentStatus, FsError | RunError> {
  const d = DRIVERS[driver];
  const s = yield* status(driver, url);
  if (s.skill.state !== "installed") yield* copySkill(path.dirname(s.skill.path));
  if (!s.mcp.connected) yield* run(d.bin, d.add(url), s.mcp.command, timeout);
  return yield* status(driver, url);
});
