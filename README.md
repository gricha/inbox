# Review Desk

A desktop app that turns your GitHub review load into one queue: only what you need to act on, one line each, in order, and everything else sorted away by rules and your policy. Enter on a PR opens its review in the desk: the diff, an AI summary with concerns and notes on the changes, and one key (pressed twice) to approve. When you're done with a PR of your own, `m m` hands it off for merge: the coordinator, a background Claude Code session the desk starts, fixes CI, addresses review comments and merges it once it's approved and green, and hands it back to the queue only when it can't. Approving someone's PR, sending your reply to a reviewer and marking your own draft ready for review are the only things the desk writes to GitHub.

Runs on macOS, Linux and Windows.

## Start

You need Node 22.18 or newer (`node -v`) and a logged-in GitHub CLI (`gh auth status`). The `claude` CLI is only needed for the agents (AI reviews, the judge and the coordinator): they're your own Claude Code, as is the coordinator (below).

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

- **The queue** is the main page: only what you must act on, one ordered list, one line each (the title, its repo#number, its age, and at most one call to action), its first ten and a line for the rest. Your own draft's call to action is Ready for review: `a` twice marks it ready on GitHub. Enter on a PR opens its review (the AI summary, concerns and why it's here are there); an issue opens in place. Anything nobody has touched for two weeks drops to Later.
- **Later** (the sidebar, `g l`): what the rules and Claude sorted away (later, FYI, hidden), what you cleared, and what resolved itself (merged, closed, approved by someone else, no longer requested), each row with why it's there.
- **Merging** (the sidebar, `g m`): your own PRs you've handed off with `m m`, the ones the coordinator is getting merged: each with what it waits on ("waits on a CI fix", "ready to merge") and the coordinator's latest note and its age. Merged ones sit under Merged for 3 days. `b` brings one back to your desk, and the coordinator hands one back itself, with its reason at the top of the queue, when it can't realistically get it merged.
- **Settings** (the sliders icon, `,`, or ⌘, in the app): GitHub, Rules, Agents, Notifications, Appearance (this device's theme: System, Light, Dark, Sand, Slate), Desktop app, AI review, Hand-off prompts. Changes save as you go.
- In the app: the menu bar shows the counts, `Control+Alt+D` shows or hides the window from anywhere, and notifications fire when something new lands in the queue (once Claude or a hard rule placed it, a hand-back included). All three can be changed in Settings → Desktop app.

| Key       | Does                                                           |
| --------- | -------------------------------------------------------------- |
| `j` / `k` | move                                                           |
| `Enter`   | review a PR (diff, AI notes, approve); an issue opens in place |
| `o`       | open on GitHub                                                 |
| `a` `a`   | the row's call to action: your draft, ready for review         |
| `m` `m`   | your own PR: hand off for merge; `b` brings it back to desk    |
| `e` / `d` | done: hidden until someone else comments, reviews or pushes    |
| `s`       | snooze: 1h, 3h, tomorrow, Monday, or until activity            |
| `m` / `p` | someone else's: mute / pin                                     |
| `u`       | undo                                                           |
| `c`       | copy a review prompt to paste into a Claude session            |
| `i`       | AI review: look / skim / skip, summary, concerns, notes        |
| `/`       | filter · `r` sync · `,` settings · `g l` later · `?` all keys  |

Done, snooze, mute and pin are local. Nothing is sent to GitHub.

## Rules

Rules give each item its first placement. Edit them in Settings → Rules: `⌘↵` previews which items would move, `⌘S` saves. They live in `~/.review-desk/config.toml`, and editing the file directly works too.

A board is a source: one or more GitHub searches plus rules. The first rule whose `when` is true sets the bucket. A rule with `hard = true` is a floor: what it matches never sorts below its bucket (Today for a Now rule). Your own Claude Code then sorts everything by your policy (Settings → Policy, a starter until you write one), with the rule's bucket as its hint. Every board feeds the same queue, and an item on several boards shows once, at its most urgent placement.

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
  { when = "me.requested_direct && !me.requested_by_bot", bucket = "now", why = "{me.requested_by} asked you directly", hard = true },
  { when = "author.close", bucket = "later", why = "you engaged with {author.engaged_90d} of their PRs" },
  { when = "me.requested_codeowner && pr.my_area", bucket = "later", why = "CODEOWNERS ping, in code you work on" },
  { when = "me.requested_codeowner && !me.requested_direct", bucket = "fyi", why = "CODEOWNERS ping to @{me.requested_team}" },
]
```

- **Expressions**: `&& || ! == != < <= > >= in matches`, plus `len() lower() contains() startswith() any(list, "glob*")`. Unknown fields are errors with a suggestion.
- **Fields** (listed next to the editor and by `desk fields`): `item.*`, `pr.*` (ci, review, mergeable, size, threads, `stacked`, `my_area`: it changes code you work in), `me.*` (requested directly or via a team or CODEOWNERS, your review, `pushed_since_review`, `new_activity`), `author.*` (bot, `via`: who a bot's PR was opened for, `engaged_90d`, `close`), `repo.*`.
- **Buckets**: `now`, `today`, `later`, `fyi`, `hide`. Hidden items stay visible under "Sorted away".
- `{close_authors}` in a query expands to the people you review most.

The first run writes a starting config: one space for the org with most of your open items, plus Personal for the rest.

## Agents

Every agent the desk runs is your own Claude Code. Settings → Agents connects it to the desk in two parts, and **Connect** there does whatever is missing (if you also work in Codex, `desk connect codex` gives it the same):

- **MCP tools** (`desk_overview`, `desk_list`, `desk_item`, `desk_act`, `desk_undo`, `desk_brief`, `desk_sync`, `desk_events`, `desk_policy`, `desk_config`, and the coordinator's `desk_merging`, `desk_note`, `desk_hand_back`), served by the desk itself at `http://localhost:47823/mcp` whenever the app or `desk serve` runs.
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
desk ls                 # the queue in the terminal (now, then today); `--all` for the rest
desk show seer#8463     # why it's there, with the rule trace
desk done seer#8463     # also: snooze, mute, pin, restore, undo, sync, prompt, brief
desk settings           # list settings; `desk settings set review.auto_ai false`
desk status --short     # "desk 10 +2" (10 in the queue, 2 new), for a status line
```

`bin/desk` is the CLI (`bin/desk.cmd` on Windows). To use `desk` from anywhere, link it onto your PATH: `ln -sf ~/code/review-desk/bin/desk ~/.local/bin/desk`.

Clients that only speak stdio can run `desk mcp` instead. Routes, tools, connecting and the security model: [docs/api.md](docs/api.md).

There's also a `/desk` pane for Claude Code / Desktop in [integrations/claude-desktop/review-desk](integrations/claude-desktop/review-desk). Install it with `claude plugin marketplace add ~/code/review-desk`, then `claude plugin install review-desk@review-desk`.

## Coordinator

The coordinator gets the PRs you hand off with `m m` merged: it works in a git worktree of your local clone, fixes CI, addresses review comments from the repo's members, merges the base in on a conflict, and merges the PR with the repo's merge method once it's approved, green and conflict-free. It never posts comments or replies as you: when a reviewer needs your answer, or it can't finish, it hands the PR back to the top of your queue with one line why. Its latest note on each PR shows in Merging.

The desk starts it, on your first hand-off (or `w` in Merging): one background Claude Code session (`claude --bg`) named "Review Desk coordinator", with Remote Control on, in `~/.review-desk/coordinator`. It's your own `claude` from your PATH, with your login, model and settings, and it uses the desk's MCP tools and skill (Settings → Agents → Connect). After that the desk only wakes it: on a hand-off, and when CI finishes, a review or comment lands, or a conflict appears on a PR in Merging, it sends one short message per minute's batch listing the PRs, their URLs and what changed (never PR text). A busy coordinator gets the message once it's idle. It keeps its history between wakes; nothing runs on a timer. Claude Code runs it, not the desk, so restarting or quitting the desk leaves it alone. Settings → Agents → Coordinator turns it off (and stops it).

Watch it or talk to it:

- Merging's top line: idle or working, **Watch on claude.ai** (its Remote Control page; the Claude app on your phone has it too, under claude.ai/code), and `c` copies `claude attach <id>`, which opens it in a terminal.
- `claude agents` lists it; `claude logs <id>` shows its recent output.
- Other sessions can message it by name ("Review Desk coordinator"), and use the desk's MCP tools and skill themselves.
- `claude stop <id>` pauses it until the next wake resumes it; `claude rm <id>` removes it, and the next wake starts a fresh one.

It runs with your own Claude Code permissions, so allow or approve `git`, `gh pr merge` and your test commands as you like. It reads CI logs and comments anyone can write, so the desk writes a deny list into `~/.review-desk/coordinator/.claude/settings.json` (unless you wrote your own there) for what would let injected text post or rewrite as you: `gh pr comment`, `gh pr review`, `gh pr ready`, `gh api -X` / `--method`, `git push --force` / `-f`. Its worktrees go under each clone's `.claude/worktrees/`, outside its own directory, so add the folder that holds your clones (its full path) to `permissions.additionalDirectories` in that file, or approve its edits there as they come.

## Never

- Its writes to GitHub are approving a PR, when you press `a` twice in its review; your reply to a conversation, when you press Send twice under it in a PR's review; and marking your own draft ready for review, when you press `a` twice on its row or in its review. They go through `src/github/write.ts`, whose allowlist holds only those mutations; agents can't reach it, and `m`, `b` and a hand-back write nothing. The coordinator is your own Claude Code session, which the desk starts and wakes: what it pushes and merges, it does with your `git` and `gh`. Everything the desk does is read only: GraphQL queries (the read client refuses any document containing `mutation`), GETs of your notifications (never marking them read), and `gh api` GETs for a PR's files and description.
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
npm run app:dev     # the app running from this checkout: src/ restarts the desk, web/ hot-reloads, electron/ restarts the app
npm run dev         # server + Vite in a browser at :5173
npm test            # node:test, no network
npm run check       # format, lint (type-aware), CSS lint, types, dead code, tests: what CI runs
npm run smoke:app   # launches the app on a scratch home and checks it end to end
npm run shots       # visual QA: screenshots of every key state, light and dark and each theme (.shots/index.html)
```

Verification: Prettier formats; oxlint with type-aware rules (`.oxlintrc.json`) and stylelint lint; `tsc` runs with `noUncheckedIndexedAccess` and friends; knip catches dead code. A pre-commit hook formats and lints staged files, a pre-push hook runs `npm run check`, and CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs it on macOS, Linux and Windows.

Set `DESK_HOME` and `DESK_PORT` to work on a scratch copy instead of your real desk.
