// Pure helpers for the desktop app: no electron import, so node --test can load them.
import { DEFAULTS } from "../src/settings.ts";

// ---------------------------------------------------------------- PATH

const MARK = "__DESK_PATH__";

// GUI launches get a bare PATH. printenv prints the exported PATH colon-joined in any shell (fish too).
export const SHELL_PATH_COMMAND = `printf '${MARK}'; printenv PATH; printf '${MARK}'`;

// The PATH between the markers, ignoring whatever the shell's rc files print around it.
export function parseShellPath(out: string): string | null {
  const m = out.match(new RegExp(`${MARK}([^]*?)${MARK}`));
  const p = m?.[1]?.trim() ?? "";
  return p === "" ? null : p;
}

export const fallbackDirs = (home: string): string[] => ["/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`, `${home}/bin`];

// Joins PATH strings and dirs in order, dropping empties and repeats.
export function mergePath(sep: string, ...parts: string[]): string {
  const seen = new Set<string>();
  for (const part of parts) for (const dir of part.split(sep)) if (dir) seen.add(dir);
  return [...seen].join(sep);
}

// An empty variable (DESK_HOME=) counts as unset.
export const envVar = (name: string): string | undefined => (process.env[name] === "" ? undefined : process.env[name]);

// ---------------------------------------------------------------- attach or start

export type Probe = { kind: "desk" } | { kind: "free" } | { kind: "other"; detail: string };

// What answers on the desk's port: a desk (attach), nothing (start one), or something else.
export async function probeHealth(base: string, timeoutMs = 1000, fetchFn: typeof fetch = fetch): Promise<Probe> {
  try {
    const res = await fetchFn(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    return res.ok && body?.ok === true ? { kind: "desk" } : { kind: "other", detail: `HTTP ${res.status} on /health` };
  } catch (e) {
    const code = (e as { cause?: { code?: string } }).cause?.code;
    if (code === "ECONNREFUSED") return { kind: "free" };
    return { kind: "other", detail: code ?? (e as Error).message };
  }
}

export const backoff = (attempt: number): number => Math.min(30_000, 1000 * 2 ** attempt);

// ---------------------------------------------------------------- SSE

export interface SSEvent {
  event: string;
  data: string;
}

// Complete events in `buf`, plus the unfinished tail to prepend to the next chunk.
export function parseSSE(buf: string): { events: SSEvent[]; rest: string } {
  const blocks = buf.replaceAll(/\r\n?/g, "\n").split("\n\n");
  const rest = blocks.pop() ?? "";
  const events: SSEvent[] = [];
  for (const block of blocks) {
    let event = "message";
    const data: string[] = [];
    let any = false;
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
      else continue;
      any = true;
    }
    if (any) events.push({ event, data: data.join("\n") });
  }
  return { events, rest };
}

// ---------------------------------------------------------------- settings

export interface DesktopSettings {
  hotkey: string;
  open_at_login: boolean;
  menu_bar_count: boolean;
}

// An older desk may not know the app.* settings; fall back to the defaults.
export function desktopSettings(values?: Record<string, unknown>): DesktopSettings {
  const v = { ...DEFAULTS, ...values } as Record<string, unknown>;
  return {
    hotkey: typeof v["app.hotkey"] === "string" ? v["app.hotkey"] : DEFAULTS["app.hotkey"],
    open_at_login: v["app.open_at_login"] === true,
    menu_bar_count: v["app.menu_bar_count"] !== false,
  };
}

// ---------------------------------------------------------------- tray text

// "desk 7 ●2 +3" -> "7 ●2 +3"
export const trayTitle = (statusText: string): string => statusText.replace(/^desk\s*/, "");

export const trayTooltip = (s: { now: number; today: number } | null): string =>
  s ? `Review Desk: ${s.now + s.today} in the queue${s.now ? `, ${s.now} urgent` : ""}` : "Review Desk";

// Menus read a single & as a mnemonic marker; cut first so && is never split.
export function menuLabel(text: string, max = 60): string {
  // oxlint-disable-next-line typescript/no-misused-spread -- code points on purpose: the cut must not split a surrogate pair
  const chars = [...text.replaceAll(/\s+/g, " ").trim()];
  const cut =
    chars.length > max
      ? chars
          .slice(0, max - 1)
          .join("")
          .trimEnd() + "…"
      : chars.join("");
  return cut.replaceAll("&", "&&");
}

export const cardLabel = (c: { repo: string; number: number; title: string }): string =>
  menuLabel(`${c.repo.split("/").pop()}#${c.number} ${c.title}`);

// ---------------------------------------------------------------- URLs

const parse = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

export const isAppUrl = (url: string, origins: string[]): boolean => origins.includes(parse(url)?.origin ?? "");
export const isHttpUrl = (url: string): boolean => ["http:", "https:"].includes(parse(url)?.protocol ?? "");
export const isHttpsUrl = (url: string): boolean => parse(url)?.protocol === "https:";
export const isGitHubUrl = (url: string): boolean => {
  const u = parse(url);
  return u?.protocol === "https:" && u.host === "github.com";
};

// ---------------------------------------------------------------- window bounds

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Saved bounds, or just the saved size when its spot is off every screen (a display was unplugged).
export function restoreBounds(saved: Partial<Bounds> | null, screens: Bounds[], def: { width: number; height: number }): Partial<Bounds> {
  const width = typeof saved?.width === "number" ? saved.width : def.width;
  const height = typeof saved?.height === "number" ? saved.height : def.height;
  if (typeof saved?.x !== "number" || typeof saved?.y !== "number") return { width, height };
  const px = saved.x + width / 2;
  const py = saved.y + 10; // the title bar has to be reachable
  const onScreen = screens.some((s) => px >= s.x && px < s.x + s.width && py >= s.y && py < s.y + s.height);
  return onScreen ? { x: saved.x, y: saved.y, width, height } : { width, height };
}

// ---------------------------------------------------------------- Linux autostart

// Desktop Entry Exec quoting, then the file's own escaping of backslashes; % is a field code.
export function desktopEntry(exec: string, args: string[]): string {
  const quote = (s: string) => (/[\s"'\\`$<>|;&*?#()]/.test(s) ? `"${s.replaceAll(/(["`$\\])/g, "\\$1")}"` : s);
  const cmd = [exec, ...args].map(quote).join(" ").replaceAll("\\", "\\\\").replaceAll("%", "%%");
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Review Desk",
    "Comment=Your GitHub review queue",
    `Exec=${cmd}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}
