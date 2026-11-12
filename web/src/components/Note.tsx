import { Effect } from "effect";
import { useEffect, useRef, useState } from "react";
import type { Note } from "../../../src/types.ts";
import { runUi } from "../api.ts";
import { age, cls, MOD, when } from "../format.ts";

const noteOf = (id: string) => `note:${id}`;

export interface NoteCtx {
  now: number;
  compact?: boolean;
  selected: string | null;
  open: (n: Note) => void; // into the note box, to change it
  done: (n: Note) => void;
}

// A note to yourself as a row: Note, its words, Done; when it reminds (or reminded) you where a PR's author goes.
export function NoteRow({ n, ctx }: { n: Note; ctx: NoteCtx }) {
  const id = noteOf(n.id);
  const later = !!n.remind_at && Date.parse(n.remind_at) > ctx.now;
  const kind = <span className="line-kind">Note</span>;
  const title = <span className="line-title">{n.text}</span>;
  const by = (
    <span
      className="line-by"
      title={n.remind_at ? `${later ? "Reminds you" : "Reminded you"} ${new Date(n.remind_at).toLocaleString()}` : undefined}
    >
      {n.remind_at ? `at ${when(n.remind_at)}` : "by you"}
    </span>
  );
  const ageEl = (
    <span className="line-age" title={`written ${new Date(n.at).toLocaleString()}`}>
      {age(n.remind_at && !later ? n.remind_at : n.at, ctx.now)}
    </span>
  );
  return (
    <div className={cls("line memo", ctx.compact && "c-line", ctx.selected === id && "sel")} data-id={id}>
      <div className={cls("line-main line-row", ctx.compact && "c-row")}>
        <button
          type="button"
          className="row-main line-btn"
          title="Change this note"
          onMouseDown={(e) => {
            e.preventDefault();
          }}
          onClick={() => {
            ctx.open(n);
          }}
        >
          {ctx.compact ? (
            <>
              {title}
              <span className="c-meta">
                {kind}
                {by}
              </span>
              {ageEl}
            </>
          ) : (
            <>
              {kind}
              {title}
            </>
          )}
        </button>
        <button
          type="button"
          className={ctx.compact ? "c-cta" : "act line-cta line-reply"}
          onClick={() => {
            ctx.done(n);
          }}
        >
          Done
        </button>
        {!ctx.compact && (
          <>
            {by}
            {ageEl}
          </>
        )}
      </div>
    </div>
  );
}

// The reminder's choices: none, a time from now as a snooze reads it, or one you pick.
const WHEN = [
  { value: "", label: "No reminder" },
  { value: "1h", label: "In 1 hour" },
  { value: "3h", label: "In 3 hours" },
  { value: "tomorrow", label: "Tomorrow 9:00" },
  { value: "monday", label: "Monday 9:00" },
  { value: "pick", label: "Pick a time…" },
];

// A datetime-local input's value for an ISO time, in this computer's clock.
const local = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

// New note (⌘N), or one you opened: your words and an optional reminder, at the window's bottom like a comment. ⌘↵ saves,
// Esc closes; a refusal keeps your words here.
export function NoteBar({
  note,
  onSave,
  onDone,
  onClose,
}: {
  note: Note | null;
  onSave: (text: string, remind: string) => Effect.Effect<boolean>;
  onDone: (n: Note) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(note?.text ?? "");
  const [pick, setPick] = useState(note?.remind_at ? "pick" : "");
  const [at, setAt] = useState(note?.remind_at ? local(note.remind_at) : "");
  const [busy, setBusy] = useState(false);
  const [opened] = useState(() => local(new Date().toISOString())); // the earliest time to pick
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    box.current?.focus();
  }, []);

  const remind = pick === "pick" ? (at ? new Date(at).toISOString() : "") : pick;
  const ready = !!text.trim() && !(pick === "pick" && !at) && !busy;

  function save() {
    if (!ready) return;
    setBusy(true);
    runUi(
      onSave(text, remind).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            setBusy(false);
          }),
        ),
        Effect.tap((ok) =>
          Effect.sync(() => {
            if (ok) onClose();
          }),
        ),
      ),
    );
  }

  return (
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a native <dialog> is modal or needs show(); this bar sits over the page
    <div className="composer note-bar" role="dialog" aria-label={note ? "Change your note" : "New note"}>
      <p className="composer-about">{note ? "Your note" : "New note to yourself"}</p>
      <div className="composer-row">
        <textarea
          ref={box}
          className="composer-input composer-text"
          aria-label="Your note"
          placeholder="Remind me to…"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.repeat) {
              e.preventDefault();
              save();
            }
          }}
        />
        <button type="button" className="act primary" title={`Save (${MOD}↵)`} disabled={!ready} onClick={save}>
          {busy ? "Saving…" : "Save"}
        </button>
        {note && (
          <button
            type="button"
            className="act"
            onClick={() => {
              onDone(note);
              onClose();
            }}
          >
            Done
          </button>
        )}
        <button type="button" className="act" title="Close (Esc)" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="note-when">
        <label>
          <span>Remind me</span>
          <select
            className="input choice"
            value={pick}
            onChange={(e) => {
              setPick(e.target.value);
            }}
          >
            {WHEN.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        {pick === "pick" && (
          <input
            className="input"
            type="datetime-local"
            aria-label="Remind me at"
            value={at}
            min={opened}
            onChange={(e) => {
              setAt(e.target.value);
            }}
          />
        )}
      </div>
    </div>
  );
}
