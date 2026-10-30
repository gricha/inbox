import { useEffect, useMemo, useRef, useState } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type DiffLineAnnotation, type FileDiffOptions } from "@pierre/diffs/react";
import type { ActivityEvent, Card, Draft, InflightRow, ReviewFile, ReviewNote, ReviewView } from "../../../src/types.ts";
import { api, message } from "../api.ts";
import { age, cls, copyText, eventText, modelName, sinceText, shortRef, when } from "../format.ts";
import { currentFile, filePatch, orderNotes, resolvedHead, says, sitterParts, splitPath } from "../view.ts";
import { Owed } from "./CardRow.tsx";
import { CI, Dots, KeyButton, REVIEW } from "./Detail.tsx";

interface NoteMeta {
  index: number; // in reading order, what ] and [ step through
  body: string;
}

const ARM_MS = 3000;
const EVENTS_SHOWN = 3; // the rest of the recent activity is a click away, so the diff stays near the top
const LINE = 96; // px below the window's top where "the file you're in" is read off
export const VERDICT = { look: "Look closely", skim: "Skim it", skip: "Skip it" };
const STATUS: Partial<Record<ReviewFile["status"], string>> = { added: "new", removed: "deleted", renamed: "renamed", copied: "copied" };
const delta = (f: ReviewFile) => (f.patch === null && !f.additions && !f.deletions ? "binary" : `+${f.additions} −${f.deletions}`);

// Pierre draws the diff in a shadow root; the themes follow the system's light or dark, like the rest of the app.
const DIFF: FileDiffOptions<NoteMeta, undefined> = {
  theme: { light: "pierre-light", dark: "pierre-dark" },
  themeType: "system",
  diffStyle: "unified",
  diffIndicators: "bars",
  lineDiffType: "word-alt",
  hunkSeparators: "line-info",
  overflow: "wrap",
  disableFileHeader: true,
  lineHoverHighlight: "disabled",
};

export function Review({
  id,
  loads,
  me,
  now,
  inert,
  flash,
  onInflight,
  row,
  armed: armedDraft,
  onLane,
  onBack,
}: {
  id: string;
  loads: number; // bumped on every refresh, so the review follows the server's updates
  me: string; // your login: d is for your own PRs
  now: number;
  inert: boolean;
  flash: (text: string, error?: boolean, ms?: number) => void;
  onInflight: (c: Card) => void; // d: in flight, or take it back
  row: InflightRow | null; // your PR in flight: its lane line goes under the facts, as in the lane
  armed: string | null; // the draft a first y armed
  onLane: (row: InflightRow, key: string, draft?: Draft) => void; // y sends its reply, x discards it, as in the lane
  onBack: () => void;
}) {
  const [view, setView] = useState<ReviewView | string | null>(null); // string: why it failed
  const [fileIdx, setFileIdx] = useState(0);
  const [noteIdx, setNoteIdx] = useState<number | null>(null);
  const [armed, setArmed] = useState(0); // when `a` was pressed once
  const [busy, setBusy] = useState<"approve" | "ai" | null>(null);
  const [approved, setApproved] = useState<string | null>(null); // until the sync shows it, so a second a a doesn't approve twice
  const seq = useRef(0);
  const shown = useRef(""); // the PR on screen
  const jumped = useRef(0); // when n, p, ] or [ last scrolled the page
  const listRef = useRef<HTMLElement>(null);
  const v = typeof view === "object" ? view : null;
  const canApprove = !!v?.approve.ok && approved !== v.card.id;
  // Your PR in flight with a reply waiting: it's shown under the header, and y sends it from here too.
  const draft = row?.state === "open" ? row.drafts[0] : undefined;

  useEffect(() => {
    if (shown.current !== id) window.scrollTo(0, 0); // a different PR starts at the top; a refresh stays put
    shown.current = id;
    const n = ++seq.current;
    void (async () => {
      try {
        const r = await api.review(id);
        if (n === seq.current) setView(r);
      } catch (e) {
        // Keep what's on screen if a refresh fails.
        if (n === seq.current) setView((cur) => (cur && typeof cur === "object" ? cur : message(e)));
      }
    })();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- loads changes on every server update; that's when to refetch
  }, [id, loads]);

  // Inline notes only when they were written for this commit: an older review's line numbers can point at the wrong code.
  const notes = useMemo(() => (v?.ai && !v.ai_stale ? orderNotes(v.ai.notes, v.files) : []), [v]);
  const notesByFile = useMemo(() => {
    const m = new Map<string, { note: ReviewNote; index: number }[]>();
    for (const [index, note] of notes.entries()) m.set(note.path, [...(m.get(note.path) ?? []), { note, index }]);
    return m;
  }, [notes]);

  // The file you're reading follows the scroll, except right after a key moved you: then it's the one the key picked.
  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const tops = [...document.querySelectorAll(".rv-file-sec")].map((el) => el.getBoundingClientRect().top);
        if (tops.length && Date.now() - jumped.current > 400) setFileIdx(currentFile(tops, LINE));
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  useEffect(() => {
    const t = armed
      ? setTimeout(() => {
          setArmed(0);
        }, ARM_MS)
      : undefined;
    return () => {
      clearTimeout(t);
    };
  }, [armed]);

  // A long file list scrolls on its own to keep the current file in sight; the page doesn't move.
  useEffect(() => {
    const list = listRef.current;
    const on = list?.querySelector<HTMLElement>(".rv-file.on");
    if (!list || !on || list.scrollHeight <= list.clientHeight) return;
    if (on.offsetTop < list.scrollTop) list.scrollTop = on.offsetTop - 8;
    else if (on.offsetTop + on.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = on.offsetTop + on.offsetHeight - list.clientHeight + 8;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- reads the DOM the new fileIdx just rendered
  }, [fileIdx]);

  function goFile(i: number) {
    if (!v?.files.length) return;
    const n = Math.max(0, Math.min(v.files.length - 1, i));
    jumped.current = Date.now();
    setFileIdx(n);
    document.querySelector(`#rv-f-${n}`)?.scrollIntoView({ block: "start" });
  }

  function goNote(d: number) {
    if (!v || !notes.length) {
      flash(v?.generating ? "The AI review is still being written" : "No notes on this PR");
      return;
    }
    const n = noteIdx === null ? (d > 0 ? 0 : notes.length - 1) : (noteIdx + d + notes.length) % notes.length;
    jumped.current = Date.now();
    setNoteIdx(n);
    setFileIdx(
      Math.max(
        0,
        v.files.findIndex((f) => f.path === notes[n]?.path),
      ),
    );
    document.querySelector(`[data-note="${n}"]`)?.scrollIntoView({ block: "center" });
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

  async function approve() {
    if (!v || busy === "approve") return;
    if (!canApprove) {
      flash(`Can't approve: ${approved === v.card.id ? "you just did" : (v.approve.reason ?? "not allowed")}`, true);
      return;
    }
    if (!armed || Date.now() - armed > ARM_MS) {
      setArmed(Date.now());
      flash(`Press a again to approve ${shortRef(v.card)}`, false, ARM_MS);
      return;
    }
    setArmed(0);
    setBusy("approve");
    try {
      await api.approve(v.card.id, v.item.head_oid);
      setApproved(v.card.id);
      flash(`Approved ${shortRef(v.card)} on GitHub`);
    } catch (e) {
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
    if (k === "n") goFile(fileIdx + 1);
    else if (k === "p") goFile(fileIdx - 1);
    else if (k === "]") goNote(1);
    else if (k === "[") goNote(-1);
    else if (k === "o" && v) window.open(v.card.url, "_blank", "noopener,noreferrer");
    else if (k === "c") void copyPrompt();
    else if (k === "i") void askAi();
    else if (k === "a") void approve();
    else if (k === "d" && v) onInflight(v.card);
    else if ((k === "y" || k === "x") && draft && row) onLane(row, k, draft);
    else if (k === "esc") onBack();
  }

  const onKey = (e: KeyboardEvent) => {
    if (inert || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    if (e.repeat && !["n", "p", "]", "["].includes(e.key)) return;
    const t = e.target instanceof HTMLElement ? e.target : document.body;
    if (t.closest("input, textarea, select, [contenteditable='true']")) return;
    if (armed && e.key !== "a" && e.key !== "Escape") setArmed(0); // any other key lets the approval lapse
    if (e.key === "Escape") {
      if (armed) setArmed(0);
      // An armed Send lapses on Esc (App drops it); only an unarmed Esc goes back.
      else if (!draft || armedDraft !== draft.id) onBack();
    } else if ((draft ? "npoci[]adyx" : "npoci[]ad").includes(e.key) && e.key.length === 1) {
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

  if (view === null) return <p className="quiet-note">Loading the review…</p>;
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
  const armedY = !!draft && armedDraft === draft.id;
  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);
  const approvers = item.reviews.filter((r) => r.state === "approved").map((r) => r.author);
  const approvals = approvers.length;
  // Problems are coloured words, as in the queue, and greyed by the same rules once the PR is sorted away.
  const facts = [
    { text: `CI ${CI[item.ci]}`, tone: item.ci === "red" ? "t-bad" : "" },
    {
      text:
        item.review_decision === "approved" && approvals
          ? `approved by ${approvers.join(", ")}`
          : `${REVIEW[item.review_decision]}${approvals ? `, ${approvals} ${approvals === 1 ? "approval" : "approvals"}` : ""}`,
      tone: item.review_decision === "changes_requested" ? "t-warn" : "",
    },
    ...(item.mergeable === "conflict" ? [{ text: "merge conflict", tone: "t-warn" }] : []),
    ...(item.draft ? [{ text: "draft", tone: "" }] : []),
    { text: `+${item.additions} −${item.deletions} in ${item.changed_files} ${item.changed_files === 1 ? "file" : "files"}`, tone: "" },
  ];
  // The why leaves out a fact it already says, as on the card ("conflicts with main" says "merge conflict").
  const why = card.why && !card.resolved && !facts.some((f) => f.text.toLowerCase() === card.why.toLowerCase()) ? card.why : "";
  const shownFacts = why ? facts.filter((f) => !says(why, f.text)) : facts;
  const resolved = card.resolved ? resolvedHead(view.activity, card.resolved, me) : null;
  const open = item.state === "open";

  return (
    <div className="review">
      <div className="rv-top">
        {/* A resolved PR needs nobody now, so it doesn't wear Now's highlighter. */}
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
            <span className="rv-by">
              by {isMine ? "you" : card.author}
              {card.author_bot ? " (bot)" : ""}
            </span>
          </p>
          <h1 className="rv-title">{card.title}</h1>
          <p className="rv-meta">
            {why && (mine ? <Owed why={why} /> : <span className="why">{why}</span>)}
            {shownFacts.map((f) => (
              <span key={f.text} className={cls("fact-word", f.tone)}>
                {f.text}
              </span>
            ))}
          </p>
          {resolved && (
            <p className="rv-meta rv-resolved">
              <span>{resolved.line}</span>
              {card.resolved_at && <span>{sinceText(card.resolved_at, now)}</span>}
            </p>
          )}
          {/* In flight: the why above says why it needs you ("in flight: …"); this is the lane's babysitter line under it. */}
          {row?.state === "open" && row.sitter.text && (
            <p className="rv-meta rv-lane">
              {sitterParts(row, now).map((p) => (
                <span key={p}>{p}</span>
              ))}
            </p>
          )}
          {draft && (
            <div className="draft rv-draft">
              <p className="draft-to">
                {draft.by === "agent" ? "Your agent's reply" : "Reply"} to {draft.to}
                {draft.quote && <span className="draft-quote">: “{draft.quote}”</span>}
              </p>
              <p className="draft-body">{draft.body}</p>
            </div>
          )}
        </header>
        {/* "First seen" is the desk's own bookkeeping, not something that happened. */}
        <Activity events={(resolved?.events ?? view.activity).filter((e) => e.kind !== "new")} me={me} now={now} />
        {/* Your own PR gets no AI review unless one was asked for; i still asks. */}
        {(!mine || !!view.ai || view.generating || busy === "ai" || !!view.ai_error) && (
          <AiSection view={view} asking={busy === "ai"} notes={notes.length} />
        )}
      </div>

      <div className="actions rv-actions">
        {mine && (
          <KeyButton
            k="d"
            label={card.inflight ? "Take back" : "In flight"}
            title={
              card.inflight ? "Back to you: babysitters stop" : "You're done: babysitters keep CI green and draft replies until it merges"
            }
            run={run}
          />
        )}
        {draft && (
          <>
            <KeyButton
              k="y"
              label={armedY ? "Press y again to send" : "Send"}
              title="Post this reply on GitHub, as you: press y twice"
              className={cls(armedY && "armed")}
              run={run}
            />
            <KeyButton k="x" label="Discard" run={run} />
          </>
        )}
        {/* Only someone else's open PR is yours to approve. */}
        {open && !isMine && (
          <KeyButton
            k="a"
            label={busy === "approve" ? "Approving…" : armed ? "Press a again to approve" : "Approve"}
            run={run}
            disabled={!canApprove || busy === "approve"}
            title={approved === card.id ? "You just approved it" : (view.approve.reason ?? "Approve on GitHub: press a twice")}
            className={cls(armed > 0 && "armed")}
          />
        )}
        <KeyButton k="o" label="Open on GitHub" run={run} />
        <KeyButton k="c" label="Copy prompt" run={run} />
        {(open || view.ai) && (
          <KeyButton
            k="i"
            label={view.ai && !view.ai_stale ? "Redo AI review" : "AI review"}
            run={run}
            disabled={view.generating || busy === "ai"}
          />
        )}
      </div>

      {view.files_error && <p className="t-bad rv-files-err">Couldn't load the diff: {view.files_error}</p>}
      {files.length > 0 && (
        <div className="rv-body">
          <nav ref={listRef} className="rv-files" aria-label="Changed files">
            <p className="rv-files-head">
              <span>
                {files.length} {files.length === 1 ? "file" : "files"}
              </span>
              <span className="rv-keys">
                <kbd>n</kbd> <kbd>p</kbd>
              </span>
            </p>
            <ol>
              {files.map((f, i) => {
                const [dir, name] = splitPath(f.path);
                const n = notesByFile.get(f.path)?.length ?? 0;
                return (
                  <li key={f.path}>
                    <button
                      type="button"
                      className={cls("rv-file", i === fileIdx && "on")}
                      title={f.path}
                      onClick={() => {
                        goFile(i);
                      }}
                    >
                      <span className="rv-fname">
                        {dir && <Dir path={dir} />}
                        <span className="rv-base">{breakable(name)}</span>
                      </span>
                      {n > 0 && <span className="rv-nn" title={`${n} AI ${n === 1 ? "note" : "notes"}`} />}
                      <span className="rv-delta">{delta(f)}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <p className="rv-files-foot">
              <Dots
                parts={[
                  `+${adds} −${dels}`,
                  ...(notes.length > 0
                    ? [
                        <span key="notes">
                          {notes.length} {notes.length === 1 ? "note" : "notes"}, <kbd>]</kbd> <kbd>[</kbd>
                        </span>,
                      ]
                    : []),
                ]}
              />
            </p>
          </nav>
          <div className="rv-diffs">
            {files.map((f, i) => (
              <FileSection key={f.path} file={f} index={i} notes={notesByFile.get(f.path) ?? []} current={noteIdx} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AiSection({ view, asking, notes }: { view: ReviewView; asking: boolean; notes: number }) {
  const ai = view.ai;
  const busy = view.generating || asking;
  return (
    <section className="rv-ai" aria-label="AI review">
      <h2 className="d-head">
        AI review{" "}
        {ai && (
          <span className="quiet">
            from {modelName(ai.model)}, {when(ai.at)}
            {view.ai_stale ? ", before the latest commits" : ""}
          </span>
        )}
      </h2>
      {busy && <p className="quiet">Your agent is reading the diff. This takes a minute or two; the notes land in the code below.</p>}
      {!busy && view.ai_error && (
        <p>
          {withCode(view.ai_error)}{" "}
          <span className="quiet">
            Press <kbd>i</kbd> to try again.
          </span>
        </p>
      )}
      {!busy && !ai && !view.ai_error && view.item.state !== "open" && <p className="quiet">No AI review.</p>}
      {!busy && !ai && !view.ai_error && view.item.state === "open" && (
        <p className="quiet">
          None yet. Press <kbd>i</kbd> to ask your agent for a summary, concerns and notes on the changes.
        </p>
      )}
      {ai && (
        <>
          <p className="rv-verdict">
            <span className={`verdict v-${ai.verdict}`}>{VERDICT[ai.verdict]}</span>
            <span className={cls("risk", ai.risk === "high" && "t-bad")}>{ai.risk} risk</span>
          </p>
          <p className="rv-summary">{ai.summary}</p>
          {ai.concerns.length > 0 ? (
            <ul className="rv-concerns" aria-label="Concerns">
              {ai.concerns.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          ) : (
            <p className="quiet">No concerns.</p>
          )}
          {!view.ai_stale && notes > 0 && (
            <p className="quiet">
              {notes} {notes === 1 ? "note" : "notes"} on the changes below: <kbd>]</kbd> next, <kbd>[</kbd> previous.
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

function FileSection({
  file,
  index,
  notes,
  current,
}: {
  file: ReviewFile;
  index: number;
  notes: { note: ReviewNote; index: number }[];
  current: number | null;
}) {
  const fileDiff = useMemo(() => (file.patch === null ? null : (parsePatchFiles(filePatch(file), file.path)[0]?.files[0] ?? null)), [file]);
  const annotations = useMemo(
    () =>
      notes
        .filter((n) => n.note.line > 0)
        .map((n): DiffLineAnnotation<NoteMeta> => ({
          side: n.note.side === "old" ? "deletions" : "additions",
          lineNumber: n.note.line,
          metadata: { index: n.index, body: n.note.body },
        })),
    [notes],
  );
  const [dir, name] = splitPath(file.path);
  const status = STATUS[file.status];
  return (
    <section className="rv-file-sec" id={`rv-f-${index}`} aria-label={file.path}>
      <h3 className="rv-fhead">
        <span className="rv-fname">
          {dir && <Dir path={dir} />}
          <span className="rv-base">{name}</span>
        </span>
        {status && (
          <span className="rv-fstatus">
            {status}
            {file.previous_path ? ` from ${file.previous_path}` : ""}
          </span>
        )}
        <span className="rv-delta">{delta(file)}</span>
      </h3>
      {notes
        .filter((n) => n.note.line === 0)
        .map((n) => (
          <Note key={n.index} index={n.index} body={n.note.body} on={current === n.index} />
        ))}
      {fileDiff ? (
        <FileDiff<NoteMeta>
          className="rv-diff"
          fileDiff={fileDiff}
          options={DIFF}
          lineAnnotations={annotations}
          renderAnnotation={(a) => <Note index={a.metadata.index} body={a.metadata.body} on={current === a.metadata.index} />}
        />
      ) : (
        <p className="rv-nodiff">No text diff: a binary file, or too large for GitHub to show.</p>
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
