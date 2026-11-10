// HTTP API + web UI on 127.0.0.1.
import fs from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { Cause, Effect, Exit, Option, Semaphore } from "effect";
import { Hono, type Context, type Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { serve, type ServerType } from "@hono/node-server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { refreshSkills, SKILL_MD } from "./agents.ts";
import { createClient } from "./client.ts";
import { createGitHub } from "./github/index.ts";
import { createWriter, type GitHubWriter } from "./github/write.ts";
import { Desk } from "./desk.ts";
import {
  BadRequest,
  Conflict,
  errorBody,
  Forbidden,
  fsError,
  isDeskHttpError,
  ListenFailed,
  NotFound,
  Unauthorized,
  Unavailable,
  type ErrorBody,
  type FsError,
  type GitHubReadError,
  type Upstream,
} from "./errors.ts";
import { settleHome } from "./home.ts";
import { createMcpServer } from "./mcp.ts";
import { instrument, logLine } from "./sentry.ts";
import { openUrl } from "./notify.ts";
import { readOmarchy, watchOmarchy } from "./omarchy.ts";
import { Remote, readTailnet, serveOff, serveOn } from "./remote.ts";
import { fetchPr, generateReview } from "./review.ts";
import { isSecret } from "./settings.ts";
import { FIELDS } from "./signals.ts";
import { GITHUB_ACTIONS, type Action, type AskLines, type GitHubAction, type InlineAt, type RemoteView } from "./types.ts";

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

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Where a browser page may call the desk from: its own address, and the Vite servers that serve its UI in development.
function originsOf(port: number): Set<string> {
  const origins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
  // Vite's default ports, or DESK_DEV_PORT when it runs on another.
  if (process.env.DESK_DEV)
    for (const p of [5173, 5174, Number(process.env.DESK_DEV_PORT) || 5173]) {
      origins.add(`http://localhost:${p}`);
      origins.add(`http://127.0.0.1:${p}`);
    }
  // The desktop app running from a checkout serves the UI from its own Vite server, on exactly this origin.
  if (process.env.DESK_UI_ORIGIN) origins.add(process.env.DESK_UI_ORIGIN);
  return origins;
}

// Per connection, not per request; and fetch undoes the encoding it asked for.
const HOP = ["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "accept-encoding", "content-encoding", "content-length"];
const UI_STARTING =
  '<!doctype html><meta http-equiv="refresh" content="2"><title>Inbox</title><p>The UI from your checkout is starting; this page tries again every 2 seconds.</p>';

// The app's Vite UI, passed through so this address always shows the checkout's current UI.
function fromUi(req: Request, ui: string): Effect.Effect<Response, Forbidden | NotFound> {
  return Effect.gen(function* () {
    const site = req.headers.get("sec-fetch-site");
    // Another site may link to the desk, but not load the checkout's files into its own page.
    if ((site === "cross-site" || site === "same-site") && req.headers.get("sec-fetch-mode") !== "navigate")
      return yield* new Forbidden({ message: "forbidden cross-site request" });
    const { pathname, search } = new URL(req.url);
    // Vite's proxy sends these prefixes back to the desk, so one the desk doesn't route would go round forever.
    if (pathname.startsWith("/api") || pathname.startsWith("/health")) return yield* new NotFound({ message: "not found" });
    const headers = new Headers(req.headers);
    for (const h of HOP) headers.delete(h);
    // The request's own signal, not the Effect's: the body streams on after the route has answered.
    const passed = Effect.tryPromise({
      try: () => fetch(`${ui}${pathname}${search}`, { headers, redirect: "manual", signal: req.signal }),
      catch: (cause) => cause,
    });
    return yield* Effect.match(passed, {
      onFailure: () =>
        new Response(UI_STARTING, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }),
      onSuccess: (res) => {
        const out = new Headers(res.headers);
        for (const h of HOP) out.delete(h);
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
      },
    });
  });
}

// The Vite page's hot-reload socket, through the desk like the page. Returns what drops the open ones: a server holding one
// never finishes closing.
export function proxyUpgrades(server: Server, port: number, ui: string): () => void {
  const origins = originsOf(port);
  const to = new URL(ui);
  const open = new Set<Duplex>();
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const origin = req.headers.origin;
    if (!LOCAL.has(URL.parse(`http://${req.headers.host ?? ""}`)?.hostname ?? "") || (origin && !origins.has(origin))) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    // Node sends every Upgrade here, curl --http2's h2c to the API too, and Vite would leave those hanging.
    const p = URL.parse(req.url ?? "", "http://localhost")?.pathname ?? "";
    if (req.headers.upgrade?.toLowerCase() !== "websocket" || p.startsWith("/api") || p.startsWith("/mcp")) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const up = net.connect(Number(to.port), to.hostname);
    open.add(socket);
    const drop = () => {
      open.delete(socket);
      socket.destroy();
      up.destroy();
    };
    up.on("error", drop).on("close", drop);
    socket.on("error", drop).on("close", drop);
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(`${lines.join("\r\n")}\r\n\r\n`);
    up.write(head);
    up.pipe(socket).pipe(up);
  });
  return () => {
    for (const s of open) s.destroy();
  };
}

// Requests that came in on the listener only `tailscale serve` is pointed at, and how each proved it's a paired device.
// By the connection, never a header: serve passes on the client's own Host, so a peer could send `Host: localhost`.
const REMOTE = new WeakSet<Request>();
const VIA = new WeakMap<Request, "cookie" | "bearer">();
export const remoteFetch =
  (app: Hono) =>
  (req: Request, env?: unknown): Response | Promise<Response> => {
    REMOTE.add(req);
    return app.fetch(req, env);
  };
const SESSION = "__Host-inbox"; // a paired browser's token: HttpOnly, Secure, SameSite=Strict, this host only

// The desk's own page, for its GitHub writes (approve, a reply, ready for review, the More menu's), hand-offs and asks: a browser marks the request same-origin and sends an Origin, which
// the check below lets through only when it's ours. curl, the CLI and agents send neither unless they forge both; from
// another device it's also a paired browser's session, which a bearer token never is.
const fromDesk = (c: Context) =>
  c.req.header("sec-fetch-site") === "same-origin" &&
  !!c.req.header("origin") &&
  (!REMOTE.has(c.req.raw) || VIA.get(c.req.raw) === "cookie");

const PAIR_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Inbox</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:4em auto;max-width:32em;padding:0 1em;color-scheme:light dark}</style>
<p id="m">Pairing this browser with your desk…</p>
<script>
const code = location.hash.slice(1);
history.replaceState(null, "", "/pair");
const say = (t) => { document.getElementById("m").textContent = t; };
if (!code) say("This link has no pairing code. On the desk's machine, run desk pair and open the link it prints.");
else
  fetch("/api/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, kind: "browser", name: "Browser on " + (navigator.platform || "a device") }),
  })
    .then(async (r) => (r.ok ? location.replace("/") : say(((await r.json().catch(() => null))?.error ?? "Pairing failed") + ".")))
    .catch(() => say("The desk didn't answer. Try the link again."));
</script>`;

// docs/effect.md Boundaries → HTTP: the value or its Response, a refusal's status, 499 for a client gone, else a logged 500 Sentry sees.
function reply<A, E>(c: Context, exit: Exit.Exit<A, E>, log: (m: string) => void): Response {
  if (Exit.isSuccess(exit)) return exit.value instanceof Response ? exit.value : c.json(exit.value as object);
  if (Cause.hasInterruptsOnly(exit.cause)) return new Response(null, { status: 499 });
  const failed = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (isDeskHttpError(failed)) {
    if (failed.status >= 500) c.error = failed;
    return c.json(errorBody(failed), failed.status);
  }
  log(`error: ${Cause.pretty(exit.cause)}`);
  const e = Cause.squash(exit.cause);
  c.error = e instanceof Error ? e : new Error(String(e));
  return c.json({ error: c.error.message, tag: "Internal" } satisfies ErrorBody, 500);
}

// A route's Effect, run and answered.
export async function respond<A, E>(
  c: Context,
  effect: Effect.Effect<A, E>,
  opts: { log: (m: string) => void; read?: boolean },
): Promise<Response> {
  return reply(c, await Effect.runPromiseExit(effect, opts.read ? { signal: c.req.raw.signal } : undefined), opts.log);
}

// A line of a PR's diff, or a range from `start` to it, rebuilt from its parts; null when any of them is bad.
function inlineAtOf(b: Record<string, unknown>): InlineAt | null {
  const line = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
  const side = (v: unknown): v is "new" | "old" => v === "new" || v === "old";
  const { path: file, line: at, side: on, start } = b;
  if (typeof file !== "string" || !file || !line(at) || !side(on)) return null;
  if (start === undefined) return { path: file, line: at, side: on };
  if (typeof start !== "object" || start === null) return null;
  const { line: from, side: was } = start as Record<string, unknown>;
  return line(from) && side(was) ? { path: file, line: at, side: on, start: { line: from, side: was } } : null;
}

export function createApp(desk: Desk, port: number, remote: Remote = new Remote(desk.store)): Hono {
  const app = new Hono();
  instrument(app);
  const origins = originsOf(port);
  const ui = process.env.DESK_UI_ORIGIN;
  const log = (m: string) => {
    desk.log(m);
  };

  // Only this machine's browser and tools: blocks DNS rebinding (Host) and cross-site requests (Origin).
  const local = (c: Context) =>
    Effect.suspend((): Effect.Effect<void, Forbidden> => {
      const refused = (message: string) => Effect.fail(new Forbidden({ message }));
      if (!LOCAL.has(new URL(c.req.url).hostname)) return refused("forbidden host");
      const origin = c.req.header("origin");
      if (origin && !origins.has(origin)) return refused("forbidden origin");
      // A no-cors GET (an <img> on another site or another localhost port) has no Origin; browsers still say where it came from.
      const site = c.req.header("sec-fetch-site");
      if ((site === "cross-site" || site === "same-site") && (c.req.path.startsWith("/api/") || c.req.path === "/mcp"))
        return refused("forbidden cross-site request");
      return Effect.void;
    });
  // From another device, through `tailscale serve`: this desk's tailnet name, its owner's login as Tailscale names them,
  // and a paired device's token; pairing itself, its page and its trade, is the only thing without one.
  const tailnet = (c: Context) =>
    Effect.suspend((): Effect.Effect<void, Forbidden | Unauthorized> => {
      const refused = (message: string) => Effect.fail(new Forbidden({ message }));
      const tn = remote.tailnet;
      if (!tn) return refused("this desk isn't served over Tailscale now");
      if (new URL(c.req.url).hostname !== tn.name) return refused("forbidden host");
      const origin = c.req.header("origin");
      if (origin && origin !== `https://${tn.name}`) return refused("forbidden origin");
      const site = c.req.header("sec-fetch-site");
      if ((site === "cross-site" || site === "same-site") && (c.req.path.startsWith("/api/") || c.req.path === "/mcp"))
        return refused("forbidden cross-site request");
      if ((c.req.header("tailscale-user-login") ?? "").toLowerCase() !== tn.login)
        return refused("only the desk's owner may use it from another device");
      if ((c.req.method === "GET" && c.req.path === "/pair") || (c.req.method === "POST" && c.req.path === "/api/pair")) return Effect.void;
      const bearer = /^Bearer (\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
      if (bearer ? remote.verify(bearer, "device") : remote.verify(getCookie(c, SESSION), "browser")) {
        VIA.set(c.req.raw, bearer ? "bearer" : "cookie");
        return Effect.void;
      }
      return Effect.fail(new Unauthorized({ message: "pair this device first: run desk pair on the desk's machine" }));
    });
  app.use("*", async (c: Context, next: Next) => {
    const checked = Effect.runSyncExit(REMOTE.has(c.req.raw) ? tailnet(c) : local(c));
    if (Exit.isFailure(checked)) c.res = reply(c, checked, log);
    else {
      await next();
      c.header("X-Frame-Options", "DENY");
      c.header("Content-Security-Policy", "frame-ancestors 'none'");
    }
  });

  // Only a bug gets here: every route answers its own failures through respond.
  app.onError((e, c) => {
    desk.log(`error: ${e.stack ?? e.message}`);
    return c.json({ error: e.message, tag: "Internal" } satisfies ErrorBody, 500);
  });

  const STARTING = "desk is starting; the first sync can take a minute";
  // Before the first sync there's nothing to show, unless it's the config's errors.
  const up = Effect.suspend((): Effect.Effect<void, Unavailable> =>
    !desk.loaded && !desk.configErrors.length ? Effect.fail(new Unavailable({ message: STARTING, reason: "starting" })) : Effect.void,
  );
  type Req = { req: { json<T>(): Promise<T> } };
  const notJson = () => new BadRequest({ message: "the body must be a JSON object" });
  const json = (c: Req): Effect.Effect<Record<string, unknown>, BadRequest> =>
    Effect.tryPromise({ try: () => c.req.json<unknown>(), catch: notJson }).pipe(
      Effect.filterOrFail((b): b is Record<string, unknown> => typeof b === "object" && b !== null && !Array.isArray(b), notJson),
    );
  // A body that isn't a JSON object reads as {}: each route says what it needs.
  const bodyOf = (c: Req) => Effect.orElseSucceed(json(c), (): Record<string, unknown> => ({}));
  // A string the body may leave out.
  const str = (b: Record<string, unknown>, k: string): Effect.Effect<string | undefined, BadRequest> => {
    const v = b[k] ?? undefined;
    return v === undefined || typeof v === "string" ? Effect.succeed(v) : Effect.fail(new BadRequest({ message: `${k} must be a string` }));
  };
  // A string the body must have.
  const field = (c: Req, key: string) =>
    Effect.flatMap(bodyOf(c), (b): Effect.Effect<string, BadRequest> =>
      typeof b[key] === "string" ? Effect.succeed(b[key]) : Effect.fail(new BadRequest({ message: `need { ${key} }` })),
    );

  // What can't fail answers through respond too: a bug in it is a logged 500 like any other.
  const total = (c: Context, f: () => unknown) => respond(c, Effect.sync(f), { log });
  app.get("/health", (c) => total(c, () => ({ ok: true, version: VERSION })));
  app.get("/api/overview", (c) =>
    respond(
      c,
      Effect.andThen(up, () => desk.overview()),
      { log, read: true },
    ),
  );
  app.get("/api/focus", (c) =>
    respond(
      c,
      Effect.andThen(up, () => desk.focus()),
      { log, read: true },
    ),
  );
  app.get("/api/queue", (c) =>
    respond(
      c,
      Effect.andThen(up, () => desk.queue()),
      { log, read: true },
    ),
  );
  app.get("/api/boards/:id", (c) =>
    respond(
      c,
      Effect.andThen(up, () => desk.board(c.req.param("id"))),
      { log, read: true },
    ),
  );
  app.get("/api/item", (c) => {
    const id = c.req.query("id");
    const item = Effect.gen(function* () {
      yield* up;
      if (!id) return yield* new BadRequest({ message: "missing ?id=" });
      return yield* desk.item(id);
    });
    return respond(c, item, { log, read: true });
  });
  app.post("/api/act", (c) => {
    const act = Effect.gen(function* () {
      yield* up;
      const b = (yield* json(c)) as { id?: string; action?: Action; until?: string };
      if (!b.id || !b.action) return yield* new BadRequest({ message: "need { id, action }" });
      return { ok: true, ...(yield* desk.act(b.id, b.action, b.until, fromDesk(c) ? undefined : "agent")) };
    });
    return respond(c, act, { log });
  });
  // desk_add and `desk add`: a pin plus GitHub reads, so agents may call it.
  app.post("/api/add", (c) => {
    const add = Effect.gen(function* () {
      yield* up;
      const { id, why, from } = yield* bodyOf(c);
      if (typeof id !== "string" || !id) return yield* new BadRequest({ message: "need { id }: owner/repo#123 or a GitHub URL" });
      const line = (v: unknown): Effect.Effect<string | undefined, BadRequest> =>
        v === undefined || typeof v === "string"
          ? Effect.succeed(v)
          : Effect.fail(new BadRequest({ message: "why and from are lines of text" }));
      return { ok: true, ...(yield* desk.add(id, yield* line(why), yield* line(from))) };
    });
    return respond(c, add, { log });
  });
  // Who you can ask to review your PR, as you type: a path of its own, since the review's GET takes any id.
  app.get("/api/reviewers/:id{.+}", (c) =>
    respond(
      c,
      Effect.andThen(up, () => desk.reviewers(c.req.param("id"), c.req.query("q") ?? "")),
      { log, read: true },
    ),
  );
  // A PR's id in one path segment (owner%2Frepo%23123), or as owner/repo%23123. An open starts its AI review and Claude's
  // read once its diff and conversation are in, so it runs to the end whoever still waits; only a prefetch is a read.
  app.get("/api/review/:id{.+}", (c) => {
    const ahead = c.req.query("ahead") === "1";
    return respond(
      c,
      Effect.andThen(up, () => desk.reviewView(c.req.param("id"), ahead)),
      { log, read: ahead },
    );
  });
  // Joins the PR's AI review, which runs to the end whoever still waits: the request's signal never reaches it.
  app.post("/api/review/:id{.+}/ai", (c) => {
    const ai = Effect.gen(function* () {
      yield* up;
      const { force } = yield* bodyOf(c);
      return { ok: true, ai: yield* desk.aiReview(c.req.param("id"), force === true) };
    });
    return respond(c, ai, { log });
  });
  // The desk's GitHub writes below: from its own window only (`refused` otherwise), once it's up, with the body read as
  // each says. A write never takes the request's signal: once sent it lands and is recorded, whoever still listens.
  const write = <A, E>(c: Context, refused: string, then: (b: Record<string, unknown>) => Effect.Effect<A, E>) =>
    respond(
      c,
      Effect.gen(function* () {
        yield* up;
        if (!fromDesk(c)) return yield* new Forbidden({ message: refused });
        return yield* then(yield* bodyOf(c));
      }),
      { log },
    );
  const bad = (message: string) => Effect.fail(new BadRequest({ message }));
  app.post("/api/review/:id{.+}/approve", (c) =>
    write(c, "approve from the PR's review in the desk", ({ head_oid, body }) => {
      if (typeof head_oid !== "string" || !head_oid) return bad("need { head_oid }: the commit you reviewed");
      if (body !== undefined && typeof body !== "string") return bad("body must be a string");
      return Effect.map(desk.approve(c.req.param("id"), head_oid, body), (r) => ({ ok: true, ...r }));
    }),
  );
  // Posts your reply to one of the PR's conversations, from the desk's own window only.
  app.post("/api/review/:id{.+}/reply", (c) =>
    write(c, "replies are sent from the desk's window, by you", (b) => {
      if (typeof b.id !== "string" || !b.id || typeof b.body !== "string") return bad("need { id, body }");
      return Effect.map(desk.reply(c.req.param("id"), b.id, b.body), (r) => ({ ok: true, ...r }));
    }),
  );
  // Your comment on the PR or issue, from the desk's own window only.
  app.post("/api/review/:id{.+}/comment", (c) =>
    write(c, "comments are sent from the desk's window, by you", (b) => {
      if (typeof b.body !== "string") return bad("need { body }");
      return Effect.map(desk.comment(c.req.param("id"), b.body), (r) => ({ ok: true, ...r }));
    }),
  );
  // Your comment on a line of the PR's diff, from the desk's own window only.
  app.post("/api/review/:id{.+}/inline", (c) =>
    write(c, "comments are sent from the desk's window, by you", (b) => {
      const at = inlineAtOf(b);
      const { body, head_oid } = b;
      if (!at || typeof body !== "string" || typeof head_oid !== "string" || !head_oid)
        return bad("need { path, line, side: new|old, start?: { line, side }, body, head_oid }");
      return Effect.map(desk.inlineComment(c.req.param("id"), at, body, head_oid), (r) => ({ ok: true, ...r }));
    }),
  );
  const reviewerIds = (b: Record<string, unknown>): Effect.Effect<{ users: string[]; teams: string[] }, BadRequest> => {
    const ids = (v: unknown): string[] | null => {
      if (v === undefined) return [];
      return Array.isArray(v) && v.every((x) => typeof x === "string" && x !== "") ? (v as string[]) : null;
    };
    const users = ids(b.users);
    const teams = ids(b.teams);
    return users && teams ? Effect.succeed({ users, teams }) : bad("users and teams are lists of node ids");
  };
  // Your own draft's Ready for review, from the desk's own window only.
  app.post("/api/review/:id{.+}/ready", (c) =>
    write(c, "mark your draft ready for review from the desk's window", (b) =>
      Effect.flatMap(reviewerIds(b), (ask) => Effect.map(desk.markReady(c.req.param("id"), ask), (r) => ({ ok: true, ...r }))),
    ),
  );
  // Reviewers for your ready PR nobody's asked to review, from the desk's own window only.
  app.post("/api/review/:id{.+}/reviewers", (c) =>
    write(c, "ask reviewers from the PR's review in the desk's window", (b) =>
      Effect.flatMap(reviewerIds(b), (ask) => Effect.as(desk.askReviewers(c.req.param("id"), ask), { ok: true })),
    ),
  );
  // The More menu's GitHub writes (close, draft, ready, merge, reopen, request changes), from the desk's own window only.
  app.post("/api/github", (c) =>
    write(c, "GitHub actions are yours, from the desk's window", (b) => {
      if (typeof b.id !== "string" || !GITHUB_ACTIONS.includes(b.action as GitHubAction)) return bad("need { id, action }");
      if (b.head_oid !== undefined && typeof b.head_oid !== "string") return bad("head_oid must be a string");
      if (b.body !== undefined && typeof b.body !== "string") return bad("body must be a string");
      const opts = { head: b.head_oid, body: b.body };
      return Effect.map(desk.githubAct(b.id, b.action as GitHubAction, opts), (r) => ({ ok: true, ...r }));
    }),
  );
  // Merging: your own PRs you handed off (Hand off for merge and Back to desk, through /api/act), which the coordinator gets merged.
  app.get("/api/inflight", (c) =>
    respond(
      c,
      Effect.andThen(up, () => desk.inflight()),
      { log, read: true },
    ),
  );
  // desk_note and desk_hand_back: local only, so agents may call them.
  app.post("/api/inflight/:id{.+}/note", (c) => {
    const note = Effect.gen(function* () {
      yield* up;
      return { ok: true, ...(yield* desk.note(c.req.param("id"), yield* field(c, "text"))) };
    });
    return respond(c, note, { log });
  });
  app.post("/api/inflight/:id{.+}/handback", (c) => {
    const back = Effect.gen(function* () {
      yield* up;
      return { ok: true, ...(yield* desk.handBack(c.req.param("id"), yield* field(c, "why"))) };
    });
    return respond(c, back, { log });
  });
  app.post("/api/coordinator/wake", (c) => {
    const wake = Effect.gen(function* () {
      yield* up;
      const { ask } = yield* bodyOf(c);
      yield* desk.wakeCoordinator(typeof ask === "string" ? ask : undefined);
      return { ok: true };
    });
    return respond(c, wake, { log });
  });
  // Your words to the coordinator, from the desk's own window only: it's woken with them at once.
  app.post("/api/ask", (c) => {
    const ask = Effect.gen(function* () {
      yield* up;
      if (!fromDesk(c)) return yield* new Forbidden({ message: "ask your agent from the desk's window" });
      const b = yield* bodyOf(c);
      if (typeof b.text !== "string") return yield* new BadRequest({ message: "need { text }" });
      let lines: AskLines | undefined;
      if (b.lines !== undefined) {
        const l = typeof b.lines === "object" && b.lines !== null ? (b.lines as Record<string, unknown>) : null;
        const at = l && inlineAtOf(l);
        if (!l || !at || typeof l.head !== "string" || (l.note !== undefined && typeof l.note !== "boolean"))
          return yield* new BadRequest({ message: "need lines: { path, line, side: new|old, start?: { line, side }, head, note? }" });
        lines = { ...at, head: l.head, ...(l.note === true && { note: true }) };
      }
      const asked = yield* desk.ask({
        text: b.text,
        item_id: yield* str(b, "item_id"),
        thread_id: yield* str(b, "thread_id"),
        thread_url: yield* str(b, "thread_url"),
        lines,
      });
      return { ok: true, ask: asked };
    });
    return respond(c, ask, { log });
  });
  app.get("/api/asks", (c) =>
    total(c, () => ({ on: desk.settings["agent.coordinator"], asks: desk.asks(), coordinator: desk.coordinator.view() })),
  );
  // desk_ask: local only, so agents may read where an ask is.
  app.get("/api/asks/:id", (c) =>
    respond(
      c,
      Effect.andThen(up, () => desk.askPlace(c.req.param("id"))),
      { log, read: true },
    ),
  );
  // desk_answer: local only, so agents may call it.
  app.post("/api/asks/:id/answer", (c) => {
    const answer = Effect.gen(function* () {
      return { ok: true, ask: yield* desk.answer(c.req.param("id"), yield* field(c, "text")) };
    });
    return respond(c, answer, { log });
  });
  // desk_inquire and desk_inquiry: an agent's question for you, and reading your answer. Local only, so agents may call them.
  app.post("/api/inquiries", (c) => {
    const inquire = Effect.gen(function* () {
      yield* up;
      const b = yield* bodyOf(c);
      const pairs = (k: string, a: string, z: string): Effect.Effect<Record<string, string>[], BadRequest> => {
        const v = b[k] ?? [];
        if (
          Array.isArray(v) &&
          v.every(
            (o: unknown) =>
              !!o &&
              typeof o === "object" &&
              typeof (o as Record<string, unknown>)[a] === "string" &&
              typeof (o as Record<string, unknown>)[z] === "string",
          )
        )
          return Effect.succeed(v as Record<string, string>[]);
        return Effect.fail(new BadRequest({ message: `${k} must be a list of { ${a}, ${z} }` }));
      };
      const question = yield* str(b, "question");
      const from = yield* str(b, "from");
      const context = yield* str(b, "context");
      if (!question || !from || context === undefined) return yield* new BadRequest({ message: "need { question, from, context }" });
      const inquiry = yield* desk.inquire({
        question,
        from,
        context,
        options: (yield* pairs("options", "answer", "next")).map((o) => ({ answer: o.answer!, next: o.next! })),
        links: (yield* pairs("links", "label", "url")).map((l) => ({ label: l.label!, url: l.url! })),
        item: yield* str(b, "item"),
      });
      return { ok: true, inquiry };
    });
    return respond(c, inquire, { log });
  });
  app.get("/api/inquiries/unread", (c) => total(c, () => desk.unreadAnswers())); // before :id, which would take it
  app.get("/api/inquiries/:id", (c) => respond(c, desk.inquiryView(c.req.param("id")), { log, read: true }));
  // desk_inquiry gave whoever asked your answer: the desk notes when, so you can see it was picked up.
  app.post("/api/inquiries/:id/read", (c) =>
    respond(
      c,
      Effect.map(desk.answerRead(c.req.param("id")), (inquiry) => ({ ok: true, inquiry })),
      { log },
    ),
  );
  // Your answer, from the desk's own window only: an agent can't answer its own question.
  app.post("/api/inquiries/:id/answer", (c) => {
    const answer = Effect.gen(function* () {
      if (!fromDesk(c)) return yield* new Forbidden({ message: "answer it in the desk's window" });
      const b = yield* bodyOf(c);
      if (b.dismiss === true) return { ok: true, inquiry: yield* desk.answerInquiry(c.req.param("id"), "", true) };
      if (typeof b.text !== "string") return yield* new BadRequest({ message: "need { text } or { dismiss: true }" });
      return { ok: true, inquiry: yield* desk.answerInquiry(c.req.param("id"), b.text) };
    });
    return respond(c, answer, { log });
  });
  // Sessions that need you (src/connectors/sessions.ts): anyone may read one; only the desk's window starts or opens one.
  app.get("/api/sessions/:id", (c) => respond(c, desk.session(c.req.param("id")), { log, read: true }));
  app.post("/api/sessions/:id/kick", (c) => {
    const kick = Effect.gen(function* () {
      if (!fromDesk(c)) return yield* new Forbidden({ message: "kick a session in the desk's window" });
      return { ok: true, ...(yield* desk.kickSession(c.req.param("id"))) };
    });
    return respond(c, kick, { log });
  });
  app.post("/api/sessions/:id/open", (c) => {
    const open = Effect.gen(function* () {
      if (!fromDesk(c)) return yield* new Forbidden({ message: "open a session from the desk's window" });
      return { ok: true, ...(yield* desk.openSession(c.req.param("id"))) };
    });
    return respond(c, open, { log });
  });
  // Automations (src/automations.ts): any local client may list, draft and run them; one an agent drafts or changes stays off
  // until you turn it on in the desk's window, and it runs before that only on your Run now there; only you delete one. A
  // plugin's is listed too, and only switched, only from the window.
  app.get("/api/automations", (c) => total(c, () => desk.automations.view()));
  app.put("/api/automations/:id", (c) => {
    const set = Effect.gen(function* () {
      yield* up;
      const b = yield* bodyOf(c);
      const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
      if (
        typeof b.name !== "string" ||
        (b.prompt !== undefined && typeof b.prompt !== "string") ||
        (b.decide !== undefined && typeof b.decide !== "string") ||
        (b.rule !== undefined && (typeof b.rule !== "object" || b.rule === null || Array.isArray(b.rule))) ||
        (b.schedule !== undefined && typeof b.schedule !== "string") ||
        (b.events !== undefined && !strings(b.events)) ||
        (b.when !== undefined && typeof b.when !== "string") ||
        (b.can !== undefined && !strings(b.can)) ||
        (b.on !== undefined && typeof b.on !== "boolean")
      )
        return yield* new BadRequest({ message: "need { name, prompt, schedule or events, when?, decide?, rule?, can?, on? }" });
      const { name, schedule, events, prompt, when, decide, rule, can, on } = b;
      const a = yield* desk.automations.set(
        c.req.param("id"),
        { name, schedule, events, prompt, when, decide, rule, can, on },
        fromDesk(c),
      );
      return { ok: true, automation: a };
    });
    return respond(c, set, { log });
  });
  // What a plugin comes with: only the owner switches it, in the window, and nothing else of it changes.
  app.put("/api/automations/:id/on", (c) => {
    const turn = Effect.gen(function* () {
      yield* up;
      if (!fromDesk(c)) return yield* new Forbidden({ message: "only the owner switches it, in the desk's window: Settings" });
      const { on } = yield* bodyOf(c);
      if (typeof on !== "boolean") return yield* new BadRequest({ message: "need { on: true or false }" });
      return { ok: true, automation: yield* desk.automations.switch(c.req.param("id"), on) };
    });
    return respond(c, turn, { log });
  });
  app.delete("/api/automations/:id", (c) => {
    const remove = Effect.gen(function* () {
      if (!fromDesk(c)) return yield* new Forbidden({ message: "delete it in the desk's window: Settings → Your automations" });
      yield* desk.automations.remove(c.req.param("id"));
      return { ok: true };
    });
    return respond(c, remove, { log });
  });
  app.post("/api/automations/:id/run", (c) => {
    const run = Effect.gen(function* () {
      yield* up;
      const a = yield* desk.automations.get(c.req.param("id"));
      if (!a.on && !fromDesk(c))
        return yield* new Conflict({
          message: `"${a.name}" is off: the owner turns it on in Settings → ${a.plugin ? (desk.connectors.find((x) => x.id === a.plugin)?.name ?? a.plugin) : "Your automations"}`,
        });
      desk.automations.run(a, "now");
      return { ok: true, running: a.id };
    });
    return respond(c, run, { log });
  });
  app.post("/api/undo", (c) => {
    const undo = Effect.gen(function* () {
      yield* up;
      const { seq } = (yield* bodyOf(c)) as { seq?: number };
      const { id, action } = yield* desk.undo(seq, fromDesk(c) ? undefined : "agent");
      return { ok: true, id, action };
    });
    return respond(c, undo, { log });
  });
  // The pass runs on through the runner, which logs and reports what fails it; the answer doesn't wait for it.
  app.post("/api/sync", (c) =>
    total(c, () => {
      desk.runner.fork("sync", desk.sync());
      return { ok: true };
    }),
  );
  app.get("/api/config", (c) =>
    respond(
      c,
      Effect.map(up, () => desk.getConfig()),
      { log, read: true },
    ),
  );
  app.post("/api/config/preview", (c) => {
    const preview = Effect.gen(function* () {
      yield* up;
      const { text } = (yield* json(c)) as { text?: string };
      return desk.preview(text ?? "");
    });
    return respond(c, preview, { log });
  });
  app.put("/api/config", (c) => {
    const put = Effect.gen(function* () {
      yield* up;
      const { text, base } = (yield* json(c)) as { text?: string; base?: string };
      return yield* desk.putConfig(text ?? "", base);
    });
    return respond(c, put, { log });
  });
  app.get("/api/policy", (c) => total(c, () => desk.getPolicy()));
  app.put("/api/policy", (c) => {
    const put = Effect.gen(function* () {
      const { text, base } = yield* json(c);
      if (typeof text !== "string") return yield* new BadRequest({ message: "need { text }" });
      if (base !== undefined && typeof base !== "string")
        return yield* new BadRequest({ message: "base must be the hash from GET /api/policy" });
      return yield* desk.putPolicy(text, base);
    });
    return respond(c, put, { log });
  });
  app.get("/api/fields", (c) => total(c, () => FIELDS));
  app.get("/api/settings", (c) => total(c, () => desk.getSettings()));
  app.put("/api/settings", (c) => {
    const put = Effect.gen(function* () {
      const b = (yield* json(c)) as { set?: Record<string, unknown>; reset?: string[] };
      // A key (a secret setting) is set or cleared in the desk's window only, as approve is: no agent, CLI or curl reaches it.
      const keys = [...(b.set && typeof b.set === "object" ? Object.keys(b.set) : []), ...(Array.isArray(b.reset) ? b.reset : [])];
      if (keys.some((k) => typeof k === "string" && isSecret(k)) && !fromDesk(c))
        return yield* new Forbidden({ message: "set or clear a key in the desk's window: Settings → Agent" });
      return yield* desk.putSettings({ set: b.set, reset: b.reset });
    });
    return respond(c, put, { log });
  });
  const mcpUrl = `http://localhost:${port}/mcp`;
  app.get("/api/agents", (c) => respond(c, desk.agentStatus(mcpUrl), { log, read: true }));
  app.post("/api/agents/connect", (c) => respond(c, desk.connectAgent(mcpUrl), { log }));
  app.get("/api/status", (c) =>
    respond(
      c,
      Effect.andThen(up, () => desk.status()),
      { log, read: true },
    ),
  );
  // The event log. A long-poll: with ?wait= it answers as soon as there's an event after ?after=, or the client goes away.
  app.get("/api/activity", (c) => {
    const int = (key: string): Effect.Effect<number | undefined, BadRequest> => {
      const v = c.req.query(key);
      const n = Number(v);
      if (v && (!Number.isInteger(n) || n < 0)) return Effect.fail(new BadRequest({ message: `${key} must be a whole number` }));
      return Effect.succeed(v ? n : undefined);
    };
    const activity = Effect.gen(function* () {
      const q = { after: yield* int("after"), limit: yield* int("limit"), wait: yield* int("wait"), item: c.req.query("item") };
      return yield* desk.activity(q);
    });
    return respond(c, activity, { log, read: true });
  });

  // The theme Omarchy has on, here; null off Omarchy.
  app.get("/api/omarchy", (c) => respond(c, readOmarchy(), { log, read: true }));

  app.get("/api/events", (c) =>
    total(c, () =>
      streamSSE(c, async (stream) => {
        // Hono's stream swallows a write to a closed client, so dropping the promise is right.
        const off = desk.onChange((rev) => void stream.writeSSE({ event: "update", data: JSON.stringify({ rev }) }));
        const offNotify =
          c.req.query("notify") === "1"
            ? desk.onNotify((title, body) => void stream.writeSSE({ event: "notify", data: JSON.stringify({ title, body }) }))
            : () => {};
        // Omarchy switching theme, read again: a window with Omarchy as its theme follows it.
        const offOmarchy = watchOmarchy(() => {
          desk.runner.fork(
            "omarchy",
            Effect.map(readOmarchy(), (t) => void stream.writeSSE({ event: "omarchy", data: JSON.stringify(t) })),
          );
        });
        stream.onAbort(() => {
          off();
          offNotify();
          offOmarchy();
        });
        await stream.writeSSE({ event: "update", data: JSON.stringify({ rev: desk.rev }) });
        while (!stream.aborted) {
          await stream.sleep(25_000);
          if (!stream.aborted) await stream.write(": ping\n\n");
        }
      }),
    ),
  );

  // Your other devices (src/remote.ts). Only this machine mints a code or a token; the code's trade is the other device's.
  const here = (c: Context, what: string) =>
    Effect.suspend(() => (REMOTE.has(c.req.raw) ? Effect.fail(new Forbidden({ message: `${what} on the desk's machine` })) : Effect.void));
  const served = Effect.suspend(() =>
    remote.url
      ? Effect.succeed(remote.url)
      : Effect.fail(new Conflict({ message: "turn on Settings → This device → Use it from your other devices first" })),
  );
  app.get("/api/remote", (c) =>
    total(
      c,
      () =>
        ({
          on: remote.wanted,
          text: remote.text,
          url: remote.url,
          login: remote.tailnet?.login ?? null,
          devices: remote.devices(),
        }) satisfies RemoteView,
    ),
  );
  app.post("/api/pair/code", (c) =>
    respond(
      c,
      Effect.gen(function* () {
        yield* here(c, "pair a device");
        const url = yield* served;
        const { code, expires_at } = remote.mint();
        return { code, expires_at, url, pair_url: `${url}/pair#${code}` };
      }),
      { log },
    ),
  );
  app.post("/api/pair/token", (c) =>
    respond(
      c,
      Effect.gen(function* () {
        yield* here(c, "mint a token");
        const url = yield* served;
        const { name } = yield* bodyOf(c);
        return { url, ...remote.issue(name, "device") };
      }),
      { log },
    ),
  );
  app.post("/api/pair", (c) =>
    respond(
      c,
      Effect.gen(function* () {
        if (!REMOTE.has(c.req.raw)) return yield* new Forbidden({ message: "pair from the other device, at the desk's tailnet address" });
        const { code, name, kind } = yield* bodyOf(c);
        const paired = yield* remote.trade(code, name, kind === "browser" ? "browser" : "device");
        log(`paired ${paired.device.kind} "${paired.device.name}" (${paired.device.id})`);
        if (kind !== "browser") return { ok: true, token: paired.token, device: paired.device };
        setCookie(c, SESSION, paired.token, { path: "/", httpOnly: true, secure: true, sameSite: "Strict", maxAge: 400 * 86_400 });
        return { ok: true, device: paired.device };
      }),
      { log },
    ),
  );
  app.get("/pair", (c) => total(c, () => c.html(PAIR_PAGE, 200, { "cache-control": "no-store" })));
  app.delete("/api/devices/:id", (c) =>
    respond(
      c,
      Effect.gen(function* () {
        if (!fromDesk(c)) return yield* new Forbidden({ message: "revoke it in the desk's window: Settings → This device" });
        yield* remote.revoke(c.req.param("id"));
        log(`revoked paired device ${c.req.param("id")}`);
        return { ok: true };
      }),
      { log },
    ),
  );
  // The skill for a paired machine's agents, its addresses this desk's as that machine reaches it.
  app.get("/skill", (c) =>
    respond(
      c,
      Effect.map(Effect.try({ try: () => fs.readFileSync(SKILL_MD, "utf8"), catch: fsError("read", SKILL_MD) }), (text) => {
        const at = REMOTE.has(c.req.raw) ? remote.url : null;
        const body = at ? text.replaceAll("http://localhost:47823", at).replaceAll("localhost:47823", at) : text;
        return c.body(body, 200, { "content-type": "text/markdown; charset=utf-8" });
      }),
      { log, read: true },
    ),
  );

  // MCP over Streamable HTTP, stateless: a fresh server per request whose tools call the routes in-process and answer for their failures.
  app.post("/mcp", (c) => {
    const api = createClient((p, init) => app.request(p, init));
    const transport = new WebStandardStreamableHTTPServerTransport();
    const handled = Effect.promise(async () => {
      await createMcpServer(api, log).connect(transport);
      return transport.handleRequest(c.req.raw);
    });
    return respond(c, handled, { log });
  });
  // Stateless: no server-initiated stream and no session to end, which the spec answers with 405.
  app.on(["GET", "DELETE"], "/mcp", (c) =>
    total(c, () => c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, 405, { allow: "POST" })),
  );

  app.all("/api/*", (c) => respond(c, Effect.fail(new NotFound({ message: "not found" })), { log }));

  if (ui) app.get("*", (c) => respond(c, fromUi(c.req.raw, ui), { log, read: true }));
  app.get("*", (c) => {
    const page = Effect.gen(function* () {
      const rel = decodeURIComponent(c.req.path).replace(/^\/+/, "") || "index.html";
      let file = path.resolve(DIST, rel);
      if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html");
      if (!fs.existsSync(file)) return c.text("UI not built. Run: npm run build", 503);
      const type = TYPES[path.extname(file)] ?? "application/octet-stream";
      const cache = file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
      const body = yield* Effect.try({ try: () => fs.readFileSync(file), catch: fsError("read", file) });
      return c.body(body, 200, { "content-type": type, "cache-control": cache });
    });
    return respond(c, page, { log, read: true });
  });

  return app;
}

type ServeOptions = {
  port?: number;
  open?: boolean;
  home?: string;
  notify?: (title: string, body: string) => void; // the desktop app shows its own notifications
  log?: (msg: string) => void;
  writer?: GitHubWriter; // a stand-in for live checks that must not write to GitHub
  tailscale?: boolean; // desk serve --tailscale: serve over Tailscale whatever the setting says
};
type Served = { url: string; desk: Desk; close(): Promise<void> };

// Listening on 127.0.0.1, or why it can't: the port in use, or Node's error.
const listen = (fetch: (req: Request, env?: unknown) => Response | Promise<Response>, port: number, url: string) =>
  Effect.callback<ServerType, ListenFailed>((resume) => {
    const s = serve({ fetch, port, hostname: "127.0.0.1" }, () => {
      resume(Effect.succeed(s));
    });
    s.once("error", (cause: Error) => {
      resume(Effect.fail(new ListenFailed({ port, url, cause })));
    });
    return Effect.sync(() => {
      s.close();
    });
  });

const shut = (s: ServerType) =>
  Effect.callback<void>((resume) => {
    s.close(() => {
      resume(Effect.void);
    });
    (s as { closeAllConnections?: () => void }).closeAllConnections?.();
  });

// Served over Tailscale while `wanted()`: `tailscale serve` on https://<tailnet name>/ to a listener on a free loopback
// port of its own, so what arrives there is remote. One change at a time; a failed start waits for the setting to change.
function overTailnet(app: Hono, remote: Remote, desk: Desk, wanted: () => boolean) {
  const lock = Semaphore.makeUnsafe(1);
  let server: ServerType | null = null;
  let failed = false;
  let closed = false;
  const on = Effect.gen(function* () {
    const tn = yield* readTailnet(desk.settings["app.tailscale_login"]);
    const s = yield* listen(remoteFetch(app), 0, "a free loopback port");
    const target = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const mine = desk.store.get("tailscale_serve");
    // Ready before serve points at it, so the first request through isn't refused.
    remote.tailnet = tn;
    yield* serveOn(tn.name, target, typeof mine === "string" ? mine : null).pipe(
      Effect.onError(() =>
        Effect.andThen(
          Effect.sync(() => {
            remote.tailnet = null;
          }),
          shut(s),
        ),
      ),
    );
    desk.store.set("tailscale_serve", target);
    server = s;
    remote.text = `On at https://${tn.name}/, for ${tn.login}'s paired devices.`;
    desk.log(`serving over Tailscale at https://${tn.name}/ for ${tn.login}`);
  });
  const off = Effect.gen(function* () {
    remote.tailnet = null;
    const s = server;
    server = null;
    if (s) yield* shut(s);
    const done = yield* Effect.exit(serveOff);
    if (Exit.isFailure(done)) desk.log(`tailscale serve didn't turn off: ${Cause.pretty(done.cause)}`);
    remote.text = "Off.";
    desk.log("stopped serving over Tailscale");
  });
  const settle: Effect.Effect<void> = Effect.suspend(() => {
    const want = !closed && wanted();
    remote.wanted = want;
    if (!want) failed = false;
    if (want === !!server || (want && failed)) return Effect.void;
    const step = want
      ? on.pipe(
          Effect.catch((e) =>
            Effect.sync(() => {
              failed = true;
              remote.text = e.message;
              desk.log(`can't serve over Tailscale: ${e.message}`);
            }),
          ),
        )
      : off;
    return Effect.andThen(step, settle);
  });
  const settled = lock.withPermits(1)(settle);
  return {
    check: () => {
      if (!closed && (!!server !== wanted() || remote.wanted !== wanted())) desk.runner.fork("tailscale serve", settled);
    },
    stop: Effect.suspend(() => {
      closed = true;
      return settled;
    }),
  };
}

// What the desk installed in your agents, kept current and renamed from before Inbox, on every start of the owner's desk
// (desk serve, the app's own): what it did, in the log.
export const refreshAgents = (desk: Desk, url: string): Effect.Effect<void> =>
  Effect.flatMap(refreshSkills(desk.home, `${url}/mcp`), (done) =>
    Effect.sync(() => {
      for (const line of done) desk.log(line);
    }),
  );

// The desk on its port, its first config read and its loops started. Its port, GitHub's viewer or a file it can't read
// or write fails it, and then it leaves nothing open: the desktop app retries.
export const startDesk = Effect.fnUntraced(function* (
  opts: ServeOptions = {},
): Effect.fn.Return<Served, ListenFailed | GitHubReadError | Upstream | FsError> {
  const port = opts.port ?? Number((process.env.DESK_PORT ?? "") || DEFAULT_PORT);
  const log =
    opts.log ??
    ((m: string) => {
      console.error(`${new Date().toISOString()} ${m}`);
      logLine(m);
    });
  const home = opts.home ?? (yield* settleHome(port, log));
  const desk = new Desk({
    home,
    github: createGitHub({ log }),
    log,
    notify: opts.notify,
    review: { fetchPr, generate: generateReview },
    writer: opts.writer ?? createWriter({ log }),
    mcpUrl: `http://localhost:${port}/mcp`,
  });
  const remote = new Remote(desk.store);
  const app = createApp(desk, port, remote);
  const url = `http://localhost:${port}`;

  // The desktop app retries: don't leak the SQLite handle each time.
  const server = yield* listen(app.fetch, port, url).pipe(
    Effect.onError(() =>
      Effect.sync(() => {
        desk.stop();
      }),
    ),
  );
  const ui = process.env.DESK_UI_ORIGIN;
  const dropUpgrades = ui ? proxyUpgrades(server as Server, port, ui) : () => {};
  log(`Inbox on ${url} (home ${home})${ui ? `, its UI from ${ui}` : ""}`);

  yield* desk.init().pipe(
    Effect.onError(() =>
      Effect.sync(() => {
        desk.stop();
        server.close();
      }),
    ),
  );
  desk.start();
  desk.runner.fork("skill refresh", refreshAgents(desk, url));
  const tailscale = overTailnet(app, remote, desk, () => !!opts.tailscale || desk.settings["app.tailscale"]);
  desk.onChange(tailscale.check);
  tailscale.check();
  if (opts.open) openUrl(url);

  // The desk stops at once; its agents may take a moment.
  const stopListening = Effect.callback<void>((resume) => {
    server.close(() => {
      resume(Effect.void);
    });
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    dropUpgrades();
  });
  // The port is let go even when closing the desk dies.
  const closing = Effect.andThen(
    tailscale.stop,
    Effect.all([Effect.exit(desk.close()), stopListening], { concurrency: 2 }).pipe(Effect.flatMap(([closed]) => closed)),
  );
  return { url, desk, close: () => Effect.runPromise(closing) };
});

// startDesk for a caller that awaits it (the desktop app): it rejects with what stopped the desk, whose words it shows.
export function startServer(opts: ServeOptions = {}): Promise<Served> {
  return Effect.runPromise(startDesk(opts));
}
