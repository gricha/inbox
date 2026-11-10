// What GitHub comes with for the Inbox's order: rules only, no model, so a fresh desk sections sensibly from its first sync.
import type { BuiltInCriterion } from "../types.ts";

export const GITHUB_CRITERIA: readonly BuiltInCriterion[] = [
  {
    id: "asked",
    name: "Asked by name",
    help: "A review asked of you by name, not of a team you're on.",
    on: true,
    when: "me.requested_direct",
    urgent: false,
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
    help: "Your PR is approved and its CI is green.",
    on: true,
    when: "me.author && !item.draft && pr.review == 'approved' && pr.ci == 'green'",
    urgent: false,
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
