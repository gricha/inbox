import type {
  Action, Brief, ConfigError, FieldDoc, ItemDetail, ItemState, Overview, PreviewResult, QueueView, SettingsView, SettingValue,
} from "../../src/types.ts";

export class ApiError extends Error {
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
  const data = await res.json();
  if (!res.ok) throw new ApiError(data.error ?? res.statusText, res.status);
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
  analyze: (id: string, force = false) => call<{ ok: true; brief: Brief }>("POST", "/api/analyze", { id, force }),
  undo: (seq?: number) => call<{ ok: true; id: string; action?: string }>("POST", "/api/undo", seq ? { seq } : {}),
  sync: () => call<{ ok: true }>("POST", "/api/sync", {}),
  config: () => call<{ path: string; text: string; errors: ConfigError[]; warnings?: ConfigError[] }>("GET", "/api/config"),
  preview: (text: string) => call<PreviewResult>("POST", "/api/config/preview", { text }),
  saveConfig: (text: string, base?: string) => call<{ ok: boolean; errors: ConfigError[] }>("PUT", "/api/config", { text, base }),
  fields: () => call<FieldDoc[]>("GET", "/api/fields"),
  settings: () => call<SettingsView>("GET", "/api/settings"),
  // Invalid values write nothing; `errors` says which keys and why.
  saveSettings: (patch: { set?: Record<string, SettingValue>; reset?: string[] }) =>
    call<{ ok: boolean; errors: ConfigError[]; settings: SettingsView }>("PUT", "/api/settings", patch),
};
