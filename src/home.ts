// The desk's home: DESK_HOME, else ~/.inbox. Its folder before the rename to Inbox, ~/.review-desk, moves there with one
// rename on the first start of a desk that finds it. The CLI, the server and the desktop app all ask here.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Effect, Result } from "effect";
import { fsError } from "./errors.ts";

const HOME = ".inbox";
const OLD = ".review-desk";

// The owner's own desk lives here; a scratch or test desk (DESK_HOME) never does.
export const defaultHome = (home = os.homedir()): string => path.join(home, HOME);

const realDir = (p: string): boolean =>
  Result.getOrElse(
    Result.try({ try: () => fs.lstatSync(p, { throwIfNoEntry: false })?.isDirectory() === true, catch: () => false }),
    () => false,
  );

// Where the home is now, moving nothing: the old folder until a desk's start moves it. An empty DESK_HOME counts as unset.
export function deskHome(env = process.env.DESK_HOME, home = os.homedir()): string {
  if (env) return env;
  const to = defaultHome(home);
  return !fs.existsSync(to) && realDir(path.join(home, OLD)) ? path.join(home, OLD) : to;
}

// Something takes connections on the port; one that never accepts holds it too.
const held = (port: number): Effect.Effect<boolean> =>
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
    if (fs.existsSync(to) || !fs.existsSync(from)) return to;
    if (!realDir(from)) {
      log(`${from} isn't a folder, so it stays as it is; the desk's home is ${to}`);
      return to;
    }
    if (yield* held(port)) {
      log(
        `a desk is running on port ${port}, so ${from} stays where it is and isn't moved to ${to} until a desk starts with the port free`,
      );
      return from;
    }
    const moved = Effect.try({
      try: () => {
        fs.renameSync(from, to);
      },
      catch: fsError("rename", from),
    });
    return yield* moved.pipe(
      Effect.match({
        onSuccess: () => {
          log(`moved the desk's home from ${from} to ${to}`);
          return to;
        },
        // Another desk starting at the same moment may have moved it first.
        onFailure: (e) => {
          const now = deskHome(env, home);
          if (now === from) log(`couldn't move ${from} to ${to}, so the desk runs from ${from}: ${e.message}`);
          return now;
        },
      }),
    );
  });
