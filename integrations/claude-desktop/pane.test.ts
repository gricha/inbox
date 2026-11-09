// The /desk pane's hooks, run by a stand-in for Claude Code against a fake desk on a port of its own. Beside the plugin, not
// in it: `claude plugin test` takes every *.test.ts under a plugin for a test of its own kind.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { unusedPort } from "../../test/helpers/fake-api.ts";
import { register } from "./inbox/hooks/register.ts";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

// A card as GET /api/queue gives it, cut to what the pane reads (docs/api.md, Card).
const card = (id: string, title: string, o: object) => {
  const [repo = "", n] = id.split("#");
  return { id, kind: "pr", repo, number: Number(n), title, by: "you", waiting_since: ago(180), ...o };
};

// The main page as the desk answers it: an agent's question, then Now and Today, each by part. One list of it is by part across both.
const QUEUE = {
  inquiries: [
    { id: "8816712d", at: ago(12), from: "seer region fix", question: "Ship the fix behind the flag, or wait for the migration?" },
  ],
  sections: {
    now: [
      card("acme/web#88", "Retry uploads on 503", { group: "back", stage: "approved", handed_back: true, waiting_since: ago(2 * 1440) }),
      card("acme/web#90", "Add a cache to search", { group: "mine", stage: "draft", cta: "ready", waiting_since: ago(1440) }),
    ],
    today: [
      card("acme/api#412", "Fix the login redirect loop", { group: "review", by: "alice", stage: "waiting for review" }),
      card("acme/api#7", "Uploads fail over 2 GB", { group: "other", kind: "issue", by: "carol", waiting_since: ago(300) }),
    ],
    blocked: [],
    later: [card("acme/api#9", "Bump a dependency", { by: "dependabot" })],
    fyi: [],
  },
};

// A desk on a port of its own: the routes the pane asks, and what it was told to do. A card it acted on leaves the queue.
async function fakeDesk(queue = QUEUE) {
  const acts: unknown[] = [];
  const gone = new Set<string>();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const now = queue.sections.now.filter((c) => !gone.has(c.id));
      const today = queue.sections.today.filter((c) => !gone.has(c.id));
      const routes: Record<string, () => unknown> = {
        "GET /api/queue": () => ({ ...queue, sections: { ...queue.sections, now, today } }),
        "GET /api/status": () => ({ text: `desk ${queue.inquiries.length + now.length + today.length} +1` }),
        "POST /api/act": () => {
          const act = JSON.parse(body);
          acts.push(act);
          gone.add(act.id);
          return { ok: true };
        },
      };
      const answer = routes[`${req.method} ${req.url}`];
      res.writeHead(answer ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(answer ? answer() : { error: "not found" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const close = () =>
    new Promise((r) => {
      server.closeAllConnections();
      server.close(r);
    });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, acts, close };
}

type El = { type: string; children?: unknown; [prop: string]: any };

// A stand-in for Claude Code's engine: it runs the pane's hooks and keeps what they register, pin and draw. Its $.http.fetch
// sends what the pane asks of localhost:47823 to `desk` and nothing else, so no test reaches the real desk's port.
function claudeCode(desk: string) {
  const hooks = new Map<string, (...args: any[]) => any>();
  const seen = { command: "", status: undefined as string | undefined };
  let pinned = () => {};
  // session.start reads the desk without holding the session up: its first status line says that read is done.
  const started = new Promise<void>((r) => (pinned = r));
  const el = (type: string) => (props: object) => ({ type, ...props });
  const $ = {
    command: { register: async (c: { name: string }) => void (seen.command = c.name) },
    clock: { now: async () => NOW, every: () => {} },
    http: {
      fetch: async (url: string, init?: RequestInit) => {
        const to = url.replace("http://localhost:47823", desk);
        assert.ok(to.startsWith(desk), `the pane asked ${url}`);
        const r = await fetch(to, init);
        return { ok: r.ok, status: r.status, text: await r.text() };
      },
    },
    ui: {
      invalidate: () => {},
      status: (text?: string) => {
        seen.status = text;
        pinned();
      },
      open: async () => ({ isPlaced: true }),
      resolve: () => ({ Box: el("Box"), Text: el("Text"), Button: el("Button"), Link: el("Link") }),
    },
  };
  register((event: string, a: any, b: any) => hooks.set(event, b ?? a), {});
  const fire = (event: string, e: object = {}) => hooks.get(event)!($, e, async (x: unknown) => x);
  const draw = (surface: string, rows = 30): El =>
    fire("ui.render", { component: "Pane", requestId: "inbox", surface, viewport: { rows } });
  return { seen, started, fire, draw };
}

const kids = (el: El): (El | string)[] => [el.children ?? []].flat(Infinity).filter(Boolean);
const all = (el: El): El[] => [el, ...kids(el).flatMap((kid) => (typeof kid === "string" ? [] : all(kid)))];
// What a drawing says, a line for each row, its parts a gap apart: a link as "its words → where it goes", a button as "[its label]".
const said = (el: El | string): string => {
  if (typeof el === "string") return el;
  const words: string =
    el.label ??
    kids(el)
      .map(said)
      .join(" ".repeat(el.columnGap ?? 0));
  if (el.type === "Link") return `${words} → ${el.href}`;
  return el.type === "Button" ? `[${words}]` : words;
};
const lines = (tree: El) => kids(tree).map(said);

test("the pane lists the Inbox as the desk's window orders it, each row one line that opens in the desk, and done or tomorrow takes a row off", async (t) => {
  const desk = await fakeDesk();
  t.after(desk.close);
  const cc = claudeCode(desk.url);

  await cc.fire("session.start");
  await cc.started;
  assert.deepEqual(cc.seen, { command: "desk", status: "desk 5 +1" }, "the status line says what the desk says, before /desk is typed");
  assert.deepEqual(await cc.fire("command.run", { command: "desk" }), { text: "Inbox opened." });

  assert.deepEqual(lines(cc.draw("terminal")), [
    "desk 5 +1 [refresh] open desk → http://localhost:47823/",
    "Question Ship the fix behind the flag, or wait for the migration? → inbox://question/8816712d by seer region fix · Answer · 12m",
    "PR Retry uploads on 503 → inbox://item/acme/web/88 web#88 · by you · handed back · 2d [done] [tomorrow]",
    "PR Fix the login redirect loop → inbox://item/acme/api/412 api#412 · by alice · waiting for review · 3h [done] [tomorrow]",
    "Issue Uploads fail over 2 GB → inbox://item/acme/api/7 api#7 · by carol · 5h [done] [tomorrow]",
    "PR Add a cache to search → inbox://item/acme/web/90 web#90 · by you · Ready for review · 24h [done] [tomorrow]",
  ]);

  // The Desktop app draws a link as plain text unless it's https: or http://localhost, spelled as new URL() spells it.
  const links = all(cc.draw("desktop")).flatMap((el) => (el.type === "Link" ? [el.href as string] : []));
  assert.deepEqual(links, [
    "http://localhost:47823/",
    "http://localhost:47823/#/inquiry/8816712d",
    "http://localhost:47823/#/item/acme%2Fweb%2388",
    "http://localhost:47823/#/item/acme%2Fapi%23412",
    "http://localhost:47823/#/item/acme%2Fapi%237",
    "http://localhost:47823/#/item/acme%2Fweb%2390",
  ]);
  for (const href of links) assert.equal(new URL(href).href, href);

  const press = (key: string): Promise<void> =>
    all(cc.draw("terminal"))
      .find((el) => el.key === key)!
      .onPress();
  await press("done:acme/api#412");
  await press("snooze:acme/api#7");
  assert.deepEqual(desk.acts, [
    { id: "acme/api#412", action: "done" },
    { id: "acme/api#7", action: "snooze", until: "tomorrow" },
  ]);
  assert.equal(cc.seen.status, "desk 3 +1");
  // Two rows fit: the rest is a count.
  assert.deepEqual(lines(cc.draw("terminal", 6)).slice(1), [
    "Question Ship the fix behind the flag, or wait for the migration? → inbox://question/8816712d by seer region fix · Answer · 12m",
    "PR Retry uploads on 503 → inbox://item/acme/web/88 web#88 · by you · handed back · 2d [done] [tomorrow]",
    "+1 more in the desk",
  ]);
});

test("a stopped desk says how to start it", async () => {
  const cc = claudeCode(`http://127.0.0.1:${await unusedPort()}`);
  await cc.fire("session.start");
  await cc.started;
  assert.equal(cc.seen.status, "desk offline");
  await cc.fire("command.run", { command: "desk" });
  assert.deepEqual(lines(cc.draw("desktop")), [
    "desk offline [refresh] open desk → http://localhost:47823/",
    "desk is not running. Start it with: desk serve",
  ]);
});

test("a title's control characters never reach Claude Code, which refuses to draw a pane that has one", async (t) => {
  const hostile = card("acme/api#66", "Hi\u001b]52;c;cm0gLXJm\u0007\r\nthere", { by: "mallory", stage: "draft" });
  const desk = await fakeDesk({ inquiries: [], sections: { ...QUEUE.sections, now: [hostile], today: [] } });
  t.after(desk.close);
  const cc = claudeCode(desk.url);
  await cc.fire("command.run", { command: "desk" });
  assert.equal(
    lines(cc.draw("terminal"))[1],
    "PR Hi ]52;c;cm0gLXJm there → inbox://item/acme/api/66 api#66 · by mallory · draft · 3h [done] [tomorrow]",
  );
});
