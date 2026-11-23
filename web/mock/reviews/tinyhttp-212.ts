// oss/tinyhttp#212: its diff and AI review for the website's demo.
import type { Canned } from "../diffs.ts";
import { file } from "../patch.ts";

export const review: Canned = {
  files: [
    file(
      "src/app.ts",
      "modified",
      `@@ -1,5 +1,6 @@
 import { createServer, type Server } from "node:http";
-import type { Handler, Middleware } from "./types.ts";
+import { createServer as createH2Server, type Http2Server } from "node:http2";
+import type { Handler, Middleware, Request, Response } from "./types.ts";
 import { Router } from "./router.ts";
 import { onError, type ErrorHandler } from "./errors.ts";

@@ -9,5 +10,7 @@ export interface AppOptions {
   settings?: AppSettings;
   onError?: ErrorHandler;
   noMatchHandler?: Handler;
+  // "prior-knowledge": serve cleartext HTTP/2 (h2c) only, to clients that open with the h2 preface.
+  http2?: "prior-knowledge";
 }

@@ -61,8 +64,10 @@ export class App extends Router {
     return this;
   }

-  listen(port?: number, cb?: () => void, host?: string): Server {
-    return createServer((req, res) => this.handler(req, res)).listen(port, host, cb);
+  listen(port?: number, cb?: () => void, host?: string): Server | Http2Server {
+    const handler = (req: Request, res: Response) => this.handler(req, res);
+    const server = this.options.http2 === "prior-knowledge" ? createH2Server(handler) : createServer(handler);
+    return server.listen(port, host, cb);
   }

   handler(req: Request, res: Response): void {`,
    ),
    file(
      "src/request.ts",
      "modified",
      `@@ -22,7 +22,8 @@ export const getProtocol = (req: Request): Protocol => {
 };

 export const getHostname = (req: Request): string | undefined => {
-  const host = req.get("X-Forwarded-Host") ?? req.headers.host;
+  // HTTP/2 has no Host header; the :authority pseudo-header carries it.
+  const host = req.get("X-Forwarded-Host") ?? req.headers.host ?? req.headers[":authority"];
   if (!host) return undefined;
   const at = host.startsWith("[") ? host.indexOf("]") + 1 : 0;
   const colon = host.indexOf(":", at);`,
    ),
    file(
      "test/http2.test.ts",
      "added",
      `@@ -0,0 +1,20 @@
+import { test } from "node:test";
+import assert from "node:assert/strict";
+import { once } from "node:events";
+import { connect } from "node:http2";
+import { App } from "../src/app.ts";
+
+test("serves h2c to a prior-knowledge client", async () => {
+  const app = new App({ http2: "prior-knowledge" });
+  app.get("/", (req, res) => res.send(\`hi \${req.hostname}\`));
+  const server = app.listen(0);
+  await once(server, "listening");
+  const { port } = server.address() as { port: number };
+  const client = connect(\`http://localhost:\${port}\`);
+  let body = "";
+  for await (const chunk of client.request({ ":path": "/" })) body += chunk;
+  assert.equal(body, "hi localhost");
+  client.close();
+  server.close();
+});
+`,
    ),
    file(
      "README.md",
      "modified",
      `@@ -48,6 +48,10 @@ app.listen(3000);

 ## Options

+### \`http2: "prior-knowledge"\`
+
+Serves cleartext HTTP/2 to clients that know in advance the server speaks it, such as \`curl --http2-prior-knowledge\` or a proxy's h2c upstream. HTTP/1.1 clients get a protocol error on that port, so give it its own port if you need both.
+
 ### \`noMatchHandler\`

 Called when no route matches. Defaults to a plain 404.`,
    ),
  ],
  ai: {
    verdict: "skim",
    risk: "low",
    summary:
      'Adds an opt-in `http2: "prior-knowledge"` option: `listen()` then builds a cleartext HTTP/2 server from `node:http2` instead of `node:http`, with the same handler. `getHostname` falls back to the `:authority` pseudo-header, since HTTP/2 requests carry no Host header. Without the option nothing changes.',
    concerns: [
      "`listen()` now returns `Server | Http2Server` for every app, so TypeScript callers that pass the result where an `http.Server` is expected stop compiling even if they never turn HTTP/2 on.",
    ],
    notes: [
      {
        path: "src/app.ts",
        side: "new",
        line: 67,
        body: "The return type widens for everyone, not only apps with the option set; that's the one thing here a caller could notice.",
      },
      {
        path: "src/app.ts",
        side: "new",
        line: 69,
        body: "The only branch: without the option this is the same `createServer` call as before, handed the same handler.",
      },
      {
        path: "src/request.ts",
        side: "new",
        line: 26,
        body: "`X-Forwarded-Host` and `Host` still win, so HTTP/1 traffic and proxied traffic read the same host as before; `:authority` only fills the gap.",
      },
      {
        path: "test/http2.test.ts",
        side: "new",
        line: 9,
        body: "Answers with `req.hostname`, so the test also covers the `:authority` fallback.",
      },
    ],
    chunks: {
      ranked: [
        { id: "h3", path: "src/app.ts", level: "skim", why: "picks the server; return type widens" },
        { id: "h4", path: "src/request.ts", level: "skim", why: "host from :authority" },
        { id: "h5", path: "test/http2.test.ts", level: "skim", why: "" },
      ],
      unread: [],
      total: 6,
    },
    guide: {
      steps: [
        {
          title: "The option and the server it picks",
          body: '`AppOptions` gains `http2`, and `listen()` builds an HTTP/2 server when it\'s set to "prior-knowledge", else the HTTP/1 one it always built.',
          check: "Without the option, `listen()` creates the same server as before.",
          hunks: [
            { id: "h1", path: "src/app.ts" },
            { id: "h2", path: "src/app.ts" },
            { id: "h3", path: "src/app.ts" },
          ],
        },
        {
          title: "The host, a test and the docs",
          body: "`getHostname` reads `:authority` when there's no Host header. The test makes a real h2 request and checks the hostname comes back; the README says the port then speaks HTTP/2 only.",
          check: "",
          hunks: [
            { id: "h4", path: "src/request.ts" },
            { id: "h5", path: "test/http2.test.ts" },
            { id: "h6", path: "README.md" },
          ],
        },
      ],
    },
  },
};
