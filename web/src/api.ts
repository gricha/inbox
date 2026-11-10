// The window's only HTTP layer: each call is an Effect that fails with one of the UI's own tagged errors below, decoded
// from the desk's error answer ({ error, tag, candidates?, reason? }, docs/effect.md → The wire). Components run them
// through runUi and answer for each failure themselves: a toast, a line on the page, the down banner.
import { Cause, Data, Effect, Exit } from "effect";
import type { ErrorBody } from "../../src/errors.ts";
import type {
  Action,
  AgentStatus,
  AiReview,
  InlineAt,
  Ask,
  AskLines,
  AsksView,
  ConfigDoc,
  ConfigError,
  FieldDoc,
  GitHubAction,
  InflightView,
  Automation,
  AutomationBody,
  AutomationView,
  CriteriaView,
  Criterion,
  CriterionBody,
  Inquiry,
  InquiryView,
  ItemDetail,
  ItemState,
  OmarchyTheme,
  Overview,
  PolicyDoc,
  PreviewResult,
  QueueView,
  Reviewer,
  RemoteView,
  ReviewView,
  SettingsView,
  SettingValue,
} from "../../src/types.ts";
import { report } from "./sentry.ts";

// ---------------------------------------------------------------- what an API call fails with

// The desk server isn't there: the request never got an answer, or the answer isn't JSON (the dev proxy's error page,
// the desk's "UI is starting" page). The down banner, and polling until it's back.
export class DeskUnreachable extends Data.TaggedError("DeskUnreachable")<{ readonly cause?: unknown }> {
  override get message(): string {
    return "desk server not reachable";
  }
}

// The desk is up but has nothing to show yet: its first sync (a 503 "starting"). A banner, and polling.
export class DeskStarting extends Data.TaggedError("DeskStarting")<{ readonly message: string }> {}

// The desk's rules have errors, so it never loaded (a 503 "config"): the notice that links to Settings → GitHub → Searches and rules.
export class DeskConfigBroken extends Data.TaggedError("DeskConfigBroken")<{ readonly message: string }> {}

// A 409: the state refuses it. kind is the desk's tag; Stale (what you edited changed meanwhile) is what Rules and Policy
// recover from. candidates: the items an ambiguous ref matched.
class DeskConflict extends Data.TaggedError("DeskConflict")<{
  readonly message: string;
  readonly kind: "AmbiguousRef" | "Stale" | "Busy" | "Conflict";
  readonly candidates?: readonly string[];
}> {}

// Ready for review landed on GitHub, asking the reviewers didn't (the wire's ReviewersNotAsked): half done, so the item
// stays gone.
class DeskReviewersNotAsked extends Data.TaggedError("DeskReviewersNotAsked")<{ readonly message: string }> {}

// Any other refusal (what you sent, not found, GitHub refused, a bug on the desk): its words, verbatim, in a toast.
class DeskRequestFailed extends Data.TaggedError("DeskRequestFailed")<{
  readonly message: string;
  readonly status: number;
  readonly kind: ErrorBody["tag"];
}> {}

// A 2xx whose body doesn't parse (cut short, not JSON after all): the parser's words, as before.
class DeskBadResponse extends Data.TaggedError("DeskBadResponse")<{ readonly status: number; readonly cause: unknown }> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

export type ApiError =
  DeskUnreachable | DeskStarting | DeskConfigBroken | DeskConflict | DeskReviewersNotAsked | DeskRequestFailed | DeskBadResponse;

// ---------------------------------------------------------------- this window's own

// Neither the Clipboard API nor the textarea fallback copied it.
export class ClipboardUnavailable extends Data.TaggedError("ClipboardUnavailable")<{ readonly cause?: unknown }> {
  override get message(): string {
    return "clipboard unavailable";
  }
}

// ---------------------------------------------------------------- calls

// An older desk sends no tag: its status says it.
const BY_STATUS: Partial<Record<number, ErrorBody["tag"]>> = {
  400: "BadRequest",
  401: "Unauthorized",
  403: "Forbidden",
  404: "NotFound",
  409: "Conflict",
  429: "TooManyRequests",
  502: "Upstream",
  503: "Unavailable",
};
// Saving over a base that changed is the only 409 these answer, whatever tag the desk sends.
const STALE = new Set(["PUT /api/policy", "PUT /api/config", "PUT /api/config/builtin"]);

function refusal(status: number, body: Partial<ErrorBody> | null, statusText: string, stale: boolean): ApiError {
  const message = body?.error ?? (statusText || String(status));
  const candidates = body?.candidates;
  const tag = body?.tag ?? (status === 409 && candidates?.length ? "AmbiguousRef" : (BY_STATUS[status] ?? "Internal"));
  if (status === 409 && stale) return new DeskConflict({ message, kind: "Stale", candidates });
  if (tag === "AmbiguousRef" || tag === "Stale" || tag === "Busy" || tag === "Conflict")
    return new DeskConflict({ message, kind: tag, candidates });
  if (tag === "Unavailable")
    return (body?.reason ?? (message.includes("config") ? "config" : "starting")) === "config"
      ? new DeskConfigBroken({ message })
      : new DeskStarting({ message });
  if (tag === "ReviewersNotAsked") return new DeskReviewersNotAsked({ message });
  return new DeskRequestFailed({ message, status, kind: tag });
}

function call<T>(method: string, path: string, body?: unknown): Effect.Effect<T, ApiError> {
  return Effect.suspend(() => {
    // One signal for the request and its body, so an interrupt while the body's still arriving stops the download too.
    const stop = new AbortController();
    return Effect.gen(function* () {
      const res = yield* Effect.tryPromise({
        try: () =>
          fetch(path, {
            method,
            headers: body === undefined ? undefined : { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: stop.signal,
          }),
        catch: (cause) => new DeskUnreachable({ cause }),
      });
      if (!(res.headers.get("content-type") ?? "").includes("json")) return yield* new DeskUnreachable({});
      const json = Effect.tryPromise({
        try: (): Promise<unknown> => res.json(),
        catch: (cause) => new DeskBadResponse({ status: res.status, cause }),
      });
      if (res.ok) return (yield* json) as T;
      // A refusal whose body doesn't parse still says what it is by its status.
      const answer = yield* json.pipe(Effect.orElseSucceed(() => null));
      return yield* Effect.fail(refusal(res.status, answer as Partial<ErrorBody> | null, res.statusText, STALE.has(`${method} ${path}`)));
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          stop.abort();
        }),
      ),
    );
  });
}

// Where the window runs an Effect: each failure it expects is answered inside (a toast, a line on the page), so what gets
// here is a bug, logged and reported. An interrupt (an effect's cleanup, StrictMode's unmount) is quiet. Nobody waits on
// it. A read passes its effect's signal; a write passes none, so leaving the page never cuts one short.
export function runUi<A>(effect: Effect.Effect<A>, options?: { readonly signal?: AbortSignal }): void {
  Effect.runCallback(effect, {
    ...options,
    onExit: (exit) => {
      if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return;
      console.error(Cause.pretty(exit.cause));
      report(Cause.squash(exit.cause));
    },
  });
}

export const api = {
  overview: () => call<Overview>("GET", "/api/overview"),
  queue: () => call<QueueView>("GET", "/api/queue"),
  item: (id: string) => call<ItemDetail>("GET", `/api/item?id=${encodeURIComponent(id)}`),
  act: (id: string, action: Action, until?: string) =>
    call<{ ok: true; state: ItemState; undo_seq: number }>("POST", "/api/act", { id, action, until }),
  // ahead: before you open it, so the desk starts no AI review or read for it.
  review: (id: string, ahead = false) => call<ReviewView>("GET", `/api/review/${encodeURIComponent(id)}${ahead ? "?ahead=1" : ""}`),
  aiReview: (id: string, force = false) => call<{ ok: true; ai: AiReview }>("POST", `/api/review/${encodeURIComponent(id)}/ai`, { force }),
  // The calls that write to GitHub: the review's Approve and replies, and Ready for review on your own draft.
  approve: (id: string, head_oid: string) =>
    call<{ ok: true; url: string }>("POST", `/api/review/${encodeURIComponent(id)}/approve`, { head_oid }),
  comment: (id: string, body: string) => call<{ ok: true; url: string }>("POST", `/api/review/${encodeURIComponent(id)}/comment`, { body }),
  // head_oid: the commit the review showed, so the line numbers are the ones you read.
  inline: (id: string, at: InlineAt, body: string, head_oid: string) =>
    call<{ ok: true; url: string }>("POST", `/api/review/${encodeURIComponent(id)}/inline`, { ...at, body, head_oid }),
  reply: (id: string, convo: string, body: string) =>
    call<{ ok: true; url: string }>("POST", `/api/review/${encodeURIComponent(id)}/reply`, { id: convo, body }),
  // With the reviewers you picked (node ids), asked right after it's marked ready.
  ready: (id: string, ask?: { users: string[]; teams: string[] }) =>
    call<{ ok: true; done: boolean }>("POST", `/api/review/${encodeURIComponent(id)}/ready`, ask ?? {}),
  askReviewers: (id: string, ask: { users: string[]; teams: string[] }) =>
    call<{ ok: true }>("POST", `/api/review/${encodeURIComponent(id)}/reviewers`, ask),
  inquiry: (id: string) => call<InquiryView>("GET", `/api/inquiries/${encodeURIComponent(id)}`),
  // A session that needs you: Kick or Resume starts it again where it left off, Open follows its own link.
  kickSession: (id: string) => call<{ ok: true; args: string[] }>("POST", `/api/sessions/${encodeURIComponent(id)}/kick`),
  openSession: (id: string) => call<{ ok: true; url: string }>("POST", `/api/sessions/${encodeURIComponent(id)}/open`),
  automations: () => call<AutomationView[]>("GET", "/api/automations"),
  criteria: () => call<CriteriaView>("GET", "/api/criteria"),
  setCriterion: (id: string, b: CriterionBody) =>
    call<{ ok: true; criterion: Criterion }>("PUT", `/api/criteria/${encodeURIComponent(id)}`, b),
  switchCriterion: (id: string, on: boolean) =>
    call<{ ok: true; criterion: Criterion }>("PUT", `/api/criteria/${encodeURIComponent(id)}/on`, { on }),
  deleteCriterion: (id: string) => call<{ ok: true }>("DELETE", `/api/criteria/${encodeURIComponent(id)}`),
  setAutomation: (id: string, b: AutomationBody) =>
    call<{ ok: true; automation: Automation }>("PUT", `/api/automations/${encodeURIComponent(id)}`, b),
  switchAutomation: (id: string, on: boolean) =>
    call<{ ok: true; automation: Automation }>("PUT", `/api/automations/${encodeURIComponent(id)}/on`, { on }),
  deleteAutomation: (id: string) => call<{ ok: true }>("DELETE", `/api/automations/${encodeURIComponent(id)}`),
  runAutomation: (id: string) => call<{ ok: true; running: string }>("POST", `/api/automations/${encodeURIComponent(id)}/run`),
  // Your answer to an agent's question, or leaving it unanswered.
  answerInquiry: (id: string, b: { text: string } | { dismiss: true }) =>
    call<{ ok: true; inquiry: Inquiry }>("POST", `/api/inquiries/${encodeURIComponent(id)}/answer`, b),
  reviewers: (id: string, q: string) => call<Reviewer[]>("GET", `/api/reviewers/${encodeURIComponent(id)}?q=${encodeURIComponent(q)}`),
  // The More menu's: close, draft, ready, merge, reopen, request changes (with a body, pinned to the head you read).
  github: (id: string, action: GitHubAction, more: { head_oid?: string; body?: string } = {}) =>
    call<{ ok: true; url: string }>("POST", "/api/github", { id, action, ...more }),
  inflight: () => call<InflightView>("GET", "/api/inflight"),
  // With an ask it stopped without answering: that ask goes to it again.
  wakeCoordinator: (ask?: string) => call<{ ok: true }>("POST", "/api/coordinator/wake", ask ? { ask } : {}),
  asks: () => call<AsksView>("GET", "/api/asks"),
  ask: (b: { text: string; item_id?: string; thread_id?: string; thread_url?: string; lines?: AskLines }) =>
    call<{ ok: true; ask: Ask }>("POST", "/api/ask", b),
  undo: (seq?: number) => call<{ ok: true; id: string; action?: string }>("POST", "/api/undo", seq ? { seq } : {}),
  sync: () => call<{ ok: true }>("POST", "/api/sync", {}),
  config: () => call<ConfigDoc>("GET", "/api/config"),
  preview: (text: string) => call<PreviewResult>("POST", "/api/config/preview", { text }),
  // A stale base fails with DeskConflict "Stale".
  saveConfig: (text: string, base?: string) => call<{ ok: boolean; errors: ConfigError[] }>("PUT", "/api/config", { text, base }),
  switchRule: (board: string, rule: string, on: boolean, base?: string) =>
    call<{ ok: boolean; errors: ConfigError[] }>("PUT", "/api/config/builtin", { board, rule, on, base }),
  fields: () => call<FieldDoc[]>("GET", "/api/fields"),
  settings: () => call<SettingsView>("GET", "/api/settings"),
  // Invalid values write nothing; `errors` says which keys and why.
  saveSettings: (patch: { set?: Record<string, SettingValue>; reset?: string[] }) =>
    call<{ ok: boolean; errors: ConfigError[]; settings: SettingsView }>("PUT", "/api/settings", patch),
  agents: () => call<AgentStatus>("GET", "/api/agents"),
  remote: () => call<RemoteView>("GET", "/api/remote"),
  revokeDevice: (id: string) => call<{ ok: true }>("DELETE", `/api/devices/${encodeURIComponent(id)}`),
  connectAgent: () => call<AgentStatus>("POST", "/api/agents/connect", {}),
  policy: () => call<PolicyDoc>("GET", "/api/policy"),
  omarchy: () => call<OmarchyTheme | null>("GET", "/api/omarchy"),
  // A stale `base` (the hash it was read at) fails with DeskConflict "Stale".
  savePolicy: (text: string, base: string) => call<{ ok: true; hash: string }>("PUT", "/api/policy", { text, base }),
};
