// Whose a PR an agent opened for a person is: the formats, and why each is safe, are in docs/api.md → Opened for you.
import type { Item } from "../types.ts";

const LABEL = String.raw`(@[A-Za-z0-9][A-Za-z0-9_-]{0,38}|\*\*(?:\\\*|[^*\n]){1,60}\*\*)`;
// Junior's runtime-owned block: "via A, B." (once "Requested by A."), A being who asked first.
const JUNIOR = new RegExp(
  String.raw`<!-- junior-request-attribution:start -->\s*(?:via|Requested by)\s+${LABEL}[^\n]*\s*<!-- junior-request-attribution:end -->`,
);
// A whole line of its own: Devin's "Requested by: @login", or "via @login.", "On behalf of @login", maybe in _ or *.
const LINE = new RegExp(String.raw`^[ \t]*[_*]?(?:requested by:?|on behalf of|via)[ \t]+${LABEL}\.?[_*]?[ \t]*$`, "gim");
// GitHub's Copilot coding agent writes no line: whoever asked it is its PR's human assignee.
const ASSIGNS = new Set(["copilot", "copilot-swe-agent"]);

const unbold = (label: string) => (label.startsWith("@") ? label : label.slice(2, -2).replaceAll("\\*", "*").trim());

// Who a PR's description says it was opened for: "@login", a name, or "" when none or when its lines disagree.
export function requesterOf(markdown: string): string {
  const block = JUNIOR.exec(markdown)?.[1];
  if (block) return unbold(block);
  const named = new Set([...markdown.matchAll(LINE)].map((m) => unbold(m[1]!)));
  return named.size === 1 ? [...named][0]! : "";
}

// A bot's PR is yours when it names you by login and assigns you, names you by your GitHub profile name or one you gave
// (`names`, compared by letters alone: "greg.pstrucha" is "Greg Pstrucha"), or is
// Copilot's with you its only human assignee. A person's PR is only ever its author's.
export function onBehalf(
  it: Pick<Item, "kind" | "author" | "author_bot" | "assignees" | "requester" | "via">,
  me: string,
  names: readonly string[],
  isBot: (login: string, flagged?: boolean) => boolean,
): boolean {
  const lc = (s: string) => s.toLowerCase();
  if (it.kind !== "pr" || !me || !isBot(it.author, it.author_bot) || lc(it.author) === lc(me)) return false;
  // Stored before the desk read requesters: its via line, until the item is fetched again.
  const r = it.requester ?? it.via ?? "";
  if (r.startsWith("@")) return lc(r.slice(1)) === lc(me) && it.assignees.some((a) => lc(a) === lc(me));
  const letters = (s: string) => s.toLowerCase().replaceAll(/[^\p{L}\p{N}]/gu, "");
  if (r) return !!letters(r) && names.some((n) => letters(n) === letters(r));
  const people = it.assignees.filter((a) => !ASSIGNS.has(lc(a)) && !isBot(a));
  return ASSIGNS.has(lc(it.author)) && people.length === 1 && lc(people[0]!) === lc(me);
}
