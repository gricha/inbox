import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createGitHub, type SearchHit } from "../src/github/index.ts";
import type { RawNode } from "../src/github/normalize.ts";

type Body = { query: string; variables: Record<string, any> };
const RL = { remaining: 4000, resetAt: "2099-01-01T00:00:00Z", cost: 1 };

function fakeGitHub(handler: (b: Body) => object | Promise<object>) {
  const calls: Body[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fake = (async (_url: string, init: RequestInit) => {
    const body: Body = JSON.parse(init.body as string);
    calls.push(body);
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    try {
      return new Response(JSON.stringify(await handler(body)));
    } finally {
      inFlight--;
    }
  }) as unknown as typeof fetch;
  return { gh: createGitHub({ token: "t", fetch: fake }), calls, maxInFlight: () => maxInFlight };
}

// A search backend over `total` synthetic PRs, cursor = offset.
function searchPage(all: { id: string; number: number; repo: string; author: string }[], b: Body) {
  const start = b.variables.after ? Number(b.variables.after) : 0;
  const end = Math.min(start + b.variables.first, all.length, 1000);
  return {
    data: {
      rateLimit: RL,
      search: {
        issueCount: all.length,
        pageInfo: { hasNextPage: end < Math.min(all.length, 1000), endCursor: String(end) },
        nodes: all.slice(start, end).map((n) => ({
          __typename: "PullRequest",
          id: n.id,
          number: n.number,
          updatedAt: "2026-03-01T00:00:00Z",
          repository: { nameWithOwner: n.repo },
          author: { login: n.author },
        })),
      },
    },
  };
}

const prs = (n: number, author = "maple", repo = "acme/widgets") =>
  Array.from({ length: n }, (_, i) => ({ id: `PR_${repo}_${author}_${i}`, number: i + 1, repo, author }));

test("search paginates 100 per page until no next page", async () => {
  const all = prs(250);
  const { gh, calls } = fakeGitHub((b) => searchPage(all, b));
  const { hits, total } = await gh.search("is:pr is:open");
  assert.equal(total, 250);
  assert.equal(hits.length, 250);
  assert.deepEqual(
    calls.map((c) => [c.variables.first, c.variables.after]),
    [
      [100, null],
      [100, "100"],
      [100, "200"],
    ],
  );
  assert.deepEqual(hits[0], {
    node_id: "PR_acme/widgets_maple_0",
    id: "acme/widgets#1",
    kind: "pr",
    updated_at: "2026-03-01T00:00:00Z",
    author: "maple",
    author_bot: false,
  });
  assert.equal(calls[0]?.variables.q, "is:pr is:open");
});

test("search stops at max", async () => {
  const all = prs(900);
  const { gh, calls } = fakeGitHub((b) => searchPage(all, b));
  const { hits, total } = await gh.search("is:pr", 150);
  assert.equal(total, 900);
  assert.equal(hits.length, 150);
  assert.deepEqual(
    calls.map((c) => c.variables.first),
    [100, 50],
  );

  const def = fakeGitHub((b) => searchPage(all, b));
  assert.equal((await def.gh.search("is:pr")).hits.length, 300);
  assert.equal(def.calls.length, 3);
});

test("search drops a node repeated across pages", async () => {
  const all = prs(150);
  const { gh } = fakeGitHub((b) => {
    const page = searchPage(all, b);
    if (b.variables.after) {
      const dup = searchPage(all, { ...b, variables: { ...b.variables, after: null } }).data.search.nodes[99];
      assert.ok(dup);
      page.data.search.nodes[0] = dup;
    }
    return page;
  });
  const { hits } = await gh.search("is:pr");
  assert.equal(hits.length, 149);
  assert.equal(new Set(hits.map((h) => h.node_id)).size, 149);
});

const base: RawNode = JSON.parse(readFileSync(new URL("./fixtures/github/pr-review.json", import.meta.url), "utf8"));
const hit = (node_id: string, author: string, kind: "pr" | "issue" = "pr"): SearchHit => ({
  node_id,
  id: `acme/widgets#${node_id}`,
  kind,
  updated_at: "",
  author,
});

test("details: your PRs get the mine fragment in 5s, the rest the review fragment in 20s, 3 at a time", async () => {
  const hits = [
    ...Array.from({ length: 7 }, (_, i) => hit(`mine${i}`, "Octo-Dev")),
    hit("myissue", "octo-dev", "issue"),
    ...Array.from({ length: 25 }, (_, i) => hit(`other${i}`, "maple")),
    hit("other0", "maple"), // duplicate across queries
  ];
  // Your PRs come as aliased nodes (n0: node(id: $id0)), each asking whether its checks are required for it.
  const idsOf = (v: Record<string, unknown>): string[] =>
    Array.isArray(v.ids) ? (v.ids as string[]) : Object.keys(v).map((k) => v[`id${k.slice(2)}`] as string);
  const { gh, calls, maxInFlight } = fakeGitHub(async (b) => {
    await sleep(5);
    const ids = idsOf(b.variables);
    // "gone" simulates a node deleted between search and details.
    const nodes = ids.map((id, i) => (id === "other3" ? null : { ...base, id, number: i + 1 }));
    if (!Array.isArray(b.variables.ids)) return { data: { rateLimit: RL, ...Object.fromEntries(nodes.map((n, i) => [`n${i}`, n])) } };
    return {
      data: { rateLimit: RL, nodes },
      errors: ids.includes("other3") ? [{ type: "NOT_FOUND", path: ["nodes", ids.indexOf("other3")], message: "gone" }] : undefined,
    };
  });
  const items = await gh.details(hits, "octo-dev");

  const mine = calls.filter((c) => c.query.includes("mergeable"));
  const review = calls.filter((c) => !c.query.includes("mergeable"));
  assert.deepEqual(
    mine.map((c) => idsOf(c.variables).length),
    [5, 2],
  );
  assert.match(mine[0]!.query, /n4: node\(id: \$id4\)[\s\S]*isRequired\(pullRequestId: \$id4\)/);
  assert.deepEqual(idsOf(mine[1]!.variables), ["mine5", "mine6"]);
  assert.deepEqual(
    review.map((c) => c.variables.ids.length),
    [20, 6],
  );
  assert.ok(review.flatMap((c) => c.variables.ids).includes("myissue"));
  assert.ok(maxInFlight() <= 3, `max in flight ${maxInFlight()}`);
  assert.equal(items.length, 7 + 1 + 25 - 1);
  assert.ok(!items.some((i) => i.node_id === "other3"));
  assert.ok(items.every((i) => i.detail_at === items[0]?.detail_at));
});

test("details with no hits makes no calls", async () => {
  const { gh, calls } = fakeGitHub(() => ({}));
  assert.deepEqual(await gh.details([], "octo-dev"), []);
  assert.equal(calls.length, 0);
});

test("context: teams, affinity (distinct PRs per author), repo_prs, orgs", async () => {
  const shared = prs(3, "maple");
  const searches: Record<string, ReturnType<typeof prs>> = {
    "reviewed-by": [...shared, ...prs(2, "birch")],
    commenter: [...shared.slice(0, 2), ...prs(1, "cedar")], // overlaps with reviewed-by; counted once
    "author:@me created": [...prs(4, "octo-dev", "acme/infra"), ...prs(1, "octo-dev", "solo/dotfiles")],
    involves: [...prs(3, "x", "acme/widgets"), ...prs(2, "x", "solo/dotfiles")],
  };
  const { gh, calls } = fakeGitHub((b) => {
    if (b.query.includes("organizations")) {
      return {
        data: {
          rateLimit: RL,
          // null = an org the token can't read (SAML), reported as FORBIDDEN with partial data.
          viewer: {
            organizations: {
              nodes: [
                { login: "acme", teams: { nodes: [{ slug: "platform-core" }, { slug: "infra" }] } },
                null,
                { login: "other", teams: { nodes: [{ slug: "infra" }] } },
              ],
            },
          },
        },
        errors: [
          {
            type: "FORBIDDEN",
            path: ["viewer", "organizations", "nodes", 1],
            message: "Resource protected by organization SAML enforcement",
          },
        ],
      };
    }
    const all = Object.entries(searches).find(([k]) => b.variables.q.includes(k))?.[1];
    assert.ok(all, b.variables.q);
    return searchPage(all, b);
  });
  const ctx = await gh.context("octo-dev");
  assert.equal(ctx.me, "octo-dev");
  assert.deepEqual(ctx.teams, ["platform-core", "infra"]);
  assert.deepEqual(ctx.affinity, { maple: 3, birch: 2, cedar: 1 });
  assert.deepEqual(ctx.repo_prs, { "acme/infra": 4, "solo/dotfiles": 1 });
  assert.deepEqual(ctx.orgs, { acme: 3, solo: 2 });

  const qs = new Set(calls.map((c) => c.variables.q).filter(Boolean));
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  assert.ok(qs.has(`is:pr reviewed-by:@me -author:@me updated:>=${since}`));
  assert.ok(qs.has(`is:pr commenter:@me -author:@me updated:>=${since}`));
  assert.ok(qs.has(`is:pr author:@me created:>=${since}`));
  assert.ok(qs.has("is:open involves:@me"));
  assert.deepEqual(calls.find((c) => c.query.includes("organizations"))!.variables, { me: "octo-dev" });
});

test("areas: your PRs and reviews of the last 90 days with their paths, 50 a page", async () => {
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const pr = (i: number, repo: string, paths: string[], changedFiles = paths.length) => ({
    id: `PR_${repo}_${i}`,
    repository: { nameWithOwner: repo },
    changedFiles,
    files: { nodes: paths.map((path) => ({ path })) },
  });
  const searches: Record<string, ReturnType<typeof pr>[]> = {
    [`is:pr author:@me created:>=${since}`]: [
      ...Array.from({ length: 60 }, (_, i) => pr(i, "acme/api", ["src/auth/session.ts"])),
      pr(99, "acme/api", ["src/billing/plan.ts"], 300), // a codemod: left out
    ],
    [`is:pr author:@me merged:>=${since} created:<${since}`]: [pr(1, "acme/web", ["app/views/list.tsx"])],
    [`is:pr reviewed-by:@me -author:@me updated:>=${since}`]: [
      pr(2, "acme/web", ["app/views/grid.tsx", "app/views/grid.test.tsx"]),
      pr(3, "acme/web", ["lib/x.ts"]),
    ],
  };
  const { gh, calls } = fakeGitHub((b) => {
    const all = searches[b.variables.q];
    assert.ok(all, b.variables.q);
    const start = b.variables.after ? Number(b.variables.after) : 0;
    const end = Math.min(start + b.variables.first, all.length);
    return {
      data: {
        rateLimit: RL,
        search: {
          issueCount: all.length,
          pageInfo: { hasNextPage: end < all.length, endCursor: String(end) },
          nodes: all.slice(start, end),
        },
      },
    };
  });
  assert.deepEqual(await gh.areas(), { "acme/api": { "src/auth/": 180 }, "acme/web": { "app/views/": 4 } });
  assert.ok(calls.every((c) => c.query.includes("files(first: 50)") && c.variables.first <= 50));
  assert.equal(calls.length, 4); // 61 of your PRs: two pages
});

test("viewer and rateLimit", async () => {
  const { gh } = fakeGitHub(() => ({ data: { rateLimit: { ...RL, remaining: 4321 }, viewer: { login: "octo-dev" } } }));
  assert.equal(gh.rateLimit(), null);
  assert.equal(await gh.viewer(), "octo-dev");
  assert.deepEqual(gh.rateLimit(), { remaining: 4321, reset_at: RL.resetAt });
});

test("notifications: every thread since a time, PRs and issues mapped to ids, paged, with the poll interval", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const thread = (id: string, type: string, url: string | null, reason = "mention") => ({
    id,
    reason,
    updated_at: "2026-10-27T11:00:00Z",
    subject: { type, url },
  });
  const pages = [
    [
      thread("1", "PullRequest", "https://api.github.com/repos/acme/widgets/pulls/412", "review_requested"),
      thread("2", "Issue", "https://api.github.com/repos/Acme/Docs/issues/7"),
      thread("3", "Release", "https://api.github.com/repos/acme/widgets/releases/1"),
      thread("4", "CheckSuite", null, "ci_activity"),
      ...Array.from({ length: 46 }, (_, i) => thread(`x${i}`, "Discussion", null)),
    ],
    [thread("5", "PullRequest", "https://api.github.com/repos/acme/widgets/pulls/9")],
  ];
  const fake = ((url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    const page = Number(new URL(url).searchParams.get("page"));
    const headers = { "last-modified": "LM", "x-poll-interval": "90", date: "Tue, 27 Oct 2026 12:00:00 GMT" };
    return Promise.resolve(new Response(JSON.stringify(pages[page - 1] ?? []), { headers }));
  }) as unknown as typeof fetch;
  const gh = createGitHub({ token: "t", fetch: fake });
  const r = await gh.notifications({ since: "2026-10-27T10:00:00Z", last_modified: "OLD" });
  assert.equal(calls.length, 2);
  const q = new URL(calls[0]!.url).searchParams;
  assert.deepEqual([q.get("all"), q.get("since"), q.get("per_page")], ["true", "2026-10-27T10:00:00Z", "50"]);
  assert.equal(calls[0]?.headers["if-modified-since"], "OLD");
  assert.equal(calls[1]?.headers["if-modified-since"], undefined);
  assert.deepEqual(
    r.threads.filter((t) => t.item).map((t) => [t.thread, t.item, t.reason]),
    [
      ["1", "acme/widgets#412", "review_requested"],
      ["2", "Acme/Docs#7", "mention"],
      ["5", "acme/widgets#9", "mention"],
    ],
  );
  assert.equal(r.threads.length, 51);
  assert.deepEqual([r.modified, r.last_modified, r.poll_interval, r.date], [true, "LM", 90, "Tue, 27 Oct 2026 12:00:00 GMT"]);
});

test("notifications: a 304 means nothing changed and costs one call", async () => {
  let n = 0;
  const fake = (() => {
    n++;
    return Promise.resolve(new Response(null, { status: 304, headers: { "x-poll-interval": "60" } }));
  }) as unknown as typeof fetch;
  const r = await createGitHub({ token: "t", fetch: fake }).notifications({ since: null, last_modified: "LM" });
  assert.deepEqual([r.modified, r.threads, r.poll_interval, n], [false, [], 60, 1]);
});

test("prContext: a PR's threads with ids, reviews, comments and only its failing checks, in one query", async () => {
  const who = (login: string, bot = false) => ({ __typename: bot ? "Bot" : "User", login });
  const { gh, calls } = fakeGitHub(() => ({
    data: {
      rateLimit: RL,
      node: {
        reviewThreads: {
          nodes: [
            {
              id: "PRRT_1",
              isResolved: false,
              isOutdated: true,
              path: "src/a.ts",
              line: null,
              comments: {
                nodes: [{ author: who("dana"), authorAssociation: "MEMBER", body: "Retry?", createdAt: "2026-03-01T10:00:00Z" }],
              },
            },
          ],
        },
        reviews: {
          nodes: [
            {
              author: who("dana"),
              authorAssociation: "MEMBER",
              state: "CHANGES_REQUESTED",
              body: "See inline",
              submittedAt: null,
              createdAt: "2026-03-01T10:00:00Z",
            },
          ],
        },
        comments: { nodes: [{ author: null, authorAssociation: "NONE", body: "+1", createdAt: "2026-03-01T11:00:00Z" }] },
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      {
                        __typename: "CheckRun",
                        name: "test",
                        conclusion: "FAILURE",
                        databaseId: 7,
                        detailsUrl: "https://x/7",
                        title: "1 failed",
                        summary: null,
                        checkSuite: { app: { slug: "github-actions" } },
                      },
                      { __typename: "CheckRun", name: "lint", conclusion: "SUCCESS", databaseId: 8 },
                      { __typename: "CheckRun", name: "deploy", conclusion: "CANCELLED", databaseId: 9 },
                      { __typename: "StatusContext", context: "ci/legacy", state: "ERROR", description: "boom", targetUrl: "https://y" },
                      null,
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    },
  }));
  const ctx = await gh.prContext("PR_1");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.query, /^query\(\$id: ID!\)/);
  assert.deepEqual(calls[0]!.variables, { id: "PR_1" });
  assert.deepEqual(ctx.threads, [
    {
      id: "PRRT_1",
      resolved: false,
      outdated: true,
      path: "src/a.ts",
      line: null,
      comments: [{ author: "dana", bot: false, trusted: true, body: "Retry?", at: "2026-03-01T10:00:00Z" }],
    },
  ]);
  assert.deepEqual(ctx.reviews, [
    { author: "dana", bot: false, trusted: true, state: "changes_requested", body: "See inline", at: "2026-03-01T10:00:00Z" },
  ]);
  assert.deepEqual(ctx.comments, [{ author: "ghost", bot: false, trusted: false, body: "+1", at: "2026-03-01T11:00:00Z" }]);
  assert.deepEqual(ctx.checks, [
    { name: "test", job_id: 7, app: "github-actions", url: "https://x/7", summary: "1 failed" },
    { name: "ci/legacy", job_id: null, app: "", url: "https://y", summary: "boom" },
  ]);
});
