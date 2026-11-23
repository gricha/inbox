// A fake agent CLI in a temp dir of its own, which DESK_CLAUDE (DESK_CODEX, DESK_OPENCODE) points at for the test and
// the no-agent helper's nothing after it. body is the shell it runs; $d is its dir, for the files it reads and writes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NO_AGENT } from "./no-agent.ts";

const ENV = { claude: "DESK_CLAUDE", codex: "DESK_CODEX", opencode: "DESK_OPENCODE" } as const;

export function fakeAgent(c: { after(fn: () => unknown): void }, name: keyof typeof ENV, body: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `desk-fake-${name}-`));
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, `#!/bin/sh\nd="$(dirname "$0")"\n${body}\n`, { mode: 0o755 });
  const key = ENV[name];
  process.env[key] = bin;
  c.after(() => {
    process.env[key] = NO_AGENT[key];
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const at = (f: string) => path.join(dir, f);
  return {
    bin,
    dir,
    at,
    // A file it wrote, or "" before it did.
    read: (f: string) => (fs.existsSync(at(f)) ? fs.readFileSync(at(f), "utf8") : ""),
    write: (f: string, text: string) => {
      fs.writeFileSync(at(f), text);
    },
  };
}
