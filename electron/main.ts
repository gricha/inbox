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
import type { MenuItemConstructorOptions, NativeImage } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DEFAULT_PORT, startServer } from "../src/server.ts";
import { readSettings, settingsPath } from "../src/settings.ts";
import type { Card, FocusView, SettingsView, SourceStatus } from "../src/types.ts";
import {
  backoff,
  cardLabel,
  commandOutput,
  deskPlan,
  desktopEntry,
  desktopSettings,
  envVar,
  fallbackDirs,
  findNode,
  isAppUrl,
  isGitHubUrl,
  isHttpsUrl,
  isHttpUrl,
  isTheme,
  keepsView,
  loginShellPath,
  menuLabel,
  mergePath,
  parseNotice,
  parseSSE,
  probeHealth,
  restoreBounds,
  SHELL_PATH_COMMAND,
  sourceDir,
  themeColors,
  trayTitle,
  trayTooltip,
  type Bounds,
  type DeskPlan,
  type DesktopSettings,
} from "./lib.ts";
import { reap, startSource, type Source } from "./source.ts";

const mac = process.platform === "darwin";
const linux = process.platform === "linux";
const port = Number(envVar("DESK_PORT") ?? DEFAULT_PORT);
const home = envVar("DESK_HOME") ?? path.join(os.homedir(), ".review-desk");
const api = `http://127.0.0.1:${port}`; // the main process's own calls; no IPv6 guess for "localhost"
const deskUrl = `http://localhost:${port}`;
let uiUrl = deskUrl;
const origins = [deskUrl, api];
// Settings → Desktop app → Run from a checkout as it was at launch; DESK_SOURCE (npm run app:dev) wins over it.
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
let theme: string | null = null; // this device's, as Settings → Appearance picked it; kept here, since the UI's origin can change

// A separate DESK_HOME (tests, a second desk) gets its own window state, logs and single-instance lock.
if (process.env.DESK_HOME) {
  app.setPath("userData", path.join(home, "app"));
  app.setAppLogsPath(path.join(home, "app", "logs"));
}

let logFile = "";
function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`;
  if (!app.isPackaged) process.stderr.write(line);
  try {
    if (!logFile) {
      fs.mkdirSync(app.getPath("logs"), { recursive: true });
      logFile = path.join(app.getPath("logs"), "desk.log");
    }
    fs.appendFileSync(logFile, line);
  } catch {}
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  void main();
}

async function main(): Promise<void> {
  app.setAppUserModelId("dev.review-desk.app");
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
    void Promise.all([
      server?.close().catch((err: Error) => {
        log(`closing the desk: ${err.message}`);
      }),
      source?.stop(),
    ]).finally(() => {
      app.exit(0);
    });
  });
  process.on("exit", () => {
    source?.kill();
  });
  app.on("activate", showWindow);

  const pathReady = fixPath();
  await app.whenReady();
  log(`Review Desk ${app.getVersion()} (Electron ${process.versions.electron}), desk ${deskUrl}, home ${home}`);
  if (mac && !app.isPackaged) app.dock?.setIcon(asset("icon.png")); // from the repo the Dock would show Electron's icon
  secureSession();
  ipcMain.handle("desktop:status", (e) => {
    if (!isAppUrl(e.senderFrame?.url ?? "", origins)) throw new Error("not allowed");
    return { hotkey, open_at_login: loginItemEnabled(), source: sourceStatus() };
  });
  theme = readTheme();
  // The preload reads it before the page's first paint.
  ipcMain.on("desktop:theme", (e) => {
    e.returnValue = theme;
  });
  ipcMain.handle("desktop:set-theme", (e, t: unknown) => {
    if (!isAppUrl(e.senderFrame?.url ?? "", origins)) throw new Error("not allowed");
    if (!isTheme(t)) throw new Error("no such theme");
    theme = t;
    try {
      fs.writeFileSync(themeFile(), JSON.stringify({ theme: t }));
    } catch (err) {
      log(`saving the theme: ${(err as Error).message}`);
    }
    win?.setBackgroundColor(paper());
  });
  Menu.setApplicationMenu(appMenu());
  createTray();
  createWindow();
  await pathReady;
  planDesk();
  await reap(home, log);
  if (!(await connect())) return;
  // Before the UI: the tray and notifications work while Vite is still coming up (or broken).
  void watch();
  await loadUi();
}

async function loadUi(): Promise<void> {
  if (source) {
    const s = source;
    const slow = setTimeout(() => {
      void win?.loadURL(startPage(`Starting the UI from ${fromSource}… its output is in ${s.status().log}`));
    }, 20_000);
    await s.uiReady();
    clearTimeout(slow);
  }
  await win?.loadURL(uiUrl).catch((e: Error) => {
    log(`loading ${uiUrl}: ${e.message}`);
  });
}

// ---------------------------------------------------------------- PATH

// Finder, the Dock and login items start apps with /usr/bin:/bin; gh and claude live elsewhere.
async function fixPath(): Promise<void> {
  if (process.platform === "win32") return;
  const sh = envVar("SHELL") ?? (mac ? "/bin/zsh" : "/bin/bash");
  const fromShell = await loginShellPath(async (timeout) => {
    const { stdout, timedOut } = await commandOutput(sh, ["-ilc", SHELL_PATH_COMMAND], timeout);
    if (timedOut) log(`${sh} didn't print PATH within ${timeout / 1000}s`);
    return stdout;
  });
  process.env.PATH = mergePath(path.delimiter, fromShell ?? "", process.env.PATH ?? "", ...fallbackDirs(os.homedir()));
  if (!fromShell) log(`couldn't read PATH from ${sh}; added the usual dirs`);
}

// ---------------------------------------------------------------- the desk

function planDesk(): void {
  plan = deskPlan(sourceWanted, findNode(process.env.PATH ?? ""));
  fromSource = plan.run === "in-process" ? "" : sourceWanted;
}

// What the window says while the chosen folder can't run the desk yet.
function waitText(p: Extract<DeskPlan, { run: "wait" }>): string {
  if (p.need !== "checkout")
    return `${p.problem}. The desk starts from ${fromSource} once that's fixed; the app looks again every 15 seconds.`;
  if (envSource !== undefined) return `${p.problem}. Point DESK_SOURCE at a Review Desk clone, or unset it, and start the app again.`;
  return `${p.problem}. Point app.source in ${settingsPath(home)} at a Review Desk clone, or clear it to run the app's own desk; the app restarts when you save it.`;
}

// Attach to the desk on the port, or start one here. False when the user chose Quit.
async function connect(): Promise<boolean> {
  let waitingOn = "";
  for (;;) {
    const probe = await probeHealth(api);
    if (probe.kind === "desk") {
      log(`attached to the desk on ${deskUrl}${fromSource ? `; ${fromSource} runs once that desk stops` : ""}`);
      return true;
    }
    if (probe.kind === "other") {
      dialog.showErrorBox(
        "Review Desk",
        `Something other than Review Desk is using port ${port} (${probe.detail}).\n\nStop it, or set DESK_PORT to another port.`,
      );
      app.quit();
      return false;
    }
    // A desk from source that fails, or can't start yet, shows that in the window and waits for a fix; never an in-process desk in its place.
    if (plan.run === "wait") {
      if (plan.problem !== waitingOn) {
        waitingOn = plan.problem;
        log(`waiting to run the desk from ${fromSource}: ${plan.problem}`);
        void win?.loadURL(startPage(waitText(plan)));
      }
      await sleep(15_000);
      checkSource(); // with no desk there's no Settings page: settings.json is where the folder gets fixed
      if (quitting || relaunching) return false;
      await fixPath();
      planDesk();
      continue;
    }
    if (plan.run === "source") {
      if (waitingOn) void win?.loadURL(startPage("Starting Review Desk\u2026"));
      source = await startSource({ dir: fromSource, node: plan.node, port, home, log });
      uiUrl = source.ui;
      origins.push(source.ui);
      log(`running the desk on ${deskUrl} and the UI on ${source.ui} from ${fromSource}`);
      return true;
    }
    try {
      log(`starting a desk on ${deskUrl}`);
      server = await startServer({ port, home, notify, log });
      return true;
    } catch (e) {
      const message = (e as Error).message;
      log(`the desk didn't start: ${message}`);
      const { response } = await dialog.showMessageBox({
        type: "error",
        message: "Review Desk couldn't start",
        detail: `${message}\n\nIf GitHub isn't logged in, run gh auth login in a terminal, then Retry.`,
        buttons: ["Retry", "Quit"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 1) {
        app.quit();
        return false;
      }
    }
  }
}

// Follows /api/events: refreshes the tray on each update, shows a desk's notifications when it isn't in this process, and
// takes over when an attached desk goes away. A desk from source restarting is just a reconnect.
async function watch(): Promise<void> {
  // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- the before-quit handler sets quitting while this loop awaits
  for (let attempt = 0; !quitting;) {
    try {
      const res = await fetch(`${api}/api/events${server ? "" : "?notify=1"}`);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      attempt = 0;
      let buf = "";
      for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
        const { events, rest } = parseSSE(buf + chunk);
        buf = rest;
        for (const e of events) {
          const n = e.event === "notify" ? parseNotice(e.data) : null;
          if (n) notify(n.title, n.body);
        }
        if (events.some((e) => e.event === "update")) refreshSoon();
      }
    } catch {}
    if (quitting) return;
    if (!server && !source && (await deskGone())) {
      log(fromSource ? "the desk went away; running it from source" : "the desk went away; starting one here");
      if (!(await connect())) return;
      if (keepsView(win?.webContents.getURL() ?? "", origins, !!source)) win?.webContents.reload();
      else await loadUi();
      continue;
    }
    await sleep(source ? 1000 : backoff(attempt++));
  }
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

async function deskGone(): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    if ((await probeHealth(api)).kind !== "free") return false;
    await sleep(1000);
  }
  return true;
}

let refreshTimer: NodeJS.Timeout | null = null;
function refreshSoon(): void {
  refreshTimer ??= setTimeout(() => {
    refreshTimer = null;
    void refresh();
  }, 500);
}

async function refresh(): Promise<void> {
  const [s, focus, settings] = await Promise.all([
    getJson<Status>("/api/status"),
    getJson<FocusView>("/api/focus"),
    getJson<SettingsView>("/api/settings"),
  ]);
  if (settings) applySettings(desktopSettings(settings.values));
  status = s;
  queueCards = focus ? [...focus.sections.now, ...focus.sections.today] : [];
  updateTray();
  updateBadge();
}

// null while the desk is starting (503) or unreachable.
async function getJson<T>(p: string): Promise<T | null> {
  try {
    const res = await fetch(`${api}${p}`, { signal: AbortSignal.timeout(5000) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
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

function applySettings(next: DesktopSettings): void {
  if (next.hotkey !== hotkey.accelerator) registerHotkey(next.hotkey);
  if (next.source !== prefs.source) checkSource();
  if (next.open_at_login !== loginApplied) {
    loginApplied = next.open_at_login;
    if (next.open_at_login !== loginItemEnabled()) setLoginItem(next.open_at_login);
  }
  prefs = next;
}

function registerHotkey(accelerator: string): void {
  if (hotkey.ok && hotkey.accelerator) globalShortcut.unregister(hotkey.accelerator);
  hotkey = { accelerator, ok: true };
  if (!accelerator) return;
  try {
    hotkey.ok = globalShortcut.register(accelerator, toggleWindow);
    if (!hotkey.ok) hotkey.error = "another app has this shortcut";
  } catch (e) {
    hotkey = { accelerator, ok: false, error: (e as Error).message };
  }
  log(hotkey.ok ? `hotkey ${accelerator}` : `hotkey ${accelerator} failed: ${hotkey.error}`);
}

const autostartFile = () => path.join(envVar("XDG_CONFIG_HOME") ?? path.join(os.homedir(), ".config"), "autostart", "review-desk.desktop");

// Only the packaged app registers itself; from the repo the login item would launch a bare Electron.
function loginItemEnabled(): boolean {
  if (!app.isPackaged) return false;
  if (linux) return fs.existsSync(autostartFile());
  return app.getLoginItemSettings(mac ? undefined : { args: ["--hidden"] }).openAtLogin;
}

function setLoginItem(on: boolean): void {
  if (!app.isPackaged) return;
  log(`open at login: ${on}`);
  if (!linux) {
    app.setLoginItemSettings({ openAtLogin: on, args: ["--hidden"] });
    return;
  }
  const file = autostartFile();
  if (!on) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, desktopEntry(envVar("APPIMAGE") ?? process.execPath, ["--hidden"]));
}

// ---------------------------------------------------------------- window

const stateFile = () => path.join(app.getPath("userData"), "window.json");
const themeFile = () => path.join(app.getPath("userData"), "theme.json");

function readTheme(): string | null {
  try {
    const t = (JSON.parse(fs.readFileSync(themeFile(), "utf8")) as { theme?: unknown }).theme;
    return isTheme(t) ? t : null;
  } catch {
    return null;
  }
}

// The UI's --paper, so the window doesn't flash another theme while it loads.
const paper = () => themeColors(theme, nativeTheme.shouldUseDarkColors).paper;

const startPage = (text: string) => {
  const ink = themeColors(theme, nativeTheme.shouldUseDarkColors).pencil;
  const body = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const page = `<title>Review Desk</title><body style="margin:0;display:grid;place-items:center;height:100vh;background:${paper()};color:${ink};font:14px system-ui;-webkit-app-region:drag"><p style="max-width:32em;text-align:center">${body}</p></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(page)}`;
};

function createWindow(): void {
  let saved: Partial<Bounds> | null = null;
  try {
    // restoreBounds type-checks each field.
    saved = JSON.parse(fs.readFileSync(stateFile(), "utf8")) as Partial<Bounds> | null;
  } catch {}
  const bg = paper();
  const w = new BrowserWindow({
    ...restoreBounds(
      saved,
      screen.getAllDisplays().map((d) => d.workArea),
      { width: 1180, height: 800 },
    ),
    minWidth: 760,
    minHeight: 500,
    title: "Review Desk",
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
      try {
        fs.writeFileSync(stateFile(), JSON.stringify(w.getNormalBounds()));
      } catch {}
    }, 500);
  };
  nativeTheme.on("updated", () => {
    if (!w.isDestroyed()) w.setBackgroundColor(paper());
  });
  w.on("resize", save);
  w.on("move", save);

  w.webContents.on("will-navigate", (e) => {
    if (isAppUrl(e.url, origins)) return;
    e.preventDefault();
    if (isHttpUrl(e.url)) void shell.openExternal(e.url);
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpsUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  void w.loadURL(startPage("Starting Review Desk…"));
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
  void win?.webContents.executeJavaScript(`location.hash = "#/settings"`).catch(() => {});
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
      if (isGitHubUrl(c.url)) void shell.openExternal(c.url);
    },
  }));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open Review Desk",
        accelerator: hotkey.ok && hotkey.accelerator ? hotkey.accelerator : undefined,
        registerAccelerator: false,
        click: showWindow,
      },
      ...(cards.length
        ? [{ type: "separator" as const }, { label: menuLabel(`Queue (${queueCards.length})`), enabled: false }, ...cards]
        : []),
      { type: "separator" },
      { label: "Sync now", click: () => void fetch(`${api}/api/sync`, { method: "POST" }).catch(() => {}) },
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
  else win?.setOverlayIcon(n ? nativeImage.createFromPath(asset("overlay-alert.png")) : null, n ? `${n} in the queue` : "");
}
