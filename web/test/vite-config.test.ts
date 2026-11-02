// The Vite UI (npm run dev, the desktop app running from a checkout).
import assert from "node:assert/strict";
import { test } from "node:test";
import config from "../vite.config.ts";

test("the Vite UI can't be framed, like the desk's own pages", () => {
  assert.deepEqual(config.server?.headers, { "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" });
});

test("a desk outage logs one proxy error, not one per request", (c) => {
  const logged = c.mock.method(console, "error", () => {});
  const logger = config.customLogger;
  assert.ok(logger);
  for (let i = 0; i < 5; i++) logger.error(`http proxy error: /api/overview\nError: connect ECONNREFUSED 127.0.0.1:48640`);
  logger.error("Internal server error: something else");
  const lines = logged.mock.calls.map((call) => String(call.arguments[0]));
  assert.equal(lines.length, 2, lines.join("\n"));
  assert.match(lines[0] ?? "", /isn't answering/);
  assert.match(lines[1] ?? "", /something else/);
});
