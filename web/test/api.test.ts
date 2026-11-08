// The window's API calls: an error answer decoded into the UI's tagged errors the way docs/effect.md's "The wire" says (a
// tag when the desk sends one, its status when an older desk doesn't), and runUi, which throws nothing and reports only bugs.
import assert from "node:assert/strict";
import { STATUS_CODES } from "node:http";
import { afterEach, test } from "node:test";
import * as Sentry from "@sentry/react";
import { Effect } from "effect";
import type { ErrorBody } from "../../src/errors.ts";
import { api, runUi, type ApiError } from "../src/api.ts";

const events: Sentry.ErrorEvent[] = [];
Sentry.init({
  dsn: "https://public@o0.ingest.sentry.io/0",
  defaultIntegrations: false,
  integrations: [],
  beforeSend: (e) => {
    events.push(e);
    return null;
  },
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  events.length = 0;
});

// The desk answers every request with this; the calls it saw, as "METHOD path".
function desk(status: number, body: string, type = "application/json; charset=utf-8"): string[] {
  const seen: string[] = [];
  globalThis.fetch = (input, init) => {
    seen.push(`${init?.method ?? "GET"} ${typeof input === "string" ? input : input instanceof URL ? input.href : input.url}`);
    return Promise.resolve(new Response(body, { status, statusText: STATUS_CODES[status], headers: { "content-type": type } }));
  };
  return seen;
}
const refusing = (status: number, body: Partial<ErrorBody>) => desk(status, JSON.stringify(body));
const failure = <A>(effect: Effect.Effect<A, ApiError>) => Effect.runPromise(Effect.flip(effect));

test("a refusal with a tag is decoded by its tag, its words verbatim", async () => {
  refusing(409, { error: "already approving acme/api#1", tag: "Busy" });
  const busy = await failure(api.approve("acme/api#1", "abc"));
  assert.equal(busy._tag, "DeskConflict");
  assert.equal(busy._tag === "DeskConflict" && busy.kind, "Busy");
  assert.equal(busy.message, "already approving acme/api#1");

  refusing(409, { error: '"api#1" matches 2 items', tag: "AmbiguousRef", candidates: ["acme/api#1", "oss/api#1"] });
  const ambiguous = await failure(api.act("api#1", "done"));
  assert.deepEqual(ambiguous._tag === "DeskConflict" && [ambiguous.kind, ambiguous.candidates], [
    "AmbiguousRef",
    ["acme/api#1", "oss/api#1"],
  ]);

  refusing(502, { error: "Marked it ready, but GitHub didn't ask for the reviews: boom", tag: "ReviewersNotAsked" });
  const half = await failure(api.ready("acme/api#1", { users: ["u"], teams: [] }));
  assert.equal(half._tag, "ReviewersNotAsked");
  assert.equal(half.message, "Marked it ready, but GitHub didn't ask for the reviews: boom");

  refusing(404, { error: "unknown item acme/api#9", tag: "NotFound" });
  const missing = await failure(api.item("acme/api#9"));
  assert.deepEqual(missing._tag === "DeskRequestFailed" && [missing.status, missing.kind, missing.message], [
    404,
    "NotFound",
    "unknown item acme/api#9",
  ]);
});

test("a refusal without a tag (an older desk) is decoded by its status", async () => {
  const cases: [number, Partial<ErrorBody>, string, string][] = [
    [400, { error: "the comment is empty" }, "DeskRequestFailed", "BadRequest"],
    [403, { error: "not from here" }, "DeskRequestFailed", "Forbidden"],
    [404, { error: "not found" }, "DeskRequestFailed", "NotFound"],
    [409, { error: "in Merging already" }, "DeskConflict", "Conflict"],
    [409, { error: "matches 2 items", candidates: ["a/b#1", "c/b#1"] }, "DeskConflict", "AmbiguousRef"],
    // No words to go on: a 502 is GitHub refusing, even "Marked it ready…".
    [502, { error: "Marked it ready, but GitHub didn't ask for the reviews: boom" }, "DeskRequestFailed", "Upstream"],
    [500, { error: "boom" }, "DeskRequestFailed", "Internal"],
  ];
  for (const [status, body, tag, kind] of cases) {
    refusing(status, body);
    const e = await failure(api.act("acme/api#1", "done"));
    assert.equal(e._tag, tag, `${status} ${body.error}`);
    assert.equal((e as { kind?: string }).kind, kind, `${status} ${body.error}`);
    assert.equal(e.message, body.error);
  }
});

test("a 503 is the desk starting or its rules broken, by its reason or else its words", async () => {
  const cases: [Partial<ErrorBody>, string][] = [
    [{ error: "desk is starting; the first sync can take a minute", tag: "Unavailable", reason: "starting" }, "DeskStarting"],
    [{ error: "config has errors: boards.0.when: unknown field", tag: "Unavailable", reason: "config" }, "DeskConfigBroken"],
    [{ error: "config has errors: boards.0.when: unknown field" }, "DeskConfigBroken"],
    [{ error: "desk is starting; the first sync can take a minute" }, "DeskStarting"],
    [{ error: "config has errors: x", tag: "Unavailable" }, "DeskConfigBroken"],
  ];
  for (const [body, tag] of cases) {
    refusing(503, body);
    const e = await failure(api.queue());
    assert.equal(e._tag, tag, JSON.stringify(body));
    assert.equal(e.message, body.error);
  }
});

test("a 409 from saving the policy or the rules is Stale whatever its tag; elsewhere it isn't", async () => {
  refusing(409, { error: "policy.md changed since you opened it", tag: "Conflict" });
  const policy = await failure(api.savePolicy("text", "base"));
  assert.equal(policy._tag === "DeskConflict" && policy.kind, "Stale");
  refusing(409, { error: "config.toml changed on disk since you opened it" });
  const config = await failure(api.saveConfig("text", "base"));
  assert.equal(config._tag === "DeskConflict" && config.kind, "Stale");
  const seen = refusing(409, { error: "in Merging already" });
  const act = await failure(api.act("acme/api#1", "inflight"));
  assert.equal(act._tag === "DeskConflict" && act.kind, "Conflict");
  assert.deepEqual(seen, ["POST /api/act"]);
});

test("no answer, or one that isn't JSON (a proxy's page, the UI starting), is the desk unreachable", async () => {
  desk(503, "<!doctype html><p>The UI from your checkout is starting", "text/html; charset=utf-8");
  const page = await failure(api.overview());
  assert.equal(page._tag, "DeskUnreachable");
  assert.equal(page.message, "desk server not reachable");

  desk(200, "ok", "text/plain");
  assert.equal((await failure(api.queue()))._tag, "DeskUnreachable");

  const refused = new TypeError("fetch failed");
  globalThis.fetch = () => Promise.reject(refused);
  const gone = await failure(api.queue());
  assert.equal(gone._tag, "DeskUnreachable");
  assert.equal(gone._tag === "DeskUnreachable" && gone.cause, refused);
});

test("a 2xx body cut short is a bad response in the parser's words; a refusal's says what it is by its status", async () => {
  desk(200, '{"sections": {');
  const cut = await failure(api.queue());
  assert.equal(cut._tag, "DeskBadResponse");
  assert.ok(cut.message.length > 0 && cut.message !== "desk server not reachable", cut.message);

  desk(409, "{");
  const refusal = await failure(api.act("acme/api#1", "done"));
  assert.equal(refusal._tag, "DeskConflict");
  assert.equal(refusal.message, "Conflict"); // the status text

  desk(404, "null");
  assert.equal((await failure(api.item("x"))).message, "Not Found");

  // HTTP/2 has no status text: the code says it.
  globalThis.fetch = () => Promise.resolve(new Response("{", { status: 502, headers: { "content-type": "application/json" } }));
  assert.equal((await failure(api.sync())).message, "502");
});

test("an answer decodes to the value", async () => {
  desk(200, JSON.stringify({ ok: true, hash: "h2" }));
  assert.deepEqual(await Effect.runPromise(api.savePolicy("text", "h1")), { ok: true, hash: "h2" });
});

test("runUi: an interrupted read aborts its request and says nothing", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  let signal: AbortSignal | undefined;
  globalThis.fetch = (_input, init) =>
    new Promise((_ok, fail) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener("abort", () => {
        fail(new DOMException("aborted", "AbortError"));
      });
    });
  const stop = new AbortController();
  runUi(api.queue().pipe(Effect.ignore), { signal: stop.signal });
  stop.abort(); // the effect's cleanup
  assert.equal(signal?.aborted, true);
  await Sentry.flush(500);
  assert.equal(logged.mock.callCount(), 0);
  assert.equal(events.length, 0);
});

test("runUi: a write without a signal runs to its end", async () => {
  desk(200, JSON.stringify({ ok: true, url: "https://github.com/acme/api/pull/1#c" }));
  const wrote = await new Promise<boolean>((done) => {
    runUi(api.comment("acme/api#1", "hi").pipe(Effect.isSuccess, Effect.map(done)));
  });
  assert.ok(wrote);
});

test("runUi: a bug is logged and reported, and nothing escapes it", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const bug = new TypeError("Cannot read properties of undefined (reading 'card')");
  assert.doesNotThrow(() => {
    runUi(Effect.die(bug));
  });
  await Sentry.flush(500);
  assert.equal(logged.mock.callCount(), 1);
  assert.match(String(logged.mock.calls[0]?.arguments[0]), /Cannot read properties of undefined/);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.exception?.values?.[0]?.value, bug.message);
});
