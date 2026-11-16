// The window's notices: what's wrong with the system (the desk, your agent, the sync, your rules), as bubbles at the
// window's edge rather than lines in a page. Each comes from what the desk reports, so the tray and MCP agree; which
// you dismissed is this device's.
import type { Overview, Paused, SourceStatus } from "../../src/types.ts";
import { tilde, when } from "./format.ts";

// The one thing that fixes it: a page to open, or a press the window runs.
export type Fix = { label: string; href: string } | { label: string; run: "retry" | "sync" };

export interface Notice {
  id: string; // one per condition, so a dismissal names it
  sig: string; // what it is now: a dismissed one comes back once this changes
  tone: "red" | "amber" | null; // failing, caution, or just so you know
  title: string;
  text?: string; // may hold `code`
  log?: string; // a stopped desk's last lines
  fix?: Fix;
  busy?: boolean; // its fix is running
  transient?: boolean; // an action failed: it fades on its own
}

export interface Conditions {
  offline: boolean;
  source: SourceStatus | null; // the desk from a checkout restarting or stopped, while it's unreachable
  starting: string | null; // the desk is up but has nothing yet
  broken: string | null; // the rules don't load
  overview: Pick<Overview, "syncing" | "sync_error" | "connectors" | "config_errors" | "rate_limit"> | null;
  paused: Paused | null;
  page: string; // the route's hash: the page that already says it hides its bubble
  agent: string; // what the window calls the agent
}

const RULES = "#/settings/rules";
const AGENT = "#/settings/agent";

// In the order they matter. While the desk is unreachable, what it said last is stale: only that it's down is said.
export function noticesOf(c: Conditions): Notice[] {
  if (c.source?.state === "running")
    return [
      {
        id: "desk",
        sig: "restarting",
        tone: null,
        title: "Restarting the desk",
        text: `With the latest changes in \`${tilde(c.source.dir)}\`.`,
      },
    ];
  if (c.source?.state === "failed")
    return [
      {
        id: "desk",
        sig: "stopped",
        tone: "red",
        title: "The desk stopped",
        text: `The desk in \`${tilde(c.source.dir)}\` starts again on the next change under src/ or after npm install.`,
        ...(c.source.detail ? { log: c.source.detail } : {}),
      },
    ];
  if (c.offline)
    return [
      {
        id: "desk",
        sig: "offline",
        tone: "red",
        title: "The desk isn't running",
        text: "Start it with `desk serve` or open the desktop app.",
        fix: { label: "Retry", run: "retry" },
      },
    ];
  if (c.starting !== null)
    return [
      { id: "desk", sig: "starting", tone: null, title: "The desk is starting", text: c.starting, fix: { label: "Retry", run: "retry" } },
    ];

  const out: Notice[] = [];
  const onRules = c.page === RULES;
  const errors = c.overview?.config_errors.length ?? 0;
  if (c.broken !== null && !onRules)
    out.push({
      id: "rules",
      sig: "broken",
      tone: "red",
      title: "Your rules don't load",
      text: `There's nothing on your desk until they do. ${c.broken.replace(/^config has errors:\s*/, "")}`,
      fix: { label: "Fix rules", href: RULES },
    });
  else if (errors > 0 && c.broken === null && !onRules)
    out.push({
      id: "rules",
      sig: `errors:${errors}`,
      tone: "amber",
      title: `Your rules have ${errors} ${errors === 1 ? "error" : "errors"}`,
      text: "Your desk uses the last version that worked.",
      fix: { label: "Fix rules", href: RULES },
    });

  if (c.paused && c.page !== AGENT)
    out.push({
      id: "agent",
      sig: c.paused.who,
      tone: "red",
      title: c.paused.who === "claude" ? `${c.agent} is paused` : "AI reviews are paused",
      text: c.paused.why,
      fix: { label: "Open Settings → Agent", href: AGENT },
    });

  // The last sync failed or hit GitHub's rate limit. Rate limited has no fix: the desk skips every sync until the limit
  // resets, so a retry would only seem to run. A sync under way after a failure keeps it, its fix running.
  const o = c.overview;
  if (o?.sync_error && o.connectors.some((x) => x.status === "paused")) {
    const reset = o.rate_limit?.reset_at;
    out.push({
      id: "sync",
      sig: "limited",
      tone: "amber",
      title: "GitHub's rate limit is used up",
      text: reset ? `Syncing starts again at ${when(reset)}.` : o.sync_error,
    });
  } else if (o?.sync_error)
    out.push({
      id: "sync",
      sig: "failed",
      tone: "red",
      title: "Sync failed",
      text: o.sync_error,
      fix: { label: o.syncing ? "Syncing…" : "Try again", run: "sync" },
      busy: o.syncing,
    });
  return out;
}

// What you dismissed: a condition's id and what it was then.
export type Dismissed = Record<string, string>;

export const undismissed = (ns: readonly Notice[], dismissed: Dismissed): Notice[] => ns.filter((n) => dismissed[n.id] !== n.sig);

// Only dismissals that still match what's there: one resolved, or changed, shows again when it next comes.
export function forget(ns: readonly Notice[], dismissed: Dismissed): Dismissed {
  const keep: Dismissed = {};
  for (const n of ns) if (dismissed[n.id] === n.sig) keep[n.id] = n.sig;
  return Object.keys(keep).length === Object.keys(dismissed).length ? dismissed : keep;
}

// An action that failed: one bubble per message, the newest last, at most three.
export function withFailure(list: readonly Notice[], text: string, at: number): Notice[] {
  const rest = list.filter((n) => n.title !== text);
  return [...rest, { id: `failed:${at}`, sig: text, tone: "red" as const, title: text, transient: true }].slice(-3);
}
