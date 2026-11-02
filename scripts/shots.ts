// npm run shots [-- --url http://localhost:47823] [--out .shots]: visual QA.
// Screenshots every key state in light and dark at two window sizes, zooms into every highlighter mark at 3x,
// and fails on clipped or short highlight bands, sideways scrolling and console errors.
// Without --url it starts the mock API and Vite, so the data is the same on every run.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright-core";
import type { QueueView } from "../src/types.ts";

const root = path.join(import.meta.dirname, "..");
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const out = path.resolve(arg("--out") ?? path.join(root, ".shots"));
const MOCK = Number(process.env.SHOTS_MOCK_PORT ?? 47830); // separate ports let two checkouts run shots at once
const VITE = Number(process.env.SHOTS_VITE_PORT ?? 5190);
const kids: ChildProcess[] = [];

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

// Every highlighter mark: the ::before band must cover the text and nothing may clip it.
// Page code is a string: this project's tsconfig has no DOM types, on purpose (the server mustn't touch them).
const HIGHLIGHTS = ".b-now .ref-ink, .g-now > .group-head > span:first-child";
const CHECK_HIGHLIGHTS = `(() => {
  const problems = [];
  const px = (v) => Number.parseFloat(v) || 0;
  for (const el of document.querySelectorAll(${JSON.stringify(HIGHLIGHTS)})) {
    const pseudo = getComputedStyle(el, "::before");
    if (pseudo.content === "none") continue;
    const box = el.getBoundingClientRect();
    if (!box.width) continue; // not rendered at this size
    const band = { left: box.left + px(pseudo.left), right: box.right - px(pseudo.right), top: box.top + px(pseudo.top), bottom: box.bottom - px(pseudo.bottom) };
    const range = document.createRange();
    range.selectNodeContents(el);
    // Only the text you can see: an ellipsis hides the rest of a long repo name.
    const r = range.getBoundingClientRect();
    const text = { left: Math.max(r.left, box.left), right: Math.min(r.right, box.right), top: r.top, bottom: r.bottom };
    const name = '"' + el.textContent + '"';
    if (band.top > text.top + 0.5 || band.bottom < text.bottom - 0.5) problems.push(name + ": the band doesn't cover the text's height");
    if (band.left > text.left - 2 || band.right < text.right + 2) problems.push(name + ": the band doesn't run past both ends of the text");
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const st = getComputedStyle(p);
      if (st.overflowX === "visible" && st.overflowY === "visible") continue;
      const r = p.getBoundingClientRect();
      // 1px of slack for the stroke's tilt
      if (band.left < r.left - 1 || band.right > r.right + 1 || band.top < r.top - 1 || band.bottom > r.bottom + 1) {
        problems.push(name + ': clipped by <' + p.tagName.toLowerCase() + ' class="' + p.className + '">');
        break;
      }
    }
  }
  return problems;
})()`;

interface Shot {
  name: string;
  go: (page: Page) => Promise<void>;
  after?: (page: Page) => Promise<void>; // puts back what `go` changed in the mock
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
  await page.locator(".queue h2").first().waitFor({ timeout: 15_000 });
};
// Now and Today fold after their first five: open them for a card that sits behind a line.
const unfoldNow = async (page: Page) => {
  for (const g of [".g-now", ".g-today"]) {
    const fold = page.locator(`${g} .fold`);
    if (await fold.isVisible()) await fold.click();
  }
  await page.waitForTimeout(200);
};
// A setting changed through the API, as Settings would; `after` puts it back.
const setting = (key: string, value: unknown) => async (page: Page) => {
  await page.evaluate(
    `fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(${JSON.stringify(
      value === undefined ? { reset: [key] } : { set: { [key]: value } },
    )}) })`,
  );
  await page.waitForTimeout(300);
};
const top = async (page: Page) => {
  await page.evaluate("scrollTo(0, 0)");
};
const SHOTS: Shot[] = [
  { name: "queue", go: at("#/") },
  {
    // A selected card the AI says to look at closely: its whole review, its facts and its keys.
    name: "queue-selected",
    go: async (page) => {
      await at("#/")(page);
      await page.locator(".row", { hasText: "Rewrite the tokenizer with a state table" }).locator(".row-main").focus();
      await page.waitForTimeout(200);
    },
  },
  {
    // Nothing in Now: one line, with no highlighter.
    name: "queue-empty",
    go: async (page) => {
      await queueAs((q) => {
        q.sections.now = [];
      })(page);
      await top(page);
    },
    after: async (page) => {
      await page.unroute("**/api/queue");
      await page.reload();
      await page.locator(".queue h2").first().waitFor({ timeout: 15_000 });
    },
  },
  {
    // The cursor on Today's "n more for today" line, then Enter opens the rest in place.
    name: "queue-fold",
    go: async (page) => {
      await at("#/")(page);
      await page.locator(".g-today .fold").focus();
      await page.locator(".g-today .fold").scrollIntoViewIfNeeded();
    },
  },
  {
    name: "queue-today",
    go: async (page) => {
      await at("#/")(page);
      await page.locator(".g-today .fold").focus();
      await page.keyboard.press("Enter");
      await page.waitForTimeout(200);
      await page.locator(".g-today").scrollIntoViewIfNeeded();
    },
    // The fold is per window: a reload folds Today again for the shots after this one.
    after: async (page) => {
      await page.reload();
      await page.locator(".queue h2").first().waitFor({ timeout: 15_000 });
    },
  },
  {
    // A stack behind Today's line: three PRs from one author on one sheet, under one line that says why.
    name: "queue-stack",
    go: async (page) => {
      await at("#/")(page);
      await unfoldNow(page);
      await page.locator(".run", { hasText: "3 PRs from rosa" }).scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
    },
    after: async (page) => {
      await page.reload();
      await page.locator(".queue h2").first().waitFor({ timeout: 15_000 });
    },
  },
  {
    // Tab from the selected card lands on its first key: the cursor's fill and ring, clear of the letters.
    name: "queue-tab-key",
    go: async (page) => {
      await at("#/")(page);
      await page.locator(".row", { hasText: "Support HTTP/2 prior knowledge" }).locator(".row-main").focus();
      await page.keyboard.press("Tab");
      await page.waitForTimeout(200);
    },
  },
  {
    // One line above the queue instead of a note on every card.
    name: "queue-ai-paused",
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
      await unfoldNow(page);
      await page.locator(".row", { hasText: "Worker OOM on large batches" }).locator(".row-main").click();
      await page.waitForTimeout(400);
    },
  },
  { name: "review", go: review("acme/api#4127") },
  { name: "review-note", go: review("acme/api#4127", ["]", "]", "]"]) },
  // n lands on requirements.txt: a file at the repo's root, with a long folder below it in the list.
  { name: "review-python", go: review("acme/ml-pipeline#311", ["n"]) },
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
      await unfoldNow(page);
      await page.locator(".row", { hasText: "Virtualize the issue stream list" }).locator(".row-main").focus();
      await page.keyboard.press("Enter");
      await page.locator(".rv-diff").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(600);
    },
  },
  {
    // The menu opens under the card, so its keys stay in view.
    name: "snooze",
    go: async (page) => {
      await at("#/")(page);
      await page.locator(".row", { hasText: "Support HTTP/2 prior knowledge" }).locator(".row-main").focus();
      await page.keyboard.press("s");
      await page.waitForTimeout(200);
    },
  },
  {
    // The Resolved group open, scrolled into view. Before "sorted-away" opens Later.
    name: "resolved",
    go: async (page) => {
      await at("#/")(page);
      await page.keyboard.press("g");
      await page.keyboard.press("d");
      await page.waitForTimeout(300);
      await page.locator(".g-resolved").scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
    },
  },
  {
    // Enter on a resolved PR: its review says why it resolved, and when, under the facts.
    name: "review-resolved",
    go: async (page) => {
      await at("#/")(page);
      const row = page.locator(".g-resolved .row", { hasText: "Tighten the CSP" }).locator(".row-main");
      if (!(await row.isVisible())) {
        await page.keyboard.press("g");
        await page.keyboard.press("d");
      }
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
      await page.locator(".rv-more").click();
      await page.waitForTimeout(200);
    },
  },
  {
    name: "sorted-away",
    go: async (page) => {
      await at("#/")(page);
      await page.keyboard.press("g");
      await page.keyboard.press("l");
      await page.waitForTimeout(300);
    },
  },
  // Your PRs in flight: a reply to send, a question, no local clone, CI being fixed, one waiting on reviewers, one landed.
  { name: "inflight", go: at("#/inflight") },
  {
    name: "inflight-question",
    go: async (page) => {
      await at("#/inflight")(page);
      await page.keyboard.press("j");
      await page.keyboard.press("j");
      await page.waitForTimeout(200);
    },
  },
  {
    // Merged and closed ones under Landed, below the fold at every size.
    name: "inflight-landed",
    go: async (page) => {
      await at("#/inflight")(page);
      await page.evaluate(`document.querySelector(".lane h3").scrollIntoView({ block: "center" })`);
      await page.waitForTimeout(200);
    },
  },
  {
    // Enter on a lane row: its review says what the lane says, and Esc goes back to the lane.
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
    name: "help",
    go: async (page) => {
      await at("#/")(page);
      await page.keyboard.press("?");
      await page.waitForTimeout(200);
    },
  },
  {
    // The coordinator's line in the top bar (its latest run touched Today), opened: its recent log above the queue.
    name: "coordinator-log",
    go: async (page) => {
      await at("#/")(page);
      await page.locator(".coord-line").click();
      await page.locator(".cl-list li").first().waitFor({ timeout: 5000 });
    },
  },
  {
    // A PR the policy judge placed: w opens it in place; its rule trace ends with the policy step.
    name: "judged",
    go: async (page) => {
      await at("#/")(page);
      await page.locator(".row", { hasText: "Rewrite the tokenizer with a state table" }).locator(".row-main").focus();
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
  {
    // policy.md empty: the editor holds the starter, and says so.
    name: "settings-policy-starter",
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
  { name: "settings-inflight", go: at("#/settings/inflight") },
  { name: "settings-review", go: at("#/settings/review") },
  {
    // Paused after failures in a row: one line, its label in ink, said once.
    name: "settings-review-paused",
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
    // Logged out, the coordinator and the judge stop too: each says so in its one line, in ink, with when it tries again.
    name: "settings-agent-paused",
    go: async (page) => {
      await at("#/")(page);
      await pauseAi(true)(page);
      await at("#/settings/agent")(page);
    },
    after: pauseAi(false),
  },
  {
    name: "settings-policy-paused",
    go: async (page) => {
      await at("#/")(page);
      await pauseAi(true)(page);
      await at("#/settings/policy")(page);
    },
    after: pauseAi(false),
  },
  {
    // Babysitting off: the intro says so once, a PR that needs you has its problem as its why, nothing says "watching".
    name: "inflight-babysit-off",
    go: async (page) => {
      await setting("inflight.babysit", false)(page);
      await at("#/inflight")(page);
    },
    after: setting("inflight.babysit", undefined),
  },
  {
    // Cleared, with what the coordinator put away saying so.
    name: "cleared",
    go: async (page) => {
      await at("#/")(page);
      await page.keyboard.press("g");
      await page.keyboard.press("x");
      await page.waitForTimeout(300);
      await page.locator(".g-cleared").scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
    },
  },
  {
    // The sidebar after use: a group opened from it, then a Settings page. Only the page you're on gets the pill.
    name: "sidebar-used",
    go: async (page) => {
      await at("#/")(page);
      const later = page.locator(".side-item", { hasText: "Later" });
      if (await later.isVisible()) await later.click();
      await at("#/settings/notify")(page);
    },
  },
  // Last: its "press a again" toast would sit over the next shot.
  { name: "review-approve", go: review("acme/api#4127", ["a"]) },
];
const SIZES = [
  { name: "wide", width: 1280, height: 820, mac: false },
  { name: "mid", width: 900, height: 700, mac: false },
  { name: "min", width: 780, height: 600, mac: false },
  // What the owner sees: the desktop app on macOS, which pads for the traffic lights.
  { name: "mac", width: 1280, height: 820, mac: true },
];

const failures: string[] = [];
const files: string[] = [];
try {
  const url = arg("--url") ?? (await start());
  fs.rmSync(out, { recursive: true, force: true });
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
      await page.locator(".queue h2").first().waitFor({ timeout: 15_000 });
      for (const shot of SHOTS) {
        await page.keyboard.press("Escape");
        await shot.go(page);
        await page.mouse.move(0, 0); // no hover state left over from a click
        const file = `${theme}-${size.name}-${shot.name}.png`;
        await page.screenshot({ path: path.join(out, file) });
        files.push(file);
        const sideways = await page.evaluate<number>("document.documentElement.scrollWidth - innerWidth");
        if (sideways > 0) failures.push(`${file}: the page scrolls sideways by ${sideways}px`);
        for (const p of await page.evaluate<string[]>(CHECK_HIGHLIGHTS)) failures.push(`${file}: ${p}`);
        await shot.after?.(page);
      }
      await page.close();
    }
    // Close-ups of every highlighter mark, at 3x.
    const zoom = await browser.newPage({ viewport: { width: 1280, height: 820 }, colorScheme: theme, deviceScaleFactor: 3 });
    await zoom.goto(`${url}/#/`);
    await zoom.locator(".queue h2").first().waitFor({ timeout: 15_000 });
    const marks = zoom.locator(HIGHLIGHTS);
    for (let i = 0; i < (await marks.count()); i++) {
      // Cards with a line of context are taller: a long Now runs past the window.
      await marks.nth(i).scrollIntoViewIfNeeded();
      const b = await marks.nth(i).boundingBox();
      if (!b) continue;
      const file = `${theme}-zoom-${i}.png`;
      await zoom.screenshot({
        path: path.join(out, file),
        clip: { x: b.x - 16, y: b.y - 10, width: b.width + 120, height: b.height + 20 },
      });
      files.push(file);
    }
    await zoom.close();
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
