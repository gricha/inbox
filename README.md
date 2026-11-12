# Inbox

A desktop app that turns your GitHub review load into one queue. It shows only what you need to act on, one line each, in order. Your rules, and your agent weighing them, sort everything else away.

- **Review in the desk.** A click on a PR opens its diff with an AI summary, concerns and notes on the changes. One click approves it, and it leaves your list at once.
- **Hand off your own PRs.** **Hand off for merge** gives a PR to the coordinator, a background agent session the desk starts. It fixes CI, addresses review comments and merges once the PR is approved and green. It hands the PR back to your Inbox only when it can't.
- **Your agent, your login.** Every agent run is your own Claude Code, Codex or OpenCode.
- **Writes only on your click.** The desk writes to GitHub only when you click a button that says so. See [Safety](#safety).

Runs on macOS, Linux and Windows.

## Start

```bash
curl -fsSL https://raw.githubusercontent.com/gricha/inbox/main/install.sh | bash
```

On macOS and Linux, that one command:

- installs the app from the latest release: `/Applications/Inbox.app`, or `~/.local/bin/Inbox.AppImage` on Linux. It updates itself from then on. Until there's a release (or with `bash -s -- --source`), it installs from source in `~/.local/share/inbox`, which needs Node 22.18+ and git;
- signs you in to GitHub with the GitHub CLI (`gh auth login`), offering to install `gh` with Homebrew;
- puts `desk` in `~/.local/bin` and that on your PATH (not with Linux's AppImage: there `npm install -g @gricha/inbox` brings it);
- opens Inbox;
- run by Claude Code, Codex or OpenCode (ask it to install Inbox with that command), installs Inbox's MCP tools and skill in that agent and picks it as yours. Start a new session of it to use them.

Run it again to update. On Windows, run the installer from [Releases](https://github.com/gricha/inbox/releases).

**The first open** is one page: GitHub, signed in as you or what to run, and your agent. Claude Code, Codex and OpenCode each say whether they're installed and logged in, or the command that gets them there. Press **Use Claude Code** (or yours): that installs Inbox's MCP tools and skill in it, and you're on your Inbox while the first sync runs, about 30 seconds. Settings → Agent changes it later; `desk setup` does the same from a terminal.

Every agent run is your own CLI, on your own login.

Without the app, from npm: the server, the web UI at <http://localhost:47823> and the `desk` CLI.

```bash
npm install -g @gricha/inbox
desk serve --open
```

From a checkout:

```bash
npm install
npm run app
```

The app runs the desk server itself; if one is already running on port 47823 (`desk serve`), the app attaches to it.

To build an installable app for the current OS into `release/` (a `.dmg`, an AppImage, or a Windows installer):

```bash
npm run dist     # or dist:mac, dist:linux, dist:win
```

The macOS build is ad-hoc signed and not notarized: the first time, right-click the app → Open (`install.sh` clears the quarantine flag, so it opens directly).

**Coming from Review Desk?** Quit Review Desk.app and delete it, or its login item keeps starting it (Inbox removes the old Linux autostart entry itself). Inbox keeps your window, theme and settings, and moves `~/.review-desk` to `~/.inbox` on first start, leaving a link at the old path.

## Use it

The sidebar has four pages, plus **Ask your agent** and **Settings** in its footer.

- **Inbox**: what needs you, in three sections, **Urgent**, **Standard** and **FYI** (see [Urgency](#urgency)). Each row is one line: the title, why it's there, who it's from, its age and at most one call to action, such as Ready for review on your draft or Merge on your PR that's ready. Agents' questions and sessions that need you lead Urgent. Someone else's PR arrives once its AI review is done. Anything untouched for two weeks drops to FYI.
- **Blocked**: your PRs that can't move yet, such as one that needs another PR merged first, or one waiting on reviewers. Each says what it waits on, down the chain. It comes back to your Inbox when that changes.
- **Merging**: your PRs the coordinator is getting merged, each with what it waits on and the coordinator's latest note. Merged ones stay for 3 days. **Back to desk** takes one back.
- **Archive**: what's done (by you, or resolved by GitHub: merged, closed, approved), then what you snoozed or muted and what your rules hid.
- **Settings** (⌘, in the app): Inbox and notifications, Agent, Your automations, Urgency, This device (theme, shortcut, menu bar count), then GitHub (account, searches and rules, the AI review, its automations). Changes save as you go.

Everything is a click. A row opens its review (an issue opens in place). Right-click a row for Done, Snooze, Close on GitHub and Copy link. Platform keys still work: Esc goes back, ⌘↵ sends what you wrote, ⌘S saves an editor, Tab moves between controls.

**Snooze** hides an item in the Archive until a time, until someone acts, or until the PR changes as you need: CI passes, new commits, approved, out of draft, conflict fixed. Done, snooze, mute and pin are local; nothing goes to GitHub.

Problems with the desk itself (offline, a failed sync, your agent logged out, broken rules, an action GitHub refused) show as a bubble at the window's bottom right.

In the app: the menu bar shows the Inbox's count (macOS), `Control+Alt+D` (Control+Option+D on a Mac) shows or hides the window from anywhere, and a notification fires when something new lands in your Inbox.

More on each page: [docs/ui.md](docs/ui.md).

## Rules

Rules give each item its first placement. Edit them in Settings → GitHub → Searches and rules: **Preview changes** shows what would move, **Save** saves. They live in `~/.inbox/config.toml`, which you can also edit directly.

A **board** is one or more GitHub searches plus rules. The first rule whose `when` is true sets the bucket. Then your agent (the judge) sorts everything, weighing every rule that matches with its weight, plus your automations' sorts and criteria. An item on several boards shows once, at its most urgent placement.

- `weight = 8`: how much your agent counts the rule, 0 to 10 (5 unless set). 9 or 10 is your firm default, under 3 a hint. GitHub's rules carry their own: a review asked of you by name weighs 9, a team ping 5.
- `hard = true`: a floor. What it matches never sorts below its bucket.
- `final = true`: your agent doesn't re-sort it (your pin still lifts it).

To change how something sorts, add or reweigh a rule, or ask your agent to.

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

- **Expressions**: `&& || ! == != < <= > >= in matches`, plus `len() lower() contains() startswith() any(list, "glob*")`. An unknown field is an error with a suggestion.
- **Fields**: `item.*`, `pr.*`, `me.*`, `author.*`, `repo.*`. The full list is beside the editor and in `desk fields`.
- **Buckets**: `now`, `today`, `blocked`, `later`, `fyi`, `hide`. Only rules fill `blocked`. Hidden items are in the Archive under "Hidden by rules".
- `{close_authors}` in a query expands to the people you review most.

The first run writes a starting config: one space for the org with most of your open items, plus Personal. Its boards name GitHub's built-in rule sets (`builtin = "review"`, `"mine"`, `"mentions"`, `"issues"`, `"collaborators"`) instead of copying them, so a release that improves them reaches you. Your file holds only your changes:

```toml
builtin = "review"
off = ["your-repo"]                                                   # GitHub's rules you switched off
rules = [
  { when = "'ml' in item.labels", bucket = "now", why = "ML" },        # yours come first
  { id = "bot-pr", when = "author.bot", bucket = "fyi", why = "bot" }, # replaces GitHub's bot-pr
  { after = "stacked", when = "pr.ci == 'pending'", bucket = "later" }, # right after GitHub's stacked
]
```

Searches and rules lists the built-in rules with a switch each. Details: [docs/api.md → Rules](docs/api.md#rules-built-in-and-your-own).

## Connect your agent

Settings → Agent picks the agent that sorts your desk, writes AI reviews and runs the coordinator: **Claude Code**, **Codex** (run `codex login` once) or **OpenCode** (`opencode auth login`, or a provider key in your environment).

The agent needs two things from the desk. Settings → Agent says if either is missing, and **Connect** there adds it.

- **MCP tools**, served by the desk at `http://localhost:47823/mcp` while the app or `desk serve` runs. The list: [docs/api.md → MCP tools](docs/api.md#mcp-tools).
- **The Inbox skill** ([skills/inbox/SKILL.md](skills/inbox/SKILL.md)): what the desk is, which tool to use when, and its rules. The desk keeps installed copies up to date.

| Agent       | MCP tools                                                                       | Skill copied to                    |
| ----------- | ------------------------------------------------------------------------------- | ---------------------------------- |
| Claude Code | `claude mcp add --transport http --scope user inbox http://localhost:47823/mcp` | `~/.claude/skills/inbox/`          |
| Codex       | `codex mcp add inbox --url http://localhost:47823/mcp`                          | `~/.agents/skills/inbox/`          |
| OpenCode    | `opencode mcp add inbox --url http://localhost:47823/mcp`                       | `~/.config/opencode/skills/inbox/` |

The same from a terminal:

```bash
desk connect            # what Claude Code is missing, and the commands that fix it
desk connect --apply    # do it
desk connect codex      # or: desk connect opencode
```

Clients that only speak stdio can run `desk mcp`. Connecting from another machine: [Use it from another machine](#use-it-from-another-machine).

**A `/desk` pane for Claude Code**: your Inbox beside the chat, with its count as a status line. Install it with `claude plugin marketplace add ~/code/review-desk`, then `claude plugin install inbox@inbox`, and type `/desk` in a new session. (Had it as `review-desk`? Run `claude plugin uninstall review-desk@review-desk` and `claude plugin marketplace remove review-desk` first.)

## The CLI

`desk` (`bin/desk`, or `bin/desk.cmd` on Windows) talks to the running desk. To use it from anywhere, link it onto your PATH:

```bash
ln -sf ~/code/review-desk/bin/desk ~/.local/bin/desk
```

```bash
desk ls                       # your Inbox; --all adds blocked, later and FYI
desk show seer#8463           # why it's there, with the rule trace
desk add getsentry/seer#8463  # put it on your desk, pinned, and start its AI review
desk add getsentry/seer#8463 "your call on the retry budget" --from "seer retry fix"  # with the line it shows as why
desk done seer#8463           # also: snooze, mute, pin, restore, undo
desk sync                     # sync with GitHub now
desk settings                 # list settings; `desk settings set review.auto_ai false`
desk status --short           # "desk 10 +2" (10 on your Inbox, 2 new), for a status line
desk render review.json       # a review document as one HTML page (docs/review-format.md)
```

`desk help` lists every command. Routes, tools and types: [docs/api.md](docs/api.md).

## Use it from another machine

Over [Tailscale](https://tailscale.com), for you alone. On the desk's computer, turn on Settings → This device → **Use it from your other devices** (or run `desk serve --tailscale`).

- The desk runs `tailscale serve`, so it answers at `https://<this machine's tailnet name>/` on your tailnet only, never on the internet (no `tailscale funnel`). It stops serving when you turn the setting off or the desk stops.
- It needs Tailscale signed in, with MagicDNS and HTTPS certificates on. The setting says what's missing.
- Only your own Tailscale login gets in (More → Tailscale login allowed changes whose), and only from a device you paired.

Pair a device with a one-time code (10 minutes, one try):

```bash
desk pair            # on the desk's computer
```

- **A browser** (phone, laptop): open the link it prints, `https://<name>/pair#<code>`.
- **Another machine with an Inbox checkout**: `bin/desk connect https://<name> --code <code>` (add `codex` or `opencode`). It pairs and connects that machine's agent.
- **A machine without a checkout**: run `desk pair --print` on the desk's computer and paste the commands it prints. They carry a token: treat it as a password.
- **Codex and OpenCode** read the token from `INBOX_TOKEN`; the commands above print the `export` line.
- **stdio clients and the CLI**: `DESK_URL=https://<name> DESK_TOKEN=<token> desk mcp` (or any `desk` command).

Settings → This device lists paired devices; **Revoke** shuts one out at once. The desk's own computer needs no token. How requests are checked: [docs/api.md → Security model](docs/api.md#security-model).

## Coordinator

The coordinator gets the PRs you hand off merged. The window calls it **your agent**.

For each PR (or stack) it starts a subagent that works in a git worktree of your local clone. The subagent fixes CI, addresses review comments from the repo's members, rebases on a conflict, and merges with the repo's merge method once the PR is approved, green and conflict-free. It never posts comments or replies as you. When a reviewer needs your answer, or it can't finish, it hands the PR back to the top of your Inbox with one line why. Its latest note on each PR shows in Merging.

**Conflicts.** A merge conflict alone never lands on your desk. Your PR that's otherwise ready to merge (approved, CI not failing, not a draft) but conflicts goes to the coordinator to rebase. It shows in Merging as "rebasing", is pushed with `--force-with-lease`, and comes back to your desk ready to merge. With the coordinator off, it stays on your desk.

**How it runs.** The desk starts it on your first hand-off or ask (or **Start it now** in Merging), then only wakes it: at once for your asks, and once a minute with news on PRs in Merging (CI finished, a review or comment, a conflict). Wakes carry PR ids, URLs and what changed, never PR text. The desk checks every 5 minutes that it's still running and resumes it if not. Settings → Agent → **Run your agent** turns it off and on.

- **Claude Code**: one background session (`claude --bg`) named "Inbox coordinator", in `~/.inbox/coordinator`, with Remote Control on. It's your own `claude`, with your login, model and settings. Claude Code runs it, so quitting the desk leaves it running. If Claude Code hasn't trusted that folder, Merging says so: run `claude` there once and accept.
- **Codex**: one Codex thread; each wake is a `codex exec resume` turn the desk runs and waits on. A desk restart stops a turn in progress. Codex reads the deny list only in a trusted folder, so add `[projects."<that folder>"]` with `trust_level = "trusted"` to `~/.codex/config.toml` (Merging says so). With Let your agent run without asking off, it runs in Codex's workspace-write sandbox and hands back what needs a push.
- **OpenCode**: one OpenCode session, run as the desk's own `inbox-desk` agent whose bash rules hold the deny list. OpenCode has no sandbox. With Let your agent run without asking off, whatever your OpenCode config would ask about is refused.

Switching agents keeps each one's session. Details for each: [docs/api.md → The coordinator](docs/api.md#the-coordinator).

**Permissions.** Settings → Agent → **Let your agent run without asking** (on by default) runs it without permission prompts. The deny list still applies, but it's then the only fence. Leave it on if your own sessions skip permission prompts: Claude Code passes messages between two sessions only when both skip them or neither does. Claude Code needs bypass mode accepted once: run `claude --dangerously-skip-permissions` and accept. Until then, or if your org disables it, Merging shows the refusal in red.

With it off, the coordinator uses your own Claude Code permissions, so allow `git`, `gh pr merge` and your test commands as you like. Its worktrees go under each clone's `.claude/worktrees/`, so add the folder holding your clones to `permissions.additionalDirectories` in `~/.inbox/coordinator/.claude/settings.json`, or approve its edits as they come.

**The deny list.** The coordinator reads CI logs and comments anyone can write. So the desk writes a deny list into `~/.inbox/coordinator/.claude/settings.json` that blocks what would let injected text post or rewrite as you: `gh pr` comment, review, ready, edit, close, reopen and create; `gh issue` comment, edit, close, reopen and create; all of `gh api`, and force pushes (not `--force-with-lease`). The desk adds missing rules and keeps the rest of that file.

**Talk to it.** **Ask your agent** in the sidebar opens a chat about what you're looking at: in a PR's review, the PR and the spot you were on (a conversation, a thread, or lines you picked with `+`). It acts with the desk's tools. On your own open PR it can push a change you ask for (never forced or merged). On someone else's it answers with a suggestion and never pushes or posts. It replies in the chat and as a notification. More: [docs/ui.md → Asking your agent](docs/ui.md#asking-your-agent).

To watch it:

- Merging's top line: **Watch on claude.ai** (its Remote Control page, also in the Claude phone app) and **Copy attach command** (`claude attach <id>`, `codex resume <id>` or `opencode --session <id>`).
- `claude agents` lists it; `claude logs <id>` shows recent output.
- `claude stop <id>` stops it until the desk's next check (within 5 minutes); turn it off in Settings to keep it stopped. `claude rm <id>` removes it; the next wake starts a fresh one.
- Other sessions can message it by name ("Inbox coordinator") or use the desk's MCP tools themselves.

## Urgency

Every item on your Inbox gets a score out of 10. The score and your **criteria** put it in a section.

- A **criterion** is a yes-or-no about an item: a rule (`when`, free and exact) or a question your model answers (`ask`, such as "Is it about service accounts?"). A yes raises the score. An **urgent** criterion's yes puts the item in Urgent whatever its score, even one your rules hid.
- Tell your agent what you care about ("I care about PRs about service accounts") and it saves a criterion. Criteria only order your Inbox; they never act on an item.
- Settings → Urgency lists yours and GitHub's (Asked by name, which counts 3 points, Waiting on your reply, and the urgent ones: Ready to merge, Your PR others wait on, Handed back), each with a switch.
- Your agent scores 20 items a call, with the one-line why your row shows. With a decision model key (Settings → Agent → More), that model scores instead. Before a model answers, or with Score the Inbox off, the desk scores from the rules and criteria.
- Urgent is 8 or more, FYI 3 or less (Settings → Inbox and notifications). A review asked of you by name, or your pin, never goes below Standard.
- Every answer is kept in `~/.inbox/labels.jsonl`, to train a cheaper model later.

Details: [docs/api.md → Urgency](docs/api.md#urgency).

## Automations

An automation is an instruction the desk runs for you, on a schedule or on events, that puts on your desk what needs you. For example: "Weekdays at 9, look at what's new in getsentry/warden and put on my desk what needs me."

**Built in.** GitHub comes with some, listed in Settings → GitHub, each with a switch. **Copy to your automations** makes an editable copy.

- On by default (no model): **Pick a reviewer** (your ready PR, a workday with nobody asked by name), **Follow up on silent reviewers** (two workdays of silence), **Team reviews someone else took** (to FYI), **Wide team pings** (asked of four or more teams: hidden).
- Off by default: **Snooze while CI is red** and **Questions in mentions** (a model spots a question for you).

**Yours.** Settings → Your automations lists them, with when each runs, its last run, **Run now** and a switch. Open one to edit it. Ask any agent with the desk's tools to write one (`desk_automations`). One an agent writes or changes stays off until you turn it on, and only you can delete one.

**When it runs.**

- A schedule: `daily 09:00`, `weekdays 09:00,13:00`, `mon,thu 17:30`, or `weekdays hourly`, local time. A run missed while the desk slept runs once.
- Or events from the desk's event log (a review asked of you, new commits, CI changing, a comment, a merge, …). It runs once for the items the events landed on, up to 20 at a time.
- A **check** (`when`, written like a rule) filters items first. Items that fail it never reach a model.

**How it decides.** Pick the cheapest that works:

- **A rule** calls no model: every item that passes the check gets its one action.
- **A question** is one model call without tools: for each item, what to do, or nothing.
- **An agent** is your own Claude Code (or Codex, or OpenCode) with read-only tools, for what needs a deeper look. It runs in `~/.inbox/automations` (`claude -p` for Claude Code) and never asks: a deny list blocks posting, pushing, editing files and the desk's own writes, even where your settings allow them. **Copy resume command** on a run reopens its session.

**What it may do.** By default it only adds items to your desk, pinned, with its own why. You can allow more (`can`): sort to Today, Later or FYI, hide, snooze, mark done, mute. It never sorts into Now or Blocked. Your hard rules, `final` rules and pins bind it. What it adds, it adds once, until something about the item changes. Every action carries its name and undo takes it back. It never touches a review asked of you by name, your pin or a PR your agent handed back.

**Decision model.** By default your agent answers questions. With an OpenRouter key (Settings → Agent → More; `typesafe/jev-1.14` by default), each item is one request to OpenRouter's Decisions API, and the desk acts only when it's at least 80% sure. The item's facts then leave your computer for OpenRouter (never the AI review or its files). The key lives in `~/.inbox/secrets.json`.

A run that added something, couldn't, or failed notifies you. When a question's model can't answer (logged out, out of credits), the run waits and tries again in half an hour. Details: [docs/api.md → Automations](docs/api.md#automations).

## Safety

**What the desk writes to GitHub**, each only on your click and only through `src/github/write.ts`:

- Approve, in a PR's review.
- Comment on a PR or an open issue, and comment on a line of a diff (the `+` by the line).
- Reply under a conversation in a PR's review.
- Ready for review on your draft (asking the reviewers you picked), and Ask reviewers on your ready PR.
- Merge on your PR's row, when it's approved (or needs no review), green, not a draft, not stacked and mergeable. It uses the repo's merge method, pinned to the commit the desk checked.
- The More menu, when the desk allows it for that item: close, reopen, convert to draft or merge your PR, or re-request review from who reviewed it; request changes on someone else's, or take yourself off its reviewers; close an issue you opened or are assigned. The toast's Undo reopens or marks ready again.

Everything else is read-only: GraphQL queries, GETs of your notifications (never marking them read) and of a PR's files. Agents can't reach the writer. Hand off for merge, Back to desk and hand-backs write nothing. The coordinator pushes and merges with your own `git` and `gh`.

**What it never does:**

- It never listens beyond `127.0.0.1`, and rejects a foreign `Host` or `Origin`. Only with Use it from your other devices on does anything else reach it, through `tailscale serve`, from your login, on a paired device.
- An automation never writes. The desk acts on what it lists, only as you allowed. Only you turn one on.
- Nothing about your items goes to a model other than your own agent, unless you set a decision model key (see [Automations](#automations)).
- PR text never goes into the coordinator's wakes, only URLs and numbers. The AI review fences PR text as untrusted and runs with no tools. Each concern quotes the code it's about, and a second pass drops any the diff doesn't bear out.
- What you write (comments, replies, answers, your rules) never reaches Sentry, where the desk reports its errors and traces. Request bodies, MCP arguments and your IP stay off. Log lines can carry what the desk logs (an agent's question, a hand-back's reason). `DESK_SENTRY=0` sends nothing.

## Files

|                                                |                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| `~/.inbox/config.toml`                         | spaces, boards, rules                                            |
| `~/.inbox/settings.json`                       | settings you changed from the default                            |
| `~/.inbox/secrets.json`                        | the decision model key                                           |
| `~/.inbox/desk.db`                             | cache and local state (SQLite), and paired devices' token hashes |
| `~/.inbox/docs/`                               | review documents                                                 |
| [AGENTS.md](AGENTS.md)                         | where each kind of change goes                                   |
| [docs/api.md](docs/api.md)                     | behaviour, HTTP routes, MCP tools, security model                |
| [docs/architecture.md](docs/architecture.md)   | modules, CLI, MCP, desktop app                                   |
| [docs/ui.md](docs/ui.md)                       | what each page does and says                                     |
| [docs/visual.md](docs/visual.md)               | the mark, colours, layout, and how a design change is checked    |
| [docs/review-format.md](docs/review-format.md) | review documents (`inbox.review/1`)                              |
| [docs/effect.md](docs/effect.md)               | error handling                                                   |
| [docs/vision.md](docs/vision.md)               | where Inbox is going                                             |
| [docs/plugins.md](docs/plugins.md)             | a small core with sources as plugins: what's built, what's next  |

## Develop

```bash
npm run app:dev     # the app from this checkout: src/ restarts the desk, web/ hot-reloads, electron/ restarts the app
npm run dev         # server + Vite in a browser at :5173
npm test            # node:test, no network
npm run check       # what CI runs: format, type-aware lint, CSS lint, types, dead code, tests
npm run smoke:app   # launches the app on a scratch home and checks it end to end
npm run shots       # screenshots of every key state, light and dark and each theme (.shots/index.html)
npm run icons       # every icon (app, tray, favicon) from assets/brand/mark.svg
```

A pre-commit hook formats and lints staged files. A pre-push hook runs `npm run check`, and CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs it on macOS, Linux and Windows.

Set `DESK_HOME` and `DESK_PORT` to work on a scratch desk, and `DESK_SENTRY=0` to keep it out of Sentry. Where to make a change: [AGENTS.md](AGENTS.md).

## Release

GitHub Actions is blocked by billing, so for now releases are built and published from a Mac:

```bash
npm run release 0.2.4             # on a clean main: sets the version, commits and tags v0.2.4; pushes nothing
npm run release:publish v0.2.4    # builds every platform from the tag, pushes main and the tag, publishes the Release
```

[scripts/release-publish.sh](scripts/release-publish.sh) checks out the tag in a worktree under `.claude/worktrees/`, runs `npm run check`, and builds macOS (arm64 and Intel), Windows (installer and zip) and Linux (AppImage and tar.gz) with electron-builder, which cross-builds from macOS with no Docker or Wine. Then it pushes main up to the tag, and `gh release create` publishes one GitHub Release with every build, the `latest*.yml` files the updater reads, and notes generated from the commits since the last release. It needs `gh` logged in with write access to `gricha/inbox`, and refuses a tag that's already released.

- `npm run release:publish v0.2.4 -- --build-only` builds into `release/` and stops: nothing is pushed or published.
- Nothing is signed: macOS is ad-hoc signed and not notarized, and Windows shows a SmartScreen warning on first run.
- The Windows and Linux builds are made on the Mac and not run there: try one on a real machine when their packaging changes.

[.github/workflows/release.yml](.github/workflows/release.yml) does the same on a tag push once Actions runs again; until then it fails at its first job. When it works, go back to `git push origin main v0.2.4` and stop using `release:publish`, or the two race to create the Release.

**Updates.** The packaged app checks the latest release every 6 hours with your GitHub token (the repo is private). When there's a newer one, the sidebar's footer says so:

- **Update to 0.2.0** where the app can install it (the Linux AppImage, the Windows installer): it downloads, quits and restarts.
- **Download 0.2.0** elsewhere, including macOS (the ad-hoc signed build can't self-update): download the `.dmg`, drag Inbox over the old one, and open it (right-click → Open the first time).

A desk run from a checkout (`npm run app`, `desk serve`, Run from a checkout) never checks.

**npm.** `npm publish` from the tagged commit ships `@gricha/inbox`: `prepack` compiles `src/` to `lib/` (Node won't run TypeScript from `node_modules`) and builds the web UI. An npm install has no Sentry SDK, so it reports nothing.
