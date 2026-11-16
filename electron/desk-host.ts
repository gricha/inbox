// The app's own desk, in an Electron utility process so its synchronous work never holds up the window. electron/main.ts
// forks it and is its log, its notifications and its installer, over the parent port (messages in lib.ts).
import { Effect } from "effect";
import { Upstream } from "../src/errors.ts";
import { startDesk } from "../src/server.ts";
import type { AppUpdater } from "../src/updates.ts";
import { DeskFailed, toHost, type FromHost } from "./lib.ts";

const port = process.parentPort;
const send = (m: FromHost) => {
  port.postMessage(m);
};
const log = (msg: string) => {
  send({ type: "log", msg });
};

let close: (() => Promise<void>) | null = null;
let installs = 0;
const installing = new Map<number, (error: string | undefined) => void>();

// The app downloads and installs; on success it quits, this process with it, so only a failure comes back.
const install = (): Effect.Effect<void, Upstream> =>
  Effect.callback<void, Upstream>((resume) => {
    const id = ++installs;
    installing.set(id, (error) => {
      resume(error === undefined ? Effect.void : Effect.fail(new Upstream({ message: error })));
    });
    send({ type: "install", id });
    return Effect.sync(() => {
      installing.delete(id);
    });
  });

const start = (o: { port: number; home: string; app?: { version: string; install: boolean } }) => {
  const app: AppUpdater | undefined = o.app && { version: o.app.version, ...(o.app.install ? { install } : {}) };
  Effect.runFork(
    startDesk({
      port: o.port,
      home: o.home,
      log,
      notify: (title, body) => {
        send({ type: "notify", title, body });
      },
      ...(app && { app }),
    }).pipe(
      Effect.match({
        onFailure: (e) => {
          send({ type: "failed", message: e.message });
        },
        onSuccess: (s) => {
          close = () => s.close();
          send({ type: "started" });
        },
      }),
    ),
  );
};

const stop = () => {
  const closing = close;
  close = null;
  Effect.runFork(
    Effect.tryPromise({ try: () => closing?.() ?? Promise.resolve(), catch: (cause) => new DeskFailed({ cause }) }).pipe(
      Effect.catch((e) =>
        Effect.sync(() => {
          log(`closing the desk: ${e.message}`);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          send({ type: "stopped" });
        }),
      ),
    ),
  );
};

port.on("message", (e) => {
  const m = toHost(e.data);
  if (!m) {
    log(`the desk's process can't read what the app sent: ${JSON.stringify(e.data)}`);
    return;
  }
  if (m.type === "start") start(m);
  else if (m.type === "stop") stop();
  else installing.get(m.id)?.(m.error);
});
