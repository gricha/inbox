import { Effect } from "effect";
import { useState } from "react";
import type { SetupView } from "../../../src/types.ts";
import { api, runUi } from "../api.ts";
import { cls } from "../format.ts";
import { Mark } from "./Mark.tsx";

// The first-run page, in the window's place until you pick your agent: GitHub, then the agent. The desk decides what it
// says (GET /api/setup); Retry asks it again, and Use connects that agent as Settings → Agent's Connect does.
export function Setup({ view, onChange }: { view: SetupView; onChange: (v: SetupView) => void }) {
  const [busy, setBusy] = useState<string | null>(null); // "check", or the agent being connected
  const [error, setError] = useState<{ at: string; text: string } | null>(null);
  const github = view.github;

  function send(at: string, call: Effect.Effect<SetupView, { message: string }>) {
    setBusy(at);
    setError(null);
    runUi(
      call.pipe(
        Effect.match({
          onSuccess: onChange,
          onFailure: (e) => {
            setError({ at, text: e.message });
          },
        }),
        Effect.ensuring(
          Effect.sync(() => {
            setBusy(null);
          }),
        ),
      ),
    );
  }
  const check = () => {
    send("check", api.checkSetup());
  };
  const retry = (
    <button type="button" className="act" disabled={!!busy} onClick={check}>
      {busy === "check" ? "Checking…" : "Retry"}
    </button>
  );
  const run = (fix: string) => (
    <>
      Run <code>{fix}</code> in a terminal, then Retry.
    </>
  );

  return (
    <main className="setup">
      <div className="setup-col">
        <h1 className="setup-title">
          <Mark />
          Set up Inbox
        </h1>

        <h2 className="setup-head">GitHub</h2>
        <div className="lines s-sheet">
          <div className="setting s-status">
            <div className="s-label-col">
              <p className="s-label">{github.login ? `Signed in as @${github.login}` : github.error}</p>
              {!github.login && (
                <p className={cls("s-help", error?.at === "check" && "t-bad")}>
                  {error?.at === "check" ? error.text : github.fix ? run(github.fix) : "Check your connection, then Retry."}
                </p>
              )}
            </div>
            {!github.login && <div className="s-control">{retry}</div>}
          </div>
        </div>

        <h2 className="setup-head">Your agent</h2>
        <p className="setup-help">It reviews PRs before you open them and gets the PRs you hand off merged, on your own login.</p>
        <div className="lines s-sheet">
          {view.agents.map((a) => (
            <div className="setting s-status" key={a.id}>
              <div className="s-label-col">
                <p className="s-label">{a.name}</p>
                <p className={cls("s-help", error?.at === a.id && "t-bad")}>
                  {error?.at === a.id ? (
                    error.text
                  ) : a.fix ? (
                    <>
                      {a.installed ? "Not logged in." : "Not installed."}{" "}
                      {github.login ? (
                        run(a.fix)
                      ) : (
                        <>
                          Run <code>{a.fix}</code> in a terminal.
                        </>
                      )}
                    </>
                  ) : (
                    "Installed and logged in."
                  )}
                </p>
              </div>
              {github.login && (
                <div className="s-control">
                  {a.fix ? (
                    retry
                  ) : (
                    <button
                      type="button"
                      className="act primary go"
                      disabled={!!busy}
                      onClick={() => {
                        send(a.id, api.chooseAgent(a.id));
                      }}
                    >
                      {busy === a.id ? "Connecting…" : `Use ${a.name}`}
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
