// What GitHub comes with: automations a stranger's desk runs from its first sync, with no config. Generic only: no person,
// repo or topic. Rules (no model) are on; what needs a model is off until you switch it on. None of them can lift what
// holds an item for you: a direct ask of you by name keeps its hard Now floor (and none of them asks it), your pin and a
// hand-back stay where they are.
import type { BuiltInAutomation } from "../types.ts";

// What a sort reads again: anything that changes the item ends a sort, so these sort it again.
const CHANGES = ["new", "review_requested", "reviewed", "pushed", "commented", "ci"] as const;

export const GITHUB_AUTOMATIONS: readonly BuiltInAutomation[] = [
  {
    id: "pick-reviewer",
    name: "Pick a reviewer",
    help: "Your ready PR waited a workday with nobody asked by name, and nothing it needs is still open: it comes to your desk so you pick a reviewer.",
    on: true,
    schedule: "weekdays hourly",
    prompt: "",
    when: "me.author && !item.draft && !pr.blocked && !pr.review_optional && pr.ready_weekday_hours >= 24 && len(pr.people_requested) == 0 && len(pr.reviewers) == 0",
    decide: "rule",
    rule: { do: "add", why: "nobody asked by name for a workday" },
  },
  {
    id: "follow-up",
    name: "Follow up on silent reviewers",
    help: "Your PR's named reviewers have been silent two workdays, and nothing it needs is still open: it comes to your desk so you follow up.",
    on: true,
    schedule: "weekdays hourly",
    prompt: "",
    when: "me.author && !item.draft && !pr.blocked && pr.asked_weekday_hours >= 48 && len(pr.reviewers) == 0",
    decide: "rule",
    rule: { do: "add", why: "the reviewers you named are silent two workdays" },
  },
  {
    id: "team-reviewed",
    name: "Team reviews someone else took",
    help: "A review asked of a team you're on, not of you by name, that someone else has already reviewed goes to FYI, unless it changes code you work on.",
    on: true,
    schedule: "",
    events: [...CHANGES],
    prompt: "",
    when: "me.requested && !me.requested_direct && me.requested_team != '' && len(pr.reviewers) > 0 && !me.commented && !pr.my_area",
    decide: "rule",
    rule: { do: "fyi", why: "someone else reviewed it for your team" },
    can: ["fyi"],
  },
  {
    id: "wide-ping",
    name: "Wide team pings",
    help: "A review asked of four or more teams at once, and not of you by name, is hidden, unless it changes code you work on.",
    on: true,
    schedule: "",
    events: [...CHANGES],
    prompt: "",
    when: "me.requested && !me.requested_direct && len(pr.teams_requested) >= 4 && !me.commented && !pr.my_area",
    decide: "rule",
    rule: { do: "hide", why: "asked of four or more teams at once" },
    can: ["hide"],
  },
  {
    id: "red-ci",
    name: "Snooze while CI is red",
    help: "Your PR whose CI goes red is snoozed until its CI passes.",
    on: false,
    schedule: "",
    events: ["new", "ci"],
    prompt: "",
    when: "me.author && !item.draft && pr.ci == 'red'",
    decide: "rule",
    rule: { do: "snooze", until: "ci", why: "CI is red: back when it passes" },
    can: ["snooze"],
  },
  {
    id: "mention-question",
    name: "Questions in mentions",
    help: "When someone mentions you, a model reads it and puts it on your desk if they ask you something.",
    on: false,
    schedule: "",
    events: ["mentioned"],
    prompt:
      "Someone mentioned me on this item. If they ask me something, or need an answer or a decision from me, sort it to Today. Otherwise leave it as it is.",
    when: "!me.author",
    decide: "ask",
    can: ["today"],
  },
];
