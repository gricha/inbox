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
- **The event log** keeps every event. The UI shows an item's recent activity; the coordinator reads it each tick.
- **The judge** decides what reaches the feed: structured rules per connector first (cheap, deterministic: "only repos X, Y, Z or direct references"), then the agent for the gray zone, guided by a prose policy the owner writes by talking to an agent.
- **The feed** is one list sorted by priority. Items resolve on their own when the world resolves them (someone else approved, merged, closed, no longer requested) and come back if that stops being true.
- **Lanes**: Review (other people's PRs, each arriving with an AI summary, concerns and notes on the changes) and Merging (the owner's own PRs they've handed off; the coordinator keeps CI green, handles members' comments and merges them, and hands back only what needs the owner).
- **The coordinator** is one ordinary Claude Code session the owner keeps in their Claude app's sidebar, running a self-paced `/loop` with the desk's MCP tools and skill. It gets handed-off PRs merged, and maintains the policy and config when asked in prose.
- **Review in the desk**: Linear-style inline PR review with Pierre's `@pierre/diffs`, AI notes on the changed code, one key to approve.

## Decisions (defaults; the owner can change any of them later)

1. **Events without webhooks.** GitHub webhooks need a public URL and admin rights. The GitHub connector polls the notifications API (cheap, about every 60 s, `If-Modified-Since`, honours `X-Poll-Interval`) to learn what changed, refreshes those items, and derives events by comparing snapshots. A periodic search pass reconciles. A webhook relay can plug into the same event log later.
2. **Writing to GitHub.** The desk writes only on the owner's keypress: approve, and Ready for review on their own draft, through one module with an allowlist, each logged. The coordinator is the owner's own Claude Code: it pushes to and merges the owner's PRs it was handed, and never posts comments or replies as them.
3. **The coordinator.** Not the desk's: one session the owner starts with `/loop` and the skill's instructions, visible in their sidebar, pacing itself (about 5 minutes while something is in Merging, 20 to 30 when idle). Claude Code's push "channels" would be cleaner but are a research preview.
4. **AI cost.** Structured rules run first, so only items that would reach the owner get an AI summary and review. Results are cached per head commit, and generation runs a couple at a time.

## Slices

1. Connector interface and event log; GitHub sync on top of them (notifications + reconcile); auto-resolve.
2. Prose policy and the judge; the coordinator session, able to edit policy and config.
3. PR review view: Pierre diffs, AI summary, concerns and notes on changes, approve.
4. Merging, and the coordinator getting handed-off PRs merged.
