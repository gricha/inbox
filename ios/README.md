# Inbox for iPhone (v0)

Your desk on your phone: the same lists as the window (Inbox, Blocked, Merging, Archive), read from the desk on your
computer over Tailscale. SwiftUI, iOS 17 or newer, iPhone only, no third-party packages. So far it has only run in the
Simulator.

The phone pairs as a **phone** (a bearer token the desk takes as its own window's, unlike a machine's, which is an
agent's). So it shows everything, it triages (Done, Snooze, Mute, Back on the desk, a move to another section, Undo),
it filters its lists, it writes and finishes your notes, and it does what an item is on your desk for: approve, comment
(on a PR, or on a line of its diff), reply, mark ready, ask reviewers, merge, hand off for merge, answer a question,
kick a session, wake your agent, ask your agent. See [What the phone does](#what-the-phone-does) and
[Not on the phone](#not-on-the-phone). A phone paired before this (as a device)
is still refused every write: disconnect it and pair again.

## Build and test

Xcode 26 is all you need; the project (`Inbox.xcodeproj`) is checked in.

```bash
cd ios
SIM='platform=iOS Simulator,name=iPhone 17 Pro'
xcodebuild -project Inbox.xcodeproj -scheme Inbox -destination "$SIM" -derivedDataPath .build build
xcodebuild -project Inbox.xcodeproj -scheme Inbox -destination "$SIM" -derivedDataPath .build test
```

Or open `ios/Inbox.xcodeproj` in Xcode and press Run. Use `xcodebuild`/`xcrun`, not a bare `swift` on your PATH.

The project is generated from `project.yml` with [XcodeGen](https://github.com/yonaskolb/XcodeGen)
(`brew install xcodegen`). After adding, removing or renaming a file: `cd ios && xcodegen generate`, and commit the
project with the change.

`npm run check` neither builds nor tests this folder (Prettier skips `ios/` too): the commands above are its check. The
tests (`InboxTests`) decode every response the app reads from saved copies of the mock desk's answers
(`InboxTests/Fixtures`: each the mock's answer to the read it's named for, saved with `curl` and indented four spaces;
`review-lean.json` is written by hand), hold the wording to the window's (`web/src/format.ts`, `notices.ts`), and run the client against
the desk's exact refusals through a stubbed `URLProtocol`. They never touch the network.

## Run it in the Simulator

Against the mock desk (fake data, nothing real is touched):

```bash
# in the repo's root; needs npm install
MOCK_PORT=47841 MOCK_NO_POLL=1 node --disable-warning=ExperimentalWarning web/mock/server.ts
```

Run the app, and on its first screen type `http://localhost:47841`. No code is asked for: the Simulator shares your
Mac's localhost, and the desk's own computer needs no token.

Against your own desk on the same Mac: start the desktop app (or `inbox serve`) and type `http://localhost:47823`.
Triage there is real: Done on the phone is Done on your desk (the toast's Undo takes it back).

A Debug build also reads launch arguments, for trying one state without tapping to it (none is saved; a Release build
ignores them):

```bash
xcrun simctl launch booted it.pstrucha.inbox -deskURL http://localhost:47841 -page merging
```

| Argument                                       | Shows                                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| `-deskURL http://localhost:<port>`             | that desk (localhost only), leaving the saved one alone                 |
| `-page inbox\|blocked\|merging\|archive`       | that page                                                               |
| `-open <owner/repo#n>`                         | an item's page; `-open inquiry:<id>` a question, `-open session:<id>` a session |
| `-scrollTo standard`                           | the Inbox scrolled to a section (`urgent`, `standard`, `fyi`); with `-page merging`, `work`: your agent's work |
| `-box approve\|comment\|changes\|reviewers\|reply\|answer` | with `-open`: that page's box, opened once the page has loaded |
| `-part checks\|reviewers\|files`              | with `-open`: that line of a PR's State, or the list of files (the guide's steps) above its diff, opened |
| `-scroll diff\|thread\|said`                   | with `-open`: a PR's page scrolled to its diff, the first thread on a line of it, or its Conversation tab |
| `-scroll guide\|step-<n>\|note`                | with `-open`: the guided review's first step, a later one (from 0), or the AI review's first note on a line |
| `-ai open`                                     | with `-open`: the AI review's fold, opened                              |
| `-review.view guided\|traditional\|conversation` | the diff's order where a review has steps, or the Conversation tab, for this launch (the saved choice is left alone) |
| `-part risk\|changes`                          | with `-open`: that row of a PR's Status, opened                         |
| `-said links\|none`                            | with `-open`: a PR's conversation as the mock never sends it: a bot's links and images, reviews' verdicts and a resolved thread added, or nothing said |
| `-approved`                                    | with `-open`: someone else's PR as if you'd approved its commit         |
| `-comment <path>:<line>`                       | with `-open`: the box for a comment on that line of the new file        |
| `-issue running\|again\|failed\|stale\|none\|off\|injection\|blocked` | with `-open`: an issue's pre-review in a state the mock never sends     |
| `-step <n>`                                    | with `-open`: an issue's walk at its nth step                           |
| `-chat <owner/repo#n>\|none`                   | Ask your agent, about that item or nothing                              |
| `-agent codex\|opencode`                       | with `-chat`: your agent as the desk would name another (its name, mark and menus); the mock's is Claude Code |
| `-asks empty\|off\|on\|waiting\|queued\|onit\|stopped\|error\|none` | with `-chat`: the chat as the mock never sends it: nothing asked, your agent off (`on`: drawn as on though the desk says off, so a send is refused), and each thing it can be doing about the last ask |
| `-filter "<text>" [-filterFocus]`              | the lists' filter as typed (`"author:dana "`: a term then a space is a pill); with the cursor in its box, so its suggestions show |
| `-note new\|<note id>`                         | the note box: a new note, or that one opened (the mock's are `n1`, `n2`, `n3`) |
| `-settings`                                    | the settings sheet                                                      |
| `-empty`                                       | the desk as if nothing were on it                                       |
| `-connect [-connectAddress <text>] [-connectError "<words>"]` | the connect screen, with that address and those words in red |
| `-connect -scan "<text>"`                      | the connect screen as if the camera had read that QR (the Simulator has no camera) |

## Look at it

```bash
ios/shots.sh                 # every state, light and dark, into ios/.shots/
ios/shots.sh inbox item-pr   # only these
```

It builds, installs on the booted simulator, starts the mock on port 47841 (and stops it), and writes
`ios/.shots/<state>-<light|dark>.png` for: `connect` (in the Simulator, Scan the code is off and says why), `connect-error`, `connect-scan-wrong` (a QR that isn't a desk's), `connect-scanned` (a desk's link read: its address, said before Connect), `inbox`, `inbox-scrolled`, `inbox-empty`,
`inbox-filter` (the filter's box with the cursor in it: Filter by person), `inbox-filter-author` (a pill and what it
keeps), `inbox-filter-large` (the same at an accessibility text size), `inbox-fyi` (FYI's first five and Show 3 more),
`blocked` (its tree's guides), `blocked-filter` (flat, "4 of 11"), `merging` (your agent's line with Wake it), `merging-filter` (its rows a filter keeps),
`merging-work` (Claude's work: two reviews being written, your ask, a failed review with Try again, an answer nobody
picked up), `chat` (Ask your agent: Claude Code's name and mark, your asks and its answers, what it's said so far and
what it's on under the last, how it runs by Send), `chat-item` (about a PR: its ref and ×, your agent's open question
above the box), `chat-empty` (nothing asked: the box takes the page), `chat-off`, `chat-stopped` (Wake it),
`chat-codex` and `chat-opencode` (their names, marks and words for how they run; no effort on OpenCode), `chat-large`
(an accessibility text size: how it runs takes a line above Back and Send), `archive`,
`archive-filter`, `note-new` and `note-edit` (the note box), `item-pr` (its verdict's tag, the AI review folded, its Status; Approve), `item-pr-status` (the risk opened), `item-pr-approved` ("✓ You approved" on the bar), `item-pr-viewed` (a file viewed: folded, ticked, "1 viewed"), `item-pr-ai-open` (a
review with a goal, its fold opened), `item-pr-guided` (a step of the guide, its diagram as text), `item-pr-guided-note`
(Look here and a potential bug under their line), `item-pr-guided-end` (the last step, its test file folded, the guide's
end), `item-pr-ai-stale` (on an earlier commit, a new one being written), `item-pr-ai-failed` (Try again),
`item-pr-ai-running`, `item-pr-ai-none` (Ask Claude for one), `item-pr-guided-large` (a step at an accessibility text
size), `item-pr-checks` (a failing
run, its checks opened), `item-pr-own` (your PR: who reviews it, + Add reviewers), `item-pr-diff` (its diff in Code changes, from the first file), `item-pr-files` and `item-pr-steps` (the list of files, or of the guide's steps, opened above it),
`item-pr-diff-thread` (a thread under its line), `item-pr-line-comment` (the box for a comment on a line), `item-issue` (its pre-review; Make PR with fix), `item-issue-step` (a walk at its second step; Comment), `item-issue-injection` (a flagged one: Block), `item-issue-none` (Analyze it), `item-issue-blocked` (Unblock), `item-issue-large` (the walk at an accessibility text size), `item-reply` (what
waits on your reply, each with your agent's read, on the Conversation tab), `item-pr-conversation` (a bot's links and images as words, reviews' verdicts, a resolved one as a line), `item-pr-conversation-none`, `item-draft` (Ready for review; its description's first paragraph where a review would be), `item-mine` (Hand off for merge), `item-merging` (Back to desk),
the boxes `approve`, `reply`, `reviewers` and `answer`, `question`, `session`, `session-kick`, `item-large` and `item-largest` (accessibility
text sizes, AccessibilityL and XXXL, where the bar's quiet buttons fold into More and the longest call to action keeps its words), `settings` and `offline` (a desk that isn't
there). People's pictures are asked of GitHub by login, and the mock's logins (dana, marco, priya) are real accounts'
names: a shot shows whoever owns them, or nothing when GitHub can't be reached. It won't shoot while something already answers on that port (a mock you started by
hand has whatever you did to it since): stop that first, or set `SHOTS_PORT`.

Look at them after any change here, as `npm run shots` is looked at for the window: clipped or cut text, weights (a
title is 500, a heading 650, a row's facts 400), the facts line when it runs out of room, both appearances, and the top
and bottom edges: an opened page has no navigation bar, so its first line sits under the status bar and its bar at the
foot stays on one line. What a shot can't show (the page menu with New note and Ask your agent, which reads "Your agent · waiting" while your
latest ask has no answer; a send and its answer landing, Copy on a code block, the chat's ×, its menus open, Another
model…'s field, a pick saved or refused, Expand the box, an answer's long press, a row's swipe and long press and each entry of its menu, the More
menu, Show more, a pick from the filter's suggestions and Backspace on a pill, the reminder's menu and its date picker,
Wake it, a write and its toast or refusal, the toast's Undo, pull to refresh, and the swipe back from the left edge on each opened page, which
`Views/Acting.swift` keeps alive with the bar hidden), try by hand against the mock.

## Test mode

**Try test mode**, under Connect on the connect screen, shows the app with no desk: made-up pull requests, issues,
questions, sessions and notes, the mock desk's (`web/mock/server.ts`), recorded into `Inbox/Demo.json`. It's what App
Review sees. Every request goes to `DemoDesk` (`Inbox/Demo.swift`), a `URLProtocol` on its own session for the address
`https://test-mode.invalid`, so nothing leaves the phone. Its times move on to now; a write (Approve, Done, Merge, an
answer, Hand off) takes the item off the lists, Undo puts it back, a note shows in its section, and an ask is answered
at once with a line saying no agent runs here. Toasts say "in test mode" where they'd say "on GitHub", and nobody's
GitHub picture is asked for. Settings → **Leave test mode** goes back to the connect screen; a fresh launch starts the
made-up desk afresh. `ios/testflight.sh` records it afresh for each upload (`npm run ios:demo`) and puts the committed
copy back, so an upload always has today's mock; the committed one is what tests and shots use. Shots: `test-mode`,
`test-mode-settings` (`-deskURL https://test-mode.invalid`).

## On a real phone

Not tried on a phone yet: v0 has only run in the Simulator, and the project has no signing team set. When you do:

1. On the desk's computer: Settings → Tailscale → **Use it from your other devices** (or `inbox serve --tailscale`).
   The desk then answers at `https://<machine>.<tailnet>.ts.net` on your tailnet only. It needs the `tailscale` command
   on the desk's PATH.
2. On the phone: Tailscale on, signed in with the **same login** that owns the desk's computer.
3. On the desk's computer: Settings → Network → **Pair a device**. It shows a QR, the address and a code (one try,
   10 minutes).
4. In the app: **Scan the code** and point it at the QR. Scan it in the app, not with the phone's Camera app, which
   opens the link in Safari and spends the code there. Or type the address and the code (`inbox pair` prints both), or
   paste the whole link (`https://<name>/pair#<code>`) into the address field.

Scan the code takes only a link shaped like a desk's pairing link (`https://<any name>/pair#<code>`): any other QR is
said to be none, in red under the viewfinder, and nothing is asked of anyone, so no try is spent. A link of that shape
closes the sheet and still sends nothing: the address it named is in the field, with "Scanned the pairing code for
<name>. Connect pairs this phone with that desk." under it, since a QR can name any address and whatever answers
there would be shown as your desk. **Connect** then trades the code, once; changing the address drops the scanned
code. A refusal (a used code, Tailscale off) shows on the connect screen with the address kept and the code field
empty for a new one. The live
camera, iOS's ask for it and the screen for a camera that was refused can't run in the Simulator, which has no camera:
only what happens with what was read is tested (`-scan`, `AddressTests`, `StoreTests`).

The app trades the code once for a token and keeps it in the Keychain (this device only); the address is in
UserDefaults. Settings → Disconnect forgets the token on the phone. The device stays listed on the desk until you revoke
it there (Settings → Network): if you do, the phone's next request is refused and it goes back to the connect
screen.

Checked in the Simulator on the desk's own Mac, through a desk served at its tailnet address, when the app still paired
as a machine (kind `device`): pairing with the link, the token on every read, a desk still starting (503, in its words)
and the event stream, which `tailscale serve` passes through as it comes. Not yet checked through a real tailnet:
pairing as a phone (kind `phone`) and any write with its token; `test/remote.test.ts` holds the desk's side of both, and
the app's writes are checked against the mock. The first request after serving is turned on can time out once, while
Tailscale gets the address its certificate: Connect again with the same code, which an unanswered try doesn't burn.

A phone paired by a build that paired as a machine holds a token the desk refuses every write: at its next launch the
app forgets it and asks to pair again (revoke the old pairing in Settings → Network).

## TestFlight

`ios/testflight.sh` archives a Release build, signs it and uploads it to App Store Connect, where it shows under
TestFlight once Apple has processed it. The build number is main's commit count; the version testers see is
`MARKETING_VERSION` in `project.yml`. `ONLY_ARCHIVE=1` signs an `.ipa` into `.build/testflight/` and sends nothing.

Done for this app: the record is **Inbox Review Desk** (`it.pstrucha.inbox`), its TestFlight internal group Team gets
each upload by itself, and Test Information holds the review notes below. For another team, once, before the first
upload:

1. **The app's record.** App Store Connect → Apps → + → New App: iOS, a name (shown on the App Store and in TestFlight;
   "Inbox" alone is likely taken), the bundle ID `it.pstrucha.inbox` (the first `ONLY_ARCHIVE=1 ios/testflight.sh`
   registers it, so the list offers it), any SKU.
2. **Signing.** Either stay signed in to Xcode with the Apple ID of the team (Settings → Accounts), or make an App Store
   Connect API key (Users and Access → Integrations, App Manager) and pass `ASC_KEY_ID`, `ASC_ISSUER_ID` and
   `ASC_KEY_PATH`. The first archive makes the team's distribution certificate and profile.
3. **Run it.** The team is the owner's (`GYRQ5A56S5`) unless `TEAM` says another:

   ```bash
   ios/testflight.sh
   ```

Testers in your own team (internal testing) get it at once. Anyone else (external testing) waits for Beta App Review,
which signs in with nothing: tell it, under TestFlight → Test Information → Beta App Review Information, "No account is
needed. On the first screen, press Try test mode (under Connect): the app then shows made-up pull requests, issues and
questions, and nothing leaves the phone. Connecting to a real desk needs the desktop app on the owner's computer and
Tailscale." The App Store itself also wants a privacy policy URL; the app collects nothing (`Inbox/PrivacyInfo.xcprivacy`).

What's set for it: `ITSAppUsesNonExemptEncryption` false (HTTPS only, so no export questions), the privacy manifest
(UserDefaults, for the desk's address), `UIRequiresFullScreen` (portrait only), and the 1024 icon with no alpha.

## What the phone does

A paired phone is your hands like the window (`fromDesk()` in `src/server.ts`; README → Safety). An opened page has one
bar at its foot: Back, More, Snooze, Done, and the one call to action the item is there for, in the window's words.
Approve and Hand off for merge are filled green, as the window's; every other call to action is the accent. When they
don't fit on one line Snooze, then Done, fold into More (at the default size only beside the longest name, Hand off for
merge, where Snooze does); More is its three dots only where it doesn't fit even alone beside the call to action.

- **A PR or an issue.** The row's own call to action (Ready for review, Add reviewers, Reply, Hand off for merge); else Approve on
  someone else's PR, Comment on an issue, Hand off for merge on yours once it's through review (`Card.act(open:)`). Open
  means open on GitHub, as the window's review: a PR the desk resolved while it's still open ("approved by alice", "no
  longer requested"), opened from the Archive, can still be approved and commented on. In
  Merging the bar has Back to desk. More has Mute, Comment, Add reviewers (on your draft: Ready for review, asking
  reviewers, which marks it ready and asks them in one go), Hand off for merge, Ask your agent; under On GitHub the
  writes the desk allows now, as the window's More (`Card.actions` less convert to draft, ready and reopen: Close,
  Merge now, Request changes, Re-request review, Remove me as a reviewer); then Open on GitHub and Copy GitHub link. Approve, Merge and Request changes are pinned to the commit the page last drew (`Store.pins`, moved by every
  review that lands, as the window since 9f5819a): a push the page redrew is yours to approve, one it hasn't drawn yet
  the desk refuses, its words kept in the sheet. Approve's and Request changes' boxes hold the commit that was on
  screen when they opened (`ItemPage.pinned()`): the page reads on under a sheet, so a push that lands there is
  refused however often the button is pressed, until the box is closed and opened on what the page now shows. Whether you may approve is the desk's say (`approve.ok`): once you've
  approved its commit (`approve.approved`) the bar says "✓ You approved" in Approve's place; any other no on an open
  PR leaves Approve off and the page says why ("Can't approve: it's closed.").
- **The AI review.** As the window draws it. Its verdict is a tag at the end of the header's facts, filled in the
  colour of how much it asks of you (Look closely red, Skim it amber, Skip it green, its words the sheet's colour),
  "on an earlier commit" after it when a push has left it behind; its risk is Status's. Its goal leads, in ink (an
  older review without one leads with its summary's first sentence). Then "In the stack" and "Not quite what the
  description says", each name on a line of its own. The rest is folded: its first lines show and fade out into
  **Show more** (in the accent), which opens the summary, "Also risky", Interfaces (each name, what changed,
  "breaking", what it means; a press goes to its line of the diff), Could be better, and a diagram no step draws;
  **Show less** under it folds it again. Every PR opens folded, and the preview takes no presses. "Since your review"
  is never folded. Its concerns are listed only when they can't sit in the code (a
  review of an earlier commit, or one with no notes). While one is written: "Claude is reviewing it. The notes land in
  the code below in a minute or two.", later with how long and which try. A failed one says why and when your agent
  tries again, with **Try again**; an open PR with none has **Ask Claude for one**; a closed one says "No AI review."
  Both ask your agent, so they spend it: only a press does (`Store.askReview()`), never opening the page. The words
  "Claude is reviewing api#4127." show at once, the desk's events redraw the page, a second press meanwhile does
  nothing, and only the desk's own refusal is a bubble (its answer comes when the review is written, minutes later,
  so nothing waits for it). A PR in Merging has neither link: it's your agent's. Your own PR shows this only once a
  review exists, is being written or failed. All of it is the model's words: plain text, a URL never a link.
- **A PR's Status.** Under the AI review, as the window's sidebar: a row each, what it says on the left and its
  measure on the right, a press showing what's behind it. **Risk**, with an AI review: "Low risk", "Medium risk" or
  "High risk", with the rows' signal on the right (one red bar for high, two orange for medium, all four green for low), opening to its reasons (or "No
  reason given."). **Checks**: "Checks passing", "Checks running", "Some checks failing" (an optional one failing or
  one cancelled) or "Checks failing" (a required one), and how many pass of all ("10/11", the first number in its
  colour); it opens to each by name, shards of one check folded into one row, the passing ones behind "N more
  passing" past six rows; a check opens its page ("Checks couldn't load" and why, when GitHub wouldn't give them).
  **Changes**: "Small changes" (up to 100 lines in up to 5 files), "Moderate changes" (up to 600 in up to 20) or
  "Lots of changes", with its + and −, opening to its files, lines added and lines removed. Then Reviewers (amber on
  changes requested), Merge (what stands in its way) and, with no stack, Depends. Reviewers opens to who and where
  each stands, each with their picture, yours too; on your open PR each person has one action, a trailing button and
  the same in the row's long press: **Remove** (× , asked and hasn't reviewed) or **Ask again** (↻, reviewed; not on a
  draft), through `POST /api/review/:id/reviewer`. A team has none. + Add reviewers is there on your open PR that's
  ready. Under the title, the reviewers with a verdict: a green tick, or "changes" in amber. Your own PR with no AI review shows its
  description's first paragraph there instead. A diff or a conversation that couldn't load says so in its place. A PR in a stack lists it
  under its Status, as the window's timeline: "Stack on main", its open PRs bottom first, a node each on a pale line,
  this one's node in the accent and its title in ink (a red ✗ for CI failing, "changes" in amber or a green ✓ only
  where that's news); a long stack shows four around this PR and "16 more" (Fewer), and the
  stack's other branches come under "Other branches" (`Stack.around()`). A press opens that PR.
- **Review, Code changes and Conversation.** Tabs under the stack, as words, the one you're on in ink with a
  rule under it: a review with steps reads two ways, the choice kept on this phone (`review.view`), Guided first; a
  review without steps has Code changes and Conversation. Conversation (with how many wait on your reply) holds what
  reviewers said in the diff's place; a PR opened to reply, and the bar's Reply, open on it. Guided is only the review's steps: "2 of 4" and the
  step's title, its words, "Check:", its note, its diagram, then its sections, each under Look or Skim and why; at its
  foot "Next: …", which goes to the next step, and after the last "End of the guide. 3 more files change outside it:
  read every file in Code changes". A potential bug no step covers still shows, under "Potential bugs outside the
  guide". A test file starts folded there. A diagram is its title, its caption and one line per edge or message
  ("Dispatch (new) → Lease (new): lease()"): the window's own fallback, never a figure.
- **The AI review in the code.** In either order its notes sit under their lines, in the sans face with a rule down
  the margin; the first of them are its concerns, each headed "Potential bug" with an amber edge. A note about the
  whole file (or on a line the diff doesn't show) sits above the file's lines. "Look here, lines 12–14:" marks where
  correctness hinges; a review of an earlier commit marks nothing.
- **Its files, to go to.** The diff's heading ("5 files changed") opens the window's list of files in place: each
  file once in reading order, its level (Look, Skim), a dot where the AI review has notes in it and a tick once
  you've viewed it ("5 files changed · 2 viewed"), then "Not worth reviewing · N files"; a press goes to it. In Guided the same heading lists the guide's steps ("2 of 4" and the
  title) instead, as the window's steps take the files' place (`DiffModel.stops`).
- **A PR's diff.** Under its State and stack, every file once in the PR's order (the window's Code changes), each under
  a header that folds it and stays at the top while its lines scroll: the name with its folder cut from the head, the
  lines added and removed, and under it new, deleted or renamed from where. Lines are unified and wrapped, never
  scrolled sideways (that would fight the swipe back): the new file's number (the old one on a removed line), the
  sign, the text, a faint green or red behind what was added or removed. At the header's right, **Viewed** (a 44pt
  box), as GitHub's: ticked, the file folds and every one of its hunks' marks goes to the desk (`Store.markViewed()`,
  kept in the desk, nothing on GitHub); a file all of whose marks are viewed opens folded, and a press on its header
  opens it for now; unticked, it opens. A push that rewrites one of its hunks unticks it. In Guided the box is on each
  section of a step, as the window's. The tick shows at once and stays until a read agrees (`ItemPage.marking`). Then the files the desk folded away, under
  "Not worth reviewing · N files", each with why (a lockfile; no text diff). A file's first 400 lines are drawn, the
  rest are on GitHub; past about 3,000 lines in all, every file starts folded. A review thread sits under its line
  (not an outdated one), drawn as under "What was said", with Reply and Open on GitHub; a resolved one is one line until pressed. On an open PR, press a
  line to comment on it: a removed line's comment goes on the old file's side, any other on the new one's. One line
  only, pinned to the commit the diff was at when the line was pressed (a push read under the box doesn't move it). The box's Ask your agent opens your chat on that line instead (your
  comment's words stay in the box). Your words show under the line as "You · sent" until the conversation
  read again has them. Code stops growing at the first accessibility text size; what people said grows on.
- **What reviewers said.** The Conversation tab, as the window's (`Conversation.tsx`): "Waiting on your reply N",
  then a card each, those waiting on you first and edged in the accent. Every comment is unfolded, a hairline between
  them: the author's picture (yours too; none for a bot), when, and on the first where ("src/auth.ts:42",
  ", outdated"), "resolved", or a review's "Approved" (green) or "Changes requested" (amber); then the words. One
  waiting on you has your agent's take with its call in bold, "<agent> is reading it." or why it couldn't. Then
  "Reply sent." once you have, Open on GitHub and Ask your agent; then, on an open PR, a row with your picture and
  "Reply to azulus…" that opens the reply sheet. A resolved one nobody waits on you for is one line (who, where,
  "resolved", how it began) until pressed. Nothing said: a dashed box, "No conversation yet", "Comments and review
  threads on this PR show here." At the tab's foot on an open PR, "Comment on api#4127…" opens Comment's box. A thread
  gets a thread reply, a comment or a review a comment on the PR; a closed PR takes none. Nothing resolves a thread
  from here: "resolved" is only said. After a reply the page stays and reads the review again; until then your words
  show as "You · sent"; it leaves the page only when the desk took the PR off (`Store.left()`: a reply was all it
  asked of you and this was the last one waiting). The bar's Reply answers the first one waiting; a draft is kept per
  conversation. A comment is drawn as the window's `SaidText` (`Blocks.said()`, the twin of `saidBlocks()` with
  labels): paragraphs, lists, bold, `code`, a fenced block on the sheet with Copy, a `<details>` folded under its
  summary until pressed, a paragraph in `<sub>` as small print, HTML comments gone. A link (`[words](url)`, `<a
  href>`, a bare https URL) reads as its words, underlined, and an image (`![alt](url)`, `<img>`, a `<picture>`'s) as
  its alt, a linked image as a link in its alt: nothing opens from the words, and a long press on them offers Copy
  link (only https, no userinfo). Images aren't drawn. Any other tag is left as the text it is. The reply box's quote
  stays plain text, cut to a few lines.
- **An issue's pre-review**, as the window's (`IssuePre` in `Detail.tsx`), under why it's here: "A bug." (a feature
  request, a question, an issue) and its summary; whether it was read from the code in your clone or the issue's text
  alone; What's wrong, Cause, where in the code (`path:line` and why), The fix (or What we'd do); then its walk, one
  step at a time with Back and Next. Above it, where it stands: your agent is reading it (again), it failed (Try
  again), it was written before the issue's latest activity (Read it again), None yet (Analyze it); nothing when AI
  reviews are off and none is written. A fix your agent can make on an open issue puts Make PR with fix on the bar
  (Comment moves to More); once taken, the bar is Comment again, so a second press can't ask twice. A possible prompt
  injection shows the flag in red and nothing else of the review: the bar's call to action is Block @who (their items
  are muted on your desk; nothing on GitHub), and "Not an injection: analyze it" reads it anyway. A blocked author's
  issue says so, with Unblock. The facts line adds how you were asked (unless the why says it) and who placed it.
- **A question.** In the window's order: "Agent" and who asks, the question, what it's about (a press opens the item
  here, or on GitHub when the desk doesn't hold it), everything the agent said and its links, then its answers, each a
  button that answers with it. **Answer**, on the bar, opens the box for your own words ("Or write your own answer",
  2,000 characters at most, as the desk takes; its button is Send); Dismiss lets the agent decide. After any of them
  the page stays, as the window's: "✓ Answered: …" (or "✓ Dismissed: it decides itself") and "Not picked up yet" until
  the agent reads it. Its row's
  menu: Answer, Dismiss.
- **A session.** Kick or Resume (off until a rate limit resets), Done and Snooze; Mute is in More. Its whole folder is
  under its name. Its row's menu: Done, Snooze (a time: a session has no activity to wait on, and its toast says only
  the time), then Kick or Resume when that's its first action.
- **The lists.** As the window's, in the desk's order.
  - **A row**, as the window's two-line row: what it is as an icon (a PR, an issue, a question, a session, a note), then
    its title; under it its ref and why, and on the right its call to action as a small tinted button (a press on the
    row opens its page, whose bar has it), the quick bolt, a PR's signal, who it's from as their picture alone (yours
    too; a small robot for a bot's own PR or an agent's question, a clock for a note's reminder) and its age. The
    signal is four bars (`Views/Signal.swift`, RowIcons.tsx's `Signal` and `factsOf()`): one lit for each of its stage
    (on the Inbox), CI, the AI review's risk and its size with nothing against it, all lit in one colour by how many
    (one red, two orange, three yellow, four green). A phone has no hover: VoiceOver reads its facts ("Approved. CI
    passing. Low risk, skip it. Tiny change").
  - **The filter**, on all four pages (one filter, as the window's search): a box under the
    page's name. Words match a row's title, repo, author or ref. `author:dana` keeps who opened it (a bot's PR counts
    as the person it was opened for; `author:you`, yours) and `involves:dana` anyone on it. A term followed by a space
    is a pill, drawn as words ("Author dana ×"): a press on it, or Backspace at the box's start, takes it off; Clear
    empties the box. With the cursor in an empty box, "Filter by person" offers Author and Involves; a typed name
    offers up to four people as Author (if they wrote a row) and as Involves; after `author:` or `involves:`, up to
    eight people, you first (picked as `you`), then most rows first. While filtering: a group with a match opens (its heading is no toggle until the
    filter clears), Blocked lies flat, Blocked and the Archive count "3 of 12", FYI shows all, the first-pass line
    hides, a note is kept by its words, and nothing left reads "No matches." Questions and sessions always show, and so
    do your agent's line and Claude's work on Merging, whose rows and Merged are filtered.
  - **FYI** shows its first five when it has seven or more, then **Show N more**: a press shows the rest until you
    leave the page. Its heading counts them all.
  - **A row's menu** (long press), in the window's order: Done (or Back on the desk), Snooze, Move to Urgent, Standard
    or FYI (one section up or down, with Undo), Close on GitHub where the desk allows it (Undo reopens a PR); then the
    phone's Mute, Open on GitHub and Copy GitHub link. A Merging row's: Back to the desk.
  - **Blocked** draws its tree: a hairline in the indent from each row to the PR it needs.
  - **Merging**: your agent's line ends with **Wake it** (**Start it now** before its first turn, **Try again** when
    it can't run). Each press is a turn of your agent on your own Claude, so only a press sends one, and a second
    press while one is on its way sends nothing. A PR your agent only rebases isn't listed: it stays on the Inbox.
    Between its rows and Merged, while there is any, **Claude's work** (your agent's name): the desk's ledger of what
    it owes you. Each row: the PR's title, your ask in quotes or the question you answered; its ref; "Claude is
    reviewing it" or "Your agent has it" (and "try 2 of 3"), "Waiting its turn", "Tries again in 2m" and why,
    "Failed 3 times: …" in ink, or "Your answer to … hasn't been picked up"; and since when. A press opens the
    review, your chat or the question. **Try again**, under a failed review or ask, is its own press: a review is
    asked for again (`POST /api/review/:id/ai`, said at once, never waited for), an ask is handed to your agent again
    (`POST /api/coordinator/wake { ask }`). An answer has none: only the session that asked can read it.
- **Ask your agent.** The window's chat (`Chat.tsx`) as a page. Its head: your agent's own name and mark (Claude Code,
  Codex, OpenCode: `AsksView.options.agent`; "Your agent" until the desk has answered), the item it's about and ×
  (ask about nothing in particular). One conversation, every ask oldest first: your words; when, its item (a press
  opens it) and "on plan.ts:20–23" or "on a thread"; then the answer and its time. An answer is your agent's words,
  drawn as text: paragraphs, lists, bold, `code`, a code block on the sheet with **Copy** (it keeps its fence, to paste
  on GitHub); a URL is shown, never a link. A long press on an answer is its tools, the window's at its foot: **Copy
  this answer** and **Go to what you asked**. Under the last ask without an answer, what your agent has said so far this
  turn (`coordinator.saying`, a message at a time, a shade quieter than an answer; the answer takes its place), then
  what it's doing: "Waiting on a permission prompt" (Answer it on claude.ai), "Queued: it gets this when it's done with
  what it's on", its latest step in its own words or "On it" (a step its words above already hold reads as On it,
  `Wait.said()`), "It can't run: …" in red, or "It stopped without answering" with **Wake it** (then "Asked it
  again"); Watch it on claude.ai where it has a page. Above the box: your agent's open questions about the item (Answer
  opens the question) and the spot the next ask carries ("On azulus's thread on src/sync/merge.ts:88", × for the whole
  PR). The box has no frame: you write on the page ("Ask or tell it something about api#4127"). With nothing asked yet
  it takes the page, you write at its top and its controls keep the foot; with a conversation it sits at the foot, and
  its corner expands it over the log and shrinks it back (Send shrinks it). Under it: Back, **how your agent runs**,
  and Send (the accent's square with a paper plane). How it runs is the window's three menus, the same settings as
  Settings → Agent (`agent.coordinator_bypass`, `_model`, `_effort`), each saved the moment it's picked
  (`Store.setAgentOption()`, `PUT /api/settings`) with the one in force ticked: how freely it runs in its own words
  (Ask first or Bypass permissions; Codex: Workspace only or Full access; OpenCode: Refuse what asks or Approve what
  asks), its model ("Model" while it's the agent's default; what its own command lists once the desk has read it
  (`AsksView.models`), until then Claude Code's Fable 5.2, Opus 5.5, Sonnet 5.5 and Haiku 5.5; **Another model…** opens
  a field for any name its command takes) and its effort ("Effort" while default; its levels, from the same list; none
  on OpenCode). A pick shows at once; one the desk refuses goes back, its words in red under the box. Where
  they don't fit beside Send (a long model's name, large text) they take a line of their own above Back and Send. What
  you typed and didn't send is kept per item. A refusal puts your words back with the desk's own in red
  (`Store.askFailed`), before anything you typed meanwhile; if you'd left the chat by then, a bubble says why and its
  draft has them. Your agent off: the box is off and says so in place of the menus. It opens from the page menu (**Ask
  your agent**, or **Your agent · waiting** while your latest ask has no answer; not with your agent off), an item's
  More, a conversation or a thread on a line, a line's box, a row of your agent's work, and after Make PR with fix.
  Opening it only reads (`GET /api/asks`, again on each of the desk's updates, no timer); **Send and Wake it each spend
  a turn of your agent on your own Claude**, so only a press sends one, and a second press while one is on its way
  sends nothing. A pick in the menus starts no turn: it changes how the next one runs.
- **Notes.** A note leads the section you put it in: a due reminder, then Urgent's notes, lead Urgent (after the
  questions and sessions), Standard's lead Standard and FYI's lead FYI, each counted in its heading. Its row (Note, its
  words, Done, "at Tue 9:00" or "by you") opens its box: your words, **In** (Urgent, Standard or FYI; Standard for a
  new note), **Remind me** (No reminder, In 1 hour, In 3 hours, Tomorrow 9:00, Monday 9:00, or Pick a time…, not before
  now), Save, Done (it leaves your desk for good, no Undo, as the window) and Close. A swipe on the row is Done too. Its
  menu (long press), as the window's: Done, Move to the section one up or down (a due note counts as Urgent; a move
  drops its reminder), Snooze (a time, which becomes its reminder), Change note (its box) and Copy text. **New note**
  is in the page's menu. A refusal keeps your words in the box with the desk's own. Notes are the desk's: nothing on
  GitHub.
- **People's pictures.** A person's GitHub picture before their name: who said what in a conversation or a thread on a
  line, the reviewers' list, the filter's pills and suggestions (yours too, as `you`). A row shows who it's from as
  the picture alone, yours too, in a slot that keeps its room. An item's page draws yours too, as the window's review
  (its header's "by you", the reviewers, the conversation and its reply rows). None for a bot or a team (docs/ui.md).
  Nothing is drawn, and no room kept, while one loads or when it doesn't,
  and a login that failed isn't asked for again. **This request goes from the phone straight to GitHub**
  (`avatars.githubusercontent.com/<login>?s=40`), not through the desk, with no token: it carries only the login.

A press sends at once, as the window's buttons do. What takes words (Approve's optional comment, Comment, Reply, Request
changes, Answer) is a sheet with a field and one named button, as tall as what's in it so it sits on the keyboard; if the desk
refuses, the sheet stays with your words and the desk's own. A write the desk never answered may still have landed: the
sheet says so and the desk is read again, rather than claiming it wasn't sent. `Store` has one method per write ("Writing" in `Inbox/Store.swift`): each sends once (`busy(id)`
meanwhile), says what the window says when it lands, and reads the desk again. The toast's Undo reopens a PR you closed
and makes a converted draft ready again.

What it calls: reads (`/api/overview`, `/api/queue`, `/api/inflight`, `/api/item`, `/api/inquiries/:id`,
`/api/reviewers/:id`, `/api/asks`, `/api/setup`, `/api/events`, `/health`), `POST /api/act` (done, snooze, mute, unmute, restore, seen, inflight,
takeback, and urgent, standard, fyi), `/api/undo`, `/api/sync`, `/api/notes`, `/api/notes/:id`, `/api/notes/:id/done`,
`/api/coordinator/wake` and `/api/ask` (each a turn of your agent: only on a press), the writes above (`/api/review/:id/approve|comment|inline|reply|ready|reviewers|ai`,
`/api/issue/:id/analyze|fix|block|unblock`, `/api/github`, `/api/inquiries/:id/answer`, `/api/sessions/:id/kick`) and,
once, `/api/pair`. And, not the desk: `https://avatars.githubusercontent.com/<login>?s=40` for a person's picture.

What opening a PR costs: one `GET /api/review/:id` without `ahead`, exactly the window's open, so the desk may start
its AI review (`review.auto_ai`) and your agent's read of the conversations waiting on you. Every redraw after it asks with
`?ahead=1`, a second after the desk's last event, so an event never restarts a failed job (`Store.readReview()`). Not
every event is a redraw, since each is the whole review again and the desk sends one every couple of seconds while your
agent works: the page reads again when the lists say something new about the PR, a sync ended or a write from this
phone did (`Store.mark()`), on every event while its AI review is being written, your agent is reading its
conversations or your words aren't in them yet, and otherwise at most every half minute (`Store.redraws()`). A PR's page no longer asks `/api/item`: that is for issues. Rows and lists never ask for a
review, and nothing is prefetched. Nothing but a press on Ask Claude for one or Try again posts `/api/review/:id/ai`. The answer is the whole review (`ReviewView` in `Models.swift`: the order to read
its hunks in, the AI review's parts, checks, reviewers, conversations); each file's own `patch` is never kept, since
the same lines are in the order's hunks.

What opening an issue costs: one `GET /api/item`, as the window's open, so the desk may start its pre-review when AI
reviews are on and none is written for this version; a redraw asks again a second after the desk's last event. Nothing
but a press posts `/api/issue/:id/analyze` (Analyze it, Try again, Read it again; `{ trust: true }` only from "Not an
injection: analyze it"), `/fix` (Make PR with fix: a turn of your agent), `/block` or `/unblock`. After Make PR with
fix the chat opens on the issue, as the window's (`Store.askedAbout()`): the desk made the ask, so nothing more is sent.

## Not on the phone

Left out on purpose, each said here once.

- **Settings' editors** (rules, automations, urgency criteria, themes, network, agents): configuration is done at the
  desk's computer; the phone only renders the desk's state, in the default light and dark. The one exception is the
  chat's own menus for how your agent runs (its run mode, model and effort), as the window's chat has them by Send.
- **The first run** (connecting GitHub, picking your agent): it sets up the desk's own machine, so it happens there.
  A phone paired before it was finished (`inbox pair` doesn't check) shows the lists with a bubble, "The desk isn't
  set up yet", saying to finish it on the computer (`GET /api/setup`, asked once per connection and then on each read
  while it's unfinished); with GitHub not connected every read is refused in the desk's words instead.
- **The update line and installing an update**: that's the desktop app updating itself.
- **A session's Open**: the desk refuses it to a phone (403), since it opens a terminal on the desk's computer. The
  session's page says so where its button would be.
- **Copy attach command** (a session's and Merging's): a command to run on the desk's computer. Cheap to copy, but
  only useful with Universal Clipboard.
- **A bubble's "Fix rules" and "Open Settings → Agent"**: they lead into Settings, which isn't
  here; the bubble's words still show.
- **The "Restarting the desk" and "The desk stopped" bubbles**: they come from the desktop app's own bridge, not the
  API.
- **Copy link** (`inbox://…`): nothing on a phone opens it; Copy GitHub link is there instead. Cheap if pasting to an
  agent from the phone turns out to matter.
- **Pin**: it isn't in the window either. Its only trace is a `p` key in `App.tsx` that no button, link or menu
  reaches, and no row shows a pin.
- **A row's call to action acting from the list** (the window's Ready for review and Hand off for merge in one press):
  here a press on a row always opens its page, whose bar has the action, so a scroll can't act.
- **Only the window's header on a PR's page**: the window's review says nothing of why the PR is on your desk, its
  stage or its age, since its row is beside it; a phone's page has no list beside it, so the row's why, stage, age,
  comment count and labels lead the page. The rest is the window's: "Resolved: merged by li-wei", no Recent activity
  on a PR (an issue has it), and Merging's line only when your agent said what it waits on.
- **Staying on the review after a write that takes it off your desk**: after Approve, Comment on the PR or issue,
  Request changes, Close and Merge the phone goes back to the list, where the toast is; the window stays on the
  review. Only a comment on a line and a reply stay on the page.
- **"More lines" around a hunk** (`GET /api/file`): the phone shows the hunks only, to keep the page and what it
  reads small.
- **Word-level changes and syntax highlighting** in the diff: plain added and removed lines.
- **A comment on a range of lines** (the window's drag), and an ask about one: single lines only.
- **Diagrams drawn as figures** (ELK layout, Excalidraw): a diagram is its lines as text, the window's own fallback.
- **"Open the drawn review"** (the desk's rendered review document, in a web view): cheap, not built; it's a second
  way to read the same review.
- **The rule trace on an item**: a fold for tuning rules, which is done in Settings on the computer. Where an issue
  sits, from which board and why it moved are on its page ("FYI, from the Mentions board, sorted by Claude: …", "The
  rule said today; it moved to fyi because …"), as the window's; the other boards' placements are in the trace.
- **Keys** (Esc, ⌘↵, ⌘1 to ⌘4, the arrows) **and the list beside a review**: they belong to a keyboard and a wide
  window.
- **Prefetching a review before it's opened** (the window's hover): a phone has no hover, and the desk already warms
  diffs after each sync.
- **Opening the pairing link from the phone's Camera app straight into the app** (a URL scheme or universal link):
  each desk has its own private ts.net name, so the app scans the QR itself.
- **A read-only page of the desk's settings** (`GET /api/settings`): cheap, but a page of settings you can't change
  is a page without an action.
- **A leaner review from the desk** (`?lean=1`, dropping each file's `patch`): not needed unless the answer proves
  slow over a tailnet when measured.
- **Asking for an AI review of your own PR that has none** (the window's More): yours shows one only once it exists.
- **Links in your agent's answers**: a URL in the chat is text to read, not a link to follow.
- **The chat following your agent's words as they come** (the window's, unless you've scrolled up): the page stays on
  the newest turn's top, so a long answer being written never pulls the page from under your reading.
- **Go to the top of the conversation** (an answer's third tool): the status bar's tap does it. The chat's Close icon
  and its keys (Enter, Shift+Enter, Esc) are the window's; here it's Back, the swipe back and Send.

Not built at all: notifications, an iPad layout.

## Where things are

| To change                                   | Edit                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| What the desk's JSON looks like             | `Inbox/Models.swift` (every field optional, enums kept as strings, lists skip a bad row) |
| What it asks the desk, and errors           | `Inbox/APIClient.swift`; an address or a pairing link in `Inbox/Address.swift`         |
| State, loading, the live stream, acting     | `Inbox/Store.swift` (one `@Observable` store; the launch arguments too)                |
| The window's words (ages, snooze, bubbles)  | `Inbox/Format.swift`, kept in step with `web/src/format.ts`, `view.ts`, `notices.ts`   |
| Colours, faces, the mark                    | `Inbox/Theme.swift` (the default theme's tokens from `web/src/styles.css`; SF Pro and SF Mono, as the window's) |
| A row                                       | `Inbox/Views/Rows.swift` (the window's two-line row, `.c-row`); its icons and picture in `Views/RowIcons.swift`; a PR's signal in `Views/Signal.swift` |
| The pages and their lists, a row's menu     | `Inbox/Views/DeskView.swift` (`CardMenu`, `NoteLine`, `SessionLine`; Merging's agent line and `wake()`) |
| The filter                                  | `Filter` in `Inbox/Format.swift` (`parse()`, `matches()`, `people()`, `suggest()`, `picked()`, `dropped()`: view.ts's and Filter.tsx's); the box and its suggestions in `Inbox/Views/FilterBar.swift`; `Store.filter`, `shown()` |
| FYI's five, a row's moves, Blocked's tree   | `Lists.fyiCut()`, `moves()`, `treeGuides()` in `Format.swift`; `TreeGuides` in `Rows.swift` |
| Notes                                       | `Inbox/Views/NoteSheet.swift`; their places in `InboxList` and their menu in `NoteLine` (`DeskView.swift`); `Remind`, `Lists.moves(_:now:)` in `Format.swift`; `Store.saveNote()`, `doneNote()`, `noting` |
| People's pictures                           | `Avatar` in `Inbox/Views/Rows.swift`; whose: `Card.face`, `Standings.Standing.face`, `WhoLine` |
| Wake it                                     | `Store.wake()`, `APIClient.wake()`                                                     |
| Ask your agent (the chat)                   | `Inbox/Views/Chat.swift` (`ChatPage`); what it's about, its words and the waiting line: `ChatAbout`, `Wait`, `Asking` in `Inbox/Asking.swift` (Chat.tsx's); how it runs: `AgentKind` there (Chat.tsx's `AGENT`), `Store.setAgentOption()`; the marks: `Inbox/Views/AgentMark.swift`; `Store.asks`, `readAsks()`, `ask()`, `wake(ask:toast:)`, `openChat()`, `askDrafts`; `APIClient.asks()`, `ask()`; `AsksView` in `Models.swift`; the route is `Route.chat` |
| Where the chat opens from                   | the page menu in `DeskView.swift`; More, `asking()` and `askLine()` in `ItemPage.swift`; `SaidActions` (`ask`); `WriteSheet`'s `aside`; `Store.askedAbout()` |
| An agent's answer as text                   | `Blocks.parse()`, `inline()`, `fencedCopy()` in `Inbox/Blocks.swift` (the twins of `src/prose.ts`); drawn by `ProseBlocks` in `Chat.swift` |
| What a reviewer wrote, as blocks            | `Blocks.said()` in `Inbox/Blocks.swift` (`saidBlocks()` in `src/prose.ts`); drawn by `SaidText` in `Said.swift`      |
| Your agent's work in Merging                | `WorkLine` in `DeskView.swift`; `Asking.workTitle()`, `workPhrase()`, `workSince()`, `canRetry()`; `Work` in `Models.swift`; Try again: `Store.retryReview()`, `wake(ask:toast:)` |
| An item's page                              | `Inbox/Views/ItemPage.swift`                                                           |
| A PR's Status (risk, checks, changes, reviewers, merge) | `Inbox/Views/ReviewState.swift` (`Status`: the words and thresholds, a reviewer's action); `CheckGroup.of()` in `Format.swift` (view.ts's `checkGroups()`); `Store.reviewer()` |
| A file's Viewed box                         | `Folds` and `DiffSection.marks` in `Inbox/PatchLines.swift`; the box in `DiffView.head()`; `ItemPage.markViewed()`, `marking`; `Store.markViewed()` |
| What reviewers said, the Conversation tab, Reply | `Inbox/Views/ConversationTab.swift`; `Inbox/Views/Said.swift` (`SaidText` with its Copy link, `SaidComments` and `SaidActions`, shared with the diff's threads); words in `Format.swift` (`Words.place()`, `takeSplit()`, `saidText()`, `replyTo()`), `Blocks.saidLine()`; `Store.reply()`, `left()` |
| The AI review's block, a diagram as text    | `Inbox/Views/AiBlock.swift` (`AiSection`, `Named`, `DiagramLines`; the verdict's tag is `ItemPage.facts()`); words in `Format.swift` (`Words.lead()`, `reviewing()`, `reviewFailed()`, `listsConcerns()`, `fit`); `diagramText()` in `Inbox/Guide.swift` |
| An issue's pre-review, its bar              | `Inbox/Views/IssuePre.swift`; `ItemDetail.preStanding`, `preStale`, `fixable` and `IssueReview` in `Models.swift`; words in `Format.swift` (`Words.issueKind()`, `asked()`, `placedBy()`); `Store.analyzeIssue()`, `fixIssue()`, `blockAuthor()`; the bar's choice in `ItemPage.bar` |
| Asking for an AI review                     | `Store.askReview()`, `asking`; `APIClient.askReview()` (the one request that waits minutes) |
| The guided review, notes on lines           | `Inbox/Guide.swift` (`Diff.walk()`, `guided()`, `isTestPath()`, `placed()`, `on()`: the twins of `src/sections.ts`); `DiffModel(guided:bugs:)`; steps, `AiNote` and Look here in `Inbox/Views/DiffView.swift`; the two tabs and `reach()` in `ItemPage.swift` |
| A PR's diff: lines, order, threads, the fold | `Inbox/PatchLines.swift` (`patchLines()`, `Diff.traditional()`, `threadsOn()`, `spot()`, `DiffModel`: the twins of `src/review.ts`, `src/sections.ts` and `web/src/view.ts`); drawn by `Inbox/Views/DiffView.swift` |
| A comment on a line                         | `Store.inline()`, `APIClient.inline()`; the box is `ItemPage`'s `.line`               |
| When a PR's review is read, and the pin     | `Store.readReview()`, `closeReview()`, `pins` in `Inbox/Store.swift`                   |
| A question, a session, Settings, bubbles    | `Inbox/Views/Pages.swift`                                                              |
| An opened page's bar, the boxes that write  | `Inbox/Views/Acting.swift` (`BottomBar`, `WriteSheet`, `ReviewersSheet`, the swipe back) |
| The connect screen                          | `Inbox/Views/ConnectView.swift`                                                        |
| Test mode (no desk; App Review)             | `Inbox/Demo.swift` (`DemoDesk`); its answers `Inbox/Demo.json`, from `npm run ios:demo` (`scripts/ios-demo.ts`); `Store.testMode()`; `DeskAddress.isDemo` |
| Scan the code (the camera, the QR it reads) | `Inbox/Views/ScanView.swift`; what counts as a desk's link: `DeskAddress.scanned()`    |
| The app icon                                | `Inbox/Assets.xcassets/AppIcon.appiconset` (the mark, full-bleed on petrol)            |
