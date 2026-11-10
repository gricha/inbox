// Settings → Agent → Your policy: ~/.inbox/policy.md, prose Claude sorts by. Saved with ⌘S, like the rules.
// While the file is empty the starter is in effect, so the editor shows it: editing it and saving makes it yours.
import { Effect } from "effect";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { PolicyDoc } from "../../../src/types.ts";
import { api, runUi } from "../api.ts";
import { cls, MOD, tilde, aiName } from "../format.ts";
import { ActButton } from "./Detail.tsx";
import { withCode } from "./Review.tsx";
import { judgeStatusText } from "../view.ts";

// What the editor starts from: the file, or the starter while it's empty.
const startOf = (d: PolicyDoc) => (d.text.trim() ? d.text : d.starter);

export function Policy({
  active,
  shown,
  refresh,
  now,
  flash,
  onDoc,
  children,
}: {
  active: boolean; // Settings is open: the file loads with it, for its row's help and so the view opens on it
  shown: boolean; // its view is on screen: ⌘S works
  refresh: number; // bumps on every app refresh: a clean editor re-reads the file
  now: number;
  flash: (text: string, error?: boolean) => void;
  onDoc: (d: PolicyDoc | null) => void; // the file as saved, and the judge's status
  children?: ReactNode; // the view's last rows: the hourly cap
}) {
  const [doc, setDoc] = useState<PolicyDoc | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const dirty = doc !== null && text !== startOf(doc);
  const starter = doc !== null && !doc.text.trim();
  const latest = useRef({ doc, text });
  latest.current = { doc, text };

  // While you edit, only the judge's status refreshes; the text and its base stay as you opened them.
  const load = useCallback(
    (): Effect.Effect<void> =>
      api.policy().pipe(
        Effect.match({
          onSuccess: (p) => {
            const { doc: d, text: t } = latest.current;
            if (d !== null && t !== startOf(d)) setDoc({ ...d, judge: p.judge });
            else {
              setDoc(p);
              setText(startOf(p));
            }
            setLoadError("");
          },
          onFailure: (e) => {
            setLoadError(e.message);
          },
        }),
      ),
    [],
  );

  useEffect(() => {
    const stop = new AbortController();
    if (active) runUi(load(), { signal: stop.signal });
    return () => {
      stop.abort();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- refresh only triggers a re-read
  }, [active, load, refresh]);

  function save() {
    if (!doc) return;
    setBusy(true);
    runUi(
      api.savePolicy(text, doc.hash).pipe(
        Effect.tap((r) =>
          Effect.sync(() => {
            setDoc({ ...doc, text, hash: r.hash });
            if (!text.trim()) setText(doc.starter);
            flash(
              text.trim()
                ? `Policy saved. ${aiName()} sorts your desk by it.`
                : `Policy cleared. ${aiName()} sorts by the starter policy again.`,
            );
          }),
        ),
        Effect.catch((e) =>
          e._tag === "DeskConflict" && e.kind === "Stale"
            ? // Changed under us (an agent, an editor): keep your edit, take the new file as the base.
              api.policy().pipe(
                Effect.map(setDoc),
                Effect.ignore, // no new base: the toast still says why it wasn't saved
                Effect.andThen(
                  Effect.sync(() => {
                    flash(
                      "policy.md changed since you opened it. Your edit is still here: Revert loads the new text, Save again overwrites it.",
                      true,
                    );
                  }),
                ),
              )
            : Effect.sync(() => {
                flash(e.message, true);
              }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            setBusy(false);
          }),
        ),
      ),
    );
  }

  useEffect(() => {
    onDoc(doc);
  }, [doc, onDoc]);

  // ⌘S saves the editor you're in.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s" || !wrap.current?.contains(document.activeElement)) return;
    e.preventDefault();
    if (!busy && dirty) save();
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      keys.current(e);
    };
    if (shown) window.addEventListener("keydown", h);
    return () => {
      window.removeEventListener("keydown", h);
    };
  }, [shown]);

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    if (dirty) window.addEventListener("beforeunload", h);
    return () => {
      window.removeEventListener("beforeunload", h);
    };
  }, [dirty]);

  return (
    <div className="policy" ref={wrap} data-own-save="">
      {loadError && <p className="s-live t-bad">Couldn't load the policy: {loadError}</p>}
      <textarea
        className="editor prose"
        value={text}
        placeholder={`Empty: ${aiName()} sorts by the starter policy.`}
        aria-label="Policy"
        disabled={!doc}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") e.currentTarget.blur();
        }}
      />
      <div className="editor-foot">
        {/* Filled while there's something to save: the one to press. */}
        <ActButton
          label={busy ? "Saving…" : "Save"}
          title={`Save (${MOD}S)`}
          disabled={busy || !dirty}
          className={cls(dirty && "primary")}
          run={() => {
            save();
          }}
        />
        <ActButton
          label="Revert"
          disabled={!dirty}
          run={() => {
            if (doc) setText(startOf(doc));
          }}
        />
        {doc && <code className="s-path">{tilde(doc.path)}</code>}
        <span className="grow" />
        {dirty && <span className="unsaved">Unsaved changes</span>}
      </div>
      {starter && <p className="s-live quiet">This is the starter policy. {aiName()} sorts by it until you change it.</p>}
      {/* An agent's failure is about the agent, not your work: ink, not red. */}
      {doc && <p className={cls("s-live", doc.judge.state !== "error" && "quiet")}>{withCode(judgeStatusText(doc.judge, now))}</p>}
      {children}
    </div>
  );
}
