import "../../test/helpers/no-agent.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTOMATION_BODY_KEYS, automationBody } from "../../src/automation-body.ts";
import type { Automation } from "../../src/types.ts";
import { blank, bodyOf, editing } from "../src/automation-draft.ts";

const SAVED = { on: true, by: "you", updated_at: "2026-11-20T09:00:00Z" } as const;

// An agent's with every key it may have, and a rule's with the rest.
const AGENT: Automation = {
  id: "mail",
  name: "Mail",
  schedule: "",
  events: ["commented", "ci"],
  prompt: "Read my mail.",
  when: "!author.bot",
  can: ["add", "fyi"],
  mcp: ["gmail", "claude.ai Calendar"],
  buttons: [
    { label: "Open in Gmail", do: "open" },
    { label: "Draft a reply", do: "ask", prompt: "Draft a reply." },
  ],
  icon: "brand:gmail",
  type: 'type Email = { kind: "bill" | "personal"; sender: string }',
  rules: [
    { when: "item.kind == 'bill'", do: "urgent" },
    { ask: "Is it a newsletter?", do: "drop" },
  ],
  ...SAVED,
};
const RULE: Automation = {
  id: "bots",
  name: "Bots",
  schedule: "weekdays 09:00",
  prompt: "",
  when: "author.bot",
  decide: "rule",
  rule: { do: "snooze", until: "ci", why: "a bot's, until CI passes" },
  can: ["snooze"],
  ...SAVED,
  on: false,
};

test("an untouched edit saves the automation back as it is: every key, the editor's and the ones it doesn't show", () => {
  for (const a of [AGENT, RULE]) {
    assert.deepEqual(bodyOf(editing(a)), automationBody(a), a.id);
    assert.deepEqual(Object.keys(bodyOf(editing(a))).toSorted(), [...AUTOMATION_BODY_KEYS].toSorted(), a.id);
  }
});

test("what the editor clears goes as cleared, not as it was", () => {
  const d = editing(AGENT);
  const { type: _t, rules: _r, ...rest } = d;
  const b = bodyOf({ ...rest, when: " ", decide: "ask", mcp: "" });
  assert.deepEqual([b.when, b.type, b.rules, b.mcp, b.decide], [undefined, undefined, undefined, undefined, "ask"]);
  assert.deepEqual([b.buttons, b.icon], [AGENT.buttons, AGENT.icon], "the editor doesn't show these: they go back as they were");
  const ruled = bodyOf({ ...d, decide: "rule", rule: { do: "hide", why: "noise" } });
  assert.deepEqual([ruled.prompt, ruled.can, ruled.rule], ["", ["hide"], { do: "hide", why: "noise" }]);
  assert.deepEqual(bodyOf({ ...blank(), name: "New" }), {
    name: "New",
    schedule: "weekdays 09:00",
    events: undefined,
    prompt: "",
    when: undefined,
    decide: undefined,
    rule: undefined,
    can: undefined,
    mcp: undefined,
    type: undefined,
    rules: undefined,
    on: true,
  });
});
