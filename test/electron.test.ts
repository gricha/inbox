import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Effect, Fiber, Scheduler, Schema } from "effect";
import { BadRequest } from "../src/errors.ts";
import { failure, run } from "./helpers/run.ts";
import {
  appRunner,
  backoff,
  APP_FILES,
  cardLabel,
  carryOver,
  commandOutput,
  DESK_ARGS,
  DeskCallFailed,
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
  menuLabel,
  mergePath,
  NoFreePort,
  OLD_APP_NAME,
  parseJson,
  parseNotice,
  parseShellPath,
  parseSSE,
  probeHealth,
  quietly,
  readJson,
  restoreBounds,
  saveBounds,
  SHELL_PATH_COMMAND,
  sourceDir,
  sourceEnv,
  themeColors,
  trayTitle,
  trayTooltip,
  tryOr,
  viteArgs,
  watchEvent,
  type DeskPlan,
  type SSEvent,
} from "../electron/lib.ts";
import { freePort, reap, startSource } from "../electron/source.ts";

// A local server for what the app asks its desk; close() also ends any stream it holds open.
const serve = (handler: http.RequestListener) =>
  new Promise<{ base: string; close: () => void }>((resolve) => {
    const s = http.createServer(handler).listen(0, "127.0.0.1", () => {
      resolve({
        base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
        close: () => {
          s.closeAllConnections();
          s.close();
        },
      });
    });
  });

const isAlive = (pid: number) => tryOr(() => process.kill(pid, 0), false);

test("parseShellPath ignores rc-file noise around the markers", () => {
  const out = `Welcome!\n__DESK_PATH__/opt/homebrew/bin:/usr/bin:/bin\n__DESK_PATH__\nbye`;
  assert.equal(parseShellPath(out), "/opt/homebrew/bin:/usr/bin:/bin");
  assert.equal(parseShellPath("no markers"), null);
  assert.equal(parseShellPath("__DESK_PATH__\n__DESK_PATH__"), null);
  assert.match(SHELL_PATH_COMMAND, /printenv PATH/);
});

test(
  "commandOutput stops a shell that ignores SIGTERM, and what it started, at the deadline",
  { skip: process.platform === "win32" },
  async () => {
    assert.deepEqual(await run(commandOutput("/bin/sh", ["-c", "printf hi"], 5000)), { stdout: "hi", timedOut: false });
    const t0 = Date.now();
    const { stdout, timedOut } = await run(commandOutput("/bin/sh", ["-c", "trap '' TERM; sleep 30 & echo $!; wait"], 300));
    assert.ok(Date.now() - t0 < 2000, `returned after ${Date.now() - t0}ms`);
    assert.equal(timedOut, true);
    const pid = Number(stdout.trim());
    assert.ok(pid > 0, `the background job's pid: ${JSON.stringify(stdout)}`);
    for (let i = 0; i < 20 && isAlive(pid); i++) await sleep(50);
    assert.equal(isAlive(pid), false, "the rc's child is gone too");
    if (fs.existsSync("/bin/zsh")) {
      const zdot = fs.mkdtempSync(path.join(os.tmpdir(), "desk-zdot-"));
      try {
        fs.writeFileSync(path.join(zdot, ".zshrc"), "sleep 3\n");
        process.env.ZDOTDIR = zdot;
        const t1 = Date.now();
        assert.equal((await run(commandOutput("/bin/zsh", ["-ilc", SHELL_PATH_COMMAND], 300))).timedOut, true);
        assert.ok(Date.now() - t1 < 1000, `interactive zsh returned after ${Date.now() - t1}ms`);
      } finally {
        delete process.env.ZDOTDIR;
        fs.rmSync(zdot, { recursive: true, force: true });
      }
    }
  },
);

test("loginShellPath tries the login shell once more, for longer, before giving up on it", async () => {
  const tries: number[] = [];
  const shell = (outs: string[]) => (timeoutMs: number) =>
    Effect.sync(() => {
      tries.push(timeoutMs);
      return outs[tries.length - 1] ?? "";
    });
  assert.equal(
    await run(loginShellPath(shell(["", "__DESK_PATH__/opt/homebrew/bin:/usr/bin\n__DESK_PATH__"]))),
    "/opt/homebrew/bin:/usr/bin",
  );
  assert.deepEqual(tries, [5000, 20_000], "a slow first shell after a boot gets a second, longer try");
  tries.length = 0;
  assert.equal(await run(loginShellPath(shell(["__DESK_PATH__/usr/bin__DESK_PATH__"]))), "/usr/bin");
  assert.deepEqual(tries, [5000]);
  tries.length = 0;
  assert.equal(await run(loginShellPath(shell(["noise", "noise"]))), null);
  assert.equal(tries.length, 2);
});

test("mergePath keeps order and drops repeats and empties", () => {
  assert.equal(mergePath(":", "/a:/b", "/usr/bin:/a::", "/c", ""), "/a:/b:/usr/bin:/c");
});

test("fallbackDirs: the usual dirs, then where nvm, Volta, mise, asdf and fnm keep node", () => {
  const usual = ["/opt/homebrew/bin", "/usr/local/bin", "/h/.local/bin", "/h/bin"];
  const disk = (versions: string[], aliases: Record<string, string>, dirs: string[] = []) => {
    const has = new Set([...versions.map((v) => `/h/.nvm/versions/node/${v}/bin`), ...dirs]);
    return {
      isDir: (p: string) => has.has(p),
      read: (p: string) => (p.startsWith("/h/.nvm/alias/") ? (aliases[p.slice("/h/.nvm/alias/".length)] ?? null) : null),
      list: (p: string) => (p === "/h/.nvm/versions/node" ? versions : []),
    };
  };
  const nvm = (versions: string[], aliases: Record<string, string>) => fallbackDirs("/h", disk(versions, aliases)).slice(usual.length);
  const bin = (v: string) => [`/h/.nvm/versions/node/${v}/bin`];

  assert.deepEqual(fallbackDirs("/h", disk([], {})), usual, "gh and claude are looked for where they were");
  const installed = ["v22.9.0", "v24.14.0", "v22.22.0", "v20.20.2"];
  assert.deepEqual(nvm(installed, { default: "22" }), bin("v22.22.0"), "a partial version is the newest it matches");
  assert.deepEqual(nvm(installed, { default: "v22.9.0\n" }), bin("v22.9.0"));
  assert.deepEqual(nvm(installed, { default: "node" }), bin("v24.14.0"));
  assert.deepEqual(
    nvm(installed, { default: "lts/*", "lts/*": "lts/iron", "lts/iron": "v20.20.2" }),
    bin("v20.20.2"),
    "aliases are followed",
  );
  assert.deepEqual(
    nvm(installed, { default: "lts/*", "lts/*": "lts/krypton", "lts/krypton": "v24.16.0" }),
    bin("v24.14.0"),
    "not installed: the newest",
  );
  assert.deepEqual(nvm(installed, { default: "2" }), bin("v24.14.0"), "2 isn't 22");
  assert.deepEqual(nvm(installed, { default: "a", a: "b", b: "a" }), bin("v24.14.0"), "an alias loop ends");
  assert.deepEqual(nvm(installed, {}), bin("v24.14.0"), "no default alias");
  assert.deepEqual(nvm(["v22.22.0", "system", ".DS_Store"], {}), bin("v22.22.0"));

  const managers = ["/h/.volta/bin", "/h/.local/share/mise/shims", "/h/.asdf/shims", "/h/.local/share/fnm/aliases/default/bin"];
  assert.deepEqual(fallbackDirs("/h", disk(["v22.22.0"], { default: "22" }, managers)), [...usual, ...bin("v22.22.0"), ...managers]);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-home-"));
  try {
    fs.mkdirSync(path.join(home, ".nvm/versions/node/v22.22.0/bin"), { recursive: true });
    fs.mkdirSync(path.join(home, ".nvm/alias"), { recursive: true });
    fs.writeFileSync(path.join(home, ".nvm/alias/default"), "22\n");
    fs.mkdirSync(path.join(home, ".volta/bin"), { recursive: true });
    assert.deepEqual(fallbackDirs(home).slice(usual.length), [`${home}/.nvm/versions/node/v22.22.0/bin`, `${home}/.volta/bin`], "on disk");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("envVar treats an empty variable as unset", () => {
  process.env.DESK_TEST_VAR = "";
  try {
    assert.equal(envVar("DESK_TEST_VAR"), undefined);
    process.env.DESK_TEST_VAR = "x";
    assert.equal(envVar("DESK_TEST_VAR"), "x");
    assert.equal(envVar("DESK_TEST_UNSET_VAR"), undefined);
  } finally {
    delete process.env.DESK_TEST_VAR;
  }
});

test("probeHealth: a desk, nothing, or something else", async () => {
  const desk = await serve((_q, r) => {
    r.writeHead(200, { "content-type": "application/json" }).end(`{"ok":true,"version":"0.1.0"}`);
  });
  assert.deepEqual(await run(probeHealth(desk.base)), { kind: "desk" });
  desk.close();

  const other = await serve((_q, r) => {
    r.writeHead(404).end("nope");
  });
  assert.equal((await run(probeHealth(other.base))).kind, "other");
  other.close();

  const hung = await serve(() => {});
  const p = await run(probeHealth(hung.base, 200));
  assert.deepEqual(
    p,
    { kind: "other", detail: "The operation was aborted due to timeout" },
    "a desk too busy to answer isn't one to replace",
  );
  hung.close();

  // The port the desk just released is now free.
  assert.deepEqual(await run(probeHealth(desk.base)), { kind: "free" });
});

test("backoff doubles up to 30s", () => {
  assert.deepEqual([0, 1, 2, 10].map(backoff), [1000, 2000, 4000, 30_000]);
});

test("parseSSE returns complete events and keeps the tail", () => {
  const { events, rest } = parseSSE(`event: update\ndata: {"rev":1}\n\n: ping\n\nevent: update\r\ndata: {"rev":2}\r\n\r\nevent: upd`);
  assert.deepEqual(events, [
    { event: "update", data: `{"rev":1}` },
    { event: "update", data: `{"rev":2}` },
  ]);
  assert.equal(rest, "event: upd");
  assert.deepEqual(parseSSE(rest + "ate\ndata: x\n\n").events, [{ event: "update", data: "x" }]);
});

test("desktopSettings falls back to the defaults", () => {
  assert.deepEqual(desktopSettings(), { hotkey: "Control+Alt+D", open_at_login: false, menu_bar_count: true, source: "" });
  assert.deepEqual(
    desktopSettings({ "app.hotkey": "", "app.open_at_login": true, "app.menu_bar_count": false, "app.source": "~/code/review-desk" }),
    { hotkey: "", open_at_login: true, menu_bar_count: false, source: "~/code/review-desk" },
  );
});

test("parseNotice reads a desk's notify event and ignores anything else", () => {
  assert.deepEqual(parseNotice('{"title":"Inbox","body":"api#7 · asks you"}'), { title: "Inbox", body: "api#7 · asks you" });
  for (const bad of ["", "null", '{"title":1,"body":"x"}', '{"title":"t"}', "{"]) assert.equal(parseNotice(bad), null, bad);
});

test("sourceDir: off when empty, ~ is your home, relative paths resolve", () => {
  assert.equal(sourceDir("", "/Users/me"), "");
  assert.equal(sourceDir("  ", "/Users/me"), "");
  assert.equal(sourceDir("~", "/Users/me"), path.resolve("/Users/me"));
  assert.equal(sourceDir(" ~/code/review-desk/ ", "/Users/me"), path.resolve("/Users/me/code/review-desk"));
  assert.equal(sourceDir("/opt/desk", "/Users/me"), path.resolve("/opt/desk"));
  assert.equal(sourceDir("~other/desk", "/Users/me"), path.resolve("~other/desk"), "only ~ and ~/ mean your home");
});

test("deskPlan: a chosen checkout runs from source or waits for what it lacks, never the app's own desk", () => {
  const waits = (p: DeskPlan) => (p.run === "wait" ? `${p.need}: ${p.problem}` : p.run);
  const node = (version: string) => ({ path: "/bin/node", version });
  assert.deepEqual(deskPlan("", null), { run: "in-process" }, "no checkout chosen: the app's own desk, as before");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-checkout-"));
  try {
    assert.match(
      waits(deskPlan(dir, node("v22.22.0\n"))),
      /^checkout: .* isn't an Inbox checkout/,
      "a wrong folder waits too, never the app's own desk",
    );
    for (const f of ["src/cli.ts", "web/vite.config.ts"]) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), "");
    }
    assert.match(waits(deskPlan(dir, node("v22.22.0\n"))), /^modules: .*run npm install there/);
    fs.mkdirSync(path.join(dir, "node_modules/vite/bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules/vite/bin/vite.js"), "");
    assert.match(
      waits(deskPlan(dir, null)),
      /^node: Couldn't find node .*Node 22\.18/,
      "without node it waits for node; an older bundled desk can't read today's config",
    );
    assert.equal(
      waits(deskPlan(dir, null, fs.existsSync, "win32")),
      "node: Couldn't find node on PATH; install Node 22.18 or newer",
      "Windows has no login shell or version-manager dirs to name",
    );
    assert.deepEqual(deskPlan(dir, node("v22.22.0\n")), { run: "source", node: "/bin/node" });
    for (const v of ["v22.18.0", "v23.1.0", "v24.14.0"]) assert.equal(deskPlan(dir, node(v)).run, "source", v);
    assert.equal(
      waits(deskPlan(dir, node("v20.20.2\n"))),
      "node: /bin/node is Node 20.20.2; the desk needs 22.18 or newer",
      "nvm's lts/iron",
    );
    assert.match(waits(deskPlan(dir, node("v22.17.1"))), /^node: .*Node 22\.17\.1/);
    assert.match(waits(deskPlan(dir, node(""))), /^node: \/bin\/node didn't say its version/, "a node that doesn't run");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("findNode: the first node on PATH, absolute dirs only", () => {
  const exe = process.platform === "win32" ? "node.exe" : "node";
  const has = new Set([path.join("/b", exe), path.join("/c", exe)]);
  const isFile = (p: string) => has.has(p);
  assert.equal(findNode(["/a", "/b", "/c"].join(path.delimiter), path.delimiter, isFile), path.join("/b", exe));
  assert.equal(
    findNode(["", "b"].join(path.delimiter), path.delimiter, () => true),
    null,
    "a relative PATH entry isn't trusted",
  );
  assert.equal(findNode(path.dirname(process.execPath)), process.execPath, "finds a real one");
});

test("the desk runs under node --watch on all of src/, Vite on one exact port", () => {
  assert.deepEqual(DESK_ARGS.slice(0, 2), ["--watch", "--watch-path=src"]);
  assert.deepEqual(DESK_ARGS.slice(-2), ["src/cli.ts", "serve"]);
  assert.equal(
    viteArgs(48123).join(" "),
    "node_modules/vite/bin/vite.js --config web/vite.config.ts --host 127.0.0.1 --port 48123 --strictPort",
  );
});

test("watchEvent reads node --watch's own lines", () => {
  assert.equal(watchEvent("Restarting 'src/cli.ts'"), "restart");
  assert.equal(watchEvent("Failed running 'src/cli.ts'. Waiting for file changes before restarting..."), "exit");
  assert.equal(watchEvent("Completed running 'src/cli.ts'. Waiting for file changes before restarting..."), "exit");
  assert.equal(watchEvent("2026-11-02T20:32:52.577Z Inbox on http://localhost:48601"), null);
  assert.equal(watchEvent("  Restarting 'src/cli.ts'"), null, "the desk's own output doesn't count");
});

test("sourceEnv: the desk's port and home, exactly the UI's origin, and no DESK_DEV", () => {
  const env = sourceEnv(
    { PATH: "/usr/bin", DESK_DEV: "1", DESK_DEV_PORT: "5174", DESK_SOURCE: "/x", DESK_PORT: "1", DESK_CLAUDE: "/fake" },
    { port: 48601, home: "/tmp/h", ui: "http://127.0.0.1:48602" },
  );
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    DESK_CLAUDE: "/fake",
    DESK_PORT: "48601",
    DESK_HOME: "/tmp/h",
    DESK_UI_ORIGIN: "http://127.0.0.1:48602",
    DESK_API: "http://127.0.0.1:48601",
  });
});

test("the window's colours before the UI paints follow this device's theme, else the OS", () => {
  assert.equal(themeColors("slate", false).paper, "#1b2028");
  assert.equal(themeColors("sand", true).paper, "#f3eee5");
  assert.equal(themeColors("system", true).paper, "#14171c");
  assert.equal(themeColors(null, false).paper, "#f5f6f8");
  assert.equal(themeColors("omarchy", true).paper, "#14171c");
  assert.deepEqual(
    ["system", "slate", "omarchy", "toString", "", 3].map((t) => isTheme(t)),
    [true, true, true, false, false, false],
  );
});

test("tray title and tooltip", () => {
  assert.equal(trayTitle("desk 7 +3"), "7 +3");
  assert.equal(trayTitle(""), "");
  assert.equal(trayTooltip({ now: 2, today: 5 }), "Inbox: 7");
  assert.equal(trayTooltip({ now: 0, today: 5 }), "Inbox: 5");
  assert.equal(trayTooltip(null), "Inbox");
});

test("menu labels escape & and are cut to 60 chars", () => {
  assert.equal(menuLabel("Fix A & B"), "Fix A && B");
  const long = menuLabel("x".repeat(50) + " a & b & c & d");
  assert.equal(long, "x".repeat(50) + " a && b &&…");
  assert.equal(menuLabel("a".repeat(59) + "&b"), "a".repeat(59) + "…"); // never splits &&
  assert.equal(cardLabel({ repo: "getsentry/seer", number: 12, title: "Ship\nit" }), "seer#12 Ship it");
});

test("URL checks", () => {
  const origins = ["http://localhost:47823", "http://127.0.0.1:47823"];
  assert.ok(isAppUrl("http://localhost:47823/#/settings", origins));
  assert.ok(!isAppUrl("http://localhost:47824/", origins));
  assert.ok(!isAppUrl("https://localhost:47823/", origins));
  assert.ok(!isAppUrl("not a url", origins));
  assert.ok(isHttpUrl("http://example.com") && isHttpUrl("https://example.com"));
  assert.ok(!isHttpUrl("file:///etc/passwd") && !isHttpUrl("javascript:alert(1)"));
  assert.ok(isHttpsUrl("https://github.com") && !isHttpsUrl("http://github.com"));
  assert.ok(isGitHubUrl("https://github.com/getsentry/seer/pull/12"));
  assert.ok(
    !isGitHubUrl("http://github.com/x") && !isGitHubUrl("https://github.com.evil.example/x") && !isGitHubUrl("https://gist.github.com/x"),
  );
});

test("an inbox:// link, at launch or handed to a second instance, routes the window to its item or page", () => {
  // Windows and Linux put the link among Chromium's switches; from the repo, after the app's path.
  assert.equal(linkArg(["Inbox.exe", "--allow-file-access-from-files", "inbox://item/acme/api/7"]), "inbox://item/acme/api/7");
  assert.equal(linkArg(["electron", ".", "INBOX://blocked"]), "INBOX://blocked");
  assert.equal(linkArg(["Inbox.exe", "--hidden"]), undefined);
  assert.equal(linkHash("inbox://item/acme/api/7"), "#/item/acme%2Fapi%237");
  assert.equal(linkHash("inbox://merging"), "#/inflight");
  assert.equal(linkHash("inbox://fyi/"), "#/later");
  assert.equal(linkHash("inbox://inbox"), "#/");
  assert.equal(linkHash("inbox://question/1c0ffee2"), "#/inquiry/1c0ffee2");
  // What names nothing just brings the window forward; an http link isn't the app's to route.
  for (const link of ["inbox://item/acme", "inbox://settings", "http://localhost:47823/#/review/acme%2Fapi%237"])
    assert.equal(linkHash(link), null, link);
});

test("keepsView: after the desk comes back, only a window still on its UI reloads; the wait page loads the UI", () => {
  const origins = ["http://localhost:47823", "http://127.0.0.1:47823"];
  const waitPage = "data:text/html;charset=utf-8,%3Ctitle%3EReview%20Desk";
  assert.equal(keepsView("http://localhost:47823/#/pr/o/r/1", origins, false), true, "attached again: the same view");
  assert.equal(keepsView(waitPage, origins, false), false, "waited, then attached or started here: load the UI");
  assert.equal(keepsView("chrome-error://chromewebdata/", origins, false), false);
  assert.equal(keepsView("", origins, false), false);
  assert.equal(keepsView("http://localhost:47823/", origins, true), false, "from source: the UI is on Vite now");
});

test("restoreBounds keeps saved bounds only when they're on a screen", () => {
  const screens = [{ x: 0, y: 25, width: 1512, height: 920 }];
  const def = { width: 1180, height: 800 };
  assert.deepEqual(restoreBounds(null, screens, def), def);
  assert.deepEqual(restoreBounds({ x: 100, y: 60, width: 900, height: 600 }, screens, def), { x: 100, y: 60, width: 900, height: 600 });
  assert.deepEqual(restoreBounds({ x: 3000, y: 60, width: 900, height: 600 }, screens, def), { width: 900, height: 600 });
});

test("saveBounds writes where the window is, and nothing for one destroyed before its save timer fired", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-bounds-"));
  try {
    const file = path.join(dir, "window.json");
    const bounds = { x: 100, y: 60, width: 900, height: 600 };
    saveBounds({ isDestroyed: () => false, getNormalBounds: () => bounds }, file);
    assert.deepEqual(readJson(file), bounds);
    fs.rmSync(file);
    const destroyed = {
      isDestroyed: () => true,
      getNormalBounds: (): typeof bounds => {
        throw new TypeError("Object has been destroyed");
      },
    };
    saveBounds(destroyed, file);
    assert.equal(fs.existsSync(file), false);
    saveBounds({ isDestroyed: () => false, getNormalBounds: () => bounds }, path.join(dir, "no-such-dir", "window.json"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("carryOver: Inbox's first start copies the window's place and the theme from Review Desk's folder, never over its own", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-carry-"));
  try {
    const old = path.join(dir, "Review Desk");
    const mine = path.join(dir, "Inbox");
    fs.mkdirSync(path.join(old, "Local Storage"), { recursive: true });
    fs.writeFileSync(path.join(old, "window.json"), '{"width":900}');
    fs.writeFileSync(path.join(old, "theme.json"), '{"theme":"slate"}');
    fs.writeFileSync(path.join(old, "Local Storage", "000003.log"), "chromium's");
    assert.deepEqual(APP_FILES, ["window.json", "theme.json"]);
    assert.equal(OLD_APP_NAME, "Review Desk");
    assert.deepEqual(await run(carryOver(old, mine)), ["window.json", "theme.json"]);
    assert.equal(fs.readFileSync(path.join(mine, "theme.json"), "utf8"), '{"theme":"slate"}');
    assert.deepEqual(fs.readdirSync(mine).toSorted(), ["theme.json", "window.json"], "Chromium's own files stay behind");
    assert.ok(fs.existsSync(path.join(old, "window.json")), "copied, not moved");
    fs.writeFileSync(path.join(mine, "theme.json"), '{"theme":"dark"}');
    fs.rmSync(path.join(mine, "window.json"));
    assert.deepEqual(await run(carryOver(old, mine)), ["window.json"], "only what it lacks");
    assert.equal(fs.readFileSync(path.join(mine, "theme.json"), "utf8"), '{"theme":"dark"}', "the new app's own choice stays");
    assert.deepEqual(await run(carryOver(path.join(dir, "never"), path.join(dir, "fresh"))), []);
    assert.equal(fs.existsSync(path.join(dir, "fresh")), false, "nothing to carry: nothing made");
    fs.rmSync(mine, { recursive: true });
    fs.writeFileSync(mine, "a file where the folder goes");
    const e = await failure(carryOver(old, mine));
    assert.deepEqual([e._tag, e.op], ["FsError", "mkdir"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("desktopEntry quotes Exec arguments", () => {
  const text = desktopEntry("/home/me/My Apps/Inbox.AppImage", ["--hidden"]);
  assert.match(text, /^\[Desktop Entry\]\nType=Application\nName=Inbox\n/);
  assert.match(text, /\nExec="\/home\/me\/My Apps\/Inbox.AppImage" --hidden\n/);
  assert.match(desktopEntry("/opt/a$b/100%", []), /\nExec="\/opt\/a\\\\\$b\/100%%"\n/);
  assert.match(desktopEntry("/usr/bin/inbox", ["--hidden"]), /\nExec=\/usr\/bin\/inbox --hidden\n/);
});

test("commandOutput: one spawn refuses before it starts gives no output, like one that fails to start", async () => {
  assert.deepEqual(await run(commandOutput("bad\0command", [], 5000)), { stdout: "", timedOut: false });
  assert.deepEqual(await run(commandOutput(path.join(os.tmpdir(), "desk-no-such-command"), [], 5000)), { stdout: "", timedOut: false });
});

test("commandOutput: a spawn failure is heard however soon its fiber yields", async () => {
  const missing = path.join(os.tmpdir(), "desk-no-such-command");
  // From 3: below it, the runtime itself misses timers.
  for (let ops = 3; ops <= 8; ops++)
    assert.deepEqual(await run(Effect.provideService(commandOutput(missing, [], 5000), Scheduler.MaxOpsBeforeYield, ops)), {
      stdout: "",
      timedOut: false,
    });
});

test("commandOutput interrupted stops its whole group before it ends", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-cmd-"));
  try {
    const file = path.join(dir, "pid");
    const fiber = Effect.runFork(commandOutput("/bin/sh", ["-c", `sleep 30 & echo $! > ${file}; wait`], 60_000));
    for (let i = 0; i < 100 && !fs.existsSync(file); i++) await sleep(20);
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    assert.ok(isAlive(pid));
    await Effect.runPromise(Fiber.interrupt(fiber));
    for (let i = 0; i < 20 && isAlive(pid); i++) await sleep(50);
    assert.equal(isAlive(pid), false, "what the shell started went with it");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tryOr, quietly, parseJson and readJson: what may not be there is a fallback, never a throw", () => {
  assert.equal(
    tryOr(() => {
      throw new Error("gone");
    }, "fallback"),
    "fallback",
  );
  assert.equal(
    tryOr(() => 7, 0),
    7,
  );
  quietly(() => {
    throw new Error("ignored");
  });
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  for (const bad of ["", "{", "undefined"]) assert.equal(parseJson(bad), null, bad);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-json-"));
  try {
    fs.writeFileSync(path.join(dir, "ok.json"), '{"theme":"slate"}');
    fs.writeFileSync(path.join(dir, "bad.json"), "{theme");
    assert.deepEqual(readJson(path.join(dir, "ok.json")), { theme: "slate" });
    assert.equal(readJson(path.join(dir, "bad.json")), null);
    assert.equal(readJson(path.join(dir, "missing.json")), null);
    assert.equal(readJson(dir), null, "a directory");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the app's own failures keep the words of what failed", () => {
  const aborted = Object.assign(new Error("ERR_ABORTED (-3) loading 'data:text/html,…'"), { code: "ERR_ABORTED", errno: -3 });
  assert.equal(new ElectronRefused({ cause: aborted }).aborted, true, "a load the next one superseded");
  const refused = new ElectronRefused({
    cause: Object.assign(new Error("ERR_CONNECTION_REFUSED (-102)"), { code: "ERR_CONNECTION_REFUSED" }),
  });
  assert.equal(refused.aborted, false);
  assert.equal(refused.message, "ERR_CONNECTION_REFUSED (-102)");
  assert.equal(new ElectronRefused({ cause: "no" }).aborted, false);
  assert.equal(new DeskCallFailed({ url: "http://127.0.0.1:1/api/events", status: 503 }).message, "HTTP 503");
  assert.equal(new DeskCallFailed({ url: "http://127.0.0.1:1/api/events", cause: new TypeError("fetch failed") }).message, "fetch failed");
  assert.equal(new DeskCallFailed({ url: "http://127.0.0.1:1/api/events" }).message, "no answer from http://127.0.0.1:1/api/events");
  assert.equal(
    new DeskFailed({ cause: new Error("port 47823 is in use; is desk already running?") }).message,
    "port 47823 is in use; is desk already running?",
  );
  assert.equal(
    new NoFreePort({ cause: new Error("listen EPERM: operation not permitted 127.0.0.1") }).message,
    "listen EPERM: operation not permitted 127.0.0.1",
  );
});

test("ipcAnswer: the renderer gets the value, or a plain Error with a failure's words; a bug is logged too", async () => {
  const lines: string[] = [];
  const log = (m: string) => {
    lines.push(m);
  };
  assert.deepEqual(await ipcAnswer("desktop:status", Effect.succeed({ ok: true }), log), { ok: true });
  await assert.rejects(ipcAnswer("desktop:set-theme", Effect.fail(new BadRequest({ message: "no such theme" })), log), (e: unknown) => {
    assert.ok(e instanceof Error);
    assert.equal(e.constructor, Error, "only the message survives the structured clone, so only a message is sent");
    assert.equal(e.message, "no such theme");
    return true;
  });
  assert.deepEqual(lines, [], "a refusal is the renderer's to show");
  await assert.rejects(
    ipcAnswer(
      "desktop:status",
      Effect.sync(() => {
        throw new TypeError("boom");
      }),
      log,
    ),
    /boom/,
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^desktop:status failed: .*boom/s);
});

test("appRunner logs what fails in the app's background work, and nothing for an interrupt", async () => {
  const lines: string[] = [];
  const runner = appRunner((m) => {
    lines.push(m);
  });
  const failed = runner.fork("opening a link", Effect.fail(new ElectronRefused({ cause: new Error("no handler for this URL") })));
  await Effect.runPromise(Fiber.await(failed!));
  const died = runner.fork(
    "refreshing the tray",
    Effect.sync(() => {
      throw new Error("a bug");
    }),
  );
  await Effect.runPromise(Fiber.await(died!));
  const cut = runner.fork("following the desk", Effect.never);
  await Effect.runPromise(Fiber.interrupt(cut!));
  assert.equal(lines.length, 2, lines.join("\n"));
  assert.match(lines[0]!, /^opening a link failed: .*no handler for this URL/s);
  assert.match(lines[1]!, /^refreshing the tray failed: .*a bug/s);
});

test("getJson: the desk's answer, or null while it's starting, unreachable or unreadable", async () => {
  const desk = await serve((q, r) => {
    if (q.url === "/api/status") r.writeHead(200, { "content-type": "application/json" }).end(`{"now":2,"today":5}`);
    else if (q.url === "/api/bad") r.writeHead(200, { "content-type": "application/json" }).end("{");
    else if (q.url === "/api/shape") r.writeHead(200, { "content-type": "application/json" }).end(`{"now":"2"}`);
    else r.writeHead(503, { "content-type": "application/json" }).end(`{"error":"desk is starting"}`);
  });
  const Counts = Schema.Struct({ now: Schema.Number, today: Schema.Number });
  try {
    assert.deepEqual(await run(getJson(`${desk.base}/api/status`, Counts)), { now: 2, today: 5 });
    assert.equal(await run(getJson(`${desk.base}/api/focus`, Counts)), null, "starting");
    assert.equal(await run(getJson(`${desk.base}/api/bad`, Counts)), null, "not JSON");
    assert.equal(await run(getJson(`${desk.base}/api/shape`, Counts)), null, "not its shape");
  } finally {
    desk.close();
  }
  assert.equal(await run(getJson(`${desk.base}/api/status`, Counts)), null, "nothing there");
});

test("followEvents: each event until the stream ends; no answer, an HTTP error or a dropped stream is DeskCallFailed", async () => {
  let drop = false;
  const desk = await serve((q, r) => {
    if (q.url === "/starting") {
      r.writeHead(503).end();
      return;
    }
    r.writeHead(200, { "content-type": "text/event-stream" });
    r.write(`event: update\ndata: {"rev":1}\n\nevent: notify\ndata: {"title":"Inbox","body":"api#7"}\n\n`);
    r.write("event: upd");
    setTimeout(() => {
      if (drop) r.destroy();
      else r.end("ate\ndata: 2\n\n");
    }, 20);
  });
  try {
    const seen: SSEvent[] = [];
    let connected = 0;
    const on = {
      connected: () => {
        connected++;
      },
      event: (e: SSEvent) => {
        seen.push(e);
      },
    };
    await run(followEvents(`${desk.base}/api/events`, on));
    assert.equal(connected, 1);
    assert.deepEqual(seen, [
      { event: "update", data: `{"rev":1}` },
      { event: "notify", data: `{"title":"Inbox","body":"api#7"}` },
      { event: "update", data: "2" },
    ]);

    drop = true;
    seen.length = 0;
    const dropped = await failure(followEvents(`${desk.base}/api/events`, on));
    assert.equal(dropped._tag, "DeskCallFailed");
    assert.equal(seen.length, 2, "what came before it dropped");

    const starting = await failure(followEvents(`${desk.base}/starting`, on));
    assert.equal(starting._tag, "DeskCallFailed");
    assert.equal(starting.message, "HTTP 503");
    assert.equal(connected, 2, "a 503 isn't connected");
  } finally {
    desk.close();
  }
  assert.equal((await failure(followEvents(`${desk.base}/api/events`, { connected() {}, event() {} })))._tag, "DeskCallFailed");
});

test("followEvents interrupted lets go of the stream", async () => {
  let closed: () => void = () => {};
  const gone = new Promise<void>((resolve) => {
    closed = resolve;
  });
  let opened: () => void = () => {};
  const open = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const desk = await serve((q, r) => {
    r.writeHead(200, { "content-type": "text/event-stream" });
    r.write(": ping\n\n");
    q.on("close", closed);
  });
  try {
    const fiber = Effect.runFork(followEvents(`${desk.base}/api/events`, { connected: opened, event() {} }));
    await open;
    await Effect.runPromise(Fiber.interrupt(fiber));
    await gone;
  } finally {
    desk.close();
  }
});

test("freePort gives a port the UI's dev server can listen on", async () => {
  const port = await run(freePort());
  assert.ok(Number.isInteger(port) && port > 0);
  const s = http.createServer();
  await new Promise<void>((resolve) => {
    s.listen(port, "127.0.0.1", resolve);
  });
  s.close();
});

test("reap stops only what an earlier run left going from source, then forgets it", { skip: process.platform === "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-reap-"));
  const file = path.join(home, "live.json");
  const lines: string[] = [];
  const log = (m: string) => {
    lines.push(m);
  };
  const idle = (...args: string[]) =>
    spawn(process.execPath, ["-e", "process.stdout.write('up'); setInterval(() => {}, 1000)", ...args], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  const left = idle("--", "--watch-path=src"); // as a script argument: node runs no --watch with -e
  const other = idle();
  // Until it has started, ps shows a child with the command line of what forked it.
  const up = (c: ReturnType<typeof idle>) =>
    new Promise((resolve) => {
      c.stdout.once("data", resolve);
      c.once("exit", resolve); // one that never ran fails the assertions below instead of hanging here
    });
  try {
    await Promise.all([up(left), up(other)]);
    await run(reap(home, log));
    assert.deepEqual(lines, [], "nothing was left");

    fs.writeFileSync(file, "{not json");
    await run(reap(home, log));
    assert.ok(fs.existsSync(file), "one it can't read stays as it is");

    fs.writeFileSync(file, JSON.stringify({ pids: [left.pid, other.pid, 999_999_999] }));
    await run(reap(home, log));
    for (let i = 0; i < 20 && isAlive(left.pid!); i++) await sleep(50);
    assert.equal(isAlive(left.pid!), false, "the desk an earlier run left going");
    assert.equal(isAlive(other.pid!), true, "a pid that went to something else since");
    assert.deepEqual(lines, [`stopping what an earlier run left going from source (pid ${left.pid})`]);
    assert.equal(fs.existsSync(file), false);

    if (process.getuid?.() !== 0) {
      fs.writeFileSync(file, JSON.stringify({ pids: [] }));
      fs.chmodSync(home, 0o500);
      try {
        const e = await failure(reap(home, log));
        assert.equal(e._tag, "FsError");
        assert.match(e.message, /EACCES|EPERM/);
      } finally {
        fs.chmodSync(home, 0o700);
      }
    }
  } finally {
    left.kill("SIGKILL");
    other.kill("SIGKILL");
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("startSource: a node that spawn refuses to start is a failure the restart loop handles, never a throw", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-source-"));
  const logged: string[] = [];
  try {
    const source = await run(
      startSource({
        dir: home,
        node: "bad\0node",
        port: 1,
        home,
        log: (m) => {
          logged.push(m);
        },
      }),
    );
    const status = source.status();
    assert.equal(status.state, "failed");
    assert.match(status.detail ?? "", /^couldn't run node: .*null bytes/);
    assert.ok(logged.some((m) => m.startsWith("desk from source: couldn't run node: ")));
    const liveLog = () => fs.readFileSync(path.join(home, "live.log"), "utf8");
    assert.match(liveLog(), /desk: couldn't run node: .*; starting it again in 2s/);
    t.mock.timers.tick(2000);
    assert.match(liveLog(), /desk: couldn't run node: .*; starting it again in 4s/, "it tries again, backing off");
    await run(source.stop());
    await run(source.uiReady()); // stopped: nothing to wait for
    assert.match(liveLog(), /stopped\n$/);
    t.mock.timers.tick(4000);
    assert.doesNotMatch(liveLog().split("stopped\n")[1] ?? "", /starting/, "a stopped source starts nothing");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test(
  "startSource's restart loop: a node that exits backs off up to 30 s, a minute up starts the count again, and a node_modules change restarts the desk at once",
  { skip: process.platform === "win32", timeout: 30_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-source-"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-checkout-"));
    fs.mkdirSync(path.join(dir, "node_modules"));
    const lock = path.join(dir, "node_modules", ".package-lock.json");
    fs.writeFileSync(lock, "{}");
    // A fake node: Vite exits 1 at once (or once hold is gone); the desk says a line and runs until it's stopped.
    const node = path.join(home, "node");
    const hold = path.join(home, "hold");
    fs.writeFileSync(
      node,
      `#!/bin/sh\ncase "$*" in *vite*) while [ -f "${hold}" ]; do sleep 0.02; done; exit 1;; esac\necho desk up\nexec sleep 30\n`,
    );
    fs.chmodSync(node, 0o755);
    const liveLog = () => tryRead(path.join(home, "live.log"));
    const lines = () => liveLog().split("\n");
    // Real time, by setImmediate: setTimeout and Date are the test's.
    const until = async (cond: () => boolean, what: string) => {
      const deadline = performance.now() + 10_000;
      while (!cond()) {
        if (performance.now() > deadline) assert.fail(`timed out waiting for ${what}:\n${liveLog()}`);
        await new Promise((r) => {
          setImmediate(r);
        });
      }
    };
    const count = (re: RegExp) => lines().filter((l) => re.test(l)).length;
    const viteBackoff = (s: number) => new RegExp(`vite: node exited \\(1\\); starting it again in ${s}s$`);
    const source = await run(startSource({ dir, node, port: 1, home, log: () => {} }));
    try {
      await until(() => count(viteBackoff(2)) === 1, "vite's first backoff");
      for (const [waited, next] of [
        [2, 4],
        [4, 8],
        [8, 16],
        [16, 30],
      ] as const) {
        t.mock.timers.tick(waited * 1000);
        await until(() => count(viteBackoff(next)) === 1, `vite backing off ${next}s`);
      }
      // Up for over a minute before it exits: the count starts again.
      fs.writeFileSync(hold, "");
      const starts = count(/app \| .* starting .*vite/);
      t.mock.timers.tick(30_000);
      await until(() => count(/app \| .* starting .*vite/) === starts + 1, "vite started again");
      t.mock.timers.tick(61_000);
      fs.rmSync(hold);
      await until(() => count(viteBackoff(1)) === 1, "vite's backoff starting over");

      // npm install: the desk's node is stopped and started again with no backoff (watchFile polls every 2 s).
      await until(() => liveLog().includes("desk | desk up"), "the desk up");
      const desks = count(/app \| .* starting .*--watch/);
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(lock, later, later);
      await until(() => count(/app \| .* starting .*--watch/) === desks + 1, "the desk started again");
      const changed = lines().findIndex((l) => l.includes("node_modules changed; starting the desk again"));
      assert.ok(changed >= 0, liveLog());
      assert.ok(
        lines()
          .slice(changed)
          .every((l) => !/desk: .*starting it again in/.test(l)),
        "no backoff between",
      );
    } finally {
      await run(source.stop());
    }
    assert.equal(fs.existsSync(path.join(home, "live.json")), false);
    assert.match(liveLog(), /stopped\n$/);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  },
);

function tryRead(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}
