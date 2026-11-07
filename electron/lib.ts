// Pure helpers for the desktop app: no electron import, so node --test can load them.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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

// SIGKILL to its whole group at the deadline: an interactive shell ignores SIGTERM, and what its rc files started would linger.
export function commandOutput(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const group = process.platform !== "win32";
    const child = spawn(cmd, args, { detached: group, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let stdout = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (s: string) => {
      stdout += s;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(group ? -child.pid : child.pid, "SIGKILL");
      } catch {} // already gone
      child.stdout.destroy(); // a background job that kept the pipe can't hold up close
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve({ stdout, timedOut });
    };
    child.on("error", done);
    child.on("close", done);
  });
}

// The first login shell after a boot can be slow (nvm, a cold disk), so it gets a second, longer try.
export async function loginShellPath(run: (timeoutMs: number) => Promise<string>, timeouts = [5000, 20_000]): Promise<string | null> {
  for (const timeoutMs of timeouts) {
    const p = parseShellPath(await run(timeoutMs));
    if (p) return p;
  }
  return null;
}

export interface Disk {
  isDir(p: string): boolean;
  read(p: string): string | null;
  list(p: string): string[];
}

const disk: Disk = {
  isDir: (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  read: (p) => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  list: (p) => {
    try {
      return fs.readdirSync(p);
    } catch {
      return [];
    }
  },
};

// Version managers' node dirs go after the usual ones, so gh and claude resolve exactly as before.
export function fallbackDirs(home: string, d: Disk = disk): string[] {
  const managers = [
    nvmBin(home, d),
    `${home}/.volta/bin`,
    `${home}/.local/share/mise/shims`,
    `${home}/.asdf/shims`,
    `${home}/.local/share/fnm/aliases/default/bin`,
    `${home}/Library/Application Support/fnm/aliases/default/bin`,
  ];
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    `${home}/.local/bin`,
    `${home}/bin`,
    ...managers.filter((p): p is string => p !== null && d.isDir(p)),
  ];
}

// nvm's default alias ("22", "lts/*", "node", another alias) as the newest installed version it names, else the newest installed.
function nvmBin(home: string, d: Disk): string | null {
  const root = `${home}/.nvm`;
  const installed = d
    .list(`${root}/versions/node`)
    .filter((v) => /^v\d+\.\d+\.\d+$/.test(v))
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  if (!installed.length) return null;
  let want = "default";
  for (let hops = 0; hops < 10; hops++) {
    const next = d.read(`${root}/alias/${want}`)?.trim();
    if (!next) break;
    want = next;
  }
  const version = /^v?(\d+(?:\.\d+){0,2})$/.exec(want)?.[1];
  const hit = version ? installed.find((v) => `${v.slice(1)}.`.startsWith(`${version}.`)) : undefined;
  return `${root}/versions/node/${hit ?? installed[0]}/bin`;
}

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
export async function probeHealth(base: string, timeoutMs = 1000): Promise<Probe> {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
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

// A desk's `event: notify`, which it sends to the app attached with ?notify=1 instead of notifying itself.
export function parseNotice(data: string): { title: string; body: string } | null {
  try {
    const n = JSON.parse(data) as { title?: unknown; body?: unknown };
    return typeof n.title === "string" && typeof n.body === "string" ? { title: n.title, body: n.body } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- settings

export interface DesktopSettings {
  hotkey: string;
  open_at_login: boolean;
  menu_bar_count: boolean;
  source: string;
}

// An older desk may not know the app.* settings; fall back to the defaults.
export function desktopSettings(values?: Record<string, unknown>): DesktopSettings {
  const v = { ...DEFAULTS, ...values } as Record<string, unknown>;
  return {
    hotkey: typeof v["app.hotkey"] === "string" ? v["app.hotkey"] : DEFAULTS["app.hotkey"],
    open_at_login: v["app.open_at_login"] === true,
    menu_bar_count: v["app.menu_bar_count"] !== false,
    source: typeof v["app.source"] === "string" ? v["app.source"] : "",
  };
}

// ---------------------------------------------------------------- run from a checkout

// The setting (or DESK_SOURCE) as an absolute folder; "" is off.
export function sourceDir(value: string, homedir: string): string {
  const v = value.trim();
  if (!v) return "";
  return path.resolve(v === "~" || v.startsWith("~/") ? path.join(homedir, v.slice(1)) : v);
}

// The first `node` on PATH, as an absolute path so a retry doesn't depend on the PATH it started with.
export function findNode(PATH: string, sep = path.delimiter, isFile: (p: string) => boolean = executable): string | null {
  const exe = process.platform === "win32" ? "node.exe" : "node";
  for (const dir of PATH.split(sep)) if (path.isAbsolute(dir) && isFile(path.join(dir, exe))) return path.join(dir, exe);
  return null;
}

function executable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export type DeskPlan =
  { run: "source"; node: string } | { run: "wait"; need: "checkout" | "modules" | "node"; problem: string } | { run: "in-process" };

// A chosen folder waits for what it lacks, even being a checkout, rather than fall back to the app's own desk, which may be too old for today's config.
export function deskPlan(
  dir: string,
  node: { path: string; version: string } | null,
  exists: (p: string) => boolean = fs.existsSync,
  platform: NodeJS.Platform = process.platform,
): DeskPlan {
  if (!dir) return { run: "in-process" };
  if (!exists(path.join(dir, "src", "cli.ts")) || !exists(path.join(dir, "web", "vite.config.ts")))
    return { run: "wait", need: "checkout", problem: `${dir} isn't a Review Desk checkout` };
  if (!exists(path.join(dir, "node_modules", "vite", "bin", "vite.js")))
    return { run: "wait", need: "modules", problem: `${dir} has no node_modules yet; run npm install there` };
  if (!node)
    return {
      run: "wait",
      need: "node",
      problem:
        platform === "win32" // no login shell or version-manager dirs to look in
          ? "Couldn't find node on PATH; install Node 22.18 or newer"
          : "Couldn't find node on your login shell's PATH or where nvm, Volta, mise, asdf or fnm keep it; install Node 22.18 or newer",
    };
  if (tooOld(node.version))
    return {
      run: "wait",
      need: "node",
      problem: node.version
        ? `${node.path} is Node ${node.version.trim().replace(/^v/, "")}; the desk needs 22.18 or newer`
        : `${node.path} didn't say its version; the desk needs Node 22.18 or newer`,
    };
  return { run: "source", node: node.path };
}

// package.json's engines: older Node can't run src/cli.ts as TypeScript without a flag.
const tooOld = (version: string): boolean => {
  const m = /^v?(\d+)\.(\d+)\./.exec(version.trim());
  return !m || Number(m[1]) < 22 || (Number(m[1]) === 22 && Number(m[2]) < 18);
};

// --watch-path, not node's own module tracking: a file that doesn't parse is watched too, so saving a fix restarts it.
export const DESK_ARGS = [
  "--watch",
  "--watch-path=src",
  "--watch-preserve-output",
  "--disable-warning=ExperimentalWarning",
  "src/cli.ts",
  "serve",
];
export const viteArgs = (port: number): string[] => [
  "node_modules/vite/bin/vite.js",
  "--config",
  "web/vite.config.ts",
  "--host",
  "127.0.0.1",
  "--port",
  String(port),
  "--strictPort",
];

// node --watch's own lines: a change is restarting the desk, or the desk exited and it waits for the next change.
export function watchEvent(line: string): "restart" | "exit" | null {
  if (line.startsWith("Restarting '")) return "restart";
  if (/^(Failed|Completed) running '/.test(line)) return "exit";
  return null;
}

// Both children get the desk's port and home; the desk lets in exactly the UI's origin, never DESK_DEV's localhost ports.
export function sourceEnv(env: NodeJS.ProcessEnv, o: { port: number; home: string; ui: string }): NodeJS.ProcessEnv {
  const { DESK_DEV: _dev, DESK_DEV_PORT: _devPort, DESK_SOURCE: _source, ...rest } = env;
  return { ...rest, DESK_PORT: String(o.port), DESK_HOME: o.home, DESK_UI_ORIGIN: o.ui, DESK_API: `http://127.0.0.1:${o.port}` };
}

// ---------------------------------------------------------------- tray text

// The UI's --paper and --pencil per theme (web/src/styles.css), for the window before the UI paints.
const THEME_COLORS: Record<string, { paper: string; pencil: string }> = {
  light: { paper: "#f7f7f5", pencil: "#62676f" },
  dark: { paper: "#151618", pencil: "#9599a1" },
  sand: { paper: "#f3eee5", pencil: "#73685a" },
  slate: { paper: "#1b2028", pencil: "#8e98a5" },
};

export const isTheme = (t: unknown): t is string => t === "system" || (typeof t === "string" && Object.hasOwn(THEME_COLORS, t));

// This device's theme's colours; System (or none picked yet) follows the OS.
export const themeColors = (theme: string | null, osDark: boolean): { paper: string; pencil: string } =>
  (theme && Object.hasOwn(THEME_COLORS, theme) ? THEME_COLORS[theme] : undefined) ?? THEME_COLORS[osDark ? "dark" : "light"]!;

// "desk 7 +3" -> "7 +3"
export const trayTitle = (statusText: string): string => statusText.replace(/^desk\s*/, "");

export const trayTooltip = (s: { now: number; today: number } | null): string =>
  s ? `Review Desk: ${s.now + s.today} in the Inbox` : "Review Desk";

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
// After the desk comes back, a window still on its UI keeps its view; one on the start or wait page has none to keep.
export const keepsView = (pageUrl: string, origins: string[], fromSource: boolean): boolean => !fromSource && isAppUrl(pageUrl, origins);
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
