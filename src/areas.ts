// The code you work in: directories from your recent PRs and reviews, per repo, and which of them a PR touches.
import type { Areas, Context, Item } from "./types.ts";

const DEPTH = 3; // src/sentry/auth/
const KEEP = 40; // per repo
const AUTHORED = 3; // a PR you wrote counts this many reviews
const MIN = 2; // one review alone doesn't make a directory yours
const MASS = 100; // changed files past which a PR (a codemod, a rename) says nothing about where you work

export interface AreaPr {
  repo: string;
  files: number; // changed files, all of them
  paths: string[];
  authored: boolean;
}

// "src/sentry/auth/models.py" -> "src/sentry/auth/"; a top-level file -> "".
export function dirOf(path: string): string {
  const parts = path.split("/").slice(0, -1).slice(0, DEPTH);
  return parts.length ? `${parts.join("/")}/` : "";
}

// Each PR adds its weight once per directory it changes; the top KEEP per repo stay.
export function buildAreas(prs: AreaPr[]): Areas {
  const repos = new Map<string, Map<string, number>>();
  for (const pr of prs) {
    if (pr.files > MASS) continue;
    const repo = pr.repo.toLowerCase();
    const dirs = repos.get(repo) ?? new Map<string, number>();
    repos.set(repo, dirs);
    for (const d of new Set(pr.paths.map(dirOf))) if (d) dirs.set(d, (dirs.get(d) ?? 0) + (pr.authored ? AUTHORED : 1));
  }
  const out: Areas = {};
  for (const [repo, dirs] of repos) {
    const top = [...dirs].filter(([, w]) => w >= MIN).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (top.length) out[repo] = Object.fromEntries(top.slice(0, KEEP));
  }
  return out;
}

type Known = Pick<Context, "areas"> | null;
type Pr = Pick<Item, "repo" | "paths">;

const mineIn = (ctx: Known, repo: string) => ctx?.areas?.[repo.toLowerCase()] ?? {};

// Your areas in a repo, heaviest first; [] when you have none there or they aren't known yet.
export function areasFor(ctx: Known, repo: string): { dir: string; weight: number }[] {
  return Object.entries(mineIn(ctx, repo))
    .map(([dir, weight]) => ({ dir, weight }))
    .sort((a, b) => b.weight - a.weight);
}

// How many of a PR's paths are in your areas there; -1 while its paths or your areas aren't known.
export function areaFiles(item: Pr, ctx: Known): number {
  if (!item.paths || !ctx?.areas) return -1;
  const mine = mineIn(ctx, item.repo);
  return item.paths.filter((p) => Object.hasOwn(mine, dirOf(p))).length;
}

export interface Touch {
  dir: string; // "src/sentry/auth/", or "/" for files at the top
  files: number;
  mine: boolean; // one of your areas
}

// The directories a PR changes, yours first, then by files; null while its paths or your areas aren't known.
export function touched(item: Pr, ctx: Known): Touch[] | null {
  if (!item.paths || !ctx?.areas) return null;
  const mine = mineIn(ctx, item.repo);
  const out = new Map<string, Touch>();
  for (const p of item.paths) {
    const dir = dirOf(p) || "/";
    const t = out.get(dir) ?? { dir, files: 0, mine: Object.hasOwn(mine, dir) };
    t.files++;
    out.set(dir, t);
  }
  return [...out.values()].sort((a, b) => Number(b.mine) - Number(a.mine) || b.files - a.files || a.dir.localeCompare(b.dir));
}
