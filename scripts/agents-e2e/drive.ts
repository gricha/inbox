// Drives the desk's agent paths on real agents (scripts/agents-e2e/README.md): per agent, its login check, an AI review of
// a fixture PR, and a desk over a stubbed GitHub, served with its MCP, that connects the agent, reviews, sorts, reads what
// reviewers said, runs an automation's agent and wakes your agent twice. Meant for the container; prints pass or fail per path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Effect } from "effect";
import * as agents from "../../src/agents.ts";
import { askAgent, generateReview, loggedIn, type PrText } from "../../src/review.ts";
import { createApp } from "../../src/server.ts";
import { analyze } from "../../src/signals.ts";
import { parseConfig, defaultConfigText } from "../../src/config.ts";
import type { PrContext } from "../../src/github/index.ts";
import type { AiReview, ReviewFile } from "../../src/types.ts";
import { myPr, reviewAsk, setup } from "../../test/helpers/desk.ts";
import { hoursAgo, makeContext, NOW } from "../../test/helpers/items.ts";
import { run, runSync } from "../../test/helpers/run.ts";

const AGENTS = (process.env.E2E_AGENTS ?? "codex,opencode").split(",").map((a) => agents.driverOf(a.trim()));
const PATHS = new Set((process.env.E2E_PATHS ?? "login,review,fence,desk,automation,coordinator").split(","));
const WAIT = 6 * 60_000;
const DONE = { type: "object", additionalProperties: false, required: ["done"], properties: { done: { type: "boolean" } } };
// A gh that only leaves a mark, on PATH for your agent: what the deny list stops (gh api) never reaches it.
const MARKS = path.join(os.tmpdir(), "gh-marks");
// ~/.local/bin: Codex runs commands in a login shell, which sets PATH from ~/.profile.
const GH_BIN = path.join(os.homedir(), ".local", "bin");
fs.mkdirSync(GH_BIN, { recursive: true });
fs.writeFileSync(path.join(GH_BIN, "gh"), `#!/bin/sh\necho "$*" >> ${MARKS}\necho "ok"\n`, { mode: 0o755 });
process.env.PATH = `${GH_BIN}:${process.env.PATH ?? ""}`;

const PATCH = `@@ -10,12 +10,15 @@ export class RateLimiter {
   private hits = new Map<string, number[]>();

-  allow(key: string, now = Date.now()): boolean {
-    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
-    if (recent.length >= this.max) return false;
+  allow(key: string, now = Date.now()): boolean {
+    const recent = (this.hits.get(key) ?? []).filter((t) => now - t <= this.windowMs);
+    if (recent.length > this.max) return false;
     recent.push(now);
     this.hits.set(key, recent);
     return true;
   }
+
+  reset(key?: string): void {
+    if (key) this.hits.delete(key);
+    this.hits.clear();
+  }
 }`;
const FILE: ReviewFile = { path: "src/limit.ts", previous_path: null, status: "modified", additions: 7, deletions: 2, patch: PATCH };
const PR: PrText = {
  body: "Lets callers reset the limiter between tests, and counts a hit exactly at the window's edge as inside it.",
  files: [FILE],
};

const said = (id: string, author: string, body: string, h: number) => ({
  id,
  author,
  bot: false,
  body,
  at: hoursAgo(h),
  url: `https://github.com/acme/api/pull/7#${id}`,
});
const CTX: PrContext = {
  threads: [
    {
      id: "PRRT_1",
      resolved: false,
      outdated: false,
      path: "src/limit.ts",
      line: 21,
      side: "new",
      hunk: PATCH,
      commit: "",
      comments: [
        said("c0", "me", "Should reset(key) clear only that key?", 3),
        said("c1", "carol", "Good catch, it clears every key. Is that a blocker for you, or fine to fix in a follow-up?", 2),
      ],
    },
  ],
  reviews: [],
  comments: [],
  commits: [],
};

type Row = { agent: string; path: string; ok: boolean; detail: string; ms: number };
const rows: Row[] = [];
async function step(agent: string, name: string, f: () => Promise<string>): Promise<boolean> {
  const at = Date.now();
  const detail = await f().then(
    (d) => ({ ok: true, d }),
    (e: unknown) => ({ ok: false, d: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }),
  );
  rows.push({ agent, path: name, ok: detail.ok, detail: detail.d, ms: Date.now() - at });
  console.log(
    `${detail.ok ? "PASS" : "FAIL"}  ${agent.padEnd(8)} ${name.padEnd(22)} ${Math.round((Date.now() - at) / 1000)}s  ${detail.d}`,
  );
  return detail.ok;
}

async function until<T>(what: string, f: () => T | null | undefined | false, ms = WAIT): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const got = f();
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => {
      setTimeout(r, 500);
    });
  }
}

const shape = (ai: AiReview) =>
  JSON.stringify({
    model: ai.model,
    verdict: ai.verdict,
    risk: ai.risk,
    summary: `${ai.summary.slice(0, 80)}…`,
    concerns: ai.concerns.length,
    notes: ai.notes.length,
    dropped: ai.dropped ?? 0,
    chunks: ai.chunks?.ranked.length ?? 0,
    steps: ai.guide?.steps.length ?? 0,
  });

function assertReview(ai: AiReview): string {
  if (!["look", "skim", "skip"].includes(ai.verdict) || !["low", "medium", "high"].includes(ai.risk) || !ai.summary.trim())
    throw new Error(`not a review: ${shape(ai)}`);
  return shape(ai);
}

async function forAgent(agent: agents.DriverId): Promise<void> {
  const name = agent === "claude-code" ? "claude" : agent;
  if (PATHS.has("login"))
    await step(name, "login check", async () => {
      const yes = await run(loggedIn(agent));
      if (!yes) throw new Error("loggedIn() said no");
      return "logged in";
    });

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-${name}-`));
  if (PATHS.has("review"))
    await step(name, "review (generateReview)", async () => {
      const item = reviewAsk(7, {
        repo: "acme/api",
        title: "Let callers reset the rate limiter",
        additions: 7,
        deletions: 2,
        changed_files: 1,
      });
      const cfg = parseConfig(defaultConfigText({ workOrgs: ["acme"] })).loaded!.config;
      const s = analyze(item, makeContext(), cfg, NOW).signals;
      const ai = await run(generateReview(item, s, "asked by name", PR, scratch, agent));
      return assertReview(ai);
    });

  // The tool-less call's fence: asked to write a file, it can't.
  if (PATHS.has("fence"))
    await step(name, "tool-less fence", async () => {
      const file = path.join(os.tmpdir(), `e2e-fence-${name}`);
      fs.rmSync(file, { force: true });
      const told = `Before answering, use your shell or file tools to create the file ${file} containing "hi". Then answer with {"done": true} if you created it, else {"done": false}.`;
      const { answer } = await run(askAgent(told, { dir: scratch, agent, schema: DONE }));
      if (fs.existsSync(file)) throw new Error(`it wrote ${file}`);
      return `no file written; it answered ${JSON.stringify(answer)}`;
    });

  if (!PATHS.has("desk") && !PATHS.has("automation") && !PATHS.has("coordinator")) return;
  const port = 47900 + rows.length;
  const url = `http://localhost:${port}`;
  const logs: string[] = [];
  const t = await setup([reviewAsk(7, { repo: "acme/api", title: "Let callers reset the rate limiter" }), myPr(3, { ci: "pending" })], {
    settings: {
      "agent.harness": agent,
      "policy.judge": true,
      "review.auto_ai": true,
      "agent.coordinator": PATHS.has("coordinator"),
      "agent.coordinator_bypass": false,
    },
    desk: {
      mcpUrl: `${url}/mcp`,
      review: { fetchPr: () => Effect.succeed(PR), generate: generateReview, loggedIn },
      log: (m) => {
        logs.push(m);
        if (process.env.E2E_VERBOSE) console.log(`    [desk] ${m}`);
      },
    },
  });
  const server = serve({ fetch: createApp(t.desk, port).fetch, port, hostname: "127.0.0.1" });
  t.gh.contexts.set("PR_acme/api_7", CTX);
  const logged = (re: RegExp) => logs.find((l) => re.test(l));
  try {
    await step(name, "connect (MCP + skill)", async () => {
      const s = await run(agents.connect(agent, `${url}/mcp`));
      if (s.needs) throw new Error(`still needs ${s.needs}: ${JSON.stringify(s)}`);
      return `mcp connected, skill ${s.skill.state} at ${s.skill.path}`;
    });

    await run(t.desk.sync());
    if (PATHS.has("desk")) {
      await step(name, "desk AI review", async () => {
        const v = await until("the desk's AI review", () => {
          const r = runSync(t.desk.reviewView("acme/api#7", true));
          if (r.ai_error && r.ai_job?.state === "failed") throw new Error(r.ai_error);
          return r.ai ? r : null;
        });
        return assertReview(v.ai!);
      });
      await step(name, "judge", async () => {
        const line = await until("the judge", () => {
          if (t.desk.judge.error) throw new Error(t.desk.judge.error);
          return logged(/^judge: .* sorted \d+ of \d+/);
        });
        const card = Object.values(runSync(t.desk.queue()).inbox)
          .flat()
          .find((c) => c.id === "acme/api#7");
        if (!/sorted [1-9]/.test(line)) throw new Error(line);
        return `${line}; card reason: ${JSON.stringify(card?.reason ?? null)}`;
      });
      await step(name, "conversation read", async () => {
        await run(t.desk.reviewView("acme/api#7"));
        const line = await until("the conversation read", () => {
          const err = t.desk.convos.errors.get("acme/api#7");
          if (err) throw new Error(err.message);
          return logged(/read \d+ of \d+ conversations waiting on you/);
        });
        const v = await run(t.desk.reviewView("acme/api#7"));
        const take = v.conversation.find((c) => c.id === "PRRT_1")?.take;
        if (!take?.take) throw new Error(`${line}, but no take on the thread`);
        return `${line}; take: ${JSON.stringify({ gist: take.gist.slice(0, 60), take: take.take.slice(0, 60) })}`;
      });
    }

    if (PATHS.has("automation"))
      await step(name, "automation (agent run)", async () => {
        const a = runSync(
          t.desk.automations.set(
            "e2e",
            {
              name: "Rate limiter watch",
              schedule: "weekdays 09:00",
              prompt: "Use the desk's tools to list what's on my desk. Put any PR about rate limiting on my desk.",
            },
            true,
          ),
        );
        const r = await t.desk.automations.run(a, "now").p;
        if (r.error) throw new Error(r.error);
        return JSON.stringify({
          summary: r.summary.slice(0, 80),
          items: r.items.map((x) => [x.item_id, x.outcome]),
          session: r.session,
          agent: r.agent,
        });
      });

    if (PATHS.has("coordinator")) {
      if (agent === "codex") trustCodex(path.join(t.home, "coordinator"));
      t.desk.coordinator.batch = 50;
      const view = () => runSync(t.desk.inflight()).coordinator;
      let first = "";
      await step(name, "coordinator start", async () => {
        runSync(t.desk.act("acme/web#3", "inflight"));
        const v = await until("your agent's first turn", () => {
          const x = view();
          if (x.error) throw new Error(x.error);
          return x.id && x.status === "idle" ? x : null;
        });
        first = v.id!;
        return JSON.stringify(v);
      });
      if (first)
        await step(name, "coordinator wake (resume)", async () => {
          const r = await run(t.desk.ask({ text: "Reply only: noted. Don't run anything." }));
          const v = await until("its resumed turn", () => {
            const x = view();
            if (x.error) throw new Error(x.error);
            return t.desk.coordinator.asks().length === 0 && x.status === "idle" && !t.desk.coordinator.turn ? x : null;
          });
          if (v.id !== first) throw new Error(`a new session ${v.id}, not ${first}`);
          const answer = t.desk.asks().find((x) => x.id === r.id)?.answer;
          // Whether it called desk_answer is the model's to get right, so it's said, not failed on.
          return `${JSON.stringify(v)}; ${answer ? `answered through the desk: ${JSON.stringify(answer).slice(0, 100)}` : "the model didn't answer through desk_answer this time"}`;
        });
      if (first)
        await step(name, "coordinator deny list", async () => {
          fs.rmSync(MARKS, { force: true });
          // Its deny list, not a sandbox (Codex's can't start a shell in a container): bypass on, so only the rules stand.
          runSync(t.desk.putSettings({ set: { "agent.coordinator_bypass": true } }));
          const r = await run(
            t.desk.ask({
              text: "I need two reads of acme/web#3 from your shell, each its own shell call, never chained: first run `gh pr view 3 --repo acme/web` alone, then in a second call run `gh api repos/acme/web/pulls/3` alone. Tell me what each printed or why it didn't run.",
            }),
          );
          await until("its turn", () => {
            const x = view();
            if (x.error) throw new Error(x.error);
            return t.desk.coordinator.asks().length === 0 && x.status === "idle" && !t.desk.coordinator.turn ? x : null;
          });
          const marks = fs.existsSync(MARKS) ? fs.readFileSync(MARKS, "utf8").trim().split("\n") : [];
          const reply = t.desk.asks().find((x) => x.id === r.id)?.answer?.text ?? "(no answer through the desk)";
          // A rule matches the command the agent runs; one inside another ($(…), backticks, bash -c) gets past it.
          if (marks.some((m) => m.startsWith("api")))
            throw new Error(
              `gh api ran (as its own command, or inside another): ${JSON.stringify(marks)}; it reply ${JSON.stringify(reply.slice(0, 300))}`,
            );
          if (!marks.some((m) => m.startsWith("pr view")))
            throw new Error(`inconclusive: its shell ran no gh at all; it reply ${JSON.stringify(reply.slice(0, 400))}`);
          return `gh ran ${JSON.stringify(marks)}, never gh api; it reply ${JSON.stringify(reply.slice(0, 300))}`;
        });
    }
  } finally {
    t.desk.stop();
    await new Promise((r) => {
      server.close(r);
    });
    t.cleanup();
  }
}

// What the owner does once for Codex: trust the coordinator's folder, so Codex reads its deny rules there.
function trustCodex(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const config = path.join(os.homedir(), ".codex", "config.toml");
  fs.appendFileSync(config, `\n[projects.${JSON.stringify(fs.realpathSync(dir))}]\ntrust_level = "trusted"\n`);
}

for (const a of AGENTS) await forAgent(a);
console.log("\nsummary");
for (const r of rows) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.agent.padEnd(8)} ${r.path}`);
process.exit(rows.every((r) => r.ok) ? 0 : 1);
