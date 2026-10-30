# Where Review Desk is going

Review Desk is the owner's control center for mundane engineering work, and a partner for Claude Code, Codex or whatever agent harness they use. Most of what reaches an engineer is noise; the desk's job is to show only what needs them, sorted by priority, and to let agents handle the rest.

## The model

```
connectors ──events──▶ event log ──▶ judge ──▶ feed items (open / resolved) ──▶ UI, coordinator
   ▲                                  ▲  rules (structured, cheap)                │
   │                                  └─ policy (prose, judged by the agent)      │
   └──────────────────── actions (approve, comment, push) ◀───────────────────────┘
```

- **Connectors** are data accessors. GitHub is the first; Linear, Slack and Sentry can follow. A connector turns its source into a continuous stream of events (review requested, someone else approved, CI failed, new comment, mention, merged) and snapshots of the items they concern.
- **The event log** keeps every event. The UI shows an item's recent activity; the coordinator reads the log to react.
- **The judge** decides what reaches the feed: structured rules per connector first (cheap, deterministic: "only repos X, Y, Z or direct references"), then the agent for the gray zone, guided by a prose policy the owner writes by talking to an agent.
- **The feed** is one list sorted by priority. Items resolve on their own when the world resolves them (someone else approved, merged, closed, no longer requested) and come back if that stops being true.
- **Lanes**: Review (other people's PRs, each arriving with an AI summary, concerns and notes on the changes) and In flight (the owner's own PRs they've marked done; babysitter agents keep CI green and handle comments, and hand back only decisions that need the owner).
- **The coordinator** is a Claude Code session the desk starts at launch, wired to the desk through MCP and the CLI. It curates the feed, maintains the policy and config when asked in prose, and runs the babysitters.
- **Review in the desk**: Linear-style inline PR review with Pierre's `@pierre/diffs`, AI notes on the changed code, one key to approve.

## Decisions (defaults; the owner can change any of them later)

1. **Events without webhooks.** GitHub webhooks need a public URL and admin rights. The GitHub connector polls the notifications API (cheap, about every 60 s, `If-Modified-Since`, honours `X-Poll-Interval`) to learn what changed, refreshes those items, and derives events by comparing snapshots. A periodic search pass reconciles. A webhook relay can plug into the same event log later.
2. **Writing to GitHub.** Actions the owner clicks are allowed: approve, and later request changes and comment. Babysitter agents may push commits to the owner's own PR branches and re-run CI. Agent replies to reviewers are drafts the owner sends with one click (a setting can let them post). Agents never approve, merge, or comment on other people's PRs. Every write goes through one module with an allowlist and is logged.
3. **The coordinator.** The desk starts `claude --bg` (or the configured agent's equivalent) at launch with the desk's MCP server. It waits on `desk_events` (a long-poll tool that returns when something happens), so it is event-driven today. The owner can see it with `claude agents` and talk to it with `claude attach`. Claude Code's push "channels" would be cleaner but are a research preview. Fallback: one `claude -p` per batch of events.
4. **AI cost.** Structured rules run first, so only items that would reach the owner get an AI summary and review. Results are cached per head commit, and generation runs a couple at a time.

## Slices

1. Connector interface and event log; GitHub sync on top of them (notifications + reconcile); auto-resolve.
2. Prose policy and the judge; the coordinator session, able to edit policy and config.
3. PR review view: Pierre diffs, AI summary, concerns and notes on changes, approve.
4. In-flight lane and babysitter agents.
