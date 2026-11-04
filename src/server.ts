// HTTP API + web UI on 127.0.0.1.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createClient } from "./client.ts";
import { createGitHub } from "./github/index.ts";
import { createWriter, type GitHubWriter } from "./github/write.ts";
import { Desk, DeskError } from "./desk.ts";
import { createMcpServer } from "./mcp.ts";
import { openUrl } from "./notify.ts";
import { fetchPr, generateReview } from "./review.ts";
import { FIELDS } from "./signals.ts";
import { GITHUB_ACTIONS, type Action, type GitHubAction } from "./types.ts";

const VERSION = "0.1.0";
export const DEFAULT_PORT = 47823;
const DIST = fileURLToPath(new URL("../web/dist/", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

// The desk's own page, for its GitHub writes (approve, a reply, ready for review, the More menu's), hand-offs and asks: a browser marks the request same-origin and sends an Origin, which
// the check below lets through only when it's ours. curl, the CLI and agents send neither unless they forge both.
const fromDesk = (c: { req: { header(name: string): string | undefined } }) =>
  c.req.header("sec-fetch-site") === "same-origin" && !!c.req.header("origin");

export function createApp(desk: Desk, port: number): Hono {
  const app = new Hono();
  const origins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
  // Vite's default ports, or DESK_DEV_PORT when it runs on another.
  if (process.env.DESK_DEV)
    for (const p of [5173, 5174, Number(process.env.DESK_DEV_PORT) || 5173]) {
      origins.add(`http://localhost:${p}`);
      origins.add(`http://127.0.0.1:${p}`);
    }
  // The desktop app running from a checkout serves the UI from its own Vite server, on exactly this origin.
  if (process.env.DESK_UI_ORIGIN) origins.add(process.env.DESK_UI_ORIGIN);

  // Only this machine's browser and tools: blocks DNS rebinding (Host) and cross-site requests (Origin).
  app.use("*", async (c, next) => {
    const host = new URL(c.req.url).hostname;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) throw new DeskError(403, "forbidden host");
    const origin = c.req.header("origin");
    if (origin && !origins.has(origin)) throw new DeskError(403, "forbidden origin");
    // A no-cors GET (an <img> on another site or another localhost port) has no Origin; browsers still say where it came from.
    const site = c.req.header("sec-fetch-site");
    if ((site === "cross-site" || site === "same-site") && (c.req.path.startsWith("/api/") || c.req.path === "/mcp"))
      throw new DeskError(403, "forbidden cross-site request");
    await next();
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", "frame-ancestors 'none'");
  });

  app.onError((e, c) => {
    if (e instanceof DeskError) return c.json({ error: e.message, candidates: e.candidates }, e.status as 400);
    desk.log(`error: ${e.stack ?? e.message}`);
    return c.json({ error: e.message }, 500);
  });

  const ready = () => {
    if (!desk.loaded && !desk.configErrors.length) throw new DeskError(503, "desk is starting; the first sync can take a minute");
  };

  app.get("/health", (c) => c.json({ ok: true, version: VERSION }));
  app.get("/api/overview", (c) => {
    ready();
    return c.json(desk.overview());
  });
  app.get("/api/focus", (c) => {
    ready();
    return c.json(desk.focus());
  });
  app.get("/api/queue", (c) => {
    ready();
    return c.json(desk.queue());
  });
  app.get("/api/boards/:id", (c) => {
    ready();
    return c.json(desk.board(c.req.param("id")));
  });
  app.get("/api/item", (c) => {
    ready();
    const id = c.req.query("id");
    if (!id) throw new DeskError(400, "missing ?id=");
    return c.json(desk.item(id));
  });
  app.post("/api/act", async (c) => {
    ready();
    const body = await c.req.json<{ id?: string; action?: Action; until?: string }>();
    if (!body.id || !body.action) throw new DeskError(400, "need { id, action }");
    return c.json({ ok: true, ...desk.act(body.id, body.action, body.until, fromDesk(c) ? undefined : "agent") });
  });
  // desk_add and `desk add`: a pin plus GitHub reads, so agents may call it.
  app.post("/api/add", async (c) => {
    ready();
    const { id } = await c.req.json<{ id?: unknown }>().catch((): { id?: unknown } => ({}));
    if (typeof id !== "string" || !id) throw new DeskError(400, "need { id }: owner/repo#123 or a GitHub URL");
    return c.json({ ok: true, ...(await desk.add(id)) });
  });
  // Who you can ask to review your PR, as you type: a path of its own, since the review's GET takes any id.
  app.get("/api/reviewers/:id{.+}", async (c) => {
    ready();
    return c.json(await desk.reviewers(c.req.param("id"), c.req.query("q") ?? ""));
  });
  // A PR's id in one path segment (owner%2Frepo%23123), or as owner/repo%23123.
  app.get("/api/review/:id{.+}", async (c) => {
    ready();
    return c.json(await desk.reviewView(c.req.param("id"), c.req.query("ahead") === "1"));
  });
  app.post("/api/review/:id{.+}/ai", async (c) => {
    ready();
    const { force } = await c.req.json<{ force?: boolean }>().catch((): { force?: boolean } => ({}));
    return c.json({ ok: true, ai: await desk.aiReview(c.req.param("id"), force === true) });
  });
  app.post("/api/review/:id{.+}/approve", async (c) => {
    ready();
    if (!fromDesk(c)) throw new DeskError(403, "approve from the PR's review in the desk (a a)");
    const { head_oid, body } = await c.req
      .json<{ head_oid?: unknown; body?: unknown }>()
      .catch((): { head_oid?: unknown; body?: unknown } => ({}));
    if (typeof head_oid !== "string" || !head_oid) throw new DeskError(400, "need { head_oid }: the commit you reviewed");
    if (body !== undefined && typeof body !== "string") throw new DeskError(400, "body must be a string");
    return c.json({ ok: true, ...(await desk.approve(c.req.param("id"), head_oid, body)) });
  });
  // Posts your reply to one of the PR's conversations, from the desk's own window only.
  app.post("/api/review/:id{.+}/reply", async (c) => {
    ready();
    if (!fromDesk(c)) throw new DeskError(403, "replies are sent from the desk's window, by you");
    const b = await c.req.json<{ id?: unknown; body?: unknown }>().catch((): { id?: unknown; body?: unknown } => ({}));
    if (typeof b.id !== "string" || !b.id || typeof b.body !== "string") throw new DeskError(400, "need { id, body }");
    return c.json({ ok: true, ...(await desk.reply(c.req.param("id"), b.id, b.body)) });
  });
  // Your own draft's Ready for review, from the desk's own window only.
  app.post("/api/review/:id{.+}/ready", async (c) => {
    ready();
    if (!fromDesk(c)) throw new DeskError(403, "mark your draft ready for review from the desk's window (a)");
    const b = await c.req.json<{ users?: unknown; teams?: unknown }>().catch((): { users?: unknown; teams?: unknown } => ({}));
    const ids = (v: unknown): string[] | null => {
      if (v === undefined) return [];
      return Array.isArray(v) && v.every((x) => typeof x === "string" && x !== "") ? (v as string[]) : null;
    };
    const users = ids(b.users);
    const teams = ids(b.teams);
    if (!users || !teams) throw new DeskError(400, "users and teams are lists of node ids");
    await desk.markReady(c.req.param("id"), { users, teams });
    return c.json({ ok: true });
  });
  // The More menu's GitHub writes (close, draft, merge, reopen, request changes), from the desk's own window only.
  app.post("/api/github", async (c) => {
    ready();
    if (!fromDesk(c)) throw new DeskError(403, "GitHub actions are yours, from the desk's window (.)");
    const b = await c.req
      .json<{ id?: unknown; action?: unknown; head_oid?: unknown; body?: unknown }>()
      .catch((): { id?: unknown; action?: unknown; head_oid?: unknown; body?: unknown } => ({}));
    if (typeof b.id !== "string" || !GITHUB_ACTIONS.includes(b.action as GitHubAction)) throw new DeskError(400, "need { id, action }");
    if (b.head_oid !== undefined && typeof b.head_oid !== "string") throw new DeskError(400, "head_oid must be a string");
    if (b.body !== undefined && typeof b.body !== "string") throw new DeskError(400, "body must be a string");
    return c.json({ ok: true, ...(await desk.githubAct(b.id, b.action as GitHubAction, { head: b.head_oid, body: b.body })) });
  });
  // Merging: your own PRs you handed off (m m, b through /api/act), which the coordinator gets merged.
  app.get("/api/inflight", (c) => {
    ready();
    return c.json(desk.inflight());
  });
  const line = async (c: { req: { json<T>(): Promise<T> } }, key: string) => {
    const v = (await c.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({})))[key];
    if (typeof v !== "string") throw new DeskError(400, `need { ${key} }`);
    return v;
  };
  // desk_note and desk_hand_back: local only, so agents may call them.
  app.post("/api/inflight/:id{.+}/note", async (c) => {
    ready();
    return c.json({ ok: true, ...desk.note(c.req.param("id"), await line(c, "text")) });
  });
  app.post("/api/inflight/:id{.+}/handback", async (c) => {
    ready();
    return c.json({ ok: true, ...desk.handBack(c.req.param("id"), await line(c, "why")) });
  });
  app.post("/api/coordinator/wake", async (c) => {
    ready();
    await desk.wakeCoordinator();
    return c.json({ ok: true });
  });
  // Your words to the coordinator, from the desk's own window only: it's woken with them at once.
  app.post("/api/ask", async (c) => {
    ready();
    if (!fromDesk(c)) throw new DeskError(403, "ask the coordinator from the desk's window (t)");
    const b = await c.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
    const str = (k: string) => {
      const v = b[k] ?? undefined;
      if (v === undefined || typeof v === "string") return v;
      throw new DeskError(400, `${k} must be a string`);
    };
    if (typeof b.text !== "string") throw new DeskError(400, "need { text }");
    const ask = await desk.ask({ text: b.text, item_id: str("item_id"), thread_id: str("thread_id"), thread_url: str("thread_url") });
    return c.json({ ok: true, ask });
  });
  app.get("/api/asks", (c) => c.json({ on: desk.settings["agent.coordinator"], asks: desk.asks() }));
  // desk_answer: local only, so agents may call it.
  app.post("/api/asks/:id/answer", async (c) => c.json({ ok: true, ask: desk.answer(c.req.param("id"), await line(c, "text")) }));
  app.post("/api/undo", async (c) => {
    ready();
    const body = await c.req.json<{ seq?: number }>().catch((): { seq?: number } => ({}));
    const { id, action } = desk.undo(body.seq, fromDesk(c) ? undefined : "agent");
    return c.json({ ok: true, id, action });
  });
  app.post("/api/sync", (c) => {
    void desk.sync();
    return c.json({ ok: true });
  });
  app.get("/api/config", (c) => {
    ready();
    return c.json(desk.getConfig());
  });
  app.post("/api/config/preview", async (c) => {
    ready();
    const { text } = await c.req.json<{ text: string }>();
    return c.json(desk.preview(text ?? ""));
  });
  app.put("/api/config", async (c) => {
    ready();
    const { text, base } = await c.req.json<{ text: string; base?: string }>();
    return c.json(desk.putConfig(text ?? "", base));
  });
  app.get("/api/policy", (c) => c.json(desk.getPolicy()));
  app.put("/api/policy", async (c) => {
    const { text, base } = await c.req.json<{ text?: unknown; base?: unknown }>();
    if (typeof text !== "string") throw new DeskError(400, "need { text }");
    if (base !== undefined && typeof base !== "string") throw new DeskError(400, "base must be the hash from GET /api/policy");
    return c.json(desk.putPolicy(text, base));
  });
  app.get("/api/fields", (c) => c.json(FIELDS));
  app.get("/api/settings", (c) => c.json(desk.getSettings()));
  app.put("/api/settings", async (c) => {
    const body = await c.req.json<{ set?: Record<string, unknown>; reset?: string[] }>();
    return c.json(desk.putSettings({ set: body.set, reset: body.reset }));
  });
  const mcpUrl = `http://localhost:${port}/mcp`;
  app.get("/api/agents", (c) => c.json(desk.agentStatus(mcpUrl)));
  app.post("/api/agents/connect", async (c) => c.json(await desk.connectAgent(mcpUrl)));
  app.get("/api/status", (c) => {
    ready();
    return c.json(desk.status());
  });
  // The event log. A long-poll: with ?wait= it answers as soon as there's an event after ?after=.
  app.get("/api/activity", async (c) => {
    const int = (key: string) => {
      const v = c.req.query(key);
      const n = Number(v);
      if (v && (!Number.isInteger(n) || n < 0)) throw new DeskError(400, `${key} must be a whole number`);
      return v ? n : undefined;
    };
    const q = { after: int("after"), limit: int("limit"), wait: int("wait"), item: c.req.query("item") };
    return c.json(await desk.activity({ ...q, signal: c.req.raw.signal }));
  });

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const off = desk.onChange((rev) => void stream.writeSSE({ event: "update", data: JSON.stringify({ rev }) }));
      const offNotify =
        c.req.query("notify") === "1"
          ? desk.onNotify((title, body) => void stream.writeSSE({ event: "notify", data: JSON.stringify({ title, body }) }))
          : () => {};
      stream.onAbort(() => {
        off();
        offNotify();
      });
      await stream.writeSSE({ event: "update", data: JSON.stringify({ rev: desk.rev }) });
      while (!stream.aborted) {
        await stream.sleep(25_000);
        if (!stream.aborted) await stream.write(": ping\n\n");
      }
      off();
      offNotify();
    }),
  );

  // MCP over Streamable HTTP, stateless: a fresh server per request whose tools call the routes above in-process.
  app.post("/mcp", async (c) => {
    const api = createClient((p, init) => app.request(p, init));
    const transport = new WebStandardStreamableHTTPServerTransport();
    await createMcpServer(api).connect(transport);
    return transport.handleRequest(c.req.raw);
  });
  // Stateless: no server-initiated stream and no session to end, which the spec answers with 405.
  app.on(["GET", "DELETE"], "/mcp", (c) =>
    c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, 405, { allow: "POST" }),
  );

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  app.get("*", (c) => {
    const rel = decodeURIComponent(c.req.path).replace(/^\/+/, "") || "index.html";
    let file = path.resolve(DIST, rel);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html");
    if (!fs.existsSync(file)) return c.text("UI not built. Run: npm run build", 503);
    const type = TYPES[path.extname(file)] ?? "application/octet-stream";
    const cache = file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
    return c.body(fs.readFileSync(file), 200, { "content-type": type, "cache-control": cache });
  });

  return app;
}

export async function startServer(
  opts: {
    port?: number;
    open?: boolean;
    home?: string;
    notify?: (title: string, body: string) => void; // the desktop app shows its own notifications
    log?: (msg: string) => void;
    writer?: GitHubWriter; // a stand-in for live checks that must not write to GitHub
  } = {},
): Promise<{ url: string; desk: Desk; close(): Promise<void> }> {
  const port = opts.port ?? Number((process.env.DESK_PORT ?? "") || DEFAULT_PORT);
  const home = opts.home ?? ((process.env.DESK_HOME ?? "") || path.join(os.homedir(), ".review-desk")); // empty means unset, as in the CLI
  const log =
    opts.log ??
    ((m: string) => {
      console.error(`${new Date().toISOString()} ${m}`);
    });
  const desk = new Desk({
    home,
    github: createGitHub({ log }),
    log,
    notify: opts.notify,
    review: { fetchPr, generate: generateReview },
    writer: opts.writer ?? createWriter({ log }),
  });
  const app = createApp(desk, port);
  const url = `http://localhost:${port}`;

  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
      resolve(s);
    });
    s.once("error", (e: NodeJS.ErrnoException) => {
      reject(e.code === "EADDRINUSE" ? new Error(`port ${port} is in use; is desk already running? (${url})`) : e);
    });
  });
  log(`Review Desk on ${url} (home ${home})`);

  try {
    await desk.init();
  } catch (e) {
    desk.stop(); // the desktop app retries; don't leak the SQLite handle each time
    server.close();
    throw e;
  }
  desk.start();
  if (opts.open) openUrl(url);

  return {
    url,
    desk,
    close: async () => {
      const agentsGone = desk.close(); // stops the desk at once; its agents may take a moment
      await new Promise<void>((r) => {
        server.close(() => {
          r();
        });
        (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      });
      await agentsGone;
    },
  };
}
