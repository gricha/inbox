import { once } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { Effect } from "effect";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer as createViteServer } from "vite";
import { Desk } from "../src/desk.ts";
import { DeskError, GitHubGraphQLError, GitHubHttpError, NotFound, Upstream } from "../src/errors.ts";
import type { GitHubWriter } from "../src/github/write.ts";
import { DEFAULT_POLICY, textHash } from "../src/judge.ts";
import { notifyCommand, openCommand } from "../src/notify.ts";
import { createApp, proxyUpgrades, respond } from "../src/server.ts";
import { myPr, reviewAsk, setup as withItems } from "./helpers/desk.ts";
import { FakeGitHub, hoursAgo, makeItem, NOW } from "./helpers/items.ts";
import { run, runSync } from "./helpers/run.ts";
import { refuseWrites } from "./helpers/writer.ts";

// An agent the desk started inherits these; the tests that want them set their own.
delete process.env.DESK_UI_ORIGIN;
delete process.env.DESK_DEV;

async function setup(settings?: Record<string, unknown>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-srv-"));
  // No judge unless a test asks: it must not start a claude here (test/judge.test.ts runs it against a fake).
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ "policy.judge": false, ...settings }));
  const items = [
    makeItem({
      number: 7,
      review_requests: [{ reviewer: "me", type: "user", codeowner: false }],
      request_events: [{ at: hoursAgo(1), actor: "alice", actor_bot: false, reviewer: "me", reviewer_type: "user" }],
    }),
  ];
  const desk = new Desk({
    home,
    github: new FakeGitHub(items, (q) => (q.includes("review-requested:@me") ? ["acme/api#7"] : [])),
    now: () => NOW,
    notify: () => {},
    log: () => {},
  });
  await run(desk.init());
  await run(desk.sync());
  const app = createApp(desk, 47823);
  const req = (p: string, init: RequestInit = {}) => app.request(`http://127.0.0.1:47823${p}`, init);
  const json = async (p: string, init: RequestInit = {}): Promise<any> => (await req(p, init)).json();
  return {
    desk,
    app,
    req,
    json,
    cleanup: () => {
      desk.stop();
      fs.rmSync(home, { recursive: true });
    },
  };
}

test("rejects foreign Host and Origin", async () => {
  const t = await setup();
  assert.equal((await t.app.request("http://evil.example/api/overview")).status, 403);
  assert.equal(
    (
      await t.req("/api/act", {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal((await t.req("/api/overview", { headers: { origin: "http://localhost:47823" } })).status, 200);
  assert.equal((await t.req("/mcp", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" })).status, 403);
  assert.equal((await t.app.request("http://evil.example/mcp", { method: "POST", body: "{}" })).status, 403);
  // What a browser sends for an <img> on another site: no Origin, so only Sec-Fetch-Site says it's foreign.
  const img = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" };
  assert.equal((await t.req("/api/review/api%237", { headers: img })).status, 403, "opening a review can start an AI run");
  assert.equal((await t.req("/api/queue", { headers: { "sec-fetch-site": "same-site" } })).status, 403, "another localhost port");
  assert.equal((await t.req("/mcp", { method: "POST", headers: img, body: "{}" })).status, 403);
  assert.equal((await t.req("/api/review/api%237", { headers: { "sec-fetch-site": "same-origin" } })).status, 200, "the desk's own page");
  assert.equal((await t.req("/api/queue", { headers: { "sec-fetch-site": "none" } })).status, 200, "typed into the address bar");
  assert.notEqual((await t.req("/", { headers: img })).status, 403, "the page itself isn't the API");
  t.cleanup();
});

test("MCP over Streamable HTTP at /mcp: the stdio tools, served in-process", async () => {
  const t = await setup();
  const srv = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: t.app.fetch, port: 0, hostname: "127.0.0.1" }, () => {
      resolve(s);
    });
  });
  const { port } = srv.address() as AddressInfo;
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: (r.content as { text: string }[]).map((c) => c.text).join("\n"), isError: !!r.isError };
  };
  try {
    assert.deepEqual((await client.listTools()).tools.map((x) => x.name).sort(), [
      "desk_act",
      "desk_add",
      "desk_answer",
      "desk_ask",
      "desk_automations",
      "desk_brief",
      "desk_config",
      "desk_events",
      "desk_hand_back",
      "desk_inquire",
      "desk_inquiry",
      "desk_item",
      "desk_list",
      "desk_merging",
      "desk_note",
      "desk_overview",
      "desk_policy",
      "desk_sync",
      "desk_undo",
    ]);
    assert.match((await call("desk_overview")).text, /focus: 1 now, 0 today/);
    const events = await call("desk_events", { after: 0, item: "api#7" });
    assert.match(events.text, /^1 event\(s\) after 0 on api#7 · last_seq 1/);
    assert.match(events.text, /#1 {2}\S+ {2}acme\/api#7 {2}new by alice {2}kind=pr/);

    const act = await call("desk_act", { ref: "api#7", action: "done" });
    const seq = Number(/Undo with desk_undo seq=(\d+)/.exec(act.text)?.[1]);
    assert.ok(seq > 0, act.text);
    assert.equal(runSync(t.desk.status()).text, "");
    assert.deepEqual(await call("desk_undo", { seq }), { text: "undid done on acme/api#7", isError: false });
    assert.equal(runSync(t.desk.status()).text, "desk 1");

    const added = await call("desk_add", { ref: "api#7", why: "needs your call on the retry budget", from: "seer retry fix" });
    assert.match(added.text, /^added acme\/api#7 to the user's desk, pinned\. .*Undo with desk_undo seq=\d+\./);
    assert.equal(runSync(t.desk.item("api#7")).state.pinned, true);
    assert.deepEqual(runSync(t.desk.item("api#7")).card.handoff, { why: "needs your call on the retry budget", from: "seer retry fix" });
    assert.equal((await call("desk_add", { ref: "api#7" })).isError, true, "a hand-off says why");

    const missing = await call("desk_item", { ref: "api#99" });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /no item "api#99"/);
    assert.equal((await t.req("/mcp")).status, 405);
  } finally {
    await client.close();
    srv.close();
    t.cleanup();
  }
});

test("API round trip: overview, board, item, act, undo, status", async () => {
  const t = await setup();
  const ov = await t.json("/api/overview");
  assert.equal(ov.focus.now, 1);
  const board = await t.json("/api/boards/acme-review");
  assert.equal(board.sections.now[0].id, "acme/api#7");
  const item = await t.json(`/api/item?id=${encodeURIComponent("api#7")}`);
  assert.equal(item.card.why, "alice asked you directly");
  assert.ok(Array.isArray(item.placements[0].trace));

  const act = await t.json("/api/act", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "api#7", action: "done" }),
  });
  assert.equal(act.ok, true);
  assert.ok(act.state.done_at);
  assert.equal((await t.json("/api/status")).text, "");
  const undo = await t.json("/api/undo", { method: "POST" });
  assert.deepEqual(undo, { ok: true, id: "acme/api#7", action: "done" });
  assert.equal((await t.json("/api/status")).text, "desk 1");
  t.cleanup();
});

test("activity: the log over HTTP, a long-poll that answers when an event lands, and bad params", async () => {
  const t = await setup();
  assert.deepEqual(
    (await t.json("/api/activity")).events.map((e: { seq: number; kind: string }) => [e.seq, e.kind]),
    [[1, "new"]],
  );
  assert.deepEqual(await t.json("/api/activity?after=1&item=api%237"), { events: [], last_seq: 1 });
  const waiting = t.json("/api/activity?after=1&wait=30");
  setTimeout(() => {
    t.desk.record("github", [{ at: NOW.toISOString(), item_id: "acme/api#7", kind: "pushed", actor: "alice", data: { oid: "b2" } }]);
  }, 20);
  const page = await waiting;
  assert.deepEqual([page.last_seq, page.events[0].kind, page.events[0].data], [2, "pushed", { oid: "b2" }]);
  assert.equal((await t.req("/api/activity?after=-1")).status, 400);
  assert.equal((await t.req("/api/activity?wait=soon")).status, 400);
  assert.equal((await t.req("/api/activity?item=api%2399")).status, 404);
  t.cleanup();
});

// This desk has no diff reader, agent or write client, so every review route answers without touching GitHub or an agent.
test("review routes take the PR's id encoded in one segment or with its slash", async () => {
  const t = await setup();
  const page = { "sec-fetch-site": "same-origin", origin: "http://localhost:47823" };
  const post = (p: string, body: unknown, headers: Record<string, string> = page) =>
    t.req(p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  for (const p of ["/api/review/acme%2Fapi%237", "/api/review/acme/api%237", "/api/review/api%237"]) {
    const v = await t.json(p);
    assert.equal(v.card.id, "acme/api#7", p);
    assert.equal(v.files_error, "diffs aren't available in this desk");
    assert.deepEqual(v.approve, { ok: false, reason: "approving isn't available in this desk" });
  }
  const ai = await post("/api/review/acme%2Fapi%237/ai", { force: true });
  assert.equal(ai.status, 502);
  assert.match(((await ai.json()) as { error: string }).error, /AI review isn't available/);
  assert.equal((await post("/api/review/acme/api%237/approve", { head_oid: "h7" })).status, 409);
  const curl = await t.req("/api/review/acme/api%237/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ head_oid: "h7" }),
  });
  assert.equal(curl.status, 403, "not from curl, the CLI or an agent: only the desk's page approves");
  assert.match(((await curl.json()) as { error: string }).error, /review in the desk/);
  // One forged header isn't enough: the desk's page sends both.
  for (const one of [{ "sec-fetch-site": "same-origin" }, { origin: "http://localhost:47823" }] as Record<string, string>[])
    assert.equal((await post("/api/review/acme/api%237/approve", { head_oid: "h7" }, one)).status, 403, JSON.stringify(one));
  assert.equal((await post("/api/review/acme%2Fapi%237/approve", {})).status, 400, "the commit you reviewed is required");
  assert.equal((await post("/api/review/acme%2Fapi%237/approve", { head_oid: "h7", body: 5 })).status, 400);
  assert.equal((await t.req("/api/review/acme%2Fapi%2399")).status, 404);
  t.cleanup();
});

test("DESK_DEV lets the Vite dev server's page in, on its usual ports or DESK_DEV_PORT", async (c) => {
  const prev = { dev: process.env.DESK_DEV, port: process.env.DESK_DEV_PORT };
  c.after(() => {
    for (const [k, v] of [
      ["DESK_DEV", prev.dev],
      ["DESK_DEV_PORT", prev.port],
    ] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
  const t = await setup();
  const from = async (app: ReturnType<typeof createApp>, origin: string) =>
    (await app.request("http://127.0.0.1:47823/api/queue", { headers: { origin } })).status;
  process.env.DESK_DEV = "1";
  process.env.DESK_DEV_PORT = "48531";
  const dev = createApp(t.desk, 47823);
  assert.deepEqual(
    [await from(dev, "http://localhost:5173"), await from(dev, "http://localhost:48531"), await from(dev, "http://localhost:48532")],
    [200, 200, 403],
  );
  delete process.env.DESK_DEV;
  assert.equal(await from(createApp(t.desk, 47823), "http://localhost:48531"), 403, "only in dev");
  t.cleanup();
});

test("DESK_UI_ORIGIN lets in exactly the desktop app's Vite page, approve included", async (c) => {
  const prev = process.env.DESK_UI_ORIGIN;
  c.after(() => {
    if (prev === undefined) delete process.env.DESK_UI_ORIGIN;
    else process.env.DESK_UI_ORIGIN = prev;
  });
  const t = await setup();
  process.env.DESK_UI_ORIGIN = "http://127.0.0.1:48555";
  const app = createApp(t.desk, 47823);
  const approve = async (origin: string) =>
    (
      await app.request("http://127.0.0.1:47823/api/review/acme/api%237/approve", {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", origin },
        body: JSON.stringify({ head_oid: "h7" }),
      })
    ).status;
  // 409: past the origin checks, refused only because this desk has no write client.
  assert.deepEqual(
    [await approve("http://127.0.0.1:48555"), await approve("http://localhost:48555"), await approve("http://localhost:5173")],
    [409, 403, 403],
  );
  t.cleanup();
});

// A stand-in for the app's Vite server: it answers with the path it was asked and the request's Accept, and echoes upgraded sockets.
async function fakeVite(c: { after(fn: () => unknown): void }) {
  const asked: { url: string; headers: http.IncomingHttpHeaders }[] = [];
  const up = http.createServer((req, res) => {
    asked.push({ url: req.url!, headers: req.headers });
    if (req.headers["if-none-match"] === '"v1"') res.writeHead(304).end();
    else res.writeHead(200, { "content-type": "text/javascript", etag: '"v1"' }).end(`served ${req.url} for ${req.headers.accept}`);
  });
  up.on("upgrade", (req: http.IncomingMessage, socket: net.Socket) => {
    asked.push({ url: req.url!, headers: req.headers });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.pipe(socket);
  });
  up.listen(0, "127.0.0.1");
  await once(up, "listening");
  c.after(() => {
    up.closeAllConnections();
    up.close();
  });
  return { up, asked, origin: `http://127.0.0.1:${(up.address() as AddressInfo).port}` };
}

const withUiOrigin = (c: { after(fn: () => unknown): void }, origin: string) => {
  const prev = process.env.DESK_UI_ORIGIN;
  c.after(() => {
    if (prev === undefined) delete process.env.DESK_UI_ORIGIN;
    else process.env.DESK_UI_ORIGIN = prev;
  });
  process.env.DESK_UI_ORIGIN = origin;
};

test("from a checkout the desk's own address serves the app's Vite UI, the API still its own", async (c) => {
  const vite = await fakeVite(c);
  withUiOrigin(c, vite.origin);
  const t = await setup();
  c.after(t.cleanup);
  const app = createApp(t.desk, 47823);
  const get = (p: string, headers: Record<string, string> = {}) => app.request(`http://localhost:47823${p}`, { headers });
  const mod = await get("/src/main.tsx?t=5", { accept: "*/*", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" });
  assert.equal(mod.status, 200);
  assert.equal(await mod.text(), "served /src/main.tsx?t=5 for */*");
  assert.equal(mod.headers.get("content-type"), "text/javascript");
  assert.equal(mod.headers.get("x-frame-options"), "DENY", "framed by no site, as the desk's pages");
  assert.equal((await get("/", { "if-none-match": '"v1"' })).status, 304, "Vite's cache answers pass through");
  const asked = vite.asked.length;
  assert.equal((await get("/api/queue")).status, 200);
  assert.equal(vite.asked.length, asked, "the API is the desk's own");
  const site = (s: string, mode: string) => get("/src/App.tsx", { "sec-fetch-site": s, "sec-fetch-mode": mode });
  assert.equal((await site("cross-site", "navigate")).status, 200, "a link from another site opens the desk");
  assert.equal((await site("cross-site", "no-cors")).status, 403, "another site can't load the checkout's files");
  assert.equal((await site("same-site", "cors")).status, 403, "nor another localhost port");
  vite.up.closeAllConnections();
  vite.up.close();
  await once(vite.up, "close");
  const down = await get("/");
  assert.equal(down.status, 503);
  assert.match(await down.text(), /http-equiv="refresh"/, "the page tries again while Vite starts");
});

test("from a checkout a path under /api or /health that the desk doesn't route is its own 404, not a loop through Vite", async (c) => {
  // Vite's proxy sends these prefixes back to the desk, as this stand-in does with everything (a few times at most).
  let asked = 0;
  let desk = "";
  const up = http.createServer((req, res) => {
    asked++;
    if (asked > 5) res.writeHead(508).end();
    else void fetch(`${desk}${req.url}`).then(async (r) => res.writeHead(r.status).end(await r.text()));
  });
  up.listen(0, "127.0.0.1");
  await once(up, "listening");
  c.after(() => {
    up.closeAllConnections();
    up.close();
  });
  withUiOrigin(c, `http://127.0.0.1:${(up.address() as AddressInfo).port}`);
  const t = await setup();
  c.after(t.cleanup);
  const srv = serve({ fetch: createApp(t.desk, 47823).fetch, port: 0, hostname: "127.0.0.1" });
  await once(srv, "listening");
  c.after(() => srv.close());
  desk = `http://localhost:${(srv.address() as AddressInfo).port}`;
  for (const p of ["/apix", "/api-docs", "/health/", "/healthz"]) assert.equal((await fetch(`${desk}${p}`)).status, 404, p);
  assert.equal(asked, 0, "none went to Vite");
});

// The app's own Vite server, from web/vite.config.ts, on a free port.
async function realVite(c: { after(fn: () => unknown): void }) {
  const prev = process.env.DESK_API;
  process.env.DESK_API = "http://127.0.0.1:1"; // its proxy must not reach a real desk
  const server = await createViteServer({
    configFile: path.join(import.meta.dirname, "../web/vite.config.ts"),
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "desk-vite-")),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  }).finally(() => {
    if (prev === undefined) delete process.env.DESK_API;
    else process.env.DESK_API = prev;
  });
  await server.listen();
  c.after(() => server.close());
  return `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
}

test("only Vite's own page can open a file in the owner's editor, on Vite's port or through the desk", async (c) => {
  const vite = await realVite(c);
  withUiOrigin(c, vite);
  const t = await setup();
  c.after(t.cleanup);
  const app = createApp(t.desk, 47823);
  // No such file, so a request that gets through opens nothing either.
  const open = `/__open-in-editor?file=${encodeURIComponent(path.join(os.tmpdir(), "desk-no-such-file"))}`;
  const iframe = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" };
  assert.equal((await fetch(`${vite}${open}`, { headers: iframe })).status, 403, "another site's hidden iframe on Vite's port");
  assert.equal((await app.request(`http://localhost:47823${open}`, { headers: iframe })).status, 403, "or on the desk's");
  assert.equal((await fetch(`${vite}${open}`, { headers: { "sec-fetch-site": "same-site" } })).status, 403, "another localhost port");
  const overlay = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" };
  assert.equal((await app.request(`http://localhost:47823${open}`, { headers: overlay })).status, 200, "Vite's error overlay still can");
});

test("from a checkout the page's hot-reload socket goes through to Vite, from the desk's own page only", async (c) => {
  const vite = await fakeVite(c);
  const srv = http.createServer();
  const drop = proxyUpgrades(srv, 47823, vite.origin);
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  c.after(() => {
    drop();
    srv.close();
  });
  const port = (srv.address() as AddressInfo).port;
  const open = async (host: string, origin: string, url = "/?token=abc", upgrade = "websocket") => {
    const s = net.connect(port, "127.0.0.1");
    s.write(`GET ${url} HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nUpgrade: ${upgrade}\r\nConnection: Upgrade\r\n\r\n`);
    const [head] = (await once(s, "data")) as [Buffer];
    return { s, head: String(head) };
  };
  const ok = await open("localhost:47823", "http://localhost:47823");
  assert.match(ok.head, /^HTTP\/1.1 101 /);
  assert.equal(vite.asked.at(-1)?.url, "/?token=abc");
  assert.equal(vite.asked.at(-1)?.headers.origin, "http://localhost:47823");
  ok.s.write("ping");
  assert.equal(String((await once(ok.s, "data"))[0]), "ping");
  assert.match((await open("localhost:47823", "https://evil.example")).head, /^HTTP\/1.1 403 /);
  assert.match((await open("evil.example", "http://localhost:47823")).head, /^HTTP\/1.1 403 /, "DNS rebinding");
  const asked = vite.asked.length;
  const own = (url: string, upgrade: string) => open("localhost:47823", "http://localhost:47823", url, upgrade);
  assert.match((await own("/api/queue", "h2c")).head, /^HTTP\/1.1 400 /, "curl --http2 fails fast, not hangs");
  assert.match((await own("/mcp", "websocket")).head, /^HTTP\/1.1 400 /, "the desk's own routes have no socket");
  assert.equal(vite.asked.length, asked, "neither went to Vite");
  // A server holding an upgraded socket never finishes closing, which would hold up node --watch's restart.
  const gone = once(ok.s, "close");
  drop();
  const closed = new Promise((r) => {
    srv.close(() => {
      r("closed");
    });
  });
  assert.equal(await Promise.race([closed, sleep(2000, "still open", { ref: false })]), "closed");
  await gone;
});

test("an app attached with /api/events?notify=1 gets the desk's notifications", async (c) => {
  const t = await setup();
  c.mock.timers.enable({ apis: ["setTimeout"] }); // the streams' 25 s keepalive must not hold the test open
  const own: string[] = [];
  t.desk.notifyFn = (_title, body) => {
    own.push(body);
  };
  const open = async (p: string) => (await t.req(p)).body!.pipeThrough(new TextDecoderStream()).getReader();
  const ui = await open("/api/events");
  t.desk.notify("Review Desk", "with only the UI's stream");
  const app = await open("/api/events?notify=1");
  let text = "";
  while (!text.includes("event: update")) text += (await app.read()).value ?? "";
  t.desk.notify("Review Desk", "acme/api#7 · asks you");
  while (!text.includes("event: notify")) text += (await app.read()).value ?? "";
  assert.match(text, /event: notify\ndata: {"title":"Review Desk","body":"acme\/api#7 · asks you"}\n/);
  assert.deepEqual(own, ["with only the UI's stream"], "the desk notifies itself only while no app listens");
  await Promise.all([ui.cancel(), app.cancel()]);
  t.cleanup();
});

test("errors: unknown board/item, bad action", async () => {
  const t = await setup();
  assert.equal((await t.req("/api/boards/nope")).status, 404);
  assert.equal((await t.req("/api/item?id=api%2399")).status, 404);
  const bad = await t.req("/api/act", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "api#7", action: "explode" }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await t.req("/api/nope")).status, 404);
  t.cleanup();
});

test("config preview and save", async () => {
  const t = await setup();
  const cfg = await t.json("/api/config");
  assert.ok(cfg.text.includes("[[boards]]"));
  assert.deepEqual(cfg.warnings, []);
  const prev = await t.json("/api/config/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "bogus = [" }),
  });
  assert.ok(prev.errors.length > 0);
  const legacy = await t.json("/api/config/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: `poll_seconds = 60\n${cfg.text}` }),
  });
  assert.deepEqual([legacy.errors, legacy.warnings.map((w: { path: string }) => w.path)], [[], ["poll_seconds"]]);
  assert.ok(legacy.boards.length > 0);
  const put = await t.json("/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: cfg.text }),
  });
  assert.equal(put.ok, true);
  const fields = await t.json("/api/fields");
  assert.ok(fields.some((f: { path: string }) => f.path === "me.requested_direct"));
  const put2 = (base: string) =>
    t.req("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: cfg.text, base }),
    });
  assert.equal((await put2(cfg.hash)).status, 200, "the hash from GET works as base");
  assert.equal((await put2("0123456789abcdef")).status, 409);
  t.cleanup();
});

test("policy: empty by default, so the starter is in effect; saved to policy.md with the hash as base, 409 when stale", async (c) => {
  // No judge: it must not start a real claude here (test/judge.test.ts runs it against a fake).
  const t = await setup({ "policy.judge": false });
  c.after(t.cleanup);
  const put = (body: unknown) =>
    t.req("/api/policy", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const p = await t.json("/api/policy");
  assert.deepEqual([p.text, p.starter, p.hash], ["", DEFAULT_POLICY, textHash(DEFAULT_POLICY)]);
  assert.equal(p.path, path.join(t.desk.home, "policy.md"));
  assert.deepEqual([p.judge.state, p.judge.off_reason], ["off", "it's turned off"]);
  const saved = (await (await put({ text: "Bot PRs are FYI.\n", base: p.hash })).json()) as { ok: boolean; hash: string };
  assert.equal(saved.ok, true);
  assert.equal(fs.readFileSync(path.join(t.desk.home, "policy.md"), "utf8"), "Bot PRs are FYI.\n");
  const again = await t.json("/api/policy");
  assert.deepEqual([again.text, again.hash], ["Bot PRs are FYI.\n", saved.hash]);
  assert.equal(again.judge.off_reason, "it's turned off");
  assert.equal((await put({ text: "x", base: p.hash })).status, 409, "the old hash is stale now");
  assert.equal((await put({ base: saved.hash })).status, 400);
  assert.equal((await put({ text: "x".repeat(20_001), base: saved.hash })).status, 400);
});

test("opening a URL and notifying per platform, all as argv", () => {
  const url = "http://localhost:47823";
  assert.deepEqual(openCommand(url, "darwin"), ["open", [url]]);
  assert.deepEqual(openCommand(url, "linux"), ["xdg-open", [url]]);
  assert.deepEqual(openCommand(url, "win32"), ["rundll32", ["url.dll,FileProtocolHandler", url]]);
  assert.deepEqual(notifyCommand("Review Desk", '-u critical; "x"', "linux"), [
    "notify-send",
    ["--app-name=Review Desk", "--", "Review Desk", '-u critical; "x"'],
  ]);
  assert.deepEqual(notifyCommand("Review Desk", "body", "darwin")?.[1].slice(-2), ["body", "Review Desk"]);
  assert.equal(notifyCommand("Review Desk", "body", "win32"), null);
});

// A scratch HOME (USERPROFILE on Windows) and an empty PATH: the real ~/.claude, ~/.claude.json and ~/.codex are never touched.
test("agents: Claude Code's status, and connect", async () => {
  const t = await setup();
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-home-"));
  Object.assign(process.env, { HOME: home, USERPROFILE: home, PATH: path.join(home, "empty") });
  try {
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { "review-desk": { type: "http" } } }));
    const before = await t.json("/api/agents");
    assert.equal(before.driver, "claude-code");
    assert.deepEqual(before.mcp, {
      connected: true,
      command: "claude mcp add --transport http --scope user review-desk http://localhost:47823/mcp",
    });
    assert.equal(before.skill.state, "missing");
    const after = await t.json("/api/agents/connect", { method: "POST" });
    assert.equal(after.skill.state, "installed");
    assert.ok(fs.existsSync(path.join(home, ".claude", "skills", "review-desk", "SKILL.md")));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    t.cleanup();
  }
});

test("a route's Effect answers a refusal with its status and tag, a client that left with 499, and anything else with a logged 500 Sentry sees", async () => {
  const logs: string[] = [];
  const log = (m: string) => {
    logs.push(m);
  };
  const seen = new Map<string, unknown>();
  const app = new Hono();
  app.use("*", async (c, next) => {
    await next();
    seen.set(c.req.path, c.error);
  });
  const upstream = new Upstream({ message: "GitHub HTTP 500: oops" });
  app.get("/value", (c) => respond(c, Effect.succeed({ ok: true }), { log }));
  app.get("/refused", (c) => respond(c, Effect.fail(new NotFound({ message: 'no automation "nope"' })), { log }));
  app.get("/legacy", (c) => respond(c, Effect.fail(new DeskError(409, "already answered")), { log }));
  app.get("/upstream", (c) => respond(c, Effect.fail(upstream), { log }));
  app.get("/bug", (c) => respond(c, Effect.die(new TypeError("x is undefined")), { log }));
  app.get("/wait", (c) => respond(c, Effect.never, { log, read: true }));
  const get = async (p: string) => {
    const res = await app.request(`http://127.0.0.1${p}`);
    return [res.status, await res.json()];
  };
  assert.deepEqual(await get("/value"), [200, { ok: true }]);
  assert.deepEqual(await get("/refused"), [404, { error: 'no automation "nope"', tag: "NotFound" }]);
  assert.deepEqual(await get("/legacy"), [409, { error: "already answered", tag: "Conflict" }]);
  assert.deepEqual(await get("/upstream"), [502, { error: "GitHub HTTP 500: oops", tag: "Upstream" }]);
  assert.deepEqual(await get("/bug"), [500, { error: "x is undefined", tag: "Internal" }]);
  assert.deepEqual(
    [seen.get("/refused"), seen.get("/legacy"), seen.get("/upstream")],
    [undefined, undefined, upstream],
    "the failure itself, for Sentry",
  );
  assert.ok(seen.get("/bug") instanceof TypeError);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /^error: .*x is undefined/s);
  // The request kept here: a Request built from init follows its signal only while something holds it.
  const gone = new AbortController();
  const req = new Request("http://127.0.0.1/wait", { signal: gone.signal });
  const waiting = app.request(req);
  await sleep(20);
  gone.abort();
  assert.equal((await waiting).status, 499, "nothing to answer, and nothing logged");
  assert.equal(logs.length, 1);
});

test("the desk's refusals answer through respond with their tag, words and status, and a body that isn't JSON is a 400", async (c) => {
  const t = await withItems([reviewAsk(1), myPr(1, { ci: "green" }), myPr(3, { ci: "green" })], { settings: { "policy.judge": false } });
  c.after(t.cleanup);
  await run(t.desk.sync());
  const app = createApp(t.desk, 47823);
  const DESK = { "sec-fetch-site": "same-origin", origin: "http://localhost:47823" };
  const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`http://127.0.0.1:47823${p}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    return [res.status, await res.json()];
  };
  const no = (tag: string, error: string) => ({ error, tag });
  assert.deepEqual(await call("GET", "/api/item"), [400, no("BadRequest", "missing ?id=")]);
  assert.deepEqual(await call("GET", "/api/item?id=nope%2399"), [404, no("NotFound", 'no item "nope#99" on the desk')]);
  assert.deepEqual(await call("GET", "/api/item?id=what"), [
    404,
    no("NotFound", `can't read "what"; use owner/repo#123, repo#123 or a GitHub URL`),
  ]);
  const [status, ambiguous] = (await call("GET", "/api/item?id=%231")) as [number, { candidates: string[] }];
  assert.deepEqual(
    [status, { ...ambiguous, candidates: ambiguous.candidates.toSorted() }],
    [409, { error: '"#1" matches 2 items', tag: "AmbiguousRef", candidates: ["acme/api#1", "acme/web#1"] }],
  );
  assert.deepEqual(await call("GET", "/api/boards/nope"), [404, no("NotFound", 'no board "nope"')]);
  assert.deepEqual(await call("POST", "/api/act", "nope"), [400, no("BadRequest", "the body must be a JSON object")], "it was a 500");
  assert.deepEqual(await call("POST", "/api/act", {}), [400, no("BadRequest", "need { id, action }")]);
  assert.deepEqual(await call("POST", "/api/act", { id: "web#3", action: "inflight" }), [
    403,
    no("Forbidden", "hand a PR off for merge from the desk's window"),
  ]);
  assert.deepEqual(await call("POST", "/api/act", { id: "api#1", action: "snooze", until: "someday" }), [
    400,
    no("BadRequest", `can't read snooze time "someday"; use 1h, 3h, 2d, tomorrow, monday, activity or a future ISO time`),
  ]);
  assert.deepEqual(await call("POST", "/api/act", { id: "web#3", action: "takeback" }), [
    409,
    no("Conflict", "acme/web#3 isn't in Merging"),
  ]);
  assert.deepEqual(await call("POST", "/api/act", { id: "api#1", action: "nope" }), [400, no("BadRequest", 'unknown action "nope"')]);
  assert.deepEqual(await call("POST", "/api/undo", "null"), [404, no("NotFound", "nothing to undo")], "JSON null reads as {}");
  assert.deepEqual(await call("POST", "/api/inflight/web%233/note", { text: "rebasing" }), [
    409,
    no("Conflict", "acme/web#3 isn't one of your open PRs in Merging"),
  ]);
  assert.equal((await call("POST", "/api/act", { id: "web#3", action: "inflight" }, DESK))[0], 200);
  assert.deepEqual(await call("POST", "/api/inflight/web%233/note", { text: " ‮ " }), [400, no("BadRequest", "the note is empty")]);
  assert.deepEqual(await call("POST", "/api/inflight/web%233/handback", {}), [400, no("BadRequest", "need { why }")]);
  assert.deepEqual(await call("PUT", "/api/policy", { text: "x", base: "stale" }), [
    409,
    no("Stale", "policy.md changed since you opened it; reload to see it, then reapply your edit"),
  ]);
  assert.deepEqual(await call("PUT", "/api/config", { text: "x", base: "stale" }), [
    409,
    no("Stale", "config.toml changed on disk since you opened it; reload to see it, then reapply your edit"),
  ]);
  assert.deepEqual(await call("PUT", "/api/policy", "null"), [400, no("BadRequest", "the body must be a JSON object")]);
  assert.deepEqual(await call("PUT", "/api/settings", "[]"), [400, no("BadRequest", "the body must be a JSON object")]);
  assert.deepEqual(await call("POST", "/api/config/preview", "{"), [400, no("BadRequest", "the body must be a JSON object")]);
  assert.deepEqual(await call("POST", "/api/add", "[]"), [400, no("BadRequest", "need { id }: owner/repo#123 or a GitHub URL")]);
  assert.deepEqual(await call("POST", "/api/inquiries/nope/answer", { text: "yes" }), [
    403,
    no("Forbidden", "answer it in the desk's window"),
  ]);
  assert.deepEqual(await call("POST", "/api/inquiries/nope/answer", { text: "yes" }, DESK), [404, no("NotFound", 'no inquiry "nope"')]);
  assert.deepEqual(
    await call("POST", "/api/inquiries", {
      question: "Merge it?",
      from: "a session",
      context: "x ".repeat(120),
      links: [{ label: "the run", url: "http://ci.example/1" }],
    }),
    [400, no("BadRequest", "a link is https, not http:")],
  );
  assert.deepEqual(await call("POST", "/api/asks/nope/answer", { text: "done" }), [404, no("NotFound", 'no ask "nope"')]);
  // settings.json that can't be written: Node's words, a 500 as before
  fs.rmSync(path.join(t.home, "settings.json"));
  fs.mkdirSync(path.join(t.home, "settings.json"));
  const [failed, why] = (await call("PUT", "/api/settings", { set: { "notify.enabled": false } })) as [
    number,
    { error: string; tag: string },
  ];
  assert.deepEqual([failed, why.tag], [500, "Internal"]);
  assert.match(why.error, /settings\.json/);
});

test("the desk's GitHub writes answer through respond: GitHub's refusal is Upstream in its words, a moved head Stale, a second press Busy", async (c) => {
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const refused = "Resource not accessible by integration";
  const writer: GitHubWriter = {
    ...refuseWrites(refused),
    ready: () => Effect.void,
    approve: () => Effect.promise(() => held).pipe(Effect.as({ url: "https://github.com/acme/api/pull/1#pullrequestreview-1" })),
  };
  const ready = { ci: "green", review_decision: "approved", mergeable: "clean", merge_method: "SQUASH", head_oid: "h4" } as const;
  const t = await withItems([reviewAsk(1, { head_oid: "h1" }), myPr(3, { ci: "green", draft: true }), myPr(4, ready)], {
    settings: { "policy.judge": false },
    desk: { writer },
  });
  c.after(t.cleanup);
  await run(t.desk.sync());
  const app = createApp(t.desk, 47823);
  const DESK = { "sec-fetch-site": "same-origin", origin: "http://localhost:47823" };
  const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = DESK) => {
    const res = await app.request(`http://127.0.0.1:47823${p}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return [res.status, await res.json()];
  };
  const no = (tag: string, error: string) => ({ error, tag });
  const review = (ref: string, what: string) => `/api/review/${encodeURIComponent(ref)}/${what}`;
  assert.deepEqual(await call("POST", review("acme/api#1", "approve"), { head_oid: "h1" }, {}), [
    403,
    no("Forbidden", "approve from the PR's review in the desk"),
  ]);
  assert.deepEqual(await call("POST", review("acme/api#1", "approve"), { head_oid: "h0" }), [
    409,
    no("Stale", "can't approve acme/api#1: it has new commits since you opened it"),
  ]);
  assert.deepEqual(await call("POST", "/api/github", { id: "acme/web#4", action: "merge", head_oid: "h3" }), [
    409,
    no("Stale", "can't merge acme/web#4: it has new commits since you opened it"),
  ]);
  assert.deepEqual(await call("POST", "/api/github", { id: "acme/web#4", action: "reopen" }), [
    409,
    no("Conflict", "can't reopen acme/web#4 now"),
  ]);
  assert.deepEqual(await call("POST", "/api/github", { id: "acme/web#4", action: "close" }), [
    502,
    no("Upstream", `couldn't close acme/web#4 on GitHub: ${refused}`),
  ]);
  assert.deepEqual(await call("POST", review("acme/api#1", "comment"), { body: " " }), [400, no("BadRequest", "the comment is empty")]);
  assert.deepEqual(await call("POST", review("acme/api#1", "comment"), { body: "Thanks" }), [
    502,
    no("Upstream", `GitHub didn't take the comment: ${refused}`),
  ]);
  const line = { path: "src/a.ts", line: 3, side: "new", body: "nit", head_oid: "h1" };
  assert.deepEqual(await call("POST", review("acme/api#1", "inline"), line), [
    502,
    no("Upstream", `GitHub didn't take the comment: ${refused}`),
  ]);
  const context = t.gh.prContext.bind(t.gh);
  t.gh.prContext = () => Effect.fail(new GitHubHttpError({ status: 502, message: "GitHub HTTP 502: bad gateway" }));
  assert.deepEqual(await call("POST", review("acme/api#1", "reply"), { id: "PRRT_1", body: "Done" }), [
    502,
    no("Upstream", "couldn't read the PR's conversations: GitHub HTTP 502: bad gateway"),
  ]);
  t.gh.prContext = context;
  assert.deepEqual(await call("POST", review("acme/api#1", "reply"), { id: "PRRT_1", body: "Done" }), [
    404,
    no("NotFound", 'no conversation "PRRT_1" on acme/api#1'),
  ]);
  assert.deepEqual(await call("POST", review("acme/web#4", "reviewers"), { users: ["U_dana"] }), [
    502,
    no("Upstream", `GitHub didn't ask for the reviews: ${refused}`),
  ]);
  assert.deepEqual(await call("POST", review("acme/web#3", "ready"), { users: ["U_dana"] }), [
    502,
    no("ReviewersNotAsked", `Marked it ready, but GitHub didn't ask for the reviews: ${refused}`),
  ]);
  assert.deepEqual(
    t.desk.store.db
      .prepare("SELECT action FROM events WHERE item_id = 'acme/web#3' ORDER BY seq")
      .all()
      .map((r) => r.action),
    ["ready", "done"],
    "ready landed and is kept: nothing rolled back",
  );
  t.gh.reviewers = () => Effect.fail(new GitHubGraphQLError({ message: "GitHub: Could not resolve to a Repository" }));
  assert.deepEqual(
    await call("GET", `/api/reviewers/${encodeURIComponent("acme/web#4")}?q=da`),
    [502, no("Upstream", "GitHub: Could not resolve to a Repository")],
    "it was a 500",
  );
  assert.deepEqual(await call("GET", `/api/reviewers/${encodeURIComponent("acme/api#1")}`), [
    409,
    no("Conflict", "acme/api#1 isn't your PR"),
  ]);
  t.gh.lookup = () => Effect.fail(new GitHubHttpError({ status: 500, message: "GitHub HTTP 500: oops" }));
  assert.deepEqual(await call("POST", "/api/add", { id: "acme/other#9" }), [502, no("Upstream", "GitHub HTTP 500: oops")]);
  assert.deepEqual(await call("POST", "/api/add", { id: "acme/api#1", why: 5 }), [400, no("BadRequest", "why and from are lines of text")]);
  assert.deepEqual(await call("POST", "/api/add", { id: "what" }), [
    400,
    no("BadRequest", `can't read "what"; use owner/repo#123 or a GitHub URL`),
  ]);

  const first = call("POST", review("acme/api#1", "approve"), { head_oid: "h1" });
  await sleep(20);
  assert.deepEqual(await call("POST", review("acme/api#1", "approve"), { head_oid: "h1" }), [
    409,
    no("Busy", "already approving acme/api#1"),
  ]);
  release();
  assert.deepEqual(await first, [200, { ok: true, url: "https://github.com/acme/api/pull/1#pullrequestreview-1" }]);
});

test("a desk whose config never loaded answers 503: starting until the config's errors say why, and Focus says so too", async (c) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-srv-"));
  const cold = new Desk({ home, github: new FakeGitHub([], () => []), now: () => NOW, notify: () => {}, log: () => {} });
  c.after(() => {
    cold.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const app = createApp(cold, 47823);
  const get = async (p: string) => {
    const res = await app.request(`http://127.0.0.1:47823${p}`);
    return [res.status, await res.json()];
  };
  const starting = { error: "desk is starting; the first sync can take a minute", tag: "Unavailable", reason: "starting" };
  assert.deepEqual(await get("/api/queue"), [503, starting]);
  assert.deepEqual(await get("/api/status"), [503, starting]);
  fs.writeFileSync(path.join(home, "config.toml"), "[[boards]]\nid = 7\n");
  runSync(cold.reloadConfig());
  const broken = {
    error: `config has errors: ${cold.configErrors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
    tag: "Unavailable",
    reason: "config",
  };
  assert.ok(cold.configErrors.length);
  for (const p of ["/api/focus", "/api/queue", "/api/overview", "/api/status", "/api/inflight", "/api/item?id=web%233"])
    assert.deepEqual(await get(p), [503, broken], `${p}: focus was a TypeError 500`);
});
