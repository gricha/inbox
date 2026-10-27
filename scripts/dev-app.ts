// npm run app:dev: the desktop app on the Vite dev server (hot reload), restarted when src/ or electron/ change.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createServer } from "vite";
import { probeHealth } from "../electron/lib.ts";

const root = path.join(import.meta.dirname, "..");
const electron = createRequire(import.meta.url)("electron") as string; // outside Electron the package exports the binary's path
const port = Number(process.env.DESK_PORT || 47823);
process.env.DESK_API = `http://127.0.0.1:${port}`; // web/vite.config.ts proxies /api there

if ((await probeHealth(process.env.DESK_API)).kind === "desk") {
  console.warn(`A desk is already running on :${port}; the app attaches to it, so src/ changes won't reach it, and it rejects`);
  console.warn(`the Vite origin unless it runs with DESK_DEV=1. For a separate dev desk: DESK_PORT=47900 DESK_HOME=/tmp/desk-dev npm run app:dev`);
}

const vite = await createServer({ configFile: path.join(root, "web/vite.config.ts") });
await vite.listen();
const ui = vite.resolvedUrls?.local[0] ?? "http://localhost:5173/";
console.log(`Vite on ${ui}`);

let child: ChildProcess | null = null;
let stopping = false;

function launch(): void {
  const c = spawn(electron, [root], { stdio: "inherit", env: { ...process.env, DESK_DEV: "1", DESK_UI: ui } });
  child = c;
  // Quitting the app (Cmd+Q, tray) ends the dev session too.
  c.on("exit", () => { if (child === c && !stopping) void shutdown(); });
}

function stop(): Promise<void> {
  const c = child;
  child = null;
  if (!c || c.exitCode !== null || c.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => c.kill("SIGKILL"), 5000);
    c.once("exit", () => { clearTimeout(force); resolve(); });
    c.kill("SIGTERM"); // main.ts quits on SIGTERM, closing its in-process desk
  });
}

let timer: NodeJS.Timeout | undefined;
let restarting = Promise.resolve();
const restart = (file: string | null) => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log(`\n${file ?? "change"}: restarting Electron`);
    restarting = restarting.then(stop).then(launch);
  }, 300);
};
for (const dir of ["src", "electron"]) fs.watch(path.join(root, dir), { recursive: true }, (_e, file) => restart(file && path.join(dir, file)));

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await stop();
  await vite.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

launch();
