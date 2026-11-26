// A session you talk to from the desk: the desk runs it as its own child, as the Claude app does (`claude --resume <id> -p`
// speaking stream-json both ways), so your messages reach it, its turn streams back, and its permission prompts and
// questions wait on your answer here. Its transcript stays the record; this keeps only what isn't in it yet.
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { Effect, Result } from "effect";
import { kill, OWN_GROUP, track } from "../children.ts";
import { CommandFailed, type UnsafeArgument } from "../errors.ts";
import { isRecord, jsonOf, str } from "../narrow.ts";
import { claudeCommand, claudeSpawn } from "../review.ts";

const IDLE = 15 * 60_000; // a turn ended this long ago with nothing new from you: it lets go
const LET_GO = 10_000; // how long a closing session gets to finish writing before it's stopped

// What it asks before it goes on: a tool to run (a permission), or AskUserQuestion's and ExitPlanMode's own call.
export interface HostAsk {
  id: string; // the request's id, which the answer names
  tool: string;
  input: Record<string, unknown> | null;
  at: string; // when it asked
}

// Its process's args: the session's own mode, model and effort, since a resumed session keeps them.
export const hostArgs = (sessionId: string): string[] => [
  "--resume",
  sessionId,
  "-p",
  "--output-format",
  "stream-json",
  "--input-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--permission-prompt-tool",
  "stdio",
];

const obj = (v: unknown): Record<string, unknown> | null => (isRecord(v) ? v : null);

export class SessionHost {
  readonly sessionId: string;
  readonly cwd: string;
  child: ChildProcess | null = null;
  busy = false; // a turn runs
  asks: HostAsk[] = [];
  saying = ""; // the message it's writing, before its transcript has it
  error: string | null = null; // how its last turn or its process failed
  closed = false;
  idle: NodeJS.Timeout | null = null;
  allowed: { tool: string; input: string } | null = null; // the call you allowed before it asked again: allowed when it does
  changed: () => void;
  gone: () => void; // its process ended

  constructor(sessionId: string, cwd: string, changed: () => void, gone: () => void) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.changed = changed;
    this.gone = gone;
  }

  start(): Effect.Effect<void, CommandFailed | UnsafeArgument> {
    return Effect.flatMap(claudeSpawn(claudeCommand(), hostArgs(this.sessionId)), (s) => {
      const made = Result.try({
        try: () =>
          spawn(s.file, s.args, { cwd: this.cwd, shell: s.shell, detached: OWN_GROUP, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }),
        catch: (cause) => cause,
      });
      if (Result.isFailure(made))
        return Effect.fail(new CommandFailed({ command: s.name ?? s.file, code: null, signal: null, stderr: "", cause: made.failure }));
      const child = made.success;
      this.child = child;
      track(child);
      let rest = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8").on("data", (d: string) => {
        const lines = (rest + d).split("\n");
        rest = lines.pop() ?? "";
        for (const l of lines) this.read(l);
      });
      child.stderr?.setEncoding("utf8").on("data", (d: string) => {
        stderr = (stderr + d).slice(-4096);
      });
      child.stdin?.on("error", () => {}); // a write after it exited: its close says why
      child.on("error", (e: NodeJS.ErrnoException) => {
        this.error = e.code === "ENOENT" ? `${claudeCommand()} not found` : e.message;
      });
      child.once("close", (code) => {
        if (rest) this.read(rest);
        this.closed = true;
        this.busy = false;
        this.asks = [];
        this.saying = "";
        if (this.idle) clearTimeout(this.idle);
        const last = stderr.trim().split("\n").at(-1);
        if (code && !this.error) this.error = [last].find(Boolean) ?? `claude exited with ${code}`;
        this.gone();
        this.changed();
      });
      return Effect.void;
    });
  }

  write(o: unknown): void {
    if (!this.closed) this.child?.stdin?.write(`${JSON.stringify(o)}\n`);
  }

  say(text: string): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.busy = true;
    this.error = null;
    this.write({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
    this.changed();
  }

  // Your answer to what it asked: allow (with AskUserQuestion's answers in its input), or deny with why.
  answer(id: string, allow: boolean, input: Record<string, unknown> | null, message: string): boolean {
    const ask = this.asks.find((a) => a.id === id);
    if (!ask) return false;
    this.asks = this.asks.filter((a) => a !== ask);
    const response = allow ? { behavior: "allow", updatedInput: input ?? ask.input ?? {} } : { behavior: "deny", message };
    this.write({ type: "control_response", response: { subtype: "success", request_id: id, response } });
    this.changed();
    return true;
  }

  read(line: string): void {
    const e = obj(jsonOf(line));
    if (!e) return;
    if (e.type === "control_request") {
      const req = obj(e.request);
      const id = str(e.request_id);
      if (!id) return;
      if (req?.subtype === "can_use_tool" && str(req.tool_name)) {
        const ask = { id, tool: str(req.tool_name)!, input: obj(req.input), at: new Date().toISOString() };
        this.asks = [...this.asks, ask];
        const pre = this.allowed;
        this.allowed = null;
        if (pre && pre.tool === ask.tool && pre.input === JSON.stringify(ask.input)) this.answer(id, true, null, "");
        else this.changed();
      } else this.write({ type: "control_response", response: { subtype: "error", request_id: id, error: "not supported by Inbox" } });
      return;
    }
    if (e.type === "stream_event") {
      const ev = obj(e.event);
      const delta = obj(ev?.delta);
      if (ev?.type === "content_block_delta" && delta?.type === "text_delta" && str(delta.text)) {
        this.saying += str(delta.text)!;
        this.changed();
      }
      return;
    }
    if (e.type === "assistant") {
      this.saying = "";
      this.changed();
      return;
    }
    if (e.type === "result") {
      this.busy = false;
      this.saying = "";
      this.asks = [];
      this.error = e.is_error === true ? (str(e.result) ?? "its turn failed") : null;
      this.idle = setTimeout(() => {
        this.child?.stdin?.end();
      }, IDLE);
      this.idle.unref();
      this.changed();
    }
  }

  // Let it go: its input ends, so it finishes writing and exits; one that doesn't is stopped.
  close(): Effect.Effect<void> {
    return Effect.callback<void>((done) => {
      const child = this.child;
      if (!child || this.closed) {
        done(Effect.void);
        return;
      }
      const hard = setTimeout(() => {
        kill(child);
      }, LET_GO);
      child.once("close", () => {
        clearTimeout(hard);
        done(Effect.void);
      });
      child.stdin?.end();
    });
  }
}
