import { Effect } from "effect";
import { useEffect, useMemo, useRef, useState } from "react";
import { blocks } from "../../../src/prose.ts";
import type { InboxSection, Note, NoteButton } from "../../../src/types.ts";
import { runUi } from "../api.ts";
import { age, cls, when } from "../format.ts";
import { useKeyedLayout } from "../keyed.ts";
import { remindTime, TIMES } from "../view.ts";
import { ChainButton, stepsOf, WaitingRows, type ChainCtx } from "./Chain.tsx";
import { ProseBlocks } from "./Prose.tsx";
import { ClockIcon, KindIcon, NoteGlyph, RowFacts } from "./RowIcons.tsx";

export const noteOf = (id: string) => `note:${id}`; // its row's id, as the right-click and the cursor read it

export interface NoteCtx {
  now: number;
  compact?: boolean;
  selected: string | null;
  open: (n: Note) => void; // into the note tray, to change it
  done: (n: Note) => void;
  press: (n: Note, button: number) => void; // an automation's Ask button
  chains?: ChainCtx; // a chain's head: its steps, open under it on this device
  me?: string; // your login, for a step of yours
}

// Where an Open button goes, said before you press it: the link is what a run read, so its host is the tell.
const hostOf = (url: string) => URL.parse(url)?.host ?? url;

// One of an automation's buttons: Open is a link out (the window opens it in your browser), Ask a press the desk handles.
function NoteAction({
  n,
  b,
  i,
  className,
  onPress,
}: {
  n: Note;
  b: NoteButton;
  i: number;
  className: string;
  onPress: (n: Note, i: number) => void;
}) {
  if (b.do === "open")
    return n.url ? (
      <a className={className} href={n.url} target="_blank" rel="noreferrer" data-tip={`Opens ${hostOf(n.url)}`}>
        {b.label}
      </a>
    ) : null;
  return (
    <button
      type="button"
      className={className}
      data-tip={`Asks your agent: ${b.prompt ?? ""}`}
      onClick={() => {
        onPress(n, i);
      }}
    >
      {b.label}
    </button>
  );
}

// A note to yourself as a row: Note, its words, Done; when it reminds (or reminded) you where a PR's author goes. One an
// automation raised says which, and its first button is the row's.
export function NoteRow({ n, ctx }: { n: Note; ctx: NoteCtx }) {
  const id = noteOf(n.id);
  const later = !!n.remind_at && Date.parse(n.remind_at) > ctx.now;
  const kindIcon = (
    <KindIcon
      kind="note"
      icon={n.icon}
      tip={n.from ? `From your automation ${n.from.name}: a click opens it` : "Note to yourself: a click changes it"}
    />
  );
  const title = <span className="line-title">{n.text}</span>;
  const by = (
    <span
      className="line-by"
      title={n.remind_at ? `${later ? "Reminds you" : "Reminded you"} ${new Date(n.remind_at).toLocaleString()}` : undefined}
    >
      {n.remind_at ? `at ${when(n.remind_at)}` : (n.from?.name ?? "by you")}
    </span>
  );
  const first = n.buttons?.[0];
  const cta = ctx.compact ? "c-cta" : "act line-cta line-reply";
  const remind = n.remind_at ? `${later ? "Reminds you" : "Reminded you"} ${new Date(n.remind_at).toLocaleString()}` : undefined;
  const face = (
    <span className="line-by line-face" data-tip={remind}>
      {n.remind_at && <ClockIcon />}
      <span className="sr">{n.remind_at ? `at ${when(n.remind_at)}` : (n.from?.name ?? "by you")}</span>
    </span>
  );
  const ageEl = (
    <span className="line-age" data-tip={`written ${new Date(n.at).toLocaleString()}`}>
      {age(n.remind_at && !later ? n.remind_at : n.at, ctx.now)}
    </span>
  );
  const steps = ctx.compact ? [] : stepsOf(n.waiting, ctx.chains);
  const chained = ctx.chains && steps.length > 0 ? ctx.chains : null;
  return (
    <>
      <div className={cls("line memo", ctx.compact && "c-line", ctx.selected === id && "sel")} data-id={id}>
        <div className={cls("line-main line-row", ctx.compact && "c-row", chained && "has-chain")}>
          <button
            type="button"
            className="row-main line-btn"
            onMouseDown={(e) => {
              e.preventDefault();
            }}
            onClick={() => {
              ctx.open(n);
            }}
          >
            {ctx.compact ? (
              <>
                <span className="c-top">
                  {kindIcon}
                  {title}
                </span>
                <span className="c-meta">
                  {by}
                  <span className="c-gap" />
                  {ageEl}
                </span>
              </>
            ) : (
              <>
                {kindIcon}
                {title}
              </>
            )}
          </button>
          {chained && <ChainButton head={id} steps={steps} ctx={chained} />}
          {first && (first.do === "ask" || n.url) ? (
            <NoteAction n={n} b={first} i={0} className={cta} onPress={ctx.press} />
          ) : (
            <button
              type="button"
              className={cta}
              onClick={() => {
                ctx.done(n);
              }}
            >
              Done
            </button>
          )}
          {!ctx.compact && (
            <>
              <RowFacts />
              {face}
              {ageEl}
            </>
          )}
        </div>
      </div>
      {chained?.open.has(id) && (
        <WaitingRows steps={steps} head={[]} ctx={chained} me={ctx.me ?? ""} now={ctx.now} selected={ctx.selected} />
      )}
    </>
  );
}

// Where the note goes on the Inbox, your call: a reminder that's due leads Urgent whatever you picked.
const SECTIONS: readonly { value: InboxSection; label: string }[] = [
  { value: "urgent", label: "Urgent" },
  { value: "standard", label: "Standard" },
  { value: "fyi", label: "FYI" },
];

// The reminder's choices: none, a time from now as a snooze reads it, or one you pick.
const WHEN = [
  { value: "", label: "No reminder" },
  { value: "1h", label: "In 1 hour" },
  { value: "3h", label: "In 3 hours" },
  { value: "tomorrow", label: "Tomorrow 9:00" },
  { value: "monday", label: "Monday 9:00" },
  { value: "pick", label: "Pick a time…" },
];

// Esc closes a list or the calendar open over the tray, before the window reads it as closing the tray: the window leaves
// Esc alone while a .more-pop is up, as it does for a review's More.
function useEscCloses(open: boolean, close: () => void) {
  const fn = useRef(close);
  fn.current = close;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!open || e.key !== "Escape" || e.isComposing) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      fn.current();
    };
    window.addEventListener("keydown", h, { capture: true });
    return () => {
      window.removeEventListener("keydown", h, { capture: true });
    };
  }, [open]);
}

const Chevron = () => (
  <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
    <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
  </svg>
);

// The tray's own list, in the desk's look: a small button saying what's picked, and its choices in a popover under it.
function Menu({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string; off?: boolean }[];
  onPick: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  useEscCloses(open, () => {
    setOpen(false);
  });
  return (
    <span className="nt-menu">
      <button
        type="button"
        className="nt-pick"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {options.find((o) => o.value === value)?.label ?? label}
        <Chevron />
      </button>
      {open && (
        <>
          <div
            className="scrim-clear"
            role="presentation"
            onClick={() => {
              setOpen(false);
            }}
          />
          <div className="popover more-pop nt-pop" role="menu" aria-label={label}>
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="menuitemradio"
                aria-checked={o.value === value}
                className={cls("pop-item", o.value === value && "on")}
                disabled={o.off}
                onClick={() => {
                  onPick(o.value);
                  setOpen(false);
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

const two = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

// A day and a time you pick, in the desk's look: a small button saying it, and under it a month to click a day in and a
// list of half hours. Nothing before `min` (now, when the tray opened) can be picked. Its value is a datetime-local's.
function TimePick({
  value,
  min,
  open,
  setOpen,
  onChange,
}: {
  value: string;
  min: string;
  open: boolean;
  setOpen: (o: boolean) => void;
  onChange: (v: string) => void;
}) {
  const [minDay = "", minTime = ""] = min.split("T");
  const [day = "", time = ""] = value.split("T");
  const [month, setMonth] = useState(() => (day || minDay).slice(0, 7)); // the month on show, "2026-11"
  useEscCloses(open, () => {
    setOpen(false);
  });
  const [y = 0, m = 1] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const lead = (first.getDay() + 6) % 7; // Monday leads the week
  const days = new Date(y, m, 0).getDate();
  const cells = [...Array.from({ length: lead }, () => 0), ...Array.from({ length: days }, (_, i) => i + 1)];
  const step = (by: number) => {
    const d = new Date(y, m - 1 + by, 1);
    setMonth(`${d.getFullYear()}-${two(d.getMonth() + 1)}`);
  };
  const said = value
    ? new Date(value).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "Pick a day";
  // A day picked first takes 9:00 or the first half hour still ahead of it; a time picked first takes today.
  const ahead = (d: string) => remindTime(d, minDay, minTime);
  // The half hours open on the one picked, else 9:00 or the next one ahead, never at midnight.
  const times = useRef<HTMLDivElement>(null);
  useKeyedLayout(open || null, () => {
    const at = time || ahead(day || minDay);
    const list = times.current;
    const row = list?.querySelector<HTMLElement>(`[data-time="${at}"]`);
    if (list && row) list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top;
  });
  return (
    <span className="nt-menu">
      <button
        type="button"
        className="nt-pick"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="The time to remind you at"
        onClick={() => {
          setOpen(!open);
        }}
      >
        {said}
        <Chevron />
      </button>
      {open && (
        <>
          <div
            className="scrim-clear"
            role="presentation"
            onClick={() => {
              setOpen(false);
            }}
          />
          <div className="popover more-pop nt-pop nt-cal">
            <div className="nt-cal-days">
              <div className="nt-cal-head">
                <button
                  type="button"
                  className="nt-cal-step"
                  aria-label="The month before"
                  disabled={month <= minDay.slice(0, 7)}
                  onClick={() => {
                    step(-1);
                  }}
                >
                  <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M10 3.5 5.5 8l4.5 4.5" />
                  </svg>
                </button>
                <span>{first.toLocaleString(undefined, { month: "long", year: "numeric" })}</span>
                <button
                  type="button"
                  className="nt-cal-step"
                  aria-label="The month after"
                  onClick={() => {
                    step(1);
                  }}
                >
                  <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="m6 3.5 4.5 4.5L6 12.5" />
                  </svg>
                </button>
              </div>
              <div className="nt-cal-grid">
                {DAYS.map((d) => (
                  <span key={d} className="nt-cal-dow">
                    {d}
                  </span>
                ))}
                {cells.map((n, i) => {
                  const d = `${month}-${two(n)}`;
                  return n ? (
                    <button
                      key={d}
                      type="button"
                      className={cls("nt-cal-day", d === day && "on", d === minDay && "today")}
                      disabled={d < minDay}
                      onClick={() => {
                        onChange(`${d}T${time && (d > minDay || time > minTime) ? time : ahead(d)}`);
                      }}
                    >
                      {n}
                    </button>
                  ) : (
                    // oxlint-disable-next-line react/no-array-index-key -- the blanks before the 1st never reorder
                    <span key={`b${i}`} />
                  );
                })}
              </div>
            </div>
            <div className="nt-cal-times" role="menu" aria-label="Time" ref={times}>
              {TIMES.map((t) => (
                <button
                  key={t}
                  type="button"
                  data-time={t}
                  role="menuitemradio"
                  aria-checked={t === time}
                  className={cls("pop-item", t === time && "on")}
                  disabled={(day || minDay) === minDay && t <= minTime}
                  onClick={() => {
                    onChange(`${day || minDay}T${t}`);
                    setOpen(false);
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </span>
  );
}

// A datetime-local input's value for an ISO time, in this computer's clock.
const local = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

// New note (⌘N), or one you opened: a tray that drops from the page's top over the blurred page and slides back up, your words and an optional
// reminder. ↵ saves (⇧↵ is a new line), Esc discards; a refusal keeps your words here.
export function NoteBar({
  note,
  onSave,
  onDone,
  onClose,
  closer,
}: {
  note: Note | null;
  onSave: (text: string, remind: string, section: InboxSection) => Effect.Effect<boolean>;
  onDone: (n: Note) => void;
  onClose: () => void; // once it has slid away
  closer: (leave: (() => void) | null) => void; // hands the window its way out, so Esc slides it away as its buttons do
}) {
  const [text, setText] = useState(note?.text ?? "");
  const [section, setSection] = useState<InboxSection>(note?.section ?? "standard");
  const [pick, setPick] = useState(note?.remind_at ? "pick" : "");
  const [at, setAt] = useState(note?.remind_at ? local(note.remind_at) : "");
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false); // the calendar, open: picking "Pick a time…" opens it
  const [opened] = useState(() => local(new Date().toISOString())); // the earliest time to pick
  const [leaving, setLeaving] = useState(false); // sliding back up; gone when that ends
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    box.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    closer(() => {
      setLeaving(true);
    });
    return () => {
      closer(null);
    };
  }, [closer]);
  const leave = () => {
    setLeaving(true);
  };

  const remind = pick === "pick" ? (at ? new Date(at).toISOString() : "") : pick;
  const ready = !!text.trim() && !(pick === "pick" && !at) && !busy;

  function save() {
    if (!ready) return;
    setBusy(true);
    runUi(
      onSave(text, remind, section).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            setBusy(false);
          }),
        ),
        Effect.tap((ok) =>
          Effect.sync(() => {
            if (ok) leave();
          }),
        ),
      ),
    );
  }

  const changed = text !== (note?.text ?? "") || section !== (note?.section ?? "standard");
  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- a click on the blurred page closes an untouched tray; Esc and Close are its keys and button
    <div
      className={cls("note-veil", leaving && "leaving")}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !changed) leave();
      }}
    >
      <div
        className={cls("note-tray", leaving && "leaving")}
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a native <dialog>'s backdrop covers the sidebar; this one covers only the page
        role="dialog"
        aria-modal="true"
        aria-label={note ? "Change your note" : "New note"}
        onAnimationEnd={(e) => {
          if (leaving && e.target === e.currentTarget) onClose();
        }}
      >
        {/* Its way out, at its top right: Esc does the same. */}
        <button
          type="button"
          className="note-x"
          title={note ? "Close without saving (Esc)" : "Discard this note (Esc)"}
          aria-label={note ? "Close without saving" : "Discard this note"}
          onClick={leave}
        >
          <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
            <path d="m4.5 4.5 7 7m0-7-7 7" />
          </svg>
        </button>
        <textarea
          ref={box}
          className="note-text"
          aria-label="Your note"
          placeholder="Type a note to yourself here (e.g. Remind me to…)"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !e.repeat) {
              e.preventDefault();
              save();
            }
          }}
        />
        <div className="note-when">
          <span className="note-remind">
            <span>In</span>
            <Menu
              label="Where it goes on your Inbox"
              value={section}
              options={SECTIONS}
              onPick={(v) => {
                const s = SECTIONS.find((x) => x.value === v);
                if (s) setSection(s.value);
              }}
            />
          </span>
          <span className="note-remind">
            <span>Remind me</span>
            <Menu
              label="When to remind you"
              value={pick}
              options={WHEN}
              onPick={(v) => {
                setPick(v);
                if (v === "pick") setPicking(true);
              }}
            />
            {pick === "pick" && <TimePick value={at} min={opened} open={picking} setOpen={setPicking} onChange={setAt} />}
          </span>
          <span className="note-acts">
            {note && (
              <button
                type="button"
                className="act note-done"
                title="Mark this note as done: it leaves your Inbox"
                onClick={() => {
                  onDone(note);
                  leave();
                }}
              >
                <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="m3.5 8.5 3 3 6-7" />
                </svg>
                Mark as done
              </button>
            )}
            <button type="button" className="act primary" title="Save (↵)" disabled={!ready} onClick={save}>
              {busy ? "Saving…" : "Save note"}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

// A note an automation raised, opened: its line, where it came from, its body as prose (an agent wrote it from what it
// read: no HTML, no images, its links as text), and its buttons. Nothing in it is yours to change, so it's read, not edited.
export function NoteCard({
  note,
  now,
  onPress,
  onDone,
  onClose,
  closer,
}: {
  note: Note;
  now: number;
  onPress: (n: Note, button: number) => void;
  onDone: (n: Note) => void;
  onClose: () => void;
  closer: (leave: (() => void) | null) => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const bs = useMemo(() => blocks(note.body ?? ""), [note.body]);
  useEffect(() => {
    closer(() => {
      setLeaving(true);
    });
    return () => {
      closer(null);
    };
  }, [closer]);
  const leave = () => {
    setLeaving(true);
  };
  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- a click on the blurred page closes it; Esc and Close are its keys and button
    <div
      className={cls("note-veil", leaving && "leaving")}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) leave();
      }}
    >
      <div
        className={cls("note-tray note-card", leaving && "leaving")}
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a native <dialog>'s backdrop covers the sidebar; this one covers only the page
        role="dialog"
        aria-modal="true"
        aria-label={note.text}
        onAnimationEnd={(e) => {
          if (leaving && e.target === e.currentTarget) onClose();
        }}
      >
        <button type="button" className="note-x" title="Close (Esc)" aria-label="Close" onClick={leave}>
          <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
            <path d="m4.5 4.5 7 7m0-7-7 7" />
          </svg>
        </button>
        <div className="nc-head">
          <div className="nc-title">{note.text}</div>
          <div className="nc-from">
            <NoteGlyph icon={note.icon} />
            From your automation {note.from?.name} · {age(note.at, now)} ago
          </div>
        </div>
        {bs.length > 0 && <ProseBlocks bs={bs} links={false} />}
        <div className="note-when">
          <span className="note-acts">
            {note.buttons?.map((b, i) => (
              <NoteAction
                key={`${b.do}:${b.label}`}
                n={note}
                b={b}
                i={i}
                className={cls("act", i === 0 && "primary")}
                onPress={(n, at) => {
                  onPress(n, at);
                  leave();
                }}
              />
            ))}
            <button
              type="button"
              className="act note-done"
              title="Mark this note as done: it leaves your Inbox"
              onClick={() => {
                onDone(note);
                leave();
              }}
            >
              <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
                <path d="m3.5 8.5 3 3 6-7" />
              </svg>
              Mark as done
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
