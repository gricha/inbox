import { Effect } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";
import { BUCKETS, type ConfigDoc, type ConfigError, type FieldDoc, type PreviewResult } from "../../../src/types.ts";
import { api, runUi } from "../api.ts";
import { BUCKET_LABEL, cls, MOD, shortId, tilde } from "../format.ts";
import { lineOf } from "../view.ts";
import { ActButton } from "./Detail.tsx";

export function Rules({
  active,
  shown,
  refresh,
  flash,
  onSaved,
  onDirty,
}: {
  active: boolean; // Settings is open: the file loads with it, so the view opens on it
  shown: boolean; // its view is on screen: its keys work
  refresh: number; // bumps on every app refresh: a clean editor re-reads the file in case it changed on disk
  flash: (text: string, error?: boolean) => void;
  onSaved: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const [doc, setDoc] = useState<{ path: string; text: string } | null>(null);
  const [loadError, setLoadError] = useState("");
  const [text, setText] = useState("");
  const [errors, setErrors] = useState<ConfigError[]>([]);
  const [warnings, setWarnings] = useState<ConfigError[]>([]);
  const [hard, setHard] = useState<ConfigDoc["hard"]>([]);
  const [preview, setPreview] = useState<{ text: string; result: PreviewResult } | null>(null);
  const [busy, setBusy] = useState<"" | "preview" | "save">("");
  const [fields, setFields] = useState<FieldDoc[]>([]);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState("1:1");
  const ta = useRef<HTMLTextAreaElement>(null);
  const dirty = doc !== null && text !== doc.text;
  const latest = useRef({ doc, text });
  latest.current = { doc, text };

  const load = useCallback(
    (): Effect.Effect<void> =>
      api.config().pipe(
        Effect.match({
          onSuccess: (c) => {
            const { doc: d, text: t } = latest.current;
            if (d !== null && t !== d.text) return; // you started editing while this was in flight
            if (!d || d.text !== c.text || d.path !== c.path) {
              setDoc({ path: c.path, text: c.text });
              setText(c.text);
              setPreview(null);
            }
            setErrors(c.errors);
            setWarnings(c.warnings ?? []);
            setHard(c.hard);
            setLoadError("");
          },
          onFailure: (e) => {
            setLoadError(e.message);
          },
        }),
      ),
    [],
  );

  useEffect(() => {
    const stop = new AbortController();
    // The fields' help is a side list: the editor works without it.
    void runUi(api.fields().pipe(Effect.map(setFields), Effect.ignore), { signal: stop.signal });
    return () => {
      stop.abort();
    };
  }, []);

  // Re-read the file each time the page opens: it may have been edited outside (desk config edit, an editor).
  useEffect(() => {
    // Read through the ref: finishing an edit (dirty to clean) must not trigger a re-read.
    const { doc: d, text: t } = latest.current;
    const stop = new AbortController();
    if (active && (d === null || t === d.text)) void runUi(load(), { signal: stop.signal });
    return () => {
      stop.abort();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- refresh only triggers a re-read
  }, [active, load, refresh]);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);

  const idle = Effect.sync(() => {
    setBusy("");
  });

  function runPreview() {
    setBusy("preview");
    void runUi(
      api.preview(text).pipe(
        Effect.match({
          onSuccess: (result) => {
            setPreview({ text, result });
            setErrors(result.errors);
          },
          onFailure: (e) => {
            flash(e.message, true);
          },
        }),
        Effect.ensuring(idle),
      ),
    );
  }

  function save() {
    setBusy("save");
    void runUi(
      api.saveConfig(text, doc?.text).pipe(
        Effect.tap((r) =>
          Effect.sync(() => {
            setErrors(r.errors);
            if (r.ok) {
              setDoc((d) => d && { ...d, text });
              setPreview(null);
              flash("Saved. Syncing with the new rules.");
              onSaved();
            } else flash(`Not saved: ${r.errors.length} ${r.errors.length === 1 ? "error" : "errors"}`, true);
          }),
        ),
        Effect.catch((e) =>
          e._tag === "DeskConflict" && e.kind === "Stale"
            ? // The file changed under us: keep your edit, take the new file as the base, and say so.
              api.config().pipe(
                Effect.tap((c) =>
                  Effect.sync(() => {
                    setDoc({ path: c.path, text: c.text });
                  }),
                ),
                Effect.ignore, // no new base: the toast still says why it wasn't saved
                Effect.andThen(
                  Effect.sync(() => {
                    flash(
                      "config.toml changed on disk. Your edit is still here: Revert loads the new file, Save again overwrites it.",
                      true,
                    );
                  }),
                ),
              )
            : Effect.sync(() => {
                flash(e.message, true);
              }),
        ),
        Effect.ensuring(idle),
      ),
    );
  }

  // Window-level so ⌘S / ⌘↵ work wherever focus is on this view; a ref keeps the latest text.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    // An editor that saves itself (your policy's, an automation's) keeps its own ⌘S.
    if (!(e.metaKey || e.ctrlKey) || document.activeElement?.closest("[data-own-save]")) return;
    if (e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (!busy && dirty) save();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!busy) runPreview();
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      keys.current(e);
    };
    if (shown) window.addEventListener("keydown", h);
    return () => {
      window.removeEventListener("keydown", h);
    };
  }, [shown]);

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    if (dirty) window.addEventListener("beforeunload", h);
    return () => {
      window.removeEventListener("beforeunload", h);
    };
  }, [dirty]);

  function track() {
    const el = ta.current;
    if (!el) return;
    const before = el.value.slice(0, el.selectionStart);
    setPos(`${before.split("\n").length}:${el.selectionStart - before.lastIndexOf("\n")}`);
  }

  // execCommand keeps the browser's undo stack; setRangeText is the fallback.
  function insert(s: string) {
    const el = ta.current;
    if (!el) return;
    el.focus();
    // oxlint-disable-next-line typescript/no-deprecated -- the only way to insert text that the textarea's undo stack keeps
    if (!document.execCommand("insertText", false, s)) {
      el.setRangeText(s, el.selectionStart, el.selectionEnd, "end");
      setText(el.value);
    }
    track();
  }

  function jump(path: string) {
    const el = ta.current;
    const line = lineOf(text, path);
    if (!el || line === null) return;
    const lines = text.split("\n");
    const startOf = (n: number) => lines.slice(0, n).reduce((sum, l) => sum + l.length + 1, 0);
    const start = startOf(line);
    el.focus({ preventScroll: true });
    el.setSelectionRange(start, start + (lines[line] ?? "").length);
    el.scrollTop = depthOf(el, text.slice(0, startOf(Math.max(0, line - 4))));
    // The line sits near the editor's top, which a click on an error under the editor (a narrow window) has scrolled away.
    el.scrollIntoView({ block: "nearest" });
    track();
  }

  const q = query.trim().toLowerCase();
  const listed = q ? fields.filter((f) => f.path.includes(q) || f.doc.toLowerCase().includes(q)) : fields;
  const stale = preview !== null && preview.text !== text;
  const pvBoards = preview?.result.boards ?? [];
  const same = (b: PreviewResult["boards"][number]) =>
    b.before !== null && !b.moved.length && !b.unfetched.length && BUCKETS.every((k) => b.before![k] === b.counts[k]);
  const changed = pvBoards.filter((b) => !same(b));
  const unchanged = pvBoards.filter(same);

  return (
    <div className="rules-wrap" hidden={!shown}>
      {loadError && (
        <div className="notice err">
          <span>Couldn't load the rules: {loadError}</span>
          <button
            type="button"
            className="btn"
            onClick={() => {
              void runUi(load());
            }}
          >
            Retry
          </button>
        </div>
      )}
      <div className="rules">
        <div className="editor-col">
          <textarea
            ref={ta}
            className="editor"
            value={text}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Config TOML"
            onChange={(e) => {
              setText(e.target.value);
            }}
            onSelect={track}
            onKeyDown={(e) => {
              if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                insert("  ");
              } else if (e.key === "Escape")
                // Onto its foot, so Tab and Enter go on from Save (Preview changes while there's nothing to save).
                e.currentTarget.closest(".editor-col")?.querySelector<HTMLButtonElement>(".editor-foot button:not(:disabled)")?.focus();
            }}
          />
          <div className="editor-foot">
            {/* Filled while there's something to save: the one to press. */}
            <ActButton
              label={busy === "save" ? "Saving…" : "Save"}
              title={`Save (${MOD}S). In the editor, Tab indents and Esc leaves it.`}
              disabled={!!busy || !dirty}
              className={cls(dirty && !errors.length && "primary")}
              run={() => {
                save();
              }}
            />
            <ActButton
              label={busy === "preview" ? "Previewing…" : "Preview changes"}
              title={`Preview changes (${MOD}\u21b5)`}
              disabled={!!busy}
              run={() => {
                runPreview();
              }}
            />
            <ActButton
              label="Revert"
              disabled={!dirty}
              run={() => {
                if (doc) setText(doc.text);
                setErrors([]);
                setPreview(null);
              }}
            />
            {doc && <code className="s-path">{tilde(doc.path)}</code>}
            <span className="grow" />
            {dirty && <span className="unsaved">Unsaved changes</span>}
            <span className="pos">Line {pos.replace(":", ", column ")}</span>
          </div>
        </div>

        <div className="side-col">
          {warnings.length > 0 && (
            <section className="side-block">
              <h2 className="s-sub t-warn">Moved to Settings</h2>
              <ul className="plain">
                {warnings.map((w) => (
                  <li key={w.path}>
                    <code>{w.path}</code> is ignored here now; it lives in Settings. Delete it from this file.
                  </li>
                ))}
              </ul>
            </section>
          )}
          {errors.length > 0 && (
            <section className="side-block errors">
              <h2 className="s-sub t-bad">
                {errors.length} {errors.length === 1 ? "error" : "errors"}
              </h2>
              <ul>
                {errors.map((e, i) => (
                  // oxlint-disable-next-line react/no-array-index-key -- errors have no id and can repeat a path
                  <li key={i}>
                    <button
                      type="button"
                      className="err-row"
                      onClick={() => {
                        jump(e.path);
                      }}
                      title="Jump to this line"
                    >
                      <code>{e.path}</code>
                      <span>{e.message}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="side-block">
            <h2 className="s-sub">Rules Claude can't sort below</h2>
            {hard.length ? (
              <p className="small">
                What a hard rule matches stays at least in its bucket (<code>today</code> for a <code>now</code> rule), whatever Claude,
                quiet days or caps say. A final rule places what it matches itself: Claude doesn't re-sort it.
              </p>
            ) : (
              <p className="small">
                None: Claude can sort anything off your desk. <code>hard = true</code> on a rule keeps what it matches there.
              </p>
            )}
            {hard.length > 0 && (
              <ul className="plain hard-rules">
                {hard.map((h, i) => (
                  // oxlint-disable-next-line react/no-array-index-key -- rules have no id; the list is redrawn whole
                  <li key={i}>
                    <span>
                      {h.board} → {BUCKET_LABEL[h.bucket]}
                      {h.why && `: ${h.why}`}
                      {h.final && <span className="quiet"> (final)</span>}
                    </span>
                    <code>{h.when}</code>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="side-block">
            <h2 className="s-sub">What would move {stale && <span className="stale">(edited since)</span>}</h2>
            {!preview ? (
              <p className="small">Preview changes shows what moves before you save. Nothing changes until you save.</p>
            ) : pvBoards.length === 0 ? (
              <p className="small">Fix the errors to see a preview.</p>
            ) : (
              changed.map((b) => (
                <div key={b.id} className="pv-board">
                  <div className="pv-name">
                    <b>{b.name}</b> <span className="mono">{b.id}</span>
                    {b.before === null && <span className="quiet">new board</span>}
                  </div>
                  <div className="pv-counts">
                    {BUCKETS.map((k) => {
                      const was = b.before?.[k] ?? 0;
                      return (
                        <span key={k} className={cls(was !== b.counts[k] && "chg")}>
                          {BUCKET_LABEL[k]} {b.before ? `${was} → ${b.counts[k]}` : b.counts[k]}
                        </span>
                      );
                    })}
                  </div>
                  {b.moved.length > 0 && (
                    <ul className="pv-moved">
                      {b.moved.map((m) => (
                        <li key={m.id}>
                          <span className="ref">{shortId(m.id)}</span>
                          <span className="mono">
                            {m.from ?? "new"} → {m.to}
                          </span>
                          <span className="title" title={m.title}>
                            {m.title}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {b.unfetched.length > 0 && (
                    <p className="note small">
                      Not fetched yet, so not counted; saving fetches:{" "}
                      {b.unfetched.map((u) => (
                        <code key={u}>{u}</code>
                      ))}
                    </p>
                  )}
                </div>
              ))
            )}
            {pvBoards.length > 0 && unchanged.length > 0 && (
              <p className={cls("small", changed.length > 0 && "pv-same")}>
                {changed.length ? `Unchanged: ${unchanged.map((b) => b.name).join(", ")}` : "Nothing moves on any board."}
              </p>
            )}
          </section>

          <section className="side-block">
            <h2 className="s-sub">Fields</h2>
            <input
              className="input"
              type="search"
              placeholder="Search fields"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
              aria-label="Search fields"
            />
            <div className="fields-list">
              {listed.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  className="field"
                  onClick={() => {
                    insert(f.path);
                  }}
                  title="Insert at the cursor"
                >
                  <code>{f.path}</code>
                  <span className="type">{f.type}</span>
                  <span className="doc">{f.doc}</span>
                </button>
              ))}
              {!listed.length && <p className="small">No fields match.</p>}
            </div>
          </section>

          <section className="side-block">
            <h2 className="s-sub">Syntax</h2>
            <dl className="cheat">
              <div className="fact">
                <dt>rules</dt>
                <dd>
                  first matching <code>when</code> places the card; else <code>default</code>
                </dd>
              </div>
              <div className="fact">
                <dt>buckets</dt>
                <dd>
                  <code>now today blocked later fyi hide</code>
                </dd>
              </div>
              <div className="fact">
                <dt>logic</dt>
                <dd>
                  <code>&amp;&amp; || !</code> (or <code>and or not</code>)
                </dd>
              </div>
              <div className="fact">
                <dt>compare</dt>
                <dd>
                  <code>== != &lt; &lt;= &gt; &gt;= in matches</code>
                </dd>
              </div>
              <div className="fact">
                <dt>functions</dt>
                <dd>
                  <code>len(x) lower(s) contains(s, sub) startswith(s, p) any(list, "glob*")</code>
                </dd>
              </div>
              <div className="fact">
                <dt>examples</dt>
                <dd>
                  <code>"ml-team" in item.labels</code>, <code>item.title matches "^fix"</code>
                </dd>
              </div>
              <div className="fact">
                <dt>why</dt>
                <dd>
                  <code>why = "close collaborator: {"{author.engaged_90d}"} PRs"</code>
                </dd>
              </div>
              <div className="fact">
                <dt>caps</dt>
                <dd>
                  <code>caps = {"{ now = 3, today = 6 }"}</code>; <code>nocap = true</code> on a rule exempts it
                </dd>
              </div>
              <div className="fact">
                <dt>hard</dt>
                <dd>
                  <code>hard = true</code> on a rule: a floor. What it matches never sorts below its bucket (<code>today</code> for a{" "}
                  <code>now</code> rule); Claude sorts within it, and everything else with the rule's bucket as its hint
                </dd>
              </div>
              <div className="fact">
                <dt>final</dt>
                <dd>
                  <code>final = true</code> on a rule: Claude doesn't re-sort what it matches; it stays in the rule's bucket (your pin still
                  lifts it)
                </dd>
              </div>
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}

// How far down the editor `before` reaches once wrapped: laid out in a hidden copy of the editor, from one mark to another.
function depthOf(el: HTMLTextAreaElement, before: string): number {
  const copy = document.createElement("div");
  const from = document.createElement("span");
  const to = document.createElement("span");
  copy.className = "editor";
  // Its own scrollbar, as the editor has one, so its lines are as wide as the editor's.
  Object.assign(copy.style, {
    position: "absolute",
    visibility: "hidden",
    width: `${el.offsetWidth}px`,
    height: "auto",
    overflowY: "scroll",
  });
  copy.append(from, before, to);
  document.body.append(copy);
  const depth = to.getBoundingClientRect().top - from.getBoundingClientRect().top;
  copy.remove();
  return depth;
}
