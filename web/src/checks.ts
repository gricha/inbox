// A PR's checks: each one's dot, and runs of one check grouped.
import type { Check } from "../../src/types.ts";

// A check's colour in the review's sidebar: red failing, amber failing but not required, yellow running, green passing, grey skipped.
export type Dot = "red" | "amber" | "yellow" | "green" | "grey";

const DOTS: Dot[] = ["red", "amber", "yellow", "green", "grey"];

export const checkDot = (c: Check): Dot =>
  c.state === "failing" || c.state === "cancelled"
    ? c.optional
      ? "amber"
      : "red"
    : c.state === "running"
      ? "yellow"
      : c.state === "passing"
        ? "green"
        : "grey";

export interface CheckGroup {
  name: string;
  dot: Dot; // its worst check's, skipped ones aside
  checks: Check[];
}

// A shard's mark at a name's end: "(1/3)", "[2]", "#4", " 3", "shard 2 of 5".
const SHARD = /\s*(?:\([^()]*\)|\[[^\]]*\]|#?\d+(?:\s*(?:\/|of)\s*\d+)?|shard\s*\d+(?:\s*(?:\/|of)\s*\d+)?)$/i;

// Checks that share a name but for a shard's mark are one row, worst first; one alone keeps its whole name.
export function checkGroups(list: Check[]): CheckGroup[] {
  const by = new Map<string, Check[]>();
  for (const c of list) {
    const key = c.name.replace(SHARD, "").trim() || c.name;
    by.set(key, [...(by.get(key) ?? []), c]);
  }
  const groups = [...by].map(([name, checks]) => {
    const dots = new Set(checks.map(checkDot));
    const dot = DOTS.find((d) => d !== "grey" && dots.has(d)) ?? "grey";
    return { name: checks.length === 1 ? checks[0]!.name : name, dot, checks };
  });
  return groups.toSorted((a, b) => DOTS.indexOf(a.dot) - DOTS.indexOf(b.dot));
}
