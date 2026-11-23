import { Effect } from "effect";
import { useEffect, useState } from "react";
import type { SetupView } from "../../../src/types.ts";
import { api, runUi } from "../api.ts";
import { cls, copyText } from "../format.ts";
import { Mark } from "./Mark.tsx";

const RECHECK_MS = 10_000;

// The first-run page, in the window's place until GitHub is connected and you've picked your agent. The desk decides what
// it says (GET /api/setup). What's missing is a step to take, not an error: the command to run, and Check again, which the
// page also does by itself (and when the window comes back) until nothing's left to wait on. Use connects that agent as
// Settings → Agent's Connect does.
export function Setup({ view, onChange }: { view: SetupView; onChange: (v: SetupView) => void }) {
  const [busy, setBusy] = useState<string | null>(null); // "check", or the agent being connected
  const [error, setError] = useState<{ at: string; text: string } | null>(null);
  const github = view.github;
  const waiting = !github.login || (!view.picked && view.agents.every((a) => a.fix));

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

  useEffect(() => {
    const quiet = () => {
      if (!waiting || busy) return;
      runUi(
        api.checkSetup().pipe(
          Effect.match({
            onSuccess: onChange,
            onFailure: (e) => {
              setError({ at: "check", text: e.message });
            },
          }),
        ),
      );
    };
    const timer = window.setInterval(quiet, RECHECK_MS);
    window.addEventListener("focus", quiet);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", quiet);
    };
  }, [waiting, busy, onChange]);

  const again = (
    <button type="button" className="act" disabled={!!busy} onClick={check}>
      {busy === "check" ? "Checking…" : "Check again"}
    </button>
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
              <p className="s-label">{github.login ? `Signed in as @${github.login}` : github.step}</p>
              {!github.login && (
                <p className={cls("s-help", error?.at === "check" && "t-bad")} title={github.detail ?? undefined}>
                  {error?.at === "check" ? (
                    error.text
                  ) : (
                    <>
                      {github.why}
                      {github.url ? (
                        <>
                          {" Get it from "}
                          <a href={github.url} target="_blank" rel="noreferrer">
                            {github.url.replace(/^https:\/\//, "")}
                          </a>
                          , then run this in a terminal:
                        </>
                      ) : (
                        github.fix && " Run this in a terminal:"
                      )}
                    </>
                  )}
                </p>
              )}
              {!github.login && github.fix && <Command text={github.fix} />}
            </div>
            {!github.login && <div className="s-control">{again}</div>}
          </div>
        </div>

        <h2 className="setup-head">Your agent</h2>
        <p className="setup-help">
          Your agent reads and sorts your desk, reviews PRs before you open them and gets the PRs you hand off merged, on your own login.
          Inbox works with any one of these.
        </p>
        <div className="lines s-sheet">
          {view.agents.map((a) => (
            <div className="setting s-status" key={a.id}>
              <div className="s-label-col">
                <p className="s-label">{a.name}</p>
                <p className={cls("s-help", error?.at === a.id && "t-bad")}>
                  {error?.at === a.id
                    ? error.text
                    : view.picked === a.id
                      ? "Your agent: Inbox's MCP tools and skill are installed in it."
                      : !a.fix
                        ? "Installed and signed in."
                        : a.installed
                          ? `Sign in to ${a.name} to use it here. Run this in a terminal:`
                          : `Install ${a.name} to use it here. Run this in a terminal:`}
                </p>
                {view.picked !== a.id && a.fix && <Command text={a.fix} />}
              </div>
              {view.picked !== a.id && (
                <div className="s-control">
                  {a.fix ? (
                    again
                  ) : (
                    <button
                      type="button"
                      className={cls("act", !view.picked && "primary go")}
                      disabled={!!busy}
                      onClick={() => {
                        send(a.id, api.chooseAgent(a.id));
                      }}
                    >
                      {busy === a.id ? "Installing…" : `Use ${a.name}`}
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

// A command to run, and a button that copies it.
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="setup-run">
      <code>{text}</code>
      <button
        type="button"
        className="act"
        onClick={() => {
          runUi(
            copyText(text).pipe(
              Effect.match({
                onSuccess: () => {
                  setCopied(true);
                  window.setTimeout(() => {
                    setCopied(false);
                  }, 1500);
                },
                onFailure: () => {
                  setCopied(false);
                },
              }),
            ),
          );
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
