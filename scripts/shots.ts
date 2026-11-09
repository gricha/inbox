// npm run shots [-- --url http://localhost:47823] [--out .shots] [--only queue,review]: visual QA.
// Screenshots every key state in light and dark at its window sizes (SIZES, and a browser at 200 % zoom), and each theme,
// and fails on sideways scrolling and console errors. docs/visual.md → Checking a design change says what to look at.
// Without --url it starts the mock API and Vite, so the data is the same on every run.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page, type Request as Sent, type Route } from "playwright-core";
import { colorsOf, tokensFrom } from "../src/omarchy.ts";
import { THEMES } from "../src/themes.ts";
import type {
  AgentStatus,
  Ask,
  AskLines,
  AsksView,
  AutomationView,
  InflightView,
  OmarchyTheme,
  Overview,
  QueueView,
  ReviewView,
  SettingsView,
} from "../src/types.ts";

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
  // An AI review that never finishes during the run, so every theme and size shows it being written; no sync on a timer.
  node(["--disable-warning=ExperimentalWarning", "web/mock/server.ts"], {
    MOCK_PORT: String(MOCK),
    MOCK_AI_MS: "3600000",
    MOCK_NO_POLL: "1",
  });
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
  sizes?: string[]; // only at these of SIZES; without it, at every size but the ones a shot must ask for
}
const at = (hash: string) => async (page: Page) => {
  await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
  await page.waitForTimeout(400);
};
// A PR's review, opened from `from` (the Inbox), once Pierre has drawn and highlighted its diffs; then each selector clicked
// in order. Always from that page, so every size shows the same way back and list beside it, and the review opens afresh
// rather than keep what the shot before left in it.
const review =
  (id: string, clicks: string[] = [], from = "#/") =>
  async (page: Page) => {
    // Already there, it may be by an Esc whose hashchange hasn't landed yet: a review opened before it would skip the page.
    if ((await page.evaluate<string>("location.hash")) !== from) await at(from)(page);
    else await page.waitForTimeout(100);
    // The list beside it from its top, whatever the shot before scrolled: it brings the review's row into view itself.
    await page.evaluate(`document.querySelector(".beside-list")?.scrollTo(0, 0)`);
    await at(`#/review/${encodeURIComponent(id)}`)(page);
    await page.locator(".rv-diff").first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(900);
    for (const c of clicks) {
      await page.locator(c).first().click();
      await page.waitForTimeout(250);
    }
  };
const MORE = ".rv-actions .more-wrap > button";
// A row's right-click menu, then its entry that reads `item`.
const rowMenuPick = async (page: Page, row: string, item: string) => {
  await page.locator(row).locator(".row-main").click({ button: "right" });
  await page.locator(".ctx-item", { hasText: item }).first().click();
};
// Where each selector's first match starts down the page, or -1 when there's none: read at once, never waited for.
const tops = (page: Page, sels: string[]) =>
  page.evaluate<number[]>(`${JSON.stringify(sels)}.map((s) => document.querySelector(s)?.getBoundingClientRect().top ?? -1)`);
const inOrder = (ys: number[]) => ys.every((y, i) => y >= 0 && (i === 0 || y > ys[i - 1]!));
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
// Nothing in the Inbox: its one line, and no count beside Inbox in the sidebar.
const emptyInbox = async (page: Page, name: string) => {
  const seen = await page.evaluate<{ line: string | null; count: string | null }>(`({
    line: document.querySelector(".queue-empty")?.textContent ?? null,
    count: document.querySelector(".side-item .side-count")?.textContent ?? null,
  })`);
  if (seen.line !== "Nothing needs you right now." || seen.count) failures.push(`${name}: the empty Inbox reads ${JSON.stringify(seen)}`);
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
// The review's sidebar back to its default for the window's width: what Hide or Files chose is kept per device.
const sideDefault = async (page: Page) => {
  await page.evaluate(`localStorage.removeItem("desk.review.side")`);
};
// Your chat closed: with words in its box, the first Esc only leaves the box.
const closeChat = async (page: Page) => {
  for (let i = 0; i < 2 && (await page.locator(".chat").count()); i++) await page.keyboard.press("Escape");
};
const top = async (page: Page) => {
  await page.evaluate("scrollTo(0, 0)");
};
// A line of plan.ts in acme/api#4127's review, and the + by its number once hovering the line shows it.
const PLAN = '.rv-file-sec[aria-label="src/planner/plan.ts"]';
const planLine = (page: Page, n: number) => page.locator(PLAN).first().locator(`div[data-line="${n}"]`).last();
const plusBy = async (page: Page, n: number) => {
  const line = planLine(page, n);
  // Pierre can redraw the diff mid-scroll: the locator finds the line again.
  for (let i = 0; ; i++) {
    try {
      await line.scrollIntoViewIfNeeded({ timeout: 5000 });
      break;
    } catch (e) {
      if (i === 2) throw e;
      await page.waitForTimeout(300);
    }
  }
  const plus = page.locator(PLAN).first().locator("[data-utility-button]").first();
  for (let i = 0; i < 10 && !(await plus.count()); i++) {
    await page.mouse.move(0, 0);
    await line.hover();
    await page.waitForTimeout(150);
  }
  return plus;
};
// Asks sent from the chat stay in the page, never the mock: the bodies posted, and the asks list carrying the last one.
const echoAsks = async (page: Page, id: string) => {
  const posted: Record<string, unknown>[] = [];
  let sent: Ask | null = null;
  await page.route("**/api/ask", (route) => {
    const b = route.request().postDataJSON() as {
      text: string;
      item_id?: string;
      thread_id?: string;
      thread_url?: string;
      lines?: AskLines;
    };
    posted.push(b);
    sent = {
      id,
      at: new Date().toISOString(),
      text: b.text,
      item_id: b.item_id ?? null,
      thread_id: b.thread_id ?? null,
      thread_url: b.thread_url ?? null,
      lines: b.lines ?? null,
      answer: null,
    };
    return route.fulfill({ json: { ok: true, ask: sent } });
  });
  await page.route("**/api/asks", async (route) => {
    const res = await route.fetch();
    const v = (await res.json()) as AsksView;
    if (sent) v.asks.push(sent);
    await route.fulfill({ response: res, json: v });
  });
  return posted;
};
// What the page says about the chat: the line above its box, its item, and whether its box has the keys.
const chatState = (page: Page) =>
  page.evaluate<{ on: string | null; about: string | null; drops: number; focus: boolean; box: boolean }>(`({
    on: document.querySelector(".chat-on")?.textContent ?? null,
    about: document.querySelector(".chat-about")?.textContent ?? null,
    drops: document.querySelectorAll(".chat .chat-drop").length,
    focus: !!document.activeElement?.classList.contains("chat-input"),
    box: !!document.querySelector(".rv-inline"),
  })`);
// acme/api#4127's review in a fresh page, lines 20 to 23 of plan.ts picked down the gutter, and their box's Ask your agent.
const linesInChat = async (page: Page) => {
  await fresh(page);
  await review("acme/api#4127")(page);
  // The whole range in view: a drag past the window's edge stops at it.
  await planLine(page, 21).evaluate((el: { scrollIntoView: (o: { block: "center" }) => void }) => {
    el.scrollIntoView({ block: "center" });
  });
  const plus = await plusBy(page, 20);
  const from = await plus.boundingBox();
  const to = await planLine(page, 23).boundingBox();
  if (!from || !to) throw new Error("plan.ts's lines 20 and 23 aren't on screen");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.locator(".rv-inline").waitFor();
  await page.locator(".rv-inline button", { hasText: "Ask your agent" }).click();
  await page.locator(".chat-input").waitFor();
};
const LINES = { path: "src/planner/plan.ts", line: 23, side: "new", start: { line: 20, side: "new" } };
// A Settings view: the head is its way back to Settings' part `part` (or the Automations tab, named so), the view names
// itself, and the column is `col` at most.
const settingsView = async (page: Page, name: string, title: string, part: string, col: string) => {
  const seen = await page.evaluate<{ back: string | null; href: string | null; h1: string | null; col: string }>(`(() => {
    const back = document.querySelector(".page-head a.back");
    return {
      back: back?.textContent.trim() ?? null,
      href: back?.getAttribute("href") ?? null,
      h1: [...document.querySelectorAll(".s-view")].find((v) => !v.hidden)?.querySelector("h1")?.textContent.trim() ?? null,
      col: getComputedStyle(document.querySelector(".main")).maxWidth,
    };
  })()`);
  const to = part === "automations" ? "Automations" : "Settings";
  if (seen.back !== to) failures.push(`${name}: the page head's way back reads ${JSON.stringify(seen.back)}, not ${to}`);
  if (seen.href !== `#/settings/${part}`) failures.push(`${name}: the way back goes to ${seen.href}, not #/settings/${part}`);
  if (seen.h1 !== title) failures.push(`${name}: the view's name reads ${JSON.stringify(seen.h1)}`);
  if (seen.col !== col) failures.push(`${name}: the column is ${seen.col}, not ${col}`);
  if (await page.locator(".s-page:visible").count()) failures.push(`${name}: a Settings tab shows beside the view`);
};
// The policy view's hourly cap: its row, on screen once scrolled to, under the judge's status line.
const capUnderStatus = async (page: Page, name: string) => {
  const cap = page.locator('[id="row-policy.max_per_hour"]');
  if (!(await cap.isVisible())) {
    failures.push(`${name}: no hourly cap in the policy view`);
    return;
  }
  const [status, row] = await page.evaluate<number[]>(`[
    [...document.querySelectorAll(".policy > .s-live")].at(-1)?.getBoundingClientRect().bottom ?? -1,
    document.getElementById("row-policy.max_per_hour").getBoundingClientRect().top,
  ]`);
  if (status! < 0 || row! < status!) failures.push(`${name}: the hourly cap isn't under the judge's status`);
};
// A theme picked in Settings → This device, as its select sets it; `after` puts System back.
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
// Omarchy picked on a machine running it (the mock isn't one: its GET /api/omarchy is answered here). Hackerman and Lupine
// aren't the desk's, so each is the tokens made from its colors.toml as Omarchy 4.5 ships it.
const omarchyOf = (name: string, scheme: "light" | "dark", colors: string): OmarchyTheme => ({
  name,
  scheme,
  theme: null,
  tokens: tokensFrom(colorsOf(colors), scheme),
});
const HACKERMAN = omarchyOf(
  "hackerman",
  "dark",
  `accent = "#82FB9C"\nbackground = "#0B0C16"\nforeground = "#ddf7ff"\nred = "#50f872"\nyellow = "#50f7d4"\ngreen = "#4fe88f"`,
);
const LUPINE = omarchyOf(
  "lupine",
  "light",
  `accent = "#3264eb"\nbackground = "#fafafa"\nforeground = "#212121"\nbright_foreground = "#000000"\nred = "#c900c4"\ngreen = "#4a2fd0"`,
);
const omarchyAs = (o: OmarchyTheme) => async (page: Page) => {
  await page.route("**/api/omarchy", (route) => route.fulfill({ json: o }));
  await pickTheme("omarchy")(page);
  const on = await page.evaluate<[string?, string?]>(
    `[document.documentElement.dataset.theme, document.documentElement.style.getPropertyValue("--sheet")]`,
  );
  if (on[0] !== "omarchy" || on[1] !== o.tokens?.["--sheet"]) failures.push(`omarchy: ${o.name} shows as ${JSON.stringify(on)}`);
};
const leaveOmarchy = async (page: Page) => {
  await unroute(page);
  await page.evaluate(`localStorage.removeItem("desk.omarchy")`);
  await systemTheme(page);
};
// A Settings part's status rows, by their labels, top to bottom.
const statusRows = (page: Page, part: string) =>
  page.evaluate<string[]>(`[...document.querySelectorAll("#s-${part} .s-status .s-label")].map((l) => l.textContent.trim())`);
// Settings as the mock serves it, changed in the browser, from a fresh load since the window reads it once; unsettle undoes it.
const settingsAs = (change: (v: SettingsView) => void) => async (page: Page) => {
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const res = await route.fetch();
    const v = (await res.json()) as SettingsView;
    change(v);
    await route.fulfill({ response: res, json: v });
  });
  await at("#/")(page);
  await page.reload();
  await page.locator(READY).first().waitFor({ timeout: 15_000 });
};
// The overview as the mock serves it, changed in the browser, from the next load on; unsettle undoes it.
const overviewAs = (change: (o: Overview) => void) => async (page: Page) => {
  await page.route("**/api/overview", async (route) => {
    const res = await route.fetch();
    const o = (await res.json()) as Overview;
    change(o);
    await route.fulfill({ response: res, json: o });
  });
};
// The automations as the mock serves them, changed in the browser; unsettle undoes it.
const automationsAs = (change: (v: AutomationView[]) => void) => async (page: Page) => {
  await page.route("**/api/automations", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const res = await route.fetch();
    const v = (await res.json()) as AutomationView[];
    change(v);
    await route.fulfill({ response: res, json: v });
  });
  await at("#/")(page);
  await page.reload();
  await page.locator(READY).first().waitFor({ timeout: 15_000 });
};
// Each automation's row in Automations: its name, its help (and the part of it in red), and its controls.
const automationRows = (page: Page) =>
  page.evaluate<{ name: string; help: string; red: string[]; run: boolean; on: boolean | null; review: string | null }[]>(`
    [...document.querySelectorAll("#s-automations .au-row")].map((r) => ({
      name: r.querySelector(".s-name").textContent,
      help: r.querySelector(".s-help").textContent,
      red: [...r.querySelectorAll(".s-help .t-bad, .s-help.t-bad")].map((x) => x.textContent),
      run: [...r.querySelectorAll("button")].some((b) => b.textContent === "Run now"),
      on: r.querySelector(".switch")?.checked ?? null,
      review: r.querySelector(".s-cta")?.getAttribute("href") ?? null,
    }))`);
const unsettle = async (page: Page) => {
  await unroute(page);
  await at("#/")(page);
  await page.reload();
  await page.locator(READY).first().waitFor({ timeout: 15_000 });
};
let reposWere: unknown = null; // the mock's own github.my_repos, which settings-saves resets and puts back
// A setting as the desk has it now, read past the window.
const deskHas = (page: Page, key: string) =>
  page.evaluate<unknown>(`fetch("/api/settings").then((r) => r.json()).then((v) => v.values[${JSON.stringify(key)}])`);
// One step of settings-saves: `commit` on a setting's row (after `edit`, which may grow it), then the desk has `want`, "Saved"
// showed in that row, the row kept its height (`still`: a reset can shrink a list back), and the line clears the hairline.
const saveStep = async (
  page: Page,
  step: string,
  key: string,
  o: { edit?: () => Promise<void>; commit: () => Promise<void>; want: unknown; still?: false },
) => {
  const row = page.locator(`[id="row-${key}"]`);
  await row.scrollIntoViewIfNeeded();
  // The row's height, and how far its message line runs past the row's bottom edge, its hairline.
  const measure = () =>
    page.evaluate<[number, number]>(`(() => {
      const r = document.getElementById(${JSON.stringify(`row-${key}`)}).getBoundingClientRect();
      return [r.height, document.querySelector(${JSON.stringify(`[id="row-${key}"] .s-msg`)}).getBoundingClientRect().bottom - r.bottom];
    })()`);
  await o.edit?.();
  const [before] = await measure();
  // The save this step sends: a "Saved" still showing from the row's last step isn't this one's.
  const put = page
    .waitForResponse((r) => r.url().endsWith("/api/settings") && r.request().method() === "PUT", { timeout: 5000 })
    .catch(() => null);
  await o.commit();
  if (!(await put)) failures.push(`settings-saves: ${step}: nothing was sent for ${key}`);
  if (
    !(await row
      .locator(".s-msg .t-good", { hasText: "Saved" })
      .waitFor({ timeout: 3000 })
      .then(
        () => true,
        () => false,
      ))
  )
    failures.push(`settings-saves: ${step}: no "Saved" on ${key}`);
  const [after, over] = await measure();
  if (o.still !== false && before !== after) failures.push(`settings-saves: ${step}: ${key}'s row went from ${before}px to ${after}px`);
  if (over > 0) failures.push(`settings-saves: ${step}: ${key}'s "Saved" runs ${over}px over the hairline`);
  const has = await deskHas(page, key);
  if (JSON.stringify(has) !== JSON.stringify(o.want))
    failures.push(`settings-saves: ${step}: the desk has ${key} = ${JSON.stringify(has)}, not ${JSON.stringify(o.want)}`);
};
// The shortcut row's line once it reads `want`, or what it reads after 3 s: the app is asked a moment after the settings load.
const hotkeySays = async (page: Page, want: string) => {
  const sel = JSON.stringify('[id="row-app.hotkey"] .s-help');
  await page
    .waitForFunction(`document.querySelector(${sel})?.textContent === ${JSON.stringify(want)}`, null, { timeout: 3000 })
    .catch(() => {});
  return page.evaluate<string | null>(`document.querySelector(${sel})?.textContent ?? null`);
};
// Reset to default on a row you changed: it shows once "Saved" has gone.
const resetStep = (page: Page, key: string, want: unknown, still?: false) =>
  saveStep(page, `reset ${key}`, key, {
    commit: () => page.locator(`[id="row-${key}"]`).getByRole("button", { name: "Reset to default" }).click({ timeout: 4000 }),
    want,
    still,
  });
// The page the sidebar marks as where you are: a review's or a question's is the page it was opened from.
const sideOn = (page: Page) =>
  page.evaluate<string | null>(`document.querySelector(".side-item.on .side-name")?.textContent.trim() ?? null`);
// The sidebar's sync line, null while there's nothing wrong: its words, red, spinning, its tooltip.
const syncLine = (page: Page) =>
  page.evaluate<{ text: string; red: boolean; spin: boolean; tip: string | null; press: boolean } | null>(`(() => {
    const b = document.querySelector(".side-sync");
    return b && { text: b.textContent.trim(), red: b.classList.contains("err"), spin: !!b.querySelector(".spin"), tip: b.getAttribute("title"), press: b.tagName === "BUTTON" };
  })()`);
// The page head's words: a list's filter, a review's way back, or the page's name.
const headSays = (page: Page) =>
  page.evaluate<string | null>(
    `(() => { const h = document.querySelector(".page-head"); return h && (h.querySelector("input")?.placeholder ?? h.textContent.trim()); })()`,
  );
// Settings' tabs in the page head, the one it marks current in brackets: "[Settings] Automations"; null with none.
const tabsSay = (page: Page) =>
  page.evaluate<string | null>(`(() => {
    const tabs = [...document.querySelectorAll(".page-head .head-tabs a")];
    return tabs.length ? tabs.map((a) => (a.getAttribute("aria-current") === "page" ? "[" + a.textContent + "]" : a.textContent)).join(" ") : null;
  })()`);
// The sidebar's pages in order, "|" for its hairline; null where it's hidden.
const sidePages = (page: Page) =>
  page.evaluate<string | null>(`(() => {
    const nav = document.querySelector(".side-nav");
    if (!nav?.getClientRects().length) return null;
    return [...nav.children].map((el) => (el.classList.contains("side-sep") ? "|" : el.querySelector(".side-name")?.textContent.trim())).join(" ");
  })()`);
// The words of the open More menu, top to bottom, its heading as "#On GitHub".
const moreItems = (page: Page) =>
  page.evaluate<string[]>(
    `[...(document.querySelector(".more-pop")?.children ?? [])].map((el) => (el.classList.contains("pop-title") ? "#" : "") + el.textContent.trim())`,
  );
// The list beside a review or a question: how wide, its fold button, the row it marks, its rows' lines, and whether the
// review's sidebar sits beside the diff; null where there's none.
const besideSays = (page: Page) =>
  page.evaluate<{
    width: number;
    open: string | null;
    label: string | null;
    controls: boolean;
    hit: number;
    sel: string | null;
    titles: number;
    metas: number;
    sideInline: boolean;
  } | null>(`(() => {
    const col = document.querySelector(".beside"), fold = document.querySelector(".beside-fold");
    if (!col || !fold) return null;
    const f = fold.getBoundingClientRect(), side = document.querySelector(".rv-side");
    const lh = (el) => parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.2;
    const lines = (sel) => Math.max(0, ...[...document.querySelectorAll(sel)].map((el) => Math.round(el.getBoundingClientRect().height / lh(el))));
    return {
      width: Math.round(col.getBoundingClientRect().width),
      open: fold.getAttribute("aria-expanded"),
      label: fold.getAttribute("aria-label"),
      controls: !!document.getElementById(fold.getAttribute("aria-controls") ?? ""),
      hit: Math.min(f.width, f.height),
      sel: document.querySelector(".beside .line.sel")?.dataset.id ?? null,
      titles: lines(".beside .c-row .line-title"),
      metas: lines(".beside .c-row .c-meta"),
      sideInline: !!side && getComputedStyle(side).position !== "fixed",
    };
  })()`);
// The list beside the review open with what its page shows, the open item marked, two lines a row at most.
const besideOpen = async (page: Page, name: string, sel: string) => {
  const b = await besideSays(page);
  if (!b) {
    failures.push(`${name}: no list beside it`);
    return;
  }
  if (b.width < 320 || b.width > 360) failures.push(`${name}: the list beside it is ${b.width}px wide`);
  if (b.open !== "true" || b.label !== "Hide the list" || !b.controls || b.hit < 28)
    failures.push(`${name}: its fold button reads ${JSON.stringify(b)}`);
  if (b.sel !== sel) failures.push(`${name}: the list marks ${JSON.stringify(b.sel)}, not ${sel}`);
  if (b.titles > 2 || b.metas > 1) failures.push(`${name}: a row's title takes ${b.titles} lines and its facts ${b.metas}`);
};
let skTop = -1; // where queue-loading's placeholders started
const LONG = "Stream partial results to the client while the hash join stage spills its build side to disk under memory pressure";
const SHOTS: Shot[] = [
  {
    // Nothing is selected on load: no row's fill, no filled call to action.
    name: "queue",
    sizes: ["wide", "mid", "min", "mac", "xl"],
    go: async (page) => {
      await at("#/")(page);
      if (await page.locator(".line.sel").count()) failures.push("queue: a row is selected on load");
      if (await page.locator(".line-cta.primary").count()) failures.push("queue: a row's call to action is filled on load");
      const on = await sideOn(page);
      if (on !== "Inbox") failures.push(`queue: the sidebar marks ${JSON.stringify(on)}`);
      const head = await headSays(page);
      if (head !== "Filter") failures.push(`queue: the page head reads ${JSON.stringify(head)}, not the filter`);
      if (await page.locator(".side-sync").count()) failures.push("queue: the sidebar has a sync line while the sync is fine");
    },
  },
  {
    // A trip to another page and back: the row you focused before isn't filled any more.
    name: "queue-after-settings",
    go: async (page) => {
      await at("#/")(page);
      await page.locator(".queue [data-id]").nth(1).locator(".row-main").focus();
      await at("#/settings/github")(page);
      await at("#/")(page);
      if (await page.locator(".line.sel").count()) failures.push("queue-after-settings: a row is still selected after a trip to Settings");
    },
  },
  {
    // The macOS app at 840px: the compact sidebar, its brand row under the traffic lights.
    name: "queue-840",
    sizes: ["mac"],
    go: async (page) => {
      await page.setViewportSize({ width: 840, height: 700 });
      await at("#/")(page);
    },
    after: async (page) => {
      const mac = SIZES.find((s) => s.name === "mac")!;
      await page.setViewportSize({ width: mac.width, height: mac.height });
    },
  },
  {
    // GitHub's rate limit: the sidebar's sync line, there only when something's wrong, says so in red with the error in its
    // tooltip; nothing to press, since the desk skips a sync until the limit resets, so a click shows no retry.
    name: "sync-limited",
    go: async (page) => {
      const error = "GitHub rate limited until 2026-11-09T00:00:00Z (HTTP 403)";
      await overviewAs((o) => {
        o.sync_error = error;
        o.connectors = o.connectors.map((c) => ({ ...c, status: "paused", error }));
      })(page);
      await page.reload();
      await page.locator(READY).first().waitFor({ timeout: 15_000 });
      await page.locator(".side-sync").waitFor();
      const line = await syncLine(page);
      if (line?.text !== "Rate limited" || !line.red || line.spin || line.tip !== error || line.press)
        failures.push(`sync-limited: the rate-limited sync line reads ${JSON.stringify(line)}`);
      await page.locator(".side-sync").click();
      await page.waitForTimeout(150);
      const after = await syncLine(page);
      if (after?.text !== "Rate limited") failures.push(`sync-limited: a click on the line reads ${JSON.stringify(after)}`);
    },
    after: unsettle,
  },
  {
    // The desk gone: the list stays under the red line with Retry, and the sync line says Offline in red.
    name: "sync-offline",
    go: async (page) => {
      await at("#/")(page);
      // A 200 that isn't JSON is what the window takes for no desk, without a console error; the event stream stays.
      await page.route("**/api/**", (route) =>
        route.request().url().endsWith("/api/events") ? route.fallback() : route.fulfill({ contentType: "text/plain", body: "" }),
      );
      await page.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`);
      await page.locator(".side-sync", { hasText: "Offline" }).waitFor();
      const line = await syncLine(page);
      if (!line?.red || line.spin) failures.push(`sync-offline: the sync line reads ${JSON.stringify(line)}`);
      if (!(await page.locator(".notice.err").isVisible()) || !(await page.locator(".queue .line").count()))
        failures.push("sync-offline: the list isn't kept under the red line");
    },
    // Then the desk back: the red line and the sync line both go.
    after: async (page) => {
      await unroute(page);
      await page.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`);
      for (const sel of [".side-sync", ".notice.err"])
        await page
          .locator(sel)
          .waitFor({ state: "detached", timeout: 5000 })
          .catch(() => failures.push(`sync-offline: ${sel} stays once the desk is back`));
      await fresh(page);
    },
  },
  // A browser at 200 % zoom (1280×820 at 640×410): the sidebar is one row across the top, scrolling inside itself; the page
  // under it never scrolls sideways.
  ...(
    [
      ["zoom-queue", at("#/")],
      ["zoom-review", review("acme/api#4127")],
      [
        "zoom-inquiry",
        async (page: Page) => {
          await at("#/inquiry/q1c0ffee")(page);
          await page.locator(".inquiry .inq-options").waitFor();
        },
      ],
      ["zoom-settings", at("#/settings/github")],
    ] as const
  ).map(([name, go]): Shot => ({
    name,
    sizes: ["wide"],
    go: async (page) => {
      await page.setViewportSize({ width: 640, height: 410 });
      await go(page);
      const side = await page.evaluate<{ row: boolean; h: number }>(
        `(() => { const s = document.querySelector(".side"); return { row: getComputedStyle(s).flexDirection === "row", h: s.getBoundingClientRect().height }; })()`,
      );
      if (!side.row || side.h > 60) failures.push(`${name}: the sidebar isn't one row across the top: ${JSON.stringify(side)}`);
    },
    after: async (page) => {
      const wide = SIZES.find((s) => s.name === "wide")!;
      await page.setViewportSize({ width: wide.width, height: wide.height });
    },
  })),
  // At 250 % zoom (512×328) the sidebar's row runs past the window: a thin scrollbar says so, and its end reaches Settings.
  {
    name: "zoom-512",
    sizes: ["wide"],
    go: async (page) => {
      await page.setViewportSize({ width: 512, height: 328 });
      await at("#/")(page);
      const s = await page.evaluate<{ over: boolean; bar: string; reach: boolean }>(`(() => {
        const side = document.querySelector(".side"), last = [...side.querySelectorAll(".side-item")].at(-1);
        side.scrollLeft = side.scrollWidth;
        const r = last.getBoundingClientRect(), b = side.getBoundingClientRect();
        const out = { over: side.scrollWidth > side.clientWidth, bar: getComputedStyle(side).scrollbarWidth, reach: r.left >= b.left - 1 && r.right <= b.right + 1 };
        side.scrollLeft = 0;
        return out;
      })()`);
      if (s.over && (s.bar === "none" || !s.reach)) failures.push(`zoom-512: the sidebar's row hides its end: ${JSON.stringify(s)}`);
    },
    after: async (page) => {
      const wide = SIZES.find((s) => s.name === "wide")!;
      await page.setViewportSize({ width: wide.width, height: wide.height });
    },
  },
  // What can't move yet: a chain's rows together, the first saying what its blocker waits on, then a review wait.
  { name: "blocked", go: at("#/blocked") },
  // The PR a chain waits on: what it blocks, and what it waits on. Opened from the queue, where it is.
  {
    name: "review-blocker",
    go: review("acme/api#1294"),
  },
  // A PR another one blocks: its header says what, greyed like Later's.
  {
    name: "review-blocked",
    go: async (page) => {
      await review("acme/billing#2298", [], "#/blocked")(page);
    },
  },
  {
    // The third row Tab-focused: its calm fill, and the rows stay evenly spaced.
    name: "queue-selected",
    go: async (page) => {
      await at("#/")(page);
      await top(page);
      await page.locator(".queue [data-id]").nth(2).locator(".row-main").focus();
      await page.waitForTimeout(250);
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
      await at("#/")(page);
      await queueAs((q) => {
        q.sections.now = [];
        q.sections.today = [];
        q.inquiries = [];
      })(page);
      await top(page);
      await emptyInbox(page, "queue-empty");
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
      await at("#/")(page);
      await queueAs((q) => {
        q.sections.now = [];
        q.sections.today = [];
        q.inquiries = [];
        q.reviewing = 1;
      })(page);
      await top(page);
      await emptyInbox(page, "queue-empty-reviewing");
      const [empty, reviewing] = await tops(page, [".queue-empty", ".queue-reviewing"]);
      if (!(reviewing! > empty!)) failures.push("queue-empty-reviewing: the reviewing line isn't under the empty line");
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
      await at("#/")(page);
      await hold(page, "**/api/queue");
      await page.locator(".queue .sk-row").first().waitFor();
      await page.waitForTimeout(600); // the placeholders show only once the wait is noticeable
      skTop = (await tops(page, [".queue .lines"]))[0] ?? -1;
    },
    // The rows land where their placeholders were: the first sheet starts where the placeholders' did.
    after: async (page) => {
      await release("**/api/queue")(page);
      await top(page);
      const [loaded] = await tops(page, [".queue .lines"]);
      if (Math.abs(loaded! - skTop) > 1)
        failures.push(`queue-loading: the rows land at ${loaded}px, their placeholders were at ${skTop}px`);
    },
  },
  {
    // The queue's "n more" line, Tab-focused; a click opens the rest in place.
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
      await page.locator(".queue .fold").click();
      await page.waitForTimeout(200);
    },
    after: refold,
  },
  {
    // Your pin lifts a blocked PR onto your page, its stage "blocked", under api#1294, which it waits on and which offers Reply.
    name: "queue-blocked",
    go: async (page) => {
      await queueAs((q) => {
        const [pinned] = q.sections.blocked.splice(0, 1);
        const at1294 = q.sections.today.findIndex((c) => c.id === "acme/api#1294");
        if (pinned) q.sections.today.splice(at1294 + 1, 0, { ...pinned, group: "mine", pinned: true });
      })(page);
      await unfold(page);
      await page.evaluate(`document.querySelector('.queue [data-id="acme/billing#2298"]').scrollIntoView({ block: "center" })`);
      await page.waitForTimeout(200);
    },
    after: async (page) => {
      await unroute(page);
      await refold(page);
    },
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
    // A click on a PR opens its review; an issue opens in place, its actions quiet text, Close last.
    name: "expanded",
    go: async (page) => {
      await at("#/")(page);
      await unfold(page);
      await page.locator(".line", { hasText: "Worker OOM on large batches" }).locator(".row-main").click();
      await page.waitForTimeout(400);
      const acts = await page.evaluate<{ text: string; title: string | null }[]>(
        `[...document.querySelectorAll(".card-keys .act")].map((b) => ({ text: b.textContent.trim(), title: b.getAttribute("title") }))`,
      );
      if (acts[0]?.text !== "Comment" || acts.at(-1)?.text !== "Close" || acts.at(-1)?.title !== "Close (Esc)")
        failures.push(`expanded: the opened issue's actions read ${JSON.stringify(acts)}`);
    },
  },
  {
    // Comment on an issue opened in place: the comment bar at the window's bottom.
    name: "issue-comment",
    after: refold,
    go: async (page) => {
      await at("#/")(page);
      await unfold(page);
      await page.locator(".line", { hasText: "Worker OOM on large batches" }).locator(".row-main").click();
      await page.waitForTimeout(400);
      await page.locator(".card-keys button", { hasText: "Comment" }).click();
      await page.keyboard.type("The OOM is in the batcher: I'll cap the batch at 500 rows today.");
      await page.waitForTimeout(200);
    },
  },
  {
    // Snooze on an issue opened in place: its row's menu at the button, Snooze open.
    name: "issue-snooze",
    go: async (page) => {
      await at("#/")(page);
      await unfold(page);
      await page.locator(".line", { hasText: "Worker OOM on large batches" }).locator(".row-main").click();
      await page.waitForTimeout(400);
      await page.locator(".card-keys button", { hasText: "Snooze" }).click();
      await page.waitForTimeout(200);
      if (!(await page.locator(".ctx-sub").isVisible())) failures.push("issue-snooze: Snooze didn't open its times");
    },
    after: async (page) => {
      for (let i = 0; i < 2 && (await page.locator(".ctx").count()); i++) await page.keyboard.press("Escape");
      await refold(page);
    },
  },
  {
    // Opened from the Inbox: the back link in the review's head names it, and the sidebar marks it.
    name: "review",
    go: async (page) => {
      await at("#/")(page);
      await review("acme/api#4127")(page);
      const back = (await page.locator(".page-head .back").textContent())?.trim();
      if (back !== "Inbox") failures.push(`review: the back link reads ${JSON.stringify(back)}`);
      const on = await sideOn(page);
      if (on !== "Inbox") failures.push(`review: the sidebar marks ${JSON.stringify(on)}`);
      if (await page.locator(".rv-ai .prose").count()) failures.push("review: the AI review doesn't open folded");
      if (!inOrder(await tops(page, [".rv-ai", ".rv-convo", ".rv-comment"])))
        failures.push("review: the AI review isn't above the conversation and your comment");
    },
  },
  // From 1160px the list a review was opened from stays beside it, two lines a row, the open one marked; below, none.
  {
    name: "beside-review",
    sizes: ["wide", "mac", "xl", "mid", "min"],
    go: async (page) => {
      await at("#/")(page);
      await review("acme/api#4127")(page);
      const wide = await page.evaluate<boolean>("innerWidth >= 1160");
      const b = await besideSays(page);
      if (!wide) {
        if (b || (await page.locator(".beside").count())) failures.push("beside-review: a list or its rail beside the review below 1160px");
        return;
      }
      await besideOpen(page, "beside-review", "acme/api#4127");
      if (b?.sideInline) failures.push("beside-review: the review's sidebar squeezes in beside the diff next to the list");
      // The calls to action sit before the ages, so the ages end in one column.
      const ends = await page.evaluate<number[]>(
        `[...new Set([...document.querySelectorAll(".beside .c-row .line-age")].map((el) => Math.round(el.getBoundingClientRect().right)))]`,
      );
      if (ends.length !== 1) failures.push(`beside-review: the ages end at ${ends.join(", ")}px, not in one column`);
      // A row's right-click menu, as on the table: its row marked while it's open, then the open review's again.
      await page.locator('.beside .line[data-id="acme/api#4099"] .row-main').click({ button: "right" });
      if (!(await page.locator(".ctx").count())) failures.push("beside-review: a right-click on a row beside the review opens no menu");
      const marked = (await besideSays(page))?.sel;
      if (marked !== "acme/api#4099") failures.push(`beside-review: with its menu open, the list marks ${JSON.stringify(marked)}`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
      const after = (await besideSays(page))?.sel;
      if (after !== "acme/api#4127") failures.push(`beside-review: with the menu closed, the list marks ${JSON.stringify(after)}`);
    },
  },
  // An issue in the list beside a review opens in place under its row, as in the table; the review stays.
  {
    name: "beside-issue",
    sizes: ["wide", "xl"],
    go: async (page) => {
      await at("#/")(page);
      await review("acme/api#4127")(page);
      await page.locator(".beside .queue .fold").click();
      await page.locator(".beside .line", { hasText: "Worker OOM on large batches" }).locator(".row-main").click();
      await page.locator(".beside .line.open .card-keys").waitFor();
      await page.waitForTimeout(300);
      if (!(await page.evaluate<boolean>(`location.hash.startsWith("#/review/")`)))
        failures.push("beside-issue: opening an issue beside the review left the review");
    },
    after: async (page) => {
      // Esc closes it first, as on the table, and the review stays.
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
      const left = await page.evaluate<{ open: boolean; review: boolean }>(
        `({ open: !!document.querySelector(".line.open"), review: location.hash.startsWith("#/review/") })`,
      );
      if (left.open || !left.review) failures.push(`beside-issue: after Esc, ${JSON.stringify(left)}`);
      if (left.open) await page.locator(".beside .line.open .card-keys .act", { hasText: "Close" }).last().click();
      await refold(page);
    },
  },
  // Folded to its rail: the review's sidebar has room beside the diff again; the choice is kept on this device.
  {
    name: "beside-folded",
    sizes: ["wide", "mac", "xl"],
    go: async (page) => {
      await at("#/")(page);
      await review("acme/api#4127")(page);
      await page.locator(".beside-fold").click();
      await page.waitForTimeout(300);
      const b = await besideSays(page);
      if (!b || b.width !== 28 || b.open !== "false" || b.label !== "Show the list" || !b.controls)
        failures.push(`beside-folded: the rail reads ${JSON.stringify(b)}`);
      if (!b?.sideInline) failures.push("beside-folded: the review's sidebar isn't beside the diff with the list folded");
      if ((await page.evaluate<string | null>(`localStorage.getItem("desk.list")`)) !== "folded")
        failures.push("beside-folded: folding the list isn't kept on this device");
    },
    after: async (page) => {
      if (await page.locator(".beside.folded").count()) await page.locator(".beside-fold").click();
      await page.waitForTimeout(200);
      if (await page.evaluate<string | null>(`localStorage.getItem("desk.list")`))
        failures.push("beside-folded: showing the list again isn't kept on this device");
    },
  },
  // The chat open in a window under 1600px: the list folds to its rail, the saved choice untouched, and comes back with the chat gone.
  {
    name: "beside-chat",
    sizes: ["wide", "mac", "xl"],
    go: async (page) => {
      await at("#/")(page);
      await review("me/notes-app#12")(page);
      await page.locator(".side-ask").click();
      await page.locator(".chat-input").waitFor();
      await page.waitForTimeout(300);
      const b = await besideSays(page);
      if (!b || b.width !== 28 || b.open !== "false") failures.push(`beside-chat: beside the chat, the list reads ${JSON.stringify(b)}`);
      if (await page.evaluate<string | null>(`localStorage.getItem("desk.list")`))
        failures.push("beside-chat: the chat folding the list changed the saved choice");
    },
    after: async (page) => {
      await closeChat(page);
      await page.waitForTimeout(200);
      if ((await besideSays(page))?.open !== "true") failures.push("beside-chat: the list doesn't come back when the chat closes");
    },
  },
  // An agent's question: the Inbox beside it, the question's row marked.
  {
    name: "beside-inquiry",
    sizes: ["wide", "mac", "xl"],
    go: async (page) => {
      await at("#/")(page);
      await at("#/inquiry/q2bead00")(page);
      await page.locator(".inquiry .inq-write textarea").waitFor();
      await page.waitForTimeout(200);
      await besideOpen(page, "beside-inquiry", "ask:q2bead00");
    },
    after: async (page) => {
      // From the question, a review and then another from the list: the way back is the list's page, the Inbox.
      for (const id of ["acme/api#4099", "acme/api#4127"]) {
        await page.locator(`.beside .line[data-id="${id}"] .row-main`).click();
        await page.waitForFunction(`decodeURIComponent(location.hash) === ${JSON.stringify(`#/review/${id}`)}`);
        await page.waitForTimeout(200);
      }
      const back = (await page.locator(".page-head .back").textContent())?.trim();
      if (back !== "Inbox") failures.push(`beside-inquiry: two reviews on from the question, the back link reads ${JSON.stringify(back)}`);
      await at("#/")(page);
    },
  },
  // A long title: one line in the table, two at most beside a review, cut at the second's end.
  {
    name: "beside-long",
    sizes: ["wide", "xl"],
    go: async (page) => {
      await queueAs((q) => {
        for (const c of [...q.sections.now, ...q.sections.today]) if (c.id === "acme/api#4127") c.title = LONG;
      })(page);
      await at("#/")(page);
      // How many lines a row's title takes, and whether it's cut short.
      const title = (sel: string) =>
        page.evaluate<{ lines: number; cut: boolean } | null>(`(() => {
          const el = document.querySelector(${JSON.stringify(`${sel} .line[data-id="acme/api#4127"] .line-title`)});
          if (!el) return null;
          const lh = parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.2;
          return { lines: Math.round(el.getBoundingClientRect().height / lh), cut: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1 };
        })()`);
      const table = await title(".queue");
      if (table?.lines !== 1) failures.push(`beside-long: in the table, the long title reads ${JSON.stringify(table)}`);
      await review("acme/api#4127")(page);
      const cut = await title(".beside");
      if (cut?.lines !== 2 || !cut.cut) failures.push(`beside-long: beside the review, the long title reads ${JSON.stringify(cut)}`);
    },
    after: async (page) => {
      await unroute(page);
      await fresh(page);
    },
  },
  // Folding, unfolding and resizing past 1160px and back draw nothing anew and fetch nothing again: the same review, its
  // comment typed, the file you were reading.
  {
    name: "beside-keeps",
    sizes: ["wide", "xl"],
    go: async (page) => {
      await at("#/")(page);
      await review("acme/api#4127")(page);
      const words = "A comment that outlives the list folding";
      await page.locator(".rv-comment-input").fill(words);
      await page.evaluate(`document.querySelectorAll(".rv-file-sec[id]")[1]?.scrollIntoView({ block: "start" })`);
      await page.waitForTimeout(300);
      const reading = () =>
        page.evaluate<string | null>(`(() => {
          let on = null;
          for (const el of document.querySelectorAll(".rv-file-sec[id]")) if (el.getBoundingClientRect().top <= 96) on = el.getAttribute("aria-label");
          return on;
        })()`);
      const before = await reading();
      await page.evaluate(`window.__review = document.querySelector(".rv-main")`);
      const gets: string[] = [];
      const seen = (r: { method: () => string; url: () => string }) => {
        const u = new URL(r.url());
        if (r.method() === "GET" && u.pathname.startsWith("/api/")) gets.push(u.pathname + u.search);
      };
      page.on("request", seen);
      const size = page.viewportSize()!;
      await page.locator(".beside-fold").click();
      await page.waitForTimeout(300);
      await page.locator(".beside-fold").click();
      await page.waitForTimeout(300);
      await page.setViewportSize({ width: 1100, height: size.height });
      await page.waitForTimeout(300);
      await page.setViewportSize(size);
      await page.waitForTimeout(400);
      page.off("request", seen);
      const same = await page.evaluate<boolean>(`document.querySelector(".rv-main") === window.__review`);
      if (!same) failures.push("beside-keeps: the review was drawn anew as the list folded, unfolded or the window resized");
      const kept = await page.locator(".rv-comment-input").inputValue();
      if (kept !== words) failures.push(`beside-keeps: the comment box reads ${JSON.stringify(kept)}`);
      const fetched = gets.filter((u) => u.startsWith("/api/review/") && !u.includes("ahead=1")).length;
      const refreshes = gets.filter((u) => u === "/api/queue").length;
      if (fetched > refreshes) failures.push(`beside-keeps: the review was fetched ${fetched} times in ${refreshes} refreshes`);
      const after = await reading();
      if (after !== before) failures.push(`beside-keeps: reading ${JSON.stringify(before)}, the page moved to ${JSON.stringify(after)}`);
      // Another review from the list: the list stays as it was, marking the new one.
      await page.evaluate(`window.__list = document.querySelector(".beside-list")`);
      await page.locator('.beside .line[data-id="acme/api#4099"] .row-main').click();
      await page.locator(".rv-diff").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(400);
      if (!(await page.evaluate<boolean>(`document.querySelector(".beside-list") === window.__list`)))
        failures.push("beside-keeps: the list was drawn anew for the next review");
      const next = await besideSays(page);
      if (next?.sel !== "acme/api#4099") failures.push(`beside-keeps: the list marks ${JSON.stringify(next?.sel)} for the next review`);
    },
    after: fresh,
  },
  {
    // The owner's case: Skim it, low risk, a long summary with code names, folded under the facts.
    name: "review-ai-skim",
    go: async (page) => {
      await review("nadia/sentry-javascript-integrations#14402")(page);
      const ai = page.locator(".rv-ai");
      if (!(await ai.locator('.rv-ai-lead[aria-expanded="false"]').count()))
        failures.push("review-ai-skim: the AI review doesn't open folded");
      if (await ai.locator(".prose").count()) failures.push("review-ai-skim: the rest of the summary shows while folded");
      if ((await ai.locator(".rv-gist code").count()) < 2) failures.push("review-ai-skim: the first sentence's code names aren't code");
      if ((await ai.allInnerTexts()).join("").includes("`")) failures.push("review-ai-skim: a backtick shows");
      const h = await page.evaluate<number>(`document.querySelector(".rv-ai")?.getBoundingClientRect().height ?? 0`);
      if (h > 120) failures.push(`review-ai-skim: the folded AI review is ${Math.round(h)}px tall`);
      if (!inOrder(await tops(page, [".rv-ai", ".rv-comment"]))) failures.push("review-ai-skim: the AI review isn't above your comment");
    },
  },
  {
    // A click on the verdict opens the rest under the first sentence; a URL in it stays text.
    name: "review-ai-open",
    go: async (page) => {
      await review("nadia/sentry-javascript-integrations#14402")(page);
      const lead = page.locator(".rv-ai-lead");
      if (await lead.count()) await lead.click();
      await page.waitForTimeout(200);
      const ai = page.locator(".rv-ai");
      if (!(await ai.locator('.rv-ai-lead[aria-expanded="true"]').count())) failures.push("review-ai-open: a click doesn't open it");
      if (!(await ai.locator(".prose").allInnerTexts()).join(" ").includes("Tests cover"))
        failures.push("review-ai-open: the rest of the summary is missing");
      if (!(await ai.locator(".prose code").count())) failures.push("review-ai-open: the rest's code names aren't code");
      if (await ai.locator("a").count()) failures.push("review-ai-open: a URL in the AI review is a link");
      if ((await ai.allInnerTexts()).join("").includes("`")) failures.push("review-ai-open: a backtick shows");
    },
  },
  {
    // A re-review being written over one on an earlier commit: since and the concerns stay out of the fold.
    name: "review-ai-since",
    go: async (page) => {
      await review("acme/api#4099")(page);
      const ai = page.locator(".rv-ai");
      if (!(await ai.locator('.rv-ai-lead[aria-expanded="false"]').count()))
        failures.push("review-ai-since: the AI review doesn't open folded");
      if (!(await ai.locator(".rv-verdict").allInnerTexts()).join("").includes("on an earlier commit"))
        failures.push("review-ai-since: the verdict isn't marked on an earlier commit");
      if (!(await ai.allInnerTexts()).join("").includes("Since your review:")) failures.push("review-ai-since: no since line while folded");
      if ((await ai.locator(".rv-since code, .rv-concerns code").count()) < 2)
        failures.push("review-ai-since: since or a concern shows code raw");
      if ((await ai.allInnerTexts()).join("").includes("`")) failures.push("review-ai-since: a backtick shows");
    },
  },
  {
    // A note in the diff draws its code names as code, as the AI review above it does.
    name: "review-ai-note",
    go: async (page) => {
      await review("acme/api#4127")(page);
      await page.evaluate(
        `[...document.querySelectorAll(".rv-note")].find((n) => n.querySelector("code"))?.scrollIntoView({ block: "center" })`,
      );
      await page.waitForTimeout(300);
      const notes = page.locator(".rv-note");
      if (!(await notes.locator("code").count())) failures.push("review-ai-note: a note's code names aren't code");
      if ((await notes.allInnerTexts()).join("").includes("`")) failures.push("review-ai-note: a backtick shows in a note");
    },
  },
  {
    // Opened while the desk fetches its diff: the row's header and AI read at once, quiet placeholders for the rest.
    name: "review-loading",
    go: async (page) => {
      await hold(page, "**/api/review/**");
      await page.locator(READY).first().waitFor({ timeout: 15_000 });
      await at(`#/review/${encodeURIComponent("acme/api#4127")}`)(page);
      await page.waitForTimeout(300);
      if (!(await page.locator('.review[aria-busy="true"] .rv-ai-lead').count()))
        failures.push("review-loading: the row's AI read isn't folded");
      if ((await page.locator(".rv-convo.sk-short").count()) && !inOrder(await tops(page, [".rv-ai", ".rv-convo.sk-short"])))
        failures.push("review-loading: the AI read isn't above the conversation's placeholder");
    },
    // Then the rest lands: the comment box stays where it was drawn, its conversation's line kept for it.
    after: async (page) => {
      const [was] = await tops(page, [".rv-comment"]);
      await page.unroute("**/api/review/**");
      for (const r of held.splice(0)) await r.continue().catch(() => {});
      await page.locator(".rv-diff").first().waitFor({ timeout: 15_000 });
      const [now] = await tops(page, [".rv-comment"]);
      if (Math.abs(now! - was!) > 2) failures.push(`review-loading: the comment box moved ${now! - was!}px when the review landed`);
      await fresh(page);
    },
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
      await page.locator(".rv-ai").waitFor();
      const ask = await page.locator(".rv-ai .link-btn").textContent();
      if (ask !== "Ask Claude for one") failures.push(`review-empty: the AI section offers ${JSON.stringify(ask)}`);
    },
    after: async (page) => {
      await unroute(page);
      await fresh(page);
    },
  },
  {
    // The AI review failed: its error, and Try again beside it.
    name: "review-ai-error",
    go: async (page) => {
      await reviewAs((v) => {
        Object.assign(v, { ai: null, generating: false, ai_error: "Claude Code isn't logged in. Run `claude auth login` in a terminal." });
      })(page);
      await review("acme/api#4127")(page);
      const again = await page.locator(".rv-ai .link-btn").textContent();
      if (again !== "Try again") failures.push(`review-ai-error: the AI section offers ${JSON.stringify(again)}`);
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
  {
    // The + by a line's number: a box under that line, below the thread already on it.
    name: "review-inline",
    go: async (page) => {
      await review("acme/api#4127")(page);
      await (await plusBy(page, 23)).click();
      await page.locator(".rv-inline textarea").waitFor();
      await page.waitForFunction(`document.activeElement?.matches(".rv-inline textarea")`); // Pierre slots the box in a frame later
      await page.keyboard.type("Return how many rows the stream had read when the budget ran out?");
      await page.waitForTimeout(300);
      // Only its GitHub send is a shape: Cancel and Ask your agent are text.
      const filled = await page.locator(".rv-inline .act.primary").count();
      if (filled !== 1) failures.push(`review-inline: ${filled} filled buttons in the box, not 1`);
      if (!(await page.locator(".rv-tc-body code").count())) failures.push("review-inline: a code name in the thread above isn't code");
      if (!(await page.locator(".rv-inline button", { hasText: "Ask your agent" }).count()))
        failures.push("review-inline: the box has no Ask your agent");
      // Its Comment on screen when it opens, not only the words.
      const send = await page.locator(".rv-inline .act.primary").boundingBox();
      if (!send || send.y < 0 || send.y + send.height > page.viewportSize()!.height)
        failures.push(`review-inline: the box's Comment is off screen: ${JSON.stringify(send)}`);
    },
  },
  // Your own draft's one call to action is Ready for review; your ready PR's is Hand off for merge.
  { name: "review-draft", go: review("acme/web#2303") },
  // Your ready PR nobody's asked to review: back on top of the queue with Add reviewers.
  {
    name: "queue-unasked",
    go: async (page) => {
      await fresh(page);
      await queueAs((q) => {
        for (const c of [...q.sections.now, ...q.sections.today])
          if (c.id === "acme/api#3051")
            Object.assign(c, { cta: "reviewers", handed_back: true, group: "back", why: "nobody's asked to review it: add reviewers" });
      })(page);
      await top(page);
    },
    after: async (page) => {
      await unroute(page);
      await page.reload();
      await page.locator(READY).first().waitFor({ timeout: 15_000 });
    },
  },
  // Its review: the reviewers box has the cursor, GitHub's suggestions beside it, Ask reviewers the one to press.
  {
    name: "review-unasked",
    go: async (page) => {
      await fresh(page);
      await reviewAs((v) => {
        if (v.card.id !== "acme/api#3051") return;
        Object.assign(v.card, { cta: "reviewers", handed_back: true, why: "nobody's asked to review it: add reviewers" });
        v.item = { ...v.item, review_requests: [] };
      })(page);
      await at(`#/review/${encodeURIComponent("acme/api#3051")}`)(page);
      // The box has the cursor and its list stays closed, so nothing covers Ask reviewers; GitHub's picks are on the line.
      await page.waitForFunction(`document.activeElement?.matches(".rv-reviewers-input")`);
      await page.locator(".rv-suggested .suggest").first().waitFor();
      await page.waitForTimeout(300);
      if (await page.locator(".rv-reviewers-pop").count()) failures.push("review-unasked: the reviewers list opens over Ask reviewers");
    },
    after: async (page) => {
      await unroute(page);
      await fresh(page);
    },
  },
  // The reviewers box opens GitHub's suggested reviewers for your draft.
  {
    name: "review-reviewers",
    go: async (page) => {
      await review("acme/web#2303", [".rv-reviewers-input"])(page);
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
  // Ready for review: it's off your desk at once; the review stays, saying what you did and where it went, its spinner while GitHub (here
  // never) answers. The held request stays held (unrouting would let it through to the mock); a reload brings the row back.
  {
    name: "review-ready-sent",
    go: async (page) => {
      await page.route("**/ready", () => {});
      await review("acme/web#2303", ['.rv-actions button:has-text("Ready for review")'])(page);
      await page.waitForTimeout(300);
    },
    after: fresh,
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
      // Claude's read, what azulus wrote and the folded lines set code names as code.
      const convo = page.locator(".rv-convo");
      if ((await convo.locator(".cv-take code, .cv-body code, .cv-line code").count()) < 3)
        failures.push("review-conversation: a code name in the conversation isn't code");
      if ((await convo.allInnerTexts()).join("").includes("`")) failures.push("review-conversation: a backtick shows");
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
  // The sidebar lists a file at the repo's root and a long folder.
  {
    name: "review-python",
    go: async (page) => {
      await review("acme/ml-pipeline#311")(page);
      // Its files are what it's for: open over the diff where the column folds them.
      const files = page.locator(".rv-side-show");
      if (await files.isVisible()) await files.click();
      await page.waitForTimeout(200);
    },
    after: sideDefault,
  },
  // In a stack: its place after the ref, and the chain in the sidebar, this PR marked.
  { name: "review-stack", go: review("acme/api#4154") },
  // Past the last change: the folded rest's line where the review has one (the mock's doesn't), and a click opens it in place.
  ...(["review-fold", "review-rest"] as const).map((name): Shot => ({
    name,
    go: async (page) => {
      await review("acme/api#4127")(page);
      const fold = page.locator(".rv-fold");
      if (!(await fold.count())) await page.locator(".rv-file-sec").last().scrollIntoViewIfNeeded();
      else if (name === "review-rest") await fold.click();
      else await fold.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
    },
  })),
  {
    // A capped ranking: what Claude didn't read, then the hunks it left out, marked Skip.
    name: "review-unread",
    go: async (page) => {
      await review("acme/worker#879")(page);
      await toBottom("review-unread")(page);
    },
  },
  {
    // Hide or Files: folded where it was open (wide), open over the diff where it starts folded (narrow).
    name: "review-side-toggled",
    go: review("acme/api#4154", [".rv-side-toggle"]),
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
    // A click from the queue on a PR with no AI review yet: it's being written.
    name: "review-writing",
    go: async (page) => {
      await at("#/")(page);
      await unfold(page);
      await page.locator(".line", { hasText: "Virtualize the issue stream list" }).locator(".row-main").click();
      await page.locator(".rv-diff").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(600);
    },
  },
  {
    // A row's menu, Snooze open: the times, then what this PR can wait on.
    name: "snooze",
    go: async (page) => {
      await at("#/")(page);
      await rowMenuPick(page, '.line:has-text("Support HTTP/2 prior knowledge")', "Snooze");
      await page.locator(".ctx-sub").waitFor();
      await page.waitForTimeout(200);
    },
    after: async (page) => {
      for (let i = 0; i < 2 && (await page.locator(".ctx").count()); i++) await page.keyboard.press("Escape");
    },
  },
  {
    // The Archive, what you finished and what resolved, newest first.
    name: "archive",
    go: async (page) => {
      await at("#/archive")(page);
      await page.locator(".g-archive").waitFor();
      await page.waitForTimeout(200);
    },
  },
  {
    // A click on a resolved PR in the Archive: its review says why it resolved, and when, under the facts.
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
      if (!(await page.locator(".rv-side").isVisible())) await page.locator(".rv-side-show").click(); // folded in a narrow window
      await page.locator(".rv-side .rv-more").click();
      await page.waitForTimeout(200);
    },
    after: sideDefault,
  },
  // FYI: what Claude and the rules sorted away, on its own page.
  {
    name: "later",
    go: async (page) => {
      await at("#/later")(page);
      const on = await sideOn(page);
      if (on !== "FYI") failures.push(`later: the sidebar marks ${JSON.stringify(on)}`);
      const head = await headSays(page);
      if (head !== "Filter") failures.push(`later: the page head reads ${JSON.stringify(head)}, not the filter`);
    },
  },
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
  // Merging: what each waits on and the coordinator's latest note, one merged; your agent's line has its buttons.
  {
    name: "inflight",
    go: async (page) => {
      await at("#/inflight")(page);
      const head = await headSays(page);
      if (head !== "Merging") failures.push(`inflight: the page head reads ${JSON.stringify(head)}`);
      for (const b of ["Copy attach command", "Wake it"])
        if (!(await page.locator(".lane-coord button", { hasText: b }).count())) failures.push(`inflight: your agent's line has no ${b}`);
      // Each row's whole phrase, with the note's age, is its tooltip.
      const note = await page.evaluate<{ first: string; title: string | null } | null>(`(() => {
        const n = document.querySelector(".lane-row:not(.dim) .line-note");
        return n && { first: n.querySelector(".dots > span")?.textContent ?? "", title: n.getAttribute("title") };
      })()`);
      if (!note?.first || !note.title?.startsWith(note.first) || !note.title.slice(note.first.length).startsWith(" \u00b7 "))
        failures.push(`inflight: the first row's phrase has the tooltip ${JSON.stringify(note)}`);
    },
  },
  {
    // One click on a row opens its review.
    name: "inflight-click",
    go: async (page) => {
      await at("#/inflight")(page);
      await page.locator(".lane-row:not(.dim) .row-main").first().click();
      await page.waitForTimeout(300);
      const hash = await page.evaluate<string>("location.hash");
      if (!hash.startsWith("#/review/")) failures.push(`inflight-click: a click on a row went to ${hash}`);
    },
  },
  {
    // Nothing handed off yet, and your agent not started: Start it now.
    name: "inflight-empty",
    go: async (page) => {
      await page.route("**/api/inflight", async (route) => {
        const res = await route.fetch();
        const v = (await res.json()) as InflightView;
        v.rows = [];
        v.coordinator = { ...v.coordinator, id: null, url: null };
        await route.fulfill({ response: res, json: v });
      });
      await at("#/")(page); // from Merging itself the hash wouldn't change, so nothing would refetch
      await at("#/inflight")(page);
      await page
        .locator(".lane-coord button", { hasText: "Start it now" })
        .waitFor({ timeout: 5000 })
        .catch(() => failures.push("inflight-empty: your agent's line has no Start it now"));
    },
    after: unroute,
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
      if (!(await page.locator(".lane-coord-error button", { hasText: "Try again" }).count()))
        failures.push("inflight-coord-error: your agent's line has no Try again");
    },
    after: unroute,
  },
  {
    // A row Tab reached: its whole phrase under it, and no buttons (a click opens it, a right-click has the rest).
    name: "inflight-selected",
    go: async (page) => {
      await at("#/")(page); // from Merging itself the hash wouldn't change, so the shot before's view would stay
      await at("#/inflight")(page);
      await page.locator(".lane [data-id]").nth(1).locator(".row-main").focus();
      await page.waitForTimeout(200);
      if (await page.locator(".lane-more .act").count()) failures.push("inflight-selected: the selected row has buttons");
      if (await page.locator(".lane-coord-error").count()) failures.push("inflight-selected: your agent's line shows an error");
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
    // Hand off for merge, in your own PR's row menu: the row leaves at once, a spinner in the toast while the desk (here never) answers.
    name: "handoff-sent",
    go: async (page) => {
      await page.route("**/api/act", async (route) => {
        if ((route.request().postDataJSON() as { action?: string }).action !== "inflight") await route.continue();
      });
      await at("#/")(page);
      await rowMenuPick(page, '.line[data-id="oss/tinyhttp#205"]', "Hand off for merge");
      await page.waitForTimeout(300);
    },
    after: fresh,
  },
  {
    // An agent's question leads the main page; a click opens its page: what it's about, all it said, its links, the answers.
    name: "inquiry",
    go: async (page) => {
      await at("#/")(page);
      await top(page);
      await page.locator(".queue .line.inq .row-main").first().click();
      await page.locator(".inquiry .inq-options").waitFor();
      await page.waitForTimeout(200);
      // Your agent's own question: its answer box is how you talk to it here.
      if (await page.locator(".side-ask").count()) failures.push("inquiry: the sidebar offers Ask your agent on its own question");
      const back = (await page.locator(".page-head .back").textContent())?.trim();
      if (back !== "Inbox") failures.push(`inquiry: the back link reads ${JSON.stringify(back)}`);
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
    // A click picks the agent's answer: the page stays and says so while it's sent. Held, so the mock's question waits for the next size.
    name: "inquiry-answered",
    go: async (page) => {
      await page.route("**/api/inquiries/*/answer", () => {});
      await at("#/inquiry/q1c0ffee")(page);
      await page.locator(".inquiry .inq-option").first().click();
      await page.locator(".inq-answered").waitFor();
      await page.waitForTimeout(200);
    },
    // Then the check: the queue's view holds open questions only, and the page still knows the question is your agent's.
    after: async (page) => {
      await page.route("**/api/queue", async (route) => {
        const res = await route.fetch();
        const q = (await res.json()) as QueueView;
        q.inquiries = q.inquiries.filter((x) => x.id !== "q1c0ffee");
        await route.fulfill({ response: res, json: q });
      });
      // The overview says whether your agent is on: Ask your agent's absence means something once it's in.
      const overview = page.waitForResponse((r) => r.url().endsWith("/api/overview"));
      await page.reload();
      await page.locator(".inquiry .inq-options").waitFor();
      await overview;
      await page.waitForTimeout(300);
      if (await page.locator(".side-ask").count())
        failures.push("inquiry-answered: the sidebar offers Ask your agent once the queue drops the answered question");
      await unroute(page);
      await fresh(page);
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
    // A click on a Merging row: its review says what Merging says, and Esc goes back there.
    name: "review-inflight",
    go: async (page) => {
      await at("#/inflight")(page);
      await page.locator('.lane [data-id="acme/api#4122"] .row-main').click();
      await page.locator(".rv-diff").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(600);
    },
  },
  {
    // A row menu's Ask your agent: the chat about that row, the queue narrowed beside it at wide sizes.
    name: "ask-row",
    go: async (page) => {
      await at("#/")(page);
      await rowMenuPick(page, '.line[data-id="oss/tinyhttp#205"]', "Ask your agent");
      await page.locator(".chat-input").waitFor();
      await page.keyboard.type("I think we addressed this in the follow-up, you can dismiss it");
      await page.waitForTimeout(300);
      if (await page.locator(".line-ask").count()) failures.push("ask-row: a row still has its own Ask");
      if (await page.locator(".side-ask").isVisible()) failures.push("ask-row: the sidebar offers Ask your agent with the chat open");
    },
    after: closeChat,
  },
  {
    // Ask your agent on Blocked's first row: beside the chat, every row's why wraps whole rather than run under More.
    name: "ask-blocked",
    go: async (page) => {
      await at("#/blocked")(page);
      await page.locator(".queue [data-id]").first().locator(".row-main").focus();
      await page.locator(".side-ask").click();
      await page.locator(".chat-input").waitFor();
      await page.waitForTimeout(300);
      const cut = await page.evaluate<number[]>(
        `[...document.querySelectorAll(".queue .row-main")].map((b) => b.scrollWidth - b.clientWidth).filter((d) => d > 0)`,
      );
      if (cut.length) failures.push(`ask-blocked: ${cut.length} row(s) overflow and clip, by ${cut.join(", ")}px`);
    },
    after: closeChat,
  },
  {
    // In a review, about the conversation you were on: sent, it waits for the answer under it.
    name: "ask-review",
    go: async (page) => {
      const sent: Ask = {
        id: "shot0001",
        at: new Date().toISOString(),
        text: "Confirm we addressed priya's question so I can reply",
        item_id: "me/notes-app#12",
        thread_id: "IC_freeze",
        thread_url: null,
        answer: null,
      };
      let posted = false;
      await page.route("**/api/ask", (route) => {
        posted = true;
        return route.fulfill({ json: { ok: true, ask: sent } });
      });
      // A sync mid-shot refetches the asks: they keep the one sent, as the desk's would.
      await page.route("**/api/asks", async (route) => {
        const res = await route.fetch();
        const v = (await res.json()) as AsksView;
        if (posted) v.asks.push(sent);
        await route.fulfill({ response: res, json: v });
      });
      await review("me/notes-app#12")(page);
      // A box that posts on GitHub names what it does there: Send is only for your agent.
      const convos = await page.evaluate<
        { buttons: string[]; filled: string; lead: boolean }[]
      >(`[...document.querySelectorAll(".cv")].map((cv) => {
        const words = (b) => b.textContent.trim();
        const actions = cv.querySelector(".actions");
        const send = actions.querySelector(".act.primary, .act.s-cta");
        return { buttons: [...actions.querySelectorAll("button, a")].map(words), filled: send ? words(send) : "", lead: !!send?.matches(".primary") };
      })`);
      for (const [i, c] of convos.entries()) {
        if (c.buttons.some((b) => b.includes("Send") || b === "Ask coordinator"))
          failures.push(`ask-review: conversation ${i + 1}'s actions read ${c.buttons.join(", ")}`);
        if (c.filled !== "Reply") failures.push(`ask-review: conversation ${i + 1}'s call to action reads "${c.filled}", not Reply`);
      }
      // One filled Reply on the page, the first's; the rest tinted.
      if (convos.filter((c) => c.lead).length !== 1 || !convos[0]?.lead)
        failures.push(`ask-review: filled Replies ${JSON.stringify(convos.map((c) => c.lead))}, not the first alone`);
      if (!convos[1]?.buttons.includes("Ask your agent")) failures.push("ask-review: the second conversation has no Ask your agent");
      await page.locator(".cv-reply").nth(1).focus();
      await page.keyboard.press("Escape");
      // The cached asks draw at once: the fetch must land before the send, or it would replace the ask sent.
      const loaded = page.waitForResponse((r) => r.url().endsWith("/api/asks"));
      await page.locator(".side-ask").click();
      await loaded;
      await page.locator(".chat-turn", { hasText: "412 passed" }).waitFor();
      for (const el of [".chat .prose pre", ".chat .prose ol", ".chat .prose ul"]) await page.locator(el).waitFor();
      const asked = await page.evaluate<{ text: string; href: string | null } | null>(`(() => {
        const q = document.querySelector(".chat-q");
        return q && { text: q.textContent, href: q.querySelector("a")?.getAttribute("href") ?? null };
      })()`);
      if (!asked?.text.startsWith("Your agent asks: Compact tombstones") || asked.href !== "#/inquiry/q1c0ffee")
        failures.push(`ask-review: above the box, ${JSON.stringify(asked)} rather than your agent's question about notes-app#12`);
      if (
        !(await page.evaluate<boolean>(
          `[...document.querySelectorAll(".chat .prose pre")].every((p) => p.nextElementSibling?.classList.contains("prose-copy"))`,
        ))
      )
        failures.push("ask-review: a code block in an answer has no Copy under it");
      await page.keyboard.type("Confirm we addressed priya's question so I can reply");
      await page.keyboard.press("Enter");
      await page.locator(".chat-turn", { hasText: "priya's question" }).waitFor();
      if (await page.locator(".rv-side").count()) failures.push("ask-review: the review's sidebar shows beside the chat");
      await page.waitForTimeout(300);
    },
    after: async (page) => {
      await unroute(page);
      await closeChat(page);
    },
  },
  {
    // The chat's log at its first turn, an answer's numbered list.
    name: "ask-top",
    go: async (page) => {
      await review("me/notes-app#12")(page);
      // The fetch lands before the scroll: a turn it adds or drops sends the log back to the newest.
      const loaded = page.waitForResponse((r) => r.url().endsWith("/api/asks"));
      await page.locator(".side-ask").click();
      await loaded;
      await page.locator(".chat .prose ol").waitFor();
      await page.waitForTimeout(100);
      await page.evaluate(`document.querySelector(".chat-log").scrollTop = 0`);
      await page.waitForTimeout(200);
    },
    after: closeChat,
  },
  {
    // A PR whose latest ask is unanswered, the chat closed: the sidebar's Ask says so, in what fits it; its action line doesn't.
    name: "ask-waiting",
    go: async (page) => {
      await review("me/notes-app#12")(page);
      const width = page.viewportSize()?.width ?? 0;
      const ask = await page.evaluate<{ words: string; icon: boolean; waiting: boolean } | null>(`(() => {
        const b = document.querySelector(".side-ask");
        const shown = (el) => !!el && getComputedStyle(el).display !== "none";
        return b && { words: [...b.querySelectorAll("span")].filter(shown).map((s) => s.textContent).join(""), icon: shown(b.querySelector(".i")), waiting: b.classList.contains("waiting") };
      })()`);
      const want = width > 1000 ? "Your agent \u00b7 waiting" : "Asked";
      if (!ask || ask.words !== want || !ask.waiting || !ask.icon)
        failures.push(`ask-waiting: at ${width}px the sidebar's ask is ${JSON.stringify(ask)}, not ${want} by its icon`);
      const actions = (await page.locator(".rv-actions").textContent()) ?? "";
      if (/Coordinator|agent/.test(actions)) failures.push(`ask-waiting: the review's actions say ${actions}`);
    },
  },
  {
    // Lines picked down the gutter, then their box's Ask your agent: the box goes (it was empty), the chat is on those lines.
    name: "ask-lines",
    go: async (page) => {
      const posted = await echoAsks(page, "shot0002");
      await linesInChat(page);
      const c = await chatState(page);
      if (c.box || !c.on?.startsWith("On plan.ts:20\u201323") || !c.focus)
        failures.push(`ask-lines: after Ask your agent, ${JSON.stringify(c)}`);
      await page.keyboard.type("why is the budget only checked between batches?");
      await page.keyboard.press("Enter");
      await page.locator(".chat-turn .chat-meta", { hasText: "on plan.ts:20\u201323" }).waitFor();
      const b = posted[0] ?? {};
      const { head, ...lines } = (b.lines ?? {}) as Partial<AskLines>;
      if (JSON.stringify(lines) !== JSON.stringify(LINES) || !/^[0-9a-f]{40}$/.test(head ?? "") || "thread_id" in b)
        failures.push(`ask-lines: it posted ${JSON.stringify(b)}`);
      await page.waitForTimeout(200);
    },
    after: async (page) => {
      await unroute(page);
      await closeChat(page);
    },
  },
  {
    // Words in the + box, then its Ask your agent: they stay in the box, unsent, and the chat is on that line.
    name: "ask-lines-words",
    go: async (page) => {
      const words = "Return how many rows the stream had read when the budget ran out?";
      await fresh(page);
      await review("acme/api#4127")(page);
      await (await plusBy(page, 23)).click();
      await page.waitForFunction(`document.activeElement?.matches(".rv-inline textarea")`); // Pierre slots the box in a frame later
      await page.keyboard.type(words);
      await page.route("**/api/review/*/inline", (route) => {
        failures.push("ask-lines-words: Ask your agent posted to GitHub");
        return route.abort();
      });
      await page.locator(".rv-inline button", { hasText: "Ask your agent" }).click();
      await page.locator(".chat-input").waitFor();
      const c = await chatState(page);
      const kept = await page.locator(".rv-inline textarea").inputValue();
      if (kept !== words || c.on !== "On plan.ts:23\u00d7" || !c.focus)
        failures.push(`ask-lines-words: the box holds ${JSON.stringify(kept)}, the chat ${JSON.stringify(c)}`);
      await page.locator(".rv-inline").scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
    },
    after: async (page) => {
      await unroute(page);
      await closeChat(page);
      await fresh(page); // the words are kept per PR in this window
    },
  },
  {
    // The line's x: the next ask is about the whole PR.
    name: "ask-lines-drop",
    go: async (page) => {
      const posted = await echoAsks(page, "shot0003");
      await linesInChat(page);
      await page.locator(".chat-on .chat-drop").click();
      const c = await chatState(page);
      if (c.on !== null || !c.focus) failures.push(`ask-lines-drop: after its x, ${JSON.stringify(c)}`);
      await page.keyboard.type("is anything else in this PR worth a second look?");
      await page.keyboard.press("Enter");
      await page.locator(".chat-turn", { hasText: "worth a second look" }).waitFor();
      if (posted[0]?.lines) failures.push(`ask-lines-drop: it posted lines ${JSON.stringify(posted[0].lines)}`);
      await page.waitForTimeout(200);
    },
    after: async (page) => {
      await unroute(page);
      await closeChat(page);
    },
  },
  {
    // The sidebar's Ask your agent on the queue: the chat about the selected row; the head's x makes it about nothing.
    name: "ask-general",
    go: async (page) => {
      const posted = await echoAsks(page, "shot0004");
      await at("#/")(page);
      await page.locator('.line[data-id="oss/tinyhttp#205"] .row-main').focus();
      await page.locator(".side-ask").click();
      await page.locator(".chat-input").waitFor();
      const before = await chatState(page);
      if (before.about !== "tinyhttp#205") failures.push(`ask-general: the chat is about ${JSON.stringify(before.about)}`);
      await page.locator(".chat-head .chat-drop").click();
      const c = await chatState(page);
      if (c.about !== "" || c.drops || !c.focus) failures.push(`ask-general: after the head's x, ${JSON.stringify(c)}`);
      await page.keyboard.type("what should I look at first?");
      await page.keyboard.press("Enter");
      await page.locator(".chat-turn", { hasText: "look at first" }).waitFor();
      if (posted[0]?.item_id) failures.push(`ask-general: it posted item_id ${JSON.stringify(posted[0].item_id)}`);
      await page.waitForTimeout(200);
    },
    after: async (page) => {
      await unroute(page);
      await closeChat(page);
    },
  },
  {
    // Ask your agent on Settings: the chat about nothing beside the page.
    name: "ask-settings",
    go: async (page) => {
      await at("#/settings/github")(page);
      await page.locator(".side-ask").click();
      await page.locator(".chat-input").waitFor();
      await page.waitForTimeout(200);
    },
    after: closeChat,
  },
  {
    // Files with the chat open beside the review: the chat closes and the sidebar is back in its place. At 1100px and below
    // the chat lies over the page, Files under it: Close first.
    name: "ask-f",
    go: async (page) => {
      await review("acme/api#4154")(page);
      await page.locator(".side-ask").click();
      await page.locator(".chat-empty").waitFor(); // no asks about it yet: no log to focus
      if ((page.viewportSize()?.width ?? 0) <= 1100) await page.locator(".chat-head button", { hasText: "Close" }).click();
      await page.locator(".rv-side-show").click();
      await page.locator(".chat").waitFor({ state: "detached" });
      await page.locator(".rv-side").waitFor();
    },
    after: sideDefault,
  },
  {
    // Your agent off: no Ask your agent anywhere.
    name: "ask-off",
    go: async (page) => {
      await page.route("**/api/asks", (route) => route.fulfill({ json: { on: false, asks: [] } }));
      await page.route("**/api/overview", async (route) => {
        const res = await route.fetch();
        const o = (await res.json()) as Overview;
        o.agent = false;
        await route.fulfill({ response: res, json: o });
      });
      await page.reload();
      await page.locator(READY).first().waitFor({ timeout: 15_000 });
      await review("me/notes-app#12")(page);
      const asks = await page.evaluate<string[]>(
        `[...document.querySelectorAll("button, a")].filter((el) => !el.closest(".chat") && el.textContent.includes("Ask your agent")).map((el) => el.className)`,
      );
      if (asks.length || (await page.locator(".side-ask").count()))
        failures.push(`ask-off: the review offers Ask your agent: ${asks.join(", ")}`);
      await at("#/")(page);
      await page.locator(".line", { hasText: "Drop the legacy v1 auth" }).locator(".row-main").click({ button: "right" });
      await page.locator(".ctx").waitFor();
      if ((await page.locator(".ctx").textContent())?.includes("Ask your agent"))
        failures.push("ask-off: a row's menu offers Ask your agent");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    },
    // A refresh can still be on its way through the overview's handler: unroute lets it finish quietly.
    after: async (page) => {
      await unroute(page);
      await closeChat(page);
      await fresh(page);
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
  // Ready for review on its row: off the list at once, a spinner while GitHub (here never) answers. Held, as review-ready-sent's, so the
  // mock's draft stays a draft for the next size's shots.
  {
    name: "draft-cta-sent",
    go: async (page) => {
      await page.route("**/ready", () => {});
      await at("#/")(page);
      await unfold(page);
      await page.locator('.line[data-id="acme/web#2303"] .line-cta').click();
      await page.waitForTimeout(500); // past the row's fade and fold
    },
    after: fresh,
  },
  {
    // A PR the policy judge placed: Why it's here opens it in place; its rule trace ends with the policy step.
    name: "judged",
    after: refold,
    go: async (page) => {
      await at("#/")(page);
      await unfold(page);
      await rowMenuPick(page, '.line:has-text("Rewrite the tokenizer with a state table")', "Why it's here");
      await page.locator(".trace-toggle summary").first().click();
      await page.waitForTimeout(300);
    },
  },
  {
    // GitHub's part at the top, its tuning and prompts folded behind More.
    name: "settings-github",
    go: async (page) => {
      await at("#/settings/github")(page);
      if (await page.evaluate<boolean>(`!!document.getElementById("setting-github.poll_seconds")?.getClientRects().length`))
        failures.push("settings-github: More GitHub settings is open on arrival");
      const rows = await statusRows(page, "github");
      if (rows.length !== 1 || !rows[0]!.startsWith("Signed in as @"))
        failures.push(`settings-github: GitHub's status rows read ${JSON.stringify(rows)}`);
      const tip = await page.evaluate<string | null>(`document.querySelector("#s-github .s-status")?.title ?? null`);
      if (!tip?.startsWith("Your teams: @")) failures.push(`settings-github: the status row's tooltip reads ${JSON.stringify(tip)}`);
    },
    sizes: ["wide", "mid", "min", "mac", "xl"],
  },
  {
    // More GitHub settings opened with a click: its rows in the same sheet, under it.
    name: "settings-github-more",
    go: async (page) => {
      await at("#/settings/github")(page);
      await page.getByRole("button", { name: "More GitHub settings" }).click();
      const hidden = await page.evaluate<
        string[]
      >(`["github.my_repos", "github.bots", "github.close_collaborator_min", "github.poll_seconds",
        "handoff.prompt", "handoff.mine", "handoff.issue"].filter((k) => !document.getElementById("setting-" + k)?.getClientRects().length)`);
      if (hidden.length) failures.push(`settings-github-more: ${hidden.join(", ")} still folded`);
      await page.evaluate(`scrollBy(0, document.querySelector(".s-more").getBoundingClientRect().top - 160)`);
      await page.waitForTimeout(200);
    },
    after: async (page) => {
      await page.getByRole("button", { name: "More GitHub settings" }).click();
    },
  },
  {
    // GitHub's last sync failed on its login: the status row's help is the error in red, with the fix.
    name: "settings-github-error",
    go: async (page) => {
      // As the desk would say it everywhere: the sidebar's sync line failed too.
      await overviewAs((o) => {
        o.sync_error = "GitHub rejected the token (HTTP 401)";
      })(page);
      await settingsAs((v) => {
        v.github.error = "GitHub rejected the token (HTTP 401)";
      })(page);
      await at("#/settings/github")(page);
      const label = await page.locator("#s-github .s-status .s-label").textContent();
      if (label !== "GitHub doesn't accept your login")
        failures.push(`settings-github-error: the status row says ${JSON.stringify(label)}`);
      const help = await page.evaluate<{ text: string; red: boolean } | null>(`(() => {
        const h = document.querySelector("#s-github .s-status .s-help");
        return h && { text: h.textContent, red: h.classList.contains("t-bad") };
      })()`);
      if (!help?.red || !help.text.includes("Run gh auth login in a terminal, then sync."))
        failures.push(`settings-github-error: the status row's help reads ${JSON.stringify(help)}`);
      // The sync line that help means: there with the error, red, the error in its tooltip.
      await page.locator(".side-sync").waitFor({ timeout: 5000 });
      const line = await syncLine(page);
      if (line?.text !== "Sync failed" || !line.red || line.tip !== "GitHub rejected the token (HTTP 401)")
        failures.push(`settings-github-error: the sidebar's sync line reads ${JSON.stringify(line)}`);
    },
    after: unsettle,
  },
  { name: "settings-queue", go: at("#/settings/queue") },
  {
    // Quiet hours stored unpadded, as `desk settings set` may write it: in and out of its time without a change saves nothing.
    name: "settings-queue-quiet-kept",
    go: async (page) => {
      await settingsAs((v) => {
        v.values["notify.quiet"] = "9:30-17:05";
      })(page);
      await at("#/settings/queue")(page);
      const puts: string[] = [];
      const put = (r: Sent) => {
        if (r.method() === "PUT" && r.url().includes("/api/settings")) puts.push(r.postData() ?? "");
      };
      page.on("request", put);
      await page.locator('[id="setting-notify.quiet-from"]').click();
      await page.locator('[id="setting-queue.cards"]').click();
      await page.waitForTimeout(400);
      page.off("request", put);
      if (puts.length) failures.push(`settings-queue-quiet-kept: leaving quiet hours unchanged saved ${puts.join(", ")}`);
    },
    after: unsettle,
  },
  {
    // Notifications off: quiet hours has nothing to do, so its words and its field are greyed and the field takes nothing.
    name: "settings-queue-off",
    go: async (page) => {
      await settingsAs((v) => {
        v.values["notify.enabled"] = false;
      })(page);
      await at("#/settings/queue")(page);
      const quiet = await page.evaluate<{ off: boolean; disabled: boolean } | null>(`(() => {
        const row = document.getElementById("row-notify.quiet"), field = document.getElementById("setting-notify.quiet");
        return row && field && { off: row.classList.contains("s-off"), disabled: field.disabled };
      })()`);
      if (!quiet?.off || !quiet.disabled) failures.push(`settings-queue-off: quiet hours isn't greyed: ${JSON.stringify(quiet)}`);
      if (await page.evaluate<boolean>(`document.getElementById("setting-notify.enabled").disabled`))
        failures.push("settings-queue-off: Notify me is greyed too");
    },
    after: unsettle,
  },
  {
    // Quiet hours off: its switch off, and its times greyed but kept, 19:00 and 09:00 until you've had others.
    name: "settings-queue-quiet-off",
    go: async (page) => {
      await settingsAs((v) => {
        v.values["notify.quiet"] = "";
      })(page);
      await at("#/settings/queue")(page);
      const seen = await page.evaluate<string>(`["from", "to", ""].map((s) => {
        const f = document.getElementById("setting-notify.quiet" + (s && "-" + s));
        return (s ? f.value : f.checked ? "on" : "off") + (f.disabled ? " greyed" : "");
      }).join()`);
      if (seen !== "19:00 greyed,09:00 greyed,off") failures.push(`settings-queue-quiet-off: quiet hours reads ${seen}`);
    },
    after: unsettle,
  },
  {
    // Each kind of control saves as you go: a number, quiet hours off, on and a new start, a switch by its label, a select,
    // a repo under More and, in the app, the shortcut's Turn off; then Reset to default puts each back. Shot on the last.
    name: "settings-saves",
    writes: true,
    go: async (page) => {
      reposWere ??= await deskHas(page, "github.my_repos");
      await at("#/settings/queue")(page);
      const days = page.locator('[id="setting-queue.quiet_days"]');
      await saveStep(page, "quiet days", "queue.quiet_days", {
        edit: () => days.fill("7"),
        commit: () => days.press("Enter"),
        want: 7,
      });
      const quiet = page.locator('[id="setting-notify.quiet"]');
      const from = page.locator('[id="setting-notify.quiet-from"]');
      await saveStep(page, "quiet hours off", "notify.quiet", { commit: () => quiet.click(), want: "" });
      const off = await page.evaluate<string[]>(
        `["from", "to"].map((s) => { const f = document.getElementById("setting-notify.quiet-" + s); return f.value + (f.disabled ? " greyed" : ""); })`,
      );
      if (off.join() !== "19:00 greyed,09:00 greyed") failures.push(`settings-saves: quiet hours off shows ${JSON.stringify(off)}`);
      await saveStep(page, "quiet hours on", "notify.quiet", { commit: () => quiet.click(), want: "19:00-09:00" });
      await saveStep(page, "quiet hours from 20:00", "notify.quiet", {
        edit: () => from.fill("20:00"),
        commit: () => from.press("Enter"),
        want: "20:00-09:00",
      });
      await saveStep(page, "Notify me off", "notify.enabled", {
        commit: () => page.locator('label[for="setting-notify.enabled"]').click(),
        want: false,
      });
      if (!(await quiet.isDisabled())) failures.push("settings-saves: quiet hours isn't greyed with notifications off");
      await at("#/settings/github")(page);
      const pick = page.locator('[id="setting-github.resolve_on_others_approval"]');
      await saveStep(page, "a select", "github.resolve_on_others_approval", {
        commit: async () => {
          await pick.selectOption("never");
        },
        want: "never",
      });
      await page.getByRole("button", { name: "More GitHub settings" }).click();
      const repos = page.locator('[id="setting-github.my_repos"]');
      await saveStep(page, "a repo", "github.my_repos", {
        edit: async () => {
          await repos.evaluate((el: { focus: () => void; setSelectionRange: (a: number, b: number) => void; value: string }) => {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
          });
          await page.keyboard.type("\nacme/new-repo");
        },
        commit: () => repos.blur(),
        want: [...(reposWere as string[]), "acme/new-repo"],
      });
      if (await page.evaluate<boolean>("!!window.desktop")) {
        await at("#/settings/app")(page);
        const row = page.locator('[id="row-app.hotkey"]');
        await saveStep(page, "the shortcut off", "app.hotkey", {
          commit: () => row.getByRole("button", { name: "Turn off" }).click(),
          want: "",
        });
        const says = await hotkeySays(page, "Off.");
        if (says !== "Off." || (await row.getByRole("button", { name: "Turn off" }).count()))
          failures.push(`settings-saves: the shortcut off reads ${JSON.stringify(says)}, with Turn off still there`);
        await resetStep(page, "app.hotkey", "Control+Alt+D");
        const back = await hotkeySays(page, "Works from any app.");
        if (back !== "Works from any app.") failures.push(`settings-saves: the shortcut back reads ${JSON.stringify(back)}`);
        await at("#/settings/github")(page);
      }
      await resetStep(page, "github.my_repos", [], false);
      await resetStep(page, "github.resolve_on_others_approval", "always");
      await page.getByRole("button", { name: "More GitHub settings" }).click();
      await at("#/settings/queue")(page);
      await resetStep(page, "notify.enabled", true);
      await resetStep(page, "notify.quiet", "19:00-09:00");
      await resetStep(page, "queue.quiet_days", 14);
    },
    // What a step that failed left: each back to the default, and the mock's own repos back.
    after: async (page) => {
      await page.evaluate(
        `fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(${JSON.stringify({
          set: { "github.my_repos": reposWere },
          reset: ["queue.quiet_days", "notify.quiet", "notify.enabled", "github.resolve_on_others_approval", "app.hotkey"],
        })}) })`,
      );
      const open = page.locator('.s-more [aria-expanded="true"]');
      if (await open.count()) await open.click();
      await at("#/")(page);
    },
  },
  {
    // Searches and rules, a view of its own: the head's way back to Settings, its name, the column at 1180px, Save on screen,
    // and still on screen with the editor dragged taller than the window; its code wraps, never scrolling sideways.
    name: "settings-rules",
    go: async (page) => {
      await at("#/settings/rules")(page);
      await settingsView(page, "settings-rules", "Searches and rules", "github", "1180px");
      const below = () =>
        page.evaluate<number>(`document.querySelector(".rules-wrap .editor-foot").getBoundingClientRect().bottom - innerHeight`);
      const foot = await below();
      if (foot > 0) failures.push(`settings-rules: the editor's foot ends ${Math.round(foot)}px below the window`);
      const sideways = await page.evaluate<number>(`(() => {
        const ed = document.querySelector(".rules-wrap .editor");
        return ed.scrollWidth - ed.clientWidth;
      })()`);
      if (sideways > 0) failures.push(`settings-rules: the editor's code scrolls ${sideways}px sideways`);
      await page.evaluate(`document.querySelector(".rules-wrap .editor").style.height = "calc(100vh + 400px)"`);
      const tall = await below();
      if (tall > 0) failures.push(`settings-rules: with the editor dragged taller, its foot ends ${Math.round(tall)}px below the window`);
      await page.evaluate(`document.querySelector(".rules-wrap .editor").style.height = ""`);
    },
  },
  {
    // A draft survives a trip to another part and back; Esc, once the editor's left, goes back to GitHub's part; #/rules
    // opens the view again with the draft still in it, which is what's shot.
    name: "settings-rules-keeps",
    go: async (page) => {
      const draft = "# a draft kept across the trip";
      const kept = () => page.evaluate<boolean>(`document.querySelector(".rules-wrap .editor").value.includes(${JSON.stringify(draft)})`);
      await at("#/settings/rules")(page);
      await page.evaluate(`(() => {
        const el = document.querySelector(".rules-wrap .editor");
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      })()`);
      await page.keyboard.type(`\n${draft}`);
      await at("#/settings/agent")(page);
      await at("#/settings/rules")(page);
      if (!(await kept())) failures.push("settings-rules-keeps: the draft is gone after a trip to Claude's part");
      await page.locator(".rules-wrap .editor").focus();
      await page.keyboard.press("Escape");
      if (await page.evaluate<boolean>(`location.hash !== "#/settings/rules"`))
        failures.push("settings-rules-keeps: Esc in the editor left the view, not the editor");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      const hash = await page.evaluate<string>("location.hash");
      if (hash !== "#/settings/github") failures.push(`settings-rules-keeps: Esc goes to ${hash}, not GitHub's part`);
      await at("#/rules")(page);
      await settingsView(page, "settings-rules-keeps", "Searches and rules", "github", "1180px");
      if (!(await kept())) failures.push("settings-rules-keeps: #/rules opens the view without the draft");
    },
    after: async (page) => {
      await page.getByRole("button", { name: "Revert" }).click();
      await at("#/")(page);
    },
  },
  {
    // A bucket that isn't one, under a comment long enough to wrap: Preview changes lists the error under a red head, and
    // clicking it selects its line, which is what's shot (the lines above it in view, however they wrap). Nothing is saved.
    name: "settings-rules-errors",
    go: async (page) => {
      await at("#/settings/rules")(page);
      const editor = page.locator(".rules-wrap .editor");
      const lines = (await editor.inputValue()).split("\n");
      const bad = lines.findIndex((l, i) => i > lines.length / 2 && l.startsWith("bucket = "));
      lines[bad] = 'bucket = "soon"';
      lines.splice(1, 0, `# ${"a comment long enough to wrap ".repeat(20)}`);
      await editor.fill(lines.join("\n"));
      // What's wrong is on screen, in the rail beside the editor or, the rail under it, the editor's foot: on preview and
      // with the line it picked.
      const said = () =>
        page.evaluate<boolean>(`[...document.querySelectorAll(".err-row, .foot-err")].some((el) => {
          const r = el.getBoundingClientRect();
          return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && el.textContent.includes('"soon" is not a bucket');
        })`);
      await page.getByRole("button", { name: "Preview changes" }).click();
      await page.locator(".err-row").first().waitFor();
      if (!(await said())) failures.push("settings-rules-errors: after Preview changes, no error is on screen");
      await page.locator(".err-row").first().click();
      if (!(await said())) failures.push("settings-rules-errors: with its line picked, the error isn't on screen");
      const seen = await page.evaluate<{ red: boolean; picked: string; hidden: number }>(`(() => {
        const ed = document.querySelector(".rules-wrap .editor");
        const head = getComputedStyle(document.querySelector(".errors .s-sub")).color;
        return {
          red: head === getComputedStyle(document.querySelector(".err-row code")).color,
          picked: ed.value.slice(ed.selectionStart, ed.selectionEnd),
          hidden: document.querySelector(".page-head").getBoundingClientRect().bottom - ed.getBoundingClientRect().top,
        };
      })()`);
      if (!seen.red) failures.push("settings-rules-errors: the errors' head isn't red");
      if (seen.picked !== 'bucket = "soon"') failures.push(`settings-rules-errors: the error selects ${JSON.stringify(seen.picked)}`);
      if (seen.hidden > 0) failures.push(`settings-rules-errors: the editor's top is ${Math.round(seen.hidden)}px under the page's head`);
    },
    after: async (page) => {
      await page.getByRole("button", { name: "Revert" }).click();
      await at("#/")(page);
    },
  },
  {
    // The mock's Claude Code has the tools but not the skill: one row says so, with the page's one filled button.
    name: "settings-agent",
    go: async (page) => {
      await at("#/settings/agent")(page);
      const rows = await statusRows(page, "agent");
      if (rows.join("|") !== "Claude Code isn't connected to the desk")
        failures.push(`settings-agent: Claude's status rows read ${JSON.stringify(rows)}`);
      const filled = await page.locator("#s-agent .s-status .act.primary", { hasText: "Connect Claude Code" }).isVisible();
      if (!filled) failures.push("settings-agent: no filled Connect Claude Code");
    },
  },
  {
    // Your agent off: letting it run without asking would do nothing, so that row isn't drawn; Run your agent is.
    name: "settings-agent-off",
    go: async (page) => {
      // Off as the desk would say it everywhere: the overview too, so no Ask your agent shows.
      await overviewAs((o) => {
        o.agent = false;
      })(page);
      await settingsAs((v) => {
        v.values["agent.coordinator"] = false;
      })(page);
      await at("#/settings/agent")(page);
      if (await page.locator(".side-ask").count()) failures.push("settings-agent-off: Ask your agent shows with your agent off");
      if (await page.locator('[id="row-agent.coordinator_bypass"]').count())
        failures.push("settings-agent-off: Let your agent run without asking is drawn while your agent is off");
      if (!(await page.locator('[id="row-agent.coordinator"]').isVisible())) failures.push("settings-agent-off: no Run your agent row");
    },
    after: unsettle,
  },
  {
    // Claude Code has the tools and the skill: nothing to say, so no status row and no Connect anywhere.
    name: "settings-agent-connected",
    go: async (page) => {
      await page.route("**/api/agents", async (route) => {
        const res = await route.fetch();
        const a = (await res.json()) as AgentStatus;
        Object.assign(a, { mcp: { ...a.mcp, connected: true }, skill: { ...a.skill, state: "installed" }, needs: null, connect: [] });
        await route.fulfill({ response: res, json: a });
      });
      await at("#/")(page); // Settings reads it again only when it's opened
      await at("#/settings/agent")(page);
      const rows = await statusRows(page, "agent");
      if (rows.length) failures.push(`settings-agent-connected: Claude's part still says ${JSON.stringify(rows)}`);
      if (await page.evaluate<boolean>(`document.querySelector(".settings").textContent.includes("Connect")`))
        failures.push("settings-agent-connected: Settings still offers Connect");
    },
    after: async (page) => {
      await unroute(page);
      await at("#/")(page);
    },
  },
  {
    // Your policy, a view of its own: the editor, the judge's status, then the hourly cap's row under it.
    name: "settings-policy",
    go: async (page) => {
      await at("#/settings/policy")(page);
      await settingsView(page, "settings-policy", "Your policy", "agent", "760px");
      await capUnderStatus(page, "settings-policy");
    },
  },
  {
    // Settings' Automations tab, on its own: a row each, its name, when it runs and its last run, Run now and its switch on the
    // sheet's right edge in line with the settings tab's; the agent's draft has a tinted Review instead and no switch; New
    // automation last.
    name: "settings-automations",
    go: async (page) => {
      await at("#/settings/queue")(page);
      const setting = await page.evaluate<number>(`document.querySelector('[id="setting-notify.enabled"]').getBoundingClientRect().right`);
      await at("#/settings/automations")(page);
      const tabs = await tabsSay(page);
      if (tabs !== "Settings [Automations]") failures.push(`settings-automations: the page head's tabs read ${JSON.stringify(tabs)}`);
      if (await page.locator("#s-github").isVisible()) failures.push("settings-automations: the settings tab's parts show on Automations");
      const [mine, draft, ...more] = await automationRows(page);
      if (
        !mine ||
        mine.name !== "Warden and dotagents issues" ||
        !/^Weekdays at 9:00 · next (\w{3} )?9:00 · ran \d+h ago, put 2 on your desk$/.test(mine.help) ||
        mine.red.length ||
        !mine.run ||
        mine.on !== true ||
        mine.review
      )
        failures.push(`settings-automations: the first row reads ${JSON.stringify(mine)}`);
      if (
        !draft ||
        draft.help !== "An agent wrote it; read it before it runs · Mon and Thu at 17:30" ||
        draft.run ||
        draft.on !== null ||
        draft.review !== "#/settings/automations/sdk-releases"
      )
        failures.push(`settings-automations: the agent's draft reads ${JSON.stringify(draft)}`);
      if (more.length) failures.push(`settings-automations: ${more.length} more rows than the mock's two`);
      const [tinted, wash] = await page.evaluate<string[]>(`(() => {
        const d = document.createElement("div");
        d.style.background = "var(--accent-wash)";
        document.body.append(d);
        const fills = [document.querySelector("#s-automations .s-cta"), d].map((e) => getComputedStyle(e).backgroundColor);
        d.remove();
        return fills;
      })()`);
      if (tinted !== wash) failures.push(`settings-automations: Review's fill is ${tinted}, not the accent's wash ${wash}`);
      const edge = await page.evaluate<number>(`document.querySelector("#s-automations .switch").getBoundingClientRect().right`);
      if (Math.abs(edge - setting) > 0.5)
        failures.push(`settings-automations: an automation's switch ends at ${edge}px, a setting's at ${setting}px`);
      const last = await page.evaluate<string | null>(
        `document.querySelector("#s-automations .s-sheet > :last-child")?.textContent ?? null`,
      );
      if (last !== "New automation") failures.push(`settings-automations: the sheet's last row reads ${JSON.stringify(last)}`);
    },
  },
  {
    // The last run failed: only those words are red; one of yours that's off says so, with its switch and no Run now.
    name: "settings-automations-failed",
    go: async (page) => {
      await automationsAs((v) => {
        const run = v[0]!.runs[0]!;
        run.error = "claude exited with 1: your login has expired\nRun claude and log in again.";
        run.items = [];
        Object.assign(v[1]!, { by: "you", on: false, next_at: null });
      })(page);
      await at("#/settings/automations")(page);
      const [failed, off] = await automationRows(page);
      if (
        !failed ||
        !/^failed \d+h ago: claude exited with 1: your login has expired$/.test(failed.red.join("|")) ||
        !failed.help.startsWith("Weekdays at 9:00 · next ")
      )
        failures.push(`settings-automations-failed: the failed run's row reads ${JSON.stringify(failed)}`);
      if (!off || off.help !== "Mon and Thu at 17:30 · off · hasn't run yet" || off.run || off.on !== false || off.review)
        failures.push(`settings-automations-failed: the one that's off reads ${JSON.stringify(off)}`);
    },
    after: unsettle,
  },
  {
    // None yet: one row says how to get one, and its New automation opens the editor under the sheet, the link gone while it's
    // open. Nothing's saved: Cancel closes it.
    name: "settings-automations-new",
    go: async (page) => {
      await automationsAs((v) => {
        v.length = 0;
      })(page);
      await at("#/settings/automations")(page);
      const none = await page.evaluate<string>(`document.querySelector("#s-automations .s-sheet").innerText.replaceAll(/\\n+/g, "\\n")`);
      if (none !== "None yet\nAsk an agent to write one, or write one yourself.\nNew automation")
        failures.push(`settings-automations-new: with none the part reads ${JSON.stringify(none)}`);
      await page.locator("#s-automations").getByRole("button", { name: "New automation" }).click();
      const seen = await page.evaluate<{ below: boolean; link: boolean; focus: string | null }>(`(() => {
        const sheet = document.querySelector("#s-automations .s-sheet"), form = document.querySelector("#s-automations .au-editor");
        return {
          below: !!form && form.getBoundingClientRect().top >= sheet.getBoundingClientRect().bottom,
          link: sheet.textContent.includes("New automation"),
          focus: document.activeElement?.placeholder ?? null,
        };
      })()`);
      if (!seen.below || seen.link || seen.focus !== "Warden and dotagents issues")
        failures.push(`settings-automations-new: the editor ${JSON.stringify(seen)}`);
      await page.evaluate(`document.querySelector("#s-automations .au-editor").scrollIntoView({ block: "end" })`);
    },
    after: async (page) => {
      const cancel = page.locator("#s-automations .au-editor").getByRole("button", { name: "Cancel" });
      if (await cancel.count()) await cancel.click();
      await unsettle(page);
    },
  },
  {
    // The agent's draft, opened by its Review: its instruction quoted, then a filled Turn on and Edit, with no Run now.
    name: "settings-automations-draft",
    go: async (page) => {
      const name = "SDK release blockers";
      await at("#/settings/automations")(page);
      await page.locator("#s-automations .s-cta").click();
      await page.waitForTimeout(300);
      const hash = await page.evaluate<string>("location.hash");
      if (hash !== "#/settings/automations/sdk-releases") failures.push(`settings-automations-draft: Review opens ${hash}`);
      await settingsView(page, "settings-automations-draft", name, "automations", "760px");
      const seen = await page.evaluate<{ line: string; prompt: string; filled: string[]; buttons: string[] }>(`(() => {
        const v = [...document.querySelectorAll(".s-view")].find((s) => !s.hidden);
        return {
          line: v.querySelector(".s-view-line").textContent,
          prompt: v.querySelector(".au-prompt")?.textContent ?? "",
          filled: [...v.querySelectorAll(".act.primary")].map((b) => b.textContent),
          buttons: [...v.querySelectorAll(".au-view .actions button")].map((b) => b.textContent),
        };
      })()`);
      if (seen.line !== "Mon and Thu at 17:30 · an agent wrote it: read it before you turn it on.")
        failures.push(`settings-automations-draft: the view's line reads ${JSON.stringify(seen.line)}`);
      if (!seen.prompt.startsWith("Check the open release-blocker issues"))
        failures.push(`settings-automations-draft: the instruction reads ${JSON.stringify(seen.prompt)}`);
      if (seen.filled.join() !== "Turn on" || seen.buttons.join() !== "Turn on,Edit")
        failures.push(`settings-automations-draft: its buttons are ${JSON.stringify(seen)}`);
    },
    after: at("#/"),
  },
  {
    // An automation's view, from its name: its instruction, what each run found and what came of each item, each run's
    // session a Copy resume command away (the command in its tooltip, not on the page); Esc goes back to Automations, and
    // an id that isn't one says so.
    name: "settings-automations-runs",
    go: async (page) => {
      const name = "Warden and dotagents issues";
      const open = async () => {
        await at("#/settings/automations")(page);
        await page.locator("#s-automations .s-name", { hasText: name }).click();
        await page.locator(".s-view .au-run").first().waitFor();
      };
      await open();
      const hash = await page.evaluate<string>("location.hash");
      if (hash !== "#/settings/automations/warden-issues") failures.push(`settings-automations-runs: its name opens ${hash}`);
      await settingsView(page, "settings-automations-runs", name, "automations", "760px");
      const seen = await page.evaluate<{ runs: number; tips: string[]; said: boolean }>(`(() => {
        const v = [...document.querySelectorAll(".s-view")].find((s) => !s.hidden);
        return {
          runs: v.querySelectorAll(".au-run").length,
          tips: [...v.querySelectorAll(".au-resume")].map((b) => b.title),
          said: document.querySelector(".main").innerText.includes("claude --resume"),
        };
      })()`);
      if (seen.runs !== 2) failures.push(`settings-automations-runs: ${seen.runs} runs in the view`);
      const tip = /^cd \S+\/\.review-desk\/automations && claude --resume [\da-f-]{36}$/;
      if (seen.tips.length !== 2 || !seen.tips.every((t) => tip.test(t)))
        failures.push(`settings-automations-runs: Copy resume command's tooltips read ${JSON.stringify(seen.tips)}`);
      if (seen.said) failures.push("settings-automations-runs: claude --resume is on the page, not only in a tooltip");
      // The clipboard stubbed, so a shot never touches yours.
      await page.evaluate(`navigator.clipboard.writeText = async (t) => { window.__copied = t; }`);
      await page.locator(".s-view .au-resume").first().click();
      const copied = await page.evaluate<unknown>("window.__copied");
      const toast = await page.locator(".toast").textContent();
      if (copied !== seen.tips[0] || toast !== "Copied")
        failures.push(`settings-automations-runs: Copy resume command copied ${JSON.stringify(copied)}, saying ${JSON.stringify(toast)}`);
      await page.reload(); // the toast's gone with it, and Settings opens on the view
      await page.locator(".s-view .au-run").first().waitFor();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      const back = await page.evaluate<string>("location.hash");
      if (back !== "#/settings/automations") failures.push(`settings-automations-runs: Esc goes to ${back}, not Automations`);
      await at("#/settings/automations/nope")(page);
      const none = await page.evaluate<{ line: string | null; href: string | null }>(`({
        line: [...document.querySelectorAll(".s-view")].find((s) => !s.hidden)?.textContent.trim() ?? null,
        href: document.querySelector(".page-head a.back")?.getAttribute("href") ?? null,
      })`);
      if (none.line !== "There’s no automation called “nope”." || none.href !== "#/settings/automations")
        failures.push(`settings-automations-runs: an unknown id shows ${JSON.stringify(none)}`);
      await open();
    },
    after: at("#/"),
  },
  {
    // Settings' tabs are links Tab reaches: Enter on Automations opens it, and the sidebar's Settings the settings tab. A new
    // automation half written survives a trip to the settings tab, and an edit in an automation's view one to Settings and
    // back; Esc on the Automations tab goes to the Inbox, as from any part. Shot on the settings tab, Automations focused.
    name: "settings-tabs",
    go: async (page) => {
      const hash = () => page.evaluate<string>("location.hash");
      const tab = (name: string) => page.locator(".page-head .head-tab", { hasText: name });
      await at("#/settings/github")(page);
      const links = await page.evaluate<string[]>(
        `[...document.querySelectorAll(".page-head .head-tabs a")].map((a) => a.getAttribute("href") + (a.tabIndex < 0 ? " (no Tab)" : ""))`,
      );
      if (links.join() !== "#/settings,#/settings/automations") failures.push(`settings-tabs: the tabs link to ${JSON.stringify(links)}`);
      await tab("Settings").focus();
      await page.keyboard.press("Tab");
      const focused = await page.evaluate<string | null>("document.activeElement?.textContent ?? null");
      if (focused !== "Automations") failures.push(`settings-tabs: Tab from the Settings tab goes to ${JSON.stringify(focused)}`);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);
      if ((await hash()) !== "#/settings/automations" || (await tabsSay(page)) !== "Settings [Automations]")
        failures.push(`settings-tabs: Enter on Automations goes to ${await hash()}, the tabs reading ${await tabsSay(page)}`);
      // A new one half written, then the settings tab and back.
      await page.locator("#s-automations").getByRole("button", { name: "New automation" }).click();
      await page.locator("#s-automations .au-editor input").first().fill("Half written");
      await tab("Settings").click();
      await page.waitForTimeout(300);
      if (await page.locator("#s-automations").isVisible()) failures.push("settings-tabs: Automations shows on the settings tab");
      await tab("Automations").click();
      await page.waitForTimeout(300);
      const kept = await page
        .locator("#s-automations .au-editor input")
        .first()
        .inputValue({ timeout: 2000 })
        .catch(() => null);
      if (kept !== "Half written") failures.push(`settings-tabs: back on Automations, the new one's name reads ${JSON.stringify(kept)}`);
      await page.locator("#s-automations .au-editor").getByRole("button", { name: "Cancel" }).click();
      // An edit in a view, then the sidebar's Settings, the Automations tab and its name again.
      const name = "Warden and dotagents issues";
      await page.locator("#s-automations .s-name", { hasText: name }).click();
      await page.locator(".s-view .au-view").getByRole("button", { name: "Edit" }).click();
      await page.locator(".s-view .au-editor input").first().fill("Warden, edited");
      await page.locator(".side-item", { hasText: "Settings" }).click();
      await page.waitForTimeout(400);
      if ((await hash()) !== "#/settings" || (await tabsSay(page)) !== "[Settings] Automations")
        failures.push(`settings-tabs: the sidebar's Settings goes to ${await hash()}, the tabs reading ${await tabsSay(page)}`);
      await tab("Automations").click();
      await page.locator("#s-automations .s-name", { hasText: name }).click();
      await page.waitForTimeout(300);
      const edited = await page
        .locator(".s-view .au-editor input")
        .first()
        .inputValue({ timeout: 2000 })
        .catch(() => null);
      if (edited !== "Warden, edited") failures.push(`settings-tabs: back in its view, the edit's name reads ${JSON.stringify(edited)}`);
      await page.locator(".s-view .au-editor").getByRole("button", { name: "Cancel" }).click();
      await at("#/settings/automations")(page);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      if ((await hash()) !== "#/") failures.push(`settings-tabs: Esc on the Automations tab goes to ${await hash()}, not the Inbox`);
      await at("#/settings")(page);
      await tab("Settings").focus();
      await page.keyboard.press("Tab");
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
      const help = await page.evaluate<string | null>(
        `[...document.querySelectorAll(".s-view-row")].find((r) => r.querySelector(".s-name")?.textContent === "Your policy")?.querySelector(".s-help")?.textContent ?? null`,
      );
      if (help !== "The starter policy, until you change it.")
        failures.push(`settings-policy-starter: Your policy's row says ${JSON.stringify(help)}`);
      await at("#/settings/policy")(page);
      await capUnderStatus(page, "settings-policy-starter");
    },
    after: async (page) => {
      await page.evaluate(`(async () => {
        const p = await (await fetch("/api/policy")).json();
        await fetch("/api/policy", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: window.__policy, base: p.hash }) });
      })()`);
    },
  },
  {
    // On Settings the sidebar marks Settings, none of the pages, and the page head names it; in a browser This device is the
    // theme alone (the mac size has the app's bridge: settings-app-desktop).
    name: "settings-app",
    go: async (page) => {
      await at("#/settings/app")(page);
      const rows = await page.evaluate<string[]>(
        `[...document.querySelectorAll("#s-app .setting")].map((r) => r.id || r.querySelector(".input")?.id)`,
      );
      if (!(await page.evaluate<boolean>("!!window.desktop")) && rows.join() !== "s-theme")
        failures.push(`settings-app: This device in a browser has ${JSON.stringify(rows)}, not the theme alone`);
      const on = await sideOn(page);
      if (on !== "Settings") failures.push(`settings-app: the sidebar marks ${JSON.stringify(on)}`);
      const tabs = await tabsSay(page);
      if (tabs !== "[Settings] Automations") failures.push(`settings-app: the page head's tabs read ${JSON.stringify(tabs)}`);
      if (await page.locator(".page-head a.back").count()) failures.push("settings-app: the page head is a way back");
      if (await page.locator("#s-automations").isVisible()) failures.push("settings-app: Automations shows on the settings tab");
      const col = await page.evaluate<string>(`getComputedStyle(document.querySelector(".main")).maxWidth`);
      if (col !== "760px") failures.push(`settings-app: the column is ${col}, not 760px`);
    },
  },
  {
    // The macOS app: This device has its rows after the theme, and the shortcut's line comes from the app's status().
    name: "settings-app-desktop",
    sizes: ["mac"],
    go: async (page) => {
      await at("#/settings/app")(page);
      // Back on the part Settings last showed, App's scroll to the top wins over Settings' to the part; settings-aliases checks landing.
      await page.evaluate(`document.getElementById("s-app").scrollIntoView({ block: "start" })`);
      const missing = await page.evaluate<string[]>(
        `["app.hotkey", "app.open_at_login", "app.menu_bar_count", "app.source"].filter((k) => !document.getElementById("row-" + k)?.getClientRects().length)`,
      );
      if (missing.length) failures.push(`settings-app-desktop: no ${missing.join(", ")} row`);
      const says = await hotkeySays(page, "Works from any app.");
      if (says !== "Works from any app.") failures.push(`settings-app-desktop: the shortcut's line reads ${JSON.stringify(says)}`);
      const row = page.locator('[id="row-app.hotkey"]');
      const tip = await row.getByRole("button", { name: "Record a shortcut" }).getAttribute("title");
      if (tip !== "Press ⌃, ⌥ or ⌘ with a key; Esc cancels")
        failures.push(`settings-app-desktop: Record's tooltip reads ${JSON.stringify(tip)}`);
      if (!(await row.getByRole("button", { name: "Turn off" }).isVisible())) failures.push("settings-app-desktop: no Turn off");
      // Recording names no key on the page (Record's tooltip does), and Esc in the field cancels it without saving.
      await row.getByRole("button", { name: "Record a shortcut" }).click();
      const text = await row.textContent();
      if (!(await row.locator('[aria-pressed="true"]').count()) || /Esc|Backspace|⌃/.test(text ?? ""))
        failures.push(`settings-app-desktop: recording reads ${JSON.stringify(text)}`);
      await page.keyboard.press("Escape");
      if (await row.locator('[aria-pressed="true"]').count()) failures.push("settings-app-desktop: Esc doesn't cancel the recording");
      if ((await deskHas(page, "app.hotkey")) !== "Control+Alt+D") failures.push("settings-app-desktop: recording changed the shortcut");
      await page.locator('[id="setting-app.hotkey"]').blur();
    },
  },
  {
    // Another app has the shortcut: the app's status() says so, and the line under the label is that, in red.
    name: "settings-app-desktop-taken",
    sizes: ["mac"],
    go: async (page) => {
      await page.evaluate(
        `window.__deskStatus = { hotkey: { accelerator: "Control+Alt+D", ok: false, error: "another app has this shortcut" }, open_at_login: false, source: null }`,
      );
      await at("#/settings/queue")(page); // the app is asked again when Settings reads the desk's settings again
      await at("#/settings/app")(page);
      await page.evaluate(`document.getElementById("s-app").scrollIntoView({ block: "start" })`);
      const says = await hotkeySays(page, "Couldn't use Control+Alt+D: another app has this shortcut.");
      const red = await page.evaluate<boolean>(`!!document.querySelector('[id="row-app.hotkey"] .s-help.t-bad')`);
      if (says !== "Couldn't use Control+Alt+D: another app has this shortcut." || !red)
        failures.push(`settings-app-desktop-taken: the shortcut's line reads ${JSON.stringify(says)}${red ? "" : ", not in red"}`);
    },
    after: async (page) => {
      await page.evaluate("delete window.__deskStatus");
      await at("#/")(page);
    },
  },
  {
    // The old sections' links land on the part their settings live in now; the last, GitHub's, is what's shot.
    name: "settings-aliases",
    go: async (page) => {
      for (const [old, part] of [
        ["notify", "queue"],
        ["appearance", "app"],
        ["review", "github"],
        ["handoff", "github"],
      ]) {
        await at(`#/settings/${old}`)(page);
        const seen = await page.evaluate<boolean>(`(() => {
          const h = document.querySelector("#s-${part} > .group-head")?.getBoundingClientRect();
          return !!h && h.top >= 52 && h.bottom <= innerHeight && (${JSON.stringify(part)} !== "github" || scrollY === 0);
        })()`);
        if (!seen) failures.push(`settings-aliases: #/settings/${old} doesn't land on ${part}`);
      }
    },
  },
  {
    // Settings is one page: its end, with More closed.
    name: "settings-bottom",
    go: async (page) => {
      await at("#/settings/app")(page);
      await toBottom("settings-bottom")(page);
    },
  },
  {
    // Paused after failures in a row: one status row in Claude's part, in ink, not red, said once on the page.
    name: "settings-agent-paused",
    writes: true,
    go: async (page) => {
      await at("#/")(page);
      await pauseAi(true)(page);
      await at("#/settings/agent")(page);
      const said = await page.evaluate<number>(
        `[...document.querySelectorAll(".settings *")].filter((el) => !el.children.length && el.textContent.includes("AI reviews are paused")).length`,
      );
      if (said !== 1) failures.push(`settings-agent-paused: Settings says AI reviews are paused ${said} times`);
      const rows = await statusRows(page, "agent");
      if (rows.filter((r) => r === "AI reviews are paused").length !== 1)
        failures.push(`settings-agent-paused: Claude's status rows read ${JSON.stringify(rows)}`);
      const ink = await page.evaluate<boolean>(`(() => {
        const row = [...document.querySelectorAll("#s-agent .s-status")].find((r) => r.querySelector(".s-label")?.textContent === "AI reviews are paused");
        const help = row && getComputedStyle(row.querySelector(".s-help")).color;
        return !!help && help === getComputedStyle(row.querySelector(".s-label")).color;
      })()`);
      if (!ink) failures.push("settings-agent-paused: the pause's words aren't in ink");
    },
    after: pauseAi(false),
  },
  {
    // Snoozed or muted, under Later, with until when: its heading opens it.
    name: "cleared",
    go: async (page) => {
      await at("#/later")(page);
      await page.locator(".g-cleared .group-toggle").click();
      await page.waitForTimeout(300);
      await page.locator(".g-cleared").scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
    },
  },
  // The More menu in a review.
  {
    // Done first, then what isn't a write, then the writes under "On GitHub".
    name: "more-review",
    go: async (page) => {
      await review("acme/worker#875", [MORE])(page);
      const back = (await page.locator(".page-head .back").textContent())?.trim();
      if (back !== "Inbox") failures.push(`more-review: the review's way back reads ${JSON.stringify(back)}`);
      const items = await moreItems(page);
      const head = items.indexOf("#On GitHub");
      if (items[0] !== "Done" || head < 1 || head === items.length - 1 || items[head - 1] !== "Open on GitHub")
        failures.push(`more-review: the More menu reads ${JSON.stringify(items)}`);
    },
  },
  {
    // A PR that's done: More puts it back, as its row's menu does.
    name: "more-review-done",
    go: async (page) => {
      await at("#/")(page);
      await reviewAs((v) => {
        v.card.status = "done";
      })(page);
      await review("acme/api#4127", [MORE])(page);
      await page.locator(".more-pop").waitFor();
      const items = await moreItems(page);
      if (items[0] !== "Back on the desk" || items.includes("Done"))
        failures.push(`more-review-done: the More menu reads ${JSON.stringify(items)}`);
    },
    after: async (page) => {
      await page.keyboard.press("Escape");
      await unroute(page);
      await fresh(page);
    },
  },
  {
    // Request changes on someone else's PR: what you write, sent twice.
    name: "review-request-changes",
    go: async (page) => {
      await review("acme/api#4127", [MORE, '.more-pop .pop-item:has-text("Request changes")'])(page);
      await page.keyboard.type("The retry loop never gives up: cap it, and add a test for the cap.");
      await page.waitForTimeout(200);
    },
  },
  {
    // The sidebar after use: FYI opened from it, then a Settings page. Only the page you're on gets the pill.
    name: "sidebar-used",
    go: async (page) => {
      await at("#/")(page);
      const side = await sidePages(page);
      if (side !== "Inbox Blocked FYI | Merging Archive") failures.push(`sidebar-used: the sidebar reads ${side}`);
      await page.locator(".side-item", { hasText: "FYI" }).click();
      await at("#/settings/notify")(page);
    },
  },
  // Each theme picked on this device, over the system's light or dark: the queue, a row selected, a review, the chat, Merging
  // and Settings. `--only theme-<id>` shoots one theme's.
  ...THEMES.map((t) => t.id).flatMap((id): Shot[] => [
    {
      name: `theme-${id}`,
      go: async (page) => {
        await pickTheme(id)(page);
        await page.locator(".queue [data-id]").nth(1).locator(".row-main").focus();
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
      name: `theme-${id}-ask`,
      go: async (page) => {
        await pickTheme(id)(page);
        await review("me/notes-app#12")(page);
        await page.locator(".side-ask").click();
        await page.locator(".chat .prose").first().waitFor();
        await page.waitForTimeout(200);
      },
      after: systemTheme,
    },
    {
      name: `theme-${id}-inflight`,
      go: async (page) => {
        await pickTheme(id)(page);
        await at("#/inflight")(page);
        await page.locator(".lane [data-id]").nth(1).locator(".row-main").focus();
      },
      after: systemTheme,
    },
    // Settings' controls in the theme's colours: from GitHub's select on, a switch on and one off, the filled Connect and the
    // Inbox's numbers.
    {
      name: `theme-${id}-settings`,
      go: async (page) => {
        await settingsAs((v) => {
          v.values["agent.coordinator_bypass"] = false;
        })(page);
        await pickTheme(id)(page);
        await at("#/settings/github")(page);
        await page.locator("#s-agent .s-status .act.primary").waitFor();
        await page.evaluate(
          `scrollTo(0, document.getElementById("row-github.resolve_on_others_approval").getBoundingClientRect().top + scrollY - 64)`,
        );
        const seen = await page.evaluate<{ off: boolean; select: boolean; number: boolean }>(`(() => {
          const shown = (el) => { const r = el?.getBoundingClientRect(); return !!r && r.top >= 52 && r.bottom <= innerHeight; };
          return {
            off: [...document.querySelectorAll(".settings .switch")].some((s) => !s.checked && shown(s)),
            select: [...document.querySelectorAll(".settings select")].some(shown),
            number: [...document.querySelectorAll(".settings .input.num")].some(shown),
          };
        })()`);
        if (!seen.off || !seen.select || !seen.number) failures.push(`theme-${id}-settings: on screen ${JSON.stringify(seen)}`);
      },
      after: async (page) => {
        await systemTheme(page);
        await unsettle(page);
      },
      sizes: ["wide"],
    },
  ]),
  // Omarchy as this device's theme, with one the desk hasn't got: the queue and a review in Hackerman's colours, the queue
  // in Lupine's, and This device offering Omarchy with the theme it has on.
  {
    name: "theme-omarchy",
    go: async (page) => {
      await omarchyAs(HACKERMAN)(page);
      await page.locator(".queue [data-id]").nth(1).locator(".row-main").focus();
    },
    after: leaveOmarchy,
  },
  {
    name: "theme-omarchy-review",
    go: async (page) => {
      await omarchyAs(HACKERMAN)(page);
      await review("acme/api#4127")(page);
    },
    after: leaveOmarchy,
  },
  {
    // Omarchy switching while the window's open, as the event stream hands the window a switch: to Nord, which is the
    // desk's own, then to Lupine.
    name: "theme-omarchy-light",
    go: async (page) => {
      await omarchyAs(HACKERMAN)(page);
      const switchTo = (o: OmarchyTheme) =>
        page.evaluate<[string?, string?]>(`(async () => {
          (await import("/src/theme.ts")).omarchyIs(${JSON.stringify(o)});
          return [document.documentElement.dataset.theme, document.documentElement.style.getPropertyValue("--sheet")];
        })()`);
      const nord = await switchTo({ name: "nord", scheme: "dark", theme: "nord", tokens: null });
      if (nord[0] !== "nord" || nord[1]) failures.push(`theme-omarchy-light: a switch to Nord shows ${JSON.stringify(nord)}`);
      const lupine = await switchTo(LUPINE);
      if (lupine[0] !== "omarchy" || lupine[1] !== LUPINE.tokens?.["--sheet"])
        failures.push(`theme-omarchy-light: a switch to Lupine shows ${JSON.stringify(lupine)}`);
      await page.locator(".queue [data-id]").nth(1).locator(".row-main").focus();
    },
    after: leaveOmarchy,
  },
  {
    name: "theme-omarchy-settings",
    go: async (page) => {
      await omarchyAs(HACKERMAN)(page);
      await at("#/settings/app")(page);
      const row = await page.evaluate<[string, string]>(
        `[document.getElementById("s-theme").value, document.querySelector("#s-app .setting .s-help").textContent]`,
      );
      if (row[0] !== "omarchy" || !row[1].includes("(now Hackerman)"))
        failures.push(`theme-omarchy-settings: the row reads ${JSON.stringify(row)}`);
    },
    after: leaveOmarchy,
    sizes: ["wide"],
  },
  // The More menu open in a review.
  { name: "more-menu", go: review("acme/worker#875", [MORE]) },
  // Right-click a row: its actions at the pointer, Snooze open to the side with what this PR can wait on.
  {
    name: "row-menu",
    go: async (page) => {
      await at("#/")(page);
      await page.locator(".line", { hasText: "Drop the legacy v1 auth" }).locator(".row-main").click({ button: "right" });
      await page.locator(".ctx-has-sub").hover();
      await page.locator(".ctx-sub").waitFor();
      await page.waitForTimeout(200);
      if (!(await page.locator(".ctx-item", { hasText: "Why it's here" }).count())) failures.push("row-menu: no Why it's here");
    },
    after: async (page) => {
      await page.keyboard.press("Escape");
    },
  },
  {
    // Done in a row's menu: the row leaves and takes its fill with it; no neighbour is filled in its place. Held, so the mock
    // keeps the row for the next size's shots.
    name: "row-done-unselected",
    go: async (page) => {
      await page.route("**/api/act", async (route) => {
        if ((route.request().postDataJSON() as { action?: string }).action !== "done") await route.continue();
      });
      await at("#/")(page);
      await rowMenuPick(page, ".queue .line:not(.inq) >> nth=1", "Done");
      await page.waitForTimeout(400);
      if (await page.locator(".line.sel").count()) failures.push("row-done-unselected: a row is filled after the one you finished left");
    },
    // The reload drops the held write first: unrouting while it's held would let it through to the mock.
    after: async (page) => {
      await fresh(page);
      await unroute(page);
    },
  },
  {
    // The letters that were shortcuts do nothing now: no menu, toast, chat or page change, and the row keeps the focus.
    name: "no-keys",
    go: async (page) => {
      await fresh(page);
      await page.locator(".toast").waitFor({ state: "detached" });
      await top(page);
      const row = page.locator(".queue .line:not(.inq)").first();
      await row.locator(".row-main").focus();
      const id = await row.getAttribute("data-id");
      let tabs = 0;
      const opened = () => {
        tabs++;
      };
      page.context().on("page", opened);
      for (const k of ["j", "k", "e", "d", "s", "m", "p", "a", ".", "u", "r", "/", "?", "g", "l", "t", "w", "i", "o"]) {
        await page.keyboard.press(k);
        await page.waitForTimeout(100);
      }
      page.context().off("page", opened);
      const open = await page.locator(".toast, .ctx, .more-pop, .popover, .chat, .dialog").count();
      const hash = await page.evaluate<string>("location.hash");
      const focused = await page.evaluate<string | null>(`document.activeElement?.closest(".line")?.dataset.id ?? null`);
      if (open || hash !== "#/" || focused !== id || tabs)
        failures.push(`no-keys: after the old shortcuts, ${JSON.stringify({ open, hash, focused, tabs })}`);
    },
  },
  // Approve at once: the review stays, its Approve now what you did, in the Archive, a spinner while GitHub (here never)
  // answers. Last: its toast would sit over the next shot.
  {
    name: "review-approve",
    go: async (page) => {
      await page.route("**/approve", () => {});
      await review("acme/api#4127", ['.rv-actions button:has-text("Approve")'])(page);
      await page.waitForTimeout(400); // past its row's fade and fold beside it
      // Its toast centres on the page's column, beside the list as without it.
      const off = await page.evaluate<number | null>(`(() => {
        const t = document.querySelector(".toast")?.getBoundingClientRect(), c = document.querySelector(".col")?.getBoundingClientRect();
        return t && c ? Math.round(Math.abs(t.left + t.width / 2 - (c.left + c.width / 2))) : null;
      })()`);
      if (off === null || off > 2) failures.push(`review-approve: the toast is ${off}px off the middle of the page's column`);
    },
  },
];
const SIZES: { name: string; width: number; height: number; mac: boolean; asked?: true }[] = [
  { name: "wide", width: 1280, height: 820, mac: false },
  { name: "mid", width: 900, height: 700, mac: false },
  { name: "min", width: 780, height: 600, mac: false },
  // What the owner sees: the desktop app on macOS, which pads for the traffic lights.
  { name: "mac", width: 1280, height: 820, mac: true },
  // A big window: the list beside a review with room, the queue and Settings; only for the shots that ask for it.
  { name: "xl", width: 1440, height: 900, mac: false, asked: true },
];

// The icons shot: every icon and the window's Mark at real size on both sidebars, at 100 % and 2x, to judge the small ones.
const ICON_PX = [16, 20, 24, 32, 64];
async function iconSheets(browser: Browser, url: string): Promise<string[]> {
  const data = (file: string, type = "image/png") => `data:${type};base64,${fs.readFileSync(path.join(root, file)).toString("base64")}`;
  const sheets: string[] = [];
  for (const scale of [1, 2]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: scale });
    // The @2x file at 2x where there is one, as Electron picks.
    const asset = (name: string) => {
      const x2 = `assets/${name.replace(".png", "@2x.png")}`;
      return data(scale === 2 && fs.existsSync(path.join(root, x2)) ? x2 : `assets/${name}`);
    };
    const sides: string[] = [];
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`${url}/#/`);
      const brand = page.locator(".side-brand");
      await brand.waitFor({ timeout: 15_000 });
      // The sidebar's colours and the Mark as the window draws them.
      const s = await page.evaluate<{ side: string; pencil: string; color: string; mark: string; w: number; h: number }>(`(() => {
        const css = getComputedStyle(document.documentElement), mark = document.querySelector(".side-brand .mark");
        const r = document.querySelector(".side-brand").getBoundingClientRect();
        return { side: css.getPropertyValue("--side"), pencil: css.getPropertyValue("--pencil"), color: getComputedStyle(mark).color, mark: mark.outerHTML, w: r.width, h: r.height };
      })()`);
      const row = (label: string, cells: string[]) =>
        `<div class="row"><div class="label">${label}</div><div class="cells">${cells.join("")}</div></div>`;
      const cell = (px: number | string, img: string) => `<figure>${img}<figcaption>${px}</figcaption></figure>`;
      const marks = ICON_PX.map((px) =>
        cell(px, `<span class="mk" style="width:${px}px;height:${px}px;color:${s.color}">${s.mark}</span>`),
      );
      const tiles = (src: string) => ICON_PX.map((px) => cell(px, `<img src="${src}" width="${px}" height="${px}">`));
      // macOS draws a template image in the menu bar's text colour: black on a light bar, white on a dark one.
      const template = `<img src="${asset("trayTemplate.png")}" width="22" height="16"${scheme === "dark" ? ' style="filter:invert(1)"' : ""}>`;
      const row16 = (name: string) => `<img src="${asset(name)}" width="16" height="16">`;
      const named = `<img src="data:image/png;base64,${(await brand.screenshot()).toString("base64")}" width="${s.w}" height="${s.h}">`;
      sides.push(
        `<section style="background:${s.side};color:${s.pencil}"><h2>${scheme === "light" ? "Light" : "Dark"} sidebar</h2>` +
          row("Mark, in the window", marks) +
          row("Beside the name", [named]) +
          row("App icon", tiles(data("assets/icon.png"))) +
          row("Favicon", tiles(data("web/public/icon.svg", "image/svg+xml"))) +
          row("Menu bar", [cell("22×16", template), cell("with a count", `<span class="bar">${template}3</span>`)]) +
          row("Tray, Windows and Linux", [
            cell("tray", row16("tray.png")),
            cell("alert", row16("tray-alert.png")),
            cell("badge", row16("overlay-alert.png")),
          ]) +
          `</section>`,
      );
    }
    await page.setViewportSize({ width: 900, height: 400 });
    await page.setContent(
      `<!doctype html><meta charset="utf-8"><style>
        body{margin:0;display:grid;grid-template-columns:1fr 1fr;font:12px system-ui}
        section{padding:16px 20px} h2{margin:0 0 12px;font-size:13px;font-weight:600}
        .row{display:grid;grid-template-columns:150px 1fr;align-items:end;padding:10px 0}
        .cells{display:flex;align-items:end;gap:18px} figure{margin:0;display:grid;justify-items:center;gap:4px}
        .mk{display:block}.mk svg{display:block;width:100%;height:100%;fill:currentColor}
        img{display:block}.bar{display:flex;align-items:center;gap:4px;font:14px system-ui}
      </style>${sides.join("")}`,
    );
    const file = `icons-${scale}x.png`;
    await page.screenshot({ path: path.join(out, file), fullPage: true });
    sheets.push(file);
    await page.close();
  }
  return sheets;
}

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
      // The macOS app's bridge (electron/preload.cjs) with only status() faked: App takes the shell's markers from it, and
      // Settings → This device draws the app's rows. No theme, so the theme stays in localStorage as in a browser.
      if (size.mac) {
        await page.addInitScript(
          `window.desktop = { platform: "darwin", version: "0.0.0", status: async () => window.__deskStatus ?? { hotkey: { accelerator: "Control+Alt+D", ok: true }, open_at_login: false, source: null } };`,
        );
        // The window's traffic lights as the app places them (electron/main.ts: 18,19), drawn only, so the shots show the row
        // the owner sees beside the mark.
        await page.addInitScript(`document.addEventListener("DOMContentLoaded", () => {
          const lights = document.createElement("div");
          lights.setAttribute("aria-hidden", "true");
          lights.style.cssText = "position:fixed;left:18px;top:19px;z-index:2147483647;display:flex;gap:8px;pointer-events:none";
          for (const c of ["#ff5f57", "#febc2e", "#28c840"]) {
            const d = document.createElement("span");
            d.style.cssText = "width:12px;height:12px;border-radius:50%;box-shadow:inset 0 0 0 0.5px rgb(0 0 0 / 18%);background:" + c;
            lights.append(d);
          }
          document.documentElement.append(lights);
        });`);
      }
      page.on("console", (m) => {
        if (m.type() === "error") failures.push(`${theme}/${size.name}: console error: ${m.text()}`);
      });
      await page.goto(`${url}/#/`);
      await page.locator(READY).first().waitFor({ timeout: 15_000 });
      for (const shot of shots) {
        if (shot.sizes ? !shot.sizes.includes(size.name) : size.asked) continue;
        await page.keyboard.press("Escape");
        await shot.go(page);
        await page.mouse.move(0, 0); // no hover state left over from a click
        const file = `${theme}-${size.name}-${shot.name}.png`;
        await page.screenshot({ path: path.join(out, file) });
        files.push(file);
        const sideways = await page.evaluate<number>("document.documentElement.scrollWidth - innerWidth");
        if (sideways > 0) failures.push(`${file}: the page scrolls sideways by ${sideways}px`);
        // The window names no key: a button's tooltip names its own.
        const chips = await page.evaluate<number>(`[...document.querySelectorAll("kbd")].filter((k) => k.getClientRects().length).length`);
        if (chips) failures.push(`${file}: ${chips} key chip(s) on screen`);
        // The sidebar's words fit it (in a row, at 640px and below, it scrolls sideways inside itself instead), and so does the head.
        const spill = await page.evaluate<number>(`(() => {
          const side = document.querySelector(".side"), head = document.querySelector(".page-head");
          const over = (el) => (el ? el.scrollWidth - el.clientWidth : 0);
          const row = !side || getComputedStyle(side).flexDirection === "row";
          const items = row ? [] : [side, ...side.querySelectorAll(".side-item, .side-name")];
          return Math.max(over(head), ...items.map(over));
        })()`);
        if (spill > 0) failures.push(`${file}: the sidebar or the page head runs ${spill}px past its edge`);
        // A table cuts a repo to 6 letters' room and a why to 10 at most: who it's from goes first (styles.css @container). A
        // row beside a review cuts its last fact to 8, its dot included.
        const squeezed = await page.evaluate<string[]>(`(() => {
          const out = [];
          const table = ".lines .line:not(.c-line, .lane-row, .blocked-row) ";
          for (const [sel, n] of [[table + ".line-ref", 6], [table + ".line-note", 10], [".c-line .c-meta > :last-child", 8]])
            for (const el of document.querySelectorAll(sel)) {
              if (!el.getClientRects().length || el.scrollWidth <= el.clientWidth + 1) continue;
              const room = document.createElement("span"), cs = getComputedStyle(el);
              room.style.cssText = "position:absolute;visibility:hidden;width:" + n + "ch";
              for (const k of ["fontFamily", "fontSize", "fontWeight", "fontVariantNumeric"]) room.style[k] = cs[k];
              document.body.append(room);
              if (el.getBoundingClientRect().width < room.getBoundingClientRect().width - 1) out.push(el.textContent);
              room.remove();
            }
          return out;
        })()`);
        if (squeezed.length) failures.push(`${file}: a table cuts ${squeezed.map((t) => JSON.stringify(t)).join(", ")} to a few letters`);
        const wraps = await page.evaluate<boolean>(`(() => {
          const words = document.querySelector(".side-brand span"), r = document.createRange();
          if (!words?.getClientRects().length) return false;
          r.selectNodeContents(words);
          return r.getClientRects().length > 1;
        })()`);
        if (wraps) failures.push(`${file}: the sidebar's "Review Desk" wraps`);
        // The macOS app's traffic lights (electron/main.ts: at 18,19) sit over no control.
        if (size.mac) {
          const under = await page.evaluate<string[]>(`[...document.querySelectorAll("a, button, input, select, textarea")]
            .filter((el) => { const r = el.getBoundingClientRect(); return r.width && r.left < 80 && r.right > 12 && r.top < 38 && r.bottom > 12; })
            .map((el) => el.textContent.trim() || el.className)`);
          if (under.length) failures.push(`${file}: the traffic lights sit over ${under.join(", ")}`);
        }
        await shot.after?.(page);
      }
      await page.close();
    }
  }
  if (!only || only.some((o) => "icons".includes(o))) files.push(...(await iconSheets(browser, url)));
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
