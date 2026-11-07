import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Reviewer } from "../../../src/types.ts";
import { api, message } from "../api.ts";
import { cls } from "../format.ts";

// Who Ready for review asks to review your draft: GitHub's suggestions on the line, a click each, and in the list as you
// focus it, then its people and teams as you type. Those already asked show first and stay; @ in the review focuses it.
export function Reviewers({
  id,
  asked,
  picked,
  setPicked,
}: {
  id: string;
  asked: string[]; // logins and team slugs already asked on GitHub
  picked: Reviewer[];
  setPicked: (r: Reviewer[]) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  // What GitHub found for q; a string is why the search failed.
  const [found, setFound] = useState<{ q: string; list: Reviewer[] } | string | null>(null);
  const [hi, setHi] = useState(0);
  const [suggested, setSuggested] = useState<Reviewer[]>([]);
  const seq = useRef(0);

  // GitHub's suggestions, on the line before you look for anyone: who you'd likely ask anyway.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = await api.reviewers(id, "");
        if (live) setSuggested(r.filter((x) => x.suggested));
      } catch {
        // the list says why when you open it
      }
    })();
    return () => {
      live = false;
    };
  }, [id]);

  useEffect(() => {
    const n = ++seq.current;
    const search = async () => {
      try {
        const r = await api.reviewers(id, q);
        if (n === seq.current) setFound({ q, list: r });
      } catch (e) {
        if (n === seq.current) setFound(message(e));
      }
    };
    const t = open ? setTimeout(() => void search(), q ? 150 : 0) : undefined;
    return () => {
      clearTimeout(t);
    };
  }, [id, q, open]);

  const taken = new Set([...asked, ...picked.map((p) => p.login)].map((x) => x.toLowerCase()));
  // Until GitHub answers what's typed now, only the last answer's names that match it show, so Enter never adds a stale one.
  const now = typeof found === "object" && found?.q === q;
  const needle = q.trim().toLowerCase();
  const list =
    typeof found === "object" && found
      ? found.list
          .filter((r) => !taken.has(r.login.toLowerCase()))
          .filter((r) => now || r.login.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle))
          .slice(0, 8)
      : [];
  const offered = suggested.filter((r) => !taken.has(r.login.toLowerCase())).slice(0, 4);

  function add(r: Reviewer) {
    setPicked([...picked, r]);
    setQ("");
    setHi(0);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => (list.length ? (h + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = list[hi];
      if (r) add(r);
    } else if (e.key === "Backspace" && !q && picked.length) {
      setPicked(picked.slice(0, -1));
    } else if (e.key === "Escape") {
      // Its own: Esc here never leaves the review.
      e.stopPropagation();
      if (open && q) setQ("");
      else e.currentTarget.blur();
    }
  }

  return (
    <div className="rv-reviewers">
      <span className="rv-reviewers-label">Reviewers</span>
      {asked.map((a) => (
        <span key={a} className="rv-reviewer asked" title="Already asked on GitHub">
          {a}
        </span>
      ))}
      {picked.map((p) => (
        <span key={p.id} className="rv-reviewer">
          {p.login}
          {p.team && <span className="rv-reviewer-team">team</span>}
          <button
            type="button"
            className="rv-reviewer-x"
            aria-label={`Don't ask ${p.login}`}
            onClick={() => {
              setPicked(picked.filter((x) => x.id !== p.id));
            }}
          >
            ×
          </button>
        </span>
      ))}
      <span className="rv-reviewers-add">
        <input
          className="rv-reviewers-input"
          value={q}
          placeholder={picked.length || asked.length ? "Add another" : "Add reviewers"}
          aria-label="Add a reviewer"
          onChange={(e) => {
            setQ(e.target.value);
            setHi(0);
          }}
          onFocus={() => {
            setOpen(true);
          }}
          onBlur={() => {
            setOpen(false);
          }}
          onKeyDown={onKeyDown}
        />
        {open && (
          <div className="popover rv-reviewers-pop" aria-label="Reviewers">
            {typeof found === "string" ? (
              <p className="rv-reviewers-note err">Couldn't load reviewers: {found}</p>
            ) : list.length === 0 && !now ? (
              <p className="rv-reviewers-note">Asking GitHub…</p>
            ) : list.length === 0 ? (
              <p className="rv-reviewers-note">{q ? `No one matches “${q}”` : "No suggestions: type a name"}</p>
            ) : (
              list.map((r, i) => (
                <button
                  key={r.id}
                  type="button"
                  className={cls("pop-item", i === hi && "hi")}
                  // Before the input's blur closes the list.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add(r);
                  }}
                >
                  <span className="rv-reviewer-login">{r.login}</span>
                  {r.name && <span className="rv-reviewer-name">{r.name}</span>}
                  <span className="rv-reviewer-why">{r.team ? "team" : r.suggested ? "suggested" : ""}</span>
                </button>
              ))
            )}
          </div>
        )}
      </span>
      {offered.length > 0 && (
        <span className="rv-suggested">
          <span className="rv-reviewers-label">Suggested</span>
          {offered.map((r) => (
            <button
              key={r.id}
              type="button"
              className="rv-reviewer suggest"
              title={`Ask ${r.name || r.login} too: GitHub suggests them for this PR`}
              onClick={() => {
                add(r);
              }}
            >
              <span aria-hidden>+</span>
              {r.login}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}
