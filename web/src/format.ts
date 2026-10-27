import type { Bucket, Card } from "../../src/types.ts";

export const shortRef = (c: { repo: string; number: number }) => `${c.repo.split("/")[1]}#${c.number}`;
export const shortId = (id: string) => id.replace(/^[^/]+\//, "");

const MIN = 60_000;

// "12m", "5h", "3d"
export function age(at: string, now: number): string {
  const m = Math.max(0, Math.round((now - Date.parse(at)) / MIN));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

// "40s ago", "5m ago"
export function ago(at: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 172_800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

// "14:30" today, "Tue 09:00" within a week, else "Nov 12 09:00"
export function when(at: string): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const days = (d.getTime() - Date.now()) / 86_400_000;
  if (d.toDateString() === new Date().toDateString()) return time;
  if (Math.abs(days) < 6) return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export function clearedText(c: Card): string {
  if (c.status === "muted") return "muted";
  if (c.status === "done") return "done until someone else acts";
  if (c.status === "snoozed") return c.snooze_until ? `snoozed until ${when(c.snooze_until)} or new activity` : "snoozed until activity";
  return "";
}

export const BUCKET_LABEL: Record<Bucket, string> = { now: "Now", today: "Today", later: "Later", fyi: "FYI", hide: "Hidden" };

export const SNOOZE: { key: string; until: string; label: string; toast: string }[] = [
  { key: "1", until: "1h", label: "1 hour", toast: "for an hour (or until new activity)" },
  { key: "2", until: "3h", label: "3 hours", toast: "for 3 hours (or until new activity)" },
  { key: "3", until: "tomorrow", label: "Tomorrow 9:00", toast: "until tomorrow 9:00 (or new activity)" },
  { key: "4", until: "monday", label: "Monday 9:00", toast: "until Monday 9:00 (or new activity)" },
  { key: "5", until: "activity", label: "Until activity", toast: "until someone acts" },
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
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) throw new Error("clipboard unavailable");
  }
}

export const cls = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" ");
