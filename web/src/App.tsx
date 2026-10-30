import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  Action,
  Card,
  DesktopBridge,
  Draft,
  InflightRow,
  InflightView,
  ItemDetail,
  Overview,
  QueueView,
  SettingsView,
} from "../../src/types.ts";
import { api, message, starting, unreachable } from "./api.ts";
import { cls, copyText, shortId, shortRef, SNOOZE } from "./format.ts";
import { DEFAULT_OPEN, FOLD, groupsOf, navigable, parseRoute, removeCard, routeHash, stops, type GroupKey, type Route } from "./view.ts";
import type { RowCtx } from "./components/CardRow.tsx";
import { CoordinatorLog } from "./components/CoordinatorLog.tsx";
import { Help } from "./components/Help.tsx";
import { Inflight } from "./components/Inflight.tsx";
import { Queue } from "./components/Queue.tsx";
import { Review } from "./components/Review.tsx";
import { Settings } from "./components/Settings.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TopBar } from "./components/TopBar.tsx";

interface Toast {
  id: number;
  text: string;
  error?: boolean;
  undo?: boolean;
}

const LEAVES = new Set<Action>(["done", "snooze", "mute", "inflight"]);
const VERB: Partial<Record<Action, string>> = {
  done: "Done",
  mute: "Muted",
  unmute: "Unmuted",
  pin: "Pinned",
  unpin: "Unpinned",
  restore: "Restored",
  inflight: "In flight",
  takeback: "Took back",
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
  i: { name: "inflight" },
};
const AWAY_KEYS: Record<string, GroupKey> = { l: "later", f: "fyi", d: "resolved", h: "hidden", x: "cleared" };
const configBroken = (msg: string | null) => !!msg && msg.startsWith("config has errors");
const desktop = (window as Window & { desktop?: DesktopBridge }).desktop;

// The desktop app's window needs room for the macOS traffic lights and a draggable title bar.
if (desktop) {
  document.documentElement.dataset.shell = "desktop";
  document.documentElement.dataset.platform = desktop.platform;
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
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  // Sorted-away groups open only when asked (g l, …), and close again on reload: the queue is Now and Today.
  const [open, setOpen] = useState(DEFAULT_OPEN);
  const [unfolded, setUnfolded] = useState(false); // Today's "n more for today"
  const [filter, setFilter] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const [help, setHelp] = useState(false);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [section, setSection] = useState(route.name === "settings" ? route.section : "github"); // kept while on the queue
  const [settingsSeen, setSettingsSeen] = useState(route.name === "settings");
  const [loads, setLoads] = useState(0); // bumped on every refresh, so Rules can re-read a file changed on disk
  const [tick, setTick] = useState(0); // bumped when an undo's hold on the selection runs out
  const [coordOpen, setCoordOpen] = useState(false); // the coordinator's log, above the queue
  const [lane, setLane] = useState<InflightView | null>(null);
  const [laneSel, setLaneSel] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null); // a draft on its way to GitHub
  const [reviewFrom, setReviewFrom] = useState<"queue" | "inflight">("queue"); // where Esc goes back to from a review
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
  const landing = useRef<{ id: string; top: number } | null>(null); // where the card j/k moves to sat on screen
  const settingsSeq = useRef(0); // a GET that started before a save must not undo it
  const gAt = useRef(0);
  // An id we just asked for (e.g. after undo) that the next refresh will bring back.
  const pending = useRef<{ id: string; until: number } | null>(null);

  const flash = useCallback((text: string, error = false, canUndo = false, ms = 6000) => {
    clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), text, error, undo: canUndo });
    toastTimer.current = window.setTimeout(() => {
      setToast(null);
    }, ms);
  }, []);
  const reviewFlash = useCallback(
    (text: string, error = false, ms?: number) => {
      flash(text, error, false, ms);
    },
    [flash],
  );

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
      const [ov, v, d, l] = await Promise.all([
        api.overview(),
        // Always: the sidebar shows the queue's counts on every page.
        api.queue(),
        exp ? api.item(exp).catch((e: unknown) => message(e)) : null,
        // A review of your PR in flight shows its lane line too.
        r.name === "inflight" || r.name === "review" ? api.inflight() : null,
      ]);
      if (n !== loadSeq.current) return;
      setOverview(ov);
      if (l) setLane(l);
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

  const onLane = route.name === "inflight";
  // A review belongs to the page it was opened from: Esc, the back link and the sidebar go back there.
  useEffect(() => {
    if (route.name !== "review") setReviewFrom(route.name === "inflight" ? "inflight" : "queue");
  }, [route.name]);
  useEffect(() => {
    if (!onLane) return;
    window.scrollTo(0, 0);
    void load();
  }, [onLane, load]);

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

  const groups = useMemo(() => groupsOf(view, open, filter, unfolded), [view, open, filter, unfolded]);
  const flat = useMemo(() => navigable(groups, leaving), [groups, leaving]);
  const cursor = useMemo(() => stops(groups, leaving), [groups, leaving]);
  const current = flat.find((c) => c.id === selected) ?? null;
  const laneRows = useMemo(() => lane?.rows ?? [], [lane]);
  const laneCur = laneRows.find((r) => r.card.id === laneSel) ?? laneRows[0] ?? null;

  useEffect(() => {
    if (onLane && laneCur) document.querySelector(`.lane [data-id="${CSS.escape(laneCur.card.id)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [onLane, laneCur]);

  // Keep the selection by id across refreshes; if its card is gone, take whatever now sits at its old position.
  useEffect(() => {
    if (!flat.length || (selected === FOLD && cursor.includes(FOLD))) return;
    const i = flat.findIndex((c) => c.id === selected);
    if (i >= 0) {
      lastIndex.current = i;
      return;
    }
    if (pending.current && pending.current.id === selected && Date.now() < pending.current.until) return;
    const next = flat[Math.min(lastIndex.current, flat.length - 1)];
    if (next) setSelected(next.id);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- tick re-checks once the undo hold has run out
  }, [flat, cursor, selected, tick]);

  // The card j/k lands on stays put while the one it left closes above it; then it's scrolled into view if it grew past it.
  useLayoutEffect(() => {
    const at = landing.current;
    landing.current = null;
    if (!at || at.id !== selected) return;
    const top = document.querySelector(`[data-id="${CSS.escape(at.id)}"]`)?.getBoundingClientRect().top;
    if (top !== undefined) window.scrollBy(0, top - at.top);
  }, [selected]);

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

  // A PR opens its review in place of the queue; an issue opens in place.
  function openCard(c: Card) {
    if (c.kind !== "pr") {
      toggle(c);
      return;
    }
    setSelected(c.id);
    setSnoozeFor(null);
    // An in-flight PR is in Now for what its babysitter left you (a reply to send, a question): that's in the lane.
    if (c.inflight) setLaneSel(c.id);
    go(c.inflight ? { name: "inflight" } : { name: "review", id: c.id });
    void seen(c);
  }

  // Starts the PR's AI review without opening it; the verdict shows on the row when it's done.
  async function aiReview(c: Card) {
    if (c.kind !== "pr") {
      flash("AI reviews are for pull requests", true);
      return;
    }
    flash(`Asked for an AI review of ${shortRef(c)}. It takes a minute or two.`);
    try {
      const r = await api.aiReview(c.id);
      flash(`AI review of ${shortRef(c)}: ${r.ai.verdict}`);
    } catch (e) {
      flash(`AI review of ${shortRef(c)} failed: ${message(e)}`, true);
    }
  }

  // d: your own open PR goes in flight (you're done; agents get it merged), or comes back.
  function inflight(c: Card) {
    const mine = c.kind === "pr" && !c.resolved && c.author.toLowerCase() === (overview?.me ?? "").toLowerCase();
    if (!mine) {
      flash("Only your own open PRs go in flight", true);
      return;
    }
    void act(c, c.inflight ? "takeback" : "inflight");
  }

  async function send(r: InflightRow, d: Draft) {
    if (sending) return;
    setSending(d.id);
    try {
      await api.sendDraft(r.card.id, d.id);
      flash(`Sent your reply to ${d.to}`);
    } catch (e) {
      flash(message(e), true);
    } finally {
      setSending(null);
      refresh(0);
    }
  }

  async function dismiss(r: InflightRow, d?: Draft) {
    try {
      await api.dismiss(r.card.id, d?.id);
      flash(
        d
          ? `Discarded the reply to ${d.to}`
          : r.escalation
            ? `Dismissed the question on ${shortRef(r.card)}`
            : `Marked the outside comments on ${shortRef(r.card)} read`,
      );
    } catch (e) {
      flash(message(e), true);
    }
    refresh(0);
  }

  // The lane's keys: enter review, o GitHub, d take back, y send a reply, x discard it (or the question), c copy the resume command.
  function laneRun(r: InflightRow, k: string, d?: Draft) {
    const c = r.card;
    setLaneSel(c.id);
    if (k === "enter") go({ name: "review", id: c.id });
    else if (k === "o") window.open(c.url, "_blank", "noopener,noreferrer");
    else if (k === "d" && r.state === "open") void act(c, "takeback");
    else if (k === "y") {
      const draft = d ?? r.drafts[0];
      if (draft) void send(r, draft);
      else flash(`No reply to send on ${shortRef(c)}`);
    } else if (k === "x") {
      if (d) void dismiss(r, d);
      else if (r.escalation || r.outside_at) void dismiss(r);
      else if (r.drafts[0]) void dismiss(r, r.drafts[0]);
      else flash(`Nothing to dismiss on ${shortRef(c)}`);
    } else if (k === "c") void copyResume(r);
  }

  async function copyResume(r: InflightRow) {
    if (!r.resume) {
      flash("No babysitter session to open yet");
      return;
    }
    try {
      await copyText(r.resume);
      flash("Copied: paste it in a terminal to open the babysitter's session");
    } catch (e) {
      flash(`Couldn't copy: ${message(e)}`, true);
    }
  }

  function moveLane(d: number) {
    if (!laneRows.length) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const i = laneRows.findIndex((r) => r.card.id === laneCur?.card.id);
    const next = laneRows[Math.max(0, Math.min(laneRows.length - 1, i + d))];
    if (next) setLaneSel(next.card.id);
  }

  function run(c: Card, k: string) {
    if (k === "enter") openCard(c);
    else if (k === "d") inflight(c);
    else if (c.inflight && ["e", "s", "m"].includes(k)) flash(`${shortRef(c)} is in flight, so its babysitter has it. d takes it back.`);
    else if (k === "o") {
      window.open(c.url, "_blank", "noopener,noreferrer");
      void seen(c);
    } else if (k === "e") void act(c, c.status === "active" ? "done" : "restore");
    else if (k === "s") {
      setSelected(c.id);
      setSnoozeFor(c.id);
    } else if (k === "m") void act(c, c.status === "muted" ? "unmute" : "mute");
    else if (k === "p") void act(c, c.pinned ? "unpin" : "pin");
    else if (k === "c") void copy(c);
    else if (k === "i") void aiReview(c);
    else if (k === "w") {
      if (expanded === c.id) setShowSignals((s) => !s);
      else {
        toggle(c);
        setShowSignals(true);
      }
    }
  }

  function move(d: number) {
    if (!cursor.length) return;
    // A clicked link or button keeps focus and would take the next Enter.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const i = cursor.indexOf(selected ?? "");
    const next = cursor[i < 0 ? 0 : Math.max(0, Math.min(cursor.length - 1, i + d))];
    if (!next) return;
    const top = document.querySelector(`[data-id="${CSS.escape(next)}"]`)?.getBoundingClientRect().top;
    landing.current = top === undefined ? null : { id: next, top };
    setSelected(next);
  }

  // Today's "n more" line opens in place; the cursor goes on to the first card it showed.
  function unfold() {
    const first = view && view.today_cards > 0 ? view.sections.today[view.today_cards] : undefined;
    setUnfolded(true);
    if (first) setSelected(first.id);
  }

  function toggleGroup(k: GroupKey) {
    setOpen((o) => ({ ...o, [k]: !o[k] }));
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
    if (k === "g") gAt.current = Date.now();
    else if (k === "?") setHelp(true);
    else if (k === ",") go({ name: "settings", section: "github" });
    else if (k === "r") void sync();
    else if (k === "u") void undo();
    else if (route.name === "settings") {
      if (k === "Escape") go({ name: "queue" });
    } else if (route.name === "review") {
      // The review view reads its own keys.
    } else if (route.name === "inflight") {
      if (k === "Escape") go({ name: "queue" });
      else if (k === "j" || k === "ArrowDown" || k === "k" || k === "ArrowUp") {
        e.preventDefault();
        moveLane(k === "j" || k === "ArrowDown" ? 1 : -1);
      } else if (laneCur && (k === "Enter" || (k.length === 1 && "odyxc".includes(k)))) {
        e.preventDefault();
        laneRun(laneCur, k === "Enter" ? "enter" : k);
      }
    } else if (k === "/") {
      e.preventDefault();
      filterRef.current?.focus();
    } else if (k === "Escape") {
      if (expanded) setExpanded(null);
      else if (coordOpen) setCoordOpen(false);
      else if (filter) setFilter("");
    } else if (k === "j" || k === "ArrowDown" || k === "k" || k === "ArrowUp") {
      e.preventDefault();
      move(k === "j" || k === "ArrowDown" ? 1 : -1);
    } else if (k === "Enter" && selected === FOLD) {
      e.preventDefault();
      unfold();
    } else if (k === "Enter" && current) {
      e.preventDefault();
      openCard(current);
    } else if (current && k.length === 1 && "oesmpcwid".includes(k)) {
      e.preventDefault();
      run(current, k);
    }
  };
  // The key after g is the chord's, whatever it means on its own (i in a review, x and d in the lane), so it never falls
  // through to them. Capture phase: this runs before any other keydown listener, the review's included.
  const onChord = (e: KeyboardEvent) => {
    if (!gAt.current || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || ["Shift", "Meta", "Control", "Alt"].includes(e.key)) return;
    const t = e.target instanceof HTMLElement ? e.target : document.body;
    if (t.closest("input, textarea, select, [contenteditable='true']")) return;
    const fresh = Date.now() - gAt.current < 1200;
    gAt.current = 0;
    if (!fresh) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const k = e.key;
    if (CHORDS[k]) go(CHORDS[k]);
    else if (AWAY_KEYS[k] && route.name === "queue") toggleGroup(AWAY_KEYS[k]);
  };
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  const chordRef = useRef(onChord);
  chordRef.current = onChord;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      keyRef.current(e);
    };
    const chord = (e: KeyboardEvent) => {
      chordRef.current(e);
    };
    window.addEventListener("keydown", chord, { capture: true });
    window.addEventListener("keydown", h);
    return () => {
      window.removeEventListener("keydown", chord, { capture: true });
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
    boardLabel,
    click: openCard,
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
      <Sidebar route={route} from={reviewFrom} view={view} overview={overview} inert={help} />
      <div className="col">
        <TopBar
          overview={overview}
          offline={down === UNREACHABLE}
          now={now}
          route={route}
          from={reviewFrom}
          filter={filter}
          setFilter={setFilter}
          filterRef={filterRef}
          onSync={() => {
            void sync();
          }}
          onHelp={() => {
            setHelp(true);
          }}
          coordOpen={coordOpen}
          onCoordinator={() => {
            setCoordOpen((o) => !o);
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
          {route.name === "queue" && !broken && coordOpen && (
            <CoordinatorLog
              loads={loads}
              now={now}
              flash={flash}
              onClose={() => {
                setCoordOpen(false);
              }}
            />
          )}
          {route.name === "queue" && !broken && (
            <Queue
              view={view}
              overview={overview}
              groups={groups}
              ctx={ctx}
              filter={filter}
              toggle={toggleGroup}
              unfold={unfold}
              selectFold={() => {
                setSelected(FOLD);
              }}
            />
          )}
          {route.name === "review" && !broken && (
            <Review
              key={route.id} // a different PR starts fresh: first file, no note, nothing armed
              id={route.id}
              loads={loads}
              me={overview?.me ?? ""}
              now={now}
              inert={help}
              flash={reviewFlash}
              onInflight={inflight}
              row={laneRows.find((r) => r.card.id === route.id) ?? null}
              onBack={() => {
                go({ name: reviewFrom });
              }}
            />
          )}
          {route.name === "inflight" && !broken && (
            <Inflight view={lane} now={now} selected={laneCur?.card.id ?? null} sending={sending} select={setLaneSel} run={laneRun} />
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
