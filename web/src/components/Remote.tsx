// Settings → Network → Tailscale: using the desk from your other devices, and pairing them.
import { Effect } from "effect";
import { useState } from "react";
import { renderSVG } from "uqr";
import type { PairCode, RemoteView } from "../../../src/types.ts";
import { api, runUi } from "../api.ts";
import { useKeyed } from "../keyed.ts";
import { ago, cls, copyText } from "../format.ts";
import { withCode } from "./Prose.tsx";

// Under Use it from your other devices: where the desk serves and for whom, or why it can't, then each paired device with
// Revoke. Turning on takes Tailscale a moment, so a row still on its way is read again.
export function RemoteRows({
  active,
  loads,
  on,
  now,
  flash,
}: {
  active: boolean;
  loads: number;
  on: boolean;
  now: number;
  flash: (text: string) => void;
}) {
  const [view, setView] = useState<RemoteView | null>(null);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // A code on screen, and the devices paired before it: a new one among them is the code's, and closes it.
  const [pairing, setPairing] = useState<(PairCode & { before: string[] }) | null>(null);
  useKeyed(active ? `${loads} ${on} ${tick}` : null, (signal) => {
    runUi(api.remote().pipe(Effect.map(setView), Effect.ignore), { signal });
  });
  const turning = !!view && (view.on !== on || (on && !view.url && view.text === "Off.") || (!on && !!view.url));
  // Each answer still on its way sets a new view, which sets the next try.
  useKeyed(turning ? view : null, () => {
    const t = setTimeout(() => {
      setTick((n) => n + 1);
    }, 1000);
    return () => {
      clearTimeout(t);
    };
  });

  // Read again every 2s while a code waits for its device; one paired since closes it.
  const added = pairing ? view?.devices.find((d) => !pairing.before.includes(d.id)) : undefined;
  useKeyed(added?.id ?? null, () => {
    setPairing(null);
    if (added) flash(`Paired ${added.name}`);
  });
  useKeyed(pairing && !added ? view : null, () => {
    const t = setTimeout(() => {
      setTick((n) => n + 1);
    }, 2000);
    return () => {
      clearTimeout(t);
    };
  });

  function pair() {
    setError(null);
    runUi(
      api.pairCode().pipe(
        Effect.tap((p) =>
          Effect.sync(() => {
            setPairing({ ...p, before: view?.devices.map((d) => d.id) ?? [] });
          }),
        ),
        Effect.catch((e) =>
          Effect.sync(() => {
            setError(e.message);
          }),
        ),
      ),
    );
  }

  function copy(text: string, what: string) {
    runUi(
      copyText(text).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            flash(`Copied ${what}`);
          }),
        ),
        Effect.catch(() =>
          Effect.sync(() => {
            flash("Couldn't copy");
          }),
        ),
      ),
    );
  }

  function revoke(id: string, name: string) {
    setError(null);
    runUi(
      api.revokeDevice(id).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            setView((v) => v && { ...v, devices: v.devices.filter((d) => d.id !== id) });
            flash(`Revoked ${name}`);
          }),
        ),
        Effect.catch((e) =>
          Effect.sync(() => {
            setError(e.message);
          }),
        ),
      ),
    );
  }

  if (!view) return null;
  const failed = on && !view.url && !turning;
  return (
    <>
      {on && (
        <div className="setting s-status">
          <div className="s-label-col">
            <p className="s-label">{view.url ? `At ${view.url}` : failed ? "Can't serve over Tailscale" : "Starting"}</p>
            <p className={cls("s-help", failed && "t-bad")}>
              {view.url ? `For ${view.login}'s devices, each paired once.` : failed ? withCode(view.text) : "Asking Tailscale."}
            </p>
          </div>
          {view.url && (
            <div className="s-control">
              <button type="button" className="act primary go" onClick={pair}>
                {pairing ? "New code" : "Pair a device"}
              </button>
            </div>
          )}
        </div>
      )}
      {on && view.url && pairing && (
        <PairRow
          p={pairing}
          expired={Date.parse(pairing.expires_at) <= now}
          onCopy={copy}
          onClose={() => {
            setPairing(null);
          }}
        />
      )}
      {view.devices.map((d) => (
        <div key={d.id} className="setting s-status">
          <div className="s-label-col">
            <p className="s-label">{d.name}</p>
            <p className="s-help">
              {d.kind === "browser" ? "A browser" : d.kind === "phone" ? "A phone" : "A machine's agents"}, paired {ago(d.created_at, now)}
              {d.last_used_at ? `, last used ${ago(d.last_used_at, now)}` : ", not used yet"}.
            </p>
          </div>
          <div className="s-control">
            <button
              type="button"
              className="act"
              onClick={() => {
                revoke(d.id, d.name);
              }}
            >
              Revoke
            </button>
          </div>
        </div>
      ))}
      {error && (
        <div className="setting s-status">
          <p className="s-help t-bad">{error}</p>
        </div>
      )}
    </>
  );
}

// A code being paired: its QR for the iPhone app's scanner (a phone's own camera would open the link in Safari and spend the code there), the link for a browser, the command for another machine's agents.
function PairRow({
  p,
  expired,
  onCopy,
  onClose,
}: {
  p: PairCode;
  expired: boolean;
  onCopy: (text: string, what: string) => void;
  onClose: () => void;
}) {
  const connect = `bin/inbox connect ${p.url} --code ${p.code}`;
  return (
    <div className="setting s-pair">
      {!expired && (
        <img
          className="s-qr"
          alt={`QR code for ${p.pair_url}`}
          src={`data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(p.pair_url))}`}
        />
      )}
      <div className="s-label-col">
        <p className="s-label">{expired ? "That code expired" : `Code ${p.code}`}</p>
        {expired ? (
          <p className="s-help">Press New code for another.</p>
        ) : (
          <>
            <p className="s-help">
              Scan it in the Inbox app on your phone, or open the link in the other device's browser. Works once, for 10 minutes.
            </p>
            <p className="s-help">
              <code>{p.pair_url}</code>{" "}
              <button
                type="button"
                className="act"
                onClick={() => {
                  onCopy(p.pair_url, "the link");
                }}
              >
                Copy link
              </button>
            </p>
            <p className="s-help">
              Another machine with an Inbox checkout: <code>{connect}</code>{" "}
              <button
                type="button"
                className="act"
                onClick={() => {
                  onCopy(connect, "the command");
                }}
              >
                Copy command
              </button>
            </p>
          </>
        )}
      </div>
      <div className="s-control">
        <button type="button" className="act" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
