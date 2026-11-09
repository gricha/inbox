// GitHub module: light search, batched details, daily context. Read only.

import { Effect, Result } from "effect";
import { buildAreas, type AreaPr } from "../areas.ts";
import type { GitHubRateLimited, GitHubReadError } from "../errors.ts";
import type { Areas, Check, Context, Item, Reviewer, ReviewState } from "../types.ts";
import { createClient, decode } from "./client.ts";
import { isBot, login, normalize, toChecks, toHit, type Actor, type RawCheck, type RawHit, type RawNode } from "./normalize.ts";
import {
  branchPrs as branchPrsQuery,
  DETAILS_REVIEW,
  detailsMine,
  FILES_SEARCH,
  LIGHT_SEARCH,
  LOOKUP,
  PR_CHECKS,
  PR_CONTEXT,
  REVIEWERS,
  TEAMS,
  VIEWER,
} from "./queries.ts";

export interface SearchHit {
  node_id: string;
  id: string;
  kind: "pr" | "issue";
  updated_at: string;
  author: string;
  author_bot?: boolean;
  title?: string; // untrusted
}
export interface NotificationThread {
  thread: string; // thread id
  item: string | null; // "owner/repo#123" for a PR or issue, else null
  reason: string; // review_requested, mention, team_mention, assign, author, comment, ...
  updated_at: string;
}
export interface NotificationPage {
  modified: boolean; // false when If-Modified-Since says nothing changed (a 304 costs no rate limit)
  threads: NotificationThread[];
  last_modified: string | null; // send back as If-Modified-Since
  poll_interval: number; // seconds GitHub asks clients to wait (X-Poll-Interval)
  date: string | null; // GitHub's clock
}
// One comment, review or reply; id and url are GitHub's for it.
interface Said {
  id: string;
  author: string;
  bot: boolean;
  body: string;
  at: string;
  url: string;
}
// A PR's conversation, for the review's conversation and Claude's read of it. Every text field is untrusted GitHub text.
export interface PrContext {
  threads: {
    id: string; // the review thread's node id: what a reply goes to
    resolved: boolean;
    outdated: boolean;
    path: string;
    line: number | null;
    side: "new" | "old"; // old: on a removed line, numbered in the old file
    hunk: string; // the diff the thread started on
    commit: string; // the last commit its last comment still applied to, "" if unknown
    comments: Said[];
  }[];
  reviews: (Said & { state: ReviewState })[];
  comments: Said[]; // on the PR itself
  commits: { oid: string; headline: string; at: string; author: string }[]; // the latest 20, oldest first; author: login, "" if unknown
}
export interface GitHub {
  viewer(): Effect.Effect<string, GitHubReadError>;
  search(query: string, max?: number): Effect.Effect<{ hits: SearchHit[]; total: number }, GitHubReadError>;
  // Missing/deleted nodes are skipped, and so is a batch that failed: only a rate limit fails the call.
  details(hits: SearchHit[], me: string): Effect.Effect<Item[], GitHubRateLimited>;
  context(me: string): Effect.Effect<Omit<Context, "refreshed_at">, GitHubReadError>; // teams, 90-day affinity, repo_prs, orgs
  areas(): Effect.Effect<Areas, GitHubReadError>; // the directories of your PRs and reviews, last 90 days
  // Threads updated since `since`, read or not. Read only: nothing is marked read.
  notifications(opts: { since: string | null; last_modified: string | null }): Effect.Effect<NotificationPage, GitHubReadError>;
  prContext(nodeId: string): Effect.Effect<PrContext, GitHubReadError>; // a PR's threads, reviews, comments and recent commits
  checks(nodeId: string): Effect.Effect<Check[], GitHubReadError>; // a PR's head commit's checks one by one, in GitHub's order
  // For stacks, PRs by exact branch in one repo: up, the PR whose head is the branch (the repo's own, not a fork's); down,
  // open PRs based on it. pr: the PR whose number `branch` holds, any state; none for an issue or a number not there.
  branchPrs(repo: string, probes: { dir: "up" | "down" | "pr"; branch: string }[]): Effect.Effect<SearchHit[], GitHubReadError>;
  lookup(repo: string, number: number): Effect.Effect<SearchHit | null, GitHubReadError>;
  // GitHub's suggestions first, then users, then teams
  reviewers(repo: string, number: number, q: string): Effect.Effect<Reviewer[], GitHubReadError>;
  rateLimit(): { remaining: number; reset_at: string } | null; // from the last response
}

type RawSaid = { id: string; author: Actor | null; body: string; createdAt: string; url: string };
interface RawPrContext {
  node: {
    reviewThreads?: {
      nodes: {
        id: string;
        isResolved: boolean;
        isOutdated: boolean;
        path: string;
        line: number | null;
        diffSide: "LEFT" | "RIGHT";
        hunk?: { nodes: { diffHunk: string }[] };
        comments: { nodes: (RawSaid & { commit?: { oid: string } | null })[] };
      }[];
    };
    reviews?: { nodes: (RawSaid & { state: string; submittedAt: string | null })[] };
    comments?: { nodes: RawSaid[] };
    history?: {
      nodes: {
        commit: { oid: string; messageHeadline: string; committedDate: string; author: { user: { login: string } | null } | null };
      }[];
    };
  } | null;
}

const said = (c: RawSaid, at = c.createdAt): Said => ({
  id: c.id,
  author: login(c.author),
  bot: isBot(c.author),
  body: c.body,
  at,
  url: c.url,
});

function parsePrContext(data: RawPrContext): PrContext {
  const n = data.node;
  return {
    threads: (n?.reviewThreads?.nodes ?? []).map((t) => ({
      id: t.id,
      resolved: t.isResolved,
      outdated: t.isOutdated,
      path: t.path,
      line: t.line,
      side: t.diffSide === "LEFT" ? "old" : "new",
      hunk: t.hunk?.nodes[0]?.diffHunk ?? "",
      commit: t.comments.nodes.at(-1)?.commit?.oid ?? "",
      comments: t.comments.nodes.map((c) => said(c)),
    })),
    reviews: (n?.reviews?.nodes ?? []).map((r) =>
      Object.assign(said(r, r.submittedAt ?? r.createdAt), { state: r.state.toLowerCase() as ReviewState }),
    ),
    comments: (n?.comments?.nodes ?? []).map((c) => said(c)),
    commits: (n?.history?.nodes ?? []).map(({ commit: c }) => ({
      oid: c.oid,
      headline: c.messageHeadline,
      at: c.committedDate,
      author: c.author?.user?.login ?? "",
    })),
  };
}
interface RawChecks {
  node: {
    commits?: {
      nodes: {
        commit: {
          statusCheckRollup: {
            contexts: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: (RawCheck | null)[] };
          } | null;
        };
      }[];
    };
  } | null;
}
interface RawThread {
  id: string;
  reason: string;
  updated_at: string;
  subject: { type: string; url: string | null };
}

const NOTIFICATION_PAGES = 5;

function threadItem(t: RawThread): string | null {
  if (t.subject.type !== "PullRequest" && t.subject.type !== "Issue") return null;
  const m = /\/repos\/([^/]+)\/([^/]+)\/(?:pulls|issues)\/(\d+)$/.exec(t.subject.url ?? "");
  return m ? `${m[1]}/${m[2]}#${m[3]}` : null;
}

interface SearchData {
  search: { issueCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ({ id?: string } | null)[] };
}
interface RawFiles {
  id: string;
  repository: { nameWithOwner: string };
  changedFiles: number;
  files: { nodes: { path: string }[] } | null;
}
type BranchNode = RawHit & { headRepository: { nameWithOwner: string } | null };
interface BranchData {
  // A page of PRs for up and down; one node for pr, {} when the number is an issue's.
  repository: Record<string, { nodes: (BranchNode | null)[] } | BranchNode | null> | null;
}
interface TeamsData {
  viewer: { name?: string | null; organizations: { nodes: ({ login: string; teams: { nodes: { slug: string }[] } } | null)[] } };
}

const RECENT = 20; // your latest PRs' titles, for the judge
const PROBES = 40; // stack probes (aliases) a query
const CHECK_PAGES = 5; // 100 checks a page: more than 500 on one commit aren't listed

const chunk = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

function tally(keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = (out[k] ?? 0) + 1;
  return out;
}

export function createGitHub(opts: { token?: string; fetch?: typeof fetch; log?: (msg: string) => void } = {}): GitHub {
  const client = createClient(opts);
  const log = (m: string) => opts.log?.(m);

  // A search's nodes, `per` a page, in whatever shape `doc` asks for.
  const pages = Effect.fnUntraced(function* (doc: string, q: string, max: number, per: number) {
    // Keyed by node id: cursors are offsets, so an item that moves between pages can come back twice.
    const nodes = new Map<string, unknown>();
    let total = 0;
    let after: string | null = null;
    while (nodes.size < max) {
      const data: SearchData = yield* client.query<SearchData>(doc, { q, first: Math.min(per, max - nodes.size), after });
      const page = yield* decode(() => {
        const { search: p } = data;
        for (const n of p.nodes) if (n?.id) nodes.set(n.id, n);
        return { total: p.issueCount, next: p.pageInfo.hasNextPage ? p.pageInfo.endCursor : null };
      });
      total = page.total;
      if (!page.next) break;
      after = page.next;
    }
    return { nodes: [...nodes.values()], total };
  });

  const search = Effect.fn("GitHub.search")(function* (q: string, max: number = 300) {
    const { nodes, total } = yield* pages(LIGHT_SEARCH, q, max, 100);
    return { hits: yield* decode(() => (nodes as RawHit[]).map(toHit)), total };
  });

  // A failed batch is skipped, not fatal: its items stay stale and are retried next sync. A rate limit stops them all.
  const batch = Effect.fnUntraced(
    function* (b: { mine: boolean; ids: string[] }, now: string) {
      const data = b.mine
        ? yield* client.query<Record<string, RawNode | null>>(
            detailsMine(b.ids.length),
            Object.fromEntries(b.ids.map((id, i) => [`id${i}`, id])),
          )
        : yield* client.query<{ nodes: (RawNode | null)[] }>(DETAILS_REVIEW, { ids: b.ids });
      // normalize is pure: a node it can't read fails its batch, not the sync.
      return yield* decode(() => {
        const nodes = b.mine
          ? b.ids.map((_, i) => (data as Record<string, RawNode | null>)[`n${i}`] ?? null)
          : (data as { nodes: (RawNode | null)[] }).nodes;
        return nodes.filter((n) => n !== null).map((n) => normalize(n, now));
      });
    },
    (effect, b) =>
      effect.pipe(
        Effect.catch((e) =>
          e._tag === "GitHubRateLimited"
            ? Effect.fail(e)
            : Effect.sync((): Item[] => {
                log(`details batch of ${b.ids.length} failed: ${e.message}`);
                return [];
              }),
        ),
      ),
  );

  const details = Effect.fn("GitHub.details")(function* (hits: SearchHit[], me: string) {
    const unique = [...new Map(hits.map((h) => [h.node_id, h])).values()];
    const isMine = (h: SearchHit) => h.kind === "pr" && h.author.toLowerCase() === me.toLowerCase();
    const batches = [
      ...chunk(unique.filter(isMine), 5).map((b) => ({ mine: true, ids: b.map((h) => h.node_id) })),
      ...chunk(
        unique.filter((h) => !isMine(h)),
        20,
      ).map((b) => ({ mine: false, ids: b.map((h) => h.node_id) })),
    ];
    const now = new Date().toISOString();
    const results = yield* Effect.forEach(batches, (b) => batch(b, now), { concurrency: 3 });
    return results.flat();
  });

  const context = Effect.fn("GitHub.context")(function* (me: string) {
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    // Keep whatever parts succeed; a failed part comes back empty and is logged.
    const settled = yield* Effect.all(
      {
        teams: client.query<TeamsData>(TEAMS, { me }),
        reviewed: search(`is:pr reviewed-by:@me -author:@me updated:>=${since}`, 1000),
        commented: search(`is:pr commenter:@me -author:@me updated:>=${since}`, 1000),
        authored: search(`is:pr author:@me created:>=${since}`, 1000),
        involved: search("is:open involves:@me", 300),
      },
      { concurrency: "unbounded", mode: "result" },
    );
    const parts: Result.Result<unknown, GitHubReadError>[] = Object.values(settled);
    const failed = parts.flatMap((r) => (Result.isFailure(r) ? [r.failure] : []));
    const [first] = failed;
    if (first && failed.length === parts.length) return yield* Effect.fail(first);
    for (const e of failed) log(`context: ${e.message}`);
    const ok = <T, E>(r: Result.Result<T, E>, empty: T) => (Result.isSuccess(r) ? r.success : empty);
    const none = { hits: [] as SearchHit[], total: 0 };
    const teams = ok(settled.teams, { viewer: { organizations: { nodes: [] } } });
    const reviewed = ok(settled.reviewed, none);
    const commented = ok(settled.commented, none);
    const authored = ok(settled.authored, none);
    const involved = ok(settled.involved, none);
    const engaged = new Map<string, Set<string>>();
    for (const h of [...reviewed.hits, ...commented.hits]) {
      if (h.author_bot) continue;
      if (!engaged.has(h.author)) engaged.set(h.author, new Set());
      engaged.get(h.author)!.add(h.node_id);
    }
    const latest = authored.hits.toSorted((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, RECENT);
    return yield* decode(() => ({
      me,
      name: teams.viewer.name ?? "",
      teams: [...new Set(teams.viewer.organizations.nodes.flatMap((o) => o?.teams.nodes.map((t) => t.slug) ?? []))],
      affinity: Object.fromEntries([...engaged].map(([author, prs]) => [author, prs.size])),
      repo_prs: tally(authored.hits.map((h) => h.id.split("#")[0] ?? "")),
      orgs: tally(involved.hits.map((h) => h.id.split("/")[0] ?? "")),
      recent: latest.map((h) => h.title ?? "").filter(Boolean),
    }));
  });

  const areas = Effect.fn("GitHub.areas")(function* () {
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    const prs = (q: string, authored: boolean) =>
      pages(FILES_SEARCH, `is:pr ${q}`, 500, 50).pipe(
        Effect.flatMap(({ nodes }) =>
          decode((): AreaPr[] =>
            (nodes as RawFiles[]).map((n) => ({
              repo: n.repository.nameWithOwner,
              files: n.changedFiles,
              paths: n.files?.nodes.map((f) => f.path) ?? [],
              authored,
            })),
          ),
        ),
      );
    const found = yield* Effect.all(
      [
        prs(`author:@me created:>=${since}`, true),
        prs(`author:@me merged:>=${since} created:<${since}`, true),
        prs(`reviewed-by:@me -author:@me updated:>=${since}`, false),
      ],
      { concurrency: "unbounded" },
    );
    return buildAreas(found.flat());
  });

  const branchPrs = Effect.fn("GitHub.branchPrs")(function* (repo: string, probes: { dir: "up" | "down" | "pr"; branch: string }[]) {
    const [owner, name] = repo.split("/");
    const out = new Map<string, SearchHit>();
    for (const part of chunk(probes, PROBES)) {
      const vars = Object.fromEntries(part.map((p, i) => [`b${i}`, p.dir === "pr" ? Number(p.branch) : p.branch]));
      const data = yield* client.query<BranchData>(branchPrsQuery(part.map((p) => p.dir)), { owner, name, ...vars });
      yield* decode(() => {
        part.forEach((p, i) => {
          const got = data.repository?.[`p${i}`];
          for (const n of !got ? [] : "nodes" in got ? got.nodes : [got]) {
            if (!n?.id || (p.dir === "up" && n.headRepository?.nameWithOwner.toLowerCase() !== repo.toLowerCase())) continue;
            out.set(n.id, toHit(n));
          }
        });
      });
    }
    return [...out.values()];
  });

  const lookup = Effect.fn("GitHub.lookup")(function* (repo: string, number: number) {
    const [owner, name] = repo.split("/");
    const data = yield* client.query<{ repository: { issueOrPullRequest: RawHit | null } | null }>(LOOKUP, { owner, name, number });
    return yield* decode(() => {
      const n = data.repository?.issueOrPullRequest;
      return n ? toHit(n) : null;
    });
  });

  const reviewers = Effect.fn("GitHub.reviewers")(function* (repo: string, number: number, q: string) {
    const [owner, name] = repo.split("/");
    type U = { id: string; login: string; name: string | null };
    const data = yield* client.query<{
      repository: { pullRequest: { suggestedReviewers: { reviewer: U }[] } | null; assignableUsers: { nodes: U[] } } | null;
      organization: { teams: { nodes: { id: string; slug: string; name: string }[] } } | null;
    }>(REVIEWERS, { owner, name, number, q: q || null });
    return yield* decode(() => {
      const user = (u: U, suggested: boolean): Reviewer => ({ id: u.id, login: u.login, name: u.name ?? "", team: false, suggested });
      const needle = q.toLowerCase();
      const suggested = (data.repository?.pullRequest?.suggestedReviewers ?? [])
        .map((s) => user(s.reviewer, true))
        .filter((r) => !needle || r.login.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle));
      const users = (data.repository?.assignableUsers.nodes ?? []).map((u) => user(u, false));
      const teams = (data.organization?.teams.nodes ?? []).map((t) => ({
        id: t.id,
        login: t.slug,
        name: t.name,
        team: true,
        suggested: false,
      }));
      const out = new Map<string, Reviewer>();
      for (const r of [...suggested, ...users, ...teams]) if (!out.has(r.id)) out.set(r.id, r);
      return [...out.values()];
    });
  });

  const checks = Effect.fn("GitHub.checks")(function* (id: string) {
    const raw: RawCheck[] = [];
    let after: string | null = null;
    for (let page = 0; page < CHECK_PAGES; page++) {
      const data: RawChecks = yield* client.query<RawChecks>(PR_CHECKS, { id, after });
      const next = yield* decode(() => {
        const got = data.node?.commits?.nodes[0]?.commit.statusCheckRollup?.contexts;
        for (const c of got?.nodes ?? []) if (c) raw.push(c);
        return got?.pageInfo.hasNextPage ? got.pageInfo.endCursor : null;
      });
      if (!next) break;
      after = next;
    }
    return yield* decode(() => toChecks(raw));
  });

  const notifications = Effect.fn("GitHub.notifications")(function* (feed: { since: string | null; last_modified: string | null }) {
    const threads: NotificationThread[] = [];
    const head = (h: Headers, modified: boolean): NotificationPage => ({
      modified,
      threads,
      last_modified: h.get("last-modified"),
      poll_interval: Number(h.get("x-poll-interval")) || 60,
      date: h.get("date"),
    });
    let first: NotificationPage | null = null;
    for (let page = 1; page <= NOTIFICATION_PAGES; page++) {
      const q = new URLSearchParams({ all: "true", per_page: "50", page: String(page) });
      if (feed.since) q.set("since", feed.since);
      const conditional = page === 1 && feed.last_modified ? { "if-modified-since": feed.last_modified } : undefined;
      const r = yield* client.get(`/notifications?${q.toString()}`, { headers: conditional });
      first ??= head(r.headers, r.status !== 304);
      if (r.status === 304) break;
      const more = yield* decode(() => {
        const list = r.data as RawThread[];
        for (const t of list) threads.push({ thread: t.id, item: threadItem(t), reason: t.reason, updated_at: t.updated_at });
        return list.length >= 50;
      });
      if (!more) break;
    }
    return first ?? head(new Headers(), false);
  });

  return {
    viewer: () => client.query<{ viewer: { login: string } }>(VIEWER).pipe(Effect.flatMap((d) => decode(() => d.viewer.login))),
    search,
    details,
    context,
    areas,
    notifications,
    prContext: (id) => client.query<RawPrContext>(PR_CONTEXT, { id }).pipe(Effect.flatMap((d) => decode(() => parsePrContext(d)))),
    checks,
    branchPrs,
    lookup,
    reviewers,
    rateLimit: () => client.rateLimit(),
  };
}
