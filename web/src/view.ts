import { Result } from "effect";
import type {
  ActivityEvent,
  AskLines,
  Card,
  Conversation,
  InlineAt,
  JudgeStatus,
  JudgeStep,
  QueueView,
  ReviewFile,
  ReviewHunk,
  ReviewNote,
  ReviewOrder,
  SettingDef,
  SettingValue,
  SettingsView,
} from "../../src/types.ts";
import { byPart } from "../../src/types.ts";
import { ago, BUCKET_LABEL, shortRef, aiName } from "./format.ts";

// The Inbox (`queue`), a PR's review in its place, Blocked, FYI (`later`: what was sorted away), your PRs in Merging, the
// Archive (what's done), and Settings (with the rules).
export type Route =
  | { name: "queue" }
  | { name: "review"; id: string }
  | { name: "inquiry"; id: string } // an agent's question
  | { name: "item"; id: string } // a permalink's (src/links.ts): a PR opens in its review, an issue in place on its page
  | { name: "later" }
  | { name: "blocked" } // what can't move until something else happens
  | { name: "inflight" }
  | { name: "archive" }
  | { name: "settings"; section: string };
// What a write that finished your part did, and where the item went: the Archive, or Merging.
export interface Acted {
  what: string;
  where: "archive" | "inflight";
  sending?: boolean;
}

// A list page a review was opened from, and goes back to.
export type ListPage = "queue" | "later" | "blocked" | "inflight" | "archive";
// The Inbox is one list: what the rules and Claude put in now, then today, in the desk's order. What was sorted away is on
// FYI (`later`); what's done (yours, or resolved by the world) is in the Archive.
export type GroupKey = "queue" | "later" | "fyi" | "hidden" | "cleared" | "archive" | "blocked";
export type Variant = "active" | "hidden" | "cleared" | "archive" | "blocked";

export interface Group {
  key: GroupKey;
  label: string;
  cards: Card[]; // after the filter, and the fold
  total: number; // before the filter
  open: boolean;
  forced: boolean; // opened by the filter, not by you
  variant: Variant;
  fold: number; // the queue: items behind its "n more" line
}

// The cursor's stop on a group's "n more" line.
export const foldOf = (k: GroupKey) => `fold:${k}`;
// Hand off for merge is for a PR that's through its review: your agent gets an approved PR merged, it doesn't get one approved.
export const awaitsReview = (c: Pick<Card, "review">) => c.review === "required" || c.review === "changes_requested";
// Nor a draft (Ready for review first), nor one nobody's asked to review (Add reviewers first).
export const handsOff = (c: Pick<Card, "draft" | "cta" | "review">) => !c.draft && c.cta !== "reviewers" && !awaitsReview(c);
export const inquiryOf = (id: string) => `ask:${id}`; // an agent's question on the main page

export const SORTED_AWAY: GroupKey[] = ["later", "fyi", "hidden", "cleared"];
// The groups each list page shows.
export const PAGE_GROUPS: Record<"queue" | "later" | "archive" | "blocked", GroupKey[]> = {
  queue: ["queue"],
  later: SORTED_AWAY,
  archive: ["archive"],
  blocked: ["blocked"],
};

// Settings' old section ids, still in links and habits, and the part each one's settings live in now.
const SETTINGS_ALIAS: Record<string, string> = { notify: "queue", review: "github", appearance: "app", handoff: "github" };

// The editors that open as views of their own inside Settings, by id, and the part each one's Edit row is in.
export const SETTINGS_VIEWS: Record<string, { name: string; part: string } | undefined> = {
  rules: { name: "Searches and rules", part: "github" },
  policy: { name: "Your policy", part: "agent" },
};

// Settings' parts, each a route (#/settings/<id>) and an item of the sidebar while you're in Settings: the core's, then under
// a hairline one per plugin, holding its account, its settings and the automations it comes with.
export const SETTINGS_PARTS: readonly { id: string; name: string; plugin?: true }[] = [
  { id: "queue", name: "Inbox and notifications" },
  { id: "agent", name: "Agent" },
  { id: "automations", name: "Your automations" },
  { id: "app", name: "This device" },
  { id: "github", name: "GitHub", plugin: true },
];

// An automation's own view in Settings ("automations/warden-issues", a plugin's "automations/github.pick-reviewer"): its id.
export const automationOf = (section: string): string | null => /^automations\/([\w-]+(?:\.[\w-]+)?)$/.exec(section)?.[1] ?? null;

// Where a Settings view's back link and Esc go: the part it opened from (a plugin's automation's, its plugin's); null on a part.
export function settingsBack(section: string): string | null {
  const view = SETTINGS_VIEWS[section]?.part;
  if (view) return view;
  const id = automationOf(section);
  if (id === null) return null;
  const plugin = id.includes(".") ? id.slice(0, id.indexOf(".")) : null;
  return plugin && SETTINGS_PARTS.some((p) => p.plugin && p.id === plugin) ? plugin : "automations";
}

// The part a Settings route is on, which the sidebar marks: its own, or the one its view opened from.
export const settingsPart = (section: string): string => settingsBack(section) ?? section;

// A part's name, for the page's head and the way back to it.
export const partName = (id: string): string => SETTINGS_PARTS.find((p) => p.id === id)?.name ?? "Settings";

// What shows an automation run's session (Claude Code's, or Codex's): resumed in the automations folder, beside settings.json in the desk's home.
export function resumeCommand(settingsPath: string, session: string, codex = false): string {
  const win = /^[A-Za-z]:\\/.test(settingsPath);
  const dir = `${settingsPath.replace(/[\\/]settings\.json\b.*$/, "")}${win ? "\\" : "/"}automations`;
  const quoted = /^[\w./\\:~+-]+$/.test(dir) ? dir : win ? `"${dir}"` : `'${dir.replaceAll("'", String.raw`'\''`)}'`;
  return `cd ${quoted} && ${codex ? "codex resume" : "claude --resume"} ${session}`;
}

// What opens your agent from a terminal: Claude Code's attach, or Codex's resume of its session.
export const attachCommand = (id: string, codex: boolean): string => (codex ? `codex resume ${id}` : `claude attach ${id}`);

// The desktop app's bridge as far as Settings' rows care (window.desktop): absent in a browser.
type Shell = { platform: string } | undefined;
type Values = Record<string, SettingValue>;
const inApp = (_: Values, app: Shell) => app !== undefined;

// Settings' rows that would do nothing here aren't drawn, by key; `desk settings` and settings.json still set them.
export const SHOWN: Record<string, ((values: Values, app: Shell) => boolean) | undefined> = {
  "agent.coordinator_bypass": (v) => v["agent.coordinator"] !== false,
  "app.hotkey": inApp,
  "app.open_at_login": inApp,
  "app.menu_bar_count": (_, app) => app?.platform === "darwin", // only macOS's tray draws a title beside the icon
  "app.source": inApp,
  "app.tailscale": inApp, // the desk's own computer: a browser elsewhere is reached through it
  "app.tailscale_login": inApp,
};

// Rows greyed while another setting leaves them nothing to do, by key.
export const DISABLED: Record<string, ((values: Values) => boolean) | undefined> = {
  "notify.quiet": (v) => v["notify.enabled"] === false,
};

// Quiet hours' "19:00-09:00" as its two time fields' "HH:MM"; null while it's off ("") or not that shape.
export function quietTimes(v: string): [string, string] | null {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(v.trim());
  return m ? [`${m[1]!.padStart(2, "0")}:${m[2]!}`, `${m[3]!.padStart(2, "0")}:${m[4]!}`] : null;
}

// A shortcut in the Mac's words: Electron's Alt is Option there, and CommandOrControl is Command. The app takes either.
export const macKeys = (acc: string) =>
  acc
    .split("+")
    .map((k) => ({ Alt: "Option", CommandOrControl: "Command", CmdOrCtrl: "Command", Cmd: "Command", Ctrl: "Control" })[k] ?? k)
    .join("+");

// The shortcut row's help from the desktop app's status(); null until the app answers for the shortcut that's saved.
export function hotkeyHelp(
  saved: string,
  s: { accelerator: string; ok: boolean; error?: string } | null,
  mac = false,
): { text: string; bad: boolean } | null {
  if (!saved) return { text: "Off.", bad: false };
  if (!s || s.accelerator !== saved) return null;
  if (s.ok) return { text: "Works from any app.", bad: false };
  return { text: `Couldn't use ${mac ? macKeys(saved) : saved}: ${(s.error ?? "another app has it").replace(/\.?$/, ".")}`, bad: true };
}

export function parseRoute(hash: string): Route {
  const m = hash.match(/^#\/settings(?:\/([\w-]*(?:\/[\w-]+(?:\.[\w-]+)?)?))?\/?$/);
  if (m) return { name: "settings", section: m[1] ? (SETTINGS_ALIAS[m[1]] ?? m[1]) : SETTINGS_PARTS[0]!.id };
  if (hash === "#/rules") return { name: "settings", section: "rules" };
  if (hash === "#/inflight") return { name: "inflight" };
  if (hash === "#/later") return { name: "later" };
  if (hash === "#/blocked" || hash === "#/waiting") return { name: "blocked" };
  if (hash === "#/archive") return { name: "archive" };
  const page = /^#\/(review|inquiry|item)\/(.+)$/.exec(hash);
  if (page) {
    const id = Result.try({ try: () => decodeURIComponent(page[2]!), catch: () => "a mangled link" });
    return Result.isSuccess(id) ? { name: page[1] as "review" | "inquiry" | "item", id: id.success } : { name: "queue" };
  }
  return { name: "queue" };
}

// The page the sidebar marks current: a review is on the page it was opened from, a question on the Inbox; Settings is none.
export function pageOf(route: Route, from: ListPage): ListPage | null {
  if (route.name === "review") return from;
  if (route.name === "inquiry" || route.name === "item") return "queue";
  return route.name === "settings" ? null : route.name;
}

// The list beside a review or a question, in a window 1160px or wider (`roomy`): open, or its rail when you folded it or
// while the chat is open in a window under 1600px (`crowded`), unless you opened it beside the chat (`peek`).
export function beside(o: {
  route: Route;
  roomy: boolean;
  crowded: boolean;
  folded: boolean;
  chat: boolean;
  peek: boolean;
}): "open" | "rail" | null {
  if (!o.roomy || (o.route.name !== "review" && o.route.name !== "inquiry")) return null;
  return o.folded || (o.chat && o.crowded && !o.peek) ? "rail" : "open";
}

// What the Inbox counts: everything on it, an agent's question included (one waits on you too); a row on its way off (you
// acted on it) or a question you answered no longer counts.
export const inboxCount = (v: QueueView, leaving: ReadonlySet<string> = new Set(), answered: ReadonlySet<string> = new Set()) =>
  [...v.sections.now, ...v.sections.today].filter((c) => !leaving.has(c.id)).length + v.inquiries.filter((q) => !answered.has(q.id)).length;

export function routeHash(r: Route): string {
  if (r.name === "settings") return `#/settings/${r.section}`;
  if (r.name === "review" || r.name === "inquiry" || r.name === "item") return `#/${r.name}/${encodeURIComponent(r.id)}`;
  return r.name === "queue" ? "#/" : `#/${r.name}`;
}

// ---------------------------------------------------------------- review

// GitHub's file patch is only hunks; the diff renderer wants git's file headers too.
export function filePatch(f: ReviewFile): string {
  const before = f.previous_path ?? f.path;
  const mode = f.status === "added" ? "new file mode 100644\n" : f.status === "removed" ? "deleted file mode 100644\n" : "";
  const from = f.status === "added" ? "/dev/null" : `a/${before}`;
  const to = f.status === "removed" ? "/dev/null" : `b/${f.path}`;
  return `diff --git a/${before} b/${f.path}\n${mode}--- ${from}\n+++ ${to}\n${f.patch ?? ""}\n`;
}

// One stretch of the review: a file's hunks next to each other in the desk's order, at one level and for one reason.
export interface Section {
  key: string;
  path: string;
  file: number; // index in ReviewView.files
  level: ReviewHunk["level"]; // skip: Claude left it out, or under a ranked review's fold; null: no ranking
  why: string | null; // Claude's few words, why it wasn't read, or why the desk folded the file
  hunks: ReviewHunk[]; // none for a file with no text diff
  notes: number[]; // indices into ai.notes, in reading order
}

// A file's neighbouring hunks at one level and for one reason, as one section.
function grouped(hunks: ReviewHunk[], list: Section[] = []): Section[] {
  const from = list.length;
  for (const h of hunks) {
    const last = list.length > from ? list.at(-1) : undefined;
    if (last?.path === h.path && last.level === h.level && last.why === h.why) {
      last.hunks.push(h);
      last.notes.push(...h.notes);
    } else list.push({ key: h.id, path: h.path, file: h.file, level: h.level, why: h.why, hunks: [h], notes: [...h.notes] });
  }
  return list;
}

const restOf = (o: ReviewOrder): Section[] =>
  o.rest.map((r) => ({
    key: `rest:${r.path}`,
    path: r.path,
    file: r.file,
    level: o.ranked ? "skip" : null,
    why: r.why,
    hunks: r.hunks,
    notes: [...r.notes, ...r.hunks.flatMap((h) => h.notes)],
  }));

// The desk's reading order as sections: ranked, unread, skipped, then from `rest` on, the files the desk folds away.
export function sections(o: ReviewOrder): { list: Section[]; rest: number } {
  const list = grouped([...o.chunks, ...o.unread, ...o.skipped]);
  return { list: [...list, ...restOf(o)], rest: list.length };
}

export interface WalkStep {
  at: number; // its first section in the list
  title: string;
  body: string;
  check: string;
}

// The walk-through as one list of sections: each step's, then from `beyond` on what no step covers, then the desk's fold.
export function walk(o: ReviewOrder): { list: Section[]; rest: number; steps: WalkStep[]; beyond: number } {
  const list: Section[] = [];
  const steps = (o.steps ?? []).map((st) => {
    const at = list.length;
    grouped(st.hunks, list);
    return { at, title: st.title, body: st.body, check: st.check };
  });
  const beyond = list.length;
  grouped(o.beyond ?? [], list);
  const rest = list.length;
  return { list: [...list, ...restOf(o)], rest, steps, beyond };
}

const DRAW_LINES = 400; // about what Pierre highlights in a frame or two

// How far to draw the sections from `from` on: as many as fit in `lines` diff lines, and at least one more.
export function drawUpTo(list: { hunks: Pick<ReviewHunk, "patch">[] }[], from: number, lines = DRAW_LINES): number {
  let i = from;
  let n = 0;
  while (i < list.length && (i === from || n < lines)) {
    for (const h of list[i]!.hunks) n += h.patch.split("\n").length;
    i++;
  }
  return i;
}

// The rows a diff of these hunks draws at least: its context, added and removed lines.
export function diffRows(hunks: Pick<ReviewHunk, "patch">[]): number {
  return hunks.reduce((n, h) => n + h.patch.split("\n").filter((l) => /^[ +-]/.test(l)).length, 0);
}

// Whether a note sits on one of these hunks' lines; one that doesn't is about the whole file, above its diff.
export function onLines(hunks: Pick<ReviewHunk, "header">[], n: Pick<ReviewNote, "side" | "line">): boolean {
  return hunks.some((h) => {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(h.header);
    const [from, count] = n.side === "old" ? [m?.[1], m?.[2]] : [m?.[3], m?.[4]];
    return !!from && n.line >= Number(from) && n.line < Number(from) + Number(count ?? 1);
  });
}

type Side = "new" | "old";

// The diff's rows in order, each with its hunk and its line number on each side it's on (a context line is on both).
function rowsOf(hunks: Pick<ReviewHunk, "patch">[]): { hunk: number; old: number | null; new: number | null }[] {
  const rows: { hunk: number; old: number | null; new: number | null }[] = [];
  for (const [hunk, h] of hunks.entries()) {
    const [head = "", ...lines] = h.patch.split("\n");
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(head);
    if (!m) continue;
    let o = Number(m[1]);
    let n = Number(m[2]);
    for (const l of lines)
      if (l.startsWith("+")) rows.push({ hunk, old: null, new: n++ });
      else if (l.startsWith("-")) rows.push({ hunk, old: o++, new: null });
      else if (l.startsWith(" ")) rows.push({ hunk, old: o++, new: n++ });
  }
  return rows;
}

// Where a comment on the gutter's pick goes: GitHub's line and side, from the earlier row of the pick to the later. GitHub
// takes a range only within one hunk; across two, the comment is on the last line.
export function inlineAt(
  path: string,
  hunks: Pick<ReviewHunk, "patch">[],
  pick: { start: number; side?: "additions" | "deletions"; end: number; endSide?: "additions" | "deletions" },
): InlineAt | null {
  const rows = rowsOf(hunks);
  const at = (line: number, s: "additions" | "deletions" | undefined): { i: number; line: number; side: Side } | null => {
    const side: Side = s === "deletions" ? "old" : "new";
    const i = rows.findIndex((r) => r[side] === line);
    return i < 0 ? null : { i, line, side };
  };
  const a = at(pick.start, pick.side);
  const b = at(pick.end, pick.endSide ?? pick.side);
  if (!a || !b) return null;
  const [first, last] = a.i <= b.i ? [a, b] : [b, a];
  return {
    path,
    line: last.line,
    side: last.side,
    ...(first.i !== last.i && rows[first.i]!.hunk === rows[last.i]!.hunk && { start: { line: first.line, side: first.side } }),
  };
}

// The review threads on these hunks' lines, to show where they are; outdated ones are only in the conversation.
export function threadsOn(conversation: Conversation[], path: string, hunks: Pick<ReviewHunk, "header">[]): Conversation[] {
  return conversation.filter(
    (c) =>
      c.kind === "thread" &&
      c.path === path &&
      !c.outdated &&
      c.line !== null &&
      !!c.side &&
      onLines(hunks, { line: c.line, side: c.side }),
  );
}

// "src/planner/" and "plan.ts", so the name can stay whole while the folder truncates.
export function splitPath(p: string): [string, string] {
  const i = p.lastIndexOf("/");
  return [p.slice(0, i + 1), p.slice(i + 1)];
}

export const lineName = (at: InlineAt) => `${splitPath(at.path)[1]}:${at.start ? `${at.start.line}\u2013` : ""}${at.line}`;

// Mixed sides read as the new file's lines: only an all-removed range says so.
export function linesLabel(l: AskLines): string {
  if (l.note) return `${aiName()}'s note on ${lineName(l)}`;
  return l.side === "old" && (!l.start || l.start.side === "old") ? `${lineName(l)}, removed` : lineName(l);
}

// A resolved PR's "Resolved: …" line takes the event that caused it (and who merged or closed it), so Recent activity
// doesn't say it again; the "resolved" events go too. `events` are newest first.
export function resolvedHead(events: ActivityEvent[], resolved: string, me: string): { line: string; events: ActivityEvent[] } {
  const ended = resolved === "merged" || resolved === "closed";
  const approver = /^approved by (.+)$/.exec(resolved)?.[1]?.toLowerCase();
  const cause = events.find((e) =>
    ended
      ? e.kind === resolved
      : resolved === "no longer requested"
        ? e.kind === "request_removed"
        : e.kind === "reviewed" && e.data.state === "approved" && e.actor.toLowerCase() === approver,
  );
  const who = ended && cause?.actor ? ` by ${cause.actor.toLowerCase() === me.toLowerCase() ? "you" : cause.actor}` : "";
  return { line: `Resolved: ${resolved}${who}`, events: events.filter((e) => e !== cause && e.kind !== "resolved") };
}

// Which section the reader is in: the last one whose top has scrolled past the line under the page head. At the page's end
// the last ones can't reach that line, so it's the last one.
export function currentFile(tops: number[], line: number, atEnd = false): number {
  if (atEnd) return Math.max(0, tops.length - 1);
  let cur = 0;
  for (const [i, top] of tops.entries()) if (top <= line) cur = i;
  return cur;
}

const matches = (c: Card, q: string) =>
  !q || `${c.title}\n${c.repo}\n${c.author}\n${shortRef(c)}`.toLowerCase().includes(q.trim().toLowerCase());

// FYI's Later group opens with the page; the rest open when asked (a click on their heading).
export const DEFAULT_OPEN: Record<GroupKey, boolean> = {
  queue: true,
  later: true,
  fyi: false,
  hidden: false,
  cleared: false,
  archive: true,
  blocked: true,
};

const LABEL: Record<GroupKey, string> = {
  queue: "Queue",
  later: "Later",
  fyi: "FYI",
  hidden: "Hidden by rules",
  cleared: "Snoozed or muted",
  archive: "Archive",
  blocked: "Blocked",
};

// The queue is now's items then today's, in the desk's order, and folds after its first queue.cards. While filtering, every
// group with a match opens so nothing that matches stays tucked away, and nothing folds.
export function groupsOf(
  view: QueueView | null,
  open: Record<GroupKey, boolean>,
  filter: string,
  unfolded: Partial<Record<GroupKey, boolean>> = {},
): Group[] {
  if (!view) return [];
  const q = filter.trim();
  const group = (key: GroupKey, all: Card[], variant: Variant = "active", cap?: number): Group => {
    const matched = all.filter((c) => matches(c, q));
    const forced = !!q && matched.length > 0 && !open[key];
    // A fold that would hide one item costs more than the item: it folds only when two or more would go behind it.
    const n = cap && !q && !unfolded[key] && matched.length - cap >= 2 ? cap : matched.length;
    return {
      key,
      label: LABEL[key],
      cards: matched.slice(0, n),
      total: all.length,
      open: open[key] || forced,
      forced,
      variant,
      fold: matched.length - n,
    };
  };
  const s = view.sections;
  return [
    // One list in the desk's order: it sorts Now and Today each by part, and the page shows each part's Now before its Today.
    group("queue", byPart([...s.now, ...s.today]), "active", view.cards),
    group("later", s.later),
    group("fyi", s.fyi),
    group("hidden", view.hidden, "hidden"),
    group(
      "cleared",
      view.cleared.filter((c) => c.status !== "done"),
      "cleared",
    ),
    // What you did that took it off your desk, and what the world dealt with: newest first.
    group(
      "archive",
      [...view.cleared.filter((c) => c.status === "done"), ...view.resolved].sort((a, b) =>
        (b.resolved_at ?? b.done_at ?? "").localeCompare(a.resolved_at ?? a.done_at ?? ""),
      ),
      "archive",
    ),
    // What can't move yet, a chain's rows together, in the desk's order.
    group("blocked", s.blocked, "blocked"),
  ];
}

// The list page and group that show a card, folds open: where a permalink to an issue opens it in place.
export function whereIs(view: QueueView, id: string): { page: keyof typeof PAGE_GROUPS; group: GroupKey } | null {
  const group = groupsOf(view, DEFAULT_OPEN, "", { queue: true }).find((g) => g.cards.some((c) => c.id === id))?.key;
  const page = group && (Object.keys(PAGE_GROUPS) as (keyof typeof PAGE_GROUPS)[]).find((p) => PAGE_GROUPS[p].includes(group));
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

// The rows on screen, and a group's "n more" line where it folds.
export const stops = (groups: Group[], leaving: Set<string>): string[] =>
  groups.flatMap((g) =>
    g.open ? [...g.cards.filter((c) => !leaving.has(c.id)).map((c) => c.id), ...(g.fold ? [foldOf(g.key)] : [])] : [],
  );

export function removeCard(v: QueueView, id: string): QueueView {
  const drop = (cs: Card[]) => cs.filter((c) => c.id !== id);
  const s = v.sections;
  return {
    ...v,
    sections: { now: drop(s.now), today: drop(s.today), blocked: drop(s.blocked), later: drop(s.later), fyi: drop(s.fyi) },
    hidden: drop(v.hidden),
  };
}

// Best-effort 0-based line for a config error path like "boards[1].rules[2].when" in TOML text.
const HEADER = /^\s*\[\[?\s*([\w.]+)\s*\]\]?\s*(#.*)?$/;

export function lineOf(text: string, path: string): number | null {
  const lines = text.split("\n");
  const lineAt = (i: number) => lines[i] ?? "";
  // TOML syntax errors come as "line 12" (1-based).
  const numbered = path.match(/^line (\d+)$/);
  if (numbered) return Math.min(Number(numbered[1]), lines.length) - 1;
  const header = (i: number) => lineAt(i).match(HEADER)?.[1] ?? null;
  // A table ends at the next header that isn't one of its sub-tables.
  const end = (at: number, name: string) => {
    for (let i = at + 1; i < lines.length; i++) {
      const h = header(i);
      if (h !== null && !h.startsWith(`${name}.`)) return i;
    }
    return lines.length;
  };
  let from = 0;
  let to = lines.length;
  let found: number | null = null;
  const prefix: string[] = [];
  for (const [, key = "", idx] of path.matchAll(/([A-Za-z_]\w*)(?:\[(\d+)\])?/g)) {
    prefix.push(key);
    const name = prefix.join(".");
    let at = -1;
    if (idx !== undefined) {
      for (let i = from, n = 0; i < to; i++) {
        if (header(i) === name && lineAt(i).trim().startsWith("[[") && n++ === Number(idx)) {
          at = i;
          break;
        }
      }
      // Inline arrays (`rules = [ { when = … }, … ]`): the idx-th `{` line after `key = [`.
      if (at < 0) {
        const open = new RegExp(`^\\s*${key}\\s*=\\s*\\[`);
        for (let i = from; i < to && header(i) === null; i++) {
          if (!open.test(lineAt(i))) continue;
          for (let j = i + 1, n = 0; j < to && !/^\s*\]/.test(lineAt(j)); j++)
            if (lineAt(j).trim().startsWith("{") && n++ === Number(idx)) return j;
          return i;
        }
      }
    } else {
      const assign = new RegExp(`^\\s*${key}\\s*=`);
      for (let i = from; i < to && header(i) === null; i++) if (assign.test(lineAt(i))) return i;
      for (let i = from; i < to; i++) {
        if (header(i) === name) {
          at = i;
          break;
        }
      }
    }
    if (at < 0) return found;
    found = at;
    from = at + 1;
    to = end(at, name);
  }
  return found;
}

// ---------------------------------------------------------------- settings

export const draftOf = (v: SettingDef["default"]): string => (Array.isArray(v) ? v.join("\n") : String(v));

export const parseList = (text: string) =>
  text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

// The value to save for a field's text. The server judges it: a blank number is sent as NaN (null in JSON) and rejected.
export function valueOf(def: SettingDef, text: string): SettingValue {
  if (def.type === "number") return text.trim() === "" ? NaN : Number(text);
  if (def.type === "list") return parseList(text);
  return def.type === "text" ? text : text.trim();
}

export interface KeyLike {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const KEY_NAMES: Record<string, string> = {
  Space: "Space",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Enter: "Return",
  NumpadEnter: "Return",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Escape: "Escape",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
  Backslash: "\\",
};

// An Electron accelerator, or null until the combo has a key plus Control, Alt or Command.
// Reads the physical key (code): with Option held a Mac reports Alt+D as "∂".
export function acceleratorOf(e: KeyLike, mac: boolean): string | null {
  const m = e.code.match(/^(?:Key([A-Z])|Digit(\d)|(F(?:[1-9]|1\d|2[0-4])))$/);
  const key = m ? (m[1] ?? m[2] ?? m[3]) : KEY_NAMES[e.code];
  if (!key || !(e.ctrlKey || e.altKey || e.metaKey)) return null;
  const mods = [
    e.metaKey && (mac ? "Command" : "Super"),
    e.ctrlKey && "Control",
    e.altKey && (mac ? "Option" : "Alt"),
    e.shiftKey && "Shift",
  ];
  return [...mods.filter(Boolean), key].join("+");
}

// Errors that `gh auth login` fixes, e.g. "GitHub rejected the token (HTTP 401)".
export const authProblem = (error: string) => /\b(401|token|bad credentials|unauthori[sz]ed|gh auth)\b/i.test(error);

// ---------------------------------------------------------------- the policy judge

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sentence = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? "" : "."}`;
// "5m": how long until `at`.
const until = (at: string, now: number) => ago(new Date(2 * now - Date.parse(at)).toISOString(), now).replace(/ ago$/, "");

// The judge's step in a rule trace, after "Claude": as src/judge.ts's judgeText says it to agents.
export function judgeStepText(j: JudgeStep): string {
  if (j.bucket === null) return j.pending ? "not sorted yet, so where the rules put it" : "no answer, so where the rules put it";
  const why = j.why || "keeps the rule's why";
  return `${BUCKET_LABEL[j.bucket].toLowerCase()}, ${why}${j.pending ? " (an earlier answer; sorting it again)" : ""}`;
}

// AI reviews paused and Claude's sorting failing for the one reason (a lapsed login): Settings says it once, in Claude's
// part, with the sooner of their next tries; null when they differ, or either is fine.
export function onePause(ai: SettingsView["paused"]["ai"], judge?: JudgeStatus): { why: string; next: string } | null {
  if (!ai || judge?.state !== "error" || judge.error !== ai.why) return null;
  return { why: ai.why, next: judge.retry_at && judge.retry_at < ai.until ? judge.retry_at : ai.until };
}

export function judgeStatusText(j: JudgeStatus, now: number): string {
  if (j.state === "off") return `${aiName()} doesn't sort your desk: ${j.off_reason ?? "it's off"}.`;
  const hour = `${j.spent} of ${j.max_per_hour} this hour.`;
  if (j.state === "error")
    return `${aiName()}'s last sorting call failed: ${sentence(j.error ?? "unknown error")}${j.retry_at ? ` Next try in ${until(j.retry_at, now)}.` : ""}`;
  const placed = `${count(j.judged, "item")} sorted by ${aiName()}${j.waiting ? `, ${j.waiting} waiting` : ""}`;
  if (j.state === "idle" && j.retry_at)
    return `${sentence(placed)} The hour's limit is reached (${j.max_per_hour}); next batch in ${until(j.retry_at, now)}.`;
  return j.state === "running" ? `Sorting now. ${sentence(placed)} ${sentence(hour)}` : `${sentence(placed)} ${sentence(hour)}`;
}
