import { test } from "node:test";
import assert from "node:assert/strict";
import { BUDGETS, readOwnSkill, skillText } from "../src/connectors/github-review.ts";
import { buildPrompt, parseReview, reviewOrder } from "../src/review.ts";
import { analyze } from "../src/signals.ts";
import { parseConfig, defaultConfigText } from "../src/config.ts";
import type { AiReview, ReviewFile } from "../src/types.ts";
import { makeContext, makeItem, NOW } from "./helpers/items.ts";

const PATCH = [
  "@@ -10,3 +10,8 @@ export function plan(q: Query) {",
  "   const rows = scan(q);",
  "-  return rows;",
  "+  if (q.limit < 0) throw new RangeError(q.limit);",
  "+  const limited = rows.slice(0, q.limit);",
  "+  audit(limited);",
  "+  metrics.count(limited.length);",
  "+  log(limited);",
  "+  return limited;",
  "   // end",
].join("\n");
const FILE: ReviewFile = { path: "src/plan.ts", previous_path: null, status: "modified", additions: 6, deletions: 1, patch: PATCH };
const at = (line: number, quote: string, more: Record<string, unknown> = {}) => ({ path: FILE.path, side: "new", line, quote, ...more });
const concern = (i: number) => at(12, "const limited = rows.slice(0, q.limit);", { body: `Concern ${i}.` });

test("the risk the reviewer judged sets every cap: low keeps one concern and three things in the code, high keeps more", () => {
  const answer = (risk: string) => ({
    risk,
    summary: "x",
    risk_reasons: [
      { factor: "data", why: "rewrites rows" },
      { factor: "contract", why: "changes plan()" },
      { factor: "nonsense", why: "dropped: not a factor" },
    ],
    concerns: [concern(1), concern(2), concern(3)],
    look: [at(11, "if (q.limit < 0) throw new RangeError(q.limit);", { end: 99, why: "the guard" })],
    notes: [at(13, "audit(limited);", { body: "Audits." }), at(14, "metrics.count(limited.length);", { body: "Counts." })],
    improvements: [at(15, "log(limited);", { body: "Log the count, not the rows." })],
  });
  const low = parseReview(answer("low"), [FILE]);
  assert.deepEqual(low.concerns, ["Concern 1."]);
  assert.equal(low.look!.length, 1);
  assert.equal(low.notes.length + low.look!.length + low.improvements!.length, BUDGETS.low.inCode, "concerns are notes too");
  assert.deepEqual(low.risk_reasons, [], "low has no reasons");
  const high = parseReview(answer("high"), [FILE]);
  assert.deepEqual(high.concerns, ["Concern 1.", "Concern 2.", "Concern 3."]);
  assert.deepEqual(
    high.risk_reasons!.map((r) => r.factor),
    ["data", "contract"],
  );
  assert.equal(high.improvements!.length, 1);
  assert.equal(high.notes.length, 5);
  assert.equal(parseReview({ ...answer("high"), verdict: "skip" }, [FILE]).verdict, "skim", "high risk is never skip");
});

test("a look range is clipped to its hunk and 15 lines, and lands on its hunk in the reading order; one whose quote isn't in the diff is out", () => {
  const r = parseReview(
    {
      risk: "high",
      summary: "x",
      chunks: [{ id: "h1", level: "look", why: "" }],
      look: [
        at(11, "if (q.limit < 0) throw new RangeError(q.limit);", { end: 99, why: "the guard" }),
        at(12, "not in the diff", { end: 13, why: "x" }),
      ],
    },
    [FILE],
  );
  assert.deepEqual(r.look, [{ path: FILE.path, side: "new", line: 11, end: 17, why: "the guard" }]);
  const ai: AiReview = { ...r, head_oid: "h", model: "m", at: NOW.toISOString() };
  assert.deepEqual(reviewOrder([FILE], ai, false).chunks[0]!.looks, [0]);
});

test("interfaces and improvements are placed like notes; a breaking interface needs a quote, intent's gap only when it doesn't fit", () => {
  const r = parseReview(
    {
      risk: "medium",
      summary: "x",
      intent: { goal: "Caps the rows a plan returns.", fit: "matches", gap: "should vanish", stack: "" },
      interfaces: [
        at(10, "const rows = scan(q);", {
          name: "plan()",
          kind: "function",
          change: "changed",
          breaking: true,
          impact: "Callers get fewer rows.",
        }),
        at(10, "nope", { name: "ghost", kind: "type", change: "added", breaking: false, impact: "x" }),
        at(10, "const rows = scan(q);", { name: "", kind: "type", change: "added", breaking: false, impact: "no name" }),
      ],
    },
    [FILE],
  );
  assert.deepEqual(r.interfaces, [
    {
      name: "plan()",
      kind: "function",
      change: "changed",
      breaking: true,
      impact: "Callers get fewer rows.",
      path: FILE.path,
      side: "new",
      line: 10,
    },
  ]);
  assert.deepEqual(r.intent, { goal: "Caps the rows a plan returns.", fit: "matches", gap: "", stack: "" });
  const partial = parseReview({ summary: "x", intent: { goal: "g", fit: "partial", gap: "Also logs rows.", stack: "s" } }, [FILE]);
  assert.equal(partial.intent!.gap, "Also logs rows.");
  assert.ok(!("intent" in parseReview({ summary: "x" }, [FILE])), "no goal, no intent");
});

test("a step keeps its note and a diagram it names only when the diagram survived the grammar; notes and diagrams are capped by risk", () => {
  const files: ReviewFile[] = [FILE, { ...FILE, path: "src/b.ts" }, { ...FILE, path: "src/c.ts" }];
  const flow = 'flowchart LR\n  a["fetch"] --> b["plan"] --> c[("rows")]:::new';
  const r = parseReview(
    {
      risk: "low",
      summary: "x",
      chunks: ["h1", "h2", "h3"].map((id) => ({ id, level: "look", why: "" })),
      steps: [
        { title: "One", body: "", check: "", note: "Ships before the migration.", diagram: "d1", hunks: ["h1"] },
        { title: "Two", body: "", check: "", note: "Over the low cap.", diagram: "d2", hunks: ["h2", "h3"] },
      ],
      diagrams: [
        { id: "d1", title: "The new path", caption: "c", source: flow },
        { id: "d2", title: "Over the low cap", caption: "c", source: flow },
        {
          id: "d3",
          title: "Refused",
          caption: "c",
          source: 'flowchart LR\n  a --> b\n  click a "javascript:alert(1)"\n  b --> c\n  <img src=x>',
        },
      ],
    },
    files,
  );
  assert.deepEqual(
    r.guide!.steps.map((st) => [st.note, st.diagram]),
    [
      ["Ships before the migration.", "d1"],
      [undefined, undefined],
    ],
    "one note and one diagram at low risk",
  );
  assert.deepEqual(
    r.diagrams!.map((d) => [d.id, d.graph.kind]),
    [["d1", "flow"]],
  );
});

test("the owner's review.md adds instructions, replaces a section and switches parts off, which empties their fields", () => {
  const own = readOwnSkill(
    ["Care about migrations.", "off: diagrams, improvements, risk", "## concerns", "- concerns: only data loss.", "## bogus", "x"].join(
      "\n",
    ),
  );
  assert.deepEqual([...own.off], ["diagrams", "improvements"], "risk can't be switched off");
  const t = skillText({ me: "me", mine: false, since: null, stacked: false }, own);
  assert.match(t, /\n- concerns: only data loss\.\n/);
  assert.doesNotMatch(t, /defects or risky behaviour changes/);
  assert.match(t, /- diagrams: always an empty list\./);
  assert.match(t, /me's own instructions for their reviews .*:\nCare about migrations\.\nx$/, "an unknown heading's text is theirs too");
  const r = parseReview({ risk: "high", summary: "x", improvements: [at(15, "log(limited);", { body: "b" })] }, [FILE], own.off);
  assert.deepEqual(r.improvements, []);
});

test("the prompt asks for risk first and, for your own PR, concerns written for you as the author", () => {
  const cfg = parseConfig(defaultConfigText({ workOrgs: ["acme"] })).loaded!.config;
  const mine = makeItem({ author: "me" });
  const p = buildPrompt(mine, analyze(mine, makeContext(), cfg, NOW).signals, "", { body: "", files: [FILE] }, "TAG");
  assert.ok(p.indexOf("Judge the risk first") < p.indexOf("- concerns:"));
  assert.match(p, /Write them for the author/);
  assert.match(p, /- verdict: what me should do next with their own PR/);
});
