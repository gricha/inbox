// Loaded before every test file (npm test): the judge is on by default, so no test may reach the owner's real claude.
// Tests that run an agent point DESK_CLAUDE at their own fake.
process.env.DESK_CLAUDE = "/nonexistent/claude";
// The Sessions source reads these; no test may read the owner's own sessions.
process.env.DESK_CLAUDE_HOME = "/nonexistent/.claude";
process.env.DESK_CODEX_HOME = "/nonexistent/.codex";
process.env.DESK_CLAUDE_APP = "/nonexistent/claude-code-sessions";
