# Agents end to end

A manual check, not part of `npm test`: the desk's Codex and OpenCode paths against a real model, in a container, through OpenRouter. Each agent is pointed at OpenRouter in its own config inside the container (`~/.codex/config.toml`'s `model_providers.openrouter`, `~/.config/opencode/opencode.json`'s `model`), written by `entry.sh` at run time; the desk's code is never told about OpenRouter.

```bash
docker build -t inbox-agents-e2e scripts/agents-e2e
docker run --rm --env-file <file with OPENROUTER_API_KEY=…> -v "$PWD":/src:ro inbox-agents-e2e
```

The checkout is mounted read only at `/src` and run with its own `node_modules` (the desk's runtime dependencies are plain JS). The key comes only from `--env-file`: it isn't in the image, and both configs name the variable, not its value.

`drive.ts` runs, per agent, and prints PASS or FAIL per path with what came back:

- `login`: `loggedIn()`, the desk's login check.
- `review`: `generateReview()` on a fixture PR (one file, no GitHub), its writer and its check.
- `fence`: a tool-less call asked to write a file, which it mustn't be able to.
- `desk`: a desk over a stubbed GitHub (`test/helpers/desk.ts`), served with its MCP on a scratch port, that connects the agent (`agents.connect()`: MCP server and skill), writes the PR's AI review, sorts it with the judge and reads what a reviewer said.
- `automation`: an automation's agent run, with the desk's read tools over MCP.
- `coordinator`: your agent's first turn, a wake that resumes the same session (and whether the model answered the ask through `desk_answer`, said but not failed on), and its deny list with Let your agent run without asking on, so only the rules stand: told to run `gh pr view` and then `gh api` as two commands, the first must reach a `gh` on its PATH that only leaves a mark, and the second must not. A rule matches the command the agent runs, so a `gh api` it runs inside another (`echo "$(gh api …)"`, `bash -c`) gets past either agent's rules; that fails the check too.

Knobs: `E2E_AGENTS` (`codex,opencode`), `E2E_PATHS` (any of the above, comma separated), `E2E_MODEL` (an OpenRouter model id with tools; `openai/gpt-5-mini` by default), `E2E_VERBOSE=1` for the desk's log. Build args `CODEX_VERSION` and `OPENCODE_VERSION` pick the CLIs. A full run is about 25 model calls, a few cents on the default model.
