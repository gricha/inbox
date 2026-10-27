import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Desk } from "../src/desk.ts";
import { notifyCommand, openCommand } from "../src/notify.ts";
import { createApp } from "../src/server.ts";
import { FakeGitHub, hoursAgo, makeItem, NOW } from "./helpers/items.ts";

async function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-srv-"));
  const items = [makeItem({ number: 7, review_requests: [{ reviewer: "me", type: "user", codeowner: false }], request_events: [{ at: hoursAgo(1), actor: "alice", actor_bot: false, reviewer: "me", reviewer_type: "user" }] })];
  const desk = new Desk({ home, github: new FakeGitHub(items, (q) => (q.includes("review-requested:@me") ? ["acme/api#7"] : [])), now: () => NOW, notify: () => {}, log: () => {} });
  await desk.init();
  await desk.sync();
  const app = createApp(desk, 47823);
  const req = (p: string, init: RequestInit = {}) => app.request(`http://127.0.0.1:47823${p}`, init);
  const json = async (p: string, init: RequestInit = {}): Promise<any> => (await req(p, init)).json();
  return { desk, app, req, json, cleanup: () => { desk.stop(); fs.rmSync(home, { recursive: true }); } };
}

test("rejects foreign Host and Origin", async () => {
  const t = await setup();
  assert.equal((await t.app.request("http://evil.example/api/overview")).status, 403);
  assert.equal((await t.req("/api/act", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" })).status, 403);
  assert.equal((await t.req("/api/overview", { headers: { origin: "http://localhost:47823" } })).status, 200);
  t.cleanup();
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

  const act = await t.json("/api/act", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "api#7", action: "done" }) });
  assert.equal(act.ok, true);
  assert.ok(act.state.done_at);
  assert.equal((await t.json("/api/status")).text, "");
  const undo = await t.json("/api/undo", { method: "POST" });
  assert.deepEqual(undo, { ok: true, id: "acme/api#7", action: "done" });
  assert.equal((await t.json("/api/status")).text, "desk ●1");
  t.cleanup();
});

test("errors: unknown board/item, bad action", async () => {
  const t = await setup();
  assert.equal((await t.req("/api/boards/nope")).status, 404);
  assert.equal((await t.req("/api/item?id=api%2399")).status, 404);
  const bad = await t.req("/api/act", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "api#7", action: "explode" }) });
  assert.equal(bad.status, 400);
  assert.equal((await t.req("/api/nope")).status, 404);
  t.cleanup();
});

test("config preview and save", async () => {
  const t = await setup();
  const cfg = await t.json("/api/config");
  assert.ok(cfg.text.includes("[[boards]]"));
  assert.deepEqual(cfg.warnings, []);
  const prev = await t.json("/api/config/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "bogus = [" }) });
  assert.ok(prev.errors.length > 0);
  const legacy = await t.json("/api/config/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `poll_seconds = 60\n${cfg.text}` }) });
  assert.deepEqual([legacy.errors, legacy.warnings.map((w: { path: string }) => w.path)], [[], ["poll_seconds"]]);
  assert.ok(legacy.boards.length > 0);
  const put = await t.json("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: cfg.text }) });
  assert.equal(put.ok, true);
  const fields = await t.json("/api/fields");
  assert.ok(fields.some((f: { path: string }) => f.path === "me.requested_direct"));
  t.cleanup();
});

test("opening a URL and notifying per platform, all as argv", () => {
  const url = "http://localhost:47823";
  assert.deepEqual(openCommand(url, "darwin"), ["open", [url]]);
  assert.deepEqual(openCommand(url, "linux"), ["xdg-open", [url]]);
  assert.deepEqual(openCommand(url, "win32"), ["rundll32", ["url.dll,FileProtocolHandler", url]]);
  assert.deepEqual(notifyCommand("Review Desk", "-u critical; \"x\"", "linux"), ["notify-send", ["--app-name=Review Desk", "--", "Review Desk", '-u critical; "x"']]);
  assert.deepEqual(notifyCommand("Review Desk", "body", "darwin")?.[1].slice(-2), ["body", "Review Desk"]);
  assert.equal(notifyCommand("Review Desk", "body", "win32"), null);
});
