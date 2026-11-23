// A setting's control, by its type (or its key): each saves as you change it and shows what the desk saved.
import { Effect } from "effect";
import { useEffect, useRef, useState, type ChangeEvent, type ComponentType, type KeyboardEvent } from "react";
import type { SettingDef, SettingType, SettingValue } from "../../../src/types.ts";
import { runUi } from "../api.ts";
import { cls, MAC } from "../format.ts";
import { acceleratorOf, draftOf, macKeys, quietTimes, valueOf } from "../settingValues.ts";

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

export function StringField(p: FieldProps) {
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

// What you picked shows until the save answers; by then `value` is what the desk saved (or kept, refused).
function BooleanField({ value, commit, id, disabled }: FieldProps) {
  const [mine, setMine] = useState<boolean | null>(null);
  const on = mine ?? value === true;

  function flip(v: boolean) {
    setMine(v);
    runUi(
      commit(v).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            setMine(null);
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
  const [mine, setMine] = useState<string | null>(null); // as BooleanField's
  const picked = mine ?? String(value);

  function pick(v: string) {
    setMine(v);
    runUi(
      commit(v).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            setMine(null);
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

// A string the desk offers choices for (your agent's models): a dropdown, its default first, and a value set before
// that isn't among them still shown, so it's kept until you pick another.
export function ChoiceField(p: FieldProps) {
  const now = String(p.value);
  const listed = p.def.choices ?? [];
  const options = [
    { value: "", label: p.def.placeholder ?? "Default" },
    ...(now && !listed.some((c) => c.value === now) ? [{ value: now, label: now }] : []),
    ...listed,
  ];
  return <SelectField {...p} def={{ ...p.def, options }} />;
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

export const CONTROLS: Record<SettingType, ComponentType<FieldProps>> = {
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
export const BY_KEY: Record<string, ComponentType<FieldProps> | undefined> = { "notify.quiet": QuietHours };
