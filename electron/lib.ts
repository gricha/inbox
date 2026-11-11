// Pure helpers for the desktop app: no electron import, so node --test can load them.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Cause, Data, Effect, Result } from "effect";
import { fsError, messageOf, type FsError } from "../src/errors.ts";
import { hashOf, placeOf } from "../src/links.ts";
import { Runner } from "../src/runner.ts";
import { detached, report } from "../src/sentry.ts";
import { DEFAULTS } from "../src/settings.ts";
import { themeOf } from "../src/themes.ts";

// ---------------------------------------------------------------- what the app's own calls fail with (docs/effect.md)

// The desk (or its UI's dev server) didn't answer the app (cause: fetch's error), or answered with an HTTP error. The app
// tries again, or reads it as nothing there yet.
export class DeskCallFailed extends Data.TaggedError("DeskCallFailed")<{
  readonly url: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {
  override get message(): string {
    if (this.status !== undefined) return `HTTP ${this.status}`;
    return this.cause instanceof Error ? this.cause.message : `no answer from ${this.url}`;
  }
}

// The desk this process runs didn't start, or didn't close: startServer's or close's error is the cause, and its words
// are the dialog's or the log's.
export class DeskFailed extends Data.TaggedError("DeskFailed")<{ readonly cause: unknown }> {
  override get message(): string {
    return messageOf(this.cause);
  }
}

// Electron (or the OS through it) refused: a page that didn't load, a link it didn't open, a login item it didn't set.
// cause is its error, whose words show. A load the next one superseded is ERR_ABORTED: nothing went wrong.
export class ElectronRefused extends Data.TaggedError("ElectronRefused")<{ readonly cause: unknown }> {
  get aborted(): boolean {
    const c = this.cause;
    return typeof c === "object" && c !== null && "code" in c && c.code === "ERR_ABORTED";
  }
  override get message(): string {
    return messageOf(this.cause);
  }
}

// No port for the UI's dev server: the OS wouldn't let the app listen on one (a sandbox). cause is its error.
export class NoFreePort extends Data.TaggedError("NoFreePort")<{ readonly cause: unknown }> {
  override get message(): string {
    return messageOf(this.cause);
  }
}

// The app's background work (its start, following the desk, the tray's refresh, a link it opens): what fails is logged,
// and reported if the app reports, never an unhandled rejection; interruption is quiet.
export const appRunner = (log: (m: string) => void): Runner => new Runner(log, report, detached);

// The IPC boundary (an ipcMain.handle handler): what the Effect gives, or a rejection with a failure's words alone, all the
// structured clone keeps. A bug rejects with its own words and is logged and reported.
export const ipcAnswer = <A, E extends { readonly message: string }>(
  channel: string,
  effect: Effect.Effect<A, E>,
  log: (m: string) => void,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.tapCause((cause) =>
        Effect.sync(() => {
          if (!Cause.hasDies(cause)) return;
          log(`${channel} failed: ${Cause.pretty(cause)}`);
          report(Cause.squash(cause), channel);
        }),
      ),
      Effect.mapError((e) => new Error(e.message)),
    ),
  );

// ---------------------------------------------------------------- files and processes that may not be there

// What f gives, or fallback when it throws: a file or a process that may be gone, where that is the answer.
export const tryOr = <A, B>(f: () => A, fallback: B): A | B => Result.merge(Result.try({ try: f, catch: () => fallback }));

// f run for what it does, or nothing when it throws: a process that's already gone, a file the app does without.
export const quietly = (f: () => void): void => {
  Result.try({ try: f, catch: () => null });
};

// JSON someone else wrote (a desk's notice, the app's own window.json), or null when it isn't JSON.
export const parseJson = (text: string): unknown => tryOr((): unknown => JSON.parse(text), null);

// A file the app keeps for itself, or null when it's missing or isn't JSON: the app starts without it.
export const readJson = (file: string): unknown => {
  const text = disk.read(file);
  return text === null ? null : parseJson(text);
};

export const writeFile = (file: string, text: string): Effect.Effect<void, FsError> =>
  Effect.try({
    try: () => {
      fs.writeFileSync(file, text);
    },
    catch: fsError("write", file),
  });

export const removeFile = (file: string): Effect.Effect<void, FsError> =>
  Effect.try({
    try: () => {
      fs.rmSync(file, { force: true });
    },
    catch: fsError("remove", file),
  });

export const makeDir = (dir: string): Effect.Effect<void, FsError> =>
  Effect.try({
    try: () => {
      fs.mkdirSync(dir, { recursive: true });
    },
    catch: fsError("mkdir", dir),
  });

// ---------------------------------------------------------------- the app's own files from before the rename to Inbox

// Electron keeps userData in a folder named for the app; this is the one it had.
export const OLD_APP_NAME = "Review Desk";
// What the app keeps there itself: the window's place and size, and this device's theme. The rest is Chromium's.
export const APP_FILES = ["window.json", "theme.json"];

// Copies each file `from` has and `to` lacks, and says which it copied; one already in `to` is the new app's own.
export const carryOver = (from: string, to: string, files: readonly string[] = APP_FILES): Effect.Effect<string[], FsError> =>
  Effect.gen(function* () {
    const copied: string[] = [];
    for (const f of files) {
      const [src, dst] = [path.join(from, f), path.join(to, f)];
      if (fs.existsSync(dst) || !fs.existsSync(src)) continue;
      yield* makeDir(to);
      yield* Effect.try({
        try: () => {
          fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
        },
        catch: fsError("copy", src),
      });
      copied.push(f);
    }
    return copied;
  });

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
// One that can't start prints nothing, as one that fails to: its caller reads no output either way.
// Spawned in the register beside its listeners: a fiber yielding in between would leave a spawn failure's error uncaught.
export const commandOutput = (cmd: string, args: string[], timeoutMs: number): Effect.Effect<{ stdout: string; timedOut: boolean }> =>
  Effect.callback<{ stdout: string; timedOut: boolean }>((resume) => {
    const group = process.platform !== "win32";
    const started = Result.try({
      try: () => spawn(cmd, args, { detached: group, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }),
      catch: () => null,
    });
    if (Result.isFailure(started)) {
      resume(Effect.succeed({ stdout: "", timedOut: false }));
      return Effect.void; // nothing started, nothing to stop
    }
    const child = started.success;
    let stdout = "";
    let timedOut = false;
    let closed = false;
    child.stdout.setEncoding("utf8").on("data", (s: string) => {
      stdout += s;
    });
    const stop = () => {
      const pid = child.pid;
      if (pid)
        quietly(() => {
          process.kill(group ? -pid : pid, "SIGKILL");
        }); // already gone
      child.stdout.destroy(); // a background job that kept the pipe can't hold up close
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const done = () => {
      closed = true;
      clearTimeout(timer);
      resume(Effect.succeed({ stdout, timedOut }));
    };
    child.on("error", done);
    child.on("close", done);
    // Interrupted: the group goes, and the run ends once it has.
    return Effect.callback<void>((gone) => {
      clearTimeout(timer);
      if (closed) {
        gone(Effect.void);
        return;
      }
      child.once("close", () => {
        gone(Effect.void);
      });
      stop();
    });
  });

// The first login shell after a boot can be slow (nvm, a cold disk), so it gets a second, longer try.
export const loginShellPath = (
  run: (timeoutMs: number) => Effect.Effect<string>,
  timeouts = [5000, 20_000],
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    for (const timeoutMs of timeouts) {
      const p = parseShellPath(yield* run(timeoutMs));
      if (p) return p;
    }
    return null;
  });

export interface Disk {
  isDir(p: string): boolean;
  read(p: string): string | null;
  list(p: string): string[];
}

const disk: Disk = {
  isDir: (p) => tryOr(() => fs.statSync(p).isDirectory(), false),
  read: (p) => tryOr(() => fs.readFileSync(p, "utf8"), null),
  list: (p) => tryOr(() => fs.readdirSync(p), []),
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

// A call to the desk (or its UI's dev server): its answer, whatever its status, or DeskCallFailed when none came in time.
export const request = (
  url: string,
  opts: { method?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Effect.Effect<Response, DeskCallFailed> =>
  Effect.tryPromise({
    try: (signal) => {
      const signals = [
        signal,
        ...(opts.signal ? [opts.signal] : []),
        ...(opts.timeoutMs === undefined ? [] : [AbortSignal.timeout(opts.timeoutMs)]),
      ];
      return fetch(url, { method: opts.method, signal: AbortSignal.any(signals) });
    },
    catch: (cause) => new DeskCallFailed({ url, cause }),
  });

// An answer's body as JSON; its signal (request's timeout) still bounds the read.
const json = (res: Response, url: string): Effect.Effect<unknown, DeskCallFailed> =>
  Effect.tryPromise({ try: (): Promise<unknown> => res.json(), catch: (cause) => new DeskCallFailed({ url, cause }) });

// What the desk answers at url, or null while it's starting (503), unreachable, or answering with what doesn't parse.
export const getJson = <T>(url: string, timeoutMs = 5000): Effect.Effect<T | null> =>
  request(url, { timeoutMs }).pipe(
    Effect.flatMap((res) => (res.ok ? json(res, url).pipe(Effect.map((v) => v as T)) : Effect.succeed(null))),
    Effect.orElseSucceed(() => null),
  );

// What answers on the desk's port: a desk (attach), nothing (start one), or something else.
export const probeHealth = (base: string, timeoutMs = 1000): Effect.Effect<Probe> =>
  request(`${base}/health`, { timeoutMs }).pipe(
    Effect.flatMap((res) =>
      json(res, `${base}/health`).pipe(
        Effect.orElseSucceed(() => null),
        Effect.map((body): Probe =>
          res.ok && (body as { ok?: unknown } | null)?.ok === true
            ? { kind: "desk" }
            : { kind: "other", detail: `HTTP ${res.status} on /health` },
        ),
      ),
    ),
    Effect.catch((e) => {
      const code = (e.cause as { cause?: { code?: unknown } } | undefined)?.cause?.code;
      return Effect.succeed<Probe>(
        code === "ECONNREFUSED" ? { kind: "free" } : { kind: "other", detail: typeof code === "string" ? code : e.message },
      );
    }),
  );

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

// The desk's events (/api/events) until the stream ends, each one to `event`, and `connected` once it's answered. What
// ends it early (no answer, an HTTP error, the connection dropping) is DeskCallFailed.
export const followEvents = (url: string, on: { connected(): void; event(e: SSEvent): void }): Effect.Effect<void, DeskCallFailed> =>
  Effect.suspend(() => {
    const cut = new AbortController();
    return Effect.gen(function* () {
      const res = yield* request(url, { signal: cut.signal });
      const body = yield* res.ok && res.body ? Effect.succeed(res.body) : Effect.fail(new DeskCallFailed({ url, status: res.status }));
      on.connected();
      const reader = body.pipeThrough(new TextDecoderStream()).getReader();
      const read = Effect.tryPromise({ try: () => reader.read(), catch: (cause) => new DeskCallFailed({ url, cause }) });
      let buf = "";
      for (let chunk = yield* read; !chunk.done; chunk = yield* read) {
        const { events, rest } = parseSSE(buf + chunk.value);
        buf = rest;
        for (const e of events) on.event(e);
      }
    }).pipe(
      // Cut short (interrupted, or a bug in what handles an event): the stream goes too.
      Effect.ensuring(
        Effect.sync(() => {
          cut.abort();
        }),
      ),
    );
  });

// A desk's `event: notify`, which it sends to the app attached with ?notify=1 instead of notifying itself.
export function parseNotice(data: string): { title: string; body: string } | null {
  const n = parseJson(data);
  if (typeof n !== "object" || n === null) return null;
  const { title, body } = n as { title?: unknown; body?: unknown };
  return typeof title === "string" && typeof body === "string" ? { title, body } : null;
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

const executable = (p: string): boolean =>
  tryOr(() => {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  }, false);

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
    return { run: "wait", need: "checkout", problem: `${dir} isn't an Inbox checkout` };
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

export const isTheme = (t: unknown): t is string => t === "system" || t === "omarchy" || themeOf(t) !== undefined;

// This device's theme's --paper and --pencil, for the window before the UI paints; System (or none picked yet) and Omarchy
// (which the desk reads) follow the OS, which Omarchy sets to its light or dark.
export function themeColors(theme: string | null, osDark: boolean): { paper: string; pencil: string } {
  const { paper, pencil } = themeOf(theme) ?? themeOf(osDark ? "dark" : "light")!;
  return { paper, pencil };
}

// "desk 7 +3" -> "7 +3"
export const trayTitle = (statusText: string): string => statusText.replace(/^desk\s*/, "");

export const trayTooltip = (s: { now: number; today: number } | null): string => (s ? `Inbox: ${s.now + s.today}` : "Inbox");

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

export const isAppUrl = (url: string, origins: string[]): boolean => origins.includes(URL.parse(url)?.origin ?? "");
// After the desk comes back, a window still on its UI keeps its view; one on the start or wait page has none to keep.
export const keepsView = (pageUrl: string, origins: string[], fromSource: boolean): boolean => !fromSource && isAppUrl(pageUrl, origins);
export const isHttpUrl = (url: string): boolean => ["http:", "https:"].includes(URL.parse(url)?.protocol ?? "");
export const isHttpsUrl = (url: string): boolean => URL.parse(url)?.protocol === "https:";
export const isGitHubUrl = (url: string): boolean => {
  const u = URL.parse(url);
  return u?.protocol === "https:" && u.host === "github.com";
};

// ---------------------------------------------------------------- inbox:// links (src/links.ts)

export const PROTOCOL = "inbox";
// The inbox:// link Windows and Linux start the app with, or hand a second instance, among Chromium's switches.
export const linkArg = (argv: readonly string[]): string | undefined => argv.find((a) => a.toLowerCase().startsWith(`${PROTOCOL}:`));
// The window's route to what an inbox:// link names; null for one that names nothing, or any other link.
export function linkHash(link: string): string | null {
  const p = link.trim().toLowerCase().startsWith(`${PROTOCOL}:`) ? placeOf(link) : null;
  return p ? hashOf(p) : null;
}

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

// Where the window was is a nicety: unsaved (it's gone, or the file can't be written), it opens at its default size.
export const saveBounds = (w: { isDestroyed(): boolean; getNormalBounds(): Bounds }, file: string): void => {
  if (w.isDestroyed()) return; // a destroyed window throws on getNormalBounds, uncaught in a timer
  Effect.runSync(Effect.ignore(writeFile(file, JSON.stringify(w.getNormalBounds()))));
};

// ---------------------------------------------------------------- Linux autostart

// Desktop Entry Exec quoting, then the file's own escaping of backslashes; % is a field code.
export function desktopEntry(exec: string, args: string[]): string {
  const quote = (s: string) => (/[\s"'\\`$<>|;&*?#()]/.test(s) ? `"${s.replaceAll(/(["`$\\])/g, "\\$1")}"` : s);
  const cmd = [exec, ...args].map(quote).join(" ").replaceAll("\\", "\\\\").replaceAll("%", "%%");
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Inbox",
    "Comment=Your GitHub review queue",
    `Exec=${cmd}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

// electron-updater replaces an AppImage or the Windows installer's install in place; the macOS build is ad hoc signed,
// which Squirrel.Mac refuses, and a tar.gz or zip has nothing to run: those get the release page.
export function selfUpdates(platform: string, env: NodeJS.ProcessEnv, installed: boolean): boolean {
  if (platform === "linux") return !!env.APPIMAGE;
  if (platform === "win32") return installed;
  return false;
}
