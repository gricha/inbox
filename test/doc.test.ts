import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Effect } from "effect";
import { main } from "../src/cli.ts";
import { createClient } from "../src/client.ts";
import { docId, docOf, readDoc } from "../src/doc.ts";
import { createMcpServer } from "../src/mcp.ts";
import { renderText } from "../src/render.ts";
import { createApp } from "../src/server.ts";
import type { AiReview, DocSaved } from "../src/types.ts";
import { setup } from "./helpers/desk.ts";
import { sample, SOURCE } from "./helpers/doc.ts";
import { makeItem } from "./helpers/items.ts";
import { failure, run } from "./helpers/run.ts";

const tmp = mkdtempSync(join(tmpdir(), "desk-doc-"));

const read = (raw: unknown) => {
  const r = readDoc(raw);
  if (!r.ok) assert.fail(r.why);
  return r;
};

test("a document reads through the review's own parsers, and what it keeps is a fixed point", () => {
  const r = read(sample());
  assert.deepEqual(r.dropped, []);
  assert.equal(r.ai.concerns.length, 1);
  assert.equal(r.ai.notes.length, 2, "the concern is also a note on its line");
  assert.equal(r.ai.guide?.steps.length, 2);
  assert.equal(r.ai.diagrams?.[0]?.graph.kind, "flow");
  assert.equal(r.doc.review.diagrams[0]?.source, SOURCE);
  const again = read(JSON.parse(JSON.stringify(r.doc)));
  assert.deepEqual(again.doc, r.doc);
  assert.equal(docId(again.doc), docId(r.doc));
  assert.match(docId(r.doc), /^[0-9a-f]{16}$/);
});

test("the desk's own review becomes the same document an agent's would", () => {
  const { doc, ai } = read(sample());
  const kept: AiReview = { ...ai, head_oid: "abc", model: "claude-opus-5", at: "2026-11-10T12:00:00.000Z" };
  const r = docOf(doc.pr, doc.files, kept);
  if (!r.ok) assert.fail(r.why);
  assert.equal(r.doc.by, "Inbox, claude-opus-5");
  assert.deepEqual(r.doc.review, doc.review);
  assert.deepEqual(r.ai, ai);
});

test("what doesn't hold is left out and said: a quote that isn't in the diff, more than the risk's budget", () => {
  const fake = { path: "src/lease.ts", side: "new", line: 2, quote: "rm -rf /", body: "Not in the diff." };
  const low = Array.from({ length: 4 }, (_, i) => ({
    path: "src/dispatch.ts",
    side: "new",
    line: 11,
    quote: "const t = lease.take(job);",
    body: `note ${i}`,
  }));
  const r = read(sample({}, { notes: [fake, ...low], risk: "low", concerns: [] }));
  assert.ok(
    r.dropped.some((d) => d.includes("1 comment quoting code that isn't in the diff")),
    r.dropped.join("; "),
  );
  assert.ok(
    r.dropped.some((d) => /^notes: \d of 5 kept$/.test(d)),
    r.dropped.join("; "),
  );
});

test("a document is refused, with why: the wrong format, no summary, bad files, a diagram outside the grammar", () => {
  const why = (raw: unknown) => {
    const r = readDoc(raw);
    assert.equal(r.ok, false);
    return r.ok ? "" : r.why;
  };
  assert.match(why([]), /JSON object/);
  assert.match(why(sample({ format: "inbox.review/2" })), /format must be "inbox.review\/1", not "inbox.review\/2"/);
  assert.match(why(sample({}, { summary: "  " })), /no summary/);
  assert.match(why(sample({ pr: { title: "" } })), /pr.title/);
  assert.match(why(sample({ pr: { title: "x", url: "javascript:alert(1)" } })), /https link/);
  assert.match(why(sample({ files: [] })), /files must list/);
  assert.match(why(sample({ files: [{ path: "a.ts", patch: "+no hunk header" }] })), /@@ line/);
  const html = ["flowchart LR", '  a["<img src=x onerror=alert(1)>"] --> b', "  b --> c"].join("\n");
  assert.match(why(sample({}, { diagrams: [{ id: "d1", title: "", caption: "", source: html }] })), /diagram d1: .*HTML in a label/);
  assert.match(
    why(sample({}, { diagrams: [{ id: "d1", title: "", caption: "", source: 'pie\n  "a": 1' }] })),
    /diagram d1: not a flowchart/,
  );
  assert.match(why(sample({}, { diagrams: [{ id: "1 bad", title: "", caption: "", source: SOURCE }] })), /a diagram's id/);
});

test("the page has every part, draws the diagram as SVG, and runs nothing", async () => {
  const { html } = await run(renderText(JSON.stringify(sample())));
  assert.match(html, /^<!doctype html>/);
  for (const part of [
    "Split the scheduler",
    "Look closely",
    "medium risk",
    "renewals race with expiry",
    "Lease owns the jobs table, so a stale worker can't write.",
    "Not quite what the description says:",
    "Interfaces",
    "Lease.renew()",
    "1 of 2",
    "The lease",
    "Check:",
    "Look here, lines 2–4:",
    "A renewal after expiry should be refused, not thrown.",
    "Takes a lease before running.",
    "Who writes the table",
    "End of the walk-through",
  ])
    assert.ok(html.includes(part), `missing: ${part}`);
  assert.match(html, /<svg class="dg-svg"[^>]*role="img"/);
  assert.match(html, /<text[^>]*>Dispatch<\/text>/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /url\(data:font\/woff2;base64,/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
  assert.doesNotMatch(html, /<script|<link|src="http|url\(http|url\("\.\//);
});

test("a document's words are only ever text on the page", async () => {
  const evil = '<script>alert(1)</script><img src=x onerror="alert(2)">';
  const raw = sample(
    { pr: { title: evil, repo: "acme/worker", url: "https://github.com/acme/worker/pull/1?a=1&b=2" } },
    {
      summary: evil,
      concerns: [],
      notes: [
        { path: "src/dispatch.ts", side: "new", line: 11, quote: "const t = lease.take(job);", body: `${evil} [x](javascript:alert(4))` },
      ],
    },
  );
  const { html } = await run(renderText(JSON.stringify(raw)));
  assert.doesNotMatch(html, /<script|<img|href="javascript/);
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes('href="https://github.com/acme/worker/pull/1?a=1&amp;b=2"'));
  const quoted = readDoc(sample({ pr: { title: "x", url: 'https://github.com/" onmouseover="alert(3)' } }));
  assert.equal(quoted.ok, false, "a link with a quote in it is refused");
});

test("renderText refuses what isn't a document in words an agent can fix it from", async () => {
  assert.match((await failure(renderText("{"))).message, /^not a review document: /);
  assert.match(
    (await failure(renderText(JSON.stringify(sample({}, { summary: "" }))))).message,
    /not a review document: the review has no summary/,
  );
});

async function cli(argv: string[]) {
  let out = "",
    err = "";
  const code = await main(argv, { stdout: { write: (s: string) => (out += s) }, stderr: { write: (s: string) => (err += s) } });
  return { code, out, err };
}

test("desk render writes the page beside the document, or where -o says, without a desk", async () => {
  const file = join(tmp, "review.json");
  writeFileSync(file, JSON.stringify(sample()));
  const r = await cli(["render", file]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), join(tmp, "review.html"));
  assert.match(readFileSync(join(tmp, "review.html"), "utf8"), /Split the scheduler/);
  const out = join(tmp, "elsewhere.html");
  assert.equal((await cli(["render", file, "-o", out])).code, 0);
  assert.match(readFileSync(out, "utf8"), /<svg class="dg-svg"/);
  const stdout = await cli(["render", file, "-o", "-"]);
  assert.match(stdout.out, /^<!doctype html>/);
  writeFileSync(file, JSON.stringify(sample({ format: "nope" })));
  const bad = await cli(["render", file]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /^desk: not a review document: format must be "inbox.review\/1", not "nope"/);
});

// ---------------------------------------------------------------- the desk: its routes, its own reviews, desk_doc

async function deskWith() {
  const item = makeItem({ number: 7, review_requests: [{ reviewer: "me", type: "user", codeowner: false }] });
  const t = await setup([item], { settings: { "review.auto_ai": false } });
  await run(t.desk.sync());
  const { doc, ai } = read(sample());
  t.desk.review = {
    fetchPr: () => Effect.succeed({ body: "", files: doc.files }),
    generate: (it) => Effect.succeed({ ...ai, head_oid: it.head_oid, model: "claude-opus-5", at: "2026-11-10T12:00:00.000Z" }),
  };
  const app = createApp(t.desk, 47823);
  const req = (p: string, init: RequestInit = {}) => app.request(`http://127.0.0.1:47823${p}`, init);
  return { ...t, app, req };
}

test("POST /api/docs keeps an agent's document as files and serves it back, as JSON and as a page only the desk may frame", async (c) => {
  const t = await deskWith();
  c.after(t.cleanup);
  const res = await t.req("/api/docs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sample()) });
  assert.equal(res.status, 200);
  const saved = (await res.json()) as DocSaved & { ok: true };
  assert.match(saved.id, /^[0-9a-f]{16}$/);
  assert.equal(saved.link, `inbox://doc/${saved.id}`);
  assert.equal(saved.json, join(t.home, "docs", `${saved.id}.json`));
  assert.equal(JSON.parse(readFileSync(saved.json, "utf8")).format, "inbox.review/1");
  assert.match(readFileSync(saved.html, "utf8"), /Split the scheduler/);

  const json = await t.req(`/api/docs/${saved.id}`);
  assert.equal(json.status, 200);
  assert.equal(((await json.json()) as { pr: { title: string } }).pr.title, "Split the scheduler");
  const page = await t.req(`/api/docs/${saved.id}/html`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(page.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.match(page.headers.get("content-security-policy") ?? "", /^default-src 'none'; .*frame-ancestors 'self'$/);
  assert.equal((await t.req("/api/overview")).headers.get("x-frame-options"), "DENY", "every other page stays unframed");

  assert.equal((await t.req("/api/docs/0123456789abcdef")).status, 404);
  assert.equal((await t.req("/api/docs/..%2Fdesk.db")).status, 404);
  const bad = await t.req("/api/docs", { method: "POST", body: JSON.stringify(sample({ format: "x" })) });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /^not a review document: format must be/);
});

test("the desk writes a document for each AI review it makes, and on demand for the one it has", async (c) => {
  const t = await deskWith();
  c.after(t.cleanup);
  const res = await t.req("/api/review/acme%2Fapi%237/ai", { method: "POST", body: "{}" });
  assert.equal(res.status, 200);
  const { ai } = (await res.json()) as { ai: AiReview };
  assert.match(ai.doc ?? "", /^[0-9a-f]{16}$/);
  const doc = JSON.parse(readFileSync(join(t.home, "docs", `${ai.doc}.json`), "utf8")) as { by: string; pr: Record<string, unknown> };
  assert.equal(doc.by, "Inbox, claude-opus-5");
  assert.equal(doc.pr.repo, "acme/api");
  assert.equal(doc.pr.number, 7);
  const again = await t.req("/api/review/acme%2Fapi%237/doc", { method: "POST", body: "{}" });
  assert.equal(((await again.json()) as DocSaved).id, ai.doc, "kept, not written again");
});

test("desk_doc submits a document from the agent's file and says where its page is", async (c) => {
  const t = await deskWith();
  c.after(t.cleanup);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(createClient((p, init) => t.app.request(`http://127.0.0.1:47823${p}`, init))).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  c.after(() => client.close());
  const file = join(tmp, "agent.json");
  writeFileSync(file, JSON.stringify(sample({}, { notes: [], concerns: [] })));
  const r = await client.callTool({ name: "desk_doc", arguments: { path: file } });
  const text = (r.content as { text: string }[]).map((x) => x.text).join("\n");
  assert.ok(!r.isError, text);
  const id = /^review document ([0-9a-f]{16})$/m.exec(text)?.[1];
  assert.ok(id, text);
  assert.ok(text.includes(`page: ${join(t.home, "docs", `${id}.html`)}`), text);
  assert.ok(text.includes(`in the desk: inbox://doc/${id}`), text);
  const none = await client.callTool({ name: "desk_doc", arguments: {} });
  assert.ok(none.isError);
});
