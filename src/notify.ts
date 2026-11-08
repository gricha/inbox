// Desktop notifications and opening URLs. Text goes in as argv: never through a shell, never into AppleScript source.
import { execFile } from "node:child_process";
import { Result } from "effect";

type Command = [file: string, args: string[]];

// Windows gets none: the desktop app shows its own notifications.
export function notifyCommand(title: string, body: string, platform: NodeJS.Platform = process.platform): Command | null {
  if (platform === "darwin") {
    return [
      "osascript",
      ["-e", "on run argv", "-e", "display notification (item 1 of argv) with title (item 2 of argv)", "-e", "end run", "--", body, title],
    ];
  }
  if (platform === "win32") return null;
  return ["notify-send", ["--app-name=Review Desk", "--", title, body]];
}

export function openCommand(url: string, platform: NodeJS.Platform = process.platform): Command {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

// A notification never fails what sent it: a missing notify-send or xdg-open, or text execFile refuses (a NUL byte), does nothing.
const run = (c: Command | null): void => {
  if (c) Result.try({ try: () => execFile(c[0], c[1], () => {}), catch: () => null });
};

export const notify = (title: string, body: string): void => {
  run(notifyCommand(title, body));
};
export const openUrl = (url: string): void => {
  run(openCommand(url));
};

// quiet = "19:00-09:00"; wraps past midnight when start > end.
export function inQuietHours(quiet: string, now: Date): boolean {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(quiet);
  if (!m) return false;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  const t = now.getHours() * 60 + now.getMinutes();
  return start <= end ? t >= start && t < end : t >= start || t < end;
}
