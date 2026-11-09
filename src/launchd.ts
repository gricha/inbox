// launchd LaunchAgent so `desk serve` runs at login and restarts if it dies.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Schedule } from "effect";
import { CommandFailed, Conflict, fsError, type FsError } from "./errors.ts";
import { defaultHome, held, settleHome } from "./home.ts";

const LABEL = "dev.inbox.desk";
const OLD_LABEL = "dev.review-desk.desk"; // its label before the rename to Inbox

export interface PlistOptions {
  nodePath: string;
  cliPath: string;
  home: string;
  deskHome: string; // where its desk keeps its home, and the log
  port: number;
}

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const str = (s: string) => `<string>${esc(s)}</string>`;

export function plistFor(o: PlistOptions): string {
  const log = join(o.deskHome, "desk.log");
  // launchd starts agents with a bare PATH: add where `gh` and `claude` usually live.
  const path = [dirname(o.nodePath), join(o.home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${str(LABEL)}
  <key>ProgramArguments</key>
  <array>
    ${str(o.nodePath)}
    ${str("--disable-warning=ExperimentalWarning")}
    ${str(o.cliPath)}
    ${str("serve")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  ${str(log)}
  <key>StandardErrorPath</key>
  ${str(log)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    ${str(path)}
    <key>DESK_PORT</key>
    ${str(String(o.port))}
  </dict>
</dict>
</plist>
`;
}

const plistPath = (home = homedir(), label = LABEL) => join(home, "Library", "LaunchAgents", `${label}.plist`);
const domain = () => `gui/${process.getuid!()}`;

const remove = (file: string) =>
  Effect.try({
    try: () => {
      rmSync(file, { force: true });
    },
    catch: fsError("remove", file),
  });

// Its job stopped and its plist gone, under either label; not loaded is fine. The plists it removed that were there.
const bootoutAll = Effect.fnUntraced(function* (home: string): Effect.fn.Return<string[], FsError> {
  const gone: string[] = [];
  for (const label of [OLD_LABEL, LABEL]) {
    spawnSync("launchctl", ["bootout", `${domain()}/${label}`]);
    const file = plistPath(home, label);
    if (existsSync(file)) gone.push(file);
    yield* remove(file);
  }
  return gone;
});

const mkdir = (dir: string) =>
  Effect.try({
    try: () => {
      mkdirSync(dir, { recursive: true });
    },
    catch: fsError("mkdir", dir),
  });

const bootstrap = (file: string) =>
  Effect.suspend((): Effect.Effect<void, CommandFailed> => {
    const r = spawnSync("launchctl", ["bootstrap", domain(), file], { encoding: "utf8" });
    if (r.status === 0) return Effect.void;
    const stderr = r.stderr ?? "";
    const summary = `launchctl bootstrap failed: ${stderr.trim()}`;
    return Effect.fail(new CommandFailed({ command: "launchctl", code: r.status, signal: r.signal, stderr, cause: r.error, summary }));
  });

// The job's desk runs without DESK_HOME, on the owner's home: ~/.review-desk moves to ~/.inbox here first, once the job
// booted out has let go of the port, since an ~/.inbox made for the log would keep it from moving. Where it couldn't (a
// desk still runs from it), nothing is installed: the job's own desk would move the folder its log is in.
export const install = Effect.fn("launchd.install")(function* (
  cliPath: string,
  port: number = Number((process.env.DESK_PORT ?? "") || 47823),
  log: (m: string) => void = () => {},
): Effect.fn.Return<{ file: string; log: string }, FsError | CommandFailed | Conflict> {
  const home = homedir();
  const file = plistPath(home);
  yield* bootoutAll(home);
  for (let i = 0; i < 50 && (yield* held(port)); i++) yield* Effect.sleep(100);
  const deskHome = yield* settleHome(port, log, "", home);
  if (deskHome !== defaultHome(home))
    return yield* new Conflict({
      message: `desk install needs the port free: quit the desk running from ${deskHome} (Review Desk.app, or that desk serve), then run it again`,
    });
  yield* mkdir(deskHome);
  yield* mkdir(dirname(file));
  const plist = plistFor({ nodePath: process.execPath, cliPath, home, deskHome, port });
  yield* Effect.try({
    try: () => {
      writeFileSync(file, plist);
    },
    catch: fsError("write", file),
  });
  // bootout returns before the old job is fully gone, so an immediate bootstrap can fail with EIO: 5 tries, 500 ms apart.
  yield* bootstrap(file).pipe(Effect.retry({ times: 4, schedule: Schedule.spaced("500 millis") }));
  return { file, log: join(deskHome, "desk.log") };
});

// The plists it removed, the one from before the rename too.
export const uninstall = Effect.fn("launchd.uninstall")(function* (): Effect.fn.Return<string[], FsError> {
  return yield* bootoutAll(homedir());
});
