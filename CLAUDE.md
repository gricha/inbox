# Review Desk

A desktop app (Electron, macOS/Linux/Windows) that turns a GitHub review load into one queue. It is early: the owner is still working out what they want, so keep changes small and easy to undo. Prefer plain code over new abstractions.

Product principle: minimize surfaces (ideally one) and maximize automation. New things become rules, settings or something on the one queue, not new tabs or pages. Design: only urgency gets colour (highlighter = now), sentence case, no boxed chips. After any UI change run `npm run shots` and look at `.shots/` in light and dark; don't call a design change done from code alone.

## Where a change goes

| To change                                          | Edit                                                                                                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A setting (Settings page, `desk settings`)         | One entry in `SETTINGS` in `src/settings.ts`; read it via `desk.settings["section.key"]`. The UI renders it from the schema                                                                            |
| Boards, rules, spaces                              | `~/.review-desk/config.toml` (the Rules page), or the first-run template `defaultConfigText` in `src/config.ts`                                                                                        |
| A field rules can use (`me.*`, `pr.*`, …)          | `FIELDS` and `analyze()` in `src/signals.ts`; any new GitHub data in `src/github/queries.ts` + `normalize.ts`                                                                                          |
| What GitHub is asked                               | `src/github/` (the read client refuses `mutation`; the only writes, approve, Send, and `m`/`b`'s ready-for-review and auto-merge on and off, are in `src/github/write.ts`)                             |
| How a source syncs, what counts as an event        | `src/connectors/` (`github.ts`: reconcile and the notifications feed; `github-events.ts`: the pure snapshot diff), the event log in `activity` (`src/store.ts`)                                        |
| When an item counts as resolved                    | `resolution()` in `src/resolve.ts`                                                                                                                                                                     |
| An HTTP route                                      | `src/server.ts` → a method on `Desk` in `src/desk.ts`                                                                                                                                                  |
| The queue / review / Settings UI                   | `web/src/components/` (Queue, CardRow, Review, Inflight, Settings, Rules, Policy, CoordinatorLog), routes in `web/src/view.ts`, wiring in `web/src/App.tsx`, styles and tokens in `web/src/styles.css` |
| The AI review (prompt, agents, diff fetch)         | `src/review.ts`; kept per commit and run in the background by `Desk` in `src/desk.ts`. Every agent run is the owner's own `claude` (no `--model`, no API key); see api.md's "Your own Claude Code"     |
| Merging: `m`, `b`, needs-you, hand-backs, Send     | `Desk` in `src/desk.ts` (the "merging (in flight)" section, `compute()` for Now), `web/src/components/Inflight.tsx`; internal names stay `inflight`                                                    |
| Claude in Merging (when, worktree, prompt, flags)  | `src/babysit.ts` (babysitters); started from the event log by `Desk`; settings `inflight.*`                                                                                                            |
| The policy and the judge (prompt, starter, cap)    | `~/.review-desk/policy.md` (Settings → Policy), `DEFAULT_POLICY` while it's empty; `src/judge.ts`, its answers reach `classify()` in `src/rules.ts` through `Desk.compute()`; hard rules in `place()`  |
| The coordinator (session, wake, learn, its log)    | `src/coordinator.ts`; its MCP tools (`desk_policy`, `desk_config`, `desk_note`, `desk_act`'s reason) in `src/mcp.ts`; what it may save when in `Desk.ownerAsked()`                                     |
| The desktop app (window, tray, hotkey, login item) | `electron/main.ts`; pure helpers in `electron/lib.ts`                                                                                                                                                  |
| CLI / MCP                                          | `src/cli.ts` / `src/mcp.ts` (both talk HTTP to the running desk via `src/client.ts`)                                                                                                                   |
| Shared types                                       | `src/types.ts` (the web UI imports these too)                                                                                                                                                          |
| The skill                                          | `skills/review-desk/SKILL.md`; connecting agents to the desk in `src/agents.ts`                                                                                                                        |

## Run

```bash
npm run app        # the desktop app from the repo
npm run app:dev    # desktop app with hot reload (web) and restart on src/ or electron/ changes
npm run dev        # server --watch + Vite in a browser at :5173
npm test           # node:test, no network
npm run check      # everything CI runs: prettier, oxlint (type-aware), stylelint, tsc, knip, tests
npm run format     # prettier --write
```

`DESK_HOME` and `DESK_PORT` point any of these at a scratch home and port; the default is `~/.review-desk` on 47823.

## Rules

- The desk writes to GitHub only through `src/github/write.ts`, and only on an explicit user action in the UI (today: approve, `a a` in a PR's review; Send on a drafted reply, `y` then `y` again in Merging, its review or on its card in Now; `m` on your own PR, which marks a draft ready and turns on auto-merge where the repo allows it, and `b`, which turns off what `m` turned on). Its `ALLOWED` map is the complete list of mutations; adding one is a product decision, not a refactor. A hand-back by Claude writes nothing. The only GitHub command a babysitter may run is `git push` to its own PR's branch (`claudeArgs` in `src/babysit.ts` is that allowlist, plus the owner's own Claude Code allow rules, which it loads with `--settings`; the repo's tests it runs are code it can edit, see api.md's security model); their tests use a temp bare remote and a fake `claude`, never a real PR. Every write is logged and recorded in the action log. Nothing an agent can call (MCP tools, the CLI) reaches it, and the read client in `src/github/client.ts` keeps refusing every `mutation`. Tests use a fake write client; live checks stub it (`startServer({ writer })`) and never touch real PRs.
- Node runs the `.ts` files directly (type stripping): no enums, namespaces or parameter properties; relative imports end in `.ts`; type-only imports use `import type`.
- Comments: one line, only for a non-obvious why.
- Add or update a test in `test/` (or `web/test/`) for logic changes. Tests never run a real agent: the judge and coordinator tests put a fake `claude` in a temp dir, and a `Desk` without `mcpUrl` keeps the coordinator off.
- `npm run check` must pass before you're done (the pre-push hook runs it; CI runs it on macOS, Linux and Windows). Fix findings, don't silence them: an inline `// oxlint-disable-next-line <rule> -- <reason>` only where the rule is wrong for that line. Don't loosen `.oxlintrc.json` or the tsconfig flags.
- TypeScript 7 (the Go compiler) has no JS API, so typescript-eslint can't run; type-aware linting is oxlint + tsgolint.
