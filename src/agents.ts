// The agent you work in (Settings → Agents): whether it has the desk's MCP tools and the Review Desk skill, and connecting it.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { claudeSpawn } from "./analyze.ts";
import type { AgentStatus } from "./types.ts";

const SKILL = fileURLToPath(new URL("../skills/review-desk", import.meta.url));

interface Driver {
  bin: string;
  add: (url: string) => string[]; // registers the desk's MCP server for every project
  servers: (home: string) => unknown; // the agent's user-level MCP servers, by name
  skills: (home: string) => string;
}

const DRIVERS: Record<string, Driver> = {
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
};

const sh = (s: string) => (/^[\w./:@=-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

function registered(d: Driver, home: string): boolean {
  try {
    const servers = d.servers(home);
    return typeof servers === "object" && servers !== null && "review-desk" in servers;
  } catch {
    return false; // no config yet, or one we can't parse: registering will say what's wrong
  }
}

function skillState(dir: string): "installed" | "outdated" | "missing" {
  if (!fs.existsSync(path.join(dir, "SKILL.md"))) return "missing";
  const same = (f: string) =>
    fs.existsSync(path.join(dir, f)) && fs.readFileSync(path.join(dir, f)).equals(fs.readFileSync(path.join(SKILL, f)));
  return fs.readdirSync(SKILL).every(same) ? "installed" : "outdated";
}

// HOME is read on every call, so tests can point it at a scratch directory.
export function status(driver: string, url: string): AgentStatus {
  const d = DRIVERS[driver];
  if (!d) return { driver, mcp: null, skill: null };
  const home = os.homedir();
  const parent = d.skills(home);
  const dir = path.join(parent, "review-desk");
  return {
    driver,
    mcp: { connected: registered(d, home), command: [d.bin, ...d.add(url)].map(sh).join(" ") },
    skill: {
      state: skillState(dir),
      path: path.join(dir, "SKILL.md"),
      command: `mkdir -p ${sh(parent)} && cp -R ${sh(SKILL)} ${sh(parent)}/`,
    },
  };
}

function run(bin: string, args: string[], command: string): Promise<void> {
  const s = claudeSpawn(bin, args);
  return new Promise((resolve, reject) => {
    execFile(s.file, s.args, { shell: s.shell, timeout: 60_000 }, (err, _stdout, stderr) => {
      if (!err) {
        resolve();
        return;
      }
      // cmd.exe exits 9009 when it can't find the command.
      const why =
        err.code === "ENOENT" || (s.shell && err.code === 9009)
          ? `${bin} isn't on PATH`
          : `${bin} failed: ${(stderr || err.message).trim().split("\n").slice(-2).join(" ")}`;
      reject(new Error(`${why}. Run it yourself: ${command}`));
    });
  });
}

// Installs or refreshes the skill, then registers the MCP server if it isn't yet.
export async function connect(driver: string, url: string): Promise<AgentStatus> {
  const d = DRIVERS[driver];
  const s = status(driver, url);
  if (!d || !s.mcp || !s.skill) return s;
  if (s.skill.state !== "installed") {
    const dir = path.dirname(s.skill.path);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(SKILL)) fs.writeFileSync(path.join(dir, f), fs.readFileSync(path.join(SKILL, f)));
  }
  if (!s.mcp.connected) await run(d.bin, d.add(url), s.mcp.command);
  return status(driver, url);
}
