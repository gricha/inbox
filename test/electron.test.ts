import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  backoff,
  cardLabel,
  desktopEntry,
  desktopSettings,
  envVar,
  isAppUrl,
  isGitHubUrl,
  isHttpsUrl,
  isHttpUrl,
  menuLabel,
  mergePath,
  parseShellPath,
  parseSSE,
  probeHealth,
  restoreBounds,
  SHELL_PATH_COMMAND,
  trayTitle,
  trayTooltip,
} from "../electron/lib.ts";

test("parseShellPath ignores rc-file noise around the markers", () => {
  const out = `Welcome!\n__DESK_PATH__/opt/homebrew/bin:/usr/bin:/bin\n__DESK_PATH__\nbye`;
  assert.equal(parseShellPath(out), "/opt/homebrew/bin:/usr/bin:/bin");
  assert.equal(parseShellPath("no markers"), null);
  assert.equal(parseShellPath("__DESK_PATH__\n__DESK_PATH__"), null);
  assert.match(SHELL_PATH_COMMAND, /printenv PATH/);
});

test("mergePath keeps order and drops repeats and empties", () => {
  assert.equal(mergePath(":", "/a:/b", "/usr/bin:/a::", "/c", ""), "/a:/b:/usr/bin:/c");
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
  assert.deepEqual(desktopSettings(), { hotkey: "Control+Alt+D", open_at_login: false, menu_bar_count: true });
  assert.deepEqual(desktopSettings({ "app.hotkey": "", "app.open_at_login": true, "app.menu_bar_count": false }), {
    hotkey: "",
    open_at_login: true,
    menu_bar_count: false,
  });
});

test("tray title and tooltip", () => {
  assert.equal(trayTitle("desk 7 ●2 +3"), "7 ●2 +3");
  assert.equal(trayTitle(""), "");
  assert.equal(trayTooltip({ now: 2, today: 5 }), "Review Desk: 7 in the queue, 2 urgent");
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
