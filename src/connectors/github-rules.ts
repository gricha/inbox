// What GitHub comes with for its boards: the rules each kind of board places its items by, read from here on every load,
// so a release that improves one reaches every desk whose board names it (`builtin = "review"` in config.toml). An id is
// stable: the owner's config switches a rule off by it (`off`), or puts theirs in its place (a rule with that `id`).
// Every rule that matches an item is a signal for the judge, and its `weight` (0 to 10, RULE_WEIGHT unset) says how much it
// counts: a review asked of you by name weighs most, a team or CODEOWNERS ping little, a bot's PR is noise.
import type { BuiltInRules } from "../types.ts";

const MENTIONS: BuiltInRules["rules"] = [
  { id: "new-replies", when: "me.new_activity", bucket: "today", why: "new replies since you last acted", weight: 6 },
  {
    id: "unreplied",
    when: "!me.commented && !me.author && item.activity_hours < 72",
    bucket: "today",
    why: "you were mentioned and haven't replied",
    weight: 4,
  },
  { id: "assigned", when: "me.assignee", bucket: "later", why: "assigned to you", weight: 4 },
];

export const GITHUB_RULES: Readonly<Record<string, BuiltInRules>> = {
  review: {
    name: "PRs to review",
    rules: [
      {
        id: "asked-directly",
        when: "me.requested_direct && !me.requested_by_bot",
        bucket: "now",
        why: "{me.requested_by} asked you directly",
        weight: 9,
      },
      {
        id: "asked-by-bot",
        when: "me.requested_direct && me.requested_by_bot",
        bucket: "today",
        why: "asked you by name (added by {me.requested_by})",
        weight: 8,
      },
      { id: "yours-via-bot", when: "me.author", bucket: "later", why: "your PR, opened through {author.login}", weight: 6 },
      {
        id: "after-changes-requested",
        when: "!me.requested && me.review_state == 'changes_requested'",
        bucket: "today",
        why: "new commits after you requested changes",
        weight: 6,
      },
      { id: "new-commits", when: "!me.requested", bucket: "later", why: "new commits since your review", weight: 4 },
      // Asked of your team, not of you by name: someone else asked or reviewing has it; one in your area or by someone you
      // review for, that nobody took in a day, is yours. (A wide ping is the wide-ping automation's.)
      {
        id: "team-taken",
        when: "me.requested && !me.requested_direct && !me.commented && (len(pr.people_requested) > 0 || len(pr.reviewers) > 0)",
        bucket: "fyi",
        why: "asked of @{me.requested_team}; someone else has it",
        weight: 7,
      },
      {
        id: "team-waited",
        when: "me.requested && !me.requested_direct && (!author.bot || author.via != '') && (author.close || pr.my_area) && me.requested_hours >= 24",
        bucket: "today",
        why: "asked of @{me.requested_team} a day ago, and nobody took it",
        weight: 5,
      },
      {
        id: "close-collaborator",
        when: "author.close",
        bucket: "later",
        why: "close collaborator: you engaged with {author.engaged_90d} of their PRs in 90 days",
        weight: 3,
      },
      { id: "your-repo", when: "repo.mine", bucket: "today", why: "your repo", weight: 5 },
      { id: "bot-pr", when: "author.bot && author.via == ''", bucket: "hide", why: "bot PR", weight: 8 },
      { id: "added-by-bot", when: "me.requested_by_bot", bucket: "later", why: "added by {me.requested_by} (bot)", weight: 4 },
      {
        id: "codeowners-your-area",
        when: "me.requested_codeowner && !me.requested_direct && pr.my_area",
        bucket: "later",
        why: "CODEOWNERS ping to @{me.requested_team}, in code you work on",
        weight: 3,
      },
      {
        id: "codeowners",
        when: "me.requested_codeowner && !me.requested_direct",
        bucket: "fyi",
        why: "CODEOWNERS ping to @{me.requested_team}",
        weight: 6,
      },
      {
        id: "team-your-area",
        when: "me.requested && !me.requested_direct && pr.my_area",
        bucket: "later",
        why: "asked of @{me.requested_team}, in code you work on",
        weight: 3,
      },
      { id: "team", when: "me.requested && !me.requested_direct", bucket: "fyi", why: "asked of @{me.requested_team}", weight: 5 },
    ],
  },
  mine: {
    name: "My PRs",
    rules: [
      // Blocked is for your own PRs: someone else's blocked PR goes where its board's other rules put it (a review asked of
      // you is yours to give whatever the PR waits on). A change request or a reply you owe is yours to do now, blocked or not.
      {
        id: "blocked",
        when: "pr.blocked && pr.review != 'changes_requested' && !me.owes_reply",
        bucket: "blocked",
        why: "blocked by {pr.blocker}, which {pr.blocker_waits}",
        final: true,
      },
      {
        id: "fresh-draft",
        when: "item.draft && item.updated_hours < 336",
        bucket: "today",
        why: "your draft: finish it",
        hard: true,
        weight: 6,
      },
      { id: "draft", when: "item.draft && item.updated_hours >= 336", bucket: "later", why: "draft, quiet for 2+ weeks", weight: 6 },
      {
        id: "changes-requested",
        when: "pr.review == 'changes_requested'",
        bucket: "now",
        why: "changes requested",
        nocap: true,
        weight: 8,
      },
      {
        id: "requires-closed",
        when: "len(pr.requires_closed) > 0",
        bucket: "today",
        why: "needs {pr.requires_closed}, closed without merging",
        weight: 5,
      },
      {
        id: "blocks-others",
        when: "len(pr.blocks) > 0 && me.owes_reply",
        bucket: "today",
        why: "blocks {pr.blocks}; it {pr.waits}",
        weight: 7,
      },
      { id: "stacked", when: "pr.stacked", bucket: "later", why: "stacked on {pr.base}", weight: 7 },
      { id: "ci-red", when: "pr.ci == 'red' && pr.pushed_hours >= 1", bucket: "today", why: "CI failing", weight: 4 },
      { id: "new-activity", when: "me.new_activity", bucket: "today", why: "new comments or reviews", weight: 4 },
      {
        id: "ready-to-merge",
        when: "pr.review == 'approved' && pr.ci == 'green'",
        bucket: "today",
        why: "approved and green: ready to merge",
        weight: 8,
      },
      {
        id: "no-review-ready",
        when: "pr.review_optional && pr.review != 'changes_requested' && pr.ci == 'green'",
        bucket: "today",
        why: "green, and its repo needs no review: ready to merge",
        weight: 7,
      },
      // A conflict doesn't take it out: it still waits on its reviews, and your agent only rebases a PR that's approved.
      {
        id: "waits-on-review",
        when: "len(pr.waiting_on) > 0 && !me.owes_reply && pr.ci != 'red'",
        bucket: "blocked",
        why: "{pr.waits}",
        final: true,
      },
      {
        id: "unresolved-threads",
        when: "pr.unresolved_threads > 0",
        bucket: "later",
        why: "unresolved threads: {pr.unresolved_threads}",
        weight: 4,
      },
      { id: "quiet", when: "item.activity_hours > 72", bucket: "later", why: "quiet for 3+ days: nudge a reviewer?", weight: 5 },
    ],
  },
  mentions: { name: "Mentions & assigned", rules: MENTIONS },
  // A board that also lists your own issues.
  issues: {
    name: "Issues & mentions",
    rules: [...MENTIONS, { id: "your-issue", when: "me.author", bucket: "fyi", why: "your issue", weight: 3 }],
  },
  collaborators: {
    name: "Close collaborators",
    rules: [{ id: "new-pr", when: "item.created_hours < 24", bucket: "later", why: "new from {author.login}", weight: 2 }],
  },
};
