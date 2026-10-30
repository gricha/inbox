// Settings: how the desk behaves, stored in settings.json (only values that differ from the default).
// Adding a setting = one entry in SETTINGS; the Settings page, validation and `desk settings` pick it up.
import fs from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
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

export const SECTIONS: SettingsSection[] = [
  {
    id: "github",
    title: "GitHub",
    help: "Read through the gh CLI's login (or GITHUB_TOKEN). Review Desk writes to GitHub only when you approve a PR.",
  },
  { id: "agent", title: "Agents" },
  { id: "policy", title: "Policy", help: "Prose guidance the judge and the coordinator follow." },
  { id: "notify", title: "Notifications" },
  { id: "app", title: "Desktop app", help: "Only the desktop app uses these." },
  {
    id: "inflight",
    title: "In flight",
    help: "Your own PRs you've marked done with d. A babysitter (Claude Code, in a worktree of your local clone) fixes red CI, merges the base in on a conflict, and drafts replies to reviewers for you to send. It pushes only to the PR's own branch, never force-pushes, and never posts to GitHub.",
  },
  {
    id: "review",
    title: "AI review",
    help: "Your agent (Agents above) reads a PR's diff and writes a summary, concerns and notes on the changes. It sends the diff to whichever account that CLI is logged in to.",
  },
  {
    id: "handoff",
    title: "Hand-off prompts",
    help: "Pressing c on an item copies one of these, ready to paste into a Claude session. Fields like {item.url}, {item.number}, {item.repo} and {item.author} are filled in. Keep PR titles out: they are untrusted text.",
  },
];

export const SETTINGS = [
  { key: "github.poll_seconds", section: "github", label: "Sync every (seconds)", type: "number", default: 90, min: 30, max: 3600 },
  {
    key: "github.close_collaborator_min",
    section: "github",
    label: "Close collaborator after",
    type: "number",
    default: 3,
    min: 1,
    max: 100,
    help: "author.close is true when you reviewed or commented on at least this many of their PRs in 90 days.",
  },
  {
    key: "github.bots",
    section: "github",
    label: "Also treat as bots",
    type: "list",
    default: [],
    pattern: "^[\\w.-]+(\\[bot\\])?$",
    pattern_hint: "a GitHub login",
    help: "Logins. GitHub Apps are detected automatically.",
  },
  {
    key: "github.my_repos",
    section: "github",
    label: "Repos that count as yours",
    type: "list",
    default: [],
    pattern: "^[\\w.-]+/[\\w.-]+$",
    pattern_hint: "owner/name",
    help: "repo.mine is true for these. Repos you own count automatically.",
  },
  {
    key: "github.resolve_on_others_approval",
    section: "github",
    label: "Resolve when someone else approves",
    type: "select",
    default: "always",
    options: [
      { value: "always", label: "Always" },
      { value: "team_only", label: "Only when your team was asked" },
      { value: "never", label: "Never" },
    ],
    help: "A PR you were asked to review moves to Resolved once someone else approves it after the ask and no more reviews are required. It comes back if you're asked again.",
  },
  {
    key: "agent.driver",
    section: "agent",
    label: "Main agent",
    type: "select",
    default: "claude-code",
    options: [
      { value: "claude-code", label: "Claude Code" },
      { value: "codex", label: "Codex" },
      { value: "none", label: "None" },
    ],
    help: "The agent you work in. Review Desk connects to it: its MCP tools and the Review Desk skill.",
  },
  {
    key: "coordinator.enabled",
    section: "agent",
    label: "Coordinator",
    type: "boolean",
    default: true,
    help: "A Claude Code session the desk wakes when something happens. It keeps the queue clean by your policy with local, undoable actions, and edits the policy and rules when you ask it to. It never writes to GitHub.",
  },
  {
    key: "policy.judge",
    section: "policy",
    label: "Let the agent place what your rules leave open",
    type: "boolean",
    default: true,
    help: "Items no rule matched, and items a rule sends to judge, go to your agent with the policy, 20 at a time. Until it answers they use the board's default. Nothing is judged while the policy is empty.",
  },
  {
    key: "policy.max_per_hour",
    section: "policy",
    label: "Items it may judge per hour",
    type: "number",
    default: 60,
    min: 1,
    max: 1000,
  },
  { key: "notify.enabled", section: "notify", label: "Notify me when something new lands in Now", type: "boolean", default: true },
  {
    key: "notify.quiet",
    section: "notify",
    label: "Quiet hours",
    type: "string",
    default: "19:00-09:00",
    placeholder: "19:00-09:00",
    pattern: "^\\d{1,2}:\\d{2}-\\d{1,2}:\\d{2}$",
    pattern_hint: "like 19:00-09:00",
    help: "No notifications in this window. Empty for none.",
  },
  {
    key: "app.hotkey",
    section: "app",
    label: "Show / hide hotkey",
    type: "hotkey",
    default: "Control+Alt+D",
    placeholder: "Control+Alt+D",
    desktop: true,
    pattern: ACCELERATOR,
    pattern_hint: "modifiers and a key, like Control+Alt+D",
    help: "Works from any app. Empty turns it off.",
  },
  { key: "app.open_at_login", section: "app", label: "Open at login", type: "boolean", default: false, desktop: true },
  { key: "app.menu_bar_count", section: "app", label: "Show counts in the menu bar", type: "boolean", default: true, desktop: true },
  {
    key: "inflight.babysit",
    section: "inflight",
    label: "Babysit PRs in flight",
    type: "boolean",
    default: true,
    help: "Only PRs you marked with d. Off: they still leave the queue, and come back to Now when CI fails or reviewers ask for something.",
  },
  {
    key: "inflight.max_agents",
    section: "inflight",
    label: "Agents at once",
    type: "number",
    default: 2,
    min: 1,
    max: 5,
    help: "One per PR at most.",
  },
  {
    key: "inflight.trusted_bots",
    section: "inflight",
    label: "Bots whose comments babysitters act on",
    type: "list",
    default: [],
    pattern: "^[\\w.-]+(\\[bot\\])?$",
    pattern_hint: "a GitHub login",
    placeholder: "cursor[bot]",
    help: "Babysitters act on feedback from the repo's collaborators (owners, members, collaborators) and these bots. Anyone else's comments come back to you, in Now; their words never reach an agent.",
  },
  {
    key: "inflight.repos",
    section: "inflight",
    label: "Local clones",
    type: "list",
    default: [],
    pattern: "^[\\w.-]+/[\\w.-]+\\s*=\\s*\\S.*$",
    pattern_hint: "owner/repo = /path/to/clone",
    placeholder: "getsentry/sentry = ~/code/sentry",
    help: "Where a repo is cloned, one per line. Repos not listed are found under the folders below.",
  },
  {
    key: "inflight.clone_roots",
    section: "inflight",
    label: "Look for clones in",
    type: "list",
    default: ["~/code"],
    pattern: "^\\S.*$",
    pattern_hint: "a folder",
    help: "Folders searched two levels deep for a clone whose origin is the PR's repo.",
  },
  {
    key: "review.auto_ai",
    section: "review",
    label: "Review PRs in Now and Today ahead of time",
    type: "boolean",
    default: true,
    help: "Other people's PRs, two at a time, once per commit; a PR you open gets one too. Off: press i in a review to ask for one.",
  },
  {
    key: "analyze.command",
    section: "review",
    label: "Claude command",
    type: "string",
    default: "claude",
    required: true,
    help: "A name on PATH or an absolute path. Codex runs as codex from PATH.",
  },
  {
    key: "analyze.model",
    section: "review",
    label: "Claude model",
    type: "string",
    default: "sonnet",
    required: true,
    pattern: "^[\\w.\\[\\]-]+$",
    pattern_hint: "a model alias or id, like sonnet",
  },
  { key: "handoff.prompt", section: "handoff", label: "Someone else's PR", type: "text", default: DEFAULT_PROMPT, required: true },
  { key: "handoff.mine", section: "handoff", label: "Your PR", type: "text", default: DEFAULT_MINE, required: true },
  { key: "handoff.issue", section: "handoff", label: "An issue", type: "text", default: DEFAULT_ISSUE, required: true },
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

// Reads settings.json. Bad entries fall back to their defaults; `raw` keeps them (null if unreadable) so a save doesn't drop them.
export function readSettings(file: string): {
  overrides: Record<string, SettingValue>;
  errors: ConfigError[];
  raw: Record<string, unknown> | null;
} {
  if (!fs.existsSync(file)) return { overrides: {}, errors: [], raw: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { overrides: {}, errors: [{ path: "settings.json", message: (e as Error).message }], raw: null };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { overrides: {}, errors: [{ path: "settings.json", message: "must be a JSON object" }], raw: null };
  const overrides: Record<string, SettingValue> = {};
  const errors: ConfigError[] = [];
  for (const [k, v] of Object.entries(raw)) {
    const err = checkSetting(k, v);
    if (err) errors.push({ path: k, message: err });
    else overrides[k] = v as SettingValue;
  }
  return { overrides, errors, raw: raw as Record<string, unknown> };
}

export const effective = (overrides: Record<string, SettingValue>): Settings => ({ ...DEFAULTS, ...overrides });

export function writeSettings(file: string, values: Record<string, unknown>): void {
  const real = fs.existsSync(file) ? fs.realpathSync(file) : file; // keep a symlinked settings.json a symlink
  const sorted = Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
  const tmp = `${real}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sorted, null, 2) + "\n");
  fs.renameSync(tmp, real);
}

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
  "analyze.command": "analyze.command",
  "analyze.model": "analyze.model",
};
export const LEGACY_TABLES = ["signals", "notify", "handoff", "analyze"];

// Pulls the old settings out of config.toml text. `text` is null when they couldn't be removed cleanly.
export function migrateLegacy(configText: string): { moved: Record<string, SettingValue>; text: string | null } | null {
  let raw: Record<string, unknown>;
  try {
    raw = parse(configText);
  } catch {
    return null;
  }
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
  try {
    const after = parse(text) as Record<string, unknown>;
    const same = JSON.stringify([raw.spaces, raw.boards]) === JSON.stringify([after.spaces, after.boards]);
    const clean = !("poll_seconds" in after) && !LEGACY_TABLES.some((t) => t in after);
    return { moved, text: same && clean ? text : null };
  } catch {
    return { moved, text: null };
  }
}

export const settingsPath = (home: string) => path.join(home, "settings.json");
