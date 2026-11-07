// An agent's text as blocks and spans to draw as React elements, never as HTML: paragraphs, lists, `code`, ``` blocks and
// **bold** read as meant, and a link only ever shows the https URL it opens.
// A link's url is new URL(raw).href, both its href and what's shown.
export type Span =
  { t: "text"; text: string; bold: boolean } | { t: "code"; text: string; bold: boolean } | { t: "link"; url: string; bold: boolean };
export type Block =
  | { t: "p"; spans: Span[] }
  | { t: "ul"; items: Span[][] }
  | { t: "ol"; start: number; items: Span[][] }
  | { t: "pre"; text: string; info: string }; // info: the fence's ```suggestion or ```ts, kept only for Copy

// Markers only, with the rest of the line sliced off: a `[ \t]+(.*)$` tail backtracks quadratically when `$` can't match.
const HEADING = /^ {0,3}#{1,6}[ \t]/;
const BULLET = /^[ \t]*[-*][ \t]/;
const NUMBER = /^[ \t]*(\d{1,3})\.[ \t]/;
const MD_LINK = /\[([^\]\n]{1,200})\]\((https:\/\/[^\s)]+)\)/g;
const URL_IN_TEXT = /(https:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]])/;
const INFO = /^[\w+-]{1,30}$/;

type Raw =
  | { t: "p"; lines: string[]; heading: boolean }
  | { t: "ul"; items: string[][] }
  | { t: "ol"; start: number; items: string[][] }
  | { t: "pre"; text: string; info: string };

// Copy's text: a fence longer than any backtick run opening a line inside, since GitHub ends a block on one as long.
export function fencedCopy(text: string, info: string): string {
  const f = "`".repeat(Math.max(3, ...[...text.matchAll(/^ {0,3}(`+)/gm)].map((m) => m[1]!.length + 1)));
  return `${f}${info}\n${text}\n${f}`;
}

export function blocks(text: string): Block[] {
  const raw: Raw[] = [];
  let fence: string[] | null = null;
  let info = "";
  let list: Extract<Raw, { items: string[][] }> | null = null;
  let open: string[] | null = null; // the open p's or list item's lines, which a plain line continues
  const close = () => {
    list = null;
    open = null;
  };
  const item = (t: "ul" | "ol", rest: string, start = 1) => {
    open = [rest.trim()];
    if (list?.t === t) list.items.push(open);
    else {
      list = t === "ul" ? { t, items: [open] } : { t, start, items: [open] };
      raw.push(list);
    }
  };
  const pre = (lines: string[]) => {
    if (lines.join("").trim()) raw.push({ t: "pre", text: lines.join("\n"), info });
  };
  for (const line of text.replaceAll("\r", "").split("\n")) {
    if (fence) {
      if (line.trim() !== "```") fence.push(line);
      else {
        pre(fence);
        fence = null;
      }
      continue;
    }
    if (line.trimStart().startsWith("```")) {
      fence = [];
      const rest = line.trim().slice(3).trim();
      info = INFO.test(rest) ? rest : "";
      close();
      continue;
    }
    if (!line.trim()) {
      close();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      raw.push({ t: "p", lines: [line.slice(h[0].length).trim()], heading: true });
      close();
      continue;
    }
    const b = BULLET.exec(line);
    if (b) {
      item("ul", line.slice(b[0].length));
      continue;
    }
    const n = NUMBER.exec(line);
    if (n) {
      item("ol", line.slice(n[0].length), Number(n[1]));
      continue;
    }
    if (open) open.push(line.trim());
    else {
      open = [line.trim()];
      raw.push({ t: "p", lines: open, heading: false });
    }
  }
  if (fence) pre(fence);
  return raw.flatMap((r): Block[] => {
    if (r.t === "pre") return [r];
    if (r.t === "ul") return [{ t: "ul", items: r.items.map((ls) => inline(ls.join("\n"))) }];
    if (r.t === "ol") return [{ t: "ol", start: r.start, items: r.items.map((ls) => inline(ls.join("\n"))) }];
    const spans = inline(r.lines.join("\n"), r.heading);
    return spans.length ? [{ t: "p", spans }] : [];
  });
}

export function inline(text: string, heading = false): Span[] {
  const parts = text.split("`");
  // An odd backtick count leaves the last one unpaired: it's text.
  if (parts.length % 2 === 0) parts.splice(-2, 2, parts.slice(-2).join("`"));
  const marks = parts.reduce((n, part, i) => (i % 2 ? n : n + part.split("**").length - 1), 0);
  let toggles = marks - (marks % 2);
  const out: Span[] = [];
  let bold = false;
  let run = "";
  const flush = () => {
    words(out, run, bold);
    run = "";
  };
  for (const [i, part] of parts.entries()) {
    if (i % 2) {
      flush();
      out.push({ t: "code", text: part, bold });
      continue;
    }
    for (const [j, bit] of part.split("**").entries()) {
      if (j && toggles) {
        flush();
        toggles--;
        bold = !bold;
      } else if (j) run += "**";
      run += bit;
    }
  }
  flush();
  return tidy(heading ? out.map((s) => ({ ...s, bold: true })) : out);
}

// Markdown links read as `label (` + the link + `)`, so a label never hides where it goes; any other match stays text.
function words(out: Span[], text: string, bold: boolean): void {
  let rest = "";
  let at = 0;
  for (const m of text.matchAll(MD_LINK)) {
    const url = link(m[2] ?? "");
    rest += text.slice(at, m.index);
    at = m.index + m[0].length;
    if (url) {
      urls(out, `${rest}${m[1]} (`, bold);
      out.push({ t: "link", url, bold });
      rest = ")";
    } else rest += m[0];
  }
  urls(out, rest + text.slice(at), bold);
}

function urls(out: Span[], text: string, bold: boolean): void {
  for (const [i, bit] of text.split(URL_IN_TEXT).entries()) {
    const url = i % 2 ? link(bit) : null;
    out.push(url ? { t: "link", url, bold } : { t: "text", text: bit, bold });
  }
}

// .href puts a lookalike host in punycode and resolves `..` and %2E; userinfo could make another host read as GitHub.
function link(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

function tidy(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    const last = out.at(-1);
    if (s.t !== "link" && !s.text) continue;
    if (s.t === "text" && last?.t === "text" && last.bold === s.bold) last.text += s.text;
    else out.push(s);
  }
  return out;
}

// A sentence ends at . ! or ? (and a closing quote or bracket) before a space; "e.g." and the like don't end one.
const END = /(?<!\b(?:e\.g|i\.e|etc|vs|cf))[.!?]["')\]]?(?=\s)/i;

// The first sentence of the first paragraph and what's left, never cut inside `code`; no lead when it opens with a list or code.
export function lead(bs: Block[]): { first: Span[]; rest: Block[] } {
  const [head, ...after] = bs;
  if (head?.t !== "p") return { first: [], rest: bs };
  for (const [i, s] of head.spans.entries()) {
    if (s.t !== "text") continue;
    const next = head.spans[i + 1]; // a sentence can end on bold, before the next text's space
    const m = END.exec(s.text + (next?.t === "text" ? next.text.slice(0, 1) : ""));
    if (!m) continue;
    const cut = m.index + m[0].length;
    const more = tidy([{ ...s, text: s.text.slice(cut) }, ...head.spans.slice(i + 1)]);
    const [h] = more;
    if (h?.t === "text") more[0] = { ...h, text: h.text.trimStart() };
    const spans = more.filter((x) => x.t === "link" || x.text);
    return {
      first: [...head.spans.slice(0, i), { ...s, text: s.text.slice(0, cut) }],
      rest: spans.length ? [{ t: "p", spans }, ...after] : after,
    };
  }
  return { first: head.spans, rest: after };
}

// Text the PR's author can steer (an AI review of their PR) opens no link: a URL in it is drawn as its text.
export function unlinked(ss: Span[]): Span[] {
  return ss.map((s): Span => (s.t === "link" ? { t: "text", text: s.url, bold: s.bold } : s));
}
