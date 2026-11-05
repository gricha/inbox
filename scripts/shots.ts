// npm run shots [-- --url http://localhost:47823] [--out .shots] [--only queue,review]: visual QA.
// Screenshots every key state in light and dark at four window sizes, and each theme, and fails on sideways scrolling and
// console errors.
// Without --url it starts the mock API and Vite, so the data is the same on every run.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page, type Route } from "playwright-core";
import type { InflightView, QueueView, ReviewView } from "../src/types.ts";

const root = path.join(import.meta.dirname, "..");
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const out = path.resolve(arg("--out") ?? path.join(root, ".shots"));
const MOCK = Number(process.env.SHOTS_MOCK_PORT ?? 47830); // separate ports let two checkouts run shots at once
const VITE = Number(process.env.SHOTS_VITE_PORT ?? 5190);
const kids: ChildProcess[] = [];
const failures: string[] = [];

async function up(url: string, ms = 30_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise<void>((r) => {
      setTimeout(r, 200);
    });
  }
  throw new Error(`${url} didn't come up`);
}

async function start(): Promise<string> {
  const node = (args: string[], env: Record<string, string>) =>
    kids.push(spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: "ignore" }));
  // An AI review that never finishes during the run, so every theme and size shows it being written.
  node(["--disable-warning=ExperimentalWarning", "web/mock/server.ts"], { MOCK_PORT: String(MOCK), MOCK_AI_MS: "3600000" });
  node(["node_modules/vite/bin/vite.js", "--config", "web/vite.config.ts", "--port", String(VITE), "--strictPort"], {
    DESK_API: `http://127.0.0.1:${MOCK}`,
  });
  await up(`http://127.0.0.1:${MOCK}/health`);
  await up(`http://localhost:${VITE}/`);
  return `http://localhost:${VITE}`;
}

// The queue has loaded: its rows, or its one empty line.
const READY = ".queue .line, .queue .queue-empty";

interface Shot {
  name: string;
  go: (page: Page) => Promise<void>;
  after?: (page: Page) => Promise<void>; // puts back what `go` changed in the mock
  writes?: true; // changes the desk's settings, policy or state: only against the mock, never a real desk at --url
}
const at = (hash: string) => async (page: Page) => {
  await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
  await page.waitForTimeout(400);
};
// A PR's review, once Pierre has drawn and highlighted its diffs.
const review =
  (id: string, keys: string[] = []) =>
  async (page: Page) => {
    await at(`#/review/${encodeURIComponent(id)}`)(page);
    await page.locator(".rv-diff").first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(900);
    for (const k of keys) {
      await page.keyboard.press(k);
      await page.waitForTimeout(250);
    }
  };
// AI reviews paused, as after an expired login: a mock-only switch (web/mock/server.ts).
const pauseAi = (paused: boolean) => async (page: Page) => {
  await page.evaluate(`fetch("/api/mock/ai-paused", { method: "POST", body: JSON.stringify({ paused: ${paused} }) })`);
  await page.locator(".ai-paused").waitFor({ state: paused ? "visible" : "detached", timeout: 5000 });
};
// The queue as the mock serves it, changed in the browser: for states the mock's data doesn't reach.
const queueAs = (change: (q: QueueView) => void) => async (page: Page) => {
  await page.route("**/api/queue", async (route) => {
    const res = await route.fetch();
    const q = (await res.json()) as QueueView;
    change(q);
    await route.fulfill({ response: res, json: q });
  });
  await page.reload();
  await page.locator(READY).first().waitFor({ timeout: 15_000 });
};
// The desk slow to answer: GETs matching `glob` wait until `release` lets them go. A reload first, so nothing the page
// already fetched (a review a row's rest prefetched) stands in for them.
const held: Route[] = [];
const hold = async (page: Page, glob: string) => {
  await page.route(glob, (route) => {
    held.push(route);
  });
  await page.reload();
};
// The queue in a fresh page: nothing a changed answer left behind stands in for the next shot's.
const fresh = async (page: Page) => {
  await page.evaluate(`location.hash = "#/"`);
  await page.reload();
  await page.locator(READY).first().waitFor({ timeout: 15_000 });
};
const release = (glob: string) => async (page: Page) => {
  await page.unroute(glob);
  for (const r of held.splice(0)) await r.continue().catch(() => {}); // a reload dropped it
  await fresh(page);
};
// Puts back what queueAs, reviewAs and the like changed; a live update refetching mid-handler just then fulfills too late.
const unroute = (page: Page) => page.unrouteAll({ behavior: "ignoreErrors" });
// A review as the mock serves it, changed in the browser.
const reviewAs = (change: (v: ReviewView) => void) => async (page: Page) => {
  await page.route("**/api/review/**", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const res = await route.fetch();
    const v = (await res.json()) as ReviewView;
    change(v);
    await route.fulfill({ response: res, json: v });
  });
  await page.reload(); // nothing fetched before this stands in for it
  await page.locator(READY).first().waitFor({ timeout: 15_000 });
};
// The queue folds after its first ten: open it for a row that sits behind the line.
const unfold = async (page: Page) => {
  const fold = page.locator(".queue .fold");
  if (await fold.isVisible()) await fold.click();
  await page.waitForTimeout(200);
};
// The fold is per window: a reload folds the queue again for the shots after this one.
const refold = async (page: Page) => {
  await page.reload();
  await page.locator(READY).first().waitFor({ timeout: 15_000 });
};
// Scrolled to the end, the last thing on the page ends near the window's bottom: no empty room to scroll into.
const BOTTOM_ROOM = 160;
const toBottom = (name: string) => async (page: Page) => {
  await page.evaluate("scrollTo(0, document.documentElement.scrollHeight)");
  await page.waitForTimeout(300);
  const room = await page.evaluate<number | null>(`(() => {
    if (document.documentElement.scrollHeight <= innerHeight + 1) return null; // nothing to scroll
    const main = document.querySelector(".main");
    const pinned = (el) => {
      for (let p = el; p && p !== main; p = p.parentElement) if (["sticky", "fixed"].includes(getComputedStyle(p).position)) return true;
      return false;
    };
    // What you can see: text, a field, a diff (its shadow root); an empty placeholder line isn't content.
    const seen = (el) => el.textContent.trim() || el.shadowRoot || ["TEXTAREA", "INPUT", "SELECT", "IMG", "CANVAS"].includes(el.tagName);
    let end = 0;
    for (const el of main.querySelectorAll("*")) {
      if (el.children.length || pinned(el) || !seen(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.height) end = Math.max(end, r.bottom);
    }
    return Math.round(innerHeight - end);
  })()`);
  if (room !== null && room > BOTTOM_ROOM)
    failures.push(`${name}: ${room}px of empty page below the last content when scrolled to the bottom`);
};
// The review's sidebar back to its default for the window's width: what f chose is kept per device.
const sideDefault = async (page: Page) => {
  await page.evaluate(`localStorage.removeItem("desk.review.side")`);
};
// A fresh page, for a shot that left a write held: the queue as the mock has it.
const reload = async (page: Page) => {
  await page.evaluate(`location.hash = "#/"`);
  await page.reload();
  await page.locator(READY).first().waitFor({ timeout: 15_000 });
};
const top = async (page: Page) => {
  await page.evaluate("scrollTo(0, 0)");
};
// A theme picked in Settings → Appearance, as its select sets it; `after` puts System back.
const pickTheme = (id: string) => async (page: Page) => {
  await page.evaluate(`localStorage.setItem("desk.theme", ${JSON.stringify(id)}); location.hash = "#/"`);
  await page.reload();
  await page.locator(READY).first().waitFor({ timeout: 15_000 });
};
const systemTheme = async (page: Page) => {
  await page.evaluate(`localStorage.removeItem("desk.theme"); location.hash = "#/"`);
  await page.reload();
  await page.locator(READY).first().waitFor({ timeout: 15_000 });
};
const SHOTS: Shot[] = [
  { name: "queue", go: at("#/") },
  {
    // j j from the top: the selected row's calm fill, and the rows stay evenly spaced.
    name: "queue-selected",
    go: async (page) => {
      await at("#/")(page);
      await top(page);
      await page.locator(".queue [data-id]").first().locator(".row-main").focus();
      for (const k of ["j", "j"]) {
        await page.keyboard.press(k);
        await page.waitForTimeout(250);
      }
      // Within each part's sheet: the parts have room between them.
      const gaps = await page.evaluate<number[]>(`(() => [...document.querySelectorAll(".queue .lines")].flatMap((sheet) => {
        const rows = [...sheet.querySelectorAll(":scope > [data-id]")].map((el) => el.getBoundingClientRect());
        return rows.slice(1).map((r, i) => Math.round(r.top - rows[i].bottom));
      }))()`);
      if (gaps.length && Math.max(...gaps) - Math.min(...gaps) > 1)
        failures.push(`queue-selected: uneven gaps between the queue's rows: ${gaps.join(", ")}px`);
    },
  },
  {
    // Nothing in the queue: one line, with no 0.
    name: "queue-empty",
    go: async (page) => {
      await queueAs((q) => {
        q.sections.now = [];
        q.sections.today = [];
      })(page);
      await top(page);
    },
    after: async (page) => {
      await unroute(page);
      await page.reload();
      await page.locator(READY).first().waitFor({ timeout: 15_000 });
    },
  },
  {
    // PRs held back until Claude has reviewed them: one quiet line under the queue.
    name: "queue-reviewing",
    go: async (page) => {
      await queueAs((q) => {
        q.reviewing = 3;
      })(page);
      await toBottom("queue-reviewing")(page);
    },
    after: async (page) => {
      await unroute(page);
      await page.reload();
      await page.locator(READY).first().waitFor({ timeout: 15_000 });
    },
  },
  {
    // Nothing on the queue yet, one on its way.
    name: "queue-empty-reviewing",
    go: async (page) => {
      await queueAs((q) => {
        q.sections.now = [];
        q.sections.today = [];
        q.reviewing = 1;
      })(page);
      await top(page);
    },
    after: async (page) => {
      await unroute(page);
      await page.reload();
      await page.locator(READY).first().waitFor({ timeout: 15_000 });
    },
  },
  {
    // The first load while the desk is slow: quiet rows where the rows will be.
    name: "queue-loading",
    go: async (page) => {
      await hold(page, "**/api/queue");
      await page.locator(".queue .sk-row").first().waitFor();
      await page.waitForTimeout(600); // the placeholders show only once the wait is noticeable
    },
    after: release("**/api/queue"),
  },
  {
    // The cursor on the queue's "n more" line, then Enter opens the rest in place.
    name: "queue-fold",
    go: async (page) => {
      await at("#/")(page);
      await page.locator(".queue .fold").focus();
      await page.locator(".queue .fold").scrollIntoViewIfNeeded();
    },
  },
  {
    name: "queue-unfolded",
    go: async (page) => {
      await at("#/")(page);
      await page.locator(".queue .fold").focus();
      await page.keyboard.press("Enter");
      await page.waitForTimeout(200);
    },
    after: refold,
  },
  {
    // The end of the queue: its last rows and the fold line, then the window's edge.
    name: "queue-bottom",
    go: async (page) => {
      await at("#/")(page);
      await toBottom("queue-bottom")(page);
    },
  },
  {
    // One line above the queue instead of a note on every card.
    name: "queue-ai-paused",
    writes: true,
    go: async (page) => {
      await at("#/")(page);
      await pauseAi(true)(page);
      await top(page);
    },
    after: pauseAi(false),
  },
  {
    // Enter on a PR opens its review; an issue still opens in place.
    name: "expanded",
    go: async (page) => {
      await at("#/")(page);
      await unfold(page);
      await page.locator(".line", { hasText: "Worker OOM on large batches" }).locator(".row-main").click();
      await page.waitForTimeout(400);
    },
  },
  {
    // w on an issue opened in place: the comment bar at the window's bottom.
    name: "issue-comment",
    after: refold,
    go: async (page) => {
      await at("#/")(page);
      await unfold(page);
      await page.locator(".line", { hasText: "Worker OOM on large batches" }).locator(".row-main").click();
      await page.waitForTimeout(400);
      await page.keyboard.press("w");
      await page.keyboard.type("The OOM is in the batcher: I'll cap the batch at 500 rows today.");
      await page.waitForTimeout(200);
    },
  },
  { name: "review", go: review("acme/api#4127") },
  {
    // Opened while the desk fetches its diff: the row's header and AI read at once, quiet placeholders for the rest.
    name: "review-loading",
    go: async (page) => {
      await hold(page, "**/api/review/**");
      await page.locator(READY).first().waitFor({ timeout: 15_000 });
      await at(`#/review/${encodeURIComponent("acme/api#4127")}`)(page);
      await page.waitForTimeout(300);
    },
    after: release("**/api/review/**"),
  },
  {
    // An agent's hand-off: who sent it and what it needs from you, under the why and facts.
    name: "review-handoff",
    go: async (page) => {
      await reviewAs((v) => {
        v.card.handoff = { why: "needs your call on the token transport before it merges", from: "seer write gate" };
      })(page);
      await at(`#/review/${encodeURIComponent("acme/api#4127")}`)(page);
      await page.locator(".rv-diff").first().waitFor({ timeout: 15_000 });
    },
    after: async (page) => {
      await unroute(page);
      await fresh(page);
    },
  },
  {
    // Nothing to show yet: no comments, no AI review, no files, one quiet line each.
    name: "review-empty",
    go: async (page) => {
      await reviewAs((v) => {
        Object.assign(v, { files: [], conversation: [], ai: null, ai_stale: false, generating: false, ai_error: null });
        v.order = { ...v.order, ranked: false, chunks: [], unread: [], skipped: [], rest: [], notes: [] };
        v.item = { ...v.item, additions: 0, deletions: 0, changed_files: 0 };
      })(page);
      await at(`#/review/${encodeURIComponent("acme/api#4127")}`)(page);
    },
    after: async (page) => {
      await unroute(page);
      await fresh(page);
    },
  },
  {
    // The last file ends at the window's bottom: no empty room below it to scroll into.
    name: "review-bottom",
    go: async (page) => {
      await review("acme/api#4127")(page);
      await toBottom("review-bottom")(page);
    },
  },
  { name: "review-note", go: review("acme/api#4127", ["]", "]", "]"]) },
  {
    // The + by a line's number: a box under that line, below the thread already on it.
    name: "review-inline",
    go: async (page) => {
      await review("acme/api#4127")(page);
      const plan = page.locator('.rv-file-sec[aria-label="src/planner/plan.ts"]').first();
      const line = plan.locator('div[data-line="23"]').last();
      await line.scrollIntoViewIfNeeded();
      const plus = plan.locator("[data-utility-button]").first();
      for (let i = 0; i < 10 && !(await plus.count()); i++) {
        await page.mouse.move(0, 0);
        await line.hover();
        await page.waitForTimeout(150);
      }
      await plus.click();
      await page.locator(".rv-inline textarea").waitFor();
      await page.keyboard.type("Return how many rows the stream had read when the budget ran out?");
      await page.waitForTimeout(300);
    },
  },
  // Z: every file folded to its header.
  { name: "review-files-folded", go: review("acme/api#4127", ["Z"]) },
  // Your own draft's one call to action is Ready for review; your ready PR's is Hand off for merge.
  { name: "review-draft", go: review("acme/web#2303") },
  // @ opens GitHub's suggested reviewers for your draft.
  {
    name: "review-reviewers",
    go: async (page) => {
      await review("acme/web#2303")(page);
      await page.keyboard.press("@");
      await page.locator(".rv-reviewers-pop .pop-item").first().waitFor();
    },
  },
  // Reviewers picked by typing: a person GitHub suggested and a team.
  {
    name: "review-reviewers-picked",
    go: async (page) => {
      await review("acme/web#2303")(page);
      const box = page.locator(".rv-reviewers-input");
      for (const q of ["da", "back"]) {
        await box.fill(q);
        await page.locator(".rv-reviewers-pop .pop-item").first().waitFor();
        await page.waitForTimeout(250);
        await box.press("Enter");
      }
      await box.press("Escape");
    },
  },
  // a: it's off your desk at once; the review stays, saying what you did and where it went, its spinner while GitHub (here
  // never) answers. The held request stays held (unrouting would let it through to the mock); a reload brings the row back.
  {
    name: "review-ready-sent",
    go: async (page) => {
      await page.route("**/ready", () => {});
      await review("acme/web#2303", ["a"])(page);
      await page.waitForTimeout(300);
    },
    after: reload,
  },
  { name: "review-mine", go: review("oss/tinyhttp#205") },
  // Your PR where reviewers wait on you: Claude's read and a reply box each, the rest one quiet line, opened here.
  {
    name: "review-conversation",
    go: async (page) => {
      await review("me/notes-app#12")(page);
      await page.locator(".rv-convo .rv-more").click();
      await page.locator(".cv-said").first().locator("summary").click();
      await page.waitForTimeout(200);
    },
  },
  {
    name: "review-conversation-fold",
    go: async (page) => {
      await review("me/notes-app#12")(page);
      // The review before it is the same PR, still mounted with its fold open.
      const fold = page.locator(".rv-convo .rv-more");
      if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
      await page.locator(".cv-quiet").last().locator("summary").click();
      await page.evaluate(`document.querySelector(".rv-convo .rv-more").scrollIntoView({ block: "center" })`);
      await page.waitForTimeout(200);
    },
  },
  // n goes to the next change in reading order; the sidebar lists a file at the repo's root and a long folder.
  { name: "review-python", go: review("acme/ml-pipeline#311", ["n"]) },
  // In a stack: its place after the ref, and the chain in the sidebar, this PR marked.
  { name: "review-stack", go: review("acme/api#4154") },
  // n past the last change stops on the folded rest's line; Enter opens it in place.
  { name: "review-fold", go: review("acme/api#4127", ["n", "n", "n", "n", "n"]) },
  { name: "review-rest", go: review("acme/api#4127", ["n", "n", "n", "n", "n", "Enter"]) },
  {
    // A capped ranking: what Claude didn't read, then the fold that says some may still be worth a look.
    name: "review-unread",
    go: async (page) => {
      await review("acme/worker#879")(page);
      await toBottom("review-unread")(page);
    },
  },
  {
    // f: folded where it was open (wide), open over the diff where it starts folded (narrow); f again puts it back.
    name: "review-side-toggled",
    go: review("acme/api#4154", ["f"]),
    after: sideDefault,
  },
  {
    // Rule whys are yours to write and can run long: a fact that wraps carries on after its "·", never under it.
    name: "review-long-why",
    go: async (page) => {
      await review("acme/api#4127")(page);
      await page.evaluate(
        `document.querySelector(".rv-meta .why").textContent = "close collaborator: you engaged with 128 of their PRs in 90 days, and the observability team wants your eyes on the query explorer directly"`,
      );
    },
  },
  {
    // Enter from the queue on a PR with no AI review yet: it's being written.
    name: "review-writing",
    go: async (page) => {
      await at("#/")(page);
      await unfold(page);
      await page.locator(".line", { hasText: "Virtualize the issue stream list" }).locator(".row-main").focus();
      await page.keyboard.press("Enter");
      await page.locator(".rv-diff").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(600);
    },
  },
  {
    // The menu opens under the row.
    name: "snooze",
    go: async (page) => {
      await at("#/")(page);
      await page.locator(".line", { hasText: "Support HTTP/2 prior knowledge" }).locator(".row-main").focus();
      await page.keyboard.press("s");
      await page.waitForTimeout(200);
    },
  },
  {
    // g a: the Archive, what you finished and what resolved, newest first.
    name: "archive",
    go: async (page) => {
      await at("#/")(page);
      await page.keyboard.press("g");
      await page.keyboard.press("a");
      await page.locator(".g-archive").waitFor();
      await page.waitForTimeout(200);
    },
  },
  {
    // Enter on a resolved PR in the Archive: its review says why it resolved, and when, under the facts.
    name: "review-resolved",
    go: async (page) => {
      await at("#/archive")(page);
      const row = page.locator(".g-archive .line", { hasText: "Tighten the CSP" }).locator(".row-main");
      await row.click();
      await page.locator(".rv-diff").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(600);
    },
  },
  {
    // A PR's recent activity, every line of it.
    name: "review-activity",
    go: async (page) => {
      await review("acme/api#4127")(page);
      if (!(await page.locator(".rv-side").isVisible())) await page.keyboard.press("f"); // folded in a narrow window
      await page.locator(".rv-side .rv-more").click();
      await page.waitForTimeout(200);
    },
    after: sideDefault,
  },
  // What Claude and the rules sorted away, on its own page.
  { name: "later", go: at("#/later") },
  {
    name: "later-empty",
    go: async (page) => {
      await queueAs((q) => {
        q.sections.later = [];
        q.sections.fyi = [];
        q.hidden = [];
        q.cleared = [];
        q.resolved = [];
      })(page);
      await at("#/later")(page);
    },
    after: async (page) => {
      await unroute(page);
      await page.reload();
      await page.locator(READY).first().waitFor({ timeout: 15_000 });
    },
  },
  // Merging: what each waits on and the coordinator's latest note, one merged.
  { name: "inflight", go: at("#/inflight") },
  {
    name: "inflight-empty",
    go: async (page) => {
      await page.route("**/api/inflight", async (route) => {
        const res = await route.fetch();
        const v = (await res.json()) as InflightView;
        v.rows = [];
        await route.fulfill({ response: res, json: v });
      });
      await at("#/inflight")(page);
    },
    after: async (page) => {
      await unroute(page);
    },
  },
  {
    // claude couldn't start or resume it: the line says why, in red.
    name: "inflight-coord-error",
    go: async (page) => {
      await page.route("**/api/inflight", async (route) => {
        const res = await route.fetch();
        const v = (await res.json()) as InflightView;
        v.coordinator.error =
          "Workspace not trusted. Run `claude` in /Users/you/.review-desk/coordinator once and accept the trust prompt, then retry.";
        await route.fulfill({ response: res, json: v });
      });
      await at("#/")(page); // from Merging itself the hash wouldn't change, so nothing would refetch
      await at("#/inflight")(page);
      await page.locator(".lane-coord-error").waitFor({ timeout: 5000 });
    },
    after: async (page) => {
      await unroute(page);
    },
  },
  {
    // The selected row's keys: Review, Open on GitHub, Back to desk.
    name: "inflight-selected",
    go: async (page) => {
      await at("#/inflight")(page);
      await page.keyboard.press("j");
      await page.waitForTimeout(200);
    },
  },
  {
    // The coordinator handed it back: at the top of the queue, one line like the rest.
    name: "handed-back",
    go: async (page) => {
      await at("#/")(page);
      await page.locator('.line[data-id="oss/tinyhttp#205"] .row-main').focus();
      await page.waitForTimeout(200);
    },
  },
  {
    // m on your own PR hands it off at once: the row leaves, a spinner in the toast while the desk (here never) answers.
    name: "handoff-sent",
    go: async (page) => {
      await page.route("**/api/act", async (route) => {
        if ((route.request().postDataJSON() as { action?: string }).action !== "inflight") await route.continue();
      });
      await at("#/")(page);
      await page.locator('.line[data-id="oss/tinyhttp#205"] .row-main').focus();
      await page.keyboard.press("m");
      await page.waitForTimeout(300);
    },
    after: reload,
  },
  {
    // An agent's question leads the main page; Enter opens its page: what it's about, all it said, its links, the answers.
    name: "inquiry",
    go: async (page) => {
      await at("#/")(page);
      await top(page);
      await page.locator(".queue .line.inq .row-main").first().focus();
      await page.keyboard.press("Enter");
      await page.locator(".inquiry .inq-options").waitFor();
      await page.waitForTimeout(200);
    },
    after: at("#/"),
  },
  {
    // A question with no answers to pick: the box to write in is ready.
    name: "inquiry-open",
    go: async (page) => {
      await at("#/inquiry/q2bead00")(page);
      await page.locator(".inquiry .inq-write textarea").waitFor();
      await page.waitForTimeout(200);
    },
    after: at("#/"),
  },
  {
    // 1 picks the agent's answer: the page stays and says so while it's sent. Held, so the mock's question waits for the next size.
    name: "inquiry-answered",
    go: async (page) => {
      await page.route("**/api/inquiries/*/answer", () => {});
      await at("#/inquiry/q1c0ffee")(page);
      await page.locator(".inquiry .inq-options").waitFor();
      await page.keyboard.press("1");
      await page.locator(".inq-answered").waitFor();
      await page.waitForTimeout(200);
    },
    after: reload,
  },
  {
    // Merged and closed ones under Merged, below the fold at every size.
    name: "inflight-landed",
    go: async (page) => {
      await at("#/inflight")(page);
      await page.evaluate(`document.querySelector(".lane h3").scrollIntoView({ block: "center" })`);
      await page.waitForTimeout(200);
    },
  },
  {
    name: "inflight-bottom",
    go: async (page) => {
      await at("#/inflight")(page);
      await toBottom("inflight-bottom")(page);
    },
  },
  {
    // Enter on a Merging row: its review says what Merging says, and Esc goes back there.
    name: "review-inflight",
    go: async (page) => {
      await at("#/inflight")(page);
      await page.locator('.lane [data-id="acme/api#4122"] .row-main').click();
      await page.keyboard.press("Enter");
      await page.locator(".rv-diff").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(600);
    },
  },
  {
    // t on a selected row: the composer to the coordinator, about that row.
    name: "ask-row",
    go: async (page) => {
      await at("#/")(page);
      await page.locator('.line[data-id="oss/tinyhttp#205"] .row-main').focus();
      await page.keyboard.press("t");
      await page.locator(".composer-input").waitFor();
      await page.keyboard.type("I think we addressed this in the follow-up, you can dismiss it");
      await page.waitForTimeout(300); // its rise in has run
    },
  },
  {
    // In a review, about the conversation you were on: sent, it waits for the answer under it.
    name: "ask-review",
    go: async (page) => {
      await page.route("**/api/ask", (route) =>
        route.fulfill({
          json: {
            ok: true,
            ask: {
              id: "shot0001",
              at: new Date().toISOString(),
              text: "Confirm we addressed priya's question so I can reply",
              item_id: "me/notes-app#12",
              thread_id: "IC_freeze",
              thread_url: null,
              answer: null,
            },
          },
        }),
      );
      await review("me/notes-app#12")(page);
      await page.locator(".cv-reply").nth(1).focus();
      await page.keyboard.press("Escape");
      await page.keyboard.press("t");
      await page.locator(".composer .ask", { hasText: "kai's naming nit" }).waitFor(); // its asks loaded, so they can't replace the one sent
      await page.keyboard.type("Confirm we addressed priya's question so I can reply");
      await page.keyboard.press("Enter");
      await page.locator(".composer .ask", { hasText: "priya's question" }).waitFor();
      await page.waitForTimeout(300); // its rise in has run
    },
    after: async (page) => {
      await page.unroute("**/api/ask");
    },
  },
  {
    // The coordinator off: the composer says so and sends nothing.
    name: "ask-off",
    go: async (page) => {
      await page.route("**/api/asks", (route) => route.fulfill({ json: { on: false, asks: [] } }));
      await at("#/inflight")(page);
      await page.keyboard.press("j");
      await page.keyboard.press("t");
      await page.locator(".composer-note").waitFor();
      await page.waitForTimeout(300); // its rise in has run
    },
    after: async (page) => {
      await page.unroute("**/api/asks");
    },
  },
  {
    name: "help",
    go: async (page) => {
      await at("#/")(page);
      await page.keyboard.press("?");
      await page.waitForTimeout(200);
    },
  },
  {
    // Your own draft's one call to action, Ready for review.
    name: "draft-cta",
    after: refold,
    go: async (page) => {
      await at("#/")(page);
      await unfold(page);
      await page.locator('.line[data-id="acme/web#2303"] .row-main').focus();
      await page.waitForTimeout(200);
    },
  },
  // a on its row: off the list at once, a spinner while GitHub (here never) answers. Held, as review-ready-sent's, so the
  // mock's draft stays a draft for the next size's shots.
  {
    name: "draft-cta-sent",
    go: async (page) => {
      await page.route("**/ready", () => {});
      await at("#/")(page);
      await unfold(page);
      await page.locator('.line[data-id="acme/web#2303"] .row-main').focus();
      await page.keyboard.press("a");
      await page.waitForTimeout(300);
    },
    after: reload,
  },
  {
    // A PR the policy judge placed: w opens it in place; its rule trace ends with the policy step.
    name: "judged",
    after: refold,
    go: async (page) => {
      await at("#/")(page);
      await unfold(page);
      await page.locator(".line", { hasText: "Rewrite the tokenizer with a state table" }).locator(".row-main").focus();
      await page.keyboard.press("w");
      await page.locator(".trace-toggle summary").first().click();
      await page.waitForTimeout(300);
    },
  },
  { name: "settings-github", go: at("#/settings/github") },
  { name: "settings-queue", go: at("#/settings/queue") },
  { name: "settings-rules", go: at("#/settings/rules") },
  { name: "settings-agent", go: at("#/settings/agent") },
  { name: "settings-policy", go: at("#/settings/policy") },
  { name: "settings-automations", go: at("#/settings/automations") },
  {
    // An automation's runs: its instruction, what each run found, and what came of each item.
    name: "settings-automations-runs",
    go: async (page) => {
      await at("#/settings/automations")(page);
      await page.locator(".au-main").first().click();
      await page.locator(".au-runs").waitFor();
      await page.locator(".au-runs").scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
    },
    after: at("#/"),
  },
  {
    // policy.md empty: the editor holds the starter, and says so.
    name: "settings-policy-starter",
    writes: true,
    go: async (page) => {
      await page.evaluate(`(async () => {
        const p = await (await fetch("/api/policy")).json();
        window.__policy = p.text;
        await fetch("/api/policy", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "", base: p.hash }) });
      })()`);
      await at("#/settings/agent")(page);
      await at("#/settings/policy")(page);
    },
    after: async (page) => {
      await page.evaluate(`(async () => {
        const p = await (await fetch("/api/policy")).json();
        await fetch("/api/policy", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: window.__policy, base: p.hash }) });
      })()`);
    },
  },
  { name: "settings-app", go: at("#/settings/app") },
  { name: "settings-appearance", go: at("#/settings/appearance") },
  { name: "settings-review", go: at("#/settings/review") },
  {
    // Settings is one page: its end, Rules and Policy above it.
    name: "settings-bottom",
    go: async (page) => {
      await at("#/settings/review")(page);
      await toBottom("settings-bottom")(page);
    },
  },
  {
    // Paused after failures in a row: one line, its label in ink, said once.
    name: "settings-review-paused",
    writes: true,
    go: async (page) => {
      await at("#/")(page);
      await pauseAi(true)(page);
      await at("#/settings/review")(page);
      await page.evaluate(`document.querySelector("#s-review").scrollIntoView()`);
      await page.waitForTimeout(200);
    },
    after: pauseAi(false),
  },
  {
    name: "settings-policy-paused",
    writes: true,
    go: async (page) => {
      await at("#/")(page);
      await pauseAi(true)(page);
      await at("#/settings/policy")(page);
    },
    after: pauseAi(false),
  },
  {
    // Snoozed or muted, under Later, with until when.
    name: "cleared",
    go: async (page) => {
      await at("#/later")(page);
      await page.keyboard.press("g");
      await page.keyboard.press("x");
      await page.waitForTimeout(300);
      await page.locator(".g-cleared").scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
    },
  },
  // The More menu (.): on your PR's review, on the queue's selected row, and on an old PR of yours under Later.
  { name: "more-review", go: review("acme/worker#875", ["."]) },
  {
    name: "more-row",
    after: refold,
    go: async (page) => {
      await at("#/")(page);
      await unfold(page); // your PRs come after what waits on your review
      await page.locator('.line[data-id="acme/worker#875"] .row-main').focus();
      await page.keyboard.press(".");
      await page.waitForTimeout(200);
    },
  },
  {
    // Your draft: Ready for review in its More menu too.
    name: "more-draft",
    after: refold,
    go: async (page) => {
      await at("#/")(page);
      await unfold(page);
      await page.locator('.line[data-id="acme/web#2303"] .row-main').focus();
      await page.keyboard.press(".");
      await page.waitForTimeout(200);
    },
  },
  {
    name: "more-later",
    go: async (page) => {
      await at("#/later")(page);
      await page.locator('.line[data-id="acme/api#4040"] .row-main').focus();
      await page.keyboard.press(".");
      await page.waitForTimeout(200);
    },
  },
  {
    // Request changes on someone else's PR: what you write, sent twice.
    name: "review-request-changes",
    go: async (page) => {
      await review("acme/api#4127", [".", "x"])(page);
      await page.keyboard.type("The retry loop never gives up: cap it, and add a test for the cap.");
      await page.waitForTimeout(200);
    },
  },
  {
    // The sidebar after use: Later opened from it, then a Settings page. Only the page you're on gets the pill.
    name: "sidebar-used",
    go: async (page) => {
      await at("#/")(page);
      const later = page.locator(".side-item", { hasText: "Later" });
      if (await later.isVisible()) await later.click();
      await at("#/settings/notify")(page);
    },
  },
  // Each theme picked on this device, over the system's light or dark: the queue, a row selected, and a review.
  ...["light", "dark", "sand", "slate"].flatMap((id): Shot[] => [
    {
      name: `theme-${id}`,
      go: async (page) => {
        await pickTheme(id)(page);
        await page.locator(".queue [data-id]").first().locator(".row-main").focus();
        await page.keyboard.press("j");
      },
      after: systemTheme,
    },
    {
      name: `theme-${id}-review`,
      go: async (page) => {
        await pickTheme(id)(page);
        await review("acme/api#4127")(page);
      },
      after: systemTheme,
    },
    {
      name: `theme-${id}-inflight`,
      go: async (page) => {
        await pickTheme(id)(page);
        await at("#/inflight")(page);
        await page.keyboard.press("j");
      },
      after: systemTheme,
    },
  ]),
  // The More menu open in a review, its keys on it.
  { name: "more-menu", go: review("acme/worker#875", ["."]) },
  // Right-click a row: its actions at the pointer, Snooze open to the side with what this PR can wait on.
  {
    name: "row-menu",
    go: async (page) => {
      await at("#/")(page);
      await page.locator(".line", { hasText: "Drop the legacy v1 auth" }).locator(".row-main").click({ button: "right" });
      await page.locator(".ctx-has-sub").hover();
      await page.locator(".ctx-sub").waitFor();
      await page.waitForTimeout(200);
    },
    after: async (page) => {
      await page.keyboard.press("Escape");
    },
  },
  // a approves at once: the review stays, its Approve now what you did, in the Archive, a spinner while GitHub (here never)
  // answers. Last: its toast would sit over the next shot.
  {
    name: "review-approve",
    go: async (page) => {
      await page.route("**/approve", () => {});
      await review("acme/api#4127", ["a"])(page);
    },
  },
];
const SIZES = [
  { name: "wide", width: 1280, height: 820, mac: false },
  { name: "mid", width: 900, height: 700, mac: false },
  { name: "min", width: 780, height: 600, mac: false },
  // What the owner sees: the desktop app on macOS, which pads for the traffic lights.
  { name: "mac", width: 1280, height: 820, mac: true },
];

const files: string[] = [];
try {
  const real = arg("--url");
  const url = real ?? (await start());
  // --only keeps the shots whose names contain one of its words, for a quick loop on one page.
  const only = arg("--only")?.split(",");
  const shots = SHOTS.filter((s) => !(real && s.writes) && (!only || only.some((o) => s.name.includes(o))));
  if (!only) fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome" });
  for (const theme of ["light", "dark"] as const) {
    for (const size of SIZES) {
      const page = await browser.newPage({
        viewport: { width: size.width, height: size.height },
        colorScheme: theme,
        deviceScaleFactor: 2,
      });
      // Init scripts run before <html> exists, so set the desktop markers once it does.
      if (size.mac) {
        await page.addInitScript(
          `document.addEventListener("DOMContentLoaded", () => { document.documentElement.dataset.shell = "desktop"; document.documentElement.dataset.platform = "darwin"; });`,
        );
      }
      page.on("console", (m) => {
        if (m.type() === "error") failures.push(`${theme}/${size.name}: console error: ${m.text()}`);
      });
      await page.goto(`${url}/#/`);
      await page.locator(READY).first().waitFor({ timeout: 15_000 });
      for (const shot of shots) {
        await page.keyboard.press("Escape");
        await shot.go(page);
        await page.mouse.move(0, 0); // no hover state left over from a click
        const file = `${theme}-${size.name}-${shot.name}.png`;
        await page.screenshot({ path: path.join(out, file) });
        files.push(file);
        const sideways = await page.evaluate<number>("document.documentElement.scrollWidth - innerWidth");
        if (sideways > 0) failures.push(`${file}: the page scrolls sideways by ${sideways}px`);
        await shot.after?.(page);
      }
      await page.close();
    }
  }
  await browser.close();
  const sheet = files.map((f) => `<figure><img src="${f}" loading="lazy"><figcaption>${f}</figcaption></figure>`).join("\n");
  fs.writeFileSync(
    path.join(out, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Review Desk shots</title><style>body{font:13px system-ui;margin:24px;display:grid;grid-template-columns:repeat(auto-fill,minmax(480px,1fr));gap:24px}img{width:100%;border:1px solid #ccc}figure{margin:0}</style>${sheet}`,
  );
  console.log(`${files.length} shots in ${out} (open index.html)`);
} finally {
  for (const k of kids) k.kill();
}
if (failures.length) {
  console.error(`\n${failures.length} problem(s):\n${failures.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("no problems found");
