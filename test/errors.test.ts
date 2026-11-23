import "./helpers/no-agent.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { refusalOf } from "../src/errors.ts";

test("a refusal reads its tag, or its status when an older desk sent none or one it doesn't know", () => {
  const cases: [number, unknown, ReturnType<typeof refusalOf>][] = [
    [409, { error: "it moved", tag: "Stale" }, { tag: "Stale", error: "it moved" }],
    [400, { error: "no", tag: "Nonsense" }, { tag: "BadRequest", error: "no" }],
    [409, { error: "which?", candidates: ["a#1", "b#1"] }, { tag: "AmbiguousRef", error: "which?", candidates: ["a#1", "b#1"] }],
    [409, { error: "no" }, { tag: "Conflict", error: "no" }],
    [503, { error: "config.toml has errors" }, { tag: "Unavailable", error: "config.toml has errors", reason: "config" }],
    [503, { error: "syncing", tag: "Unavailable", reason: "config" }, { tag: "Unavailable", error: "syncing", reason: "config" }],
    [503, null, { tag: "Unavailable", reason: "starting" }],
    [418, "teapot", { tag: "Internal" }],
  ];
  for (const [status, body, want] of cases) assert.deepEqual(refusalOf(status, body), want, `${status} ${JSON.stringify(body)}`);
});
