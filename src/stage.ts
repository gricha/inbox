import type { Item, Stage } from "./types.ts";

// Only a collaborator's approval counts (the coordinator merges on it); anyone's change request holds the PR.
export function verdicts(it: Item, self: string): { approved_by: string[]; changes_by: string[] } {
  const me = self.toLowerCase();
  const latest = new Map<string, Item["reviews"][number]>();
  for (const r of it.reviews)
    if (
      !r.author_bot &&
      r.author.toLowerCase() !== me &&
      (r.state === "changes_requested" || r.state === "dismissed" || (r.state === "approved" && r.trusted))
    )
      latest.set(r.author.toLowerCase(), r);
  const by = (state: string) => [...latest.values()].filter((r) => r.state === state).map((r) => r.author);
  return { approved_by: by("approved"), changes_by: by("changes_requested") };
}

// Approved as the desk says it: a collaborator approved, nobody asks for changes, and GitHub wants no other approval.
export function approved(it: Item, self: string): boolean {
  const v = verdicts(it, self);
  return !v.changes_by.length && v.approved_by.length > 0 && it.review_decision !== "required";
}

// `self` is the person whose own review doesn't count: the PR's author, or you on yours.
export function stage(it: Item, self: string): Stage | undefined {
  if (it.kind !== "pr") return undefined;
  if (it.state !== "open") return it.state;
  if (it.draft) return "draft";
  if (verdicts(it, self).changes_by.length) return "changes requested";
  // GitHub says "required" while the branch still wants another approval or a code owner's.
  return approved(it, self) ? "approved" : "waiting for review";
}
