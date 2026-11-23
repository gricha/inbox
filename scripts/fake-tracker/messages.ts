// What the fake tracker serves: messages that need me in a chat and issue tracker, not email, three of them malformed as a
// real source's can be (a kind it doesn't have, a date as a number and mentions as one string, no author).
export const TRACKER_TYPE = `type Message = {
  kind: "question" | "review_request" | "incident" | "announcement";
  author: string;
  channel: string;
  mentions: string[];
  due?: string; // an ISO date
  points?: number;
}`;

export const MESSAGES: readonly Record<string, unknown>[] = [
  {
    id: "m1",
    kind: "incident",
    author: "dana",
    channel: "infra-alerts",
    mentions: ["me", "oncall"],
    title: "p99 latency on the API is over 2s, can you look?",
    body: "Started **14:05 UTC** after the deploy. Dashboards: <https://grafana.example/d/api>",
    url: "https://tracker.example/m/m1",
  },
  {
    id: "m2",
    kind: "review_request",
    author: "priya",
    channel: "design",
    mentions: ["me"],
    title: "Review the onboarding copy before Friday",
    body: "Three screens, about 200 words.",
    due: "2026-11-27",
    points: 3,
    url: "https://tracker.example/m/m2",
  },
  {
    id: "m3",
    kind: "announcement",
    author: "release-bot",
    channel: "releases",
    mentions: ["here"],
    title: "v2.3 shipped",
    url: "https://tracker.example/m/m3",
  },
  {
    id: "m4",
    kind: "question",
    author: "standup-bot",
    channel: "eng",
    mentions: ["me"],
    title: "Daily digest: 4 threads mention you",
    url: "https://tracker.example/m/m4",
  },
  { id: "m5", kind: "Incident!!", author: "sam", channel: "support", mentions: ["me"], title: "Customer can't log in" },
  { id: "m6", kind: "question", author: "lee", channel: "ops", mentions: "me", due: 20261130, title: "Can you approve the change window?" },
  { id: "m7", kind: "question", channel: "random", mentions: ["me"], title: "Who owns the billing service now?" },
];
