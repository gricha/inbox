import { test } from "node:test";
import assert from "node:assert/strict";
import { notify, openUrl } from "../src/notify.ts";

// execFile refuses a NUL byte before it starts anything, so nothing is shown or opened here.
test("a notification never fails what sent it, even with text execFile refuses", () => {
  assert.doesNotThrow(() => {
    notify("a title\0", "a body");
  });
  assert.doesNotThrow(() => {
    openUrl("https://example.com/\0");
  });
});
