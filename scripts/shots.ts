// npm run shots [-- --url http://localhost:47823] [--out .shots]: visual QA.
// Screenshots every key state in light and dark at four window sizes, and each theme, and fails on sideways scrolling and
// console errors.
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
      const gaps = await page.evaluate<number[]>(`(() => {
        const rows = [...document.querySelectorAll(".queue .lines > [data-id]")].map((el) => el.getBoundingClientRect());
        return rows.slice(1).map((r, i) => Math.round(r.top - rows[i].bottom));
      })()`);
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
      await page.unroute("**/api/queue");
      await page.reload();
      await page.locator(READY).first().waitFor({ timeout: 15_000 });
    },
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
  { name: "review", go: review("acme/api#4127") },
  {
    // The last file ends at the window's bottom: no empty room below it to scroll into.
    name: "review-bottom",
    go: async (page) => {
      await review("acme/api#4127")(page);
      await toBottom("review-bottom")(page);
    },
  },
  { name: "review-note", go: review("acme/api#4127", ["]", "]", "]"]) },
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
    // g d: Later, with the Resolved group open and scrolled into view.
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
      await at("#/later")(page);
      const row = page.locator(".g-resolved .line", { hasText: "Tighten the CSP" }).locator(".row-main");
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
  // What Claude and the rules sorted away, on its own page.
  { name: "later", go: at("#/later") },
  // Merging: a reply to send, a question, CI being fixed where the repo has no auto-merge, one waiting with auto-merge on,
  // one merged.
  { name: "inflight", go: at("#/inflight") },
  {
    name: "inflight-question",
    go: async (page) => {
      await at("#/inflight")(page);
      await page.keyboard.press("j");
      await page.waitForTimeout(200);
    },
  },
  {
    // Claude handed it back (no local clone): at the top of the queue, one line like the rest.
    name: "handed-back",
    go: async (page) => {
      await at("#/")(page);
      await page.locator('.line[data-id="oss/tinyhttp#205"] .row-main').focus();
      await page.waitForTimeout(200);
    },
  },
  {
    // A first m on your own PR only arms the hand-off, as y does Send: a toast says press it again.
    name: "handoff-armed",
    go: async (page) => {
      await at("#/")(page);
      await page.locator('.line[data-id="oss/tinyhttp#205"] .row-main').focus();
      await page.keyboard.press("m");
      await page.waitForTimeout(200);
    },
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
  { name: "settings-inflight", go: at("#/settings/inflight") },
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
    // Logged out, the coordinator and the judge stop too: each says so in its one line, in ink, with when it tries again.
    name: "settings-agent-paused",
    writes: true,
    go: async (page) => {
      await at("#/")(page);
      await pauseAi(true)(page);
      await at("#/settings/agent")(page);
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
    // Claude off: the intro says so once, a PR that needs you has its problem as its why, nothing says "watching".
    name: "inflight-babysit-off",
    writes: true,
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
      await at("#/later")(page);
      await page.keyboard.press("g");
      await page.keyboard.press("x");
      await page.waitForTimeout(300);
      await page.locator(".g-cleared").scrollIntoViewIfNeeded();
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
  ]),
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

const files: string[] = [];
try {
  const real = arg("--url");
  const url = real ?? (await start());
  const shots = real ? SHOTS.filter((s) => !s.writes) : SHOTS;
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
