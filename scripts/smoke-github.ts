// Live, read-only check of src/github against the real API.
// Run: node --disable-warning=ExperimentalWarning scripts/smoke-github.ts

import { Cause, Effect, Exit } from "effect";
import { createGitHub } from "../src/github/index.ts";

const gh = createGitHub({
  log: (m) => {
    console.error(`  [github] ${m}`);
  },
});

const timed = <A, E>(label: string, effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const start = performance.now();
    const out = yield* effect;
    console.log(`  (${label} ${((performance.now() - start) / 1000).toFixed(2)}s)`);
    return out;
  });

const smoke = Effect.gen(function* () {
  const me = yield* timed("viewer", gh.viewer());
  console.log(`viewer: ${me}`);

  const q = "is:pr is:open review-requested:@me archived:false";
  const { hits, total } = yield* timed("search", gh.search(q));
  console.log(
    `\n${q}\n  total ${total}, fetched ${hits.length}, first: ${hits
      .slice(0, 3)
      .map((h) => h.id)
      .join(", ")}`,
  );

  const items = yield* timed("details review", gh.details(hits.slice(0, 20), me));
  for (const it of items) {
    const ask = it.request_events.findLast(
      (e) => e.reviewer === me || it.review_requests.some((r) => r.type === "team" && r.reviewer === e.reviewer),
    );
    const by = ask ? `${ask.actor}${ask.actor_bot ? " (bot)" : ""}` : "?";
    console.log(
      `  ${it.id}  ci=${it.ci} review=${it.review_decision} threads=${it.threads_unresolved}/${it.threads_total} requested-by=${by}`,
    );
  }

  const mine = yield* timed("search mine", gh.search("is:pr is:open author:@me archived:false", 5));
  const myItems = yield* timed("details mine", gh.details(mine.hits, me));
  console.log(`\nyour open PRs: ${mine.total}`);
  for (const it of myItems) {
    console.log(
      `  ${it.id}  ci=${it.ci} mergeable=${it.mergeable} unresolved=${it.threads_unresolved} thread_last=${it.thread_last.length} head_author=${it.head_author}`,
    );
  }

  const ctx = yield* timed("context", gh.context(me));
  const top = (r: Record<string, number>, n: number) =>
    Object.entries(r)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => `${k}:${v}`)
      .join(", ");
  console.log(
    `\ncontext: ${ctx.teams.length} teams, ${Object.keys(ctx.affinity).length} authors engaged, ${Object.keys(ctx.repo_prs).length} repos authored in`,
  );
  console.log(`  top affinity: ${top(ctx.affinity, 5)}`);
  console.log(`  top orgs: ${top(ctx.orgs, 5)}`);
  console.log(`  top repos: ${top(ctx.repo_prs, 3)}`);

  console.log(`\nrate limit: ${JSON.stringify(gh.rateLimit())}`);
});

// The boundary: what GitHub refused, or a bug, ends the run with its words and exit 1.
const exit = await Effect.runPromiseExit(smoke);
if (Exit.isFailure(exit)) {
  console.error(`smoke-github failed: ${Cause.pretty(exit.cause)}`);
  process.exitCode = 1;
}
