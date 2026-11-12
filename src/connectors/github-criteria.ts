// What GitHub comes with for the Inbox's order: rules only, no model, so a fresh desk sections sensibly from its first sync.
import type { BuiltInCriterion } from "../types.ts";

export const GITHUB_CRITERIA: readonly BuiltInCriterion[] = [
  {
    id: "asked",
    name: "Asked by name",
    help: "A review asked of you by name, not of a team you're on: it counts heavily toward Urgent until you review.",
    on: true,
    when: "me.requested_direct",
    urgent: false,
    weight: 3,
  },
  {
    id: "reply",
    name: "Waiting on your reply",
    help: "Someone answered you: on your PR they spoke last, on theirs they pushed after your review.",
    on: true,
    when: "me.owes_reply || (!me.author && me.reviewed && me.pushed_since_review)",
    urgent: false,
  },
  {
    id: "ready",
    name: "Ready to merge",
    help: 'Your PR is approved (or its repo needs no review) and its CI is green: one press merges it, so it\'s Urgent. One others wait on is "Your PR others wait on" instead.',
    on: true,
    when: "me.author && !item.draft && !pr.stacked && !pr.blocked && len(pr.blocks) == 0 && pr.ci == 'green' && (pr.review == 'approved' || (pr.review_optional && pr.review != 'changes_requested'))",
    urgent: true,
  },
  {
    id: "draft",
    name: "Your draft",
    help: "Your own PR is still a draft: it waits on you to mark it Ready for review, so it's Urgent.",
    on: true,
    when: "me.author && item.draft",
    urgent: true,
  },
  {
    id: "unblocks",
    name: "Your PR others wait on",
    help: "Your PR other PRs need merged first is ready to merge, or waits on your reply.",
    on: true,
    when: "me.author && len(pr.blocks) > 0 && (me.owes_reply || (pr.review == 'approved' && pr.ci == 'green'))",
    urgent: true,
  },
  {
    id: "handed-back",
    name: "Handed back",
    help: "Your agent couldn't get your PR merged and gave it back to you.",
    on: true,
    when: "me.handed_back",
    urgent: true,
  },
];
