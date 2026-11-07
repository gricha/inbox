// Settings → Automations: your instructions on a schedule, each with its last runs. Turn one on, run it now, write or change
// one, delete it. A run's summary and whys are an agent's words: shown as text, never markup.
import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import type { AutomationRun, AutomationView } from "../../../src/types.ts";
import { api, message } from "../api.ts";
import { ago, cls, issueUrl, MOD, when } from "../format.ts";

const OUTCOME: Record<AutomationRun["items"][number]["outcome"], string> = {
  added: "Added",
  kept: "Already on your desk",
  left: "You'd dealt with it",
  resolved: "Nobody needs it now",
  failed: "Couldn't add",
};

interface Draft {
  id: string | null; // null: a new one, its id from its name
  name: string;
  schedule: string;
  prompt: string;
  on: boolean;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 40);

// The last run in a line: what it put on your desk, or why it failed.
function lastLine(r: AutomationRun | undefined, now: number): { text: string; bad: boolean } {
  if (!r) return { text: "Hasn't run yet", bad: false };
  if (!r.done_at) return { text: `Running since ${ago(r.at, now)}`, bad: false };
  if (r.error) return { text: `Failed ${ago(r.at, now)}: ${r.error.split("\n")[0] ?? ""}`, bad: true };
  const added = r.items.filter((x) => x.outcome === "added").length;
  const failed = r.items.filter((x) => x.outcome === "failed").length;
  const said = [added && `put ${added} on your desk`, failed && `couldn't add ${failed}`].filter(Boolean).join(", ");
  return { text: `Ran ${ago(r.at, now)}: ${said || "nothing new needed you"}`, bad: failed > 0 };
}

export function Automations({
  active,
  refresh,
  now,
  flash,
}: {
  active: boolean;
  refresh: number; // bumps on every app refresh
  now: number;
  flash: (text: string, error?: boolean) => void;
}) {
  const [list, setList] = useState<AutomationView[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null); // whose runs show
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await api.automations());
      setError("");
    } catch (e) {
      setError(message(e));
    }
  }, []);

  useEffect(() => {
    if (active) void load();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- refresh only triggers a re-read
  }, [active, load, refresh]);

  // True once it's saved; a switch's put leaves an open editor as it is.
  async function put(id: string, b: Omit<Draft, "id">, done: string): Promise<boolean> {
    setBusy(true);
    try {
      await api.setAutomation(id, b);
      flash(done);
      await load();
      return true;
    } catch (e) {
      flash(message(e), true);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function runNow(a: AutomationView) {
    try {
      await api.runAutomation(a.id);
      flash(`Running ${a.name}: what it finds lands on your desk`);
      await load();
    } catch (e) {
      flash(message(e), true);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await api.deleteAutomation(id);
      setDraft(null);
      await load();
    } catch (e) {
      flash(message(e), true);
    } finally {
      setBusy(false);
    }
  }

  // A new one's id is its name's, made free with -2, -3… so it never lands on one you have.
  function save(d: Draft) {
    const base = d.id ?? slug(d.name);
    if (!base) {
      flash("Give it a name", true);
      return;
    }
    let id = base;
    for (let n = 2; !d.id && list?.some((a) => a.id === id); n++) id = `${base.slice(0, 36)}-${n}`;
    void (async () => {
      if (await put(id, { name: d.name, schedule: d.schedule, prompt: d.prompt, on: d.on }, d.id ? `Saved ${d.name}` : `Added ${d.name}`))
        setDraft(null);
    })();
  }

  if (error && !list) return <p className="t-bad">Couldn't load automations: {error}</p>;
  if (!list) return null;
  return (
    <div className="au">
      {list.length > 0 && (
        <ul className="au-list">
          {list.map((a) => {
            const last = lastLine(a.runs[0], now);
            const shown = open === a.id;
            // What an agent wrote is on screen before you turn it on or run it.
            const drafted = !a.on && a.by === "an agent";
            return (
              <li key={a.id} className={cls("au-item", !a.on && "off")}>
                <div className="au-row">
                  <input
                    className="switch"
                    type="checkbox"
                    // oxlint-disable-next-line jsx-a11y/role-has-required-aria-props -- a checkbox input's state is its native checked
                    role="switch"
                    checked={a.on}
                    aria-label={`Run ${a.name} on its schedule`}
                    onChange={() => {
                      void put(
                        a.id,
                        { name: a.name, schedule: a.schedule, prompt: a.prompt, on: !a.on },
                        `${a.name} is ${a.on ? "off" : "on"}`,
                      );
                    }}
                  />
                  <button
                    type="button"
                    className="au-main"
                    aria-expanded={shown}
                    onClick={() => {
                      setOpen(shown ? null : a.id);
                    }}
                  >
                    <span className="au-name">{a.name}</span>
                    <span className="au-when">
                      {a.schedule}
                      {a.on && a.next_at ? ` · next ${when(a.next_at)}` : ""}
                      {drafted ? " · an agent wrote or changed it: read it, then turn it on to run it" : ""}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="act"
                    disabled={a.running}
                    onClick={() => {
                      void runNow(a);
                    }}
                  >
                    {a.running ? "Running…" : "Run now"}
                  </button>
                  <button
                    type="button"
                    className="act"
                    onClick={() => {
                      setDraft({ id: a.id, name: a.name, schedule: a.schedule, prompt: a.prompt, on: a.on });
                    }}
                  >
                    Edit
                  </button>
                </div>
                <p className={cls("au-last", last.bad && "t-bad")}>{last.text}</p>
                {shown ? <Runs a={a} /> : drafted && <p className="au-prompt au-draft">{a.prompt}</p>}
              </li>
            );
          })}
        </ul>
      )}
      {list.length === 0 && !draft && (
        <p className="quiet au-none">
          None yet. Ask an agent with the desk's tools (&ldquo;every Monday, look at the new issues in … and put what needs me on my
          desk&rdquo;), or write one.
        </p>
      )}
      {draft ? (
        <Editor
          key={draft.id ?? "new"}
          draft={draft}
          busy={busy}
          onSave={save}
          onCancel={() => {
            setDraft(null);
          }}
          onDelete={
            draft.id
              ? () => {
                  void remove(draft.id!);
                }
              : null
          }
        />
      ) : (
        <button
          type="button"
          className="act au-new"
          onClick={() => {
            setDraft({ id: null, name: "", schedule: "weekdays 09:00", prompt: "", on: true });
          }}
        >
          New automation
        </button>
      )}
    </div>
  );
}

// Its instruction, then each run: when, what it found, and what came of each item.
function Runs({ a }: { a: AutomationView }) {
  return (
    <div className="au-runs">
      <p className="au-prompt">{a.prompt}</p>
      {a.runs.map((r) => (
        <section key={r.id} className="au-run" aria-label={`Run ${when(r.at)}`}>
          <h4 className="au-run-head">
            {when(r.at)} · {r.trigger === "now" ? "run now" : "on schedule"}
            {!r.done_at && <span className="busy" aria-label="running" />}
          </h4>
          {r.error && <p className="t-bad au-run-error">{r.error}</p>}
          {r.summary && <p className="au-summary">{r.summary}</p>}
          {r.items.length > 0 && (
            <ul className="au-found">
              {r.items.map((x) => (
                <li key={x.item_id}>
                  <span className={cls("au-outcome", x.outcome === "failed" && "t-bad")}>{OUTCOME[x.outcome]}</span>
                  {/^[\w.-]+\/[\w.-]+#\d+$/.test(x.item_id) ? (
                    <a href={issueUrl(x.item_id)} target="_blank" rel="noreferrer">
                      {x.item_id}
                    </a>
                  ) : (
                    <span>{x.item_id}</span>
                  )}
                  <span className="au-why">{x.error ?? x.why}</span>
                </li>
              ))}
            </ul>
          )}
          {r.session && (
            <p className="quiet au-session">
              To see what it did: <code>claude --resume {r.session}</code> in the desk's <code>automations</code> folder
            </p>
          )}
        </section>
      ))}
    </div>
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
  onDelete: (() => void) | null;
}) {
  const [d, setD] = useState(draft);
  const ready = !!d.name.trim() && !!d.schedule.trim() && !!d.prompt.trim();
  // ⌘S or ⌘↵ saves from any field, Esc leaves it as it was.
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
          placeholder="Warden and dotagents issues"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- you opened the editor to write in it
          autoFocus={!d.id}
          onKeyDown={keys}
          onChange={(e) => {
            setD({ ...d, name: e.target.value });
          }}
        />
      </label>
      <label className="au-field">
        <span className="s-label">When</span>
        <input
          className="input"
          value={d.schedule}
          placeholder="weekdays 09:00"
          onKeyDown={keys}
          onChange={(e) => {
            setD({ ...d, schedule: e.target.value });
          }}
        />
        <span className="s-help">Local time: daily 09:00, weekdays 09:00,13:00, mon,thu 17:30 or weekdays hourly.</span>
      </label>
      <label className="au-field">
        <span className="s-label">Instruction</span>
        <textarea
          className="editor prose"
          value={d.prompt}
          maxLength={8000}
          onKeyDown={keys}
          placeholder="Look at the issues opened or active in getsentry/warden and getsentry/dotagents since the last run. Put on my desk the ones that need me: a regression, a question to me, a PR that touches what I own. Nothing needs me? Say so."
          onChange={(e) => {
            setD({ ...d, prompt: e.target.value });
          }}
        />
        <span className="s-help">
          Your own Claude Code runs it read only, with your tools; it lists the PRs and issues that need you with a line on why, and the
          desk puts them on your desk.
        </span>
      </label>
      <div className="actions">
        <button type="submit" className="act primary" disabled={!ready || busy} title={`Save (${MOD}S)`}>
          Save
        </button>
        <button type="button" className="act" title="Cancel (Esc)" onClick={onCancel}>
          Cancel
        </button>
        {onDelete && (
          <button type="button" className="act au-delete" disabled={busy} onClick={onDelete}>
            Delete
          </button>
        )}
      </div>
    </form>
  );
}
