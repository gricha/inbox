import { Effect } from "effect";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parsePatchFiles, type SelectedLineRange } from "@pierre/diffs";
import { FileDiff, type DiffLineAnnotation, type FileDiffOptions } from "@pierre/diffs/react";
import type {
  ActivityEvent,
  AiReview,
  Card,
  Conversation as Convo,
  GitHubAction,
  InflightRow,
  InlineAt,
  ReviewFile,
  ReviewNote,
  Reviewer,
  ReviewView,
  Stack,
  StackMember,
} from "../../../src/types.ts";
import { andMore } from "../../../src/stage.ts";
import { api, runUi } from "../api.ts";
import { age, cls, eventText, handoffLabel, MOD, modelName, sinceText, shortRef, when } from "../format.ts";
import { blocks, inline, lead, unlinked } from "../prose.ts";
import { reviewOf } from "../reviews.ts";
import {
  boxBack,
  boxGone,
  holding,
  holdKeys,
  isSending,
  keepDraft,
  keptDraft,
  keysHeld,
  returnDraft,
  sendingOn,
  watchKept,
  type Kept,
} from "../drafts.ts";
import {
  currentFile,
  diffRows,
  drawUpTo,
  filePatch,
  inlineAt,
  lineName,
  linesLabel,
  onLines,
  resolvedHead,
  routeHash,
  says,
  sections,
  splitPath,
  threadsOn,
  type Acted,
  type Section,
} from "../view.ts";
import "../diffThemes.ts";
import { getStored, setStored } from "../storage.ts";
import { diffTheme } from "../theme.ts";
import { Owed } from "./CardRow.tsx";
import { CI, HandButton, ActButton, REVIEW } from "./Detail.tsx";
import type { Spot } from "./Chat.tsx";
import { Conversation, threadOf } from "./Conversation.tsx";
import { MoreButton, MoreMenu, WriteBox } from "./More.tsx";
import { ProseBlocks, spans, Words } from "./Prose.tsx";
import { Reviewers } from "./Reviewers.tsx";
import { SkLines } from "./Skeleton.tsx";

// What sits under a line of the diff: an AI note (index: its place in reading order), a review thread, the comment you're
// writing, or one you sent that the conversation doesn't show yet.
type Meta =
  | { kind: "note"; index: number; body: string }
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

interface Sent {
  at: InlineAt;
  thread: string | null;
  body: string;
  url: string;
}

interface Fact {
  text: string;
  tone: string; // t-bad, t-warn, or "" for pencil
}

const EVENTS_SHOWN = 3; // the rest of the recent activity is a click away, so the diff stays near the top
const LINE = 96; // px below the window's top where "the section you're in" is read off
const VERDICT = { look: "Look closely", skim: "Skim it", skip: "Skip it" };
const LEVEL: Record<NonNullable<Section["level"]>, string> = { look: "Look", skim: "Skim", unread: "Not read", skip: "Skip" };
const STATUS: Partial<Record<ReviewFile["status"], string>> = { added: "new", removed: "deleted", renamed: "renamed", copied: "copied" };
const REST = "Not worth reviewing"; // the fold's line
const STACK_SHOWN = 4; // the PR below this one, this one and two above; the rest of a long stack is a click away
const ROOM = 1000; // px of the page's column (styles.css's @container pane): narrower, the sidebar opens over the diff, folded
const ROW = 19; // px: .rv-diff's --diffs-line-height
const SIDE = "desk.review.side"; // this device's choice: the review's sidebar open or folded, where it has room
const pane = () => document.querySelector(".col");
const roomy = () => (pane()?.clientWidth ?? innerWidth) >= ROOM;

// Pierre draws the diff in a shadow root; its syntax colours and light or dark follow the app's theme (diffOptions).
const DIFF: FileDiffOptions<Meta, undefined> = {
  diffStyle: "unified",
  diffIndicators: "bars",
  lineDiffType: "word-alt",
  hunkSeparators: "line-info-basic",
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
  me: string; // your login: Hand off for merge and Back to desk are for your own PRs
  now: number;
  flash: (text: string, error?: boolean) => void;
  onCard: (c: Card, key: string) => void; // d Done, m Hand off for merge, b Back to desk: as in its row's menu
  onGithub: (c: Card, action: GitHubAction, head: string, body?: string) => Effect.Effect<boolean>; // the More menu's writes, and Request changes
  acted: Acted | undefined; // what you did on it from here: shown in place of the button you pressed
  row: InflightRow | null; // your PR in Merging: what it waits on and the coordinator's note go under the facts, as in Merging
  // Approve, Ready for review, Ask reviewers: App sends these, as from a row; it leaves the desk, and the review goes back to the list.
  onApprove: (c: Card, head: string) => void;
  onReady: (c: Card, picked: Reviewer[]) => void;
  onAskReviewers: (c: Card, picked: Reviewer[]) => void; // your ready PR nobody's asked to review: ask who you picked
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
  const [side, setSide] = useState(() => getStored(SIDE) !== "folded");
  const [room, setRoom] = useState(roomy); // the page's column has room for the sidebar beside the diff
  const [over, setOver] = useState(false); // without room, Files opened it over the diff (not kept)
  const showSide = (room ? side : over) && !chat;
  const [busy, setBusy] = useState<"ai" | null>(null);
  const [drawn, setDrawn] = useState(0); // sections drawn past the first screenful
  const [picked, setPicked] = useState<Reviewer[]>([]); // who Ready for review asks
  const [more, setMore] = useState(false); // the More menu
  const [writing, setWriting] = useState(false); // Request changes, being written
  // Your comment on the PR, unsent: kept here, not in its box, so a refusal, acting on the PR or its closing never loses it.
  const [comment, setComment] = useState("");
  const [shut, setShut] = useState<ReadonlySet<string>>(new Set()); // files whose diff you folded, by path
  const [draft, setDraft] = useState<Draft | null>(() => restored(id, 1));
  const [sent, setSent] = useState<Sent[]>([]);
  const draftText = useRef(keptDraft(id)?.text ?? ""); // here, so a box Pierre redraws keeps your words without a render per keystroke
  const drafts = useRef(1);
  const alive = useRef(true);
  const draftSel = useRef<[number, number] | null>(null); // where the caret was, for a box drawn again
  const [stay, setStay] = useState<number | null>(null); // after a fold: the file you were in, kept in view
  const [focusAsk, setFocusAsk] = useState(0); // bumped to put the cursor in the box; a box drawn again after a fold doesn't take it
  const focusDone = useRef(0);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set()); // resolved threads you opened, by id
  // The commit this review opened at: approve, merge and request changes stay pinned to it, so a push you haven't reopened for is refused.
  const [read, setRead] = useState("");
  const seq = useRef(0);
  const jumped = useRef(0); // when a click last scrolled the page to a file
  const v = typeof view === "object" ? view : null;
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
  // Your ready PR nobody's asked to review: Ask reviewers asks who you pick.
  const asking = v?.card.cta === "reviewers";
  const picking = readying || asking;
  // A PR in Merging is the coordinator's: no AI review to ask for.
  const flying = !!row && row.state === "open";

  useEffect(() => {
    window.scrollTo(0, 0); // a different PR starts at the top; a refresh stays put
  }, []);

  // The page's column narrows with the list beside it, the chat or the window; given room again, the sidebar goes back beside the diff.
  useEffect(() => {
    const col = pane();
    const watch = new ResizeObserver(() => {
      const r = roomy();
      setRoom(r);
      if (r) setOver(false);
    });
    if (col) watch.observe(col);
    return () => {
      watch.disconnect();
    };
  }, []);

  useEffect(() => {
    const n = ++seq.current;
    const stop = new AbortController();
    void runUi(
      reviewOf(id).pipe(
        Effect.match({
          onSuccess: (r) => {
            if (n !== seq.current) return;
            setView(r);
            setRead((h) => h || r.item.head_oid);
          },
          // Keep what's on screen if a refresh fails.
          onFailure: (e) => {
            if (n === seq.current) setView((cur) => (cur && typeof cur === "object" ? cur : e.message));
          },
        }),
      ),
      { signal: stop.signal },
    );
    return () => {
      stop.abort();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- loads changes on every server update; that's when to refetch
  }, [id, loads]);

  // Opened to ask reviewers (its row's Add reviewers): the box has the cursor, once per PR.
  const askedFocus = useRef("");
  useEffect(() => {
    if (!asking || askedFocus.current === id) return;
    askedFocus.current = id;
    requestAnimationFrame(() => {
      document.querySelector<HTMLInputElement>(".rv-reviewers-input")?.focus();
    });
  }, [asking, id]);

  // The desk's reading order; its notes are only those written for this commit, in reading order.
  const order = v?.order;
  const { list, rest } = useMemo(() => (order ? sections(order) : { list: [], rest: 0 }), [order]);
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

  // The sidebar scrolls on its own to keep the current file in sight; the page doesn't move.
  useEffect(() => {
    const box = document.querySelector<HTMLElement>(".rv-side");
    const on = box?.querySelector<HTMLElement>(".rv-file.on");
    if (!box || !on || box.scrollHeight <= box.clientHeight) return;
    if (on.offsetTop < box.scrollTop) box.scrollTop = on.offsetTop - 8;
    else if (on.offsetTop + on.offsetHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = on.offsetTop + on.offsetHeight - box.clientHeight + 8;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- reads the DOM the new secIdx just rendered
  }, [secIdx]);

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
    if (i >= rest) setRestOpen(true);
    setDrawn((d) => Math.max(d, i + 1));
    setSecIdx(i);
    requestAnimationFrame(() => {
      document.querySelector(el)?.scrollIntoView({ block });
    });
  }

  function toggleFold(path: string, at: number) {
    holdKeys(false); // you've left the box for the fold
    const next = new Set(shut);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setShut(next);
    setStay(at);
  }

  // To the words you haven't sent, opening their file (or the rest, which goTo opens) if it's folded, with the cursor in them.
  function backToDraft(d: Draft) {
    if (!v) return;
    const i = drawnAt(d, list, v.conversation, v.diff_head);
    const path = list[i]?.path;
    if (path && shut.has(path)) setShut((cur) => new Set([...cur].filter((p) => p !== path)));
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
    void runUi(
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
            setSent((s) => [...s, { at: d.at, thread: d.thread, body: text.trim(), url }]);
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
    // With the chat open, Files puts the sidebar back in its place.
    const show = chat || !(room ? side : over);
    if (chat) onCloseChat();
    if (!room) {
      setOver(show);
      return;
    }
    setSide(show);
    setStored(SIDE, show ? "open" : "folded");
  }

  function askAi() {
    if (!v || busy === "ai") return;
    if (v.generating) {
      flash("The AI review is already being written");
      return;
    }
    setBusy("ai");
    const ref = shortRef(v.card);
    void runUi(
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
    else onApprove(v.card, read);
  }

  function run(k: string) {
    // With your comment unsent, what acts on the PR goes back to it first.
    if (comment.trim() && "admb.".includes(k)) {
      document.querySelector<HTMLTextAreaElement>(".rv-comment textarea")?.focus();
      flash("Your comment isn't sent: Comment sends it, or empty the box");
      return;
    }
    if (k === "o" && v) window.open(v.card.url, "_blank", "noopener,noreferrer");
    else if (k === "a" && acted) flash(`${acted.what}: ${v ? shortRef(v.card) : ""} is off your desk`);
    else if (k === "a" && readying && v) onReady(v.card, picked);
    else if (k === "a" && asking && v) {
      if (picked.length) onAskReviewers(v.card, picked);
      else document.querySelector<HTMLInputElement>(".rv-reviewers-input")?.focus();
    } else if (k === "a") approve();
    else if ((k === "d" || k === "m" || k === "b") && v) onCard(v.card, k);
    else if (k === "." && v) setMore(true);
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

  if (view === null) return <Shell card={known} me={me} now={now} row={row} side={showSide} />;
  if (typeof view === "string")
    return (
      <div className="review">
        <p className="t-bad">{view}</p>
      </div>
    );

  const { card, item, files } = view;
  const isMine = !!me && card.author.toLowerCase() === me.toLowerCase();
  const mine = item.state === "open" && isMine;
  const approvers = item.reviews.filter((r) => r.state === "approved").map((r) => r.author);
  const approvals = approvers.length;
  // Problems are coloured words, as in the queue, and greyed by the same rules once the PR is sorted away.
  const facts: Fact[] = [
    { text: `CI ${CI[item.ci]}`, tone: item.ci === "red" ? "t-bad" : "" },
    {
      text:
        item.review_decision === "approved" && approvals
          ? `approved by ${approvers.join(", ")}`
          : `${REVIEW[item.review_decision]}${approvals ? `, ${approvals} ${approvals === 1 ? "approval" : "approvals"}` : ""}`,
      tone: item.review_decision === "changes_requested" ? "t-warn" : "",
    },
    // Merged or closed, a conflict no longer matters.
    ...(item.state === "open" && item.mergeable === "conflict" ? [{ text: "merge conflict", tone: "t-warn" }] : []),
    ...(item.draft ? [{ text: "draft", tone: "" }] : []),
    ...depFacts(card),
    { text: `+${item.additions} −${item.deletions} in ${item.changed_files} ${item.changed_files === 1 ? "file" : "files"}`, tone: "" },
  ];
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
  // Yours from here that the refreshed conversation doesn't have yet.
  const pending = sent.filter(
    (s) =>
      !view.conversation.some((c) =>
        c.comments.some((k) => (s.url && k.url === s.url) || (k.author.toLowerCase() === me.toLowerCase() && k.body.trim() === s.body)),
      ),
  );
  const section = (x: Section, i: number) => (
    <SectionView
      key={x.key}
      section={x}
      index={i}
      file={files[x.file]!}
      notes={view.ai?.notes ?? []}
      order={notes}
      now={now}
      shut={shut.has(x.path)}
      onFold={() => {
        toggleFold(x.path, i);
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
  // One way to ask for an AI review in each state: the AI section's own line when it offers one, else More.
  const aiInline = !!view.ai_error || (!view.ai && open && aiShown);
  const aiLink = !view.generating && busy !== "ai" && !flying && !aiInline;

  return (
    <div className={cls("review", showSide && "side-open")}>
      <div className="rv-main">
        {!showSide && (
          <button type="button" className="act rv-side-toggle rv-side-show" title="Show the sidebar" onClick={toggleSide}>
            {view.stack ? "Stack and files" : "Files"}
          </button>
        )}
        <div className="rv-top">
          <Head card={card} me={me} now={now} facts={facts} owed={mine} resolved={resolved?.line ?? null} row={row} />
          {/* Yours gets no AI summary unless asked for, so its description's first paragraph says what it's about. */}
          {isMine && !view.ai && item.body && <p className="rv-summary rv-desc">{item.body.split("\n")[0]}</p>}
          {/* Your own PR gets no AI review unless one was asked for; More still asks. */}
          {aiShown && (
            <AiSection
              ai={view.ai}
              stale={view.ai_stale}
              busy={view.generating || busy === "ai"}
              error={view.ai_error}
              open={open}
              notes={notes.length}
              onAsk={
                flying
                  ? undefined
                  : () => {
                      askAi();
                    }
              }
            />
          )}
          <Conversation view={view} now={now} flash={flash} agent={agent} onSpot={onSpot} onAsk={onAsk} />
          {((open && !acted) || !!comment.trim()) && (
            <CommentBox card={card} body={comment} setBody={setComment} sending={!!acted?.sending} onComment={onComment} />
          )}
        </div>

        {picking && !acted && (
          <Reviewers id={card.id} asked={item.review_requests.map((r) => r.reviewer)} picked={picked} setPicked={setPicked} />
        )}
        {/* Done from here: what you did and where it went, above what's left to do. */}
        {acted && (
          <p className="rv-acted">
            <span className="rv-acted-what">✓ {acted.what}</span>
            {acted.sending && <span className="busy" aria-label="sending" />}
            <a href={acted.where === "inflight" ? "#/inflight" : "#/archive"}>{acted.where === "inflight" ? "in Merging" : "in Archive"}</a>
          </p>
        )}
        {/* What finishes it first (its call to action, or Hand off or Back to desk on yours), then the rest. */}
        <div className="actions rv-actions">
          {readying && !acted && (
            <ActButton
              k="a"
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
              k="a"
              label="Ask reviewers"
              run={run}
              title={
                picked.length
                  ? `Ask ${picked.map((p) => p.login).join(", ")} to review it, on GitHub`
                  : "Nobody's asked to review it: pick reviewers above, then ask them"
              }
              className="primary"
            />
          )}
          {/* Only someone else's open PR is yours to approve. */}
          {open && !isMine && !acted && (
            <ActButton
              k="a"
              label="Approve"
              run={run}
              disabled={!canApprove}
              title={view.approve.reason ?? "Approve on GitHub"}
              className={cls("go", !writing && "primary")}
            />
          )}
          {/* While you owe replies, Reply is the one filled button. */}
          {mine && !(acted?.where === "inflight" && !card.inflight) && (
            <HandButton card={card} run={run} primary={card.cta !== "reply" && !asking && !acted} />
          )}
          <span className="more-wrap">
            <MoreButton
              open={more}
              onClick={() => {
                run(".");
              }}
            />
            {more && (
              <MoreMenu
                card={card}
                actions={card.actions ?? []}
                links={[
                  // As the row's menu says it: Done, or Back on the desk once it's done, snoozed or muted.
                  ...(!card.inflight && !acted
                    ? [
                        {
                          label: card.status === "active" ? "Done" : "Back on the desk",
                          run: () => {
                            run("d");
                          },
                        },
                      ]
                    : []),
                  ...(aiLink
                    ? [
                        {
                          label: view.ai ? "Ask Claude to review it again" : "Ask Claude to review it",
                          run: () => {
                            askAi();
                          },
                        },
                      ]
                    : []),
                  {
                    label: "Open on GitHub",
                    run: () => {
                      run("o");
                    },
                  },
                ]}
                pick={(a) => {
                  if (a === "request_changes") setWriting(true);
                  else void runUi(onGithub(card, a, read));
                }}
                onClose={() => {
                  setMore(false);
                }}
              />
            )}
          </span>
        </div>
        {writing && (
          <WriteBox
            label="Request changes"
            placeholder="What needs to change"
            onSend={(body) => {
              void runUi(
                onGithub(card, "request_changes", read, body).pipe(
                  Effect.tap((done) =>
                    Effect.sync(() => {
                      if (done) setWriting(false);
                    }),
                  ),
                ),
              );
            }}
            onClose={() => {
              setWriting(false);
            }}
          />
        )}

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
            {visible.slice(0, Math.min(rest, upTo)).map(section)}
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
      </div>
      {showSide && (
        <aside className="rv-side" aria-label="Stack, files and recent activity">
          <button type="button" className="act rv-side-toggle" title="Hide the sidebar" onClick={toggleSide}>
            Hide
          </button>
          {view.stack && <StackList stack={view.stack} />}
          {list.length > 0 && (
            <nav className="rv-files" aria-label="Files in reading order">
              <h2 className="rv-side-head">
                <span>
                  {files.length} {files.length === 1 ? "file" : "files"}
                </span>
              </h2>
              <ol>
                {list.map((x, i) => {
                  if (list.findIndex((y) => y.path === x.path) !== i) return null; // each file once, where reading reaches it
                  const [dir, name] = splitPath(x.path);
                  const on = list[secIdx]?.path === x.path && !(folded && secIdx >= rest);
                  return (
                    <li key={x.path}>
                      <button
                        type="button"
                        className={cls("rv-file", on && "on")}
                        title={x.path}
                        onClick={() => {
                          goTo(i);
                        }}
                      >
                        <span className="rv-fname">
                          {dir && <Dir path={dir} />}
                          <span className="rv-base">{breakable(name)}</span>
                        </span>
                        {list.some((y) => y.path === x.path && y.notes.length > 0) && <span className="rv-nn" title="AI notes" />}
                        {x.level && <span className="rv-lvl">{LEVEL[x.level]}</span>}
                      </button>
                    </li>
                  );
                })}
              </ol>
            </nav>
          )}
          {/* "First seen" is the desk's own bookkeeping, not something that happened. */}
          <Activity events={(resolved?.events ?? view.activity).filter((e) => e.kind !== "new")} me={me} now={now} />
        </aside>
      )}
    </div>
  );
}

// The header: the ref, the title, and one line of why and facts; a resolved PR's line, and Merging's for your PR there.
function Head({
  card,
  me,
  now,
  facts,
  owed,
  resolved,
  row,
}: {
  card: Card;
  me: string;
  now: number;
  facts: Fact[];
  owed: boolean; // your open PR: its why is what you owe
  resolved: string | null;
  row: InflightRow | null;
}) {
  const isMine = !!me && card.author.toLowerCase() === me.toLowerCase();
  // The why leaves out a fact it already says, as on the card ("conflicts with main" says "merge conflict").
  const why = card.why && !card.resolved && !facts.some((f) => f.text.toLowerCase() === card.why.toLowerCase()) ? card.why : "";
  const shownFacts = why ? facts.filter((f) => !says(why, f.text)) : facts;
  // What it waits on and the coordinator's latest note, as Merging says it.
  const lane = row?.state === "open" && (row.waits_on || row.note) ? row : null;
  return (
    // Sorted away, resolved or calm in Merging, its problems go grey; waiting on you in Merging, they keep their colour.
    <header
      className={cls(
        "rv-head",
        `b-${card.bucket}`,
        (card.status !== "active" || card.resolved !== null || card.bucket === "hide") && "dim",
      )}
    >
      <p className="rv-ref">
        <a className="ref" href={card.url} target="_blank" rel="noreferrer" title={`${card.repo}#${card.number} on GitHub`}>
          <span className="ref-ink">
            <span className="ref-repo">{card.repo.split("/")[1]}</span>#{card.number}
          </span>
        </a>
        {card.stack && (
          <span className="rv-by" title={`${card.stack.pos} of ${card.stack.size} open PRs in its stack`}>
            {card.stack.pos}/{card.stack.size}
          </span>
        )}
        <span className="rv-by">
          by {isMine ? "you" : card.author}
          {card.author_bot ? " (bot)" : ""}
        </span>
      </p>
      <h1 className="rv-title">{card.title}</h1>
      <p className="rv-meta">
        {why && (owed ? <Owed why={why} /> : <span className="why">{why}</span>)}
        {shownFacts.map((f) => (
          <span key={f.text} className={cls("fact-word", f.tone)}>
            {f.text}
          </span>
        ))}
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

// The header's facts as its row has them, until the review brings who approved and how many files.
function rowFacts(c: Card): Fact[] {
  const size = c.chips.find((x) => x.startsWith("+"));
  return [
    { text: `CI ${CI[c.ci]}`, tone: c.ci === "red" ? "t-bad" : "" },
    { text: REVIEW[c.review], tone: c.review === "changes_requested" ? "t-warn" : "" },
    ...(!c.resolved && c.chips.includes("conflict") ? [{ text: "merge conflict", tone: "t-warn" }] : []),
    ...(c.draft ? [{ text: "draft", tone: "" }] : []),
    ...depFacts(c),
    ...(size ? [{ text: size, tone: "" }] : []),
  ];
}

// The review before it lands: what its row knows, and quiet placeholders where the rest will be, so nothing moves.
function Shell({ card, me, now, row, side }: { card: Card | null; me: string; now: number; row: InflightRow | null; side: boolean }) {
  const isMine = !!card && !!me && card.author.toLowerCase() === me.toLowerCase();
  const pf = card?.preflight;
  const ai =
    pf?.verdict && pf.risk && pf.summary
      ? { verdict: pf.verdict, risk: pf.risk, summary: pf.summary, since: pf.since, concerns: pf.concerns ?? [] }
      : null;
  // Opening it starts the review unless AI reviews are off or paused.
  const writing = pf?.state === "running" || pf?.state === "queued" || pf?.state === "stale";
  const none = !ai && (pf?.state === "off" || pf?.state === "paused");
  return (
    <div className={cls("review", side && "side-open")} aria-busy="true">
      <div className="rv-main">
        <div className="rv-top">
          {card ? (
            <Head
              card={card}
              me={me}
              now={now}
              facts={rowFacts(card)}
              owed={isMine && !card.resolved}
              resolved={card.resolved ? resolvedHead([], card.resolved, me).line : null}
              row={row}
            />
          ) : (
            <header className="rv-head" aria-hidden="true">
              <p className="rv-ref">
                <span className="sk sk-ref" />
              </p>
              <h1 className="rv-title">
                <span className="sk sk-title" />
              </h1>
              <p className="rv-meta">
                <span className="sk sk-meta" />
              </p>
            </header>
          )}
          {ai || writing || none ? (
            <AiSection ai={ai} stale={pf?.state !== "ready"} busy={writing} error={null} open notes={pf?.notes ?? 0} onAsk={undefined} />
          ) : (
            (!isMine || !!card?.verdict) && (
              <section className="rv-ai" aria-label="AI review">
                <SkLines count={1} className="sk-verdict" />
                <SkLines count={1} className="rv-gist" />
              </section>
            )
          )}
          {(card?.cta === "reply" || card?.chips.some((c) => c.endsWith("unresolved"))) && (
            <SkLines count={1} className="rv-convo sk-short" />
          )}
        </div>
        <div className="actions rv-actions" aria-hidden="true">
          <span className="sk sk-key" />
          <span className="sk sk-key" />
          <span className="sk sk-key" />
        </div>
        <div className="rv-diffs" aria-hidden="true">
          {[0, 1].map((i) => (
            <section key={i} className="rv-file-sec">
              <h3 className="rv-fhead">
                <span className="sk sk-file" />
              </h3>
              <SkLines count={9} className="sk-code" />
            </section>
          ))}
        </div>
      </div>
      {side && (
        <aside className="rv-side" aria-hidden="true">
          <nav className="rv-files">
            <h2 className="rv-side-head">Files</h2>
            <SkLines count={5} className="sk-files" />
          </nav>
        </aside>
      )}
    </div>
  );
}

const NODE: Record<StackMember["state"], string> = { open: "○", merged: "●", closed: "×" };

// The stack's open PRs bottom first, the PR on screen marked; each member's state as calm glyphs, words in its tooltip. A
// long one shows the PRs around this one, and the rest behind one line.
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
          <span className="rv-node" aria-hidden="true">
            {NODE[m.state]}
          </span>
          <span className="rv-mnum">#{m.number}</span>
          <span className="rv-mtitle">{m.title}</span>
          {/* Passing, running and waiting on a review are no news; what's wrong or approved is. */}
          {m.state === "open" && (
            <span className="rv-marks" aria-label={words}>
              {m.ci === "red" && <span className="t-bad">✗</span>}
              {m.review === "changes_requested" && <span className="t-warn">±</span>}
              {m.review === "approved" && <span>✓</span>}
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

// The AI review's read, from the review or, until it lands, from its row's preflight (no model or time yet).
type AiShown = Pick<AiReview, "verdict" | "risk" | "summary" | "since" | "concerns"> & Partial<Pick<AiReview, "model" | "at">>;

function AiSection({
  ai,
  stale,
  busy,
  error,
  open,
  notes,
  onAsk,
}: {
  ai: AiShown | null;
  stale: boolean;
  busy: boolean; // being written
  error: string | null;
  open: boolean;
  notes: number;
  onAsk: (() => void) | undefined; // none for a PR in Merging: it's your agent's
}) {
  const [more, setMore] = useState(false); // the rest of the summary, on this PR only: every PR opens folded
  const summary = ai?.summary ?? "";
  const { first, rest } = useMemo(() => lead(blocks(summary)), [summary]);
  const folds = first.length > 0 && rest.length > 0;
  const verdict = ai && (
    <>
      <span className={`verdict v-${ai.verdict}`}>{VERDICT[ai.verdict]}</span>
      <span className={`risk r-${ai.risk}`}>
        <span className="meter" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        {ai.risk} risk
      </span>
      {stale && <span className="quiet">on an earlier commit</span>}
    </>
  );
  return (
    <section className="rv-ai" aria-label="AI review">
      {busy && <p className="quiet">Claude is reviewing it. The notes land in the code below in a minute or two.</p>}
      {!busy && error && (
        <p>
          {withCode(error)}{" "}
          <button type="button" className="link-btn" disabled={!onAsk} onClick={onAsk}>
            Try again
          </button>
        </p>
      )}
      {!busy && !ai && !error && !open && <p className="quiet">No AI review.</p>}
      {!busy && !ai && !error && open && (
        <p className="quiet">
          No AI review yet.{" "}
          <button type="button" className="link-btn" disabled={!onAsk} onClick={onAsk}>
            Ask Claude for one
          </button>
        </p>
      )}
      {ai && (
        <>
          <p className="rv-verdict" title={ai.model && ai.at ? `AI review by ${modelName(ai.model)}, ${when(ai.at)}` : undefined}>
            {folds ? (
              <button
                type="button"
                className={cls("rv-ai-lead", !more && "shut")}
                aria-expanded={more}
                onClick={() => {
                  setMore(!more);
                }}
              >
                <span className="rv-chev" aria-hidden="true">
                  {"\u203a"}
                </span>
                {verdict}
              </button>
            ) : (
              verdict
            )}
          </p>
          {first.length > 0 && <p className="rv-gist">{spans(unlinked(first))}</p>}
          {rest.length > 0 && (more || !folds) && <ProseBlocks bs={rest} links={false} />}
          {ai.since && (
            <p className="rv-since">
              <b>Since your review:</b> {spans(unlinked(inline(ai.since)))}
            </p>
          )}
          {/* Each concern is also a note in the code; listed here only when the notes can't sit there. */}
          {(stale || notes === 0) &&
            (ai.concerns.length > 0 ? (
              <ul className="rv-concerns" aria-label="Concerns">
                {ai.concerns.map((c) => (
                  <li key={c}>{spans(unlinked(inline(c)))}</li>
                ))}
              </ul>
            ) : (
              <p className="quiet">No concerns.</p>
            ))}
        </>
      )}
    </section>
  );
}

// A command in an agent's message (`claude auth login`) reads as code.
export function withCode(text: string) {
  // oxlint-disable-next-line react/no-array-index-key -- a fixed split never reorders, and the same command can appear twice
  return text.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
}

function Activity({ events, me, now }: { events: ActivityEvent[]; me: string; now: number }) {
  const [all, setAll] = useState(false);
  if (!events.length) return null;
  const more = events.length - EVENTS_SHOWN;
  return (
    <section className="rv-activity" aria-label="Recent activity">
      <h2 className="d-head">Recent activity</h2>
      <ul className="events">
        {(all ? events : events.slice(0, EVENTS_SHOWN)).map((e) => (
          <li key={e.seq}>
            {eventText(e, me)}
            <span className="rv-age">{age(e.at, now)}</span>
          </li>
        ))}
        {more > 0 && (
          <li>
            <button
              type="button"
              className="rv-more"
              aria-expanded={all}
              onClick={() => {
                setAll((a) => !a);
              }}
            >
              {all ? "Fewer" : `${more} more`}
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}

// A long file name wraps after a "_", "-" or ".", never mid-word.
const breakable = (name: string) =>
  name.split(/(?<=[_.-])/).map((part, i) => (
    // oxlint-disable-next-line react/no-array-index-key -- parts are positional and never reorder
    <span key={i}>
      {i > 0 && <wbr />}
      {part}
    </span>
  ));

// A long directory gives way from its start, so the file's own name stays whole and every name sits right after its folder.
function Dir({ path }: { path: string }) {
  return (
    <span className="rv-dir">
      <bdi>{path}</bdi>
    </span>
  );
}

// Your comment on the PR, under what reviewers said, while it's open (or while it has words): Comment (or Cmd+Enter) sends
// it, Esc leaves it. The words are the review's, so GitHub refusing them leaves them here.
function CommentBox({
  card,
  body,
  setBody,
  sending,
  onComment,
}: {
  card: Card;
  body: string;
  setBody: (t: string) => void;
  sending: boolean;
  onComment: (c: Card, body: string) => Effect.Effect<boolean>;
}) {
  function send() {
    if (!body.trim() || sending) return;
    void runUi(
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
      <textarea
        className="rv-comment-input"
        aria-label={`Your comment on ${shortRef(card)}`}
        placeholder={`Comment on ${shortRef(card)}\u2026`}
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.repeat) return;
          if (e.key === "Escape") e.currentTarget.blur();
          else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
      />
      {body.trim() && (
        <div className="actions">
          <button
            type="button"
            className="act primary"
            title={`Comment on GitHub, as you (${MOD}\u21b5)`}
            disabled={sending}
            onClick={() => {
              send();
            }}
          >
            {sending ? "Commenting\u2026" : "Comment"}
          </button>
        </div>
      )}
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

function SectionView({
  section: x,
  index,
  file,
  notes,
  order,
  now,
  shut,
  onFold,
  conversation,
  canComment,
  draft,
  composer,
  head,
  opened,
  onOpen,
  sent,
  onDraft,
}: {
  section: Section;
  index: number;
  file: ReviewFile;
  notes: ReviewNote[]; // the AI review's
  order: number[]; // ReviewView.order.notes: a note's place in it is its place in reading order
  now: number;
  shut: boolean; // you folded this file
  onFold: () => void;
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
  const fileDiff = useMemo(
    () =>
      x.hunks.length
        ? (parsePatchFiles(filePatch({ ...file, patch: x.hunks.map((h) => h.patch).join("\n") }), cacheKey)[0]?.files[0] ?? null)
        : null,
    [x, file, cacheKey],
  );
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
      ...mine
        .filter((n) => n.inline)
        .map((n): DiffLineAnnotation<Meta> => ({
          side: sideOf(n.note.side),
          lineNumber: n.note.line,
          metadata: { kind: "note", index: n.index, body: n.note.body },
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
    [mine, threads, writing, boxLine, boxSide, sent, x],
  );
  // The lines marked only while you drag down the gutter: Pierre's own selection would outlive the box, and pin the + to it.
  const [dragging, setDragging] = useState<SelectedLineRange | null>(null);
  const gutter = useRef<(r: SelectedLineRange) => void>(() => {});
  gutter.current = (r) => {
    setDragging(null);
    const at = inlineAt(x.path, x.hunks, r);
    if (at) onDraft(at, null);
  };
  const base = diffOptions();
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
    <section className={cls("rv-file-sec", shut && "shut")} id={`rv-s-${index}`} aria-label={x.path}>
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
      </h3>
      {!shut && mine.filter((n) => !n.inline).map((n) => <Note key={n.index} index={n.index} body={n.note.body} />)}
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
            if (m.kind === "note") return <Note key={`n${m.index}`} index={m.index} body={m.body} />;
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
      el.scrollIntoView({ block: "nearest" });
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
          <span className="rv-tc-who">{c.author}</span>
          <span className="rv-tc-at">{age(c.at, now)}</span>
          <div className="rv-tc-body">
            <Words text={c.body} />
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

// Claude's words on the PR's code, drawn as the AI review's are: code as code, a URL as text.
function Note({ index, body }: { index: number; body: string }) {
  return (
    <div className="rv-note" data-note={index}>
      {spans(unlinked(inline(body)))}
    </div>
  );
}
