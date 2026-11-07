// Settings → Policy: ~/.review-desk/policy.md, prose Claude sorts by. Saved with ⌘S, like the rules.
// While the file is empty the starter is in effect, so the editor shows it: editing it and saving makes it yours.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PolicyDoc } from "../../../src/types.ts";
import { api, message } from "../api.ts";
import { cls, MOD, tilde } from "../format.ts";
import { ActButton } from "./Detail.tsx";
import { withCode } from "./Review.tsx";
import { judgeStatusText } from "../view.ts";

// What the editor starts from: the file, or the starter while it's empty.
const shown = (d: PolicyDoc) => (d.text.trim() ? d.text : d.starter);

export function Policy({
  active,
  refresh,
  now,
  flash,
}: {
  active: boolean;
  refresh: number; // bumps on every app refresh: a clean editor re-reads the file
  now: number;
  flash: (text: string, error?: boolean) => void;
}) {
  const [doc, setDoc] = useState<PolicyDoc | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const dirty = doc !== null && text !== shown(doc);
  const starter = doc !== null && !doc.text.trim();
  const latest = useRef({ doc, text });
  latest.current = { doc, text };

  // While you edit, only the judge's status refreshes; the text and its base stay as you opened them.
  const load = useCallback(async () => {
    try {
      const p = await api.policy();
      const { doc: d, text: t } = latest.current;
      if (d !== null && t !== shown(d)) setDoc({ ...d, judge: p.judge });
      else {
        setDoc(p);
        setText(shown(p));
      }
      setLoadError("");
    } catch (e) {
      setLoadError(message(e));
    }
  }, []);

  useEffect(() => {
    if (active) void load();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- refresh only triggers a re-read
  }, [active, load, refresh]);

  async function save() {
    if (!doc) return;
    setBusy(true);
    try {
      const r = await api.savePolicy(text, doc.hash);
      setDoc({ ...doc, text, hash: r.hash });
      if (!text.trim()) setText(doc.starter);
      flash(text.trim() ? "Policy saved. Claude sorts your desk by it." : "Policy cleared. Claude sorts by the starter policy again.");
    } catch (e) {
      if ((e as { status?: number }).status === 409) {
        // Changed under us (an agent, an editor): keep your edit, take the new file as the base.
        const p = await api.policy().catch(() => null);
        if (p) setDoc(p);
        flash("policy.md changed since you opened it. Your edit is still here: Revert loads the new text, Save again overwrites it.", true);
      } else flash(message(e), true);
    } finally {
      setBusy(false);
    }
  }

  // ⌘S saves the editor you're in: Rules has its own on the same page.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s" || !wrap.current?.contains(document.activeElement)) return;
    e.preventDefault();
    if (!busy && dirty) void save();
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      keys.current(e);
    };
    if (active) window.addEventListener("keydown", h);
    return () => {
      window.removeEventListener("keydown", h);
    };
  }, [active]);

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
        placeholder="Empty: Claude sorts by the starter policy."
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
        <ActButton
          label={busy ? "Saving…" : "Save"}
          title={`Save (${MOD}S)`}
          disabled={busy || !dirty}
          run={() => {
            void save();
          }}
        />
        <ActButton
          label="Revert"
          disabled={!dirty}
          run={() => {
            if (doc) setText(shown(doc));
          }}
        />
        <span className="grow" />
        {dirty && <span className="unsaved">Unsaved changes</span>}
      </div>
      {starter && <p className="s-live quiet">This is the starter policy. Claude sorts by it until you change it.</p>}
      {/* An agent's failure is about the agent, not your work: ink, not red. */}
      {doc && <p className={cls("s-live", doc.judge.state !== "error" && "quiet")}>{withCode(judgeStatusText(doc.judge, now))}</p>}
      <p className="s-path quiet" title={doc?.path}>
        <code>{doc ? tilde(doc.path) : "…"}</code>
      </p>
    </div>
  );
}
