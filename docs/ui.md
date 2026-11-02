# UI

The main page is what needs you: one ordered list, one line per item. A PR's review opens in its place and Esc brings the list back. Later holds what was sorted away, Merging your own PRs Claude is getting merged, and Settings is configuration.

## Principles

- **Only what needs you on the main page.** If it's on the main page, you need to act on it: one list, what the desk put in now and then today, in the desk's order (`src/desk.ts` orders it; the page only renders it, so the tray, MCP and notifications say the same). No now-vs-today split, no headings.
- **One line per item.** The title (17px), then quietly its repo#number, its age on the right. No why, AI gist, concerns, verdict, chips, "sorted by Claude" or per-row keys: Enter opens the review (or an issue in place), where all that is, and the keys are in the help overlay (`?`).
- **Merging is Claude's.** A PR you handed off (`m m`) never shows on the main page, whatever it needs from you (a question, a reply to Send, ready to merge, outsiders' comments): Merging lists those first and counts them on its sidebar entry. Only a PR Claude hands back comes back to the main page.
- **Calm, informational.** No highlighter. Ink and pencil grey on the paper; colour only where it carries information: "CI failing" red, "changes requested" and "merge conflict" amber, the same words and colours in a review and in Merging. Sentence case, no chips or boxed badges, no all-caps, no monospace outside code. The selected row is a neutral fill, nothing more.
- **Themes are per device.** Tokens live on `:root` in `web/src/styles.css`: the light set, the dark set under `prefers-color-scheme` (System), and `[data-theme]` sets for Light, Dark, Sand (warm paper) and Slate (blue-grey dark). Settings → Appearance picks one for this device (`web/src/theme.ts`, in localStorage, never a desk setting), and `index.html` applies it before the first paint. Text colours are `--ink`, `--ink-2` and `--pencil`; `--faint` is for non-text only. Check every change in light and dark and each theme (`npm run shots`).

## Layout

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Review Desk  │ [ Filter / ]                                        Synced 1m  │
│              ├────────────────────────────────────────────────────────────────┤
│ GitHub    21 │ Add a keep-alive timeout option  tinyhttp#205               26h │  handed back by Claude: first
│ Later        │ Support HTTP/2 prior knowledge  tinyhttp#212                29h │
│ Merging    2 │ Retry dead-lettered jobs with jittered backoff  worker#882  26h │  the selected row: a neutral fill
│              │ …                                                              │
│              │ 11 more                                                        │
│ Settings   , │                                                                │
└───────────────────────────────────────────────────────────────────────────────┘
```

- A 232px sidebar: GitHub (the main page, with how many need you), Later (no count: nothing there needs you), Merging (with how many wait on you there; the tooltip has how many are merging) and Settings. The active item is a neutral filled pill; a review is under the page it was opened from. At 820px and below it hides; the top bar then names the page and carries quiet "Later" and "Merging 2" links.
- The main page and Later use the window's width, with the page's side padding; Merging keeps an 880px column, a review 1280px.
- Every page ends near the window's bottom: below its last line there's only the room j/k leave under a row (84px), never empty paper to scroll into. `npm run shots` checks the queue, a review, Merging and Settings scrolled to the bottom.
- The main page: its first `queue.cards` rows (10), then one pencil line, "11 more", which j/k stop on and Enter (or a click) opens in place; it folds only when two or more would go behind it. Empty, it's one line: "Nothing needs you right now." While Claude can't log in, one line above the rows says so once: "**Claude is paused:** Claude Code isn't logged in, so nothing is being sorted or reviewed. Run `claude auth login`." (or "**AI reviews are paused:**" and why).
- The desk's order: what Claude handed back; a close look or high risk on the current commit, then on an earlier one; what a cap made not urgent; your PR approved and green; the rest as the rules ordered them; someone else's PR with CI failing, which waits on its author; "Skip it" last. Now's before Today's, each in that order.
- The quiet rule: an item nobody has touched for `queue.quiet_days` (14) leaves the main page for Later, before caps. A pinned item and a review you were asked for in that time stay.
- Enter (or a click) on a PR opens its review (below). On an issue it opens the item in place under its row: why it's here ("Assigned to you"), one pencil line of facts (by, how you were asked, labels, comments, who placed it), where it sits and from which board, a collapsed rule trace, its recent activity (the last 8 events in plain words), and its keys under a hairline (esc Close, o, e, s, m). `w` opens any row in place with the full table of signals, its rule trace and its raw signals. The snooze menu (`s`) opens under the row.
- Later (`#/later`, `g l`): the sorted-away groups, Later (open with the page), FYI, Resolved, Hidden by rules and Cleared, each a heading with its count that opens and closes it (`g f`, `g d`, `g h`, `g x` open one from anywhere). Their rows are the same one line plus, in pencil, why it's there: Later's why or "quiet for 3 weeks", a cleared row's "snoozed until Sat 9:00", a resolved one's reason ("merged", "approved by alice") with when it resolved as its time. Resolved lists the last day's items that were on the main page, or that you opened or resolved yourself. While filtering, groups with matches open on their own and empty ones disappear. Esc goes back to the main page.
- Claude sorts every item; a hard rule is a floor. Who placed it is in the opened item's facts and the rule trace, never on the row.
- The coordinator: when it changed the queue in the last day, the top bar carries one quiet pencil line, "Coordinator snoozed 2 items · 4m" ("just now" in the first minute; below 1000px the name goes and the verb stays, "Snoozed 2 items · 4m"). What it cleared says so under Later → Cleared ("coordinator snoozed until Sat 9:00 or new activity"), and its reason is in that row's opened facts. Housekeeping that never reached you (Later, FYI) stays in its log and Settings → Agents. A click (`esc Close`) opens its log above the rows: one pencil line per run ("Run 14 · 6 events, 3 actions") above its actions, each with its reason and a pencil Undo, and its notes (not one that only repeats its run's single action), with the time on the right like a row's age; what it did outside a run (a policy edit in a terminal) sits under its own "In a terminal" line. A learn run reads "Run 13 · read your last 6 actions"; a policy change is "Changed the policy" with what it took out and put in under it, one pencil line each ("− …", "+ …", three at most), and a pencil Undo that puts the text before it back. No colour, no badge.
- Settings: one scrolling page, wider than the queue so the rules editor fits, with no page title (the sidebar names it; one pencil line says where it's saved) and section heads at the groups' 17px. Sections come from the schema in `src/settings.ts`, plus Rules (the TOML editor with preview, and beside it the saved config's hard rules in plain lines: "PRs to review (Personal) → Now: someone asked you directly" over its `when` in pencil, the space named when two boards share a name; with none, one line says Claude can sort anything off your desk); `#/settings/<section>` scrolls to one. Settings stays mounted once opened, so an unsaved Rules draft survives a trip to the queue.
- Settings → Policy, right after Rules: one sentence (how you want Claude to sort your desk; the coordinator refines it), a plain text editor in the UI font, "⌘S Save" (saves the editor you're in) and Revert as an action line, like Rules', then quiet lines: while policy.md is empty the editor holds the starter and one line says "This is the starter policy. Claude sorts by it until you change it." (editing and saving makes it yours; clearing it brings the starter back), the judge's status (a failure in ink, not red) ("23 items sorted by Claude. 7 of 300 this hour.", or why it's off, or its last failure and the next try), and the file's path (the starter is said once, in the line under the editor). If the file changed since you opened it, Save keeps your text and says so.
- Settings → Agents → Coordinator: the switch, one line of status ("Idle. Last run 5m ago: 6 events, 3 actions.", "Running, started 20s ago.", its last error and next try in ink, or why it's off), then its short session id and the command that opens it in a terminal, all of it, wrapping between arguments (`cd ~/.review-desk/coordinator && claude --resume <id> --mcp-config mcp.json`: your own Claude Code plus the desk's tools), with Copy.
- Settings → Appearance, before Desktop app: one Theme select (System, Light, Dark, Sand, Slate) for this device; it isn't a desk setting, so it isn't in `settings.json` and another window or device keeps its own.
- Settings → AI review and → Merging: when AI reviews or babysitters are paused after failures in a row (an expired login), one line says so, its label in ink as above the queue ("**AI reviews are paused:** … Next try in 30m."), within the measure, once, instead of on every PR. Every agent is your own `claude` from your PATH: there's no agent, command or model to set, and Settings → Agents only says whether Claude Code has the desk's tools and skill.

## The review view

`#/review/<id>`, Linear-style: the PR is read and approved in the desk, in the queue's place, with the sidebar still there. The column widens to 1280px.

```
  api#4127  by priya                                       Recent activity
  Stream partial results from the query planner            sam commented · 37m
  asked you directly · CI passing · review required        you were mentioned · 1h
  +62 −7 in 5 files                                        priya pushed · 2h
                                                           2 more

  AI review from Opus 5, 14:32
  Look closely   medium risk
  Adds a streaming scan (streamRows) and uses it in runPlan, so ...
  ┃ src/routes/query.ts passes ?budget= through Number() unchecked ...
  5 notes on the changes below: ] next, [ previous.

  a Approve   o Open on GitHub   c Copy prompt   i Redo AI review

  5 files          n p  │ src/planner/stream.ts                        new +24 −0
  src/planner/stream.ts │ ┌───────────────────────────────────────────────────┐
  src/planner/plan.ts   │ │  9 + // Yields rows in batches as the scan ...    │
  ...                   │ │ 10 + export async function* streamRows(...)       │
                        │ │    ┃ The core of the change: rows come out in ... │  an AI note, at its line
```

- Header: the ref, author ("by you" on yours), title, then one line: why it's on the desk (the row doesn't say; a fact it already says is left out), CI, the review state ("approved by marco"), a merge conflict (only while it's open), size. Your PR in Merging says why it waits on you, as Merging does ("**Merging:** reply ready to send", or just "merging" while Claude has it), adds Claude's line from Merging under it, in pencil, unless it only repeats the why (a question, no clone: then the "Set up a local clone" link), and the reply waiting for Send as a margin note, which `y` (twice) sends and `x` discards from here too. With a question, `c` answers it in a terminal and `x` dismisses it, as in Merging; Copy prompt and AI review aren't offered on a PR in Merging. Its keys go in Merging's order, `b` last. Esc and the top bar's back link ("‹ Queue", "‹ Later" or "‹ Merging") go back to the page it was opened from. Problems are coloured words, and pencil at regular weight once the PR is sorted away, resolved, or calm in Merging. A wrapped line starts with a fact, never a "·", and a fact that wraps carries on after its "·", not under it.
- A resolved PR (Enter on a row under Resolved, or one you just approved) says so in one pencil line under the facts, "Resolved: merged by li-wei · 2h" (the reason, who merged or closed it, and how long ago, "just now" in the first minute), in place of the why.
- Recent activity: the PR's latest events in the queue's words (never the desk's own "first seen"), newest first, three of them and the rest behind a quiet "n more", each with its time after the facts' "·". Above 1100px it's a column of its own beside the facts and the AI review, one event a line; narrower, it's one wrapped pencil line under the facts ("sam commented 37m · you were mentioned 1h · 2 more"), so the AI review and the diff stay near the top. A resolved PR leaves out its "resolved" event and the one that caused it (the merge, the approval, the removed request); the Resolved line says it.
- The AI review: who wrote it, by the model's name ("from Opus 5"), verdict, risk (a pencil fact; only high is red and semibold), summary, concerns as margin notes (as in the diff), and how many notes sit in the code. While it's being written, a quiet line says so; a failure shows its reason in ink, not red (it's about the agent, not the PR), with a command in it set as code (`claude auth login`), and `i` tries again. When AI reviews are paused after failures in a row, a PR that wasn't tried says that. A merged or closed PR with none says "No AI review." (`i` still asks, though the key line leaves it out); your own PR, open or not, shows the section only once a review exists or is being written. A re-review adds "**Since your review:** …" under the summary. A review of an earlier commit stays, marked "on an earlier commit", and its notes aren't placed in the new code.
- Files on the left (sticky, 300px from 1280px up; above the diff at 1100px and below), with a dot on files that have notes. A long folder gives way from its start ("…versions/0008_cache.py") but always shows "…/", so each file's name stays whole right after it, wrapping when it's longer than the list. The file you're reading follows the scroll and wears the cursor's fill and pencil ring; at the page's end, that's the last file.
- Diffs: `@pierre/diffs`, unified, word-level changes, wrapped lines, Shiki highlighting in Pierre's light and dark themes (the one the device's theme is: System follows the computer, Sand is light, Slate dark), on `--sheet` in a hairline frame. Its CSS variables take the app's fonts (JetBrains Mono for code). Each file's name sticks under the top bar while you read it.
- AI notes are margin notes under the line they explain: a thin rule, the note in the UI font. The one `]`/`[` landed on gets the cursor's fill and ring. Notes about a whole file sit above its diff.
- Approve: `a` arms it (the key reads "**a** again to approve" in ink semibold, and a toast says "Press a again to approve"), a second `a` within 3 s sends it; anything else lets it lapse. The key shows only on someone else's open PR; it's disabled, with the reason as its tooltip, on one you already approved at this commit. It approves the commit on screen: if the desk has seen a newer push, it refuses. The approval is one of the desk's writes to GitHub, with Send on a drafted reply ([api.md](api.md#security-model)).

## Merging

`#/inflight`: your own open PRs you handed off with `m m`, and what Claude is doing on each. Its heading says how many and how many wait on you ("Merging 4 · 2 waiting on you"), and the sidebar entry carries that second count. One list, those waiting on you first, then the ones Claude is working on, then the quiet ones; merged and closed ones sit under Merged for 3 days, flat pencil rows like Resolved's.

- Each row: the title and its age, then the ref, why it waits on you (a real label in ink, "**Claude asks:** …"; otherwise regular ink, "Reply ready to send", "Comments from outside contributors", "Ready to merge") and the PR's state in plain words (CI passing, failing with up to two check names, or running; approved by, changes requested by, waiting on, people first and teams as a count; unresolved threads; merge conflict; auto-merge on); then what it waits on and Claude's own line ("fixing CI · 4m · npm test", "pushed a fix for 2 comments · abc1234"). With Claude off, the intro says so once and a PR has the problem itself as its why ("CI failing").
- Calm: a row is ink and pencil grey while Claude has it, problems included. One waiting on you has its why in ink and its problems their colour. No highlighter.
- A drafted reply sits under its row like an AI note in a review, a margin rule and no card. Send (`y`, twice) and Discard (`x`) are the selected row's keys; Send posts it on GitHub as you, and `y` in its review sends the same reply.
- The selected row's keys, what finishes it first and Back to desk last: Send and Discard (with a reply), or Answer in a terminal and Dismiss the question (with a question; Mark read for outside contributors' comments), then Review, Open on GitHub, Copy resume command and Back to desk.
- Nothing here reaches the main page: a question, a reply, ready to merge or outsiders' comments wait here. Only a PR Claude hands back goes to the main page, on top, and leaves Merging.
- Empty, the page is one line: "**Merging** Nothing yet: press m on one of your PRs when you're done with it."

## Keys

`j/k` move (they stop on "n more") · `Enter` review a PR, open an issue, show the rest · `o` GitHub · `m m` hand your PR off for merge · `b` turn off the auto-merge `m` turned on · `e`/`d` done (restore on a cleared item) · `s` snooze, then 1–5 · `m` mute · `p` pin · `u` undo (only what this window did) · `c` copy prompt · `i` AI review · `w` rule trace and signals · `/` filter · `Esc` close, then clear the filter (on Later, back to the main page) · `r` sync · `,` settings · `g r` rules · `g m` Merging · `g l/f/d/h/x` Later with that group open (the key after `g` is always the chord's, never the key's own action) · `?` help, which lists them all.

In a review: `n/p` next and previous file · `]/[` next and previous AI note · `a` then `a` approve · `m m` hand off, `b` back to desk · `y` then `y` send your PR's drafted reply, `x` discard it · `i` AI review again · `o` GitHub · `c` copy prompt · `Esc` back to where you opened it.

In Merging: `j/k` move · `Enter` review · `o` GitHub · `b` back to desk · `y` then `y` send the drafted reply · `x` dismiss the question (or outside comments), or discard the reply · `c` copy the resume command · `Esc` the main page. `e`, `s` and `m` don't apply there: Claude has it, so `b` brings it back first.

Tab focus and the j/k cursor are the same thing: focusing a row selects it.

## Files

|                                                              |                                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `web/src/App.tsx`                                            | state, data loading, SSE, keyboard                                                                      |
| `web/src/view.ts`                                            | routes, grouping, filter, rule-error line lookup, settings helpers (pure, tested in `web/test`)         |
| `web/src/components/TopBar.tsx`                              | wordmark, filter or back link, the coordinator's line, Later and Merging (narrow), sync, help, settings |
| `web/src/components/CoordinatorLog.tsx`                      | the coordinator's log, opened from the top bar                                                          |
| `web/src/components/Queue.tsx`, `CardRow.tsx`, `Detail.tsx`  | the main page and Later: one-line rows, an item opened in place                                         |
| `web/src/components/Review.tsx`                              | a PR's review: header, AI review, files, Pierre diffs with notes, approve                               |
| `web/src/components/Inflight.tsx`                            | Merging: your PRs handed off, what Claude is doing, what waits on you, drafts with Send                 |
| `web/src/components/Settings.tsx`, `Rules.tsx`, `Policy.tsx` | configuration; the coordinator's status sits in Settings.tsx                                            |
| `web/src/styles.css`, `web/src/theme.ts`                     | token sets per theme, then layout by area; the device's theme, kept in localStorage                     |
| `web/src/fonts/`                                             | Instrument Sans (UI), JetBrains Mono (code), bundled so nothing loads from the network                  |
| `web/mock/server.ts`, `diffs.ts`                             | an in-memory API for UI work without GitHub: `node web/mock/server.ts`; real-looking diffs              |
