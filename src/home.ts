// The desk's home: DESK_HOME, else ~/.inbox. Its folder before the rename to Inbox, ~/.review-desk, moves there with one
// rename on the first start of a desk that finds it, and is left as a link to it. The CLI, the server and the desktop app
// all ask here.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Effect, Result } from "effect";
import { fsError } from "./errors.ts";

const HOME = ".inbox";
const OLD = ".review-desk";

export const defaultHome = (home = os.homedir()): string => path.join(home, HOME);

// A folder, or a link to one (a dotfiles home, say), which a rename moves as the link.
const isDir = (p: string): boolean =>
  Result.getOrElse(
    Result.try({ try: () => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true, catch: () => false }),
    () => false,
  );

// Where the home is now, moving nothing: the old folder until a desk's start moves it. An empty DESK_HOME counts as unset.
export function deskHome(env = process.env.DESK_HOME, home = os.homedir()): string {
  if (env) return env;
  const to = defaultHome(home);
  return !fs.existsSync(to) && isDir(path.join(home, OLD)) ? path.join(home, OLD) : to;
}

const real = (p: string): string =>
  Result.getOrElse(Result.try({ try: () => fs.realpathSync(p), catch: () => null }), () => path.resolve(p));

// The owner's own desk runs from the home as it is now (~/.review-desk until it moves), or through a link to it; a scratch
// or test desk (DESK_HOME elsewhere) never does.
export const ownersHome = (dir: string, home = os.homedir()): boolean => real(dir) === real(deskHome("", home));

// Something takes connections on the port; one that never accepts holds it too.
export const held = (port: number): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    const answer = (v: boolean) => {
      s.destroy();
      resume(Effect.succeed(v));
    };
    s.setTimeout(1000, () => {
      answer(true);
    });
    s.once("connect", () => {
      answer(true);
    });
    s.once("error", () => {
      answer(false);
    });
    return Effect.sync(() => {
      s.destroy();
    });
  });

// The home a desk starting on `port` runs from, moving ~/.review-desk to ~/.inbox first when that's all there is. Never when
// ~/.inbox is there already, and never while something answers on the port: with no desk on ~/.inbox yet, that's one
// running from the old folder, which keeps it until a start finds the port free. A move that fails leaves it where it is.
// What still opens ~/.review-desk after the move (Review Desk.app at login, its checkout's desk, a desk install job from
// before) finds the home through the link the move leaves there, rather than making an empty one.
export const settleHome = (
  port: number,
  log: (m: string) => void,
  env = process.env.DESK_HOME,
  home = os.homedir(),
): Effect.Effect<string> =>
  Effect.gen(function* () {
    if (env) return env;
    const to = defaultHome(home);
    const from = path.join(home, OLD);
    if (fs.existsSync(to)) {
      if (isDir(from) && real(from) !== real(to))
        log(`${from} is still there beside ${to}: the desk's home is ${to}, and ${from} is left as it is`);
      return to;
    }
    if (!fs.existsSync(from)) return to;
    if (!isDir(from)) {
      log(`${from} isn't a folder, so it stays as it is; the desk's home is ${to}`);
      return to;
    }
    if (yield* held(port)) {
      log(
        `a desk is running on port ${port}, so ${from} stays where it is and isn't moved to ${to} until a desk starts with the port free`,
      );
      return from;
    }
    const moved = yield* Effect.result(
      Effect.try({
        try: () => {
          fs.renameSync(from, to);
        },
        catch: fsError("rename", from),
      }),
    );
    // Another desk starting at the same moment may have moved it first.
    if (Result.isFailure(moved)) {
      const now = deskHome(env, home);
      if (now === from) log(`couldn't move ${from} to ${to}, so the desk runs from ${from}: ${moved.failure.message}`);
      return now;
    }
    const linked = yield* Effect.result(
      Effect.try({
        // A junction on Windows, which needs no privilege; elsewhere relative, so it follows the home folder.
        try: () => {
          fs.symlinkSync(process.platform === "win32" ? to : HOME, from, "junction");
        },
        catch: fsError("link", from),
      }),
    );
    log(
      Result.isSuccess(linked)
        ? `moved the desk's home from ${from} to ${to}, and left ${from} as a link to it`
        : `moved the desk's home from ${from} to ${to}; couldn't leave a link to it there: ${linked.failure.message}`,
    );
    return to;
  });
