# Inbox for Claude

A `/desk` pane in Claude Code (the Desktop app or a terminal) with your Inbox beside the chat: one list in the desk's order (an agent's question, a PR handed back to you, reviews asked of you, issues and other PRs, then your own PRs), one line each: what it is (PR, Issue or Question), its title, its repo#number, who it's from, its stage or its call to action (Ready for review, Reply, Add reviewers, Answer) and its age.

A click on a row's title opens it in the desk. In a terminal that's its `inbox://` link, which the Inbox app opens. The Desktop app and VS Code draw any link but `https:` or `http://localhost` as plain text, so there it's the desk's own page for it (`http://localhost:47823/#/item/…`). `done` and `tomorrow` on a row are the desk's Done and a snooze until tomorrow. A call to action is a GitHub write or your answer to an agent, which the desk takes only from its own window: open the row.

Under the prompt it pins what the desk says as a status line, e.g. `desk 10 +2` (10 in the queue, 2 new), which Claude Code leads with `⚠` and the plugin's name, and reads the desk again every minute. It reads the local Inbox server at http://localhost:47823 (the default port; the pane always uses it), so the desk must be running: the Inbox app, or `desk serve`. Nothing here talks to GitHub.

## Install

```bash
claude plugin marketplace add ~/code/review-desk
claude plugin install inbox@inbox
```

Then type `/desk` in a new session, or after `/reload-plugins` in one that's running. It needs Claude Code 2.1.287 or newer (`claude --version`): older ones don't run a plugin's hooks module. It installs for your user, so the Desktop app's sessions have it too. Claude Code reads the plugin from this checkout in place: after a pull there's nothing to reinstall, and the next session (or `/reload-plugins`) has the change.

Installed it as `review-desk` before the rename to Inbox? Its marketplace and plugin keep that name, so remove them first: `claude plugin uninstall review-desk@review-desk` and `claude plugin marketplace remove review-desk`.

## Test

`npm test` runs [../pane.test.ts](../pane.test.ts): the pane's hooks, run by a stand-in for Claude Code against a fake desk on its own port. `claude plugin validate integrations/claude-desktop/inbox` checks the plugin as Claude Code will read it.
