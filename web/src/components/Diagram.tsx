// Placeholder until the diagram renderer lands.
import type { DiagramGraph } from "../../../src/types.ts";
export function Diagram({ title }: { graph: DiagramGraph; title: string; caption: string }) {
  return <p className="quiet">{title}</p>;
}
