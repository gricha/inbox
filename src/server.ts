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
import type { Action } from "./types.ts";

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

export function createApp(desk: Desk, port: number): Hono {
  const app = new Hono();
  const origins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
  if (process.env.DESK_DEV)
    for (const p of [5173, 5174]) {
      origins.add(`http://localhost:${p}`);
      origins.add(`http://127.0.0.1:${p}`);
    }

  // Only this machine's browser and tools: blocks DNS rebinding (Host) and cross-site requests (Origin).
  app.use("*", async (c, next) => {
    const host = new URL(c.req.url).hostname;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) throw new DeskError(403, "forbidden host");
    const origin = c.req.header("origin");
    if (origin && !origins.has(origin)) throw new DeskError(403, "forbidden origin");
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
    return c.json({ ok: true, ...desk.act(body.id, body.action, body.until) });
  });
  // A PR's id in one path segment (owner%2Frepo%23123), or as owner/repo%23123.
  app.get("/api/review/:id{.+}", async (c) => {
    ready();
    return c.json(await desk.reviewView(c.req.param("id")));
  });
  app.post("/api/review/:id{.+}/ai", async (c) => {
    ready();
    const { force } = await c.req.json<{ force?: boolean }>().catch((): { force?: boolean } => ({}));
    return c.json({ ok: true, ai: await desk.aiReview(c.req.param("id"), force === true) });
  });
  app.post("/api/review/:id{.+}/approve", async (c) => {
    ready();
    const { head_oid, body } = await c.req
      .json<{ head_oid?: unknown; body?: unknown }>()
      .catch((): { head_oid?: unknown; body?: unknown } => ({}));
    if (typeof head_oid !== "string" || !head_oid) throw new DeskError(400, "need { head_oid }: the commit you reviewed");
    if (body !== undefined && typeof body !== "string") throw new DeskError(400, "body must be a string");
    return c.json({ ok: true, ...(await desk.approve(c.req.param("id"), head_oid, body)) });
  });
  app.post("/api/undo", async (c) => {
    ready();
    const body = await c.req.json<{ seq?: number }>().catch((): { seq?: number } => ({}));
    const { id, action } = desk.undo(body.seq);
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
      stream.onAbort(off);
      await stream.writeSSE({ event: "update", data: JSON.stringify({ rev: desk.rev }) });
      while (!stream.aborted) {
        await stream.sleep(25_000);
        if (!stream.aborted) await stream.write(": ping\n\n");
      }
      off();
    }),
  );

  // MCP over Streamable HTTP, stateless: a fresh server per request whose tools call the routes above in-process.
  const inProcess = createClient((p, init) => app.request(p, init));
  app.post("/mcp", async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport();
    await createMcpServer(inProcess).connect(transport);
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
    writer?: GitHubWriter; // a stand-in for live checks that must not approve anything
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
      desk.stop();
      await new Promise<void>((r) => {
        server.close(() => {
          r();
        });
        (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      });
    },
  };
}
