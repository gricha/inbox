// An automation's typed notes in Settings: the TypeScript type its notes are, checked by the desk as you type
// (POST /api/automations/check, so the window never parses it itself); its rules on them, in order; and on its page, the
// notes it held because they don't fit. A held note's text and fields are what a run read from others' words: text only.
import { Effect } from "effect";
import { useRef, useState, type KeyboardEvent } from "react";
import { ITEM_DOES, type AutomationView, type ItemField, type ItemRule, type TypeCheck } from "../../../src/types.ts";
import { oneOf } from "../../../src/narrow.ts";
import { api, runUi } from "../api.ts";
import { useKeyed } from "../keyed.ts";
import { aiName, cls, when } from "../format.ts";
import { routeHash } from "../view.ts";

// What a rule on its notes does with a yes.
export const ITEM_DOES_WORDS: Record<ItemRule["do"], string> = {
  drop: "Drop it",
  urgent: "Urgent",
  standard: "Standard",
  fyi: "FYI",
};
const RULES_MAX = 10;
const QUIET = 400; // how long typing pauses before the desk checks it

// The desk's check of a type and its rules, a moment after each change; the fields stay those of the last type that read.
// null: not a typed one, so nothing to check.
export function useTypeCheck(type: string | null, rules: ItemRule[]) {
  const [check, setCheck] = useState<{ of: string; result: TypeCheck } | null>(null);
  const [fields, setFields] = useState<ItemField[]>([]);
  const key = JSON.stringify([type, rules]);
  useKeyed(type === null ? null : key, (signal) => {
    const t = setTimeout(() => {
      runUi(
        api.checkType(type ?? "", rules).pipe(
          Effect.map((result) => {
            setCheck({ of: key, result });
            if (!result.error) setFields(result.fields);
            return result;
          }),
          Effect.ignore, // the desk offline: Save says so
        ),
        { signal },
      );
    }, QUIET);
    return () => {
      clearTimeout(t);
    };
  });
  return { result: check?.result ?? null, current: check?.of === key, fields };
}

// Where a line and column are in the text, and how far the token there runs, to mark it.
function spanAt(text: string, line: number, column: number): [number, number] {
  const lines = text.split("\n");
  const start = Math.min(text.length, lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + column - 1);
  const token = /^[\w$]+|^"[^"\n]*"?|^'[^'\n]*'?|^[^\s]/.exec(text.slice(start))?.[0] ?? "";
  return [start, start + token.length];
}

// The type, in the app's code style. The desk's refusal is marked where it is, and said under it in the parser's words.
export function TypeField({
  value,
  check,
  onChange,
  keys,
}: {
  value: string;
  check: ReturnType<typeof useTypeCheck>;
  onChange: (v: string) => void;
  keys: (e: KeyboardEvent) => void;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const error = check.result?.error ?? null;
  const at = error?.line && error.column && check.current ? spanAt(value, error.line, error.column) : null;
  const go = () => {
    const el = ta.current;
    if (!el || !at) return;
    el.focus();
    el.setSelectionRange(at[0], at[1]);
  };
  return (
    <div className="au-field">
      <label className="s-label" htmlFor="au-type-src">
        Its notes are
      </label>
      <div className="au-type-box">
        {at && (
          <div className="au-type-back" aria-hidden="true">
            {value.slice(0, at[0])}
            <span className="au-type-mark">{value.slice(at[0], at[1]) || " "}</span>
            {value.slice(at[1])}
          </div>
        )}
        <textarea
          ref={ta}
          id="au-type-src"
          className="editor au-type-src"
          value={value}
          maxLength={4000}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={'type Email = {\n  kind: "bill" | "statement" | "personal";\n  sender: string;\n  amount?: number;\n}'}
          aria-invalid={!!error}
          aria-describedby="au-type-help"
          onKeyDown={keys}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
      </div>
      {error ? (
        <p id="au-type-help" className="s-help t-bad au-type-error">
          {at ? (
            <button type="button" className="au-type-go" title="Go there in the type" onClick={go}>
              {error.message}
            </button>
          ) : (
            error.message
          )}
        </p>
      ) : (
        <span id="au-type-help" className="s-help">
          TypeScript, one type: string, number, boolean, string literals (&quot;a&quot; | &quot;b&quot;), optional fields, nested objects
          and arrays. The run fills each note&rsquo;s fields by it; one that doesn&rsquo;t fit is held off your desk, and {aiName()}{" "}
          recommends what to do. Empty: its notes have no fields.
        </span>
      )}
      {check.fields.length > 0 && value.trim() && (
        <dl className="au-fields" aria-label="What its rules can read">
          {check.fields.map((f) => (
            <div key={f.path}>
              <dt>
                <code>{f.path}</code>
              </dt>
              <dd>
                <code>{f.type}</code>
                {f.optional && <span className="quiet">, may be left out</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

// Its rules, in order: each a when over item.<field>, an ask in your words, or both, and what a yes does.
export function RulesField({
  rules,
  check,
  onChange,
  keys,
}: {
  rules: ItemRule[];
  check: ReturnType<typeof useTypeCheck>;
  onChange: (r: ItemRule[]) => void;
  keys: (e: KeyboardEvent) => void;
}) {
  const set = (i: number, r: ItemRule) => {
    onChange(rules.map((x, j) => (j === i ? r : x)));
  };
  const move = (i: number, by: number) => {
    const next = [...rules];
    const [r] = next.splice(i, 1);
    next.splice(i + by, 0, r!);
    onChange(next);
  };
  const errors = check.current ? (check.result?.rules ?? []) : [];
  return (
    <fieldset className="au-field">
      <legend className="s-label">Its rules</legend>
      {rules.length > 0 && (
        <ol className="au-rules">
          {rules.map((r, i) => {
            const n = i + 1;
            const error = errors[i] ?? null;
            const said = !!r.when?.trim() || !!r.ask?.trim();
            return (
              // oxlint-disable-next-line react/no-array-index-key -- a rule has no id; its place is what it is
              <li key={i} className="au-rule">
                <div className="au-line">
                  <select
                    className="input choice au-rule-do"
                    aria-label={`What rule ${n} does`}
                    value={r.do}
                    onKeyDown={keys}
                    onChange={(e) => {
                      const does = oneOf(ITEM_DOES, e.target.value);
                      if (does) set(i, { ...r, do: does });
                    }}
                  >
                    {ITEM_DOES.map((d) => (
                      <option key={d} value={d}>
                        {ITEM_DOES_WORDS[d]}
                      </option>
                    ))}
                  </select>
                  <span className="s-unit">when</span>
                  <input
                    className="input au-code"
                    aria-label={`Rule ${n}: when`}
                    value={r.when ?? ""}
                    placeholder={'item.<field> == "…"'}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    aria-invalid={!!error && error.startsWith("when:")}
                    onKeyDown={keys}
                    onChange={(e) => {
                      const { when: _, ...rest } = r;
                      set(i, e.target.value ? { ...rest, when: e.target.value } : rest);
                    }}
                  />
                </div>
                <div className="au-line">
                  <span className="s-unit">and {aiName()} says yes to</span>
                  <input
                    className="input"
                    aria-label={`Rule ${n}: ask`}
                    value={r.ask ?? ""}
                    maxLength={1000}
                    placeholder="Optional: a question, in your words"
                    onKeyDown={keys}
                    onChange={(e) => {
                      const { ask: _, ...rest } = r;
                      set(i, e.target.value ? { ...rest, ask: e.target.value } : rest);
                    }}
                  />
                </div>
                <div className="au-rule-foot">
                  {error && <span className={cls("s-help", said && "t-bad")}>{error}</span>}
                  <span className="grow" />
                  <button
                    type="button"
                    className="link-btn"
                    disabled={i === 0}
                    aria-label={`Move rule ${n} up`}
                    onClick={() => {
                      move(i, -1);
                    }}
                  >
                    Move up
                  </button>
                  <button
                    type="button"
                    className="link-btn"
                    disabled={i === rules.length - 1}
                    aria-label={`Move rule ${n} down`}
                    onClick={() => {
                      move(i, 1);
                    }}
                  >
                    Move down
                  </button>
                  <button
                    type="button"
                    className="link-btn"
                    aria-label={`Remove rule ${n}`}
                    onClick={() => {
                      onChange(rules.filter((_, j) => j !== i));
                    }}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <div className="au-line">
        <button
          type="button"
          className="s-edit"
          disabled={rules.length >= RULES_MAX}
          onClick={() => {
            onChange([...rules, { do: "drop" }]);
          }}
        >
          Add a rule
        </button>
      </div>
      <span className="s-help">
        Asked of each note that fits its type, in order: the first that says yes decides, and one none does goes where its run put it. When
        is the rules&rsquo; language over the fields above, with no model; an ask is a yes or no a light model answers, only for the notes
        its when passes. Use when wherever the fields settle it.
      </span>
    </fieldset>
  );
}

// What an automation held off your desk, on its page: each note, how it doesn't fit, and your agent's recommendation.
export function HeldNotes({ a }: { a: AutomationView }) {
  if (!a.held.length) return null;
  return (
    <>
      <h2 className="group-head au-runs-head">Held</h2>
      <p className="s-view-line">Notes whose fields don&rsquo;t fit its type. They aren&rsquo;t on your desk.</p>
      <div className="lines">
        {a.held.map((h) => (
          <section key={h.id} className="au-held" aria-label={`Held: ${h.text}`}>
            <div className="au-run-top">
              <h3 className="au-held-text">{h.text}</h3>
              {h.rec ? (
                <a className="au-resume link-btn" href={routeHash({ name: "inquiry", id: h.rec })}>
                  {aiName()}&rsquo;s recommendation
                </a>
              ) : (
                <span className="au-resume quiet">{aiName()} is still to recommend</span>
              )}
            </div>
            <p className="au-held-at">{when(h.at)}</p>
            <pre className="au-held-error t-bad">{h.error}</pre>
            <code className="au-held-fields">{JSON.stringify(h.fields)}</code>
          </section>
        ))}
      </div>
    </>
  );
}
