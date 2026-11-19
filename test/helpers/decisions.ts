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
    state?: { note?: string; item?: string[]; path?: string; status?: string; patch?: string }; // an item's, or a tag's hunk
    questions?: Record<string, { type: string; instructions: string; criteria: Record<string, string> }>;
  };
}

export async function fakeDecisions(answer: (call: DecisionCall) => { status?: number; json?: unknown; text?: string }) {
  const calls: DecisionCall[] = [];
  let open = 0; // requests it's reading or answering
  const srv = createServer((req, res) => {
    open++;
    res.on("close", () => {
      open--;
    });
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
    // Until nothing's open and nothing new came in for a while: a run that stopped at a refusal leaves its other requests
    // in flight, and one landing late would count against what the test does next.
    quiet: async (ms = 150) => {
      const busy = (seen: number) => open > 0 || seen !== calls.length;
      let seen = -1;
      while (busy(seen)) {
        seen = calls.length;
        await new Promise<void>((r) => {
          setTimeout(r, ms);
        });
      }
    },
    close: () =>
      new Promise<void>((r) => {
        srv.close(() => {
          r();
        });
        srv.closeAllConnections();
      }),
  };
}
