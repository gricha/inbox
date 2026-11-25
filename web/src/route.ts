// The window's routes: each page's hash, Settings' parts and views, and where a review goes back to.
import { Result } from "effect";
import { oneOf } from "../../src/narrow.ts";
import { SETTINGS_PARTS } from "./settings-parts.ts";

// The Inbox (`queue`: Urgent, Standard and FYI), a PR's review in its place, Blocked, your PRs in Merging, the Archive
// (what's done, snoozed, muted or hidden), and Settings (with the rules).
export type Route =
  | { name: "queue" }
  | { name: "review"; id: string }
  | { name: "inquiry"; id: string } // an agent's question
  | { name: "session"; id: string } // a session that needs you: its conversation, and your reply
  | { name: "item"; id: string } // a permalink's (src/links.ts): a PR opens in its review, an issue in place on its page
  | { name: "doc"; id: string } // a review document's page (src/doc.ts), by its link
  | { name: "log"; id: string } // an item's log: how it got where it is, and why
  | { name: "blocked" } // what can't move until something else happens
  | { name: "inflight" }
  | { name: "archive" }
  | { name: "settings"; section: string };

// A list page a review was opened from, and goes back to.
export type ListPage = "queue" | "blocked" | "inflight" | "archive";

// Settings' old section ids, still in links and habits, and the part each one's settings live in now.
const SETTINGS_ALIAS: Record<string, string> = {
  notify: "queue",
  review: "github",
  handoff: "github",
  policy: "agent", // Your policy, gone: rules and their weights sort now
  criteria: "automations", // Urgency, with your automations in Automations now
  tailscale: "network",
  lan: "network",
  appearance: "app", // its theme, in This device now
};

// The editors that open as views of their own inside Settings, by id, and the part each one's Edit row is in.
export const SETTINGS_VIEWS: Record<string, { name: string; part: string } | undefined> = {
  rules: { name: "Searches and rules", part: "github" },
};

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

export function parseRoute(hash: string): Route {
  const m = hash.match(/^#\/settings(?:\/([\w-]*(?:\/[\w-]+(?:\.[\w-]+)?)?))?\/?$/);
  if (m) return { name: "settings", section: m[1] ? (SETTINGS_ALIAS[m[1]] ?? m[1]) : SETTINGS_PARTS[0]!.id };
  if (hash === "#/rules") return { name: "settings", section: "rules" };
  if (hash === "#/inflight") return { name: "inflight" };
  if (hash === "#/blocked" || hash === "#/waiting") return { name: "blocked" };
  if (hash === "#/archive") return { name: "archive" };
  const page = /^#\/(review|inquiry|session|item|doc|log)\/(.+)$/.exec(hash);
  const name = oneOf(["review", "inquiry", "session", "item", "doc", "log"], page?.[1]);
  if (page && name) {
    const id = Result.try({ try: () => decodeURIComponent(page[2]!), catch: () => "a mangled link" });
    return Result.isSuccess(id) ? { name, id: id.success } : { name: "queue" };
  }
  return { name: "queue" };
}

// The page the sidebar marks current: a review is on the page it was opened from, a question on the Inbox; Settings is none.
export function pageOf(route: Route, from: ListPage): ListPage | null {
  if (route.name === "review") return from;
  if (route.name === "inquiry" || route.name === "session" || route.name === "item" || route.name === "doc" || route.name === "log")
    return "queue";
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

export function routeHash(r: Route): string {
  if (r.name === "settings") return `#/settings/${r.section}`;
  if ("id" in r) return `#/${r.name}/${encodeURIComponent(r.id)}`;
  return r.name === "queue" ? "#/" : `#/${r.name}`;
}
