# Review Desk: design

v2, 2026-10-26, revised after three adversarial reviews (security red-team, host feasibility, scope fit). Every number comes from the six-month replay in [evidence.md](evidence.md).

## TL;DR

- `deskd` reads GitHub every 60s and never writes. It sorts your review load into cards: ≤3 NOW and ≤6 TODAY (your asks and your PRs don't count against the caps). LATER waits off-screen; FYI is in Audit.
- You triage in a `/desk` pane in the Claude Desktop Code tab. The status line shows `●2 +3`. Notifications fire only for new NOW cards, plus 3 summaries.
- The core signal is who wrote the PR. In replay, the shipped rules (V1) surface 80% of the _requested_ PRs you engaged with (171 of 215), before you did, at 22 cards a week; first-draft rules got 61% at 26.5. Counting PRs nobody asked you about, that's 48% of all engagements (~64% with collab-watch).
- Other sessions read the desk over MCP and the CLI. Only sessions in getsentry/\* or gricha/\* repos can triage.
- `h` builds a sandboxed room for a PR and copies a launch prompt. The verdict and draft come back to the card.
- The desk never posts. LLMs run only when you press `i` or launch a room.
- About 3.5 dev-days to a usable pane, judged on your week-2 use.

## Terms

| Term                      | Meaning                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Card                      | One row for one or more PRs: a series (one author's PRs that a bot such as sentry-junior asked you to review) or the same author + commit scope within 72h |
| NOW / TODAY / LATER / FYI | Someone waits on you / you'd likely engage today / returns on an event or the Monday card / hidden, in Audit                                               |
| Ask                       | A human asked you directly, mentioned you, asked a question, re-requested you, or it's your move on your PR. Protected                                     |
| Principal                 | Whose PR it is. A junior PR "Requested by X" counts as X's                                                                                                 |
| MINE                      | Your PRs and inbound items on your repos                                                                                                                   |
| Room / handoff            | A disposable folder with a PR's files / one session launched into it                                                                                       |
| A0 / A1 / A2 / A3         | Analyzers. A0 parses existing bot findings (no model). A1 background relevance, A2 ask-intent (both off). A3 the impact brief an LLM writes on `i`         |
| W0–W3                     | GitHub write tiers: W0 reads, W1 mark your notifications done, W2 pending review, W3 anything public. v1 is W0 only                                        |
| sent_detected             | Sync saw your review; the card closes                                                                                                                      |
| Monday card               | ≤5 cleanup decisions a week; untouched by Wednesday → defaults apply                                                                                       |
| R0 / P9 / V1              | Replay variants: first-draft rules / best tuned / shipped (P9 + 2 deltas)                                                                                  |
| collab-watch              | Open PRs by your close collaborators, requested or not                                                                                                     |

## Where this deviates from what you asked

| You asked for                                               | v1 does                                                                                                                 | Why                                                                                                                                           | What would change it                                                                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A desktop app, maybe embeddable in Claude Code, Codex or T3 | A pane in the Desktop Code tab, a status line, notifications and a CLI. **Codex and T3 get MCP tools only, no UI**      | You live in Desktop and a pane costs 0 tokens. 117 untouched requests show that separate surfaces go unopened                                 | Mods fail the spike or get switched off → the same list at `http://localhost:47823`, from the same view-model                                 |
| Trigger sessions, or manage an always-on session            | `h` builds a room and copies a prompt; you paste it into a new session. Nothing to chat with. "Always-on" means `deskd` | `start_session` wakes its caller on every child turn, maybe not at all for new folders. A standing session over PR text is the riskiest piece | You say what it should do (watch your PRs? answer "what's next?"), ≥3 handoffs/wk for 2 weeks, spike check 10 passes → the Desk launcher (§6) |
| Small local agents that say whether to look                 | Rules decide. An LLM writes an impact brief only on `i`                                                                 | Author history beats every analyzer stand-in (the keyword proxy's +5pp is leaky). Background billing is open                                  | Decision 2 → A1 on FYI cards with topic chips, A3 prefetch for TODAY, kept only if `desk eval` shows lift. On-device models are an option     |
| Manage my GitHub, repos and PRs                             | Read-only views of your PRs, your repos (inbound PRs, issues, main CI) and others' PRs. Every action opens GitHub       | Standing rule: the desk never posts                                                                                                           | Nothing in v1. W1 (mark notifications done) is the only write ever considered                                                                 |

## Decisions for you

| #   | Decision                                                                                                             | Default if you say nothing                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | Accept the four deviations above                                                                                     | Accepted                                                                                                 |
| 2   | Background LLM analysis of internal code: personal Max, Sentry Enterprise, an API key, or an on-device model? $ cap? | None. `i` only, on your plan                                                                             |
| 3   | Is `i` (`claude -p` on your plan over seer/sentry hunks) OK under Sentry policy?                                     | Yes, as ordinary Claude Code use                                                                         |
| 4   | Which repos are yours?                                                                                               | getsentry/{warden, dotagents, junior, claudescope}, gricha/\*: PRs by others, new issues, red CI on main |
| 5   | Which folders get triage tools over MCP?                                                                             | Repos with origin getsentry/\* or gricha/\*. Everything else is read-only                                |
| 6   | Will you do the Monday card (≤5 decisions)?                                                                          | Untouched by Wednesday → defaults apply                                                                  |
| 7   | Work hours, quiet hours, which Focus modes count                                                                     | Mon–Fri 09:00–18:30; any macOS Focus                                                                     |
| 8   | Will you send the team ask (§9)?                                                                                     | The desk carries the load                                                                                |
| 9   | May own-PR fix sessions run tests or devenv?                                                                         | Yes, with prompts. Never for others' PRs                                                                 |
| 10  | Mark ~188 merged/closed notification threads done (irreversible)?                                                    | No. Done stays local                                                                                     |
| 11  | Can junior stamp the human principal on its PRs?                                                                     | No; the desk parses the body                                                                             |

## 1. Principles

1. Two capped lists, counted in cards: ≤3 NOW, ≤6 TODAY _unprotected_. Asks and MINE are cap-exempt and shown in the header.
2. Live where you already work.
3. Rules decide, models explain. Manual > rule > model.
4. Asks are immutable to agents and never cap-evicted.
5. Why-lines are templated from signals, never from PR text.
6. PR code never runs. Sessions on others' PRs have no shell, no messaging, no reads outside their room. Own-PR fix sessions get a shell with prompts. Work sessions see PR text fenced, with the trust of reading GitHub.
7. Every launch needs your keypress.
8. Snoozes are predicates over current state.
9. The daemon is the truth; every surface is optional and probed.
10. No use-number, no feature.

## 2. Surfaces

| Surface                                             | Role                                                                                                                             |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `/desk` pane (Desktop Code tab, bundled CC 2.1.308) | The triage UI. Tabs `1` List · `2` Mine · `3` Audit                                                                              |
| Status line, every session                          | `⚠ desk: ●2 +3` = NOW count + new TODAY cards since you looked. Blank at 0/0; `desk offline` if deskd is down. The host adds `⚠` |
| macOS notification (`osascript`)                    | The only interruption: NOW entries + 3 summaries                                                                                 |
| `desk` CLI                                          | `ls`, `done <id>`, `status`, `doctor`                                                                                            |
| `desk` MCP, `/desk:triage`                          | For agents anywhere; a 12-line text table when mods are off                                                                      |

| Host                                                                            | v1                                                                                |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Desktop Code tab                                                                | Pane, status line, plugin MCP and hooks                                           |
| Terminal CC (after `claude auth login && claude update`; PATH 2.1.267 gets 401) | Same plugin; rooms open via `claude-cli://open?cwd=<room>&q=<prompt>`             |
| Codex                                                                           | MCP only: `[mcp_servers.desk] command="desk" args=["mcp"]`, `tool_timeout_sec=30` |
| T3 Code 0.0.40                                                                  | MCP only, if it passes MCP config through (unverified)                            |

| Failure                                               | What still works                                              |
| ----------------------------------------------------- | ------------------------------------------------------------- |
| Mods off (rollout flag, `--safe-mode`) or spike fails | Notifications, CLI, MCP; the List at `http://localhost:47823` |
| deskd down                                            | Status line says `desk offline`; launchd restarts it          |
| Desktop closed, Mac asleep                            | deskd syncs and notifies whenever the Mac is awake            |
| Room confinement unproven (spike 6–7)                 | No rooms on others' PRs; `i` only                             |

## 3. UI

**Card.** Collapsed: whose turn, kind chip (`ASK`, `MINE`, `AGENT`), `repo#n` or series, author, title (plain text, ≤70 chars), age; line 2 is the why-line and facts. Expanded adds evidence chips (`7 of your files`, `topic: agent-token`), series order, linked session, draft, buttons.

**Keyboard** (pane focused). Each card is a Button, so Up/Down move between cards natively.

| Where         | Keys                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Bar           | `↵` expand, `↵` again opens on GitHub · `e` done · `s` snooze · `m` mute · `u` undo                                            |
| Expanded card | `o` open · `h` hand off · `i` impact brief · `w` why · `c` read draft · `x` not mine · `t` split series · `n` nudge (your PRs) |
| `s` row       | `1` CI green · `2` author pushes · `3` mentioned · `4` tomorrow · `5` Monday                                                   |
| `h` row       | `1` brief · `2` draft comments · `3` fix my PR (yours only)                                                                    |
| Monday card   | `e` take the default · `k` keep · `m` mute                                                                                     |
| Anywhere      | `z` desk focus 90 min · `p` pull up (Audit)                                                                                    |

`e s m u` act on the one expanded card. A row replaces the bar while open, and the tab Buttons lose their hotkeys until it closes, so its digits never hit the tabs; Esc cancels. `e` = done until new activity; `m` is the only permanent silence; `x` = FYI + a "not mine" label.

**Flows**

- **(a) Morning.** 09:30 notification if anything is visible. Work NOW, then TODAY; ≤10 min. A card closes when sync sees your review.
- **(b) New ask while focused.** NOW within 60s (5 min idle), protected. Under `z`: no alert, `●3` in the status line, one summary when `z` ends. Under a macOS Focus, deskd sends as usual and macOS files it silently in Notification Center. A full NOW pushes its lowest unprotected card to the top of TODAY.
- **(c) Audit.** Hidden cards by rule. `p` pulls one to TODAY and logs a false negative; 2 in 14 days put ⚠ on the rule. "Agent actions 24h" lists every non-you change, with undo.
- **(d) Your PRs** reach the List only when they need you:

| Condition (ready PRs)                                                                               | Bucket         | Action                          |
| --------------------------------------------------------------------------------------------------- | -------------- | ------------------------------- |
| Changes requested, a thread's last comment isn't yours, or approved + required CI green + mergeable | NOW, protected | `Reply` → `h 3` / `Merge` → `o` |
| Required CI red >1h after your push, or conflicts (warden#548)                                      | TODAY          | `Rebase` / `Fix` → `h 3`        |
| Awaiting review >3 days, idle ≤45 days (junior-prod#415, 40d)                                       | TODAY, once    | `n` copies a templated ping     |
| Drafts idle >21 days; ready PRs idle >45 days (.github#211, hunk#1/#2)                              | Mine tab only  | On the Monday card              |

- **(e) First run.** No-ask items whose last request and activity are both >14 days old go to FYI in one batch; one `u` undoes it. Today: 9 cards (26 PRs), mostly hidden anyway.
- **(f) Monday card.** ≤5 decisions: oldest LATER cards idle ≥7 days and stale Mine PRs. Untouched by Wednesday → LATER cards idle ≥14 days go to FYI.

**Interruptions: NOW-entry alerts plus 3 summaries.**

| Mode                           | Notifications                                                                        | Search sync         |
| ------------------------------ | ------------------------------------------------------------------------------------ | ------------------- |
| Work hours                     | NOW entries, ≤1 batch per 20 min; dropped if it entered NOW >30 min before the flush | 60s active, 5m idle |
| `z` (desk focus)               | None; one summary when it ends                                                       | Same                |
| macOS Focus                    | Sent as usual; macOS holds them silently                                             | Same                |
| Quiet hours, weekends          | None; folded into 09:30                                                              | 15m                 |
| Summaries (exempt from 30 min) | 09:30 if non-empty; end of `z`; "While away" on wake                                 | —                   |

Text stands alone (`Desk · seer#8463 · vaind asked you · 25d`). A click opens Script Editor, not the card.

**Wireframe 1: the List, today's 117 PRs under V1**

```
┌ Review Desk ──── now 2 · today 6 cards / 26 PRs · mine 2 · ⟳ 40s ─────────┐
│ NOW 2                                                                     │
│▸● ASK  seer#8463  vaind · Read eval API keys from macOS Keychain      25d │
│        vaind asked you · 128 lines · CI ✓ · +2 evals PRs                  │
│ ● ASK  seer#8949  vaind · Flag provider client calls in unchecked…     6d │
│ TODAY 6/6                                                                 │
│ ○      azulus · codemode series ×11 (+1 CI red)         seer×9 sentry×3 │
│        You review 79% of azulus's PRs · via sentry-junior                │
│ ○      seer#8427  alexsohn1126 · Abort a force-push… · 7 of your files   │
│ ○      seer#9093  azulus · Keep pipeline step_id within 64 bits          │
│ ○      sentry#128771  alexsohn1126 · 5 of your files · 388 lines         │
│ ○      wedamija · investigations ×3 (+6 hidden) · 2–6 of your files      │
│ ○      seer#8845  vaind · Bump azure/setup-helm to v5.0.1                │
│ MINE 2  warden#548 conflicts [Rebase] · junior-prod#415 no review 40d    │
│ ─ 10 waiting for a slot · 5 later · 35 hidden ─────────────────────────── │
│ ↵ open · e done · s snooze · m mute · u undo                              │
└───────────────────────────────────────────────────────────────────────────┘
```

**Wireframe 2: an expanded card**

```
┌ TODAY · YOU ─ azulus · codemode series ×11 (+1 CI red) ──── seer+sentry ┐
│ why    close collaborator: you review 79% of azulus's PRs (60d)         │
│ ask    via sentry-junior (bot ask, floor LATER) · today                 │
│ facts  2–402 lines each · req'd CI ✓ 11/12 (sentry#128838 ✗)            │
│ sig    up to 8 of your files · topic: code mode                         │
│ order  sentry#128853 → seer#9073 → seer#9084 → seer#9076 → …            │
│ [o] open first  [h] hand off  [i] impact  [w] why  [t] split           │
└─────────────────────────────────────────────────────────────────────────┘
```

**Wireframe 3: Audit (counted after grouping)**

```
Hidden 35 cards (58 PRs)              replay engaged   pulled 7d   [p] pull up
 agent-low-aff ........ 14 cards / 14 PRs   3.6%            0
 approved-by-others ...  6 / 6              0 of 184        0
 no signal (default) ..  6 / 8              2.7%            0
 blocked, not yours ...  5 / 7              –               0
 dependabot ...........  2 / 21             0 of 71         0
 fanout ...............  1 / 1              1.8%            0
 stale (>45d) .........  1 / 1              –               0
 Agent actions 24h: none
```

## 4. Domain model

| Entity                  | Key fields                                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| item                    | key (`github:pr:getsentry/seer#9086`), kind (`pr_review`, `pr_watch`, `my_pr`, `my_repo`, `mention`, `agent_waiting`), `title_untrusted`, author {login, kind}, principal, head_sha, base_sha, state, card_id        |
| card                    | id (`card:series:<principal>←<requester>@<t0>`), item_keys[], bucket, rank, protected (`ask`, `bot_ask`), why, whose_turn, disposition (open, snoozed, done, muted), snooze {predicates[], until_ts}, done_watermark |
| event                   | item_key, type (review_requested, reviewed, commented, mentioned, pushed, required_ci_changed, ready, merged, session_*…), actor {login, kind}, at, dedupe_key                                                       |
| signal, decision, label | signal {item_key, revision, name, value}; decision (append-only) {bucket, rule_id, invariant, cap_evicted, trace[]}; label (`engaged`, `not_mine`, `pulled_from_fyi`)                                                |
| action                  | actor (you, rule, or agent + client + profile), verb, before, after, undo_of. Agents undo only their own                                                                                                             |
| handoff, draft [M3]     | handoff {card, intent, head_sha, session state, result}; draft {head_sha, body, comments[], status: draft, copied, sent_detected, stale}                                                                             |
| source                  | id, cursors, rate_remaining. Later sources (Slack) map to item/event/actor, so invariants carry over                                                                                                                 |

A card takes its highest member's bucket. Lower members show as `+N hidden`, not lifted. `t` splits one out.

## 5. Triage pipeline

```
sync → normalize → signals → cards → decide(snapshot, rules, t):
  rules (first match) → invariants → your overrides → caps → decisions → view-models
```

`decide()` is pure; the live path and the replay golden test share it.

| Stage     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sync      | Union search `is:open archived:false (review-involves:@me OR involves:@me OR assignee:@me OR team:getsentry/machine-learning-ai)` + `mentions:@me`. **collab-watch**: `is:open is:pr org:getsentry author:<close collaborators>`. Your PRs with checks. Your repos: `is:open repo:<each> -author:gricha` + required checks on main. `/notifications` If-Modified-Since. Detail on change in aliased `pN: node(id:…)` blocks (≤20), each with its own `isRequired(pullRequestId:)` |
| normalize | Request age = latest ReviewRequestedEvent. Principal parsed from junior PR bodies                                                                                                                                                                                                                                                                                                                                                                                                 |
| signals   | `ask.*` (human vs bot, from the request's actor), `route.teams`, `hist.*` (your engagements with the author as of t, humans only), `aff.weighted` (files of your merged PRs, prior 120d; no lock/generated/hub files; tests ×0.5), `aff.open_pr_overlap`, `state.*` (draft, required CI, mergeable, approved by others), `conv.*`. `topic.hits`: a chip from changed paths and identifiers you introduced, never title or body                                                    |
| caps      | NOW ≤3, TODAY ≤6 unprotected cards. Overflow waits (LATER `over_cap`) and refills TODAY                                                                                                                                                                                                                                                                                                                                                                                           |

**`builtin.toml` = replay variant V1.** First match wins; default FYI. NOW/TODAY rules are replayed except `[live]`. LATER-vs-FYI choices don't move the replay; they follow per-rule engagement.

```toml
# Gate: replay recall 0.80 (train 0.79 / test 0.80), 22.3 cards/wk, 6.2 on screen at 9am
version = 1
[limits]
now_cards = 3      # unprotected
today_cards = 6    # unprotected; asks and MINE are cap-exempt

[[invariant]]  # never below TODAY, immutable to agents, never cap-evicted
id = "asks"
when = "ask.human_direct || conv.mentioned || conv.question_to_me || ask.rerequested_by_human || mine.my_move"
min = "TODAY"

[[invariant]]  # azulus ×12 via sentry-junior; getsentry#22736 via cursor. 0 of 4 matured engaged
id = "bot-asks"
when = "ask.bot_direct"
min = "LATER"

[[rule]]  # seer#8463, seer#8949: vaind asked you. 21 of 36 human asks engaged
id = "human-ask"
when = "ask.human_direct && !state.draft"
bucket = "NOW"
why = "{ask.by} asked you · {ask.age}"

[[rule]]  # junior PR "Requested by greg.pstrucha"
id = "my-agent-pr"
when = "item.my_agent_pr"
bucket = "NOW"

[[rule]]  # [live] your own PRs were outside the replay
id = "mine-my-move"
when = "item.mine && !state.draft && (state.changes_requested || conv.unresolved_last_not_mine > 0 || (state.approved && state.required_ci == 'SUCCESS' && state.mergeable == 'MERGEABLE'))"
bucket = "NOW"

[[rule]]  # [live] warden#548 (conflicts)
id = "mine-fix"
when = "item.mine && !state.draft && (state.required_ci_red_1h || state.mergeable == 'CONFLICTING')"
bucket = "TODAY"

[[rule]]  # [live] junior-prod#415
id = "mine-waiting"
when = "item.mine && !state.draft && state.awaiting_review_days > 3 && item.idle_days <= 45"
bucket = "TODAY"
once = true

[[rule]]  # [live] PRs by others and issues on your repos
id = "my-repo-inbound"
when = "item.my_repo && author.kind == 'human' && !conv.answered_by_me"
bucket = "TODAY"

[[rule]]  # [live] red CI on main in your repos
id = "my-repo-main-red"
when = "item.my_repo_main && state.required_ci_red_1h"
bucket = "TODAY"

[[rule]]  # azulus: 103 of 131 requested PRs engaged
id = "close-collaborator"   # ≥3 engagements and ≥30% of their PRs, 60d
when = "author.kind == 'human' && hist.close && !state.blocked"
bucket = "TODAY"
why = "You review {hist.rate_60d|pct} of {author.login}'s PRs"

[[rule]]  # vaind 10, sehr-m 8, NicoHinderling 8 engagements in 28d
id = "recent-collaborator"
when = "author.kind == 'human' && hist.eng_28d >= 2 && !state.blocked"
bucket = "TODAY"

[[rule]]  # sentry#125243 overlaps your sentry#126405. 17.6% vs 4.3%
id = "overlaps-my-pr"
when = "aff.open_pr_overlap > 0 && !state.blocked"
bucket = "TODAY"

[[rule]]  # 0 of 71
id = "dependabot"
when = "author.login.startsWith('dependabot')"
bucket = "FYI"

[[rule]]  # cleanup only
id = "stale"
when = "item.age_days > 45"
bucket = "FYI"

[[rule]]  # sentry#128705. 0 of 184
id = "approved-by-others"
when = "state.approved_by_others"
bucket = "FYI"

[[rule]]  # sentry#127080 (12 teams). 1.8%
id = "fanout"
when = "size(route.teams) >= 4"
bucket = "FYI"

[[rule]]  # sentry app / junior PRs via seer's `*` line. 3.6%
id = "agent-low-aff"
when = "author.kind != 'human' && aff.weighted < 2"
bucket = "FYI"

[[rule]]  # seer#9098 (required CI red): wakes on state
id = "blocked"
when = "state.blocked && (aff.weighted >= 1 || aff.open_pr_overlap > 0)"
bucket = "LATER"
until = ["required_ci_green", "ready_for_review", "mergeable"]

[[rule]]  # seer#9099: wedamija, 2 of your files. 9.8% at 1–2 files
id = "team-my-files"
when = "aff.weighted >= 1"
bucket = "TODAY"
# default FYI: no affinity 2.7%; area-only 2.7%

[rank]   # the P9 score; dropping the size term cost 1.4pp recall
direct_ask = 40
per_file_of_yours = 6        # max 6 files
overlap_my_pr = 15
human_author = 10
per_day_since_request = 1    # max 14
over_800_lines = -10
recent_collaborator = 12
close_collaborator = 30
```

`state.blocked` = draft (replayed), or required CI red or conflicting (`[live]`: CI history can't be reconstructed). If MINE averages >3 cards/day in week 1, the `my-repo-*` rules start counting toward the TODAY cap.

**Rule engine.** M1a ships these rules as a TS function with a golden test against `sim.py` on the backtest data. The TOML+CEL loader comes at your first rule change (M2): `@bufbuild/cel` pinned, signals bound as Maps with bigint counts, saves fail on any evaluation error, and every rule dry-runs on the live inbox and the replay first. Agents can only `propose_rule`; `desk rules on <id>` activates.

**Analyzers [M3].** A0 parses warden, Bugbot, Seer and Copilot findings at head_sha into a chip; no model. A3 runs only on `i`: deskd pre-cuts ≤30k tokens (hunks touching your files, your open-PR diffs, A0, fenced PR text) and runs `claude -p --restricted --tools "" --strict-mcp-config --json-schema <s> --no-session-persistence` in an empty folder. Output: `{verdict: must_review | skim | skip, reasons[], est_minutes, injection_suspected}`. A3 ranks within a bucket, promotes TODAY→NOW only with a deterministic co-signal, never demotes; `injection_suspected` pins the card to manual. A1 and A2 stay off until decision 2.

**Learning loop** (each step survives being skipped). Passive labels come from sync; `x` and `p` add more. A pull-out counts against the rule that hid the card. [M2] ≥3 consistent actions with no counter-example in 14 days → a proposed rule in `desk status`. A monthly replay proposes thresholds but never applies them. `hist.*` counts GitHub engagements, never desk opens, and `desk status` flags any author above 40% of TODAY entries for 2 weeks.

## 6. Agent integration

**Inbound.** One zod registry generates MCP (`desk mcp` stdio shim → 0600 unix socket; MCP 2025-11-25 and 2026-07-28), the CLI (`--json`), and HTTP on `http://localhost:47823` (bearer from a 0600 file, Host/Origin checks, strict CSP). The pane uses HTTP as actor=you. CLI and MCP writes are recorded as agents (`agent:cli`, `agent:<client>`): invariants bind them, they show in "Agent actions 24h", and they can be undone. Slow work returns a `job_id`.

| Tool                       | Profiles                    | Shape                                                                | Ships |
| -------------------------- | --------------------------- | -------------------------------------------------------------------- | ----- |
| list_cards                 | read, work                  | `{bucket?[], kind?, limit} → {cards[], counts, as_of}`               | M1a   |
| get_card                   | read, work, room (its item) | `{id} → card + items (*_untrusted fenced)`                           | M1a   |
| explain                    | read, work                  | `{id} → {bucket, trace[], flip_conditions[]}`                        | M1a   |
| snooze / done / set_bucket | work                        | `{ids, …} → {action_id}` or `invariant_protected`                    | M1b   |
| undo                       | work                        | `{action_id}`; the caller's own actions only                         | M1b   |
| test_rule / propose_rule   | work                        | `{toml} → {moves[], recall_delta}` / `→ {rule_id, status: proposed}` | M2    |
| get_diff                   | work, room (its item)       | `{id, path?} → {head_sha, base_sha, diff_untrusted}`                 | M3    |
| draft_review               | work, room                  | `{item_id, head_sha, body, comments[]} → {draft_id}`, local only     | M3    |
| report_result              | room                        | `{verdict, summary, draft_id?} → {ok}`, bound to the handoff         | M3    |
| analyze / get_job          | work                        | `{id} → {job_id}`; runs after you confirm in the pane                | M3    |
| list_sessions              | work                        | `{item_id?} → {sessions[]}`                                          | M3    |

Resources `desk://inbox`, `desk://card/{id}`; prompts `/desk:triage`, `/desk:review <id>` (work). The `/desk:review` template ends with `draft_review` and says never to post, comment or approve on GitHub. **No GitHub write tool exists.**

**Profiles** come from `CLAUDE_PROJECT_DIR`, which Claude Code sets for every MCP server (plugin ones included), never from the shim's cwd.

| Project dir                                                                                                | Profile                                                                                      |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `~/ReviewDesk/rooms/<key>@<sha7>/`                                                                         | `room`: read + draft/report, for that one item. No triage, so an injected PR can't hide asks |
| A repo whose origin matches `[trust] work_origins` (default `github.com/getsentry/`, `github.com/gricha/`) | `work`: read, triage, draft, propose rules. Invariants bind                                  |
| Anything else, or no `CLAUDE_PROJECT_DIR` (Codex, T3)                                                      | `read`                                                                                       |
| Analyzers                                                                                                  | None (`--strict-mcp-config`, no servers)                                                     |

Rooms use the plugin's server; no per-room `.mcp.json`. Your uid is one trust domain: profiles keep agents in their lane, and §7 holds the hard limits.

**Outbound: three narrow interfaces, one backend each.**

```
Launcher { launch(room, prompt) }          // copy-prompt (Desktop) | claude-cli:// deep link (terminal)
Tracker  { ingest(hook); link(session) }   // plugin hooks; cwd → room, branch → your PR head
Runner   { run(input, schema, budget) }    // tool-less claude -p
```

Rejected: ACP everywhere (can't strip env; codex-acp force-trusts cwd), the Agent SDK ("should use API key"), `claude --bg` (needs workspace trust; not in Desktop's sidebar).

**Handoff sequence (M3)**

```
`h` → row [1 brief · 2 draft comments · 3 fix my PR]              Esc cancels
deskd: fetch mirror @head_sha → build room (§7) → Handoff{id, ready}
pane: [Copy prompt] [Reveal room]    prompt = template(handoff_id), no PR text
you: Desktop → new session in the room folder → paste → Enter      ← the launch
room session ─get_card/get_diff─► ─draft_review─► draft_id ─report_result─► verdict
hooks (SessionStart, Notification, Stop) ─► desk ingest (ids only)
  card: working ⇄ needs input → "done · skim ~5m · draft 3 comments" | idle_no_report
`c` → Read draft (plain text, secret-scanned) → `c` again copies → GitHub Files tab
you submit on GitHub ─► sync: sent_detected ─► card closes
head moves ─► handoff stale: "re-run on new head?"
```

In a terminal, `claude-cli://open?cwd=<room>&q=<prompt>` opens a session with the prompt filled in, not sent.

**Agent waiting on you [M3].** Hooks track only linked sessions (cwd is a room, or branch is your PR head). `needs_input` badges the card, and becomes an `AGENT` card on your PRs or after 10 min. No pushes into sessions.

**Desk launcher (not in v1).** A pinned Desktop session whose mod calls `start_session` on a keypress, removing the paste. Gated on decision 1, ≥3 handoffs/wk for 2 weeks, and spike check 10. Known constraints:

- The child's model is capped at the caller's, so Desk runs on the room model (Sonnet).
- The mod must consume Desk's wake turns (`session.receive {consumed}` or `prompt.submit {drop}`, origin `sdk`), or fail closed to a disposable launcher.
- `use_worktree:false`, a templated `background` (≥80 chars), `permission_mode:"default"`, name ≤24 chars `[a-z0-9-]`.
- Desk itself denies `SendMessage`, `ListAgents` and `Agent`.
- Nonce, cwd and mode checks run inline before `$.tool.call` (a mod's hook can't see its own calls); Desk's hook denies `start_session` to everyone else. After an Esc, launches may be refused until you type in Desk.

## 7. Safety

| Area                | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Never posts         | v1's client is `GhRead` (W0): GET + GraphQL queries; `mutation` is rejected. No write module exists. W1 (mark notifications done): M4+, opt-in, native confirm, never `/repos/*/subscription`. W2 (pending review) and W3 (anything public): no code path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Untrusted text      | Only in `*_untrusted` fields: fenced in prompts, plain text in every UI. Why-lines, notifications, status text and launch prompts are templates over ids and signals. Topic chips use paths and identifiers, never title or body. The shipped mod never calls `$.prompt.submit`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Rooms (others' PRs) | **Build:** in `~/ReviewDesk/rooms/` (visible, so Desktop's folder picker reaches it), `git archive <head>` from the desk mirror, whose `info/attributes` is `* -export-subst -export-ignore`, so the PR's `.gitattributes` can't hide files or inject text. Symlink entries (mode 120000) are dropped; the build fails if `find src -type l` finds any. No checkout, no hooks. `**/CLAUDE.md`, `CLAUDE.local.md`, `**/AGENTS.md`, `.github/copilot-instructions.md` come from base_sha. Stripped: `**/.claude/`, `**/.mcp.json`, `.codex/`, `.agents/`, `.cursor/`, `.vscode/`, `.envrc`, `mise.toml`, `.devcontainer/`. **Desk-written `.claude/settings.json`:** `permissions.blockReadsOutsideWorkingDirectories: true`; default mode; deny `Bash`, `WebFetch`, `WebSearch`, `SendMessage`, `ListAgents`, `Agent`, `mcp__ccd_*`; `crossSessionInbound: "refuse"`. **Proof:** spike checks 6–7, then `desk doctor` every release |
| Own-PR fix rooms    | Writable mirror worktree; `core.hooksPath=/dev/null`, `GIT_CONFIG_GLOBAL=/dev/null`, no `GH_TOKEN`, empty `GH_CONFIG_DIR`. Bash prompts. Deny `SendMessage`, `ListAgents`, `Agent`. Reviewer comments fenced. You push. Your clones are never touched (sentry's post-checkout runs `devenv sync`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| A3 runner           | `--restricted` alone keeps Read, Glob, Grep and SendMessage, hence `--tools ""`. Empty per-job folder, env {PATH, HOME}, own process group, per-run budget                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Drafts              | Agent-written, so untrusted. `c` shows fenced plain text first; a second `c` copies. A secret scan (gh, ssh, AWS, Anthropic token shapes, private keys, the desk bearer) blocks the copy and names the line. Unread text never reaches the clipboard                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Local API           | Anything running as you can read the bearer, so it is not a boundary. It reaches only local triage state and room builds: no GitHub writes, no launches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GitHub auth         | `gh auth token` in memory, refreshed on 401/403; SSO banner. ≤10% of the shared 5000/h; non-urgent tiers pause below 40%                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| LLM billing         | Only you start runs (`i`, rooms), in unmodified Claude Code on your plan. `auto_llm_repos = []`. No OpenRouter for private source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Data at rest        | `desk.db` (WAL, 0600): metadata, signals, ≤2KB untrusted excerpts, verdicts, drafts; no diffs. Untrusted text purged 30 days after close; rooms deleted 48h after handoff; logs hold ids                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## 8. Runtime

```
launchd (KeepAlive) ─ deskd: Node 24 LTS, Hono, node:sqlite (thin typed layer), single-instance lock
  ├ sync: one serialized GhRead client, token bucket
  ├ core: decide() per changed item → caps → view-models
  ├ jobs [M3]: sqlite queue, ≤2 concurrent (A3, git fetch), each in its own process group
  ├ mirrors [M3]: bare, blobless, hookless, attributes neutralized
  ├ unix socket 0600 ◄ CLI, `desk ingest` hooks, `desk mcp` shims
  └ http://localhost:47823 ◄ pane; the List page only if mods fail
```

PATH Node is 22.22.0 (nvm): install Node 24 LTS and run with `--disable-warning=ExperimentalWarning`. No ORM; stable Drizzle has no node:sqlite driver.

| Tier                                         | Active (activity <5 min)  | Idle      | Quiet hours |
| -------------------------------------------- | ------------------------- | --------- | ----------- |
| Notifications (If-Modified-Since; 304s free) | max(60s, X-Poll-Interval) | Same      | 5m          |
| Search, collab-watch, your PRs, your repos   | 60s                       | 5m        | 15m         |
| Detail (aliased `node(id:)`, ≤20)            | On change                 | On change | On change   |
| `hist.*`, affinity                           | Nightly 03:00, or on wake |           |             |
| Mirrors [M3]                                 | Before a room or A3       |           |             |

**Sleep and wake.** A clock jump >2× the tick is a wake: alerts mute 120s, one catch-up sync runs, snoozes re-evaluate, and due time snoozes fold into one "While away" line. A missed 09:30 summary arrives on wake before 12:00. Stale-head A3 jobs drop; their handoffs go `stale`.

| Failure           | Behavior                                                                   |
| ----------------- | -------------------------------------------------------------------------- |
| 401 / SSO         | Pane banner; reads pause; cards marked stale                               |
| Rate <40%         | Pause detail, collab-watch, mirrors                                        |
| Search lag        | A notification event forces a detail refresh                               |
| mergeable UNKNOWN | Re-query; never decide on it                                               |
| deskd crash       | launchd restarts; WAL; orphan process groups reaped; nightly `VACUUM INTO` |

**Observability.** `desk status`: one line, eval numbers, rule proposals, concentration flag. `desk doctor`: versions, SSO, mods, hotkeys, profiles, the room probe (outside Read refused; Bash and SendMessage absent), `claude -p` auth. `desk eval` (weekly): recall at +4h, cards/wk, on-screen p50/p90, false negatives per rule, live-vs-replay drift.

## 9. MVP plan

| M                                 | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Gate: continue if / kill if                                                                                                                                                                                                             | Effort             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **M0** Day 0                      | Build the throwaway spike plugin (check 0). Then you, ~45 min: run checks 1–10, send the team ask, fix auth                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Each check picks a fallback                                                                                                                                                                                                             | 0.5 dev-d + 45 min |
| **M1a**                           | **Day 1:** deskd-lite: union search, collab-watch, your PRs, your repos; `hist.*` from a nightly reviewed-by/commenter search; affinity from your merged PRs. V1 rules as a TS function + golden test vs `sim.py` (recall 0.80±0.02, 22.3±2 cards/wk), run with author + scope grouping as the replay did; series grouping is judged by its use-number. **Day 2:** List pane (NOW, TODAY, MINE row, one summary line), bar keys, status line, `osascript` alerts. **Day 3:** sqlite dispositions, snoozes, sent_detected, first run, Audit and Mine tabs, `desk ls/done --json`, read-only MCP | Build check: golden test passes                                                                                                                                                                                                         | ~3.5 dev-d         |
| **Use weeks 1–2**                 | You triage from `/desk`; the pane is frozen in week 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | **Continue:** pane used ≥4 of 5 workdays, ≤2 FYI pull-outs/wk, 0 hidden human asks, on-screen p50 ≤7 cards, MINE ≤3 cards/day. **Kill:** you drift back to /pulls → keep notifications, CLI, MCP                                        | —                  |
| **M1b** (week 2, no pane changes) | MCP `work` profile + `CLAUDE_PROJECT_DIR` selection, Codex config (`read`), `desk status`/`eval`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | ≥1 MCP call/day from another session in week 3, else cut work tools, keep read                                                                                                                                                          | ~1.5 dev-d         |
| **M2** (on demand)                | TOML+CEL loader, dry run, `test_rule`/`propose_rule`, `desk rules on`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Built at your first rule change; golden test still passes                                                                                                                                                                               | ~1.5 dev-d         |
| **M3** weeks 3–4                  | Monday card, mirrors, rooms, copy-prompt + deep link, `draft_review`/`report_result`, Read draft + secret scan, A0, A3 on `i`, hooks tracker                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **Continue:** ≥3 handoffs/wk with a usable verdict or draft; 0 unintended writes; 0 launches without your keypress; room probe passes. **1–2/wk:** keep copy-prompt, add nothing. **0 for 2 weeks:** remove `h`; keep `i` if used ≥2/wk | ~4 dev-d           |
| **M4+**                           | Not-now items, each with its own use-number                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | —                                                                                                                                                                                                                                       | —                  |

Use-numbers for small features: series grouping ≥1 series card/wk (else scope only); `w` ≥1/wk in weeks 1–2 (else off the card); Monday card opened on ≥2 of its first 4 Mondays (else auto-apply only); rule proposals ≥1 activated in the first month after M2 (else stop proposing). The old "beat the usual-author baseline by +10pp" gate is gone: the author prior _is_ that baseline ([evidence](evidence.md#the-baseline-gate)). A failed use gate kills triage complexity, not the pane, MCP or handoffs.

**Day-0 spike checklist** (~30 min to run; results feed `desk doctor`) 0. [ ] **Build** (~0.5 dev-d, before Day 0). A throwaway plugin in `spike/`: a `/desk` pane with one Button (hotkey `e`); a `/desk-status` command that sets then clears `$.ui.status`; `$.http.fetch` plus a `Link` to `http://localhost:47823/health`, served by a ~5-line node server; a stdio MCP server that logs `CLAUDE_PROJECT_DIR` to a file. No `$.prompt.submit`, no monitors. Install it.

1. [ ] **Pane.** `/desk` in a Desktop Code-tab session. _Pass:_ a pane opens beside the chat. _Fail →_ M1a builds the List at `http://localhost:47823` instead.
2. [ ] **Hotkeys.** Press a Button's hotkey (`e`) with the pane focused. _Pass:_ the callback runs; Desktop shows the key. _Fail →_ a click/Enter-only pane.
3. [ ] **Status line.** `$.ui.status('desk: ●2')`, then `$.ui.status(undefined)`. _Pass:_ shows as `⚠ desk: ●2`, then clears. _Fail →_ notifications carry the counts.
4. [ ] **Transport.** `$.http.fetch('http://localhost:47823/health')` and a `Link` to it. _Pass:_ 200; the link is clickable. _Fail →_ the pane calls `desk … --json` via `$.process.run`.
5. [ ] **Notifications.** Enable Script Editor in System Settings › Notifications; run `osascript -e 'display notification "test" with title "Desk"'`, then again under a Focus mode. _Pass:_ arrives; suppressed under Focus. _Fail →_ status line only.
6. [ ] **Room reads.** A never-opened folder with the §7 settings and a symlink `notes → ~/.ssh/known_hosts`. In a Desktop session there, Read `~/.ssh/known_hosts` by absolute path, then `notes`. _Pass:_ both refused, no prompt. _Fail →_ no rooms; `i` only.
7. [ ] **Room tools.** In that session, try Bash, WebFetch, SendMessage. _Pass:_ all absent. _Fail →_ as 6.
8. [ ] **Profile signal.** Sessions in the room, `~/code/sentry` and `/tmp`; read the spike server's log. _Pass:_ three distinct `CLAUDE_PROJECT_DIR` values. _Fail →_ use MCP `roots/list`; if that fails too, everything gets `read`.
9. [ ] **Runner.** `claude auth login && claude update`, then from an empty folder: `claude -p --restricted --tools "" --strict-mcp-config --json-schema '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}' --no-session-persistence "reply ok"`. _Pass:_ prints `{"ok":true}`. _Fail →_ A3 waits; `i` hidden.
10. [ ] **Continuation (Desk launcher only).** From a test session, `start_session` into a never-opened folder (`permission_mode:"default"`, `use_worktree:false`) and let the child end a turn. Is the parent continued, via `session.receive` or `prompt.submit` (origin `sdk`), and can a mod consume it? _None →_ no wake handling. _Unconsumable →_ disposable launcher, or copy-prompt for good.

**Your first weeks** (days from M1a shipping; every chore has a default)

| When          | Task                                                | If skipped                 |
| ------------- | --------------------------------------------------- | -------------------------- |
| Day 0, 45 min | Run the spike, send the team ask, fix auth          | M1a waits on checks 1–5    |
| Days 1–5      | Triage only from `/desk`; review on GitHub as usual | —                          |
| Day 3, 5 min  | Skim Audit; `p` anything you should have seen       | No change                  |
| Day 5, 2 min  | One line on what it missed, one on noise            | Judged on use numbers only |

**Team ask** (a draft; you send it):

> Could we enable code review assignment for @getsentry/machine-learning-ai (1 reviewer, load-balanced, notify only the assignee) and narrow seer's `*` CODEOWNERS line? Most seer PRs ping all 21 of us. The team gets ~157 requests a week, and I engage with ~6% of them.

If they say yes, re-run the replay before tuning anything.

## Not now

- **Surfaces:** a window (Electron, tray, global hotkey), a web inbox (unless mods fail), MCP Apps, toasts, the band, a 14:00 digest, Focus mirroring, click-through notifications (terminal-notifier).
- **Sessions:** the Desk launcher, `claude --bg`, pushes into sessions, Desk as a chat companion, Codex/T3 launchers.
- **GitHub writes:** W1 notification cleanup.
- **Analysis:** A1, A2, background A3, on-device models, Agent SDK, ACP, Codex app-server, an API-key pool.
- **Triage:** chain grouping, CODEOWNERS line matching, topic rules (until an as-of replay passes), spot-checks.
- **Sources:** Slack/junior asks (37% of engagements had no request), Linear, teammate presets, a dotagents bundle.
- **Dropped:** "remove me from review", W2 pending reviews.

## Risks and open items

| Risk                                                           | Mitigation                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| azulus is 45% of engagements; recall for everyone else is 0.65 | Monthly replay; concentration flag                                      |
| Labels measure habit, not value                                | Pull-outs; `desk eval` drift                                            |
| 37% of engagements had no request                              | collab-watch recovers 57 of 95; your-repos source; Slack later          |
| Mods sit behind a rollout flag                                 | Probed, with a fallback; v1 doesn't use `start_session`                 |
| Prompt injection via PR text                                   | Fenced fields, confined shell-less rooms, no write path, scanned drafts |
| Your uid is one trust domain                                   | No write code; rooms can't read out; the bearer gates nothing dangerous |
| 5000/h GitHub budget shared with all your agents               | ≤10% target; pause below 40%                                            |
| Busy weeks; build creep                                        | Defaults for every chore; timeboxes and kill rows                       |

**Open items (TODO)**

- Confirm `blockReadsOutsideWorkingDirectories` from a room's project settings holds in a Desktop-launched session (spike 6).
- Confirm `CLAUDE_PROJECT_DIR` reaches plugin MCP servers in Desktop (spike 8).
- MINE volume is unmeasured (outside the replay): log it per day in week 1.
- `state.blocked` with CI and conflicts is live-only: compare TODAY volume to replay in `desk eval`.
- Re-test topic hits from paths/identifiers as-of in the replay before any topic rule.
- T3 MCP passthrough and Codex-app MCP Apps are unverified.

## Decision log

| Topic                        | Choice                                                        | Why                                                                                                                   | Rejected                                         |
| ---------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Surface                      | Mod pane + status line in Desktop                             | Where you work; 0 tokens                                                                                              | Localhost tab, Electron, TUI                     |
| Web page                     | Mods-fail fallback only                                       | A second surface (scope fit)                                                                                          | A Rules/Audit/Settings web app                   |
| Codex/T3                     | MCP only                                                      | No UI host; T3 unverified                                                                                             | MCP Apps                                         |
| Caps                         | ≤3/≤6 unprotected                                             | V1 replay; honest header                                                                                              | TODAY 8                                          |
| Shipped rules                | V1 = P9 + human ask → NOW + bot-ask floor LATER               | One variant for TOML, wireframes, gate                                                                                | The first draft's TOML (8 silent deltas from P9) |
| Size term                    | Kept                                                          | Dropping it cost 1.4pp                                                                                                | "No size penalty"                                |
| Topics                       | Chip from paths/identifiers                                   | Leaky +5pp; PR text is attacker-controlled                                                                            | topic → TODAY                                    |
| Rule engine                  | TS function; TOML+CEL at first change                         | Nobody edits CEL in week 1                                                                                            | TOML+CEL in M1; YAML; JSON                       |
| Grouping, CODEOWNERS         | Series (bot-requested, one author) then scope; CODEOWNERS cut | Series catches azulus ×12; no rule reads the matched line                                                             | Chain; parse at baseRefOid                       |
| Repos, own PRs               | MINE source, cap-exempt, logged                               | You asked; outside the replay                                                                                         | Omit; under TODAY cap                            |
| First run, Monday            | One undoable batch; ≤5 decisions, auto by Wednesday           | Busy-week survival                                                                                                    | Open-ended sweep                                 |
| Analyzers                    | A3 on `i`; on-device only as a decision-2 option              | Billing open; A1 lift leaky                                                                                           | Background LLM                                   |
| Launch (critics split)       | Copy-prompt + deep link; Desk launcher deferred               | Scope: always-on reinterpreted. Host: model cap, new folders may not wake. Red-team: continuation text untrusted      | M3 Desk launcher; `claude --bg`                  |
| Desk model, if built         | Room model; mod drops wakes or fails closed                   | Child capped at caller's model                                                                                        | Haiku Desk                                       |
| Room reads (critics split)   | `blockReadsOutsideWorkingDirectories` in room settings        | Red-team also asked for `--restricted`: Desktop can't pass flags, and it skips the room's settings. Spike 6 proves it | Prompt-gated reads                               |
| MCP profile (critics merged) | `CLAUDE_PROJECT_DIR`; `work` for trusted origins only         | Host: server cwd isn't the project. Red-team: untrusted CLAUDE.md drives triage                                       | By cwd; broad `work`                             |
| Pane transport               | HTTP as actor=you                                             | Via MCP, your own keys hit `invariant_protected`                                                                      | `$.mcp.call`                                     |
| Session push                 | None                                                          | Sidesteps `crossSessionInbound`                                                                                       | Inbox socket                                     |
| Notifications                | `osascript`, NOW + 3 summaries, staleness at flush            | Focus for free                                                                                                        | Toasts; 15-min rule that dropped batches         |
| Keyboard                     | 5 keys; cards are Buttons                                     | One-char hotkeys; Enter hits focus                                                                                    | `j`/`k`; 16-key bar                              |
| Stack                        | Node 24, Hono, node:sqlite, no ORM                            | Stable Drizzle lacks the driver                                                                                       | Drizzle rc                                       |
| Sync                         | Union search 60s/5m/15m, If-Modified-Since, aliased detail    | <10% budget                                                                                                           | Events API, webhooks                             |
| Snoozes                      | Level-triggered predicates                                    | Sleep loses nothing                                                                                                   | Timers                                           |
| Auth                         | `gh auth token` in memory                                     | Notifications need OAuth/classic                                                                                      | GitHub App, fine-grained PAT                     |
| Writes, billing              | W0 only; you-initiated LLM                                    | Never-post is structural; policy open                                                                                 | W2 pending reviews; OpenRouter                   |
| Slack                        | Deferred                                                      | Request sources first                                                                                                 | —                                                |
| Gate                         | Golden test, then week-2 use                                  | +10pp over usual-author is unreachable                                                                                | "Beat usual-author by +10pp or stop"             |
