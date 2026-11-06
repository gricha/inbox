import { COORDINATOR_NAME, UNTIL, type ActivityEvent, type Bucket, type Card, type Handoff } from "../../src/types.ts";

export const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = MAC ? "⌘" : "Ctrl+";

// What an agent's hand-off leads with: which task sent it.
export const handoffLabel = (h: Handoff) => (h.from ? `From ${h.from}:` : "Handed to you:");

// Who asks, as the window says it: the coordinator is "your agent"; every other session goes by the name it gave itself.
export const fromName = (from: string, start = true) => (from === COORDINATOR_NAME ? (start ? "Your agent" : "your agent") : from);

export const shortRef = (c: { repo: string; number: number }) => `${c.repo.split("/")[1]}#${c.number}`;
export const shortId = (id: string) => id.replace(/^[^/]+\//, "");
export const issueUrl = (id: string) => {
  const [repo, n] = id.split("#");
  return `https://github.com/${repo}/issues/${n}`; // GitHub sends a PR's number on to its pull page
};

const MIN = 60_000;

// "12m", "5h", "3d"
export function age(at: string, now: number): string {
  const m = Math.max(0, Math.round((now - Date.parse(at)) / MIN));
  if (m < 60) return `${m}m`;
  // Rounded before the switch, so 47.6h and 48.3h both read "2d".
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(m / 1440)}d`;
}

// "just now" in the first minute, then as age(): for a single time on its own, where "0m" reads like a glitch.
export const sinceText = (at: string, now: number) => (Date.parse(at) > now - 60_000 ? "just now" : age(at, now));

// "40s ago", "5m ago"
export function ago(at: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(s / 3600);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

// "14:30" today, "Tue 9:00" within a week, else "Nov 12 9:00": as the snooze menu writes it.
export function when(at: string): string {
  const d = new Date(at);
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  const days = (d.getTime() - Date.now()) / 86_400_000;
  if (d.toDateString() === new Date().toDateString()) return time;
  if (Math.abs(days) < 6) return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

// Who wrote an AI review: "claude-opus-5[1m]" → "Opus 5", "claude-sonnet-4-5-20250929" → "Sonnet 4.5", "codex" → "Codex".
export function modelName(id: string): string {
  if (id === "claude-code") return "Claude Code";
  const m = /^(?:claude-)?([a-z]+)((?:-\d{1,2})*)(?:-\d{8})?(?:\[\w+\])?$/.exec(id);
  if (!m) return id;
  const [, family = "", version = ""] = m;
  return `${family[0]!.toUpperCase()}${family.slice(1)}${version.replaceAll("-", ".").replace(/^\./, " ")}`;
}

// "snoozed until Sat 9:00 or new activity".
export function clearedText(c: Card): string {
  if (c.status === "muted") return "muted";
  if (c.status === "done") return "done until someone else acts";
  if (c.status === "snoozed" && c.snooze_when) return `snoozed until ${UNTIL[c.snooze_when]}`;
  if (c.status === "snoozed") return c.snooze_until ? `snoozed until ${when(c.snooze_until)} or new activity` : "snoozed until activity";
  return "";
}

const REVIEWED: Record<string, string> = { approved: "approved", changes_requested: "requested changes", commented: "commented" };

// One event in plain words, without its time: "alice approved", "CI went red". `me` reads as "you".
export function eventText(e: ActivityEvent, me = ""): string {
  const { data: d } = e;
  const who = me && e.actor.toLowerCase() === me.toLowerCase() ? "you" : e.actor;
  switch (e.kind) {
    case "new":
      return "first seen";
    case "review_requested":
      return `${who ? `${who} asked` : "asked"} ${d.type === "team" ? `@${String(d.reviewer)}` : "you"}`;
    case "request_removed":
      return `request to ${d.type === "team" ? `@${String(d.reviewer)}` : "you"} removed`;
    case "reviewed":
      return `${who} ${REVIEWED[String(d.state)] ?? "reviewed"}`;
    case "pushed":
      return who ? `${who} pushed` : "new commits";
    case "ci":
      return d.to === "red" ? "CI went red" : d.to === "green" ? "CI went green" : "CI started";
    case "commented":
      return `${who} commented`;
    case "merged":
      return who ? `${who} merged it` : "merged";
    case "closed":
      return "closed";
    case "reopened":
      return "reopened";
    case "mentioned":
      return d.reason === "team_mention" ? "your team was mentioned" : "you were mentioned";
    case "assigned":
      return "assigned to you";
    case "conflict":
      return d.base ? `conflicts with ${String(d.base)}` : "merge conflict";
    case "resolved":
      return `resolved: ${String(d.reason)}`;
    case "unresolved":
      return `came back (was ${String(d.was)})`;
    case "blocked":
      return `blocked by ${String(d.by)}`;
    case "unblocked":
      return d.merged
        ? `unblocked: ${String(d.merged)} merged`
        : d.closed
          ? `needs ${String(d.closed)}, closed without merging`
          : "unblocked";
  }
  return e.kind;
}

// "~/.review-desk/settings.json" rather than the full home path.
export const tilde = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+(?=\/)|^[A-Za-z]:\\Users\\[^\\]+(?=\\)/, "~");

export const BUCKET_LABEL: Record<Bucket, string> = {
  now: "Now",
  today: "Today",
  blocked: "Blocked",
  later: "Later",
  fyi: "FYI",
  hide: "Hidden",
};

export const SNOOZE: { key: string; until: string; label: string; toast: string }[] = [
  { key: "1", until: "1h", label: "1 hour", toast: "for an hour (or until new activity)" },
  { key: "2", until: "3h", label: "3 hours", toast: "for 3 hours (or until new activity)" },
  { key: "3", until: "tomorrow", label: "Tomorrow 9:00", toast: "until tomorrow 9:00 (or new activity)" },
  { key: "4", until: "monday", label: "Monday 9:00", toast: "until Monday 9:00 (or new activity)" },
  { key: "5", until: "activity", label: "Until activity", toast: "until someone acts" },
];

// The times, then what this item can wait on (6 on), as the desk says: it stays in Later until that happens.
export const snoozeOptions = (c: Card): typeof SNOOZE => [
  ...SNOOZE,
  ...(c.wake_on ?? []).map((u, i) => ({ key: String(6 + i), until: u, label: `Until ${UNTIL[u]}`, toast: `until ${UNTIL[u]}` })),
];

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs a secure, focused context; the textarea path works in more places.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    // oxlint-disable-next-line typescript/no-deprecated -- the fallback for when the Clipboard API is refused; nothing replaces it
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) throw new Error("clipboard unavailable");
  }
}

export const cls = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" ");
