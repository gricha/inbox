import type { Areas, Context, Item, Reviewer } from "../../src/types.ts";
import type { GitHub, NotificationPage, NotificationThread, PrContext, SearchHit } from "../../src/github/index.ts";

export const NOW = new Date("2026-10-27T12:00:00Z");
export const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

export function makeItem(o: Partial<Item> & { repo?: string; number?: number } = {}): Item {
  const repo = o.repo ?? "acme/api";
  const number = o.number ?? 1;
  return {
    id: `${repo}#${number}`,
    node_id: `PR_${repo}_${number}`,
    kind: "pr",
    repo,
    number,
    title: `Change ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    author: "alice",
    author_bot: false,
    state: "open",
    draft: false,
    labels: [],
    assignees: [],
    created_at: hoursAgo(48),
    updated_at: hoursAgo(2),
    additions: 10,
    deletions: 2,
    changed_files: 1,
    base: "main",
    default_branch: "main",
    head_ref: `change-${number}`,
    head_repo: repo,
    retargeted: null,
    ci: "green",
    review_decision: "required",
    mergeable: "unknown",
    head_oid: "abc",
    head_committed_at: hoursAgo(40),
    head_author: o.author ?? "alice",
    review_requests: [],
    request_events: [],
    reviews: [],
    comments: [],
    comments_total: 0,
    threads_total: 0,
    threads_unresolved: 0,
    thread_last: [],
    requires: [],
    detail_at: hoursAgo(0),
    ...o,
  };
}

export function makeContext(o: Partial<Context> = {}): Context {
  return {
    me: "me",
    teams: ["ml-team"],
    affinity: { alice: 12, bob: 1 },
    repo_prs: { "acme/api": 4 },
    orgs: { acme: 40, me: 3 },
    refreshed_at: NOW.toISOString(),
    ...o,
  };
}

// In-memory GitHub: each search returns the items whose ids `route(query)` lists.
export class FakeGitHub implements GitHub {
  items = new Map<string, Item>();
  route: (query: string) => string[];
  ctx: Context;
  searches: string[] = [];
  detailCalls: string[][] = [];
  clock = () => NOW;
  // The notifications feed: the next poll returns `threads` (then nothing until more are queued).
  threads: NotificationThread[] = [];
  pollInterval = 60;
  feedCalls: { since: string | null; last_modified: string | null }[] = [];

  constructor(items: Item[], route: (q: string) => string[], ctx = makeContext()) {
    for (const it of items) this.items.set(it.id, it);
    this.route = route;
    this.ctx = ctx;
  }

  viewer() {
    return Promise.resolve(this.ctx.me);
  }

  search(query: string) {
    this.searches.push(query);
    const hits: SearchHit[] = this.route(query)
      .map((id) => this.items.get(id))
      .filter((it): it is Item => it !== undefined)
      .map((it) => ({ node_id: it.node_id, id: it.id, kind: it.kind, updated_at: it.updated_at, author: it.author }));
    return Promise.resolve({ hits, total: hits.length });
  }

  details(hits: SearchHit[]) {
    this.detailCalls.push(hits.map((h) => h.id));
    return Promise.resolve(hits.map((h) => ({ ...this.items.get(h.id)!, detail_at: this.clock().toISOString() })));
  }

  context() {
    const { refreshed_at: _, ...rest } = this.ctx;
    return Promise.resolve(rest);
  }

  // What areas() finds next: a test sets the directories, or an Error to fail the fetch.
  found: Areas | Error = {};
  areaCalls = 0;

  areas() {
    this.areaCalls++;
    return this.found instanceof Error ? Promise.reject(this.found) : Promise.resolve(this.found);
  }

  notifications(opts: { since: string | null; last_modified: string | null }): Promise<NotificationPage> {
    this.feedCalls.push(opts);
    const threads = this.threads;
    this.threads = [];
    const date = this.clock().toISOString();
    if (!threads.length && opts.last_modified)
      return Promise.resolve({ modified: false, threads, last_modified: opts.last_modified, poll_interval: this.pollInterval, date });
    return Promise.resolve({
      modified: true,
      threads,
      last_modified: `lm-${this.feedCalls.length}`,
      poll_interval: this.pollInterval,
      date,
    });
  }

  // Stack probes over the same items, as GitHub answers them; each call is logged as "repo dir branch".
  probeCalls: string[] = [];

  branchPrs(repo: string, probes: { dir: "up" | "down"; branch: string }[]): Promise<SearchHit[]> {
    const hits = new Map<string, SearchHit>();
    for (const p of probes) {
      this.probeCalls.push(`${repo} ${p.dir} ${p.branch}`);
      for (const it of this.items.values()) {
        if (it.kind !== "pr" || it.repo !== repo) continue;
        const up = p.dir === "up" && it.head_ref === p.branch && (it.head_repo ?? repo) === repo;
        const down = p.dir === "down" && it.base === p.branch && it.state === "open";
        if (up || down) hits.set(it.id, { node_id: it.node_id, id: it.id, kind: "pr", updated_at: it.updated_at, author: it.author });
      }
    }
    return Promise.resolve([...hits.values()]);
  }

  // A PR's threads, reviews, comments and commits, by node id; empty unless a test sets one.
  contexts = new Map<string, PrContext>();
  contextCalls: string[] = [];

  prContext(nodeId: string): Promise<PrContext> {
    this.contextCalls.push(nodeId);
    return Promise.resolve(this.contexts.get(nodeId) ?? { threads: [], reviews: [], comments: [], commits: [] });
  }

  // Who a test offers as reviewers, and what each search asked.
  reviewerList: Reviewer[] = [];
  reviewerCalls: string[] = [];

  reviewers(repo: string, number: number, q: string): Promise<Reviewer[]> {
    this.reviewerCalls.push(`${repo}#${number} ${q}`);
    return Promise.resolve(this.reviewerList);
  }

  lookupCalls: string[] = [];

  lookup(repo: string, number: number): Promise<SearchHit | null> {
    this.lookupCalls.push(`${repo}#${number}`);
    const it = [...this.items.values()].find((i) => i.repo.toLowerCase() === repo.toLowerCase() && i.number === number);
    return Promise.resolve(it ? { node_id: it.node_id, id: it.id, kind: it.kind, updated_at: it.updated_at, author: it.author } : null);
  }

  rateLimit() {
    return null;
  }
}
