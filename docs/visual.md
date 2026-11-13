# Visual design

How the desk looks and how a design change gets in: the brand, the tokens, the layout, taking in a handoff and checking
a change. What each page does and says is [ui.md](ui.md). The product principle and the rules are
[AGENTS.md](../AGENTS.md); they win over anything here.

## The brand

The mark is the inbox design kit's icon A: a broad tray with sloped inner shoulders and a short pill floating above it,
two filled paths in a 64×64 viewBox.

- **One geometry.** `assets/brand/mark.svg` (`currentColor`) is the master; everything else is drawn from its two paths.
- **Never** redraw, stretch, stroke, shadow, gradient or badge the mark.
- **Keep its viewBox.** The silhouette spans x 8–56 and y 19.6–44.5; the room around it is deliberate.
- **A status dot goes on the tile's corner** (the tray's alert), never on the mark.
- **Colours.** The tile is petrol `#365D60` with a warm-white `#F7F6F2` mark, the same in every theme. In the window the
  mark is `--accent-ink` (petrol in Light, a light petrol in Dark, each theme's accent elsewhere). A coloured mark on a
  light surface, a light one on a dark surface; never dark petrol on a dark panel.
- **In the window** it's `Mark` (`web/src/components/Mark.tsx`): inline SVG at 24px (a silhouette about 18×9px),
  `aria-hidden`, beside the word "Inbox" in the sidebar's brand row. In the macOS app (traffic lights in that row) and
  at 641–1000px the mark stands alone.

`npm run icons` (`scripts/icons.ts`, run in Electron, which rasterizes) reads the master's paths and writes:

| File                                 | What                                                                                      | Size       |
| ------------------------------------ | ----------------------------------------------------------------------------------------- | ---------- |
| `assets/brand/tile.svg`              | the petrol tile, corner 13.5 of 64, the warm-white mark at the kit's proportions          | 64 viewBox |
| `assets/icon.svg`, `assets/icon.png` | the app icon (macOS, Windows, Linux): the tile on the macOS grid (824px at 100,100), flat | 1024       |
| `assets/trayTemplate.png`, `@2x`     | the macOS menu bar: the mark alone in black (macOS tints it), cropped with a margin       | 22×16, 2x  |
| `assets/tray.png`, `@2x`             | the Windows and Linux tray: the tile                                                      | 16, 32     |
| `assets/tray-alert.png`, `@2x`       | the same, with a red dot in the corner the pill leaves clear                              | 16, 32     |
| `assets/overlay-alert.png`           | the Windows taskbar's badge: a red dot                                                    | 16         |
| `web/public/icon.svg`                | the favicon and the manifest's icon: the tile                                             | any        |
| `web/public/icon-maskable.svg`       | the manifest's maskable icon: full bleed, the mark at three quarters inside the safe zone | any        |

`Mark.tsx` carries its own copy of the paths (inline, so it takes the colour). `web/test/mark.test.ts` fails when it or
any SVG above differs from the master. The manifest's colours are Light's paper.

To change the mark: edit the master, run `npm run icons`, paste the paths into `Mark.tsx`, then look at the icon sheet
([Checking a design change](#checking-a-design-change)).

## The visual system

Ink and pencil on calm paper; colour only where it carries information; the accent on calls to action.

Tokens live in `web/src/styles.css`:

- Light on `:root`.
- Dark under `prefers-color-scheme: dark` (System) and again under `[data-theme="dark"]`. Keep the two identical.
- One `[data-theme]` block per other theme.
- `src/themes.ts` holds each theme's paper and pencil, which the desktop window and `index.html`'s pre-paint use before
  the CSS loads.

| Token                                 | Role                                                                                                  | Light                           | Dark                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------- |
| `--paper`                             | the canvas: the page and its head                                                                     | `#f5f6f8`                       | `#14171c`                       |
| `--sheet`                             | a panel: a list page under its head, the list beside a review, menus, bubbles                         | `#fff`                          | `#1b1f26`                       |
| `--wash`                              | a quiet fill: the filter, loading bars, your words in the chat, an off switch's track, a greyed field | `#edeff2`                       | `#242a33`                       |
| `--ink`                               | text                                                                                                  | `#20242c`                       | `#eceff4`                       |
| `--ink-2`                             | strong secondary text: the sidebar's pages; an on switch's fill                                       | `#3d4450`                       | `#c9cfd9`                       |
| `--pencil`                            | secondary text: a row's facts and its label, the sidebar's footer                                     | `#5c6573`                       | `#a7b0be`                       |
| `--faint`                             | the quietest: separators; never text                                                                  | `#979eaa`                       | `#6b7482`                       |
| `--rule`, `--rule-strong`             | a hairline, a firmer one                                                                              | `#dde1e7`, `#c9ced6`            | `#343b46`, `#424a57`            |
| `--control`                           | a control's necessary edge (a field, a switch, the fold button's ring)                                | `#7c8798`                       | `#6b7686`                       |
| `--sel`                               | a selected thing's fill outside the tables (the PR on screen in a stack, the file you're in)          | `#eef1f4`                       | `#222830`                       |
| `--side`, `--side-hover`, `--side-on` | the sidebar, under the pointer, where you are                                                         | `#eff1f4`, `#e7eaee`, `#dfe3e8` | `#111419`, `#1c2027`, `#252b34` |
| `--red`, `--red-wash`                 | failing: CI failing, a high risk, sync failed, desk offline, your agent can't run, Connect failed     | `#b42318`, `#fcebe9`            | `#ffb4ab`, `#3b2421`            |
| `--amber`, `--amber-wash`             | caution: changes requested, a merge conflict, a medium risk                                           | `#8a4b08`, `#faefdf`            | `#ebc076`, `#33291b`            |
| `--green`                             | done or fine: a low risk, what you did in a review ("✓ Approved")                                     | `#176847`                       | `#8dceaf`                       |
| `--go`, `--on-go`                     | Approve and Hand off for merge, filled                                                                | `#176847`, `#fff`               | `#8dceaf`, `#0e2419`            |
| `--accent`, `--on-accent`             | the one call to action to press, filled                                                               | `#365d60`, `#fff`               | `#a8cacb`, `#162b2d`            |
| `--accent-ink`                        | links, the focus ring, a row's tinted call to action, the Agent label on a question's page, the mark  | `#365d60`                       | `#a3c5c7`                       |
| `--accent-wash`                       | a row's tinted call to action                                                                         | `#d5e8e7`                       | `#243a3d`                       |
| `--shadow`                            | only what lies over the page: menus, toasts, bubbles, the chat over a narrow page                     | ink at 6 % and 12 %             | black at 35 % and 50 %          |

- **Colour carries information.** Red fails, amber cautions, green is done or fine, always with words ("CI failing",
  "changes requested"). The brand colour never stands in for them. Everything else is ink and pencil, including what a
  Merging row waits on and an AI review's or the judge's failure (it's about the agent, not the PR).
- **Type.** Instrument Sans for the UI, JetBrains Mono for code, both bundled. Sentence case, no all-caps, no monospace
  outside code.

  | Text                                  | Size                     |
  | ------------------------------------- | ------------------------ |
  | a row's title (`--title-size`)        | 15px                     |
  | a row's facts (`--meta-size`)         | 13px                     |
  | the sidebar's items                   | 13.5px                   |
  | the PR, Issue or Question label       | 11.5px semibold          |
  | a head's name                         | 15px semibold            |
  | a plugin part's Automations heading   | 15px/650                 |
  | a Settings view's name                | 18px/650                 |
  | a Settings label, its help            | 14px/550, 13px           |
  | the heads in Searches and rules' rail | 14px/650                 |
  | a review's title                      | 22–26px, with the window |

- **Selection.** The table row you opened, right-clicked or Tab-focused gets a quiet fill (Light and Dark: `--side-on`
  mixed into `--sheet`; other themes: `--ink` mixed into it) and a 2px `--accent` mark at its leading edge, down the
  whole row. A tinted call to action on a selected row gets an `--accent` edge, since in some themes the fill is as dark
  as the wash. Nothing is selected when a page opens.
- **Focus.** Keyboard focus on a row is a 2px `--accent-ink` ring, selected or not. Elsewhere `:focus-visible` is a
  1.5px pencil outline.
- **People.** A GitHub person in a row's "by" column, a review's head, a conversation or the Reviewers part has their
  picture before the name: `Avatar` (`web/src/components/Avatar.tsx`), round, sized to the words (16px at 13px), no
  ring, inside the column so columns still line up. None for you, a bot, a team or an agent's session. One that doesn't
  load disappears and reserves nothing. It's `avatars.githubusercontent.com/<login>?s=40`; the shots serve these
  themselves (`offline()` in `scripts/shots.ts`), with one login failing.
- **Space and shape.** The 4px base (8, 12, 16, 24, 32) where you touch spacing; don't restyle what you don't touch.
  Controls take 7–9px corners. A list has none: it runs edge to edge.
- **Motion.** A spin while syncing or sending, a slow breath on loading bars; none under reduced motion.
- **A new theme** is a row in `src/themes.ts`, a block in `styles.css` that sets every token, and its id in
  `index.html`'s pre-paint list. `web/test/themes.test.ts` holds the three together and every theme to contrast floors
  (ink 10:1 on the sheet, secondary text and labels about 4.5:1, a hairline seen but quiet). Tune the colour, never the
  test.

## The layout

No top bar: the sidebar is the window's only global chrome, and each page has its own head.

```
┌──────────┬──────────────┬────────────────────────────────┬────────────┐
│ ▬ Inbox  │ Inbox 21  ‹› │ ‹ Inbox                        │ Your agent │  the heads: 52px, sticky, drag handles
│          ├──────────────┼────────────────────────────────┤            │
│ Inbox 21 │ Title, two   │ api#4154 by priya              │            │
│ Blocked  │ lines at most│ Planner: hash join stage       │            │
│ ──────── │ PR · api#41… │ …                              │            │
│ Merging  │              │                                │            │
│ Archive  │              │                                │            │
│          │              │                                │            │
│ Ask …    │              │                                │            │
│ Settings │              │                                │            │
└──────────┴──────────────┴────────────────────────────────┴────────────┘
  sidebar    the list beside  the page's column               the chat
             a review
```

| Region                                            | Width                                                                                                                                                                               | Scrolls                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| The sidebar (`Sidebar.tsx`)                       | 200px; 148px at 641–1000px; one row across the top at 640px and below                                                                                                               | inside itself; sideways in its row |
| The list beside a review (`Beside.tsx`)           | 320–360px (28vw), or as wide as you drag its edge (260px to half the window, kept per device); folded, nothing but its button; only for a review or a question, at 1160px and wider | inside itself                      |
| The page's column (`.col`, `PageHead.tsx` on top) | the rest: a list edge to edge, a review with the page's padding, Settings 760px, Searches and rules 1180px, a question 880px                                                        | the window                         |
| The chat (`Chat.tsx`)                             | 320–420px (25vw): a third column above 1100px, over the page's right edge at 1100px and below                                                                                       | inside itself                      |
| A review's sidebar (`.rv-side`)                   | 280px beside the diff while the page's column is 1000px or wider (container query `pane`), else over the diff's edge; its toggle is pinned                                          | inside itself                      |

### The sidebar

- The brand row: 52px, the desktop app's drag handle, 86px of left padding for the macOS traffic lights.
- The pages: Inbox with its count, Blocked, a hairline, Merging, the Archive (⌘1 to ⌘4). FYI is a section of the Inbox,
  not a page. The pill marks only where you are.
- The footer, bottom up: Settings, the update line (only when a newer Inbox exists), Ask your agent ("Ask" at
  641–1000px).
- In Settings the sidebar lists Settings' parts in the pages' place, under a quieter **‹ Inbox**: the core's, then the
  plugins' under a hairline. The part you're on has the neutral pill. No tabs.

### The page's head

- Sticky, 52px (as tall as the brand row and the list's head), on `--paper`, a hairline under it. It's a drag handle,
  its controls excepted.
- It holds only the page's own: a list's filter (on the rows' text edge), Merging's or a Settings part's name (on the
  rows' text), or Back for a review, a question or a Settings view ("‹ Inbox", "‹ Question", "‹ GitHub",
  "‹ Your automations").

### A list page

The Inbox, Blocked, Merging and the Archive.

- One `--sheet` from the sidebar's divider to the window's edge, like the list beside a review: no side borders, no
  corners.
- Hairlines between rows and above and below the table (none right under the head, which has its own).
- The Inbox's sections (Urgent, Standard, FYI) and the other pages' groups have quiet headings on the rows' text,
  further from the table above than from their own rows.
- Rows, headings and the lines between them (Your agent, "n more reach you…") start on the head's padding:
  24px (12px at 640px and below; 16px beside a review). So the filter's edge, Merging's name and the rows' text make
  one line.
- Inside a table: below 760px the stage column goes (on your own row the stage takes the place of "by you"); below 620px
  who it's from goes (your own row's changes requested and handed back stay). A repo keeps 6 letters' room, a why 10.

### The list beside a review

- It's the page the review was opened from (a question's is the Inbox), from the same data: its order, its groups'
  headings and its filter.
- Two lines a row: the title, cut at two lines; then one pencil line. When that line is short of room, a long repo
  gives way first, then a sorted-away row's why, then the last fact, each to a few letters, never to a bare ellipsis.
  At most one indicator, the call to action before the age so ages end in one column.
- **The fold.** A chevron on its right divider just under the heads (on their hairline where the list starts with a
  row, as the Inbox and Merging do). Always there, a 28px target across the divider, clear of both heads and of Back.
  Labelled "Hide the list" / "Show the list", with `aria-expanded` and `aria-controls`. Folded is kept per device
  (`desk.list`).
- With the chat open in a window under 1600px it folds away without changing that saved choice.
- **It's a sibling of the page's column in `App.tsx`, never wrapped round the review.** Why: folding, a resize or the
  list coming and going must never redraw or refetch the review. Keep it that way.

### Bubbles

What's wrong with the system (`Bubbles.tsx`; which conditions and words: `web/src/notices.ts`).

- A stack at the window's bottom right, 16px in, 340px wide or what the page's column leaves, left of the chat when
  it's open.
- The page's bottom padding grows by the stack's height (`--bubbles-h`), so its last rows scroll clear.
- Each is a `--sheet` panel with a hairline and `--shadow`: its title in ink 13px/600, its words in pencil, a 7px dot
  before the title as the only colour (`--red` failing, `--amber` a caution, none for news), its one fix as the tinted
  call to action, and a pencil × to dismiss.
- A failed action's title is its words at 500, fading over its last second.
- A toast centres on the page's column, clear of the sidebar, the list and the chat, and above the bubbles.

### Widths at a glance

| Window           | What changes                                                                     |
| ---------------- | -------------------------------------------------------------------------------- |
| 640px and below  | the sidebar is one row across the top; the page's padding is 12px                |
| 641–1000px       | the sidebar compacts to 148px; Ask your agent reads "Ask"; the mark stands alone |
| 1100px and below | the chat lies over the page                                                      |
| 1160px and up    | a review or a question keeps its list beside it                                  |
| under 1600px     | the chat folds that list away                                                    |

### Scrolling

- The window scrolls the page, so the heads stick, `scrollIntoView` works and the shots' scroll checks hold.
- The sidebar, the list, the chat, a review's sidebar and the rules editor scroll inside themselves. The editor's foot
  (Save and the rest) sticks to the window's bottom while the editor runs past it.
- Code wraps. Nothing scrolls the page sideways (the shots fail on it).

### The desktop app

- At least 760×500 (`electron/main.ts`).
- On macOS the traffic lights sit at 18,19 in the sidebar's brand row. No control may sit under them at any width (the
  mac shots check).

## The kit and the desk

How the inbox design kit's information architecture maps onto the desk. It names no state, owner or action the desk
doesn't have.

| The kit                                               | The desk                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Inbox: needs a human decision                         | Inbox: three sections, Urgent, Standard and FYI, in the desk's order                             |
| In flight: delegated, or waiting on an external event | Merging (handed to your agent) and Blocked (waiting on another PR or a review)                   |
| History: completed, dismissed, superseded             | the Archive: done by you or resolved by the world; snoozed, muted and hidden by rules are groups |
| One readable reason for attention on each row         | a quiet why (`Card.reason`), its stage and its call to action; no AI gist or chips               |
| Sources and Settings under the navigation             | Settings in the sidebar's footer; GitHub and other sources are Settings parts                    |
| Navigation, queue and review side by side, always     | the full-width table with nothing open; the list beside a review once one is open, at 1160px up  |
| The navigation collapses to a 64px rail               | the sidebar compacts to 148px and keeps its words: the window names every action in words        |
| A separate Focus mode, a theme switcher in a bar      | not built: themes stay in Settings → This device                                                 |
| 14px titles, 80px rows                                | 15px titles; a table row is one line, a row beside a review two                                  |
| Six brand colours, petrol recommended                 | petrol for the mark, Light and Dark; no brand colour picker                                      |

## Taking in a design handoff

A handoff (a kit, a mock-up, a review of the window) is input, not law: it was likely made without this repository.

The `design-handoff` workflow (`.claude/workflows/design-handoff.js`, args `{ kit, notes? }`) does steps 1 to 4: it
reads the handoff as untrusted data, maps each recommendation by area, and returns the brief and the questions for the
owner.

1. **Read** all of it, then AGENTS.md's product principle and Rules, ui.md and this file.
2. **Map** every recommendation onto what the desk really has: its pages, sections and parts, a card's fields, its
   actions and their words. Write the mapping down, like the table above. Never invent a state, owner, progress or
   action: map it honestly to what exists, or leave it out.
3. **List the conflicts**: with the product principle (one line a row, no chips, every action a click named in words, no
   key named in the window), with the Rules, and with what already works. Put each to the owner as a decision, with its
   options and their costs. Never settle one yourself. Write the answers into the brief.
4. **Write the brief**: the owner's decisions, what changes and what stays in each area, starting values, and how it'll
   be checked. Where the brief and the handoff disagree, the brief wins.
5. **Build it in steps**, each committed with its tests, shots and docs:
   - the tokens (`styles.css`, `src/themes.ts`, `index.html`'s pre-paint, the desktop window's colours, with
     `themes.test.ts`'s floors held);
   - the shell and the content (the sidebar, the heads, the columns, the rows);
   - the assets (the master, `npm run icons`, `Mark.tsx`);
   - the verification below.

   Keep every existing word unless the change is about words. Move a shot's assertion with the control it checks;
   don't delete it.

6. **Update** this file, ui.md, README and AGENTS.md as each step lands.

## Checking a design change

A design change is never done from code alone. Look at the shots yourself, light and dark, and say what you didn't
verify.

The `design-check` workflow (`.claude/workflows/design-check.js`, args `{ base?, only?, dir? }`, `dir` for another
checkout) runs this list: the shots, a critic per group of states, a script for what the shots don't check, the diff
against the design rules, and a skeptic per finding.

### The shots

`npm run shots` drives Chrome against the mock and writes `.shots/` (`index.html` shows them all). The data is the same
on every run: it syncs only when a shot asks, never on a timer.

| Size | Window                                                                                                              | Which shots                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| wide | 1280×820                                                                                                            | all                                                                      |
| mid  | 900×700                                                                                                             | all                                                                      |
| min  | 780×600                                                                                                             | all                                                                      |
| mac  | 1280×820, the macOS app's shell with traffic lights (a stand-in bridge; only `status()` is faked)                   | all                                                                      |
| xl   | 1440×900                                                                                                            | `queue`, `settings-github`, the `beside-*` ones                          |
| zoom | 1280×820 at 200 % (640×410 at 2x); `zoom-512` is the Inbox at 250 % (512×328), its sidebar row scrolled to Settings | `zoom-queue`, `zoom-review`, `zoom-inquiry`, `zoom-settings`, `zoom-512` |

Each runs in light and dark. Each theme has `theme-<id>`, `-review`, `-ask` and `-inflight` at the four main sizes and
`-settings` at wide. Omarchy has `theme-omarchy` and `-review` (Hackerman, a theme the desk makes from its colours),
`-light` (a live switch to Nord, then Lupine) and `-settings`.

While iterating, `npm run shots -- --only queue,beside` runs the shots whose names contain one of those words.
`SHOTS_MOCK_PORT` and `SHOTS_VITE_PORT` keep two checkouts' runs apart.

### What to look at

For a change to the shell, the rows or the palette, run them all, then look at, in light and dark:

- `queue`, `review`, `beside-review`, `beside-folded`, `inquiry` and `settings-github` at each size;
- the `zoom-*` ones;
- `theme-<id>` and `theme-<id>-review` for at least three other themes: a light one, a dark one and one with its own
  diff colours (Sand, Slate and Gruvbox, say).

### The icons

`npm run shots -- --only icons` writes `icons-1x.png` and `icons-2x.png`: the Mark, the app icon, the favicon, the menu
bar's template (with a count) and the trays, at 16, 20, 24, 32 and 64px on the light and the dark sidebar. Judge the 1x
sheet at 100 %, the 16px ones above all.

### What the shots fail on by themselves

Every shot fails on: the page scrolling sideways, a key chip on screen, a console error, the sidebar's or a head's words
running past their edge, "Inbox" wrapping, a control under the traffic lights. Beyond that:

| Shot                                                                                      | Checks                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beside-review`, `beside-folded`, `beside-inquiry`                                        | the list beside: its width, the fold button's label, state and target, the row it marks                                                                                       |
| `beside-long`                                                                             | a long title: one line in a table, at most two beside a review                                                                                                                |
| `beside-keeps`                                                                            | the review, its typed comment and the file being read survive a fold, unfold and resize, with no refetch                                                                      |
| `beside-chat`                                                                             | the chat folds the list without touching the saved choice                                                                                                                     |
| `review-checks`                                                                           | checks closed to one line, in words and red; each check in words with a link, what's wrong first                                                                              |
| `review-panel`, `review-loading`                                                          | the sidebar's parts in order, a line each, no activity; its toggle works at the bottom of a long review; drawn while loading                                                  |
| `review-top`                                                                              | the top stays short; the empty comment box is one line; the first file within 386px of the top                                                                                |
| `review-comment`                                                                          | the box grows while the buttons stay put; Esc leaves it; its words survive the next item and back                                                                             |
| `zoom-*`                                                                                  | the sidebar as one row at 640px                                                                                                                                               |
| `queue`                                                                                   | no bubble while all's fine                                                                                                                                                    |
| `sync-limited`, `sync-failed`, `sync-offline`, `settings-github-error`, `queue-ai-paused` | each bubble's words, colour, fix and place; `sync-failed`'s Dismiss lasts a reload and returns when it recurs; `queue-ai-paused`'s none on Settings → Local Agent Integration |
| `bubbles-stack`, `bubbles-chat`                                                           | three in order, a failed action's fading, the last row clear of them; beside the chat                                                                                         |
| `queue-empty`, `later-empty`, `inflight-empty`, `queue-loading`, `*-bottom`               | empty and loading pages; every page ending near the window's bottom                                                                                                           |
| `first-sync`, `first-sorting`, their `-narrow`                                            | a new desk's first minutes: the desk's line, no empty line, above the first section                                                                                           |
| `setup`, `setup-github`, `setup-narrow`, `setup-done`                                     | the first-run page: no sidebar, its rows' words, one green Use while GitHub is signed in, none while not; Use lands on the Inbox                                              |
| `settings-nav`                                                                            | Settings' sidebar links, the head naming the part, a draft kept across parts, Esc, the way back                                                                               |
| `settings-github-automations`                                                             | GitHub's automations, their switches, a built-in's view and copy                                                                                                              |

### What they don't

Try these by hand against the mock (`MOCK_PORT=47824 node web/mock/server.ts`, then
`DESK_API=http://127.0.0.1:47824 npx vite --config web/vite.config.ts`), or script them with `page.route` as the shots
fake a slow desk:

- **The desk coming back**: stop the mock. The list stays and a bubble says the desk isn't running, with Retry (as
  `sync-offline` shows). It must go once the desk is back.
- **A failing sync** (`MOCK_SYNC_ERROR=1`): the "Sync failed" bubble with the error, the list kept, never an empty
  Inbox. Try again reads "Syncing…" until the sync fails again.
- **A refused write**: a bubble says why and the item comes back.
- **A refresh while you type a comment**: your words stay.
- **The keyboard alone**: Tab reaches a row and shows its ring, Enter opens it, Esc goes back.

### Then

- `npm run check`: with the lint and types it runs `web/test/themes.test.ts` (every theme's tokens and contrast) and
  `web/test/mark.test.ts` (one geometry).
- **Report** which PNGs you looked at, by name, and what you couldn't verify.
