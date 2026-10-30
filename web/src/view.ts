import type {
  ActivityEvent,
  Card,
  CoordinatorActed,
  CoordinatorLogEntry,
  CoordinatorStatus,
  InflightRow,
  JudgeStatus,
  JudgeStep,
  QueueView,
  ReviewFile,
  ReviewNote,
  SettingDef,
  SettingValue,
} from "../../src/types.ts";
import { ago, BUCKET_LABEL, shortId, shortRef } from "./format.ts";

// One surface (the queue), a PR's review in its place, your in-flight PRs, and Settings, whose sections include the rules editor.
export type Route = { name: "queue" } | { name: "review"; id: string } | { name: "inflight" } | { name: "settings"; section: string };
export type GroupKey = "now" | "today" | "later" | "fyi" | "resolved" | "hidden" | "cleared";
export type Variant = "active" | "hidden" | "cleared" | "resolved";

export interface Group {
  key: GroupKey;
  label: string;
  cards: Card[]; // after the filter
  total: number; // before the filter
  open: boolean;
  forced: boolean; // opened by the filter, not by you
  variant: Variant;
}

export const SORTED_AWAY: GroupKey[] = ["later", "fyi", "resolved", "hidden", "cleared"];

export function parseRoute(hash: string): Route {
  const m = hash.match(/^#\/settings(?:\/([\w-]*))?\/?$/);
  if (m) return { name: "settings", section: m[1] === undefined || m[1] === "" ? "github" : m[1] };
  if (hash === "#/rules") return { name: "settings", section: "rules" };
  if (hash === "#/inflight") return { name: "inflight" };
  const review = /^#\/review\/(.+)$/.exec(hash);
  if (review) {
    try {
      return { name: "review", id: decodeURIComponent(review[1]!) };
    } catch {
      return { name: "queue" }; // a mangled link
    }
  }
  return { name: "queue" };
}

export function routeHash(r: Route): string {
  if (r.name === "settings") return `#/settings/${r.section}`;
  if (r.name === "review") return `#/review/${encodeURIComponent(r.id)}`;
  return r.name === "inflight" ? "#/inflight" : "#/";
}

// ---------------------------------------------------------------- in flight

// An in-flight PR's state in plain words; `problem` marks what's wrong, which is coloured only while it needs you.
export function laneFacts(
  r: Pick<InflightRow, "ci" | "failing" | "approved_by" | "changes_by" | "waiting_on" | "threads_unresolved" | "mergeable" | "draft">,
  base: string,
): { text: string; problem: boolean }[] {
  const out: { text: string; problem: boolean }[] = [];
  const add = (text: string, problem = false) => out.push({ text, problem });
  if (r.draft) add("draft");
  // Check names can be long ("tacos-gha / TACOS Unlock (terragrunt/regions/…)"): two at most, each clipped.
  const clip = (n: string) => (n.length > 40 ? `${n.slice(0, 39)}…` : n);
  const f = r.failing;
  const failing = f.length > 2 ? `${clip(f[0]!)} and ${f.length - 1} more` : f.map(clip).join(", ");
  if (r.ci === "red") add(failing ? `CI failing: ${failing}` : "CI failing", true);
  else if (r.ci === "green") add("CI passing");
  else if (r.ci === "pending") add("CI running");
  if (r.approved_by.length) add(`approved by ${r.approved_by.join(", ")}`);
  if (r.changes_by.length) add(`changes requested by ${r.changes_by.join(", ")}`, true);
  if (r.waiting_on.length) add(`waiting on ${r.waiting_on.join(", ")}`);
  if (r.threads_unresolved) add(`${r.threads_unresolved} unresolved ${r.threads_unresolved === 1 ? "thread" : "threads"}`);
  if (r.mergeable === "conflict") add(`conflicts with ${base}`, true);
  return out;
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

// Notes in reading order: by file as listed, a file's own notes first, then down the diff.
export function orderNotes(notes: ReviewNote[], files: ReviewFile[]): ReviewNote[] {
  const at = new Map(files.map((f, i) => [f.path, i]));
  return notes
    .filter((n) => at.has(n.path))
    .map((n, i) => ({ n, i }))
    .sort((a, b) => at.get(a.n.path)! - at.get(b.n.path)! || a.n.line - b.n.line || a.i - b.i)
    .map((x) => x.n);
}

// "src/planner/" and "plan.ts", so the name can stay whole while the folder truncates.
export function splitPath(p: string): [string, string] {
  const i = p.lastIndexOf("/");
  return [p.slice(0, i + 1), p.slice(i + 1)];
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

// Which file the reader is in: the last one whose top has scrolled past the line under the top bar.
export function currentFile(tops: number[], line: number): number {
  let cur = 0;
  for (const [i, top] of tops.entries()) if (top <= line) cur = i;
  return cur;
}

const matches = (c: Card, q: string) =>
  !q || `${c.title}\n${c.repo}\n${c.author}\n${shortRef(c)}`.toLowerCase().includes(q.trim().toLowerCase());

export const DEFAULT_OPEN: Record<GroupKey, boolean> = {
  now: true,
  today: true,
  later: false,
  fyi: false,
  resolved: false,
  hidden: false,
  cleared: false,
};

const LABEL: Record<GroupKey, string> = {
  now: "Now",
  today: "Today",
  later: "Later",
  fyi: "FYI",
  resolved: "Resolved",
  hidden: "Hidden by rules",
  cleared: "Cleared",
};

// While filtering, every group with a match opens so nothing that matches stays tucked away.
export function groupsOf(view: QueueView | null, open: Record<GroupKey, boolean>, filter: string): Group[] {
  if (!view) return [];
  const q = filter.trim();
  const group = (key: GroupKey, all: Card[], variant: Variant = "active"): Group => {
    const cards = all.filter((c) => matches(c, q));
    const forced = !!q && cards.length > 0 && !open[key];
    return { key, label: LABEL[key], cards, total: all.length, open: open[key] || forced, forced, variant };
  };
  const s = view.sections;
  return [
    group("now", s.now),
    group("today", s.today),
    group("later", s.later),
    group("fyi", s.fyi),
    group("resolved", view.resolved, "resolved"),
    group("hidden", view.hidden, "hidden"),
    group("cleared", view.cleared, "cleared"),
  ];
}

// The cards j/k move through, in screen order.
export const navigable = (groups: Group[], leaving: Set<string>) =>
  groups.flatMap((g) => (g.open ? g.cards : [])).filter((c) => !leaving.has(c.id));

export function removeCard(v: QueueView, id: string): QueueView {
  const drop = (cs: Card[]) => cs.filter((c) => c.id !== id);
  const s = v.sections;
  return {
    sections: { now: drop(s.now), today: drop(s.today), later: drop(s.later), fyi: drop(s.fyi) },
    hidden: drop(v.hidden),
    cleared: v.cleared,
    resolved: v.resolved,
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
  const mods = [e.metaKey && (mac ? "CommandOrControl" : "Super"), e.ctrlKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift"];
  return [...mods.filter(Boolean), key].join("+");
}

// Errors that `gh auth login` fixes, e.g. "GitHub rejected the token (HTTP 401)".
export const authProblem = (error: string) => /\b(401|token|bad credentials|unauthori[sz]ed|gh auth)\b/i.test(error);

// ---------------------------------------------------------------- the policy judge and the coordinator

const PAST: Record<string, string> = {
  snooze: "snoozed",
  done: "cleared",
  mute: "muted",
  unmute: "unmuted",
  pin: "pinned",
  unpin: "unpinned",
  restore: "restored",
};
const past = (action: string | null) => PAST[action ?? ""] ?? action ?? "acted on";
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sentence = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? "" : "."}`;
// "5m": how long until `at`.
const until = (at: string, now: number) => ago(new Date(2 * now - Date.parse(at)).toISOString(), now).replace(/ ago$/, "");

// The judge's step in a rule trace, after "policy": as src/judge.ts's judgeText says it to agents.
export function judgeStepText(j: JudgeStep): string {
  if (j.bucket === null) return j.pending ? "not judged yet, so the board default" : "no answer, so the board default";
  const why = j.why || "it says nothing about this item";
  return `${BUCKET_LABEL[j.bucket].toLowerCase()}, ${why}${j.pending ? " (judged before the latest activity)" : ""}`;
}

// "snoozed 3 FYI items", "snoozed 2 items and muted 1": the top bar's line, after "Coordinator".
export function actedText(a: CoordinatorActed): string {
  const parts = Object.entries(a.counts).sort((x, y) => y[1] - x[1]);
  const [first] = parts;
  if (!first) return "";
  const [bucket] = a.buckets;
  const where = parts.length === 1 && bucket && bucket !== "hide" && a.buckets.every((b) => b === bucket) ? `${BUCKET_LABEL[bucket]} ` : "";
  const head = `${past(first[0])} ${first[1]} ${where}${first[1] === 1 ? "item" : "items"}`;
  const all = [head, ...parts.slice(1).map(([action, n]) => `${past(action)} ${n}`)];
  return all.length === 1 ? head : `${all.slice(0, -1).join(", ")} and ${all.at(-1)!}`;
}

// One line of the coordinator's log.
export function logText(e: CoordinatorLogEntry): string {
  if (e.kind === "act") {
    const what = `${sentence(past(e.action)).slice(0, -1)} ${e.item_id ? shortId(e.item_id) : "an item"}`;
    return e.text ? `${what}: ${e.text}` : what;
  }
  return e.kind === "run" && e.run ? `Run ${e.run}: ${e.text.charAt(0).toLowerCase()}${e.text.slice(1)}` : e.text;
}

export function judgeStatusText(j: JudgeStatus, now: number): string {
  if (j.state === "off") return `Nothing is judged: ${j.off_reason ?? "it's off"}.`;
  const hour = `${j.spent} of ${j.max_per_hour} this hour.`;
  if (j.state === "error")
    return `The judge's last call failed: ${sentence(j.error ?? "unknown error")}${j.retry_at ? ` Next try in ${until(j.retry_at, now)}.` : ""}`;
  const placed = `${count(j.judged, "item")} placed by the policy${j.waiting ? `, ${j.waiting} waiting` : ""}`;
  if (j.state === "idle" && j.retry_at)
    return `${sentence(placed)} The hour's limit is reached (${j.max_per_hour}); next batch in ${until(j.retry_at, now)}.`;
  return j.state === "running" ? `Judging now. ${sentence(placed)} ${sentence(hour)}` : `${sentence(placed)} ${sentence(hour)}`;
}

export function coordinatorText(s: CoordinatorStatus, now: number): string {
  if (s.state === "off") return sentence(s.off_reason ?? "Off");
  if (s.state === "running") return `Running, started ${ago(s.running_since ?? new Date(now).toISOString(), now)}.`;
  if (s.state === "error") {
    const when = s.last_run ? ` ${ago(s.last_run.started_at, now)}` : "";
    return `Its last run failed${when}: ${sentence(s.error ?? "unknown error")}${s.next_at ? ` Next try in ${until(s.next_at, now)}.` : ""}`;
  }
  if (s.held) return "Waiting: you have it open in a terminal. It picks up the new events once you close it.";
  if (!s.started) return "It starts its session after the first sync.";
  const r = s.last_run;
  const did = r && (r.kind === "intro" ? "its first" : `${count(r.events, "event")}, ${count(r.actions, "action")}`);
  const last = r ? ` Last run ${ago(r.started_at, now)}: ${did}.` : "";
  const head =
    s.state === "waiting" ? `Waiting for things to settle${s.next_at ? `; next run in ${until(s.next_at, now)}` : ""}.` : "Idle.";
  return `${head}${last}${s.policy_empty ? " It wakes on new activity once you've written a policy." : ""}`;
}
