import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, renderTemplate } from "../src/expr.ts";
import { analyze } from "../src/signals.ts";
import { parseConfig, defaultConfigText } from "../src/config.ts";
import { makeContext, makeItem, NOW } from "./helpers/items.ts";

const cfg = parseConfig(defaultConfigText({ workOrgs: ["acme"] })).loaded!.config;
const sig = analyze(makeItem({ labels: ["bug", "area:ml"], title: "Revert flaky retry" }), makeContext(), cfg, NOW).signals;

const run = (src: string) => {
  const c = compile(src);
  if (!c.ok) throw new Error(c.error);
  return c.eval(sig);
};

test("operators and precedence", () => {
  assert.equal(run("1 + 2 * 3"), 7);
  assert.equal(run("(1 + 2) * 3"), 9);
  assert.equal(run("pr.size > 10 && pr.ci == 'green'"), true);
  assert.equal(run("pr.size > 100 || author.close"), true);
  assert.equal(run("!author.close"), false);
  assert.equal(run("not author.close or item.draft"), false);
  assert.equal(run("!item.draft && pr.ci == 'green'"), true);
  assert.equal(run("-pr.size < 0"), true);
  assert.equal(run("pr.files != 2"), true);
});

test("in, matches and functions", () => {
  assert.equal(run("'bug' in item.labels"), true);
  assert.equal(run("'Revert' in item.title"), true);
  assert.equal(run("item.title matches '^revert'"), true);
  assert.equal(run("item.repo in ['acme/api', 'acme/web']"), true);
  assert.equal(run("len(item.labels)"), 2);
  assert.equal(run("lower(item.author) == 'alice'"), true);
  assert.equal(run("contains(item.title, 'FLAKY')"), true);
  assert.equal(run("startswith(item.repo, 'acme/')"), true);
  assert.equal(run("any(item.labels, 'area:*')"), true);
  assert.equal(run("any(item.labels, 'team:*')"), false);
});

test("compile errors are specific", () => {
  const unknown = compile("me.requsted_direct");
  assert.equal(unknown.ok, false);
  assert.match((unknown as { error: string }).error, /did you mean "me.requested_direct"/);
  assert.match((compile("pr.ci = 'red'") as { error: string }).error, /use ==/);
  assert.match((compile("foo(1)") as { error: string }).error, /unknown function/);
  assert.match((compile("len(1, 2)") as { error: string }).error, /takes 1/);
  assert.match((compile("(pr.size") as { error: string }).error, /expected "\)"/);
  assert.match((compile("item.title matches '['") as { error: string }).error, /bad regex/);
  assert.match((compile("'open") as { error: string }).error, /unterminated/);
});

test("type errors surface at eval time", () => {
  const c = compile("item.title > 3");
  assert.ok(c.ok);
  assert.throws(() => (c as { eval: (s: unknown) => unknown }).eval(sig), /needs numbers/);
});

test("templates interpolate fields and round numbers", () => {
  assert.equal(renderTemplate("{author.login} · {author.engaged_90d} PRs · {item.created_hours}h", sig), "alice · 12 PRs · 48h");
  assert.equal(renderTemplate("{nope.field} {item.labels}", sig), "{nope.field} bug and area:ml");
});

test("a list of three or more renders 'a, b and N more'", () => {
  const blocks = { ...sig, pr: { ...sig.pr, blocks: ["web#1", "web#2", "web#3", "web#4"] } };
  assert.equal(renderTemplate("blocks {pr.blocks}", blocks), "blocks web#1, web#2 and 2 more");
  assert.equal(renderTemplate("blocks {pr.blocks}", { ...sig, pr: { ...sig.pr, blocks: ["web#1"] } }), "blocks web#1");
});

test("a count of 1 takes the singular", () => {
  const one = { ...sig, pr: { ...sig.pr, unresolved_threads: 1 } };
  assert.equal(renderTemplate("{pr.unresolved_threads} unresolved threads", one), "1 unresolved thread");
  assert.equal(renderTemplate("{pr.unresolved_threads} threads, {author.engaged_90d} of their PRs", one), "1 thread, 12 of their PRs");
  assert.equal(renderTemplate("{pr.unresolved_threads} unresolved threads", sig), `${sig.pr.unresolved_threads} unresolved threads`);
});
