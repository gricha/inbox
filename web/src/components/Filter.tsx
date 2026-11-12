import { useRef, useState, type KeyboardEvent } from "react";
import { cls } from "../format.ts";
import { FILTER_KEYS, filterOf, filterRest, parseFilter, type FilterKey } from "../view.ts";
import { Avatar } from "./Avatar.tsx";

export interface FilterPerson {
  login: string;
  author: boolean; // wrote one of the rows
}

const KEY_LABEL: Record<FilterKey, string> = { author: "Author", involves: "Involves" };
const KEY_HELP: Record<FilterKey, string> = { author: "who opened it", involves: "anyone on it: asked, reviewed or said something" };

type Pick = { key: FilterKey; login: string }; // login "": the key alone, to pick its person next

// What the word being typed can turn into: a key's people, or for a name, who it is as author or as anyone involved.
function suggest(word: string, people: FilterPerson[]): Pick[] {
  const t = /^(author|involves):(\S*)$/i.exec(word);
  if (t) {
    const key = (t[1] as string).toLowerCase() as FilterKey;
    const q = (t[2] as string).replace(/^@/, "").toLowerCase();
    return people
      .filter((p) => (key === "involves" || p.author) && p.login.toLowerCase().includes(q))
      .slice(0, 8)
      .map((p) => ({ key, login: p.login }));
  }
  const q = word.replace(/^@/, "").toLowerCase();
  if (!q) return FILTER_KEYS.map((key) => ({ key, login: "" }));
  const found = people.filter((p) => p.login.toLowerCase().includes(q)).slice(0, 4);
  return [
    ...found.filter((p) => p.author).map((p) => ({ key: "author" as const, login: p.login })),
    ...found.map((p) => ({ key: "involves" as const, login: p.login })),
  ];
}

// A list's filter: on its page's head, or the head of the list beside a review. Words match a row's title, repo or author;
// author:dana and involves:dana pick people, as pills, suggested as you type.
export function Filter({
  filter,
  setFilter,
  people,
  me,
}: {
  filter: string;
  setFilter: (s: string) => void;
  people: FilterPerson[];
  me: string;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const pills = parseFilter(filter).terms.filter((t) => t.done);
  const rest = filterRest(filter);
  const word = /\S*$/.exec(rest)?.[0] ?? "";
  // A typed word that's a name opens the list; an empty box only once there's nothing else to filter by.
  const list = open && (word || !rest.trim()) ? suggest(word, people) : [];
  const shown = list.length > 0;

  function pick(p: Pick) {
    const before = rest.slice(0, rest.length - word.length);
    setFilter(p.login ? filterOf([...pills, { key: p.key, who: p.login }], before) : filterOf(pills, `${before}${p.key}:`));
    setHi(0);
    setOpen(true);
    input.current?.focus();
  }
  function drop(i: number) {
    setFilter(
      filterOf(
        pills.filter((_, j) => j !== i),
        rest,
      ),
    );
    input.current?.focus();
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setFilter("");
      e.currentTarget.blur();
    } else if (shown && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setHi((h) => (h + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length);
    } else if (e.key === "Enter" && shown && word) {
      e.preventDefault();
      pick(list[Math.min(hi, list.length - 1)] as Pick);
    } else if (e.key === "Enter" || e.key === "ArrowDown") e.currentTarget.blur();
    else if (e.key === "Backspace" && pills.length && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
      e.preventDefault();
      drop(pills.length - 1);
    }
  }

  return (
    <div className="search-box">
      <label className="search">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" />
          <path d="m10.5 10.5 3 3" />
        </svg>
        {pills.map((t, i) => {
          const you = t.who === "you" || t.who === "me";
          return (
            <span key={`${t.key}:${t.who}`} className="search-pill" title={`${KEY_LABEL[t.key]}: ${t.who}`}>
              <span className="search-pill-key">{KEY_LABEL[t.key]}</span>
              {(you ? me : t.who) && <Avatar login={you ? me : t.who} />}
              <span className="search-pill-who">{you ? "you" : t.who}</span>
              <button
                type="button"
                className="search-pill-x"
                aria-label={`Remove ${KEY_LABEL[t.key].toLowerCase()} ${t.who}`}
                onClick={(e) => {
                  e.preventDefault();
                  drop(i);
                }}
              >
                ×
              </button>
            </span>
          );
        })}
        <input
          ref={input}
          type="search"
          placeholder={pills.length ? "" : "Filter"}
          aria-label="Filter by title, repo or person"
          autoComplete="off"
          value={rest}
          onChange={(e) => {
            setFilter(filterOf(pills, e.target.value));
            setHi(0);
            setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
          }}
          onBlur={() => {
            setOpen(false);
          }}
          onKeyDown={onKeyDown}
        />
      </label>
      {shown && (
        <div className="popover search-pop" aria-label="Filter by person">
          {!word && <p className="pop-head">Filter by person</p>}
          {list.map((p, i) => (
            <button
              key={`${p.key}:${p.login}`}
              type="button"
              className={cls("pop-item", i === hi && "hi")}
              // Before the input's blur closes the list.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(p);
              }}
            >
              <span className="search-pop-key">{KEY_LABEL[p.key]}</span>
              {p.login ? (
                <>
                  <Avatar login={p.login} />
                  <span className="search-pop-who">{p.login}</span>
                </>
              ) : (
                <span className="search-pop-help">{KEY_HELP[p.key]}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
