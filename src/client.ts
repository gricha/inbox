// Typed HTTP client for the desk API. Used by the CLI and the MCP server.

import type {
  Action,
  BoardView,
  Brief,
  ConfigDoc,
  ConfigError,
  FieldDoc,
  FocusView,
  ItemDetail,
  ItemState,
  Overview,
  PreviewResult,
  QueueView,
  SettingsView,
  SettingValue,
} from "./types.ts";

export type { ConfigDoc };

export interface ActResult {
  ok: true;
  state: ItemState;
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

async function call<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  let res: Response;
  try {
    res = await fetch(baseUrl() + path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (e) {
    if (refused(e)) throw new DeskDownError();
    throw e;
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (data ?? {}) as { error?: string; candidates?: string[] };
    throw new DeskApiError(res.status, e.error, e.candidates);
  }
  return data as T;
}

const q = encodeURIComponent;

export const overview = () => call<Overview>("GET", "/api/overview");
export const focus = () => call<FocusView>("GET", "/api/focus");
export const queue = () => call<QueueView>("GET", "/api/queue");
export const board = (id: string) => call<BoardView>("GET", `/api/boards/${q(id)}`);
export const item = (ref: string) => call<ItemDetail>("GET", `/api/item?id=${q(ref)}`);
export const act = (id: string, action: Action, until?: string) => call<ActResult>("POST", "/api/act", { id, action, until });
export const undo = (seq?: number) => call<{ ok: true; id: string; action: Action }>("POST", "/api/undo", { seq });
export const sync = () => call<{ ok: true }>("POST", "/api/sync", {});
export const getConfig = () => call<ConfigDoc>("GET", "/api/config");
export const previewConfig = (text: string) => call<PreviewResult>("POST", "/api/config/preview", { text });
export const putConfig = (text: string) =>
  call<{ ok: boolean; errors: ConfigError[]; warnings?: ConfigError[] }>("PUT", "/api/config", { text });
export const fields = () => call<FieldDoc[]>("GET", "/api/fields");
export const settings = () => call<SettingsView>("GET", "/api/settings");
export const putSettings = (patch: SettingsPatch) =>
  call<{ ok: boolean; errors: ConfigError[]; settings: SettingsView }>("PUT", "/api/settings", patch);
export const status = (timeoutMs?: number) => call<StatusInfo>("GET", "/api/status", undefined, timeoutMs);
export const analyze = (id: string, force = false) => call<{ ok: true; brief: Brief }>("POST", "/api/analyze", { id, force }, 240_000);
export const health = () => call<{ ok: true; version: string }>("GET", "/health");
