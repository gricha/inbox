// The Inbox's lists: their groups, what a row says and counts, chains of waiting steps, picking rows, an item's log.
import { keysOf } from "../../src/narrow.ts";
import {
  askRef,
  type AgentName,
  type Card,
  type InboxSection,
  type PlacedEntry,
  type QueueView,
  type WaitingStep,
  type Where,
} from "../../src/types.ts";
import { matches } from "./filter.ts";
import { aiName, BUCKET_LABEL, snoozeOptions } from "./format.ts";

// Ids to leave out: a Set, or the keys of a Map.
export interface Ids {
  has(id: string): boolean;
}

// What a write that finished your part did, and where the item went: the Archive, or Merging.
export interface Acted {
  what: string;
  where: "archive" | "inflight";
  sending?: boolean;
}

// The Inbox is its sections, as the desk placed and ordered them (QueueView.inbox). What's done (yours, or resolved by the
// world), snoozed, muted or hidden by rules is in the Archive.
export type GroupKey = "urgent" | "standard" | "fyi" | "hidden" | "cleared" | "archive" | "blocked";

export type Variant = "active" | "hidden" | "cleared" | "archive" | "blocked";

export interface Group {
  key: GroupKey;
  label: string;
  cards: Card[]; // after the filter
  total: number; // before the filter
  open: boolean;
  forced: boolean; // opened by the filter, not by you
  variant: Variant;
}

export const inquiryOf = askRef; // an agent's question on the main page

// The groups each list page shows.
export const PAGE_GROUPS: Record<"queue" | "archive" | "blocked", GroupKey[]> = {
  queue: ["urgent", "standard", "fyi"],
  archive: ["archive", "cleared", "hidden"],
  blocked: ["blocked"],
};

// The other agents' resume: Codex's by thread, OpenCode's TUI on a session.
const RESUME = { codex: "codex resume", opencode: "opencode --session" } as const;

// What shows an automation run's session (Claude Code's, Codex's or OpenCode's): resumed in the automations folder, beside settings.json in the desk's home.
export function resumeCommand(settingsPath: string, session: string, agent?: "codex" | "opencode"): string {
  const win = /^[A-Za-z]:\\/.test(settingsPath);
  const dir = `${settingsPath.replace(/[\\/]settings\.json\b.*$/, "")}${win ? "\\" : "/"}automations`;
  const quoted = /^[\w./\\:~+-]+$/.test(dir) ? dir : win ? `"${dir}"` : `'${dir.replaceAll("'", String.raw`'\''`)}'`;
  return `cd ${quoted} && ${agent ? RESUME[agent] : "claude --resume"} ${session}`;
}

// What opens your agent from a terminal: Claude Code's attach, or Codex's or OpenCode's resume of its session.
export const attachCommand = (id: string, agent: AgentName): string =>
  agent === "Codex" ? `codex resume ${id}` : agent === "OpenCode" ? `opencode --session ${id}` : `claude attach ${id}`;

// What the Inbox counts: everything on it, an agent's question and a session that needs you included (each waits on you
// too); a row on its way off (you acted on it) or a question you answered no longer counts.
export const inboxCount = (v: QueueView, leaving: Ids = new Set(), answered: Ids = new Set()) =>
  [...v.inbox.urgent, ...v.inbox.standard].filter((c) => !leaving.has(c.id)).length +
  v.inquiries.filter((q) => !answered.has(q.id)).length +
  v.sessions.filter((s) => s.status === "active" && !leaving.has(s.id)).length;

const FYI_SHOWN = 5; // FYI's first rows; the rest wait behind Show more until you leave the page

// How many of FYI's rows (`ids`, its notes then its cards) show before Show more, or null for all: none waits for a fold of
// one, nor while the selected row is further down.
export function fyiShown(ids: readonly string[], selected: string | null): number | null {
  if (ids.length <= FYI_SHOWN + 1 || (selected !== null && ids.indexOf(selected) >= FYI_SHOWN)) return null;
  return FYI_SHOWN;
}

// The Inbox's sections, Blocked and the Archive's own group open with their page; the rest open when asked (a click on their heading).
export const DEFAULT_OPEN: Record<GroupKey, boolean> = {
  urgent: true,
  standard: true,
  fyi: true,
  hidden: false,
  cleared: false,
  archive: true,
  blocked: true,
};

const LABEL: Record<GroupKey, string> = {
  urgent: "Urgent",
  standard: "Standard",
  fyi: "FYI",
  hidden: "Hidden by rules",
  cleared: "Snoozed or muted",
  archive: "Archive",
  blocked: "Blocked",
};

// The Inbox's sections in the desk's order, every row shown: all of Urgent before Standard, all of Standard before FYI. While
// filtering, every group with a match opens so nothing that matches stays tucked away.
export function groupsOf(view: QueueView | null, open: Record<GroupKey, boolean>, filter: string, me = ""): Group[] {
  if (!view) return [];
  const q = filter.trim();
  const group = (key: GroupKey, all: Card[], variant: Variant = "active"): Group => {
    const matched = all.filter((c) => matches(c, q, me));
    const forced = !!q && matched.length > 0 && !open[key];
    return {
      key,
      label: LABEL[key],
      cards: matched,
      total: all.length,
      open: open[key] || forced,
      forced,
      variant,
    };
  };
  const s = view.sections;
  return [
    group("urgent", view.inbox.urgent),
    group("standard", view.inbox.standard),
    group("fyi", view.inbox.fyi),
    // What you did that took it off your desk, and what the world dealt with: newest first.
    group(
      "archive",
      [...view.cleared.filter((c) => c.status === "done"), ...view.resolved].sort((a, b) =>
        (b.resolved_at ?? b.done_at ?? "").localeCompare(a.resolved_at ?? a.done_at ?? ""),
      ),
      "archive",
    ),
    group(
      "cleared",
      view.cleared.filter((c) => c.status !== "done"),
      "cleared",
    ),
    group("hidden", view.hidden, "hidden"),
    // What can't move yet, a chain's rows together, in the desk's order.
    group("blocked", s.blocked, "blocked"),
  ];
}

// The list page and group that show a card: where a permalink to an issue opens it in place.
export function whereIs(view: QueueView, id: string): { page: keyof typeof PAGE_GROUPS; group: GroupKey } | null {
  const group = groupsOf(view, DEFAULT_OPEN, "").find((g) => g.cards.some((c) => c.id === id))?.key;
  const page = group && keysOf(PAGE_GROUPS).find((p) => PAGE_GROUPS[p].includes(group));
  return group && page ? { page, group } : null;
}

// Blocked's tree guide, from its rows' depths in the desk's order: per row, one per level, as `tree` draws them (├ └ │ or none).
export type Guide = "tee" | "end" | "rail" | "gap";

export function treeGuides(depths: number[]): Guide[][] {
  // Whether a later row hangs at level k under the same row as this one does, before the tree climbs above k.
  const more = (i: number, k: number) => {
    for (const d of depths.slice(i + 1)) if (d <= k) return d === k;
    return false;
  };
  return depths.map((d, i) =>
    Array.from({ length: d }, (_, l): Guide => (l + 1 === d ? (more(i, d) ? "tee" : "end") : more(i, l + 1) ? "rail" : "gap")),
  );
}

// A chain's waiting steps hang one level under its head, wherever the head hangs: the head's guide goes on past them.
export function stepGuides(head: Guide[], n: number): Guide[][] {
  const above = head.map((g, i): Guide => (i < head.length - 1 ? g : g === "tee" ? "rail" : "gap"));
  return Array.from({ length: n }, (_, i): Guide[] => [...above, i === n - 1 ? "end" : "tee"]);
}

// A waiting step's why, in place of its own: what it comes after.
export const afterText = (s: WaitingStep) => `After ${s.after}${s.draft ? " \u00b7 Draft" : ""}`;

// A chain head's button: how many steps wait on it, or Hide while they're open.
export const chainLabel = (n: number, open: boolean) => (open ? "Hide" : `${n} after this`);

export const WAIT = "wait:"; // a waiting step's row id, as its right-click reads it

// The waiting step a row id names, among the heads on screen.
export function stepOf(id: string, heads: readonly { waiting?: WaitingStep[] | undefined }[]): WaitingStep | undefined {
  if (!id.startsWith(WAIT)) return undefined;
  return heads.flatMap((h) => h.waiting ?? []).find((s) => `${WAIT}${s.id}` === id);
}

// The steps a chain in the view still waits on, by id.
export function waitingSteps(view: QueueView): ReadonlySet<string> {
  const n = view.notes;
  const heads = [...Object.values(view.sections).flat(), ...view.resolved, ...view.cleared, ...view.hidden];
  return new Set([...heads, ...n.due, ...n.urgent, ...n.open, ...n.fyi, ...n.later].flatMap((h) => h.waiting ?? []).map((s) => s.id));
}

// This device's open chains: a head's id in the set or out of it.
export const toggled = (open: ReadonlySet<string>, id: string): Set<string> => {
  const next = new Set(open);
  if (!next.delete(id)) next.add(id);
  return next;
};

// The same fact in other words, as rules write whys: "conflicts with main", "red CI", "you requested changes", "2 approvals".
const MEANINGS = [
  /conflict/i,
  /\bCI\b.*\b(?:fail\w*|red|broken)\b|\b(?:fail\w*|red|broken)\b.*\bCI\b/i,
  /\bchanges requested\b|\brequested changes\b/i,
  /\bapprov(?:ed|als?)\b/i,
];

// Whether a why already says a fact, in its words or in other words for the same thing.
export const says = (why: string, fact: string) =>
  why.toLowerCase().includes(fact.toLowerCase()) || MEANINGS.some((m) => m.test(why) && m.test(fact));

const PLACED_BY: Record<NonNullable<Card["placed_by"]>, string> = {
  hard: "placed by a hard rule",
  pin: "kept up by its pin",
  get claude() {
    return `sorted by ${aiName()}`;
  },
  automation: "sorted by an automation",
  get pending() {
    return `not sorted by ${aiName()} yet`;
  },
  get unanswered() {
    return `${aiName()} gave no answer`;
  },
};

// The selected card's facts, in the review header's words, less what the card already says: its why, its problems and
// size, which every card shows, and a sorted-away row's note.
export function cardFacts(
  c: Pick<Card, "kind" | "author" | "why" | "chips" | "ci" | "preflight" | "demoted" | "team_ask" | "placed_by">,
  me: string,
  away = false,
): string[] {
  const out: string[] = [];
  if (c.author.toLowerCase() !== me.toLowerCase()) out.push(`by ${c.author}`);
  // Nobody asked you by name: a why like "close collaborator" doesn't say so.
  if (c.team_ask && !c.why.includes("@")) out.push(c.team_ask);
  if (c.kind === "pr" && c.ci === "green" && !/\bgreen\b/i.test(c.why)) out.push("CI passing");
  if (c.kind === "pr" && c.ci === "pending") out.push("CI running");
  if (c.chips.includes("approved")) out.push("approved");
  const threads = /^(\d+) unresolved$/.exec(c.chips.find((x) => x.endsWith(" unresolved")) ?? "")?.[1];
  if (threads) out.push(`${threads} unresolved ${threads === "1" ? "thread" : "threads"}`);
  if (c.chips.includes("draft")) out.push("draft");
  const risk = c.preflight?.risk;
  if (risk && risk !== "high") out.push(`${risk} risk`);
  const notes = c.preflight?.state === "ready" ? (c.preflight.notes ?? 0) : 0;
  if (notes) out.push(`${notes} ${notes === 1 ? "note" : "notes"} on the changes`);
  // Who placed it: its why is a hard rule's, Claude's, or a rule's until Claude answers.
  if (c.placed_by) out.push(PLACED_BY[c.placed_by]);
  if (c.demoted && !away) out.push(c.demoted);
  return out.filter((f) => !says(c.why, f));
}

// The cards on screen, in screen order.
export const navigable = (groups: Group[], leaving: Set<string>) =>
  groups.flatMap((g) => (g.open ? g.cards : [])).filter((c) => !leaving.has(c.id));

// The rows on screen.
export const stops = (groups: Group[], leaving: Set<string>): string[] => navigable(groups, leaving).map((c) => c.id);

// The view without the rows you finished: items off every active group (cleared and resolved keep theirs), and sessions.
export function withoutRows(v: QueueView, gone: Ids): QueueView {
  const drop = <T extends { id: string }>(cs: T[]) => cs.filter((c) => !gone.has(c.id));
  const s = v.sections;
  return {
    ...v,
    sections: { now: drop(s.now), today: drop(s.today), blocked: drop(s.blocked), later: drop(s.later), fyi: drop(s.fyi) },
    inbox: { urgent: drop(v.inbox.urgent), standard: drop(v.inbox.standard), fyi: drop(v.inbox.fyi) },
    hidden: drop(v.hidden),
    sessions: drop(v.sessions),
  };
}

const WHERE_LABEL: Record<Where, string> = {
  urgent: "Urgent",
  standard: "Standard",
  fyi: "FYI",
  blocked: "Blocked",
  hidden: "Hidden",
  cleared: "Off desk",
  resolved: "Resolved",
  gone: "Gone",
};

// One log line's parts: what kind of change it was, where it stood after, and what that rested on (the rule is drawn as a
// link of its own, so it isn't here).
export function logLine(e: PlacedEntry): { kind: string; where: string; judge: string; note: string; why: string } {
  const c = e.changed;
  const kind = c.includes("new")
    ? "new"
    : c.includes("where") && e.status
      ? e.status
      : c.includes("resolved")
        ? "resolved"
        : c.includes("moved") && e.moved
          ? "you moved"
          : c.includes("where")
            ? "moved"
            : c.includes("score")
              ? "score"
              : c.includes("judge")
                ? "judge"
                : c.includes("rule")
                  ? "rule"
                  : "criteria";
  const where = `${WHERE_LABEL[e.where]}${e.score === undefined ? "" : ` ${e.score}`}`;
  const judge = e.judge ? `${e.judge.by ?? aiName()}: ${e.judge.bucket ? BUCKET_LABEL[e.judge.bucket].toLowerCase() : "no answer"}` : "";
  const note = e.resolved ?? (c.includes("criteria") || c.includes("new") ? (e.criteria ?? []).join(", ") : "");
  // Claude's why when it gave one: it's what moved the item; else the row's.
  const said = e.judge?.why ?? "";
  return { kind, where, judge, note, why: said.length > 0 ? said : e.reason };
}

// Shift-click: the rows from the anchor (the row you last clicked) to this one, in the order they're on screen. With no
// anchor on screen, this one alone.
export function pickRange(order: string[], anchor: string | null, id: string): string[] {
  const to = order.indexOf(id);
  if (to < 0) return [];
  const from = anchor === null ? -1 : order.indexOf(anchor);
  if (from < 0) return [id];
  return order.slice(Math.min(from, to), Math.max(from, to) + 1);
}

// ⌘-click: this one added, or dropped if it's picked already.
export const pickToggle = (picked: string[], id: string): string[] =>
  picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];

// What a right-click on several picked rows offers: only what every one of them allows.
export interface BulkMenu {
  done: "done" | "restore" | null; // Done for rows on the Inbox, Back on the desk for the Archive's
  section: InboxSection | null; // all in one section: its moves
  snoozes: ReturnType<typeof snoozeOptions>;
  close: boolean; // all can be closed on GitHub
}

export function bulkMenu(cards: Card[]): BulkMenu {
  const active = cards.every((c) => c.status === "active" && !c.inflight);
  const away = cards.every((c) => c.status !== "active" && !c.inflight);
  const [first] = cards;
  const section = active && first?.section && cards.every((c) => c.section === first.section) ? first.section : null;
  const snoozes =
    active && first ? snoozeOptions(first).filter((o) => cards.every((c) => snoozeOptions(c).some((x) => x.until === o.until))) : [];
  return {
    done: active ? "done" : away ? "restore" : null,
    section,
    snoozes,
    close: cards.length > 0 && cards.every((c) => (c.actions ?? []).includes("close")),
  };
}

const two = (n: number) => String(n).padStart(2, "0");

// Every half hour of a day, as a clock reads it.
export const TIMES = Array.from({ length: 48 }, (_, i) => `${two(Math.floor(i / 2))}:${i % 2 ? "30" : "00"}`);

// A reminder's time once its day is picked: 9:00, or the first half hour still ahead when that's later today.
export const remindTime = (day: string, today: string, now: string): string =>
  TIMES.find((t) => t >= "09:00" && (day > today || t > now)) ?? "23:30";
