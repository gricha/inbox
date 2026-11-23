// Who a bot's PR was opened for, where no line says: the light model reads it once per description, in the background.
import "./helpers/no-agent.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { personOf } from "../src/attribution.ts";
import type { Item } from "../src/types.ts";
import { teamPing, idle, QUIET, reviewAsk, setup } from "./helpers/desk.ts";
import { hoursAgo } from "./helpers/items.ts";
import { run, runSync } from "./helpers/run.ts";
import { posix } from "./helpers/platform.ts";
import { until } from "./helpers/wait.ts";
import { fakeAgent } from "./helpers/fake-agent.ts";

// A claude that answers answer.json's items and keeps each call's prompt.
function fakeClaude(c: TestContext) {
  const f = fakeAgent(
    c,
    "claude",
    `n=$(($(cat "$d/count" 2>/dev/null || echo 0) + 1)); echo $n > "$d/count"\ncat > "$d/stdin.$n"\nprintf '{"type":"result","is_error":false,"structured_output":%s}' "$(cat "$d/answer.json")"`,
  );
  return {
    say: (items: { id: string; person: string }[]) => {
      f.write("answer.json", JSON.stringify({ items }));
    },
    calls: () => Number(f.read("count") || 0),
    stdin: (n: number) => f.read(`stdin.${n}`),
  };
}

async function settled(t: Awaited<ReturnType<typeof setup>>) {
  await idle(t.desk);
  await until(() => !t.desk.attributions.running && !t.desk.attributions.due().length);
}

const claudePr = (o: Partial<Item> = {}) =>
  reviewAsk(1, {
    author: "claude[bot]",
    author_bot: true,
    requester: "",
    body: "Fixes the flaky login test.\nAsked for by Dana Quinn in #eng.",
    ...o,
  });
const juniorPr = reviewAsk(2, { author: "sentry-junior", author_bot: true, requester: "@sam", body: "Retries the webhook.\nvia @sam." });

test("a bot's PR with no line is read by the light model once per description; one with a line never is", posix, async (c) => {
  const fake = fakeClaude(c);
  fake.say([{ id: "acme/api#1", person: "Dana Quinn" }]);
  const t = await setup([claudePr(), juniorPr], { settings: QUIET });
  c.after(t.cleanup);
  await run(t.desk.sync());
  await settled(t);
  assert.equal(fake.calls(), 1);
  assert.match(fake.stdin(1), /Asked for by Dana Quinn/);
  assert.ok(!fake.stdin(1).includes("acme/api#2"), "Junior's line says who: no model");
  const card = (id: string) => runSync(t.desk.item(id)).card;
  assert.deepEqual(card("acme/api#1").attribution, { person: "Dana Quinn", agent: "claude[bot]", source: "model" });
  assert.equal(card("acme/api#1").by, "Dana Quinn");
  assert.deepEqual(card("acme/api#2").attribution, { person: "@sam", agent: "sentry-junior", source: "line" });
  assert.equal(card("acme/api#2").by, "sam");

  // Another pass over the same description asks nothing.
  t.gh.items.set("acme/api#1", { ...claudePr(), updated_at: hoursAgo(0) });
  await run(t.desk.sync());
  await settled(t);
  assert.equal(fake.calls(), 1, "kept for its description");

  // An edited description is read again; nobody named reads as none.
  fake.say([{ id: "acme/api#1", person: "" }]);
  t.gh.items.set("acme/api#1", {
    ...claudePr({ body: "Fixes the flaky login test." }),
    updated_at: new Date(Date.parse(hoursAgo(0)) + 60_000).toISOString(),
  });
  await run(t.desk.sync());
  await settled(t);
  assert.equal(fake.calls(), 2);
  assert.deepEqual(card("acme/api#1").attribution, { person: "", agent: "claude[bot]", source: "none" });
  assert.equal(card("acme/api#1").by, "claude[bot]");
});

test("a bot's PR the bot-pr rule hides is read too, and stays hidden only when nobody asked for it", posix, async (c) => {
  const fake = fakeClaude(c);
  fake.say([
    { id: "acme/api#3", person: "Dana Quinn" },
    { id: "acme/api#4", person: "" },
  ]);
  const ping = (n: number, body: string, tail = "") => ({ ...teamPing(n), author: "claude[bot]", author_bot: true, body, tail });
  const t = await setup([ping(3, "Fixes the flaky login test.", "Asked for by Dana Quinn."), ping(4, "Bumps lodash.")], {
    settings: QUIET,
    builtIns: true,
  });
  c.after(t.cleanup);
  await run(t.desk.sync());
  await settled(t);
  assert.equal(fake.calls(), 1);
  assert.match(fake.stdin(1), /description's end: Asked for by Dana Quinn\./, "where agents sign who asked");
  const bucket = (id: string) => t.desk.snapshot().best.get(id)?.bucket;
  assert.notEqual(bucket("acme/api#3"), "hide", "someone asked for it: shown as a person's would be");
  assert.equal(bucket("acme/api#4"), "hide");
});

test("what the light model answers is a login or a name, never a sentence", () => {
  assert.equal(personOf("@dana"), "@dana");
  assert.equal(personOf(" Dana Quinn "), "Dana Quinn");
  assert.equal(personOf("@"), "");
  assert.equal(personOf("@dana and @sam"), "");
  assert.equal(personOf("[dana](https://x)"), "");
  assert.equal(personOf("x".repeat(61)), "");
  assert.equal(personOf("42"), "");
});
