export const meta = {
  name: "design-check",
  description:
    "Check a UI change as docs/visual.md's \"Checking a design change\" says: shoot it, look at every state at every size in light, dark and other themes, try what the shots can't against the mock, review the diff against the design rules, and verify each finding",
  whenToUse:
    'After a change under web/, assets/brand, scripts/icons.ts or scripts/shots.ts, before calling it done. args: { base?: "HEAD~1", only?: "settings,queue", dir?: "<another checkout>" }',
  phases: [
    { title: "Shoot", detail: "npm run shots, grouped by state" },
    { title: "Look", detail: "a critic per group of states, every size and theme" },
    { title: "Try", detail: "what the shots don't check, scripted against the mock" },
    { title: "Rules", detail: "the diff against AGENTS.md's design rules and docs/visual.md" },
    { title: "Verify", detail: "a skeptic per high or medium finding" },
  ],
};

const a = args || {};
const BASE = a.base || "HEAD~1";
const ONLY = a.only ? ` -- --only ${a.only}` : "";
const P = "PATH=/opt/homebrew/bin:$PATH";
const SHOTS = `${P} SHOTS_MOCK_PORT=47871 SHOTS_VITE_PORT=5271 npm run shots${ONLY}`;
const AT = a.dir ? ` Work in the checkout at ${a.dir}: run every command there and read its files, not the session's folder.` : "";
const RO = `Read-only: do not edit tracked files or commit; probes and scripts go under /tmp/design-check/. Prefix node tooling with ${P}.${AT}`;
const SPEC =
  'The design rules are AGENTS.md\'s product principle (its Design part) and Rules, docs/visual.md (the brand, the visual system, the layout, "Checking a design change") and docs/ui.md.';

const FINDINGS = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["high", "medium", "low"] },
          where: { type: "string" },
          problem: { type: "string" },
          evidence: { type: "string" },
          fix: { type: "string" },
        },
        required: ["severity", "where", "problem", "evidence", "fix"],
      },
    },
  },
  required: ["findings"],
};

phase("Shoot");
const shot = await agent(
  `Run the screenshots for this checkout from the repo root: \`${SHOTS}\` (it takes a while). ${RO}
Then list what it wrote to .shots/ grouped by state: the part of a file name after its size and theme (queue, review, beside-review, settings-github, inquiry, icons, theme-sand-review…); every file of a state goes in its group. Report every problem the run printed, verbatim: a shot that fails is a finding.`,
  {
    label: "shoot",
    phase: "Shoot",
    schema: {
      type: "object",
      properties: {
        problems: { type: "array", items: { type: "string" } },
        groups: {
          type: "array",
          items: {
            type: "object",
            properties: { state: { type: "string" }, files: { type: "array", items: { type: "string" } } },
            required: ["state", "files"],
          },
        },
      },
      required: ["problems", "groups"],
    },
  },
);
const groups = (shot && shot.groups) || [];
// About eight critics, each with neighbouring states at all their sizes and themes.
const per = Math.max(1, Math.ceil(groups.length / 8));
const batches = [];
for (let i = 0; i < groups.length; i += per) batches.push(groups.slice(i, i + per));
log(`${groups.length} states in ${batches.length} batches; the run reported ${(shot && shot.problems.length) || 0} problems`);

const look = (batch, i) =>
  agent(
    `You are a visual design critic. ${RO} ${SPEC}
Look with the Read tool at every one of these screenshots (in .shots/), comparing sizes and themes of the same state side by side: ${JSON.stringify(batch)}.
Judge them against the rules: hierarchy and calm (colour only where it carries information; the accent on calls to action); alignment (meta columns line up row to row; heads, rows and the list beside a review on one grid); legibility and contrast in every theme; the mark at its small sizes; the sidebar and its footer, page heads and the fold control; the macOS app's traffic lights; narrow and zoom sizes; anything clipped, overlapping, truncated wrongly, jumping between pages, or plainly ugly. Each finding names the PNG(s) and exactly what to change.`,
    { label: `look:${i + 1}`, phase: "Look", schema: FINDINGS },
  );

const tryIt = () =>
  agent(
    `You check what docs/visual.md's "Checking a design change" says the shots don't. ${RO} ${SPEC}
Start the mock desk and Vite the way that section says, on ports 47872 and 5272, then drive Chrome with playwright-core (channel "chrome", as scripts/shots.ts does) from a script under /tmp/design-check/, and check each of these with evidence: the desk going away and coming back; a failing sync (MOCK_SYNC_ERROR=1); a write the mock refuses; a refresh while you type a comment; the keyboard alone (Tab reaches a row and shows its ring, Enter opens it, Esc goes back); and anything that the change (\`git diff ${BASE}\`) touches and no shot covers. Each failed check is a finding, with the script's output; list what passed in the evidence of a low finding named "passed".`,
    { label: "try", phase: "Try", schema: FINDINGS },
  );

const rules = () =>
  agent(
    `You are the design-rules reviewer. ${RO} ${SPEC}
Review \`git diff ${BASE}\` (committed and uncommitted) under web/, assets/, scripts/, electron/, src/ where it's the UI's, and the docs. Check: sentence case; no boxed chips or highlighter; every action a click named in words and no key named in a window string (web/test/hints.test.ts); colour only where it carries information, and themes only through tokens (no literal colours outside the theme blocks); state stays on the desk and clients only render; accessibility (labels, aria-expanded and aria-controls, focus-visible distinct from selection, nothing reachable only by hover); the desktop shell's drag regions; Effects through runUi; a remount that would lose a draft or scroll; dead CSS; docs that no longer match the code. Each finding with file:line and the fix.`,
    { label: "rules", phase: "Rules", schema: FINDINGS },
  );

const verify = (f) =>
  agent(
    `Try to refute this design-review finding; if you can't confirm it from the screenshots, the scripts' output or the code, say it is refuted. ${RO} ${SPEC}
Finding: ${JSON.stringify(f)}`,
    {
      label: `verify:${(f.where || "").slice(0, 40)}`,
      phase: "Verify",
      schema: { type: "object", properties: { refuted: { type: "boolean" }, why: { type: "string" } }, required: ["refuted", "why"] },
    },
  ).then((v) => ({ ...f, refuted: v ? v.refuted : true, why: v ? v.why : "no verdict" }));

// Each reviewer's high and medium findings are verified as soon as that reviewer is done.
const reviewers = [...batches.map((b, i) => () => look(b, i)), () => tryIt(), () => rules()];
const reviewed = await pipeline(
  reviewers,
  (run) => run(),
  (r) => {
    const all = (r && r.findings) || [];
    return parallel(all.filter((f) => f.severity !== "low").map((f) => () => verify(f))).then((checked) => ({
      checked: checked.filter(Boolean),
      lows: all.filter((f) => f.severity === "low"),
    }));
  },
);
const done = reviewed.filter(Boolean);
const checked = done.flatMap((d) => d.checked);
return {
  problems: (shot && shot.problems) || [],
  confirmed: checked.filter((f) => !f.refuted),
  refuted: checked.filter((f) => f.refuted),
  low: done.flatMap((d) => d.lows),
};
