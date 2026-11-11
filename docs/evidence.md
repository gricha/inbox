# Inbox: evidence

The facts behind [design.md](design.md), each with its source. It's a snapshot taken on 2026-10-26: read it to see why
the original design chose what it did, not as a description of the desk today. Bucket names are that design's (NOW,
TODAY, LATER, FYI).

Sources: **verified locally** means checked read-only on the owner's Mac that day. **Research** means that day's research
run (6 reports, a critique, 3 verifications). Nothing was posted to GitHub or changed while gathering this.

## 1. Backtest (replay)

### Method

| Step       | How                                                                                                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window     | 2026-05-01 to 10-26, org getsentry. Read-only: ~880 GraphQL points, 0 REST search calls, ~60 REST GETs                                                                                                                       |
| Engagement | `is:pr org:getsentry {reviewed-by\|commenter}:gricha -author:gricha updated:>=2026-05-01`: 374 PRs, 359 with your first review or comment in the window                                                                      |
| Population | every PR created 2026-04-15 to 10-26 in seer, sentry, ops, getsentry and sandbox-router (searches sliced by date to stay under 1,000 results). 4,048 not by you had a machine-learning-ai ReviewRequestedEvent in the window |
| Route      | half-monthly CODEOWNERS snapshots at historical commits, last match wins                                                                                                                                                     |
| Affinity   | files from your merged getsentry PRs in the 120 days before each request (no future leak); lock, generated and hub files excluded; tests count half                                                                          |
| Replay     | 30-minute inbox snapshots with caps. A card is one author and commit scope within 72h. Signals computed as of each snapshot. Tuned on May–Jul, tested on Aug–Oct                                                             |
| Recall     | the share of your 215 in-inbox engagements (18 direct + 197 team) shown in NOW or TODAY before you engaged                                                                                                                   |
| V1         | the shipped rules, replayed by wrapping `sim.py`; defined in [research/backtest/README.md](../research/backtest/README.md)                                                                                                   |

### Key numbers

| Metric                            | Value                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| PRs you engaged with              | 359; mean 13.3/wk (median 11, range 2–30)                                                                           |
| Where engagement came from        | team-only 202 (56%), unasked 134 (37%), direct 23 (6%)                                                              |
| azulus                            | 161 of 359 engagements (45%); 103 of azulus's 131 requested PRs engaged (79%)                                       |
| ML-team request inflow            | 157/wk (seer 88, sentry 57, ops 11)                                                                                 |
| Base rate                         | 227 of 4,048 = 5.6% (seer 7.5%, sentry 3.3%, ops 2.5%, sandbox-router 0%)                                           |
| By route                          | direct 31%, seer catch-all `*` 8.4%, specific path 3.2%, no ML line 0.7%                                            |
| By author                         | human 5.8%, sentry-junior 9.8%, sentry app 1.4%, dependabot 0 of 71                                                 |
| Direct asks                       | by a human: 21 of 36 engaged (58%). By a bot: 0 of 18 (14 created on the last day, so 0 of the 4 that matured)      |
| Time to engage                    | team-only median 0.7h, 71% within 4h, 90% within 24h (n=197); direct median 1.6h (n=18)                             |
| Request to close                  | median 5.2h, p90 165h                                                                                               |
| File affinity (weighted)          | 0: 2.7% · 1–2: 9.8% · 3–5: 16.4% · 6+: 23.6%. AUC 0.71; area-level 0.55 without azulus                              |
| Overlap with one of your open PRs | 17.6% vs 4.3%                                                                                                       |
| Size                              | ≤10 lines 3.1% … >1000 lines 9.6%                                                                                   |
| Hide rules, engagement at entry   | approved-by-others 0 of 184, dependabot 0 of 71, fan-out 1.8%, agent-low-aff 3.6%, no affinity 2.7%, area-only 2.7% |
| collab-watch source               | +4.0 PRs/wk, 56% engaged; recovers 57 of 95 unasked engagements in the focus repos                                  |

### Variants

| Variant                                                           | Recall (train / test)                               | Cards/wk    | PRs/wk      | On screen 9am | Precision   |
| ----------------------------------------------------------------- | --------------------------------------------------- | ----------- | ----------- | ------------- | ----------- |
| R0: first-draft (dry-run) rules                                   | 0.61 (0.59 / 0.63)                                  | 26.5        | 37.7        | 7.2           | 0.11        |
| R0t: that TOML as literally written                               | 0.57 (0.59 / 0.55); direct 8 of 18                  | 26.1        | 36.9        | 7.2           | 0.10        |
| R0 + any author you engaged with in 28d (usual-author baseline)   | 0.78 (0.77 / 0.80)                                  | 26.3        | 40.7        | 7.7           | 0.12        |
| R0 + close collaborator (≥3 engagements, ≥30% of their PRs, 60d)  | 0.73 (0.76 / 0.70)                                  | 26.9        | 38.7        | 7.2           | 0.13        |
| R0 with affinity ≥2 files                                         | 0.48 (0.41 / 0.55)                                  | 20.8        | 28.6        | 5.6           | 0.13        |
| R0 with directory affinity ≥1                                     | 0.70                                                | 29.2        | 43.7        | 8.2           | 0.10        |
| R0 + topic keywords (A1 stand-in; keyword list leaks the future)  | 0.66                                                | 26.4        | 37.9        | 7.6           | 0.12        |
| R0, TODAY cap 5 / 12                                              | 0.59 / 0.66                                         | 19.4 / 32.2 | 27.3 / 45.4 | 4.9 / 9.0     | 0.14 / 0.10 |
| P6: both author priors + your junior PRs + principal parsing      | 0.81 (0.82 / 0.80)                                  | 27.1        | 41.2        | 7.6           | 0.14        |
| P9: P6 with TODAY cap 6                                           | 0.79 (0.79 / 0.80)                                  | 21.4        | 33.2        | 5.9           | 0.16        |
| **V1: P9 + human ask → NOW + bot ask floored at LATER (shipped)** | **0.80 (0.79 / 0.80); 171 of 215; direct 17 of 18** | **22.3**    | **34.8**    | **6.2**       | **0.15**    |
| V1 without the −10 size term                                      | 0.78 (0.76 / 0.80)                                  | 21.4        | 33.7        | 6.2           | 0.16        |

V1 slices:

- azulus 91 of 91; everyone else 80 of 124 (0.65).
- Engagements ≥4h after the request: 54 of 68 (0.79).
- seer 126 of 156 (0.81); sentry 41 of 52 (0.79).
- Weekly cards: median 21, range 12–37.
- Coverage of all 359 engagements: 171 (48%); about 64% with collab-watch's 57.

### The baseline gate

The plan's gate was: beat "direct ask or usual author" by +10pp, or stop. That gate would fire: the usual-author rule
alone reaches 0.78 at 26.3 cards/wk. The author prior _is_ that baseline, and it ships as rules.

V1 matches its recall (0.80 vs 0.78) with 15% fewer cards (22.3 vs 26.3) and ~1.5 fewer on screen. What the desk adds
is that lower load, protected asks, your PRs and repos, Audit, and handoffs. So v1 is gated on the golden test against
the V1 replay, then on week-2 use.

### Where the replay overrode the first dry run

| Dry run / first brief                       | Replay                                         | v1                                  |
| ------------------------------------------- | ---------------------------------------------- | ----------------------------------- |
| TODAY cap 8                                 | Cap 6 + author prior: same recall, fewer cards | 6                                   |
| No author history                           | The largest single lift                        | `hist.*` rules                      |
| azulus code-mode stack in NOW via a bot ask | Bot asks: 0 of 4 matured engaged               | Top of TODAY via close-collaborator |
| NOW only ≤300 lines                         | No effect; bigger PRs are engaged more         | Removed (the −10 rank term stays)   |
| Team-area → LATER                           | 2.7%, the same as no affinity                  | FYI                                 |
| Asks floored at LATER                       | 8 of 18 direct recall                          | Human asks floored at TODAY         |
| A daily digest                              | 71% engage within 4h                           | Live pane + count                   |

### The queue under V1 on 2026-10-26 (117 open requests)

| Bucket             | Cards   | PRs | Examples                                                                                                                           |
| ------------------ | ------- | --- | ---------------------------------------------------------------------------------------------------------------------------------- |
| NOW                | 2       | 4   | seer#8463 and seer#8949, both vaind asking you                                                                                     |
| TODAY              | 6       | 26  | azulus code-mode series (12 PRs, 11 ready), seer#8427, seer#9093, sentry#128771, wedamija investigations (3 + 6 hidden), seer#8845 |
| Waiting (over cap) | 10      | 13  | vaind's sandbox-router PRs, sentry#128808                                                                                          |
| LATER              | 5       | 16  | blocked PRs touching your files; getsentry#22736 (cursor ask, floored at LATER)                                                    |
| FYI (Audit)        | 35      | 58  | agent-low-aff 14, approved-by-others 6, no signal 6, blocked-not-yours 5, dependabot 2 (21 PRs), fanout 1, stale 1                 |
| MINE               | 2 TODAY | —   | warden#548 (conflicts), junior-prod#415 (no review in 40d); 9 stale PRs in the Mine tab                                            |

The first-run step would move 9 cards (26 PRs) to FYI, nearly all of which the rules hide anyway. LATER goes from 5 to 4.

### Limitations

- **Visible engagement only.** Slack approvals, silent reads and PRs you should have reviewed don't show. The replay
  measures agreement with your habits, which your tooling already shaped (seer/sentry notifications on Ignore since
  2026-06-27).
- **Team requests look active too long.** A teammate's review that satisfies a team request leaves no removal event.
- **CI and mergeability not reconstructed.** Every PR was treated as green and mergeable (27% were failing CI in the dry
  run), so live `blocked` differs from the replay. Stale labels weren't reconstructed either.
- **Approximate inputs.** CODEOWNERS uses half-monthly snapshots. Size and file lists are final-state values; only the
  first 100 files are used. Affinity uses your merged getsentry PRs as a proxy for commit history.
- **Huge PRs.** 85 population PRs had >100 timeline events, so late re-requests on big fan-out PRs could be missed.
- **Cards are a heuristic** (same author, same scope, 72h). Your done, snooze and mute actions aren't modelled. Caps
  apply to all cards, including asks, which are cap-exempt live (about 1.4 asks a week).
- **Right-censoring.** The last two weeks had less time to be engaged. Excluding requests after 10-12 moves the base
  rate from 5.6% to 5.5%.
- **The topic-keyword variant leaks future information.**
- **One author dominates**, and the prior can feed on itself.
- **Focus repos only.** 40 unasked engagements in OSS and tool repos (dotagents, warden, skillet, junior-prod, toolkit,
  .github) are outside the model, as are your own PRs, so MINE volume is unmeasured.
- **Wall-clock time to engage**, with no adjustment for hours, time zones or PTO. The direct sample is small (n=18).

## 2. GitHub data plane

| Fact                                                                                                                                                                   | Source                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Your seer and sentry subscriptions are on Ignore (since 2026-06-27): `/notifications` shows nothing from them, mentions included                                       | Research: `gh api repos/getsentry/{seer,sentry}/subscription`; `gh api '/notifications?all=true&since=2026-10-12'` |
| 212 unread notifications; 188 (89%) point at merged, closed or non-PR subjects                                                                                         | Research: `gh api notifications` plus a GraphQL state lookup per subject                                           |
| 117 open requests: 102 team-only, 13 direct + team, 2 direct-only. 76 reach you only via a catch-all `*` (seer, sandbox-router)                                        | Research: GraphQL search plus read-only CODEOWNERS fetches                                                         |
| Of the 15 direct requests, sentry-junior added 12, cursor 1, a human (vaind) 2                                                                                         | Research: `timelineItems(REVIEW_REQUESTED_EVENT).actor`                                                            |
| `review-requested:@me` 117; `user-review-requested:@me` 15; `team-review-requested-user:@me` 115; `review-involves:@me` 133                                            | Research: `gh api graphql` issueCount probes; docs.github.com, searching issues and pull requests                  |
| PR search has no changed-path qualifier                                                                                                                                | Research: live search (`path:` returns 0)                                                                          |
| The notification reason `review_requested` is the same for team and direct requests                                                                                    | docs.github.com/en/rest/activity/notifications                                                                     |
| A teammate's review on behalf of the team removes the team request. seer/sentry rulesets don't require code-owner review                                               | Research: GraphQL `onBehalfOf` on seer#9089; `gh api repos/getsentry/{seer,sentry}/rules/branches/...`             |
| No API says which CODEOWNERS line matched                                                                                                                              | docs.github.com, about code owners                                                                                 |
| `CheckRun.isRequired` and `StatusContext.isRequired` take `pullRequestId` or `pullRequestNumber`. `ReviewRequest.asCodeOwner` exists. `ISSUE_ADVANCED` is a SearchType | Host-feasibility review: `gh api graphql` introspection                                                            |
| statusCheckRollup is FAILURE on 31 of 117, including non-required checks                                                                                               | Research: GraphQL contexts with `isRequired` on seer#9098                                                          |
| mergeable came back UNKNOWN on 77 of 117 at first fetch                                                                                                                | Research: detail fetch                                                                                             |
| 5,000/h REST and 5,000 points/h GraphQL, shared across all your tokens. Detail for 117 PRs cost 88 points                                                              | docs.github.com rate limits; research: `gh api rate_limit`                                                         |
| `/notifications` answers If-Modified-Since with 304 without using quota, and sends X-Poll-Interval: 60                                                                 | Research: `gh api -i` probes; docs.github.com best practices                                                       |
| The Events API lags up to 6h; webhooks need repo or org admin                                                                                                          | docs.github.com/en/rest/activity/events; docs.github.com webhook forwarding                                        |
| Native stacks exist in the schema, but azulus's 12 code-mode PRs have `stack=null`                                                                                     | Research: GraphQL introspection and query                                                                          |
| Team code review assignment replaces a team request with N assigned members                                                                                            | docs.github.com, managing code review settings for your team                                                       |
| You have 14 open PRs; 9 are drafts or idle >30 days                                                                                                                    | Research: GraphQL `is:pr is:open author:gricha`                                                                    |

## 3. Host capabilities on this Mac

These are about Claude Desktop and the Claude Code CLI as they were that day, which design.md's in-Desktop surface
relied on.

| Fact                                                                                                                                                                                                                                                                                                                                                        | Source                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop's Code tab bundles Claude Code 2.1.308. The PATH CLI is 2.1.267, and its stored credential returns 401                                                                                                                                                                                                                                              | Verified locally: `claude --version`, the bundled binary's `--version`, `claude doctor`                                                                        |
| No managed settings apply. Desktop runs sessions as subscription `max` in your personal org                                                                                                                                                                                                                                                                 | Verified locally: no managed-settings.json or Claude MDM profile; `~/.claude/remote-settings.json` is `{}`; `ps eww` shows `CLAUDE_CODE_SUBSCRIPTION_TYPE=max` |
| Mods work in Desktop (≥2.1.286), not in the 2.1.267 CLI                                                                                                                                                                                                                                                                                                     | code.claude.com/docs/en/plugins/mods/overview; verified locally: `claude plugin test`                                                                          |
| Plugin monitors and custom channels don't run in Desktop's Code tab                                                                                                                                                                                                                                                                                         | Verified locally: strings in the 2.1.308 binary (non-TTY stdout counts as non-interactive)                                                                     |
| Desktop is an MCP Apps host; the terminal CLI is not                                                                                                                                                                                                                                                                                                        | Verified locally: `CLAUDE_CODE_MCP_APPS_HOST=1` in the session env; code.claude.com/docs/en/mcp                                                                |
| Mod hotkeys are one digit or lowercase letter, and Desktop shows the key. Enter presses the focused control; Up and Down move between controls. Panes are ≤45% wide; Esc returns focus                                                                                                                                                                      | code.claude.com/docs/en/plugins/mods/interface, "Keyboard focus and hotkeys"                                                                                   |
| `$.ui.status` lines start with `⚠` and the mod's name                                                                                                                                                                                                                                                                                                       | code.claude.com/docs/en/plugins/mods/api                                                                                                                       |
| In Desktop a `Link` is clickable only for `https:` or `http://localhost`                                                                                                                                                                                                                                                                                    | code.claude.com/docs/en/plugins/mods/interface, "Link in the Desktop app"                                                                                      |
| `permissions.blockReadsOutsideWorkingDirectories` refuses Read, Grep, Glob and LSP outside the working directories in every mode; `true` in any settings file applies                                                                                                                                                                                       | code.claude.com/docs/en/settings-reference                                                                                                                     |
| Without that setting, a read outside the working directory is a prompt, not a block                                                                                                                                                                                                                                                                         | Red-team review: the read-permission resolver in the 2.1.308 binary                                                                                            |
| `--restricted` removes only code-running tools and WebFetch, confines file tools, and loads only managed settings and `--settings`. `--tools ""` disables all built-in tools                                                                                                                                                                                | code.claude.com/docs/en/cli-reference                                                                                                                          |
| SendMessage needs no permission. Deny rules on `SendMessage` and `ListAgents` remove them. `crossSessionInbound: refuse` blocks inbound only                                                                                                                                                                                                                | code.claude.com/docs/en/cross-session-messaging; tools reference (host-feasibility review)                                                                     |
| Claude Code sets `CLAUDE_PROJECT_DIR` in every spawned MCP server's env. Plugin helpers run from the plugin root                                                                                                                                                                                                                                            | code.claude.com/docs/en/mcp                                                                                                                                    |
| `start_session` caps the child's model and effort at the caller's, allows only the caller's permission mode or lower, needs `background` ≥80 chars for a fresh start, and limits names to `[a-z0-9-]` ≤24. It continues the caller when a child ends its turn whether or not `wake_when_done` is set, unless the child's folder was never opened in Desktop | Verified locally: tool schema loaded via ToolSearch (not called)                                                                                               |
| `git archive` honours the tree's `.gitattributes`: `export-subst` writes commit metadata into files, `export-ignore` drops files. A mirror `info/attributes` of `* -export-subst -export-ignore` neutralizes both. Symlinks are archived either way                                                                                                         | Verified locally: git 2.50.1, a throwaway test repo                                                                                                            |
| Agent SDK and `--bg` sessions don't appear in Desktop's sidebar                                                                                                                                                                                                                                                                                             | code.claude.com/docs/en/sessions and agent-view; research verification 1                                                                                       |
| `claude --bg` checks workspace trust; a room `.mcp.json` server prompts before connecting                                                                                                                                                                                                                                                                   | code.claude.com/docs/en/agent-view and permissions (host-feasibility review)                                                                                   |
| `osascript` notifications are attributed to Script Editor and have no click-through                                                                                                                                                                                                                                                                         | Research (medium confidence); not tested, to avoid a permission prompt                                                                                         |
| The Node on PATH is v22.22.0 (nvm). node:sqlite works but prints an ExperimentalWarning                                                                                                                                                                                                                                                                     | Verified locally: `node --version`; research                                                                                                                   |
| Stable drizzle-orm 0.45.4 has no node:sqlite driver; 1.0.0-rc.5 does                                                                                                                                                                                                                                                                                        | `npm view drizzle-orm`, `npm pack --dry-run`                                                                                                                   |
| `@bufbuild/cel` 0.6.1 needs `@bufbuild/protobuf` as a peer. JS numbers bind as double; ints must be bigint                                                                                                                                                                                                                                                  | `npm view @bufbuild/cel` and its README (host-feasibility review)                                                                                              |
| A research-time stub plugin passed `claude plugin validate` on 2.1.308 and 2.1.267. It wasn't carried into this repo: it was a stub (no Buttons, placeholder MCP server) and sent PR titles through `$.prompt.submit`. design §9 check 0 specifies the real spike                                                                                           | Verified locally: file read; research verification 1                                                                                                           |

## 4. Auth, billing and policy

| Fact                                                                                                                                                                                                                                                                                | Source                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| The gh token is a GitHub CLI OAuth token with `repo`, `read:org`, `gist` and `admin:public_key`, already SSO-authorized. It can write, so read-only must be enforced in code                                                                                                        | Research: `gh auth status`; `gh api -i` headers                                          |
| Notification endpoints reject fine-grained PATs and GitHub App tokens. The narrowest classic scope, `notifications`, also allows repo watch/unwatch. Marking read or done can't be undone                                                                                           | docs.github.com/en/rest/activity/notifications; OAuth scopes doc                         |
| A pending review is invisible to others, but creating one needs PR write, which can also submit and approve                                                                                                                                                                         | docs.github.com, reviewing proposed changes; fine-grained PAT permission tables          |
| getsentry has SAML SSO. With a linked identity, only authorized tokens work                                                                                                                                                                                                         | Research: `/orgs/getsentry/sso` returns 200; docs.github.com SSO authorization           |
| End users may use their subscription in the unmodified Claude Code binary. Agent SDK developers "should use API key". Plan limits assume ordinary individual use                                                                                                                    | code.claude.com/docs/en/legal-and-compliance; code.claude.com/docs/en/agent-sdk/overview |
| In `-p` mode, `ANTHROPIC_API_KEY` overrides the subscription. `-p` runs a folder's hooks and `.mcp.json` even if the folder was never trusted                                                                                                                                       | code.claude.com/docs/en/authentication and headless                                      |
| Sentry's guidance conflicts: the Claude Usage Guide says Okta enterprise accounts only; the Virtual Cards guide allows personal Max; the OpenRouter guide covers non-core use. Claude Code and Codex are approved for private source; OpenRouter is not in the Approved AI Tools DB | Research: Sentry Notion pages of those names                                             |
| codex-acp force-trusts the session cwd. Codex app-server auth "has never been permitted for commercial or hosted services"                                                                                                                                                          | Research: codex-acp v2.3.0 source; learn.chatgpt.com app-server docs                     |
| claude-agent-acp defaults `settingSources` to user, project and local, and merges env over `process.env`                                                                                                                                                                            | Research: claude-agent-acp v0.97.0 `src/acp-agent.ts`                                    |

## 5. Landscape

- **GitHub's /pulls dashboard** (GA 2026-07-09): inbox sections, saved views, new qualifiers; no API, no path filter.
  (github.blog changelog)
- **gh-dash 4.26**: YAML search sections plus shell keybindings. About 40% of the desk in an afternoon, as a stopgap.
  (gh-dash docs)
- **CodeRabbit Triage** (beta): deterministic workflow state, but excludes team requests and can't match paths or
  CODEOWNERS. (coderabbit.ai blog and docs)
- **Graphite, Octobox, Linear, Reviewable, Aviator**: sections, done-until-new-activity, snooze until a time or
  activity, whose-turn lists. (their docs)
- **T3 Code**: a control surface over several agents. Its MCP server is read-only by default; its MCP Apps render only in
  Codex threads from 0.1.0 (you had 0.0.40). (github.com/pingdotgg/t3code docs)
- **Codex**: app-server JSON-RPC; `codex mcp-server` was removed. (learn.chatgpt.com)
- **Churn**: Vibe Kanban sunsetting, Terragon shut down, Crystal became Nimbalyst, Superset became Paradev.
  (`gh repo view`)
- **Gap**: nothing found ranks team requests by local signals such as author history, affinity or your open PRs.
- **Patterns borrowed**: whose-turn plus reason codes, deterministic first, done-until-new-activity, snooze-until-event,
  a hard cap on the top bucket, agent sessions as attention items.

## 6. Design lineage

- Three proposals, three judges: evidence-first (107), standalone-first (98), embedded-first (87). Each won one judge's
  lens.
- design_v1 = evidence-first plus grafts: from embedded-first the in-Desktop surface, the host spike and level-triggered
  snoozes; from standalone-first the Launcher/Tracker/Runner split, review rooms, series grouping and the read-only
  GitHub type.
- Three reviews of design_v1 produced v2:
  - **Red-team**: read confinement for rooms, `git archive` attribute and symlink handling, profiles for untrusted
    repos, draft laundering, topic matching on PR text, the spike's `$.prompt.submit`.
  - **Host feasibility**: the `start_session` model cap and wake rule, SendMessage in rooms, `--restricted` not being
    tool-less, MCP profile selection, keyboard limits, Drizzle, CEL, `osascript`, `isRequired` batching.
  - **Scope fit**: the four deviations, missing repo management, an overbuilt M1, the rule-set mismatch with P9,
    busy-week survival, cutting the web page.
