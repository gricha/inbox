// The desktop app: a window, tray and global hotkey around the desk. It attaches to a desk already
// running on the port (desk serve, launchd), runs one from a checkout (electron/source.ts), or runs one in-process.
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  screen,
  session,
  shell,
  Tray,
} from "electron";
import type { IpcMainInvokeEvent, MenuItemConstructorOptions, NativeImage } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Cause, Effect, Exit, Fiber, Result } from "effect";
import { BadRequest, Forbidden, messageOf, type FsError } from "../src/errors.ts";
import { deskHome, settleHome } from "../src/home.ts";
import { report } from "../src/sentry.ts";
import { DEFAULT_PORT, startServer } from "../src/server.ts";
import { readSettings, settingsPath } from "../src/settings.ts";
import type { Card, FocusView, SettingsView, SourceStatus } from "../src/types.ts";
import {
  appRunner,
  backoff,
  cardLabel,
  carryOver,
  commandOutput,
  DeskFailed,
  deskPlan,
  desktopEntry,
  desktopSettings,
  ElectronRefused,
  envVar,
  fallbackDirs,
  findNode,
  followEvents,
  getJson,
  ipcAnswer,
  isAppUrl,
  isGitHubUrl,
  isHttpsUrl,
  isHttpUrl,
  isTheme,
  keepsView,
  linkArg,
  linkHash,
  loginShellPath,
  makeDir,
  menuLabel,
  mergePath,
  OLD_APP_NAME,
  parseNotice,
  probeHealth,
  PROTOCOL,
  quietly,
  readJson,
  removeFile,
  request,
  restoreBounds,
  saveBounds,
  SHELL_PATH_COMMAND,
  sourceDir,
  themeColors,
  trayTitle,
  trayTooltip,
  writeFile,
  type Bounds,
  type DeskPlan,
  type DesktopSettings,
  type SSEvent,
} from "./lib.ts";
import { reap, startSource, type Source } from "./source.ts";

const mac = process.platform === "darwin";
const linux = process.platform === "linux";
const port = Number(envVar("DESK_PORT") ?? DEFAULT_PORT);
let home = deskHome(); // where it is now; connect() moves ~/.review-desk to ~/.inbox before the first desk starts
const api = `http://127.0.0.1:${port}`; // the main process's own calls; no IPv6 guess for "localhost"
const deskUrl = `http://localhost:${port}`;
let uiUrl = deskUrl;
const origins = [deskUrl, api];
// Settings → This device → Run from a checkout as it was at launch; DESK_SOURCE (npm run app:dev) wins over it.
const envSource = envVar("DESK_SOURCE");
const launchSource = desktopSettings(readSettings(settingsPath(home)).overrides).source;
const sourceWanted = sourceDir(envSource ?? launchSource, os.homedir());
// Set once the login shell's PATH is in: the desk from a checkout needs its node.
let plan: DeskPlan = { run: "in-process" };
let fromSource = "";
const asset = (name: string) => path.join(app.getAppPath(), "assets", name);

type Status = { now: number; today: number; new: number; text: string };
type Server = Awaited<ReturnType<typeof startServer>>;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let server: Server | null = null; // set when this process runs the desk
let source: Source | null = null; // set when the desk and UI run from a checkout
let quitting = false;
let closing = false;
let relaunching = false;
let prefs: DesktopSettings = desktopSettings();
let hotkey: { accelerator: string; ok: boolean; error?: string } = { accelerator: "", ok: true };
let status: Status | null = null;
let queueCards: Card[] = []; // the queue's top: now, then today
let loginApplied: boolean | null = null; // last applied, so a refused registration isn't retried on every update
let theme: string | null = null; // this device's, as Settings → This device picked it; kept here, since the UI's origin can change
let pendingHash: string | null = null; // where an inbox:// link asked the window to go before the UI loaded

// A separate DESK_HOME (tests, a second desk) gets its own window state, logs and single-instance lock.
if (process.env.DESK_HOME) {
  app.setPath("userData", path.join(home, "app"));
  app.setAppLogsPath(path.join(home, "app", "logs"));
}

let logFile = "";
function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`;
  if (!app.isPackaged) process.stderr.write(line);
  // Logging never fails what it logs: a line it can't write is left out.
  quietly(() => {
    if (!logFile) {
      fs.mkdirSync(app.getPath("logs"), { recursive: true });
      logFile = path.join(app.getPath("logs"), "desk.log");
    }
    fs.appendFileSync(logFile, line);
  });
}

// Everything the app starts and nobody waits on goes through it, so what fails is in desk.log.
const runner = appRunner(log);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Windows and Linux start a second instance for a clicked inbox:// link; macOS hands it to open-url, at launch too.
  app.on("second-instance", (_e, argv) => {
    const link = linkArg(argv);
    if (link) openPermalink(link);
    else showWindow();
  });
  app.on("open-url", (e, url) => {
    e.preventDefault();
    openPermalink(url);
  });
  const launched = linkArg(process.argv);
  if (launched) openPermalink(launched);
  runner.fork("starting the app", main());
}

function main(): Effect.Effect<void> {
  return Effect.gen(function* () {
    app.setAppUserModelId("dev.inbox.app");
    app.on("before-quit", () => {
      quitting = true;
    });
    app.on("will-quit", (e) => {
      globalShortcut.unregisterAll();
      if (!server && !source) return;
      e.preventDefault();
      if (closing) return;
      closing = true;
      // A second app.quit() after preventing will-quit is ignored (Electron 45); the windows are closed by now anyway.
      runner.fork("quitting", stopDesk(server, source));
    });
    process.on("exit", () => {
      source?.kill();
    });
    app.on("activate", showWindow);

    const pathReady = yield* Effect.forkChild(fixPath());
    yield* Effect.promise(() => app.whenReady());
    log(`Inbox ${app.getVersion()} (Electron ${process.versions.electron}), desk ${deskUrl}, home ${home}`);
    if (!process.env.DESK_HOME) yield* carryOverFiles();
    // Only the packaged app on the owner's home takes inbox:// links: from the repo they'd start a bare Electron.
    if (app.isPackaged && !process.env.DESK_HOME && !app.isDefaultProtocolClient(PROTOCOL))
      log(app.setAsDefaultProtocolClient(PROTOCOL) ? `opening ${PROTOCOL}:// links` : `couldn't take ${PROTOCOL}:// links`);
    if (mac && !app.isPackaged) app.dock?.setIcon(asset("icon.png")); // from the repo the Dock would show Electron's icon
    secureSession();
    handle("desktop:status", (e) =>
      fromApp(e).pipe(Effect.map(() => ({ hotkey, open_at_login: loginItemEnabled(), source: sourceStatus() }))),
    );
    theme = readTheme();
    // The preload reads it before the page's first paint.
    ipcMain.on("desktop:theme", (e) => {
      e.returnValue = theme;
    });
    handle("desktop:set-theme", (e, t) =>
      Effect.gen(function* () {
        yield* fromApp(e);
        const picked = yield* isTheme(t) ? Effect.succeed(t) : Effect.fail(new BadRequest({ message: "no such theme" }));
        theme = picked;
        yield* writeFile(themeFile(), JSON.stringify({ theme: picked })).pipe(
          Effect.catch((err) =>
            Effect.sync(() => {
              log(`saving the theme: ${err.message}`);
            }),
          ),
        );
        win?.setBackgroundColor(paper());
      }),
    );
    Menu.setApplicationMenu(appMenu());
    createTray();
    createWindow();
    yield* Fiber.join(pathReady);
    yield* planDesk();
    yield* reap(home, log).pipe(
      Effect.catch((e) =>
        Effect.sync(() => {
          log(`forgetting what an earlier run left going: ${e.message}`);
        }),
      ),
    );
    if (!(yield* connect())) return;
    // Before the UI: the tray and notifications work while Vite is still coming up (or broken).
    runner.fork("following the desk", watch());
    yield* loadUi();
  });
}

// The desk this process runs closed and what runs from a checkout stopped, each failure logged; then the app exits.
function stopDesk(s: Server | null, src: Source | null): Effect.Effect<void> {
  return Effect.gen(function* () {
    const closed = s
      ? Effect.tryPromise({ try: () => s.close(), catch: (cause) => new DeskFailed({ cause }) }).pipe(
          Effect.catch((err) =>
            Effect.sync(() => {
              log(`closing the desk: ${err.message}`);
            }),
          ),
        )
      : Effect.void;
    const stopped = src
      ? src.stop().pipe(
          Effect.catch((err) =>
            Effect.sync(() => {
              log(`stopping the desk from ${fromSource}: ${err.message}`);
            }),
          ),
        )
      : Effect.void;
    const done = yield* Effect.exit(Effect.all([closed, stopped], { concurrency: "unbounded", discard: true }));
    if (Exit.isFailure(done)) {
      log(`quitting failed: ${Cause.pretty(done.cause)}`);
      report(Cause.squash(done.cause), "quitting");
    }
    app.exit(0);
  });
}

// The IPC boundary: a handler's failure rejects the renderer's call with its words (ipcAnswer).
function handle<A, E extends { readonly message: string }>(
  channel: string,
  answer: (e: IpcMainInvokeEvent, arg: unknown) => Effect.Effect<A, E>,
): void {
  ipcMain.handle(channel, (e, arg: unknown) => ipcAnswer(channel, answer(e, arg), log));
}

// Only the desk's own window asks the app for its state or sets its theme.
const fromApp = (e: IpcMainInvokeEvent): Effect.Effect<void, Forbidden> =>
  isAppUrl(e.senderFrame?.url ?? "", origins) ? Effect.void : Effect.fail(new Forbidden({ message: "not allowed" }));

function loadUi(): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (source) {
      const s = source;
      const slow = setTimeout(() => {
        showPage(`Starting the UI from ${fromSource}… its output is in ${s.status().log}`);
      }, 20_000);
      yield* s.uiReady().pipe(
        Effect.ensuring(
          Effect.sync(() => {
            clearTimeout(slow);
          }),
        ),
      );
    }
    if (!win) return;
    const hash = pendingHash;
    pendingHash = null;
    yield* load(win, hash ? `${uiUrl}/${hash}` : uiUrl).pipe(
      Effect.catch((e) =>
        Effect.sync(() => {
          log(`loading ${uiUrl}: ${e.message}`);
        }),
      ),
    );
    if (pendingHash) goTo(pendingHash); // a link clicked while it loaded
  });
}

// ---------------------------------------------------------------- PATH

// Finder, the Dock and login items start apps with /usr/bin:/bin; gh and claude live elsewhere.
function fixPath(): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (process.platform === "win32") return;
    const sh = envVar("SHELL") ?? (mac ? "/bin/zsh" : "/bin/bash");
    const fromShell = yield* loginShellPath((timeout) =>
      commandOutput(sh, ["-ilc", SHELL_PATH_COMMAND], timeout).pipe(
        Effect.map(({ stdout, timedOut }) => {
          if (timedOut) log(`${sh} didn't print PATH within ${timeout / 1000}s`);
          return stdout;
        }),
      ),
    );
    process.env.PATH = mergePath(path.delimiter, fromShell ?? "", process.env.PATH ?? "", ...fallbackDirs(os.homedir()));
    if (!fromShell) log(`couldn't read PATH from ${sh}; added the usual dirs`);
  });
}

// ---------------------------------------------------------------- the desk

function planDesk(): Effect.Effect<void> {
  return Effect.gen(function* () {
    const node = sourceWanted ? findNode(process.env.PATH ?? "") : null;
    const version = node ? (yield* commandOutput(node, ["--version"], 5000)).stdout : "";
    plan = deskPlan(sourceWanted, node ? { path: node, version } : null);
    fromSource = plan.run === "in-process" ? "" : sourceWanted;
  });
}

// What the window says while the chosen folder can't run the desk yet.
function waitText(p: Extract<DeskPlan, { run: "wait" }>): string {
  // Windows' PATH comes only from launch: a node installed meanwhile isn't found until the app starts again.
  if (p.need === "node" && process.platform === "win32")
    return `${p.problem}. The desk starts from ${fromSource} once you quit the app and open it again.`;
  if (p.need !== "checkout")
    return `${p.problem}. The desk starts from ${fromSource} once that's fixed; the app looks again every 15 seconds.`;
  if (envSource !== undefined) return `${p.problem}. Point DESK_SOURCE at an Inbox clone, or unset it, and start the app again.`;
  return `${p.problem}. Point app.source in ${settingsPath(home)} at an Inbox clone, or clear it to run the app's own desk; the app restarts when you save it.`;
}

// Attach to the desk on the port, or start one here. False when the user chose Quit.
function connect(): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    let waitingOn = "";
    // This loop comes round every 15 seconds while it waits: a line the move said last time isn't said again.
    let settleSaid = "";
    const settleLog = (m: string) => {
      if (m !== settleSaid) log(m);
      settleSaid = m;
    };
    for (;;) {
      const probe = yield* probeHealth(api);
      if (probe.kind === "desk") {
        log(`attached to the desk on ${deskUrl}${fromSource ? `; ${fromSource} runs once that desk stops` : ""}`);
        return true;
      }
      if (probe.kind === "other") {
        dialog.showErrorBox(
          "Inbox",
          `Something other than Inbox is using port ${port} (${probe.detail}).\n\nStop it, or set DESK_PORT to another port.`,
        );
        app.quit();
        return false;
      }
      const settled = yield* settleHome(port, settleLog);
      home = settled;
      // A desk from source that fails, or can't start yet, shows that in the window and waits for a fix; never an in-process desk in its place.
      if (plan.run === "wait") {
        if (plan.problem !== waitingOn) {
          waitingOn = plan.problem;
          log(`waiting to run the desk from ${fromSource}: ${plan.problem}`);
          showPage(waitText(plan));
        }
        yield* Effect.sleep(15_000);
        checkSource(); // with no desk there's no Settings page: settings.json is where the folder gets fixed
        if (quitting || relaunching) return false;
        if (plan.need === "node") yield* fixPath(); // a login shell (nvm and all) every 15 s only when it can help
        yield* planDesk();
        continue;
      }
      if (plan.run === "source") {
        const started = yield* Effect.result(startSource({ dir: fromSource, node: plan.node, port, home, log }));
        // Its home or a port for its UI: said in the window, and tried again, as a desk from source that can't start yet.
        if (Result.isFailure(started)) {
          const problem = `The desk from ${fromSource} couldn't start: ${started.failure.message}`;
          if (problem !== waitingOn) {
            waitingOn = problem;
            log(problem);
            showPage(`${problem}. The app tries again every 15 seconds.`);
          }
          yield* Effect.sleep(15_000);
          checkSource();
          if (quitting || relaunching) return false;
          continue;
        }
        if (waitingOn) showPage("Starting Inbox\u2026");
        const s = started.success;
        source = s;
        uiUrl = s.ui;
        origins.push(s.ui);
        log(`running the desk on ${deskUrl} and the UI on ${s.ui} from ${fromSource}`);
        return true;
      }
      log(`starting a desk on ${deskUrl}`);
      const started = yield* Effect.result(
        Effect.tryPromise({ try: () => startServer({ port, home: settled, notify, log }), catch: (cause) => new DeskFailed({ cause }) }),
      );
      if (Result.isSuccess(started)) {
        server = started.success;
        return true;
      }
      const { message } = started.failure;
      log(`the desk didn't start: ${message}`);
      const { response } = yield* Effect.promise(() =>
        dialog.showMessageBox({
          type: "error",
          message: "Inbox couldn't start",
          detail: `${message}\n\nIf GitHub isn't logged in, run gh auth login in a terminal, then Retry.`,
          buttons: ["Retry", "Quit"],
          defaultId: 0,
          cancelId: 1,
        }),
      );
      if (response === 1) {
        app.quit();
        return false;
      }
    }
  });
}

// Follows /api/events: refreshes the tray on each update, shows a desk's notifications when it isn't in this process, and
// takes over when an attached desk goes away. A desk from source restarting is just a reconnect.
function watch(): Effect.Effect<void> {
  return Effect.gen(function* () {
    let attempt = 0;
    const events = {
      connected: () => {
        attempt = 0;
      },
      event: (e: SSEvent) => {
        const n = e.event === "notify" ? parseNotice(e.data) : null;
        if (n) notify(n.title, n.body);
        if (e.event === "update") refreshSoon();
      },
    };
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- the before-quit handler sets quitting while this loop waits
    while (!quitting) {
      // However the stream ended (the desk restarting, or gone), the checks below tell what's next; a bug is logged too.
      yield* followEvents(`${api}/api/events${server ? "" : "?notify=1"}`, events).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.sync(() => {
                if (!Cause.hasDies(cause)) return;
                log(`following the desk failed: ${Cause.pretty(cause)}`);
                report(Cause.squash(cause), "following the desk");
              }),
        ),
      );
      if (quitting) return;
      if (!server && !source && (yield* deskGone())) {
        log(fromSource ? "the desk went away; running it from source" : "the desk went away; starting one here");
        if (!(yield* connect())) return;
        if (keepsView(win?.webContents.getURL() ?? "", origins, !!source)) win?.webContents.reload();
        else yield* loadUi();
        continue;
      }
      yield* Effect.sleep(source ? 1000 : backoff(attempt++));
    }
  });
}

function sourceStatus(): SourceStatus | null {
  if (!sourceWanted) return null;
  if (plan.run === "wait") return { dir: sourceWanted, state: "invalid", detail: plan.problem };
  return source?.status() ?? { dir: sourceWanted, state: "attached" };
}

// Switching Run from a checkout takes a restart. It compares settings.json, which the next launch reads, so it can't loop.
function checkSource(): void {
  if (envSource !== undefined || relaunching) return;
  if (desktopSettings(readSettings(settingsPath(home)).overrides).source === launchSource) return;
  relaunching = true;
  log("Run from a checkout changed; restarting the app");
  app.relaunch({ args: process.argv.slice(1).filter((a) => a !== "--hidden") });
  app.quit();
}

function deskGone(): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    for (let i = 0; i < 3; i++) {
      if ((yield* probeHealth(api)).kind !== "free") return false;
      yield* Effect.sleep(1000);
    }
    return true;
  });
}

let refreshTimer: NodeJS.Timeout | null = null;
function refreshSoon(): void {
  refreshTimer ??= setTimeout(() => {
    refreshTimer = null;
    runner.fork("refreshing the tray", refresh());
  }, 500);
}

function refresh(): Effect.Effect<void> {
  return Effect.gen(function* () {
    const [s, focus, settings] = yield* Effect.all(
      [getJson<Status>(`${api}/api/status`), getJson<FocusView>(`${api}/api/focus`), getJson<SettingsView>(`${api}/api/settings`)],
      { concurrency: "unbounded" },
    );
    if (settings) yield* applySettings(desktopSettings(settings.values));
    status = s;
    queueCards = focus ? [...focus.sections.now, ...focus.sections.today] : [];
    updateTray();
    updateBadge();
  });
}

function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: mac ? undefined : asset("icon.png") });
  shown.add(n);
  n.on("click", () => {
    shown.delete(n);
    showWindow();
  });
  n.on("close", () => {
    shown.delete(n);
  });
  n.show();
}
const shown = new Set<Notification>(); // a collected Notification loses its click handler

// ---------------------------------------------------------------- desktop settings

function applySettings(next: DesktopSettings): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (next.hotkey !== hotkey.accelerator) registerHotkey(next.hotkey);
    if (next.source !== prefs.source) checkSource();
    if (next.open_at_login !== loginApplied) {
      loginApplied = next.open_at_login;
      // One the OS refuses is logged; the tray still updates.
      if (next.open_at_login !== loginItemEnabled())
        yield* setLoginItem(next.open_at_login).pipe(
          Effect.catch((e) =>
            Effect.sync(() => {
              log(`open at login failed: ${e.message}`);
            }),
          ),
        );
    }
    prefs = next;
  });
}

function registerHotkey(accelerator: string): void {
  if (hotkey.ok && hotkey.accelerator) globalShortcut.unregister(hotkey.accelerator);
  hotkey = { accelerator, ok: true };
  if (!accelerator) return;
  // One Electron can't read throws; another app's is false. Either way it's what Settings shows.
  const registered = Result.try({ try: () => globalShortcut.register(accelerator, toggleWindow), catch: messageOf });
  if (Result.isFailure(registered)) hotkey = { accelerator, ok: false, error: registered.failure };
  else if (!registered.success) hotkey = { accelerator, ok: false, error: "another app has this shortcut" };
  log(hotkey.ok ? `hotkey ${accelerator}` : `hotkey ${accelerator} failed: ${hotkey.error}`);
}

const autostartFile = (name = "inbox") =>
  path.join(envVar("XDG_CONFIG_HOME") ?? path.join(os.homedir(), ".config"), "autostart", `${name}.desktop`);

// Only the packaged app registers itself; from the repo the login item would launch a bare Electron.
function loginItemEnabled(): boolean {
  if (!app.isPackaged) return false;
  if (linux) return fs.existsSync(autostartFile());
  return app.getLoginItemSettings(mac ? undefined : { args: ["--hidden"] }).openAtLogin;
}

function setLoginItem(on: boolean): Effect.Effect<void, FsError | ElectronRefused> {
  return Effect.gen(function* () {
    if (!app.isPackaged) return;
    log(`open at login: ${on}`);
    if (!linux) {
      yield* Effect.try({
        try: () => {
          app.setLoginItemSettings({ openAtLogin: on, args: ["--hidden"] });
        },
        catch: (cause) => new ElectronRefused({ cause }),
      });
      return;
    }
    const file = autostartFile();
    if (!on) {
      yield* removeFile(file);
      return;
    }
    yield* makeDir(path.dirname(file));
    yield* writeFile(file, desktopEntry(envVar("APPIMAGE") ?? process.execPath, ["--hidden"]));
    yield* removeFile(autostartFile("review-desk")); // the app's own entry from before the rename, which starts the old one
  });
}

// ---------------------------------------------------------------- window

const stateFile = () => path.join(app.getPath("userData"), "window.json");
const themeFile = () => path.join(app.getPath("userData"), "theme.json");

// Inbox's first start: the window's place and the theme from the app's folder before the rename, as the user left them.
function carryOverFiles(): Effect.Effect<void> {
  const from = path.join(app.getPath("appData"), OLD_APP_NAME);
  return carryOver(from, app.getPath("userData")).pipe(
    Effect.match({
      onSuccess: (copied) => {
        if (copied.length) log(`carried ${copied.join(" and ")} over from ${from}`);
      },
      onFailure: (e) => {
        log(`carrying the window and theme over from ${from}: ${e.message}`);
      },
    }),
  );
}

function readTheme(): string | null {
  const t = (readJson(themeFile()) as { theme?: unknown } | null)?.theme;
  return isTheme(t) ? t : null;
}

// The UI's --paper, so the window doesn't flash another theme while it loads.
const paper = () => themeColors(theme, nativeTheme.shouldUseDarkColors).paper;

const startPage = (text: string) => {
  const ink = themeColors(theme, nativeTheme.shouldUseDarkColors).pencil;
  const body = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const page = `<title>Inbox</title><body style="margin:0;display:grid;place-items:center;height:100vh;background:${paper()};color:${ink};font:14px system-ui;-webkit-app-region:drag"><p style="max-width:32em;text-align:center">${body}</p></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(page)}`;
};

const load = (w: BrowserWindow, url: string): Effect.Effect<void, ElectronRefused> =>
  Effect.tryPromise({ try: () => w.loadURL(url), catch: (cause) => new ElectronRefused({ cause }) });

// The window's start page with text on it. The next load superseding it rejects it with ERR_ABORTED: nothing went wrong.
function showPage(text: string): void {
  if (!win) return;
  runner.fork(
    "showing the start page",
    load(win, startPage(text)).pipe(
      Effect.catchIf(
        (e) => e.aborted,
        () => Effect.void,
      ),
    ),
  );
}

// A link the window was asked to open, in the browser.
function openLink(url: string): void {
  runner.fork(
    "opening a link",
    Effect.tryPromise({ try: () => shell.openExternal(url), catch: (cause) => new ElectronRefused({ cause }) }),
  );
}

function createWindow(): void {
  const saved = readJson(stateFile()) as Partial<Bounds> | null; // restoreBounds type-checks each field
  const bg = paper();
  const w = new BrowserWindow({
    ...restoreBounds(
      saved,
      screen.getAllDisplays().map((d) => d.workArea),
      { width: 1180, height: 800 },
    ),
    minWidth: 760,
    minHeight: 500,
    title: "Inbox",
    show: false,
    backgroundColor: bg,
    // On macOS the UI's title bar holds the traffic lights (web/src/styles.css pads it for them).
    ...(mac ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 19 } } : {}),
    autoHideMenuBar: !mac,
    icon: mac ? undefined : asset("icon.png"),
    webPreferences: {
      preload: path.join(app.getAppPath(), "electron", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [`--desk-version=${app.getVersion()}`],
    },
  });
  win = w;
  const hidden = process.argv.includes("--hidden") || (mac && app.getLoginItemSettings().wasOpenedAtLogin);
  w.once("ready-to-show", () => {
    if (!hidden) w.show();
  });
  w.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    w.hide();
  });
  let saveTimer: NodeJS.Timeout | undefined;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveBounds(w, stateFile());
    }, 500);
  };
  w.on("closed", () => {
    clearTimeout(saveTimer);
  });
  nativeTheme.on("updated", () => {
    if (!w.isDestroyed()) w.setBackgroundColor(paper());
  });
  w.on("resize", save);
  w.on("move", save);

  w.webContents.on("will-navigate", (e) => {
    if (isAppUrl(e.url, origins)) return;
    e.preventDefault();
    if (isHttpUrl(e.url)) openLink(e.url);
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpsUrl(url)) openLink(url);
    return { action: "deny" };
  });
  showPage("Starting Inbox…");
}

function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (mac) app.focus({ steal: true });
}

function toggleWindow(): void {
  if (win?.isVisible() && win.isFocused()) {
    win.hide();
    if (mac) app.hide(); // hand focus back to the previous app
  } else showWindow();
}

function openSettings(): void {
  showWindow();
  goTo("#/settings");
}

// An inbox:// link clicked anywhere: the window comes forward at its item or page; one that names nothing just brings it.
function openPermalink(link: string): void {
  const hash = linkHash(link);
  if (hash === null) log(`an ${PROTOCOL}:// link that names nothing: ${link}`);
  else goTo(hash);
  showWindow();
}

// The window's route: now, on the UI; while the start page shows, once the UI loads.
function goTo(hash: string): void {
  const w = win;
  pendingHash = hash;
  if (!w || !isAppUrl(w.webContents.getURL(), origins)) return;
  pendingHash = null;
  runner.fork(
    "going to a page",
    Effect.tryPromise({
      try: () => w.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`),
      catch: (cause) => new ElectronRefused({ cause }),
    }),
  );
}

function secureSession(): void {
  // The UI's "c" copies a prompt; nothing else (camera, notifications, ...) is ever needed.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === "clipboard-sanitized-write");
  });
}

function appMenu(): Menu {
  const settings: MenuItemConstructorOptions = { label: "Settings…", accelerator: "CmdOrCtrl+,", click: openSettings };
  const first: MenuItemConstructorOptions = mac
    ? {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          settings,
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      }
    : { label: "File", submenu: [settings, { type: "separator" }, { role: "quit" }] };
  return Menu.buildFromTemplate([
    first,
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
      ],
    },
    { role: "windowMenu" },
  ]);
}

// ---------------------------------------------------------------- tray and badge

const trayImage = (alert: boolean): NativeImage =>
  nativeImage.createFromPath(asset(mac ? "trayTemplate.png" : alert ? "tray-alert.png" : "tray.png"));

function createTray(): void {
  tray = new Tray(trayImage(false));
  Object.assign(globalThis, { deskTray: tray }); // scripts/smoke-app.ts checks it
  if (!mac) tray.on("click", toggleWindow);
  updateTray();
}

// The queue's count, as the sidebar shows it: one list, no urgent split.
const queued = () => (status?.now ?? 0) + (status?.today ?? 0);

function updateTray(): void {
  if (!tray) return;
  tray.setToolTip(trayTooltip(status));
  if (mac) tray.setTitle(prefs.menu_bar_count ? trayTitle(status?.text ?? "") : "", { fontType: "monospacedDigit" });
  else tray.setImage(trayImage(queued() > 0));
  const cards: MenuItemConstructorOptions[] = queueCards.slice(0, 5).map((c) => ({
    label: cardLabel(c),
    click: () => {
      if (isGitHubUrl(c.url)) openLink(c.url);
    },
  }));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open Inbox",
        accelerator: hotkey.ok && hotkey.accelerator ? hotkey.accelerator : undefined,
        registerAccelerator: false,
        click: showWindow,
      },
      ...(cards.length
        ? [{ type: "separator" as const }, { label: menuLabel(`Inbox (${queueCards.length})`), enabled: false }, ...cards]
        : []),
      { type: "separator" },
      {
        label: "Sync now",
        click: () => {
          runner.fork("Sync now", request(`${api}/api/sync`, { method: "POST" }));
        },
      },
      { label: "Settings…", click: openSettings },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          app.quit();
        },
      },
    ]),
  );
}

function updateBadge(): void {
  const n = queued();
  if (mac) app.dock?.setBadge(n ? String(n) : "");
  else if (linux) app.setBadgeCount(n);
  else win?.setOverlayIcon(n ? nativeImage.createFromPath(asset("overlay-alert.png")) : null, n ? `${n} in the Inbox` : "");
}
