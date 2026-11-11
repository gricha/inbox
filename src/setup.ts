// The first-run page's words (GET /api/setup): who GitHub says you are or what to run, and each agent's state.
import type { DriverId } from "./agents.ts";
import type { GitHubReadError, Upstream } from "./errors.ts";
import type { SetupAgent, SetupView } from "./types.ts";

export const AGENTS: { id: DriverId; name: string }[] = [
  { id: "claude-code", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "opencode", name: "OpenCode" },
];

const INSTALL: Record<DriverId, { unix: string; win32: string }> = {
  "claude-code": { unix: "curl -fsSL https://claude.ai/install.sh | bash", win32: "npm install -g @anthropic-ai/claude-code" },
  codex: { unix: "npm install -g @openai/codex", win32: "npm install -g @openai/codex" },
  opencode: { unix: "curl -fsSL https://opencode.ai/install | bash", win32: "npm install -g opencode-ai" },
};
// The same words as errors.ts's NOT_LOGGED_IN and its kin.
const LOGIN: Record<DriverId, string> = { "claude-code": "claude auth login", codex: "codex login", opencode: "opencode auth login" };

export function agentView(id: DriverId, name: string, installed: boolean, loggedIn: boolean, platform = process.platform): SetupAgent {
  const install = INSTALL[id][platform === "win32" ? "win32" : "unix"];
  const fix = !installed ? `${install} && ${LOGIN[id]}` : loggedIn ? null : LOGIN[id];
  return { id, name, installed, logged_in: installed && loggedIn, fix };
}

export function githubView(login: string, error: GitHubReadError | Upstream | null, platform = process.platform): SetupView["github"] {
  if (!error) return { login: login || null, error: null, fix: null };
  if (error._tag !== "GitHubAuthError") return { login: null, error: `Couldn't reach GitHub: ${error.message}`, fix: null };
  if (error.reason === "gh_missing")
    return platform === "darwin"
      ? { login: null, error: "The GitHub CLI isn't installed.", fix: "brew install gh && gh auth login" }
      : { login: null, error: "The GitHub CLI isn't installed: get it from cli.github.com.", fix: "gh auth login" };
  const why = error.reason === "rejected" ? "GitHub refused your login." : "You're not signed in to GitHub.";
  return { login: null, error: why, fix: "gh auth login" };
}
