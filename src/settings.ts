// Settings: how the desk behaves, stored in settings.json (only values that differ from the default).
// Adding a setting = one entry in SETTINGS: validation, `desk settings` and its section's part of the Settings page (`more` folds it).
import fs from "node:fs";
import path from "node:path";
import { Effect, Result } from "effect";
import { parse } from "smol-toml";
import { fsError, type FsError } from "./errors.ts";
import type { ConfigError, SettingDef, SettingsSection, SettingValue } from "./types.ts";

const DEFAULT_PROMPT = `Review {item.url} by {item.author}.
Read it with \`gh pr view {item.number} --repo {item.repo}\` and \`gh pr diff {item.number} --repo {item.repo}\`.
Tell me what it changes, what looks risky, and whether I need to look closely. Draft any review comments here in chat.
Do not post, comment, approve or request changes on GitHub.`;

const DEFAULT_MINE = `Help me move my PR {item.url} forward.
Read it with \`gh pr view {item.number} --repo {item.repo} --comments\` and \`gh pr checks {item.number} --repo {item.repo}\`.
Summarize what reviewers asked for, what's failing, and what's left before it can merge. Draft replies here in chat.
Do not post, comment or push anything to GitHub.`;

const DEFAULT_ISSUE = `Look at {item.url} by {item.author}.
Read it with \`gh issue view {item.number} --repo {item.repo} --comments\`.
Tell me what's being asked of me, if anything, and draft a reply here in chat.
Do not post or comment on GitHub.`;

const ACCELERATOR =
  "^((Command|Cmd|Control|Ctrl|CommandOrControl|CmdOrCtrl|Alt|Option|AltGr|Shift|Super|Meta)\\+)+" +
  "([A-Za-z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|Plus|[-=\\[\\];',./`\\\\])$";

// The Settings page's parts in order: GitHub, where sources go, then the core's; Automations has no keys, so the page draws its part.
export const SECTIONS: SettingsSection[] = [
  { id: "github", title: "GitHub" },
  { id: "agent", title: "Claude" },
  { id: "queue", title: "Inbox and notifications" },
  { id: "automations", title: "Automations" },
  { id: "app", title: "This device" },
];

export const SETTINGS = [
  {
    key: "github.resolve_on_others_approval",
    section: "github",
    label: "Archive a review request when someone else approves",
    type: "select",
    default: "always",
    options: [
      { value: "always", label: "Always" },
      { value: "team_only", label: "Only when your team was asked" },
      { value: "never", label: "Never" },
    ],
    help: "Once no more reviews are required; it comes back if you're asked again.",
  },
  {
    key: "review.auto_ai",
    section: "github",
    label: "Claude reviews other people's PRs ahead of time",
    type: "boolean",
    default: true,
    help: "Once per commit; each joins your Inbox when its review is written.",
  },
  {
    key: "github.my_repos",
    section: "github",
    more: true,
    label: "Repos that count as yours",
    type: "list",
    default: [],
    pattern: "^[\\w.-]+/[\\w.-]+$",
    pattern_hint: "owner/name",
    help: "Their PRs and issues rank higher; repos you own count already.",
  },
  {
    key: "github.bots",
    section: "github",
    more: true,
    label: "Also treat as bots",
    type: "list",
    default: [],
    pattern: "^[\\w.-]+(\\[bot\\])?$",
    pattern_hint: "a GitHub login",
    help: "Their activity isn't news and their approval archives nothing; GitHub Apps count already.",
  },
  {
    key: "github.close_collaborator_min",
    section: "github",
    more: true,
    label: "Count someone as a close collaborator after",
    type: "number",
    default: 5,
    min: 1,
    max: 100,
    unit: "PRs",
    help: "Of theirs you reviewed or commented on in 90 days; rules call this author.close.",
  },
  {
    key: "github.poll_seconds",
    section: "github",
    more: true,
    label: "Sync with GitHub every",
    type: "number",
    default: 90,
    min: 30,
    max: 3600,
    unit: "seconds",
    help: "It waits longer by itself when GitHub's limit runs low.",
  },
  {
    key: "handoff.prompt",
    section: "github",
    more: true,
    label: "Agent prompt for someone else's PR",
    type: "text",
    default: DEFAULT_PROMPT,
    required: true,
    help: "Fields like {item.url}, {item.number} and {item.author} are filled in; leave titles out: anyone writes them.",
  },
  {
    key: "handoff.mine",
    section: "github",
    more: true,
    label: "Agent prompt for your PR",
    type: "text",
    default: DEFAULT_MINE,
    required: true,
  },
  {
    key: "handoff.issue",
    section: "github",
    more: true,
    label: "Agent prompt for an issue",
    type: "text",
    default: DEFAULT_ISSUE,
    required: true,
  },
  {
    key: "policy.judge",
    section: "agent",
    label: "Sort my desk with Claude",
    type: "boolean",
    default: true,
    help: "Claude places each item by your policy; off, only your rules do.",
  },
  {
    key: "agent.coordinator",
    section: "agent",
    label: "Run your agent",
    type: "boolean",
    default: true,
    help: "A Claude Code session that answers Ask your agent and gets what you hand off merged.",
  },
  {
    key: "agent.coordinator_bypass",
    section: "agent",
    label: "Let your agent run without asking",
    type: "boolean",
    default: true,
    help: "Match your own sessions so messages between them arrive; it still can't post as you.",
  },
  {
    key: "policy.max_per_hour",
    section: "agent",
    label: "Let Claude sort up to",
    type: "number",
    default: 300,
    min: 1,
    max: 1000,
    unit: "items an hour",
    help: "On your own Claude Code login, 20 items a call.",
  },
  {
    key: "queue.quiet_days",
    section: "queue",
    label: "Move untouched items to FYI after",
    type: "number",
    default: 14,
    min: 0,
    max: 365,
    unit: "days",
    help: "Except pinned items, recent review requests and what your rules hold there; 0 keeps all.",
  },
  {
    key: "queue.cards",
    section: "queue",
    label: "Show the first",
    type: "number",
    default: 10,
    min: 0,
    max: 100,
    unit: "items",
    help: "The rest fold behind one line you can open; 0 shows them all.",
  },
  {
    key: "notify.enabled",
    section: "queue",
    label: "Notify me when something needs me",
    type: "boolean",
    default: true,
    help: "New Inbox items, agents' questions, your agent's answers and automations' results.",
  },
  {
    key: "notify.quiet",
    section: "queue",
    label: "Quiet hours",
    type: "string",
    default: "19:00-09:00",
    placeholder: "19:00-09:00",
    pattern: "^\\d{1,2}:\\d{2}-\\d{1,2}:\\d{2}$",
    pattern_hint: "like 19:00-09:00",
    help: "No notifications between these times, every day, in this computer's time.",
  },
  {
    key: "app.hotkey",
    section: "app",
    label: "Shortcut to show or hide the window",
    type: "hotkey",
    default: "Control+Alt+D",
    placeholder: "Control+Alt+D",
    pattern: ACCELERATOR,
    pattern_hint: "modifiers and a key, like Control+Alt+D",
    help: "From any app, while the desktop app runs.", // until the app says whether it took it (Settings.tsx)
  },
  { key: "app.open_at_login", section: "app", label: "Open at login", type: "boolean", default: false },
  { key: "app.menu_bar_count", section: "app", label: "Show the Inbox count in the menu bar", type: "boolean", default: true },
  {
    key: "app.source",
    section: "app",
    label: "Run from a checkout",
    type: "string",
    default: "",
    help: "A Review Desk clone, npm install done; changing it restarts the app.",
  },
] as const satisfies readonly SettingDef[];

type ValueOf<T> = T extends "number" ? number : T extends "boolean" ? boolean : T extends "list" ? string[] : string;
export type Settings = { [D in (typeof SETTINGS)[number] as D["key"]]: ValueOf<D["type"]> };

const DEFS = new Map<string, SettingDef>(SETTINGS.map((d) => [d.key, d]));
export const settingDef = (key: string) => DEFS.get(key);
export const DEFAULTS = Object.fromEntries(SETTINGS.map((d) => [d.key, d.default])) as unknown as Settings;

// Returns an error message, or null when `value` is valid for `key`.
export function checkSetting(key: string, value: unknown): string | null {
  const d = DEFS.get(key);
  if (!d) return `unknown setting "${key}"`;
  const re = d.pattern ? new RegExp(d.pattern) : null;
  switch (d.type) {
    case "number":
      if (typeof value !== "number" || !Number.isInteger(value)) return "must be a whole number";
      if (d.min !== undefined && value < d.min) return `must be at least ${d.min}`;
      if (d.max !== undefined && value > d.max) return `must be at most ${d.max}`;
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false";
    case "list": {
      if (!Array.isArray(value) || !value.every((v): v is string => typeof v === "string")) return "must be a list of strings";
      const bad = re && value.find((v) => !re.test(v));
      return bad === undefined || bad === null ? null : `"${bad}" isn't ${d.pattern_hint ?? "valid"}`;
    }
    case "select":
      return d.options?.some((o) => o.value === value) ? null : `must be one of ${d.options?.map((o) => o.value).join(", ")}`;
    case "string":
    case "text":
    case "hotkey":
      if (typeof value !== "string") return "must be a string";
      if (!value.trim()) return d.required ? "can't be empty" : null;
      return re && !re.test(value) ? `must be ${d.pattern_hint ?? `like ${d.placeholder}`}` : null;
  }
  throw new Error("unknown setting type");
}

// Settings that no longer exist: ignored when read, but kept in the file, so an older desk still sees the owner's choice.
const REMOVED = new Set([
  "analyze.model",
  "analyze.command",
  "agent.driver",
  "queue.now_cards",
  "queue.today_cards",
  "coordinator.enabled",
  "inflight.babysit",
  "inflight.auto_merge",
  "inflight.max_agents",
  "inflight.trusted_bots",
  "inflight.repos",
  "inflight.clone_roots",
]);

// What settings.json holds. Bad entries fall back to their defaults; `raw` keeps them (null if unusable) so a save doesn't drop them.
// `text` is what was read, so a watcher can tell a change: "" for no file, null for one that couldn't be read.
export interface SettingsFile {
  overrides: Record<string, SettingValue>;
  errors: ConfigError[];
  raw: Record<string, unknown> | null;
  text: string | null;
}

const unusable = (message: string, text: string | null): SettingsFile => ({
  overrides: {},
  errors: [{ path: "settings.json", message }],
  raw: null,
  text,
});

function settingsFrom(text: string): SettingsFile {
  const parsed = Result.try({ try: (): unknown => JSON.parse(text), catch: (e) => (e as Error).message });
  if (Result.isFailure(parsed)) return unusable(parsed.failure, text);
  const raw = parsed.success;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return unusable("must be a JSON object", text);
  const overrides: Record<string, SettingValue> = {};
  const errors: ConfigError[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (REMOVED.has(k)) continue;
    const err = checkSetting(k, v);
    if (err) errors.push({ path: k, message: err });
    else overrides[k] = v as SettingValue;
  }
  return { overrides, errors, raw: raw as Record<string, unknown>, text };
}

// Reads settings.json, none yet being no overrides. Only reading it fails: what's in it is checked entry by entry.
export const loadSettings = (file: string): Effect.Effect<SettingsFile, FsError> =>
  Effect.suspend((): Effect.Effect<SettingsFile, FsError> =>
    fs.existsSync(file)
      ? Effect.try({ try: () => fs.readFileSync(file, "utf8"), catch: fsError("read", file) }).pipe(Effect.map(settingsFrom))
      : Effect.succeed({ overrides: {}, errors: [], raw: {}, text: "" }),
  );

// For what reads it synchronously and goes on regardless (the desk starting, the desktop app): one it can't read is a
// problem on settings.json, like one that isn't JSON, and nothing a save may write over.
export const readSettings = (file: string): SettingsFile =>
  Effect.runSync(loadSettings(file).pipe(Effect.catch((e) => Effect.succeed(unusable(e.message, null)))));

export const effective = (overrides: Record<string, SettingValue>): Settings => ({ ...DEFAULTS, ...overrides });

// Through a temporary file and a rename, so a reader never sees half of it, and through a symlinked settings.json.
export const writeSettings = Effect.fn("writeSettings")(function* (file: string, values: Record<string, unknown>) {
  const real = fs.existsSync(file) ? yield* Effect.try({ try: () => fs.realpathSync(file), catch: fsError("realpath", file) }) : file;
  const sorted = Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
  const tmp = `${real}.${process.pid}.tmp`;
  const text = JSON.stringify(sorted, null, 2) + "\n";
  yield* Effect.try({
    try: () => {
      fs.writeFileSync(tmp, text);
    },
    catch: fsError("write", tmp),
  });
  yield* Effect.try({
    try: () => {
      fs.renameSync(tmp, real);
    },
    catch: fsError("rename", real),
  });
}, Effect.uninterruptible);

// ---------------------------------------------------------------- moving settings out of config.toml

// Where each pre-settings config.toml key lives now.
const LEGACY: Record<string, string> = {
  poll_seconds: "github.poll_seconds",
  "signals.close_collaborator_min": "github.close_collaborator_min",
  "signals.bots": "github.bots",
  "signals.my_repos": "github.my_repos",
  "notify.enabled": "notify.enabled",
  "notify.quiet": "notify.quiet",
  "handoff.prompt": "handoff.prompt",
  "handoff.mine": "handoff.mine",
  "handoff.issue": "handoff.issue",
};
export const LEGACY_TABLES = ["signals", "notify", "handoff", "analyze"];

const toml = (text: string): Result.Result<Record<string, unknown>, unknown> => Result.try({ try: () => parse(text), catch: (e) => e });

// Pulls the old settings out of config.toml text. `text` is null when they couldn't be removed cleanly.
export function migrateLegacy(configText: string): { moved: Record<string, SettingValue>; text: string | null } | null {
  const parsed = toml(configText);
  if (Result.isFailure(parsed)) return null; // parseConfig reports it
  const raw = parsed.success;
  if (!("poll_seconds" in raw) && !LEGACY_TABLES.some((t) => t in raw)) return null;
  const moved: Record<string, SettingValue> = {};
  for (const [old, key] of Object.entries(LEGACY)) {
    const [a = "", b] = old.split(".");
    const v = b === undefined ? raw[a] : (raw[a] as Record<string, unknown> | undefined)?.[b];
    if (v === undefined) continue;
    // TOML's """ strings end with a newline the defaults don't have.
    const value =
      typeof v === "string" ? v.trimEnd() : key === "github.poll_seconds" && typeof v === "number" ? Math.max(30, Math.round(v)) : v;
    if (checkSetting(key, value) === null && JSON.stringify(value) !== JSON.stringify(settingDef(key)!.default))
      moved[key] = value as SettingValue;
  }

  // Drop `poll_seconds = …` and the legacy tables, line by line, minding multi-line strings.
  const out: string[] = [];
  let skipping = false;
  let inString = false;
  let seenTable = false;
  let trailing: string[] = []; // comments after a skipped table's last key describe the next table
  for (const line of configText.split("\n")) {
    const header = !inString && /^\s*\[/.test(line);
    if (header) {
      seenTable = true;
      skipping = new RegExp(`^\\s*\\[\\s*(${LEGACY_TABLES.join("|")})\\s*\\]\\s*(#.*)?$`).test(line);
      if (!skipping) out.push(...trailing);
      trailing = [];
    } else if (skipping) {
      trailing = !inString && /^\s*(#.*)?$/.test(line) ? [...trailing, line] : [];
    }
    const drop = skipping || (!inString && !seenTable && /^\s*poll_seconds\s*=/.test(line));
    if ((line.match(/"""|'''/g) ?? []).length % 2 === 1) inString = !inString;
    if (!drop) out.push(line);
  }
  const text = out
    .join("\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "");
  const reparsed = toml(text);
  if (Result.isFailure(reparsed)) return { moved, text: null };
  const after = reparsed.success;
  const same = JSON.stringify([raw.spaces, raw.boards]) === JSON.stringify([after.spaces, after.boards]);
  const clean = !("poll_seconds" in after) && !LEGACY_TABLES.some((t) => t in after);
  return { moved, text: same && clean ? text : null };
}

export const settingsPath = (home: string) => path.join(home, "settings.json");
