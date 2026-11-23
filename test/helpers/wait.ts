import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

// Polls until cond holds. A passing test waits only as long as that takes; the 20 s is for a loaded machine (the whole
// suite beside other work), where starting a fake CLI can take seconds.
export async function until(cond: () => boolean | Promise<boolean>, what = "timed out waiting"): Promise<void> {
  for (const end = Date.now() + 20_000; !(await cond());) {
    if (Date.now() > end) assert.fail(what);
    await sleep(10);
  }
}
