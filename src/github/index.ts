// GitHub module: light search, batched details, daily context. Read only.

import { buildAreas, type AreaPr } from "../areas.ts";
import type { Areas, Context, Item, ReviewState } from "../types.ts";
import { createClient, RateLimitedError } from "./client.ts";
import { checkFailed, checkName, collaborator, normalize, toHit, type RawCheck, type RawHit, type RawNode } from "./normalize.ts";
import {
  branchPrs as branchPrsQuery,
  DETAILS_REVIEW,
  detailsMine,
  FILES_SEARCH,
  LIGHT_SEARCH,
  PR_CONTEXT,
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
// A PR's conversation and failing checks, for a babysitter's prompt. Every text field is untrusted GitHub text.
export interface PrContext {
  threads: {
    id: string; // the review thread's node id: what a reply goes to
    resolved: boolean;
    outdated: boolean;
    path: string;
    line: number | null;
    comments: { author: string; bot: boolean; trusted: boolean; body: string; at: string }[];
  }[];
  // trusted: a collaborator on the repo (OWNER, MEMBER, COLLABORATOR); only their words reach a babysitter.
  reviews: { author: string; bot: boolean; trusted: boolean; state: ReviewState; body: string; at: string }[];
  comments: { author: string; bot: boolean; trusted: boolean; body: string; at: string }[]; // on the PR itself
  checks: { name: string; job_id: number | null; app: string; url: string; summary: string }[]; // the failing ones
}

export interface GitHub {
  viewer(): Promise<string>;
  search(query: string, max?: number): Promise<{ hits: SearchHit[]; total: number }>;
  details(hits: SearchHit[], me: string): Promise<Item[]>; // missing/deleted nodes are skipped
  context(me: string): Promise<Omit<Context, "refreshed_at">>; // teams, 90-day affinity, repo_prs, orgs
  areas(): Promise<Areas>; // the directories of your PRs and reviews, last 90 days
  // Threads updated since `since`, read or not. Read only: nothing is marked read.
  notifications(opts: { since: string | null; last_modified: string | null }): Promise<NotificationPage>;
  prContext(nodeId: string): Promise<PrContext>; // a PR's threads, reviews, comments and failing checks
  // For stacks, PRs by exact branch in one repo: up, the PR whose head is the branch (the repo's own, not a fork's); down,
  // open PRs based on it.
  branchPrs(repo: string, probes: { dir: "up" | "down"; branch: string }[]): Promise<SearchHit[]>;
  rateLimit(): { remaining: number; reset_at: string } | null; // from the last response
}

interface Author {
  __typename?: string;
  login: string;
}
interface Assoc {
  authorAssociation?: string;
}
interface RawPrContext {
  node: {
    reviewThreads?: {
      nodes: {
        id: string;
        isResolved: boolean;
        isOutdated: boolean;
        path: string;
        line: number | null;
        comments: { nodes: ({ author: Author | null; body: string; createdAt: string } & Assoc)[] };
      }[];
    };
    reviews?: {
      nodes: ({ author: Author | null; state: string; body: string; submittedAt: string | null; createdAt: string } & Assoc)[];
    };
    comments?: { nodes: ({ author: Author | null; body: string; createdAt: string } & Assoc)[] };
    commits?: {
      nodes: {
        commit: {
          statusCheckRollup: {
            contexts: {
              nodes: (
                | (RawCheck & {
                    databaseId?: number | null;
                    detailsUrl?: string | null;
                    title?: string | null;
                    summary?: string | null;
                    description?: string | null;
                    targetUrl?: string | null;
                    checkSuite?: { app: { slug: string } | null } | null;
                  })
                | null
              )[];
            };
          } | null;
        };
      }[];
    };
  } | null;
}

const who = (a: Author | null, assoc: Assoc) => ({
  author: a?.login ?? "ghost",
  bot: a?.__typename === "Bot" || !!a?.login.endsWith("[bot]"),
  trusted: collaborator(assoc.authorAssociation),
});

function parsePrContext(data: RawPrContext): PrContext {
  const n = data.node;
  const checks = n?.commits?.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  return {
    threads: (n?.reviewThreads?.nodes ?? []).map((t) => ({
      id: t.id,
      resolved: t.isResolved,
      outdated: t.isOutdated,
      path: t.path,
      line: t.line,
      comments: t.comments.nodes.map((c) => Object.assign(who(c.author, c), { body: c.body, at: c.createdAt })),
    })),
    reviews: (n?.reviews?.nodes ?? []).map((r) =>
      Object.assign(who(r.author, r), { state: r.state.toLowerCase() as ReviewState, body: r.body, at: r.submittedAt ?? r.createdAt }),
    ),
    comments: (n?.comments?.nodes ?? []).map((c) => Object.assign(who(c.author, c), { body: c.body, at: c.createdAt })),
    checks: checks
      .filter((c) => c !== null && checkFailed(c))
      .map((c) => ({
        name: checkName(c!),
        job_id: c!.databaseId ?? null,
        app: c!.checkSuite?.app?.slug ?? "",
        url: c!.detailsUrl ?? c!.targetUrl ?? "",
        summary: [c!.title, c!.summary, c!.description].filter(Boolean).join("\n"),
      })),
  };
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
interface BranchData {
  repository: Record<string, { nodes: ((RawHit & { headRepository: { nameWithOwner: string } | null }) | null)[] } | null> | null;
}
interface TeamsData {
  viewer: { name?: string | null; organizations: { nodes: ({ login: string; teams: { nodes: { slug: string }[] } } | null)[] } };
}

const RECENT = 20; // your latest PRs' titles, for the judge
const PROBES = 40; // stack probes (aliases) a query

const chunk = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

function tally(keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = (out[k] ?? 0) + 1;
  return out;
}

export async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]!); // in range: no await between the while check and next++
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

export function createGitHub(opts: { token?: string; fetch?: typeof fetch; log?: (msg: string) => void } = {}): GitHub {
  const client = createClient(opts);

  // A search's nodes, `per` a page, in whatever shape `doc` asks for.
  async function pages(doc: string, q: string, max: number, per: number) {
    // Keyed by node id: cursors are offsets, so an item that moves between pages can come back twice.
    const nodes = new Map<string, unknown>();
    let total = 0;
    let after: string | null = null;
    while (nodes.size < max) {
      const { search: page }: SearchData = await client.query<SearchData>(doc, { q, first: Math.min(per, max - nodes.size), after });
      total = page.issueCount;
      for (const n of page.nodes) if (n?.id) nodes.set(n.id, n);
      if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break;
      after = page.pageInfo.endCursor;
    }
    return { nodes: [...nodes.values()], total };
  }

  async function search(q: string, max = 300) {
    const { nodes, total } = await pages(LIGHT_SEARCH, q, max, 100);
    return { hits: (nodes as RawHit[]).map(toHit), total };
  }

  async function details(hits: SearchHit[], me: string): Promise<Item[]> {
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
    const fetchNodes = async (b: { mine: boolean; ids: string[] }): Promise<(RawNode | null)[]> => {
      if (!b.mine) return (await client.query<{ nodes: (RawNode | null)[] }>(DETAILS_REVIEW, { ids: b.ids })).nodes;
      const data = await client.query<Record<string, RawNode | null>>(
        detailsMine(b.ids.length),
        Object.fromEntries(b.ids.map((id, i) => [`id${i}`, id])),
      );
      return b.ids.map((_, i) => data[`n${i}`] ?? null);
    };
    // A failed batch is skipped, not fatal: its items stay stale and are retried next sync.
    const results = await pool(batches, 3, async (b) => {
      try {
        const nodes = await fetchNodes(b);
        return nodes.filter((n) => n !== null).map((n) => normalize(n, now));
      } catch (e) {
        if (e instanceof RateLimitedError) throw e;
        opts.log?.(`details batch of ${b.ids.length} failed: ${(e as Error).message}`);
        return [];
      }
    });
    return results.flat();
  }

  async function context(me: string): Promise<Omit<Context, "refreshed_at">> {
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    // Keep whatever parts succeed; a failed part comes back empty and is logged.
    const settled = await Promise.allSettled([
      client.query<TeamsData>(TEAMS, { me }),
      search(`is:pr reviewed-by:@me -author:@me updated:>=${since}`, 1000),
      search(`is:pr commenter:@me -author:@me updated:>=${since}`, 1000),
      search(`is:pr author:@me created:>=${since}`, 1000),
      search("is:open involves:@me", 300),
    ]);
    const failed = settled.filter((r) => r.status === "rejected").map((r) => r.reason as Error);
    const [first] = failed;
    if (first && failed.length === settled.length) throw first;
    for (const e of failed) opts.log?.(`context: ${e.message}`);
    const ok = <T>(r: PromiseSettledResult<T>, empty: T) => (r.status === "fulfilled" ? r.value : empty);
    const none = { hits: [] as SearchHit[], total: 0 };
    const teams = ok(settled[0], { viewer: { organizations: { nodes: [] } } });
    const reviewed = ok(settled[1], none);
    const commented = ok(settled[2], none);
    const authored = ok(settled[3], none);
    const involved = ok(settled[4], none);
    const engaged = new Map<string, Set<string>>();
    for (const h of [...reviewed.hits, ...commented.hits]) {
      if (h.author_bot) continue;
      if (!engaged.has(h.author)) engaged.set(h.author, new Set());
      engaged.get(h.author)!.add(h.node_id);
    }
    const latest = authored.hits.toSorted((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, RECENT);
    return {
      me,
      name: teams.viewer.name ?? "",
      teams: [...new Set(teams.viewer.organizations.nodes.flatMap((o) => o?.teams.nodes.map((t) => t.slug) ?? []))],
      affinity: Object.fromEntries([...engaged].map(([author, prs]) => [author, prs.size])),
      repo_prs: tally(authored.hits.map((h) => h.id.split("#")[0] ?? "")),
      orgs: tally(involved.hits.map((h) => h.id.split("/")[0] ?? "")),
      recent: latest.map((h) => h.title ?? "").filter(Boolean),
    };
  }

  async function areas(): Promise<Areas> {
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    const prs = async (q: string, authored: boolean): Promise<AreaPr[]> =>
      ((await pages(FILES_SEARCH, `is:pr ${q}`, 500, 50)).nodes as RawFiles[]).map((n) => ({
        repo: n.repository.nameWithOwner,
        files: n.changedFiles,
        paths: n.files?.nodes.map((f) => f.path) ?? [],
        authored,
      }));
    const found = await Promise.all([
      prs(`author:@me created:>=${since}`, true),
      prs(`author:@me merged:>=${since} created:<${since}`, true),
      prs(`reviewed-by:@me -author:@me updated:>=${since}`, false),
    ]);
    return buildAreas(found.flat());
  }

  async function branchPrs(repo: string, probes: { dir: "up" | "down"; branch: string }[]): Promise<SearchHit[]> {
    const [owner, name] = repo.split("/");
    const out = new Map<string, SearchHit>();
    for (const part of chunk(probes, PROBES)) {
      const vars = Object.fromEntries(part.map((p, i) => [`b${i}`, p.branch]));
      const data = await client.query<BranchData>(branchPrsQuery(part.map((p) => p.dir)), { owner, name, ...vars });
      part.forEach((p, i) => {
        for (const n of data.repository?.[`p${i}`]?.nodes ?? []) {
          if (!n || (p.dir === "up" && n.headRepository?.nameWithOwner.toLowerCase() !== repo.toLowerCase())) continue;
          out.set(n.id, toHit(n));
        }
      });
    }
    return [...out.values()];
  }

  async function notifications(feed: { since: string | null; last_modified: string | null }): Promise<NotificationPage> {
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
      const r = await client.get(`/notifications?${q.toString()}`, { headers: conditional });
      first ??= head(r.headers, r.status !== 304);
      if (r.status === 304) break;
      const list = r.data as RawThread[];
      for (const t of list) threads.push({ thread: t.id, item: threadItem(t), reason: t.reason, updated_at: t.updated_at });
      if (list.length < 50) break;
    }
    return first ?? head(new Headers(), false);
  }

  return {
    viewer: async () => (await client.query<{ viewer: { login: string } }>(VIEWER)).viewer.login,
    search,
    details,
    context,
    areas,
    notifications,
    prContext: async (id) => parsePrContext(await client.query<RawPrContext>(PR_CONTEXT, { id })),
    branchPrs,
    rateLimit: () => client.rateLimit(),
  };
}
