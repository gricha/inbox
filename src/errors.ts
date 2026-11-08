// The desk's expected failures, as tagged errors: an Effect's error channel names them, catchTag recovers from one, and
// each carries the words the owner sees verbatim (its message). A bug or a broken invariant is a defect instead (a throw
// inside Effect code, or Effect.die) and never gets a class here. docs/effect.md has the rules. Tags are unique across
// families (GitHub's 403 is GitHubForbidden, never Forbidden). A class added before its first user carries
// `@public until C<n>` (knip skips it) until the step that first uses it removes the tag.
import { Data } from "effect";

// ---------------------------------------------------------------- what the HTTP API refuses with (status: its answer)

// What you sent can't be read or isn't allowed.
/** @public until C4b */
export class BadRequest extends Data.TaggedError("BadRequest")<{ readonly message: string }> {
  get status(): 400 {
    return 400;
  }
}

// Not from here: another site, another host, or a write only the desk's own window may send.
/** @public until C5a */
export class Forbidden extends Data.TaggedError("Forbidden")<{ readonly message: string }> {
  get status(): 403 {
    return 403;
  }
}

// No such item, board, ask, inquiry, automation or route.
/** @public until C4b */
export class NotFound extends Data.TaggedError("NotFound")<{ readonly message: string }> {
  get status(): 404 {
    return 404;
  }
}

// A ref that matches more than one item: the candidates go back so the caller can pick.
/** @public until C5a */
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
/** @public until C4b */
export class Conflict extends Data.TaggedError("Conflict")<{ readonly message: string }> {
  get status(): 409 {
    return 409;
  }
}

// You changed an older version than the one there now (the policy's or rules' base, the head you approved).
/** @public until C5a */
export class Stale extends Data.TaggedError("Stale")<{ readonly message: string }> {
  get status(): 409 {
    return 409;
  }
}

// The same write is already on its way: the desk refuses a second one at once rather than queueing it.
/** @public until C5b */
export class Busy extends Data.TaggedError("Busy")<{ readonly message: string }> {
  get status(): 409 {
    return 409;
  }
}

// What the desk passes on: GitHub refused or failed, or your agent didn't start. cause is the original error object,
// kept as is: Sentry skips one report() already sent.
/** @public until C5b */
export class Upstream extends Data.TaggedError("Upstream")<{ readonly message: string; readonly cause?: unknown }> {
  get status(): 502 {
    return 502;
  }
}

// Your draft is marked ready on GitHub, but asking the reviewers failed: half done, so nothing is rolled back. Its cause
// is the writer's error, so it's still reported.
/** @public until C5b */
export class ReviewersNotAsked extends Data.TaggedError("ReviewersNotAsked")<{ readonly message: string; readonly cause?: unknown }> {
  get status(): 502 {
    return 502;
  }
}

// The desk can't answer yet: it's starting (the first sync), or its rules have errors.
/** @public until C5a */
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

// ---------------------------------------------------------------- files

type FsOp = "read" | "write" | "rename" | "copy" | "mkdir" | "realpath" | "readdir" | "remove" | "stat" | "append" | "watch";

// A file the desk reads or writes failed: cause is Node's own error (its code says which: ENOENT, EACCES…), and its
// message is Node's, which already names the file.
/** @public until C3 */
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
/** @public until C3 */
export const fsError =
  (op: FsOp, path: string) =>
  (cause: unknown): FsError =>
    new FsError({ op, path, cause });

// ---------------------------------------------------------------- child processes (claude, gh)

// The command isn't on PATH (or cmd.exe can't find it): the hint, what to install, is the whole message.
export class CommandNotFound extends Data.TaggedError("CommandNotFound")<{ readonly command: string; readonly hint: string }> {
  override get message(): string {
    return this.hint;
  }
}

// No answer in time: it was stopped, and what it started with it.
export class CommandTimeout extends Data.TaggedError("CommandTimeout")<{ readonly command: string; readonly timeoutMs: number }> {
  override get message(): string {
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

// It exited non-zero or couldn't start: the last lines it wrote to stderr, else Node's error (cause), else its exit.
export class CommandFailed extends Data.TaggedError("CommandFailed")<{
  readonly command: string;
  readonly code: number | null;
  readonly signal: string | null;
  readonly stderr: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    const why =
      this.stderr || (this.cause instanceof Error ? this.cause.message : `${this.command} exited with ${this.code ?? this.signal}`);
    return why.trim().split("\n").slice(-3).join(" ");
  }
}

// What a command printed doesn't parse (gh's one JSON object per line): cause is the parser's error, whose words show.
export class CommandBadOutput extends Data.TaggedError("CommandBadOutput")<{ readonly command: string; readonly cause: unknown }> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : `${this.command} printed something unreadable`;
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

// claude answered with an error (is_error): the API's message ("Overloaded"), and its status when it gave one.
export class ClaudeApiError extends Data.TaggedError("ClaudeApiError")<{ readonly message: string; readonly status?: number }> {}

// What claude answered can't be read, or isn't an answer (no summary): excerpt is what it printed, cause the parser's error.
export class ClaudeBadOutput extends Data.TaggedError("ClaudeBadOutput")<{
  readonly message: string;
  readonly excerpt?: string;
  readonly cause?: unknown;
}> {}

export type ClaudeError = ClaudeNotLoggedIn | ClaudeApiError | ClaudeBadOutput;

// ---------------------------------------------------------------- GitHub

// The pages of a PR's files were fetched across a push and disagree on its head commit.
export class PrChangedDuringFetch extends Data.TaggedError("PrChangedDuringFetch")<{ readonly id: string }> {
  override get message(): string {
    return "the PR changed while its diff was fetched: open it again";
  }
}

// ---------------------------------------------------------------- legacy (removed in C6, with DeskError)

// An error the HTTP API answers with its status: 400 for what you sent, 404, 409 for a state that refuses it, 502 for GitHub.
export class DeskError extends Error {
  status: number;
  candidates?: string[];
  constructor(status: number, message: string, candidates?: string[]) {
    super(message);
    this.status = status;
    this.candidates = candidates;
  }
}

const LEGACY_TAGS: Record<number, ErrorBody["tag"]> = {
  400: "BadRequest",
  403: "Forbidden",
  404: "NotFound",
  409: "Conflict",
  502: "Upstream",
  503: "Unavailable",
};

// A DeskError's answer, with the tag its status and words say. effect-bridge(C6): goes with DeskError.
export function legacyBody(e: DeskError): ErrorBody {
  const candidates = e.candidates?.length ? [...e.candidates] : undefined;
  const tag: ErrorBody["tag"] = candidates
    ? "AmbiguousRef"
    : e.status === 502 && e.message.startsWith("Marked it ready")
      ? "ReviewersNotAsked"
      : (LEGACY_TAGS[e.status] ?? "Internal");
  const reason = e.status === 503 ? (e.message.startsWith("config has errors") ? "config" : "starting") : undefined;
  return { error: e.message, tag, ...(candidates && { candidates }), ...(reason && { reason }) };
}
