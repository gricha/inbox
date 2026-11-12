// npm run shots [-- --url http://localhost:47823] [--out .shots] [--only queue,review]: visual QA.
// Screenshots every key state in light and dark at its window sizes (SIZES, and a browser at 200 % zoom), and each theme,
// and fails on sideways scrolling and console errors. docs/visual.md → Checking a design change says what to look at.
// Without --url it starts the mock API and Vite, so the data is the same on every run.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page, type Request as Sent, type Route } from "playwright-core";
import { colorsOf, tokensFrom } from "../src/omarchy.ts";
import { isTestPath } from "../src/sections.ts";
import { THEMES } from "../src/themes.ts";
import type {
  AgentStatus,
  Ask,
  AskLines,
  AsksView,
  AutomationView,
  FirstPass,
  InflightView,
  OmarchyTheme,
  Overview,
  UpdateView,
  QueueView,
  ReviewHunk,
  ReviewOrder,
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

// GitHub never answers a shot: a person's picture is a pattern made from their login, and NO_AVATAR's fails, to show the
// name standing alone.
const NO_AVATAR = "kofi";
// No picture is a broken box, and each one in sight (not clipped or under the chat) has loaded.
const AVATARS_DRAWN = `[...document.querySelectorAll("img.avatar")].every((i) => {
  if (i.complete) return i.naturalWidth > 0;
  const r = i.getBoundingClientRect();
  return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) !== i;
})`;
// Each person named in `sel` on screen has their picture before the name, but NO_AVATAR, whose name stands alone.
async function faces(page: Page, name: string, sel: string): Promise<void> {
  await page.waitForFunction(AVATARS_DRAWN, undefined, { timeout: 3000 }).catch(() => null);
  const seen = await page.evaluate<{ names: number; bare: string[]; wrong: string[] }>(`(() => {
    const out = { names: 0, bare: [], wrong: [] };
    for (const el of document.querySelectorAll(${JSON.stringify(sel)})) {
      const r = el.getBoundingClientRect();
      if (!r.width || r.bottom < 0 || r.top > innerHeight) continue;
      const who = el.textContent.trim().replace(/^by /, "");
      if (who === "you" || who.startsWith("@") || who.endsWith("[bot]")) continue;
      out.names++;
      const img = el.querySelector("img.avatar");
      if (who === ${JSON.stringify(NO_AVATAR)} ? img : !img) (img ? out.wrong : out.bare).push(who);
    }
    return out;
  })()`);
  if (!seen.names) failures.push(`${name}: no person's name on screen in ${sel}`);
  if (seen.bare.length) failures.push(`${name}: ${seen.bare.join(", ")} without a picture in ${sel}`);
  if (seen.wrong.length) failures.push(`${name}: ${NO_AVATAR}'s picture that failed still takes room in ${sel}`);
}
async function offline(page: Page): Promise<void> {
  // On the context, so a shot's page.unrouteAll() never lets one through.
  await page.context().route(/^https:\/\/([^/]+\.)?github(usercontent)?\.com\//, (route) => {
    const url = new URL(route.request().url());
    const login = decodeURIComponent(url.pathname.slice(1));
    if (url.host !== "avatars.githubusercontent.com" || login === NO_AVATAR) {
      if (url.host !== "avatars.githubusercontent.com") failures.push(`a shot fetched ${url.href}`);
      return route.fulfill({ status: 404 });
    }
    let h = 0;
    for (const ch of login) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
    const cells: string[] = [];
    for (let i = 0; i < 15; i++)
      if ((h >> i) & 1)
        for (const x of new Set([i % 3, 4 - (i % 3)])) cells.push(`<rect x="${x}" y="${Math.floor(i / 3)}" width="1" height="1"/>`);
    const body = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 7 7"><rect x="-1" y="-1" width="7" height="7" fill="#f0f0f0"/><g fill="hsl(${h % 360} 45% 55%)">${cells.join("")}</g></svg>`;
    return route.fulfill({ contentType: "image/svg+xml", body });
  });
}

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

// The queue has loaded: its rows, its one empty line, or a new desk's first minutes.
const READY = ".queue .line, .queue .queue-empty, .queue .queue-first";

interface Shot {
  name: string;
  go: (page: Page) => Promise<void>;
  after?: (page: Page) => Promise<void>; // puts back what `go` changed in the mock
  writes?: true; // changes the desk's settings or state: only against the mock, never a real desk at --url
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
  await page.locator(".bubble", { hasText: "is paused" }).waitFor({ state: paused ? "visible" : "detached", timeout: 5000 });
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
// A Settings view: the head is its way back to Settings' part `part`, named so, the view names itself, and the column is
// `col` at most.
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
  const to = ({ github: "GitHub", agent: "Agent", automations: "Your automations" } as Record<string, string>)[part] ?? part;
  if (seen.back !== to) failures.push(`${name}: the page head's way back reads ${JSON.stringify(seen.back)}, not ${to}`);
  if (seen.href !== `#/settings/${part}`) failures.push(`${name}: the way back goes to ${seen.href}, not #/settings/${part}`);
  if (seen.h1 !== title) failures.push(`${name}: the view's name reads ${JSON.stringify(seen.h1)}`);
  if (seen.col !== col) failures.push(`${name}: the column is ${seen.col}, not ${col}`);
  if (await page.locator(".s-page:visible").count()) failures.push(`${name}: a Settings part shows beside the view`);
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
// A newer Inbox, as a packaged app's desk says it; its release page only, unless a shot says the app installs it.
const NEWER: UpdateView = {
  current: "0.1.0",
  latest: "0.2.0",
  url: "https://github.com/gricha/inbox/releases/tag/v0.2.0",
  available: true,
  install: false,
  installing: false,
  error: null,
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
// Its last run `minutes` before the page reads it, not before the mock started: a whole round of shots outlasts an hour.
const ranAgo = (id: string, minutes: number) => (v: AutomationView[]) => {
  const runs = v.find((a) => a.id === id)!.runs;
  const by = Date.now() - minutes * 60_000 - Date.parse(runs[0]!.at);
  for (const r of runs)
    Object.assign(r, {
      at: new Date(Date.parse(r.at) + by).toISOString(),
      done_at: r.done_at && new Date(Date.parse(r.done_at) + by).toISOString(),
    });
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
// An automation's view, read off the page: its line, its instruction, its facts as "label: words", its buttons, each run's
// head and what came of each item of the latest.
const automationFacts = (page: Page) =>
  page.evaluate<{ line: string; prompt: string | null; facts: string[]; buttons: string; runs: string[]; outcomes: string[] }>(`(() => {
    const v = [...document.querySelectorAll(".s-view")].find((s) => !s.hidden);
    return {
      line: v.querySelector(".s-view-line").textContent,
      prompt: v.querySelector(".au-prompt")?.textContent ?? null,
      facts: [...v.querySelectorAll(".au-facts dt")].map((dt) => dt.textContent + ": " + dt.nextElementSibling.textContent),
      buttons: [...v.querySelectorAll(".au-view .actions button")].map((b) => b.textContent).join(),
      runs: [...v.querySelectorAll(".au-run-head")].map((h) => h.textContent),
      outcomes: [...(v.querySelector(".au-run")?.querySelectorAll(".au-outcome") ?? [])].map((o) => o.textContent),
    };
  })()`);
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
// The bubbles at the window's edge, top to bottom: each its title, words, colour and fix, and whether it lies on the page's
// column inside the window, clear of the sidebar, the list beside a review and the chat.
interface BubbleSays {
  title: string;
  text: string | null;
  tone: "red" | "amber" | null;
  fix: string | null;
  dismiss: boolean;
  placed: boolean;
}
const bubblesSay = (page: Page) =>
  page.evaluate<BubbleSays[]>(`[...document.querySelectorAll(".bubble")].map((b) => {
    const r = b.getBoundingClientRect();
    const left = Math.max(0, ...[".side", ".beside"].map((s) => document.querySelector(s)?.getBoundingClientRect().right ?? 0));
    const chat = document.querySelector(".chat")?.getBoundingClientRect().left ?? innerWidth;
    return {
      title: b.querySelector(".bubble-title").textContent,
      text: b.querySelector(".bubble-text")?.textContent ?? null,
      tone: b.classList.contains("t-red") ? "red" : b.classList.contains("t-amber") ? "amber" : null,
      fix: b.querySelector(".bubble-fix")?.textContent ?? null,
      dismiss: b.querySelector(".bubble-x")?.getAttribute("aria-label") === "Dismiss",
      placed: (innerWidth <= 640 || r.left >= left) && r.right <= Math.min(chat, innerWidth) && r.bottom <= innerHeight && r.top >= 0,
    };
  })`);
const SYNC_401 = "GitHub rejected the token (HTTP 401)";
const refusing = new Set<string>(); // routes a shot refuses on purpose: the browser's console error for each is expected
// The page head's words: a list's filter, a review's way back, or the page's name.
const headSays = (page: Page) =>
  page.evaluate<string | null>(
    `(() => { const h = document.querySelector(".page-head"); return h && (h.querySelector("input")?.placeholder ?? h.textContent.trim()); })()`,
  );
// In Settings: the page head's words, then the sidebar's items, "|" for its hairline and the one it marks current in brackets:
// "Agent: Inbox Inbox and notifications [Agent] Your automations This device | GitHub"; null outside Settings.
const SETTINGS_SIDE = ["Inbox and notifications", "Agent", "Your automations", "Urgency", "Appearance", "This device"];
const settingsSays = (page: Page) =>
  page.evaluate<string | null>(`(() => {
    const nav = document.querySelector('.side-nav[aria-label="Settings"]');
    if (!nav) return null;
    const items = [...nav.children].map((el) =>
      el.classList.contains("side-sep") ? "|" : el.getAttribute("aria-current") === "page" ? "[" + el.textContent.trim() + "]" : el.textContent.trim(),
    );
    return document.querySelector(".page-head").textContent.trim() + ": " + items.join(" ");
  })()`);
// What settingsSays reads on the part named `on`.
const onPart = (on: string) =>
  `${on}: Inbox ${[...SETTINGS_SIDE, "|", "GitHub", "Sessions"].map((p) => (p === on ? `[${p}]` : p)).join(" ")}`;
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
// The first-run page, as a fresh desk shows it: a mock-only switch (web/mock/server.ts), then a reload, since the window
// asks about it only until it's done. `github: false` is GitHub signed out.
const firstRun =
  (github = true) =>
  async (page: Page) => {
    await page.evaluate(`fetch("/api/mock/setup", { method: "POST", body: JSON.stringify({ needed: true, github: ${github} }) })`);
    await page.reload();
    await page.locator(".setup").waitFor({ timeout: 15_000 });
  };
const setupDone = async (page: Page) => {
  await page.evaluate(`fetch("/api/mock/setup", { method: "POST", body: JSON.stringify({ needed: false }) })`);
  await page.reload();
  await page.locator(READY).first().waitFor({ timeout: 15_000 });
};
// What the first-run page says: its rows' labels and help, and its buttons.
const setupSays = (page: Page) =>
  page.evaluate<{ side: boolean; title: string; rows: string[]; buttons: string[]; go: string[] }>(`(() => ({
    side: !!document.querySelector(".side"),
    title: document.querySelector(".setup-title")?.textContent ?? "",
    rows: [...document.querySelectorAll(".setup .setting")].map((r) => r.querySelector(".s-label").textContent + " | " + (r.querySelector(".s-help")?.textContent ?? "")),
    buttons: [...document.querySelectorAll(".setup button")].map((b) => b.textContent),
    go: [...document.querySelectorAll(".setup .act.primary.go")].map((b) => b.textContent),
  }))()`);
// pick: Use Claude Code pressed first, as the installer does when Claude Code runs it.
const setupShot = (name: string, github: boolean, viewport?: { width: number; height: number }, pick = false): Shot => ({
  name,
  writes: true,
  ...(viewport && { sizes: ["wide"] }),
  go: async (page) => {
    if (viewport) await page.setViewportSize(viewport);
    await firstRun(github)(page);
    if (pick) {
      await page.getByRole("button", { name: "Use Claude Code" }).click();
      await page.getByText("Your agent:").waitFor({ timeout: 15_000 });
    }
    const s = await setupSays(page);
    const want = pick
      ? {
          rows: [
            "You're not signed in to GitHub. | Run gh auth login in a terminal, then Retry.",
            "Claude Code | Your agent: Inbox's MCP tools and skill are installed in it.",
            "Codex | Not logged in. Run codex login in a terminal, then Retry.",
            "OpenCode | Not installed. Run curl -fsSL https://opencode.ai/install | bash && opencode auth login in a terminal, then Retry.",
          ],
          buttons: ["Retry", "Retry", "Retry"],
        }
      : github
        ? {
            rows: [
              "Signed in as @me | ",
              "Claude Code | Installed and logged in.",
              "Codex | Not logged in. Run codex login in a terminal, then Retry.",
              "OpenCode | Not installed. Run curl -fsSL https://opencode.ai/install | bash && opencode auth login in a terminal, then Retry.",
            ],
            buttons: ["Use Claude Code", "Retry", "Retry"],
          }
        : {
            rows: [
              "You're not signed in to GitHub. | Run gh auth login in a terminal, then Retry.",
              "Claude Code | Installed and logged in.",
              "Codex | Not logged in. Run codex login in a terminal, then Retry.",
              "OpenCode | Not installed. Run curl -fsSL https://opencode.ai/install | bash && opencode auth login in a terminal, then Retry.",
            ],
            buttons: ["Retry", "Use Claude Code", "Retry", "Retry"],
          };
    const got = { rows: s.rows, buttons: s.buttons };
    if (s.side || s.title !== "Set up Inbox" || JSON.stringify(got) !== JSON.stringify(want))
      failures.push(`${name}: the page reads ${JSON.stringify(s)}`);
    if (s.go.length !== (pick ? 0 : 1)) failures.push(`${name}: its green buttons are ${JSON.stringify(s.go)}`);
  },
  after: async (page) => {
    if (viewport) {
      const wide = SIZES.find((x) => x.name === "wide")!;
      await page.setViewportSize({ width: wide.width, height: wide.height });
    }
    await setupDone(page);
  },
});
// A new desk's first minutes (QueueView.first_pass): one line where the empty Inbox would be, or above its rows.
const firstPassShot = (name: string, pass: FirstPass, viewport?: { width: number; height: number }): Shot => ({
  name,
  sizes: ["wide"],
  go: async (page) => {
    if (viewport) await page.setViewportSize(viewport);
    await at("#/")(page);
    await queueAs((q) => {
      q.first_pass = pass;
      if (pass.step === "sync") {
        q.sections.now = [];
        q.sections.today = [];
        q.inbox = { urgent: [], standard: [], fyi: [] };
        q.inquiries = [];
        q.notes = { due: [], open: [], later: [] };
        q.sessions = [];
      }
    })(page);
    await top(page);
    const seen = await page.evaluate<{ line: string | null; empty: number; above: boolean }>(`(() => {
      const line = document.querySelector(".queue-first");
      const head = document.querySelector(".queue .group-head");
      return {
        line: line?.textContent ?? null,
        empty: document.querySelectorAll(".queue-empty").length,
        above: !head || (!!line && line.getBoundingClientRect().bottom <= head.getBoundingClientRect().top),
      };
    })()`);
    if (seen.line !== pass.line || seen.empty || !seen.above) failures.push(`${name}: the Inbox reads ${JSON.stringify(seen)}`);
  },
  after: async (page) => {
    if (viewport) {
      const wide = SIZES.find((x) => x.name === "wide")!;
      await page.setViewportSize({ width: wide.width, height: wide.height });
    }
    await unroute(page);
    await page.reload();
    await page.locator(READY).first().waitFor({ timeout: 15_000 });
  },
});
const SYNCING: FirstPass = { step: "sync", done: 4, total: 12, found: 63, line: "Getting your PRs from GitHub… 63 found so far" };
const SORTING: FirstPass = { step: "sort", done: 40, total: 120, found: 120, line: "Sorting 120 PRs… 40 done" };
const SHOTS: Shot[] = [
  setupShot("setup", true),
  setupShot("setup-github", false),
  setupShot("setup-picked", false, undefined, true),
  setupShot("setup-narrow", true, { width: 390, height: 760 }),
  {
    // Picking your agent: one press, then the Inbox.
    name: "setup-done",
    writes: true,
    sizes: ["wide"],
    go: async (page) => {
      await firstRun()(page);
      await page.locator(".setup .act.primary.go", { hasText: "Use Claude Code" }).click();
      await page.locator(READY).first().waitFor({ timeout: 5000 });
      if (await page.locator(".setup").count()) failures.push("setup-done: the first-run page is still there");
      if ((await sideOn(page)) !== "Inbox") failures.push("setup-done: it didn't land on the Inbox");
    },
  },
  {
    // Nothing is selected on load: no row's fill, no filled call to action.
    name: "queue",
    sizes: ["wide", "mid", "min", "mac", "xl"],
    go: async (page) => {
      await at("#/")(page);
      if (await page.evaluate<boolean>("innerWidth >= 1280"))
        await faces(page, "queue", ".line:not(.c-line, .inq, .session, .memo) .line-by");
      if (await page.locator(".line.sel").count()) failures.push("queue: a row is selected on load");
      if (await page.locator(".line-cta.primary").count()) failures.push("queue: a row's call to action is filled on load");
      const on = await sideOn(page);
      if (on !== "Inbox") failures.push(`queue: the sidebar marks ${JSON.stringify(on)}`);
      const head = await headSays(page);
      if (head !== "Filter") failures.push(`queue: the page head reads ${JSON.stringify(head)}, not the filter`);
      if (await page.locator(".bubble").count()) failures.push("queue: a bubble while nothing's wrong");
      // Its sections under their headings, Urgent led by an agent's question, a row like the rest; a hand-back saying so on
      // its own row at every width; each row saying why it's there; every row shown, no "n more".
      const list = await page.evaluate<{
        heads: string[];
        tables: number;
        first: (string | null)[];
        back: string | null;
        fold: number;
        reasons: number;
        rows: number;
      }>(`(() => {
        const text = (el, sel) => el?.querySelector(sel)?.textContent.trim() ?? null;
        const first = document.querySelector(".queue .line");
        const back = document.querySelector('.queue .line[data-id="oss/tinyhttp#205"] .line-stage');
        const cards = [...document.querySelectorAll(".queue .line[data-id]:not(.inq, .session, .memo)")];
        return {
          heads: [...document.querySelectorAll(".queue .group-head span:first-child")].map((h) => h.textContent),
          tables: document.querySelectorAll(".queue .lines").length,
          first: [text(first, ".line-kind"), text(first, ".line-by"), text(first, ".line-cta")],
          back: back?.getClientRects().length ? back.textContent : null,
          fold: document.querySelectorAll(".queue .fold").length,
          reasons: cards.filter((c) => c.querySelector(".line-note")?.textContent.trim()).length,
          rows: cards.length,
        };
      })()`);
      if (list.heads.join(" ") !== "Urgent Standard FYI" || list.tables !== 3)
        failures.push(`queue: the Inbox is ${list.tables} tables under ${JSON.stringify(list.heads)}`);
      if (list.reasons !== list.rows) failures.push(`queue: ${list.rows - list.reasons} of ${list.rows} rows don't say why they're there`);
      if (list.first.join(" · ") !== "Question · by your agent · Answer")
        failures.push(`queue: an agent's question's row reads ${JSON.stringify(list.first)}`);
      if (list.back !== "handed back") failures.push(`queue: the handed-back PR's stage reads ${JSON.stringify(list.back)}`);
      if (list.fold) failures.push('queue: a section folds behind a "more" line');
    },
  },
  {
    // Notes to yourself: a due reminder in Urgent, one with no time leading Standard; New note on the head and ⌘N open the
    // note box, its reminder picked from a list or a time you pick.
    name: "queue-notes",
    go: async (page) => {
      await at("#/")(page);
      const rows = await page.evaluate<{ urgent: string[]; standard: string[] }>(`(() => ({
        urgent: [...document.querySelectorAll(".g-urgent .line.memo .line-title")].map((e) => e.textContent),
        standard: [...document.querySelectorAll(".g-standard .line.memo .line-title")].map((e) => e.textContent),
      }))()`);
      if (rows.urgent.length !== 1 || rows.standard.length !== 1) failures.push(`queue-notes: notes drawn ${JSON.stringify(rows)}`);
      if (!(await page.locator(".page-head .head-note", { hasText: "New note" }).count()))
        failures.push("queue-notes: no New note on the head");
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+n`);
      await page.locator(".note-bar textarea").waitFor({ timeout: 3000 });
      await page.locator(".note-bar textarea").fill("Ping Sam about the holdout set once the reranker eval lands");
      await page.locator(".note-bar select").selectOption("pick");
      await page.waitForTimeout(150);
      if (!(await page.locator('.note-bar input[type="datetime-local"]').count()))
        failures.push("queue-notes: Pick a time shows no time field");
    },
    after: async (page) => {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
      if (await page.locator(".note-bar").count()) failures.push("queue-notes: Esc leaves the note box open");
    },
  },
  {
    // Change with your agent on a criterion: your words go to your agent told which tool to use, and its chat opens.
    name: "settings-criteria-ask",
    go: async (page) => {
      await at("#/settings/criteria")(page);
      const sent: string[] = [];
      const seen = (r: Sent) => {
        if (r.method() === "POST" && r.url().endsWith("/api/ask")) sent.push(r.postData() ?? "");
      };
      page.on("request", seen);
      await page.locator(".cr-row .link-btn", { hasText: "Change with your agent" }).first().click();
      await page.locator(".ask-change textarea").fill("Only when its CI is green");
      await page.locator(".ask-change .act.primary").click();
      await page.waitForTimeout(500);
      page.off("request", seen);
      const text = sent.length ? (JSON.parse(sent[0]!) as { text: string }).text : "";
      if (!text.includes("Only when its CI is green") || !text.includes("desk_criteria"))
        failures.push(`settings-criteria-ask: your agent was sent ${JSON.stringify(text)}`);
      if (!(await page.locator(".chat").count())) failures.push("settings-criteria-ask: the chat didn't open");
    },
    after: async (page) => {
      await page.keyboard.press("Escape");
      await at("#/")(page);
    },
  },
  {
    // Sessions that need you, after the agents' questions and before every PR: rows like the others (Session, its name,
    // quietly its folder, its call to action, its kind where a PR's author goes and why where its stage goes), and the
    // blocked one opened in place with what it said, where it runs and its buttons.
    name: "queue-session",
    after: async (page) => {
      if (await page.locator(".line.session.open").count()) await page.locator(".session-more button", { hasText: "Close" }).click();
    },
    go: async (page) => {
      await at("#/")(page);
      const rows = await page.evaluate<{ order: string[]; rows: (string | null)[][] }>(`(() => {
        const text = (el, sel) => el.querySelector(sel)?.textContent.trim() ?? null;
        const lines = [...document.querySelectorAll(".queue .lines > .line")];
        return {
          order: lines.map((el) => (el.classList.contains("inq") ? "q" : el.classList.contains("session") ? "s" : "c")),
          rows: [...document.querySelectorAll(".queue .line.session")].map((el) =>
            [".line-kind", ".line-title", ".line-ref", ".line-cta", ".line-by", ".line-stage"].map((sel) => text(el, sel)),
          ),
        };
      })()`);
      const order = rows.order.join("");
      if (!/^q*ssc/.test(order)) failures.push(`queue-session: the Inbox's order reads ${order}`);
      const [blocked, stalled] = rows.rows;
      if (blocked?.join(" · ") !== "Session · Fix the flaky upload test · api · Open · Desktop · needs permission: Bash")
        failures.push(`queue-session: the blocked session's row reads ${JSON.stringify(blocked)}`);
      if (
        !/^Session · Migrate the job store to SQLite · worker · Kick · Background · rate limited until \d\d:\d\d$/.test(
          stalled?.join(" · ") ?? "",
        )
      )
        failures.push(`queue-session: the stalled session's row reads ${JSON.stringify(stalled)}`);
      // Its menu, as minimal as a PR's: Done, Snooze (to a time), then its call to action.
      await page.locator(".line.session", { hasText: "Migrate the job store" }).locator(".row-main").click({ button: "right" });
      await page.locator(".ctx-item").first().waitFor();
      const menu = await page.evaluate<string[]>(
        `[...document.querySelectorAll(".ctx > .ctx-group > .ctx-item, .ctx > .ctx-group > .ctx-subwrap > .ctx-item")].map((el) => (el.querySelector("span") ?? el).textContent.trim())`,
      );
      if (menu.join(" · ") !== "Done · Snooze · Kick") failures.push(`queue-session: a session's menu reads ${JSON.stringify(menu)}`);
      await page.keyboard.press("Escape");
      await page.locator(".line.session", { hasText: "Fix the flaky upload test" }).locator(".row-main").click();
      await page.waitForTimeout(200);
      const open = await page.evaluate<{ why: string; said: string; facts: string[]; acts: [string, boolean][] } | null>(`(() => {
        const d = document.querySelector(".line.session.open .session-more");
        return d && {
          why: d.querySelector(".d-why")?.textContent.trim() ?? "",
          said: d.querySelector(".session-said")?.textContent.trim() ?? "",
          facts: [...d.querySelectorAll(".card-facts span")].map((x) => x.textContent.trim()),
          acts: [...d.querySelectorAll(".card-keys button")].map((b) => [b.textContent.trim(), b.classList.contains("primary")]),
        };
      })()`);
      if (!open) failures.push("queue-session: a click doesn't open the session in place");
      else {
        if (!open.why.startsWith("Needs permission: Bash")) failures.push(`queue-session: its detail says ${JSON.stringify(open.why)}`);
        if (open.said !== "Bash: Run the upload tests 20 times with retries off")
          failures.push(`queue-session: what it said reads ${JSON.stringify(open.said)}`);
        if (open.facts.join(" · ") !== "Desktop · /Users/you/code/api · fix/upload-flake · running")
          failures.push(`queue-session: where it runs reads ${JSON.stringify(open.facts)}`);
        if (
          JSON.stringify(open.acts) !==
          JSON.stringify([
            ["Open", true],
            ["Done", false],
            ["Snooze", false],
            ["Mute", false],
            ["Close", false],
          ])
        )
          failures.push(`queue-session: its buttons read ${JSON.stringify(open.acts)}`);
      }
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
    // GitHub's rate limit: a bubble at the window's edge says so in amber, and when syncing starts again; nothing to press,
    // since the desk skips a sync until the limit resets.
    name: "sync-limited",
    go: async (page) => {
      const error = "GitHub rate limited until 2026-11-09T00:00:00Z (HTTP 403)";
      await overviewAs((o) => {
        o.sync_error = error;
        o.connectors = o.connectors.map((c) => ({ ...c, status: "paused", error }));
        o.rate_limit = { remaining: 0, reset_at: new Date(Date.now() + 40 * 60_000).toISOString() };
      })(page);
      await page.reload();
      await page.locator(READY).first().waitFor({ timeout: 15_000 });
      await page.locator(".bubble").waitFor();
      await page.waitForTimeout(300); // in, not rising
      const b = await bubblesSay(page);
      if (b.length !== 1 || b[0]!.title !== "GitHub's rate limit is used up" || b[0]!.tone !== "amber" || b[0]!.fix || !b[0]!.placed)
        failures.push(`sync-limited: the bubbles read ${JSON.stringify(b)}`);
      if (!b[0]?.text?.startsWith("Syncing starts again at ")) failures.push(`sync-limited: its words are ${JSON.stringify(b[0]?.text)}`);
    },
    after: unsettle,
  },
  {
    // A newer Inbox: the sidebar's footer offers it above Settings in the accent; Update when the app installs it
    // itself, Download (its release page) when it can't.
    name: "sidebar-update",
    go: async (page) => {
      await overviewAs((o) => {
        o.update = { ...NEWER, install: true };
      })(page);
      await page.reload();
      await page.locator(READY).first().waitFor({ timeout: 15_000 });
      const text = await page.locator(".side-update").textContent();
      if (text !== "Update to 0.2.0") failures.push(`sidebar-update: the line reads ${JSON.stringify(text)}`);
    },
    after: unsettle,
  },
  {
    name: "sidebar-download",
    go: async (page) => {
      await overviewAs((o) => {
        o.update = NEWER;
      })(page);
      await page.reload();
      await page.locator(READY).first().waitFor({ timeout: 15_000 });
      const link = page.locator("a.side-update");
      if ((await link.textContent()) !== "Download 0.2.0" || !(await link.getAttribute("href"))?.includes("/releases/tag/v0.2.0"))
        failures.push(`sidebar-download: the line reads ${JSON.stringify(await link.textContent())}`);
    },
    after: unsettle,
  },
  {
    // The last sync failed: a red bubble with the error and Try again, the list kept beside it. Dismissed, it stays gone
    // across a reload while the sync keeps failing; once a sync works and a later one fails, it's back.
    name: "sync-failed",
    go: async (page) => {
      await overviewAs((o) => {
        o.sync_error = SYNC_401;
      })(page);
      await page.reload();
      await page.locator(READY).first().waitFor({ timeout: 15_000 });
      await page.locator(".bubble").waitFor();
      await page.waitForTimeout(300); // in, not rising
      const b = await bubblesSay(page);
      if (
        b.length !== 1 ||
        b[0]!.title !== "Sync failed" ||
        b[0]!.text !== SYNC_401 ||
        b[0]!.tone !== "red" ||
        b[0]!.fix !== "Try again" ||
        !b[0]!.dismiss ||
        !b[0]!.placed
      )
        failures.push(`sync-failed: the bubbles read ${JSON.stringify(b)}`);
      if (!(await page.locator(".queue .line").count())) failures.push("sync-failed: the list isn't kept");
    },
    after: async (page) => {
      await page.locator(".bubble-x").click();
      await page
        .locator(".bubble")
        .waitFor({ state: "detached", timeout: 2000 })
        .catch(() => failures.push("sync-failed: Dismiss leaves it"));
      await page.reload();
      await page.locator(READY).first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(300);
      if (await page.locator(".bubble").count())
        failures.push("sync-failed: a dismissed bubble is back after a reload, the sync still failing");
      await unroute(page);
      await page.reload();
      await page.locator(READY).first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(300);
      await overviewAs((o) => {
        o.sync_error = SYNC_401;
      })(page);
      await page.reload();
      await page
        .locator(".bubble", { hasText: "Sync failed" })
        .waitFor({ timeout: 5000 })
        .catch(() => failures.push("sync-failed: failing again after a sync worked, it isn't back"));
      await unsettle(page);
    },
  },
  {
    // The desk gone: the list stays, and a red bubble says the desk isn't running, with Retry.
    name: "sync-offline",
    go: async (page) => {
      await at("#/")(page);
      // A 200 that isn't JSON is what the window takes for no desk, without a console error; the event stream stays.
      await page.route("**/api/**", (route) =>
        route.request().url().endsWith("/api/events") ? route.fallback() : route.fulfill({ contentType: "text/plain", body: "" }),
      );
      await page.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`);
      await page.locator(".bubble", { hasText: "The desk isn't running" }).waitFor();
      await page.waitForTimeout(300); // in, not rising
      const b = await bubblesSay(page);
      if (b.length !== 1 || b[0]!.tone !== "red" || b[0]!.fix !== "Retry" || !b[0]!.placed)
        failures.push(`sync-offline: the bubbles read ${JSON.stringify(b)}`);
      if (await page.locator(".main .notice").count()) failures.push("sync-offline: the page still has a notice line");
      if (!(await page.locator(".queue .line").count())) failures.push("sync-offline: the list isn't kept");
    },
    // Then the desk back: the bubble goes.
    after: async (page) => {
      await unroute(page);
      await page.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`);
      await page
        .locator(".bubble")
        .waitFor({ state: "detached", timeout: 5000 })
        .catch(() => failures.push("sync-offline: the bubble stays once the desk is back"));
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
      // One sheet: every row as far from the one before it.
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
        q.inbox = { urgent: [], standard: [], fyi: [] };
        q.inquiries = [];
        q.notes = { due: [], open: [], later: [] };
        q.sessions = [];
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
  firstPassShot("first-sync", SYNCING),
  firstPassShot("first-sync-narrow", SYNCING, { width: 390, height: 760 }),
  firstPassShot("first-sorting", SORTING),
  firstPassShot("first-sorting-narrow", SORTING, { width: 390, height: 760 }),
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
        q.inbox = { urgent: [], standard: [], fyi: [] };
        q.inquiries = [];
        q.notes = { due: [], open: [], later: [] };
        q.sessions = [];
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
    // Scrolled into Standard, its heading stays pinned under the page's head, rows passing under it.
    name: "queue-pinned-head",
    go: async (page) => {
      await at("#/")(page);
      await page.evaluate(`(() => {
        const rows = document.querySelectorAll(".g-standard .line");
        rows[Math.min(6, rows.length - 1)].scrollIntoView({ block: "start" });
      })()`);
      await page.waitForTimeout(200);
      const pin = await page.evaluate<{ top: number; head: number } | null>(`(() => {
        const h = document.querySelector(".g-standard .group-head"), head = document.querySelector(".page-head");
        return h && head ? { top: Math.round(h.getBoundingClientRect().top), head: Math.round(head.getBoundingClientRect().bottom) } : null;
      })()`);
      if (!pin || pin.top !== pin.head)
        failures.push(`queue-pinned-head: Standard's heading is at ${JSON.stringify(pin)}, not under the page's head`);
    },
  },
  {
    // Your pin lifts a blocked PR onto your page, its stage "blocked", under api#1294, which it waits on and which offers Reply.
    name: "queue-blocked",
    go: async (page) => {
      await queueAs((q) => {
        const [pinned] = q.sections.blocked.splice(0, 1);
        const list = Object.values(q.inbox).find((cs) => cs.some((c) => c.id === "acme/api#1294")) ?? q.inbox.standard;
        const at1294 = list.findIndex((c) => c.id === "acme/api#1294");
        if (pinned) list.splice(at1294 + 1, 0, { ...pinned, group: "mine", pinned: true, reason: "kept up by your pin" });
      })(page);
      await page.evaluate(`document.querySelector('.queue [data-id="acme/billing#2298"]').scrollIntoView({ block: "center" })`);
      await page.waitForTimeout(200);
    },
    after: async (page) => {
      await unroute(page);
    },
  },
  {
    // A draft Junior opened for you is yours: by you, Ready for review, among your PRs.
    name: "queue-on-behalf",
    go: async (page) => {
      await at("#/")(page);
      await page.evaluate(`document.querySelector('.queue [data-id="acme/api#4131"]').scrollIntoView({ block: "center" })`);
      await page.waitForTimeout(200);
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
    // Claude logged out: one bubble at the window's edge instead of a line on the page or a note on every card, its words and
    // the way to Settings → Agent; on that page, none, as the page says it.
    name: "queue-ai-paused",
    writes: true,
    go: async (page) => {
      await at("#/")(page);
      await pauseAi(true)(page);
      await top(page);
      const b = await bubblesSay(page);
      if (
        b.length !== 1 ||
        b[0]!.title !== "Claude is paused" ||
        !b[0]!.text?.includes("Run claude auth login") ||
        b[0]!.tone !== "red" ||
        b[0]!.fix !== "Open Settings → Agent" ||
        !b[0]!.placed
      )
        failures.push(`queue-ai-paused: the bubbles read ${JSON.stringify(b)}`);
      const first = await page.locator(".queue > *").first().getAttribute("class");
      if (!first?.includes("group"))
        failures.push(`queue-ai-paused: the queue starts with ${JSON.stringify(first)}, not its first section`);
    },
    after: async (page) => {
      await page.locator(".bubble-fix", { hasText: "Open Settings → Agent" }).click();
      await page.waitForTimeout(400);
      const hash = await page.evaluate<string>("location.hash");
      if (hash !== "#/settings/agent") failures.push(`queue-ai-paused: Open Settings → Agent went to ${hash}`);
      if (await page.locator(".bubble").count()) failures.push("queue-ai-paused: Settings → Agent says it and still has the bubble");
      await at("#/")(page);
      await pauseAi(false)(page);
    },
  },
  {
    // Three at once, the order they matter: Claude paused, the sync failing, then an action that failed, which fades on its
    // own. The list's last rows scroll clear of them.
    name: "bubbles-stack",
    writes: true,
    go: async (page) => {
      await overviewAs((o) => {
        o.sync_error = SYNC_401;
      })(page);
      refusing.add("/api/act");
      await page.route("**/api/act", (route) =>
        route.fulfill({
          status: 502,
          json: { error: "GitHub refused: Resource not accessible by integration (HTTP 403)", tag: "Upstream" },
        }),
      );
      await page.reload();
      await page.locator(READY).first().waitFor({ timeout: 15_000 });
      await pauseAi(true)(page);
      await rowMenuPick(page, ".queue .line:not(.inq) >> nth=1", "Done");
      await page.locator(".bubble.transient").waitFor({ timeout: 5000 });
      await page.mouse.move(0, 0);
      await page.waitForTimeout(400);
      const b = await bubblesSay(page);
      const titles = b.map((x) => x.title);
      if (
        JSON.stringify(titles) !==
        JSON.stringify(["Claude is paused", "Sync failed", "GitHub refused: Resource not accessible by integration (HTTP 403)"])
      )
        failures.push(`bubbles-stack: the bubbles read ${JSON.stringify(titles)}`);
      if (b.some((x) => !x.placed)) failures.push(`bubbles-stack: a bubble lies off the page's column: ${JSON.stringify(b)}`);
      if (await page.locator(".toast").count()) failures.push("bubbles-stack: the failure is in the toast too");
      // At the page's end its last row sits above the stack, not under it.
      const clear = await page.evaluate<boolean>(`(() => {
        scrollTo(0, document.documentElement.scrollHeight);
        const rows = document.querySelectorAll(".queue .line");
        const last = rows[rows.length - 1]?.getBoundingClientRect();
        const stack = document.querySelector(".bubbles").getBoundingClientRect();
        return !!last && last.bottom <= stack.top;
      })()`);
      if (!clear) failures.push("bubbles-stack: the list's last row stays under the bubbles at the page's end");
      await top(page);
    },
    after: async (page) => {
      await page
        .locator(".bubble.transient")
        .waitFor({ state: "detached", timeout: 12_000 })
        .catch(() => failures.push("bubbles-stack: the failed action's bubble doesn't fade on its own"));
      refusing.delete("/api/act");
      await pauseAi(false)(page);
      await unsettle(page);
    },
  },
  {
    // Beside the chat, never under it.
    name: "bubbles-chat",
    writes: true,
    go: async (page) => {
      await at("#/")(page);
      await pauseAi(true)(page);
      await page.locator(".side-ask").click();
      await page.locator(".chat-input").waitFor();
      await page.waitForTimeout(300);
      const b = await bubblesSay(page);
      if (b.length !== 1 || !b[0]!.placed) failures.push(`bubbles-chat: beside the chat, the bubbles read ${JSON.stringify(b)}`);
    },
    after: async (page) => {
      await closeChat(page);
      await pauseAi(false)(page);
    },
  },
  {
    // A click on a PR opens its review; an issue opens in place, its actions quiet text, Close last.
    name: "expanded",
    go: async (page) => {
      await at("#/")(page);
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
    go: async (page) => {
      await at("#/")(page);
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
      await page.locator(".line", { hasText: "Worker OOM on large batches" }).locator(".row-main").click();
      await page.waitForTimeout(400);
      await page.locator(".card-keys button", { hasText: "Snooze" }).click();
      await page.waitForTimeout(200);
      if (!(await page.locator(".ctx-sub").isVisible())) failures.push("issue-snooze: Snooze didn't open its times");
    },
    after: async (page) => {
      for (let i = 0; i < 2 && (await page.locator(".ctx").count()); i++) await page.keyboard.press("Escape");
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
      await faces(page, "review", ".rv-ref .rv-by:last-child, .cv-author");
    },
  },
  // The top of a review stays short, so the diff starts high: your comment's box is one line on the actions' row, with no
  // row of its own, until it has words. On the three-line box over its own row of actions the first file started at 486px
  // in the mac window, 478 and 475 in the narrower ones; a box or a row creeping back would pass 386 again.
  {
    name: "review-top",
    go: async (page) => {
      await review("acme/api#4127")(page);
      const seen = await page.evaluate<{ box: number; boxTop: number; act: number; file: number; send: number }>(`(() => {
        const r = (s) => document.querySelector(s).getBoundingClientRect();
        return {
          box: Math.round(r(".rv-comment-input").height),
          boxTop: Math.round(r(".rv-comment-input").top),
          act: Math.round(r(".rv-actions .act").top),
          file: Math.round(r(".rv-views, .rv-file-sec").top), // where the diff starts: its two orders' switch, when it has one
          send: document.querySelectorAll(".rv-comment .act").length,
        };
      })()`);
      if (seen.box > 36) failures.push(`review-top: the empty comment box is ${seen.box}px tall, not one line`);
      if (Math.abs(seen.boxTop - seen.act) > 2 || seen.send)
        failures.push(`review-top: the empty comment box isn't alone on the actions' row: ${JSON.stringify(seen)}`);
      if (seen.file > 386) failures.push(`review-top: the diff starts ${seen.file}px down the window, past 386`);
    },
  },
  // Your comment on the PR: the box grows with its words while the buttons stay where they were, Comment beside it; Esc
  // leaves it with the words kept; they're still in it, at their size, after stepping to the next item and back; and the
  // platform's send key sends it.
  {
    name: "review-comment",
    go: async (page) => {
      type Edge = { left: number; top: number; bottom: number };
      const mod = process.platform === "darwin" ? "Meta" : "Control";
      await page.route("**/comment", () => {}); // GitHub never answers here, so the mock's PR stays as it was
      await review("acme/api#4127")(page);
      const box = page.locator(".rv-comment-input");
      const says = () =>
        page.evaluate<{ box: number; approve: Edge | null; send: Edge | null; focused: boolean; hash: string }>(`(() => {
          const r = (s) => { const b = document.querySelector(s)?.getBoundingClientRect(); return b ? { left: Math.round(b.left), top: Math.round(b.top), bottom: Math.round(b.bottom) } : null; };
          const input = document.querySelector(".rv-comment-input").getBoundingClientRect();
          return {
            box: Math.round(input.height),
            approve: r(".rv-actions > .act"),
            send: r(".rv-comment .act"),
            focused: document.activeElement?.matches(".rv-comment-input") ?? false,
            hash: decodeURIComponent(location.hash),
          };
        })()`);
      const empty = await says();
      const words = [
        "Two things before this merges:",
        "1. the budget is only checked between batches",
        "2. a partial result needs saying so",
      ];
      await box.click();
      const cursor = await says();
      for (const [i, line] of words.entries()) {
        if (i) await page.keyboard.press("Enter");
        await page.keyboard.type(line);
      }
      const typed = await says();
      if (cursor.box !== empty.box) failures.push(`review-comment: the cursor alone resized the box, ${empty.box}px to ${cursor.box}px`);
      if (typed.box < 70) failures.push(`review-comment: with three lines in it the box is ${typed.box}px tall`);
      if (JSON.stringify(typed.approve) !== JSON.stringify(empty.approve))
        failures.push(
          `review-comment: Approve moved as the box grew, ${JSON.stringify(empty.approve)} to ${JSON.stringify(typed.approve)}`,
        );
      // Comment is beside the box, inside its height: no row added under the actions.
      const row = typed.approve?.top ?? 0;
      if (!typed.send || typed.send.top < row - 2 || typed.send.bottom > row + typed.box + 2)
        failures.push(`review-comment: Comment isn't beside the box: ${JSON.stringify(typed)}`);
      await page.keyboard.press("Escape");
      const left = await says();
      if (left.focused || left.hash !== "#/review/acme/api#4127" || (await box.inputValue()) !== words.join("\n"))
        failures.push(`review-comment: Esc in the box with words in it left ${JSON.stringify([left, await box.inputValue()])}`);
      // The item after, then back: the words are still in the box, at the size they need.
      await box.click();
      await page.keyboard.press(`${mod}+BracketRight`);
      await page.waitForTimeout(400);
      const away = (await says().catch(() => null))?.hash ?? decodeURIComponent(await page.evaluate<string>("location.hash"));
      if (away === "#/review/acme/api#4127") failures.push("review-comment: the next-item key didn't leave the review");
      await page.keyboard.press(`${mod}+BracketLeft`);
      await page.locator(".rv-diff").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(400);
      const back = await says();
      const kept = await box.inputValue();
      if (back.hash !== "#/review/acme/api#4127" || kept !== words.join("\n"))
        failures.push(`review-comment: back on the review, the comment box reads ${JSON.stringify(kept)}`);
      else if (back.box < 70) failures.push(`review-comment: back on the review, the box with its words is ${back.box}px tall`);
      await box.click();
      await page.keyboard.press(`${mod}+Enter`);
      await page
        .locator(".rv-acted")
        .waitFor({ timeout: 5000 })
        .catch(() => {});
      const acted = (await page.locator(".rv-acted").count()) ? await page.locator(".rv-acted-what").textContent() : null;
      if (acted !== "\u2713 Commented") failures.push(`review-comment: the send key in the box left ${JSON.stringify(acted)}`);
    },
    after: async (page) => {
      await unroute(page);
      await fresh(page);
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
      if (wide) await faces(page, "beside-review", ".c-line:not(.inq) .c-meta .line-by");
      const b = await besideSays(page);
      if (!wide) {
        if (b || (await page.locator(".beside").count())) failures.push("beside-review: a list or its rail beside the review below 1160px");
        return;
      }
      await besideOpen(page, "beside-review", "acme/api#4127");
      if (b?.sideInline) failures.push("beside-review: the review's sidebar squeezes in beside the diff next to the list");
      // The Inbox beside it keeps the page's sections, Urgent first, a question's row leading it.
      const heads = await page.locator(".beside .group-head").count();
      const first = await page.locator(".beside .line .c-meta").first().textContent();
      if (heads !== 3 || first !== "Questionby your agent")
        failures.push(`beside-review: the Inbox beside it has ${heads} headings and starts ${JSON.stringify(first)}`);
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
      // The other question's row beside it has its menu too, its row marked while it's open, then the open question's again.
      await page.locator('.beside .line[data-id="ask:q1c0ffee"] .row-main').click({ button: "right" });
      const marked = (await page.locator(".ctx").count()) ? (await besideSays(page))?.sel : null;
      if (marked !== "ask:q1c0ffee") failures.push(`beside-inquiry: a right-click on a question beside it marks ${JSON.stringify(marked)}`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
      const after = (await besideSays(page))?.sel;
      if (after !== "ask:q2bead00") failures.push(`beside-inquiry: with the menu closed, the list marks ${JSON.stringify(after)}`);
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
        for (const c of Object.values(q.inbox).flat()) if (c.id === "acme/api#4127") c.title = LONG;
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
    // The next review's parts: the goal leads, the first risk reason after the meter, the gap unfolded; the fold holds the
    // summary, the other reasons, Interfaces and Could be better; Look here sits on its line and the first step has a note.
    name: "review-ai-parts",
    go: async (page) => {
      await page.evaluate(`localStorage.removeItem("desk.review.view")`);
      await review("acme/worker#879")(page);
      const ai = page.locator(".rv-ai");
      const bad = (m: string) => failures.push(`review-ai-parts: ${m}`);
      if (!(await ai.locator(".rv-gist").innerText()).startsWith("Splits the scheduler into Lease and Dispatch"))
        bad("the goal doesn't lead");
      if (!(await ai.locator(".rv-reason").count())) bad("no risk reason after the meter");
      if (!(await ai.innerText()).includes("Not quite what the description says:")) bad("no gap line");
      await page.locator(".rv-ai-lead").click();
      await page.waitForTimeout(200);
      const text = await ai.innerText();
      for (const want of ["Interfaces", "Lease.renew()", "Could be better", "Also risky:"])
        if (!text.includes(want)) bad(`the fold has no ${want}`);
      if (!(await page.locator(".rv-look").count())) bad("no Look here in the diff");
      if (!(await page.locator(".rv-step-note").count())) bad("the first step's note is missing");
      const fig = page.locator(".rv-step .dg").first();
      if (!(await fig.count())) bad("the first step's diagram is missing");
      else if (!(await fig.locator(".dg-svg").count())) {
        await fig.scrollIntoViewIfNeeded();
        await page.waitForTimeout(2000);
        if (!(await fig.locator(".dg-svg").count())) bad("the first step's diagram fell back to text");
      }
    },
  },
  {
    // A step's diagram, laid out by ELK in the app's tokens, under its step's note.
    name: "review-diagram",
    go: async (page) => {
      await page.evaluate(`localStorage.removeItem("desk.review.view")`);
      await review("acme/worker#879")(page);
      const fig = page.locator(".rv-step .dg").first();
      await fig.scrollIntoViewIfNeeded();
      await page.locator(".rv-step .dg-svg").first().waitFor({ timeout: 15_000 });
      await page.evaluate(`document.querySelector("#rv-step-0").scrollIntoView({ block: "start" })`);
      await page.waitForTimeout(300);
    },
  },
  {
    // A review document's page (inbox://doc/<id>) in the window: the desk's rendered page in a frame, under Back.
    name: "doc",
    go: async (page) => {
      await at("#/doc/0123456789abcdef")(page);
      const frame = page.frameLocator("iframe.doc-frame");
      await frame.locator(".dg-svg").first().waitFor({ timeout: 15_000 });
      const back = (await page.locator(".page-head .back").textContent())?.trim();
      if (back !== "Inbox") failures.push(`doc: the back link reads ${JSON.stringify(back)}`);
      if (!(await frame.locator(".rv-title").textContent())?.includes("Split the scheduler")) failures.push("doc: the page has no title");
    },
    after: at("#/"),
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
      // The sidebar's toggle is the loaded review's: the icon button, not words.
      const toggle = await page.evaluate<{ tag: string; text: string; icon: boolean; label: string | null } | null>(`(() => {
        const b = document.querySelector('.review[aria-busy="true"] .rv-side-toggle');
        return b && { tag: b.tagName, text: b.textContent.trim(), icon: !!b.querySelector("svg"), label: b.getAttribute("aria-label") };
      })()`);
      if (toggle?.tag !== "BUTTON" || toggle.text || !toggle.icon || !toggle.label?.endsWith("checks and files"))
        failures.push(`review-loading: the sidebar's toggle is ${JSON.stringify(toggle)}`);
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
    // A review that ran out of time three times: why, and Try again, never a spinner for a review nobody runs.
    name: "review-ai-failed",
    go: async (page) => {
      await review("acme/worker#890")(page);
      const ai = await page.locator(".rv-ai").textContent();
      if (!ai?.startsWith("The AI review failed 3 times: no answer in 5 minutes, so it was stopped. Try again"))
        failures.push(`review-ai-failed: the AI section reads ${JSON.stringify(ai)}`);
      if (ai?.includes("Claude is reviewing it")) failures.push("review-ai-failed: it says Claude is reviewing it");
    },
  },
  {
    // A try that failed, the next one waiting out its backoff: why, and when Claude tries again.
    name: "review-ai-retrying",
    go: async (page) => {
      const retry = new Date(Date.now() + 2 * 60_000).toISOString();
      await reviewAs((v) => {
        const error = "no answer in 5 minutes, so it was stopped";
        Object.assign(v, { ai: null, generating: false, ai_error: error });
        v.ai_job = {
          kind: "ai_review",
          key: v.card.id,
          item: v.card.id,
          head: v.item.head_oid,
          state: "queued",
          attempts: 1,
          queued_at: retry,
          started_at: retry,
          finished_at: null,
          retry_at: retry,
          error,
        };
      })(page);
      await review("acme/api#4127")(page);
      const ai = await page.locator(".rv-ai").textContent();
      if (ai !== "The AI review failed: no answer in 5 minutes, so it was stopped. Claude tries again in 2 minutes. Try again")
        failures.push(`review-ai-retrying: the AI section reads ${JSON.stringify(ai)}`);
    },
    after: async (page) => {
      await unroute(page);
      await fresh(page);
    },
  },
  {
    // On its second try, minutes in: it says so, not that the notes land in a minute or two. Four minutes in as the shot
    // reads it, since a pause in an earlier shot starts the try again as on the desk.
    name: "review-ai-running",
    go: async (page) => {
      await reviewAs((v) => {
        if (v.ai_job) v.ai_job.started_at = new Date(Date.now() - 4 * 60_000).toISOString();
      })(page);
      await review("acme/web#2301")(page);
      const ai = await page.locator(".rv-ai").textContent();
      if (ai !== "Claude is reviewing it, 4 minutes so far, try 2 of 3.")
        failures.push(`review-ai-running: the AI section reads ${JSON.stringify(ai)}`);
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
        for (const c of Object.values(q.inbox).flat())
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
      if (await page.getByRole("button", { name: "Hand off for merge" }).count())
        failures.push("review-unasked: Hand off for merge shows where a review is required");
    },
    after: async (page) => {
      await unroute(page);
      await fresh(page);
    },
  },
  // The same in a repo that needs no review (terraform-sandboxes): Hand off for merge beside Ask reviewers, which stays filled.
  {
    name: "review-unasked-no-review",
    go: async (page) => {
      await fresh(page);
      await reviewAs((v) => {
        if (v.card.id !== "acme/api#3051") return;
        Object.assign(v.card, {
          cta: "reviewers",
          handed_back: true,
          why: "nobody's asked to review it: add reviewers",
          review: "none",
          review_optional: true,
        });
        v.item = { ...v.item, review_requests: [], review_decision: "none" };
      })(page);
      await at(`#/review/${encodeURIComponent("acme/api#3051")}`)(page);
      await page.waitForFunction(`document.activeElement?.matches(".rv-reviewers-input")`);
      await page.locator(".rv-suggested .suggest").first().waitFor();
      await page.waitForTimeout(300);
      const hand = page.getByRole("button", { name: "Hand off for merge" });
      if (!(await hand.count())) failures.push("review-unasked-no-review: no Hand off for merge beside Ask reviewers");
      else if ((await hand.getAttribute("class"))?.split(" ").includes("primary"))
        failures.push("review-unasked-no-review: Hand off for merge is filled beside Ask reviewers");
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
  {
    // Your own PR still waiting on its review: no Hand off for merge in its review or its row's menu, since it isn't approved.
    name: "review-mine",
    go: async (page) => {
      await at("#/")(page);
      await page.locator('.line[data-id="oss/tinyhttp#205"] .row-main').click({ button: "right" });
      await page.locator(".ctx-item").first().waitFor();
      if (await page.locator(".ctx-item", { hasText: "Hand off for merge" }).count())
        failures.push("review-mine: the row menu of a PR waiting on its review has Hand off for merge");
      await page.keyboard.press("Escape");
      await review("oss/tinyhttp#205")(page);
      if (await page.locator("button", { hasText: "Hand off for merge" }).count())
        failures.push("review-mine: the review of a PR waiting on its review has Hand off for merge");
    },
  },
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
  // A PR's checks, in the sidebar with its files: one line that says where CI stands, red while one that counts is failing;
  // open, each check by name with its state in words and a link to its page, what's wrong first. A click on the facts' "CI
  // failing" opens the sidebar at them.
  {
    name: "review-checks",
    go: async (page) => {
      await review("oss/tinyhttp#205")(page);
      const side = page.locator(".rv-side");
      if (!(await side.isVisible())) await page.locator(".rv-side-show").click(); // folded where the column is narrow
      const part = page.locator("[data-part=checks]");
      if (!(await part.count())) {
        failures.push("review-checks: the sidebar has no checks");
        return;
      }
      const read = () =>
        page.evaluate<{ line: string; red: boolean; rows: string[]; more: string; above: boolean }>(`(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--red)";
        document.body.append(probe);
        const red = getComputedStyle(probe).color;
        probe.remove();
        const part = document.querySelector("[data-part=checks]"), line = part.querySelector(".rv-part-line");
        const box = part.getBoundingClientRect();
        return {
          line: line.textContent,
          red: getComputedStyle(line).color === red,
          rows: [...part.querySelectorAll(".rv-part-row")].map((el) => {
            const dot = [...el.querySelector(".rv-dot").classList].find((c) => c.startsWith("d-")).slice(2);
            const n = el.querySelector(".rv-part-state")?.textContent;
            return dot + " " + el.querySelector(".rv-part-name").textContent + (n ? " ×" + n : "") + (el.getAttribute("href")?.startsWith("https://") ? " ↗" : "");
          }),
          more: part.querySelector(".rv-part-more")?.textContent ?? "",
          above: box.bottom <= document.querySelector(".rv-files").getBoundingClientRect().top,
        };
      })()`);
      const shut = await read();
      if (shut.line !== "3 failing, 1 running of 11 checks" || !shut.red)
        failures.push(`review-checks: its line reads ${JSON.stringify(shut)}`);
      if (!shut.above) failures.push("review-checks: the checks aren't in the sidebar above its files");
      // Shards fold into one row with a count; what's wrong first; the passing ones behind one line.
      if (shut.rows.join(" | ") !== "red e2e ×2 | red unit tests ×3 | amber visual diff ↗" || shut.more !== "5 more passing")
        failures.push(`review-checks: the rows read ${JSON.stringify(shut)}`);
      await part.locator(".rv-check-group").first().click();
      const nested = await read();
      if (nested.rows.slice(1, 3).join(" | ") !== "red (chromium) ↗ | yellow (firefox) ↗")
        failures.push(`review-checks: e2e opened reads ${JSON.stringify(nested.rows)}`);
    },
    after: sideDefault,
  },
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
  // The guided review: two words above the diff where the review has steps, Guided Review first; only its steps, each with
  // its sections, test files folded; what no step covers is left to Traditional, which draws every file in the PR's order.
  ...(["review-guided", "review-guided-next", "review-guided-end", "review-traditional"] as const).map((name): Shot => ({
    name,
    go: async (page) => {
      await page.evaluate(`localStorage.removeItem("desk.review.view")`);
      const id = name === "review-guided-end" ? "acme/worker#879" : "acme/api#4127";
      await review(id)(page);
      const bad = (m: string) => failures.push(`${name}: ${m}`);
      const tabs = await page.locator(".rv-views .head-tab").allTextContents();
      const on = await page.locator(".rv-views .head-tab.on").allTextContents();
      if (tabs.join("|") !== "Guided Review|Traditional" || on.join() !== "Guided Review")
        bad(`the switch reads ${JSON.stringify(tabs)}, on ${JSON.stringify(on)}`);
      // What the desk sent, and the sections the page drew, in order.
      const sectionsDrawn = `[...document.querySelectorAll(".rv-diffs > .rv-step, .rv-diffs > .rv-file-sec[id]")].map((el) =>
            el.classList.contains("rv-file-sec")
              ? el.getAttribute("aria-label") + (el.classList.contains("shut") ? " (folded)" : "")
              : "# " + (el.children.length ? [...el.querySelectorAll(":scope > h2, :scope > p")].map((c) => c.textContent).join(" ") : el.textContent).replace(/\\s+/g, " ").trim(),
          )`;
      const seen = await page.evaluate<{ o: ReviewOrder; drawn: string[] }>(`(async () => {
          scrollTo(0, document.documentElement.scrollHeight);
          await new Promise((r) => setTimeout(r, 600));
          const v = await (await fetch("/api/review/" + encodeURIComponent(${JSON.stringify(id)}) + "?ahead=1")).json();
          const drawn = ${sectionsDrawn};
          scrollTo(0, 0);
          return { o: v.order, drawn };
        })()`);
      const { o } = seen;
      const tests = (p: string) => (isTestPath(p) ? `${p} (folded)` : p);
      // Sections as the page groups them: a step's run of one file at one level.
      const runs = (hs: ReviewHunk[]) =>
        hs.filter((h, i) => i === 0 || h.path !== hs[i - 1]!.path || h.level !== hs[i - 1]!.level).map((h) => tests(h.path));
      const steps = o.steps ?? [];
      const want = steps.flatMap((st, i) => [
        `# ${i + 1} of ${steps.length} ${st.title}${st.body ? ` ${st.body.replaceAll("`", "")}` : ""}${st.check ? ` Check: ${st.check}` : ""}${st.note ? ` ${st.note}` : ""}`,
        ...runs(st.hunks),
      ]);
      if (steps.length < 2) bad(`the review has ${steps.length} steps`);
      if (seen.drawn.join("\n") !== want.join("\n")) bad(`the page draws\n${seen.drawn.join("\n")}\nnot\n${want.join("\n")}`);
      const nexts = await page.locator(".rv-next").allTextContents();
      const last = nexts.at(-1) ?? "";
      if (
        nexts.slice(0, -1).join("|") !==
          steps
            .slice(1)
            .map((st) => `Next: ${st.title}`)
            .join("|") ||
        !last.startsWith("End of the guide.")
      )
        bad(`the steps end with ${JSON.stringify(nexts)}`);
      const outside = new Set([...(o.beyond ?? []), ...o.rest].map((h) => h.path)).size;
      if (outside > 0 !== last.includes("Traditional"))
        bad(`with ${outside} files outside the guide, its end reads ${JSON.stringify(last)}`);
      if (await page.locator(".rv-side").isVisible()) {
        const rows = await page.locator(".rv-files .rv-file").allTextContents();
        if (rows.length !== steps.length) bad(`the sidebar lists ${JSON.stringify(rows)}`);
      }
      if (name === "review-guided") await page.locator(".rv-views").scrollIntoViewIfNeeded();
      if (name === "review-guided-next") {
        await page.locator(".rv-next").first().click();
        await page.waitForTimeout(500);
        const stepTop = await page.evaluate<number>(`document.querySelector("#rv-step-1").getBoundingClientRect().top`);
        if (stepTop < 0 || stepTop > 140) bad(`Next leaves step 2's heading at ${Math.round(stepTop)}px`);
        // Where the sidebar is folded, opened to show the step you're in.
        if (!(await page.locator(".rv-side").isVisible())) await page.locator(".rv-side-toggle").click();
        await page.waitForTimeout(300);
        const marked = await page.locator(".rv-files .rv-file.on").allTextContents();
        if (marked.length !== 1 || !marked[0]!.includes(steps[1]!.title)) bad(`the sidebar marks ${JSON.stringify(marked)}, not step 2`);
      }
      if (name === "review-guided-end") {
        await page.locator(".rv-next").last().scrollIntoViewIfNeeded();
        await page.evaluate(`document.querySelector(".rv-next:last-of-type")?.scrollIntoView({ block: "center" })`);
        await page.waitForTimeout(300);
      }
      if (name === "review-traditional") {
        await page.locator(".rv-views .head-tab", { hasText: "Traditional" }).click();
        await page.waitForTimeout(400);
        const drawn = await page.evaluate<string[]>(`(async () => {
          scrollTo(0, document.documentElement.scrollHeight);
          await new Promise((r) => setTimeout(r, 600));
          const d = ${sectionsDrawn};
          scrollTo(0, 0);
          return d;
        })()`);
        const all = [...o.chunks, ...o.unread, ...o.skipped];
        const files = [...new Set(all.toSorted((a, b) => a.file - b.file).map((h) => h.path))];
        if (drawn.join() !== files.join()) bad(`Traditional draws ${drawn.join()}, not every file in order: ${files.join()}`);
        if ((await page.evaluate<string | null>(`localStorage.getItem("desk.review.view")`)) !== "traditional")
          bad("the choice isn't kept");
        if (await page.locator(".rv-next, .rv-files[aria-label='Steps of the guided review']").count())
          bad("Traditional still shows the steps");
        await page.locator(".rv-views").scrollIntoViewIfNeeded();
      }
    },
    after: async (page) => {
      await page.evaluate(`localStorage.setItem("desk.review.view", "traditional")`);
      await sideDefault(page);
    },
    // xl has room for the sidebar beside the list, where the steps replace the files.
    sizes: ["wide", "mid", "min", "mac", "xl"],
  })),
  {
    // A concern is marked on its line as a potential bug, its evidence in its words.
    name: "review-bug",
    go: async (page) => {
      await review("oss/tinyhttp#212")(page);
      const bug = page.locator(".rv-note.bug").first();
      if (!(await bug.count())) failures.push("review-bug: no concern marked Potential bug");
      else {
        await bug.scrollIntoViewIfNeeded();
        if ((await bug.locator(".rv-bug").textContent()) !== "Potential bug") failures.push("review-bug: its label reads otherwise");
      }
    },
  },
  {
    // A review without steps has no switch: the page is as it was.
    name: "review-guided-none",
    go: async (page) => {
      await review("acme/api#4154")(page);
      if (await page.locator(".rv-views, .rv-step").count()) failures.push("review-guided-none: a review without steps shows the switch");
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
  // The review's sidebar is the PR's state, a line each: its stack, its checks, its reviewers, what stands in its merge,
  // then its files, and no activity. One icon button at the review's top right shows it and hides it, and is still there,
  // with the sidebar, at the bottom of a long review.
  {
    name: "review-panel",
    go: async (page) => {
      // A conflict with its base, as the desk says it of your own PR.
      await reviewAs((v) => {
        if (v.card.id !== "acme/api#4154") return;
        v.merge = "Merge conflict with main";
        v.item.mergeable = "conflict";
      })(page);
      const toggle = page.locator(".rv-side-toggle");
      const side = page.locator(".rv-side");
      const says = () =>
        page.evaluate<{
          tag: string;
          text: string;
          icon: boolean;
          label: string | null;
          title: string | null;
          open: string | null;
          on: boolean;
        }>(`(() => {
          const b = document.querySelector(".rv-side-toggle"), r = b.getBoundingClientRect();
          const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return {
            tag: b.tagName,
            text: b.textContent.trim(),
            icon: !!b.querySelector("svg"),
            label: b.getAttribute("aria-label"),
            title: b.getAttribute("title"),
            open: b.getAttribute("aria-expanded"),
            on: r.top >= 52 && r.bottom <= innerHeight && r.right <= innerWidth && b.contains(at),
          };
        })()`);
      // Hidden then shown then hidden, at the bottom of a long review; the sidebar, shown, is in the window too.
      const atBottom = async (where: string) => {
        if (await side.isVisible()) await toggle.click();
        await page.evaluate("scrollTo(0, document.documentElement.scrollHeight)");
        await page.waitForTimeout(300);
        const hidden = await says();
        if (!hidden.on || hidden.open !== "false" || hidden.label !== "Show checks and files")
          failures.push(`review-panel: at the bottom of the review${where}, the toggle reads ${JSON.stringify(hidden)}`);
        await toggle.click();
        await page.waitForTimeout(200);
        const shown = await says();
        const inView = await page.evaluate<boolean>(`(() => {
          const r = document.querySelector(".rv-side")?.getBoundingClientRect();
          return !!r && r.height > 100 && r.top >= 51 && r.bottom <= innerHeight + 1;
        })()`);
        if (!shown.on || shown.open !== "true" || shown.label !== "Hide checks and files" || !inView)
          failures.push(`review-panel: shown at the bottom of the review${where}, ${JSON.stringify({ ...shown, inView })}`);
        await toggle.click();
        await page.waitForTimeout(200);
        if (await side.count()) failures.push(`review-panel: the toggle doesn't hide the sidebar at the bottom of the review${where}`);
        await page.evaluate("scrollTo(0, 0)");
      };
      await review("acme/api#4099")(page);
      const first = await says();
      if (first.tag !== "BUTTON" || first.text || !first.icon || first.title !== first.label)
        failures.push(`review-panel: the sidebar's toggle isn't one icon button named in its tooltip: ${JSON.stringify(first)}`);
      await atBottom("");
      // With the list folded there's room for the sidebar beside the diff: the same button, in its column.
      const fold = page.locator(".beside-fold");
      if (await fold.count()) {
        await fold.click();
        await page.waitForTimeout(300);
        await atBottom(", the sidebar beside the diff");
        await fold.click();
        await page.waitForTimeout(300);
      }
      // A PR in a stack with a conflict: every part, in order, a line each.
      await review("acme/api#4154")(page);
      if ((await says()).label !== "Show the stack, checks and files")
        failures.push(`review-panel: in a stack, the toggle reads ${JSON.stringify((await says()).label)}`);
      await toggle.click();
      await side.waitFor();
      const parts = await page.evaluate<{
        names: string[];
        text: string;
        lines: Record<string, { text: string; lines: number; amber: boolean; open: string | null }>;
      }>(`(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--amber)";
        document.body.append(probe);
        const amber = getComputedStyle(probe).color;
        probe.remove();
        const side = document.querySelector(".rv-side"), lines = {};
        for (const part of side.querySelectorAll(".rv-part")) {
          const words = part.querySelector(".rv-side-head .fact-word");
          lines[part.getAttribute("aria-label")] = {
            text: words.textContent,
            lines: Math.round(words.getBoundingClientRect().height / parseFloat(getComputedStyle(words).lineHeight)),
            amber: getComputedStyle(words).color === amber,
            open: part.querySelector(".rv-part-lead")?.getAttribute("aria-expanded") ?? null,
          };
        }
        return { names: [...side.querySelectorAll("section, nav")].map((el) => el.getAttribute("aria-label")), text: side.textContent, lines };
      })()`);
      if (parts.names.join(" | ") !== "Stack | Checks | Reviewers | Merge | Files")
        failures.push(`review-panel: the sidebar's parts are ${parts.names.join(" | ")}`);
      if (/recent activity/i.test(parts.text)) failures.push("review-panel: the sidebar still lists recent activity");
      const want = {
        Checks: { text: "CI passing · 11 checks", lines: 1, amber: false, open: "false" },
        Reviewers: { text: "Changes requested by sam", lines: 1, amber: true, open: "false" },
        Merge: { text: "Merge conflict with main", lines: 1, amber: true, open: null },
      };
      if (JSON.stringify(parts.lines) !== JSON.stringify(want))
        failures.push(`review-panel: closed, the parts read ${JSON.stringify(parts.lines)}`);
      const lead = page.locator("[data-part=reviewers] .rv-part-lead");
      if (await lead.count()) await lead.click();
      const rows = await page.evaluate<string[]>(
        `[...document.querySelectorAll("[data-part=reviewers] .rv-part-row")].map((el) => el.querySelector(".rv-part-name").textContent + ": " + el.querySelector(".rv-part-state").textContent)`,
      );
      if (rows.join(" | ") !== "sam: changes requested") failures.push(`review-panel: opened, the reviewers read ${rows.join(" | ")}`);
      await faces(page, "review-panel", "[data-part=reviewers] .rv-part-name");
    },
    after: async (page) => {
      await unroute(page);
      await sideDefault(page);
      await fresh(page);
    },
  },
  // The FYI page's old link opens the Inbox, whose FYI section is what that page's Later and FYI were.
  {
    name: "later",
    go: async (page) => {
      await at("#/later")(page);
      const on = await sideOn(page);
      if (on !== "Inbox") failures.push(`later: the sidebar marks ${JSON.stringify(on)}`);
      await page.locator(".queue .g-fyi").scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
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
  // A PR in a repo that needs no review, CI running: it can merge once CI passes, no review to wait on.
  {
    name: "inflight-no-review",
    go: async (page) => {
      await page.route("**/api/inflight", async (route) => {
        const res = await route.fetch();
        const v = (await res.json()) as InflightView;
        for (const r of v.rows)
          if (r.card.id === "acme/web#2295")
            Object.assign(r, { ci: "pending", failing: [], review_optional: true, waits_on: "can merge once CI passes: no review needed" });
        await route.fulfill({ response: res, json: v });
      });
      await at("#/")(page);
      await at("#/inflight")(page);
      await page.locator(".lane [data-id]").first().waitFor();
      const says = await page.locator('.lane [data-id="acme/web#2295"]').textContent();
      if (!says?.includes("can merge once CI passes")) failures.push(`inflight-no-review: its row reads ${JSON.stringify(says)}`);
    },
    after: async (page) => {
      await unroute(page);
      await fresh(page);
    },
  },
  {
    // Claude's work under the rows, in their columns: two reviews being written (one on its second try), your ask your agent has, a review
    // that failed three times, with its reason and Try again, and your answer nobody picked up, with no Try again; nothing in red.
    name: "inflight-work",
    go: async (page) => {
      await at("#/")(page); // from Merging itself the hash wouldn't change, so the shot before's view would stay
      await at("#/inflight")(page);
      const work = page.locator(".lane .group", { has: page.locator("#h-work") });
      await work.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      const head = (await page.locator("#h-work").textContent())?.replace(/\d+$/, "");
      if (head !== "Claude's work") failures.push(`inflight-work: its heading reads ${JSON.stringify(head)}`);
      const rows = await page.evaluate<
        { note: string; retry: string | null; color: string; x: number; id: string }[]
      >(`[...document.querySelectorAll(".work-row")].map((e) => ({
        note: e.querySelector(".line-note")?.textContent ?? "",
        retry: e.querySelector(".line-cta")?.textContent ?? null,
        color: getComputedStyle(e.querySelector(".line-note")).color,
        x: e.querySelector(".line-note").getBoundingClientRect().left,
        id: e.dataset.id,
      }))`);
      // Merging's columns: where each stands starts where a merging PR's phrase does.
      const x = await page.evaluate<number | null>(
        `document.querySelector(".lane-row:not(.work-row):not(.dim) .line-note")?.getBoundingClientRect().left ?? null`,
      );
      if (x !== null && rows.some((r) => Math.abs(r.x - x) > 1))
        failures.push(`inflight-work: its column starts at ${rows.map((r) => r.id + " " + r.x).join(", ")}, Merging's at ${x}`);
      if (!rows.some((r) => r.note.startsWith("Claude is reviewing it")))
        failures.push(`inflight-work: no running review in ${JSON.stringify(rows)}`);
      if (!rows.some((r) => r.note.includes("try 2 of 3"))) failures.push("inflight-work: the second try doesn't say so");
      const failed = rows.find((r) => r.note.startsWith("Failed 3 times: "));
      if (failed?.retry !== "Try again") failures.push(`inflight-work: the failed review reads ${JSON.stringify(failed)}`);
      if (rows.filter((r) => r.retry).length !== 1) failures.push("inflight-work: Try again on a row that hasn't failed");
      const unread = rows.find((r) => r.note.startsWith("Your answer to seer: code mode research hasn't been picked up"));
      if (!unread?.note.endsWith("that session has probably ended") || unread.retry)
        failures.push(`inflight-work: your unread answer reads ${JSON.stringify(unread)}`);
      const red = await page.evaluate<string>(`(() => {
        const probe = document.body.appendChild(document.createElement("span"));
        probe.style.color = "var(--red)";
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      })()`);
      if (rows.some((r) => r.color === red)) failures.push("inflight-work: a reason in red: it's about the agent, not the PR");
    },
  },
  {
    // A click on Claude's work's review row opens that PR's review.
    name: "inflight-work-click",
    go: async (page) => {
      await at("#/")(page);
      await at("#/inflight")(page);
      await page.locator('.work-failed[data-id^="ai_review"] .row-main').click();
      await page.waitForTimeout(300);
      const hash = await page.evaluate<string>("location.hash");
      if (hash !== `#/review/${encodeURIComponent("acme/worker#890")}`) failures.push(`inflight-work-click: a click went to ${hash}`);
    },
  },
  {
    // A click on your answer nobody picked up opens its question, which says so under your answer.
    name: "inflight-work-answer",
    go: async (page) => {
      await at("#/")(page);
      await at("#/inflight")(page);
      await page.locator('.work-row[data-id^="answer"] .row-main').click();
      await page.locator(".inq-answered").waitFor();
      await page.waitForTimeout(200);
      const hash = await page.evaluate<string>("location.hash");
      if (hash !== "#/inquiry/q3ab5e17") failures.push(`inflight-work-answer: a click went to ${hash}`);
      const said = await page.locator(".inq-pickup").textContent();
      if (said !== "Not picked up yet") failures.push(`inflight-work-answer: under your answer it reads ${JSON.stringify(said)}`);
    },
    after: at("#/"),
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
        v.work = [];
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
          "Workspace not trusted. Run `claude` in /Users/you/.inbox/coordinator once and accept the trust prompt, then retry.";
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
    // Hand off for merge, in your own approved PR's review: it leaves at once, a spinner in the toast while the desk (here never) answers.
    name: "handoff-sent",
    go: async (page) => {
      await page.route("**/api/act", async (route) => {
        if ((route.request().postDataJSON() as { action?: string }).action !== "inflight") await route.continue();
      });
      await review("acme/worker#875")(page);
      await page.getByRole("button", { name: "Hand off for merge" }).click();
      await page.waitForTimeout(300);
    },
    after: fresh,
  },
  {
    // An agent's question leads the Inbox; a click opens its page: what it's about, all it said, its links, the answers.
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
      const acts = await page.evaluate<string[]>(`[...document.querySelectorAll(".inq-write .actions .act")].map((b) => b.textContent)`);
      if (acts.join(" · ") !== "Send · Dismiss · Copy link") failures.push(`inquiry-open: its actions read ${JSON.stringify(acts)}`);
    },
    // Copy link, where its page has its actions: the question's inbox:// link on the clipboard (stubbed), and a quiet toast.
    after: async (page) => {
      await page.evaluate(`navigator.clipboard.writeText = async (t) => { window.__copied = t; }`);
      const copy = page.locator(".inq-write .act", { hasText: "Copy link" });
      if (await copy.count()) {
        await copy.click();
        await page.locator(".toast").waitFor();
        const said = [await page.evaluate<unknown>("window.__copied"), await page.locator(".toast").textContent()];
        if (said[0] !== "inbox://question/q2bead00" || said[1] !== "Copied the link to sentry: ViewerContext rollout's question")
          failures.push(`inquiry-open: Copy link copied and said ${JSON.stringify(said)}`);
      }
      await fresh(page); // its toast gone
    },
  },
  {
    // A question you answered, once its session read your answer: when, under it.
    name: "inquiry-picked-up",
    go: async (page) => {
      await at("#/inquiry/q4f00d42")(page);
      await page.locator(".inq-answered").waitFor();
      await page.waitForTimeout(200);
      const said = (await page.locator(".inq-pickup").textContent()) ?? "";
      if (!/^Picked up \d+m ago$/.test(said)) failures.push(`inquiry-picked-up: under your answer it reads ${JSON.stringify(said)}`);
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
    // The sidebar's Ask your agent on a focused row: the chat about that row, the queue narrowed beside it at wide sizes.
    name: "ask-row",
    go: async (page) => {
      await at("#/")(page);
      await page.locator('.line[data-id="oss/tinyhttp#205"] .row-main').focus();
      await page.locator(".side-ask").click();
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
    go: async (page) => {
      await at("#/")(page);
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
      await page.locator('.line[data-id="acme/web#2303"] .line-cta').click();
      await page.waitForTimeout(500); // past the row's fade and fold
    },
    after: fresh,
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
      // The sync that help means: its bubble, there with the error in red.
      await page.locator(".bubble").waitFor({ timeout: 5000 });
      const b = await bubblesSay(page);
      if (b[0]?.title !== "Sync failed" || b[0].tone !== "red" || b[0].text !== SYNC_401)
        failures.push(`settings-github-error: the bubbles read ${JSON.stringify(b)}`);
    },
    after: unsettle,
  },
  { name: "settings-queue", go: at("#/settings/queue") },
  {
    // Sessions' own part, a plugin's under GitHub in the sidebar: its switch and the model's read, Stalled after behind
    // More, and no Automations heading, as it comes with none.
    name: "settings-sessions",
    go: async (page) => {
      await at("#/settings/sessions")(page);
      const part = await page.evaluate<{ rows: string[]; heads: number; side: string[] }>(`(() => {
        const s = document.querySelector("#s-sessions");
        return {
          rows: [...s.querySelectorAll(".setting:not([hidden]) .s-label")].map((el) => el.textContent.trim()),
          heads: s.querySelectorAll(".group-head").length,
          side: [...document.querySelectorAll(".side-nav .side-name")].map((el) => el.textContent.trim()).slice(-2),
        };
      })()`);
      if (part.rows.join(" · ") !== "Show sessions that need you · Ask your agent whether a question waits on you")
        failures.push(`settings-sessions: its rows read ${JSON.stringify(part.rows)}`);
      if (part.heads) failures.push("settings-sessions: it has an Automations heading with nothing under it");
      if (part.side.join(" · ") !== "GitHub · Sessions") failures.push(`settings-sessions: the sidebar ends ${JSON.stringify(part.side)}`);
    },
  },
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
      await page.locator('[id="setting-queue.quiet_days"]').click();
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
      // Each built-in rule says how much Claude counts it, in words, and a final one says final instead.
      const weights = await page.evaluate<string[]>(
        `[...document.querySelectorAll(".builtin-rules li .br-text > span:first-child")].map((s) => s.textContent.replaceAll("\\u00a0", " "))`,
      );
      if (!weights.some((w) => w.includes("asked you directly · firm, 9 of 10")))
        failures.push(`settings-rules: no built-in rule reads its weight: ${JSON.stringify(weights.slice(0, 3))}`);
      if (weights.some((w) => w.includes("(final)") && w.includes(" of 10"))) failures.push("settings-rules: a final rule shows a weight");
      await page.evaluate(`document.querySelector(".builtin-board").open = true`);
    },
    after: async (page) => {
      await page.evaluate(`document.querySelector(".builtin-board").open = false`);
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
        failures.push(`settings-agent: the agent's status rows read ${JSON.stringify(rows)}`);
      const filled = await page.locator("#s-agent .s-status .act.primary", { hasText: "Connect Claude Code" }).isVisible();
      if (!filled) failures.push("settings-agent: no filled Connect Claude Code");
      // The part is the agent's: its name is the first row's choice, Codex listed beside it; its status follows.
      const head = await settingsSays(page);
      if (head !== onPart("Agent")) failures.push(`settings-agent: the head and the sidebar read ${JSON.stringify(head)}`);
      const first = await page.evaluate<{ label: string; options: [string, boolean][]; status: boolean } | null>(`(() => {
        const row = document.querySelector("#s-agent .setting");
        const sel = row?.querySelector("select");
        return row && sel
          ? {
              label: row.querySelector(".s-label")?.textContent.trim() + ": " + sel.selectedOptions[0]?.textContent,
              options: [...sel.options].map((o) => [o.textContent, o.disabled]),
              status: !!row.nextElementSibling?.classList.contains("s-status"),
            }
          : null;
      })()`);
      if (
        first?.label !== "Agent: Claude Code" ||
        JSON.stringify(first.options) !==
          JSON.stringify([
            ["Claude Code", false],
            ["Codex", false],
            ["OpenCode", false],
          ]) ||
        !first.status
      )
        failures.push(`settings-agent: the part starts with ${JSON.stringify(first)}`);
    },
  },
  {
    // Codex chosen: the status row and Connect name it, sorting and reviewing say Codex, your agent stays Claude Code's.
    name: "settings-agent-codex",
    writes: true,
    go: async (page) => {
      await page.evaluate(
        `fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ set: { "agent.harness": "codex" } }) })`,
      );
      await at("#/settings/agent")(page);
      const rows = await statusRows(page, "agent");
      if (rows.join("|") !== "Codex isn't connected to the desk")
        failures.push(`settings-agent-codex: the status rows read ${JSON.stringify(rows)}`);
      if (!(await page.locator("#s-agent .s-status .act.primary", { hasText: "Connect Codex" }).isVisible()))
        failures.push("settings-agent-codex: no filled Connect Codex");
      const said = await page.evaluate<
        Record<string, string>
      >(`(() => Object.fromEntries(["agent.harness", "policy.judge", "agent.coordinator"].map((k) => {
        const r = document.getElementById("row-" + k);
        return [k, (r?.querySelector(".s-label")?.textContent ?? "") + " / " + (r?.querySelector(".s-help")?.textContent ?? "")];
      })))()`);
      const want = {
        "agent.harness": "Agent / Sorts your desk and reviews PRs ahead of time, on your own login.",
        "policy.judge":
          "Sort my desk with Codex / Codex places each item by weighing every rule that matches it; off, the first matching rule does.",
        "agent.coordinator": "Run your agent / A Codex session that answers Ask your agent and gets what you hand off merged.",
      };
      if (JSON.stringify(said) !== JSON.stringify(want)) failures.push(`settings-agent-codex: the rows read ${JSON.stringify(said)}`);
    },
    after: async (page) => {
      await page.evaluate(
        `fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ reset: ["agent.harness"] }) })`,
      );
    },
  },
  {
    // More Agent settings, opened: the decision model's key is a password field whose help says what leaves this computer;
    // saved, it shows dots and the desk never sends the key back, and Reset to default clears it. Shot with one saved.
    name: "settings-agent-more",
    go: async (page) => {
      const KEY = "sk-or-v1-shots-0000000000000000000000000000000000000000000000000000";
      await at("#/settings/agent")(page);
      await page.getByRole("button", { name: "More Agent settings" }).click();
      const key = page.locator('[id="setting-agent.decision_key"]');
      const row = page.locator('[id="row-agent.decision_key"]');
      const seen = await page.evaluate<{ type: string; value: string; hint: string | null; help: string }>(`(() => {
        const r = document.getElementById("row-agent.decision_key"), i = r.querySelector("input");
        return { type: i.type, value: i.value, hint: i.placeholder, help: r.querySelector(".s-help")?.textContent ?? "" };
      })()`);
      if (
        seen.type !== "password" ||
        seen.value !== "" ||
        seen.hint !== "An OpenRouter key" ||
        seen.help !== "Sends OpenRouter each item's title, labels, people, reviewers, state and description's start. Empty: Claude answers."
      )
        failures.push(`settings-agent-more: the key's row reads ${JSON.stringify(seen)}`);
      const model = await page.locator('[id="setting-agent.decision_model"]').inputValue();
      if (model !== "typesafe/jev-1.14") failures.push(`settings-agent-more: the model reads ${JSON.stringify(model)}`);
      // The judge's hourly cap is tuning: folded here, now that Your policy is gone.
      if (!(await page.locator('[id="row-policy.max_per_hour"]').isVisible()))
        failures.push("settings-agent-more: no Let Claude sort up to in More Agent settings");
      if (await page.locator(".s-view-row").filter({ hasText: "Your policy" }).count())
        failures.push("settings-agent-more: a Your policy row is still drawn");
      await key.fill(KEY);
      await key.blur();
      await row.getByText("Saved").waitFor({ timeout: 3000 });
      await page.waitForTimeout(1800); // "Saved" gives way to Reset to default
      const after = await page.evaluate<{ shown: string; api: unknown; onPage: boolean; reset: boolean }>(`(async () => ({
        shown: document.getElementById("setting-agent.decision_key").value,
        api: (await (await fetch("/api/settings")).json()).values["agent.decision_key"],
        onPage: document.documentElement.outerHTML.includes(${JSON.stringify(KEY)}),
        reset: [...document.getElementById("row-agent.decision_key").querySelectorAll("button")].some((b) => b.textContent === "Reset to default"),
      }))()`);
      const dots = "\u2022".repeat(8);
      if (after.shown !== dots || after.api !== dots || after.onPage || !after.reset)
        failures.push(`settings-agent-more: with a key saved the row is ${JSON.stringify(after)}`);
      await page.evaluate(`scrollBy(0, document.querySelector("#s-agent .s-more").getBoundingClientRect().top - 160)`);
      await page.waitForTimeout(200);
    },
    after: async (page) => {
      await page.locator('[id="row-agent.decision_key"]').getByRole("button", { name: "Reset to default" }).click();
      await page.waitForTimeout(300);
      const cleared = await deskHas(page, "agent.decision_key");
      if (cleared !== "") failures.push(`settings-agent-more: Reset to default leaves ${JSON.stringify(cleared)}`);
      await page.getByRole("button", { name: "More Agent settings" }).click();
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
    // Another skill of yours holds skills/inbox: the row says what holds it before Connect is pressed, and nothing to run.
    name: "settings-agent-taken",
    go: async (page) => {
      await page.route("**/api/agents", async (route) => {
        const res = await route.fetch();
        const a = (await res.json()) as AgentStatus;
        const taken = `${a.skill.path} is another skill named inbox, not the desk's: move it, then connect again`;
        Object.assign(a, { skill: { ...a.skill, state: "taken" }, taken, needs: "taken", connect: [] });
        await route.fulfill({ response: res, json: a });
      });
      await at("#/")(page);
      await at("#/settings/agent")(page);
      const rows = await statusRows(page, "agent");
      if (rows.join("|") !== "Claude Code has another skill or server named inbox")
        failures.push(`settings-agent-taken: Claude's status rows read ${JSON.stringify(rows)}`);
      const help = await page.locator("#s-agent .s-status .s-help").first().textContent();
      if (!help?.includes("is another skill named inbox")) failures.push(`settings-agent-taken: its help reads ${JSON.stringify(help)}`);
    },
    after: async (page) => {
      await unroute(page);
      await at("#/")(page);
    },
  },
  {
    // Settings → Urgency: your criteria (the agent's, on), then GitHub's under their heading, each with its switch; who last
    // scored the Inbox, quietly under the sheets.
    name: "settings-criteria",
    go: async (page) => {
      await at("#/settings/criteria")(page);
      const says = await settingsSays(page);
      if (says !== onPart("Urgency")) failures.push(`settings-criteria: the head and the sidebar read ${JSON.stringify(says)}`);
      const rows = await page.locator("#s-criteria .cr-row").count();
      if (rows !== 7) failures.push(`settings-criteria: ${rows} rows, not the mock's one and GitHub's six`);
      if ((await page.locator("#s-criteria .switch:checked").count()) !== rows) failures.push("settings-criteria: a criterion is off");
    },
  },
  {
    // A criterion's editor, under the sheet, open on the agent's.
    name: "settings-criteria-edit",
    go: async (page) => {
      await at("#/settings/criteria")(page);
      await page.locator("#s-criteria .cr-name").first().click();
      await page.waitForTimeout(200);
    },
    after: async (page) => {
      await page.locator("#s-criteria .au-editor").getByRole("button", { name: "Cancel" }).click();
    },
  },
  {
    // Settings' Automations tab, on its own: a row each, its name, when it runs and its last run, Run now and its switch on the
    // sheet's right edge in line with the settings tab's; the agent's draft has a tinted Review instead and no switch; one
    // that runs on events says what it reacts to, and each says what its last run did by verb; New automation last.
    name: "settings-automations",
    go: async (page) => {
      await automationsAs(ranAgo("team-pings", 30))(page);
      await at("#/settings/queue")(page);
      const setting = await page.evaluate<number>(`document.querySelector('[id="setting-notify.enabled"]').getBoundingClientRect().right`);
      await at("#/settings/automations")(page);
      const says = await settingsSays(page);
      if (says !== onPart("Your automations")) failures.push(`settings-automations: the head and the sidebar read ${JSON.stringify(says)}`);
      if (await page.locator("#s-github").isVisible()) failures.push("settings-automations: another part shows on Your automations");
      const [mine, draft, rule, ask, ...more] = await automationRows(page);
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
      if (!rule || !/^When CI changes · ran \d+h ago, snoozed 1$/.test(rule.help) || !rule.run || rule.on !== true)
        failures.push(`settings-automations: the rule's row reads ${JSON.stringify(rule)}`);
      if (
        !ask ||
        !/^Weekdays, every hour · next \S+( \S+)? · ran 30m ago, sorted 1 to Today, sorted 2 to FYI, left 1 where a rule or your pin holds it$/.test(
          ask.help,
        ) ||
        ask.red.length
      )
        failures.push(`settings-automations: the question's row reads ${JSON.stringify(ask)}`);
      if (more.length) failures.push(`settings-automations: ${more.length} more rows than the mock's four`);
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
    after: unsettle,
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
      if (seen.filled.join() !== "Turn on" || seen.buttons.join() !== "Turn on,Edit,Change with your agent")
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
      const tip = /^cd \S+\/\.inbox\/automations && claude --resume [\da-f-]{36}$/;
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
    // A rule's view: no instruction; what starts it, its check and its action in plain words; its run says what it did.
    name: "settings-automations-rule",
    go: async (page) => {
      await at("#/settings/automations")(page);
      await page.locator("#s-automations .s-name", { hasText: "My red CI" }).click();
      await page.locator(".s-view .au-run").first().waitFor();
      await settingsView(page, "settings-automations-rule", "My red CI", "automations", "760px");
      const seen = await automationFacts(page);
      const want = {
        line: "When CI changes · on",
        prompt: null,
        facts: [
          "Only when: me.author && pr.ci == 'red'",
          "Decides: A rule, with no model: snooze until CI passes, saying \u201cCI is red: back when it passes\u201d",
        ],
        buttons: "Run now,Edit,Turn off,Change with your agent",
        runs: ["on an event · snoozed 1"],
        outcomes: ["Snoozed until CI passes"],
      };
      if (JSON.stringify({ ...seen, runs: seen.runs.map((r) => r.replace(/^.*? · /, "")) }) !== JSON.stringify(want))
        failures.push(`settings-automations-rule: the view reads ${JSON.stringify(seen)}`);
    },
    after: at("#/"),
  },
  {
    // A question's view: its instruction, its check, who answers and what it may do; its run by verb, the item a hard rule
    // held saying which. With a decision model's key set, the view names the model that answers instead of Claude.
    name: "settings-automations-ask",
    go: async (page) => {
      const open = async () => {
        await at("#/settings/automations")(page);
        await page.locator("#s-automations .s-name", { hasText: "Team pings" }).click();
        await page.locator(".s-view .au-run").first().waitFor();
      };
      await page.evaluate(
        `fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ set: { "agent.decision_key": "sk-or-v1-shots" } }) })`,
      );
      await page.reload();
      await open();
      const model = (await automationFacts(page)).facts[1];
      if (model !== "Decides: A question: typesafe/jev-1.14 answers, through OpenRouter")
        failures.push(`settings-automations-ask: with a decision model's key it reads ${JSON.stringify(model)}`);
      await page.evaluate(
        `fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ reset: ["agent.decision_key"] }) })`,
      );
      await page.reload();
      await open();
      await settingsView(page, "settings-automations-ask", "Team pings", "automations", "760px");
      const seen = await automationFacts(page);
      const want = {
        prompt: "A ping to my whole team that isn't about the config loader is FYI. One that is, I want today.",
        facts: [
          "Only when: me.requested && !me.requested_direct",
          "Decides: A question: Claude answers, without tools",
          "May: Sort to Today and sort to FYI",
        ],
        buttons: "Run now,Edit,Turn off,Change with your agent",
        outcomes: ["Sorted to FYI", "Sorted to FYI", "Sorted to Today", "Held where it is"],
      };
      const got = { prompt: seen.prompt, facts: seen.facts, buttons: seen.buttons, outcomes: seen.outcomes };
      if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`settings-automations-ask: the view reads ${JSON.stringify(seen)}`);
      if (!seen.line.startsWith("Weekdays, every hour · next "))
        failures.push(`settings-automations-ask: its line reads ${JSON.stringify(seen.line)}`);
      if (!seen.runs[0]?.endsWith("on schedule · sorted 1 to Today, sorted 2 to FYI, left 1 where a rule or your pin holds it"))
        failures.push(`settings-automations-ask: its last run's head reads ${JSON.stringify(seen.runs[0])}`);
      const last = await page.evaluate<string>(`[...document.querySelectorAll(".s-view:not([hidden]) .au-found li")].at(-1).textContent`);
      if (!last.endsWith("a hard rule keeps it in Today or above"))
        failures.push(`settings-automations-ask: the held item reads ${JSON.stringify(last)}`);
    },
    after: at("#/"),
  },
  {
    // A question's editor: what starts it and its schedule, its check, how it decides with who answers, its instruction and
    // what it may do as ticks. Choosing a rule swaps the instruction and the ticks for one action; choosing events swaps
    // the schedule for the kinds to tick. Nothing is saved: Cancel leaves it as it was.
    name: "settings-automations-edit",
    go: async (page) => {
      await at("#/settings/automations/team-pings")(page);
      await page.locator(".s-view .au-view").getByRole("button", { name: "Edit" }).click();
      const form = page.locator(".s-view .au-editor");
      const read = () =>
        page.evaluate<{
          labels: string[];
          selects: string[];
          schedule: string | null;
          when: string;
          ticked: string[];
          boxes: number;
          help: string;
        }>(`(() => {
          const f = document.querySelector(".s-view:not([hidden]) .au-editor");
          return {
            labels: [...f.querySelectorAll(".s-label")].map((l) => l.textContent),
            selects: [...f.querySelectorAll("select")].map((x) => x.selectedOptions[0].textContent),
            schedule: f.querySelector('input[aria-label="Schedule"]')?.value ?? null,
            when: f.querySelector(".au-code").value,
            ticked: [...f.querySelectorAll(".au-check")].filter((l) => l.querySelector("input").checked).map((l) => l.textContent),
            boxes: f.querySelectorAll(".au-check").length,
            help: [...f.querySelectorAll("fieldset .s-help")].map((h) => h.textContent).join(" | "),
          };
        })()`);
      const asked = await read();
      const want = {
        labels: ["Name", "Runs", "Only when", "How it decides", "Instruction", "It may"],
        selects: ["On a schedule", "Ask a model"],
        schedule: "weekdays hourly",
        when: "me.requested && !me.requested_direct",
        ticked: ["Sort to Today", "Sort to FYI"],
        boxes: 8,
      };
      const { help, ...got } = asked;
      if (JSON.stringify(got) !== JSON.stringify(want))
        failures.push(`settings-automations-edit: the editor opens as ${JSON.stringify(asked)}`);
      if (!help.includes("One call reads the items and answers for each, or leaves it as it is. Claude answers, without tools."))
        failures.push(`settings-automations-edit: how it decides says ${JSON.stringify(help)}`);
      // A rule: one action in place of the instruction and the ticks; back to a question, they're as they were.
      await form.getByLabel("How it decides").selectOption({ label: "A rule" });
      const ruled = await read();
      if (
        ruled.labels.join() !== "Name,Runs,Only when,How it decides,Then" ||
        ruled.selects.join() !== "On a schedule,A rule,Sort to FYI" ||
        ruled.boxes
      )
        failures.push(`settings-automations-edit: as a rule it reads ${JSON.stringify(ruled)}`);
      await form.getByLabel("What it does").selectOption({ label: "Snooze" });
      if ((await read()).selects.join() !== "On a schedule,A rule,Snooze,tomorrow")
        failures.push(`settings-automations-edit: a snooze reads ${JSON.stringify((await read()).selects)}`);
      await form.getByLabel("How it decides").selectOption({ label: "Ask a model" });
      // Events: the kinds to tick in place of the schedule; back on a schedule, its words are as they were.
      await form.getByLabel("What starts it").selectOption({ label: "When something happens" });
      const events = await read();
      if (events.schedule !== null || events.boxes !== 17 + 8 || events.ticked.join() !== "Sort to Today,Sort to FYI")
        failures.push(`settings-automations-edit: on events it reads ${JSON.stringify(events)}`);
      if (!(await form.getByRole("button", { name: "Save" }).isDisabled()))
        failures.push("settings-automations-edit: Save is on with no event ticked");
      await form.getByLabel("What starts it").selectOption({ label: "On a schedule" });
      const back = await read();
      if (JSON.stringify({ ...back, help: undefined }) !== JSON.stringify({ ...asked, help: undefined }))
        failures.push(`settings-automations-edit: back as it was, it reads ${JSON.stringify(back)}`);
      // Shot from its check down: how it decides, its instruction, what it may do and its buttons.
      await page.evaluate(`(() => {
        const f = document.querySelector(".s-view:not([hidden]) .au-editor");
        [...f.querySelectorAll(".s-label")].find((l) => l.textContent === "Only when").scrollIntoView({ block: "start" });
        scrollBy(0, -90);
      })()`);
      await page.waitForTimeout(200);
    },
    after: async (page) => {
      await page.locator(".s-view .au-editor").getByRole("button", { name: "Cancel" }).click();
      const kept = await page.evaluate<unknown>(
        `fetch("/api/automations").then((r) => r.json()).then((v) => v.find((a) => a.id === "team-pings").decide)`,
      );
      if (kept !== "ask") failures.push(`settings-automations-edit: Cancel left it deciding by ${JSON.stringify(kept)}`);
      await at("#/")(page);
    },
  },
  {
    // A rule's editor, on events: the kinds ticked, its check, and its action with what a snooze waits for. Saved, the desk has
    // the whole automation as the editor says it, and the view says the new words; shot with the editor open again.
    name: "settings-automations-edit-rule",
    go: async (page) => {
      const was = await page.evaluate<string>(
        `fetch("/api/automations").then((r) => r.json()).then((v) => JSON.stringify(v.find((a) => a.id === "my-red-ci")))`,
      );
      await at("#/settings/automations/my-red-ci")(page);
      const edit = async () => {
        await page.locator(".s-view .au-view").getByRole("button", { name: "Edit" }).click();
        return page.locator(".s-view .au-editor");
      };
      let form = await edit();
      const seen = await page.evaluate<{ labels: string[]; selects: string[]; ticked: string[]; why: string }>(`(() => {
        const f = document.querySelector(".s-view:not([hidden]) .au-editor");
        return {
          labels: [...f.querySelectorAll(".s-label")].map((l) => l.textContent),
          selects: [...f.querySelectorAll("select")].map((x) => x.selectedOptions[0].textContent),
          ticked: [...f.querySelectorAll(".au-check")].filter((l) => l.querySelector("input").checked).map((l) => l.textContent),
          why: f.querySelector('input[aria-label="Why, as the item shows it"]').value,
        };
      })()`);
      const want = {
        labels: ["Name", "Runs", "Only when", "How it decides", "Then"],
        selects: ["When something happens", "A rule", "Snooze", "CI passes"],
        ticked: ["CI changes"],
        why: "CI is red: back when it passes",
      };
      if (JSON.stringify(seen) !== JSON.stringify(want))
        failures.push(`settings-automations-edit-rule: the editor opens as ${JSON.stringify(seen)}`);
      await form.getByLabel("Until").selectOption({ label: "tomorrow" });
      await form.getByLabel("New commits are pushed").check();
      await form.getByRole("button", { name: "Save" }).click();
      await page.locator(".s-view .au-facts").waitFor();
      const saved = await page.evaluate<Record<string, unknown>>(
        `fetch("/api/automations").then((r) => r.json()).then((v) => v.find((a) => a.id === "my-red-ci"))`,
      );
      const kept = [saved.schedule, saved.events, saved.when, saved.decide, saved.rule, saved.can, saved.prompt, saved.on];
      const sent = [
        "",
        ["pushed", "ci"],
        "me.author && pr.ci == 'red'",
        "rule",
        { do: "snooze", until: "tomorrow", why: "CI is red: back when it passes" },
        ["snooze"],
        "",
        true,
      ];
      if (JSON.stringify(kept) !== JSON.stringify(sent))
        failures.push(`settings-automations-edit-rule: saved, the desk has ${JSON.stringify(kept)}`);
      const said = await automationFacts(page);
      if (said.line !== "When new commits are pushed or CI changes · on" || !said.facts[1]?.includes("snooze until tomorrow, saying"))
        failures.push(`settings-automations-edit-rule: saved, the view reads ${JSON.stringify(said)}`);
      // As it was, for the shots after this one.
      await page.evaluate(
        `((a) => fetch("/api/automations/my-red-ci", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(a) }))(${was})`,
      );
      await page.reload();
      await page.locator(".s-view .au-facts").waitFor();
      form = await edit();
      await form.waitFor();
      // Shot from its check down: how it decides, its action and its buttons.
      await page.evaluate(`(() => {
        const f = document.querySelector(".s-view:not([hidden]) .au-editor");
        [...f.querySelectorAll(".s-label")].find((l) => l.textContent === "Only when").scrollIntoView({ block: "start" });
        scrollBy(0, -90);
      })()`);
      await page.waitForTimeout(200);
    },
    after: async (page) => {
      await page.locator(".s-view .au-editor").getByRole("button", { name: "Cancel" }).click();
      await at("#/")(page);
    },
  },
  {
    // Settings' parts are the sidebar's items under the way back to the Inbox; drafts survive a trip between them.
    name: "settings-nav",
    go: async (page) => {
      const hash = () => page.evaluate<string>("location.hash");
      const side = (name: string) => page.locator('.side-nav[aria-label="Settings"] .side-item', { hasText: new RegExp(`^${name}$`) });
      await at("#/settings")(page);
      if ((await settingsSays(page)) !== onPart("Inbox and notifications"))
        failures.push(`settings-nav: #/settings reads ${JSON.stringify(await settingsSays(page))}`);
      const links = await page.evaluate<string[]>(
        `[...document.querySelectorAll('.side-nav[aria-label="Settings"] a')].map((a) => a.getAttribute("href"))`,
      );
      const want = [
        "#/",
        "#/settings/queue",
        "#/settings/agent",
        "#/settings/automations",
        "#/settings/criteria",
        "#/settings/app",
        "#/settings/github",
        "#/settings/sessions",
      ];
      if (links.join() !== want.join()) failures.push(`settings-nav: the sidebar links to ${JSON.stringify(links)}`);
      if (await page.locator(".page-head .head-tabs").count()) failures.push("settings-nav: the page head still has tabs");
      for (const [name, id] of [
        ["Agent", "agent"],
        ["GitHub", "github"],
        ["Your automations", "automations"],
      ] as const) {
        await side(name).click();
        await page.waitForTimeout(300);
        if ((await hash()) !== `#/settings/${id}` || (await settingsSays(page)) !== onPart(name))
          failures.push(`settings-nav: ${name} goes to ${await hash()}, reading ${JSON.stringify(await settingsSays(page))}`);
      }
      // A new one half written, then another part and back.
      await page.locator("#s-automations").getByRole("button", { name: "New automation" }).click();
      await page.locator("#s-automations .au-editor input").first().fill("Half written");
      await side("Agent").click();
      await page.waitForTimeout(300);
      if (await page.locator("#s-automations").isVisible()) failures.push("settings-nav: Your automations shows on Agent");
      await side("Your automations").click();
      await page.waitForTimeout(300);
      const kept = await page
        .locator("#s-automations .au-editor input")
        .first()
        .inputValue({ timeout: 2000 })
        .catch(() => null);
      if (kept !== "Half written")
        failures.push(`settings-nav: back on Your automations, the new one's name reads ${JSON.stringify(kept)}`);
      await page.locator("#s-automations .au-editor").getByRole("button", { name: "Cancel" }).click();
      // An edit in a view, then the footer's Settings, and its name again: the sidebar marks Your automations in its view.
      const name = "Warden and dotagents issues";
      await page.locator("#s-automations .s-name", { hasText: name }).click();
      await page.waitForTimeout(300);
      if ((await sideOn(page)) !== "Your automations") failures.push(`settings-nav: in a view, the sidebar marks ${await sideOn(page)}`);
      await page.locator(".s-view .au-view").getByRole("button", { name: "Edit" }).click();
      await page.locator(".s-view .au-editor input").first().fill("Warden, edited");
      await page.locator(".side-foot .side-item", { hasText: "Settings" }).click();
      await page.waitForTimeout(400);
      if ((await hash()) !== "#/settings") failures.push(`settings-nav: the footer's Settings goes to ${await hash()}`);
      await side("Your automations").click();
      await page.locator("#s-automations .s-name", { hasText: name }).click();
      await page.waitForTimeout(300);
      const edited = await page
        .locator(".s-view .au-editor input")
        .first()
        .inputValue({ timeout: 2000 })
        .catch(() => null);
      if (edited !== "Warden, edited") failures.push(`settings-nav: back in its view, the edit's name reads ${JSON.stringify(edited)}`);
      await page.locator(".s-view .au-editor").getByRole("button", { name: "Cancel" }).click();
      await at("#/settings/automations")(page);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      if ((await hash()) !== "#/") failures.push(`settings-nav: Esc on Your automations goes to ${await hash()}, not the Inbox`);
      await at("#/settings/agent")(page);
      await side("Inbox").click();
      await page.waitForTimeout(300);
      if ((await hash()) !== "#/") failures.push(`settings-nav: the sidebar's Inbox goes to ${await hash()}`);
      await at("#/settings/app")(page);
    },
    after: at("#/"),
  },
  {
    // What GitHub comes with, on its part under its settings: a switch and one line each; one opens as a view you can only
    // switch or copy, and a copy is yours, off, in Your automations.
    name: "settings-github-automations",
    writes: true,
    go: async (page) => {
      await automationsAs(ranAgo("github.pick-reviewer", 42))(page);
      await at("#/settings/github")(page);
      const rows = await page.evaluate<string[]>(`[...document.querySelectorAll("#s-github .au-row")].map((r) =>
        r.querySelector(".s-name").textContent.trim() + " " + (r.querySelector("input.switch").checked ? "on" : "off"))`);
      const want = [
        "Pick a reviewer on",
        "Follow up on silent reviewers on",
        "Team reviews someone else took on",
        "Wide team pings on",
        "Snooze while CI is red off",
        "Questions in mentions off",
      ];
      if (rows.join() !== want.join()) failures.push(`settings-github-automations: GitHub's automations read ${JSON.stringify(rows)}`);
      const help = await page.locator("#s-github .au-row .s-help").first().textContent();
      if (
        !help?.startsWith("Your ready PR waited a workday with nobody asked by name") ||
        !help.endsWith("ran 42m ago, put 1 on your desk")
      )
        failures.push(`settings-github-automations: Pick a reviewer's line reads ${JSON.stringify(help)}`);
      if (await page.locator("#s-github .au-row", { hasText: "Pick a reviewer" }).locator(".s-help .t-bad").count())
        failures.push("settings-github-automations: a red word on Pick a reviewer");
      await page.locator("#s-github .s-name", { hasText: "Pick a reviewer" }).click();
      await page.waitForTimeout(300);
      await page.locator(".s-view .au-view").getByRole("button", { name: "Copy to your automations" }).click();
      await page.waitForTimeout(500);
      const copied = await page.evaluate<string>("location.hash");
      if (copied !== "#/settings/automations/pick-a-reviewer") failures.push(`settings-github-automations: Copy goes to ${copied}`);
      await settingsView(page, "settings-github-automations (copy)", "Pick a reviewer", "automations", "760px");
      if (!(await page.locator(".s-view .au-view").getByRole("button", { name: "Edit" }).count()))
        failures.push("settings-github-automations: the copy has no Edit");
      if ((await page.locator(".s-view .au-view").getByRole("button", { name: "Turn on" }).count()) !== 1)
        failures.push("settings-github-automations: the copy isn't off");
      // The mock keeps it: gone again, so the next size and Your automations' shots start from the mock's four.
      await page.evaluate(`fetch("/api/automations/${copied.split("/").pop()}", { method: "DELETE" })`);
      // The shot: the built-in one's own view, its way back GitHub, Copy where Edit would be.
      await at("#/settings/automations/github.pick-reviewer")(page);
      await settingsView(page, "settings-github-automations", "Pick a reviewer", "github", "760px");
      if (await page.locator(".s-view .au-view").getByRole("button", { name: "Edit" }).count())
        failures.push("settings-github-automations: a built-in one has Edit");
      if ((await sideOn(page)) !== "GitHub")
        failures.push(`settings-github-automations: in its view, the sidebar marks ${await sideOn(page)}`);
    },
    after: async (page) => {
      await unsettle(page);
      await at("#/settings/github")(page);
    },
  },
  {
    // On Settings the sidebar marks Settings, none of the pages, and the page head names it; in a browser This device has no
    // rows, only a line saying they're the app's (the mac size has the app's bridge: settings-app-desktop).
    name: "settings-app",
    go: async (page) => {
      await at("#/settings/app")(page);
      const rows = await page.evaluate<string[]>(
        `[...document.querySelectorAll("#s-app .setting")].map((r) => r.id || r.querySelector(".input")?.id)`,
      );
      if (!(await page.evaluate<boolean>("!!window.desktop")) && (rows.length || !(await page.locator("#s-app .quiet-note").count())))
        failures.push(`settings-app: This device in a browser has ${JSON.stringify(rows)}, not the line saying they're the app's`);
      const on = await sideOn(page);
      if (on !== "This device") failures.push(`settings-app: the sidebar marks ${JSON.stringify(on)}`);
      const says = await settingsSays(page);
      if (says !== onPart("This device")) failures.push(`settings-app: the head and the sidebar read ${JSON.stringify(says)}`);
      if (await page.locator(".page-head a.back").count()) failures.push("settings-app: the page head is a way back");
      if (await page.locator("#s-automations").isVisible()) failures.push("settings-app: Your automations shows on This device");
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
      const field = await page.locator('[id="setting-app.hotkey"]').inputValue();
      if (field !== "Control+Option+D") failures.push(`settings-app-desktop: the shortcut's field reads ${JSON.stringify(field)}`);
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
    // Use it from your other devices, on: where it serves and for whom under it, then each paired device with Revoke, which
    // takes it off at once; off, the address goes and the devices stay listed.
    name: "settings-app-remote",
    sizes: ["mac"],
    writes: true,
    go: async (page) => {
      await page.evaluate(`fetch("/api/mock/devices", { method: "POST" })`); // used 40 minutes ago as of now
      await at("#/settings/app")(page);
      const row = page.locator('[id="row-app.tailscale"]');
      if (!(await row.isVisible())) failures.push("settings-app-remote: no Use it from your other devices row");
      await row.locator("input.switch").check();
      const where = page.locator(".s-status", { hasText: "At https://desk.tail1234.ts.net" });
      await where.waitFor({ timeout: 5000 }).catch(() => {});
      if (!(await where.isVisible())) failures.push("settings-app-remote: no line saying where it serves");
      else if (!(await where.textContent())?.includes("you@example.com's devices"))
        failures.push(`settings-app-remote: the line reads ${JSON.stringify(await where.textContent())}`);
      const devices = await page.locator(".s-status", { has: page.getByRole("button", { name: "Revoke" }) }).allTextContents();
      if (devices.length !== 2 || !devices[0]!.includes("Browser on iPhone") || !devices[0]!.includes("last used 40m ago"))
        failures.push(`settings-app-remote: the devices read ${JSON.stringify(devices)}`);
      await page.evaluate(`document.getElementById("row-app.tailscale").scrollIntoView({ block: "center" })`);
    },
    after: async (page) => {
      const laptop = page.locator(".s-status", { hasText: "work-laptop" });
      await laptop.getByRole("button", { name: "Revoke" }).click();
      await laptop.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
      if (await laptop.count()) failures.push("settings-app-remote: Revoke left the device");
      await page.locator('[id="row-app.tailscale"] input.switch').uncheck();
      const where = page.locator(".s-status", { hasText: "At https://" });
      await where.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
      if (await where.count()) failures.push("settings-app-remote: off, it still says where it serves");
      await page.evaluate(`fetch("/api/mock/devices", { method: "POST" })`);
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
      // In the Mac's words, as the field has it.
      const says = await hotkeySays(page, "Couldn't use Control+Option+D: another app has this shortcut.");
      const red = await page.evaluate<boolean>(`!!document.querySelector('[id="row-app.hotkey"] .s-help.t-bad')`);
      if (says !== "Couldn't use Control+Option+D: another app has this shortcut." || !red)
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
        ["review", "github"],
        ["handoff", "github"],
      ]) {
        await at(`#/settings/${old}`)(page);
        const seen = await page.evaluate<boolean>(`(() => {
          const shown = [...document.querySelectorAll(".s-part")].filter((p) => p.getClientRects().length).map((p) => p.id);
          return shown.join() === "s-${part}" && scrollY === 0;
        })()`);
        if (!seen) failures.push(`settings-aliases: #/settings/${old} doesn't land on ${part}`);
      }
    },
  },
  {
    // A part's end, with More closed: This device, the last of the core's.
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
      // The login lapsed, which stops the sorting too: said once, in Claude's part, and not again under the sorting's switch.
      const said = await page.evaluate<number>(
        `[...document.querySelectorAll(".settings .s-help")].filter((el) => el.textContent.includes("isn't logged in")).length`,
      );
      if (said !== 1) failures.push(`settings-agent-paused: Settings says Claude Code isn't logged in ${said} times`);
      const rows = await statusRows(page, "agent");
      if (rows.filter((r) => r === "Claude is paused").length !== 1)
        failures.push(`settings-agent-paused: Claude's status rows read ${JSON.stringify(rows)}`);
      const ink = await page.evaluate<boolean>(`(() => {
        const row = [...document.querySelectorAll("#s-agent .s-status")].find((r) => r.querySelector(".s-label")?.textContent === "Claude is paused");
        const help = row && getComputedStyle(row.querySelector(".s-help")).color;
        return !!help && help === getComputedStyle(row.querySelector(".s-label")).color;
      })()`);
      if (!ink) failures.push("settings-agent-paused: the pause's words aren't in ink");
    },
    after: pauseAi(false),
  },
  {
    // Snoozed or muted, in the Archive, with until when: its heading opens it.
    name: "cleared",
    go: async (page) => {
      await at("#/archive")(page);
      await page.locator(".g-cleared .group-toggle").click();
      await page.waitForTimeout(300);
      await page.locator(".g-cleared").scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
    },
  },
  // The More menu in a review.
  {
    // Done and Copy link, then Close and Request changes under "On GitHub".
    name: "more-review",
    go: async (page) => {
      await review("acme/worker#875", [MORE])(page);
      const back = (await page.locator(".page-head .back").textContent())?.trim();
      if (back !== "Inbox") failures.push(`more-review: the review's way back reads ${JSON.stringify(back)}`);
      const items = await moreItems(page);
      const head = items.indexOf("#On GitHub");
      if (items[0] !== "Done" || items[1] !== "Copy link" || (head >= 0 && (head !== 2 || head === items.length - 1)))
        failures.push(`more-review: the More menu reads ${JSON.stringify(items)}`);
    },
  },
  {
    // Copy link in a review's More: the PR's inbox:// link on the clipboard (stubbed, never yours), and a quiet toast.
    name: "more-copy-link",
    go: async (page) => {
      await review("acme/worker#875", [MORE])(page);
      await page.evaluate(`navigator.clipboard.writeText = async (t) => { window.__copied = t; }`);
      await page.locator(".more-pop .pop-item", { hasText: "Copy link" }).click();
      await page.locator(".toast").waitFor();
      const said = [await page.evaluate<unknown>("window.__copied"), await page.locator(".toast").textContent()];
      if (said[0] !== "inbox://item/acme/worker/875" || said[1] !== "Copied the link to worker#875")
        failures.push(`more-copy-link: copied and said ${JSON.stringify(said)}`);
      await page.waitForTimeout(300); // the toast in, not fading in
    },
    after: fresh, // its toast gone, so the next shot doesn't show it
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
    // The sidebar after use: Blocked opened from it, then a Settings page. Only the page you're on gets the pill.
    name: "sidebar-used",
    go: async (page) => {
      await at("#/")(page);
      const side = await sidePages(page);
      if (side !== "Inbox Blocked | Merging Archive") failures.push(`sidebar-used: the sidebar reads ${side}`);
      await page.locator(".side-item", { hasText: "Blocked" }).click();
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
    // Settings' controls in the theme's colours, on the Agent part: its select, the filled Connect, a switch on and one off.
    {
      name: `theme-${id}-settings`,
      go: async (page) => {
        await settingsAs((v) => {
          v.values["agent.coordinator_bypass"] = false;
        })(page);
        await pickTheme(id)(page);
        await at("#/settings/agent")(page);
        await page.locator("#s-agent .s-status .act.primary").waitFor();
        const seen = await page.evaluate<{ on: boolean; off: boolean; select: boolean }>(`(() => {
          const shown = (el) => { const r = el?.getBoundingClientRect(); return !!r && r.top >= 52 && r.bottom <= innerHeight; };
          return {
            on: [...document.querySelectorAll(".settings .switch")].some((s) => s.checked && shown(s)),
            off: [...document.querySelectorAll(".settings .switch")].some((s) => !s.checked && shown(s)),
            select: [...document.querySelectorAll(".settings select")].some(shown),
          };
        })()`);
        if (!seen.on || !seen.off || !seen.select) failures.push(`theme-${id}-settings: on screen ${JSON.stringify(seen)}`);
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
    // Omarchy switching from a dark theme to a light one with a review open: the diff's code takes the light colours at
    // once, as the sheet does, rather than at the window's next tick.
    name: "theme-omarchy-review-switch",
    go: async (page) => {
      await omarchyAs(HACKERMAN)(page);
      await review("acme/api#4127")(page);
      const token = () =>
        page.evaluate<string | null>(`(() => {
          const s = [...(document.querySelector(".rv-diff")?.shadowRoot?.querySelectorAll("[data-line] span") ?? [])].find((el) => !el.children.length && el.textContent.trim() === "return");
          return s ? getComputedStyle(s).color : null;
        })()`);
      const dark = await token();
      await page.evaluate(`(async () => (await import("/src/theme.ts")).omarchyIs(${JSON.stringify(LUPINE)}))()`);
      await page.waitForTimeout(400);
      const light = await token();
      if (!dark || dark === light)
        failures.push(`theme-omarchy-review-switch: the diff's keyword stays ${String(light)} on Lupine's sheet`);
    },
    after: leaveOmarchy,
  },
  {
    name: "theme-omarchy-settings",
    go: async (page) => {
      await omarchyAs(HACKERMAN)(page);
      await at("#/settings/appearance")(page);
      const row = await page.evaluate<[string, string]>(
        `[document.getElementById("s-theme").value, document.querySelector("#s-appearance .setting .s-help").textContent]`,
      );
      if (row[0] !== "omarchy" || !row[1].includes("(now Hackerman)"))
        failures.push(`theme-omarchy-settings: the row reads ${JSON.stringify(row)}`);
    },
    after: leaveOmarchy,
    sizes: ["wide"],
  },
  // The More menu open in a review.
  { name: "more-menu", go: review("acme/worker#875", [MORE]) },
  // The platform's keys: ⌘1 to ⌘4 are the sidebar's pages, top to bottom; ⌘] and ⌘[ open the item after and before the
  // open one in its list (the questions, the sessions, then the rows), each as a click on its row would.
  {
    name: "keys",
    go: async (page) => {
      const mod = process.platform === "darwin" ? "Meta" : "Control";
      const hash = () => page.evaluate<string>("location.hash");
      await at("#/")(page);
      const pages: string[] = [];
      for (const n of [2, 3, 4, 1]) {
        await page.keyboard.press(`${mod}+Digit${n}`);
        await page.waitForTimeout(150);
        pages.push(await hash());
      }
      if (pages.join(" ") !== "#/blocked #/inflight #/archive #/") failures.push(`keys: ${mod}+2,3,4,1 went to ${JSON.stringify(pages)}`);
      // From the Inbox with nothing open: the first item, the next two, then back one.
      const ids = await page.evaluate<string[]>(
        `[...document.querySelectorAll(".queue .line")].slice(0, 4).map((l) => l.dataset.id ?? "q:" + l.querySelector(".row-main")?.textContent?.slice(0, 20))`,
      );
      // A session opens in place on the Inbox, as an issue does: the row open there is where it went.
      const seen: string[] = [];
      for (const key of ["BracketRight", "BracketRight", "BracketRight", "BracketLeft"]) {
        await page.keyboard.press(`${mod}+${key}`);
        await page.waitForTimeout(250);
        const h = decodeURIComponent(await hash());
        seen.push(
          h === "#/"
            ? `#/ open ${await page.evaluate<string | null>(`document.querySelector(".queue .line.open")?.dataset.id ?? null`)}`
            : h,
        );
      }
      const step = (h: string) => (h.startsWith("#/inquiry/") ? "question" : h.replace(/^#\/review\/|^#\/ open /, ""));
      const went = seen.map(step);
      if (went[0] !== "question" || went[1] !== "question" || went[2] !== ids[2] || went[3] !== "question" || seen[3] !== seen[1])
        failures.push(`keys: ${mod}+] x3 then ${mod}+[ went to ${JSON.stringify(seen)}, the list starting ${JSON.stringify(ids)}`);
      // An issue opens in place on its list, so the review before it gives way to the list; Merging steps through its PRs.
      await at("#/")(page);
      const before = await page.evaluate<string | null>(
        `[...document.querySelectorAll(".queue .line")].find((l, i, all) => all[i + 1]?.querySelector(".line-kind")?.textContent === "Issue")?.dataset.id ?? null`,
      );
      await at(`#/review/${encodeURIComponent(before ?? "")}`)(page);
      await page.locator(".rv-diff").first().waitFor({ timeout: 15_000 });
      await page.keyboard.press(`${mod}+BracketRight`);
      await page.waitForTimeout(400);
      const opened = await page.evaluate<string | null>(`document.querySelector(".queue .line.open")?.dataset.id ?? null`);
      if ((await hash()) !== "#/" || !opened)
        failures.push(`keys: ${mod}+] from ${before} is at ${await hash()} with ${opened} open in place`);
      await at("#/inflight")(page);
      await page.keyboard.press(`${mod}+BracketRight`);
      await page.waitForTimeout(250);
      const lane = decodeURIComponent(await hash());
      if (lane !== "#/review/acme/api#4122") failures.push(`keys: ${mod}+] on Merging went to ${lane}`);
      const tip = await page.locator(".side-nav .side-item").nth(1).getAttribute("title");
      if (!tip?.endsWith(process.platform === "darwin" ? "(⌘2)" : "(Ctrl+2)"))
        failures.push(`keys: Blocked's tooltip is ${JSON.stringify(tip)}`);
    },
    after: fresh,
    sizes: ["mac"],
  },
  // Right-click a row: its actions at the pointer, Snooze open to the side with what this PR can wait on.
  {
    name: "row-menu",
    go: async (page) => {
      await at("#/")(page);
      await page.locator(".line", { hasText: "Drop the legacy v1 auth" }).locator(".row-main").click({ button: "right" });
      await page.locator(".ctx-has-sub").hover();
      await page.locator(".ctx-sub").waitFor();
      await page.waitForTimeout(200);
      const items = await page.evaluate<string[][]>(
        `[...document.querySelectorAll(".ctx > .ctx-group")].map((g) => [...g.querySelectorAll(".ctx-item")].filter((b) => !b.closest(".ctx-sub")).map((b) => b.textContent.trim()))`,
      );
      if (
        JSON.stringify(items[0]) !== JSON.stringify(["Done", "Snooze›"]) ||
        JSON.stringify(items.at(-1)) !== JSON.stringify(["Copy link"])
      )
        failures.push(`row-menu: it reads ${JSON.stringify(items)}`);
    },
    after: async (page) => {
      await page.keyboard.press("Escape");
    },
  },
  {
    // Copy link in a row's menu: the item's inbox:// link on the clipboard (stubbed), and a quiet toast.
    name: "row-menu-copy-link",
    go: async (page) => {
      await at("#/")(page);
      await page.evaluate(`navigator.clipboard.writeText = async (t) => { window.__copied = t; }`);
      await rowMenuPick(page, '.line:has-text("Drop the legacy v1 auth")', "Copy link");
      await page.locator(".toast").waitFor();
      const said = [await page.evaluate<unknown>("window.__copied"), await page.locator(".toast").textContent()];
      if (said[0] !== "inbox://item/acme/api/4099" || said[1] !== "Copied the link to api#4099")
        failures.push(`row-menu-copy-link: copied and said ${JSON.stringify(said)}`);
      await page.waitForTimeout(300); // the toast in, not fading in
    },
    after: fresh, // its toast gone, so the next shot doesn't show it
  },
  {
    // Right-click an agent's question: what its page offers, Answer, Copy link and Dismiss. Then each: Copy link copies its
    // inbox:// link (the clipboard stubbed); Dismiss takes its row off the list at once (held, so the mock keeps the
    // question for the next size); Answer opens its page.
    name: "row-menu-question",
    go: async (page) => {
      await at("#/")(page);
      await page.locator(".queue .line.inq .row-main").first().click({ button: "right" });
      await page.waitForTimeout(200);
      const items = await page.evaluate<string[][]>(
        `[...document.querySelectorAll(".ctx > .ctx-group")].map((g) => [...g.querySelectorAll(".ctx-item")].map((b) => b.textContent))`,
      );
      if (JSON.stringify(items) !== JSON.stringify([["Answer", "Copy link"], ["Dismiss"]]))
        failures.push(`row-menu-question: a question's menu reads ${JSON.stringify(items)}`);
    },
    after: async (page) => {
      await page.keyboard.press("Escape");
      // Its entry that reads `item`, from a fresh right-click; false where a question has no menu.
      const pick = async (item: string) => {
        await page.locator(".queue .line.inq .row-main").first().click({ button: "right" });
        const entry = page.locator(".ctx-item", { hasText: item });
        if (!(await entry.count())) return false;
        await entry.click();
        return true;
      };
      await page.evaluate(`navigator.clipboard.writeText = async (t) => { window.__copied = t; }`);
      if (await pick("Copy link")) {
        await page.locator(".toast").waitFor();
        const said = [await page.evaluate<unknown>("window.__copied"), await page.locator(".toast").textContent()];
        if (said[0] !== "inbox://question/q1c0ffee" || said[1] !== "Copied the link to your agent's question")
          failures.push(`row-menu-question: Copy link copied and said ${JSON.stringify(said)}`);
      }
      await page.route("**/api/inquiries/*/answer", () => {});
      const rows = () => page.locator(".queue .line.inq").count();
      const before = await rows();
      if (await pick("Dismiss")) {
        await page.waitForTimeout(200);
        if ((await rows()) !== before - 1)
          failures.push(`row-menu-question: after Dismiss, ${await rows()} of ${before} questions are listed`);
      }
      // The reload drops the held write first: unrouting while it's held would let it through to the mock.
      await fresh(page);
      await unroute(page);
      if (await pick("Answer")) {
        await page.waitForTimeout(200);
        const hash = await page.evaluate<string>("location.hash");
        if (hash !== "#/inquiry/q1c0ffee") failures.push(`row-menu-question: Answer went to ${hash}`);
      }
      await fresh(page);
    },
  },
  {
    // A permalink to a PR (the desktop app routes inbox://item/… to #/item/…): its review, the link gone from the history.
    name: "link-pr",
    go: async (page) => {
      await at("#/blocked")(page);
      await at(`#/item/${encodeURIComponent("acme/api#4127")}`)(page);
      await page.locator(".rv-diff").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(600);
      const hash = await page.evaluate<string>("location.hash");
      if (hash !== `#/review/${encodeURIComponent("acme/api#4127")}`) failures.push(`link-pr: the link went to ${hash}`);
    },
    after: async (page) => {
      await page.goBack();
      await page.waitForTimeout(300);
      const back = await page.evaluate<string>("location.hash");
      if (back !== "#/blocked") failures.push(`link-pr: Back from it goes to ${back}`);
    },
  },
  {
    // A permalink to an issue: on the page that lists it, past the queue's fold, opened in place and in view.
    name: "link-issue",
    go: async (page) => {
      await at("#/blocked")(page);
      await at(`#/item/${encodeURIComponent("acme/worker#860")}`)(page);
      await page.waitForTimeout(600);
      const seen = await page.evaluate<{ hash: string; open: string | null; inView: boolean }>(`(() => {
        const row = document.querySelector(".line.open");
        const r = row?.getBoundingClientRect();
        return { hash: location.hash, open: row?.dataset.id ?? null, inView: !!r && r.top >= 0 && r.top < innerHeight };
      })()`);
      if (seen.hash !== "#/" || seen.open !== "acme/worker#860" || !seen.inView)
        failures.push(`link-issue: the link opened ${JSON.stringify(seen)}`);
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
      // The review shots read Traditional; the review-guided ones start from the default.
      await page.addInitScript(`localStorage.getItem("desk.review.view") ?? localStorage.setItem("desk.review.view", "traditional")`);
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
      await offline(page);
      // A review document's frame runs no script, so the stand-ins above, which Playwright puts in every frame, are refused there.
      const docFrame = (m: string) => m.startsWith("Blocked script execution in") && m.includes("/api/docs/");
      page.on("console", (m) => {
        const from = m.location().url;
        if (
          m.type() === "error" &&
          !from.startsWith("https://avatars.githubusercontent.com/") &&
          !docFrame(m.text()) &&
          ![...refusing].some((r) => from.includes(r))
        )
          failures.push(`${theme}/${size.name}: console error: ${m.text()}`);
      });
      await page.goto(`${url}/#/`);
      await page.locator(READY).first().waitFor({ timeout: 15_000 });
      for (const shot of shots) {
        if (shot.sizes ? !shot.sizes.includes(size.name) : size.asked) continue;
        await page.keyboard.press("Escape");
        await shot.go(page);
        await page.mouse.move(0, 0); // no hover state left over from a click
        const file = `${theme}-${size.name}-${shot.name}.png`;
        // The pictures on screen have loaded, or gone for good: none is a broken box.
        const box = (await page.waitForFunction(AVATARS_DRAWN, undefined, { timeout: 3000 }).catch(() => null)) === null;
        if (box) failures.push(`${file}: a person's picture on screen hasn't loaded`);
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
        if (wraps) failures.push(`${file}: the sidebar's "Inbox" wraps`);
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
    `<!doctype html><meta charset="utf-8"><title>Inbox shots</title><style>body{font:13px system-ui;margin:24px;display:grid;grid-template-columns:repeat(auto-fill,minmax(480px,1fr));gap:24px}img{width:100%;border:1px solid #ccc}figure{margin:0}</style>${sheet}`,
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
