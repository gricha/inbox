# Inbox: design

Why the desk is built the way it is: the principles behind it, the technical choices with their reasons, and what was considered and left out. Read this before reopening a settled question.

Other docs own the rest:

- What the product is and where it's going: [vision.md](vision.md).
- How it looks: [visual.md](visual.md). What each page does: [ui.md](ui.md).
- How the pieces fit: [architecture.md](architecture.md). Behaviour and API: [api.md](api.md).
- The product rules (writes, keys, state on the desk): [AGENTS.md](../AGENTS.md).
- The numbers below come from a six-month replay of the owner's review history: [evidence.md](evidence.md).

The first design (2026-10-26) was a pane inside Claude Desktop with key-driven triage and sandboxed review "rooms". The desktop app replaced it. That proposal is in git history; this file keeps only what still holds.

## What the replay taught

These shaped the built-in rules (`src/connectors/github-rules.ts`) and the defaults.

- **Who wrote the PR is the strongest signal.** Author history was the largest single lift in the replay. File affinity helps less; matching only the area (directory) did no better than nothing. So the desk reads your review affinity per author and your areas daily, and a close collaborator's PR is surfaced.
- **A human asking you beats a bot asking you.** Direct asks from a person were engaged 58% of the time; asks a bot added, almost never. So `asked-directly` is Now, and bot asks sit lower.
- **Some requests are almost never engaged.** PRs someone else already approved (0 of 184), dependabot (0 of 71), and CODEOWNERS fan-out to a big team (1.8%). So another's approval resolves your request by default (`github.resolve_on_others_approval`), bot PRs are hidden, and a CODEOWNERS request outside your areas is FYI.
- **Small lists hold up.** A Today cap of 6 kept recall with fewer cards than 8. The first-run template gives every board `caps = { now = 3, today = 6 }`.
- **People engage fast.** 71% of engagements came within 4 hours of the request. So the queue is live, with notifications, not a daily digest.
- **Size isn't a reason to skip.** Bigger PRs were engaged more, not less. No rule caps Now by size.
- **Many engagements had no request** (37%). So the default boards also list PRs you reviewed before, mentions and assignments, and close collaborators' open PRs, not only review requests.

Known limits of that evidence:

- One author was 45% of the owner's engagements. Recall for everyone else was 0.65.
- Engagement measures habit, not value.

## Principles

1. **Show only what needs the owner.** Short lists, one queue, everything else sorted away but never silently dropped (hidden items stay listed with the rule that hid them).
2. **Rules are cheap and certain; the agent handles the rest.** Rules give a hint and, when `hard`, a floor. Your agent judges the gray zone, weighing every rule that matches by its weight. A pin or a hard rule is never overridden.
3. **The desk is the truth.** It decides what's on the queue, its order and what notifies. Every client (window, tray, CLI, MCP) only renders, so they agree.
4. **Snoozes are conditions, not timers.** "Until CI passes" is checked against each fresh snapshot (`happened()` in `src/signals.ts`). A sleeping laptop loses nothing.
5. **PR text is untrusted.** It's fenced in every prompt and in MCP results. Agent calls that read it have no tools.
6. **Writes only on the owner's click.** Through one allowlisted module (`src/github/write.ts`), never from an agent. Adding a write is a product decision.
7. **Resolved is derived, not stored.** An item leaves when the world deals with it and comes back if that stops being true.

## Technical choices

| Topic                 | Choice                                                                                                               | Why                                                                                       | Rejected                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Learning what changed | Poll `/notifications` with `If-Modified-Since`, plus a periodic search reconcile; derive events by diffing snapshots | Webhooks need a public URL and admin rights ([vision.md](vision.md)). A 304 costs nothing | Webhooks, the Events API                                                                                    |
| Fetching              | Light search, then details for what changed                                                                          | A search with full details is too slow (architecture.md → Sync)                           | One big search                                                                                              |
| GitHub auth           | `gh auth token`, in memory                                                                                           | The notifications API needs an OAuth or classic token                                     | A GitHub App, a fine-grained PAT                                                                            |
| Storage               | `node:sqlite`, WAL, a thin typed layer                                                                               | No native modules; stable Drizzle had no `node:sqlite` driver                             | An ORM                                                                                                      |
| Server                | Hono, bound to `127.0.0.1`                                                                                           | Small, Fetch-based: MCP calls the routes in-process through `app.request`                 | —                                                                                                           |
| Runtime               | Node runs the TypeScript directly                                                                                    | No build step for the desk, in the packaged app too                                       | —                                                                                                           |
| Model calls           | The owner's own `claude`, `codex` or `opencode` CLI, on their plan and settings                                      | No API key to manage; one agent, configured once                                          | The Agent SDK (wants an API key), ACP (can't strip the environment; codex-acp trusts the working directory) |
| AI analysis           | Tool-less calls in an empty directory                                                                                | PR text can sway the words, not act                                                       | Agents with tools over PR text                                                                              |
| The coordinator       | Your agent in the background, woken by events only (Claude Code: `claude --bg`)                                      | A desk restart leaves it alone; no loop burning turns                                     | A long-running loop in the desk                                                                             |
| Rules language        | A small expression language of our own (`src/expr.ts`)                                                               | Safe (no eval, only known fields), with compile errors that suggest the field you meant   | —                                                                                                           |

## Considered and left out

- **Marking GitHub notifications done.** The desk's done is local; it never touches your GitHub notification threads.
- **Sandboxed review sessions for others' PRs.** The AI review runs tool-less instead; a hand-off prompt goes to your own session.
- **A daily digest.** People engage within hours; the live queue and notifications cover it.
- **Topic matching from PR titles or bodies.** That text is attacker-controlled, and the replay's lift from it leaked the future.
- **Sources beyond GitHub** (Slack, Linear). The connector interface allows them; [plugins.md](plugins.md) is the design.
