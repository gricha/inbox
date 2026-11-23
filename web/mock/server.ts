// In-memory mock of the desk HTTP API for UI work. Run: node --disable-warning=ExperimentalWarning web/mock/server.ts
// What it serves and its switches: web/mock/desk.ts.
import { createServer } from "node:http";
import { handle } from "./desk.ts";

const PORT = process.env.MOCK_PORT ? Number(process.env.MOCK_PORT) : 47824;

const server = createServer((req, res) => {
  void handle(req, res);
});

server.listen(PORT, "127.0.0.1", () => {
  const at = server.address();
  const port = typeof at === "object" && at ? at.port : PORT;
  console.log(`mock desk API on http://127.0.0.1:${port}`);
});
