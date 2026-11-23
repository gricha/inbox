// A fake MCP server over stdio for a source that isn't email: a chat and issue tracker's messages that need me. Tests and
// scratch desks register it in their own Claude config (CLAUDE_CONFIG_DIR), never yours: see fake-tracker/claude.ts.
//   node scripts/fake-tracker/server.ts   (FAKE_TRACKER_DATA: a JSON file of messages in place of messages.ts's)
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MESSAGES } from "./messages.ts";

const file = process.env.FAKE_TRACKER_DATA;
const messages: unknown = file ? JSON.parse(fs.readFileSync(file, "utf8")) : MESSAGES;

const server = new McpServer({ name: "tracker", version: "0.1.0" });
server.registerTool(
  "list_messages",
  {
    description: "Messages that need me: questions, review requests, incidents and announcements, newest first. Read only.",
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  () => ({ content: [{ type: "text", text: JSON.stringify(messages) }] }),
);
await server.connect(new StdioServerTransport());
