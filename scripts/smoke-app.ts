// npm run smoke:app [-- <packaged binary>]: launches the desktop app (from the repo, or a packaged binary) on a
// scratch home and port, checks the window, tray, bridge and clipboard, opens Settings and quits. SMOKE_VERSION also
// checks the app's version; SMOKE_DEEP=1 waits for the first GitHub sync and opens an item's review (npm run qa:release).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Effect } from "effect";
import { _electron } from "playwright-core";
import { envVar, probeHealth } from "../electron/lib.ts";
import { freePort } from "../electron/source.ts";
import { defaultConfigText } from "../src/config.ts";
import { isRecord } from "../src/narrow.ts";
import type { DesktopBridge } from "../src/types.ts";

const root = path.join(import.meta.dirname, "..");
const bin = process.argv[2];
const ownHome = !process.env.DESK_HOME;
const home = envVar("DESK_HOME") ?? fs.mkdtempSync(path.join(os.tmpdir(), "desk-smoke-"));
const port = envVar("DESK_PORT") ?? String(await Effect.runPromise(freePort()));
if (port === "47823") throw new Error("pick a scratch DESK_PORT, not the real desk's 47823");
const deskUrl = `http://localhost:${port}`;

const step = (msg: string) => {
  console.log(`• ${msg}`);
};
// A desk's JSON, asked again when a kept-alive connection it had just closed resets: fetch's race, not the desk failing.
const reset = (e: unknown) => isRecord(e) && isRecord(e.cause) && e.cause.code === "ECONNRESET";
async function deskJson(url: string): Promise<unknown> {
  for (let i = 0; ; i++) {
    const got = await fetch(url).then(
      async (r): Promise<{ ok: unknown } | null> => ({ ok: await r.json() }),
      (e: unknown) => {
        if (i < 2 && reset(e)) return null;
        throw e instanceof Error ? e : new Error(String(e));
      },
    );
    if (got) return got.ok;
    await sleep(300);
  }
}
// A home with no config.toml is a first run, whose setup page can cover the window midway through the checks.
const config = path.join(home, "config.toml");
fs.mkdirSync(home, { recursive: true });
if (!fs.existsSync(config)) fs.writeFileSync(config, defaultConfigText({ workOrgs: [] }));
const env = { ...process.env, DESK_HOME: home, DESK_PORT: port, DESK_SENTRY: "0" } as Record<string, string>;
delete env.DESK_SOURCE;
delete env.DESK_DEV;

step(`launching ${bin ?? "the app from the repo"} (home ${home}, port ${port})`);
const app = await _electron.launch(bin ? { executablePath: bin, env, timeout: 60_000 } : { args: [root], env, timeout: 60_000 });
const exited = new Promise<number | null>((resolve) => {
  app.process().once("exit", (code, sig) => {
    // A run that fails says how the app went, not only that a page was gone.
    if (!closing) step(`the app exited by itself (${code ?? sig})`);
    resolve(code);
  });
});
let closing = false;
let output = "";
const keep = (d: Buffer) => {
  output = (output + d.toString()).slice(-4000);
};
app.process().stdout?.on("data", keep);
app.process().stderr?.on("data", keep);
try {
  const page = await app.firstWindow();
  page.on("crash", () => {
    step("the window's renderer crashed");
  });
  page.on("close", () => {
    if (!closing) step(`the window closed by itself; the app's last output:\n${output}`);
  });
  step("window open; waiting for the desk (a fresh home reads your GitHub context first, ~30 s)");
  await page.waitForURL((u) => u.href.startsWith(deskUrl), { timeout: 120_000 });
  await page.locator('.side a.side-item[aria-current="page"]', { hasText: "Inbox" }).waitFor({ timeout: 30_000 });
  assert.equal(await page.title(), "Inbox");
  step("Inbox rendered");

  const tray = await app.evaluate(({ app: electronApp, nativeImage }) => {
    const t = (globalThis as { deskTray?: Electron.Tray }).deskTray;
    const icons = [
      "trayTemplate.png",
      "tray.png",
      "tray-alert.png",
      "overlay-alert.png",
      "icon.png",
      "icon-dev.png",
      "icon-qa.png",
      "tray-dev.png",
      "tray-qa.png",
    ];
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
  const want = envVar("SMOKE_VERSION");
  if (want) assert.equal(bridge.version, want, "not the version under test");
  assert.equal(typeof bridge.status.open_at_login, "boolean");
  assert.equal(typeof bridge.status.hotkey.ok, "boolean");
  step(`bridge: ${JSON.stringify(bridge)}`);

  // The UI's Copy attach command uses navigator.clipboard; put back whatever text was there.
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
    const copied = await page.evaluate(`navigator.clipboard.writeText("inbox smoke").then(() => "ok", (e) => e.message)`);
    const read = await app.evaluate(({ clipboard }) => clipboard.readText());
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), before);
    assert.equal(copied, "ok");
    assert.equal(read, "inbox smoke");
    step("navigator.clipboard.writeText works");
  }

  if (envVar("SMOKE_DEEP")) {
    type Overview = { synced_at: string | null; syncing: boolean; sync_error: string | null; config_errors: unknown[] };
    let o: Overview | null = null;
    for (let i = 0; i < 90 && !(o?.synced_at && !o.syncing); i++) {
      await sleep(2000);
      o = (await deskJson(`${deskUrl}/api/overview`)) as Overview | null;
    }
    assert.ok(o?.synced_at, "no finished GitHub sync after 3 minutes");
    assert.equal(o.sync_error, null, `sync failed: ${o.sync_error}`);
    assert.deepEqual(o.config_errors, [], "config errors");
    step(`synced with GitHub at ${o.synced_at}`);
    // Rows land once Claude has sorted the first sync. A PR's row opens its review; your sessions and questions lead the
    // Inbox and open pages of their own.
    await page
      .locator(".queue [data-id] .row-main")
      .first()
      .waitFor({ timeout: 90_000 })
      .catch(() => null);
    const queue = (await deskJson(`${deskUrl}/api/queue`)) as { sections: Record<string, { id: string; kind: string }[]> };
    const prs = new Set(Object.values(queue.sections).flatMap((cards) => cards.filter((c) => c.kind === "pr").map((c) => c.id)));
    const shown = await page.evaluate<string[]>(`[...document.querySelectorAll(".queue [data-id]")].map((r) => r.dataset.id)`);
    const pr = shown.find((id) => prs.has(id));
    if (pr) {
      await page.locator(`.queue [data-id="${pr}"] .row-main`).first().click();
      await page.locator(".review").waitFor({ timeout: 30_000 });
      step(`${pr}'s review opened`);
      await page.goBack();
      await page.locator(".queue").waitFor({ timeout: 10_000 });
    } else step("the Inbox has no PR; skipped opening a review");
  }

  await app.evaluate(({ Menu }) => {
    const items = Menu.getApplicationMenu()!.items.flatMap((i) => i.submenu?.items ?? []);
    items.find((i) => i.label === "Settings…")!.click();
  });
  await page.waitForURL((u) => u.hash.startsWith("#/settings"), { timeout: 5000 });
  // In Settings the sidebar lists its parts, one of them current, in place of the pages.
  await page.locator('.side nav[aria-label="Settings"] a.side-item[aria-current="page"]').waitFor({ timeout: 10_000 });
  step("Settings… opened #/settings");

  closing = true;
  await app.close();
  const code = await exited;
  assert.equal(code, 0, `exit code ${code}`);
  assert.equal((await Effect.runPromise(probeHealth(`http://127.0.0.1:${port}`))).kind, "free", "the in-process desk is still listening");
  assert.ok(fs.existsSync(path.join(home, "app", "logs", "desk.log")), "no desk.log");
  step("quit cleanly; the port is free");
  console.log("smoke:app passed");
} catch (e) {
  app.process().kill("SIGKILL"); // a blocking dialog ignores SIGTERM and would stay on the screen
  throw e;
} finally {
  if (ownHome) fs.rmSync(home, { recursive: true, force: true });
}
