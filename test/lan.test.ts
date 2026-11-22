import "./helpers/no-agent.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Desk } from "../src/desk.ts";
import { createApp, lanFetch } from "../src/server.ts";
import { FakeGitHub, makeItem, NOW } from "./helpers/items.ts";
import { run } from "./helpers/run.ts";

delete process.env.DESK_UI_ORIGIN;
delete process.env.DESK_DEV;

const TOKEN = "lan-token-for-tests";
const AT = "http://192.168.1.20:47824";

async function setup(on = true, token = TOKEN) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-lan-"));
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ "policy.judge": false, "lan.on": on }));
  fs.writeFileSync(path.join(home, "secrets.json"), JSON.stringify(token ? { "lan.token": token } : {}));
  const desk = new Desk({
    home,
    github: new FakeGitHub([makeItem({ number: 7 })], () => []),
    now: () => NOW,
    notify: () => {},
    log: () => {},
  });
  await run(desk.init());
  await run(desk.sync());
  const app = createApp(desk, 47823);
  const far = lanFetch(app);
  const viaLan = (p: string, init: RequestInit = {}) => Promise.resolve(far(new Request(`${AT}${p}`, init)));
  return {
    app,
    viaLan,
    cleanup: () => {
      desk.stop();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

const basic = (t: string) => ({ authorization: `Basic ${Buffer.from(`me:${t}`).toString("base64")}` });

test("from the local network: no token is 401 asking for Basic auth; the token as Basic or Bearer reads the queue", async (c) => {
  const t = await setup();
  c.after(t.cleanup);
  const none = await t.viaLan("/api/queue");
  assert.equal(none.status, 401);
  assert.match(none.headers.get("www-authenticate") ?? "", /^Basic /);
  assert.equal((await t.viaLan("/api/queue", { headers: basic("wrong") })).status, 401);
  assert.equal((await t.viaLan("/api/queue", { headers: basic(TOKEN) })).status, 200);
  assert.equal((await t.viaLan("/api/queue", { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
});

test("from the local network: read only, and only from the desk's own address", async (c) => {
  const t = await setup();
  c.after(t.cleanup);
  const post = await t.viaLan("/api/act", { method: "POST", headers: { ...basic(TOKEN), "content-type": "application/json" }, body: "{}" });
  assert.equal(post.status, 403);
  assert.equal((await t.viaLan("/mcp", { method: "POST", headers: basic(TOKEN) })).status, 403);
  assert.equal((await t.viaLan("/api/queue", { headers: { ...basic(TOKEN), origin: "http://evil.example" } })).status, 403);
  assert.equal((await t.viaLan("/api/queue", { headers: { ...basic(TOKEN), origin: AT } })).status, 200);
});

test("from the local network: refused while it's off or has no token, and a Host of localhost changes nothing", async (c) => {
  const off = await setup(false);
  c.after(off.cleanup);
  assert.equal((await off.viaLan("/api/queue", { headers: basic(TOKEN) })).status, 403);
  const empty = await setup(true, "");
  c.after(empty.cleanup);
  assert.equal((await empty.viaLan("/api/queue", { headers: basic("") })).status, 403);
  const on = await setup();
  c.after(on.cleanup);
  const spoofed = await Promise.resolve(lanFetch(on.app)(new Request("http://localhost:47823/api/queue")));
  assert.equal(spoofed.status, 401);
});
