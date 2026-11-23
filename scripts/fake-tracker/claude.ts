#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// A fake `claude -p` for a desk's automation over the fake tracker (DESK_CLAUDE points at this file). An automation's run
// reads every stdio server in its --mcp-config, as the real one would, and turns each message into a note with its fields
// as the source gave them, malformed ones too. The tool-less calls answer from FAKE_CLAUDE_DIR: <kind>.<n>.json for that
// kind's nth call, else <kind>.json (kinds: run, rule, recommend, other), else a default. Each call's args and stdin are
// kept there as args.<n> and stdin.<n>.
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { field, isRecord, jsonOf, str, strings } from "../../src/narrow.ts";

const args = process.argv.slice(2);
const after = (flag: string) => {
  const at = args.indexOf(flag);
  return at < 0 ? undefined : args[at + 1];
};
const input = fs.readFileSync(0, "utf8");
const dir = process.env.FAKE_CLAUDE_DIR;
const schema = jsonOf(after("--json-schema") ?? "{}");
const props = field(schema, "properties");
const kind = field(props, "notes")
  ? "run"
  : (strings(field(field(props, "do"), "enum")) ?? []).includes("fix")
    ? "recommend"
    : field(field(field(field(props, "items"), "items"), "properties"), "yes")
      ? "rule"
      : "other";

const bump = (name: string) => {
  if (!dir) return 1;
  const f = path.join(dir, name);
  const n = Number(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "0") + 1;
  fs.writeFileSync(f, String(n));
  return n;
};
const call = bump("count");
const nth = bump(`count.${kind}`);
if (dir) {
  fs.writeFileSync(path.join(dir, `args.${call}`), args.join("\n"));
  fs.writeFileSync(path.join(dir, `stdin.${call}`), input);
}
const given = (name: string) => {
  const f = dir && path.join(dir, name);
  return f && fs.existsSync(f) ? jsonOf(fs.readFileSync(f, "utf8")) : undefined;
};

// Each message as a note: what a run would make of it, its fields copied from the source whatever their shape.
function noteOf(m: unknown) {
  const author = str(field(m, "author"));
  return {
    key: str(field(m, "id")) ?? "",
    text: `${author ?? "Someone"} in #${str(field(m, "channel")) ?? "?"}: ${str(field(m, "title")) ?? ""}`,
    ...(str(field(m, "body")) && { body: field(m, "body") }),
    ...(str(field(m, "url")) && { url: field(m, "url") }),
    urgent: field(m, "kind") === "incident",
    ...(field(m, "kind") === "review_request" && { icon: "git-pull-request" }),
    fields: Object.fromEntries(
      ["kind", "author", "channel", "mentions", "due", "points"].flatMap((k) => (field(m, k) === undefined ? [] : [[k, field(m, k)]])),
    ),
  };
}

async function read(): Promise<object> {
  const config = jsonOf(fs.readFileSync(after("--mcp-config") ?? "", "utf8"));
  const servers = field(config, "mcpServers");
  const notes: object[] = [];
  for (const entry of Object.values(isRecord(servers) ? servers : {})) {
    const command = str(field(entry, "command"));
    if (!command) continue; // the desk's own, over HTTP
    const own = field(entry, "env");
    const env = Object.fromEntries(
      [...Object.entries(process.env), ...Object.entries(isRecord(own) ? own : {})].flatMap(([k, v]) =>
        typeof v === "string" ? [[k, v]] : [],
      ),
    );
    const client = new Client({ name: "fake-claude", version: "0.1.0" });
    await client.connect(
      new StdioClientTransport({
        command,
        args: strings(field(entry, "args")) ?? [],
        env,
      }),
    );
    const got = await client.callTool({ name: "list_messages", arguments: {} });
    await client.close();
    const content = field(got, "content");
    const text = str(field(Array.isArray(content) ? content[0] : undefined, "text")) ?? "[]";
    const list = jsonOf(text);
    for (const m of Array.isArray(list) ? list : []) notes.push(noteOf(m));
  }
  return { summary: `Read ${notes.length} messages that mention me.`, items: [], notes };
}

const DEFAULTS: Record<string, object> = {
  rule: { items: [] },
  recommend: { do: "drop", says: "I think this can be dropped: do you agree?", why: "It doesn't say what it needs." },
  other: {},
};
const answer = given(`${kind}.${nth}.json`) ?? given(`${kind}.json`) ?? (kind === "run" ? await read() : DEFAULTS[kind]);
process.stdout.write(JSON.stringify({ type: "result", is_error: false, session_id: `fake-${call}`, structured_output: answer }));
