// Settings → Automations: your instructions on a schedule. The tab lists them (turn one on, run it now, write a new one);
// each opens a view of its own with its instruction, its editor and its runs. A run's summary and whys are an agent's words:
// shown as text, never markup.
import { Effect } from "effect";
import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  outcomeText,
  VERB,
  type ActivityKind,
  type AutomationBody,
  type AutomationView as Auto,
  type RuleAction,
  type Verb,
  type Way,
} from "../../../src/types.ts";
import { api, runUi } from "../api.ts";
import { ago, cls, copyText, issueUrl, MOD, when } from "../format.ts";
import { resumeCommand, routeHash } from "../view.ts";
import { SkLines } from "./Skeleton.tsx";

type Run = Auto["runs"][number];
const RAN: Record<Run["trigger"], string> = { schedule: "on schedule", now: "run now", event: "on an event" };

interface Draft {
  id: string | null; // null: a new one, its id from its name
  name: string;
  schedule: string; // "" with events
  events: ActivityKind[];
  prompt: string;
  when: string;
  decide: Way;
  rule?: RuleAction; // with decide rule
  can: Verb[];
  on: boolean;
}

// What the desk may do with what it lists, after "may": "add to your desk, sort to FYI and snooze".
const mayText = (can: readonly Verb[]) => {
  const said = can.map((v) => VERB[v]);
  return said.length > 1 ? `${said.slice(0, -1).join(", ")} and ${said.at(-1)}` : (said[0] ?? "");
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 40);

const viewOf = (id: string) => routeHash({ name: "settings", section: `automations/${id}` });
const drafted = (a: Auto) => !a.on && a.by === "an agent"; // what an agent wrote is on screen before you turn it on

// The last run, the end of its row's help: what it put on your desk, then (red, the only part that is) why it failed or what
// it couldn't add.
function lastLine(r: Run | undefined, now: number): { text: string; bad: string } {
  if (!r) return { text: "hasn't run yet", bad: "" };
  if (!r.done_at) return { text: `running since ${ago(r.at, now)}`, bad: "" };
  if (r.error) return { text: "", bad: `failed ${ago(r.at, now)}: ${r.error.split("\n")[0] ?? ""}` };
  const ran = `ran ${ago(r.at, now)}, `;
  if (r.didnt) return { text: r.did ? `${ran}${r.did}, ` : ran, bad: r.didnt };
  return { text: `${ran}${r.did || "nothing new needed you"}`, bad: "" };
}

type Automations = ReturnType<typeof useAutomations>;

// The list and its writes, once for Settings: the tab's rows and an automation's view read the same list.
export function useAutomations(active: boolean, refresh: number, flash: (text: string, error?: boolean) => void) {
  const [list, setList] = useState<Auto[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // A new one being written: the tab's last row opens it, and its editor sits under the tab's sheet.
  const [writing, setWriting] = useState<Draft | null>(null);
  // An edit open in an automation's view, by its id: kept across a trip to another automation's view, or anywhere, and back.
  const [edits, setEdits] = useState<Record<string, Draft | undefined>>({});
  const keep = useCallback((id: string, d: Draft | null) => {
    setEdits((e) => ({ ...e, [id]: d ?? undefined }));
  }, []);

  const load = useCallback(
    (): Effect.Effect<void> =>
      api.automations().pipe(
        Effect.match({
          onSuccess: (l) => {
            setList(l);
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

  const failed = (e: { message: string }) =>
    Effect.sync(() => {
      flash(e.message, true);
    });
  const idle = Effect.sync(() => {
    setBusy(false);
  });

  // True once it's saved; a switch's put leaves an open editor as it is.
  function put(id: string, b: AutomationBody, done: string): Effect.Effect<boolean> {
    return Effect.suspend(() => {
      setBusy(true);
      return api.setAutomation(id, b).pipe(
        Effect.andThen(() => {
          flash(done);
          return load();
        }),
        Effect.as(true),
        Effect.catch((e) => failed(e).pipe(Effect.as(false))),
        Effect.ensuring(idle),
      );
    });
  }

  // The whole automation each time: what a switch doesn't change goes back as it is.
  const turn = (a: Auto, on: boolean) => {
    const { id: _, ...same } = editing(a);
    return put(a.id, { ...same, on }, `${a.name} is ${on ? "on" : "off"}`);
  };

  function runNow(a: Auto): Effect.Effect<void> {
    return api.runAutomation(a.id).pipe(
      Effect.andThen(() => {
        flash(`Running ${a.name}: what it finds lands on your desk`);
        return load();
      }),
      Effect.catch(failed),
    );
  }

  // True once it's gone.
  function remove(id: string): Effect.Effect<boolean> {
    return Effect.suspend(() => {
      setBusy(true);
      return api.deleteAutomation(id).pipe(
        Effect.andThen(load),
        Effect.as(true),
        Effect.catch((e) => failed(e).pipe(Effect.as(false))),
        Effect.ensuring(idle),
      );
    });
  }

  // A new one's id is its name's, made free with -2, -3… so it never lands on one you have. True once it's saved.
  function save(d: Draft): Effect.Effect<boolean> {
    const base = d.id ?? slug(d.name);
    if (!base) {
      flash("Give it a name", true);
      return Effect.succeed(false);
    }
    let id = base;
    for (let n = 2; !d.id && list?.some((a) => a.id === id); n++) id = `${base.slice(0, 36)}-${n}`;
    const { id: _, ...body } = d;
    return put(id, body, d.id ? `Saved ${d.name}` : `Added ${d.name}`);
  }

  return { list, error, busy, writing, setWriting, edits, keep, turn, runNow, remove, save };
}

const editing = (a: Auto): Draft => ({
  id: a.id,
  name: a.name,
  schedule: a.schedule,
  events: a.events ?? [],
  prompt: a.prompt,
  when: a.when ?? "",
  decide: a.decide ?? "agent",
  ...(a.rule && { rule: a.rule }),
  can: a.can ?? ["add"],
  on: a.on,
});

// The Automations tab's rows on its sheet: each its name (its view), when it runs and its last run, Run now while it's on
// and its switch; an agent's draft has Review instead, so it can't run before its instruction has been on screen.
export function AutomationRows({ au, now }: { au: Automations; now: number }) {
  if (au.error && !au.list)
    return (
      <div className="setting s-status">
        <div className="s-label-col">
          <p className="s-label">Couldn't load your automations</p>
          <p className="s-help t-bad">{au.error}</p>
        </div>
      </div>
    );
  if (!au.list)
    return (
      <div className="setting" aria-hidden="true">
        <SkLines count={2} />
      </div>
    );
  const write = au.writing ? null : (
    <button
      type="button"
      className="s-edit"
      onClick={() => {
        au.setWriting({
          id: null,
          name: "",
          schedule: "weekdays 09:00",
          events: [],
          prompt: "",
          when: "",
          decide: "agent",
          can: ["add"],
          on: true,
        });
      }}
    >
      New automation
    </button>
  );
  if (!au.list.length)
    return (
      <div className="setting">
        <div className="s-label-col">
          <p className="s-label">None yet</p>
          <p className="s-help">Ask an agent to write one, or write one yourself.</p>
        </div>
        <div className="s-control">{write}</div>
      </div>
    );
  return (
    <>
      {au.list.map((a) => (
        <AutomationRow key={a.id} a={a} au={au} now={now} />
      ))}
      {write && <div className="s-more">{write}</div>}
    </>
  );
}

function AutomationRow({ a, au, now }: { a: Auto; au: Automations; now: number }) {
  const href = viewOf(a.id);
  const draft = drafted(a);
  const last = lastLine(a.runs[0], now);
  const timing = [a.trigger, a.on ? a.next_at && `next ${when(a.next_at)}` : "off"].filter(Boolean).join(" · ");
  return (
    <div className="setting au-row">
      <div className="s-label-col">
        {/* A draft's Review is its one stop for Tab; the name is there for the mouse. */}
        <a className="s-label s-name" href={href} tabIndex={draft ? -1 : undefined}>
          {a.name}
        </a>
        <p className="s-help">
          {draft ? (
            `An agent wrote it; read it before it runs · ${a.trigger}`
          ) : (
            <>
              {timing} · {last.text}
              {last.bad && <span className="t-bad">{last.bad}</span>}
            </>
          )}
        </p>
      </div>
      <div className="s-control">
        {draft ? (
          <a className="act s-cta" href={href} aria-label={`Review ${a.name}`}>
            Review
          </a>
        ) : (
          <>
            {a.on && (
              <button
                type="button"
                className="s-edit"
                disabled={a.running}
                aria-label={`Run now: ${a.name}`}
                onClick={() => {
                  runUi(au.runNow(a));
                }}
              >
                {a.running ? "Running…" : "Run now"}
              </button>
            )}
            <input
              className="switch"
              type="checkbox"
              // oxlint-disable-next-line jsx-a11y/role-has-required-aria-props -- a checkbox input's state is its native checked
              role="switch"
              checked={a.on}
              aria-label={`Run ${a.name} ${a.events ? "when its events land" : "on its schedule"}`}
              onChange={() => {
                runUi(au.turn(a, !a.on));
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}

// A new automation's editor, under the tab's sheet once its last row's New automation opens it.
export function NewAutomation({ au }: { au: Automations }) {
  if (!au.writing) return null;
  return (
    <div className="au-new">
      <Editor
        draft={au.writing}
        busy={au.busy}
        onSave={(d) => {
          runUi(
            au.save(d).pipe(
              Effect.tap((ok) =>
                Effect.sync(() => {
                  if (ok) au.setWriting(null);
                }),
              ),
            ),
          );
        }}
        onCancel={() => {
          au.setWriting(null);
        }}
        onDelete={null}
      />
    </div>
  );
}

// An automation's view (#/settings/automations/<id>): its name and when it runs, its instruction and what you can do with
// it, then its runs.
export function AutomationView({
  au,
  id,
  settingsPath,
  flash,
}: {
  au: Automations;
  id: string;
  settingsPath: string | null; // settings.json's: the runs' folder is beside it, in the desk's home
  flash: (text: string, error?: boolean) => void;
}) {
  const draft = au.edits[id] ?? null;
  const setDraft = (d: Draft | null) => {
    au.keep(id, d);
  };

  if (au.error && !au.list)
    return (
      <p id="s-view-automation" className="s-view-line t-bad">
        Couldn't load automations: {au.error}
      </p>
    );
  // On its way: its name's and its line's places.
  if (!au.list)
    return (
      <div aria-busy="true">
        <h1 id="s-view-automation" className="s-view-name" aria-label="Loading">
          <span className="sk" />
        </h1>
        <SkLines count={1} className="s-view-line" />
      </div>
    );
  const a = au.list.find((x) => x.id === id);
  if (!a)
    return (
      <p id="s-view-automation" className="s-view-line">
        There&rsquo;s no automation called &ldquo;{id}&rdquo;.
      </p>
    );

  const agents = drafted(a);
  const line = `${a.trigger} · ${agents ? "an agent wrote it: read it before you turn it on." : a.on ? (a.next_at ? `next ${when(a.next_at)}` : "on") : "off"}`;
  const turn = (on: boolean) => () => {
    runUi(au.turn(a, on));
  };
  const resume = (session: string) => {
    if (!settingsPath) return null;
    const cmd = resumeCommand(settingsPath, session);
    return (
      <button
        type="button"
        className="link-btn au-resume"
        title={cmd}
        onClick={() => {
          runUi(
            copyText(cmd).pipe(
              Effect.match({
                onSuccess: () => {
                  flash("Copied");
                },
                onFailure: () => {
                  flash(`Couldn't copy it. Run ${cmd}`, true);
                },
              }),
            ),
          );
        }}
      >
        Copy resume command
      </button>
    );
  };

  return (
    <>
      <h1 id="s-view-automation" className="s-view-name">
        {a.name}
      </h1>
      <p className="s-view-line">{line}</p>
      <div className="au-view">
        {draft ? (
          <Editor
            draft={draft}
            busy={au.busy}
            onChange={setDraft}
            onSave={(d) => {
              runUi(
                au.save(d).pipe(
                  Effect.tap((ok) =>
                    Effect.sync(() => {
                      if (ok) setDraft(null);
                    }),
                  ),
                ),
              );
            }}
            onCancel={() => {
              setDraft(null);
            }}
            onDelete={() => {
              runUi(
                au.remove(a.id).pipe(
                  Effect.tap((ok) =>
                    Effect.sync(() => {
                      if (!ok) return;
                      setDraft(null);
                      flash(`Deleted ${a.name}`);
                      location.replace(routeHash({ name: "settings", section: "automations" })); // its view is gone with it
                    }),
                  ),
                ),
              );
            }}
          />
        ) : (
          <>
            <p className="au-prompt">{a.prompt}</p>
            <p className="au-note">
              {a.can
                ? `Runs with your Claude Code and only reads; with what it lists, the desk may ${mayText(a.can)}.`
                : "Runs with your Claude Code and only reads; what needs you lands in your Inbox."}
            </p>
            <div className="actions">
              {agents ? (
                <button type="button" className="act primary" disabled={au.busy} onClick={turn(true)}>
                  Turn on
                </button>
              ) : (
                <button
                  type="button"
                  className="act"
                  disabled={a.running}
                  onClick={() => {
                    runUi(au.runNow(a));
                  }}
                >
                  {a.running ? "Running…" : "Run now"}
                </button>
              )}
              <button
                type="button"
                className="act"
                onClick={() => {
                  setDraft(editing(a));
                }}
              >
                Edit
              </button>
              {!agents && (
                <button type="button" className="act" disabled={au.busy} onClick={turn(!a.on)}>
                  {a.on ? "Turn off" : "Turn on"}
                </button>
              )}
            </div>
          </>
        )}
      </div>
      <h2 className="group-head au-runs-head">Runs</h2>
      {a.runs.length ? <Runs a={a} resume={resume} /> : <p className="s-view-line">It hasn&rsquo;t run yet.</p>}
    </>
  );
}

// Each run: when, what it found, and what came of each item; its session one click from your clipboard.
function Runs({ a, resume }: { a: Auto; resume: (session: string) => ReactNode }) {
  return (
    <div className="lines">
      {a.runs.map((r) => (
        <section key={r.id} className="au-run" aria-label={`Run ${when(r.at)}`}>
          <div className="au-run-top">
            <h3 className="au-run-head">
              {when(r.at)} · {RAN[r.trigger]}
              {r.did && ` · ${r.did}`}
              {r.didnt && <span className="t-bad"> · {r.didnt}</span>}
              {!r.done_at && <span className="busy" aria-label="running" />}
            </h3>
            {r.session && resume(r.session)}
          </div>
          {r.error && <p className="t-bad au-run-error">{r.error}</p>}
          {r.summary && <p className="au-summary">{r.summary}</p>}
          {r.items.length > 0 && (
            <ul className="au-found">
              {r.items.map((x) => (
                <li key={x.item_id}>
                  <span className={cls("au-outcome", (x.outcome === "failed" || x.outcome === "refused") && "t-bad")}>
                    {outcomeText(x)}
                  </span>
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
        </section>
      ))}
    </div>
  );
}

function Editor({
  draft,
  busy,
  onChange,
  onSave,
  onCancel,
  onDelete,
}: {
  draft: Draft;
  busy: boolean;
  onChange?: (d: Draft) => void; // where it's kept while you write
  onSave: (d: Draft) => void;
  onCancel: () => void;
  onDelete: (() => void) | null;
}) {
  const [d, setDraft] = useState(draft);
  const setD = (next: Draft) => {
    setDraft(next);
    onChange?.(next);
  };
  const ready = !!d.name.trim() && (!!d.schedule.trim() || d.events.length > 0) && !!d.prompt.trim();
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
