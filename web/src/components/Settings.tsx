// Rendered from the schema in GET /api/settings: a new entry in SETTINGS (src/settings.ts) needs no change here.
import { useEffect, useRef, useState, type ChangeEvent, type ComponentType, type KeyboardEvent, type ReactNode } from "react";
import type { DesktopBridge, GitHubStatus, SettingDef, SettingsView, SettingType, SettingValue } from "../../../src/types.ts";
import { api, message } from "../api.ts";
import { ago, cls, when } from "../format.ts";
import { Rules } from "./Rules.tsx";
import { acceleratorOf, authProblem, draftOf, valueOf } from "../view.ts";

type DesktopStatus = Awaited<ReturnType<DesktopBridge["status"]>>;
// Resolves to the value the server saved, or null when it was rejected (the row shows why).
type Commit = (v: SettingValue) => Promise<SettingValue | null>;
interface FieldProps {
  def: SettingDef;
  value: SettingValue;
  commit: Commit;
  clear: () => void;
  id: string;
  invalid: boolean;
}

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

// A refetch updates the draft only while you aren't editing it, and a rejected draft stays for you to fix.
function useDraft({ def, value, commit, clear, id, invalid }: FieldProps) {
  const shown = draftOf(value);
  const [draft, setDraft] = useState(shown);
  const typed = useRef(false);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current && !typed.current) setDraft(shown);
  }, [shown]);

  async function save(text: string) {
    if (!typed.current) {
      setDraft(shown);
      return;
    }
    const v = valueOf(def, text);
    if (JSON.stringify(v) === JSON.stringify(value)) {
      typed.current = false;
      clear();
      setDraft(shown);
      return;
    }
    const saved = await commit(v);
    if (saved === null || focused.current) return;
    typed.current = false;
    setDraft(draftOf(saved));
  }

  return {
    draft,
    submit: (text: string) => {
      typed.current = true;
      setDraft(text);
      void save(text);
    },
    bind: {
      id,
      value: draft,
      "aria-invalid": invalid,
      "aria-describedby": `${id}-msg`,
      spellCheck: false,
      onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        typed.current = true;
        setDraft(e.target.value);
      },
      onFocus: () => {
        focused.current = true;
      },
      onBlur: () => {
        focused.current = false;
        void save(draft);
      },
      onKeyDown: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if (e.key === "Escape") {
          typed.current = false;
          clear();
          setDraft(shown);
          e.currentTarget.blur();
        } else if (e.key === "Enter" && e.currentTarget instanceof HTMLInputElement) e.currentTarget.blur();
      },
    },
  };
}

function NumberField(p: FieldProps) {
  const d = useDraft(p);
  return <input className="input num" type="number" min={p.def.min} max={p.def.max} step={1} {...d.bind} />;
}

// An optional setting saved as "" is off, not the default: say so instead of greying in the example.
const emptyLabel = (p: FieldProps) => (!p.def.required && p.value === "" ? (p.def.type === "hotkey" ? "Off" : "None") : p.def.placeholder);

function StringField(p: FieldProps) {
  const d = useDraft(p);
  return <input className="input" type="text" placeholder={emptyLabel(p)} autoCapitalize="off" autoCorrect="off" {...d.bind} />;
}

function TextField(p: FieldProps) {
  const d = useDraft(p);
  return <textarea className="input area" rows={Math.max(3, d.draft.split("\n").length)} {...d.bind} />;
}

function ListField(p: FieldProps) {
  const d = useDraft(p);
  const hint = p.def.pattern_hint ? `One ${p.def.pattern_hint} per line` : "One per line";
  return <textarea className="input area" rows={Math.max(2, d.draft.split("\n").length + 1)} placeholder={hint} {...d.bind} />;
}

function BooleanField({ value, commit, id }: FieldProps) {
  const [on, setOn] = useState(value === true);
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    setSynced(value);
    setOn(value === true);
  }

  async function flip(v: boolean) {
    setOn(v);
    if ((await commit(v)) === null) setOn(!v);
  }

  return (
    <input
      id={id}
      className="switch"
      type="checkbox"
      // oxlint-disable-next-line jsx-a11y/role-has-required-aria-props -- a checkbox input's state is its native checked; ARIA in HTML forbids aria-checked here
      role="switch"
      checked={on}
      aria-labelledby={`${id}-label`}
      aria-describedby={`${id}-msg`}
      onChange={(e) => {
        void flip(e.target.checked);
      }}
    />
  );
}

function HotkeyField(p: FieldProps) {
  const d = useDraft(p);
  const [recording, setRecording] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!recording) {
      d.bind.onKeyDown(e);
      return;
    }
    const bare = !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey);
    if (bare && e.key === "Tab") return;
    e.preventDefault();
    if (bare && e.key === "Escape") {
      setRecording(false);
      return;
    }
    const acc = bare && e.key === "Backspace" ? "" : acceleratorOf(e, MAC);
    if (acc === null) return;
    setRecording(false);
    e.currentTarget.blur();
    d.submit(acc);
  }

  return (
    <div className="hotkey">
      <input
        ref={input}
        className="input hotkey-input"
        type="text"
        placeholder={recording ? "Press the keys…" : emptyLabel(p)}
        readOnly={recording}
        {...d.bind}
        value={recording ? "" : d.draft}
        onKeyDown={onKeyDown}
        onBlur={() => {
          setRecording(false);
          d.bind.onBlur();
        }}
      />
      {/* mousedown would blur the input and end the recording before the click lands */}
      <button
        type="button"
        className="btn"
        aria-pressed={recording}
        aria-label={recording ? "Cancel recording" : "Record a shortcut"}
        onMouseDown={(e) => {
          e.preventDefault();
        }}
        onClick={() => {
          setRecording(!recording);
          input.current?.focus();
        }}
      >
        {recording ? "Cancel" : "Record"}
      </button>
      {recording && (
        <span className="quiet small" aria-live="polite">
          Press {MAC ? "⌃, ⌥ or ⌘" : "Ctrl or Alt"} with a key. Esc cancels, Backspace clears.
        </span>
      )}
    </div>
  );
}

const CONTROLS: Record<SettingType, ComponentType<FieldProps>> = {
  number: NumberField,
  boolean: BooleanField,
  string: StringField,
  text: TextField,
  list: ListField,
  hotkey: HotkeyField,
};

function Row({ def, view, onView, extra }: { def: SettingDef; view: SettingsView; onView: (v: SettingsView) => void; extra?: ReactNode }) {
  const [status, setStatus] = useState<"saved" | { error: string } | null>(null);
  const [epoch, setEpoch] = useState(0); // remounts the control after a reset so it drops a rejected draft
  const timer = useRef(0);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );

  async function put(patch: { set?: Record<string, SettingValue>; reset?: string[] }): Promise<SettingsView | null> {
    clearTimeout(timer.current);
    try {
      const r = await api.saveSettings(patch);
      onView(r.settings);
      if (!r.ok) {
        setStatus({ error: r.errors.map((e) => e.message).join("; ") || "not saved" });
        return null;
      }
      setStatus("saved");
      timer.current = window.setTimeout(() => {
        setStatus(null);
      }, 1600);
      return r.settings;
    } catch (e) {
      setStatus({ error: message(e) });
      return null;
    }
  }

  async function resetToDefault() {
    if (await put({ reset: [def.key] })) setEpoch((n) => n + 1);
  }

  const id = `setting-${def.key}`;
  const Control = CONTROLS[def.type] ?? StringField;
  const control = (
    <Control
      key={epoch}
      id={id}
      def={def}
      value={view.values[def.key] ?? (def.default as SettingValue)}
      invalid={typeof status === "object" && status !== null}
      clear={() => {
        setStatus(null);
      }}
      commit={async (v) => (await put({ set: { [def.key]: v } }))?.values[def.key] ?? null}
    />
  );
  const reset = view.overridden.includes(def.key) && (
    <button
      type="button"
      className="link-btn"
      title={`Default: ${draftOf(def.default) || "(empty)"}`}
      onClick={() => {
        void resetToDefault();
      }}
    >
      Reset to default
    </button>
  );

  return (
    <div className={cls("setting", `st-${def.type}`)}>
      <div className="s-label-col">
        {def.type === "boolean" ? (
          <span className="s-label" id={`${id}-label`}>
            {def.label}
          </span>
        ) : (
          <label className="s-label" htmlFor={id}>
            {def.label}
          </label>
        )}
        {def.help && <p className="s-help">{def.help}</p>}
        {reset}
      </div>
      <div className="s-control">
        {control}
        {extra}
        <div className="s-msg" id={`${id}-msg`} aria-live="polite">
          {status === "saved" && <span className="t-good">Saved</span>}
          {typeof status === "object" && status !== null && <span className="t-bad">Not saved: {status.error}</span>}
        </div>
      </div>
    </div>
  );
}

function HotkeyStatus({ s }: { s: DesktopStatus["hotkey"] }) {
  if (!s.accelerator) return <p className="s-live quiet">Off</p>;
  if (s.ok)
    return (
      <p className="s-live">
        <span className="t-good">Active.</span> Press <kbd>{s.accelerator}</kbd> from any app.
      </p>
    );
  return (
    <p className="s-live t-bad">
      Couldn't use {s.accelerator}: {s.error ?? "another app may have it"}
    </p>
  );
}

function GitHubStatusView({ gh, now }: { gh: GitHubStatus; now: number }) {
  return (
    <div className="gh">
      <div className="gh-account">
        {gh.login ? (
          <p className="gh-who">
            Signed in as <b>@{gh.login}</b>
          </p>
        ) : (
          <p className="gh-who">Not signed in yet</p>
        )}
        <p className="quiet">
          Through {gh.auth}. {gh.synced_at ? `Last synced ${ago(gh.synced_at, now)}.` : "Not synced yet."}
          {gh.rate_limit && ` ${gh.rate_limit.remaining.toLocaleString()} API requests left until ${when(gh.rate_limit.reset_at)}.`}
        </p>
      </div>
      {gh.error && (
        <div className="notice err" role="alert">
          <span>
            {gh.error}
            {authProblem(gh.error) && (
              <>
                {" "}
                Run <code>gh auth login</code> in a terminal, then sync.
              </>
            )}
          </span>
        </div>
      )}
      {gh.teams.length > 0 && (
        <div className="gh-block">
          <h3 className="s-sub">Your teams</h3>
          <p className="gh-teams">
            {gh.teams.map((t) => (
              <span key={t}>@{t}</span>
            ))}
          </p>
        </div>
      )}
      {gh.orgs.length > 0 && (
        <div className="gh-block">
          <h3 className="s-sub">Where your open items are</h3>
          <table className="orgs">
            <tbody>
              {gh.orgs.map((o) => (
                <tr key={o.org}>
                  <td className="org">{o.org}</td>
                  <td className="n">{o.items}</td>
                  <td className="space">{o.space ? `in ${o.space}` : <span className="quiet">in Personal</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="quiet small">
            Spaces decide which searches run for which orgs. Change them in <a href="#/settings/rules">Rules</a>.
          </p>
        </div>
      )}
    </div>
  );
}

// "/Users/me/.review-desk/settings.json" → "~/.review-desk/settings.json"
const tilde = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+(?=\/)|^[A-Za-z]:\\Users\\[^\\]+(?=\\)/, "~");

const RULES = {
  id: "rules",
  title: "Rules",
  help: "Which GitHub searches feed the queue, and the rules that decide where each item lands. Everything a rule sends to later, FYI or hide is sorted away for you.",
};

export function Settings({
  active,
  section: asked,
  view,
  now,
  loads,
  onView,
  flash,
  onRulesSaved,
  onRulesDirty,
}: {
  active: boolean;
  section: string;
  view: SettingsView | null;
  now: number;
  loads: number;
  onView: (v: SettingsView) => void;
  flash: (text: string, error?: boolean) => void;
  onRulesSaved: () => void;
  onRulesDirty: (dirty: boolean) => void;
}) {
  const [live, setLive] = useState<DesktopStatus | null>(null);
  const desktop = (window as Window & { desktop?: DesktopBridge }).desktop;
  const sections = view ? [...view.sections.slice(0, 1), RULES, ...view.sections.slice(1)] : [RULES];
  // An unknown section (an old link, a typo) shows the first one rather than an empty pane.
  const section = !view || sections.some((x) => x.id === asked) ? asked : (sections[0] ?? RULES).id;
  const [rulesSeen, setRulesSeen] = useState(section === "rules");
  useEffect(() => {
    if (section === "rules") setRulesSeen(true);
  }, [section]);

  // The desktop app re-registers the hotkey when settings.json changes; give it a moment before asking.
  useEffect(() => {
    const t =
      desktop && view
        ? setTimeout(() => {
            desktop.status().then(setLive, () => {});
          }, 300)
        : undefined;
    return () => {
      clearTimeout(t);
    };
  }, [view, desktop]);

  const s = sections.find((x) => x.id === section) ?? null;
  const defs = view && s ? view.defs.filter((d) => d.section === s.id) : [];
  const desktopOnly = defs.length > 0 && defs.every((d) => d.desktop);

  return (
    <div className="settings" hidden={!active}>
      <select
        className="input s-pick"
        aria-label="Settings section"
        value={section}
        onChange={(e) => {
          location.hash = `#/settings/${e.target.value}`;
        }}
      >
        {sections.map((x) => (
          <option key={x.id} value={x.id}>
            {x.title}
          </option>
        ))}
      </select>
      <div className="s-pane">
        {!view && section !== "rules" && <p className="quiet">Loading…</p>}
        {view && view.errors.length > 0 && (
          <div className="notice warn" role="alert">
            <span>
              settings.json has{" "}
              {view.errors.length === 1
                ? "a problem, so that setting uses its default"
                : `${view.errors.length} problems, so those settings use their defaults`}
              :
              {view.errors.map((e) => (
                <span key={e.path} className="s-file-err">
                  <code>{e.path}</code> {e.message}
                </span>
              ))}
            </span>
          </div>
        )}
        {s && (
          <header className="s-head-block">
            <h1>{s.title}</h1>
            {desktopOnly && !desktop ? (
              <p className="s-intro">Only the desktop app uses these. Open it to change how it behaves.</p>
            ) : (
              s.help && <p className="s-intro">{s.help}</p>
            )}
          </header>
        )}
        {view && section === "github" && <GitHubStatusView gh={view.github} now={now} />}
        {view && section !== "rules" && defs.length > 0 && (
          <div className="s-fields">
            {defs.map((d) => (
              <Row
                key={d.key}
                def={d}
                view={view}
                onView={onView}
                extra={d.type === "hotkey" && live && <HotkeyStatus s={live.hotkey} />}
              />
            ))}
          </div>
        )}
        {rulesSeen && (
          <Rules active={active && section === "rules"} refresh={loads} flash={flash} onSaved={onRulesSaved} onDirty={onRulesDirty} />
        )}
        {view && section !== "rules" && (
          <p className="s-path quiet" title={view.path}>
            Saved as you go to <code>{tilde(view.path)}</code>
          </p>
        )}
      </div>
    </div>
  );
}
