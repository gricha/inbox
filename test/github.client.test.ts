import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient, GH_MISSING, RateLimitedError } from "../src/github/client.ts";

type Body = { query: string; variables: Record<string, unknown> };

function fakeFetch(...responses: ((b: Body) => Response)[]) {
  const calls: (Body & { headers: Record<string, string> })[] = [];
  const f = ((_url: string, init: RequestInit) => {
    const body: Body = JSON.parse(init.body as string);
    calls.push({ ...body, headers: init.headers as Record<string, string> });
    const r = responses[Math.min(calls.length, responses.length) - 1];
    // A throwing response becomes a rejection, as with a real fetch.
    return new Promise<Response>((resolve) => {
      if (!r) throw new Error("fakeFetch needs a response");
      resolve(r(body));
    });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

const RL = { remaining: 4000, resetAt: "2099-01-01T00:00:00Z", cost: 1 };
const ok =
  (data: object, extra: object = {}) =>
  () =>
    new Response(JSON.stringify({ data: { rateLimit: RL, ...data }, ...extra }));
const status =
  (code: number, text = "", headers: Record<string, string> = {}) =>
  () =>
    new Response(text, { status: code, headers });
const client = (f: typeof fetch, logs: string[] = []) =>
  createClient({
    token: "t0ken",
    fetch: f,
    retryDelayMs: 0,
    log: (m) => {
      logs.push(m);
    },
  });

test("refuses mutations without calling GitHub", async () => {
  const fake = fakeFetch(ok({}));
  await assert.rejects(client(fake.fetch).query("mutation { addStar(input: {}) { clientMutationId } }"), /read-only/);
  assert.equal(fake.calls.length, 0);
});

test("sends the token and variables, returns data, tracks the rate limit", async () => {
  const fake = fakeFetch(ok({ viewer: { login: "octo-dev" } }));
  const c = client(fake.fetch);
  assert.equal(c.rateLimit(), null);
  const d = await c.query<{ viewer: { login: string } }>("query($a: Int) { viewer { login } }", { a: 1 });
  assert.equal(d.viewer.login, "octo-dev");
  assert.equal(fake.calls[0]?.headers.authorization, "bearer t0ken");
  assert.deepEqual(fake.calls[0]?.variables, { a: 1 });
  assert.deepEqual(c.rateLimit(), { remaining: 4000, reset_at: "2099-01-01T00:00:00Z" });
});

test("retries 502 and network errors, then succeeds", async () => {
  const logs: string[] = [];
  const fake = fakeFetch(
    status(502, "<html>bad gateway</html>"),
    () => {
      throw new TypeError("fetch failed");
    },
    ok({ x: 1 }),
  );
  assert.deepEqual(await client(fake.fetch, logs).query("query { x }"), { rateLimit: RL, x: 1 });
  assert.equal(fake.calls.length, 3);
  assert.equal(logs.length, 2);
});

test("gives up after two retries", async () => {
  const fake = fakeFetch(status(503));
  await assert.rejects(client(fake.fetch).query("query { x }"), /GitHub HTTP 503/);
  assert.equal(fake.calls.length, 3);
});

test("retries a GraphQL-level timeout", async () => {
  const fake = fakeFetch(
    () =>
      new Response(
        JSON.stringify({
          data: null,
          errors: [{ message: "Something went wrong while executing your query. This may be the result of a timeout" }],
        }),
      ),
    ok({ x: 2 }),
  );
  assert.equal((await client(fake.fetch).query<{ x: number }>("query { x }")).x, 2);
});

test("NOT_FOUND errors are not fatal; other errors throw", async () => {
  const notFound = fakeFetch(
    ok({ nodes: [{ id: "a" }, null] }, { errors: [{ type: "NOT_FOUND", path: ["nodes", 1], message: "Could not resolve to a node" }] }),
  );
  assert.deepEqual((await client(notFound.fetch).query<{ nodes: unknown[] }>("query { nodes }")).nodes, [{ id: "a" }, null]);

  const broken = fakeFetch(ok({}, { errors: [{ type: "INVALID", message: "Field 'nope' doesn't exist" }] }));
  await assert.rejects(client(broken.fetch).query("query { nope }"), /Field 'nope' doesn't exist/);
  assert.equal(broken.calls.length, 1);
});

test("FORBIDDEN (e.g. SAML) with partial data is skipped and logged; with no data it throws", async () => {
  const logs: string[] = [];
  const saml = {
    type: "FORBIDDEN",
    path: ["viewer", "organizations", "nodes", 1],
    message: "Resource protected by organization SAML enforcement",
  };
  const partial = fakeFetch(ok({ orgs: [{ login: "acme" }, null] }, { errors: [saml] }));
  assert.deepEqual((await client(partial.fetch, logs).query<{ orgs: unknown[] }>("query { orgs }")).orgs, [{ login: "acme" }, null]);
  assert.match(logs[0] ?? "", /SAML/);

  const empty = fakeFetch(
    () => new Response(JSON.stringify({ data: null, errors: [saml, { type: "NOT_FOUND", message: "Could not resolve" }] })),
  );
  await assert.rejects(client(empty.fetch).query("query { x }"), /SAML.*Could not resolve/);
});

test("secondary rate limit (403/429) throws RateLimitedError with resetAt", async () => {
  const fake = fakeFetch(status(403, '{"message":"You have exceeded a secondary rate limit"}', { "retry-after": "120" }));
  const before = Date.now();
  const err = await client(fake.fetch)
    .query("query { x }")
    .catch((e) => e);
  assert.ok(err instanceof RateLimitedError);
  const wait = Date.parse(err.resetAt) - before;
  assert.ok(wait >= 119_000 && wait <= 125_000, `wait ${wait}`);
  assert.equal(fake.calls.length, 1);

  await assert.rejects(client(fakeFetch(status(429)).fetch).query("query { x }"), RateLimitedError);
});

test("a 403 that isn't a rate limit is a plain error", async () => {
  await assert.rejects(
    client(fakeFetch(status(403, '{"message":"Resource not accessible by integration"}')).fetch).query("query { x }"),
    (e: Error) => !(e instanceof RateLimitedError) && e.message.includes("HTTP 403"),
  );
});

test("primary limit exhausted (RATE_LIMITED) uses the reset header", async () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  const fake = fakeFetch(
    () =>
      new Response(JSON.stringify({ data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }), {
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
      }),
  );
  const err = await client(fake.fetch)
    .query("query { x }")
    .catch((e) => e);
  assert.ok(err instanceof RateLimitedError);
  assert.equal(err.resetAt, new Date(reset * 1000).toISOString());
});

test("remaining below 200 blocks further calls until reset", async () => {
  const low = { remaining: 150, resetAt: "2099-01-01T00:00:00Z", cost: 1 };
  const fake = fakeFetch(() => new Response(JSON.stringify({ data: { rateLimit: low, x: 1 } })));
  const c = client(fake.fetch);
  await c.query("query { x }");
  const err = await c.query("query { x }").catch((e) => e);
  assert.ok(err instanceof RateLimitedError);
  assert.equal(err.resetAt, "2099-01-01T00:00:00Z");
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(c.rateLimit(), { remaining: 150, reset_at: "2099-01-01T00:00:00Z" });
});

test("a past reset lets calls through again", async () => {
  const fake = fakeFetch(() => new Response(JSON.stringify({ data: { rateLimit: { remaining: 10, resetAt: "2000-01-01T00:00:00Z" } } })));
  const c = client(fake.fetch);
  await c.query("query { x }");
  await c.query("query { x }");
  assert.equal(fake.calls.length, 2);
});

test("a missing gh says how to install it", async () => {
  const env = { PATH: process.env.PATH, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), "desk-nogh-"));
  delete process.env.GITHUB_TOKEN;
  try {
    const fake = fakeFetch(ok({}));
    await assert.rejects(createClient({ fetch: fake.fetch }).query("query { viewer { login } }"), (e: Error) => e.message === GH_MISSING);
    assert.equal(fake.calls.length, 0);
  } finally {
    process.env.PATH = env.PATH;
    if (env.GITHUB_TOKEN !== undefined) process.env.GITHUB_TOKEN = env.GITHUB_TOKEN;
  }
});
