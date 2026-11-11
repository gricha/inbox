// An AI review's diagram: a strict subset of Mermaid (docs/review-format.md → Diagrams) parsed into plain data, never run.
// It accepts only what the window draws, so every diagram it takes is valid Mermaid too; any other line fails the whole one.
import type {
  DiagramEdge,
  DiagramGraph,
  DiagramMark,
  DiagramMessage,
  DiagramNode,
  DiagramNote,
  DiagramParticipant,
  DiagramShape,
} from "./types.ts";

export type { DiagramGraph } from "./types.ts";

const MAX_SOURCE = 2048; // bytes
const MAX_NODES = 12;
const MAX_EDGES = 16;
const MAX_PARTICIPANTS = 6;
const MAX_ROWS = 14; // a sequence's messages and notes
const MAX_LABEL = 40;
const MAX_MESSAGE = 48;
const MIN_PARTS = 3;

const ID = /^[A-Za-z][A-Za-z0-9_]{0,23}$/;
const MARKS = new Set<string>(["new", "changed", "removed"]);
// Styling, links and config: dropped, never interpreted.
const DROPPED = /^(classDef|style|linkStyle|click)\s/;

// A state diagram's [*]: ids no source can name, since the ID pattern starts with a letter.
export const STATE_START = "_start";
export const STATE_END = "_end";

interface Bad {
  why: string;
}
const bad = (why: string): Bad => ({ why });
const isBad = (x: unknown): x is Bad => typeof x === "object" && x !== null && "why" in x;

interface Line {
  n: number;
  text: string;
}

export function parseDiagram(source: string): { ok: true; graph: DiagramGraph } | { ok: false; why: string } {
  if (new TextEncoder().encode(source).length > MAX_SOURCE) return { ok: false, why: `the source is over ${MAX_SOURCE} bytes` };
  const lines: Line[] = [];
  for (const [i, raw] of source.split(/\r?\n/).entries()) {
    const text = raw.trim().replace(/;$/, "").trimEnd();
    if (text && !text.startsWith("%%") && !DROPPED.test(text)) lines.push({ n: i + 1, text });
  }
  const [head, ...body] = lines;
  const header = head?.text.split(/\s+/) ?? [];
  let out: DiagramGraph | Bad;
  if ((header[0] === "flowchart" || header[0] === "graph") && header.length === 2) {
    const dir = header[1] === "TD" ? "TB" : header[1];
    out = dir === "LR" || dir === "TB" ? parseFlow(dir, body) : bad(`a flowchart goes LR or TB, not ${dir}`);
  } else if ((header[0] === "stateDiagram-v2" || header[0] === "stateDiagram") && header.length === 1) out = parseState(body);
  else if (header[0] === "sequenceDiagram" && header.length === 1) out = parseSequence(body);
  else out = bad("not a flowchart, stateDiagram-v2 or sequenceDiagram");
  return isBad(out) ? { ok: false, why: out.why } : { ok: true, graph: out };
}

// One plain line per edge or message ("fetchPr() → buildPrompt(): claims"): the fallback when layout fails, and the
// figure's accessible description.
export function diagramText(graph: DiagramGraph): string[] {
  if (graph.kind === "flow") {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const name = (id: string) => {
      const n = byId.get(id);
      if (!n) return id;
      return n.mark ? `${n.label} (${n.mark})` : n.label;
    };
    const lines = graph.edges.map((e) => `${name(e.from)} ${e.style === "line" ? "—" : "→"} ${name(e.to)}${e.label ? `: ${e.label}` : ""}`);
    const linked = new Set(graph.edges.flatMap((e) => [e.from, e.to]));
    for (const n of graph.nodes) if (!linked.has(n.id)) lines.push(name(n.id));
    return lines;
  }
  const label = new Map(graph.participants.map((p) => [p.id, p.label]));
  const name = (id: string) => label.get(id) ?? id;
  const lines: string[] = [];
  const notesAt = (i: number) => {
    for (const note of graph.notes) if (note.at === i) lines.push(`Note over ${note.over.map(name).join(", ")}: ${note.text}`);
  };
  graph.messages.forEach((m, i) => {
    notesAt(i);
    lines.push(`${name(m.from)} → ${name(m.to)}${m.text ? `: ${m.text}` : ""}`);
  });
  notesAt(graph.messages.length);
  return lines;
}

// ---------------------------------------------------------------------------- text

// A label as written, quoted or not: one line of plain words, no HTML, within its limit.
function words(raw: string, max: number, quoted: boolean): string | Bad {
  let s = raw.trim();
  // A message or note quoted as labels are (the prompt says to quote every label) reads without its quotes too.
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  if (quoted && s.includes('"')) return bad(`a stray quote in ${raw.trim()}`);
  s = s.replaceAll(/\s+/g, " ").trim();
  if (/<\/?[A-Za-z!]/.test(s)) return bad(`HTML in a label: ${s}`);
  if (s.length > max) return bad(`a label over ${max} characters: ${s}`);
  return s;
}

function labelText(raw: string, max = MAX_LABEL): string | Bad {
  const s = words(raw, max, true);
  return s === "" ? bad("an empty label") : s;
}

function ident(raw: string): string | Bad {
  if (!ID.test(raw)) return bad(`an id must be a letter then up to 23 letters, digits or _: ${raw}`);
  return raw === "end" ? bad("end can't be an id") : raw;
}

// ---------------------------------------------------------------------------- flowchart and state

interface Flow {
  nodes: Map<string, DiagramNode>;
  edges: DiagramEdge[];
  groups: { id: string; label: string }[];
  group: string | null; // the open subgraph
  classes: { ids: string[]; mark: DiagramMark | null; n: number }[];
}

const newFlow = (): Flow => ({ nodes: new Map(), edges: [], groups: [], group: null, classes: [] });

const mark = (name: string | undefined): DiagramMark | null => (name && MARKS.has(name) ? (name as DiagramMark) : null);

function node(f: Flow, rawId: string, shape?: DiagramShape, text?: string, cls?: string): string | Bad {
  const key = ident(rawId);
  if (isBad(key)) return key;
  if (f.groups.some((g) => g.id === key)) return bad(`${key} names both a subgraph and a node`);
  let n = f.nodes.get(key);
  if (!n) {
    n = { id: key, label: key, shape: "box", mark: null, group: null };
    f.nodes.set(key, n);
  }
  if (text !== undefined) {
    const l = labelText(text);
    if (isBad(l)) return l;
    n.label = l;
  }
  if (shape) n.shape = shape;
  n.mark = mark(cls) ?? n.mark;
  if (f.group) n.group = f.group;
  return key;
}

const SHAPES: Record<string, [string, DiagramShape]> = {
  "[": ["]", "box"],
  "([": ["])", "term"],
  "[(": [")]", "store"],
  "{": ["}", "choice"],
  "((": ["))", "circle"],
};
// id, then optionally a shape around a label (quoted, or plain words with no brackets or quotes), then optionally :::mark.
const NODE =
  /([A-Za-z][A-Za-z0-9_]*)(?:(\[\(|\(\[|\(\(|\[|\{)\s*("[^"]*"|[^"[\](){}|]*?)\s*(\)\]|\]\)|\)\)|\]|\}))?(?::::([A-Za-z][\w-]*))?/y;
// -->, ---, -.->, or a label inside the link (-- label -->, -. label .->), then optionally |label|.
const LINK = /\s*(?:(-->|---|-\.->)|--\s+("[^"]*"|[^\s"|-][^"|]*?)\s+-->|-\.\s+("[^"]*"|[^\s"|.][^"|]*?)\s+\.->)\s*(?:\|([^|]*)\|)?\s*/y;

// A node, or a chain of them: a --> b -.->|label| c.
function chain(f: Flow, line: string): Bad | undefined {
  let pos = 0;
  let from: string | null = null;
  let link: Omit<DiagramEdge, "from" | "to"> | null = null;
  for (;;) {
    NODE.lastIndex = pos;
    const m = NODE.exec(line);
    if (!m) return bad(`can't read: ${line}`);
    const [, rawId = "", open, inner, close, cls] = m;
    let shape: [string, DiagramShape] | undefined;
    if (open !== undefined) {
      shape = SHAPES[open];
      if (!shape || shape[0] !== close) return bad(`a shape that doesn't close as it opens: ${m[0]}`);
    }
    const to = node(f, rawId, shape?.[1], shape ? inner : undefined, cls);
    if (isBad(to)) return to;
    if (from !== null && link) f.edges.push({ from, to, ...link });
    from = to;
    pos = NODE.lastIndex;
    if (pos === line.length) return undefined;
    LINK.lastIndex = pos;
    const l = LINK.exec(line);
    if (!l) return bad(`can't read: ${line}`);
    const [, op, solid, dotted, piped] = l;
    if ((solid ?? dotted) !== undefined && piped !== undefined) return bad(`a link with two labels: ${line}`);
    const text = solid ?? dotted ?? piped;
    const edgeLabel = text === undefined ? "" : labelText(text);
    if (isBad(edgeLabel)) return edgeLabel;
    link = { label: edgeLabel, style: op === "---" ? "line" : op === "-.->" || dotted !== undefined ? "dotted" : "arrow" };
    pos = LINK.lastIndex;
  }
}

const SUBGRAPH = /^subgraph\s+([A-Za-z][A-Za-z0-9_]*)(?:\s*\[\s*("[^"]*"|[^"[\]]*?)\s*\])?$/;
const CLASS = /^class\s+([A-Za-z]\w*(?:\s*,\s*[A-Za-z]\w*)*)\s+([A-Za-z][\w-]*)$/;

// class a,b new, and :::mark on a state.
function classLine(f: Flow, line: Line): boolean {
  const m = CLASS.exec(line.text);
  if (!m) return false;
  f.classes.push({ ids: (m[1] ?? "").split(",").map((s) => s.trim()), mark: mark(m[2]), n: line.n });
  return true;
}

function finishFlow(f: Flow, direction: "LR" | "TB"): DiagramGraph | Bad {
  if (f.group) return bad(`subgraph ${f.group} has no end`);
  for (const c of f.classes)
    for (const key of c.ids) {
      const n = f.nodes.get(key);
      if (!n) return bad(`line ${c.n}: class names ${key}, which isn't a node`);
      n.mark = c.mark ?? n.mark;
    }
  const nodes = [...f.nodes.values()];
  if (nodes.length < MIN_PARTS) return bad(`${nodes.length} nodes: a diagram needs at least ${MIN_PARTS}`);
  if (nodes.length > MAX_NODES) return bad(`${nodes.length} nodes: at most ${MAX_NODES}`);
  if (f.edges.length > MAX_EDGES) return bad(`${f.edges.length} edges: at most ${MAX_EDGES}`);
  const used = new Set(nodes.map((n) => n.group));
  return { kind: "flow", direction, nodes, edges: f.edges, groups: f.groups.filter((g) => used.has(g.id)) };
}

function parseFlow(direction: "LR" | "TB", lines: Line[]): DiagramGraph | Bad {
  const f = newFlow();
  for (const line of lines) {
    const at = (b: Bad) => bad(`line ${line.n}: ${b.why}`);
    const sub = SUBGRAPH.exec(line.text);
    if (sub) {
      if (f.group) return at(bad("a subgraph inside a subgraph"));
      const key = ident(sub[1] ?? "");
      if (isBad(key)) return at(key);
      if (f.nodes.has(key) || f.groups.some((g) => g.id === key)) return at(bad(`${key} is already taken`));
      const l = sub[2] === undefined ? key : labelText(sub[2]);
      if (isBad(l)) return at(l);
      f.groups.push({ id: key, label: l });
      f.group = key;
      continue;
    }
    if (line.text === "end") {
      if (!f.group) return at(bad("an end with no subgraph open"));
      f.group = null;
      continue;
    }
    if (classLine(f, line)) continue;
    const b = chain(f, line.text);
    if (b) return at(b);
  }
  return finishFlow(f, direction);
}

const STATE_AS = /^state\s+("[^"]*")\s+as\s+([A-Za-z]\w*)$/;
const STATE_REF = String.raw`(\[\*\]|[A-Za-z]\w*)(?::::([A-Za-z][\w-]*))?`;
const TRANSITION = new RegExp(String.raw`^${STATE_REF}\s*-->\s*${STATE_REF}\s*(?::(.*))?$`);

// A state diagram, drawn as a flowchart top to bottom: states are boxes, [*] a start or end circle, events edge labels.
function parseState(lines: Line[]): DiagramGraph | Bad {
  const f = newFlow();
  for (const line of lines) {
    const at = (b: Bad) => bad(`line ${line.n}: ${b.why}`);
    const as = STATE_AS.exec(line.text);
    if (as) {
      const key = node(f, as[2] ?? "", undefined, as[1]);
      if (isBad(key)) return at(key);
      continue;
    }
    if (classLine(f, line)) continue;
    const t = TRANSITION.exec(line.text);
    if (!t) return at(bad(`can't read: ${line.text}`));
    const [, a = "", aCls, b = "", bCls, event] = t;
    const end = (ref: string, cls: string | undefined, terminal: string, name: string) => {
      if (ref !== "[*]") return node(f, ref, undefined, undefined, cls);
      if (!f.nodes.has(terminal)) f.nodes.set(terminal, { id: terminal, label: name, shape: "circle", mark: null, group: null });
      return terminal;
    };
    const from = end(a, aCls, STATE_START, "start");
    if (isBad(from)) return at(from);
    const to = end(b, bCls, STATE_END, "end");
    if (isBad(to)) return at(to);
    const l = event === undefined ? "" : labelText(event);
    if (isBad(l)) return at(l);
    f.edges.push({ from, to, label: l, style: "arrow" });
  }
  return finishFlow(f, "TB");
}

// ---------------------------------------------------------------------------- sequence

const PARTICIPANT = /^(participant|actor)\s+([A-Za-z]\w*)(?:\s+as\s+(.+))?$/;
const MESSAGE = /^([A-Za-z]\w*)\s*(-->>|->>)\s*([A-Za-z]\w*)\s*:(.*)$/;
const NOTE = /^note\s+over\s+([A-Za-z]\w*)(?:\s*,\s*([A-Za-z]\w*))?\s*:(.*)$/i;

function parseSequence(lines: Line[]): DiagramGraph | Bad {
  const participants: DiagramParticipant[] = [];
  const messages: DiagramMessage[] = [];
  const notes: DiagramNote[] = [];
  const part = (raw: string): string | Bad => {
    const key = ident(raw);
    if (isBad(key)) return key;
    if (!participants.some((p) => p.id === key)) participants.push({ id: key, label: key, actor: false });
    return key;
  };
  for (const line of lines) {
    const at = (b: Bad) => bad(`line ${line.n}: ${b.why}`);
    const p = PARTICIPANT.exec(line.text);
    if (p) {
      const key = part(p[2] ?? "");
      if (isBad(key)) return at(key);
      const l = p[3] === undefined ? key : labelText(p[3]);
      if (isBad(l)) return at(l);
      for (const it of participants) if (it.id === key) Object.assign(it, { label: l, actor: p[1] === "actor" });
      continue;
    }
    const m = MESSAGE.exec(line.text);
    if (m) {
      const from = part(m[1] ?? "");
      if (isBad(from)) return at(from);
      const to = part(m[3] ?? "");
      if (isBad(to)) return at(to);
      const text = words(m[4] ?? "", MAX_MESSAGE, false);
      if (isBad(text)) return at(text);
      messages.push({ from, to, text, reply: m[2] === "-->>" });
      continue;
    }
    const n = NOTE.exec(line.text);
    if (n) {
      const over: string[] = [];
      for (const raw of [n[1], n[2]]) {
        if (raw === undefined) continue;
        const key = part(raw);
        if (isBad(key)) return at(key);
        over.push(key);
      }
      const text = words(n[3] ?? "", MAX_MESSAGE, false);
      if (isBad(text)) return at(text);
      if (!text) return at(bad("an empty note"));
      notes.push({ over, text, at: messages.length });
      continue;
    }
    return at(bad(`can't read: ${line.text}`));
  }
  if (participants.length < MIN_PARTS) return bad(`${participants.length} participants: a diagram needs at least ${MIN_PARTS}`);
  if (participants.length > MAX_PARTICIPANTS) return bad(`${participants.length} participants: at most ${MAX_PARTICIPANTS}`);
  const rows = messages.length + notes.length;
  if (rows > MAX_ROWS) return bad(`${rows} messages and notes: at most ${MAX_ROWS}`);
  return { kind: "sequence", participants, messages, notes };
}
