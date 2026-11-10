// Rendered from the schema in GET /api/settings: a new entry in SETTINGS (src/settings.ts) needs no change here.
import { Effect } from "effect";
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type {
  AgentStatus,
  DesktopBridge,
  GitHubStatus,
  JudgeStatus,
  PolicyDoc,
  RemoteView,
  SettingDef,
  SettingsView,
  SettingType,
  SettingValue,
} from "../../../src/types.ts";
import { api, runUi } from "../api.ts";
import { ago, aiName, cls, githubTip, MAC, orgsLine } from "../format.ts";
import { AutomationRows, AutomationView, NewAutomation, useAutomations } from "./Automations.tsx";
import { Policy } from "./Policy.tsx";
import { Rules } from "./Rules.tsx";
import { withCode } from "./Review.tsx";
import { SkLines } from "./Skeleton.tsx";
import { SourceLine } from "./Source.tsx";
import {
  acceleratorOf,
  authProblem,
  automationOf,
  DISABLED,
  draftOf,
  hotkeyHelp,
  macKeys,
  judgeStatusText,
  onePause,
  quietTimes,
  routeHash,
  SETTINGS_VIEWS,
  settingsBack,
  settingsTab,
  SHOWN,
  valueOf,
} from "../view.ts";
import { applyTheme, desktop, omarchyName, omarchyTheme, onOmarchy, savedTheme, THEME_GROUPS, type ThemeId } from "../theme.ts";

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
  disabled: boolean;
}

// A refetch updates the draft only while you aren't editing it, and a rejected draft stays for you to fix.
function useDraft({ def, value, commit, clear, id, invalid, disabled }: FieldProps) {
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
    runUi(
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
      disabled,
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
  return <input className="input" type="text" placeholder={emptyLabel(p)} autoCapitalize="off" autoCorrect="off" {...d.bind} />;
}

// A secret never comes back from the desk: once set, its field holds the dots that stand in for it, selected when you
// come to it so what you paste takes their place.
function SecretField(p: FieldProps) {
  const d = useDraft(p);
  return (
    <input
      className="input"
      type="password"
      placeholder={p.def.placeholder}
      autoComplete="off"
      {...d.bind}
      onFocus={(e) => {
        d.bind.onFocus();
        e.currentTarget.select();
      }}
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

function BooleanField({ value, commit, id, disabled }: FieldProps) {
  const [on, setOn] = useState(value === true);
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    setSynced(value);
    setOn(value === true);
  }

  function flip(v: boolean) {
    setOn(v);
    runUi(
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
      disabled={disabled}
      aria-describedby={`${id}-msg`}
      onChange={(e) => {
        flip(e.target.checked);
      }}
    />
  );
}

function SelectField({ def, value, commit, id, invalid, disabled }: FieldProps) {
  const [picked, setPicked] = useState(String(value));
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    setSynced(value);
    setPicked(String(value));
  }

  function pick(v: string) {
    const was = picked;
    setPicked(v);
    runUi(
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
      disabled={disabled}
      aria-invalid={invalid}
      aria-describedby={`${id}-msg`}
      onChange={(e) => {
        pick(e.target.value);
      }}
    >
      {def.options?.map((o) => (
        <option key={o.value} value={o.value} disabled={!!o.off}>
          {o.off ? `${o.label} (${o.off})` : o.label}
        </option>
      ))}
    </select>
  );
}

function HotkeyField(p: FieldProps) {
  const d = useDraft(MAC ? { ...p, value: macKeys(String(p.value)) } : p); // the field in the Mac's words there
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

  // mousedown would blur the input and end the recording before the click lands
  const keep = (e: { preventDefault: () => void }) => {
    e.preventDefault();
  };
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
      <button
        type="button"
        className="btn"
        disabled={p.disabled}
        title={MAC ? "Press ⌃, ⌥ or ⌘ with a key; Esc cancels" : "Press Ctrl or Alt with a key; Esc cancels"}
        aria-pressed={recording}
        aria-label={recording ? "Cancel recording" : "Record a shortcut"}
        onMouseDown={keep}
        onClick={() => {
          setRecording(!recording);
          input.current?.focus();
        }}
      >
        {recording ? "Cancel" : "Record"}
      </button>
      {p.value !== "" && (
        <button
          type="button"
          className="btn"
          disabled={p.disabled}
          onMouseDown={keep}
          onClick={() => {
            setRecording(false);
            d.submit("");
          }}
        >
          Turn off
        </button>
      )}
    </div>
  );
}

// Quiet hours: two times, then a switch on the row's right edge like every other; off saves "", on the times as the
// "19:00-09:00" checkSetting has always taken.
function QuietHours({ value, commit, clear, id, invalid, disabled }: FieldProps) {
  const saved = String(value);
  const [on, setOn] = useState(saved !== "");
  const [times, setTimes] = useState<[string, string]>(quietTimes(saved) ?? ["19:00", "09:00"]); // off: the last times you had
  const editing = useRef(false);
  const escaped = useRef(false); // Esc blurs the field with the times it just put back not drawn yet
  useEffect(() => {
    setOn(saved !== "");
    const t = quietTimes(saved);
    if (t && !editing.current) setTimes(t);
  }, [saved]);

  function put(v: string, refused: () => void) {
    runUi(
      commit(v).pipe(
        Effect.tap((s) =>
          Effect.sync(() => {
            if (s === null) refused();
          }),
        ),
      ),
    );
  }
  function flip(v: boolean) {
    setOn(v);
    put(v ? times.join("-") : "", () => {
      setOn(!v);
    });
  }
  // On leaving a field, as every other field here saves: a time typed digit by digit isn't saved halfway, and one you didn't
  // change isn't saved at all (a stored "9:30-17:05" reads as 09:30 and 17:05).
  function leave() {
    editing.current = false;
    const had = quietTimes(saved)?.join("-") ?? saved;
    if (escaped.current) escaped.current = false;
    else if (on && times[0] && times[1] && times.join("-") !== had) put(times.join("-"), () => {}); // refused: kept as typed, the row says why
  }

  const time = (i: 0 | 1) => (
    <input
      id={`${id}-${i ? "to" : "from"}`}
      className="input time"
      type="time"
      value={times[i]}
      disabled={disabled || !on}
      aria-label={i ? "Quiet hours end" : "Quiet hours start"}
      aria-invalid={invalid}
      aria-describedby={`${id}-msg`}
      onFocus={() => {
        editing.current = true;
      }}
      onChange={(e) => {
        const next: [string, string] = [...times];
        next[i] = e.target.value;
        setTimes(next);
      }}
      onBlur={leave}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          escaped.current = true;
          clear();
          setTimes(quietTimes(saved) ?? times);
        }
        if (e.key === "Escape" || e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
  return (
    <div className="quiet-hours">
      {time(0)}
      <span className="s-unit">to</span>
      {time(1)}
      <input
        id={id}
        className="switch"
        type="checkbox"
        // oxlint-disable-next-line jsx-a11y/role-has-required-aria-props -- a checkbox input's state is its native checked; ARIA in HTML forbids aria-checked here
        role="switch"
        checked={on}
        disabled={disabled}
        aria-describedby={`${id}-msg`}
        onChange={(e) => {
          flip(e.target.checked);
        }}
      />
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
  secret: SecretField,
};
// A setting whose control isn't its type's, by key, looked up first.
const BY_KEY: Record<string, ComponentType<FieldProps> | undefined> = { "notify.quiet": QuietHours };

function Row({
  def,
  view,
  loads,
  onView,
  extra,
  help,
  hidden,
  disabled = false,
}: {
  def: SettingDef;
  view: SettingsView;
  loads: number; // bumped on every refresh: the desk answering again
  onView: (v: SettingsView) => void;
  extra?: ReactNode;
  help?: { text: string; bad: boolean } | null; // a live line in place of the def's help: null keeps the def's
  hidden?: boolean;
  disabled?: boolean;
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
  // Not saved because the desk was down: once it answers again, the row shows what it has, not that old refusal.
  const away = useRef(false);
  useEffect(() => {
    if (!away.current) return;
    away.current = false;
    setStatus(null);
    setEpoch((n) => n + 1);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a refresh is what says the desk is back
  }, [loads]);

  // The settings as saved, or null when it wasn't (the row says why): it never fails.
  function put(patch: { set?: Record<string, SettingValue>; reset?: string[] }): Effect.Effect<SettingsView | null> {
    return Effect.suspend(() => {
      clearTimeout(timer.current);
      return api.saveSettings(patch).pipe(
        Effect.match({
          onSuccess: (r) => {
            away.current = false;
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
            away.current = e._tag === "DeskUnreachable";
            setStatus({ error: e.message });
            return null;
          },
        }),
      );
    });
  }

  function resetToDefault() {
    runUi(
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
  const Control = BY_KEY[def.key] ?? CONTROLS[def.type] ?? StringField;
  const control = (
    <Control
      key={epoch}
      id={id}
      def={def}
      value={view.values[def.key] ?? (def.default as SettingValue)}
      invalid={typeof status === "object" && status !== null}
      disabled={disabled}
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
  const said = help ?? (def.help ? { text: def.help, bad: false } : null);

  return (
    <div id={`row-${def.key}`} className={cls("setting", `st-${def.type}`, wide && "wide", disabled && "s-off")} hidden={hidden}>
      <div className="s-label-col">
        <label className="s-label" htmlFor={id}>
          {def.label}
        </label>
        {said && (
          <p className={cls("s-help", said.bad && "t-bad")} aria-live={help === undefined ? undefined : "polite"}>
            {said.text}
          </p>
        )}
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

// Who the desk reads GitHub as, or its last sync's error and the fix; the teams and the rate limit are in the tooltip. A
// login GitHub just refused isn't a sign-in: the row says so, and who it was is in the tooltip.
function GitHubStatusRow({ gh }: { gh: GitHubStatus }) {
  const refused = !!gh.error && authProblem(gh.error);
  const tip = [refused && gh.login && `Last signed in as @${gh.login}.`, githubTip(gh)].filter(Boolean).join(" ");
  return (
    <div className="setting s-status" title={tip || undefined}>
      <div className="s-label-col">
        <p className="s-label">{refused ? "GitHub doesn't accept your login" : gh.login ? `Signed in as @${gh.login}` : "Not signed in"}</p>
        {gh.error ? (
          <p className="s-help t-bad">
            {withCode(gh.error.replace(/\.?$/, "."))}
            {authProblem(gh.error) && (
              <>
                {" "}
                Run <code>gh auth login</code> in a terminal, then sync.
              </>
            )}
          </p>
        ) : (
          <p className="s-help">
            {gh.login
              ? `Through ${gh.auth === "gh CLI" ? "gh" : gh.auth}. The desk writes to GitHub only when you click a button that says so.`
              : "Not synced yet."}
          </p>
        )}
      </div>
    </div>
  );
}

// In the words of the agent you chose: its tools and skill are what Connect sets up.
const needs = (agent: string) => ({
  connect: {
    label: `${agent} isn't connected to the desk`,
    help: "Your agent and agents' questions need the desk's tools and skill.",
    press: `Connect ${agent}`,
    busy: "Connecting…",
    failed: "Couldn't connect",
    done: `Connected ${agent} to the desk.`,
  },
  update: {
    label: "The desk's skill is out of date",
    help: `${agent} has an older copy than this desk.`,
    press: "Update the skill",
    busy: "Updating…",
    failed: "Couldn't update it",
    done: `Updated ${agent}'s copy of the desk's skill.`,
  },
  // Its help is the status's own words: what holds the name, and where it points.
  taken: {
    label: `${agent} has another skill or server named inbox`,
    help: "",
    press: `Connect ${agent}`,
    busy: "Connecting…",
    failed: "Couldn't connect",
    done: `Connected ${agent} to the desk.`,
  },
});

// Under the agent's name, what needs you, and only then: the agent missing the desk's tools or skill, AI reviews paused.
function ClaudeStatus({
  active,
  loads,
  paused,
  judge,
  now,
  flash,
}: {
  active: boolean;
  loads: number;
  paused: SettingsView["paused"]["ai"];
  judge: JudgeStatus | undefined;
  now: number;
  flash: (text: string) => void;
}) {
  const both = onePause(paused, judge);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Re-read on every app refresh: the agent's own config can change outside the desk.
  useEffect(() => {
    const stop = new AbortController();
    // Not answering: what's shown stays, and the next refresh asks again.
    if (active) runUi(api.agents().pipe(Effect.map(setStatus), Effect.ignore), { signal: stop.signal });
    return () => {
      stop.abort();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- loads only triggers a re-read
  }, [active, loads]);

  const need = status?.needs;
  const say = need && needs(status.driver === "codex" ? "Codex" : "Claude Code")[need];

  function connect() {
    setBusy(true);
    setError(null);
    runUi(
      api.connectAgent().pipe(
        Effect.tap((s) =>
          Effect.sync(() => {
            if (say && !s.needs) flash(say.done);
          }),
        ),
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

  return (
    <>
      {status && say && (
        <div className="setting s-status">
          <div className="s-label-col">
            <p className="s-label">{say.label}</p>
            <p className={cls("s-help", error && "t-bad")}>
              {error ? `${say.failed}: ${error}` : status.taken ? `${status.taken}.` : say.help}
            </p>
          </div>
          <div className="s-control">
            <button
              type="button"
              className="act primary"
              disabled={busy}
              title={status.connect.join("\n")}
              onClick={() => {
                connect();
              }}
            >
              {busy ? say.busy : say.press}
            </button>
          </div>
        </div>
      )}
      {/* A pause after failures in a row (an expired login) is the agent's, said once here rather than on every PR; when
          the sorting fails for the same reason, this says it for both, and Your policy doesn't again. */}
      {paused && (
        <div className="setting s-status">
          <div className="s-label-col">
            <p className="s-label">{both ? `${aiName()} is paused` : "AI reviews are paused"}</p>
            <p className="s-help s-ink">
              {withCode(paused.why.replace(/\.?$/, "."))}
              {both && " Nothing is sorted or reviewed until then."} Next try in{" "}
              {Math.max(1, Math.round((Date.parse(both?.next ?? paused.until) - now) / 60_000))}m.
            </p>
          </div>
        </div>
      )}
    </>
  );
}

// This device's first row, not from the schema: the theme is this device's, so it's kept here, not on the desk. Omarchy
// is offered where the desk reads an Omarchy theme, or once picked.
function ThemeRow() {
  const [theme, setTheme] = useState<ThemeId>(savedTheme);
  const omarchy = useSyncExternalStore(onOmarchy, omarchyTheme);
  const offer = omarchy !== null || theme === "omarchy";
  return (
    <div className="setting st-select">
      <div className="s-label-col">
        <label className="s-label" htmlFor="s-theme">
          Theme
        </label>
        <p className="s-help">
          Only this device. System follows your computer's light or dark
          {offer && `; Omarchy, the theme Omarchy has on${omarchy ? ` (now ${omarchyName(omarchy.name)})` : ""}`}.
        </p>
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
          {offer && <option value="omarchy">Omarchy</option>}
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

// A row that opens one of Settings' views: its name and its Edit both go there.
function ViewRow({ id, help, tone }: { id: string; help: ReactNode; tone?: "bad" | "ink" }) {
  const href = routeHash({ name: "settings", section: id });
  const name = SETTINGS_VIEWS[id]?.name ?? id;
  return (
    <div className="setting s-view-row">
      <div className="s-label-col">
        {/* Edit is the one stop for Tab; the name is there for the mouse. */}
        <a className="s-label s-name" href={href} tabIndex={-1}>
          {name}
        </a>
        <p className={cls("s-help", tone === "bad" && "t-bad", tone === "ink" && "s-ink")}>{help}</p>
      </div>
      <div className="s-control">
        <a className="s-edit" href={href} aria-label={`Edit ${name.toLowerCase()}`}>
          Edit
        </a>
      </div>
    </div>
  );
}

// Under Use it from your other devices: where the desk serves and for whom, or why it can't, then each paired device with
// Revoke. Turning on takes Tailscale a moment, so a row still on its way is read again.
function RemoteRows({
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
  useEffect(() => {
    const stop = new AbortController();
    if (active) runUi(api.remote().pipe(Effect.map(setView), Effect.ignore), { signal: stop.signal });
    return () => {
      stop.abort();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- loads, on and tick only trigger a re-read
  }, [active, loads, on, tick]);
  const turning = !!view && (view.on !== on || (on && !view.url && view.text === "Off.") || (!on && !!view.url));
  // Each answer still on its way sets a new view, which sets the next try.
  useEffect(() => {
    const t = turning
      ? setTimeout(() => {
          setTick((n) => n + 1);
        }, 1000)
      : undefined;
    return () => {
      clearTimeout(t);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- view only times the next read
  }, [turning, view]);

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
              {view.url ? (
                <>
                  For {view.login}'s devices. To pair one, run <code>desk pair</code> on this computer.
                </>
              ) : failed ? (
                withCode(view.text)
              ) : (
                "Asking Tailscale."
              )}
            </p>
          </div>
        </div>
      )}
      {view.devices.map((d) => (
        <div key={d.id} className="setting s-status">
          <div className="s-label-col">
            <p className="s-label">{d.name}</p>
            <p className="s-help">
              {d.kind === "browser" ? "A browser" : "A machine's agents"}, paired {ago(d.created_at, now)}
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

// What a part's lookups get: the page's state.
interface PartProps {
  view: SettingsView;
  active: boolean;
  now: number;
  loads: number;
  configErrors: number;
  policy: PolicyDoc | null;
  flash: (text: string) => void;
}

// Rows a part's sheet starts with, before its settings', by the part's id: a plugin's part adds one entry.
const LEAD: Record<string, (p: PartProps) => ReactNode> = {
  github: (p) => (
    <>
      <GitHubStatusRow gh={p.view.github} />
      <ViewRow
        id="rules"
        tone={p.configErrors > 0 ? "bad" : undefined}
        help={
          p.configErrors > 0
            ? `${p.configErrors} ${p.configErrors === 1 ? "error" : "errors"} in your rules`
            : (orgsLine(p.view.github.orgs, p.view.github.catch_all) ?? "Which GitHub searches feed your desk, and where each item starts.")
        }
      />
    </>
  ),
  app: () => <ThemeRow />,
};

// Rows after a setting's own, by its key: your policy under the switch that sorts by it.
const AFTER: Record<string, (p: PartProps) => ReactNode> = {
  "app.tailscale": (p) => (
    <RemoteRows active={p.active} loads={p.loads} on={p.view.values["app.tailscale"] === true} now={p.now} flash={p.flash} />
  ),
  // The agent's own status under its name, and only while something needs you.
  "agent.harness": (p) => (
    <ClaudeStatus active={p.active} loads={p.loads} paused={p.view.paused.ai} judge={p.policy?.judge} now={p.now} flash={p.flash} />
  ),
  "policy.judge": ({ policy, view, now }) => {
    // Its failure, unless it's the one the agent's status already says for the AI reviews too.
    const failed = policy?.judge.state === "error" && !onePause(view.paused.ai, policy.judge);
    return (
      <ViewRow
        id="policy"
        tone={failed ? "ink" : undefined}
        help={
          failed
            ? withCode(judgeStatusText(policy.judge, now)) // an agent's failure, in ink: it's about Claude, not your work
            : policy && !policy.text.trim()
              ? "The starter policy, until you change it."
              : `How ${aiName()} sorts, in your words.`
        }
      />
    );
  },
};

// Settings a view draws, not their part: the hourly cap sits in Your policy, next to how much of it this hour took.
const ELSEWHERE = new Set(["policy.max_per_hour"]);

// A view's own head under the page's: its name and one line.
function ViewHead({ id, line }: { id: string; line: string }) {
  return (
    <>
      <h1 id={`s-view-${id}`} className="s-view-name">
        {SETTINGS_VIEWS[id]?.name}
      </h1>
      <p className="s-view-line">{line}</p>
    </>
  );
}

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
  configErrors,
  onView,
  flash,
  onRulesSaved,
  onRulesDirty,
}: {
  active: boolean;
  section: string; // a part's id, automations (its tab), or a view's (rules, policy, automations/<id>)
  view: SettingsView | null;
  now: number;
  loads: number;
  configErrors: number; // the saved rules' errors, for Searches and rules' row
  onView: (v: SettingsView) => void;
  flash: (text: string, error?: boolean) => void;
  onRulesSaved: () => void;
  onRulesDirty: (dirty: boolean) => void;
}) {
  const [live, setLive] = useState<DesktopStatus | null>(null);
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [policy, setPolicy] = useState<PolicyDoc | null>(null);
  const inView = settingsBack(section) !== null;
  const tab = settingsTab(section);
  const au = useAutomations(active, loads, flash);
  // Who answers an automation's question: the decision model once its key is set, else Claude.
  const decisionModel = view?.values["agent.decision_key"] ? String(view.values["agent.decision_model"]) : null;
  // The automation last opened stays mounted, so an edit in its view survives a trip to its tab, or anywhere, and back.
  const automation = automationOf(section);
  const [lastAutomation, setLastAutomation] = useState(automation);
  if (automation !== null && automation !== lastAutomation) setLastAutomation(automation);

  // The desktop app re-registers the hotkey once it reads the new settings: ask after a moment, and again until it has.
  const hotkey = view?.values["app.hotkey"];
  useEffect(() => {
    const stop = new AbortController();
    let t: ReturnType<typeof setTimeout> | undefined;
    const ask = (tries: number) => {
      t = setTimeout(() => {
        runUi(
          Effect.tryPromise({ try: () => desktop?.status() ?? Promise.resolve(null), catch: (e) => e }).pipe(
            Effect.tap((s) =>
              Effect.sync(() => {
                setLive(s);
                if (s && s.hotkey.accelerator !== hotkey && tries > 1) ask(tries - 1);
              }),
            ),
            Effect.ignore, // the app not answering: the shortcut's and the checkout's lines stay as they were
          ),
          { signal: stop.signal },
        );
      }, 300);
    };
    if (desktop && view) ask(10);
    return () => {
      clearTimeout(t);
      stop.abort();
    };
  }, [view, hotkey]);

  // A tab of parts; a link to a part scrolls to it, each time you come to it, and a view or the Automations tab opens at its top.
  const ready = view !== null;
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const top = section === "github" || tab === "automations" || inView;
    // escaped: a mistyped #/settings/github/x mustn't throw
    const jump = () => {
      if (top) window.scrollTo({ top: 0 });
      else document.querySelector(`#${CSS.escape(`s-${section}`)}`)?.scrollIntoView({ block: "start" });
    };
    if (active && ready) jump();
    // The parts above load their own rows after the page (Claude's status): it jumps again as they grow, until you scroll or a
    // moment has passed.
    const ro = new ResizeObserver(jump);
    if (active && ready && !top && page.current) ro.observe(page.current);
    const stop = () => {
      ro.disconnect();
    };
    const t = setTimeout(stop, 2000);
    const input = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    for (const e of input) window.addEventListener(e, stop, { once: true, passive: true });
    return () => {
      stop();
      clearTimeout(t);
      for (const e of input) window.removeEventListener(e, stop);
    };
  }, [active, section, ready, inView, tab]);

  // Back from a view to its part, focus goes to what opened it (its row's Edit, an automation's name or Review), so Tab goes on
  // from there; after App's route change, which blurs whatever had it.
  const lastSection = useRef(section);
  useEffect(() => {
    const was = lastSection.current;
    lastSection.current = section;
    const back = active && was !== section && settingsBack(was) === section;
    const href = routeHash({ name: "settings", section: was });
    const frame = back
      ? requestAnimationFrame(() => {
          document
            .querySelector<HTMLElement>(`#${CSS.escape(`s-${section}`)} a[href="${CSS.escape(href)}"]:not([tabindex="-1"])`)
            ?.focus({ preventScroll: true });
        })
      : 0;
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [active, section]);

  const row = (d: SettingDef | undefined, folded = false) =>
    view &&
    d && (
      <Row
        key={d.key}
        def={d}
        view={view}
        loads={loads}
        onView={onView}
        hidden={folded}
        disabled={DISABLED[d.key]?.(view.values) ?? false}
        help={d.type === "hotkey" ? hotkeyHelp(String(view.values[d.key] ?? d.default), live?.hotkey ?? null, MAC) : undefined}
        extra={d.key === "app.source" && live && <SourceLine s={live.source ?? null} />}
      />
    );

  return (
    <div className="settings" hidden={!active}>
      <div ref={page} className="s-page" hidden={inView || tab !== "settings"}>
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
          const p: PartProps = { view, active, now, loads, configErrors, policy, flash };
          const defs = view.defs.filter(
            (d) => d.section === x.id && !ELSEWHERE.has(d.key) && (SHOWN[d.key]?.(view.values, desktop) ?? true),
          );
          const folded = defs.filter((d) => d.more);
          // A problem in settings.json on a folded setting opens its part's More, so you see the row it's about.
          const open = more[x.id] ?? folded.some((d) => view.errors.some((e) => e.path === d.key));
          const lead = LEAD[x.id];
          return (
            <section key={x.id} id={`s-${x.id}`} className="s-part" aria-labelledby={`s-${x.id}-title`}>
              <h2 id={`s-${x.id}-title`} className="group-head">
                {x.title}
              </h2>
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
            </section>
          );
        })}
      </div>
      {/* The tabs and the views stay mounted, so an unsaved draft in any survives leaving it and coming back. */}
      <div className="s-page" hidden={inView || tab !== "automations"}>
        <section id="s-automations" className="s-part" aria-label="Automations">
          <div className="lines s-sheet">
            <AutomationRows au={au} now={now} />
          </div>
          <NewAutomation au={au} model={decisionModel} />
        </section>
      </div>
      <section className="s-view" hidden={section !== "rules"} aria-labelledby="s-view-rules">
        <ViewHead id="rules" line={`Which GitHub searches feed your desk, and where each item starts before ${aiName()} sorts it.`} />
        <Rules
          active={active}
          shown={active && section === "rules"}
          refresh={loads}
          flash={flash}
          onSaved={onRulesSaved}
          onDirty={onRulesDirty}
        />
      </section>
      <section className="s-view" hidden={section !== "policy"} aria-labelledby="s-view-policy">
        <ViewHead id="policy" line={`How you want ${aiName()} to sort your desk, in your words. An agent can change it when you ask.`} />
        <Policy active={active} shown={active && section === "policy"} refresh={loads} now={now} flash={flash} onDoc={setPolicy}>
          {view && <div className="lines s-sheet">{row(view.defs.find((d) => d.key === "policy.max_per_hour"))}</div>}
        </Policy>
      </section>
      <section className="s-view" hidden={automation === null} aria-labelledby="s-view-automation">
        {lastAutomation !== null && (
          <AutomationView
            key={lastAutomation}
            au={au}
            id={lastAutomation}
            settingsPath={view?.path ?? null}
            model={decisionModel}
            flash={flash}
          />
        )}
      </section>
    </div>
  );
}
