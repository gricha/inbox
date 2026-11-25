// A PR's head checked out for its AI review to read: a bare clone under the desk's home, borrowing your local clone's objects
// (--shared, your clone untouched) or, without one or with a shallow or partial one, cloned from GitHub (blobless); the head
// fetched into it when it lacks it; and a worktree per review, removed when the review is done.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Effect, Semaphore } from "effect";
import { messageOf, NoCheckout } from "./errors.ts";
import { findClone } from "./issue.ts";
import { runCommand } from "./review.ts";
import type { Item } from "./types.ts";

export interface Checkout {
  dir: string;
  done: Effect.Effect<void>; // removes it
}

const GIT_MISSING = "git not found: install git so git runs from your PATH";
// gh's login for a private repo, whatever git helper you have; no LFS downloads, which a read doesn't need.
const AUTH = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];
const ENV = { GIT_LFS_SKIP_SMUDGE: "1", GIT_TERMINAL_PROMPT: "0" };
const STALE_MS = 3 * 60 * 60_000; // a checkout a crash left behind
const locks = new Map<string, Semaphore.Semaphore>(); // one git at a time in each bare clone
const told = new Set<string>(); // repos whose clone the log said isn't borrowed

const git = (args: string[], cwd: string, timeout = 120_000) =>
  runCommand({ file: "git", args, shell: false }, { cwd, timeout, missing: GIT_MISSING, env: ENV });
// Named with --git-dir, not found from its folder: a git with safe.bareRepository=explicit opens no other bare repo.
const inBare = (bare: string, args: string[], timeout?: number) => git(["--git-dir", bare, ...args], path.dirname(bare), timeout);

export const prCheckout = (
  home: string,
  clone: string | null, // yours, or none: the desk clones it from GitHub
  item: Pick<Item, "repo" | "number" | "head_oid">,
  remote = `https://github.com/${item.repo}.git`,
) => {
  const name = item.repo.replace("/", "__");
  // Absolute, since git runs these paths from other folders.
  const bare = path.resolve(home, "repos", `${name}.git`);
  const out = path.resolve(home, "checkouts");
  let lock = locks.get(bare);
  if (!lock) locks.set(bare, (lock = Semaphore.makeUnsafe(1)));
  return lock.withPermits(1)(
    Effect.gen(function* () {
      // A bare clone whose borrowed objects are gone (your clone moved) is made again.
      const alt = path.join(bare, "objects", "info", "alternates");
      const lent = fs.existsSync(alt) ? fs.readFileSync(alt, "utf8").trim() : "";
      if (lent && !fs.existsSync(lent)) fs.rmSync(bare, { recursive: true, force: true });
      if (!fs.existsSync(path.join(bare, "HEAD"))) {
        fs.mkdirSync(path.dirname(bare), { recursive: true });
        const from = clone ? ["--shared", clone] : ["--filter=blob:none", remote];
        yield* git([...AUTH, "clone", "--bare", "--quiet", ...from, bare], path.dirname(bare), 1_800_000);
      }
      const has = yield* inBare(bare, ["cat-file", "-e", `${item.head_oid}^{commit}`]).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (!has)
        yield* inBare(
          bare,
          [...AUTH, "fetch", "--quiet", "--no-tags", remote, `+refs/pull/${item.number}/head:refs/inbox/pr/${item.number}`],
          600_000,
        );
      fs.mkdirSync(out, { recursive: true });
      for (const d of fs.readdirSync(out)) {
        const p = path.join(out, d);
        if (Date.now() - fs.statSync(p).mtimeMs > STALE_MS) fs.rmSync(p, { recursive: true, force: true });
      }
      yield* inBare(bare, ["worktree", "prune"]);
      const dir = path.join(out, `${name}-${item.number}-${randomBytes(4).toString("hex")}`);
      // A blobless clone fetches the files it checks out.
      yield* inBare(bare, [...AUTH, "worktree", "add", "--detach", "--quiet", dir, item.head_oid], 1_800_000);
      const done = inBare(bare, ["worktree", "remove", "--force", dir]).pipe(
        Effect.ignore,
        Effect.andThen(
          Effect.sync(() => {
            fs.rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
      return { dir, done } satisfies Checkout;
    }),
  );
};

// git can't clone from a clone that lacks history or file contents, so only a full one lends its objects.
const unborrowable = (clone: string) =>
  Effect.gen(function* () {
    const shallow = yield* git(["rev-parse", "--is-shallow-repository"], clone);
    if (shallow.trim() === "true") return "it's shallow";
    const promisor = yield* git(["config", "--get-regexp", String.raw`^remote\..*\.promisor$`], clone).pipe(
      Effect.orElseSucceed(() => ""), // exits 1 when there's none
    );
    return promisor.trim() ? "it's partial" : null;
  });

// The PR's head from your clone of its repo, or GitHub's, or why not, in words its review shows.
export const checkoutFor = (
  home: string,
  item: Pick<Item, "repo" | "number" | "head_oid">,
  find: (repo: string) => string | null = findClone,
  remote?: string,
  log: (m: string) => void = console.error,
): Effect.Effect<Checkout, NoCheckout> => {
  const found = find(item.repo);
  const failed = (clone: string | null) => (cause: unknown) =>
    new NoCheckout({
      message: `couldn't check out this PR's head ${clone ? `from your clone at ${clone}` : "from GitHub"}: ${messageOf(cause)}`,
      cause,
    });
  const from = (clone: string | null) =>
    prCheckout(home, clone, item, remote).pipe(
      Effect.mapError(failed(clone)),
      Effect.catchDefect((bug) => Effect.fail(failed(clone)(bug))), // a folder it couldn't make or read
    );
  if (!found) return from(null);
  return unborrowable(found).pipe(
    Effect.mapError(failed(found)),
    Effect.flatMap((why) => {
      if (!why) return from(found);
      if (!told.has(item.repo)) {
        told.add(item.repo);
        log(`${item.repo}: reviews check out from GitHub, not your clone at ${found}: ${why}`);
      }
      return from(null);
    }),
  );
};
