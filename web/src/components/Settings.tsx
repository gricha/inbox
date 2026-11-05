// Rendered from the schema in GET /api/settings: a new entry in SETTINGS (src/settings.ts) needs no change here.
import { useEffect, useRef, useState, type ChangeEvent, type ComponentType, type KeyboardEvent, type ReactNode } from "react";
import type { AgentStatus, DesktopBridge, GitHubStatus, SettingDef, SettingsView, SettingType, SettingValue } from "../../../src/types.ts";
import { api, message } from "../api.ts";
import { ago, cls, tilde, when } from "../format.ts";
import { Automations } from "./Automations.tsx";
import { Policy } from "./Policy.tsx";
import { Rules } from "./Rules.tsx";
import { withCode } from "./Review.tsx";
import { SkLines } from "./Skeleton.tsx";
import { SourceLine } from "./Source.tsx";
import { acceleratorOf, authProblem, draftOf, valueOf } from "../view.ts";
import { applyTheme, savedTheme, THEMES, type ThemeId } from "../theme.ts";

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
  // A value with a set shape (a time window) is short; free text gets the column.
  return (
    <input
      className={cls("input", p.def.pattern && "short")}
      type="text"
      placeholder={emptyLabel(p)}
      autoCapitalize="off"
      autoCorrect="off"
      {...d.bind}
    />
  );
}

function TextField(p: FieldProps) {
  const d = useDraft(p);
  return <textarea className="input area" rows={Math.max(3, d.draft.split("\n").length)} {...d.bind} />;
}

function ListField(p: FieldProps) {
  const d = useDraft(p);
  const hint = p.def.placeholder ?? (p.def.pattern_hint ? `One ${p.def.pattern_hint.replace(/^an? /, "")} per line` : "One per line");
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

function SelectField({ def, value, commit, id, invalid }: FieldProps) {
  const [picked, setPicked] = useState(String(value));
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    setSynced(value);
    setPicked(String(value));
  }

  async function pick(v: string) {
    const was = picked;
    setPicked(v);
    if ((await commit(v)) === null) setPicked(was);
  }

  return (
    <select
      id={id}
      className="input choice"
      value={picked}
      aria-invalid={invalid}
      aria-describedby={`${id}-msg`}
      onChange={(e) => {
        void pick(e.target.value);
      }}
    >
      {def.options?.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
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
  select: SelectField,
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
        {/* Reset sits on the label's line, so it never reads as the setting's help. */}
        <div className="s-label-row">
          {def.type === "boolean" ? (
            <span className="s-label" id={`${id}-label`}>
              {def.label}
            </span>
          ) : (
            <label className="s-label" htmlFor={id}>
              {def.label}
            </label>
          )}
          {reset}
        </div>
        {def.help && <p className="s-help">{def.help}</p>}
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

function PausedLine({ p, label, now }: { p: SettingsView["paused"]["ai"]; label: string; now: number }) {
  if (!p) return null;
  const left = Math.max(1, Math.round((Date.parse(p.until) - now) / 60_000));
  return (
    <p className="s-live">
      <b>{label}</b> {withCode(p.why.replace(/\.?$/, "."))} Next try in {left}m.
    </p>
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

const SKILL_STATE = { installed: "installed", outdated: "out of date", missing: "not installed" };

// Whether Claude Code has the desk's MCP tools and skill, and Connect when it doesn't.
function AgentLink({ active, loads }: { active: boolean; loads: number }) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Re-read on every app refresh: the agent's own config can change outside the desk.
  useEffect(() => {
    if (active) api.agents().then(setStatus, () => {});
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- loads only triggers a re-read
  }, [active, loads]);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.connectAgent());
    } catch (e) {
      setError(message(e));
      setStatus(await api.agents().catch(() => status));
    } finally {
      setBusy(false);
    }
  }

  if (!status?.mcp || !status.skill) return null;
  const missing = !status.mcp.connected || status.skill.state !== "installed";
  return (
    <div className="agent">
      <p className="s-live quiet" title={status.mcp.command}>
        MCP tools: {status.mcp.connected ? "connected" : "not connected"}
      </p>
      <p className="s-live quiet" title={status.skill.path}>
        Skill: {SKILL_STATE[status.skill.state]}
      </p>
      {missing && (
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => {
            void connect();
          }}
        >
          {busy ? "Connecting…" : "Connect"}
        </button>
      )}
      {error && <p className="s-live t-bad">Couldn't connect: {error}</p>}
    </div>
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

// Not from the schema: the theme is this device's, so it's kept here, not on the desk.
const APPEARANCE = { id: "appearance", title: "Appearance", help: "This device's theme. Other windows and devices keep their own." };

function Appearance() {
  const [theme, setTheme] = useState<ThemeId>(savedTheme);
  return (
    <div className="s-fields">
      <div className="setting st-select">
        <div className="s-label-col">
          <label className="s-label" htmlFor="s-theme">
            Theme
          </label>
          <p className="s-help">System follows your computer's light or dark.</p>
        </div>
        <div className="s-control">
          <select
            id="s-theme"
            className="input choice"
            value={theme}
            onChange={(e) => {
              const t = e.target.value as ThemeId;
              applyTheme(t);
              setTheme(t);
            }}
          >
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

const RULES = {
  id: "rules",
  title: "Rules",
  help: "Which GitHub searches feed the queue, and the rules that place each item. Claude then sorts it by your policy, with the rule's placement as its hint; a hard rule's bucket is a floor.",
};

export function Settings({
  active,
  section,
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
  // Rules go after the sources and the agent they feed (GitHub, Agents), before the smaller settings.
  const at = view ? Math.max(1, view.sections.findIndex((x) => x.id === "agent") + 1) : 0;
  // Appearance goes before the desktop app's settings, or last.
  const app = view ? (view.sections.findIndex((x) => x.id === "app") + 1 || view.sections.length + 1) - 1 : 0;
  const sections = view
    ? [...view.sections.slice(0, at), RULES, ...view.sections.slice(at, app), APPEARANCE, ...view.sections.slice(app)]
    : [RULES];

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

  // One page with every section; a link to a section (#/settings/rules) scrolls to it.
  const ready = view !== null;
  useEffect(() => {
    if (!active || !ready) return;
    if (section === "github") window.scrollTo({ top: 0 });
    else document.querySelector(`#s-${section}`)?.scrollIntoView({ block: "start" });
  }, [active, section, ready]);

  return (
    <div className="settings" hidden={!active}>
      {/* The sidebar names the page; the head is only where it's saved. */}
      <header className="s-page-head">
        {view && (
          <p className="quiet" title={view.path}>
            Saved as you go to <code>{tilde(view.path)}</code>
          </p>
        )}
      </header>
      {!view && (
        <section className="s-section" aria-busy="true" aria-label="Loading">
          <h2>
            <span className="sk" />
          </h2>
          <SkLines count={3} className="s-intro" />
        </section>
      )}
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
      {sections.map((x) => {
        const defs = view ? view.defs.filter((d) => d.section === x.id) : [];
        const desktopOnly = defs.length > 0 && defs.every((d) => d.desktop);
        return (
          <section key={x.id} id={`s-${x.id}`} className="s-section" aria-labelledby={`s-${x.id}-title`}>
            <h2 id={`s-${x.id}-title`}>{x.title}</h2>
            {desktopOnly && !desktop ? (
              <p className="s-intro">Only the desktop app uses these.</p>
            ) : (
              x.help && <p className="s-intro">{x.help}</p>
            )}
            {view && x.id === "github" && <GitHubStatusView gh={view.github} now={now} />}
            {/* A pause after failures in a row (an expired login) is the agent's, said once here rather than on every PR. */}
            {view && x.id === "review" && <PausedLine p={view.paused.ai} label="AI reviews are paused:" now={now} />}
            {x.id === "agent" && <AgentLink active={active} loads={loads} />}
            {x.id === "rules" && <Rules active={active} refresh={loads} flash={flash} onSaved={onRulesSaved} onDirty={onRulesDirty} />}
            {x.id === "policy" && <Policy active={active} refresh={loads} now={now} flash={flash} />}
            {x.id === "automations" && <Automations active={active} refresh={loads} now={now} flash={flash} />}
            {x.id === "appearance" && <Appearance />}
            {view && defs.length > 0 && (
              <div className="s-fields">
                {defs.map((d) => (
                  <Row
                    key={d.key}
                    def={d}
                    view={view}
                    onView={onView}
                    extra={
                      d.key === "app.source"
                        ? live && <SourceLine s={live.source ?? null} />
                        : d.type === "hotkey" && live && <HotkeyStatus s={live.hotkey} />
                    }
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
