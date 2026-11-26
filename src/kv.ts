// What the desk keeps in kv (`Store.read()`, `Store.prefixed()`), checked as it's read back: a value in a shape it no longer
// has reads as absent.
import { Schema } from "effect";
import { NoteButtonSchema } from "./automation-body.ts";
import { schemaOf } from "./narrow.ts";
import {
  BUCKETS,
  INBOX_SECTIONS,
  type AiReview,
  type Ask,
  type Bucket,
  type DeepReview,
  type Handoff,
  type IssueReview,
  type Note,
  type Place,
  type Recommendation,
  type ReviewFile,
} from "./types.ts";

// An automation's sort of an item (kv `sorted:<id>`): good while the item is what it sorted (sortKey) and you haven't acted
// on it.
export interface Sorted {
  automation: string;
  name: string;
  bucket: Bucket;
  why: string;
  key: string;
  at: string;
}
// An automation's snooze, done or mute of an item (kv `acted:<id>`): its why, while that action is the item's latest.
export interface Acted {
  name: string;
  why: string;
  seq: number;
}

// Agents' hand-offs (inbox_add) of an item, by the seq of the pin each made.
type Added = Record<string, Handoff>;

// A PR's Merging record, in kv under the babysitters' old `sitter:` prefix so hand-backs made before survive.
export interface Merging {
  handback?: { reason: string; at: string };
  note?: { text: string; at: string };
  rebase?: string; // when the desk gave it to the coordinator to rebase, ready to merge but for a conflict
  back?: string; // when you brought it back with b
}

export const arrayOf = <S extends Schema.Top>(s: S) => Schema.mutable(Schema.Array(s));
const opt = Schema.optionalKey;
const lineSide = Schema.Literals(["new", "old"]);
export const PlaceSchema = schemaOf<Place>()(
  Schema.Struct({
    section: Schema.Literals(INBOX_SECTIONS),
    rank: Schema.Number,
    after: opt(Schema.String),
    before: opt(Schema.String),
    at: opt(Schema.String),
    seen: opt(Schema.String),
  }),
);
export const SortedSchema = schemaOf<Sorted>()(
  Schema.Struct({
    automation: Schema.String,
    name: Schema.String,
    bucket: Schema.Literals(BUCKETS),
    why: Schema.String,
    key: Schema.String,
    at: Schema.String,
  }),
);
export const ActedSchema = schemaOf<Acted>()(Schema.Struct({ name: Schema.String, why: Schema.String, seq: Schema.Number }));
const HandoffSchema = schemaOf<Handoff>()(Schema.Struct({ why: Schema.String, from: Schema.String }));
export const AddedSchema = schemaOf<Added>()(Schema.Record(Schema.String, HandoffSchema));
// An automation's find (kv `pushed:<id>`): who found it and why, and what it was each time it added it (`once`).
const PushedSchema = Schema.Struct({
  name: Schema.String,
  why: Schema.String,
  once: opt(Schema.Record(Schema.String, Schema.String)),
});
export const MergingSchema = schemaOf<Merging>()(
  Schema.Struct({
    handback: opt(Schema.Struct({ reason: Schema.String, at: Schema.String })),
    note: opt(Schema.Struct({ text: Schema.String, at: Schema.String })),
    rebase: opt(Schema.String),
    back: opt(Schema.String),
  }),
);
const BlockedSchema = Schema.Record(Schema.String, Schema.Struct({ since: Schema.String, by: Schema.String }));
export type Blocked = typeof BlockedSchema.Type;
const ReviewNoteSchema = Schema.Struct({ path: Schema.String, line: Schema.Number, side: lineSide, body: Schema.String });
const DiagramGraphSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("flow"),
    direction: Schema.Literals(["LR", "TB"]),
    nodes: arrayOf(
      Schema.Struct({
        id: Schema.String,
        label: Schema.String,
        shape: Schema.Literals(["box", "term", "store", "choice", "circle"]),
        mark: Schema.NullOr(Schema.Literals(["new", "changed", "removed"])),
        group: Schema.NullOr(Schema.String),
      }),
    ),
    edges: arrayOf(
      Schema.Struct({
        from: Schema.String,
        to: Schema.String,
        label: Schema.String,
        style: Schema.Literals(["arrow", "line", "dotted"]),
      }),
    ),
    groups: arrayOf(Schema.Struct({ id: Schema.String, label: Schema.String })),
  }),
  Schema.Struct({
    kind: Schema.Literal("sequence"),
    participants: arrayOf(Schema.Struct({ id: Schema.String, label: Schema.String, actor: Schema.Boolean })),
    messages: arrayOf(Schema.Struct({ from: Schema.String, to: Schema.String, text: Schema.String, reply: Schema.Boolean })),
    notes: arrayOf(Schema.Struct({ over: arrayOf(Schema.String), text: Schema.String, at: Schema.Number })),
  }),
]);
export const AiReviewSchema = schemaOf<AiReview>()(
  Schema.Struct({
    verdict: Schema.Literals(["look", "skim", "skip"]),
    risk: Schema.Literals(["low", "medium", "high"]),
    summary: Schema.String,
    since: opt(Schema.String),
    concerns: arrayOf(Schema.String),
    notes: arrayOf(ReviewNoteSchema),
    dropped: opt(Schema.Number),
    chunks: opt(
      Schema.Struct({
        ranked: arrayOf(
          Schema.Struct({ id: Schema.String, path: Schema.String, level: Schema.Literals(["look", "skim"]), why: Schema.String }),
        ),
        unread: arrayOf(Schema.String),
        total: Schema.Number,
      }),
    ),
    guide: opt(
      Schema.Struct({
        steps: arrayOf(
          Schema.Struct({
            title: Schema.String,
            body: Schema.String,
            check: Schema.String,
            note: opt(Schema.String),
            diagram: opt(Schema.String),
            hunks: arrayOf(Schema.Struct({ id: Schema.String, path: Schema.String })),
          }),
        ),
      }),
    ),
    risk_reasons: opt(
      arrayOf(
        Schema.Struct({
          factor: Schema.Literals(["data", "security", "contract", "concurrency", "deploy", "irreversible", "reach", "untested", "other"]),
          why: Schema.String,
        }),
      ),
    ),
    intent: opt(
      Schema.Struct({
        goal: Schema.String,
        fit: Schema.Literals(["matches", "partial", "differs", "undescribed"]),
        gap: Schema.String,
        stack: Schema.String,
      }),
    ),
    look: opt(arrayOf(Schema.Struct({ path: Schema.String, side: lineSide, line: Schema.Number, end: Schema.Number, why: Schema.String }))),
    interfaces: opt(
      arrayOf(
        Schema.Struct({
          name: Schema.String,
          kind: Schema.Literals(["function", "type", "endpoint", "schema", "config", "event", "cli", "permission", "other"]),
          change: Schema.Literals(["added", "changed", "removed"]),
          breaking: Schema.Boolean,
          impact: Schema.String,
          path: Schema.String,
          side: lineSide,
          line: Schema.Number,
        }),
      ),
    ),
    improvements: opt(arrayOf(ReviewNoteSchema)),
    diagrams: opt(
      arrayOf(
        Schema.Struct({
          id: Schema.String,
          title: Schema.String,
          caption: Schema.String,
          source: opt(Schema.String),
          graph: DiagramGraphSchema,
        }),
      ),
    ),
    skill: opt(Schema.String),
    doc: opt(Schema.String),
    refused: opt(arrayOf(Schema.String)),
    code: opt(Schema.Boolean),
    tags: opt(Schema.Record(Schema.String, arrayOf(Schema.String))),
    head_oid: Schema.String,
    model: Schema.String,
    at: Schema.String,
  }),
);
export const IssueReviewSchema = schemaOf<IssueReview>()(
  Schema.Struct({
    updated_at: Schema.String,
    at: Schema.String,
    model: Schema.String,
    injection: Schema.NullOr(Schema.Struct({ who: Schema.String, why: Schema.String })),
    kind: Schema.Literals(["bug", "feature", "question", "other"]),
    summary: Schema.String,
    problem: Schema.String,
    cause: Schema.String,
    evidence: arrayOf(Schema.Struct({ path: Schema.String, line: Schema.Number, why: Schema.String })),
    fix: Schema.String,
    fixable: Schema.Boolean,
    steps: arrayOf(Schema.Struct({ title: Schema.String, body: Schema.String })),
    code: Schema.Boolean,
    repo_dir: opt(Schema.String),
    base: opt(Schema.String),
  }),
);
const IssueFailSchema = Schema.Struct({ updated_at: Schema.String, error: Schema.String, at: Schema.String });
export type IssueFail = typeof IssueFailSchema.Type;
const ReviewFileSchema = schemaOf<ReviewFile>()(
  Schema.Struct({
    path: Schema.String,
    previous_path: Schema.NullOr(Schema.String),
    status: Schema.Literals(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]),
    additions: Schema.Number,
    deletions: Schema.Number,
    patch: Schema.NullOr(Schema.String),
    sha: opt(Schema.String),
  }),
);
// The changed files and description kept per head commit (kv `pr:<id>`); the owner's review.md is read fresh each run.
export const PrTextSchema = Schema.Struct({
  body: Schema.String,
  files: arrayOf(ReviewFileSchema),
  head: opt(Schema.String),
  since: opt(Schema.Struct({ base: Schema.String, files: arrayOf(ReviewFileSchema) })),
  stack: opt(arrayOf(Schema.String)),
  skill: opt(Schema.String),
  head_oid: Schema.String,
});
export const AskSchema = schemaOf<Ask>()(
  Schema.Struct({
    id: Schema.String,
    at: Schema.String,
    text: Schema.String,
    item_id: Schema.NullOr(Schema.String),
    thread_id: Schema.NullOr(Schema.String),
    thread_url: Schema.NullOr(Schema.String),
    lines: opt(
      Schema.NullOr(
        Schema.Struct({
          path: Schema.String,
          line: Schema.Number,
          side: lineSide,
          start: opt(Schema.Struct({ line: Schema.Number, side: lineSide })),
          head: Schema.String,
          note: opt(Schema.Boolean),
        }),
      ),
    ),
    fix: opt(Schema.Boolean),
    note: opt(
      Schema.Struct({
        text: Schema.String,
        body: opt(Schema.String),
        url: opt(Schema.String),
        from: opt(Schema.Struct({ id: Schema.String, name: Schema.String })),
        fields: opt(Schema.Record(Schema.String, Schema.Unknown)),
      }),
    ),
    answer: Schema.NullOr(Schema.Struct({ text: Schema.String, at: Schema.String })),
  }),
);
const InquiryOptionSchema = Schema.Struct({ answer: Schema.String, next: Schema.String });
// Questions asked before options said what follows had plain options and no links.
// A recommendation by what it does; one stored in a shape none of them has reads as absent, and its question with it.
const recommended = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Struct({
    automation: Schema.String,
    held: Schema.String,
    item: Schema.Struct({ text: Schema.String, fields: Schema.Unknown }),
    error: Schema.String,
    ...fields,
  });
const RecommendationSchema = schemaOf<Recommendation>()(
  Schema.Union([
    recommended({ do: Schema.Literal("fix"), fields: Schema.Record(Schema.String, Schema.Unknown) }),
    recommended({ do: Schema.Literal("type"), type: Schema.String, was: opt(Schema.String) }),
    recommended({ do: Schema.Literal("prompt"), prompt: Schema.String, was: Schema.String }),
    recommended({ do: Schema.Literal("drop") }),
  ]),
);
export const KeptInquirySchema = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  from: Schema.String,
  question: Schema.String,
  context: Schema.String,
  options: arrayOf(Schema.Union([Schema.String, InquiryOptionSchema])),
  links: opt(arrayOf(Schema.Struct({ label: Schema.String, url: Schema.String }))),
  item_id: Schema.NullOr(Schema.String),
  answer: Schema.NullOr(
    Schema.Struct({ text: Schema.String, at: Schema.String, dismissed: Schema.Boolean, read_at: opt(Schema.NullOr(Schema.String)) }),
  ),
  fix: opt(RecommendationSchema),
  place: opt(PlaceSchema),
});

export const NoteSchema = schemaOf<Omit<Note, "waiting" | "facts">>()(
  Schema.Struct({
    id: Schema.String,
    at: Schema.String,
    text: Schema.String,
    remind_at: Schema.NullOr(Schema.String),
    reminded_at: Schema.NullOr(Schema.String),
    section: opt(Schema.Literals(INBOX_SECTIONS)),
    from: opt(Schema.Struct({ id: Schema.String, name: Schema.String })),
    body: opt(Schema.String),
    url: opt(Schema.String),
    buttons: opt(Schema.mutable(Schema.Array(NoteButtonSchema))),
    icon: opt(Schema.String),
    fields: opt(Schema.Record(Schema.String, Schema.Unknown)),
    place: opt(PlaceSchema),
  }),
);

// A PR's deep review as the agent answers it, and as the desk keeps it with its last failure (kv `deep:<id>`).
export const DeepAnswerSchema = Schema.Struct({
  intent: Schema.String,
  intent_from: Schema.Literals(["stated", "inferred", "missing"]),
  lean: Schema.Literals(["ship", "fix first", "rethink"]),
  premises: arrayOf(
    Schema.Struct({ premise: Schema.String, verdict: Schema.Literals(["holds", "fails", "unknown"]), evidence: Schema.String }),
  ),
  wrong: arrayOf(
    Schema.Struct({
      what: Schema.String,
      why: Schema.String,
      evidence: arrayOf(Schema.String),
      severity: Schema.Literals(["blocker", "fix"]),
    }),
  ),
  ask: arrayOf(Schema.Struct({ question: Schema.String, why: Schema.String })),
  author_fixes: arrayOf(Schema.String),
  checked: Schema.Struct({ summary: Schema.String, tests: Schema.String, probes: Schema.Number }),
});
const DeepReviewSchema = schemaOf<DeepReview>()(
  Schema.Struct({
    ...DeepAnswerSchema.fields,
    head_oid: Schema.String,
    model: Schema.String,
    at: Schema.String,
    seconds: Schema.Number,
  }),
);
const DeepSchema = Schema.Struct({ review: Schema.NullOr(DeepReviewSchema), error: Schema.NullOr(Schema.String) });

// The kv keys with a shape of their own, and the prefixes whose keys (`issue_fail:<id>`) share one, read and written typed
// through Store.kv(), putKv(), kvAt(), putKvAt() and byPrefix(). The rest still go through read() and set().
export const KV = { blocked: BlockedSchema } as const;
export const KV_PREFIX = { "issue_fail:": IssueFailSchema, "pushed:": PushedSchema, "deep:": DeepSchema } as const;
