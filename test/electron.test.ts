import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  backoff,
  cardLabel,
  commandOutput,
  DESK_ARGS,
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
  loginShellPath,
  menuLabel,
  mergePath,
  parseNotice,
  parseShellPath,
  parseSSE,
  probeHealth,
  restoreBounds,
  SHELL_PATH_COMMAND,
  sourceDir,
  sourceEnv,
  themeColors,
  trayTitle,
  trayTooltip,
  viteArgs,
  watchEvent,
  type DeskPlan,
} from "../electron/lib.ts";

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
    assert.deepEqual(await commandOutput("/bin/sh", ["-c", "printf hi"], 5000), { stdout: "hi", timedOut: false });
    const t0 = Date.now();
    const { stdout, timedOut } = await commandOutput("/bin/sh", ["-c", "trap '' TERM; sleep 30 & echo $!; wait"], 300);
    assert.ok(Date.now() - t0 < 2000, `returned after ${Date.now() - t0}ms`);
    assert.equal(timedOut, true);
    const pid = Number(stdout.trim());
    assert.ok(pid > 0, `the background job's pid: ${JSON.stringify(stdout)}`);
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 20 && alive(); i++) await sleep(50);
    assert.equal(alive(), false, "the rc's child is gone too");
    if (fs.existsSync("/bin/zsh")) {
      const zdot = fs.mkdtempSync(path.join(os.tmpdir(), "desk-zdot-"));
      try {
        fs.writeFileSync(path.join(zdot, ".zshrc"), "sleep 3\n");
        process.env.ZDOTDIR = zdot;
        const t1 = Date.now();
        assert.equal((await commandOutput("/bin/zsh", ["-ilc", SHELL_PATH_COMMAND], 300)).timedOut, true);
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
  const shell = (outs: string[]) => (timeoutMs: number) => {
    tries.push(timeoutMs);
    return Promise.resolve(outs[tries.length - 1] ?? "");
  };
  assert.equal(await loginShellPath(shell(["", "__DESK_PATH__/opt/homebrew/bin:/usr/bin\n__DESK_PATH__"])), "/opt/homebrew/bin:/usr/bin");
  assert.deepEqual(tries, [5000, 20_000], "a slow first shell after a boot gets a second, longer try");
  tries.length = 0;
  assert.equal(await loginShellPath(shell(["__DESK_PATH__/usr/bin__DESK_PATH__"])), "/usr/bin");
  assert.deepEqual(tries, [5000]);
  tries.length = 0;
  assert.equal(await loginShellPath(shell(["noise", "noise"])), null);
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
  const serve = (handler: http.RequestListener) =>
    new Promise<{ base: string; close: () => void }>((resolve) => {
      const s = http.createServer(handler).listen(0, "127.0.0.1", () => {
        resolve({
          base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
          close: () => {
            s.close();
          },
        });
      });
    });

  const desk = await serve((_q, r) => {
    r.writeHead(200, { "content-type": "application/json" }).end(`{"ok":true,"version":"0.1.0"}`);
  });
  assert.deepEqual(await probeHealth(desk.base), { kind: "desk" });
  desk.close();

  const other = await serve((_q, r) => {
    r.writeHead(404).end("nope");
  });
  assert.equal((await probeHealth(other.base)).kind, "other");
  other.close();

  const hung = await serve(() => {});
  const p = await probeHealth(hung.base, 200);
  assert.equal(p.kind, "other");
  hung.close();

  // The port the desk just released is now free.
  assert.deepEqual(await probeHealth(desk.base), { kind: "free" });
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
  assert.deepEqual(parseNotice('{"title":"Review Desk","body":"api#7 · asks you"}'), { title: "Review Desk", body: "api#7 · asks you" });
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
  const problem = (p: DeskPlan) => (p.run === "source" ? "" : (p.problem ?? ""));
  assert.deepEqual(deskPlan("", null), { run: "in-process" }, "no checkout chosen: the app's own desk, as before");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-checkout-"));
  try {
    const notCheckout = deskPlan(dir, "/bin/node");
    assert.equal(notCheckout.run, "in-process", "a wrong folder can still be fixed in Settings");
    assert.match(problem(notCheckout), /isn't a Review Desk checkout/);
    for (const f of ["src/cli.ts", "web/vite.config.ts"]) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), "");
    }
    const noModules = deskPlan(dir, "/bin/node");
    assert.equal(noModules.run, "wait");
    assert.match(problem(noModules), /run npm install there/);
    fs.mkdirSync(path.join(dir, "node_modules/vite/bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules/vite/bin/vite.js"), "");
    const noNode = deskPlan(dir, null);
    assert.equal(noNode.run, "wait", "without node it waits for node; an older bundled desk can't read today's config");
    assert.match(problem(noNode), /Couldn't find node .*Node 22\.18/);
    assert.deepEqual(deskPlan(dir, "/bin/node"), { run: "source", node: "/bin/node" });
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
  assert.equal(watchEvent("2026-11-02T20:32:52.577Z Review Desk on http://localhost:48601"), null);
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
  assert.equal(themeColors("system", true).paper, "#151618");
  assert.equal(themeColors(null, false).paper, "#f7f7f5");
  assert.deepEqual(
    ["system", "slate", "toString", "", 3].map((t) => isTheme(t)),
    [true, true, false, false, false],
  );
});

test("tray title and tooltip", () => {
  assert.equal(trayTitle("desk 7 +3"), "7 +3");
  assert.equal(trayTitle(""), "");
  assert.equal(trayTooltip({ now: 2, today: 5 }), "Review Desk: 7 in the queue");
  assert.equal(trayTooltip({ now: 0, today: 5 }), "Review Desk: 5 in the queue");
  assert.equal(trayTooltip(null), "Review Desk");
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

test("restoreBounds keeps saved bounds only when they're on a screen", () => {
  const screens = [{ x: 0, y: 25, width: 1512, height: 920 }];
  const def = { width: 1180, height: 800 };
  assert.deepEqual(restoreBounds(null, screens, def), def);
  assert.deepEqual(restoreBounds({ x: 100, y: 60, width: 900, height: 600 }, screens, def), { x: 100, y: 60, width: 900, height: 600 });
  assert.deepEqual(restoreBounds({ x: 3000, y: 60, width: 900, height: 600 }, screens, def), { width: 900, height: 600 });
});

test("desktopEntry quotes Exec arguments", () => {
  const text = desktopEntry("/home/me/Apps/Review Desk.AppImage", ["--hidden"]);
  assert.match(text, /^\[Desktop Entry\]\n/);
  assert.match(text, /\nExec="\/home\/me\/Apps\/Review Desk.AppImage" --hidden\n/);
  assert.match(desktopEntry("/opt/a$b/100%", []), /\nExec="\/opt\/a\\\\\$b\/100%%"\n/);
  assert.match(desktopEntry("/usr/bin/review-desk", ["--hidden"]), /\nExec=\/usr\/bin\/review-desk --hidden\n/);
});
