import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const node = (f: string) => fileURLToPath(new URL(`./demo/node/${f}.ts`, import.meta.url));
const NODE: Record<string, string> = {
  fs: "fs",
  path: "path",
  os: "os",
  crypto: "crypto",
  child_process: "child_process",
  url: "url",
  "timers/promises": "timers",
  module: "misc",
  net: "misc",
  sqlite: "misc",
  http: "misc",
  async_hooks: "misc",
  util: "misc",
  stream: "misc",
  "@sentry/hono/node": "misc",
};

// useinbox.dev: the landing page and, at /demo/, the real window running against the mock desk in the page.
export default defineConfig({
  root: import.meta.dirname,
  publicDir: "public",
  plugins: [react()],
  // The mock reads its switches from process.env; the demo page sets them (demo/index.html), so keep Vite from inlining {}.
  define: { "process.env": "globalThis.process.env" },
  resolve: { alias: Object.entries(NODE).map(([m, f]) => ({ find: m.startsWith("@") ? m : `node:${m}`, replacement: node(f) })) },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: { input: { index: "index.html", demo: "demo/index.html" } },
  },
  server: { port: 5190 },
});
