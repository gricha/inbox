// Saves the mock's answers the iOS app's decoding tests read (ios/InboxTests/Fixtures), each to the read it's named for,
// indented four spaces. review-lean.json is written by hand. web/test/ios-fixtures.test.ts keeps them in step.
//   node --disable-warning=ExperimentalWarning scripts/ios-fixtures.ts
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const at = (id: string) => encodeURIComponent(id);
export const FIXTURES: Record<string, string> = {
  asks: "/api/asks",
  health: "/health",
  inflight: "/api/inflight",
  inquiry: "/api/inquiries/q1c0ffee",
  "item-issue-steps": `/api/item?id=${at("acme/api#4071")}`,
  "item-issue": `/api/item?id=${at("acme/worker#860")}`,
  item: `/api/item?id=${at("acme/api#4127")}`,
  overview: "/api/overview",
  queue: "/api/queue",
  "review-own": `/api/review/${at("me/notes-app#12")}`,
  "review-steps": `/api/review/${at("acme/api#4127")}`,
  review: `/api/review/${at("acme/worker#879")}`,
  reviewers: `/api/reviewers/${at("me/notes-app#12")}?q=`,
};

// Every key path in a JSON value: an object's keys by name, an array's elements as one [].
export function keyPaths(v: unknown, under = "", out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keyPaths(x, `${under}[]`, out);
  else if (typeof v === "object" && v !== null)
    for (const [k, x] of Object.entries(v)) {
      out.add(`${under}.${k}`);
      keyPaths(x, `${under}.${k}`, out);
    }
  return out;
}

// The mock on a free port, without its pollers: its first line says where.
export async function startMock(): Promise<{ base: string; stop: () => void }> {
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../web/mock/server.ts", import.meta.url))],
    { env: { ...process.env, MOCK_PORT: "0", MOCK_NO_POLL: "1" }, stdio: ["ignore", "pipe", "inherit"] },
  );
  const said: unknown[] = await once(child.stdout, "data");
  const base = /http:\/\/[\d.:]+/.exec(String(said[0]))?.[0];
  if (!base) throw new Error(`the mock said ${String(said[0])}`);
  return {
    base,
    stop: () => {
      child.kill();
    },
  };
}

if (import.meta.main) {
  const mock = await startMock();
  try {
    for (const [name, path] of Object.entries(FIXTURES)) {
      const body: unknown = await (await fetch(mock.base + path)).json();
      fs.writeFileSync(new URL(`../ios/InboxTests/Fixtures/${name}.json`, import.meta.url), `${JSON.stringify(body, null, 4)}\n`);
      console.log(`saved ${name}.json from ${path}`);
    }
  } finally {
    mock.stop();
  }
}
