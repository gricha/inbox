// An AI review's diagram (src/diagram.ts) laid out and drawn as SVG markup (src/html.ts): one geometry for the window, which
// runs ELK in a Web Worker and measures with a canvas (web/src/components/Diagram.tsx), and for a rendered review, which
// runs ELK in Node and measures with Instrument Sans's widths (src/render.ts). Every string in the graph is the model's, so
// it only ever becomes SVG text; nothing from it is a style or a link.
import type { ElkNode } from "elkjs/lib/elk-api.js";
import { STATE_END, STATE_START } from "./diagram.ts";
import { el, type El, type Kid } from "./html.ts";
import { CHARS, W400, W500 } from "./metrics.ts";
import type { DiagramEdge, DiagramGraph, DiagramNode, DiagramParticipant } from "./types.ts";

const FONT = 12.5;
const SMALL = 11.5;
const PAD_X = 12;
const NODE_H = 30;
const MAX_H = 320;
const MAX_W = 720; // past this an LR flowchart is drawn top down, so its text isn't shrunk to fit the column
const MIN_SCALE = 0.85;

export type Measure = (text: string, size: number, weight: number) => number;
export type ElkLayout = (root: ElkNode) => Promise<ElkNode>;

interface Pt {
  x: number;
  y: number;
}
interface Box {
  x: number; // top left
  y: number;
  w: number;
  h: number;
}
export type Drawn =
  | {
      kind: "flow";
      w: number;
      h: number;
      groups: { id: string; label: string; box: Box }[];
      edges: { edge: DiagramEdge; paths: Pt[][]; labelAt: Pt | null }[];
      nodes: { node: DiagramNode; box: Box }[];
    }
  | {
      kind: "sequence";
      minX: number;
      w: number;
      h: number;
      heads: { part: DiagramParticipant; box: Box }[];
      lifeline: { top: number; bottom: number };
      rows: Row[];
    };
type Row =
  | { kind: "message"; key: string; from: number; to: number; y: number; text: string; reply: boolean }
  | { kind: "note"; key: string; box: Box; text: string };

// Instrument Sans as Chrome draws it, for Node, which has no canvas; a character it doesn't list is an average one.
const AT = new Map(Array.from(CHARS, (c, i) => [c, i]));
export const fontMeasure: Measure = (text, size, weight) => {
  const table = weight >= 500 ? W500 : W400;
  let w = 0;
  for (const c of text) {
    const i = AT.get(c);
    w += i === undefined ? (c.codePointAt(0)! > 0x2e80 ? 1000 : 600) : table[i]!;
  }
  return (w * size) / 1000;
};

// ---------------------------------------------------------------------------- layout

export function layout(graph: DiagramGraph, elk: ElkLayout, measure: Measure): Promise<Drawn> {
  return graph.kind === "sequence" ? Promise.resolve(sequence(graph, measure)) : fitted(graph, elk, measure);
}

async function fitted(graph: Extract<DiagramGraph, { kind: "flow" }>, elk: ElkLayout, measure: Measure): Promise<Drawn> {
  const drawn = await flow(graph, elk, measure, graph.direction);
  if (graph.direction !== "LR" || drawn.w <= MAX_W) return drawn;
  const down = await flow(graph, elk, measure, "TB");
  return down.w < drawn.w ? down : drawn;
}

function nodeSize(n: { shape: DiagramNode["shape"]; label: string }, measure: Measure): { w: number; h: number } {
  const w = measure(n.label, FONT, 500);
  return n.shape === "choice" ? { w: w + 44, h: 44 } : { w: Math.max(56, w + 2 * PAD_X), h: NODE_H };
}

const DIRECTION = { LR: "RIGHT", TB: "DOWN" } as const;

async function flow(
  graph: Extract<DiagramGraph, { kind: "flow" }>,
  elk: ElkLayout,
  measure: Measure,
  dir: keyof typeof DIRECTION,
): Promise<Drawn> {
  const kids = (group: string | null): ElkNode[] =>
    graph.nodes
      .filter((n) => n.group === group)
      .map((n) => {
        const { w, h } = nodeSize(n, measure);
        const layer = n.id === STATE_START ? "FIRST" : n.id === STATE_END ? "LAST" : null;
        const kid: ElkNode = { id: `n_${n.id}`, width: w, height: h };
        if (layer) kid.layoutOptions = { "elk.layered.layering.layerConstraint": layer };
        return kid;
      });
  const root: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": DIRECTION[dir],
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "40",
      "elk.spacing.nodeNode": "22",
      "elk.spacing.edgeLabel": "4",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.padding": "[top=8,left=8,bottom=8,right=8]",
      "elk.edgeLabels.inline": "true",
      "elk.json.shapeCoords": "ROOT",
      "elk.json.edgeCoords": "ROOT",
    },
    children: [
      ...kids(null),
      ...graph.groups.map((g) => ({
        id: `g_${g.id}`,
        layoutOptions: { "elk.padding": "[top=26,left=12,bottom=12,right=12]" },
        children: kids(g.id),
      })),
    ],
    edges: graph.edges.map((e, i) => ({
      id: `e${i}`,
      sources: [`n_${e.from}`],
      targets: [`n_${e.to}`],
      labels: e.label ? [{ text: e.label, width: measure(e.label, SMALL, 400) + 8, height: 16 }] : [],
    })),
  };
  const out = await elk(root);
  const boxes = new Map<string, Box>();
  const walk = (n: ElkNode) => {
    for (const c of n.children ?? []) {
      boxes.set(c.id, { x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 });
      walk(c);
    }
  };
  walk(out);
  const box = (id: string): Box => {
    const b = boxes.get(id);
    if (!b) throw new Error(`ELK placed no ${id}`);
    return b;
  };
  const laid = new Map((out.edges ?? []).map((e) => [e.id, e]));
  return {
    kind: "flow",
    w: Math.ceil(out.width ?? 0),
    h: Math.ceil(out.height ?? 0),
    groups: graph.groups.map((g) => ({ id: g.id, label: g.label, box: box(`g_${g.id}`) })),
    edges: graph.edges.map((edge, i) => {
      const e = laid.get(`e${i}`);
      const paths = (e?.sections ?? []).map((s) => [s.startPoint].concat(s.bendPoints ?? [], [s.endPoint]));
      const l = e?.labels?.[0];
      const labelAt = l ? { x: (l.x ?? 0) + (l.width ?? 0) / 2, y: (l.y ?? 0) + (l.height ?? 0) / 2 } : null;
      return { edge, paths, labelAt };
    }),
    nodes: graph.nodes.map((node) => ({ node, box: box(`n_${node.id}`) })),
  };
}

// No layout library: a column per participant, a row per message or note.
function sequence(graph: Extract<DiagramGraph, { kind: "sequence" }>, measure: Measure): Drawn {
  const index = new Map(graph.participants.map((p, i) => [p.id, i]));
  const col = (id: string) => index.get(id) ?? 0;
  const colW = Math.max(120, ...graph.participants.map((p) => measure(p.label, FONT, 500) + 2 * PAD_X + 16));
  const gaps = graph.messages
    .filter((m) => m.from !== m.to)
    .map((m) => measure(m.text, SMALL, 400) / Math.abs(col(m.to) - col(m.from)) + 24);
  const step = Math.max(colW, ...gaps);
  const x = (id: string) => 8 + step / 2 + col(id) * step;
  const rowH = 34;
  const top = 8 + NODE_H + 18;
  let minX = 0;
  let maxX = 16 + step * graph.participants.length;
  const rows: Row[] = [];
  const nextY = () => top + rows.length * rowH + 14;
  const notesAt = (i: number) => {
    for (const [k, n] of graph.notes.entries()) {
      if (n.at !== i) continue;
      const xs = n.over.map(x);
      const w = Math.max(Math.max(...xs) - Math.min(...xs) + 100, measure(n.text, SMALL, 400) + 16);
      const mid = (Math.max(...xs) + Math.min(...xs)) / 2;
      const y = nextY();
      rows.push({ kind: "note", key: `n${k}`, box: { x: mid - w / 2, y: y - 11, w, h: 22 }, text: n.text });
      minX = Math.min(minX, mid - w / 2 - 4);
      maxX = Math.max(maxX, mid + w / 2 + 4);
    }
  };
  for (const [i, m] of graph.messages.entries()) {
    notesAt(i);
    const y = nextY();
    rows.push({ kind: "message", key: `m${i}`, from: x(m.from), to: x(m.to), y, text: m.text, reply: m.reply });
    if (m.from === m.to) maxX = Math.max(maxX, x(m.from) + 28 + measure(m.text, SMALL, 400) + 4);
  }
  notesAt(graph.messages.length);
  const h = top + rows.length * rowH + 4;
  return {
    kind: "sequence",
    minX,
    w: Math.ceil(maxX - minX),
    h: Math.ceil(h),
    heads: graph.participants.map((part) => {
      const { w } = nodeSize({ shape: "box", label: part.label }, measure);
      return { part, box: { x: x(part.id) - w / 2, y: 8, w, h: NODE_H } };
    }),
    lifeline: { top: 8 + NODE_H, bottom: h - 4 },
    rows,
  };
}

// ---------------------------------------------------------------------------- drawing

// At most the column's width and MAX_H tall, never larger than drawn: the width attribute caps it, CSS scales it down. A tall
// one (a long sequence) grows past MAX_H rather than shrink its text below MIN_SCALE.
export function svg(drawn: Drawn, o: { label: string; desc: string; descId: string; measure: Measure }): El {
  const scale = Math.max(MIN_SCALE, Math.min(1, MAX_H / drawn.h));
  const minX = drawn.kind === "sequence" ? drawn.minX : 0;
  return el(
    "svg",
    {
      class: "dg-svg",
      viewBox: `${minX} 0 ${drawn.w} ${drawn.h}`,
      width: Math.ceil(drawn.w * scale),
      height: Math.ceil(drawn.h * scale),
      role: "img",
      "aria-label": o.label,
      "aria-describedby": o.descId,
    },
    el("desc", { id: o.descId }, o.desc),
    drawn.kind === "flow" ? flowSvg(drawn, o.measure) : sequenceSvg(drawn),
  );
}

function flowSvg(drawn: Extract<Drawn, { kind: "flow" }>, measure: Measure): Kid[] {
  return [
    drawn.groups.map((g) =>
      el(
        "g",
        { class: "dg-group" },
        el("rect", { x: g.box.x, y: g.box.y, width: g.box.w, height: g.box.h, rx: 8 }),
        el("text", { x: g.box.x + 8, y: g.box.y + 14 }, g.label),
      ),
    ),
    drawn.edges.map(({ edge, paths, labelAt }) =>
      el(
        "g",
        { class: `dg-edge dg-${edge.style}` },
        paths.map((ps) => el("path", { class: "dg-line", d: rounded(ps) })),
        edge.style !== "line" && paths.length > 0 && arrow(paths.at(-1) ?? []),
        labelAt && edge.label && edgeLabel(labelAt, edge.label, measure),
      ),
    ),
    drawn.nodes.map(({ node, box }) => nodeSvg(node.shape, node.mark, box, node.label)),
  ];
}

function sequenceSvg(drawn: Extract<Drawn, { kind: "sequence" }>): Kid[] {
  const mid = (b: Box) => b.x + b.w / 2;
  return [
    drawn.heads.map(({ box }) =>
      el("line", { class: "dg-life", x1: mid(box), x2: mid(box), y1: drawn.lifeline.top, y2: drawn.lifeline.bottom }),
    ),
    drawn.heads.map(({ part, box }) => nodeSvg(part.actor ? "term" : "box", null, box, part.label)),
    drawn.rows.map((r) => {
      if (r.kind === "note")
        return el(
          "g",
          { class: "dg-note" },
          el("rect", { x: r.box.x, y: r.box.y, width: r.box.w, height: r.box.h, rx: 4 }),
          el("text", { x: mid(r.box), y: r.box.y + r.box.h / 2 + 4, "text-anchor": "middle" }, r.text),
        );
      const cls = `dg-edge ${r.reply ? "dg-dotted" : "dg-arrow"}`;
      if (r.from === r.to) {
        const a = r.from;
        return el(
          "g",
          { class: cls },
          el("path", { class: "dg-line", d: `M${a},${r.y - 6}h22v14h-22` }),
          arrow([
            { x: a + 10, y: r.y + 8 },
            { x: a + 1, y: r.y + 8 },
          ]),
          el("text", { class: "dg-label", x: a + 28, y: r.y + 5 }, r.text),
        );
      }
      const end = r.to - Math.sign(r.to - r.from);
      return el(
        "g",
        { class: cls },
        el("path", { class: "dg-line", d: `M${r.from},${r.y + 6}L${end},${r.y + 6}` }),
        arrow([
          { x: r.from, y: r.y + 6 },
          { x: end, y: r.y + 6 },
        ]),
        el("text", { class: "dg-label", x: (r.from + r.to) / 2, y: r.y - 1, "text-anchor": "middle" }, r.text),
      );
    }),
  ];
}

function nodeSvg(shape: DiagramNode["shape"], mark: DiagramNode["mark"], box: Box, label: string): El {
  const { x, y, w, h } = box;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const ry = 4;
  let outline: Kid;
  if (shape === "store")
    outline = [
      el("path", { d: `M${x},${y + ry}a${w / 2},${ry} 0 0 1 ${w},0v${h - 2 * ry}a${w / 2},${ry} 0 0 1 -${w},0Z` }),
      el("path", { class: "dg-lid", d: `M${x},${y + ry}a${w / 2},${ry} 0 0 0 ${w},0` }),
    ];
  else if (shape === "choice") outline = el("path", { d: `M${cx},${y}L${x + w},${cy}L${cx},${y + h}L${x},${cy}Z` });
  else if (shape === "circle") outline = el("ellipse", { cx, cy, rx: w / 2, ry: h / 2 });
  else outline = el("rect", { x, y, width: w, height: h, rx: shape === "term" ? h / 2 : 6 });
  return el(
    "g",
    { class: `dg-node${mark ? ` dg-${mark}` : ""}` },
    outline,
    el("text", { x: cx, y: cy + 4.3, "text-anchor": "middle" }, label),
  );
}

function edgeLabel(at: Pt, text: string, measure: Measure): Kid {
  const w = measure(text, SMALL, 400) + 8;
  return [
    el("rect", { class: "dg-label-bg", x: at.x - w / 2, y: at.y - 8, width: w, height: 16, rx: 3 }),
    el("text", { class: "dg-label", x: at.x, y: at.y + 4, "text-anchor": "middle" }, text),
  ];
}

// Drawn, not a <marker>: a marker needs a document-wide id.
function arrow(ps: Pt[]): Kid {
  const a = ps.at(-2);
  const b = ps.at(-1);
  if (!a || !b) return null;
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const p = (dx: number, dy: number) => `${b.x + dx * Math.cos(ang) - dy * Math.sin(ang)},${b.y + dx * Math.sin(ang) + dy * Math.cos(ang)}`;
  return el("path", { class: "dg-tip", d: `M${p(0, 0)}L${p(-7, -3.5)}L${p(-7, 3.5)}Z` });
}

// An orthogonal polyline with soft corners.
function rounded(ps: Pt[], r = 8): string {
  const [first] = ps;
  const last = ps.at(-1);
  if (!first || !last) return "";
  let d = `M${first.x},${first.y}`;
  for (let i = 1; i < ps.length - 1; i++) {
    const a = ps[i - 1];
    const b = ps[i];
    const c = ps[i + 1];
    if (!a || !b || !c) continue;
    const l1 = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const l2 = Math.hypot(c.x - b.x, c.y - b.y) || 1;
    const k = Math.min(r, l1 / 2, l2 / 2);
    d += `L${b.x - ((b.x - a.x) / l1) * k},${b.y - ((b.y - a.y) / l1) * k}Q${b.x},${b.y} ${b.x + ((c.x - b.x) / l2) * k},${b.y + ((c.y - b.y) / l2) * k}`;
  }
  return `${d}L${last.x},${last.y}`;
}
