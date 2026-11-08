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

test("pruning one source's rows leaves the others'", () => {
  const store = new Store(":memory:");
  const at = NOW.toISOString();
  const note = { id: "notes:1", url: "", created_at: at, updated_at: at };
  store.putItems([makeItem({ number: 1 }), note, { ...note, id: "notesy:1" }], at);
  const later = new Date(NOW.getTime() + 1).toISOString();
  store.pruneItems("notes", later);
  assert.deepEqual([...store.itemMeta().keys()].sort(), ["acme/api#1", "notesy:1"]);
  store.pruneItems("github", later);
  assert.deepEqual([...store.itemMeta().keys()], ["notesy:1"]);
  store.close();
});
