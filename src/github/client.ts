// Read-only GitHub transport (GraphQL queries and REST GETs): token, retries, rate-limit tracking.

import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const ENDPOINT = "https://api.github.com/graphql";
const REST = "https://api.github.com";
const RETRYABLE = new Set([502, 503, 504]);
const RETRIES = 2;
const MIN_REMAINING = 200;
// oxlint-disable-next-line typescript/strict-void-return -- promisify picks execFile's util.promisify.custom form, so no return value is discarded
const execFileAsync = promisify(execFile);
// Per-node errors that leave the rest of the response usable: a deleted node, or one the token can't see (e.g. SAML).
const PARTIAL = new Set(["NOT_FOUND", "FORBIDDEN"]);
export const GH_MISSING = "GitHub CLI (gh) not found: install it from https://cli.github.com and run gh auth login, or set GITHUB_TOKEN";

export class RateLimitedError extends Error {
  resetAt: string;
  constructor(resetAt: string, detail: string) {
    super(`GitHub rate limited until ${resetAt} (${detail})`);
    this.name = "RateLimitedError";
    this.resetAt = resetAt;
  }
}

class RetryableError extends Error {}

interface GqlError {
  type?: string;
  message: string;
}
interface GqlResponse {
  data?: { rateLimit?: { remaining: number; resetAt: string } } | null;
  errors?: GqlError[];
}

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
  query<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
  // A REST read, e.g. "/notifications?all=true". Anything but GET is refused, so it can't mark threads read.
  get(path: string, init?: { method?: string; headers?: Record<string, string> }): Promise<RestResponse>;
  rateLimit(): { remaining: number; reset_at: string } | null;
}

function resetFrom(h: Headers): string {
  const after = h.get("retry-after");
  const reset = h.get("x-ratelimit-reset");
  if (after) return new Date(Date.now() + Number(after) * 1000).toISOString();
  if (reset && h.get("x-ratelimit-remaining") === "0") return new Date(Number(reset) * 1000).toISOString();
  return new Date(Date.now() + 60_000).toISOString(); // GitHub's advice for secondary limits: wait at least a minute
}

export function createClient(opts: ClientOptions = {}): Client {
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log ?? (() => {});
  const delay = opts.retryDelayMs ?? 1000;
  let token: Promise<string> | undefined;
  let last: { remaining: number; reset_at: string } | null = null;

  const getToken = () =>
    (token ??= opts.token
      ? Promise.resolve(opts.token)
      : process.env.GITHUB_TOKEN
        ? Promise.resolve(process.env.GITHUB_TOKEN)
        : execFileAsync("gh", ["auth", "token"]).then(
            (r) => r.stdout.trim(),
            (e: NodeJS.ErrnoException) => {
              token = undefined;
              throw new Error(
                e.code === "ENOENT" ? GH_MISSING : `no GitHub token: set GITHUB_TOKEN or run \`gh auth login\` (${e.message})`,
              );
            },
          ));

  async function send(url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }) {
    const authorization = `bearer ${await getToken()}`;
    let res: Response, text: string;
    try {
      res = await doFetch(url, {
        method: init.method,
        headers: { authorization, "user-agent": "review-desk", ...init.headers },
        body: init.body,
        signal: AbortSignal.timeout(30_000),
      });
      text = await res.text();
    } catch (e) {
      throw new RetryableError(`GitHub request failed: ${(e as Error).message}`);
    }
    if (RETRYABLE.has(res.status)) throw new RetryableError(`GitHub HTTP ${res.status}`);
    const limited =
      res.status === 429 ||
      (res.status === 403 &&
        (res.headers.has("retry-after") || res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(text)));
    if (limited) throw new RateLimitedError(resetFrom(res.headers), `HTTP ${res.status}`);
    if (res.status === 401) {
      token = undefined; // re-read `gh auth token` next time
      throw new Error("GitHub rejected the token (HTTP 401): run `gh auth login`");
    }
    if (!res.ok && res.status !== 304) throw new Error(`GitHub HTTP ${res.status}: ${text.slice(0, 200)}`);
    return { status: res.status, text, headers: res.headers };
  }

  async function retrying<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof RetryableError) || i >= RETRIES) throw e;
        log(`${e.message}; retry ${i + 1}/${RETRIES}`);
        await sleep(delay * 3 ** i);
      }
    }
  }

  function query<T>(doc: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (/\bmutation\b/i.test(doc)) return Promise.reject(new Error("review-desk is read-only: refusing to send a mutation"));
    // Stop before spending the last of the budget; the sync loop waits for resetAt.
    if (last && last.remaining < MIN_REMAINING && Date.parse(last.reset_at) > Date.now()) {
      return Promise.reject(new RateLimitedError(last.reset_at, `${last.remaining} points left`));
    }
    const body = JSON.stringify({ query: doc, variables });
    return retrying(async () => {
      const { text, headers } = await send(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body });
      const json = JSON.parse(text) as GqlResponse;
      const rl = json.data?.rateLimit;
      if (rl) last = { remaining: rl.remaining, reset_at: rl.resetAt };
      // Those nodes come back null and callers skip them; with no data at all, every error is fatal.
      const errors = (json.errors ?? []).filter((e) => !(json.data && PARTIAL.has(e.type ?? "")));
      const forbidden = json.data && json.errors?.find((e) => e.type === "FORBIDDEN");
      if (forbidden) log(`skipped inaccessible data: ${forbidden.message}`);
      const msg = errors.map((e) => e.message).join("; ");
      if (errors.some((e) => e.type === "RATE_LIMITED" || /rate limit/i.test(e.message)))
        throw new RateLimitedError(resetFrom(headers), msg);
      if (errors.some((e) => /timeout/i.test(e.message))) throw new RetryableError(`GitHub: ${msg}`);
      if (errors.length) throw new Error(`GitHub: ${msg}`);
      return json.data as T;
    });
  }

  function get(path: string, init: { method?: string; headers?: Record<string, string> } = {}): Promise<RestResponse> {
    const method = init.method ?? "GET";
    if (method.toUpperCase() !== "GET") return Promise.reject(new Error(`review-desk is read-only: refusing to send ${method}`));
    if (!path.startsWith("/") || path.startsWith("//")) return Promise.reject(new Error(`not a GitHub API path: ${path}`));
    return retrying(async () => {
      const r = await send(REST + path, {
        method: "GET",
        headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...init.headers },
      });
      return { status: r.status, headers: r.headers, data: r.status === 304 ? null : (JSON.parse(r.text) as unknown) };
    });
  }

  return { query, get, rateLimit: () => last };
}
