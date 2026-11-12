# API

The desk server is the one process that owns your queue. The desktop app runs it, or `desk serve` does. It serves on `http://localhost:47823` (`DESK_PORT` changes the port):

- the web UI,
- a JSON API ([HTTP routes](#http-routes)),
- a server-sent events stream ([Events](#events)),
- an MCP endpoint at `/mcp` for agents ([MCP tools](#mcp-tools)).

The CLI, `desk mcp` and the web UI are all clients of it. Types live in [src/types.ts](../src/types.ts), the source of truth.

## Contents

- **Reference:** [The first run](#the-first-run) · [Connect an agent](#connect-an-agent) · [MCP tools](#mcp-tools) · [HTTP routes](#http-routes) · [Main types](#main-types) · [Events](#events)
- **Agents and models:** [Your own agent](#your-own-agent) · [The decision model](#the-decision-model-openrouter)
- **Reviews:** [The AI review](#the-ai-review) · [What reviewers said](#what-reviewers-said)
- **Sorting:** [Rules: built in and your own](#rules-built-in-and-your-own) · [The judge](#the-judge) · [Your areas](#your-areas) · [Urgency](#urgency)
- **Working for you:** [The coordinator](#the-coordinator) · [Asks](#asks) · [Sessions](#sessions) · [Automations](#automations)
- **Items:** [Stacks](#stacks) · [Dependencies](#dependencies) · [Adding](#adding) · [Resolved](#resolved) · [Opened for you](#opened-for-you)
- **Your PRs:** [Merging](#merging) · [Ready for review](#ready-for-review) · [Nobody's asked to review it](#nobodys-asked-to-review-it) · [The More menu](#the-more-menu)
- [Security model](#security-model)

## Connect an agent

Agents reach the queue over MCP. The desk serves it at `/mcp` whenever it runs, so there is nothing else to start.

### The first run

A desk that was never set up (no `config.toml` and nothing learned from GitHub yet) shows the window's first-run page instead of the Inbox, until GitHub is connected and you've picked your agent. A desk from before that page never shows it. The desk decides (`Desk.setupView()`, kv `setup`), so the window, `desk setup` and any client see the same state.

- **GitHub.** The first config is written from what GitHub says about you. When that fails (no `gh`, not logged in, offline), the desk still starts, without a config: `setup.github` says why and what to run, and every page's route answers 503 "GitHub isn't connected yet". Retry (`POST /api/setup/check`) asks again, writes the first config and syncs.
- **Your agent.** Each of Claude Code, Codex and OpenCode with whether its CLI is on PATH and logged in (its own status command, as the login check uses; asked at most every 30 seconds, and again on Retry), and what to run while it isn't. Picking one (`POST /api/setup`) sets `agent.harness` and runs Connect for it, installing the desk's MCP tools and skill in it (`picked`). The page is then done for good, or once GitHub is connected. It refuses an agent that isn't ready, with what to run.
- **The installer:** `install.sh` run by Claude Code, Codex or OpenCode (it reads `CLAUDECODE`, `CODEX_THREAD_ID`/`CODEX_SANDBOX`, `OPENCODE`; `INBOX_AGENT` names one or `none`) installs that agent's MCP tools and skill right away (`desk connect <agent> --apply`), then picks it once the desk answers (`desk setup <agent>`).
- **From a terminal:** `desk setup` asks both again and prints the same; `desk setup claude` (or `codex`, `opencode`) picks one.

Settings → Agent is where you change it afterwards.

### Your agent (Settings → Agent)

`agent.harness` picks your agent: `claude-code` (the default), `codex` or `opencode`. Every agent run the desk makes follows it ([Your own agent](#your-own-agent)), and so does Connect (`driverOf()` in `src/agents.ts`).

Settings → Agent shows a row when your agent lacks the desk's MCP tools or the Inbox skill ([skills/inbox/SKILL.md](../skills/inbox/SKILL.md)). **Connect &lt;agent&gt;** installs what's missing (`POST /api/agents/connect`); **Update the skill** shows when only the skill is out of date. When both are in place the row is gone. From a terminal:

```bash
desk connect                   # what Claude Code is missing, and the commands that fix it
desk connect --apply           # does it
desk connect codex             # Codex instead
desk connect opencode          # or OpenCode
```

| Agent       | Registered when                                                | Registers with                                                                  | Skill                                      |
| ----------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------ |
| Claude Code | `~/.claude.json`'s `mcpServers["inbox"]` is the desk's         | `claude mcp add --transport http --scope user inbox http://localhost:47823/mcp` | `~/.claude/skills/inbox/SKILL.md`          |
| Codex       | `~/.codex/config.toml`'s `[mcp_servers.inbox]` is the desk's   | `codex mcp add inbox --url http://localhost:47823/mcp`                          | `~/.agents/skills/inbox/SKILL.md`          |
| OpenCode    | `~/.config/opencode/opencode.json`'s `mcp.inbox` is the desk's | `opencode mcp add inbox --url http://localhost:47823/mcp`                       | `~/.config/opencode/skills/inbox/SKILL.md` |

`--scope user` makes Claude Code's entry work in every project; `claude mcp list` then shows `inbox: http://localhost:47823/mcp (HTTP) - ✔ Connected` while the desk runs. Codex reads user skills from `~/.agents/skills` ([Codex skills](https://developers.openai.com/codex/skills)).

**What Connect does**, in order, logging each step (`desk connect --apply` prints them):

1. Copies the skill, or refreshes a copy that differs from the repo's.
2. Registers the MCP server if it isn't registered.
3. Removes the old `review-desk` install: the `review-desk` MCP server when it's this desk's (`claude mcp remove --scope user review-desk`, `codex mcp remove review-desk`), and `skills/review-desk/` when it holds only the skill's own `SKILL.md`. Anything else there is yours and stays. A `review-desk` server at another desk's port is left for that desk.

**Keeping it current.** The owner's desk (home `~/.inbox`, `~/.review-desk` until that moves, or a link to either) refreshes each agent's installed skill when it starts and whenever the repo's `SKILL.md` changes, and does the same `review-desk` cleanup. It never installs a missing one. One agent's CLI failing (say, not on the desk's PATH) is logged, retried on the next start, and doesn't hold up the others. A desk on any other `DESK_HOME` (a scratch desk, tests) leaves agents alone.

**What counts as the desk's entry:** its `/mcp` on the desk's port (`localhost`, `127.0.0.1` or `[::1]`), or a stdio `desk mcp` (`bin/desk`, `bin/desk.cmd`, or node on the desk's `src/cli.ts`) aimed at the desk's port (its `DESK_PORT`, else the desk's, else 47823). A stdio `inbox` you added already counts; to switch it to HTTP, run `claude mcp remove inbox -s user` and Connect again.

**When the name is taken.** `inbox` is a common name, and a second desk wants it too. The desk counts as connected under any name whose entry is its own, and `mcp.name` says which. Otherwise Connect picks:

- **A desk's entry** (a loopback `/mcp`, or `desk mcp`) **whose desk doesn't answer** its `/health` within a second: it's left from a desk that's gone, and Connect replaces it (`claude mcp remove --scope user inbox && claude mcp add …`; OpenCode's add replaces).
- **A desk that answers:** it keeps `inbox`, and this desk goes in as `inbox-<port>` (then `inbox-<port>-2`, …).
- **Anything else of yours:** it keeps `inbox`, and the desk goes in as `inbox-desk` (then `inbox-<port>`).
- **A skill in `skills/inbox/` that isn't the desk's** (its front matter isn't `name: inbox` with `desk_list` and `desk_item` in it): the desk's goes in `skills/inbox-desk/` (then `inbox-desk-2`, …), its front matter named to match.

Nothing of yours is overwritten or removed. `note` says what was picked and why ("Connected as inbox-47998: your other desk keeps inbox"). The tools are `desk_*` under any server name.

### Any MCP client

- **Streamable HTTP** at `http://localhost:47823/mcp`. No auth and no session (no `Mcp-Session-Id`), `POST` only; `GET` and `DELETE` answer 405.
- **From another machine**, while the desk serves over Tailscale (README → Use it from another machine): `https://<tailnet name>/mcp` with `Authorization: Bearer <token>`. `desk connect <address> --code` or `desk pair --print` gives that machine its token.
- **stdio**: run `desk mcp` (the absolute path to `bin/desk` if it isn't on PATH; `bin/desk.cmd` on Windows). It serves the same tools and calls the running desk's HTTP API. Set `DESK_PORT` if the desk isn't on 47823, or `--url https://<tailnet name>` (or `DESK_URL`) with `DESK_TOKEN` for a desk on another machine; the token is only sent over https.

  ```bash
  claude mcp add --scope user inbox -- ~/code/review-desk/bin/desk mcp
  ```

- The old HTTP+SSE transport (2024-11-05) isn't served; use stdio for clients that only have that.

## MCP tools

The same tools over HTTP and stdio. Results are text, and most end with a JSON block. Errors come back as a tool result with `isError: true` and the API's message (`no item "nope#1" on the desk`, or `"sentry#1" matches 2 items — candidates: …`). Over stdio, a desk that isn't running gives `desk is not running — start it with: desk serve`. No tool writes to GitHub.

**`ref`** is any of:

- `owner/repo#123`, or `repo#123` when unique;
- a GitHub URL;
- the item's desk link: `inbox://item/owner/repo/123` (Copy link), or `http://localhost:<port>/#/review/<id>` or `#/item/<id>`.

A page's link (`inbox://blocked`), a question's link (`inbox://question/<id>`) or anything that names no item is refused in words (`src/links.ts`). The same holds for the CLI's `<ref>` and the routes' `id`.

| Tool               | Arguments                                                                                                                                                     | Returns                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desk_overview`    | none                                                                                                                                                          | Counts per space and board, Focus totals, sync status, config errors; JSON `Overview`. Read only                                                                                                                                                                                                                                                   |
| `desk_list`        | `board?` (omit or `"focus"` for Focus), `buckets?` (`now` `today` `blocked` `later` `fyi` `hide` `cleared`; default now, today), `limit?` (1–200, default 25) | One line per card: bucket, id, title, why, and "stack 3/20" with the PRs it stands for. Focus holds only now and today, a stack once, led by the sessions that need you (`session:<id>`). JSON of the cards. Read only                                                                                                                             |
| `desk_item`        | `ref`                                                                                                                                                         | Facts, bucket and why per board, the rule trace, the signals the judge weighs (and what its answer weighed), its stack, the AI review's verdict, summary and concerns, the hand-off prompt, and its `inbox://` link to give the owner; JSON `{ card, placements, judge, state }`. A `session:<id>` gives its `SessionCard`. Read only              |
| `desk_act`         | `ref`, `action` (`done` `snooze` `mute` `unmute` `pin` `unpin` `restore`), `until?` (snooze only; default `tomorrow`, or one of the card's `wake_on`)         | What changed and the undo `seq`; JSON `{ ok, state, undo_seq }`. On a session: done, snooze to a time, mute, unmute, restore                                                                                                                                                                                                                       |
| `desk_add`         | `ref` (`repo#123` only for an item the desk holds), `why` (one line, ≤300), `from` (your task, ≤60)                                                           | Adds and pins it ([Adding](#adding)): `added <id> to the user's desk, pinned`, its AI review's state, the undo `seq`, then the item as `desk_item` gives it                                                                                                                                                                                        |
| `desk_undo`        | `seq?` (default: the latest action from anyone)                                                                                                               | `undid <action> on <id>`. Can't undo a hand-off for merge or a Back to desk (the owner's to undo)                                                                                                                                                                                                                                                  |
| `desk_brief`       | `ref`                                                                                                                                                         | The PR's AI review: verdict, risk, summary, concerns and notes; JSON `AiReview`. Cached per commit; usually ready for PRs in Now and Today, otherwise a call to your agent (a minute or two)                                                                                                                                                       |
| `desk_doc`         | one of `doc?`, `path?`, `ref?`                                                                                                                                | Keeps and renders a review document ([review-format.md](review-format.md)): `POST /api/docs` for `doc` or the .json at `path`, `POST /api/review/:id/doc` for `ref`. Answers with the page's file, its `inbox://doc/<id>` link, its browser address and what was left out. With the desk down, renders `doc` or `path` into the desk's home itself |
| `desk_sync`        | none                                                                                                                                                          | `sync started`                                                                                                                                                                                                                                                                                                                                     |
| `desk_events`      | `after?` (seq, default 0), `wait?` (0–60 s), `limit?` (1–500, default 100), `item?` (a ref)                                                                   | One line per event (`#seq at item kind by actor data`), oldest first, and `last_seq` for the next `after`; JSON `ActivityPage`. With `wait` it returns as soon as one lands. Read only                                                                                                                                                             |
| `desk_merging`     | none                                                                                                                                                          | One line per PR in Merging: CI and failing checks, reviews, unresolved threads, mergeable, base, what blocks it, the repo's merge method, "no review needed" where so, the last note. Titles and notes fenced; JSON of the rows. Read only                                                                                                         |
| `desk_hand_back`   | `ref`, `why` (one line, ≤300)                                                                                                                                 | The PR leaves Merging for the top of the queue as "handed back: <why>"; the owner is notified. Only on the owner's open PR in Merging                                                                                                                                                                                                              |
| `desk_note`        | `ref`, `text` (one line, ≤300)                                                                                                                                | `noted on <ref>`: the PR's status line on its row in Merging, with its age; only the latest shows. Only on the owner's open PR in Merging                                                                                                                                                                                                          |
| `desk_config`      | `action` (`get` `preview` `save`), `text?` (the whole config.toml), `base?` (save)                                                                            | get: config.toml fenced, its hash and errors, the judge's status, each board's built-in rules by id with their weights. preview: errors, counts per board before → after, items that would move; saves nothing. save: valid text only; a stale `base` is an error                                                                                  |
| `desk_answer`      | `ask_id` (from the wake message), `text` (≤6,000, paragraphs, answer first)                                                                                   | `answered ask <id>`: the coordinator's answer to the owner's ask, shown in their chat; the owner is notified                                                                                                                                                                                                                                       |
| `desk_ask`         | `ask_id` (from a wake that says `desk_ask <id> says where`)                                                                                                   | Where the owner's ask is: their words, whose the item is and its state, the thread or the lines (side, numbers, commit read, head now), and `Push: yes` only on their own open PR (else `Push: no` and why). File name, `file_arg`, base and branch are fenced                                                                                     |
| `desk_inquire`     | `question`, `context` (200–6,000), `options?` (≤6 `{ answer, next }`), `links?` (≤12 `{ label, url }`), `item?`, `from`                                       | `asked as inquiry <id>`: a question for the owner, a row on their main page with its own page, and a notification. Beside the chat, not instead of it. Its description says when to ask and what the page needs. Poll `desk_inquiry` for the answer                                                                                                |
| `desk_inquiry`     | `id?` (or the question's `inbox://question/<id>` link), `wait?` (0–60 s)                                                                                      | The answer, "no answer yet", or that it was dismissed. Giving the answer by `id` marks it picked up (`POST /api/inquiries/:id/read`). By link it also shows the question itself (fenced) and doesn't count as a pickup. With no `id`: the answers nobody has picked up yet, picking none up                                                        |
| `desk_criteria`    | `action` (`list` `set` `delete`), `id?`, `name?`, `when?`, `ask?`, `urgent?`                                                                                  | list: each criterion, on or off, and how many Inbox items it says yes to; a plugin's marked built in. set: saves one, whole, on at once. delete: removes one of the owner's ([Urgency](#urgency))                                                                                                                                                  |
| `desk_automations` | `action` (`list` `set` `run`), `id?`, `name?`, `schedule?`, `events?`, `prompt?`, `when?`, `decide?`, `rule?`, `can?`                                         | list: each automation (a plugin's marked built in), what starts it, its check, how it decides, what it may do, on or off, next run, last 3 runs (summaries fenced). set: drafts or changes one, whole; it stays off until the owner turns it on. run: runs one that's on, now ([Automations](#automations))                                        |

`until` (snooze): `1h`, `3h`, `2d` (any positive hours or days), `tomorrow` (09:00 local; before 05:00 it means this morning), `monday` (next Monday 09:00), `activity` (until someone else acts), `YYYY-MM-DD` (09:00 that day), a future ISO time, or one of the card's `wake_on` (`ci`, `push`, `approved`, `ready`, `conflict`).

## HTTP routes

JSON in and out. Errors are `{ error: string, candidates?: string[] }`:

- 400: a bad request.
- 404: an unknown board, item or route.
- 409: an ambiguous short ref (with `candidates`), or an action the item's state doesn't allow.
- 502: GitHub or your agent refused; the error has its reason.

**503 while starting.** Routes marked ✓ answer 503 until the first load finishes. If config.toml has errors from the start, the routes that read the queue keep answering 503, and `/api/config` works so you can fix it. Errors in a later edit keep the last good config running.

**Own page only** means the route answers 403 unless the request comes from the desk's own window (`Sec-Fetch-Site: same-origin` and the desk's `Origin`; see [Security model](#security-model)). Agents, the CLI and curl get 403.

### Queue and items

| Method | Path              | What it does                                                                                                                                                                                                | 503 |
| ------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| GET    | `/health`         | `{ ok: true, version }`                                                                                                                                                                                     |     |
| GET    | `/api/overview`   | `Overview`                                                                                                                                                                                                  | ✓   |
| GET    | `/api/queue`      | `QueueView`: every item once, at its best placement. The window's main source                                                                                                                               | ✓   |
| GET    | `/api/focus`      | `FocusView`: the queue's now and today in the desk's order; never a PR in Merging                                                                                                                           | ✓   |
| GET    | `/api/boards/:id` | `BoardView`                                                                                                                                                                                                 | ✓   |
| GET    | `/api/item`       | `?id=<ref>` (encode `#` as `%23`) → `ItemDetail`                                                                                                                                                            | ✓   |
| POST   | `/api/act`        | `{ id, action, until? }` → `{ ok, state: ItemState, undo_seq }`. `seen` and `undo` give `undo_seq: 0`. `inflight` is own page only                                                                          | ✓   |
| POST   | `/api/add`        | `{ id, why?, from? }` → `{ ok, item: ItemDetail, undo_seq }`: on your desk, pinned ([Adding](#adding)). 400 for a ref it can't read or a short one it doesn't hold; 404 when GitHub has no such PR or issue | ✓   |
| POST   | `/api/undo`       | `{ seq? }` (default: the latest action, any client's) → `{ ok, id, action }`. 409 if a later action on the item must be undone first, or for a hand-off or Back to desk not from the own page               | ✓   |
| POST   | `/api/sync`       | Starts a sync now                                                                                                                                                                                           |     |
| GET    | `/api/status`     | `{ now, today, new, text }`; `text` is e.g. `desk 7 +3` (7 in the queue, 3 new), `""` when 0/0                                                                                                              | ✓   |
| GET    | `/api/fields`     | `FieldDoc[]`: every field rules can use                                                                                                                                                                     |     |

`Action` is one of:

- `done`, `snooze`, `mute`, `unmute`, `pin`, `unpin`, `restore`;
- `inflight`: Hand off for merge, your own open PR into [Merging](#merging);
- `takeback`: Back to desk, out of Merging;
- `seen`: marks it looked at; not undoable;
- `undo`: undoes the latest action on that item.

`until` is as for `desk_act` ([MCP tools](#mcp-tools)).

### Reviews and GitHub writes

Every write here is own page only, logged, and answers 502 with GitHub's reason when GitHub refuses. `:id` is `owner%2Frepo%23123` (or `owner/repo%23123`).

| Method | Path                        | What it does                                                                                                                                                                                                                                                                                         | 503 |
| ------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| GET    | `/api/review/:id`           | `ReviewView`; 400 for an issue. Opening it asks for the AI review (with `review.auto_ai`, when this commit has none) and has your agent read what waits on you; `?ahead=1`, the window's prefetch, starts neither                                                                                    | ✓   |
| POST   | `/api/review/:id/ai`        | `{ force? }` → `{ ok, ai: AiReview }`: this commit's review unless `force`; joins a run already going                                                                                                                                                                                                | ✓   |
| POST   | `/api/review/:id/doc`       | `{ ok } & DocSaved`: the AI review as a review document (the one `AiReview.doc` names, or written now). 409 with no AI review or no diff                                                                                                                                                             | ✓   |
| POST   | `/api/review/:id/approve`   | `{ head_oid, body? }` → `{ ok, url }`: approves at `head_oid`, the commit the view showed, then refreshes the PR and runs a full sync. 409 for your own PR, a closed one, one you approved at this commit, or new commits since                                                                      | ✓   |
| POST   | `/api/review/:id/reply`     | `{ id, body }` → `{ ok, url }`: your reply to one of the PR's conversations, as you ([What reviewers said](#what-reviewers-said)). 404 for a conversation that isn't this PR's; 409 for a closed PR                                                                                                  | ✓   |
| POST   | `/api/review/:id/comment`   | `{ body }` → `{ ok, url }`: your comment on the PR or issue. It's done, off your desk until someone else acts. 400 when empty; 409 when closed or merged                                                                                                                                             | ✓   |
| POST   | `/api/review/:id/inline`    | `{ path, line, side, start?, body, head_oid }` → `{ ok, url }`: a comment on a line of the diff, on `side` `new` (RIGHT) or `old` (LEFT), `start` for a range, pinned to `head_oid`. Not done. 400 for a bad line or empty body; 409 for a closed PR                                                 | ✓   |
| POST   | `/api/review/:id/ready`     | `{ users?, teams? }` (node ids) → `{ ok, done }`: marks your open draft ready, then asks those reviewers ([Ready for review](#ready-for-review)). 400 unless lists of ids; 409 unless your own open draft; 502 "Marked it ready, but …" when only the request failed                                 | ✓   |
| POST   | `/api/review/:id/reviewers` | `{ users?, teams? }` → `{ ok }`: asks them to review your open non-draft PR; it leaves your desk until someone reviews. 400 when nobody's picked; 409 for a draft or someone else's PR                                                                                                               | ✓   |
| GET    | `/api/reviewers/:id`        | `?q=` → `Reviewer[]` (`id login name team suggested`): GitHub's suggestions matching `q` first, then people with access and the org's teams, never you. 409 unless it's your PR. Read only                                                                                                           |     |
| POST   | `/api/github`               | `{ id, action, head_oid?, body? }` → `{ ok, url }`: a [More menu](#the-more-menu) write (`close`, `draft`, `ready`, `merge`, `reopen`, `request_changes` with `body`); refreshes the item first. 409 unless the card offers it now, or for new commits since `head_oid` on a merge or change request | ✓   |

### Settings and rules

| Method | Path                  | What it does                                                                                                                                                                                                                                                               | 503 |
| ------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| GET    | `/api/config`         | `ConfigDoc`: `{ path, text, hash, errors, warnings?, hard, builtins }`. `hard`: the hard and final rules. `builtins`: per board that names a set, each built-in rule with its `weight`, `on` and `yours` ([Rules](#rules-built-in-and-your-own))                           | ✓   |
| POST   | `/api/config/preview` | `{ text }` → `PreviewResult`: errors, and per board the new counts and which items would move                                                                                                                                                                              | ✓   |
| PUT    | `/api/config`         | `{ text, base? }` → `{ ok, errors, warnings }`. Saves only valid text, and never with a settings section (`poll_seconds`, `[signals]`, `[notify]`, `[handoff]`, `[analyze]`: those live in Settings). 409 if the file changed since `base` (text or hash)                  | ✓   |
| PUT    | `/api/config/builtin` | `{ board, rule, on, base? }`: switches one built-in rule through the board's `off` list; answers as `PUT /api/config`. 400 when `off` spans lines                                                                                                                          | ✓   |
| GET    | `/api/settings`       | `SettingsView`: schema, effective values, what's overridden, GitHub status, the judge's status (`judge`)                                                                                                                                                                   |     |
| PUT    | `/api/settings`       | `{ set?, reset? }` → `{ ok, errors, settings }`; writes nothing if any value is invalid. Setting a secret (`agent.decision_key`) is own page only                                                                                                                          |     |
| GET    | `/api/agents`         | `AgentStatus` for your agent: `{ driver, mcp: { connected, name, command }, skill: { state, path, command }, needs, note, connect }`. `skill.state` is `installed`, `outdated` or `missing`; `needs` is `connect`, `update` or null; `note` says a name that isn't `inbox` |     |
| POST   | `/api/agents/connect` | `AgentStatus` after installing the skill and registering the MCP server (under another name when `inbox` is kept by something else); 502 with the command to run yourself when the agent's CLI fails or isn't on PATH                                                      |     |
| GET    | `/api/setup`          | `SetupView`: `{ needed, github: { login, error, fix }, agent, picked, agents: [{ id, name, installed, logged_in, fix }] }`. `fix` is the command to run, null when there's none ([The first run](#the-first-run))                                                          |     |
| POST   | `/api/setup/check`    | `SetupView` after asking GitHub (when it wasn't connected: then the first config and sync) and each agent's CLI again                                                                                                                                                      |     |
| POST   | `/api/setup`          | `{ agent }` → `SetupView`: sets `agent.harness`, connects it as `POST /api/agents/connect` does, and ends the first-run page once GitHub is connected. 409 while the agent isn't installed and logged in, with what to run                                                 |     |
| POST   | `/api/update`         | `UpdateView`: the packaged app downloads the newer release and restarts into it. 409 when there's none or the app can't install it itself                                                                                                                                  |     |
| GET    | `/api/omarchy`        | The theme Omarchy has on; null off Omarchy                                                                                                                                                                                                                                 |     |

### Merging, the coordinator and asks

| Method | Path                         | What it does                                                                                                                                                                                                                | 503 |
| ------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| GET    | `/api/inflight`              | `InflightView`: your PRs in Merging (open first, latest activity on top, then merged or closed in the last 3 days), the coordinator's state, and Claude's work                                                              | ✓   |
| POST   | `/api/inflight/:id/note`     | `{ text }` → `{ ok, text }` (`desk_note`), flattened to one line. 400 when empty; 409 unless your open PR in Merging                                                                                                        | ✓   |
| POST   | `/api/inflight/:id/handback` | `{ why }` → `{ ok, reason }` (`desk_hand_back`): the PR leaves Merging for the top of the queue. 409 unless your open PR in Merging                                                                                         | ✓   |
| POST   | `/api/coordinator/wake`      | Starts the coordinator, or has it look at Merging now (Start it now, Wake it). 409 while `agent.coordinator` is off                                                                                                         | ✓   |
| POST   | `/api/ask`                   | `{ text, item_id?, thread_id?, thread_url?, lines? }` → `{ ok, ask }`: your words to the coordinator ([Asks](#asks)), up to 2,000 characters. Own page only. 409 while `agent.coordinator` is off; 502 when it didn't start | ✓   |
| GET    | `/api/asks`                  | `{ on, asks, coordinator }`: whether it's on, your asks oldest first with their answers, and what it's doing                                                                                                                |     |
| GET    | `/api/asks/:id`              | `AskPlace` (`desk_ask`): where the ask is. Agents may read it. 404 for an unknown ask                                                                                                                                       | ✓   |
| POST   | `/api/asks/:id/answer`       | `{ text }` → `{ ok, ask }` (`desk_answer`). Paragraphs kept; control, bidi and zero-width characters dropped; at most one blank line in a row. 400 over 6,000 characters (never cut); 404 for an unknown ask                |     |

### Agents' questions

| Method | Path                        | What it does                                                                                                                                                                                                            | 503 |
| ------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| POST   | `/api/notes`                | `{ text, remind }` → `{ ok, note: Note }`: a note to yourself; `remind` is `""` or a time as a snooze reads it (`1h`, `tomorrow`, `monday`, a date, an ISO time). `QueueView.notes` places them: `due`, `open`, `later` |     |
| POST   | `/api/notes/:id`            | `{ text, remind }` → `{ ok, note }`: changed; a new time notifies again. `/api/notes/:id/done` removes it                                                                                                               |     |
| POST   | `/api/inquiries`            | `{ question, from, context, options?, links?, item? }` → `{ ok, inquiry }` (`desk_inquire`). Limits below; 400 says what's missing                                                                                      |     |
| GET    | `/api/inquiries/unread`     | `Inquiry[]`: answers nobody has picked up yet (`answer.read_at` null), in the order asked. Listing picks none up                                                                                                        |     |
| GET    | `/api/inquiries/:id`        | `InquiryView` (the question's page): the `Inquiry`, its item's `card` (null when the desk doesn't hold it), and `answer: { text, at, dismissed, read_at? }` once answered or dismissed. Reading here isn't a pickup     |     |
| POST   | `/api/inquiries/:id/read`   | `{ ok, inquiry }`: stamps `answer.read_at` the first time and ends its job in Claude's work. No change for an open question, a dismissal or a later read                                                                |     |
| POST   | `/api/inquiries/:id/answer` | `{ text }` or `{ dismiss: true }` → `{ ok, inquiry }`. Own page only (an agent can't answer its own question). 400 when empty; 409 if already answered                                                                  | ✓   |

A question's limits: `question` one line (300), `from` one line (60), `context` 200 to 6,000 characters (paragraphs kept), at most 6 `options` (`answer` 80, `next` 400: what the agent does if you pick it), at most 12 `links` with https URLs, and an `item` or at least one link. Text over a limit is refused, never cut; bidi marks are dropped.

After you answer, the question leaves the main page and is owed to whoever asked until they read it: an `answer` job in Claude's work, with one notification if it's unread after 30 minutes. A dismissal owes nothing. A question the coordinator asked (`from` "Inbox coordinator") wakes it with your answer, which counts as its read.

### Sessions, automations and criteria

| Method | Path                       | What it does                                                                                                                                                                                          | 503          |
| ------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| GET    | `/api/sessions/:id`        | `SessionCard` of a session that needs you now; 404 once it doesn't ([Sessions](#sessions))                                                                                                            |              |
| POST   | `/api/sessions/:id/kick`   | `{ ok, args, note }`: Kick or Resume in background. Own page only. 409 while its process runs, before its rate limit resets, or for a kind it isn't for                                               | ✓            |
| POST   | `/api/sessions/:id/open`   | `{ ok, url }`: opens its `claude://` or `codex://` link on the desk's computer. Own page only; 409 with no link                                                                                       | ✓            |
| GET    | `/api/automations`         | `AutomationView[]` ([Automations](#automations))                                                                                                                                                      |              |
| PUT    | `/api/automations/:id`     | `AutomationBody` → `{ ok, automation }`: creates or replaces one of yours. From the own page `on` is as sent; from anything else a new or changed automation is off. 400 for a plugin's or a bad body | ✓ (`on`)     |
| PUT    | `/api/automations/:id/on`  | `{ on }` → `{ ok, automation }`: switches a plugin's (`github.<id>`). Own page only; 404 for one of yours (its switch is its PUT)                                                                     | ✓            |
| DELETE | `/api/automations/:id`     | Own page only; 400 for a plugin's                                                                                                                                                                     | ✓            |
| POST   | `/api/automations/:id/run` | `{ ok, running }`: runs it now, in the background. 409 for one that's off unless from the own page                                                                                                    | ✓ (when off) |
| GET    | `/api/criteria`            | `CriteriaView`: each criterion with `yes` (the Inbox items it says yes to), and `waiting`, `held`, `scored` ([Urgency](#urgency))                                                                     |              |
| PUT    | `/api/criteria/:id`        | `{ name, when?, ask?, urgent?, on? }` → `{ ok, criterion }`: saves yours, whole. An agent's is on (`on` is the window's to set)                                                                       |              |
| PUT    | `/api/criteria/:id/on`     | `{ on }` → `{ ok, criterion }`: switches yours or a plugin's. Own page only                                                                                                                           |              |
| DELETE | `/api/criteria/:id`        | 400 for a plugin's                                                                                                                                                                                    |              |

`PUT /api/automations/:id` checks: id is lowercase letters, digits and `-`, up to 40; `schedule` like `daily 09:00`, `weekdays 09:00`, `mon,thu 17:30`, or `events` instead, not both; an instruction up to 8,000 characters (none for a rule); `when` compiles; `decide` and a rule's `rule`; `can` (add alone when left out).

### Documents, events and the rest

| Method      | Path                 | What it does                                                                                                                                                                                                                                                     |
| ----------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST        | `/api/docs`          | A review document ([review-format.md](review-format.md)) → `{ ok } & DocSaved` (`desk_doc`): read as the desk reads its own AI review, kept as `<home>/docs/<id>.json` and `<id>.html`. `dropped` lists what was left out; 400 with why                          |
| GET         | `/api/docs/:id`      | The document as kept                                                                                                                                                                                                                                             |
| GET         | `/api/docs/:id/html` | Its page: one HTML file, no script, nothing fetched. Its CSP lets only the desk's own window frame it (`#/doc/<id>`)                                                                                                                                             |
| GET         | `/api/activity`      | `?after=&limit=&item=&wait=` → `ActivityPage`, a long-poll ([The event log](#the-event-log))                                                                                                                                                                     |
| GET         | `/api/events`        | Server-sent events ([Events](#events))                                                                                                                                                                                                                           |
| POST        | `/mcp`               | MCP JSON-RPC (Streamable HTTP): responses as an SSE stream; 202 for notifications                                                                                                                                                                                |
| GET, DELETE | `/mcp`               | 405, `Allow: POST`                                                                                                                                                                                                                                               |
| GET         | `/api/remote`        | `RemoteView`: `{ on, text, url, login, devices }`, Settings → This device's Tailscale rows                                                                                                                                                                       |
| POST        | `/api/pair/code`     | `{ code, expires_at, url, pair_url }` (`desk pair`). This machine only; 409 while not served over Tailscale. A new code replaces the last                                                                                                                        |
| POST        | `/api/pair/token`    | `{ name? }` → `{ url, token, device }` (`desk pair --print`). This machine only; 409 while not served                                                                                                                                                            |
| POST        | `/api/pair`          | `{ code, kind?: "browser" \| "device", name? }`. Another device only: the code for `{ ok, token, device }`, or for a browser the session cookie and `{ ok, device }`. 403 for a wrong, used or expired code; 429 past five tries a minute                        |
| DELETE      | `/api/devices/:id`   | Revokes a device at once. Own page only                                                                                                                                                                                                                          |
| GET         | `/pair`              | Another device only: the page a pairing link opens. It trades the code in its `#` for a session and goes to the Inbox                                                                                                                                            |
| GET         | `/skill`             | `skills/inbox/SKILL.md` as text; from another device, with the desk's tailnet address in place of `localhost:47823`                                                                                                                                              |
| GET         | anything else        | The web UI from `web/dist` (unknown paths get `index.html`). From a checkout (`DESK_UI_ORIGIN`), the app's Vite server passed through with its hot-reload WebSocket, or a 503 page that retries while it starts. `/api…` and `/health…` paths get the desk's 404 |

### Main types

Trimmed from [src/types.ts](../src/types.ts); the file is the source of truth. Text from GitHub or an agent (titles, why's from agents, summaries, notes, answers) is untrusted.

```ts
type Bucket = "now" | "today" | "blocked" | "later" | "fyi" | "hide";
type Until = "ci" | "push" | "approved" | "ready" | "conflict"; // what a snooze can wait on
type GitHubAction = "close" | "draft" | "ready" | "merge" | "reopen" | "request_changes";

interface Card {
  id: string; // "owner/repo#123"
  kind: "pr" | "issue";
  repo: string;
  number: number;
  title: string; // untrusted
  url: string;
  author: string;
  author_bot: boolean;
  by: string; // who the row says it's from: "you", the person a bot opened it for, else its author
  stage?: "draft" | "waiting for review" | "changes requested" | "approved" | "blocked" | "handed back" | "merged" | "closed";
  bucket: Bucket;
  why: string; // e.g. "vaind asked you directly"
  handoff?: { why: string; from: string }; // an agent added it (desk_add); gone once you act on it
  demoted?: string; // over a cap: "3 from PRs to review are urgent already"
  board: string;
  boards: string[]; // every board it's on
  chips: string[]; // "draft", "CI red", "conflict", "3 unresolved", "+120 −30", …
  ci: "green" | "red" | "pending" | "none";
  review: "approved" | "changes_requested" | "required" | "none";
  draft: boolean;
  created_at: string;
  updated_at: string;
  activity_at: string; // latest activity by someone else
  waiting_since: string; // request time if requested, else created_at
  new: boolean; // activity since you last looked
  pinned: boolean;
  status: "active" | "done" | "snoozed" | "muted";
  snooze_until: string | null;
  snooze_when: Until | null; // snoozed until this happens
  wake_on?: Until[]; // what a snooze can wait on now
  done_at?: string; // while done: when
  verdict: "look" | "skim" | "skip" | null; // the current commit's AI review
  preflight?: Preflight; // Now and Today only
  handed_back?: boolean; // your PR back on top; its why says why
  cta?: "ready" | "reply" | "reviewers" | "merge"; // the row's one call to action
  review_optional?: true; // your PR's repo needs no review: Hand off for merge beside Add reviewers
  talk?: true; // people said something on it
  actions?: GitHubAction[]; // the More menu's writes allowed now
  resolved: string | null; // "merged", "approved by alice", …; null while open
  resolved_at: string | null;
  inflight: boolean; // your PR, in Merging
  group?: "back" | "review" | "other" | "mine"; // a Now or Today card's part of the main page's order
  placed_by?: "hard" | "pin" | "claude" | "automation" | "pending" | "unanswered";
  team_ask?: string; // asked only of your team: "CODEOWNERS ping to @ml-team"
  stack?: StackRef; // an open PR whose line has two or more open PRs
  blocker?: { id: string; ref: string; waits: string }; // the PR at the end of its blocking chain
  needs?: string[]; // open PRs it needs merged first, directly
  depth?: number; // on Blocked: how deep in its chain the row hangs
  blocks?: string[]; // open PRs that need this one merged first
  section?: "urgent" | "standard" | "fyi"; // on the Inbox
  score?: number; // on the Inbox: 0 to 10
  reason?: string; // on the Inbox: the row's quiet why
  quick?: string; // someone else's PR that's quick to review: "low risk, 24 lines"
}

// The AI review of a card's head, for skimming.
interface Preflight {
  state: "ready" | "stale" | "running" | "queued" | "paused" | "off" | "failed" | "none";
  verdict?: "look" | "skim" | "skip";
  risk?: "low" | "medium" | "high";
  summary?: string;
  since?: string; // a re-review's gist
  concerns?: string[]; // at most 2
  notes?: number;
}

interface QueueView {
  inquiries: Inquiry[]; // agents' questions for you, oldest first
  sessions: SessionCard[]; // sessions that need you
  sections: { now: Card[]; today: Card[]; blocked: Card[]; later: Card[]; fyi: Card[] }; // the rules' view
  reviewing: number; // PRs held until their first AI review is written
  hidden: Card[]; // a rule put it in "hide"
  cleared: Card[]; // done, snoozed, muted
  resolved: Card[]; // newest first (see Resolved)
  paused: { who: "claude" | "ai"; why: string } | null; // shown once, as a bubble
  stacks: Record<string, Stack>; // each stack a card here carries
  inbox: { urgent: Card[]; standard: Card[]; fyi: Card[] }; // what the window draws (see Urgency)
  first_pass: FirstPass | null; // a new desk's first minutes (see The first pass)
}
// FirstPass: { step: "sync" | "sort"; done; total; found; line }, `line` in the desk's words for the Inbox.
// FocusView: { sessions, sections: { now, today }, reviewing, paused }; never resolved items.
// BoardView: { board: BoardSummary & { queries }, sections, hidden, cleared }; every PR, no stacks.

interface Overview {
  me: string;
  synced_at: string | null;
  syncing: boolean;
  sync_error: string | null;
  config_errors: ConfigError[];
  connectors: {
    id: string;
    name: string;
    status: "ok" | "syncing" | "paused" | "error";
    synced_at: string | null;
    error: string | null;
    progress?: { done: number; total: number; found: number } | null;
  }[]; // progress: the running pass's searches done of total, items found so far
  spaces: { id: string; name: string; boards: BoardSummary[] }[]; // counts per bucket, cleared, new, error?
  focus: { now: number; today: number; new: number; asks: number; sessions: number };
  inflight: { total: number }; // your open PRs in Merging
  agent: boolean; // agent.coordinator is on: the window shows Ask your agent
  ai_agent: AgentName; // who sorts and reviews (agent.harness)
  rate_limit: { remaining: number; reset_at: string } | null;
  sentry?: { dsn: string; release: string | undefined } | null; // the UI's Sentry; null: none
  update?: UpdateView | null; // null: no packaged app runs this desk
}

interface UpdateView {
  current: string;
  latest: string | null;
  url: string | null; // the release's page
  available: boolean;
  install: boolean; // the app can install it itself (POST /api/update)
  installing: boolean;
  error: string | null; // why the last install failed
}

interface Placement {
  board: string;
  bucket: Bucket; // after caps
  rule_bucket: Bucket; // before caps, after the judge
  rule: number | null; // matched rule index; null = the board default
  why: string;
  demoted?: string;
  trace: TraceStep[];
  hard?: boolean; // a hard rule matched
  floor?: Bucket; // it never sorts below this (hard rule or pin)
  judge?: JudgeStep; // while the judge is on
  hint?: { bucket: Bucket; why: string }; // where the first matching rule put it
  signals?: JudgeSignal[]; // every rule on this board that matches it
}

interface JudgeSignal {
  from: string; // "built-in rule asked-directly on \"PRs to review\"", "your rule #2 on …", "automation …", "criterion …"
  bucket?: Bucket; // what it suggests; a criterion's yes suggests none
  why: string;
  weight: number; // 0 to 10
  hard?: boolean;
  key: string; // changes when the rule, its bucket or its weight does
}

interface ItemDetail {
  card: Card;
  item: Item; // the normalized GitHub item
  signals: Signals; // every field rules can read
  placements: Placement[]; // per board
  judge?: { signals: JudgeSignal[]; saw: JudgeSignal[] | null; at: string | null; fresh: boolean }; // what the judge weighs now; what its answer weighed
  state: ItemState;
  handoff_prompt: string;
  ai: AiReview | null;
  ai_stale: boolean; // new commits since
  generating: boolean;
  held: boolean; // kept off the queue until its first AI review
  activity: ActivityEvent[]; // latest first
  stack: Stack | null;
}

interface ReviewView {
  card: Card;
  item: Item;
  handoff_prompt: string;
  files: { path: string; previous_path: string | null; status: string; additions: number; deletions: number; patch: string | null }[];
  diff_head: string; // the commit the diff is at: what an inline comment pins to
  files_error: string | null;
  order: ReviewOrder; // every hunk once, in reading order
  ai: AiReview | null; // the latest, even if stale
  ai_stale: boolean;
  ai_error: string | null; // last failure on this commit, or why reviews are paused
  generating: boolean;
  ai_job: Job | null; // its job in Claude's work
  approve: { ok: boolean; reason: string | null }; // reason: why not
  activity: ActivityEvent[]; // the last 8, newest first
  stack: Stack | null;
  checks: Checks | null; // null: none ran, or the fetch failed
  checks_error: string | null;
  reviewers: { line: string; changes: boolean; list: { who: string; state: "changes requested" | "asked" | "approved" | "commented" }[] };
  merge: string | null; // what blocks the merge: "Merge conflict with main"
  conversation: Conversation[]; // those waiting on you first
  conversation_error: string | null;
  reading: boolean; // your agent is reading the ones waiting on you
  reading_error: string | null;
  asks: Ask[]; // yours to the coordinator about it
}

interface Conversation {
  id: string; // what a reply goes to
  kind: "thread" | "comment" | "review";
  path: string | null; // a thread's file
  line: number | null;
  side: "new" | "old" | null; // old: a removed line, numbered in the old file
  outdated: boolean;
  resolved: boolean;
  state: ReviewState | null; // a review's
  comments: { id: string; author: string; bot: boolean; body: string; at: string; url: string }[]; // oldest first
  waiting_on_you: boolean;
  url: string;
  take: Take | null; // your agent's read; only when waiting on you
}

interface Checks {
  line: string; // "CI passing · 14 checks", "2 failing of 14 checks"
  failing: boolean; // a required check fails: drawn red
  list: { name: string; state: "failing" | "cancelled" | "running" | "passing" | "skipped"; optional: boolean; url: string }[];
}

interface AiReview {
  verdict: "look" | "skim" | "skip";
  risk: "low" | "medium" | "high";
  summary: string;
  since?: string; // a re-review: what changed since your review
  concerns: string[]; // each also a note on its line
  notes: { path: string; line: number; side: "new" | "old"; body: string }[]; // line 0: the whole file
  dropped?: number; // what the checks took out
  chunks?: {
    ranked: { id: string; path: string; level: "look" | "skim"; why: string }[];
    unread: string[]; // hunks too long to send
    total: number;
  };
  guide?: {
    steps: { title: string; body: string; check: string; note?: string; diagram?: string; hunks: { id: string; path: string }[] }[];
  };
  // The review document's parts (review-format.md); absent on older reviews.
  risk_reasons?: { factor: RiskFactor; why: string }[];
  intent?: { goal: string; fit: "matches" | "partial" | "differs" | "undescribed"; gap: string; stack: string };
  look?: ReviewLook[];
  interfaces?: ReviewInterface[];
  improvements?: ReviewNote[];
  diagrams?: ReviewDiagram[];
  skill?: string; // hash of the review instructions used
  doc?: string; // its review document's id
  refused?: string[]; // diagrams the grammar refused
  head_oid: string; // the commit it read
  model: string; // as the agent reports it ("claude-opus-5[1m]"), else "claude-code", "codex", "opencode"
  at: string;
}

// The reading order: clients render it as is.
interface ReviewOrder {
  ranked: boolean; // false: no ranking for this commit; chunks is every hunk, file by file
  chunks: ReviewHunk[]; // read these, in this order
  unread: ReviewHunk[]; // too long for the agent to see
  skipped: ReviewHunk[]; // the agent left them out
  rest: { path: string; file: number; why: string; hunks: ReviewHunk[]; notes: number[] }[]; // folded by the desk
  notes: number[]; // ai.notes in reading order; empty for an older commit
  steps?: { title: string; body: string; check: string; hunks: ReviewHunk[] }[]; // the walk-through
  beyond?: ReviewHunk[]; // with steps: hunks no step covers
}

interface ReviewHunk {
  id: string; // h1, h2, … as the prompt numbered them
  path: string;
  file: number; // index in files
  header: string; // its @@ line
  patch: string; // its own lines, @@ first
  additions: number;
  deletions: number;
  level: "look" | "skim" | "skip" | "unread" | null; // null: no ranking
  rank: number | null; // 1 = first; look and skim only
  why: string | null;
  notes: number[]; // ai.notes to show with it
  looks?: number[]; // ai.look entries starting here
}

interface ActivityEvent {
  seq: number; // increasing
  at: string; // when it happened, else when the desk noticed
  source: string; // "github"
  item_id: string;
  kind: ActivityKind; // see The event log
  actor: string; // login, "" if unknown
  data: Record<string, string | boolean>;
}

interface ActivityPage {
  events: ActivityEvent[]; // oldest first
  last_seq: number; // the next call's `after`
}

interface InflightView {
  rows: InflightRow[]; // a stack's rows together, bottom first
  stacks: Record<string, Stack>;
  coordinator: CoordinatorView;
  work: Work[]; // Claude's work: running, queued, failed
}

interface InflightRow {
  card: Card;
  state: "open" | "merged" | "closed";
  base: string;
  stacked: boolean; // based on another PR
  review_optional: boolean; // merges once CI passes
  merge_method: "MERGE" | "SQUASH" | "REBASE" | null;
  ci: "green" | "red" | "pending" | "none";
  failing: string[]; // failing check names
  approved_by: string[]; // collaborators only
  changes_by: string[];
  waiting_on: string[]; // asked, not heard from; teams as @slug
  threads_unresolved: number;
  mergeable: "clean" | "conflict" | "unknown";
  draft: boolean;
  rebase: boolean; // only here to be rebased
  blocked_by: { ref: string; waits: string } | null;
  requires_closed: string[]; // PRs it needs that closed unmerged
  waits_on: string | null; // "waits on CI", "ready to merge"; null once merged or closed
  note: { text: string; at: string } | null; // the coordinator's latest; untrusted
}

interface CoordinatorView {
  on: boolean;
  id: string | null; // null until started
  url: string | null; // its Remote Control page
  error: string | null; // why it last couldn't start or resume
  status: "busy" | "shell" | "waiting" | "idle" | "stopped" | null; // checked every 10 s while an ask waits
  queued: string[]; // your asks not handed over yet
}

interface Ask {
  id: string;
  at: string;
  text: string; // your words
  item_id: string | null;
  thread_id: string | null;
  thread_url: string | null;
  lines?: AskLines | null;
  answer: { text: string; at: string } | null; // untrusted
}

interface AskLines {
  path: string; // untrusted: never in the wake line
  line: number;
  side: "new" | "old";
  start?: { line: number; side: "new" | "old" };
  head: string; // the 40-character commit
  note?: boolean; // the AI note there, not lines you picked
}

interface AskPlace {
  ask: Ask;
  about: { url: string; whose: "mine" | "theirs" | "issue"; merging: boolean; state: "open" | "closed" | "merged" } | null;
  head: string | null; // the PR's head at the last sync
  base: string | null; // removed lines are numbered there
  push: { repo: string; branch: string } | null; // only your own open PR
}

interface StackRef {
  id: string; // the bottom PR's id
  pos: number; // 1 = the lowest open PR of its line
  size: number; // open PRs in the line
  folded?: string[]; // on the one card listed for a stack: the members it stands for
}

interface Stack {
  id: string;
  repo: string;
  base: string; // the branch under the bottom PR
  line: StackMember[]; // bottom first
  forks: StackMember[]; // other branches at a fork
  current: string; // the PR the view is about
  up: string | null;
  down: string | null;
}

interface StackMember {
  id: string;
  number: number;
  title: string; // untrusted
  url: string;
  author: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  ci: "green" | "red" | "pending" | "none";
  review: "approved" | "changes_requested" | "required" | "none";
  parent: string | null;
  current: boolean;
  bucket: Bucket | null; // null off the queue
  why: string;
}

interface SessionCard {
  id: string; // "session:<its id>"
  session_id: string; // Claude Code's session id, or Codex's thread id
  kind: "cli" | "background" | "desktop" | "codex";
  name: string;
  cwd: string;
  branch: string | null;
  state: "blocked" | "stalled";
  reason: string; // "needs permission: Bash", "rate limited until 14:05"
  since: string;
  excerpt: string; // one line
  resets_at: string | null;
  alive: boolean; // its process runs
  actions: ("kick" | "resume" | "attach" | "open")[];
  open_url: string | null;
  attach: string | null; // the command attach copies
  status: "active" | "done" | "snoozed" | "muted";
  snooze_until: string | null;
}

type Verb = "add" | "today" | "later" | "fyi" | "hide" | "snooze" | "done" | "mute";

interface Automation {
  id: string; // a slug: "warden-issues"
  name: string;
  schedule: string; // "daily 09:00", "weekdays 09:00,13:00", "mon,thu 17:30", "weekdays hourly"; "" with events
  events?: ActivityKind[]; // runs when one lands on an item
  prompt: string; // the instruction; "" for a rule
  when?: string; // its check, in the rules' language
  decide?: "rule" | "ask"; // absent: agent
  rule?: { do: Verb; until?: string; why: string }; // decide rule's fixed action
  can?: Verb[]; // absent: add only
  on: boolean;
  by: "you" | "an agent"; // who last changed it
  updated_at: string;
  plugin?: string; // a plugin's ("github"): you only switch it
  help?: string; // a plugin's one line
}

// PUT /api/automations/:id: the whole automation; what's left out is its default.
type AutomationBody = {
  name: string;
  schedule?: string;
  events?: ActivityKind[];
  prompt?: string; // required but for a rule
  when?: string;
  decide?: "rule" | "ask" | "agent";
  rule?: { do: Verb; until?: string; why: string };
  can?: Verb[];
  on?: boolean;
};

interface AutomationRun {
  id: string;
  automation: string;
  trigger: "schedule" | "now" | "event";
  at: string;
  done_at: string | null; // null while it runs
  error: string | null;
  summary: string; // untrusted
  items: AutomationItem[];
  session: string | null; // the agent session, to resume
  agent?: "codex" | "opencode";
}

interface AutomationItem {
  item_id: string;
  why: string;
  do?: Verb; // absent: add
  until?: string;
  outcome: "added" | "did" | "kept" | "left" | "resolved" | "held" | "refused" | "failed";
  error?: string;
}

interface AutomationView extends Automation {
  trigger: string; // "Mon and Thu at 17:30", "When CI changes or someone comments"
  next_at: string | null;
  running: boolean;
  waiting: { why: string; until: string } | null; // an ask whose model can't answer now
  runs: (AutomationRun & { did: string; didnt: string })[]; // the last 10, newest first
}
```

## Events

`GET /api/events` is a server-sent events stream:

- `event: update`, `data: {"rev": n}`: once on connect, then after any change (a sync, a triage action or undo, a config or settings save, an AI review or judge call starting or finishing, an approval, a draft marked ready, a note, a hand-back, a hand-off or Back to desk). Refetch what you show.
- `event: notify`, `data: {"title", "body"}`: only with `?notify=1`. The desktop app asks for these when it attaches to a desk it doesn't run in-process; while one listens, the desk shows no notification of its own.
- `event: omarchy`: the Omarchy theme changed (the same value as `GET /api/omarchy`).
- `: ping` comment lines every 25 s keep the connection open.

**What notifies** (`Desk.notifyNew()`, after a sync, a judge answer or a hand-back): a new item on the queue once Claude or a hard rule placed it, and a hand-back. Each once, outside `notify.quiet`. Not: an item Claude hasn't sorted yet, what your own pin put there, what you added, your own draft. Other notifications (an automation's run, an agent's question, an ask's answer) are described where they happen.

### The event log

`GET /api/activity` (and `desk_events`) reads the event log: what happened to items on the desk, found by comparing each fresh snapshot of an item with the last one.

- Follow it by passing `last_seq` back as `after`.
- With `wait=60` the request holds until something happens, so a loop of calls is event-driven.
- `item` narrows it to one item; an exact `owner/repo#123` works after the item left the desk.
- Bad numbers are a 400; an unknown short ref is a 404.

| `kind`             | When                                                                    | `actor`             | `data`                                                 |
| ------------------ | ----------------------------------------------------------------------- | ------------------- | ------------------------------------------------------ |
| `new`              | first seen on the desk                                                  | author              | `kind` (`pr`, `issue`)                                 |
| `review_requested` | a review was asked of you or one of your teams (again, if re-requested) | who asked           | `reviewer`, `type` (`user`, `team`), `codeowner`       |
| `request_removed`  | that ask went away, other than by your own review or a merge            |                     | `reviewer`, `type`                                     |
| `reviewed`         | someone else (not a bot) reviewed                                       | reviewer            | `state` (`approved`, `changes_requested`, `commented`) |
| `pushed`           | a new head commit                                                       | the commit's author | `oid`                                                  |
| `ci`               | CI turned green, red or pending (not the "pending" a push starts)       |                     | `from`, `to`                                           |
| `commented`        | someone else (not a bot) commented                                      | commenter           |                                                        |
| `merged`           | merged                                                                  | who merged          |                                                        |
| `closed`           | closed without merging                                                  |                     |                                                        |
| `reopened`         | reopened                                                                |                     |                                                        |
| `mentioned`        | a notification says you or your team were mentioned                     |                     | `reason` (`mention`, `team_mention`)                   |
| `assigned`         | you were assigned                                                       |                     |                                                        |
| `conflict`         | your PR started conflicting with its base                               |                     | `base`                                                 |
| `resolved`         | it became resolved                                                      | who resolved it     | `reason`                                               |
| `unresolved`       | it stopped being resolved                                               |                     | `was` (the old reason)                                 |
| `blocked`          | your PR a board lists or Merging has became blocked by another PR       |                     | `by` (`pr.blocker`)                                    |
| `unblocked`        | it stopped being blocked                                                |                     | `was`, `merged` (the PR that merged, or ""), `closed`  |

**How GitHub changes reach the log.** The notifications API is polled about every 60 s (`If-Modified-Since`, honouring `X-Poll-Interval`; read only, nothing is marked read).

- A notification about an item on the desk refreshes that item at once.
- One about an item the desk doesn't hold (a review request, mention, team mention, assignment or your own item) starts a full pass early.
- The full pass (every board's searches, then details for what changed) still runs every `github.poll_seconds`. A rate limit pauses both.

## Agents and models

### Your own agent

Settings → Agent (`agent.harness`) picks who sorts and reviews: Claude Code (the default), Codex or OpenCode. It is always your own CLI from PATH, on your own login, model and config. The desk passes no model and sets no API key. (`DESK_CLAUDE`, `DESK_CODEX` and `DESK_OPENCODE` only point tests at fakes.)

There are two kinds of runs:

- **Tool-less calls**, through one seam, `askAgent()` in `src/review.ts`: the judge, the AI review and its check, the read of what reviewers said, an automation's question, Urgency's criteria and scores, and a session's read. They run in `~/.inbox/agent/`, an empty directory, with the input fenced as untrusted.
- **Runs with tools**: your agent, [the coordinator](#the-coordinator), and an automation's agent run (`decide: "agent"`). Each has its own fences, described there.

Choosing another agent applies from the next call and retries at once what failed on the last. The window names the chosen agent ("Sort my desk with Codex", "OpenCode is reviewing it"; `agentName()`, `agentDefs()` in `src/settings.ts`, `Overview.ai_agent`).

The only model the desk calls that isn't your agent is [the decision model](#the-decision-model-openrouter), and only once you give it a key.

#### Claude Code

- **Command:** `claude -p --json-schema … --tools "" --strict-mcp-config --no-session-persistence`, prompt on stdin.
- **Yours:** no `--model`, `--agents`, `--system-prompt` or `--bare`, and no `ANTHROPIC_API_KEY` set (one in the desk's own environment would reach it, as it would your own `claude -p`). Your model, effort and plugins apply.
- **Fenced:** no tools, and `--strict-mcp-config` loads none of your MCP servers (Slack, Linear, GitHub, …).
- **Stopping:** each run is its own process group (`taskkill /T` on Windows), so stopping it stops what it started. When the desk closes it stops every run (SIGTERM, SIGKILL 2 s later) and waits for them, so a restart under `node --watch` leaves none behind.
- **Logged out:** a 401 reads ``Claude Code isn't logged in. Run `claude auth login` in a terminal.``; desk.log keeps Claude's own words.
- **Model:** a review records the model Claude Code reports (`modelUsage`).

#### Codex

- **Command:** `codex exec --json --sandbox read-only --ephemeral --skip-git-repo-check -C ~/.inbox/agent`, then:
  - `--disable` for `shell_tool`, `unified_exec`, `apps`, `plugins`, `browser_use`, `browser_use_external`, `in_app_browser`, `computer_use`, `image_generation`, `view_image`, `multi_agent`, `hooks` and `memories`;
  - `-c web_search="disabled"`, `-c approval_policy="never"`;
  - `-c mcp_servers.<name>.enabled=false` for each of your MCP servers;
  - `--output-schema <file> -o <file> -`, prompt on stdin.
- **Fenced:** Codex has no "no tools" switch, so this turns off everything that can run, reach out or act, and the read-only sandbox refuses writes.
- **MCP servers off:** overriding the whole `mcp_servers` table would merge with yours, so the desk first asks `codex <the same --disable flags> mcp list --json` (kept 5 minutes, asked again when you switch agents) and turns each enabled one off by name. `--disable plugins` drops plugins' servers. If the list fails, the call doesn't run: `CodexServersUnknown` ("Couldn't confirm Codex's MCP servers are off, so it didn't run: …"), held like a logged-out agent.
- **Yours:** no `--model`, `--profile` or `--ignore-user-config`; your `config.toml` stays in charge.
- **Files:** the schema and the last message go through two files in `~/.inbox/agent/`, removed after the run.
- **Answer:** the last message. With none, the turn's failure is the error: a login pauses the desk in Codex's words (``Codex isn't logged in. Run `codex login` in a terminal.``); a usage or rate limit holds what asked without spending a try.
- **Login check:** `codex login status`, or a `model_provider` in `config.toml` (as for OpenRouter) whose `env_key` is set in the desk's environment.
- **Model:** Codex's events name none, so its reviews say `codex`.

#### OpenCode

- **Command:** `opencode run --format json --pure --agent inbox-desk --title Inbox` in `~/.inbox/agent`. The prompt goes on stdin with the answer's JSON Schema after it (`opencode run` takes no schema). The title stops OpenCode from asking a small model to name the session.
- **Fenced** through `OPENCODE_CONFIG_CONTENT`, which OpenCode merges last over your config (one of your own is kept under it):
  - its own agent `inbox-desk`, whose permissions deny `*` and each permission by name (`read`, `edit`, `bash`, `webfetch`, `task`, `skill`, …), so they beat your global rules;
  - `mcp.<name>.enabled: false` for each MCP server `opencode debug config --pure` lists enabled (kept 5 minutes; if it can't be read, the call is refused);
  - `share: "disabled"`.
- `--pure` leaves out external plugins, which run code in the process whatever the permissions say.
- **Yours:** no `--model`, so your default model runs it.
- **Answer:** the last text part. Reviews say `opencode`. The session is deleted after it's read (`opencode session delete <id>`).
- **Errors:** status 401 (or a message about logging in) pauses the desk (``OpenCode isn't logged in. Run `opencode auth login` in a terminal.``); 429 or 402 holds what asked; anything else keeps its words. A provider with no key fails with OpenCode's "Unexpected server error", which the desk can't tell apart.
- **Login check:** `opencode auth list` counts a stored credential or a provider key set in the environment.

### The decision model (OpenRouter)

With `agent.decision_key` set (Settings → Agent → More; an OpenRouter key), an automation's question (`decide: "ask"`) and [Urgency](#urgency)'s criteria and scores go to OpenRouter's Decisions API instead of your agent. With no key, nothing in the desk calls OpenRouter.

**The request** (`src/decisions.ts`): one per item, `POST https://openrouter.ai/api/alpha/decisions` with `Authorization: Bearer <key>` and a body of `{ model, state, questions }`, nothing else. Plain `fetch`, 30 s timeout, four at once. `model` is `agent.decision_model`, default `typesafe/jev-1.14`, pinned because each release's probabilities differ.

**What leaves your computer**, to OpenRouter and the model's provider: `state` is `{ note, item }`, the item's lines as the judge's prompt words them, under a note that calls them untrusted (`Automations.lines(id, happened, true)`). That is:

- `owner/repo#number`, title, labels, the first 280 characters of the description;
- who opened it (a bot's PR, for whom), draft or not, its age and others' last activity;
- a PR's size, CI, review decision, its base when stacked, when you last pushed to your own;
- unresolved threads and who had the last word; what blocks it, what it needs that closed, what it blocks;
- how you were asked (by name, team, CODEOWNERS, by whom), how often you review the author, whether it's your repo, who else is asked, others' reviews;
- where it is on your desk (bucket, board, why), and on an event's run what just happened ("CI went from green to red; dana commented").

It leaves out the AI review's first sentence and the directories the PR touches. The key's help in Settings says this in short.

**The question:** `questions` is one question, `decision`, whose `instructions` are the automation's instruction word for word. It's a `noul` (yes or no) when the automation may do one thing, with `criteria` saying what yes means; else a `choice` of its `can` verbs and `leave`.

**The answer** is read strictly from `answers.decision`: a `noul`'s probability of yes, or a `choice`'s pick and `probabilities[pick]`. The desk acts only at 0.8 or above (`SURE`). A `leave`, a `refusal`, a missing probability or one below 0.8 leaves the item as it is. The item's why is "the decision model's answer (91% sure)", or for a yes-or-no the instruction's first line and how sure it was.

**Failures:**

- `DecisionModelError`, the run's error: a missing or mistyped answer, or any other 4xx.
- `DecisionModelDown`: 401, 402, 429, a 5xx, or no answer (unreachable, or nothing in 30 s); e.g. "OpenRouter refused the decision model's key (401). Check it in Settings → Agent.". It holds the run like a logged-out agent: not spent, nothing in it acted on (one item's failure holds the whole run), its events kept. It asks again in 30 minutes, or at once when you save another key or model.

**The key** is a `secret` setting:

- Kept in `<home>/secrets.json` (`secretsPath()`), never in `settings.json`, which people keep in a dotfiles repo.
- Written `0600` through a temporary file and a rename. Refused (nothing written) while `secrets.json` is a link or can't be read. Merged into the settings when they're read. A key found in `settings.json` moves there once at start (`Desk.migrateSecrets()`).
- Only the desk's own page sets or clears it: `PUT /api/settings` naming a secret from any other client is 403.
- An automation's agent run may not read it (`--disallowedTools Read(//<home>/secrets.json)` and the same deny rule in its folder).
- Sent only in that header, cut from any error text, never logged. `GET /api/settings`, `PUT /api/settings` and `desk settings` show a set key as `••••••••` (`SECRET_SET`); sending that back changes nothing, and `""` or a reset clears it.

## Reviews

### The AI review

Your agent writes each PR's AI review:

- a verdict (`look`, `skim`, `skip`) and a risk level;
- a summary: a short paragraph on what changes, how and why;
- concerns: what goes wrong, when, and what would fix it;
- notes anchored to lines of the diff;
- a ranking of the diff's hunks, and a walk-through;
- on a re-review, `since`.

The review document parts (`risk_reasons`, `intent`, `look`, …) are in [review-format.md](review-format.md).

**Only what holds up is kept.** Each concern and note quotes the code it's about.

1. `parseReview()` drops one whose quote isn't in that file's diff (`backed()`: every quoted line is in a diff line, ignoring whitespace, a copied `n12`/`o11` number or `+`/`-` sign, and at least one line has a letter or digit).
2. A second, separate run (`buildCheckPrompt()`, the same isolation, no tools) sees what the writer saw plus those comments with their quotes, and says for each whether the PR bears it out. Only what it says holds is kept; an unclear one isn't. A check that fails fails the review, to be tried again.
3. Then the caps (6 concerns, 12 notes counting them) and the ranking apply. Each concern is also a note on its line. `dropped` counts what steps 1 and 2 took out, and the log says it.

**How it runs.** As in [Your own agent](#your-own-agent), with the PR text fenced as untrusted. All tool-less calls share `~/.inbox/agent/`, because Claude Code keeps a `~/.claude/projects` entry per directory.

**Re-reviews.** When someone pushed since your last review (`me.pushed_since_review`), the prompt also carries the diff from the commit you reviewed to the head (`compare/<commit>...<head>`). The review then adds `since`: one sentence on what changed since you looked and whether it settles the concerns. The card shows it as its gist ("Since your review: …").

**When reviews are written.** Reviews are kept per head commit. With `review.auto_ai` on (the default), the desk writes them in the background:

- for open PRs in Now and Today, other people's and your own, drafts included, but not while handed off for merge;
- each with its stack in the prompt, bottom first;
- `review.at_once` at a time (8 by default; Settings → GitHub → More);
- in queue order, so the cards on screen are ready first.

It also writes one for any PR whose review you open.

**Held until reviewed.** Such a PR reaches the queue (`/api/queue`, `/api/focus`, the tray, `desk_list`, `desk ls`, the new-item notification) only once its first review is written. Until then `Desk.awaitsAi()` keeps it off, counted in `reviewing` (and `ItemDetail.held`), paused reviews included. Only AI reviews turned off, or this commit's review out of tries, lets one through unreviewed. Once a PR has been on the queue (kv `shown:<id>`, also set by your pin, restore or unmute) it isn't held again: a pause, a restart or a push leaves it where it is, and a new review is written while it keeps its place (its preflight says `stale`). Its notification comes when it reaches the queue; on a desk's first pass, held ones count as already there.

**Failures and retries.** Each review is a job in the ledger of [Claude's work](architecture.md#claudes-work-srcjobsts), which outlives a restart.

- A failed try (in the agent's words, or a run past 15 minutes, which the loop stops) is retried 2 and then 10 minutes later, before anything new.
- After three it's failed for that commit until you ask (Try again, Ask Claude for one, `desk brief`). Opening it or a sync doesn't restart it. With `review.auto_ai` off, a failed try is failed at once.
- Two failures in a row on different PRs (an expired login fails every PR) pause the background reviews for 30 minutes. The queue says so once (`paused`; "Claude is paused" when the cause is the login, which stops the judge too). Asking in the review still runs one.
- A success or a change to `review.auto_ai` resumes them; a settings change also retries the PRs that failed. One call that works after a login failure (a review or the judge) retries everything else that failed on the login at once.

#### Ranking

The ranking says which hunks are worth your attention, and in what order.

- The prompt numbers every hunk `h1`, `h2`, … across the files in order. A lockfile's hunks keep their numbers but aren't shown; the "since your review" diff has none.
- The agent answers `chunks`: at most 20 hunk ids in reading order (most worth first, looks before skims; on a re-review, what changed since you looked first), each with a level (`look` or `skim`) and a few words why. What it leaves out isn't worth reviewing (imports, renames, formatting, generated files, snapshots, tests that mirror the code).
- The desk keeps its order and only ids the prompt showed, each once. A hunk the agent wrote a note on but left out joins the end as a skim, so a slip can't bury what it flagged.
- A file's diff past 20 KB is cut inside the hunk that crosses it: that hunk's start is shown and counts as read, and the hunks after it are `unread`.
- Ranking costs about 20 output tokens a hunk.

`GET /api/review/:id` turns this into `order`, which clients render as is:

1. `chunks`: the ranked hunks;
2. `unread`: those the agent didn't see, with why (the PR or the file was too long);
3. `skipped`: those it left out (level `skip`, still in view: the agent's answer comes from a diff anyone can write);
4. `rest`: what the desk itself folds, by file with why (lockfiles and generated files, files with no text diff).

Each hunk has its own patch, level, rank, why and notes; `order.notes` lists the notes in reading order. `files[].patch` repeats the same text. A review from before ranking, one for an older commit, or a ranking whose ids no longer name the same files gives `ranked: false`: every hunk, file by file.

#### Walk-through (Guided Review)

The same answer carries `steps`: two to eight parts of the change in the order that makes it easiest to understand (where it starts, what builds on it, its callers, then wiring and tests). Each has a title, a sentence or two, what to check there, and the hunk ids it covers, from any files. It costs no extra call, and the checker doesn't see it.

- `parseSteps()` keeps only ids the prompt showed, each hunk in the first step naming it. It drops a step with no hunks or no title, keeps at most 8, and cuts the title at 60 characters, the body at 300 and the check at 200.
- Fewer than two steps, or steps covering under half of the ranked hunks, keep no walk-through (`guide`). The log says how many steps covered how many hunks.
- `order.steps` holds the steps with the same hunks the ranked view has; `order.beyond` holds every hunk of `chunks`, `unread` and `skipped` no step covers. So steps, `beyond` and `rest` hold every hunk once.
- A stale review, one written before steps, or steps whose ids no longer match have neither.
- Step text is untrusted and unchecked: it's drawn as text, it only orders and heads, and it never folds a hunk.

#### Opening a review

Opening a PR (`GET /api/review/:id`) asks for its AI review and has your agent read what waits on you; `?ahead=1`, the window's prefetch of the row you rest on, starts neither. After each sync the desk fetches the main page's PRs' diffs and conversations ahead, three at a time. Both are kept (the diff per head commit, the conversation until the PR updates), so a sync refetches only what changed.

**Checks** (`ReviewView.checks`, `src/checks.ts`): every check run and commit status on the head commit.

- Each has a name (untrusted), a state (`failing`, `cancelled`, `running`, `passing`, `skipped`), `optional` (the base branch requires other checks but not this one) and a `url` (https only, else `""`).
- Ordered with what's wrong first, then by name, under one line: "CI passing · 14 checks", "2 failing, 1 running of 14 checks", "1 failing (not required) of 14 checks". `failing` means a required check fails; the window draws the line red.
- A GitHub read of its own (`PR_CHECKS`, 100 a page, one point), asked only when a review is opened or fetched ahead, never by a sync. Kept until a sync next reads that PR (within 3 minutes for your own PR, 30 for someone else's, or when GitHub says it changed), so it's never older than the facts' "CI passing".
- A commit nothing ran on has `checks: null`. A fetch GitHub refuses is `checks_error`, asked again on the next open.

**Reviewers** (`ReviewView.reviewers`, `standings()` in `src/stage.ts`), from what a sync already holds:

- one line: "Approved by marco · waiting on sam and @backend", "Changes requested by kofi", "Nobody's asked";
- `changes` when someone asks for changes (the line is amber);
- each person or team with one standing, in this order: `changes requested`, `asked`, `approved`, `commented`. `verdicts()` decides approved and changes requested as the stage does (a collaborator's approval, anyone's change request, the author's own reviews aside). Teams show as `@slug`, bots are left out, and you are "you".

**Merge line:** `ReviewView.merge` is one line when something stands in an open PR's way ("Merge conflict with main", from `mergeable`, which the desk asks only of your own PRs), else `null`.

`activity` keeps the PR's recent events; a resolved PR's head line reads them.

### What reviewers said

A PR's review view carries its conversations (`ReviewView.conversation`, `src/conversation.ts`): every review thread (resolved or not, outdated or not, with its file, line and comments), the PR's comments and the reviews' bodies. Bots' comments on the PR (status reports) and empty review bodies are left out. The desk reads them once a sync sees the PR updated.

**What waits on you.** A person other than you had the last word:

- on your PR, after your last word there;
- on someone else's PR, in a thread you're in or a comment that @mentions you.

Bots never wait on you. Nor does a thread your push answered: GitHub marks it outdated, and the push that did (the commit after the last one the thread applied to) is yours and came after their last word. A force-push counts; when it took that commit away, your latest push (the head commit, if yours) stands in. A reply on a thread that was already outdated still waits on you.

**Reply on the row.** The same rule, on what a sync knows of your PR, gives its row the call to action Reply when that's all it needs: open, not in Merging, not a draft, CI not failing, no conflict, no changes requested, and not approved and green (`owesReply`).

**Your agent's read.** For each conversation waiting on you, your agent (tool-less, like the judge) reads the PR's title, description, latest commits and the conversations, with the code a thread is on, fenced with a random tag. Up to 10 a call, one PR at a time, in the background: when you open a review, and after a sync for rows that say Reply. For each it gives a one-line gist of what they want and its take ("Valid concern: …", "A nit: …", "Already addressed: …", "Only you can answer: …", "Nothing to do: …"). The take is kept per conversation until a newer comment arrives (`take:<pr>` in the store). A failure shows in the view and isn't retried on that PR for 10 minutes.

**Answering.** The reply box starts with your agent's suggestion. Reply (or ⌘↩) posts it on GitHub as you, through `POST /api/review/:id/reply`, one of the desk's GitHub writes ([Security model](#security-model)). A thread's `side` (`new`, `old` for a removed line, `null` on the PR) places it in the diff. Your own comment on a line goes through `POST /api/review/:id/inline`.

## Sorting

Rules place each item first: they're cheap and say exactly what they do. Then your agent, the judge, weighs every rule that matches it (with its weight), automations' sorts and criteria's yeses, and makes the call. Then [Urgency](#urgency) orders the Inbox into Urgent, Standard and FYI. What you want is said in rules, weights, automations and criteria. An old `~/.inbox/policy.md` is left on disk and not read; desk.log says so once.

### Rules: built in and your own

A board's rules live in `config.toml` (`parseConfig()` in `src/config.ts`). They are yours, plus its plugin's set when the board names one with `builtin`.

- A plugin declares its sets in its own file (`Connector.rules`). GitHub's are in `src/connectors/github-rules.ts`: `review`, `mine`, `mentions`, `issues` (mentions plus your own issues) and `collaborators`. Each set (`BuiltInRules`) has a name and rules, each with a stable `id`.
- Sets are code, read on every load. A release that changes a rule changes where items land on every desk whose board names the set, with nothing written to `config.toml`. A rule dropped from code is gone, and an `id` referring to it is a config error.

The file holds only your part:

```toml
[[boards]]
id = "acme-review"
# … queries, filter, caps, default
builtin = "review"                 # GitHub's rules for PRs to review
off = ["your-repo"]                # switched off
rules = [
  { when = "'ml' in item.labels", bucket = "now", why = "ML", weight = 8 },        # yours: before GitHub's, counts a lot
  { id = "bot-pr", when = "author.bot", bucket = "fyi", why = "bot PR" },         # yours, in place of GitHub's bot-pr
  { after = "stacked", when = "pr.ci == 'pending'", bucket = "later", why = "CI running" },  # yours, right after stacked
]
```

**Order** (`resolveRules()`):

1. Your rules without `id` or `after`, as written.
2. The set's rules, except those in `off`. A rule of yours with the same `id` takes that rule's place. Your rules with `after` naming it follow it, as written.

An override is the whole rule as written (`hard`, `final` and `nocap` too), not a patch. A board without `builtin` is yours alone.

**Errors:** a `builtin` the source doesn't have; an `off`, `id` or `after` naming no rule of the set; an `id` also in `off`; two of your rules with one `id`; `id` with `after`; any of these on a board without `builtin`.

**Downstream**, everything reads the resolved rules (`BoardConfig.rules`). Each keeps `id` (the set's rule, or yours in its place) and `own` (yours: its index in the file's `rules`, which a compile error names).

- `GET /api/config`'s `builtins` lists each board's set rules as they stand (`on`, and `yours` with `path` to your override).
- `PUT /api/config/builtin` switches one (`switchBuiltIn()` rewrites the board's one-line `off` and saves as `PUT /api/config` does).
- `desk_config get` lists them under the file.

**Older configs** had GitHub's rules copied onto each board. `migrateBuiltIns()` runs once (kv `builtins_migrated`, with `config.toml.bak`). A board whose rules match one set in order for at least half of it names the set. Rules equal to the set's go; one that differs only in its `when` or `why` becomes an override with that `id`; the rest keep their place with `after`; what the set has that the board didn't goes in `off`. It writes nothing unless every board's resolved rules come out exactly as before, and leaves alone a board written as `[[boards.rules]]` tables or that's mostly yours.

### The judge

Your agent triages everything that reaches the desk, after the rules.

**Placements and floors:**

- The first matching rule's bucket and why (or the board's `default` when none matched) is the judge's **hint**, and holds until it answers. `bucket = "judge"` hints the board default.
- `hard = true` is a **floor**: what it matches never sorts below the rule's bucket (Today for a Now rule), whatever the judge, the quiet rule (`queue.quiet_days`) or caps say. Now's cap still sends overflow to Today. GitHub's rules set it on your fresh drafts.
- `final = true` takes the item away from the judge: it stays in the rule's bucket (your pin's floor still lifts it; `bucket = "judge"` can't be final).
- **Your pin** is a floor too: Today or above. A pin from the coordinator's `desk_add` (`from` "Inbox coordinator") isn't: the judge sees "pinned by the coordinator" and weighs it like a signal of weight 5. A pin or unpin sorts the item again.
- Resolution still applies: a PR that's merged, closed, or approved by someone else (`github.resolve_on_others_approval`) leaves the desk ([Resolved](#resolved)).

**Signals.** For each item the judge gets every signal about it (`JudgeSignal`), not just the first rule:

- every rule that matches it, on every board that lists it (yours and GitHub's), each with its bucket, why and weight; one that's hard says so;
- an automation's sort of it (weight 8), which also stands in for the judge's answer until the judge has weighed it;
- each criterion that says yes to it ([Urgency](#urgency)).

A rule's `weight` is 0 to 10, 5 when unset (`RULE_WEIGHT`): 9 or 10 is your firm default, 6 to 8 strong, 3 to 5 a lean, under 3 a hint. GitHub's rules carry the weights that once were its starter prose:

| Weight | GitHub's rules                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| 9, 8   | a review asked of you by name (a person's ask 9, a bot's 8); a bot's PR (hide); your PR with changes requested, or approved and green |
| 7      | a team ask someone else has (FYI); your PR others wait on, ready with no review needed, or stacked                                    |
| 6      | a CODEOWNERS ping (FYI); new replies; new commits after you asked for changes; your drafts; your PR opened by a bot                   |
| 5      | a team ask (FYI), or one in your area nobody took in a day; your repo; your PR quiet, or needing a closed PR                          |
| 4      | new commits since your review; a bot added you; CI red or new activity on your PR; unresolved threads; mentions                       |
| 3, 2   | a close collaborator; a CODEOWNERS or team ask in your area; your own issue; a collaborator's new PR                                  |

A review asked of you by name is a heavy default, not a forced push: the judge can still make the call, and so can the scorer ([Urgency](#urgency)).

**The prompt** goes to your agent, tool-less, with the items fenced with a random tag. Its instructions are the judge's own, fixed in `buildJudgePrompt()` (`src/judge.ts`), the same on every desk. It asks what you should do with each item:

- `now`: a person is blocked on you today; one or two at most; never CI on your own PR.
- `today`: a person is waiting on you, or it's yours to finish (approved and green).
- `later`: yours, but nobody is blocked.
- `fyi`: someone else has it, or nobody needs you; kept off your page.
- `hide`: automated noise.

Only rules fill `blocked`: the schema leaves it out and an answer of it is dropped. The prompt says less is more and to sort away what it's unsure of. It says how to weigh signals: the heaviest usually decides, several agreeing count more than one, at equal weight your rule beats GitHub's, and a hard signal, a floor and your pin bound the answer. Reading the facts, how you were asked counts most (by name far more than through a team), then whether you usually review the author and whether it builds on what you're building; a directory you've worked in is weak evidence on its own.

An item's signals as the judge reads them:

```
  hint: the rules would put it in today on the "PRs to review" board (an ml-team ask)
  signals:
  - today, weight 7: your rule #1 on "PRs to review": an ml-team ask
  - fyi, weight 7: built-in rule team-taken on "PRs to review": asked of @ml-team; someone else has it
  - fyi, weight 5: built-in rule team on "PRs to review": asked of @ml-team
  - fyi, weight 8: automation Team reviews someone else took: someone else reviewed it for your team
  - yes: criterion About ML
```

Each item gets its hint (where the first rule put it, on which board, why), its signals, a hard rule's floor, who pinned it, and its facts, a line each:

- who opened it and when ("PR by sentry-junior (bot) for Michelle Tran");
- size, CI, review state, and "stacked on <base>" when its base isn't the default branch;
- on your own PR: how long ago you pushed, unresolved threads and who had the last word;
- how you were asked (by name and by whom, via which team, CODEOWNERS), whether you usually review the author (`author.close`), who else was asked, others' standing reviews (bots and you left out);
- for someone else's PR: how many of its files are in your areas and the directories it touches ([Your areas](#your-areas));
- the AI review's call, risk and first sentence ("of an earlier commit" when so);
- the description's first 280 characters.

Above the items, inside the fence: who you are (name, teams, the five authors you engage with most, your 20 latest PR titles) and your areas in each repo of the batch.

Each item gets back a bucket and a few words of why, which replace the hint's (an empty why keeps the rule's). Then the quiet rule and caps apply as usual, down to any floor.

**Limits and caching:**

- Up to 20 items per call, one call at a time, at most `policy.max_per_hour` items an hour (default 300; only calls that answered count).
- Never-answered items go first, then those in Now or Today, then by latest activity. Re-sorting already-answered items uses at most half the hour, so new items always have room.
- Answers are kept per item (kv `judge:<id>`, with the signals it weighed), keyed on what the judge read that can change (`judgeKey`: others' latest activity, state, draft, commit, red CI, review decision, mergeability, title, labels, review requests, people's reviews; once they arrive, its files and its commit's AI review) and on its signals' keys (`Snapshot.judging`). A bot's comment or a CI rerun asks nothing; a rule's new weight, bucket or `when`, a new automation sort or a criterion's new yes asks again for what it touches.
- A changed item keeps its old answer until the new one lands, and so does each item a rule change touches; never-answered items go first. An item the reply leaves out stays where the rules put it until it changes, and its card says "Claude gave no answer".
- `policy.judge` (default on) turns the judge off; then the rules' placements stand.

**Failures.** Until an item has an answer, or if the call fails, it sits where the rules put it. A failure (an expired login, a timeout) shows in Settings → Agent under Sort my desk with Claude and pauses the judge for 5, then 10, 20 and 60 minutes; syncs don't retry sooner. Turning `policy.judge` off and on, or changing the agent settings, tries again now. desk.log keeps the agent's own words.

**What you see.** The rule trace (`desk_item`, `desk show`, the item's detail) ends with the judge's step: `Claude: today, <why>` (plus "an earlier answer; sorting it again" while a fresh one is due), `automation <name>: fyi, <why> (Claude is weighing it)`, or `Claude: not sorted yet, so where the rules put it`. `desk_item` and `desk show` then list the signals the judge weighs and, when its answer weighed others, those (`ItemDetail.judge`). A hard rule's step names its floor (`hard rule: never below today`). The card's facts say who placed it: "sorted by Claude", "placed by a hard rule", "kept up by its pin", "not sorted by Claude yet" or "Claude gave no answer".

### Your areas

Your areas tell a CODEOWNERS ping that touches your code from one that doesn't.

**What items carry.** Every item has `body`, the first 600 characters of its description, whitespace collapsed (untrusted). A PR has `paths`, its first 50 changed files (`changed_files` counts all). Items stored before the desk asked lack them, which means unknown.

**What an area is.** A directory you work in, per repo:

- the directory of each changed file, up to four levels (`src/seer/automation/autofix/`);
- from your PRs created or merged in the last 90 days (3 points each) and the PRs you reviewed (1 point), once per PR;
- leaving out PRs of more than 100 files (codemods, renames), top-level directories alone (`src/`, `tests/`), and directories under 3 points or under a tenth of your heaviest in that repo;
- the top 40 per repo.

They're fetched on the first sync and then daily (`areas` and `areas_at` in the context, kv `context`). A failed fetch keeps the last ones and tries again in about an hour.

**Rule fields:**

- `pr.my_area_files`: how many of the PR's paths are in your areas there; -1 while either is unknown.
- `pr.my_area`: at least one.
- `pr.paths`: the first 50 paths, empty while unknown. `any(pr.paths, 'src/sentry/seer/*')` matches whatever the title says; `*` is any run of characters, `/` included.

The first-run config hints a CODEOWNERS ping into Later when `pr.my_area`, FYI otherwise. Neither is hard, so the judge has the last word. The judge's prompt reads them through `src/areas.ts`:

```ts
areasFor(ctx: Context | null, repo: string): { dir: string; weight: number }[]; // heaviest first; [] if none or unknown
touched(item: Item, ctx: Context | null): { dir: string; files: number; mine: boolean }[] | null; // yours first; null while unknown
areaFiles(item: Item, ctx: Context | null): number; // pr.my_area_files
```

as "in their areas: 2 of 5 files; touches src/sentry/auth/ (2, theirs), static/app/views/ (3)". An answer remembers whether the PR's files were known and which commit's AI review it saw, so an item sorted before either arrived is sorted again (its earlier answer holds meanwhile).

### Urgency

The Inbox's sections, Urgent, Standard and FYI, and their order come from `src/urgency.ts`. It works on what the rules, the judge and automations' sorts placed in now, today, later or fyi. Those buckets stay the rules' view (`QueueView.sections`, the rule trace, `desk_list`); `QueueView.inbox` is what the window draws.

**Criteria** (Settings → Urgency, `desk_criteria`, `/api/criteria`) are yes-or-no questions about an item.

- Yours are in kv `criteria` (`Criterion` in `src/types.ts`). A plugin's are in its file (`Connector.criteria`; GitHub's in `src/connectors/github-criteria.ts`), switched in kv `criteria_builtin`.
- Each has an id, a name, and at least one of: `when` (the rules' language, free and exact, compiled on save) and `ask` (a question for a model, asked only of items whose `when` passes). `urgent`: a yes puts the item in Urgent whatever its score. A plugin's may carry a `weight`: the points a yes adds to the desk's own score (1 unless set), and the scorer reads it as "counts 3 times".
- A criterion only orders the Inbox and never acts on an item, so one an agent saves is on at once (`by: "an agent"`). Any local client may save or delete yours; only the window switches one (403 otherwise).
- An urgent yes brings even an item the rules or the judge hid onto the Inbox.

GitHub's are rule-only, so a fresh desk sections from its first sync:

| Criterion              | Says yes when                                                                                                                                              | Urgent   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Asked by name          | `me.requested_direct`: a review asked of you by name, whoever added it; not one asked only of a team you're on. Reviewing it drops the request             | weight 3 |
| Waiting on your reply  | `me.owes_reply`, or someone else's PR you reviewed got pushes since                                                                                        |          |
| Ready to merge         | yours, approved or in a repo that needs no review, green, not a draft, not stacked or blocked, and no PR waits on it: one press merges it (`cta: "merge"`) | yes      |
| Your draft             | yours and still a draft: it waits on you to mark it Ready for review (`cta: "ready"`)                                                                      | yes      |
| Your PR others wait on | yours, other PRs need it merged first, and it's ready to merge or waits on your reply                                                                      | yes      |
| Handed back            | `me.handed_back`                                                                                                                                           | yes      |

**Outcomes.** A `when` alone is evaluated every time the desk computes its view. A question's answer is kept per item (kv `said:<id>`), keyed on the item (`sortKey()`, less the pin) and the question, so a model is asked again only when either changes; until then the item keeps its earlier answer (no, before the first). Questions go in the background, before scores:

- on the decision model when `agent.decision_key` is set (one request an item, a `noul` per question, yes at 0.8 or above);
- else one tool-less call of 20 items on your agent (`askAgent()`), the questions in your words, the items fenced.

A model that can't answer holds every question and score for 30 minutes (`Urgency.held`, shown in Settings → Urgency), and the Inbox uses what it has. Another key, model or agent, the agent working again, or saving a criterion asks at once.

**Score**, 0 to 10, for each Inbox item. The scorer gets the item as the judge's `describe()` words it, where the rules placed it and why, and each criterion's outcome by name; it answers a score and a one-line why.

- On the decision model when its key is set: a `choice` of 0 to 10; the score is the probabilities' mean, with no why.
- Else on your agent, 20 items a call, one call at a time, after the judge answered for the item.
- Kept in kv `score:<id>`, keyed on the item, its placement, the outcomes and the scorer, and held while the item stays in the bucket it was scored in.
- With `agent.score` off, or no score yet, the desk's own: the bucket's (now 7, today 6, later 3, fyi 1) plus each yes's weight, at most 10. Asked by name's 3 takes an ask in Now or Today to Urgent and one in Later to Standard; a model's score can still put it in Standard.

**Sections** (`sectionOf()`):

1. Urgent for an urgent yes or a hand-back (`snap.needs`).
2. Else FYI for what was sorted to fyi.
3. Else Urgent at `queue.urgent_at` (8) or above, FYI at `queue.fyi_at` (3) or below, Standard between. Only a kept score (`score:<id>`) sorts to FYI: without one, the rules' later sits at the cutoff, so a new desk's later items are Standard, under now and today, until the scorer answers.

A review asked of you by name, and your pin, are never below Standard, even with Asked by name off. Agents' questions and the sessions that need you lead Urgent. Each section is ordered by score, then the desk's order (`byPart()` of now and today, then later, then fyi).

Each card carries `section`, `score` and `reason`, the row's quiet why. `reason` is the first of: a hand-back's words, the urgent yeses' names, an automation's why, the score's why, the yeses' names, the rules' why.

**The first pass** (`Desk.firstPass()`, `QueueView.first_pass`). A new desk says what it's doing on its Inbox until its first minutes are through:

- `sync` until the first sync finishes: the searches done of total and items found so far (`ConnectorStatus.progress`; only the first pass tells the window of each search). "Getting your PRs from GitHub… 63 found so far".
- `sort` while the judge, a criterion's question or the scorer hasn't answered an Inbox item yet: "Sorting 120 PRs… 40 done".
- Then kv `first_pass` is `done` for good; so too once the judge or the scorer is held (its bubble says why), and on a desk that had synced before the key was kept. A failed first sync shows its bubble instead.

**The dataset.** Every answer the desk takes, a criterion's or a score's, is appended to `<home>/labels.jsonl`: `{ kind, at, by, item, input, … }` with what the model was given and what it said (`yes` and `p`; `score`, `why`, the decision model's `probabilities`). It's for distilling a cheaper model later; the desk only appends to it.

## Working for you

### The coordinator

One background agent session the desk starts and wakes (`src/coordinator.ts`, README → Coordinator); the window calls it your agent. What it does on a wake is the skill's "Coordinator" section. It's your own agent, with your MCP servers, tools and permissions, plus the desk's tools through the user-scope `inbox` server (Settings → Agent → Connect).

**What it does on a wake:**

- reads the PRs handed off for merge (`desk_merging`) and the events since its last wake (`desk_events`);
- works in a git worktree of your clone: fixes CI, addresses members' review comments, and rebases on a conflict once the PR is otherwise ready;
- pushes to the PR's own branch (`--force-with-lease` after a rebase);
- merges with `gh pr merge` once it's approved, green and conflict-free;
- notes what it did (`desk_note`, on the PR's row in Merging) and hands back what it can't finish (`desk_hand_back`).

It never posts comments or replies as you.

**What wakes it:**

- a hand-off;
- on a PR in Merging: CI finishing (green or red), a review, a comment, a conflict;
- your [asks](#asks), and your answers to its questions;
- `POST /api/coordinator/wake` (Start it now, Wake it in Merging).

News is queued one entry per PR. A minute after the first, the desk delivers it as one line of ids, URLs and kinds of change, never PR text. Queued news stays in kv `coordinator_news` until a start or resume succeeds, so a restart or a failed start keeps it. News on a merged or closed PR doesn't wake it, and a second Wake it while one runs adds nothing.

**Settings.** `agent.coordinator` off stops it, and nothing wakes it; on again resumes it once the stopped process has exited. `agent.coordinator_bypass` (default on) runs it without permission prompts.

**Status** shows in Merging as `InflightView.coordinator`: on, its id (null until started), its link, and `error`, what the agent said when it last couldn't start or resume (kv `coordinator_error`, cleared once a run succeeds). The error shows in red in Merging, with one notification when it first fails.

#### On Claude Code

**Starting.** On the first hand-off or ask, the desk runs `claude --bg --name "Inbox coordinator" --remote-control "Inbox coordinator" "<role line> <news>"` in `<home>/coordinator`.

- Before that it adds any missing rule of its deny list to the folder's `.claude/settings.json`; your own settings there stay.
- With `agent.coordinator_bypass` on it adds `--permission-mode bypassPermissions`. Deny rules still apply in every mode.
- It keeps the id it prints in kv `coordinator_bg`, with the claude.ai link from `claude logs` and `mode`: `bypass`, `default`, or `unknown` for a session picked up from its folder without being seen to start (a record without `mode` is `default`).

**Keeping it running.** When the desk starts, every 5 minutes, and when `agent.coordinator` turns on, `claude agents --json --all` finds the session. One that stopped or crashed is resumed with `claude --resume <sessionId> --bg` and no prompt, which starts no turn. With no session and nothing to deliver, it creates none. Claude's daemon runs the session, not the desk, so the desk's agent cleanup (`stopAll`) and a restart under `node --watch` leave it running.

**Delivering.** The desk reads `claude agents --json --all`:

- busy, in a shell, or on a permission prompt: it keeps the news and looks again a minute later;
- idle and running: `claude stop <id>`, then `claude --resume <sessionId> --bg "<news>"` with no other flag, so the same session continues;
- stopped: just the resume;
- gone (`claude rm`): a fresh start. It picks up only a running session from its folder, never one a mode switch left stopped.

**Switching mode.** A session keeps its permission mode across `claude --resume`. When the setting and `mode` differ, the next launch (a delivery, the 5-minute resume, or at once when the setting changes) resumes with `--name`, `--remote-control` and `--permission-mode bypassPermissions` or `default`. Claude then starts a copy with the history in that mode; the desk keeps the copy's id and mode, and the original stays stopped in `claude agents`. A busy session waits until idle; one on a permission prompt switches at once and is told to look at Merging. A session still under the old name "Review Desk coordinator" becomes one copy named "Inbox coordinator" the same way.

**Refusals**, shown as `error`:

- Bypass for `--bg` until it's been accepted once (`claude --dangerously-skip-permissions`), or under a managed `disableBypassPermissionsMode`. Turning the setting off resumes the old session as it was.
- A folder Claude Code hasn't trusted (nor one above it): ``<folder> is not a trusted directory. Run `claude` there once and accept the trust dialog, then retry.`` The desk doesn't mark folders trusted.
- A session from another folder can't be resumed (claude resumes only from a session's own folder), for instance the old home's after `~/.review-desk` moved to `~/.inbox`. `find()` stops and forgets it, and the next wake starts a fresh one.

#### On Codex

There's no background daemon (`Coordinator.runOwn()`): each turn is the desk's child process.

- **First turn:** `codex exec --json <sandbox> -C <home>/coordinator --skip-git-repo-check <off> <mcp> "<role line> <news>"`. The thread id from its first event (`thread.started`) goes in kv `coordinator_codex`, beside Claude Code's `coordinator_bg`, so switching agents keeps each one's session; the next wake goes to the chosen agent's, starting one if it has none.
- **Later turns:** `codex exec resume --json <sandbox> --skip-git-repo-check <off> <mcp> <id> "<message>"` in that folder.
- `<sandbox>`: with bypass on, `--dangerously-bypass-approvals-and-sandbox`. Off: `--sandbox workspace-write` (on a resume, `-c sandbox_mode="workspace-write"`), `-c sandbox_workspace_write.network_access=true`, `-c approval_policy="never"`.
- `<off>`: `--disable` for `apps`, `plugins`, `browser_use`, `browser_use_external`, `in_app_browser` and `computer_use`.
- `<mcp>`: each of your MCP servers off by name, as in the tool-less call, except the desk's: `-c mcp_servers.inbox.url="<the desk's /mcp>"` and `enabled=true` (`inbox_desk` when your `inbox` is another server).

**A turn.** The run that starts a turn ends once Codex names its thread, delivering what it took (news and asks dropped from the queue, asks' jobs begun). The turn goes on with `status` `busy` until it exits (an hour at most), then `idle`. Its failure (a `turn.failed` or `error` event, else stderr) is `error` in Codex's words, a login one as ``Codex isn't logged in. Run `codex login` in a terminal.``. What queued meanwhile goes as the next turn. One that exits before naming a thread fails the run, and its news stays queued. `url` is null (no Remote Control); the 5-minute look and the 10-second watch don't ask Codex anything.

**Deny rules.** Codex has no deny list. Before each start or wake the desk writes `<home>/coordinator/.codex/rules/inbox.rules`: the deny list's rules that are a command's leading words (`gh pr comment`, `gh pr review`, `gh pr ready`, `gh pr edit`, `gh issue comment`, `gh api`, `git push --force`, `git push -f`, `gh pr close|reopen|create`, `gh issue close|reopen|create|edit`) as `prefix_rule(…, decision = "forbidden")`. Rules matching a flag after the branch (`git push * -f*`, `* --force`, `* +*`) have no Codex form. Codex reads a project's `.codex/rules` only when `~/.codex/config.toml` (`$CODEX_HOME`) trusts that folder, which `-c` can't set, so an untrusted folder is `CodexUntrusted` and nothing runs ("… add `[projects."<folder>"]` with `trust_level = "trusted"` to <config>").

**What holds on Codex:** no MCP server but the desk's; those rules; with bypass off, the sandbox (it writes only in its folder and temp dirs, never a `.git` or `.codex`, so pushing to your clones needs bypass). **What doesn't:** rules a prefix can't express; a denied command inside another (`echo "$(gh api …)"`, backticks; the e2e harness saw one run); with bypass on, any sandbox.

#### On OpenCode

The same shape as Codex (`Coordinator.runOwn()`), each turn the desk's child:

- **First turn:** `opencode run --format json --pure --agent inbox-desk --title "Inbox coordinator" "<role line> <news>"` in `<home>/coordinator`. The session id (on every event) goes in kv `coordinator_opencode`.
- **Later turns:** `opencode run … --session <id> "<message>"`.
- `--auto` when `agent.coordinator_bypass` is on approves what your config says to ask about; off, nobody is there to answer, so it's refused.
- Its config holds the desk's MCP server as the tool-less call's does (yours off, `mcp.inbox` at the desk's `/mcp`, `inbox_desk` when your `inbox` is another server), and the deny list as `inbox-desk`'s bash rules (`"gh pr comment *": "deny"`, …). OpenCode matches the whole command and each part of a chain, so the flag-after-the-branch rules hold here too.
- OpenCode has no sandbox. What holds: no MCP server but the desk's, and the deny list (it reads a `$(…)` inside a command, but not a command run by `bash -c`); with bypass off, what your config asks about.
- A failure is an `error` event's words (its status first); a 401 gets OpenCode's login words.

### Asks

An ask is your words to the coordinator (`POST /api/ask`, Ask your agent in the window). It doesn't wait for the news batch:

- the desk keeps it (kv `asks`, the latest 200);
- queues one line for it in kv `coordinator_asks`;
- delivers it as soon as a run in progress is done (busy: it waits; not started: it starts it), ahead of any news in the same message.

`agent.coordinator` off refuses it. One that isn't started and won't start is a 502, and the ask is dropped. `desk_answer` stores the answer on the ask, updates the views and, on its first answer, notifies you with its first paragraph (`notify.enabled`, outside `notify.quiet`).

**The line:** `My ask <id>, about <whose> <item id> (<url>)<state>, <where>: "<your words>" Answer it with desk_answer.` Your words are flattened onto it; the desk keeps your paragraphs. Everything else is the desk's own words, never PR text (`askLine()`, from `askAbout()`), and each part comes only when you were on one:

- `<whose>`: `my PR`, `someone else's PR` or `the issue`. Yours means `me.author` (you opened it, or a bot opened it for you: [Opened for you](#opened-for-you)) or in Merging. A bot's "via" line alone never makes it yours; without GitHub context every PR reads someone else's.
- `<state>`: `, not handed off` or `, in Merging` on your open PR; `, merged` or `, closed`; `, read only: don't push to it or post on it` on someone else's; `, not on the desk now, read only: …` on an item that left the desk.
- `<where>`: `on the thread <url>`, or the lines by number and side with `(desk_ask <id> says where)`. Removed lines read `removed lines 17-18`; a range across sides `removed line 17 to line 23`. The file's name never goes in the line: `desk_ask` (`GET /api/asks/:id`) gives it fenced, with a shell-quoted `file_arg`.

For example:

- `My ask 9c1e2f3a, about my PR acme/web#3 (https://github.com/acme/web/pull/3), not handed off, on the thread https://github.com/acme/web/pull/3#discussion_r9: "confirm it's addressed" Answer it with desk_answer.`
- `My ask 9c1e2f3a, about someone else's PR acme/api#4127 (https://github.com/acme/api/pull/4127), read only: don't push to it or post on it, on lines 20-23 of its diff (desk_ask 9c1e2f3a says where): "why is the budget only checked between batches?" Answer it with desk_answer.`
- With no item, only your words: `My ask 9c1e2f3a: "…" Answer it with desk_answer.`

`Wake it` re-sends the ask with the item's state now (handed off since, merged since, or off the desk).

**Its job.** Each ask is a job in [Claude's work](architecture.md#claudes-work-srcjobsts), from when the coordinator is handed it until `desk_answer`. One it stopped without answering (idle or stopped, nothing in flight, not about to be told again) goes to it again 5 and then 15 minutes after it last went. 30 minutes after the third it's failed ("your agent stopped without answering it, 3 times"). An answered ask still waiting to go is dropped from `coordinator_asks`, so it's never asked twice.

**Lines** (`lines: { path, line, side, start?, head, note? }`) need a PR, and an ask is on a thread or on lines, not both. Each of these is a 400, and nothing is kept or sent:

- "need lines: { path, line, side: new|old, start?: { line, side }, head, note? }" (malformed);
- "lines are on a PR's diff: send its item_id";
- "lines are on a PR's diff" (on an issue);
- "an ask is on a thread or on lines, not both";
- "lines need head: the 40-character commit they were read at";
- "lines need path: a file name with no control characters" (empty, over 1,000 characters, or with a control, line-separator, bidi or other invisible character).

### Sessions

The second source (`src/connectors/sessions.ts`, [plugins.md](plugins.md)): your own Claude Code and Codex sessions on this computer that are blocked on you or stalled. They're rows on the Inbox after agents' questions.

- On by default (it only reads, and does nothing without `claude`). Settings → Sessions: `sessions.enabled`, `sessions.ask` (the model's read, below), `sessions.quiet_minutes` (25). It comes with no automations.
- It polls every 30 seconds while the desk runs, and never writes to `~/.claude`, `~/.codex` or the desktop app's folder.
- OpenCode's sessions aren't read. With OpenCode chosen, the source still lists Claude Code's and Codex's, and the model's read runs on OpenCode.

**What it reads:**

- `claude agents --json --all`: every live session and the background ones. A pass whose list can't be read changes nothing.
- The last 64 KB of each one's transcript (`~/.claude/projects/*/<session id>.jsonl`).
- The desktop app's records (`~/Library/Application Support/Claude-3p` and `Claude`, `claude-code-sessions/*/*/local_*.json`: `postTurnSummary`, `priorErrorMark`).
- A terminal transcript written in the last day that's in no list (its process is gone), unless it's a background one you removed (`~/.claude/jobs/*/state.json`).
- Codex's `state_5.sqlite`, opened read only and immutable: your unarchived `cli` and `vscode` threads from the last 3 days (never `codex exec` or sub-agents), with each rollout's last 64 KB.

Any shape it doesn't know gives no item. Nothing it reads is kept but a one-line excerpt (160 characters) in memory. `DESK_CLAUDE_HOME`, `DESK_CODEX_HOME` and `DESK_CLAUDE_APP` point it elsewhere (the tests do).

**Blocked**, from what the session shows: a permission prompt (with its tool), input, a sandbox request, a worker or a dialog; an unanswered AskUserQuestion or ExitPlanMode; a turn ended on `authentication_failed` (login expired) or billing; a background session's `state: blocked`; the desktop app's `postTurnSummary.status_category: blocked`.

**Stalled:** a turn ended on a rate limit (until `quotaLimits.resetsAt` when it says), `overloaded` or a 5xx; a background session's `state: failed`; a turn left open with no process (unless you stopped or interrupted it); the desktop app's error mark after its last turn; and, weakly, busy with nothing written for `sessions.quiet_minutes`, unless it's retrying or a subagent is working. Codex keeps no errors or approvals in its rollouts, so a Codex turn started and idle 25 minutes is all it can say.

**Asking you something.** A turn that ended normally with a question, in a terminal still open (or Codex's `task_complete`), goes to your agent (`askAgent()`, tool-less, the message's last 2 KB, at most 3 a pass), once per session and last event. It reaches the Inbox only if it's blocking; a directional question ("Want me to also…?") never does. With `sessions.ask` off, none reaches the Inbox. The desktop app's and background sessions' own reads stand instead.

**Left out:** the coordinator (`Inbox coordinator`) and anything working under the desk's home (the judge, reviews, automations).

**Actions** (`SessionCard.actions`):

| Session                | Action                                    |
| ---------------------- | ----------------------------------------- |
| background, no process | **Kick** (`POST /api/sessions/:id/kick`)  |
| terminal, process gone | **Resume in background** (the same route) |
| background, running    | **Copy attach command**                   |
| desktop app, Codex     | **Open** (`POST /api/sessions/:id/open`)  |
| terminal, running      | none                                      |

Kick reads `claude agents --json --all` again, runs the coordinator's `halt()`, then `claude --resume <id> --bg "Continue where you left off."` in the session's folder, and logs it. Done hides a session until it moves on (a later event); snooze takes a time; mute and undo work as on any item, all through `POST /api/act`.

### Automations

Your instructions, run on a schedule or on events (`src/automations.ts`, README → Automations). They're kept in kv `automations`, with their runs in kv `automation_runs` (the last 10 each).

#### Built in

A plugin comes with automations of its own (`Connector.automations`, `BuiltInAutomation` in `src/types.ts`). GitHub's, in `src/connectors/github-automations.ts`:

| Id                        | Name                           | What it does                                                                                      | On  |
| ------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------- | --- |
| `github.pick-reviewer`    | Pick a reviewer                | Your ready PR waited a workday with nobody asked by name: to your desk to pick a reviewer         | yes |
| `github.follow-up`        | Follow up on silent reviewers  | Your PR's named reviewers have been silent two workdays: to your desk to follow up                | yes |
| `github.team-reviewed`    | Team reviews someone else took | A team ask someone else already reviewed goes to FYI, unless it touches your areas                | yes |
| `github.wide-ping`        | Wide team pings                | A review asked of four or more teams, not of you by name, is hidden, unless it touches your areas | yes |
| `github.red-ci`           | Snooze while CI is red         | Your PR whose CI goes red is snoozed until CI passes                                              | no  |
| `github.mention-question` | Questions in mentions          | When someone mentions you, a model reads it and adds it if they ask you something                 | no  |

- `Automations.all()` lists yours, then a plugin's as `<plugin>.<id>` with `plugin` and `help` set and `by` "you", so everything below holds for them alike.
- Their definition is code, read each time: a release that changes one just takes effect, and one dropped from code is gone. Kv `automations_builtin` keeps only your switch per id (`{ on, at }`).
- `PUT` and `DELETE /api/automations/:id` refuse one (400). `PUT /api/automations/:id/on` switches it, from the own page only. `desk_automations` lists it, marked built in, and can't change or switch it.
- Copy to your automations in the window is a `PUT` of a new id with its definition, `on: false`.
- On a fresh desk, an event automation reads the log from the start (automations start before the first sync); a scheduled one waits for that sync.

#### What starts it

**A schedule.** Every minute and when the desk starts, each automation that's on, whose schedule parses and that isn't running, runs once if its latest due time (`dueAt`) is after both its `updated_at` and its last run's `at`. A run the desk stopped in the middle is closed with an error at the next start and doesn't count, so it runs again.

**Events** (never both; `schedule` is then `""`): a list of event kinds (`ACTIVITY_KINDS`; see [The event log](#the-event-log)).

- Kv `automation_seen` keeps the log `seq` it has read up to. It's set to the log's end when saved with events (unless it was already on with events) and stays there while off, so what happened before it watched isn't news.
- `Automations.pump()` runs when a sync pass ends (`Desk.synced()`, after the pass's blocked and unblocked events and before its new-item notification) and when one of its runs ends.
- `batch()` reads the events after that `seq`: those of its kinds, by item, up to 20 items; the rest wait for the next run. `new` and `resolved` on an item this automation itself added aren't news.
- The items the desk still holds whose check passes (in any state) are one run (`trigger: "event"`), each with a `what happened: …` line ("CI went from green to red; dana commented"). When none pass, nothing runs, no model is called and no run is kept; it reads on.
- One automation never runs twice at once: what lands during a run (Run now included) waits for the next, which starts when that one ends.
- A finished run, failed or not, moves its `seq` to its batch's end. A run the desk stopped in doesn't, so it runs again after the next start.
- A failed event run (agent logged out, a check it can't read) waits 30 minutes before the next, and its failure is notified once.

#### The check

`when` is an expression in the rules' language (`src/expr.ts`, fields from `GET /api/fields`), compiled on save (400 `when: …` otherwise) and asked per item before anything else.

- A scheduled run (or Run now) with a check is about the open items on the desk that pass it (`Automations.passing()`: on a board, not done, snoozed, muted, resolved or in Merging), latest activity first. An item it can't evaluate doesn't pass.
- None pass: nothing runs, and the run is recorded as "Nothing on your desk passed its check, so nothing ran.", so the schedule's due time is spent.
- Otherwise the run gets the first 20 (its summary says when more passed), each as the judge's `describe()` words it with where it is on the desk, between `<items-<random>>` tags after a line calling them untrusted.
- A check the desk can no longer read (a field it names is gone) fails the run.

#### How it decides

`decide` (`WAYS`), cheapest first:

- **`rule`**: no model. Every item its check passed gets the fixed action `rule: { do, why, until? }`. `until` is a snooze's, in words that mean the same every time: `1h`, `2d`, `tomorrow`, `monday`, `activity`, `ci`, `push`, `approved`, `ready`, `conflict`. It has no instruction (`prompt` is `""`).
- **`ask`**: one tool-less call over up to 20 items, the judge's mechanism, in `<home>/agent`. The prompt has the instruction between `<instruction-<random>>` tags, what each of its `can` verbs does, and the items fenced. The answer is `{ items: [{ ref, do, why, until? }] }`; with `agent.decision_key` set, [the decision model](#the-decision-model-openrouter) answers instead, one request an item. An item it leaves out stays as it is; an answer about an item it wasn't asked about, or a second one, is dropped. The summary is the desk's ("Asked Claude about 3 items; it left 1 as it is.").
- **`agent`** (the default): a run with tools ([below](#the-agent-run)).

A rule or an ask is about items, so on a schedule it needs `when` (400 otherwise). Run now of one with only events records that there's nothing to run it on.

**An ask asks only about what's new to it** on a schedule. Kv `automation_asked` keeps who it last asked (a hash of what it does and the model) and each item's `sortKey()` (less the pin) as it was asked. An unchanged item is left out ("It had asked about 3 more, unchanged since."); with nothing left, nothing runs. Run now, an event run, an edit or another model asks about all of them. An item a sync took off the desk while the decision model was being asked is skipped, and the summary names it.

**A rule or an ask adds once.** No agent remembers what a rule's or an ask's last run added, so the desk does: `pushed:<id>.once[<automation id>]` is the item's `sortKey()` (less the pin) when that automation added it. `Desk.push()` adds an item once for what it is, including one you'd marked done (restored, in the same undo step as its pin; snoozed, muted or in Merging is `left`). While the key is the same it answers `left`, so after Done or Unpin it's back only once the item changes. A scheduled rule whose action is `add` also checks the open items you marked done, since nothing else would bring one back.

**When the model can't answer** (`agentDown()`: not logged in, at its limit, or not installed; or `DecisionModelDown`), an ask's run is held, not spent: it's dropped from `automation_runs`, its events stay unread, `AutomationView.waiting` says why and when it asks again (30 minutes; `automations.held`, in memory), one notification says so, and neither schedule nor events start it before then. Saving the automation, or another key or model, ends the wait at once. An agent run that fails the same way is a failed run.

#### The agent run

On Claude Code: `claude -p --output-format json --permission-mode dontAsk --allowedTools <…> --disallowedTools Read(//<home>/secrets.json) --json-schema <{ summary, items: [{ ref, why }] }>` in `<home>/automations`.

- **Allowed:** Read, Grep, Glob, WebSearch, WebFetch; `gh`'s issue and pr list and view, pr diff and checks, search, run and release list and view, repo view; the desk's read tools (under the name Claude Code has this desk as, else `mcp__inbox__` and the old `mcp__review-desk__`).
- **Denied**, added to the folder's `.claude/settings.json` when missing: the coordinator's deny list, plus `Write`, `Edit`, `NotebookEdit`, `git push`, `git commit`, `gh`'s merge, issue transfer/delete/lock/pin, label, release writes, workflow, run rerun/cancel, repo writes, secret and variable, the desk's writing tools (`mcp__inbox__desk_<act|add|undo|config|note|hand_back|answer|inquire|inquiry|automations>`, also under `mcp__review-desk__` and the desk's own name), and reading `<home>/secrets.json`. It never asks and is refused the rest.
- **stdin:** the instruction, the read-only rules, its last good run's time and the items the desk took from it (never one it couldn't or refused).
- 20 minutes at most. An answer without a summary fails the run. The run stores the session id from claude's envelope.

On Codex (`Automations.byCodex()`): `codex exec --json --sandbox read-only --skip-git-repo-check -C <home>/automations`, with:

- the tool-less call's `--disable` flags. No shell: Codex can't allow only `gh`'s reads (an allowing rule runs a command outside the sandbox), and the read-only sandbox can read `secrets.json`;
- `-c web_search="disabled"`, `-c approval_policy="never"`;
- your MCP servers off but the desk's: `-c mcp_servers.inbox.url="<the desk's /mcp>"`, `enabled=true`, `enabled_tools=["desk_list","desk_item","desk_overview","desk_events","desk_brief","desk_merging"]` (`inbox_desk` when your `inbox` is another server). Codex connects to MCP servers itself, outside the sandbox, so the desk's localhost `/mcp` is reachable though the sandbox has no network;
- `--output-schema <file> -o <file> -`, the prompt on stdin with a line saying it has only those tools. The schema is made strict first (`strictSchema()`: each object closed, each property required, so an optional `until` comes back empty), since OpenAI refuses others with `invalid_json_schema`.

Its session is kept (no `--ephemeral`): `session` is the thread and `agent` is `codex`, so Copy resume command is `codex resume <id>`. A login or a limit fails the run in Codex's words.

On OpenCode (`opencodeRun()`): the tool-less call in `<home>/automations` with the desk's MCP server added, and `inbox-desk`'s permissions deny everything but those six read tools (`<server>_desk_list` … `allow`). Its session is kept, `agent` is `opencode`, and Copy resume command is `opencode --session <id>`.

#### What it may do

`can` lists the verbs: `add`, `today`, `later`, `fyi`, `hide`, `snooze`, `done`, `mute`. Absent, it's `add` alone, and the run answers `{ ref, why }` only. With more, the schema gives each item `do` (one of its `can`) and `until`, the prompt says what each verb does, and each item goes through `Automations.apply()` against the automation as it is then. An automation deleted or turned off during its run, a `do` the desk doesn't know, or one no longer in its `can` is `refused`, and nothing happens to the item.

**`add`** is `Desk.push()`: `hold()` (resolve, else fetch read only, as `desk_add`), then kv `pushed:<id>` = `{ automation, name, why }`.

- It answers `resolved` if resolved; `left` if not active or in Merging; `kept` if pinned or already in Now or Today; else it pins the item (undo log agent `automation:<id>`), starts its pre-review, and answers `added`. One it can't hold is `failed`.
- An automation's pin, like yours, keeps the item in Today or above. Where that pin is what puts it there (or on the Added board), the placement's why is `<name>: <its why>`.
- `done`, `snooze`, `mute` and `inflight` end an automation's pin (undo restores it). The new-item notification skips what an automation pinned.

**`today`, `later`, `fyi`, `hide`** are `Desk.sort()`: kv `sorted:<id>` = `{ automation, name, bucket, why, key, at }`, with `key` the item's `sortKey()` (the judge's `judgeKey()` less the PR's files and AI review).

- While the key holds, `compute()` gives `classify()` that sort in place of the judge's answer (a `JudgeStep` with `by`), whether the judge is on or off. A hard rule's floor, a `final` rule and your pin bind it as they bind the judge (then it's `held`, its error saying which). Caps and quiet days apply after it.
- The placement's why is `<name>: <its why>`, the card's `placed_by` is `automation`, and the trace's last step reads `automation <name>: fyi, <why>`.
- It holds only while the automation is on and its `can` still has that bucket. It ends when the item changes (`Desk.dropStaleSorts()` deletes it when a sync pass ends), when you act on the item (any `act()` but `seen`), or when the automation is deleted.
- Answers: `held` for a sort by an automation that's off; `resolved`; `left` (not active, or in Merging); `failed` (on no board); `kept` (its own sort of the item as it still is).
- Never `now` (a pin and a hard Now rule both stop at Today) and never `blocked` (only rules fill it).

**`snooze`** (with `until` in `desk_act`'s words; tomorrow without), **`done`** and **`mute`** are `Desk.clear()`: the desk's own `act()`, in the action log with agent `automation:<id>`, so `POST /api/undo` and `desk_act undo` take it back. Kv `acted:<id>` = `{ name, why, seq }` gives the card's why (`<name>: <its why>`) while that action is the item's latest and stands.

- Answers: `left` (not active, or in Merging); `resolved`; `held` when something holds the item for you, its error saying which: what the desk raised (`Snapshot.needs`: "your agent handed it back to you", "it's your ready PR nobody's asked to review"), your own pin ("your pin keeps it on your desk"; an automation's pin doesn't hold it), or a hard rule ("a hard rule keeps it in Now").

Sorts and clears act only on what the desk holds. They fetch nothing, and a ref the desk doesn't hold is `failed`.

#### Results

Each item's `outcome`:

- `added`: on your desk now.
- `did`: the desk did `do` (a sort, a snooze, done, mute).
- `kept`: already on your desk, or already sorted so.
- `left`: you'd dealt with it (done, snoozed, muted, in Merging), so it stays that way.
- `resolved`: nobody needs it now.
- `held`: its sort is kept, but a hard rule, a final rule or your pin holds it (`error` says which).
- `refused`: outside its `can`.
- `failed`: the desk couldn't (`error` says why).

`GET /api/automations` gives each run `did` ("put 2 on your desk, sorted 3 to FYI, snoozed 1") and `didnt` ("couldn't add 1, refused 2"). `outcomeText()` in `src/types.ts` words one item's outcome ("Sorted to FYI", "Snoozed until CI passes", "Not allowed") for the window and `desk_automations`. Deleting an automation stops its run in progress, which then adds and stores nothing.

**Notifications** (`notify.enabled`, outside `notify.quiet`): when a run put any on your desk (sorting into Today counts), couldn't do something, or failed. The new-item notification skips those. What it sorts away, snoozes, marks done or mutes notifies nothing.

## Items

### Stacks

A stack is PRs in one repo, each based on the head branch of the one below it, the bottom one on the default branch (or on a branch no PR heads). The desk works stacks out on every snapshot from the PRs it holds (`src/stacks.ts`, pure), whoever wrote them. Nothing about a stack is stored.

- **Links.** A PR's parent is the PR whose head branch is its base, in the repo itself (a fork's branch of the same name isn't it): an open one first, then merged, then closed. A PR GitHub moved to the default branch when the PR below it merged (its latest base change, `Item.retargeted`) keeps that merged PR as its parent.
- **Forks.** A PR with two PRs on its branch forks the stack. A line goes bottom to top and, at each fork above the current PR, takes the branch with open PRs, then the longest, then the oldest PR's. `Stack.forks` has the rest.
- **Dead branches.** A closed PR with nothing open or merged above it is in no stack. One with open PRs above it stays, closed.
- **Counting.** `StackRef.pos` and `size` count the open PRs of the line, what's still to land, so merged PRs below don't move "3/20"; the chain still lists them. A PR has a ref when it's open and its line has two or more open PRs. Two open PRs forking off a merged one aren't stacked on each other: neither has a ref, and each is its own card.
- **One line per stack.** `GET /api/queue` and `/api/focus` list a stack once (`oneLinePerStack()`). Of its members with a card in Now, Today, Later and FYI, the one in the most urgent section stands for it (the lowest on a tie, then the main line before a fork). The others leave the sections and are named on that card's `stack.folded`, bottom first. Boards, hidden, cleared and resolved list every PR. `QueueView.stacks` has the chain of every stack a card in the view carries.
- **Notifications** go per PR: a member newly in Now is news even while a lower one stands for its stack.
- **Merging.** `GET /api/inflight` keeps a stack's rows together, bottom first.

**What the desk fetches**, each sync, for the stacks of PRs on the boards (read only):

- the PR heading the branch a bottom PR is based on (or was, before GitHub moved it);
- open PRs based on an open PR's branch;
- the stack's members no board lists that are open as of a fetch over 30 minutes ago.

At most 120 probes a pass, each asked again only after 30 minutes. Probes for a stack, or for a PR based on another's branch, go first; probes that only look for a stack above a PR on the default branch get what's left after 40 are kept for later rounds. Three rounds a pass, so a chain a few PRs deep fills in at once; one repo's probes are one query, three repos at a time.

What it fetches is stored without events: it's context, not news, so the coordinator doesn't wake for it. Once a board lists such a PR, it's fetched again and its events since the desk last logged any are logged (`new` if never). Any stored member opens in the review view. Members of a listed PR's stack aren't pruned with the items no search returned for 14 days. PRs stored before the desk asked for `head_ref`, `default_branch`, `retargeted` and `requires` are refetched, 40 a pass.

### Dependencies

A PR needs another merged first when it's stacked on it ([Stacks](#stacks)) or its description says so.

**Description markers.** `requiresOf()` in `src/deps.ts` reads the whole markdown description into `Item.requires` (at most 10, case as written, in linear time on any body):

- "Requires", "Depends on", "Stacked on", "Builds on", "Blocked by", "Needs" or "Merge this after", then a link or a ref (`owner/repo#N`, `#N`);
- a checklist under "blocked on:" (checked items are done).

Quotes, code, comments, `<details>`, "once X lands", "Follow-up to" and "Merge this before X" don't count.

**Following the chain.** `dependencies()` follows those PRs through the ones the desk holds to the end of the chain, for every open PR.

- Only a PR in the same org counts, so a description can't pick a blocker elsewhere. Another org's ref stays in `pr.requires`, in full, and is never fetched.
- Refs the desk doesn't hold, and issues, never block.
- An edge that closes a loop is dropped: a PR inside a loop isn't blocked by it, and one outside that needs a member is blocked by the first it reaches.
- The desk follows at most 20 refs from each listed PR, nearest first (a description's author picks what it names).
- One the desk doesn't hold is fetched by number with the stack probes, read only and stored quietly, at most 20 a pass (not for a bot's own PR). A number that isn't a PR it can read (an issue, gone, no access) isn't asked again for a day (kv `dep_misses`).
- A stored PR another one needs isn't pruned, and is refreshed every 10 minutes while open (at most 20 a pass, the longest unfetched first).
- A PR it needs merging counts as news on it: a done or an "until activity" snooze ends then.

**Rule fields**, filled in by `Desk.compute()` (`GET /api/fields` has each one's doc):

| Field                    | Meaning                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `pr.requires`            | PRs it needs merged first, in any state                                                                     |
| `pr.blocked`             | something in its chain is still open                                                                        |
| `pr.blocked_by`          | the open PRs it needs directly                                                                              |
| `pr.blocker`             | the open PR at the end of the chain, "(through …)" when it isn't a direct need                              |
| `pr.blocker_waits`       | that PR's `pr.waits`, or "is in Merging"                                                                    |
| `pr.blocker_mine`        | an open PR in its chain waits on you (a review, your reply, your own PR's next step outside Merging)        |
| `pr.blocks`              | open PRs that need this one merged first                                                                    |
| `pr.requires_closed`     | PRs it needs that closed without merging                                                                    |
| `pr.reviewers`           | who has reviewed it (approved, asked for changes, commented); you, its author and bots left out             |
| `pr.people_requested`    | people asked by name; you and bots left out                                                                 |
| `pr.teams_requested`     | teams asked, as slugs, yours included                                                                       |
| `pr.ready_weekday_hours` | weekday hours since its latest Ready for review (`Item.ready_at`), or since opened if never a draft         |
| `pr.asked_weekday_hours` | weekday hours since the latest request to someone in `pr.people_requested`, or since it went ready if later |

They sit beside `pr.waits`, `pr.waiting_on` and `me.owes_reply`. Examples: a team's ask someone's already on is `len(pr.reviewers) > 0 || len(pr.people_requested) > 0`; a wide ping is `len(pr.teams_requested) >= 4`.

**Weekday hours** (`weekdayHours()` in `src/signals.ts`) count every hour of Monday to Friday in the desk's time zone, nights included, and none of the weekend. 24 is one workday; a PR ready at Friday 17:00 has waited 15 by Monday 08:00. Holidays count as weekdays; a weekday a clock change shortens counts 23.

- `pr.ready_weekday_hours` is -1 for a draft, an issue, a merged or closed PR, and a PR stored before the desk read `ready_at` (until its next refresh).
- `pr.asked_weekday_hours` falls back to the ready time for a request made while a draft or older than the 20 request events the desk reads. It's -1 when nobody is asked by name (a team's request, a bot's and your own don't count) and whenever `pr.ready_weekday_hours` is.
- GitHub's built-in automations Pick a reviewer and Follow up on silent reviewers read them ([Automations](#automations)).

**The first-run Blocked rules** are `final`, and only on My PRs: Blocked is for your own PRs. Boards of other people's PRs (PRs to review, Mentions, Close collaborators) have no rule for it, so a blocked PR there goes where their other rules put it (a review asked of you by name is in Now, its stage "blocked"). On My PRs:

1. `pr.blocked && pr.review != 'changes_requested' && !me.owes_reply` goes first, so a change request or a reply you owe stays yours.
2. A root that blocks others and owes a reply goes to Today ("blocks getsentry#22982 and getsentry#22983; it waits on your reply to markstory, then …"), as does one whose need closed without merging ("needs sentry#1, closed without merging").
3. Your PRs waiting on reviewers go to Blocked ("waits on a review from sam, @backend and 1 more"), with a merge conflict too ("waits on a review from cvxluo, and a merge conflict fix"). A conflict is only a signal until it's approved, when your agent rebases it. Red CI keeps such a PR out (it has its own rule).

A config with the earlier rule, which left out a conflicted PR, gets today's once (`migrateWaitsConflict`, backup in `config.toml.bak`).

### Adding

`desk_add` (`POST /api/add`, `desk add <ref>`) is "add X to my review" from any session. Nothing is written to GitHub, so agents may call it.

- **Fetching.** A PR or issue the desk doesn't hold is fetched read only (`GitHub.lookup`, then the usual details query) and stored with its events, `new` first, so the notifications feed follows it from then on. One it holds (a quietly stored stack member included) is used as it is.
- **Pinning.** Either way it's pinned. One done, snoozed or muted comes back too, logged as one `pin`: the returned `undo_seq` undoes both.
- **Pre-review.** For a PR the desk starts what opening its review would: its diff and conversations, your agent's read of what waits on you, and its AI review (with `review.auto_ai`, on someone else's PR with none for this commit). These queue with the background ones, `review.at_once` at a time, so an agent adding many doesn't start an agent run for each.
- **The Added board.** Your pins that no board places sit on a board of their own, `added` (why "you added it", Today by default). The judge sorts them like anything else, and your pin's floor keeps them in Today or above. They don't notify; you put them there.
- **From the coordinator.** A `desk_add` with `from` exactly "Inbox coordinator" (or "Review Desk coordinator") is the coordinator's opinion, not your pin: no floor, so the judge weighs it with the item's signals (and a rule's Blocked keeps it there). One no board places is on `added` too, with its why.
- **Keeping it fresh.** While a pinned item is open and no search returns it, each sync refreshes it (every 3 minutes), probes its stack, and keeps it from the 14-day prune. Once merged or closed it resolves and goes like anything else.
- **The hand-off.** `why` (one plain line) and `from` are the card's `handoff` (`{ why, from }`), shown in the review's header and the opened item ("From seer write gate: …") and given to agents in `desk_item`. They're kept in kv `added:<id>` by the seq of that pin, and shown while that pin is the item's latest and you haven't acted on the item since (undoing your action brings the hand-off back). The card's `why` stays whatever placed it.
- `desk_add` requires both `why` and `from`; `desk add <ref> [why] --from <task>` and the HTTP route take them optionally.

### Resolved

An item is resolved when the world has dealt with it. It's worked out from every snapshot and never stored, so it comes back on its own when the reason stops holding (asked again, reopened). Resolved items leave Now, Today, Later and FYI (and don't count against caps) for `QueueView.resolved`, with the reason as their `why`. Done, snooze, mute and pin are kept as they were.

The reasons, in order:

- **`merged`, `closed`:** any item.
- **`you approved`:** a PR you or your team were asked to review, whose latest verdict from you approves, while GitHub no longer asks you and nobody asked you or your team again since. It stops being yours when you're asked again, someone else pushes, or someone else acts after your latest action (`me.new_activity`: a reply, a review, an @mention). Then someone else's approval resolves it as `approved by <login>`, and anything else brings it back where its rules put it (new commits: Later, "new commits since your review"; a mention: Today on Mentions). Your own change request or a dismissed approval doesn't count. It doesn't depend on `github.resolve_on_others_approval` or on more reviews being required: your part is done.
- **`approved by <login>`:** a PR you or your team were asked to review that someone else (not you, not a bot) approved after the ask, while that's still their latest verdict. Not while your own latest review requests changes, nor while GitHub still requires more reviews. `github.resolve_on_others_approval`: `always` (default), `team_only` (only when the ask went to a team), `never`.
- **`no longer requested`:** you or your team were asked, the ask is gone, and you never reviewed.

Your own PRs and issues only resolve by merging or closing.

An item that drops out of every search gets one refresh, so the desk learns why. If it's resolved it stays on its boards (past their filters) for 3 days, under Resolved. So does one that resolved in the last 3 days, by a time the resolution itself gives, but that a search still returns while its board's filter would drop it (you approved it, and `reviewed-by:@me` still lists it). `no longer requested` has no such time, so it doesn't.

### Opened for you

A PR an agent's bot opened for you is yours wherever the desk decides "mine" (`me.author`): your PRs' boards and rules, its stage and who it's from ("you"), Ready for review, Add reviewers, Reply, the More menu's writes on your PR, Hand off for merge and Merging, the coordinator's "my PR" and the branch it may push, and the AI review it skips as yours. A review the bot asked of you on it (Junior often adds whoever asked as a reviewer) isn't one: `me.requested` and the rest read false, so rules about PRs to review never take it.

`requesterOf()` in `src/github/behalf.ts` reads who a PR's description names when the desk reads its details (`Item.requester`: `"@login"` or a name; `""` when none, or when two lines disagree). `onBehalf()` decides, in `analyze()` and in the connector, which then reads the PR as deeply and as often as your own. No model is asked. It takes all of:

- **A bot opened it:** a GitHub App (`[bot]`, GraphQL's `Bot`), or a login under Settings → GitHub → Also treat as bots (`github.bots`), which is how another agent's account counts. A person's PR is only ever its author's, whatever it says.
- **It names you** in a line the agent writes, as a whole line or Junior's block, never a mention in passing:

| Agent                                   | What it writes                                                                                                                                   | Counts when                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Junior (`sentry-junior`)                | `<!-- junior-request-attribution:start -->` `via @gricha.` `<!-- …:end -->` (older: `Requested by …`; asked by two: `via @a, **b**.`, the first) | you're assigned too, as Junior assigns whoever asked                                                                                                                            |
| Junior, no GitHub login linked          | `via **greg.pstrucha**.` in that block                                                                                                           | the name is your GitHub profile name or one in Settings → GitHub → Names agents use for you (`github.my_names`), compared by letters alone (`greg.pstrucha` is "Greg Pstrucha") |
| Devin (`devin-ai-integration`)          | `Requested by: @gricha`                                                                                                                          | you're assigned too, as Devin assigns whoever asked                                                                                                                             |
| Any bot                                 | a line of its own: `via @gricha.`, `Requested by @gricha`, `On behalf of @gricha`, maybe in `_` or `*`                                           | you're assigned too                                                                                                                                                             |
| GitHub Copilot coding agent (`Copilot`) | nothing                                                                                                                                          | you're its PR's only person assigned, as Copilot assigns whoever asked it                                                                                                       |

**Why each is safe.** Anyone with write access can edit a description, and so an assignee. So the desk takes a login only when both say it (an edit to one alone makes nothing yours), a name only when it's your profile name or one you gave, Copilot's assignee only alone, and never a person's PR. A PR that names you but doesn't assign you stays someone else's, as does one whose `via` line (`author.via`, still who a bot's PR shows it's from) names you.

**Not recognized**, for want of a marker that names a GitHub account:

- Claude's GitHub app (`claude[bot]`: "Generated with Claude Code"; its Slack runs write `_Requested by **Name** · Slack thread_` on a line with more);
- Codex (`chatgpt-codex-connector[bot]`: nothing);
- Cursor (`cursor[bot]`: its links, and `Co-authored-by` naming itself);
- Junior's automation runs (`via [automation …]`);
- `Co-authored-by` trailers, which the desk doesn't read during sync and which say who wrote a commit, not who asked.

Matching your GitHub name ("Greg Pstrucha") alone isn't safe either: anyone may share it.

The first-run My PRs board lists them too (`assignee:@me -author:@me`, the Mentions board's search, so no extra query, with `filter = "me.author"`). A config with the board as first written gets that once (`migrateOnBehalf`, backup in `config.toml.bak`). A name-only one that no search assigns you needs a query of yours, such as `"greg.pstrucha" in:body author:app/sentry-junior`.

## Your PRs

### Merging

Your own open PR, once you're done with it, goes to Merging with **Hand off for merge** (on the open item or in its review), and [the coordinator](#the-coordinator) gets it merged.

**Handing off.** `POST /api/act` with `inflight`, own page only (403 otherwise; `inflight_at` in `ItemState`).

- A draft answers 409: Ready for review is yours, so it would wait on you in Merging.
- The window offers Hand off for merge only on a PR through its review (`review` `approved` or `none`: `handsOff()` in `web/src/view.ts`), and, in a repo that needs no review, beside Add reviewers ([below](#nobodys-asked-to-review-it)). The API also takes one still waiting on its review, as the coordinator's tests and a PR whose approval a push dismissed need.
- **Back to desk** (`takeback`) brings it back. Undo (the toast's, or the API's from the own page) reverses either. Handing it off again starts afresh, without the last note or hand-back.
- Neither writes to GitHub. Done on your own PR is plain done, as anywhere.

**While it's there**, the coordinator has it:

- It leaves Now, Today, the sorted-away groups, Focus, the status line and `desk_list` for Merging (`GET /api/inflight`).
- Done, snooze and mute answer 409 (Back to desk first). A hand-off clears an earlier one, and undo brings that back.
- The judge doesn't place it.
- Each row says what it waits on (`waits_on`, the desk's call): another PR to merge first, one it needs that closed without merging, red CI, a conflict, changes requested, CI running ("can merge once CI passes: no review needed" in a repo that needs none, `review_optional` on the row), unresolved threads, a review (never in a repo that needs none), the PR below it in a stack, else "ready to merge". And the coordinator's latest note with its age.
- Merged and closed ones stay for 3 days.

**Rebasing** happens on its own. After each sync (`Desk.rebaseConflicts()`), your own PR in Now or Today that's otherwise ready to merge (approved by GitHub's review decision, not a draft, CI not red) and conflicting goes to Merging with `rebase` set and one news entry for the coordinator: `ready to merge but conflicts: rebase it onto its base, …, don't merge it; …`. (GitHub runs no `pull_request` CI on a conflicting PR.)

- Only while `agent.coordinator` is on, and only once this desk has started a coordinator (kv `coordinator_bg`).
- Its row says "rebasing" (`rebase: true`).
- When GitHub shows it mergeable (or it merges or closes), or `agent.coordinator` turns off, the desk takes it out of Merging and drops the record, back to where the rules put it.
- A PR with a Merging record isn't sent: one handed back stays handed back until it's mergeable, and Back to desk leaves `back` on the record, so it stays yours until you hand it off.
- A merge conflict alone is no rule's and notifies nobody.

**Handing back.** When the coordinator can't realistically get it merged (`desk_hand_back`: a redesign, a product decision, a reviewer who needs your answer, CI it can't fix, no local clone), the PR leaves Merging for the top of your queue with "handed back: <reason>" as its why, until you deal with it (done, or Hand off for merge again). You're notified. Nothing is written to GitHub.

- A hand-back of a PR your rules keep in Blocked waits there. Once its blocker merges it tops the queue as "unblocked: X merged · handed back: …" and notifies. Done on it drops the hand-back; the PR comes back by your rules when it unblocks.
- A PR another PR blocks isn't sent to rebase, nor handed back for having nobody asked to review it.
- The desk wakes the coordinator with "unblocked: X merged" when one in Merging unblocks (`Desk.trackBlocked()`), or "needs X, closed without merging" (`closed`: `pr.requires_closed`, joined) when what blocked it closed instead.

### Ready for review

Your own open draft has one call to action on its row and in its review: **Ready for review** (`cta: "ready"`), whatever its CI says. Getting CI green is the coordinator's job once it's ready, so the desk doesn't hold this back. The More menu offers it too (`ready`).

1. It sends `markPullRequestReadyForReview` (`POST /api/review/:id/ready`).
2. In its review, it then sends `requestReviews` for the reviewers you picked above the button. GitHub's suggested reviewers sit on the line, a click each (`GET /api/reviewers/:id` with no query); the box searches as you type, suggestions first; those already asked show and stay.
3. It logs each write and refreshes the PR.

Once someone's asked to review it (who you picked, or who was asked while it was a draft) your part is done: it leaves your desk until someone else acts (`done: true`). With nobody asked (`pr.unasked`, bots' requests and reviews aside), or when GitHub refuses the request, it isn't done (`done: false`): it stays on your desk, where [Add reviewers](#nobodys-asked-to-review-it) is its call to action and, 10 minutes on, puts it on top. It's one of the desk's GitHub writes ([Security model](#security-model)).

### Nobody's asked to review it

Your open PR that isn't a draft, that nobody is asked to review, and that nobody but bots and you has reviewed (`pr.unasked`, a rule field too) waits on nothing but you asking someone.

- A request for a bot (Copilot's, or anyone under `github.bots`) doesn't count as asked, nor does their review. A request GitHub hides from you (a team you can't see) does count. On a bot's PR opened for you, your own review doesn't count.
- Its call to action is **Add reviewers** (`cta: "reviewers"`, ahead of Reply; answering a comment doesn't make it done) from the start.
- Once nothing has touched it for 10 minutes (a workflow or CODEOWNERS asks within moments of a PR opening or going ready), while a board lists it and it isn't quiet as Later counts it (no update in `queue.quiet_days`, unless pinned), the desk puts it on top of your desk like a hand-back: Now, `handed_back`, why "nobody's asked to review it: add reviewers", in the main page's Back to you part.
- Add reviewers opens its review with the Reviewers box focused and GitHub's suggestions beside it. Ask reviewers asks who you picked (`POST /api/review/:id/reviewers`); then it's done until someone reviews.
- A request (CODEOWNERS' when you mark it ready included) or a person's review clears it.
- Ready for review from the desk with nobody asked leaves it here rather than done, so it comes back this way instead of waiting in the Archive.
- A hand-off refuses it (409: the coordinator would wait on nothing), and Hand off for merge isn't offered. One in Merging that becomes unasked (a request taken back) is handed back by the desk on the next sync with the same why, logged as the desk's (`desk`).

**A repo that needs no review** (`pr.review_optional`: GitHub gives no review decision, `review: "none"`, on a PR based on the default branch, as with no branch protection or ruleset asking for one; a stacked PR's base never asks, so it doesn't count) isn't held back by any of that:

- Add reviewers stays its call to action, with Hand off for merge beside it (`review_optional: true` on your card; Ask reviewers stays the filled button in its review).
- A hand-off takes it, and the desk doesn't hand it back for having nobody asked.
- Its `pr.waits` doesn't wait on a review, and Merging says it can merge once CI passes.
- The coordinator's wake says so on each of its lines (`NO_REVIEW` in `src/coordinator.ts`: merging on green CI is expected and low stakes), as `desk_merging` does ("no review needed").
- A draft is still Ready for review first.

### The More menu

The desk decides which GitHub actions an item offers (`Desk.actions()`, `actions` on its card) and refuses any other with 409. The window shows three of them: **Close** (a review's More and a row's right-click menu), **Re-request review** (both), **Remove me as a reviewer** (both) and **Request changes** (a review's More). A click sends it, through `POST /api/github`, a GitHub write like approve ([Security model](#security-model)).

| Item                                                                          | Offers                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your open PR, or one a bot opened for you ([Opened for you](#opened-for-you)) | close; convert to draft; a draft: ready for review; re-request review from everyone but bots who reviewed it and isn't asked now (`requestReviewsByLogin`, added to who's asked); merge now, without the coordinator, when approved, green, not stacked, mergeable and the repo's merge method is known (`mergePullRequest` with `expectedHeadOid` at the head the desk judged ready) |
| Your closed PR                                                                | reopen                                                                                                                                                                                                                                                                                                                                                                                |
| An open issue you opened or are assigned                                      | close                                                                                                                                                                                                                                                                                                                                                                                 |
| Someone else's open PR                                                        | remove me as a reviewer, when it asks you by name (a team's ask is the team's): GitHub's REST `DELETE …/requested_reviewers`, the desk's one REST write (`REST_ALLOWED`), as GraphQL has no way to; request changes, in its review only: what you write is the review's body, sent with the button or ⌘↵, pinned to the commit you read (`head_oid` required)                         |
| A PR in Merging                                                               | none (Back to desk first)                                                                                                                                                                                                                                                                                                                                                             |

- The toast's Undo, while a close's or a draft's toast is up, reopens it or marks it ready again; the others have no undo.
- From a row, a close or a merge leaves the list at once, as Done does.
- A review's approve, merge and request changes stay pinned to the commit it opened at, so a push you haven't reopened it for is refused (409).
- After a close, draft, merge or reopen the item offers nothing more until a read shows the change, so a failed refresh can't offer the same write again.

## Security model

- **This machine only, unless you turn on Tailscale.** The server listens on `127.0.0.1`, never on other interfaces. With Use it from your other devices on, it also listens on a second, free `127.0.0.1` port that only `tailscale serve` is pointed at (`overTailnet` in `src/server.ts`, `src/remote.ts`).
- **From another device, three checks, all needed.** A request is remote by the connection it came in on, never by a header (`tailscale serve` passes the client's own `Host` on, so a peer could send `Host: localhost`). A remote request must:
  1. name this machine's tailnet name as `Host` (and `Origin`, when there is one);
  2. carry `Tailscale-User-Login` with the owner's login (`app.tailscale_login`, else the login that owns this machine in `tailscale status --json`). `tailscale serve` sets it from who sent the request, strips a client's own, and leaves it off for tagged devices and Funnel. Without it, or with another's: 403;
  3. carry a paired device's token: `Authorization: Bearer` for a machine's agents and the CLI, or the `__Host-inbox` cookie (`HttpOnly; Secure; SameSite=Strict`) for a paired browser. Without a valid one: 401.

  Only `GET /pair` and the code's trade, `POST /api/pair`, skip the token, and the trade still takes the login. Codes come from this machine only (`desk pair`), one at a time, 8 characters, for 10 minutes; any try burns the code, and the trade takes five tries a minute from anyone. Tokens are 32 random bytes; the store keeps their sha256 with the device's name, when it was paired and last used, compares in constant time, and a revoked one fails on its next request. Neither a code nor a token is ever logged. From another device, own-page writes need a paired browser's session on the tailnet origin; a bearer token never counts, whatever headers it forges. Requests on this machine are checked as below; a `Tailscale-User-Login` on one changes nothing.

- **Host and Origin checks** on every route, `/mcp` included.
  - A `Host` other than `localhost`, `127.0.0.1` or `[::1]` gets 403, which blocks DNS rebinding.
  - An `Origin` other than the desk's own gets 403, which blocks other websites. The desk's own is `http://localhost:<port>`, `http://127.0.0.1:<port>`, the Vite dev server on 5173 or 5174 (or `DESK_DEV_PORT`) when `DESK_DEV=1`, or exactly `DESK_UI_ORIGIN`, which the desktop app sets for the Vite server it runs from a checkout. MCP clients and the CLI send no `Origin` and are allowed.
  - A browser request without an `Origin` (a no-cors GET, such as an `<img>` pointing at `/api/review/5`, which would start an AI run) still says `Sec-Fetch-Site`. `/api/*` and `/mcp` refuse `cross-site` and `same-site` (another localhost port). So does the UI passed through from a checkout's Vite server, for anything but a navigation, so another site can link to the desk but not load the checkout's files.
  - The hot-reload WebSocket takes the Host and Origin checks; any other Upgrade (curl `--http2`'s h2c, a socket to `/api` or `/mcp`) gets 400. Vite's `/__open-in-editor`, which opens any file in your editor, answers only its own page (`same-origin`), on Vite's port and through the desk.
  - Responses can't be framed (`X-Frame-Options: DENY`), including the Vite UI the desktop app runs from a checkout (or `npm run dev`), so a site can't frame it to click approve.
- **No auth on this machine beyond that.** Any program running as you can read the queue and triage it, as with the CLI. Handing a PR off for merge, and undoing a hand-off or a Back to desk, take the desk's own page, as approve does: the coordinator merges what's in Merging, so an agent's shell can't put a PR there.
- **Writes to GitHub, on your click.** All of the desk's GitHub writes go through `src/github/write.ts`, whose allowlist holds exactly these mutations:

  | Mutation                                                                                                                                                                                                         | Sent by                                                                            |
  | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
  | `addPullRequestReview(event: APPROVE)`, pinned with `commitOID` to the commit you read                                                                                                                           | `POST /api/review/:id/approve` (Approve)                                           |
  | `addPullRequestReviewThreadReply`, `addComment`, only to one of that PR's own conversations                                                                                                                      | `POST /api/review/:id/reply` (Reply)                                               |
  | `addComment`                                                                                                                                                                                                     | `POST /api/review/:id/comment` (Comment, on a PR or an open issue)                 |
  | `addPullRequestReview(event: COMMENT)` with one thread, pinned with `commitOID`                                                                                                                                  | `POST /api/review/:id/inline` (the `+` by a line)                                  |
  | `markPullRequestReadyForReview`, then `requestReviews` (union)                                                                                                                                                   | `POST /api/review/:id/ready` (Ready for review)                                    |
  | `requestReviews`                                                                                                                                                                                                 | `POST /api/review/:id/reviewers` (Ask reviewers)                                   |
  | `closePullRequest`, `convertPullRequestToDraft`, `markPullRequestReadyForReview`, `mergePullRequest` (with `expectedHeadOid`), `reopenPullRequest`, `addPullRequestReview(event: REQUEST_CHANGES)`, `closeIssue` | `POST /api/github`, only when the card offers it ([The More menu](#the-more-menu)) |

  These routes only take a request the browser marks `Sec-Fetch-Site: same-origin` that also carries the desk's own `Origin`. The desk's page sends both; MCP clients and the CLI send neither, so curl or an agent's shell gets 403. That's a speed bump against a shell that forges headers, not a wall. The module reads its own token, logs every write, and the desk records it in the action log (undo can't reach it). No MCP tool and no CLI command calls it. Hand off for merge, Back to desk, notes and hand-backs write nothing.

  Everything else is read only: the GitHub client runs GraphQL queries and refuses any document containing `mutation`, REST GETs for the notifications feed (it refuses any other method, so it can't mark a thread read), and `gh api` GETs for a PR's files and description. Done, snooze, mute and pin are local state in `desk.db`.

- **The coordinator is yours, not the desk's.** The desk starts and wakes it, but it's your own agent session with your permissions. What it pushes and merges, it does with your `git` and `gh`, under the rules its skill gives it: no plain force-push or reset (after a rebase only `--force-with-lease`, only to your own PR's branch), no comments or replies as you, only members' and collaborators' comments, PR text as data, a re-check before it merges. The desk gives it local tools only, and counts only a collaborator's approval in `approved_by` and `waits_on`. It writes deny rules for what it must never run into its folder (README → Coordinator; on Codex and OpenCode as in [The coordinator](#the-coordinator)). Its wake messages carry only PR ids, URLs and kinds of change, and for an ask the desk's own words with yours, never PR text.
- **Untrusted text is fenced.** Titles and AI review text come from GitHub, and a hand-off prompt template can include the title.
  - MCP results that carry them (`desk_list`, `desk_item`, `desk_brief`, `desk_events` for logins and reasons, `desk_merging` for titles and notes) put them between `<untrusted-data nonce="…">` and `</untrusted-data nonce="…">`, after a line saying to treat them as data. The nonce is random per result, so text inside can't fake the closing marker. `desk_ask` fences a line ask's file name and the branch.
  - Titles are flattened to one line with control characters removed. The CLI strips control characters, so a title can't emit terminal escapes.
  - Every tool-less agent call (the AI review, the judge, the read of what reviewers said) fences GitHub text with a random tag and runs with no tools, no MCP servers and an empty working directory. The AI review is untrusted output too: the diff it read came from GitHub.
  - The UI shows the coordinator's notes as text, never runs them.
- **The coordinator's answers are drawn from a fixed subset.** An answer is untrusted agent text (its words may come from GitHub). `src/prose.ts` draws only paragraphs, `-`/`*` and `1.` lists, `code`, ``` blocks and `**bold**`, as React elements: never HTML, never an image, never a label in place of a URL. A link is https only, without a username or password, shown as its normalised `href` (a lookalike host shows as punycode). Everything else is text. Inquiries stay text with `code` spans and URLs ([ui.md](ui.md)).
