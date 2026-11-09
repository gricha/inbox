import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { deskHome, settleHome } from "../src/home.ts";
import { unusedPort } from "./helpers/fake-api.ts";
import { run } from "./helpers/run.ts";

// A scratch HOME holding the old home, with what a desk keeps there: never the real ~/.review-desk or ~/.inbox.
function scratch(c: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-home-"));
  c.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });
  const old = path.join(home, ".review-desk");
  const inbox = path.join(home, ".inbox");
  const lines: string[] = [];
  const log = (m: string) => {
    lines.push(m);
  };
  const keep = (dir: string) => {
    fs.mkdirSync(path.join(dir, "coordinator", ".claude"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config.toml"), "# mine\n");
    fs.writeFileSync(path.join(dir, "coordinator", ".claude", "settings.json"), "{}\n");
  };
  return { home, old, inbox, lines, log, keep };
}

// What the move leaves at ~/.review-desk: a link to ~/.inbox, so Review Desk.app or an old job opens the home, never an empty one.
const linked = (s: ReturnType<typeof scratch>) =>
  fs.lstatSync(s.old).isSymbolicLink() && fs.realpathSync(s.old) === fs.realpathSync(s.inbox);

test("the first start moves ~/.review-desk to ~/.inbox, all of it, logged once, and leaves a link to it", async (c) => {
  const s = scratch(c);
  s.keep(s.old);
  assert.equal(deskHome("", s.home), s.old, "until a desk starts, it's where it was");
  const port = await unusedPort();
  assert.equal(await run(settleHome(port, s.log, "", s.home)), s.inbox);
  assert.ok(fs.lstatSync(s.inbox).isDirectory());
  assert.ok(linked(s));
  if (process.platform !== "win32") assert.equal(fs.readlinkSync(s.old), ".inbox", "relative, so it follows the home folder");
  assert.equal(fs.readFileSync(path.join(s.inbox, "config.toml"), "utf8"), "# mine\n");
  assert.equal(fs.readFileSync(path.join(s.old, "config.toml"), "utf8"), "# mine\n", "the old path opens the same home");
  assert.ok(fs.existsSync(path.join(s.inbox, "coordinator", ".claude", "settings.json")));
  assert.deepEqual(s.lines, [`moved the desk's home from ${s.old} to ${s.inbox}, and left ${s.old} as a link to it`]);
  assert.equal(await run(settleHome(port, s.log, "", s.home)), s.inbox);
  assert.equal(deskHome("", s.home), s.inbox);
  assert.equal(s.lines.length, 1, "logged once");
});

test("DESK_HOME wins over both, and nothing moves", async (c) => {
  const s = scratch(c);
  s.keep(s.old);
  const mine = path.join(s.home, "scratch-desk");
  assert.equal(deskHome(mine, s.home), mine);
  assert.equal(await run(settleHome(await unusedPort(), s.log, mine, s.home)), mine);
  assert.ok(fs.existsSync(s.old));
  assert.equal(fs.existsSync(s.inbox), false);
  assert.deepEqual(s.lines, []);
});

test("with ~/.inbox there, it's the home and the old folder is left as it is, which each start says", async (c) => {
  const s = scratch(c);
  s.keep(s.old);
  fs.mkdirSync(s.inbox);
  assert.equal(deskHome("", s.home), s.inbox);
  const port = await unusedPort();
  assert.equal(await run(settleHome(port, s.log, "", s.home)), s.inbox);
  assert.equal(fs.readFileSync(path.join(s.old, "config.toml"), "utf8"), "# mine\n");
  assert.deepEqual(fs.readdirSync(s.inbox), []);
  const beside = `${s.old} is still there beside ${s.inbox}: the desk's home is ${s.inbox}, and ${s.old} is left as it is`;
  assert.deepEqual(s.lines, [beside]);
  assert.equal(await run(settleHome(port, s.log, "", s.home)), s.inbox);
  assert.deepEqual(s.lines, [beside, beside], "once per start");
});

test("with neither, it's ~/.inbox, which the desk makes as it starts", async (c) => {
  const s = scratch(c);
  assert.equal(deskHome("", s.home), s.inbox);
  assert.equal(await run(settleHome(await unusedPort(), s.log, "", s.home)), s.inbox);
  assert.equal(fs.existsSync(s.inbox), false);
  assert.deepEqual(s.lines, []);
});

test("while a desk answers on the port, both stay and the log says so; the next start with the port free moves it", async (c) => {
  const s = scratch(c);
  s.keep(s.old);
  const desk = createServer();
  await new Promise<void>((r) => {
    desk.listen(0, "127.0.0.1", r);
  });
  const { port } = desk.address() as AddressInfo;
  assert.equal(await run(settleHome(port, s.log, "", s.home)), s.old);
  assert.ok(fs.existsSync(s.old));
  assert.equal(fs.existsSync(s.inbox), false);
  assert.equal(s.lines.length, 1);
  assert.match(s.lines[0]!, new RegExp(`^a desk is running on port ${port}, so .+\\.review-desk stays where it is`));
  await new Promise<void>((r) => {
    desk.close(() => {
      r();
    });
  });
  assert.equal(await run(settleHome(port, s.log, "", s.home)), s.inbox);
  assert.ok(linked(s));
});

test("a link at ~/.review-desk to a folder (a dotfiles home) moves as the link: ~/.inbox points where it did", async (c) => {
  const s = scratch(c);
  const dotfiles = path.join(s.home, "dotfiles", "desk");
  s.keep(dotfiles);
  fs.symlinkSync(dotfiles, s.old, "junction");
  assert.equal(deskHome("", s.home), s.old);
  assert.equal(await run(settleHome(await unusedPort(), s.log, "", s.home)), s.inbox);
  assert.ok(fs.lstatSync(s.inbox).isSymbolicLink());
  assert.equal(fs.realpathSync(s.inbox), fs.realpathSync(dotfiles));
  assert.equal(fs.readFileSync(path.join(s.inbox, "config.toml"), "utf8"), "# mine\n");
  assert.ok(linked(s));
  assert.deepEqual(s.lines, [`moved the desk's home from ${s.old} to ${s.inbox}, and left ${s.old} as a link to it`]);
});

test("a file or a broken link at ~/.review-desk isn't a home: it stays as it is, and the home is ~/.inbox", async (c) => {
  const s = scratch(c);
  fs.writeFileSync(s.old, "not a folder");
  assert.equal(deskHome("", s.home), s.inbox);
  assert.equal(await run(settleHome(await unusedPort(), s.log, "", s.home)), s.inbox);
  assert.equal(fs.readFileSync(s.old, "utf8"), "not a folder");
  assert.equal(fs.existsSync(s.inbox), false);
  assert.deepEqual(s.lines, [`${s.old} isn't a folder, so it stays as it is; the desk's home is ${s.inbox}`]);
  fs.rmSync(s.old);
  fs.symlinkSync(path.join(s.home, "gone"), s.old, "junction");
  assert.equal(await run(settleHome(await unusedPort(), s.log, "", s.home)), s.inbox);
  assert.ok(fs.lstatSync(s.old).isSymbolicLink());
  assert.equal(s.lines.length, 1, "a link to nothing is nothing to move");
});
