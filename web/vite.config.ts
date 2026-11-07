import { createLogger, defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// An empty DESK_API means unset.
const api = (process.env.DESK_API ?? "") || "http://127.0.0.1:47823";

// While the desk is down every proxied call fails; say so once, not with a stack trace per request.
let deskDown = false;
const logger = createLogger();
const logError = logger.error.bind(logger);
logger.error = (msg, opts) => {
  const proxy = msg.includes("http proxy error");
  if (!proxy) logError(msg, opts);
  else if (!deskDown) logError(`http proxy error: the desk on ${api} isn't answering; more are left out until it does`, opts);
  if (proxy) deskDown = true;
};

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    react(),
    {
      name: "desk-editor-guard",
      configureServer(server) {
        // Vite's /__open-in-editor opens any file in the owner's editor; only its own error overlay may ask, not another site's iframe.
        server.middlewares.use("/__open-in-editor", (req, res, next) => {
          if (req.headers["sec-fetch-site"] === "same-origin") next();
          else res.writeHead(403).end("forbidden cross-site request");
        });
      },
    },
  ],
  customLogger: logger,
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    // The desk's own pages send these too; without them any site could frame this UI and click approve or Send in it.
    headers: { "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" },
    proxy: {
      "/api": {
        target: api,
        // The proxy leaves the page's event stream open when the desk restarts; end it so the page reconnects to the new one.
        configure: (proxy) => {
          proxy.on("proxyRes", (upstream, _req, res) => {
            deskDown = false;
            upstream.on("close", () => {
              if (!upstream.complete) res.destroy();
            });
          });
        },
      },
      "/health": api,
    },
  },
});
