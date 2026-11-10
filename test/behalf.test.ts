import { test } from "node:test";
import assert from "node:assert/strict";
import { onBehalf, requesterOf } from "../src/github/behalf.ts";
import { normalize, type RawNode } from "../src/github/normalize.ts";
import { botCheck } from "../src/signals.ts";
import { makeItem, NOW } from "./helpers/items.ts";

// As Junior (getsentry/junior, packages/junior-github/src/tool-support/attribution.ts) writes its block.
const junior = (line: string) =>
  `Retries the webhook on a 502.\n\n<!-- junior-request-attribution:start -->\n${line}\n<!-- junior-request-attribution:end -->\n\n` +
  `<!-- junior-session-footer:start -->\n--\n\n[View Session](https://junior.example/conversations/x)\n<!-- junior-session-footer:end -->`;

test("who a PR's description says it was opened for, in each agent's format", () => {
  const cases: [string, string, string][] = [
    ["Junior, linked to GitHub", junior("via @me."), "@me"],
    ["Junior, asked by two: the first", junior("via @me, **telkins**."), "@me"],
    ["Junior, no GitHub login linked", junior("via **greg.pstrucha**."), "greg.pstrucha"],
    ["Junior, its older wording", junior("Requested by **Greg Pstrucha** via Junior."), "Greg Pstrucha"],
    ["Junior, an escaped star in a name", junior(String.raw`via **a\*b**.`), "a*b"],
    ["Devin", "Fixes the race.\n\nLink to Devin session: https://app.devin.ai/sessions/1\nRequested by: @me", "@me"],
    ["a line of its own", "Bumps the parser.\n\n_On behalf of @me._", "@me"],
    ["Requested by, no colon", "Bumps the parser.\nRequested by @me", "@me"],
    ["Junior's automation run names nobody", junior("via [automation `sched_1`](https://junior.example/a) · Run ID `sched_1:2`."), ""],
    ["Claude's Slack line isn't a line of its own", "_Requested by **Henri Lemoine** · [Slack thread](https://x.slack.com/a)_", ""],
    ["a passing mention", "Thanks @me for the idea; requested by @me in standup, via @me's branch.", ""],
    ["prose about a queue", "It goes via the queue.\n", ""],
    ["two lines that disagree", "Requested by: @me\nOn behalf of @dana", ""],
    ["Copilot writes none", "Thanks for asking me to work on this.\n<!-- START COPILOT CODING AGENT SUFFIX -->", ""],
  ];
  for (const [what, body, who] of cases) assert.equal(requesterOf(body), who, what);
});

test("a bot's PR is yours only when it names you and assigns you, names a name you gave, or is Copilot's with you its only person", () => {
  const isBot = botCheck(["acme-agent"]);
  const yours = (o: Parameters<typeof makeItem>[0], names: string[] = []) => onBehalf(makeItem(o), "me", names, isBot);
  const bot = { author: "sentry-junior", author_bot: true };
  assert.equal(yours({ ...bot, requester: "@me", assignees: ["me"] }), true, "Junior, linked: names and assigns you");
  assert.equal(yours({ ...bot, requester: "@ME", assignees: ["Me"] }), true, "logins compare without case");
  assert.equal(yours({ ...bot, requester: "@me" }), false, "named but not assigned: anyone with write access can edit a description");
  assert.equal(yours({ ...bot, requester: "@dana", assignees: ["me", "dana"] }), false, "opened for someone else");
  assert.equal(yours({ ...bot, requester: "greg.pstrucha" }, ["greg.pstrucha"]), true, "a name you gave");
  assert.equal(yours({ ...bot, requester: "greg.pstrucha" }), false, "a name you didn't give");
  assert.equal(yours({ ...bot, requester: "Greg" }, ["greg.pstrucha"]), false, "names match whole");
  assert.equal(yours({ ...bot, requester: "greg.pstrucha" }, ["Greg Pstrucha"]), true, "your profile name, compared by letters alone");
  assert.equal(yours({ ...bot, via: "greg.pstrucha" }, ["Greg Pstrucha"]), true, "stored before requesters were read: its via line");
  assert.equal(yours({ ...bot, requester: "", via: "greg.pstrucha" }, ["Greg Pstrucha"]), false, "a requester read as none wins over via");
  assert.equal(yours({ ...bot, requester: "*" }, [""]), false, "no letters never matches an empty name");
  assert.equal(yours({ author: "carol", requester: "@me", assignees: ["me"] }), false, "a person's PR is its author's");
  assert.equal(yours({ author: "carol", requester: "greg.pstrucha" }, ["greg.pstrucha"]), false, "a person's PR, a name you gave");
  assert.equal(yours({ author: "acme-agent", requester: "@me", assignees: ["me"] }), true, "a login you listed as a bot");
  assert.equal(yours({ author: "dependabot", author_bot: true, assignees: ["me"] }), false, "a bot assigning you isn't opening it for you");
  assert.equal(yours({ ...bot, kind: "issue", requester: "@me", assignees: ["me"] }), false, "an issue isn't a PR");
  const copilot = { author: "Copilot", author_bot: true };
  assert.equal(yours({ ...copilot, assignees: ["me", "Copilot"] }), true, "Copilot: you're its only person assigned");
  assert.equal(yours({ ...copilot, assignees: ["me", "dana"] }), false, "two people: whose isn't sure");
  assert.equal(yours({ ...copilot, assignees: ["dana", "Copilot"] }), false, "someone else's");
  assert.equal(
    yours({ author: "devin-ai-integration", author_bot: true, assignees: ["me"] }),
    false,
    "only Copilot goes by its assignee alone",
  );
});

test("a PR's requester is read from its markdown description, not the text GitHub renders without Junior's markers", () => {
  const raw = {
    __typename: "PullRequest",
    id: "PR_1",
    number: 7,
    title: "Retry",
    url: "https://github.com/acme/api/pull/7",
    state: "OPEN",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    closedAt: null,
    bodyText: "Retries the webhook on a 502.\nvia @me.",
    body: junior("via @me."),
    author: { __typename: "Bot", login: "sentry-junior" },
    repository: { nameWithOwner: "acme/api" },
    labels: { nodes: [] },
    assignees: { nodes: [{ login: "me" }] },
    comments: { totalCount: 0, nodes: [] },
  } as unknown as RawNode;
  const it = normalize(raw, NOW.toISOString());
  assert.deepEqual([it.requester, it.via, it.assignees], ["@me", "@me", ["me"]]);
  assert.equal(normalize({ ...raw, body: "Bumps lodash." }, NOW.toISOString()).requester, "");
});
