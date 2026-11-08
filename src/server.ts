// HTTP API + web UI on 127.0.0.1.
import fs from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { Cause, Effect, Exit, Option } from "effect";
import { Hono, type Context, type Next } from "hono";
import { streamSSE } from "hono/streaming";
import { serve, type ServerType } from "@hono/node-server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
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
  Unavailable,
  type ErrorBody,
  type FsError,
  type GitHubReadError,
  type Upstream,
} from "./errors.ts";
import { createMcpServer } from "./mcp.ts";
import { instrument, logLine } from "./sentry.ts";
import { openUrl } from "./notify.ts";
import { fetchPr, generateReview } from "./review.ts";
import { FIELDS } from "./signals.ts";
import { GITHUB_ACTIONS, type Action, type AskLines, type GitHubAction, type InlineAt } from "./types.ts";

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
  '<!doctype html><meta http-equiv="refresh" content="2"><title>Review Desk</title><p>The UI from your checkout is starting; this page tries again every 2 seconds.</p>';

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

// The desk's own page, for its GitHub writes (approve, a reply, ready for review, the More menu's), hand-offs and asks: a browser marks the request same-origin and sends an Origin, which
// the check below lets through only when it's ours. curl, the CLI and agents send neither unless they forge both.
const fromDesk = (c: { req: { header(name: string): string | undefined } }) =>
  c.req.header("sec-fetch-site") === "same-origin" && !!c.req.header("origin");

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

export function createApp(desk: Desk, port: number): Hono {
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
  app.use("*", async (c: Context, next: Next) => {
    const checked = Effect.runSyncExit(local(c));
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
      Effect.flatMap(reviewerIds(b), (ask) => Effect.as(desk.markReady(c.req.param("id"), ask), { ok: true })),
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
  app.get("/api/inquiries/:id", (c) => respond(c, desk.inquiryView(c.req.param("id")), { log, read: true }));
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
  // Automations (src/automations.ts): any local client may list, draft and run them; one an agent drafts or changes stays off
  // until you turn it on in the desk's window, and it runs before that only on your Run now there; only you delete one.
  app.get("/api/automations", (c) => total(c, () => desk.automations.view()));
  app.put("/api/automations/:id", (c) => {
    const set = Effect.gen(function* () {
      yield* up;
      const b = yield* bodyOf(c);
      if (
        typeof b.name !== "string" ||
        typeof b.schedule !== "string" ||
        typeof b.prompt !== "string" ||
        (b.on !== undefined && typeof b.on !== "boolean")
      )
        return yield* new BadRequest({ message: "need { name, schedule, prompt, on? }" });
      const a = yield* desk.automations.set(
        c.req.param("id"),
        { name: b.name, schedule: b.schedule, prompt: b.prompt, on: b.on },
        fromDesk(c),
      );
      return { ok: true, automation: a };
    });
    return respond(c, set, { log });
  });
  app.delete("/api/automations/:id", (c) => {
    const remove = Effect.gen(function* () {
      if (!fromDesk(c)) return yield* new Forbidden({ message: "delete it in the desk's window: Settings → Automations" });
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
        return yield* new Conflict({ message: `"${a.name}" is off: the owner turns it on in Settings → Automations` });
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

  app.get("/api/events", (c) =>
    total(c, () =>
      streamSSE(c, async (stream) => {
        // Hono's stream swallows a write to a closed client, so dropping the promise is right.
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
      }),
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
};
type Served = { url: string; desk: Desk; close(): Promise<void> };

// Listening on 127.0.0.1, or why it can't: the port in use, or Node's error.
const listen = (app: Hono, port: number, url: string) =>
  Effect.callback<ServerType, ListenFailed>((resume) => {
    const s = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
      resume(Effect.succeed(s));
    });
    s.once("error", (cause: Error) => {
      resume(Effect.fail(new ListenFailed({ port, url, cause })));
    });
    return Effect.sync(() => {
      s.close();
    });
  });

// The desk on its port, its first config read and its loops started. Its port, GitHub's viewer or a file it can't read
// or write fails it, and then it leaves nothing open: the desktop app retries.
export const startDesk = Effect.fnUntraced(function* (
  opts: ServeOptions = {},
): Effect.fn.Return<Served, ListenFailed | GitHubReadError | Upstream | FsError> {
  const port = opts.port ?? Number((process.env.DESK_PORT ?? "") || DEFAULT_PORT);
  const home = opts.home ?? ((process.env.DESK_HOME ?? "") || path.join(os.homedir(), ".review-desk")); // empty means unset, as in the CLI
  const log =
    opts.log ??
    ((m: string) => {
      console.error(`${new Date().toISOString()} ${m}`);
      logLine(m);
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

  // The desktop app retries: don't leak the SQLite handle each time.
  const server = yield* listen(app, port, url).pipe(
    Effect.onError(() =>
      Effect.sync(() => {
        desk.stop();
      }),
    ),
  );
  const ui = process.env.DESK_UI_ORIGIN;
  const dropUpgrades = ui ? proxyUpgrades(server as Server, port, ui) : () => {};
  log(`Review Desk on ${url} (home ${home})${ui ? `, its UI from ${ui}` : ""}`);

  yield* desk.init().pipe(
    Effect.onError(() =>
      Effect.sync(() => {
        desk.stop();
        server.close();
      }),
    ),
  );
  desk.start();
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
  const closing = Effect.all([Effect.exit(desk.close()), stopListening], { concurrency: 2 }).pipe(Effect.flatMap(([closed]) => closed));
  return { url, desk, close: () => Effect.runPromise(closing) };
});

// startDesk for a caller that awaits it (the desktop app): it rejects with what stopped the desk, whose words it shows.
export function startServer(opts: ServeOptions = {}): Promise<Served> {
  return Effect.runPromise(startDesk(opts));
}
