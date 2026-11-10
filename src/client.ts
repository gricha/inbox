// Typed HTTP client for the desk API. Used by the CLI and the MCP server: each call is an Effect that fails with one of
// the client's own errors below, decoded from the desk's answer ({ error, tag, candidates?, reason? }, docs/effect.md →
// The wire).

import { Data, Effect } from "effect";
import type { ErrorBody } from "./errors.ts";
import {
  UNTIL,
  type Action,
  type ActivityPage,
  type AiReview,
  type Ask,
  type AskPlace,
  type Automation,
  type AutomationBody,
  type AutomationView,
  type CriteriaView,
  type Criterion,
  type CriterionBody,
  type Inquiry,
  type InquiryLink,
  type InquiryOption,
  type SessionCard,
  type BoardView,
  type ConfigDoc,
  type ConfigError,
  type FieldDoc,
  type FocusView,
  type InflightView,
  type ItemDetail,
  type ItemState,
  type Overview,
  type PolicyDoc,
  type PreviewResult,
  type QueueView,
  type SettingsView,
  type SettingValue,
  type Until,
} from "./types.ts";

export interface ActResult {
  ok: true;
  state: ItemState;
  undo_seq: number;
}
// The server stores "activity" as done-until-activity, so the state alone doesn't say it.
export function untilText(until: string | undefined, s: ItemState, time: (iso: string) => string): string {
  if (!until) return "";
  if (until === "activity") return " until someone else acts";
  if (s.snooze_when) return ` until ${UNTIL[s.snooze_when.split(":")[0] as Until]}`;
  if (s.snooze_until) return ` until ${time(s.snooze_until)}${s.snooze_on_activity ? " or activity" : ""}`;
  return "";
}
export interface AddResult {
  ok: true;
  item: ItemDetail;
  undo_seq: number;
}
export interface StatusInfo {
  now: number;
  today: number;
  new: number;
  text: string;
}
export interface SettingsPatch {
  set?: Record<string, SettingValue>;
  reset?: string[];
}

// Nothing listens on the desk's port: it isn't running.
class DeskDown extends Data.TaggedError("DeskDown")<{ readonly cause?: unknown }> {
  override get message(): string {
    return "desk is not running — start it with: desk serve";
  }
}

// The request got no answer: it timed out, or the connection failed. Its words are fetch's ("The operation was aborted due
// to timeout").
class DeskNoAnswer extends Data.TaggedError("DeskNoAnswer")<{ readonly cause: unknown }> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

// The desk refused: its status and words, and its tag (and a 503's reason) to tell refusals apart by. An older desk sends
// no tag: its status says it, and a 503's words its reason. The message names the candidates an ambiguous ref matched.
export class DeskApiError extends Data.TaggedError("DeskApiError")<{
  readonly status: number;
  readonly said: string;
  readonly tag: ErrorBody["tag"];
  readonly candidates: readonly string[];
  readonly reason?: "starting" | "config";
}> {
  override get message(): string {
    const msg = this.said || `HTTP ${this.status}`;
    return this.candidates.length ? `${msg} — candidates: ${this.candidates.join(", ")}` : msg;
  }
}

export type ClientError = DeskDown | DeskNoAnswer | DeskApiError;

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

function refusal(status: number, data: unknown): DeskApiError {
  const b = (typeof data === "object" && data !== null ? data : {}) as Partial<ErrorBody>;
  const said = b.error ?? "";
  const candidates = b.candidates ?? [];
  const tag = b.tag ?? (status === 409 && candidates.length ? "AmbiguousRef" : (BY_STATUS[status] ?? "Internal"));
  const reason = status === 503 ? (b.reason ?? (said.includes("config") ? "config" : "starting")) : undefined;
  return new DeskApiError({ status, said, tag, candidates, ...(reason && { reason }) });
}

// DESK_URL: a desk on another machine, at its tailnet address (DESK_TOKEN is its device token); else this machine's.
export function baseUrl(): string {
  return (process.env.DESK_URL?.trim().replace(/\/+$/, "") ?? "") || `http://127.0.0.1:${(process.env.DESK_PORT ?? "") || 47823}`;
}

function refused(e: unknown): boolean {
  const cause = (e as { cause?: { code?: string; errors?: { code?: string }[] } } | null)?.cause;
  return cause?.code === "ECONNREFUSED" || !!cause?.errors?.some((x) => x.code === "ECONNREFUSED");
}

// A token only ever goes over HTTPS.
const overNetwork = (path: string, init: RequestInit): Promise<Response> => {
  const base = baseUrl();
  const token = process.env.DESK_TOKEN;
  if (!token || !base.startsWith("https://")) return fetch(base + path, init);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(base + path, { ...init, headers });
};

const q = encodeURIComponent;

// `send` is fetch over loopback by default; the server's /mcp passes its own app to call the same routes in-process.
export function createClient(send: (path: string, init: RequestInit) => Response | Promise<Response> = overNetwork) {
  function call<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Effect.Effect<T, ClientError> {
    return Effect.gen(function* () {
      const json = body === undefined ? undefined : JSON.stringify(body); // a body that can't be encoded is a bug, not "no answer"
      const res = yield* Effect.tryPromise({
        try: (signal) =>
          Promise.resolve(
            send(path, {
              method,
              headers: json === undefined ? undefined : { "content-type": "application/json" },
              body: json,
              signal: timeoutMs ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : signal,
            }),
          ),
        catch: (cause) => (refused(cause) ? new DeskDown({ cause }) : new DeskNoAnswer({ cause })),
      });
      // A body that isn't JSON reads as null, as before: a refusal still says what it is by its status.
      const data = yield* Effect.orElseSucceed(
        Effect.tryPromise({ try: (): Promise<unknown> => res.json(), catch: (cause) => cause }),
        () => null,
      );
      if (!res.ok) return yield* refusal(res.status, data);
      return data as T;
    });
  }

  return {
    overview: () => call<Overview>("GET", "/api/overview"),
    focus: () => call<FocusView>("GET", "/api/focus"),
    queue: () => call<QueueView>("GET", "/api/queue"),
    board: (id: string) => call<BoardView>("GET", `/api/boards/${q(id)}`),
    item: (ref: string) => call<ItemDetail>("GET", `/api/item?id=${q(ref)}`),
    act: (id: string, action: Action, until?: string) => call<ActResult>("POST", "/api/act", { id, action, until }),
    undo: (seq?: number) => call<{ ok: true; id: string; action: Action }>("POST", "/api/undo", { seq }),
    add: (ref: string, why?: string, from?: string) =>
      call<AddResult>("POST", "/api/add", { id: ref, ...(why !== undefined && { why }), ...(from !== undefined && { from }) }),
    sync: () => call<{ ok: true }>("POST", "/api/sync", {}),
    getConfig: () => call<ConfigDoc>("GET", "/api/config"),
    previewConfig: (text: string) => call<PreviewResult>("POST", "/api/config/preview", { text }),
    putConfig: (text: string, base?: string) =>
      call<{ ok: boolean; errors: ConfigError[]; warnings?: ConfigError[] }>("PUT", "/api/config", { text, base }),
    policy: () => call<PolicyDoc>("GET", "/api/policy"),
    putPolicy: (text: string, base: string) => call<{ ok: true; hash: string }>("PUT", "/api/policy", { text, base }),
    fields: () => call<FieldDoc[]>("GET", "/api/fields"),
    settings: () => call<SettingsView>("GET", "/api/settings"),
    putSettings: (patch: SettingsPatch) =>
      call<{ ok: boolean; errors: ConfigError[]; settings: SettingsView }>("PUT", "/api/settings", patch),
    status: (timeoutMs?: number) => call<StatusInfo>("GET", "/api/status", undefined, timeoutMs),
    aiReview: (id: string, force = false) => call<{ ok: true; ai: AiReview }>("POST", `/api/review/${q(id)}/ai`, { force }, 360_000),
    // Merging, for the coordinator: your handed-off PRs, a status line on one, and handing one back. All local.
    inflight: () => call<InflightView>("GET", "/api/inflight"),
    note: (id: string, text: string) => call<{ ok: true; text: string }>("POST", `/api/inflight/${q(id)}/note`, { text }),
    handBack: (id: string, why: string) => call<{ ok: true; reason: string }>("POST", `/api/inflight/${q(id)}/handback`, { why }),
    answer: (id: string, text: string) => call<{ ok: true; ask: Ask }>("POST", `/api/asks/${q(id)}/answer`, { text }),
    askPlace: (id: string) => call<AskPlace>("GET", `/api/asks/${q(id)}`),
    // An agent's question for the user, and their answer once they give it.
    inquire: (b: { question: string; from: string; context: string; options?: InquiryOption[]; links?: InquiryLink[]; item?: string }) =>
      call<{ ok: true; inquiry: Inquiry }>("POST", "/api/inquiries", b),
    inquiry: (id: string) => call<Inquiry>("GET", `/api/inquiries/${q(id)}`),
    session: (ref: string) => call<SessionCard>("GET", `/api/sessions/${q(ref)}`),
    unreadAnswers: () => call<Inquiry[]>("GET", "/api/inquiries/unread"),
    answerRead: (id: string) => call<{ ok: true; inquiry: Inquiry }>("POST", `/api/inquiries/${q(id)}/read`),
    automations: () => call<AutomationView[]>("GET", "/api/automations"),
    criteria: () => call<CriteriaView>("GET", "/api/criteria"),
    setCriterion: (id: string, b: CriterionBody) => call<{ ok: true; criterion: Criterion }>("PUT", `/api/criteria/${q(id)}`, b),
    deleteCriterion: (id: string) => call<{ ok: true }>("DELETE", `/api/criteria/${q(id)}`),
    setAutomation: (id: string, b: AutomationBody) => call<{ ok: true; automation: Automation }>("PUT", `/api/automations/${q(id)}`, b),
    runAutomation: (id: string) => call<{ ok: true; running: string }>("POST", `/api/automations/${q(id)}/run`),
    activity: (o: { after?: number; wait?: number; limit?: number; item?: string } = {}) => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(o)) if (v !== undefined) params.set(k, String(v));
      return call<ActivityPage>("GET", `/api/activity?${params.toString()}`, undefined, ((o.wait ?? 0) + 15) * 1000);
    },
    health: () => call<{ ok: true; version: string }>("GET", "/health"),
    // Pairing another device (src/remote.ts): a code to trade there, or a token here; the trade, from the other device.
    pairCode: () => call<{ code: string; expires_at: string; url: string; pair_url: string }>("POST", "/api/pair/code", {}),
    pairToken: (name: string) => call<{ url: string; token: string }>("POST", "/api/pair/token", { name }),
    trade: (code: string, name: string) => call<{ ok: true; token: string }>("POST", "/api/pair", { code, name, kind: "device" }),
  };
}
export type DeskClient = ReturnType<typeof createClient>;

export const {
  overview,
  queue,
  board,
  item,
  act,
  undo,
  add,
  sync,
  getConfig,
  previewConfig,
  putConfig,
  fields,
  settings,
  putSettings,
  status,
  aiReview,
  health,
  pairCode,
  pairToken,
} = createClient();
