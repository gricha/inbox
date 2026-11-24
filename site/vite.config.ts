import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { compact } from "./stars.ts";

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

// The repo's stars for the navbar as of the build, so the first paint has a number; the page reads the live count after.
async function stars(): Promise<string> {
  const res = await fetch("https://api.github.com/repos/gricha/inbox", { signal: AbortSignal.timeout(5000) }).catch(() => null);
  const body: unknown = res?.ok ? await res.json().catch(() => null) : null;
  const n = body && typeof body === "object" && "stargazers_count" in body ? body.stargazers_count : null;
  return typeof n === "number" ? compact(n) : "";
}
const starsAtBuild = await stars();

// useinbox.dev: the landing page and, at /demo/, the real window running against the mock desk in the page.
export default defineConfig({
  root: import.meta.dirname,
  publicDir: "public",
  plugins: [react(), { name: "stars", transformIndexHtml: (html) => html.replace("<!--stars-->", starsAtBuild) }],
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
