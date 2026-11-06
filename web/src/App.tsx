import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Action,
  Card,
  GitHubAction,
  InflightRow,
  InflightView,
  Inquiry,
  ItemDetail,
  Overview,
  QueueView,
  Reviewer,
  SettingsView,
} from "../../src/types.ts";
import { api, message, starting, unreachable } from "./api.ts";
import { cls, copyText, shortId, shortRef, snoozeOptions } from "./format.ts";
import { restOn } from "./reviews.ts";
import { keysHeld } from "./drafts.ts";
import { adoptTheme, desktop } from "./theme.ts";
import {
  DEFAULT_OPEN,
  groupsOf,
  inquiryOf,
  isFold,
  isInquiry,
  navigable,
  parseRoute,
  removeCard,
  routeHash,
  PAGE_GROUPS,
  SORTED_AWAY,
  type Acted,
  type ListPage,
  stops,
  type GroupKey,
  type Route,
} from "./view.ts";
import type { RowCtx } from "./components/CardRow.tsx";
import { startSentry } from "./sentry.ts";
import { CommentBar } from "./components/CommentBar.tsx";
import { Composer, type About, type Thread } from "./components/Composer.tsx";
import { Help } from "./components/Help.tsx";
import { Inflight } from "./components/Inflight.tsx";
import { InquiryPage } from "./components/Inquiry.tsx";
import { rowActions } from "./components/More.tsx";
import { RowMenu } from "./components/RowMenu.tsx";
import { Later, Queue } from "./components/Queue.tsx";
import { Review } from "./components/Review.tsx";
import { Settings } from "./components/Settings.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { SourceNotice, useSourceDown } from "./components/Source.tsx";
import { TopBar } from "./components/TopBar.tsx";

interface Toast {
  id: number;
  text: string;
  error?: boolean;
  undo?: boolean;
  busy?: boolean; // a write on its way to GitHub: a spinner until it lands
}

const LEAVES = new Set<Action>(["done", "snooze", "mute"]);
const VERB: Partial<Record<Action, string>> = {
  done: "Done",
  mute: "Muted",
  unmute: "Unmuted",
  pin: "Pinned",
  unpin: "Unpinned",
  restore: "Restored",
};
// What a More menu write says it did; close and draft can be undone with u (reopen, ready for review).
const DID: Record<GitHubAction, string> = {
  close: "Closed on GitHub",
  draft: "Converted to a draft on GitHub",
  ready: "Marked ready for review on GitHub",
  merge: "Merged on GitHub",
  reopen: "Reopened on GitHub",
  request_changes: "Requested changes on GitHub",
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
  m: { name: "inflight" },
  w: { name: "waiting" },
};
// g l, g f, g h, g x: Later, with that group open; g a (or g d): the Archive.
const AWAY_KEYS: Record<string, GroupKey> = { l: "later", f: "fyi", h: "hidden", x: "cleared", a: "archive", d: "archive" };
const configBroken = (msg: string | null) => !!msg && msg.startsWith("config has errors");

// The desktop app's window needs room for the macOS traffic lights and a draggable title bar.
if (desktop) {
  document.documentElement.dataset.shell = "desktop";
  document.documentElement.dataset.platform = desktop.platform;
  adoptTheme();
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
  const [moreFor, setMoreFor] = useState<string | null>(null); // the row whose More menu is open
  const [commenting, setCommenting] = useState<Card | null>(null); // the issue whose comment bar is open (w on it opened in place)
  const [menuAt, setMenuAt] = useState<{ id: string; x: number; y: number } | null>(null); // a row's right-click menu
  const stay = useRef<string | null>(null); // a row selected by a right-click: the page doesn't scroll to it under its menu
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [answered, setAnswered] = useState<Set<string>>(new Set()); // agents' questions you answered, gone at once
  // What you did on an item from this page, until you leave it: a review shows it in place of the key you pressed.
  const [acted, setActed] = useState<Record<string, Acted | undefined>>({});
  const actedRef = useRef(acted);
  // Later's groups other than its own open only when asked (g f, …), and close again on reload.
  const [open, setOpen] = useState(DEFAULT_OPEN);
  const [unfolded, setUnfolded] = useState<Partial<Record<GroupKey, boolean>>>({}); // the queue's "n more" line
  const [filter, setFilter] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const [help, setHelp] = useState(false);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [section, setSection] = useState(route.name === "settings" ? route.section : "github"); // kept while on the queue
  const [settingsSeen, setSettingsSeen] = useState(route.name === "settings");
  const [loads, setLoads] = useState(0); // bumped on every refresh, so Rules can re-read a file changed on disk
  const [tick, setTick] = useState(0); // bumped when an undo's hold on the selection runs out
  const [lane, setLane] = useState<InflightView | null>(null);
  const [laneSel, setLaneSel] = useState<string | null>(null);
  const [reviewFrom, setReviewFrom] = useState<ListPage>("queue"); // where Esc goes back to from a review
  const [reviewQuestion, setReviewQuestion] = useState<string | null>(null); // or the agent's question it was opened from
  const [asking, setAsking] = useState<About | null>(null); // the composer to the coordinator, open
  const [thread, setThread] = useState<Thread | null>(null); // the conversation you were last on in a review
  const rulesDirty = useRef(false);

  const filterRef = useRef<HTMLInputElement>(null);
  const routeRef = useRef(route);
  routeRef.current = route;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const downRef = useRef(down);
  downRef.current = down;
  const sourceDown = useSourceDown(down === UNREACHABLE);
  const loadSeq = useRef(0);
  const refreshTimer = useRef(0);
  const toastTimer = useRef(0);
  const undoSeq = useRef<number | null>(null);
  const undoWrite = useRef<{ id: string; to: "reopen" | "ready" } | null>(null); // u after a close or a draft, instead
  const lastIndex = useRef(0);
  const settingsSeq = useRef(0); // a GET that started before a save must not undo it
  const gAt = useRef(0);
  // An id we just asked for (e.g. after undo) that the next refresh will bring back.
  const pending = useRef<{ id: string; until: number } | null>(null);

  // A GitHub write's u lasts as long as its toast, so a stray u hours later can't reopen or un-draft anything.
  const flash = useCallback((text: string, error = false, canUndo = false, ms = 6000, busy = false) => {
    clearTimeout(toastTimer.current);
    if (!canUndo) undoWrite.current = null;
    setToast({ id: Date.now(), text, error, undo: canUndo, busy });
    toastTimer.current = window.setTimeout(() => {
      setToast(null);
      undoWrite.current = null;
    }, ms);
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
      const [ov, v, d, l] = await Promise.all([
        api.overview(),
        // Always: the sidebar shows the queue's counts on every page.
        api.queue(),
        exp ? api.item(exp).catch((e: unknown) => message(e)) : null,
        // A review of your PR in Merging shows its Merging line too.
        r.name === "inflight" || r.name === "review" ? api.inflight() : null,
      ]);
      if (n !== loadSeq.current) return;
      setOverview(ov);
      startSentry(ov.sentry);
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
      setThread(null); // a review you come back to asks about the PR until you pick a conversation again
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
    setMoreFor(null);
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
    if (route.name === "review") return;
    setReviewFrom(route.name === "settings" || route.name === "inquiry" ? "queue" : route.name);
    setReviewQuestion(route.name === "inquiry" ? route.id : null);
  }, [route]);
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
    // Bumping epoch is how a dead stream gets reopened.
  }, [refresh, epoch]);

  // A desk from a checkout is back within a second or two of a change.
  const quick = sourceDown?.state === "running";
  useEffect(() => {
    const t = down
      ? setInterval(
          () => {
            void load();
          },
          quick ? 1000 : 5000,
        )
      : undefined;
    return () => {
      clearInterval(t);
    };
  }, [down, load, quick]);

  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
    }, 15_000);
    return () => {
      clearInterval(t);
    };
  }, []);

  const me = overview?.me ?? "";
  // A new page starts with nothing done on it.
  useEffect(() => {
    actedRef.current = {};
    setActed({});
    stay.current = null;
    setMenuAt(null);
  }, [route]);
  const onLater = route.name === "later";
  const onArchive = route.name === "archive";
  const onWaiting = route.name === "waiting";
  const groups = useMemo(() => groupsOf(view, open, filter, unfolded), [view, open, filter, unfolded]);
  // j/k and the selection go through the page on screen: the queue, or Later's groups; in a review, the page it came from.
  const list = route.name === "review" ? reviewFrom : route.name;
  const page = useMemo(() => {
    const keys = PAGE_GROUPS[list === "later" || list === "archive" || list === "waiting" ? list : "queue"];
    return groups.filter((g) => keys.includes(g.key));
  }, [groups, list]);
  const flat = useMemo(() => navigable(page, leaving), [page, leaving]);
  // Agents' questions lead the main page (one waits on each); the filter reads them too.
  const inquiries = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (route.name !== "queue" && route.name !== "inquiry") return []; // on a question's page, the queue's cursor stays on it
    return (view?.inquiries ?? []).filter(
      (q) => !answered.has(q.id) && (!f || q.question.toLowerCase().includes(f) || q.from.toLowerCase().includes(f)),
    );
  }, [view, answered, filter, route.name]);
  const cursor = useMemo(() => [...inquiries.map((q) => inquiryOf(q.id)), ...stops(page, leaving)], [inquiries, page, leaving]);
  const current = flat.find((c) => c.id === selected) ?? null;
  const asked = inquiries.find((q) => inquiryOf(q.id) === selected) ?? null;
  const laneRows = useMemo(() => lane?.rows ?? [], [lane]);
  const laneCur = laneRows.find((r) => r.card.id === laneSel) ?? laneRows[0] ?? null;
  // Every card on the desk the client has, by id: a review opens on its row's card while the rest is on its way.
  const known = useMemo(() => {
    const m = new Map<string, Card>();
    if (view)
      for (const c of [
        ...Object.values(view.sections).flat(),
        ...view.hidden,
        ...view.cleared,
        ...view.resolved,
        ...view.waiting.reviews,
        ...view.waiting.prs,
      ])
        m.set(c.id, c);
    for (const r of laneRows) m.set(r.card.id, r.card);
    return m;
  }, [view, laneRows]);
  const knownRef = useRef(known);
  knownRef.current = known;

  // The cards of the rows on screen: Merging's on its page, else the list's, so a stale Merging card never stands in.
  const onScreen = useMemo(
    () => (onLane ? laneRows.map((r) => r.card) : page.flatMap((g) => (g.open ? g.cards : []))),
    [onLane, laneRows, page],
  );
  // A right-click on a row, wherever it is (the queue, Later, the Archive, Merging), selects it and opens its menu.
  function rowMenu(x: number, y: number, target: Element | null): boolean {
    const id = target?.closest<HTMLElement>(".line[data-id]")?.dataset.id;
    const c = onScreen.find((card) => card.id === id);
    if (!c) {
      stay.current = null;
      setMenuAt(null);
      return false;
    }
    stay.current = c.id;
    if (onLane) setLaneSel(c.id);
    else setSelected(c.id);
    setSnoozeFor(null);
    setMoreFor(null);
    setMenuAt({ id: c.id, x, y });
    return true;
  }
  const rowMenuRef = useRef(rowMenu);
  rowMenuRef.current = rowMenu;
  useEffect(() => {
    const h = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest(".ctx, .scrim-clear")) return; // the open menu's own
      if (rowMenuRef.current(e.clientX, e.clientY, t)) e.preventDefault();
    };
    window.addEventListener("contextmenu", h);
    return () => {
      window.removeEventListener("contextmenu", h);
    };
  }, []);
  const menuCard = menuAt ? onScreen.find((c) => c.id === menuAt.id) : undefined;
  const closeMenu = useCallback(() => {
    stay.current = null;
    setMenuAt(null);
  }, []);
  // Its row left the page (sorted away, resolved, acted on elsewhere): the menu goes with it, for good.
  useEffect(() => {
    if (menuAt && !menuCard) closeMenu();
  }, [menuAt, menuCard, closeMenu]);

  // The PR row you rest on, by j/k or the pointer, has its review fetched ahead, so opening it doesn't wait on GitHub.
  const onRow =
    route.name === "inflight"
      ? (laneCur?.card ?? null)
      : route.name === "queue" || route.name === "later" || route.name === "archive" || route.name === "waiting"
        ? current
        : null;
  const restingPr = onRow?.kind === "pr" ? onRow.id : null;
  useEffect(() => {
    restOn(restingPr);
  }, [restingPr]);
  useEffect(() => {
    const over = (e: PointerEvent) => {
      const id = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-id]")?.dataset.id : undefined;
      restOn(id && knownRef.current.get(id)?.kind === "pr" ? id : null);
    };
    document.addEventListener("pointerover", over);
    return () => {
      document.removeEventListener("pointerover", over);
    };
  }, []);

  useEffect(() => {
    if (onLane && laneCur && stay.current !== laneCur.card.id)
      document.querySelector(`.lane [data-id="${CSS.escape(laneCur.card.id)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [onLane, laneCur]);

  // Keep the selection by id across refreshes; if its card is gone, take whatever now sits at its old position.
  useEffect(() => {
    if ((isFold(selected) || isInquiry(selected)) && cursor.includes(selected!)) return;
    // The first pick is the page's first row: an agent's question, when one waits; so is the pick after one that went.
    if ((selected === null || isInquiry(selected)) && isInquiry(cursor[0] ?? null)) {
      setSelected(cursor[0]!);
      return;
    }
    if (!flat.length) return;
    const i = flat.findIndex((c) => c.id === selected);
    if (i >= 0) {
      lastIndex.current = i;
      return;
    }
    if (pending.current && pending.current.id === selected && Date.now() < pending.current.until) return;
    const next = flat[Math.min(lastIndex.current, flat.length - 1)];
    if (!next) return;
    setSelected(next.id);
    // The first pick of a session takes focus too, so the keys act on it and Tab goes on from it.
    if (document.activeElement === document.body && ["queue", "later"].includes(routeRef.current.name))
      requestAnimationFrame(() => {
        focusRow(next.id);
      });
    // tick re-checks once the undo hold has run out.
  }, [flat, cursor, selected, tick]);

  // The first row of a group brings its heading along (the page's first, the top of the page), so no heading sits under the bar.
  useEffect(() => {
    if (!selected || !["queue", "later", "waiting", "archive"].includes(route.name) || stay.current === selected) return;
    const el = document.querySelector(`[data-id="${CSS.escape(selected)}"]`);
    const head = el?.closest(".group")?.querySelector(".group-head");
    if (!el) return;
    if (document.querySelector(".queue [data-id]") === el) window.scrollTo(0, 0);
    else if (head && el.closest(".group")?.querySelector("[data-id]") === el && head.getBoundingClientRect().top < 64)
      head.scrollIntoView({ block: "start" });
    else el.scrollIntoView({ block: "nearest" });
    // Filtering moves rows, so scroll the selection back into view.
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
    if (leaves) hide(c);
    try {
      const started = Date.now();
      const res = await api.act(c.id, action, until);
      undoSeq.current = res.undo_seq || null; // before the animation, so a quick u undoes this action
      undoWrite.current = null;
      if (leaves) {
        await sleep(Math.max(0, 200 - (Date.now() - started)));
        setView((v) => v && removeCard(v, c.id));
      }
      const verb = action === "snooze" ? `Snoozed ${snoozeOptions(c).find((o) => o.until === until)?.toast ?? ""}` : VERB[action];
      flash(`${verb}: ${shortRef(c)}`, false, true);
    } catch (e) {
      flash(message(e), true);
    } finally {
      if (leaves) unhide(c.id);
      refresh(0);
    }
  }

  // Enter on an agent's question: its own page, with all it said.
  function openInquiry(q: Inquiry) {
    setSelected(inquiryOf(q.id));
    go({ name: "inquiry", id: q.id });
  }

  // A row leaving the list: the next one takes the cursor, it fades out, and j/k skip it until unhide().
  // `ends`: a close or a merge, which ends a wait too; anything else you do on Waiting leaves the row where it is.
  function hide(c: Card, ends = false) {
    setSnoozeFor(null);
    if (list === "waiting" && !ends) return;
    const i = flat.findIndex((x) => x.id === c.id);
    if (i >= 0) setSelected((flat[i + 1] ?? flat[i - 1])?.id ?? null);
    if (expanded === c.id) setExpanded(null);
    setLeaving((s) => new Set(s).add(c.id));
  }

  function unhide(id: string) {
    setLeaving((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }

  // Your answer to an agent's question (or leaving it unanswered): it leaves the main page at once while its page stays,
  // saying so; a refusal brings it back. True once the desk has it.
  async function answerInquiry(q: Inquiry, text: string, dismiss = false): Promise<boolean> {
    const id = inquiryOf(q.id);
    const i = cursor.indexOf(id);
    if (selected === id) setSelected(cursor[i + 1] ?? cursor[i - 1] ?? null);
    setAnswered((s) => new Set(s).add(q.id));
    let ok = true;
    try {
      await api.answerInquiry(q.id, dismiss ? { dismiss: true } : { text });
      flash(dismiss ? `Dismissed ${q.from}'s question` : `Answered ${q.from}`);
    } catch (e) {
      ok = false;
      setAnswered((s) => {
        const next = new Set(s);
        next.delete(q.id);
        return next;
      });
      setSelected(id);
      flash(message(e), true);
    }
    refresh(0);
    return ok;
  }

  // A write that finishes your part takes it off the list at once, with a spinner in the toast until GitHub has it; a
  // refusal brings it back. A review stays open, saying what you did and where it went (`did`). `error` on what the write
  // returns: done, but with something to say. True once GitHub has it.
  async function finish(
    c: Card,
    sending: string,
    did: Acted,
    write: () => Promise<{ text: string; error?: boolean; undo?: boolean }>,
    ends = false,
  ): Promise<boolean> {
    // Sent already from this review; a list's row that stays (Waiting's) can take the next write.
    if (actedRef.current[c.id] && routeRef.current.name === "review") return false;
    const mark = (to: Acted | null) => {
      actedRef.current = { ...actedRef.current, [c.id]: to ?? undefined };
      setActed(actedRef.current);
    };
    mark({ ...did, sending: true });
    hide(c, ends);
    flash(sending, false, false, 60_000, true);
    try {
      const r = await write();
      mark({ ...did, sending: false });
      setView((v) => v && removeCard(v, c.id, ends));
      flash(r.text, r.error, r.undo);
      return true;
    } catch (e) {
      mark(null);
      flash(message(e), true);
      return false;
    } finally {
      unhide(c.id);
      refresh(0);
    }
  }

  async function undo() {
    const w = undoWrite.current;
    if (w) {
      undoWrite.current = null;
      try {
        if (w.to === "ready") {
          await api.ready(w.id);
          await api.act(w.id, "undo"); // marking it ready took it off your desk; undoing the draft keeps it where it was
        } else await api.github(w.id, "reopen");
        flash(`Undid it on GitHub: ${shortId(w.id)} is ${w.to === "ready" ? "ready for review" : "open"} again`);
      } catch (e) {
        flash(message(e), true);
      }
      refresh(0);
      return;
    }
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

  // A PR opens its review in place of the queue; an issue opens in place.
  function openCard(c: Card) {
    if (c.kind !== "pr") {
      toggle(c);
      return;
    }
    setSelected(c.id);
    setSnoozeFor(null);
    go({ name: "review", id: c.id });
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

  // m: your own open PR goes to Merging (you're done; the coordinator gets it merged). Not undone with u: b brings it back.
  function handOff(c: Card) {
    void finish(c, `Handing off ${shortRef(c)}…`, { what: "Handed off for merge", where: "inflight" }, async () => {
      await api.act(c.id, "inflight");
      undoSeq.current = null;
      return { text: `Handed off for merge: ${shortRef(c)}. The coordinator gets it merged.` };
    });
  }

  // b: your PR leaves Merging for your desk.
  async function back(c: Card) {
    if (!c.inflight) {
      flash(`${shortRef(c)} isn't in Merging`);
      return;
    }
    try {
      await api.act(c.id, "takeback");
      undoSeq.current = null;
      undoWrite.current = null;
      flash(`Back on your desk: ${shortRef(c)}`);
    } catch (e) {
      flash(message(e), true);
    }
    refresh(0);
  }

  // a: Ready for review on GitHub, from its row or its review (asking whoever was picked there). Only the review request
  // failing leaves it ready, so it stays gone and the toast says who to ask.
  function markReady(c: Card, picked: Reviewer[] = []) {
    const names = picked.map((p) => p.login).join(", ");
    const ask = { users: picked.filter((p) => !p.team).map((p) => p.id), teams: picked.filter((p) => p.team).map((p) => p.id) };
    void finish(c, `Marking ${shortRef(c)} ready for review…`, { what: "Marked ready for review", where: "archive" }, async () => {
      try {
        await api.ready(c.id, ask);
      } catch (e) {
        if (!message(e).startsWith("Marked it ready")) throw e;
        return { text: `${message(e)}. Ask ${names} on GitHub.`, error: true };
      }
      return { text: `Marked ${shortRef(c)} ready for review${names ? ` and asked ${names}` : ""} on GitHub` };
    });
  }

  // a in the review of your ready PR nobody's asked to review: asks who you picked; it leaves your desk until someone reviews.
  function askReviewers(c: Card, picked: Reviewer[]) {
    const names = picked.map((p) => p.login).join(", ");
    const ask = { users: picked.filter((p) => !p.team).map((p) => p.id), teams: picked.filter((p) => p.team).map((p) => p.id) };
    void finish(c, `Asking ${names} to review ${shortRef(c)}…`, { what: `Asked ${names}`, where: "archive" }, async () => {
      await api.askReviewers(c.id, ask);
      return { text: `Asked ${names} to review ${shortRef(c)} on GitHub` };
    });
  }

  // w: your comment on the PR (its review) or the issue (the comment bar). True once GitHub has it, so its box closes; a
  // refusal keeps your words in it.
  function comment(c: Card, body: string): Promise<boolean> {
    return finish(c, `Commenting on ${shortRef(c)}…`, { what: "Commented", where: "archive" }, async () => {
      await api.comment(c.id, body);
      return { text: `Commented on ${shortRef(c)} on GitHub` };
    });
  }

  // a in a review: approved on GitHub, pinned to the commit the review showed.
  function approve(c: Card, head: string) {
    void finish(c, `Approving ${shortRef(c)}…`, { what: "Approved", where: "archive" }, async () => {
      await api.approve(c.id, head);
      return { text: `Approved ${shortRef(c)} on GitHub` };
    });
  }

  // .: the row's More menu, with what the desk allows it on GitHub.
  function openMore(c: Card) {
    setSelected(c.id);
    setSnoozeFor(null);
    if (rowActions(c).length) setMoreFor(c.id);
    else if (c.actions?.includes("request_changes")) flash("Request changes is in its review: Enter");
    else flash(`Nothing more to do on GitHub for ${shortRef(c)}`);
  }

  // A More menu write, from a row or a review (head: the commit the review showed; body: Request changes' words). Close,
  // merge and Request changes finish your part, so it leaves your desk at once; draft and reopen keep it where it is.
  async function github(c: Card, action: GitHubAction, head?: string, body?: string): Promise<boolean> {
    setMoreFor(null);
    // The same as its a: off your desk at once, into the Archive.
    if (action === "ready") {
      markReady(c);
      return true;
    }
    const write = async () => {
      await api.github(c.id, action, { ...(head ? { head_oid: head } : {}), ...(body ? { body } : {}) });
      undoSeq.current = null;
      const to = action === "close" && c.kind === "pr" ? "reopen" : action === "draft" ? "ready" : null;
      undoWrite.current = to && { id: c.id, to };
      return { text: `${DID[action]}: ${shortRef(c)}`, undo: !!to };
    };
    if (action === "close" || action === "merge" || action === "request_changes") {
      const verb = action === "close" ? "Closing" : action === "merge" ? "Merging" : "Requesting changes on";
      const what = action === "close" ? "Closed" : action === "merge" ? "Merged" : "Requested changes";
      return finish(c, `${verb} ${shortRef(c)} on GitHub…`, { what, where: "archive" }, write, action !== "request_changes");
    }
    try {
      const r = await write();
      flash(r.text, false, r.undo);
      return true;
    } catch (e) {
      flash(message(e), true);
      return false;
    } finally {
      refresh(0);
    }
  }

  // t: a word with the coordinator about what you're on: the review's PR and its conversation, a row, or nothing.
  function openAsk(id?: string, t?: Thread) {
    const r = routeRef.current;
    const item = id ?? (r.name === "review" ? r.id : r.name === "inflight" ? laneCur?.card.id : r.name === "settings" ? null : current?.id);
    setCommenting(null);
    setAsking({ item: item ?? null, thread: t ?? (r.name === "review" && thread?.item === item ? thread : null) });
    requestAnimationFrame(() => {
      document.querySelector<HTMLInputElement>(".composer-input")?.focus();
    });
  }

  // Merging's keys: enter review, o GitHub, b back to desk, t ask the coordinator.
  function laneRun(r: InflightRow, k: string) {
    const c = r.card;
    setLaneSel(c.id);
    if (k === "t") openAsk(c.id);
    else if (k === "enter") go({ name: "review", id: c.id });
    else if (k === "o") window.open(c.url, "_blank", "noopener,noreferrer");
    else if (k === "b" && r.state === "open") void back(c);
  }

  // c copies `claude attach <id>`; w starts the coordinator, or has it look at Merging now.
  async function coordinatorKey(k: "c" | "w") {
    const id = lane?.coordinator.id;
    try {
      if (k === "w") {
        await api.wakeCoordinator();
        flash(id ? "Asked the coordinator to look at Merging." : "Started the coordinator.");
        refresh(0);
      } else if (id) {
        await copyText(`claude attach ${id}`);
        flash("Copied. Run it in a terminal to open the coordinator.");
      } else flash("The coordinator isn't started yet: w starts it.");
    } catch (e) {
      flash(message(e), true);
    }
  }

  function moveLane(d: number) {
    if (!laneRows.length) return;
    const i = laneRows.findIndex((r) => r.card.id === laneCur?.card.id);
    const next = laneRows[Math.max(0, Math.min(laneRows.length - 1, i + d))];
    if (!next) return;
    setLaneSel(next.card.id);
    focusRow(next.card.id);
  }

  function run(c: Card, k: string) {
    if (k === "enter") openCard(c);
    else if (k === "esc") setExpanded(null);
    else if (k === "t") openAsk(c.id);
    // From its review: a PR in Merging is the coordinator's.
    else if (c.inflight && ["e", "d", "s", "m"].includes(k))
      flash(`${shortRef(c)} is in Merging, so the coordinator has it. b brings it back to the desk.`);
    else if (k === "b") void back(c);
    else if (k === ".") openMore(c);
    else if (k === "a" && c.cta === "ready") markReady(c);
    else if (k === "a" && c.cta === "reviewers")
      openCard(c); // its review, with the reviewers box ready
    else if (k === "m" && c.kind === "pr" && !c.resolved && c.author.toLowerCase() === me.toLowerCase()) {
      if (c.draft) flash(`${shortRef(c)} is a draft: mark it ready for review first (a)`);
      else if (c.cta === "reviewers") flash(`Nobody's asked to review ${shortRef(c)}: add reviewers first (a)`);
      else handOff(c);
    } else if (k === "o") {
      window.open(c.url, "_blank", "noopener,noreferrer");
      void seen(c);
    } else if (k === "e" || k === "d") void act(c, c.status === "active" ? "done" : "restore");
    else if (k === "s") {
      setSelected(c.id);
      setSnoozeFor(c.id);
    } else if (k === "m") void act(c, c.status === "muted" ? "unmute" : "mute");
    else if (k === "p") void act(c, c.pinned ? "unpin" : "pin");
    else if (k === "i") void aiReview(c);
    else if (k === "w") {
      // An issue opened in place: w writes a comment, as it does in a PR's review.
      if (expanded === c.id && c.kind === "issue" && !showSignals && !c.resolved) {
        setAsking(null);
        setCommenting(c);
        // Open already, it takes the keys back: what you type never runs as the page's keys.
        requestAnimationFrame(() => {
          document.querySelector<HTMLTextAreaElement>(".composer-text")?.focus();
        });
      } else if (expanded === c.id) setShowSignals((s) => !s);
      else {
        toggle(c);
        setShowSignals(true);
      }
    }
  }

  // Focus follows the cursor, without a scroll of its own.
  function focusRow(id: string) {
    const el = document.querySelector(`[data-id="${CSS.escape(id)}"]`);
    const target = el instanceof HTMLButtonElement ? el : el?.querySelector(".row-main");
    if (target instanceof HTMLElement) target.focus({ preventScroll: true });
  }

  function move(d: number) {
    if (!cursor.length) return;
    const i = cursor.indexOf(selected ?? "");
    const next = cursor[i < 0 ? 0 : Math.max(0, Math.min(cursor.length - 1, i + d))];
    if (!next) return;
    setSelected(next);
    focusRow(next);
  }

  // A group's "n more" line opens in place; the cursor goes on to the first card it showed.
  function unfold(k: GroupKey) {
    const shown = new Set(groups.find((g) => g.key === k)?.cards.map((c) => c.id));
    const first = groupsOf(view, open, filter, { ...unfolded, [k]: true })
      .find((g) => g.key === k)
      ?.cards.find((c) => !shown.has(c.id));
    setUnfolded((u) => ({ ...u, [k]: true }));
    if (first) {
      setSelected(first.id);
      requestAnimationFrame(() => {
        focusRow(first.id);
      });
    }
  }

  function toggleGroup(k: GroupKey) {
    setOpen((o) => ({ ...o, [k]: !o[k] }));
  }

  // A chord opens its group on Later (or the Archive), and scrolls to it; pressed again there, it closes it.
  function chordGroup(k: GroupKey) {
    const target = k === "archive" ? "archive" : "later";
    const here = route.name === target;
    if (!here || !open[k]) setOpen((o) => ({ ...o, [k]: true }));
    else toggleGroup(k);
    if (!here) go({ name: target });
    requestAnimationFrame(() => {
      document.querySelector(`.g-${k}`)?.scrollIntoView({ block: "start" });
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
      const c = flat.find((x) => x.id === snoozeFor);
      if (!c)
        setSnoozeFor(null); // its card left the list; don't hold the keyboard
      else {
        const o = snoozeOptions(c).find((x) => x.key === k);
        if (o) void act(c, "snooze", o.until);
        else if (k === "Escape" || k === "s") setSnoozeFor(null);
        e.preventDefault();
        return;
      }
    }
    if (k === "g") gAt.current = Date.now();
    else if (k === "?") setHelp(true);
    else if (k === "t") {
      e.preventDefault();
      openAsk();
    } else if (k === ",") go({ name: "settings", section: "github" });
    else if (k === "r") void sync();
    else if (k === "u") void undo();
    else if (route.name === "settings") {
      if (k === "Escape") go({ name: "queue" });
    } else if (route.name === "review" || route.name === "inquiry") {
      // The review and a question's page read their own keys.
    } else if (route.name === "inflight") {
      if (k === "Escape") go({ name: "queue" });
      else if (k === "j" || k === "ArrowDown" || k === "k" || k === "ArrowUp") {
        e.preventDefault();
        moveLane(k === "j" || k === "ArrowDown" ? 1 : -1);
      } else if (laneCur && (k === "Enter" || k === "o" || k === "b")) {
        e.preventDefault();
        laneRun(laneCur, k === "Enter" ? "enter" : k);
      } else if (k === "c" || k === "w") {
        e.preventDefault();
        void coordinatorKey(k);
      }
    } else if (k === "/") {
      e.preventDefault();
      filterRef.current?.focus();
    } else if (k === "Escape") {
      if (expanded) setExpanded(null);
      else if (filter) setFilter("");
      else if (onLater || onArchive || onWaiting) go({ name: "queue" });
    } else if (k === "j" || k === "ArrowDown" || k === "k" || k === "ArrowUp") {
      e.preventDefault();
      move(k === "j" || k === "ArrowDown" ? 1 : -1);
    } else if (asked && k === "Enter") {
      e.preventDefault();
      openInquiry(asked);
    } else if (asked && (k === "d" || k === "e")) {
      e.preventDefault();
      void answerInquiry(asked, "", true);
    } else if (k === "Enter" && isFold(selected)) {
      e.preventDefault();
      unfold(selected!.slice("fold:".length) as GroupKey);
    } else if (k === "Enter" && current) {
      e.preventDefault();
      openCard(current);
    } else if (current && k.length === 1 && "oedsmbpwia.".includes(k)) {
      e.preventDefault();
      run(current, k);
    }
  };
  // The key after g is the chord's, whatever it means on its own (i in a review, b in Merging), so it never falls
  // through to them. Capture phase: this runs before any other keydown listener, the review's included.
  const onChord = (e: KeyboardEvent) => {
    // A key while the review's comment box is drawn again is the box's: no shortcut runs on it.
    if (keysHeld()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (menuAt) return; // a row's menu has the keyboard, Esc included
    // Esc on the help sheet closes it, and only it: a review or a page under it would read it as "go back" too.
    if (help && (e.key === "Escape" || e.key === "?") && !e.isComposing) {
      setHelp(false);
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    // Esc closes the composer or the comment bar, wherever focus is, before a review or a page reads it as "go back"; a
    // snooze or More menu over it closes first.
    if ((asking || commenting) && !snoozeFor && !moreFor && e.key === "Escape" && !e.isComposing) {
      setAsking(null);
      setCommenting(null);
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
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
    else if (AWAY_KEYS[k]) chordGroup(AWAY_KEYS[k]);
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
    moreFor,
    closeMore: () => {
      setMoreFor(null);
    },
    github: (c, a) => {
      void github(c, a);
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
          question={route.name === "review" ? reviewQuestion : null}
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
          {sourceDown && <SourceNotice s={sourceDown} />}
          {down && !broken && !sourceDown && (
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
            <Queue
              view={view}
              overview={overview}
              groups={groups}
              ctx={ctx}
              inquiries={inquiries}
              inq={{
                now,
                selected,
                select: (q) => {
                  setSelected(inquiryOf(q.id));
                },
                open: openInquiry,
              }}
              filter={filter}
              unfold={unfold}
              selectFold={(k) => {
                setSelected(`fold:${k}`);
              }}
            />
          )}
          {route.name === "later" && !broken && (
            <Later
              view={view}
              groups={groups}
              keys={SORTED_AWAY}
              empty="Nothing sorted away."
              ctx={ctx}
              filter={filter}
              toggle={toggleGroup}
            />
          )}
          {route.name === "waiting" && !broken && (
            <Later
              view={view}
              groups={groups}
              keys={PAGE_GROUPS.waiting}
              empty="Nothing of yours waits on anyone else."
              ctx={ctx}
              filter={filter}
              toggle={toggleGroup}
            />
          )}
          {route.name === "archive" && !broken && (
            <Later
              view={view}
              groups={groups}
              keys={PAGE_GROUPS.archive}
              empty="Nothing here yet: what you finish, and what's dealt with, lands here."
              ctx={ctx}
              filter={filter}
              toggle={toggleGroup}
            />
          )}
          {route.name === "review" && !broken && (
            <Review
              key={route.id} // a different PR starts fresh: first file, no note
              id={route.id}
              known={known.get(route.id) ?? null}
              loads={loads}
              me={overview?.me ?? ""}
              now={now}
              inert={help}
              flash={flash}
              onCard={run}
              onGithub={(c, a, head, body) => github(c, a, head, body)}
              acted={acted[route.id]}
              row={laneRows.find((r) => r.card.id === route.id) ?? null}
              onApprove={approve}
              onReady={markReady}
              onAskReviewers={askReviewers}
              onComment={comment}
              onBack={() => {
                go(reviewQuestion ? { name: "inquiry", id: reviewQuestion } : { name: reviewFrom });
              }}
              onAsk={(t) => {
                openAsk(t.item, t);
              }}
              onThread={setThread}
            />
          )}
          {route.name === "inquiry" && !broken && (
            <InquiryPage
              key={route.id}
              id={route.id}
              loads={loads}
              now={now}
              inert={help}
              flash={flash}
              onAnswer={answerInquiry}
              onBack={() => {
                go({ name: "queue" });
              }}
            />
          )}
          {route.name === "inflight" && !broken && (
            <Inflight view={lane} now={now} selected={laneCur?.card.id ?? null} select={setLaneSel} run={laneRun} />
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
      {commenting && (
        <CommentBar
          key={commenting.id}
          card={commenting}
          onSend={(body) => {
            // Each send is new: one earlier on this page doesn't stop it, and the bar can't send twice at once.
            actedRef.current = { ...actedRef.current, [commenting.id]: undefined };
            return comment(commenting, body);
          }}
          onClose={() => {
            const id = commenting.id;
            setCommenting((cur) => (cur?.id === id ? null : cur));
          }}
        />
      )}
      {asking && (
        <Composer
          key={`${asking.item ?? ""} ${asking.thread?.id ?? ""}`} // another item or thread starts afresh
          about={asking}
          loads={loads}
          now={now}
          onClose={() => {
            setAsking(null);
          }}
        />
      )}
      {toast && (
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- not every screen reader announces <output> as a live region; role=status is
        <div key={toast.id} className={cls("toast", toast.error && "error")} role="status">
          <span>{toast.text}</span>
          {toast.busy && <span className="busy" aria-label="sending" />}
          {toast.undo && (
            <button
              type="button"
              className="toast-btn"
              onClick={() => {
                void undo();
              }}
            >
              <kbd>u</kbd> Undo
            </button>
          )}
        </div>
      )}
      {menuAt && menuCard && (
        <RowMenu
          key={`${menuAt.id} ${menuAt.x} ${menuAt.y}`}
          card={menuCard}
          x={menuAt.x}
          y={menuAt.y}
          me={me}
          run={run}
          act={(c, a, until) => {
            void act(c, a, until);
          }}
          github={(c, a) => {
            void github(c, a);
          }}
          reopen={(x, y) => {
            const under = document.elementsFromPoint(x, y).find((n) => !n.closest(".ctx, .scrim-clear"));
            rowMenu(x, y, under ?? null);
          }}
          onClose={closeMenu}
        />
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
