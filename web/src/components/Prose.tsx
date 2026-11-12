import { Effect } from "effect";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { runUi } from "../api.ts";
import { copyText } from "../format.ts";
import { blocks, fencedCopy, saidBlocks, textLines, unlinked, type Block, type Said, type Span } from "../../../src/prose.ts";

// An agent's words drawn from src/prose.ts: React elements only, never HTML, never an image.
export function Prose({ text }: { text: string }) {
  const bs = useMemo(() => blocks(text), [text]);
  return <ProseBlocks bs={bs} />;
}

// links false: text the PR's author can steer (an AI review of their PR), where a URL is drawn as text.
export function ProseBlocks({ bs, links = true }: { bs: Block[]; links?: boolean }) {
  return (
    <div className="prose">
      {bs.map((b, i) => (
        // oxlint-disable-next-line react/no-array-index-key -- a fixed parse never reorders
        <Fragment key={i}>{block(b, links)}</Fragment>
      ))}
    </div>
  );
}

// What a reviewer wrote on GitHub: its markdown as blocks, <details> a fold, <sub> small print; its URLs text, never HTML.
export function SaidText({ text }: { text: string }) {
  const bs = useMemo(() => saidBlocks(text), [text]);
  return <div className="prose said">{bs.map(saidBlock)}</div>;
}

function saidBlock(b: Said, i: number): ReactNode {
  if (b.t === "details")
    return (
      <details key={i} className="said-more">
        <summary>{spans(unlinked(b.summary))}</summary>
        <div className="prose">{b.blocks.map(saidBlock)}</div>
      </details>
    );
  if (b.t === "small")
    return (
      <p key={i} className="said-small">
        {spans(unlinked(b.spans))}
      </p>
    );
  return <Fragment key={i}>{block(b, false)}</Fragment>;
}

// What a reviewer wrote, or Claude's read of it: code as code, a URL as text, never HTML; the box's pre-wrap keeps lines and indents.
export function Words({ text }: { text: string }) {
  return textLines(text).map((l, i) => (
    // oxlint-disable-next-line react/no-array-index-key -- a fixed split never reorders
    <Fragment key={i}>
      {i > 0 && "\n"}
      {spans(unlinked(l))}
    </Fragment>
  ));
}

function block(b: Block, links: boolean): ReactNode {
  const line = (ss: Span[]) => spans(links ? ss : unlinked(ss));
  if (b.t === "pre") return <Pre text={b.text} info={b.info} />;
  if (b.t === "p") return <p>{line(b.spans)}</p>;
  const items = b.items.map((s, i) => (
    // oxlint-disable-next-line react/no-array-index-key -- a fixed parse never reorders
    <li key={i}>{line(s)}</li>
  ));
  return b.t === "ul" ? <ul>{items}</ul> : <ol start={b.start}>{items}</ol>;
}

// A code block, and a quiet Copy that keeps its fence: a ```suggestion pasted on GitHub is a suggestion there.
function Pre({ text, info }: { text: string; info: string }) {
  const [said, setSaid] = useState("Copy");
  return (
    <>
      <pre>
        <code>{text}</code>
      </pre>
      <button
        type="button"
        className="act prose-copy"
        title="Copy it with its ``` fence, to paste on GitHub"
        onClick={() => {
          runUi(
            copyText(fencedCopy(text, info)).pipe(
              Effect.match({
                onSuccess: () => {
                  setSaid("Copied");
                },
                onFailure: () => {
                  setSaid("Couldn't copy: select it instead");
                },
              }),
            ),
          );
        }}
      >
        {said}
      </button>
    </>
  );
}

export function spans(ss: Span[]): ReactNode {
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
