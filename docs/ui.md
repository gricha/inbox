# UI

A tour of the window, page by page: what's on each and what each control does.

- How it looks (tokens, type, widths, breakpoints, the shots): [visual.md](visual.md).
- What the desk decides behind each page (urgency, rules, Merging, the API): [api.md](api.md).
- Where the code for each part lives: [AGENTS.md](../AGENTS.md) → Where a change goes, and [Files](#files) below.

The pages:

| Page                                    | Route               | What it holds                                            |
| --------------------------------------- | ------------------- | -------------------------------------------------------- |
| [Inbox](#the-inbox)                     | `#/`                | What needs you, in three sections: Urgent, Standard, FYI |
| [A review](#the-review-view)            | `#/review/<id>`     | One PR, read and acted on in the Inbox's place           |
| [A question](#an-agents-question)       | `#/inquiry/<id>`    | An agent's question for you                              |
| [Blocked](#blocked)                     | `#/blocked`         | Your PRs that can't move yet                             |
| [Merging](#merging)                     | `#/inflight`        | Your PRs handed off to your agent to merge               |
| [Archive](#archive)                     | `#/archive`         | What's done, snoozed, muted or hidden by rules           |
| [A review document](#a-review-document) | `#/doc/<id>`        | A review document the desk rendered                      |
| [Settings](#settings)                   | `#/settings/<part>` | Configuration, one part at a time                        |
| [The first run](#the-first-run)         | any                 | GitHub and your agent, once, before the Inbox            |

## Principles

- **Mouse first, plain words.** Every action is a button, a link or a row's right-click menu, named for what it does. The window names no key: no key chips, no key in a label, placeholder or flash. A button's tooltip may name its own key. Only platform keys work ([Keys](#keys)).
- **Nothing selected on open.** A page opens with no row selected.
- **One line per item, as a table.** No AI gist, verdict or chips on a row. A click opens the review, where all that is.
- **What you do takes it off.** Approve, a comment, Ready for review, Request changes, Close, Merge and Hand off for merge each take the item off its list at once. It goes to the Archive (Merging for a hand-off). A toast spins until GitHub has it. If GitHub refuses, the item comes back and a bubble says why. Nothing asks for a second press.
- **A review stays open after you act.** In place of the button it says what you did and where the item went ("✓ Approved · in Archive"), so you can read on or press Esc.
- **One name for the coordinator.** The window calls it _your agent_. "Coordinator" stays in code, settings keys, the skill and technical docs. Merging is `inflight` in code.
- **Send talks to your agent.** A box that posts on GitHub says what it does there (Reply, Comment). Only the chat and an answer to an agent say Send.
- **Calm.** Colour only where it carries information: "CI failing" red, "changes requested" and "merge conflict" amber, an AI review's risk (low green, medium amber, high red) and its verdict's tag in the same three. The one control to press in each place is filled with the accent; a row's call to action is tinted and fills under the pointer. Everything else on a row or an opened item is text. Sentence case, no all-caps, no monospace outside code. Details: [visual.md → The visual system](visual.md#the-visual-system).
- **State lives on the desk.** Pages only render what the desk sends (`QueueView`, `Card`), so the tray, MCP and another client agree.

## Layout

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Inbox        │ Inbox                                               New note │  the page's own head
│ [ Search ]   ├────────────────────────────────────────────────────────────────┤
│ ▣ Inbox   21 │ Urgent  3                                                      │  a section's heading and its count
│ ◷ Blocked    │ Question  Compact tombstones in #12, or ship…?    Answer   24m │  an agent's question leads Urgent
│ ⑂ Merging    │ PR  Rotate staging KMS keys  infra#540  Auth and keys      28h │  its reason, quietly after its ref
│ ⊠ Archive    │ Standard  9                                                    │
│              │ PR  Retry dead-lettered jobs  worker#882  carol waits…     26h │  the row you came back from: a neutral fill
│              │ 3 more                                                         │
│              │ FYI  14                                                        │
│ Ask your ag… │                                                                │
│ Settings     │                                                                │
└───────────────────────────────────────────────────────────────────────────────┘
```

Widths, breakpoints and spacing are in [visual.md → The layout](visual.md#the-layout). This section covers behaviour.

### The sidebar

The window's only global chrome. There's no top bar.

- **Brand row**: the mark and "Inbox". In the macOS app it holds the traffic lights and is the window's drag handle.
- **Pages**: Inbox (with its count), Blocked, Merging and Archive.
  - Inbox counts Urgent, Standard, agents' questions and sessions that need you.
  - Blocked, Merging and Archive have no count. Merging's tooltip says how many are merging.
  - A review is marked under the page it was opened from; a question under the Inbox.
  - Clicking Inbox while on it scrolls to the top.
- **Footer**, bottom up: Settings, then the [update line](#the-update-line) when there's a newer Inbox, then [Ask your agent](#asking-your-agent).
- **In Settings**, the pages give way to Settings' parts, under **‹ Inbox** ([Settings](#settings)).
- **Narrow windows**: the sidebar compacts (the mark alone, "Ask" for Ask your agent), then becomes one row across the top that scrolls sideways inside itself.

### A page's head

Sticky, and the desktop app's drag handle. It holds only the page's own controls:

- Inbox, Blocked, Archive: the page's name, the filter by person and New note; Merging: its name and the filter by person. The search is at the top of the sidebar, on every page but Settings (it searches the lists, and Settings has none): its words match a row's title, repo or author, and one query searches the Inbox, Blocked, Merging and the Archive, and the list beside a review. Esc in it clears its words. The filter by person is an icon button; a count on it says how many people it picks. It opens a popover with a box to find someone, then **Author** (who opened it; a bot's PR counts as the person it was opened for) and **Involves** (anyone on it: its author, assignees, who was asked, who reviewed, commented or answered a thread), you first in each. A click picks or unpicks a person (a tick marks who's picked); **Clear** unpicks them all. Esc or a click outside closes it. The picks and the search's words apply together.
- Merging and a Settings part: the page's name.
- A review has its own bar in the head's place ([The diff](#the-diff)). A question, a Settings view: the way back ("‹ Inbox", "‹ Blocked", "‹ Merging", "‹ Archive", "‹ GitHub", "‹ Agent", "‹ Automations"). Its tooltip names Esc, and for a review or question, ⌘[ and ⌘].

### The list beside a review

In a window 1160px or wider, a review or a question keeps the list it came from beside it.

- Same rows, order, group headings and filter as that page. A question's list is the Inbox.
- Two tight lines a row, neither wrapping: its icon, the title (cut short) and the call to action as accent text; under the title, repo#number and its why, then its facts as icons, who it's from as their picture, and the age. The why gives way first. A note or a question says who it's from in words there.
- Section headings are the page's: small, on the paper's colour, pinned to the list's top.
- The open item's row is marked.
- A click or right-click does what it does on the full page. An issue opens in place under its row; Esc closes it first.
- A review opened from the list goes back to the list's page. One opened beside a question goes back to the question.
- A chevron on the list's divider folds it away, leaving only the chevron at the page's edge ("Hide the list", "Show the list"). The choice is kept per device.
- Its right edge drags to resize it (or ←/→ with the edge focused); a double-click gives back its usual width. The width is kept per device.
- While the chat is open in a window under 1600px, the list folds away on its own without changing that choice.
- Folding, resizing or the list appearing never redraws or refetches the review. Your typing, folded files and scroll stay.
- Moving to another review scrolls its row into the middle if it's out of sight.
- Below 1160px there's no list.

### Loading, empty, scroll

- While a page waits on the desk, quiet bars stand where its rows or text will be. They show only after about 150 ms, so a quick answer never flashes them.
- A review on its way has the loaded page's shape, so nothing moves when it lands: the views' pills and the action's in the bar, each file's header (fold mark, path, lines changed) over code with a gutter of line numbers and indented lines, and in the sidebar the checks' row among Status, a reviewer's row under Reviewers, and the files as a tree.
- An empty page is one pencil line: "Nothing needs you right now.", "Nothing is blocked.", "Nothing in Merging yet: …", "Nothing here yet: …". With a filter: "No matches."
- A new desk's first minutes are one pencil line in the empty line's place, or above the rows once they come: "Getting your PRs from GitHub… 63 found so far", then "Sorting 120 PRs… 40 done". The desk words it (`QueueView.first_pass`); it's gone once the first sorting is through and never shows again.
- A list page opens at its top. Back from a review or a question, it returns where you left it.
- Every page ends a little below its last row: no empty paper to scroll into.

## The Inbox

The main page: what the desk put on your desk, in three sections. `src/urgency.ts` places and orders them ([api.md → Urgency](api.md#urgency)); the page only draws `QueueView.inbox`.

- **Urgent**: what an urgent criterion says yes to (for example "Ready to merge": your own approved, green PR), what your agent handed back, and a score at the Urgent threshold (a review asked of you by name usually reaches it: "Asked by name" counts 3). Agents' questions and sessions that need you lead it.
- **Standard**: the rest.
- **FYI**: what rules or an automation sorted away, or a model's low score. A review asked of you by name and a pinned item never go here. Before the scorer answers, what the rules put in later is Standard, under the rest.

Each section is a heading with its count; a click opens or closes it. Within a section: higher score first, then the desk's order (`group` on each card): hand-backs, other people's PRs waiting on your review, issues and the rest, then your own PRs.

Every row of Urgent and Standard shows, then FYI's first 5: the rest wait behind **Show N more** (one click shows all, until you leave the page). A filter, or a selected row further down, shows all of FYI. Scrolling, the section you're in keeps its heading pinned under the page's head until the next one's pushes it off.

**Notes to yourself.** **New note** on a list page's head, or ⌘N anywhere, blurs the page and drops a tray from its top, 760px wide at most, in the chrome's colour, a hairline round all but its top, its bottom corners round (it slides back up when it closes): your words, large, and at its foot a small **In** with the tray's own list of sections (Urgent, Standard or FYI; Standard for a new note), then **Remind me** with the tray's own list (No reminder, In 1 hour, In 3 hours, Tomorrow 9:00, Monday 9:00, or Pick a time…, which opens the tray's own calendar: a month to click a day in and the half hours beside it, nothing before now) and **Save note** in the accent, with **Mark as done** (a tick, in grey) before it on a note you opened; a cross at the tray's top right closes it, as Esc does (faded, still filled, until there's something to save). It has no title: the empty box says "Type a note to yourself here (e.g. Remind me to…)". ↵ saves (⇧↵ is a new line), Esc discards (an open list or calendar closes first), as does a click on the blurred page while the words are untouched. A note without a reminder leads the section you put it in; one with a reminder waits under **Reminders** at the top of the Archive, then at its time notifies once (even in quiet hours; not when notifications are off) and leads Urgent. Its row: Note, its words, **Done**, and its time ("at Tue 9:00") where a PR's author goes. A click on it opens the tray to change it. The filter matches a note's words. What you do to a note shows at once, before the desk answers: Done takes its row off, a move or Snooze puts it where the desk will, a saved note shows its new words, section and reminder, and a new one appears (`pending.ts`, read back with the next queue); a refusal puts it back and the tray keeps your words.

The quiet rule: an item nobody has touched for `queue.quiet_days` (14) moves to FYI, unless pinned or a review you were asked for in that time.

### A row

One line, columns lining up row to row:

| Part           | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kind           | An icon: a PR, an issue, a question, a session or a note. Its tip says which.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Title          | 14px.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Ref            | repo#number. A long repo name is cut short; the number never is. A stack's place follows ("3/6").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Why            | In pencil, `Card.reason`: a hand-back's words, the urgent criterion's name, an automation and its why, the score's line or the rules' why.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Call to action | At most one ([below](#calls-to-action)): a small tinted button, as wide as its words.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Facts          | A PR's, as one signal icon: four filled bars, grey until lit. One is lit for each of its status, CI, the AI review's risk and its size with nothing against it (a draft or a stage that stops it, CI failing or running, medium or high risk, a medium or large change each take one off), and the lit ones share a colour: one red, two orange, three yellow, four green. Under the pointer it opens **Status**: a row each for the four, words on the left and its icon or counts on the right, as a review's Status reads. A bolt before it marks someone else's small PR its AI review calls low risk (`Card.quick`). |
| By             | Who it's from: their GitHub picture alone (yours on your own, a small robot for a bot or an agent). A bot's PR opened for someone shows that person's picture when its [attribution](api.md#opened-for-you) names a login (a robot for a name alone); its tip says "By dana via sentry-junior", or "By you via sentry-junior". Unknown, "By sentry-junior".                                                                                                                                                                                                                                                               |
| Age            | How long it's waited: minutes (40m), hours (5h), days (3d) up to 45, then whole months (2mo).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Every icon says itself in the window's own tooltip (`Tips.tsx`, any `data-tip`): "Pull request", "By dana"; the signal's is Status and its four rows ("Approved", "CI passing", "Low risk, skip it", "Small change +120 −30"; `.tip-rich`). A row with no facts keeps the empty slot, so the columns line up.

In a narrow table the bolt goes first, then who it's from; the signal stays. Who placed an item (Claude or a rule) is never on the row; it's in the opened item's facts and rule trace.

A stack of PRs is one row: the lowest open member, in the most urgent place, with its place in the stack ("api#4154 3/6").

### Calls to action

The desk picks it (`cta` on the card). A tinted button before the age, filled under the pointer:

- **Ready for review** on your own open draft, even with red CI (your agent fixes CI once it's ready). Marks it ready on GitHub at once and it leaves your desk.
- **Reply** on your PR whose only action is answering someone. Opens its review with the first reply box focused.
- **Add reviewers** on your ready PR nobody's asked to review. Opens its review with the Reviewers box focused.
- **Hand off for merge** on your own PR that's approved, green and mergeable. It goes to Merging in one press, where your agent gets it merged. To merge it yourself now, its review's More has **Merge**.

Ready for review with nobody asked isn't done: the PR comes back ready, with Add reviewers as its call to action, and the toast ends "Nobody's asked to review it yet". Ten minutes later it tops your desk.

### Clicking a row

- A PR opens its [review](#the-review-view).
- An issue or a session opens in place under its row.
- A question opens its [page](#an-agents-question).

### An issue opened in place

- Why it's here ("Assigned to you").
- One pencil line of facts: by, how you were asked, labels, comments, who placed it.
- Where it sits and from which board, a collapsed rule trace.
- Its **pre-review** ([api.md → Issues](api.md#issues)), under "Pre-review":
  - "A bug." (a feature request, a question) and one sentence; then whether it read the code in your clone or only the issue's text;
  - **What's wrong**, **Cause**, the places in the code as `path:line` with a short why, and **The fix** (or **What we'd do**), each as plain prose;
  - for one that isn't a simple fix, a walk through it, one step at a time with **Back** and **Next**, ending with its recommendation;
  - while one's on its way, "Your agent is reading it"; a failed one says why with **Try again**; one written before the issue's latest activity says so with **Read it again**; none yet (AI reviews on) offers **Analyze it**;
  - **flagged**: "Possible prompt injection from @x." in red, what gave it away, and "No agent read it further", with **Block @x** (mutes their items on your desk; nothing on GitHub) and **Not an injection: analyze it**. Its row's why says so too;
  - a blocked author's issue says so, with **Unblock @x**.
- Its last 8 events in plain words.
- Actions as text under a hairline: **Make PR with fix** (first, in the accent, when the pre-review found a small, clear fix), **Comment**, **Ask your agent**, **Open on GitHub**, **Done** (or **Back on the desk**), **Snooze**, **Mute**, **Close**.
- Close, a click on its row, or Esc closes it.

**Make PR with fix** asks your agent, with the pre-review's analysis (never the issue's own words), to open a draft PR with the fix. Your agent's chat opens on the issue, where it answers with the PR's link. The desk itself writes nothing.

**Comment** opens a comment bar at the window's bottom. ⌘↵ sends it to GitHub and the issue leaves your desk until someone else acts. Esc closes the bar. A refusal keeps your words. A refresh that moves the row doesn't touch it.

### A row's menu

Right-click any row (Inbox, Blocked, Merging, Archive) for a menu at the pointer:

- **Done** (or **Back on the desk** once cleared).
- **Snooze**, opening to the side: a time, until activity, or what the PR can wait on now (`wake_on`: CI passes, new commits, it's approved, it's ready for review, the merge conflict is fixed).
- **Move to Urgent** / **Move to Standard** / **Move to FYI**, on the Inbox: one section up or down (Standard offers both; Urgent and FYI offer Standard). It stays there until you're done with it, snooze or mute it; Undo moves it back.
- **Close on GitHub**, where it can be closed.
- **Copy link**, **Copy GitHub link** (the PR or issue on GitHub).

On Merging the menu is **Back to the desk**, **Copy link** and **Copy GitHub link**. A question's is **Answer**, **Copy link**, **Dismiss**. A session's is **Done**, **Snooze** and its call to action. A note's is **Done**, its moves (**Move to Urgent**, **Move to Standard**, **Move to FYI**, one section up or down as a row's; a due reminder counts as Urgent, and a move drops the reminder), **Snooze** (a time, which becomes its reminder), **Change note** and **Copy text**. Every kind of row starts with Done and Snooze, from one place in `RowMenu.tsx`. Arrows move, → opens Snooze, Enter picks, Esc closes.

### Agents' questions

A Claude Code session asks you in the desk (`desk_inquire`) beside its chat: when you asked it to, or about work going on while you're away. Your agent always asks here.

A question is a row at the top of Urgent: a question mark as its icon, the question as its title, **Answer** as its call to action, a small robot whose tip says who asks ("Asked by your agent", or the session's name), and its age. The desk refuses a question without enough context, a link or item, or answers that say what follows.

### Sessions that need you

Your own Claude Code and Codex sessions on this computer that are blocked on you or stalled (`src/connectors/sessions.ts`; Settings → Sessions turns them off). They follow the questions, blocked ones first.

- **Row**: a terminal as its icon, its kind in the tip ("Desktop session"; CLI, Background, Desktop, Codex), its name, its folder, why it's here in pencil after it ("needs permission: Bash", "asked a question", "rate limited until 14:05", "stopped mid-turn", "login expired", "no progress"), its call to action and its age.
- **Calls to action**: **Kick** (a background session with no process), **Resume in background** (a terminal's whose process is gone), **Open** (the desktop app's or Codex's).
- **Opened in place**: the reason and when, the last line it said or asked, its kind, folder, branch, and whether its process runs. Then its actions (a running background session offers **Copy attach command**, `claude attach <id>`; a running terminal one has none and says to go back to it), **Done**, **Snooze** (until tomorrow), **Mute**, **Close**.
- It leaves on its own once the session moves on. Done hides it until then.
- The desk refuses Kick, in words, while the process runs or before a rate limit resets.
- No session rows in the list beside a review.

## An agent's question

`#/inquiry/<id>`. Made to decide from without opening anything else.

- Who asks and when, and the question as its title.
- The PR or issue it's about: who it's from, its stage, whether it's resolved. **Open its review** for a PR; its ref links to GitHub. A review opened from here goes back to the question.
- The agent's context as paragraphs (`code` spans and URLs kept, never markup), and its links with where each goes.
- The answers as a table, each with what the agent does next and its pick marked. A click picks one.
- Or write your own: **Send** (or ⌘↵).
- **Dismiss** leaves it unanswered; the agent decides itself.
- **Copy link** copies the question's link ([Links](#links)).

Once answered or dismissed it leaves the Inbox at once. The page stays and says so ("✓ Answered", with your answer). If the desk refuses, your words come back.

Under your answer: **Not picked up yet**, then **Picked up 2m ago** once the asking session reads it (`desk_inquiry`, or your agent's wake). Nothing pushes an answer to a session that stopped waiting. Until it's read, it's a line in Merging's [Claude's work](#claudes-work); after 30 minutes unread the desk tells you once that the session has probably ended. A dismissal owes nothing.

## The review view

`#/review/<id>`: a PR read and acted on in the desk, in the Inbox's place. The sidebar stays, and in a wide window so does the list it came from. The diff takes the page's width; a foldable sidebar on the right holds the PR's state and files.

```
  Planner: hash join stage                                        [    Approve    ] [⋯]
  api#4154  by priya  [Look closely]
                                                                  Status
  Adds a streaming scan (streamRows) and uses it in runPlan, ...  Medium risk               ▂▄
  Show more                                                       Checks passing         14/14
                                                                  Small changes         +34 −4
  Guided Review   Traditional   Conversation 2
  ──────────────────────────────────────────────────────────────  Stack on main
  Look  src/planner/plan.ts  budget checked only between batches  ○ #4153 Planner: run the table…  ✗
  ┌──────────────────────────────────────────────────────────────┐┃○ #4154 Planner: hash join st… ±┃
  │ 17 + export async function runPlan(q, budgetMs = ...)        │
  │    ┃ The budget is only checked between batches, so ...      │  Reviewers
  └──────────────────────────────────────────────────────────────┘  sam      changes requested
  Skim  src/planner/stream.ts  new batching generator         +24 −0
  ...                                                             3 files
  Skip  docs/api/query.md                                        +3 −1  ○ src/planner/plan.ts   Look
  Not worth reviewing · 1 file                                    ○ docs/api/query.md      Skip
```

Esc goes back to the page it was opened from. A review has no page head: its own bar is in its place, and the list beside it and the sidebar are the other ways back.

### Opening

- It never waits. It draws at once from the row's card (header, CI, review state, size, and the AI review's read when the card has one), with quiet bars where the rest will land, so nothing moves.
- Resting the pointer on a PR row for 150 ms fetches its review ahead (`?ahead=1`, which starts no AI work). The desk also fetches the Inbox's diffs after each sync.
- A big diff draws its first files with the page and the rest a chunk at a time.

### Header

- The title first, 10px of air over it; under it its metadata on one line, 10px of air under that: the ref, the author with their picture ("by you" on yours; a bot's PR opened for someone "by dana via sentry-junior", with dana's picture when a login, "by you via sentry-junior" on yours; unknown, "by sentry-junior (bot)"), then the AI review's verdict as a tag, a rounded rectangle filled with the colour of how much it asks of you, as risk is ("Look closely" red, "Skim it" amber, "Skip it" green, its words in the sheet's colour; the model and time in its tooltip). A review of an earlier commit isn't shown anywhere (header, AI review, Status): the new one's state stands in its place. A stack's place is the sidebar's (Stack), not the header's.
- How big it is and who reviews it are the sidebar's (Status, Reviewers).
- Nothing else: why it's on the desk is the row's; CI, the review state, a conflict and what it blocks are the sidebar's.
- A resolved PR says so under the title: "Resolved: merged by li-wei · 2h".
- Your PR in Merging says "Merging", with what it waits on and your agent's latest note.
- Your own PR with no AI review shows the first paragraph of its description under the title.
- Problems are coloured words; pencil once the PR is sorted away, resolved, or calm in Merging.

### The review's sidebar

Sections, each open: its name, where it stands in one line that reads first (red when a required check fails, amber for changes requested), then its rows.

- **Status** first: a row each, what it says on the left and its measure on the right; a click shows what's behind it.
  - **Risk**, when there's an AI review: "Low risk", "Medium risk" or "High risk", and the rows' signal, four rising bars as a phone shows it: one red for high, two orange for medium, all four green for low. It opens to its reasons.
  - **Checks**: "Checks passing", "Checks running", "Some checks failing" (an optional one failing or one cancelled) or "Checks failing" (a required one), and on the right how many pass of all of them ("19/22"), the first number in its colour. It opens straight to every check, with no line over them, a row each with a dot: red failing, red hollow failing but not required, yellow running, green passing, grey skipped. Shards of one check (`backend test (0)`, `(1)`, `[2/3]`, `#4`) are one row with a count and their worst dot; a click lists them. What's wrong comes first. `checkGroups()` in `web/src/view.ts`.
  - **Changes**: "Small changes" (up to 100 lines in up to 5 files), "Moderate changes" (up to 600 in up to 20) or "Lots of changes", with its + and − on the right; it opens to bullets: its files, lines added and lines removed.

- **Stack** only while the PR is stacked: another open PR in its stack.
- **Reviewers**: everyone, with their picture and where they stand; no line over them ("Nobody's asked" when there's no one). On your open PR each person has one icon after their state: × removes one asked who hasn't reviewed yet, ↻ asks one who reviewed to review again (`POST /api/review/:id/reviewer`, the REST unrequest or rerequest for that login alone); their verdict then reads "approved · asked again" (or "changes requested · asked again") and the ↻ goes until they review. A team's ask has none: it's the team's. On your open PR, **+ Add reviewers** (also in More) opens a box right there, under who's asked: a pick is the ask (GitHub asks them at once, `keep` on `POST /api/review/:id/reviewers`, so the PR stays on your desk), and **Done** closes it. Each change shows at once (removed off the list, "· asked again", or added as "asked") and the review is read again every 3 seconds until its review requests have it; a refusal puts the list back.
- Sections are parted by a hairline.
- **Merge**: a conflict. **Depends**: what it's blocked by or blocks, when it isn't in a stack (a stack has its own section).

### The AI review

No heading; right under the header.

- **Goal** first: what the PR sets out to do, in ink, larger than the rest (16 to 17.5px). A review written before goals leads with its summary's first sentence.
- Its verdict is the header's tag, and its risk the sidebar's (Status).
- **The rest of the summary**: folded, its first lines show and fade out into **Show more** (in the accent), which opens it; then **Show less** under it folds it again. Every PR opens folded. Folded, the preview takes no clicks or focus (`inert`) and draws no diagram.
- **Since your review**: on a re-review, under the summary, never folded.
- A named part (**In the stack**, how it fits its goal, **Also risky**, **Interfaces**, **Could be better**, **Since your review**) is its name on a line of its own, then what it says on the next.
- **Concerns**: each is also a note in the code. They're listed only when no note can sit there.
- All of it is drawn as plain prose (`code`, **bold**, lists), never HTML. URLs stay text: the PR's author can steer what Claude writes.

States:

- Running: "Claude is reviewing it. The notes land in the code below in a minute or two." After two minutes or on a retry: "Claude is reviewing it, 4 minutes so far, try 2 of 3." Shown only while its job runs.
- Failed: the reason in ink, not red (it's about the agent, not the PR). "… Claude tries again in 2 minutes." or "The AI review failed 3 times: …". **Try again** asks again.
- Paused after failures in a row: a PR that wasn't tried says so.
- None yet on an open PR: "No AI review yet. **Ask Claude for one**". On a merged or closed PR: "No AI review."
- Your own PR shows the section only once a review exists or is running.

The agent's name in these lines follows Settings → Agent (Claude, Codex or OpenCode).

### What reviewers said

The **Conversation** tab, in the diff's place (the tabs: [The diff](#the-diff)). Its name carries how many wait on your reply, and a PR opened to reply (its row's Reply) opens on it. It stays drawn while you read the diff, so a reply you're writing is there when you're back.

- A resolved conversation that isn't waiting on you is one quiet line (who, where, "resolved", how it began) until a click opens it.
- Each conversation is a card on the sheet, a hairline between one comment and the next: every comment with its author's picture, when, and on the first where (file:line, "outdated"), "resolved", or a review's "Approved" or "Changes requested"; then its words.
- Those waiting on you come first, under "Waiting on your reply" and how many, edged in the accent, with Claude's take under the words, the call in semibold ("**Valid concern:** …", "**Only you can answer:** …"). Until Claude has read it: "Claude is reading it." A failure says why in ink.
- Under them, quiet links: **Open on GitHub** and **Ask your agent**.
- At a card's foot, over a hairline, a row to reply in on an open PR: your GitHub picture, "Reply to azulus…", and a round button that sends it (or ⌘↵), filled with the accent once there are words. The box is one line and grows as you write. The desk never writes your answer; a thread's reply goes to the thread, a comment's or a review's is a comment on the PR. Sent, the card says "Reply sent." and your words show under it at once, as yours with "sent", until the review read again has them (read again every 3 seconds meanwhile).
- What a reviewer wrote is drawn from its markdown and its HTML, parsed into elements and never set as HTML (`saidBlocks()` in `src/prose.ts`, `SaidText` in `Prose.tsx`): headings, paragraphs, lists, `code` and ``` blocks; a link (`[words](url)` or `<a href>`) reads as its words and opens its https URL, the URL in its tooltip; an image (`![alt](url)`, `<img>`, a `<picture>`'s) is drawn when GitHub hosts it (an upload to a comment, `*.githubusercontent.com`) and is a link in its alt otherwise, or when it doesn't load; a linked image is a link in its alt; a `<details>` is a fold under its `<summary>`; a paragraph in `<sub>` is small print; `<br>`, `<b>` and `<code>` read as meant; HTML comments (a bot's `<!-- finding -->` markers) are gone; any other tag is text. The same in the diff's threads.
- With nothing said yet, a dashed box in the cards' place: "No conversation yet", "Comments and review threads on this PR show here."
- No attachments: GitHub has no public API to upload one, so the boxes take words only.
- **Your comment** on the PR is at the tab's foot (see [Actions](#actions)). Sent, it shows above the box at once, as yours, until the review read again has it; your own comments and reviews are part of the conversation, never waiting on you.

### The diff

The desk's reading order (`ReviewView.order`), which the guide's steps are built from:

1. What Claude ranked: each hunk under its file's name, its level ("Look", then "Skim") and Claude's few words why.
2. What Claude didn't read ("Not read", and whether the PR or file was too long).
3. What Claude left out: "Skip", with no why, still in view (anyone can write a diff, so it can't hide code).
4. One pencil line, "Not worth reviewing · 2 files": lockfiles, generated files, files with no text diff. A click opens them in place.

Neighbouring hunks of a file at one level read as one. Without a ranking (none yet, or an earlier commit's) it keeps file order. A PR with no changes says "No files changed."

**Guided Review, Traditional and Conversation.** Three pills (rounded rectangles, regular weight, the one you're on filled a little more and in ink) at the left of the review's bar, which is flush with the window's top, stuck there, as tall as a page's head, and a drag handle. The title, the AI review and the view you picked are under it. The first two are the diff's orders, the choice kept per device (`desk.review.view`), Guided Review first; Conversation is what reviewers said and your comment's box, in the diff's place. A review without steps (`order.steps`: none yet, or an earlier commit's) shows Traditional and Conversation. A click on a step, a file or a line the AI review names goes back to the diff.

- **Guided Review** is only the guide, as Linear's guided reviews: each step is a heading ("1 of 4", its title), a sentence or two, and "**Check:** …" when there's something to verify, then only the hunks it covers. A quiet "Next: <title>" at its foot. In the sidebar the steps are a timeline on a pale line: a pale node each and its title dimmed, the step you're on a flat node in a fluorescent purple (no glow) and its title in ink, each title on one line (the whole of it in its tooltip). The model is asked for titles of at most four words, under 28 characters. The last reads "End of the guide.", and when files changed outside it, "3 more files change outside it: read every file in Traditional", a link to that tab. Nothing the steps leave out is drawn, so the guide holds your attention. A test file in a step is folded until you open it (`isTestPath()` in `src/sections.ts`).
- **Diagrams** in a step are drawn by Excalidraw (`web/src/components/Sketch.tsx`), hand-drawn in the theme's own colours: new parts green, changed amber, removed dashed, a store in the accent. The desk's layout (ELK, measured in Excalifont) places them; a left-to-right flowchart stays left to right while it fits the column at 85% or more, and redraws when the theme changes. Excalifont comes from the desk (`web/public/excalidraw`), never a CDN. If Excalidraw fails, or `desk.sketch` is `"0"` in localStorage, the plain drawing shows instead; a rendered review page always has the plain one.
- **Potential bugs**: each of the AI review's concerns is marked **Potential bug** on its line, edged in amber: what goes wrong, when, the fix, then "Evidence:" what in the diff shows it and how to confirm it (a suspicion with no evidence in the diff is only a note saying what to check). In Guided Review a concern's hunk shows even when no step covers it, under "Potential bugs outside the guide" after the steps.
- **Traditional** is the plain diff: every file in the PR's order, all its hunks in diff order, Claude's notes inline on their lines (`traditional()` in `src/sections.ts`), then the desk's "Not worth reviewing" fold.
- In the review's sidebar the steps take the files' place. Traditional's files are the same timeline nested in their folders (`pathTree()` in `web/src/view.ts`; a folder holding only a folder reads as one, "web/src"), stuck under the review's bar like the steps (the hairline above either fades once it's stuck): the file you're in is the purple node and follows the scroll, its folders are ringed in the same purple, a click folds a folder or opens it, a folded one holding that file is the node in its place, and scrolling into a folded folder's file opens it.

**Drawing.** `@pierre/diffs`: unified, word-level changes, wrapped lines, Shiki highlighting in the theme's syntax colours (`diff` in `src/themes.ts`, `web/src/diffThemes.ts`). Unchanged lines fold into a band ("14 unmodified lines"); its arrows open ten more at a time, in either review. A drawn file is read whole ahead (`GET /api/file/:id?path=`: the file at the PR's head; before it is the same run back through its patch, `oldFromNew()` in `web/src/view.ts`), so the first click opens lines. A file GitHub won't give whole (binary, too big) says so in a bubble. Each file's name sticks under the review's bar while you read it.

**Folding files.** A file's header folds its diff and everything on it. Consecutive folded files read as one list. A different PR starts with every file open but those you've viewed.

**Viewed.** A **Viewed** checkbox at the right of a file's header, as GitHub's: ticked, the file folds, and it opens folded each time you come back, until a push changes what it changes. Unticked, it opens. A click on a viewed file's header opens it for now. The mark is kept per hunk, by its path and changed lines alone (`ReviewHunk.mark`): a rebase that moves the code or changes the lines around it keeps it, and a push that rewrites one hunk unticks its file (in Guided Review, the step holding that hunk). A file with no text diff is new once its blob is. The desk keeps the marks (kv `viewed:<id>`) while the PR is on it; nothing goes to GitHub.

### Notes and threads on the diff

- **AI notes** sit under the line they explain, in the UI font. Notes about a whole file sit above its diff.
- **Review threads** sit under their line, after any AI note: each comment's author, picture, age and text, then **Reply** and **On GitHub**. A resolved one is one pencil line ("Resolved · priya: …") that opens. Outdated threads are only in the conversation above.

### Commenting on a line

- Hover a line: a `+` shows by its number. Click it (or drag down the numbers for a range within one hunk) to open a box under the line.
- ⌘↵ or **Comment** posts one comment on GitHub at once, as you, on the commit whose diff you picked the line in.
- Esc in an empty box closes it. With words, Esc leaves the box and keeps them; another `+` or Reply takes you back to them (opening their file if folded).
- Leaving the review keeps unsent words in this window.
- While it sends, the box is read-only and `+` on that PR waits. If GitHub refuses, it says so and the words come back.
- If a push removes the line, the box moves above the diff, still yours to send or cancel.
- **Reply** on a thread opens the same box under it.
- What you sent shows in place, with a link, until the refreshed conversation has it.
- Commenting doesn't finish a review: the PR stays and Approve stays.
- **Ask your agent**, quiet text after Cancel, opens the chat about those lines or that thread instead. Nothing moves between the two boxes.

### Actions

The actions sit at the right of the review's bar, the strip stuck across its top with the three views at its left (see [The diff](#the-diff)): the call to action, 30px tall, then **More**, a narrow button of three dots, one over the other. Their corners are tighter (6px). The call to action is filled with the theme's accent whatever it does, Approve and Hand off for merge too, and its states are mixed from the theme: under the pointer the fill leans to the ink, pressed it leans further, and focus rings it in the accent.

- **Approve**: only on someone else's open PR. Sends at once; the PR leaves your desk. Disabled, with the reason in its tooltip, if you already approved this commit. It approves the commit on screen; if the desk has seen a newer push, it refuses.
- Or the PR's own call to action: **Ready for review** or **Ask reviewers**.
- **Hand off for merge** on your own PR, only once it's approved or its repo needs no review. Not on a draft or a ready PR nobody's asked to review (unless its repo needs no review). One already in Merging shows **Back to desk** instead, last.
- **More**: **Done** (or **Back on the desk**), **Copy link**, then under "On GitHub" the writes it allows: **Close**, **Request changes** (opens a box for its body).
- **Your comment**: a card at the foot of the Conversation tab, as a reply's row is: your GitHub picture, "Comment on api#4127…", and the round send button. It grows as you write. ⌘↵ sends it and the PR leaves your desk until someone answers. Esc leaves it with your words kept. With words in it, the buttons take you to the tab and the box instead of acting. Unsent words are kept per PR in this window.

Every GitHub write is listed in [api.md → Security model](api.md#security-model).

### Your draft's reviewers

A line under the AI review on your draft (and on your ready PR nobody's asked), under one line saying what Ready for review or Ask reviewers will send:

- Each person shows their GitHub picture; a team shows "@".
- Those already asked show first and stay.
- A box adds more: GitHub's suggestions under "Suggested by GitHub, from who changed these files", then people with access and the org's teams as you type (↑/↓, Enter adds, Backspace on empty removes the last, Esc leaves).
- After it, "Suggested": up to four of GitHub's suggestions as dashed pills; a click adds one.
- Ready for review asks them right after marking it ready. With nobody picked it only marks it ready and the PR stays for Add reviewers.

On your ready PR nobody's asked to review, the same line opens with the box focused, and the filled button is **Ask reviewers**.

### The review's sidebar

Beside the diff it's always there (240px wide in a column under 880px), with no toggle, and it scrolls with the page: its parts go by, and **Guided Review** sticks under the review's bar (scrolling in itself when the guide is longer than the window). In a page column under 680px it lies over the diff and starts folded; there one icon button at the review's top right shows and hides it ("Show checks and files", "Hide the stack, checks and files"), and it scrolls in itself. While the chat is open the chat takes its place; the same button brings the sidebar back and closes the chat.

Top to bottom:

- **The stack**, when the PR is in one: "Stack on main", its open PRs bottom first as a timeline like the guide's (a node each on one line), each with only what's news (a red cross for CI failing, "changes" in amber, a green tick for approved). The PR on screen has the accent's node and its title in ink, no fill or ring. A long stack shows four and "16 more". A click opens that PR.
- **The checks**, when any ran on its head: one line ("CI passing · 14 checks", "2 failing of 14 checks", "3 running of 14 checks"), red while a required check fails. A click opens every check, worst first, each linking to its page. A failing check the base branch doesn't require reads "failing, not required". Fetched when the review opens; "Couldn't load the checks: …" if GitHub won't give them.
- **The files**, in Traditional, in the PR's order with a dot when they have notes and a tick once you've viewed them ("3 viewed" by the count). A click scrolls there. The one you're reading is marked.
- **The reviewers**, always: one line ("Approved by marco · waiting on sam and @backend", "Changes requested by kofi", "Waiting on you", "Nobody's asked"), amber on changes requested. A click lists each person or team, who holds it first. Bots and the author are left out.
- **The merge**, only when something's in the way: "Merge conflict with main", in amber. Only asked for your own PRs.

## Blocked

`#/blocked` (`#/waiting` also lands here): what can't move until something else happens. Your rules put items in the `blocked` bucket (`QueueView.sections.blocked`). The first-run rules put there:

- Your PRs that need another PR merged first (its description says "Requires …", or it's stacked on it), down the chain.
- Your PRs waiting on reviewers ("waits on a review from dana and @backend").
- Your PRs in Merging that another PR blocks ("in Merging · needs …").

Someone else's blocked PR isn't here: a review asked of you is yours to give, so it stays on the Inbox with stage "blocked". A rule can still send one here (`pr.blocked`, `pr.blocker_mine`).

The page is one group, Blocked, drawn as a tree:

- A chain at a time, the longest-waiting first. A PR comes before the PRs that need it, each indented under it with a quiet guide (├ └ │).
- A row's why names what it needs ("needs billing#2300"). The chain says once what its blocker waits on ("needs sentry#129460, which waits on your reply to markstory, then a review from …").
- The age column is how long it's been blocked.
- Filtering flattens the tree.

What you do on a row takes it off. It comes back when the PR it waits on merges. A hand-back of a PR blocked by another waits here, and tops the Inbox once that PR merges.

## Merging

`#/inflight`: your PRs handed off with Hand off for merge, which your agent is getting merged. Nothing here reaches the Inbox; only a PR your agent hands back goes there, on top.

**The agent line**, above the rows: "Your agent", **Watch on claude.ai**, **Copy attach command** (the command in its tooltip), **Wake it**.

- When it can't run: "**Your agent can't run:**" in red, the reason, and **Try again**.
- Before it's started: "Your agent starts on your first hand-off or ask." and **Start it now**.
- Off: says it's off in Settings → Agent.

**Rows**: open PRs first, latest activity on top.

- The title, ref, stack place, one phrase, the age.
- The phrase is what it waits on ("waits on a CI fix", "waits on a second look from dana", "ready to merge"), then your agent's latest note ("Pushed 4be71c2 for dana's 3 comments"). The whole phrase is the tooltip.
- All ink and pencil, problems included: your agent has it.
- A stack's rows sit together under "Stack on main · 6 open" when two or more are here.
- The selected row moves its phrase to a line underneath.
- Click opens the review; right-click: **Back to the desk**, **Copy link**, **Copy GitHub link**.

**Merged**: PRs merged or closed in the last 3 days, as pencil rows.

### Claude's work

Under the rows, only while there's some: what Claude owes you, from the desk's ledger ([architecture.md → Claude's work](architecture.md#claudes-work-srcjobsts)). One line each: an AI review, your ask to your agent, or your unread answer to an agent's question.

- Running ("Claude is reviewing it · try 2 of 3", "Your agent has it"), then waiting ("Tries again in 2m · …", "Waiting its turn"), then failed ("Failed 3 times: …") with **Try again**. Reasons are ink, not red.
- An answer reads "Your answer to <who asked> hasn't been picked up", and after 30 minutes adds "· that session has probably ended". No Try again: only the asking session can read it. The line goes a day later.
- A click opens the PR's review, the chat for an ask, or the question for an answer.

Empty: "Nothing in Merging yet: hand off one of your PRs for merge when you're done with it."

## Archive

`#/archive`: what's done, newest first. Three groups, each a heading with its count:

- **Archive** (open): what you did ("done: back when someone else acts", timed when you did it) and what the world resolved ("merged", "you approved", "approved by alice", timed when it resolved). Covers the last day's items that were on the Inbox or that you opened or resolved.
- **Snoozed or muted** (folded): "snoozed until Sat 9:00", "snoozed until CI passes".
- **Hidden by rules** (folded): the rule that hid it.

**Back on the desk** (row menu, or More in a review) puts an item back. Filtering opens groups with matches and hides empty ones. Esc clears the filter, then goes to the Inbox.

## Links

**Copy link** (a row's menu, More in a review) copies the item's permalink, `inbox://item/owner/repo/123`, and says "Copied the link to api#4127".

- Clicking one anywhere on the computer opens the desktop app there (`#/item/<id>`): a PR's review, or an issue opened in place on its page.
- Pages: `inbox://inbox`, `inbox://blocked`, `inbox://merging`, `inbox://archive`. `inbox://fyi` opens the Inbox.
- A question: `inbox://question/<id>` opens its page. Pasted to any agent, `desk_inquiry` reads it (the question whole and your answer). Reading it by link isn't picking up your answer; only the asking session does that.
- A review document: `inbox://doc/<id>`.
- An agent can also read `http://localhost:47823/#/review/<id>` as the item's ref.

Code: `src/links.ts`; the protocol in `electron/main.ts`.

## A review document

`#/doc/<id>` shows a review document (`inbox.review/1`) as the desk rendered it, framed with nothing allowed but its links. Agents write them with `desk_doc` or `desk render`; they're kept in `<home>/docs`. Format: [review-format.md](review-format.md).

## Settings

No tabs. In Settings the sidebar lists its parts in place of the pages, under **‹ Inbox** and a rule (⌘1–⌘4 still open the pages). There's no search there. Two groups, each under a quiet heading:

- **App**, the app's own: Inbox and notifications, Automations, Agent, This device, Network.
- **Integrations**, one per plugin: GitHub, Sessions.

`SETTINGS_PARTS` in `web/src/settings-parts.ts`. The sidebar's Settings and `#/settings` open the first part.

### How a part works

- Each part is a route, `#/settings/<part>`, drawn alone, its name in the head. No intro text.
- Settings are rows on one sheet: label and help on the left, the control on the right edge. A number has its unit after it ("[14] days"). A prompt or path takes the row's width. On a narrow sheet controls go under their words; switches stay beside them.
- Clicking a label flips its switch.
- A switch on a list (an automation, a criterion, a built-in rule) flips at once, as does Run now ("Running…") and a delete (the row goes). If the desk refuses, it's put back and a bubble says why; a refused delete reopens its editor with your words.
- Under the control: "Saved" (green, briefly), "Not saved: …" (red, your input kept), or **Reset to default** on a changed setting (the default in its tooltip).
- Tuning sits at the sheet's end in its own section, **More <part> settings**, always open.
- A row that would do nothing here isn't drawn (`SHOWN`); one that waits on another is greyed (`DISABLED`). `desk settings` and settings.json still set every one.
- When settings.json has a problem, a notice above the part names each setting by label and key.
- Old links still land: `#/settings/automations`, `notify` → Inbox and notifications, `review` and `handoff` → GitHub, `#/rules` → Searches and rules, `policy` (Your policy, gone) → Agent.
- **Views**: Searches and rules (`#/settings/rules`) and each automation (`#/settings/automations/<id>`; a plugin's `github.<id>`) open as views. Their head is the way back to their part ("‹ GitHub", "‹ Automations"), and so is Esc once you've left the editor. Coming back puts focus on what opened it.
- Esc on a part goes to the Inbox.
- Parts and views stay mounted once opened, so an unsaved rules or automation draft survives leaving and coming back.

### Inbox and notifications

- Move untouched items to FYI after (days).
- Urgent from a score of (8), FYI up to a score of (3).
- Notify me when something needs me.
- Quiet hours: two times (in this computer's 12- or 24-hour clock) and a switch. Off saves `""` and greys the times, keeping them; on saves `19:00-09:00`. A time saves when you leave its field. The row greys while notifications are off.

### Agent

- **Agent** (`agent.harness`): Claude Code, Codex or OpenCode. Every run is your own `claude`, `codex` or `opencode` from your PATH, on your own login; there's no command or model to set. Labels across Settings name the one you picked.
- **Status rows**, only while something needs you:
  - "Claude Code isn't connected to the desk" with **Connect Claude Code** (the commands in its tooltip; a failure in red under it). When something else of yours keeps the name inbox, its help says what the desk goes in as instead ("Connects as inbox-47998: your other desk keeps inbox"), and the flash after says the same.
  - "The desk's skill is out of date" with **Update the skill**.
  - "AI reviews are paused" after failures in a row (an expired login), with why and the next try. When sorting fails for the same reason, "Claude is paused" covers both: "Nothing is sorted or reviewed until then."
- **Sort my desk with Claude**: Claude weighs every rule that matches an item. Under it, only when its last call failed (and not for the reason "Claude is paused" already says), **Sorting failed** with why and the next try, in ink.
- **Score the Inbox with Claude** (`agent.score`).
- **Run your agent**. Off stops it, nothing wakes it, and no Ask your agent shows.
- **Let your agent run without asking** (on by default; only while Run your agent is on): bypass permissions mode (its deny list still holds). Changing it restarts it.
- **Your agent's model** and **Your agent's effort** (only while Run your agent is on; no effort on OpenCode): dropdowns of what the picked agent takes (Claude Code's aliases and levels; `codex debug models`; `opencode models`), Default first for its own default; a value set by hand stays listed. Where nothing can be read, a text field. Each agent keeps its own: switching agents puts the outgoing one's model and effort away and brings the incoming one's back (its own defaults the first time). On Claude Code a change starts a copy of the session that runs with it. The chat's menus set the same.
- **More Agent settings**: **Let Claude sort up to** so many items an hour, **Decision model key** (an OpenRouter key, saved only from this page in `secrets.json`; shows dots once saved; pasting replaces it; Reset to default clears it; its help says what goes to OpenRouter), **Decision model** (its id), **Light model** (`agent.light_model`: what sorts, scores, answers the rules' questions and reads small facts like who a bot's PR is for, after any external provider such as the decision model; a dropdown of your agent's models, empty for "Haiku, the cheapest" on Claude Code, "GPT-5.6 Luna, the cheapest" on Codex, or its own default on OpenCode) and **Light model's effort** (`agent.light_effort`: a dropdown of your agent's levels, empty for low; none on OpenCode). Both kept per agent like your agent's model. [api.md → The light model](api.md#the-light-model).

### Automations

`#/settings/automations` (`#/settings/criteria` goes here too): **Your automations**, then **Urgency**, one page.

#### Your automations

One row per automation, then **New automation**. With none: "None yet", "Ask an agent to write one, or write one yourself."

Each row:

- Its name, linking to its view.
- What starts it, in words ("Weekdays at 9:00", "Weekdays, every hour", "When CI changes or someone comments"), a schedule's next run, or "off".
- Its last run ("ran 2h ago, put 2 on your desk"). Failures in red ("failed 2h ago: …", "couldn't add 1", "refused 2"). While a question's model can't answer: "waiting: …" in red.
- **Run now** while it's on ("Running…" while it runs) and its switch.

**An automation's view** (`#/settings/automations/<id>`):

- Name, what starts it and its next run (or "on", "off").
- Its instruction, quoted (a rule has none).
- **Only when**: its check, in the code font.
- **Decides**: a rule ("A rule, with no model: …"), a question ("A question: Claude answers, without tools", or the decision model "through OpenRouter"), or an agent ("An agent: your Claude Code, with read-only tools").
- **May** (not for a rule): "Add to your desk, sort to FYI and snooze".
- While its model can't answer: a red line saying it's waiting, why, when it asks again, and that nothing was spent.
- **Run now** (not for a rule, or a question on events without a check), **Edit**, **Turn off**/**Turn on**.
- Its runs: when and how ("on schedule", "run now", "on an event"), what it did ("put 2 on your desk, sorted 3 to FYI, snoozed 1"), the agent's summary, each item with what came of it (Added, Sorted to FYI, Hidden, Snoozed until CI passes, Marked done, Muted, Already on your desk, You'd dealt with it, Nobody needs it now, Held where it is; Not allowed and Couldn't add in red) and why.
- **Copy resume command** copies `cd <home>/automations && claude --resume <id>` (`codex resume` or `opencode --session` for those agents).
- Deleting one goes back to Automations. A link to one that isn't there says so.

**The editor** (New automation, or Edit in a view):

- **Name**.
- **Runs**: On a schedule (in words: `weekdays 09:00`) or When something happens (event kinds to tick: "CI changes", "A review is asked of you or your team", "Someone comments", …). Each keeps its value when you switch.
- **Only when**: the check. A rule or a question on a schedule needs one.
- **How it decides**: A rule, Ask a model, or An agent with tools.
- For a rule, **Then**: Add to your desk, Sort to Today, Sort to Later, Sort to FYI, Hide, Snooze (with "until": tomorrow, an hour, 3 hours, Monday, new activity, CI passes, new commits, approved, ready for review, conflict fixed), Mark done, Mute; and the why the item shows.
- For the others, **Instruction** and **It may** (the same eight, at least one).
- **Save** (⌘S; off until it's a valid automation), **Cancel** (Esc), and in a view **Delete** (no confirmation; stops a run in progress).
- A new one's id is its name's, made unique with -2, -3…

#### Urgency

**Change with your agent**, on each criterion's line and under an automation's buttons: a box for what should change, in your words. **Ask your agent** sends them to your agent with what to do (`changeAsk()` in `web/src/view.ts`): change it with `desk_criteria` or `desk_automations`, only what you asked, and say what changed; a built-in can't be edited, so it writes your own instead (an automation saved off) and says whether to switch the built-in off. The chat opens on it.
Your criteria on one sheet, under your automations ([api.md → Urgency](api.md#urgency)).

- Each row: its name, what it says yes to, whether a yes is urgent, how many Inbox items it says yes to now, who wrote it, and its switch.
- A click on the name opens its editor under the sheet: name, question, rule (**Only when**), whether a yes is urgent; Save, Cancel, Delete.
- **New criterion** at the sheet's foot.
- **From GitHub**: the criteria GitHub comes with ("Asked by name", "Waiting on your reply", "Ready to merge", "Your draft", "Your PR others wait on", "Handed back"). You only switch them.
- Under the sheets, quietly, who last scored your Inbox. A question waiting on its model says why on the first row.

### This device

- **Theme**: System, Omarchy (when available), then the light themes and the dark ones. Kept per device, not a desk setting ([Themes](#themes)). `#/settings/appearance`, where it was, opens here.
- Only in the desktop app:
  - **Shortcut to show or hide the window**: its field, **Record** (tooltip names the keys it takes), **Turn off** while set. Help: "Works from any app.", "Off.", or in red why it couldn't take it ("Couldn't use Control+Alt+D: another app has this shortcut."). On a Mac it uses Option and Command. Default Control+Alt+D.
  - **Open at login**.
  - **Show the Inbox count in the menu bar** (macOS only).
  - **Run from a checkout** ([AGENTS.md → Run](../AGENTS.md#run)).

### Network

Two sections: Tailscale, then Local network.

#### Tailscale

Only in the desktop app (in a browser it says to open the app): **Use it from your other devices**, under it where it serves with **Pair a device** (a one-time code as a QR to scan in the Inbox app on your phone, its link for another device's browser and the `desk connect` command; it closes once the device pairs) and each paired device with **Revoke**, then **Tailscale login allowed in** ([api.md → Security model](api.md#security-model)).

#### Local network

**Read it from your local network** and **Local network token** ([api.md → Security model](api.md#security-model)).

#### Themes

- System (follows the computer), Light, Dark, Sand, Slate, Solarized, Catppuccin Latte, Sentry Dusk, Sentry Dawn, Gruvbox, Tokyo Night, Everforest, Kanagawa, Nord, Rose Pine (Dawn), Flexoki Light. Listed in `src/themes.ts`, each with a matching diff syntax theme.
- Kept by the desktop app in its own data (it also paints the window in that paper before the UI loads); in a browser, in localStorage. `index.html` applies it before the first paint. Code: `web/src/theme.ts`.
- **Omarchy**, on a machine running Omarchy, follows Omarchy's current theme (`src/omarchy.ts`, `GET /api/omarchy`). A theme the desk has by that name is shown as the desk's own; any other is built from its `colors.toml`, held to the same contrast floors. The desk polls Omarchy's `theme.name` each second while a window is connected and sends an `omarchy` event, so a switch shows without a reload. The last one shown is kept in localStorage (`desk.omarchy`) for the pre-paint.
- Adding a theme and the token roles: [visual.md → The visual system](visual.md#the-visual-system).

### GitHub

The first plugin's part.

- **Status**: "Signed in as @you" (or "Not signed in"), over "Through gh. The desk writes to GitHub only when you click a button that says so." Or the last sync's error in red, with "Run `gh auth login` in a terminal, then sync." when a login would fix it. Your teams and what's left of the rate limit are in its tooltip.
- **Searches and rules**: its help says where each org's items start ("acme goes to Work, everything else to Personal."), or the error count in red.
- **Archive a review request when someone else approves**: Always, only when your team was asked, or never.
- **Claude reviews other people's PRs ahead of time** (the AI review).
- **More GitHub settings**: AI reviews running at once, repos that count as yours, more bots, names agents use for you, the close-collaborator threshold, the sync interval (`github.poll_seconds`, 90 s), and the prompts `desk prompt <ref>` prints for someone else's PR, yours and an issue.
- **Automations**: the ones GitHub comes with (`src/connectors/github-automations.ts`). Each row: its name, what it does and its last run, **Run now** and its switch (the only thing you change). Its view has **Copy to your automations** in place of Edit (makes an editable copy, off) and no Delete.

**Searches and rules** (`#/settings/rules`):

- One line, then the TOML editor with a preview, as tall as the window allows. Code wraps.
- Its foot stays on the window's bottom edge: **Save** (filled while there are changes; ⌘S), **Preview changes** (⌘↵), **Revert**, the file's path, "Unsaved changes" and the cursor position.
- Tab indents in the editor; Esc leaves it onto Save.
- A click on an error jumps to its line. In a narrow window the first error also shows in the editor's foot.
- Beside it, **Built in**: each board's GitHub rules, folded per board, each with its bucket, why and weight in plain words ("Now: someone asked you directly · firm, 9 of 10"; `weightText()`), a switch, or Edit where yours stands in its place.
- Then **Rules Claude can't sort below**: the saved hard and final rules in board order ("My PRs (Personal) → Today: your draft: finish it · strong, 6 of 10" over its `when`; "(final)" marked in place of a weight). With none, one line says Claude can sort anything off your desk.
- The Syntax sheet says what `weight` does: 0 to 10, 5 unless set.

Rules themselves: [api.md → Rules: built in and your own](api.md#rules-built-in-and-your-own).

### Sessions

The Sessions plugin's part ([api.md → Sessions](api.md#sessions)):

- **Show sessions that need you** (`sessions.enabled`).
- **Ask your agent whether a question waits on you** (`sessions.ask`).
- **More Sessions settings**: **Stalled after** (`sessions.quiet_minutes`).

## The first run

A desk that was never set up shows one page in the window's place, without the sidebar, until you pick your agent ([api.md → The first run](api.md#the-first-run)). Its top is the drag handle.

- **Set up Inbox**, with the mark.
- **GitHub**: "Signed in as @you", or why not ("You're not signed in to GitHub.", "The GitHub CLI isn't installed.", "Couldn't reach GitHub: …") with the command to run and **Retry**.
- **Your agent**: one line on what it does, then Claude Code, Codex and OpenCode, each "Installed and logged in." with a green **Use Claude Code**, or "Not logged in." / "Not installed." with the command to run and **Retry**. While GitHub isn't connected the agents say only where they stand; GitHub's Retry asks about everything.
- **Use …** is one press: "Connecting…", then the Inbox with the first sync running. What fails (the CLI refusing the MCP server, or missing) is red under that agent; a name something else of yours keeps never does, as Connect picks another, and the button stays to try again.
- It never shows again. Settings → Agent changes the agent; `desk setup` does the same from a terminal.

## Bubbles

What's wrong with the system is never a line in a page. It's a small stack of bubbles at the window's bottom right (left of the chat when it's open). `noticesOf()` in `web/src/notices.ts` decides them from what the desk reports, so the tray and MCP agree.

In order:

| Bubble                                                                           | Fix                                  |
| -------------------------------------------------------------------------------- | ------------------------------------ |
| "The desk isn't running" / "The desk is starting"                                | Retry                                |
| "Restarting the desk" / "The desk stopped" (with its last lines)                 | none                                 |
| "Your rules don't load" / "Your rules have 2 errors" (not on Searches and rules) | Fix rules                            |
| "Claude is paused" / "AI reviews are paused" (not on Settings → Agent)           | Open Settings → Agent                |
| "Sync failed" and the error                                                      | Try again ("Syncing…" while it runs) |
| "GitHub's rate limit is used up" and when syncing resumes                        | none: every sync waits for the reset |
| An action that failed (GitHub refused, a save refused)                           | none; fades after 8 s unless hovered |

- While the desk is down, only that is said: what it said last is stale.
- A dot before the title: red for failing, amber for a caution.
- Each has at most one fix, and **Dismiss**.
- A dismissed bubble stays gone on this device while its condition holds. It comes back when the condition changes (logged out → failing otherwise) or after it resolves and recurs.
- Failed actions: newest last, three at most.
- The page leaves room under its end so its last rows scroll clear. A toast rises above the bubbles.
- What belongs to the item on screen stays on it (its CI, its AI review's failure). Settings keeps its own diagnostics.

## Asking your agent

A quiet **Ask your agent** in the sidebar's footer opens your chat with your agent on the window's right, about what you're on:

- In a PR's review: the PR and the last spot you were on: a conversation's reply box (or its **Ask your agent**), a thread's Reply, or lines you picked with `+`.
- Elsewhere: the Merging row, the selected row, a question's item, or nothing.

The `+` box and a thread's Reply box each have a quiet **Ask your agent** after Cancel. It opens the chat on those lines or that thread; your typed words stay in their box, unsent. The chat is never filled from a box: the `+` box only posts to GitHub, and the chat only talks to your agent. Line asks need an open PR.

### The sidebar item

- "Ask your agent", or "**Your agent · waiting**" (filled bubble) while your latest ask about the review's PR is unanswered. Compact: "Ask" / "Asked".
- Not drawn while the chat is open, with your agent off, or on your agent's own question's page (its answer box is how you talk to it there).

### Where the chat sits

- Above 1100px it's a third column and the page narrows. At 1100px and below it lies over the page's right edge.
- Beside a review in a window under 1600px, the list beside the review folds away.
- In a review it takes the review sidebar's place. The sidebar's toggle closes the chat and brings it back.

### The chat

- **Head**: your agent's own name with its mark ("Claude Code", "Codex", "OpenCode"; the marks are Lobe Icons'), the item it's about, and at the right edge **New chat** and an icon button that closes the chat (its tip names Esc). Outside a review, a × after the item switches to general asks, keeping what you typed.
- **The spot**, above the box: "On dana's thread on src/auth.ts:42", "On plan.ts:20–23", "On plan.ts:17–18, removed". Full path and commit in its tooltip. A × drops it so the next ask is about the whole PR. Picking another spot replaces it; leaving the review drops it.
- **Open questions** from your agent about the item: "Your agent asks: … · Answer".
- **History**: one conversation, every ask you've sent oldest first, whatever it was about: your words on the right with their time, the PR it was about (a link to its review) and spot; each answer as plain prose (paragraphs, lists, `code`, code blocks, bold; https links shown as URLs; never HTML or images). Each code block has a **Copy** that keeps its ``` fence, ready to paste as a GitHub suggestion.
- **Under your latest unanswered ask**: "On it", "Queued: …", "Waiting on a permission prompt" (answer it on claude.ai), or "It stopped without answering" with **Wake it**, plus a link to watch it on claude.ai.
- **While it works**, under your latest unanswered ask: what it's said so far this turn, a message at a time as its agent writes them, a shade quieter than an answer; its answer takes their place. The pane follows its newest words unless you've scrolled up.
- **Under each answer**: when, and three icon buttons, each named in its tip: **Copy this answer**, **Go to what you asked**, **Go to the top of the conversation**.
- **New chat** is one bordered button in two halves. The plus ("New chat with Claude Code, about the same thing" in its tip) starts an empty chat with your agent about what this one was about: its session starts afresh on your next ask, and an ask it hadn't answered is let go. The arrow opens "New chat with" and the three agents, yours marked "Your agent"; picking another starts the new chat with it and makes it your agent, as Settings → Agent does.
- **An agent that isn't ready**, picked there: the pane says "OpenCode isn't installed" (or "isn't logged in"), the command to run with **Copy the command**, a link to its own page ("How to install OpenCode"), **Check again** (the new chat opens once it's ready) and **Back to Claude Code**.
- With nothing asked yet there's no log: the box takes the pane, you write at its top ("Ask or tell it something about web#3") and its controls keep the foot. In the pane's middle are four examples under "Inspiration", small one-line pills, gone once you type: two things to ask and two rules to have it add ("Make security PRs urgent"). A click puts one in the box, unsent.
- It opens at the newest turn's top and returns there on a send and when an answer lands. Shift+Tab from the box reaches the log.

### The box

- No frame of its own: you write on the pane. Enter, ⌘↵ or **Send** (the accent's square with a paper plane, named in its tip) sends; Shift+Enter is a new line.
- In its top corner, once there's a conversation, an icon button expands the box over the log to write at length, and shrinks it back; sending shrinks it.
- **How your agent runs**, left of Send: up to three menus of the desk's own, each saved as you pick it and the same settings as Settings → Agent. How freely it runs, in the agent's words ("Ask first" / "Bypass permissions" on Claude Code, "Workspace only" / "Full access" on Codex, "Refuse what asks" / "Approve what asks" on OpenCode); its model ("Model" while it's the agent's default; Claude Code lists Fable, Opus, Sonnet and Haiku, and every agent takes a typed one); its effort ("Effort" while default; none on OpenCode). A menu opens over its words with the one in force ticked; while it's open its trigger shows no tooltip; Esc or a click away closes it.
- Esc in the empty box closes the chat; with words, Esc leaves the box and keeps them.
- Esc anywhere outside a text box closes the chat before the page reads it as "back". Esc in another box stays that box's.
- Focus stays in the box after a send.
- Unsent words are kept per item in this window.

### Behaviour

- It stays open wherever you go until you close it, and through a reload of the window. In a review it's about that PR; elsewhere it stays about what it was, without a spot.
- When your agent pushes a change you asked for to your own open PR (not handed off): it stays on your desk; the push counts as your activity; an open `+` box stays pinned to the commit you read; the AI review goes stale; the answer names the commit and says to pull first.
- If your agent won't start, the chat says so and your words stay.
- With your agent off (Settings → Agent), no Ask your agent shows. An open chat says so and its box sends nothing.

## The update line

When a newer Inbox is released, a line appears in the sidebar's footer, above Settings (`Sidebar.tsx`):

- **Update to x.y.z** where the app can install it itself (macOS, an AppImage on Linux, the installed Windows app). A click downloads it and restarts into it; it reads "Updating…" meanwhile.
- **Download x.y.z** elsewhere (archives, a Mac app it can't write over): a link to the release page. If an install failed, its tooltip says why.

The desk checks the latest GitHub Release every 6 hours, only in the packaged app (`src/updates.ts`; the install is `electron-updater` in `electron/main.ts`, and the app's own swap in `electron/mac-update.ts` on macOS). Releases: [README → Release](../README.md#release).

## Keys

Holding ⌘ (Ctrl elsewhere) alone for a moment shows each shortcut as a small chip by its button, growing out of nothing: ⌘1 to ⌘4 on the sidebar's pages, / on the search, ⌘N on New note, ⌘↵ over a conversation's send button. Letting go, or pressing another key, puts them away (`data-key` on the button, `[data-key]` in `styles.css`, the hold in `App.tsx`).

The window names no key; a button's tooltip names its own. Only platform keys work, and / for the filter, as on GitHub. Nothing outside a box you're typing in writes to GitHub or changes an item.

| Key                             | Does                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Esc                             | Closes the topmost thing (a menu, the chat, the comment bar, a box, an editor). On a list: then closes the item opened in place, then clears the filter. Then goes back: a review or question to where it came from, a Settings view to its part, any other page to the Inbox. A held Esc doesn't repeat. |
| ⌘↵                              | Sends in every box that sends (a comment, a line comment or reply, Reply, Request changes, the issue comment bar, an answer). Previews in Searches and rules.                                                                                                                                             |
| Enter / Shift+Enter             | In the chat: send / new line.                                                                                                                                                                                                                                                                             |
| ⌘S                              | Saves rules or an automation.                                                                                                                                                                                                                                                                             |
| Tab                             | Moves focus. A row is a button: focusing selects it, Enter or Space opens it. In the rules editor Tab indents.                                                                                                                                                                                            |
| ↓ / ↑                           | On a list page and Merging: focuses (selects) the row after / before the focused or selected one, from the first or last; Enter opens it. The page scrolls only to keep it in view.                                                                                                                       |
| Arrows, Enter, Space, Backspace | In menus, the reviewers box, settings fields and the shortcut recorder.                                                                                                                                                                                                                                   |
| /                               | Puts you in the search at the top of the sidebar, when you're not typing; not in Settings.                                                                                                                                                                                                                |
| ⌘1–⌘4                           | Inbox, Blocked, Merging, Archive (Ctrl elsewhere). Each page's tooltip names its key.                                                                                                                                                                                                                     |
| ⌘] / ⌘[                         | The item after / before the open one in its list (else the selected one; with neither, the first or last), opened as a click would. On Merging, its PRs. Stops at the list's ends and at a fold. Works from a box; does nothing in Settings.                                                              |
| ⌘,                              | Settings (desktop app).                                                                                                                                                                                                                                                                                   |
| Control+Alt+D                   | Shows or hides the window from any app (desktop app; settable in This device).                                                                                                                                                                                                                            |

Code: `onKey` and `onCapture` (`SIDE_PAGES`, `stepTo()`) in `web/src/App.tsx`, plus each box's own handler. `web/test/hints.test.ts` keeps key names out of the window's strings.

## Files

| File                                                                              | What                                                                                 |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `web/src/App.tsx`                                                                 | state, data loading, SSE, keys, routes wired to pages                                |
| `web/src/view.ts`                                                                 | routes, grouping, filter, settings parts and helpers (pure, tested in `web/test`)    |
| `web/src/notices.ts`, `components/Bubbles.tsx`                                    | the bubbles: which, in what words, dismissals                                        |
| `web/src/components/Sidebar.tsx`, `PageHead.tsx`                                  | the sidebar (pages, Ask your agent, the update line, Settings); each page's head     |
| `web/src/components/Queue.tsx`, `CardRow.tsx`, `Detail.tsx`                       | the Inbox, Blocked and the Archive: rows, an item opened in place                    |
| `web/src/components/Inquiry.tsx`, `Session.tsx`                                   | agents' questions (rows and page); sessions that need you                            |
| `web/src/components/RowMenu.tsx`, `More.tsx`                                      | a row's right-click menu; a review's More                                            |
| `web/src/components/Beside.tsx`                                                   | the list beside a review or a question                                               |
| `web/src/components/Review.tsx`, `Conversation.tsx`, `Reviewers.tsx`              | a PR's review: header, AI review, conversations, diffs and notes, actions, reviewers |
| `web/src/components/Inflight.tsx`                                                 | Merging and Claude's work                                                            |
| `web/src/components/Chat.tsx`, `Prose.tsx`                                        | Ask your agent; drawing an agent's text                                              |
| `web/src/components/Settings.tsx`, `Rules.tsx`, `Automations.tsx`, `Criteria.tsx` | Settings and its views                                                               |
| `web/src/components/Setup.tsx`                                                    | the first-run page                                                                   |
| `web/src/styles.css`, `web/src/theme.ts`                                          | tokens per theme and layout ([visual.md](visual.md)); the device's theme             |
| `web/src/components/Mark.tsx`, `assets/brand/mark.svg`                            | the mark ([visual.md → The brand](visual.md#the-brand))                              |
| `web/src/fonts/`                                                                  | bundled fonts, so nothing loads from the network                                     |
| `web/mock/server.ts`, `diffs.ts`                                                  | an in-memory API for UI work without GitHub: `node web/mock/server.ts`               |
