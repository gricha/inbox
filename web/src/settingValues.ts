// Settings' values: when a row shows, a field's text and keys, a config error's line, the judge's words.
import type { JudgeStatus, JudgeStep, SettingDef, SettingsView, SettingValue } from "../../src/types.ts";
import { ago, aiName, BUCKET_LABEL } from "./format.ts";

// The desktop app's bridge as far as Settings' rows care (window.desktop): absent in a browser.
type Shell = { platform: string } | undefined;

type Values = Record<string, SettingValue>;

const inApp = (_: Values, app: Shell) => app !== undefined;

// Settings' rows that would do nothing here aren't drawn, by key; `inbox settings` and settings.json still set them.
export const SHOWN: Record<string, ((values: Values, app: Shell) => boolean) | undefined> = {
  "agent.coordinator_bypass": (v) => v["agent.coordinator"] !== false,
  "agent.coordinator_model": (v) => v["agent.coordinator"] !== false,
  "agent.coordinator_effort": (v) => v["agent.coordinator"] !== false && v["agent.harness"] !== "opencode",
  "agent.light_effort": (v) => v["agent.harness"] !== "opencode",
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

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const sentence = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? "" : "."}`;

// "5m": how long until `at`.
const until = (at: string, now: number) => ago(new Date(2 * now - Date.parse(at)).toISOString(), now).replace(/ ago$/, "");

// A rule's weight in plain words: how much Claude counts it when it sorts what the rule matches.
export function weightText(w: number): string {
  const how = w >= 9 ? "firm" : w >= 6 ? "strong" : w >= 3 ? "a lean" : "a hint";
  return `${how}, ${w}\u00a0of\u00a010`; // kept on one line
}

// The judge's step in a rule trace, after "Claude": as src/judge.ts's judgeText says it to agents.
export function judgeStepText(j: JudgeStep): string {
  if (j.bucket === null) return j.pending ? "not sorted yet, so where the rules put it" : "no answer, so where the rules put it";
  const why = j.why || "keeps the rule's why";
  const pending = j.by ? ` (${aiName()} is weighing it)` : " (an earlier answer; sorting it again)";
  return `${BUCKET_LABEL[j.bucket].toLowerCase()}, ${why}${j.pending ? pending : ""}`;
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

// What your agent is told with your words, so it changes the right thing the right way: an automation through
// inbox_automations, a criterion through inbox_criteria; a built-in one can't be edited, so it writes your own instead.
export function changeAsk(what: { kind: "automation" | "criterion"; id: string; name: string; builtIn: boolean }, words: string): string {
  const tool = what.kind === "automation" ? "inbox_automations" : "inbox_criteria";
  const it = `my ${what.kind === "automation" ? "automation" : "urgency criterion"} "${what.name}" (id ${what.id})`;
  return what.builtIn
    ? `Change ${it}: ${words}\n\nIt's built in, so it can't be edited: with ${tool}, read its definition and write my own ${what.kind} that does this instead${what.kind === "automation" ? " (it stays off until I turn it on)" : ""}. Then tell me what you wrote and whether I should switch the built-in off.`
    : `Change ${it}: ${words}\n\nWith ${tool}, read its whole definition, change only what I asked, and save it. Then tell me what you changed.`;
}
