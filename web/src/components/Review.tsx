import { Effect } from "effect";
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as KeyEvent,
  type ReactNode,
} from "react";
import { parsePatchFiles, type SelectedLineRange } from "@pierre/diffs";
import { FileDiff, type DiffLineAnnotation, type FileDiffOptions } from "@pierre/diffs/react";
import { hydratePartialDiff, type FileDiffLoadedFiles } from "@pierre/diffs";
import {
  type Card,
  type Check,
  type Checks,
  type Conversation as Convo,
  type GitHubAction,
  type InflightRow,
  type InlineAt,
  type ReviewFile,
  type ReviewLook,
  type ReviewNote,
  type NoteKind,
  type Reviewer,
  type ReviewView,
  type Stack,
  type StackMember,
} from "../../../src/types.ts";
import { andMore } from "../../../src/stage.ts";
import { api, runUi } from "../api.ts";
import { useKeyed } from "../keyed.ts";
import { RISK_BARS } from "../risk.ts";
import { Signal } from "./RowIcons.tsx";
import { age, byOf, cls, handoffLabel, MOD, modelName, sinceText, shortRef, when } from "../format.ts";
import { inline, unlinked, urlPlace } from "../../../src/prose.ts";
import { reviewOf } from "../reviews.ts";
import { hasReviewerAsk, useShown, withReviewerAsks } from "../pending.ts";
import {
  boxBack,
  boxGone,
  holding,
  holdKeys,
  isSending,
  keepChanges,
  keepComment,
  keepDraft,
  keptChanges,
  keptComment,
  keptDraft,
  keysHeld,
  returnDraft,
  sendingOn,
  watchKept,
  type Kept,
} from "../drafts.ts";
import { checkDot, checkGroups, type Dot } from "../checks.ts";
import {
  currentFile,
  oldFromNew,
  pathTree,
  wholeFor,
  diffRows,
  drawUpTo,
  filePatch,
  inlineAt,
  lineName,
  linesLabel,
  sectionOf,
  resolvedHead,
  splitPath,
  threadsOn,
  type PathNode,
} from "../diffLines.ts";
import { routeHash } from "../route.ts";
import { type Acted } from "../groups.ts";
import { isTestPath, LEVEL, onLines, STATUS, tagTip, traditional, VERDICT, walk, type Section } from "../../../src/sections.ts";
import "../diffThemes.ts";
import { diffTheme, omarchyTheme, onOmarchy } from "../theme.ts";
import { Avatar } from "./Avatar.tsx";
import { CI, HandButton, ActButton, REVIEW } from "./Detail.tsx";
import type { Spot } from "./Chat.tsx";
import { Composer, Conversation, threadOf, type Said } from "./Conversation.tsx";
import { AiSection, type AiShown } from "./AiSection.tsx";
import { DeepSection } from "./DeepSection.tsx";
import { Diagram } from "./Diagram.tsx";
import { MoreButton, MoreMenu, WriteBox } from "./More.tsx";
import { SaidText, spans, Words } from "./Prose.tsx";
import { focusReviewers, Reviewers } from "./Reviewers.tsx";
import { SkLines } from "./Skeleton.tsx";
import { Splitter, type Width } from "./Splitter.tsx";

// What sits under a line of the diff: an AI note (index: its place in reading order), a review thread, the comment you're
// writing, or one you sent that the conversation doesn't show yet.
type Meta =
  | { kind: "note"; index: number; body: string; is?: NoteKind }
  | { kind: "look"; line: number; end: number; why: string }
  | { kind: "thread"; id: string }
  | { kind: "draft" }
  | { kind: "sent"; body: string; url: string };

// The comment you're writing on a line, or a reply to a review thread on it; its words stay in Review's text ref.
interface Draft {
  n: number;
  at: InlineAt;
  thread: string | null;
  head: string; // the commit whose diff the line was picked on: it posts there, even after a push
  busy: boolean;
}

// Where a write you made sent it, as the review's mark links it.
const PLACE: Record<Acted["where"], { href: string; said: string }> = {
  archive: { href: "#/archive", said: "in Archive" },
  inflight: { href: "#/inflight", said: "in Merging" },
  queue: { href: "#/", said: "on your Inbox" },
};

interface Sent {
  at: InlineAt;
  thread: string | null;
  body: string;
  url: string;
}

interface Fact {
  text: string;
  tone: string; // t-bad, t-warn, or "" for pencil
  go?: (() => void) | undefined; // a click on it: CI's shows its checks
}

// Sorted away, resolved or calm in Merging, a PR's problems go grey: its header's facts, and its checks in the sidebar.
const calm = (c: Card) => cls(`b-${c.bucket}`, (c.status !== "active" || c.resolved !== null || c.bucket === "hide") && "dim");

const LINE = 96; // px below the window's top where "the section you're in" is read off
const REST = "Not worth reviewing"; // the fold's line
const STACK_SHOWN = 4; // the PR below this one, this one and two above; the rest of a long stack is a click away
const SIDE: Width = { key: "desk.review.side.width", cssVar: "--rv-side-w-user", min: 220, max: 0.45 };
const ROOM = 680; // px of the page's column (styles.css's @container pane): narrower, the sidebar opens over the diff, folded
const ROW = 19; // px: .rv-diff's --diffs-line-height
const pane = () => document.querySelector(".col");
// The fractional width, as the container query reads it, so the two agree at the edge.
const roomy = () => (pane()?.getBoundingClientRect().width ?? innerWidth) >= ROOM;

// Pierre draws the diff in a shadow root; its syntax colours and light or dark follow the app's theme (diffOptions).
const DIFF: FileDiffOptions<Meta, undefined> = {
  diffStyle: "unified",
  diffIndicators: "bars",
  lineDiffType: "word-alt",
  hunkSeparators: "line-info",
  expansionLineCount: 10,
  overflow: "wrap",
  disableFileHeader: true,
  lineHoverHighlight: "disabled",
  // A band that starts or ends the file sits on the frame's edge; its words start where the line numbers do (2ch of the code).
  // A removed line's dashed bar shows its number's band between the dashes: Pierre fills them with --diffs-bg-deletion, which
  // is a theme's raw override (what it mixes into the sheet, styles.css) where one is set, so the dashes ran into a solid stripe.
  unsafeCSS: `[data-separator-first] { margin-top: calc(-1 * var(--diffs-gap-block, var(--diffs-gap-fallback))); }
[data-separator-last] { margin-bottom: calc(-1 * max(0px, var(--diffs-gap-block, var(--diffs-gap-fallback)) - var(--diffs-scrollbar-gutter))); }
[data-separator=line-info-basic] [data-separator-content] { padding-inline: calc(1.2 * var(--diffs-font-size)); }
[data-indicators=bars] [data-line-type=change-deletion][data-column-number]::before { background-image: linear-gradient(0deg, transparent 50%, var(--diffs-deletion-base) 50%); }
[data-utility-button] { background-color: var(--ink-2); color: var(--sheet); }
:host { --diffs-selection-base: var(--pencil); }
[data-annotation-content] { display: flex; flex-direction: column; }`,
};

// One object per theme, so a re-render doesn't hand Pierre new options (and a fresh highlight) each time.
const OPTIONS = new Map<string, FileDiffOptions<Meta, undefined>>();
function diffOptions(): FileDiffOptions<Meta, undefined> {
  const t = diffTheme();
  const o = OPTIONS.get(t.id) ?? { ...DIFF, theme: t.theme, themeType: t.type };
  OPTIONS.set(t.id, o);
  return o;
}

export function Review({
  id,
  known,
  loads,
  me,
  now,
  flash,
  onCard,
  onGithub,
  row,
  acted,
  onApprove,
  onReady,
  onAskReviewers,
  onAddReviewer,
  onReviewer,
  onComment,
  onBack,
  chat,
  agent,
  onCloseChat,
  onAsk,
  onSpot,
  onAskWaiting,
}: {
  id: string;
  known: Card | null; // its row's card, drawn at once while the review is on its way
  loads: number; // bumped on every refresh, so the review follows the server's updates
  me: string; // your login
  now: number;
  flash: (text: string, error?: boolean) => void;
  onCard: (c: Card, key: string) => void; // done, handoff (Hand off for merge), back (Back to desk), log, link: as in its row's menu
  onGithub: (c: Card, action: GitHubAction, head: string, body?: string) => Effect.Effect<boolean>; // the More menu's writes, and Request changes
  acted: Acted | undefined; // what you did on it from here: shown in place of the button you pressed
  row: InflightRow | null; // your PR in Merging: what it waits on and the coordinator's note go under the facts, as in Merging
  // Approve, Ready for review, Ask reviewers: App sends these, as from a row; it leaves the desk, and the review goes back to the list.
  onApprove: (c: Card, head: string, keeps: boolean) => void; // keeps: approving makes the merge yours, so it stays
  onReady: (c: Card, picked: Reviewer[]) => void;
  onAskReviewers: (c: Card, picked: Reviewer[]) => void; // your ready PR nobody's asked to review: ask who you picked
  onAddReviewer: (c: Card, r: Reviewer) => Effect.Effect<boolean>; // one picked in the sidebar: asked at once
  onReviewer: (c: Card, login: string, act: "remove" | "rerequest") => Effect.Effect<boolean>; // a reviewer's icon in the sidebar
  onComment: (c: Card, body: string) => Effect.Effect<boolean>; // your comment on the PR; true once GitHub has it
  onBack: () => void;
  chat: boolean; // your chat with your agent is open: it takes the sidebar's place
  agent: boolean; // your agent is on: its boxes offer Ask your agent
  onCloseChat: () => void; // Files closes it for the sidebar
  onAsk: (s: Spot) => void; // a box's Ask your agent: the chat, about that spot
  onSpot: (s: Spot | null) => void; // the spot you're on, for what Ask your agent asks about; null: the PR as a whole
  onAskWaiting: (waiting: boolean) => void; // your latest ask about it is unanswered: the sidebar's Ask says so
}) {
  const [view, setView] = useState<ReviewView | string | null>(null); // string: why it failed
  const [secIdx, setSecIdx] = useState(0); // the section you're in; with the rest folded, its line is one past the last shown
  const [restOpen, setRestOpen] = useState(false);
  const [walking, setWalking] = useState(true); // a PR opens on its Review when it has one; Code changes is for this PR only
  // The Conversation tab, in the diff's place: a PR opened to reply starts on it.
  const [talking, setTalking] = useState(known?.cta === "reply");
  const tabbed = useRef(!!known); // whether the tab it opens on was picked: by its row, or once the review lands
  const [testsOpen, setTestsOpen] = useState<ReadonlySet<string>>(new Set()); // test files you opened in the guided review
  const [side, setSide] = useState(true); // every review opens with it; a fold lasts for this review
  const [room, setRoom] = useState(roomy); // the page's column has room for the sidebar beside the diff
  const [over, setOver] = useState(false); // without room, Files opened it over the diff
  const showSide = (room ? side : over) && !chat; // with room it's always there: no toggle hides it
  const [busy, setBusy] = useState<"ai" | null>(null);
  // Run deep review pressed, and the result on screen then: shown running until the desk's read has it running or a new one.
  const [deepAsked, setDeepAsked] = useState<{ at: string; was: string | null } | null>(null);
  const [drawn, setDrawn] = useState(0); // sections drawn past the first screenful
  const [picked, setPicked] = useState<Reviewer[]>([]); // who Ready for review asks
  // Each file's whole text before and after, read once per commit, so a hunk's band opens more lines on the first click.
  const wholes = useRef(new Map<string, Promise<FileDiffLoadedFiles>>());
  const [more, setMore] = useState(false); // the More menu
  // The sidebar's checks and reviewers, listed: every PR opens with each in one line.
  const [writing, setWriting] = useState(() => !!keptChanges(id)); // Request changes, being written
  // Your comment on the PR, unsent: kept here, not in its box, so a refusal, acting on the PR or its closing never loses it,
  // and per PR for this window, as a line's is, so leaving the review and coming back finds it; sent, it's cleared.
  const [comment, setComment] = useState(() => keptComment(id));
  const writeComment = (text: string) => {
    setComment(text);
    keepComment(id, text);
  };
  const [shut, setShut] = useState<ReadonlySet<string>>(new Set()); // files whose diff you folded, by path
  const [viewed, setViewed] = useState<ReadonlySet<string>>(new Set()); // the marks of the hunks you've viewed (ReviewView.viewed)
  const marking = useRef(new Map<string, boolean>()); // clicks on their way to the desk: a refresh landing first doesn't undo them
  const [peek, setPeek] = useState<ReadonlySet<string>>(new Set()); // sections you viewed and opened again, by key
  const [shutDirs, setShutDirs] = useState<ReadonlySet<string>>(new Set()); // folders you folded in the sidebar's files
  const [draft, setDraft] = useState<Draft | null>(() => restored(id, 1));
  const [poke, setPoke] = useState(0); // a read again while what you sent isn't back yet
  const draftText = useRef(keptDraft(id)?.text ?? ""); // here, so a box Pierre redraws keeps your words without a render per keystroke
  const drafts = useRef(1);
  const alive = useRef(true);
  const draftSel = useRef<[number, number] | null>(null); // where the caret was, for a box drawn again
  const [stay, setStay] = useState<number | null>(null); // after a fold: the file you were in, kept in view
  const [focusAsk, setFocusAsk] = useState(0); // bumped to put the cursor in the box; a box drawn again after a fold doesn't take it
  const focusDone = useRef(0);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set()); // resolved threads you opened, by id
  // The commit the review last drew: approve, merge and request changes are pinned to it, so a push it hasn't drawn yet is refused.
  const [read, setRead] = useState("");
  const seq = useRef(0);
  const jumped = useRef(0); // when a click last scrolled the page to a file
  const v = typeof view === "object" ? view : null;
  // Yours from here that the review's read has: by its link, or your words on a comment of yours.
  const inRead = (s: { body: string; url: string }) =>
    !!v?.conversation.some((c) =>
      c.comments.some((k) => (s.url && k.url === s.url) || (k.author.toLowerCase() === me.toLowerCase() && k.body.trim() === s.body)),
    );
  // What you wrote on a line (by its link) and on the PR or a thread, and reviewers you added, removed or asked again,
  // until the read has them.
  const sent = useShown<string, Sent>(v, (_, s) => inRead(s));
  const said = useShown<string, Said>(v, (_, s) => inRead(s));
  const asks = useShown<string, "asked" | "removed">(v, (who, how) => !!v && hasReviewerAsk(v.item.review_requests, who, how));
  const pending = [...sent.shown.values()].filter((s) => !inRead(s));
  const saying = [...said.shown.values()].filter((s) => !inRead(s));
  const say = (s: Said) => {
    said.show(s.url || `${s.convo ?? ""}:${s.body}`, s);
  };
  const latest = v?.asks.at(-1);
  const waiting = !!latest && !latest.answer; // your latest ask about it: the sidebar's Ask says it's waiting
  useEffect(() => {
    onAskWaiting(waiting);
    return () => {
      onAskWaiting(false);
    };
  }, [waiting, onAskWaiting]);
  const canApprove = !!v?.approve.ok;
  // Your own open draft: Ready for review instead of Approve.
  const readying = v?.card.cta === "ready";
  // Your ready PR nobody's asked to review, or one you add reviewers to: Ask reviewers asks who you pick.
  const [adding, setAdding] = useState("");
  const yoursOpen = !!v && v.card.by === "you" && v.item.state === "open" && !v.item.draft;
  const asking = v?.card.cta === "reviewers";
  // + Add reviewers in the sidebar: the box opens there, under who's asked, with its own Ask.
  const sideAdding = adding === id && yoursOpen && !asking;
  const picking = readying || asking;
  // A PR in Merging is the coordinator's: no AI review to ask for.
  const flying = !!row && row.state === "open";

  useEffect(() => {
    window.scrollTo(0, 0); // a different PR starts at the top; a refresh stays put
  }, []);

  // The page's column narrows with the list beside it, the chat or the window; given room again, the sidebar goes back beside the diff.
  // Measured before the first paint as well: a review drawn with the window would otherwise flash its sidebar over the diff.
  useLayoutEffect(() => {
    const col = pane();
    const fit = () => {
      const r = roomy();
      setRoom(r);
      if (r) setOver(false);
    };
    fit();
    const watch = new ResizeObserver(fit);
    if (col) watch.observe(col);
    return () => {
      watch.disconnect();
    };
  }, []);

  useKeyed(`${id} ${loads} ${poke}`, (signal) => {
    const n = ++seq.current;
    runUi(
      reviewOf(id).pipe(
        Effect.match({
          onSuccess: (r) => {
            if (n !== seq.current) return;
            if (!tabbed.current && r.card.cta === "reply") setTalking(true);
            tabbed.current = true;
            setView(r);
            setRead(r.item.head_oid);
            setViewed(withMarks(new Set(r.viewed), marking.current));
          },
          // Keep what's on screen if a refresh fails.
          onFailure: (e) => {
            if (n === seq.current) setView((cur) => (cur && typeof cur === "object" ? cur : e.message));
          },
        }),
      ),
      { signal },
    );
  });

  // What you sent and GitHub hasn't given back yet: read the review again every 3 seconds, ten times at most.
  const unread = pending.length + saying.length + asks.shown.size;
  const tries = useRef(0);
  useKeyed(unread && tries.current < 10 ? `${unread} ${poke}` : null, () => {
    const t = setTimeout(() => {
      tries.current += 1;
      setPoke((p) => p + 1);
    }, 3000);
    return () => {
      clearTimeout(t);
    };
  });

  // A reviewer change shows at once and is read back until the review has it; a refusal puts it back.
  function askReviewer(who: string, how: "asked" | "removed", write: Effect.Effect<boolean>) {
    const key = who.toLowerCase();
    tries.current = 0;
    asks.show(key, how);
    runUi(
      write.pipe(
        Effect.tap((ok) =>
          Effect.sync(() => {
            if (!ok) asks.drop(key);
          }),
        ),
      ),
    );
  }

  function addReviewers() {
    if (!showSide) toggleSide();
    setAdding(id);
    requestAnimationFrame(() => {
      requestAnimationFrame(focusReviewers);
    });
  }

  // Your draft or ready PR nobody's asked has its box on the page, asked by Ready for review or Ask reviewers.
  function toPicker() {
    setOver(false);
    requestAnimationFrame(focusReviewers);
  }

  // Opened to ask reviewers (its row's Add reviewers): the box has the cursor, once per PR.
  const askedFocus = useRef("");
  useEffect(() => {
    if (!asking || askedFocus.current === id) return;
    askedFocus.current = id;
    requestAnimationFrame(focusReviewers);
  }, [asking, id]);

  // The desk's reading order; its notes are only those written for this commit, in reading order.
  const order = v?.order;
  const guided = !!order?.steps?.length;
  // The guided review is only its steps: what no step covers is left to Code changes, so the guide holds your attention.
  const guiding = guided && walking;
  // The AI review's concerns are its first notes: each is a potential bug, marked on its line.
  const bugs = v && !v.ai_stale ? (v.ai?.concerns.length ?? 0) : 0;
  const { list, rest, steps, left, beyond } = useMemo(() => {
    if (!order) return { list: [], rest: 0, steps: [], left: [], beyond: 0 };
    if (!guiding) return { ...traditional(order), steps: [], left: [], beyond: 0 };
    const w = walk(order);
    // A potential bug the steps leave out still shows, after them.
    const after = w.list.slice(w.beyond);
    const flagged = after.filter((y) => y.notes.some((n) => n < bugs));
    const shown = [...w.list.slice(0, w.beyond), ...flagged];
    return { list: shown, rest: shown.length, steps: w.steps, left: after.filter((y) => !flagged.includes(y)), beyond: w.beyond };
  }, [order, guiding, bugs]);
  const leftFiles = new Set(left.map((y) => y.path)).size;
  const isViewed = (x: Section) => x.marks.every((m) => viewed.has(m));
  // Guided, a test file stays folded until you open it; one you've viewed, until you open it again.
  const isShut = (x: Section) =>
    shut.has(x.path) || (guiding && isTestPath(x.path) && !testsOpen.has(x.path)) || (isViewed(x) && !peek.has(x.key));
  const seen = new Set(guiding ? [] : list.filter((x) => isViewed(x)).map((x) => x.path)); // Code changes' files you've viewed
  // The sidebar's rows in the guided review: its steps.
  const noted = (at: number, end: number) => list.slice(at, end).some((y) => y.notes.length > 0);
  const stops = steps.map((st, k) => {
    const end = steps[k + 1]?.at ?? beyond;
    return { n: k + 1, name: st.title, at: st.at, end, el: `#rv-step-${k}`, notes: noted(st.at, end) };
  });
  const notes = order?.notes ?? [];
  const folded = !!order?.ranked && rest < list.length && !restOpen;
  const visible = folded ? list.slice(0, rest) : list;
  // A big diff draws a screenful with the page and the rest a few files a frame, so the top never waits on highlighting.
  const first = useMemo(() => drawUpTo(list, 0), [list]);
  const upTo = Math.max(first, drawn);
  useEffect(() => {
    let t = 0;
    const f =
      upTo < list.length
        ? requestAnimationFrame(() => {
            t = window.setTimeout(() => {
              setDrawn(drawUpTo(list, upTo));
            });
          })
        : 0;
    return () => {
      cancelAnimationFrame(f);
      clearTimeout(t);
    };
  }, [upTo, list]);

  // The section you're reading follows the scroll, except right after a click moved you: then it's the one it picked.
  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Not the placeholders; a folded file is the one you're in once its middle reaches the line, so the next can't steal it.
        const tops = [...document.querySelectorAll(".rv-file-sec[id]")].map((el) => {
          const r = el.getBoundingClientRect();
          return el.classList.contains("shut") ? r.top + r.height / 2 : r.top;
        });
        const atEnd = scrollY > 0 && scrollY + innerHeight >= document.documentElement.scrollHeight - 2;
        if (tops.length && Date.now() - jumped.current > 400) setSecIdx(currentFile(tops, LINE, atEnd));
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  // The sidebar's list scrolls on its own to keep the file or step you're in in sight; the page doesn't move.
  useKeyed(secIdx, () => {
    const on = document.querySelector<HTMLElement>(".rv-side .rv-step-row.on");
    if (!on) return;
    for (const box of [on.closest<HTMLElement>("nav"), on.closest<HTMLElement>(".rv-side")]) {
      if (!box || box.scrollHeight <= box.clientHeight) continue;
      const strip = box.querySelector<HTMLElement>(":scope > .rv-side-top")?.offsetHeight ?? 0; // pinned at its top, under the toggle
      const b = box.getBoundingClientRect();
      const r = on.getBoundingClientRect();
      if (r.top < b.top + strip) box.scrollTop -= b.top + strip - r.top + 8;
      else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom + 8;
    }
  });

  // Scrolling into a file opens the folders it sits in; one you fold while in it stays folded until you move on.
  const onPath = folded && secIdx >= rest ? null : (list[secIdx]?.path ?? null);
  useKeyed(onPath, () => {
    if (onPath) setShutDirs((ds) => (hasInside(ds, onPath) ? new Set([...ds].filter((d) => !onPath.startsWith(`${d}/`))) : ds));
  });

  // A comment on this PR that GitHub refused after you'd left the review it was sent from comes back here.
  const draftNow = useRef(draft);
  draftNow.current = draft;
  useEffect(
    () =>
      watchKept((pr) => {
        if (pr !== id || draftNow.current) return;
        draftText.current = keptDraft(id)?.text ?? "";
        draftSel.current = null;
        setDraft(restored(id, ++drafts.current));
      }),
    [id],
  );

  // Leaving the review leaves the keys to the page; the words stay kept for when you're back.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      holdKeys(false);
    };
  }, []);

  // Folding moves what's below; before the page scrolls on its own, the file you were in comes back into view and stays current.
  useLayoutEffect(() => {
    if (stay === null) return;
    jumped.current = Date.now();
    setSecIdx(stay);
    const top = document.querySelector(`#rv-s-${stay}`)?.getBoundingClientRect().top;
    if (top !== undefined && (top < LINE || top > innerHeight)) document.querySelector(`#rv-s-${stay}`)?.scrollIntoView({ block: "start" });
    setStay(null);
  }, [stay]);

  // To a section, opening the rest when it's there; the scroll waits for the render that shows it.
  function goTo(i: number, el = `#rv-s-${i}`, block: ScrollLogicalPosition = "start") {
    jumped.current = Date.now();
    setTalking(false); // the diff is the other tabs'
    if (i >= rest) setRestOpen(true);
    setDrawn((d) => Math.max(d, i + 1));
    setSecIdx(i);
    requestAnimationFrame(() => {
      document.querySelector(el)?.scrollIntoView({ block });
    });
  }

  // To a line the AI review names (an interface, an improvement): its section, the line in view.
  function toLine(path: string, at: "new" | "old", line: number) {
    const i = sectionOf(list, path, { side: at, line });
    if (i >= 0) goTo(i);
  }

  // A step's diagram, when the review drew one that survived the grammar.
  function figure(which: string) {
    const d = which ? v?.ai?.diagrams?.find((x) => x.id === which) : undefined;
    return d ? <Diagram graph={d.graph} title={d.title} caption={d.caption} /> : null;
  }

  function toStep(k: number) {
    goTo(steps[k]!.at, `#rv-step-${k}`);
  }

  function toggleFold(x: Section, at: number) {
    holdKeys(false); // you've left the box for the fold
    if (isShut(x)) unfold(x, isViewed(x));
    else if (isViewed(x)) setPeek(without(peek, x.key));
    else setShut(new Set([...shut, x.path]));
    setStay(at);
  }

  function unfold(x: Section, viewedNow: boolean) {
    setShut((cur) => without(cur, x.path));
    if (guiding && isTestPath(x.path)) setTestsOpen((cur) => new Set([...cur, x.path]));
    if (viewedNow) setPeek((cur) => new Set([...cur, x.key]));
  }

  // Viewed folds it, as GitHub's checkbox does, and unviewed opens it. A refusal puts it back as it was.
  function markViewed(x: Section, at: number, on: boolean) {
    holdKeys(false);
    const change = new Map(x.marks.map((m) => [m, on]));
    for (const m of x.marks) marking.current.set(m, on);
    setViewed((cur) => withMarks(cur, change));
    setPeek(without(peek, x.key));
    if (!on) unfold(x, false);
    setStay(at);
    runUi(
      api.viewed(id, x.marks, on).pipe(
        Effect.match({
          onSuccess: () => {},
          onFailure: (e) => {
            if (!alive.current) return;
            const back = x.marks.filter((m) => marking.current.get(m) === on); // not those you've clicked again since
            setViewed((cur) => withMarks(cur, new Map(back.map((m) => [m, !on]))));
            flash(`Couldn't mark ${x.path} ${on ? "viewed" : "not viewed"}: ${e.message}`, true);
          },
        }),
        Effect.ensuring(
          Effect.sync(() => {
            for (const m of x.marks) if (marking.current.get(m) === on) marking.current.delete(m);
          }),
        ),
      ),
    );
  }

  // To the words you haven't sent, opening their file (or the rest, which goTo opens) if it's folded, with the cursor in them.
  function backToDraft(d: Draft) {
    if (!v) return;
    setTalking(false);
    const i = drawnAt(d, list, v.conversation, v.diff_head);
    const x = list[i];
    if (x && shut.has(x.path)) setShut((cur) => without(cur, x.path));
    if (x && guiding && isTestPath(x.path)) setTestsOpen((cur) => new Set([...cur, x.path]));
    if (x && isViewed(x)) setPeek((cur) => new Set([...cur, x.key]));
    if (i >= 0) goTo(i, ".rv-inline", "center");
    else document.querySelector(".rv-orphan")?.scrollIntoView({ block: "center" });
    setFocusAsk((f) => f + 1);
    flash("Post or clear the comment you're writing first");
  }

  // The gutter's + (or a drag down it), or a thread's Reply: a box under that line. Words you haven't sent are never dropped
  // for another: you're taken to them instead.
  function openDraft(at: InlineAt, thread: string | null) {
    if (!v) return;
    if (draft?.busy || isSending(id)) {
      flash("Still sending your last comment");
      return;
    }
    if (draft && draftText.current.trim()) {
      backToDraft(draft);
      return;
    }
    draftText.current = "";
    draftSel.current = null;
    const d = { n: ++drafts.current, at, thread, head: v.diff_head, busy: false };
    setDraft(d);
    setFocusAsk((f) => f + 1);
    onSpot(spotOf(d, v));
  }

  // The box's Ask your agent: the chat about its spot. It never reads what you typed: an empty box closes, words stay put.
  function askFromBox() {
    if (!draft || !v) return;
    const s = spotOf(draft, v);
    if (!draftText.current.trim()) {
      setDraft(null);
      draftText.current = "";
      keepDraft(id, null);
      holdKeys(false);
    }
    onAsk(s);
  }

  // It runs to the end after you leave the review: words GitHub refused go back to the PR.
  function sendDraft(text: string) {
    if (!v || !draft || draft.busy || !text.trim()) return;
    const d = { ...draft, busy: true };
    const pr = id;
    const ref = shortRef(v.card);
    setDraft(d);
    // Out of what's kept while it's on its way: leave and come back meanwhile, and it isn't there to send twice.
    keepDraft(pr, null);
    sendingOn(pr, true);
    runUi(
      (d.thread ? api.reply(v.card.id, d.thread, text) : api.inline(v.card.id, d.at, text, d.head)).pipe(
        Effect.match({
          onFailure: (e) => {
            sendingOn(pr, false);
            returnDraft(pr, { at: d.at, thread: d.thread, head: d.head, text });
            if (!alive.current) {
              flash(`Your comment on ${ref} didn't post: ${e.message}. Your words are back on it.`, true);
              return;
            }
            setDraft((cur) => (cur?.n === d.n ? { ...cur, busy: false } : cur));
            flash(e.message, true);
          },
          onSuccess: ({ url }) => {
            sendingOn(pr, false);
            flash(d.thread ? `Sent your reply on ${ref} on GitHub` : `Commented on ${lineName(d.at)} on GitHub`);
            if (!alive.current) return; // a review you've left doesn't touch the one you're on
            tries.current = 0;
            sent.show(url, { at: d.at, thread: d.thread, body: text.trim(), url });
            setDraft((cur) => (cur?.n === d.n ? null : cur));
            if (drafts.current === d.n) {
              draftText.current = "";
              holdKeys(false);
            }
          },
        }),
      ),
    );
  }

  function toggleSide() {
    // With the chat open, Files puts the sidebar back in its place; closing the chat can give or take the column's room.
    if (chat) {
      onCloseChat();
      setSide(true);
      setOver(true);
      return;
    }
    if (!room) {
      setOver(!over);
      return;
    }
    setSide(!side);
  }

  // A deep review of this commit with steps guides the Review tab, and says what the AI review's summary would.
  const deepGuides = !!v?.deep && v.files.length > 0 && v.deep.head_oid === v.diff_head && v.deep.steps.length > 0;

  // Starts the PR's deep review; the desk marks it running before it answers, so the next read shows it.
  function runDeep() {
    if (!v) return;
    setDeepAsked({ at: new Date().toISOString(), was: v.deep?.at ?? null });
    runUi(
      api.deepReview(v.card.id).pipe(
        Effect.match({
          onSuccess: () => {},
          onFailure: (e) => {
            setDeepAsked(null);
            flash(e.message, true);
          },
        }),
      ),
    );
  }

  function askAi() {
    if (!v || busy === "ai") return;
    if (v.generating) {
      flash("The AI review is already being written");
      return;
    }
    setBusy("ai");
    const ref = shortRef(v.card);
    runUi(
      api.aiReview(v.card.id, !!v.ai && !v.ai_stale).pipe(
        Effect.match({
          onSuccess: (r) => {
            flash(`AI review of ${ref}: ${r.ai.verdict}`);
          },
          onFailure: (e) => {
            flash(e.message, true);
          },
        }),
        Effect.ensuring(
          Effect.sync(() => {
            setBusy(null);
          }),
        ),
      ),
    );
  }

  function approve() {
    if (!v) return;
    if (!canApprove) flash(`Can't approve: ${v.approve.reason ?? "not allowed"}`, true);
    else onApprove(v.card, read, !!v.approve.keeps);
  }

  function run(k: string) {
    // With your comment unsent, what acts on the PR goes back to it first.
    if (comment.trim() && ["primary", "done", "handoff", "back", "more"].includes(k)) {
      setTalking(true); // its box is the Conversation tab's
      requestAnimationFrame(() => {
        document.querySelector<HTMLTextAreaElement>(".rv-comment textarea")?.focus();
      });
      flash("Your comment isn't sent: Comment sends it, or empty the box");
      return;
    }
    if (k === "primary" && acted) flash(`${acted.what}: ${v ? shortRef(v.card) : ""} is off your desk`);
    else if (k === "primary" && readying && v) onReady(v.card, picked);
    else if (k === "primary" && asking && v) {
      if (picked.length) onAskReviewers(v.card, picked);
      else document.querySelector<HTMLInputElement>(".rv-reviewers-input")?.focus();
    } else if (k === "primary") approve();
    else if ((k === "done" || k === "handoff" || k === "back") && v) onCard(v.card, k);
    else if (k === "more" && v) setMore(true);
  }

  // Esc goes back to where the review was opened from; a box you write in keeps its own Esc.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    const t = e.target instanceof HTMLElement ? e.target : document.body;
    if (t.closest("input, textarea, select, [contenteditable='true']")) return;
    if (keysHeld()) {
      e.preventDefault();
      return;
    }
    onBack();
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

  // The sidebar's toggle, only where it can't sit beside the diff (a narrow column, where it opens over it) or the chat holds
  // its place: pinned at the review's top right however far it's scrolled.
  const holds = `${(v?.stack ?? known?.stack) ? "the stack, " : ""}checks and files`;
  const toggle =
    room && !chat ? null : (
      <button
        type="button"
        className={cls("act", "rv-side-toggle", !showSide && "rv-side-show")}
        aria-expanded={showSide}
        aria-controls="rv-side"
        aria-label={`${showSide ? "Hide" : "Show"} ${holds}`}
        title={`${showSide ? "Hide" : "Show"} ${holds}`}
        onClick={toggleSide}
      >
        <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.5 3.5h11v9h-11zM10 3.5v9" />
        </svg>
      </button>
    );

  if (view === null) return <Shell card={known} me={me} now={now} row={row} side={showSide} toggle={toggle} />;
  if (typeof view === "string")
    return (
      <div className="review">
        <p className="t-bad">{view}</p>
      </div>
    );

  const { card, item, files } = view;
  const isMine = card.by === "you"; // yours, or a bot's opened for you
  const size = item.changed_files ? { add: item.additions, del: item.deletions } : null;
  const deps = depFacts(card);
  const resolved = card.resolved ? resolvedHead(view.activity, card.resolved, me) : null;
  // The one box you write in, wherever it's drawn: under its line, or above the diff once a push took its line off it.
  const composer = (label: string) =>
    draft && (
      <InlineBox
        key={`d${draft.n}`}
        label={label}
        busy={draft.busy}
        text={draftText.current}
        focus={focusAsk === focusDone.current ? 0 : focusAsk}
        hadFocus={holding()}
        sel={draftSel.current}
        onSel={(s) => {
          draftSel.current = s;
        }}
        onFocused={() => {
          focusDone.current = focusAsk;
        }}
        onFocusChange={holdKeys}
        onText={(t) => {
          draftText.current = t;
          keepDraft(id, { at: draft.at, thread: draft.thread, head: draft.head, text: t });
        }}
        onSend={(t) => {
          sendDraft(t);
        }}
        onCancel={() => {
          setDraft(null);
          draftText.current = "";
          keepDraft(id, null);
          holdKeys(false);
        }}
        onAsk={agent ? askFromBox : undefined}
      />
    );
  // A box whose line a refresh took off the diff, or put under the closed rest, is drawn above the diff instead.
  const orphanAt = draft ? drawnAt(draft, list, view.conversation, view.diff_head) : 0;
  const reviewers = withReviewerAsks(view.reviewers.list, asks.shown);
  // Pierre's "more lines" around a hunk: the file at the PR's head, and before it the same file run back through its patch.
  const wholeFile = (f: ReviewFile): Promise<FileDiffLoadedFiles> => {
    const key = `${view.diff_head ?? ""}:${f.path}`;
    const kept = wholes.current.get(key);
    if (kept) return kept;
    const got = Effect.runPromise(
      api.file(card.id, f.path).pipe(
        Effect.flatMap(({ text }) => {
          const old = text === null ? null : oldFromNew(text, f.patch ?? "");
          return text === null || old === null
            ? Effect.fail(new Error("GitHub doesn't give this file whole"))
            : Effect.succeed({
                oldFile: { name: f.previous_path ?? f.path, contents: old },
                newFile: { name: f.path, contents: text },
              });
        }),
      ),
    );
    wholes.current.set(key, got);
    got.catch(() => wholes.current.delete(key));
    return got;
  };
  const loadFile = (f: ReviewFile): Promise<FileDiffLoadedFiles> =>
    wholeFile(f).catch((e: unknown) => {
      flash(`Couldn't show more lines of ${f.path}: ${e instanceof Error ? e.message : String(e)}`, true);
      throw e;
    });
  const section = (x: Section, i: number) => (
    <SectionView
      key={x.key}
      section={x}
      index={i}
      file={files[x.file]!}
      loadFile={loadFile}
      wholeFile={wholeFile}
      notes={view.ai?.notes ?? []}
      looks={view.ai_stale ? [] : (view.ai?.look ?? [])}
      order={notes}
      bugs={bugs}
      now={now}
      shut={isShut(x)}
      onFold={() => {
        toggleFold(x, i);
      }}
      viewed={isViewed(x)}
      onViewed={(on) => {
        markViewed(x, i, on);
      }}
      conversation={view.conversation}
      canComment={open}
      draft={draft}
      composer={composer}
      head={view.diff_head}
      opened={opened}
      onOpen={(tid, o) => {
        setOpened((cur) => {
          const next = new Set(cur);
          if (o) next.add(tid);
          else next.delete(tid);
          return next;
        });
      }}
      sent={pending}
      onDraft={(at, thread) => {
        openDraft(at, thread);
      }}
    />
  );
  const open = item.state === "open";
  const aiShown = !isMine || !!view.ai || view.generating || busy === "ai" || !!view.ai_error;
  // A review of an earlier commit isn't shown, so it isn't taken for this commit's.
  const ai = view.ai_stale ? null : view.ai;

  // The diff's two orders.
  const pickOrder = (w: boolean) => {
    setTalking(false);
    setWalking(w);
    setDrawn(0); // the other view's sections draw a screenful first too, not all at once
  };
  const owed = view.conversation.filter((c) => c.waiting_on_you).length; // waiting on your reply: the tab's count
  // The views are tabs: the arrows, Home and End move to a view and show it.
  const tabKeys = (e: KeyEvent<HTMLButtonElement>) => {
    const tabs = [...(e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
    const at = tabs.indexOf(e.currentTarget);
    const to =
      e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const next = tabs[(to + tabs.length) % tabs.length];
    next?.focus();
    next?.click();
  };
  const tab = (name: string, on: boolean, pick: () => void, count = 0) => (
    <button
      key={name}
      type="button"
      role="tab"
      className={cls("head-tab", on && "on")}
      aria-selected={on}
      aria-controls="rv-panel"
      tabIndex={on ? 0 : -1}
      onKeyDown={tabKeys}
      onClick={pick}
    >
      {name}
      {count > 0 && (
        <span className="pill-count rv-tab-n" title={`${count} waiting on your reply`}>
          {count}
        </span>
      )}
    </button>
  );
  // What finishes it (its call to action, or Hand off or Back to desk on yours), then More, at the right of the bar
  // across the review's top. Done from here, what you did and where it went.
  const actions = (
    <div className="actions rv-actions">
      {acted && (
        <p className="rv-acted">
          <span className="rv-acted-what">✓ {acted.what}</span>
          <span className="rv-acted-dot" aria-hidden="true">
            ·
          </span>
          <a href={PLACE[acted.where].href}>{PLACE[acted.where].said}</a>
          {acted.sending && <span className="busy" aria-label="sending" />}
        </p>
      )}
      {readying && !acted && (
        <ActButton
          k="primary"
          label="Ready for review"
          run={run}
          title={
            picked.length
              ? `Mark it ready for review on GitHub and ask ${picked.map((p) => p.login).join(", ")}`
              : "Mark it ready for review on GitHub"
          }
          className="primary"
        />
      )}
      {asking && !acted && (
        <ActButton
          k="primary"
          label="Ask reviewers"
          run={run}
          title={
            picked.length
              ? `Ask ${picked.map((p) => p.login).join(", ")} to review it, on GitHub`
              : "Nobody's asked to review it: pick reviewers, then ask them"
          }
          className="primary"
        />
      )}
      {/* Only someone else's open PR is yours to approve: done, it says so; refused, a press says why. */}
      {open && !isMine && !acted && view.approve.approved && (
        <p className="rv-acted">
          <span className="rv-acted-what">✓ You approved</span>
        </p>
      )}
      {open && !isMine && !acted && !view.approve.approved && (
        <ActButton
          k="primary"
          label="Approve"
          run={run}
          title={view.approve.reason ?? "Approve on GitHub"}
          className={cls(canApprove && !writing && "primary")}
        />
      )}
      {/* While you owe replies, Reply is the one filled button. */}
      {/* Hand off or Back to desk once the review's read has where you sent it. */}
      {!(acted?.where === "inflight" && !card.inflight) && !(acted?.where === "queue" && card.inflight) && (
        <HandButton card={card} run={run} primary={card.cta !== "reply" && !asking && !acted} />
      )}
      <span className="more-wrap">
        <MoreButton
          open={more}
          onClick={() => {
            run("more");
          }}
        />
        {more && (
          <MoreMenu
            card={card}
            actions={(card.actions ?? []).filter((a) => a !== "draft" && a !== "ready" && a !== "reopen")}
            links={[
              // As the row's menu says it: Done, or Back on the desk once it's done, snoozed or muted.
              ...(!card.inflight && !acted
                ? [
                    {
                      label: card.status === "active" ? "Done" : "Back on the desk",
                      run: () => {
                        run("done");
                      },
                    },
                  ]
                : []),
              ...(yoursOpen && !asking && !acted ? [{ label: "Add reviewers", run: addReviewers }] : []),
              {
                label: "Show log",
                run: () => {
                  onCard(card, "log");
                },
              },
              {
                label: "Copy link",
                run: () => {
                  onCard(card, "link");
                },
              },
            ]}
            pick={(a) => {
              if (a === "request_changes") setWriting(true);
              else runUi(onGithub(card, a, read));
            }}
            onClose={() => {
              setMore(false);
            }}
          />
        )}
      </span>
    </div>
  );

  return (
    <>
      {/* Across the review's top, stuck there: its views as tabs, then what finishes it and More. */}
      <div className="rv-bar">
        <div className="rv-views" role="tablist" aria-label="Review, Code changes or Conversation">
          {guided &&
            tab("Review", !talking && walking, () => {
              pickOrder(true);
            })}
          {tab("Code changes", !talking && !guiding, () => {
            pickOrder(false);
          })}
          {tab(
            "Conversation",
            talking,
            () => {
              setTalking(true);
            },
            owed,
          )}
        </div>
        {actions}
      </div>
      <div className={cls("review", showSide && "side-open")}>
        {toggle}
        <div className="rv-main" id="rv-panel" role="tabpanel" aria-label={talking ? "Conversation" : guiding ? "Review" : "Code changes"}>
          <div className="rv-top">
            <Head card={card} me={me} now={now} resolved={resolved?.line ?? null} row={row} ai={aiShown && !deepGuides ? ai : null} />
            {!talking && walking && (
              <DeepSection
                deep={view.deep}
                running={
                  view.deep_running ??
                  (deepAsked && (view.deep?.at ?? null) === deepAsked.was && now - Date.parse(deepAsked.at) < 15_000 ? deepAsked.at : null)
                }
                error={view.deep_error}
                stale={!!view.deep && view.deep.head_oid !== item.head_oid}
                now={now}
                onRun={runDeep}
                onStep={(k) => {
                  if (steps[k]) toStep(k);
                }}
              />
            )}
            {/* Yours gets no AI summary unless asked for, so its description's first paragraph says what it's about. */}
            {isMine && !ai && item.body && <p className="rv-summary rv-desc">{item.body.split("\n")[0]}</p>}
            {/* Your own PR gets no AI review unless one was asked for; More still asks. */}
            {aiShown && !deepGuides && (
              <AiSection
                ai={ai}
                busy={view.generating || busy === "ai"}
                error={view.ai_error}
                job={view.ai_job}
                now={now}
                open={open}
                notes={notes.length}
                onLine={toLine}
                onAsk={
                  flying
                    ? undefined
                    : () => {
                        askAi();
                      }
                }
              />
            )}
          </div>

          {picking && !acted && (
            <Reviewers
              id={card.id}
              asked={item.review_requests.map((r) => ({ login: r.reviewer, team: r.type === "team" }))}
              picked={picked}
              setPicked={setPicked}
              ready={readying}
            />
          )}
          {writing && (
            <WriteBox
              label="Request changes"
              placeholder="What needs to change"
              kept={keptChanges(card.id)}
              onText={(t) => {
                keepChanges(card.id, t);
              }}
              onSend={(body) => {
                runUi(
                  onGithub(card, "request_changes", read, body).pipe(
                    Effect.tap((done) =>
                      Effect.sync(() => {
                        if (!done) return;
                        keepChanges(card.id, "");
                        setWriting(false);
                      }),
                    ),
                  ),
                );
              }}
              onClose={() => {
                keepChanges(card.id, "");
                setWriting(false);
              }}
            />
          )}

          {/* Kept while you read the diff, so a reply you're writing is there when you're back. */}
          <div className="rv-talk" hidden={!talking}>
            <Conversation
              view={view}
              me={me}
              now={now}
              flash={flash}
              agent={agent}
              onSpot={onSpot}
              onAsk={onAsk}
              saying={saying}
              onSaid={(s) => {
                tries.current = 0;
                say(s);
              }}
              foot={
                // Still there once you've acted, so you can comment on what you did; while Request changes is open its box
                // is the one you write in, so an empty comment box steps aside.
                (open || !!comment.trim()) &&
                !(writing && !comment.trim()) && (
                  <CommentBox
                    card={card}
                    me={me}
                    body={comment}
                    setBody={writeComment}
                    sending={!!acted?.sending}
                    onComment={(c, b) =>
                      onComment(c, b).pipe(
                        Effect.tap((ok) =>
                          Effect.sync(() => {
                            if (!ok) return;
                            tries.current = 0;
                            say({ convo: null, body: b.trim(), url: "" });
                          }),
                        ),
                      )
                    }
                  />
                )
              }
            />
          </div>
          {!talking && (
            <>
              {draft && (orphanAt < 0 || (folded && orphanAt >= rest)) && (
                <div className="rv-orphan">
                  <p className="quiet">
                    {draft.thread
                      ? "Your reply: its thread isn't on the diff on screen. It still goes to that thread."
                      : `Your comment on ${lineName(draft.at)}: that line isn't on the diff on screen. It still goes on the line you picked, in the commit you read.`}
                  </p>
                  {composer(draft.thread ? "Reply" : rangeLabel(draft.at))}
                </div>
              )}
              {view.files_error && <p className="t-bad rv-files-err">Couldn't load the diff: {view.files_error}</p>}
              {!view.files_error && !files.length && <p className="quiet rv-nofiles">No files changed.</p>}
              {list.length > 0 && (
                <div className="rv-diffs">
                  {visible.slice(0, Math.min(rest, upTo)).map((x, i) => {
                    const k = steps.findIndex((st) => st.at === i);
                    const end = steps.findIndex((_, j) => (steps[j + 1]?.at ?? beyond) === i + 1);
                    const next = steps[end + 1];
                    return (
                      <Fragment key={x.key}>
                        {k >= 0 && (
                          <header className="rv-step" id={`rv-step-${k}`}>
                            <h2 className="rv-step-head">
                              <span className="rv-step-n">
                                {k + 1} of {steps.length}
                              </span>{" "}
                              {steps[k]!.title}
                            </h2>
                            {steps[k]!.body && <p className="rv-step-body">{spans(unlinked(inline(steps[k]!.body)))}</p>}
                            {steps[k]!.check && (
                              <p className="rv-step-body">
                                <b>Check:</b> {spans(unlinked(inline(steps[k]!.check)))}
                              </p>
                            )}
                            {steps[k]!.note && <p className="rv-step-body rv-step-note">{spans(unlinked(inline(steps[k]!.note)))}</p>}
                            {figure(steps[k]!.diagram)}
                          </header>
                        )}
                        {steps.length > 0 && i === beyond && (
                          <h2 className="rv-step rv-step-head" id="rv-bugs">
                            Potential bugs outside the guide
                          </h2>
                        )}
                        {section(x, i)}
                        {end >= 0 &&
                          (next ? (
                            <button
                              type="button"
                              className="link-btn rv-next"
                              onClick={() => {
                                toStep(end + 1);
                              }}
                            >
                              Next: {next.title}
                            </button>
                          ) : (
                            <p className="quiet rv-next">
                              End of the guide.
                              {leftFiles > 0 && (
                                <>
                                  {" "}
                                  {leftFiles === 1 ? "1 more file changes" : `${leftFiles} more files change`} outside it:{" "}
                                  <button
                                    type="button"
                                    className="link-btn"
                                    onClick={() => {
                                      setWalking(false);
                                      scrollTo({ top: 0 });
                                    }}
                                  >
                                    read every file in Code changes
                                  </button>
                                </>
                              )}
                            </p>
                          ))}
                      </Fragment>
                    );
                  })}
                  {order?.ranked && rest < list.length && upTo >= rest && (
                    <button
                      type="button"
                      className={cls("fold", "rv-fold", folded && secIdx >= rest && "sel")}
                      aria-expanded={!folded}
                      onClick={() => {
                        if (folded) goTo(rest);
                        else {
                          holdKeys(false);
                          setRestOpen(false);
                        }
                      }}
                    >
                      {REST} · {list.length - rest} {list.length - rest === 1 ? "file" : "files"}
                    </button>
                  )}
                  {visible.slice(rest, upTo).map((x, i) => section(x, rest + i))}
                </div>
              )}
            </>
          )}
        </div>
        {showSide && room && (
          <Splitter
            width={SIDE}
            edge="left"
            column={() => document.querySelector<HTMLElement>("#rv-side")}
            label="the sidebar"
            className="rv-side-resize"
          />
        )}
        {showSide && (
          <aside id="rv-side" className="rv-side" aria-label="Status, stack, reviewers and files">
            <div className="rv-side-top" aria-hidden="true" />
            <StatusPart
              ai={ai}
              checks={view.checks}
              checksError={view.checks_error}
              size={size && { ...size, files: item.changed_files }}
              tone={calm(card)}
            />
            {/* Only while it's stacked: another open PR in its stack (the list shows the open ones and this one). */}
            {view.stack && [...view.stack.line, ...view.stack.forks].some((m) => m.state === "open" && !m.current) && (
              <StackList stack={view.stack} />
            )}
            <SidePart
              id="reviewers"
              name="Reviewers"
              line={reviewers.length ? "" : asks.shown.size ? "Nobody's asked" : view.reviewers.line}
              bad={view.reviewers.changes ? "t-warn" : ""}
              tone={calm(card)}
              // oxlint-disable-next-line no-map-spread -- each row is a new object with optional fields, not a reviewer copied
              rows={reviewers.map((r) => {
                const person = r.who !== "you" && !r.who.startsWith("@"); // a team's ask is the team's
                const yours = card.by === "you" && item.state === "open" && !acted;
                const remove = yours && person && r.state === "asked";
                const again = yours && person && !item.draft && r.state !== "asked" && !r.again;
                return {
                  name: r.who,
                  ...(r.who === "you" ? me && { login: me } : person && { login: r.who }),
                  state: r.again ? `${r.state} · asked again` : r.state,
                  bad: r.state === "changes requested" ? "t-warn" : "",
                  ...((remove || again) && {
                    tools: (
                      <button
                        type="button"
                        className="rv-rev-tool"
                        title={remove ? `Remove ${r.who} as a reviewer` : `Ask ${r.who} to review again`}
                        aria-label={remove ? `Remove ${r.who} as a reviewer` : `Ask ${r.who} to review again`}
                        onClick={() => {
                          askReviewer(r.who, remove ? "removed" : "asked", onReviewer(card, r.who, remove ? "remove" : "rerequest"));
                        }}
                      >
                        <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
                          {remove ? <path d="m4.5 4.5 7 7m0-7-7 7" /> : <path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 3v2.5H10" />}
                        </svg>
                      </button>
                    ),
                  }),
                };
              })}
              add={acted ? undefined : picking ? toPicker : yoursOpen && !sideAdding ? addReviewers : undefined}
            >
              {sideAdding && !acted && (
                <div className="rv-side-add">
                  {/* A pick is the ask: GitHub asks them at once, and the box stays for more. */}
                  <Reviewers
                    id={card.id}
                    asked={item.review_requests.map((r) => ({ login: r.reviewer, team: r.type === "team" }))}
                    picked={picked}
                    setPicked={setPicked}
                    ready={false}
                    compact
                    onPick={(r) => {
                      askReviewer(
                        r.team ? `@${r.login}` : r.login,
                        "asked",
                        onAddReviewer(card, r).pipe(
                          Effect.tap((ok) =>
                            Effect.sync(() => {
                              if (!ok) setPicked((ps) => ps.filter((p) => p.id !== r.id));
                            }),
                          ),
                        ),
                      );
                    }}
                  />
                  <div className="actions">
                    <button
                      type="button"
                      className="act"
                      onClick={() => {
                        setAdding("");
                        setPicked([]);
                      }}
                    >
                      Done
                    </button>
                  </div>
                </div>
              )}
            </SidePart>
            {view.merge && <SidePart id="merge" name="Merge" line={view.merge} bad="t-warn" tone={calm(card)} />}
            {!view.stack && deps.length > 0 && (
              <SidePart id="deps" name="Depends" line={deps.map((d) => d.text).join(" · ")} bad="" tone={calm(card)} />
            )}
            {steps.length > 0 && <StepList stops={stops} on={secIdx} onGo={goTo} />}
            {list.length > 0 && !steps.length && (
              <nav className="rv-files rv-steps rv-tree" aria-label="Files">
                <h2 className="rv-side-head">
                  <span>
                    {files.length} {files.length === 1 ? "file" : "files"}
                  </span>
                  {seen.size > 0 && <span className="rv-lvl">{seen.size} viewed</span>}
                </h2>
                {/* The guide's timeline, nested: a folder's files hang under it, the file you're in marked as you scroll. */}
                <FileTree
                  nodes={pathTree(list.map((x) => x.path))}
                  list={list}
                  on={onPath}
                  shut={shutDirs}
                  seen={seen}
                  onFold={(d) => {
                    setShutDirs((ds) => new Set(ds.has(d) ? [...ds].filter((x) => x !== d) : [...ds, d]));
                  }}
                  onGo={goTo}
                />
              </nav>
            )}
          </aside>
        )}
      </div>
    </>
  );
}

const without = (set: ReadonlySet<string>, x: string): ReadonlySet<string> => (set.has(x) ? new Set([...set].filter((y) => y !== x)) : set);
// The marks viewed once these changes land: true adds one, false takes it out.
const withMarks = (marks: ReadonlySet<string>, change: ReadonlyMap<string, boolean>): ReadonlySet<string> => {
  const next = new Set(marks);
  for (const [m, on] of change) {
    if (on) next.add(m);
    else next.delete(m);
  }
  return next;
};
// Whether any of these folders holds the file.
const hasInside = (dirs: ReadonlySet<string>, path: string) => [...dirs].some((d) => path.startsWith(`${d}/`));

// Code changes' files in the sidebar, as folders: each file once, where reading reaches it. A click folds a folder or opens
// it; the folders of the file you're in are ringed, and a folded one is marked in its place.
function FileTree({
  nodes,
  list,
  on,
  shut,
  seen,
  onFold,
  onGo,
}: {
  nodes: PathNode[];
  list: Section[];
  on: string | null; // the file you're in
  shut: ReadonlySet<string>; // folded folders, by path
  seen: ReadonlySet<string>; // files you've viewed, by path
  onFold: (dir: string) => void;
  onGo: (i: number) => void;
}) {
  return (
    <ol>
      {nodes.map((n) => {
        if (n.kids) {
          const open = !shut.has(n.path);
          const holds = !!on?.startsWith(`${n.path}/`);
          return (
            <li key={`${n.path}/`}>
              <button
                type="button"
                className={cls("rv-step-row", "rv-tree-dir", holds && (open ? "near" : "on"))}
                aria-expanded={open}
                title={`${open ? "Fold" : "Open"} ${n.path}`}
                onClick={() => {
                  onFold(n.path);
                }}
              >
                <span className="rv-step-dot" aria-hidden="true" />
                <span className="rv-step-name">{n.name}</span>
                {!open && <span className="rv-lvl">{countFiles(n)}</span>}
              </button>
              {open && <FileTree nodes={n.kids} list={list} on={on} shut={shut} seen={seen} onFold={onFold} onGo={onGo} />}
            </li>
          );
        }
        const i = list.findIndex((y) => y.path === n.path);
        const level = list[i]?.level;
        const viewed = seen.has(n.path);
        return (
          <li key={n.path}>
            <button
              type="button"
              className={cls("rv-step-row", on === n.path && "on", viewed && "seen")}
              aria-current={on === n.path ? "location" : undefined}
              title={viewed ? `${n.path} · viewed` : n.path}
              onClick={() => {
                onGo(i);
              }}
            >
              <span className="rv-step-dot" aria-hidden="true" />
              <span className="rv-step-name">{n.name}</span>
              {list.some((y) => y.path === n.path && y.notes.length > 0) && <span className="rv-nn" title="AI notes" />}
              {level && <span className="rv-lvl">{LEVEL[level]}</span>}
              {viewed && (
                <span className="rv-lvl" aria-hidden="true">
                  ✓
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

const countFiles = (n: PathNode): number => (n.kids ? n.kids.reduce((sum, k) => sum + countFiles(k), 0) : 1);

// The guided review's steps in the sidebar, where Code changes lists the files; the one you're in follows the scroll.
function StepList({
  stops,
  on,
  onGo,
}: {
  stops: { n: number; name: string; at: number; end: number; el: string; notes: boolean }[];
  on: number;
  onGo: (i: number, el: string) => void;
}) {
  return (
    <nav className="rv-files rv-steps" aria-label="Steps of the review">
      <h2 className="rv-side-head">
        <span>Review</span>
      </h2>
      {/* A timeline: a dot a step on one line down the list, the step you're on in a fluorescent purple. */}
      <ol>
        {stops.map((r) => {
          const here = on >= r.at && on < r.end;
          return (
            <li key={r.at} className={cls(here && "on")}>
              <button
                type="button"
                className={cls("rv-step-row", here && "on")}
                aria-current={here ? "step" : undefined}
                title={`${r.n}. ${r.name}`}
                onClick={() => {
                  onGo(r.at, r.el);
                }}
              >
                <span className="rv-step-dot" aria-hidden="true" />
                <span className="rv-step-name">{r.name}</span>
                {r.notes && <span className="rv-nn" title="AI notes" />}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// The header: the ref and who it's by, then the title; how big it is, who reviews it and what stands in its way are the
// sidebar's. A resolved
// PR's line, and Merging's for your PR there.
function Head({
  card,
  me,
  now,
  resolved,
  row,
  ai = null,
}: {
  card: Card;
  me: string;
  now: number;
  resolved: string | null;
  row: InflightRow | null;
  ai?: AiShown | null; // its verdict, a tag at the metadata's end
}) {
  const isMine = card.by === "you"; // yours, or a bot's opened for you
  const by = byOf(card, me);
  // What it waits on and the coordinator's latest note, as Merging says it.
  const lane = row?.state === "open" && (row.waits_on || row.note) ? row : null;
  return (
    <header className={cls("rv-head", calm(card))}>
      <h1 className="rv-title">{card.title}</h1>
      {/* Its metadata, under the title: the ref, who it's by, and the AI review's verdict as a tag. */}
      <p className="rv-ref">
        <a className="ref" href={card.url} target="_blank" rel="noreferrer" title={`${card.repo}#${card.number} on GitHub`}>
          <span className="ref-ink">
            <span className="ref-repo">{card.repo.split("/")[1]}</span>#{card.number}
          </span>
        </a>
        <span className="rv-by">
          by {by.face && <Avatar login={by.face} />}
          {by.who}
          {card.author_bot && !card.attribution?.person && !isMine ? " (bot)" : ""}
        </span>
        {ai && (
          <span
            className={`rv-tag verdict v-${ai.verdict}`}
            title={ai.model && ai.at ? `AI review by ${modelName(ai.model)}, ${when(ai.at)}` : "The AI review's verdict"}
          >
            {VERDICT[ai.verdict]}
          </span>
        )}
      </p>
      {card.handoff && (
        <p className="rv-meta rv-handoff">
          <span>
            <b>{handoffLabel(card.handoff)}</b> {card.handoff.why}
          </span>
        </p>
      )}
      {resolved && (
        <p className="rv-meta rv-resolved">
          <span>{resolved}</span>
          {card.resolved_at && <span>{sinceText(card.resolved_at, now)}</span>}
        </p>
      )}
      {lane && (
        <p className="rv-meta rv-lane">
          {lane.waits_on && <span>{lane.waits_on}</span>}
          {/* No space before the age, so a wrap takes the note's last word with it and the age never sits alone. */}
          {lane.note && (
            <span>
              {lane.note.text}
              <span className="rv-age">{age(lane.note.at, now)}</span>
            </span>
          )}
        </p>
      )}
    </header>
  );
}

// Another PR it needs merged first, and the open PRs that need it.
function depFacts(c: Card): Fact[] {
  return [
    ...(c.blocker ? [{ text: `blocked by ${c.blocker.ref}`, tone: "" }] : []),
    ...(c.blocks?.length ? [{ text: `blocks ${andMore(c.blocks)}`, tone: "" }] : []),
  ];
}

// The header's size as its row has it, until the review lands.
function rowSize(c: Card): { add: number; del: number } | null {
  const m = /^\+(\d+) −(\d+)/.exec(c.chips.find((x) => x.startsWith("+")) ?? "");
  return m ? { add: Number(m[1]), del: Number(m[2]) } : null;
}

// A placeholder file's lines, as [indent, width %]: none where a blank line would be.
const SK_CODE: readonly (readonly [number, number])[] = [
  [0, 42],
  [0, 30],
  [0, 0],
  [0, 48],
  [1, 26],
  [1, 34],
  [0, 4],
  [0, 0],
  [0, 58],
  [1, 44],
  [2, 36],
  [1, 4],
];
// A placeholder file tree, as [depth, width %]: a folder, its files, another folder.
const SK_TREE: readonly (readonly [number, number])[] = [
  [0, 18],
  [1, 34],
  [2, 46],
  [2, 38],
  [0, 30],
  [1, 52],
];

// The review before it lands: what its row knows, and quiet placeholders where the rest will be, so nothing moves.
function Shell({
  card,
  me,
  now,
  row,
  side,
  toggle,
}: {
  card: Card | null;
  me: string;
  now: number;
  row: InflightRow | null;
  side: boolean;
  toggle: ReactNode; // the sidebar's, as the loaded review draws it
}) {
  const isMine = card?.by === "you";
  const pf = card?.preflight;
  const rough = card ? rowSize(card) : null;
  const shellSize = rough && { ...rough, files: null }; // the row says its lines, not its files
  const ai =
    pf?.verdict && pf.risk && pf.summary
      ? {
          verdict: pf.verdict,
          risk: pf.risk,
          summary: pf.summary,
          ...(pf.since !== undefined && { since: pf.since }),
          concerns: pf.concerns ?? [],
        }
      : null;
  // An earlier commit's read isn't shown, as in the loaded review.
  const fresh = pf?.state === "ready" ? ai : null;
  // Opening it starts the review unless AI reviews are off or paused.
  const writing = pf?.state === "running" || pf?.state === "queued" || pf?.state === "stale";
  const none = !fresh && (pf?.state === "off" || pf?.state === "paused" || pf?.state === "failed");
  // Its call to action and More, where the loaded review draws them.
  const keys = (
    <div className="actions rv-actions" aria-hidden="true">
      {(!isMine || !!card?.cta) && <span className="sk sk-key sk-key-cta" />}
      <span className="sk sk-key" />
    </div>
  );
  return (
    <>
      <div className="rv-bar" aria-hidden="true">
        {/* Its views' names as bars: Review only where there's an AI review to guide by. */}
        <div className="rv-views">
          {fresh && <span className="sk sk-tab" />}
          <span className="sk sk-tab" />
          <span className="sk sk-tab" />
        </div>
        {keys}
      </div>
      <div className={cls("review", side && "side-open")} aria-busy="true">
        {toggle}
        <div className="rv-main">
          <div className="rv-top">
            {card ? (
              <Head
                card={card}
                me={me}
                now={now}
                resolved={card.resolved ? resolvedHead([], card.resolved, me).line : null}
                row={row}
                ai={fresh}
              />
            ) : (
              <header className="rv-head" aria-hidden="true">
                <h1 className="rv-title">
                  <span className="sk sk-title" />
                </h1>
                <p className="rv-ref">
                  <span className="sk sk-ref" />
                </p>
                <p className="rv-meta">
                  <span className="sk sk-meta" />
                </p>
              </header>
            )}
            {fresh || writing || none ? (
              <AiSection ai={fresh} busy={writing} error={null} job={null} now={now} open notes={pf?.notes ?? 0} onAsk={undefined} />
            ) : (
              (!isMine || !!card?.verdict) && (
                <section className="rv-ai" aria-label="AI review">
                  <SkLines count={1} className="rv-gist" />
                  <SkLines count={1} className="sk-verdict" />
                </section>
              )
            )}
          </div>
          <div className="rv-diffs" aria-hidden="true">
            {[0, 1].map((i) => (
              <section key={i} className="rv-file-sec">
                <h3 className="rv-fhead">
                  <span className="sk sk-chev" />
                  <span className="sk sk-file" />
                  <span className="sk sk-delta" />
                </h3>
                {/* Code, not prose: a gutter of line numbers, then lines of a file's lengths and indents. */}
                <div className="sk-code">
                  {SK_CODE.map((_, n) => {
                    const [indent, width] = SK_CODE[(n + i * 5) % SK_CODE.length]!;
                    return (
                      // oxlint-disable-next-line react/no-array-index-key -- a placeholder line is its place
                      <span key={n} className="sk-code-row">
                        <span className="sk sk-no" />
                        {width > 0 && <span className="sk" style={{ marginLeft: `${indent * 2}ch`, width: `${width}%` }} />}
                      </span>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
        {side && (
          <aside id="rv-side" className="rv-side" aria-hidden="true">
            <div className="rv-side-top" />
            <StatusPart
              ai={fresh}
              checks={null}
              checksError={null}
              size={shellSize}
              tone={card ? calm(card) : ""}
              pending={!card || (card.kind === "pr" && card.ci !== "none")}
            />
            {/* A PR's reviewers: a face, a name, where they stand. */}
            {card?.kind !== "issue" && (
              <section className="rv-part">
                <h2 className="rv-side-head">
                  <span>Reviewers</span>
                </h2>
                <span className="rv-part-row sk-reviewer">
                  <span className="sk sk-face" />
                  <span className="sk sk-name" />
                  <span className="sk sk-state" />
                </span>
              </section>
            )}
            {/* The files as the tree they'll be: folders, and the files hanging under them. */}
            <nav className="rv-files">
              <h2 className="rv-side-head">Files</h2>
              <div className="sk-tree">
                {SK_TREE.map(([depth, width], n) => (
                  // oxlint-disable-next-line react/no-array-index-key -- a placeholder line is its place
                  <span key={n} className="sk-tree-row" style={{ paddingLeft: depth * 14 }}>
                    <span className="sk sk-node" />
                    <span className="sk" style={{ width: `${width}%` }} />
                  </span>
                ))}
              </div>
            </nav>
          </aside>
        )}
      </div>
    </>
  );
}

// How big it is, in a word: by its lines changed and its files.
function changesWord(add: number, del: number, files: number | null): string {
  const lines = add + del;
  const n = files ?? 0; // unknown while it loads: its lines alone
  if (lines <= 100 && n <= 5) return "Small changes";
  if (lines <= 600 && n <= 20) return "Moderate changes";
  return "Lots of changes";
}

// One row of Status: what it says on the left, on the right a mark in its colour or what stands in for one (the checks'
// count, the diff); a click shows or hides what's behind it.
function StatusRow({
  id,
  said,
  end,
  children,
  open,
  setOpen,
}: {
  id: string;
  said: string; // "High risk", "Some checks failing", "Lots of changes"
  end: ReactNode;
  children: ReactNode;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  return (
    <li className="rv-status" data-status={id}>
      <button
        type="button"
        className="rv-status-row"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <span className="rv-status-said">{said}</span>
        {end}
      </button>
      {open && <div className="rv-status-more">{children}</div>}
    </li>
  );
}

// Status, at the top of the sidebar: the AI review's risk, the checks and how big the change is, a row each; a click on one
// shows its reasons, its list of checks or its counts.
function StatusPart({
  ai,
  checks,
  checksError,
  size,
  tone,
  pending,
}: {
  ai: AiShown | null;
  checks: Checks | null;
  checksError: string | null;
  size: { add: number; del: number; files: number | null } | null;
  tone: string;
  pending?: boolean; // the checks are on their way: their row's shape, where it'll be
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => (on: boolean) => {
    setOpen((o) => ({ ...o, [id]: on }));
  };
  if (!ai && !checks && !checksError && !size && !pending) return null;
  const reasons = ai?.risk_reasons ?? [];
  const passing = checks?.list.filter((c) => c.state === "passing").length ?? 0;
  return (
    <section className={cls("rv-part", tone)} data-part="status" aria-label="Status">
      <h2 className="rv-side-head">
        <span>Status</span>
      </h2>
      <ol className="rv-status-list">
        {ai && (
          <StatusRow
            id="risk"
            said={`${ai.risk[0]!.toUpperCase()}${ai.risk.slice(1)} risk`}
            end={
              // The rows' signal, for risk alone: one red bar for high, two orange for medium, all four green for low.
              <span className="rv-signal" title={`${ai.risk} risk`}>
                <Signal lit={RISK_BARS[ai.risk]} />
              </span>
            }
            open={!!open.risk}
            setOpen={toggle("risk")}
          >
            {reasons.length ? (
              <ul className="rv-status-why">
                {reasons.map((x) => (
                  <li key={x.why}>{x.why}</li>
                ))}
              </ul>
            ) : (
              <p className="rv-status-why">No reason given.</p>
            )}
          </StatusRow>
        )}
        {checks && (
          <StatusRow
            id="checks"
            said={checks.said}
            end={
              <span className="rv-status-count" title={`${passing} of ${checks.list.length} passing`}>
                <span className={`c-${checks.tone}`}>{passing}</span>/{checks.list.length}
              </span>
            }
            open={!!open.checks}
            setOpen={toggle("checks")}
          >
            <CheckRows checks={checks} />
          </StatusRow>
        )}
        {!checks && !checksError && pending && (
          <li className="rv-status" aria-hidden="true">
            <span className="rv-status-row">
              <span className="rv-status-said">
                <span className="sk sk-said" />
              </span>
              <span className="sk sk-count" />
            </span>
          </li>
        )}
        {!checks && checksError && (
          <StatusRow id="checks" said="Checks couldn't load" end={null} open={!!open.checks} setOpen={toggle("checks")}>
            <p className="rv-status-why t-bad">{checksError}</p>
          </StatusRow>
        )}
        {size && (
          <StatusRow
            id="changes"
            said={changesWord(size.add, size.del, size.files)}
            end={
              <span className="rv-size" title={`${size.add} lines added, ${size.del} removed`}>
                <span className="add">+{size.add}</span> <span className="del">−{size.del}</span>
              </span>
            }
            open={!!open.changes}
            setOpen={toggle("changes")}
          >
            <ul className="rv-status-why">
              {size.files !== null && <li>{`${size.files} ${size.files === 1 ? "file" : "files"} changed`}</li>}
              <li>{`${size.add} ${size.add === 1 ? "line" : "lines"} added`}</li>
              <li>{`${size.del} ${size.del === 1 ? "line" : "lines"} removed`}</li>
            </ul>
          </StatusRow>
        )}
      </ol>
    </section>
  );
}

// One part of the sidebar (the checks, the reviewers, the merge): a line that says where it stands, red or amber where
// that's a problem; with rows, a click opens it to each by name with its state in words, a link where it has a page.
function SidePart({
  id,
  name,
  line,
  bad,
  tone = "",
  rows,
  add,
  children,
}: {
  children?: ReactNode; // the reviewers' box, while you add some
  id: string; // data-part, for a check to find it by
  name: string;
  line: string; // "" when its rows say it all
  bad: string; // t-bad, t-warn, or "" for ink
  tone?: string; // calm(): on a sorted-away PR its problems are grey
  rows?: { name: string; login?: string; state: string; bad: string; tools?: ReactNode }[];
  add?: (() => void) | undefined; // the reviewers' Add reviewers, on your open PR or draft
}) {
  return (
    <section className={cls("rv-part", tone)} data-part={id} aria-label={name}>
      <h2 className="rv-side-head">
        <span>{name}</span>
      </h2>
      {line && (
        <p className={cls("rv-part-line", "fact-word", bad)} title={line}>
          {line}
        </p>
      )}
      {!!rows?.length && (
        <ol>
          {rows.map((r) => (
            <li key={r.name}>
              <span className="rv-part-row">
                <span className="rv-part-name">
                  {r.login && <Avatar login={r.login} />}
                  {r.name}
                </span>
                <span className={cls("rv-part-state", "fact-word", r.bad)}>{r.state}</span>
                {r.tools}
              </span>
            </li>
          ))}
        </ol>
      )}
      {children}
      {add && (
        <button type="button" className="rv-part-more" onClick={add}>
          + Add reviewers
        </button>
      )}
    </section>
  );
}

const DOT_WORDS: Record<Dot, string> = {
  red: "failing",
  amber: "failing, not required",
  yellow: "running",
  green: "passing",
  grey: "skipped",
};

// Every check, one row each (shards of one check under one row, a click opens them), what's wrong first; a dot says how
// each is doing. Status's Checks row opens it.
function CheckRows({ checks }: { checks: Checks }) {
  const [nested, setNested] = useState<Set<string>>(new Set());
  const shown = checkGroups(checks.list);
  const dot = (d: Dot) => <span className={cls("rv-dot", `d-${d}`)} aria-label={DOT_WORDS[d]} title={DOT_WORDS[d]} />;
  const link = (c: Check, label: string, cls_ = "rv-part-row") =>
    c.url ? (
      <a
        className={cls_}
        href={c.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`${c.name}: ${DOT_WORDS[checkDot(c)]}\n${urlPlace(c.url)}`}
      >
        {dot(checkDot(c))}
        <span className="rv-part-name">{label}</span>
      </a>
    ) : (
      <span className={cls_} title={`${c.name}: ${DOT_WORDS[checkDot(c)]}`}>
        {dot(checkDot(c))}
        <span className="rv-part-name">{label}</span>
      </span>
    );
  return (
    <ol>
      {shown.map((g) => {
        if (g.checks.length === 1) return <li key={g.name}>{link(g.checks[0]!, g.name)}</li>;
        const isOpen = nested.has(g.name);
        return (
          <li key={g.name}>
            <button
              type="button"
              className="rv-part-row rv-check-group"
              aria-expanded={isOpen}
              onClick={() => {
                const next = new Set(nested);
                if (isOpen) next.delete(g.name);
                else next.add(g.name);
                setNested(next);
              }}
            >
              {dot(g.dot)}
              <span className="rv-part-name">{g.name}</span>
              <span className="rv-part-state">{g.checks.length}</span>
              <span className="rv-chev" aria-hidden="true">
                ›
              </span>
            </button>
            {isOpen && (
              <ol className="rv-check-shards">
                {g.checks.map((c, i) => (
                  // oxlint-disable-next-line react/no-array-index-key -- two shards can share a name, and the list never reorders in place
                  <li key={i}>{link(c, c.name.slice(g.name.length).trim() || c.name)}</li>
                ))}
              </ol>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// A stack member's news as a mark: CI failing a red cross, approved a green tick.
const Mark = ({ d, tone }: { d: string; tone: string }) => (
  <svg className={cls("i rv-mark", tone)} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d={d} />
  </svg>
);

// The stack's open PRs bottom first, as the guide's timeline: a node each on one line, the PR on screen's in the accent and
// its title in ink; each member's news as a mark, words in its tooltip. A long one shows the PRs around this one, and the
// rest behind one line.
function StackList({ stack }: { stack: Stack }) {
  const [all, setAll] = useState(false);
  const live = (ms: StackMember[]) => ms.filter((m) => m.state === "open" || m.current);
  const line = live(stack.line);
  const forks = live(stack.forks);
  const at = Math.max(0, line.findIndex((m) => m.current) - 1);
  const more = line.length - STACK_SHOWN;
  // Folds only when two or more would go behind it, as the queue does.
  const shown = all || more < 2 ? line : line.slice(Math.min(at, more), Math.min(at, more) + STACK_SHOWN);
  const member = (m: StackMember) => {
    const state = m.state === "open" && m.draft ? "draft" : m.state;
    const words = [`#${m.number} ${state}`, ...(m.state === "open" ? [`CI ${CI[m.ci]}`, REVIEW[m.review]] : [])].join(" · ");
    return (
      <li key={m.id}>
        <a
          className={cls("rv-member", m.current && "on", m.state !== "open" && "dim")}
          href={routeHash({ name: "review", id: m.id })}
          aria-current={m.current ? "page" : undefined}
          title={`${words}\n${m.title}`}
        >
          <span className="rv-step-dot" aria-hidden="true" />
          <span className="rv-mnum">#{m.number}</span>
          <span className="rv-mtitle">{m.title}</span>
          {/* Passing, running and waiting on a review are no news; what's wrong or approved is: a red cross, amber, a green tick. */}
          {m.state === "open" && (
            <span className="rv-marks" aria-label={words}>
              {m.ci === "red" && <Mark d="M4.5 4.5l7 7M11.5 4.5l-7 7" tone="t-bad" />}
              {m.review === "changes_requested" && <span className="t-warn">changes</span>}
              {m.review === "approved" && <Mark d="M3.5 8.5l3 3 6-7" tone="t-ok" />}
            </span>
          )}
        </a>
      </li>
    );
  };
  return (
    <section className="rv-stack" aria-label="Stack">
      <h2 className="rv-side-head">
        <span>Stack on {stack.base}</span>
      </h2>
      <ol>
        {shown.map(member)}
        {more >= 2 && (
          <li>
            <button
              type="button"
              className="rv-more"
              aria-expanded={all}
              onClick={() => {
                setAll(!all);
              }}
            >
              {all ? "Fewer" : `${more} more`}
            </button>
          </li>
        )}
      </ol>
      {forks.length > 0 && (
        <>
          <h3 className="rv-side-head">Other branches</h3>
          <ol>{forks.map(member)}</ol>
        </>
      )}
    </section>
  );
}

// A long directory gives way from its start, so the file's own name stays whole and every name sits right after its folder.
function Dir({ path }: { path: string }) {
  return (
    <span className="rv-dir">
      <bdi>{path}</bdi>
    </span>
  );
}

// Your comment on the PR, at the Conversation tab's foot, while it's open (or while it has words): as tall as its words
// need, with Comment at its foot. Comment (or Cmd+Enter) sends it, Esc leaves it. The words are the
// review's, so GitHub refusing them leaves them here.
function CommentBox({
  card,
  me,
  body,
  setBody,
  sending,
  onComment,
}: {
  card: Card;
  me: string;
  body: string;
  setBody: (t: string) => void;
  sending: boolean;
  onComment: (c: Card, body: string) => Effect.Effect<boolean>;
}) {
  function send() {
    if (!body.trim() || sending) return;
    runUi(
      onComment(card, body).pipe(
        Effect.tap((done) =>
          Effect.sync(() => {
            if (done) setBody("");
          }),
        ),
      ),
    );
  }
  return (
    <div className="rv-comment">
      <Composer
        me={me}
        kind="rv-comment-input"
        label={`Comment on ${shortRef(card)}\u2026`}
        value={body}
        busy={sending}
        title={`Comment on GitHub, as you (${MOD}\u21b5)`}
        onChange={setBody}
        onSend={send}
      />
    </div>
  );
}
const sideOf = (s: "new" | "old"): "additions" | "deletions" => (s === "old" ? "deletions" : "additions");
const onSection = (x: Section, at: InlineAt) => at.path === x.path && onLines(x.hunks, at);
// The draft this window kept for a PR you left with words unsent.
function restored(id: string, n: number): Draft | null {
  const k: Kept | null = keptDraft(id);
  return k && { n, at: k.at, thread: k.thread, head: k.head, busy: false };
}

// Where a box is, as the chat names it: its thread, or the lines at the commit you picked them in.
function spotOf(d: Draft, rv: ReviewView): Spot {
  const convo = rv.conversation.find((x) => x.id === d.thread);
  if (convo) return threadOf(rv.card.id, convo);
  const lines = { ...d.at, head: d.head };
  return { kind: "lines", item: rv.card.id, lines, label: linesLabel(lines) };
}

// The section a draft's box belongs in; -1 once a push took its line or thread off the diff (it shows above the diff then).
function drawnAt(d: Draft, list: Section[], conversation: Convo[], head: string): number {
  if (!d.thread && d.head !== head) return -1; // a push since: the line it posts on isn't the one on screen any more
  return list.findIndex((x) => (d.thread ? threadsOn(conversation, x.path, x.hunks).some((t) => t.id === d.thread) : onSection(x, d.at)));
}

const rangeLabel = (at: InlineAt | undefined) => (at?.start ? `Comment on lines ${at.start.line}–${at.line}` : "Comment");

// A section's own cut of its file before and after: what follows it the same on both sides, as Pierre needs; null when it can't be.
function sectionCut(w: FileDiffLoadedFiles, file: ReviewFile, x: Section): FileDiffLoadedFiles | null {
  if (!w.oldFile) return null;
  const c = wholeFor(
    { old: w.oldFile.contents, new: w.newFile.contents },
    file.patch ?? "",
    x.hunks.map((h) => h.patch),
  );
  return c && { oldFile: { ...w.oldFile, contents: c.old }, newFile: { ...w.newFile, contents: c.new } };
}

function SectionView({
  section: x,
  index,
  file,
  notes,
  looks,
  order,
  bugs,
  now,
  shut,
  onFold,
  viewed,
  onViewed,
  conversation,
  canComment,
  draft,
  composer,
  head,
  opened,
  onOpen,
  sent,
  onDraft,
  loadFile,
  wholeFile,
}: {
  section: Section;
  index: number;
  file: ReviewFile;
  loadFile: (f: ReviewFile) => Promise<FileDiffLoadedFiles>; // on a band's click, saying why when it can't
  wholeFile: (f: ReviewFile) => Promise<FileDiffLoadedFiles>; // ahead, quietly
  notes: ReviewNote[]; // the AI review's
  looks: ReviewLook[]; // the AI review's: where correctness hinges
  order: number[]; // ReviewView.order.notes: a note's place in it is its place in reading order
  bugs: number; // the notes before this one are the AI review's concerns: potential bugs
  now: number;
  shut: boolean; // you folded this file
  onFold: () => void;
  viewed: boolean; // you marked every hunk of it viewed
  onViewed: (on: boolean) => void;
  conversation: Convo[];
  canComment: boolean;
  draft: Draft | null;
  composer: (label: string) => ReactNode; // the box you write in
  head: string; // the commit on screen
  opened: ReadonlySet<string>; // resolved threads you opened: kept here, as Pierre redraws them when a box opens or closes
  onOpen: (id: string, open: boolean) => void;
  sent: Sent[]; // yours that the conversation doesn't show yet
  onDraft: (at: InlineAt, thread: string | null) => void;
}) {
  // Pierre keeps a drawn diff by this key: the commit and the hunks, so a push or a regroup draws what a + will post on.
  const cacheKey = `${head}:${x.hunks.map((h) => h.id).join(",")}`;
  const partial = useMemo(
    () =>
      x.hunks.length
        ? (parsePatchFiles(filePatch({ ...file, patch: x.hunks.map((h) => h.patch).join("\n") }), cacheKey)[0]?.files[0] ?? null)
        : null,
    [x, file, cacheKey],
  );
  // Drawn, its file is read whole ahead; it's drawn whole (highlighting the whole file) only once the pointer comes near, so a
  // band's first click opens lines without a big PR paying for every file it shows. Until then, or if GitHub won't, the patch's.
  const [whole, setWhole] = useState<FileDiffLoadedFiles | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const stop = new AbortController();
    if (!shut && partial?.isPartial)
      runUi(
        Effect.tryPromise(() => wholeFile(file)).pipe(
          Effect.tap((w) =>
            Effect.sync(() => {
              setWhole(w);
            }),
          ),
          Effect.ignore,
        ),
        { signal: stop.signal },
      );
    return () => {
      stop.abort();
    };
  }, [shut, partial, file, wholeFile]);
  const fileDiff = useMemo(() => {
    const files = partial?.isPartial && whole && near ? sectionCut(whole, file, x) : null;
    return partial && files
      ? Effect.runSync(Effect.try(() => hydratePartialDiff("clone", partial, files)).pipe(Effect.orElseSucceed(() => partial)))
      : partial;
  }, [partial, whole, near, file, x]);
  const mine = useMemo(
    () =>
      x.notes.flatMap((n) => {
        const note = notes[n];
        return note ? [{ note, index: order.indexOf(n), inline: onLines(x.hunks, note) }] : [];
      }),
    [x, notes, order],
  );
  const threads = useMemo(() => threadsOn(conversation, x.path, x.hunks), [conversation, x]);
  const replyTo = draft?.thread ? threads.find((t) => t.id === draft.thread) : undefined;
  const writing = draft && (draft.thread ? !!replyTo : draft.head === head && onSection(x, draft.at)) ? draft : null;
  // A reply sits under its thread wherever a push has moved it.
  const boxLine = replyTo ? (replyTo.line ?? 0) : writing?.at.line;
  const boxSide = replyTo ? (replyTo.side ?? "new") : writing?.at.side;
  const annotations = useMemo(
    () => [
      // First, so nothing landing on the file moves it (Pierre keys these by place); its CSS order puts it last on its line.
      ...(writing && boxLine && boxSide ? [{ side: sideOf(boxSide), lineNumber: boxLine, metadata: { kind: "draft" } as const }] : []),
      ...[...new Set(x.hunks.flatMap((h) => h.looks ?? []))].flatMap((i): DiffLineAnnotation<Meta>[] => {
        const l = looks[i];
        return l ? [{ side: sideOf(l.side), lineNumber: l.line, metadata: { kind: "look", line: l.line, end: l.end, why: l.why } }] : [];
      }),
      ...mine
        .filter((n) => n.inline)
        .map((n): DiffLineAnnotation<Meta> => ({
          side: sideOf(n.note.side),
          lineNumber: n.note.line,
          metadata: { kind: "note", index: n.index, body: n.note.body, ...(n.note.flag && { is: n.note.flag }) },
        })),
      ...threads.map((t): DiffLineAnnotation<Meta> => ({
        side: sideOf(t.side ?? "new"),
        lineNumber: t.line ?? 0,
        metadata: { kind: "thread", id: t.id },
      })),
      ...sent
        .filter((s) => !s.thread && onSection(x, s.at))
        .map((s): DiffLineAnnotation<Meta> => ({
          side: sideOf(s.at.side),
          lineNumber: s.at.line,
          metadata: { kind: "sent", body: s.body, url: s.url },
        })),
    ],
    [mine, looks, threads, writing, boxLine, boxSide, sent, x],
  );
  // The lines marked only while you drag down the gutter: Pierre's own selection would outlive the box, and pin the + to it.
  const [dragging, setDragging] = useState<SelectedLineRange | null>(null);
  const gutter = useRef<(r: SelectedLineRange) => void>(() => {});
  gutter.current = (r) => {
    setDragging(null);
    const at = inlineAt(x.path, x.hunks, r);
    if (at) onDraft(at, null);
  };
  useSyncExternalStore(onOmarchy, omarchyTheme); // a live switch of Omarchy's theme draws the diff in its colours
  const load = useRef(loadFile);
  load.current = loadFile;
  const fileRef = useRef(file);
  fileRef.current = file;
  const sectionRef = useRef(x);
  sectionRef.current = x;
  const theme = diffOptions();
  const base = useMemo(
    (): FileDiffOptions<Meta, undefined> => ({
      ...theme,
      loadDiffFiles: () =>
        load
          .current(fileRef.current)
          .then((w) => sectionCut(w, fileRef.current, sectionRef.current) ?? Promise.reject(new Error("no more lines to show here"))),
    }),
    [theme],
  );
  const options = useMemo(
    (): FileDiffOptions<Meta, undefined> =>
      canComment
        ? {
            ...base,
            enableGutterUtility: true,
            onGutterUtilityClick: (r) => {
              gutter.current(r);
            },
            onLineSelectionChange: setDragging,
          }
        : base,
    [base, canComment],
  );
  const [dir, name] = splitPath(x.path);
  const status = STATUS[file.status];
  const level = x.level && LEVEL[x.level];
  const adds = x.hunks.reduce((n, h) => n + h.additions, 0);
  const dels = x.hunks.reduce((n, h) => n + h.deletions, 0);
  return (
    <section
      className={cls("rv-file-sec", shut && "shut")}
      id={`rv-s-${index}`}
      aria-label={x.path}
      onPointerEnter={() => {
        setNear(true);
      }}
    >
      <h3 className="rv-fhead">
        <button
          type="button"
          className="rv-fold-btn"
          aria-expanded={!shut}
          title={shut ? "Show this file" : "Fold this file"}
          onClick={onFold}
        >
          <span className="rv-chev" aria-hidden="true">
            ›
          </span>
          {level && <span className={`rv-level l-${x.level}`}>{level}</span>}
          <span className="rv-fname">
            {dir && <Dir path={dir} />}
            <span className="rv-base">{name}</span>
          </span>
        </button>
        {x.why && (
          <span className="rv-why" title={x.why}>
            {x.why}
          </span>
        )}
        {status && (
          <span className="rv-fstatus">
            {status}
            {file.previous_path ? ` from ${file.previous_path}` : ""}
          </span>
        )}
        {x.hunks.length > 0 && <span className="rv-delta">{`+${adds} −${dels}`}</span>}
        <label
          className="rv-viewed"
          title={viewed ? "Viewed: folded until a push changes it" : "Mark as viewed: folds it until a push changes it"}
        >
          <input
            type="checkbox"
            checked={viewed}
            onChange={(e) => {
              onViewed(e.target.checked);
            }}
          />
          Viewed
        </label>
      </h3>
      {!shut && x.tags.length > 0 && (
        <div className="rv-ttags">
          {x.tags.map((t) => (
            <span
              key={t.id}
              className="rv-tag rv-ttag"
              title={tagTip(t)}
              style={{ ...(t.bg && { background: t.bg }), ...(t.fg && { color: t.fg }) }}
            >
              {t.name}
            </span>
          ))}
        </div>
      )}
      {!shut &&
        mine
          .filter((n) => !n.inline)
          .map((n) => <Note key={n.index} index={n.index} body={n.note.body} bug={n.index < bugs} is={n.note.flag} />)}
      {!shut && fileDiff && (
        <FileDiff<Meta>
          className="rv-diff"
          // Pierre draws a frame or more after the page; its height held meanwhile, nothing below it jumps.
          style={{ minHeight: diffRows(x.hunks) * ROW }}
          fileDiff={fileDiff}
          options={options}
          selectedLines={dragging}
          lineAnnotations={annotations}
          renderAnnotation={(a) => {
            const m = a.metadata;
            if (m.kind === "note") return <Note key={`n${m.index}`} index={m.index} body={m.body} bug={m.index < bugs} is={m.is} />;
            if (m.kind === "look") return <Look key={`l${m.line}`} line={m.line} end={m.end} why={m.why} />;
            if (m.kind === "draft") return composer(writing?.thread ? "Reply" : rangeLabel(writing?.at));
            if (m.kind === "sent") return <Yours key={`s${m.url}`} body={m.body} url={m.url} />;
            const t = threads.find((c) => c.id === m.id);
            if (!t) return null;
            return (
              <ThreadNote
                key={t.id}
                convo={t}
                sent={sent.filter((s) => s.thread === t.id)}
                now={now}
                replying={draft?.thread === t.id}
                open={opened.has(t.id) || draft?.thread === t.id}
                onOpen={(o) => {
                  onOpen(t.id, o);
                }}
                onReply={
                  canComment && draft?.thread !== t.id
                    ? () => {
                        onDraft({ path: x.path, line: t.line ?? 0, side: t.side ?? "new" }, t.id);
                      }
                    : null
                }
              />
            );
          }}
        />
      )}
    </section>
  );
}

// What you're writing under a line: Cmd+Enter or its button posts it on GitHub, as you; Esc leaves an empty one.
function InlineBox({
  label,
  busy,
  text,
  focus,
  hadFocus,
  sel,
  onSel,
  onFocused,
  onFocusChange,
  onText,
  onSend,
  onCancel,
  onAsk,
}: {
  label: string;
  busy: boolean;
  text: string;
  focus: number; // asks for the cursor; 0 leaves it where it is
  hadFocus: boolean; // drawn again while you were typing in it: it takes the cursor back
  sel: [number, number] | null; // and puts it back where it was
  onSel: (sel: [number, number]) => void;
  onFocused: () => void;
  onFocusChange: (focused: boolean) => void;
  onText: (text: string) => void;
  onSend: (text: string) => void;
  onCancel: () => void;
  onAsk?: (() => void) | undefined; // Ask your agent: your chat about this spot; what you typed here stays here
}) {
  const [value, setValue] = useState(text);
  const area = useRef<HTMLTextAreaElement>(null);
  const focused = useRef(onFocused);
  focused.current = onFocused;
  const [keep] = useState(hadFocus); // as it was when this box was drawn
  const [at] = useState(sel);
  // In the commit that takes it out, before any key queued meanwhile is handled.
  useLayoutEffect(
    () => () => {
      boxGone();
    },
    [],
  );
  // Pierre slots it into its diff a frame or two after it mounts, and focus doesn't take until then.
  useEffect(() => {
    let frame = 0;
    let tries = 0;
    const take = () => {
      const el = area.current;
      if (!el) return;
      if (tries++ > 300) {
        boxBack();
        return;
      }
      if (el !== document.activeElement) el.focus({ preventScroll: true });
      if (el !== document.activeElement) {
        frame = requestAnimationFrame(take);
        return;
      }
      if (keep && at) el.setSelectionRange(at[0], at[1]);
      else el.setSelectionRange(el.value.length, el.value.length);
      // The whole box in view, its Comment under the words too, not only where you type.
      (el.closest(".rv-inline") ?? el).scrollIntoView({ block: "nearest" });
      boxBack();
      focused.current();
    };
    if (focus || keep) frame = requestAnimationFrame(take);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [focus, keep, at]);
  const send = () => {
    if (value.trim() && !busy) onSend(value);
  };
  return (
    <div className={cls("rv-inline", label === "Reply" && "rv-inline-reply")}>
      <textarea
        ref={area}
        className="cv-reply"
        aria-label={label}
        placeholder={`${label}, as you`}
        value={value}
        readOnly={busy}
        onFocus={() => {
          onFocusChange(true);
        }}
        onBlur={(e) => {
          // A box Pierre is drawing again is taken out without your leaving it: only a real blur lets the cursor go.
          const el = e.currentTarget;
          requestAnimationFrame(() => {
            const page = document.activeElement === null || document.activeElement === document.body;
            if (el !== document.activeElement && (el.isConnected || !page)) onFocusChange(false);
          });
        }}
        onChange={(e) => {
          setValue(e.target.value);
          onText(e.target.value);
          onSel([e.target.selectionStart, e.target.selectionEnd]);
        }}
        onSelect={(e) => {
          onSel([e.currentTarget.selectionStart, e.currentTarget.selectionEnd]);
        }}
        onKeyDown={(e) => {
          if (e.repeat) return;
          if (e.key === "Escape") {
            onFocusChange(false); // before a fold that may follow at once draws it again
            if (value.trim()) e.currentTarget.blur();
            else onCancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="actions">
        <button
          type="button"
          className="act primary"
          title={`${label === "Reply" ? "Reply" : "Comment"} on GitHub, as you (${MOD}\u21b5)`}
          disabled={!value.trim() || busy}
          onClick={send}
        >
          {label === "Reply" ? "Reply" : "Comment"}
          {busy && <span className="busy" aria-label="posting" />}
        </button>
        <button type="button" className="act" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        {onAsk && (
          <button
            type="button"
            className="act"
            disabled={busy}
            title={
              label === "Reply"
                ? "Your chat with your agent about this thread; what you typed here stays here, unsent"
                : "Your chat with your agent about these lines; what you typed here stays here, unsent"
            }
            onClick={onAsk}
          >
            Ask your agent
          </button>
        )}
      </div>
    </div>
  );
}

// A review thread where it was left. GitHub text: shown as text, never as markup.
function ThreadNote({
  convo,
  sent,
  now,
  replying,
  open,
  onOpen,
  onReply,
}: {
  convo: Convo;
  sent: Sent[];
  now: number;
  replying: boolean; // your reply box comes right after it
  open: boolean;
  onOpen: (open: boolean) => void;
  onReply: (() => void) | null;
}) {
  const body = (
    <>
      {convo.comments.map((c) => (
        <div key={c.id} className="rv-tc">
          <span className="rv-tc-who">
            {!c.bot && <Avatar login={c.author} />}
            {c.author}
          </span>
          <span className="rv-tc-at">{age(c.at, now)}</span>
          <div className="rv-tc-body">
            <SaidText text={c.body} />
          </div>
        </div>
      ))}
      {sent.map((s) => (
        <Yours key={s.url || s.body} body={s.body} url={s.url} />
      ))}
      <div className="rv-tc-acts">
        {onReply && (
          <button type="button" className="link-btn rv-tc-reply" onClick={onReply}>
            Reply
          </button>
        )}
        <a href={convo.url} target="_blank" rel="noopener noreferrer">
          On GitHub
        </a>
      </div>
    </>
  );
  if (!convo.resolved)
    return (
      <div className="rv-thread" data-replying={replying || undefined}>
        {body}
      </div>
    );
  return (
    <details
      className="rv-thread resolved"
      data-replying={replying || undefined}
      open={open}
      onToggle={(e) => {
        if (e.currentTarget.open !== open) onOpen(e.currentTarget.open);
      }}
    >
      <summary>
        {"Resolved \u00b7 "}
        {convo.comments[0]?.author}: <Words text={convo.comments[0]?.body.split("\n")[0] ?? ""} />
      </summary>
      {body}
    </details>
  );
}

// Yours from here, until the refreshed conversation has it.
function Yours({ body, url }: { body: string; url: string }) {
  return (
    <div className="rv-tc rv-tc-mine">
      <span className="rv-tc-who">You</span>
      <span className="rv-tc-at">
        {url ? (
          <a href={url} target="_blank" rel="noopener noreferrer">
            sent
          </a>
        ) : (
          "sent"
        )}
      </span>
      <div className="rv-tc-body">
        <Words text={body} />
      </div>
    </div>
  );
}

// Where the change's correctness hinges: read these lines even if nothing else.
function Look({ line, end, why }: { line: number; end: number; why: string }) {
  return (
    <div className="rv-note rv-look">
      <b>Look here{end > line ? `, lines ${line}–${end}` : ""}:</b> {spans(unlinked(inline(why)))}
    </div>
  );
}

// Claude's words on the PR's code, drawn as the AI review's are: code as code, a URL as text.
// The AI review's note on a line; a concern says so first: it's a potential bug, with what shows it and how to confirm it.
// A deep review's says what it is: a blocker, an issue, a question for you, what it verified, or a nit.
const NOTE_LABEL: Record<NoteKind, string> = { blocker: "Blocker", issue: "Issue", question: "Question", verified: "Verified", nit: "Nit" };
function Note({ index, body, bug, is }: { index: number; body: string; bug: boolean; is?: NoteKind | undefined }) {
  const label = is ? NOTE_LABEL[is] : bug ? "Potential bug" : null;
  return (
    <div className={cls("rv-note", (is ? is === "blocker" || is === "issue" : bug) && "bug", is && `rv-note-${is}`)} data-note={index}>
      {label && <b className="rv-bug">{label}</b>}
      {spans(unlinked(inline(body)))}
    </div>
  );
}
