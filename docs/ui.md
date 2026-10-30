# UI

One surface. The window is the queue; a PR's review opens in its place and Esc brings the queue back. In flight lists your own PRs that agents are keeping moving, and Settings is configuration.

## Principles

- **Minimize surfaces, maximize automation.** One queue; boards and rules feed it and are edited in Settings → Rules. The sidebar navigates the queue, In flight and Settings; it never categorizes by repo or board.
- **Only urgency gets colour.** A yellow highlighter marks Now: the heading and each item's ref (an empty Now has none). It's a marker stroke (`::before`, chisel-cut caps sized in em, a wavy middle, a slight tilt), never a box; `npm run shots` checks it covers its text and is never clipped. Everything else is ink and pencil grey. Problems are coloured words on every Now and Today card, the same words and colours everywhere (the queue, a review, the lane): "CI failing" red, "changes requested" and "merge conflict" amber; they turn grey once sorted away. Passing CI, a verdict, an agent's failure: ink and pencil; "high risk" is the AI's one red word.
- **No boxes around words.** No chips, tags or outlined badges. Cards are sheets on the paper, never outlined. The only frame is the keyboard cursor: a neutral fill with a pencil ring, on a card as on a row (and on a key you Tab to); any other focus ring is pencil, never blue. A link in a sentence is ink-2 over a quiet rule, and a switch that's on is ink: blue is only the new dot. A key is a pencil letter before what it does ("**esc** Close", "**1** 1 hour"), never boxed and never after its label.
- **Sentence case.** No all-caps labels, no monospace outside code.
- **Both themes.** Tokens live on `:root` in `web/src/styles.css`, with a dark block under `prefers-color-scheme`. Check every change in light and dark. Text colours are `--ink`, `--ink-2` and `--pencil`; `--faint` is for non-text only.

## Layout

```
┌───────────────────────────────────────────────────────────────┐
│ ● ● ●  Review Desk  [ Filter / ]                    Synced 1m │  title bar (drag region in the app)
├───────────────────────────────────────────────────────────────┤
│      AI reviews are paused: Claude Code isn't logged in. …    │  only while they are
│      Now 7                                                    │
│    ╭───────────────────────────────────────────────────────╮  │
│    │ Read eval API keys from macOS Keychain            32d │  │  the title, whole; its age
│    │ seer#8463  asked you directly   +62 −7 · Look closely │  │  ref, why, problems; size and the AI's call
│    │ Reads the eval keys from the Keychain instead of the  │  │  the AI's gist, in whole sentences
│    │ env file. A missing key now fails at startup.         │  │
│    │ ┃ The fallback logs the key's name and its value.     │  │  its top concern (look closely, high risk)
│    ╰───────────────────────────────────────────────────────╯  │
│    ╭───────────────────────────────────────────────────────╮  │
│    │ Paginate the audit log export                      3d │  │  your PR
│    │ api#4122  In flight: reply ready to send              │  │  what you owe, its label in ink
│    │ ┃ Kept it as the row id: the API docs promise a …     │  │  the reply y sends
│    ╰───────────────────────────────────────────────────────╯  │
│      …                                                        │
│    ╰───────────────────────────────────────────────────────╯  │  the folded cards' edges
│      2 more need you                                          │
│      Today 8                                                  │
│    ╭───────────────────────────────────────────────────────╮  │
│    │ Remove the sentry.get_dsn helper                  22h │  │
│    │ seer#9073  close collaborator       +4 −120 · Skip it │  │
│    │ Deletes an unused helper and its tests.               │  │
│    ╰───────────────────────────────────────────────────────╯  │
│      …                                                        │
│    ╰───────────────────────────────────────────────────────╯  │  the folded cards' edges
│      3 more for today                                         │
│      Sorted away   later   resolved                           │
└───────────────────────────────────────────────────────────────┘
```

- A 232px sidebar: GitHub (the queue, with its Now and Today count), In flight (with how many PRs are in flight, as its heading says; the ones that need you are in Now) and Settings, counts in pencil. The active item is a neutral filled pill; a review is under the page it was opened from. At 820px and below it hides; the top bar then names the page and carries a quiet "In flight 3" link.
- One centred column beside it: 800px for the queue and In flight, so the AI's call on a card's right edge sits near its title. The top bar's filter starts on the column's edge. In the queue, In flight and the coordinator's log, headings and every card's text start on one edge.
- The queue is prefiltered, not a list of GitHub: only Now and Today show, the weightiest first, every card carries its pre-flight, and everything else is one quiet line below.
- A card (Now and Today): the title, whole and wrapping, with the new dot and pin after its last word and its age on the right. Then the ref, why it's here and its problems in their colours (left out when the why says them), and on the right edge the size in pencil (not on your own PR) and the AI's call: "Look closely" (semibold ink), "Skim it" (ink-2), "Skip it" (pencil), the review's own words, with "high risk" in red before it. Refs read down the left and calls down the right. Then the AI's gist, as long as the call is heavy: whole sentences at a 72ch measure, up to about 200 characters and three lines to look closely, 140 and two lines to skim, the first clause on one line to skip. A card the AI says to look at closely, or calls high risk, adds its top concern as a margin note (a thin rule, no box): its first sentence, consequence included, never clipped. A number keeps its unit on its line ("15 s", "0–100 %"). An issue's third line is its latest event, in pencil ("tomas commented · 4h"); then its why says how you're on it ("assigned to you", "you were mentioned") instead of only that something is new, and it carries no new dot. A comment's text isn't shown: it's GitHub text the event log, which agents read, doesn't keep.
- Your own PR's why is what you owe: a real label in ink, the rest regular ("**Babysitter asks:** keep it nightly, or switch to hourly?", "**In flight:** reply ready to send", "**Approved and green:** merge it"), and a why without a label in regular ink. Its third line is only what a card's keys don't already say: the reply waiting for Send, as a margin note (its first sentence; `y` twice sends it from the queue), or what failed and the key that deals with it ("Acceptance failing · **d** hands it to a babysitter"), less what its why already says; selected, the keys say it, so the line goes. In flight, what failed goes with the problem word, as in the lane ("CI failing: node 22, lint"), and a PR with no clone to work in says where to set one up ("Set up a local clone of oss/tinyhttp so a babysitter can take it", a link to Settings → In flight). A babysitter's question leaves the PR's problems to the lane. A failing check its base branch doesn't require isn't "CI failing": it's a pencil "optional check failing".
- No current review: the call's place says "AI review being written", "AI review queued" or "AI review paused", in pencil. A review of an older commit keeps its call with "· updating" (or "· paused", "· earlier commit" when auto reviews are off), and its gist and concern turn pencil. While AI reviews are paused (an expired login), one line above Now says so once: "**AI reviews are paused:** Claude Code isn't logged in. Run `claude auth login` in a terminal."
- The selected card has a neutral fill and the pencil ring, and opens in place: about four lines of the summary (Enter opens the review with the rest), up to two concerns, one pencil line of facts ("by priya", unless its stack's head says it; CI passing or running, approved, threads, draft, risk below high, "5 notes on the changes", a demotion like "Now was full on PRs to review (3)"; less what the card already says), then its keys under a hairline ("enter Review o Open on GitHub e Done s Snooze m Mute"; your PR adds "d Hand to a babysitter"; one in flight has only Show in flight, Open on GitHub, Send (`y`, with a reply), Answer in a terminal (`c`) and Dismiss (`x`) with a question, and Take back). `y` arms Send: the key line and a toast say "Press y again to send", a second `y` within 3 s posts it, anything else lets it lapse. j/k move focus with the cursor, so Tab goes on to the selected card's keys, from the first card the queue selects on load too; a key under the keyboard wears the cursor's fill and ring. A group's first card brings its heading into view. j/k keep the card they land on where it was while the one they left closes above it. A click opens a card without selecting it first, since the selected card grows. The snooze menu opens under the card, never over its keys.
- Stacks: three or more consecutive items with the same author and reason sit under one line ("3 PRs from vaind asked you directly", the problem in its colour) on one sheet, ruled apart; their cards leave the why out. Your own are "Your 7 PRs" wherever they are, sorted away too. A stack of your own PRs is "Your 3 PRs **CI failing** **d** hands each to a babysitter", and each PR in it is two lines: its title, and its ref with what failed.
- The order: within Now and Today, the weightiest first: a close look, high risk, an item a cap pushed out of Now, and your PR one key from done (a reply to send, a question, approved and green); then the rest as the rules ordered them, your PR in flight that no key finishes (no clone) among them; "Skip it" last. Over a cap, an item the AI says to skip gives up its slot first ("the AI says skip it"), so the next one gets in and gets its own review.
- The fold: Now shows its first `queue.now_cards` cards (5) and Today its first `queue.today_cards` (5); the rest sit behind one pencil line, "6 more need you", "3 more for today", with the next cards' edges showing under the last one (a step lighter than a sheet in dark). A stack is all above the line or all behind it. j/k stop on it (the cards' cursor, the column's full width) and Enter (or a click) opens the rest in place.
- An empty group is one line: "**Now** Nothing needs you right now." with no highlighter and no 0, "**Today** Nothing else for today."
- The quiet rule: an item nobody has touched for `queue.quiet_days` (14) leaves Now and Today for Later, before caps, with "quiet for 3 weeks" as its note. A pinned item and a review you were asked for in that time stay.
- Sorted away: later and resolved, on one quiet line with no counts. FYI, hidden by rules and cleared aren't named there: they open on their chords (`g f`, `g h`, `g x`) or the filter, and join the line while open. Opened, their items are flat rows on the paper, not cards, with regular-weight titles: title, then ref, why, problems in grey (and a note like "quiet for 3 weeks"). Each name opens its group inline (`g l`, `g d`); they're closed again on every load. While filtering, empty groups disappear, groups with matches open on their own, and nothing folds.
- Resolved rows are dimmed like cleared ones (pencil titles), carry no "new" dot, and show the reason ("merged", "you approved", "approved by alice", "no longer requested") where the why goes, and when it resolved where the wait time goes, newest first. Acting on one (done, snooze) keeps it under Resolved.
- Enter (or a click) on a PR opens its review (below); on your PR in flight, which is only in Now because it needs you, it opens In flight at that PR. On an issue it opens the item in place, in the selected card's shape: one pencil line of facts (by, how you were asked unless the why says it, labels, comments, last activity), one line of why only when it says more than the card's (for a resolved item, the reason first and then where it would be otherwise; the policy; a cap), a collapsed rule trace, its recent activity (the last 8 events in plain words: "alice approved · 2h", "CI went red · 20m", your own as "you"; never the desk's own "first seen", nor the event its why already says), and its keys under the hairline (esc Close, o, e, s, m). `w` opens any card in place with the full table of signals, its rule trace and its raw signals.
- An item the policy judge placed shows the judge's why as its why; its detail says "by your policy", and the rule trace ends with a `policy` step (`today, the tokenizer you maintain`, or `not judged yet, so the board default`).
- The coordinator: when it changed Now or Today in the last day, the top bar carries one quiet pencil line, "Coordinator snoozed 2 Today items · 4m" (below 1000px just "Coordinator · 4m"; "just now" in the first minute). Housekeeping that never reached you (Later, FYI) stays in its log and Settings → Agents. A click (`esc Close`) opens its log above the queue, on the cards' edge: one pencil line per run ("Run 14 · 6 events, 3 actions") above its actions, each with its reason and a pencil Undo, and its notes, with the time on the right like a card's age. No colour, no badge.
- Settings: one scrolling page, wider than the queue so the rules editor fits, with no page title (the sidebar names it; one pencil line says where it's saved) and section heads at the groups' 17px. Sections come from the schema in `src/settings.ts`, plus Rules (the TOML editor with preview); `#/settings/<section>` scrolls to one. Settings stays mounted once opened, so an unsaved Rules draft survives a trip to the queue.
- Settings → Policy, right after Rules: one sentence ("Prose guidance the judge and the coordinator follow."), a plain text editor in the UI font (an example as its placeholder), "⌘S Save" (saves the editor you're in) and Revert as an action line, like Rules', then one quiet line of the judge's status (a failure in ink, not red) ("23 items placed by the policy. 7 of 60 this hour.", or why it's off, or its last failure and the next try) and the file's path. If the file changed since you opened it, Save keeps your text and says so.
- Settings → Agents → Coordinator: the switch, one line of status ("Idle. Last run 5m ago: 6 events, 3 actions.", "Running, started 20s ago.", its last error and next try in ink, or why it's off), then its short session id and the command that opens it in a terminal on one line (an ellipsis if it doesn't fit), with Copy.
- Settings → AI review and → In flight: when AI reviews or babysitters are paused after failures in a row (an expired login), one line says so, its label in ink as above Now ("**AI reviews are paused:** … Next try in 30m."), within the measure, once, instead of on every PR. Every agent is your own `claude` from your PATH: there's no command or model to set.

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

- Header: the ref (highlighted when it's in Now), author ("by you" on yours), title, then one line: why it's on the desk (a fact it already says is left out, as on the card), CI, the review state ("approved by marco"), a merge conflict, size. Your PR in flight says so in its why, worded as in Now ("**In flight:** reply ready to send", or just "in flight" while its babysitter has it, as calm as its lane row), adds the babysitter's line from the lane under it, in pencil, and the reply waiting for Send as a margin note, which `y` (twice) sends and `x` discards from here too. Esc and the top bar's back link ("‹ In flight" or "‹ Queue") go back to the page it was opened from. Problems are coloured words, as in the queue, and grey once the PR is sorted away or resolved. A wrapped line starts with a fact, never a "·", and a fact that wraps carries on after its "·", not under it.
- A resolved PR (Enter on a row under Resolved, or one you just approved) says so in one pencil line under the facts, "Resolved: merged by li-wei · 2h" (the reason, who merged or closed it, and how long ago, "just now" in the first minute), in place of the why; its ref loses Now's highlighter.
- Recent activity: the PR's latest events in the queue's words (never the desk's own "first seen"), newest first, three of them and the rest behind a quiet "n more", each with its time after the facts' "·". Above 1100px it's a column of its own beside the facts and the AI review, one event a line; narrower, it's one wrapped pencil line under the facts ("sam commented 37m · you were mentioned 1h · 2 more"), so the AI review and the diff stay near the top. A resolved PR leaves out its "resolved" event and the one that caused it (the merge, the approval, the removed request); the Resolved line says it.
- The AI review: who wrote it, by the model's name ("from Opus 5"), verdict, risk (a pencil fact; only high is red and semibold), summary, concerns as margin notes (as on the card and in the diff), and how many notes sit in the code. While it's being written, a quiet line says so; a failure shows its reason in ink, not red (it's about the agent, not the PR), with a command in it set as code (`claude auth login`), and `i` tries again. When AI reviews are paused after failures in a row, a PR that wasn't tried says that. A merged or closed PR with none says "No AI review." (`i` still asks, though the key line leaves it out); your own PR shows the section only once a review exists or is being written. A review of an older commit stays, marked "before the latest commits", and its notes aren't placed in the new code.
- Files on the left (sticky, 300px from 1280px up; above the diff at 1100px and below), with a dot on files that have notes. A long folder gives way from its start ("…versions/0008_cache.py") but always shows "…/", so each file's name stays whole right after it, wrapping when it's longer than the list. The file you're reading follows the scroll and wears the cursor's fill and pencil ring.
- Diffs: `@pierre/diffs`, unified, word-level changes, wrapped lines, Shiki highlighting in Pierre's light and dark themes, on `--sheet` in a hairline frame. Its CSS variables take the app's fonts (JetBrains Mono for code). Each file's name sticks under the top bar while you read it.
- AI notes are margin notes under the line they explain: a thin rule, the note in the UI font. The one `]`/`[` landed on gets the cursor's fill and ring. Notes about a whole file sit above its diff.
- Approve: `a` arms it (the key line and a toast say "Press a again to approve"), a second `a` within 3 s sends it; anything else lets it lapse. The key shows only on someone else's open PR; it's disabled, with the reason as its tooltip, on one you already approved at this commit. It approves the commit on screen: if the desk has seen a newer push, it refuses. The approval is one of the desk's writes to GitHub, with Send on a drafted reply ([api.md](api.md#security-model)).

## In flight

`#/inflight`: your own open PRs you marked done with `d`, and what each babysitter is doing. One list, those that need you first, then the ones a babysitter is working on, then the quiet ones; merged and closed ones sit under Landed for 3 days, flat pencil rows like Resolved's.

```
  In flight 5
  Your PRs marked done. Babysitters fix CI and draft replies; a PR is back in Now only when it needs you.
╭──────────────────────────────────────────────────────────────────────────────────╮
│ Paginate the audit log export                                                 3d │
│ api#4122  Reply ready to send   CI passing   changes requested by dana   …      │
│ pushed a fix for 3 comments · 4be71c2 · 24m                                      │
│ ┃ Reply to dana on src/export/audit.ts:88: "Should the cursor be opaque? …"      │
│ ┃ Kept it as the row id: the API docs promise a stable, sortable cursor, …       │
│ ┃ y Send   x Discard                                                             │
╰──────────────────────────────────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────────────────────────────────╮
│ Fix the flaky timezone test                                                  20h │
│ web#2295  CI failing: test (20.x)   waiting on marco                             │
│ fixing CI · 4m · npm test -- timezone                                            │
╰──────────────────────────────────────────────────────────────────────────────────╯
```

- Each row is a queue card, so a PR keeps its shape between Now and the lane: the title and its age, then the ref, why it's back with you (as in Now: a real label in ink, "**Babysitter asks:** …", "**Approved and green:** merge it"; otherwise regular ink, "Reply ready to send", "Comments from outside contributors", "No local clone of oss/tinyhttp, so no babysitter" with a link to set up local clones under it) and the PR's state; then, where a gist goes, the babysitter's own line ("fixing CI · 4m · npm test", "pushed a fix for 2 comments · abc1234", "watching") unless it only repeats the why. The PR's state in plain words: CI passing, failing (with up to two check names) or running; approved by, changes requested by, waiting on (people first, teams as a count: "waiting on azulus and 5 teams"); unresolved threads; merge conflict. A fact wraps only between its items. With babysitting off, the intro says so once, a PR that needs you has the problem itself as its why ("CI failing"), and nothing says "watching". The right-hand time is the queue's: how long it's been waiting, or when it landed.
- Calm: a row is ink and pencil grey while a babysitter has it, problems included. A row that needs you gets the highlighter on its ref and its problems their colour, as in Now.
- A drafted reply sits under its row like an AI note in a review, a margin rule and no card: what it answers ("Your agent's reply to …" when an agent other than its babysitter drafted it) and the reply. Send (`y`, twice) and Discard (`x`) are the selected row's keys. Send posts it on GitHub as you; it's one of the desk's three writes, and `y` on its card in Now or in its review sends the same reply.
- The selected row has the cards' one fill and ring, and its keys under the hairline: Review, Send and Discard (with a reply), Open on GitHub, Take back, Dismiss the question (or Mark read, for outside contributors' comments), Copy resume command (`cd <worktree> && claude --resume <session>`, to open the babysitter's session yourself; "Answer in a terminal" when it asked a question).
- In Now, a PR in flight says so, its label in ink: "**In flight:** reply ready to send", or "**Babysitter asks:** …", so it doesn't read like a reviewer's ask; Enter on it opens the lane at that PR, `y` (twice) sends its reply from the queue, and with a question `c` copies the command to answer it in the babysitter's session and `x` dismisses it.
- Empty, the page is one line: "**In flight** Nothing yet: press d on one of your PRs when you're done with it."

## Keys

`j/k` move (they stop on "n more" lines) · `Enter` review a PR, open an issue, show the rest of Now or Today · `o` GitHub · `d` your PR in flight, or take it back · `y` then `y` send your in-flight PR's drafted reply · `x` dismiss its question (`c` copies the command to answer it) · `e` done (restore on a cleared item) · `s` snooze, then 1–5 · `m` mute · `p` pin · `u` undo (only what this window did) · `c` copy prompt · `i` AI review · `w` rule trace and signals · `/` filter · `Esc` close, then clear the filter · `r` sync · `,` settings · `g r` rules · `g i` in flight · `g l/f/d/h/x` sorted-away groups (the key after `g` is always the chord's, never the key's own action) · `?` help.

In a review: `n/p` next and previous file · `]/[` next and previous AI note · `a` then `a` approve · `d` your PR in flight, or take it back · `y` then `y` send your in-flight PR's reply, `x` discard it · `i` AI review again · `o` GitHub · `c` copy prompt · `Esc` back to where you opened it (the queue or In flight).

In flight: `j/k` move · `Enter` review · `o` GitHub · `d` take back · `y` then `y` send the drafted reply · `x` dismiss the question (or outside comments), or discard the reply · `c` copy the resume command · `Esc` the queue. `e`, `s` and `m` don't apply to a PR in flight: its babysitter has it, so `d` takes it back first.

Tab focus and the j/k cursor are the same thing: focusing a row selects it.

## Files

|                                                              |                                                                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `web/src/App.tsx`                                            | state, data loading, SSE, keyboard                                                              |
| `web/src/view.ts`                                            | routes, grouping, filter, rule-error line lookup, settings helpers (pure, tested in `web/test`) |
| `web/src/components/TopBar.tsx`                              | wordmark, filter or back link, the coordinator's line, In flight (narrow), sync, help, settings |
| `web/src/components/CoordinatorLog.tsx`                      | the coordinator's log, opened from the top bar                                                  |
| `web/src/components/Queue.tsx`, `CardRow.tsx`, `Detail.tsx`  | the queue                                                                                       |
| `web/src/components/Review.tsx`                              | a PR's review: header, AI review, files, Pierre diffs with notes, approve                       |
| `web/src/components/Inflight.tsx`                            | the In-flight lane: your PRs in flight, the babysitters' state, drafts with Send                |
| `web/src/components/Settings.tsx`, `Rules.tsx`, `Policy.tsx` | configuration; the coordinator's status sits in Settings.tsx                                    |
| `web/src/styles.css`                                         | tokens for both themes, then layout by area                                                     |
| `web/src/fonts/`                                             | Instrument Sans (UI), JetBrains Mono (code), bundled so nothing loads from the network          |
| `web/mock/server.ts`, `diffs.ts`                             | an in-memory API for UI work without GitHub: `node web/mock/server.ts`; real-looking diffs      |
