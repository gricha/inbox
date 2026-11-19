// The Mac's own update: Squirrel.Mac refuses an ad hoc signed build, so the release's app is downloaded and kept beside the
// running one, then swapped in for it here. No electron import, so node --test can load it.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { messageOf, Upstream } from "../src/errors.ts";
import { field, str } from "../src/narrow.ts";
import { macDmg } from "./lib.ts";

interface MacUpdate {
  token: string;
  repo: string; // owner/name
  bundle: string; // the running Inbox.app
  arch: string;
  fetch?: typeof fetch;
}

const failed = (what: string) => (cause: unknown) => new Upstream({ message: `${what}: ${messageOf(cause)}`, cause });
const attempt = <A>(what: string, f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: failed(what) });
const exec = (what: string, cmd: string, args: string[]) =>
  Effect.callback<string, Upstream>((resume) => {
    execFile(cmd, args, (e, stdout) => {
      resume(e ? Effect.fail(failed(what)(e)) : Effect.succeed(stdout));
    });
  });
// rm, not fs.rm: inside Electron, fs reads an app's app.asar as a folder it can't delete, and the old app left behind would
// stop the next update moving this one aside.
const remove = (p: string) => Effect.ignore(exec("clearing up", "rm", ["-rf", p]));
// Beside the app, so moving it into place is a rename on one volume.
const aside = (bundle: string, what: string) => path.join(path.dirname(bundle), `.${path.basename(bundle)}.${what}`);

interface Release {
  version: string;
  name: string; // this Mac's dmg
  url: string;
  digest: string; // sha256:…, as GitHub lists it
}

const get = (o: MacUpdate, what: string, url: string, accept: string) =>
  attempt(what, () => (o.fetch ?? fetch)(url, { headers: { Authorization: `Bearer ${o.token}`, Accept: accept } })).pipe(
    Effect.filterOrFail(
      (r) => r.ok,
      (r) => new Upstream({ message: `${what}: GitHub answered ${r.status}` }),
    ),
  );

// The latest release and this Mac's dmg in it.
export function release(o: MacUpdate): Effect.Effect<Release, Upstream> {
  return Effect.gen(function* () {
    const what = "reading the release";
    const res = yield* get(o, what, `https://api.github.com/repos/${o.repo}/releases/latest`, "application/vnd.github+json");
    const body: unknown = yield* attempt(what, () => res.json());
    const version = (str(field(body, "tag_name")) ?? "").replace(/^v/, "");
    const name = macDmg(version, o.arch);
    const assets: unknown = field(body, "assets");
    const asset: unknown = Array.isArray(assets) ? assets.find((a) => field(a, "name") === name) : undefined;
    const url = str(field(asset, "url"));
    const digest = str(field(asset, "digest"));
    if (!url) return yield* Effect.fail(new Upstream({ message: `the release has no ${name}` }));
    if (!digest?.startsWith("sha256:")) return yield* Effect.fail(new Upstream({ message: `the release lists no checksum for ${name}` }));
    return { version, name, url, digest };
  });
}

// That dmg, into dir: refused unless it matches the checksum GitHub lists for it. Answers where it is.
export function download(o: MacUpdate, rel: Release, dir: string): Effect.Effect<string, Upstream> {
  return Effect.gen(function* () {
    const body = yield* get(o, "downloading the update", rel.url, "application/octet-stream");
    const bytes = Buffer.from(yield* attempt("downloading the update", () => body.arrayBuffer()));
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== rel.digest)
      return yield* Effect.fail(new Upstream({ message: `${rel.name} doesn't match the release's checksum` }));
    const dmg = path.join(dir, rel.name);
    yield* attempt("saving the update", () => fs.writeFile(dmg, bytes));
    return dmg;
  });
}

// The new app takes the old one's place; the old one goes back if that fails, and is deleted once it hasn't.
export function swap(bundle: string, staged: string): Effect.Effect<void, Upstream> {
  const old = aside(bundle, "old");
  return Effect.gen(function* () {
    yield* remove(old);
    yield* attempt("moving the old app aside", () => fs.rename(bundle, old));
    yield* attempt("moving the new app in", () => fs.rename(staged, bundle)).pipe(
      Effect.tapError(() => Effect.ignore(attempt("putting the old app back", () => fs.rename(old, bundle)))),
    );
    yield* remove(old);
  });
}

// The app kept beside the running one, and its version: null when there's none, or one cut short or tampered with.
const kept = (staged: string): Effect.Effect<string | null> =>
  exec("checking the new app", "codesign", ["--verify", "--deep", "--strict", staged]).pipe(
    Effect.andThen(
      exec("checking the new app", "plutil", [
        "-extract",
        "CFBundleShortVersionString",
        "raw",
        "-o",
        "-",
        path.join(staged, "Contents", "Info.plist"),
      ]),
    ),
    Effect.map((v) => v.trim()),
    Effect.orElseSucceed(() => null),
  );

// Downloads the latest release's app and keeps it beside the running one, where a restart of the app still finds it;
// one already there is kept as it is. Answers its version.
export function macFetch(o: MacUpdate): Effect.Effect<string, Upstream> {
  const staged = aside(o.bundle, "update");
  return Effect.gen(function* () {
    const rel = yield* release(o);
    if ((yield* kept(staged)) === rel.version) return rel.version;
    const tmp = yield* attempt("making room for the download", () => fs.mkdtemp(path.join(os.tmpdir(), "inbox-update-")));
    return yield* Effect.gen(function* () {
      const dmg = yield* download(o, rel, tmp);
      const mnt = path.join(tmp, "mnt");
      yield* remove(staged);
      yield* attempt("opening the dmg", () => fs.mkdir(mnt));
      yield* exec("opening the dmg", "hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mnt, dmg]);
      yield* Effect.gen(function* () {
        const app = (yield* attempt("reading the dmg", () => fs.readdir(mnt))).find((f) => f.endsWith(".app"));
        if (!app) return yield* Effect.fail(new Upstream({ message: "the dmg has no app in it" }));
        return yield* exec("copying the new app", "ditto", [path.join(mnt, app), staged]);
      }).pipe(Effect.ensuring(Effect.ignore(exec("closing the dmg", "hdiutil", ["detach", mnt, "-force"]))));
      // A copy cut short, or a dmg that isn't this release, is never kept.
      const said = yield* kept(staged);
      if (said !== rel.version)
        return yield* Effect.fail(
          new Upstream({ message: said ? `the dmg holds Inbox ${said}, not ${rel.version}` : "the new app didn't copy whole" }),
        );
      return rel.version;
    }).pipe(
      Effect.tapError(() => remove(staged)),
      Effect.ensuring(remove(tmp)),
    );
  });
}

// Replaces the running app with the one macFetch kept; the caller relaunches. Answers the new version.
export function macInstall(bundle: string): Effect.Effect<string, Upstream> {
  const staged = aside(bundle, "update");
  return Effect.gen(function* () {
    const version = yield* kept(staged);
    if (!version) return yield* Effect.fail(new Upstream({ message: "the downloaded update is gone" }));
    yield* swap(bundle, staged);
    return version;
  });
}
