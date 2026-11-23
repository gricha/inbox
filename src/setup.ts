// The first-run page's words (GET /api/setup): who GitHub says you are or the step left, and each agent's state.
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
// Where each agent says how to install it.
const PAGE: Record<DriverId, string> = {
  "claude-code": "https://claude.com/claude-code",
  codex: "https://developers.openai.com/codex/cli",
  opencode: "https://opencode.ai/docs",
};
// The same words as errors.ts's NOT_LOGGED_IN and its kin.
const LOGIN: Record<DriverId, string> = { "claude-code": "claude auth login", codex: "codex login", opencode: "opencode auth login" };

export function agentView(id: DriverId, name: string, installed: boolean, loggedIn: boolean, platform = process.platform): SetupAgent {
  const install = INSTALL[id][platform === "win32" ? "win32" : "unix"];
  const fix = !installed ? `${install} && ${LOGIN[id]}` : loggedIn ? null : LOGIN[id];
  return { id, name, installed, logged_in: installed && loggedIn, fix, url: PAGE[id] };
}

// What's left before Inbox can read GitHub, said as a step to take rather than an error: a first run on a machine without gh,
// signed out or offline is where everyone starts. detail is what the desk saw, for a tooltip.
export function githubView(login: string, error: GitHubReadError | Upstream | null, platform = process.platform): SetupView["github"] {
  const view = { login: null, why: null, fix: null, url: null, detail: null };
  if (!error) return { ...view, login: login || null, step: null };
  if (error._tag !== "GitHubAuthError")
    return { ...view, step: "Connect to GitHub", why: "Inbox can't reach GitHub from here. Check your connection.", detail: error.message };
  const why = "Inbox reads your reviews, PRs and issues through it.";
  if (error.reason === "gh_missing")
    return platform === "darwin"
      ? { ...view, step: "Install the GitHub CLI", why, fix: "brew install gh && gh auth login" }
      : { ...view, step: "Install the GitHub CLI", why, fix: "gh auth login", url: "https://cli.github.com" };
  if (error.reason === "rejected")
    return {
      ...view,
      step: "Sign in to GitHub again",
      why: "GitHub no longer takes the saved login.",
      fix: "gh auth login",
      detail: error.message,
    };
  return {
    ...view,
    step: "Sign in to GitHub",
    why: "Inbox reads your reviews, PRs and issues on your own login.",
    fix: "gh auth login",
    detail: error.message,
  };
}
