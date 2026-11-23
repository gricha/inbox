// PUT /api/automations/:id's body, one schema for the desk, its mock and the window (nothing here is Node's): its keys,
// the limits the desk keeps it to, and a saved automation as the body that saves it again unchanged.
import { Result, Schema } from "effect";
import { keysOf, schemaOf } from "./narrow.ts";
import { ACTIVITY_KINDS, ITEM_DOES, VERBS, WAYS, type Automation, type AutomationBody, type NoteButton } from "./types.ts";

// What Automations.set() refuses past, and MCP's inbox_automations says up front.
export const LIMITS = {
  name: 80,
  prompt: 8_000,
  why: 300, // a rule's
  servers: 10, // mcp
  server: 100, // one server's name
  buttons: 3,
  label: 24,
  ask: 1_000, // an Ask button's prompt, and a rule's ask
  type: 4_000,
  rules: 10,
} as const;

const list = <S extends Schema.Top>(s: S) => Schema.mutable(Schema.Array(s));
const opt = Schema.optional;

export const NoteButtonSchema = schemaOf<NoteButton>()(
  Schema.Union([
    Schema.Struct({ label: Schema.String, do: Schema.Literal("open") }),
    Schema.Struct({ label: Schema.String, do: Schema.Literal("ask"), prompt: Schema.String }),
  ]),
);

const AutomationBodySchema = schemaOf<AutomationBody>()(
  Schema.Struct({
    name: Schema.String,
    schedule: opt(Schema.String),
    events: opt(list(Schema.Literals(ACTIVITY_KINDS))),
    prompt: opt(Schema.String),
    when: opt(Schema.String),
    decide: opt(Schema.Literals(WAYS)),
    rule: opt(Schema.Struct({ do: Schema.Literals(VERBS), why: Schema.String, until: opt(Schema.String) })),
    can: opt(list(Schema.Literals(VERBS))),
    mcp: opt(list(Schema.String)),
    buttons: opt(list(NoteButtonSchema)),
    icon: opt(Schema.String),
    type: opt(Schema.String),
    rules: opt(list(Schema.Struct({ when: opt(Schema.String), ask: opt(Schema.String), do: Schema.Literals(ITEM_DOES) }))),
    on: opt(Schema.Boolean),
  }),
);

// A body as sent, in Effect's words when it isn't one; a key it doesn't know is refused, not dropped.
export const decodeAutomationBody = (v: unknown): Result.Result<AutomationBody, string> =>
  Schema.decodeUnknownResult(AutomationBodySchema, { onExcessProperty: "error" })(v).pipe(Result.mapError((e) => e.message));

// A list that must name every key of T: one T has and the list lacks fails to compile.
const everyKey =
  <T>() =>
  <K extends keyof T>(ks: readonly K[] & ([keyof T] extends [K] ? unknown : never)): readonly K[] =>
    ks;
export const AUTOMATION_BODY_KEYS = everyKey<AutomationBody>()(keysOf(AutomationBodySchema.fields));

// Every key of T present, an optional one perhaps undefined: what's built as one can't leave a field out.
export type Whole<T> = { [K in keyof T]-?: T[K] };

// A saved automation as the body that saves it again as it is.
export function automationBody(a: Automation): AutomationBody {
  const b: Whole<AutomationBody> = {
    name: a.name,
    schedule: a.schedule,
    events: a.events,
    prompt: a.prompt,
    when: a.when,
    decide: a.decide,
    rule: a.rule,
    can: a.can,
    mcp: a.mcp,
    buttons: a.buttons,
    icon: a.icon,
    type: a.type,
    rules: a.rules,
    on: a.on,
  };
  return b;
}
