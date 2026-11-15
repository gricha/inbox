import type { TestContext } from "node:test";

// A fake CLI written as a #! script can't run on Windows: a test that has one answer skips there.
export function unixOnly(c: TestContext): boolean {
  if (process.platform !== "win32") return false;
  c.skip("its fake CLI is a #! script, which Windows can't run");
  return true;
}
