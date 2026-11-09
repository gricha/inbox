# Review Desk

A desktop app that turns your GitHub review load into one queue: only what you need to act on, one line each, in order, and everything else sorted away by rules and your policy. A click on a PR opens its review in the desk: the diff, an AI summary with concerns and notes on the changes, and one click to approve (it's off your desk at once). When you're done with a PR of your own, **Hand off for merge** hands it off: the coordinator, a background Claude Code session the desk starts, fixes CI, addresses review comments and merges it once it's approved and green, and hands it back to your Inbox only when it can't. Approving someone's PR, commenting on one, sending your reply to a reviewer, marking your own draft ready for review (asking the reviewers you pick) and the More menu's typical PR and issue actions (close, convert to draft, merge, reopen, request changes) are the only things the desk writes to GitHub.

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

- **Inbox** is the main page: only what you must act on, one ordered list in parts (agents' questions, a PR back to you (the coordinator handed it back, or it's ready and nobody's asked to review it: Add reviewers), other people's PRs waiting on your review in amber, issues and other PRs, then your own PRs), one line each (the title, its repo#number, its age, and at most one call to action), its first ten and a line for the rest. Your own draft's call to action is Ready for review: it marks it ready on GitHub (in its review, with the reviewers you pick: GitHub's suggestions sit on the line, a click each, and the box finds anyone as you type). A click on a PR opens its review (the AI summary, concerns and why it's here are there); an issue opens in place. Someone else's PR comes onto it once Claude has reviewed it (a line under the list says how many are still being reviewed), and one an agent handed you says why it's there and who sent it. Anything nobody has touched for two weeks drops to Later, on FYI.
- **Blocked** (the sidebar): what can't move until something else happens, as your rules put it in the `blocked` bucket: a PR that needs another PR merged first (its description says "Requires …", or it's stacked on it), down the chain ("blocked by sentry#129460, which waits on your reply to markstory, then a review from cvxluo, skaasten and 6 more"), and your PRs waiting on reviewers ("waits on a review from dana and @backend"). Your PRs in Merging that another PR blocks are listed too, in their chain ("in Merging · blocked by …"). A chain's rows sit together, the PR blocking them first, and only the first says what that PR waits on. What you do on a row takes it off; it comes back when the PR it waits on merges. A coordinator's hand-back of a PR another one blocks waits here, and tops the Inbox once that PR merges. A click opens the review, where you can comment to nudge.
- **FYI** (the sidebar): what the rules and Claude sorted away (later, FYI, hidden) and what you snoozed or muted, each row with why it's there.
- **Merging** (the sidebar): your own PRs you've handed off, the ones the coordinator is getting merged: each with what it waits on ("waits on a CI fix", "ready to merge") and the coordinator's latest note and its age. Merged ones sit under Merged for 3 days. Back to desk brings one back to your desk, and the coordinator hands one back itself, with its reason, at the top of your Inbox, when it can't realistically get it merged. Your PR that's ready to merge but conflicts shows there too, "rebasing", until GitHub sees it mergeable (Coordinator, below).
- **Archive** (the sidebar): what's done: what you acted on in the desk (it leaves your list the moment you do; a review stays open saying what you did) and what resolved itself (merged, closed, approved, no longer requested), newest first. Last in the sidebar, under Merging.
- **Settings** (the sidebar, or ⌘, in the app): GitHub (with its searches and rules, the AI review, and under More the sync interval, bots and what `desk prompt <ref>` prints), Claude (connecting it, sorting by your policy, your agent), Inbox and notifications, This device (its theme: System, or a light one (Light, Sand, Solarized, Catppuccin Latte, Sentry Dawn, Rose Pine, Flexoki Light) or a dark one (Dark, Slate, Sentry Dusk, Gruvbox, Tokyo Night, Everforest, Kanagawa, Nord), or on a machine running Omarchy, Omarchy, which follows its theme as it switches; and the desktop app's). Changes save as you go. Automations, your instructions on a schedule, are its second tab.
- In the app: the menu bar shows the Inbox's count (macOS), `Control+Alt+D` (Control+Option+D on a Mac) shows or hides the window from anywhere, and notifications fire when something new lands in your Inbox (once Claude or a hard rule placed it, a hand-back included). The shortcut and the menu bar's count are in Settings → This device, notifications in Settings → Inbox and notifications.

Everything is a click. A row opens its review (an issue opens in place); a right-click on any row opens its menu: Review, Open on GitHub, its call to action or Hand off for merge, Done, Snooze, Mute, Pin, Why it's here, Ask your agent, and its GitHub writes. A review's buttons and More do the rest. The keys that stay are the platform's: Esc closes and goes back, ⌘↵ sends what you wrote, Enter sends in the chat, ⌘S saves an editor, Tab moves between rows and buttons.

Snooze waits on FYI until a time, until someone acts, or until the PR changes as you need: CI passes, new commits, it's approved, out of draft, the merge conflict fixed; then it's back on your desk. Done, snooze, mute and pin are local. Nothing is sent to GitHub.

## Rules

Rules give each item its first placement. Edit them in Settings → GitHub → Searches and rules: Preview changes (⌘↵) shows which items would move, Save (⌘S) saves. They live in `~/.inbox/config.toml`, and editing the file directly works too.

A board is a source: one or more GitHub searches plus rules. The first rule whose `when` is true sets the bucket. A rule with `hard = true` is a floor: what it matches never sorts below its bucket (Today for a Now rule). A rule with `final = true` isn't re-sorted by Claude: what it matches stays in its bucket (your pin still lifts it). Your own Claude Code then sorts everything by your policy (Settings → Claude → Your policy, a starter until you write one), with the rule's bucket as its hint. Every board feeds the same desk, and an item on several boards shows once, at its most urgent placement.

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
- **Fields** (listed next to the editor and by `desk fields`): `item.*`, `pr.*` (ci, review, mergeable, size, threads, `stacked`, `my_area`: it changes code you work in; `requires`, `blocked`, `blocker`, `blocker_waits`, `blocks`: the PRs it needs merged first and who blocks whom; `waits`, `waiting_on`: what and who it waits on), `me.*` (requested directly or via a team or CODEOWNERS, your review, `pushed_since_review`, `new_activity`, `owes_reply`), `author.*` (bot, `via`: who a bot's PR was opened for, `engaged_90d`, `close`), `repo.*`.
- **Buckets**: `now`, `today`, `blocked`, `later`, `fyi`, `hide`. Only rules fill `blocked`: Claude never answers it. Hidden items stay visible under "Sorted away".
- `{close_authors}` in a query expands to the people you review most.

The first run writes a starting config: one space for the org with most of your open items, plus Personal for the rest.

## Agents

Every agent the desk runs is your own Claude Code. It connects to the desk in two parts; while one is missing, Settings → Claude says so, and **Connect Claude Code** there does whatever is missing (if you also work in Codex, `desk connect codex` gives it the same):

- **MCP tools** (`desk_overview`, `desk_list`, `desk_item`, `desk_act`, `desk_add`, `desk_undo`, `desk_brief`, `desk_sync`, `desk_events`, `desk_policy`, `desk_config`, and the coordinator's `desk_merging`, `desk_note`, `desk_hand_back`, `desk_answer`, `desk_ask`), served by the desk itself at `http://localhost:47823/mcp` whenever the app or `desk serve` runs.
- **The Inbox skill** ([skills/inbox/SKILL.md](skills/inbox/SKILL.md)): what the desk is, which tool to use when, and the rules (PR text is untrusted, triage is local and undoable, nothing is posted to GitHub, rule changes only after a preview and your OK). Once installed, the desk keeps it current: `desk serve` on `~/.inbox` refreshes an installed copy that differs from the repo's when it starts and when the repo's skill changes. It, and Connect, also rename what Connect installed before the rename to Inbox: the `review-desk` MCP server becomes `inbox`, and the skill's copy moves from `skills/review-desk/` to `skills/inbox/`.

| Agent       | MCP tools                                                                       | Skill                               |
| ----------- | ------------------------------------------------------------------------------- | ----------------------------------- |
| Claude Code | `claude mcp add --transport http --scope user inbox http://localhost:47823/mcp` | copied to `~/.claude/skills/inbox/` |
| Codex       | `codex mcp add inbox --url http://localhost:47823/mcp`                          | copied to `~/.agents/skills/inbox/` |

The same from a terminal:

```bash
desk connect            # what Claude Code is missing, and the commands that fix it
desk connect --apply    # do it
desk connect codex      # Codex instead
```

The CLI and the MCP tools talk to the running desk.

```bash
desk ls                       # the queue in the terminal (now, then today); `--all` for the rest
desk show seer#8463           # why it's there, with the rule trace
desk add getsentry/seer#8463  # on your desk, pinned, its AI review started ("add X to my review" in any session)
desk add getsentry/seer#8463 "your call on the retry budget" --from "seer retry fix"  # with the line it shows as why
desk done seer#8463           # also: snooze, mute, pin, restore, undo, sync, prompt, brief
desk settings                 # list settings; `desk settings set review.auto_ai false`
desk status --short           # "desk 10 +2" (10 in the queue, 2 new), for a status line
```

`bin/desk` is the CLI (`bin/desk.cmd` on Windows). To use `desk` from anywhere, link it onto your PATH: `ln -sf ~/code/review-desk/bin/desk ~/.local/bin/desk`.

Clients that only speak stdio can run `desk mcp` instead. Routes, tools, connecting and the security model: [docs/api.md](docs/api.md).

There's also a `/desk` pane for Claude Code / Desktop in [integrations/claude-desktop/inbox](integrations/claude-desktop/inbox). Install it with `claude plugin marketplace add ~/code/review-desk`, then `claude plugin install inbox@inbox`.

## Coordinator

The desk's window calls it **your agent**.

The coordinator gets the PRs you hand off for merge merged: it gives each PR, or each stack, its own background subagent and keeps track of them, and the subagent works in a git worktree of your local clone, fixes CI, addresses review comments from the repo's members, rebases it on a conflict once it's otherwise ready, and merges the PR with the repo's merge method once it's approved, green and conflict-free. It never posts comments or replies as you: when a reviewer needs your answer, or it can't finish, it hands the PR back to the top of your Inbox with one line why. Its latest note on each PR shows in Merging.

A merge conflict on its own isn't yours: no rule puts one on your desk and nothing notifies for one. Once the coordinator is started, your own PR on your desk that's otherwise ready to merge (approved, CI not failing, not a draft) and conflicts goes to it to rebase, on its own: it leaves your desk for Merging as "rebasing", and the coordinator rebases it onto its base, runs what it can, pushes with `--force-with-lease` to that PR's own branch and leaves the merge to you. Once GitHub sees it mergeable it leaves Merging by itself and is back on your desk, ready to merge. One it can't rebase cleanly it hands back with why; one it hands back or you bring back with Back to desk stays yours. With the coordinator off, it stays on your desk. A PR you handed off for merge gets rebased once it's approved, or before the coordinator pushes a fix (GitHub runs no CI on a conflicting PR); a stacked one whose parent was squash-merged with `git rebase --onto`, dropping the parent's commits.

The desk starts it, on your first hand-off or ask (or **Start it now** in Merging): one background Claude Code session (`claude --bg`) named "Inbox coordinator", with Remote Control on, in `~/.inbox/coordinator`. It's your own `claude` from your PATH, with your login, model and settings, and it uses the desk's MCP tools and skill (Settings → Claude → Connect Claude Code). After that the desk only wakes it: at once with your asks, on a hand-off, and when CI finishes, a review or comment lands, or a conflict appears on a PR in Merging, it sends one short message per minute's batch listing the PRs, their URLs and what changed (never PR text). A busy coordinator gets the message once it's idle; news that a desk restart or a failed start interrupts goes with the next wake or desk start. It keeps its history between wakes. Once started, the desk keeps it running: when the desk starts and every 5 minutes it looks (one `claude agents`, no turn); a running one is left as it is, and one that stopped or crashed is resumed with no prompt, which starts no turn. A wake briefly stops and resumes it, so talk to it between wakes, or turn it off while you work with it. Claude Code runs it, not the desk, so restarting or quitting the desk leaves it alone. Turning off Settings → Claude → Run your agent stops it; on again resumes it. After the desk's home moved from `~/.review-desk` (its folder before the rename to Inbox), the session in the old folder can't be resumed: the desk stops it, and the next wake starts a fresh one in `~/.inbox/coordinator`. If Claude Code hasn't trusted that folder (or one above it), Merging says so in claude's words until you run `claude` there once and accept.

Settings → Claude → Let your agent run without asking (on by default) runs it in bypass permissions mode, so it never stops to ask. Its deny list (below) still applies, since deny rules hold in every mode, but it's then the only fence: anything it doesn't name runs without asking. Leave it on if your own sessions skip permission prompts: Claude Code delivers messages between two sessions only when both skip them or neither does, so otherwise the coordinator's messages to your sessions, and theirs to it, are held and expire. Claude Code needs bypass mode accepted once first: run `claude --dangerously-skip-permissions` in a terminal and accept. Until then, or if your org disables bypass mode, Merging shows Claude Code's refusal in red. Changing the setting restarts the coordinator in the new mode with its history: Claude Code makes a copy of the session, which the desk keeps from then on, and the old one stays stopped in `claude agents`. A busy coordinator switches once it's idle; one stuck on a permission prompt switches right away and carries on. Off again, the copy runs in Claude Code's `default` mode, not a `defaultMode` from your settings.

Talk to it from the desk: **Ask your agent** in the sidebar opens your chat with it about what you're on. In a PR's review, that's the PR and the spot you were last on: a conversation, a thread you clicked Reply on, or lines you picked with the `+`; the chat's × widens it. The `+` box, a thread's Reply box and each conversation have a quiet **Ask your agent** too, which never sends what you typed there. Enter sends: the desk keeps your words and wakes it at once with them, the item's id and URL, whose PR it is in the desk's words, and the thread's URL or the lines' numbers. Never PR text: it reads a file's name with `desk_ask`. It does what you said with the desk's tools, by checking the code and GitHub, or by its subagents. On your own open PR it makes a change you ask for (in Merging, the subagent that has it; not handed off, a subagent for that ask alone, which pushes to its branch, never forced or merged, and says to pull first); on someone else's it answers with the change (a suggestion block, with Copy under it), and never pushes or posts. It answers with `desk_answer`, in the chat and as a notification, and its open questions about the item show above the chat's box. With it off, no Ask your agent shows, and the chat says so and sends nothing. Other Claude sessions can message "Inbox coordinator" by name, or use the desk's MCP tools themselves.

Watch it or talk to it:

- Merging's top line: **Watch on claude.ai** (its Remote Control page; the Claude app on your phone has it too, under claude.ai/code), and **Copy attach command** copies `claude attach <id>`, which opens it in a terminal.
- `claude agents` lists it; `claude logs <id>` shows its recent output.
- Other sessions can message it by name ("Inbox coordinator"), and use the desk's MCP tools and skill themselves.
- `claude stop <id>` stops it until the desk's next look, within 5 minutes, resumes it (turn it off in Settings to keep it stopped); `claude rm <id>` removes it, and the next wake starts a fresh one.

With Let your agent run without asking (above) off, it runs with your own Claude Code permissions, so allow or approve `git`, `gh pr merge` and your test commands as you like. It reads CI logs and comments anyone can write, so the desk writes a deny list into `~/.inbox/coordinator/.claude/settings.json` for what would let injected text post or rewrite as you: `gh pr comment`, `review`, `ready`, `edit`, `close`, `reopen` and `create`, `gh issue comment`, `edit`, `close`, `reopen` and `create` (close and reopen take `--comment`), all of `gh api`, and a force push: `--force` or `-f` before or after the branch, or a `+branch` refspec (not `--force-with-lease`, which it pushes with after a rebase). If that file exists, the desk adds the rules it lacks and keeps the rest. Its worktrees go under each clone's `.claude/worktrees/`, outside its own directory, so add the folder that holds your clones (its full path) to `permissions.additionalDirectories` in that file, or approve its edits there as they come.

## Automations

The desk's sources are GitHub, polled, and your automations: your instructions, run on a schedule by your own Claude Code, that put on your desk what needs you from wherever they look. "Weekdays at 9, look at what's new in getsentry/warden and getsentry/dotagents and put on my desk what needs me" is one. Settings → Automations lists them, each with when it runs in words ("Mon and Thu at 17:30") and its last run, **Run now** while it's on and a switch (one an agent wrote or changed has **Review** instead, which opens it), and its name opens it: its instruction, its last runs (what each read and found, and what came of each item) and an editor: a name, when (`daily 09:00`, `weekdays 09:00,13:00`, `mon,thu 17:30`, or `weekdays hourly` for every hour on the hour, local time) and the instruction. Ask any agent with the desk's tools to write one for you (`desk_automations`); one an agent drafts or changes stays off until you turn it on there, and only you delete one.

When one is due (the last matching time passed since its last run, and since you set it; a desk that slept through several runs once, and one a desk restart cut off runs again), the desk runs `claude -p` in `~/.inbox/automations` with the instruction, read-only rules, and when its last run was and what the desk took from it. It's your own `claude` with your login, model and settings, and it never asks: it may read (files, the web, `gh`'s list, view, search, diff and checks, the desk's read tools) and use what your Claude Code settings already allow (your MCP servers' tools you allowed, say), and anything else is refused. A deny list in that folder keeps posting, editing or merging with `gh`, `gh api`, pushing, committing, editing files and the desk's own writes off even where your settings allow them. Its answer is a summary and the PRs and issues that need you (`owner/repo#123`, up to 20), each with one line on why. The desk adds them the way `desk_add` does (fetched if it doesn't hold them, pinned, a PR's pre-review started), and the item's why on your desk is the automation's ("Warden issues: a crash since 0.9"); the pin lifts it to Today or above, as yours would. One already in your Inbox stays as it is; one you'd dealt with (done, snoozed, muted, in Merging) stays that way, and so does one nobody needs now (closed, merged, approved by someone else). Done, snooze, mute or a hand-off ends an automation's pin, so what you dealt with stays dealt with. A run that put something on your desk, couldn't add something, or failed notifies you. Each run keeps its Claude Code session: `claude --resume <id>` in that folder shows what it did, and **Copy resume command** on the run copies that.

## Never

- Its writes to GitHub are approving a PR, when you click Approve in its review; a comment on a PR, when you click Comment in its review, or on an open issue, Comment on it opened in place; a comment on a line of its diff, when you click the `+` by the line's number (or drag it down several) and send it; your reply to a conversation, when you click Reply under it in a PR's review; marking your own draft ready for review, when you click Ready for review on its row or in its review, and asking the reviewers you picked there; asking reviewers on your ready PR nobody's asked to review, when you click Ask reviewers in its review; and the More menu's (in a PR's review, or a row's right-click menu), each only when the desk allows it for that item: closing or reopening a PR you opened, converting it to a draft, merging it now, without the coordinator (only when it's approved, green, not stacked on another PR and GitHub says it's mergeable, with the repo's merge method, pinned to the commit the desk judged ready), closing an issue you opened or are assigned, and requesting changes on someone else's PR with what you write in its review. The toast's Undo, while a close's or a draft's toast is up, reopens it or marks it ready again. They go through `src/github/write.ts`, whose allowlist holds only those mutations; agents can't reach it, and Hand off for merge, Back to desk and a hand-back write nothing. The coordinator is your own Claude Code session, which the desk starts and wakes: what it pushes and merges, it does with your `git` and `gh`. Everything the desk does is read only: GraphQL queries (the read client refuses any document containing `mutation`), GETs of your notifications (never marking them read), and `gh api` GETs for a PR's files and description.
- An automation never writes: it runs read only behind a deny list, and the desk, not the run, puts what it lists on your desk. Only you turn one on.
- It never listens beyond `127.0.0.1`, and it rejects requests with a foreign `Host` or `Origin`.
- What you write (comments, replies, your answers to agents, the policy) never reaches Sentry, where `desk serve` reports its errors, traces and log lines and the UI its errors and traces (`src/sentry.ts`): request and response bodies, MCP calls' arguments and results, and your IP stay off. Its log lines do carry what the desk logs, such as an agent's question or why a PR was handed back, and its errors GitHub's error text. `DESK_SENTRY=0` sends nothing.
- It never puts PR text into the hand-off prompt, only the URL and number. The AI review's prompt fences PR text as untrusted, and the agent runs with no tools. Each of its concerns and notes quotes the code it's about, and a second run checks every one against the diff: what the diff doesn't bear out never reaches you.

## Files

|                                              |                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| `~/.inbox/config.toml`                       | spaces, boards, rules                                                          |
| `~/.inbox/settings.json`                     | settings you changed from the default                                          |
| `~/.inbox/desk.db`                           | cache and your local state (SQLite)                                            |
| [AGENTS.md](AGENTS.md)                       | where each kind of change goes                                                 |
| [docs/architecture.md](docs/architecture.md) | modules, API, CLI, MCP, desktop app                                            |
| [docs/ui.md](docs/ui.md)                     | the UI                                                                         |
| [docs/visual.md](docs/visual.md)             | the mark, the colours, the layout, and how a design change is made and checked |
| [docs/plugins.md](docs/plugins.md)           | the design for a small core with every source a plugin (not built yet)         |

## Develop

```bash
npm run app:dev     # the app running from this checkout: src/ restarts the desk, web/ hot-reloads, electron/ restarts the app
npm run dev         # server + Vite in a browser at :5173
npm test            # node:test, no network
npm run check       # format, lint (type-aware), CSS lint, types, dead code, tests: what CI runs
npm run smoke:app   # launches the app on a scratch home and checks it end to end
npm run shots       # visual QA: screenshots of every key state, light and dark and each theme (.shots/index.html); docs/visual.md says what to look at
npm run icons       # every icon (app, tray, favicon) from the mark in assets/brand/mark.svg
```

Verification: Prettier formats; oxlint with type-aware rules (`.oxlintrc.json`) and stylelint lint; `tsc` runs with `noUncheckedIndexedAccess` and friends; knip catches dead code. A pre-commit hook formats and lints staged files, a pre-push hook runs `npm run check`, and CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs it on macOS, Linux and Windows.

Set `DESK_HOME` and `DESK_PORT` to work on a scratch copy instead of your real desk, and `DESK_SENTRY=0` to keep it out of Sentry.
