import type { Hono } from "hono";

// A request to the app as this machine's desk on its default port: request(app)("/api/queue", init).
export const request =
  (app: Hono) =>
  (p: string, init: RequestInit = {}): Response | Promise<Response> =>
    app.request(`http://127.0.0.1:47823${p}`, init);
