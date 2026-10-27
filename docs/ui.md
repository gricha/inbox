# UI

One surface. The window is the queue; Settings is the only other place, and it's configuration.

## Principles

- **Minimize surfaces, maximize automation.** No tabs. Boards and rules feed one queue; they're edited in Settings → Rules.
- **Only urgency gets colour.** A yellow highlighter marks Now: the heading and each item's ref. Everything else is ink and pencil grey. Problems ("CI failing", "merge conflict") are coloured words in Now and Today, and turn grey once sorted away.
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

- One centred column, 920px wide. The ref column (`--ref-w`) lines up group heads, refs and the Settings section list. Titles, run headers and the open detail share the second column.
- Runs: three or more consecutive items with the same author and reason collapse under one header, with their facts on the title line.
- Sorted away: later, FYI, hidden by rules, cleared. Each count opens its group inline (`g l`, `g f`, `g h`, `g x`). While filtering, empty groups disappear and groups with matches open on their own, without changing what you'd saved.
- Opening an item (Enter) shows facts, one line of why, a collapsed rule trace, and one line of actions with their keys.
- Settings: the section list sits in the ref column (a dropdown below 820px). Sections come from the schema in `src/settings.ts`, plus Rules (the TOML editor with preview). Settings stays mounted once opened, so an unsaved Rules draft survives a trip to the queue.

## Keys

`j/k` move · `Enter` open · `o` GitHub · `e` done (restore on a cleared item) · `s` snooze, then 1–5 · `m` mute · `p` pin · `u` undo (only what this window did) · `c` copy prompt · `i` brief · `w` signals · `/` filter · `Esc` close, then clear the filter · `r` sync · `,` settings · `g r` rules · `g l/f/h/x` sorted-away groups · `?` help.

Tab focus and the j/k cursor are the same thing: focusing a row selects it.

## Files

| | |
|---|---|
| `web/src/App.tsx` | state, data loading, SSE, keyboard |
| `web/src/view.ts` | routes, grouping, filter, rule-error line lookup, settings helpers (pure, tested in `web/test`) |
| `web/src/components/TopBar.tsx` | wordmark, filter, sync, help, settings |
| `web/src/components/Queue.tsx`, `CardRow.tsx`, `Detail.tsx` | the queue |
| `web/src/components/Settings.tsx`, `Rules.tsx` | configuration |
| `web/src/styles.css` | tokens for both themes, then layout by area |
| `web/src/fonts/` | Instrument Sans (UI), JetBrains Mono (code), bundled so nothing loads from the network |
| `web/mock/server.ts` | an in-memory API for UI work without GitHub: `node web/mock/server.ts` |
