import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Effect } from "effect";
import { GitHubHttpError, Upstream } from "../src/errors.ts";
import { createGitHub } from "../src/github/index.ts";
import { Runner } from "../src/runner.ts";
import { newer, releaseVersion, Updates, type AppUpdater } from "../src/updates.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { bundleOf, macDmg, selfUpdates } from "../electron/lib.ts";
import { download, release, swap } from "../electron/mac-update.ts";
import { failure, run } from "./helpers/run.ts";

test("newer compares x.y.z, a v allowed, a prerelease before its release", () => {
  assert.equal(newer("v0.2.0", "0.1.0"), true);
  assert.equal(newer("0.10.0", "0.9.9"), true);
  assert.equal(newer("1.0.0", "1.0.0"), false);
  assert.equal(newer("0.1.0", "0.2.0"), false);
  assert.equal(newer("1.0.0", "1.0.0-beta.1"), true);
  assert.equal(newer("1.0.0-beta.1", "1.0.0"), false);
  assert.equal(newer("nightly", "0.1.0"), false);
});

test("npm run release takes a plain x.y.z past the current version", () => {
  assert.deepEqual(releaseVersion("0.2.0", "0.1.0"), { version: "0.2.0" });
  assert.deepEqual(releaseVersion("v1.0.0", "0.1.0"), { version: "1.0.0" });
  assert.deepEqual(releaseVersion(undefined, "0.1.0"), { refused: "usage: npm run release <x.y.z>, e.g. npm run release 0.2.0" });
  assert.ok("refused" in releaseVersion("0.2.0-beta.1", "0.1.0"));
  assert.deepEqual(releaseVersion("0.1.0", "0.1.0"), { refused: "0.1.0 isn't past 0.1.0, the version now" });
});

type Latest = Effect.Effect<{ tag: string; url: string } | null, GitHubHttpError>;
const URL = "https://github.com/gricha/inbox/releases/tag/v0.2.0";

function updates(app: AppUpdater | null, latest: () => Latest = () => Effect.succeed({ tag: "v0.2.0", url: URL })) {
  const logs: string[] = [];
  let changes = 0;
  let asked = 0;
  const u = new Updates({
    latest: () => {
      asked++;
      return latest();
    },
    app,
    runner: new Runner(
      () => {},
      () => {},
      (fn) => {
        fn();
      },
    ),
    log: (m) => {
      logs.push(m);
    },
    changed: () => {
      changes++;
    },
  });
  return { u, logs, changes: () => changes, asked: () => asked };
}

test("a desk no packaged app runs never asks GitHub and has nothing to show", () => {
  const { u, asked } = updates(null);
  u.start();
  u.stop();
  assert.equal(asked(), 0);
  assert.equal(u.view(), null);
});

test("a newer release is available; without an install of the app's, its release page is where to get it", async () => {
  const { u, changes } = updates({ version: "0.1.0" });
  assert.deepEqual(u.view(), {
    current: "0.1.0",
    latest: null,
    url: null,
    available: false,
    install: false,
    downloading: false,
    ready: false,
    installing: false,
    error: null,
  });
  await run(u.check());
  assert.deepEqual(u.view(), {
    current: "0.1.0",
    latest: "0.2.0",
    url: URL,
    available: true,
    install: false,
    downloading: false,
    ready: false,
    installing: false,
    error: null,
  });
  assert.equal(changes(), 1);
  await run(u.check());
  assert.equal(changes(), 1, "the same release again changes nothing");
  assert.equal((await failure(u.install()))._tag, "Conflict");
});

test("the app's own version or older isn't an update, and no release or a failed check keeps what it knew", async () => {
  assert.equal(updates({ version: "0.2.0" }).u.view()?.available, false);
  const same = updates({ version: "0.2.0" });
  await run(same.u.check());
  assert.equal(same.u.view()?.available, false);
  assert.equal((await failure(same.u.install())).message, "Inbox is up to date");

  const none = updates({ version: "0.1.0" }, () => Effect.succeed(null));
  await run(none.u.check());
  assert.equal(none.u.view()?.latest, null);

  const down = updates({ version: "0.1.0" }, () => Effect.fail(new GitHubHttpError({ status: 502, message: "GitHub HTTP 502" })));
  await run(down.u.check());
  assert.equal(down.u.view()?.latest, null);
  assert.deepEqual(down.logs, ["checking for an update: GitHub HTTP 502"]);
});

test("a newer release is downloaded unasked, once; Restart then runs the app's install once", async () => {
  let downloads = 0;
  let installs = 0;
  let done: (() => void) | null = null;
  const { u, logs } = updates({
    version: "0.1.0",
    download: () => {
      downloads++;
      return Effect.callback<void>((resume) => {
        done = () => {
          resume(Effect.void);
        };
      });
    },
    install: () => {
      installs++;
      return Effect.never;
    },
  });
  await run(u.check());
  assert.deepEqual([u.view()?.install, u.view()?.downloading, u.view()?.ready], [true, true, false]);
  await run(u.check());
  assert.equal((await run(u.install())).installing, false, "a press before it's downloaded restarts nothing");
  assert.deepEqual([downloads, installs], [1, 0]);
  done!();
  await sleep(0);
  assert.deepEqual([u.view()?.downloading, u.view()?.ready], [false, true]);
  assert.equal((await run(u.install())).installing, true);
  await run(u.install());
  assert.deepEqual([downloads, installs], [1, 1], "a second press while it restarts starts nothing");
  assert.deepEqual(logs.slice(1), ["downloading Inbox 0.2.0", "Inbox 0.2.0 is downloaded", "restarting into Inbox 0.2.0"]);
});

test("a download that fails says why and leaves the release page; the next check tries again", async () => {
  let outcome: Effect.Effect<void, Upstream> = Effect.fail(new Upstream({ message: "downloading the update: net::ERR_FAILED" }));
  const { u } = updates({ version: "0.1.0", download: () => outcome, install: () => Effect.never });
  await run(u.check());
  await sleep(0);
  assert.deepEqual(u.view(), {
    current: "0.1.0",
    latest: "0.2.0",
    url: URL,
    available: true,
    install: false,
    downloading: false,
    ready: false,
    installing: false,
    error: "downloading the update: net::ERR_FAILED",
  });
  assert.equal((await failure(u.install()))._tag, "Conflict");
  outcome = Effect.void;
  await run(u.check());
  await sleep(0);
  assert.deepEqual([u.view()?.install, u.view()?.ready, u.view()?.error], [true, true, null]);
});

test("the read client asks for the latest release, and a repo with none is no release", async () => {
  const asked: string[] = [];
  let status = 200;
  const fake = ((url: string) => {
    asked.push(url);
    return Promise.resolve(
      status === 200
        ? new Response(JSON.stringify({ tag_name: "v0.2.0", html_url: URL }))
        : new Response(JSON.stringify({ message: "Not Found" }), { status }),
    );
  }) as unknown as typeof fetch;
  const gh = createGitHub({ token: "t", fetch: fake });
  assert.deepEqual(await run(gh.latestRelease("gricha/inbox")), { tag: "v0.2.0", url: URL });
  assert.deepEqual(asked, ["https://api.github.com/repos/gricha/inbox/releases/latest"]);
  status = 404;
  assert.equal(await run(gh.latestRelease("gricha/inbox")), null);
});

test("the app installs an update itself only from an AppImage, the Windows installer's install or a Mac app it can replace", () => {
  assert.equal(selfUpdates("linux", { APPIMAGE: "/home/me/Inbox-0.1.0.AppImage" }, false), true);
  assert.equal(selfUpdates("linux", {}, false), false);
  assert.equal(selfUpdates("win32", {}, true), true);
  assert.equal(selfUpdates("win32", {}, false), false);
  assert.equal(selfUpdates("darwin", {}, true), true);
  assert.equal(selfUpdates("darwin", {}, false), false);
});

test("a Mac's bundle is found from its executable, not when macOS runs a translocated copy", () => {
  assert.equal(bundleOf("/Applications/Inbox.app/Contents/MacOS/Inbox"), "/Applications/Inbox.app");
  assert.equal(
    bundleOf("/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
    "/repo/node_modules/electron/dist/Electron.app",
  );
  assert.equal(bundleOf("/private/var/folders/x/AppTranslocation/ABC/d/Inbox.app/Contents/MacOS/Inbox"), null);
  assert.equal(bundleOf("/usr/local/bin/node"), null);
  assert.equal(macDmg("0.3.0", "arm64"), "Inbox-0.3.0-arm64.dmg");
  assert.equal(macDmg("0.3.0", "x64"), "Inbox-0.3.0.dmg");
});

test("a Mac's update is this Mac's dmg from the latest release, refused unless it matches the release's checksum", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-test-"));
  const bytes = Buffer.from("a dmg");
  let digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const asked: [string, string | null][] = [];
  const fake = ((url: string, init: RequestInit) => {
    asked.push([url, new Headers(init.headers).get("Authorization")]);
    if (url.endsWith("/releases/latest"))
      return Promise.resolve(
        Response.json({
          tag_name: "v0.3.0",
          assets: [
            { name: "Inbox-0.3.0.dmg", url: "https://api.github.com/assets/1", digest: "sha256:intel" },
            { name: "Inbox-0.3.0-arm64.dmg", url: "https://api.github.com/assets/2", digest },
          ],
        }),
      );
    return Promise.resolve(new Response(bytes));
  }) as unknown as typeof fetch;
  const o = { token: "t", repo: "gricha/inbox", bundle: "/Applications/Inbox.app", arch: "arm64", fetch: fake };
  const rel = await run(release(o));
  assert.equal(rel.version, "0.3.0");
  assert.equal(fs.readFileSync(await run(download(o, rel, dir)), "utf8"), "a dmg");
  assert.deepEqual(asked, [
    ["https://api.github.com/repos/gricha/inbox/releases/latest", "Bearer t"],
    ["https://api.github.com/assets/2", "Bearer t"],
  ]);
  digest = "sha256:another";
  assert.match((await failure(download(o, await run(release(o)), dir))).message, /doesn't match the release's checksum/);
  const intel = { ...o, arch: "x64" };
  assert.match((await failure(download(intel, await run(release(intel)), dir))).message, /doesn't match/);
  fs.rmSync(dir, { recursive: true });
});

test("the new app takes the old one's place and the old one is deleted; a swap that fails puts the old one back", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-test-"));
  const bundle = path.join(dir, "Inbox.app");
  const staged = path.join(dir, ".Inbox.app.update");
  fs.mkdirSync(bundle);
  fs.writeFileSync(path.join(bundle, "v"), "old");
  fs.mkdirSync(staged);
  fs.writeFileSync(path.join(staged, "v"), "new");
  await run(swap(bundle, staged));
  assert.equal(fs.readFileSync(path.join(bundle, "v"), "utf8"), "new");
  assert.deepEqual(fs.readdirSync(dir), ["Inbox.app"]);
  assert.match((await failure(swap(bundle, staged))).message, /moving the new app in/);
  assert.equal(fs.readFileSync(path.join(bundle, "v"), "utf8"), "new");
  assert.deepEqual(fs.readdirSync(dir), ["Inbox.app"]);
  fs.rmSync(dir, { recursive: true });
});
