// Settings → Automation Rules → Urgency: your criteria and the plugins', each a yes or no about an item that orders the Inbox and never acts on
// it. Yours first, with New criterion; then what GitHub comes with, which you only switch.
import { Effect } from "effect";
import { Fragment, useCallback, useEffect, useState, type KeyboardEvent } from "react";
import type { CriteriaView } from "../../../src/types.ts";
import { api, runUi } from "../api.ts";
import { ago, aiName, MOD } from "../format.ts";
import { AskChange } from "./AskChange.tsx";
import { changeAsk } from "../view.ts";
import { SkLines } from "./Skeleton.tsx";

type Crit = CriteriaView["criteria"][number];
interface Draft {
  id: string | null;
  name: string;
  when: string;
  ask: string;
  urgent: boolean;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 40);

// What it says yes to, in a line: the plugin's own words, else its question, else its rule.
const whatOf = (c: Crit) => (c.help ?? (c.ask ? `Asks: ${c.ask}` : `When ${c.when ?? ""}`)).replace(/\.$/, "");

export function Criteria({
  active,
  refresh,
  now,
  flash,
  onAsked,
}: {
  active: boolean;
  refresh: number;
  now: number;
  flash: (text: string, error?: boolean) => void;
  onAsked: () => void; // your agent has your words: its chat opens
}) {
  const [changing, setChanging] = useState<string | null>(null); // the criterion you're asking your agent to change
  const [view, setView] = useState<CriteriaView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  const load = useCallback(
    (): Effect.Effect<void> =>
      api.criteria().pipe(
        Effect.match({
          onSuccess: (v) => {
            setView(v);
            setError("");
          },
          onFailure: (e) => {
            setError(e.message);
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

  // A write, then the list again; what fails says so and leaves the list as it was.
  const write = (e: Effect.Effect<unknown, { message: string }>, done: string, after?: () => void) => {
    setBusy(true);
    runUi(
      e.pipe(
        Effect.andThen(() => {
          flash(done);
          after?.();
          return load();
        }),
        Effect.catch((x) =>
          Effect.sync(() => {
            flash(x.message, true);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            setBusy(false);
          }),
        ),
      ),
    );
  };
  const turn = (c: Crit) => {
    write(api.switchCriterion(c.id, !c.on), `${c.name} is ${c.on ? "off" : "on"}`);
  };
  const save = (d: Draft) => {
    let id = d.id ?? slug(d.name);
    for (let n = 2; !d.id && view?.criteria.some((c) => c.id === id); n++) id = `${slug(d.name).slice(0, 36)}-${n}`;
    const body = { name: d.name, when: d.when, ask: d.ask, urgent: d.urgent };
    write(api.setCriterion(id, body), d.id ? `Saved ${d.name}` : `Added ${d.name}`, () => {
      setDraft(null);
    });
  };
  const remove = (d: Draft) => {
    if (d.id)
      write(api.deleteCriterion(d.id), `Deleted ${d.name}`, () => {
        setDraft(null);
      });
  };

  if (!view)
    return (
      <div className="lines s-sheet">
        {error ? (
          <div className="setting s-status">
            <div className="s-label-col">
              <p className="s-label">Couldn't load your criteria</p>
              <p className="s-help t-bad">{error}</p>
            </div>
          </div>
        ) : (
          <div className="setting" aria-hidden="true">
            <SkLines count={2} />
          </div>
        )}
      </div>
    );
  const own = view.criteria.filter((c) => !c.plugin);
  const plugins = [...new Set(view.criteria.flatMap((c) => (c.plugin ? [c.plugin] : [])))];
  const row = (c: Crit) => (
    <Fragment key={c.id}>
      <div className="setting cr-row">
        <div className="s-label-col">
          {c.plugin ? (
            <p className="s-label">{c.name}</p>
          ) : (
            <button
              type="button"
              className="s-label s-name cr-name"
              onClick={() => {
                setDraft({ id: c.id, name: c.name, when: c.when ?? "", ask: c.ask ?? "", urgent: c.urgent });
              }}
            >
              {c.name}
            </button>
          )}
          <p className="s-help">
            {whatOf(c)}
            {c.urgent ? " · a yes is urgent" : ""}
            {c.on ? ` · yes for ${c.yes} on your Inbox` : ""}
            {c.on && c.waiting ? ` · ${c.waiting} waiting for an answer` : ""}
            {!c.plugin && c.by === "an agent" ? " · an agent wrote it" : ""}
            {changing !== c.id && (
              <>
                {" · "}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setChanging(c.id);
                  }}
                >
                  Change with your agent
                </button>
              </>
            )}
          </p>
        </div>
        <div className="s-control">
          <input
            className="switch"
            type="checkbox"
            // oxlint-disable-next-line jsx-a11y/role-has-required-aria-props -- a checkbox input's state is its native checked
            role="switch"
            checked={c.on}
            disabled={busy}
            aria-label={`Order the Inbox by ${c.name}`}
            onChange={() => {
              turn(c);
            }}
          />
        </div>
      </div>
      {changing === c.id && (
        <div className="setting cr-ask">
          <AskChange
            ask={(words) => changeAsk({ kind: "criterion", id: c.id, name: c.name, builtIn: !!c.plugin }, words)}
            onSent={onAsked}
            onClose={() => {
              setChanging(null);
            }}
            flash={flash}
          />
        </div>
      )}
    </Fragment>
  );
  const fresh = () => {
    setDraft({ id: null, name: "", when: "", ask: "", urgent: false });
  };
  return (
    <>
      <div className="lines s-sheet">
        {view.held && (
          <div className="setting s-status">
            <div className="s-label-col">
              <p className="s-label">Questions are waiting</p>
              <p className="s-help t-bad">{view.held.why}</p>
            </div>
          </div>
        )}
        {own.map(row)}
        {!own.length && (
          <div className="setting">
            <div className="s-label-col">
              <p className="s-label">None of yours yet</p>
              <p className="s-help">Tell your agent what you care about, or write one: a yes moves an item up your Inbox.</p>
            </div>
            {!draft && (
              <div className="s-control">
                <button type="button" className="s-edit" onClick={fresh}>
                  New criterion
                </button>
              </div>
            )}
          </div>
        )}
        {own.length > 0 && !draft && (
          <div className="s-more">
            <button type="button" className="s-edit" onClick={fresh}>
              New criterion
            </button>
          </div>
        )}
      </div>
      {draft && (
        <div className="au-new">
          <Editor
            key={draft.id ?? ""}
            draft={draft}
            busy={busy}
            onSave={save}
            onCancel={() => {
              setDraft(null);
            }}
            onDelete={draft.id ? remove : null}
          />
        </div>
      )}
      {plugins.map((p) => (
        <section key={p} className="cr-plugin" aria-label={`What ${p === "github" ? "GitHub" : p} comes with`}>
          <h2 className="group-head">{p === "github" ? "From GitHub" : p}</h2>
          <div className="lines s-sheet">{view.criteria.filter((c) => c.plugin === p).map(row)}</div>
        </section>
      ))}
      <p className="cr-note">
        {view.scored
          ? `${view.scored.by} last scored your Inbox ${ago(view.scored.at, now)}.`
          : `Scored by the desk from your rules and these yeses until ${aiName()} scores it.`}
      </p>
    </>
  );
}

function Editor({
  draft,
  busy,
  onSave,
  onCancel,
  onDelete,
}: {
  draft: Draft;
  busy: boolean;
  onSave: (d: Draft) => void;
  onCancel: () => void;
  onDelete: ((d: Draft) => void) | null;
}) {
  const [d, setD] = useState(draft);
  const ready = !!d.name.trim() && (!!d.when.trim() || !!d.ask.trim());
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") onCancel();
    else if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "Enter")) {
      e.preventDefault();
      if (ready) onSave(d);
    }
  };
  return (
    <form
      className="au-editor"
      data-own-save=""
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSave(d);
      }}
    >
      <label className="au-field">
        <span className="s-label">Name</span>
        <input
          className="input"
          value={d.name}
          maxLength={80}
          placeholder="Service accounts"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- you opened the editor to write in it
          autoFocus={!d.id}
          onKeyDown={keys}
          onChange={(e) => {
            setD({ ...d, name: e.target.value });
          }}
        />
      </label>
      <label className="au-field">
        <span className="s-label">Ask</span>
        <textarea
          className="editor prose cr-ask"
          value={d.ask}
          maxLength={1000}
          placeholder="Is it about service accounts?"
          onKeyDown={keys}
          onChange={(e) => {
            setD({ ...d, ask: e.target.value });
          }}
        />
        <span className="s-help">
          A yes-or-no question about each item, which {aiName()} answers once per change. Leave it empty for a rule alone.
        </span>
      </label>
      <label className="au-field">
        <span className="s-label">Only when</span>
        <input
          className="input au-code"
          value={d.when}
          placeholder="!me.author"
          spellCheck={false}
          onKeyDown={keys}
          onChange={(e) => {
            setD({ ...d, when: e.target.value });
          }}
        />
        <span className="s-help">In your rules' language: free and exact. With a question, only these items are asked.</span>
      </label>
      <label className="au-check">
        <input
          type="checkbox"
          checked={d.urgent}
          onChange={(e) => {
            setD({ ...d, urgent: e.target.checked });
          }}
        />
        A yes makes it urgent, whatever its score
      </label>
      <div className="actions">
        <button type="submit" className="act primary" disabled={!ready || busy} title={`Save (${MOD}S)`}>
          Save
        </button>
        <button type="button" className="act" title="Cancel (Esc)" onClick={onCancel}>
          Cancel
        </button>
        {onDelete && (
          <button
            type="button"
            className="act au-delete"
            disabled={busy}
            onClick={() => {
              onDelete(d);
            }}
          >
            Delete
          </button>
        )}
      </div>
    </form>
  );
}
