// A local stand-in for OpenRouter's Decisions API: it records each request and answers with `answer(body)`, so no test
// reaches the real one or needs a real key.
import { createServer } from "node:http";

export interface DecisionCall {
  method: string;
  path: string;
  authorization: string;
  contentType: string;
  body: {
    model?: unknown;
    state?: { note?: string; item?: string[] };
    questions?: Record<string, { type: string; instructions: string; criteria: Record<string, string> }>;
  };
}

export async function fakeDecisions(answer: (call: DecisionCall) => { status?: number; json?: unknown; text?: string }) {
  const calls: DecisionCall[] = [];
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => {
      raw += c.toString();
    });
    req.on("end", () => {
      const call: DecisionCall = {
        method: req.method ?? "",
        path: req.url ?? "",
        authorization: req.headers.authorization ?? "",
        contentType: req.headers["content-type"] ?? "",
        body: JSON.parse(raw || "{}") as DecisionCall["body"],
      };
      calls.push(call);
      const a = answer(call);
      res.writeHead(a.status ?? 200, { "content-type": "application/json" });
      res.end(a.text ?? JSON.stringify(a.json ?? {}));
    });
  });
  await new Promise<void>((r) => {
    srv.listen(0, "127.0.0.1", r);
  });
  const { port } = srv.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/api/alpha/decisions`,
    calls,
    close: () =>
      new Promise<void>((r) => {
        srv.close(() => {
          r();
        });
        srv.closeAllConnections();
      }),
  };
}
