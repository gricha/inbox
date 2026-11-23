// Every test file's first import (test/no-agent.test.ts checks), so however a test is run it can't reach the owner's real
// claude, codex or opencode: the judge is on by default.
// Tests that run an agent point DESK_CLAUDE (DESK_CODEX, DESK_OPENCODE) at their own fake, and put this back after.
export const NO_AGENT = {
  DESK_CLAUDE: "/nonexistent/claude",
  DESK_CODEX: "/nonexistent/codex",
  DESK_OPENCODE: "/nonexistent/opencode",
} as const;
Object.assign(process.env, NO_AGENT);
// The Sessions source reads these; no test may read the owner's own sessions.
process.env.DESK_CLAUDE_HOME = "/nonexistent/.claude";
process.env.DESK_CODEX_HOME = "/nonexistent/.codex";
process.env.DESK_CLAUDE_APP = "/nonexistent/claude-code-sessions";
// Claude Code's config dir, if the shell sets one: tests point HOME at their own .claude.json.
process.env.CLAUDE_CONFIG_DIR = "";
