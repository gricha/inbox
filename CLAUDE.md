# Review Desk

A desktop app (Electron, macOS/Linux/Windows) that turns a GitHub review load into one queue. It is early: the owner is still working out what they want, so keep changes small and easy to undo. Prefer plain code over new abstractions.

Product principle: minimize surfaces (ideally one) and maximize automation. New things become rules, settings or something on the one queue, not new tabs or pages. Design: only urgency gets colour (highlighter = now), sentence case, no boxed chips. After any UI change run `npm run shots` and look at `.shots/` in light and dark; don't call a design change done from code alone.

## Where a change goes

| To change                                          | Edit                                                                                                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A setting (Settings page, `desk settings`)         | One entry in `SETTINGS` in `src/settings.ts`; read it via `desk.settings["section.key"]`. The UI renders it from the schema                                        |
| Boards, rules, spaces                              | `~/.review-desk/config.toml` (the Rules page), or the first-run template `defaultConfigText` in `src/config.ts`                                                    |
| A field rules can use (`me.*`, `pr.*`, …)          | `FIELDS` and `analyze()` in `src/signals.ts`; any new GitHub data in `src/github/queries.ts` + `normalize.ts`                                                      |
| What GitHub is asked                               | `src/github/` (read-only: the client refuses `mutation`)                                                                                                           |
| How a source syncs, what counts as an event        | `src/connectors/` (`github.ts`: reconcile and the notifications feed; `github-events.ts`: the pure snapshot diff), the event log in `activity` (`src/store.ts`)    |
| When an item counts as resolved                    | `resolution()` in `src/resolve.ts`                                                                                                                                 |
| An HTTP route                                      | `src/server.ts` → a method on `Desk` in `src/desk.ts`                                                                                                              |
| The queue / Settings UI                            | `web/src/components/` (Queue, CardRow, Settings, Rules), routes in `web/src/view.ts`, wiring in `web/src/App.tsx`, styles and theme tokens in `web/src/styles.css` |
| The desktop app (window, tray, hotkey, login item) | `electron/main.ts`; pure helpers in `electron/lib.ts`                                                                                                              |
| CLI / MCP                                          | `src/cli.ts` / `src/mcp.ts` (both talk HTTP to the running desk via `src/client.ts`)                                                                               |
| Shared types                                       | `src/types.ts` (the web UI imports these too)                                                                                                                      |
| The skill                                          | `skills/review-desk/SKILL.md`; connecting agents to the desk in `src/agents.ts`                                                                                    |

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

- Never write to GitHub: no mutations, no comments, no reviews.
- Node runs the `.ts` files directly (type stripping): no enums, namespaces or parameter properties; relative imports end in `.ts`; type-only imports use `import type`.
- Comments: one line, only for a non-obvious why.
- Add or update a test in `test/` (or `web/test/`) for logic changes.
- `npm run check` must pass before you're done (the pre-push hook runs it; CI runs it on macOS, Linux and Windows). Fix findings, don't silence them: an inline `// oxlint-disable-next-line <rule> -- <reason>` only where the rule is wrong for that line. Don't loosen `.oxlintrc.json` or the tsconfig flags.
- TypeScript 7 (the Go compiler) has no JS API, so typescript-eslint can't run; type-aware linting is oxlint + tsgolint.
