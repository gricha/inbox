import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import type { Drawn, Measure } from "../../../src/diagram-layout.ts";
import type { DiagramMark, DiagramShape } from "../../../src/types.ts";
import { seeded } from "../drawing.ts";

// A diagram drawn by Excalidraw: our layout (ELK, measured in Excalifont) as Excalidraw elements, exported as a hand-drawn
// SVG in the theme's own colours. Its font comes from the desk (public/excalidraw), never a CDN.
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
  }
}

const FONT_URL = "/excalidraw/fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2"; // its Latin range
const SCALE = 14 / 12.5; // Excalifont at 14 where the layout asks for Instrument Sans at 12.5
const EXCALIFONT = 5;
const MAX_H = 400; // past this it scales down, never below MIN_SCALE
const MIN_SCALE = 0.85;
export const SKETCH_SHRINK = MIN_SCALE; // a left-to-right flowchart keeps its direction while it fits at this

let font: Promise<void> | null = null;
export const loadSketchFont = (): Promise<void> =>
  (font ??= (async () => {
    const f = await new FontFace("Excalifont", `url(${FONT_URL})`).load();
    document.fonts.add(f);
  })());

let canvas: CanvasRenderingContext2D | null = null;
export const sketchMeasure: Measure = (text, size) => {
  canvas ??= document.createElement("canvas").getContext("2d");
  if (!canvas) return text.length * size * 0.7;
  canvas.font = `${size * SCALE}px Excalifont`;
  return canvas.measureText(text).width;
};

// ---------------------------------------------------------------------------- the theme's colours

// The tokens as the page resolves them where the diagram sits (a theme, the system's dark, Omarchy's colours).
type Ink = Record<
  "ink" | "pencil" | "faint" | "rule" | "wash" | "sheet" | "green" | "amber" | "amberWash" | "red" | "accent" | "accentWash",
  string
>;
const TOKENS: Record<keyof Ink, string> = {
  ink: "--ink",
  pencil: "--pencil",
  faint: "--faint",
  rule: "--rule-strong",
  wash: "--wash",
  sheet: "--sheet",
  green: "--green",
  amber: "--amber",
  amberWash: "--amber-wash",
  red: "--red",
  accent: "--accent",
  accentWash: "--accent-wash",
};
function inkAt(el: HTMLElement): Ink {
  const probe = document.createElement("span");
  el.append(probe);
  const read = (token: string) => {
    probe.style.color = `var(${token})`;
    return getComputedStyle(probe).color;
  };
  const out: Ink = {
    ink: read(TOKENS.ink),
    pencil: read(TOKENS.pencil),
    faint: read(TOKENS.faint),
    rule: read(TOKENS.rule),
    wash: read(TOKENS.wash),
    sheet: read(TOKENS.sheet),
    green: read(TOKENS.green),
    amber: read(TOKENS.amber),
    amberWash: read(TOKENS.amberWash),
    red: read(TOKENS.red),
    accent: read(TOKENS.accent),
    accentWash: read(TOKENS.accentWash),
  };
  probe.remove();
  return out;
}
// A colour at an alpha: rgb(r, g, b) → rgba(r, g, b, a).
const tint = (rgb: string, a: number) => rgb.replace(/^rgba?\(([^,]+),([^,]+),([^,)]+).*$/, `rgba($1,$2,$3, ${a})`);

const TYPE: Record<DiagramShape, "rectangle" | "ellipse" | "diamond"> = {
  box: "rectangle",
  term: "rectangle",
  store: "rectangle",
  choice: "diamond",
  circle: "ellipse",
};

// ---------------------------------------------------------------------------- elements

type Pt = { x: number; y: number };
type Skel = Record<string, unknown>;

function skeleton(d: Drawn, c: Ink): Skel[] {
  const look = (mark: DiagramMark | "plain" | "store"): { stroke: string; fill: string; text: string } =>
    ({
      plain: { stroke: c.pencil, fill: c.wash, text: c.ink },
      store: { stroke: c.accent, fill: c.accentWash, text: c.ink },
      new: { stroke: c.green, fill: tint(c.green, 0.14), text: c.ink },
      changed: { stroke: c.amber, fill: c.amberWash, text: c.ink },
      removed: { stroke: c.faint, fill: "transparent", text: c.pencil },
    })[mark];
  const text = (t: string, cx: number, cy: number, size: number, color = c.pencil): Skel => {
    const w = sketchMeasure(t, size, 400);
    const fontSize = size * SCALE;
    return { type: "text", text: t, x: cx - w / 2, y: cy - fontSize * 0.62, fontSize, fontFamily: EXCALIFONT, strokeColor: color };
  };
  const line = (pts: Pt[], o: { arrow?: boolean; dashed?: boolean; color?: string }): Skel => {
    const [a] = pts;
    const at = a ?? { x: 0, y: 0 };
    return {
      type: o.arrow === false ? "line" : "arrow",
      x: at.x,
      y: at.y,
      points: pts.map((p) => [p.x - at.x, p.y - at.y]),
      strokeColor: o.color ?? c.pencil,
      strokeWidth: 1,
      strokeStyle: o.dashed ? "dashed" : "solid",
      roundness: null,
      endArrowhead: o.arrow === false ? null : "arrow",
      startArrowhead: null,
    };
  };
  const box = (b: { x: number; y: number; w: number; h: number }, kind: DiagramShape, l: ReturnType<typeof look>, o: Skel) => ({
    type: TYPE[kind],
    x: b.x,
    y: b.y,
    width: b.w,
    height: b.h,
    strokeColor: l.stroke,
    backgroundColor: l.fill,
    fillStyle: "solid",
    strokeWidth: 1,
    roughness: 1,
    roundness: kind === "choice" || kind === "circle" ? null : { type: 3 },
    ...o,
  });

  if (d.kind === "flow")
    return [
      ...d.groups.flatMap((g): Skel[] => [
        {
          type: "rectangle",
          x: g.box.x,
          y: g.box.y,
          width: g.box.w,
          height: g.box.h,
          strokeColor: c.rule,
          backgroundColor: "transparent",
          strokeStyle: "dashed",
          strokeWidth: 1,
          roundness: { type: 3 },
        },
        { ...text(g.label, 0, 0, 11), x: g.box.x + 10, y: g.box.y + 5, strokeColor: c.faint },
      ]),
      ...d.edges.flatMap(({ edge, paths, labelAt }): Skel[] => [
        ...paths.map((p) => line(p, { arrow: edge.style !== "line", dashed: edge.style === "dotted" })),
        ...(labelAt && edge.label ? [text(edge.label, labelAt.x, labelAt.y, 11.5)] : []),
      ]),
      ...d.nodes.map(({ node, box: b }): Skel => {
        const l = look(node.mark ?? (node.shape === "store" ? "store" : "plain"));
        return box(b, node.shape, l, {
          strokeWidth: node.mark === "new" || node.mark === "changed" ? 1.5 : 1,
          strokeStyle: node.mark === "removed" ? "dashed" : "solid",
          label: { text: node.label, fontSize: 12.5 * SCALE, fontFamily: EXCALIFONT, strokeColor: l.text },
        });
      }),
    ];

  const mid = (b: { x: number; w: number }) => b.x + b.w / 2;
  return [
    ...d.heads.map(({ box: b }) =>
      line(
        [
          { x: mid(b), y: d.lifeline.top },
          { x: mid(b), y: d.lifeline.bottom },
        ],
        { arrow: false, dashed: true, color: c.rule },
      ),
    ),
    ...d.heads.map(({ part, box: b }) =>
      box(b, "box", look("plain"), { label: { text: part.label, fontSize: 12.5 * SCALE, fontFamily: EXCALIFONT, strokeColor: c.ink } }),
    ),
    ...d.rows.flatMap((r): Skel[] => {
      if (r.kind === "note")
        return [
          box(
            r.box,
            "box",
            { stroke: c.amber, fill: c.amberWash, text: c.ink },
            {
              label: { text: r.text, fontSize: 11.5 * SCALE, fontFamily: EXCALIFONT, strokeColor: c.ink },
            },
          ),
        ];
      if (r.from === r.to)
        return [
          line(
            [
              { x: r.from, y: r.y - 6 },
              { x: r.from + 22, y: r.y - 6 },
              { x: r.from + 22, y: r.y + 8 },
              { x: r.from + 1, y: r.y + 8 },
            ],
            { dashed: r.reply },
          ),
          { ...text(r.text, 0, r.y, 11.5, c.ink), x: r.from + 28 },
        ];
      const end = r.to - Math.sign(r.to - r.from);
      return [
        line(
          [
            { x: r.from, y: r.y + 6 },
            { x: end, y: r.y + 6 },
          ],
          { dashed: r.reply },
        ),
        text(r.text, (r.from + r.to) / 2, r.y - 10, 11.5, c.ink),
      ];
    }),
  ];
}

// ---------------------------------------------------------------------------- drawing

interface ExcalidrawApi {
  convertToExcalidrawElements: (elements: Skel[], opts: { regenerateIds: boolean }) => readonly object[];
  exportToSvg: (opts: { elements: readonly object[]; appState: Record<string, unknown>; files: null }) => Promise<SVGSVGElement>;
}
const loadExcalidraw = async (): Promise<ExcalidrawApi> => {
  window.EXCALIDRAW_ASSET_PATH ??= "/excalidraw/";
  const mod: unknown = await import("@excalidraw/excalidraw");
  if (!isApi(mod)) throw new Error("Excalidraw has no exportToSvg");
  return mod;
};
const isApi = (m: unknown): m is ExcalidrawApi =>
  typeof m === "object" && m !== null && "exportToSvg" in m && "convertToExcalidrawElements" in m;

// The theme's colours where the diagram sits, read again when the theme changes: a theme picked (data-theme), Omarchy's
// colours (style) or the system's dark mode.
function useInk(at: RefObject<HTMLElement | null>): Ink | null {
  const [ink, setInk] = useState<Ink | null>(null);
  useEffect(() => {
    const read = () => {
      if (at.current) setInk(inkAt(at.current));
    };
    read();
    const seen = new MutationObserver(read);
    seen.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    const dark = matchMedia("(prefers-color-scheme: dark)");
    dark.addEventListener("change", read);
    return () => {
      seen.disconnect();
      dark.removeEventListener("change", read);
    };
  }, [at]);
  return ink;
}

export function Sketch({ drawn, label, onFail }: { drawn: Drawn; label: string; onFail: (e: unknown) => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const ink = useInk(holder);
  const failed = useEffectEvent(onFail);
  useEffect(() => {
    let live = true;
    const draw = async () => {
      const at = holder.current;
      if (!at || !ink) return;
      const { convertToExcalidrawElements, exportToSvg } = await loadExcalidraw();
      const svg = await exportToSvg({
        elements: convertToExcalidrawElements(seeded(skeleton(drawn, ink)), { regenerateIds: false }),
        appState: { exportBackground: false, exportWithDarkMode: false, exportPadding: 4 },
        files: null,
      });
      if (!live) return;
      // Never drawn larger than laid out; a tall one scales down to MAX_H, but its text never below MIN_SCALE.
      const w = Number(svg.getAttribute("width")) || drawn.w;
      const h = Number(svg.getAttribute("height")) || drawn.h;
      const room = at.clientWidth > 0 ? at.clientWidth : w;
      svg.setAttribute("width", String(Math.ceil(w * Math.max(MIN_SCALE, Math.min(1, MAX_H / h, room / w)))));
      svg.removeAttribute("height");
      svg.classList.add("dg-sketch-svg");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", label);
      at.replaceChildren(svg);
      setReady(true);
    };
    draw().catch((e: unknown) => {
      if (live) failed(e);
    });
    return () => {
      live = false;
    };
  }, [drawn, label, ink]);
  return <div ref={holder} className="dg-sketch" aria-busy={!ready} />;
}
