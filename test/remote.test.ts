import "./helpers/no-agent.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Desk } from "../src/desk.ts";
import { Remote } from "../src/remote.ts";
import { createApp, remoteFetch, startServer } from "../src/server.ts";
import { unusedPort } from "./helpers/fake-api.ts";
import { Effect } from "effect";
import type { Item } from "../src/types.ts";
import type { GitHubWriter } from "../src/github/write.ts";
import { myPr, reviewAsk } from "./helpers/desk.ts";
import { FakeGitHub, makeItem, NOW } from "./helpers/items.ts";
import { unixOnly } from "./helpers/platform.ts";
import { codeOf } from "../src/narrow.ts";
import { run } from "./helpers/run.ts";
import { refuseWrites } from "./helpers/writer.ts";
import { until } from "./helpers/wait.ts";

delete process.env.DESK_UI_ORIGIN;
delete process.env.DESK_DEV;

const NAME = "desk.tail1.ts.net";
const OWNER = "owner@example.com";
const AT = `https://${NAME}`;

// `items` are on the desk (every search returns them); `writer` is its GitHub writer.
async function setup(items?: Item[], writer?: GitHubWriter) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-remote-"));
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ "policy.judge": false }));
  const desk = new Desk({
    home,
    github: new FakeGitHub(items ?? [makeItem({ number: 7 })], () => (items ?? []).map((i) => i.id)),
    now: () => NOW,
    notify: () => {},
    log: () => {},
    ...(writer ? { writer } : {}),
  });
  await run(desk.init());
  await run(desk.sync());
  let now = Date.now();
  const remote = new Remote(desk.store, () => now);
  remote.tailnet = { name: NAME, login: OWNER };
  const app = createApp(desk, 47823, remote);
  const far = remoteFetch(app);
  // What `tailscale serve` hands the desk: the client's Host, and the login of whoever's device sent it.
  const viaTailnet = (p: string, init: RequestInit & { login?: string | null } = {}) => {
    const { login = OWNER, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (login) headers.set("tailscale-user-login", login);
    return Promise.resolve(far(new Request(`http://${NAME}${p}`, { ...rest, headers })));
  };
  const local = (p: string, init: RequestInit = {}) => app.request(`http://127.0.0.1:47823${p}`, init);
  const json = { "content-type": "application/json" };
  const mint = async (): Promise<string> => ((await (await local("/api/pair/code", { method: "POST" })).json()) as { code: string }).code;
  const trade = (code: string, kind = "device", headers: Record<string, string> = {}) =>
    viaTailnet("/api/pair", { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify({ code, kind, name: "laptop" }) });
  const token = async (kind = "device") => ((await (await trade(await mint(), kind)).json()) as { token: string }).token;
  return {
    desk,
    app,
    remote,
    viaTailnet,
    local,
    mint,
    trade,
    token,
    json,
    later: (ms: number) => {
      now += ms;
    },
    cleanup: () => {
      desk.stop();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

test("from another device: no token is 401, a token without the owner's Tailscale login 403, both 200", async (c) => {
  const t = await setup();
  c.after(t.cleanup);
  assert.equal((await t.viaTailnet("/api/queue")).status, 401);
  const tok = await t.token();
  assert.equal((await t.viaTailnet("/api/queue", { headers: bearer(tok), login: null })).status, 403, "no identity header");
  assert.equal((await t.viaTailnet("/api/queue", { headers: bearer(tok), login: "someone@else.com" })).status, 403, "another user");
  assert.equal((await t.viaTailnet("/api/queue", { headers: bearer("inbox_wrong") })).status, 401);
  assert.equal((await t.viaTailnet("/api/queue", { headers: bearer(tok) })).status, 200);
  // Serve passes on the client's Host: a peer saying localhost is still remote, and refused.
  const far = remoteFetch(t.app);
  const spoofed = await far(
    new Request("http://localhost:47823/api/queue", { headers: { "tailscale-user-login": OWNER, ...bearer(tok) } }),
  );
  assert.equal(spoofed.status, 403);
  // While the desk isn't served, its remote listener refuses everything.
  t.remote.tailnet = null;
  assert.equal((await t.viaTailnet("/api/queue", { headers: bearer(tok) })).status, 403);
});

test("on this machine, a Tailscale identity header changes nothing and no token is asked", async (c) => {
  const t = await setup();
  c.after(t.cleanup);
  assert.equal((await t.local("/api/queue", { headers: { "tailscale-user-login": "someone@else.com" } })).status, 200);
  assert.equal((await t.local("/api/queue")).status, 200);
});

test("a pairing code works once, is burned by a wrong try, expires after 10 minutes, and only this machine mints one", async (c) => {
  const t = await setup();
  c.after(t.cleanup);
  const code = await t.mint();
  assert.match(code, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  const first = await t.trade(code.toLowerCase());
  assert.equal(first.status, 200);
  assert.match(((await first.json()) as { token: string }).token, /^inbox_/);
  assert.equal((await t.trade(code)).status, 403, "used once");
  const burned = await t.mint();
  assert.equal((await t.trade("AAAA-AAAA")).status, 403);
  assert.equal((await t.trade(burned)).status, 403, "a wrong try burns it");
  const old = await t.mint();
  t.later(10 * 60_000 + 1);
  assert.equal((await t.trade(old)).status, 403, "expired");
  const tok = await t.token();
  assert.equal((await t.viaTailnet("/api/pair/code", { method: "POST", headers: bearer(tok) })).status, 403, "a paired device can't mint");
  assert.equal(
    (await t.local("/api/pair", { method: "POST", headers: t.json, body: JSON.stringify({ code: await t.mint() }) })).status,
    403,
  );
  // Trading still needs the owner's login.
  assert.equal((await t.viaTailnet("/api/pair", { method: "POST", login: "someone@else.com", body: "{}" })).status, 403);
});

test("the pairing trade takes five tries a minute, from anyone", async (c) => {
  const t = await setup();
  c.after(t.cleanup);
  for (let i = 0; i < 5; i++) assert.equal((await t.trade("AAAA-AAAA")).status, 403);
  const code = await t.mint();
  const sixth = await t.trade(code);
  assert.deepEqual([sixth.status, ((await sixth.json()) as { tag: string }).tag], [429, "TooManyRequests"]);
  t.later(60_001);
  assert.equal((await t.trade(await t.mint())).status, 200);
});

test("a revoked device's token stops working at once, and only the desk's window revokes", async (c) => {
  const t = await setup();
  c.after(t.cleanup);
  const tok = await t.token();
  assert.equal((await t.viaTailnet("/api/queue", { headers: bearer(tok) })).status, 200);
  const view = (await (await t.local("/api/remote")).json()) as { devices: { id: string; name: string; kind: string }[] };
  assert.deepEqual(
    view.devices.map((d) => [d.name, d.kind]),
    [["laptop", "device"]],
  );
  const id = view.devices[0]!.id;
  assert.equal((await t.local(`/api/devices/${id}`, { method: "DELETE" })).status, 403, "curl or an agent");
  const desk = { "sec-fetch-site": "same-origin", origin: "http://localhost:47823" };
  assert.equal((await t.local(`/api/devices/${id}`, { method: "DELETE", headers: desk })).status, 200);
  assert.equal((await t.viaTailnet("/api/queue", { headers: bearer(tok) })).status, 401);
  assert.ok(!JSON.stringify(t.desk.store.devices()).includes(tok), "never the token itself");
});

test("a paired browser has an HttpOnly Secure SameSite=Strict session, and its writes need it and the tailnet origin", async (c) => {
  const t = await setup();
  c.after(t.cleanup);
  const page = await t.viaTailnet("/pair");
  assert.equal(page.status, 200, "the pair page needs no token");
  const res = await t.trade(await t.mint(), "browser", { origin: AT, "sec-fetch-site": "same-origin" });
  assert.equal(res.status, 200);
  const set = res.headers.get("set-cookie") ?? "";
  assert.match(set, /^__Host-inbox=inbox_[\w-]+; Max-Age=\d+; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
  assert.equal(((await res.json()) as { token?: string }).token, undefined, "the token stays in the cookie");
  const cookie = set.split(";")[0]!;
  const tok = await t.token();
  const write = (headers: Record<string, string>) =>
    t.viaTailnet("/api/inquiries/nope/answer", { method: "POST", headers: { ...t.json, ...headers }, body: JSON.stringify({ text: "x" }) });
  const page2 = { "sec-fetch-site": "same-origin", origin: AT };
  assert.equal((await write({ ...page2, cookie })).status, 404, "the desk's own page: past the check, to a question that isn't there");
  assert.equal((await write({ ...page2, ...bearer(tok) })).status, 403, "a device's token, even forging the page's headers");
  assert.equal((await write({ "sec-fetch-site": "same-origin", origin: "http://localhost:47823", cookie })).status, 403, "another origin");
  assert.equal((await write({ cookie })).status, 403, "not the page");
  assert.equal(
    (await t.viaTailnet("/api/queue", { headers: { cookie: `__Host-inbox=${tok}` } })).status,
    401,
    "a device token isn't a session",
  );
});

test("a paired phone is you: its token alone approves, answers, hands off and triages as the window does; a machine's is still refused", async (c) => {
  const approved: string[][] = [];
  const writer: GitHubWriter = {
    ...refuseWrites(),
    approve: (pr, commit) =>
      Effect.sync(() => {
        approved.push([pr, commit]);
        return { url: "" };
      }),
  };
  const t = await setup([reviewAsk(1), myPr(3, { ci: "pending" })], writer);
  c.after(t.cleanup);
  const phone = await t.token("phone");
  const machine = await t.token();
  // No Origin, no Sec-Fetch-Site: a native app sends neither.
  const post = (tok: string, p: string, body: unknown) =>
    t.viaTailnet(p, { method: "POST", headers: { ...t.json, ...bearer(tok) }, body: JSON.stringify(body) });
  const approve = (tok: string) => post(tok, "/api/review/acme%2Fapi%231/approve", { head_oid: "abc" });
  assert.equal((await approve(machine)).status, 403);
  assert.deepEqual(approved, []);
  assert.equal((await approve(phone)).status, 200);
  assert.deepEqual(approved, [["PR_acme/api_1", "abc"]]);
  const logged = t.desk.store.db.prepare("SELECT action, agent FROM events WHERE item_id = 'acme/api#1' AND undone = 1").all();
  assert.deepEqual(
    logged.map((r) => [r.action, r.agent]),
    [["approve", null]],
    "the write is logged",
  );
  const answer = (tok: string) => post(tok, "/api/inquiries/nope/answer", { text: "x" });
  assert.equal((await answer(machine)).status, 403);
  assert.equal((await answer(phone)).status, 404, "past the check, to a question that isn't there");
  const act = (tok: string, action: string) => post(tok, "/api/act", { id: "acme/web#3", action });
  assert.equal((await act(machine, "inflight")).status, 403);
  assert.equal((await act(phone, "inflight")).status, 200);
  const back = (await (await act(phone, "takeback")).json()) as { undo_seq: number };
  assert.equal((await post(machine, "/api/undo", { seq: back.undo_seq })).status, 409, "an agent can't put it back in Merging");
  assert.equal((await post(phone, "/api/undo", { seq: back.undo_seq })).status, 200);
  assert.equal((await act(machine, "undo")).status, 409, "nor undo your hand-off");
  assert.equal((await act(phone, "undo")).status, 200);
  assert.equal((await act(machine, "done")).status, 200, "a machine still triages");
});

test("a phone's token is a phone's only over the tailnet, as a bearer, for the owner, until it's revoked", async (c) => {
  const t = await setup();
  c.after(t.cleanup);
  const res = await t.trade(await t.mint(), "phone");
  assert.equal(res.headers.get("set-cookie"), null);
  const { token: phone, device } = (await res.json()) as { token: string; device: { id: string; kind: string } };
  assert.match(phone, /^inbox_/);
  assert.equal(device.kind, "phone");
  const answer = (headers: Record<string, string>, login = OWNER) =>
    t.viaTailnet("/api/inquiries/nope/answer", {
      method: "POST",
      headers: { ...t.json, ...headers },
      body: JSON.stringify({ text: "x" }),
      login,
    });
  assert.equal((await answer(bearer(phone))).status, 404, "past the check");
  assert.equal((await answer(bearer(phone), "someone@else.com")).status, 403, "another Tailscale user");
  const here = await t.local("/api/inquiries/nope/answer", { method: "POST", headers: { ...t.json, ...bearer(phone) }, body: "{}" });
  assert.equal(here.status, 403, "on the desk's machine it's nothing");
  assert.equal((await t.viaTailnet("/api/queue", { headers: { cookie: `__Host-inbox=${phone}` } })).status, 401, "not a session");
  assert.equal((await t.viaTailnet("/api/pair/code", { method: "POST", headers: bearer(phone) })).status, 403, "a phone can't mint");
  const view = (await (await t.local("/api/remote")).json()) as { devices: { name: string; kind: string }[] };
  assert.deepEqual(
    view.devices.map((d) => [d.name, d.kind]),
    [["laptop", "phone"]],
  );
  assert.equal(t.remote.issue(undefined, "phone").device.name, "A phone");
  // A phone revokes a device as the window does: here, itself.
  assert.equal((await t.viaTailnet(`/api/devices/${device.id}`, { method: "DELETE", headers: bearer(phone) })).status, 200);
  assert.equal((await answer(bearer(phone))).status, 401);
});

test("every route kept for the window takes a phone's token and refuses a machine's; a phone's from another origin is refused, and one that isn't spelled phone is a machine's", async (c) => {
  const t = await setup([myPr(3, { ci: "pending" })]);
  c.after(t.cleanup);
  const phone = await t.token("phone");
  const machine = await t.token();
  const send = (tok: string, method: string, p: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    t.viaTailnet(p, { method, headers: { ...t.json, ...bearer(tok), ...headers }, body: JSON.stringify(body) });
  // Each past the check for the phone, to whatever the route says of a body or an id that isn't there.
  const routes: [string, string, unknown, number][] = [
    ["POST", "/api/github", { id: "acme/web#3", action: "nope" }, 400],
    ["POST", "/api/review/acme%2Fweb%233/comment", { body: "" }, 400],
    ["POST", "/api/review/acme%2Fweb%233/reply", {}, 400],
    ["POST", "/api/ask", {}, 400],
    ["POST", "/api/sessions/nope/kick", {}, 404],
    ["PUT", "/api/automations/nope/on", {}, 400],
    ["DELETE", "/api/automations/nope", {}, 404],
    ["PUT", "/api/criteria/nope/on", {}, 400],
    ["PUT", "/api/settings", { reset: ["agent.decision_key"] }, 200],
  ];
  for (const [method, p, body, past] of routes) {
    assert.equal((await send(machine, method, p, body)).status, 403, `a machine's token: ${method} ${p}`);
    assert.equal((await send(phone, method, p, body)).status, past, `a phone's token: ${method} ${p}`);
  }
  // Open starts an app on the desk's computer: a window's only.
  assert.equal((await send(phone, "POST", "/api/sessions/nope/open")).status, 403);
  const devices = (await (await t.local("/api/remote")).json()) as { devices: { id: string }[] };
  assert.equal((await send(machine, "DELETE", `/api/devices/${devices.devices[0]!.id}`)).status, 403, "a machine revokes nothing");
  // The token alone is enough only from no page at all: another site's page holding it is still refused.
  assert.equal((await send(phone, "POST", "/api/ask", {}, { origin: "https://evil.example" })).status, 403);
  assert.equal((await send(phone, "POST", "/api/ask", {}, { "sec-fetch-site": "cross-site" })).status, 403);
  for (const kind of ["Phone", ["phone"], "phone "]) {
    const res = await t.viaTailnet("/api/pair", { method: "POST", headers: t.json, body: JSON.stringify({ code: await t.mint(), kind }) });
    const paired = (await res.json()) as { token: string; device: { kind: string } };
    assert.equal(paired.device.kind, "device", JSON.stringify(kind));
    assert.equal((await send(paired.token, "POST", "/api/ask")).status, 403);
  }
});

test("MCP called with a phone's token is still an agent: its tools reach no route kept for the window", async (c) => {
  const t = await setup([myPr(3, { ci: "pending" })]);
  c.after(t.cleanup);
  const phone = await t.token("phone");
  const post = (p: string, body: unknown) =>
    t.viaTailnet(p, { method: "POST", headers: { ...t.json, ...bearer(phone) }, body: JSON.stringify(body) });
  assert.equal((await post("/api/act", { id: "acme/web#3", action: "inflight" })).status, 200);
  const back = (await (await post("/api/act", { id: "acme/web#3", action: "takeback" })).json()) as { undo_seq: number };
  const far = remoteFetch(t.app);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${AT}/mcp`), {
      fetch: (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set("tailscale-user-login", OWNER);
        return Promise.resolve(far(new Request(url, { ...init, headers })));
      },
      requestInit: { headers: bearer(phone) },
    }),
  );
  const undone = await client.callTool({ name: "inbox_undo", arguments: { seq: back.undo_seq } });
  assert.ok(undone.isError, JSON.stringify(undone.content));
  await client.close();
  assert.equal((await post("/api/undo", { seq: back.undo_seq })).status, 200, "the phone itself may");
});

test("MCP over /mcp from another device: with a token it lists the tools; without one it's 401", async (c) => {
  const t = await setup();
  c.after(t.cleanup);
  const tok = await t.token();
  const far = remoteFetch(t.app);
  const send = (login: string | null) => (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (login) headers.set("tailscale-user-login", login);
    return Promise.resolve(far(new Request(url, { ...init, headers })));
  };
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${AT}/mcp`), { fetch: send(OWNER), requestInit: { headers: bearer(tok) } }),
  );
  const tools = (await client.listTools()).tools.map((x) => x.name);
  assert.ok(tools.includes("inbox_list") && tools.includes("inbox_item"), tools.join(", "));
  const r = await client.callTool({ name: "inbox_list", arguments: {} });
  assert.ok(!r.isError, JSON.stringify(r.content));
  await client.close();
  const res = await far(new Request(`${AT}/mcp`, { method: "POST", headers: { "tailscale-user-login": OWNER }, body: "{}" }));
  assert.equal(res.status, 401);
});

test("the skill a paired machine fetches names the desk at its tailnet address", async (c) => {
  const t = await setup();
  c.after(t.cleanup);
  assert.equal((await t.viaTailnet("/skill")).status, 401);
  const text = await (await t.viaTailnet("/skill", { headers: bearer(await t.token()) })).text();
  assert.ok(text.includes(`${AT}/#/review/`) && !text.includes("localhost:47823"), text.slice(0, 400));
  assert.ok((await (await t.local("/skill")).text()).includes("http://localhost:47823"), "this machine's is as shipped");
});

// A tailscale that answers status and serve as 1.102 does, keeping what's served in a file beside it.
function fakeTailscale(status: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-ts-"));
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status));
  const bin = path.join(dir, "tailscale");
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const a = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "calls"), JSON.stringify(a) + "\\n");
const serve = path.join(__dirname, "serve.json");
if (a.join(" ") === "status --json") process.stdout.write(fs.readFileSync(path.join(__dirname, "status.json")));
else if (a.join(" ") === "serve status --json") process.stdout.write(fs.existsSync(serve) ? fs.readFileSync(serve) : "{}");
else if (a[0] === "serve" && a[1] === "--bg" && a[2] === "--https=443") {
  const name = JSON.parse(fs.readFileSync(path.join(__dirname, "status.json"))).Self.DNSName.replace(/\\.$/, "");
  // Whole or not at all, as tailscale's own state is: the test reads it while this runs.
  fs.writeFileSync(serve + ".tmp", JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { [name + ":443"]: { Handlers: { "/": { Proxy: a[3] } } } } }));
  fs.renameSync(serve + ".tmp", serve);
} else if (a.join(" ") === "serve --https=443 off") fs.rmSync(serve, { force: true });
else { process.stderr.write("unexpected: " + a.join(" ")); process.exit(1); }
`,
    { mode: 0o755 },
  );
  const calls = () =>
    fs.existsSync(path.join(dir, "calls"))
      ? fs
          .readFileSync(path.join(dir, "calls"), "utf8")
          .trim()
          .split("\n")
          .map((l) => (JSON.parse(l) as string[]).join(" "))
      : [];
  const served = (): string | null => {
    // One read, not exists-then-read: serve off may remove it in between.
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, "serve.json"), "utf8");
    } catch (e) {
      if (codeOf(e) === "ENOENT") return null;
      throw e;
    }
    const cfg = JSON.parse(text) as { Web: Record<string, { Handlers: Record<string, { Proxy: string }> }> };
    return Object.values(cfg.Web)[0]!.Handlers["/"]!.Proxy;
  };
  return { dir, calls, served };
}

const RUNNING = {
  BackendState: "Running",
  Self: { DNSName: `${NAME}.`, UserID: 42 },
  CertDomains: [NAME],
  User: { 42: { ID: 42, LoginName: OWNER } },
};

const get = (target: string, p: string, headers: Record<string, string>) =>
  new Promise<number>((resolve, reject) => {
    const u = new URL(target);
    http
      .get({ host: u.hostname, port: u.port, path: p, headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
      .on("error", reject);
  });

async function started(
  c: { after(fn: () => unknown): void },
  status: Record<string, unknown>,
  settings: Record<string, unknown>,
  installed = true,
  tailscale = false,
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-ts-home-"));
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ "policy.judge": false, ...settings }));
  const before = new Desk({ home, github: new FakeGitHub([], () => []), now: () => new Date(), notify: () => {}, log: () => {} });
  await run(before.init());
  before.stop();
  const ts = fakeTailscale(status);
  if (!installed) fs.rmSync(path.join(ts.dir, "tailscale"));
  const saved = { PATH: process.env.PATH, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  process.env.PATH = ts.dir; // no gh: syncs fail at once; only the fake tailscale is found
  delete process.env.GITHUB_TOKEN;
  const srv = await startServer({ port: await unusedPort(), home, log: () => {}, tailscale });
  c.after(async () => {
    await srv.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ts.dir, { recursive: true, force: true });
  });
  return { srv, ts };
}

test("Use it from your other devices runs tailscale serve to a listener of its own, and turns it off with the setting and the desk", async (c) => {
  if (unixOnly(c)) return;
  const { srv, ts } = await started(c, RUNNING, { "app.tailscale": true });
  await until(() => !!ts.served(), `tailscale serve ran: ${ts.calls().join("; ")}`);
  const target = ts.served()!;
  assert.match(target, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(new URL(target).port, new URL(srv.url).port, "not the desk's own port");
  assert.equal(await get(target, "/api/queue", { host: NAME, "tailscale-user-login": OWNER }), 401, "remote by its connection");
  assert.equal(await get(target, "/api/queue", { host: "localhost", "tailscale-user-login": OWNER }), 403);
  const view = (await (await fetch(`${srv.url}/api/remote`)).json()) as { on: boolean; url: string; login: string; text: string };
  assert.deepEqual([view.on, view.url, view.login], [true, AT, OWNER]);
  await run(srv.desk.putSettings({ set: { "app.tailscale": false } }));
  await until(() => !ts.served(), "turned off with the setting");
  await assert.rejects(get(target, "/api/queue", { host: NAME }), "its listener is closed");
  await run(srv.desk.putSettings({ set: { "app.tailscale": true } }));
  await until(() => !!ts.served(), "on again");
  await srv.close();
  assert.equal(ts.served(), null, "and off when the desk stops");
  assert.ok(
    ts.calls().every((l) => !l.includes("funnel")),
    ts.calls().join("; "),
  );
});

test("Settings says in plain words why it can't serve over Tailscale, and leaves another serve of yours alone", async (c) => {
  if (unixOnly(c)) return;
  const { srv, ts } = await started(c, { ...RUNNING, BackendState: "NeedsLogin" }, { "app.tailscale": true });
  const text = async () => ((await (await fetch(`${srv.url}/api/remote`)).json()) as { text: string }).text;
  const SIGNED_OUT = "Tailscale isn't running or signed in here: open Tailscale and sign in.";
  await until(async () => (await text()) === SIGNED_OUT, `Settings says: ${SIGNED_OUT}`);
  fs.writeFileSync(path.join(ts.dir, "status.json"), JSON.stringify(RUNNING));
  fs.writeFileSync(
    path.join(ts.dir, "serve.json"),
    JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { [`${NAME}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } }),
  );
  await run(srv.desk.putSettings({ set: { "app.tailscale": false } }));
  await run(srv.desk.putSettings({ set: { "app.tailscale": true } }));
  const THEIRS = `tailscale serve already serves https://${NAME}/: turn that off first (tailscale serve --https=443 off)`;
  await until(async () => (await text()) === THEIRS, `Settings says: ${THEIRS}`);
  assert.equal(ts.served(), "http://127.0.0.1:3000", "yours, untouched");
  await srv.close();
  assert.equal(ts.served(), "http://127.0.0.1:3000", "nor turns it off when it stops");
});

test("with no tailscale installed, Settings says so", async (c) => {
  const { srv } = await started(c, RUNNING, { "app.tailscale": true }, false);
  const text = async () => ((await (await fetch(`${srv.url}/api/remote`)).json()) as { text: string }).text;
  await until(async () => (await text()) !== "Off.", "Settings looked for tailscale");
  assert.equal(await text(), "Tailscale isn't installed here: there's no tailscale command.");
  await srv.close();
});

test("inbox serve --tailscale serves over Tailscale with the setting off, for that run", async (c) => {
  if (unixOnly(c)) return;
  const { srv, ts } = await started(c, RUNNING, {}, true, true);
  await until(() => !!ts.served(), `tailscale serve ran: ${ts.calls().join("; ")}`);
  assert.equal(srv.desk.settings["app.tailscale"], false);
  await srv.close();
  assert.equal(ts.served(), null);
});
