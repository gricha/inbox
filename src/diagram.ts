// Placeholder until the diagram grammar lands.
import type { DiagramGraph } from "./types.ts";
export function parseDiagram(_source: string): { ok: true; graph: DiagramGraph } | { ok: false; why: string } {
  return { ok: false, why: "diagrams aren't parsed yet" };
}
