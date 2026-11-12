// A PR's file at its head, for its review's more lines: read once per commit, null when GitHub won't give it whole.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewAsk, setup } from "./helpers/desk.ts";
import { run } from "./helpers/run.ts";

test("a PR's file at its head is read from GitHub once per commit, and null when GitHub won't give it", async (c) => {
  const t = await setup([reviewAsk(1, { head_oid: "h1" })]);
  c.after(t.cleanup);
  await run(t.desk.sync());
  t.gh.blobs.set("h1:src/a.ts", "one\ntwo\n");
  let reads = 0;
  const blob = t.gh.blob.bind(t.gh);
  t.gh.blob = (repo, oid, path) => {
    reads++;
    return blob(repo, oid, path);
  };
  assert.deepEqual(await run(t.desk.fileAt("api#1", "src/a.ts")), { text: "one\ntwo\n" });
  assert.deepEqual(await run(t.desk.fileAt("api#1", "src/a.ts")), { text: "one\ntwo\n" });
  assert.equal(reads, 1, "kept by commit");
  assert.deepEqual(await run(t.desk.fileAt("api#1", "img/logo.png")), { text: null });
  await assert.rejects(run(t.desk.fileAt("api#1", "")), /need path/);
});
