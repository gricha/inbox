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

Connecting copies the skill (and refreshes a copy that differs from the repo's), then registers the MCP server if it isn't registered yet. After that the owner's desk keeps it current: each time `desk serve` starts on `~/.review-desk` (as the app running from a checkout does), and whenever the repo's `SKILL.md` changes while it runs, it refreshes each agent's installed copy that differs from the repo's, and logs it. It never installs a missing one, and a desk on any other `DESK_HOME` (a scratch desk, tests) leaves them alone:

| Agent       | Registered when                                        | Registers with                                                                        | Skill                                   |
| ----------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------- |
| Claude Code | `~/.claude.json` has `mcpServers["review-desk"]`       | `claude mcp add --transport http --scope user review-desk http://localhost:47823/mcp` | `~/.claude/skills/review-desk/SKILL.md` |
| Codex       | `~/.codex/config.toml` has `[mcp_servers.review-desk]` | `codex mcp add review-desk --url http://localhost:47823/mcp`                          | `~/.agents/skills/review-desk/SKILL.md` |

`--scope user` makes Claude Code's entry available in every project. `claude mcp list` then shows `review-desk: http://localhost:47823/mcp (HTTP) - ✔ Connected` while the desk runs, and a failed connection while it doesn't. If you added the older stdio `review-desk` before, it already counts as registered; to switch it to HTTP, run `claude mcp remove review-desk -s user`, then Connect again. Codex reads user skills from `~/.agents/skills` ([Codex skills](https://developers.openai.com/codex/skills)).

### Your own Claude Code

Every agent the desk runs (the AI review, the judge and Claude's read of what reviewers said) is the `claude` CLI from your PATH under your own login (there's no setting for it: `DESK_CLAUDE` only points tests and QA at a fake), with your own model, effort and plugins: the desk passes no `--model`, no `--agents` or `--system-prompt`, no `--bare`, and sets no `ANTHROPIC_API_KEY` (one in the desk's own environment would reach them, as it would your own `claude -p`). What it does take away is reach: every run has `--strict-mcp-config`, so none of your MCP servers (Slack, Linear, GitHub, …) load, only the desk's own where a run has one. The AI review and the judge have no tools at all, so your settings bring only your model, effort and plugins. Each run is a process group of its own (taskkill `/T` on Windows), so stopping it stops what it started too (hooks, test runners); the desk stops every one when it closes (SIGTERM, SIGKILL 2 s later) and waits for them before it exits, so a restart under `node --watch` leaves none behind.

### The AI review

The same agent writes each PR's AI review: a verdict, a risk level, a summary, concerns, short notes anchored to lines of the diff, and a ranking of the diff's hunks. Claude Code runs as `claude -p --json-schema … --tools "" --strict-mcp-config --no-session-persistence` (`claude` from your PATH), and the review says which model wrote it, as Claude Code reports it (`modelUsage`); it gets the prompt on stdin in `~/.review-desk/agent/`, an empty directory the AI review, the judge and login checks share (Claude Code keeps a `~/.claude/projects` entry per directory, so the desk has one), with the PR text fenced as untrusted. When someone pushed since your last review (`me.pushed_since_review`), the prompt also carries the diff from the commit you reviewed to the head (`compare/<commit>...<head>`), and the review adds `since`: one sentence on what changed since you looked and whether it settles the concerns, which the card shows as its gist ("Since your review: …"). Reviews are kept per head commit. With `review.auto_ai` on (the default) the desk writes them in the background for other people's open PRs in Now and Today, two at a time, in the queue's order (Now, then Today from the top, so the cards on screen are ready first), and for any PR whose review you open; a failure isn't retried on the same commit for 30 minutes unless you ask. Two failures in a row (an expired login fails every PR) pause these reviews nobody asked for, for 30 minutes: the queue says so once (`paused`; when the cause is the login, which stops the judge too, it says Claude is paused, as it does when the judge fails on it first), the review view says so on a PR that wasn't tried, asking with `i` (or `desk brief`) still runs, and a success or a change to `review.auto_ai` resumes them; a settings change also retries the PRs that failed. One call that works after a login failure (an AI review or the judge) retries everything else that failed on the login, without waiting out its backoff. A `claude -p` 401 reads as ``Claude Code isn't logged in. Run `claude auth login` in a terminal.``, and the log keeps Claude's own words (`401 OAuth access token has expired`).

The ranking says which chunks are worth your attention and in what order. The prompt numbers every hunk `h1`, `h2`, … across the files in order (before its `@@` line; a lockfile's hunks keep their numbers but aren't shown, and the "since your review" diff has none), and Claude answers `chunks`: at most 20 hunk ids in the order to read them (most worth first, looks before skims; on a re-review, what changed since you looked first), each with a level (`look` or `skim`) and a few words why. Everything it leaves out is not worth reviewing (imports, renames, formatting, generated files, lockfiles, snapshots, tests that mirror the code). The desk keeps Claude's order and only ids the prompt showed, each once; a hunk Claude wrote a note on but left out joins the end as a skim (with no why), so leaving a hunk out by a slip can't bury what Claude itself flagged. It stores the ranking with the review (`chunks`: the ids with their paths, the hunks left out for length as `unread`, whether the list filled the cap, the total). A file's diff past 20 KB is cut inside the hunk that crosses it: that hunk's start is shown and counts as read, and the hunks after it are unread. `GET /api/review/:id` turns it into `order`: the chunks to read, ranked, then the unread ones (with why: the PR or their file was too long), then the hunks Claude left out (`skipped`, level `skip`), then what the desk itself folds away by file with why (lockfiles and generated files, files with no text diff), each hunk with its own patch, level, rank, why and the notes that sit on it, and `order.notes`, the notes in that reading order. Only the desk's own calls are folded: Claude's answer comes from a diff anyone can write, so what it leaves out stays in view, marked Skip. Clients render hunks from `order`; `files[].patch` repeats the same text for today's review UI and goes once that reads `order`. A review from before ranking, one for an older commit, or a ranking whose ids no longer name the same files keeps today's order: every hunk file by file (`ranked: false`). Ranking adds about 20 output tokens a chunk, so even a full list costs little: measured on 2026-11-02 on honojs/hono#5547 (5 files, 14 hunks, +63 −16), the whole review took 90 s and 7,133 output tokens (4,338 of them thinking), and its 7 ranked chunks were 0.5 KB of the 4.9 KB answer.

Opening a PR (`GET /api/review/:id`) asks for its AI review and has Claude read what waits on you; `?ahead=1`, the UI's prefetch of the row you rest on, starts neither. After each sync the desk fetches the main page's PRs' diffs and conversations ahead, three at a time, so opening one doesn't wait on GitHub; both are kept (the diff per head commit, the conversation until the PR updates), so a sync refetches only what changed.

### What reviewers said

A PR's review view carries its conversations (`ReviewView.conversation`, `src/conversation.ts`): every review thread (resolved or not, outdated or not, its file and line, each comment with its author and time), the comments on the PR and the reviews' bodies (bots' comments on the PR, which are status reports, and empty review bodies are left out). The desk reads them once a sync sees the PR updated. One rule says which wait on you: a person other than you had the last word, on your PR after your last word there; on someone else's PR, in a thread you're in or in a comment that @mentions you. Bots never wait on you. The same rule, on what a sync knows of your PR (each thread's last comment, the PR's comments), gives the main page's row the call to action "Reply" when that's all it needs: open, not in Merging, not a draft, CI not failing, no conflict, no changes requested and not approved and green.

Claude reads each one waiting on you, like the judge: `claude -p --json-schema … --tools "" --strict-mcp-config --no-session-persistence` in `~/.review-desk/agent/`, the PR's title, description, latest commits and the conversations (with the code a thread is on) fenced with a random tag as untrusted text it must never take instructions from. Up to 10 a call, one PR at a time, in the background: when you open a review, and after a sync for the rows that say Reply. For each it gives a one-line gist of what they want, its take ("Valid concern: …", "A nit: …", "Already addressed: …", "Only you can answer: …", "Nothing to do: …") and a reply in your voice, kept per conversation until a newer comment arrives (`take:<pr>` in the store). A failure shows in the view and isn't retried on that PR for 10 minutes.

You answer in the review: the reply box starts with Claude's suggestion, and Send (or ⌘↩) posts it through `POST /api/review/:id/reply`. It's one of the desk's GitHub writes ([Security model](#security-model)).

### The policy and the judge

Claude triages everything that reaches the desk. Rules come first: they're cheap and say exactly what they do. A placement, a matching rule's bucket and why or the board's `default` when none matched, is Claude's hint, and holds until Claude answers; a rule's `bucket = "judge"` is a hint of the board default. A rule with `hard = true` is a floor: what it matches never sorts below the rule's bucket, or Today for a Now rule, whatever Claude answers (below it, the floor holds with the rule's why), and neither the quiet rule (`queue.quiet_days`) nor caps move it lower; Now's cap still sends the overflow to Today. The first-run config makes the rules for a review asked of you by name hard, so those always reach your desk: a person's ask (bucket now, so Claude picks Now or Today) and one a bot added (bucket today; Junior adds asks for people). A config written before hard rules existed gets the person's rule (`me.requested_direct && !me.requested_by_bot`, bucket now, as the first run wrote it with `nocap = true`) made hard once, and one written before the bot's rule gets it once, right after that hard rule, both with one `config.toml.bak`. Your pin is a floor too: what you pinned stays in Today or above, with or without Claude. A pin the old desk-run coordinator made isn't: Claude sees it ("pinned by the coordinator") and sorts by your policy. A pin or unpin sorts the item again. Resolution still applies: a PR that's merged, closed or approved by someone else (`github.resolve_on_others_approval`) leaves the desk. The policy, `~/.review-desk/policy.md`, is prose you write in Settings → Policy, or by asking an agent with the desk's tools (`desk_policy`), or in any editor; the desk re-reads it when it changes. While it's empty a built-in starter policy (`DEFAULT_POLICY` in `src/judge.ts`, "less is more") is in effect, so Claude sorts from the first sync; `desk_policy get` and Settings → Policy say so.

The judge sends those items to the same agent as the AI review, with the same isolation: `claude -p --json-schema … --tools "" --strict-mcp-config --no-session-persistence`, the prompt on stdin in `~/.review-desk/agent/`, the policy and the items fenced with a random tag. The prompt asks what you should do with each item (now: a person is blocked on you today, one or two at most, never CI on your own PR; today: a person is waiting on you, or it's yours to finish, approved and green; later: yours, but nobody is blocked; fyi: someone else has it or nobody needs you, kept off your page; hide: automated noise), says less is more and to sort away what it's unsure of, and gives each item its facts and its hint. When the policy's lines disagree, a line that sorts an item away for who made it or its state (bots, drafts, stacked PRs, someone else asked by name, a teammate reviewing) beats one that promotes it for what it touches, and being asked by name, a pin and a hard rule's floor beat both; what counts most is how you were asked, whether you usually review the author, and whether it builds on what you're building, while a directory you've worked in is weak evidence on its own. The facts, a line each: who opened it and when (a bot's PR opened for a person says so, "PR by sentry-junior (bot) for Michelle Tran", or "their own PR, opened through sentry-junior" when it's via you); size, CI and review state, and "stacked on <base>" when its base isn't the repo's default branch; on your own PR, how long ago you pushed and its unresolved threads with who had the last word ("cursor (bot)"); how you were asked (by name and by whom, or via which team, and whether CODEOWNERS), whether you're a usual reviewer of the author (`author.close`) and who else was asked; others' standing reviews ("approved by erin; commented frank", leaving out bots and you); for someone else's PR, how many of its files are in your areas and the directories it touches, yours marked "theirs" (see "Your areas"); the AI's pre-flight review when there is one, its call, risk and first sentence ("of an earlier commit" when it is); and the description's first 280 characters. Above the items, inside the fence, come who you are (your name and teams, the five authors whose PRs you engage with most, and the titles of your 20 latest PRs, from the context) and your areas in each repo the batch's PRs are in. The hint is where the rules would put it, on which board, and why; under a hard rule its floor ("a hard rule keeps it in today or above"), and on a pinned item who pinned it (yours: "which keeps it in today or above"). Each item gets back a bucket and a few words of why, which replace the hint's (an empty why keeps the rule's). Then the quiet rule and caps apply as usual, down to a hard rule's floor.

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

One background Claude Code session the desk starts and wakes (`src/coordinator.ts`, README → Coordinator), and the skill's "Coordinator" section is what it does on a wake. On the first hand-off (or `POST /api/coordinator/wake`, `w` in Merging) the desk runs `claude --bg --name "Review Desk coordinator" --remote-control "Review Desk coordinator" "<role line> <news>"` in `<home>/coordinator`, after adding any rule of its deny list missing from its `.claude/settings.json` (the owner's own settings there stay), and keeps the id it prints (kv `coordinator_bg`, with its claude.ai link from `claude logs` and `mode`, the permission mode it started with: `bypass` or `default`; a record without one is `default`, and one the desk picked up from its folder without seeing it start is `unknown`, so its next launch sets the mode). With `agent.coordinator_bypass` on (the default), the start adds `--permission-mode bypassPermissions`: no permission prompts, while the deny list still holds (deny rules apply in every mode). A session keeps its mode across `claude --resume` with no flags; when the setting and `mode` differ, the next launch (a delivery, the no-prompt resume at a check, or right away when the setting changes; a busy one waits until it's idle, one waiting on a permission prompt switches at once and is told to look at Merging) resumes with `--name`, `--remote-control` (in case a copy doesn't keep them) and `--permission-mode bypassPermissions` or `--permission-mode default`, so claude starts a copy with the history in that mode, and the desk keeps the copy's id and the new mode (the original stays in `claude agents`, stopped); later wakes resume the copy with no flags. Claude Code refuses bypass for `--bg` until it's been accepted once (`claude --dangerously-skip-permissions`), or when a managed `disableBypassPermissionsMode` forbids it; that refusal is `error` like any other, and turning the setting off resumes the old session as it was. From then on it keeps it running: when the desk starts (`Desk.start()`), every 5 minutes and when `agent.coordinator` is turned on, `claude agents --json --all` picks up that session, and one that stopped or crashed is resumed with `claude --resume <sessionId> --bg` and no prompt, which starts no turn. With no session and nothing to deliver, it creates none. After that, a hand-off and, on a PR in Merging, CI finishing (`ci` to green or red), a review, a comment or a conflict queue one entry per PR; a minute after the first, the desk delivers them as one line of ids, URLs and kinds (never PR text). It reads `claude agents --json --all`: busy (or in a shell, or waiting on a permission), it keeps them and looks again a minute later; they're kept in kv `coordinator_news` until a start or resume succeeds, so a desk restart or a failed start leaves them for the next wake or desk start; idle and running, `claude stop <id>` then `claude --resume <sessionId> --bg "<news>"` (with no other flag, so claude continues that session, same id and history, instead of starting a copy); stopped, just the resume; gone (`claude rm`), a fresh start (it picks up only a running session from its folder, never one a switch left stopped). Merging's line is `coordinator` in `InflightView`: on, its id (null until started), link, and `error`: what claude said when it last couldn't start or resume it (kv `coordinator_error`, cleared once a run succeeds), shown in red in Merging, with one notification when it first fails. News on a merged or closed PR doesn't wake it, and a second `w` while one runs adds nothing. Claude's daemon runs the session, not the desk, so the desk's agent cleanup (`stopAll`) and a restart under `node --watch` leave it running. `agent.coordinator` off stops it and nothing wakes it; on again resumes it once the stopped process has exited. It's the owner's own Claude Code, with their MCP servers, tools and permissions, and the desk's tools through the user-scope `review-desk` server (Settings → Agents → Connect). On a wake it reads the PRs handed off for merge (`desk_merging`) and the events since its last wake (`desk_events`), works in a git worktree of the owner's clone to fix CI, address members' review comments and, once it's otherwise ready, rebase it on a conflict, pushes to the PR's own branch (`--force-with-lease` after a rebase), merges with `gh pr merge` once it's approved, green and conflict-free, notes what it did (`desk_note`, shown on the PR's row in Merging), and hands back what it can't finish (`desk_hand_back`). It never posts comments or replies as the owner.

An ask (`POST /api/ask`, `t` in the window) doesn't wait for the batch: the desk keeps it (kv `asks`, the latest 200), queues one line, `My ask <id>, about <item id> (<url>), on the thread <url>: "<your words>" Answer it with desk_answer.`, in kv `coordinator_asks`, and delivers it as soon as a run in progress is done, the same way as news (busy, it waits; not started, it starts it), ahead of any news in the same message. `agent.coordinator` off refuses it, and one that isn't started and won't start is a 502, with the ask dropped. `desk_answer` stores the answer on the ask, bumps the views and, on its first answer, notifies (`notify.enabled`, outside `notify.quiet`).

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

The same fifteen tools over HTTP and stdio. Results are text; most end with a JSON block for parsing. Errors come back as a tool result with `isError: true` and the API's message, e.g. `no item "nope#1" on the desk`, or `"sentry#1" matches 2 items — candidates: getsentry/sentry#1, other/sentry#1`. Over stdio, a desk that isn't running gives `desk is not running — start it with: desk serve`.

`ref` is `owner/repo#123`, `repo#123` when unique, or a GitHub URL.

| Tool             | Arguments                                                                                                                                                               | Returns                                                                                                                                                                                                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desk_overview`  | none                                                                                                                                                                    | Counts per space and board, Focus totals, sync status and config errors; JSON `Overview`. Read only                                                                                                                                                                                                               |
| `desk_list`      | `board?` (board id; omit or `"focus"` for Focus), `buckets?` (`now` `today` `later` `fyi` `hide` `cleared`; default now, today), `limit?` (1–200, default 25)           | One line per card (bucket, id, title, why, and "stack 3/20" with the PRs a stack's one line stands for); JSON of the cards (`id bucket title why author url chips status new pinned boards stack`). Focus only holds now and today, a stack once. Read only                                                       |
| `desk_item`      | `ref`                                                                                                                                                                   | Facts, bucket and why on each board, the rule trace, its stack bottom first (state, CI, review, where each sits), the AI review's verdict, summary and concerns if there is one, and the review hand-off prompt; JSON `{ card, placements, state }`. Read only                                                    |
| `desk_act`       | `ref`, `action` (`done` `snooze` `mute` `unmute` `pin` `unpin` `restore`), `until?` (snooze only, default `tomorrow`; or until it happens: one of the card's `wake_on`) | What changed and the undo `seq`; JSON `{ ok, state: ItemState, undo_seq }`. Local only                                                                                                                                                                                                                            |
| `desk_add`       | `ref` (`owner/repo#123` or a GitHub URL; `repo#123` only for an item the desk holds)                                                                                    | `added <id> to the user's desk, pinned`, whether its AI review is being written or ready, and the undo `seq`, then the item as `desk_item` describes it. Local only: [Adding](#adding)                                                                                                                            |
| `desk_undo`      | `seq?` (positive integer; default the latest action from anyone: UI, CLI or agent). Not a hand-off for merge, nor a Back to desk (yours to undo)                        | `undid <action> on <id>`                                                                                                                                                                                                                                                                                          |
| `desk_brief`     | `ref`                                                                                                                                                                   | The PR's AI review: look, skim or skip, risk, summary, concerns and notes on the changes; JSON `AiReview`. Usually written already for PRs in Now and Today; otherwise a model call through `agent.driver` (a minute or two). Cached per commit                                                                   |
| `desk_sync`      | none                                                                                                                                                                    | `sync started`                                                                                                                                                                                                                                                                                                    |
| `desk_events`    | `after?` (seq, default 0), `wait?` (seconds, 0–60, default 0), `limit?` (1–500, default 100), `item?` (a ref)                                                           | One line per event (`#seq at item kind by actor data`), oldest first, and `last_seq` to pass as `after` next; JSON `ActivityPage`. With `wait` it returns as soon as one lands. Read only                                                                                                                         |
| `desk_merging`   | none                                                                                                                                                                    | One line per PR in Merging (the owner's, handed off with `m`): id, title, CI with its failing checks, reviews, unresolved threads, mergeable, its base (stacked on another PR or not), the repo's merge method, the last note; titles and notes fenced; JSON of the rows (`InflightRow` less its card). Read only |
| `desk_hand_back` | `ref`, `why` (one line, up to 300 characters)                                                                                                                           | The PR leaves Merging for the top of the queue with "handed back: <why>", and the owner is notified; writes nothing to GitHub. Only on the owner's open PR in Merging. Local only                                                                                                                                 |
| `desk_policy`    | `action` (`get` `set`), `text?` and `base?` (set: the whole new policy, and the hash from get)                                                                          | get: the policy in effect fenced (the starter while policy.md is empty, and it says so), its hash and the judge's status; JSON `{ hash, starter, judge }`. set: saves it; a stale `base` is an error (get it again and redo the edit)                                                                             |
| `desk_config`    | `action` (`get` `preview` `save`), `text?` (preview, save: the whole new config.toml), `base?` (save: the hash from get)                                                | get: config.toml fenced, its hash and errors. preview: errors, counts per board before → after, and the items that would move (titles fenced); nothing is saved. save: only valid text, and a stale `base` is an error                                                                                            |
| `desk_note`      | `ref`, `text` (one line, up to 300 characters)                                                                                                                          | `noted on <ref>`: the PR's status line in Merging, shown on its row with its age; only the latest shows. Only on the owner's open PR in Merging. Local only                                                                                                                                                       |
| `desk_answer`    | `ask_id` (from the wake message), `text` (up to 2000 characters)                                                                                                        | `answered ask <id>`: the coordinator's answer to the owner's ask, shown under it in the desk, and the owner is notified. Local only                                                                                                                                                                               |
| `desk_inquire`   | `question`, `context?`, `options?` (up to 6), `from?` (who asks, as the user knows the session), `item?`                                                                | `asked as inquiry <id>`: a question for the user in their desk instead of in chat, a row on their main page and a notification. Call `desk_inquiry` for the answer                                                                                                                                                |
| `desk_inquiry`   | `id`, `wait?` (seconds, 0–60)                                                                                                                                           | The user's answer, "no answer yet", or that they dismissed it (decide yourself). With `wait` it returns as soon as they answer. Read only                                                                                                                                                                         |

`until`: `1h`, `3h`, `2d` (any positive hours or days), `tomorrow` (09:00 local; before 05:00 it means this morning), `monday` (next Monday 09:00), `activity` (until someone else acts), `YYYY-MM-DD` (09:00 that day), or a future ISO time.

## HTTP routes

JSON in and out. Errors are `{ error: string, candidates?: string[] }` with a 4xx or 5xx status: 400 for a bad request, 404 for an unknown board, item or route, 409 for an ambiguous short ref (with `candidates`). Routes marked ✓ answer 503 until the first load finishes; if config.toml has errors from the start, those that read the queue (overview, queue, focus, boards, item, act, review, status) keep answering 503 and `/api/config` works so you can fix it. Errors in a later edit keep the last good config running.

| Method      | Path                         | Request                                                       | Response                                                                                                                                                                                                                                                                                                                                                                                                                    | 503 while starting |
| ----------- | ---------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| GET         | `/health`                    |                                                               | `{ ok: true, version: string }`                                                                                                                                                                                                                                                                                                                                                                                             |                    |
| GET         | `/api/overview`              |                                                               | `Overview`                                                                                                                                                                                                                                                                                                                                                                                                                  | ✓                  |
| GET         | `/api/queue`                 |                                                               | `QueueView`: every item once, at its best placement (the UI's main surface)                                                                                                                                                                                                                                                                                                                                                 | ✓                  |
| GET         | `/api/focus`                 |                                                               | `FocusView`: the queue's now and today, each in the desk's order (what Claude handed back, close looks, then the rest; someone else's red PR and "skip it" last); never a PR in Merging                                                                                                                                                                                                                                     | ✓                  |
| GET         | `/api/boards/:id`            |                                                               | `BoardView`                                                                                                                                                                                                                                                                                                                                                                                                                 | ✓                  |
| GET         | `/api/item`                  | `?id=<ref>` (encode `#` as `%23`)                             | `ItemDetail`                                                                                                                                                                                                                                                                                                                                                                                                                | ✓                  |
| POST        | `/api/act`                   | `{ id: string, action: Action, until?: string }`              | `{ ok: true, state: ItemState, undo_seq: number }` (`seen` and `undo` return `undo_seq: 0`)                                                                                                                                                                                                                                                                                                                                 | ✓                  |
| POST        | `/api/add`                   | `{ id: string }` (a ref, as for `desk_add`)                   | `{ ok: true, item: ItemDetail, undo_seq: number }`: on your desk, pinned ([Adding](#adding)); 400 for a ref it can't read, or a short one the desk doesn't hold; 404 when GitHub has no such PR or issue; 502 when fetching it failed                                                                                                                                                                                       | ✓                  |
| POST        | `/api/undo`                  | `{ seq?: number }` (default: the latest action, any client's) | `{ ok: true, id: string, action: Action }`; 409 if a later action on the same item must be undone first, or for a hand-off or Back to desk not from the desk's own page                                                                                                                                                                                                                                                     | ✓                  |
| GET         | `/api/review/:id`            | `:id` is `owner%2Frepo%23123` (or `owner/repo%23123`)         | `ReviewView`: the PR's facts, its changed files, the order to read its hunks in, the AI review, whether you can approve, and what reviewers said (`conversation`, [below](#what-reviewers-said)); 400 for an issue. Opening it asks for the AI review when `review.auto_ai` is on and there's none for this commit                                                                                                          | ✓                  |
| POST        | `/api/review/:id/ai`         | `{ force?: boolean }`                                         | `{ ok: true, ai: AiReview }`: the one for this commit unless `force`; joins a run already going; 502 with the reason if the agent fails                                                                                                                                                                                                                                                                                     | ✓                  |
| POST        | `/api/review/:id/approve`    | `{ head_oid: string, body?: string }`                         | `{ ok: true, url: string }`: approves the PR on GitHub at `head_oid`, the commit the view showed (below), then refreshes that PR (it resolves as `you approved` within seconds) and runs a full sync; 403 unless it's the desk's own page (`Sec-Fetch-Site: same-origin` and its `Origin`); 409 for your own PR, a closed one, one you approved at this commit, or new commits since; 502 with GitHub's reason              | ✓                  |
| POST        | `/api/review/:id/reply`      | `{ id: string, body: string }`                                | `{ ok: true, url: string }`: posts your reply to one of the PR's conversations on GitHub, as you: a review thread's reply, or a comment on the PR for a comment or a review. 403 unless it's the desk's own page, as for approve; 404 for a conversation that isn't this PR's; 409 for a closed PR; 502 with GitHub's reason                                                                                                | ✓                  |
| POST        | `/api/review/:id/ready`      |                                                               | `{ ok: true }`: marks your own open draft ready for review on GitHub (Ready for review, `a`), then asks `{ users?, teams? }` (node ids from `/api/reviewers/:id`) to review it; logs each and refreshes the PR; 403 unless it's the desk's own page, as for approve; 400 unless they're lists of ids; 409 unless it's your own open draft; 502 with GitHub's reason ("Marked it ready, but …" when only the request failed) | ✓                  |
| GET         | `/api/reviewers/:id`         | `q?`                                                          | `Reviewer[]`: who you can ask to review your own PR (`id login name team suggested`): GitHub's suggestions matching `q` first, then people with access and the owner org's teams, never you; 409 unless it's your PR. Read only                                                                                                                                                                                             |                    |
| POST        | `/api/github`                | `{ id, action, head_oid?, body? }`                            | `{ ok: true, url }`: the More menu's GitHub write (`action`: `close`, `draft`, `merge`, `reopen`, `request_changes` with `body`), logged, and the item refreshed before it answers; 403 unless it's the desk's own page, as for approve; 409 unless the item's card offers it now (`actions`), or for new commits since `head_oid` on a merge or a change request; 502 with GitHub's reason                                 | ✓                  |
| POST        | `/api/sync`                  |                                                               | `{ ok: true }` (starts a sync now)                                                                                                                                                                                                                                                                                                                                                                                          |                    |
| GET         | `/api/config`                |                                                               | `ConfigDoc`: `{ path, text, hash, errors, warnings?, hard }`; `hard`: the hard rules (board, with its space when two share a name; bucket, when, and why with fields as "someone")                                                                                                                                                                                                                                          | ✓                  |
| POST        | `/api/config/preview`        | `{ text: string }`                                            | `PreviewResult`: errors, and per board the new counts and which items would move                                                                                                                                                                                                                                                                                                                                            | ✓                  |
| PUT         | `/api/config`                | `{ text: string, base?: string }`                             | `{ ok: boolean, errors: ConfigError[], warnings: ConfigError[] }`; saves only if valid, and never with a settings section (`poll_seconds`, `[signals]`, `[notify]`, `[handoff]`, `[analyze]`: they live in Settings); 409 if the file changed since `base` (the text you started from, or its `hash`)                                                                                                                       | ✓                  |
| GET         | `/api/policy`                |                                                               | `PolicyDoc`: `{ path, text, starter, hash, judge: JudgeStatus }`; `text` is `""` until you write one, and `starter` is in effect meanwhile                                                                                                                                                                                                                                                                                  |                    |
| PUT         | `/api/policy`                | `{ text: string, base?: string }`                             | `{ ok: true, hash: string }`; writes `policy.md`; 409 if it changed since `base` (the `hash` you read); 400 over 20,000 characters                                                                                                                                                                                                                                                                                          |                    |
| GET         | `/api/fields`                |                                                               | `FieldDoc[]`: every field rules can use                                                                                                                                                                                                                                                                                                                                                                                     |                    |
| GET         | `/api/settings`              |                                                               | `SettingsView`: schema, effective values, what's overridden, GitHub status                                                                                                                                                                                                                                                                                                                                                  |                    |
| PUT         | `/api/settings`              | `{ set?: Record<string, SettingValue>, reset?: string[] }`    | `{ ok: boolean, errors: ConfigError[], settings: SettingsView }`; writes nothing if any value is invalid                                                                                                                                                                                                                                                                                                                    |                    |
| GET         | `/api/agents`                |                                                               | `AgentStatus` for Claude Code: `{ driver, mcp: { connected, command } \| null, skill: { state: "installed" \| "outdated" \| "missing", path, command } \| null }`                                                                                                                                                                                                                                                           |                    |
| POST        | `/api/agents/connect`        |                                                               | `AgentStatus` after installing the skill and registering the MCP server; 502 with the command to run yourself if the agent's CLI fails or isn't on PATH                                                                                                                                                                                                                                                                     |                    |
| GET         | `/api/status`                |                                                               | `{ now: number, today: number, new: number, text: string }`; `text` is e.g. `desk 7 +3` (7 in the queue, 3 new), `""` when 0/0                                                                                                                                                                                                                                                                                              | ✓                  |
| GET         | `/api/inflight`              |                                                               | `InflightView`: your PRs in Merging, open ones first (latest activity on top), then any that merged or closed in the last 3 days                                                                                                                                                                                                                                                                                            | ✓                  |
| POST        | `/api/inflight/:id/note`     | `{ text: string }`                                            | `{ ok: true, text: string }` (`desk_note`), flattened to one line; 409 unless it's your open PR in Merging; 400 when empty                                                                                                                                                                                                                                                                                                  | ✓                  |
| POST        | `/api/inflight/:id/handback` | `{ why: string }`                                             | `{ ok: true, reason: string }` (`desk_hand_back`), flattened to one line: the PR leaves Merging for the top of the queue; 409 unless it's your open PR in Merging                                                                                                                                                                                                                                                           | ✓                  |
| POST        | `/api/coordinator/wake`      |                                                               | `{ ok: true }`: starts the coordinator, or has it look at Merging now (`w` in Merging); 409 while `agent.coordinator` is off                                                                                                                                                                                                                                                                                                | ✓                  |
| POST        | `/api/ask`                   | `{ text, item_id?, thread_id?, thread_url? }` (strings)       | `{ ok: true, ask: Ask }`: your words to the coordinator (`t`), kept and sent to it at once with the item's id and URL and the thread's URL; 403 unless it's the desk's own page, as for approve; 409 while `agent.coordinator` is off; 502 when it didn't start                                                                                                                                                             | ✓                  |
| GET         | `/api/asks`                  |                                                               | `AsksView`: `{ on, asks }`, whether the coordinator is on and your asks, oldest first, with its answers                                                                                                                                                                                                                                                                                                                     |                    |
| POST        | `/api/asks/:id/answer`       | `{ text: string }`                                            | `{ ok: true, ask: Ask }` (`desk_answer`): the coordinator's answer, flattened to one line; notifies you on the first one; 404 for an unknown ask                                                                                                                                                                                                                                                                            |                    |
| POST        | `/api/inquiries`             | `{ question, from?, context?, options?, item? }`              | `{ ok: true, inquiry: Inquiry }` (`desk_inquire`): an agent's question for you, a row on the main page and a notification; question and from one line (300, 60), context up to 2000, at most 6 options of 80; 400 otherwise                                                                                                                                                                                                 |                    |
| GET         | `/api/inquiries/:id`         |                                                               | `Inquiry` (`desk_inquiry`): with `answer: { text, at, dismissed }` once you answered or dismissed it; 404 for an unknown one                                                                                                                                                                                                                                                                                                |                    |
| POST        | `/api/inquiries/:id/answer`  | `{ text }` or `{ dismiss: true }`                             | `{ ok: true, inquiry }`: your answer; it leaves the main page. 403 unless it's the desk's own page (an agent can't answer its own question); 400 for an empty one; 409 if already answered                                                                                                                                                                                                                                  | ✓                  |
| POST        | `/api/review/:id/comment`    | `{ body }`                                                    | `{ ok: true, url }`: your comment on the PR (`w` in its review, `addComment`), a GitHub write like approve; it's done, off your desk until someone else acts. 403 unless it's the desk's own page; 400 for an empty one; 502 with GitHub's reason                                                                                                                                                                           | ✓                  |
| GET         | `/api/activity`              | `?after=<seq>&limit=<n>&item=<ref>&wait=<seconds>`            | `ActivityPage`: `{ events, last_seq }`, the event log after `after`, oldest first. A long-poll: with `wait` (up to 60) it answers as soon as an event lands; below                                                                                                                                                                                                                                                          |                    |
| GET         | `/api/events`                |                                                               | Server-sent events, below                                                                                                                                                                                                                                                                                                                                                                                                   |                    |
| POST        | `/mcp`                       | MCP JSON-RPC (Streamable HTTP)                                | JSON-RPC responses as an SSE stream; 202 for notifications                                                                                                                                                                                                                                                                                                                                                                  |                    |
| GET, DELETE | `/mcp`                       |                                                               | 405, `Allow: POST`                                                                                                                                                                                                                                                                                                                                                                                                          |                    |
| GET         | anything else                |                                                               | The web UI from `web/dist` (unknown paths get `index.html`)                                                                                                                                                                                                                                                                                                                                                                 |                    |

`Action` is `done`, `snooze`, `mute`, `unmute`, `pin`, `unpin`, `restore`, `inflight` (your own open PR goes to [Merging](#merging): `m`), `takeback` (out of Merging: `b`), `seen` (marks it looked at; not undoable) or `undo` (undoes the latest action on that item). `until` is as for `desk_act`.

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
  snooze_when: "ci" | "push" | "approved" | "ready" | "conflict" | null; // snoozed until it happens instead of a time
  wake_on?: ("ci" | "push" | "approved" | "ready" | "conflict")[]; // what a snooze can wait on now (the snooze menu's 6 on)
  done_at?: string; // while it's done: when (you marked it done, or acted on it in the desk); the Archive's time
  verdict: "look" | "skim" | "skip" | null; // from the AI review of the current commit
  preflight?: Preflight; // Now and Today cards only
  next?: string; // your own PR in Now or Today: "merge conflict with main: m hands it off for merge"; none in Merging or approved and green
  checks_failed?: string[]; // your own PR in Now or Today: its failing checks
  checks_optional?: string[]; // those its base branch doesn't require; CI isn't "red" for these alone
  handed_back?: boolean; // your PR, back from Merging because the coordinator can't get it merged: at the top of the queue, its why says why
  cta?: "ready" | "reply"; // the row's one call to action: "ready" is Ready for review (a) on your own open draft unless its CI is failing; "reply" on your own PR whose only action is answering someone (also on its review's card: its first reply box is focused)
  actions?: GitHubAction[]; // the More menu's GitHub writes the desk allows now ("close", "draft", "merge", "reopen", "request_changes"); absent when none
  last_event?: ActivityEvent; // an issue in Now or Today: its latest event
  involved?: string; // an issue in Now or Today: how you're on it ("assigned to you", "you were mentioned")
  resolved: string | null; // why it needs nobody now: "merged", "closed", "you approved", "approved by alice", "no longer requested"
  resolved_at: string | null; // when it resolved (its last update when GitHub doesn't say); null while it's open
  inflight: boolean; // your open PR, in Merging
  placed_by?: "hard" | "pin" | "claude" | "pending" | "unanswered"; // a hard rule, a pin's floor, Claude, the rules until Claude answers, or since it gave no answer; unset with the judge off and in Merging
  stack?: StackRef; // an open PR whose line has two or more open PRs (Stacks, below)
}

// The AI review of a card's head, for skimming. The other fields come from the latest review, for an older head unless ready.
interface Preflight {
  state: "ready" | "stale" | "running" | "queued" | "paused" | "off" | "none"; // stale: a new one is coming; off: review.auto_ai is off; none: an issue or your PR
  verdict?: "look" | "skim" | "skip";
  risk?: "low" | "medium" | "high";
  summary?: string;
  concerns?: string[]; // at most 2
  notes?: number;
  chunks?: { look: number; skim: number; total: number }; // hunks ranked worth a look or a skim, of all in the diff; unset without a ranking
  at?: string;
}

interface QueueView {
  inquiries: Inquiry[]; // agents' questions waiting on your answer, oldest first: the main page's first rows
  sections: { now: Card[]; today: Card[]; later: Card[]; fyi: Card[] };
  hidden: Card[]; // a rule put it in "hide"
  cleared: Card[]; // done, snoozed, muted
  resolved: Card[]; // the world dealt with it (see Resolved, below); newest first
  cards: number; // queue.cards: the queue is one list, now's cards then today's (each the weightiest first); it shows this many, the rest behind one line; 0 = all
  paused: { who: "claude" | "ai"; why: string } | null; // said once above the queue: claude, when the AI review or the judge can't log in; ai, when AI reviews nobody asked for keep failing otherwise
  stacks: Record<string, Stack>; // by stack id: each stack a card here carries (Stacks, below); current is the card sections list it by, else its first card
}
// BoardView is the same for one board, plus board: BoardSummary & { queries: string[] }, without resolved items, and no stacks: a board lists every PR.
// FocusView is { sections: { now: Card[]; today: Card[] }, cards, paused }; resolved items are never in it; a stack is one card, as in the queue.

interface Overview {
  me: string;
  synced_at: string | null;
  syncing: boolean;
  sync_error: string | null;
  config_errors: { path: string; message: string }[];
  connectors: { id: string; name: string; status: "ok" | "syncing" | "paused" | "error"; synced_at: string | null; error: string | null }[]; // GitHub today
  spaces: { id: string; name: string; boards: BoardSummary[] }[]; // BoardSummary: id, name, space, counts per bucket + cleared, new, error?
  focus: { now: number; today: number; new: number };
  inflight: { total: number }; // your open PRs in Merging
  rate_limit: { remaining: number; reset_at: string } | null;
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

interface ItemDetail {
  card: Card;
  item: Item; // the normalized GitHub item
  signals: Signals; // every field rules can read
  placements: Placement[]; // per board: bucket, rule, why, and the rule trace
  state: ItemState; // done_at, snooze_until, snooze_on_activity, snooze_when, muted, pinned, seen_at
  handoff_prompt: string;
  ai: AiReview | null;
  ai_stale: boolean; // new commits since the AI review
  generating: boolean;
  activity: ActivityEvent[]; // the item's last 8 events, newest first
  stack: Stack | null; // its stack, with it current
}

interface ReviewView {
  card: Card;
  item: Item;
  handoff_prompt: string;
  files: { path: string; previous_path: string | null; status: string; additions: number; deletions: number; patch: string | null }[]; // patch: today's UI renders it; new clients render order's hunks
  files_error: string | null; // the diff couldn't be fetched
  order: ReviewOrder; // every hunk once, in the order to read them (below)
  ai: AiReview | null; // the latest, even if stale
  ai_stale: boolean;
  ai_error: string | null; // the last failed attempt on this commit, or why AI reviews are paused
  generating: boolean;
  approve: { ok: boolean; reason: string | null }; // reason: why not, e.g. "it's your PR"
  activity: ActivityEvent[]; // the PR's last 8 events, newest first
  stack: Stack | null; // its stack, with it current: the sidebar's chain, and up/down for the keys that move along it
}

interface AiReview {
  verdict: "look" | "skim" | "skip";
  risk: "low" | "medium" | "high";
  summary: string;
  concerns: string[];
  notes: { path: string; line: number; side: "new" | "old"; body: string }[]; // line 0: about the whole file
  chunks?: {
    // absent on reviews written before ranking, or when Claude gave no list
    ranked: { id: string; path: string; level: "look" | "skim"; why: string }[]; // Claude's order (at most 20), then hunks it noted but didn't rank, as skims
    unread: string[]; // hunks left out of the prompt because the PR, or their file, was too long to read whole
    capped: boolean; // Claude ranked as many as it may: more may be worth a look
    total: number; // hunks in the diff
  };
  head_oid: string; // the commit it read
  model: string; // as Claude Code reports it ("claude-opus-5[1m]"), else "claude-code"
  at: string;
}

// The desk's reading order for GET /api/review/:id: clients render it as is, without sorting or ranking anything.
interface ReviewOrder {
  ranked: boolean; // false: no ranking for this commit (none yet, written before ranking, or a newer push): chunks is every hunk, file by file
  chunks: ReviewHunk[]; // read these, in this order: Claude's (most worth first; a re-review, what changed since you looked first), then hunks it noted but didn't rank
  unread: ReviewHunk[]; // Claude didn't see these (the PR or their file was too long to read whole), file by file
  skipped: ReviewHunk[]; // Claude saw these and left them out (level "skip"), file by file
  rest: { path: string; file: number; why: string; hunks: ReviewHunk[]; notes: number[] }[]; // folded, by file; why: "lockfile or generated", "no text diff: binary or too large", "renamed without changes"; notes: a file's own when it has no hunks
  notes: number[]; // indices into ai.notes in reading order; empty when the review is for an older commit
}

interface ReviewHunk {
  id: string; // h1, h2, … across the files in order, as the AI review's prompt numbers them
  path: string;
  file: number; // index in files
  index: number; // its place among its file's hunks
  header: string; // its @@ line
  patch: string; // its own lines, the @@ line first: render it on its own
  additions: number;
  deletions: number;
  level: "look" | "skim" | "skip" | "unread" | null; // null: no ranking
  rank: number | null; // 1 = read it first; look and skim only
  why: string | null; // look and skim: Claude's few words ("" on a hunk it noted but didn't rank); unread: "the PR was too long to read whole" or "its file was too long to read whole"
  notes: number[]; // indices into ai.notes to show with it; the file's own notes (line 0) ride on its first hunk in the order
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
  stacked: boolean; // its base isn't the repo's default branch: it sits on another PR
  merge_method: "MERGE" | "SQUASH" | "REBASE" | null; // the repo's default for you, when the desk knows it
  ci: "green" | "red" | "pending" | "none";
  failing: string[]; // failing check names
  approved_by: string[]; // collaborators only (OWNER, MEMBER, COLLABORATOR): the coordinator merges on it
  changes_by: string[]; // changes requested by
  waiting_on: string[]; // asked and not heard from; teams as @slug
  threads_unresolved: number;
  mergeable: "clean" | "conflict" | "unknown";
  draft: boolean;
  rebase: boolean; // the desk gave it to the coordinator only to rebase: ready to merge but conflicts; it leaves once mergeable
  waits_on: string | null; // the first thing between it and a merge: "rebasing", "waits on a CI fix", "waits on a review from dana", "ready to merge"; null once merged or closed
  note: { text: string; at: string } | null; // the coordinator's latest desk_note; untrusted, an agent wrote it
}
// InflightView is { rows: InflightRow[]; stacks: Record<string, Stack>; coordinator: CoordinatorView }, and CoordinatorView is
// { on: boolean; id: string | null; url: string | null; error: string | null; status; queued: boolean } (its claude.ai link;
// why it can't run; what `claude agents` last said it's doing: "busy" | "shell" | "waiting" (a permission prompt) | "idle" |
// "stopped" | null, looked at every 10 s while one of your asks waits on its answer; your ask not handed over yet).
// GET /api/asks is { on, asks: Ask[], coordinator: CoordinatorView }, so a waiting ask can say what it's doing.
// A stack's rows are together, bottom first, where its first row would be; stacks has each of them, its first row current.

// Where a card's PR sits in its stack, counting what's still to land: "3/20".
interface StackRef {
  id: string; // the stack: its bottom PR's id
  pos: number; // this PR's place among the open PRs of its line, 1 = the lowest open one; merged ones below don't count
  size: number; // the open PRs in that line
  folded?: string[]; // on the one card a queue view lists for the stack: its other members it stands for, bottom first
}

interface Stack {
  id: string; // its bottom PR's id
  repo: string;
  base: string; // the branch under the bottom PR: the default branch, or one no PR the desk knows heads
  line: StackMember[]; // bottom first, through the current PR; above a fork, the branch with open PRs, then the longest, then the oldest
  forks: StackMember[]; // the other branches at a fork, bottom first; each member's parent says where it branches off
  current: string; // the PR the view is about
  up: string | null; // the next open PR above the current one on the line
  down: string | null; // and below it
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
  parent: string | null; // the member it's based on; null at the bottom
  current: boolean;
  bucket: Bucket | null; // where the queue has it; null off the queue (merged, closed, cleared, in Merging, on no board)
  why: string; // its card's why ("merged" for a merged one); "" when the desk has none
}
```

## Stacks

A stack is PRs in one repo, each based on the head branch of the one below it, the bottom one on the default branch (or on a branch no PR heads). The desk works them out on every snapshot from the PRs it holds (`src/stacks.ts`, pure), whoever wrote them; nothing about a stack is stored.

- **Links.** A PR's parent is the PR whose head branch is its base, from the repo itself (a fork's branch of the same name isn't it): an open one first, then merged, then closed. A PR GitHub moved to the default branch when the PR below it merged (its latest base change, `Item.retargeted`) keeps that merged PR as its parent.
- **Forks and dead branches.** A PR with two PRs on its branch forks the stack. A line goes bottom to top through a PR and, above it at each fork, takes the branch with open PRs, then the longest, then the oldest PR's; `Stack.forks` has the rest. A closed PR with nothing open or merged above it is in no stack; one with open PRs above it stays, closed.
- **Counting.** `StackRef.pos`/`size` count the open PRs of the PR's line, what's still to land, so merged PRs below don't move "3/20"; the chain still lists them. A PR has a ref when it's open and its line has two or more open PRs: two open PRs forking off a merged one aren't stacked on each other, so neither has a ref and each is its own card (the chain still shows the other branch).
- **One line per stack.** `GET /api/queue` and `/api/focus` list a stack once: of its members with a card in Now, Today, Later and FYI, the one in the most urgent section stands for it, the lowest in the stack on a tie (then the main line before a fork); the others leave the sections and are named on that card's `stack.folded`, bottom first. Boards, hidden, cleared and resolved list every PR. `QueueView.stacks` has the chain of every stack a card in the view carries: current is the card the sections list it by, or the first card of a stack with none there (all cleared, say). `oneLinePerStack()` is the rule. Desktop notifications go per PR, not per line: a member newly in Now is news even while a lower one stands for its stack, and isn't again when it comes to stand for it.
- **Merging.** `GET /api/inflight` keeps a stack's rows together, bottom first.
- **What the desk fetches.** Each sync, for the stacks of PRs on the boards, read only and at most 120 probes a pass, each asked again only after 30 minutes: the PR heading the branch a bottom PR is based on (or was, before GitHub moved it), open PRs based on an open PR's branch, and the stack's members no board lists that are open as of a fetch over 30 minutes ago. Probes for a stack or a PR based on another's branch go first; those that only look for a stack above a PR on the default branch get what's left after 40 are kept for later rounds, and the rest wait for the next pass. Three rounds a pass, so a chain a few PRs deep fills in at once; one repo's probes are one query, three repos at a time. What it fetches is stored without events: context for a stack, not news, so the coordinator doesn't wake for it and the notifications feed treats it as an item the desk doesn't hold. Once a board lists it, it's fetched again and its events since the desk last logged any are logged (`new` if it never did). Any stored member opens in the review view. Members of a listed PR's stack aren't pruned with the items no search returned for 14 days. PRs stored before the desk asked for `head_ref`, `default_branch` and `retargeted` are refetched, 40 a pass.

## Adding

`desk_add` (`POST /api/add`, `desk add <ref>`) is "add X to my review" from any session. A PR or issue the desk doesn't hold is fetched read only (`GitHub.lookup`, then the usual details query) and stored with its events, a `new` first, so the notifications feed follows it from then on; one it holds, a stack's member stored quietly included, is used as it is. Either way it's pinned, and one done, snoozed or muted comes back too (logged as one `pin`: the returned `undo_seq` undoes both), and for a PR the desk then starts what opening its review would: its diff and conversations fetched, Claude's read of what waits on you, and its AI review (with `review.auto_ai`, on someone else's PR with none for this commit), queued with the background ones, two at a time, so an agent adding many doesn't start a `claude` for each. Your pins that no board places, whether added or dropped by a board's search or filter, sit on a board of their own, `added` (why "you added it", Today by default): Claude sorts them like anything else and your pin's floor keeps them in Today or above. They don't notify; you put them there. While a pinned item is open and no search returns it, each sync refreshes it (every 3 minutes, as no search says when it changed), probes its stack, and keeps it from the 14-day prune; once it's merged or closed it resolves and goes like anything else. Nothing is written to GitHub, so agents may call it.

## Resolved

An item is resolved when the world has dealt with it. It's worked out from every snapshot, never stored, so it comes back on its own when the reason stops holding (asked again, reopened). Resolved items leave Now, Today, Later and FYI (and don't count against caps) for `QueueView.resolved`, with the reason as their `why`; done, snooze, mute and pin are kept as they were. The reasons, in order:

- `merged`, `closed`: any item.
- `you approved`: a PR you or your team were asked to review whose latest verdict from you approves, while GitHub no longer asks you and nobody asked you or your team again after that approval. Asked again (a re-request), new commits from someone else, or someone else acting after your latest action (`me.new_activity`: a reply, a review, an @mention), it stops being yours: someone else's approval resolves it as `approved by <login>`, anything else brings it back to wherever its rules put it (new commits: Later, "new commits since your review"; a mention: Today on Mentions). Your own changes request or a dismissed approval doesn't count. It doesn't depend on `github.resolve_on_others_approval` or on more reviews being required: your part is done.
- `approved by <login>`: a PR you or your team were asked to review that someone else (not you, not a bot) approved after the ask, while that's still their latest verdict. Not while your own latest review requests changes, nor while GitHub still says more reviews are required (another approval, or a code owner's). `github.resolve_on_others_approval`: `always` (default), `team_only` (only when the ask went to a team), `never`.
- `no longer requested`: you or your team were asked, the ask is gone, and you never reviewed.

Your own PRs and issues only resolve by merging or closing. An item that drops out of every search gets one refresh so the desk learns which it was; if it's resolved it stays on its boards (past their filters) for 3 days, under Resolved. So does one that resolved in the last 3 days, by a time the resolution itself gives, but is still in a search its board's filter would now drop it from (you approved it: `reviewed-by:@me` still lists it); `no longer requested` has no such time, so it doesn't.

## Merging

Your own open PR, once you're done with it: `m` in the queue, on the open item or in its review hands it off for merge (`POST /api/act` with `inflight`, only from the desk's own page, as for approve: 403 otherwise; `inflight_at` in `ItemState`), and the coordinator ([above](#the-coordinator)) gets it merged. A draft answers 409: Ready for review is yours, so it would wait on you in Merging (`a` first). `b` brings it back to your desk (`takeback`); undo (`u`, the API's undo, from the desk's own page) reverses either, and handing it off again starts afresh, without the last note or hand-back. `d` on your own PR is plain done, as on anything else. Neither writes to GitHub. A hand-off leaves Now, Today and the sorted-away groups (and focus, the status line and `desk_list`) for the Merging tab (`GET /api/inflight`): each row says what it waits on (`waits_on`, the desk's call: red CI, a conflict, changes requested, CI running, unresolved threads, a review, the PR below it in a stack, else "ready to merge") and the coordinator's latest note with its age. Merged and closed ones stay for 3 days. While it's there the coordinator has it: done, snooze and mute answer 409 (`b` first; a hand-off clears an earlier one, and undo brings that back), and the judge doesn't place it.

- **Rebasing.** No keypress: after each sync (`Desk.rebaseConflicts()`), your own PR in Now or Today that's otherwise ready to merge (approved by GitHub's review decision, not a draft, CI not red: GitHub runs no `pull_request` CI on a conflicting PR) and conflicting goes to Merging, while `agent.coordinator` is on and only once this desk has started a coordinator (kv `coordinator_bg`), with `rebase` (when) on its Merging record and one news entry for the coordinator: `ready to merge but conflicts: rebase it onto its base, …, don't merge it; …`. Its row says "rebasing" (`rebase: true`). When GitHub shows it mergeable (or it merges or closes), or `agent.coordinator` is off, the desk takes it out of Merging and drops the record, so it goes back to where the rules put it. A PR with a Merging record isn't sent: one handed back stays handed back until it's mergeable, and `b` leaves `back` (when) on the record, so it stays yours until `m`. A merge conflict alone is no rule's and notifies nobody (the first-run rule that put one on your desk is removed once, as written, with a `config.toml.bak`).
- **Handing back.** When the coordinator can't realistically get it merged (`desk_hand_back`: a redesign, a product decision, a reviewer who needs your answer, CI it can't fix, no local clone), the PR leaves Merging for your desk, at the top of the queue with "handed back: <reason>" as its why, until you deal with it (done, or `m` again), and you're notified. A hand-back writes nothing to GitHub.

### Ready for review

Your own open draft carries one call to action on its row and in its review: Ready for review (`cta: "ready"` on its card, set by the desk), unless its CI is failing: then its why ("your draft: finish it") says what to do. `a` sends `markPullRequestReadyForReview` (`POST /api/review/:id/ready`), then, in its review, `requestReviews` for the reviewers you picked above the button (`@` focuses the box; it searches `GET /api/reviewers/:id` as you type, GitHub's suggestions first; those already asked show and stay), logs each and refreshes the PR, after which it sits wherever the rules and Claude put a ready PR. It's one of the desk's GitHub writes ([Security model](#security-model)).

### More (.)

The typical GitHub actions sit in a More menu (`.` on the selected row, on the queue or under Later, or in a PR's review), each with its own key while it's open. The desk decides which an item offers (`Desk.actions()`, `actions` on its card) and refuses any other with 409. A press of its key sends it. A PR you opened (its real author, never a bot's `via` line) can be closed (`c`), converted to a draft (`d`, unless it is one) and merged now, without the coordinator (`m`, only when it's approved, CI is green, it isn't stacked on another PR, GitHub says it's mergeable and the repo's merge method is known; `mergePullRequest` with `expectedHeadOid` set to the head the desk judged ready); your closed PR reopened (`r`); an open issue you opened or are assigned closed (`c`); and someone else's open PR gets Request changes (`x`, in its review only: what you write is the review's body, sent with the button or ⌘↵, pinned to the commit you read; `head_oid` is required). A PR in Merging offers none (`b` first). `u` while a close's or a draft's toast is up reopens it or marks it ready again; the others have no undo. From a row, a close or a merge leaves the list at once, as Done does. Each goes through `POST /api/github`, a GitHub write like approve ([Security model](#security-model)). A review's approve, merge and Request changes stay pinned to the commit it opened at, so a push you haven't reopened it for is refused (409). After a close, draft, merge or reopen the item offers nothing more until a read shows the change, so a refresh that failed can't offer the same write again.

## Events

`GET /api/events` is a server-sent events stream:

- `event: update` with `data: {"rev": n}`, once on connect and again after any change: a sync landing, a triage action or undo, a config, settings or policy save, an AI review starting or finishing, a judge call starting or finishing, an approval, a draft marked ready, a note or a hand-back arriving, a hand-off or Back to desk. Refetch what you show.
- `event: notify` with `data: {"title", "body"}`, only with `?notify=1`: the desktop app attached to a desk it doesn't run in-process asks for these, and while one listens the desk shows no notification of its own. The desk notifies (`Desk.notifyNew()`, after a sync, a judge answer or a hand-back) for a new item on the queue once Claude or a hard rule placed it (not while Claude hasn't sorted it, nor what your own pin put there, nor what you added, nor your own draft), a hand-back included; each once, outside `notify.quiet`.
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
- **Host and Origin checks** on every route, `/mcp` included. A request whose `Host` isn't `localhost`, `127.0.0.1` or `[::1]` gets 403, which blocks DNS rebinding. A request with an `Origin` other than the desk's own (`http://localhost:<port>`, `http://127.0.0.1:<port>`, plus the Vite dev server on 5173 or 5174, or `DESK_DEV_PORT`, when `DESK_DEV=1`, or exactly `DESK_UI_ORIGIN`, which the desktop app sets for the Vite server it runs from a checkout) gets 403, which blocks other websites. MCP clients and the CLI send no `Origin` and are allowed. A browser request that carries no `Origin` (a no-cors GET, such as an `<img>` pointing at `/api/review/5`, which would start an AI run) still says `Sec-Fetch-Site`; `/api/*` and `/mcp` refuse `cross-site` and `same-site` (another localhost port). Responses can't be framed (`X-Frame-Options: DENY`), and neither can the Vite UI the desktop app runs from a checkout (or `npm run dev`): it sends the same headers, so a site can't frame it to click approve.
- **No auth beyond that.** Any program running as you on this machine can read the queue and triage it, the same as with the CLI. Handing a PR off for merge, and undoing a hand-off or a Back to desk, take the desk's own page, as approve does (below): the coordinator merges what's in Merging, so an agent's shell can't put a PR there.
- **Writes to GitHub, on your keypress.** The desk's GitHub API writes all go through `src/github/write.ts`, whose allowlist holds exactly these mutations: `addPullRequestReview(event: APPROVE)`, sent by `POST /api/review/:id/approve` (the review view's `a`) and pinned with `commitOID` to the commit you read (if the desk has seen a newer push, it refuses); `addPullRequestReviewThreadReply` and `addComment`, sent by `POST /api/review/:id/reply` (Send on your reply in a PR's review), only to one of that PR's own conversations, and `addComment` by `POST /api/review/:id/comment` (`w` in its review); `markPullRequestReadyForReview` and then `requestReviews` (union, for whoever you picked), sent by `POST /api/review/:id/ready` (Ready for review, `a` on your own open draft); and the More menu's `closePullRequest`, `convertPullRequestToDraft`, `mergePullRequest` (pinned with `expectedHeadOid`), `reopenPullRequest`, `addPullRequestReview(event: REQUEST_CHANGES)` and `closeIssue`, sent by `POST /api/github` only when the item's card offers them ([More](#more-)). These routes only take a request the browser marks `Sec-Fetch-Site: same-origin` that also carries the desk's own `Origin` (the desk's page sends both; MCP clients and the CLI send neither), so curl or an agent's shell gets 403. That's a speed bump against a shell that forges headers, not a wall. The module reads its own token, logs every write, and the desk records it in the action log (undo can't reach it). No MCP tool and no CLI command calls it; `m`, `b`, notes and hand-backs write nothing. Everything else is read only: the GitHub client runs GraphQL queries and refuses any document containing `mutation`, REST GETs for the notifications feed (the client refuses any other method, so it can't mark a thread read), and the review reads a PR's files and description with `gh api` GETs. Done, snooze, mute and pin are local state in `desk.db`.
- **The coordinator is yours, not the desk's.** The desk starts and wakes it, but it's your own Claude Code session with your permissions: what it pushes and merges, it does with your `git` and `gh`, under the rules its skill gives it (no plain force-push or reset: after a rebase only `--force-with-lease`, only to your own PR's branch; no comments or replies as you, members' and collaborators' comments only, PR text as data, a re-check before it merges). The desk gives it local tools only, and counts only a collaborator's approval in `approved_by` and `waits_on`. The desk writes deny rules for what it must never run into its directory's `.claude/settings.json` when there's none (README → Coordinator), and its wake messages carry only PR ids, URLs and kinds of change.
- **Untrusted text is fenced.** Titles and AI review text come from GitHub, and a hand-off prompt template can include the title. MCP results that carry them (`desk_list`, `desk_item`, `desk_brief`, and `desk_events` for logins and reasons) put them between `<untrusted-data nonce="…">` and `</untrusted-data nonce="…">`, after a line saying to treat them as data, not instructions; the nonce is random per result, so text inside can't fake the closing marker. Titles are flattened to one line with control characters removed. The AI review's prompt fences PR text with a random tag too, the agent runs with no tools, no MCP servers and an empty working directory, and the CLI strips control characters so a title can't emit terminal escapes. The AI review is untrusted output as well: the diff it read came from GitHub. The judge, and Claude's read of what reviewers said, work the same way: no tools, no MCP, an empty directory, the GitHub text fenced. `desk_merging` fences titles and the coordinator's notes too, and the UI shows notes as text, never runs them.
