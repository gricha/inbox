// Settings → Your automations: your instructions, on a schedule or when something happens; a plugin's part lists the ones it
// comes with, which you only switch or copy. The part lists them (turn one on, run it now, write a new one); each opens a view of its own that says in plain words what starts it, its check, how it decides
// and what it may do, with its editor and its runs. A run's summary and whys are an agent's words: shown as text, never markup.
import { Effect } from "effect";
import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { AskChange } from "./AskChange.tsx";
import {
  ACTIVITY_KINDS,
  EVENT,
  outcomeText,
  UNTIL,
  VERB,
  VERBS,
  type ActivityKind,
  type AutomationBody,
  type AutomationRun,
  type AutomationView as Auto,
  type RuleAction,
  type Verb,
  type Way,
} from "../../../src/types.ts";
import { api, runUi } from "../api.ts";
import { ago, cls, copyText, issueUrl, MOD, when, aiName } from "../format.ts";
import { changeAsk, resumeCommand, routeHash } from "../view.ts";
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

// What the desk may do with what it lists: "add to your desk, sort to FYI and snooze".
const mayText = (can: readonly Verb[]) => {
  const said = can.map((v) => VERB[v]);
  return said.length > 1 ? `${said.slice(0, -1).join(", ")} and ${said.at(-1)}` : (said[0] ?? "");
};
const cap = (t: string) => `${t.charAt(0).toUpperCase()}${t.slice(1)}`;

// How long a rule's snooze lasts, after "until": the desk's own words for a snooze, less a date.
const UNTILS: [string, string][] = [
  ["tomorrow", "tomorrow"],
  ["1h", "an hour from then"],
  ["3h", "3 hours from then"],
  ["monday", "Monday"],
  ["activity", "new activity"],
  ...Object.entries(UNTIL),
];
const untilWords = (u: string | undefined) => UNTILS.find(([k]) => k === (u ?? "tomorrow"))?.[1] ?? u ?? "";

// How it decides, the three ways cheapest first, as the editor offers them.
const WAY: Record<Way, { name: string; help: string }> = {
  rule: { name: "A rule", help: "No model: every item that passes the check gets the one action below." },
  ask: { name: "Ask a model", help: "One call reads the items and answers for each, or leaves it as it is." },
  agent: { name: "An agent with tools", help: "Your own agent, read only, with tools: it can look further than the items." },
};
// Who answers a question: your decision model once its key is set (Settings → Agent), else Claude.
const answers = (model: string | null) => (model ? `${model} answers, through OpenRouter` : `${aiName()} answers, without tools`);
// Codex's and OpenCode's run have only the desk's read tools: neither can hold a shell to gh's reads, so they have none.
const agentRun = () =>
  aiName() === "Claude" ? "your Claude Code, with read-only tools" : `your ${aiName()}, read only, with the desk's read tools and no shell`;

// What goes to the desk for a draft: the whole automation. A rule's verb is the one thing it may do.
function bodyOf(d: Draft): AutomationBody {
  const rule = d.decide === "rule" ? (d.rule ?? { do: "fyi" as const, why: "" }) : null;
  return {
    name: d.name,
    ...(d.schedule ? { schedule: d.schedule } : { events: d.events }),
    ...(d.when.trim() && { when: d.when.trim() }),
    decide: d.decide,
    ...(rule ? { rule, can: [rule.do] } : { prompt: d.prompt, can: d.can }),
    on: d.on,
  };
}

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

  // The whole automation each time: what a switch doesn't change goes back as it is. A plugin's is only switched.
  function turn(a: Auto, on: boolean): Effect.Effect<boolean> {
    if (!a.plugin) return put(a.id, bodyOf({ ...editing(a), on }), `${a.name} is ${on ? "on" : "off"}`);
    return Effect.suspend(() => {
      setBusy(true);
      return api.switchAutomation(a.id, on).pipe(
        Effect.andThen(() => {
          flash(`${a.name} is ${on ? "on" : "off"}`);
          return load();
        }),
        Effect.as(true),
        Effect.catch((e) => failed(e).pipe(Effect.as(false))),
        Effect.ensuring(idle),
      );
    });
  }

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

  // A new one's id is its name's, made free with -2, -3… so it never lands on one you have. Its id once it's saved, else null.
  function save(d: Draft, done?: string): Effect.Effect<string | null> {
    const base = d.id ?? slug(d.name);
    if (!base) {
      flash("Give it a name", true);
      return Effect.succeed(null);
    }
    let id = base;
    for (let n = 2; !d.id && list?.some((a) => a.id === id); n++) id = `${base.slice(0, 36)}-${n}`;
    return put(id, bodyOf(d), done ?? (d.id ? `Saved ${d.name}` : `Added ${d.name}`)).pipe(Effect.map((ok) => (ok ? id : null)));
  }

  // A plugin's, as one of yours to change: its definition, off until you turn it on; its view opens.
  const copy = (a: Auto) =>
    save({ ...editing(a), id: null, on: false }, `Copied ${a.name} to your automations, off`).pipe(
      Effect.tap((id) =>
        Effect.sync(() => {
          if (id) location.hash = viewOf(id);
        }),
      ),
    );

  return { list, error, busy, writing, setWriting, edits, keep, turn, runNow, remove, save, copy };
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

// A part's automation rows on its sheet: each its name (its view), when it runs (a plugin's: what it does) and its last run,
// Run now while it's on and its switch; an agent's draft has Review instead, so it can't run before its instruction has been
// on screen. `plugin`: that plugin's, which you don't write; else yours, ending in New automation.
export function AutomationRows({ au, now, plugin }: { au: Automations; now: number; plugin?: string }) {
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
  const list = au.list.filter((a) => a.plugin === plugin);
  if (plugin) return list.map((a) => <AutomationRow key={a.id} a={a} au={au} now={now} />);
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
  if (!list.length)
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
      {list.map((a) => (
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
              {a.help ?? timing} · {a.waiting ? "" : last.text}
              {a.waiting ? <span className="t-bad">waiting: {a.waiting.why}</span> : last.bad && <span className="t-bad">{last.bad}</span>}
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
export function NewAutomation({ au, model }: { au: Automations; model: string | null }) {
  if (!au.writing) return null;
  return (
    <div className="au-new">
      <Editor
        draft={au.writing}
        model={model}
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

// An automation's view (#/settings/automations/<id>): its name and what starts it, its instruction, then in plain words its
// check, how it decides and what it may do, what you can do with it (a plugin's: switch it, or copy it to yours), and its runs.
export function AutomationView({
  au,
  id,
  settingsPath,
  model,
  flash,
  onAsked,
}: {
  au: Automations;
  id: string;
  settingsPath: string | null; // settings.json's: the runs' folder is beside it, in the desk's home
  model: string | null; // the decision model that answers questions, once its key is set; else Claude does
  flash: (text: string, error?: boolean) => void;
  onAsked: () => void; // your agent has your words: its chat opens
}) {
  const draft = au.edits[id] ?? null;
  const [changing, setChanging] = useState(false);
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
  const resume = (session: string, agent: AutomationRun["agent"]) => {
    if (!settingsPath) return null;
    const cmd = resumeCommand(settingsPath, session, agent);
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
      {a.help && <p className="s-view-line">{a.help}</p>}
      <p className="s-view-line">{line}</p>
      <div className="au-view">
        {draft ? (
          <Editor
            draft={draft}
            model={model}
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
            {a.prompt && <p className="au-prompt">{a.prompt}</p>}
            <Facts a={a} model={model} />
            {a.waiting && (
              <p className="au-note t-bad">
                Waiting: {a.waiting.why} It asks again at {when(a.waiting.until)}; nothing was spent.
              </p>
            )}
            <div className="actions">
              {agents ? (
                <button type="button" className="act primary" disabled={au.busy} onClick={turn(true)}>
                  Turn on
                </button>
              ) : !a.schedule && !a.when && a.decide ? null : (
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
              {a.plugin ? (
                <button
                  type="button"
                  className="act"
                  disabled={au.busy}
                  onClick={() => {
                    runUi(au.copy(a));
                  }}
                >
                  Copy to your automations
                </button>
              ) : (
                <button
                  type="button"
                  className="act"
                  onClick={() => {
                    setDraft(editing(a));
                  }}
                >
                  Edit
                </button>
              )}
              {!agents && (
                <button type="button" className="act" disabled={au.busy} onClick={turn(!a.on)}>
                  {a.on ? "Turn off" : "Turn on"}
                </button>
              )}
              {!changing && (
                <button
                  type="button"
                  className="act"
                  onClick={() => {
                    setChanging(true);
                  }}
                >
                  Change with your agent
                </button>
              )}
            </div>
            {changing && (
              <AskChange
                ask={(words) => changeAsk({ kind: "automation", id: a.id, name: a.name, builtIn: !!a.plugin }, words)}
                onSent={onAsked}
                onClose={() => {
                  setChanging(false);
                }}
                flash={flash}
              />
            )}
          </>
        )}
      </div>
      <h2 className="group-head au-runs-head">Runs</h2>
      {a.runs.length ? <Runs a={a} resume={resume} /> : <p className="s-view-line">It hasn&rsquo;t run yet.</p>}
    </>
  );
}

// What an automation is, in a few plain lines: its check, how it decides, what it may do.
function Facts({ a, model }: { a: Auto; model: string | null }) {
  const way = a.decide ?? "agent";
  const rule = a.rule;
  const decides =
    way === "rule" && rule
      ? `A rule, with no model: ${VERB[rule.do]}${rule.do === "snooze" ? ` until ${untilWords(rule.until)}` : ""}, saying \u201c${rule.why}\u201d`
      : way === "ask"
        ? `A question: ${answers(model)}`
        : `An agent: ${agentRun()}.`;
  return (
    <dl className="au-facts">
      {a.when && (
        <>
          <dt>Only when</dt>
          <dd>
            <code>{a.when}</code>
          </dd>
        </>
      )}
      <dt>Decides</dt>
      <dd>{decides}</dd>
      {way !== "rule" && (
        <>
          <dt>May</dt>
          <dd>{cap(mayText(a.can ?? ["add"]))}</dd>
        </>
      )}
    </dl>
  );
}

// Each run: when, what it found, and what came of each item; its session one click from your clipboard.
function Runs({ a, resume }: { a: Auto; resume: (session: string, agent: AutomationRun["agent"]) => ReactNode }) {
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
            {r.session && resume(r.session, r.agent)}
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
  model,
  busy,
  onChange,
  onSave,
  onCancel,
  onDelete,
}: {
  draft: Draft;
  model: string | null; // the decision model that answers questions, once its key is set
  busy: boolean;
  onChange?: (d: Draft) => void; // where it's kept while you write
  onSave: (d: Draft) => void;
  onCancel: () => void;
  onDelete: (() => void) | null;
}) {
  const [d, setDraft] = useState(draft);
  // What the other way of starting it held, so switching there and back loses nothing.
  const [other, setOther] = useState({ schedule: draft.schedule || "weekdays 09:00", events: draft.events });
  const setD = (next: Draft) => {
    setDraft(next);
    onChange?.(next);
  };
  const onEvents = d.schedule === "";
  const rule = d.rule ?? { do: "fyi" as const, why: "" };
  const starts = onEvents ? d.events.length > 0 : !!d.schedule.trim();
  const says = d.decide === "rule" ? !!rule.why.trim() : !!d.prompt.trim() && d.can.length > 0;
  // A rule or a question is about items: its events', or on a schedule the ones its check passes.
  const needsCheck = d.decide !== "agent" && !onEvents && !d.when.trim();
  const ready = !!d.name.trim() && starts && says && !needsCheck;
  // ⌘S or ⌘↵ saves from any field, Esc leaves it as it was.
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") onCancel();
    else if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "Enter")) {
      e.preventDefault();
      if (ready) onSave(d);
    }
  };
  const tick = <T extends string>(list: T[], v: T, on: boolean, order: readonly T[]) =>
    order.filter((x) => (x === v ? on : list.includes(x)));
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
      <fieldset className="au-field">
        <legend className="s-label">Runs</legend>
        <div className="au-line">
          <select
            className="input choice"
            aria-label="What starts it"
            value={onEvents ? "events" : "schedule"}
            onKeyDown={keys}
            onChange={(e) => {
              setOther({ schedule: d.schedule || other.schedule, events: d.events });
              setD(
                e.target.value === "events" ? { ...d, schedule: "", events: other.events } : { ...d, schedule: other.schedule, events: [] },
              );
            }}
          >
            <option value="schedule">On a schedule</option>
            <option value="events">When something happens</option>
          </select>
          {!onEvents && (
            <input
              className="input"
              aria-label="Schedule"
              value={d.schedule}
              placeholder="weekdays 09:00"
              onKeyDown={keys}
              onChange={(e) => {
                // Emptied, it's still a schedule: a space keeps it from reading as events.
                setD({ ...d, schedule: e.target.value || " " });
              }}
            />
          )}
        </div>
        {onEvents ? (
          <>
            <div className="au-checks">
              {ACTIVITY_KINDS.map((k) => (
                <label key={k} className="au-check">
                  <input
                    type="checkbox"
                    checked={d.events.includes(k)}
                    onChange={(e) => {
                      setD({ ...d, events: tick<ActivityKind>(d.events, k, e.target.checked, ACTIVITY_KINDS) });
                    }}
                  />
                  {cap(EVENT[k])}
                </label>
              ))}
            </div>
            <span className="s-help">Once for the items a sync brings these on, and never twice at once.</span>
          </>
        ) : (
          <span className="s-help">Local time: daily 09:00, weekdays 09:00,13:00, mon,thu 17:30 or weekdays hourly.</span>
        )}
      </fieldset>
      <label className="au-field">
        <span className="s-label">Only when</span>
        <input
          className="input au-code"
          value={d.when}
          placeholder="me.requested_direct && pr.ci == 'red'"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onKeyDown={keys}
          onChange={(e) => {
            setD({ ...d, when: e.target.value });
          }}
        />
        <span className={cls("s-help", needsCheck && "s-ink")}>
          {needsCheck
            ? `${WAY[d.decide].name === "A rule" ? "A rule" : "A question"} on a schedule needs a check: the items it's about.`
            : "A check the desk asks of each item first, written like a rule's (Searches and rules lists the fields). Only what passes is handed on; empty, there's none."}
        </span>
      </label>
      <fieldset className="au-field">
        <legend className="s-label">How it decides</legend>
        <div className="au-line">
          <select
            className="input choice"
            aria-label="How it decides"
            value={d.decide}
            onKeyDown={keys}
            onChange={(e) => {
              setD({ ...d, decide: e.target.value as Way });
            }}
          >
            {(["rule", "ask", "agent"] as const).map((w) => (
              <option key={w} value={w}>
                {WAY[w].name}
              </option>
            ))}
          </select>
        </div>
        <span className="s-help">
          {WAY[d.decide].help}
          {d.decide === "ask" && ` ${cap(answers(model))}.`}
        </span>
      </fieldset>
      {d.decide === "rule" ? (
        <fieldset className="au-field">
          <legend className="s-label">Then</legend>
          <div className="au-line">
            <select
              className="input choice"
              aria-label="What it does"
              value={rule.do}
              onKeyDown={keys}
              onChange={(e) => {
                const verb = e.target.value as Verb;
                const { until: _, ...kept } = rule;
                setD({ ...d, rule: { ...kept, do: verb, ...(verb === "snooze" && { until: rule.until ?? "tomorrow" }) } });
              }}
            >
              {VERBS.map((v) => (
                <option key={v} value={v}>
                  {cap(VERB[v])}
                </option>
              ))}
            </select>
            {rule.do === "snooze" && (
              <>
                <span className="s-unit">until</span>
                <select
                  className="input choice"
                  aria-label="Until"
                  value={rule.until ?? "tomorrow"}
                  onKeyDown={keys}
                  onChange={(e) => {
                    setD({ ...d, rule: { ...rule, until: e.target.value } });
                  }}
                >
                  {UNTILS.map(([k, words]) => (
                    <option key={k} value={k}>
                      {words}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
          <input
            className="input"
            aria-label="Why, as the item shows it"
            value={rule.why}
            maxLength={300}
            placeholder="Why, as the item shows it: CI is red, back when it passes"
            onKeyDown={keys}
            onChange={(e) => {
              setD({ ...d, rule: { ...rule, why: e.target.value } });
            }}
          />
        </fieldset>
      ) : (
        <>
          <label className="au-field">
            <span className="s-label">Instruction</span>
            <textarea
              className="editor prose"
              value={d.prompt}
              maxLength={8000}
              onKeyDown={keys}
              placeholder={
                d.decide === "ask"
                  ? "A ping to my whole team that isn't about the config loader is FYI. One that is, I want today."
                  : "Look at the issues opened or active in getsentry/warden and getsentry/dotagents since the last run. Put on my desk the ones that need me: a regression, a question to me, a PR that touches what I own. Nothing needs me? Say so."
              }
              onChange={(e) => {
                setD({ ...d, prompt: e.target.value });
              }}
            />
            <span className="s-help">
              {d.decide === "ask"
                ? "In your words: what should happen to which items. It answers for each item, or leaves it as it is."
                : `${aiName() === "Claude" ? "Your own Claude Code runs it read only, with your tools" : `Your own ${aiName()} runs it read only, with the desk's read tools and no shell`}; it lists PRs and issues with a line on why, and the desk does with them what you allow below.`}
            </span>
          </label>
          <fieldset className="au-field">
            <legend className="s-label">It may</legend>
            <div className="au-checks">
              {VERBS.map((v) => (
                <label key={v} className="au-check">
                  <input
                    type="checkbox"
                    checked={d.can.includes(v)}
                    onChange={(e) => {
                      setD({ ...d, can: tick<Verb>(d.can, v, e.target.checked, VERBS) });
                    }}
                  />
                  {cap(VERB[v])}
                </label>
              ))}
            </div>
            <span className="s-help">
              What the desk does with what it lists; anything else is refused. A sort holds until the item changes; a snooze, done or mute
              can be undone.
            </span>
          </fieldset>
        </>
      )}
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
