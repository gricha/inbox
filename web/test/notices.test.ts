import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConnectorStatus } from "../../src/types.ts";
import { forget, noticesOf, undismissed, withFailure, type Conditions, type Dismissed } from "../src/notices.ts";

const gh = (status: ConnectorStatus["status"], error: string | null): ConnectorStatus => ({
  id: "github",
  name: "GitHub",
  status,
  synced_at: "2026-10-27T12:00:00Z",
  error,
});
const overview = (syncing: boolean, sync_error: string | null, status: ConnectorStatus["status"] = "ok", errors = 0) => ({
  syncing,
  sync_error,
  connectors: [gh(status, sync_error)],
  config_errors: Array.from({ length: errors }, (_, i) => ({ path: `rules[${i}]`, message: "bad" })),
  rate_limit: null,
});
const fine: Conditions = {
  offline: false,
  source: null,
  starting: null,
  broken: null,
  overview: overview(false, null),
  paused: null,
  page: "#/",
  agent: "Claude",
};
const ids = (c: Partial<Conditions>) => noticesOf({ ...fine, ...c }).map((n) => `${n.id}:${n.sig}`);
const LOGGED_OUT = "Claude Code isn't logged in, so nothing is being sorted or reviewed. Run `claude auth login`.";

test("a bubble only for what's wrong with the system: nothing while the desk answers, syncs and its agent runs", () => {
  assert.deepEqual(ids({}), []);
  assert.deepEqual(ids({ overview: null }), []);
  assert.deepEqual(ids({ overview: overview(true, null, "syncing") }), []);
});

test("the agent paused: its own words and the way to Settings → Agent, except on that page, which says it", () => {
  const [n, ...rest] = noticesOf({ ...fine, paused: { who: "claude", why: LOGGED_OUT } });
  assert.equal(rest.length, 0);
  assert.equal(n?.title, "Claude is paused");
  assert.equal(n?.text, LOGGED_OUT);
  assert.equal(n?.tone, "red");
  assert.deepEqual(n?.fix, { label: "Open Settings → Local Agent Integration", href: "#/settings/agent" });
  assert.equal(noticesOf({ ...fine, paused: { who: "ai", why: "out of usage" } })[0]?.title, "AI reviews are paused");
  assert.deepEqual(ids({ paused: { who: "claude", why: LOGGED_OUT }, page: "#/settings/agent" }), []);
});

test("the sync: failed with its error and Try again, running again while it retries; rate limited waits with nothing to press", () => {
  const failed = noticesOf({ ...fine, overview: overview(false, "GitHub rejected the token (HTTP 401)", "error") })[0];
  assert.equal(failed?.title, "Sync failed");
  assert.equal(failed?.text, "GitHub rejected the token (HTTP 401)");
  assert.deepEqual(failed?.fix, { label: "Try again", run: "sync" });
  assert.equal(failed?.busy, false);
  const retrying = noticesOf({ ...fine, overview: overview(true, "GitHub rejected the token (HTTP 401)", "syncing") })[0];
  assert.deepEqual([retrying?.sig, retrying?.busy, retrying?.fix?.label], ["failed", true, "Syncing…"]);
  const limited = noticesOf({
    ...fine,
    overview: overview(false, "GitHub rate limited until 2026-10-27T13:00:00Z (HTTP 403)", "paused"),
  })[0];
  assert.equal(limited?.title, "GitHub's rate limit is used up");
  assert.equal(limited?.tone, "amber");
  assert.equal(limited?.fix, undefined);
});

test("the desk unreachable says only that, with Retry: what it said last is stale", () => {
  const down = { overview: overview(false, "boom", "error"), paused: { who: "claude" as const, why: LOGGED_OUT } };
  assert.deepEqual(ids({ ...down, offline: true }), ["desk:offline"]);
  assert.deepEqual(noticesOf({ ...fine, offline: true })[0]?.fix, { label: "Retry", run: "retry" });
  assert.deepEqual(ids({ ...down, offline: true, source: { dir: "/Users/x/code/desk", state: "running" } }), ["desk:restarting"]);
  const stopped = noticesOf({ ...fine, offline: true, source: { dir: "/Users/x/code/desk", state: "failed", detail: "Error: boom" } })[0];
  assert.deepEqual([stopped?.sig, stopped?.log, stopped?.text?.includes("`~/code/desk`")], ["stopped", "Error: boom", true]);
  assert.deepEqual(ids({ starting: "the desk is syncing for the first time" }), ["desk:starting"]);
});

test("the rules: broken or with errors, Fix rules to their page, and none on that page", () => {
  const broken = noticesOf({ ...fine, broken: "config has errors: rules[0]: bad" })[0];
  assert.equal(broken?.text, "There's nothing on your desk until they do. rules[0]: bad");
  assert.deepEqual(broken?.fix, { label: "Fix rules", href: "#/settings/rules" });
  assert.deepEqual(ids({ overview: overview(false, null, "ok", 2) }), ["rules:errors:2"]);
  assert.equal(noticesOf({ ...fine, overview: overview(false, null, "ok", 1) })[0]?.title, "Your rules have 1 error");
  assert.deepEqual(ids({ overview: overview(false, null, "ok", 2), page: "#/settings/rules" }), []);
  // In the order they matter: the rules, the agent, the sync.
  assert.deepEqual(ids({ overview: overview(false, "boom", "error", 1), paused: { who: "claude", why: LOGGED_OUT } }), [
    "rules:errors:1",
    "agent:claude",
    "sync:failed",
  ]);
});

test("a dismissed bubble stays gone while its condition holds, and comes back once it changes or resolves and recurs", () => {
  const paused = noticesOf({ ...fine, paused: { who: "claude", why: LOGGED_OUT } });
  let dismissed: Dismissed = { agent: "claude" };
  assert.deepEqual(undismissed(paused, dismissed), []);
  // Still there: the dismissal is kept, the same object, so nothing saves it again.
  assert.equal(forget(paused, dismissed), dismissed);
  // It changes: from logged out to AI reviews failing, it shows again.
  const changed = noticesOf({ ...fine, paused: { who: "ai", why: "out of usage" } });
  assert.equal(undismissed(changed, dismissed).length, 1);
  // Resolved: the dismissal goes, so the next time it's paused it shows.
  dismissed = forget(noticesOf(fine), dismissed);
  assert.deepEqual(dismissed, {});
  assert.equal(undismissed(paused, dismissed).length, 1);
  // A sync that keeps failing stays dismissed through its retries and new errors; turning rate limited shows it.
  const failing = (e: string, syncing = false) => noticesOf({ ...fine, overview: overview(syncing, e, syncing ? "syncing" : "error") });
  const sync = { sync: "failed" };
  assert.deepEqual(undismissed(failing("HTTP 502", true), sync), []);
  assert.deepEqual(undismissed(failing("HTTP 503"), sync), []);
  assert.equal(undismissed(noticesOf({ ...fine, overview: overview(false, "limited", "paused") }), sync).length, 1);
});

test("an action that failed: one bubble a message, the newest last, at most three, each fading on its own", () => {
  let list = withFailure([], "GitHub refused: not allowed", 1);
  assert.deepEqual(
    list.map((n) => [n.title, n.transient, n.tone]),
    [["GitHub refused: not allowed", true, "red"]],
  );
  list = withFailure(list, "b", 2);
  list = withFailure(list, "GitHub refused: not allowed", 3);
  assert.deepEqual(
    list.map((n) => n.title),
    ["b", "GitHub refused: not allowed"],
  );
  for (const [i, t] of ["c", "d", "e"].entries()) list = withFailure(list, t, 4 + i);
  assert.deepEqual(
    list.map((n) => n.title),
    ["c", "d", "e"],
  );
});
