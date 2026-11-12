// The AI review's default instructions, the GitHub plugin's review skill: one section per part of the answer (and one on anchoring), by a stable
// id the owner's ~/.inbox/review.md can replace (`## <id>`) or switch off (`off: <id>, …`). The schema, caps, fence and
// checker live in src/review.ts; this is only what the reviewer is asked to write.

// Bumped when the default instructions change, so a review says which it was written with.
export const REVIEW_SKILL_VERSION = "3";

export interface SkillContext {
  me: string; // the owner's login
  mine: boolean; // their own PR
  since: string | null; // the short sha they last reviewed, for a re-review
  stacked: boolean;
}

export interface Budget {
  inCode: number; // concerns + look + improvements + notes
  concerns: number;
  look: number;
  improvements: number;
  reasons: number;
  interfaces: number;
  chunks: number;
  steps: number;
  stepNotes: number;
  diagrams: number;
}

// Ceilings by the risk the reviewer returns; the parser enforces the returned risk's column whatever the text says.
export const BUDGETS: Record<"low" | "medium" | "high", Budget> = {
  low: { inCode: 3, concerns: 1, look: 1, improvements: 1, reasons: 0, interfaces: 2, chunks: 8, steps: 3, stepNotes: 1, diagrams: 1 },
  medium: { inCode: 6, concerns: 3, look: 2, improvements: 1, reasons: 2, interfaces: 3, chunks: 12, steps: 5, stepNotes: 2, diagrams: 1 },
  high: { inCode: 12, concerns: 6, look: 3, improvements: 3, reasons: 3, interfaces: 5, chunks: 20, steps: 8, stepNotes: 3, diagrams: 2 },
};

// The parts the owner can switch off: their cap drops to zero and their instructions say to leave the field empty.
const OPTIONAL = ["look", "interfaces", "improvements", "notes", "walk", "diagrams"] as const;

const budgetLine = (r: "low" | "medium" | "high") => {
  const b = BUDGETS[r];
  return `  ${r}: at most ${b.inCode} things in the code (concerns ≤${b.concerns}, look ≤${b.look}, improvements ≤${b.improvements}, the rest notes), ${b.reasons} risk reasons, ${b.interfaces} interfaces, ${b.chunks} ranked hunks, ${b.steps} steps (${b.stepNotes} with a note), ${b.diagrams} ${b.diagrams === 1 ? "diagram" : "diagrams"};`;
};

const SECTIONS: readonly { id: string; text: (c: SkillContext) => string }[] = [
  {
    id: "budget",
    text: (c) =>
      [
        `Judge the risk first: it sets how much you write. Then write every field; each may be empty, and empty is the usual answer when nothing qualifies. Budgets by risk (ceilings, not targets: every item you add takes ${c.me}'s attention from the others):`,
        budgetLine("low"),
        budgetLine("medium"),
        budgetLine("high"),
      ].join("\n"),
  },
  {
    id: "risk",
    text: () =>
      `- risk: "low", "medium" or "high": how much breaks, for whom, and how hard it is to undo, if this change is wrong. Not its size.` +
      ` high: it can lose or corrupt data; crosses a security boundary (auth, permissions, secrets, untrusted input); breaks a contract others build on (a public API, a schema, a wire format, config or a CLI others use); runs a migration or anything that can't be rolled back; or changes concurrency or a deploy path that can take a service down.` +
      ` medium: it changes behaviour users or other code depend on, inside one boundary, and a revert undoes it.` +
      ` low: the same behaviour as before (refactors, renames, tests, docs, copy), off by default, or a patch-level dependency bump.\n` +
      `- risk_reasons: why, most serious first, within the budget; empty when low. Each: factor (data, security, contract, concurrency, deploy, irreversible, reach, untested or other) and why, at most twelve words, naming the thing ("rewrites user rows in place").`,
  },
  {
    id: "intent",
    text: () =>
      `- intent: goal, one sentence: what the PR is for, as an outcome, not which files change. fit: "matches" when the diff does what its description says and no more; "partial" when it does part of it, or more; "differs" when it does something else; "undescribed" when there's nothing to compare. gap: one sentence on the difference, or "".`,
  },
  {
    id: "stack",
    text: (c) =>
      c.stacked
        ? `  intent.stack: it's in a stack (listed below, with the goal of each PR below it when known): one sentence on where it sits and what it adds over the PR below, naming what it takes from there without explaining it again. Fit is judged against its own description, and against the stack's titles when the description defers to them; a PR doing what another member's title promises is "partial", and gap says so.`
        : `  intent.stack: "".`,
  },
  {
    id: "verdict",
    text: (c) =>
      c.mine
        ? `- verdict: what ${c.me} should do next with their own PR: "look" (something to fix before asking for review), "skim" (worth a glance first) or "skip" (ready as it is). High risk is never "skip".`
        : `- verdict: "look" (read it closely), "skim" (glance at it) or "skip" (trivial, or not theirs to review). High risk is never "skip".`,
  },
  {
    id: "summary",
    text: () =>
      `- summary: how it does it, naming the main functions or files; two sentences when the risk is low, at most three otherwise.`,
  },
  {
    id: "since",
    text: (c) =>
      c.since
        ? `- since: ${c.me} reviewed it before, at ${c.since}. One sentence on what changed since then (the "since your review" diff), and whether that settles the concerns you'd raise.`
        : `- since: an empty string.`,
  },
  {
    id: "anchors",
    text: () =>
      `Anchoring (concerns, look, interfaces, improvements and notes): each diff line starts with its number: n12 is line 12 of the new file (added "+" or unchanged), o11 is line 11 of the old file (removed "-"). path: exactly as after "file:". side "new" with an n number; side "old" with an o number only for a removal with nothing added. line: that number. quote: that line of the diff, copied exactly, without its number or sign. Anchor on the first line of the change it's about.`,
  },
  {
    id: "concerns",
    text: (c) =>
      `- concerns: defects or risky behaviour changes you'd bet on: code in this diff that does the wrong thing for a concrete input or caller.${c.mine ? ` Write them for the author: what a reviewer would stop on, worth fixing before asking for review.` : ""} No style; no "add tests" unless a specific path this diff adds is untested and that is what makes it risky. Each: body, three to six sentences: what goes wrong, when (a concrete input, caller or path through this code), and what would fix it; then "Evidence:" what in this diff shows it (the lines, and the values that flow through them to the failure) and how to confirm it (an input to try, a test to write, or the caller to read); anchored (path, side, line, quote: the line or lines that show it). A suspicion you can't back with evidence from this diff isn't a concern: write it as a note saying what to check.` +
      ` The desk shows each concern on its line in the code, so don't also write it as a note.`,
  },
  {
    id: "look",
    text: (c) =>
      `- look: the places ${c.me} must read even if they read nothing else: where the change's correctness hinges (the new invariant, the boundary check, the migration step). Each: anchored on its first line, end (its last line, at most 15 lines on, in the same hunk), why (at most twelve words: what to verify there). Not a concern again.`,
  },
  {
    id: "interfaces",
    text: () =>
      `- interfaces: what this PR adds, changes or removes that other code, services, users, stored data or the PRs above it rely on: exported functions and types, HTTP routes, schemas and migrations, events and wire formats, config keys, CLI flags, permissions. Not internal helpers. Each: name; kind (function, type, endpoint, schema, config, event, cli, permission or other); change (added, changed or removed); breaking (true only when an existing caller or stored data stops working as before); impact (one sentence: who depends on it, a stack member above by its title included, and what changes for them); anchored where it is.`,
  },
  {
    id: "improvements",
    text: () =>
      `- improvements: apart from concerns: a change that makes this PR clearly better and that its author could make in this PR (a simpler shape, a guard on a path the diff adds, a name that misleads). Not style, not taste, not another PR's work. Each: body (one or two sentences: what and why), anchored.`,
  },
  {
    id: "notes",
    text: (c) =>
      `- notes: short notes, written for ${c.me} as the reviewer, within the in-code budget: context on the hunks worth explaining, one or two sentences each, about the change this PR makes there: what's different now and why it matters (a behaviour that changed, a caller it affects, an assumption it relies on). Never describe what a function or the code does in general, and never restate the diff. Not line-by-line commentary: skip imports, renames, formatting, tests that just mirror the code, and generated files. Each: body, anchored.`,
  },
  {
    id: "chunks",
    text: (c) =>
      `- chunks: the hunks worth ${c.me}'s attention, in the order to read them: ${c.since ? "they reviewed it before, so what changed since then first, then the rest, most worth first" : "the look ranges' hunks first, then most worth first, looks before skims"}. Each hunk's @@ line starts with its id (h1, h2, …). For each: id; level "look" (read it closely: logic, behaviour, data, security) or "skim" (glance at it); why in at most six words.` +
      ` Leave out everything not worth reviewing: imports, renames, formatting, generated files, lockfiles, snapshots, tests that just mirror the code. Empty when nothing is worth a look.`,
  },
  {
    id: "walk",
    text: (c) =>
      `- steps: a walk through the change for ${c.me}, in the order that makes it easiest to understand, not the order of importance: start where the change starts (the new type, contract or core function), then what builds on it, then its callers, then wiring and tests.${c.stacked ? " In a stack, start from what this PR takes from the one below, by name." : ""} Two steps or more, each a part of the change, not a file; an empty list when the PR is one small change.` +
      ` For each: title, at most six words; body, one or two sentences on what this part changes and why it's read at this point; check, one sentence on what to verify here, or an empty string; note: block prose for the step, at most three sentences, only when it needs context no single line carries (an order things must ship in, how two parts fit, what was there before), else ""; diagram: the id of the diagram drawn for this step, or ""; hunks, the ids it covers, from any files, in the order to read them.` +
      ` Put every hunk in chunks in exactly one step. Describe; anything you'd assert about a bug belongs in concerns.`,
  },
  {
    id: "diagrams",
    text: () =>
      [
        `- diagrams: draw one only when the change is a structure prose describes worse: a data flow across three or more components that this PR adds or reroutes, a state machine it adds or changes, a call path whose shape changes (one graph, nodes marked :::new, :::changed or :::removed), or a protocol between three or more parties (a sequence). Never one function, a list of files, or the steps restated. Each: id (d1, d2), title (at most six words), caption (one sentence: what to notice), source: Mermaid, only:`,
        `    flowchart LR or TB; nodes id["label"], id[("label")] (a store), id{"label"} (a decision), id(["label"]) (an end); edges -->, -.-> or ---, labelled -->|"label"|; subgraph id ["label"] … end; :::new, :::changed, :::removed.`,
        `    stateDiagram-v2 with [*] --> A and A --> B : event.`,
        `    sequenceDiagram with participant X as Label, A->>B: text, A-->>B: text (a reply), Note over A: text.`,
        `  Quote every label. At most 12 nodes and 16 edges, or 6 participants and 14 messages; labels at most 40 characters. Nothing else (no style, classDef, click or init): anything outside the subset drops the diagram.`,
      ].join("\n"),
  },
];

export interface OwnSkill {
  extra: string; // text under no heading: the owner's own instructions
  replaced: Map<string, string>; // ## <id> → its text
  off: Set<string>; // parts switched off (OPTIONAL only)
}

// ~/.inbox/review.md: text under no heading is the owner's own, `## <id>` replaces a section, `off: a, b` switches parts off.
export function readOwnSkill(md: string): OwnSkill {
  const own: OwnSkill = { extra: "", replaced: new Map(), off: new Set() };
  let at: string | null = null;
  const extra: string[] = [];
  const known = new Set(SECTIONS.map((s) => s.id));
  for (const line of md.split("\n")) {
    const head = /^##\s+([a-z]+)\s*$/.exec(line);
    const off = /^off:\s*(.*)$/i.exec(line);
    if (head) {
      at = known.has(head[1]!) ? head[1]! : null;
      if (at) own.replaced.set(at, "");
      continue;
    }
    if (off && at === null) {
      for (const id of off[1]!.split(",").map((s) => s.trim())) if ((OPTIONAL as readonly string[]).includes(id)) own.off.add(id);
      continue;
    }
    if (at) own.replaced.set(at, `${own.replaced.get(at)}${own.replaced.get(at) ? "\n" : ""}${line}`);
    else extra.push(line);
  }
  own.extra = extra.join("\n").trim();
  // A heading with nothing under it keeps the default.
  for (const [id, t] of own.replaced) {
    if (t.trim()) own.replaced.set(id, t.trim());
    else own.replaced.delete(id);
  }
  return own;
}

const OFF_FIELD: Record<string, string> = { walk: "steps" };

// The instructions as the reviewer reads them: the defaults, the owner's replacements, their switched-off parts as empty fields.
export function skillText(c: SkillContext, own: OwnSkill | null): string {
  const parts = SECTIONS.map((s) => {
    if (own?.off.has(s.id)) return `- ${OFF_FIELD[s.id] ?? s.id}: always an empty list.`;
    return own?.replaced.get(s.id) ?? s.text(c);
  });
  if (own?.extra)
    parts.push("", `${c.me}'s own instructions for their reviews (they come first where they differ from the above):`, own.extra);
  return parts.join("\n");
}
