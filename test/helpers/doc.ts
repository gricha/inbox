// A review document as an agent would write it (docs/review-format.md), for the format's, the routes' and the CLI's tests.
import { FORMAT } from "../../src/doc.ts";

const LEASE = [
  "@@ -1,3 +1,5 @@",
  " export class Lease {",
  "-  renew() {}",
  "+  renew(token: string) {",
  "+    if (token !== this.token) throw new Stale();",
  "+  }",
  " }",
].join("\n");
const DISPATCH = [
  "@@ -10,2 +10,3 @@",
  " export function dispatch(job: Job) {",
  "-  run(job);",
  "+  const t = lease.take(job);",
  "+  run(job, t);",
].join("\n");
export const SOURCE = ["flowchart LR", '  d["Dispatch"]:::new -->|"take()"| l["Lease"]', '  l --> t[("jobs table")]'].join("\n");

export function sample(over: Record<string, unknown> = {}, review: Record<string, unknown> = {}) {
  return {
    format: FORMAT,
    pr: { title: "Split the scheduler", repo: "acme/worker", number: 879, url: "https://github.com/acme/worker/pull/879", author: "kofi" },
    by: "a Claude Code session",
    at: "2026-11-10T12:00:00Z",
    files: [
      { path: "src/lease.ts", status: "modified", patch: LEASE },
      { path: "src/dispatch.ts", status: "modified", patch: DISPATCH },
    ],
    review: {
      risk: "medium",
      risk_reasons: [{ factor: "concurrency", why: "renewals race with expiry" }],
      intent: {
        goal: "Lease owns the jobs table, so a stale worker can't write.",
        fit: "partial",
        gap: "Also renames a config key.",
        stack: "",
      },
      verdict: "look",
      summary: "Splits the scheduler into Lease and Dispatch.\n\nThe old scheduler stays behind a flag.",
      since: "",
      concerns: [
        {
          path: "src/lease.ts",
          side: "new",
          line: 3,
          quote: "if (token !== this.token) throw new Stale();",
          body: "A renewal after expiry should be refused, not thrown.",
        },
      ],
      look: [{ path: "src/lease.ts", side: "new", line: 2, end: 4, quote: "renew(token: string) {", why: "the token check" }],
      interfaces: [
        {
          path: "src/lease.ts",
          side: "new",
          line: 2,
          quote: "renew(token: string) {",
          name: "Lease.renew()",
          kind: "function",
          change: "changed",
          breaking: true,
          impact: "Callers pass a token.",
        },
      ],
      improvements: [],
      notes: [
        { path: "src/dispatch.ts", side: "new", line: 11, quote: "const t = lease.take(job);", body: "Takes a lease before running." },
      ],
      chunks: [
        { id: "h1", level: "look", why: "the token check" },
        { id: "h2", level: "skim", why: "dispatch takes a lease" },
      ],
      steps: [
        { title: "The lease", body: "Lease checks the token.", check: "A stale token is refused.", note: "", diagram: "d1", hunks: ["h1"] },
        { title: "Dispatch", body: "Dispatch takes a lease first.", check: "", note: "", diagram: "", hunks: ["h2"] },
      ],
      diagrams: [{ id: "d1", title: "Who writes the table", caption: "Only Lease does.", source: SOURCE }],
      ...review,
    },
    ...over,
  };
}
