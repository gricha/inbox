// Typed HTTP client for the desk API. Used by the CLI and the MCP server.

import {
  UNTIL,
  type Action,
  type ActivityPage,
  type AiReview,
  type Ask,
  type AskPlace,
  type Automation,
  type AutomationView,
  type Inquiry,
  type InquiryLink,
  type InquiryOption,
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

export class DeskDownError extends Error {
  constructor() {
    super("desk is not running — start it with: desk serve");
    this.name = "DeskDownError";
  }
}

export class DeskApiError extends Error {
  status: number;
  candidates: string[];
  constructor(status: number, error: string | undefined, candidates: string[] = []) {
    const msg = (error ?? "") || `HTTP ${status}`;
    super(candidates.length ? `${msg} — candidates: ${candidates.join(", ")}` : msg);
    this.name = "DeskApiError";
    this.status = status;
    this.candidates = candidates;
  }
}

export function baseUrl(): string {
  return `http://127.0.0.1:${(process.env.DESK_PORT ?? "") || 47823}`;
}

function refused(e: unknown): boolean {
  const cause = (e as { cause?: { code?: string; errors?: { code?: string }[] } }).cause;
  return cause?.code === "ECONNREFUSED" || !!cause?.errors?.some((x) => x.code === "ECONNREFUSED");
}

async function overNetwork(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(baseUrl() + path, init);
  } catch (e) {
    if (refused(e)) throw new DeskDownError();
    throw e;
  }
}

const q = encodeURIComponent;

// `send` is fetch over loopback by default; the server's /mcp passes its own app to call the same routes in-process.
export function createClient(send: (path: string, init: RequestInit) => Response | Promise<Response> = overNetwork) {
  async function call<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const res = await send(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const e = (data ?? {}) as { error?: string; candidates?: string[] };
      throw new DeskApiError(res.status, e.error, e.candidates);
    }
    return data as T;
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
    automations: () => call<AutomationView[]>("GET", "/api/automations"),
    setAutomation: (id: string, b: { name: string; schedule: string; prompt: string }) =>
      call<{ ok: true; automation: Automation }>("PUT", `/api/automations/${q(id)}`, b),
    runAutomation: (id: string) => call<{ ok: true; running: string }>("POST", `/api/automations/${q(id)}/run`),
    activity: (o: { after?: number; wait?: number; limit?: number; item?: string } = {}) => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(o)) if (v !== undefined) params.set(k, String(v));
      return call<ActivityPage>("GET", `/api/activity?${params.toString()}`, undefined, ((o.wait ?? 0) + 15) * 1000);
    },
    health: () => call<{ ok: true; version: string }>("GET", "/health"),
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
} = createClient();
