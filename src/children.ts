// Every process the desk's agents run (claude, and the gh calls an AI review makes), so closing the desk stops them all.
// Each gets a process group of its own (spawn's `detached`), so a kill reaches what it started too: hooks, test runners.
import { execFile, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const win = process.platform === "win32";
export const OWN_GROUP = !win; // detached on Windows is a new console window; taskkill /T reaches the tree there
const GRACE = 2000; // well inside the 5 s the app gives a desk from a checkout to quit

const live = new Set<ChildProcess>();
let hooked = false;

export function track(child: ChildProcess): void {
  if (!child.pid) return; // never started: its error says why, and -0 would be the desk's own group
  if (!hooked) {
    hooked = true;
    // A desk that crashes still takes them along.
    process.once("exit", () => {
      for (const c of live) signal(c, "SIGKILL");
    });
  }
  live.add(child);
  child.once("close", () => {
    live.delete(child);
  });
}

function signal(child: ChildProcess, sig: NodeJS.Signals): void {
  try {
    if (win) execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
    else process.kill(-child.pid!, sig);
  } catch {} // the group is gone
}

// SIGTERM to its group, then SIGKILL after `grace` for whatever ignored it.
export function kill(child: ChildProcess, grace = GRACE): void {
  if (!live.has(child)) return;
  signal(child, "SIGTERM");
  if (win) return; // taskkill /F is already the hard kill
  const hard = setTimeout(() => {
    if (live.has(child)) signal(child, "SIGKILL");
  }, grace);
  hard.unref();
}

// The desk closing: resolves once every agent is gone, or a second after the SIGKILL for those that ignored SIGTERM.
export async function stopAll(grace = GRACE): Promise<void> {
  const all = [...live];
  if (!all.length) return;
  const gone = Promise.all(
    all.map(
      (c) =>
        new Promise((r) => {
          c.once("close", r);
        }),
    ),
  );
  for (const c of all) kill(c, grace);
  await Promise.race([gone, sleep(grace + 1000, undefined, { ref: false })]);
}
