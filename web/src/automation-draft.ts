// An automation as its editor holds it, and the body a save sends: what the editor doesn't show (buttons, icon) goes back
// as it was, and what it does is always written, undefined when cleared, so neither can drop a field.
import { automationBody, type Whole } from "../../src/automation-body.ts";
import type { ActivityKind, Automation, AutomationBody, AutomationView, ItemRule, RuleAction, Verb, Way } from "../../src/types.ts";

export interface Draft {
  id: string | null; // null: a new one, its id from its name
  base: AutomationBody; // as it was saved: what the editor doesn't change goes back as it is
  name: string;
  schedule: string; // "" with events
  events: ActivityKind[];
  prompt: string;
  when: string;
  decide: Way;
  rule?: RuleAction; // with decide rule
  can: Verb[];
  mcp: string; // an agent's MCP servers, as typed: names, comma-separated
  type?: string; // its notes' type and rules
  rules?: ItemRule[];
  on: boolean;
}

const serversOf = (t: string) => [
  ...new Set(
    t
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean),
  ),
];

// A new one, as New automation opens it.
export const blank = (): Draft => ({
  id: null,
  base: { name: "" },
  name: "",
  schedule: "weekdays 09:00",
  events: [],
  prompt: "",
  when: "",
  decide: "agent",
  can: ["add"],
  mcp: "",
  on: true,
});

export const editing = (a: Automation): Draft => ({
  id: a.id,
  base: automationBody(a),
  name: a.name,
  schedule: a.schedule,
  events: a.events ?? [],
  prompt: a.prompt,
  when: a.when ?? "",
  decide: a.decide ?? "agent",
  ...(a.rule && { rule: a.rule }),
  can: a.can ?? ["add"],
  mcp: (a.mcp ?? []).join(", "),
  ...(a.type && { type: a.type }),
  ...(a.rules && { rules: a.rules }),
  on: a.on,
});

// What goes to the desk for a draft: the whole automation, as the desk keeps it. A rule's verb is the one thing it may do.
export function bodyOf(d: Draft): AutomationBody {
  const rule = d.decide === "rule" ? (d.rule ?? { do: "fyi" as const, why: "" }) : undefined;
  const can = rule ? [rule.do] : d.can;
  const mcp = d.decide === "agent" ? serversOf(d.mcp) : [];
  const edited: Whole<Omit<AutomationBody, "buttons" | "icon">> = {
    name: d.name,
    schedule: d.schedule,
    events: d.schedule ? undefined : d.events,
    prompt: rule ? "" : d.prompt,
    when: d.when.trim() || undefined,
    decide: d.decide === "agent" ? undefined : d.decide,
    rule,
    can: can.join() === "add" ? undefined : can,
    mcp: mcp.length ? mcp : undefined,
    type: d.type === "" ? undefined : d.type,
    rules: d.rules?.length ? d.rules : undefined,
    on: d.on,
  };
  return { ...d.base, ...edited };
}

// An automation as an edit being saved makes it: drawn so until the desk's copy has it.
export function shownAs(a: AutomationView, d: Draft): AutomationView {
  const { events: _e, when: _w, decide: _d, rule: _r, can: _c, mcp: _m, buttons: _b, icon: _i, type: _t, rules: _ru, ...kept } = a;
  const b = bodyOf(d);
  const starts = (x: { schedule?: string | undefined; events?: readonly string[] | undefined }) =>
    JSON.stringify([x.schedule ?? "", x.events ?? []]);
  return {
    ...kept,
    // Only the desk words a schedule: a new one's words come with the read back.
    ...(starts(b) !== starts(a) && { trigger: "Saving…" }),
    name: b.name,
    schedule: b.schedule ?? "",
    prompt: b.prompt ?? "",
    ...(b.events && b.events.length > 0 && { events: b.events }),
    ...(b.when && { when: b.when }),
    ...(b.decide && b.decide !== "agent" && { decide: b.decide }),
    ...(d.decide === "rule" && d.rule && { rule: d.rule }),
    ...(b.can && { can: b.can }),
    ...(b.mcp && { mcp: b.mcp }),
    ...(b.buttons && { buttons: b.buttons }),
    ...(b.icon && { icon: b.icon }),
    ...(b.type && { type: b.type }),
    ...(d.rules && d.rules.length > 0 && { rules: d.rules }),
    on: b.on ?? a.on,
  };
}
