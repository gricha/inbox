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
function searchPage(all: { id: string; number: number; repo: string; author: string; updated?: string }[], b: Body) {
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
          title: `Change ${n.number} by ${n.author}`,
          updatedAt: n.updated ?? "2026-03-01T00:00:00Z",
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
    title: "Change 1 by maple",
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

test("context: your name, teams, affinity (distinct PRs per author), repo_prs, orgs, your latest PRs' titles", async () => {
  const shared = prs(3, "maple");
  const searches: Record<string, ReturnType<typeof prs>> = {
    "reviewed-by": [...shared, ...prs(2, "birch")],
    commenter: [...shared.slice(0, 2), ...prs(1, "cedar")], // overlaps with reviewed-by; counted once
    "author:@me created": [
      ...prs(4, "octo-dev", "acme/infra").map((p) => Object.assign(p, { updated: `2026-03-0${p.number}T00:00:00Z` })),
      ...prs(1, "octo-dev", "solo/dotfiles"),
    ],
    involves: [...prs(3, "x", "acme/widgets"), ...prs(2, "x", "solo/dotfiles")],
  };
  const { gh, calls } = fakeGitHub((b) => {
    if (b.query.includes("organizations")) {
      return {
        data: {
          rateLimit: RL,
          // null = an org the token can't read (SAML), reported as FORBIDDEN with partial data.
          viewer: {
            name: "Octo Dev",
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
  assert.equal(ctx.name, "Octo Dev");
  assert.deepEqual(
    ctx.recent,
    ["Change 4 by octo-dev", "Change 3 by octo-dev", "Change 2 by octo-dev", "Change 1 by octo-dev", "Change 1 by octo-dev"],
    "the latest updated first",
  );

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

test("branchPrs: one aliased query per 40 probes a repo; up drops a fork's PR on a branch of the same name", async () => {
  const pr = (id: string, number: number, head: string) => ({
    __typename: "PullRequest",
    id,
    number,
    title: `PR ${number}`,
    updatedAt: "2026-11-02T00:00:00Z",
    repository: { nameWithOwner: "getsentry/sentry" },
    author: { __typename: "User", login: "gricha" },
    headRepository: { nameWithOwner: head },
  });
  const { gh, calls } = fakeGitHub((b) => {
    const repository: Record<string, object> = {};
    for (const k of Object.keys(b.variables).filter((v) => v.startsWith("b"))) {
      const i = k.slice(1);
      repository[`p${i}`] = {
        nodes:
          b.variables[k] === "ref/a"
            ? [pr("PR_a", 1, "getsentry/sentry"), pr("PR_fork", 7, "someone/sentry")]
            : b.variables[k] === "ref/b"
              ? [pr("PR_c", 3, "getsentry/sentry"), null]
              : [],
      };
    }
    return { data: { rateLimit: RL, repository } };
  });
  const probes = [
    { dir: "up" as const, branch: "ref/a" },
    { dir: "down" as const, branch: "ref/b" },
    ...Array.from({ length: 40 }, (_, i) => ({ dir: "down" as const, branch: `x${i}` })),
  ];
  const hits = await gh.branchPrs("getsentry/sentry", probes);
  assert.deepEqual(
    hits.map((h) => h.id),
    ["getsentry/sentry#1", "getsentry/sentry#3"],
  );
  assert.equal(calls.length, 2);
  assert.deepEqual([calls[0]!.variables.owner, calls[0]!.variables.name, calls[0]!.variables.b0], ["getsentry", "sentry", "ref/a"]);
  assert.match(calls[0]!.query, /p0: pullRequests\(headRefName: \$b0, states: \[OPEN, MERGED, CLOSED\]/);
  assert.match(calls[0]!.query, /p1: pullRequests\(baseRefName: \$b1, states: \[OPEN\]/);
  assert.doesNotMatch(calls[0]!.query, /mutation/);
});

test("branchPrs: a pr probe asks for its number as an Int; a PR comes back, an issue's {} and a missing number's null don't", async () => {
  const { gh, calls } = fakeGitHub((b) => ({
    data: {
      rateLimit: RL,
      repository: {
        p0: {
          __typename: "PullRequest",
          id: "PR_5",
          number: 5,
          title: "Control silo",
          updatedAt: "2026-11-02T00:00:00Z",
          repository: { nameWithOwner: "getsentry/sentry" },
          author: { __typename: "User", login: "carol" },
          headRepository: { nameWithOwner: "carol/sentry" },
        },
        p1: {},
        p2: null,
        p3: { nodes: [] },
      },
    },
    errors: b.variables.b2 === 9 ? [{ type: "NOT_FOUND", message: "no issue or PR 9" }] : [],
  }));
  const hits = await gh.branchPrs("GetSentry/Sentry", [
    { dir: "pr", branch: "5" },
    { dir: "pr", branch: "7" },
    { dir: "pr", branch: "9" },
    { dir: "down", branch: "main" },
  ]);
  assert.deepEqual(
    hits.map((h) => h.id),
    ["getsentry/sentry#5"],
  );
  assert.deepEqual([calls[0]!.variables.b0, calls[0]!.variables.b3], [5, "main"]);
  assert.match(calls[0]!.query, /\$b0: Int!, \$b1: Int!, \$b2: Int!, \$b3: String!/);
  assert.match(calls[0]!.query, /p0: issueOrPullRequest\(number: \$b0\) \{ \.\.\. on PullRequest \{ \.\.\.B \} \}/);
  assert.doesNotMatch(calls[0]!.query, /mutation/);
});

test("lookup: one PR or issue by number, as a search hit; null when the repo or number doesn't exist", async () => {
  const { gh, calls } = fakeGitHub((b) => {
    if (b.variables.name === "gone")
      return { data: { rateLimit: RL, repository: null }, errors: [{ type: "NOT_FOUND", message: "no repo" }] };
    const node =
      b.variables.number === 7
        ? {
            __typename: "Issue",
            id: "I_7",
            number: 7,
            title: "Flaky",
            updatedAt: "2026-11-02T00:00:00Z",
            repository: { nameWithOwner: "getsentry/sentry" },
            author: { __typename: "User", login: "dave" },
          }
        : null;
    return { data: { rateLimit: RL, repository: { issueOrPullRequest: node } } };
  });
  assert.deepEqual(await gh.lookup("getsentry/sentry", 7), {
    node_id: "I_7",
    id: "getsentry/sentry#7",
    kind: "issue",
    updated_at: "2026-11-02T00:00:00Z",
    author: "dave",
    author_bot: false,
    title: "Flaky",
  });
  assert.deepEqual([calls[0]!.variables.owner, calls[0]!.variables.name, calls[0]!.variables.number], ["getsentry", "sentry", 7]);
  assert.doesNotMatch(calls[0]!.query, /mutation/);
  assert.equal(await gh.lookup("getsentry/sentry", 8), null);
  assert.equal(await gh.lookup("getsentry/gone", 1), null);
});

test("reviewers: GitHub's suggestions that match what you typed first, then people and the org's teams, each once", async () => {
  const u = (id: string, login: string, name: string | null = null) => ({ id, login, name });
  const { gh, calls } = fakeGitHub(() => ({
    data: {
      rateLimit: RL,
      repository: {
        pullRequest: { suggestedReviewers: [{ reviewer: u("U_dana", "dana", "Dana Lee") }, { reviewer: u("U_sam", "sam") }] },
        assignableUsers: { nodes: [u("U_dan", "dan"), u("U_dana", "dana", "Dana Lee")] },
      },
      organization: { teams: { nodes: [{ id: "T_1", slug: "data", name: "Data" }] } },
    },
  }));
  assert.deepEqual(await gh.reviewers("acme/api", 7, "da"), [
    { id: "U_dana", login: "dana", name: "Dana Lee", team: false, suggested: true },
    { id: "U_dan", login: "dan", name: "", team: false, suggested: false },
    { id: "T_1", login: "data", name: "Data", team: true, suggested: false },
  ]);
  assert.deepEqual(calls[0]!.variables, { owner: "acme", name: "api", number: 7, q: "da" });
  assert.doesNotMatch(calls[0]!.query, /mutation/);
});

test("prContext: a PR's threads with ids and the code they're on, reviews, comments and recent commits, in one query", async () => {
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
              diffSide: "LEFT",
              hunk: { nodes: [{ diffHunk: "@@ -1 +1 @@\n-a\n+b" }] },
              comments: {
                nodes: [
                  {
                    id: "PRRC_1",
                    author: who("dana"),
                    body: "Retry?",
                    createdAt: "2026-03-01T10:00:00Z",
                    url: "https://github.com/acme/api/pull/1#discussion_r1",
                    commit: { oid: "9e8e006aaaabbbbccccddddeeeeffff000011112" },
                  },
                ],
              },
            },
          ],
        },
        reviews: {
          nodes: [
            {
              id: "PRR_1",
              url: "https://github.com/acme/api/pull/1#pullrequestreview-1",
              author: who("dana"),
              state: "CHANGES_REQUESTED",
              body: "See inline",
              submittedAt: null,
              createdAt: "2026-03-01T10:00:00Z",
            },
          ],
        },
        comments: {
          nodes: [{ id: "IC_1", url: "", author: null, body: "+1", createdAt: "2026-03-01T11:00:00Z" }],
        },
        history: {
          nodes: [
            {
              commit: {
                oid: "abc1234aaaabbbbccccddddeeeeffff000011112",
                messageHeadline: "Retry 502s",
                committedDate: "2026-03-01T12:00:00Z",
                author: { user: { login: "me" } },
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
      side: "old",
      hunk: "@@ -1 +1 @@\n-a\n+b",
      commit: "9e8e006aaaabbbbccccddddeeeeffff000011112",
      comments: [
        {
          id: "PRRC_1",
          author: "dana",
          bot: false,
          body: "Retry?",
          at: "2026-03-01T10:00:00Z",
          url: "https://github.com/acme/api/pull/1#discussion_r1",
        },
      ],
    },
  ]);
  assert.deepEqual(ctx.reviews, [
    {
      id: "PRR_1",
      author: "dana",
      bot: false,
      state: "changes_requested",
      body: "See inline",
      at: "2026-03-01T10:00:00Z",
      url: "https://github.com/acme/api/pull/1#pullrequestreview-1",
    },
  ]);
  assert.deepEqual(ctx.comments, [{ id: "IC_1", author: "ghost", bot: false, body: "+1", at: "2026-03-01T11:00:00Z", url: "" }]);
  assert.deepEqual(ctx.commits, [
    { oid: "abc1234aaaabbbbccccddddeeeeffff000011112", headline: "Retry 502s", at: "2026-03-01T12:00:00Z", author: "me" },
  ]);
});
