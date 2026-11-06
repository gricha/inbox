import { Fragment, useMemo, type ReactNode } from "react";
import { blocks, type Block, type Span } from "../prose.ts";

// An agent's words drawn from web/src/prose.ts: React elements only, never HTML, never an image.
export function Prose({ text }: { text: string }) {
  const bs = useMemo(() => blocks(text), [text]);
  return (
    <div className="prose">
      {bs.map((b, i) => (
        // oxlint-disable-next-line react/no-array-index-key -- a fixed parse never reorders
        <Fragment key={i}>{block(b)}</Fragment>
      ))}
    </div>
  );
}

function block(b: Block): ReactNode {
  if (b.t === "pre")
    return (
      <pre>
        <code>{b.text}</code>
      </pre>
    );
  if (b.t === "p") return <p>{spans(b.spans)}</p>;
  const items = b.items.map((s, i) => (
    // oxlint-disable-next-line react/no-array-index-key -- a fixed parse never reorders
    <li key={i}>{spans(s)}</li>
  ));
  return b.t === "ul" ? <ul>{items}</ul> : <ol start={b.start}>{items}</ol>;
}

function spans(ss: Span[]): ReactNode {
  return ss.map((s, i) => {
    const el =
      s.t === "text" ? (
        s.text
      ) : s.t === "code" ? (
        <code>{s.text}</code>
      ) : (
        <a href={s.url} target="_blank" rel="noreferrer">
          {s.url}
        </a>
      );
    // oxlint-disable-next-line react/no-array-index-key -- a fixed parse never reorders
    return <Fragment key={i}>{s.bold ? <b>{el}</b> : el}</Fragment>;
  });
}
