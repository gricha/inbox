// Whether a newer Inbox is out: the packaged app's version against the latest GitHub Release, read with the owner's
// token (the repo is private), and the install the app does itself where it can.
import { Effect } from "effect";
import { Conflict, type GitHubReadError, type Upstream } from "./errors.ts";
import type { Runner } from "./runner.ts";
import type { UpdateView } from "./types.ts";

// Where `npm run release` tags and .github/workflows/release.yml publishes; build.publish in package.json says the same.
export const RELEASES = { owner: "gricha", repo: "inbox" } as const;

const CHECK_EVERY = 6 * 60 * 60_000;

// The packaged app running this desk: its version, and its install where electron-updater can replace the build in place.
export interface AppUpdater {
  version: string;
  install?: () => Effect.Effect<void, Upstream>; // downloads the release and restarts into it; it never returns once it has
}

// x.y.z, a leading v allowed; anything after a "-" (a prerelease) sorts before the release itself.
function parseVersion(v: string): [number, number, number, boolean] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), !!m[4]] : null;
}

export function newer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (const i of [0, 1, 2] as const) if (a[i] !== b[i]) return a[i] > b[i];
  return b[3] && !a[3];
}

export class Updates {
  private readonly latestRelease: () => Effect.Effect<{ tag: string; url: string } | null, GitHubReadError>;
  private readonly app: AppUpdater | null;
  private readonly runner: Runner;
  private readonly log: (m: string) => void;
  private readonly changed: () => void;
  private latest: { version: string; url: string } | null = null;
  private installing = false;
  private error: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: {
    latest: () => Effect.Effect<{ tag: string; url: string } | null, GitHubReadError>;
    app: AppUpdater | null;
    runner: Runner;
    log: (m: string) => void;
    changed: () => void;
  }) {
    this.latestRelease = opts.latest;
    this.app = opts.app;
    this.runner = opts.runner;
    this.log = opts.log;
    this.changed = opts.changed;
  }

  // Only the packaged app's desk asks GitHub: a checkout's main is live, and desk serve has no build to replace.
  start(): void {
    if (!this.app || this.timer) return;
    const check = () => {
      this.runner.fork("checking for an update", this.check());
    };
    check();
    this.timer = setInterval(check, CHECK_EVERY);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // What fails (GitHub down, the rate limit) is logged and the last release known kept: the next check asks again.
  check(): Effect.Effect<void> {
    return this.latestRelease().pipe(
      Effect.flatMap((r) =>
        Effect.sync(() => {
          this.found(r);
        }),
      ),
      Effect.catch((e) =>
        Effect.sync(() => {
          this.log(`checking for an update: ${e.message}`);
        }),
      ),
    );
  }

  private found(r: { tag: string; url: string } | null): void {
    if (!r || !parseVersion(r.tag)) return;
    const latest = { version: r.tag.replace(/^v/, ""), url: r.url };
    if (latest.version === this.latest?.version) return;
    this.latest = latest;
    if (this.app && newer(latest.version, this.app.version)) this.log(`Inbox ${latest.version} is out (this is ${this.app.version})`);
    this.changed();
  }

  view(): UpdateView | null {
    if (!this.app) return null;
    const latest = this.latest;
    return {
      current: this.app.version,
      latest: latest?.version ?? null,
      url: latest?.url ?? null,
      available: !!latest && newer(latest.version, this.app.version),
      install: !!this.app.install && !this.error,
      installing: this.installing,
      error: this.error,
    };
  }

  // The app downloads the release and restarts into it; what fails is said on the line, which then links to the release.
  install(): Effect.Effect<UpdateView, Conflict> {
    return Effect.suspend(() => {
      const v = this.view();
      const run = this.app?.install;
      if (!v?.available) return Effect.fail(new Conflict({ message: "Inbox is up to date" }));
      if (!run || !v.install)
        return Effect.fail(new Conflict({ message: `This app can't update itself: get Inbox ${v.latest} from ${v.url}` }));
      if (this.installing) return Effect.succeed(v);
      this.installing = true;
      this.log(`updating to Inbox ${v.latest}`);
      this.runner.fork(
        "updating",
        // Done, the app is quitting into the new build: it stays installing until then.
        run().pipe(
          Effect.catch((e) =>
            Effect.sync(() => {
              this.error = e.message;
              this.installing = false;
              this.log(`updating to Inbox ${v.latest} failed: ${e.message}`);
              this.changed();
            }),
          ),
        ),
      );
      this.changed();
      return Effect.succeed(this.view()!);
    });
  }
}

// npm run release's argument: x.y.z (a leading v allowed) past the current version, or why not.
export function releaseVersion(arg: string | undefined, current: string): { version: string } | { refused: string } {
  const v = parseVersion(arg ?? "");
  if (!arg || !v || v[3]) return { refused: `usage: npm run release <x.y.z>, e.g. npm run release ${bump(current)}` };
  const version = arg.trim().replace(/^v/, "");
  if (!newer(version, current)) return { refused: `${version} isn't past ${current}, the version now` };
  return { version };
}

const bump = (current: string): string => {
  const v = parseVersion(current);
  return v ? `${v[0]}.${v[1] + 1}.0` : "0.1.0";
};
