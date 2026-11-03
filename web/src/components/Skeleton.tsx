import { cls } from "../format.ts";

const n = (count: number) => [...Array.from({ length: count }).keys()];

// Rows on their way, at the queue's row height, so the page doesn't move when they land.
export function SkRows({ count = 6 }: { count?: number }) {
  return (
    <div className="lines" aria-busy="true" aria-label="Loading">
      {n(count).map((i) => (
        <div key={i} className="sk-row" aria-hidden="true">
          <span className="sk" />
          <span className="sk" />
          <span className="sk" />
        </div>
      ))}
    </div>
  );
}

// Lines of text on their way, at the line height of the text around them.
export function SkLines({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div className={cls("sk-lines", className)} aria-hidden="true">
      {n(count).map((i) => (
        <span key={i} className="sk" />
      ))}
    </div>
  );
}
