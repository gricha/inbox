import assert from "node:assert/strict";
import { test } from "node:test";
import { keepComment, keptComment } from "../src/drafts.ts";

test("your unsent comment on a PR is kept by PR, so leaving its review doesn't lose it, until it's sent or emptied", () => {
  assert.equal(keptComment("acme/api#1"), "");
  keepComment("acme/api#1", "Two things before this merges:\n1. the budget");
  keepComment("acme/api#2", "Looks right");
  assert.equal(keptComment("acme/api#1"), "Two things before this merges:\n1. the budget");
  keepComment("acme/api#1", " \n"); // sent, or emptied: only space is nothing to keep
  assert.deepEqual([keptComment("acme/api#1"), keptComment("acme/api#2")], ["", "Looks right"]);
});
