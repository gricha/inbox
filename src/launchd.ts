// launchd LaunchAgent so `desk serve` runs at login and restarts if it dies.

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

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

export async function install(cliPath: string, port = Number((process.env.DESK_PORT ?? "") || 47823)): Promise<string> {
  const home = homedir();
  const file = plistPath(home);
  mkdirSync(join(home, ".review-desk"), { recursive: true });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, plistFor({ nodePath: process.execPath, cliPath, home, port }));
  spawnSync("launchctl", ["bootout", `${domain()}/${LABEL}`]);
  // bootout returns before the old job is fully gone, so an immediate bootstrap can fail with EIO.
  for (let i = 0; ; i++) {
    const r = spawnSync("launchctl", ["bootstrap", domain(), file], { encoding: "utf8" });
    if (r.status === 0) return file;
    if (i === 4) throw new Error(`launchctl bootstrap failed: ${(r.stderr ?? "").trim()}`);
    await sleep(500);
  }
}

export function uninstall(): string {
  const file = plistPath();
  spawnSync("launchctl", ["bootout", `${domain()}/${LABEL}`]);
  rmSync(file, { force: true });
  return file;
}
