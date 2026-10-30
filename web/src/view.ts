import type { Card, QueueView, ReviewFile, ReviewNote, SettingDef, SettingValue } from "../../src/types.ts";
import { shortRef } from "./format.ts";

// One surface (the queue), a PR's review in its place, and Settings, whose sections include the rules editor.
export type Route = { name: "queue" } | { name: "review"; id: string } | { name: "settings"; section: string };
export type GroupKey = "now" | "today" | "later" | "fyi" | "hidden" | "cleared";
export type Variant = "active" | "hidden" | "cleared";

export interface Group {
  key: GroupKey;
  label: string;
  cards: Card[]; // after the filter
  total: number; // before the filter
  open: boolean;
  forced: boolean; // opened by the filter, not by you
  variant: Variant;
}

export const SORTED_AWAY: GroupKey[] = ["later", "fyi", "hidden", "cleared"];

export function parseRoute(hash: string): Route {
  const m = hash.match(/^#\/settings(?:\/([\w-]*))?\/?$/);
  if (m) return { name: "settings", section: m[1] === undefined || m[1] === "" ? "github" : m[1] };
  if (hash === "#/rules") return { name: "settings", section: "rules" };
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

export const routeHash = (r: Route) =>
  r.name === "settings" ? `#/settings/${r.section}` : r.name === "review" ? `#/review/${encodeURIComponent(r.id)}` : "#/";

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

// Which file the reader is in: the last one whose top has scrolled past the line under the top bar.
export function currentFile(tops: number[], line: number): number {
  let cur = 0;
  for (const [i, top] of tops.entries()) if (top <= line) cur = i;
  return cur;
}

const matches = (c: Card, q: string) =>
  !q || `${c.title}\n${c.repo}\n${c.author}\n${shortRef(c)}`.toLowerCase().includes(q.trim().toLowerCase());

export const DEFAULT_OPEN: Record<GroupKey, boolean> = { now: true, today: true, later: false, fyi: false, hidden: false, cleared: false };

const LABEL: Record<GroupKey, string> = {
  now: "Now",
  today: "Today",
  later: "Later",
  fyi: "FYI",
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
