// Read-only GitHub GraphQL transport: token, retries, rate-limit tracking.

import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const ENDPOINT = "https://api.github.com/graphql";
const RETRYABLE = new Set([502, 503, 504]);
const RETRIES = 2;
const MIN_REMAINING = 200;
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

interface GqlError { type?: string; message: string }
interface GqlResponse { data?: { rateLimit?: { remaining: number; resetAt: string } } | null; errors?: GqlError[] }

export interface ClientOptions {
  token?: string;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
  retryDelayMs?: number;
}

export interface Client {
  query<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
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
        : promisify(execFile)("gh", ["auth", "token"]).then(
            (r) => r.stdout.trim(),
            (e) => {
              token = undefined;
              throw new Error(e.code === "ENOENT" ? GH_MISSING : `no GitHub token: set GITHUB_TOKEN or run \`gh auth login\` (${e.message})`);
            },
          ));

  async function attempt(body: string): Promise<{ json: GqlResponse; headers: Headers }> {
    const authorization = `bearer ${await getToken()}`;
    let res: Response, text: string;
    try {
      res = await doFetch(ENDPOINT, {
        method: "POST",
        headers: { authorization, "content-type": "application/json", "user-agent": "review-desk" },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      text = await res.text();
    } catch (e) {
      throw new RetryableError(`GitHub request failed: ${(e as Error).message}`);
    }
    if (RETRYABLE.has(res.status)) throw new RetryableError(`GitHub HTTP ${res.status}`);
    const limited = res.status === 429 || (res.status === 403 && (res.headers.has("retry-after") || res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(text)));
    if (limited) throw new RateLimitedError(resetFrom(res.headers), `HTTP ${res.status}`);
    if (res.status === 401) {
      token = undefined; // re-read `gh auth token` next time
      throw new Error("GitHub rejected the token (HTTP 401): run `gh auth login`");
    }
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status}: ${text.slice(0, 200)}`);
    return { json: JSON.parse(text), headers: res.headers };
  }

  async function query<T>(doc: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (/\bmutation\b/i.test(doc)) throw new Error("review-desk is read-only: refusing to send a mutation");
    // Stop before spending the last of the budget; the sync loop waits for resetAt.
    if (last && last.remaining < MIN_REMAINING && Date.parse(last.reset_at) > Date.now()) {
      throw new RateLimitedError(last.reset_at, `${last.remaining} points left`);
    }
    const body = JSON.stringify({ query: doc, variables });
    for (let i = 0; ; i++) {
      try {
        const { json, headers } = await attempt(body);
        const rl = json.data?.rateLimit;
        if (rl) last = { remaining: rl.remaining, reset_at: rl.resetAt };
        // Those nodes come back null and callers skip them; with no data at all, every error is fatal.
        const errors = (json.errors ?? []).filter((e) => !(json.data && PARTIAL.has(e.type ?? "")));
        const forbidden = json.data && json.errors?.find((e) => e.type === "FORBIDDEN");
        if (forbidden) log(`skipped inaccessible data: ${forbidden.message}`);
        const msg = errors.map((e) => e.message).join("; ");
        if (errors.some((e) => e.type === "RATE_LIMITED" || /rate limit/i.test(e.message))) throw new RateLimitedError(resetFrom(headers), msg);
        if (errors.some((e) => /timeout/i.test(e.message))) throw new RetryableError(`GitHub: ${msg}`);
        if (errors.length) throw new Error(`GitHub: ${msg}`);
        return json.data as T;
      } catch (e) {
        if (!(e instanceof RetryableError) || i >= RETRIES) throw e;
        log(`${e.message}; retry ${i + 1}/${RETRIES}`);
        await sleep(delay * 3 ** i);
      }
    }
  }

  return { query, rateLimit: () => last };
}
