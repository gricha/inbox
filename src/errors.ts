// The desk's expected failures, as tagged errors: an Effect's error channel names them, catchTag recovers from one, and
// each carries the words the owner sees verbatim (its message). A bug or a broken invariant is a defect instead (a throw
// inside Effect code, or Effect.die) and never gets a class here. docs/effect.md has the rules. Tags are unique across
// families (GitHub's 403 is GitHubHttpError with its status, or GitHubRateLimited for a read's rate limit; never Forbidden).
import { Data } from "effect";

// What was thrown, in its words: an Error's message, else the value as text.
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------- what the HTTP API refuses with (status: its answer)

// What you sent can't be read or isn't allowed.
export class BadRequest extends Data.TaggedError("BadRequest")<{ readonly message: string }> {
  get status(): 400 {
    return 400;
  }
}

// Not from here: another site, another host, or a write only the desk's own window may send.
export class Forbidden extends Data.TaggedError("Forbidden")<{ readonly message: string }> {
  get status(): 403 {
    return 403;
  }
}

// No such item, board, ask, inquiry, automation or route.
export class NotFound extends Data.TaggedError("NotFound")<{ readonly message: string }> {
  get status(): 404 {
    return 404;
  }
}

// A ref that matches more than one item: the candidates go back so the caller can pick.
export class AmbiguousRef extends Data.TaggedError("AmbiguousRef")<{
  readonly message: string;
  readonly ref: string;
  readonly candidates: readonly string[];
}> {
  get status(): 409 {
    return 409;
  }
}

// A state that refuses it: in Merging already, not your PR, already answered, your agent is off…
export class Conflict extends Data.TaggedError("Conflict")<{ readonly message: string }> {
  get status(): 409 {
    return 409;
  }
}

// You changed an older version than the one there now (the policy's or rules' base, the head you approved).
export class Stale extends Data.TaggedError("Stale")<{ readonly message: string }> {
  get status(): 409 {
    return 409;
  }
}

// The same write is already on its way: the desk refuses a second one at once rather than queueing it.
export class Busy extends Data.TaggedError("Busy")<{ readonly message: string }> {
  get status(): 409 {
    return 409;
  }
}

// What the desk passes on: GitHub refused or failed, or your agent didn't start. cause is the original error object,
// kept as is: Sentry skips one report() already sent.
export class Upstream extends Data.TaggedError("Upstream")<{ readonly message: string; readonly cause?: unknown }> {
  get status(): 502 {
    return 502;
  }
}

// Your draft is marked ready on GitHub, but asking the reviewers failed: half done, so nothing is rolled back. Its cause
// is the writer's error, so it's still reported.
export class ReviewersNotAsked extends Data.TaggedError("ReviewersNotAsked")<{ readonly message: string; readonly cause?: unknown }> {
  get status(): 502 {
    return 502;
  }
}

// The desk can't answer yet: it's starting (the first sync), or its rules have errors.
export class Unavailable extends Data.TaggedError("Unavailable")<{ readonly message: string; readonly reason: "starting" | "config" }> {
  get status(): 503 {
    return 503;
  }
}

export type DeskHttpError =
  BadRequest | Forbidden | NotFound | AmbiguousRef | Conflict | Stale | Busy | Upstream | ReviewersNotAsked | Unavailable;

const HTTP_CLASSES = [
  BadRequest,
  Forbidden,
  NotFound,
  AmbiguousRef,
  Conflict,
  Stale,
  Busy,
  Upstream,
  ReviewersNotAsked,
  Unavailable,
] as const;

// By class, not by _tag: another family's error, or a plain object with the same tag, has no status to answer with.
export const isDeskHttpError = (u: unknown): u is DeskHttpError => HTTP_CLASSES.some((C) => u instanceof C);

// The JSON an HTTP error answers with. error and candidates are what every client read before tags; tag (and reason for
// a 503) let the UI and the CLI tell refusals apart without matching words. "Internal" is a 500: a failure or a bug the
// desk didn't expect. Readers decode `tag ?? fromStatus(status)`: older desks send no tag.
export type ErrorBody = {
  error: string;
  tag: DeskHttpError["_tag"] | "Internal";
  candidates?: string[];
  reason?: "starting" | "config";
};

export function errorBody(e: DeskHttpError): ErrorBody {
  if (e._tag === "AmbiguousRef") return { error: e.message, tag: e._tag, candidates: [...e.candidates] };
  if (e._tag === "Unavailable") return { error: e.message, tag: e._tag, reason: e.reason };
  return { error: e.message, tag: e._tag };
}

// ---------------------------------------------------------------- the desk's own server

// Its port couldn't be listened on: in use (another desk, most likely), or Node's error (cause) says why.
export class ListenFailed extends Data.TaggedError("ListenFailed")<{
  readonly port: number;
  readonly url: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    const c = this.cause as { code?: unknown } | null;
    if (typeof c === "object" && c !== null && c.code === "EADDRINUSE")
      return `port ${this.port} is in use; is desk already running? (${this.url})`;
    return this.cause instanceof Error ? this.cause.message : `couldn't listen on port ${this.port}: ${String(this.cause)}`;
  }
}

// ---------------------------------------------------------------- the rules' expressions (config.toml)

// A board's filter or priority, or a rule's when, doesn't parse, or names a field or function there isn't: the words the
// Rules page shows at its path. pos is where it went wrong (1-based), hint the field it may have meant.
export class ExprSyntaxError extends Data.TaggedError("ExprSyntaxError")<{
  readonly source: string;
  readonly message: string;
  readonly pos?: number;
  readonly hint?: string;
}> {}

// An expression that parsed but can't be worked out for an item: op on what isn't a number, `in` on what isn't a list or
// text, `matches` on a field's value that isn't a pattern. The rule doesn't match, and its trace keeps the words.
export class ExprEvalError extends Data.TaggedError("ExprEvalError")<{ readonly message: string; readonly op?: string }> {}

// ---------------------------------------------------------------- files

type FsOp = "read" | "write" | "rename" | "copy" | "mkdir" | "realpath" | "readdir" | "remove" | "stat" | "append" | "watch";

// A file the desk reads or writes failed: cause is Node's own error (its code says which: ENOENT, EACCES…), and its
// message is Node's, which already names the file.
export class FsError extends Data.TaggedError("FsError")<{ readonly op: FsOp; readonly path: string; readonly cause: unknown }> {
  get code(): string | undefined {
    const c = this.cause as { code?: unknown } | null;
    return typeof c === "object" && c !== null && typeof c.code === "string" ? c.code : undefined;
  }
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : `couldn't ${this.op} ${this.path}: ${String(this.cause)}`;
  }
}

// For Effect.try's and Effect.tryPromise's catch: `catch: fsError("write", file)`.
export const fsError =
  (op: FsOp, path: string) =>
  (cause: unknown): FsError =>
    new FsError({ op, path, cause });

// ---------------------------------------------------------------- child processes (claude, gh)

// The command isn't on PATH (or cmd.exe can't find it): the hint, what to install, is the whole message.
export class CommandNotFound extends Data.TaggedError("CommandNotFound")<{ readonly command: string; readonly hint: string }> {
  override get message(): string {
    return this.hint || `${this.command} not found`;
  }
}

// No answer in time: it was stopped, and what it started with it. summary: the words of a caller that has its own.
export class CommandTimeout extends Data.TaggedError("CommandTimeout")<{
  readonly command: string;
  readonly timeoutMs: number;
  readonly summary?: string;
}> {
  override get message(): string {
    if (this.summary) return this.summary;
    return `no answer in ${Math.round(this.timeoutMs / 60_000)} minutes, so it was stopped`;
  }
}

// It printed more than the desk keeps, so it was stopped.
export class CommandOutputTooLarge extends Data.TaggedError("CommandOutputTooLarge")<{
  readonly command: string;
  readonly limitBytes: number;
}> {
  override get message(): string {
    return `${this.command} printed more than ${this.limitBytes / 1024 / 1024} MB, so it was stopped`;
  }
}

// Exited non-zero or couldn't start: stderr's last lines, else Node's error, else its exit; summary is a caller's own words.
export class CommandFailed extends Data.TaggedError("CommandFailed")<{
  readonly command: string;
  readonly code: number | null;
  readonly signal: string | null;
  readonly stderr: string;
  readonly cause?: unknown;
  readonly summary?: string;
}> {
  override get message(): string {
    if (this.summary) return this.summary;
    const why =
      this.stderr || (this.cause instanceof Error ? this.cause.message : `${this.command} exited with ${this.code ?? this.signal}`);
    return why.trim().split("\n").slice(-3).join(" ") || `${this.command} exited with ${this.code ?? this.signal}`;
  }
}

// What a command printed doesn't parse (gh's one JSON object per line): cause is the parser's error, else detail says why.
export class CommandBadOutput extends Data.TaggedError("CommandBadOutput")<{
  readonly command: string;
  readonly cause?: unknown;
  readonly detail?: string;
}> {
  override get message(): string {
    return this.detail ?? (this.cause instanceof Error ? this.cause.message : `${this.command} printed something unreadable`);
  }
}

// An argument cmd.exe can't be given safely (a Windows claude.cmd shim): nothing was started.
export class UnsafeArgument extends Data.TaggedError("UnsafeArgument")<{ readonly message: string }> {}

export type CommandError = CommandNotFound | CommandTimeout | CommandOutputTooLarge | CommandFailed | UnsafeArgument;

// ---------------------------------------------------------------- Claude Code

// The whole message: retryAgents, paused() and the judge find it by suffix in the stored error texts.
export const NOT_LOGGED_IN = "Claude Code isn't logged in. Run `claude auth login` in a terminal.";

// An expired or missing login. detail is the CLI's own words ("401 OAuth access token has expired"), for the log.
export class ClaudeNotLoggedIn extends Data.TaggedError("ClaudeNotLoggedIn")<{ readonly detail: string }> {
  override get message(): string {
    return NOT_LOGGED_IN;
  }
}

// claude's is_error answer: the API's words, else its status, so the coordinator never keeps an empty error.
export class ClaudeApiError extends Data.TaggedError("ClaudeApiError")<{ readonly message: string; readonly status?: number }> {
  constructor(args: { readonly message: string; readonly status?: number }) {
    const said = args.message.trim()
      ? args.message
      : args.status === undefined
        ? "claude failed"
        : `claude failed: API error ${args.status}`;
    super({ ...args, message: said });
  }
}

// What claude answered can't be read, or isn't an answer (no summary): excerpt is what it printed, cause the parser's error.
export class ClaudeBadOutput extends Data.TaggedError("ClaudeBadOutput")<{
  readonly message: string;
  readonly excerpt?: string;
  readonly cause?: unknown;
}> {}

export type ClaudeError = ClaudeNotLoggedIn | ClaudeApiError | ClaudeBadOutput;

// ---------------------------------------------------------------- GitHub

// No token to send (gh isn't installed, or `gh auth token` failed: cause is its error), or GitHub refused the one a read
// sent (a 401, after which the token is read again). The message says what to do.
export class GitHubAuthError extends Data.TaggedError("GitHubAuthError")<{
  readonly reason: "gh_missing" | "no_token" | "rejected";
  readonly message: string;
  readonly cause?: unknown;
}> {}

// GitHub's rate limit, or the desk keeping the last of its budget: nothing more until resetAt (ISO).
export class GitHubRateLimited extends Data.TaggedError("GitHubRateLimited")<{ readonly resetAt: string; readonly message: string }> {}

// GitHub answered with an HTTP error: "GitHub HTTP 500: <the start of its body>" ("GitHub HTTP 503" alone after a read's retries).
export class GitHubHttpError extends Data.TaggedError("GitHubHttpError")<{ readonly status: number; readonly message: string }> {}

// GitHub took the query or the write and said no: "GitHub: <its messages>". types are its error types (INVALID…).
export class GitHubGraphQLError extends Data.TaggedError("GitHubGraphQLError")<{
  readonly message: string;
  readonly types?: readonly string[];
}> {}

// A read got no answer (the network failed, or nothing came in 30 seconds), after its retries. cause is fetch's error.
export class GitHubNetworkError extends Data.TaggedError("GitHubNetworkError")<{ readonly message: string; readonly cause: unknown }> {}

// GitHub's answer isn't JSON or isn't the shape asked for: the parser's words, and its error as cause.
export class GitHubBadResponse extends Data.TaggedError("GitHubBadResponse")<{ readonly message: string; readonly cause?: unknown }> {}

// A write whose outcome isn't known (no answer in time, the network failed, an answer without what it wrote): it may have
// landed, so it's never sent again by itself.
export class GitHubWriteUncertain extends Data.TaggedError("GitHubWriteUncertain")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// Every board search failed in a pass (what each listed before stays): the first one's words without its query, and its
// error as cause.
export class GitHubSearchesFailed extends Data.TaggedError("GitHubSearchesFailed")<{ readonly message: string; readonly cause: unknown }> {}

// GitHub has the PR or issue, but its details didn't come back (details skips a batch it refused): nothing was added.
export class GitHubNotFetched extends Data.TaggedError("GitHubNotFetched")<{ readonly id: string }> {
  override get message(): string {
    return `couldn't fetch ${this.id} from GitHub; try again`;
  }
}

export type GitHubReadError =
  GitHubAuthError | GitHubRateLimited | GitHubHttpError | GitHubGraphQLError | GitHubNetworkError | GitHubBadResponse;
export type GitHubWriteError = GitHubAuthError | GitHubHttpError | GitHubGraphQLError | GitHubWriteUncertain;
export type GitHubError = GitHubReadError | GitHubWriteError;

// The pages of a PR's files were fetched across a push and disagree on its head commit.
export class PrChangedDuringFetch extends Data.TaggedError("PrChangedDuringFetch")<{ readonly id: string }> {
  override get message(): string {
    return "the PR changed while its diff was fetched: open it again";
  }
}
