// A PR's checks as its review lists them: what's wrong first, and all of them in one line.

import type { Check, Checks } from "./types.ts";

const ORDER: Check["state"][] = ["failing", "cancelled", "running", "passing", "skipped"];

// null for a commit nothing ran on. A failing check the base branch doesn't require is counted, and said to be so when no
// failing one is required; only one that holds the merge back makes the line red.
export function checksView(checks: Check[]): Checks | null {
  if (!checks.length) return null;
  const list = checks.toSorted((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.name.localeCompare(b.name));
  const count = (state: Check["state"]) => list.filter((c) => c.state === state).length;
  const failing = list.some((c) => c.state === "failing" && !c.optional);
  const parts = [
    count("failing") ? `${count("failing")} failing${failing ? "" : " (not required)"}` : "",
    ...(["cancelled", "running"] as const).map((s) => (count(s) ? `${count(s)} ${s}` : "")),
  ].filter(Boolean);
  const all = `${list.length} ${list.length === 1 ? "check" : "checks"}`;
  return { line: parts.length ? `${parts.join(", ")} of ${all}` : `CI passing · ${all}`, failing, list };
}
