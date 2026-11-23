// The desk the demo talks to: the repo's mock (web/mock/desk.ts), answering the window's fetch and EventSource in this
// page instead of over HTTP. Each visitor has their own; a reload starts it again.
import { handle, type MockRequest, type MockResponse } from "../../web/mock/desk.ts";

const ours = (url: URL) => url.origin === location.origin && (url.pathname.startsWith("/api/") || url.pathname === "/health");

const request = (method: string, url: URL, body: string, onClose: Set<() => void>): MockRequest => ({
  method,
  url: url.pathname + url.search,
  on: (_event, listener) => onClose.add(listener),
  [Symbol.asyncIterator]: () => {
    let left = body ? [body] : [];
    return {
      next: () => {
        const [value, ...rest] = left;
        left = rest;
        return Promise.resolve(value === undefined ? { value, done: true as const } : { value, done: false as const });
      },
    };
  },
});

// A response the mock writes into, read as a stream: JSON ends at once, the event stream stays open.
const response = () => {
  let status = 200;
  let headers: Record<string, string> = {};
  let started: (r: Response) => void = () => {};
  const ready = new Promise<Response>((ok) => {
    started = ok;
  });
  const enc = new TextEncoder();
  let push: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => {
      push = c;
    },
  });
  const res: MockResponse = {
    writeHead: (s, h) => {
      status = s;
      headers = h;
      started(new Response(stream, { status, headers }));
    },
    write: (chunk) => push?.enqueue(enc.encode(chunk)),
    end: (chunk) => {
      if (chunk) push?.enqueue(enc.encode(chunk));
      push?.close();
    },
  };
  return { res, ready };
};

const realFetch = window.fetch.bind(window);

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request ? input : null;
  const url = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input, location.href);
  if (!ours(url)) return realFetch(input, init);
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  const body = typeof init?.body === "string" ? init.body : req ? await req.text() : "";
  const { res, ready } = response();
  void handle(request(method, url, body, new Set()), res);
  return ready;
};

// The window's live updates: the mock's event stream, parsed as EventSource would.
class DemoEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 0;
  readonly url: string;
  readonly withCredentials = false;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private readonly closers = new Set<() => void>();

  constructor(url: string | URL) {
    super();
    this.url = new URL(String(url), location.href).href;
    const { res, ready } = response();
    void handle(request("GET", new URL(this.url), "", this.closers), res);
    void ready.then((r) => this.read(r));
  }

  private async read(r: Response) {
    if (this.readyState === 2 || !r.body) return;
    this.readyState = 1;
    const open = new Event("open");
    this.onopen?.(open);
    this.dispatchEvent(open);
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done || this.readyState === 2) return;
      buf += value;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let type = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) type = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (!data.length) continue;
        const e = new MessageEvent(type, { data: data.join("\n") });
        if (type === "message") this.onmessage?.(e);
        this.dispatchEvent(e);
      }
    }
  }

  close() {
    this.readyState = 2;
    for (const c of this.closers) c();
  }
}

Object.defineProperty(window, "EventSource", { value: DemoEventSource });
