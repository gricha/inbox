// Read-only GitHub transport (GraphQL queries and REST GETs): token, retries, rate-limit tracking.

import { execFile } from "node:child_process";
import { Cache, Duration, Effect, Exit, Result, Schedule, Schema } from "effect";
import {
  GitHubAuthError,
  GitHubBadResponse,
  GitHubGraphQLError,
  GitHubHttpError,
  GitHubNetworkError,
  GitHubRateLimited,
  type GitHubReadError,
} from "../errors.ts";
import { field } from "../narrow.ts";

const ENDPOINT = "https://api.github.com/graphql";
const REST = "https://api.github.com";
const RETRYABLE = new Set([502, 503, 504]);
const RETRIES = 2;
const MIN_REMAINING = 200;
// Per-node errors that leave the rest of the response usable: a deleted node, or one the token can't see (e.g. SAML).
const PARTIAL = new Set(["NOT_FOUND", "FORBIDDEN"]);
export const GH_MISSING = "GitHub CLI (gh) not found: install it from https://cli.github.com and run gh auth login, or set GITHUB_TOKEN";
const TOKEN_TIMEOUT_MS = 30_000;
const GH_SLOW = "gh auth token didn't answer in 30 s: run it in a terminal";

export function readToken(token?: string): Effect.Effect<string, GitHubAuthError> {
  return Effect.suspend((): Effect.Effect<string, GitHubAuthError> => {
    if (token) return Effect.succeed(token);
    if (process.env.GITHUB_TOKEN) return Effect.succeed(process.env.GITHUB_TOKEN);
    return Effect.callback<string, GitHubAuthError>((resume) => {
      let late = false;
      const child = execFile("gh", ["auth", "token"], (err, stdout) => {
        clearTimeout(timer);
        if (late) return;
        if (!err) {
          resume(Effect.succeed(stdout.trim()));
          return;
        }
        const message = `no GitHub token: set GITHUB_TOKEN or run \`gh auth login\` (${err.message})`;
        resume(
          Effect.fail(
            err.code === "ENOENT"
              ? new GitHubAuthError({ reason: "gh_missing", message: GH_MISSING, cause: err })
              : new GitHubAuthError({ reason: "no_token", message, cause: err }),
          ),
        );
      });
      // A write reads it where nothing interrupts it, so a gh that never answers (a keychain prompt) is given up here.
      const timer = setTimeout(() => {
        late = true;
        if (child.pid !== undefined) child.kill();
        resume(Effect.fail(new GitHubAuthError({ reason: "no_token", message: GH_SLOW })));
      }, TOKEN_TIMEOUT_MS);
      timer.unref(); // the running gh keeps the process up; this alone mustn't
      // Interrupted, a gh that started is stopped. Not execFile's signal: for one that didn't start it signals the desk's own group.
      return Effect.sync(() => {
        clearTimeout(timer);
        if (child.pid !== undefined) child.kill();
      });
    });
  });
}

// What GitHub sent can't be read, or isn't the shape the caller reads: its words, as a failure rather than a crash.
export const decode = <A>(parse: () => A): Effect.Effect<A, GitHubBadResponse> =>
  Effect.try({
    try: parse,
    catch: (cause) => new GitHubBadResponse({ message: cause instanceof Error ? cause.message : String(cause), cause }),
  });

// What GitHub sent, read as a schema says: a failure in its words when it isn't that shape.
export const decodeAs = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, v: unknown): Effect.Effect<S["Type"], GitHubBadResponse> =>
  decode(() => Schema.decodeUnknownSync(schema)(v));

// A GraphQL answer, the read client's and the writer's: data is the query's to read.
export const GQL_ANSWER = Schema.Struct({
  data: Schema.optionalKey(Schema.Unknown),
  errors: Schema.optionalKey(Schema.Array(Schema.Struct({ type: Schema.optionalKey(Schema.String), message: Schema.String }))),
});
const RATE_LIMIT = Schema.Struct({ remaining: Schema.Number, resetAt: Schema.String });

export interface ClientOptions {
  token?: string;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
  retryDelayMs?: number;
}

interface RestResponse {
  status: number; // 200, or 304 when If-Modified-Since says nothing changed
  headers: Headers;
  data: unknown; // parsed JSON; null for a 304
}

export interface Client {
  query(query: string, variables?: Record<string, unknown>): Effect.Effect<unknown, GitHubReadError>; // data, for decodeAs
  // A REST read, e.g. "/notifications?all=true". Anything but GET is refused, so it can't mark threads read.
  get(path: string, init?: { method?: string; headers?: Record<string, string> }): Effect.Effect<RestResponse, GitHubReadError>;
  rateLimit(): { remaining: number; reset_at: string } | null;
}

const isoAt = (ms: number) => {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// Retry-After in seconds (or an HTTP date), else the primary limit's reset; anything unreadable waits the minute below.
function resetFrom(h: Headers): string {
  const after = h.get("retry-after");
  const reset = h.get("x-ratelimit-reset");
  const at =
    (after ? (isoAt(Date.now() + Number(after) * 1000) ?? isoAt(Date.parse(after))) : null) ??
    (reset && h.get("x-ratelimit-remaining") === "0" ? isoAt(Number(reset) * 1000) : null);
  return at ?? new Date(Date.now() + 60_000).toISOString(); // GitHub's advice for secondary limits: wait at least a minute
}

// What a read tries again: no answer, a gateway's 502/503/504, or GraphQL's own timeout.
const retryable = (e: GitHubReadError) =>
  e._tag === "GitHubNetworkError" ||
  (e._tag === "GitHubHttpError" && RETRYABLE.has(e.status)) ||
  (e._tag === "GitHubGraphQLError" && /timeout/i.test(e.message));

// What a GraphQL answer says: its data, and the errors that fail it.
function answerOf(text: string) {
  const json = Schema.decodeUnknownSync(GQL_ANSWER)(JSON.parse(text));
  // Those nodes come back null and callers skip them; with no data at all, every error is fatal.
  const fatal = (json.errors ?? []).filter((e) => !(json.data && PARTIAL.has(e.type ?? "")));
  return {
    data: json.data,
    rateLimit: Result.getOrUndefined(Schema.decodeUnknownResult(RATE_LIMIT)(field(json.data, "rateLimit"))),
    forbidden: json.data ? json.errors?.find((e) => e.type === "FORBIDDEN") : undefined,
    failed: fatal.length > 0,
    limited: fatal.some((e) => e.type === "RATE_LIMITED" || /rate limit/i.test(e.message)),
    msg: fatal.map((e) => e.message).join("; "),
    types: fatal.flatMap((e) => (e.type ? [e.type] : [])),
  };
}

const TOKEN = "token";

export function createClient(opts: ClientOptions = {}): Client {
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log ?? (() => {});
  const delay = opts.retryDelayMs ?? 1000;
  let last: { remaining: number; reset_at: string } | null = null;
  // Read once and kept, but a failed read isn't: the next request reads it again, as it does after a 401.
  const tokens = Effect.runSync(
    Cache.makeWith<typeof TOKEN, string, GitHubAuthError>(() => readToken(opts.token), {
      capacity: 1,
      timeToLive: (exit) => (Exit.isFailure(exit) ? Duration.zero : Duration.infinity),
    }),
  );
  // 3 attempts, waiting delay then 3x it; the log says each retry.
  const retrying = <A>(self: Effect.Effect<A, GitHubReadError>) =>
    self.pipe(
      Effect.retry(
        Schedule.exponential(delay, 3).pipe(
          Schedule.setInputType<GitHubReadError>(),
          Schedule.while(({ input }) => retryable(input)),
          Schedule.upTo({ times: RETRIES }),
          Schedule.tap(({ input, attempt }) =>
            Effect.sync(() => {
              log(`${input.message}; retry ${attempt}/${RETRIES}`);
            }),
          ),
        ),
      ),
    );

  const send = Effect.fnUntraced(function* (
    url: string,
    init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
  ): Effect.fn.Return<{ status: number; text: string; headers: Headers }, GitHubReadError> {
    const authorization = `bearer ${yield* Cache.get(tokens, TOKEN)}`;
    const { res, text } = yield* Effect.tryPromise({
      try: async (signal) => {
        const answer = await doFetch(url, {
          method: init.method,
          headers: { authorization, "user-agent": "inbox", ...init.headers },
          ...(init.body !== undefined && { body: init.body }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        });
        return { res: answer, text: await answer.text() };
      },
      catch: (cause) =>
        new GitHubNetworkError({ message: `GitHub request failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause }),
    });
    if (RETRYABLE.has(res.status)) return yield* new GitHubHttpError({ status: res.status, message: `GitHub HTTP ${res.status}` });
    const limited =
      res.status === 429 ||
      (res.status === 403 &&
        (res.headers.has("retry-after") || res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(text)));
    if (limited) {
      const resetAt = resetFrom(res.headers);
      return yield* new GitHubRateLimited({ resetAt, message: `GitHub rate limited until ${resetAt} (HTTP ${res.status})` });
    }
    if (res.status === 401) {
      yield* Cache.invalidate(tokens, TOKEN); // re-read `gh auth token` next time
      return yield* new GitHubAuthError({ reason: "rejected", message: "GitHub rejected the token (HTTP 401): run `gh auth login`" });
    }
    if (!res.ok && res.status !== 304)
      return yield* new GitHubHttpError({ status: res.status, message: `GitHub HTTP ${res.status}: ${text.slice(0, 200)}` });
    return { status: res.status, text, headers: res.headers };
  });

  const ask = Effect.fnUntraced(function* (body: string): Effect.fn.Return<unknown, GitHubReadError> {
    const { text, headers } = yield* send(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body });
    const a = yield* decode(() => answerOf(text));
    if (a.rateLimit) last = { remaining: a.rateLimit.remaining, reset_at: a.rateLimit.resetAt };
    if (a.forbidden) log(`skipped inaccessible data: ${a.forbidden.message}`);
    if (a.limited) {
      const resetAt = resetFrom(headers);
      return yield* new GitHubRateLimited({ resetAt, message: `GitHub rate limited until ${resetAt} (${a.msg})` });
    }
    if (a.failed) return yield* new GitHubGraphQLError({ message: `GitHub: ${a.msg}`, ...(a.types.length > 0 && { types: a.types }) });
    return a.data;
  });

  function query(doc: string, variables: Record<string, unknown> = {}): Effect.Effect<unknown, GitHubReadError> {
    if (/\bmutation\b/i.test(doc)) return Effect.die(new Error("Inbox is read-only: refusing to send a mutation"));
    const body = JSON.stringify({ query: doc, variables });
    return Effect.suspend((): Effect.Effect<unknown, GitHubReadError> => {
      const budget = last;
      // Stop before spending the last of the budget; the sync loop waits for resetAt.
      if (budget && budget.remaining < MIN_REMAINING && Date.parse(budget.reset_at) > Date.now()) {
        const message = `GitHub rate limited until ${budget.reset_at} (${budget.remaining} points left)`;
        return Effect.fail(new GitHubRateLimited({ resetAt: budget.reset_at, message }));
      }
      return retrying(ask(body));
    });
  }

  function get(
    path: string,
    init: { method?: string; headers?: Record<string, string> } = {},
  ): Effect.Effect<RestResponse, GitHubReadError> {
    const method = init.method ?? "GET";
    if (method.toUpperCase() !== "GET") return Effect.die(new Error(`Inbox is read-only: refusing to send ${method}`));
    if (!path.startsWith("/") || path.startsWith("//")) return Effect.die(new Error(`not a GitHub API path: ${path}`));
    const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...init.headers };
    return retrying(
      send(REST + path, { method: "GET", headers }).pipe(
        Effect.flatMap((r) =>
          decode(() => ({ status: r.status, headers: r.headers, data: r.status === 304 ? null : (JSON.parse(r.text) as unknown) })),
        ),
      ),
    );
  }

  return { query, get, rateLimit: () => last };
}
