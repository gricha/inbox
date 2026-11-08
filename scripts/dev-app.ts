// npm run app:dev: the desktop app running from this checkout (DESK_SOURCE, as Settings → Desktop app → Run from a checkout):
// src/ restarts the desk, web/ hot-reloads, and a change under electron/ restarts the app.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Effect } from "effect";
import { envVar, probeHealth } from "../electron/lib.ts";

const root = path.join(import.meta.dirname, "..");
const electron = createRequire(import.meta.url)("electron") as string; // outside Electron the package exports the binary's path
const port = Number(envVar("DESK_PORT") ?? 47823);

if ((await Effect.runPromise(probeHealth(`http://127.0.0.1:${port}`))).kind === "desk") {
  console.warn(`A desk is already running on :${port}; the app attaches to it, so src/ and web/ changes won't reach it.`);
  console.warn(`For a separate dev desk: DESK_PORT=47900 DESK_HOME=/tmp/desk-dev npm run app:dev`);
}

let child: ChildProcess | null = null;
let stopping = false;

function launch(): void {
  const c = spawn(electron, [root], { stdio: "inherit", env: { ...process.env, DESK_SOURCE: root } });
  child = c;
  // Quitting the app (Cmd+Q, tray) ends the dev session too.
  c.on("exit", () => {
    if (child === c && !stopping) void shutdown();
  });
}

function stop(): Promise<void> {
  const c = child;
  child = null;
  if (!c || c.exitCode !== null || c.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => {
      c.kill("SIGKILL");
    }, 10_000);
    c.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    c.kill("SIGTERM"); // main.ts quits on SIGTERM, stopping the desk and Vite it runs
  });
}

let timer: NodeJS.Timeout | undefined;
let restarting = Promise.resolve();
fs.watch(path.join(root, "electron"), { recursive: true }, (_e, file) => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log(`\n${file ? path.join("electron", file) : "electron/"}: restarting Electron`);
    restarting = restarting.then(stop).then(launch);
  }, 300);
});

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await stop();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

launch();
