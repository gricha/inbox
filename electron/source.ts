// Run from a checkout (Settings → Desktop app → Run from a checkout): the desk under node --watch and the UI on a Vite dev
// server, both from a Review Desk clone, as children of the app. No electron import.
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import type { SourceStatus } from "../src/types.ts";
import { backoff, DESK_ARGS, sourceEnv, viteArgs, watchEvent } from "./lib.ts";

const win = process.platform === "win32";
const LOG_MAX = 2_000_000;
const TAIL = 30;

type Name = "desk" | "vite";

export interface Source {
  ui: string; // the Vite server's origin
  status(): SourceStatus;
  uiReady(): Promise<void>;
  stop(): Promise<void>;
  kill(): void; // on process exit, when there's no time to wait
}

const pidFile = (home: string) => path.join(home, "live.json");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Children of an app that crashed (it had no chance to stop them) would still hold the desk's port.
export async function reap(home: string, log: (m: string) => void): Promise<void> {
  let pids: unknown = [];
  try {
    pids = (JSON.parse(fs.readFileSync(pidFile(home), "utf8")) as { pids?: unknown }).pids;
  } catch {
    return;
  }
  for (const pid of Array.isArray(pids) ? pids : []) {
    if (win || !Number.isInteger(pid) || !alive(pid as number)) continue;
    const cmd = (() => {
      try {
        return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
      } catch {
        return "";
      }
    })();
    if (!/--watch-path=src|vite\/bin\/vite\.js/.test(cmd)) continue; // the pid went to something else since
    log(`stopping what an earlier run left going from source (pid ${pid})`);
    signal(pid as number, "SIGTERM", true);
    for (let i = 0; i < 30 && alive(pid as number); i++) await sleep(100);
    signal(pid as number, "SIGKILL", true);
  }
  fs.rmSync(pidFile(home), { force: true });
}

function signal(pid: number | undefined, sig: NodeJS.Signals, group: boolean): void {
  if (!pid) return;
  try {
    if (win) execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {});
    else process.kill(group ? -pid : pid, sig);
  } catch {} // already gone
}

export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => {
        resolve(port);
      });
    });
  });

export async function startSource(o: { dir: string; node: string; port: number; home: string; log: (m: string) => void }): Promise<Source> {
  fs.mkdirSync(o.home, { recursive: true });
  const logFile = path.join(o.home, "live.log");
  const ui = `http://127.0.0.1:${await freePort()}`;
  const env = sourceEnv(process.env, { port: o.port, home: o.home, ui });
  const kids: Record<Name, ChildProcess | null> = { desk: null, vite: null };
  let stopping = false;
  let failed = false;
  let reload = false; // the desk's node --watch was stopped to pick up new packages
  let tail: string[] = []; // the desk's output since it last started

  let logSize = 0;
  try {
    logSize = fs.statSync(logFile).size;
  } catch {}
  const write = (name: Name | "app", line: string) => {
    const text = `${name} | ${line}\n`;
    try {
      if (logSize > LOG_MAX) {
        fs.renameSync(logFile, `${logFile}.1`);
        logSize = 0;
      }
      fs.appendFileSync(logFile, text);
      logSize += Buffer.byteLength(text);
    } catch {}
  };

  const onLine = (name: Name, line: string) => {
    write(name, line);
    if (name !== "desk") return;
    const ev = watchEvent(line);
    if (ev === "restart") {
      failed = false;
      tail = [];
    } else if (ev === "exit") failed = true;
    else tail = [...tail.slice(1 - TAIL), line];
  };

  const run = (name: Name, args: string[], attempt: number) => {
    if (stopping) return;
    write("app", `${new Date().toISOString()} starting ${o.node} ${args.join(" ")}`);
    const c = spawn(o.node, args, { cwd: o.dir, env, detached: !win, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    kids[name] = c;
    if (name === "desk") {
      failed = false;
      tail = [];
    }
    try {
      fs.writeFileSync(pidFile(o.home), JSON.stringify({ pids: [kids.desk?.pid, kids.vite?.pid].filter(Boolean) }));
    } catch {}
    for (const s of [c.stdout, c.stderr])
      if (s)
        readline.createInterface({ input: s }).on("line", (line) => {
          onLine(name, line);
        });
    const since = Date.now();
    let ended = false;
    // node --watch outlives a broken desk; this is node itself failing (not on PATH) or getting killed.
    const end = (why: string) => {
      if (ended || stopping) return;
      ended = true;
      if (name === "desk" && reload) {
        reload = false;
        run(name, args, 0);
        return;
      }
      if (name === "desk") {
        failed = true;
        tail = [...tail, why].slice(-TAIL);
      }
      const next = Date.now() - since > 60_000 ? 0 : attempt + 1;
      write("app", `${new Date().toISOString()} ${name}: ${why}; starting it again in ${backoff(next) / 1000}s`);
      o.log(`${name} from source: ${why}`);
      setTimeout(() => {
        run(name, args, next);
      }, backoff(next));
    };
    c.on("error", (e) => {
      end(`couldn't run node: ${e.message}`);
    });
    c.on("exit", (code, sig) => {
      end(`node exited (${sig ?? code})`);
    });
  };

  run("vite", viteArgs(Number(new URL(ui).port)), 0);
  run("desk", DESK_ARGS, 0);

  // npm install (say, after a merge that added a package) restarts the desk too. Polled by path: npm ci replaces the file.
  const lock = path.join(o.dir, "node_modules", ".package-lock.json");
  fs.watchFile(lock, { interval: 2000 }, (cur, prev) => {
    const desk = kids.desk;
    if (stopping || cur.mtimeMs === prev.mtimeMs || !desk || desk.exitCode !== null || desk.signalCode !== null) return;
    write("app", `${new Date().toISOString()} node_modules changed; starting the desk again`);
    reload = true;
    signal(desk.pid, "SIGTERM", false); // node --watch hands it on to the desk, which closes cleanly
  });

  const exited = (c: ChildProcess) =>
    c.exitCode !== null || c.signalCode !== null || !c.pid
      ? Promise.resolve()
      : new Promise<void>((r) => {
          c.once("exit", () => {
            r();
          });
        });

  return {
    ui,
    status: () => ({ dir: o.dir, state: failed ? "failed" : "running", detail: failed ? tail.join("\n") : undefined, log: logFile }),
    async uiReady() {
      for (;;) {
        if (stopping) return;
        try {
          if ((await fetch(ui, { signal: AbortSignal.timeout(2000) })).ok) return;
        } catch {}
        await sleep(300);
      }
    },
    async stop() {
      if (stopping) return;
      stopping = true;
      fs.unwatchFile(lock);
      const all = [kids.desk, kids.vite].filter((c): c is ChildProcess => c !== null);
      // node --watch passes one SIGTERM on to the desk, which closes cleanly; a second one to the desk would cut that short.
      signal(kids.desk?.pid, "SIGTERM", false);
      signal(kids.vite?.pid, "SIGTERM", true);
      await Promise.race([Promise.all(all.map(exited)), sleep(5000)]);
      for (const c of all) signal(c.pid, "SIGKILL", true); // whatever they started and left
      write("app", `${new Date().toISOString()} stopped`);
      fs.rmSync(pidFile(o.home), { force: true });
    },
    kill() {
      if (stopping) return;
      stopping = true;
      fs.unwatchFile(lock);
      signal(kids.desk?.pid, "SIGTERM", false);
      signal(kids.vite?.pid, "SIGTERM", true);
    },
  };
}
