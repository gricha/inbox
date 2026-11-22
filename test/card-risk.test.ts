// A row's risk is its AI review's, not a guess from the verdict: "skim it" can be low risk.

import "./helpers/no-agent.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewAsk, setup } from "./helpers/desk.ts";
import { run, runSync } from "./helpers/run.ts";

test("a card carries its AI review's risk for the current commit only", async (c) => {
  const t = await setup([reviewAsk(1), reviewAsk(2)]);
  c.after(t.cleanup);
  await run(t.desk.sync());
  const one = t.gh.items.get("acme/api#1")!;
  const review = { verdict: "skim", risk: "low", summary: "", concerns: [], notes: [], model: "claude", at: new Date().toISOString() };
  t.desk.store.set("review:acme/api#1", { ...review, head_oid: one.head_oid });
  t.desk.store.set("review:acme/api#2", { ...review, head_oid: "an-earlier-commit" });
  t.desk.changed();
  const card = (ref: string) => runSync(t.desk.item(ref)).card;
  assert.equal(card("api#1").verdict, "skim");
  assert.equal(card("api#1").risk, "low");
  assert.equal(card("api#2").risk, undefined, "an earlier commit's review says nothing of this one");
});
