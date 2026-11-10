// An AI review's diagram: the strict Mermaid subset, its limits, and that nothing outside it gets through.
import { test } from "node:test";
import assert from "node:assert/strict";
import { diagramText, parseDiagram, type DiagramGraph } from "../src/diagram.ts";

const parse = (src: string): DiagramGraph => {
  const r = parseDiagram(src);
  assert.ok(r.ok, r.ok ? "" : r.why);
  return r.graph;
};
const why = (src: string): string => {
  const r = parseDiagram(src);
  assert.ok(!r.ok, `parsed: ${src}`);
  return r.why;
};
const flow = (src: string) => {
  const g = parse(src);
  assert.equal(g.kind, "flow");
  return g;
};
const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `n${i + from}`);

test("a flowchart: the five shapes, quoted and plain labels, marks, and its direction", () => {
  const g = flow(`flowchart LR
  fetch["fetchPr()"] --> prompt(["buildPrompt()"])
  prompt --> store[("reviews")]
  store --> pick{"keep it?"}
  pick --> done((done)):::new
  plain[Plain words] --> fetch`);
  assert.equal(g.direction, "LR");
  assert.deepEqual(
    g.nodes.map((n) => [n.id, n.label, n.shape, n.mark]),
    [
      ["fetch", "fetchPr()", "box", null],
      ["prompt", "buildPrompt()", "term", null],
      ["store", "reviews", "store", null],
      ["pick", "keep it?", "choice", null],
      ["done", "done", "circle", "new"],
      ["plain", "Plain words", "box", null],
    ],
  );
  assert.equal(flow("graph TD\n a --> b --> c").direction, "TB", "graph and TD are Mermaid's spellings of the same");
  assert.equal(flow("flowchart TB\n a --> b --> c").direction, "TB");
  assert.match(why("flowchart RL\n a --> b --> c"), /LR or TB/);
});

test("edges: the three links, both ways to label one, and chains", () => {
  const g = flow(`flowchart LR
  a --> b
  b --- c
  c -.-> d
  a -->|claims| c
  b -- "unbacked" --> d
  d -. later .-> a
  a --> e -.->|maybe| f --- g`);
  assert.deepEqual(
    g.edges.map((e) => [e.from, e.to, e.label, e.style]),
    [
      ["a", "b", "", "arrow"],
      ["b", "c", "", "line"],
      ["c", "d", "", "dotted"],
      ["a", "c", "claims", "arrow"],
      ["b", "d", "unbacked", "arrow"],
      ["d", "a", "later", "dotted"],
      ["a", "e", "", "arrow"],
      ["e", "f", "maybe", "dotted"],
      ["f", "g", "", "line"],
    ],
  );
  assert.deepEqual(flow('flowchart LR\n a["x --> y"] --> b --> c').nodes[0]?.label, "x --> y", "a link inside a quoted label is text");
  for (const link of ["==>", "-.-", "--->", "--o", "<-->", "-- a --> b"])
    assert.match(why(`flowchart LR\n a ${link} b\n b --> c`), /line 2: can't read/, link);
  assert.match(why("flowchart LR\n a & b --> c"), /can't read/);
  assert.match(why("flowchart LR\n a --> b -->\n c"), /can't read/);
});

test("subgraphs: one level, labelled or not, and a node goes where it's mentioned", () => {
  const g = flow(`flowchart LR
  subgraph client ["The window"]
    ui["Review page"] --> api
  end
  subgraph server
    api["/api/review"] --> desk
  end
  desk --> db[("desk.db")]
  subgraph empty
  end`);
  assert.deepEqual(g.groups, [
    { id: "client", label: "The window" },
    { id: "server", label: "server" },
  ]);
  assert.deepEqual(
    g.nodes.map((n) => [n.id, n.group]),
    [
      ["ui", "client"],
      ["api", "server"],
      ["desk", "server"],
      ["db", null],
    ],
  );
  assert.match(why("flowchart LR\n subgraph a\n subgraph b\n x --> y --> z\n end\n end"), /line 3: a subgraph inside a subgraph/);
  assert.match(why("flowchart LR\n subgraph a\n x --> y --> z"), /subgraph a has no end/);
  assert.match(why("flowchart LR\n x --> y --> z\n end"), /an end with no subgraph/);
  assert.match(why("flowchart LR\n x --> y --> z\n subgraph x\n end"), /x is already taken/);
});

test("marks: :::name on a node and class a,b name; other class names mean nothing", () => {
  const g = flow(`flowchart LR
  a --> b:::removed --> c --> d:::other
  class a,c new
  class b , d changed
  class a highlight`);
  assert.deepEqual(
    g.nodes.map((n) => [n.id, n.mark]),
    [
      ["a", "new"],
      ["b", "changed"],
      ["c", "new"],
      ["d", "changed"],
    ],
  );
  assert.match(why("flowchart LR\n a --> b --> c\n class zz new"), /line 3: class names zz, which isn't a node/);
});

test("a state diagram is a flowchart top to bottom, with circles for start and end", () => {
  const g = flow(`stateDiagram-v2
  state "Waiting for review" as Waiting
  [*] --> Waiting
  Waiting --> Approved : approve
  Waiting --> Changes:::new : request changes
  Changes --> Waiting : push
  Approved --> [*]
  class Approved changed`);
  assert.equal(g.direction, "TB");
  assert.deepEqual(
    g.nodes.map((n) => [n.id, n.label, n.shape, n.mark]),
    [
      ["Waiting", "Waiting for review", "box", null],
      ["_start", "start", "circle", null],
      ["Approved", "Approved", "box", "changed"],
      ["Changes", "Changes", "box", "new"],
      ["_end", "end", "circle", null],
    ],
  );
  assert.deepEqual(
    g.edges.map((e) => [e.from, e.to, e.label]),
    [
      ["_start", "Waiting", ""],
      ["Waiting", "Approved", "approve"],
      ["Waiting", "Changes", "request changes"],
      ["Changes", "Waiting", "push"],
      ["Approved", "_end", ""],
    ],
  );
  assert.equal(parse("stateDiagram\n [*] --> A\n A --> [*]").kind, "flow");
  assert.match(why("stateDiagram-v2\n [*] --> A\n A --> B\n state A {\n }"), /line 4: can't read/);
  assert.match(why("stateDiagram-v2\n [*] --> A\n A : a description\n A --> [*]"), /line 3: can't read/);
});

test("a sequence: participants and actors, calls, replies, and notes over one or two", () => {
  const g = parse(`sequenceDiagram
  participant D as Desk
  actor O as "The owner"
  participant W as Writer agent
  O->>D: open the review
  Note over D: reads the diff
  D->>W: prompt with the fenced diff
  W-->>D: review JSON
  Note over D,W: checked against the hunks
  D->>C: check claims
  D->>D: keep()`);
  assert.equal(g.kind, "sequence");
  if (g.kind !== "sequence") return;
  assert.deepEqual(g.participants, [
    { id: "D", label: "Desk", actor: false },
    { id: "O", label: "The owner", actor: true },
    { id: "W", label: "Writer agent", actor: false },
    { id: "C", label: "C", actor: false },
  ]);
  assert.deepEqual(
    g.messages.map((m) => [m.from, m.to, m.text, m.reply]),
    [
      ["O", "D", "open the review", false],
      ["D", "W", "prompt with the fenced diff", false],
      ["W", "D", "review JSON", true],
      ["D", "C", "check claims", false],
      ["D", "D", "keep()", false],
    ],
  );
  assert.deepEqual(g.notes, [
    { over: ["D"], text: "reads the diff", at: 1 },
    { over: ["D", "W"], text: "checked against the hunks", at: 3 },
  ]);
  for (const line of [
    "A->>+B: go",
    "A-xB: lost",
    "A->B: open arrow",
    "loop every minute",
    "alt ok",
    "Note left of A: x",
    "autonumber",
    "activate A",
  ])
    assert.match(why(`sequenceDiagram\n A->>B: hi\n B->>C: hi\n ${line}`), /line 4: can't read/, line);
});

test("the limits: node, edge, participant and row counts, label lengths, ids, the source's size, and at least three parts", () => {
  const nodes = (n: number) => `flowchart LR\n${ids(n).join("\n")}`;
  assert.equal(flow(nodes(12)).nodes.length, 12);
  assert.match(why(nodes(13)), /13 nodes: at most 12/);
  assert.match(why(nodes(2)), /2 nodes: a diagram needs at least 3/);

  const edges = (n: number) => `flowchart LR\n${Array.from({ length: n }, (_, i) => `n${i % 4} --> n${(i + 1) % 4}`).join("\n")}`;
  assert.equal(flow(edges(16)).edges.length, 16);
  assert.match(why(edges(17)), /17 edges: at most 16/);

  const parts = (n: number) =>
    `sequenceDiagram\n${ids(n)
      .map((p) => `participant ${p}`)
      .join("\n")}`;
  assert.equal(parse(parts(6)).kind, "sequence");
  assert.match(why(parts(7)), /7 participants: at most 6/);
  assert.match(why(parts(2)), /2 participants: a diagram needs at least 3/);
  const rows = (n: number) => `${parts(3)}\n${Array.from({ length: n }, (_, i) => (i % 2 ? "Note over n0: x" : "n0->>n1: x")).join("\n")}`;
  assert.equal(parse(rows(14)).kind, "sequence");
  assert.match(why(rows(15)), /15 messages and notes: at most 14/);

  assert.equal(flow(`flowchart LR\n a["${"x".repeat(40)}"] --> b --> c`).nodes[0]?.label.length, 40);
  assert.match(why(`flowchart LR\n a["${"x".repeat(41)}"] --> b --> c`), /line 2: a label over 40 characters/);
  assert.match(why(`flowchart LR\n a -->|${"x".repeat(41)}| b --> c`), /a label over 40 characters/);
  assert.match(why(`sequenceDiagram\n a->>b: ${"x".repeat(49)}\n b->>c: hi`), /a label over 48 characters/);
  assert.equal(parse(`sequenceDiagram\n a->>b: ${"x".repeat(48)}\n b->>c: hi`).kind, "sequence");
  assert.match(why('flowchart LR\n a[""] --> b --> c'), /an empty label/);

  assert.equal(flow(`flowchart LR\n ${"a".repeat(24)} --> b --> c`).nodes.length, 3);
  assert.match(why(`flowchart LR\n ${"a".repeat(25)} --> b --> c`), /an id must be/);
  assert.match(why("flowchart LR\n a_1 --> _b --> c"), /can't read/);
  assert.match(why("flowchart LR\n a --> end --> c"), /end can't be an id/);
  assert.match(why("sequenceDiagram\n participant x-y\n a->>b: hi\n b->>c: hi"), /can't read/);

  const big = `flowchart LR\n a --> b --> c\n%% ${"x".repeat(2048)}`;
  assert.match(why(big), /over 2048 bytes/);
  assert.match(
    why(`flowchart LR\n a["${"é".repeat(20)}"] --> b --> c\n%% ${"é".repeat(1000)}`),
    /over 2048 bytes/,
    "bytes, not characters",
  );
});

test("styling, links and config are dropped, never interpreted", () => {
  const g = flow(`%%{init: {"theme": "dark", "securityLevel": "loose"}}%%
flowchart LR
  %% a comment
  a["One"] --> b["Two"] --> c["Three"];
  classDef new fill:#f00,stroke:url(javascript:alert(1))
  style a fill:#f00,color:expression(alert(1))
  linkStyle 0 stroke:#f00
  click a "javascript:alert(document.cookie)" "tip"
  click b callback`);
  assert.deepEqual(
    g.nodes.map((n) => [n.id, n.label, n.mark]),
    [
      ["a", "One", null],
      ["b", "Two", null],
      ["c", "Three", null],
    ],
  );
  assert.equal(g.edges.length, 2);
  assert.doesNotMatch(JSON.stringify(g), /javascript|alert|fill|init|cookie/);
});

test("any line outside the subset fails the whole diagram, an injection attempt included", () => {
  assert.match(why("pie\n title x"), /not a flowchart, stateDiagram-v2 or sequenceDiagram/);
  assert.match(why(""), /not a flowchart/);
  assert.match(why("---\nconfig:\n  theme: dark\n---\nflowchart LR\n a --> b --> c"), /not a flowchart/);
  assert.match(why('flowchart LR\n a --> b --> c\n A["<img src=x onerror=alert(1)>"]'), /line 3: HTML in a label/);
  assert.match(why('flowchart LR\n a["<b>bold</b>"] --> b --> c'), /HTML in a label/);
  assert.match(why("flowchart LR\n a -->|<br/>| b --> c"), /HTML in a label/);
  assert.match(why("sequenceDiagram\n a->>b: <script>alert(1)</script>\n b->>c: hi"), /HTML in a label/);
  assert.match(why('flowchart LR\n a["say "hi""] --> b --> c'), /can't read|stray quote/);
  assert.match(why("flowchart LR\n a --> b --> c\n a(round) --> b"), /line 3: can't read/);
  assert.match(why("flowchart LR\n a --> b --> c\n direction TB"), /line 3: can't read/);
  assert.match(why("flowchart LR\n a --> b --> c\n a@{ shape: rect }"), /line 3: can't read/);
  assert.match(why('flowchart LR\n a --> b --> c\n click"a" "javascript:alert(1)"'), /line 3: can't read/);
  assert.match(why("sequenceDiagram\n a->>b: hi\n b->>c: hi\n rect rgb(1,2,3)"), /line 4: can't read/);
  assert.match(why("flowchart LR\n a[(oops] --> b --> c"), /doesn't close as it opens|can't read/);
  assert.equal(flow('flowchart LR\n a["x > 0 && y < 1"] --> b --> c').nodes[0]?.label, "x > 0 && y < 1", "a comparison isn't HTML");
});

test("the text: one line per edge or message, marks named, unlinked nodes and notes kept", () => {
  assert.deepEqual(
    diagramText(
      parse(`flowchart LR
  fetch["fetchPr()"] --> prompt["buildPrompt()"]
  prompt -->|claims| check["checkClaims()"]:::new
  check --- old["oldCheck()"]:::removed
  lone["Review page"]`),
    ),
    [
      "fetchPr() → buildPrompt()",
      "buildPrompt() → checkClaims() (new): claims",
      "checkClaims() (new) — oldCheck() (removed)",
      "Review page",
    ],
  );
  assert.deepEqual(
    diagramText(
      parse(`sequenceDiagram
  participant D as Desk
  participant W as Writer
  Note over D: first
  D->>W: prompt
  W-->>D: review
  D->>C:
  Note over D,W: last`),
    ),
    ["Note over Desk: first", "Desk → Writer: prompt", "Writer → Desk: review", "Desk → C", "Note over Desk, Writer: last"],
  );
});

test("a sequence's message or note in quotes reads without them; a quote inside one stays", () => {
  const r = parseDiagram(
    ["sequenceDiagram", '  A->>B: "commit the queue"', '  B-->>C: "ok"', '  Note over C: "the "fill" job"', '  C->>A: say "hi"'].join("\n"),
  );
  assert.ok(r.ok);
  assert.ok(r.graph.kind === "sequence");
  assert.deepEqual(
    [...r.graph.messages.map((m) => m.text), ...r.graph.notes.map((n) => n.text)],
    ["commit the queue", "ok", 'say "hi"', 'the "fill" job'],
  );
});
