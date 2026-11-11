import { Effect } from "effect";
import type { ELK } from "elkjs/lib/elk-api.js";
import workerUrl from "elkjs/lib/elk-worker.min.js?url";
import { createElement, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { diagramText } from "../../../src/diagram.ts";
import { layout, svg, type Drawn, type Measure } from "../../../src/diagram-layout.ts";
import type { Kid } from "../../../src/html.ts";
import type { DiagramGraph } from "../../../src/types.ts";
import { LayoutFailed, runUi } from "../api.ts";

// An AI review's diagram (src/diagram.ts): laid out by ELK in a worker and drawn as SVG by src/diagram-layout.ts, the same
// geometry a rendered review has (src/render.ts), in the theme's tokens.

const FONT = 12.5;

export function Diagram({ graph, title = "", caption = "" }: { graph: DiagramGraph; title?: string; caption?: string }) {
  const [drawn, setDrawn] = useState<Drawn | "failed" | null>(null);
  const lines = useMemo(() => diagramText(graph), [graph]);
  const descId = useId();
  useEffect(() => {
    setDrawn(null);
    const stop = new AbortController();
    runUi(
      laidOut(graph).pipe(
        Effect.match({
          onFailure: (e) => {
            console.warn(`diagram drawn as text: ${e.message}`);
            setDrawn("failed");
          },
          onSuccess: setDrawn,
        }),
      ),
      { signal: stop.signal },
    );
    return () => {
      stop.abort();
    };
  }, [graph]);

  return (
    <figure className="dg">
      {(title || caption) && (
        <figcaption className="dg-head">
          {title && <span className="dg-title">{title}</span>}
          {caption && <span className="dg-caption">{caption}</span>}
        </figcaption>
      )}
      {drawn === "failed" ? (
        <ul className="dg-text">
          {lines.map((l, i) => (
            // oxlint-disable-next-line react/no-array-index-key -- a fixed list never reorders
            <li key={i}>{l}</li>
          ))}
        </ul>
      ) : drawn ? (
        react(svg(drawn, { label: title || "Diagram", desc: lines.join("\n"), descId, measure }))
      ) : null}
    </figure>
  );
}

// The drawing's markup as React elements; SVG's attribute names but these two are React's own.
const NAMES: Record<string, string> = { class: "className", "text-anchor": "textAnchor" };
// Children go in as arguments, not an array, so React asks no keys of a drawing that never reorders.
const flat = (ks: Kid[]): Kid[] => ks.flatMap((k) => (Array.isArray(k) ? flat(k) : [k]));
function react(k: Kid): ReactNode {
  if (k === null || k === undefined || k === false || typeof k === "string" || typeof k === "number") return k;
  if (Array.isArray(k)) return flat(k).map(react);
  if ("raw" in k) return null;
  const props = Object.fromEntries(Object.entries(k.attrs).map(([n, v]) => [NAMES[n] ?? n, v]));
  return createElement(k.tag, props, ...flat(k.kids).map(react));
}

// ---------------------------------------------------------------------------- measuring

let canvas: CanvasRenderingContext2D | null = null;
let family = "";

const measure: Measure = (text, size, weight) => {
  canvas ??= document.createElement("canvas").getContext("2d");
  family ||= getComputedStyle(document.documentElement).getPropertyValue("--sans").trim() || "system-ui, sans-serif";
  if (!canvas) return text.length * size * 0.55;
  canvas.font = `${weight} ${size}px ${family}`;
  return canvas.measureText(text).width;
};

// ---------------------------------------------------------------------------- layout

let elk: Promise<ELK> | null = null;
const loadElk = (): Promise<ELK> =>
  (elk ??= import("elkjs/lib/elk-api.js").then(({ default: Elk }) => new Elk({ workerUrl, algorithms: ["layered"] })));

function laidOut(graph: DiagramGraph): Effect.Effect<Drawn, LayoutFailed> {
  return Effect.gen(function* () {
    // Measured in the face it's drawn in, once that has loaded.
    yield* Effect.tryPromise({
      try: () => document.fonts.load(`500 ${FONT}px "Instrument Sans"`),
      catch: (cause) => new LayoutFailed({ cause }),
    }).pipe(Effect.ignore);
    return yield* Effect.tryPromise({
      try: () => layout(graph, async (root) => (await loadElk()).layout(root), measure),
      catch: (cause) => new LayoutFailed({ cause }),
    }).pipe(
      // The worker never answers if its script didn't load.
      Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(new LayoutFailed({})) }),
      Effect.tapError(() =>
        Effect.sync(() => {
          elk = null;
        }),
      ),
    );
  });
}
