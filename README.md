# Inbox

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

Had it as Review Desk, before the rename to Inbox? Quit Review Desk.app and delete it before you next log in: its login item starts it (on macOS and Windows; Inbox removes the old Linux autostart entry itself), and nothing deletes it for you. Inbox carries over its window, theme and settings, and moves `~/.review-desk` to `~/.inbox` on its first start, leaving a link at the old path for anything that still looks there.

The app runs the desk server itself. If one is already running on port 47823 (`desk serve`), the app attaches to it.

## Use it

- **Inbox** is the main page: what's on your desk in three sections, **Urgent**, **Standard** and **FYI**, each ordered by a score out of 10 and each row saying quietly why it's there (Urgency, below). Agents' questions and sessions that need you lead Urgent; within a section, after the score, the desk's order: a PR back to you a PR back to you (the coordinator handed it back, as its row says, or it's ready and nobody's asked to review it: Add reviewers), other people's PRs waiting on your review, issues and other PRs, then your own PRs. One line each (the title, its repo#number, why it's there, its age, and at most one call to action); Standard and FYI show their first ten and a line for the rest. Your own draft's call to action is Ready for review: it marks it ready on GitHub (in its review, with the reviewers you pick: GitHub's suggestions sit on the line, a click each, and the box finds anyone as you type). A click on a PR opens its review (the AI summary, concerns and why it's here are there); an issue opens in place. Someone else's PR comes onto it once Claude has reviewed it (a line under the list says how many are still being reviewed), and one an agent handed you says why it's there and who sent it. Anything nobody has touched for two weeks drops to FYI.
- **Blocked** (the sidebar): your own PRs that can't move until something else happens, as your rules put them in the `blocked` bucket (the first-run rules fill it only from My PRs; someone else's blocked PR is sorted like any other, and a review asked of you is yours to give whatever its PR waits on): a PR of yours that needs another PR merged first (its description says "Requires …", or it's stacked on it), down the chain ("blocked by sentry#129460, which waits on your reply to markstory, then a review from cvxluo, skaasten and 6 more"), and your PRs waiting on reviewers ("waits on a review from dana and @backend"). Your PRs in Merging that another PR blocks are listed too, in their chain ("in Merging · blocked by …"). A chain's rows sit together, the PR blocking them first, and only the first says what that PR waits on. What you do on a row takes it off; it comes back when the PR it waits on merges. A coordinator's hand-back of a PR another one blocks waits here, and tops the Inbox once that PR merges. A click opens the review, where you can comment to nudge.
- **Merging** (the sidebar): your own PRs you've handed off, the ones the coordinator is getting merged: each with what it waits on ("waits on a CI fix", "ready to merge") and the coordinator's latest note and its age. Merged ones sit under Merged for 3 days. Back to desk brings one back to your desk, and the coordinator hands one back itself, with its reason, at the top of your Inbox, when it can't realistically get it merged. Your PR that's ready to merge but conflicts shows there too, "rebasing", until GitHub sees it mergeable (Coordinator, below).
- **Archive** (the sidebar): what's done: what you acted on in the desk (it leaves your list the moment you do; a review stays open saying what you did) and what resolved itself (merged, closed, approved, no longer requested), newest first; then, each under its own heading, what you snoozed or muted and what your rules hid. Last in the sidebar, under Merging.
- **Settings** (the sidebar, or ⌘, in the app): its parts are the sidebar's items while you're in it, under the way back to the Inbox: Inbox and notifications, Agent (connecting it, sorting by your policy, your agent), Your automations (your instructions on a schedule or on events), Urgency (your criteria, and GitHub's), This device (its theme: System, or a light one (Light, Sand, Solarized, Catppuccin Latte, Sentry Dawn, Rose Pine, Flexoki Light) or a dark one (Dark, Slate, Sentry Dusk, Gruvbox, Tokyo Night, Everforest, Kanagawa, Nord), or on a machine running Omarchy, Omarchy, which follows its theme as it switches; and the desktop app's), then under a hairline GitHub (your account, its searches and rules, the AI review, under More the sync interval, bots and what `desk prompt <ref>` prints, and the automations it comes with). Changes save as you go.
- In the app: the menu bar shows the Inbox's count (macOS), `Control+Alt+D` (Control+Option+D on a Mac) shows or hides the window from anywhere, and notifications fire when something new lands in your Inbox (once Claude or a hard rule placed it, a hand-back included). The shortcut and the menu bar's count are in Settings → This device, notifications in Settings → Inbox and notifications.

Everything is a click. A row opens its review (an issue opens in place); a right-click on any row opens its menu: Done, Snooze, Close on GitHub where it can be closed, and Copy link. A review's buttons and More do the rest. The keys that stay are the platform's: Esc closes and goes back, ⌘↵ sends what you wrote, Enter sends in the chat, ⌘S saves an editor, Tab moves between rows and buttons.

Snooze waits in the Archive until a time, until someone acts, or until the PR changes as you need: CI passes, new commits, it's approved, out of draft, the merge conflict fixed; then it's back on your desk. Done, snooze, mute and pin are local. Nothing is sent to GitHub.

## Rules

Rules give each item its first placement. Edit them in Settings → GitHub → Searches and rules: Preview changes (⌘↵) shows which items would move, Save (⌘S) saves. They live in `~/.inbox/config.toml`, and editing the file directly works too.

A board is a source: one or more GitHub searches plus rules. The first rule whose `when` is true sets the bucket. A rule with `hard = true` is a floor: what it matches never sorts below its bucket (Today for a Now rule). A rule with `final = true` isn't re-sorted by Claude: what it matches stays in its bucket (your pin still lifts it). Your own agent (Claude Code, or Codex: Settings → Agent) then sorts everything by your policy (Settings → Agent → Your policy, a starter until you write one), with the rule's bucket as its hint. Every board feeds the same desk, and an item on several boards shows once, at its most urgent placement.

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

The first run writes a starting config: one space for the org with most of your open items, plus Personal for the rest. Its boards don't copy GitHub's rules: each names the set GitHub comes with for it (`builtin = "review"`, `"mine"`, `"mentions"`, `"issues"`, `"collaborators"`), which the desk reads from its code, so a release that improves one reaches your desk. Your file holds only what's yours:

```toml
builtin = "review"
off = ["your-repo"]                                                   # GitHub's rules you switched off
rules = [
  { when = "'ml' in item.labels", bucket = "now", why = "ML" },        # yours come first
  { id = "bot-pr", when = "author.bot", bucket = "fyi", why = "bot" }, # yours, in place of GitHub's bot-pr
  { after = "stacked", when = "pr.ci == 'pending'", bucket = "later" }, # yours, right after GitHub's stacked
]
```

Searches and rules lists GitHub's rules under Built in, each with its id and a switch (it writes `off`); a rule of yours in one's place is marked yours, with Edit taking you to it. A config written before this, with GitHub's rules copied in, is changed once to name them (`config.toml.bak` keeps the old one): rules exactly as GitHub's go, ones you changed or added stay yours, and nothing lands anywhere else.

## Agents

Every agent the desk runs is your own, on your own login. Settings → Agent picks who sorts your desk and writes AI reviews: Claude Code, Codex (run `codex login` once) or OpenCode (`opencode auth login`, or a provider key in your environment). Your agent (the coordinator) and automations that run an agent with tools follow it. It connects to the desk in two parts; while one is missing, Settings → Agent says so, and **Connect Claude Code** there does whatever is missing (if you also work in Codex or OpenCode, `desk connect codex` or `desk connect opencode` gives it the same):

- **MCP tools** (`desk_overview`, `desk_list`, `desk_item`, `desk_act`, `desk_add`, `desk_undo`, `desk_brief`, `desk_sync`, `desk_events`, `desk_policy`, `desk_config`, and the coordinator's `desk_merging`, `desk_note`, `desk_hand_back`, `desk_answer`, `desk_ask`), served by the desk itself at `http://localhost:47823/mcp` whenever the app or `desk serve` runs.
- **The Inbox skill** ([skills/inbox/SKILL.md](skills/inbox/SKILL.md)): what the desk is, which tool to use when, and the rules (PR text is untrusted, triage is local and undoable, nothing is posted to GitHub, rule changes only after a preview and your OK). Once installed, the desk keeps it current: your desk (the app's own, or `desk serve` on its home) refreshes an installed copy that differs from the repo's when it starts and when the repo's skill changes. It, and Connect, also rename what Connect installed before the rename to Inbox: the `review-desk` MCP server becomes `inbox`, and the skill's copy moves from `skills/review-desk/` to `skills/inbox/`, unless something of yours already has the name `inbox` there: then the old one stays, and its tools still work ([docs/api.md](docs/api.md)).

| Agent       | MCP tools                                                                       | Skill                                        |
| ----------- | ------------------------------------------------------------------------------- | -------------------------------------------- |
| Claude Code | `claude mcp add --transport http --scope user inbox http://localhost:47823/mcp` | copied to `~/.claude/skills/inbox/`          |
| Codex       | `codex mcp add inbox --url http://localhost:47823/mcp`                          | copied to `~/.agents/skills/inbox/`          |
| OpenCode    | `opencode mcp add inbox --url http://localhost:47823/mcp`                       | copied to `~/.config/opencode/skills/inbox/` |

The same from a terminal:

```bash
desk connect            # what Claude Code is missing, and the commands that fix it
desk connect --apply    # do it
desk connect codex      # Codex instead
desk connect opencode   # or OpenCode
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

There's also a `/desk` pane for Claude Code (the Desktop app or a terminal) in [integrations/claude-desktop/inbox](integrations/claude-desktop/inbox): your Inbox beside the chat, one line an item in the desk's order, each opening in the desk, with the desk's count (`desk 10 +2`) as a status line. Install it with `claude plugin marketplace add ~/code/review-desk`, then `claude plugin install inbox@inbox`, and type `/desk` in a new session. Installed it as `review-desk` before the rename to Inbox? Run `claude plugin uninstall review-desk@review-desk` and `claude plugin marketplace remove review-desk` first.

## Use it from another machine

Over [Tailscale](https://tailscale.com), for you alone. On the desk's computer, turn on Settings → This device → **Use it from your other devices** (or run `desk serve --tailscale`). The desk then runs `tailscale serve` in the background, so it answers at `https://<this machine's tailnet name>/` over HTTPS on your tailnet (never `tailscale funnel`, so never on the internet), and turns it off again with the setting or when the desk stops. It needs Tailscale signed in, with MagicDNS and HTTPS certificates on for your tailnet; the setting's row says in plain words what's missing. Only your own Tailscale login gets in (another person on your tailnet doesn't; More → Tailscale login allowed in changes whose), and only from a device you paired:

```bash
desk pair            # on the desk's computer: a one-time code (10 minutes, one try), and what to do with it
```

- **A browser** (a phone, a laptop): open the link it prints, `https://<name>/pair#<code>`. That browser keeps a session and lands on your Inbox.
- **Another machine with an Inbox checkout**: `bin/desk connect https://<name> --code <code>` (add `codex` or `opencode` for those). It pairs the machine and gives its Claude Code the desk's MCP tools (over HTTP, with the machine's token) and the skill.
- **A machine without one**: run `desk pair --print` on the desk's computer instead, and paste the commands it prints there. They carry a token: treat it as a password.
- **Codex** and **OpenCode** read the token from `INBOX_TOKEN`: `desk connect … codex` (or `opencode`) and `desk pair --print` print the `export` line for your shell's profile.
- **stdio-only clients and the CLI**: `DESK_URL=https://<name> DESK_TOKEN=<token> desk mcp` (or any `desk` command).

Settings → This device lists every paired device, with when it was last used; **Revoke** shuts it out at once. On this computer nothing changes: no token, as before. How each request is checked: [docs/api.md](docs/api.md) → Security model.

## Coordinator

The desk's window calls it **your agent**.

The coordinator gets the PRs you hand off for merge merged: it gives each PR, or each stack, its own background subagent and keeps track of them, and the subagent works in a git worktree of your local clone, fixes CI, addresses review comments from the repo's members, rebases it on a conflict once it's otherwise ready, and merges the PR with the repo's merge method once it's approved, green and conflict-free. It never posts comments or replies as you: when a reviewer needs your answer, or it can't finish, it hands the PR back to the top of your Inbox with one line why. Its latest note on each PR shows in Merging.

A merge conflict on its own isn't yours: no rule puts one on your desk and nothing notifies for one. Once the coordinator is started, your own PR on your desk that's otherwise ready to merge (approved, CI not failing, not a draft) and conflicts goes to it to rebase, on its own: it leaves your desk for Merging as "rebasing", and the coordinator rebases it onto its base, runs what it can, pushes with `--force-with-lease` to that PR's own branch and leaves the merge to you. Once GitHub sees it mergeable it leaves Merging by itself and is back on your desk, ready to merge. One it can't rebase cleanly it hands back with why; one it hands back or you bring back with Back to desk stays yours. With the coordinator off, it stays on your desk. A PR you handed off for merge gets rebased once it's approved, or before the coordinator pushes a fix (GitHub runs no CI on a conflicting PR); a stacked one whose parent was squash-merged with `git rebase --onto`, dropping the parent's commits.

The desk starts it, on your first hand-off or ask (or **Start it now** in Merging): one background Claude Code session (`claude --bg`) named "Inbox coordinator", with Remote Control on, in `~/.inbox/coordinator`. It's your own `claude` from your PATH, with your login, model and settings, and it uses the desk's MCP tools and skill (Settings → Agent → Connect Claude Code). After that the desk only wakes it: at once with your asks, on a hand-off, and when CI finishes, a review or comment lands, or a conflict appears on a PR in Merging, it sends one short message per minute's batch listing the PRs, their URLs and what changed (never PR text). A busy coordinator gets the message once it's idle; news that a desk restart or a failed start interrupts goes with the next wake or desk start. It keeps its history between wakes. Once started, the desk keeps it running: when the desk starts and every 5 minutes it looks (one `claude agents`, no turn); a running one is left as it is, and one that stopped or crashed is resumed with no prompt, which starts no turn. A wake briefly stops and resumes it, so talk to it between wakes, or turn it off while you work with it. Claude Code runs it, not the desk, so restarting or quitting the desk leaves it alone. Turning off Settings → Agent → Run your agent stops it; on again resumes it. After the desk's home moved from `~/.review-desk` (its folder before the rename to Inbox), the session from the old folder can't be resumed: the desk stops it, and the next wake starts a fresh one in `~/.inbox/coordinator`. If Claude Code hasn't trusted that folder (or one above it), Merging says so in claude's words until you run `claude` there once and accept.

With Codex chosen (Settings → Agent), your agent is one Codex session instead: the desk starts it with `codex exec --json` in `~/.inbox/coordinator` and keeps the thread it names as its id, and each wake is one `codex exec resume --json <id> "<message>"` turn the desk runs and waits on, one at a time (what lands meanwhile goes when it ends); Merging says busy while a turn runs and idle between, with no claude.ai link, and **Copy attach command** copies `codex resume <id>`. Codex has no background daemon, so a desk restart stops a turn in progress. With Let your agent run without asking on it runs with `--dangerously-bypass-approvals-and-sandbox`; off, in Codex's workspace-write sandbox with network and no approvals, which writes only in its folder and temp dirs (not your clones, and never a `.git`), so it can merge and read but hands back what needs a push. None of your MCP servers load but the desk's. The deny list's leading-word rules (`gh pr comment`, `gh api`, `git push --force`, …) are written as forbidden Codex rules in `.codex/rules/inbox.rules`, which Codex reads only in a folder you trust, so it doesn't start until `~/.codex/config.toml` has `[projects."<that folder>"]` with `trust_level = "trusted"` (Merging says so); the rules that match a flag after the branch (`git push origin x --force`, `+x`) have no Codex form. Switching agents keeps each one's session: the next wake goes to the chosen agent's, started if it has none.

With OpenCode chosen, it's the same shape: `opencode run --format json` in `~/.inbox/coordinator` starts its session, each wake is `opencode run --session <id> "<message>"`, and **Copy attach command** copies `opencode --session <id>`. OpenCode has no sandbox. The desk runs it as its own agent (`inbox-desk`, in the config it passes in `OPENCODE_CONFIG_CONTENT`) whose bash rules deny the whole deny list, flags after the branch included, with none of your MCP servers but the desk's. With Let your agent run without asking on it passes `--auto`, so what your OpenCode config says to ask about is approved; off, nobody is there to answer, so that's refused.

Settings → Agent → Let your agent run without asking (on by default) runs it in bypass permissions mode, so it never stops to ask. Its deny list (below) still applies, since deny rules hold in every mode, but it's then the only fence: anything it doesn't name runs without asking. Leave it on if your own sessions skip permission prompts: Claude Code delivers messages between two sessions only when both skip them or neither does, so otherwise the coordinator's messages to your sessions, and theirs to it, are held and expire. Claude Code needs bypass mode accepted once first: run `claude --dangerously-skip-permissions` in a terminal and accept. Until then, or if your org disables bypass mode, Merging shows Claude Code's refusal in red. Changing the setting restarts the coordinator in the new mode with its history: Claude Code makes a copy of the session, which the desk keeps from then on, and the old one stays stopped in `claude agents`. A busy coordinator switches once it's idle; one stuck on a permission prompt switches right away and carries on. Off again, the copy runs in Claude Code's `default` mode, not a `defaultMode` from your settings.

Talk to it from the desk: **Ask your agent** in the sidebar opens your chat with it about what you're on. In a PR's review, that's the PR and the spot you were last on: a conversation, a thread you clicked Reply on, or lines you picked with the `+`; the chat's × widens it. The `+` box, a thread's Reply box and each conversation have a quiet **Ask your agent** too, which never sends what you typed there. Enter sends: the desk keeps your words and wakes it at once with them, the item's id and URL, whose PR it is in the desk's words, and the thread's URL or the lines' numbers. Never PR text: it reads a file's name with `desk_ask`. It does what you said with the desk's tools, by checking the code and GitHub, or by its subagents. On your own open PR it makes a change you ask for (in Merging, the subagent that has it; not handed off, a subagent for that ask alone, which pushes to its branch, never forced or merged, and says to pull first); on someone else's it answers with the change (a suggestion block, with Copy under it), and never pushes or posts. It answers with `desk_answer`, in the chat and as a notification, and its open questions about the item show above the chat's box. With it off, no Ask your agent shows, and the chat says so and sends nothing. Other Claude sessions can message "Inbox coordinator" by name, or use the desk's MCP tools themselves.

Watch it or talk to it:

- Merging's top line: **Watch on claude.ai** (its Remote Control page; the Claude app on your phone has it too, under claude.ai/code), and **Copy attach command** copies `claude attach <id>`, which opens it in a terminal.
- `claude agents` lists it; `claude logs <id>` shows its recent output.
- Other sessions can message it by name ("Inbox coordinator"), and use the desk's MCP tools and skill themselves.
- `claude stop <id>` stops it until the desk's next look, within 5 minutes, resumes it (turn it off in Settings to keep it stopped); `claude rm <id>` removes it, and the next wake starts a fresh one.

With Let your agent run without asking (above) off, it runs with your own Claude Code permissions, so allow or approve `git`, `gh pr merge` and your test commands as you like. It reads CI logs and comments anyone can write, so the desk writes a deny list into `~/.inbox/coordinator/.claude/settings.json` for what would let injected text post or rewrite as you: `gh pr comment`, `review`, `ready`, `edit`, `close`, `reopen` and `create`, `gh issue comment`, `edit`, `close`, `reopen` and `create` (close and reopen take `--comment`), all of `gh api`, and a force push: `--force` or `-f` before or after the branch, or a `+branch` refspec (not `--force-with-lease`, which it pushes with after a rebase). If that file exists, the desk adds the rules it lacks and keeps the rest. Its worktrees go under each clone's `.claude/worktrees/`, outside its own directory, so add the folder that holds your clones (its full path) to `permissions.additionalDirectories` in that file, or approve its edits there as they come.

## Urgency

Every item on your Inbox gets a score out of 10, and the score and your **criteria** put it in a section. A criterion is a yes-or-no about an item: a rule (`when`, in the rules' language: free and exact) or a question your model answers (`ask`: "Is it about service accounts?", asked only of the items its rule lets through, and again only when the item or the question changes). A yes counts toward the score; an **urgent** one's yes puts the item in Urgent whatever its score, even one the rules hid. Tell your agent what you care about ("I care about PRs about service accounts") and it saves one with `desk_criteria`, on at once: a criterion only orders your Inbox and never acts on an item. Settings → Urgency lists yours and GitHub's (asked by name, waiting on your reply, ready to merge, and urgent: your PR others wait on, handed back), each with a switch.

The score weighs where your rules put the item and your criteria's answers. Claude gives it, 20 items a call, with a one-line why your row shows; with a decision model key (Settings → Agent → More), that model does; with Score the Inbox off, or before a model has answered, the desk scores from the rules and the yeses, so a fresh desk sections at once. Urgent is a score of 8 or more, FYI 3 or less (Settings → Inbox and notifications); what the rules or an automation sort to FYI stays there, and a review asked of you by name or your pin never goes below Standard. A hand-back is always urgent. Every answer is kept in `~/.inbox/labels.jsonl`, the data a cheaper model can be taught this from.

## Automations

GitHub comes with a few, so a new desk works with no config: Settings → GitHub lists them under its settings, each with a switch and one line on what it does, and you only switch them (to change one, **Copy to your automations** makes it yours, off, to edit). On from the start, each a rule that calls no model: **Pick a reviewer** puts your ready PR on your desk once it's waited a workday with nobody asked by name; **Follow up on silent reviewers** does once the people you named have been silent two workdays (neither for a PR that's blocked on another still open); **Team reviews someone else took** sorts a review asked of your team, not of you by name, to FYI once someone else has reviewed it; **Wide team pings** hides a review asked of four or more teams at once; neither touches a PR that changes code you work on (`pr.my_area`), which your policy sorts. Off until you turn them on: **Snooze while CI is red** (your PR, until CI passes) and **Questions in mentions** (a model reads a mention and puts it on your desk when someone asks you something). They run as yours do, under the same limits: none touches a review asked of you by name, your pin or a PR your agent handed back, what each does carries its name, and undo takes it back. A new release may change what one does, and that just takes effect; your switch stays as you left it.

The desk's sources are GitHub, polled, and your automations: your instructions, run on a schedule by your own Claude Code, that put on your desk what needs you from wherever they look. "Weekdays at 9, look at what's new in getsentry/warden and getsentry/dotagents and put on my desk what needs me" is one. Settings → Your automations lists them, each with when it runs in words ("Mon and Thu at 17:30") and its last run, **Run now** while it's on and a switch (one an agent wrote or changed has **Review** instead, which opens it), and its name opens it: its instruction, what starts it, its check, how it decides and what it may do in plain words, its last runs (what each read and found, and what came of each item) and an editor: a name, what starts it (a schedule: `daily 09:00`, `weekdays 09:00,13:00`, `mon,thu 17:30`, or `weekdays hourly` for every hour on the hour, local time; or events to tick), its check, how it decides, and the instruction with what it may do, or a rule's one action. Ask any agent with the desk's tools to write one for you (`desk_automations`); one an agent drafts or changes stays off until you turn it on there, and only you delete one.

When one is due (the last matching time passed since its last run, and since you set it; a desk that slept through several runs once, and one a desk restart cut off runs again), the desk runs `claude -p` in `~/.inbox/automations` with the instruction, read-only rules, and when its last run was and what the desk took from it. It's your own `claude` with your login, model and settings, and it never asks: it may read (files, the web, `gh`'s list, view, search, diff and checks, the desk's read tools) and use what your Claude Code settings already allow (your MCP servers' tools you allowed, say), and anything else is refused. A deny list in that folder keeps posting, editing or merging with `gh`, `gh api`, pushing, committing, editing files and the desk's own writes off even where your settings allow them. Its answer is a summary and the PRs and issues that need you (`owner/repo#123`, up to 20), each with one line on why. The desk adds them the way `desk_add` does (fetched if it doesn't hold them, pinned, a PR's pre-review started), and the item's why on your desk is the automation's ("Warden issues: a crash since 0.9"); the pin lifts it to Today or above, as yours would. One already in your Inbox stays as it is; one you'd dealt with (done, snoozed, muted, in Merging) stays that way, and so does one nobody needs now (closed, merged, approved by someone else). Done, snooze, mute or a hand-off ends an automation's pin, so what you dealt with stays dealt with. A run that put something on your desk, couldn't add something, or failed notifies you. Each run keeps its Claude Code session: `claude --resume <id>` in that folder shows what it did, and **Copy resume command** on the run copies that.

With Codex chosen, a run is `codex exec --json --sandbox read-only` in that folder with only the desk's read tools: no shell, `gh` or web, since Codex has no way to allow `gh`'s reads and nothing else, and none of your MCP servers. Its session is kept, so **Copy resume command** copies `codex resume <id>`. With OpenCode chosen, the same tools and nothing else (every other permission denied): **Copy resume command** copies `opencode --session <id>`.

An automation can react instead of waiting for its time: in place of a schedule it has events, kinds from the desk's event log (a review asked of you, new commits, CI changing, a comment, a review, a merge and so on). When a sync brings one of them, the desk runs it once for the items those events landed on, each with what happened ("CI went from green to red"), up to 20 at a time. It never runs twice at once: what lands while it runs waits for the next run. Events from before you set it, or while it was off, aren't its news.

An automation can carry a check (`when`), written like a rule's (`me.requested_direct && pr.ci == 'red'`): the desk asks it before anything else, of its events' items or, on a schedule, of each open item on your desk, and hands the run only the ones that pass, fenced as untrusted text. With none, nothing runs and no model is called.

An automation decides what to do with those items in one of three ways, and the cheapest that can is the right one. **A rule** calls no model: every item its check passes gets its one action ("when CI goes red on a PR of mine, snooze it until CI passes"). **A question** is one model call without tools: it reads the items as the desk describes them and your instruction, and says for each what to do, or leaves it alone ("a ping to my whole team that isn't about the loader is FYI"). **An agent** is the run described above, your Claude Code with read-only tools, for what takes looking further than the item. A rule or a question on a schedule needs a check, since it's about items. What a rule or a question adds, it adds once: mark it done or unpin it and it stays off your desk until something about the item changes (a push, a review, a new request, someone's comment), so an hourly rule is a nudge and not a nag; and a rule that adds also brings back a PR you'd marked done, so "my PR, asked by name two weekdays ago and still no review: follow up" (`me.author && !item.draft && pr.asked_weekday_hours >= 48 && len(pr.reviewers) == 0`) finds the one that went to the Archive when you asked. Claude answers a question, unless you give the desk a decision model's key (Settings → Agent → More: an OpenRouter key, and which model, `typesafe/jev-1.14` by default): then each item is one small request to OpenRouter's Decisions API, a model that answers a typed question with probabilities instead of prose, and the desk acts only when it's at least 80% sure, leaving the item alone otherwise. With a key set, what a decision about an item needs leaves your computer for OpenRouter (its repo and number, title, labels, the people on it and who's asked, its state and CI, others' reviews, where it is on your desk and the start of its description; never the AI review or the files it touches); with none, nothing does. The key lives in `~/.inbox/secrets.json`, yours alone to read and kept out of `settings.json`, and only the desk's window sets it. A scheduled question asks only about what's new to it, so an hourly one doesn't ask about the same unchanged items every hour. When a question's model can't answer (Claude Code logged out or at its limit, the key refused or out of credits, OpenRouter failing or out of reach), the run waits instead of failing: nothing is spent, the same items are asked about half an hour later, and Automations says it's waiting and why.

An automation adds, and nothing else, unless you allow it more (`can`, which `desk_automations` sets and its view shows): sorting an item to Today, Later or FYI or hiding it, snoozing it, marking it done, muting it. Its run then says what to do with each item it lists, and the desk does it or refuses: a verb you didn't allow is refused, and the run's record says so. A sort is kept the way Claude's answer is: it holds until the item changes (new commits, a review, a new comment) or you act on the item, your hard rules' floors, `final` rules and your own pin bind it as they bind Claude, and the item's trace says "automation <its name>: fyi, <why>". It never sorts into Now or Blocked. A snooze, done or mute is the desk's own action, logged as the automation's: the item says why, and undo (or Back on the desk, Unmute) takes it back. The run's record says what it did by verb ("put 2 on your desk, sorted 3 to FYI, snoozed 1") and lists each item with what came of it and why.

## Never

- Its writes to GitHub are approving a PR, when you click Approve in its review; a comment on a PR, when you click Comment in its review, or on an open issue, Comment on it opened in place; a comment on a line of its diff, when you click the `+` by the line's number (or drag it down several) and send it; your reply to a conversation, when you click Reply under it in a PR's review; marking your own draft ready for review, when you click Ready for review on its row or in its review, and asking the reviewers you picked there; asking reviewers on your ready PR nobody's asked to review, when you click Ask reviewers in its review; and the More menu's (in a PR's review, or a row's right-click menu), each only when the desk allows it for that item: closing or reopening a PR you opened, converting it to a draft, merging it now, without the coordinator (only when it's approved, green, not stacked on another PR and GitHub says it's mergeable, with the repo's merge method, pinned to the commit the desk judged ready), closing an issue you opened or are assigned, and requesting changes on someone else's PR with what you write in its review. The toast's Undo, while a close's or a draft's toast is up, reopens it or marks it ready again. They go through `src/github/write.ts`, whose allowlist holds only those mutations; agents can't reach it, and Hand off for merge, Back to desk and a hand-back write nothing. The coordinator is your own Claude Code session, which the desk starts and wakes: what it pushes and merges, it does with your `git` and `gh`. Everything the desk does is read only: GraphQL queries (the read client refuses any document containing `mutation`), GETs of your notifications (never marking them read), and `gh api` GETs for a PR's files and description.
- An automation never writes: it runs read only behind a deny list, and the desk, not the run, acts on what it lists, only in the ways you allowed it (adding it to your desk, unless you allowed more). Only you turn one on.
- Nothing about your items goes to a model that isn't your own Claude Code, unless you set a decision model's key: then automations' questions send each item's facts to OpenRouter (Automations, above). The key stays in `~/.inbox/settings.json`; the desk never shows it again, logs it or sends it anywhere else.
- It never listens beyond `127.0.0.1`, and it rejects requests with a foreign `Host` or `Origin`. Only with Use it from your other devices on does anything else reach it: through `tailscale serve`, from your own Tailscale login, on a device you paired.
- What you write (comments, replies, your answers to agents, the policy) never reaches Sentry, where `desk serve` reports its errors, traces and log lines and the UI its errors and traces (`src/sentry.ts`): request and response bodies, MCP calls' arguments and results, and your IP stay off. Its log lines do carry what the desk logs, such as an agent's question or why a PR was handed back, and its errors GitHub's error text. `DESK_SENTRY=0` sends nothing.
- It never puts PR text into the hand-off prompt, only the URL and number. The AI review's prompt fences PR text as untrusted, and the agent runs with no tools. Each of its concerns and notes quotes the code it's about, and a second run checks every one against the diff: what the diff doesn't bear out never reaches you.

## Files

|                                              |                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| `~/.inbox/config.toml`                       | spaces, boards, rules                                                          |
| `~/.inbox/settings.json`                     | settings you changed from the default                                          |
| `~/.inbox/desk.db`                           | cache and your local state (SQLite), and your paired devices' token hashes     |
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

## Release

```bash
npm run release 0.2.0          # on a clean main: package.json at 0.2.0, committed and tagged v0.2.0, nothing pushed
git push origin main v0.2.0    # the tag starts the release workflow
```

[.github/workflows/release.yml](.github/workflows/release.yml) checks the tag is package.json's version and runs `npm run check`, builds macOS (arm64 and Intel), Linux and Windows with electron-builder, and publishes them as one GitHub Release with notes from the commits since the last one, beside the `latest*.yml` files the app's updater reads. One channel: the latest release that isn't a draft or prerelease.

The packaged app's desk checks the latest release every 6 hours with your GitHub token (the repo is private), and when there's a newer one, the sidebar's footer says so above Settings: **Update to 0.2.0** where the app installs it itself (the Linux AppImage and the Windows installer's install: it downloads, quits and starts the new build), **Download 0.2.0** elsewhere, which opens the release page. The macOS build is ad hoc signed, which macOS's updater won't take, so on a Mac it's the release page: download the `.dmg` for your Mac, drag Inbox over the old one, and open it (the first time, right-click → Open, since it isn't notarized). A desk run from a checkout (Run from a checkout, `npm run app`, `desk serve`) never checks: main is what runs there.
