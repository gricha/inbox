// A changed file from its patch text, for the mock's canned diffs (diffs.ts, reviews/).
import type { ReviewFile } from "../../src/types.ts";

// Blank lines below are unchanged blank lines, which a patch writes as a single space.
export const file = (path: string, status: ReviewFile["status"], text: string): ReviewFile => {
  const lines = text.split("\n").map((l) => l || " ");
  return {
    path,
    previous_path: null,
    status,
    additions: lines.filter((l) => l.startsWith("+")).length,
    deletions: lines.filter((l) => l.startsWith("-")).length,
    patch: lines.join("\n"),
  };
};
