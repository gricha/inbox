import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Action, Card, GitHubAction } from "../../../src/types.ts";
import { cls, snoozeOptions } from "../format.ts";
import { MORE, rowActions } from "./More.tsx";

// What an entry does: the row's key (as run() takes it), a desk action, a More menu write, or a snooze.
type Do = { key: string } | { act: Action } | { github: GitHubAction } | { snooze: string };

interface Entry {
  label: string;
  key?: string; // the row's own key for it, which also works while the menu is open
  do: Do;
}

export interface RowMenuProps {
  card: Card;
  x: number;
  y: number;
  me: string;
  run: (c: Card, key: string) => void;
  act: (c: Card, action: Action, until?: string) => void;
  github: (c: Card, a: GitHubAction) => void;
  reopen: (x: number, y: number) => void; // a right-click outside it: the menu of the row there, if any
  onClose: () => void;
}

// A row's right-click menu: what its keys do, so a mouse reaches all of it. Snooze opens to the side with the times and what
// this item can wait on.
export function RowMenu({ card, x, y, me, run, act, github, reopen, onClose }: RowMenuProps) {
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y, flip: false });
  const [sub, setSub] = useState(false);
  const leave = useRef<number | undefined>(undefined);
  const mine = card.kind === "pr" && card.author.toLowerCase() === me.toLowerCase();
  const snoozes = card.inflight ? [] : snoozeOptions(card);

  const key = (label: string, k: string): Entry => ({ label, key: k, do: { key: k } });
  const muted = card.status === "muted";
  const handsOff = mine && !card.resolved; // m on your open PR hands it off, so it doesn't mute
  const groups: Entry[][] = [
    [key(card.kind === "pr" ? "Review" : "Open", "enter"), key("Open on GitHub", "o")],
    [
      ...(card.cta === "ready" ? [key("Ready for review", "a")] : []),
      ...(card.cta === "reviewers" ? [key("Add reviewers", "a")] : []),
      ...(mine && !card.resolved && !card.draft && !card.inflight && card.cta !== "reviewers" ? [key("Hand off for merge", "m")] : []),
      ...(card.inflight ? [key("Back to the desk", "b")] : []),
      ...(card.inflight
        ? []
        : [
            card.status === "active"
              ? { label: "Done", key: "e", do: { act: "done" as const } }
              : { label: "Back on the desk", key: "e", do: { act: "restore" as const } },
          ]),
    ],
    [
      ...(card.inflight
        ? []
        : [
            {
              label: muted ? "Unmute" : "Mute",
              ...(!handsOff && { key: "m" }),
              do: { act: muted ? ("unmute" as const) : ("mute" as const) },
            },
          ]),
      { label: card.pinned ? "Unpin" : "Pin", key: "p", do: { act: card.pinned ? ("unpin" as const) : ("pin" as const) } },
      key("Ask your agent", "t"),
    ],
    // Its call to action is above already.
    rowActions(card)
      .filter((a) => !(a === "ready" && card.cta === "ready"))
      .map((a) => ({ label: `${MORE[a].label} on GitHub`, do: { github: a } })),
  ];
  const entries = groups.flat();

  function choose(d: Do) {
    onClose();
    if ("key" in d) run(card, d.key);
    else if ("act" in d) act(card, d.act);
    else if ("github" in d) github(card, d.github);
    else act(card, "snooze", d.snooze);
  }

  // Inside the window, opening up or left where it would run off; the side menu goes left when there's no room right.
  useLayoutEffect(() => {
    const r = menu.current?.getBoundingClientRect();
    if (!r) return;
    const left = x + r.width > innerWidth - 8 ? Math.max(8, x - r.width) : x;
    const top = y + r.height > innerHeight - 8 ? Math.max(8, innerHeight - 8 - r.height) : y;
    setPos({ left, top, flip: left + r.width + 260 > innerWidth - 8 });
    // The menu takes focus, not its first item: nothing looks picked until you hover or press an arrow.
    menu.current?.focus({ preventScroll: true });
  }, [x, y]);

  useEffect(() => {
    const close = () => {
      onClose();
    };
    // Focus going anywhere else (a click in the chat, say) closes it, so typing there never runs its keys.
    const out = (e: FocusEvent) => {
      // menu.current is null once this menu is gone, while the next one, opened by a right-click elsewhere, takes focus.
      if (e.target instanceof Node && menu.current && !menu.current.contains(e.target)) onClose();
    };
    window.addEventListener("focusin", out);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    // Your scrolling closes it; the page's own (bringing the row it selected into view) doesn't.
    window.addEventListener("wheel", close);
    window.addEventListener("touchmove", close);
    return () => {
      window.removeEventListener("focusin", out);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("wheel", close);
      window.removeEventListener("touchmove", close);
      clearTimeout(leave.current);
    };
  }, [onClose]);

  // While open it has the keyboard: arrows move, → and ← open and close Snooze, the row's keys act, Esc closes.
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing || ["Shift", "Meta", "Control", "Alt"].includes(e.key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...(menu.current?.querySelectorAll<HTMLElement>(".ctx-item") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const inSub = !!(document.activeElement as HTMLElement | null)?.closest(".ctx-sub");
    if (e.key === "Escape") {
      if (!inSub) onClose();
      else {
        setSub(false);
        menu.current?.querySelector<HTMLElement>(".ctx-has-sub")?.focus();
      }
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const scope = items.filter((el) => !!el.closest(".ctx-sub") === inSub);
      const i = at < 0 ? -1 : scope.indexOf(items[at]!);
      const down = e.key === "ArrowDown";
      scope[i < 0 ? (down ? 0 : scope.length - 1) : (i + (down ? 1 : scope.length - 1)) % scope.length]?.focus();
    } else if (
      (e.key === "ArrowRight" && (document.activeElement as HTMLElement | null)?.classList.contains("ctx-has-sub")) ||
      (e.key === "s" && snoozes.length)
    ) {
      openSub();
    } else if (e.key === "ArrowLeft" && inSub) {
      setSub(false);
      menu.current?.querySelector<HTMLElement>(".ctx-has-sub")?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      // Nothing picked yet: Enter is the row's own, Review.
      if (at >= 0) items[at]?.click();
      else if (e.key === "Enter") choose(entries[0]!.do);
    } else {
      const hit = entries.find((en) => en.key === e.key);
      const o = snoozes.find((so) => so.key === e.key);
      if (hit) choose(hit.do);
      else if (o) choose({ snooze: o.until });
    }
  };
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      keyRef.current(e);
    };
    window.addEventListener("keydown", h, { capture: true });
    return () => {
      window.removeEventListener("keydown", h, { capture: true });
    };
  }, [keyRef]);

  function openSub() {
    setSub(true);
    requestAnimationFrame(() => {
      menu.current?.querySelector<HTMLElement>(".ctx-sub .ctx-item")?.focus();
    });
  }

  // Hovering another item closes Snooze after a moment, so cutting across a corner on the way to it doesn't.
  const hover = (open: boolean) => {
    clearTimeout(leave.current);
    if (open) setSub(true);
    else
      leave.current = window.setTimeout(() => {
        setSub(false);
      }, 250);
  };

  const item = (en: Entry) => (
    <button
      key={en.label}
      type="button"
      role="menuitem"
      className="ctx-item"
      onMouseEnter={(e) => {
        hover(false);
        e.currentTarget.focus({ preventScroll: true }); // what's highlighted is what Enter does
      }}
      onClick={() => {
        choose(en.do);
      }}
    >
      <span>{en.label}</span>
      {en.key && <kbd>{en.key}</kbd>}
    </button>
  );

  return (
    <>
      <div
        className="scrim-clear"
        role="presentation"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          reopen(e.clientX, e.clientY);
        }}
      />
      <div
        ref={menu}
        className={cls("ctx", pos.flip && "flip")}
        role="menu"
        tabIndex={-1}
        aria-label={`${card.kind === "pr" ? "PR" : "Issue"} ${card.repo}#${card.number}`}
        style={{ left: pos.left, top: pos.top }}
        onContextMenu={(e) => {
          e.preventDefault();
        }}
      >
        {groups
          .filter((g) => g.length)
          .map((g, gi) => (
            <div key={g[0]!.label} className="ctx-group">
              {g.map(item)}
              {/* Snooze sits after Done, as e and s do on the keyboard. */}
              {gi === 1 && snoozes.length > 0 && (
                <div
                  className="ctx-subwrap"
                  onMouseEnter={() => {
                    hover(true);
                  }}
                  onMouseLeave={() => {
                    hover(false);
                  }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded={sub}
                    className={cls("ctx-item ctx-has-sub", sub && "on")}
                    onMouseEnter={(e) => {
                      e.currentTarget.focus({ preventScroll: true });
                    }}
                    onClick={openSub}
                  >
                    <span>Snooze</span>
                    <kbd>s</kbd>
                    <span className="ctx-caret" aria-hidden="true">
                      ›
                    </span>
                  </button>
                  {sub && (
                    <SnoozeSub
                      options={snoozes}
                      pick={(until) => {
                        choose({ snooze: until });
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          ))}
      </div>
    </>
  );
}

function SnoozeSub({ options, pick }: { options: ReturnType<typeof snoozeOptions>; pick: (until: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  // Up as far as it would run past the window's bottom.
  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (r) setShift(Math.min(0, innerHeight - 8 - r.bottom));
  }, []);
  return (
    <div ref={box} className="ctx ctx-sub" role="menu" aria-label="Snooze" style={{ transform: `translateY(${shift}px)` }}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="menuitem"
          className={cls("ctx-item", o.key === "6" && "ctx-sep")}
          onMouseEnter={(e) => {
            e.currentTarget.focus({ preventScroll: true });
          }}
          onClick={() => {
            pick(o.until);
          }}
        >
          <span>{o.label}</span>
          <kbd>{o.key}</kbd>
        </button>
      ))}
    </div>
  );
}
