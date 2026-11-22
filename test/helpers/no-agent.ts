// Every test file's first import (test/no-agent.test.ts checks), so however a test is run it can't reach the owner's real
// claude: the judge is on by default.
// Tests that run an agent point DESK_CLAUDE at their own fake.
process.env.DESK_CLAUDE = "/nonexistent/claude";
// The Sessions source reads these; no test may read the owner's own sessions.
process.env.DESK_CLAUDE_HOME = "/nonexistent/.claude";
process.env.DESK_CODEX_HOME = "/nonexistent/.codex";
process.env.DESK_CLAUDE_APP = "/nonexistent/claude-code-sessions";
process.env.DESK_OPENCODE = "/nonexistent/opencode";
// Claude Code's config dir, if the shell sets one: tests point HOME at their own .claude.json.
process.env.CLAUDE_CONFIG_DIR = "";
