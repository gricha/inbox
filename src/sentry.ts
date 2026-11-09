// The desk's errors, logs and traces go to Sentry (greg-pstrucha-test: review-desk, and review-desk-web for the UI; the projects
// keep their names from before the rename to Inbox). Only `desk serve` starts it, so tests and the CLI's other commands send
// nothing; DESK_SENTRY=0 turns it off.
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import type * as SentrySdk from "@sentry/hono/node";
import type { Hono } from "hono";
import { isDeskHttpError } from "./errors.ts";

const SERVER_DSN = "https://67d41f6516775a8698be5de57fe53b85@o4511536895623168.ingest.us.sentry.io/4512382725718016";
const WEB_DSN = "https://fde5d7d368ea4fb4b31bee7435f2b35b@o4511536895623168.ingest.us.sentry.io/4512382725783552";

let sdk: typeof SentrySdk | null = null;
let release: string | undefined;
// Errors report() sent, so a route's 502 wrapping one (an AI review the UI asked for) isn't sent again.
const sent = new WeakSet<object>();
// Taken on load, before any request: a loop's timer runs in it, so the request that re-armed the loop isn't on every
// later issue and trace.
const root = AsyncLocalStorage.snapshot();

export async function startSentry(): Promise<void> {
  if (process.env.DESK_SENTRY === "0") return;
  // Loaded here, not on import: only `desk serve` pays for the SDK, and the app ships without it.
  const s = await import("@sentry/hono/node");
  release = commit();
  s.init({
    dsn: SERVER_DSN,
    ...(release && { release }),
    tracesSampleRate: 0.2,
    // Your comments and replies travel in request bodies, and agents' asks and your answers in MCP calls: they stay off
    // Sentry, and so does your IP.
    dataCollection: { httpBodies: [], mcp: { inputs: false, outputs: false }, userInfo: false },
    // Its listener would keep a desk with an unhandled rejection running; without it the desk still crashes, reported.
    integrations: (all) => all.filter((i) => i.name !== "OnUnhandledRejection"),
  });
  sdk = s;
}

// Sends what's still buffered (logs go out every few seconds) before the desk exits.
export async function stopSentry(): Promise<void> {
  await sdk?.close(2_000);
}

// Each request as a trace, and a 5xx as an issue. A refusal (a DeskHttpError) is an answer the desk chose: only a
// failure it passes on (GitHub's, an agent's) is worth one, not "still starting", and not one whose cause report()
// already sent.
export function instrument(app: Hono): void {
  if (!sdk) return;
  const shouldHandleError = (e: unknown) => {
    const status = isDeskHttpError(e) ? e.status : undefined;
    if (status === undefined) return true;
    const cause = (e as { cause?: unknown }).cause;
    return status >= 500 && status !== 503 && !(cause instanceof Object && sent.has(cause));
  };
  app.use(sdk.sentry(app, { shouldHandleError }));
}

// What the UI sends to, while the desk itself does: the mock and tests leave it out, so they send nothing.
export function webSentry(): { dsn: string; release: string | undefined } | null {
  return sdk && { dsn: WEB_DSN, release };
}

// A failure the desk handles (it shows it, or tries again later) that's still worth an issue in Sentry.
export function report(err: unknown, what: string, item?: string): void {
  if (!sdk) return;
  if (err instanceof Object) sent.add(err);
  sdk.captureException(err, { tags: { what, ...(item && { item }) } });
}

// Each line the desk logs, as a Sentry log.
export function logLine(m: string): void {
  sdk?.logger.info(m);
}

// A loop's next run, in a trace of its own.
export function detached(fn: () => void): void {
  const s = sdk;
  if (s)
    root(() => {
      s.startNewTrace(fn);
    });
  else fn();
}

// The checkout's commit: an issue says which version it happened on. None when git isn't there or it isn't a checkout.
function commit(): string | undefined {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8", timeout: 5_000 });
  return (r.status === 0 && r.stdout.trim()) || undefined;
}
