// npm run release 0.2.0: package.json and package-lock.json at 0.2.0, committed on main and tagged v0.2.0, all local.
// npm run release:publish v0.2.0 then builds every platform on this Mac and publishes the GitHub Release.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { Cause, Data, Effect, Exit } from "effect";
import { messageOf } from "../src/errors.ts";
import { releaseVersion } from "../src/updates.ts";

class Refused extends Data.TaggedError("Refused")<{ readonly message: string }> {}

const git = (...args: string[]) =>
  Effect.try({
    try: () => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(),
    catch: (cause) => new Refused({ message: `git ${args.join(" ")}: ${messageOf(cause)}` }),
  });

const readJson = (file: string) =>
  Effect.try({
    try: () => JSON.parse(fs.readFileSync(file, "utf8")) as { version: string; packages?: Record<string, { version?: string }> },
    catch: (cause) => new Refused({ message: `reading ${file}: ${messageOf(cause)}` }),
  });

const writeJson = (file: string, data: unknown) =>
  Effect.try({
    try: () => {
      fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    },
    catch: (cause) => new Refused({ message: `writing ${file}: ${messageOf(cause)}` }),
  });

const release = Effect.gen(function* () {
  const pkg = yield* readJson("package.json");
  const asked = releaseVersion(process.argv[2], pkg.version);
  if ("refused" in asked) return yield* new Refused({ message: asked.refused });
  const { version } = asked;
  const tag = `v${version}`;
  if ((yield* git("rev-parse", "--abbrev-ref", "HEAD")) !== "main") return yield* new Refused({ message: "release from main" });
  if (yield* git("status", "--porcelain")) return yield* new Refused({ message: "commit or stash your changes first" });
  if (yield* git("tag", "--list", tag)) return yield* new Refused({ message: `${tag} is already a tag` });
  const lock = yield* readJson("package-lock.json");
  pkg.version = version;
  lock.version = version;
  const root = lock.packages?.[""];
  if (root) root.version = version;
  yield* writeJson("package.json", pkg);
  yield* writeJson("package-lock.json", lock);
  yield* git(
    "commit",
    "--quiet",
    "-m",
    `Inbox ${version}: package.json at ${version} for the ${tag} release`,
    "package.json",
    "package-lock.json",
  );
  yield* git("tag", "-a", tag, "-m", `Inbox ${version}`);
  return tag;
});

// The boundary: what it refused ends the run with its words and exit 1.
const exit = await Effect.runPromiseExit(release);
if (Exit.isSuccess(exit)) console.log(`Committed and tagged ${exit.value}. To publish it: npm run release:publish ${exit.value}`);
else {
  const err = Cause.squash(exit.cause);
  console.error(`release: ${err instanceof Refused ? err.message : Cause.pretty(exit.cause)}`);
  process.exitCode = 1;
}
