// Whether the world has already dealt with an item. Derived from each snapshot, never stored, so it undoes itself.
import type { Settings } from "./settings.ts";
import type { Item, Signals } from "./types.ts";

export interface Resolution {
  reason: string; // "merged", "closed", "you approved", "approved by alice", "no longer requested"
  actor: string; // who resolved it, "" if unknown
  at: string | null; // when, if known
}

type ResolveSettings = Pick<Settings, "github.resolve_on_others_approval" | "github.bots">;

const lc = (s: string) => s.toLowerCase();

export function resolution(item: Item, s: Signals, settings: ResolveSettings, teams: string[]): Resolution | null {
  if (item.state === "merged") return { reason: "merged", actor: item.merged_by ?? "", at: item.closed_at ?? null };
  if (item.state === "closed") return { reason: "closed", actor: "", at: item.closed_at ?? null };
  // Your own PRs, and issues, only resolve by closing.
  if (item.kind !== "pr" || s.me.author) return null;

  const me = lc(s.me.login);
  const myTeams = new Set(teams.map(lc));
  const asks = item.request_events.filter((e) => (e.reviewer_type === "user" ? lc(e.reviewer) === me : myTeams.has(lc(e.reviewer))));
  const lastAsk = asks.at(-1) ?? null;
  if (!s.me.requested && !lastAsk) return null; // nobody asked you, so there's nothing to resolve

  // Your latest verdict approves and nobody asked you again since (approving clears your ask on GitHub).
  // A push or someone else's reply after it brings the PR back to wherever its rules put it.
  const yours = item.reviews.findLast((r) => lc(r.author) === me && r.state !== "commented" && r.state !== "pending");
  if (
    yours?.state === "approved" &&
    !s.me.requested &&
    !(lastAsk && lastAsk.at > yours.at) &&
    !s.me.pushed_since_review &&
    !s.me.new_activity
  )
    return { reason: "you approved", actor: s.me.login, at: yours.at };

  const mode = settings["github.resolve_on_others_approval"];
  const viaTeam = s.me.requested ? !s.me.requested_direct : lastAsk?.reviewer_type === "team";
  // Your changes request still blocks the merge, and "required" means more reviews (maybe yours or your team's) are needed.
  const blocked = s.me.review_state === "changes_requested" || item.review_decision === "required";
  if ((mode === "always" || (mode === "team_only" && viaTeam)) && !blocked) {
    const bots = new Set(settings["github.bots"].map(lc));
    const isBot = (r: Item["reviews"][number]) => r.author_bot || bots.has(lc(r.author)) || r.author.endsWith("[bot]");
    const since = lastAsk?.at ?? "";
    // Each reviewer's latest verdict: a later change request or dismissal takes an approval back.
    const verdicts = new Map<string, Item["reviews"][number]>();
    for (const r of item.reviews) if (r.state !== "commented" && r.state !== "pending") verdicts.set(lc(r.author), r);
    const approval = [...verdicts.values()]
      .filter((r) => r.state === "approved" && r.at > since && lc(r.author) !== me && !isBot(r))
      .sort((a, b) => a.at.localeCompare(b.at))[0];
    if (approval) return { reason: `approved by ${approval.author}`, actor: approval.author, at: approval.at };
  }
  if (!s.me.requested && !s.me.reviewed) return { reason: "no longer requested", actor: "", at: null };
  return null;
}
