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
- **Calm.** Colour only where it carries information: "CI failing" red, "changes requested" and "merge conflict" amber, an AI review's risk (low green, medium amber, high red). The one control to press in each place is filled with the accent; a row's call to action is tinted and fills under the pointer. Everything else on a row or an opened item is text. Sentence case, no all-caps, no monospace outside code. Details: [visual.md → The visual system](visual.md#the-visual-system).
- **State lives on the desk.** Pages only render what the desk sends (`QueueView`, `Card`), so the tray, MCP and another client agree.

## Layout

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ ▬ Inbox      │ [ Filter ]                                                     │  the page's own head
│              ├────────────────────────────────────────────────────────────────┤
│ Inbox     21 │ Urgent  3                                                      │  a section's heading and its count
│ Blocked      │ Question  Compact tombstones in #12, or ship…?    Answer   24m │  an agent's question leads Urgent
│ ──────────── │ PR  Rotate staging KMS keys  infra#540  Auth and keys      28h │  its reason, quietly after its ref
│ Merging      │ Standard  9                                                    │
│ Archive      │ PR  Retry dead-lettered jobs  worker#882  carol waits…     26h │  the row you came back from: a neutral fill
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
- **Pages**: Inbox (with its count), Blocked, then under a hairline Merging and Archive.
  - Inbox counts Urgent, Standard, agents' questions and sessions that need you.
  - Blocked, Merging and Archive have no count. Merging's tooltip says how many are merging.
  - A review is marked under the page it was opened from; a question under the Inbox.
  - Clicking Inbox while on it scrolls to the top.
- **Footer**, bottom up: Settings, then the [update line](#the-update-line) when there's a newer Inbox, then [Ask your agent](#asking-your-agent).
- **In Settings**, the pages give way to Settings' parts, under **‹ Inbox** ([Settings](#settings)).
- **Narrow windows**: the sidebar compacts (the mark alone, "Ask" for Ask your agent), then becomes one row across the top that scrolls sideways inside itself.

### A page's head

Sticky, and the desktop app's drag handle. It holds only the page's own controls:

- Inbox, Blocked, Archive: the filter. In the filter, Esc clears it; Enter or ↓ leaves it.
- Merging and a Settings part: the page's name.
- A review, a question, a Settings view: the way back ("‹ Inbox", "‹ Blocked", "‹ Merging", "‹ Archive", "‹ GitHub", "‹ Agent", "‹ Your automations"). Its tooltip names Esc, and for a review or question, ⌘[ and ⌘].

### The list beside a review

In a window 1160px or wider, a review or a question keeps the list it came from beside it.

- Same rows, order, group headings and filter as that page. A question's list is the Inbox.
- Two lines a row: the title (two lines at most), then one pencil line: PR, Issue or Question, repo#number, a sorted-away row's why, who it's from, the stage, the call to action as accent text, and the age.
- The open item's row is marked.
- A click or right-click does what it does on the full page. An issue opens in place under its row; Esc closes it first.
- A review opened from the list goes back to the list's page. One opened beside a question goes back to the question.
- A chevron on the list's divider folds it to a rail ("Hide the list", "Show the list"). The choice is kept per device.
- While the chat is open in a window under 1600px, the list folds to its rail on its own without changing that choice.
- Folding, resizing or the list appearing never redraws or refetches the review. Your typing, folded files and scroll stay.
- Moving to another review scrolls its row into the middle if it's out of sight.
- Below 1160px there's no list and no rail.

### Loading, empty, scroll

- While a page waits on the desk, quiet bars stand where its rows or text will be. They show only after about 150 ms, so a quick answer never flashes them.
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

Every row shows: all of Urgent, then all of Standard, then all of FYI, nothing behind a "more". Scrolling, the section you're in keeps its heading pinned under the page's head until the next one's pushes it off.

**Notes to yourself.** **New note** on a list page's head, or ⌘N anywhere, opens a box at the window's bottom: your words and **Remind me** (No reminder, In 1 hour, In 3 hours, Tomorrow 9:00, Monday 9:00, or Pick a time…, a date and time). ⌘↵ saves, Esc closes. A note without a reminder leads Standard; one with a reminder waits under **Reminders** at the top of the Archive, then at its time notifies once (even in quiet hours; not when notifications are off) and leads Urgent. Its row: Note, its words, **Done**, and its time ("at Tue 9:00") where a PR's author goes. A click on it opens the box to change it. The filter matches a note's words.

The quiet rule: an item nobody has touched for `queue.quiet_days` (14) moves to FYI, unless pinned or a review you were asked for in that time.

### A row

One line, columns lining up row to row:

| Part           | What it shows                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Label          | PR, Issue, Question or Session. A bolt by "PR" marks someone else's small PR its AI review calls low risk (`Card.quick`).                  |
| Title          | 15px.                                                                                                                                      |
| Ref            | repo#number. A long repo name is cut short; the number never is. A stack's place follows ("3/6").                                          |
| Why            | In pencil, `Card.reason`: a hand-back's words, the urgent criterion's name, an automation and its why, the score's line or the rules' why. |
| Call to action | At most one ([below](#calls-to-action)).                                                                                                   |
| By             | Who it's from, with their GitHub picture (none for you or a bot). "by you" a shade darker.                                                 |
| Stage          | A PR's stage. On your own PR, "changes requested" is amber.                                                                                |
| Age            | How long it's waited.                                                                                                                      |

In a narrow table the stage column goes first, then who it's from. On your own row the stage takes the place of "by you". Who placed an item (Claude or a rule) is never on the row; it's in the opened item's facts and rule trace.

A stack of PRs is one row: the lowest open member, in the most urgent place, with its place in the stack ("api#4154 3/6").

### Calls to action

The desk picks it (`cta` on the card). A tinted button before the age, filled under the pointer:

- **Ready for review** on your own open draft, even with red CI (your agent fixes CI once it's ready). Marks it ready on GitHub at once and it leaves your desk.
- **Reply** on your PR whose only action is answering someone. Opens its review with the first reply box focused.
- **Add reviewers** on your ready PR nobody's asked to review. Opens its review with the Reviewers box focused.
- **Merge** on your own PR that's approved, green and mergeable. Merges it on GitHub with the repo's merge method in one press, and it goes to the Archive.

Ready for review with nobody asked isn't done: the PR comes back ready, with Add reviewers as its call to action, and the toast ends "Nobody's asked to review it yet". Ten minutes later it tops your desk.

### Clicking a row

- A PR opens its [review](#the-review-view).
- An issue or a session opens in place under its row.
- A question opens its [page](#an-agents-question).

### An issue opened in place

- Why it's here ("Assigned to you").
- One pencil line of facts: by, how you were asked, labels, comments, who placed it.
- Where it sits and from which board, a collapsed rule trace, and its last 8 events in plain words.
- Actions as text under a hairline: **Comment**, **Open on GitHub**, **Done** (or **Back on the desk**), **Snooze**, **Mute**, **Close**.
- Close, a click on its row, or Esc closes it.

**Comment** opens a comment bar at the window's bottom. ⌘↵ sends it to GitHub and the issue leaves your desk until someone else acts. Esc closes the bar. A refusal keeps your words. A refresh that moves the row doesn't touch it.

### A row's menu

Right-click any row (Inbox, Blocked, Merging, Archive) for a menu at the pointer:

- **Done** (or **Back on the desk** once cleared).
- **Snooze**, opening to the side: a time, until activity, or what the PR can wait on now (`wake_on`: CI passes, new commits, it's approved, it's ready for review, the merge conflict is fixed).
- **Close on GitHub**, where it can be closed.
- **Copy link**.

On Merging the menu is **Back to the desk** and **Copy link**. A question's is **Answer**, **Copy link**, **Dismiss**. A session's is **Done**, **Snooze** and its call to action. Arrows move, → opens Snooze, Enter picks, Esc closes.

### Agents' questions

A Claude Code session asks you in the desk (`desk_inquire`) beside its chat: when you asked it to, or about work going on while you're away. Your agent always asks here.

A question is a row at the top of Urgent: labeled **Question**, the question as its title, **Answer** as its call to action, "by" who asks ("by your agent", or the session's name), and its age. The desk refuses a question without enough context, a link or item, or answers that say what follows.

### Sessions that need you

Your own Claude Code and Codex sessions on this computer that are blocked on you or stalled (`src/connectors/sessions.ts`; Settings → Sessions turns them off). They follow the questions, blocked ones first.

- **Row**: labeled **Session**, its name, its folder, its call to action, its kind where "by" goes (CLI, Background, Desktop, Codex), why it's here where the stage goes ("needs permission: Bash", "asked a question", "rate limited until 14:05", "stopped mid-turn", "login expired", "no progress"), and its age.
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
  api#4154  3/6  by priya                                                                      [▯▮]
  Planner: hash join stage                                        Stack on main
  asked you directly · CI passing · changes requested             ○ #4153 Planner: run the table…  ✗
  +172 −32 in 3 files                                             ┃○ #4154 Planner: hash join st… ±┃
                                                                  ○ #4155 Planner: stream partia…
› Look closely  ▮▮▯ medium risk                                     3 more
  Adds a streaming scan (streamRows) and uses it in runPlan, ...  CI passing · 14 checks         ›
                                                                  Changes requested by sam       ›
  (threads waiting on you)                                        Merge conflict with main
                                                                  3 files
  [Approve] [More] [ Comment on api#4154…           ]             src/planner/plan.ts       • Look
                                                                  src/routes/query.ts       • Look
                                                                  docs/api/query.md           Skip

  Look  src/planner/plan.ts  budget checked only between batches  +7 −3
  ┌──────────────────────────────────────────────────────────────┐
  │ 17 + export async function runPlan(q, budgetMs = ...)        │
  │    ┃ The budget is only checked between batches, so ...      │  an AI note, at its line
  └──────────────────────────────────────────────────────────────┘
  Skim  src/planner/stream.ts  new batching generator         +24 −0
  ...
  Skip  docs/api/query.md                                        +3 −1
  Not worth reviewing · 1 file
```

Esc or the back link goes back to the page it was opened from.

### Opening

- It never waits. It draws at once from the row's card (header, CI, review state, size, and the AI review's read when the card has one), with quiet bars where the rest will land, so nothing moves.
- Resting the pointer on a PR row for 150 ms fetches its review ahead (`?ahead=1`, which starts no AI work). The desk also fetches the Inbox's diffs after each sync.
- A big diff draws its first files with the page and the rest a chunk at a time.

### Header

- The ref, a stack's place ("3/6"), the author with their picture ("by you" on yours), the title.
- Under the title, one line: its size, + in green and − in red, then who reviews it, each with their picture (a team "@") and a verdict's mark (✓ approved in green, "changes" in amber). Someone who only commented is in the sidebar's Reviewers.
- Nothing else: why it's on the desk is the row's; CI, the review state, a conflict and what it blocks are the sidebar's.
- A resolved PR says so under the title: "Resolved: merged by li-wei · 2h".
- Your PR in Merging says "Merging", with what it waits on and your agent's latest note.
- Your own PR with no AI review shows the first paragraph of its description under the title.
- Problems are coloured words; pencil once the PR is sorted away, resolved, or calm in Merging.

### The review's sidebar

Sections, each open: its name, where it stands in one line that reads first (red when a required check fails, amber for changes requested), then its rows.

- **Checks**: a row each, with a dot: red failing, red hollow failing but not required, yellow running, green passing, grey skipped. Shards of one check (`backend test (0)`, `(1)`, `[2/3]`, `#4`) are one row with a count and their worst dot; a click lists them. What's wrong comes first; past six rows the green and grey ones wait behind "N more passing". `checkGroups()` in `web/src/view.ts`.
- **Reviewers**: everyone, with their picture and where they stand; no line over them ("Nobody's asked" when there's no one). On your open PR, **+ Add reviewers** (also in More) opens the reviewers box above the buttons with **Ask reviewers**, which asks who you pick, added to who's asked.
- **Merge**: a conflict. **Depends**: what it's blocked by or blocks, when it isn't in a stack (a stack has its own section).

### The AI review

No heading; right under the header.

- **Verdict**: "Look closely" (a step larger, semibold), "Skim it" or "Skip it". The model and time are in its tooltip.
- **Risk**: in colour with a three-step meter. "on an earlier commit" in pencil when it is.
- **Summary**: its first sentence. A chevron (or a click on the verdict) opens the rest. Every PR opens folded.
- **Since your review**: on a re-review, under the summary, never folded.
- **Concerns**: each is also a note in the code. They're listed only when no note can sit there (none, or an earlier commit's review).
- All of it is drawn as plain prose (`code`, **bold**, lists), never HTML. URLs stay text: the PR's author can steer what Claude writes.

States:

- Running: "Claude is reviewing it. The notes land in the code below in a minute or two." After two minutes or on a retry: "Claude is reviewing it, 4 minutes so far, try 2 of 3." Shown only while its job runs.
- Failed: the reason in ink, not red (it's about the agent, not the PR). "… Claude tries again in 2 minutes." or "The AI review failed 3 times: …". **Try again** asks again.
- Paused after failures in a row: a PR that wasn't tried says so.
- None yet on an open PR: "No AI review yet. **Ask Claude for one**". On a merged or closed PR: "No AI review."
- Your own PR shows the section only once a review exists or is running.

The agent's name in these lines follows Settings → Agent (Claude, Codex or OpenCode).

### What reviewers said

Under the AI review, only when there's any.

- "Waiting on your reply" and how many, then each as a margin note: who (with picture), where (file:line, "outdated", or "on the PR"), when.
- Claude's one-line gist, then its take with the call in semibold ("**Valid concern:** …", "**Only you can answer:** …"), then the original words behind "What azulus wrote".
- An empty reply box: the desk never writes your answer. **Reply** (or ⌘↵) posts it on GitHub as you.
- Until Claude has read it, the gist is the comment's first line and "Claude is reading it." A failure says why in ink.
- Text is drawn with `code` as code, never HTML; URLs stay text; the original keeps its lines and ``` blocks.
- Everything not waiting on you is one line, "3 more conversations not waiting on you", opening to a line each and then their comments.

### The diff

The desk's reading order (`ReviewView.order`), which the guide's steps are built from:

1. What Claude ranked: each hunk under its file's name, its level ("Look", then "Skim") and Claude's few words why.
2. What Claude didn't read ("Not read", and whether the PR or file was too long).
3. What Claude left out: "Skip", with no why, still in view (anyone can write a diff, so it can't hide code).
4. One pencil line, "Not worth reviewing · 2 files": lockfiles, generated files, files with no text diff. A click opens them in place.

Neighbouring hunks of a file at one level read as one. Without a ranking (none yet, or an earlier commit's) it keeps file order. A PR with no changes says "No files changed."

**Guided Review and Traditional.** Two tabs above the diff, the choice kept per device (`desk.review.view`), Guided Review first. A review without steps (`order.steps`: none yet, or an earlier commit's) shows Traditional alone, with no tabs.

- **Guided Review** is only the guide, as Linear's guided reviews: each step is a heading ("1 of 4", its title), a sentence or two, and "**Check:** …" when there's something to verify, then only the hunks it covers. A quiet "Next: <title>" at its foot. The last reads "End of the guide.", and when files changed outside it, "3 more files change outside it: read every file in Traditional", a link to that tab. Nothing the steps leave out is drawn, so the guide holds your attention. A test file in a step is folded until you open it (`isTestPath()` in `src/sections.ts`).
- **Potential bugs**: each of the AI review's concerns is marked **Potential bug** on its line, edged in amber: what goes wrong, when, the fix, then "Evidence:" what in the diff shows it and how to confirm it (a suspicion with no evidence in the diff is only a note saying what to check). In Guided Review a concern's hunk shows even when no step covers it, under "Potential bugs outside the guide" after the steps.
- **Traditional** is the plain diff: every file in the PR's order, all its hunks in diff order, Claude's notes inline on their lines (`traditional()` in `src/sections.ts`), then the desk's "Not worth reviewing" fold.
- In the review's sidebar the steps take the files' place.

**Drawing.** `@pierre/diffs`: unified, word-level changes, wrapped lines, Shiki highlighting in the theme's syntax colours (`diff` in `src/themes.ts`, `web/src/diffThemes.ts`). Unchanged lines fold into a band ("14 unmodified lines"); its arrows open ten more at a time, in either review. A drawn file is read whole ahead (`GET /api/file/:id?path=`: the file at the PR's head; before it is the same run back through its patch, `oldFromNew()` in `web/src/view.ts`), so the first click opens lines. A file GitHub won't give whole (binary, too big) says so in a bubble. Each file's name sticks under the head while you read it.

**Folding files.** A file's header folds its diff and everything on it. Consecutive folded files read as one list. A different PR starts with every file open.

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

The actions' row, under what reviewers said:

- **Approve** (green): only on someone else's open PR. Sends at once; the PR leaves your desk. Disabled, with the reason in its tooltip, if you already approved this commit. It approves the commit on screen; if the desk has seen a newer push, it refuses.
- Or the PR's own call to action: **Ready for review** or **Ask reviewers**.
- **Hand off for merge** (green) on your own PR, only once it's approved or its repo needs no review. Not on a draft or a ready PR nobody's asked to review (unless its repo needs no review). One already in Merging shows **Back to desk** instead, last.
- **More**: **Done** (or **Back on the desk**), **Copy link**, then under "On GitHub" the writes it allows: **Close**, **Request changes** (opens a box for its body).
- **Your comment**: a one-line box on the same row ("Comment on api#4127…"). It grows as you write; **Comment** shows once it has words. ⌘↵ sends it and the PR leaves your desk until someone answers. Esc leaves it with your words kept. With words in it, the buttons take you back to the box instead of acting. Unsent words are kept per PR in this window.

Every GitHub write is listed in [api.md → Security model](api.md#security-model).

### Your draft's reviewers

A line above Ready for review on your draft (and above Ask reviewers on your ready PR nobody's asked), under one line saying what the button will send:

- Each person shows their GitHub picture; a team shows "@".
- Those already asked show first and stay.
- A box adds more: GitHub's suggestions under "Suggested by GitHub, from who changed these files", then people with access and the org's teams as you type (↑/↓, Enter adds, Backspace on empty removes the last, Esc leaves).
- After it, "Suggested": up to four of GitHub's suggestions as dashed pills; a click adds one.
- Ready for review asks them right after marking it ready. With nobody picked it only marks it ready and the PR stays for Add reviewers.

On your ready PR nobody's asked to review, the same line opens with the box focused, and the filled button is **Ask reviewers**.

### The review's sidebar

One icon button at the review's top right shows and hides it ("Show checks and files", "Hide the stack, checks and files"). The choice is kept per device. It stays in view as you scroll. In a narrow page column it lies over the diff and starts folded. While the chat is open the chat takes its place; the toggle brings the sidebar back and closes the chat.

Top to bottom:

- **The stack**, when the PR is in one: "Stack on main", its open PRs bottom first, each with only what's news (✗ CI failing in red, ± changes requested in amber, ✓ approved). The PR on screen is marked. A long stack shows four and "16 more". A click opens that PR.
- **The checks**, when any ran on its head: one line ("CI passing · 14 checks", "2 failing of 14 checks", "3 running of 14 checks"), red while a required check fails. A click opens every check, worst first, each linking to its page. A failing check the base branch doesn't require reads "failing, not required". Fetched when the review opens; "Couldn't load the checks: …" if GitHub won't give them.
- **The files**, in Traditional, in the PR's order with a dot when they have notes. A click scrolls there. The one you're reading is marked.
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
- Click opens the review; right-click: **Back to the desk**, **Copy link**.

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

No tabs. In Settings the sidebar lists its parts in place of the pages, under **‹ Inbox** (⌘1–⌘4 still open the pages):

- The core's: Inbox and notifications, Agent, Your automations, Urgency, This device.
- Under a hairline, one per plugin: GitHub, Sessions.

`SETTINGS_PARTS` in `web/src/view.ts`. The sidebar's Settings and `#/settings` open the first part.

### How a part works

- Each part is a route, `#/settings/<part>`, drawn alone, its name in the head. No intro text.
- Settings are rows on one sheet: label and help on the left, the control on the right edge. A number has its unit after it ("[14] days"). A prompt or path takes the row's width. On a narrow sheet controls go under their words; switches stay beside them.
- Clicking a label flips its switch.
- Under the control: "Saved" (green, briefly), "Not saved: …" (red, your input kept), or **Reset to default** on a changed setting (the default in its tooltip).
- Tuning folds behind one quiet row at the sheet's end, **More <part> settings**, closed on open.
- A row that would do nothing here isn't drawn (`SHOWN`); one that waits on another is greyed (`DISABLED`). `desk settings` and settings.json still set every one.
- When settings.json has a problem, a notice above the part names each setting by label and key, and opens More if needed.
- Old links still land: `#/settings/automations`, `notify` → Inbox and notifications, `review` and `handoff` → GitHub, `#/rules` → Searches and rules, `policy` (Your policy, gone) → Agent.
- **Views**: Searches and rules (`#/settings/rules`) and each automation (`#/settings/automations/<id>`; a plugin's `github.<id>`) open as views. Their head is the way back to their part ("‹ GitHub", "‹ Your automations"), and so is Esc once you've left the editor. Coming back puts focus on what opened it.
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
- **More Agent settings**: **Let Claude sort up to** so many items an hour, **Decision model key** (an OpenRouter key, saved only from this page in `secrets.json`; shows dots once saved; pasting replaces it; Reset to default clears it; its help says what goes to OpenRouter) and **Decision model** (its id).

### Your automations

`#/settings/automations`: one row per automation, then **New automation**. With none: "None yet", "Ask an agent to write one, or write one yourself."

Each row:

- Its name, linking to its view.
- What starts it, in words ("Weekdays at 9:00", "Weekdays, every hour", "When CI changes or someone comments"), a schedule's next run, or "off".
- Its last run ("ran 2h ago, put 2 on your desk"). Failures in red ("failed 2h ago: …", "couldn't add 1", "refused 2"). While a question's model can't answer: "waiting: …" in red.
- **Run now** while it's on ("Running…" while it runs) and its switch.
- One an agent wrote or changed reads "An agent wrote it; read it before it runs · …" and has a tinted **Review** instead of a switch: it can't run before you've seen its instruction.

**An automation's view** (`#/settings/automations/<id>`):

- Name, what starts it and its next run (or "on", "off", "an agent wrote it: read it before you turn it on.").
- Its instruction, quoted (a rule has none).
- **Only when**: its check, in the code font.
- **Decides**: a rule ("A rule, with no model: …"), a question ("A question: Claude answers, without tools", or the decision model "through OpenRouter"), or an agent ("An agent: your Claude Code, with read-only tools").
- **May** (not for a rule): "Add to your desk, sort to FYI and snooze".
- While its model can't answer: a red line saying it's waiting, why, when it asks again, and that nothing was spent.
- **Run now** (not for a rule, or a question on events without a check), **Edit**, **Turn off**/**Turn on**. One an agent wrote has a filled **Turn on**.
- Its runs: when and how ("on schedule", "run now", "on an event"), what it did ("put 2 on your desk, sorted 3 to FYI, snoozed 1"), the agent's summary, each item with what came of it (Added, Sorted to FYI, Hidden, Snoozed until CI passes, Marked done, Muted, Already on your desk, You'd dealt with it, Nobody needs it now, Held where it is; Not allowed and Couldn't add in red) and why.
- **Copy resume command** copies `cd <home>/automations && claude --resume <id>` (`codex resume` or `opencode --session` for those agents).
- Deleting one goes back to Your automations. A link to one that isn't there says so.

**The editor** (New automation, or Edit in a view):

- **Name**.
- **Runs**: On a schedule (in words: `weekdays 09:00`) or When something happens (event kinds to tick: "CI changes", "A review is asked of you or your team", "Someone comments", …). Each keeps its value when you switch.
- **Only when**: the check. A rule or a question on a schedule needs one.
- **How it decides**: A rule, Ask a model, or An agent with tools.
- For a rule, **Then**: Add to your desk, Sort to Today, Sort to Later, Sort to FYI, Hide, Snooze (with "until": tomorrow, an hour, 3 hours, Monday, new activity, CI passes, new commits, approved, ready for review, conflict fixed), Mark done, Mute; and the why the item shows.
- For the others, **Instruction** and **It may** (the same eight, at least one).
- **Save** (⌘S; off until it's a valid automation), **Cancel** (Esc), and in a view **Delete** (no confirmation; stops a run in progress).
- A new one's id is its name's, made unique with -2, -3…

### Urgency

**Change with your agent**, on each criterion's line and under an automation's buttons: a box for what should change, in your words. **Ask your agent** sends them to your agent with what to do (`changeAsk()` in `web/src/view.ts`): change it with `desk_criteria` or `desk_automations`, only what you asked, and say what changed; a built-in can't be edited, so it writes your own instead (an automation saved off) and says whether to switch the built-in off. The chat opens on it.
`#/settings/criteria`: your criteria on one sheet ([api.md → Urgency](api.md#urgency)).

- Each row: its name, what it says yes to, whether a yes is urgent, how many Inbox items it says yes to now, who wrote it, and its switch.
- A click on the name opens its editor under the sheet: name, question, rule (**Only when**), whether a yes is urgent; Save, Cancel, Delete.
- **New criterion** at the sheet's foot.
- **From GitHub**: the criteria GitHub comes with ("Asked by name", "Waiting on your reply", "Ready to merge", "Your draft", "Your PR others wait on", "Handed back"). You only switch them.
- Under the sheets, quietly, who last scored your Inbox. A question waiting on its model says why on the first row.

### Appearance

- **Theme**: System, Omarchy (when available), then the light themes and the dark ones. Kept per device, not a desk setting ([Themes](#themes)).

### This device

- Only in the desktop app:
  - **Shortcut to show or hide the window**: its field, **Record** (tooltip names the keys it takes), **Turn off** while set. Help: "Works from any app.", "Off.", or in red why it couldn't take it ("Couldn't use Control+Alt+D: another app has this shortcut."). On a Mac it uses Option and Command. Default Control+Alt+D.
  - **Open at login**.
  - **Show the Inbox count in the menu bar** (macOS only).
  - **Run from a checkout** ([AGENTS.md → Run](../AGENTS.md#run)).
  - **Use it from your other devices** (Tailscale) and its devices ([api.md → Security model](api.md#security-model)).
- In a browser the part is the theme alone.

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
- Beside a review in a window under 1600px, the list beside the review folds to its rail.
- In a review it takes the review sidebar's place. The sidebar's toggle closes the chat and brings it back.

### The chat

- **Head**: "Your agent", the item it's about, **Close**. Outside a review, a × after the item switches to general asks, keeping what you typed.
- **The spot**, above the box: "On dana's thread on src/auth.ts:42", "On plan.ts:20–23", "On plan.ts:17–18, removed". Full path and commit in its tooltip. A × drops it so the next ask is about the whole PR. Picking another spot replaces it; leaving the review drops it.
- **Open questions** from your agent about the item: "Your agent asks: … · Answer".
- **History**, oldest first: your words on the right with their time and spot; each answer as plain prose (paragraphs, lists, `code`, code blocks, bold; https links shown as URLs; never HTML or images). Each code block has a **Copy** that keeps its ``` fence, ready to paste as a GitHub suggestion.
- **Under your latest unanswered ask**: "On it", "Queued: …", "Waiting on a permission prompt" (answer it on claude.ai), or "It stopped without answering" with **Wake it**, plus a link to watch it on claude.ai.
- With nothing asked yet: "Ask or tell it something about web#3: it answers here."
- It opens at the newest turn's top and returns there on a send and when an answer lands. Shift+Tab from the box reaches the log.

### The box

- Enter, ⌘↵ or **Send** sends; Shift+Enter is a new line.
- Esc in the empty box closes the chat; with words, Esc leaves the box and keeps them.
- Esc anywhere outside a text box closes the chat before the page reads it as "back". Esc in another box stays that box's.
- Focus stays in the box after a send.
- Unsent words are kept per item in this window.

### Behaviour

- It follows you into another PR's review, about that PR, and closes when you leave for any other page.
- When your agent pushes a change you asked for to your own open PR (not handed off): it stays on your desk; the push counts as your activity; an open `+` box stays pinned to the commit you read; the AI review goes stale; the answer names the commit and says to pull first.
- If your agent won't start, the chat says so and your words stay.
- With your agent off (Settings → Agent), no Ask your agent shows. An open chat says so and its box sends nothing.

## The update line

When a newer Inbox is released, a line appears in the sidebar's footer, above Settings (`Sidebar.tsx`):

- **Update to x.y.z** where the app can install it itself (an AppImage on Linux, the installed Windows app). A click downloads it and restarts into it; it reads "Updating…" meanwhile.
- **Download x.y.z** elsewhere (macOS, archives): a link to the release page. If an install failed, its tooltip says why.

The desk checks the latest GitHub Release every 6 hours, only in the packaged app (`src/updates.ts`; the install is `electron-updater` in `electron/main.ts`). Releases: [README → Release](../README.md#release).

## Keys

The window names no key; a button's tooltip names its own. Only platform keys work. Nothing outside a box you're typing in writes to GitHub or changes an item.

| Key                             | Does                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Esc                             | Closes the topmost thing (a menu, the chat, the comment bar, a box, an editor). On a list: then closes the item opened in place, then clears the filter. Then goes back: a review or question to where it came from, a Settings view to its part, any other page to the Inbox. A held Esc doesn't repeat. |
| ⌘↵                              | Sends in every box that sends (a comment, a line comment or reply, Reply, Request changes, the issue comment bar, an answer). Previews in Searches and rules.                                                                                                                                             |
| Enter / Shift+Enter             | In the chat: send / new line.                                                                                                                                                                                                                                                                             |
| ⌘S                              | Saves rules or an automation.                                                                                                                                                                                                                                                                             |
| Tab                             | Moves focus. A row is a button: focusing selects it, Enter or Space opens it. In the rules editor Tab indents.                                                                                                                                                                                            |
| Arrows, Enter, Space, Backspace | In menus, the reviewers box, settings fields and the shortcut recorder.                                                                                                                                                                                                                                   |
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
