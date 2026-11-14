import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Action, Card, GitHubAction, InboxSection, Inquiry, MailCard, SessionAction, SessionCard } from "../../../src/types.ts";
import { cls, fromName, SNOOZE, snoozeOptions } from "../format.ts";
import { useKeyedLayout } from "../keyed.ts";
import { MORE, rowActions } from "./More.tsx";
import { isKeyOf } from "../../../src/narrow.ts";
import { openMail } from "./Mail.tsx";
import { SESSION_ACTION } from "./Session.tsx";

// Where a row on the Inbox can move: one section up or down.
const MOVES: Record<InboxSection, InboxSection[]> = { urgent: ["standard"], standard: ["urgent", "fyi"], fyi: ["standard"] };
const SECTION_NAME: Record<InboxSection, string> = { urgent: "Urgent", standard: "Standard", fyi: "FYI" };

// What an entry does: the row's action (as run() takes it), a desk action, a More menu write, or a snooze.
type Do = { key: string } | { act: Action } | { github: GitHubAction } | { snooze: string };

interface Entry {
  label: string;
  do: Do;
}

export interface RowMenuProps {
  card: Card;
  x: number;
  y: number;
  snooze?: boolean; // opened by an issue's Snooze: Snooze open, its first time focused
  me: string;
  run: (c: Card, key: string) => void;
  act: (c: Card, action: Action, until?: string) => void;
  github: (c: Card, a: GitHubAction) => void;
  reopen: (x: number, y: number) => void; // a right-click outside it: the menu of the row there, if any
  onClose: () => void;
}

// A row's right-click menu: every write a row has. Snooze opens to the side with the times and what this item can wait on.
export function RowMenu({ card, x, y, snooze, run, act, github, reopen, onClose }: RowMenuProps) {
  const snoozes = card.inflight ? [] : snoozeOptions(card);

  const go = (label: string, id: string): Entry => ({ label, do: { key: id } });
  // Only what's worth a right-click: off your desk (Done) or until later (Snooze), closing it, and its link. The rest is
  // a click on the row, its call to action, or its review.
  const groups: Entry[][] = [
    card.inflight
      ? [go("Back to the desk", "b")]
      : [
          card.status === "active"
            ? { label: "Done", do: { act: "done" as const } }
            : { label: "Back on the desk", do: { act: "restore" as const } },
        ],
    card.section && card.status === "active" && !card.inflight
      ? MOVES[card.section].map((to) => ({ label: `Move to ${SECTION_NAME[to]}`, do: { act: to } }))
      : [],
    rowActions(card)
      .filter((a) => a === "close")
      .map((a) => ({ label: `${MORE[a]} on GitHub`, do: { github: a } })),
    [go("Copy link", "link"), go("Copy GitHub link", "github-link")],
  ];
  function pick(d: Do) {
    if ("key" in d) run(card, d.key);
    else if ("act" in d) act(card, d.act);
    else if ("github" in d) github(card, d.github);
    else act(card, "snooze", d.snooze);
  }
  return (
    <Menu
      label={`${card.kind === "pr" ? "PR" : "Issue"} ${card.repo}#${card.number}`}
      groups={groups}
      snoozes={snoozes}
      x={x}
      y={y}
      snooze={snooze}
      pick={pick}
      reopen={reopen}
      onClose={onClose}
    />
  );
}

// An agent's question's menu: what its page offers. `run` takes answer, link or dismiss.
export function QuestionMenu({
  q,
  x,
  y,
  run,
  reopen,
  onClose,
}: {
  q: Inquiry;
  x: number;
  y: number;
  run: (q: Inquiry, key: string) => void;
  reopen: (x: number, y: number) => void;
  onClose: () => void;
}) {
  const go = (label: string, id: string): Entry => ({ label, do: { key: id } });
  return (
    <Menu
      label={`Question by ${fromName(q.from, false)}`}
      groups={[[go("Answer", "answer"), go("Copy link", "link")], [go("Dismiss", "dismiss")]]}
      snoozes={[]}
      x={x}
      y={y}
      pick={(d) => {
        if ("key" in d) run(q, d.key);
      }}
      reopen={reopen}
      onClose={onClose}
    />
  );
}

// A session's menu: Done and Snooze (to a time: a session has no activity to wait on), then its first action.
export function SessionMenu({
  s,
  x,
  y,
  act,
  start,
  reopen,
  onClose,
}: {
  s: SessionCard;
  x: number;
  y: number;
  act: (s: SessionCard, action: "done" | "snooze", until?: string) => void;
  start: (s: SessionCard, action: SessionAction) => void;
  reopen: (x: number, y: number) => void;
  onClose: () => void;
}) {
  const [first] = s.actions;
  return (
    <Menu
      label={`Session ${s.name}`}
      groups={[[{ label: "Done", do: { act: "done" } }], first ? [{ label: SESSION_ACTION[first].label, do: { key: first } }] : []]}
      snoozes={SNOOZE.filter((o) => o.until !== "activity")}
      x={x}
      y={y}
      pick={(d) => {
        if ("snooze" in d) act(s, "snooze", d.snooze);
        else if ("act" in d) act(s, "done");
        else if ("key" in d && isKeyOf(SESSION_ACTION, d.key)) start(s, d.key);
      }}
      reopen={reopen}
      onClose={onClose}
    />
  );
}

// An urgent email's menu: Done (until a new message), Open in Gmail, Mute, and Snooze to a time.
export function MailMenu({
  m,
  x,
  y,
  act,
  reopen,
  onClose,
}: {
  m: MailCard;
  x: number;
  y: number;
  act: (m: MailCard, action: "done" | "snooze" | "mute", until?: string) => void;
  reopen: (x: number, y: number) => void;
  onClose: () => void;
}) {
  return (
    <Menu
      label={`Email ${m.subject}`}
      groups={[
        [{ label: "Done", do: { act: "done" } }],
        [
          { label: "Open in Gmail", do: { key: "open" } },
          { label: "Mute", do: { act: "mute" } },
        ],
      ]}
      snoozes={SNOOZE.filter((o) => o.until !== "activity")}
      x={x}
      y={y}
      pick={(d) => {
        if ("snooze" in d) act(m, "snooze", d.snooze);
        else if ("act" in d) act(m, d.act === "mute" ? "mute" : "done");
        else if ("key" in d && d.key === "open") openMail(m);
      }}
      reopen={reopen}
      onClose={onClose}
    />
  );
}

// The menu itself, at the pointer: its entries in groups, Snooze's side menu after Done, and the keyboard while it's open.
function Menu({
  label,
  groups,
  snoozes,
  x,
  y,
  snooze,
  pick,
  reopen,
  onClose,
}: {
  label: string; // whose menu it is, for a screen reader
  groups: Entry[][];
  snoozes: ReturnType<typeof snoozeOptions>;
  x: number;
  y: number;
  snooze?: boolean | undefined;
  pick: (d: Do) => void;
  reopen: (x: number, y: number) => void;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y, flip: false });
  const [sub, setSub] = useState(!!snooze);
  const leave = useRef<number | undefined>(undefined);
  const entries = groups.flat();

  function choose(d: Do) {
    onClose();
    pick(d);
  }

  // Inside the window, opening up or left where it would run off; the side menu goes left when there's no room right.
  useLayoutEffect(() => {
    const r = menu.current?.getBoundingClientRect();
    if (!r) return;
    const left = x + r.width > innerWidth - 8 ? Math.max(8, x - r.width) : x;
    const top = y + r.height > innerHeight - 8 ? Math.max(8, innerHeight - 8 - r.height) : y;
    setPos({ left, top, flip: left + r.width + 260 > innerWidth - 8 });
    // The menu takes focus, not its first item: nothing looks picked until you hover or press an arrow; opened for Snooze,
    // Snooze's first time does.
    const first = snooze ? menu.current?.querySelector<HTMLElement>(".ctx-sub .ctx-item") : null;
    (first ?? menu.current)?.focus({ preventScroll: true });
  }, [x, y, snooze]);

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

  // While open it has the keyboard: arrows move, Right and Left open and close Snooze, Enter picks, Esc closes.
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing || ["Shift", "Meta", "Control", "Alt"].includes(e.key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...(menu.current?.querySelectorAll<HTMLElement>(".ctx-item") ?? [])];
    const active = document.activeElement;
    const at = items.findIndex((el) => el === active);
    const inSub = !!active?.closest(".ctx-sub");
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
    } else if (e.key === "ArrowRight" && active?.classList.contains("ctx-has-sub")) {
      openSub();
    } else if (e.key === "ArrowLeft" && inSub) {
      setSub(false);
      menu.current?.querySelector<HTMLElement>(".ctx-has-sub")?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      // Nothing picked yet: Enter is the row's own, its first entry.
      if (at >= 0) items[at]?.click();
      else if (e.key === "Enter") choose(entries[0]!.do);
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
        aria-label={label}
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
              {/* Snooze sits after Done. */}
              {gi === 0 && snoozes.length > 0 && (
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
                    <span className="ctx-caret" aria-hidden="true">
                      ›
                    </span>
                  </button>
                  {sub && (
                    <SnoozeSub
                      top={pos.top}
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

function SnoozeSub({
  top,
  options,
  pick,
}: {
  top: number; // its menu's, once placed: it opens with its menu, before the menu moves up to fit the window
  options: ReturnType<typeof snoozeOptions>;
  pick: (until: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  const shifted = useRef(0);
  // Up as far as it would run past the window's bottom, from where its menu is now.
  useKeyedLayout(top, () => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    shifted.current = Math.min(0, innerHeight - 8 - (r.bottom - shifted.current));
    setShift(shifted.current);
  });
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
        </button>
      ))}
    </div>
  );
}
