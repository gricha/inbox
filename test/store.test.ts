import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { makeItem, NOW } from "./helpers/items.ts";

test("a PR stored without requires lacks it; one with [] doesn't", () => {
  const store = new Store(":memory:");
  const { requires: _, ...old } = makeItem({ number: 1 });
  const { requires: __, ...issue } = makeItem({ number: 3, kind: "issue" });
  store.putItems([old, makeItem({ number: 2 }), issue], NOW.toISOString());
  const meta = store.itemMeta();
  assert.deepEqual(
    ["acme/api#1", "acme/api#2", "acme/api#3"].map((id) => meta.get(id)?.lacks),
    [true, false, false],
  );
  store.close();
});
