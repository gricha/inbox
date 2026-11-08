// The desktop app running the desk from a checkout (Settings → This device → Run from a checkout).
import { Effect } from "effect";
import { useEffect, useState } from "react";
import type { SourceStatus } from "../../../src/types.ts";
import { runUi } from "../api.ts";
import { tilde } from "../format.ts";
import { desktop } from "../theme.ts";

// While the desk is unreachable: is that the desk from a checkout restarting, or stopped until the next change?
export function useSourceDown(down: boolean): SourceStatus | null {
  const [s, setS] = useState<SourceStatus | null>(null);
  useEffect(() => {
    const stop = new AbortController();
    const ask = () => {
      void runUi(
        Effect.tryPromise({ try: () => desktop?.status() ?? Promise.resolve(null), catch: (e) => e }).pipe(
          Effect.map((st) => st?.source ?? null),
          Effect.orElseSucceed(() => null), // the app not answering: nothing to say beyond the desk being down
          Effect.map(setS),
        ),
        { signal: stop.signal },
      );
    };
    const t = down && desktop ? setInterval(ask, 1000) : undefined;
    if (t) ask();
    return () => {
      stop.abort();
      clearInterval(t);
      setS(null);
    };
  }, [down]);
  return down && (s?.state === "running" || s?.state === "failed") ? s : null;
}

export function SourceNotice({ s }: { s: SourceStatus }) {
  return (
    <div className="notice calm" aria-live="polite">
      {s.state === "running" ? (
        <span>
          Restarting the desk with the latest changes in <code>{tilde(s.dir)}</code>…
        </span>
      ) : (
        <span>
          The desk in <code>{tilde(s.dir)}</code> stopped. It starts again on the next change under src/ or after npm install.
          {s.detail && <pre className="notice-log">{s.detail}</pre>}
        </span>
      )}
    </div>
  );
}

// Under the setting in Settings.
export function SourceLine({ s }: { s: SourceStatus | null }) {
  if (!s) return null;
  if (s.state === "invalid") return <p className="s-live t-bad">{tilde(s.detail ?? "")}.</p>;
  if (s.state === "attached")
    return (
      <p className="s-live">
        A desk was already running on its port when the app started, so the app uses that one. Quit it to run from{" "}
        <code>{tilde(s.dir)}</code>.
      </p>
    );
  if (s.state === "failed")
    return (
      <div className="s-live">
        <p className="t-bad">
          The desk in <code>{tilde(s.dir)}</code> stopped. It starts again on the next change under src/ or after npm install.
        </p>
        {s.detail && <pre className="notice-log">{s.detail}</pre>}
      </div>
    );
  return (
    <p className="s-live">
      <span className="t-good">Running</span> from <code>{tilde(s.dir)}</code>
      {s.log && (
        <>
          , output in <code>{tilde(s.log)}</code>
        </>
      )}
      .
    </p>
  );
}
