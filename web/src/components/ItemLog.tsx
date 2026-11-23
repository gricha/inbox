// An item's log, for tuning your rules: one line per event, newest first. The desk's own moves (where it went, its score,
// the rule that placed it, Claude's answer, why) between what happened on GitHub.
import { Effect } from "effect";
import { useEffect, useRef, useState } from "react";
import type { ActivityEvent, ItemDetail, PlacedEntry, PlacingRule } from "../../../src/types.ts";
import { api, runUi } from "../api.ts";
import { cls, eventText } from "../format.ts";
import { useKeyed } from "../keyed.ts";
import { logLine } from "../groups.ts";

type Line = { at: string; key: string; placed?: PlacedEntry; event?: ActivityEvent };

// "Nov 17 07:22", one token per column.
const stamp = (at: string) => {
  const d = new Date(at);
  const hm = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${hm}`;
};

export function ItemLog({
  id,
  loads,
  me,
  onBack,
  onRule,
}: {
  id: string;
  loads: number; // bumped on every refresh: a move shows as it lands
  me: string;
  onBack: () => void;
  onRule: (rule: PlacingRule) => void; // a line's rule: Rules with it shown
}) {
  const [d, setD] = useState<ItemDetail | string | null>(null); // string: why it couldn't load
  const seq = useRef(0);
  useKeyed(`${id} ${loads}`, (signal) => {
    const n = ++seq.current;
    runUi(
      api.item(id).pipe(
        Effect.match({
          onSuccess: (r) => {
            if (n === seq.current) setD(r);
          },
          onFailure: (e) => {
            if (n === seq.current) setD((cur) => (cur && typeof cur === "object" ? cur : e.message));
          },
        }),
      ),
      { signal },
    );
  });

  const back = useRef(onBack);
  back.current = onBack;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const t = e.target instanceof HTMLElement ? e.target : document.body;
      if (!t.closest("input, textarea, select, [contenteditable='true']")) back.current();
    };
    window.addEventListener("keydown", h);
    return () => {
      window.removeEventListener("keydown", h);
    };
  }, []);

  if (d === null) return <div className="item-log" aria-busy="true" />;
  if (typeof d === "string")
    return (
      <div className="item-log">
        <p className="t-bad">{d}</p>
      </div>
    );

  const { card } = d;
  const lines: Line[] = [
    ...d.log.map((p) => ({ at: p.at, key: `p${p.seq}`, placed: p })),
    ...d.activity.map((e) => ({ at: e.at, key: `e${e.seq}`, event: e })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <div className="item-log">
      <h1 className="log-title">
        <span className="quiet">
          {card.repo}#{card.number}
        </span>{" "}
        {card.title}
      </h1>
      {lines.length === 0 && <p className="quiet">Nothing logged yet.</p>}
      <ol className="plain log-lines">
        {lines.map((l) => {
          const p = l.placed;
          const x = p && logLine(p);
          return (
            <li key={l.key} className={cls(p ? "log-desk" : "log-github")}>
              <time dateTime={l.at}>{stamp(l.at)}</time>
              <span className="log-kind">{x ? x.kind : "github"}</span>
              <span className="log-msg">
                {p && x ? (
                  <>
                    <b>{x.where}</b>
                    {p.rule && (
                      <button
                        type="button"
                        className="log-rule"
                        title={`${p.rule.when}: open it in your rules`}
                        onClick={() => {
                          if (p.rule) onRule(p.rule);
                        }}
                      >
                        rule {p.rule.id ?? p.rule.why}
                      </button>
                    )}
                    {x.judge && <span>{x.judge}</span>}
                    {x.note && <span>{x.note}</span>}
                    {x.why && <span className="quiet">{x.why}</span>}
                  </>
                ) : (
                  l.event && eventText(l.event, me)
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
