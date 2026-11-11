# Where Inbox is going

Inbox is the owner's control center for routine engineering work, and a partner for whatever agent they use (Claude Code, Codex, OpenCode). Most of what reaches an engineer is noise. The desk shows only what needs them, in priority order, and lets agents handle the rest.

## The model

```
connectors ──events──▶ event log ──▶ judge ──▶ feed items (open / resolved) ──▶ UI, coordinator
   ▲                                  ▲  rules (structured, cheap)                │
   │                                  └─ policy (prose, judged by the agent)      │
   └──────────────────── actions (approve, comment, push) ◀───────────────────────┘
```

- **Connectors** turn a source into a stream of events (review requested, approved, CI failed, new comment, mention, merged) plus snapshots of the items they concern. GitHub is the first; Linear, Slack and Sentry can follow.
- **The event log** keeps every event. The UI shows an item's recent activity from it; the coordinator reads it on each wake.
- **The judge** decides what reaches the feed. Structured rules run first (cheap and exact). The agent handles the gray zone, guided by a prose policy the owner writes.
- **The feed** is one list in priority order. Items resolve on their own when the world resolves them (approved by someone else, merged, closed, no longer requested), and come back if that stops being true.
- **Merging** holds the owner's PRs they've handed off. The coordinator keeps CI green, handles members' comments, merges, and hands back only what needs the owner.
- **The coordinator** is one background agent session the desk starts and wakes with news, using the desk's MCP tools and skill. It also edits the policy and config when asked in prose.
- **Review in the desk**: inline PR review (with `@pierre/diffs`), AI notes on the changed code, one click to approve.

## Decisions

Defaults; the owner can change any of them.

1. **Events without webhooks.** Webhooks need a public URL and admin rights. The GitHub connector polls the notifications API (about every 60 s, `If-Modified-Since`, honouring `X-Poll-Interval`), refreshes what changed, and derives events by comparing snapshots. A periodic search reconciles. A webhook relay could feed the same event log later.
2. **Writing to GitHub only on a click.** The desk writes only when the owner clicks, through one module with an allowlist, and logs each write. The coordinator is the owner's own agent: it pushes to and merges PRs it was handed, and pushes to the owner's own PR when asked from the desk. It never pushes to anyone else's PR and never posts as the owner.
3. **The coordinator is woken, not looping.** The desk wakes it on events only: a hand-off, CI finishing, a review or comment, a conflict, an ask. The desk checks every 5 minutes that it's still running. On Claude Code, its daemon runs the session, so a desk restart leaves it alone.
4. **AI cost.** Rules run first, so only items that could reach the owner get an AI review. Reviews are cached per head commit and run a couple at a time.

## Next

A small core with every source as a plugin: [plugins.md](plugins.md).
