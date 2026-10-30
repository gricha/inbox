import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Action, Card, DesktopBridge, ItemDetail, Overview, QueueView, SettingsView } from "../../src/types.ts";
import { api, message, starting, unreachable } from "./api.ts";
import { cls, copyText, shortId, shortRef, SNOOZE } from "./format.ts";
import { DEFAULT_OPEN, groupsOf, navigable, parseRoute, removeCard, routeHash, type GroupKey, type Route } from "./view.ts";
import type { RowCtx } from "./components/CardRow.tsx";
import { Help } from "./components/Help.tsx";
import { Queue } from "./components/Queue.tsx";
import { Settings } from "./components/Settings.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TopBar } from "./components/TopBar.tsx";

interface Toast {
  id: number;
  text: string;
  error?: boolean;
  undo?: boolean;
}

const OPEN_KEY = "desk.groups";
const LEAVES = new Set<Action>(["done", "snooze", "mute"]);
const VERB: Partial<Record<Action, string>> = {
  done: "Done",
  mute: "Muted",
  unmute: "Unmuted",
  pin: "Pinned",
  unpin: "Unpinned",
  restore: "Restored",
};
const sleep = (ms: number) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });
const go = (r: Route) => {
  location.hash = routeHash(r);
};
const UNREACHABLE = "unreachable";
const CHORDS: Record<string, Route> = {
  r: { name: "settings", section: "rules" },
  s: { name: "settings", section: "github" },
  q: { name: "queue" },
};
const AWAY_KEYS: Record<string, GroupKey> = { l: "later", f: "fyi", d: "resolved", h: "hidden", x: "cleared" };
const configBroken = (msg: string | null) => !!msg && msg.startsWith("config has errors");
const desktop = (window as Window & { desktop?: DesktopBridge }).desktop;

// The desktop app's window needs room for the macOS traffic lights and a draggable title bar.
if (desktop) {
  document.documentElement.dataset.shell = "desktop";
  document.documentElement.dataset.platform = desktop.platform;
}

function loadOpen(): Record<GroupKey, boolean> {
  try {
    const saved = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}") as Partial<Record<GroupKey, boolean>>;
    return { ...DEFAULT_OPEN, ...saved, now: true, today: true };
  } catch {
    return DEFAULT_OPEN;
  }
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const [overview, setOverview] = useState<Overview | null>(null);
  const [view, setView] = useState<QueueView | null>(null);
  const [down, setDown] = useState<string | null>(null); // why the API isn't usable right now
  const [epoch, setEpoch] = useState(0); // bumped to reopen the event stream
  const [now, setNow] = useState(() => Date.now());
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, ItemDetail | string>>({});
  const [showSignals, setShowSignals] = useState(false);
  const [snoozeFor, setSnoozeFor] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState<Set<string>>(new Set());
  const [briefErrors, setBriefErrors] = useState<Record<string, string>>({});
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(loadOpen);
  const [filter, setFilter] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const [help, setHelp] = useState(false);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [section, setSection] = useState(route.name === "settings" ? route.section : "github"); // kept while on the queue
  const [settingsSeen, setSettingsSeen] = useState(route.name === "settings");
  const [loads, setLoads] = useState(0); // bumped on every refresh, so Rules can re-read a file changed on disk
  const [tick, setTick] = useState(0); // bumped when an undo's hold on the selection runs out
  const rulesDirty = useRef(false);

  const filterRef = useRef<HTMLInputElement>(null);
  const routeRef = useRef(route);
  routeRef.current = route;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const downRef = useRef(down);
  downRef.current = down;
  const loadSeq = useRef(0);
  const refreshTimer = useRef(0);
  const toastTimer = useRef(0);
  const undoSeq = useRef<number | null>(null);
  const lastIndex = useRef(0);
  const settingsSeq = useRef(0); // a GET that started before a save must not undo it
  const gAt = useRef(0);
  // An id we just asked for (e.g. after undo) that the next refresh will bring back.
  const pending = useRef<{ id: string; until: number } | null>(null);

  const flash = useCallback((text: string, error = false, canUndo = false) => {
    clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), text, error, undo: canUndo });
    toastTimer.current = window.setTimeout(() => {
      setToast(null);
    }, 6000);
  }, []);

  const saveSettingsView = useCallback((s: SettingsView) => {
    settingsSeq.current++;
    setSettings(s);
  }, []);

  const loadSettings = useCallback(async () => {
    const sn = ++settingsSeq.current;
    try {
      const s = await api.settings();
      if (sn === settingsSeq.current) setSettings(s);
    } catch {}
  }, []);

  const load = useCallback(async () => {
    const r = routeRef.current;
    const exp = expandedRef.current;
    const n = ++loadSeq.current;
    if (r.name === "settings") void loadSettings();
    try {
      const [ov, v, d] = await Promise.all([
        api.overview(),
        // Always: the sidebar shows the queue's counts on every page.
        api.queue(),
        exp ? api.item(exp).catch((e: unknown) => message(e)) : null,
      ]);
      if (n !== loadSeq.current) return;
      setOverview(ov);
      setNow(Date.now());
      setLoads((x) => x + 1);
      // The dev proxy keeps a dead upstream's event stream open, so reopen it once the API answers again.
      if (downRef.current) setEpoch((x) => x + 1);
      setDown(null);
      setView(v);
      if (exp && d) setDetails((m) => ({ ...m, [exp]: d }));
    } catch (e) {
      if (n !== loadSeq.current) return;
      if (unreachable(e)) setDown(UNREACHABLE);
      else if (starting(e)) setDown(message(e));
      else flash(message(e), true);
    }
  }, [flash, loadSettings]);

  const refresh = useCallback(
    (ms = 300) => {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        void load();
      }, ms);
    },
    [load],
  );

  useEffect(() => {
    const on = () => {
      setRoute(parseRoute(location.hash));
    };
    window.addEventListener("hashchange", on);
    return () => {
      window.removeEventListener("hashchange", on);
    };
  }, []);

  const settingsSection = route.name === "settings" ? route.section : null;
  useEffect(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setExpanded(null);
    setSnoozeFor(null);
    if (settingsSection !== null) {
      setSection(settingsSection);
      setSettingsSeen(true);
      window.scrollTo(0, 0);
    } else if (rulesDirty.current) flash("Your rule edits are kept. Save them in Settings → Rules.");
    void load();
  }, [settingsSection, flash, load]);

  // Live updates; EventSource gives up after a non-200 (e.g. the dev proxy while the server is down), so reconnect by hand.
  useEffect(() => {
    let es: EventSource | null = null;
    let retry = 0;
    const connect = () => {
      es = new EventSource("/api/events");
      es.addEventListener("update", () => {
        refresh();
      });
      es.addEventListener("open", () => {
        refresh();
      });
      es.addEventListener("error", () => {
        // While the browser retries, the stream sits in CONNECTING; a fetch tells us whether the server is gone.
        refresh(0);
        if (es?.readyState !== EventSource.CLOSED) return;
        setDown((d) => d ?? UNREACHABLE);
        retry = window.setTimeout(connect, 5000);
      });
    };
    connect();
    const visible = () => {
      if (document.visibilityState === "visible") refresh(0);
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      es?.close();
      clearTimeout(retry);
      document.removeEventListener("visibilitychange", visible);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- bumping epoch is how a dead stream gets reopened
  }, [refresh, epoch]);

  useEffect(() => {
    const t = down
      ? setInterval(() => {
          void load();
        }, 5000)
      : undefined;
    return () => {
      clearInterval(t);
    };
  }, [down, load]);

  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
    }, 15_000);
    return () => {
      clearInterval(t);
    };
  }, []);

  const groups = useMemo(() => groupsOf(view, open, filter), [view, open, filter]);
  const flat = useMemo(() => navigable(groups, leaving), [groups, leaving]);
  const current = flat.find((c) => c.id === selected) ?? null;

  // Keep the selection by id across refreshes; if its card is gone, take whatever now sits at its old position.
  useEffect(() => {
    if (!flat.length) return;
    const i = flat.findIndex((c) => c.id === selected);
    if (i >= 0) {
      lastIndex.current = i;
      return;
    }
    if (pending.current && pending.current.id === selected && Date.now() < pending.current.until) return;
    const next = flat[Math.min(lastIndex.current, flat.length - 1)];
    if (next) setSelected(next.id);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- tick re-checks once the undo hold has run out
  }, [flat, selected, tick]);

  useEffect(() => {
    if (selected && route.name === "queue")
      document.querySelector(`[data-id="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: "nearest" });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- filtering moves rows, so scroll the selection back into view
  }, [selected, filter, route.name]);

  const boards = useMemo(() => overview?.spaces.flatMap((s) => s.boards.map((b) => ({ ...b, spaceName: s.name }))) ?? [], [overview]);
  const boardLabel = useCallback(
    (id: string) => {
      const b = boards.find((x) => x.id === id);
      if (!b) return id;
      return boards.filter((x) => x.name === b.name).length > 1 ? `${b.name} (${b.spaceName})` : b.name;
    },
    [boards],
  );

  async function fetchDetail(id: string): Promise<ItemDetail | null> {
    try {
      const d = await api.item(id);
      setDetails((m) => ({ ...m, [id]: d }));
      return d;
    } catch (e) {
      setDetails((m) => ({ ...m, [id]: message(e) }));
      return null;
    }
  }

  async function seen(c: Card) {
    if (!c.new) return;
    try {
      await api.act(c.id, "seen");
      refresh();
    } catch {}
  }

  function toggle(c: Card) {
    setSelected(c.id);
    setSnoozeFor(null);
    if (expanded === c.id) {
      setExpanded(null);
      return;
    }
    setExpanded(c.id);
    setShowSignals(false);
    void fetchDetail(c.id);
    void seen(c);
  }

  async function act(c: Card, action: Action, until?: string) {
    setSnoozeFor(null);
    // A resolved item stays under Resolved whatever you do to it.
    const leaves = LEAVES.has(action) && c.status === "active" && !c.resolved;
    if (leaves) {
      const i = flat.findIndex((x) => x.id === c.id);
      setSelected((flat[i + 1] ?? flat[i - 1])?.id ?? null);
      if (expanded === c.id) setExpanded(null);
      setLeaving((s) => new Set(s).add(c.id));
    }
    try {
      const started = Date.now();
      const res = await api.act(c.id, action, until);
      undoSeq.current = res.undo_seq || null; // before the animation, so a quick u undoes this action
      if (leaves) {
        await sleep(Math.max(0, 200 - (Date.now() - started)));
        setView((v) => v && removeCard(v, c.id));
      }
      const verb = action === "snooze" ? `Snoozed ${SNOOZE.find((o) => o.until === until)?.toast ?? ""}` : VERB[action];
      flash(`${verb}: ${shortRef(c)}`, false, true);
    } catch (e) {
      flash(message(e), true);
    } finally {
      if (leaves)
        setLeaving((s) => {
          const next = new Set(s);
          next.delete(c.id);
          return next;
        });
      refresh(0);
    }
  }

  async function undo() {
    // Only what this window did: a stray u must not walk back yesterday's history.
    if (undoSeq.current === null) {
      flash("Nothing to undo in this window");
      return;
    }
    try {
      const r = await api.undo(undoSeq.current);
      undoSeq.current = null;
      pending.current = { id: r.id, until: Date.now() + 2000 };
      setSelected(r.id);
      // If the item comes back into a closed group, let the selection move on once the wait is over.
      setTimeout(() => {
        setTick((t) => t + 1);
      }, 2100);
      flash(`Undid ${r.action ?? "that"} on ${shortId(r.id)}`);
      refresh(0);
    } catch (e) {
      flash(message(e), true);
    }
  }

  async function sync() {
    setOverview((o) => o && { ...o, syncing: true });
    try {
      await api.sync();
    } catch (e) {
      if (!unreachable(e)) flash(message(e), true);
    }
    refresh(0);
  }

  async function copy(c: Card) {
    const cached = details[c.id];
    const d = typeof cached === "object" ? cached : await fetchDetail(c.id);
    if (!d) {
      flash("Couldn't load the prompt", true);
      return;
    }
    try {
      await copyText(d.handoff_prompt);
      flash("Prompt copied. Paste it into a Claude session.");
    } catch (e) {
      flash(`Couldn't copy: ${message(e)}`, true);
    }
  }

  async function brief(c: Card) {
    if (c.kind !== "pr") {
      flash("Briefs are for pull requests", true);
      return;
    }
    if (analyzing.has(c.id)) return;
    setAnalyzing((s) => new Set(s).add(c.id));
    setBriefErrors((m) => {
      const next = { ...m };
      delete next[c.id];
      return next;
    });
    if (expanded !== c.id) toggle(c);
    try {
      const d = details[c.id];
      const r = await api.analyze(c.id, typeof d === "object" && d.brief !== null);
      flash(`Brief for ${shortRef(c)}: ${r.brief.verdict}`);
      void fetchDetail(c.id);
    } catch (e) {
      setBriefErrors((m) => ({ ...m, [c.id]: message(e) }));
      flash(`Brief failed for ${shortRef(c)}: ${message(e)}`, true);
    } finally {
      setAnalyzing((s) => {
        const next = new Set(s);
        next.delete(c.id);
        return next;
      });
    }
  }

  function run(c: Card, k: string) {
    if (k === "o") {
      window.open(c.url, "_blank", "noopener,noreferrer");
      void seen(c);
    } else if (k === "e") void act(c, c.status === "active" ? "done" : "restore");
    else if (k === "s") {
      setSelected(c.id);
      setSnoozeFor(c.id);
    } else if (k === "m") void act(c, c.status === "muted" ? "unmute" : "mute");
    else if (k === "p") void act(c, c.pinned ? "unpin" : "pin");
    else if (k === "c") void copy(c);
    else if (k === "i") void brief(c);
    else if (k === "w") {
      if (expanded === c.id) setShowSignals((s) => !s);
      else {
        toggle(c);
        setShowSignals(true);
      }
    }
  }

  function move(d: number) {
    if (!flat.length) return;
    // A clicked link or button keeps focus and would take the next Enter.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const i = flat.findIndex((c) => c.id === selected);
    const next = flat[i < 0 ? 0 : Math.max(0, Math.min(flat.length - 1, i + d))];
    if (next) setSelected(next.id);
  }

  function toggleGroup(k: GroupKey) {
    setOpen((o) => {
      const next = { ...o, [k]: !o[k] };
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }

  const onKey = (e: KeyboardEvent) => {
    const t = e.target instanceof HTMLElement ? e.target : document.body;
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    // Holding a key must not mark card after card done; only movement repeats.
    if (e.repeat && !["j", "k", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    if (t.closest("input, textarea, select, [contenteditable='true']")) return;
    // Buttons keep their own Enter/Space, except a card's own row button: Enter there means the selected card.
    if ((e.key === "Enter" || e.key === " ") && t.closest("button, a, summary") && !t.classList.contains("row-main")) return;
    const k = e.key;
    if (help) {
      if (k === "Escape" || k === "?") setHelp(false);
      return;
    }
    if (snoozeFor) {
      const o = SNOOZE.find((x) => x.key === k);
      const c = flat.find((x) => x.id === snoozeFor);
      if (!c)
        setSnoozeFor(null); // its card left the list; don't hold the keyboard
      else {
        if (o) void act(c, "snooze", o.until);
        else if (k === "Escape" || k === "s") setSnoozeFor(null);
        e.preventDefault();
        return;
      }
    }
    if (Date.now() - gAt.current < 1200) {
      gAt.current = 0;
      if (CHORDS[k]) {
        go(CHORDS[k]);
        return;
      }
      if (AWAY_KEYS[k] && route.name === "queue") {
        toggleGroup(AWAY_KEYS[k]);
        return;
      }
    }
    if (k === "g") gAt.current = Date.now();
    else if (k === "?") setHelp(true);
    else if (k === ",") go({ name: "settings", section: "github" });
    else if (k === "r") void sync();
    else if (k === "u") void undo();
    else if (route.name === "settings") {
      if (k === "Escape") go({ name: "queue" });
    } else if (k === "/") {
      e.preventDefault();
      filterRef.current?.focus();
    } else if (k === "Escape") {
      if (expanded) setExpanded(null);
      else if (filter) setFilter("");
    } else if (k === "j" || k === "ArrowDown" || k === "k" || k === "ArrowUp") {
      e.preventDefault();
      move(k === "j" || k === "ArrowDown" ? 1 : -1);
    } else if (k === "Enter" && current) {
      e.preventDefault();
      toggle(current);
    } else if (current && k.length === 1 && "oesmpcwi".includes(k)) {
      e.preventDefault();
      run(current, k);
    }
  };
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      keyRef.current(e);
    };
    window.addEventListener("keydown", h);
    return () => {
      window.removeEventListener("keydown", h);
    };
  }, []);

  const ctx: RowCtx = {
    now,
    me: overview?.me ?? "",
    selected,
    expanded,
    leaving,
    snoozeFor,
    showSignals,
    details,
    analyzing,
    briefErrors,
    boardLabel,
    click: toggle,
    select: (c) => {
      setSelected(c.id);
    },
    run,
    snooze: (c, until) => {
      void act(c, "snooze", until);
    },
    closeSnooze: () => {
      setSnoozeFor(null);
    },
    restore: (c) => {
      void act(c, "restore");
    },
  };
  const configErrors = overview?.config_errors.length ?? 0;
  const broken = configBroken(down);

  return (
    <div className="app">
      <Sidebar route={route} view={view} inert={help} />
      <div className="col">
        <TopBar
          overview={overview}
          offline={down === UNREACHABLE}
          now={now}
          route={route}
          filter={filter}
          setFilter={setFilter}
          filterRef={filterRef}
          onSync={() => {
            void sync();
          }}
          onHelp={() => {
            setHelp(true);
          }}
          inert={help}
        />
        <main className="main" inert={help}>
          {down && !broken && (
            <div className={cls("notice", down === UNREACHABLE ? "err" : "warn")} role="alert">
              {down === UNREACHABLE ? (
                <span>
                  The desk server isn't running. Start it with <code>desk serve</code> or open the desktop app.
                </span>
              ) : (
                <span>{down}</span>
              )}
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void load();
                }}
              >
                Retry
              </button>
            </div>
          )}
          {broken && !(route.name === "settings" && route.section === "rules") && (
            <div className="notice err" role="alert">
              <span>Your rules don't load, so there's no queue yet. {down!.replace(/^config has errors:\s*/, "")}</span>
              <a className="btn" href="#/settings/rules">
                Fix rules
              </a>
            </div>
          )}
          {configErrors > 0 && !broken && !(route.name === "settings" && route.section === "rules") && (
            <div className="notice warn">
              <span>
                Your rules have {configErrors} {configErrors === 1 ? "error" : "errors"}, so the queue uses the last version that worked.
              </span>
              <a className="btn" href="#/settings/rules">
                Fix rules
              </a>
            </div>
          )}
          {route.name === "queue" && !broken && (
            <Queue view={view} overview={overview} groups={groups} ctx={ctx} filter={filter} toggle={toggleGroup} />
          )}
          {/* Settings stays mounted once opened, so an unsaved Rules draft survives a trip to the queue. */}
          {settingsSeen && (
            <Settings
              active={route.name === "settings"}
              section={section}
              view={settings}
              now={now}
              loads={loads}
              onView={saveSettingsView}
              flash={flash}
              onRulesSaved={() => {
                refresh(0);
              }}
              onRulesDirty={(d) => {
                rulesDirty.current = d;
              }}
            />
          )}
        </main>
      </div>
      {toast && (
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- not every screen reader announces <output> as a live region; role=status is
        <div key={toast.id} className={cls("toast", toast.error && "error")} role="status">
          <span>{toast.text}</span>
          {toast.undo && (
            <button
              type="button"
              className="toast-btn"
              onClick={() => {
                void undo();
              }}
            >
              Undo <kbd>u</kbd>
            </button>
          )}
        </div>
      )}
      {help && (
        <Help
          onClose={() => {
            setHelp(false);
          }}
        />
      )}
    </div>
  );
}
