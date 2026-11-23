import type { WaitingStep } from "../../../src/types.ts";
import { age, cls } from "../format.ts";
import { afterText, chainLabel, stepGuides, WAIT, type Guide, type Ids } from "../groups.ts";
import { Avatar } from "./Avatar.tsx";
import { ChainIcon, KindIcon, RowFacts } from "./RowIcons.tsx";
import { parseItemId } from "../../../src/links.ts";

// What a chain's rows need from the app: which heads are open on this device, and a step's own click.
export interface ChainCtx {
  open: ReadonlySet<string>;
  toggle: (head: string) => void;
  step: (s: WaitingStep) => void; // opens it, as its row would
  gone: Ids; // steps you just stopped waiting: off their chain until the desk says where they are
}

const TREE_STEP = 20; // as CardRow's

const KIND_TIP = { pr: "Pull request", issue: "Issue", note: "Note to yourself" };

// The steps still to show under a head.
export const stepsOf = (waiting: WaitingStep[] | undefined, ctx: ChainCtx | undefined): WaitingStep[] =>
  ctx ? (waiting ?? []).filter((s) => !ctx.gone.has(s.id)) : [];

// A chain's head, after its why: quietly, how many steps wait on it; pressed, they open under it, and Hide folds them.
export function ChainButton({ head, steps, ctx }: { head: string; steps: WaitingStep[]; ctx: ChainCtx }) {
  const open = ctx.open.has(head);
  return (
    <button
      type="button"
      className="line-chain"
      aria-expanded={open}
      data-tip={open ? "Fold the steps that wait on this" : "Steps that wait on this one, in the order they run"}
      onClick={() => {
        ctx.toggle(head);
      }}
    >
      <ChainIcon />
      {chainLabel(steps.length, open)}
    </button>
  );
}

// A head's waiting steps, one level under it, each a row as any other, saying what it comes after where its why would be.
export function WaitingRows({
  steps,
  head,
  ctx,
  me,
  now,
  selected,
}: {
  steps: WaitingStep[];
  head: Guide[]; // the head's own guide, on Blocked
  ctx: ChainCtx;
  me: string;
  now: number;
  selected: string | null;
}) {
  const guides = stepGuides(head, steps.length);
  return steps.map((s, i) => {
    const g = guides[i]!;
    const after = afterText(s);
    const { repo: name, number: num } = parseItemId(s.ref);
    const who = s.by === "you" ? me : s.by;
    return (
      <div key={s.id} className={cls("line wait-line", selected === `${WAIT}${s.id}` && "sel")} data-id={`${WAIT}${s.id}`}>
        <div className="line-main line-row" style={{ paddingLeft: `calc(var(--pad, 14px) + ${g.length * TREE_STEP}px)` }}>
          <span className="tree" aria-hidden="true">
            {g.map((x, k) => (
              // oxlint-disable-next-line react/no-array-index-key -- a step is its level: its place is all that tells it apart
              <span key={k} className={`tree-${x}`} />
            ))}
          </span>
          <button
            type="button"
            className="row-main line-btn"
            onMouseDown={(e) => {
              e.preventDefault();
            }}
            onClick={() => {
              ctx.step(s);
            }}
          >
            <KindIcon kind={s.kind} tip={KIND_TIP[s.kind]} />
            <span className="line-title">{s.title}</span>
            {s.ref && (
              <>
                <span className="line-ref" data-tip={`${s.repo}#${num}`}>
                  {name}
                </span>
                <span className="line-num">#{num}</span>
              </>
            )}
            <span className="line-note wait-after" data-tip={after}>
              {after}
            </span>
          </button>
          <RowFacts />
          <span className="line-by line-face" data-tip={who ? `By ${s.by === "you" ? "you" : s.by}` : undefined}>
            {who && <Avatar login={who} />}
            <span className="sr">{who ? `by ${s.by}` : "by you"}</span>
          </span>
          <span className="line-age" data-tip={`waiting since ${new Date(s.since).toLocaleString()}`}>
            {age(s.since, now)}
          </span>
        </div>
      </div>
    );
  });
}
