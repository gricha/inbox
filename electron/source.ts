// Run from a checkout (Settings → This device → Run from a checkout): the desk under node --watch and the UI on a Vite dev
// server, both from a Review Desk clone, as children of the app. No electron import.
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { Effect, Result } from "effect";
import { CommandFailed, type FsError } from "../src/errors.ts";
import type { SourceStatus } from "../src/types.ts";
import {
  backoff,
  DESK_ARGS,
  makeDir,
  NoFreePort,
  quietly,
  readJson,
  removeFile,
  request,
  sourceEnv,
  tryOr,
  viteArgs,
  watchEvent,
} from "./lib.ts";

const win = process.platform === "win32";
const LOG_MAX = 2_000_000;
const TAIL = 30;

type Name = "desk" | "vite";

export interface Source {
  ui: string; // the Vite server's origin
  status(): SourceStatus;
  uiReady(): Effect.Effect<void>;
  stop(): Effect.Effect<void, FsError>;
  kill(): void; // on process exit, when there's no time to wait
}

const pidFile = (home: string) => path.join(home, "live.json");

const alive = (pid: number): boolean => tryOr(() => process.kill(pid, 0), false);

// Children of an app that crashed (it had no chance to stop them) would still hold the desk's port.
export const reap = (home: string, log: (m: string) => void): Effect.Effect<void, FsError> =>
  Effect.gen(function* () {
    const saved = readJson(pidFile(home));
    if (saved === null) return; // none, or not JSON: left as it is
    const { pids } = saved as { pids?: unknown };
    for (const pid of Array.isArray(pids) ? pids : []) {
      if (win || !Number.isInteger(pid) || !alive(pid as number)) continue;
      const cmd = tryOr(() => execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }), "");
      if (!/--watch-path=src|vite\/bin\/vite\.js/.test(cmd)) continue; // the pid went to something else since
      log(`stopping what an earlier run left going from source (pid ${pid})`);
      signal(pid as number, "SIGTERM", true);
      for (let i = 0; i < 30 && alive(pid as number); i++) yield* Effect.sleep(100);
      signal(pid as number, "SIGKILL", true);
    }
    yield* removeFile(pidFile(home));
  });

function signal(pid: number | undefined, sig: NodeJS.Signals, group: boolean): void {
  if (!pid) return;
  quietly(() => {
    if (win) execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {});
    else process.kill(group ? -pid : pid, sig);
  }); // already gone
}

export const freePort = (): Effect.Effect<number, NoFreePort> =>
  Effect.callback((resume) => {
    const s = net.createServer();
    s.once("error", (cause) => {
      resume(Effect.fail(new NoFreePort({ cause })));
    });
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => {
        resume(Effect.succeed(port));
      });
    });
    return Effect.sync(() => {
      s.close();
    });
  });

export const startSource = (o: {
  dir: string;
  node: string;
  port: number;
  home: string;
  log: (m: string) => void;
}): Effect.Effect<Source, FsError | NoFreePort> =>
  Effect.gen(function* () {
    yield* makeDir(o.home);
    const logFile = path.join(o.home, "live.log");
    const uiPort = yield* freePort();
    const ui = `http://127.0.0.1:${uiPort}`;
    const env = sourceEnv(process.env, { port: o.port, home: o.home, ui });
    const kids: Record<Name, ChildProcess | null> = { desk: null, vite: null };
    let stopping = false;
    let failed = false;
    let reload = false; // the desk's node --watch was stopped to pick up new packages
    let tail: string[] = []; // the desk's output since it last started

    let logSize = tryOr(() => fs.statSync(logFile).size, 0);
    // live.log is for reading after the fact: one it can't write leaves the desk running.
    const write = (name: Name | "app", line: string) => {
      const text = `${name} | ${line}\n`;
      quietly(() => {
        if (logSize > LOG_MAX) {
          fs.renameSync(logFile, `${logFile}.1`);
          logSize = 0;
        }
        fs.appendFileSync(logFile, text);
        logSize += Buffer.byteLength(text);
      });
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
      const since = Date.now();
      let ended = false;
      // node --watch outlives a broken desk; this is node itself failing (not on PATH, or a path spawn refuses) or getting killed.
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
      const started = Result.try({
        try: () => spawn(o.node, args, { cwd: o.dir, env, detached: !win, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }),
        catch: (cause) => new CommandFailed({ command: o.node, code: null, signal: null, stderr: "", cause }),
      });
      if (name === "desk") {
        failed = false;
        tail = [];
      }
      if (Result.isFailure(started)) {
        end(`couldn't run node: ${started.failure.message}`);
        return;
      }
      const c = started.success;
      kids[name] = c;
      // For reap after a crash: one the app can't write only means a crash would leave these running.
      quietly(() => {
        fs.writeFileSync(pidFile(o.home), JSON.stringify({ pids: [kids.desk?.pid, kids.vite?.pid].filter(Boolean) }));
      });
      for (const s of [c.stdout, c.stderr])
        if (s)
          readline.createInterface({ input: s }).on("line", (line) => {
            onLine(name, line);
          });
      c.on("error", (e) => {
        end(`couldn't run node: ${e.message}`);
      });
      c.on("exit", (code, sig) => {
        end(`node exited (${sig ?? code})`);
      });
    };

    run("vite", viteArgs(uiPort), 0);
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

    // Checked in the register: one that exits between a check outside and the listener would hold up a quit for 5 s.
    const exited = (c: ChildProcess): Effect.Effect<void> =>
      Effect.callback<void>((resume) => {
        if (c.exitCode !== null || c.signalCode !== null || !c.pid) {
          resume(Effect.void);
          return Effect.void;
        }
        const done = () => {
          resume(Effect.void);
        };
        c.once("exit", done);
        return Effect.sync(() => {
          c.off("exit", done);
        });
      });

    const kill = () => {
      if (stopping) return;
      stopping = true;
      fs.unwatchFile(lock);
      // node --watch passes one SIGTERM on to the desk, which closes cleanly; a second one to the desk would cut that short.
      signal(kids.desk?.pid, "SIGTERM", false);
      signal(kids.vite?.pid, "SIGTERM", true);
    };

    return {
      ui,
      status: () => ({ dir: o.dir, state: failed ? "failed" : "running", detail: failed ? tail.join("\n") : undefined, log: logFile }),
      uiReady: () =>
        Effect.gen(function* () {
          for (;;) {
            if (stopping) return;
            const up = yield* request(ui, { timeoutMs: 2000 }).pipe(
              Effect.map((res) => res.ok),
              Effect.orElseSucceed(() => false), // not up yet: Vite takes a while
            );
            if (up) return;
            yield* Effect.sleep(300);
          }
        }),
      stop: () =>
        Effect.gen(function* () {
          if (stopping) return;
          kill();
          const all = [kids.desk, kids.vite].filter((c): c is ChildProcess => c !== null);
          yield* Effect.timeoutOption(Effect.all(all.map(exited), { concurrency: "unbounded" }), 5000);
          for (const c of all) signal(c.pid, "SIGKILL", true); // whatever they started and left
          write("app", `${new Date().toISOString()} stopped`);
          yield* removeFile(pidFile(o.home));
        }),
      kill,
    } satisfies Source;
  });
