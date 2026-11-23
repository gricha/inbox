// The iOS app's decoding tests read saved copies of the mock's answers (ios/InboxTests/Fixtures): each key path in a copy
// must still be in what the mock answers now, or the app's tests pass against a shape the desk no longer sends.
// scripts/ios-fixtures.ts saves them again.
import "../../test/helpers/no-agent.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { FIXTURES, keyPaths, startMock } from "../../scripts/ios-fixtures.ts";

let mock: { base: string; stop: () => void };
before(async () => {
  mock = await startMock();
});
after(() => {
  mock.stop();
});

test("each iOS fixture's key paths are still in the mock's answer to its read", async () => {
  const gone: Record<string, string[]> = {};
  for (const [name, path] of Object.entries(FIXTURES)) {
    const saved: unknown = JSON.parse(fs.readFileSync(new URL(`../../ios/InboxTests/Fixtures/${name}.json`, import.meta.url), "utf8"));
    const now = keyPaths(await (await fetch(mock.base + path)).json());
    const missing = [...keyPaths(saved)].filter((p) => !now.has(p));
    if (missing.length) gone[name] = missing;
  }
  assert.deepEqual(gone, {});
});
