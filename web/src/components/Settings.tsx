// Rendered from the schema in GET /api/settings: a new entry in SETTINGS (src/settings.ts) needs no change here.
import { Effect } from "effect";
import { Fragment, useEffect, useRef, useState, type ChangeEvent, type ComponentType, type KeyboardEvent, type ReactNode } from "react";
import type { AgentStatus, DesktopBridge, GitHubStatus, SettingDef, SettingsView, SettingType, SettingValue } from "../../../src/types.ts";
import { api, runUi } from "../api.ts";
import { ago, cls, MAC, when } from "../format.ts";
import { Automations } from "./Automations.tsx";
import { Policy } from "./Policy.tsx";
import { Rules } from "./Rules.tsx";
import { withCode } from "./Review.tsx";
import { SkLines } from "./Skeleton.tsx";
import { SourceLine } from "./Source.tsx";
import { acceleratorOf, authProblem, draftOf, valueOf } from "../view.ts";
import { applyTheme, desktop, savedTheme, THEME_GROUPS, type ThemeId } from "../theme.ts";

type DesktopStatus = Awaited<ReturnType<DesktopBridge["status"]>>;
// The value the server saved, or null when it was rejected (the row shows why): it never fails.
type Commit = (v: SettingValue) => Effect.Effect<SettingValue | null>;
interface FieldProps {
  def: SettingDef;
  value: SettingValue;
  commit: Commit;
  clear: () => void;
  id: string;
  invalid: boolean;
}

// A refetch updates the draft only while you aren't editing it, and a rejected draft stays for you to fix.
function useDraft({ def, value, commit, clear, id, invalid }: FieldProps) {
  const shown = draftOf(value);
  const [draft, setDraft] = useState(shown);
  const typed = useRef(false);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current && !typed.current) setDraft(shown);
  }, [shown]);

  function save(text: string) {
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
    void runUi(
      commit(v).pipe(
        Effect.tap((saved) =>
          Effect.sync(() => {
            if (saved === null || focused.current) return;
            typed.current = false;
            setDraft(draftOf(saved));
          }),
        ),
      ),
    );
  }

  return {
    draft,
    submit: (text: string) => {
      typed.current = true;
      setDraft(text);
      save(text);
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
        save(draft);
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
  const unit = p.def.unit && `${p.id}-unit`;
  return (
    <>
      <input
        className="input num"
        type="number"
        min={p.def.min}
        max={p.def.max}
        step={1}
        {...d.bind}
        aria-describedby={cls(unit, d.bind["aria-describedby"])}
      />
      {unit && (
        <span className="s-unit" id={unit}>
          {p.def.unit}
        </span>
      )}
    </>
  );
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

  function flip(v: boolean) {
    setOn(v);
    void runUi(
      commit(v).pipe(
        Effect.tap((saved) =>
          Effect.sync(() => {
            if (saved === null) setOn(!v);
          }),
        ),
      ),
    );
  }

  return (
    <input
      id={id}
      className="switch"
      type="checkbox"
      // oxlint-disable-next-line jsx-a11y/role-has-required-aria-props -- a checkbox input's state is its native checked; ARIA in HTML forbids aria-checked here
      role="switch"
      checked={on}
      aria-describedby={`${id}-msg`}
      onChange={(e) => {
        flip(e.target.checked);
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

  function pick(v: string) {
    const was = picked;
    setPicked(v);
    void runUi(
      commit(v).pipe(
        Effect.tap((saved) =>
          Effect.sync(() => {
            if (saved === null) setPicked(was);
          }),
        ),
      ),
    );
  }

  return (
    <select
      id={id}
      className="input choice"
      value={picked}
      aria-invalid={invalid}
      aria-describedby={`${id}-msg`}
      onChange={(e) => {
        pick(e.target.value);
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

function Row({
  def,
  view,
  onView,
  extra,
  hidden,
}: {
  def: SettingDef;
  view: SettingsView;
  onView: (v: SettingsView) => void;
  extra?: ReactNode;
  hidden?: boolean;
}) {
  const [status, setStatus] = useState<"saved" | { error: string } | null>(null);
  const [epoch, setEpoch] = useState(0); // remounts the control after a reset so it drops a rejected draft
  const timer = useRef(0);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );

  // The settings as saved, or null when it wasn't (the row says why): it never fails.
  function put(patch: { set?: Record<string, SettingValue>; reset?: string[] }): Effect.Effect<SettingsView | null> {
    return Effect.suspend(() => {
      clearTimeout(timer.current);
      return api.saveSettings(patch).pipe(
        Effect.match({
          onSuccess: (r) => {
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
          },
          onFailure: (e) => {
            setStatus({ error: e.message });
            return null;
          },
        }),
      );
    });
  }

  function resetToDefault() {
    void runUi(
      put({ reset: [def.key] }).pipe(
        Effect.tap((saved) =>
          Effect.sync(() => {
            if (saved) setEpoch((n) => n + 1);
          }),
        ),
      ),
    );
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
      commit={(v) => put({ set: { [def.key]: v } }).pipe(Effect.map((saved) => saved?.values[def.key] ?? null))}
    />
  );
  const reset = status === null && view.overridden.includes(def.key) && (
    <button
      type="button"
      className="link-btn"
      title={`Default: ${draftOf(def.default) || "(empty)"}`}
      onClick={() => {
        resetToDefault();
      }}
    >
      Reset to default
    </button>
  );
  // Free text (a prompt, a path) takes the row's width under its label; a value with a set shape stays beside it.
  const wide = def.type === "text" || (def.type === "string" && !def.pattern);

  return (
    <div id={`row-${def.key}`} className={cls("setting", `st-${def.type}`, wide && "wide")} hidden={hidden}>
      <div className="s-label-col">
        <label className="s-label" htmlFor={id}>
          {def.label}
        </label>
        {def.help && <p className="s-help">{def.help}</p>}
        {!wide && extra}
      </div>
      <div className="s-control">
        {control}
        {wide && extra}
        <div className="s-msg">
          <span id={`${id}-msg`} aria-live="polite">
            {status === "saved" && <span className="t-good">Saved</span>}
            {typeof status === "object" && status !== null && <span className="t-bad">Not saved: {status.error}</span>}
          </span>
          {reset}
        </div>
      </div>
    </div>
  );
}

function PausedLine({ p, now }: { p: SettingsView["paused"]["ai"]; now: number }) {
  if (!p) return null;
  const left = Math.max(1, Math.round((Date.parse(p.until) - now) / 60_000));
  return (
    <p className="s-live">
      <b>AI reviews are paused:</b> {withCode(p.why.replace(/\.?$/, "."))} Next try in {left}m.
    </p>
  );
}

function HotkeyStatus({ s }: { s: DesktopStatus["hotkey"] }) {
  if (!s.accelerator) return <p className="s-live quiet">Off</p>;
  if (s.ok)
    return (
      <p className="s-live">
        <span className="t-good">Active:</span> {s.accelerator} shows or hides the window from any app.
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
    const stop = new AbortController();
    // Not answering: what's shown stays, and the next refresh asks again.
    if (active) void runUi(api.agents().pipe(Effect.map(setStatus), Effect.ignore), { signal: stop.signal });
    return () => {
      stop.abort();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- loads only triggers a re-read
  }, [active, loads]);

  function connect() {
    setBusy(true);
    setError(null);
    void runUi(
      api.connectAgent().pipe(
        Effect.catch((e) =>
          Effect.sync(() => {
            setError(e.message);
          }).pipe(Effect.andThen(api.agents().pipe(Effect.orElseSucceed(() => status)))),
        ),
        Effect.map(setStatus),
        Effect.ensuring(
          Effect.sync(() => {
            setBusy(false);
          }),
        ),
      ),
    );
  }

  if (!status) return null;
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
            connect();
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
            Spaces decide which searches run for which orgs. Change them in <a href="#/settings/rules">Searches and rules</a>.
          </p>
        </div>
      )}
    </div>
  );
}

// This device's first row, not from the schema: the theme is this device's, so it's kept here, not on the desk.
function ThemeRow() {
  const [theme, setTheme] = useState<ThemeId>(savedTheme);
  return (
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
          <option value="system">System</option>
          {THEME_GROUPS.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.themes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
    </div>
  );
}

// What a part's lookups get: the page's state, and a setting's row by its key.
interface PartProps {
  active: boolean;
  loads: number;
  now: number;
  flash: (text: string, error?: boolean) => void;
  row: (key: string) => ReactNode;
}

// Rows a part's sheet starts with, before its settings', by the part's id: a plugin's part adds one entry.
const LEAD: Record<string, (p: PartProps) => ReactNode> = {
  app: () => <ThemeRow />,
};

// Rows after a setting's own, by its key: your policy and its hourly cap under the switch that sorts by it.
const AFTER: Record<string, (p: PartProps) => ReactNode> = {
  "policy.judge": (p) => (
    <>
      <div className="setting wide s-block" id="s-policy">
        <div className="s-label-col">
          <h3 className="s-label">Your policy</h3>
          <p className="s-help">How you want Claude to sort your desk, in your words. An agent can change it when you ask.</p>
        </div>
        <Policy active={p.active} refresh={p.loads} now={p.now} flash={p.flash} />
      </div>
      {p.row("policy.max_per_hour")}
    </>
  ),
};

// Settings an AFTER entry draws, not their part's run of rows.
const ELSEWHERE = new Set(["policy.max_per_hour"]);

// A part's folded settings: tuning and prompts, one click away, in the same sheet.
function MoreToggle({ title, open, controls, onToggle }: { title: string; open: boolean; controls: string; onToggle: () => void }) {
  return (
    <div className="s-more">
      <button type="button" className="link-btn" aria-expanded={open} aria-controls={controls} onClick={onToggle}>
        More {title} settings
        <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4.5 6.5 8 10l3.5-3.5" />
        </svg>
      </button>
    </div>
  );
}

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
  const [more, setMore] = useState<Record<string, boolean>>({});

  // The desktop app re-registers the hotkey when settings.json changes; give it a moment before asking.
  useEffect(() => {
    const stop = new AbortController();
    const t =
      desktop && view
        ? setTimeout(() => {
            void runUi(
              Effect.tryPromise({ try: () => desktop?.status() ?? Promise.resolve(null), catch: (e) => e }).pipe(
                Effect.map(setLive),
                Effect.ignore, // the app not answering: the hotkey's line stays as it was
              ),
              { signal: stop.signal },
            );
          }, 300)
        : undefined;
    return () => {
      clearTimeout(t);
      stop.abort();
    };
  }, [view]);

  // One page of parts; a link to a part, or to Rules or your policy (#/settings/rules), scrolls to it.
  const ready = view !== null;
  useEffect(() => {
    if (!active || !ready) return;
    if (section === "github") window.scrollTo({ top: 0 });
    else document.querySelector(`#s-${section}`)?.scrollIntoView({ block: "start" });
  }, [active, section, ready]);

  const row = (d: SettingDef | undefined, folded = false) =>
    view &&
    d && (
      <Row
        key={d.key}
        def={d}
        view={view}
        onView={onView}
        hidden={folded}
        extra={
          d.key === "app.source"
            ? live && <SourceLine s={live.source ?? null} />
            : d.type === "hotkey" && live && <HotkeyStatus s={live.hotkey} />
        }
      />
    );
  const p: PartProps = { active, loads, now, flash, row: (key) => row(view?.defs.find((d) => d.key === key)) };

  return (
    <div className="settings" hidden={!active}>
      {!view && (
        <section className="s-part s-skel" aria-busy="true" aria-label="Loading">
          <h2 className="group-head">
            <span className="sk" />
          </h2>
          <div className="lines s-sheet">
            {[0, 1, 2].map((i) => (
              <div key={i} className="setting" aria-hidden="true">
                <SkLines count={2} />
              </div>
            ))}
          </div>
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
            {view.errors.map((e) => {
              const d = view.defs.find((x) => x.key === e.path);
              return (
                <span key={e.path} className="s-file-err">
                  {d ? (
                    <>
                      {d.label} (<code>{e.path}</code>):
                    </>
                  ) : (
                    <code>{e.path}</code>
                  )}{" "}
                  {e.message}
                </span>
              );
            })}
          </span>
        </div>
      )}
      {view?.sections.map((x) => {
        const defs = view.defs.filter((d) => d.section === x.id && !ELSEWHERE.has(d.key));
        const folded = defs.filter((d) => d.more);
        // A problem in settings.json on a folded setting opens its part's More, so you see the row it's about.
        const open = more[x.id] ?? folded.some((d) => view.errors.some((e) => e.path === d.key));
        const lead = LEAD[x.id];
        return (
          <section key={x.id} id={`s-${x.id}`} className="s-part" aria-labelledby={`s-${x.id}-title`}>
            <h2 id={`s-${x.id}-title`} className="group-head">
              {x.title}
            </h2>
            {x.id === "github" && <GitHubStatusView gh={view.github} now={now} />}
            {x.id === "agent" && (
              <>
                <AgentLink active={active} loads={loads} />
                {/* A pause after failures in a row (an expired login) is the agent's, said once here rather than on every PR. */}
                <PausedLine p={view.paused.ai} now={now} />
              </>
            )}
            {x.id === "automations" && <Automations active={active} refresh={loads} now={now} flash={flash} />}
            {(lead !== undefined || defs.length > 0) && (
              <div className="lines s-sheet">
                {lead?.(p)}
                {defs
                  .filter((d) => !d.more)
                  .map((d) => (
                    <Fragment key={d.key}>
                      {row(d)}
                      {AFTER[d.key]?.(p)}
                    </Fragment>
                  ))}
                {folded.length > 0 && (
                  <MoreToggle
                    title={x.title}
                    open={open}
                    controls={folded.map((d) => `row-${d.key}`).join(" ")}
                    onToggle={() => {
                      setMore({ ...more, [x.id]: !open });
                    }}
                  />
                )}
                {folded.map((d) => row(d, !open))}
              </div>
            )}
            {/* Rules stays mounted with the page, so an unsaved draft survives a trip to the Inbox. */}
            {x.id === "github" && (
              <section id="s-rules" className="s-rules" aria-labelledby="s-rules-title">
                <h3 id="s-rules-title" className="s-block-head">
                  Searches and rules
                </h3>
                <p className="s-help">Which GitHub searches feed your desk, and where each item starts before Claude sorts it.</p>
                <Rules active={active} refresh={loads} flash={flash} onSaved={onRulesSaved} onDirty={onRulesDirty} />
              </section>
            )}
          </section>
        );
      })}
    </div>
  );
}
