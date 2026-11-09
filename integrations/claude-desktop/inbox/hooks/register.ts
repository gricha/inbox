// Plain calls, not JSX: Node runs this file as it is for its test, integrations/claude-desktop/pane.test.ts (npm test).
import type { EngineInterface, HttpResponse, Register, RenderChildren } from "claude-code";

const PANE = "inbox";
const API = "http://localhost:47823";
const JSON_BODY = { "content-type": "application/json" };
// A row's call to action, in the desk's words.
const CTA = { ready: "Ready for review", reply: "Reply", reviewers: "Add reviewers" };
// The main page's parts, in its order (docs/api.md, Card.group).
const PARTS = ["back", "review", "other", "mine"];

// What the pane reads of GET /api/queue (docs/api.md).
type Card = {
  id: string;
  kind: "pr" | "issue";
  repo: string;
  number: number;
  title: string;
  by: string;
  stage?: string;
  cta?: keyof typeof CTA;
  handed_back?: boolean;
  group?: string;
  waiting_since: string;
};
type Queue = { inquiries: { id: string; at: string; from: string; question: string }[]; sections: { now: Card[]; today: Card[] } };

// A row as drawn: what it is, its title, where a click goes (the Inbox app's link, and the desk's own page) and the rest of its line.
type Row = { id: string | null; kind: string; title: string; app: string; web: string; meta: string };
type View = { rows: Row[]; status: string; error: string | null };

// The desk's last answer. It's refetched every minute and after a reload, so it needs no $.state; until the first answer it claims nothing.
let view: View = { rows: [], status: "Reading the desk…", error: null };

// GitHub's and agents' text is untrusted, and Claude Code refuses to draw a pane with a control character in it.
const oneLine = (s: string) => s.replaceAll(/[\p{Cc}\u2028\u2029]+/gu, " ").trim();

// "12m", "5h", "3d", as the desk's rows say it.
function age(at: string, now: number): string {
  const m = Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(m / 1440)}d`;
}

// The Inbox as one list: agents' questions, then now's and today's cards by part, as the desk's window orders them. Each link is src/links.ts's.
function rows(q: Queue, now: number): Row[] {
  const asked = q.inquiries.map((a) => ({
    id: null,
    kind: "Question",
    title: oneLine(a.question),
    app: `inbox://question/${a.id}`,
    web: `${API}/#/inquiry/${a.id}`,
    meta: `by ${oneLine(a.from)} · Answer · ${age(a.at, now)}`,
  }));
  const part = (c: Card) => PARTS.indexOf(c.group ?? "other");
  const cards = [...q.sections.now, ...q.sections.today]
    .sort((a, b) => part(a) - part(b))
    .map((c) => ({
      id: c.id,
      kind: c.kind === "pr" ? "PR" : "Issue",
      title: oneLine(c.title),
      app: `inbox://item/${c.repo}/${c.number}`,
      web: `${API}/#/item/${encodeURIComponent(c.id)}`,
      meta: [
        `${c.repo.split("/")[1]}#${c.number}`,
        `by ${oneLine(c.by)}`,
        c.cta ? CTA[c.cta] : c.handed_back ? "handed back" : c.stage,
        age(c.waiting_since, now),
      ]
        .filter(Boolean)
        .join(" · "),
    }));
  return [...asked, ...cards];
}

// What the desk answered, as the pane draws it; a refusal (503 while it starts) in the desk's own words.
function read(queue: HttpResponse, status: HttpResponse, now: number): View {
  try {
    if (!queue.ok) throw new Error(JSON.parse(queue.text).error ?? `HTTP ${queue.status}`);
    return {
      rows: rows(JSON.parse(queue.text) as Queue, now),
      status: status.ok ? (JSON.parse(status.text).text as string) : "",
      error: null,
    };
  } catch (err) {
    return { rows: [], status: "desk: error", error: oneLine(String((err as Error).message ?? err)) };
  }
}

// Reads the desk and keeps what the pane draws; the status line says what the desk says.
async function refresh($: EngineInterface): Promise<void> {
  view = await Promise.all([$.http.fetch(`${API}/api/queue`), $.http.fetch(`${API}/api/status`), $.clock.now()]).then(
    ([queue, status, now]) => read(queue, status, now),
    () => ({ rows: [], status: "desk offline", error: "desk is not running. Start it with: desk serve" }),
  );
  $.ui.invalidate("ui.render");
  $.ui.status(view.status || undefined);
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "desk", description: "Open Inbox: what needs you" });
    void refresh($);
    $.clock.every(60_000, () => refresh($));
    return next(e);
  });

  on("command.run", { command: "desk" }, async ($) => {
    await refresh($);
    const opened = await $.ui.open({ id: PANE, title: "Inbox" });
    return { text: opened.isPlaced ? "Inbox opened." : `Inbox: ${API}` };
  });

  on("ui.render", { component: "Pane", requestId: PANE }, ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e);
    // One line where there's room: a cell between its parts, which wrap whole in a narrow pane instead of squeezing into columns.
    const line = (children: RenderChildren) => Box({ flexDirection: "row", flexWrap: "wrap", columnGap: 1, children });
    // The desk's own triage, which it takes from any client. A row's call to action (a GitHub write, an answer) it takes only from its window.
    const act = (label: string, body: { id: string; action: string; until?: string }) =>
      Button({
        key: `${body.action}:${body.id}`,
        label,
        plain: true,
        dimColor: true,
        onPress: async () => {
          const sent = $.http.fetch(`${API}/api/act`, { method: "POST", headers: JSON_BODY, body: JSON.stringify(body) });
          // A desk that's gone says so in the read that follows.
          await sent.catch(() => null);
          await refresh($);
        },
      });
    const room = Math.max(1, (e.viewport?.rows ?? 30) - 4);

    return Box({
      flexDirection: "column",
      children: [
        line([
          Text({ bold: true, children: view.status || "Nothing needs you right now." }),
          Button({ key: "refresh", label: "refresh", plain: true, onPress: () => refresh($) }),
          Link({ href: `${API}/`, label: "open desk" }),
        ]),
        view.error && Text({ color: "red", children: view.error }),
        view.rows.slice(0, room).map((r) =>
          line([
            Text({ dimColor: true, children: r.kind }),
            // Desktop and VS Code draw a link as plain text unless it's https: or http://localhost, so there it's the desk's own page.
            Link({ href: e.surface === "terminal" ? r.app : r.web, label: r.title }),
            Text({ dimColor: true, children: r.meta }),
            r.id && [act("done", { id: r.id, action: "done" }), act("tomorrow", { id: r.id, action: "snooze", until: "tomorrow" })],
          ]),
        ),
        view.rows.length > room && Text({ dimColor: true, children: `+${view.rows.length - room} more in the desk` }),
      ],
    });
  });
};
