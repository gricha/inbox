import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Desk } from "../src/desk.ts";
import { Remote } from "../src/remote.ts";
import { createApp, remoteFetch, startServer } from "../src/server.ts";
import { unusedPort } from "./helpers/fake-api.ts";
import { FakeGitHub, makeItem, NOW } from "./helpers/items.ts";
import { run } from "./helpers/run.ts";

delete process.env.DESK_UI_ORIGIN;
delete process.env.DESK_DEV;

const NAME = "desk.tail1.ts.net";
const OWNER = "owner@example.com";
const AT = `https://${NAME}`;

async function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-remote-"));
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ "policy.judge": false }));
  const desk = new Desk({
    home,
    github: new FakeGitHub([makeItem({ number: 7 })], () => []),
    now: () => NOW,
    notify: () => {},
    log: () => {},
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
  const token = async () => ((await (await trade(await mint())).json()) as { token: string }).token;
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
  assert.ok(tools.includes("desk_list") && tools.includes("desk_item"), tools.join(", "));
  const r = await client.callTool({ name: "desk_list", arguments: {} });
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
  fs.writeFileSync(serve, JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { [name + ":443"]: { Handlers: { "/": { Proxy: a[3] } } } } }));
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
    const f = path.join(dir, "serve.json");
    if (!fs.existsSync(f)) return null;
    const cfg = JSON.parse(fs.readFileSync(f, "utf8")) as { Web: Record<string, { Handlers: Record<string, { Proxy: string }> }> };
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

async function until(f: () => boolean, what: string) {
  for (let i = 0; i < 200 && !f(); i++) await sleep(20);
  assert.ok(f(), what);
}

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
  const { srv, ts } = await started(c, { ...RUNNING, BackendState: "NeedsLogin" }, { "app.tailscale": true });
  const text = async () => ((await (await fetch(`${srv.url}/api/remote`)).json()) as { text: string }).text;
  await until(() => ts.calls().length > 0, "asked tailscale");
  await sleep(50);
  assert.equal(await text(), "Tailscale isn't running or signed in here: open Tailscale and sign in.");
  fs.writeFileSync(path.join(ts.dir, "status.json"), JSON.stringify(RUNNING));
  fs.writeFileSync(
    path.join(ts.dir, "serve.json"),
    JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { [`${NAME}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } }),
  );
  await run(srv.desk.putSettings({ set: { "app.tailscale": false } }));
  await run(srv.desk.putSettings({ set: { "app.tailscale": true } }));
  await until(() => ts.calls().includes("serve status --json"), "looked at what's served");
  await sleep(50);
  assert.equal(await text(), `tailscale serve already serves https://${NAME}/: turn that off first (tailscale serve --https=443 off)`);
  assert.equal(ts.served(), "http://127.0.0.1:3000", "yours, untouched");
  await srv.close();
  assert.equal(ts.served(), "http://127.0.0.1:3000", "nor turns it off when it stops");
});

test("with no tailscale installed, Settings says so", async (c) => {
  const { srv } = await started(c, RUNNING, { "app.tailscale": true }, false);
  const text = async () => ((await (await fetch(`${srv.url}/api/remote`)).json()) as { text: string }).text;
  for (let i = 0; i < 100 && (await text()) === "Off."; i++) await sleep(20);
  assert.equal(await text(), "Tailscale isn't installed here: there's no tailscale command.");
  await srv.close();
});

test("desk serve --tailscale serves over Tailscale with the setting off, for that run", async (c) => {
  const { srv, ts } = await started(c, RUNNING, {}, true, true);
  await until(() => !!ts.served(), `tailscale serve ran: ${ts.calls().join("; ")}`);
  assert.equal(srv.desk.settings["app.tailscale"], false);
  await srv.close();
  assert.equal(ts.served(), null);
});
