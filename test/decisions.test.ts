// The Decisions API client, against a local stand-in: the request it sends is the documented one, and what comes back is
// read strictly. Never the real API, never a real key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, type Question } from "../src/decisions.ts";
import { fakeDecisions } from "./helpers/decisions.ts";
import { failure, run } from "./helpers/run.ts";

const KEY = "sk-or-v1-0000000000000000000000000000000000000000000000000000000000000000";
const YES_NO: Question = { type: "noul", instructions: "Is it a bot's?", criteria: { true: "A bot opened it.", false: "A person did." } };
const WHERE: Question = { type: "choice", instructions: "Where does it go?", criteria: { fyi: "nobody needs me", leave: "as it is" } };

test("a request is the documented one: POST, the key as a bearer token, and model, state and questions in the body", async (c) => {
  const api = await fakeDecisions(() => ({
    json: {
      id: "gen-dec-1",
      model: "typesafe/jev-1.14-20261014",
      provider: "TypeSafe",
      answers: {
        bot: { type: "noul", noul: 0.96 },
        where: { type: "choice", choice: "fyi", confidence: 0.67, probabilities: { fyi: 0.78, leave: 0.22 } },
      },
      usage: { input_tokens: 476, output_tokens: 70, cost: 0.00002 },
    },
  }));
  c.after(api.close);
  const state = { note: "one item", item: ["id: acme/api#4", "title: Bump deps"] };
  const answers = await run(decide(state, { bot: YES_NO, where: WHERE }, { key: KEY, model: "typesafe/jev-1.14", url: api.url }));
  assert.deepEqual(answers, {
    bot: { type: "noul", noul: 0.96 },
    where: { type: "choice", choice: "fyi", probabilities: { fyi: 0.78, leave: 0.22 } },
  });
  const [call] = api.calls;
  assert.deepEqual(
    [call!.method, call!.path, call!.authorization, call!.contentType],
    ["POST", "/api/alpha/decisions", `Bearer ${KEY}`, "application/json"],
  );
  assert.deepEqual(call!.body, { model: "typesafe/jev-1.14", state, questions: { bot: YES_NO, where: WHERE } }, "nothing else is sent");
});

test("a refusal is an answer; a question left out, or answered as another type, fails the call, never a default", async (c) => {
  let answers: unknown = { bot: { type: "refusal" } };
  const api = await fakeDecisions(() => ({ json: { model: "m", answers, usage: {} } }));
  c.after(api.close);
  const opts = { key: KEY, model: "typesafe/jev-1.14", url: api.url };
  assert.deepEqual(await run(decide("x", { bot: YES_NO }, opts)), { bot: { type: "refusal" } });
  answers = { where: { type: "choice", choice: "fyi" } };
  assert.deepEqual(
    await run(decide("x", { where: WHERE }, opts)),
    { where: { type: "choice", choice: "fyi" } },
    "probabilities are optional",
  );
  for (const bad of [{}, { bot: { type: "choice", choice: "fyi" } }, { bot: { type: "noul" } }, { bot: { type: "noul", noul: "0.9" } }]) {
    answers = bad;
    const e: { _tag: string; message: string } = await failure(decide("x", { bot: YES_NO }, opts));
    assert.deepEqual([e._tag, e.message], ["DecisionModelError", 'the decision model gave no noul answer to "bot"'], JSON.stringify(bad));
  }
});

test("401, 402, 429, a 5xx and no answer are the model being down, in the owner's words; anything else is its error, and neither repeats the key", async (c) => {
  let next: { status: number; json?: unknown; text?: string } = {
    status: 401,
    json: { error: { code: 401, message: "Missing Authentication header" } },
  };
  const api = await fakeDecisions(() => next);
  c.after(api.close);
  const ask = () => failure(decide("x", { bot: YES_NO }, { key: KEY, model: "typesafe/jev-1.14", url: api.url }));
  for (const [status, words] of [
    [401, "OpenRouter refused the decision model's key (401). Check it in Settings → Agent."],
    [
      402,
      "OpenRouter says the decision model's key is out of credits (402). Add credits, or clear the key in Settings → Agent and Claude answers instead.",
    ],
    [429, "OpenRouter is rate limiting the decision model (429)."],
  ] as const) {
    next = { status, json: { error: { code: status, message: `no: ${KEY}` } } };
    const e = await ask();
    assert.deepEqual([e._tag, "status" in e && e.status, e.message], ["DecisionModelDown", status, words]);
  }
  next = { status: 400, json: { error: { code: 400, message: `Invalid request parameters for key ${KEY}` } } };
  const refused = await ask();
  assert.deepEqual(
    [refused._tag, refused.message],
    ["DecisionModelError", "the decision model failed: Invalid request parameters for key [key] (HTTP 400)"],
  );
  next = { status: 200, text: "<html>Fine</html>" };
  assert.equal((await ask()).message, "the decision model's answer isn't JSON (HTTP 200)");
  next = { status: 500, json: { error: { code: 500, message: `provider overloaded for ${KEY}` } } };
  const failed = await ask();
  assert.deepEqual(
    [failed._tag, "status" in failed && failed.status, failed.message],
    ["DecisionModelDown", 500, "OpenRouter's decision model failed: provider overloaded for [key] (HTTP 500)."],
  );
  next = { status: 502, text: "<html>Bad gateway</html>" };
  const gateway = await ask();
  assert.deepEqual([gateway._tag, gateway.message], ["DecisionModelDown", "OpenRouter's decision model failed (HTTP 502)."]);
  await api.close();
  const gone = await ask();
  assert.equal(gone._tag, "DecisionModelDown");
  assert.match(gone.message, /^OpenRouter couldn't be reached: /);
  assert.ok(!gone.message.includes(KEY));
});
