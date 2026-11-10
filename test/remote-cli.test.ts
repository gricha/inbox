import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { main } from "../src/cli.ts";
import { createClient } from "../src/client.ts";
import { Desk } from "../src/desk.ts";
import { Remote } from "../src/remote.ts";
import { createApp, remoteFetch } from "../src/server.ts";
import { FakeGitHub, makeItem, NOW } from "./helpers/items.ts";
import { run } from "./helpers/run.ts";

delete process.env.DESK_UI_ORIGIN;
delete process.env.DESK_DEV;

const NAME = "desk.tail1.ts.net";
const AT = `https://${NAME}`;
const OWNER = "owner@example.com";

// The desk on a loopback port for `desk pair`, and every fetch to its tailnet address answered in-process as serve would.
async function setup(c: { after(fn: () => unknown): void; mock: { method: typeof import("node:test").mock.method } }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-rcli-"));
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ "policy.judge": false }));
  const logs: string[] = [];
  const desk = new Desk({
    home,
    github: new FakeGitHub([makeItem({ number: 7 })], () => []),
    now: () => NOW,
    notify: () => {},
    log: (m) => {
      logs.push(m);
    },
  });
  await run(desk.init());
  await run(desk.sync());
  const remote = new Remote(desk.store);
  remote.tailnet = { name: NAME, login: OWNER };
  const app = createApp(desk, 47823, remote);
  const srv = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => {
      resolve(s);
    });
  });
  const far = remoteFetch(app);
  const real = globalThis.fetch;
  c.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    if (new URL(req.url).hostname !== NAME) return real(req);
    const headers = new Headers(req.headers);
    headers.set("tailscale-user-login", OWNER);
    return Promise.resolve(far(new Request(req, { headers })));
  });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "desk-rcli-home-"));
  const bin = path.join(scratch, "bin");
  fs.mkdirSync(bin);
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH, DESK_PORT: process.env.DESK_PORT };
  Object.assign(process.env, { HOME: scratch, USERPROFILE: scratch, PATH: bin, DESK_PORT: String((srv.address() as AddressInfo).port) });
  c.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    srv.close();
    desk.stop();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  // An agent's CLI that keeps what it was run with, one argument a line.
  const agent = (name: string, script = "") => {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$@" > "$HOME/${name}-args"\n${script}\n`, { mode: 0o755 });
  };
  const argsOf = (name: string) =>
    fs
      .readFileSync(path.join(scratch, `${name}-args`), "utf8")
      .trim()
      .split("\n");
  const works = async (token: string) =>
    (await globalThis.fetch(`${AT}/api/queue`, { headers: { authorization: `Bearer ${token}` } })).status === 200;
  return { desk, remote, logs, scratch, agent, argsOf, works };
}

async function cli(argv: string[]) {
  let out = "",
    err = "";
  const code = await main(argv, { stdout: { write: (s: string) => (out += s) }, stderr: { write: (s: string) => (err += s) } });
  return { code, out, err };
}

test("desk pair prints the code, the browser's link and the other machine's command; --print a token whose commands work", async (c) => {
  const t = await setup(c);
  const p = await cli(["pair"]);
  assert.equal(p.code, 0, p.err);
  const code = /Pairing code (\w{4}-\w{4})/.exec(p.out)?.[1];
  assert.ok(code, p.out);
  assert.ok(p.out.includes(`${AT}/pair#${code}`), p.out);
  assert.ok(p.out.includes(`bin/desk connect ${AT} --code ${code}`), p.out);
  const printed = await cli(["pair", "--print", "--name", "work laptop"]);
  assert.equal(printed.code, 0, printed.err);
  const token = /Bearer (inbox_[\w-]+)/.exec(printed.out)?.[1];
  assert.ok(token, printed.out);
  assert.ok(printed.out.includes(`claude mcp add --transport http --scope user inbox ${AT}/mcp --header 'Authorization: Bearer ${token}'`));
  assert.ok(printed.out.includes(`codex mcp add inbox --url ${AT}/mcp --bearer-token-env-var INBOX_TOKEN`));
  assert.ok(printed.out.includes(`curl -fsS -H 'Authorization: Bearer ${token}' ${AT}/skill -o ~/.claude/skills/inbox/SKILL.md`));
  assert.ok(await t.works(token));
  assert.deepEqual(
    t.remote.devices().map((d) => d.name),
    ["work laptop"],
  );
  assert.ok(!t.logs.some((l) => l.includes(token) || l.includes(code)), t.logs.join("\n"));
});

test("desk connect <address> --code on another machine trades the code, installs the skill and registers the MCP server with the token", async (c) => {
  const t = await setup(c);
  t.agent("claude");
  const code = t.remote.mint().code;
  const r = await cli(["connect", NAME, "--code", code]);
  assert.equal(r.code, 0, r.err);
  const args = t.argsOf("claude");
  assert.deepEqual(args.slice(0, 8), ["mcp", "add", "--transport", "http", "--scope", "user", "inbox", `${AT}/mcp`]);
  assert.equal(args[8], "--header");
  const token = /^Authorization: Bearer (inbox_[\w-]+)$/.exec(args[9] ?? "")?.[1];
  assert.ok(token && (await t.works(token)), args.join(" "));
  assert.ok(!r.out.includes(token), "Claude Code keeps it; it isn't printed");
  const skill = fs.readFileSync(path.join(t.scratch, ".claude", "skills", "inbox", "SKILL.md"), "utf8");
  assert.ok(skill.includes(AT) && !skill.includes("localhost:47823"));
  assert.equal(t.remote.devices()[0]!.name, os.hostname());
  const again = await cli(["connect", AT, "--code", code]);
  assert.deepEqual([again.code, again.err], [1, "desk: that pairing code isn't valid: run desk pair again for a new one\n"]);
  const bad = await cli(["connect", `http://${NAME}`, "--code", code]);
  assert.equal(bad.code, 2, "only https");
});

test("desk connect for Codex registers the variable it reads the token from, and says to set it", async (c) => {
  const t = await setup(c);
  t.agent("codex");
  const r = await cli(["connect", AT, "codex", "--code", t.remote.mint().code]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(t.argsOf("codex"), ["mcp", "add", "inbox", "--url", `${AT}/mcp`, "--bearer-token-env-var", "INBOX_TOKEN"]);
  const token = /export INBOX_TOKEN=(inbox_[\w-]+)/.exec(r.out)?.[1];
  assert.ok(token && (await t.works(token)), r.out);
  assert.ok(fs.existsSync(path.join(t.scratch, ".agents", "skills", "inbox", "SKILL.md")));
});

test("when the agent's CLI fails, what connect says names <token>, never the token", async (c) => {
  const t = await setup(c);
  t.agent("claude", "exit 1");
  const r = await cli(["connect", AT, "--code", t.remote.mint().code]);
  assert.equal(r.code, 1);
  assert.ok(r.err.includes("--header 'Authorization: Bearer <token>'") && !r.err.includes("inbox_"), r.err);
});

test("DESK_URL and DESK_TOKEN point the CLI and desk mcp at a desk on another machine, the token only over https", async (c) => {
  const t = await setup(c);
  const { token } = t.remote.issue("stdio", "device");
  const saved = { DESK_URL: process.env.DESK_URL, DESK_TOKEN: process.env.DESK_TOKEN };
  c.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  Object.assign(process.env, { DESK_URL: `${AT}/`, DESK_TOKEN: token });
  const s = await run(createClient().status());
  assert.equal(typeof s.now, "number");
  const sent: (string | null)[] = [];
  const fetched = c.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
    sent.push(new Request(input, init).headers.get("authorization"));
    return Promise.resolve(Response.json({ ok: true }));
  });
  process.env.DESK_URL = `http://${NAME}`;
  await run(createClient().health());
  assert.deepEqual(sent, [null], "not over plain http");
  fetched.mock.restore();
});
