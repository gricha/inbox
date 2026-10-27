# Review Desk for Claude

A `/desk` pane in Claude Code (Desktop or terminal) that shows what needs you now and today from Review Desk, with done and snooze buttons, plus a status-line count (`desk ●2 ◐8`) refreshed every minute. It reads the local Review Desk server at http://localhost:47823 (the default port; the pane always uses it), so run `desk serve` (or `desk install`) first. Nothing here talks to GitHub.

## Install

```bash
claude plugin marketplace add ~/code/review-desk
claude plugin install review-desk@review-desk
```

Then type `/desk` in a session.
