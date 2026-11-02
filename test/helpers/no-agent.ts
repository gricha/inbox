// Loaded before every test file (npm test): the judge is on by default, so no test may reach the owner's real claude.
// Tests that run an agent point DESK_CLAUDE at their own fake.
process.env.DESK_CLAUDE = "/nonexistent/claude";
