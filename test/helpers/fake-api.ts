// A tiny node:http stand-in for the desk API, with canned data. Sets DESK_PORT for the client.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { checkSetting, DEFAULTS, SECTIONS, SETTINGS } from "../../src/settings.ts";
import type {
  Bucket,
  BoardSummary,
  BoardView,
  Card,
  ConfigError,
  FocusView,
  ItemDetail,
  ItemState,
  Overview,
  QueueView,
  SettingsView,
  SettingValue,
} from "../../src/types.ts";

const NOW = Date.now();
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();

export function card(id: string, bucket: Bucket, title: string, why: string, extra: Partial<Card> = {}): Card {
  const [repo = "", n] = id.split("#");
  return {
    id,
    kind: "pr",
    repo,
    number: Number(n),
    title,
    url: `https://github.com/${repo}/pull/${n}`,
    author: "octo",
    author_bot: false,
    bucket,
    why,
    board: "reviews",
    boards: ["reviews"],
    chips: ["+120 −30"],
    ci: "green",
    review: "required",
    draft: false,
    size: 150,
    created_at: ago(48),
    updated_at: ago(2),
    activity_at: ago(2),
    waiting_since: ago(30),
    new: false,
    pinned: false,
    status: "active",
    snooze_until: null,
    verdict: null,
    ...extra,
  };
}

export const CARDS = {
  now: card("getsentry/seer#8949", "now", "Flag provider client calls in unchecked paths", "octo asked you · 6d", {
    new: true,
    chips: ["CI red", "+120 −30"],
    ci: "red",
  }),
  today: card("getsentry/sentry#101", "today", "Fix the flaky snuba test that only fails on Tuesdays", "your team was asked · 1d"),
  later: card("getsentry/sentry#202", "later", "Bump some dependency", "team ask, not close"),
  fyi: card("acme/widgets#7", "fyi", "Widget docs", "you're mentioned"),
  hidden: card("getsentry/sentry#303", "hide", "Bot PR", "bot author"),
  cleared: card("getsentry/sentry#404", "today", "Already handled", "done", { status: "done" }),
  hostile: card("acme/widgets#66", "today", "Hi\x1b]52;c;cm0gLXJmIH4=\x07\rthere", "x"),
};

const summary: BoardSummary = {
  id: "reviews",
  name: "PRs to review",
  space: "work",
  counts: { now: 1, today: 1, later: 1, fyi: 1, hide: 1, cleared: 1 },
  new: 1,
};

const overview: Overview = {
  me: "you",
  synced_at: ago(0.05),
  syncing: false,
  sync_error: null,
  config_errors: [],
  spaces: [{ id: "work", name: "Work", boards: [summary] }],
  focus: { now: 1, today: 1, new: 1 },
  rate_limit: { remaining: 4800, reset_at: ago(-1) },
};

const focus: FocusView = { sections: { now: [CARDS.now], today: [CARDS.today] } };

const queueView: QueueView = {
  sections: { now: [CARDS.now], today: [CARDS.today], later: [CARDS.later], fyi: [CARDS.fyi] },
  hidden: [CARDS.hidden],
  cleared: [CARDS.cleared],
};

const boardView: BoardView = {
  board: { ...summary, queries: ["is:open is:pr review-requested:@me"] },
  sections: { now: [CARDS.now], today: [CARDS.today], later: [CARDS.later], fyi: [CARDS.fyi] },
  hidden: [CARDS.hidden],
  cleared: [CARDS.cleared],
};

function state(id: string, patch: Partial<ItemState> = {}): ItemState {
  return { id, done_at: null, snooze_until: null, snooze_on_activity: false, muted: false, pinned: false, seen_at: null, ...patch };
}

function detail(c: Card): ItemDetail {
  return {
    card: c,
    item: {} as ItemDetail["item"],
    signals: {} as ItemDetail["signals"],
    placements: [
      {
        board: "reviews",
        bucket: c.bucket,
        rule_bucket: c.bucket,
        rule: 1,
        why: c.why,
        trace: [
          { index: -1, when: "!author.bot", matched: true },
          { index: 0, when: "pr.ci == 'red' && me.author", matched: false },
          { index: 1, when: "me.requested_direct", matched: true },
        ],
      },
    ],
    state: state(c.id),
    handoff_prompt: `Review ${c.url}\nTitle: ${c.title}`,
    ai: null,
    ai_stale: false,
    generating: false,
  };
}

const ALL = Object.values(CARDS);

function resolve(ref: string): { status: number; body: unknown } {
  if (ref === "sentry#1")
    return { status: 409, body: { error: "ambiguous ref sentry#1", candidates: ["getsentry/sentry#1", "other/sentry#1"] } };
  const c = ALL.find((x) => x.id === ref || x.id.endsWith("/" + ref));
  return c ? { status: 200, body: detail(c) } : { status: 404, body: { error: `unknown item ${ref}` } };
}

export interface FakeApi {
  port: number;
  calls: { method: string; path: string; body: any }[];
  configPath: string;
  settings: Record<string, SettingValue>; // overrides, as in settings.json
  close(): Promise<void>;
}

// Real defs and validation, so CLI tests exercise the actual schema.
function settingsView(overrides: Record<string, SettingValue>): SettingsView {
  return {
    path: "/home/you/.review-desk/settings.json",
    sections: SECTIONS,
    defs: [...SETTINGS],
    values: { ...DEFAULTS, ...overrides },
    overridden: Object.keys(overrides),
    errors: [],
    github: { login: "you", auth: "gh CLI", error: null, synced_at: ago(0.05), rate_limit: null, teams: [], orgs: [] },
  };
}

function putSettings(api: FakeApi, body: { set?: Record<string, SettingValue>; reset?: string[] }) {
  const errors: ConfigError[] = [];
  for (const [k, v] of Object.entries(body.set ?? {})) {
    const e = checkSetting(k, v);
    if (e) errors.push({ path: k, message: e });
  }
  for (const k of body.reset ?? []) if (!(k in DEFAULTS)) errors.push({ path: k, message: `unknown setting "${k}"` });
  if (!errors.length) {
    for (const [k, v] of Object.entries(body.set ?? {})) {
      if (JSON.stringify(v) === JSON.stringify(DEFAULTS[k as keyof typeof DEFAULTS])) delete api.settings[k];
      else api.settings[k] = v;
    }
    for (const k of body.reset ?? []) delete api.settings[k];
  }
  return { ok: !errors.length, errors, settings: settingsView(api.settings) };
}

type Reply = { status: number; data: unknown };
const reply = (status: number, data: unknown): Reply => ({ status, data });

function route(api: FakeApi, method: string | undefined, url: URL, body: any): Reply {
  switch (`${method} ${url.pathname}`) {
    case "GET /health":
      return reply(200, { ok: true, version: "0.1.0" });
    case "GET /api/overview":
      return reply(200, overview);
    case "GET /api/focus":
      return reply(200, focus);
    case "GET /api/queue":
      return reply(200, queueView);
    case "GET /api/boards/reviews":
      return reply(200, boardView);
    case "GET /api/item": {
      const r = resolve(url.searchParams.get("id")!);
      return reply(r.status, r.body);
    }
    case "POST /api/act": {
      const r = resolve(body.id);
      if (r.status !== 200) return reply(r.status, r.body);
      const id = (r.body as ItemDetail).card.id;
      const patch: Partial<ItemState> =
        // Mirrors desk.ts: "activity" is done-until-activity; timed snoozes also wake on activity.
        body.action === "snooze"
          ? body.until === "activity"
            ? { done_at: new Date().toISOString() }
            : { snooze_until: "2026-10-28T09:00:00.000Z", snooze_on_activity: true }
          : body.action === "done"
            ? { done_at: new Date().toISOString() }
            : body.action === "mute"
              ? { muted: true }
              : body.action === "pin"
                ? { pinned: true }
                : {};
      return reply(200, { ok: true, state: state(id, patch), undo_seq: 7 });
    }
    case "POST /api/undo":
      return reply(200, { ok: true, id: CARDS.now.id, action: "done" });
    case "POST /api/sync":
      return reply(200, { ok: true });
    case "GET /api/config":
      return reply(200, { path: api.configPath, text: "poll_seconds = 60\n", errors: [] });
    case "POST /api/config/preview":
      return reply(200, {
        errors: body.text.includes("INVALID") ? [{ path: "boards[0].rules[0].when", message: "unknown field me.nope" }] : [],
        boards: [],
      });
    case "PUT /api/config":
      return reply(200, { ok: true, errors: [] });
    case "GET /api/fields":
      return reply(200, [{ path: "me.requested_direct", type: "boolean", doc: "asked by name" }]);
    case "GET /api/settings":
      return reply(200, settingsView(api.settings));
    case "PUT /api/settings":
      return reply(200, putSettings(api, body));
    case "GET /api/status":
      return reply(200, { now: 1, today: 1, new: 1, text: "desk ●1 ◐1 +1" });
  }
  if (url.pathname.startsWith("/api/boards/")) return reply(404, { error: `unknown board ${decodeURIComponent(url.pathname.slice(12))}` });
  return reply(404, { error: "not found" });
}

async function respond(api: FakeApi, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let r: Reply;
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url!, "http://x");
    api.calls.push({ method: req.method!, path: url.pathname + url.search, body });
    r = route(api, req.method, url, body);
  } catch (e) {
    r = reply(500, { error: String(e) }); // a bug in the fake fails the test instead of crashing the run
  }
  res.writeHead(r.status, { "content-type": "application/json" });
  res.end(JSON.stringify(r.data));
}

export async function startFakeApi(opts: { configPath?: string } = {}): Promise<FakeApi> {
  const api: FakeApi = {
    port: 0,
    calls: [],
    configPath: opts.configPath ?? "/nonexistent/config.toml",
    settings: { "github.poll_seconds": 120 },
    close: async () => {},
  };
  const server = createServer((req, res) => {
    void respond(api, req, res);
  });
  await new Promise<void>((r) => {
    server.listen(0, "127.0.0.1", r);
  });
  api.port = (server.address() as AddressInfo).port;
  process.env.DESK_PORT = String(api.port);
  api.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => {
        r();
      });
    });
  return api;
}

// A port with nothing listening on it.
export async function unusedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => {
    s.listen(0, "127.0.0.1", r);
  });
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => {
    s.close(() => {
      r();
    });
  });
  return port;
}
