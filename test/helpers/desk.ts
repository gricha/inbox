// A Desk over a FakeGitHub in a temp home, with a clock the test moves.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Desk, type DeskOptions } from "../../src/desk.ts";
import type { Item } from "../../src/types.ts";
import { FakeGitHub, hoursAgo, makeItem, NOW } from "./items.ts";
import { run } from "./run.ts";

export const reviewAsk = (n: number, o: Partial<Item> = {}) =>
  makeItem({
    number: n,
    author: "carol",
    review_requests: [{ reviewer: "me", type: "user", codeowner: false }],
    request_events: [{ at: hoursAgo(n), actor: "carol", actor_bot: false, reviewer: "me", reviewer_type: "user" }],
    ...o,
  });
export const teamPing = (n: number) =>
  makeItem({ number: n, author: "carol", review_requests: [{ reviewer: "ml-team", type: "team", codeowner: true }] });
// Asked of dana: a ready PR nobody's asked to review comes back to you (pr.unasked), which few tests are about.
export const myPr = (n: number, o: Partial<Item> = {}) =>
  makeItem({
    number: n,
    repo: "acme/web",
    author: "me",
    head_author: "me",
    ci: "red",
    review_requests: [{ reviewer: "dana", type: "user", codeowner: false }],
    ...o,
  });

// Searches return what GitHub would: open items requested from you, and your own open PRs.
// `settings` is written to settings.json before the desk reads it; `desk` adds options (a writer).
export async function setup(items: Item[], extra: { settings?: Record<string, unknown>; desk?: Partial<DeskOptions> } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-test-"));
  if (extra.settings) fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify(extra.settings));
  const gh: FakeGitHub = new FakeGitHub(items, (q) => {
    const all = [...gh.items.values()].filter((i) => i.state === "open");
    if (q.includes("review-requested:@me") && !q.includes("-review-requested"))
      return all.filter((i) => i.review_requests.length).map((i) => i.id);
    if (q.includes("author:@me") && !q.includes("-author:@me")) return all.filter((i) => i.author === "me").map((i) => i.id);
    return [];
  });
  let now = NOW;
  gh.clock = () => now;
  const notes: string[] = [];
  const desk = new Desk({
    home,
    github: gh,
    now: () => now,
    notify: (_t, b) => {
      notes.push(b);
    },
    log: () => {},
    ...extra.desk,
  });
  await run(desk.init());
  return {
    desk,
    gh,
    notes,
    home,
    setNow: (d: Date) => {
      now = d;
    },
    cleanup: () => {
      desk.stop();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

// Lets a sync started in the background (by a save, a timer or the feed) finish.
export async function idle(desk: Desk) {
  while (desk.syncing) {
    await new Promise((r) => {
      setImmediate(r);
    });
  }
}
