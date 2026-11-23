// Rendered from the schema in GET /api/settings: a new entry in SETTINGS (src/settings.ts) needs no change here.
import { SETTINGS_PARTS } from "../settings-parts.ts";
import { McpServers } from "./McpServers.tsx";
import { Effect } from "effect";
import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AgentStatus, DesktopBridge, GitHubStatus, JudgeStatus, SettingDef, SettingsView, SettingValue } from "../../../src/types.ts";
import { api, runUi } from "../api.ts";
import { useKeyed } from "../keyed.ts";
import { aiName, cls, githubTip, MAC, orgsLine } from "../format.ts";
import { AutomationRows, AutomationView, NewAutomation, useAutomations } from "./Automations.tsx";
import { Usage } from "./Usage.tsx";
import { Criteria } from "./Criteria.tsx";
import { Rules, type RuleFocus } from "./Rules.tsx";
import { withCode } from "./Prose.tsx";
import { SkLines } from "./Skeleton.tsx";
import { SourceLine } from "./Source.tsx";
import { BY_KEY, ChoiceField, CONTROLS, StringField } from "./SettingFields.tsx";
import { RemoteRows } from "./Remote.tsx";
import {
  authProblem,
  automationOf,
  DISABLED,
  draftOf,
  hotkeyHelp,
  judgeStatusText,
  onePause,
  routeHash,
  SETTINGS_VIEWS,
  settingsBack,
  SHOWN,
} from "../view.ts";
import { applyTheme, desktop, isThemeId, omarchyName, omarchyTheme, onOmarchy, savedTheme, THEME_GROUPS, type ThemeId } from "../theme.ts";

type DesktopStatus = Awaited<ReturnType<DesktopBridge["status"]>>;
function Row({
  def,
  view,
  loads,
  onView,
  extra,
  help,
  disabled = false,
}: {
  def: SettingDef;
  view: SettingsView;
  loads: number; // bumped on every refresh: the desk answering again
  onView: (v: SettingsView) => void;
  extra?: ReactNode;
  help?: { text: string; bad: boolean } | null; // a live line in place of the def's help: null keeps the def's
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
  useKeyed(loads, () => {
    if (!away.current) return;
    away.current = false;
    setStatus(null);
    setEpoch((n) => n + 1);
  });

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
  const Control = BY_KEY[def.key] ?? (def.choices?.length ? ChoiceField : CONTROLS[def.type]) ?? StringField;
  const control = (
    <Control
      key={epoch}
      id={id}
      def={def}
      value={view.values[def.key] ?? (typeof def.default === "object" ? [...def.default] : def.default)}
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
  const wide = def.type === "text" || (def.type === "string" && !def.pattern && !def.choices?.length);
  const said = help ?? (def.help ? { text: def.help, bad: false } : null);

  return (
    <div id={`row-${def.key}`} className={cls("setting", `st-${def.type}`, wide && "wide", disabled && "s-off")}>
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
  useKeyed(active ? loads : null, (signal) => {
    // Not answering: what's shown stays, and the next refresh asks again.
    runUi(api.agents().pipe(Effect.map(setStatus), Effect.ignore), { signal });
  });

  const need = status?.needs;
  const say = need && needs(status.driver === "codex" ? "Codex" : status.driver === "opencode" ? "OpenCode" : "Claude Code")[need];

  function connect() {
    setBusy(true);
    setError(null);
    runUi(
      api.connectAgent().pipe(
        Effect.tap((s) =>
          Effect.sync(() => {
            if (say && !s.needs) flash(s.note ? `${s.note}.` : say.done);
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
              {error ? `${say.failed}: ${error}` : status.note ? `${status.note}.` : say.help}
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
          the sorting fails for the same reason, this says it for both, and the sorting switch doesn't again. */}
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

// Appearance's row, not from the schema: the theme is this device's, so it's kept here, not on the desk. Omarchy
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
            const t = e.target.value;
            if (!isThemeId(t)) return;
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

// What a part's lookups get: the page's state.
interface PartProps {
  view: SettingsView;
  active: boolean;
  now: number;
  loads: number;
  configErrors: number;
  flash: (text: string) => void;
}

// Rows a part's sheet starts with, before its settings', by the part's id: a plugin's part adds one entry.
const LEAD: Record<string, (p: PartProps) => ReactNode> = {
  // Every device's own: in the browser too, where the rest of This device is the desktop app's.
  app: () => <ThemeRow />,
  github: (p) => (
    <>
      <GitHubStatusRow gh={p.view.github} />
      <ViewRow
        id="rules"
        {...(p.configErrors > 0 && { tone: "bad" })}
        help={
          p.configErrors > 0
            ? `${p.configErrors} ${p.configErrors === 1 ? "error" : "errors"} in your rules`
            : (orgsLine(p.view.github.orgs, p.view.github.catch_all) ?? "Which GitHub searches feed your desk, and where each item starts.")
        }
      />
    </>
  ),
};

// Rows after a setting's own, by its key: the sorting's failure under the switch that turns it on.
const AFTER: Record<string, (p: PartProps) => ReactNode> = {
  "app.tailscale": (p) => (
    <RemoteRows active={p.active} loads={p.loads} on={p.view.values["app.tailscale"] === true} now={p.now} flash={p.flash} />
  ),
  // The agent's own status under its name, and only while something needs you.
  "agent.harness": (p) => (
    <ClaudeStatus active={p.active} loads={p.loads} paused={p.view.paused.ai} judge={p.view.judge} now={p.now} flash={p.flash} />
  ),
  "policy.judge": ({ view, now }) => {
    // Its failure, unless it's the one the agent's status already says for the AI reviews too.
    if (view.judge.state !== "error" || onePause(view.paused.ai, view.judge)) return null;
    return (
      <div className="setting s-status">
        <div className="s-label-col">
          <p className="s-label">Sorting failed</p>
          {/* An agent's failure, in ink: it's about Claude, not your work. */}
          <p className="s-help s-ink">{withCode(judgeStatusText(view.judge, now))}</p>
        </div>
      </div>
    );
  },
};

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
  onAsked,
  ruleFocus,
}: {
  active: boolean;
  section: string; // a part's id (automations: yours), or a view's (rules, automations/<id>)
  view: SettingsView | null;
  now: number;
  loads: number;
  configErrors: number; // the saved rules' errors, for Searches and rules' row
  onView: (v: SettingsView) => void;
  flash: (text: string, error?: boolean) => void;
  onRulesSaved: () => void;
  onRulesDirty: (dirty: boolean) => void;
  onAsked: () => void; // your agent has your words about an automation or a criterion: its chat opens
  ruleFocus: RuleFocus | null; // a row's "See the rule that put it here": Rules shows that rule
}) {
  const [live, setLive] = useState<DesktopStatus | null>(null);
  const inView = settingsBack(section) !== null;
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

  // A part or a view opens at its top.
  const ready = view !== null;
  useKeyed(active && ready ? section : null, () => {
    window.scrollTo({ top: 0 });
  });

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

  const row = (d: SettingDef | undefined) =>
    view &&
    d && (
      <Row
        key={d.key}
        def={d}
        view={view}
        loads={loads}
        onView={onView}
        disabled={DISABLED[d.key]?.(view.values) ?? false}
        {...(d.type === "hotkey" && { help: hotkeyHelp(String(view.values[d.key] ?? d.default), live?.hotkey ?? null, MAC) })}
        extra={d.key === "app.source" && live && <SourceLine s={live.source ?? null} />}
      />
    );

  return (
    <div className="settings" hidden={!active}>
      <div className="s-page" hidden={inView || section === "automations" || section === "usage" || section === "mcp"}>
        {!view && (
          <section className="s-part s-skel" aria-busy="true" aria-label="Loading">
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
          const p: PartProps = { view, active, now, loads, configErrors, flash };
          const defs = view.defs.filter((d) => d.section === x.id && (SHOWN[d.key]?.(view.values, desktop) ?? true));
          const tuning = defs.filter((d) => d.more);
          const lead = LEAD[x.id];
          return (
            <section key={x.id} id={`s-${x.id}`} className="s-part" aria-label={x.title} hidden={section !== (x.part ?? x.id)}>
              {x.part && <h2 className="group-head">{x.title}</h2>}
              {(x.id === "app" || x.id === "tailscale") && lead === undefined && !defs.length && (
                <p className="quiet-note">{x.title}'s settings are the desktop app's: open Inbox's app to change them.</p>
              )}
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
                </div>
              )}
              {/* Tuning and prompts: a section of their own under the part's, always open. */}
              {tuning.length > 0 && (
                <>
                  <h2 className="group-head">More {x.title} settings</h2>
                  <div className="lines s-sheet">{tuning.map((d) => row(d))}</div>
                </>
              )}
              {SETTINGS_PARTS.some((s) => s.plugin && s.automations !== false && s.id === x.id) && (
                <>
                  <h2 className="group-head">Automations</h2>
                  <div className="lines s-sheet">
                    <AutomationRows au={au} now={now} plugin={x.id} />
                  </div>
                </>
              )}
            </section>
          );
        })}
      </div>
      {/* The parts and the views stay mounted, so an unsaved draft in any survives leaving it and coming back. */}
      <div className="s-page" hidden={section !== "automations"}>
        <section id="s-automations" className="s-part" aria-label="Your automations">
          <h2 className="group-head">Your automations</h2>
          <div className="lines s-sheet">
            <AutomationRows au={au} now={now} />
          </div>
          <NewAutomation au={au} model={decisionModel} />
        </section>
        <section id="s-criteria" className="s-part" aria-label="Urgency">
          <h2 className="group-head">Urgency</h2>
          <Criteria active={active && section === "automations"} refresh={loads} now={now} flash={flash} onAsked={onAsked} />
        </section>
      </div>
      <div className="s-page" hidden={section !== "mcp"}>
        <section id="s-mcp" className="s-part" aria-label="MCP servers">
          <McpServers active={active && section === "mcp"} refresh={loads} flash={flash} />
        </section>
      </div>
      <div className="s-page" hidden={section !== "usage"}>
        <section id="s-usage" className="s-part" aria-label="Usage">
          <Usage active={active && section === "usage"} refresh={loads} />
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
          focus={ruleFocus}
        />
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
            onAsked={onAsked}
          />
        )}
      </section>
    </div>
  );
}
