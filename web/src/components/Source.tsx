// The desktop app running the desk from a checkout (Settings → Desktop app → Run from a checkout).
import { useEffect, useState } from "react";
import type { SourceStatus } from "../../../src/types.ts";
import { tilde } from "../format.ts";
import { desktop } from "../theme.ts";

// While the desk is unreachable: is that the desk from a checkout restarting, or stopped until the next change?
export function useSourceDown(down: boolean): SourceStatus | null {
  const [s, setS] = useState<SourceStatus | null>(null);
  useEffect(() => {
    let live = true;
    const ask = async () => {
      const st = await desktop?.status().catch(() => null);
      if (live) setS(st?.source ?? null);
    };
    const t = down && desktop ? setInterval(() => void ask(), 1000) : undefined;
    if (t) void ask();
    return () => {
      live = false;
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
