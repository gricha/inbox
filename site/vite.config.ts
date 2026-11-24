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

// The repo's stars for the navbar, read once per build (each deploy); none when GitHub doesn't answer.
async function stars(): Promise<string> {
  const res = await fetch("https://api.github.com/repos/gricha/inbox", { signal: AbortSignal.timeout(5000) }).catch(() => null);
  const body: unknown = res?.ok ? await res.json().catch(() => null) : null;
  const n = body && typeof body === "object" && "stargazers_count" in body ? body.stargazers_count : null;
  if (typeof n !== "number") return "";
  const shown = n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
  return `<span class="stars" title="${n} stars on GitHub"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 .9l2.2 4.5 4.9.7-3.6 3.5.9 4.9L8 12.2l-4.4 2.3.9-4.9L.9 6.1l4.9-.7z"/></svg>${shown}</span>`;
}
const starsHtml = await stars();

// useinbox.dev: the landing page and, at /demo/, the real window running against the mock desk in the page.
export default defineConfig({
  root: import.meta.dirname,
  publicDir: "public",
  plugins: [react(), { name: "stars", transformIndexHtml: (html) => html.replace("<!--stars-->", starsHtml) }],
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
