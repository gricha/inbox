// The Mac's own update: Squirrel.Mac refuses an ad hoc signed build, so the release's dmg is swapped in for the running
// app here. No electron import, so node --test can load it.
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
const remove = (p: string) => Effect.ignore(attempt("clearing up", () => fs.rm(p, { recursive: true, force: true })));
// Beside the app, so moving it into place is a rename on one volume.
const aside = (bundle: string, what: string) => path.join(path.dirname(bundle), `.${path.basename(bundle)}.${what}`);

// The latest release's dmg for this Mac, into dir: refused unless it matches the checksum GitHub lists for it.
export function download(o: MacUpdate, dir: string): Effect.Effect<{ dmg: string; version: string }, Upstream> {
  const get = (what: string, url: string, accept: string) =>
    attempt(what, () => (o.fetch ?? fetch)(url, { headers: { Authorization: `Bearer ${o.token}`, Accept: accept } })).pipe(
      Effect.filterOrFail(
        (r) => r.ok,
        (r) => new Upstream({ message: `${what}: GitHub answered ${r.status}` }),
      ),
    );
  return Effect.gen(function* () {
    const res = yield* get("reading the release", `https://api.github.com/repos/${o.repo}/releases/latest`, "application/vnd.github+json");
    const release: unknown = yield* attempt("reading the release", () => res.json());
    const version = (str(field(release, "tag_name")) ?? "").replace(/^v/, "");
    const name = macDmg(version, o.arch);
    const assets: unknown = field(release, "assets");
    const asset: unknown = Array.isArray(assets) ? assets.find((a) => field(a, "name") === name) : undefined;
    const url = str(field(asset, "url"));
    const digest = str(field(asset, "digest"));
    if (!url) return yield* Effect.fail(new Upstream({ message: `the release has no ${name}` }));
    if (!digest?.startsWith("sha256:")) return yield* Effect.fail(new Upstream({ message: `the release lists no checksum for ${name}` }));
    const body = yield* get("downloading the update", url, "application/octet-stream");
    const bytes = Buffer.from(yield* attempt("downloading the update", () => body.arrayBuffer()));
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== digest)
      return yield* Effect.fail(new Upstream({ message: `${name} doesn't match the release's checksum` }));
    const dmg = path.join(dir, name);
    yield* attempt("saving the update", () => fs.writeFile(dmg, bytes));
    return { dmg, version };
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

// Downloads the latest release and replaces the running app with it; the caller relaunches. Answers the new version.
export function macUpdate(o: MacUpdate): Effect.Effect<string, Upstream> {
  const staged = aside(o.bundle, "update");
  return Effect.gen(function* () {
    const tmp = yield* attempt("making room for the download", () => fs.mkdtemp(path.join(os.tmpdir(), "inbox-update-")));
    return yield* Effect.gen(function* () {
      const got = yield* download(o, tmp);
      const mnt = path.join(tmp, "mnt");
      yield* remove(staged);
      yield* attempt("opening the dmg", () => fs.mkdir(mnt));
      yield* exec("opening the dmg", "hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mnt, got.dmg]);
      yield* Effect.gen(function* () {
        const app = (yield* attempt("reading the dmg", () => fs.readdir(mnt))).find((f) => f.endsWith(".app"));
        if (!app) return yield* Effect.fail(new Upstream({ message: "the dmg has no app in it" }));
        return yield* exec("copying the new app", "ditto", [path.join(mnt, app), staged]);
      }).pipe(Effect.ensuring(Effect.ignore(exec("closing the dmg", "hdiutil", ["detach", mnt, "-force"]))));
      // A copy cut short, or a dmg that isn't this release, never replaces the app.
      yield* exec("checking the new app", "codesign", ["--verify", "--deep", "--strict", staged]);
      const plist = path.join(staged, "Contents", "Info.plist");
      const said = (yield* exec("checking the new app", "plutil", [
        "-extract",
        "CFBundleShortVersionString",
        "raw",
        "-o",
        "-",
        plist,
      ])).trim();
      if (said !== got.version) return yield* Effect.fail(new Upstream({ message: `the dmg holds Inbox ${said}, not ${got.version}` }));
      yield* swap(o.bundle, staged);
      return got.version;
    }).pipe(Effect.ensuring(Effect.andThen(remove(staged), remove(tmp))));
  });
}
