# UI

The main page is what needs you: one ordered list, one line per item. A PR's review opens in its place and Esc brings the list back. Later holds what was sorted away, Merging your own PRs Claude is getting merged, and Settings is configuration.

## Principles

- **Only what needs you on the main page.** If it's on the main page, you need to act on it: one list, what the desk put in now and then today, in the desk's order (`src/desk.ts` orders it; the page only renders it, so the tray, MCP and notifications say the same). No now-vs-today split, no headings.
- **One line per item.** The title (17px), then quietly its repo#number (and a stack's place, "3/20"), at most one call to action naming the action, its age on the right. No why, AI gist, concerns, verdict, chips or "sorted by Claude": Enter opens the review (or an issue in place), where all that is, and the keys are in the help overlay (`?`). The call to action is the desk's (`cta` on the card): today only your own open draft's "**a** Ready for review", in ink-2 before the age; `a` arms it ("**a** again to mark ready", in ink semibold, and a toast), a second `a` within 3 s marks it ready on GitHub.
- **Merging is the coordinator's.** A PR you handed off (`m m`) never shows on the main page. The coordinator, your own Claude Code session in your Claude app's sidebar, gets it merged; only a PR it hands back comes back to the main page, on top.
- **Calm, informational.** No highlighter. Ink and pencil grey on the paper; colour only where it carries information: "CI failing" red, "changes requested" and "merge conflict" amber, the same words and colours in a review. Merging is all ink and pencil. Sentence case, no chips or boxed badges, no all-caps, no monospace outside code. The selected row is a neutral fill, nothing more.
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

- A 232px sidebar: GitHub (the main page, with how many need you), Later (no count: nothing there needs you), Merging (no count either: nothing there needs you; the tooltip has how many are merging) and Settings. The active item is a neutral filled pill; a review is under the page it was opened from. At 820px and below it hides; the top bar then names the page and carries quiet "Later" and "Merging 2" links.
- The main page, Later and a review use the window's width, with the page's side padding; Merging keeps an 880px column.
- Every page ends near the window's bottom: below its last line there's only the room j/k leave under a row (84px), never empty paper to scroll into. `npm run shots` checks the queue, a review, Merging and Settings scrolled to the bottom.
- The main page: its first `queue.cards` rows (10), then one pencil line, "11 more", which j/k stop on and Enter (or a click) opens in place; it folds only when two or more would go behind it. Empty, it's one line: "Nothing needs you right now." While Claude can't log in, one line above the rows says so once: "**Claude is paused:** Claude Code isn't logged in, so nothing is being sorted or reviewed. Run `claude auth login`." (or "**AI reviews are paused:**" and why).
- A stack of PRs is one line, the one the desk sends for it (the lowest member in the most urgent place), with its place among the stack's open PRs quietly after its repo#number: "api#4154 3/6". A row under Later in a stack says it the same way.
- The desk's order: what the coordinator handed back; a close look or high risk on the current commit, then on an earlier one; what a cap made not urgent; your PR approved and green; the rest as the rules ordered them; someone else's PR with CI failing, which waits on its author; "Skip it" last. Now's before Today's, each in that order.
- The quiet rule: an item nobody has touched for `queue.quiet_days` (14) leaves the main page for Later, before caps. A pinned item and a review you were asked for in that time stay.
- Enter (or a click) on a PR opens its review (below). On an issue it opens the item in place under its row: why it's here ("Assigned to you"), one pencil line of facts (by, how you were asked, labels, comments, who placed it), where it sits and from which board, a collapsed rule trace, its recent activity (the last 8 events in plain words), and its keys under a hairline (esc Close, o, e, s, m). `w` opens any row in place with the full table of signals, its rule trace and its raw signals. The snooze menu (`s`) opens under the row.
- Later (`#/later`, `g l`): the sorted-away groups, Later (open with the page), FYI, Resolved, Hidden by rules and Cleared, each a heading with its count that opens and closes it (`g f`, `g d`, `g h`, `g x` open one from anywhere). Their rows are the same one line plus, in pencil, why it's there: Later's why or "quiet for 3 weeks", a cleared row's "snoozed until Sat 9:00", a resolved one's reason ("merged", "approved by alice") with when it resolved as its time. Resolved lists the last day's items that were on the main page, or that you opened or resolved yourself. While filtering, groups with matches open on their own and empty ones disappear. Esc goes back to the main page.
- Claude sorts every item; a hard rule is a floor. Who placed it is in the opened item's facts and the rule trace, never on the row.
- Settings: one scrolling page, wider than the queue so the rules editor fits, with no page title (the sidebar names it; one pencil line says where it's saved) and section heads at the groups' 17px. Sections come from the schema in `src/settings.ts`, plus Rules (the TOML editor with preview, and beside it the saved config's hard rules in plain lines: "PRs to review (Personal) → Now: someone asked you directly" over its `when` in pencil, the space named when two boards share a name; with none, one line says Claude can sort anything off your desk); `#/settings/<section>` scrolls to one. Settings stays mounted once opened, so an unsaved Rules draft survives a trip to the queue.
- Settings → Policy, right after Rules: one sentence (how you want Claude to sort your desk), a plain text editor in the UI font, "⌘S Save" (saves the editor you're in) and Revert as an action line, like Rules', then quiet lines: while policy.md is empty the editor holds the starter and one line says "This is the starter policy. Claude sorts by it until you change it." (editing and saving makes it yours; clearing it brings the starter back), the judge's status (a failure in ink, not red) ("23 items sorted by Claude. 7 of 300 this hour.", or why it's off, or its last failure and the next try), and the file's path (the starter is said once, in the line under the editor). If the file changed since you opened it, Save keeps your text and says so.
- Settings → Agents: whether Claude Code has the desk's MCP tools and skill, and Connect when it doesn't; the coordinator itself is a session you start (README → Coordinator), so it has no switch here.
- Settings → Appearance, before Desktop app: one Theme select (System, Light, Dark, Sand, Slate) for this device; it isn't a desk setting, so it isn't in `settings.json` and another window or device keeps its own.
- Settings → AI review: when AI reviews are paused after failures in a row (an expired login), one line says so, its label in ink as above the queue ("**AI reviews are paused:** … Next try in 30m."), within the measure, once, instead of on every PR. Every agent is your own `claude` from your PATH: there's no agent, command or model to set.

## The review view

`#/review/<id>`, Linear-style: the PR is read and approved in the desk, in the queue's place, with the sidebar still there. The diff takes the page's width; a foldable sidebar on the right holds the stack, the files and recent activity.

```
  api#4154  3/6  by priya                                         Stack on main                N P
  Planner: hash join stage                                        ● #4150 Planner: pull the cost…
  asked you directly · CI passing · changes requested             ○ #4152 Planner: run the table…  ✓
  +172 −32 in 3 files                                             ┃○ #4154 Planner: hash join st… ±┃
                                                                  ◌ #4156 Planner: stream partia… ✗
  (threads waiting on you)
                                                                  3 files                      n p
  AI review from Opus 5, 14:32                                    src/planner/plan.ts       • Look
  Look closely   medium risk                                      src/routes/query.ts       • Look
  Adds a streaming scan (streamRows) and uses it in runPlan, ...  docs/api/query.md           Skip
  5 notes on the changes below: ] next, [ previous.
                                                                  Recent activity
  a Approve   o Open on GitHub   c Copy prompt   i Redo AI review  sam commented · 37m

  Look  src/planner/plan.ts  budget checked only between batches  +7 −3
  ┌──────────────────────────────────────────────────────────────┐
  │ 17 + export async function runPlan(q, budgetMs = ...)        │
  │    ┃ The budget is only checked between batches, so ...      │  an AI note, at its line
  └──────────────────────────────────────────────────────────────┘
  Skim  src/planner/stream.ts  new batching generator         +24 −0
  ...
  Not worth reviewing · 2 files
```

- Header: the ref, a stack's place ("3/6", as on the main page), author ("by you" on yours), title, then one line: why it's on the desk (the row doesn't say; a fact it already says is left out), CI, the review state ("approved by marco"), a merge conflict (only while it's open), size. Your PR in Merging says "Merging", with what it waits on and the coordinator's latest note and its age under it, in pencil, as Merging does; Copy prompt and AI review aren't offered on it. Your own open draft offers "**a** Ready for review" first, as its row does. Its keys go in Merging's order, `b` last. Esc and the top bar's back link ("‹ Queue", "‹ Later" or "‹ Merging") go back to the page it was opened from. Problems are coloured words, and pencil at regular weight once the PR is sorted away, resolved, or calm in Merging. A wrapped line starts with a fact, never a "·", and a fact that wraps carries on after its "·", not under it.
- A resolved PR (Enter on a row under Resolved, or one you just approved) says so in one pencil line under the facts, "Resolved: merged by li-wei · 2h" (the reason, who merged or closed it, and how long ago, "just now" in the first minute), in place of the why.
- Under the header, before the AI review, the threads waiting on you (`Conversation`, given the review).
- The AI review: who wrote it, by the model's name ("from Opus 5"), verdict, risk (a pencil fact; only high is red and semibold), summary, concerns as margin notes (as in the diff), and how many notes sit in the code. While it's being written, a quiet line says so; a failure shows its reason in ink, not red (it's about the agent, not the PR), with a command in it set as code (`claude auth login`), and `i` tries again. When AI reviews are paused after failures in a row, a PR that wasn't tried says that. A merged or closed PR with none says "No AI review." (`i` still asks, though the key line leaves it out); your own PR, open or not, shows the section only once a review exists or is being written. A re-review adds "**Since your review:** …" under the summary. A review of an earlier commit stays, marked "on an earlier commit", and its notes aren't placed in the new code.
- The diff in the desk's reading order (`ReviewView.order`), the page's width: what Claude ranked first, a look before a skim, each a hunk under its file's name with its level ("Look" in ink, "Skim" a step quieter) and Claude's few words why; then what Claude didn't read ("Not read", and whether the PR or its file was too long); then one pencil line, "Not worth reviewing · 2 files" (and, when Claude ranked as many as it may, that some may still be worth a look), which `n` stops on and Enter (or a click) opens in place. A file's hunks next to each other at one level read as one. A review without a ranking (none yet, older, or for an earlier commit) keeps file order, and a file with no text diff says so in its header. `n`/`p` step through that order, `]`/`[` through the notes in it.
- The sidebar (`f` folds and opens it, for this device, kept in localStorage; 280px beside the diff above 1100px, over the diff's right edge below it, where it starts folded):
  - The stack, when the PR is in one: "Stack on main", then its PRs bottom first (the line through this PR; other branches at a fork under "Other branches"), each its glyph (○ open, ◌ draft, ● merged, × closed), number and title, and only what's news: CI failing ✗ in red, running ◔, changes requested ± in amber, approved ✓. The PR on screen wears the cursor's fill and ring; the words are in each one's tooltip. A click, or `N` (up) and `P` (down), opens the next one's review.
  - The files, each once in reading order with its level (Look, Skim, Not read, Skip) and a dot when it has notes; a click goes to where reading reaches it. A long folder gives way from its start ("…versions/0008_cache.py") but always shows "…/", so each file's name stays whole right after it. The file you're reading follows the scroll and wears the cursor's fill and ring.
  - Recent activity: the PR's latest events in the queue's words (never the desk's own "first seen"), newest first, three of them and the rest behind a quiet "n more", each with its time after a "·". A resolved PR leaves out its "resolved" event and the one that caused it (the merge, the approval, the removed request); the Resolved line says it.
- Diffs: `@pierre/diffs`, unified, word-level changes, wrapped lines, Shiki highlighting in Pierre's light and dark themes (the one the device's theme is: System follows the computer, Sand is light, Slate dark), on `--sheet` in a hairline frame. Its CSS variables take the app's fonts (JetBrains Mono for code). Each file's name sticks under the top bar while you read it.
- AI notes are margin notes under the line they explain: a thin rule, the note in the UI font. The one `]`/`[` landed on gets the cursor's fill and ring. Notes about a whole file sit above its diff.
- Approve: `a` arms it (the key reads "**a** again to approve" in ink semibold, and a toast says "Press a again to approve"), a second `a` within 3 s sends it; anything else lets it lapse. The key shows only on someone else's open PR; it's disabled, with the reason as its tooltip, on one you already approved at this commit. It approves the commit on screen: if the desk has seen a newer push, it refuses. The approval is one of the desk's writes to GitHub, with Send on a drafted reply ([api.md](api.md#security-model)).

## Merging

`#/inflight`: your own open PRs you handed off with `m m`, which the coordinator is getting merged. Its heading says how many ("Merging 4"), then one pencil line: "The coordinator is getting these merged. What it can't get merged comes back to your queue." Open ones first, the latest activity on top; merged and closed ones sit under Merged for 3 days, flat pencil rows like Resolved's.

- A stack's rows sit together, bottom first, under one quiet line ("Stack on main · 6 open") when two or more of its PRs are here; each says its place after its ref ("2/6").
- Each row: the title and its age, then the ref and what it waits on, the desk's words ("waits on a CI fix", "waits on a second look from dana", "waits on a review from sam, @backend and 4 more", "ready to merge"), then the coordinator's latest note and its age ("Pushed 4be71c2 for dana's 3 comments · 24m"). All ink and pencil, problems included: the coordinator has it. No highlighter.
- The selected row's keys: Review, Open on GitHub, Back to desk.
- Nothing here reaches the main page. Only a PR the coordinator hands back goes there, on top, and leaves Merging.
- Empty, the page is one line: "**Merging** Nothing yet: press m on one of your PRs when you're done with it."

## Keys

`j/k` move (they stop on "n more") · `Enter` review a PR, open an issue, show the rest · `o` GitHub · `a a` the row's call to action (Ready for review on your draft) · `m m` hand your PR off for merge · `e`/`d` done (restore on a cleared item) · `s` snooze, then 1–5 · `m` mute · `p` pin · `u` undo (only what this window did) · `c` copy prompt · `i` AI review · `w` rule trace and signals · `/` filter · `Esc` close, then clear the filter (on Later, back to the main page) · `r` sync · `,` settings · `g r` rules · `g m` Merging · `g l/f/d/h/x` Later with that group open (the key after `g` is always the chord's, never the key's own action) · `?` help, which lists them all.

In a review: `n/p` next and previous change, in reading order · `N/P` up and down the stack · `f` the sidebar · `]/[` next and previous AI note · `a` then `a` approve (or, on your own draft, Ready for review) · `m m` hand off, `b` back to desk · `i` AI review again · `o` GitHub · `c` copy prompt · `Esc` back to where you opened it.

In Merging: `j/k` move · `Enter` review · `o` GitHub · `b` back to desk · `Esc` the main page. `e`, `s` and `m` don't apply there: the coordinator has it, so `b` brings it back first.

Tab focus and the j/k cursor are the same thing: focusing a row selects it.

## Files

|                                                              |                                                                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `web/src/App.tsx`                                            | state, data loading, SSE, keyboard                                                              |
| `web/src/view.ts`                                            | routes, grouping, filter, rule-error line lookup, settings helpers (pure, tested in `web/test`) |
| `web/src/components/TopBar.tsx`                              | wordmark, filter or back link, Later and Merging (narrow), sync, help, settings                 |
| `web/src/components/Queue.tsx`, `CardRow.tsx`, `Detail.tsx`  | the main page and Later: one-line rows, an item opened in place                                 |
| `web/src/components/Review.tsx`                              | a PR's review: header, AI review, files, Pierre diffs with notes, approve                       |
| `web/src/components/Inflight.tsx`                            | Merging: your PRs handed off, what each waits on, the coordinator's latest note                 |
| `web/src/components/Settings.tsx`, `Rules.tsx`, `Policy.tsx` | configuration                                                                                   |
| `web/src/styles.css`, `web/src/theme.ts`                     | token sets per theme, then layout by area; the device's theme, kept in localStorage             |
| `web/src/fonts/`                                             | Instrument Sans (UI), JetBrains Mono (code), bundled so nothing loads from the network          |
| `web/mock/server.ts`, `diffs.ts`                             | an in-memory API for UI work without GitHub: `node web/mock/server.ts`; real-looking diffs      |
