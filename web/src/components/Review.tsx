import { useEffect, useMemo, useRef, useState } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type DiffLineAnnotation, type FileDiffOptions } from "@pierre/diffs/react";
import type {
  ActivityEvent,
  AiReview,
  Card,
  GitHubAction,
  InflightRow,
  ReviewFile,
  ReviewNote,
  Reviewer,
  ReviewView,
  Stack,
  StackMember,
} from "../../../src/types.ts";
import { api, message } from "../api.ts";
import { age, cls, copyText, eventText, modelName, sinceText, shortRef, when } from "../format.ts";
import { reviewOf } from "../reviews.ts";
import {
  currentFile,
  diffRows,
  drawUpTo,
  filePatch,
  onLines,
  resolvedHead,
  routeHash,
  says,
  sections,
  splitPath,
  type Section,
} from "../view.ts";
import { diffTheme } from "../theme.ts";
import { Owed } from "./CardRow.tsx";
import { CI, HandKey, KeyButton, REVIEW } from "./Detail.tsx";
import { Asks, type Thread } from "./Composer.tsx";
import { Conversation } from "./Conversation.tsx";
import { MoreButton, MoreMenu, RequestChanges } from "./More.tsx";
import { Reviewers } from "./Reviewers.tsx";
import { SkLines } from "./Skeleton.tsx";

interface NoteMeta {
  index: number; // in reading order, what ] and [ step through
  body: string;
}

interface Fact {
  text: string;
  tone: string; // t-bad, t-warn, or "" for pencil
}

const ARM_MS = 3000;
const EVENTS_SHOWN = 3; // the rest of the recent activity is a click away, so the diff stays near the top
const LINE = 96; // px below the window's top where "the section you're in" is read off
const VERDICT = { look: "Look closely", skim: "Skim it", skip: "Skip it" };
const LEVEL: Record<NonNullable<Section["level"]>, string> = { look: "Look", skim: "Skim", unread: "Not read", skip: "Skip" };
const STATUS: Partial<Record<ReviewFile["status"], string>> = { added: "new", removed: "deleted", renamed: "renamed", copied: "copied" };
const REST = "Not worth reviewing"; // the fold's line
const STACK_SHOWN = 4; // the PR below this one, this one and two above; the rest of a long stack is a click away
const NARROW = 1100; // px: below it the sidebar opens over the diff, so it starts folded
const ROW = 19; // px: .rv-diff's --diffs-line-height
const SIDE = "desk.review.side"; // this device's choice: the review's sidebar open or folded

function sideSaved(): boolean {
  try {
    const v = localStorage.getItem(SIDE);
    if (v) return v === "open";
  } catch {
    // storage off: the window's width decides
  }
  return innerWidth > NARROW;
}

// Pierre draws the diff in a shadow root; its light or dark follows the app's theme (diffTheme).
const DIFF: FileDiffOptions<NoteMeta, undefined> = {
  theme: { light: "pierre-light", dark: "pierre-dark" },
  diffStyle: "unified",
  diffIndicators: "bars",
  lineDiffType: "word-alt",
  hunkSeparators: "line-info-basic",
  overflow: "wrap",
  disableFileHeader: true,
  lineHoverHighlight: "disabled",
  // A band that starts or ends the file sits on the frame's edge; its words start where the line numbers do (2ch of the code).
  unsafeCSS: `[data-separator-first] { margin-top: calc(-1 * var(--diffs-gap-block, var(--diffs-gap-fallback))); }
[data-separator-last] { margin-bottom: calc(-1 * max(0px, var(--diffs-gap-block, var(--diffs-gap-fallback)) - var(--diffs-scrollbar-gutter))); }
[data-separator=line-info-basic] [data-separator-content] { padding-inline: calc(1.2 * var(--diffs-font-size)); }`,
};

// One object per theme, so a re-render doesn't hand Pierre new options (and a fresh highlight) each time.
const OPTIONS = new Map<string, FileDiffOptions<NoteMeta, undefined>>();
function diffOptions(): FileDiffOptions<NoteMeta, undefined> {
  const t = diffTheme();
  const o = OPTIONS.get(t) ?? { ...DIFF, themeType: t };
  OPTIONS.set(t, o);
  return o;
}

export function Review({
  id,
  known,
  loads,
  me,
  now,
  inert,
  flash,
  onCard,
  onGithub,
  row,
  armed: armedKey,
  readied,
  onReady,
  onBack,
  onAsk,
  onThread,
}: {
  id: string;
  known: Card | null; // its row's card, drawn at once while the review is on its way
  loads: number; // bumped on every refresh, so the review follows the server's updates
  me: string; // your login: m and b are for your own PRs
  now: number;
  inert: boolean;
  flash: (text: string, error?: boolean, ms?: number) => void;
  onCard: (c: Card, key: string) => void; // d done, m hand off for merge, b back to desk: as on its card
  onGithub: (c: Card, action: GitHubAction, head: string) => void; // the More menu's writes but request changes, which is here
  row: InflightRow | null; // your PR in Merging: what it waits on and the coordinator's note go under the facts, as in Merging
  armed: string | null; // armOf("m", id) after a first m
  readied: "sending" | "sent" | undefined; // Ready for review sent for it, from here or its row
  onReady: (c: Card, picked: Reviewer[]) => void; // a on your own draft: App sends it, as from its row
  onBack: () => void;
  onAsk: (t: Thread) => void; // a conversation's Ask coordinator: the composer, about it
  onThread: (t: Thread) => void; // the conversation you're on, for what t asks about
}) {
  const [view, setView] = useState<ReviewView | string | null>(null); // string: why it failed
  const [secIdx, setSecIdx] = useState(0); // the section you're in; with the rest folded, its line is one past the last shown
  const [noteIdx, setNoteIdx] = useState<number | null>(null); // a place in order.notes
  const [restOpen, setRestOpen] = useState(false);
  const [side, setSide] = useState(sideSaved);
  const [busy, setBusy] = useState<"approve" | "ai" | null>(null);
  const [drawn, setDrawn] = useState(0); // sections drawn past the first screenful
  // The PR your approval went out for: shown done at once, and until the sync shows it, so a second a doesn't send it twice.
  const [approved, setApproved] = useState<string | null>(null);
  const [picked, setPicked] = useState<Reviewer[]>([]); // who Ready for review asks
  const [more, setMore] = useState(false); // the More menu (.)
  const [changes, setChanges] = useState(false); // Request changes, being written
  // The commit this review opened at: approve, merge and request changes stay pinned to it, so a push you haven't reopened for is refused.
  const [read, setRead] = useState("");
  const seq = useRef(0);
  const shown = useRef(""); // the PR on screen
  const jumped = useRef(0); // when n, p, ] or [ last scrolled the page
  const v = typeof view === "object" ? view : null;
  const canApprove = !!v?.approve.ok && approved !== v.card.id;
  // Your own open draft: a marks it ready for review instead of approving.
  const readying = v?.card.cta === "ready";
  // A PR in Merging is the coordinator's: no prompt to copy or AI review to ask for.
  const flying = !!row && row.state === "open";

  useEffect(() => {
    if (shown.current !== id) window.scrollTo(0, 0); // a different PR starts at the top; a refresh stays put
    shown.current = id;
    const n = ++seq.current;
    void (async () => {
      try {
        const r = await reviewOf(id);
        if (n === seq.current) {
          setView(r);
          setRead((h) => h || r.item.head_oid);
        }
      } catch (e) {
        // Keep what's on screen if a refresh fails.
        if (n === seq.current) setView((cur) => (cur && typeof cur === "object" ? cur : message(e)));
      }
    })();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- loads changes on every server update; that's when to refetch
  }, [id, loads]);

  // The desk's reading order; its notes are only those written for this commit, in the order ] and [ step through.
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

  // The section you're reading follows the scroll, except right after a key moved you: then it's the one the key picked.
  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const tops = [...document.querySelectorAll(".rv-file-sec[id]")].map((el) => el.getBoundingClientRect().top); // not the placeholders
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

  // n and p stop on the folded rest's line too, as j and k do on the queue's "n more"; Enter there opens it.
  function goSec(i: number) {
    const n = Math.max(0, Math.min(visible.length - (folded ? 0 : 1), i));
    if (!folded || n < rest) goTo(n);
    else {
      jumped.current = Date.now();
      setDrawn((d) => Math.max(d, rest)); // the fold shows once what's above it is drawn
      setSecIdx(n);
      requestAnimationFrame(() => {
        document.querySelector(".rv-fold")?.scrollIntoView({ block: "center" });
      });
    }
  }

  function goNote(d: number) {
    if (!v || !notes.length) {
      flash(v?.generating ? "The AI review is still being written" : "No notes on this PR");
      return;
    }
    const n = noteIdx === null ? (d > 0 ? 0 : notes.length - 1) : (noteIdx + d + notes.length) % notes.length;
    setNoteIdx(n);
    goTo(
      Math.max(
        0,
        list.findIndex((x) => x.notes.includes(notes[n]!)),
      ),
      `[data-note="${n}"]`,
      "center",
    );
  }

  function toggleSide() {
    setSide(!side);
    try {
      localStorage.setItem(SIDE, side ? "folded" : "open");
    } catch {
      // storage off: it holds until the window closes
    }
  }

  async function askAi() {
    if (!v || busy === "ai") return;
    if (v.generating) {
      flash("The AI review is already being written");
      return;
    }
    setBusy("ai");
    try {
      const r = await api.aiReview(v.card.id, !!v.ai && !v.ai_stale);
      flash(`AI review of ${shortRef(v.card)}: ${r.ai.verdict}`);
    } catch (e) {
      flash(message(e), true);
    } finally {
      setBusy(null);
    }
  }

  // a: approved on GitHub. Shown done at once; a refusal undoes that.
  async function approve() {
    if (!v || busy === "approve") return;
    if (!canApprove) {
      flash(`Can't approve: ${approved === v.card.id ? "you just did" : (v.approve.reason ?? "not allowed")}`, true);
      return;
    }
    setApproved(v.card.id);
    setBusy("approve");
    try {
      await api.approve(v.card.id, read);
      flash(`Approved ${shortRef(v.card)} on GitHub`);
    } catch (e) {
      setApproved(null);
      flash(message(e), true);
    } finally {
      setBusy(null);
    }
  }

  async function copyPrompt() {
    if (!v) return;
    try {
      await copyText(v.handoff_prompt);
      flash("Prompt copied. Paste it into a Claude session.");
    } catch (e) {
      flash(`Couldn't copy: ${message(e)}`, true);
    }
  }

  function run(k: string) {
    if (k === "n") goSec(secIdx + 1);
    else if (k === "p") goSec(secIdx - 1);
    else if (k === "N" && v?.stack?.up) location.hash = routeHash({ name: "review", id: v.stack.up });
    else if (k === "P" && v?.stack?.down) location.hash = routeHash({ name: "review", id: v.stack.down });
    else if (k === "f") toggleSide();
    else if (k === "Enter" && folded && secIdx >= rest) goTo(rest);
    else if (k === "]") goNote(1);
    else if (k === "[") goNote(-1);
    else if (k === "o" && v) window.open(v.card.url, "_blank", "noopener,noreferrer");
    else if (k === "c" && !flying) void copyPrompt();
    else if (k === "i" && !flying) void askAi();
    else if (k === "a" && readying && v) onReady(v.card, picked);
    else if (k === "a") void approve();
    else if ((k === "d" || k === "m" || k === "b") && v) onCard(v.card, k);
    else if (k === "." && v) {
      if (v.card.actions?.length) setMore(true);
      else flash(`Nothing more to do on GitHub for ${shortRef(v.card)}`);
    } else if (k === "esc") onBack();
  }

  const onKey = (e: KeyboardEvent) => {
    // Option types @ on some layouts.
    if (inert || e.metaKey || e.ctrlKey || (e.altKey && e.key !== "@") || e.isComposing) return;
    if (e.repeat && !["n", "p", "]", "["].includes(e.key)) return;
    const t = e.target instanceof HTMLElement ? e.target : document.body;
    if (t.closest("input, textarea, select, [contenteditable='true']")) return;
    if (e.key === "Escape") {
      // Esc with a hand-off armed never reaches here: App lets it lapse first.
      onBack();
    } else if (e.key === "@" && readying && !readied) {
      e.preventDefault();
      document.querySelector<HTMLInputElement>(".rv-reviewers-input")?.focus();
    } else if (("npoci[]admbfNP.".includes(e.key) && e.key.length === 1) || (e.key === "Enter" && folded && secIdx >= rest)) {
      e.preventDefault();
      run(e.key);
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

  if (view === null) return <Shell card={known} me={me} now={now} row={row} side={side} />;
  if (typeof view === "string")
    return (
      <div className="review">
        <p className="t-bad">{view}</p>
        <p className="quiet">
          Press <kbd>esc</kbd> to go back to the queue.
        </p>
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
    { text: `+${item.additions} −${item.deletions} in ${item.changed_files} ${item.changed_files === 1 ? "file" : "files"}`, tone: "" },
  ];
  const resolved = card.resolved ? resolvedHead(view.activity, card.resolved, me) : null;
  const section = (x: Section, i: number) => (
    <SectionView key={x.key} section={x} index={i} file={files[x.file]!} notes={view.ai?.notes ?? []} order={notes} current={noteIdx} />
  );
  const open = item.state === "open";

  return (
    <div className={cls("review", side && "side-open")}>
      <div className="rv-main">
        <div className="rv-top">
          <Head card={card} me={me} now={now} facts={facts} owed={mine} resolved={resolved?.line ?? null} row={row} />
          <Conversation view={view} now={now} flash={flash} onThread={onThread} onAsk={onAsk} />
          <Asks asks={view.asks} now={now} />
          {/* Your own PR gets no AI review unless one was asked for; i still asks. */}
          {(!isMine || !!view.ai || view.generating || busy === "ai" || !!view.ai_error) && (
            <AiSection
              ai={view.ai}
              stale={view.ai_stale}
              busy={view.generating || busy === "ai"}
              error={view.ai_error}
              open={open}
              notes={notes.length}
            />
          )}
        </div>

        {readying && (
          <Reviewers
            id={card.id}
            asked={item.review_requests.map((r) => r.reviewer)}
            picked={picked}
            setPicked={setPicked}
            disabled={!!readied}
          />
        )}
        {/* What finishes it first (a, or m or b on yours), then o and the rest. */}
        <div className="actions rv-actions">
          {readying && (
            <KeyButton
              k={readied ? "" : "a"}
              label={readied ? "✓ Ready for review" : "Ready for review"}
              run={run}
              disabled={!!readied}
              busy={readied === "sending"}
              title={
                picked.length
                  ? `Mark it ready for review on GitHub and ask ${picked.map((p) => p.login).join(", ")}`
                  : "Mark it ready for review on GitHub"
              }
              className={readied ? "done" : "primary"}
            />
          )}
          {/* Only someone else's open PR is yours to approve. */}
          {open && !isMine && (
            <KeyButton
              k={approved === card.id ? "" : "a"}
              label={approved === card.id ? "✓ Approved" : "Approve"}
              run={run}
              disabled={!canApprove}
              busy={busy === "approve"}
              title={approved === card.id ? "You approved it" : (view.approve.reason ?? "Approve on GitHub")}
              className={approved === card.id ? "done" : cls("go", !changes && "primary")}
            />
          )}
          {/* While you owe replies, Send is the one filled button. */}
          {mine && <HandKey card={card} run={run} armed={armedKey} primary={card.cta !== "reply"} />}
          {/* Shorter beside More, so the row stays one line at 900px with the sidebar folded. */}
          <KeyButton k="o" label={card.actions?.length ? "GitHub" : "Open on GitHub"} title="Open on GitHub" run={run} />
          {!flying && <KeyButton k="c" label="Copy prompt" run={run} />}
          {!flying && (open || view.ai) && (
            <KeyButton
              k="i"
              label={view.ai && !view.ai_stale ? "Redo AI review" : "AI review"}
              run={run}
              disabled={view.generating || busy === "ai"}
            />
          )}
          <KeyButton
            k="f"
            label={side ? "Hide sidebar" : view.stack ? "Stack" : "Files"}
            title="The sidebar: the stack, the files and recent activity"
            run={run}
          />
          {!!card.actions?.length && (
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
                  actions={card.actions}
                  pick={(a) => {
                    if (a === "request_changes") setChanges(true);
                    else onGithub(card, a, read);
                  }}
                  onClose={() => {
                    setMore(false);
                  }}
                  flash={(text) => {
                    flash(text, false, ARM_MS);
                  }}
                />
              )}
            </span>
          )}
        </div>
        {changes && (
          <RequestChanges
            card={card}
            head={read}
            flash={flash}
            onClose={() => {
              setChanges(false);
            }}
          />
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
                  else setRestOpen(false);
                }}
              >
                {REST} · {list.length - rest} {list.length - rest === 1 ? "file" : "files"}
              </button>
            )}
            {visible.slice(rest, upTo).map((x, i) => section(x, rest + i))}
          </div>
        )}
      </div>
      {side && (
        <aside className="rv-side" aria-label="Stack, files and recent activity">
          {view.stack && <StackList stack={view.stack} />}
          {list.length > 0 && (
            <nav className="rv-files" aria-label="Files in reading order">
              <h2 className="rv-side-head">
                <span>
                  {files.length} {files.length === 1 ? "file" : "files"}
                </span>
                <span className="rv-keys">
                  <kbd>n</kbd> <kbd>p</kbd>
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

// The header's facts as its row has them, until the review brings who approved and how many files.
function rowFacts(c: Card): Fact[] {
  const size = c.chips.find((x) => x.startsWith("+"));
  return [
    { text: `CI ${CI[c.ci]}`, tone: c.ci === "red" ? "t-bad" : "" },
    { text: REVIEW[c.review], tone: c.review === "changes_requested" ? "t-warn" : "" },
    ...(!c.resolved && c.chips.includes("conflict") ? [{ text: "merge conflict", tone: "t-warn" }] : []),
    ...(c.draft ? [{ text: "draft", tone: "" }] : []),
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
          {(card?.cta === "reply" || card?.chips.some((c) => c.endsWith("unresolved"))) && (
            <SkLines count={1} className="rv-convo sk-short" />
          )}
          {ai || writing || none ? (
            <AiSection ai={ai} stale={pf?.state !== "ready"} busy={writing} error={null} open notes={pf?.notes ?? 0} />
          ) : (
            (!isMine || !!card?.verdict) && (
              <section className="rv-ai" aria-label="AI review">
                <SkLines count={1} className="sk-verdict" />
                <SkLines count={3} className="rv-summary" />
              </section>
            )
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
        <span className="rv-keys" title="Next and previous PR in the stack">
          <kbd>N</kbd> <kbd>P</kbd>
        </span>
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
}: {
  ai: AiShown | null;
  stale: boolean;
  busy: boolean; // being written
  error: string | null;
  open: boolean;
  notes: number;
}) {
  return (
    <section className="rv-ai" aria-label="AI review">
      {busy && <p className="quiet">Claude is reviewing it. The notes land in the code below in a minute or two.</p>}
      {!busy && error && (
        <p>
          {withCode(error)}{" "}
          <span className="quiet">
            Press <kbd>i</kbd> to try the AI review again.
          </span>
        </p>
      )}
      {!busy && !ai && !error && !open && <p className="quiet">No AI review.</p>}
      {!busy && !ai && !error && open && (
        <p className="quiet">
          No AI review yet. Press <kbd>i</kbd> to ask Claude for one.
        </p>
      )}
      {ai && (
        <>
          <p className="rv-verdict" title={ai.model && ai.at ? `AI review by ${modelName(ai.model)}, ${when(ai.at)}` : undefined}>
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
          </p>
          <p className="rv-summary">{ai.summary}</p>
          {ai.since && (
            <p className="rv-summary">
              <b>Since your review:</b> {ai.since}
            </p>
          )}
          {/* Each concern is also a note in the code; listed here only when the notes can't sit there. */}
          {(stale || notes === 0) &&
            (ai.concerns.length > 0 ? (
              <ul className="rv-concerns" aria-label="Concerns">
                {ai.concerns.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            ) : (
              <p className="quiet">No concerns.</p>
            ))}
          {!stale && notes > 0 && (
            <p className="quiet">
              {notes} {notes === 1 ? "note" : "notes"} in the code below.
            </p>
          )}
        </>
      )}
    </section>
  );
}

// A command in an agent's message (`claude auth login`) reads as code.
export function withCode(text: string) {
  return text.split("`").map((part, i) => (i % 2 ? <code key={part}>{part}</code> : part));
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

function SectionView({
  section: x,
  index,
  file,
  notes,
  order,
  current,
}: {
  section: Section;
  index: number;
  file: ReviewFile;
  notes: ReviewNote[]; // the AI review's
  order: number[]; // ReviewView.order.notes: a note's place in it is what ] and [ land on
  current: number | null;
}) {
  const fileDiff = useMemo(
    () =>
      x.hunks.length
        ? (parsePatchFiles(filePatch({ ...file, patch: x.hunks.map((h) => h.patch).join("\n") }), x.key)[0]?.files[0] ?? null)
        : null,
    [x, file],
  );
  const mine = useMemo(
    () =>
      x.notes.flatMap((n) => {
        const note = notes[n];
        return note ? [{ note, index: order.indexOf(n), inline: onLines(x.hunks, note) }] : [];
      }),
    [x, notes, order],
  );
  const annotations = useMemo(
    () =>
      mine
        .filter((n) => n.inline)
        .map((n): DiffLineAnnotation<NoteMeta> => ({
          side: n.note.side === "old" ? "deletions" : "additions",
          lineNumber: n.note.line,
          metadata: { index: n.index, body: n.note.body },
        })),
    [mine],
  );
  const [dir, name] = splitPath(x.path);
  const status = STATUS[file.status];
  const level = x.level && LEVEL[x.level];
  const adds = x.hunks.reduce((n, h) => n + h.additions, 0);
  const dels = x.hunks.reduce((n, h) => n + h.deletions, 0);
  return (
    <section className="rv-file-sec" id={`rv-s-${index}`} aria-label={x.path}>
      <h3 className="rv-fhead">
        {level && <span className={`rv-level l-${x.level}`}>{level}</span>}
        <span className="rv-fname">
          {dir && <Dir path={dir} />}
          <span className="rv-base">{name}</span>
        </span>
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
      {mine
        .filter((n) => !n.inline)
        .map((n) => (
          <Note key={n.index} index={n.index} body={n.note.body} on={current === n.index} />
        ))}
      {fileDiff && (
        <FileDiff<NoteMeta>
          className="rv-diff"
          // Pierre draws a frame or more after the page; its height held meanwhile, nothing below it jumps.
          style={{ minHeight: diffRows(x.hunks) * ROW }}
          fileDiff={fileDiff}
          options={diffOptions()}
          lineAnnotations={annotations}
          renderAnnotation={(a) => <Note index={a.metadata.index} body={a.metadata.body} on={current === a.metadata.index} />}
        />
      )}
    </section>
  );
}

function Note({ index, body, on }: { index: number; body: string; on: boolean }) {
  return (
    <div className={cls("rv-note", on && "on")} data-note={index}>
      {body}
    </div>
  );
}
