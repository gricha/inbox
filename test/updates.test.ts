import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Effect } from "effect";
import { GitHubHttpError, Upstream } from "../src/errors.ts";
import { createGitHub } from "../src/github/index.ts";
import { Runner } from "../src/runner.ts";
import { newer, releaseVersion, Updates, type AppUpdater } from "../src/updates.ts";
import { selfUpdates } from "../electron/lib.ts";
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

test("Update runs the app's install once; one that fails says why and leaves the release page", async () => {
  let installs = 0;
  let outcome: Effect.Effect<void, Upstream> = Effect.never;
  const { u } = updates({
    version: "0.1.0",
    install: () => {
      installs++;
      return outcome;
    },
  });
  await run(u.check());
  assert.equal(u.view()?.install, true);
  assert.equal((await run(u.install())).installing, true);
  await run(u.install());
  assert.equal(installs, 1, "a second press while it installs starts nothing");

  const again = updates({
    version: "0.1.0",
    install: () => {
      installs++;
      return outcome;
    },
  });
  outcome = Effect.fail(new Upstream({ message: "downloading the update: net::ERR_FAILED" }));
  await run(again.u.check());
  await run(again.u.install());
  await sleep(0);
  assert.deepEqual(again.u.view(), {
    current: "0.1.0",
    latest: "0.2.0",
    url: URL,
    available: true,
    install: false,
    installing: false,
    error: "downloading the update: net::ERR_FAILED",
  });
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

test("the app installs an update itself only from an AppImage or the Windows installer's install", () => {
  assert.equal(selfUpdates("linux", { APPIMAGE: "/home/me/Inbox-0.1.0.AppImage" }, false), true);
  assert.equal(selfUpdates("linux", {}, false), false);
  assert.equal(selfUpdates("win32", {}, true), true);
  assert.equal(selfUpdates("win32", {}, false), false);
  assert.equal(selfUpdates("darwin", {}, true), false);
});
