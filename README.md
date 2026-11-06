# Review Desk

A desktop app that turns your GitHub review load into one queue: only what you need to act on, one line each, in order, and everything else sorted away by rules and your policy. Enter on a PR opens its review in the desk: the diff, an AI summary with concerns and notes on the changes, and one key to approve (it's off your desk at once). When you're done with a PR of your own, `m` hands it off for merge: the coordinator, a background Claude Code session the desk starts, fixes CI, addresses review comments and merges it once it's approved and green, and hands it back to the queue only when it can't. Approving someone's PR, commenting on one, sending your reply to a reviewer, marking your own draft ready for review (asking the reviewers you pick) and the More menu's typical PR and issue actions (close, convert to draft, merge, reopen, request changes) are the only things the desk writes to GitHub.

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

- **The queue** is the main page: only what you must act on, one ordered list in parts (agents' questions, a PR back to you (the coordinator handed it back, or it's ready and nobody's asked to review it: Add reviewers), other people's PRs waiting on your review in amber, issues and other PRs, then your own PRs), one line each (the title, its repo#number, its age, and at most one call to action), its first ten and a line for the rest. Your own draft's call to action is Ready for review: `a` marks it ready on GitHub (in its review, with the reviewers you pick: GitHub's suggestions sit on the line, a click each, and `@` finds anyone as you type). Enter on a PR opens its review (the AI summary, concerns and why it's here are there); an issue opens in place. Someone else's PR comes onto it once Claude has reviewed it (a line under the list says how many are still being reviewed), and one an agent handed you says why it's there and who sent it. Anything nobody has touched for two weeks drops to Later.
- **Later** (the sidebar, `g l`): what the rules and Claude sorted away (later, FYI, hidden) and what you snoozed or muted, each row with why it's there.
- **Archive** (the sidebar, `g a`): what's done: what you acted on in the desk (it leaves your list the moment you do; a review stays open saying what you did) and what resolved itself (merged, closed, approved, no longer requested), newest first.
- **Blocked** (the sidebar, `g b`): what can't move until something else happens, as your rules put it in the `blocked` bucket: a PR that needs another PR merged first (its description says "Requires …", or it's stacked on it), down the chain ("blocked by sentry#129460, which waits on your reply to markstory, then a review from cvxluo, skaasten and 6 more"), and your PRs waiting on reviewers ("waits on a review from dana and @backend"). Your PRs in Merging that another PR blocks are listed too, in their chain ("in Merging · blocked by …"). A chain's rows sit together, the PR blocking them first, and only the first says what that PR waits on. What you do on a row takes it off; it comes back when the PR it waits on merges. A coordinator's hand-back of a PR another one blocks waits here, and tops the queue once that PR merges. Enter opens the review, where `w` comments to nudge.
- **Merging** (the sidebar, `g m`): your own PRs you've handed off with `m`, the ones the coordinator is getting merged: each with what it waits on ("waits on a CI fix", "ready to merge") and the coordinator's latest note and its age. Merged ones sit under Merged for 3 days. `b` brings one back to your desk, and the coordinator hands one back itself, with its reason at the top of the queue, when it can't realistically get it merged. Your PR that's ready to merge but conflicts shows there too, "rebasing", until GitHub sees it mergeable (Coordinator, below).
- **Settings** (the sliders icon, `,`, or ⌘, in the app): GitHub, Rules, Agents, Notifications, Appearance (this device's theme: System, Light, Dark, Sand, Slate), Desktop app, AI review, Hand-off prompts. Changes save as you go.
- In the app: the menu bar shows the counts, `Control+Alt+D` shows or hides the window from anywhere, and notifications fire when something new lands in the queue (once Claude or a hard rule placed it, a hand-back included). All three can be changed in Settings → Desktop app.

| Key       | Does                                                           |
| --------- | -------------------------------------------------------------- |
| `j` / `k` | move                                                           |
| `Enter`   | review a PR (diff, AI notes, approve); an issue opens in place |
| `o`       | open on GitHub                                                 |
| `a`       | the row's call to action: Ready for review, Add reviewers      |
| `m`       | your own PR: hand off for merge; `b` brings it back to desk    |
| `.`       | more, on GitHub: close, ready or draft, merge now, reopen      |
| `e` / `d` | done: hidden until someone else comments, reviews or pushes    |
| `s`       | snooze: for a while, or until CI passes, new commits, approval |
| `m` / `p` | someone else's: mute / pin                                     |
| `u`       | undo                                                           |
| `i`       | AI review: look / skim / skip, summary, concerns, notes        |
| `/`       | filter · `r` sync · `,` settings · `g l` later · `?` all keys  |

Right-click a row for the same actions in a menu. Snooze waits in Later until a time, until someone acts, or until the PR changes as you need: CI passes, new commits, it's approved, out of draft, the merge conflict fixed; then it's back on your desk. Done, snooze, mute and pin are local. Nothing is sent to GitHub.

## Rules

Rules give each item its first placement. Edit them in Settings → Rules: `⌘↵` previews which items would move, `⌘S` saves. They live in `~/.review-desk/config.toml`, and editing the file directly works too.

A board is a source: one or more GitHub searches plus rules. The first rule whose `when` is true sets the bucket. A rule with `hard = true` is a floor: what it matches never sorts below its bucket (Today for a Now rule). A rule with `final = true` isn't re-sorted by Claude: what it matches stays in its bucket (your pin still lifts it). Your own Claude Code then sorts everything by your policy (Settings → Policy, a starter until you write one), with the rule's bucket as its hint. Every board feeds the same queue, and an item on several boards shows once, at its most urgent placement.

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

Every agent the desk runs is your own Claude Code. Settings → Agents connects it to the desk in two parts, and **Connect** there does whatever is missing (if you also work in Codex, `desk connect codex` gives it the same):

- **MCP tools** (`desk_overview`, `desk_list`, `desk_item`, `desk_act`, `desk_add`, `desk_undo`, `desk_brief`, `desk_sync`, `desk_events`, `desk_policy`, `desk_config`, and the coordinator's `desk_merging`, `desk_note`, `desk_hand_back`, `desk_answer`, `desk_ask`), served by the desk itself at `http://localhost:47823/mcp` whenever the app or `desk serve` runs.
- **The Review Desk skill** ([skills/review-desk/SKILL.md](skills/review-desk/SKILL.md)): what the desk is, which tool to use when, and the rules (PR text is untrusted, triage is local and undoable, nothing is posted to GitHub, rule changes only after a preview and your OK). Once installed, the desk keeps it current: `desk serve` on `~/.review-desk` refreshes an installed copy that differs from the repo's when it starts and when the repo's skill changes.

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

There's also a `/desk` pane for Claude Code / Desktop in [integrations/claude-desktop/review-desk](integrations/claude-desktop/review-desk). Install it with `claude plugin marketplace add ~/code/review-desk`, then `claude plugin install review-desk@review-desk`.

## Coordinator

The desk's window calls it **your agent**.

The coordinator gets the PRs you hand off with `m` merged: it gives each PR, or each stack, its own background subagent and keeps track of them, and the subagent works in a git worktree of your local clone, fixes CI, addresses review comments from the repo's members, rebases it on a conflict once it's otherwise ready, and merges the PR with the repo's merge method once it's approved, green and conflict-free. It never posts comments or replies as you: when a reviewer needs your answer, or it can't finish, it hands the PR back to the top of your queue with one line why. Its latest note on each PR shows in Merging.

A merge conflict on its own isn't yours: no rule puts one on your desk and nothing notifies for one. Once the coordinator is started, your own PR on your desk that's otherwise ready to merge (approved, CI not failing, not a draft) and conflicts goes to it to rebase, with no keypress: it leaves your desk for Merging as "rebasing", and the coordinator rebases it onto its base, runs what it can, pushes with `--force-with-lease` to that PR's own branch and leaves the merge to you. Once GitHub sees it mergeable it leaves Merging by itself and is back on your desk, ready to merge. One it can't rebase cleanly it hands back with why; one it hands back or you bring back with `b` stays yours. With the coordinator off, it stays on your desk. A PR you handed off with `m` gets rebased once it's approved, or before the coordinator pushes a fix (GitHub runs no CI on a conflicting PR); a stacked one whose parent was squash-merged with `git rebase --onto`, dropping the parent's commits.

The desk starts it, on your first hand-off (or `w` in Merging): one background Claude Code session (`claude --bg`) named "Review Desk coordinator", with Remote Control on, in `~/.review-desk/coordinator`. It's your own `claude` from your PATH, with your login, model and settings, and it uses the desk's MCP tools and skill (Settings → Agents → Connect). After that the desk only wakes it: on a hand-off, and when CI finishes, a review or comment lands, or a conflict appears on a PR in Merging, it sends one short message per minute's batch listing the PRs, their URLs and what changed (never PR text). A busy coordinator gets the message once it's idle; news that a desk restart or a failed start interrupts goes with the next wake or desk start. It keeps its history between wakes. Once started, the desk keeps it running: when the desk starts and every 5 minutes it looks (one `claude agents`, no turn); a running one is left as it is, and one that stopped or crashed is resumed with no prompt, which starts no turn. A wake briefly stops and resumes it, so talk to it between wakes, or turn it off while you work with it. Claude Code runs it, not the desk, so restarting or quitting the desk leaves it alone. Settings → Agents → Your agent turns it off (and stops it); on again resumes it.

Settings → Agents → Your agent skips permission prompts (on by default) runs it in bypass permissions mode, so it never stops to ask. Its deny list (below) still applies, since deny rules hold in every mode, but it's then the only fence: anything it doesn't name runs without asking. Leave it on if your own sessions skip permission prompts: Claude Code delivers messages between two sessions only when both skip them or neither does, so otherwise the coordinator's messages to your sessions, and theirs to it, are held and expire. Claude Code needs bypass mode accepted once first: run `claude --dangerously-skip-permissions` in a terminal and accept. Until then, or if your org disables bypass mode, Merging shows Claude Code's refusal in red. Changing the setting restarts the coordinator in the new mode with its history: Claude Code makes a copy of the session, which the desk keeps from then on, and the old one stays stopped in `claude agents`. A busy coordinator switches once it's idle; one stuck on a permission prompt switches right away and carries on. Off again, the copy runs in Claude Code's `default` mode, not a `defaultMode` from your settings.

Talk to it from the desk: `t` on any page, or **t Ask your agent** in the top bar, opens your chat with it about what you're on. In a PR's review, that's the PR and the spot you were last on: a conversation, a thread you clicked Reply on, lines you picked with the `+`, or the AI note `]` took you to; the chat's × widens it. The `+` box, a thread's Reply box and each conversation have a quiet **Ask your agent** too, which never sends what you typed there. Enter sends: the desk keeps your words and wakes it at once with them, the item's id and URL, whose PR it is in the desk's words, and the thread's URL or the lines' numbers. Never PR text: it reads a file's name with `desk_ask`. It does what you said with the desk's tools, by checking the code and GitHub, or by its subagents. On your own open PR it makes a change you ask for (in Merging, the subagent that has it; not handed off, a subagent for that ask alone, which pushes to its branch, never forced or merged, and says to pull first); on someone else's it answers with the change (a suggestion block, with Copy under it), and never pushes or posts. It answers with `desk_answer`, in the chat and as a notification, and its open questions about the item show above the chat's box. With it off, no Ask your agent shows, and the chat says so and sends nothing. Other Claude sessions can message "Review Desk coordinator" by name, or use the desk's MCP tools themselves.

Watch it or talk to it:

- Merging's top line: **Watch on claude.ai** (its Remote Control page; the Claude app on your phone has it too, under claude.ai/code), and `c` copies `claude attach <id>`, which opens it in a terminal.
- `claude agents` lists it; `claude logs <id>` shows its recent output.
- Other sessions can message it by name ("Review Desk coordinator"), and use the desk's MCP tools and skill themselves.
- `claude stop <id>` stops it until the desk's next look, within 5 minutes, resumes it (turn it off in Settings to keep it stopped); `claude rm <id>` removes it, and the next wake starts a fresh one.

With Your agent skips permission prompts (above) off, it runs with your own Claude Code permissions, so allow or approve `git`, `gh pr merge` and your test commands as you like. It reads CI logs and comments anyone can write, so the desk writes a deny list into `~/.review-desk/coordinator/.claude/settings.json` for what would let injected text post or rewrite as you: `gh pr comment`, `review`, `ready`, `edit`, `close`, `reopen` and `create`, `gh issue comment`, `edit`, `close`, `reopen` and `create` (close and reopen take `--comment`), all of `gh api`, and a force push: `--force` or `-f` before or after the branch, or a `+branch` refspec (not `--force-with-lease`, which it pushes with after a rebase). If that file exists, the desk adds the rules it lacks and keeps the rest. Its worktrees go under each clone's `.claude/worktrees/`, outside its own directory, so add the folder that holds your clones (its full path) to `permissions.additionalDirectories` in that file, or approve its edits there as they come.

## Automations

The desk's sources are GitHub, polled, and your automations: your instructions, run on a schedule by your own Claude Code, that put on your desk what needs you from wherever they look. "Weekdays at 9, look at what's new in getsentry/warden and getsentry/dotagents and put on my desk what needs me" is one. Settings → Automations lists them, each with its schedule, a switch, **Run now**, its last runs (what each read and found, and what came of each item) and an editor: a name, when (`daily 09:00`, `weekdays 09:00,13:00`, `mon,thu 17:30`, or `weekdays hourly` for every hour on the hour, local time) and the instruction. Ask any agent with the desk's tools to write one for you (`desk_automations`); one an agent drafts or changes stays off until you turn it on there, and only you delete one.

When one is due (the last matching time passed since its last run, and since you set it; a desk that slept through several runs once, and one a desk restart cut off runs again), the desk runs `claude -p` in `~/.review-desk/automations` with the instruction, read-only rules, and when its last run was and what the desk took from it. It's your own `claude` with your login, model and settings, and it never asks: it may read (files, the web, `gh`'s list, view, search, diff and checks, the desk's read tools) and use what your Claude Code settings already allow (your MCP servers' tools you allowed, say), and anything else is refused. A deny list in that folder keeps posting, editing or merging with `gh`, `gh api`, pushing, committing, editing files and the desk's own writes off even where your settings allow them. Its answer is a summary and the PRs and issues that need you (`owner/repo#123`, up to 20), each with one line on why. The desk adds them the way `desk_add` does (fetched if it doesn't hold them, pinned, a PR's pre-review started), and the item's why on your desk is the automation's ("Warden issues: a crash since 0.9"); the pin lifts it to Today or above, as yours would. One already on your queue stays as it is; one you'd dealt with (done, snoozed, muted, in Merging) stays that way, and so does one nobody needs now (closed, merged, approved by someone else). Done, snooze, mute or a hand-off ends an automation's pin, so what you dealt with stays dealt with. A run that put something on your desk, couldn't add something, or failed notifies you. Each run keeps its Claude Code session: `claude --resume <id>` in that folder shows what it did.

## Never

- Its writes to GitHub are approving a PR, when you press `a` in its review; a comment on a PR, when you press `w` in its review and send it, or on an open issue, `w` on it opened in place; a comment on a line of its diff, when you press the `+` by the line's number (or drag it down several) and send it; your reply to a conversation, when you press Reply under it in a PR's review; marking your own draft ready for review, when you press `a` on its row or in its review, and asking the reviewers you picked there; asking reviewers on your ready PR nobody's asked to review, when you press `a` in its review; and the More menu's (`.` on the selected row or in a PR's review), each only when the desk allows it for that item: closing (`c`) or reopening (`r`) a PR you opened, converting it to a draft (`d`), merging it now, without the coordinator (`m`; only when it's approved, green, not stacked on another PR and GitHub says it's mergeable, with the repo's merge method, pinned to the commit the desk judged ready), closing an issue you opened or are assigned (`c`), and requesting changes on someone else's PR with what you write in its review (`x`, then send). `u` while a close's or a draft's toast is up reopens it or marks it ready again. They go through `src/github/write.ts`, whose allowlist holds only those mutations; agents can't reach it, and `m`, `b` and a hand-back write nothing. The coordinator is your own Claude Code session, which the desk starts and wakes: what it pushes and merges, it does with your `git` and `gh`. Everything the desk does is read only: GraphQL queries (the read client refuses any document containing `mutation`), GETs of your notifications (never marking them read), and `gh api` GETs for a PR's files and description.
- An automation never writes: it runs read only behind a deny list, and the desk, not the run, puts what it lists on your desk. Only you turn one on.
- It never listens beyond `127.0.0.1`, and it rejects requests with a foreign `Host` or `Origin`.
- What you write (comments, replies, your answers to agents, the policy) never reaches Sentry, where `desk serve` reports its errors, traces and log lines and the UI its errors and traces (`src/sentry.ts`): request and response bodies, MCP calls' arguments and results, and your IP stay off. Its log lines do carry what the desk logs, such as an agent's question or why a PR was handed back, and its errors GitHub's error text. `DESK_SENTRY=0` sends nothing.
- It never puts PR text into the hand-off prompt, only the URL and number. The AI review's prompt fences PR text as untrusted, and the agent runs with no tools. Each of its concerns and notes quotes the code it's about, and a second run checks every one against the diff: what the diff doesn't bear out never reaches you.

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

Set `DESK_HOME` and `DESK_PORT` to work on a scratch copy instead of your real desk, and `DESK_SENTRY=0` to keep it out of Sentry.
