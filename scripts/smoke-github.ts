// Live, read-only check of src/github against the real API.
// Run: node --disable-warning=ExperimentalWarning scripts/smoke-github.ts

import { createGitHub } from "../src/github/index.ts";

const gh = createGitHub({ log: (m) => console.error(`  [github] ${m}`) });

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const out = await fn();
  console.log(`  (${label} ${((performance.now() - start) / 1000).toFixed(2)}s)`);
  return out;
}

const me = await timed("viewer", () => gh.viewer());
console.log(`viewer: ${me}`);

const q = "is:pr is:open review-requested:@me archived:false";
const { hits, total } = await timed("search", () => gh.search(q));
console.log(`\n${q}\n  total ${total}, fetched ${hits.length}, first: ${hits.slice(0, 3).map((h) => h.id).join(", ")}`);

const items = await timed("details review", () => gh.details(hits.slice(0, 20), me));
for (const it of items) {
  const ask = it.request_events.findLast((e) => e.reviewer === me || it.review_requests.some((r) => r.type === "team" && r.reviewer === e.reviewer));
  const by = ask ? `${ask.actor}${ask.actor_bot ? " (bot)" : ""}` : "?";
  console.log(`  ${it.id}  ci=${it.ci} review=${it.review_decision} threads=${it.threads_unresolved}/${it.threads_total} requested-by=${by}`);
}

const mine = await timed("search mine", () => gh.search("is:pr is:open author:@me archived:false", 5));
const myItems = await timed("details mine", () => gh.details(mine.hits, me));
console.log(`\nyour open PRs: ${mine.total}`);
for (const it of myItems) {
  console.log(`  ${it.id}  ci=${it.ci} mergeable=${it.mergeable} unresolved=${it.threads_unresolved} thread_last=${it.thread_last.length} head_author=${it.head_author}`);
}

const ctx = await timed("context", () => gh.context(me));
const top = (r: Record<string, number>, n: number) => Object.entries(r).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}:${v}`).join(", ");
console.log(`\ncontext: ${ctx.teams.length} teams, ${Object.keys(ctx.affinity).length} authors engaged, ${Object.keys(ctx.repo_prs).length} repos authored in`);
console.log(`  top affinity: ${top(ctx.affinity, 5)}`);
console.log(`  top orgs: ${top(ctx.orgs, 5)}`);
console.log(`  top repos: ${top(ctx.repo_prs, 3)}`);

console.log(`\nrate limit: ${JSON.stringify(gh.rateLimit())}`);
