# API

The desk server is the one process that owns your queue. The desktop app runs it, or `desk serve` does. While it runs, everything below is on `http://localhost:47823` (`DESK_PORT` changes the port): the web UI, a JSON API, a server-sent events stream, and an MCP endpoint for agents. The CLI, `desk mcp` and the web UI are all clients of it.

Types named here are in [src/types.ts](../src/types.ts), which is the source of truth.

## Connect an agent

Agents reach the queue over MCP. The desk serves it at `/mcp` whenever it runs, so there is nothing else to start.

### Your agent (Settings → Agents)

Settings → Agents shows whether Claude Code has the desk's MCP tools and the Review Desk skill ([skills/review-desk/SKILL.md](../skills/review-desk/SKILL.md)), and its **Connect** button does what's missing (`POST /api/agents/connect`). There's nothing to pick: every agent the desk runs is your own Claude Code. If you also work in Codex, the CLI gives it the same tools. From a terminal:

```bash
desk connect                   # what Claude Code is missing, and the commands that fix it
desk connect --apply           # does it
desk connect codex             # Codex instead
```

Connecting copies the skill (and refreshes a copy that differs from the repo's), then registers the MCP server if it isn't registered yet:

| Agent       | Registered when                                        | Registers with                                                                        | Skill                                   |
| ----------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------- |
| Claude Code | `~/.claude.json` has `mcpServers["review-desk"]`       | `claude mcp add --transport http --scope user review-desk http://localhost:47823/mcp` | `~/.claude/skills/review-desk/SKILL.md` |
| Codex       | `~/.codex/config.toml` has `[mcp_servers.review-desk]` | `codex mcp add review-desk --url http://localhost:47823/mcp`                          | `~/.agents/skills/review-desk/SKILL.md` |

`--scope user` makes Claude Code's entry available in every project. `claude mcp list` then shows `review-desk: http://localhost:47823/mcp (HTTP) - ✔ Connected` while the desk runs, and a failed connection while it doesn't. If you added the older stdio `review-desk` before, it already counts as registered; to switch it to HTTP, run `claude mcp remove review-desk -s user`, then Connect again. Codex reads user skills from `~/.agents/skills` ([Codex skills](https://developers.openai.com/codex/skills)).

### Your own Claude Code

Every agent the desk runs (the AI review, the judge, the coordinator, babysitters) is the `claude` CLI from your PATH under your own login (there's no setting for it: `DESK_CLAUDE` only points tests and QA at a fake), with your own model, effort and plugins: the desk passes no `--model`, no `--agents` or `--system-prompt` (the coordinator only appends its job with `--append-system-prompt`), no `--bare`, and sets no `ANTHROPIC_API_KEY` (one in the desk's own environment would reach them, as it would your own `claude -p`). What it does take away is reach: every run has `--strict-mcp-config`, so none of your MCP servers (Slack, Linear, GitHub, …) load, only the desk's own where a run has one. The AI review and the judge have no tools at all, so your settings bring only your model, effort and plugins. Babysitters keep `--restricted`, which confines their file tools to the worktree and skips your settings files, and get your `settings.json` back with `--settings` (`$CLAUDE_CONFIG_DIR` or `~/.claude`) when it exists. Each run is a process group of its own (taskkill `/T` on Windows), so stopping it stops what it started too (hooks, test runners); the desk stops every one when it closes (SIGTERM, SIGKILL 2 s later) and waits for them before it exits, so a restart under `node --watch` leaves none behind.

### The AI review

The same agent writes each PR's AI review: a verdict, a risk level, a summary, concerns, and short notes anchored to lines of the diff. Claude Code runs as `claude -p --json-schema … --tools "" --strict-mcp-config --no-session-persistence` (`claude` from your PATH), and the review says which model wrote it, as Claude Code reports it (`modelUsage`); it gets the prompt on stdin in `~/.review-desk/agent/`, an empty directory the AI review, the judge and login checks share (Claude Code keeps a `~/.claude/projects` entry per directory, so the desk has one), with the PR text fenced as untrusted. When someone pushed since your last review (`me.pushed_since_review`), the prompt also carries the diff from the commit you reviewed to the head (`compare/<commit>...<head>`), and the review adds `since`: one sentence on what changed since you looked and whether it settles the concerns, which the card shows as its gist ("Since your review: …"). Reviews are kept per head commit. With `review.auto_ai` on (the default) the desk writes them in the background for other people's open PRs in Now and Today, two at a time, in the queue's order (Now, then Today from the top, so the cards on screen are ready first), and for any PR whose review you open; a failure isn't retried on the same commit for 30 minutes unless you ask. Two failures in a row (an expired login fails every PR) pause these reviews nobody asked for, for 30 minutes: the queue says so once (`paused`; when the cause is the login, which stops the judge and the coordinator too, it says Claude is paused, as it does when either of those fails on it first), the review view says so on a PR that wasn't tried, asking with `i` (or `desk brief`) still runs, and a success or a change to `review.auto_ai` resumes them; a settings change also retries the PRs that failed. One call that works after a login failure (an AI review, the judge, the coordinator or a babysitter) retries everything else that failed on the login, without waiting out its backoff. A `claude -p` 401 reads as ``Claude Code isn't logged in. Run `claude auth login` in a terminal.``, and the log keeps Claude's own words (`401 OAuth access token has expired`).

### The policy and the judge

Claude triages everything that reaches the desk. Rules come first: they're cheap and say exactly what they do. A placement, a matching rule's bucket and why or the board's `default` when none matched, is Claude's hint, and holds until Claude answers; a rule's `bucket = "judge"` is a hint of the board default. A rule with `hard = true` is a floor: what it matches never sorts below the rule's bucket, or Today for a Now rule, whatever Claude answers (below it, the floor holds with the rule's why), and neither the quiet rule (`queue.quiet_days`) nor caps move it lower; Now's cap still sends the overflow to Today. The coordinator can't clear it either. The first-run config makes the rules for a review asked of you by name hard, so those always reach your desk: a person's ask (bucket now, so Claude picks Now or Today) and one a bot added (bucket today; Junior adds asks for people). A config written before hard rules existed gets the person's rule (`me.requested_direct && !me.requested_by_bot`, bucket now, as the first run wrote it with `nocap = true`) made hard once, and one written before the bot's rule gets it once, right after that hard rule, both with one `config.toml.bak`. Your pin is a floor too: what you pinned stays in Today or above, with or without Claude. The coordinator's pin isn't: Claude sees it ("pinned by the coordinator") and sorts by your policy, and a pin or unpin sorts the item again. Resolution still applies: a PR that's merged, closed or approved by someone else (`github.resolve_on_others_approval`) leaves the desk. The policy, `~/.review-desk/policy.md`, is prose you write in Settings → Policy, or by asking the coordinator (below), or in any editor; the desk re-reads it when it changes. While it's empty a built-in starter policy (`DEFAULT_POLICY` in `src/judge.ts`, "less is more") is in effect, so Claude sorts from the first sync; `desk_policy get` and Settings → Policy say so.

The judge sends those items to the same agent as the AI review, with the same isolation: `claude -p --json-schema … --tools "" --strict-mcp-config --no-session-persistence`, the prompt on stdin in `~/.review-desk/agent/`, the policy and the items fenced with a random tag. The prompt asks what you should do with each item (now: a person is blocked on you today, one or two at most, never CI on your own PR; today: a person is waiting on you, or it's yours to finish, approved and green or a draft of yours touched in the last two weeks; later: yours, but nobody is blocked; fyi: someone else has it or nobody needs you, kept off your page; hide: automated noise), says less is more and to sort away what it's unsure of, and gives each item its facts and its hint. When the policy's lines disagree, a line that sorts an item away for who made it or its state (bots, drafts other than your own recent ones, stacked PRs, someone else asked by name, a teammate reviewing) beats one that promotes it for what it touches, and being asked by name, a pin and a hard rule's floor beat both; what counts most is how you were asked, whether you usually review the author, and whether it builds on what you're building, while a directory you've worked in is weak evidence on its own. The facts, a line each: who opened it and when (a bot's PR opened for a person says so, "PR by sentry-junior (bot) for Michelle Tran", or "their own PR, opened through sentry-junior" when it's via you); size, CI and review state, and "stacked on <base>" when its base isn't the repo's default branch; on your own PR, how long ago you pushed and its unresolved threads with who had the last word ("cursor (bot)"); how you were asked (by name and by whom, or via which team, and whether CODEOWNERS), whether you're a usual reviewer of the author (`author.close`) and who else was asked; others' standing reviews ("approved by erin; commented frank", leaving out bots and you); for someone else's PR, how many of its files are in your areas and the directories it touches, yours marked "theirs" (see "Your areas"); the AI's pre-flight review when there is one, its call, risk and first sentence ("of an earlier commit" when it is); and the description's first 280 characters. Above the items, inside the fence, come who you are (your name and teams, the five authors whose PRs you engage with most, and the titles of your 20 latest PRs, from the context) and your areas in each repo the batch's PRs are in. The hint is where the rules would put it, on which board, and why; under a hard rule its floor ("a hard rule keeps it in today or above"), and on a pinned item who pinned it (yours: "which keeps it in today or above"). Each item gets back a bucket and a few words of why, which replace the hint's (an empty why keeps the rule's). Then the quiet rule and caps apply as usual, down to a hard rule's floor.

- Up to 20 items per call, one call at a time, at most `policy.max_per_hour` items an hour (default 300, on your own login; only calls that answered count). Never-answered items go first, then those in Now or Today (by Claude's earlier answer, else the rules), then the latest activity. Sorting again what Claude already answered uses at most half the hour, so new items always have room. `policy.judge` (default on) turns it off: then the rules' placements stand.
- Answers are kept per item, with what the judge read of it that can change (`judgeKey`: others' latest activity, bots left out; its state, draft, commit, whether CI is red, review decision, mergeability, title, labels, review requests and people's reviews; once they arrive, its files and an AI review of its commit) and the hash of the policy in effect. A bot's comment or a CI rerun asks nothing. An item that changed keeps its old answer until the new one lands, and so does every item when the policy changes: Claude sorts them all again, never-answered ones first (writing the starter out as your own changes nothing). An item the reply leaves out stays where the rules put it until it changes, and its card says "Claude gave no answer".
- Until an item has an answer, or if the call fails, it sits where the rules put it. A failure (a 401 from an expired `claude` login, a timeout) shows in Settings → Policy and pauses the judge for 5, then 10, 20 and 60 minutes; syncs don't retry sooner. Turning `policy.judge` off and on (once you've run `claude auth login`, say), or changing the agent settings, tries again now; desk.log keeps Claude's own words.
- The rule trace (`desk_item`, `desk show`, the item's detail) ends with the judge's step: `Claude: today, <why>` (with "an earlier answer; sorting it again" while a fresh one is due), or `Claude: not sorted yet, so where the rules put it`. A hard rule's step says its floor (`hard rule: never below today`). A card says who placed it in its facts: "sorted by Claude" (within a hard rule's floor too), "placed by a hard rule" (when the floor held, or until Claude answers), "kept up by its pin" (when a pin's floor held), "not sorted by Claude yet", or "Claude gave no answer".

### Your areas

What tells a CODEOWNERS ping that touches your code from one that doesn't. Every item carries `body`, the first 600 characters of its description with whitespace collapsed (untrusted GitHub text), and a PR carries `paths`, its first 50 changed files (`changed_files` counts all); items stored before the desk asked lack them, which means unknown. Your areas are the directories you work in, per repo: the directory of each changed file, up to four levels (`src/seer/automation/autofix/`), from your PRs created or merged in the last 90 days (3 points per PR) and the PRs you reviewed (1 point), once per PR, leaving out PRs of more than 100 files (codemods, renames), top directories alone (`src/`, `tests/`), and directories under 3 points or under a tenth of your heaviest in that repo, the top 40 per repo. They're fetched on the first sync and then daily, on their own (`areas` and `areas_at` in the context, kv `context`); a failed fetch keeps the last ones and tries again in about an hour.

Rules read them as `pr.my_area_files` (how many of the PR's paths are in your areas there, -1 while either is unknown) and `pr.my_area` (at least one). The first-run config hints a CODEOWNERS ping into Later when `pr.my_area` and FYI otherwise; neither is hard, so Claude has the last word. The judge's prompt reads them through `src/areas.ts`:

```ts
areasFor(ctx: Context | null, repo: string): { dir: string; weight: number }[]; // your areas there, heaviest first; [] if none or unknown
touched(item: Item, ctx: Context | null): { dir: string; files: number; mine: boolean }[] | null; // the PR's directories, yours first, then by files ("/" for top-level files); null while unknown
areaFiles(item: Item, ctx: Context | null): number; // pr.my_area_files
```

as "in their areas: 2 of 5 files; touches src/sentry/auth/ (2, theirs), static/app/views/ (3)". An answer remembers whether the PR's files were known and which commit's AI review it saw, so an item Claude sorted before its files were fetched, or before its AI review of the current commit landed, is sorted again (its earlier answer holds meanwhile).

### The coordinator

A Claude Code session the desk runs for you, wired to the desk's MCP server and nothing else. It keeps the queue clean by your policy, and it's who you talk to when you want the policy or the rules changed. Settings → Agents → Coordinator (`coordinator.enabled`, on by default) shows what it's doing, its session id and the command that opens it in a terminal.

- **Its session.** After the first sync, the desk starts it once: `claude -p --session-id <id> --name "Review Desk coordinator"` in `~/.review-desk/coordinator/`, with a system prompt saying its job, `--mcp-config` holding only the desk's own `http://127.0.0.1:<port>/mcp` (`--strict-mcp-config`), `--tools ""` (no built-in tools), `--allowedTools` with its desk tools by name (all but `desk_draft_reply` and `desk_escalate`, so a new tool isn't granted by default), and `--permission-mode dontAsk`, using `claude` from your PATH like the AI review, with your own model and settings. The id is kept in `desk.db`; its first run is told to look at the queue (`desk_overview`), so nothing from before it existed is replayed.
- **Waking.** Nothing runs while nothing happens. Events that can change what needs you (new, review requested, reviewed, commented, mentioned, assigned, reopened, unresolved, CI turning red), on anything but your PRs in Merging (Claude has those), start a run 30 s after things go quiet, or 2 minutes after the first one at the latest. A run is `claude -p --resume <id>` with the same flags and the batch on stdin, fenced as untrusted. One run at a time; events that land meanwhile go in the next one. Events from while it was turned off aren't replayed.
- **Learning.** Your own actions on items (done, snooze, mute, unmute, pin, unpin, restore, and undoing one of the coordinator's, from the UI, the CLI or your own agent; not the coordinator's, and not handing PRs off for merge) are feedback on the triage. Each action in the desk's action log says which agent took it (`agent`), so the coordinator's never read as yours. A learn run is a separate kind of run: at most every 6 hours, once 3 or more of them happened since the last one (in the last 7 days), and only when no events are waiting (those go first), the desk sends those actions, each with the item's title and where the triage has it (a hard rule, Claude, or the rules until Claude answers) and why, all fenced as untrusted. It runs as a session of its own that isn't kept (`--no-session-persistence`, not `--resume`), so no earlier wake's GitHub text is in it, with only `desk_policy` and `desk_note` allowed. It asks for the policy to be refined with `desk_policy set` where your actions disagree with it (small, general changes in your voice, a line changed only when at least two of your actions agree, and never a line that would sort away the kind of item you pinned or brought back), and what changed said in a `desk_note`. The log shows it as "Read your last 5 actions".
- **What it does.** Reads the policy (`desk_policy`), looks at the items (`desk_item`), and acts only where the policy calls for it, with `desk_act` and a `reason`, then says what it did with `desk_note`. When you ask, it rewrites the policy (`desk_policy set`) and the rules (`desk_config`: preview, show you what moves, save only on your yes). The desk refuses its rules saves during any run, and its policy saves during an event wake, which carries nothing but GitHub text (403); a learn run may save the policy. It doesn't mute (403): what it clears, done or snoozed, comes back on new activity, so a later ask by name reaches you. It can't clear what a hard rule placed (403), whatever the policy says. It can't post to GitHub or approve: those aren't among its tools. Your PRs in Merging are Claude's: it can't mark them done, snoozed or muted, draft replies, ask questions or hand them back (403), nor clear one Claude handed back, and its `desk_undo` reaches only its own actions.
- **Its log.** Every run, action (with its reason and undo), note and policy or rules change goes in its log (`GET /api/coordinator`). A policy change shows what it took out and put in (up to three lines each) and an Undo (`POST /api/policy/undo { version }`) that puts back the text from before it, while that change is still the latest; the desk keeps the last 20 versions of the policy (`policy_history` in `desk.db`), whoever changed it. When it changed Now or Today in the last day, the queue's top bar says so in one quiet line ("Coordinator snoozed 2 Today items · 4m"); a click opens the log, where each action can be undone. Housekeeping in Later and FYI stays in the log and Settings → Agents.
- **Talking to it.** `cd ~/.review-desk/coordinator && claude --resume <id> --mcp-config mcp.json` (Settings shows all of it, with a Copy button): your own Claude Code, with your own MCP servers, tools and permissions, plus the desk's server from `mcp.json`. There you're the one asking; the desk still refuses its drafts and questions on PRs in Merging. While you have it open, the desk's runs wait (it checks `claude agents --json`) and pick up the events once you close it.
- **Hygiene.** Each run is stopped after 10 minutes and killed when the desk stops; the session belongs to this desk's coordinator directory, so a desk on a copy of another desk's `desk.db` starts its own instead of resuming that desk's; every run is logged to `desk.log` and its log. A failed run (a 401, a timeout) shows in Settings and waits 5, 10, 20, then 60 minutes before the next try (turning it off and on, or changing the agent settings, tries now); a failed first run starts over with a fresh id. After a login failure the next run first makes one `--no-session-persistence` call to check the login, so failed retries don't each leave a session in `claude --resume`; babysitters do the same.
- **Why not `claude --bg`.** A background session stays up after its turn, so resuming it with the next batch would start a copy, and the desk couldn't time it out, stop it or read its errors. A `claude -p --resume` turn exits when it's done, so it costs nothing between wakes, and it's the same session you resume in a terminal.

### Claude Code over stdio (fallback)

For a client that only speaks stdio, `desk mcp` serves the same tools on stdin/stdout and calls the HTTP API of the running desk:

```bash
claude mcp add --scope user review-desk -- ~/code/review-desk/bin/desk mcp
```

### Any MCP client

- Streamable HTTP at `http://localhost:47823/mcp`. No auth, no session (stateless: no `Mcp-Session-Id`), `POST` only; `GET` and `DELETE` answer `405` because there is no server-initiated stream and no session to end.
- Or stdio: command `desk mcp` (the absolute path to `bin/desk` if it isn't on PATH; `bin/desk.cmd` on Windows), with `DESK_PORT` set if the desk isn't on 47823.
- The old HTTP+SSE transport (2024-11-05) isn't served; use stdio for clients that only have that.

## MCP tools

The same thirteen tools over HTTP and stdio. Results are text; most end with a JSON block for parsing. Errors come back as a tool result with `isError: true` and the API's message, e.g. `no item "nope#1" on the desk`, or `"sentry#1" matches 2 items — candidates: getsentry/sentry#1, other/sentry#1`. Over stdio, a desk that isn't running gives `desk is not running — start it with: desk serve`.

`ref` is `owner/repo#123`, `repo#123` when unique, or a GitHub URL.

| Tool               | Arguments                                                                                                                                                                                | Returns                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desk_overview`    | none                                                                                                                                                                                     | Counts per space and board, Focus totals, sync status and config errors; JSON `Overview`. Read only                                                                                                                                                                                                                                                               |
| `desk_list`        | `board?` (board id; omit or `"focus"` for Focus), `buckets?` (`now` `today` `later` `fyi` `hide` `cleared`; default now, today), `limit?` (1–200, default 25)                            | One line per card (bucket, id, title, why); JSON of the cards (`id bucket title why author url chips status new pinned boards`). Focus only holds now and today. Read only                                                                                                                                                                                        |
| `desk_item`        | `ref`                                                                                                                                                                                    | Facts, bucket and why on each board, the rule trace, the AI review's verdict, summary and concerns if there is one, and the review hand-off prompt; JSON `{ card, placements, state }`. Read only                                                                                                                                                                 |
| `desk_act`         | `ref`, `action` (`done` `snooze` `mute` `unmute` `pin` `unpin` `restore`), `until?` (snooze only, default `tomorrow`), `reason?` (up to 300 characters)                                  | What changed and the undo `seq`; JSON `{ ok, state: ItemState, undo_seq }`. Local only. The coordinator's actions go in its log with the reason; it can't mute                                                                                                                                                                                                    |
| `desk_undo`        | `seq?` (positive integer; default the latest action from anyone: UI, CLI or agent). Not a hand-off for merge, nor a Back to desk (yours to undo); the coordinator's only its own actions | `undid <action> on <id>`                                                                                                                                                                                                                                                                                                                                          |
| `desk_brief`       | `ref`                                                                                                                                                                                    | The PR's AI review: look, skim or skip, risk, summary, concerns and notes on the changes; JSON `AiReview`. Usually written already for PRs in Now and Today; otherwise a model call through `agent.driver` (a minute or two). Cached per commit                                                                                                                   |
| `desk_sync`        | none                                                                                                                                                                                     | `sync started`                                                                                                                                                                                                                                                                                                                                                    |
| `desk_events`      | `after?` (seq, default 0), `wait?` (seconds, 0–60, default 0), `limit?` (1–500, default 100), `item?` (a ref)                                                                            | One line per event (`#seq at item kind by actor data`), oldest first, and `last_seq` to pass as `after` next; JSON `ActivityPage`. With `wait` it returns as soon as one lands. Read only                                                                                                                                                                         |
| `desk_draft_reply` | `ref`, `thread_id?` (a review thread's node id, `PRRT_…`; omit for a comment on the PR), `body` (1–5000 characters)                                                                      | `Drafted a reply to <who> on <ref>. Not posted`; JSON `{ id, thread_id }`. Only on your own open PR in Merging, only to one of its threads whose last word isn't an outsider's; not from the coordinator, and from a babysitter only on its own PR. The draft waits in Merging for you to send; a new draft for the same thread replaces it. Local only           |
| `desk_escalate`    | `ref`, `question` (one line, up to 300 characters), `hand_back?` (true: the PR goes back to your desk; `question` says why)                                                              | In Merging (yours, open): to Now with "Claude asks: <question>" ("your agent asks" from another client), and Claude waits until you dismiss it. With `hand_back`: it leaves Merging for the top of Now with "handed back: <reason>" (it can't be merged); it writes nothing to GitHub. Not from the coordinator; from a babysitter only on its own PR. Local only |
| `desk_policy`      | `action` (`get` `set`), `text?` and `base?` (set: the whole new policy, and the hash from get)                                                                                           | get: the policy in effect fenced (the starter while policy.md is empty, and it says so), its hash and the judge's status; JSON `{ hash, starter, judge }`. set: saves it; a stale `base` is an error (get it again and redo the edit)                                                                                                                             |
| `desk_config`      | `action` (`get` `preview` `save`), `text?` (preview, save: the whole new config.toml), `base?` (save: the hash from get)                                                                 | get: config.toml fenced, its hash and errors. preview: errors, counts per board before → after, and the items that would move (titles fenced); nothing is saved. save: only valid text, and a stale `base` is an error                                                                                                                                            |
| `desk_note`        | `text` (1–500 characters)                                                                                                                                                                | `noted`: a line in the coordinator's log, which the owner reads from the queue's top bar                                                                                                                                                                                                                                                                          |

`until`: `1h`, `3h`, `2d` (any positive hours or days), `tomorrow` (09:00 local; before 05:00 it means this morning), `monday` (next Monday 09:00), `activity` (until someone else acts), `YYYY-MM-DD` (09:00 that day), or a future ISO time.

## HTTP routes

JSON in and out. Errors are `{ error: string, candidates?: string[] }` with a 4xx or 5xx status: 400 for a bad request, 404 for an unknown board, item or route, 409 for an ambiguous short ref (with `candidates`). Routes marked ✓ answer 503 until the first load finishes; if config.toml has errors from the start, those that read the queue (overview, queue, focus, boards, item, act, review, status) keep answering 503 and `/api/config` works so you can fix it. Errors in a later edit keep the last good config running.

| Method      | Path                         | Request                                                           | Response                                                                                                                                                                                                                                                                                                                                       | 503 while starting |
| ----------- | ---------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| GET         | `/health`                    |                                                                   | `{ ok: true, version: string }`                                                                                                                                                                                                                                                                                                                |                    |
| GET         | `/api/overview`              |                                                                   | `Overview`                                                                                                                                                                                                                                                                                                                                     | ✓                  |
| GET         | `/api/queue`                 |                                                                   | `QueueView`: every item once, at its best placement (the UI's main surface)                                                                                                                                                                                                                                                                    | ✓                  |
| GET         | `/api/focus`                 |                                                                   | `FocusView`: the queue's now and today                                                                                                                                                                                                                                                                                                         | ✓                  |
| GET         | `/api/boards/:id`            |                                                                   | `BoardView`                                                                                                                                                                                                                                                                                                                                    | ✓                  |
| GET         | `/api/item`                  | `?id=<ref>` (encode `#` as `%23`)                                 | `ItemDetail`                                                                                                                                                                                                                                                                                                                                   | ✓                  |
| POST        | `/api/act`                   | `{ id: string, action: Action, until?: string, reason?: string }` | `{ ok: true, state: ItemState, undo_seq: number }` (`seen` and `undo` return `undo_seq: 0`). With `X-Desk-Agent: coordinator` the action and its `reason` go in the coordinator's log                                                                                                                                                          | ✓                  |
| POST        | `/api/undo`                  | `{ seq?: number, agent?: true }` (default: the latest action)     | `{ ok: true, id: string, action: Action }`; 409 if a later action on the same item must be undone first, or for an agent (`agent`, or the coordinator's header) undoing a hand-off or Back to desk, or the coordinator undoing what it didn't do                                                                                               | ✓                  |
| GET         | `/api/review/:id`            | `:id` is `owner%2Frepo%23123` (or `owner/repo%23123`)             | `ReviewView`: the PR's facts, its changed files, the AI review and whether you can approve; 400 for an issue. Opening it asks for the AI review when `review.auto_ai` is on and there's none for this commit                                                                                                                                   | ✓                  |
| POST        | `/api/review/:id/ai`         | `{ force?: boolean }`                                             | `{ ok: true, ai: AiReview }`: the one for this commit unless `force`; joins a run already going; 502 with the reason if the agent fails                                                                                                                                                                                                        | ✓                  |
| POST        | `/api/review/:id/approve`    | `{ head_oid: string, body?: string }`                             | `{ ok: true, url: string }`: approves the PR on GitHub at `head_oid`, the commit the view showed (below), then refreshes that PR (it resolves as `you approved` within seconds) and runs a full sync; 409 for your own PR, a closed one, one you approved at this commit, or new commits since; 502 with GitHub's reason                       | ✓                  |
| POST        | `/api/sync`                  |                                                                   | `{ ok: true }` (starts a sync now)                                                                                                                                                                                                                                                                                                             |                    |
| GET         | `/api/config`                |                                                                   | `ConfigDoc`: `{ path, text, hash, errors, warnings?, hard }`; `hard`: the hard rules (board, with its space when two share a name; bucket, when, and why with fields as "someone")                                                                                                                                                             | ✓                  |
| POST        | `/api/config/preview`        | `{ text: string }`                                                | `PreviewResult`: errors, and per board the new counts and which items would move                                                                                                                                                                                                                                                               | ✓                  |
| PUT         | `/api/config`                | `{ text: string, base?: string }`                                 | `{ ok: boolean, errors: ConfigError[], warnings: ConfigError[] }`; saves only if valid, and never with a settings section (`poll_seconds`, `[signals]`, `[notify]`, `[handoff]`, `[analyze]`: they live in Settings); 409 if the file changed since `base` (the text you started from, or its `hash`); 403 from the coordinator during any run | ✓                  |
| GET         | `/api/policy`                |                                                                   | `PolicyDoc`: `{ path, text, starter, hash, judge: JudgeStatus }`; `text` is `""` until you write one, and `starter` is in effect meanwhile                                                                                                                                                                                                     |                    |
| PUT         | `/api/policy`                | `{ text: string, base?: string }`                                 | `{ ok: true, hash: string }`; writes `policy.md`; 409 if it changed since `base` (the `hash` you read); 400 over 20,000 characters; 403 from the coordinator during an event wake (a learn run may)                                                                                                                                            |                    |
| POST        | `/api/policy/undo`           | `{ version: number }`                                             | `{ ok: true, hash: string }`; puts back the policy from before that change (the coordinator log's Undo); 409 if it changed since or is undone already, 404 once the desk no longer keeps it                                                                                                                                                    |                    |
| GET         | `/api/coordinator`           |                                                                   | `CoordinatorView`: `{ status: CoordinatorStatus, log: CoordinatorLogEntry[] }`, the latest 60 entries, newest first                                                                                                                                                                                                                            |                    |
| POST        | `/api/coordinator/note`      | `{ text: string }`                                                | `{ ok: true }`; a line in the coordinator's log (`desk_note`)                                                                                                                                                                                                                                                                                  |                    |
| GET         | `/api/fields`                |                                                                   | `FieldDoc[]`: every field rules can use                                                                                                                                                                                                                                                                                                        |                    |
| GET         | `/api/settings`              |                                                                   | `SettingsView`: schema, effective values, what's overridden, GitHub status                                                                                                                                                                                                                                                                     |                    |
| PUT         | `/api/settings`              | `{ set?: Record<string, SettingValue>, reset?: string[] }`        | `{ ok: boolean, errors: ConfigError[], settings: SettingsView }`; writes nothing if any value is invalid                                                                                                                                                                                                                                       |                    |
| GET         | `/api/agents`                |                                                                   | `AgentStatus` for Claude Code: `{ driver, mcp: { connected, command } \| null, skill: { state: "installed" \| "outdated" \| "missing", path, command } \| null }`                                                                                                                                                                              |                    |
| POST        | `/api/agents/connect`        |                                                                   | `AgentStatus` after installing the skill and registering the MCP server; 502 with the command to run yourself if the agent's CLI fails or isn't on PATH                                                                                                                                                                                        |                    |
| GET         | `/api/status`                |                                                                   | `{ now: number, today: number, new: number, text: string }`; `text` is e.g. `desk 7 ●2 +3` (7 in the queue, 2 of them urgent, 3 new), `""` when 0/0                                                                                                                                                                                            | ✓                  |
| GET         | `/api/inflight`              |                                                                   | `InflightView`: your PRs in Merging, those that need you first, then any that merged or closed in the last 3 days                                                                                                                                                                                                                              | ✓                  |
| POST        | `/api/inflight/:id/draft`    | `{ body: string, thread_id?: string }`                            | `{ ok: true, draft: Draft }` (`desk_draft_reply`); 409 unless it's your open PR in Merging; 400 for an empty reply or a thread that isn't the PR's                                                                                                                                                                                             | ✓                  |
| POST        | `/api/inflight/:id/escalate` | `{ question: string, hand_back?: boolean }`                       | `{ ok: true, question: string }` (`desk_escalate`), flattened to one line; with `hand_back`, the PR leaves Merging for your desk                                                                                                                                                                                                               | ✓                  |
| POST        | `/api/inflight/:id/dismiss`  | `{ draft_id?: string }`                                           | `{ ok: true }`: discards that draft, or without `draft_id` the question; Claude looks at the PR again                                                                                                                                                                                                                                          | ✓                  |
| POST        | `/api/inflight/:id/send`     | `{ draft_id: string }`                                            | `{ ok: true, url: string }`: posts the draft on GitHub, as you (below). 403 unless it's the desk's own page (`Sec-Fetch-Site: same-origin` and its `Origin`), so only its window sends; 409 if it isn't your open PR or was sent already; 502 with GitHub's reason                                                                             | ✓                  |
| POST        | `/api/inflight/:id/handoff`  |                                                                   | `{ ok: true, state: ItemState, auto_merge: { on, why, at } }`: `m`, below. Your open PR goes to Merging, a draft is marked ready and auto-merge goes on where the repo allows it (`why` says why not). 403 unless it's the desk's own page, as for send; 409 if it isn't your open PR                                                          | ✓                  |
| POST        | `/api/inflight/:id/back`     |                                                                   | `{ ok: true, state: ItemState, auto_merge_off: boolean, error?: string }`: `b`. Claude stops, and auto-merge goes off if the desk turned it on (`error`: GitHub refused). Out of Merging, it only turns off the auto-merge `m` turned on. 403 unless it's the desk's own page; 409 if it isn't in Merging and has none                         | ✓                  |
| GET         | `/api/activity`              | `?after=<seq>&limit=<n>&item=<ref>&wait=<seconds>`                | `ActivityPage`: `{ events, last_seq }`, the event log after `after`, oldest first. A long-poll: with `wait` (up to 60) it answers as soon as an event lands; below                                                                                                                                                                             |                    |
| GET         | `/api/events`                |                                                                   | Server-sent events, below                                                                                                                                                                                                                                                                                                                      |                    |
| POST        | `/mcp`                       | MCP JSON-RPC (Streamable HTTP)                                    | JSON-RPC responses as an SSE stream; 202 for notifications                                                                                                                                                                                                                                                                                     |                    |
| GET, DELETE | `/mcp`                       |                                                                   | 405, `Allow: POST`                                                                                                                                                                                                                                                                                                                             |                    |
| GET         | anything else                |                                                                   | The web UI from `web/dist` (unknown paths get `index.html`)                                                                                                                                                                                                                                                                                    |                    |

`Action` is `done`, `snooze`, `mute`, `unmute`, `pin`, `unpin`, `restore`, `inflight` (your own open PR goes to [Merging](#merging) without the GitHub writes `m` makes), `takeback` (out of Merging), `seen` (marks it looked at; not undoable) or `undo` (undoes the latest action on that item). `until` is as for `desk_act`.

### Main types

```ts
interface Card {
  id: string; // "owner/repo#123"
  kind: "pr" | "issue";
  repo: string;
  number: number;
  title: string; // untrusted GitHub text
  url: string;
  author: string;
  author_bot: boolean;
  bucket: "now" | "today" | "later" | "fyi" | "hide";
  why: string; // the hard rule's reason, Claude's, or the rule's until Claude answers, e.g. "vaind asked you directly"
  demoted?: string; // over a board's cap: "3 from PRs to review are urgent already" (now to today), "the queue has 6 from PRs to review already" (today to later)
  board: string;
  boards: string[]; // every board it's on
  chips: string[]; // short facts: "issue", "draft", "CI red", "conflict", "changes requested", "approved", "3 unresolved", "+120 −30"
  ci: "green" | "red" | "pending" | "none";
  review: "approved" | "changes_requested" | "required" | "none";
  draft: boolean;
  size: number;
  created_at: string;
  updated_at: string;
  activity_at: string; // latest activity by someone else
  waiting_since: string;
  new: boolean; // activity since you last looked
  pinned: boolean;
  status: "active" | "done" | "snoozed" | "muted";
  snooze_until: string | null;
  verdict: "look" | "skim" | "skip" | null; // from the AI review of the current commit
  preflight?: Preflight; // Now and Today cards only
  next?: string; // your own PR in Now or Today: "merge conflict with main: m hands it off for merge"; none in Merging or approved and green
  checks_failed?: string[]; // your own PR in Now or Today: its failing checks
  checks_optional?: string[]; // those its base branch doesn't require; CI isn't "red" for these alone
  reply?: Draft; // your PR in Merging: the first reply waiting for Send (y, twice, sends it from the queue)
  escalated?: boolean; // your PR in Merging: Claude (or the desk) asked you something; x dismisses it from the queue
  resume?: string; // ...and the command that opens Claude's session (c copies it)
  handed_back?: boolean; // your PR, back from Merging because Claude can't get it merged: at the top of Now, its why says why
  desk_auto_merge?: boolean; // your open PR out of Merging with the auto-merge m turned on still on: b turns it off
  last_event?: ActivityEvent; // an issue in Now or Today: its latest event
  involved?: string; // an issue in Now or Today: how you're on it ("assigned to you", "you were mentioned")
  resolved: string | null; // why it needs nobody now: "merged", "closed", "you approved", "approved by alice", "no longer requested"
  resolved_at: string | null; // when it resolved (its last update when GitHub doesn't say); null while it's open
  inflight: boolean; // your open PR, in Merging
  placed_by?: "hard" | "pin" | "claude" | "pending" | "unanswered"; // a hard rule, a pin's floor, Claude, the rules until Claude answers, or since it gave no answer; unset with the judge off and in Merging
}

// The AI review of a card's head, for skimming. The other fields come from the latest review, for an older head unless ready.
interface Preflight {
  state: "ready" | "stale" | "running" | "queued" | "paused" | "off" | "none"; // stale: a new one is coming; off: review.auto_ai is off; none: an issue or your PR
  verdict?: "look" | "skim" | "skip";
  risk?: "low" | "medium" | "high";
  summary?: string;
  concerns?: string[]; // at most 2
  notes?: number;
  at?: string;
}

interface QueueView {
  sections: { now: Card[]; today: Card[]; later: Card[]; fyi: Card[] };
  hidden: Card[]; // a rule put it in "hide"
  cleared: Card[]; // done, snoozed, muted
  resolved: Card[]; // the world dealt with it (see Resolved, below); newest first
  cards: number; // queue.cards: the queue is one list, now's cards then today's (each the weightiest first); it shows this many, the rest behind one line; 0 = all
  paused: { who: "claude" | "ai"; why: string } | null; // said once above the queue: claude, when the AI review, the judge or the coordinator can't log in; ai, when AI reviews nobody asked for keep failing otherwise
}
// BoardView is the same for one board, plus board: BoardSummary & { queries: string[] }, without resolved items.
// FocusView is { sections: { now: Card[]; today: Card[] }, cards, paused }; resolved items are never in it.

interface Overview {
  me: string;
  synced_at: string | null;
  syncing: boolean;
  sync_error: string | null;
  config_errors: { path: string; message: string }[];
  connectors: { id: string; name: string; status: "ok" | "syncing" | "paused" | "error"; synced_at: string | null; error: string | null }[]; // GitHub today
  spaces: { id: string; name: string; boards: BoardSummary[] }[]; // BoardSummary: id, name, space, counts per bucket + cleared, new, error?
  focus: { now: number; today: number; new: number };
  inflight: { total: number; needs_you: number }; // your open PRs in Merging, and how many need you
  rate_limit: { remaining: number; reset_at: string } | null;
  coordinator: { state: "off" | "idle" | "waiting" | "running" | "error"; acted: CoordinatorActed | null }; // acted: its latest run with actions in the last day, for the top bar
}

interface Placement {
  board: string;
  bucket: Bucket; // after the judge, quiet and caps
  rule_bucket: Bucket; // before quiet and caps
  rule: number | null; // the matched rule, null = the board default
  why: string;
  demoted?: string;
  trace: TraceStep[];
  hard?: boolean; // a hard rule matched it
  floor?: Bucket; // ...so it never sorts below this (Today for a Now rule)
  judge?: { bucket: Bucket | null; why: string; pending: boolean }; // while the judge is on; bucket null: where the rules put it
  hint?: { bucket: Bucket; why: string }; // with judge: where the rules put it
}

interface PolicyDoc {
  path: string;
  text: string; // policy.md; empty means the starter is in effect
  starter: string; // the built-in starter policy
  hash: string; // of the policy in effect; pass it back as `base`
  judge: JudgeStatus; // state off | idle | running | error, off_reason, waiting, judged, spent and max_per_hour this hour, last_at, error, retry_at
}

interface CoordinatorStatus {
  state: "off" | "idle" | "waiting" | "running" | "error";
  off_reason: string | null; // e.g. "Coordinator needs Claude Code for now"
  session_id: string;
  started: boolean; // its first run made the session
  dir: string; // ~/.review-desk/coordinator: Claude Code keeps sessions per directory
  command: string | null; // opens it in a terminal; null until it's started
  running_since: string | null;
  pending: number; // events waiting for the next run
  next_at: string | null;
  last_run: {
    n: number;
    kind: "intro" | "events" | "learn"; // learn: it read your own actions, to refine the policy
    started_at: string;
    ms: number;
    ok: boolean;
    events: number; // a learn run: your actions it read
    actions: number;
    error: string | null;
  } | null;
  error: string | null; // the last run's failure, until one succeeds
  held: boolean; // you have it open in a terminal, so runs wait
}

interface CoordinatorLogEntry {
  seq: number;
  at: string;
  run: number; // 0: while you talk to it
  kind: "run" | "act" | "note" | "policy" | "config";
  text: string; // an action's reason, a note, what a run did, a policy change's "− out" and "+ in" lines; its own words, so untrusted
  item_id: string | null;
  action: string | null;
  bucket: Bucket | null; // where the item sat when it acted
  undo_seq: number | null;
  version: number | null; // a policy change the desk still keeps: Undo (POST /api/policy/undo) puts back the text before it
  undone: boolean;
}

interface ItemDetail {
  card: Card;
  item: Item; // the normalized GitHub item
  signals: Signals; // every field rules can read
  placements: Placement[]; // per board: bucket, rule, why, and the rule trace
  state: ItemState; // done_at, snooze_until, snooze_on_activity, muted, pinned, seen_at
  handoff_prompt: string;
  ai: AiReview | null;
  ai_stale: boolean; // new commits since the AI review
  generating: boolean;
  activity: ActivityEvent[]; // the item's last 8 events, newest first
}

interface ReviewView {
  card: Card;
  item: Item;
  handoff_prompt: string;
  files: { path: string; previous_path: string | null; status: string; additions: number; deletions: number; patch: string | null }[];
  files_error: string | null; // the diff couldn't be fetched
  ai: AiReview | null; // the latest, even if stale
  ai_stale: boolean;
  ai_error: string | null; // the last failed attempt on this commit, or why AI reviews are paused
  generating: boolean;
  approve: { ok: boolean; reason: string | null }; // reason: why not, e.g. "it's your PR"
  activity: ActivityEvent[]; // the PR's last 8 events, newest first
}

interface AiReview {
  verdict: "look" | "skim" | "skip";
  risk: "low" | "medium" | "high";
  summary: string;
  concerns: string[];
  notes: { path: string; line: number; side: "new" | "old"; body: string }[]; // line 0: about the whole file
  head_oid: string; // the commit it read
  model: string; // as Claude Code reports it ("claude-opus-5[1m]"), else "claude-code"
  at: string;
}

interface ActivityEvent {
  seq: number; // increasing; pass the last one you saw as `after`
  at: string; // when it happened if GitHub says (a review, a comment, a merge), else when the desk noticed
  source: string; // the connector: "github"
  item_id: string; // "owner/repo#123"
  kind: ActivityKind; // below
  actor: string; // login, "" if unknown
  data: Record<string, string | boolean>;
}

interface ActivityPage {
  events: ActivityEvent[]; // oldest first
  last_seq: number; // the last event's seq, or the log's latest when there are none: the next call's `after`
}

interface InflightRow {
  card: Card;
  state: "open" | "merged" | "closed";
  base: string;
  ci: "green" | "red" | "pending" | "none";
  failing: string[]; // failing check names
  approved_by: string[];
  changes_by: string[]; // changes requested by
  waiting_on: string[]; // asked and not heard from; teams as @slug
  threads_unresolved: number;
  mergeable: "clean" | "conflict" | "unknown";
  draft: boolean;
  needs_you: string | null; // why it needs you: "Claude asks: <question>", "reply ready to send", "CI failing; Claude couldn't fix it", "ready to merge" (auto-merge isn't on)
  escalation: { question: string; at: string } | null;
  sitter: { state: "running" | "queued" | "done" | "waiting" | "blocked" | "idle"; text: string; since: string | null }; // "fixing CI", "pushed a fix for 2 comments · abc1234"
  drafts: Draft[]; // unsent: { id, thread_id, to: "dana on src/api.ts:12", quote, body, at, sent_at, url }
  run: SitterRun | null; // the latest run: session id, why, outcome, pushed_oid, summary, step, log path
  resume: string | null; // `cd <worktree> && claude --resume <session>`
  auto_merge: boolean; // GitHub's auto-merge is on: it merges once it's approved and green
  merge_note: string | null; // why it isn't ("the repo doesn't allow auto-merge"): you merge it
}
// InflightView is { rows: InflightRow[]; babysitting: boolean } (inflight.babysit: off, Merging says so once).
```

## Resolved

An item is resolved when the world has dealt with it. It's worked out from every snapshot, never stored, so it comes back on its own when the reason stops holding (asked again, reopened). Resolved items leave Now, Today, Later and FYI (and don't count against caps) for `QueueView.resolved`, with the reason as their `why`; done, snooze, mute and pin are kept as they were. The reasons, in order:

- `merged`, `closed`: any item.
- `you approved`: a PR you or your team were asked to review whose latest verdict from you approves, while GitHub no longer asks you and nobody asked you or your team again after that approval. Asked again (a re-request), new commits from someone else, or someone else acting after your latest action (`me.new_activity`: a reply, a review, an @mention), it stops being yours: someone else's approval resolves it as `approved by <login>`, anything else brings it back to wherever its rules put it (new commits: Later, "new commits since your review"; a mention: Today on Mentions). Your own changes request or a dismissed approval doesn't count. It doesn't depend on `github.resolve_on_others_approval` or on more reviews being required: your part is done.
- `approved by <login>`: a PR you or your team were asked to review that someone else (not you, not a bot) approved after the ask, while that's still their latest verdict. Not while your own latest review requests changes, nor while GitHub still says more reviews are required (another approval, or a code owner's). `github.resolve_on_others_approval`: `always` (default), `team_only` (only when the ask went to a team), `never`.
- `no longer requested`: you or your team were asked, the ask is gone, and you never reviewed.

Your own PRs and issues only resolve by merging or closing. An item that drops out of every search gets one refresh so the desk learns which it was; if it's resolved it stays on its boards (past their filters) for 3 days, under Resolved. So does one that resolved in the last 3 days, by a time the resolution itself gives, but is still in a search its board's filter would now drop it from (you approved it: `reviewed-by:@me` still lists it); `no longer requested` has no such time, so it doesn't.

## Merging

Your own open PR, once you're done with it: `m`, pressed twice as it writes to GitHub, in the queue, on the open item or in its review hands it off for merge (`POST /api/inflight/:id/handoff`; `inflight_at` in `ItemState`), and Claude gets it merged. `b` brings it back to your desk (`POST /api/inflight/:id/back`), which stops Claude and removes its worktree; undoing that (`u`, the API's undo) brings back its drafts and question, and handing it off again later starts afresh. `d` on your own PR is plain done, as on anything else. A hand-off leaves Now, Today and the sorted-away groups for the Merging tab (`GET /api/inflight`), and comes back to the top of Now only when it needs you, with the reason as its why ("merging: reply ready to send", or "Claude asks: …" for a question, so it doesn't read like a reviewer's): a question from Claude, a reply ready to send, comments from outside contributors (nobody else will read them), a problem nobody is fixing (Claude off, a run that failed), or "ready to merge" (approved, green and conflict-free while auto-merge isn't on). Merged and closed ones stay in Merging for 3 days. While it's there Claude has it: done, snooze and mute answer 409 (`b` first; a hand-off clears an earlier one, and undo brings that back), the judge doesn't place it, and its events don't wake the coordinator.

- **Auto-merge.** On `m`, with `inflight.auto_merge` on (the default) and the repo allowing it (`autoMergeAllowed`), the desk marks a draft ready for review (`markPullRequestReadyForReview`) and turns on GitHub's auto-merge with your default merge method (`enablePullRequestAutoMerge`, `viewerDefaultMergeMethod`), so GitHub merges it once it's approved and green. Otherwise nothing is written, and the row says why ("the repo doesn't allow auto-merge", "auto-merge is off in Settings", GitHub's refusal): merge it yourself when it's green. Auto-merge that was on already is left alone, unless an earlier `m` turned it on: that stays the desk's. `b` turns off (`disablePullRequestAutoMerge`) only what `m` turned on, and only while GitHub still has it on; a draft it marked ready stays ready. Out of Merging (handed back, done, or the hand-off undone), the card keeps a `b` that only turns that auto-merge off. A `b` while `m`'s writes are on their way stops the ones not yet sent. Undo doesn't touch GitHub.
- **Handing back.** When Claude can't realistically get it merged, the PR leaves Merging for your desk, at the top of Now with "handed back: <reason>" as its why, until you deal with it (done, or `m` again): Claude decides that for a reviewer who wants a redesign, a product decision or CI it can't fix (`desk_escalate` with `hand_back`), and the desk for a fork's branch, a branch name it won't pass to git, no local clone, or CI still red after 3 runs. A hand-back writes nothing to GitHub: auto-merge stays as it was, and the card says "auto-merge still on", with `b` to turn off what `m` turned on. The coordinator can't clear a PR Claude handed back (403). A question, unlike a hand-back, keeps the PR in Merging: once you answer it, Claude carries on.

### Claude (babysitters)

With `inflight.babysit` on (the default), the desk starts an agent, a babysitter, for a PR in Merging that needs work: CI red, a merge conflict, or feedback from a collaborator (an open thread whose last word is theirs, changes requested, a review or comment since you marked it). A collaborator is someone GitHub calls the repo's OWNER, MEMBER or COLLABORATOR (`authorAssociation`), or a bot listed in `inflight.trusted_bots` (none by default). Anyone else's feedback never reaches an agent: the PR comes back to Now with "comments from outside contributors" until you dismiss it (`x`), and no run starts for it. It looks when the event log says something happened to the PR (a few seconds after, so a burst lands first), when you mark it, at start, and every 10 minutes. Each problem is tried once (per head commit for CI and conflicts), red CI at most 3 times in a row; at most `inflight.max_agents` (default 2) run at once, one per PR, the rest wait. Turning `inflight.babysit` off stops the ones running.

- **Agent.** Your own Claude Code (`claude` from your PATH). One `claude -p` per run with its own `--session-id` and `--name "desk: owner/repo#123"`, the prompt on stdin, stream-json output kept under `~/.review-desk/babysit/` (14 days), a 30-minute limit, killed with its process group (SIGTERM, then SIGKILL 10 s later) when it times out, when the PR goes back to your desk, when it merges or closes, and when the desk stops (then SIGKILL comes after 2 s). Merging's `c` copies `cd <worktree> && claude --resume <session>` to open the session yourself. `claude --bg` would let you `claude attach` while it runs, but a background session doesn't exit, report its result or fail visibly on a bad login, so the desk couldn't time it out, count it or say what it did; that's a later change.
- **Flags.** `--restricted` (file tools confined to the worktree, no project or user settings files), `--settings` with your own `settings.json` (`$CLAUDE_CONFIG_DIR` or `~/.claude`) when it exists, so your model, effort and plugins apply, and so do its permission rules and hooks, `--tools Bash,Read,Edit,Write,Glob,Grep`, `--permission-mode dontAsk` (anything not allowed is refused, never asked), `--mcp-config` with only the desk's MCP server and `--strict-mcp-config`, `--disallowedTools` for git options that write a file anywhere, run a program or read a file from outside the worktree (`--output`, `--ext-diff`, `--no-index`, `--contents`, `--open-files-in-pager`, `git commit -F`/`--file`, and `gh`; a deny rule beats any allow), and `--allowedTools`: the file tools; `git status diff log show blame ls-files rev-parse add restore rm mv`; `git commit -m`, `-am` or `-a -m` (the message on the command line, so no file goes into a commit); `git fetch origin [<branch>|<base>]`, `git merge [--no-edit] origin/<base>`, `git merge origin/<branch>`, `git merge --continue|--abort`; exactly one push, `git push origin HEAD:refs/heads/<branch>` (no options, so no `--force`, no other ref); the repo's own test, lint and install commands found in it (`npm`/`pnpm`/`yarn`/`bun` scripts named test, lint, check, typecheck, format, build; `make` targets; `pytest`, `ruff`; `cargo`; `go`); and `desk_draft_reply`, `desk_escalate`, `desk_item`. No `gh` and no network tools among them (allow rules in your own `settings.json` add to these, except `gh`, which is denied; keep network commands out of yours), no `GITHUB_TOKEN` or `GH_TOKEN` in its environment; git pushes with your own credentials.
- **Workspace.** A git worktree of your local clone at `~/.review-desk/worktrees/<owner>/<repo>-<number>`, detached at the PR's pushed head (your clone may have the branch checked out itself, and git allows a branch in one worktree only). Each run starts from what's pushed. The clone is `inflight.repos` (`owner/repo = /path`, its origin checked), else the first git repo up to two levels under `inflight.clone_roots` (default `~/code`) whose `origin` is the PR's repo; none gives "no local clone of owner/repo", and the PR goes back to your desk. Git work on one clone (fetch, adding and removing worktrees) runs one at a time, since git can't fetch into a repo twice at once. A PR whose branch is in a fork goes back to your desk. The worktree is removed when the PR merges, closes or goes back to your desk.
- **What it's told.** The PR, what's wrong (outside the fence only counts, since check names come from whatever app posts them), the failing checks with the tail of their GitHub Actions logs (read with `gh api` GETs), the open threads with their ids (an outsider's comment inside one is left out by name), collaborators' reviews and comments, all inside a fence with a random tag and a line saying it's untrusted text anyone can write. Fix the cause and keep the change small; for a conflict, merge the base in or escalate; never force-push or rewrite pushed commits; reply only through `desk_draft_reply`; hand anything that's yours to decide to `desk_escalate`, then stop.
- **After a run** the desk reads git: pushed (the branch moved to the worktree's commit), committed but not pushed, or nothing, and logs it with the session id and log path. If the branch no longer contains the commit the run started from, the PR gets a question. A failed run reads claude's error as the judge and the coordinator do (an API error's JSON body comes down to its message). One that failed because Claude Code isn't logged in (a 401) says ``Claude Code isn't logged in. Run `claude auth login` in a terminal.``, isn't counted as tried, leaves its PR calm in Merging (it's the agent's login, not the PR, so it doesn't go back to Now), and no run starts for 15 minutes or until you change an agent setting (`agent.driver`, `analyze.*`).

### Send

A drafted reply shows under its PR in Merging: what it answers, then the reply, with Send (`y`) and Discard (`x`). In the queue, the PR's card shows the reply too, and `y` sends it from there. Send posts it on GitHub as you: `addPullRequestReviewThreadReply` for a thread, `addComment` for the PR. It's one of the desk's GitHub writes ([Security model](#security-model)).

## Events

`GET /api/events` is a server-sent events stream:

- `event: update` with `data: {"rev": n}`, once on connect and again after any change: a sync landing, a triage action or undo, a config, settings or policy save, an AI review starting or finishing, a judge call or coordinator run starting or finishing, an approval, Claude starting, moving on or finishing on a PR, a draft, a question or a hand-back arriving, a reply sent, a hand-off or Back to desk. Refetch what you show.
- `event: notify` with `data: {"title", "body"}`, only with `?notify=1`: the desktop app attached to a desk it doesn't run in-process asks for these, and while one listens the desk shows no notification of its own.
- `: ping` comment lines every 25 s to keep the connection open.

### The event log

`GET /api/activity` (and the `desk_events` tool) reads the event log: what happened to items on the desk, derived by comparing each fresh snapshot of an item with the last one. Follow it by passing `last_seq` back as `after`; with `wait=60` the request holds until something happens, so a loop of calls is event-driven. `item` narrows it to one item (an exact `owner/repo#123` works after the item has left the desk). Bad numbers are a 400; an unknown short ref is a 404.

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

How GitHub changes reach the log: the notifications API is polled about every 60 s (`If-Modified-Since`, honouring `X-Poll-Interval`; read only, nothing is marked read). A notification about an item on the desk refreshes that item at once; one about an item the desk doesn't have yet, for a review request, mention, team mention, assignment or your own item, starts a full pass early. The full pass (every board's searches, then details for what changed) still runs every `github.poll_seconds`, and a rate limit pauses both.

## Security model

- **This machine only.** The server listens on `127.0.0.1`, never on other interfaces.
- **Host and Origin checks** on every route, `/mcp` included. A request whose `Host` isn't `localhost`, `127.0.0.1` or `[::1]` gets 403, which blocks DNS rebinding. A request with an `Origin` other than the desk's own (`http://localhost:<port>`, `http://127.0.0.1:<port>`, plus the Vite dev server on 5173 or 5174, or `DESK_DEV_PORT`, when `DESK_DEV=1`, or exactly `DESK_UI_ORIGIN`, which the desktop app sets for the Vite server it runs from a checkout) gets 403, which blocks other websites. MCP clients and the CLI send no `Origin` and are allowed. A browser request that carries no `Origin` (a no-cors GET, such as an `<img>` pointing at `/api/review/5`, which would start an AI run) still says `Sec-Fetch-Site`; `/api/*` and `/mcp` refuse `cross-site` and `same-site` (another localhost port). Responses can't be framed (`X-Frame-Options: DENY`), and neither can the Vite UI the desktop app runs from a checkout (or `npm run dev`): it sends the same headers, so a site can't frame it to click approve or Send.
- **No auth beyond that.** Any program running as you on this machine can read the queue and triage it, the same as with the CLI. The MCP configs the desk writes say who's calling: `X-Desk-Agent: coordinator`, or `babysitter` with `X-Desk-PR: <its PR>`. That grants nothing; it files the coordinator's actions in its log, says who drafted a reply or asked a question, and takes things away from agents misled by GitHub text: during a run the coordinator can't save the rules, nor the policy during an event wake; it can't mute, nor clear what a hard rule placed; it never drafts, asks or hands back on a PR in Merging, and a babysitter does so only on its own PR (403); an agent's undo (`desk_undo`) can't undo a hand-off or a Back to desk, and the coordinator's undoes only its own actions (409).
- **Writes to GitHub, on your keypress.** The desk's GitHub API writes all go through `src/github/write.ts`, whose allowlist holds exactly six mutations: `addPullRequestReview(event: APPROVE)`, sent by `POST /api/review/:id/approve` (the review view's `a a`) and pinned with `commitOID` to the commit you read (if the desk has seen a newer push, it refuses); and `addPullRequestReviewThreadReply` and `addComment`, sent by `POST /api/inflight/:id/send` (Send on a drafted reply, in Merging or `y` on its card in Now), only on your own open PR; and `markPullRequestReadyForReview` and `enablePullRequestAutoMerge`, sent by `POST /api/inflight/:id/handoff` (`m` on your own open PR), and `disablePullRequestAutoMerge`, sent by `POST /api/inflight/:id/back` (`b`), [above](#merging). These routes only take a request the browser marks `Sec-Fetch-Site: same-origin` that also carries the desk's own `Origin` (the desk's page sends both; MCP clients and the CLI send neither), so curl or an agent's shell gets 403. That's a speed bump against a shell that forges headers, not a wall. The module reads its own token, logs every write, and the desk records it in the action log (undo can't reach it). No MCP tool and no CLI command calls it, and neither does Claude handing a PR back: agents never approve, post or touch auto-merge.
- **Babysitters push, and draft the rest.** The only GitHub command a babysitter may run is `git push origin HEAD:refs/heads/<branch>` to your own PR's branch, the one in Merging it works on, with your git credentials, from a worktree under `~/.review-desk/worktrees`; the allowlist above has no force, rebase or other ref, and denies `gh` (other allow rules in your own Claude Code `settings.json`, which babysitters load, add to it), and its environment has no GitHub token. Their replies are drafts you send. That allowlist limits what the agent runs directly, not what the code it runs can do: it may edit the repo and run its tests, so an agent misled by what it reads could run code as you, and that code could use your git credentials or `gh` login. So what it reads is limited too: only feedback from the repo's collaborators (`authorAssociation` OWNER, MEMBER or COLLABORATOR) and bots you list in `inflight.trusted_bots` starts a run or reaches its prompt; anyone else's comes back to you in Now and is left out of the prompt by name, and a draft can't answer a thread an outsider spoke last in. Check names and CI logs still reach it, fenced as untrusted. The fence, the token-free environment, the git deny rules and the post-run check that the branch still holds the commit the run started from are the other safeguards. Babysit only repos whose tests you'd run, or turn `inflight.babysit` off. Everything else is read only: the GitHub client runs GraphQL queries and refuses any document containing `mutation`, REST GETs for the notifications feed (the client refuses any other method, so it can't mark a thread read), and the review reads a PR's files and description with `gh api` GETs. Done, snooze, mute and pin are local state in `desk.db`.
- **Untrusted text is fenced.** Titles and AI review text come from GitHub, and a hand-off prompt template can include the title. MCP results that carry them (`desk_list`, `desk_item`, `desk_brief`, and `desk_events` for logins and reasons) put them between `<untrusted-data nonce="…">` and `</untrusted-data nonce="…">`, after a line saying to treat them as data, not instructions; the nonce is random per result, so text inside can't fake the closing marker. Titles are flattened to one line with control characters removed. The AI review's prompt fences PR text with a random tag too, the agent runs with no tools, no MCP servers and an empty working directory, and the CLI strips control characters so a title can't emit terminal escapes. The AI review is untrusted output as well: the diff it read came from GitHub. The judge works the same way: no tools, no MCP, an empty directory, the items fenced. The coordinator has the desk's MCP tools and nothing else (`--tools ""`, `--strict-mcp-config`, `--allowedTools` naming its tools), so it can triage locally and edit the policy and rules but can't reach GitHub, a shell or files, nor draft or ask on your PRs in Merging; its wake messages fence GitHub text, and its own notes and reasons are shown as text, never run.
- **A learned policy only changes local sorting.** A learn run lets the coordinator save the policy in a run nobody started by asking, and its message carries GitHub titles (fenced), so a title could try to steer it. It runs as a fresh session that isn't kept, so the GitHub text earlier wakes read isn't in it, and it may call only `desk_policy` and `desk_note`, so it can't fetch more. What it could do with that is bounded: the policy decides only where items sit on your desk (Claude's buckets and the coordinator's local, undoable actions). Hard rules live in config.toml, which no run can save, and they hold whatever the policy says: nothing sorts what they match below their floor, and the coordinator can't clear it, nor mute anything at all. Nothing about the policy reaches GitHub writes (the allowlist above) or a babysitter's tools. Every change is in the coordinator's log with what it took out and put in, and one click undoes it.
