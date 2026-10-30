# UI

One surface. The window is the queue; a PR's review opens in its place and Esc brings the queue back. Settings is the only other place, and it's configuration.

## Principles

- **Minimize surfaces, maximize automation.** One queue; boards and rules feed it and are edited in Settings → Rules. The sidebar navigates the queue and Settings; it never categorizes by repo or board.
- **Only urgency gets colour.** A yellow highlighter marks Now: the heading, each item's ref and the sidebar's Now count. It's a marker stroke (`::before`, chisel-cut caps sized in em, a wavy middle, a slight tilt), never a box; `npm run shots` checks it covers its text and is never clipped. Everything else is ink and pencil grey. Problems ("CI failing", "merge conflict") are coloured words in Now and Today, and turn grey once sorted away.
- **No boxes around words.** No chips, tags or outlined badges. The only frame is the keyboard cursor: a neutral fill with a pencil ring.
- **Sentence case.** No all-caps labels, no monospace outside code.
- **Both themes.** Tokens live on `:root` in `web/src/styles.css`, with a dark block under `prefers-color-scheme`. Check every change in light and dark. Text colours are `--ink`, `--ink-2` and `--pencil`; `--faint` is for non-text only.

## Layout

```
┌───────────────────────────────────────────────────────────────┐
│ ● ● ●  Review Desk        [ Filter  / ]     Synced 1m ago  ⌨ ⚙ │  title bar (drag region in the app)
├───────────────────────────────────────────────────────────────┤
│        Now 1                                                  │
│        seer#8463    Read eval API keys from macOS Keychain 32d │
│                     vaind asked you directly  +119 −9          │
│        Today 8                                                │
│                     6 PRs from azulus                         │
│        seer#9073    Remove the sentry.get_dsn helper  +5 −45 22h│
│        …                                                      │
│        Sorted away   31 later   108 fyi (22 new)              │
│        Your rules moved these out of the way.                 │
└───────────────────────────────────────────────────────────────┘
```

- A 232px sidebar: Queue (Now, Today), Sorted away (Later, FYI, Hidden, Cleared: a click opens the group and scrolls to it) and Settings (its sections). The active item is a neutral filled pill. At 820px and below it hides; Settings then uses a dropdown.
- One centred column, 920px wide, beside it. The ref column (`--ref-w`) lines up group heads and refs. Titles, run headers and the open detail share the second column.
- Runs: three or more consecutive items with the same author and reason collapse under one header, with their facts on the title line.
- Sorted away: later, FYI, hidden by rules, cleared. Each count opens its group inline (`g l`, `g f`, `g h`, `g x`). While filtering, empty groups disappear and groups with matches open on their own, without changing what you'd saved.
- Enter (or a click) on a PR opens its review (below). On an issue it opens the item in place: facts, one line of why, a collapsed rule trace, and one line of actions with their keys. `w` opens a PR in place too, with its rule trace and raw signals.
- A row whose PR has an AI review of its current commit says so after its facts: "AI says look".
- Settings: sections are listed in the sidebar (a dropdown below 820px). Sections come from the schema in `src/settings.ts`, plus Rules (the TOML editor with preview). Settings stays mounted once opened, so an unsaved Rules draft survives a trip to the queue.

## The review view

`#/review/<id>`, Linear-style: the PR is read and approved in the desk, in the queue's place, with the sidebar still there. The column widens to 1280px.

```
  api#4127  by priya
  Stream partial results from the query planner
  asked you directly · CI passing · review required · +62 −7 in 5 files

  AI review from sonnet, 14:32
  Look closely   medium risk
  Adds a streaming scan (streamRows) and uses it in runPlan, so ...
  Concerns
  • src/routes/query.ts passes ?budget= through Number() unchecked ...
  5 notes on the changes below. ] and [ step through them.

  a Approve   o Open on GitHub   c Copy prompt   i Redo AI review   esc Back

  5 files          n p  │ src/planner/stream.ts                        new +24 −0
  src/planner/stream.ts │ ┌───────────────────────────────────────────────────┐
  src/planner/plan.ts   │ │  9 + // Yields rows in batches as the scan ...    │
  ...                   │ │ 10 + export async function* streamRows(...)       │
                        │ │    ┃ The core of the change: rows come out in ... │  an AI note, at its line
```

- Header: the ref (highlighted when it's in Now), author, title, then one line: why it's on the desk, CI, the review state, size. Problems are coloured words, as in the queue.
- The AI review: verdict, risk (only high is coloured), summary, concerns, and how many notes sit in the code. While it's being written, a quiet line says so; a failure shows its reason and `i` tries again. A review of an older commit stays, marked "before the latest commits", and its notes aren't placed in the new code.
- Files on the left (sticky; above the diff at 1100px and below), with a dot on files that have notes. The file you're reading follows the scroll and wears the cursor's fill and pencil ring.
- Diffs: `@pierre/diffs`, unified, word-level changes, wrapped lines, Shiki highlighting in Pierre's light and dark themes, on `--sheet` in a hairline frame. Its CSS variables take the app's fonts (JetBrains Mono for code). Each file's name sticks under the top bar while you read it.
- AI notes are margin notes under the line they explain: a thin rule, the note in the UI font. The one `]`/`[` landed on gets the cursor's fill and ring. Notes about a whole file sit above its diff.
- Approve: `a` arms it (the key line and a toast say "Press a again to approve"), a second `a` within 3 s sends it; anything else lets it lapse. It's disabled, with the reason as its tooltip, on your own PR, a closed one, or one you already approved at this commit. It approves the commit on screen: if the desk has seen a newer push, it refuses. The approval is the desk's one write to GitHub ([api.md](api.md#security-model)).

## Keys

`j/k` move · `Enter` review a PR, open an issue · `o` GitHub · `e` done (restore on a cleared item) · `s` snooze, then 1–5 · `m` mute · `p` pin · `u` undo (only what this window did) · `c` copy prompt · `i` AI review · `w` rule trace and signals · `/` filter · `Esc` close, then clear the filter · `r` sync · `,` settings · `g r` rules · `g l/f/h/x` sorted-away groups · `?` help.

In a review: `n/p` next and previous file · `]/[` next and previous AI note · `a` then `a` approve · `i` AI review again · `o` GitHub · `c` copy prompt · `Esc` back to the queue.

Tab focus and the j/k cursor are the same thing: focusing a row selects it.

## Files

|                                                             |                                                                                                 |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `web/src/App.tsx`                                           | state, data loading, SSE, keyboard                                                              |
| `web/src/view.ts`                                           | routes, grouping, filter, rule-error line lookup, settings helpers (pure, tested in `web/test`) |
| `web/src/components/TopBar.tsx`                             | wordmark, filter, sync, help, settings                                                          |
| `web/src/components/Queue.tsx`, `CardRow.tsx`, `Detail.tsx` | the queue                                                                                       |
| `web/src/components/Review.tsx`                             | a PR's review: header, AI review, files, Pierre diffs with notes, approve                       |
| `web/src/components/Settings.tsx`, `Rules.tsx`              | configuration                                                                                   |
| `web/src/styles.css`                                        | tokens for both themes, then layout by area                                                     |
| `web/src/fonts/`                                            | Instrument Sans (UI), JetBrains Mono (code), bundled so nothing loads from the network          |
| `web/mock/server.ts`, `diffs.ts`                            | an in-memory API for UI work without GitHub: `node web/mock/server.ts`; real-looking diffs      |
