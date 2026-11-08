import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Cause, Effect, Exit, Fiber } from "effect";
import { GitHubRateLimited } from "../src/errors.ts";
import { createClient, GH_MISSING } from "../src/github/client.ts";
import { failure, run } from "./helpers/run.ts";

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

test("refuses mutations without calling GitHub: a bug, not a failure anyone handles", async () => {
  const fake = fakeFetch(ok({}));
  const mutation = client(fake.fetch).query("mutation { addStar(input: {}) { clientMutationId } }");
  await assert.rejects(Effect.runPromise(mutation), /read-only/);
  const exit = await Effect.runPromiseExit(mutation);
  assert.ok(Exit.isFailure(exit) && Cause.hasDies(exit.cause) && !Cause.hasFails(exit.cause));
  assert.equal(fake.calls.length, 0);
});

test("sends the token and variables, returns data, tracks the rate limit", async () => {
  const fake = fakeFetch(ok({ viewer: { login: "octo-dev" } }));
  const c = client(fake.fetch);
  assert.equal(c.rateLimit(), null);
  const d = await run(c.query<{ viewer: { login: string } }>("query($a: Int) { viewer { login } }", { a: 1 }));
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
  assert.deepEqual(await run(client(fake.fetch, logs).query("query { x }")), { rateLimit: RL, x: 1 });
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(logs, ["GitHub HTTP 502; retry 1/2", "GitHub request failed: fetch failed; retry 2/2"]);
});

test("gives up after two retries", async () => {
  const fake = fakeFetch(status(503));
  const e = await failure(client(fake.fetch).query("query { x }"));
  assert.equal(e._tag, "GitHubHttpError");
  assert.deepEqual([e.message, e._tag === "GitHubHttpError" && e.status], ["GitHub HTTP 503", 503]);
  assert.equal(fake.calls.length, 3);
});

test("no answer after the retries is a network failure, with fetch's error as its cause", async () => {
  const down = new TypeError("fetch failed");
  const fake = fakeFetch(() => {
    throw down;
  });
  const e = await failure(client(fake.fetch).query("query { x }"));
  assert.deepEqual([e._tag, e.message], ["GitHubNetworkError", "GitHub request failed: fetch failed"]);
  assert.equal(e._tag === "GitHubNetworkError" && e.cause, down);
  assert.equal(fake.calls.length, 3);
});

test("interrupting a read aborts its fetch", async () => {
  let seen: AbortSignal | undefined;
  const fetch = ((_url: string, init: RequestInit) => {
    seen = init.signal ?? undefined;
    return new Promise<Response>(() => {});
  }) as unknown as typeof globalThis.fetch;
  const fiber = Effect.runFork(client(fetch).query("query { x }"));
  await new Promise((r) => {
    setTimeout(r, 10);
  });
  assert.ok(seen && !seen.aborted, "the request is out");
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.equal(seen.aborted, true);
});

test("an answer that isn't JSON is a bad response, in the parser's words, and isn't retried", async () => {
  const fake = fakeFetch(status(200, "<html>sign in</html>"));
  const e = await failure(client(fake.fetch).query("query { x }"));
  assert.equal(e._tag, "GitHubBadResponse");
  assert.match(e.message, /JSON/);
  assert.ok(e._tag === "GitHubBadResponse" && e.cause instanceof SyntaxError);
  assert.equal(fake.calls.length, 1);
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
  assert.equal((await run(client(fake.fetch).query<{ x: number }>("query { x }"))).x, 2);
});

test("NOT_FOUND errors are not fatal; other errors throw", async () => {
  const notFound = fakeFetch(
    ok({ nodes: [{ id: "a" }, null] }, { errors: [{ type: "NOT_FOUND", path: ["nodes", 1], message: "Could not resolve to a node" }] }),
  );
  assert.deepEqual((await run(client(notFound.fetch).query<{ nodes: unknown[] }>("query { nodes }"))).nodes, [{ id: "a" }, null]);

  const broken = fakeFetch(ok({}, { errors: [{ type: "INVALID", message: "Field 'nope' doesn't exist" }] }));
  const e = await failure(client(broken.fetch).query("query { nope }"));
  assert.deepEqual(
    [e._tag, e.message, e._tag === "GitHubGraphQLError" && e.types],
    ["GitHubGraphQLError", "GitHub: Field 'nope' doesn't exist", ["INVALID"]],
  );
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
  assert.deepEqual((await run(client(partial.fetch, logs).query<{ orgs: unknown[] }>("query { orgs }"))).orgs, [{ login: "acme" }, null]);
  assert.match(logs[0] ?? "", /SAML/);

  const empty = fakeFetch(
    () => new Response(JSON.stringify({ data: null, errors: [saml, { type: "NOT_FOUND", message: "Could not resolve" }] })),
  );
  await assert.rejects(run(client(empty.fetch).query("query { x }")), /SAML.*Could not resolve/);
});

test("secondary rate limit (403/429) fails with GitHubRateLimited and its resetAt", async () => {
  const fake = fakeFetch(status(403, '{"message":"You have exceeded a secondary rate limit"}', { "retry-after": "120" }));
  const before = Date.now();
  const err = await failure(client(fake.fetch).query("query { x }"));
  assert.ok(err instanceof GitHubRateLimited);
  const wait = Date.parse(err.resetAt) - before;
  assert.ok(wait >= 119_000 && wait <= 125_000, `wait ${wait}`);
  assert.equal(err.message, `GitHub rate limited until ${err.resetAt} (HTTP 403)`);
  assert.equal(fake.calls.length, 1);

  await assert.rejects(run(client(fakeFetch(status(429)).fetch).query("query { x }")), GitHubRateLimited);
});

test("a Retry-After that's a date, or unreadable, still gives a reset time", async () => {
  const date = "Wed, 21 Oct 2099 07:28:00 GMT";
  const at = await failure(client(fakeFetch(status(429, "", { "retry-after": date })).fetch).query("query { x }"));
  assert.equal(at._tag === "GitHubRateLimited" && at.resetAt, new Date(date).toISOString());
  const before = Date.now();
  const junk = await failure(client(fakeFetch(status(429, "", { "retry-after": "soon" })).fetch).query("query { x }"));
  const wait = junk._tag === "GitHubRateLimited" ? Date.parse(junk.resetAt) - before : NaN;
  assert.ok(wait >= 59_000 && wait <= 65_000, `wait ${wait}`);
  const huge = await failure(client(fakeFetch(status(429, "", { "retry-after": "1e300" })).fetch).query("query { x }"));
  assert.equal(huge._tag, "GitHubRateLimited");
});

test("a 403 that isn't a rate limit is an HTTP error", async () => {
  const e = await failure(
    client(fakeFetch(status(403, '{"message":"Resource not accessible by integration"}')).fetch).query("query { x }"),
  );
  assert.deepEqual([e._tag, e.message], ["GitHubHttpError", 'GitHub HTTP 403: {"message":"Resource not accessible by integration"}']);
});

test("primary limit exhausted (RATE_LIMITED) uses the reset header", async () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  const fake = fakeFetch(
    () =>
      new Response(JSON.stringify({ data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }), {
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
      }),
  );
  const err = await failure(client(fake.fetch).query("query { x }"));
  assert.ok(err instanceof GitHubRateLimited);
  assert.equal(err.resetAt, new Date(reset * 1000).toISOString());
  assert.equal(err.message, `GitHub rate limited until ${err.resetAt} (API rate limit exceeded)`);
});

test("remaining below 200 blocks further calls until reset", async () => {
  const low = { remaining: 150, resetAt: "2099-01-01T00:00:00Z", cost: 1 };
  const fake = fakeFetch(() => new Response(JSON.stringify({ data: { rateLimit: low, x: 1 } })));
  const c = client(fake.fetch);
  await run(c.query("query { x }"));
  const err = await failure(c.query("query { x }"));
  assert.ok(err instanceof GitHubRateLimited);
  assert.equal(err.resetAt, "2099-01-01T00:00:00Z");
  assert.equal(err.message, "GitHub rate limited until 2099-01-01T00:00:00Z (150 points left)");
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(c.rateLimit(), { remaining: 150, reset_at: "2099-01-01T00:00:00Z" });
});

test("a past reset lets calls through again", async () => {
  const fake = fakeFetch(() => new Response(JSON.stringify({ data: { rateLimit: { remaining: 10, resetAt: "2000-01-01T00:00:00Z" } } })));
  const c = client(fake.fetch);
  await run(c.query("query { x }"));
  await run(c.query("query { x }"));
  assert.equal(fake.calls.length, 2);
});

test("a missing gh says how to install it", async () => {
  const env = { PATH: process.env.PATH, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), "desk-nogh-"));
  delete process.env.GITHUB_TOKEN;
  try {
    const fake = fakeFetch(ok({}));
    const c = createClient({ fetch: fake.fetch });
    const e = await failure(c.query("query { viewer { login } }"));
    assert.deepEqual([e._tag, e._tag === "GitHubAuthError" && e.reason, e.message], ["GitHubAuthError", "gh_missing", GH_MISSING]);
    assert.equal(fake.calls.length, 0);
    // A failed read isn't kept: once there's a token, the same client uses it.
    process.env.GITHUB_TOKEN = "from-env";
    await run(c.query("query { viewer { login } }"));
    assert.equal(fake.calls[0]?.headers.authorization, "bearer from-env");
  } finally {
    process.env.PATH = env.PATH;
    if (env.GITHUB_TOKEN !== undefined) process.env.GITHUB_TOKEN = env.GITHUB_TOKEN;
    else delete process.env.GITHUB_TOKEN;
  }
});

test("stopping a token read whose gh isn't there signals nothing else", { skip: process.platform === "win32" }, async () => {
  // In its own process group: execFile's own signal option would SIGTERM that whole group here (the spawn failed, so pid 0).
  const code = `import { Cause, Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
import { readToken } from ${JSON.stringify(pathToFileURL(path.resolve("src/github/client.ts")).href)};
const ac = new AbortController();
const p = Effect.runPromiseExit(readToken(), { signal: ac.signal });
ac.abort();
const exit = await p;
console.log(exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : String(exit));`;
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "desk-nogh-"));
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: empty };
  delete env.GITHUB_TOKEN;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code], {
    detached: true,
    env,
  });
  let out = "";
  child.stdout.on("data", (d: Buffer) => {
    out += d.toString();
  });
  const [exit, signal] = await new Promise<[number | null, string | null]>((resolve) => {
    child.on("close", (c, sig) => {
      resolve([c, sig]);
    });
  });
  fs.rmSync(empty, { recursive: true });
  assert.deepEqual([exit, signal, out.trim()], [0, null, "interrupted"]);
});

test("the token is read once and kept, and read again after GitHub rejects it", async () => {
  const env = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "first";
  try {
    const fake = fakeFetch(ok({}), ok({}), status(401, "Bad credentials"), ok({}));
    const c = createClient({ fetch: fake.fetch, retryDelayMs: 0 });
    await run(c.query("query { x }"));
    process.env.GITHUB_TOKEN = "second";
    await run(c.query("query { x }"));
    const e = await failure(c.query("query { x }"));
    assert.deepEqual(
      [e._tag, e._tag === "GitHubAuthError" && e.reason, e.message],
      ["GitHubAuthError", "rejected", "GitHub rejected the token (HTTP 401): run `gh auth login`"],
    );
    await run(c.query("query { x }"));
    assert.deepEqual(
      fake.calls.map((x) => x.headers.authorization),
      ["bearer first", "bearer first", "bearer first", "bearer second"],
    );
  } finally {
    if (env !== undefined) process.env.GITHUB_TOKEN = env;
    else delete process.env.GITHUB_TOKEN;
  }
});

// REST: a fake that records the URL, method and headers.
function restFetch(...responses: (() => Response)[]) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const f = ((url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string> });
    const r = responses[Math.min(calls.length, responses.length) - 1];
    return Promise.resolve(r ? r() : new Response("[]"));
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

test("REST: refuses anything but GET without calling GitHub, so it can never mark a thread read", async () => {
  const fake = restFetch();
  const c = client(fake.fetch);
  await assert.rejects(Effect.runPromise(c.get("/notifications/threads/1", { method: "PATCH" })), /read-only: refusing to send PATCH/);
  await assert.rejects(Effect.runPromise(c.get("/notifications", { method: "put" })), /read-only/);
  await assert.rejects(Effect.runPromise(c.get("https://evil.example/x")), /not a GitHub API path/);
  await assert.rejects(Effect.runPromise(c.get("//evil.example/x")), /not a GitHub API path/);
  assert.equal(fake.calls.length, 0);
});

test("REST: GETs api.github.com with the token and headers; a 304 has no body", async () => {
  const fake = restFetch(
    () => new Response(JSON.stringify([{ id: "1" }]), { headers: { "last-modified": "Tue, 27 Oct 2026 12:00:00 GMT" } }),
    () => new Response(null, { status: 304, headers: { "x-poll-interval": "120" } }),
  );
  const c = client(fake.fetch);
  const r = await run(c.get("/notifications?all=true"));
  assert.deepEqual([r.status, r.data, r.headers.get("last-modified")], [200, [{ id: "1" }], "Tue, 27 Oct 2026 12:00:00 GMT"]);
  assert.equal(fake.calls[0]?.url, "https://api.github.com/notifications?all=true");
  assert.equal(fake.calls[0]?.method, "GET");
  assert.equal(fake.calls[0]?.headers.authorization, "bearer t0ken");
  const again = await run(c.get("/notifications", { headers: { "if-modified-since": "Tue, 27 Oct 2026 12:00:00 GMT" } }));
  assert.deepEqual([again.status, again.data], [304, null]);
  assert.equal(fake.calls[1]?.headers["if-modified-since"], "Tue, 27 Oct 2026 12:00:00 GMT");
});

test("REST: rate limits fail with GitHubRateLimited; 502s are retried", async () => {
  await assert.rejects(run(client(restFetch(() => new Response("", { status: 429 })).fetch).get("/notifications")), GitHubRateLimited);
  const flaky = restFetch(
    () => new Response("", { status: 502 }),
    () => new Response("[]"),
  );
  assert.deepEqual((await run(client(flaky.fetch).get("/notifications"))).data, []);
  assert.equal(flaky.calls.length, 2);
});
