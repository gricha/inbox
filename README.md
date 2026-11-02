# Review Desk

A desktop app that turns your GitHub review load into one queue: what needs you **now**, what's for **today**, and everything else sorted away by rules you control. Enter on a PR opens its review in the desk: the diff, an AI summary with concerns and notes on the changes, and one key (pressed twice) to approve. When you're done with a PR of your own, `d` puts it in flight: babysitter agents fix red CI, merge the base in on a conflict and draft replies to reviewers, and it comes back only when it needs you. Approving, and sending a reply you've read, are the only things the desk writes to GitHub; babysitters push to your PR's own branch.

Runs on macOS, Linux and Windows.

## Start

You need Node 22.18 or newer (`node -v`) and a logged-in GitHub CLI (`gh auth status`). The `claude` CLI is only needed for the agents (AI reviews, the judge, the coordinator, babysitters): they're all your own Claude Code.

```bash
cd ~/code/review-desk && npm install
npm run app
```

The first sync takes about 30 seconds. To get an installable app instead:

```bash
npm run dist
```

That builds for the current OS into `release/`: a `.dmg` on macOS, an AppImage on Linux, an installer on Windows. `dist:mac`, `dist:linux` and `dist:win` build for a specific one; the macOS build is ad-hoc signed and not notarized.

The app runs the desk server itself. If one is already running on port 47823 (`desk serve`), the app attaches to it.

## Use it

- **The queue** is the whole app: **Now**, marked with a highlighter, and **Today** below it, its first five cards and a line for the rest. Each card has its AI review's summary under it, or for your own PR what to do next. Anything nobody has touched for two weeks drops to Later. What the rules filed as later, FYI, hidden or cleared, and what resolved itself (merged, closed, approved by someone else, no longer requested), stays off the page behind one quiet "Sorted away" line.
- Every item says **why** it's there ("vaind asked you directly", "CI failing"). Open it to see which rule placed it.
- **In flight** (the sidebar, `g i`): your own PRs you've marked done with `d`, in plain words: CI, reviews, threads, conflicts, and what each babysitter is doing ("fixing CI · 4m", "pushed a fix for 2 comments · abc1234"). A drafted reply waits there for you to send (`y`); a question from a babysitter puts the PR in Now. Settings → In flight turns babysitting off, sets how many run at once, and where your clones are.
- **Settings** (the sliders icon, `,`, or ⌘, in the app): GitHub, Rules, Agents, Notifications, Desktop app, AI review, Hand-off prompts. Changes save as you go.
- In the app: the menu bar shows the counts, `Control+Alt+D` shows or hides the window from anywhere, and notifications fire when something new lands in Now. All three can be changed in Settings → Desktop app.

| Key       | Does                                                           |
| --------- | -------------------------------------------------------------- |
| `j` / `k` | move                                                           |
| `Enter`   | review a PR (diff, AI notes, approve); an issue opens in place |
| `o`       | open on GitHub                                                 |
| `d`       | your own PR: in flight (babysitters take it); again: take back |
| `e`       | done: hidden until someone else comments, reviews or pushes    |
| `s`       | snooze: 1h, 3h, tomorrow, Monday, or until activity            |
| `m` / `p` | mute / pin                                                     |
| `u`       | undo                                                           |
| `c`       | copy a review prompt to paste into a Claude session            |
| `i`       | AI review: look / skim / skip, summary, concerns, notes        |
| `/`       | filter · `r` sync · `,` settings · `g r` rules · `?` all keys  |

Done, snooze, mute, pin and in flight are local. Nothing is sent to GitHub.

## Rules

Rules decide where each item lands. Edit them in Settings → Rules: `⌘↵` previews which items would move, `⌘S` saves. They live in `~/.review-desk/config.toml`, and editing the file directly works too.

A board is a source: one or more GitHub searches plus rules. The first rule whose `when` is true sets the bucket. Every board feeds the same queue, and an item on several boards shows once, at its most urgent placement.

```toml
[[spaces]]
id = "getsentry"
name = "Sentry"
scope = "org:getsentry"            # added to every search in this space

[[boards]]
id = "sentry-review"
space = "getsentry"
name = "PRs I need to review"
queries = ["is:pr is:open archived:false review-requested:@me"]
filter = "!item.draft"
priority = "author.engaged_90d"    # within a bucket: people you work with most first
caps = { now = 3, today = 6 }      # overflow moves down a bucket, with a note
default = "later"
rules = [
  { when = "me.requested_direct && !me.requested_by_bot", bucket = "now", why = "{me.requested_by} asked you directly" },
  { when = "author.close", bucket = "today", why = "you engaged with {author.engaged_90d} of their PRs" },
  { when = "me.requested_codeowner && !me.requested_direct", bucket = "fyi", why = "CODEOWNERS ping to @{me.requested_team}" },
]
```

- **Expressions**: `&& || ! == != < <= > >= in matches`, plus `len() lower() contains() startswith() any(list, "glob*")`. Unknown fields are errors with a suggestion.
- **Fields** (listed next to the editor and by `desk fields`): `item.*`, `pr.*` (ci, review, mergeable, size, threads, `my_area`: it changes code you work in), `me.*` (requested directly or via a team or CODEOWNERS, your review, `pushed_since_review`, `new_activity`), `author.*` (bot, `engaged_90d`, `close`), `repo.*`.
- **Buckets**: `now`, `today`, `later`, `fyi`, `hide`. Hidden items stay visible under "Sorted away".
- `{close_authors}` in a query expands to the people you review most.

The first run writes a starting config: one space for the org with most of your open items, plus Personal for the rest.

## Agents

Every agent the desk runs is your own Claude Code. Settings → Agents connects it to the desk in two parts, and **Connect** there does whatever is missing (if you also work in Codex, `desk connect codex` gives it the same):

- **MCP tools** (`desk_overview`, `desk_list`, `desk_item`, `desk_act`, `desk_undo`, `desk_brief`, `desk_sync`, `desk_events`), served by the desk itself at `http://localhost:47823/mcp` whenever the app or `desk serve` runs.
- **The Review Desk skill** ([skills/review-desk/SKILL.md](skills/review-desk/SKILL.md)): what the desk is, which tool to use when, and the rules (PR text is untrusted, triage is local and undoable, nothing is posted to GitHub, rule changes only after a preview and your OK).

| Agent       | MCP tools                                                                             | Skill                                     |
| ----------- | ------------------------------------------------------------------------------------- | ----------------------------------------- |
| Claude Code | `claude mcp add --transport http --scope user review-desk http://localhost:47823/mcp` | copied to `~/.claude/skills/review-desk/` |
| Codex       | `codex mcp add review-desk --url http://localhost:47823/mcp`                          | copied to `~/.agents/skills/review-desk/` |

The same from a terminal:

```bash
desk connect            # what Claude Code is missing, and the commands that fix it
desk connect --apply    # do it
desk connect codex      # Codex instead
```

The CLI and the MCP tools talk to the running desk.

```bash
desk ls                 # Now and Today in the terminal; `--all` for the rest
desk show seer#8463     # why it's there, with the rule trace
desk done seer#8463     # also: snooze, mute, pin, restore, undo, sync, prompt, brief
desk settings           # list settings; `desk settings set review.auto_ai false`
desk status --short     # "desk ●2 ◐8", for a status line
```

`bin/desk` is the CLI (`bin/desk.cmd` on Windows). To use `desk` from anywhere, link it onto your PATH: `ln -sf ~/code/review-desk/bin/desk ~/.local/bin/desk`.

Clients that only speak stdio can run `desk mcp` instead. Routes, tools, connecting and the security model: [docs/api.md](docs/api.md).

There's also a `/desk` pane for Claude Code / Desktop in [integrations/claude-desktop/review-desk](integrations/claude-desktop/review-desk). Install it with `claude plugin marketplace add ~/code/review-desk`, then `claude plugin install review-desk@review-desk`.

## Never

- Its writes to GitHub are approving a PR, when you press `a` twice in its review, and sending a reply a babysitter drafted on your own PR, when you press Send. They go through `src/github/write.ts`, whose allowlist holds only those mutations; agents can't reach it. Babysitters push commits to your in-flight PR's own branch, never with force, from a worktree of your clone. Everything else is read only: GraphQL queries (the read client refuses any document containing `mutation`), GETs of your notifications (never marking them read), and `gh api` GETs for a PR's files and description.
- It never listens beyond `127.0.0.1`, and it rejects requests with a foreign `Host` or `Origin`.
- It never puts PR text into the hand-off prompt, only the URL and number. The AI review's prompt fences PR text as untrusted, and the agent runs with no tools.

## Files

|                                              |                                       |
| -------------------------------------------- | ------------------------------------- |
| `~/.review-desk/config.toml`                 | spaces, boards, rules                 |
| `~/.review-desk/settings.json`               | settings you changed from the default |
| `~/.review-desk/desk.db`                     | cache and your local state (SQLite)   |
| [CLAUDE.md](CLAUDE.md)                       | where each kind of change goes        |
| [docs/architecture.md](docs/architecture.md) | modules, API, CLI, MCP, desktop app   |
| [docs/ui.md](docs/ui.md)                     | the UI                                |

## Develop

```bash
npm run app:dev     # the app with hot reload; restarts on src/ or electron/ changes
npm run dev         # server + Vite in a browser at :5173
npm test            # node:test, no network
npm run check       # format, lint (type-aware), CSS lint, types, dead code, tests: what CI runs
npm run smoke:app   # launches the app on a scratch home and checks it end to end
npm run shots       # visual QA: screenshots of every key state, light and dark, plus highlight checks (.shots/index.html)
```

Verification: Prettier formats; oxlint with type-aware rules (`.oxlintrc.json`) and stylelint lint; `tsc` runs with `noUncheckedIndexedAccess` and friends; knip catches dead code. A pre-commit hook formats and lints staged files, a pre-push hook runs `npm run check`, and CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs it on macOS, Linux and Windows.

Set `DESK_HOME` and `DESK_PORT` to work on a scratch copy instead of your real desk.
