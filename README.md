# Review Desk

A desktop app that turns your GitHub review load into one queue: what needs you **now**, what's for **today**, and everything else sorted away by rules you control. It never writes to GitHub.

Runs on macOS, Linux and Windows.

## Start

You need Node 22.18 or newer (`node -v`) and a logged-in GitHub CLI (`gh auth status`). The `claude` CLI is only needed for briefs.

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

- **The queue** is the whole app. **Now** is marked with a highlighter, **Today** is below it, and a single "Sorted away" line counts what the rules filed as later, FYI, hidden or cleared. Click a count to look inside.
- Every item says **why** it's there ("vaind asked you directly", "CI failing"). Open it to see which rule placed it.
- **Settings** (the sliders icon, `,`, or ⌘, in the app): GitHub, Rules, Notifications, Desktop app, Briefs, Hand-off prompts. Changes save as you go.
- In the app: the menu bar shows the counts, `Control+Alt+D` shows or hides the window from anywhere, and notifications fire when something new lands in Now. All three can be changed in Settings → Desktop app.

| Key | Does |
|---|---|
| `j` / `k` | move |
| `Enter` | open an item: facts, why, rule trace |
| `o` | open on GitHub |
| `e` | done: hidden until someone else comments, reviews or pushes |
| `s` | snooze: 1h, 3h, tomorrow, Monday, or until activity |
| `m` / `p` | mute / pin |
| `u` | undo |
| `c` | copy a review prompt to paste into a Claude session |
| `i` | brief: ask Claude whether the PR needs you (look / skim / skip) |
| `/` | filter · `r` sync · `,` settings · `g r` rules · `?` all keys |

Done, snooze, mute and pin are local. Nothing is sent to GitHub.

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
- **Fields** (listed next to the editor and by `desk fields`): `item.*`, `pr.*` (ci, review, mergeable, size, threads), `me.*` (requested directly or via a team or CODEOWNERS, your review, `pushed_since_review`, `new_activity`), `author.*` (bot, `engaged_90d`, `close`), `repo.*`.
- **Buckets**: `now`, `today`, `later`, `fyi`, `hide`. Hidden items stay visible under "Sorted away".
- `{close_authors}` in a query expands to the people you review most.

The first run writes a starting config: one space for the org with most of your open items, plus Personal for the rest.

## Agents

The CLI and the MCP server talk to the running desk.

```bash
desk ls                 # Now and Today in the terminal; `--all` for the rest
desk show seer#8463     # why it's there, with the rule trace
desk done seer#8463     # also: snooze, mute, pin, restore, undo, sync, prompt, brief
desk settings           # list settings; `desk settings set github.poll_seconds 120`
desk status --short     # "desk ●2 ◐8", for a status line
```

`bin/desk` is the CLI (`bin/desk.cmd` on Windows). To use `desk` from anywhere, link it onto your PATH: `ln -sf ~/code/review-desk/bin/desk ~/.local/bin/desk`.

MCP for Claude Code (tools `desk_overview`, `desk_list`, `desk_item`, `desk_act`, `desk_undo`, `desk_brief`, `desk_sync`):

```bash
claude mcp add --scope user review-desk -- ~/code/review-desk/bin/desk mcp
```

For Codex, add this to `~/.codex/config.toml`, with the absolute path to your checkout:

```toml
[mcp_servers.review-desk]
command = "/Users/you/code/review-desk/bin/desk"
args = ["mcp"]
```

There's also a `/desk` pane for Claude Code / Desktop in [integrations/claude-desktop/review-desk](integrations/claude-desktop/review-desk). Install it with `claude plugin marketplace add ~/code/review-desk`, then `claude plugin install review-desk@review-desk`.

## Never

- It never writes to GitHub. It only runs GraphQL queries (the client refuses any document containing `mutation`), plus one read-only `gh api` GET for a brief's diff.
- It never listens beyond `127.0.0.1`, and it rejects requests with a foreign `Host` or `Origin`.
- It never puts PR text into the hand-off prompt, only the URL and number. The brief prompt fences PR text as untrusted.

## Files

| | |
|---|---|
| `~/.review-desk/config.toml` | spaces, boards, rules |
| `~/.review-desk/settings.json` | settings you changed from the default |
| `~/.review-desk/desk.db` | cache and your local state (SQLite) |
| [CLAUDE.md](CLAUDE.md) | where each kind of change goes |
| [docs/architecture.md](docs/architecture.md) | modules, API, CLI, MCP, desktop app |
| [docs/ui.md](docs/ui.md) | the UI |

## Develop

```bash
npm run app:dev     # the app with hot reload; restarts on src/ or electron/ changes
npm run dev         # server + Vite in a browser at :5173
npm test            # node:test, no network
npm run typecheck
npm run smoke:app   # launches the app on a scratch home and checks it end to end
```

Set `DESK_HOME` and `DESK_PORT` to work on a scratch copy instead of your real desk.
