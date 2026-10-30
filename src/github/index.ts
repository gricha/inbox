// GitHub module: light search, batched details, daily context. Read only.

import type { Context, Item } from "../types.ts";
import { createClient, RateLimitedError } from "./client.ts";
import { normalize, toHit, type RawHit, type RawNode } from "./normalize.ts";
import { DETAILS_MINE, DETAILS_REVIEW, LIGHT_SEARCH, TEAMS, VIEWER } from "./queries.ts";

export interface SearchHit {
  node_id: string;
  id: string;
  kind: "pr" | "issue";
  updated_at: string;
  author: string;
  author_bot?: boolean;
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
export interface GitHub {
  viewer(): Promise<string>;
  search(query: string, max?: number): Promise<{ hits: SearchHit[]; total: number }>;
  details(hits: SearchHit[], me: string): Promise<Item[]>; // missing/deleted nodes are skipped
  context(me: string): Promise<Omit<Context, "refreshed_at">>; // teams, 90-day affinity, repo_prs, orgs
  // Threads updated since `since`, read or not. Read only: nothing is marked read.
  notifications(opts: { since: string | null; last_modified: string | null }): Promise<NotificationPage>;
  rateLimit(): { remaining: number; reset_at: string } | null; // from the last response
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
  search: { issueCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: (RawHit | null)[] };
}
interface TeamsData {
  viewer: { organizations: { nodes: ({ login: string; teams: { nodes: { slug: string }[] } } | null)[] } };
}

const chunk = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

function tally(keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = (out[k] ?? 0) + 1;
  return out;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
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

  async function search(q: string, max = 300) {
    // Keyed by node id: cursors are offsets, so an item that moves between pages can come back twice.
    const hits = new Map<string, SearchHit>();
    let total = 0;
    let after: string | null = null;
    while (hits.size < max) {
      const { search: page }: SearchData = await client.query<SearchData>(LIGHT_SEARCH, {
        q,
        first: Math.min(100, max - hits.size),
        after,
      });
      total = page.issueCount;
      for (const n of page.nodes) if (n?.id) hits.set(n.id, toHit(n));
      if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break;
      after = page.pageInfo.endCursor;
    }
    return { hits: [...hits.values()], total };
  }

  async function details(hits: SearchHit[], me: string): Promise<Item[]> {
    const unique = [...new Map(hits.map((h) => [h.node_id, h])).values()];
    const isMine = (h: SearchHit) => h.kind === "pr" && h.author.toLowerCase() === me.toLowerCase();
    const batches = [
      ...chunk(unique.filter(isMine), 5).map((b) => ({ query: DETAILS_MINE, ids: b.map((h) => h.node_id) })),
      ...chunk(
        unique.filter((h) => !isMine(h)),
        20,
      ).map((b) => ({ query: DETAILS_REVIEW, ids: b.map((h) => h.node_id) })),
    ];
    const now = new Date().toISOString();
    // A failed batch is skipped, not fatal: its items stay stale and are retried next sync.
    const results = await pool(batches, 3, async (b) => {
      try {
        const { nodes } = await client.query<{ nodes: (RawNode | null)[] }>(b.query, { ids: b.ids });
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
    return {
      me,
      teams: [...new Set(teams.viewer.organizations.nodes.flatMap((o) => o?.teams.nodes.map((t) => t.slug) ?? []))],
      affinity: Object.fromEntries([...engaged].map(([author, prs]) => [author, prs.size])),
      repo_prs: tally(authored.hits.map((h) => h.id.split("#")[0] ?? "")),
      orgs: tally(involved.hits.map((h) => h.id.split("/")[0] ?? "")),
    };
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
    notifications,
    rateLimit: () => client.rateLimit(),
  };
}
