// npm run smoke:app [-- <packaged binary>]: launches the desktop app (from the repo, or a packaged binary) on a
// scratch home and port, checks the window, tray, bridge and clipboard, opens Settings and quits.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { _electron } from "playwright-core";
import { envVar, probeHealth } from "../electron/lib.ts";
import type { DesktopBridge } from "../src/types.ts";

const root = path.join(import.meta.dirname, "..");
const bin = process.argv[2];
const ownHome = !process.env.DESK_HOME;
const home = envVar("DESK_HOME") ?? fs.mkdtempSync(path.join(os.tmpdir(), "desk-smoke-"));
const port = envVar("DESK_PORT") ?? String(await freePort());
if (port === "47823") throw new Error("pick a scratch DESK_PORT, not the real desk's 47823");
const deskUrl = `http://localhost:${port}`;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => {
        resolve(p);
      });
    });
  });
}

const step = (msg: string) => {
  console.log(`• ${msg}`);
};
const env = { ...process.env, DESK_HOME: home, DESK_PORT: port, DESK_SENTRY: "0" } as Record<string, string>;
delete env.DESK_SOURCE;
delete env.DESK_DEV;

step(`launching ${bin ?? "the app from the repo"} (home ${home}, port ${port})`);
const app = await _electron.launch(bin ? { executablePath: bin, env, timeout: 60_000 } : { args: [root], env, timeout: 60_000 });
const exited = new Promise<number | null>((resolve) => {
  app.process().once("exit", (code) => {
    resolve(code);
  });
});
try {
  const page = await app.firstWindow();
  step("window open; waiting for the desk (a fresh home reads your GitHub context first, ~30 s)");
  await page.waitForURL((u) => u.href.startsWith(deskUrl), { timeout: 120_000 });
  await page.locator(".queue h2", { hasText: "Queue" }).waitFor({ timeout: 30_000 });
  assert.equal(await page.title(), "Review Desk");
  step("queue rendered");

  const tray = await app.evaluate(({ app: electronApp, nativeImage }) => {
    const t = (globalThis as { deskTray?: Electron.Tray }).deskTray;
    const icons = ["trayTemplate.png", "tray.png", "tray-alert.png", "overlay-alert.png", "icon.png"];
    const missing = icons.filter((f) => nativeImage.createFromPath(`${electronApp.getAppPath()}/assets/${f}`).isEmpty());
    return t && !t.isDestroyed() ? { title: process.platform === "darwin" ? t.getTitle() : "", missing } : null;
  });
  assert.ok(tray, "no tray");
  assert.deepEqual(tray.missing, [], "icons missing from the app");
  step(`tray exists${tray.title ? ` (title "${tray.title}")` : ""}`);

  type Bridge = { platform: string; version: string; status: Awaited<ReturnType<DesktopBridge["status"]>> } | null;
  const readBridge = (): Promise<Bridge> =>
    page.evaluate(
      "window.desktop ? window.desktop.status().then((status) => ({ platform: window.desktop.platform, version: window.desktop.version, status })) : null",
    );
  let bridge = await readBridge();
  // The hotkey is registered once the first /api/settings arrives.
  for (let i = 0; i < 20 && bridge && !bridge.status.hotkey.accelerator; i++) {
    await sleep(250);
    bridge = await readBridge();
  }
  assert.ok(bridge, "window.desktop is missing");
  assert.equal(bridge.platform, process.platform);
  assert.match(bridge.version, /^\d+\.\d+\.\d+/);
  assert.equal(typeof bridge.status.open_at_login, "boolean");
  assert.equal(typeof bridge.status.hotkey.ok, "boolean");
  step(`bridge: ${JSON.stringify(bridge)}`);

  // The UI's "c" uses navigator.clipboard; put back whatever text was there.
  const types = await app.evaluate(async ({ clipboard }) => (await clipboard.read()).flatMap((i) => i.types));
  const textOnly = types.every(
    (t) => t.startsWith("text/plain") || t === "electron application/findtext" || t.includes("NSStringPboardType"),
  );
  const before = textOnly ? await app.evaluate(({ clipboard }) => clipboard.readText()) : null;
  if (before === null) step(`clipboard holds more than text (${types.join(", ")}); skipped the copy check`);
  else {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.focus(); // page is this window
    });
    const copied = await page.evaluate(`navigator.clipboard.writeText("review-desk smoke").then(() => "ok", (e) => e.message)`);
    const read = await app.evaluate(({ clipboard }) => clipboard.readText());
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), before);
    assert.equal(copied, "ok");
    assert.equal(read, "review-desk smoke");
    step("navigator.clipboard.writeText works");
  }

  await app.evaluate(({ Menu }) => {
    const items = Menu.getApplicationMenu()!.items.flatMap((i) => i.submenu?.items ?? []);
    items.find((i) => i.label === "Settings…")!.click();
  });
  await page.waitForURL((u) => u.hash.startsWith("#/settings"), { timeout: 5000 });
  await page.locator('.side a.side-item[aria-current="page"]', { hasText: "GitHub" }).waitFor({ timeout: 10_000 });
  step("Settings… opened #/settings");

  await app.close();
  const code = await exited;
  assert.equal(code, 0, `exit code ${code}`);
  assert.equal((await probeHealth(`http://127.0.0.1:${port}`)).kind, "free", "the in-process desk is still listening");
  assert.ok(fs.existsSync(path.join(home, "app", "logs", "desk.log")), "no desk.log");
  step("quit cleanly; the port is free");
  console.log("smoke:app passed");
} catch (e) {
  app.process().kill();
  throw e;
} finally {
  if (ownHome) fs.rmSync(home, { recursive: true, force: true });
}
