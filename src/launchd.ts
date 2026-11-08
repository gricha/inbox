// launchd LaunchAgent so `desk serve` runs at login and restarts if it dies.

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Schedule } from "effect";
import { CommandFailed, fsError, type FsError } from "./errors.ts";

const LABEL = "dev.review-desk.desk";

export interface PlistOptions {
  nodePath: string;
  cliPath: string;
  home: string;
  port: number;
}

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const str = (s: string) => `<string>${esc(s)}</string>`;

export function plistFor(o: PlistOptions): string {
  const log = join(o.home, ".review-desk", "desk.log");
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

const plistPath = (home = homedir()) => join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
const domain = () => `gui/${process.getuid!()}`;

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

export const install = Effect.fn("launchd.install")(function* (
  cliPath: string,
  port: number = Number((process.env.DESK_PORT ?? "") || 47823),
): Effect.fn.Return<string, FsError | CommandFailed> {
  const home = homedir();
  const file = plistPath(home);
  yield* mkdir(join(home, ".review-desk"));
  yield* mkdir(dirname(file));
  const plist = plistFor({ nodePath: process.execPath, cliPath, home, port });
  yield* Effect.try({
    try: () => {
      writeFileSync(file, plist);
    },
    catch: fsError("write", file),
  });
  spawnSync("launchctl", ["bootout", `${domain()}/${LABEL}`]); // not loaded is fine
  // bootout returns before the old job is fully gone, so an immediate bootstrap can fail with EIO: 5 tries, 500 ms apart.
  yield* bootstrap(file).pipe(Effect.retry({ times: 4, schedule: Schedule.spaced("500 millis") }));
  return file;
});

export const uninstall = Effect.fn("launchd.uninstall")(function* (): Effect.fn.Return<string, FsError> {
  const file = plistPath();
  spawnSync("launchctl", ["bootout", `${domain()}/${LABEL}`]); // not loaded is fine
  yield* Effect.try({
    try: () => {
      rmSync(file, { force: true });
    },
    catch: fsError("remove", file),
  });
  return file;
});
