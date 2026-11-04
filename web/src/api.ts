import type {
  Action,
  AgentStatus,
  AiReview,
  Ask,
  AsksView,
  ConfigDoc,
  ConfigError,
  FieldDoc,
  GitHubAction,
  InflightView,
  Inquiry,
  ItemDetail,
  ItemState,
  Overview,
  PolicyDoc,
  PreviewResult,
  QueueView,
  Reviewer,
  ReviewView,
  SettingsView,
  SettingValue,
} from "../../src/types.ts";

class ApiError extends Error {
  status: number; // 0 = the desk server isn't reachable
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("desk server not reachable", 0);
  }
  // A non-JSON reply is the dev proxy's error page: the desk server itself is down.
  if (!(res.headers.get("content-type") ?? "").includes("json")) throw new ApiError("desk server not reachable", 0);
  const data: unknown = await res.json();
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? res.statusText, res.status);
  return data as T;
}

export const unreachable = (e: unknown) => e instanceof ApiError && e.status === 0;
// 503 = the server is up but still loading (first sync).
export const starting = (e: unknown) => e instanceof ApiError && e.status === 503;
export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const api = {
  overview: () => call<Overview>("GET", "/api/overview"),
  queue: () => call<QueueView>("GET", "/api/queue"),
  item: (id: string) => call<ItemDetail>("GET", `/api/item?id=${encodeURIComponent(id)}`),
  act: (id: string, action: Action, until?: string) =>
    call<{ ok: true; state: ItemState; undo_seq: number }>("POST", "/api/act", { id, action, until }),
  // ahead: before you open it, so the desk starts no AI review or read for it.
  review: (id: string, ahead = false) => call<ReviewView>("GET", `/api/review/${encodeURIComponent(id)}${ahead ? "?ahead=1" : ""}`),
  aiReview: (id: string, force = false) => call<{ ok: true; ai: AiReview }>("POST", `/api/review/${encodeURIComponent(id)}/ai`, { force }),
  // The calls that write to GitHub: the review view's approve key and replies, and Ready for review on your own draft.
  approve: (id: string, head_oid: string) =>
    call<{ ok: true; url: string }>("POST", `/api/review/${encodeURIComponent(id)}/approve`, { head_oid }),
  comment: (id: string, body: string) => call<{ ok: true; url: string }>("POST", `/api/review/${encodeURIComponent(id)}/comment`, { body }),
  reply: (id: string, convo: string, body: string) =>
    call<{ ok: true; url: string }>("POST", `/api/review/${encodeURIComponent(id)}/reply`, { id: convo, body }),
  // With the reviewers you picked (node ids), asked right after it's marked ready.
  ready: (id: string, ask?: { users: string[]; teams: string[] }) =>
    call<{ ok: true }>("POST", `/api/review/${encodeURIComponent(id)}/ready`, ask ?? {}),
  // Your answer to an agent's question, or leaving it unanswered.
  answerInquiry: (id: string, b: { text: string } | { dismiss: true }) =>
    call<{ ok: true; inquiry: Inquiry }>("POST", `/api/inquiries/${encodeURIComponent(id)}/answer`, b),
  reviewers: (id: string, q: string) => call<Reviewer[]>("GET", `/api/reviewers/${encodeURIComponent(id)}?q=${encodeURIComponent(q)}`),
  // The More menu's: close, draft, merge, reopen, request changes (with a body, pinned to the head you read).
  github: (id: string, action: GitHubAction, more: { head_oid?: string; body?: string } = {}) =>
    call<{ ok: true; url: string }>("POST", "/api/github", { id, action, ...more }),
  inflight: () => call<InflightView>("GET", "/api/inflight"),
  // With an ask it stopped without answering: that ask goes to it again.
  wakeCoordinator: (ask?: string) => call<{ ok: true }>("POST", "/api/coordinator/wake", ask ? { ask } : {}),
  asks: () => call<AsksView>("GET", "/api/asks"),
  ask: (b: { text: string; item_id?: string; thread_id?: string; thread_url?: string }) =>
    call<{ ok: true; ask: Ask }>("POST", "/api/ask", b),
  undo: (seq?: number) => call<{ ok: true; id: string; action?: string }>("POST", "/api/undo", seq ? { seq } : {}),
  sync: () => call<{ ok: true }>("POST", "/api/sync", {}),
  config: () => call<ConfigDoc>("GET", "/api/config"),
  preview: (text: string) => call<PreviewResult>("POST", "/api/config/preview", { text }),
  saveConfig: (text: string, base?: string) => call<{ ok: boolean; errors: ConfigError[] }>("PUT", "/api/config", { text, base }),
  fields: () => call<FieldDoc[]>("GET", "/api/fields"),
  settings: () => call<SettingsView>("GET", "/api/settings"),
  // Invalid values write nothing; `errors` says which keys and why.
  saveSettings: (patch: { set?: Record<string, SettingValue>; reset?: string[] }) =>
    call<{ ok: boolean; errors: ConfigError[]; settings: SettingsView }>("PUT", "/api/settings", patch),
  agents: () => call<AgentStatus>("GET", "/api/agents"),
  connectAgent: () => call<AgentStatus>("POST", "/api/agents/connect", {}),
  policy: () => call<PolicyDoc>("GET", "/api/policy"),
  // 409 when `base` (the hash it was read at) is stale.
  savePolicy: (text: string, base: string) => call<{ ok: true; hash: string }>("PUT", "/api/policy", { text, base }),
};
