import { lazy, Suspense } from "react";
import type { Card, Stage } from "../../../src/types.ts";
import { aiPending } from "../../../src/stage.ts";
import { RISK_BARS, rowLit } from "../risk.ts";
import { cls, sizeOf } from "../format.ts";

// A row's icons (16px, drawn in currentColor like .i): what it is, and its facts on the right as one signal.
function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg className="i" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

const ring = <circle cx="8" cy="8" r="6" />;

const KIND = {
  pr: (
    <>
      <circle cx="4" cy="3.75" r="1.75" />
      <circle cx="4" cy="12.25" r="1.75" />
      <circle cx="12" cy="12.25" r="1.75" />
      <path d="M4 5.5v5M12 10.5v-4a2 2 0 0 0-2-2H8M9.5 2.75 7.75 4.5 9.5 6.25" />
    </>
  ),
  issue: (
    <>
      {ring}
      <circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none" />
    </>
  ),
  question: (
    <>
      {ring}
      <path d="M6.3 6.4a1.8 1.8 0 1 1 2.7 1.55c-.6.35-1 .75-1 1.35" />
      <circle cx="8" cy="11.3" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  session: (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="M4.75 6.25 6.75 8l-2 1.75M8.5 10H11" />
    </>
  ),
  note: <path d="M3.5 2.5h6l3 3v8h-9zM9.5 2.5v3h3M5.75 8.75h4.5M5.75 11h3" />,
};

const KIND_WORD = { pr: "PR", issue: "Issue", question: "Question", session: "Session", note: "Note" };

const PackIcon = lazy(() => import("./PackIcon.tsx"));

// A note's icon: the one its pack draws for its name (an email's Gmail logo, a bill's receipt), else a note's.
export function NoteGlyph({ icon }: { icon: string | undefined }) {
  const plain = <Icon>{KIND.note}</Icon>;
  if (!icon) return plain;
  return (
    <Suspense fallback={plain}>
      <PackIcon name={icon} fallback={plain} />
    </Suspense>
  );
}

// What a row is, as an icon in the titles' first column; its word stays for a screen reader. A note an automation raised
// may show its own icon (an email's Gmail logo) in place of a note's.
export function KindIcon({ kind, tip, icon }: { kind: keyof typeof KIND; tip: string; icon?: string | undefined }) {
  return (
    <span className="line-kind" data-tip={tip}>
      {kind === "note" ? <NoteGlyph icon={icon} /> : <Icon>{KIND[kind]}</Icon>}
      <span className="sr">{KIND_WORD[kind]}</span>
    </span>
  );
}

const STAGE: Record<Stage, React.ReactNode> = {
  draft: <circle cx="8" cy="8" r="6" strokeDasharray="2.4 2.3" />,
  "waiting for review": (
    <>
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="1.9" />
    </>
  ),
  "changes requested": <path d="M8 2.75v5.5M5.25 5.5h5.5M5.25 12.25h5.5" />,
  approved: <path d="M1.5 8.6l3 3 6-6.8M8 11.2l.4.4 6.1-6.8" />,
  blocked: (
    <>
      {ring}
      <path d="M3.9 3.9l8.2 8.2" />
    </>
  ),
  "handed back": <path d="M5.5 3.5l-3 3 3 3M2.5 6.5h7.25a3.25 3.25 0 0 1 0 6.5H7" />,
  rebasing: <path d="M13.5 8a5.5 5.5 0 0 1-9.6 3.7M2.5 8a5.5 5.5 0 0 1 9.6-3.7M12.5 1.8v2.7H9.8M3.5 14.2v-2.7h2.7" />,
  merged: (
    <>
      <circle cx="4" cy="3.75" r="1.75" />
      <circle cx="4" cy="12.25" r="1.75" />
      <circle cx="12" cy="8.5" r="1.75" />
      <path d="M4 5.5v5M4 5.5c0 2 2 3 6.25 3" />
    </>
  ),
  closed: <path d="M4 4l8 8M12 4l-8 8" />,
};

const CI = {
  green: { tip: "CI passing", tone: "t-ok", icon: <path d="M5.4 8.2l1.8 1.8 3.4-3.6" /> },
  red: { tip: "CI failing", tone: "t-bad", icon: <path d="M6 6l4 4M10 6l-4 4" /> },
  pending: { tip: "CI running", tone: "", icon: <path d="M8 5v3l2 1.2" /> },
};

const VERDICT = { look: "look closely", skim: "skim it", skip: "skip it" };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// A phone's signal: four rising bars, filled with no outline. As many are lit as `lit`, all in its colour (one red, two
// orange, three yellow, four green); the rest are grey.
export function Signal({ lit }: { lit: number }) {
  return (
    <svg className={`i signal n-${lit}`} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {[0, 1, 2, 3].map((n) => (
        <rect
          key={n}
          className={n < lit ? "on" : undefined}
          x={1.4 + n * 3.6}
          y={10 - n * 2.8}
          width="2.4"
          height={4.4 + n * 2.8}
          rx="0.6"
        />
      ))}
    </svg>
  );
}

interface Fact {
  key: string;
  said: string; // "Approved", "CI passing", "Low risk", "Small change"
  end?: React.ReactNode; // its icon or counts, on the right
}

// A PR's four facts, in the order its signal's popover reads: status, CI, risk, changes. One with nothing to say (no
// checks, no AI review yet) says so quietly.
function factsOf(card: Card, stage: boolean): Fact[] {
  const pr = card.kind === "pr" ? card : undefined;
  const verdict = pr?.preflight?.verdict ?? pr?.verdict ?? undefined;
  const risk = pr?.preflight?.risk ?? pr?.risk;
  const size = pr?.size && sizeOf(pr.size);
  const ci = pr && pr.ci !== "none" ? pr.ci : undefined;
  const st = stage ? pr?.stage : undefined;
  const facts: Fact[] = [];
  if (st)
    facts.push({
      key: "status",
      said: cap(st),
      // Amber only on yours, where it's work for you.
      end: (
        <span className={cls("sig-i", st === "changes requested" && card.by === "you" && "t-warn")}>
          <Icon>{STAGE[st]}</Icon>
        </span>
      ),
    });
  facts.push(
    ci
      ? {
          key: "ci",
          said: CI[ci].tip,
          end: (
            <span className={cls("sig-i", CI[ci].tone)}>
              <Icon>
                {ring}
                {CI[ci].icon}
              </Icon>
            </span>
          ),
        }
      : { key: "ci", said: "No checks" },
    risk
      ? {
          key: "risk",
          said: `${cap(risk)} risk${verdict ? `, ${VERDICT[verdict]}` : ""}`,
          end: (
            <span className="sig-i">
              <Signal lit={RISK_BARS[risk]} />
            </span>
          ),
        }
      : { key: "risk", said: "No AI review yet" },
  );
  if (size && pr?.size)
    facts.push({
      key: "size",
      said: size.label.split(":")[0]!,
      end: (
        <span className="rv-size">
          <span className="add">+{pr.size.add}</span> <span className="del">−{pr.size.del}</span>
        </span>
      ),
    });
  return facts;
}

// The facts on a row's right as one icon: the AI review's risk as its signal, the same bars a review shows (grey with no
// review yet). Under the pointer it opens them as the review's Status does: its name, then a
// row each, words on the left and its icon on the right (Tips.tsx shows its .tip-rich). A quick review's bolt leads it. A
// row with no facts keeps the empty slot, so the columns line up down the table.
export function RowFacts({ card, stage }: { card?: Card; stage?: boolean }) {
  const pr = card?.kind === "pr" ? card : undefined;
  const facts = pr ? factsOf(pr, !!stage) : [];
  const words = facts.map((f) => f.said).join(". ");
  // Its first AI review not written yet: where that review is, in words, in place of the signal it will light.
  const pending = aiPending(pr?.preflight);
  if (pending)
    return (
      <span className="line-facts">
        <span className="line-pending" data-tip={words}>
          {pending}
        </span>
      </span>
    );
  return (
    <span className="line-facts">
      {pr?.quick && (
        <span className="line-quick" data-tip={pr.quick}>
          <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M9 1.5 3.5 9h4.5l-1 5.5 5.5-7.5H8z" />
          </svg>
          <span className="sr">quick to review</span>
        </span>
      )}
      <span className="rf line-signal" data-tip={words || undefined}>
        {pr && (
          <>
            <Signal lit={rowLit(pr)} />
            <span className="sr">{words}</span>
            <span className="tip-rich sig" hidden>
              <span className="sig-head">Status</span>
              {facts.map((f) => (
                <span key={f.key} className={cls("sig-row", `sig-${f.key}`, !f.end && "quiet")}>
                  <span className="sig-said">{f.said}</span>
                  {f.end}
                </span>
              ))}
            </span>
          </>
        )}
      </span>
    </span>
  );
}

// Where a person's picture goes when a row is from no person: an agent, a bot.
export const AgentIcon = () => (
  <Icon>
    <rect x="2.75" y="5.25" width="10.5" height="8" rx="2.25" />
    <path d="M8 5.25v-2M6.1 8.75v1M9.9 8.75v1" />
    <circle cx="8" cy="2.5" r="0.75" />
  </Icon>
);

export const ClockIcon = () => (
  <Icon>
    {ring}
    <path d="M8 4.75V8l2.1 1.3" />
  </Icon>
);

// A chain's head: steps wait on it, in order.
export const ChainIcon = () => (
  <Icon>
    <path d="M7 9l2-2M6.25 5.75l1.2-1.2a2.475 2.475 0 0 1 3.5 3.5l-1.2 1.2M9.75 10.25l-1.2 1.2a2.475 2.475 0 0 1-3.5-3.5l1.2-1.2" />
  </Icon>
);
