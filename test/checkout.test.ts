import "./helpers/no-agent.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkoutFor, prCheckout } from "../src/checkout.ts";
import { failure, run } from "./helpers/run.ts";
import { posix } from "./helpers/platform.ts";

// Run from a git hook (pre-push), GIT_DIR and the like point every git here at the desk's own repo.
for (const k of Object.keys(process.env)) if (k.startsWith("GIT_")) delete process.env[k];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

// GitHub as a local repo (main, and a PR head only under refs/pull/7/head), and your clone of it before the PR was pushed.
function repos() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "desk-checkout-")));
  const hub = path.join(root, "hub");
  fs.mkdirSync(hub);
  git(hub, "init", "-q");
  fs.writeFileSync(path.join(hub, "app.ts"), "export const limit = 10;\n");
  git(hub, "add", ".");
  git(hub, "commit", "-qm", "main");
  const clone = path.join(root, "code", "api");
  git(root, "clone", "-q", hub, clone);
  git(hub, "checkout", "-qb", "pr");
  fs.writeFileSync(path.join(hub, "app.ts"), "export const limit = 100;\n");
  git(hub, "commit", "-qam", "pr");
  const head = git(hub, "rev-parse", "HEAD");
  git(hub, "update-ref", "refs/pull/7/head", head);
  git(hub, "checkout", "-q", "main");
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  return { root, hub, clone, head, home };
}

test("a PR's head is checked out from your clone, fetched when the clone lacks it, and your clone is left as it was", posix, async () => {
  const r = repos();
  const before = [git(r.clone, "for-each-ref"), git(r.clone, "worktree", "list"), git(r.clone, "status", "--porcelain")];
  const item = { repo: "acme/api", number: 7, head_oid: r.head };
  const c = await run(prCheckout(r.home, r.clone, item, r.hub));
  assert.equal(fs.readFileSync(path.join(c.dir, "app.ts"), "utf8"), "export const limit = 100;\n", "the PR's code, not main's");
  assert.equal(git(c.dir, "rev-parse", "HEAD"), r.head);
  assert.deepEqual(
    [git(r.clone, "for-each-ref"), git(r.clone, "worktree", "list"), git(r.clone, "status", "--porcelain")],
    before,
    "no ref, worktree or file of yours changed",
  );

  const again = await run(prCheckout(r.home, r.clone, item, path.join(r.root, "nowhere")));
  assert.notEqual(again.dir, c.dir, "a checkout per review; the head is already fetched, so no remote is asked");
  await run(c.done);
  await run(again.done);
  assert.ok(!fs.existsSync(c.dir) && !fs.existsSync(again.dir), "removed once it's done");
  fs.rmSync(r.root, { recursive: true });
});

test("with no clone of yours, the desk clones it from GitHub (blobless) and checks the head out from that", posix, async () => {
  const r = repos();
  const item = { repo: "acme/api", number: 7, head_oid: r.head };
  const c = await run(checkoutFor(r.home, item, () => null, r.hub));
  assert.equal(fs.readFileSync(path.join(c.dir, "app.ts"), "utf8"), "export const limit = 100;\n");
  assert.ok(!fs.existsSync(path.join(r.home, "repos", "acme__api.git", "objects", "info", "alternates")), "its own, borrowing nothing");
  await run(c.done);
  fs.rmSync(r.root, { recursive: true });
});

test("a git that only opens bare repos it's pointed at (safe.bareRepository=explicit) still checks the head out", posix, async () => {
  const r = repos();
  const item = { repo: "acme/api", number: 7, head_oid: r.head };
  process.env.GIT_CONFIG_PARAMETERS = "'safe.bareRepository=explicit'";
  try {
    for (const clone of [r.clone, null]) {
      const home = path.relative(process.cwd(), r.home); // DESK_HOME may be relative
      const c = await run(checkoutFor(home, { ...item, repo: `acme/${clone ? "yours" : "hub"}` }, () => clone, r.hub));
      assert.equal(fs.readFileSync(path.join(c.dir, "app.ts"), "utf8"), "export const limit = 100;\n");
      await run(c.done);
      assert.ok(!fs.existsSync(c.dir), "removed once it's done");
    }
  } finally {
    delete process.env.GIT_CONFIG_PARAMETERS;
    fs.rmSync(r.root, { recursive: true });
  }
});

test("a head that can't be fetched is why there's no review, in words its review shows", posix, async () => {
  const r = repos();
  const gone = await failure(
    checkoutFor(r.home, { repo: "acme/api", number: 8, head_oid: "0".repeat(40) }, () => r.clone, path.join(r.root, "nowhere")),
  );
  assert.equal(gone._tag, "NoCheckout");
  assert.match(gone.message, new RegExp(`^couldn't check out this PR's head from your clone at ${r.clone}: `));
  fs.rmSync(r.root, { recursive: true });
});

// Your clone made shallow or blobless, then a branch fetched into it but never checked out (so a blobless one lacks its file),
// and a PR on top of that commit.
for (const [kind, args] of [
  ["shallow", ["--depth", "1"]],
  ["blobless", ["--filter=blob:none"]],
  ["shallow and blobless", ["--depth", "1", "--filter=blob:none"]],
] as const)
  test(
    `a ${kind} clone of yours isn't borrowed: the desk clones from GitHub, says why once, and your clone is left as it was`,
    posix,
    async () => {
      const r = repos();
      git(r.hub, "config", "uploadpack.allowFilter", "true");
      const clone = path.join(r.root, "code", "partial");
      git(r.root, "clone", "-q", ...args, `file://${r.hub}`, clone);
      fs.writeFileSync(path.join(r.hub, "limits.ts"), "export const max = 5;\n");
      git(r.hub, "add", ".");
      git(r.hub, "commit", "-qm", "main moves on");
      git(clone, "fetch", "-q", "origin", "main:moved");
      git(r.hub, "checkout", "-qb", "pr2");
      fs.writeFileSync(path.join(r.hub, "app.ts"), "export const limit = 1000;\n");
      git(r.hub, "commit", "-qam", "pr2");
      const head = git(r.hub, "rev-parse", "HEAD");
      git(r.hub, "update-ref", "refs/pull/9/head", head);
      git(r.hub, "checkout", "-q", "main");
      const mine = () => [git(clone, "for-each-ref"), git(clone, "config", "--list", "--local"), git(clone, "count-objects", "-v")];
      const before = mine();
      const repo = `acme/${kind.replaceAll(" ", "-")}`; // its own: the log says it once per repo, for the whole desk
      const item = { repo, number: 9, head_oid: head };
      const said: string[] = [];
      const log = (m: string) => {
        said.push(m);
      };
      const c = await run(checkoutFor(r.home, item, () => clone, r.hub, log));
      assert.equal(fs.readFileSync(path.join(c.dir, "app.ts"), "utf8"), "export const limit = 1000;\n", "the PR's code");
      assert.equal(fs.readFileSync(path.join(c.dir, "limits.ts"), "utf8"), "export const max = 5;\n", "with main's file your clone lacks");
      const bare = path.join(r.home, "repos", `${repo.replace("/", "__")}.git`);
      assert.ok(!fs.existsSync(path.join(bare, "objects", "info", "alternates")), "its own, borrowing nothing");
      const again = await run(checkoutFor(r.home, item, () => clone, r.hub, log));
      assert.equal(said.length, 1, "said once per repo");
      assert.ok(said[0]?.startsWith(`${repo}: `), said[0]);
      assert.deepEqual(mine(), before, "nothing of yours changed");
      await run(c.done);
      await run(again.done);
      fs.rmSync(r.root, { recursive: true });
    },
  );
