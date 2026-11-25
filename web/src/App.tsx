import { Effect, Result, Schema } from "effect";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type {
  InboxSection,
  Action,
  Card,
  GitHubAction,
  InflightRow,
  InflightView,
  Inquiry,
  Note,
  SessionAction,
  SessionCard,
  ItemDetail,
  Overview,
  QueueView,
  Reviewer,
  SettingsView,
  SetupView,
  WaitingStep,
  Work,
} from "../../src/types.ts";
import { permalink } from "../../src/links.ts";
import { parseJson } from "../../src/narrow.ts";
import { AGREE, DISAGREE, INBOX_SECTIONS, isCoordinator, untilTime } from "../../src/types.ts";
import { api, DeskUnreachable, runUi, type ApiError, type ClipboardUnavailable, type DeskConfigBroken, type DeskStarting } from "./api.ts";
import { cls, copyText, fromName, MAC, shortId, shortRef, SNOOZE, snoozeOptions, aiName, setAiName, when } from "./format.ts";
import { restOn } from "./reviews.ts";
import { holdKeys, keysHeld } from "./drafts.ts";
import { adoptTheme, desktop, loadOmarchy, OmarchyAnswer, omarchyIs } from "./theme.ts";
import { getStored, setStored } from "./storage.ts";
import { useKeyed, useKeyedLayout } from "./keyed.ts";
import { hasNoteEdit, useShown, withDrops, withNoteEdits, type Drop } from "./pending.ts";
import {
  attachCommand,
  DEFAULT_OPEN,
  groupsOf,
  inboxCount,
  inquiryOf,
  navigable,
  pickRange,
  pickToggle,
  PAGE_GROUPS,
  stepOf,
  toggled,
  type Acted,
  stops,
  type GroupKey,
  waitingSteps,
  whereIs,
  withoutRows,
} from "./groups.ts";
import { beside, pageOf, parseRoute, routeHash, settingsBack, type ListPage, type Route } from "./route.ts";
import { filterPeople, kindButtons, matches } from "./filter.ts";
import type { RowCtx } from "./components/CardRow.tsx";
import { startSentry } from "./sentry.ts";
import { CommentBar } from "./components/CommentBar.tsx";
import { NoteBar, NoteCard, noteOf, type NoteCtx } from "./components/Note.tsx";
import { Beside } from "./components/Beside.tsx";
import { Chat, type About, type Spot } from "./components/Chat.tsx";
import { Inflight } from "./components/Inflight.tsx";
import { InquiryPage } from "./components/Inquiry.tsx";
import { BulkMenu, NoteMenu, QuestionMenu, RowMenu, SessionMenu, StepMenu, type Steps } from "./components/RowMenu.tsx";
import type { ChainCtx } from "./components/Chain.tsx";
import { Later, Queue } from "./components/Queue.tsx";
import { stepDrops, useReorder } from "./components/Reorder.tsx";
import type { SessionCtx } from "./components/Session.tsx";
import { PeopleFilter } from "./components/PeopleFilter.tsx";
import { ShowFilter } from "./components/ShowFilter.tsx";
import { Review } from "./components/Review.tsx";
import { ItemLog } from "./components/ItemLog.tsx";
import { type RuleFocus } from "./components/Rules.tsx";
import { Settings } from "./components/Settings.tsx";
import { Setup } from "./components/Setup.tsx";
import { Filter } from "./components/Filter.tsx";
import { PageHead, PAGE_NAME } from "./components/PageHead.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { useSourceDown } from "./components/Source.tsx";
import { Bubbles } from "./components/Bubbles.tsx";
import { Tips } from "./components/Tips.tsx";
import { forget, noticesOf, undismissed, withFailure, type Dismissed, type Fix, type Notice } from "./notices.ts";

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
  restore: "Restored",
  urgent: "Moved to Urgent",
  standard: "Moved to Standard",
  fyi: "Moved to FYI",
};
// What a More menu write says it did; the toast's Undo undoes close and draft (reopen, ready for review).
const DID: Record<GitHubAction, string> = {
  close: "Closed on GitHub",
  draft: "Converted to a draft on GitHub",
  ready: "Marked ready for review on GitHub",
  merge: "Merged on GitHub",
  reopen: "Reopened on GitHub",
  request_changes: "Requested changes on GitHub",
  rerequest: "Asked them to review it again on GitHub",
  unrequest: "Took you off its reviewers on GitHub",
};
const go = (r: Route) => {
  location.hash = routeHash(r);
};
type Down = DeskUnreachable | DeskStarting | DeskConfigBroken; // why the API isn't usable right now
const isDown = (e: ApiError): e is Down => e._tag === "DeskUnreachable" || e._tag === "DeskStarting" || e._tag === "DeskConfigBroken";
const LIST = "desk.list"; // this device's choice: the list beside a review open or folded
const CHAT = "desk.chat"; // the chat open in this window, about this item ("" for nothing): kept through a reload
const DISMISSED = "desk.notices"; // this device's: the notices you dismissed, each as it was then
const CHAINS = "desk.chains"; // this device's: the chains whose steps you opened under their head, by the head's id
function chainsAtStart(): Set<string> {
  const raw = getStored(CHAINS);
  const parsed = raw ? parseJson(Schema.Array(Schema.String), raw) : null;
  return new Set(parsed && Result.isSuccess(parsed) ? parsed.success : []);
}
function dismissedAtStart(): Dismissed {
  const raw = getStored(DISMISSED);
  const parsed = raw ? parseJson(Schema.Record(Schema.String, Schema.String), raw) : null;
  return parsed && Result.isSuccess(parsed) ? parsed.success : {};
}
const LIST_PAGES = new Set<Route["name"]>(["queue", "blocked", "archive"]);
// Where the search has a list to read: the list pages and Merging, and a review or question with its list beside.
const SEARCHED = new Set<Route["name"]>([...LIST_PAGES, "inflight", "review", "inquiry"]);
// The sidebar's pages, top to bottom: ⌘1 to ⌘4 (Ctrl elsewhere) open them, as tabs' numbers do in a browser.
const SIDE_PAGES = ["queue", "blocked", "inflight", "archive"] as const;
// What Blocked and the Archive say with nothing on them.
const EMPTY = {
  blocked: "Nothing is blocked.",
  archive: "Nothing here yet: what you finish, and what's dealt with, lands here.",
};
const ignore = () => {};

// Whether the window is at least `px` wide, following it as it's resized.
function useWide(px: number): boolean {
  const query = `(width >= ${px}px)`;
  const [on, setOn] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const change = () => {
      setOn(m.matches);
    };
    change();
    m.addEventListener("change", change);
    return () => {
      m.removeEventListener("change", change);
    };
  }, [query]);
  return on;
}

// The desktop app's window needs room for the macOS traffic lights and a draggable title bar.
if (desktop) {
  document.documentElement.dataset.shell = "desktop";
  document.documentElement.dataset.platform = desktop.platform;
  adoptTheme();
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const [overview, setOverview] = useState<Overview | null>(null);
  const [setup, setSetup] = useState<SetupView | null>(null); // the first-run page, while the desk says it's needed
  const [desk, setView] = useState<QueueView | null>(null); // the queue as the desk last said it
  const deskSeq = useRef(0); // the load `desk` came from
  // Rows you finished, off the lists until a load started after the write is read: one already in flight can't draw them again.
  const gone = useShown<string, number>(desk, (_, at) => deskSeq.current > at);
  const view = useMemo(() => desk && (gone.shown.size ? withoutRows(desk, gone.shown) : desk), [desk, gone.shown]);
  const [down, setDown] = useState<Down | null>(null);
  const [epoch, setEpoch] = useState(0); // bumped to reopen the event stream
  const [now, setNow] = useState(() => Date.now());
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, ItemDetail | string>>({});
  const [noting, setNoting] = useState<Note | "new" | null>(null); // the note tray: a new note, or one you opened
  const [chainsOpen, setChainsOpen] = useState(chainsAtStart);
  // Stop waiting, until the desk's view has the step off every chain, where it goes.
  const unwaited = useShown<string, true>(desk, (id) => !!desk && !waitingSteps(desk).has(id));
  const noteEdits = useShown<string, Note | null>(desk, (id, n) => !!desk && hasNoteEdit(desk.notes, id, n));
  const [drops, setDrops] = useState<readonly Drop[]>([]); // rows you placed, drawn there until the desk's view is read back
  const newNotes = useRef(0);
  const noteClose = useRef<(() => void) | null>(null); // the open tray's way out, for Esc
  const setNoteClose = useCallback((leave: (() => void) | null) => {
    noteClose.current = leave;
  }, []);
  // Holding the platform's modifier alone for a moment shows each shortcut by its button, until it's let go or used.
  useEffect(() => {
    const key = MAC ? "Meta" : "Control";
    let t = 0;
    const off = () => {
      clearTimeout(t);
      delete document.documentElement.dataset.keys;
    };
    const held = (e: KeyboardEvent) => {
      if (e.key !== key) off();
      else if (!e.repeat) {
        clearTimeout(t);
        t = window.setTimeout(() => {
          document.documentElement.dataset.keys = "on";
        }, 300);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === key) off();
    };
    window.addEventListener("keydown", held, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", off);
    return () => {
      off();
      window.removeEventListener("keydown", held, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", off);
    };
  }, []);
  const [commenting, setCommenting] = useState<Card | null>(null); // the issue whose comment bar is open (its Comment, opened in place)
  // A row's menu: at a right-click, or under an issue's Snooze with Snooze open.
  const [menuAt, setMenuAt] = useState<{ id: string; x: number; y: number; snooze?: boolean; bulk?: boolean } | null>(null);
  const [picks, setPicked] = useState<string[]>([]); // rows picked by shift- or ⌘-click on a list page
  const stay = useRef<string | null>(null); // a row selected by a right-click: the page doesn't scroll to it under its menu
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  // Agents' questions you answered, gone at once, until the desk's view has them gone.
  const answered = useShown<string, true>(desk, (id) => !!desk && !desk.inquiries.some((q) => q.id === id));
  // What you did on an item from this page, until you leave it: a review shows it in place of the button you pressed.
  const [acted, setActed] = useState<Record<string, Acted | undefined>>({});
  const actedRef = useRef(acted);
  // Later's groups other than its own open on a click on their heading, and close again on reload.
  const [open, setOpen] = useState(DEFAULT_OPEN);
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState<string | null>(null); // a pasted link's PR or issue, on its way to the desk
  const [landing, setLanding] = useState<string | null>(null); // a pasted link's row, focused once it's drawn
  const [toast, setToast] = useState<Toast | null>(null);
  const [failures, setFailures] = useState<Notice[]>([]); // actions that failed, as bubbles that fade
  const [dismissed, setDismissed] = useState<Dismissed>(dismissedAtStart);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [section, setSection] = useState(route.name === "settings" ? route.section : "github"); // kept while on the queue
  const [settingsSeen, setSettingsSeen] = useState(route.name === "settings");
  const [loads, setLoads] = useState(0); // bumped on every refresh, so Rules can re-read a file changed on disk
  const [ruleFocus, setRuleFocus] = useState<RuleFocus | null>(null); // a row's "See the rule that put it here"
  const [tick, setTick] = useState(0); // bumped when an undo's hold on the selection runs out
  const [lane, setLane] = useState<InflightView | null>(null);
  // PRs you brought back from Merging: off it, and yours to hand off again, until Merging's read has them gone.
  const backed = useShown<string, true>(lane, (id) => !lane?.rows.some((r) => r.card.id === id));
  const [laneSel, setLaneSel] = useState<string | null>(null);
  const [reviewFrom, setReviewFrom] = useState<ListPage>("queue"); // where Esc goes back to from a review
  const [reviewQuestion, setReviewQuestion] = useState<string | null>(null); // or the agent's question it was opened from
  const [asking, setAsking] = useState<About | null>(() => {
    const kept = getStored(CHAT, true);
    return kept === null ? null : { item: kept || null, spot: null };
  }); // your chat with the coordinator, open
  const [spot, setSpot] = useState<Spot | null>(null); // where in the open review you last were
  const [pageQuestion, setPageQuestion] = useState<Inquiry | null>(null); // the question page's own copy, kept once it's answered
  const [askWaiting, setAskWaiting] = useState(false); // the open review's latest ask is unanswered (Review says, and unsays it as it goes)
  const [listFolded, setListFolded] = useState(() => getStored(LIST) === "folded");
  const [peek, setPeek] = useState(false); // the list opened beside the chat in a window under 1600px, until the chat closes
  const roomy = useWide(1160);
  const crowded = !useWide(1600);
  const chatOpen = !!asking;
  useEffect(() => {
    setStored(CHAT, asking ? (asking.item ?? "") : null, true);
  }, [asking]);
  useEffect(() => {
    setPeek(false);
  }, [chatOpen]);
  const rulesDirty = useRef(false);

  const routeRef = useRef(route);
  routeRef.current = route;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const downRef = useRef(down);
  downRef.current = down;
  const sourceDown = useSourceDown(down?._tag === "DeskUnreachable");
  const loadSeq = useRef(0);
  const refreshTimer = useRef(0);
  const toastTimer = useRef(0);
  const undoSeq = useRef<number[]>([]); // the desk's actions this window's Undo takes back, several after a bulk action
  const undoWrite = useRef<{ id: string; to: "reopen" | "ready" } | null>(null); // Undo after a close or a draft, instead
  const settingsSeq = useRef(0); // a GET that started before a save must not undo it
  const setupDone = useRef(false); // asked once the desk says the first-run page is done
  // An id we just asked for (e.g. after undo) that the next refresh will bring back.
  const pending = useRef<{ id: string; until: number } | null>(null);

  // A GitHub write's Undo lasts as long as its toast, so nothing can reopen or un-draft it hours later.
  // A failure with nothing to undo is a bubble at the window's edge, not the toast: the toast says what you did.
  const flash = useCallback((text: string, error = false, canUndo = false, ms = 6000, busy = false) => {
    clearTimeout(toastTimer.current);
    if (!canUndo) undoWrite.current = null;
    if (error && !canUndo) {
      setToast(null);
      setFailures((f) => withFailure(f, text, Date.now()));
      return;
    }
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

  const loadSettings = useCallback(
    (): Effect.Effect<void> =>
      Effect.suspend(() => {
        const sn = ++settingsSeq.current;
        return api.settings().pipe(
          Effect.tap((s) =>
            Effect.sync(() => {
              if (sn === settingsSeq.current) setSettings(s);
            }),
          ),
          Effect.ignore, // the next refresh asks again
        );
      }),
    [],
  );

  const load = useCallback(
    (): Effect.Effect<void> =>
      Effect.suspend(() => {
        const r = routeRef.current;
        const exp = expandedRef.current;
        const n = ++loadSeq.current;
        const views = Effect.all(
          [
            api.overview(),
            // Always: the sidebar shows the queue's counts on every page.
            api.queue(),
            exp ? api.item(exp).pipe(Effect.catch((e) => Effect.succeed(e.message))) : Effect.succeed(null),
            // A review of your PR in Merging shows its Merging line too.
            r.name === "inflight" || r.name === "review" ? api.inflight() : Effect.succeed(null),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.match({
            onSuccess: ([ov, v, d, l]) => {
              if (n !== loadSeq.current) return;
              setAiName(ov.ai_agent);
              setOverview(ov);
              startSentry(ov.sentry);
              if (l) setLane(l);
              setNow(Date.now());
              setLoads((x) => x + 1);
              // The dev proxy keeps a dead upstream's event stream open, so reopen it once the API answers again.
              if (downRef.current) setEpoch((x) => x + 1);
              setDown(null);
              deskSeq.current = n;
              setView(v);
              if (exp && d) setDetails((m) => ({ ...m, [exp]: d }));
            },
            onFailure: (e) => {
              if (n !== loadSeq.current) return;
              if (isDown(e)) setDown((cur) => (cur?._tag === e._tag && cur.message === e.message ? cur : e));
              else flash(e.message, true);
            },
          }),
        );
        const page = r.name === "settings" ? Effect.all([loadSettings(), views], { concurrency: "unbounded", discard: true }) : views;
        if (setupDone.current) return page;
        // Until the desk says the first-run page is done, it's asked first; a desk that doesn't answer is said as before.
        return api.setup().pipe(
          Effect.matchEffect({
            onSuccess: (s) =>
              Effect.suspend(() => {
                if (n !== loadSeq.current) return Effect.void;
                setSetup(s);
                if (s.needed) return Effect.void;
                setupDone.current = true;
                return page;
              }),
            onFailure: () => page,
          }),
        );
      }),
    [flash, loadSettings],
  );

  const refresh = useCallback(
    (ms = 300) => {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        runUi(load());
      }, ms);
    },
    [load],
  );

  // Where a list page was scrolled when a review or a question was opened from it: coming back, it opens there again.
  const left = useRef<{ page: Route["name"]; y: number } | null>(null);
  useEffect(() => {
    const on = () => {
      const next = parseRoute(location.hash);
      if (LIST_PAGES.has(routeRef.current.name)) left.current = { page: routeRef.current.name, y: window.scrollY };
      setRoute(next);
      setSpot(null); // a review you come back to asks about the PR until you pick a spot in it again
      // Your chat stays open wherever you go until you close it: in a review it's about that PR, elsewhere about what it was, no spot.
      setAsking((a) => {
        if (!a) return a;
        if (next.name === "review") return a.item === next.id ? a : { item: next.id, spot: null };
        return a.spot ? { ...a, spot: null } : a;
      });
    };
    window.addEventListener("hashchange", on);
    return () => {
      window.removeEventListener("hashchange", on);
    };
  }, []);

  // A list page opens at its top, or, back from a review or a question opened from it, where it was: never at the scroll of
  // the page before. Before the selection effect, which then brings a kept row into view.
  const lastPage = useRef(route.name);
  useLayoutEffect(() => {
    const from = lastPage.current;
    lastPage.current = route.name;
    if (from === route.name || !LIST_PAGES.has(route.name)) return;
    const returning = (from === "review" || from === "inquiry") && left.current?.page === route.name;
    window.scrollTo(0, returning ? left.current!.y : 0);
  }, [route.name]);

  const settingsSection = route.name === "settings" ? route.section : null;
  useEffect(() => {
    // A new page drops focus, but not from the search: typing there may be what brought you here.
    const el = document.activeElement;
    if (el instanceof HTMLElement && !el.closest(".side-search")) el.blur();
    setExpanded(null);
    // Settings scrolls itself, to the part or view the link names, once its parts have loaded.
    if (settingsSection !== null) {
      setSection(settingsSection);
      setSettingsSeen(true);
    } else if (rulesDirty.current) flash("Your rule edits are kept. Save them in Settings → GitHub → Searches and rules.");
    const stop = new AbortController();
    runUi(load(), { signal: stop.signal });
    return () => {
      stop.abort();
    };
  }, [settingsSection, flash, load]);

  const onLane = route.name === "inflight";
  // A page opens with nothing selected; a trip into a review or a question and back keeps the row you opened.
  const lastRoute = useRef(route.name);
  useEffect(() => {
    const from = lastRoute.current;
    lastRoute.current = route.name;
    const trip = (n: Route["name"]) => n === "review" || n === "inquiry";
    if (trip(route.name) || trip(from)) return;
    setSelected(null);
    setLaneSel(null);
  }, [route]);
  // A review belongs to the page it was opened from: Esc, the back link and the sidebar go back there.
  const lastReview = useRef<string | null>(null);
  useEffect(() => {
    const was = lastReview.current;
    lastReview.current = route.name === "review" ? route.id : null;
    if (route.name === "review") {
      // Another review, from the list beside it or its stack: the way back is the list's page, not the question.
      if (was !== null && was !== route.id) setReviewQuestion(null);
      return;
    }
    setReviewFrom(
      route.name === "settings" || route.name === "inquiry" || route.name === "item" || route.name === "doc" || route.name === "log"
        ? "queue"
        : route.name,
    );
    setReviewQuestion(route.name === "inquiry" ? route.id : null);
  }, [route]);
  useEffect(() => {
    const stop = new AbortController();
    if (onLane) {
      window.scrollTo(0, 0);
      runUi(load(), { signal: stop.signal });
    }
    return () => {
      stop.abort();
    };
  }, [onLane, load]);

  // While the window shows, the desk reads GitHub sooner; a desk that can't hear it (down, or older) is no news here.
  const look = useCallback(() => {
    if (document.visibilityState === "visible") runUi(Effect.ignore(api.look()));
  }, []);

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
        look();
        refresh();
        runUi(loadOmarchy());
      });
      es.addEventListener("omarchy", (e) => {
        // One that doesn't read leaves the theme as it is.
        const data: unknown = e instanceof MessageEvent ? e.data : null;
        const o = typeof data === "string" ? parseJson(OmarchyAnswer, data) : null;
        if (o && Result.isSuccess(o)) omarchyIs(o.success);
      });
      es.addEventListener("error", () => {
        // While the browser retries, the stream sits in CONNECTING; a fetch tells us whether the server is gone.
        refresh(0);
        if (es?.readyState !== EventSource.CLOSED) return;
        setDown((d) => d ?? new DeskUnreachable({}));
        retry = window.setTimeout(connect, 5000);
      });
    };
    connect();
    const visible = () => {
      look();
      if (document.visibilityState === "visible") refresh(0);
    };
    document.addEventListener("visibilitychange", visible);
    const looking = window.setInterval(look, 30_000);
    return () => {
      es?.close();
      clearTimeout(retry);
      clearInterval(looking);
      document.removeEventListener("visibilitychange", visible);
    };
    // Bumping epoch is how a dead stream gets reopened.
  }, [refresh, look, epoch]);

  // A desk from a checkout is back within a second or two of a change.
  const quick = sourceDown?.state === "running";
  useEffect(() => {
    const t = down
      ? setInterval(
          () => {
            runUi(load());
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
  // The desk's view with the rows you placed where you put them, until it's read back.
  const placed = useMemo(() => (view && drops.length ? withDrops(view, drops) : view), [view, drops]);
  const groups = useMemo(() => groupsOf(placed, open, filter, me), [placed, open, filter, me]);
  // One search for every page: a page with no list (Settings) takes you to the Inbox to search it.
  const searchFor = (s: string) => {
    setFilter(s);
    if (s.trim() && !SEARCHED.has(route.name)) go({ name: "queue" });
  };
  // A pasted link: the page that lists it when the desk has it, else it's added (pinned, as inbox add does) and the Inbox says
  // so until the desk's list has it.
  const pasted = (ref: string) => {
    const id = [...known.keys()].find((k) => k.toLowerCase() === ref.toLowerCase());
    if (id) {
      const at = view && whereIs(view, id);
      if (lane?.rows.some((r) => r.card.id === id)) go({ name: "inflight" });
      else if (at) go({ name: at.page });
      setLanding(id);
      return;
    }
    go({ name: "queue" });
    setAdding(ref);
    runUi(
      Effect.gen(function* () {
        const res = yield* api.add(ref);
        yield* load();
        setLanding(res.item.card.id);
        undoSeq.current = res.undo_seq ? [res.undo_seq] : [];
        undoWrite.current = null;
        flash(`Added: ${shortRef(res.item.card)}`, false, true);
      }).pipe(
        Effect.catch(failed),
        Effect.ensuring(
          Effect.sync(() => {
            setAdding(null);
          }),
        ),
      ),
    );
  };
  const search = <Filter filter={filter} setFilter={searchFor} onLink={pasted} />;
  // Focusing the row selects it, as a click or ↓ would; tried again as its page and the desk's state arrive.
  useKeyedLayout(landing === null ? null : `${landing} ${route.name} ${loads}`, () => {
    const row = document.querySelector(`.main [data-id="${CSS.escape(landing ?? "")}"]`);
    const at = row?.querySelector<HTMLElement>(".row-main") ?? (row instanceof HTMLElement ? row : null);
    if (!at) return;
    at.focus();
    setLanding(null);
  });
  // The selection goes through the page on screen: the queue, or Later's groups; in a review, the page it came from.
  const list = route.name === "review" ? reviewFrom : route.name;
  const page = useMemo(() => {
    const keys = PAGE_GROUPS[list === "archive" || list === "blocked" ? list : "queue"];
    return groups.filter((g) => keys.includes(g.key));
  }, [groups, list]);
  const flat = useMemo(() => navigable(page, leaving), [page, leaving]);
  // The list on screen, or beside a review or a question: a review's is the page it was opened from, a question's the Inbox.
  const listPage = pageOf(route, reviewFrom);
  // The page's filters, on its head or on the list beside an open item: the kinds of row its rows have, then the filter by
  // person. Each offers what's on the rows the other leaves.
  const pageCards = useMemo(() => {
    if (listPage === "inflight") return (lane?.rows ?? []).map((r) => r.card);
    const keys = listPage ? PAGE_GROUPS[listPage] : [];
    return groupsOf(placed, DEFAULT_OPEN, "")
      .filter((g) => keys.includes(g.key))
      .flatMap((g) => g.cards);
  }, [listPage, lane, placed]);
  const kinds = useMemo(() => kindButtons(pageCards, filter, me), [pageCards, filter, me]);
  const people = useMemo(() => filterPeople(pageCards, filter, me), [pageCards, filter, me]);
  const filters = (
    <div className="head-filters">
      <ShowFilter filter={filter} setFilter={setFilter} kinds={kinds} />
      <PeopleFilter filter={filter} setFilter={setFilter} people={people} me={me} />
    </div>
  );
  const laneList = listPage === "inflight";
  // Agents' questions lead the main page (one waits on each); the filter reads them too.
  const inquiries = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (listPage !== "queue") return []; // on a question's page, the queue's cursor stays on it
    return (placed?.inquiries ?? []).filter(
      (q) => !answered.shown.has(q.id) && (!f || q.question.toLowerCase().includes(f) || q.from.toLowerCase().includes(f)),
    );
  }, [placed, answered, filter, listPage]);
  // Then the sessions that need you, which the filter reads too.
  const sessions = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (listPage !== "queue") return [];
    return (view?.sessions ?? []).filter(
      (s) => s.status === "active" && !leaving.has(s.id) && (!f || [s.name, s.reason, s.cwd].some((x) => x.toLowerCase().includes(f))),
    );
  }, [view, leaving, filter, listPage]);
  // The queue with your note writes on it until the desk's view has them.
  const queueView = useMemo(
    () =>
      placed &&
      (noteEdits.shown.size ? { ...placed, notes: withNoteEdits(placed.notes, noteEdits.shown, new Date(now).toISOString()) } : placed),
    [placed, noteEdits.shown, now],
  );
  // Your notes, wherever their rows are (the Inbox, or the Archive while a reminder waits): each has a right-click menu.
  const notes = useMemo(
    () =>
      queueView
        ? [...queueView.notes.due, ...queueView.notes.urgent, ...queueView.notes.open, ...queueView.notes.fyi, ...queueView.notes.later]
        : [],
    [queueView],
  );
  const cursor = useMemo(() => [...inquiries.map((q) => inquiryOf(q.id)), ...stops(page, leaving)], [inquiries, page, leaving]);
  const current = flat.find((c) => c.id === selected) ?? null;
  // The queue's view holds open questions only; an answered one's page still says whose it is and what it's about.
  const questionOf = (id: string) => view?.inquiries.find((q) => q.id === id) ?? (pageQuestion?.id === id ? pageQuestion : undefined);
  // Merging as the search and Back to desk leave it.
  const laneShown = useMemo(() => {
    const q = filter.trim();
    const shown = (r: InflightRow) => !backed.shown.has(r.card.id) && (!q || matches(r.card, q, me));
    return lane && (q || backed.shown.size) ? { ...lane, rows: lane.rows.filter(shown) } : lane;
  }, [lane, filter, me, backed.shown]);
  const laneRows = useMemo(() => laneShown?.rows ?? [], [laneShown]);
  const laneCur = laneRows.find((r) => r.card.id === laneSel) ?? null;
  // Every card on the desk the client has, by id: a review opens on its row's card while the rest is on its way.
  const known = useMemo(() => {
    const m = new Map<string, Card>();
    if (view) for (const c of [...Object.values(view.sections).flat(), ...view.hidden, ...view.cleared, ...view.resolved]) m.set(c.id, c);
    for (const r of lane?.rows ?? []) m.set(r.card.id, r.card);
    for (const id of backed.shown.keys()) {
      const c = m.get(id);
      if (c) m.set(id, { ...c, inflight: false });
    }
    return m;
  }, [view, lane, backed.shown]);
  const knownRef = useRef(known);
  knownRef.current = known;

  // A permalink (#/item/<id>) once the lists are in: a PR, or what no list has, opens its review; an issue opens in place on
  // the page that lists it, its group open, in place of the link in the history.
  const opening = useRef<string | null>(null);
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => {
    if (route.name !== "item" || !view) return;
    const at = known.get(route.id)?.kind === "issue" ? whereIs(view, route.id) : null;
    if (at) {
      opening.current = route.id;
      setOpen((o) => ({ ...o, [at.group]: true }));
    }
    location.replace(routeHash(at ? { name: at.page } : { name: "review", id: route.id }));
  }, [route, view, known]);
  useEffect(() => {
    if (route.name === "item" || opening.current === null) return;
    const c = knownRef.current.get(opening.current);
    opening.current = null;
    if (c) toggleRef.current(c);
  }, [route]);

  // The cards of the rows on screen: Merging's on its page or beside a review from it, else the list's, so a stale Merging
  // card never stands in.
  const onScreen = useMemo(
    () => (laneList ? laneRows.map((r) => r.card) : page.flatMap((g) => (g.open ? g.cards : []))),
    [laneList, laneRows, page],
  );
  // What's picked of the rows on screen: a row that left, or a group you closed, isn't.
  const pickedOn = useMemo(() => picks.filter((id) => onScreen.some((c) => c.id === id && !leaving.has(id))), [picks, onScreen, leaving]);
  useEffect(() => {
    setPicked([]);
  }, [route.name]);
  // A right-click on a row, wherever it is (the queue, Later, the Archive, Merging), selects it and opens its menu, an
  // agent's question's too; beside a review it only marks the row while its menu is open, so the page's own selection is
  // the one you left it with.
  function rowMenu(x: number, y: number, target: Element | null): boolean {
    const id = target?.closest<HTMLElement>(".line[data-id]")?.dataset.id;
    if (
      !id ||
      !(
        onScreen.some((c) => c.id === id) ||
        inquiries.some((q) => inquiryOf(q.id) === id) ||
        sessions.some((s) => s.id === id) ||
        notes.some((n) => noteOf(n.id) === id) ||
        stepOf(id, [...onScreen, ...notes])
      )
    ) {
      stay.current = null;
      setMenuAt(null);
      return false;
    }
    stay.current = id;
    // On one of several picked rows: the menu for all of them. Anywhere else drops the picks.
    const bulk = pickedOn.length > 1 && pickedOn.includes(id);
    if (!bulk) setPicked([]);
    if (!target?.closest(".beside")) {
      if (laneList) setLaneSel(id);
      else setSelected(id);
    }
    setMenuAt({ id, x, y, bulk });
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
  // A right-click outside the open menu: the menu of the row there, if any.
  const reopenMenu = (x: number, y: number) => {
    const under = document.elementsFromPoint(x, y).find((n) => !n.closest(".ctx, .scrim-clear"));
    rowMenu(x, y, under ?? null);
  };
  const menuCard = menuAt ? onScreen.find((c) => c.id === menuAt.id) : undefined;
  const pickedCards = onScreen.filter((c) => pickedOn.includes(c.id));
  const bulkLeft = pickedCards.length;
  const menuQuestion = menuAt ? inquiries.find((q) => inquiryOf(q.id) === menuAt.id) : undefined;
  const menuSession = menuAt ? sessions.find((x) => x.id === menuAt.id) : undefined;
  const menuNote = menuAt ? notes.find((n) => noteOf(n.id) === menuAt.id) : undefined;
  const menuStep = menuAt ? stepOf(menuAt.id, [...onScreen, ...notes]) : undefined;
  const closeMenu = useCallback(() => {
    stay.current = null;
    setMenuAt(null);
  }, []);
  // Its row left the page (sorted away, resolved, acted on elsewhere): the menu goes with it, for good.
  useEffect(() => {
    if (menuAt && ((!menuCard && !menuQuestion && !menuSession && !menuNote && !menuStep) || (menuAt.bulk && bulkLeft < 2))) closeMenu();
  }, [menuAt, menuCard, menuQuestion, menuSession, menuNote, menuStep, bulkLeft, closeMenu]);

  // The PR row you rest on, by Tab or the pointer, has its review fetched ahead, so opening it doesn't wait on GitHub.
  const onRow =
    route.name === "inflight"
      ? (laneCur?.card ?? null)
      : route.name === "queue" || route.name === "archive" || route.name === "blocked"
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

  // Nothing is selected until you focus, right-click or open a row; a row that leaves takes its selection with it.
  useEffect(() => {
    if (selected === null || cursor.includes(selected)) return;
    if (pending.current?.id === selected && Date.now() < pending.current.until) return; // an undo brings it back
    setSelected(null);
    // tick re-checks once the undo hold has run out.
  }, [cursor, selected, tick]);

  // A group's first row brings its heading along (the page's first, the top of the page), so no heading sits under the page head.
  useEffect(() => {
    if (!selected || !LIST_PAGES.has(route.name) || stay.current === selected) return;
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

  function fetchDetail(id: string): Effect.Effect<void> {
    return api.item(id).pipe(
      Effect.match({
        onSuccess: (d) => {
          setDetails((m) => ({ ...m, [id]: d }));
        },
        onFailure: (e) => {
          setDetails((m) => ({ ...m, [id]: e.message }));
        },
      }),
    );
  }

  function seen(c: Card): Effect.Effect<void> {
    if (!c.new) return Effect.void;
    return api.act(c.id, "seen").pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          refresh();
        }),
      ),
      Effect.ignore, // it stays marked new until it's opened again
    );
  }

  // An open issue whose pre-review is on its way is read again on each update, so it shows once it's written.
  useKeyed(loads, () => {
    const d = expanded ? details[expanded] : undefined;
    if (expanded && typeof d === "object" && d.issue_ai_state === "running") runUi(fetchDetail(expanded));
  });

  function toggle(c: Card) {
    setSelected(c.id);
    if (expanded === c.id) {
      setExpanded(null);
      return;
    }
    setExpanded(c.id);
    runUi(fetchDetail(c.id));
    runUi(seen(c));
  }

  const failed = (e: { message: string }) =>
    Effect.sync(() => {
      flash(e.message, true);
    });
  const refreshNow = Effect.sync(() => {
    refresh(0);
  });

  function act(c: Card, action: Action, until?: string): Effect.Effect<void> {
    // A resolved item stays under Resolved whatever you do to it.
    const leaves = LEAVES.has(action) && c.status === "active" && !c.resolved;
    // A move to another section is drawn there at once, where the desk puts it, as a drop is.
    const to = action === "urgent" || action === "standard" || action === "fyi" ? { id: c.id, section: action } : null;
    return Effect.gen(function* () {
      if (leaves) hide(c);
      if (to) setDrops((x) => [...x.filter((y) => y.id !== c.id), to]);
      const started = Date.now();
      const res = yield* api.act(c.id, action, until);
      if (to) yield* load();
      undoSeq.current = res.undo_seq ? [res.undo_seq] : []; // before the animation, so a quick Undo undoes this action
      undoWrite.current = null;
      if (leaves) {
        yield* Effect.sleep(Math.max(0, 200 - (Date.now() - started)));
        gone.show(c.id, loadSeq.current);
      }
      const verb = action === "snooze" ? `Snoozed ${snoozeOptions(c).find((o) => o.until === until)?.toast ?? ""}` : VERB[action];
      flash(`${verb}: ${shortRef(c)}`, false, true);
    }).pipe(
      Effect.catch(failed),
      Effect.ensuring(
        Effect.sync(() => {
          if (leaves) unhide(c.id);
          if (to) setDrops((x) => x.filter((y) => y !== to));
          refresh(0);
        }),
      ),
    );
  }

  // A row you dragged, or moved up or down from its menu: drawn where you put it at once, then the desk's view read back;
  // a refusal puts it back and says why. A move to another section says so, with Undo.
  function place(d: Drop) {
    setDrops((x) => [...x.filter((y) => y.id !== d.id), d]);
    const cross = view && INBOX_SECTIONS.find((s) => view.inbox[s].some((c) => c.id === d.id));
    runUi(
      Effect.gen(function* () {
        const res = yield* api.place(d.id, d.section, { ...(d.after && { after: d.after }), ...(d.before && { before: d.before }) });
        yield* load();
        if (cross && cross !== d.section) {
          undoSeq.current = res.undo_seq ? [res.undo_seq] : [];
          undoWrite.current = null;
          const c = known.get(d.id);
          flash(`${VERB[d.section] ?? ""}${c ? `: ${shortRef(c)}` : ""}`, false, true);
        }
      }).pipe(
        Effect.catch(failed),
        Effect.ensuring(
          Effect.sync(() => {
            setDrops((x) => x.filter((y) => y !== d));
          }),
        ),
      ),
    );
  }
  const reorder = useReorder(place);
  // The menu's Move up and Move down, as a drag past the row of its kind above or below.
  const stepsOf = (id: string): Steps => {
    const at = stepDrops(id);
    const by = (d: Drop | undefined) =>
      d &&
      (() => {
        place(d);
      });
    const above = by(at.up);
    const below = by(at.down);
    return { ...(above && { up: above }), ...(below && { down: below }) };
  };

  // One action on several picked rows: each leaves at once as it would alone, and one Undo takes them all back.
  function actAll(cs: Card[], action: Action, until?: string): Effect.Effect<void> {
    const leaves = cs.filter((c) => LEAVES.has(action) && c.status === "active" && !c.resolved);
    return Effect.gen(function* () {
      setPicked([]);
      leaves.forEach(hide);
      const started = Date.now();
      const results = yield* Effect.forEach(
        cs,
        (c) =>
          api.act(c.id, action, until).pipe(
            Effect.map((r) => ({ c, seq: r.undo_seq })),
            Effect.catch((e) => Effect.as(failed(e), null)),
          ),
        { concurrency: 4 },
      );
      const ok = results.filter((r) => r !== null);
      undoSeq.current = ok.flatMap((r) => (r.seq ? [r.seq] : []));
      undoWrite.current = null;
      yield* Effect.sleep(Math.max(0, 200 - (Date.now() - started)));
      for (const r of ok) if (leaves.includes(r.c)) gone.show(r.c.id, loadSeq.current);
      const first = cs[0];
      const verb =
        action === "snooze" && first ? `Snoozed ${snoozeOptions(first).find((o) => o.until === until)?.toast ?? ""}` : VERB[action];
      if (ok.length) flash(`${verb}: ${ok.length} ${ok.length === 1 ? "item" : "items"}`, false, true);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          for (const c of leaves) unhide(c.id);
          refresh(0);
        }),
      ),
    );
  }

  // A click on an agent's question: its own page, with all it said.
  function openInquiry(q: Inquiry) {
    setSelected(inquiryOf(q.id));
    go({ name: "inquiry", id: q.id });
  }

  // A session's triage: it fades off the list at once, and comes back if the desk refuses.
  function sessionAct(s: SessionCard, action: "done" | "snooze" | "mute", until = "tomorrow") {
    if (selected === s.id) setSelected(null);
    if (expanded === s.id) setExpanded(null);
    setLeaving((x) => new Set(x).add(s.id));
    runUi(
      api.act(s.id, action, action === "snooze" ? until : undefined).pipe(
        Effect.tap((res) =>
          Effect.sync(() => {
            undoSeq.current = res.undo_seq ? [res.undo_seq] : [];
            undoWrite.current = null;
            // Off the list before it's unhidden, so it doesn't flash back until the refresh lands.
            gone.show(s.id, loadSeq.current);
            const snoozed = SNOOZE.find((o) => o.until === until)?.toast.replace(/ \(or .*\)$/, "") ?? until;
            flash(`${action === "snooze" ? `Snoozed ${snoozed}` : VERB[action]}: ${s.name}`, false, true);
          }),
        ),
        Effect.catch(failed),
        Effect.ensuring(
          Effect.sync(() => {
            unhide(s.id);
            refresh(0);
          }),
        ),
      ),
    );
  }

  // Kick and Resume start it again where it left off, Open follows its own link, Copy attach command copies it; the desk
  // refuses in words what it won't do (its process runs, its rate limit hasn't reset).
  function sessionStart(s: SessionCard, action: SessionAction) {
    const step: Effect.Effect<string, ApiError | ClipboardUnavailable> =
      action === "attach"
        ? s.attach
          ? Effect.as(copyText(s.attach), "Copied. Run it in a terminal to open the session.")
          : Effect.succeed("")
        : action === "open"
          ? Effect.as(api.openSession(s.id), `Opened ${s.name}.`)
          : Effect.as(api.kickSession(s.id), `${action === "kick" ? "Kicked" : "Resumed"} ${s.name}: it carries on in the background.`);
    runUi(
      step.pipe(
        Effect.tap((text) =>
          Effect.sync(() => {
            if (text) flash(text);
            if (action === "kick" || action === "resume") refresh(0);
          }),
        ),
        Effect.catch(failed),
      ),
    );
  }

  // A row leaving the list: it fades out, and takes its selection with it.
  function hide(c: Card) {
    if (selected === c.id) setSelected(null);
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

  // A note to yourself, new or changed: drawn at once, put back if the desk refuses it; true once the desk has it.
  function saveNote(n: Note | null, text: string, remind: string, put?: InboxSection): Effect.Effect<boolean> {
    return Effect.suspend(() => {
      const at = new Date();
      const key = n?.id ?? `new-${++newNotes.current}`;
      const remind_at = remind ? (untilTime(remind, at)?.toISOString() ?? null) : null;
      const where = put ?? n?.section;
      const drawn: Note = {
        ...n,
        id: key,
        at: n?.at ?? at.toISOString(),
        text: text.trim(),
        remind_at,
        reminded_at: n && remind_at === n.remind_at ? n.reminded_at : null,
        ...(where && { section: where }),
      };
      noteEdits.show(key, drawn);
      return api.saveNote(n?.id ?? null, { text, remind, ...(put && { section: put }) }).pipe(
        Effect.match({
          onSuccess: ({ note }) => {
            noteEdits.drop(key);
            noteEdits.show(note.id, note);
            flash(note.remind_at ? `I'll remind you ${when(note.remind_at)}` : n ? "Note changed" : "Noted: it's on your Inbox");
            return true;
          },
          onFailure: (e) => {
            noteEdits.drop(key);
            flash(e.message, true);
            return false;
          },
        }),
        Effect.tap(refreshNow),
      );
    });
  }
  function doneNote(n: Note) {
    noteEdits.show(n.id, null);
    runUi(
      api.doneNote(n.id).pipe(
        Effect.match({
          onSuccess: () => {
            flash("Note done");
          },
          onFailure: (e) => {
            noteEdits.drop(n.id);
            flash(e.message, true);
          },
        }),
        Effect.tap(refreshNow),
      ),
    );
  }
  // An automation's note's Ask button: it leaves at once, handed to your agent; put back if the desk refuses.
  function pressNote(n: Note, button: number) {
    noteEdits.show(n.id, null);
    runUi(
      api.askNote(n.id, button).pipe(
        Effect.match({
          onSuccess: () => {
            flash("Asked your agent");
          },
          onFailure: (e) => {
            noteEdits.drop(n.id);
            flash(e.message, true);
          },
        }),
        Effect.tap(refreshNow),
      ),
    );
  }
  // A chain's steps, open under its head or folded, as you left them on this device; a step opens as its row would.
  const chains: ChainCtx = {
    open: chainsOpen,
    toggle: (head) => {
      const next = toggled(chainsOpen, head);
      setChainsOpen(next);
      setStored(CHAINS, next.size ? JSON.stringify([...next]) : null);
    },
    step: (s) => {
      if (s.note) setNoting(s.note);
      else if (s.kind === "issue") window.open(s.url, "_blank", "noopener,noreferrer");
      else {
        setSelected(s.id);
        go({ name: "review", id: s.id });
      }
    },
    gone: unwaited.shown,
  };
  // Stop waiting: off its chain at once, onto your desk where its own placement puts it once the desk answers.
  function stopWaiting(s: WaitingStep) {
    unwaited.show(s.id, true);
    runUi(
      api.after(s.id, []).pipe(
        Effect.match({
          onSuccess: () => {
            flash(`Stopped waiting: ${s.ref || s.title}`);
          },
          onFailure: (e) => {
            unwaited.drop(s.id);
            flash(e.message, true);
          },
        }),
        Effect.tap(refreshNow),
      ),
    );
  }
  const note: NoteCtx = {
    now,
    selected,
    open: (n) => {
      setNoting(n);
    },
    done: doneNote,
    press: pressNote,
    chains,
    me: overview?.me ?? "",
  };

  // Your answer to an agent's question (or leaving it unanswered): it leaves the main page at once while its page stays,
  // saying so; a refusal brings it back. True once the desk has it.
  function answerInquiry(q: Inquiry, text: string, dismiss = false): Effect.Effect<boolean> {
    return Effect.suspend(() => {
      const id = inquiryOf(q.id);
      if (selected === id) setSelected(null);
      answered.show(q.id, true);
      return api.answerInquiry(q.id, dismiss ? { dismiss: true } : { text }).pipe(
        Effect.match({
          onSuccess: () => {
            const said = q.fix
              ? text === AGREE
                ? "Agreed: done"
                : text === DISAGREE
                  ? "Disagreed: dropped"
                  : `Sent: ${q.from} recommends again`
              : `Answered ${fromName(q.from, false)}`;
            flash(dismiss ? `Dismissed ${fromName(q.from, false)}'s question` : said);
            return true;
          },
          onFailure: (e) => {
            answered.drop(q.id);
            setSelected(id);
            flash(e.message, true);
            return false;
          },
        }),
        Effect.tap(refreshNow),
      );
    });
  }

  // What you did on it from its review, shown there in place of the button you pressed; null once that's undone.
  function markActed(id: string, to: Acted | null) {
    actedRef.current = { ...actedRef.current, [id]: to ?? undefined };
    setActed(actedRef.current);
  }

  // A write that finishes your part takes it off the list at once, with a spinner in the toast until GitHub has it; a
  // refusal brings it back. A review stays open, saying what you did and where it went (`did`). `error` on what the write
  // returns: done, but with something to say. True once GitHub has it.
  function finish(
    c: Card,
    sending: string,
    did: Acted,
    write: Effect.Effect<{ text: string; error?: boolean; undo?: boolean; stays?: boolean }, ApiError>,
    shown = true, // false: the review says it only while sending (a comment), so what you'd do next is still there
  ): Effect.Effect<boolean> {
    return Effect.suspend((): Effect.Effect<boolean> => {
      // Still sending from this review: a second press waits for it. Once it's done, the next write (Hand off after Approve) goes.
      if (actedRef.current[c.id]?.sending && routeRef.current.name === "review") {
        flash(`Still sending ${actedRef.current[c.id]?.what ?? "that"}: try again in a moment`, true);
        return Effect.succeed(false);
      }
      const before = actedRef.current[c.id] ?? null; // what it says again if this one isn't shown or is refused
      const mark = (to: Acted | null) => {
        markActed(c.id, to);
      };
      mark({ ...did, sending: true });
      hide(c);
      flash(sending, false, false, 60_000, true);
      return write.pipe(
        Effect.match({
          onSuccess: (r) => {
            // Still on your desk (ready with nobody asked to review it): it went nowhere, and its next step shows in place.
            mark(r.stays || !shown ? before : { ...did, sending: false });
            if (!r.stays) gone.show(c.id, loadSeq.current);
            flash(r.text, r.error, r.undo);
            return true;
          },
          onFailure: (e) => {
            mark(before);
            flash(e.message, true);
            return false;
          },
        }),
        Effect.ensuring(
          Effect.sync(() => {
            unhide(c.id);
            refresh(0);
          }),
        ),
      );
    });
  }

  function undo(): Effect.Effect<void> {
    return Effect.suspend((): Effect.Effect<void> => {
      const w = undoWrite.current;
      if (w) {
        undoWrite.current = null;
        // Marking it ready took it off your desk, unless nobody's asked to review it; undoing the draft keeps it where it was.
        const revert: Effect.Effect<unknown, ApiError> =
          w.to === "ready"
            ? api.ready(w.id).pipe(Effect.flatMap((r): Effect.Effect<unknown, ApiError> => (r.done ? api.act(w.id, "undo") : Effect.void)))
            : api.github(w.id, "reopen");
        return revert.pipe(
          Effect.match({
            onSuccess: () => {
              markActed(w.id, null);
              flash(`Undid it on GitHub: ${shortId(w.id)} is ${w.to === "ready" ? "ready for review" : "open"} again`);
            },
            onFailure: (e) => {
              flash(e.message, true);
            },
          }),
          Effect.andThen(refreshNow),
        );
      }
      // Only what this window did: it must not walk back yesterday's history.
      const seqs = undoSeq.current;
      const [first, ...rest] = seqs;
      if (first === undefined) {
        flash("Nothing to undo in this window");
        return Effect.void;
      }
      undoSeq.current = [];
      // The latest first; the last one undone is the one that's selected and said.
      return Effect.forEach(rest.toReversed(), (seq) => api.undo(seq)).pipe(
        Effect.andThen(api.undo(first)),
        Effect.match({
          onSuccess: (r) => {
            markActed(r.id, null);
            pending.current = { id: r.id, until: Date.now() + 2000 };
            setSelected(r.id);
            // If the item comes back into a closed group, let the selection move on once the wait is over.
            setTimeout(() => {
              setTick((t) => t + 1);
            }, 2100);
            flash(`Undid ${r.action ?? "that"} on ${seqs.length > 1 ? `${seqs.length} items` : shortId(r.id)}`);
            refresh(0);
          },
          onFailure: (e) => {
            flash(e.message, true);
          },
        }),
      );
    });
  }

  function sync(): Effect.Effect<void> {
    return Effect.suspend(() => {
      setOverview((o) => o && { ...o, syncing: true });
      return api.sync().pipe(
        Effect.catchTag("DeskUnreachable", () => Effect.void), // the banner says so
        Effect.catch(failed),
        Effect.andThen(refreshNow),
      );
    });
  }

  // The app restarts into the newer Inbox it downloaded; the overview says how it's going.
  function update(): Effect.Effect<void> {
    return Effect.suspend(() => {
      setOverview((o) => (o?.update ? { ...o, update: { ...o.update, installing: true } } : o));
      return api.update().pipe(Effect.catch(failed), Effect.andThen(refreshNow));
    });
  }

  // A PR opens its review in place of the queue; an issue opens in place.
  function openCard(c: Card) {
    setPicked([]);
    if (c.kind !== "pr") {
      toggle(c);
      return;
    }
    setSelected(c.id);
    go({ name: "review", id: c.id });
    runUi(seen(c));
  }

  // Hand off for merge: your own open PR goes to Merging (you're done; your agent gets it merged). Back to desk undoes it.
  function handOff(c: Card) {
    backed.drop(c.id);
    const write = api.act(c.id, "inflight").pipe(
      Effect.map(() => {
        undoSeq.current = [];
        return { text: `Handed off for merge: ${shortRef(c)}. Your agent gets it merged.` };
      }),
    );
    runUi(finish(c, `Handing off ${shortRef(c)}…`, { what: "Handed off for merge", where: "inflight" }, write));
  }

  // An issue's pre-review buttons: analyze it (anyway, after a flag), Make PR with fix (your agent's chat opens on it), and
  // the desk's blocklist. Each refetches the issue as it's drawn.
  function issueAct(c: Card, k: "analyze" | "trust" | "fix" | "block" | "unblock"): Effect.Effect<void> {
    const call =
      k === "fix"
        ? Effect.map(api.fixIssue(c.id), () => `Asked your agent for a PR with the fix: ${shortRef(c)}`)
        : k === "block" || k === "unblock"
          ? Effect.map(api.blockAuthor(c.id, k === "block"), (r) => `${k === "block" ? "Blocked" : "Unblocked"} @${r.author} on your desk`)
          : Effect.as(api.analyzeIssue(c.id, k === "trust"), `Analyzing ${shortRef(c)}`);
    return call.pipe(
      Effect.match({
        onSuccess: (words) => {
          flash(words);
          if (k === "fix") setAsking({ item: c.id, spot: null });
        },
        onFailure: (e) => {
          flash(e.message, true);
        },
      }),
      Effect.andThen(fetchDetail(c.id)),
      Effect.andThen(refreshNow),
    );
  }

  // Back to desk: your PR leaves Merging for your desk at once; a refusal puts it back.
  function back(c: Card): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (!c.inflight) {
        flash(`${shortRef(c)} isn't in Merging`);
        return Effect.void;
      }
      const before = actedRef.current[c.id] ?? null;
      backed.show(c.id, true);
      markActed(c.id, { what: "Back to desk", where: "queue" });
      return api.act(c.id, "takeback").pipe(
        Effect.match({
          onSuccess: () => {
            undoSeq.current = [];
            undoWrite.current = null;
            flash(`Back on your desk: ${shortRef(c)}`);
          },
          onFailure: (e) => {
            backed.drop(c.id);
            markActed(c.id, before);
            flash(e.message, true);
          },
        }),
        Effect.andThen(refreshNow),
      );
    });
  }

  // Ready for review on GitHub, from its row or its review (asking whoever was picked there). With nobody asked to review
  // it, or the review request refused, it's ready but stays on your desk: the desk says which (`done`).
  function ready(c: Card, picked: Reviewer[] = []): Effect.Effect<boolean> {
    const names = picked.map((p) => p.login).join(", ");
    const ask = { users: picked.filter((p) => !p.team).map((p) => p.id), teams: picked.filter((p) => p.team).map((p) => p.id) };
    const did = `Marked ${shortRef(c)} ready for review${names ? ` and asked ${names}` : ""} on GitHub`;
    const write = api.ready(c.id, ask).pipe(
      Effect.map((r) => ({ text: r.done ? did : `${did}. Nobody's asked to review it yet`, stays: !r.done })),
      Effect.catchTag("DeskReviewersNotAsked", (e) =>
        Effect.succeed({ text: `${e.message}. Ask ${names} on GitHub.`, error: true, stays: true }),
      ),
    );
    return finish(c, `Marking ${shortRef(c)} ready for review…`, { what: "Marked ready for review", where: "archive" }, write);
  }

  function markReady(c: Card, picked: Reviewer[] = []) {
    runUi(ready(c, picked));
  }

  // Ask reviewers in the review of your ready PR nobody's asked to review: it leaves your desk until someone reviews.
  function askReviewers(c: Card, picked: Reviewer[]) {
    const names = picked.map((p) => p.login).join(", ");
    const ask = { users: picked.filter((p) => !p.team).map((p) => p.id), teams: picked.filter((p) => p.team).map((p) => p.id) };
    const write = api.askReviewers(c.id, ask).pipe(Effect.as({ text: `Asked ${names} to review ${shortRef(c)} on GitHub` }));
    runUi(finish(c, `Asking ${names} to review ${shortRef(c)}…`, { what: `Asked ${names}`, where: "archive" }, write));
  }

  // One reviewer's icon in the review's sidebar: off your PR, or asked again; the PR stays where it is. False when GitHub says no.
  function changeReviewer(c: Card, login: string, how: "remove" | "rerequest"): Effect.Effect<boolean> {
    const [doing, done] = how === "remove" ? ["Removing", "Removed"] : ["Asking", "Asked"];
    return Effect.suspend(() => {
      flash(`${doing} ${login}${how === "remove" ? ` from ${shortRef(c)}` : ` to review ${shortRef(c)} again`}…`);
      return api.reviewer(c.id, login, how).pipe(
        Effect.match({
          onSuccess: () => {
            flash(`${done} ${login}${how === "remove" ? ` as a reviewer of ${shortRef(c)}` : ` to review ${shortRef(c)} again`} on GitHub`);
            return true;
          },
          onFailure: (e) => {
            flash(`Couldn't ${how === "remove" ? "remove" : "ask"} ${login}: ${e.message}`, true);
            return false;
          },
        }),
        Effect.tap(refreshNow),
      );
    });
  }

  // One reviewer picked in the review's sidebar: asked at once, and the PR stays where it is. False when GitHub says no.
  function addReviewer(c: Card, r: Reviewer): Effect.Effect<boolean> {
    const ask = r.team ? { users: [], teams: [r.id] } : { users: [r.id], teams: [] };
    return api.askReviewers(c.id, ask, true).pipe(
      Effect.match({
        onSuccess: () => {
          flash(`Asked ${r.login} to review ${shortRef(c)} on GitHub`);
          return true;
        },
        onFailure: (e) => {
          flash(`Couldn't ask ${r.login}: ${e.message}`, true);
          return false;
        },
      }),
      Effect.tap(refreshNow),
    );
  }

  // Your comment on the PR (its review) or the issue (the comment bar). True once GitHub has it, so its box closes; a
  // refusal keeps your words in it.
  function comment(c: Card, body: string): Effect.Effect<boolean> {
    const write = api.comment(c.id, body).pipe(Effect.as({ text: `Commented on ${shortRef(c)} on GitHub` }));
    return finish(c, `Commenting on ${shortRef(c)}…`, { what: "Commented", where: "archive" }, write, false);
  }

  // Approve in a review: approved on GitHub, pinned to the commit the review showed. A merge that's now yours keeps its row.
  function approve(c: Card, head: string) {
    const write = api.approve(c.id, head).pipe(Effect.map((r) => ({ text: `Approved ${shortRef(c)} on GitHub`, stays: r.stays })));
    runUi(finish(c, `Approving ${shortRef(c)}…`, { what: "Approved", where: "archive" }, write));
  }

  // A button that opens its row's menu, at the button: an opened issue's Snooze, with Snooze open.
  function openRowMenu(c: Card, el: HTMLElement, snooze = false) {
    const r = el.getBoundingClientRect();
    stay.current = c.id;
    if (!el.closest(".beside")) setSelected(c.id);
    setMenuAt({ id: c.id, x: r.left, y: r.bottom + 4, snooze });
  }

  // A More menu write on several picked rows, each as it would be alone; the toast counts the ones GitHub took.
  function githubAll(cs: Card[], action: GitHubAction): Effect.Effect<void> {
    setPicked([]);
    return Effect.forEach(cs, (c) => github(c, action), { concurrency: 4 }).pipe(
      Effect.tap((oks) =>
        Effect.sync(() => {
          const n = oks.filter(Boolean).length;
          if (n) flash(`${DID[action]}: ${n} ${n === 1 ? "item" : "items"}`);
        }),
      ),
      Effect.asVoid,
    );
  }

  // A More menu write, from a row's menu or a review (head: the commit the review showed; body: Request changes' words). Close,
  // merge and Request changes finish your part, so it leaves your desk at once; draft and reopen keep it where it is.
  function github(c: Card, action: GitHubAction, head?: string, body?: string): Effect.Effect<boolean> {
    // The same as Ready for review: off your desk at once, into the Archive.
    if (action === "ready") return ready(c);
    const write = api.github(c.id, action, { ...(head ? { head_oid: head } : {}), ...(body ? { body } : {}) }).pipe(
      Effect.map(() => {
        undoSeq.current = [];
        const to = action === "close" && c.kind === "pr" ? "reopen" : action === "draft" ? "ready" : null;
        undoWrite.current = to && { id: c.id, to };
        return { text: `${DID[action]}: ${shortRef(c)}`, undo: !!to };
      }),
    );
    // These take it off your desk at once, as Done does; GitHub's answer follows in the toast.
    if (action === "close" || action === "merge" || action === "request_changes" || action === "unrequest") {
      const verb = {
        close: "Closing",
        merge: "Merging",
        request_changes: "Requesting changes on",
        unrequest: "Taking you off the reviewers of",
      }[action];
      const what = { close: "Closed", merge: "Merged", request_changes: "Requested changes", unrequest: "Removed you as a reviewer" }[
        action
      ];
      return finish(c, `${verb} ${shortRef(c)} on GitHub\u2026`, { what, where: "archive" }, write);
    }
    return write.pipe(
      Effect.match({
        onSuccess: (r) => {
          flash(r.text, false, r.undo);
          return true;
        },
        onFailure: (e) => {
          flash(e.message, true);
          return false;
        },
      }),
      Effect.ensuring(refreshNow),
    );
  }

  // Ask your agent: your chat with your agent, about what you're on: the review's PR and the spot you were last on, a row, or nothing.
  function openAsk(id?: string, s?: Spot) {
    // A + box's blur lets the keys go a frame later; one Pierre draws again meanwhile would take focus back from the chat.
    holdKeys(false);
    const r = routeRef.current;
    const item =
      id ??
      (r.name === "review"
        ? r.id
        : r.name === "inflight"
          ? laneCur?.card.id
          : r.name === "settings"
            ? null
            : r.name === "inquiry"
              ? (questionOf(r.id)?.item_id ?? null)
              : current?.id);
    // Drawn and focused at once, so what you type lands in the box.
    flushSync(() => {
      setCommenting(null);
      if (s) setSpot(s);
      setAsking({ item: item ?? null, spot: s ?? (r.name === "review" && spot?.item === item ? spot : null) });
    });
    const box = document.querySelector<HTMLTextAreaElement>(".chat-input");
    box?.focus();
    box?.setSelectionRange(box.value.length, box.value.length); // a kept draft carries on at its end
  }

  // One step wider: from a spot to its PR, or from an item to nothing in particular.
  function widen() {
    flushSync(() => {
      if (asking?.spot) setSpot(null);
      setAsking((a) => a && (a.spot ? { ...a, spot: null } : { item: null, spot: null }));
    });
    document.querySelector<HTMLTextAreaElement>(".chat-input")?.focus();
  }

  // Copy attach command copies `claude attach <id>` (Codex's: `codex resume <id>`, OpenCode's: `opencode --session <id>`); Wake it starts your agent, or has it look at Merging now.
  function coordinatorAct(k: "copy" | "wake"): Effect.Effect<void> {
    const id = lane?.coordinator.id;
    const step: Effect.Effect<void, ApiError | ClipboardUnavailable> =
      k === "wake"
        ? api.wakeCoordinator().pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                flash(id ? "Asked your agent to look at Merging." : "Started your agent.");
                refresh(0);
              }),
            ),
          )
        : id
          ? copyText(attachCommand(id, aiName())).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  flash("Copied. Run it in a terminal to open your agent.");
                }),
              ),
            )
          : Effect.void;
    return step.pipe(Effect.catch(failed));
  }

  // Copy link: the item's inbox:// link, which the desktop app opens it at, and which an agent reads as its ref.
  function copyLink(c: Card, onGitHub = false): Effect.Effect<void> {
    return copyText(onGitHub ? c.url : permalink({ item: c.id })).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          flash(`Copied the ${onGitHub ? "GitHub " : ""}link to ${shortRef(c)}`);
        }),
      ),
      Effect.catch(failed),
    );
  }

  // A question's link, inbox://question/<id>: the desktop app opens its page, and an agent reads it with inbox_inquiry.
  function copyQuestionLink(q: Inquiry): Effect.Effect<void> {
    return copyText(permalink({ question: q.id })).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          flash(`Copied the link to ${fromName(q.from, false)}'s question`);
        }),
      ),
      Effect.catch(failed),
    );
  }

  // A question's menu: what its page offers.
  function runQuestion(q: Inquiry, k: string) {
    if (k === "answer") openInquiry(q);
    else if (k === "link") runUi(copyQuestionLink(q));
    else if (k === "dismiss") runUi(answerInquiry(q, "", true));
    else if (k === "agree") runUi(answerInquiry(q, AGREE));
    else if (k === "disagree") runUi(answerInquiry(q, DISAGREE));
  }

  // Try again on a failed job in Claude's work: the AI review runs again (its verdict in a toast once it's in), or your ask goes to your agent again.
  function retryWork(w: Work): Effect.Effect<void> {
    if (w.kind === "ask")
      return api.wakeCoordinator(w.key).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            flash("Asked your agent again.");
            refresh(0);
          }),
        ),
        Effect.catch(failed),
      );
    const ref = shortId(w.key);
    flash(`${aiName()} is reviewing ${ref} again.`);
    return api.aiReview(w.key).pipe(
      Effect.match({
        onSuccess: (r) => {
          flash(`AI review of ${ref}: ${r.ai.verdict}`);
        },
        onFailure: (e) => {
          flash(e.message, true);
        },
      }),
    );
  }

  function run(c: Card, k: string) {
    if (k === "link") runUi(copyLink(c));
    else if (k === "github-link") runUi(copyLink(c, true));
    else if (k === "log") go({ name: "log", id: c.id });
    else if (k === "close") setExpanded(null);
    else if (k === "ask") openAsk(c.id);
    else if (k === "back") runUi(back(c));
    else if (k === "analyze" || k === "trust" || k === "fix" || k === "block" || k === "unblock") runUi(issueAct(c, k));
    else if (k === "cta" && c.cta === "ready") markReady(c);
    else if (k === "cta" && c.cta === "handoff") handOff(c);
    else if (k === "cta" && c.cta === "reviewers")
      openCard(c); // its review, with the reviewers box ready
    else if (k === "handoff") handOff(c);
    else if (k === "open") {
      window.open(c.url, "_blank", "noopener,noreferrer");
      runUi(seen(c));
    } else if (k === "done") runUi(act(c, c.status === "active" ? "done" : "restore"));
    else if (k === "mute") runUi(act(c, c.status === "muted" ? "unmute" : "mute"));
    else if (k === "comment") {
      // An issue opened in place: Comment opens the comment bar.
      setAsking(null);
      setCommenting(c);
      // Open already, it takes the cursor back.
      requestAnimationFrame(() => {
        document.querySelector<HTMLTextAreaElement>(".composer-text")?.focus();
      });
    }
  }

  function toggleGroup(k: GroupKey) {
    setOpen((o) => ({ ...o, [k]: !o[k] }));
  }

  // ⌘[ and ⌘]: the item before or after the one that's open in its list (else the selected one), opened as a click on its
  // row would; with neither, the list's first or last. Merging steps through its PRs.
  const stepAt = useRef<string | null>(null);
  function stepTo(by: 1 | -1) {
    const shown = route.name === "review" ? route.id : route.name === "inquiry" ? inquiryOf(route.id) : null;
    if (laneList) {
      const at = laneRows.findIndex((r) => r.card.id === (shown ?? laneSel));
      const to = laneRows[at < 0 ? (by > 0 ? 0 : laneRows.length - 1) : at + by];
      if (to) go({ name: "review", id: to.card.id });
      return;
    }
    const order = [...inquiries.map((q) => inquiryOf(q.id)), ...sessions.map((x) => x.id), ...flat.map((c) => c.id)];
    // An issue it opened in place beside a review is where it is, not the review still drawn.
    const last = stepAt.current;
    const here = last !== null && (last === expanded || last === shown) ? last : (shown ?? expanded ?? selected);
    const at = here === null ? -1 : order.indexOf(here);
    const id = order[at < 0 ? (by > 0 ? 0 : order.length - 1) : at + by];
    if (id === undefined) return;
    stepAt.current = id;
    const q = inquiries.find((x) => inquiryOf(x.id) === id);
    const s = sessions.find((x) => x.id === id);
    const c = flat.find((x) => x.id === id);
    if (q) {
      setExpanded(null);
      openInquiry(q);
    } else if (s) {
      // A session opens in place on the Inbox, as an issue does.
      if (route.name === "review" || route.name === "inquiry") go({ name: "queue" });
      setSelected(s.id);
      setExpanded(s.id);
    } else if (c?.kind === "pr") {
      setExpanded(null);
      openCard(c);
    } else if (c) {
      // An issue opens in place on its list, so a review or a question gives way to the list.
      if (route.name === "review" || route.name === "inquiry") go({ name: listPage ?? "queue" });
      if (expanded !== c.id) toggle(c);
    }
  }

  // ↓ and ↑ on a list page move to the row after or before the focused one (else the selected one; with neither, the first or
  // last) and focus it, which selects it; Enter opens it. False where there's no list, so the page scrolls as usual.
  function stepRow(by: 1 | -1): boolean {
    if (!LIST_PAGES.has(route.name) && route.name !== "inflight") return false;
    if (document.activeElement?.closest(".beside, .chat, .popover")) return false; // they scroll or read their own arrows
    const rows = [...document.querySelectorAll<HTMLElement>(".line[data-id] .row-main")].filter((b) => !b.closest(".beside"));
    if (!rows.length) return false;
    const idOf = (b: Element) => b.closest<HTMLElement>(".line[data-id]")?.dataset.id;
    const on = document.activeElement?.closest(".line[data-id]");
    const at = rows.findIndex((b) => (on ? b.closest(".line[data-id]") === on : idOf(b) === selected));
    const to = rows[at < 0 ? (by > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + by))];
    to?.focus({ preventScroll: LIST_PAGES.has(route.name) }); // the selection's own scroll keeps a group's heading in view
    return true;
  }

  // Esc is the one key: on a list it closes the item opened in place, then clears the filter; a Settings view goes back to its
  // part; then it goes back to the Inbox.
  const onKey = (e: KeyboardEvent) => {
    const t = e.target instanceof HTMLElement ? e.target : document.body;
    if (t.closest("input, textarea, select, [contenteditable='true']")) return;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !menuAt) {
      if (stepRow(e.key === "ArrowDown" ? 1 : -1)) e.preventDefault();
      return;
    }
    if (e.key !== "Escape" || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    if (route.name === "review" || route.name === "inquiry" || route.name === "log") return; // they read their own Esc
    const onList = LIST_PAGES.has(route.name) || route.name === "inflight"; // where the search reads a list
    const part = route.name === "settings" ? settingsBack(route.section) : null;
    if (onList && pickedOn.length) setPicked([]);
    else if (onList && expanded) setExpanded(null);
    else if (onList && filter) setFilter("");
    else if (part) go({ name: "settings", section: part });
    else if (route.name !== "queue") go({ name: "queue" });
  };
  // Capture phase: this runs before any other keydown listener, the review's included.
  const onCapture = (e: KeyboardEvent) => {
    // A key while the review's comment box is drawn again is the box's: Esc can't go back meanwhile.
    if (keysHeld()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (menuAt) return; // a row's menu has the keyboard, Esc included
    // The platform's own: ⌘1-4 are the sidebar's pages, ⌘[ and ⌘] the item before and after, where there's a list (a list
    // page, Merging, a review or a question). The shortcut recorder reads its own keys.
    const mod = (MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey && !e.shiftKey && !e.isComposing;
    const digit = /^Digit([1-4])$/.exec(e.code)?.[1];
    const bracket = e.code === "BracketLeft" ? -1 : e.code === "BracketRight" ? 1 : 0;
    const listed = LIST_PAGES.has(route.name) || route.name === "inflight" || route.name === "review" || route.name === "inquiry";
    if (mod && digit && !(e.target instanceof HTMLElement && e.target.closest(".hotkey"))) {
      if (!e.repeat) go({ name: SIDE_PAGES[Number(digit) - 1]! });
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    // ⌘J: Ask your agent, where its button shows; with the chat open, back to its box.
    if (mod && e.code === "KeyJ" && overview?.agent) {
      if (!e.repeat) openAsk(asking?.item ?? undefined, asking?.spot ?? undefined);
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    // ⌘N: a new note to yourself, from anywhere.
    if (mod && e.code === "KeyN") {
      if (!e.repeat) {
        setCommenting(null);
        setNoting("new");
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (mod && bracket && listed) {
      if (!e.repeat) stepTo(bracket);
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    const typing = e.target instanceof HTMLElement && !!e.target.closest("input, textarea, select, [contenteditable='true']");
    // "/" puts you in the sidebar's search, as on GitHub, wherever you're not typing.
    if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing) {
      const find = document.querySelector<HTMLInputElement>(".side-search .search-box input");
      if (find) {
        find.focus();
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
    }
    // Esc closes the chat from anywhere but a text box (its own box closes it only when empty, else leaves it), and the
    // comment bar from anywhere, before a review or a page reads it as "go back"; a More menu over it, or one of the chat's
    // own menus, closes first.
    const menu = !!document.querySelector(".more-pop, .chat .popover");
    if (((asking && !typing) || commenting || noting) && !menu && e.key === "Escape" && !e.isComposing) {
      setAsking(null);
      setCommenting(null);
      noteClose.current?.(); // the tray slides away, then it's gone
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    // An issue opened in place in the list beside a review closes first, as on its page, before the review reads "go back".
    const plain = e.key === "Escape" && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing;
    if (plain && expanded && !typing && !menu && document.querySelector(".beside .line.open")) {
      setExpanded(null);
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  const captureRef = useRef(onCapture);
  captureRef.current = onCapture;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      keyRef.current(e);
    };
    const capture = (e: KeyboardEvent) => {
      captureRef.current(e);
    };
    window.addEventListener("keydown", capture, { capture: true });
    window.addEventListener("keydown", h);
    return () => {
      window.removeEventListener("keydown", capture, { capture: true });
      window.removeEventListener("keydown", h);
    };
  }, []);

  // Shift- or ⌘-click on a list's row, from the anchor: the selected row on a list page, the open review beside one.
  const picker = (anchor: string | null, selects: boolean) => (c: Card, range: boolean) => {
    const order = onScreen.map((x) => x.id);
    if (range) {
      setPicked(pickRange(order, anchor, c.id));
      return;
    }
    // The anchor is the first pick, so ⌘-clicking a second row picks both.
    const from = pickedOn.length || !anchor || anchor === c.id || !order.includes(anchor) ? pickedOn : [anchor];
    const next = pickToggle(from, c.id);
    setPicked(next);
    if (selects) setSelected(next.includes(c.id) ? c.id : null);
  };
  const ctx: RowCtx = {
    now,
    me: overview?.me ?? "",
    selected,
    expanded,
    leaving,
    details,
    boardLabel,
    click: openCard,
    select: (c) => {
      setSelected(c.id);
    },
    run,
    menu: openRowMenu,
    chains,
    picked: new Set(pickedOn),
    ...(LIST_PAGES.has(route.name) && { pick: picker(selected, true) }),
  };
  const configErrors = overview?.config_errors.length ?? 0;
  const inbox = view ? inboxCount(view, leaving, answered.shown) : null;
  const offline = down?._tag === "DeskUnreachable";
  const broken = down?._tag === "DeskConfigBroken" ? down : null;
  // What's wrong with the system, from what the desk reports: the bubbles at the window's edge.
  const conditions = {
    offline,
    source: sourceDown,
    starting: down?._tag === "DeskStarting" ? down.message : null,
    broken: broken?.message ?? null,
    overview,
    paused: view?.paused ?? null,
    page: routeHash(route),
    agent: aiName(),
  };
  const notices = noticesOf(conditions);
  // Only once the desk has answered and while it does: what it said isn't gone because it's loading or down for a moment.
  const deskSaid = !!overview && (!!view || !!broken) && (!down || !!broken);
  // Against every notice, the page's own too: opening the page that says it doesn't resolve it.
  const settled = deskSaid ? forget(noticesOf({ ...conditions, page: "" }), dismissed) : dismissed;
  useEffect(() => {
    if (settled === dismissed) return;
    setDismissed(settled);
    setStored(DISMISSED, Object.keys(settled).length ? JSON.stringify(settled) : null);
  }, [settled, dismissed]);
  const dismissNotice = useCallback((n: Notice) => {
    if (n.transient) {
      setFailures((f) => f.filter((x) => x.id !== n.id));
      return;
    }
    setDismissed((d) => {
      const next = { ...d, [n.id]: n.sig };
      setStored(DISMISSED, JSON.stringify(next));
      return next;
    });
  }, []);
  const fixNotice = (f: Fix) => {
    if ("run" in f) runUi(f.run === "sync" ? sync() : load());
  };
  const ses: SessionCtx = {
    now,
    selected,
    expanded,
    leaving,
    select: (s) => {
      setSelected(s.id);
    },
    toggle: (s) => {
      setSelected(s.id);
      setExpanded(expanded === s.id ? null : s.id);
    },
    act: sessionAct,
    start: sessionStart,
  };
  const inq = {
    now,
    selected,
    select: (q: Inquiry) => {
      setSelected(inquiryOf(q.id));
    },
    open: openInquiry,
    agree: (q: Inquiry) => {
      runUi(answerInquiry(q, AGREE));
    },
  };

  // The list beside a review or a question, and the row it marks: the open item's.
  const side = broken ? null : beside({ route, roomy, crowded, folded: listFolded, chat: chatOpen, peek });
  const openSel = route.name === "review" ? route.id : route.name === "inquiry" ? inquiryOf(route.id) : null;
  // Kept per device; beside the chat in a window under 1600px, showing or hiding it lasts until the chat closes.
  function foldList() {
    if (side !== "open") {
      setListFolded(false);
      setStored(LIST, null);
      setPeek(true);
    } else if (chatOpen && crowded) setPeek(false);
    else {
      setListFolded(true);
      setStored(LIST, "folded");
    }
  }

  // The rows beside a review or a question: its list page's, two lines a row, the open item marked (the row whose menu is open,
  // while it is); focusing a row leaves the selection on it.
  const listSel = menuAt?.id ?? openSel;
  const compact: RowCtx = {
    ...ctx,
    compact: true,
    selected: listSel,
    select: ignore,
    ...(listPage && LIST_PAGES.has(listPage) && { pick: picker(openSel, false) }),
  };
  const besideRows =
    side !== "open" || !listPage ? null : listPage === "queue" ? (
      <Queue
        view={queueView}
        overview={overview}
        groups={groups}
        ctx={compact}
        inquiries={inquiries}
        inq={{ ...inq, compact: true, selected: listSel, select: ignore }}
        note={{ ...note, compact: true, selected: listSel }}
        filter={filter}
        toggle={toggleGroup}
      />
    ) : listPage === "inflight" ? (
      <Inflight
        view={laneShown}
        filter={filter}
        now={now}
        selected={listSel}
        select={ignore}
        act={ignore}
        open={(r) => {
          setLaneSel(r.card.id);
          go({ name: "review", id: r.card.id });
        }}
        onWork={ignore}
        compact
      />
    ) : (
      <Later
        view={queueView}
        groups={groups}
        keys={PAGE_GROUPS[listPage]}
        empty={EMPTY[listPage]}
        ctx={compact}
        filter={filter}
        toggle={toggleGroup}
      />
    );

  if (setup?.needed)
    return (
      <Setup
        view={setup}
        onChange={(s) => {
          setSetup(s);
          if (!s.needed) refresh(0);
        }}
      />
    );

  return (
    <div className="app">
      <Sidebar
        route={route}
        from={reviewFrom}
        count={inbox}
        overview={overview}
        onUpdate={() => {
          runUi(update());
        }}
        ask={!asking && !!overview?.agent && !(route.name === "inquiry" && isCoordinator(questionOf(route.id)?.from ?? ""))}
        waiting={route.name === "review" && askWaiting}
        onAsk={() => {
          openAsk();
        }}
        search={search}
      />
      {/* A sibling of the page's column, never around it: the review keeps its place in the tree as this comes and goes. */}
      {side && listPage && (
        <Beside
          name={PAGE_NAME[listPage]}
          count={listPage === "queue" ? inbox : null}
          open={side === "open"}
          selected={openSel}
          onFold={foldList}
          filters={filters}
        >
          {besideRows}
        </Beside>
      )}
      {/* A review has no head of its own: Esc, the list beside it and the sidebar are its ways back. */}
      <div className={cls("col", route.name === "review" && "headless")}>
        {route.name !== "review" && (
          <PageHead
            route={route}
            from={reviewFrom}
            filters={filters}
            onNote={() => {
              setCommenting(null);
              setNoting("new");
            }}
          />
        )}
        <main className="main">
          {route.name === "queue" && !broken && (
            <Queue
              view={queueView}
              overview={overview}
              groups={groups}
              ctx={ctx}
              inquiries={inquiries}
              inq={inq}
              sessions={sessions}
              ses={ses}
              note={note}
              filter={filter}
              adding={adding}
              toggle={toggleGroup}
              reorder={reorder}
            />
          )}
          {route.name === "blocked" && !broken && (
            <Later
              view={queueView}
              groups={groups}
              keys={PAGE_GROUPS.blocked}
              empty={EMPTY.blocked}
              ctx={ctx}
              filter={filter}
              toggle={toggleGroup}
            />
          )}
          {route.name === "archive" && !broken && (
            <Later
              view={queueView}
              groups={groups}
              keys={PAGE_GROUPS.archive}
              empty={EMPTY.archive}
              ctx={ctx}
              note={note}
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
              flash={flash}
              onCard={run}
              onGithub={(c, a, head, body) => github(c, a, head, body)}
              acted={acted[route.id]}
              row={laneRows.find((r) => r.card.id === route.id) ?? null}
              onApprove={approve}
              onReady={markReady}
              onAskReviewers={askReviewers}
              onAddReviewer={addReviewer}
              onReviewer={changeReviewer}
              onComment={comment}
              onBack={() => {
                go(reviewQuestion ? { name: "inquiry", id: reviewQuestion } : { name: reviewFrom });
              }}
              chat={!!asking}
              agent={!!overview?.agent}
              onCloseChat={() => {
                setAsking(null);
              }}
              onAsk={(s) => {
                openAsk(s.item, s);
              }}
              onSpot={(s) => {
                setSpot(s);
                setAsking((a) => (a && (!s || a.item === s.item) ? { ...a, spot: s } : a));
              }}
              onAskWaiting={setAskWaiting}
            />
          )}
          {/* A review document's page as the desk rendered it: it runs nothing, so it's framed with nothing allowed but its links. */}
          {route.name === "doc" && !broken && (
            <iframe
              key={route.id}
              className="doc-frame"
              title="Review document"
              src={`/api/docs/${encodeURIComponent(route.id)}/html`}
              sandbox="allow-popups allow-popups-to-escape-sandbox"
            />
          )}
          {route.name === "log" && !broken && (
            <ItemLog
              key={route.id}
              id={route.id}
              loads={loads}
              me={me}
              onBack={() => {
                history.back();
              }}
              onRule={(rule) => {
                setRuleFocus({ ...rule, at: Date.now() });
                go({ name: "settings", section: "rules" });
              }}
            />
          )}
          {route.name === "inquiry" && !broken && (
            <InquiryPage
              key={route.id}
              id={route.id}
              loads={loads}
              now={now}
              flash={flash}
              onAnswer={answerInquiry}
              onBack={() => {
                go({ name: "queue" });
              }}
              onLink={(q) => {
                runUi(copyQuestionLink(q));
              }}
              onLoad={setPageQuestion}
            />
          )}
          {route.name === "inflight" && !broken && (
            <Inflight
              view={laneShown}
              filter={filter}
              now={now}
              selected={laneCur?.card.id ?? null}
              select={setLaneSel}
              act={(k) => {
                runUi(coordinatorAct(k));
              }}
              open={(r) => {
                setLaneSel(r.card.id);
                go({ name: "review", id: r.card.id });
              }}
              onWork={(w, k) => {
                if (k === "retry") runUi(retryWork(w));
                else if (w.kind === "ai_review") go({ name: "review", id: w.key });
                else if (w.kind === "answer") go({ name: "inquiry", id: w.key });
                else openAsk(w.item ?? undefined);
              }}
            />
          )}
          {/* Settings stays mounted once opened, so an unsaved Rules draft survives a trip to the queue. */}
          {settingsSeen && (
            <Settings
              active={route.name === "settings"}
              section={section}
              view={settings}
              now={now}
              loads={loads}
              configErrors={configErrors}
              onView={saveSettingsView}
              flash={flash}
              onRulesSaved={() => {
                refresh(0);
              }}
              onRulesDirty={(d) => {
                rulesDirty.current = d;
              }}
              onAsked={() => {
                setAsking({ item: null, spot: null });
              }}
              ruleFocus={ruleFocus}
            />
          )}
        </main>
      </div>
      {asking && (
        <Chat
          key={asking.item ?? ""} // a new spot keeps your draft; the line above the box follows it
          about={asking}
          review={route.name === "review"}
          questions={(view?.inquiries ?? []).filter((q) => isCoordinator(q.from) && q.item_id === asking.item && !answered.shown.has(q.id))}
          loads={loads}
          now={now}
          onWiden={widen}
          onClose={() => {
            setAsking(null);
          }}
        />
      )}
      {noting && noting !== "new" && noting.from && (
        <NoteCard
          key={noting.id}
          note={noting}
          now={now}
          onPress={pressNote}
          onDone={doneNote}
          onClose={() => {
            setNoting(null);
          }}
          closer={setNoteClose}
        />
      )}
      {noting && (noting === "new" || !noting.from) && (
        <NoteBar
          key={noting === "new" ? "new" : noting.id}
          note={noting === "new" ? null : noting}
          onSave={(text, remind, put) => saveNote(noting === "new" ? null : noting, text, remind, put)}
          onDone={doneNote}
          onClose={() => {
            setNoting(null);
          }}
          closer={setNoteClose}
        />
      )}
      {commenting && (
        <CommentBar
          key={commenting.id}
          card={commenting}
          onSend={(body) => comment(commenting, body)}
          onClose={() => {
            const id = commenting.id;
            setCommenting((cur) => (cur?.id === id ? null : cur));
          }}
        />
      )}
      <Bubbles notices={[...undismissed(notices, dismissed), ...failures]} fix={fixNotice} dismiss={dismissNotice} />
      <Tips />
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
                runUi(undo());
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}
      {menuAt?.bulk && pickedCards.length > 1 && (
        <BulkMenu
          key={`${menuAt.id} ${menuAt.x} ${menuAt.y}`}
          cards={pickedCards}
          x={menuAt.x}
          y={menuAt.y}
          act={(cs, a, until) => {
            runUi(actAll(cs, a, until));
          }}
          github={(cs, a) => {
            runUi(githubAll(cs, a));
          }}
          reopen={reopenMenu}
          onClose={closeMenu}
        />
      )}
      {menuAt && !menuAt.bulk && menuCard && (
        <RowMenu
          key={`${menuAt.id} ${menuAt.x} ${menuAt.y}`}
          card={menuCard}
          x={menuAt.x}
          y={menuAt.y}
          {...(menuAt.snooze !== undefined && { snooze: menuAt.snooze })}
          step={stepsOf(menuAt.id)}
          run={run}
          act={(c, a, until) => {
            runUi(act(c, a, until));
          }}
          github={(c, a) => {
            runUi(github(c, a));
          }}
          reopen={reopenMenu}
          onClose={closeMenu}
        />
      )}
      {menuAt && menuSession && (
        <SessionMenu
          key={`${menuAt.id} ${menuAt.x} ${menuAt.y}`}
          s={menuSession}
          x={menuAt.x}
          y={menuAt.y}
          act={sessionAct}
          start={sessionStart}
          reopen={reopenMenu}
          onClose={closeMenu}
        />
      )}
      {menuAt && menuNote && (
        <NoteMenu
          key={`${menuAt.id} ${menuAt.x} ${menuAt.y}`}
          n={menuNote}
          x={menuAt.x}
          y={menuAt.y}
          step={stepsOf(menuAt.id)}
          done={doneNote}
          snooze={(n, until) => {
            runUi(saveNote(n, n.text, until));
          }}
          now={now}
          move={(n, to) => {
            runUi(saveNote(n, n.text, "", to));
          }}
          run={(n, k) => {
            if (k === "open") setNoting(n);
            else
              runUi(
                copyText(n.text).pipe(
                  Effect.match({
                    onSuccess: () => {
                      flash("Copied the note");
                    },
                    onFailure: (e) => {
                      flash(e.message, true);
                    },
                  }),
                ),
              );
          }}
          reopen={reopenMenu}
          onClose={closeMenu}
        />
      )}
      {menuAt && menuStep && (
        <StepMenu
          key={`${menuAt.id} ${menuAt.x} ${menuAt.y}`}
          s={menuStep}
          x={menuAt.x}
          y={menuAt.y}
          stop={stopWaiting}
          reopen={reopenMenu}
          onClose={closeMenu}
        />
      )}
      {menuAt && menuQuestion && (
        <QuestionMenu
          key={`${menuAt.id} ${menuAt.x} ${menuAt.y}`}
          q={menuQuestion}
          x={menuAt.x}
          y={menuAt.y}
          step={stepsOf(menuAt.id)}
          run={runQuestion}
          reopen={reopenMenu}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
