import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Desk } from "../src/desk.ts";
import { DEFAULT_POLICY, textHash } from "../src/judge.ts";
import { notifyCommand, openCommand } from "../src/notify.ts";
import { createApp } from "../src/server.ts";
import { FakeGitHub, hoursAgo, makeItem, NOW } from "./helpers/items.ts";

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
  await desk.init();
  await desk.sync();
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
      "desk_brief",
      "desk_config",
      "desk_events",
      "desk_hand_back",
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
    assert.equal(t.desk.status().text, "");
    assert.deepEqual(await call("desk_undo", { seq }), { text: "undid done on acme/api#7", isError: false });
    assert.equal(t.desk.status().text, "desk 1");

    const added = await call("desk_add", { ref: "api#7" });
    assert.match(added.text, /^added acme\/api#7 to the user's desk, pinned\. .*Undo with desk_undo seq=\d+\./);
    assert.equal(t.desk.item("api#7").state.pinned, true);

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
